'use strict';
// 全部程序都是临时文本文件，重启/进程身份/边界检查均为模拟；不启动任何程序。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const tx = require(path.join(root, 'tools/maintenance-transaction.cjs'));
const runtime = require(path.join(root, 'tools/maintenance-runtime.cjs'));
const health = require(path.join(root, 'tools/runtime-health.cjs'));

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-runtime-test-'));
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'relay-runtime-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let time = Date.now(), idle = true, restartOk = true, stopped = false, boundaryOk = true, clean = true;
  const programs = ['Claude', 'Codex'].map(name => ({ name, root: path.join(base, name + '.txt') }));
  for (const program of programs) await fs.writeFile(program.root, '1.0.0');
  const receipt = path.join(base, 'receipt.json'), state = path.join(base, 'version-check.json'), source = path.join(base, 'server-marker.txt');
  await fs.writeFile(source, 'source-1');
  const current = async () => Object.fromEntries(await Promise.all(programs.map(async item => [item.name, await fs.readFile(item.root, 'utf8')])));
  const receiptText = async () => JSON.stringify({ ...await current(), source: await fs.readFile(source, 'utf8') });
  await fs.writeFile(receipt, await receiptText());
  const notices = [], notifications = [], steps = [], restarts = [];
  const d = { programs, receipt, state, notice: path.join(base, 'notice.txt'), now: () => time,
    processIdentity: async () => '12345', pidAlive: () => false,
    stoppedByOwner: () => stopped,
    waitNoJobs: async () => idle,
    gitState: async () => ({ clean, sourceMatchesHead: clean }),
    runtimeBoundaryCheck: async backup => {
      const expected = JSON.parse(await fs.readFile(backup, 'utf8'));
      return boundaryOk && expected.source === await fs.readFile(source, 'utf8');
    },
    runtimeNotice: async message => notices.push(message), notify: async event => notifications.push(event),
    gateOk: async () => {
      try { return await fs.readFile(receipt, 'utf8') === await receiptText(); } catch { return false; }
    },
    onRuntimeStep: async id => steps.push(id),
    restartAndVerify: async () => { restarts.push('restart'); return restartOk && await d.gateOk(); },
  };
  d.recoveryGuard = (record, program) => runtime.recoveryGuard(record, program, d);
  async function upgrade(name, version = '2.0.0', { finish = true, confirm = true } = {}) {
    time += 10;
    const program = programs.find(item => item.name === name);
    assert.equal((await runtime.canUpgrade(program, d)).allowed, true);
    await fs.writeFile(program.root + '.new', version);
    const transaction = await tx.begin(d, program, program.root + '.new', await fs.readFile(program.root, 'utf8'));
    await tx.swapIn(d, program, transaction);
    await fs.writeFile(transaction.outputReceipt, await receiptText());
    await tx.installReceipt(d, transaction);
    await runtime.registerUpgrade(transaction, version, d);
    if (finish) await tx.finish(d, transaction);
    if (finish && confirm) assert.equal((await runtime.confirmUpgrade(transaction.id, d)).status, 'monitoring');
    return transaction;
  }
  async function event(program, category, session = 'a', startedAt = time) {
    time += 1;
    await health.recordOutcome({ program, category, sessionId: session, startedAt },
      { eventsDir: runtime.paths(d).events, clock: () => time });
  }
  async function faults(program) { await event(program, 'start', 'one'); await event(program, 'protocol', 'one'); await event(program, 'no-output', 'two'); }
  const readState = async () => JSON.parse(await fs.readFile(runtime.paths(d).state, 'utf8'));
  const versionState = async () => { try { return JSON.parse(await fs.readFile(state, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
  return { base, d, programs, current, upgrade, event, faults, readState, versionState, source, notices, notifications, steps, restarts,
    advance: amount => { time += amount; }, time: () => time,
    idle: value => { idle = value; }, restart: value => { restartOk = value; },
    stopped: value => { stopped = value; }, boundary: value => { boundaryOk = value; }, clean: value => { clean = value; } };
}

test('M6 三次连续程序故障且至少两个会话才退回，M4只标坏一次', async t => {
  const f = await fixture(t), upgrade = await f.upgrade('Claude');
  for (let i = 0; i < 3; i++) await f.event('Claude', 'start', 'one');
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  assert.equal((await f.current()).Claude, '2.0.0');
  await f.event('Claude', 'no-output', 'two');
  assert.equal((await runtime.processRuntime(f.d)).status, 'rolled-back');
  assert.equal((await f.current()).Claude, '1.0.0');
  assert.equal((await f.versionState()).failedVersions['Claude@2.0.0'].failures, 1);
  assert.equal((await f.versionState()).runtimeFailureIds[upgrade.id], true);
  assert.equal(f.notifications.filter(item => item.type === 'rolled-back').length, 1);
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  assert.equal((await f.versionState()).failedVersions['Claude@2.0.0'].failures, 1);
});

test('M6 外部原因/取消/成功/unknown均中断连续故障，认证仅提示', async t => {
  const f = await fixture(t); await f.upgrade('Claude');
  for (const category of ['network', 'auth', 'quota', 'userfile', 'cancel', 'unknown', 'success']) {
    await f.event('Claude', 'start', 'one'); await f.event('Claude', 'start', 'two');
    await f.event('Claude', category, 'two');
    assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
    assert.equal((await f.readState()).counters.Claude, undefined);
  }
  assert.ok(f.notices.some(message => message.includes('登录')));
  assert.equal((await f.current()).Claude, '2.0.0');
  assert.deepEqual((await f.versionState()).failedVersions, undefined);
});

test('M6 24小时监测保护.prev，同程序新升级等待，过期故障不算新版', async t => {
  const f = await fixture(t); await f.upgrade('Claude');
  assert.equal((await runtime.canUpgrade(f.programs[0], f.d)).reason, 'runtime-watch-window');
  f.advance(runtime.WINDOW_MS + 1);
  await f.faults('Claude');
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  assert.equal((await runtime.canUpgrade(f.programs[0], f.d)).allowed, true);
  assert.equal((await f.current()).Claude, '2.0.0');
});

test('M6 A后B升级，A故障必须B→A，不能拿R0直接覆盖B1', async t => {
  const f = await fixture(t), a = await f.upgrade('Claude'), b = await f.upgrade('Codex');
  const observations = [];
  f.d.onRuntimeStep = async id => { f.steps.push(id); observations.push({ current: await f.current(), gate: await f.d.gateOk() }); };
  await f.faults('Claude');
  const result = await runtime.processRuntime(f.d);
  assert.deepEqual(result, { status: 'rolled-back', program: 'Claude', steps: 2 });
  assert.deepEqual(f.steps, [b.id, a.id]);
  assert.deepEqual(observations[0], { current: { Claude: '2.0.0', Codex: '1.0.0' }, gate: true });
  assert.deepEqual(await f.current(), { Claude: '1.0.0', Codex: '1.0.0' });
  assert.equal((await f.versionState()).failedVersions['Codex@2.0.0'], undefined);
});

test('M6 后升级B出错，只退B，A监测证据继续有效', async t => {
  const f = await fixture(t), a = await f.upgrade('Claude'); await f.upgrade('Codex');
  await f.faults('Codex');
  assert.equal((await runtime.processRuntime(f.d)).steps, 1);
  assert.deepEqual(await f.current(), { Claude: '2.0.0', Codex: '1.0.0' });
  assert.deepEqual((await f.readState()).chain.map(entry => entry.id), [a.id]);
});

test('M6 旧程序/receipt/其他程序或源码漂移只拒绝，不能先改B', async t => {
  for (const kind of ['previous', 'receipt', 'other-program', 'source', 'git']) {
    await t.test(kind, async st => {
      const f = await fixture(st); await f.upgrade('Claude'); await f.upgrade('Codex');
      await f.faults('Claude');
      if (kind === 'previous') await fs.writeFile(f.programs[0].root + '.prev', 'drift');
      if (kind === 'receipt') await fs.writeFile(f.d.receipt, 'unknown receipt');
      if (kind === 'other-program') await fs.writeFile(f.programs[1].root, 'drift');
      if (kind === 'source') await fs.writeFile(f.source, 'source-changed');
      if (kind === 'git') f.clean(false);
      const before = await f.current(), result = await runtime.processRuntime(f.d);
      assert.equal(result.status, 'refused');
      assert.deepEqual(await f.current(), before);
      assert.equal(f.restarts.length, 0);
      assert.equal((await f.versionState()).failedVersions, undefined);
    });
  }
});

test('M6 逆序回退B后中断，下一次从A继续，失败次数不重复', async t => {
  const f = await fixture(t); await f.upgrade('Claude'); await f.upgrade('Codex'); await f.faults('Claude');
  let interrupted = false;
  f.d.onRuntimeStep = async () => { if (!interrupted) { interrupted = true; throw Error('synthetic interruption'); } };
  assert.equal((await runtime.processRuntime(f.d)).status, 'refused');
  assert.deepEqual(await f.current(), { Claude: '2.0.0', Codex: '1.0.0' });
  assert.equal((await f.readState()).rollback.index, 1);
  f.d.onRuntimeStep = async () => {};
  assert.equal((await runtime.processRuntime(f.d)).status, 'rolled-back');
  assert.deepEqual(await f.current(), { Claude: '1.0.0', Codex: '1.0.0' });
  assert.equal((await f.versionState()).failedVersions['Claude@2.0.0'].failures, 1);
});

test('M6 写M1 recovering日志后中断，可由M1接管再续完整逆序链', async t => {
  const f = await fixture(t); await f.upgrade('Claude'); await f.upgrade('Codex'); await f.faults('Claude');
  let interrupted = false;
  f.d.onPhase = async phase => { if (phase === 'recovering' && !interrupted) { interrupted = true; throw Error('synthetic interruption'); } };
  assert.equal((await runtime.processRuntime(f.d)).status, 'refused');
  assert.ok(await tx.readJournal(f.d));
  f.d.onPhase = undefined;
  assert.equal((await tx.recover(f.d)).result, 'recovered');
  assert.equal((await runtime.processRuntime(f.d)).status, 'rolled-back');
  assert.deepEqual(await f.current(), { Claude: '1.0.0', Codex: '1.0.0' });
});

test('M6 中断恢复前其他程序/源码漂移，统一M1守卫在任何写入前拒绝', async t => {
  for (const kind of ['other-program', 'source', 'git']) {
    await t.test(kind, async st => {
      const f = await fixture(st); await f.upgrade('Claude'); await f.upgrade('Codex'); await f.faults('Claude');
      f.d.onPhase = async phase => { if (phase === 'recovering') throw Error('synthetic stop'); };
      await runtime.processRuntime(f.d);
      f.d.onPhase = undefined;
      if (kind === 'other-program') await fs.writeFile(f.programs[0].root, 'unknown-change');
      if (kind === 'source') await fs.writeFile(f.source, 'new-source');
      if (kind === 'git') f.clean(false);
      const before = await f.current(), beforeReceipt = await fs.readFile(f.d.receipt, 'utf8');
      assert.equal((await tx.recover(f.d)).fatal, true);
      assert.deepEqual(await f.current(), before);
      assert.equal(await fs.readFile(f.d.receipt, 'utf8'), beforeReceipt);
    });
  }
});

test('M6 pending-commit后未finish中断，M1退回后裁剪监测条目', async t => {
  const f = await fixture(t); await f.upgrade('Claude', '2.0.0', { finish: false });
  assert.equal((await tx.recover(f.d)).result, 'recovered');
  assert.equal((await runtime.reconcile(f.d)).status, 'discarded-rolled-back-registration');
  assert.equal((await f.readState()).chain.length, 0);
  assert.equal((await f.current()).Claude, '1.0.0');
});

test('M6 finish后未confirm中断，根据完整after证据补确认', async t => {
  const f = await fixture(t); await f.upgrade('Claude', '2.0.0', { confirm: false });
  assert.equal(await runtime.pending(f.d), true);
  assert.equal((await runtime.reconcile(f.d)).status, 'confirmed');
  assert.equal((await f.readState()).chain[0].phase, 'committed');
  assert.equal(await runtime.pending(f.d), false);
});

test('M6 忙碌/手动停止不动程序，重启失败保留已退回状态供重入', async t => {
  const f = await fixture(t); await f.upgrade('Claude'); await f.faults('Claude');
  f.idle(false);
  assert.equal((await runtime.processRuntime(f.d)).status, 'waiting-idle');
  assert.equal((await f.current()).Claude, '2.0.0');
  f.stopped(true); f.idle(true);
  assert.equal((await runtime.processRuntime(f.d)).status, 'stopped-by-owner');
  f.stopped(false); f.restart(false);
  assert.equal((await runtime.processRuntime(f.d)).reason, 'runtime-restart-failed');
  assert.equal((await f.current()).Claude, '1.0.0');
  assert.ok((await f.readState()).rollback);
  f.restart(true);
  assert.equal((await runtime.processRuntime(f.d)).status, 'rolled-back');
});

test('M6 最后一次等待期间漂移，不能写恢复日志或改程序', async t => {
  const f = await fixture(t); await f.upgrade('Claude'); await f.faults('Claude');
  let calls = 0;
  f.d.waitNoJobs = async () => { if (++calls === 2) await fs.writeFile(f.source, 'changed-during-wait'); return true; };
  assert.equal((await runtime.processRuntime(f.d)).status, 'refused');
  assert.equal((await f.current()).Claude, '2.0.0');
  assert.equal(await tx.readJournal(f.d), null);
});

test('M6 升级前开始的旧任务结束既不计故障也不清新版连续计数', async t => {
  const f = await fixture(t), oldStart = f.time(); await f.upgrade('Claude');
  await f.event('Claude', 'start', 'one'); await f.event('Claude', 'start', 'two');
  await f.event('Claude', 'success', 'old-conversation', oldStart);
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  assert.equal((await f.readState()).counters.Claude.failures, 2);
  await f.event('Claude', 'start', 'old-conversation', oldStart);
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  assert.equal((await f.readState()).counters.Claude.failures, 2);
});

test('M6 状态改绑外部路径或链次序错误，只读validator与维护均拒绝', async t => {
  const f = await fixture(t); await f.upgrade('Claude');
  const state = await f.readState();
  state.chain[0].transaction.programRoot = path.join(f.base, 'unrelated.txt');
  assert.throws(() => runtime.validateState(state, f.d), /runtime-state-invalid/);
  await fs.writeFile(runtime.paths(f.d).state, JSON.stringify(state));
  assert.equal((await runtime.processRuntime(f.d)).status, 'refused');
  assert.equal((await f.current()).Claude, '2.0.0');
});


test('M6 当前程序已移至.failed但.prev尚未移回，中断恢复仍核对其他世界状态', async t => {
  for (const drift of [false, true]) await t.test(drift ? '其他程序漂移拒绝' : '完整证据续接', async st => {
    const f = await fixture(st); await f.upgrade('Claude'); await f.upgrade('Codex'); await f.faults('Claude');
    f.d.onPhase = async phase => { if (phase === 'recovering') throw Error('synthetic interruption'); };
    await runtime.processRuntime(f.d); f.d.onPhase = undefined;
    const codex = f.programs[1].root;
    await fs.rename(codex, codex + '.failed');
    if (drift) await fs.writeFile(f.programs[0].root, 'unexpected');
    const beforeReceipt = await fs.readFile(f.d.receipt, 'utf8');
    const result = await tx.recover(f.d);
    if (drift) {
      assert.equal(result.fatal, true);
      assert.equal(await tx.exists(codex), false);
      assert.equal(await fs.readFile(codex + '.prev', 'utf8'), '1.0.0');
      assert.equal(await fs.readFile(f.d.receipt, 'utf8'), beforeReceipt);
    } else {
      assert.equal(result.result, 'recovered');
      assert.equal((await runtime.processRuntime(f.d)).status, 'rolled-back');
      assert.deepEqual(await f.current(), { Claude: '1.0.0', Codex: '1.0.0' });
    }
  });
});

test('M6 边界长检查期间配置变化，在M1写入前拒绝', async t => {
  const f = await fixture(t); await f.upgrade('Claude'); await f.faults('Claude');
  let reads = 0;
  f.d.getBoundaryContext = async () => ({ root: f.base, config: { revision: ++reads }, runtime: {} });
  assert.equal((await runtime.processRuntime(f.d)).status, 'refused');
  assert.equal((await f.current()).Claude, '2.0.0');
  assert.equal(await tx.readJournal(f.d), null);
  assert.equal((await f.versionState()).failedVersions, undefined);
});

async function boundaryFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-runtime-boundary-'));
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'relay-runtime-boundary-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const helper = path.join(base, 'helper.txt'), claude = path.join(base, 'claude.exe');
  const codexRoot = path.join(base, 'codex'), manifest = path.join(base, 'runtime.json'), workspace = path.join(base, 'user');
  await fs.mkdir(path.join(codexRoot, 'bin'), { recursive: true }); await fs.mkdir(workspace);
  await fs.writeFile(helper, 'fixture tool'); await fs.writeFile(claude, 'fixture claude');
  await fs.writeFile(path.join(codexRoot, 'bin', 'codex.exe'), 'fixture codex');
  const metadata = { layoutVersion: 1, entrypoint: 'bin/codex.exe', variant: 'codex', version: '1.0.0', target: 'x86_64-pc-windows-msvc' };
  await fs.writeFile(path.join(codexRoot, 'codex-package.json'), JSON.stringify(metadata));
  await fs.writeFile(path.join(base, 'server.js'), '// fixture source');
  const manifestData = Object.fromEntries(['desktopHost', 'nodePath', 'python', 'ffmpeg', 'libreOffice', 'xlsxScript', 'whisperModel'].map(name => [name, helper]));
  Object.assign(manifestData, { claudePath: claude, codexPath: path.join(codexRoot, 'bin', 'codex.exe') });
  await fs.writeFile(manifest, JSON.stringify(manifestData));
  const config = { openaiApiKey: 'synthetic-placeholder', claudePath: claude, codexPath: manifestData.codexPath,
    users: [{ id: 'fixture', workDir: workspace }], isolation: { runtimeManifest: manifest } };
  const gate = { RECEIPT_SCHEMA: 1, REQUIRED: ['fixture'], SOURCE_FILES: ['server.js'] };
  const inspect = require(path.join(root, 'tools/maintenance-repair-inspect.cjs'));
  const files = await inspect.requiredFiles(config, manifestData, base, gate);
  // requiredFiles包含当前Node宿主：这里只读其指纹，不启动Node以外的任何程序。
  const receipt = { schema: 1, completedAt: new Date().toISOString(), checks: { fixture: { passed: true } },
    configurationFingerprint: await inspect.configurationFingerprint(config, manifestData, base),
    fingerprints: await Promise.all(files.map(async file => ({ path: file, sha256: await tx.fileHash(file) }))) };
  const receiptPath = path.join(base, 'receipt.json'); await fs.writeFile(receiptPath, JSON.stringify(receipt));
  return { base, helper, claude, codexRoot, metadata, inspect, receiptPath, context: { root: base, config, runtime: manifestData, gate } };
}

test('M6 原始receipt边界检查仅容许目标程序缺失，不跳过其他工具或任意祖先', async t => {
  const f = await boundaryFixture(t), { config, runtime: manifest, gate } = f.context;
  await fs.rename(f.claude, f.claude + '.prev');
  assert.equal(await runtime.receiptBoundaryGuard(f.receiptPath, f.context, f.claude), true);
  await assert.rejects(f.inspect.requiredFiles(config, manifest, f.base, gate, { skipProgramRoot: f.base }), /跳过范围/);
  await fs.writeFile(f.helper, 'drift');
  assert.equal(await runtime.receiptBoundaryGuard(f.receiptPath, f.context, f.claude), false);
});

test('M6 Codex缺失时仅以同一包根.prev合法布局放行，畸形布局拒绝', async t => {
  const f = await boundaryFixture(t);
  await fs.rename(f.codexRoot, f.codexRoot + '.prev');
  assert.equal(await runtime.receiptBoundaryGuard(f.receiptPath, f.context, f.codexRoot), true);
  await fs.writeFile(path.join(f.codexRoot + '.prev', 'codex-package.json'), JSON.stringify({ ...f.metadata, entrypoint: '../foreign.exe' }));
  assert.equal(await runtime.receiptBoundaryGuard(f.receiptPath, f.context, f.codexRoot), false);
});

test('M6 server事件写入绑定数据ROOT，并从实际进程起点判定新旧任务', async () => {
  const source = await fs.readFile(path.join(root, 'server.js'), 'utf8');
  const calls = [...source.matchAll(/runtimeHealth\.recordOutcome\([\s\S]*?\.catch\(\(\) => \{\}\);/g)].map(match => match[0]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call, /eventsDir: path\.join\(ROOT, 'data', 'maintenance', 'runtime-events'\)/);
  assert.ok(calls.some(call => call.includes('startedAt: proc.startedAt || msg.startedAt')));
  assert.match(source, /runtimeCompleted\s*=\s*true/);
});

test('M6 Gemini 的运行事件只记登录提醒，不让状态失效、不计入升级故障', async t => {
  const f = await fixture(t); await f.upgrade('Claude');
  await f.event('Gemini', 'success', 'g1'); await f.event('Gemini', 'start', 'g2'); await f.event('Gemini', 'protocol', 'g3'); await f.event('Gemini', 'no-output', 'g4');
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  const state = await f.readState();
  assert.equal(state.authNotified.Gemini, false); assert.equal(state.counters.Gemini, undefined);
  assert.doesNotThrow(() => runtime.validateState(state, f.d));
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  await f.event('Gemini', 'auth', 'g5');
  assert.equal((await runtime.processRuntime(f.d)).status, 'idle');
  assert.ok(f.notices.some(n => /Gemini 的登录可能已过期/.test(n)));
  assert.ok(!f.notices.some(n => /自动退回暂未执行/.test(n)));
  assert.equal((await f.current()).Claude, '2.0.0');
});
