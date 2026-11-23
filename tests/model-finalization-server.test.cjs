'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const { fixture }=require('./model-server-fixture.cjs');
const { createFinalizationBarrier }=require('../tools/model-finalization.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function complete(call) { call.child.stdout.write(JSON.stringify({type:'result',session_id:'synthetic-old',result:'合成完成',is_error:false})+'\n'); }
async function start(t,options) {
  const h=fixture(t,options),r=await h.route('/api/chat','POST',{message:'只把合成结果写文件',model:'haiku',effort:'low'});
  assert.equal(r.status,200); await tick(); return {h,id:r.body.conversationId,first:h.calls.find(c=>c.kind==='claude')};
}
async function close(call){call.child.exitCode=0;call.child.emit('close',0);await tick();await tick();}
test('H2 实际聊天路由在换提供方时等待close扫描，并把文件放进交接',async t=>{
  const {h,id,first}=await start(t);complete(first);
  const next=h.route('/api/chat','POST',{message:'上一轮结果在哪',conversationId:id,model:'gpt-6-luna',effort:'low'});
  await tick();assert.equal(h.calls.filter(c=>c.kind==='codex').length,0);
  const rel=h.api.convFolder(h.user,h.api.loadConv(h.user,id))+'/outputs/result.txt';
  h.io.writeTextSync(h.ctx,rel,'合成答案42');await close(first);
  const response=await next;assert.equal(response.status,200);
  const gpt=h.calls.find(c=>c.kind==='codex');assert.ok(gpt.child.input.includes(rel));assert.match(gpt.child.input,/只把合成结果写文件/);
  await close(gpt);
});
test('H2 同提供方连续发送不等待上一进程收尾',async t=>{
  const {h,id,first}=await start(t);complete(first);
  const next=await h.route('/api/chat','POST',{message:'继续同模型',conversationId:id,model:'haiku',effort:'low'});
  assert.equal(next.status,200);const calls=h.calls.filter(c=>c.kind==='claude');assert.equal(calls.length,2);
  await close(first);await close(calls[1]);
});
test('H2 超时后正常开始但交接明确提示可能不全',async t=>{
  const {h,id,first}=await start(t,{finalizationFactory:()=>createFinalizationBarrier({setTimer:(fn,ms)=>{assert.equal(ms,5000);return setTimeout(fn,20);},clearTimer:clearTimeout})});
  complete(first);
  const next=await h.route('/api/chat','POST',{message:'接着做',conversationId:id,model:'gpt-6-luna',effort:'low'});
  assert.equal(next.status,200);const gpt=h.calls.find(c=>c.kind==='codex');assert.match(gpt.child.input,/文件清单和文字记录可能不全/);
  await close(first);await close(gpt);
});
test('H2 等待期间删除对话不会被迟到请求复活',async t=>{
  const {h,id,first}=await start(t);complete(first);
  const next=h.route('/api/chat','POST',{message:'接着做',conversationId:id,model:'gpt-6-luna',effort:'low'});await tick();
  assert.equal((await h.route('/api/conversations/'+id,'DELETE')).status,200);
  await close(first); await h.api.modelFinalization.wait('alice',id,'openai');
  assert.throws(()=>h.io.readTextSync(h.ctx,'.memory/chats/'+id+'.md'),error=>error.code==='ENOENT');
  assert.equal((await next).status,404);assert.equal(h.calls.filter(c=>c.kind==='codex').length,0);assert.equal(h.api.loadConv(h.user,id),null);
});
test('H2 同毫秒重答仍用独立轮次身份，旧close不能把文件挂到新回答',async t=>{
  const h=fixture(t);h.evaluate('Date.now = () => 1793531771607;');
  const firstReply=await h.route('/api/chat','POST',{message:'旧任务',model:'haiku',effort:'low'}),id=firstReply.body.conversationId;
  const first=h.calls.find(c=>c.kind==='claude');await tick();complete(first);
  const rel=h.api.convFolder(h.user,h.api.loadConv(h.user,id))+'/outputs/old-turn.txt';h.io.writeTextSync(h.ctx,rel,'旧轮结果');
  const retry=await h.route('/api/chat','POST',{message:'新任务',conversationId:id,fromIndex:0,model:'haiku',effort:'low'});
  assert.equal(retry.status,200);assert.equal(firstReply.body.startedAt,retry.body.startedAt);assert.notEqual(firstReply.body.turnId,retry.body.turnId);
  const second=h.calls.filter(c=>c.kind==='claude').at(-1);await tick();
  second.child.stdout.write(JSON.stringify({type:'result',result:'NEW',is_error:false})+'\n');await close(second);
  await close(first);await h.api.modelFinalization.wait('alice',id,'openai');
  const conv=(await h.route('/api/conversations/'+id)).body;assert.equal(conv.messages.at(-1).result,'NEW');assert.deepEqual(conv.messages.at(-1).files,[]);
  const transcript=h.io.readTextSync(h.ctx,'.memory/chats/'+id+'.md');assert.match(transcript,/新任务/);assert.doesNotMatch(transcript,/## 用户说\n旧任务|old-turn/);
});
test('H2 重答按截断后的历史判断切换，仍未close的前提供方必须再次等待或提示',async t=>{
  let waits=0;const {h,id,first}=await start(t,{finalizationFactory:()=>createFinalizationBarrier({setTimer:(fn,ms)=>{assert.equal(ms,5000);waits++;return setTimeout(fn,20);},clearTimer:clearTimeout})});
  complete(first);
  const switched=await h.route('/api/chat','POST',{message:'第一次切换',conversationId:id,model:'gpt-6-luna',effort:'low'});assert.equal(switched.status,200);
  const gpt=h.calls.find(c=>c.kind==='codex');assert.match(gpt.child.input,/可能不全/);await close(gpt);
  const retry=await h.route('/api/chat','POST',{message:'重答这一轮',conversationId:id,fromIndex:2,model:'gpt-6-luna',effort:'low'});
  assert.equal(retry.status,200);assert.equal(waits,2);const again=h.calls.filter(c=>c.kind==='codex').at(-1);assert.match(again.child.input,/可能不全/);assert.doesNotMatch(again.child.input,/第一次切换/);
  await close(first);await close(again);
});
