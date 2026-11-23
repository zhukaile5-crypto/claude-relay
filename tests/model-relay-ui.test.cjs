'use strict';
// H7：使用真实页面函数及合成 DOM/账号/网络，不启动真实服务或模型。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.RELAY_TEST_ROOT||path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const extract=name=>{const m=source.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}','m'));assert.ok(m,name);return m[0];};
const plain=x=>JSON.parse(JSON.stringify(x));
function harness(provider='anthropic',status='error') {
  const sent=[],calls=[],notices=[],warm=[],nodes=new Map(),storage=new Map([['lastUserId','alice']]);let usageReads=0;
  const models=[{id:'opus',provider:'anthropic',label:'Opus'},{id:'sonnet',provider:'anthropic',label:'Sonnet'}, {id:'gpt-6.1-terra',provider:'openai',label:'GPT Terra'}, {id:'gpt-6.1-sol',provider:'openai',label:'GPT Sol'}];
  const msg={role:'assistant',model:provider==='openai'?'gpt-6.1-sol':'opus',provider,effort:'high',turnId:'turn-one',status,events:[],errorText:'network disconnected'};
  const node=key=>{if(!nodes.has(key))nodes.set(key,{textContent:'',value:'保留中的合成草稿',innerHTML:'',classList:{toggle(){},add(){},remove(){}}});return nodes.get(key);};
  const htmlNode=html=>{const buttons=new Map();for(const m of html.matchAll(/data-a="([^"]+)"/g))buttons.set(m[1],{});return{html,querySelector:q=>buttons.get(q.match(/data-a=['"]?([^\]'" ]+)/)?.[1])||null};};
  const c={S:{models,convId:'a',conv:{id:'a',model:msg.model,effort:'high',messages:[{role:'user',text:'已完成一些步骤'},msg]},convs:[],model:msg.model,effort:'high',defaultChoice:{model:'opus',effort:'medium'},serverDefaultChoice:{model:'opus',effort:'medium'},running:new Set(),pendingSends:new Set(),atts:[{path:'synthetic/draft.txt'}],tool:'word',choiceExplicitFor:null,fallbackModels:{anthropic:'sonnet',openai:'gpt-6.1-terra'}},
    authState:{epoch:0,user:'alice'},accountCurrent:(epoch,user)=>epoch===c.authState.epoch&&user===c.authState.user,
    $:node,modelLabel:id=>models.find(m=>m.id===id)?.label||id,effortsFor:()=>[['low','快速'],['medium','标准'],['high','深入']],
    usageWindows:()=>{usageReads++;return[['session',{pct:100,resetsAt:123}]];},fmtReset:()=> '稍后',
    esc:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),htmlNode,
    appendCollaborationActions(){}, icon:()=>'',spark:()=>'',splitFiles:()=>({inline:[],cards:[]}),handoffNote:()=>null,renderPlan:()=>({}),renderMd:()=>({}),renderProc:()=>({}),cachedPart:(_m,_k,_s,fn)=>fn(),
    document:{hidden:false,addEventListener(){},createElement:()=>({querySelector:()=>({}),appendChild(){}})},
    addEventListener(){},setTimeout:()=>1,clearTimeout(){},menuEl:null,updateModelBtn(){},ls:{get:(k,d)=>storage.get(k)??d,set:(k,v)=>storage.set(k,v),del:k=>storage.delete(k)},
    local:{get:async()=>null,put:async()=>{}},post:async(url,body,method)=>{calls.push({url,body:plain(body),method});return{choice:body};},
    toast:t=>notices.push(t),send:opts=>sent.push(plain(opts)),requestPrewarm:(...args)=>warm.push(args),retry:idx=>sent.push({retry:idx}),
  };
  vm.createContext(c);const begin=source.indexOf('// H5：账号只保存新对话默认值'),end=source.indexOf('// GPT 的模型名本身就带',begin);vm.runInContext(source.slice(begin,end),c);
  vm.runInContext(['handoffModel','friendlyError','relayChoiceFor','relayReply','renderRelayActions','continueReply','assistantParts'].map(extract).join('\n'),c);
  return{c,msg,models,sent,calls,notices,warm,node,usageReads:()=>usageReads};
}

