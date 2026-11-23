'use strict';
// 临时目录中的真实文件读写；Git、验收、进程和网络全部替换，不触及线上服务。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { repair } = require('../tools/maintenance-repair.cjs');
const deployment = require('../tools/maintenance-deploy.cjs');
const inspection = require('../tools/maintenance-repair-inspect.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-m5-'));
  t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase()); assert.ok(path.basename(real).startsWith('relay-m5-')); await fs.rm(real, { recursive: true, force: true }); });
  const sourcePath = path.join(root, 'server.js'), receipt = path.join(root, 'receipt.json'), runtimePath = path.join(root, 'runtime.txt');
  await fs.writeFile(sourcePath, 'new-source'); await fs.writeFile(runtimePath, 'runtime-v1');
  const runtimeSha = digest('runtime-v1'); await fs.writeFile(receipt, JSON.stringify({ source: digest('old-source'), runtime: runtimeSha }));
  const f = { root, dirty: false, stopped: false, unreadable: false, head: 'a'.repeat(40), headSource: digest('new-source'), runtimeSha,
    accepts: 0, starts: 0, notices: [], additional: [] };
  const snapshot = async () => {
    if (f.unreadable) return { readable: false };
    const source = await fs.readFile(sourcePath), receiptBytes = await fs.readFile(receipt), record = JSON.parse(receiptBytes), runtime = await fs.readFile(runtimePath);
    const sourceSha256 = digest(source), runtimeNow = digest(runtime), changes = [...f.additional];
    if (record.source !== sourceSha256) changes.push({ kind: 'server', path: sourcePath, sha256: sourceSha256 });
    if (record.runtime !== runtimeNow) changes.push({ kind: 'runtime', path: runtimePath, sha256: runtimeNow });
    const filesFingerprint = digest(JSON.stringify([sourceSha256, runtimeNow, f.additional]));
    return { readable: true, gateReady: changes.length === 0, filesFingerprint,
      fingerprint: digest(filesFingerprint + digest(receiptBytes)), sourceSha256, receiptSha256: digest(receiptBytes), changes, reasons: [] };
  };
  f.d = { root, sourcePath, receipt, state: path.join(root, 'state.json'),
    lastGoodDir: path.join(root, 'last-good'), transactionsDir: path.join(root, 'transactions'),
    repairAttemptsDir: path.join(root, 'repair-attempts'), repairSnapshot: snapshot,
    gitState: async () => ({ clean: !f.dirty, sourceMatchesHead: digest(await fs.readFile(sourcePath)) === f.headSource,
      head: f.head, headSourceSha256: f.headSource }),
    stoppedByOwner: () => f.stopped, preview: async () => ({ ok: true, changed: true }),
    accept: async ({ outputReceipt }) => { f.accepts++; await fs.writeFile(outputReceipt, JSON.stringify({ source: digest(await fs.readFile(sourcePath)), runtime: digest(await fs.readFile(runtimePath)) })); return { ok: true }; },
    waitNoJobs: async () => true, restartAndVerify: async () => { f.starts++; return true; },
    gateOk: async () => (await snapshot()).gateReady,
    checkpointCompatible: async checkpoint => { try { const value = JSON.parse(checkpoint.receipt); return value.source === digest(checkpoint.source) && value.runtime === digest(await fs.readFile(runtimePath)); } catch { return false; } },
    notice: message => { f.notices.push(message); }, log() {}, now: () => 1,
  };
  return f;
}
test('只有干净且与 HEAD 相同的源码变化才能完成真实临时文件部署', async t => {
  const f = await fixture(t);
  const result = await repair({}, f.d); assert.equal(result, 'deployed', f.notices.join('\n')); assert.equal(f.accepts, 1); assert.equal(f.starts, 1);
  assert.equal((await f.d.repairSnapshot()).gateReady, true);
  assert.equal((await fs.readdir(f.d.repairAttemptsDir)).length, 1);
  assert.equal(await repair({}, f.d), 'repair-not-needed'); assert.equal(f.accepts, 1);
});
test('验收失败后同一完整状态只能尝试一次，重建依赖也不重试', async t => {
  const f = await fixture(t); f.d.accept = async () => { f.accepts++; return { ok: false }; };
  assert.equal(await repair({}, f.d), 'acceptance-failed');
  assert.equal(await repair({}, { ...f.d }), 'repair-already-attempted');
  assert.equal(f.accepts, 1); assert.equal(f.starts, 0);
});
test('原子占位阻止两个并发修复重复验收', async t => {
  const f = await fixture(t); f.d.accept = async () => { f.accepts++; return { ok: false }; };
  const results = await Promise.all([repair({}, f.d), repair({}, { ...f.d })]);
  assert.equal(f.accepts, 1); assert.ok(results.includes('repair-already-attempted'));
});
for (const kind of ['program', 'isolation', 'runtime', 'config', 'unknown']) {
  test(kind + ' 单独或混合漂移都不得自动验收', async t => {
    const f = await fixture(t); f.additional = [{ kind, path: path.join(f.root, 'other') }];
    assert.equal(await repair({}, f.d), 'repair-refused');
    await fs.writeFile(f.d.receipt, JSON.stringify({ source: f.headSource, runtime: f.runtimeSha }));
    assert.equal(await repair({}, f.d), 'repair-refused'); assert.equal(f.accepts, 0); assert.equal(f.starts, 0);
  });
}
for (const reason of ['dirty', 'head-mismatch', 'unknown-state', 'bad-clean-value']) {
  test(reason + ' 时不自动验收', async t => {
    const f = await fixture(t);
    if (reason === 'dirty') f.dirty = true;
    if (reason === 'head-mismatch') f.headSource = digest('different-head');
    if (reason === 'unknown-state') f.unreadable = true;
    if (reason === 'bad-clean-value') { const original = f.d.gitState; f.d.gitState = async () => ({ ...await original(), clean: 'true' }); }
    assert.equal(await repair({}, f.d), 'repair-refused'); assert.equal(f.accepts, 0);
  });
}
test('提交状态在快照读取之间改变时拒绝', async t => {
  const f = await fixture(t), original = f.d.gitState; let count = 0;
  f.d.gitState = async () => ({ ...await original(), head: (++count === 1 ? 'a' : 'b').repeat(40) });
  assert.equal(await repair({}, f.d), 'repair-refused'); assert.equal(f.accepts, 0);
});
for (const phase of ['preview', 'accept', 'wait']) {
  test(phase + ' 期间出现新的运行文件漂移时不安装候选记录、不重启', async t => {
    const f = await fixture(t), originalReceipt = await fs.readFile(f.d.receipt);
    const name = { preview: 'preview', accept: 'accept', wait: 'waitNoJobs' }[phase], original = f.d[name];
    f.d[name] = async (...args) => { const result = await original(...args); await fs.writeFile(path.join(f.root, 'runtime.txt'), 'runtime-v2'); return result; };
    assert.notEqual(await repair({}, f.d), 'deployed');
    assert.deepEqual(await fs.readFile(f.d.receipt), originalReceipt); assert.equal(f.starts, 0);
  });
}
for (const mutation of ['head', 'dirty', 'unreadable', 'manual-stop']) {
  test('等待期间 ' + mutation + ' 阻止记录替换和重启', async t => {
    const f = await fixture(t), before = await fs.readFile(f.d.receipt);
    f.d.waitNoJobs = async () => { if (mutation === 'head') f.head = 'b'.repeat(40); if (mutation === 'dirty') f.dirty = true;
      if (mutation === 'unreadable') f.unreadable = true; if (mutation === 'manual-stop') f.stopped = true; return true; };
    assert.notEqual(await repair({}, f.d), 'deployed'); assert.equal(f.starts, 0); assert.deepEqual(await fs.readFile(f.d.receipt), before);
  });
}
test('不能保存尝试记录时不验收', async t => {
  const f = await fixture(t); await fs.writeFile(f.d.repairAttemptsDir, 'not-a-directory');
  assert.equal(await repair({}, f.d), 'repair-refused'); assert.equal(f.accepts, 0);
});
test('一次未完成的尝试凭据也阻止重试', async t => {
  const f = await fixture(t); f.d.accept = async () => ({ ok: false }); await repair({}, f.d);
  const entries = await fs.readdir(f.d.repairAttemptsDir); await fs.writeFile(path.join(f.d.repairAttemptsDir, entries[0]), '');
  assert.equal(await repair({}, f.d), 'repair-already-attempted');
});
test('新的文件状态和新的提交可再次尝试', async t => {
  const f = await fixture(t); f.d.accept = async () => { f.accepts++; return { ok: false }; };
  await repair({}, f.d); await fs.writeFile(f.d.sourcePath, 'next-source'); f.headSource = digest('next-source'); f.head = 'c'.repeat(40);
  assert.equal(await repair({}, f.d), 'acceptance-failed'); assert.equal(f.accepts, 2);
});
test('未完成升级交给 M1，恢复结果不会继续触发源码验收', async t => {
  const f = await fixture(t); f.d.recoverPending = async () => ({ result: 'recovered' });
  assert.equal(await repair({}, f.d), 'recovered'); assert.equal(f.accepts, 0);
  f.d.recoverPending = async () => ({ result: 'recovery-refused', fatal: true });
  assert.equal(await repair({}, f.d), 'recovery-refused'); assert.equal(f.accepts, 0);
  f.d.recoverPending = async () => ({ result: 'transaction-active' });
  assert.equal(await repair({}, f.d), 'repair-refused');
});
test('保持人工停止语义', async t => {
  const f = await fixture(t); f.stopped = true;
  assert.equal(await repair({}, f.d), 'stopped-by-owner'); assert.equal(f.accepts, 0);
});
async function recoveredFiles(t) {
  const f = await fixture(t); await fs.writeFile(f.d.receipt, JSON.stringify({ source: f.headSource, runtime: f.runtimeSha }));
  f.blocked = true; f.d.power = async () => ({ isolationBlocked: f.blocked, running: 0 });
  f.d.restartAndVerify = async () => { f.starts++; f.blocked = false; return true; };
  return f;
}
test('文件已恢复一致但进程仍受限时只重启一次，不验收也不改记录', async t => {
  const f = await recoveredFiles(t), before = await fs.readFile(f.d.receipt);
  assert.equal(await repair({}, f.d), 'repair-restarted');
  assert.equal(f.starts, 1); assert.equal(f.accepts, 0); assert.deepEqual(await fs.readFile(f.d.receipt), before);
  assert.equal(await repair({}, f.d), 'repair-not-needed'); assert.equal(f.starts, 1);
});
test('重启后仍受限时相同状态不再循环重启', async t => {
  const f = await recoveredFiles(t); f.d.restartAndVerify = async () => { f.starts++; return true; };
  assert.equal(await repair({}, f.d), 'repair-restart-failed');
  assert.equal(await repair({}, f.d), 'repair-already-attempted'); assert.equal(f.starts, 1); assert.equal(f.accepts, 0);
});
test('文件一致时未提交的工作区也只允许重启，不产生验收', async t => {
  const f = await recoveredFiles(t); f.dirty = true;
  assert.equal(await repair({}, f.d), 'repair-restarted'); assert.equal(f.accepts, 0);
});
test('受限重启前尊重人工停止，忙时不消耗尝试机会', async t => {
  const f = await recoveredFiles(t), wait = f.d.waitNoJobs;
  f.d.waitNoJobs = async () => { f.stopped = true; return true; };
  assert.equal(await repair({}, f.d), 'repair-refused'); assert.equal(f.starts, 0); f.stopped = false;
  f.d.waitNoJobs = async () => false;
  assert.equal(await repair({}, f.d), 'restart-pending'); assert.equal(f.starts, 0);
  f.d.waitNoJobs = wait; assert.equal(await repair({}, f.d), 'repair-restarted'); assert.equal(f.starts, 1);
});
test('M3 重启失败恢复旧源码和旧记录后仍能启动，即使源码不再等于 HEAD', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.d.sourcePath, 'old-source'); f.headSource = digest('old-source');
  f.d.preview = async () => ({ ok: true, changed: false });
  const baseline = await deployment.deploy({}, f.d); assert.equal(baseline, 'nothing-to-do', f.notices.join('\n'));
  await fs.writeFile(f.d.sourcePath, 'new-source'); f.headSource = digest('new-source'); f.head = 'b'.repeat(40);
  f.d.preview = async () => ({ ok: true, changed: true });
  f.d.restartAndVerify = async () => ++f.starts > 1;
  assert.equal(await repair({}, f.d), 'restart-failed-restored');
  assert.equal(f.starts, 2); assert.equal((await fs.readFile(f.d.sourcePath)).toString(), 'old-source');
});

