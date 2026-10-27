const aliases = require('./aliases');
const {limitedMap} = require('../utils/security');
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
function createDispatcher({moderatorHandlers, userHandlers, clock = Date.now}) {
    const commandTimes = limitedMap();
    const specialTimes = limitedMap(10000, 3600000);
    return async function dispatch({channel, tags, message, permissions}) {
        const [rawCommand, ...args] = message.slice(1).trim().split(/\s+/);
        const inputCommand = rawCommand.toLowerCase();
        const username = tags.username;
        const now = clock();
        const last = commandTimes.get(username);
        if (last !== undefined && now-last < 3000) return;
        commandTimes.set(username, now);

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
            const key = `${command}:${username}`;
            const previous = specialTimes.get(key);
            if (previous !== undefined && now-previous < COOLDOWNS[command]) return;
            specialTimes.set(key, now);
        }
        await userHandlers[command](channel, args, username, tags, permissions.isBroadcaster, permissions.isMod);
    };
}
module.exports = {createDispatcher};
