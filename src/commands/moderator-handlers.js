const moderation = require('./moderation');
const { amount } = require('../utils/security');
const database = require('../services/database');
function createModeratorHandlers({client, send}) {
return {
        reports: async (channel) => {
            const rows = await database.getPendingReports();
            await send(channel, rows.length ? rows.map(r => `#${r.id}: @${r.offender} — ${r.reason}`).join(' | ') : 'Новых жалоб нет.');
        },
        warn: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            if (!target) return;
            try {
                const result = await moderation.handleWarn(target);
                if (result.type === 'message') {
                    await send(channel, result.text);
                } else {
                    await moderation.handleTimeout(client, channel, target, result.duration, result.reason);
                    await send(channel, `тревога Выдан таймаут @${target} на ${result.duration} сек. Причина: ${result.reason}`);
                }
            } catch (error) {
                if (error.code === 'BOT_MODERATION') {
                    await send(channel, `⚠️ Нельзя применить модерацию к боту ${target}.`);
                } else {
                    console.error(`Ошибка в команде warn для ${target}:`, error);
                    await send(channel, `⚠️ Произошла ошибка. Подробности в консоли.`);
                }
            }
        },
        timeout: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            const duration = amount(args[1], 1209600);
            if (!target || isNaN(duration)) return;
            try {
                await moderation.handleTimeout(client, channel, target, duration, 'Нарушение правил');
                await send(channel, `тревога Выдан таймаут @${target} на ${duration} сек. Причина: Нарушение правил`);
            } catch (error) {
                if (error.code === 'BOT_MODERATION') {
                    await send(channel, `⚠️ Нельзя затаймить бота ${target}.`);
                } else {
                    console.error(`Ошибка в команде timeout для ${target}:`, error);
                    await send(channel, `⚠️ Не удалось затаймить ${target}.`);
                }
            }
        },
        ban: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            if (!target) return;
            const reason = args.length > 1 ? args.slice(1).join(' ') : 'Перманентный бан';
            try {
                await moderation.handleBan(client, channel, target, reason);
                await send(channel, `🔨 Выдан бан @${target}. Причина: ${reason}`);
            } catch (error) {
                if (error.code === 'BOT_MODERATION') {
                    await send(channel, `⚠️ Нельзя забанить бота ${target}.`);
                } else {
                    console.error(`Ошибка в команде ban для ${target}:`, error);
                    await send(channel, `Не удалось забанить @${target}.`);
                }
            }
        },
        unban: async (channel, args) => {
            const target = args[0]?.replace('@', '');
            if (!target) return;
            const result = await moderation.handleUnban(client, channel, target);
            await send(channel, result);
        },
    };
}
module.exports = {createModeratorHandlers};
