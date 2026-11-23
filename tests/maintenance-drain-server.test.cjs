'use strict';
// 只在VM里执行真实路由和后台回调，文件/模型/语音/HTTP均为内存替身，无真实监听或进程。
const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm');
const fs=require('node:fs/promises'), path=require('node:path'), {EventEmitter}=require('node:events');
const {createDrain,taskRequest,localMaintenanceRequest}=require('../tools/maintenance-drain.cjs');
const sourcePromise=fs.readFile(path.join(__dirname,'..','server.js'),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function section(source,from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,from);return source.slice(start,end);}

async function routeHarness(){
  const source=await sourcePromise, drain=createDrain(), symbol=Symbol('request'), files=new Map(), bodyReads=[];
  let callback, user={id:'one',profile:'ordinary',workDir:'D:\\synthetic-work'}, voice=deferred(), synth=deferred();
  const token='a'.repeat(64), id='b'.repeat(16), folder='D:\\synthetic-parts';
  const partPath=value=>path.join(folder,value), metaOf=value=>{const bytes=files.get(partPath(value)+'.json');return bytes?JSON.parse(bytes.toString()):null;};
  const context={URL,Buffer,path,maintenanceDrain:drain,MAINTENANCE_REQUEST_DONE:symbol,taskRequest,localMaintenanceRequest,DRAIN_MESSAGE:'准备更新，稍后再试',
    isolationBlocked:null,config:{isolation:{enabled:true}},jobs:new Map(),USERS:new Map(),lastActivity:0,awakeProc:null,stayAwake:false,stayAwakeSince:0,
    isLoopback:value=>['127.0.0.1','::1'].includes(value),idleMs:()=>0,authUser:()=>user,
    updateKeepAwake(){},shortUA:()=>'',console:{log(){},error(){}},
    readBody:async(req,_limit,raw)=>{bodyReads.push(req.url);if(req.waitBody)await req.waitBody;return raw?req.chunk:JSON.stringify(req.body||{});},
    readJSON:async req=>{if(req.waitBody)await req.waitBody;return req.body||{};},
    validId:value=>/^[a-f0-9]{16}$/.test(value),readPartReceipt:value=>{const bytes=files.get(partPath(value)+'.done.json');return bytes?JSON.parse(bytes.toString()):null;},
    readPartMeta:metaOf,PART_DIR:folder,PART_MAX:8*1024*1024,UPLOAD_LIMIT:500*1024*1024,partPath,partReceiptPath:value=>partPath(value)+'.done.json',partBusy:new Map(),
    uploadDir:()=>({dir:'D:\\synthetic-work\\uploads'}),cleanName:name=>name,crypto:{randomBytes:()=>Buffer.from(id,'hex')},
    fs:{mkdirSync(){},writeFileSync:(file,data)=>files.set(file,Buffer.from(data)),rmSync:file=>files.delete(file),
      statSync:file=>({size:(files.get(file)||Buffer.alloc(0)).length}),appendFileSync:(file,data)=>files.set(file,Buffer.concat([files.get(file)||Buffer.alloc(0),data])),
      createReadStream:file=>({file}),existsSync:file=>files.has(file)},
    resolveIn:(_u,file)=>file,toRel:(_u,file)=>path.relative(user.workDir,file),refreshSnap:async()=>{},warmPreviews(){},
    writeFileSafe:(file,data)=>files.set(file,Buffer.from(data)),
    isolation:{context:()=>({}),voiceWarm:()=>voice.promise,synthesize:()=>synth.promise,
      io:{writeFromStream:async()=>({path:'uploads/test.txt',size:4})}},
    speakableText:value=>value,
    freshEnoughSnap:async()=>{},listConvs:()=>[],listProjects:()=>[],runningIds:()=>[],pageHtml:()=>({build:'fixture'}),
    ownerNotice:async()=>'',modelsFor:()=>[],fallbackModelsFor:()=>({anthropic:null,openai:null}),toolsFor:()=>[],savedChoice:()=>({}),usage:{},userToken:()=>'',loadConv:()=>null,
    sendJSON:(res,status,body)=>{res.status=status;res.body=body;res.writeHead(status);res.end();return body;},
    http:{createServer:fn=>{callback=fn;return{};}}
  };
  vm.runInNewContext(section(source,'async function receivePart(','\nconst readJSON')+'\n'+
    section(source,'function admitMaintenanceTask(','\n// ---------- 公网隧道 ----------'),context);
  async function call(url,method='GET',options={}){
    const req={url,method,headers:options.headers||{},socket:{remoteAddress:options.remoteAddress||'127.0.0.1'},body:options.body,
      chunk:options.chunk,waitBody:options.waitBody,resume(){this.resumed=true;}};
    const res=new EventEmitter();Object.assign(res,{headersSent:false,destroyed:false,writableFinished:false,
      setHeader(){},writeHead(status){this.status=status;this.headersSent=true;},end(){if(!options.holdResponse){this.writableFinished=true;this.emit('finish');}}});
    callback(req,res);await turn();return{req,res};
  }
  return{drain,context,call,token,id,files,bodyReads,voice,synth,setUser:value=>{user=value;},metaOf};
}

