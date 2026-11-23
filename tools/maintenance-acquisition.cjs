'use strict';
// 官方版本发现与获取失败计数；仅接收注入依赖，不调用个人工具的update命令。
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const download=require('./maintenance-download.cjs'),tx=require('./maintenance-transaction.cjs');
const version=value=>{const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));return match?match.slice(1).map(Number):null;};
async function scan(program,d){
  let pinned=null,release;
  try{pinned=await d.version(program.exe);}catch{}
  try{release=await d.discover(program);}catch{release={status:'failed'};}
  const latest=release?.status==='available'?version(release.version):null;
  return{p:program,pinned,latest,release,updated:!!latest,acquisitionError:!pinned?'version-unreadable':!latest?'download-failed':null};
}
async function recordOutcome(d,program,ok,reason){
  let state={};try{state=JSON.parse(await fs.readFile(d.state,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const previous=state.acquisition?.[program.name],result=download.recordAcquisitionResult(previous,{ok,reason});
  // 恢复一次后再连续失败是新问题；没有版本号可区分，用这一轮失败的开始时间作摘要来源。
  const episode=ok?null:previous?.episode||(d.now||Date.now)();
  const next={...state,acquisition:{...(state.acquisition||{}),[program.name]:{...result,episode}}};
  await fs.mkdir(path.dirname(d.state),{recursive:true});await tx.atomicWrite(d.state,JSON.stringify(next,null,2));
  if(result.notify&&d.notify)await d.notify({type:'upgrade-failed',program:program.name.toLowerCase(),version:'unknown',reason:result.reason==='version-unreadable'?'version-unreadable':'download-failed',issueFingerprint:crypto.createHash('sha256').update(JSON.stringify(['acquisition',program.name,episode])).digest('hex')});
  return result;
}
async function prepare(program,latest,d){
  let candidate;try{candidate=await d.prepareCandidate(program,latest);}catch{return{ok:false,reason:'download-failed'};}
  if(candidate?.status!=='ready'||typeof candidate.executable!=='string')return{ok:false,reason:'download-failed'};
  let actual=null;try{actual=await d.version(candidate.executable);}catch{}
  if(!actual)return{ok:false,reason:'version-unreadable',candidate};
  if(actual.join('.')!==latest.join('.'))return{ok:false,reason:'download-failed',candidate};
  return{ok:true,candidate,program:{...program,source:candidate.executable}};
}
module.exports={scan,recordOutcome,prepare};