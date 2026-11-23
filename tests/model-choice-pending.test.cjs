'use strict';
// H5: real preference functions across independent document VMs sharing synthetic
// account-scoped storage. Requests are doubles; no browser, account or model runs.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=process.env.RELAY_TEST_ROOT||path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const A='a'.repeat(16),B='b'.repeat(16);
const plain=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const models=[{id:'sonnet',label:'Sonnet'},{id:'opus',label:'Opus'},{id:'gpt-6.1-sol',label:'GPT Sol',provider:'openai'},{id:'gpt-6-luna',label:'GPT Luna',provider:'openai'}];
function harness({storage=new Map(),account='alice',modelList=models,request}={}) {
  storage.set('lastUserId',account);
  const calls=[],notices=[],timers=new Map(),listeners=new Map(),cached=new Map();let timerId=0;
  const on=(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);};
  const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key),key:index=>[...storage.keys()][index]??null,get length(){return storage.size;}};
  const node={textContent:'',value:'',classList:{add(){},remove(){},toggle(){}},querySelector(){return null;}};
  const c={S:{models:plain(modelList),model:'sonnet',effort:'low',defaultChoice:{model:'gpt-6.1-sol',effort:'high'},serverDefaultChoice:{model:'sonnet',effort:'medium'},choiceExplicitFor:null,choiceWarning:'',conv:null,convId:null,convs:[],running:new Set(),pendingSends:new Set(),view:'chat',projectId:null,projects:[],tools:[],tool:null,atts:[],skew:0,nav:1},
    authState:{epoch:0,user:account},localStorage,crypto:crypto.webcrypto,
    accountCurrent:(epoch,user=account)=>epoch===c.authState.epoch&&user===c.authState.user&&storage.get('lastUserId')===user,
    ls:{get:(key,fallback)=>storage.get(key)??fallback,set:(key,value)=>storage.set(key,String(value)),del:key=>storage.delete(key)},
    local:{get:async key=>cached.get(key),put:async(key,value)=>cached.set(key,value)},
    effortsFor:()=>[['low','快速'],['medium','标准'],['high','深入']],modelLabel:id=>modelList.find(m=>m.id===id)?.label||id,
    $:()=>node,toast:text=>notices.push(text),updateModelBtn(){},menuEl:null,requestPrewarm(){calls.push({url:'/api/prewarm',method:'POST',body:{},keepalive:false});},
    addEventListener:on,document:{hidden:false,addEventListener:on,querySelectorAll:()=>[]},window:{},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    api:async(url,opts={})=>{const body=opts.body?JSON.parse(opts.body):{};const call={url,method:opts.method||'GET',body:plain(body),keepalive:opts.keepalive===true};calls.push(call);return request?request(call):{choice:{model:body.model,effort:body.effort}};},
  };
  vm.createContext(c);
  const post=source.match(/^const post =.*$/m);assert.ok(post,'real post wrapper');vm.runInContext(post[0],c);
  const begin=source.indexOf('// H5：账号只保存新对话默认值'),end=source.indexOf('// GPT 的模型名本身就带',begin);assert.ok(begin>=0&&end>begin);vm.runInContext(source.slice(begin,end),c);
  function open(id=A,model='sonnet',effort='low') {const conv={id,title:'Synthetic '+id,model,effort,messages:[]};c.S.convId=id;c.S.conv=conv;c.S.convs=[{id,model,effort}];c.restoreConversationChoice(conv);return conv;}
  function choose(model,effort='high') {c.S.model=model;c.S.effort=effort;c.choiceChanged();}
  function emit(name) {for(const fn of listeners.get(name)||[])fn();}
  return{c,calls,notices,storage,timers,open,choose,emit,evaluate:code=>vm.runInContext(code,c)};
}
function noChat(h) {assert.ok(h.calls.every(call=>call.url!=='/api/chat'),'preference recovery must never send a chat');}

function records(h,user) {return plain(h.c.readPendingChoices(user));}
function preferencesOnly(h,{allowPrewarm=false}={}) {noChat(h);const requests=h.calls.filter(call=>!allowPrewarm||call.url!=='/api/prewarm');assert.ok(requests.every(call=>call.method==='PATCH'||call.method==='PUT'));assert.ok(requests.every(call=>call.url==='/api/prefs'||/^\/api\/conversations\/[a-f0-9]{16}$/.test(call.url)));}

