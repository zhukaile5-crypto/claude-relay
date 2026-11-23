'use strict';
// Actual outer-Job cancellation, then account-local lease reclamation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createIsolation}=require('../isolation'),executor=require('../isolation/executor');
const root=path.resolve(__dirname,'..'),manifest=process.argv[2],output=process.argv[3];
if(!manifest||!output?.includes('codex-security-artifacts-'))throw Error('Explicit runtime and managed evidence required');
const stage=fs.mkdtempSync(path.join(root,'data','tex-cancel-')),user={id:'alice',workDir:path.join(stage,'alice')};fs.mkdirSync(user.workDir);
const config={users:[user],academicSearch:false,isolation:{enabled:true,runtimeManifest:manifest,privateRoot:path.join(stage,'private'),gptHome:path.join(stage,'gpt')}};
const importCompiler=String.raw`import importlib.util,sys,pathlib,os,time,json
p=pathlib.Path(r'C:\ClaudeRelayRuntime\tools\tex\compile_latex.py')
s=importlib.util.spec_from_file_location('relay_compile_test',p)
m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)
c=m._production_context()
`;
const delayCode=importCompiler+String.raw`
(c.workspace/'cancel.tex').write_text(r'\documentclass{article}\begin{document}SYNTHETIC\end{document}')
def delay(command,*,cwd,timeout,max_output):
 (c.workspace/'cancel-ready.json').write_text(json.dumps({'stage':cwd.name}))
 time.sleep(300)
m.compile_project(c,'cancel.tex',runner=delay)
`;
const holderCode=importCompiler+String.raw`
print('HOLDER_CONTEXT_READY',flush=True)
stage=c.scratch/'tex-abcdef0123456789abcd'
stage.mkdir();m._write_lease(stage)
print('HOLDER_LEASE_READY',flush=True)
(stage/'alive.txt').write_text('SYNTHETIC_ACTIVE')
(c.workspace/'holder-ready.json').write_text(json.dumps({'stage':stage.name}))
print('HOLDER_READY',flush=True)
time.sleep(300)
`;
const nextProgram=String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const base=process.env.RELAY_WORKSPACE,scratch=path.dirname(process.env.TEMP),checks={};
fs.writeFileSync(path.join(base,'normal.tex'),'\\documentclass{article}\\begin{document}SYNTHETIC CANCEL RECOVERY 42\\end{document}');
let holderError='';const active=cp.spawn(input.python,['-X','utf8','-I','-S','-c',input.holderCode],{windowsHide:true,stdio:['ignore','pipe','pipe']});
active.stdout.on('data',d=>{holderError=(holderError+d).slice(-5000);});active.stderr.on('data',d=>{holderError=(holderError+d).slice(-5000);});
try{
 const deadline=Date.now()+15000;while(!holderError.includes('HOLDER_READY')){if(active.exitCode!==null||Date.now()>deadline)throw Error('Active lease holder did not start: '+holderError);await new Promise(r=>setTimeout(r,100));}
 const holder='tex-abcdef0123456789abcd';
 const prior=input.cancelStage;
 checks.cancelledStageExistsBefore=fs.existsSync(path.join(scratch,prior));
 const compiled=cp.spawnSync(input.python,['-X','utf8','-I','-S',input.entry,'--source','normal.tex','--engine','pdflatex'],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
 let result;try{result=JSON.parse(compiled.stdout.trim());}catch{throw Error('Bad compiler output: '+compiled.stdout+' '+compiled.stderr);}
 if(compiled.status!==0)throw Error('Recovery compile failed: '+JSON.stringify(result));
 checks.deadStageReclaimed=!fs.existsSync(path.join(scratch,prior));
 checks.activeStagePreserved=fs.existsSync(path.join(scratch,holder,'alive.txt'))&&active.exitCode===null;
 checks.recoveryReported=result.recoveredStages>=1;
 checks.normalPdf=fs.readFileSync(path.join(base,'normal.pdf')).subarray(0,5).toString()==='%PDF-';
 active.kill();await new Promise(resolve=>{if(active.exitCode!==null)resolve();else active.once('exit',resolve);});
 const reclaimed=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c',input.importCompiler+'\nprint(m._reap_stages(c.scratch))'],{windowsHide:true,encoding:'utf8',timeout:15000});
 if(reclaimed.status!==0)throw Error('Final holder cleanup failed: '+reclaimed.stderr);
 checks.formerlyActiveStageReclaimed=!fs.existsSync(path.join(scratch,holder));
 checks.noStagesRemain=fs.readdirSync(scratch).filter(n=>/^tex-[a-f0-9]+$/.test(n)).length===0;
 process.stdout.write(JSON.stringify({checks,result}));
}finally{if(active.exitCode===null)active.kill();}
`;
(async()=>{let iso,cancelPromise;const started=Date.now(),evidence={stage,checks:{}};const abort=new AbortController();
 try{
  iso=createIsolation(config,stage);const ctx=iso.context(user);
  cancelPromise=executor.executeNode(ctx,"const cp=require('node:child_process');const r=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c',input.code],{windowsHide:true,encoding:'utf8',timeout:400000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status||0;",{input:{python:ctx.runtime.python,code:delayCode},signal:abort.signal,timeoutMs:400000,maxOutputBytes:5000});
  let ready=false,cancelStage;const until=Date.now()+30000;
  while(Date.now()<until){await new Promise(r=>setTimeout(r,300));try{cancelStage=JSON.parse(await iso.io.readBytes(ctx,'cancel-ready.json',{limitBytes:1000})).stage;ready=true;break;}catch{}}
  assert.ok(ready,'Cancelled fixture never acquired a stage lease');abort.abort();const cancelled=await cancelPromise;
  evidence.cancel={exitCode:cancelled.exitCode,cleanup:cancelled.cleanup,error:cancelled.error};
  evidence.checks.cancelledJobExited=cancelled.cleanup?.confirmedExited===true&&cancelled.cleanup?.pidAbsent===true;
  const value=await executor.executeNode(ctx,"try{\n"+nextProgram+"\n}catch(e){process.stdout.write(JSON.stringify({failure:e.message}));process.exitCode=1;}",{input:{python:ctx.runtime.python,entry:'C:\\ClaudeRelayRuntime\\tools\\tex\\compile_latex.py',holderCode,importCompiler,cancelStage},timeoutMs:180000,maxOutputBytes:20000});
  evidence.next={exitCode:value.exitCode,cleanup:value.cleanup,stderr:value.stderr,result:JSON.parse(value.stdout.toString())};
  assert.equal(value.exitCode,0,JSON.stringify(evidence.next));Object.assign(evidence.checks,evidence.next.result.checks);assert.ok(Object.values(evidence.checks).every(Boolean));
 }catch(error){evidence.failure=error.message;process.exitCode=1;}
 finally{abort.abort();if(cancelPromise)await cancelPromise.catch(()=>{});if(iso)await iso.closeAll();evidence.durationMs=Date.now()-started;fs.writeFileSync(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
})();
