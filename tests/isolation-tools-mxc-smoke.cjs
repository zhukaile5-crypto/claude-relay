'use strict';
// Explicit synthetic integration check; requires an existing managed fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const executor=require('../isolation/executor');
const {createWorkspaceIO}=require('../isolation/workspace-io');
const {createBroker,relative}=require('../isolation/mcp');
(async()=>{
 const source=path.resolve(process.argv[2]||'');
 if(path.basename(source)!=='executor-smoke-result.json'||!source.includes('codex-security-artifacts-'))throw Error('Managed synthetic fixture required');
 const {context}=JSON.parse(fs.readFileSync(source,'utf8'));
 if(!context.workspaceRoot.includes('executor-')||!context.workspaceRoot.includes('codex-security-artifacts-'))throw Error('Synthetic workspace required');
 context.runtime={gitBash:'C:\\Program Files\\Git\\bin\\bash.exe',skills:{}};
 const broker=createBroker(context),io=createWorkspaceIO(executor),prefix='broker-smoke-'+crypto.randomBytes(6).toString('hex'),checks={};
 const call=(name,args)=>broker.call(name,args);
 const txt=result=>result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 const started=Date.now();let failure;
 try{
  await call('Write',{file_path:prefix+'/中文.txt',content:'原来的文字\nline42'});
  assert.match(txt(await call('Read',{file_path:prefix+'/中文.txt',offset:2,limit:1})),/^2: line42$/);checks.readWrite=true;
  await call('Edit',{file_path:prefix+'/中文.txt',old_string:'原来的',new_string:'更新的'});
  assert.match(txt(await call('Read',{file_path:prefix+'/中文.txt'})),/更新的文字/);checks.edit=true;
  assert.match(txt(await call('Glob',{pattern:'*.txt',path:prefix})),/中文/);
  assert.match(txt(await call('Grep',{pattern:'line42',path:prefix})),/line42/);checks.search=true;
  assert.throws(()=>relative(context,'../private.txt'));assert.throws(()=>relative(context,'file.txt:alternate'));
  await assert.rejects(call('Read',{file_path:'../private.txt'}));checks.escapeDenied=true;
  const shell=JSON.parse(txt(await call('PowerShell',{command:"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Write-Output '隔离42'",timeout:10000})));
  assert.equal(shell.exitCode,0);assert.match(shell.stdout,/隔离42/);checks.shellUnicode=true;
  assert.match(txt(await call('TaskCreate',{subject:'合成任务'})),/#1/);await call('TaskUpdate',{taskId:'1',status:'completed'});
  assert.equal(JSON.parse(txt(await call('TaskList',{})))[0].status,'completed');checks.liveTasks=true;
  await assert.rejects(call('Skill',{skill:'../../secret'}));checks.skillAllowlist=true;
  await assert.rejects(call('PowerShell',{command:'echo nope',exe:'cmd.exe'}));checks.fixedSchema=true;
  const size=500*1024*1024,chunk=Buffer.alloc(1024*1024,0x5a),expected=crypto.createHash('sha256');
  async function* bytes(){for(let i=0;i<500;i++){expected.update(chunk);yield chunk;}}
  const uploadAt=Date.now(),uploaded=await io.writeFromStream(context,prefix+'/large.bin',Readable.from(bytes()),{limitBytes:size,timeoutMs:120000});
  assert.equal(uploaded.size,size);
  const verified=await executor.executeNode(context,"const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256'),s=fs.createReadStream(input.file);for await(const b of s)h.update(b);process.stdout.write(h.digest('hex'));",{input:{file:prefix+'/large.bin'},timeoutMs:120000});
  assert.equal(verified.exitCode,0);assert.equal(verified.stdout.toString(),expected.digest('hex'));checks.upload500MiB={bytes:size,durationMs:Date.now()-uploadAt,hashVerified:true};
 }catch(error){failure={message:error.message,stack:error.stack};process.exitCode=1;}
 finally{try{io.removeSync(context,prefix,{recursive:true,force:true});checks.cleaned=true;}catch(error){failure={message:error.message};process.exitCode=1;}await executor.closeAll();}
 const result={checks,failure,durationMs:Date.now()-started};
 const output=path.join(path.dirname(source),'isolation-tools-mxc-result.json');fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
