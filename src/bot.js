const {validateConfig} = require('./config');

// Validate environment before loading services that capture credentials or open the database.
if (require.main === module) {
    validateConfig();
    const {TwitchBot} = require('./runtime/twitch-bot');
    const bot = new TwitchBot();
    process.once('SIGINT', () => bot.shutdown(0));
    process.once('SIGTERM', () => bot.shutdown(0));
    process.on('unhandledRejection', () => bot.shutdown(1));
    process.on('uncaughtException', () => bot.shutdown(1));
    bot.connect();
}

// Lazy compatibility export: importing the entry point does not start the bot.
Object.defineProperty(module.exports, 'TwitchBot', {
    enumerable:true,
    get:() => require('./runtime/twitch-bot').TwitchBot
});
