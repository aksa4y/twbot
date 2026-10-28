const tmi = require('tmi.js');
const {tokenManager} = require('../services/token-manager');
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
                password: async () => {await tokenManager.check();this.chatAccessToken=tokenManager.getAccessToken();return `oauth:${this.chatAccessToken}`;},
                clientId: process.env.CLIENT_ID
            },
            channels: [process.env.CHANNEL_NAME]
        };

        this.client = client || new tmi.Client(this.config);
        this.autoModerationMode = require('../services/database').getSetting('automod_mode') || getAutoModerationMode();
        this.startedAt = Date.now();
        this.apiServer = null;
        this.send = createSender({client:this.client});
        const duelManager = new DuelManager(this.client, this.send);
        const dispatcher = createDispatcher({
            moderatorHandlers:createModeratorHandlers({client:this.client, send:this.send}),
            userHandlers:createUserHandlers({client:this.client, send:this.send, duelManager})
        });
        this.handleMessage = createMessageHandler({
            send:this.send,
            moderate:createAutoModeration({client:this.client, send:this.send, mode:() => this.autoModerationMode}),
            dispatch:dispatcher,
            isStopping:() => this.stopping
        });
        this.setupEventHandlers();
    }

    getStatus() {
        return {channel:process.env.CHANNEL_NAME,bot:process.env.BOT_USERNAME,
            connected:this.client.readyState?.() === 'OPEN',mode:this.autoModerationMode,
            uptimeSeconds:Math.floor((Date.now()-this.startedAt)/1000),stopping:!!this.stopping};
    }

    setMode(mode) {
        if (!['observe','active'].includes(mode)) throw new Error('Некорректный режим');
        require('../services/database').setSetting('automod_mode',mode);
        if (mode !== this.autoModerationMode) require('../commands/moderation').resetAutoModerationCounters();
        this.autoModerationMode = mode;
        return this.getStatus();
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
            if(this.chatStarted && /authentication failed|Login unsuccessful|Error logging in/i.test(String(reason))) this.recoverChatAuth().catch(error=>this.handleAuthError(error));

        });
        this.client.on('login_failure', () => this.recoverChatAuth().catch(error=>this.handleAuthError(error)));
    }

    handleAuthError(error) {
        console.error(error.authError ? error.message : 'Не удалось восстановить авторизацию Twitch.');
        if(error.fatal) this.shutdown(1);
        else if(this.chatStarted && this.client.readyState?.() !== 'OPEN' && !this.stopping && !this.authRetryTimer) this.authRetryTimer=setTimeout(()=>{this.authRetryTimer=null;this.recoverChatAuth().catch(error=>this.handleAuthError(error));},60000);
    }

    async recoverChatAuth() {
        if(this.stopping)return;
        if(this.authRecovery)return this.authRecovery;
        this.authRecovery=(async()=>{
            await tokenManager.refresh(this.chatAccessToken || tokenManager.getAccessToken());
            if(this.stopping)return;
            this.client.reconnect=true;
            await this.client.connect();
            clearTimeout(this.authRetryTimer);this.authRetryTimer=null;
        })();
        try {await this.authRecovery;}
        finally{this.authRecovery=null;}
    }

    async connect() {
        try {
            await require('../services/database').ready;
            console.log(`Режим автомодерации: ${this.autoModerationMode}`);
            await tokenManager.check(true);
            this.authUnsubscribe=tokenManager.onFatal(error=>this.handleAuthError(error));
            this.validationTimer = setInterval(() => tokenManager.check().catch(error=>this.handleAuthError(error)),60000);
            try {await this.client.connect();}
            catch(error){
                if(!/authentication failed|Login unsuccessful|Error logging in/i.test(String(error))) throw error;
                await this.recoverChatAuth();
            }
            this.chatStarted=true;
            console.log('✅ Бот уже на Twitch');
            this.apiServer = startApiServer(this.client, {getStatus:() => this.getStatus(), setMode:mode => this.setMode(mode)});
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
        this.authUnsubscribe?.();
        clearInterval(this.validationTimer);
        clearTimeout(this.authRetryTimer);
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
