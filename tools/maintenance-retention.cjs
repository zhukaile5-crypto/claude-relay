'use strict';
// 只清理由维护器命名的备份与证据；正式记录或保留快照引用的路径始终保护。
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const gate=require('./check-isolation.cjs');
const MAX_RECORD_BYTES=8*1024*1024,HASH=/^[a-f0-9]{64}$/i,ID=/^[a-f0-9]{32}$/;
const key=x=>path.resolve(x).toLowerCase();
const inside=(base,file)=>{const rel=path.relative(path.resolve(base),path.resolve(file));return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
async function plain(file,base){if(key(file)!==key(base)&&!inside(base,file))throw Error('清理目标越界');const stat=await fs.lstat(file);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1||key(await fs.realpath(file))!==key(file))throw Error('清理目标重定向或存在硬链接');return stat;}
async function entries(folder){try{return await fs.readdir(folder,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}}
const stable=(a,b)=>a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.ino===b.ino&&a.dev===b.dev;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
async function readJsonRecord(file,base,{maxBytes=MAX_RECORD_BYTES,afterRead}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_RECORD_BYTES)throw Error('维护记录读取上限无效');
  const before=await plain(file,base);
  if(!before.isFile()||before.size>maxBytes)throw Error('维护记录不是有限大小的普通文件');
  let handle;try{handle=await fs.open(file,'r');}catch{throw Error('维护记录在打开时变化');}let bytes;
  try{
    if(!stable(before,await handle.stat()))throw Error('维护记录在打开时变化');
    const chunks=[];let size=0;
    for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,maxBytes+1-size));const result=await handle.read(buffer,0,buffer.length,null);if(!result.bytesRead)break;size+=result.bytesRead;if(size>maxBytes)throw Error('维护记录超过大小限制');chunks.push(buffer.subarray(0,result.bytesRead));}
    bytes=Buffer.concat(chunks,size);
    if(afterRead)await afterRead(); // 合成测试可在最终核对前替换文件，正式调用不提供此钩子。
    let after;try{after=await plain(file,base);}catch{throw Error('维护记录在读取期间变化');}
    if(!stable(before,await handle.stat())||!stable(before,after))throw Error('维护记录在读取期间变化');
  }finally{await handle.close();}
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('维护记录不是有效 JSON');}
  return {value,stat:before,hash:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function validateReceipt(value) {
  if(!object(value)||value.schema!==gate.RECEIPT_SCHEMA||typeof value.completedAt!=='string'||!Number.isFinite(Date.parse(value.completedAt))||
     !HASH.test(value.configurationFingerprint||'')||!object(value.checks)||!gate.REQUIRED.every(name=>object(value.checks[name])&&typeof value.checks[name].passed==='boolean')||
     !Array.isArray(value.fingerprints)||!value.fingerprints.length||!value.fingerprints.every(item=>object(item)&&typeof item.path==='string'&&path.isAbsolute(item.path)&&HASH.test(item.sha256||'')))throw Error('验收记录结构损坏，停止清理');
  for(const check of Object.values(value.checks))if(object(check)&&check.evidence!==undefined&&(!Array.isArray(check.evidence)||!check.evidence.every(item=>typeof item==='string')))throw Error('验收证据引用结构损坏，停止清理');
  return value;
}
function validateJournal(value,{maintenanceDir,receipt,runtimeContext}) {
  const program=runtimeContext?.programs?.find(item=>item.name===value?.program),folder=path.join(maintenanceDir,'transactions',value?.id||'invalid');
  if(!object(value)||value.schema!==1||!ID.test(value.id||'')||!Number.isInteger(value.ownerPid)||value.ownerPid<=0||!program||
     typeof value.programRoot!=='string'||key(value.programRoot)!==key(program.root)||typeof value.receipt!=='string'||key(value.receipt)!==key(receipt)||
     typeof value.backup!=='string'||key(value.backup)!==key(path.join(folder,'receipt.before.json'))||typeof value.outputReceipt!=='string'||key(value.outputReceipt)!==key(path.join(folder,'receipt.candidate.json'))||
     !['oldProgramHash','candidateHash','receiptHash'].every(name=>HASH.test(value[name]||''))||value.acceptedReceiptHash!==undefined&&!HASH.test(value.acceptedReceiptHash)||
     !['prepared','moving-old','moving-new','swapped','accepting','accepted','installing-receipt','receipt-installed','waiting-idle','restarting','committed','recovering'].includes(value.phase))throw Error('升级事务结构或归属无效，停止清理');
  return value;
}
function references(value,out=new Set()) {if(typeof value==='string'&&path.isAbsolute(value))out.add(key(value));else if(Array.isArray(value))for(const item of value)references(item,out);else if(value&&typeof value==='object')for(const item of Object.values(value))references(item,out);return out;}
const protectedPath=(file,refs)=>[...refs].some(ref=>key(file)===ref||inside(file,ref)||inside(ref,file));
async function scanKnown(file,base){let count=0;async function scan(item){if(++count>50000)throw Error('清理范围过大');const st=await plain(item,base);if(!st.isDirectory()&&!st.isFile())throw Error('清理范围含有非普通文件');if(st.isDirectory())for(const entry of await entries(item))await scan(path.join(item,entry.name));}await scan(file);}
async function removeKnown(file,base){await scanKnown(file,base);await fs.rm(file,{recursive:true,force:true});}
async function retentionRows(folder,filter,keep,{minimumAgeMs=0,now=Date.now(),directories=false}={}) {
  try{if(!(await plain(folder,folder)).isDirectory())throw Error('清理范围不是普通目录');}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const rows=[];for(const entry of await entries(folder)){if(!filter(entry.name))continue;const file=path.join(folder,entry.name);const st=await plain(file,folder);if(directories?!st.isDirectory():!st.isFile())throw Error('清理对象类型不符');rows.push({file,base:folder,time:st.mtimeMs,stat:st});}
  rows.sort((a,b)=>b.time-a.time||a.file.localeCompare(b.file));
  return rows.map((row,index)=>({...row,retained:index<keep||minimumAgeMs>0&&now-row.time<minimumAgeMs}));
}
async function cleanup({receipt,maintenanceDir,keepBackups=5,keepEvidence=5,keepCheckpoints=3,now=Date.now(),runtimeContext,maxRecordBytes=MAX_RECORD_BYTES,maintenanceLockHeld=false,activeDownloads}) {
  if(![keepBackups,keepEvidence,keepCheckpoints].every(n=>Number.isInteger(n)&&n>=0)||!Number.isSafeInteger(maxRecordBytes)||maxRecordBytes<1||maxRecordBytes>MAX_RECORD_BYTES)throw Error('清理保留数量或读取上限无效');
  // 调用方在同一维护锁内释放下载后提供断言；不根据目录时间猜测下载已结束。
  if(maintenanceLockHeld!==true||activeDownloads!==0)throw Error('清理需要持有维护锁且确认没有活动下载');
  const report={removed:0,protected:0},receiptDir=path.dirname(receipt),records=new Map(),refs=new Set();
  if(runtimeContext&&(typeof runtimeContext.receipt!=='string'||key(runtimeContext.receipt)!==key(receipt)||typeof runtimeContext.state!=='string'||key(path.dirname(runtimeContext.state))!==key(maintenanceDir)))throw Error('运行状态上下文与清理范围不一致');
  await plain(receiptDir,receiptDir);await plain(maintenanceDir,maintenanceDir);
  async function load(file,base,validator,protect=false){const record=await readJsonRecord(file,base,{maxBytes:maxRecordBytes});validator(record.value);records.set(file,record);if(protect)references(record.value,refs);return record.value;}
  await load(receipt,receiptDir,validateReceipt,true);refs.add(key(receipt));
  // 不能理解活动状态时完全停止清理，避免删掉恢复必需的文件。
  for(const name of ['runtime-upgrades.json','runtime-state.json','runtime-monitor.json','runtime-rollback.json','transactions/upgrade.json']) {
    try{await load(path.join(maintenanceDir,name),maintenanceDir,value=>{
      if(name==='runtime-upgrades.json'){
        if(!runtimeContext)throw Error('缺少可信运行状态上下文，停止清理');
        require('./maintenance-runtime.cjs').validateState(value,runtimeContext);
      }else if(name==='transactions/upgrade.json')validateJournal(value,{maintenanceDir,receipt,runtimeContext});
      else throw Error('遇到未知维护状态格式，停止清理');
    },true);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const lastGood=path.join(maintenanceDir,'last-good');let current;
  try{current=await load(path.join(lastGood,'current.json'),maintenanceDir,value=>{if(!object(value)||value.schema!==1||!ID.test(value.generation||''))throw Error('快照指针无效');});refs.add(key(path.join(lastGood,current.generation)));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(current)await plain(path.join(lastGood,current.generation),lastGood);

  for(const entry of await entries(lastGood))if(ID.test(entry.name)){const folder=path.join(lastGood,entry.name);await plain(folder,lastGood);await load(path.join(folder,'acceptance.json'),folder,validateReceipt);}
  for(const entry of await entries(receiptDir))if(entry.name.startsWith(path.basename(receipt)+'.before-'))await load(path.join(receiptDir,entry.name),receiptDir,validateReceipt);
  const transactions=path.join(maintenanceDir,'transactions');

  for(const entry of await entries(transactions))if(/^[a-f0-9]{32}$/.test(entry.name)){
    const folder=path.join(transactions,entry.name);await plain(folder,transactions);
    for(const record of await entries(folder))if(/^receipt\.[\w-]+\.json$/.test(record.name))await load(path.join(folder,record.name),folder,validateReceipt);
  }
  // 先决定保留对象，再递归保留它们引用的对象；待删除备份互相引用不会形成永久保护。
  const rows=[
    ...await retentionRows(lastGood,name=>ID.test(name),keepCheckpoints,{directories:true,now}),
    ...await retentionRows(receiptDir,name=>name.startsWith(path.basename(receipt)+'.before-'),keepBackups,{now}),
    ...await retentionRows(transactions,name=>ID.test(name),3,{directories:true,minimumAgeMs:7*86400000,now}),
    ...await retentionRows(receiptDir,name=>/^codex-security-artifacts-(?:refresh|candidate)-[\w-]+$/.test(name),keepEvidence,{directories:true,now}),
    ...await retentionRows(path.join(maintenanceDir,'candidates'),name=>ID.test(name),3,{directories:true,minimumAgeMs:7*86400000,now}),
  ];
  let changed=true;
  while(changed){changed=false;for(const row of rows){if(!row.retained&&protectedPath(row.file,refs)){row.retained=true;report.protected++;}if(row.retained&&!row.referencesLoaded){row.referencesLoaded=true;changed=true;for(const [file,record]of records)if(key(file)===key(row.file)||inside(row.file,file))references(record.value,refs);}}}
  // 所有记录、目录和待删普通树均已验证后才开始删除。维护锁必须覆盖整个过程。
  for(const [file,record]of records){const current=await readJsonRecord(file,key(file)===key(receipt)||inside(receiptDir,file)?receiptDir:maintenanceDir,{maxBytes:maxRecordBytes});if(current.hash!==record.hash||!stable(current.stat,record.stat))throw Error('维护引用在收集期间变化，停止清理');}
  for(const row of rows){if(!stable(await plain(row.file,row.base),row.stat))throw Error('清理对象在规划期间变化');if(!row.retained)await scanKnown(row.file,row.base);}
  for(const row of rows)if(!row.retained){await removeKnown(row.file,row.base);report.removed++;}
  return report;
}
function boundedLogger(file,{maxBytes=2*1024*1024,archives=3}={}) {
  let queue=Promise.resolve();
  return message=>{queue=queue.catch(()=>{}).then(async()=>{
    await fs.mkdir(path.dirname(file),{recursive:true});await plain(path.dirname(file),path.dirname(file));
    let size=0;try{size=(await plain(file,path.dirname(file))).size;}catch(e){if(e.code!=='ENOENT')throw e;}
    const line=Buffer.from('['+new Date().toISOString()+'] '+String(message).slice(-16000)+'\n');
    if(size+line.length>maxBytes){for(let i=archives;i>=1;i--){const target=file+'.'+i,source=i===1?file:file+'.'+(i-1);try{await plain(source,path.dirname(file));if(i===archives){try{await plain(target,path.dirname(file));await fs.unlink(target);}catch(e){if(e.code!=='ENOENT')throw e;}}await fs.rename(source,target);}catch(e){if(e.code!=='ENOENT')throw e;}}}
    await fs.appendFile(file,line);
  });return queue;};
}
module.exports={cleanup,boundedLogger,references,validateReceipt,readJsonRecord,MAX_RECORD_BYTES};
