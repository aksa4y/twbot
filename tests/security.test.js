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
const {TwitchBot}=require('../src/bot');
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
 const bot=Object.create(TwitchBot.prototype);bot.commandTimes=require('../src/utils/security').limitedMap();
 let calls=0;bot.runAutoModeration=async()=>{calls++;return true;};bot.safeSay=async()=>{};
 for(const message of ['!iq плохой текст','когда плохой текст'])await bot.onMessage('#streamer',{username:'viewer',badges:{}},message,false);
 assert.equal(calls,2);
 await bot.onMessage('#streamer',{username:'vip',badges:{vip:'1'}},'ПРИВЕТ',false);
 assert.equal(calls,2);
});
test('ordinary user cannot invoke privileged commands',async()=>{
 const bot=Object.create(TwitchBot.prototype);bot.commandTimes=require('../src/utils/security').limitedMap();bot.runAutoModeration=async()=>false;
 let invoked=false;bot.userHandlers={addpoints:async()=>{invoked=true;}};
 await bot.onMessage('#streamer',{username:'viewer',badges:{}},'!+очки @viewer 100',false);
 assert.equal(invoked,false);
});
test('outgoing commands cannot execute slash commands',async()=>{
 const bot=Object.create(TwitchBot.prototype);bot.outgoingTimes=[];const sent=[];bot.client={say:async(c,m)=>sent.push(m)};
 await bot.safeSay('#streamer','/ban victim');await bot.safeSay('#streamer','.timeout victim');
 await bot.safeSay('#streamer','текст\nвторая строка');
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