async function inspectionFixture(t) {
  const f = await fixture(t), runtimeDir = path.join(f.root, 'runtime'), work = path.join(f.root, 'work');
  await fs.mkdir(runtimeDir); await fs.mkdir(work); await fs.mkdir(path.join(f.root, 'isolation'));
  const guardFile = path.join(f.root, 'isolation', 'guard.js'); await fs.writeFile(guardFile, 'guard');
  const entry = path.join(runtimeDir, 'synthetic.exe'); await fs.writeFile(entry, 'synthetic');
  const runtime = Object.fromEntries(['desktopHost', 'nodePath', 'codexPath', 'claudePath', 'python', 'ffmpeg', 'libreOffice', 'xlsxScript'].map(name => [name, entry]));
  const codexRoot = path.join(f.root, 'codex'); await fs.mkdir(path.join(codexRoot, 'bin'), { recursive: true });
  runtime.codexPath = path.join(codexRoot, 'bin', 'codex.exe'); await fs.writeFile(runtime.codexPath, 'synthetic codex');
  await fs.writeFile(path.join(codexRoot, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, variant: 'codex', version: '1.2.3', target: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe' }));
  runtime.whisperModel = runtimeDir;
  const config = { openaiApiKey: 'SYNTHETIC', users: [{ id: 'synthetic', workDir: work }], isolation: { enabled: true,
    runtimeManifest: path.join(f.root, 'manifest.json'), receipt: f.d.receipt } };
  const gate = { SOURCE_FILES: ['server.js', 'isolation/guard.js'], REQUIRED: ['boundary'], RECEIPT_SCHEMA: 2 };
  await fs.writeFile(config.isolation.runtimeManifest, JSON.stringify(runtime)); await fs.writeFile(path.join(f.root, 'config.json'), JSON.stringify(config));
  const files = await inspection.requiredFiles(config, runtime, f.root, gate), fingerprints = [];
  for (const file of files) fingerprints.push({ path: file, sha256: digest(await fs.readFile(file)) });
  const receipt = { schema: 2, completedAt: new Date().toISOString(), checks: { boundary: { passed: true } },
    configurationFingerprint: await inspection.configurationFingerprint(config, runtime, f.root), fingerprints };
  await fs.writeFile(f.d.receipt, JSON.stringify(receipt));
  return { ...f, config, runtime, receipt, gate, entry, guardFile, inspect: () => inspection.inspectRepairState({ root: f.root, gate }) };
}
test('异步快照与现有配置指纹语义一致，并准确区分源码、程序、隔离、配置漂移', async t => {
  const f = await inspectionFixture(t), originalGate = require('../tools/check-isolation.cjs');
  assert.equal(await inspection.configurationFingerprint(f.config, f.runtime, f.root), originalGate.configurationFingerprint(f.config, f.runtime, f.root));
  assert.equal((await f.inspect()).gateReady, true);
  await fs.writeFile(f.d.sourcePath, 'changed'); let report = await f.inspect();
  assert.equal(report.readable, true); assert.deepEqual(report.changes.map(c => c.kind), ['server']);
  await fs.writeFile(f.entry, 'updated-program'); report = await f.inspect(); assert.ok(report.changes.some(c => c.kind === 'program'));
  await fs.writeFile(f.guardFile, 'changed-boundary'); report = await f.inspect(); assert.ok(report.changes.some(c => c.kind === 'isolation'));
  f.config.users[0].id = 'another'; await fs.writeFile(path.join(f.root, 'config.json'), JSON.stringify(f.config));
  report = await f.inspect(); assert.ok(report.changes.some(c => c.kind === 'config'));
});
test('任何不可读或缺失文件都不给出可自动使用的文件指纹', async t => {
  const f = await inspectionFixture(t); await fs.unlink(f.entry);
  const report = await f.inspect(); assert.equal(report.readable, false); assert.equal(report.fingerprint, null);
});
test('新增未覆盖运行脚本和未完成边界项不能被认为只有源码变化', async t => {
  const f = await inspectionFixture(t); f.runtime.pathDirs = [path.dirname(f.entry)];
  await fs.writeFile(f.config.isolation.runtimeManifest, JSON.stringify(f.runtime));
  await fs.writeFile(path.join(path.dirname(f.entry), 'new.py'), 'synthetic');
  const report = await f.inspect(); assert.ok(report.changes.some(c => c.kind === 'runtime'));
  f.receipt.checks.boundary.passed = false; await fs.writeFile(f.d.receipt, JSON.stringify(f.receipt));
  assert.ok((await f.inspect()).changes.some(c => c.kind === 'unknown'));
});

test('本地状态携带受限原因，远程和隧道请求仍然不可见', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
  const begin = source.indexOf("  if (p.startsWith('/local/')) {"), end = source.indexOf("\n  if (!p.startsWith('/api/'))", begin);
  const run = async (remote, forwarded, blocked) => {
    let response = {}; const context = { p: '/local/power', req: { method: 'GET', socket: { remoteAddress: remote }, headers: forwarded ? { 'cf-connecting-ip': '1.1.1.1' } : {} },
      res: { writeHead: code => { response.status = code; }, end: text => { response.body = text; } }, isLoopback: value => value === '127.0.0.1',
      sendJSON: (_, status, body) => { response = { status, body }; }, jobs: { size: 0 }, idleMs: () => 0, awakeProc: null, stayAwake: false,
      stayAwakeSince: null, lastActivity: 0, isolationBlocked: blocked, maintenanceDrain: { status: running => ({ running }) } };
    await vm.runInNewContext('(async function(){' + source.slice(begin, end) + '})()', context); return response;
  };
  assert.equal((await run('127.0.0.1', false, ['synthetic reason'])).body.isolationBlocked, true);
  assert.equal((await run('127.0.0.1', false, null)).body.isolationBlocked, false);
  assert.equal((await run('10.0.0.1', false, ['secret-path'])).status, 404);
  assert.equal((await run('127.0.0.1', true, ['secret-path'])).status, 404);
});
async function watchdog({ blocked = false, stoppedAfterRead = false, malformed = false } = {}) {
  const source = await fs.readFile(path.join(__dirname, '..', 'tools', 'service_watchdog.js'), 'utf8');
  const calls = []; let stopped = false;
  const modules = { fs: { readFileSync: () => '{"port":8765}', appendFileSync() {}, statSync() { if (!stopped) throw Object.assign(Error(), { code: 'ENOENT' }); return {}; } }, path,
    http: { get(options, callback) { const listeners = {}, response = { statusCode: 200, resume() {}, on(name, fn) { listeners[name] = fn; return this; } };
      queueMicrotask(() => { callback(response); if (options.path === '/local/power') { listeners.data(Buffer.from(malformed ? '{bad' : JSON.stringify({ isolationBlocked: blocked })));
        if (stoppedAfterRead) stopped = true; listeners.end(); } }); return { on() { return this; }, destroy() {} }; } },
    child_process: { execFile(exe, args, options) { calls.push({ exe, args, options }); } },
    './maintenance-dispatch.cjs': { requestRepair: async () => calls.push({ kind: 'repair-request' }), startScheduled: async () => { calls.push({ kind: 'scheduled', options: { windowsHide: true } }); return true; } } };
  await vm.runInNewContext(source, { require: name => modules[name], __dirname: path.join(__dirname, '..', 'tools'),
    process: { execPath: process.execPath }, setTimeout: fn => queueMicrotask(fn), Date });
  return calls;
}
test('看门狗在首页仍为 200 的受限状态先保存repair请求，再发起长时维护任务', async () => {
  const calls = await watchdog({ blocked: true }); assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'repair-request'); assert.equal(calls[1].kind, 'scheduled'); assert.equal(calls[1].options.windowsHide, true);
});
test('看门狗正常时仅发起运行故障巡检，未知或人工停止时不动作', async () => {
  const normal = await watchdog(); assert.equal(normal.length, 1); assert.equal(normal[0].kind, 'scheduled'); assert.equal((await watchdog({ malformed: true })).length, 0);
  assert.equal((await watchdog({ blocked: true, stoppedAfterRead: true })).length, 0);
});
