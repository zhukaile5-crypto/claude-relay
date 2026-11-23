'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
const {createDrain}=require('../tools/maintenance-drain.cjs');
const block=source.slice(source.indexOf('function chatTranscriptText('),source.indexOf('// ---------- 项目 ----------'));
function harness(count=100,existing=80){
 const user={id:'synthetic',profile:'owner',workDir:'C:\\synthetic',chatsDir:'C:\\synthetic\\.memory\\chats'},records=[],stored=new Map(),calls=[],logs=[];
 const relative=i=>'.memory/chats/'+i.toString(16).padStart(16,'0')+'.md';
 for(let i=0;i<count;i++){records.push({id:i.toString(16).padStart(16,'0'),title:'Synthetic '+i,createdAt:1,messages:[{role:'user',text:'Synthetic question '+i},{role:'assistant',model:'haiku',events:[{k:'text',text:'Synthetic answer '+i}]}]});if(i<existing)stored.set(relative(i),'UNCHANGED_'+i);}
 const context={Buffer,Date,path:path.win32,config:{isolation:{enabled:true}},USERS:new Map([[user.id,user]]),memoryEnabled:()=>true,listConvs:()=>records,loadConv:(u,id)=>records.find(c=>c.id===id),toRel:(u,p)=>path.win32.relative(u.workDir,p).replace(/\\/g,'/'),providerOf:m=>m==='gpt'?'openai':'anthropic',modelName:()=> 'GPT',console:{log:m=>logs.push(m)},fs:new Proxy({},{get(){throw Error('Host workspace filesystem access forbidden');}}),workWrite:()=>{throw Error('Per-record sync worker forbidden');}};
 context.isolation={context:u=>({user:u}),io:{batch:async(ctx,operations)=>{calls.push(operations);return operations.map(op=>{if(op.type==='stat')return stored.has(op.path)?{ok:true,value:{isFile:true}}:{ok:false,error:{code:'ENOENT'}};assert.equal(op.type,'writeText');assert.equal(op.exclusive,true);assert.equal(op.parents,true);if(stored.has(op.path))return {ok:false,error:{code:'EEXIST'}};stored.set(op.path,op.text);return {ok:true,value:{path:op.path}};});}}};
 vm.runInNewContext(block+'\nglobalThis.api={backfillIsolatedTranscripts,chatTranscriptText,stop:()=>{transcriptBackfillStopped=true}};',context);
 return {context,user,records,stored,calls,logs,relative,...context.api};
}
test('100 historical transcripts use two asynchronous batches and preserve existing text',async()=>{
 const h=harness(),before=new Map(h.stored),summary=await h.backfillIsolatedTranscripts();
 assert.equal(h.calls.length,2);assert.equal(h.calls[0].length,100);assert.equal(h.calls[1].length,20);
 assert.deepEqual(JSON.parse(JSON.stringify(summary)),{checked:100,written:20,raced:0});
 for(const [name,text]of before)assert.equal(h.stored.get(name),text);
 assert.match(h.stored.get(h.relative(99)),/Synthetic question 99[\s\S]*Synthetic answer 99/);
});
test('large history splits checks at 256 and writes at 32 records',async()=>{
 const h=harness(300,0);await h.backfillIsolatedTranscripts();
 const checks=h.calls.filter(c=>c[0].type==='stat'),writes=h.calls.filter(c=>c[0].type==='writeText');
 assert.deepEqual(checks.map(c=>c.length),[256,44]);assert.equal(writes.length,10);assert.ok(writes.every(c=>c.length<=32));assert.equal(h.stored.size,300);
});
test('large transcript texts split write payloads at the one MiB target',async()=>{
 const h=harness(3,0);for(const c of h.records)c.messages[1].events[0].text='S'.repeat(600000);
 await h.backfillIsolatedTranscripts();const writes=h.calls.filter(c=>c[0].type==='writeText');
 assert.equal(writes.length,3);assert.ok(writes.every(c=>c.length===1&&Buffer.byteLength(c[0].text)<1024*1024));
});
test('exclusive backfill preserves a transcript completed after the initial check',async()=>{
 const h=harness(2,0),original=h.context.isolation.io.batch;
 h.context.isolation.io.batch=async(ctx,ops)=>{const rows=await original(ctx,ops);if(ops[0].type==='stat')h.stored.set(h.relative(0),'NEWLY_COMPLETED_TRANSCRIPT');return rows;};
 const summary=await h.backfillIsolatedTranscripts();assert.equal(summary.raced,1);assert.equal(h.stored.get(h.relative(0)),'NEWLY_COMPLETED_TRANSCRIPT');assert.equal(h.logs.length,0);
});
test('unexpected batch write errors surface and never use host fallbacks',async()=>{
 const h=harness(2,0),original=h.context.isolation.io.batch;
 h.context.isolation.io.batch=async(ctx,ops)=>ops[0].type==='stat'?original(ctx,ops):[{ok:false,error:{code:'EPERM'}},{ok:false,error:{code:'OUTPUT_TOO_LARGE'}}];
 await h.backfillIsolatedTranscripts();assert.equal(h.logs.length,1);assert.match(h.logs[0],/EPERM.*OUTPUT_TOO_LARGE/);assert.equal(h.stored.size,0);
});
test('shutdown stops new backfill work after an in-flight check',async()=>{
 const h=harness(100,0),original=h.context.isolation.io.batch;
 h.context.isolation.io.batch=async(ctx,ops)=>{const rows=await original(ctx,ops);h.stop();return rows;};
 await h.backfillIsolatedTranscripts();assert.equal(h.calls.length,1);assert.equal(h.stored.size,0);
});
test('transcript formatting retains attachments, provider labels and file paths',()=>{
 const h=harness(0,0),text=h.chatTranscriptText(h.user,{title:'Synthetic title',createdAt:1,messages:[{role:'user',text:'Question',attachments:[{path:'uploads/a.png'}]},{role:'assistant',model:'gpt',result:'Answer',files:[{path:'outputs/b.pdf'}]}]});
 assert.match(text,/^# Synthetic title\n日期：/);assert.match(text,/## 机主说\nQuestion\n（附件：uploads\/a.png）/);assert.match(text,/## GPT\nAnswer\n（文件：outputs\/b.pdf）/);
});
test('isolated listening callback starts normal services before scheduling backfill',()=>{
 const start=source.indexOf('  // 补齐以前对话的文字版'),end=source.indexOf('\n});',start),calls=[],scheduled=[];
 const code=source.slice(start,end);vm.runInNewContext(code,{maintenanceDrain:createDrain(),isolationBlocked:null,USERS:new Map(),refreshSnap(){},config:{isolation:{enabled:true}},cleanParts:()=>calls.push('parts'),ensureCodexLogin:()=>calls.push('login'),startTunnel:()=>calls.push('tunnel'),setImmediate:f=>scheduled.push(f),backfillIsolatedTranscripts:()=>calls.push('backfill'),console});
 assert.deepEqual(calls,['parts','login','tunnel']);assert.equal(scheduled.length,1);scheduled[0]();assert.equal(calls.at(-1),'backfill');
});