test('H5 刷新前不足500ms的单次选择同步留存，新页面补交原对话且采用keepalive',async()=>{
  const storage=new Map(),old=harness({storage});old.open();old.choose('gpt-6-luna','high');
  assert.equal(old.calls.length,0);const saved=records(old);assert.equal(saved.length,1);assert.equal(saved[0].user,'alice');assert.equal(saved[0].convId,A);assert.equal(saved[0].choice.model,'gpt-6-luna');assert.ok(saved[0].clientId);assert.ok(Number.isInteger(saved[0].serial)&&saved[0].serial>0);
  const fresh=harness({storage});fresh.open();await fresh.c.restorePendingChoices();
  assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0].url,'/api/conversations/'+A);assert.equal(fresh.calls[0].body.model,'gpt-6-luna');assert.equal(fresh.calls[0].body.effort,'high');assert.equal(fresh.calls[0].keepalive,true);
  assert.equal(fresh.c.S.model,'gpt-6-luna');assert.equal(fresh.c.S.conv.model,'gpt-6-luna');assert.equal(records(fresh).length,0);preferencesOnly(fresh);noChat(old);
});

test('H5 前次保存未完成又换型号，刷新后补交最后一笔而非在途旧选择',async()=>{
  const storage=new Map(),first=deferred(),old=harness({storage,request:()=>first.promise});old.open();old.choose('gpt-6.1-sol');const saving=old.c.flushChoice();await tick();assert.equal(old.calls.length,1);
  const earlier=records(old)[0];old.choose('gpt-6-luna','low');const latest=records(old)[0];assert.equal(latest.choice.model,'gpt-6-luna');assert.notDeepEqual([latest.clientId,latest.serial],[earlier.clientId,earlier.serial]);
  const fresh=harness({storage});fresh.open();await fresh.c.restorePendingChoices();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0].body.model,'gpt-6-luna');assert.equal(fresh.c.S.effort,'low');
  first.resolve({choice:{model:'gpt-6.1-sol',effort:'high'}});await saving;assert.equal(records(fresh).length,0);assert.equal(fresh.c.S.model,'gpt-6-luna');preferencesOnly(old);preferencesOnly(fresh);
});

test('H5 旧页面的匹配回包不能删除新页面更新后的持久记录',async()=>{
  const storage=new Map(),first=deferred(),old=harness({storage,request:()=>first.promise});old.open();old.choose('gpt-6.1-sol');const saving=old.c.flushChoice();await tick();
  const fresh=harness({storage});fresh.open();fresh.choose('gpt-6-luna','low');const newer=records(fresh)[0];
  first.resolve({choice:{model:'gpt-6.1-sol',effort:'high'}});await saving;
  assert.deepEqual(records(fresh),[newer]);await fresh.c.flushChoice();assert.equal(records(fresh).length,0);assert.equal(fresh.c.S.model,'gpt-6-luna');preferencesOnly(old,{allowPrewarm:true});preferencesOnly(fresh,{allowPrewarm:true});
});

test('H5 补交按账号和对话定位，其他账号不发出请求且A记录不改B界面',async()=>{
  const storage=new Map(),old=harness({storage});old.open(A);old.choose('gpt-6-luna');
  const otherAccount=harness({storage,account:'bob'});otherAccount.open(B,'opus','low');await otherAccount.c.restorePendingChoices();assert.equal(otherAccount.calls.length,0);assert.equal(otherAccount.c.S.model,'opus');
  const owner=harness({storage});owner.open(B,'sonnet','low');await owner.c.restorePendingChoices();assert.equal(owner.calls.length,1);assert.equal(owner.calls[0].url,'/api/conversations/'+A);assert.equal(owner.c.S.conv.id,B);assert.equal(owner.c.S.conv.model,'sonnet');assert.equal(owner.c.S.model,'sonnet');assert.equal(owner.c.S.effort,'low');preferencesOnly(owner);noChat(otherAccount);
});

test('H5 缓存启动只恢复选择不发请求，拿到新状态后才补交',async()=>{
  const storage=new Map(),old=harness({storage});old.open();old.choose('gpt-6-luna');
  const fresh=harness({storage});fresh.open();await fresh.c.restorePendingChoices({replay:false});fresh.c.restoreConversationChoice(fresh.c.S.conv);
  assert.equal(fresh.c.S.model,'gpt-6-luna');assert.equal(fresh.calls.length,0);assert.equal(records(fresh).length,1);
  await fresh.c.restorePendingChoices();assert.equal(fresh.calls.length,1);assert.equal(records(fresh).length,0);preferencesOnly(fresh);
});

