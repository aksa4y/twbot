const normalize = text => String(text).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function username(value) {
 const result = String(value || '').replace(/^[@#]/, '').toLowerCase();
 if (!/^[a-z0-9_]{1,25}$/.test(result)) throw new Error('Некорректный Twitch ник');
 return result;
}
function amount(value, max = 1000000) {
 if (!/^\d+$/.test(String(value))) throw new Error('Требуется целое положительное число');
 const n = Number(value);
 if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Число должно быть от 1 до ${max}`);
 return n;
}
function limitedMap(max = 10000, ttl = 600000) {
 const map = new Map();
 return { get(key) {const v = map.get(key); if (!v) return; if (v.until <= Date.now()) {map.delete(key); return;} return v.value;},
 set(key, value) {if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value); map.set(key, {value, until: Date.now()+ttl});}, delete: key => map.delete(key) };
}
function hasLink(text) {return /(?:https?:\/\/|www\.|(?:[\p{L}\d-]+\.)+[\p{L}]{2,63}(?:\b|\/))/iu.test(normalize(text));}
module.exports = { normalize, username, amount, limitedMap, hasLink };
