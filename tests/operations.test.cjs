'use strict';

// Read source files only. All service, filesystem mutation, process and network
// operations inside control.js are replaced with in-memory mocks.
// Run from the project root, or set RELAY_TEST_ROOT to the project to verify.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(process.env.RELAY_TEST_ROOT || process.cwd());
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const controlSource = readSource('control.js');
const serverSource = readSource('server.js');
const clientSource = readSource('public/index.html');
const tests = [];
const test = (name, run) => tests.push({ name, run });

const controlEntry = controlSource.indexOf('(async () => {');
assert(controlEntry >= 0, 'control.js command dispatcher was not found');
// 默认只载入函数；入口测试也在同一套内存替身中执行真实 dispatcher 和锁包装。
const controlFunctions = controlSource.slice(0, controlEntry) + '\nglobalThis.actions = { stop, start, restart, runLockedCommand, verifiedStop, waitForReady };';

function controlHarness({ pid = null, running = false, verification = { state: 'stopped' }, onPing = null, pingResults = null, lockedError = null,
  stopFlagExpected = true, stopError = null, stopOutput = null, stopBeforeFailure = false, alivePids = [], pidProbeError = null, onStop = null,
  dispatchLocked = false, onLockAcquire = null } = {}) {
  const fakeRoot = path.resolve('relay-memory-test');
  const flag = path.join(fakeRoot, 'data', 'stopped-by-owner');
  const pidFile = path.join(fakeRoot, 'data', 'server.pid');
  const controlLog = path.join(fakeRoot, 'logs', 'control.log');
  const files = new Map([[path.join(fakeRoot, 'config.json'), JSON.stringify({ port: 8765 })]]);
  const events = [];
  const scripts = [];
  const errors = [];
  const lockedDispatches = [];
  let clock = 1700000000000, pingCount = 0;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  if (pid) files.set(pidFile, JSON.stringify(pid));
  let serviceRunning = running;
  const fsMock = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error('Mock file missing');
      return files.get(file);
    },
    writeFileSync(file, value) { files.set(file, value); events.push(['write', file]); },
    mkdirSync() {},
    appendFileSync(file, value) { files.set(file, (files.get(file) || '') + value); events.push(['append', file]); },
    rmSync(file) { files.delete(file); events.push(['remove', file]); },
    statSync(file) { if (!files.has(file)) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return {}; },
  };
  const httpMock = {
    get(options, callback) {
      queueMicrotask(() => {
        const up = pingResults ? pingResults[Math.min(pingCount, pingResults.length - 1)] : serviceRunning;
        pingCount++;
        if (onPing) onPing({ files, flag, pingCount });
        callback({ statusCode: up ? 200 : 503, resume() {} });
      });
      return { on() { return this; }, destroy() {} };
    },
  };
  const childMock = {
    execFileSync(command, args, options) {
      assert.equal(command, 'powershell.exe');
      assert.equal(options.windowsHide, true);
      const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
      scripts.push(script);
      if (script.includes('function Hold-Process')) {
        assert.equal(files.has(flag), stopFlagExpected, '停止标记必须与手动停止或重启的意图一致');
        if (onStop) onStop({ files, pidFile });
        if (stopBeforeFailure) { events.push(['kill-verified']); serviceRunning = false; }
        if (stopError) throw stopError;
        if (stopOutput !== null) return stopOutput;
        if (verification.state === 'stopped') { events.push(['kill-verified']); serviceRunning = false; }
        return JSON.stringify(verification);
      }
      events.push(['locked-command']);
      if (lockedError) throw lockedError;
      if (dispatchLocked) {
        // 不执行 PowerShell；模拟锁等待后调用真实锁内子命令入口。
        const match = script.match(/'(start|auto-start|stop|restart|auto-restart)' '--control-lock-held'/);
        assert(match, '锁包装必须保留原始控制命令');
        assert(script.indexOf('$mutex.WaitOne(') < script.indexOf('--control-lock-held'), '先获得互斥锁再运行子命令');
        if (onLockAcquire) onLockAcquire({ files, flag, events });
        context.process.argv = [process.execPath, path.join(fakeRoot, 'control.js'), match[1], '--control-lock-held'];
        lockedDispatches.push(vm.runInContext(controlSource.slice(controlEntry), context, { timeout: 1000 }));
      }
      return '';
    },
    spawn(command, args) {
      assert(!files.has(flag), 'Start must clear the stop flag before launching');
      events.push(['spawn', command, Array.from(args)]);
      serviceRunning = true;
      return { unref() {} };
    },
  };
  const modules = { fs: fsMock, path, http: httpMock, crypto: require('node:crypto'), child_process: childMock };
  const context = {
    __dirname: fakeRoot,
    __filename: path.join(fakeRoot, 'control.js'),
    Buffer,
    require(name) { assert(Object.hasOwn(modules, name), `Unexpected require: ${name}`); return modules[name]; },
    process: {
      argv: [], execPath: process.execPath, stdout: { write() {} },
      kill(pid, signal) {
        assert.equal(signal, 0, '失败恢复只能查询进程，不得发出终止信号');
        events.push(['probe-pid', pid]);
        if (pidProbeError) throw pidProbeError;
        if (!alivePids.includes(pid)) throw Object.assign(new Error('不存在'), { code: 'ESRCH' });
      },
    },
    console: { log() {}, error(value) { errors.push(String(value)); } },
    setTimeout(callback, delay) { clock += delay; queueMicrotask(callback); return 0; },
    Date: FakeDate,
  };
  vm.createContext(context);
  vm.runInContext(controlFunctions, context, { timeout: 1000 });
  return { ...context.actions, files, flag, pidFile, controlLog, events, scripts, errors,
    async runEntry(command) {
      context.process.argv = [process.execPath, path.join(fakeRoot, 'control.js'), command];
      await vm.runInContext(controlSource.slice(controlEntry), context, { timeout: 1000 });
      await Promise.all(lockedDispatches);
    },
    elapsed: () => clock - 1700000000000, pingCount: () => pingCount, exitCode: () => context.process.exitCode };
}

