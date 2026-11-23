'use strict';
// H5：执行真实前端函数，DOM、网络、存储和账号均为合成替身，不启动浏览器或模型。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const extract = name => { const match=source.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}', 'm')); assert.ok(match, name); return match[0]; };
function harness() {
  const calls=[], notices=[], storage=new Map([['lastUserId','alice']]), cached=new Map(), timers=new Map(), nodes=new Map();let timer=0, redraws=0;
  const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',textContent:'',innerHTML:'',classList:{add(){},remove(){},toggle(){}},focus(){},querySelector(){return null;},querySelectorAll(){return[];},appendChild(){},contains(){return false;},replaceChildren(){}});return nodes.get(key);};
  const models=[{id:'opus',label:'Opus',provider:'anthropic'}, {id:'sonnet',label:'Sonnet',provider:'anthropic'},
    {id:'gpt-sol',label:'GPT Sol',provider:'openai',efforts:['low','medium','high','max','ultra']}, {id:'gpt-luna',label:'GPT Luna',provider:'openai',efforts:['low','medium','high']}];
  const c={S:{models,model:'opus',effort:'medium',defaultChoice:{model:'gpt-sol',effort:'high'},serverDefaultChoice:{model:'opus',effort:'medium'},choiceExplicitFor:null,choiceWarning:'',
      conv:null,convId:null,convs:[],running:new Set(),nav:1,view:'chat',projectId:null,projects:[],tools:[],tool:null,atts:[],skew:0,draftFor:'n',draftId:null,draftOwnerId:null},
    EFFORTS:[['low','快速'],['medium','标准'],['high','深入'],['xhigh','加强'],['max','极致']],
    authState:{user:'alice',epoch:0},accountCurrent:(epoch,user)=>epoch===c.authState.epoch&&(!user||user===c.authState.user)&&storage.get('lastUserId')===c.authState.user,
    $:node,innerWidth:1200,ls:{get:(k,d)=>storage.get(k)??d,set:(k,v)=>storage.set(k,v),del:k=>storage.delete(k)},
    local:{get:async k=>cached.get(k),put:async(k,v)=>cached.set(k,v)},
    toast:message=>notices.push(message),modelLabel:id=>models.find(m=>m.id===id)?.label||id,
    updateModelBtn(){},menuEl:{redrawModelChoice(){redraws++;}},
    addEventListener(){},document:{hidden:false,addEventListener(){}},window:{},
    setTimeout:(fn,ms)=>{timers.set(++timer,{fn,ms});return timer;},clearTimeout:id=>timers.delete(id),
    post:async(url,body,method)=>{calls.push({url,body:plain(body),method});return url==='/api/chat'?{conversationId:body.conversationId||body.newId,msgIndex:1,startedAt:1,title:'合成'}:{choice:body};},
    api:async url=>url.startsWith('/api/projects/')?{project:{id:url.split('/').at(-1),name:'合成项目'}}:{id:url.split('/').at(-1),messages:[]},
    requestPrewarm(){},setView:v=>{c.S.view=v;},renderThread(){},renderSidebar(){},syncDraft(){},cacheConv(){},cachedConv:async()=>null,convSig:x=>x?.updatedAt,
    refreshConv:fresh=>{c.S.conv=fresh;c.restoreConversationChoice(fresh);},renderProject(){},setTopTitle(){},loadState(){},updateSendBtn(){},updatePerch(){},renderBanner(){},rerenderMsg(){},renderUsage(){},refreshUsage(){},
    PAGE_BUILD:'__PAGE_BUILD__',showUpdatePill(){},lastWarm:{key:'',at:0},renderAtts(){},hop(){},autoGrow(){},draftTimer:0,
    draftLsKey:key=>'draft@alice:'+key,saveDraft(){},newDraftId:()=> 'synthetic-new',setTool:t=>{c.S.tool=t;},checkAccount:epoch=>{if(!c.accountCurrent(epoch))throw Error('stale');},
    UNREACHABLE:new Set(),unreachableError:m=>Error(m),staleAccount:()=>Object.assign(Error('stale'),{staleAccount:true}),showLogin(){},
  };
  vm.createContext(c);
  const effortLine=source.match(/^const effortsFor =.*$/m);assert.ok(effortLine);vm.runInContext(effortLine[0],c);
  const begin=source.indexOf('// H5：账号只保存新对话默认值'),end=source.indexOf('// GPT 的模型名本身就带',begin);assert.ok(begin>=0&&end>begin);
  vm.runInContext(source.slice(begin,end),c);
  vm.runInContext(['showConv','newChat','openConv','openProject','applyState','retry','continueReply','send','requestPrewarm','prewarmRetry'].map(extract).join('\n'),c);
  const conv=(id,model,effort='medium',messages=[])=>({id,title:'合成 '+id,model,effort,messages});
  return {c,calls,notices,storage,cached,timers,node,models,conv,redraws:()=>redraws};
}

