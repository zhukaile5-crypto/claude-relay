'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createIsolation}=require('../isolation'),executor=require('../isolation/executor');
const stage=path.resolve(process.argv[3]||''),manifest=path.resolve(process.argv[4]||'');
if(!path.basename(stage).startsWith('isolation-e2e-')||path.dirname(stage)!==path.resolve(__dirname,'../data')||!process.argv[2]?.includes('codex-security-artifacts-'))throw Error('Explicit synthetic stage and managed evidence required');
const user={id:'alice',workDir:path.join(stage,'alice')};fs.mkdirSync(user.workDir,{recursive:true});
const config={users:[user],isolation:{enabled:true,runtimeManifest:manifest,privateRoot:path.join(stage,'private'),gptHome:path.join(stage,'gpt')}};
const iso=createIsolation(config,stage),ctx=iso.context(user),nonce=crypto.randomBytes(8).toString('hex');
const sibling=path.join(stage,'bob'),outside=path.join(sibling,'view-canary-'+nonce+'.txt');fs.mkdirSync(sibling,{recursive:true});fs.writeFileSync(outside,'SYNTHETIC_OUTSIDE_CANARY',{flag:'wx'});
const otherHash=path.join(path.dirname(path.dirname(ctx.executionRoot)),'fixture-'+nonce);fs.mkdirSync(otherHash);const otherFile=path.join(otherHash,'canary.txt');fs.writeFileSync(otherFile,'SYNTHETIC_OTHER_ACCOUNT');
const probeFolder='.work/view-negative-'+nonce;iso.io.mkdirSync(ctx,probeFolder);
const expected=ctx.workspaceRoot.toLowerCase(),results={checks:{},tamper:[]};
function removeView(){const st=fs.lstatSync(ctx.executionRoot);if(st.isSymbolicLink())fs.unlinkSync(ctx.executionRoot);else if(st.isDirectory()){assert.equal(fs.realpathSync.native(ctx.executionRoot).toLowerCase(),ctx.executionRoot.toLowerCase());assert.equal(path.basename(ctx.executionRoot),'view');fs.rmSync(ctx.executionRoot,{recursive:true});}else throw Error('Unexpected synthetic view object');}
function restoreView(){try{removeView();}catch(e){if(e.code!=='ENOENT')throw e;}fs.symlinkSync(ctx.workspaceRoot,ctx.executionRoot,'junction');assert.equal(fs.realpathSync.native(ctx.executionRoot).toLowerCase(),expected);}
(async()=>{try{
 const program=`const fs=require('node:fs'),path=require('node:path');const result={};function attempt(name,fn){try{fn();result[name]='ALLOWED';}catch(e){result[name]=e.code||'ERROR';}}
attempt('ownWrite',()=>fs.writeFileSync(input.own,'SYNTHETIC_OWN'));
attempt('unlinkView',()=>fs.unlinkSync(input.view));attempt('renameView',()=>fs.renameSync(input.view,input.view+'-moved'));
attempt('parentWrite',()=>fs.writeFileSync(path.join(path.dirname(input.view),'new-'+input.nonce),'UNEXPECTED'));
attempt('parentJunction',()=>fs.symlinkSync(input.sibling,path.join(path.dirname(input.view),'new-link-'+input.nonce),'junction'));
attempt('outsideRead',()=>fs.readFileSync(input.outside));attempt('otherHashRead',()=>fs.readFileSync(input.otherFile));attempt('sharedBaseList',()=>fs.readdirSync(path.dirname(path.dirname(input.view))));
const escape=path.join(process.cwd(),input.escape);attempt('escapeLinkCreate',()=>fs.symlinkSync(input.sibling,escape,'junction'));
attempt('escapeRead',()=>fs.readFileSync(path.join(escape,path.basename(input.outside))));try{fs.unlinkSync(escape);}catch{}
result.apiKeyAbsent=process.env.CODEX_API_KEY===undefined;process.stdout.write(JSON.stringify(result));`;
 const r=await executor.executeNode(ctx,program,{input:{view:ctx.executionRoot,own:probeFolder+'/own.txt',escape:probeFolder+'/escape',outside,otherFile,sibling,nonce},maxOutputBytes:4000});assert.equal(r.exitCode,0,r.error||r.stderr);results.worker=JSON.parse(r.stdout);
 results.checks.ownWrite=results.worker.ownWrite==='ALLOWED';for(const name of ['unlinkView','renameView','parentWrite','parentJunction','outsideRead','otherHashRead','sharedBaseList','escapeRead'])results.checks[name+'Denied']=results.worker[name]!=='ALLOWED';results.checks.apiKeyAbsent=results.worker.apiKeyAbsent;
 assert.equal(fs.realpathSync.native(ctx.executionRoot).toLowerCase(),expected);
 for(const [scenario,target] of [['deleted',null],['insideDifferentDirectory',path.join(ctx.workspaceRoot,probeFolder)],['otherWorkspace',sibling],['dangling',path.join(sibling,'missing-'+nonce)],['regularDirectory','directory']]){
  removeView();if(target==='directory')fs.mkdirSync(ctx.executionRoot);else if(target)fs.symlinkSync(target,ctx.executionRoot,'junction');
  try{
   assert.equal(iso.context(user),ctx);const check=await executor.executeNode(ctx,"process.stdout.write('UNEXPECTED_REQUEST_CODE_RAN')",{timeoutMs:10000,maxOutputBytes:2000});
   const blocked=check.exitCode!==0&&!check.stdout.toString().includes('UNEXPECTED_REQUEST_CODE_RAN');results.tamper.push({scenario,blocked,error:check.error,stderr:check.stderr});assert.ok(blocked);
   // 新进程遇到被删除的视图会重建，但只能指向本账号工作区；被改向或悬空的视图必须拒绝。
   const fresh=createIsolation(config,stage);try{if(scenario==='deleted')assert.equal(fs.realpathSync.native(fresh.context(user).executionRoot).toLowerCase(),expected);else assert.throws(()=>fresh.context(user));}finally{await fresh.closeAll();}
  }finally{restoreView();}
 }
 results.checks.cachedContextTamperBlocked=results.tamper.every(t=>t.blocked);
 const final=await executor.executeNode(ctx,"process.stdout.write('RESTORED_OK')",{maxOutputBytes:200});results.restored={exitCode:final.exitCode,error:final.error,stderr:final.stderr,stdout:final.stdout.toString()};results.checks.restored=final.exitCode===0&&final.stdout.toString()==='RESTORED_OK';assert.ok(Object.values(results.checks).every(Boolean));
}finally{
 restoreView();iso.io.removeSync(ctx,probeFolder,{recursive:true});fs.unlinkSync(outside);fs.unlinkSync(otherFile);fs.rmdirSync(otherHash);await iso.closeAll();
 const result={executionRoot:ctx.executionRoot,workspaceRoot:ctx.workspaceRoot,...results};if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}})().catch(e=>{console.error(e);process.exitCode=1;});