test('stop without PID writes the stop flag without terminating a process', async () => {
  const h = controlHarness();
  await h.stop();
  assert(h.files.has(h.flag));
  assert(!h.events.some((event) => event[0] === 'kill-verified'));
});
test('stop after a crash writes the stop flag despite a stale PID file', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100 } });
  await h.stop();
  assert(h.files.has(h.flag));
  assert(!h.events.some((event) => event[0] === 'kill-verified'));
});
test('live stop marks intent before the existing process-tree termination', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true });
  await h.stop();
  assert(h.files.has(h.flag));
  assert(!h.files.has(h.pidFile));
  assert.deepEqual(h.events.find((event) => event[0] === 'kill-verified'), ['kill-verified']);
});
test('start while already running clears the flag without duplicate launch', async () => {
  const h = controlHarness({ running: true });
  h.files.set(h.flag, 'old');
  await h.start();
  assert(!h.files.has(h.flag));
  assert(!h.events.some((event) => event[0] === 'spawn'));
});
test('start while stopped clears the flag and launches exactly once', async () => {
  const h = controlHarness();
  h.files.set(h.flag, 'old');
  await h.start();
  assert(!h.files.has(h.flag));
  assert.equal(h.events.filter((event) => event[0] === 'spawn').length, 1);
});
test('restart stop/start sequence remains compatible', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true });
  await h.stop();
  await h.start();
  assert(!h.files.has(h.flag));
  assert.equal(h.events.filter((event) => event[0] === 'kill-verified').length, 1);
  assert.equal(h.events.filter((event) => event[0] === 'spawn').length, 1);
});

test('M2 重启调用真实控制流程且从不写人工停止标记', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true, stopFlagExpected: false });
  h.files.set(h.flag, '旧的手动停止意图');
  assert.equal(await h.restart(), true);
  assert(!h.files.has(h.flag));
  assert(!h.events.some(e => e[0] === 'write' && e[1] === h.flag));
  assert.equal(h.events.filter(e => e[0] === 'kill-verified').length, 1);
  assert.equal(h.events.filter(e => e[0] === 'spawn').length, 1);
  assert.match(controlSource.slice(controlEntry), /cmd === 'restart'[\s\S]*await restart\(\)/);
});

