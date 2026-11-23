'use strict';
// Starts only the synthetic HTTP fixture, verifies its real gate and readiness,
// then stops it. No model prompt is submitted and no production listener changes.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),manifest=path.resolve(process.argv[2]||''),output=path.resolve(process.argv[3]||'');
if(!output.includes('codex-security-artifacts-'))throw Error('Managed output path required');
const stage=fs.mkdtempSync(path.join(root,'data','isolation-e2e-'));
(async()=>{const started=Date.now(),result={stage,checks:{}},child=cp.fork(path.join(__dirname,'server-isolation-e2e.cjs'),['--serve',stage,manifest],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let stderr='';
 child.stdout.on('data',()=>{});child.stderr.on('data',d=>stderr=(stderr+d).slice(-6000));
 try{
  let serverStarted;
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic startup timed out')),90000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('Synthetic startup exited '+code+': '+stderr));});child.on('message',m=>{if(m?.harnessReady&&serverStarted===undefined)serverStarted=Date.now();if(m?.ready){clearTimeout(timer);resolve(m.port);}});});
  const health=await fetch('http://127.0.0.1:'+port+'/');await health.arrayBuffer();result.checks.healthy=health.status===200;
  // 计时只算服务本身，夹具准备另记；缺少夹具标记时判失败。
  assert.ok(serverStarted!==undefined,'Harness readiness marker missing');result.harnessMs=serverStarted-started;result.healthMs=Date.now()-serverStarted;result.checks.historyColdStartWithinDeadline=result.healthMs<20000;
  const power=await fetch('http://127.0.0.1:'+port+'/local/power');const state=await power.json();result.checks.noModelJobs=power.status===200&&state.running===0;
  const ticket=JSON.parse(fs.readFileSync(path.join(stage,'synthetic-acceptance.json'),'utf8'));result.checks.realGateReceipt=ticket.schema===2&&ticket.purpose==='synthetic-fixture-only'&&ticket.fingerprints.length>0;
  const deadline=Date.now()+30000;let complete=false;
  while(Date.now()<deadline){try{complete=['alice','bob'].every(id=>fs.readFileSync(path.join(stage,id,'.memory','chats','face000000000031.md'),'utf8').includes('SYNTHETIC_HISTORY_ANSWER_49'));}catch{}if(complete)break;await new Promise(resolve=>setTimeout(resolve,100));}
  result.checks.missingHistoryBackfilled=complete;result.history={records:100,existing:80,missing:20};
  result.checks.existingHistoryUnchanged=['alice','bob'].every(id=>Array.from({length:40},(_,i)=>i).every(i=>fs.readFileSync(path.join(stage,id,'.memory','chats','face'+i.toString(16).padStart(12,'0')+'.md'),'utf8')==='SYNTHETIC_EXISTING_TRANSCRIPT_'+i));
  result.fingerprintCount=ticket.fingerprints.length;assert.ok(Object.values(result.checks).every(Boolean));
 }catch(e){result.failure={message:e.message};process.exitCode=1;}
 finally{
  if(child.exitCode===null){child.send({stop:true});const stopped=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),10000);child.once('exit',()=>{clearTimeout(timer);resolve(true);});});result.checks.stopped=stopped;if(!stopped){child.kill();process.exitCode=1;}}
  // 通过时删掉合成工作目录，失败时保留供排查；子进程没退出就不删
  if(!result.failure&&!process.exitCode&&child.exitCode!==null){const c=require('../tools/acceptance-stage.cjs').removeStage(root,stage);result.stageRemoved=c.removed;if(c.error)result.stageCleanupError=c.error;}else result.stageRemoved=false;
  result.durationMs=Date.now()-started;fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
