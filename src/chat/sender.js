function createSender({client, clock = Date.now, logger = console}) {
 let outgoingTimes = [];
 return async function send(channel, message, returnMsg = false) {
        try {
            if (typeof message !== 'string') return null;
            message = message.replace(/[\r\n\x00-\x1f]/g, ' ').trim();
            if (!message || /^[/.]/.test(message)) return null;
            message = Array.from(message).slice(0, 450).join('');
            const now = clock();
            outgoingTimes = outgoingTimes.filter(t => now-t < 30000);
            if (outgoingTimes.length >= 18) return null;
            outgoingTimes.push(now);
            const msg = await client.say(channel, message);
            if (returnMsg) return msg;
        } catch (error) {
            logger.error(`Ошибка отправки сообщения в ${channel}:`, error.message);
        }
        return null;

 };
}
module.exports = {createSender};
