'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./model-server-fixture.cjs');const {REVIEW_PROMPT}=require('../tools/model-collaboration.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
function seed(h,extra={}){const c={id:'a'.repeat(16),title:'合成复核',createdAt:1,titled:true,sessionId:null,messages:[{role:'user',text:'FIRST_TASK'},{role:'assistant',turnId:'turn-first',model:'haiku',effort:'low',status:'done',result:'PREVIOUS_ONLY',events:[{k:'tool',id:'one',name:'Write',summary:'outputs/source.txt'}],files:[{path:'outputs/source.txt',size:7}]},{role:'user',text:'TARGET_TASK',sessionBefore:null,codexBefore:null},{role:'assistant',turnId:'turn-second',model:'haiku',effort:'low',status:'done',result:'REMOVED_ANSWER',events:[]}],...extra};h.api.saveConv(h.user,c);return c;}
async function end(h){for(const c of h.calls.filter(c=>['claude','codex'].includes(c.kind)&&c.child.exitCode===null)){c.child.exitCode=0;c.child.emit('close',0);}await tick();await tick();}
const prefs=h=>h.evaluate("JSON.stringify(loadPrefs(api.USERS.get('alice')))");
test('H9 换模型重答只替换该轮及后续，保留旧对话模型和账号默认',async t=>{
 const h=fixture(t),c=seed(h),before=prefs(h);const r=await h.route('/api/chat','POST',{conversationId:c.id,message:'TARGET_TASK',fromIndex:2,retryWithModel:true,retryTurnId:'turn-second',model:'gpt-6-luna',effort:'low'});assert.equal(r.status,200);
 const stored=h.api.loadConv(h.user,c.id);assert.equal(stored.messages.length,4);assert.equal(stored.model,'haiku');assert.equal(stored.messages.at(-1).model,'gpt-6-luna');assert.equal(stored.messages.at(-2).retryWithModel,true);assert.equal(prefs(h),before);
 const call=h.calls.find(x=>x.kind==='codex');assert.match(call.child.input,/PREVIOUS_ONLY/);assert.doesNotMatch(call.child.input,/REMOVED_ANSWER/);await end(h);
});
test('H9 复核是固定普通新消息，带完整交接并保留对话选择，之后可正常续聊',async t=>{
 const h=fixture(t),c=seed(h,{model:'haiku',effort:'low'});c.messages=c.messages.slice(0,2);h.api.saveConv(h.user,c);
 let r=await h.route('/api/chat','POST',{conversationId:c.id,action:'review',reviewIndex:1,reviewTurnId:'turn-first',message:'不能藏进标签的任意文本',model:'gpt-6-luna',effort:'low'});assert.equal(r.status,200);
 let stored=h.api.loadConv(h.user,c.id);assert.equal(stored.messages.length,4);assert.equal(stored.messages[2].action,'review');assert.equal(stored.messages[2].text,REVIEW_PROMPT);assert.equal(stored.model,'haiku');assert.equal(stored.messages[2].cont,undefined);assert.equal(stored.messages[3].handoff.from,'haiku');
 const call=h.calls.find(x=>x.kind==='codex');assert.match(call.child.input,/PREVIOUS_ONLY/);assert.match(call.child.input,/source\.txt/);assert.doesNotMatch(call.child.input,/不能藏进标签/);await end(h);
 r=await h.route('/api/chat','POST',{conversationId:c.id,message:'复核后继续聊'});assert.equal(r.status,200);assert.equal(h.calls.filter(x=>x.kind==='claude').length,1);await end(h);
});
test('H9 无权限或过期的复核/重答不会截断或发起模型',async t=>{
 const h=fixture(t,{config:{gptUsers:[]}}),c=seed(h),before=JSON.stringify(h.api.loadConv(h.user,c.id));
 for(const body of [{retryWithModel:true,fromIndex:0,model:'gpt-6-luna',message:'替换'},{action:'review',reviewIndex:3,reviewTurnId:'turn-second',model:'gpt-6-luna'},{action:'review',reviewIndex:1,reviewTurnId:'turn-first',model:'sonnet'},{retryWithModel:true,fromIndex:1,model:'sonnet',message:'替换'}]){const r=await h.route('/api/chat','POST',{conversationId:c.id,...body});assert.ok([400,409].includes(r.status));}
 assert.equal(JSON.stringify(h.api.loadConv(h.user,c.id)),before);assert.equal(h.calls.some(x=>['claude','codex'].includes(x.kind)),false);
});
test('H9 等待收尾期间目标改变，旧复核请求重新验证后拒绝',async t=>{
 let release,entered;const enter=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const h=fixture(t,{finalizationFactory:()=>({begin:()=>()=>{},wait:async()=>{entered();await wait;return {incomplete:false};}})}),c=seed(h,{model:'haiku'});
 const pending=h.route('/api/chat','POST',{conversationId:c.id,action:'review',reviewIndex:3,reviewTurnId:'turn-second',model:'gpt-6-luna'});await enter;
 const edited=h.api.loadConv(h.user,c.id);edited.messages.at(-1).turnId='replacement';h.api.saveConv(h.user,edited);release();const r=await pending;assert.equal(r.status,400);assert.equal(h.calls.some(x=>x.kind==='codex'),false);
});
