'use strict';
const crypto=require('node:crypto');
// 同一维护运行持有一个短期排空租约；定时续租跨越等待与重启命令，退出后释放。
function createClient({request,periodMs=10000,schedule=setInterval,cancel=clearInterval,random=()=>crypto.randomBytes(32).toString('hex')}){
  let token=null,timer=null,pending=null,stopping=false;
  async function renew(){
    if(stopping||!token)return null;
    if(pending)return pending;
    const current=token;
    pending=Promise.resolve().then(()=>request({action:'begin',token:current})).then(value=>value?.ok===true&&value.draining===true?value:null).catch(()=>null).finally(()=>{pending=null;});
    return pending;
  }
  async function begin(){
    stopping=false;if(!token)token=random();const requested=token;
    const value=await renew();
    if(stopping||token!==requested)return false;
    if(value&&!timer){timer=schedule(()=>{void renew();},periodMs);timer?.unref?.();}
    return !!value;
  }
  async function idle(){const value=await renew();return !!value&&value.running===0;}
  async function end(){stopping=true;if(timer){cancel(timer);timer=null;}if(pending)await pending;const old=token;token=null;if(old){try{await request({action:'end',token:old});}catch{}}}
  return{begin,idle,end};
}
module.exports={createClient};