const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');const path=require('node:path');
const {createTokenManager}=require('../src/services/token-manager');
let folder;
const fixtures=[];
async function fixture(options={}) {
 folder ||= await fs.mkdtemp(path.join(os.tmpdir(),'twbot-oauth-'));
 const file=path.join(folder,`${fixtures.length}.json`);fixtures.push(file);
 const env={CLIENT_ID:'test-client',BOT_USERNAME:'testbot',ACCESS_TOKEN:'old-access',REFRESH_TOKEN:'old%refresh&=token',CLIENT_SECRET:'test-secret',...options.env};
 return {file,env,manager:createTokenManager({env,file,...options,env})};
}
const validation=()=>({ok:true,status:200,json:async()=>({client_id:'test-client',login:'testbot',scopes:['chat:read','chat:edit','moderator:manage:banned_users','moderator:manage:chat_messages']})});
const refreshed=()=>({ok:true,status:200,json:async()=>({access_token:'new-access',refresh_token:'new-refresh'})});
after(async()=>{if(folder)await fs.rm(folder,{recursive:true,force:true});});
test('simultaneous refreshes rotate once, encode secrets and survive restart',async()=>{
 let refreshCalls=0, posted;
 const item=await fixture({fetchImpl:async(url,options)=>{
  if(url.endsWith('/token')){refreshCalls++;posted=new URLSearchParams(options.body);return refreshed();}
  return validation();
 }});
 await Promise.all([item.manager.refresh('old-access'),item.manager.refresh('old-access'),item.manager.refresh('old-access')]);
 assert.equal(refreshCalls,1);assert.equal(posted.get('refresh_token'),'old%refresh&=token');assert.equal(posted.get('client_secret'),'test-secret');
 assert.equal(item.env.ACCESS_TOKEN,'new-access');assert.equal(item.env.REFRESH_TOKEN,'new-refresh');
 const stored=JSON.parse(await fs.readFile(item.file,'utf8'));assert.equal(stored.refreshToken,'new-refresh');assert.equal(JSON.stringify(stored).includes('test-secret'),false);
 if(process.platform!=='win32')assert.equal((await fs.stat(item.file)).mode & 0o777,0o600);
 const restartedEnv={...item.env,ACCESS_TOKEN:'stale',REFRESH_TOKEN:'stale'};
 const restarted=createTokenManager({env:restartedEnv,file:item.file,fetchImpl:async()=>validation()});
 await restarted.check(true);assert.equal(restartedEnv.ACCESS_TOKEN,'new-access');assert.equal(restartedEnv.REFRESH_TOKEN,'new-refresh');
 await item.manager.refresh('old-access');assert.equal(refreshCalls,1);
});
test('valid access token does not refresh and validation is throttled to hourly',async()=>{
 let calls=0,now=100000;const item=await fixture({clock:()=>now,fetchImpl:async url=>{assert.ok(url.endsWith('/validate'));calls++;return validation();}});
 await item.manager.check();await item.manager.check();assert.equal(calls,1);
 now+=3600000;await item.manager.check();assert.equal(calls,2);
});
test('expired startup access token is refreshed before use',async()=>{
 let calls=0;
 const item=await fixture({fetchImpl:async(url,options)=>{
  if(url.endsWith('/token')){calls++;return refreshed();}
  return options.headers.Authorization==='OAuth old-access'?{ok:false,status:401}:validation();
 }});
 await item.manager.check(true);assert.equal(calls,1);assert.equal(item.env.ACCESS_TOKEN,'new-access');
});
test('invalid refresh grant is fatal and does not disclose response secrets',async()=>{
 const item=await fixture({fetchImpl:async()=>({ok:false,status:400,json:async()=>({message:'SENSITIVE_RESPONSE'})})});
 await assert.rejects(item.manager.refresh(),error=>error.fatal && !error.message.includes('SENSITIVE_RESPONSE'));
 assert.equal(item.env.ACCESS_TOKEN,'old-access');await assert.rejects(fs.stat(item.file));
});
test('temporary validation outage preserves rotated token without refreshing again',async()=>{
 let now=100000,refreshCalls=0,validationCalls=0;
 const item=await fixture({clock:()=>now,fetchImpl:async url=>{
  if(url.endsWith('/token')){refreshCalls++;return refreshed();}
  validationCalls++;if(validationCalls===1)throw new Error('secret error');return validation();
 }});
 await assert.rejects(item.manager.refresh());assert.equal(item.env.ACCESS_TOKEN,'old-access');
 assert.equal(JSON.parse(await fs.readFile(item.file,'utf8')).refreshToken,'new-refresh');
 now+=60000;await item.manager.refresh();assert.equal(refreshCalls,1);assert.equal(item.env.ACCESS_TOKEN,'new-access');
});
test('foreign identity is never installed for active requests',async()=>{
 const item=await fixture({fetchImpl:async url=>url.endsWith('/token')?refreshed():{ok:true,status:200,json:async()=>({...await validation().json(),login:'anotherbot'})}});
 await assert.rejects(item.manager.refresh(),error=>error.fatal);assert.equal(item.env.ACCESS_TOKEN,'old-access');
});
test('storage failure prevents installation of refreshed credentials',async()=>{
 const item=await fixture({save:async()=>{throw Object.assign(new Error('cannot store'),{fatal:true});},fetchImpl:async url=>url.endsWith('/token')?refreshed():validation()});
 await assert.rejects(item.manager.refresh());assert.equal(item.env.ACCESS_TOKEN,'old-access');
});
test('public clients omit secret, malformed responses and missing refresh credentials fail safely',async()=>{
 const publicItem=await fixture({env:{OAUTH_CLIENT_TYPE:'public',CLIENT_SECRET:''},fetchImpl:async(url,options)=>{
  if(url.endsWith('/token')){assert.equal(new URLSearchParams(options.body).has('client_secret'),false);return refreshed();}return validation();
 }});await publicItem.manager.refresh();
 const missing=await fixture({env:{REFRESH_TOKEN:''},fetchImpl:async()=>{throw new Error('must not request');}});await assert.rejects(missing.manager.refresh(),error=>error.fatal);
 const malformed=await fixture({fetchImpl:async()=>({ok:true,status:200,json:async()=>({access_token:'bad token'})})});await assert.rejects(malformed.manager.refresh(),error=>error.fatal);
});
test('Helix retries a rejected 401 once with fresh token but never retries ambiguous 5xx',async()=>{
 const api=require('../src/services/api');const {tokenManager}=require('../src/services/token-manager');
 const originalFetch=global.fetch,originalRefresh=tokenManager.refresh;
 const oldAccess=process.env.ACCESS_TOKEN,oldRefresh=process.env.REFRESH_TOKEN;
 process.env.ACCESS_TOKEN='old';process.env.REFRESH_TOKEN='configured';let refreshes=0;const auth=[];
 tokenManager.refresh=async failed=>{assert.equal(failed,'old');refreshes++;process.env.ACCESS_TOKEN='new';};
 try {
  global.fetch=async(url,options)=>{auth.push(options.headers.Authorization);return {ok:auth.length>1,status:auth.length>1?200:401};};
  const receipt=await api.request('moderation/bans',{},'POST',{data:{}},true);
  assert.equal(receipt.confirmation,'confirmed');assert.deepEqual(auth,['Bearer old','Bearer new']);assert.equal(refreshes,1);
  let calls=0;global.fetch=async()=>{calls++;return {ok:false,status:503};};
  await assert.rejects(api.request('moderation/bans',{},'POST',{data:{}},true),error=>error.confirmation==='unknown');assert.equal(calls,1);assert.equal(refreshes,1);
  calls=0;global.fetch=async()=>{calls++;return {ok:false,status:401};};
  process.env.ACCESS_TOKEN='old';
  await assert.rejects(api.request('moderation/bans',{},'POST',{data:{}},true));assert.equal(calls,2);assert.equal(refreshes,2);
 }finally{
  global.fetch=originalFetch;tokenManager.refresh=originalRefresh;
  if(oldAccess===undefined)delete process.env.ACCESS_TOKEN;else process.env.ACCESS_TOKEN=oldAccess;
  if(oldRefresh===undefined)delete process.env.REFRESH_TOKEN;else process.env.REFRESH_TOKEN=oldRefresh;
 }
});
test('Axios reads refreshed credentials instead of captured startup credentials',async()=>{
 const http=require('../src/services/http');const {tokenManager}=require('../src/services/token-manager');
 const oldAdapter=http.defaults.adapter,oldRefreshFn=tokenManager.refresh;
 const oldAccess=process.env.ACCESS_TOKEN,oldRefresh=process.env.REFRESH_TOKEN;
 process.env.ACCESS_TOKEN='old-axios';process.env.REFRESH_TOKEN='configured';const auth=[];
 tokenManager.refresh=async()=>{process.env.ACCESS_TOKEN='new-axios';};
 http.defaults.adapter=async config=>{
  auth.push(config.headers.Authorization);
  if(auth.length===1)throw Object.assign(new Error('sensitive headers'),{config,response:{status:401}});
  return {status:200,data:{ok:true},headers:{},config};
 };
 try {
  assert.equal((await http.get('https://api.twitch.tv/helix/streams')).data.ok,true);
  assert.deepEqual(auth,['Bearer old-axios','Bearer new-axios']);
  await assert.rejects(http.get('https://untrusted.example/'),error=>!error.message.includes('old-axios'));
  assert.equal(auth.length,2);
 }finally{
  http.defaults.adapter=oldAdapter;tokenManager.refresh=oldRefreshFn;
  if(oldAccess===undefined)delete process.env.ACCESS_TOKEN;else process.env.ACCESS_TOKEN=oldAccess;
  if(oldRefresh===undefined)delete process.env.REFRESH_TOKEN;else process.env.REFRESH_TOKEN=oldRefresh;
 }
});
test('revoked authorization notifies owner once and stops further refresh attempts',async()=>{
 let calls=0,notified=0;
 const item=await fixture({fetchImpl:async()=>{calls++;return {ok:false,status:401};}});
 const unsubscribe=item.manager.onFatal(()=>{notified++;});
 await assert.rejects(item.manager.refresh());await assert.rejects(item.manager.check());
 assert.equal(notified,1);assert.equal(calls,1);unsubscribe();
});
