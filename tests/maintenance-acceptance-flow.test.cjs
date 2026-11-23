'use strict';
// 执行真实编排函数，所有外部验收均由写合成报告的函数替代。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const acceptance=require('../tools/maintenance-acceptance.cjs'),tx=require('../tools/maintenance-transaction.cjs');
const network={stage:'model',kind:'model-network',provider:'claude',source:'model-result'};
async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'relay-m8-'));await fsp.writeFile(path.join(root,'fixture-only'),'合成验收');
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^relay-m8-/);assert.equal((await fsp.realpath(root)).toLowerCase(),root.toLowerCase());assert.equal((await fsp.lstat(root)).isSymbolicLink(),false);assert.equal(await fsp.readFile(path.join(root,'fixture-only'),'utf8'),'合成验收');await fsp.rm(root,{recursive:true,force:true});});
  const evidenceDir=path.join(root,'codex-security-artifacts-m8');await fsp.mkdir(evidenceDir);
  return {root,evidenceDir,manifestPath:path.join(root,'manifest.json'),requiredChecks:['complete']};
}
function runner(calls,outcomes=[]){return async request=>{
  calls.push(request);await fsp.writeFile(request.logFile,'合成输出 '+request.kind+' '+request.attempt,{flag:'wx'});
  if(request.kind==='regression')return {ok:true,status:0};
  const outcome=outcomes[request.attempt-1]||{},report={syntheticOnly:true,checks:{complete:true},...outcome.report};
  await fsp.writeFile(request.args[2],JSON.stringify(report),{flag:'wx'});
  return {ok:!report.failure&&!report.failureKind,status:report.failure?1:0,...outcome.result};
};}
test('M8完整编排回归仅一次，重试报告与日志各自保留',async t=>{
  const f=await fixture(t),calls=[];
  const result=await acceptance.runEvidence({...f,runCheck:runner(calls,[{report:{failure:{message:'合成网络失败'},failureKind:network}}])});
  assert.equal(result.ok,true);assert.equal(result.attemptCount,2);assert.deepEqual(calls.map(r=>r.kind),['regression','e2e','e2e']);
  const first=JSON.parse(await fsp.readFile(path.join(f.evidenceDir,'e2e-attempt-1.json'))),second=JSON.parse(await fsp.readFile(path.join(f.evidenceDir,'e2e-attempt-2.json')));
  assert.equal(first.failure.message,'合成网络失败');assert.equal(second.failure,undefined);
  assert.match(await fsp.readFile(path.join(f.evidenceDir,'e2e-attempt-1.log'),'utf8'),/e2e 1/);assert.match(await fsp.readFile(path.join(f.evidenceDir,'e2e-attempt-2.log'),'utf8'),/e2e 2/);
  const saved=JSON.parse(await fsp.readFile(path.join(f.evidenceDir,'attempts.json')));assert.equal(saved.attempts.length,3);
  assert.equal(saved.attempts[1].result.report.failure.message,'合成网络失败');assert.equal(result.recordVersionFailure,false);
});
test('M8边界在重试前改变时不启动第二个验收，首份证据仍保留',async t=>{
  const f=await fixture(t),calls=[];
  const result=await acceptance.runEvidence({...f,runCheck:runner(calls,[{report:{failure:{message:'合成网络失败'},failureKind:network}}]),beforeAttempt:({attempt})=>{if(attempt===2)throw Error('合成绑定变化');}});
  assert.equal(result.ok,false);assert.equal(result.failureKind.stage,'boundary');assert.equal(result.recordVersionFailure,false);
  assert.deepEqual(calls.map(r=>r.kind),['regression','e2e']);await fsp.access(path.join(f.evidenceDir,'e2e-attempt-1.json'));
});
test('M8回归失败不运行E2E，预算耗尽不能给第二次重新分配预算',async t=>{
  const f=await fixture(t),calls=[];
  const failed=await acceptance.runEvidence({...f,runCheck:async r=>{calls.push(r);await fsp.writeFile(r.logFile,'合成回归失败');return {ok:false,status:1};}});
  assert.equal(failed.stage,'regression');assert.equal(calls.length,1);assert.equal(failed.recordVersionFailure,false);
  const g=await fixture(t),requests=[];let left=10000;const raw=runner(requests,[{report:{failure:{message:'合成网络失败'},failureKind:network}}]);
  const exhausted=await acceptance.runEvidence({...g,remaining:()=>left,runCheck:async r=>{const result=await raw(r);if(r.kind==='regression')left=5000;else left=0;return result;}});
  assert.equal(requests.length,2);assert.ok(requests[1].timeoutMs<=5000);assert.equal(exhausted.ok,false);assert.equal(exhausted.interrupted,true);assert.equal(exhausted.recordVersionFailure,false);
});
test('M8子进程外层超时即使已有网络报告也不重试',async t=>{
  const f=await fixture(t),calls=[];
  const result=await acceptance.runEvidence({...f,runCheck:runner(calls,[{report:{failure:{message:'合成网络失败'},failureKind:network},result:{ok:false,timedOut:true}}])});
  assert.equal(calls.length,2);assert.equal(result.attemptCount,1);assert.equal(result.failureKind.kind,'runner-timeout');assert.equal(result.recordVersionFailure,false);
});
test('M8睡眠样本压过网络类别，不重试也不记坏版本',async t=>{
  const f=await fixture(t),calls=[];let time=0;const raw=runner(calls,[{report:{failure:{message:'合成网络失败'},failureKind:network}}]);
  const result=await acceptance.runEvidence({...f,clock:()=>({wallMs:time,monotonicMs:time}),runCheck:async r=>{const value=await raw(r);if(r.kind==='e2e')time+=120000;return value;}});
  assert.equal(result.ok,false);assert.equal(result.interrupted,true);assert.equal(result.recordVersionFailure,false);assert.equal(result.attemptCount,1);
});
test('M8缺少检查或候选身份不符不能通过，不把它们解释为网络问题',async t=>{
  for(const options of [{report:{checks:{}}},{report:{checks:{complete:false},failure:{message:'合成边界失败'},failureKind:network}},{report:{failure:{message:'network timeout'},candidate:{different:true}},expected:{program:'Claude'}}]){
    const f=await fixture(t),calls=[];
    const result=await acceptance.runEvidence({...f,candidateEvidence:options.expected,runCheck:runner(calls,[{report:options.report}])});
    assert.equal(result.ok,false);assert.equal(result.attemptCount,1);assert.equal(result.recordVersionFailure,false);
  }
});
test('M8安全摘要可回传中断类别，拒绝重复摘要及夹带额外字段',()=>{
  const result={ok:false,interrupted:true,recordVersionFailure:false,attemptCount:1,failureKind:{stage:'interruption',kind:'host-interrupted'},out:'不应进入摘要的内容'};
  const line=acceptance.formatResult(result),parsed=acceptance.parseResultOutput('其他输出\n'+line+'\n');
  assert.equal(parsed.interrupted,true);assert.equal(parsed.recordVersionFailure,false);assert.equal(line.includes(result.out),false);
  assert.equal(acceptance.parseResultOutput(line+'\n'+line),null);
  assert.equal(acceptance.parseResultOutput(line.replace('"schema":1','"extra":"SYNTHETIC","schema":1')),null);
});
test('M8未知模型类别、错provider和错source都不计坏版本',()=>{
  for(const failureKind of [undefined,{...network,kind:'unknown'},{...network,provider:'other'},{...network,source:'local-http'}]){
    const result=acceptance.classifyResult({ok:false,failureKind});assert.equal(result.recordVersionFailure,false);assert.equal(result.retryable,false);
  }
  for(const kind of ['model-network','model-timeout','model-start','model-protocol','model-no-output'])assert.equal(acceptance.classifyResult({ok:false,failureKind:{...network,kind}}).recordVersionFailure,true);
});
function chatHarness({last,timeout=false,health={isolationBlocked:false,running:1},interruption=null,requestFails=false}={}){
  const source=fs.readFileSync(path.join(__dirname,'server-isolation-e2e.cjs'),'utf8'),start=source.indexOf('  async function chat('),end=source.indexOf('\n  try{\n   child=',start);assert.ok(start>=0&&end>start);
  const context={acceptance,Error,request:async route=>{if(requestFails)throw Object.assign(Error('合成本地网络失败'),{failureKind:{stage:'infrastructure',kind:'local-http'}});return {status:200,value:route==='/api/chat'?{conversationId:'synthetic'}:route==='/local/power'?health:{messages:[last]}};},
    ok:r=>r.value,waitFor:async fn=>{if(timeout)throw Object.assign(Error('合成等待超时'),{code:'RELAY_WAIT_TIMEOUT'});return fn();},interruptionMonitor:{check:()=>interruption}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.chatTest=chat;',context);return ()=>context.chatTest('SYNTHETIC','haiku');
}
test('M8真实harness闭包只使用模型结构化类别，本地请求失败不冒充模型网络',async()=>{
  await assert.rejects(chatHarness({last:{status:'error',files:[],maintenanceFailureKind:'network'}})(),error=>error.failureKind.kind==='model-network'&&error.failureKind.source==='model-result');
  await assert.rejects(chatHarness({last:{status:'error',files:[],error:'network timeout'}})(),error=>error.failureKind.kind==='unknown');
  await assert.rejects(chatHarness({requestFails:true})(),error=>error.failureKind.stage==='infrastructure');
});
test('M8真实harness模型等待超时要排除受限、失联和睡眠',async()=>{
  for(const [options,stage]of [[{},'model'],[{health:{isolationBlocked:true,running:1}},'boundary'],[{health:{}},'infrastructure'],[{interruption:'execution-gap'},'interruption']]){
    await assert.rejects(chatHarness({timeout:true,...options})(),error=>error.failureKind.stage===stage);
  }
});
async function refreshHarness(t,runCheck,prepareReceipt=()=>{}){
  const f=await fixture(t),root=f.root,output=path.join(root,'data','maintenance','transactions','a'.repeat(32),'receipt.candidate.json');await fsp.mkdir(path.dirname(output),{recursive:true});
  const runtime={claudePath:path.join(root,'claude.exe'),codexPath:path.join(root,'codex','bin','codex.exe')},manifest=path.join(root,'manifest.json'),receipt=path.join(root,'data','acceptance.json');
  const metadata=path.join(root,'codex','codex-package.json');await fsp.mkdir(path.dirname(runtime.codexPath),{recursive:true});
  const config={isolation:{enabled:true,runtimeManifest:manifest,receipt}},files=[manifest,runtime.claudePath,runtime.codexPath,path.join(root,'server.js'),path.join(root,'boundary.js'),metadata];
  await fsp.writeFile(manifest,JSON.stringify(runtime));for(const file of files.slice(1))await fsp.writeFile(file,'SYNTHETIC_OLD');
  await fsp.writeFile(metadata,JSON.stringify({layoutVersion:1,version:'0.166.0',target:'x86_64-pc-windows-msvc',variant:'codex',entrypoint:'bin/codex.exe'}));
  await fsp.writeFile(path.join(root,'config.json'),JSON.stringify(config));const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const ticket={schema:2,configurationFingerprint:'a'.repeat(64),checks:{boundary:{passed:true}},fingerprints:files.map(file=>({path:file,sha256:sha(file)}))};prepareReceipt(ticket,root);await fsp.writeFile(receipt,JSON.stringify(ticket));await fsp.writeFile(path.join(root,'server.js'),'SYNTHETIC_NEW');
  const gate={RECEIPT_SCHEMA:2,REQUIRED:['boundary'],configurationFingerprint:()=>ticket.configurationFingerprint,requiredFingerprintFiles:()=>files,hashFile:sha,
    check:(cfg,file)=>({readyToEnableIsolation:JSON.parse(fs.readFileSync(file)).fingerprints.every(item=>sha(item.path)===item.sha256)})};
  const outputLines=[],processStub={argv:['node','synthetic-refresh','--output-receipt='+output],execPath:process.execPath,exitCode:0,exit:code=>{throw Error('Unexpected synthetic exit '+code);}};
  const modules={'node:fs':fs,'node:path':path,'node:crypto':crypto,'./check-isolation.cjs':gate,'./maintenance-transaction.cjs':tx,
    './maintenance-refresh-plan.cjs':require('../tools/maintenance-refresh-plan.cjs'),
    './maintenance-receipt-history.cjs':require('../tools/maintenance-receipt-history.cjs'),
    './maintenance-acceptance.cjs':{...acceptance,runEvidence:options=>acceptance.runEvidence({...options,runCheck:request=>runCheck(request,options)})}};
  const source=await fsp.readFile(path.join(__dirname,'../tools/refresh-isolation-receipt.cjs'),'utf8');
  await vm.runInNewContext('(function(){'+source+'\n})()',{require:name=>{assert.ok(modules[name],'禁止加载真实额外依赖 '+name);return modules[name];},__dirname:path.join(root,'tools'),process:processStub,console:{log:value=>outputLines.push(String(value)),error:value=>outputLines.push(String(value))},Buffer,Date,JSON});
  return{...f,output,receipt,ticket,code:processStub.exitCode,summary:acceptance.parseResultOutput(outputLines.join('\n'))};
}
test('M8普通refresh也保存两份重试证据并回传成功摘要，正式记录不改',async t=>{
  const calls=[];const f=await refreshHarness(t,async(request,options)=>{calls.push(request);await fsp.writeFile(request.logFile,'合成普通验收');if(request.kind==='regression')return{ok:true,status:0};const failure=request.attempt===1?{failure:{message:'合成网络'},failureKind:network}:{};await fsp.writeFile(request.args[2],JSON.stringify({checks:Object.fromEntries(options.requiredChecks.map(name=>[name,true])),...failure}));return{ok:request.attempt!==1,status:request.attempt===1?1:0};});
  assert.equal(f.code,0);assert.equal(f.summary.ok,true);assert.equal(f.summary.attemptCount,2);assert.equal(calls.length,3);
  assert.deepEqual(JSON.parse(await fsp.readFile(f.receipt)),f.ticket);const published=JSON.parse(await fsp.readFile(f.output));assert.ok(published.revisions[0].evidence.some(file=>file.endsWith('e2e-attempt-1.json')));assert.ok(published.revisions[0].evidence.some(file=>file.endsWith('e2e-attempt-2.json')));
});
test('M8普通refresh失败摘要保留睡眠语义，不发布候选记录',async t=>{
  const f=await refreshHarness(t,async(request,options)=>{await fsp.writeFile(request.logFile,'合成睡眠中断');if(request.kind==='regression')return{ok:true,status:0};await fsp.writeFile(request.args[2],JSON.stringify({checks:Object.fromEntries(options.requiredChecks.map(name=>[name,true])),failure:{message:'合成中断'},failureKind:{stage:'interruption',kind:'sleep'}}));return{ok:false,status:1};});
  assert.equal(f.code,4);assert.equal(f.summary.ok,false);assert.equal(f.summary.interrupted,true);assert.equal(f.summary.recordVersionFailure,false);assert.equal(fs.existsSync(f.output),false);assert.deepEqual(JSON.parse(await fsp.readFile(f.receipt)),f.ticket);
});
test('M14 普通 refresh 实际入口替换六类证据、保留边界及最近十次修订',async t=>{
  const f=await refreshHarness(t,async(request,options)=>{await fsp.writeFile(request.logFile,'合成 M14 验收');if(request.kind==='e2e')await fsp.writeFile(request.args[2],JSON.stringify({checks:Object.fromEntries(options.requiredChecks.map(name=>[name,true]))}));return{ok:true,status:0};},(ticket,root)=>{
    ticket.checks.boundary={passed:true,evidence:[path.join(root,'boundary-original.json')]};
    for(const name of require('../tools/maintenance-receipt-history.cjs').REFRESHED)ticket.checks[name]={passed:true,evidence:[path.join(root,'old-functional.json')]};
    ticket.revisions=Array.from({length:11},(_,sequence)=>({sequence,evidence:[path.join(root,'old-'+sequence+'.json')]}));
  });
  assert.equal(f.code,0);assert.equal(f.summary.ok,true);assert.deepEqual(JSON.parse(await fsp.readFile(f.receipt)),f.ticket);
  const published=JSON.parse(await fsp.readFile(f.output)),evidence=published.revisions.at(-1).evidence;
  assert.deepEqual(published.checks.boundary,f.ticket.checks.boundary);for(const name of require('../tools/maintenance-receipt-history.cjs').REFRESHED){assert.deepEqual(published.checks[name].evidence,evidence);assert.equal(published.checks[name].passed,f.ticket.checks[name].passed);}
  assert.equal(published.revisions.length,10);assert.equal(published.revisions[0].sequence,2);assert.equal(published.archivedRevisionCount,2);
});
test('冷启动计时只量服务本身：夹具准备完再开始，阈值仍是20秒且缺标记判失败',()=>{
  for(const name of ['server-isolation-e2e.cjs','isolation-readiness-startup.cjs']){
    const source=fs.readFileSync(path.join(__dirname,name),'utf8');
    assert.match(source,/serverStarted===undefined\)serverStarted=Date\.now\(\)/);
    assert.match(source,/assert\.ok\(serverStarted!==undefined,'Harness readiness marker missing'\)/);
    assert.match(source,/\.healthMs=Date\.now\(\)-serverStarted;/);assert.doesNotMatch(source,/healthMs=Date\.now\(\)-started/);
    assert.match(source,/healthMs<20000/);
  }
  const serve=fs.readFileSync(path.join(__dirname,'server-isolation-e2e.cjs'),'utf8'),marker=serve.indexOf('process.send({harnessReady:true});');
  assert.equal(serve.indexOf('process.send({harnessReady:true});',marker+1),-1);
  for(const before of ['validateHarnessCandidate({root,config:original','fs.writeFileSync(fixtureConfig.isolation.receipt','fs.symlinkSync(','server.on("listening",()=>process.send({ready:true'])assert.ok(serve.indexOf(before)>=0&&serve.indexOf(before)<marker,before);
  assert.ok(marker<serve.indexOf('mod._compile(source,mod.filename)'));
});
test('A5 冷启动分段计时的插入点在 server.js 里都恰好出现一次，改了 server.js 要同步改夹具', () => {
  const serve = fs.readFileSync(path.join(__dirname, 'server-isolation-e2e.cjs'), 'utf8'), server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const { PHASES, instrumentStartup } = require('./acceptance/startup-phases.cjs');
  assert.deepEqual(PHASES.map(n => n[1]), ['gate-start', 'gate-done', 'isolation-ready', 'page-shell-created']);
  for (const [needle, mark] of PHASES) assert.equal(server.split(needle).length - 1, 1, mark);
  // 插好标记的副本必须还能编译：11-10 那次把标记插到了 try 块和 catch 之间，候选服务一启动就语法错误。
  const { source, missing } = instrumentStartup(server);
  assert.deepEqual(missing, []);
  assert.doesNotThrow(() => new (require('node:vm').Script)(require('node:module').wrap(source), { filename: 'server.js' }));
  assert.match(source, /createIsolation\(config, ROOT\);process\.send\(\{phase:"isolation-ready"\}\);\s*\}\s*\n\s*catch \(e\)/);
  assert.match(serve, /startup\.phases=\{\.\.\.phases,firstPage:startup\.healthMs\}/);
  assert.ok(serve.indexOf('instrumentStartup(source)') < serve.indexOf('process.send({harnessReady:true});'), '标记要在开始计时前插好');
});