test('H7 Claude 额度用完用 Claude 文案与订阅恢复时间',()=>{
  const h=harness();h.msg.errorText='usage limit reached';const f=h.c.friendlyError(h.msg.errorText,h.msg);assert.match(f.title,/Claude.*额度.*稍后/);assert.equal(f.resumable,false);assert.equal(f.relayPrimary,true);assert.equal(h.usageReads(),1);
});
test('H7 GPT 余额和预算故障要求联系机主，不套用 Claude 的额度窗口',()=>{
  for(const error of ['insufficient_quota','billing_hard_limit_reached','monthly budget exceeded','余额不足']){const h=harness('openai');const f=h.c.friendlyError(error,h.msg);assert.match(f.title,/GPT.*余额或预算/);assert.match(f.hint,/联系机主/);assert.equal(f.resumable,false);assert.equal(h.usageReads(),0);}
});
test('H7 GPT 密钥错误显示联系机主而非 Claude 登录过期',()=>{
  for(const error of ['401 authentication failed','invalid_api_key sk-SYNTHETIC','Incorrect API key provided','Missing API key','No API key provided','OPENAI_API_KEY not configured']){const h=harness('openai');const f=h.c.friendlyError(error,h.msg);assert.match(f.title,/GPT.*机主/);assert.match(f.hint,/联系机主/);assert.doesNotMatch(f.title,/Claude/);assert.doesNotMatch(f.title+f.hint,/sk-SYNTHETIC|401|invalid|密钥/);}
});
test('H7 Claude 登录错误仍提示本机重新登录，未改变订阅方式',()=>{
  const h=harness();const f=h.c.friendlyError('401 not logged in',h.msg);assert.match(f.title,/Claude 登录过期/);assert.match(f.hint,/机主.*电脑上重新登录/);assert.equal(f.resumable,false);
});
test('H7 网络和繁忙错误跟随出错那轮，而不是当前选择框',()=>{
  const h=harness('openai');h.c.S.model='opus';assert.match(h.c.friendlyError('ECONNRESET',h.msg).title,/连 GPT 的网络/);assert.match(h.c.friendlyError('503 overloaded',h.msg).title,/GPT.*太忙/);
  h.msg.provider='anthropic';assert.match(h.c.friendlyError('network disconnected',h.msg).title,/连 Claude 的网络/);
});
test('H7 GPT 限速与余额故障分开，保留原模型稍后继续',()=>{
  const h=harness('openai');const f=h.c.friendlyError('429 rate_limit_exceeded',h.msg);assert.match(f.title,/GPT.*使用限制/);assert.notEqual(f.resumable,false);assert.equal(h.usageReads(),0);
});
test('H7 错误正文仅渲染友好文案，不暴露原始密钥、路径或技术详情',()=>{
  const h=harness('openai');h.msg.errorText='invalid_api_key sk-SYNTHETIC C:\\private\\secret.txt <script>synthetic</script>';
  const parts=h.c.assistantParts(h.msg,1),html=parts.kids.map(n=>n.html||'').join('');assert.match(html,/联系机主/);assert.doesNotMatch(html,/sk-SYNTHETIC|private|secret|script|invalid_api_key|详细信息/);
  h.msg.errorText='unknown internal error C:\\private\\secret.txt';const generic=h.c.assistantParts(h.msg,1).kids.map(n=>n.html||'').join('');assert.doesNotMatch(generic,/private|secret|unknown internal/);
});
test('H7 Claude 额度错误把 GPT 接力作为主操作并标明 API 计费',()=>{
  const h=harness();h.msg.errorText='usage limit reached';const row=h.c.renderRelayActions(h.msg,1);assert.match(row.html,/class="btn dark" data-a="relay"/);assert.match(row.html,/改用 GPT 继续/);assert.match(row.html,/按 API 计费/);assert.equal(row.querySelector('[data-a=continue]'),null);
});
test('H7 GPT 预算错误给 Claude 接力，不把 Claude 标成 API 计费',()=>{
  const h=harness('openai');h.msg.errorText='budget exceeded';const row=h.c.renderRelayActions(h.msg,1);assert.match(row.html,/改用 Claude 继续/);assert.match(row.html,/btn dark/);assert.doesNotMatch(row.html,/按 API 计费/);
});
test('H7 停止也可接力，仅最后一轮显示且不会自动发送',()=>{
  const h=harness('anthropic','stopped');assert.ok(h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]'));assert.equal(h.sent.length,0);
  assert.equal(h.c.renderRelayActions({...h.msg,status:'done'},1),null);h.c.S.conv.messages.push({role:'user',text:'later'});assert.equal(h.c.renderRelayActions(h.msg,1),null);
});
test('H7 另一方没有权限或配置为 null 时不显示入口',()=>{
  const h=harness();h.c.S.fallbackModels.openai=null;assert.equal(h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]'),null);
  h.c.S.fallbackModels.openai='gpt-6.1-terra';h.c.S.models=h.models.filter(m=>m.provider!=='openai');assert.equal(h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]'),null);
});
test('H7 使用过滤后的配置型号，拒绝指向同一方或未知型号的配置',()=>{
  const h=harness();h.c.S.fallbackModels.openai='gpt-6.1-sol';assert.equal(h.c.relayChoiceFor(h.msg).model,'gpt-6.1-sol');h.c.S.fallbackModels.openai='sonnet';assert.equal(h.c.relayChoiceFor(h.msg),null);h.c.S.fallbackModels.openai='unknown';assert.equal(h.c.relayChoiceFor(h.msg),null);
});
test('H7 接力使用原 continue 流程，更新当前对话选择但保留账号默认和草稿',async()=>{
  const h=harness('anthropic','stopped'),before={text:h.node('#input').value,atts:plain(h.c.S.atts),tool:h.c.S.tool};
  h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]').onclick();assert.equal(h.sent.length,1);assert.equal(h.sent[0].continue,true);assert.equal(h.sent[0].replyChoice.model,'gpt-6.1-terra');assert.deepEqual(h.sent[0].attachments,[]);assert.equal(h.sent[0].fromIndex,undefined);
  assert.equal(h.c.S.conv.model,'gpt-6.1-terra');assert.equal(h.c.S.defaultChoice.model,'opus');assert.equal(h.node('#input').value,before.text);assert.deepEqual(plain(h.c.S.atts),before.atts);assert.equal(h.c.S.tool,before.tool);
  await h.c.flushChoice();assert.deepEqual(h.calls.map(x=>[x.url,x.method]),[['/api/conversations/a','PATCH']]);assert.equal(h.calls[0].body.model,'gpt-6.1-terra');
});
test('H7 GPT 接力到 Claude 使用配置的 Sonnet',()=>{
  const h=harness('openai','stopped');h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]').onclick();assert.equal(h.sent[0].replyChoice.model,'sonnet');assert.equal(h.c.S.conv.model,'sonnet');
});
test('H7 已打开按钮在权限撤回或接力配置变化后不会改用任意备用型号发送',()=>{
  const h=harness(),button=h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]');h.c.S.fallbackModels.openai='gpt-6.1-sol';button.onclick();assert.equal(h.sent.length,0);assert.match(h.notices[0],/可用模型已经变化/);
  h.c.S.models=h.models.filter(m=>m.provider!=='openai');button.onclick();assert.equal(h.sent.length,0);
});
test('H7 旧按钮在账号、对话或同索引轮次改变后不能发起任务',()=>{
  for(const change of [h=>{h.c.authState.epoch++;h.c.authState.user='bob';},h=>{h.c.S.conv={id:'b',messages:[{},h.msg]};h.c.S.convId='b';},h=>{h.c.S.conv.messages[1]={...h.msg,turnId:'new-turn'};}]){
    const h=harness(),button=h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]');change(h);button.onclick();assert.equal(h.sent.length,0);assert.equal(h.calls.length,0);
  }
});
test('H7 任务运行中或发送确认未返回时点击接力不会创建重叠任务',()=>{
  const h=harness(),button=h.c.renderRelayActions(h.msg,1).querySelector('[data-a=relay]');h.c.S.running.add('a');button.onclick();assert.equal(h.sent.length,0);h.c.S.running.clear();h.c.S.pendingSends.add('a');button.onclick();assert.equal(h.sent.length,0);
});
test('H7 原继续按钮的预热和发送仍用原轮型号与档位',()=>{
  const h=harness('openai');h.c.S.model='opus';const button=h.c.renderRelayActions(h.msg,1).querySelector('[data-a=continue]');button.onpointerenter();assert.equal(h.warm[0][2].model,'gpt-6.1-sol');button.onclick();assert.equal(h.sent[0].replyChoice.model,'gpt-6.1-sol');assert.equal(h.sent[0].replyChoice.effort,'high');
});
test('H7 账号状态提供接力配置，撤权时重画最后错误入口且重置清空配置',()=>{
  const state=extract('applyState'),reset=extract('resetAccount');assert.match(state,/S\.fallbackModels = s\.fallbackModels/);assert.match(state,/rerenderMsg\(lastReply\)/);assert.match(reset,/fallbackModels: \{ anthropic: null, openai: null \}/);
  assert.match(source,/\.resume-row[^}]*flex-wrap: wrap/);assert.doesNotMatch(extract('relayReply'),/retryWithModel|action:.*review|\b(?:confirm|alert|prompt)\(/);
});