test('H5 打开旧 Claude 对话恢复最后一条回答，不沿用账号 GPT 默认且不写 prefs',()=>{
  const h=harness();h.c.S.model='gpt-sol';h.c.showConv({id:'old',messages:[{role:'assistant',model:'opus',effort:'low'}]},true);
  assert.equal(h.c.S.model,'opus');assert.equal(h.c.S.effort,'low');assert.equal(h.c.S.defaultChoice.model,'gpt-sol');assert.equal(h.calls.length,0);
});
test('H5 已存对话选择优先于最后回答，刷新后保持独立档位',async()=>{
  const h=harness();h.c.api=async()=>h.conv('a','gpt-sol','ultra',[{role:'assistant',model:'opus',effort:'low'}]);await h.c.openConv('a',true);
  assert.equal(h.c.S.model,'gpt-sol');assert.equal(h.c.S.effort,'ultra');h.c.S.model='sonnet';await h.c.openConv('a',true,true);
  assert.equal(h.c.S.model,'gpt-sol');assert.equal(h.c.S.defaultChoice.effort,'high');
});
test('H5 新对话和项目新对话使用默认，已有项目对话恢复自己的选择',async()=>{
  const h=harness();h.c.showConv(h.conv('a','opus'),true);h.c.newChat();assert.equal(h.c.S.model,'gpt-sol');assert.equal(h.c.S.convId,null);
  await h.c.openProject('project-one');assert.equal(h.c.S.view,'project');assert.equal(h.c.S.model,'gpt-sol');
  h.c.showConv({...h.conv('project-chat','sonnet','low'),projectId:'project-one'},true);assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.effort,'low');assert.equal(h.calls.filter(x=>x.url!=='/api/prewarm').length,0);
});
test('H5 已有对话选择只 PATCH 原目标，切到 B 后 A 回包不改 B',async()=>{
  const h=harness(),gate=deferred();h.c.post=async(url,body,method)=>{h.calls.push({url,body:plain(body),method});return gate.promise;};
  h.c.showConv(h.conv('a','opus'),true);h.c.S.model='gpt-sol';h.c.S.effort='high';h.c.choiceChanged();const saved=h.c.flushChoice();await tick();
  h.c.showConv(h.conv('b','sonnet','low'),true);gate.resolve({choice:{model:'gpt-sol',effort:'high'}});await saved;
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/conversations/a');assert.equal(h.calls[0].method,'PATCH');
  assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.id,'b');assert.equal(h.c.S.defaultChoice.model,'gpt-sol');
});
test('H5 新页保存 PUT 默认，导航后迟到回复不覆盖当前会话',async()=>{
  const h=harness(),gate=deferred();h.c.post=async(url,body,method)=>{h.calls.push({url,body:plain(body),method});return gate.promise;};
  h.c.S.view='project';h.c.S.projectId='p';h.c.S.model='sonnet';h.c.S.effort='low';h.c.choiceChanged();const saved=h.c.flushChoice();await tick();
  h.c.showConv(h.conv('a','opus','high'),true);gate.resolve({choice:{model:'sonnet',effort:'low'}});await saved;
  assert.equal(h.calls[0].url,'/api/prefs');assert.equal(h.calls[0].method,'PUT');assert.equal(h.c.S.defaultChoice.model,'sonnet');assert.equal(h.c.S.model,'opus');
});
test('H5 连续选择串行保存，早一笔响应不能覆盖后一次明确选择',async()=>{
  const h=harness(),first=deferred();h.c.post=async(url,body,method)=>{h.calls.push({url,body:plain(body),method});return h.calls.length===1?first.promise:{choice:body};};
  h.c.showConv(h.conv('a','opus'),true);h.c.S.model='gpt-sol';h.c.choiceChanged();const one=h.c.flushChoice();await tick();
  h.c.S.model='sonnet';h.c.S.effort='low';h.c.choiceChanged();const two=h.c.flushChoice();await tick();assert.equal(h.calls.length,1);
  first.resolve({choice:{model:'gpt-sol',effort:'medium'}});await one;await two;
  assert.deepEqual(h.calls.filter(x=>x.url==='/api/conversations/a').map(x=>x.body.model),['gpt-sol','sonnet']);assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.choiceExplicitFor,'a');
});
test('H5 已出队的旧账号延时保存不能借用新账号身份',async()=>{
  const h=harness();h.c.showConv(h.conv('a','opus'),true);h.c.S.model='gpt-sol';h.c.choiceChanged();const timer=[...h.timers.values()].at(-1).fn;
  h.c.authState.epoch++;h.c.authState.user='bob';h.storage.set('lastUserId','bob');timer();await tick();assert.equal(h.calls.length,0);
});
test('H5 旧账号在途回包不污染新账号选择',async()=>{
  const h=harness(),gate=deferred();h.c.post=async()=>gate.promise;h.c.showConv(h.conv('a','opus'),true);h.c.S.model='gpt-sol';h.c.choiceChanged();const saved=h.c.flushChoice();await tick();
  h.c.cancelPendingChoices();h.c.authState.epoch++;h.c.authState.user='bob';h.storage.set('lastUserId','bob');h.c.showConv(h.conv('b','sonnet','low'),true);
  gate.resolve({choice:{model:'gpt-sol',effort:'high'}});await saved;assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.id,'b');
});
test('H5 别的设备改变账号默认值不影响当前其他对话，回新页才应用',()=>{
  const h=harness();h.c.showConv(h.conv('a','opus','low'),true);h.c.applyChoice({model:'gpt-sol',effort:'ultra'});
  assert.equal(h.c.S.model,'opus');assert.equal(h.c.S.effort,'low');h.c.newChat();assert.equal(h.c.S.model,'gpt-sol');assert.equal(h.c.S.effort,'ultra');
});
test('H5 对话推送只更新对应会话，当前同一会话同步并刷新打开的菜单',()=>{
  const h=harness();h.c.showConv(h.conv('a','opus'),true);const count=h.redraws();
  h.c.applyConversationChoice('b',{model:'gpt-sol',effort:'high'});assert.equal(h.c.S.model,'opus');
  h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.effort,'low');assert.ok(h.redraws()>count);
});
test('H5 缓存读取逆序返回时旧选择不能盖掉较新的同会话推送',async()=>{
  const h=harness(),a=deferred(),b=deferred();let n=0;h.c.local.get=()=>++n===1?a.promise:b.promise;
  h.c.applyConversationChoice('a',{model:'opus',effort:'low'});h.c.applyConversationChoice('a',{model:'sonnet',effort:'high'});
  b.resolve({conv:h.conv('a','opus')});await tick();a.resolve({conv:h.conv('a','opus')});await tick();assert.equal(h.cached.get('conv/a').conv.model,'sonnet');
});
test('H5 账号权限撤回时明确提示并回可用默认，状态轮询不重复弹提示',()=>{
  const h=harness();h.c.showConv(h.conv('a','gpt-sol','ultra'),true);
  const state={conversations:[],running:[],models:h.models.filter(m=>m.provider!=='openai'),defaultModel:'opus',defaultEffort:'medium',defaultsVersion:2,choice:null};
  h.c.applyState(state,true);assert.equal(h.c.S.model,'opus');assert.equal(h.c.S.effort,'medium');assert.equal(h.notices.length,1);assert.match(h.notices[0],/不可用/);
  h.c.applyState(state,true);assert.equal(h.notices.length,1);assert.equal(h.calls.length,0);
});
test('H5 新对话默认模型权限撤回也给提示',()=>{
  const h=harness();h.c.S.model='gpt-sol';h.c.S.effort='high';
  h.c.applyState({conversations:[],running:[],models:h.models.filter(m=>m.provider!=='openai'),defaultModel:'opus',defaultEffort:'medium',choice:null},true);
  assert.equal(h.c.S.model,'opus');assert.equal(h.notices.length,1);
});
test('H5 重答和继续默认原轮型号及档位，不受当前会话其他轮影响',()=>{
  const h=harness(),sent=[];h.c.send=opts=>sent.push(plain(opts));
  h.c.showConv(h.conv('a','gpt-sol','high',[{role:'user',text:'合成问题'},{role:'assistant',model:'opus',effort:'low',status:'stopped'}]),true);
  h.c.retry(1);h.c.continueReply(1);assert.deepEqual(sent.map(x=>x.replyChoice),[{model:'opus',effort:'low'},{model:'opus',effort:'low'}]);
});
test('H5 明确手动换模型后重答采用新选择，自己的保存推送不会清掉意图',async()=>{
  const h=harness(),sent=[];h.c.send=opts=>sent.push(plain(opts));h.c.showConv(h.conv('a','opus','low',[{role:'user',text:'合成'},{role:'assistant',model:'opus',effort:'low'}]),true);
  h.c.S.model='gpt-sol';h.c.S.effort='high';h.c.choiceChanged();await h.c.flushChoice();h.c.applyConversationChoice('a',{model:'gpt-sol',effort:'high'});h.c.retry(1);
  assert.equal(sent[0].replyChoice.model,'gpt-sol');assert.equal(h.c.S.defaultChoice.effort,'high');
});
test('H5 普通发送带对话选择并把型号档位写入乐观消息',async()=>{
  const h=harness();h.c.showConv(h.conv('a','sonnet','low'),true);h.node('#input').value='合成问题';await h.c.send();
  const body=h.calls.find(x=>x.url==='/api/chat').body;assert.equal(body.model,'sonnet');assert.equal(body.effort,'low');assert.equal(h.c.S.conv.model,'sonnet');assert.equal(h.c.S.conv.messages[1].effort,'low');
});
test('H5 后端 MODEL_UNAVAILABLE 恢复输入并展示回退选择，不自动再发一轮',async()=>{
  const h=harness();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.node('#input').value='请保留这个合成草稿';
  h.c.post=async(url,body)=>{h.calls.push({url,body:plain(body)});throw Object.assign(Error('所选模型已不可用，请确认其他模型后发送'),{code:'MODEL_UNAVAILABLE',choice:{model:'opus',effort:'medium'}});};
  await h.c.send();assert.equal(h.calls.length,1);assert.equal(h.c.S.model,'opus');assert.equal(h.node('#input').value,'请保留这个合成草稿');assert.equal(h.c.S.conv.messages.length,0);assert.match(h.notices[0],/不可用/);
});
test('H5 API 错误保留模型撤回 code 和 choice 供页面处理',async()=>{
  const h=harness();h.c.fetch=async()=>({status:409,ok:false,headers:{get:()=>null},json:async()=>({error:'模型不可用',code:'MODEL_UNAVAILABLE',choice:{model:'opus',effort:'low'}})});
  vm.runInContext(extract('api'),h.c);await assert.rejects(h.c.api('/api/chat'),error=>error.code==='MODEL_UNAVAILABLE'&&error.choice.model==='opus'&&error.status===409);
});
test('H5 原轮已无权限时不在重答里默默改成其他提供方',()=>{
  const h=harness();h.c.showConv(h.conv('a','opus','medium',[{role:'assistant',model:'removed-gpt',effort:'high'}]),true);
  assert.equal(h.c.replyChoiceFor(0).model,'removed-gpt');
});
test('H5 重答和继续的预热与原轮模型一致',()=>{
  const h=harness();h.c.showConv(h.conv('a','gpt-sol','high',[{role:'user',text:'合成'},{role:'assistant',model:'opus',effort:'low',status:'stopped'}]),true);
  h.c.prewarmRetry(1);assert.equal(h.calls[0].url,'/api/prewarm');assert.equal(h.calls[0].body.model,'opus');assert.equal(h.calls[0].body.effort,'low');
  h.c.requestPrewarm(undefined,true);assert.equal(h.calls[1].body.model,'opus');
});
test('H5 GPT 可用档位按服务列表恢复，不把不支持的 ultra 留在菜单',()=>{
  const h=harness();const value=h.c.normalizedChoice({model:'gpt-luna',effort:'ultra'});assert.equal(value.model,'gpt-luna');assert.equal(value.effort,'high');
  h.c.selectedChoice(value);assert.equal(h.c.S.effort,'high');
});
test('H5 推送分发保留账号事件校验并分别处理两种选择事件',()=>{
  const events=extract('connectEvents');assert.ok(events.indexOf('if (!accountCurrent(epoch)) return;')<events.indexOf("ev.type === 'conversation-choice'"));
  assert.match(events,/ev\.type === 'conversation-choice'.*applyConversationChoice\(ev\.convId, ev\.choice\)/);assert.match(events,/ev\.type === 'choice'.*applyChoice\(ev\.choice\)/);
});

