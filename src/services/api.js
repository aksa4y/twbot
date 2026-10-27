const { username, amount, limitedMap } = require('../utils/security');
const cache = limitedMap(2000, 3600000);
async function request(endpoint, query = {}, method = 'GET', data, receipt = false) {
 const url = new URL(`https://api.twitch.tv/helix/${endpoint}`);
 for (const [k,v] of Object.entries(query)) url.searchParams.set(k, v);
 let response;
 try {response = await fetch(url, {
  method, signal: AbortSignal.timeout(8000),
  headers: {'Client-ID': process.env.CLIENT_ID, Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
  ...(data ? {body: JSON.stringify(data)} : {})
 });} catch {
  const error = new Error(`Twitch API ${endpoint}: network failure`);
  Object.assign(error,{confirmation:method === 'GET' ? 'not_sent' : 'unknown',endpoint,errorKind:'network'});
  throw error;
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
async function validateToken() {
 const response = await fetch('https://id.twitch.tv/oauth2/validate', {headers:{Authorization:`OAuth ${process.env.ACCESS_TOKEN}`}, signal:AbortSignal.timeout(8000)});
 if (!response.ok) throw new Error('Токен Twitch недействителен: получите новый токен');
 const token = await response.json();
 if (token.client_id !== process.env.CLIENT_ID || token.login !== process.env.BOT_USERNAME) throw new Error('Токен не соответствует CLIENT_ID или BOT_USERNAME');
 for (const scope of ['chat:read','chat:edit','moderator:manage:banned_users','moderator:manage:chat_messages']) {
  if (!token.scopes?.includes(scope)) throw new Error(`Токену не хватает права ${scope}`);
 }
 return token;
}
module.exports = { request, getUserId, timeoutUser, banUser, unbanUser, deleteMessage, validateToken };
