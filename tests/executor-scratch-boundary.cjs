'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createIsolation}=require('../isolation'),executor=require('../isolation/executor');
const stage=path.resolve(process.argv[3]||''),manifest=path.resolve(process.argv[4]||'');
if(!path.basename(stage).startsWith('isolation-e2e-')||path.dirname(stage)!==path.resolve(__dirname,'../data')||!process.argv[2]?.includes('codex-security-artifacts-'))throw Error('Explicit synthetic stage and managed evidence required');
const users=['alice','bob'].map(id=>({id,workDir:path.join(stage,id)}));for(const user of users)fs.mkdirSync(user.workDir,{recursive:true});
const iso=createIsolation({users,isolation:{enabled:true,runtimeManifest:manifest,privateRoot:path.join(stage,'private'),gptHome:path.join(stage,'gpt')}},stage);
(async()=>{const result={checks:{}};try{
 const alice=iso.context(users[0]),bob=iso.context(users[1]);result.scratchRoot=alice.scratchRoot;
 result.checks.physicalRoot=!fs.lstatSync(alice.scratchRoot).isSymbolicLink()&&fs.realpathSync.native(alice.scratchRoot).toLowerCase()===alice.scratchRoot.toLowerCase();
 result.checks.distinctAccounts=alice.scratchRoot!==bob.scratchRoot;
 const prepared=await executor.executeNode(bob,"require('node:fs').writeFileSync(require('node:path').join(input.scratch,'synthetic-other.txt'),'SYNTHETIC_OTHER_SCRATCH');",{input:{scratch:bob.scratchRoot}});assert.equal(prepared.exitCode,0,prepared.error||prepared.stderr);
 const code=`const fs=require('node:fs'),path=require('node:path');const r={};function attempt(name,fn){try{fn();r[name]='ALLOWED';}catch(e){r[name]=e.code||'ERROR';}}
attempt('ownWrite',()=>fs.writeFileSync(path.join(input.own,'synthetic-own.txt'),'SYNTHETIC_OWN_SCRATCH'));
attempt('otherRead',()=>fs.readFileSync(path.join(input.other,'synthetic-other.txt')));
attempt('otherWrite',()=>fs.writeFileSync(path.join(input.other,'synthetic-other.txt'),'UNEXPECTED'));
attempt('baseList',()=>fs.readdirSync(path.dirname(input.own)));
attempt('baseWrite',()=>fs.writeFileSync(path.join(path.dirname(input.own),'UNEXPECTED_SHARED_FILE'),'UNEXPECTED'));
attempt('rootRename',()=>fs.renameSync(input.own,input.own+'-moved'));
r.tempIsOwn=process.env.TEMP===path.join(input.own,'temp');r.profileIsOwn=process.env.USERPROFILE===path.join(input.own,'profile');r.noKey=!process.env.CODEX_API_KEY;process.stdout.write(JSON.stringify(r));`;
 const r=await executor.executeNode(alice,code,{input:{own:alice.scratchRoot,other:bob.scratchRoot},maxOutputBytes:3000});assert.equal(r.exitCode,0,r.error||r.stderr);result.worker=JSON.parse(r.stdout);
 result.checks.ownWritable=result.worker.ownWrite==='ALLOWED';for(const name of ['otherRead','otherWrite','baseList','baseWrite','rootRename'])result.checks[name+'Denied']=result.worker[name]!=='ALLOWED';
 result.checks.correctTemp=result.worker.tempIsOwn;result.checks.correctProfile=result.worker.profileIsOwn;result.checks.noKey=result.worker.noKey;
 const verified=await executor.executeNode(bob,"process.stdout.write(require('node:fs').readFileSync(require('node:path').join(input.scratch,'synthetic-other.txt'),'utf8'));",{input:{scratch:bob.scratchRoot},maxOutputBytes:200});result.checks.otherUnchanged=verified.exitCode===0&&verified.stdout.toString()==='SYNTHETIC_OTHER_SCRATCH';
 for(const ctx of [alice,bob])await executor.executeNode(ctx,"const fs=require('node:fs'),p=require('node:path');for(const name of ['synthetic-own.txt','synthetic-other.txt'])fs.rmSync(p.join(input.scratch,name),{force:true});",{input:{scratch:ctx.scratchRoot}});
 assert.ok(Object.values(result.checks).every(Boolean));
 }finally{await iso.closeAll();if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})().catch(e=>{console.error(e);process.exitCode=1;});
