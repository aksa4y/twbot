const database = require('./database');

const {channelScope} = require('./cooldowns');
async function awardActivityPoints(username) {
    return database.awardActivityPoints(username, channelScope('activity'));
}

async function getPoints(username) {
    return await database.getUserPoints(username);
}

async function spendPoints(username, amount) {
    await database.spendUserPoints(username, amount);
}

async function addPoints(username, amount) {
    await database.addUserPoints(username, amount);
}

async function transferPoints(from, to, amount) {
    await database.transferPoints(from,to,amount);
    return `Переведено ${amount} очков от @${from} к @${to}.`;
}

module.exports = { awardActivityPoints, getPoints, spendPoints, addPoints, transferPoints };
