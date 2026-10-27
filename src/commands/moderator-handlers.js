const defaultModeration = require('./moderation');
const database = require('../services/database');
function createModeratorHandlers({client, send, moderation = defaultModeration, logger = console}) {
    const auditContext = (actor, channel, command, context = {}) => ({
        source:'chat', actor, channel, command,
        actorId:context.tags?.['user-id'], requestId:context.tags?.id
    });
    const reason = (args, offset, fallback) => args.slice(offset).join(' ').trim().slice(0,500) || fallback;
    async function execute(channel, work) {
        try { await work(); }
        catch (error) {
            logger.error(`Ошибка команды модерации${error.auditId ? ` #${error.auditId}` : ''}`);
            const reference = error.auditId ? ` Журнал #${error.auditId}.` : '';
            if (error.confirmation === 'confirmed') await send(channel, `Twitch подтвердил действие, но возникла локальная ошибка.${reference}`);
            else if (error.confirmation === 'unknown') await send(channel, `Результат Twitch неизвестен. Проверьте состояние перед повтором.${reference}`);
            else if (error.confirmation === 'rejected') await send(channel, `Twitch отклонил действие (HTTP ${error.httpStatus}).${reference}`);
            else await send(channel, `Действие не выполнено. Проверьте параметры команды.${reference}`);
        }
    }
    return {
        reports: async channel => {
            const rows = await database.getPendingReports();
            await send(channel, rows.length ? rows.map(r=>`#${r.id}: @${r.offender} — ${r.reason}`).join(' | ') : 'Новых жалоб нет.');
        },
        warn: async (channel, args, actor, context) => execute(channel, async () => {
            const target = args[0]?.replace(/^@/,'') || '';
            const audit = auditContext(actor, channel, 'warn', context);
            const result = await moderation.handleWarn(target,reason(args,1,'Предупреждение модератора'),audit);
            if (result.type === 'message') await send(channel,result.text);
            else {
                await moderation.handleTimeout(client,channel,target,result.duration,result.reason,{...audit,parentId:result.auditId});
                await send(channel,`Выдан таймаут @${target} на ${result.duration} сек. Причина: ${result.reason}`);
            }
        }),
        timeout: async (channel, args, actor, context) => execute(channel, async () => {
            const target = args[0]?.replace(/^@/,'') || '';
            const why = reason(args,2,'Нарушение правил');
            await moderation.handleTimeout(client,channel,target,args[1],why,auditContext(actor,channel,'timeout',context));
            await send(channel,`Выдан таймаут @${target} на ${Number(args[1])} сек. Причина: ${why}`);
        }),
        ban: async (channel, args, actor, context) => execute(channel, async () => {
            const target = args[0]?.replace(/^@/,'') || '';
            const why = reason(args,1,'Перманентный бан');
            await moderation.handleBan(client,channel,target,why,auditContext(actor,channel,'ban',context));
            await send(channel,`🔨 Выдан бан @${target}. Причина: ${why}`);
        }),
        unban: async (channel, args, actor, context) => execute(channel, async () => {
            const audit = {...auditContext(actor,channel,'unban',context),reason:reason(args,1,'Снятие бана')};
            await send(channel,await moderation.handleUnban(client,channel,args[0]?.replace(/^@/,'') || '',audit));
        })
    };
}
module.exports = {createModeratorHandlers};
