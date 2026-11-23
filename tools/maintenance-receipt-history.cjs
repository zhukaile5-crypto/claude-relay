'use strict';
// 最新功能验收替换同类旧证据；未重跑的边界检查始终保留原证据。
const path=require('node:path');
// 日常重新验收（回归 + 端到端）实际重跑并证明的项。GPT 退出平台后端到端里没有 GPT，gptApi、gptHistory 不再由它刷新证据
// （旧记录里如果还有这两项，原证据原样保留；它们也已不在门槛的 REQUIRED 里）。
const REFRESHED=Object.freeze(['serverEndToEnd','regression','claudeSubscription','claudeHistory']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function refreshedEvidence(receipt,evidence,revision,{keepRevisions=10}={}) {
  if(!object(receipt)||!object(receipt.checks)||!Array.isArray(evidence)||!evidence.length||!evidence.every(file=>typeof file==='string'&&path.isAbsolute(file))||!object(revision)||!Number.isInteger(keepRevisions)||keepRevisions<1||keepRevisions>10||
     receipt.revisions!==undefined&&(!Array.isArray(receipt.revisions)||!receipt.revisions.every(object))||
     receipt.archivedRevisionCount!==undefined&&(!Number.isSafeInteger(receipt.archivedRevisionCount)||receipt.archivedRevisionCount<0))throw Error('验收证据更新参数无效');
  const result=structuredClone(receipt);
  for(const name of REFRESHED)if(Object.hasOwn(result.checks,name)){
    if(!object(result.checks[name])||typeof result.checks[name].passed!=='boolean')throw Error('功能验收项结构损坏');
    // 本函数只维护引用；成功与否必须来自上游真实验收，绝不在这里补写 passed。
    result.checks[name]={...result.checks[name],evidence:[...new Set(evidence)]};
  }
  const revisions=[...(Array.isArray(result.revisions)?result.revisions:[]),structuredClone(revision)];
  result.archivedRevisionCount=(result.archivedRevisionCount||0)+Math.max(0,revisions.length-keepRevisions);
  if(!Number.isSafeInteger(result.archivedRevisionCount))throw Error('归档修订数量无效');
  result.revisions=revisions.slice(-keepRevisions);
  return result;
}
module.exports={refreshedEvidence,REFRESHED};
