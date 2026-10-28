const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env'), quiet: true });
const { username } = require('./utils/security');
function getAutoModerationMode() {
 const mode = process.env.AUTOMOD_MODE || 'observe';
 if (!['observe','active'].includes(mode)) throw new Error('AUTOMOD_MODE должен быть observe или active');
 return mode;
}
function validateConfig() {
 getAutoModerationMode();
 if (!['confidential','public'].includes(process.env.OAUTH_CLIENT_TYPE || 'confidential')) throw new Error('Некорректный OAUTH_CLIENT_TYPE');
 if (process.env.REFRESH_TOKEN && process.env.OAUTH_CLIENT_TYPE !== 'public' && !process.env.CLIENT_SECRET) throw new Error('Для REFRESH_TOKEN заполните CLIENT_SECRET');
 for (const key of ['ACCESS_TOKEN','CLIENT_ID','BOT_USERNAME','CHANNEL_NAME']) {
  if (!process.env[key] || /EXAMPLE|YOUR_|ваш/i.test(process.env[key])) throw new Error(`Заполните ${key} в config/.env`);
 }
 process.env.ACCESS_TOKEN = process.env.ACCESS_TOKEN.replace(/^oauth:/, '');
 for (const key of ['BOT_USERNAME','CHANNEL_NAME']) process.env[key] = username(process.env[key]);
 if (process.env.API_ENABLED === 'true' && (!process.env.API_KEY || Buffer.byteLength(process.env.API_KEY) < 32)) throw new Error('API_KEY должен содержать минимум 32 байта');
 if (process.env.API_PORT && (!/^\d+$/.test(process.env.API_PORT) || Number(process.env.API_PORT)<1 || Number(process.env.API_PORT)>65535)) throw new Error('Некорректный API_PORT');
}
module.exports = { validateConfig, getAutoModerationMode };
