const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const SCOPES = ['chat:read','chat:edit','moderator:manage:banned_users','moderator:manage:chat_messages'];
function authError(message, fatal = false) {return Object.assign(new Error(message),{fatal,authError:true});}
const validSecret = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f]/.test(value);
async function saveTokens(file, data) {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
        await fs.mkdir(path.dirname(file),{recursive:true});
        handle = await fs.open(temporary,'wx',0o600);
        await handle.writeFile(JSON.stringify(data));await handle.sync();await handle.close();handle=null;
        await fs.rename(temporary,file);
    } catch {throw authError('Не удалось сохранить OAuth-токены. Проверьте права на config/.',true);}
    finally {if(handle)await handle.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
}
function createTokenManager({env = process.env, fetchImpl = (...args) => fetch(...args), file = path.join(__dirname,'../../config/oauth-tokens.json'), save = saveTokens, clock = Date.now} = {}) {
    let initialized, refreshing, pendingTokens, fatalError, checkedAt = 0, retryAfter = 0;
    const fatalListeners=new Set();
    function reportFatal(error) {if(error.fatal && !fatalError){fatalError=error;for(const listener of fatalListeners){try{listener(error);}catch{}}}}
    async function initialize() {
        if (!initialized) initialized = (async()=>{
            let stored;
            try {stored=JSON.parse(await fs.readFile(file,'utf8'));}
            catch(error){if(error.code==='ENOENT')return;throw authError('Не удалось прочитать config/oauth-tokens.json.',true);}
            if(stored.clientId!==env.CLIENT_ID || stored.botUsername!==env.BOT_USERNAME || !validSecret(stored.accessToken) || !validSecret(stored.refreshToken)) throw authError('Сохранённые OAuth-токены не соответствуют конфигурации бота.',true);
            env.ACCESS_TOKEN=stored.accessToken;env.REFRESH_TOKEN=stored.refreshToken;
        })();
        return initialized;
    }
    async function validate(accessToken = env.ACCESS_TOKEN) {
        let response;
        try {response=await fetchImpl('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(8000)});}
        catch {throw authError('Сервис проверки Twitch временно недоступен.');}
        if(response.status===401)throw Object.assign(authError('Токен Twitch недействителен.'),{invalidToken:true});
        if(!response.ok)throw authError('Сервис проверки Twitch временно недоступен.');
        let token;try {token=await response.json();}catch{throw authError('Некорректный ответ проверки Twitch.');}
        if(token.client_id!==env.CLIENT_ID || token.login!==env.BOT_USERNAME)throw authError('Токен не соответствует CLIENT_ID или BOT_USERNAME.',true);
        for(const scope of SCOPES)if(!token.scopes?.includes(scope))throw authError(`Токену не хватает права ${scope}`,true);
        return token;
    }
    async function refresh(failedToken = env.ACCESS_TOKEN) {
        await initialize();
        if(fatalError)throw fatalError;
        if(failedToken!==env.ACCESS_TOKEN)return env.ACCESS_TOKEN;
        if(refreshing)return refreshing;
        if(clock()<retryAfter)throw authError('Повтор обновления OAuth временно отложен.');
        refreshing=(async()=>{
            if(!validSecret(env.REFRESH_TOKEN))throw authError('Для автопродления нужен REFRESH_TOKEN от Authorization Code Grant.',true);
            if(env.OAUTH_CLIENT_TYPE!=='public' && !validSecret(env.CLIENT_SECRET))throw authError('Заполните CLIENT_SECRET для автопродления.',true);
            let tokens=pendingTokens;
            if(!tokens) {
            const body=new URLSearchParams({grant_type:'refresh_token',client_id:env.CLIENT_ID,refresh_token:env.REFRESH_TOKEN});
            if(env.OAUTH_CLIENT_TYPE!=='public')body.set('client_secret',env.CLIENT_SECRET);
            let response;
            try {response=await fetchImpl('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),redirect:'error',signal:AbortSignal.timeout(8000)});}
            catch {throw authError('Не получен ответ обновления OAuth. Повтор будет отложен.');}
            if(!response.ok)throw authError(response.status===400 || response.status===401 ? 'Twitch отклонил обновление OAuth. Нужна повторная авторизация.' : 'Обновление OAuth временно недоступно.',response.status===400 || response.status===401);
            try{tokens=await response.json();}catch{throw authError('Не удалось прочитать обновлённые OAuth-токены.',true);}
            if(!validSecret(tokens.access_token) || !validSecret(tokens.refresh_token))throw authError('Twitch вернул некорректные OAuth-токены.',true);
            // Save the rotated refresh token before validation: a transient validation outage
            // must not lose the only usable refresh token. Nothing uses the new access token yet.
            await save(file,{clientId:env.CLIENT_ID,botUsername:env.BOT_USERNAME,accessToken:tokens.access_token,refreshToken:tokens.refresh_token});
            pendingTokens=tokens;
            }
            await validate(tokens.access_token);
            pendingTokens=null;
            env.ACCESS_TOKEN=tokens.access_token;env.REFRESH_TOKEN=tokens.refresh_token;checkedAt=clock();
            return env.ACCESS_TOKEN;
        })();
        try{return await refreshing;}
        catch(error){retryAfter=clock()+60000;reportFatal(error);throw error;}
        finally{refreshing=null;}
    }
    async function check(force = false) {
        await initialize();
        if(fatalError)throw fatalError;
        if(!force && checkedAt && clock()-checkedAt<3600000)return;
        try {const info=await validate();checkedAt=clock();return info;}
        catch(error){if(error.invalidToken){await refresh();return;}reportFatal(error);throw error;}
    }
    return {initialize,validate,refresh,check,onFatal:listener=>{fatalListeners.add(listener);return ()=>fatalListeners.delete(listener);},getAccessToken:()=>env.ACCESS_TOKEN};
}
const tokenManager=createTokenManager();
module.exports={createTokenManager,tokenManager};
