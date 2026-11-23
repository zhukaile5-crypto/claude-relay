'use strict';
// Real Node-only check of an existing, explicitly named synthetic D: fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const executor=require('../isolation/executor');
const stage=process.argv[2],manifest=process.argv[3],output=process.argv[4];
if(!stage||!path.basename(stage).startsWith('isolation-e2e-')||path.dirname(stage)!==path.resolve(__dirname,'../data'))throw Error('Explicit synthetic stage required');
if(!output?.includes('codex-security-artifacts-'))throw Error('Managed evidence output required');
const launches=[],original=executor.executeNodeSync;
executor.executeNodeSync=(...args)=>{const result=original(...args);launches.push({exitCode:result.exitCode,error:result.error,stderr:result.stderr,cleanup:result.cleanup});return result;};
const {createIsolation}=require('../isolation');
(async()=>{
 const config={users:[{id:'alice',workDir:path.join(stage,'alice')}],isolation:{enabled:true,runtimeManifest:manifest,privateRoot:path.join(stage,'private'),gptHome:path.join(stage,'gpt')}};
 let iso;const result={stage,manifest,checks:{},launches};
 try{
  iso=createIsolation(config,stage);const u=config.users[0],ctx=iso.context(u);
  result.checks.contextReady=true;
  const program="const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('synthetic-drive-test.txt','DRIVE_OK');const child=cp.spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({cwd:process.cwd(),temp:process.env.TEMP}))'],{windowsHide:true,encoding:'utf8'});const py=cp.spawnSync(input.python,['-I','-S','-c','import os,json;print(json.dumps({\"cwd\":os.getcwd(),\"text\":open(\"synthetic-drive-test.txt\").read()}))'],{windowsHide:true,encoding:'utf8'});process.stdout.write(JSON.stringify({cwd:process.cwd(),real:fs.realpathSync.native(process.cwd()),temp:process.env.TEMP,childStatus:child.status,child:child.stdout,childError:child.error?.message,pythonStatus:py.status,python:py.stdout,pythonError:py.stderr,text:fs.readFileSync('synthetic-drive-test.txt','utf8')}));";
  const r=await executor.executeNode(ctx,program,{input:{python:ctx.runtime.python},timeoutMs:20000,maxOutputBytes:3000});
  result.worker={...r,stdout:r.stdout.toString()};assert.equal(r.exitCode,0,r.error||r.stderr);
  const value=JSON.parse(r.stdout);result.checks.workingDirectory=value.cwd.toLowerCase()===ctx.executionRoot.toLowerCase();result.checks.originalPhysicalRoot=value.real.toLowerCase()===ctx.workspaceRoot.toLowerCase();result.checks.workerTemp=value.temp.toLowerCase()===ctx.workerEnv.TEMP.toLowerCase();result.checks.childStatus=value.childStatus===0;result.checks.data=value.text==='DRIVE_OK';
  const child=JSON.parse(value.child);result.checks.childWorkingDirectory=child.cwd.toLowerCase()===ctx.executionRoot.toLowerCase();result.checks.childTemp=child.temp.toLowerCase()===ctx.workerEnv.TEMP.toLowerCase();result.checks.pythonStatus=value.pythonStatus===0;result.checks.pythonData=JSON.parse(value.python).text==='DRIVE_OK';
  result.checks.syncRead=iso.io.readTextSync(ctx,'synthetic-drive-test.txt')==='DRIVE_OK';
  iso.io.removeSync(ctx,'synthetic-drive-test.txt');assert.ok(Object.values(result.checks).every(Boolean));
 }catch(error){result.failure={message:error.message,stack:error.stack};process.exitCode=1;}
 finally{if(iso)await iso.closeAll();fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})();