for (const revoked of [false, true]) test('H5 迟到的' + (revoked ? '权限拒绝' : '网络失败') + '不能覆盖同会话更新的手动选择', async () => {
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.node('#input').value='合成待发送问题';
  h.c.post=async()=>gate.promise;const sending=h.c.send();
  h.c.S.model='sonnet';h.c.S.effort='low';h.c.choiceChanged();
  const error=Object.assign(Error('合成失败'),revoked?{code:'MODEL_UNAVAILABLE',choice:{model:'opus',effort:'medium'}}:{});
  gate.reject(error);await sending;
  assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.model,'sonnet');assert.equal(h.c.S.conv.effort,'low');assert.equal(h.node('#input').value,'合成待发送问题');
});


test('H5 远端较新选择已到达时旧 GET 不能把同版本对话换回 GPT',async()=>{
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.api=()=>gate.promise;
  const opening=h.c.openConv('a',true,true);h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});
  gate.resolve(h.conv('a','gpt-sol','high'));await opening;assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.effort,'low');assert.equal(h.c.S.conv.model,'sonnet');assert.equal(h.notices.length,0);
});
test('H5 旧 GET 仍可刷新消息，但 refreshConv 不能覆盖期间的新选择',async()=>{
  const h=harness(),gate=deferred();Object.assign(h.c,{stickBottom:false,scrollBottom(){},renderMsg:()=>({classList:{add(){}}})});vm.runInContext(extract('refreshConv'),h.c);
  h.c.showConv({...h.conv('a','gpt-sol','high',[{role:'assistant',model:'gpt-sol',events:[]}]),updatedAt:1},true);h.c.api=()=>gate.promise;
  const opening=h.c.openConv('a',true,true);h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});
  gate.resolve({...h.conv('a','gpt-sol','high',[{role:'assistant',model:'gpt-sol',events:[{k:'text',text:'new answer'}]}]),updatedAt:2});await opening;
  assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.model,'sonnet');assert.equal(h.c.S.conv.messages[0].events[0].text,'new answer');assert.equal(h.notices.length,0);
});
test('H5 本地 PATCH 已完成且待保存队列清空后旧 GET 仍不覆盖手动选择',async()=>{
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.api=()=>gate.promise;const opening=h.c.openConv('a',true,true);
  h.c.S.model='sonnet';h.c.S.effort='low';h.c.choiceChanged();await h.c.flushChoice();
  gate.resolve(h.conv('a','gpt-sol','high'));await opening;assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.model,'sonnet');assert.equal(h.c.S.choiceExplicitFor,'a');
});
test('H5 尚未保存的手动选择同样优先于已在途的 GET',async()=>{
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.api=()=>gate.promise;const opening=h.c.openConv('a',true,true);
  h.c.S.model='sonnet';h.c.S.effort='low';h.c.choiceChanged();gate.resolve(h.conv('a','gpt-sol','high'));await opening;assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.effort,'low');
});
test('H5 切换对话时缓存读取迟到也不能覆盖期间收到的选择推送',async()=>{
  const h=harness(),cache=deferred(),get=deferred();h.c.showConv(h.conv('a','opus'),true);h.c.cachedConv=()=>cache.promise;h.c.api=()=>get.promise;
  const opening=h.c.openConv('b',true);h.c.applyConversationChoice('b',{model:'sonnet',effort:'low'});cache.resolve(h.conv('b','gpt-sol','high'));await tick();
  assert.equal(h.c.S.conv.id,'b');assert.equal(h.c.S.model,'sonnet');get.resolve(h.conv('b','sonnet','low'));await opening;assert.equal(h.c.S.model,'sonnet');
});
test('H5 启动的合并状态请求返回旧对话时保留期间同步的新选择',async()=>{
  const h=harness(),gate=deferred();vm.runInContext(extract('loadState'),h.c);h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.api=()=>gate.promise;
  const reading=h.c.loadState('a');h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});
  gate.resolve({userId:'alice',conversation:h.conv('a','gpt-sol','high'),conversations:[],running:[],models:h.models,defaultModel:'opus',defaultEffort:'medium',choice:{model:'opus',effort:'medium'}});
  const result=await reading;assert.equal(result.conversation.model,'sonnet');assert.equal(result.conversation.effort,'low');assert.equal(h.c.S.model,'sonnet');
});
test('H5 推送之后才开始的新 GET 仍可接受服务器的更新选择，不被旧映射锁死',async()=>{
  const h=harness();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});h.c.api=async()=>h.conv('a','opus','high');
  await h.c.openConv('a',true,true);assert.equal(h.c.S.model,'opus');assert.equal(h.c.S.effort,'high');
});
test('H5 别的对话的新选择不阻止当前目标 GET 正常恢复',async()=>{
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.api=()=>gate.promise;const opening=h.c.openConv('a',true,true);
  h.c.applyConversationChoice('b',{model:'sonnet',effort:'low'});gate.resolve(h.conv('a','opus','high'));await opening;assert.equal(h.c.S.model,'opus');
});
test('H5 缓存等待期间账号变化时不以新账号继续请求旧对话',async()=>{
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','opus'),true);h.c.cachedConv=()=>gate.promise;let calls=0;h.c.api=async()=>{calls++;return h.conv('old-target','gpt-sol');};
  const opening=h.c.openConv('old-target',true);h.c.cancelPendingChoices();h.c.authState.epoch++;h.c.authState.user='bob';h.storage.set('lastUserId','bob');h.c.showConv(h.conv('new-account-chat','sonnet'),true);
  gate.resolve(h.conv('old-target','gpt-sol'));await opening;assert.equal(calls,0);assert.equal(h.c.S.conv.id,'new-account-chat');assert.equal(h.c.S.model,'sonnet');
});
test('H5 GET 等待期间账号变化时旧会话与选择都不能落入新账号',async()=>{
  const h=harness(),gate=deferred();h.c.showConv(h.conv('a','gpt-sol'),true);h.c.api=()=>gate.promise;const opening=h.c.openConv('a',true,true);
  h.c.cancelPendingChoices();h.c.authState.epoch++;h.c.authState.user='bob';h.storage.set('lastUserId','bob');h.c.showConv(h.conv('a','sonnet','low'),true);
  gate.resolve(h.conv('a','gpt-sol','high'));await opening;assert.equal(h.c.S.model,'sonnet');assert.equal(h.c.S.conv.effort,'low');
});

