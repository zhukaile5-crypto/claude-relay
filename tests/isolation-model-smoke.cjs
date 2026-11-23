'use strict';
// Explicit opt-in integration fixture. It uses only self-created workspaces and
// an API key supplied in process.env; no credential is written to fixture files.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const cp = require('node:child_process'), { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const { createIsolation, modelEnv, systemEnv, SETTINGS } = require('../isolation');
const artifacts = 'C:/Users/user/AppData/Local/Temp/codex-security-artifacts-b60511bba8032a3393d9e054e97066978fb1b22c476d228ccd8e3955db5d055f/artifacts';
const mode = process.argv[2] || 'fake';
const base = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'rim-'));
function write(name, value) { fs.writeFileSync(path.join(base,name), JSON.stringify(value,null,2)); }
function setup() {
  const file = path.join(base,'fixture.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,'utf8'));
  const voice = JSON.parse(fs.readFileSync(path.join(artifacts,'voice-research/voice-setup.json'),'utf8'));
  const work = path.join(base,'w'), runtimeRoot = path.join(base,'runtime'), server = path.join(base,'server');
  for (const dir of [work,runtimeRoot,server,path.join(base,'gpt')]) fs.mkdirSync(dir,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../tools/xlsx_html.py'),path.join(runtimeRoot,'xlsx_html.py'));
  const runtime = { python:voice.python, ffmpeg:voice.ffmpeg, whisperModel:voice.model,
    desktopHost:path.join(artifacts,'pdf-isolation/private-desktop-host-v2.exe'),
    nodePath:process.execPath, codexPath:'C:/Users/user/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',
    claudePath:'C:/Users/user/.local/bin/claude.exe', gitBash:'C:/Program Files/Git/bin/bash.exe',
    libreOffice:'C:/Program Files/LibreOffice/program/soffice.exe', xlsxScript:path.join(runtimeRoot,'xlsx_html.py'),
    readRoots:[voice.trusted,voice.shortCoreAlias,voice.model,path.dirname(voice.ffmpeg),'C:/Program Files/LibreOffice',runtimeRoot], skills:{} };
  fs.writeFileSync(path.join(base,'runtime.json'),JSON.stringify(runtime));
  fs.writeFileSync(path.join(base,'gpt/config.toml'),'approval_policy="never"\nsandbox_mode="workspace-write"\nmodel_reasoning_summary="detailed"\n[windows]\nsandbox="unelevated"\n[sandbox_workspace_write]\nnetwork_access=true\n');
  fs.writeFileSync(path.join(server,'mcp-servers.json'),JSON.stringify({mcpServers:{consensus:{type:'http',url:'https://mcp.consensus.app/mcp'},'reference-lookup':{type:'http',url:'https://research-desk-checker.fly.dev/mcp'}}}));
  const fixture = {base,work,server,runtime,config:{claudePath:runtime.claudePath,codexPath:runtime.codexPath,academicSearch:true,
    users:[{id:'synthetic',workDir:work}],isolation:{enabled:true,runtimeManifest:path.join(base,'runtime.json'),privateRoot:path.join(base,'private'),gptHome:path.join(base,'gpt')}}};
  write('fixture.json',fixture); return fixture;
}
function scanFiles(dir, needle) {
  let found = [];
  for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,item.name);
    if(item.isDirectory())found.push(...scanFiles(file,needle));
    else if(item.isFile()&&fs.statSync(file).size<20*1024*1024&&fs.readFileSync(file).includes(Buffer.from(needle)))found.push(path.relative(base,file));
  }
  return found;
}
function testImage() {
  const zlib=require('node:zlib'),width=120,height=60,rows=Buffer.alloc(height*(width*3+1),255);
  for(let y=0;y<height;y++){rows[y*(width*3+1)]=0;for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;if(x>8&&x<49&&y>10&&y<49){rows[i]=255;rows[i+1]=0;rows[i+2]=0;}if((x-89)**2+(y-30)**2<20**2){rows[i]=0;rows[i+1]=0;rows[i+2]=255;}}}
  function chunk(name,data){const type=Buffer.from(name),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);let crc=0xffffffff;for(const byte of Buffer.concat([type,data])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,type,data,checksum]);}
  const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function collect(handle,prompt,kind,timeoutMs=180000) {
  let stdout='',stderr='';
  handle.attach(data=>stdout+=data,data=>stderr+=data);
  const timer=setTimeout(()=>handle.cancel(),timeoutMs);
  const completed=new Promise((resolve,reject)=>{handle.child.once('error',reject);handle.child.once('close',(code,signal)=>resolve({code,signal}));});
  handle.child.stdin.end(kind==='claude'?JSON.stringify({type:'user',message:{role:'user',content:prompt}})+'\n':prompt);
  const exit=await completed;clearTimeout(timer);
  const events=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  return {...exit,events,stderr:stderr.slice(-12000)};
}
function guard(runtime,args,cwd,root,env) {
  const file=path.join(root,'launch-'+crypto.randomUUID()+'.json');
  fs.writeFileSync(file,JSON.stringify({root,desktop:'RelayPrivate_Synthetic_'+crypto.randomBytes(8).toString('hex'),jobName:'Local\\RelayIsolation_'+crypto.randomUUID(),exe:runtime.claudePath,args,cwd,env,stdio:true,timeoutMs:240000}));
  const child=cp.spawn(runtime.desktopHost,[file],{env:systemEnv(),cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  return {child,attach(out,err){child.stdout.on('data',out);child.stderr.on('data',err);},async cancel(){child.kill();}};
}
async function main(){
  const f=setup(), config={...f.config,openaiApiKey:mode==='fake'?'SYNTHETIC_FAKE_API_'+crypto.randomBytes(16).toString('hex'):process.env.CODEX_API_KEY};
  const iso=createIsolation(config,f.server),u=config.users[0];
  try {
    const ctx=iso.context(u);
    if(mode==='fake'){
      const actualSpawn=cp.spawn;let captured;
      cp.spawn=(exe,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>child.emit('close',0);captured={exe,args,options,child};return child;};
      let handle;
      try {handle=iso.launchCodex({u,model:'gpt-6.1-terra',effort:'low',instructions:'Synthetic fixture only.'});}finally{cp.spawn=actualSpawn;}
      const launch=JSON.parse(fs.readFileSync(captured.args[0],'utf8'));
      const checks={noKeyInFiles:scanFiles(base,config.openaiApiKey).length===0,launcherEnvOnly:captured.options.env.CODEX_API_KEY===config.openaiApiKey&&!('CODEX_API_KEY'in launch.env),allowlist:JSON.stringify(launch.inheritEnvKeys)==='["CODEX_API_KEY"]',profileActive:!launch.args.includes('--ignore-user-config')&&launch.args.includes('-p')};
      captured.child.emit('close',0);assert.ok(Object.values(checks).every(Boolean));
      const digest=crypto.createHash('sha256').update(config.openaiApiKey).digest('hex');
      const helperFile=path.join(base,'fake-key-helper.json');
      fs.writeFileSync(helperFile,JSON.stringify({root:base,desktop:'RelayPrivate_Key_'+crypto.randomBytes(8).toString('hex'),jobName:'Local\\RelayIsolation_'+crypto.randomUUID(),exe:f.runtime.nodePath,args:['-e','console.log(JSON.stringify({receivedFakeKey:require("node:crypto").createHash("sha256").update(process.env.CODEX_API_KEY||"").digest("hex")==='+JSON.stringify(digest)+'}))'],cwd:base,env:systemEnv(),inheritEnvKeys:['CODEX_API_KEY'],stdio:true,timeoutMs:20000}));
      const child=cp.spawn(f.runtime.desktopHost,[helperFile],{cwd:base,env:{...systemEnv(),CODEX_API_KEY:config.openaiApiKey},windowsHide:true});let output='',err='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>err+=d);child.stdin.end();const code=await new Promise(r=>child.once('close',r));
      checks.helperReceived=code===0&&output.includes('"receivedFakeKey":true');checks.stillNoKeyInFiles=scanFiles(base,config.openaiApiKey).length===0;assert.ok(Object.values(checks).every(Boolean),err);
      write('fake-result.json',{checks});console.log(JSON.stringify({base,checks}));
    } else if(mode==='claude-old') {
      const sid=crypto.randomUUID(),token='SYNTHETIC_MEMORY_'+crypto.randomBytes(8).toString('hex');
      const args=['-p','--restricted','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings',JSON.stringify(SETTINGS),'--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--permission-prompts','none','--model','haiku','--effort','low','--input-format','stream-json','--output-format','stream-json','--verbose','--session-id',sid,'--system-prompt-snapshot','off'];
      const env={...modelEnv(),CLAUDE_CODE_GIT_BASH_PATH:f.runtime.gitBash,CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',DISABLE_AUTOUPDATER:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false'};
      const result=await collect(guard(f.runtime,args,f.work,base,env),'Remember this synthetic continuity marker exactly: '+token+'. Respond only SAVED.','claude');
      const file=path.join(os.homedir(),'.claude/projects',f.work.replace(/[^a-zA-Z0-9]/g,'-'),sid+'.jsonl');
      const saved={sid,token,file,sha256:fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null};
      write('claude-old-session.json',saved);write('claude-old-result.json',result);console.log(JSON.stringify({base,code:result.code,session:sid,persisted:!!saved.sha256,errors:result.events.filter(e=>e.type==='result').map(e=>({is_error:e.is_error,result:e.result}))}));
    } else if(mode==='claude-resume') {
      const old=JSON.parse(fs.readFileSync(path.join(base,'claude-old-session.json')));
      const result=await collect(iso.launchClaude({u,sessionId:old.sid,model:'haiku',effort:'low',systemPrompt:'Synthetic continuity verification. Reply concisely.'}),'What exact synthetic continuity marker did I previously ask you to remember? Reply with only that marker.','claude');
      const newSid=result.events.find(e=>e.type==='system'&&e.subtype==='init')?.session_id;
      const checks={completed:result.code===0,remembered:JSON.stringify(result.events.filter(e=>e.type==='assistant'||e.type==='result')).includes(old.token),forked:!!newSid&&newSid!==old.sid,originalUnchanged:crypto.createHash('sha256').update(fs.readFileSync(old.file)).digest('hex')===old.sha256,newCwdFileExists:!!newSid&&fs.existsSync(iso.claudeSessionFile(u,newSid))};
      write('claude-resume-result.json',{...result,checks});console.log(JSON.stringify({base,checks,stderr:result.stderr}));assert.ok(Object.values(checks).every(Boolean));
    } else if(mode==='claude-tools') {
      await iso.io.writeFromStream(ctx,'fixture.png',require('node:stream').Readable.from([testImage()]));
      const outside=path.join(base,'outside-canary.txt');fs.writeFileSync(outside,'SYNTHETIC_OUTSIDE_PRIVATE');
      const prompt='Use the relay tools to perform this synthetic integration test in order. Write tools/fixture.txt with RELAY_ALPHA, Edit ALPHA to BETA, Read it, Glob tools/*.txt, Grep RELAY_BETA in tools. Use PowerShell to calculate 6*7 and attempt Get-Content -LiteralPath '+JSON.stringify(outside)+' with -ErrorAction Stop inside try/catch; print OUTSIDE_DENIED on access error, never reveal any file contents outside the workspace. Read fixture.png as an image and describe the two colors/shapes. TaskCreate one synthetic checklist item, TaskUpdate it completed, then TaskGet and TaskList. Reply with a compact factual report of successes and any errors. Do not use WebSearch or Consensus for this turn.';
      const result=await collect(iso.launchClaude({u,model:'sonnet',effort:'low',systemPrompt:iso.notes(u)}),prompt,'claude');
      const init=result.events.find(e=>e.type==='system'&&e.subtype==='init');
      const calls=result.events.flatMap(e=>e.message?.content||[]).filter(x=>x.type==='tool_use').map(x=>x.name);
      const checks={completed:result.code===0,relayConnected:init?.mcp_servers?.some(s=>s.name==='relay'&&s.status==='connected'),written:iso.io.readTextSync(ctx,'tools/fixture.txt')==='RELAY_BETA',tools:['Write','Edit','Read','Glob','Grep','PowerShell','TaskCreate','TaskUpdate','TaskGet','TaskList'].every(t=>calls.includes('mcp__relay__'+t)),outsideDenied:JSON.stringify(result.events).includes('OUTSIDE_DENIED'),imageRead:calls.filter(n=>n==='mcp__relay__Read').length>=2};
      write('claude-tools-result.json',{...result,checks,calls});console.log(JSON.stringify({base,checks,calls,stderr:result.stderr}));assert.ok(Object.values(checks).every(Boolean));
    } else if(mode==='claude-web') {
      const prompt='Synthetic network integration test. First call the native WebSearch tool for the official LibreOffice command-line headless conversion documentation. Then call mcp__consensus__search for randomized trials of exercise and blood pressure, maximum 2 results. Then call relay WebFetch on https://example.com/ and save_path tools/example.html. Return one public source title/URL from each search and the saved file path, or report the exact failure. Do not execute local commands.';
      const result=await collect(iso.launchClaude({u,model:'sonnet',effort:'low',systemPrompt:iso.notes(u)}),prompt,'claude',240000);
      const calls=result.events.flatMap(e=>e.message?.content||[]).filter(x=>x.type==='tool_use').map(x=>x.name),init=result.events.find(e=>e.type==='system'&&e.subtype==='init');
      const checks={completed:result.code===0,webSearchCalled:calls.includes('WebSearch'),consensusCalled:calls.includes('mcp__consensus__search'),consensusConnected:init?.mcp_servers?.some(s=>s.name==='consensus'&&s.status==='connected'),downloaded:iso.io.readTextSync(ctx,'tools/example.html').includes('Example Domain')};
      write('claude-web-result.json',{...result,checks,calls});console.log(JSON.stringify({base,checks,calls,stderr:result.stderr}));assert.ok(Object.values(checks).every(Boolean));
    } else if(mode==='claude-quick') {
      const child=iso.spawnText({model:'haiku'});
      const handle={child,attach(out,err){child.stdout.on('data',out);child.stderr.on('data',err);},async cancel(){child.kill();}};
      const result=await collect(handle,'Reply exactly SYNTHETIC_QUICK_OK.','claude');
      const checks={completed:result.code===0,answer:result.events.some(e=>e.type==='result'&&!e.is_error&&e.result==='SYNTHETIC_QUICK_OK'),noTools:result.events.filter(e=>e.type==='system'&&e.subtype==='init').every(e=>e.tools.length===0)};
      write('claude-quick-result.json',{...result,checks});console.log(JSON.stringify({base,checks,stderr:result.stderr}));assert.ok(Object.values(checks).every(Boolean));
    } else if(mode==='claude-usage') {
      const variant=process.argv[4]||'candidate',actualSpawn=cp.spawn;let child;
      cp.spawn=(exe,args,options)=>{if(exe===f.runtime.desktopHost&&variant!=='candidate'){const r=JSON.parse(fs.readFileSync(args[0]));if(variant==='legacy')r.args=['-p','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','project,local'];else r.args=r.args.filter(a=>!(variant.includes('slash')&&a==='--disable-slash-commands')&&!(variant.includes('restricted')&&a==='--restricted'));fs.writeFileSync(args[0],JSON.stringify(r));}return actualSpawn(exe,args,options);};
      try{child=iso.spawnText({model:'haiku',usage:true});}finally{cp.spawn=actualSpawn;}
      let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.end('/usage\n');const code=await new Promise(r=>child.on('close',r));
      const checks={completed:code===0,hasUsage:/current session|current week|\d+\s*%/i.test(stdout)};
      write('claude-usage-'+variant+'-result.json',{code,checks,subscriptionMessage:stdout.includes('using your subscription'),outputHash:crypto.createHash('sha256').update(stdout).digest('hex'),stderr});console.log(JSON.stringify({base,variant,checks,subscriptionMessage:stdout.includes('using your subscription'),stderr}));
    } else if(mode==='gpt-old') {
      assert.ok(config.openaiApiKey,'API key must arrive through environment');
      const token='SYNTHETIC_GPT_MEMORY_'+crypto.randomBytes(8).toString('hex');
      const actualSpawn=cp.spawn;let handle;
      // Simulate the old workspace cwd while preserving the same synthetic HOME.
      // The profile and protected process boundary remain the candidate policy.
      cp.spawn=(exe,args,options)=>{if(exe===f.runtime.desktopHost){const request=JSON.parse(fs.readFileSync(args[0]));const at=request.args.indexOf('-C');request.args[at+1]=f.work;request.cwd=f.work;fs.writeFileSync(args[0],JSON.stringify(request));}return actualSpawn(exe,args,options);};
      try{handle=iso.launchCodex({u,model:'gpt-6.1-terra',effort:'low',instructions:'Synthetic continuity test. Do not call tools for this one turn.'});}finally{cp.spawn=actualSpawn;}
      const result=await collect(handle,'Remember this synthetic continuity marker exactly: '+token+'. Respond only SAVED.','gpt');
      const sid=result.events.find(e=>e.type==='thread.started')?.thread_id;
      function find(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory()){const found=find(file);if(found)return found;}else if(item.name.includes(sid)&&item.name.endsWith('.jsonl'))return file;}}
      const file=sid?find(path.join(base,'gpt')):null;
      const saved={sid,token,file,sha256:file?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null};
      write('gpt-old-session.json',saved);write('gpt-old-result.json',result);console.log(JSON.stringify({base,code:result.code,session:sid,persisted:!!saved.sha256,stderr:result.stderr,errors:result.events.filter(e=>e.type==='error')}));assert.ok(result.code===0&&saved.sha256);
    } else if(mode==='gpt-resume') {
      const old=JSON.parse(fs.readFileSync(path.join(base,'gpt-old-session.json')));
      const result=await collect(iso.launchCodex({u,threadId:old.sid,model:'gpt-6.1-terra',effort:'low',instructions:'Synthetic continuity test. Reply with only the marker; do not call tools.'}),'What exact synthetic continuity marker did I previously ask you to remember? Reply with only that marker.','gpt');
      const sid=result.events.find(e=>e.type==='thread.started')?.thread_id;
      const checks={completed:result.code===0,remembered:JSON.stringify(result.events).includes(old.token),forked:!!sid&&sid!==old.sid,originalUnchanged:crypto.createHash('sha256').update(fs.readFileSync(old.file)).digest('hex')===old.sha256};
      write('gpt-resume-result.json',{...result,checks});console.log(JSON.stringify({base,checks,stderr:result.stderr,errors:result.events.filter(e=>e.type==='error')}));assert.ok(Object.values(checks).every(Boolean));
    } else if(mode==='gpt-tools') {
      const result=await collect(iso.launchCodex({u,model:'gpt-6.1-terra',effort:'low',instructions:iso.notes(u),attachments:[{path:'fixture.png'}]}),'Synthetic integration test: using relay MCP tools, Write tools/gpt.txt with GPT_ALPHA, Edit ALPHA to BETA, Read it. Use PowerShell to calculate 6*7. Use TaskCreate and TaskUpdate completed for one checklist item. Also describe the colors and shapes in the attached image. Finally use the native web search tool to find the official LibreOffice command-line headless documentation and report its URL. Do not use any other local file or program tools. Report concise factual results.','gpt',240000);
      const items=result.events.filter(e=>e.type==='item.completed').map(e=>e.item),mcp=items.filter(e=>e.type==='mcp_tool_call');
      const checks={completed:result.code===0,written:iso.io.readTextSync(ctx,'tools/gpt.txt')==='GPT_BETA',mcpTools:['Write','Edit','Read','PowerShell','TaskCreate','TaskUpdate'].every(name=>mcp.some(t=>t.tool===name)),webSearch:items.some(t=>t.type==='web_search')};
      write('gpt-tools-result.json',{...result,checks});console.log(JSON.stringify({base,checks,items:items.map(i=>({type:i.type,server:i.server,tool:i.tool,status:i.status})),stderr:result.stderr}));assert.ok(Object.values(checks).every(Boolean));
    } else throw Error('Unknown integration mode');
  } finally {await iso.closeAll();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
