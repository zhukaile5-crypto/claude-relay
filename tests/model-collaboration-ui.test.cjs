'use strict';
// H9：真实页面函数 + 合成 DOM/网络/账号；不调用真实模型。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.RELAY_TEST_ROOT||path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const {REVIEW_PROMPT}=require(path.join(root,'tools/model-collaboration.cjs'));
const extract=name=>{const m=source.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}','m'));assert.ok(m,name);return m[0];};
const plain=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function harness() {
  const nodes=new Map(),created=[],calls=[],notices=[],copied=[],edited=[],storage=new Map([['lastUserId','alice']]);
  function element(tag='div') { const node={tag,children:[],dataset:{},style:{},value:'保留中的草稿',textContent:'',className:'',classList:{add(){},remove(){},toggle(){}},focus(){},appendChild(n){this.children.push(n);n.parentNode=this;return n;},append(...items){items.forEach(n=>this.appendChild(n));},remove(){this.removed=true;},querySelector(q){const name=q.match(/data-a=['"]?([^\]'" ]+)/)?.[1];if(name)return this.buttons.get(name)||null;return null;},insertAdjacentHTML(_where,html){this.html+=html;},getBoundingClientRect:()=>({left:10,top:300,bottom:330})};
    Object.defineProperty(node,'innerHTML',{get(){return this.html||'';},set(v){this.html=v;this.children=[];this.buttons=new Map([...v.matchAll(/data-a="([^"]+)"/g)].map(m=>[m[1],{}]));}});node.innerHTML='';created.push(node);return node; }
  const $=key=>{if(!nodes.has(key))nodes.set(key,element());return nodes.get(key);};
  const models=[{id:'opus',label:'Opus'},{id:'sonnet',label:'Sonnet'},{id:'gpt-6.1-terra',label:'GPT Terra',provider:'openai'},{id:'gpt-6.1-sol',label:'GPT Sol',provider:'openai'}];
  const msg={role:'assistant',model:'opus',provider:'anthropic',effort:'high',turnId:'turn-one',status:'done',events:[{k:'text',text:'original answer'}]};
  const c={S:{models,convId:'a',conv:{id:'a',model:'sonnet',effort:'low',messages:[{role:'user',text:'original question',attachments:[{path:'synthetic/original.txt',name:'original.txt'}],tool:'word'},msg]},convs:[],model:'sonnet',effort:'low',defaultChoice:{model:'opus',effort:'medium'},serverDefaultChoice:{model:'opus',effort:'medium'},choiceExplicitFor:'a',running:new Set(),pendingSends:new Set(),atts:[{path:'synthetic/draft.txt',name:'draft.txt'}],tool:'research',draftFor:'c:a',view:'chat',skew:0,nav:1,tools:[],fallbackModels:{anthropic:'sonnet',openai:'gpt-6.1-terra'}},
    authState:{epoch:0,user:'alice'},accountCurrent:(epoch,user)=>epoch===c.authState.epoch&&user===c.authState.user,
    $,document:{hidden:false,addEventListener(){},createElement:element,querySelectorAll:selector=>created.filter(n=>!n.removed&&n.className==='collab-btn')},
    modelLabel:id=>{const m=models.find(m=>m.id===id);return m?(m.provider==='openai'?m.label:'Claude '+m.label):id;},effortsFor:()=>[['low','快速'],['medium','标准'],['high','深入']],
    esc:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
    innerHeight:800,innerWidth:1200,icon:()=>'',isImg:()=>false,extOf:p=>p.split('.').at(-1),typeLabel:()=>'',copyText:text=>copied.push(text),startEdit:(_el,m)=>edited.push(m.text),
    addEventListener(){},setTimeout:()=>1,clearTimeout(){},menuEl:null,placeMenu:(_anchor,menu)=>{c.menuEl=menu;},closeMenu:()=>{c.menuEl=null;},
    renderThread(){},renderAtts(){},renderSidebar(){},updateModelBtn(){},updateSendBtn(){},updatePerch(){},hop(){},autoGrow(){},setTopTitle(){},rerenderMsg(){},loadState(){},openConv:async()=>{},requestPrewarm(){},
    draftTimer:0,draftLsKey:key=>key,setTool:t=>{c.S.tool=t;},setView:v=>{c.S.view=v;},ls:{get:(k,d)=>storage.get(k)??d,set:(k,v)=>storage.set(k,v),del:k=>storage.delete(k)},
    local:{get:async()=>null,put:async()=>{}},toast:t=>notices.push(t),saveDraft(){},
    post:async(url,body,method)=>{calls.push({url,body:plain(body),method});return url==='/api/chat'?{conversationId:'a',msgIndex:c.S.conv.messages.length-1,startedAt:321,turnId:'new-turn'}:{choice:body};},
  };
  vm.createContext(c);const begin=source.indexOf('// H5：账号只保存新对话默认值'),end=source.indexOf('// GPT 的模型名本身就带',begin);vm.runInContext(source.slice(begin,end),c);
  vm.runInContext(source.match(/^const REVIEW_PROMPT =.*$/m)[0],c);
  vm.runInContext(['handoffModel','relayChoiceFor','collaborationModels','messageActionSignature','captureMessageAction','retryWithModel','reviewReply','retryModelMenu','appendCollaborationActions','updateCollaborationButtons','send','renderUser'].map(extract).join('\n'),c);
  const context=()=>c.captureMessageAction(c.S.conv.messages[1],1),before=()=>({model:c.S.model,effort:c.S.effort,convModel:c.S.conv.model,convEffort:c.S.conv.effort,explicit:c.S.choiceExplicitFor,defaults:plain(c.S.defaultChoice),text:$('#input').value,atts:plain(c.S.atts),tool:c.S.tool});
  return{c,msg,models,calls,notices,copied,edited,$,element,created,context,before};
}

test('H9 重答菜单仅列另一家授权型号，选择型号后需页面内确认才发送',async()=>{
  const h=harness(),anchor=h.element('button');h.c.retryModelMenu(anchor,h.context());const menu=h.c.menuEl;assert.equal(menu.children.length,2);assert.match(menu.innerHTML,/替换这条回答及后面的对话/);assert.ok(menu.children.every(b=>b.textContent.includes('GPT')&&b.textContent.includes('按 API 计费')));
  menu.children[1].onclick();assert.equal(h.calls.length,0);assert.match(menu.innerHTML,/旧回答及后面的对话将被替换/);assert.match(menu.innerHTML,/型号和档位保持不变/);assert.match(menu.innerHTML,/按 API 计费/);await menu.children[0].onclick();assert.equal(h.calls.filter(x=>x.url==='/api/chat').length,1);
});
test('H9 单轮重答带原轮身份与截断位置，但不修改对话选择、默认值和草稿',async()=>{
  const h=harness(),before=h.before();await h.c.retryWithModel(h.context(),'gpt-6.1-sol');const body=h.calls.find(x=>x.url==='/api/chat').body;
  assert.equal(body.retryWithModel,true);assert.equal(body.retryTurnId,'turn-one');assert.equal(body.fromIndex,0);assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.effort,'high');assert.equal(body.message,'original question');assert.equal(body.tool,'word');assert.equal(body.attachments[0].path,'synthetic/original.txt');
  assert.deepEqual(h.before(),before);assert.equal(h.c.S.conv.messages.length,2);assert.equal(h.c.S.conv.messages[1].model,'gpt-6.1-sol');assert.equal(h.calls.some(x=>x.method==='PATCH'||x.method==='PUT'),false);
});
test('H9 较早轮重答沿既有截断路径替换该轮及后续',async()=>{
  const h=harness();h.c.S.conv.messages.push({role:'user',text:'later'},{role:'assistant',model:'sonnet',turnId:'later-turn',status:'done',events:[]});
  await h.c.retryWithModel(h.context(),'gpt-6.1-terra');assert.equal(h.c.S.conv.messages.length,2);assert.equal(h.c.S.conv.messages[0].text,'original question');assert.equal(h.calls[0].body.fromIndex,0);
});
test('H9 复核为普通新轮，固定请求由服务端同一文本生成，包含原轮身份',async()=>{
  const h=harness(),before=h.before();assert.equal(vm.runInContext('REVIEW_PROMPT',h.c),REVIEW_PROMPT);await h.c.reviewReply(h.context(),'gpt-6.1-terra');const body=h.calls.find(x=>x.url==='/api/chat').body;
  assert.equal(body.action,'review');assert.equal(body.reviewIndex,1);assert.equal(body.reviewTurnId,'turn-one');assert.equal(body.message,REVIEW_PROMPT);assert.equal(body.model,'gpt-6.1-terra');assert.deepEqual(body.attachments,[]);assert.equal(body.tool,undefined);assert.equal(body.fromIndex,undefined);assert.equal(body.continue,undefined);assert.equal(body.retryWithModel,undefined);
  assert.equal(h.c.S.conv.messages.length,4);assert.equal(h.c.S.conv.messages[2].action,'review');assert.equal(h.c.S.conv.messages[2].model,'gpt-6.1-terra');assert.deepEqual(h.before(),before);
});
test('H9 复核消息平时仅显示标签，仍可编辑复制原固定请求',()=>{
  const h=harness(),msg={role:'user',action:'review',model:'gpt-6.1-terra',text:REVIEW_PROMPT,attachments:[]};const row=h.c.renderUser(msg,2);
  assert.equal(row.children[0].className,'review-tag');assert.equal(row.children[0].textContent,'请 GPT 看看');assert.ok(!row.children.some(n=>n.className==='ububble'));assert.match(row.children[0].title,/会请求.*不修改/);assert.doesNotMatch(row.children[0].title,/保证|禁止|无法修改/);
  const acts=row.children.at(-1);acts.querySelector('[data-a=copy]').onclick({currentTarget:{}});acts.querySelector('[data-a=edit]').onclick();assert.deepEqual(h.copied,[REVIEW_PROMPT]);assert.deepEqual(h.edited,[REVIEW_PROMPT]);
});
test('H9 复核入口仅在最后已结束回答，按钮明确 GPT API 计费',()=>{
  const h=harness(),acts=h.element();h.c.appendCollaborationActions(acts,h.msg,1);assert.equal(acts.children.length,3);assert.match(acts.children[1].innerHTML,/请 GPT 看看.*按 API 计费/);assert.match(acts.children[1].title,/会请求模型默认不修改文件/);
  h.c.S.conv.messages.push({role:'user',text:'later'});const earlier=h.element();h.c.appendCollaborationActions(earlier,h.msg,1);assert.equal(earlier.children.length,1);
});
test('H9 没有另一家权限不显示入口，真实 Claude 缺省目录可复核回 Claude',()=>{
  const h=harness();h.c.S.models=h.models.filter(m=>m.provider!=='openai');const none=h.element();h.c.appendCollaborationActions(none,h.msg,1);assert.equal(none.children.length,0);
  h.c.S.models=h.models;h.msg.model='gpt-6.1-sol';h.msg.provider='openai';const acts=h.element();h.c.appendCollaborationActions(acts,h.msg,1);assert.equal(acts.children.length,3);assert.match(acts.children[1].innerHTML,/请 Claude 看看/);assert.doesNotMatch(acts.children[1].innerHTML,/API/);
});
test('H9 运行或待发送时按钮禁用，结束后恢复，撤回权限后隐藏',()=>{
  const h=harness(),acts=h.element();h.c.appendCollaborationActions(acts,h.msg,1);h.c.S.running.add('a');h.c.updateCollaborationButtons();assert.ok(acts.children.every(b=>b.disabled));h.c.S.running.clear();h.c.S.pendingSends.add('a');h.c.updateCollaborationButtons();assert.ok(acts.children.every(b=>b.disabled));
  h.c.S.pendingSends.clear();h.c.updateCollaborationButtons();assert.ok(acts.children.every(b=>!b.disabled&&!b.hidden));h.c.S.models=h.models.filter(m=>m.provider!=='openai');h.c.updateCollaborationButtons();assert.ok(acts.children.every(b=>b.hidden));
});
test('H9 旧菜单在账号、对话、轮次或权限变化后不能替换新回答',async()=>{
  for(const change of [h=>{h.c.authState.epoch++;h.c.authState.user='bob';},h=>{h.c.S.convId='b';h.c.S.conv={id:'b',messages:[{},h.msg]};},h=>{h.c.S.conv.messages[1]={...h.msg,turnId:'newer-turn'};},h=>{h.c.S.models=h.models.filter(m=>m.provider!=='openai');}]){
    const h=harness(),ctx=h.context();change(h);await h.c.retryWithModel(ctx,'gpt-6.1-sol');assert.equal(h.calls.length,0);
  }
});
test('H9 旧复核按钮在新回复、身份或权限变化后不能新发请求',async()=>{
  for(const change of [h=>h.c.S.conv.messages.push({role:'user',text:'new'}),h=>{h.c.S.conv.messages[1]={...h.msg,turnId:'newer-turn'};},h=>{h.c.authState.epoch++;},h=>{h.c.S.fallbackModels.openai=null;}]){
    const h=harness(),ctx=h.context();change(h);await h.c.reviewReply(ctx,'gpt-6.1-terra');assert.equal(h.calls.length,0);
  }
});
test('H9 MODEL_UNAVAILABLE 拒绝一次性请求不会更换选择框或自动再发',async()=>{
  for(const action of ['retry','review']){const h=harness(),before=h.before(),history=plain(h.c.S.conv.messages);h.c.post=async(url,body)=>{h.calls.push({url,body:plain(body)});throw Object.assign(Error('模型不可用'),{code:'MODEL_UNAVAILABLE',choice:{model:'opus',effort:'medium'}});};
    await(action==='retry'?h.c.retryWithModel(h.context(),'gpt-6.1-sol'):h.c.reviewReply(h.context(),'gpt-6.1-terra'));assert.deepEqual(h.before(),before);assert.deepEqual(plain(h.c.S.conv.messages),history);assert.equal(h.calls.length,1);assert.match(h.notices[0],/不可用/);
  }
});
test('H9 在途失败保留后来明确选的对话型号和档位',async()=>{
  const h=harness(),gate=deferred();h.c.post=(url,body)=>url==='/api/chat'?gate.promise:Promise.resolve({choice:body});const sending=h.c.reviewReply(h.context(),'gpt-6.1-terra');h.c.S.model='opus';h.c.S.effort='medium';h.c.choiceChanged();gate.reject(Error('synthetic network'));await sending;assert.equal(h.c.S.model,'opus');assert.equal(h.c.S.conv.model,'opus');assert.equal(h.c.S.effort,'medium');assert.equal(h.c.S.choiceExplicitFor,'a');
});
test('H9 本来已选目标模型时一次性成功也不清除显式选择标记',async()=>{
  const h=harness();h.c.S.model=h.c.S.conv.model='gpt-6.1-sol';h.c.S.effort=h.c.S.conv.effort='high';await h.c.retryWithModel(h.context(),'gpt-6.1-sol');assert.equal(h.c.S.choiceExplicitFor,'a');
});
test('H9 复核后正常继续聊天仍用原先选定型号，并保留新问题草稿直到普通发送',async()=>{
  const h=harness();await h.c.reviewReply(h.context(),'gpt-6.1-terra');h.c.S.running.clear();h.c.S.conv.messages.at(-1).status='done';h.$('#input').value='follow-up question';await h.c.send();const chats=h.calls.filter(x=>x.url==='/api/chat');assert.equal(chats.length,2);assert.equal(chats[0].body.model,'gpt-6.1-terra');assert.equal(chats[1].body.model,'sonnet');assert.equal(chats[1].body.effort,'low');assert.equal(chats[1].body.message,'follow-up question');
});
test('H9 从菜单取消不会修改会话或草稿，也没有系统确认弹窗',()=>{
  const h=harness(),before=h.before();h.c.retryModelMenu(h.element(),h.context());const menu=h.c.menuEl;menu.children[0].onclick();menu.children[1].onclick();assert.equal(h.c.menuEl,null);assert.equal(h.calls.length,0);assert.deepEqual(h.before(),before);
  assert.doesNotMatch(['retryWithModel','reviewReply','retryModelMenu'].map(extract).join('\n'),/\b(?:alert|confirm|prompt)\s*\(/);
});

function interactiveHarness() {
  const h=harness(),c=h.c;h.actions=[];
  h.rebuild=()=>{for(const node of h.created)if(node.className==='collab-btn')node.removed=true;h.actions=[];(c.S.conv?.messages||[]).forEach((msg,idx)=>{if(msg.role==='assistant'&&msg.status!=='running'){const acts=h.element();c.appendCollaborationActions(acts,msg,idx);h.actions.push(acts);}});c.updateCollaborationButtons();};
  Object.assign(c,{renderThread:()=>h.rebuild(),updateHandoffNotice(){},rerenderMsg:()=>h.rebuild(),PAGE_BUILD:'__PAGE_BUILD__',renderUsage(){},refreshUsage(){},renderBanner(){},showUpdatePill(){},window:{}});
  vm.runInContext(extract('updateSendBtn')+'\n'+extract('applyState'),c);
  h.state=(models=h.models,fallback={anthropic:'sonnet',openai:'gpt-6.1-terra'})=>({conversations:[],running:[],models,fallbackModels:fallback,defaultModel:'opus',defaultEffort:'medium',choice:{model:'opus',effort:'medium'}});
  return h;
}
test('H9 真实发送失败回滚重建 DOM 后，清除 pending 会重新启用按钮',async()=>{
  for(const code of ['MODEL_UNAVAILABLE','NETWORK']){
    const h=interactiveHarness();h.c.post=async()=>{throw Object.assign(Error('synthetic failure'),{code,choice:{model:'opus',effort:'medium'}});};
    await h.c.reviewReply(h.context(),'gpt-6.1-terra');assert.equal(h.c.S.pendingSends.size,0);assert.equal(h.c.S.running.size,0);const buttons=h.actions.at(-1).children;assert.equal(buttons.length,3);assert.ok(buttons.every(button=>!button.disabled&&!button.hidden));
  }
});
test('H9 旧账号失败 finally 不能删掉新账号同 ID 正在等待的发送或更新其按钮',async()=>{
  const h=interactiveHarness(),gate=deferred();h.c.post=()=>gate.promise;const sending=h.c.reviewReply(h.context(),'gpt-6.1-terra');
  h.c.authState.epoch++;h.c.authState.user='bob';h.c.S.conv={id:'a',model:'opus',messages:[]};h.c.S.pendingSends=new Set(['a']);let updates=0;h.c.updateSendBtn=()=>{updates++;};gate.reject(Error('old account failed'));await sending;
  assert.equal(h.c.S.pendingSends.has('a'),true);assert.equal(h.c.S.conv.model,'opus');assert.equal(updates,0);
});
test('H9 权限由无到有时 applyState 为已结束回复新增可点击入口，撤回后移除',async()=>{
  const h=interactiveHarness();h.c.S.models=h.models.filter(m=>m.provider!=='openai');h.c.S.fallbackModels.openai=null;h.rebuild();assert.equal(h.actions[0].children.length,0);const before=h.before();
  h.c.applyState(h.state());assert.equal(h.actions[0].children.length,3);assert.deepEqual(h.before(),before);assert.ok(h.actions[0].children.every(button=>!button.disabled&&!button.hidden));
  h.c.applyState(h.state(h.models.filter(m=>m.provider!=='openai'),{anthropic:'sonnet',openai:null}));assert.equal(h.actions[0].children.length,0);assert.equal(h.calls.length,0);
});
test('H9 fallback 配置变化后重建复核按钮，点击采用新型号而非过期闭包',async()=>{
  const h=interactiveHarness();h.rebuild();const old=h.actions[0].children[1],before=h.before();h.c.applyState(h.state(h.models,{anthropic:'sonnet',openai:'gpt-6.1-sol'}));
  const current=h.actions[0].children[1];assert.notEqual(current,old);assert.deepEqual(h.before(),before);await current.onclick();const chat=h.calls.find(call=>call.url==='/api/chat');assert.equal(chat.body.model,'gpt-6.1-sol');assert.equal(chat.body.action,'review');assert.equal(h.notices.length,0);
});
test('H9 无 turnId 老回答经相同内容刷新和签名 URL 更新后仍可复核',async()=>{
  const h=interactiveHarness();delete h.msg.turnId;h.msg.files=[{path:'synthetic/result.txt',url:'old-signed-url'}];h.rebuild();const button=h.actions[0].children[1];
  h.c.S.conv=JSON.parse(JSON.stringify(h.c.S.conv));h.c.S.conv.messages[1].files[0].url='new-signed-url';h.c.updateCollaborationButtons();assert.equal(button.disabled,false);await button.onclick();assert.equal(h.calls.find(call=>call.url==='/api/chat').body.action,'review');assert.equal(h.notices.length,0);
});
test('H9 老回答稳定签名仍拒绝同索引的输入、回答、文件或轮次变化',async()=>{
  for(const change of [conv=>conv.messages[0].text='changed question',conv=>conv.messages[1].events[0].text='changed answer',conv=>{conv.messages[1].files=[{path:'other.txt'}];},conv=>{conv.messages[1].turnId='new-turn';}]){
    const h=interactiveHarness();delete h.msg.turnId;const ctx=h.context();h.c.S.conv=JSON.parse(JSON.stringify(h.c.S.conv));change(h.c.S.conv);await h.c.reviewReply(ctx,'gpt-6.1-terra');assert.equal(h.calls.length,0);assert.match(h.notices[0],/发生变化/);
  }
});
