const defaultModeration = require('../commands/moderation');
const {hasLink} = require('../utils/security');
const {createModerationActions} = require('./moderation-actions');
function createAutoModeration({client, send, moderation = defaultModeration, ...options}) {
    const apply = createModerationActions({client, send, moderation, ...options});
    return async function moderate(channel, tags, message, username) {
        const decide = (rule, actions) => apply({channel, tags:{...tags, username}, message, rule, actions});
        if (hasLink(message)) {
            await decide('link', [
                {type:'delete', reason:'Ссылка в сообщении'},
                {type:'warning', text:`@${username}, ссылки запрещены.`}
            ]);
            return true;
        }
        if (moderation.hasForbiddenWords(message)) {
            await decide('forbidden_word', [
                {type:'timeout', duration:moderation.getTimeoutDuration(message), reason:'Запрещённое слово'},
                {type:'delete', reason:'Запрещённое слово'}
            ]);
            return true;
        }
        const caps = moderation.checkCaps(message, username);
        if (caps) {await applyResult('caps', caps);return true;}
        const spam = await moderation.checkSpam(username, message);
        if (spam) {await applyResult('spam', spam);return true;}
        return false;

        async function applyResult(rule, result) {
            if (result.timeout) {
                const duration = result.duration || 600;
                const reason = result.reason || (rule === 'caps' ? 'Капс' : 'Спам');
                await decide(rule, [
                    {type:'timeout', duration, reason},
                    {type:'warning', text:`тревога Выдан таймаут @${username} на ${duration} сек. Причина: ${reason}`}
                ]);
            } else await decide(rule, [{type:'warning', text:result.warning}]);
        }
    };
}
module.exports = {createAutoModeration};