test('M2 停止子进程抛错后原进程已退出则继续启动并留下错误输出', async () => {
  const failure = Object.assign(new Error('Command failed: powershell.exe -EncodedCommand SYNTHETIC_ENCODED_COMMAND'), {
    status: 1, stderr: 'SYNTHETIC_CHILD_KILL_FAILURE', stdout: 'SYNTHETIC_STOP_OUTPUT',
  });
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true,
    stopFlagExpected: false, stopError: failure, stopBeforeFailure: true });
  assert.equal(await h.restart(), true);
  assert.equal(h.events.filter(e => e[0] === 'spawn').length, 1);
  assert(!h.files.has(h.flag));
  const log = h.files.get(h.controlLog);
  assert.match(log, /SYNTHETIC_CHILD_KILL_FAILURE/); assert.match(log, /SYNTHETIC_STOP_OUTPUT/);
  assert(!log.includes('SYNTHETIC_ENCODED_COMMAND'));
  assert.deepEqual(h.events.filter(e => e[0] === 'probe-pid').map(e => e[1]), [101, 100]);
});

for (const output of ['SYNTHETIC_BAD_JSON', 'null']) test('M2 停止返回无效 JSON 或结构后可安全恢复：' + output, async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true,
    stopFlagExpected: false, stopOutput: output, stopBeforeFailure: true });
  assert.equal(await h.restart(), true);
  assert.equal(h.events.filter(e => e[0] === 'spawn').length, 1);
  assert(!h.files.has(h.flag));
  assert.match(h.files.get(h.controlLog), /不是有效 JSON/);
  assert(h.files.get(h.controlLog).includes(output));
});

for (const live of [[101], [100]]) test('M2 停止失败且进程仍存活时不启动竞争服务：' + live[0], async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true, stopFlagExpected: false,
    stopError: new Error('SYNTHETIC_STOP_FAILURE'), alivePids: live });
  assert.equal(await h.restart(), false);
  assert(!h.events.some(e => e[0] === 'spawn'));
  assert(!h.files.has(h.flag));
  assert.match(h.files.get(h.controlLog), /未启动另一个服务/);
});

test('M2 停止失败后发现新 PID 时保留记录且不启动竞争服务', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: false, stopFlagExpected: false,
    stopError: new Error('SYNTHETIC_STOP_FAILURE'), alivePids: [202],
    onStop: ({ files, pidFile }) => files.set(pidFile, JSON.stringify({ pid: 202, ppid: 200, startedAt: 2000 })) });
  assert.equal(await h.restart(), false);
  assert.equal(JSON.parse(h.files.get(h.pidFile)).pid, 202);
  assert(!h.events.some(e => e[0] === 'spawn'));
  assert(!h.files.has(h.flag));
});

test('M2 进程查询无权限时不把未知状态当成已经退出', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, stopFlagExpected: false,
    stopError: new Error('SYNTHETIC_STOP_FAILURE'), pidProbeError: Object.assign(new Error('拒绝访问'), { code: 'EPERM' }) });
  assert.equal(await h.restart(), false);
  assert(!h.events.some(e => e[0] === 'spawn'));
  assert(!h.files.has(h.flag));
});

for (const running of [true, false]) test('M2 身份不符时不杀进程、不另起服务且不禁用看门狗：' + running, async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running, stopFlagExpected: false,
    verification: { state: 'refused' } });
  assert.equal(await h.restart(), false);
  assert(!h.events.some(e => ['kill-verified', 'spawn', 'probe-pid'].includes(e[0])));
  assert(h.files.has(h.pidFile));
  assert(!h.files.has(h.flag));
  assert.match(h.files.get(h.controlLog), /身份与记录不符/);
});

test('M2 子进程清理警告会落盘但不阻止已经停止的服务重启', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true, stopFlagExpected: false,
    verification: { state: 'stopped', warnings: ['PID 102: SYNTHETIC_CHILD_KILL_FAILURE'] } });
  assert.equal(await h.restart(), true);
  assert.match(h.files.get(h.controlLog), /PID 102: SYNTHETIC_CHILD_KILL_FAILURE/);
  assert(!h.files.has(h.flag));
});

test('M2 启动未恢复时返回错误且看门狗仍可接手', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true,
    stopFlagExpected: false, pingResults: [false] });
  assert.equal(await h.restart(), false);
  assert(!h.files.has(h.flag));
  assert.equal(h.events.filter(e => e[0] === 'spawn').length, 1);
  assert.match(h.files.get(h.controlLog), /重启未完成/);
});

test('M2 重启途中出现的新手动停止意图仍被保留', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true, stopFlagExpected: false,
    onPing: ({ files, flag, pingCount }) => { if (pingCount === 1) files.set(flag, '新的手动停止请求'); } });
  assert.equal(await h.restart(), false);
  assert.equal(h.files.get(h.flag), '新的手动停止请求');
  assert(!h.events.some(e => e[0] === 'spawn'));
});

