'use strict';
// 使用真实临时文件；所有 Git、验收、服务和进程探测均为替身。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { deploy, waitNoJobs } = require('../tools/maintain.cjs');
const { processesAbsent } = require('../tools/maintenance-inspect.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-m3-entry-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^relay-m3-entry-/); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase()); await fs.rm(root, { recursive: true, force: true }); });
  const d = { sourcePath: path.join(root, 'server.js'), receipt: path.join(root, 'receipt.json'), lastGoodDir: path.join(root, 'last-good'), notice: path.join(root, 'notice.txt'),
    now: () => Date.now(), waitMs: 1, idleTimeoutMs: 20, stoppedByOwner: () => false, power: async () => ({ running: 0 }), log: () => {}, serving: async () => true };
  const state = { source: 'OLD', dirty: false, accepts: 0, restarts: 0, fail: false };
  await fs.writeFile(d.sourcePath, 'OLD'); await fs.writeFile(d.receipt, 'OLD');
  d.gitState = async () => ({ clean: !state.dirty, head: (state.source === 'OLD' ? 'a' : 'b').repeat(40), sourceMatchesHead: await fs.readFile(d.sourcePath, 'utf8') === state.source });
  d.gateOk = async () => await fs.readFile(d.sourcePath, 'utf8') === await fs.readFile(d.receipt, 'utf8');
  d.preview = async () => ({ ok: true, changed: !await d.gateOk() });
  d.checkpointCompatible = async p => await fs.readFile(p.sourcePath, 'utf8') === await fs.readFile(p.receiptPath, 'utf8');
  d.accept = async ({ outputReceipt }) => { state.accepts++; if (state.fail) return { ok: false }; await fs.writeFile(outputReceipt, state.source); return { ok: true }; };
  d.restart = async () => { state.restarts++; return true; };
  return { root, d, state, change: async () => { state.source = 'NEW'; await fs.writeFile(d.sourcePath, state.source); } };
}
test('M3 维护入口建立快照并安装配套候选记录', async t => {
  const f = await fixture(t); assert.equal(await deploy({}, f.d), 'nothing-to-do'); await f.change();
  assert.equal(await deploy({}, f.d), 'deployed'); assert.equal(f.state.accepts, 1); assert.equal(f.state.restarts, 1);
  assert.equal(await f.d.gateOk(), true);
});
test('M3 维护入口验收失败保存明确通知，不重启', async t => {
  const f = await fixture(t); await f.change(); f.state.fail = true;
  assert.equal(await deploy({}, f.d), 'acceptance-failed'); assert.equal(f.state.restarts, 0);
  assert.match(await fs.readFile(f.d.notice, 'utf8'), /磁盘上已是新 server.js、配旧记录/);
});
test('M3 维护入口重启失败后恢复配套旧文件再启动', async t => {
  const f = await fixture(t); await deploy({}, f.d); await f.change();
  f.d.restart = async () => ++f.state.restarts > 1;
  assert.equal(await deploy({}, f.d), 'restart-failed-restored'); assert.equal(f.state.restarts, 2);
  assert.equal(await fs.readFile(f.d.sourcePath, 'utf8'), 'OLD'); assert.equal(await f.d.gateOk(), true);
});
test('M3 维护入口拒绝未提交源码，不验收或覆盖', async t => {
  const f = await fixture(t); await f.change(); f.state.dirty = true;
  assert.equal(await deploy({}, f.d), 'deploy-refused'); assert.equal(f.state.accepts, 0); assert.equal(f.state.restarts, 0);
  assert.equal(await fs.readFile(f.d.sourcePath, 'utf8'), 'NEW');
});
test('M3 接口失联只有明确允许且已证实原进程均退出才可恢复', async t => {
  const f = await fixture(t); f.d.power = async () => null; f.d.serviceGone = async () => true;
  assert.equal(await waitNoJobs(f.d), false); assert.equal(await waitNoJobs(f.d, { allowStopped: true }), true);
  f.d.serviceGone = async () => false; assert.equal(await waitNoJobs(f.d, { allowStopped: true }), false);
  f.d.stoppedByOwner = () => true; f.d.serviceGone = async () => true; assert.equal(await waitNoJobs(f.d, { allowStopped: true }), false);
});
test('M3 退出核对拒绝丢失记录、存活PID、权限错误和无效记录', () => {
  const record = { pid: 123, ppid: 456, startedAt: 1 };
  const gone = () => { throw Object.assign(new Error(), { code: 'ESRCH' }); };
  assert.equal(processesAbsent([record], gone), true);
  assert.equal(processesAbsent([], gone), false); assert.equal(processesAbsent([{}], gone), false);
  assert.equal(processesAbsent([record], () => {}), false);
  assert.equal(processesAbsent([record], () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), false);
  assert.equal(processesAbsent([record, { ...record, pid: 789 }], pid => { if (pid !== 789) gone(); }), false);
});