const defaultApi = require('../services/api');
const defaultModeration = require('../commands/moderation');
const database = require('../services/database');
const {getAutoModerationMode} = require('../config');
function createModerationActions({client, send, mode = getAutoModerationMode(), twitchApi = defaultApi, moderation = defaultModeration, journal = database, logger = console}) {
    if (!['observe', 'active'].includes(mode)) throw new Error('Некорректный режим автомодерации');
    return async function apply({channel, tags, message, rule, actions}) {
        // Persist the decision before any side effects. A journal failure cannot trigger a punishment.
        const id = await journal.recordAutoModerationEvent({channel, username:tags.username, messageId:tags.id, message, rule, actions, mode});
        if (mode === 'observe') {
            logger.info(`[Наблюдение #${id}] ${channel} @${tags.username}: ${rule}; ${actions.map(a => a.type).join(', ')}`);
            return;
        }
        try {
            for (const action of actions) {
                if (action.type === 'timeout') await moderation.handleTimeout(client, channel, tags.username, action.duration, action.reason);
                else if (action.type === 'delete') await twitchApi.deleteMessage(channel, tags.id);
                else if (action.type === 'warning') await send(channel, action.text);
                else throw new Error('Неизвестное действие автомодерации');
            }
            await journal.finishAutoModerationEvent(id, 'applied');
        } catch (error) {
            await journal.finishAutoModerationEvent(id, 'failed');
            // Do not persist raw network errors or credentials in the journal.
            logger.error(`Автомодерация #${id}: действие не выполнено`);
        }
    };
}
module.exports = {createModerationActions};
