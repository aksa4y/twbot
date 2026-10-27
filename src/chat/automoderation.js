const defaultModeration = require('../commands/moderation');
const defaultApi = require('../services/api');
function createAutoModeration({client, send, moderation = defaultModeration, twitchApi = defaultApi, logger = console}) {
 return async function moderate(channel, tags, message, username) {
        if (moderation.hasForbiddenWords(message)) {
            try {
                const duration = moderation.getTimeoutDuration(message);
                await moderation.handleTimeout(client, channel, username, duration, 'Запрещённое слово');
                await twitchApi.deleteMessage(channel, tags.id).catch(err =>
                    logger.error(`Не удалось удалить сообщение:`, err)
                );
            } catch (error) {
                logger.error(`Ошибка при обработке запрещённого слова:`, error);
            }
            return true;
        }

        const capsResult = moderation.checkCaps(message, username);
        if (capsResult) {
            try {
                if (capsResult.timeout) {
                    const duration = capsResult.duration || 600;
                    await moderation.handleTimeout(client, channel, username, duration, capsResult.reason || 'посиди подумай');
                    await send(channel, `тревога Выдан таймаут @${username} на ${duration} сек. Причина: ${capsResult.reason || 'Капс'}`);
                } else {
                    await send(channel, capsResult.warning);
                }
            } catch (error) {
                logger.error(`Ошибка при обработке капса:`, error);
            }
            return true;
        }

        try {
            const spamResult = await moderation.checkSpam(username, message);
            if (spamResult) {
                if (spamResult.timeout) {
                    await moderation.handleTimeout(client, channel, username, spamResult.duration, spamResult.reason);
                    await send(channel, `тревога Выдан таймаут @${username} на ${spamResult.duration} сек. Причина: ${spamResult.reason}`);
                } else {
                    await send(channel, spamResult.warning);
                }
                return true;
            }
        } catch (error) {
            logger.error(`Ошибка при проверке спама:`, error);
        }

        return false;

 };
}
module.exports = {createAutoModeration};
