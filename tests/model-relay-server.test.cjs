'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./model-server-fixture.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
const choices=h=>JSON.parse(h.evaluate("JSON.stringify(fallbackModelsFor(api.USERS.get('alice')))"));
async function end(h){for(const call of h.calls.filter(c=>['claude','codex'].includes(c.kind)&&c.child.exitCode===null)){call.child.exitCode=0;call.child.emit('close',0);}await tick();await tick();}
test('H7 默认接力Claude Sonnet和GPT Terra，只暴露当前账号可用型号',t=>{
 const h=fixture(t);assert.deepEqual(choices(h),{anthropic:'sonnet',openai:'gpt-6.1-terra',google:null});
 const denied=fixture(t,{config:{gptUsers:[]}});assert.deepEqual(choices(denied),{anthropic:'sonnet',openai:null,google:null});
});
test('H7 可配置接力型号，错提供方/已撤型号不静默替代',t=>{
 const h=fixture(t,{config:{fallbackModels:{anthropic:'haiku',openai:'gpt-6-luna'}}});assert.deepEqual(choices(h),{anthropic:'haiku',openai:'gpt-6-luna',google:null});
 const wrong=fixture(t,{config:{fallbackModels:{anthropic:'gpt-6-luna',openai:'unknown'}}});assert.deepEqual(choices(wrong),{anthropic:null,openai:null,google:null});
});
test('H7 换提供方接力仍走continue，保留停止前工具、文件和未完成清单',async t=>{
 const h=fixture(t),conv={id:'c'.repeat(16),title:'合成接力',createdAt:1,titled:true,sessionId:null,messages:[{role:'user',text:'做完文件后再写剩余结果'},{role:'assistant',model:'haiku',status:'stopped',result:'文件已做完',events:[{k:'tool',id:'done-file',name:'Write',summary:'outputs/already.txt'},{k:'tool_result',id:'done-file',error:false}],files:[{path:'outputs/already.txt',size:2}],plan:[{subject:'写剩余结果',status:'in_progress'}]}]};h.api.saveConv(h.user,conv);
 const r=await h.route('/api/chat','POST',{conversationId:conv.id,message:'继续',continue:true,model:'gpt-6.1-terra',effort:'low'});assert.equal(r.status,200);const call=h.calls.find(c=>c.kind==='codex');assert.ok(call);assert.match(call.child.input,/already\.txt/);assert.match(call.child.input,/写剩余结果/);assert.match(call.child.input,/被中断/);assert.match(call.child.input,/不要从头重来/);
 const stored=h.api.loadConv(h.user,conv.id);assert.equal(stored.messages.length,4);assert.equal(stored.messages[2].cont,true);assert.equal(stored.messages[2].resumesInterrupted,false);assert.equal(stored.model,'gpt-6.1-terra');await end(h);
});
