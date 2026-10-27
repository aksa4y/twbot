const aliases = require('./aliases');
const {createCooldownStore, channelScope} = require('../services/cooldowns');
const {canExecute} = require('../chat/permissions');
// Every command needs an explicit policy; a newly added handler is denied until registered.
const USER_ROLES = Object.freeze({
    '7tv':'viewer', ping:'viewer', eh:'viewer', tg:'viewer', rules:'viewer',
    iq:'viewer', game:'viewer', followage:'viewer', categories:'viewer',
    gift:'viewer', commands:'viewer', propose:'viewer', vote:'viewer',
    stats:'viewer', proverb:'viewer', roulette:'viewer', points:'viewer',
    joke:'viewer', fortune:'viewer', duel:'viewer', acceptduel:'viewer',
    declineduel:'viewer', report:'viewer', transfer:'viewer', top:'viewer',
    addgift:'moderator', addpoints:'moderator', resetgift:'broadcaster', test:'broadcaster'
});
const COOLDOWNS = Object.freeze({report:60000, roulette:300000});
function createDispatcher({moderatorHandlers, userHandlers, clock = Date.now, cooldowns = createCooldownStore()}) {
    return async function dispatch({channel, tags, message, permissions}) {
        const [rawCommand, ...args] = message.slice(1).trim().split(/\s+/);
        const inputCommand = rawCommand.toLowerCase();
        const username = tags.username;
        const now = clock();
        if (!cooldowns.claim(channelScope('commands', channel), username, 3000, now)) return;

        const mod = Object.hasOwn(aliases.mod, inputCommand) ? aliases.mod[inputCommand] : null;
        if (mod && Object.hasOwn(moderatorHandlers, mod)) {
            if (canExecute('moderator', permissions)) await moderatorHandlers[mod](channel, args, username);
            return;
        }
        const command = Object.hasOwn(aliases.user, inputCommand) ? aliases.user[inputCommand] : null;
        if (!command || !Object.hasOwn(userHandlers, command)) return;
        if (!Object.hasOwn(USER_ROLES, command)) return;
        const requiredRole = USER_ROLES[command];
        if (!canExecute(requiredRole, permissions)) return;
        if (Object.hasOwn(COOLDOWNS, command)) {
            if (!cooldowns.claim(channelScope(command, channel), username, COOLDOWNS[command], now)) return;
        }
        await userHandlers[command](channel, args, username, tags, permissions.isBroadcaster, permissions.isMod);
    };
}
module.exports = {createDispatcher};
