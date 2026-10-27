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
 const previous=api.timeoutUser;let timeouts=0;api.timeoutUser=async()=>{timeouts++;};
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
 for(const [tags,mayModerate,mayOwn] of cases){
  let now=100000;const invoked=[];
  const dispatch=createDispatcher({clock:()=>now,moderatorHandlers:{ban:async()=>invoked.push('ban')},userHandlers:{addpoints:async()=>invoked.push('points'),test:async()=>invoked.push('test')}});
  for(const message of ['!бан @target','!+очки @target 1','!тест текст']){
   await dispatch({channel:'#streamer',tags:{...tags,username:'roleuser'},message,permissions:getPermissions(tags)});now+=3001;
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
 const events=[];const handle=createMessageHandler({send:async()=>events.push('send'),moderate:async()=>events.push('moderate'),dispatch:async()=>events.push('dispatch'),twitchApi:{deleteMessage:async()=>events.push('delete')}});
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
 const moderate=createAutoModeration({client:{},send:async()=>events.push('send'),moderation:{hasForbiddenWords:()=>true,getTimeoutDuration:()=>600,handleTimeout:async()=>events.push('timeout')},twitchApi:{deleteMessage:async()=>events.push('delete')}});
 assert.equal(await moderate('#streamer',{id:'message'},'нарушение','viewer'),true);
 assert.deepEqual(events,['timeout','delete']);
});
