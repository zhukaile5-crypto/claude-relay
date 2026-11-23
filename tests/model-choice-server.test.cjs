'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./model-server-fixture.cjs');
const {PassThrough}=require('node:stream');
const tick=()=>new Promise(r=>setImmediate(r));
function seed(h,id='a'.repeat(16),extra={}) {
  const conv={id,title:'合成旧对话',createdAt:1,titled:true,messages:[{role:'user',text:'最初要求'},{role:'assistant',model:'haiku',effort:'low',status:'done',result:'原回答'}],...extra};
  h.api.saveConv(h.user,conv);return conv;
}
async function end(h) {for(const call of h.calls.filter(c=>['claude','codex'].includes(c.kind)&&c.child.exitCode===null)){call.child.exitCode=0;call.child.emit('close',0);}await tick();await tick();}
const prefs=h=>h.evaluate("JSON.stringify(loadPrefs(api.USERS.get('alice')))");
test('H5 旧Claude对话发送恢复原型号，不受账号GPT默认影响且发送保存对话选择',async t=>{
  const h=fixture(t);await h.route('/api/prefs','PUT',{model:'gpt-6-luna',effort:'high'});const old=seed(h),before=prefs(h);
  const r=await h.route('/api/chat','POST',{conversationId:old.id,message:'继续旧对话'});assert.equal(r.status,200);
  assert.equal(h.calls.find(c=>c.kind==='claude').options.model,'haiku');assert.equal(h.calls.some(c=>c.kind==='codex'),false);
  assert.equal(h.api.loadConv(h.user,old.id).model,'haiku');assert.equal(prefs(h),before);await end(h);
});
test('H5 对话PATCH仅改变当前对话，项目对话相同且广播带对话归属',async t=>{
  const h=fixture(t),a=seed(h),b=seed(h,'b'.repeat(16),{projectId:'12345678'});const before=prefs(h);
  h.evaluate("globalThis.choiceEvents=[]; broadcast=(event,u)=>choiceEvents.push({event,user:u.id});");
  const r=await h.route('/api/conversations/'+b.id,'PATCH',{model:'gpt-6-luna',effort:'low'});assert.equal(r.status,200);assert.equal(r.body.choice.model,'gpt-6-luna');
  assert.equal(h.api.loadConv(h.user,b.id).model,'gpt-6-luna');assert.equal(h.api.loadConv(h.user,a.id).model,undefined);assert.equal(prefs(h),before);
  const events=JSON.parse(h.evaluate('JSON.stringify(choiceEvents)'));assert.ok(events.some(x=>x.user==='alice'&&x.event.type==='conversation-choice'&&x.event.convId===b.id));assert.ok(events.every(x=>x.event.type!=='choice'));
});
test('H5 新对话使用账号默认，重答未明确选择时用原轮而非对话当前模型',async t=>{
  const h=fixture(t);await h.route('/api/prefs','PUT',{model:'gpt-6-luna',effort:'low'});
  const fresh=await h.route('/api/chat','POST',{message:'新对话'});assert.equal(fresh.status,200);assert.equal(h.calls.find(c=>c.kind==='codex').options.model,'gpt-6-luna');await end(h);
  const old=seed(h,'b'.repeat(16),{model:'gpt-6-luna',effort:'high'});
  const r=await h.route('/api/chat','POST',{conversationId:old.id,fromIndex:0,message:'重新做最初任务'});assert.equal(r.status,200);assert.equal(h.calls.find(c=>c.kind==='claude').options.model,'haiku');await end(h);
});
test('H5 已撤权或未知模型在发送、预热、PATCH都明确拒绝，不发起其他模型',async t=>{
  const h=fixture(t,{config:{gptUsers:[]}}),old=seed(h,'a'.repeat(16),{model:'gpt-6-luna',effort:'low'});
  assert.equal((await h.route('/api/conversations/'+old.id)).body.model,'gpt-6-luna');
  for(const [url,method,body] of [
    ['/api/chat','POST',{conversationId:old.id,message:'旧模型不能静默替换'}],
    ['/api/chat','POST',{message:'明确选不可用型号',model:'unknown'}],
    ['/api/prewarm','POST',{conversationId:old.id,model:'gpt-6-luna'}],
    ['/api/conversations/'+old.id,'PATCH',{model:'gpt-6-luna',effort:'low'}],
  ]) {const r=await h.route(url,method,body);assert.equal(r.status,409);assert.equal(r.body.code,'MODEL_UNAVAILABLE');assert.equal(r.body.choice.model,'sonnet');}
  assert.equal(h.calls.some(c=>['claude','codex'].includes(c.kind)),false);assert.equal(h.api.loadConv(h.user,old.id).model,'gpt-6-luna');
});
test('H5 不存在或其他账号的对话不能通过选择模型来创建替代对话',async t=>{
  const h=fixture(t),cid='b'.repeat(16);
  assert.equal((await h.route('/api/chat','POST',{conversationId:cid,message:'合成',model:'haiku'})).status,404);
  assert.equal((await h.route('/api/conversations/'+cid,'PATCH',{model:'haiku',effort:'low'})).status,404);
  assert.equal(h.api.loadConv(h.user,cid),null);assert.equal(h.calls.some(c=>c.kind==='claude'),false);
});

