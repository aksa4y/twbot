const { username, amount, limitedMap } = require('../utils/security');
const {tokenManager} = require('./token-manager');
const cache = limitedMap(2000, 3600000);
async function request(endpoint, query = {}, method = 'GET', data, receipt = false, retried = false) {
 const url = new URL(`https://api.twitch.tv/helix/${endpoint}`);
 for (const [k,v] of Object.entries(query)) url.searchParams.set(k, v);
 const usedToken=process.env.ACCESS_TOKEN;
 let response;
 try {response = await fetch(url, {
  method, redirect:'error', signal: AbortSignal.timeout(8000),
  headers: {'Client-ID': process.env.CLIENT_ID, Authorization: `Bearer ${usedToken}`, 'Content-Type': 'application/json'},
  ...(data ? {body: JSON.stringify(data)} : {})
 });} catch {
  const error = new Error(`Twitch API ${endpoint}: network failure`);
  Object.assign(error,{confirmation:method === 'GET' ? 'not_sent' : 'unknown',endpoint,errorKind:'network'});
  throw error;
 }
 if (response.status===401 && !retried && process.env.REFRESH_TOKEN) {
  try {await tokenManager.refresh(usedToken);}
  catch {throw Object.assign(new Error('Не удалось обновить OAuth Twitch'),{confirmation:'rejected',endpoint,errorKind:'auth',httpStatus:401});}
  // Twitch explicitly rejected this request as unauthenticated. Retry only once, never after a timeout/5xx.
  return request(endpoint,query,method,data,receipt,true);
 }
 if (!response.ok) {
  const error = new Error(`Twitch API ${endpoint}: HTTP ${response.status}`);
  Object.assign(error,{confirmation:method === 'GET' ? 'not_sent' : response.status >= 500 || response.status === 408 ? 'unknown' : 'rejected',httpStatus:response.status,endpoint,errorKind:'http'});
  throw error;
 }
 if (receipt) return {confirmation:'confirmed',httpStatus:response.status,endpoint};
 return response.status === 204 ? null : response.json();
}
async function getUserId(name) {
 name = username(name);
 if (cache.get(name)) return cache.get(name);
 const result = await request('users', {login:name});
 if (!result.data?.[0]) throw new Error('Пользователь Twitch не найден');
 cache.set(name, result.data[0].id);
 return result.data[0].id;
}
async function ids(channel, target) {
 const [broadcaster_id, moderator_id] = await Promise.all([getUserId(channel), getUserId(process.env.BOT_USERNAME)]);
 const result = {broadcaster_id, moderator_id};
 if (target) result.user_id = await getUserId(target);
 return result;
}
async function timeoutUser(channel, target, duration, reason) {
 duration = amount(duration, 1209600);
 const {user_id, ...query} = await ids(channel, target);
 return request('moderation/bans', query, 'POST', {data:{user_id, duration, reason: String(reason || '').slice(0,500)}},true);
}
async function banUser(channel, target, reason) {
 const {user_id, ...query} = await ids(channel, target);
 return request('moderation/bans', query, 'POST', {data:{user_id, reason:String(reason || '').slice(0,500)}},true);
}
async function unbanUser(channel, target) {return request('moderation/bans', await ids(channel,target), 'DELETE',undefined,true);}
async function deleteMessage(channel, message_id) {
 if (!/^[a-zA-Z0-9-]{1,100}$/.test(message_id || '')) throw new Error('Нет корректного ID сообщения');
 return request('moderation/chat', {...await ids(channel), message_id}, 'DELETE',undefined,true);
}
async function validateToken() {return tokenManager.validate();}
module.exports = { request, getUserId, timeoutUser, banUser, unbanUser, deleteMessage, validateToken };
