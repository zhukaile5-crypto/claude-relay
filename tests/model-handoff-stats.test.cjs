'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./model-server-fixture.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
async function end(h) {for(const call of h.calls.filter(c=>['claude','codex'].includes(c.kind)&&c.child.exitCode===null)){call.child.exitCode=0;call.child.emit('close',0);}await tick();await tick();}
function seed(h,model='haiku') {const conv={id:'a'.repeat(16),title:'合成交接',titled:true,createdAt:1,messages:[{role:'user',text:'USER_PRIVATE_SYNTHETIC'},{role:'assistant',model,status:'done',result:'ANSWER_PRIVATE_SYNTHETIC',events:[{k:'tool',id:'1',name:'Write',summary:'PRIVATE_PATH.txt'}],files:[{path:'PRIVATE_PATH.txt',size:2}]}]};h.api.saveConv(h.user,conv);return conv;}
test('H6 提供方变化时回答在启动前保存统计，ack 与重载同值且无交接正文/路径',async t=>{
 const h=fixture(t),conv=seed(h);const r=await h.route('/api/chat','POST',{conversationId:conv.id,message:'接着做',model:'gpt-6-luna',effort:'low'});assert.equal(r.status,200);
 const stats=r.body.handoff;assert.deepEqual(Object.keys(stats).sort(),['from','turns','tools','files','chars','truncated','recovered'].sort());
 assert.equal(stats.from,'haiku');assert.equal(stats.turns,1);assert.equal(stats.tools,1);assert.equal(stats.files,1);assert.ok(stats.chars>0);assert.equal(stats.recovered,false);
 assert.doesNotMatch(JSON.stringify(stats),/PRIVATE|平台交接记录/);
 const reloaded=await h.route('/api/conversations/'+conv.id);assert.deepEqual(reloaded.body.messages.at(-1).handoff,stats);assert.equal(reloaded.body.messages.at(-1).status,'running');await end(h);
});
test('H6 同提供方换型号和首轮均不保存交接线，正常回复内容不受影响',async t=>{
 const h=fixture(t),conv=seed(h);let r=await h.route('/api/chat','POST',{conversationId:conv.id,message:'同提供方',model:'sonnet',effort:'low'});assert.equal(r.status,200);assert.equal(r.body.handoff,undefined);await end(h);
 r=await h.route('/api/chat','POST',{message:'首轮',model:'gpt-6-luna',effort:'low'});assert.equal(r.status,200);assert.equal(r.body.handoff,undefined);await end(h);
});
