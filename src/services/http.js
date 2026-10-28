// Do not expose Axios config/headers (including bearer tokens) through error logging.
const {tokenManager} = require('./token-manager');
const axios = require('axios').create({timeout:8000,maxRedirects:0,maxContentLength:1048576});
axios.interceptors.request.use(config=>{
 if(new URL(config.url).origin!=='https://api.twitch.tv') throw new Error('Разрешён только Twitch API');
 config.headers['Client-ID']=process.env.CLIENT_ID;
 config.headers.Authorization=`Bearer ${process.env.ACCESS_TOKEN}`;
 config.oauthUsedToken=process.env.ACCESS_TOKEN;
 return config;
});
axios.interceptors.response.use(response=>response, async error=>{
 if(error.response?.status===401 && !error.config?.oauthRetried && process.env.REFRESH_TOKEN) {
  try {await tokenManager.refresh(error.config.oauthUsedToken);return axios.request({...error.config,oauthRetried:true});}
  catch {throw new Error('Twitch HTTP: обновление OAuth не выполнено');}
 }
 throw new Error(`Twitch HTTP: ${error.response?.status || 'network error'}`);
});
module.exports = axios;
