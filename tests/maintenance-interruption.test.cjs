'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const maintenance = require('../tools/maintain.cjs'), tx = require('../tools/maintenance-transaction.cjs'), { dependencies } = require('./maintenance-fixture.cjs');
async function fixture(t, overrides = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-m1-'));
  for (const [file, content] of Object.entries({ 'fixture-only': '仅合成测试', 'pinned.exe': '2.1.314', 'source.exe': '2.1.320', 'receipt.json': 'old-receipt', 'state.json': JSON.stringify({ lastCheckAt: Date.now() }) })) await fsp.writeFile(path.join(directory, file), content);
  t.after(async () => {
    // 仅删除本测试新建、物理路径一致且带标记的目录。
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('relay-m1-'));
    assert.equal((await fsp.lstat(directory)).isSymbolicLink(), false);
    assert.equal((await fsp.realpath(directory)).toLowerCase(), directory.toLowerCase());
    assert.equal(await fsp.readFile(path.join(directory, 'fixture-only'), 'utf8'), '仅合成测试');
    // Windows 上刚退出的合成子进程可能还占着这个目录（当前目录或句柄），会报 EBUSY：等一下再删，最多约 5 秒。
    // 11-11 Codex 升级前的回归就因为这里偶发 EBUSY 失败过。
    await fsp.rm(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  });
  return { directory, ...dependencies(directory, overrides) };
}
async function waitFor(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 20)); }
  throw Error('合成测试等待超时');
}
async function checkpoint(directory, point, t) {
  const child = cp.fork(path.join(__dirname, 'maintenance-interruption-helper.cjs'), [directory, point], { windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)); }
  });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('测试进程未到断点：' + stderr)), 10000);
    child.on('message', message => { if (message.checkpoint) { clearTimeout(timer); resolve(message); } else if (message.failure || message.unexpectedResult) { clearTimeout(timer); reject(Error(JSON.stringify(message))); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error('测试进程提前退出：' + code + ' ' + stderr)); });
  });
  return { child, message };
}
async function killOwn(child) { assert.equal(child.exitCode, null); const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
for (const point of ['swapped', 'accepting', 'restarting']) test('真实终止合成维护进程后恢复：' + point, async t => {
  const f = await fixture(t), { child, message } = await checkpoint(f.directory, point, t);
  assert.equal(await fsp.readFile(f.p('pinned.exe'), 'utf8'), point === 'accepting' ? '2.1.314' : '2.1.320');
  await killOwn(child);
  await fsp.writeFile(f.p('manual-stop'), '机主停止');
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'recovered');
  assert.equal(await fsp.readFile(f.p('pinned.exe'), 'utf8'), '2.1.314');
  assert.equal(await fsp.readFile(f.p('receipt.json'), 'utf8'), 'old-receipt');
  assert.equal(await f.d.gateOk(), true);
  assert.equal(await tx.exists(tx.paths(f.d).journal), false);
  assert.equal(await tx.exists(f.p('pinned.exe.new')), false);
  assert.equal(await tx.exists(f.p('pinned.exe.failed')), false);
  assert.deepEqual(f.calls, []);
  assert.equal(await tx.exists(f.p('manual-stop')), true);
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'not-due');
  if (point === 'accepting') {
    await fsp.writeFile(f.p('release-late'), '继续合成验收');
    await waitFor(() => tx.exists(f.p('late-done')));
    assert.equal(await fsp.readFile(message.outputReceipt, 'utf8'), 'new-receipt');
    assert.equal(await fsp.readFile(f.p('receipt.json'), 'utf8'), 'old-receipt');
    await assert.rejects(tx.installReceipt(f.d, { id: path.basename(path.dirname(message.outputReceipt)), ownerPid: process.pid }), /失效/);
  }
});
test('root 已移到 prev、日志阶段落后时仍恢复且可重复运行', async t => {
  const f = await fixture(t);
  await fsp.copyFile(f.p('source.exe'), f.p('pinned.exe.new'));
  const transaction = await tx.begin(f.d, f.d.programs[0], f.p('pinned.exe.new'), '2.1.314');
  await fsp.rename(f.p('pinned.exe'), f.p('pinned.exe.prev')); // prepared 日志之后、阶段更新之前中断。
  const result = await tx.recover(f.d, { own: true });
  assert.equal(result.result, 'recovered'); assert.equal(await f.d.gateOk(), true);
  assert.equal((await tx.recover(f.d, { own: true })).result, 'no-transaction');
  assert.equal(await tx.exists(transaction.outputReceipt), false);
});
test('活锁不会恢复另一个进行中的事务', async t => {
  const f = await fixture(t);
  await fsp.copyFile(f.p('source.exe'), f.p('pinned.exe.new'));
  const transaction = await tx.begin(f.d, f.d.programs[0], f.p('pinned.exe.new'), '2.1.314');
  await tx.swapIn(f.d, f.d.programs[0], transaction);
  await fsp.writeFile(f.d.lock, JSON.stringify({ pid: process.pid, token: '合成活锁' }));
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'maintenance-busy');
  assert.equal(await fsp.readFile(f.p('pinned.exe'), 'utf8'), '2.1.320');
  assert.equal(await tx.exists(tx.paths(f.d).journal), true);
  assert.deepEqual(f.calls, []);
});
test('维护锁保留纯 PID，身份保存在独立文件且释放时一并移除', async t => {
  const f = await fixture(t), lease = await tx.acquireLock(f.d);
  assert.equal(await fsp.readFile(f.d.lock, 'utf8'), String(process.pid));
  const identity = JSON.parse(await fsp.readFile(lease.ownerFile, 'utf8'));
  assert.equal(identity.pid, process.pid); assert.match(identity.ownerStartedAt, /^\d+$/);
  assert.equal(await tx.acquireLock(f.d), null);
  await tx.releaseLock(lease);
  assert.equal(await tx.exists(f.d.lock), false); assert.equal(await tx.exists(lease.ownerFile), false);
});
test('PID 被复用但出生时间不同，陈旧锁和事务仍会恢复', async t => {
  const f = await fixture(t);
  await fsp.copyFile(f.p('source.exe'), f.p('pinned.exe.new'));
  const transaction = await tx.begin(f.d, f.d.programs[0], f.p('pinned.exe.new'), '2.1.314');
  await tx.swapIn(f.d, f.d.programs[0], transaction);
  transaction.ownerStartedAt = '1'; await tx.writeJournal(f.d, transaction, 'swapped');
  await fsp.writeFile(f.d.lock, String(process.pid)); const stat = await fsp.stat(f.d.lock);
  await fsp.writeFile(f.d.lock + '.owner.json', JSON.stringify({ pid: process.pid, token: '合成旧身份', ownerStartedAt: '1', birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs }));
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'recovered');
  assert.equal(await f.d.gateOk(), true); assert.deepEqual(f.calls, []);
  assert.equal(await tx.exists(f.d.lock), false);
});
test('出生时间查询失败或身份文件不匹配时，不抢占活锁', async t => {
  const f = await fixture(t);
  await fsp.writeFile(f.d.lock, String(process.pid)); const stat = await fsp.stat(f.d.lock);
  const identity = { pid: process.pid, ownerStartedAt: '1', birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs };
  await fsp.writeFile(f.d.lock + '.owner.json', JSON.stringify(identity));
  assert.equal(await tx.acquireLock({ ...f.d, processIdentity: async () => null }), null);
  identity.birthtimeMs -= 1000; await fsp.writeFile(f.d.lock + '.owner.json', JSON.stringify(identity));
  assert.equal(await tx.acquireLock(f.d), null);
  assert.equal(await fsp.readFile(f.d.lock, 'utf8'), String(process.pid));
});
test('损坏日志和伪造外部备份路径只报告，不删除或改写文件', async t => {
  const f = await fixture(t);
  await fsp.mkdir(tx.paths(f.d).directory);
  await fsp.writeFile(tx.paths(f.d).journal, '{坏');
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'recovery-refused');
  assert.match(await fsp.readFile(f.d.notice, 'utf8'), /日志损坏/);
  assert.equal(await fsp.readFile(f.p('receipt.json'), 'utf8'), 'old-receipt');
  await fsp.unlink(tx.paths(f.d).journal);
  await fsp.copyFile(f.p('source.exe'), f.p('pinned.exe.new'));
  const transaction = await tx.begin(f.d, f.d.programs[0], f.p('pinned.exe.new'), '2.1.314');
  await fsp.writeFile(f.p('outside-marker'), '不能改');
  transaction.backup = f.p('outside-marker');
  await fsp.writeFile(tx.paths(f.d).journal, JSON.stringify(transaction));
  assert.equal((await tx.recover(f.d, { own: true })).result, 'recovery-refused');
  assert.equal(await fsp.readFile(f.p('outside-marker'), 'utf8'), '不能改');
  assert.equal(await fsp.readFile(f.p('pinned.exe'), 'utf8'), '2.1.314');
});
test('恢复不会覆盖事务之外的新程序或新记录', async t => {
  for (const target of ['pinned.exe','receipt.json']) {
    const f = await fixture(t);
    await fsp.copyFile(f.p('source.exe'), f.p('pinned.exe.new'));
    const transaction = await tx.begin(f.d, f.d.programs[0], f.p('pinned.exe.new'), '2.1.314');
    await tx.swapIn(f.d, f.d.programs[0], transaction);
    await fsp.writeFile(f.p(target), '人工新改动');
    assert.equal((await tx.recover(f.d, { own: true })).result, 'recovery-failed');
    assert.equal(await fsp.readFile(f.p(target), 'utf8'), '人工新改动');
    assert.equal(await tx.exists(tx.paths(f.d).journal), true);
  }
});
test('预算不足不会开始交换，验收耗尽预算则恢复旧版', async t => {
  const f = await fixture(t, { runBudgetMs: 0 });
  assert.equal(await maintenance.versionCheck({ force: true }, f.d), 'budget-exhausted');
  assert.equal(await f.d.gateOk(), true); assert.deepEqual(f.calls, []);
  let now = 0;
  const g = await fixture(t, { runBudgetMs: 10, recoveryBudgetMs: 10, budgetNow: () => now,
    accept: async () => { now = 11; return { ok: false, timedOut: true, out: '合成超时' }; } });
  assert.equal(await maintenance.versionCheck({ force: true }, g.d), 'budget-exhausted');
  assert.equal(await g.d.gateOk(), true);
  assert.equal(await tx.exists(tx.paths(g.d).journal), false);
  assert.ok(!g.calls.includes('restart'));
  assert.ok(maintenance.RUN_BUDGET_MS + maintenance.RECOVERY_BUDGET_MS < 2 * 60 * 60e3);
});
test('候选输出只能落在唯一事务目录，不改变正式记录', async t => {
  const f = await fixture(t), folder = path.join(f.directory, 'data', 'maintenance', 'transactions', crypto.randomBytes(16).toString('hex'));
  await fsp.mkdir(folder, { recursive: true });
  const output = path.join(folder, 'receipt.candidate.json'), candidate = { syntheticOnly: true };
  await tx.writeCandidateReceipt({ root: f.directory, output, receipt: candidate, config: {}, gate: { check: (config, file) => ({ readyToEnableIsolation: file === output }) } });
  assert.deepEqual(JSON.parse(await fsp.readFile(output, 'utf8')), candidate);
  assert.equal(await fsp.readFile(f.p('receipt.json'), 'utf8'), 'old-receipt');
  await assert.rejects(tx.writeCandidateReceipt({ root: f.directory, output: f.p('receipt.json'), receipt: candidate, config: {}, gate: {} }), /只能写到/);
  await assert.rejects(tx.writeCandidateReceipt({ root: f.directory, output, receipt: candidate, config: {}, gate: {} }), /已存在/);
});
test('候选核对失败删除候选，正式记录和门禁保持原样', async t => {
  const f = await fixture(t), folder = path.join(f.directory, 'data', 'maintenance', 'transactions', crypto.randomBytes(16).toString('hex'));
  await fsp.mkdir(folder, { recursive: true }); const output = path.join(folder, 'receipt.candidate.json');
  await assert.rejects(tx.writeCandidateReceipt({ root: f.directory, output, receipt: { syntheticOnly: true }, config: {}, gate: { check: () => ({ readyToEnableIsolation: false, remainingRequirements: ['合成边界拒绝'] }) } }), /合成边界拒绝/);
  assert.equal(await tx.exists(output), false); assert.equal(await f.d.gateOk(), true);
  // M9 唯一扩展是已绑定 Codex 完整包；实际包增删与所有非包拒绝由 maintenance-refresh-plan.test.cjs 构造文件验证。
});