test('H7 兼容真实服务目录中省略 provider 的 Claude 型号',()=>{
  const h=harness('openai','stopped');for(const model of h.models)if(model.provider==='anthropic')delete model.provider;
  const row=h.c.renderRelayActions(h.msg,1);assert.match(row.html,/改用 Claude 继续/);row.querySelector('[data-a=relay]').onclick();assert.equal(h.sent[0].replyChoice.model,'sonnet');assert.equal(h.c.S.conv.model,'sonnet');
});
test('H7 Claude 报错里的 capacity/exhausted 不当成额度用完；Gemini 的同类报错算使用限制',()=>{
  for(const error of ['server at capacity, please retry','connection pool exhausted']){const h=harness();const f=h.c.friendlyError(error,h.msg);assert.doesNotMatch(f.title,/额度/);assert.notEqual(f.resumable,false);}
  const g=harness();g.msg.provider='google';g.msg.model='gemini-4-neon';const f=g.c.friendlyError('RESOURCE_EXHAUSTED: model capacity',g.msg);assert.match(f.title,/Gemini.*使用限制/);
});
test('接手人选：Claude 出问题先交给 Gemini 其次 GPT，Gemini 出问题先交给 Claude；两个按钮都在', () => {
  const h = harness(); h.c.S.models = [...h.models, { id: 'gemini-4-neon', provider: 'google', label: 'Gemini Neon' }];
  // 旧服务器的名单里没有 Gemini 这一项：用模型列表里第一个 Gemini 型号
  assert.equal(h.c.relayChoiceFor(h.msg).model, 'gemini-4-neon');
  assert.deepEqual(plain(h.c.relayChoiceFor(h.msg, true)).map(c => c.model), ['gemini-4-neon', 'gpt-6.1-terra']);
  // 名单里写明没有 Gemini：不擅自补一个
  h.c.S.fallbackModels.google = null; assert.equal(h.c.relayChoiceFor(h.msg).model, 'gpt-6.1-terra');
  h.c.S.fallbackModels.google = 'gemini-4-neon';
  const row = h.c.renderRelayActions(h.msg, 1);
  assert.ok(row.querySelector('[data-a=relay]')); assert.ok(row.querySelector('[data-a=relay2]'));
  assert.match(row.html, /改用 Gemini 继续[^]*改用 GPT 继续[^]*按 API 计费/);
  const gemini = { ...h.msg, model: 'gemini-4-neon', provider: 'google' };
  assert.deepEqual(plain(h.c.relayChoiceFor(gemini, true)).map(c => c.model), ['sonnet', 'gpt-6.1-terra']);
  const gpt = { ...h.msg, model: 'gpt-6.1-sol', provider: 'openai' };
  assert.deepEqual(plain(h.c.relayChoiceFor(gpt, true)).map(c => c.model), ['sonnet', 'gemini-4-neon']);
  assert.deepEqual(plain(h.c.relayChoiceFor({ model: 'unknown-model' }, true)), []);
});
