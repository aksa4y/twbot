const database = require('./database');
const {username} = require('../utils/security');
function channelScope(kind, channel = process.env.CHANNEL_NAME) {
    return `channel:${username(channel)}:${kind}`;
}
function createCooldownStore() {
    return {
        claim: (scope, user, duration, now) => database.claimCooldown(scope, user, duration, now),
        clear: scope => database.clearCooldownScope(scope)
    };
}
module.exports = {createCooldownStore, channelScope};
