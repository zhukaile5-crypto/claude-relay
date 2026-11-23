'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const { fixture }=require('./model-server-fixture.cjs');
const id='af146508-4562-47d2-8461-a9ab183d6af6';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function missing(provider) {return provider==='claude'?'No conversation found with session ID: '+id:'Error: thread/fork: thread/fork failed: no rollout found for thread id '+id+' (code -32600)';}
async function setup(t,provider) {
  const h=fixture(t),cid='a'.repeat(16),model=provider==='claude'?'haiku':'gpt-6-luna';
  h.api.saveConv(h.user,{id:cid,title:'合成会话恢复',createdAt:1,titled:true,sessionId:id,codexThreadId:id,messages:[
    {role:'user',text:'第一轮原始要求'}, {role:'assistant',model,status:'done',result:'首轮已完成内容',files:[{path:'outputs/first.txt',size:12}]}]});
  const r=await h.route('/api/chat','POST',{conversationId:cid,message:'接着当前任务',model,effort:'low'});assert.equal(r.status,200);await tick();
  return {h,cid,model,first:h.calls.find(c=>c.kind===provider)};
}
async function fail(call,error) {call.child.stderr.write(error+'\n');call.child.exitCode=1;call.child.emit('close',1);await tick();await tick();}
async function succeed(call,provider) {
  const event=provider==='claude'?{type:'result',session_id:'new-synthetic-session',result:'成功恢复',is_error:false}:{type:'turn.completed',usage:{input_tokens:8,output_tokens:2,cached_input_tokens:0}};
  if(provider!=='claude')call.child.stdout.write(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'成功恢复'}})+'\n');
  call.child.stdout.write(JSON.stringify(event)+'\n');call.child.exitCode=0;call.child.emit('close',0);await tick();await tick();
}
for(const provider of ['claude','codex'])test('H4 '+provider+'实际启动闭包只重试一次，同条回答获得首轮完整交接',async t=>{
  const {h,cid,first}=await setup(t,provider);await fail(first,missing(provider));
  const calls=h.calls.filter(c=>c.kind===provider);assert.equal(calls.length,2);
  const retry=calls[1];assert.equal(provider==='claude'?retry.options.sessionId:retry.options.threadId,null);
  assert.match(retry.child.input,/第一轮原始要求/);assert.match(retry.child.input,/首轮已完成内容/);assert.match(retry.child.input,/outputs\/first.txt/);assert.match(retry.child.input,/从第一轮/);
  assert.equal(h.api.loadConv(h.user,cid).messages.length,4);
  await succeed(retry,provider);await h.api.modelFinalization.wait('alice',cid,provider==='claude'?'openai':'anthropic');
  const answer=(await h.route('/api/conversations/'+cid)).body.messages.at(-1);
  assert.equal(answer.status,'done');assert.equal(answer.recoveryNotice,'原会话不可用，已从对话记录恢复');assert.equal(answer.handoff.recovered,true);
});
for(const provider of ['claude','codex'])test('H4 '+provider+'已有工具事件不能重试以免重复工作',async t=>{
  const {h,first}=await setup(t,provider);
  const event=provider==='claude'?{type:'assistant',message:{content:[{type:'tool_use',id:'read',name:'Read',input:{file_path:'outputs/first.txt'}}]}}:{type:'item.started',item:{id:'cmd',type:'command_execution',command:'synthetic-only',status:'in_progress'}};
  first.child.stdout.write(JSON.stringify(event)+'\n');await fail(first,missing(provider));assert.equal(h.calls.filter(c=>c.kind===provider).length,1);
});
test('H4 Claude原始stream工具开始即阻止重试，尚未有完整参数也不例外',async t=>{
  const {h,first}=await setup(t,'claude');first.child.stdout.write(JSON.stringify({type:'stream_event',api_message_id:'s',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'early',name:'Write'}}})+'\n');
  await fail(first,missing('claude'));assert.equal(h.calls.filter(c=>c.kind==='claude').length,1);
});
test('H4 重试再次报错只显示失败，不第三次尝试',async t=>{
  const {h,cid,first}=await setup(t,'claude');await fail(first,missing('claude'));const retry=h.calls.filter(c=>c.kind==='claude')[1];await fail(retry,missing('claude'));
  assert.equal(h.calls.filter(c=>c.kind==='claude').length,2);const last=h.api.loadConv(h.user,cid).messages.at(-1);assert.equal(last.status,'error');assert.equal(last.handoff.recovered,false);assert.match(last.recoveryNotice,/未完成/);
});
test('H4 取消和网络错误不触发自动恢复',async t=>{
  const a=await setup(t,'claude');a.h.api.stopJob(a.h.user,a.cid);await fail(a.first,missing('claude'));assert.equal(a.h.calls.filter(c=>c.kind==='claude').length,1);
  const b=await setup(t,'codex');await fail(b.first,'network connection reset');assert.equal(b.h.calls.filter(c=>c.kind==='codex').length,1);
});

test('H4 缺少start但已收到工具参数增量时仍不得重试',async t=>{
  const {h,first}=await setup(t,'claude');
  first.child.stdout.write(JSON.stringify({type:'stream_event',api_message_id:'delta-only',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"file_path":"synthetic.txt"'}}})+'\n');
  await fail(first,missing('claude'));assert.equal(h.calls.filter(c=>c.kind==='claude').length,1);
});

test('H4 子任务已返回文本即视为有工具动作，不重试',async t=>{
  const {h,first}=await setup(t,'claude');
  first.child.stdout.write(JSON.stringify({type:'assistant',parent_tool_use_id:'synthetic-parent',message:{content:[{type:'text',text:'synthetic subtask performed work'}]}})+'\n');
  await fail(first,missing('claude'));assert.equal(h.calls.filter(c=>c.kind==='claude').length,1);
});

test('H4 缺失会话stderr与结构化额度错误冲突时不会自动重复请求',async t=>{
  const {h,cid,first}=await setup(t,'claude');
  first.child.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,num_turns:0,result:'insufficient_quota',errors:['insufficient_quota']})+'\n');
  await fail(first,missing('claude'));assert.equal(h.calls.filter(c=>c.kind==='claude').length,1);
  assert.equal(h.api.loadConv(h.user,cid).messages.at(-1).status,'error');
});
