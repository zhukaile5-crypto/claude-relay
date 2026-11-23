'use strict';
// H6：运行实际页面函数，DOM 和对话均为合成替身，不打开浏览器、不调用模型。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const extract = name => { const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}', 'm')); assert.ok(match, name); return match[0]; };
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const nodes = new Map(), cache = new WeakMap();
  const node = key => { if (!nodes.has(key)) nodes.set(key, {textContent:'', value:'synthetic question', innerHTML:'', classes:new Set(), classList:{toggle(name,on){const n=nodes.get(key);if(on)n.classes.add(name);else n.classes.delete(name);}}}); return nodes.get(key); };
  const models = [{id:'opus',label:'Opus 5.5',provider:'anthropic'}, {id:'sonnet',label:'Sonnet 5.5',provider:'anthropic'}, {id:'gpt-sol',label:'GPT Sol',provider:'openai'}, {id:'gpt-luna',label:'GPT Luna',provider:'openai'}];
  const c = {S:{models,model:'gpt-sol',effort:'medium',view:'chat',convId:'a',conv:{id:'a',messages:[{role:'assistant',model:'opus',provider:'anthropic'}]},running:new Set(),pendingSends:new Map(),atts:[]},
    $:node,modelLabel:id=>{const m=models.find(m=>m.id===id);return m?(m.provider==='openai'?m.label:'Claude '+m.label):id;},
    esc:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
    htmlNode:html=>({html,open:false}),partsOf:msg=>{if(!cache.has(msg))cache.set(msg,new Map());return cache.get(msg);},
    renderPlan:()=>({kind:'plan'}),liveText:()=>({kind:'live'}),renderMd:()=>({kind:'text'}),renderProc:()=>({kind:'process'}),groupSig:()=>'',
    crab:()=>'',elapsedSpan:()=>'',splitFiles:()=>({inline:[],cards:[]}),spark:()=>'',icon:()=>'',fmtElapsed:()=>'',fmtTokens:n=>n,
    appendCollaborationActions(){}, updateCollaborationButtons(){}, renderRelayActions:()=>null, friendlyError:()=>({resumable:false}),document:{createElement:()=>({querySelector:()=>({}),appendChild(){}})},effortsFor:()=>[['medium','标准']],
  };
  vm.createContext(c);
  vm.runInContext(['cachedPart','handoffModel','nextHandoffText','updateHandoffNotice','handoffPresentation','handoffNote','assistantParts','updateModelBtn','updateSendBtn'].map(extract).join('\n'),c);
  const reply = more => ({role:'assistant',model:'gpt-sol',provider:'openai',status:'done',events:[],handoff:{from:'opus',turns:3,tools:7,files:5,chars:6800,truncated:false,recovered:false},...more});
  return {c,node,models,reply};
}

