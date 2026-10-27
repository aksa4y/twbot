const database = require('./database');
function contextFields(context = {}) {
    return {
        source:context.source || 'system',
        actor:context.actor || process.env.BOT_USERNAME || 'system',
        actorId:context.actorId,
        command:context.command,
        requestId:context.requestId,
        parentId:context.parentId,
        decisionId:context.decisionId
    };
}
async function runAuditedAction({action, channel, target, reason, duration, context, remote, local, journal = database}) {
    const id = await journal.recordModerationAction({action, channel, target, reason, duration, ...contextFields(context)});
    let receipt = {confirmation:'not_sent'};
    let localApplied = false;
    try {
        let result;
        if (remote) {
            const response = await remote();
            receipt = response?.confirmation === 'confirmed' ? response : {confirmation:'unknown'};
            if (receipt.confirmation !== 'confirmed') throw Object.assign(new Error('Нет подтверждения Twitch'),{confirmation:'unknown'});
            // Persist Twitch acceptance before local bookkeeping that can fail separately.
            await journal.finishModerationAction(id, {...receipt, status:receipt.confirmation === 'confirmed' ? 'confirmed' : 'unknown'});
        }
        if (local) {result = await local();localApplied = true;}
        if (!remote) await journal.finishModerationAction(id, {status:'local', confirmation:'not_applicable'});
        return {auditId:id, result, receipt};
    } catch (error) {
        const confirmation = receipt.confirmation === 'confirmed' ? 'confirmed' : localApplied ? 'not_applicable' : error.confirmation || receipt.confirmation;
        const status = confirmation === 'confirmed' || localApplied ? 'local_error' : confirmation === 'rejected' ? 'rejected' : confirmation === 'unknown' ? 'unknown' : 'failed';
        try {
            await journal.finishModerationAction(id, {
                status, confirmation, httpStatus:error.httpStatus || receipt.httpStatus,
                endpoint:error.endpoint || receipt.endpoint,
                errorKind:confirmation === 'confirmed' || localApplied ? 'storage' : error.errorKind || 'validation_or_local'
            });
        } catch { console.error(`Не удалось завершить запись журнала #${id}; результат требует проверки.`); }
        // Expose only structured, safe diagnostics; never store raw network errors or headers.
        const failure = new Error(`Действие #${id}: ${status}`);
        Object.assign(failure,{auditId:id,confirmation,httpStatus:error.httpStatus || receipt.httpStatus,status});
        throw failure;
    }
}
module.exports = {runAuditedAction};
