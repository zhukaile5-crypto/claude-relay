'use strict';
// 真实SW/页面资源配置在VM中执行；缓存、网络和浏览器对象均为内存替身。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createPageShell}=require('../tools/page-shell.cjs');
const root=path.resolve(__dirname,'..'),origin='https://fixture.invalid';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const textResponse=(text,options={})=>new Response(text,{status:200,...options});
async function swHarness(){
  const handlers={},stores=new Map(),messages=[],calls=[];let transport=async()=>textResponse('network');
  const key=value=>new URL(typeof value==='string'?value:value.url,origin).href;
  const cacheFor=name=>{
    if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);
    return{match:async request=>store.get(key(request))?.clone(),put:async(request,response)=>{store.set(key(request),response.clone());},
      delete:async request=>store.delete(key(request)),keys:async()=>[...store.keys()].map(url=>({url})),
      addAll:async names=>{for(const name of names)store.set(key(name),await transport(name));}};
  };
  const context={URL,Response,Date,location:{origin},fetch:(...args)=>{calls.push(args);return transport(...args);},
    caches:{open:async name=>cacheFor(name),keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name)},
    self:{addEventListener:(name,fn)=>{handlers[name]=fn;},skipWaiting(){},clients:{claim:async()=>{},
      matchAll:async()=>[{postMessage:value=>messages.push(value)}]}}};
  await vm.runInNewContext(await fs.readFile(path.join(root,'public','sw.js'),'utf8'),context);
  const current=()=>[...stores.keys()].find(name=>name.startsWith('static-'));
  async function activate(){
    const waits=[];handlers.activate({waitUntil:promise=>waits.push(promise)});await Promise.all(waits);
  }
  async function install(){const waits=[];handlers.install({waitUntil:promise=>waits.push(promise)});await Promise.all(waits);}
  function request(url,options={}){
    const waits=[];let response;
    handlers.fetch({request:{url:new URL(url,origin).href,method:options.method||'GET',mode:options.mode||'cors'},
      waitUntil:promise=>waits.push(promise),respondWith:promise=>{response=Promise.resolve(promise);}});
    return{get response(){return response;},waits,settle:async()=>Promise.all(waits)};
  }
  async function message(data){
    const waits=[],replies=[];handlers.message({data,waitUntil:promise=>waits.push(promise),source:{postMessage:value=>replies.push(value)}});
    await Promise.all(waits);return replies;
  }
  return{stores,cacheFor,current,calls,messages,install,activate,request,message,setTransport:value=>{transport=value;}};
}

test('M16 实际SW带build缓存先返回旧副本，同时waitUntil保护后台更新',async()=>{
  const h=await swHarness();await h.install();const cache=h.cacheFor(h.current()),url='/vendor/lib.js?build=old';
  await cache.put(url,textResponse('old'));const net=deferred();h.setTransport(()=>net.promise);
  const event=h.request(url);assert.equal(await(await event.response).text(),'old');assert.equal(event.waits.length,1);
  net.resolve(textResponse('updated'));await event.settle();assert.equal(await(await cache.match(url)).text(),'updated');
  assert.equal(h.calls.at(-1)[1].cache,'no-cache');
});

test('M16 实际SW无build字体在线先核对网络，断网或503均保留可用缓存',async()=>{
  const h=await swHarness();await h.install();const cache=h.cacheFor(h.current()),url='/vendor/fs/inter/files/fixture.woff2';
  await cache.put(url,textResponse('old-font'));h.setTransport(async()=>textResponse('fresh-font'));
  assert.equal(await(await h.request(url).response).text(),'fresh-font');
  h.setTransport(async()=>{throw Error('synthetic offline');});
  assert.equal(await(await h.request(url).response).text(),'fresh-font');
  h.setTransport(async()=>textResponse('sleeping',{status:503}));
  assert.equal(await(await h.request(url).response).text(),'fresh-font');
});

test('M16 refresh-shell替换首页并清旧vendor，保留其他缓存；睡眠页不替换',async()=>{
  const h=await swHarness();await h.install();const cache=h.cacheFor(h.current());
  await cache.put('/vendor/lib.js?build=old',textResponse('old'));
  await cache.put('/vendor/fs/inter/files/a.woff2',textResponse('font'));
  await cache.put('/icons/icon-192.png',textResponse('icon'));
  await h.cacheFor('data').put('/api-fixture-cache',textResponse('private-fixture'));
  h.setTransport(async()=>textResponse('new-shell'));
  assert.equal((await h.message({type:'refresh-shell'}))[0].type,'shell-ready');
  assert.equal(await(await cache.match('/')).text(),'new-shell');
  assert.equal(await cache.match('/vendor/lib.js?build=old'),undefined);
  assert.equal(await cache.match('/vendor/fs/inter/files/a.woff2'),undefined);
  assert.equal(await(await cache.match('/icons/icon-192.png')).text(),'icon');
  assert.ok(await h.cacheFor('data').match('/api-fixture-cache'));
  h.setTransport(async()=>textResponse('sleep-shell',{headers:{'x-claude-sleep':'1'}}));
  await h.message({type:'refresh-shell'});assert.equal(await(await cache.match('/')).text(),'new-shell');
});