test('M13 本机维护入口拒绝远端、隧道、浏览器头及错误内容类型，不读取被拒绝请求体',async()=>{
  const h=await routeHarness();
  for(const options of [
    {remoteAddress:'203.0.113.1',headers:{'content-type':'application/json'}},
    {headers:{'content-type':'application/json','cf-connecting-ip':'203.0.113.1'}},
    {headers:{'content-type':'application/json',origin:''}},
    {headers:{'content-type':'application/json','sec-fetch-site':''}},
    {headers:{'content-type':'text/plain'}}
  ]){
    const r=await h.call('/local/maintenance','POST',{...options,body:{action:'begin',token:h.token}});
    assert.ok([403,404].includes(r.res.status));assert.equal(h.drain.blocked(),false);
  }
  assert.equal(h.bodyReads.length,0);
  const ok=await h.call('/local/maintenance','POST',{headers:{'content-type':'application/json'},body:{action:'begin',token:h.token}});
  assert.equal(ok.res.status,200);assert.equal(ok.res.body.draining,true);
  assert.equal(JSON.stringify(ok.res.body).includes(h.token),false);
  const conflict=await h.call('/local/maintenance','POST',{headers:{'content-type':'application/json'},body:{action:'end',token:'c'.repeat(64)}});
  assert.equal(conflict.res.status,409);assert.equal(h.drain.blocked(),true);
});

test('M13 认证后才入场；屏障拒新任务，状态仍可用且未登录请求不占用',async()=>{
  const h=await routeHarness();h.drain.begin(h.token);
  const blocked=await h.call('/api/voice-warm','POST');assert.equal(blocked.res.status,503);assert.equal(h.drain.status().running,0);
  const state=await h.call('/api/state');assert.equal(state.res.status,200);assert.equal(h.drain.status().running,0);
  h.setUser(null);const before=h.context.lastActivity;
  const denied=await h.call('/api/voice-warm','POST');assert.equal(denied.res.status,401);assert.equal(h.drain.status().running,0);assert.equal(h.context.lastActivity,before);
});

test('M13 voice-warm响应已完成也等后台语音；维护期间不开始第二次',async()=>{
  const h=await routeHarness();
  const first=await h.call('/api/voice-warm','POST');assert.equal(first.res.status,200);assert.equal(h.drain.status().running,1);
  h.drain.begin(h.token);
  assert.equal((await h.call('/api/voice-warm','POST')).res.status,503);
  const power=await h.call('/local/power');assert.equal(power.res.body.running,1);
  h.voice.resolve();await turn();assert.equal(h.drain.status().running,0);
});

