'use strict';
// Real local HTTP acceptance with synthetic accounts. The production config is read
// only into process memory; the production config and listener are untouched.
// 2026-11-23 GPT 退出平台：这里只验收 Claude（haiku，本机订阅）；合成配置不给任何账号开 GPT（gptUsers 不为空时门槛不通过），
// 原来的 gptSwitchAndTools、gptContinuation、gptLatexWorkflow 去掉。Gemini 由完整验收的 gemini、model-handoff 两步覆盖。
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),http=require('node:http'),assert=require('node:assert/strict'),Module=require('node:module');
const root=path.resolve(__dirname,'..');
const acceptance=require('../tools/maintenance-acceptance.cjs');
if(process.argv[2]==='--serve'){
 (async()=>{
 const stage=path.resolve(process.argv[3]),manifest=path.resolve(process.argv[4]);
 if(path.dirname(stage)!==path.join(root,'data')||!path.basename(stage).startsWith('isolation-e2e-'))throw Error('Synthetic stage required');
 const original=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
 const candidateProgram=process.argv.find(arg=>arg.startsWith('--candidate-program='))?.slice('--candidate-program='.length);
 const candidateTransaction=process.argv.find(arg=>arg.startsWith('--candidate-transaction='))?.slice('--candidate-transaction='.length);
 // 仅候选验收覆盖所选程序入口，避免原配置的绝对路径绕过临时清单。
 const candidate=candidateProgram?await require('../tools/maintenance-candidate.cjs').validateHarnessCandidate({root,config:original,program:candidateProgram,manifestPath:manifest,transactionId:candidateTransaction}):null;
 globalThis.__relayFixtureConfig={...original,host:'127.0.0.1',port:0,secret:crypto.randomBytes(32).toString('hex'),
  users:['alice','bob'].map(id=>({id,name:'Synthetic '+id,password:'SYNTHETIC_LOCAL_TEST_ONLY',workDir:path.join(stage,id),profile:'owner',lightweight:true})),
  workDir:path.join(stage,'alice'),toolboxDir:path.join(stage,'alice'),gptUsers:[],defaultModel:'haiku',defaultEffort:'low',titleModel:'haiku',
  prewarm:false,translateThinking:false,showThinking:false,tunnel:{enabled:false},wake:undefined,petHook:'',
  isolation:{enabled:true,runtimeManifest:manifest,privateRoot:path.join(stage,'private'),gptHome:path.join(stage,'gpt')},
  ...(candidate?.override||{}),
 };
 for(const id of ['alice','bob'])fs.mkdirSync(path.join(stage,id),{recursive:true});
 // 100 synthetic histories exercise cold-start backfill without personal data.
 for(const id of ['alice','bob']){
  const directory=path.join(stage,'data','users',id,'conversations'),transcripts=path.join(stage,id,'.memory','chats');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(transcripts,{recursive:true});
  for(let i=0;i<50;i++){const cid='face'+i.toString(16).padStart(12,'0');
   fs.writeFileSync(path.join(directory,cid+'.json'),JSON.stringify({id:cid,title:'Synthetic startup '+i,titled:true,createdAt:1,updatedAt:i+1,messages:[{role:'user',text:'SYNTHETIC_HISTORY_'+i},{role:'assistant',model:'haiku',status:'done',startedAt:1,finishedAt:2,result:'SYNTHETIC_HISTORY_ANSWER_'+i}]}));
   if(i<40)fs.writeFileSync(path.join(transcripts,cid+'.md'),'SYNTHETIC_EXISTING_TRANSCRIPT_'+i);
  }
 }
 fs.copyFileSync(path.join(root,'mcp-servers.json'),path.join(stage,'mcp-servers.json'));
 // This ticket belongs only to the explicitly synthetic stage. Production uses
 // the same validator and has no environment flag or branch that bypasses it.
 const gate=require('../tools/check-isolation.cjs'),fixtureConfig=globalThis.__relayFixtureConfig;
 fixtureConfig.isolation.receipt=path.join(stage,'synthetic-acceptance.json');
 const runtime=JSON.parse(fs.readFileSync(manifest,'utf8'));
 const ticket={schema:gate.RECEIPT_SCHEMA,purpose:'synthetic-fixture-only',completedAt:new Date().toISOString(),
  configurationFingerprint:gate.configurationFingerprint(fixtureConfig,runtime,stage),
  checks:Object.fromEntries(gate.REQUIRED.map(key=>[key,{passed:true}])),
  fingerprints:gate.requiredFingerprintFiles(fixtureConfig,runtime,stage,root).map(file=>({path:file,sha256:gate.hashFile(file)}))};
 fs.writeFileSync(fixtureConfig.isolation.receipt,JSON.stringify(ticket));
 for(const name of ['public','node_modules'])fs.symlinkSync(path.join(root,name),path.join(stage,name),'junction');
 let source=fs.readFileSync(path.join(root,'server.js'),'utf8');
 source=source.replace('const ROOT = __dirname;','const ROOT = '+JSON.stringify(stage)+';')
  .replace('const config = loadConfig();','const config = globalThis.__relayFixtureConfig;')
  .replace('function updateKeepAwake() {','function updateKeepAwake() { return;');
 source+='\nserver.on("listening",()=>process.send({ready:true,port:server.address().port}));\n';
 // 冷启动分段计时：只在这份内存副本里插标记，server.js 本身不变。找不到插入点就记下来，不影响验收结论。
 const instrumented=require('./acceptance/startup-phases.cjs').instrumentStartup(source);source=instrumented.source;
 if(instrumented.missing.length)process.send({phasesMissing:instrumented.missing});
 // 以上是验收夹具自己的准备（候选校验、合成历史、合成回执），线上冷启动没有这些。
 // 冷启动计时从这里开始，只量服务本身载入到首个健康响应。
 process.send({harnessReady:true});
 const mod=new Module(path.join(root,'server.js'),module);mod.filename=path.join(root,'server.js');mod.paths=Module._nodeModulePaths(root);mod._compile(source,mod.filename);
 process.on('message',message=>{if(message?.stop)process.emit('SIGINT');});
 })().catch(error=>{console.error(error.message);process.exitCode=1;});
}else{
 (async()=>{
  const manifest=path.resolve(process.argv[2]||''),output=path.resolve(process.argv[3]||'');
  const candidateProgram=process.argv.find(arg=>arg.startsWith('--candidate-program='))?.slice('--candidate-program='.length);
  const candidateTransaction=process.argv.find(arg=>arg.startsWith('--candidate-transaction='))?.slice('--candidate-transaction='.length);
  const candidate=candidateProgram?await require('../tools/maintenance-candidate.cjs').validateHarnessCandidate({root,config:JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')),program:candidateProgram,manifestPath:manifest,transactionId:candidateTransaction}):null;
  if(!output.includes('codex-security-artifacts-'))throw Error('Managed evidence output required');
  const stage=fs.mkdtempSync(path.join(root,'data','isolation-e2e-'));
  const started=Date.now(),checks={},cookies={},events=[],startup={historyRecords:100,existingTranscripts:80,missingTranscripts:20},interruptionMonitor=acceptance.createInterruptionMonitor();let stderr='',log='',base,child,stream,streamRequest,failure,failureKind;
  async function request(route,method='GET',body,account='alice',extra={},timeoutMs=180000){
   const headers={...(cookies[account]?{cookie:cookies[account],'x-relay-user':account}:{}),...extra};
   if(body!==undefined&&!Buffer.isBuffer(body)){headers['content-type']='application/json';body=JSON.stringify(body);}
   try{
    const response=await fetch(base+route,{method,headers,body,signal:AbortSignal.timeout(timeoutMs)});
    const bytes=Buffer.from(await response.arrayBuffer());let value=bytes;try{if((response.headers.get('content-type')||'').includes('application/json'))value=JSON.parse(bytes);}catch{}
    return {status:response.status,headers:response.headers,bytes,value};
   }catch{throw Object.assign(Error('本地验收服务请求失败'),{failureKind:{stage:'infrastructure',kind:'local-http'}});}
  }
  function ok(r){assert.equal(r.status,200,typeof r.value==='object'&&!Buffer.isBuffer(r.value)?JSON.stringify(r.value):'HTTP '+r.status);return r.value;}
  async function waitFor(fn,timeout=180000){const until=Date.now()+timeout;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,500));}throw Object.assign(Error('Acceptance step timed out'),{code:'RELAY_WAIT_TIMEOUT'});}
  async function chat(message,model='haiku',conversationId){
   const provider='claude';
   const a=ok(await request('/api/chat','POST',{message,model,effort:'low',conversationId}));let conv;
   try{conv=await waitFor(async()=>{const c=ok(await request('/api/conversations/'+a.conversationId));const last=c.messages.at(-1);return ['done','error','stopped'].includes(last?.status)&&Array.isArray(last.files)&&c;});}
   catch(error){
    if(error.code!=='RELAY_WAIT_TIMEOUT')throw error;
    let health;try{const response=await request('/local/power','GET',undefined,'alice',{},5000);if(response.status===200)health=response.value;}catch{}
    error.failureKind=acceptance.modelWaitFailureKind({provider,health,interruption:interruptionMonitor.check()});throw error;
   }
   const last=conv.messages.at(-1);
   if(last.status!=='done'||last.isError)throw Object.assign(Error('真实模型没有成功完成验收对话'),{failureKind:acceptance.modelFailureKind(last.maintenanceFailureKind,provider)});
   return conv;
  }
  try{
   child=cp.fork(__filename,['--serve',stage,manifest,...(candidateProgram?['--candidate-program='+candidateProgram,'--candidate-transaction='+candidateTransaction]:[])],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
   child.stdout.on('data',d=>{log=(log+d).slice(-16000);});child.stderr.on('data',d=>{stderr=(stderr+d).slice(-16000);});
   let serverStarted;const phases={};
   const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Candidate startup timed out: '+stderr)),45000);child.on('message',m=>{if(m?.harnessReady&&serverStarted===undefined)serverStarted=Date.now();if(m?.phase&&serverStarted!==undefined)phases[m.phase]=Date.now()-serverStarted;if(m?.phasesMissing)startup.phasesMissing=m.phasesMissing;if(m?.ready){if(serverStarted!==undefined)phases.listening=Date.now()-serverStarted;clearTimeout(timer);resolve(m.port);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Candidate startup exited '+code+': '+stderr));});});base='http://127.0.0.1:'+port;
   ok(await request('/'));assert.ok(serverStarted!==undefined,'Harness readiness marker missing');
   startup.harnessMs=serverStarted-started;startup.healthMs=Date.now()-serverStarted;startup.phases={...phases,firstPage:startup.healthMs};assert.ok(startup.healthMs<20000,'Cold-start health exceeded controller deadline');
   for(const account of ['alice','bob']){const r=await request('/api/login','POST',{username:account,password:'SYNTHETIC_LOCAL_TEST_ONLY'},account);ok(r);cookies[account]=r.headers.get('set-cookie').split(';')[0];}
   // 登录后能用验收要用的 Claude（haiku），而且看不到任何 GPT（GPT 已退出平台）
   const state=ok(await request('/api/state'));assert.equal(state.userId,'alice');assert.ok(state.models.some(m=>m.id==='haiku'));assert.ok(!state.models.some(m=>m.provider==='openai'));checks.loginAndModels=true;
   await waitFor(async()=>{try{return ['alice','bob'].every(id=>fs.readFileSync(path.join(stage,id,'.memory','chats','face000000000031.md'),'utf8').includes('SYNTHETIC_HISTORY_ANSWER_49'));}catch{return false;}},30000);
   for(const id of ['alice','bob'])for(let i=0;i<50;i++){const text=fs.readFileSync(path.join(stage,id,'.memory','chats','face'+i.toString(16).padStart(12,'0')+'.md'),'utf8');if(i<40)assert.equal(text,'SYNTHETIC_EXISTING_TRANSCRIPT_'+i);else assert.match(text,new RegExp('SYNTHETIC_HISTORY_ANSWER_'+i));}
   startup.backfillComplete=true;startup.existingUnchanged=true;
   assert.equal((await request('/api/state','GET',undefined,'alice',{'x-relay-user':'bob'})).status,409);checks.crossTabMismatch=true;
   const project=ok(await request('/api/projects','POST',{name:'Synthetic research project',description:'Temporary acceptance data only'}));
   ok(await request('/api/projects/'+project.id,'PATCH',{memory:'SYNTHETIC_PROJECT_MEMORY',instructions:'Use the existing local tools.'}));
   assert.equal(ok(await request('/api/projects/'+project.id)).memory,'SYNTHETIC_PROJECT_MEMORY');checks.projects=true;
   const payload=Buffer.from('Synthetic upload 中文 42\n'),uploaded=ok(await request('/api/upload?name=sample.txt','POST',payload));
   assert.deepEqual((await request('/api/file?path='+encodeURIComponent(uploaded.path))).bytes,payload);
   assert.equal((await request('/api/file?path='+encodeURIComponent(uploaded.path),'GET',undefined,'bob')).status,404);checks.uploadDownloadAccountBoundary=true;
   const part=ok(await request('/api/upload-start','POST',{name:'parts.bin',size:6}));
   ok(await request('/api/upload-part?id='+part.id+'&offset=0','PUT',Buffer.from('abc')));
   assert.equal(ok(await request('/api/upload-part?id='+part.id)).received,3);
   const finished=ok(await request('/api/upload-part?id='+part.id+'&offset=3','PUT',Buffer.from('def')));assert.equal(finished.done,true);
   assert.equal((await request('/api/file?path='+encodeURIComponent(finished.path))).bytes.toString(),'abcdef');checks.resumableUpload=true;
   const html=ok(await request('/api/upload?name=page.html','POST',Buffer.from('<!doctype html><title>Synthetic</title><p>42</p>')));
   const signed=ok(await request('/api/sign?path='+encodeURIComponent(html.path)));
   const page=await request(signed.url);assert.equal(page.status,200);assert.match(page.bytes.toString(),/Synthetic/);assert.match(page.headers.get('content-security-policy'),/sandbox/);checks.signedHtml=true;
   const sourceData=path.join(stage,'input');fs.mkdirSync(sourceData);
   const rt=JSON.parse(fs.readFileSync(manifest,'utf8'));
   const py="import pathlib,sys; from docx import Document; import openpyxl; from pptx import Presentation; p=pathlib.Path(sys.argv[1]); d=Document(); d.add_paragraph('SYNTHETIC DOCX 42 中文转换验收'); d.save(p/'word.docx'); w=openpyxl.Workbook(); w.active.append(['SYNTHETIC XLSX 42 中文转换验收',42]); w.save(p/'sheet.xlsx'); s=Presentation(); slide=s.slides.add_slide(s.slide_layouts[1]); slide.shapes.title.text='SYNTHETIC PPTX 42 中文转换验收'; s.save(p/'slides.pptx')";
   const generated=cp.spawnSync(rt.python,['-X','utf8','-I','-S','-c',py,sourceData],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(generated.status,0,generated.stderr);
   for(const name of ['word.docx','sheet.xlsx','slides.pptx']){
    const item=ok(await request('/api/upload?name='+name,'POST',fs.readFileSync(path.join(sourceData,name))));
    const preview=await request('/api/preview?path='+encodeURIComponent(item.path));ok(preview);
    if(name.endsWith('.xlsx'))assert.match(preview.value.html,/SYNTHETIC XLSX 42 中文转换验收/);else {
     assert.equal(preview.bytes.subarray(0,5).toString(),'%PDF-');
     // Independent parsing of our own generated synthetic PDF checks Unicode.
     const parsed=cp.spawnSync(rt.python,['-X','utf8','-I','-S','-c',"import sys,pymupdf; d=pymupdf.open(stream=sys.stdin.buffer.read(),filetype='pdf'); print(''.join(p.get_text() for p in d))"],{input:preview.bytes,windowsHide:true,encoding:'utf8',timeout:15000});
     assert.equal(parsed.status,0,parsed.stderr);assert.match(parsed.stdout.replace(/\s/g,''),/中文转换验收/);
    }
   }checks.officePreviews=true;console.log(JSON.stringify({step:'office_previews',passed:true}));
   const audio=await request('/api/tts','POST',{text:'这是平台隔离验收，今天的温度是二十五度。'});assert.equal(audio.status,200);assert.ok(audio.bytes.length>1000);
   const transcript=ok(await request('/api/stt','POST',audio.bytes));assert.match(transcript.text,/隔离|验收/);assert.match(transcript.text,/25|二十五/);checks.voiceRoundTrip={audioBytes:audio.bytes.length,text:transcript.text};console.log(JSON.stringify({step:'voice_roundtrip',passed:true}));
   streamRequest=http.get(base+'/api/events',{headers:{cookie:cookies.alice,'x-relay-user':'alice'}},res=>{stream=res;let pending='';res.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\n\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+2);if(line.startsWith('data: '))try{events.push(JSON.parse(line.slice(6)));}catch{}}});});
   const token='SYNTHETIC_'+crypto.randomBytes(5).toString('hex');
   const first=await chat('这是平台验收。记住本次合成标记 '+token+'。请用TaskCreate建立一项任务，用Write在当前对话outputs目录写verify.txt，内容只含标记，然后TaskUpdate完成任务。简短回答。');
   // 模型偶尔只写文件、不建任务清单（2026-11-23 完整验收里出现过）：同一个对话里再明确要求一次，断言不放宽——清单最终必须有一项完成
   const last=first.messages.at(-1);assert.ok(last.sessionId||first.sessionId);assert.ok(last.files?.some(f=>/verify\.txt$/.test(f.path)));
   if(!last.plan?.some(t=>t.status==='completed')){const again=await chat('你刚才没有使用任务清单。请现在用TaskCreate建立一项名为“验收”的任务，然后用TaskUpdate把它标记为completed。不要改动文件，简短回答。','haiku',first.id);assert.ok(again.messages.at(-1).plan?.some(t=>t.status==='completed'));}
   checks.claudeToolsAndChecklist=true;console.log(JSON.stringify({step:'claude_tools',passed:true}));
   const second=await chat('不用工具，只复述刚才记住的合成标记。','haiku',first.id);assert.match(JSON.stringify(second.messages.at(-1)),new RegExp(token));checks.claudeContinuation=true;
   if(process.argv.includes('--with-tex'))for(const [provider,model,backend] of [['claude','haiku','BibTeX plain']]){
    const name=provider+'-tex.pdf';
    const compiled=await chat('继续做合成文件验收。先读取 latex-paper 技能。请在当前对话 outputs 下新建 '+provider+'-paper 项目，创建一页 ctexart 中文 LaTeX，正文必须含“中文隔离验收”和积分公式，并引用一条明确标注为合成测试数据的参考文献：作者 Alice Tester，书名 SYNTHETIC REFERENCE 42，年份2026，出版社 Synthetic Publisher。使用 '+backend+'，保留 tex 和 bib 源文件。通过技能里的受保护 compile_latex 入口实际编译，最终 PDF 命名 '+name+'，保存于 outputs。不要只给代码或声称完成，必须确认生成PDF并给下载链接。无需其他操作。',model,first.id);
    const file=compiled.messages.at(-1).files?.find(f=>f.path.endsWith(name));assert.ok(file,'Missing actual '+provider+' compiled PDF');
    const pdf=await request('/api/file?path='+encodeURIComponent(file.path));ok(pdf);assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');
    const parsed=cp.spawnSync(rt.python,['-X','utf8','-I','-S','-c',"import sys,pymupdf; d=pymupdf.open(stream=sys.stdin.buffer.read(),filetype='pdf'); assert d.page_count>=1 and not d.is_repaired; print(''.join(p.get_text() for p in d))"],{input:pdf.bytes,windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(parsed.status,0,parsed.stderr);const text=parsed.stdout.replace(/\s/g,'');assert.match(text,/中文隔离验收/);assert.match(text,/SYNTHETICREFERENCE42/);
    checks[provider+'LatexWorkflow']={passed:true,bytes:pdf.bytes.length,backend};console.log(JSON.stringify({step:provider+'_latex',passed:true}));
   }
   assert.ok(events.some(e=>e.type!=='hello'));checks.liveEvents={count:events.length};
   const before=fs.readFileSync(path.join(stage,'data','users','alice','conversations',first.id+'.json'),'utf8');assert.match(before,new RegExp(token));checks.conversationSaved=true;
   assert.equal((await request('/api/conversations/'+first.id,'GET',undefined,'bob')).status,404);checks.conversationAccountBoundary=true;
  }catch(error){failure={message:error.message,stack:error.stack,stderr:stderr.slice(-5000),log:log.slice(-5000)};failureKind=error.failureKind||{stage:'check',kind:'unknown'};process.exitCode=1;}
  finally{
   stream?.destroy();streamRequest?.destroy();
   if(child&&child.exitCode===null){child.send({stop:true});const ended=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),10000);child.once('exit',()=>{clearTimeout(timer);resolve(true);});});if(!ended){child.kill();failure||={message:'Candidate shutdown timed out'};failureKind={stage:'infrastructure',kind:'shutdown-timeout'};process.exitCode=1;}}
   const interruption=interruptionMonitor.finish();if(interruption){failure||={message:'验收期间运行环境中断，结果无效'};failureKind={stage:'interruption',kind:'host-interrupted'};process.exitCode=1;}
  }
  // 通过时删掉合成工作目录（以前每次留下约 25 MB）；失败时保留供排查，路径在报告的 stage 里。子进程没退出就不删。
  const cleanup=!failure&&child&&child.exitCode!==null?require('../tools/acceptance-stage.cjs').removeStage(root,stage):{removed:false,kept:failure?'failed-run':'child-running'};
  const result={stage,stageRemoved:cleanup.removed,...(cleanup.error?{stageCleanupError:cleanup.error}:{}),checks,startup,failure,...(failureKind?{failureKind}:{}),durationMs:Date.now()-started,...(candidate?{candidate:candidate.evidence}:{})};fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
 })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
