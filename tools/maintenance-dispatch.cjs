'use strict';
// 五分钟看门狗只发起既有两小时维护任务，不把长验收绑在自身五分钟时限里。
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const tx=require('./maintenance-transaction.cjs');
const requestPath=root=>path.join(root,'data','maintenance','repair-request.json');
async function requestRepair(root,{now=Date.now}={}) {
  const file=requestPath(root);await tx.physical(path.dirname(file),true);await fs.mkdir(path.dirname(file),{recursive:true});
  const request={schema:1,kind:'repair',id:crypto.randomBytes(16).toString('hex'),at:now()};await tx.atomicWrite(file,JSON.stringify(request));return request;
}
async function readRequest(root) {
  const file=requestPath(root);
  try {await tx.physical(file);const stat=await fs.stat(file);if(stat.size>2048||!stat.isFile())throw Error();const value=JSON.parse(await fs.readFile(file,'utf8'));if(value.schema!==1||value.kind!=='repair'||!/^[a-f0-9]{32}$/.test(value.id||'')||!Number.isSafeInteger(value.at))throw Error();return value;}
  catch(e){if(e.code==='ENOENT')return null;throw Error('维护请求格式无效，需要机主检查');}
}
async function completeRequest(root,request) {
  const current=await readRequest(root);if(current?.id===request.id)await fs.unlink(requestPath(root));
}
function startScheduled({execFile=cp.execFile,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}) {
  return new Promise(resolve=>execFile(path.join(systemRoot,'System32','schtasks.exe'),['/Run','/TN','ClaudeRelayVersionCheck'],{windowsHide:true,timeout:30000,maxBuffer:16384},error=>resolve(!error)));
}
module.exports={requestRepair,readRequest,completeRequest,startScheduled};