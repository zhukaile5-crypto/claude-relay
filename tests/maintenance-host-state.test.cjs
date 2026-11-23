'use strict';
// 所有child_process调用都注入内存替身；本文件不执行PowerShell、不睡眠、不启动真实验收。
const test=require('node:test'),assert=require('node:assert/strict');
const host=require('../tools/maintenance-host-state.cjs'),acceptance=require('../tools/maintenance-acceptance.cjs');
const event=(overrides={})=>({schema:1,provider:'kernel-power',eventId:107,recordId:'12345',ticks:'639000000000000000',...overrides});
function reader(responses,options={}){
  const calls=[];let index=0;
  const read=host.createHostStateReader({platform:'win32',systemRoot:'C:\\Windows',...options,execFile:(exe,args,opts,done)=>{
    calls.push({exe,args,opts});const value=responses[Math.min(index++,responses.length-1)];
    if(value?.throw)throw Error('synthetic private error');
    queueMicrotask(()=>done(value?.error||null,value?.stdout??JSON.stringify(value?.event||event()),value?.stderr||''));
  }});
  return{read,calls};
}
test('M8 电源查询固定绝对PowerShell路径、无shell/配置文件、隐藏窗口与有限输出时间',async()=>{
  const h=reader([{event:event()}]);const state=await h.read(),call=h.calls[0];
  assert.equal(call.exe,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(call.opts.windowsHide,true);assert.equal(call.opts.shell,false);assert.equal(call.opts.timeout,5000);assert.equal(call.opts.maxBuffer,2048);
  for(const arg of ['-NoProfile','-NonInteractive','-WindowStyle','Hidden'])assert.ok(call.args.includes(arg));
  const script=call.args.at(-1);assert.match(script,/Get-WinEvent -ListLog System/);assert.match(script,/-MaxEvents 1/);
  for(const id of ['42,107,506,507','Power-Troubleshooter'])assert.ok(script.includes(id));
  assert.doesNotMatch(script,/\.Message|\.Properties|FormatDescription|\.ToXml|Start-Process|SetSuspendState|powercfg|schtasks/i);
  assert.deepEqual(Object.keys(state).sort(),['sleeping','transition']);assert.equal(state.sleeping,false);
  assert.match(state.transition,/^windows-power-v1:[a-f0-9]{64}$/);assert.ok(!state.transition.includes('12345'));
});
test('M8 相同固定元数据得到稳定token，记录ID/时间/事件类型变化都会改变token',async()=>{
  const values=[event(),event(),event({recordId:'12346'}),event({ticks:'639000000050000000'}),event({eventId:42}),
    event({eventId:506}),event({eventId:507}),event({provider:'power-troubleshooter',eventId:1})];
  const h=reader(values.map(value=>({event:value}))),states=[];for(const _ of values)states.push(await h.read());
  assert.equal(states[0].transition,states[1].transition);
  for(const value of states.slice(2))assert.notEqual(value.transition,states[0].transition);
});
test('M8 查询失败/拒绝访问/超时/无记录/额外stderr/无法启动一律unavailable且不返回错误正文',async()=>{
  for(const response of [{error:Error('synthetic access denied')},{error:{killed:true}},{error:{code:2}},
    {stdout:''},{stderr:'synthetic private diagnostics'},{throw:true}]){
    const h=reader([response]);assert.deepEqual(await h.read(),{unavailable:true});
  }
});
test('M8 严格枚举和字段白名单，不接受任意事件、正文或无效64位字段',async()=>{
  const invalid=[{},[],event({schema:2}),event({provider:'other'}),event({eventId:1}),event({eventId:'107'}),
    event({provider:'power-troubleshooter',eventId:42}),event({recordId:12}),event({recordId:'01'}),event({recordId:'-1'}),
    event({recordId:'9223372036854775808'}),event({ticks:'3155378976000000000'}),event({ticks:'invalid'}),
    {...event(),message:'synthetic event body'}, {...event(),device:'synthetic device'}];
  for(const value of invalid)assert.equal(host.parseSnapshot(JSON.stringify(value)),null);
  assert.equal(host.parseSnapshot('not-json'),null);assert.equal(host.parseSnapshot(' '.repeat(host.MAX_OUTPUT_BYTES+1)),null);
  assert.deepEqual(await reader([{stdout:JSON.stringify({...event(),message:'do not persist'})}]).read(),{unavailable:true});
});
test('M8 非Windows和可疑系统目录/预算在调用runner前拒绝',async()=>{
  for(const options of [{platform:'linux'},{systemRoot:'powershell.exe'},{systemRoot:'\\\\server\\Windows'},
    {systemRoot:'C:\\Windows\\..\\other'},{systemRoot:'C:\\Windows"bad'},{timeoutMs:0},{timeoutMs:16000}]){
    const h=reader([],options);assert.deepEqual(await h.read(),{unavailable:true});assert.equal(h.calls.length,0);
  }
});
test('M8 五秒睡眠且两个时钟都包含睡眠：事件transition变化，不重试不记坏版',async()=>{
  let time=1000,ran=0;const h=reader([{event:event()},{event:event({recordId:'12347',ticks:'639000000050000000'})}]);
  const result=await acceptance.runAttempts({readHostState:h.read,clock:()=>({wallMs:time,monotonicMs:time}),
    runCheck:async()=>{ran++;time+=5000;return{ok:false,failureKind:{stage:'model',kind:'model-protocol',provider:'claude',source:'model-result'}};}});
  assert.equal(ran,1);assert.equal(result.interrupted,true);assert.equal(result.recordVersionFailure,false);assert.equal(result.retried,false);
  assert.equal(result.attempts[0].classification.reason,'host-transition');
});
test('M8 无法取得前置快照不启动验收，后置不可读也不把本次计为坏版',async()=>{
  for(const beforeFailed of [true,false]){
    let ran=0;const h=reader(beforeFailed?[{error:{code:2}}]:[{event:event()},{error:{code:2}}]);
    const result=await acceptance.runAttempts({readHostState:h.read,runCheck:async()=>{ran++;return{ok:false,
      failureKind:{stage:'model',kind:'model-no-output',provider:'gpt',source:'model-result'}};}});
    assert.equal(ran,beforeFailed?0:1);assert.equal(result.interrupted,true);assert.equal(result.recordVersionFailure,false);
  }
});
test('M8 事件稳定时不掩盖真实结构化程序失败',async()=>{
  const h=reader([{event:event()}]);const result=await acceptance.runAttempts({readHostState:h.read,runCheck:async()=>({ok:false,
    failureKind:{stage:'model',kind:'model-protocol',provider:'claude',source:'model-result'}})});
  assert.equal(result.interrupted,false);assert.equal(result.recordVersionFailure,true);assert.equal(result.attemptCount,1);
});
