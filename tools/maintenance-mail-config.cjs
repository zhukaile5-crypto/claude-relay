'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const mail=require('./maintenance-notify.cjs');
function createMaintenanceMail({root,remainingBudget,log=()=>{},readFile=fs.readFile,module=mail,env=process.env}){
  async function options(){
    let config;
    try{const raw=await readFile(path.join(root,'data','maintenance','mail-config.json'),'utf8');if(raw.length>8192)throw Error();config=JSON.parse(raw);if(!config||typeof config!=='object'||Array.isArray(config))throw Error();}
    catch(error){if(error.code==='ENOENT')return{config:{enabled:false}};return null;}
    return{config:{...config,stateDir:path.join(root,'data','maintenance','mail')},env,maxAttempts:5,remainingBudget};
  }
  async function call(operation,event){
    try{const opts=await options();if(!opts){await log('邮件通知配置不可读取，请机主检查；维护继续。');return{status:'config-error'};}
      const result=operation==='notify'?await module.notify(event,opts):await module.retryPending(opts);
      if(['config-error','state-error'].includes(result?.status))await log('邮件通知暂不可用，请机主检查配置和本机状态；维护继续。');
      return result;
    }catch{try{await log('邮件通知暂未完成；维护继续，网页提示保留。');}catch{}return{status:'pending'};}
  }
  return{notify:event=>call('notify',event),retry:()=>call('retry')};
}
module.exports={createMaintenanceMail};