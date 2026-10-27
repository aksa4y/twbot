const {getPermissions} = require('./permissions');
function createMessageHandler({moderate, dispatch, isStopping = () => false}) {
    return async function handleMessage(channel, tags, message, self) {
        if (self || isStopping() || typeof message !== 'string' || !tags?.username) return;
        const permissions = getPermissions(tags);
        if (!permissions.exemptFromAutoModeration && await moderate(channel, tags, message, tags.username)) return;
        if (message.startsWith('!')) await dispatch({channel, tags, message, permissions});
    };
}
module.exports = {createMessageHandler};