test('M16 导航发现新外壳会通知长开页面；API/工作区/跨域/写请求均不经过SW缓存',async()=>{
  const h=await swHarness();await h.install();const cache=h.cacheFor(h.current());await cache.put('/',textResponse('old-shell'));
  h.setTransport(async()=>textResponse('new-shell'));
  const navigation=h.request('/',{mode:'navigate'});assert.equal(await(await navigation.response).text(),'old-shell');
  await navigation.settle();assert.equal(h.messages[0].type,'shell-updated');
  const count=h.calls.length;
  for(const[url,options]of[['/api/state',{}],['/f/user/file',{}],['https://outside.invalid/vendor/a.js',{}],['/vendor/a.js',{method:'POST'}]]){
    assert.equal(h.request(url,options).response,undefined);
  }
  assert.equal(h.calls.length,count);
});

test('同一版本只差 Cloudflare 注入的脚本时不提示更新，版本号变了才提示',async()=>{
  const shell=build=>"<script>const PAGE_BUILD = '"+build.repeat(16)+"';</script>",beacon='<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>';
  const h=await swHarness();await h.install();const cache=h.cacheFor(h.current());await cache.put('/',textResponse(shell('a')));
  h.setTransport(async()=>textResponse(shell('a')+beacon));
  let navigation=h.request('/',{mode:'navigate'});await navigation.response;await navigation.settle();
  assert.equal(h.messages.length,0,'点刷新后重开不能再提示');
  assert.deepEqual(await h.message({type:'ask-update'}),[]);
  h.setTransport(async()=>textResponse(shell('b')+beacon));
  navigation=h.request('/',{mode:'navigate'});await navigation.response;await navigation.settle();
  assert.equal(h.messages[0].type,'shell-updated');
});

test('M16 激活新SW清旧静态版本，但保留叫醒和账号数据缓存',async()=>{
  const h=await swHarness();await h.install();const current=h.current();
  await h.cacheFor('static-obsolete').put('/',textResponse('old'));
  await h.cacheFor('wake').put('/wake',textResponse('fixture'));
  await h.cacheFor('data').put('/data',textResponse('fixture'));
  await h.activate();assert.equal(h.stores.has('static-obsolete'),false);
  for(const name of[current,'wake','data'])assert.equal(h.stores.has(name),true);
});

test('M16 实际loadScript按PAGE_BUILD区分动态库并合并相同版本请求',async()=>{
  const html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
  const start=html.indexOf('const loadedScripts = {}'),end=html.indexOf('\nfunction csvTable',start);
  assert.ok(start>=0&&end>start);const appended=[];
  const context={PAGE_BUILD:'fixture-build',document:{createElement:()=>({}),head:{appendChild:script=>{appended.push(script);script.onload();}}}};
  vm.runInNewContext(html.slice(start,end),context);
  const first=context.loadScript('/vendor/mammoth.js');assert.equal(context.loadScript('/vendor/mammoth.js'),first);
  await first;assert.equal(appended[0].src,'/vendor/mammoth.js?build=fixture-build');assert.equal(appended.length,1);
  context.PAGE_BUILD='next-build';await context.loadScript('/vendor/mammoth.js');assert.equal(appended.length,2);
  assert.equal(appended[1].src,'/vendor/mammoth.js?build=next-build');
});

