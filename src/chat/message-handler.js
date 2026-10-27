const {hasLink} = require('../utils/security');
const defaultApi = require('../services/api');
const {getPermissions} = require('./permissions');
function createMessageHandler({send, moderate, dispatch, isStopping = () => false, twitchApi = defaultApi, logger = console}) {
    return async function handleMessage(channel, tags, message, self) {
        if (self || isStopping() || typeof message !== 'string' || !tags?.username) return;
        const permissions = getPermissions(tags);
        if (!permissions.exemptFromAutoModeration) {
            if (hasLink(message)) {
                try {
                    await twitchApi.deleteMessage(channel, tags.id);
                    await send(channel, `@${tags.username}, ссылки запрещены.`);
                } catch (error) {
                    logger.error('Не удалось удалить сообщение со ссылкой:', error.message);
                }
                return;
            }
            if (await moderate(channel, tags, message, tags.username)) return;
        }
        if (message.startsWith('!')) await dispatch({channel, tags, message, permissions});
    };
}
module.exports = {createMessageHandler};