function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function holdFolderPreparation(h) {
  const entered=deferred(),released=deferred();
  h.context.folderChoiceGate=released.promise;h.context.enterFolderChoiceGate=entered.resolve;
  h.evaluate("globalThis.originalEnsureChoiceFolder=ensureConvFolder; ensureConvFolder=async (...args)=>{await originalEnsureChoiceFolder(...args);enterFolderChoiceGate();await folderChoiceGate;};");
  return {entered:entered.promise,release:released.resolve};
}
test('H5 换提供方等待收尾时，较新的模型选择保留而当前请求仍按原模型执行',async t=>{
  const h=fixture(t),before=prefs(h);
  const first=await h.route('/api/chat','POST',{message:'合成首轮',model:'haiku',effort:'low'});await tick();
  const id=first.body.conversationId,claude=h.calls.find(c=>c.kind==='claude');
  claude.child.stdout.write(JSON.stringify({type:'result',session_id:'synthetic-choice-session',result:'合成完成',is_error:false})+'\n');
  h.evaluate("globalThis.choiceEvents=[]; broadcast=(event,u)=>choiceEvents.push({event,user:u.id});");
  const pending=h.route('/api/chat','POST',{conversationId:id,message:'本轮继续GPT',model:'gpt-6-luna',effort:'low'});await tick();
  const patch=await h.route('/api/conversations/'+id,'PATCH',{model:'sonnet',effort:'high'});
  const revision=h.api.loadConv(h.user,id).choiceRevision;
  claude.child.exitCode=0;claude.child.emit('close',0);await tick();await tick();
  const reply=await pending;assert.equal(reply.status,200);assert.equal(patch.status,200);assert.equal(revision,2);
  const conv=h.api.loadConv(h.user,id);assert.equal(conv.model,'sonnet');assert.equal(conv.effort,'high');assert.equal(conv.choiceRevision,revision);
  assert.equal(conv.messages.at(-2).model,'gpt-6-luna');assert.equal(conv.messages.at(-1).model,'gpt-6-luna');
  assert.equal(h.calls.find(c=>c.kind==='codex').options.model,'gpt-6-luna');
  const choices=JSON.parse(h.evaluate("JSON.stringify(choiceEvents.filter(x=>x.event.type==='conversation-choice'))"));
  assert.deepEqual(choices.at(-1),{user:'alice',event:{type:'conversation-choice',convId:id,choice:{model:'sonnet',effort:'high'}}});
  assert.equal(prefs(h),before);await end(h);
  assert.equal(h.api.loadConv(h.user,id).model,'sonnet');assert.equal(h.api.loadConv(h.user,id).choiceRevision,revision);
});
test('H5 同提供方建目录等待也保留较新选择，重复选择和只改深度都有新版本',async t=>{
  const h=fixture(t),old=seed(h,'a'.repeat(16),{model:'haiku',effort:'low',choiceRevision:4}),gate=holdFolderPreparation(h);
  const pending=h.route('/api/chat','POST',{conversationId:old.id,message:'本轮Sonnet',model:'sonnet',effort:'low'});await gate.entered;
  const same=await h.route('/api/conversations/'+old.id,'PATCH',{model:'haiku',effort:'low'});
  const sameRevision=h.api.loadConv(h.user,old.id).choiceRevision;
  const changed=await h.route('/api/conversations/'+old.id,'PATCH',{effort:'high',title:'等待中新标题'});
  gate.release();const reply=await pending;
  assert.equal(same.status,200);assert.equal(changed.status,200);assert.equal(sameRevision,5);assert.equal(reply.status,200);
  const conv=h.api.loadConv(h.user,old.id);assert.equal(conv.model,'haiku');assert.equal(conv.effort,'high');assert.equal(conv.choiceRevision,6);assert.equal(conv.title,'等待中新标题');
  assert.equal(conv.messages.at(-2).model,'sonnet');assert.equal(conv.messages.at(-2).effort,'low');assert.equal(h.calls.find(c=>c.kind==='claude').options.model,'sonnet');await end(h);
});
test('H5 同提供方准备期间删除对话，旧发送返回404且不启动或重建',async t=>{
  const h=fixture(t),old=seed(h),gate=holdFolderPreparation(h);
  const pending=h.route('/api/chat','POST',{conversationId:old.id,message:'等待准备',model:'haiku',effort:'low'});await gate.entered;
  const removed=await h.route('/api/conversations/'+old.id,'DELETE');gate.release();const reply=await pending;
  assert.equal(removed.status,200);assert.equal(reply.status,404);assert.equal(h.api.loadConv(h.user,old.id),null);assert.equal(h.calls.some(c=>['claude','codex'].includes(c.kind)),false);await tick();
});
test('H5 PATCH读取请求体期间删除对话，不写回旧存档',async t=>{
  const h=fixture(t),old=seed(h),req=new PassThrough(),res=new PassThrough();
  Object.assign(req,{url:'/api/conversations/'+old.id,method:'PATCH',complete:true,aborted:false,headers:{cookie:'relay_token='+h.api.userToken(h.user)},socket:{remoteAddress:'127.0.0.1'}});
  res.setHeader=()=>{};res.writeHead=status=>{res.status=status;};res.resume();
  const pending=h.api.handle(req,res);req.write('{"model"');await tick();
  const removed=await h.route('/api/conversations/'+old.id,'DELETE');req.end(':"sonnet","effort":"high"}');await pending;
  assert.equal(removed.status,200);assert.equal(res.status,404);assert.equal(h.api.loadConv(h.user,old.id),null);await tick();
});
test('H5 发送选择变化递增版本，相同选择续聊不制造新选择',async t=>{
  const h=fixture(t),old=seed(h,'a'.repeat(16),{model:'haiku',effort:'low',choiceRevision:7});
  let reply=await h.route('/api/chat','POST',{conversationId:old.id,message:'改用Sonnet',model:'sonnet',effort:'low'});assert.equal(reply.status,200);assert.equal(h.api.loadConv(h.user,old.id).choiceRevision,8);await end(h);
  reply=await h.route('/api/chat','POST',{conversationId:old.id,message:'同型号续聊'});assert.equal(reply.status,200);assert.equal(h.api.loadConv(h.user,old.id).choiceRevision,8);await end(h);
});