test('H6 Claude 换 GPT 时输入框说明下一模型、API 计费与交接',()=>{
  const {c}=harness();assert.equal(c.nextHandoffText(),'下一条将由 GPT Sol 回答，按 API 计费，会交接前面的内容');
});
test('H6 GPT 换 Claude 显示下一模型而不声称 Claude 按 API 计费',()=>{
  const {c}=harness();c.S.model='opus';c.S.conv.messages=[{role:'assistant',model:'gpt-sol',provider:'openai'}];
  assert.equal(c.nextHandoffText(),'下一条将由 Claude Opus 5.5 回答，会交接前面的内容');
});
test('H6 同一家更换型号不出现发送前交接提示',()=>{
  const {c}=harness();c.S.model='sonnet';assert.equal(c.nextHandoffText(),'');c.S.model='gpt-luna';c.S.conv.messages=[{role:'assistant',model:'gpt-sol',provider:'openai'}];assert.equal(c.nextHandoffText(),'');
});
test('H6 使用最后一条回答，后面的用户消息不改变来源',()=>{
  const {c}=harness();c.S.conv.messages.push({role:'assistant',model:'gpt-luna',provider:'openai'},{role:'user',text:'synthetic'});assert.equal(c.nextHandoffText(),'');
});
test('H6 新首页、项目新页和只有用户消息时不出现虚假交接',()=>{
  const {c}=harness();c.S.view='project';assert.equal(c.nextHandoffText(),'');c.S.view='chat';c.S.conv.messages=[{role:'user',text:'synthetic'}];assert.equal(c.nextHandoffText(),'');c.S.conv=null;assert.equal(c.nextHandoffText(),'');
});
test('H6 已在发送和回答中时不把当前任务称为下一条交接',()=>{
  const {c}=harness();c.S.pendingSends.set('a',{});assert.equal(c.nextHandoffText(),'');c.S.pendingSends.clear();c.S.running.add('a');assert.equal(c.nextHandoffText(),'');c.S.running.clear();assert.match(c.nextHandoffText(),/GPT Sol/);
});
test('H6 历史模型退出可用目录后依靠保存的提供方仍能提醒',()=>{
  const {c}=harness();c.S.conv.messages=[{role:'assistant',model:'retired-model',provider:'anthropic'}];assert.match(c.nextHandoffText(),/按 API 计费/);
  c.S.conv.messages=[{role:'assistant',model:'gpt-retired'}];c.S.model='opus';assert.match(c.nextHandoffText(),/Claude Opus/);
});
test('H6 选择模型和发送按钮更新都会刷新并清除已有提示',()=>{
  const {c,node}=harness();c.updateModelBtn();assert.match(node('#handoffNext').textContent,/按 API 计费/);assert.equal(node('#handoffNext').classes.has('hidden'),false);
  c.S.model='sonnet';c.updateModelBtn();assert.equal(node('#handoffNext').textContent,'');assert.equal(node('#handoffNext').classes.has('hidden'),true);
  c.S.model='gpt-sol';c.updateSendBtn();assert.match(node('#handoffNext').textContent,/GPT Sol/);c.S.running.add('a');c.updateSendBtn();assert.equal(node('#handoffNext').textContent,'');
});
test('H6 回复摘要仅显示持久化数量，外加路径或原始摘要永不渲染',()=>{
  const {c,reply}=harness(),msg=reply();Object.assign(msg.handoff,{path:'C:\\private\\secret.txt',summary:'PRIVATE_CONTEXT',messages:[{text:'PRIVATE_MESSAGE'}]});
  const info=plain(c.handoffPresentation(msg));assert.equal(info.title,'由 Claude Opus 5.5 交给 GPT Sol · 交接 3 轮、5 个文件');assert.match(info.detail,/操作记录 7 项/);assert.match(info.detail,/6800 字/);
  const html=c.handoffNote(msg).html;assert.doesNotMatch(html,/private|secret|PRIVATE|provider|session_id|thread_id|workspace|tool_result/);
});
test('H6 数量字段格式异常时不用任意文本替代统计',()=>{
  const {c,reply}=harness(),msg=reply({handoff:{from:'opus',turns:'C:\\private',tools:-1,files:Infinity,chars:NaN,truncated:'yes',recovered:1}});
  const info=plain(c.handoffPresentation(msg));assert.match(info.title,/交接 0 轮、0 个文件/);assert.match(info.detail,/操作记录 0 项.*约 0 字/);assert.equal(info.truncated,false);assert.equal(info.recovered,false);assert.doesNotMatch(c.handoffNote(msg).html,/private|NaN|Infinity/);
});
test('H6 可展开统计默认折叠，截断在折叠标题和展开摘要均明确说明',()=>{
  const {c,reply}=harness(),html=c.handoffNote(reply({handoff:{from:'opus',turns:3,tools:2,files:5,chars:600,truncated:true,recovered:true}})).html;
  assert.match(html,/^<details class="handoff-note"><summary/);assert.doesNotMatch(html,/<details[^>]+\sopen(?:\s|>)/);assert.match(html,/<summary[^>]*>[^<]*部分内容已省略<\/summary>/);
  assert.match(html,/部分较早的内容已省略/);assert.match(html,/已根据前面的内容重新接续/);
});
test('H6 同提供方型号变化和无交接元数据都不显示分隔条',()=>{
  const {c,reply}=harness();assert.equal(c.handoffNote(reply({model:'sonnet',provider:'anthropic'})),null);
  assert.equal(c.handoffNote(reply({handoff:{from:'gpt-luna',turns:1}})),null);assert.equal(c.handoffNote(reply({handoff:null})),null);
});
test('H6 未识别的模型 ID 不会把路径直接显示成模型名',()=>{
  const {c,reply}=harness();assert.equal(c.handoffNote(reply({handoff:{from:'C:\\private\\secret'}})),null);
  const msg=reply({model:'C:\\private\\secret',provider:'openai'});assert.match(c.handoffNote(msg).html,/交给 GPT/);assert.doesNotMatch(c.handoffNote(msg).html,/private|secret/);
});
test('H6 目录已无旧型号时仍给出安全的 Claude 与 GPT 名称',()=>{
  const {c,reply}=harness(),msg=reply({model:'gpt-retired',handoff:{from:'claude-old',turns:1,tools:0,files:0,chars:30}});
  assert.match(c.handoffNote(msg).html,/由 Claude 交给 GPT/);
});
test('H6 已展开统计在流式刷新中保留节点，统计改变后才重建',()=>{
  const {c,reply}=harness(),msg=reply(),first=c.handoffNote(msg);first.open=true;msg.events.push({k:'text',text:'synthetic answer'});
  assert.equal(c.handoffNote(msg),first);assert.equal(c.handoffNote(msg).open,true);msg.handoff.files=6;assert.notEqual(c.handoffNote(msg),first);
});
test('H6 重新加载保存的对话可重建相同交接摘要',()=>{
  const {c,reply}=harness(),msg=reply();const before=c.handoffNote(msg).html,loaded=JSON.parse(JSON.stringify(msg));assert.equal(c.handoffNote(loaded).html,before);
});
test('H6 分隔位于计划与回复前，保留既有恢复说明并转义内容',()=>{
  const {c,reply}=harness(),msg=reply({plan:[{subject:'synthetic'}],result:'synthetic answer',recoveryNotice:'已恢复 <safe>'});
  const parts=c.assistantParts(msg,0);assert.match(parts.kids[0].html,/handoff-note/);assert.equal(parts.kids[1].kind,'plan');assert.ok(parts.kids.some(n=>n.html?.includes('已恢复 &lt;safe&gt;')));
});
test('H6 模型显示名称中的 HTML 被转义，不会成为可执行标记',()=>{
  const {c,models,reply}=harness();models[0].label='<img src=x onerror=alert(1)>';const html=c.handoffNote(reply()).html;assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('H6 提示随输入框移动，使用礼貌播报且只添加原生展开摘要',()=>{
  const composer=source.slice(source.indexOf('<div class="composer" id="composer">'),source.indexOf('<textarea id="input"'));
  assert.match(composer,/id="handoffNext"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source,/\.handoff-next[^}]*overflow-wrap: anywhere/);assert.match(source,/\.handoff-note[^}]*overflow-wrap: anywhere/);
  const functions=['handoffModel','nextHandoffText','updateHandoffNotice','handoffPresentation','handoffNote'].map(extract).join('\n');assert.doesNotMatch(functions,/\b(?:alert|confirm|prompt|fetch|post|api)\s*\(/);
});

function sendingHarness() {
  const h=harness(),c=h.c,rerenders=[],reloads=[],notices=[];
  Object.assign(c.S,{pendingSends:new Set(),tool:null,skew:0,draftFor:'c:a',convs:[],choiceExplicitFor:null});
  Object.assign(c,{authState:{epoch:0,user:'synthetic'},accountCurrent:()=>true,choiceSerial:0,flushChoice(){},selectedChoice(choice){c.S.model=choice.model;c.S.effort=choice.effort;},renderThread(){},renderAtts(){},renderSidebar(){},updatePerch(){},
    hop(){},setTool(){},draftTimer:0,clearTimeout(){},ls:{del(){},set(){}},draftLsKey:k=>k,loadState(){},
    rerenderMsg:idx=>rerenders.push(idx),openConv:async id=>reloads.push(id),toast:message=>notices.push(message),
    post:async()=>({conversationId:'a',msgIndex:2,startedAt:123,turnId:'turn-current',handoff:{from:'opus',turns:1,tools:0,files:0,chars:20}}),
  });
  vm.runInContext(extract('send'),c);return {...h,rerenders,reloads,notices};
}
test('H6 发送确认立即给本轮补入交接统计并重画，无需等回复完成',async()=>{
  const h=sendingHarness();await h.c.send();const msg=h.c.S.conv.messages[2];assert.equal(msg.turnId,'turn-current');assert.equal(msg.handoff.turns,1);assert.deepEqual(h.rerenders,[2]);assert.equal(h.notices.length,0);
});
test('H6 先收到完成事件时迟到确认不能覆盖较新的恢复统计',async()=>{
  const h=sendingHarness();h.c.post=async()=>{const msg=h.c.S.conv.messages[2];Object.assign(msg,{turnId:'turn-current',handoff:{from:'opus',turns:1,files:2,recovered:true}});return {conversationId:'a',msgIndex:2,turnId:'turn-current',handoff:{from:'opus',turns:1,files:0,recovered:false}};};
  await h.c.send();assert.equal(h.c.S.conv.messages[2].handoff.recovered,true);assert.equal(h.c.S.conv.messages[2].handoff.files,2);assert.deepEqual(h.rerenders,[]);
});
test('H6 对话相同索引但轮次已变化时旧确认不落交接统计，重新取权威记录',async()=>{
  const h=sendingHarness();h.c.post=async()=>{h.c.S.conv.messages[2].turnId='newer-turn';return {conversationId:'a',msgIndex:2,turnId:'turn-current',handoff:{from:'opus',turns:1}};};
  await h.c.send();assert.equal(h.c.S.conv.messages[2].turnId,'newer-turn');assert.equal(h.c.S.conv.messages[2].handoff,undefined);assert.deepEqual(h.rerenders,[]);assert.deepEqual(h.reloads,['a']);
});
test('H6 导航到别的对话后旧确认不能插入分隔或改写新对话',async()=>{
  const h=sendingHarness(),other={id:'b',messages:[{role:'assistant',model:'sonnet'}]};h.c.post=async()=>{h.c.S.conv=other;h.c.S.convId='b';return {conversationId:'a',msgIndex:2,turnId:'turn-current',handoff:{from:'opus',turns:1}};};
  await h.c.send();assert.equal(h.c.S.conv,other);assert.equal(other.messages.length,1);assert.equal(other.messages[0].handoff,undefined);assert.deepEqual(h.rerenders,[]);
});

test('H6 Claude目录省略provider时仍显示保存的具体型号',()=>{
 const {c,models,reply}=harness();delete models.find(m=>m.id==='sonnet').provider;
 const info=c.handoffPresentation(reply({model:'sonnet',provider:'anthropic',handoff:{from:'gpt-sol',turns:1,files:0,tools:0,chars:100}}));
 assert.match(info.title,/交给 Claude Sonnet 5.5/);
});