test('已提交但清理日志前被终止，保留已验收的新版本', async t => {
  const f = await fixture(t), { child } = await checkpoint(f.directory, 'committed', t);
  await killOwn(child);
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'not-due');
  assert.equal(await fsp.readFile(f.p('pinned.exe'), 'utf8'), '2.1.320');
  assert.equal(await fsp.readFile(f.p('receipt.json'), 'utf8'), 'new-receipt');
  assert.equal(await tx.exists(tx.paths(f.d).journal), false);
  assert.deepEqual(f.calls, []);
});
test('记录备份被改动则拒绝恢复，候选目录联接不能被递归清理', async t => {
  const f = await fixture(t);
  await fsp.copyFile(f.p('source.exe'), f.p('pinned.exe.new'));
  const transaction = await tx.begin(f.d, f.d.programs[0], f.p('pinned.exe.new'), '2.1.314');
  await fsp.writeFile(transaction.backup, '损坏备份');
  assert.equal((await tx.recover(f.d, { own: true })).result, 'recovery-refused');
  assert.equal(await fsp.readFile(f.p('receipt.json'), 'utf8'), 'old-receipt');
  await fsp.unlink(f.p('pinned.exe.new'));
  await fsp.mkdir(f.p('outside'));
  await fsp.writeFile(f.p('outside/canary'), '保留');
  await fsp.symlink(f.p('outside'), f.p('pinned.exe.new'), 'junction');
  try {
    await assert.rejects(tx.safeRemove(f.p('pinned.exe.new'), [f.p('pinned.exe.new')]), /链接/);
    assert.equal(await fsp.readFile(f.p('outside/canary'), 'utf8'), '保留');
  } finally { await fsp.unlink(f.p('pinned.exe.new')); }
});
test('损坏维护锁只通知，不接管或删除', async t => {
  const f = await fixture(t); await fsp.writeFile(f.d.lock, '{坏锁');
  assert.equal(await maintenance.runMaintenance('version-check', {}, f.d), 'recovery-refused');
  assert.match(await fsp.readFile(f.d.notice, 'utf8'), /锁.*损坏/);
  assert.equal(await fsp.readFile(f.d.lock, 'utf8'), '{坏锁');
  assert.deepEqual(f.calls, []);
});
test('子进程超时后有界返回，即使合成后代仍持有输出管道', async t => {
  const f = await fixture(t), done = f.p('pipe-descendant-done');
  const late = "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'完成'),900)";
  const code = "const cp=require('child_process');const child=cp.spawn(process.execPath,['-e'," + JSON.stringify(late) + "," + JSON.stringify(done) + "],{detached:true,windowsHide:true,stdio:['ignore','inherit','inherit']});child.unref();setInterval(()=>{},1000)";
  const started = Date.now();
  const result = await maintenance.runCommand(process.execPath, ['-e', code], { cwd: f.directory, timeoutMs: 250 });
  assert.equal(result.ok, false); assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 750, '不能等持有管道的后代才返回');
  await waitFor(() => tx.exists(done));
});