test('M2 手动停止失败仍保留人工停止标记，不自动恢复', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true,
    stopError: new Error('SYNTHETIC_MANUAL_STOP_FAILURE') });
  assert.equal(await h.stop(), false);
  assert(h.files.has(h.flag));
  assert(!h.events.some(e => ['spawn', 'probe-pid'].includes(e[0])));
  assert.match(h.files.get(h.controlLog), /SYNTHETIC_MANUAL_STOP_FAILURE/);
});

test('automatic start preserves an existing manual stop flag', async () => {
  const h = controlHarness();
  h.files.set(h.flag, 'owner');
  assert.equal(await h.start(true), false);
  assert.equal(h.files.get(h.flag), 'owner');
  assert(!h.events.some((e) => e[0] === 'spawn' || (e[0] === 'remove' && e[1] === h.flag)));
});
test('automatic start rechecks owner intent after its awaited health probe', async () => {
  const h = controlHarness({ onPing: ({ files, flag }) => files.set(flag, 'stopped during ping') });
  assert.equal(await h.start(true), false);
  assert(h.files.has(h.flag));
  assert(!h.events.some((e) => e[0] === 'spawn'));
});
test('unrequested automatic recovery still launches once', async () => {
  const h = controlHarness();
  await h.start(true);
  assert.equal(h.events.filter((e) => e[0] === 'spawn').length, 1);
  assert(!h.events.some((e) => e[0] === 'remove' && e[1] === h.flag));
});
test('refused PID identity preserves the record and never terminates a process', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, verification: { state: 'refused' } });
  assert.equal(await h.stop(), false);
  assert(h.files.has(h.flag));
  assert(h.files.has(h.pidFile));
  assert(!h.events.some((e) => e[0] === 'kill-verified'));
});
test('stop does not erase a newer instance PID record', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1000 }, onPing: ({ files }) => {
    files.set(h.pidFile, JSON.stringify({ pid: 202, ppid: 200, startedAt: 2000 }));
  } });
  await h.stop();
  assert.equal(JSON.parse(h.files.get(h.pidFile)).pid, 202);
});
test('all changing commands use one Windows mutex and always release it', () => {
  const h = controlHarness();
  for (const command of ['start', 'auto-start', 'stop', 'restart', 'auto-restart']) h.runLockedCommand(command);
  assert.equal(h.scripts.length, 5);
  const names = h.scripts.map((s) => s.match(/Global\\ClaudeRelayControl-[a-f0-9]+/)[0]);
  assert.equal(new Set(names).size, 1);
  for (const script of h.scripts) {
    assert(script.includes('AbandonedMutexException'));
    assert(script.includes('--control-lock-held'));
    assert(script.includes('finally {'));
    assert(script.includes('$mutex.ReleaseMutex()'));
  }
});
test('M15 自动重启实际入口等待锁期间的人工停止优先且不会被删除', async () => {
  const h = controlHarness({ dispatchLocked: true,
    onLockAcquire: ({ files, flag, events }) => { events.push(['owner-stop-before-lock']); files.set(flag, '机主先完成停止'); } });
  assert(!h.files.has(h.flag), '启动维护请求时还没有停止标记');
  await h.runEntry('auto-restart');
  assert.equal(h.scripts.length, 1, '实际入口必须先经过控制互斥锁');
  assert.equal(h.files.get(h.flag), '机主先完成停止');
  assert.equal(h.exitCode(), 1, '跳过维护重启必须报告未完成');
  assert.equal(h.pingCount(), 0, '锁内发现人工停止后不能继续启停探测');
  assert.deepEqual(h.events.map(event => event[0]), ['locked-command', 'owner-stop-before-lock']);
});
test('M15 自动重启实际锁内入口在没有人工停止时正常完成且不清除意图', async () => {
  const h = controlHarness({ dispatchLocked: true, pid: { pid: 101, ppid: 100, startedAt: 1000 }, running: true, stopFlagExpected: false });
  await h.runEntry('auto-restart');
  assert.equal(h.exitCode(), undefined);
  assert.equal(h.events.filter(event => event[0] === 'locked-command').length, 1);
  assert.equal(h.events.filter(event => event[0] === 'kill-verified').length, 1);
  assert.equal(h.events.filter(event => event[0] === 'spawn').length, 1);
  assert(!h.events.some(event => event[0] === 'remove' && event[1] === h.flag));
});
test('M15 机主显式重启实际入口仍可撤销等待锁时已有的停止意图', async () => {
  const h = controlHarness({ dispatchLocked: true, stopFlagExpected: false,
    onLockAcquire: ({ files, flag }) => files.set(flag, '机主停止') });
  await h.runEntry('restart');
  assert.equal(h.exitCode(), undefined);
  assert.equal(h.events.filter(event => event[0] === 'locked-command').length, 1);
  assert.equal(h.events.filter(event => event[0] === 'spawn').length, 1);
  assert(!h.files.has(h.flag));
});

