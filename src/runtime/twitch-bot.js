const tmi = require('tmi.js');
const {getAutoModerationMode} = require('../config');
const twitchApi = require('../services/api');
const interactive = require('../commands/interactive');
const proverbs = require('../services/proverbs');
const jokes = require('../services/jokes');
const fortunes = require('../services/fortunes');
const DuelManager = require('../services/duels');
const {startApiServer} = require('../api/server');
const {createSender} = require('../chat/sender');
const {createAutoModeration} = require('../chat/automoderation');
const {createMessageHandler} = require('../chat/message-handler');
const {createDispatcher} = require('../commands/dispatcher');
const {createModeratorHandlers} = require('../commands/moderator-handlers');
const {createUserHandlers} = require('../commands/user-handlers');
class TwitchBot {
    constructor({client} = {}) {
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

        this.client = client || new tmi.Client(this.config);
        this.autoModerationMode = getAutoModerationMode();
        this.apiServer = null;
        this.send = createSender({client:this.client});
        const duelManager = new DuelManager(this.client, this.send);
        const dispatcher = createDispatcher({
            moderatorHandlers:createModeratorHandlers({client:this.client, send:this.send}),
            userHandlers:createUserHandlers({client:this.client, send:this.send, duelManager})
        });
        this.handleMessage = createMessageHandler({
            send:this.send,
            moderate:createAutoModeration({client:this.client, send:this.send, mode:this.autoModerationMode}),
            dispatch:dispatcher,
            isStopping:() => this.stopping
        });
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.client.on('message', (...args) => this.handleMessage(...args).catch(err => console.error('Ошибка обработки сообщения:', err.message)));
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
            await require('../services/database').ready;
            console.log(`Режим автомодерации: ${this.autoModerationMode}`);
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
        await require('../services/database').close();
        process.exit(code);
    }

}
module.exports = {TwitchBot};