test('H5 接受后续新 GET 后再次打开缓存不恢复旧推送型号',async()=>{
  const h=harness();h.c.showConv(h.conv('a','gpt-sol','high'),true);h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});await tick();
  h.c.api=async()=>h.conv('a','opus','high');await h.c.openConv('a',true,true);
  h.c.CONV_CACHE_DAYS=6;h.c.local.get=async()=>({at:Date.now(),conv:h.conv('a','opus','high')});vm.runInContext(extract('cachedConv'),h.c);
  const cached=await h.c.cachedConv('a');assert.equal(cached.model,'opus');assert.equal(cached.effort,'high');
});
test('H5 实际缓存读取保持已知最新选择且在账号变化后失效',async()=>{
  const h=harness(),gate=deferred();h.c.CONV_CACHE_DAYS=6;vm.runInContext(extract('cachedConv'),h.c);h.c.local.get=()=>gate.promise;
  const reading=h.c.cachedConv('a');h.c.applyConversationChoice('a',{model:'sonnet',effort:'low'});gate.resolve({at:Date.now(),conv:h.conv('a','gpt-sol','high')});
  const cached=await reading;assert.equal(cached.model,'sonnet');
  const other=deferred();h.c.local.get=()=>other.promise;const old=h.c.cachedConv('a');h.c.authState.epoch++;h.c.authState.user='bob';h.storage.set('lastUserId','bob');other.resolve({at:Date.now(),conv:h.conv('a','gpt-sol','high')});assert.equal(await old,null);
});
