const { validateConfig } = require('./config');
if (require.main === module) validateConfig();
const { limitedMap, hasLink, amount } = require('./utils/security');
const twitchApi = require('./services/api');
const tmi = require('tmi.js');

const moderation = require('./commands/moderation');
const interactive = require('./commands/interactive');
const aliases = require('./commands/aliases');
const proverbs = require('./services/proverbs');
const jokes = require('./services/jokes');
const fortunes = require('./services/fortunes');
const DuelManager = require('./services/duels');

const { startApiServer } = require('./api/server');

class TwitchBot {
    constructor() {
        this.config = {
            options: {
                debug: false,
                messagesLogLevel: process.env.LOG_LEVEL || 'info'
            },
            connection: {
                secure: true,
                reconnect: true,
                reconnectInterval: 2000,
                maxReconnectAttempts: 20,
                timeout: 20000
            },
            identity: {
                username: process.env.BOT_USERNAME,
                password: `oauth:${process.env.ACCESS_TOKEN}`,
                clientId: process.env.CLIENT_ID
            },
            channels: [process.env.CHANNEL_NAME]
        };

        this.client = new tmi.Client(this.config);
        this.commandTimes = limitedMap();
        this.outgoingTimes = [];
        this.apiServer = null;
        this.duelManager = new DuelManager(this.client, this.safeSay.bind(this));
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.client.on('message', (...args) => this.onMessage(...args).catch(err => console.error('Ошибка обработки сообщения:', err.message)));
        this.client.on('connected', (addr, port) => {
            console.log(`✅ Бот подключен к ${addr}:${port}`);
            proverbs.initProverbs().catch(console.error);
            jokes.initJokes().catch(console.error);
            fortunes.initFortunes().catch(console.error);

        });
        this.client.on('disconnected', reason => {
            console.warn(`⚠️ Бот отключен: ${reason}`);

        });
        this.client.on('login_failure', () => {
            console.error('❌ Ошибка аутентификации. Проверьте ACCESS_TOKEN в .env');
            process.exit(1);
        });
    }

    async connect() {
        try {
            await require('./services/database').ready;
            await twitchApi.validateToken();
            this.validationTimer = setInterval(() => twitchApi.validateToken().catch(() => this.shutdown(1)), 60 * 60 * 1000);
            await this.client.connect();
            console.log('✅ Бот уже на Twitch');
            this.apiServer = startApiServer(this.client);
            const refresh = async () => {
                try { const data = await twitchApi.request('streams', {user_login: process.env.CHANNEL_NAME});
                    interactive.setCurrentStreamId(data.data[0]?.id || null);
                } catch { interactive.setCurrentStreamId(null); }
            };
            await refresh();
            this.streamTimer = setInterval(refresh, 60000);
        } catch (err) {
            console.error('❌ Ошибка подключения:', err);
            process.exit(1);
        }
    }

    async shutdown(code = 0) {
        if (this.stopping) return;
        this.stopping = true;
        clearInterval(this.validationTimer);
        clearInterval(this.streamTimer);
        const force = setTimeout(() => process.exit(code || 1), 5000);
        force.unref();
        if (this.apiServer) await new Promise(resolve => this.apiServer.close(resolve));
        await this.client.disconnect().catch(() => {});
        await require('./services/database').close();
        process.exit(code);
    }

