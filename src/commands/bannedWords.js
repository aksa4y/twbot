// Channel-specific filter, not an official Twitch word list.
// Edit config/moderation.json before enabling automatic word penalties.
const config = require('../../config/moderation.json');
if (!Array.isArray(config.forbiddenWords) || config.forbiddenWords.some(w => typeof w !== 'string' || !w.trim() || w.length > 100) || config.forbiddenWords.length > 500) throw new Error('Некорректный список запрещённых слов');
module.exports = {forbiddenWords:config.forbiddenWords,wordTimeoutMap:config.wordTimeoutMap || {}};