for(const failure of ['deleted','revoked','unknown'])test('H5 '+failure+'待存选择清理并提示，不自动保存替代型号或无限重放',async()=>{
  const storage=new Map(),old=harness({storage});old.open();old.choose('gpt-6-luna');
  if(failure==='unknown') {const key=old.c.pendingChoiceStorageKey('alice',A),record=JSON.parse(storage.get(key));record.choice.model='unknown-synthetic-model';storage.set(key,JSON.stringify(record));}
  const missing=Object.assign(Error('synthetic conversation deleted'),{status:404}),revoked=Object.assign(Error('synthetic model unavailable'),{status:409,code:'MODEL_UNAVAILABLE',choice:{model:'sonnet',effort:'medium'}});
  const fresh=harness({storage,modelList:failure==='revoked'?models.filter(m=>m.provider!=='openai'):models,request:()=>Promise.reject(failure==='deleted'?missing:revoked)});fresh.open();await fresh.c.restorePendingChoices();
  assert.equal(records(fresh).length,0);assert.ok(fresh.notices.length>0);assert.ok(fresh.c.S.models.some(model=>model.id===fresh.c.S.model));assert.ok(fresh.calls.every(call=>call.body.model===(failure==='unknown'?'unknown-synthetic-model':'gpt-6-luna')),'never silently persist a fallback');
  const count=fresh.calls.length;await fresh.c.restorePendingChoices();assert.equal(fresh.calls.length,count);preferencesOnly(fresh);
});

test('H5 网络失败保留最新记录但同页状态刷新不循环重试，下次页面补交',async()=>{
  const storage=new Map(),old=harness({storage,request:()=>Promise.reject(Error('synthetic offline'))});old.open();old.choose('gpt-6-luna');await old.c.flushChoice();
  assert.equal(records(old).length,1);assert.equal(old.calls.length,1);await old.c.restorePendingChoices();await old.c.restorePendingChoices();assert.equal(old.calls.length,1);
  const fresh=harness({storage});fresh.open();await fresh.c.restorePendingChoices();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0].body.model,'gpt-6-luna');assert.equal(records(fresh).length,0);preferencesOnly(old);preferencesOnly(fresh);
});

test('H5 新对话默认选择刷新后只补PUT偏好，不创建会话或发送聊天',async()=>{
  const storage=new Map(),old=harness({storage});old.choose('gpt-6-luna','low');assert.equal(records(old)[0].convId,null);
  const fresh=harness({storage});await fresh.c.restorePendingChoices();assert.equal(fresh.calls.length,1);assert.equal(fresh.calls[0].url,'/api/prefs');assert.equal(fresh.calls[0].method,'PUT');assert.equal(fresh.calls[0].keepalive,true);assert.equal(fresh.c.S.defaultChoice.model,'gpt-6-luna');assert.equal(fresh.c.S.conv,null);assert.equal(records(fresh).length,0);preferencesOnly(fresh);
});

test('H5 显式退出清理本账号待存记录而不删除另一账号记录',()=>{
  const storage=new Map(),alice=harness({storage});alice.open(A);alice.choose('gpt-6-luna');const bob=harness({storage,account:'bob'});bob.open(B);bob.choose('gpt-6.1-sol');
  storage.set('lastUserId','alice');alice.c.cancelPendingChoices({clearStored:true});assert.equal(records(alice,'alice').length,0);assert.equal(records(alice,'bob').length,1);noChat(alice);noChat(bob);
});

test('H5 返回不同选择不算匹配确认，仍保留待存意图且不再次自动发送',async()=>{
  const storage=new Map(),old=harness({storage});old.open();old.choose('gpt-6-luna','high');const intended=records(old)[0];
  const fresh=harness({storage,request:()=>({choice:{model:'sonnet',effort:'low'}})});fresh.open();await fresh.c.restorePendingChoices();
  assert.deepEqual(records(fresh),[intended]);assert.ok(fresh.notices.length>0);assert.equal(fresh.c.S.model,'gpt-6-luna');await fresh.c.restorePendingChoices();assert.equal(fresh.calls.length,1);preferencesOnly(fresh);
});

test('H5 异步删除响应清理待存记录后，按钮显示与实际发送选择保持一致',async()=>{
  const storage=new Map(),old=harness({storage});old.open();old.choose('gpt-6-luna');
  const gate=deferred(),fresh=harness({storage,request:()=>gate.promise}),displayed=[];fresh.c.updateModelBtn=()=>displayed.push(fresh.c.S.model);fresh.open();
  const saving=fresh.c.restorePendingChoices();fresh.c.updateModelBtn();assert.equal(displayed.at(-1),'gpt-6-luna');await tick();
  gate.reject(Object.assign(Error('synthetic deleted after state rendered'),{status:404}));await saving;
  assert.equal(records(fresh).length,0);assert.equal(displayed.at(-1),fresh.c.S.model);assert.ok(fresh.notices.length>0);preferencesOnly(fresh);
});
