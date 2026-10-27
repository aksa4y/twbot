const { forbiddenWords, wordTimeoutMap } = require('./bannedWords');
const api = require('../services/api');
const {runAuditedAction} = require('../services/action-audit');
const database = require('../services/database');
const { normalize, username, amount, limitedMap } = require('../utils/security');
let spamCache = limitedMap();
let capsWarnCache = limitedMap();
function resetAutoModerationCounters() {spamCache=limitedMap();capsWarnCache=limitedMap();}
function hasForbiddenWords(message) {
 const words = normalize(message).match(/[\p{L}\p{N}_]+/gu) || [];
 return forbiddenWords.some(word => normalize(word).includes(' ') ? ` ${normalize(message)} `.includes(` ${normalize(word)} `) : words.includes(normalize(word)));
}
function getTimeoutDuration(message) {
 const words = normalize(message).split(/[^\p{L}\p{N}_]+/u);
 for (const [word, duration] of Object.entries(wordTimeoutMap)) if (words.includes(normalize(word))) return amount(duration,1209600);
 return 600;
}
function checkCaps(message, name) {
 const letters = message.match(/\p{L}/gu) || [];
 const upper = letters.filter(c => c !== c.toLowerCase()).length;
 if (letters.length < 5 || upper/letters.length <= 0.7) return null;
 const warnings = (capsWarnCache.get(name) || 0)+1;
 if (warnings <= 2) {capsWarnCache.set(name,warnings);return {warning:`@${name}, уберите капс (${warnings}/2).`};}
 capsWarnCache.delete(name);
 return {timeout:true,duration:600,reason:'Капс после двух предупреждений'};
}
async function checkSpam(name, message) {
 const now = Date.now(); message = normalize(message);
 const previous = spamCache.get(name);
 const count = previous && previous.message === message && now-previous.time<10000 ? previous.count+1 : 1;
 spamCache.set(name,{message,time:now,count});
 if (count >= 3) {spamCache.delete(name);return {timeout:true,duration:300,reason:'Повтор сообщений'};}
 return count === 2 ? {warning:`@${name}, не повторяйте сообщения.`} : null;
}
function target(name) {
 name = username(name);
 if (name === process.env.BOT_USERNAME || name === process.env.CHANNEL_NAME) throw new Error('Нельзя применять наказание к боту или владельцу канала');
 return name;
}
async function handleTimeout(client, channel, name, duration, reason, context = {}) {
 return runAuditedAction({action:'timeout',channel,target:name,duration:Number(duration),reason,context,
  remote:()=>api.timeoutUser(channel,target(name),amount(duration,1209600),reason)});
}
async function handleBan(client, channel, name, reason, context = {}) {
 return runAuditedAction({action:'ban',channel,target:name,reason,context,
  remote:()=>api.banUser(channel,target(name),reason),
  local:()=>database.createBan(username(name),reason)});
}
async function handleUnban(client, channel, name, context = {}) {
 await runAuditedAction({action:'unban',channel,target:name,reason:context.reason || 'Снятие бана',context,
  remote:()=>api.unbanUser(channel,username(name)),local:()=>database.unbanUser(username(name))});
 return `@${username(name)} разбанен.`;
}
async function handleWarn(name, reason = 'Предупреждение модератора', context = {}) {
 const {result:count,auditId} = await runAuditedAction({action:'warn',channel:context.channel || process.env.CHANNEL_NAME,target:name,reason,context,
  local:()=>database.recordWarn(target(name),reason)});
 return count >= 3 ? {type:'timeout', duration:600,reason:'Три предупреждения за 24 часа',auditId} : {type:'message',text:`@${username(name)}, предупреждение ${count}/3. Причина: ${reason}`,auditId};
}
module.exports = {resetAutoModerationCounters,hasForbiddenWords,getTimeoutDuration,checkCaps,checkSpam,handleTimeout,handleBan,handleUnban,handleWarn};
