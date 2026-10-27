// Do not expose Axios config/headers (including bearer tokens) through error logging.
const axios = require('axios').create({timeout:8000,maxRedirects:0,maxContentLength:1048576});
axios.interceptors.response.use(response=>response, error=>Promise.reject(new Error(`Twitch HTTP: ${error.response?.status || 'network error'}`)));
module.exports = axios;
