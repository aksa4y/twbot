const database = require('./database');
const {username} = require('../utils/security');
async function createReport(reporter,offender,reason) {
 reporter=username(reporter);offender=username(offender);
 if (!reason || reason.length>500) throw new Error('Причина должна содержать от 1 до 500 символов');
 await database.createReport(reporter,offender,reason);
 return `@${reporter}, жалоба принята. Модератор может открыть её командой !жалобы.`;
}
module.exports={createReport,getPendingReports:database.getPendingReports};