test('M16 server实际资源映射涵盖首页静态/动态库与所有字体目录，每项变化都会改变build',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-shell-map-'));
  t.after(async()=>{assert.equal(path.dirname(base),path.resolve(os.tmpdir()));assert.match(path.basename(base),/^relay-shell-map-/);
    assert.equal((await fs.lstat(base)).isSymbolicLink(),false);assert.equal((await fs.realpath(base)).toLowerCase(),base.toLowerCase());await fs.rm(base,{recursive:true,force:true});});
  const source=await fs.readFile(path.join(root,'server.js'),'utf8'),html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
  const publicDir=path.join(base,'public'),values={};
  const ctx={ROOT:base,PUBLIC_DIR:publicDir,path,createPageShell:options=>{values.options=options;return{get:async()=>({})};}};
  const vendorStart=source.indexOf("const NM = "),vendorEnd=source.indexOf('\nfunction pipeWorkFile',vendorStart);
  const shellStart=source.indexOf('const pageShell = createPageShell('),shellEnd=source.indexOf('\n// ---------- HTTP 路由 ----------',shellStart);
  assert.ok(vendorStart>=0&&vendorEnd>vendorStart&&shellStart>=0&&shellEnd>shellStart);
  vm.runInNewContext(source.slice(vendorStart,vendorEnd)+'\n'+source.slice(shellStart,shellEnd)+'\nglobalThis.assets=VENDOR;globalThis.fonts=KATEX_FONTS;',ctx);
  assert.equal(values.options.backgroundRefresh,true);
  const assetSet=new Set(values.options.assets),dirs=[...values.options.assetDirectories],files=new Set(assetSet);
  for(const directory of dirs)files.add(path.join(directory,'fixture.woff2'));
  const urls=new Set([...html.matchAll(/(?:src|href)=["'](\/(?:vendor|icons)\/[^"'?]+|\/favicon\.svg|\/manifest\.webmanifest|\/apple-touch-icon\.png)(?:\?[^"']*)?["']/g)].map(match=>match[1]));
  for(const match of html.matchAll(/loadScript\(['"](\/vendor\/[^'"]+)['"]\)/g))urls.add(match[1]);
  for(const url of urls){
    let file;if(url.startsWith('/vendor/fs/')){const parts=url.slice('/vendor/fs/'.length).split('/');file=path.join(base,'node_modules','@fontsource',...parts);}
    else if(url.startsWith('/vendor/fonts/'))file=path.join(ctx.fonts,url.slice('/vendor/fonts/'.length));
    else if(url.startsWith('/vendor/'))file=ctx.assets[url.slice('/vendor/'.length)];
    else file=path.join(publicDir,url==='/apple-touch-icon.png'?'icons/apple-touch-icon.png':url.slice(1));
    assert.ok(file,'未知资源 '+url);assert.ok(assetSet.has(file)||dirs.some(dir=>file.startsWith(dir+path.sep)),'资源未纳入 '+url);files.add(file);
  }
  for(const file of files){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'fixture-'+path.basename(file));}
  await fs.writeFile(path.join(publicDir,'index.html'),html);await fs.writeFile(path.join(publicDir,'sw.js'),'fixture-sw');
  const shell=createPageShell({...values.options,backgroundRefresh:false,intervalMs:0});
  let previous=await shell.get();
  for(const file of files){await fs.appendFile(file,'-changed');const current=await shell.get();assert.notEqual(current.build,previous.build,path.basename(file));previous=current;}
  for(const url of urls)if(url.startsWith('/vendor/'))assert.ok(previous.body.toString().includes(url+'?build='+previous.build)||url==='/vendor/mammoth.js');
  assert.match(source,/const page = await pageHtml\(\)/);assert.match(source,/pageBuild: \(await pageHtml\(\)\)\.build/);
});


test('M16 真实首页和state路由等待异步外壳完成后才发送body/build',async()=>{
  const source=await fs.readFile(path.join(root,'server.js'),'utf8');
  const start=source.indexOf('async function handle(req, res)'),end=source.indexOf('\nconst server = http.createServer',start);
  assert.ok(start>=0&&end>start);let page=deferred();
  const context={URL,pageHtml:()=>page.promise,taskRequest:()=>false,authUser:()=>({id:'fixture'}),USERS:new Map(),jobs:new Map(),
    isolationBlocked:null,lastActivity:0,updateKeepAwake(){},freshEnoughSnap:async()=>{},ownerNotice:async()=>'',loadConv:()=>null,
    listConvs:()=>[],listProjects:()=>[],runningIds:()=>[],modelsFor:()=>[],fallbackModelsFor:()=>({anthropic:null,openai:null}),toolsFor:()=>[],config:{},savedChoice:()=>({}),usage:{},userToken:()=>'',
    sendJSON:(res,status,body)=>{res.status=status;res.body=body;},acceptedEncoding:()=>null,compressedCopy:(name,version,body)=>body,sendStaticFile(){}};
  vm.runInNewContext(source.slice(start,end),context);
  function response(){return{setHeader(){},writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};}
  const home=response(),work=context.handle({url:'/',method:'GET',headers:{}},home);
  assert.equal(home.status,undefined);page.resolve({body:Buffer.from('fixture-html'),build:'fixture-build'});await work;
  assert.equal(home.status,200);assert.equal(home.body.toString(),'fixture-html');assert.equal(home.headers['Content-Length'],12);
  page=deferred();const state=response(),poll=context.handle({url:'/api/state',method:'GET',headers:{}},state);
  await Promise.resolve();assert.equal(state.status,undefined);page.resolve({body:Buffer.from('fixture'),build:'next-build'});await poll;
  assert.equal(state.body.pageBuild,'next-build');
});

test('M16 后台刷新先用完整旧外壳，完成后下一次读取取得新版本',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-shell-background-'));
  t.after(async()=>{assert.equal(path.dirname(base),path.resolve(os.tmpdir()));assert.match(path.basename(base),/^relay-shell-background-/);
    assert.equal((await fs.lstat(base)).isSymbolicLink(),false);assert.equal((await fs.realpath(base)).toLowerCase(),base.toLowerCase());await fs.rm(base,{recursive:true,force:true});});
  for(const[name,text]of Object.entries({'index.html':'__PAGE_BUILD__','sw.js':'worker','scoped-links.js':'links'}))await fs.writeFile(path.join(base,name),text);
  const shell=createPageShell({publicDir:base,backgroundRefresh:true,intervalMs:0}),first=await shell.get();
  await fs.writeFile(path.join(base,'scoped-links.js'),'updated-links');
  assert.equal(await shell.get(),first);
  let next=first;
  for(let attempt=0;attempt<100&&next.build===first.build;attempt++){
    await new Promise(resolve=>setTimeout(resolve,1));next=await shell.get();
  }
  assert.notEqual(next.build,first.build);
});