test('successful startup requires four seconds of health and does not probe again for status', async () => {
  const h = controlHarness();
  assert.equal(await h.start(), true);
  assert.equal(h.elapsed(), 4500);
  assert.equal(h.pingCount(), 10); // One initial probe plus nine stability probes; no final status probe.
});
test('a transient startup disconnect resets the stability window and recovers', async () => {
  const h = controlHarness({ pingResults: [false, true, true, false, true] });
  assert.equal(await h.start(), true);
  assert.equal(h.elapsed(), 6000);
  assert.equal(h.pingCount(), 13);
  assert.equal(h.events.filter((e) => e[0] === 'spawn').length, 1);
});
test('a server that never becomes healthy fails within the startup deadline', async () => {
  const h = controlHarness({ pingResults: [false] });
  assert.equal(await h.start(), false);
  assert.equal(h.elapsed(), 20000);
  assert.equal(h.events.filter((e) => e[0] === 'spawn').length, 1);
});
test('automatic readiness wait preserves a stop request received during startup', async () => {
  const h = controlHarness({ onPing: ({ files, flag, pingCount }) => { if (pingCount === 3) files.set(flag, 'owner'); } });
  assert.equal(await h.start(true), false);
  assert.equal(h.files.get(h.flag), 'owner');
  assert(h.elapsed() < 4000);
});
test('the mutex wrapper propagates child failure without repeating its encoded command', () => {
  const h = controlHarness({ lockedError: Object.assign(new Error('Command failed: encoded script'), { status: 7 }) });
  assert.doesNotThrow(() => h.runLockedCommand('restart'));
  assert.equal(h.exitCode(), 7);
});
test('the mutex wrapper still reports an invocation failure without an exit status', () => {
  const error = Object.assign(new Error('PowerShell could not be launched'), { code: 'ENOENT' });
  const h = controlHarness({ lockedError: error });
  assert.throws(() => h.runLockedCommand('start'), /PowerShell could not be launched/);
});
test('实际 PowerShell 身份策略拒绝复用或无关 PID，并记录子进程停止错误（十个模拟案例）', async () => {
  const h = controlHarness({ pid: { pid: 101, ppid: 100, startedAt: 1700000000000 }, running: true });
  await h.stop();
  const identity = h.scripts[0];
  h.runLockedCommand('auto-start');
  require('./process-identity-helper.cjs')(identity, h.scripts.slice(1), path.resolve('relay-memory-test'));
});

async function watchdogHarness(stopAt) {
  let flag = stopAt === 'initial', pings = 0;
  const starts = [];
  const modules = {
    fs: {
      readFileSync: () => JSON.stringify({ port: 8765 }), appendFileSync() {},
      statSync() { if (!flag) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return {}; },
    }, path,
    http: { get(options, cb) {
      queueMicrotask(() => { pings++; if (stopAt === 'second-ping' && pings === 2) flag = true; cb({ statusCode: 503, resume() {} }); });
      return { on() { return this; }, destroy() {} };
    } },
    child_process: { execFile(command, args) { starts.push(args); } },
  };
  const context = {
    require: (name) => modules[name], __dirname: path.join(root, 'tools'), process: { execPath: process.execPath },
    setTimeout(cb) { if (stopAt === 'delay') flag = true; queueMicrotask(cb); }, Date,
  };
  await vm.runInNewContext(readSource('tools/service_watchdog.js'), context);
  return starts;
}
for (const when of ['initial', 'delay', 'second-ping']) test('watchdog preserves manual stop during ' + when, async () => {
  assert.equal((await watchdogHarness(when)).length, 0);
});
test('watchdog requests automatic rather than manual start', async () => {
  const starts = await watchdogHarness(null);
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1], 'auto-start');
});