test('M13 客户端断开仍等语音handler；handler完成后仍等响应流完成',async()=>{
  const h=await routeHarness();
  const r=await h.call('/api/tts','POST',{body:{text:'fixture'},holdResponse:true});
  assert.equal(h.drain.status().running,1);
  r.res.destroyed=true;r.res.emit('close');assert.equal(h.drain.status().running,1);
  h.synth.resolve({audio:Buffer.from('fixture'),contentType:'audio/test'});await turn();assert.equal(h.drain.status().running,0);
  const h2=await routeHarness(), waiting=await h2.call('/api/voice-warm','POST',{holdResponse:true});
  h2.voice.resolve();await turn();assert.equal(h2.drain.status().running,1);
  waiting.res.writableFinished=true;waiting.res.emit('finish');await turn();assert.equal(h2.drain.status().running,0);
});

test('M13 分块上传间隙仍占用；已开始上传可穿过屏障完成，新上传不能开始',async()=>{
  const h=await routeHarness();
  const started=await h.call('/api/upload-start','POST',{body:{name:'test.txt',size:4}});
  assert.equal(started.res.status,200);assert.equal(h.drain.status().activeUploads,1);
  h.drain.begin(h.token);
  assert.equal((await h.call('/api/upload-start','POST',{body:{name:'new',size:4}})).res.status,503);
  assert.equal((await h.call('/api/upload-part?id='+h.id)).res.status,200);
  const part=await h.call('/api/upload-part?id='+h.id+'&offset=0','PUT',{chunk:Buffer.from('data'),holdResponse:true});
  assert.equal(part.res.status,200);assert.equal(part.res.body.done,true);
  assert.equal(h.drain.status().activeUploads,0);assert.equal(h.drain.status().running,1);
  part.res.writableFinished=true;part.res.emit('finish');await turn();assert.equal(h.drain.status().running,0);
});

test('M13 已入场但仍读请求体的上传也阻止空闲判定，账号不能借用他人续传名额',async()=>{
  const h=await routeHarness(), body=deferred();
  const pending=await h.call('/api/upload-start','POST',{body:{name:'test.txt',size:4},waitBody:body.promise});
  assert.equal(h.drain.status().running,1);h.drain.begin(h.token);
  body.resolve();await turn();assert.equal(pending.res.status,200);assert.equal(h.drain.status().activeUploads,1);
  h.setUser({id:'two',workDir:'D:\\synthetic-other'});
  assert.equal((await h.call('/api/upload-part?id='+h.id)).res.status,503);
  assert.equal(h.drain.status().activeUploads,1);
});

test('M13 正在获取额度计数到close，屏障期间不启动新的额度进程',async()=>{
  const source=await sourcePromise, drain=createDrain(), child=new EventEmitter();let launched=0;
  child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stdin={end(){}};child.kill=()=>{};
  const context={maintenanceDrain:drain,isolationBlocked:null,usage:{windows:{}},usageFetching:null,config:{isolation:{enabled:true}},
    isolation:{spawnText:()=>{launched++;return child;}},setTimeout:()=>1,clearTimeout(){},parseUsageText:()=>({}),saveUsage(){}};
  vm.runInNewContext(section(source,'function fetchUsage(','\n// 回复过程中收到的 rate_limit_event'),context);
  const work=context.fetchUsage();assert.equal(drain.status().running,1);drain.begin('a'.repeat(64));
  assert.equal(context.fetchUsage(),work);assert.equal(launched,1);
  child.emit('close');await work;assert.equal(drain.status().running,0);
  await context.fetchUsage();assert.equal(launched,1);
});
test('M13 刷新额度途中进入重启屏障时，不再发探测请求',async()=>{
  const source=await sourcePromise, drain=createDrain(), child=new EventEmitter();let probes=0;
  child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stdin={end(){}};child.kill=()=>{};
  const context={maintenanceDrain:drain,isolationBlocked:null,usage:{windows:{}},usageFetching:null,config:{isolation:{enabled:true}},
    isolation:{spawnText:()=>child},setTimeout:()=>1,clearTimeout(){},parseUsageText:()=>({}),saveUsage(){},spawnQuick:()=>{probes++;throw Error('不该启动');}};
  vm.runInNewContext(section(source,'function fetchUsage(','\n// 回复过程中收到的 rate_limit_event'),context);
  const work=context.fetchUsage({probe:true});drain.begin('a'.repeat(64));child.emit('close');await work;
  assert.equal(probes,0);
});