    modHandlers = {
        reports: async (channel) => {
            const rows = await require('./services/database').getPendingReports();
            await this.safeSay(channel, rows.length ? rows.map(r => `#${r.id}: @${r.offender} — ${r.reason}`).join(' | ') : 'Новых жалоб нет.');
        },
        warn: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            if (!target) return;
            try {
                const result = await moderation.handleWarn(target);
                if (result.type === 'message') {
                    await this.safeSay(channel, result.text);
                } else {
                    await moderation.handleTimeout(this.client, channel, target, result.duration, result.reason);
                    await this.safeSay(channel, `тревога Выдан таймаут @${target} на ${result.duration} сек. Причина: ${result.reason}`);
                }
            } catch (error) {
                if (error.code === 'BOT_MODERATION') {
                    await this.safeSay(channel, `⚠️ Нельзя применить модерацию к боту ${target}.`);
                } else {
                    console.error(`Ошибка в команде warn для ${target}:`, error);
                    await this.safeSay(channel, `⚠️ Произошла ошибка. Подробности в консоли.`);
                }
            }
        },
        timeout: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            const duration = amount(args[1], 1209600);
            if (!target || isNaN(duration)) return;
            try {
                await moderation.handleTimeout(this.client, channel, target, duration, 'Нарушение правил');
                await this.safeSay(channel, `тревога Выдан таймаут @${target} на ${duration} сек. Причина: Нарушение правил`);
            } catch (error) {
                if (error.code === 'BOT_MODERATION') {
                    await this.safeSay(channel, `⚠️ Нельзя затаймить бота ${target}.`);
                } else {
                    console.error(`Ошибка в команде timeout для ${target}:`, error);
                    await this.safeSay(channel, `⚠️ Не удалось затаймить ${target}.`);
                }
            }
        },
        ban: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            if (!target) return;
            const reason = args.length > 1 ? args.slice(1).join(' ') : 'Перманентный бан';
            try {
                await moderation.handleBan(this.client, channel, target, reason);
                await this.safeSay(channel, `🔨 Выдан бан @${target}. Причина: ${reason}`);
            } catch (error) {
                if (error.code === 'BOT_MODERATION') {
                    await this.safeSay(channel, `⚠️ Нельзя забанить бота ${target}.`);
                } else {
                    console.error(`Ошибка в команде ban для ${target}:`, error);
                    await this.safeSay(channel, `Не удалось забанить @${target}.`);
                }
            }
        },
        unban: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            if (!target) return;
            const result = await moderation.handleUnban(this.client, channel, target);
            await this.safeSay(channel, result);
        },
    };

    userHandlers = {
        '7tv': async (channel, args, username) => {
            await this.safeSay(channel, `@${username}, ${interactive.handle7tv()}`);
        },
        ping: async (channel, args, username) => {
            await this.safeSay(channel, `@${username}, ${interactive.handlePing(Date.now())}`);
        },
        eh: async (channel, args, username) => {
            await this.safeSay(channel, `@${username}, ${interactive.handleEh()}`);
        },
        tg: async (channel, args, username) => {
            await this.safeSay(channel, `@${username}, ${interactive.handleTg()}`);
        },
        rules: async (channel, args, username) => {
            await this.safeSay(channel, `@${username}, ${interactive.handleRules()}`);
        },
        iq: async (channel, args, username) => {
            try {
                const response = await interactive.handleIQ(username);
                await this.safeSay(channel, `@${username}, ${response}`);
            } catch {
                await this.safeSay(channel, `@${username}, ошибка IQ.`);
            }
        },
        game: async (channel, args, username) => {
            const response = await interactive.handleGame();
            await this.safeSay(channel, `@${username}, ${response}`);
        },
        followage: async (channel, args, username, tags, isBroadcaster) => {
            try {
                const response = await interactive.handleFollowage(tags, isBroadcaster);
                await this.safeSay(channel, `@${username}, ${response}`);
            } catch {
                await this.safeSay(channel, `@${username}, ошибка followage.`);
            }
        },
        categories: async (channel, args, username) => {
            try {
                const response = await interactive.handleCategories(channel.replace('#', ''));
                await this.safeSay(channel, `@${username}, ${response}`);
            } catch {
                await this.safeSay(channel, `@${username}, ошибка категорий.`);
            }
        },
        addgift: async (channel, args, username, tags, isBroadcaster, isMod) => {
            if (!args.length) return;
            const response = interactive.addGift(args.join(' '), username, isBroadcaster, isMod);
            await this.safeSay(channel, response);
        },
        gift: async (channel, args, username, tags, isBroadcaster, isMod) => {
            try {
                const response = await interactive.handleGift(username, this.client, channel, isBroadcaster, isMod);
                await this.safeSay(channel, response);
            } catch {
                await this.safeSay(channel, `@${username}, ошибка подарка.`);
            }
        },
        test: async (channel, args, username) => {
            if (!args.length) return;
            await this.safeSay(channel, args.join(' '));
        },
        commands: async (channel, args, username) => {
            const response = interactive.handleCommands();
            await this.safeSay(channel, `@${username}, ${response}`);
        },
        propose: async (channel, args, username) => {
            const response = await interactive.handleGameProposal(args, username);
            await this.safeSay(channel, response);
        },
        vote: async (channel, args, username) => {
            const response = await interactive.handleVote(args, username);
            await this.safeSay(channel, response);
        },
        stats: async (channel, args, username) => {
            const response = await interactive.handleStreamStats();
            await this.safeSay(channel, response);
        },
        proverb: async (channel, args, username) => {
            const response = await interactive.handleProverb(args);
            await this.safeSay(channel, response);
        },
        roulette: async (channel, args, username) => {
            const response = await interactive.handleRoulette(username);
            await this.safeSay(channel, response);
        },
        points: async (channel, args, username) => {
            const response = await interactive.handlePoints(username);
            await this.safeSay(channel, response);
        },
        resetgift: async (channel, args, username, tags, isBroadcaster, isMod) => {
            const response = interactive.handleResetGift(username, isBroadcaster);
            await this.safeSay(channel, response);
        },
        addpoints: async (channel, args, username, tags, isBroadcaster, isMod) => {
            const response = await interactive.handleAddPoints(args, username, isBroadcaster, isMod);
            await this.safeSay(channel, response);
        },
        joke: async (channel, args, username) => {
            const response = await interactive.handleJoke();
            await this.safeSay(channel, response);
        },
        fortune: async (channel, args, username) => {
            const response = await interactive.handleFortune(username);
            await this.safeSay(channel, response);
        },
        duel: async (channel, args, username) => {
            if (args.length < 2) return await this.safeSay(channel, `@${username} укажите соперника и ставку. Пример: !дуэль @ник 100`);
            const opponent = args[0].replace('@', '');
            const amount = require('./utils/security').amount(args[1]);
            if (isNaN(amount) || amount <= 0) return await this.safeSay(channel, `@${username} укажите корректную ставку.`);
            const result = await this.duelManager.createDuel(username, opponent, amount, channel);
            if (result) await this.safeSay(channel, result);
        },
        acceptduel: async (channel, args, username) => {
            const result = await this.duelManager.acceptDuel(username, channel);
            await this.safeSay(channel, result);
        },
        declineduel: async (channel, args, username) => {
            const result = await this.duelManager.declineDuel(username, channel);
            await this.safeSay(channel, result);
        },
        report: async (channel, args, username) => {
            const response = await interactive.handleReport(args, username);
            await this.safeSay(channel, response);
        },
        transfer: async (channel, args, username) => {
            const response = await interactive.handleTransfer(args, username);
            await this.safeSay(channel, response);
        },
        top: async (channel, args, username) => {
            const response = await interactive.handleTop(args);
            await this.safeSay(channel, response);
        },
    };

    async safeSay(channel, message, returnMsg = false) {
        try {
            if (typeof message !== 'string') return null;
            message = message.replace(/[\r\n\x00-\x1f]/g, ' ').trim();
            if (!message || /^[/.]/.test(message)) return null;
            message = Array.from(message).slice(0, 450).join('');
            const now = Date.now();
            this.outgoingTimes = this.outgoingTimes.filter(t => now-t < 30000);
            if (this.outgoingTimes.length >= 18) return null;
            this.outgoingTimes.push(now);
            const msg = await this.client.say(channel, message);
            if (returnMsg) return msg;
        } catch (error) {
            console.error(`Ошибка отправки сообщения в ${channel}:`, error.message);
        }
        return null;
    }

    async onMessage(channel, tags, message, self) {
        if (self || this.stopping || typeof message !== 'string' || !tags.username) return;

        const { username, mod, badges } = tags;
        const isBroadcaster = badges?.broadcaster === '1';
        const isMod = mod || isBroadcaster;
        const isVIP = badges?.vip === '1';



        if (!isMod && !isBroadcaster && !isVIP) {
            if (hasLink(message)) {
                try {
                    await twitchApi.deleteMessage(channel, tags.id);
                    await this.safeSay(channel, `@${username}, ссылки запрещены.`);
                } catch (err) {
                    console.error('Не удалось удалить сообщение со ссылкой:', err);
                }
                return;
            }
        }

        if (!isMod && !isVIP && await this.runAutoModeration(channel, tags, message, username)) return;
        if (!message.startsWith('!')) return;
        const now = Date.now();
        if (now - (this.commandTimes.get(username) || 0) < 3000) return;
        this.commandTimes.set(username, now);

        const [rawCommand, ...args] = message.slice(1).trim().split(/\s+/);
        const inputCommand = rawCommand.toLowerCase();

        if (isMod) {
            const canonicalMod = Object.hasOwn(aliases.mod, inputCommand) ? aliases.mod[inputCommand] : null;
            if (canonicalMod && Object.hasOwn(this.modHandlers, canonicalMod)) {
                await this.modHandlers[canonicalMod](channel, args, username);
                return;
            }
        }

        const canonicalUser = Object.hasOwn(aliases.user, inputCommand) ? aliases.user[inputCommand] : null;
        if (['addgift', 'addpoints'].includes(canonicalUser) && !isMod) return;
        if (['resetgift', 'test'].includes(canonicalUser) && !isBroadcaster) return;
        if (canonicalUser === 'report') {
            this.reportTimes ||= limitedMap(10000, 3600000);
            if (now - (this.reportTimes.get(username) || 0) < 60000) return;
            this.reportTimes.set(username, now);
        }
        if (canonicalUser === 'roulette') {
            this.rouletteTimes ||= limitedMap(10000, 3600000);
            if (now - (this.rouletteTimes.get(username) || 0) < 300000) return;
            this.rouletteTimes.set(username, now);
        }
        if (canonicalUser && Object.hasOwn(this.userHandlers, canonicalUser)) {
            await this.userHandlers[canonicalUser](channel, args, username, tags, isBroadcaster, isMod);
        }
    }

    async runAutoModeration(channel, tags, message, username) {
        if (moderation.hasForbiddenWords(message)) {
            try {
                const duration = moderation.getTimeoutDuration(message);
                await moderation.handleTimeout(this.client, channel, username, duration, 'Запрещённое слово');
                await twitchApi.deleteMessage(channel, tags.id).catch(err =>
                    console.error(`Не удалось удалить сообщение:`, err)
                );
            } catch (error) {
                console.error(`Ошибка при обработке запрещённого слова:`, error);
            }
            return true;
        }

        const capsResult = moderation.checkCaps(message, username);
        if (capsResult) {
            try {
                if (capsResult.timeout) {
                    const duration = capsResult.duration || 600;
                    await moderation.handleTimeout(this.client, channel, username, duration, capsResult.reason || 'посиди подумай');
                    await this.safeSay(channel, `тревога Выдан таймаут @${username} на ${duration} сек. Причина: ${capsResult.reason || 'Капс'}`);
                } else {
                    await this.safeSay(channel, capsResult.warning);
                }
            } catch (error) {
                console.error(`Ошибка при обработке капса:`, error);
            }
            return true;
        }

        try {
            const spamResult = await moderation.checkSpam(username, message);
            if (spamResult) {
                if (spamResult.timeout) {
                    await moderation.handleTimeout(this.client, channel, username, spamResult.duration, spamResult.reason);
                    await this.safeSay(channel, `тревога Выдан таймаут @${username} на ${spamResult.duration} сек. Причина: ${spamResult.reason}`);
                } else {
                    await this.safeSay(channel, spamResult.warning);
                }
                return true;
            }
        } catch (error) {
            console.error(`Ошибка при проверке спама:`, error);
        }

        return false;
    }
}

if (require.main === module) {
 const bot = new TwitchBot();
 bot.connect();
 process.once('SIGINT', () => bot.shutdown(0));
 process.once('SIGTERM', () => bot.shutdown(0));
 process.on('unhandledRejection', () => bot.shutdown(1));
 process.on('uncaughtException', () => bot.shutdown(1));
}
module.exports = { TwitchBot };
