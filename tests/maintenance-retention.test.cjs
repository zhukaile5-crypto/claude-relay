'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {cleanup,boundedLogger,readJsonRecord}=require('../tools/maintenance-retention.cjs'),gate=require('../tools/check-isolation.cjs');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-retain-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^relay-retain-/);assert.equal((await fs.lstat(root)).isSymbolicLink(),false);assert.equal((await fs.realpath(root)).toLowerCase(),root.toLowerCase());await fs.rm(root,{recursive:true,force:true});});
  const receiptDir=path.join(root,'isolation'),maintenanceDir=path.join(root,'maintenance');await fs.mkdir(receiptDir);await fs.mkdir(maintenanceDir);
  const receipt=path.join(receiptDir,'acceptance.json'),write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
  const validReceipt=(evidence=[])=>({schema:2,completedAt:'2026-11-01T00:00:00.000Z',configurationFingerprint:'a'.repeat(64),
    checks:Object.fromEntries(gate.REQUIRED.map(name=>[name,{passed:true,...(name==='filesystemDeny'?{evidence}: {})}])),
    fingerprints:[{path:path.join(root,'synthetic-program.exe'),sha256:'b'.repeat(64)}]});
  await write(receipt,validReceipt());
  const runtimeContext={state:path.join(maintenanceDir,'version-check.json'),receipt,programs:[{name:'Claude',root:path.join(root,'pinned.exe')}]};
  return{root,receipt,receiptDir,maintenanceDir,write,validReceipt,runtimeContext,options:{receipt,maintenanceDir,runtimeContext,keepBackups:2,keepEvidence:1,keepCheckpoints:1,maintenanceLockHeld:true,activeDownloads:0}};
}
async function backups(f){for(let i=0;i<4;i++)await f.write(f.receipt+'.before-'+i,f.validReceipt());}
async function assertBackups(f){assert.equal((await fs.readdir(f.receiptDir)).filter(name=>name.startsWith('acceptance.json.before-')).length,4);}
test('M14 正式记录引用的旧证据受保护，未引用旧证据与旧备份有界清理',async t=>{
  const f=await fixture(t);
  for(let i=0;i<6;i++){const dir=path.join(f.receiptDir,'codex-security-artifacts-refresh-'+i);await f.write(path.join(dir,'result.json'),{});await fs.utimes(dir,new Date(i*1000),new Date(i*1000));const backup=f.receipt+'.before-'+i;await f.write(backup,f.validReceipt());await fs.utimes(backup,new Date(i*1000),new Date(i*1000));}
  const protectedFile=path.join(f.receiptDir,'codex-security-artifacts-refresh-0','result.json');await f.write(f.receipt,f.validReceipt([protectedFile]));
  const r=await cleanup(f.options);assert.ok(r.removed>=8);await fs.access(protectedFile);const names=await fs.readdir(f.receiptDir);
  assert.equal(names.filter(x=>x.startsWith('acceptance.json.before-')).length,2);assert.equal(names.filter(x=>x.startsWith('codex-security-artifacts-')).length,2);
});
test('M14 保留快照与回退事务引用的证据不能删',async t=>{
  const f=await fixture(t),id='a'.repeat(32),folder=path.join(f.maintenanceDir,'transactions',id),evidence=path.join(f.receiptDir,'codex-security-artifacts-candidate-old','result.json');
  await f.write(evidence,{});await f.write(path.join(folder,'receipt.before.json'),f.validReceipt([evidence]));
  const programRoot=f.runtimeContext.programs[0].root,transaction={schema:1,id,program:'Claude',programRoot,receipt:f.receipt,backup:path.join(folder,'receipt.before.json'),outputReceipt:path.join(folder,'receipt.candidate.json'),
    oldVersion:'2.1.314',oldProgramHash:'a'.repeat(64),candidateHash:'b'.repeat(64),receiptHash:'c'.repeat(64),acceptedReceiptHash:'d'.repeat(64)};
  const state={schema:1,chain:[{id,phase:'pending-commit',at:1,newVersion:'2.1.320',transaction,beforeWorld:{Claude:{root:programRoot,hash:transaction.oldProgramHash}},afterWorld:{Claude:{root:programRoot,hash:transaction.candidateHash}}}],counters:{},processed:[],authNotified:{},rollback:null,pendingNotice:null};
  await f.write(path.join(f.maintenanceDir,'runtime-upgrades.json'),state);
  await cleanup({...f.options,keepEvidence:0});await fs.access(evidence);await fs.access(transaction.backup);
});
test('M14 当前可用快照即使较旧也保留，其引用证据受保护',async t=>{
  const f=await fixture(t),lastGood=path.join(f.maintenanceDir,'last-good'),old='a'.repeat(32),newer='b'.repeat(32);
  const evidence=path.join(f.receiptDir,'codex-security-artifacts-refresh-checkpoint','result.json');await f.write(evidence,{});
  await f.write(path.join(lastGood,old,'acceptance.json'),f.validReceipt([evidence]));await f.write(path.join(lastGood,newer,'acceptance.json'),f.validReceipt());
  await fs.utimes(path.join(lastGood,old),new Date(1000),new Date(1000));await fs.utimes(path.join(lastGood,newer),new Date(2000),new Date(2000));
  await f.write(path.join(lastGood,'current.json'),{schema:1,generation:old});
  await cleanup({...f.options,keepEvidence:0});await fs.access(path.join(lastGood,old,'acceptance.json'));await fs.access(evidence);
});
test('M14 可用快照指针损坏或指向缺失目录时不能清理',async t=>{
  const f=await fixture(t);await backups(f);const pointer=path.join(f.maintenanceDir,'last-good','current.json');
  await f.write(pointer,{generation:'a'.repeat(32)});await assert.rejects(cleanup(f.options),/指针无效/);await assertBackups(f);
  await f.write(pointer,{schema:1,generation:'a'.repeat(32)});await assert.rejects(cleanup(f.options),{code:'ENOENT'});await assertBackups(f);
});
test('M14 损坏状态先拒绝，不能先删除其他备份',async t=>{
  const f=await fixture(t);await backups(f);await fs.writeFile(path.join(f.maintenanceDir,'runtime-upgrades.json'),'{bad');
  await assert.rejects(cleanup(f.options),/JSON/);await assertBackups(f);
});
test('M14 可解析但语义损坏的正式验收记录完全阻止清理',async t=>{
  for(const broken of [null,{}, {schema:2}, {type:'another-record'}]){
    const f=await fixture(t);await backups(f);await f.write(f.receipt,broken);
    await assert.rejects(cleanup(f.options),/结构损坏/);await assertBackups(f);
  }
  const f=await fixture(t);await backups(f);
  for(const change of [r=>{r.schema=1;},r=>{r.completedAt='bad';},r=>{r.checks.pdf.passed='true';},r=>{delete r.checks.parentDeath;},r=>{r.fingerprints[0].sha256='bad';},r=>{r.fingerprints[0].path='relative.exe';}]){
    const value=f.validReceipt();change(value);await f.write(f.receipt,value);await assert.rejects(cleanup(f.options),/结构损坏/);await assertBackups(f);
  }
});
test('M14 旧备份、可用快照、事务记录语义损坏也在任何删除前拒绝',async t=>{
  for(const kind of ['backup','checkpoint','transaction']){
    const f=await fixture(t);await backups(f);let target;
    if(kind==='backup')target=f.receipt+'.before-old';
    if(kind==='checkpoint')target=path.join(f.maintenanceDir,'last-good','b'.repeat(32),'acceptance.json');
    if(kind==='transaction')target=path.join(f.maintenanceDir,'transactions','b'.repeat(32),'receipt.before.json');
    await f.write(target,{});await assert.rejects(cleanup(f.options),/结构损坏/);
    assert.equal((await fs.readdir(f.receiptDir)).filter(name=>name.startsWith('acceptance.json.before-')).length,kind==='backup'?5:4);
  }
});
test('M14 运行链结构损坏、未知状态或缺少可信上下文均拒绝',async t=>{
  const f=await fixture(t);await backups(f);const file=path.join(f.maintenanceDir,'runtime-upgrades.json');
  for(const broken of [{},null,{schema:1,chain:'bad',counters:{},processed:[],authNotified:{}}]){await f.write(file,broken);await assert.rejects(cleanup(f.options),/runtime-state-invalid/);await assertBackups(f);}
  await f.write(file,{schema:1,chain:[],counters:{},processed:[],authNotified:{},rollback:null,pendingNotice:null});
  await assert.rejects(cleanup({...f.options,runtimeContext:undefined}),/可信运行状态上下文/);await assertBackups(f);
  await fs.unlink(file);await f.write(path.join(f.maintenanceDir,'runtime-rollback.json'),{});
  await assert.rejects(cleanup(f.options),/未知维护状态/);await assertBackups(f);
});
test('M14 活动升级日志必须绑定可信程序和事务目录',async t=>{
  const f=await fixture(t);await backups(f);await f.write(path.join(f.maintenanceDir,'transactions','upgrade.json'),{schema:1,id:'a'.repeat(32),program:'Claude',backup:path.join(f.root,'outside.json')});
  await assert.rejects(cleanup(f.options),/事务结构或归属/);await assertBackups(f);
});
test('M14 JSON 有大小上限，读取中变更被拒绝且不泄露内容',async t=>{
  const f=await fixture(t);await backups(f);
  await assert.rejects(cleanup({...f.options,maxRecordBytes:64}),/有限大小/);await assertBackups(f);
  await assert.rejects(readJsonRecord(f.receipt,f.receiptDir,{afterRead:()=>fs.appendFile(f.receipt,' changed')}),/读取期间变化/);
  await f.write(f.receipt,f.validReceipt());
  await assert.rejects(readJsonRecord(f.receipt,f.receiptDir,{afterRead:()=>fs.unlink(f.receipt)}),/读取期间变化/);
});
test('M14 JSON 文件硬链接在读取之前拒绝',async t=>{
  const f=await fixture(t);await backups(f);const outside=path.join(f.root,'outside.json');await fs.writeFile(outside,'SYNTHETIC_DO_NOT_READ');await fs.unlink(f.receipt);
  await fs.link(outside,f.receipt);
  try{await assert.rejects(cleanup(f.options),/重定向/);await assertBackups(f);assert.equal(await fs.readFile(outside,'utf8'),'SYNTHETIC_DO_NOT_READ');}
  finally{await fs.unlink(f.receipt);}
});
test('M14 证据目录联接拒绝清理，外部内容保留',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');await f.write(path.join(outside,'canary'),{});const link=path.join(f.receiptDir,'codex-security-artifacts-refresh-link');await fs.symlink(outside,link,'junction');
  try{await assert.rejects(cleanup({...f.options,keepEvidence:0}),/重定向/);await fs.access(path.join(outside,'canary'));}finally{await fs.unlink(link);}
});
test('M14 日志按大小轮换且并发调用不会丢行或无限增大',async t=>{
  const f=await fixture(t),file=path.join(f.root,'maintenance.log'),log=boundedLogger(file,{maxBytes:256,archives:2});
  await Promise.all(Array.from({length:20},(_,i)=>log('synthetic-'+i+' '+'.'.repeat(80))));
  for(const name of [file,file+'.1',file+'.2'])assert.ok((await fs.stat(name)).size<=256);await assert.rejects(fs.stat(file+'.3'),{code:'ENOENT'});assert.match(await fs.readFile(file,'utf8'),/synthetic-19/);
});
test('M14 未持锁、活动下载或下载状态未知时不进行任何清理',async t=>{
  const f=await fixture(t);await backups(f);
  for(const change of [{maintenanceLockHeld:false},{activeDownloads:1},{activeDownloads:undefined}]){await assert.rejects(cleanup({...f.options,...change}),/维护锁且确认没有活动下载/);await assertBackups(f);}
});
test('M14 孤儿下载只保留最近三份和七天内候选，非约定名字保持不动',async t=>{
  const f=await fixture(t),now=Date.UTC(2026,10,1),base=path.join(f.maintenanceDir,'candidates'),folders=[];
  for(let i=0;i<6;i++){const folder=path.join(base,String(i).repeat(32));folders.push(folder);await f.write(path.join(folder,'bin','synthetic.exe'),{});const at=now-(10-i)*86400000;await fs.utimes(folder,new Date(at),new Date(at));}
  const unknown=path.join(base,'owner-data');await f.write(path.join(unknown,'canary'),{});
  await cleanup({...f.options,now});
  for(const folder of folders.slice(0,3))await assert.rejects(fs.stat(folder),{code:'ENOENT'});
  for(const folder of folders.slice(3))await fs.access(path.join(folder,'bin','synthetic.exe'));
  await fs.access(path.join(unknown,'canary'));
  const young=path.join(base,'a'.repeat(32));await f.write(path.join(young,'synthetic.exe'),{});await fs.utimes(young,new Date(now-6*86400000),new Date(now-6*86400000));
  await cleanup({...f.options,now});await fs.access(young);assert.equal((await fs.readdir(base)).filter(name=>/^[a-f0-9]{32}$/.test(name)).length,3);
});
test('M14 七天内超过三份候选仍全部保留',async t=>{
  const f=await fixture(t),now=Date.UTC(2026,10,1),base=path.join(f.maintenanceDir,'candidates');
  for(let i=0;i<5;i++){const folder=path.join(base,String(i).repeat(32));await f.write(path.join(folder,'synthetic.exe'),{});await fs.utimes(folder,new Date(now-86400000),new Date(now-86400000));}
  await cleanup({...f.options,now});assert.equal((await fs.readdir(base)).length,5);
});
test('M14 下载候选含目录联接或硬链接时先拒绝，备份与外部内容不删除',async t=>{
  for(const kind of ['junction','hardlink']){
    const f=await fixture(t);await backups(f);const base=path.join(f.maintenanceDir,'candidates'),outside=path.join(f.root,'outside'),old=path.join(base,'a'.repeat(32));await f.write(path.join(outside,'canary'),{});await fs.mkdir(old,{recursive:true});
    const linked=path.join(old,'linked');if(kind==='junction')await fs.symlink(outside,linked,'junction');else await fs.link(path.join(outside,'canary'),linked);
    for(let i=0;i<3;i++)await f.write(path.join(base,String(i).repeat(32),'synthetic.exe'),{});await fs.utimes(old,new Date(1000),new Date(1000));
    try{await assert.rejects(cleanup(f.options),/重定向/);await assertBackups(f);await fs.access(path.join(outside,'canary'));}finally{await fs.unlink(linked);}
  }
});
test('M14 候选目录父级重定向在任何删除前拒绝',async t=>{
  const f=await fixture(t);await backups(f);const outside=path.join(f.root,'outside'),link=path.join(f.maintenanceDir,'candidates');await fs.mkdir(outside);await fs.symlink(outside,link,'junction');
  try{await assert.rejects(cleanup(f.options),/重定向/);await assertBackups(f);await fs.access(outside);}finally{await fs.unlink(link);}
});
test('M14 废弃备份循环引用不会永远保护自身和旧证据',async t=>{
  const f=await fixture(t),a=f.receipt+'.before-a',b=f.receipt+'.before-b',evidence=path.join(f.receiptDir,'codex-security-artifacts-refresh-unused','result.json');await f.write(evidence,{});
  await f.write(a,f.validReceipt([b,evidence]));await f.write(b,f.validReceipt([a,evidence]));
  // 无最低保留年龄的对象不应因为文件时间略领先墙钟而被误保留。
  for(const file of [a,b,path.dirname(evidence)])await fs.utimes(file,new Date(Date.now()+60000),new Date(Date.now()+60000));
  const result=await cleanup({...f.options,keepBackups:0,keepEvidence:0});assert.equal(result.removed,3);for(const file of [a,b,evidence])await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('M14 保留备份间的递归引用和证据保留，当前记录不引用的旧证据可清理',async t=>{
  const f=await fixture(t),a=f.receipt+'.before-a',b=f.receipt+'.before-b',evidence=path.join(f.receiptDir,'codex-security-artifacts-refresh-needed','result.json'),unused=path.join(f.receiptDir,'codex-security-artifacts-refresh-unused','result.json');
  await f.write(evidence,{});await f.write(unused,{});await f.write(a,f.validReceipt([b]));await f.write(b,f.validReceipt([evidence]));await fs.utimes(a,new Date(2000),new Date(2000));await fs.utimes(b,new Date(1000),new Date(1000));
  await cleanup({...f.options,keepBackups:1,keepEvidence:0});for(const file of [a,b,evidence])await fs.access(file);await assert.rejects(fs.stat(unused),{code:'ENOENT'});
});
test('M14 二十轮功能更新后只保留当前与最近备份引用的证据，边界证据一直保留',async t=>{
  const f=await fixture(t),history=require('../tools/maintenance-receipt-history.cjs'),boundary=path.join(f.receiptDir,'codex-security-artifacts-candidate-boundary','filesystem.json');await f.write(boundary,{});let receipt=f.validReceipt([boundary]);
  for(let i=0;i<20;i++){
    const evidence=path.join(f.receiptDir,'codex-security-artifacts-refresh-round-'+i,'e2e.json');await f.write(evidence,{});
    receipt=history.refreshedEvidence(receipt,[evidence],{sequence:i,evidence:[evidence]});
    const backup=f.receipt+'.before-round-'+i;await f.write(backup,receipt);await fs.utimes(backup,new Date((i+1)*1000),new Date((i+1)*1000));
  }
  await f.write(f.receipt,receipt);await cleanup({...f.options,keepBackups:2,keepEvidence:0});await fs.access(boundary);
  for(let i=0;i<20;i++){const evidence=path.join(f.receiptDir,'codex-security-artifacts-refresh-round-'+i,'e2e.json');if(i<9)await assert.rejects(fs.stat(evidence),{code:'ENOENT'});else await fs.access(evidence);}
  assert.equal(receipt.revisions.length,10);assert.equal(receipt.archivedRevisionCount,10);assert.equal((await fs.readdir(f.receiptDir)).filter(name=>name.startsWith('acceptance.json.before-')).length,2);
});
test('M14 仍被正式记录引用的旧下载候选不作为孤儿删除',async t=>{
  const f=await fixture(t),base=path.join(f.maintenanceDir,'candidates'),old=path.join(base,'a'.repeat(32)),file=path.join(old,'synthetic.exe');await f.write(file,{});await fs.utimes(old,new Date(1000),new Date(1000));
  for(let i=0;i<3;i++)await f.write(path.join(base,String(i).repeat(32),'synthetic.exe'),{});await f.write(f.receipt,f.validReceipt([file]));await cleanup(f.options);await fs.access(file);
});