const canDropStart = clientSource.indexOf('function canDropIn(');
const canDropEnd = clientSource.indexOf('function dragStart(', canDropStart);
assert(canDropStart >= 0 && canDropEnd > canDropStart, 'Client drag eligibility function was not found');
const clientContext = { S: { projects: [{ id: 'project-a' }, { id: 'project-b' }] } };
vm.createContext(clientContext);
vm.runInContext(clientSource.slice(canDropStart, canDropEnd), clientContext, { timeout: 1000 });

for (const [name, conversation, section, expected] of [
  ['ordinary conversation can remain in ordinary section', {}, 'main', true],
  ['ordinary conversation cannot enter a project by drag', {}, 'p:project-a', false],
  ['project conversation cannot leave its project by drag', { projectId: 'project-a' }, 'main', false],
  ['project conversation cannot enter another project by drag', { projectId: 'project-a' }, 'p:project-b', false],
  ['sorting within the same project remains available', { projectId: 'project-a' }, 'p:project-a', true],
  ['project conversation can still enter favorites', { projectId: 'project-a' }, 'star', true],
  ['ordinary conversation can still enter favorites', {}, 'star', true],
]) {
  test(name, () => assert.equal(clientContext.canDropIn(conversation, section), expected));
}

const patchAnchor = serverSource.indexOf('// 对话属于哪个项目只在新建时定');
assert(patchAnchor >= 0, 'Conversation PATCH ownership boundary was not found');
const patchPrefix = "    if (req.method === 'PATCH') {";
const patchStart = serverSource.lastIndexOf(patchPrefix, patchAnchor);
const patchEnd = serverSource.indexOf('\n    }', patchAnchor);
assert(patchStart >= 0 && patchEnd > patchAnchor, 'Conversation PATCH handler was not found');
const patchBody = serverSource.slice(patchStart + patchPrefix.length, patchEnd);

async function patchConversation(conversation, body) {
  const context = {
    conv: conversation, req: {}, u: {}, res: {}, readJSON: async () => body, m: [null, conversation.id], loadConv: () => conversation,
    jobs: { has: () => false }, jobKey: (user, id) => JSON.stringify([user.id, id]), saveConv() {}, broadcast() {}, convMeta: (value) => value,
    sendJSON: (response, status, data) => ({ status, data }),
  };
  vm.createContext(context);
  return vm.runInContext('(async () => {' + patchBody + '\n})()', context, { timeout: 1000 });
}

for (const [name, initial, requested] of [
  ['server PATCH cannot move an ordinary conversation into a project', {}, 'project-a'],
  ['server PATCH cannot move a project conversation out', { projectId: 'project-a' }, null],
  ['server PATCH cannot move a conversation to another project', { projectId: 'project-a' }, 'project-b'],
]) {
  test(name, async () => {
    const conversation = { id: 'c', title: 'Example', ...initial };
    await patchConversation(conversation, { projectId: requested });
    assert.equal(conversation.projectId, initial.projectId);
  });
}
test('server PATCH retains favorite changes and sort position set/reset', async () => {
  const conversation = { id: 'c', title: 'Example', projectId: 'project-a' };
  await patchConversation(conversation, { starred: true, sortAt: 1000.7 });
  assert.equal(conversation.starred, true);
  assert.equal(conversation.sortAt, 1001);
  assert.equal(conversation.projectId, 'project-a');
  await patchConversation(conversation, { starred: false, sortAt: null });
  assert.equal(conversation.starred, false);
  assert(!Object.hasOwn(conversation, 'sortAt'));
  assert.equal(conversation.projectId, 'project-a');
});
test('project creation and new-conversation project assignment remain present (static)', () => {
  assert(clientSource.includes("post('/api/projects', { name, description:"));
  assert(serverSource.includes('const proj = await createProject(u, { name, description:'));
  assert(serverSource.includes('if (loadProject(u, body.projectId)) conv.projectId = body.projectId;'));
});
test('old move-to-project menu labels and function names remain absent (static)', () => {
  assert(!/moveToProject|moveConvToProject|移入项目|移出项目|移动到项目/.test(clientSource));
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log('PASS ' + name);
  }
  assert(tests.length >= 29);
  console.log(`${tests.length}/${tests.length} passed; source reads and in-memory mocks only.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