test('M13 quick队列、异步回调和延迟保存连续计数，空闲预热不计入且屏障不补预热',async()=>{
  const source=await sourcePromise, drain=createDrain(), children=[], timers=new Map();let timerId=0,saved=0;
  const job={},conv={id:'fixture'},user={id:'one'};
  const context={maintenanceDrain:drain,quickRunning:0,quickQueue:[],quickSpare:null,quickIdle:null,QUICK_MAX:1,QUICK_IDLE:1000,
    setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),killQuick(){},
    spawnQuick:()=>{const done=deferred(),child={result:done.promise,resolve:done.resolve,exitCode:null,stdin:{end(){}},kill(){}};children.push(child);return child;},
    jobs:new Map([['key',job]]),jobKey:()=> 'key',u:user,conv,job,msg:{startedAt:1},saveConv:()=>{saved++;},loadConv:()=>null,
  };
  const saves=section(source,'  const saveSoon = () => {','\n\n  // 任务清单');
  vm.runInNewContext('let saveTimer=null,releaseSave=null;\n'+saves+'\nglobalThis.lateSave=saveSoon;\n'+
    section(source,'function ensureQuickSpare()','\nfunction translateThinking'),context);
  const callback=deferred();
  context.quickAsk('fixture one',async()=>{context.lateSave();await callback.promise;});
  context.quickAsk('fixture two',()=>{});
  assert.equal(drain.status().running,2);assert.equal(children.length,2);
  drain.begin('a'.repeat(64));children[0].resolve('text');await turn();
  assert.equal(drain.status().running,3);
  callback.resolve();await turn();assert.equal(drain.status().running,2);assert.equal(children.length,2);
  children[1].resolve('');await turn();assert.equal(drain.status().running,1);
  for(const fn of [...timers.values()])fn();await turn();assert.equal(saved,1);assert.equal(drain.status().running,0);
});

test('M13 主模型退出后的快照、扫描和文字存档完成前不会报空闲',async()=>{
  const source=await sourcePromise, drain=createDrain(), snap=deferred(), scan=deferred(), transcript=deferred();let close,finished=false;
  const callback=section(source,"  child.on('close', async (code) => {",'\n}\n\n// 桌面宠物');
  const msg={role:'assistant',turnId:'fixture-turn',status:'done',startedAt:1},conv={id:'fixture',messages:[msg]};
  const context={maintenanceDrain:drain,child:{on:(_name,fn)=>{close=fn;}},finished:false,job:{},finish:()=>{finished=true;},finishFinalization:incomplete=>assert.equal(incomplete,false),refreshSnap:()=>snap.promise,
    u:{id:'one'},msg,conv,convRel:'fixture',beforeScan:Promise.resolve(new Map()),scanTurnAsync:()=>scan.promise,
    loadConv:()=>conv,jobs:new Map(),jobKey:()=>'',saveConv(){},broadcast(){},withFileUrls:(_u,value)=>value,gpt:true,
    console:{log(){}},warmPreviews(){},writeChatTranscript:()=>transcript.promise};
  vm.runInNewContext('const releaseModel=maintenanceDrain.enter();\n'+callback,context);
  const work=close(0);assert.equal(finished,true);assert.equal(drain.status().running,1);
  snap.resolve();await turn();assert.equal(drain.status().running,1);
  scan.resolve([]);await turn();assert.equal(drain.status().running,1);
  transcript.resolve();await work;assert.equal(drain.status().running,0);
});

test('M13 background工厂同步抛错也释放，屏障请求头的空值不能绕过',async()=>{
  const drain=createDrain();
  await assert.rejects(drain.background(()=>{throw Error('synthetic');}),/synthetic/);
  assert.equal(drain.status().running,0);
  for(const header of ['origin','sec-fetch-site','cf-connecting-ip'])assert.equal(localMaintenanceRequest({method:'POST',headers:{'content-type':'application/json',[header]:''}}),false);
});
