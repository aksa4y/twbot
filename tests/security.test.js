const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twbot-test-'));
process.env.DATABASE_FILE=path.join(dir,'test.db');
process.env.BOT_USERNAME='testbot';process.env.CHANNEL_NAME='streamer';
process.env.API_KEY='a'.repeat(64);
const database=require('../src/services/database');
const api=require('../src/services/api');
const moderation=require('../src/commands/moderation');
const {username,amount,hasLink}=require('../src/utils/security');
const {createMessageHandler}=require('../src/chat/message-handler');
const {createDispatcher}=require('../src/commands/dispatcher');
const {createSender}=require('../src/chat/sender');
before(()=>database.ready);
after(async()=>{await database.close();fs.rmSync(dir,{recursive:true,force:true});});
test('strict identifiers and numeric values',()=>{
 assert.equal(username('@TEST_user'),'test_user');
 for(const n of ['1x',-1,0,Infinity,1.5,1e30])assert.throws(()=>amount(n));
 assert.throws(()=>username('test&login=other'));
 assert.ok(hasLink('спам example.com'));assert.ok(hasLink('https://example.com'));
});
test('spam normalizes case, spaces and invisible characters',async()=>{
 assert.equal(await moderation.checkSpam('spammer','ТеСт  привет'),null);
 assert.ok((await moderation.checkSpam('spammer','тест привет')).warning);
 assert.ok((await moderation.checkSpam('spammer','те\u200bст привет')).timeout);
});
test('caps requires two warnings',()=>{
 assert.ok(moderation.checkCaps('ПРИВЕТ ЁЖИК','capsuser').warning);
 assert.ok(moderation.checkCaps('ПРИВЕТ ЁЖИК','capsuser').warning);
 assert.ok(moderation.checkCaps('ПРИВЕТ ЁЖИК','capsuser').timeout);
});
test('parallel transfers cannot overspend or mint points',async()=>{
 await database.addUserPoints('alice',100);
 const results=await Promise.allSettled([database.transferPoints('alice','bob',80),database.transferPoints('alice','carol',80)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const balances=await Promise.all(['alice','bob','carol'].map(database.getUserPoints));
 assert.equal(balances.reduce((a,b)=>a+b),100);assert.ok(balances.every(n=>n>=0));
 await assert.rejects(database.transferPoints('alice','alice',1));
});
test('duel settles exactly once and conserves total balance',async()=>{
 await database.addUserPoints('duela',100);await database.addUserPoints('duelb',100);
 const id=await database.createDuel('duela','duelb',50,new Date(Date.now()+60000));
 const results=await Promise.allSettled([database.settleDuel(id,'duela'),database.settleDuel(id,'duela')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(await database.getUserPoints('duela'),150);assert.equal(await database.getUserPoints('duelb'),50);
});
test('daily claim is atomic',async()=>{
 const claims=await Promise.all([database.checkDailyFortune('daily'),database.checkDailyFortune('daily')]);
 assert.equal(claims.filter(Boolean).length,1);
});
test('commands and когда text always pass moderation first; VIP is exempt',async()=>{
 let calls=0;
 const handle=createMessageHandler({moderate:async()=>{calls++;return true;},send:async()=>{},dispatch:async()=>{}});
 for(const message of ['!iq плохой текст','когда плохой текст'])await handle('#streamer',{username:'viewer',badges:{}},message,false);
 assert.equal(calls,2);
 await handle('#streamer',{username:'vip',badges:{vip:'1'}},'ПРИВЕТ',false);
 assert.equal(calls,2);
});
test('ordinary user cannot invoke privileged commands',async()=>{
 let invoked=false;
 const dispatch=createDispatcher({moderatorHandlers:{},userHandlers:{addpoints:async()=>{invoked=true;}}});
 const handle=createMessageHandler({moderate:async()=>false,send:async()=>{},dispatch});
 await handle('#streamer',{username:'viewer',badges:{}},'!+очки @viewer 100',false);
 assert.equal(invoked,false);
});
test('outgoing commands cannot execute slash commands',async()=>{
 const sent=[];const send=createSender({client:{say:async(c,m)=>sent.push(m)}});
 await send('#streamer','/ban victim');await send('#streamer','.timeout victim');
 await send('#streamer','текст\nвторая строка');
 assert.deepEqual(sent,['текст вторая строка']);
});
test('API authenticates, validates body and executes third warning timeout',async()=>{
 const {createApp}=require('../src/api/server');const server=createApp(null).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 const previous=api.timeoutUser;let timeouts=0;api.timeoutUser=async()=>{timeouts++;return {confirmation:'confirmed',httpStatus:200,endpoint:'moderation/bans'};};
 try {
  assert.equal((await fetch(url+'/stats/top?type=points')).status,401);
  for(let i=0;i<3;i++)assert.equal((await fetch(url+'/command/warn',{method:'POST',headers:{'x-api-key':process.env.API_KEY,'content-type':'application/json'},body:JSON.stringify({username:'warnuser'})})).status,200);
  assert.equal(timeouts,1);
  const bad=await fetch(url+'/points/add',{method:'POST',headers:{'x-api-key':process.env.API_KEY,'content-type':'application/json'},body:'{"username":"bad","amount":-100}'});
  assert.notEqual(bad.status,200);
  assert.equal(await database.getUserPoints('bad'),0);
 } finally {api.timeoutUser=previous;await new Promise(resolve=>server.close(resolve));}
});
test('forbidden words match whole words and normalization',()=>{
 const list=require('../src/commands/bannedWords').forbiddenWords;
 list.push('тест');
 try {assert.ok(moderation.hasForbiddenWords('ТЕ\u200bСТ'));assert.equal(moderation.hasForbiddenWords('протест'),false);}finally{list.pop();}
});
test('failed transfer rolls back debit when recipient balance exceeds cap',async()=>{
 await database.addUserPoints('sender',100);
 await database.addUserPoints('receiver',1);
 const connection=new (require('node:sqlite').DatabaseSync)(process.env.DATABASE_FILE);
 connection.prepare('UPDATE bot_points SET points=1000000000 WHERE username=?').run('receiver');connection.close();
 await assert.rejects(database.transferPoints('sender','receiver',50));
 assert.equal(await database.getUserPoints('sender'),100);
 assert.equal(await database.getUserPoints('receiver'),1000000000);
});
test('expired duel cannot settle and duplicate pending invitations are rejected',async()=>{
 const id=await database.createDuel('expireda','expiredb',10,new Date(Date.now()-1000));
 await assert.rejects(database.settleDuel(id,'expireda'));
 await database.createDuel('pendinga','pendingb',10,new Date(Date.now()+60000));
 await assert.rejects(database.createDuel('pendingc','pendingb',10,new Date(Date.now()+60000)));
});
test('vote for unknown game does not consume vote',async()=>{
 assert.equal(await database.voteForGame('stream1','missing','voter'),false);
 await database.addGameProposal('stream1','game','voter');
 assert.equal(await database.voteForGame('stream1','game','voter'),true);
 assert.equal(await database.voteForGame('stream1','game','voter'),false);
});
test('token validation rejects mismatched owner and missing scopes without logging secrets',async()=>{
 const previous=global.fetch;
 process.env.CLIENT_ID='client';
 try {
  global.fetch=async()=>({ok:true,json:async()=>({client_id:'client',login:'other',scopes:[]})});
  await assert.rejects(api.validateToken(),/BOT_USERNAME/);
  global.fetch=async()=>({ok:true,json:async()=>({client_id:'client',login:'testbot',scopes:[]})});
  await assert.rejects(api.validateToken(),/chat:read/);
 }finally{global.fetch=previous;}
});
test('role policy covers moderator and owner-only commands',async()=>{
 const {getPermissions}=require('../src/chat/permissions');
 const cases=[
  [{badges:{}},false,false],
  [{badges:{vip:'1'}},false,false],
  [{mod:true,badges:{}},true,false],
  [{badges:{broadcaster:'1'}},true,true]
 ];
 for(const [index,[tags,mayModerate,mayOwn]] of cases.entries()){
  let now=100000;const invoked=[];
  const dispatch=createDispatcher({clock:()=>now,moderatorHandlers:{ban:async()=>invoked.push('ban')},userHandlers:{addpoints:async()=>invoked.push('points'),test:async()=>invoked.push('test')}});
  for(const message of ['!бан @target','!+очки @target 1','!тест текст']){
   await dispatch({channel:'#streamer',tags:{...tags,username:`roleuser${index}`},message,permissions:getPermissions(tags)});now+=3001;
  }
  assert.deepEqual(invoked,[...(mayModerate?['ban','points']:[]),...(mayOwn?['test']:[])]);
 }
});
test('dispatcher preserves arguments, aliases and special cooldowns',async()=>{
 const {getPermissions}=require('../src/chat/permissions');
 let now=100000;const calls=[];
 const dispatch=createDispatcher({clock:()=>now,moderatorHandlers:{},userHandlers:{roulette:async(...args)=>calls.push(args)}});
 const ctx={channel:'#streamer',tags:{username:'cooluser'},permissions:getPermissions({})};
 await dispatch({...ctx,message:'!РУЛЕТКА   аргумент'});
 now+=3001;await dispatch({...ctx,message:'!рулетка'});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,3),['#streamer',['аргумент'],'cooluser']);
 now+=300000;await dispatch({...ctx,message:'!рулетка'});
 assert.equal(calls.length,2);
});
test('link deletion and ignored events never dispatch commands',async()=>{
 const events=[];
 const {createAutoModeration}=require('../src/chat/automoderation');
 const moderate=createAutoModeration({mode:'active',client:{},send:async()=>events.push('send'),journal:{recordAutoModerationEvent:async()=>1,finishAutoModerationEvent:async()=>{}},twitchApi:{deleteMessage:async()=>{events.push('delete');return {confirmation:'confirmed',httpStatus:204,endpoint:'moderation/chat'};}}});
 const handle=createMessageHandler({moderate,dispatch:async()=>events.push('dispatch')});
 await handle('#streamer',{username:'viewer',id:'message'},'!тест example.com',false);
 assert.deepEqual(events,['delete','send']);
 await handle('#streamer',{username:'viewer'},'!пинг',true);
 await handle('#streamer',null,'!пинг',false);
 assert.deepEqual(events,['delete','send']);
});
test('sender limits output and recovers after its rate window',async()=>{
 let now=100000;const sent=[];
 const send=createSender({clock:()=>now,client:{say:async(channel,text)=>{sent.push(text);return {id:'message'};}}});
 assert.deepEqual(await send('#streamer','😀'.repeat(500),true),{id:'message'});
 assert.equal(Array.from(sent[0]).length,450);
 for(let i=0;i<20;i++)await send('#streamer','ответ');
 assert.equal(sent.length,18);
 now+=30000;await send('#streamer','новое окно');assert.equal(sent.length,19);
});
test('runtime wires modules to the client without starting a connection on import',async()=>{
 const {EventEmitter}=require('node:events');
 const {TwitchBot}=require('../src/bot');
 const client=new EventEmitter();const sent=[];client.say=async(channel,text)=>sent.push(text);
 const bot=new TwitchBot({client});
 assert.equal(client.listenerCount('message'),1);
 await bot.handleMessage('#streamer',{username:'streamer',badges:{broadcaster:'1'}},'!тест проверка',false);
 assert.deepEqual(sent,['проверка']);
 bot.stopping=true;
 await bot.handleMessage('#streamer',{username:'streamer',badges:{broadcaster:'1'}},'!тест ещё',false);
 assert.equal(sent.length,1);
});
test('extracted automoderation applies punishment before deleting the offending message',async()=>{
 const {createAutoModeration}=require('../src/chat/automoderation');
 const events=[];
 const moderate=createAutoModeration({mode:'active',journal:{recordAutoModerationEvent:async()=>1,finishAutoModerationEvent:async()=>{}},client:{},send:async()=>events.push('send'),moderation:{hasForbiddenWords:()=>true,getTimeoutDuration:()=>600,handleTimeout:async()=>events.push('timeout')},twitchApi:{deleteMessage:async()=>{events.push('delete');return {confirmation:'confirmed',httpStatus:204,endpoint:'moderation/chat'};}}});
 assert.equal(await moderate('#streamer',{id:'message'},'нарушение','viewer'),true);
 assert.deepEqual(events,['timeout','delete']);
});
test('cooldowns survive actual process restarts and expire at their original deadlines',()=>{
 const {execFileSync}=require('node:child_process');
 const dbModule=path.resolve(__dirname,'../src/services/database.js');
 const script=`
  const db=require(${JSON.stringify(dbModule)});
  const now=Number(process.argv[1]);
  db.ready.then(async()=>{
   const durations={commands:3000,roulette:300000,report:60000,gift:43200000};
   const result={};
   for(const [key,duration] of Object.entries(durations)) result[key]=db.claimCooldown('channel:streamer:'+key,'restartuser',duration,now);
   result.activity=await db.awardActivityPoints('restartuser','channel:streamer:activity',now);
   result.balance=await db.getUserPoints('restartuser');
   await db.close();console.log(JSON.stringify(result));
  }).catch(()=>process.exit(1));`;
 const run=now=>JSON.parse(execFileSync(process.execPath,['-e',script,String(now)],{env:{...process.env,DATABASE_FILE:path.join(dir,'restart.db')},encoding:'utf8'}));
 assert.deepEqual(run(1000000),{commands:true,roulette:true,report:true,gift:true,activity:true,balance:1});
 assert.deepEqual(run(1001000),{commands:false,roulette:false,report:false,gift:false,activity:false,balance:1});
 assert.deepEqual(run(1300000),{commands:true,roulette:true,report:true,gift:false,activity:true,balance:2});
 assert.equal(run(44200000).gift,true);
});
test('recreated dispatcher honors saved cooldown and channel isolation',async()=>{
 const {getPermissions}=require('../src/chat/permissions');
 let now=1000000;let calls=0;
 const make=()=>createDispatcher({clock:()=>now,moderatorHandlers:{},userHandlers:{roulette:async()=>{calls++;}}});
 const ctx={channel:'#streamer',tags:{username:'dispatchrestart'},message:'!рулетка',permissions:getPermissions({})};
 await make()(ctx);assert.equal(calls,1);
 now+=4000;await make()(ctx);assert.equal(calls,1);
 await make()({...ctx,channel:'#otherchannel'});assert.equal(calls,2);
 now=1300000;await make()(ctx);assert.equal(calls,3);
});
test('gift reset clears persisted gift restrictions without resetting other cooldowns',()=>{
 const user='giftreset';const now=2000000;
 assert.equal(database.claimCooldown('channel:streamer:gift',user,43200000,now),true);
 assert.equal(database.claimCooldown('channel:streamer:roulette',user,300000,now),true);
 database.clearCooldownScope('channel:streamer:gift');
 assert.equal(database.claimCooldown('channel:streamer:gift',user,43200000,now+1),true);
 assert.equal(database.claimCooldown('channel:streamer:roulette',user,300000,now+1),false);
});
test('parallel activity awards issue one point and failed award rolls back its cooldown',async()=>{
 const scope='channel:streamer:activity';const now=3000000;
 const result=await Promise.all([database.awardActivityPoints('activityuser',scope,now),database.awardActivityPoints('activityuser',scope,now)]);
 assert.equal(result.filter(Boolean).length,1);assert.equal(await database.getUserPoints('activityuser'),1);
 await database.addUserPoints('cappedactivity',1);
 const connection=new (require('node:sqlite').DatabaseSync)(process.env.DATABASE_FILE);
 connection.prepare('UPDATE bot_points SET points=1000000000 WHERE username=?').run('cappedactivity');
 await assert.rejects(database.awardActivityPoints('cappedactivity',scope,now));
 connection.prepare('UPDATE bot_points SET points=0 WHERE username=?').run('cappedactivity');connection.close();
 assert.equal(await database.awardActivityPoints('cappedactivity',scope,now),true);
 assert.equal(await database.getUserPoints('cappedactivity'),1);
});
test('observation journals all automatic rules without deletes, timeouts or chat warnings',async()=>{
 const {createAutoModeration}=require('../src/chat/automoderation');
 const cases=[
  {message:'example.com',rule:'link'},
  {message:'запрещённое',rule:'forbidden_word',forbidden:true},
  {message:'КАПС',rule:'caps',caps:{warning:'предупреждение'}},
  {message:'КАПС',rule:'caps',caps:{timeout:true,duration:600,reason:'Капс'}},
  {message:'повтор',rule:'spam',spam:{warning:'не повторяйте'}},
  {message:'повтор',rule:'spam',spam:{timeout:true,duration:300,reason:'Спам'}}
 ];
 for(const [index,item] of cases.entries()){
  const effects=[];
  const moderate=createAutoModeration({mode:'observe',client:{},logger:{info:()=>{}},send:async()=>effects.push('send'),twitchApi:{deleteMessage:async()=>{effects.push('delete');return {confirmation:'confirmed',httpStatus:204,endpoint:'moderation/chat'};}},moderation:{
   hasForbiddenWords:()=>!!item.forbidden,getTimeoutDuration:()=>600,
   checkCaps:()=>item.caps,checkSpam:async()=>item.spam,
   handleTimeout:async()=>effects.push('timeout')
  }});
  const user=`observeuser${index}`;
  assert.equal(await moderate('#streamer',{username:user,id:`message${index}`},item.message,user),true);
  assert.deepEqual(effects,[]);
  const [event]=await database.getAutoModerationEvents({username:user});
  assert.equal(event.rule,item.rule);assert.equal(event.mode,'observe');assert.equal(event.status,'observed');
  assert.equal(event.message,item.message);assert.ok(event.actions.length>0);
 }
});
test('journal is durable across process restart and can be filtered',()=>{
 const {execFileSync}=require('node:child_process');
 const script=`const db=require(${JSON.stringify(path.resolve(__dirname,'../src/services/database.js'))});db.ready.then(async()=>{console.log(JSON.stringify(await db.getAutoModerationEvents({username:'observeuser0',mode:'observe',limit:1})));await db.close();});`;
 const rows=JSON.parse(execFileSync(process.execPath,['-e',script],{env:process.env,encoding:'utf8'}));
 assert.equal(rows.length,1);assert.equal(rows[0].rule,'link');assert.equal(rows[0].actions[0].type,'delete');
});
test('active mode persists a decision before applying it, failures are recorded',async()=>{
 const {createModerationActions}=require('../src/chat/moderation-actions');
 const order=[];
 const apply=createModerationActions({mode:'active',client:{},send:async()=>{},journal:{recordAutoModerationEvent:async()=>{order.push('record');return 1;},finishAutoModerationEvent:async(id,status)=>order.push(status)},moderation:{handleTimeout:async()=>{order.push('timeout');throw new Error('API failed');}},logger:{error:()=>{}}});
 await apply({channel:'#streamer',tags:{username:'viewer'},message:'текст',rule:'caps',actions:[{type:'timeout',duration:600,reason:'Капс'}]});
 assert.deepEqual(order,['record','timeout','failed']);
});
test('journal failure prevents all side effects in both modes',async()=>{
 const {createModerationActions}=require('../src/chat/moderation-actions');
 for(const mode of ['observe','active']){
  const effects=[];
  const apply=createModerationActions({mode,client:{},send:async()=>effects.push('send'),twitchApi:{deleteMessage:async()=>{effects.push('delete');return {confirmation:'confirmed',httpStatus:204,endpoint:'moderation/chat'};}},journal:{recordAutoModerationEvent:async()=>{throw new Error('disk failure');}}});
  await assert.rejects(apply({channel:'#streamer',tags:{username:'viewer'},message:'example.com',rule:'link',actions:[{type:'delete'}]}));
  assert.deepEqual(effects,[]);
 }
});
test('invalid mode cannot silently enable automatic punishment',()=>{
 const {getAutoModerationMode}=require('../src/config');
 const old=process.env.AUTOMOD_MODE;
 try {
  delete process.env.AUTOMOD_MODE;assert.equal(getAutoModerationMode(),'observe');
  process.env.AUTOMOD_MODE='typo';assert.throws(getAutoModerationMode);
 }finally{if(old===undefined)delete process.env.AUTOMOD_MODE;else process.env.AUTOMOD_MODE=old;}
});
test('active mode records successful actions and leaves historical observation entries untouched',async()=>{
 const {createAutoModeration}=require('../src/chat/automoderation');
 const effects=[];const user='activeloguser';
 const moderate=createAutoModeration({mode:'active',client:{},send:async()=>effects.push('send'),twitchApi:{deleteMessage:async()=>{effects.push('delete');return {confirmation:'confirmed',httpStatus:204,endpoint:'moderation/chat'};}}});
 await moderate('#streamer',{username:user,id:'active-message'},'example.com',user);
 assert.deepEqual(effects,['delete','send']);
 const [event]=await database.getAutoModerationEvents({username:user});
 assert.equal(event.status,'applied');assert.equal(event.mode,'active');
 const [observed]=await database.getAutoModerationEvents({username:'observeuser0'});
 assert.equal(observed.status,'observed');
});
test('journal CLI reads persisted messages and safely escapes terminal control characters',async()=>{
 await database.recordAutoModerationEvent({channel:'#streamer',username:'cliloguser',messageId:'cli',message:'\u001b[31mexample.com',rule:'link',actions:[{type:'delete'}],mode:'observe'});
 const {execFileSync}=require('node:child_process');
 const output=execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/moderation-log.js'),'--user','cliloguser','--limit','1'],{env:process.env,encoding:'utf8'});
 assert.equal(output.includes('\u001b'),false);
 const [event]=JSON.parse(output);assert.equal(event.username,'cliloguser');assert.equal(event.message,'\u001b[31mexample.com');
});
function mockTwitch(mode = 'success') {
 const original = global.fetch;
 const calls = [];
 global.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.twitch.tv/')) return original(url,options);
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/users')) {
   if (mode === 'lookup_error') return {ok:false,status:403};
   return {ok:true,status:200,json:async()=>({data:[{id:`id_${parsed.searchParams.get('login')}`}]})};
  }
  calls.push({url:String(url),method:options.method,body:options.body});
  if (mode === 'network') throw new Error('SECRET_TOKEN_IN_NETWORK_ERROR');
  if (typeof mode === 'number') return {ok:false,status:mode};
  return {ok:true,status:options.method === 'DELETE' ? 204 : 200};
 };
 return {calls,restore:()=>{global.fetch=original;}};
}
test('chat moderation audit records authenticated actor, target, reason and Twitch receipt',async()=>{
 const mock=mockTwitch();
 try {
  const {createModeratorHandlers}=require('../src/commands/moderator-handlers');
  const {getPermissions}=require('../src/chat/permissions');
  const sent=[];
  const dispatch=createDispatcher({moderatorHandlers:createModeratorHandlers({client:{},send:async(c,text)=>sent.push(text)}),userHandlers:{}});
  const tags={username:'auditmod',mod:true,'user-id':'1234',id:'command-id'};
  await dispatch({channel:'#streamer',tags,message:'!таймаут @auditvictim 60 повтор сообщений',permissions:getPermissions(tags)});
  const [row]=await database.getModerationActions({target:'auditvictim'});
  assert.equal(row.actor,'auditmod');assert.equal(row.actor_id,'1234');assert.equal(row.request_id,'command-id');
  assert.equal(row.source,'chat');assert.equal(row.action,'timeout');assert.equal(row.reason,'повтор сообщений');assert.equal(row.duration,60);
  assert.equal(row.confirmation,'confirmed');assert.equal(row.status,'confirmed');assert.equal(row.http_status,200);
  assert.equal(mock.calls.length,1);assert.equal(sent.length,1);
 }finally{mock.restore();}
});
test('API audit never trusts a caller-supplied moderator identity',async()=>{
 const mock=mockTwitch();
 const {createApp}=require('../src/api/server');const server=createApp(null).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 try {
  const response=await fetch(`http://127.0.0.1:${server.address().port}/command/ban`,{method:'POST',headers:{'x-api-key':process.env.API_KEY,'content-type':'application/json'},body:JSON.stringify({username:'apivictim',reason:'спам',actor:'fake_moderator'})});
  assert.equal(response.status,200);
  const [row]=await database.getModerationActions({target:'apivictim'});
  assert.equal(row.source,'api');assert.equal(row.actor,'api_key');assert.equal(row.reason,'спам');assert.equal(row.status,'confirmed');
 }finally{mock.restore();await new Promise(resolve=>server.close(resolve));}
});
test('rejection, ambiguous server response, network failure and lookup failure stay distinct',async()=>{
 for(const [index,mode,confirmation,status] of [
  [0,403,'rejected','rejected'],[1,429,'rejected','rejected'],
  [2,503,'unknown','unknown'],[3,'network','unknown','unknown'],
  [4,'lookup_error','not_sent','failed']
 ]){
  const mock=mockTwitch(mode);const user=`auditfailure${index}`;
  try {
   await assert.rejects(moderation.handleTimeout({},'#streamer',user,60,'причина',{source:'chat',actor:'auditmod'}),error=>error.confirmation===confirmation);
   const [row]=await database.getModerationActions({target:user});
   assert.equal(row.confirmation,confirmation);assert.equal(row.status,status);
   assert.equal(JSON.stringify(row).includes('SECRET_TOKEN'),false);
   assert.equal(mock.calls.length,mode==='lookup_error'?0:1);
  }finally{mock.restore();}
 }
});
test('confirmed remote ban is not misreported as rejected after local bookkeeping failure',async()=>{
 const mock=mockTwitch();const original=database.createBan;
 database.createBan=async()=>{throw new Error('disk full');};
 try {
  await assert.rejects(moderation.handleBan({},'#streamer','localfailure','причина',{source:'chat',actor:'auditmod'}),error=>error.confirmation==='confirmed');
  const [row]=await database.getModerationActions({target:'localfailure'});
  assert.equal(row.status,'local_error');assert.equal(row.confirmation,'confirmed');assert.equal(row.http_status,200);
  assert.equal(mock.calls.length,1);
 }finally{database.createBan=original;mock.restore();}
});
test('local warnings and the resulting Twitch timeout are linked in the journal',async()=>{
 const mock=mockTwitch();
 try {
  const {createModeratorHandlers}=require('../src/commands/moderator-handlers');
  const handlers=createModeratorHandlers({client:{},send:async()=>{}});
  for(let i=0;i<3;i++)await handlers.warn('#streamer',['@auditwarn','грубость'],'auditmod',{tags:{'user-id':'1234',id:`warn-${i}`}});
  const rows=await database.getModerationActions({target:'auditwarn'});
  const timeout=rows.find(row=>row.action==='timeout');const warns=rows.filter(row=>row.action==='warn');
  assert.equal(warns.length,3);assert.ok(warns.every(row=>row.status==='local' && row.confirmation==='not_applicable' && row.reason==='грубость'));
  assert.equal(timeout.status,'confirmed');assert.equal(timeout.parent_id,warns[0].id);assert.equal(timeout.actor,'auditmod');
  assert.equal(mock.calls.length,1);
 }finally{mock.restore();}
});
test('automatic actions link to decisions; observation never creates executed-action entries',async()=>{
 const mock=mockTwitch();
 try {
  const {createAutoModeration}=require('../src/chat/automoderation');
  const moderate=createAutoModeration({mode:'active',client:{},send:async()=>{}});
  await moderate('#streamer',{username:'auditauto',id:'auto-message'},'example.com','auditauto');
  const rows=await database.getModerationActions({target:'auditauto'});
  const row=rows.find(entry=>entry.action==='delete');
  assert.equal(rows.find(entry=>entry.action==='warning').confirmation,'not_applicable');
  const [decision]=await database.getAutoModerationEvents({username:'auditauto'});
  assert.equal(row.source,'automod');assert.equal(row.actor,'system');assert.equal(row.action,'delete');assert.equal(row.confirmation,'confirmed');assert.equal(row.decision_id,decision.id);
  assert.deepEqual(await database.getModerationActions({target:'observeuser0'}),[]);
 }finally{mock.restore();}
});
test('audit persistence failure blocks the mutation request',async()=>{
 const {runAuditedAction}=require('../src/services/action-audit');let calls=0;
 await assert.rejects(runAuditedAction({action:'ban',channel:'#streamer',target:'blocked',journal:{recordModerationAction:async()=>{throw new Error('disk full');}},remote:async()=>{calls++;}}));
 assert.equal(calls,0);
});
test('unfinished actions remain unknown and action journal is readable after restart',async()=>{
 const id=await database.recordModerationAction({source:'chat',actor:'auditmod',channel:'#streamer',action:'ban',target:'pendingaudit',reason:'проверка'});
 const {execFileSync}=require('node:child_process');
 const output=execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/actions-log.js'),'--user','pendingaudit'],{env:process.env,encoding:'utf8'});
 const [row]=JSON.parse(output);assert.equal(row.id,id);assert.equal(row.status,'pending');assert.equal(row.confirmation,'unknown');
});
test('chat does not announce success when Twitch outcome is unknown',async()=>{
 const mock=mockTwitch(503);const sent=[];
 try {
  const {createModeratorHandlers}=require('../src/commands/moderator-handlers');
  const handlers=createModeratorHandlers({client:{},send:async(channel,text)=>sent.push(text),logger:{error:()=>{}}});
  await handlers.timeout('#streamer',['@ambiguouschat','60','спам'],'auditmod',{tags:{id:'unknown-chat'}});
  assert.equal(sent.length,1);assert.match(sent[0],/Результат Twitch неизвестен/);assert.equal(sent[0].includes('Выдан таймаут'),false);
 }finally{mock.restore();}
});
test('invalid moderation arguments are logged without sending a Twitch mutation',async()=>{
 const mock=mockTwitch();
 try {
  await assert.rejects(moderation.handleTimeout({},'#streamer','@InvalidDuration',0,'некорректная длительность',{source:'chat',actor:'AUDITMOD'}));
  const [row]=await database.getModerationActions({target:'invalidduration'});
  assert.equal(row.actor,'auditmod');assert.equal(row.target,'invalidduration');assert.equal(row.status,'failed');assert.equal(row.confirmation,'not_sent');assert.equal(mock.calls.length,0);
 }finally{mock.restore();}
});
test('panel serves public assets but protects status, logs and settings',async()=>{
 const {createApp}=require('../src/api/server');const server=createApp(null).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const page=await fetch(base+'/panel');const html=await page.text();assert.equal(page.status,200);assert.match(html,/TWBot/);assert.equal(html.includes(process.env.API_KEY),false);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  for(const asset of ['app.js','styles.css'])assert.equal((await fetch(base+'/panel/'+asset)).status,200);
  for(const route of ['/status','/logs/actions','/logs/observations'])assert.equal((await fetch(base+route)).status,401);
  const headers={'x-api-key':process.env.API_KEY};
  const status=await (await fetch(base+'/status',{headers})).json();assert.ok(status.summary);assert.equal(JSON.stringify(status).includes(process.env.API_KEY),false);
  const log=await (await fetch(base+'/logs/actions?user=auditvictim',{headers})).json();assert.equal(log[0].target,'auditvictim');
  assert.equal((await fetch(base+'/status',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
  const hostileStatus=await new Promise((resolve,reject)=>{const req=require('node:http').get(base+'/status',{headers:{...headers,Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostileStatus,403);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('panel changes mode live, persists it and clears simulated caps counters',async()=>{
 const {EventEmitter}=require('node:events');const {TwitchBot}=require('../src/bot');const {createApp}=require('../src/api/server');
 const fake=()=>{const client=new EventEmitter();client.readyState=()=> 'OPEN';return client;};
 const bot=new TwitchBot({client:fake()});bot.setMode('observe');
 moderation.checkCaps('КАПС СООБЩЕНИЕ','switchmodeuser');moderation.checkCaps('КАПС СООБЩЕНИЕ','switchmodeuser');
 const server=createApp(bot.client,{getStatus:()=>bot.getStatus(),setMode:mode=>bot.setMode(mode)}).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}/settings/automod`;
 try {
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'active'})})).status,401);
  const headers={'x-api-key':process.env.API_KEY,'content-type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({mode:'bad'})})).status,400);
  const result=await (await fetch(url,{method:'POST',headers,body:JSON.stringify({mode:'active'})})).json();
  assert.equal(result.mode,'active');assert.equal(bot.getStatus().mode,'active');assert.ok(moderation.checkCaps('КАПС СООБЩЕНИЕ','switchmodeuser').warning);
  assert.equal(new TwitchBot({client:fake()}).autoModerationMode,'active');
  assert.equal(database.getSetting('automod_mode'),'active');
 }finally{bot.setMode('observe');await new Promise(resolve=>server.close(resolve));}
});
test('a decision retains its evaluated mode if the panel switches mode while logging',async()=>{
 const {createModerationActions}=require('../src/chat/moderation-actions');let mode='observe';const effects=[];
 const apply=createModerationActions({client:{},send:async()=>effects.push('send'),mode:()=>mode,logger:{info:()=>{}},journal:{recordAutoModerationEvent:async event=>{mode='active';assert.equal(event.mode,'observe');return 1;}}});
 await apply({channel:'#streamer',tags:{username:'viewer'},message:'spam',rule:'spam',actions:[{type:'warning',text:'warning'}],evaluatedMode:'observe'});
 assert.deepEqual(effects,[]);
});
