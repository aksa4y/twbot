const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { username, amount, limitedMap } = require('../utils/security');
const database = require('../services/database');
const moderation = require('../commands/moderation');
function createApp(client) {
 const key = process.env.API_KEY;
 if (!key || Buffer.byteLength(key)<32) throw new Error('API_KEY должен содержать минимум 32 байта');
 const app = express();
 app.disable('x-powered-by');
 const limits=limitedMap(1000,60000);
 app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
  const now=Date.now();const old=limits.get(req.socket.remoteAddress);
  const state=old && old.until>now ? old : {count:0,until:now+60000};
  state.count++;limits.set(req.socket.remoteAddress,state);
  if(state.count>60) return res.status(429).json({error:'Слишком много запросов'});
  const supplied=Buffer.from(String(req.headers['x-api-key'] || ''));const expected=Buffer.from(key);
  if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return res.status(401).json({error:'Нет доступа'});
  next();
 });
 app.use(express.json({limit:'8kb',strict:true}));
 const route = fn => (req,res,next) => Promise.resolve().then(()=>fn(req,res)).catch(next);
 app.get('/stats/top',route(async(req,res)=>{
  const functions={points:database.getTopPoints,iq:database.getTopIQ,warns:database.getTopWarns};
  if(!Object.hasOwn(functions,req.query.type)) return res.status(400).json({error:'Неверный тип'});
  res.json(await functions[req.query.type](amount(req.query.limit || 10,100)));
 }));
 app.get('/stats/user/:username',route(async(req,res)=>{
  const name=username(req.params.username);
  const [iq,points,warns]=await Promise.all([database.getUserIQ(name),database.getUserPoints(name),database.getUserWarns(name)]);
  res.json({username:name,iq,points,warns});
 }));
 app.post('/command/:command',route(async(req,res)=>{
  const name=String(req.body.username || '');const channel=process.env.CHANNEL_NAME;
  const audit={source:'api',actor:'api_key',command:req.params.command,channel};
  const reason=String(req.body.reason || 'Нарушение правил').slice(0,500);
  switch(req.params.command) {
   case 'ban': await moderation.handleBan(client,channel,name,reason,audit); break;
   case 'unban': await moderation.handleUnban(client,channel,name,{...audit,reason}); break;
   case 'timeout': await moderation.handleTimeout(client,channel,name,req.body.duration,reason,audit); break;
   case 'warn': {
    const result=await moderation.handleWarn(name,reason,audit);
    if(result.type==='timeout') await moderation.handleTimeout(client,channel,name,result.duration,result.reason,{...audit,parentId:result.auditId});
    return res.json({success:true,result});
   }
   default:return res.status(404).json({error:'Неизвестная команда'});
  }
  res.json({success:true});
 }));
 app.post('/points/add',route(async(req,res)=>{
  await database.addUserPoints(username(req.body.username),amount(req.body.amount));res.json({success:true});
 }));
 app.use((err,req,res,next)=>{
  if(res.headersSent) return next(err);
  const status=err.type==='entity.too.large'?413:err instanceof SyntaxError?400:500;
  res.status(status).json({error:status===500?'Не удалось выполнить запрос':'Некорректное тело запроса',...(err.auditId ? {auditId:err.auditId,confirmation:err.confirmation,httpStatus:err.httpStatus} : {})});
 });
 return app;
}
function startApiServer(client) {
 if(process.env.API_ENABLED!=='true') return null;
 const app=createApp(client);
 const server=app.listen(Number(process.env.API_PORT || 3001),'127.0.0.1',()=>console.log('API доступен только на 127.0.0.1'));
 server.on('error',()=>{console.error('Не удалось запустить API');process.exit(1);});
 return server;
}
module.exports={createApp,startApiServer};
