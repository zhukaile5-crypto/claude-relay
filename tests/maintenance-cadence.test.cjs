'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const maintenance = require('../tools/maintain.cjs'), policy = require('../tools/maintenance-policy.cjs');
const { dependencies } = require('./maintenance-fixture.cjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-m1-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^relay-m1-/); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false); assert.equal((await fs.realpath(directory)).toLowerCase(), directory.toLowerCase()); await fs.rm(directory, { recursive: true, force: true }); });
  for (const [file, value] of Object.entries({ 'fixture-only': '仅合成测试', 'pinned.exe': '2.1.314', 'source.exe': '2.1.320', 'receipt.json': 'old-receipt' })) await fs.writeFile(path.join(directory, file), value);
  const f = dependencies(directory); let now = 1700000000000;
  f.d.now = () => now; f.advance = ms => { now += ms; }; f.state = async () => JSON.parse(await fs.readFile(f.d.state, 'utf8'));
  return f;
}
test('M4 首次失败三天内不再验收，force不绕过坏版本退避', async t => {
  const f = await fixture(t); let attempts = 0; f.d.accept = async () => { attempts++; return { ok: false }; };
  assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed');
  f.advance(policy.VERSION_INTERVAL_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'cooldown');
  assert.equal(await maintenance.versionCheck({ force: true }, f.d), 'cooldown');
  assert.equal(attempts, 1); assert.equal((await f.state()).failedVersions['Claude@2.1.320'].failures, 1);
});
test('M4 第二次失败永久停止该版本，但更新版本立即可尝试', async t => {
  const f = await fixture(t); let attempts = 0; f.d.accept = async () => { attempts++; return { ok: false }; };
  await maintenance.versionCheck({}, f.d); f.advance(policy.FAILURE_COOLDOWN_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed');
  f.advance(20 * policy.VERSION_INTERVAL_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'failed-twice'); assert.equal(attempts, 2);
  await fs.writeFile(f.p('source.exe'), '2.1.321');
  assert.equal(await maintenance.versionCheck({ force: true }, f.d), 'acceptance-failed'); assert.equal(attempts, 3);
  const state = await f.state(); assert.equal(state.failedVersions['Claude@2.1.320'].failures, 2); assert.equal(state.failedVersions['Claude@2.1.321'].failures, 1);
});
test('M4 hourly health只核对、不覆盖版本节奏和失败历史', async t => {
  const f = await fixture(t); const before = { lastCheckAt: 1700000000000, lastVersionCheckAt: 1700000000000, failedVersions: { 'Claude@2.1.320': { failures: 1, lastFailedAt: 1700000000000 } } };
  await fs.writeFile(f.d.state, JSON.stringify(before));
  assert.equal(await maintenance.runMaintenance('health', {}, f.d), 'healthy'); assert.deepEqual(f.calls, []);
  let state = await f.state(); assert.equal(state.lastVersionCheckAt, before.lastVersionCheckAt); assert.deepEqual(state.failedVersions, before.failedVersions);
  assert.equal(await maintenance.versionCheck({}, f.d), 'not-due'); assert.deepEqual(f.calls, []);
  f.d.gateOk = async () => false;
  assert.equal(await maintenance.runMaintenance('health', {}, f.d), 'gate-drift'); assert.deepEqual(f.calls, []);
  assert.match(await fs.readFile(f.d.notice, 'utf8'), /不一致/);
  state = await f.state(); assert.equal(state.healthResult, 'gate-drift'); assert.deepEqual(state.failedVersions, before.failedVersions);
});
test('M4 每日而非三日检查，更新成功仍保留其他坏版本记录', async t => {
  const f = await fixture(t); await fs.writeFile(f.p('source.exe'), '2.1.314');
  const past = { failedVersions: { 'Codex@0.1.0': { failures: 2, lastFailedAt: 1 } } }; await fs.writeFile(f.d.state, JSON.stringify(past));
  assert.equal(await maintenance.versionCheck({}, f.d), 'up-to-date');
  f.advance(policy.VERSION_INTERVAL_MS - 1); assert.equal(await maintenance.versionCheck({}, f.d), 'not-due');
  f.advance(1); assert.equal(await maintenance.versionCheck({}, f.d), 'up-to-date');
  assert.deepEqual((await f.state()).failedVersions, past.failedVersions);
});
test('M4 无法定性的验收失败只冷却三天，不计坏版本', async t => {
  const f = await fixture(t); let attempts = 0;
  f.d.accept = async () => { attempts++; return { ok: false, recordVersionFailure: false, failureKind: { stage: 'boundary', kind: 'boundary' } }; };
  assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed');
  f.advance(policy.VERSION_INTERVAL_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'cooldown'); assert.equal(attempts, 1);
  assert.equal((await f.state()).failedVersions, undefined);
  f.advance(policy.FAILURE_COOLDOWN_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed'); assert.equal(attempts, 2);
});
for (const failureKind of [{ stage: 'model', kind: 'auth' }, { stage: 'model', kind: 'quota' }, { stage: 'interruption', kind: 'sleep' }]) {
  test('M4 ' + failureKind.kind + ' 不冷却，处理好后第二天可重试', async t => {
    const f = await fixture(t); let attempts = 0;
    f.d.accept = async () => { attempts++; return { ok: false, recordVersionFailure: false, interrupted: failureKind.stage === 'interruption', failureKind }; };
    await maintenance.versionCheck({}, f.d); f.advance(policy.VERSION_INTERVAL_MS);
    assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed'); assert.equal(attempts, 2);
  });
}
test('M4 核对恢复正常后清掉自己的提示，保留其他提示', async t => {
  const f = await fixture(t); f.d.gateOk = async () => false;
  await maintenance.runMaintenance('health', {}, f.d); f.d.gateOk = async () => true;
  await maintenance.runMaintenance('health', {}, f.d);
  await assert.rejects(fs.readFile(f.d.notice), { code: 'ENOENT' });
  await fs.writeFile(f.d.notice, '其他维护提示');
  await maintenance.runMaintenance('health', {}, f.d);
  assert.equal(await fs.readFile(f.d.notice, 'utf8'), '其他维护提示');
});
test('M4 预算结束不登记为版本故障', async t => {
  const f = await fixture(t); f.d.runBudgetMs = 0;
  assert.equal(await maintenance.versionCheck({ force: true }, f.d), 'budget-exhausted');
  await assert.rejects(fs.readFile(f.d.state), { code: 'ENOENT' });
});test('A1 冷却期和两次失败只写日志不挂横幅；失败提示带北京时间且不随检查时间变', async t => {
  const f = await fixture(t); const logs = []; f.d.log = m => { logs.push(m); };
  f.d.accept = async () => ({ ok: false });
  assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed');
  const failed = await fs.readFile(f.d.notice, 'utf8');
  assert.match(failed, /^Claude 2\.1\.320 自动升级没有成功（11月15日 06:13）/);
  f.advance(policy.VERSION_INTERVAL_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'cooldown');
  await assert.rejects(fs.readFile(f.d.notice), { code: 'ENOENT' });
  assert.ok(logs.some(m => /Claude 2\.1\.320 暂缓：冷却中，11月18日 06:13 后可再试/.test(m)), logs.join('\n'));
  const state = await f.state(); assert.equal(state.versions.Claude.result, 'cooldown'); assert.equal(state.versions.Claude.retryAt, 1700000000000 + policy.FAILURE_COOLDOWN_MS);
  f.advance(policy.FAILURE_COOLDOWN_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'acceptance-failed');
  f.advance(policy.VERSION_INTERVAL_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'failed-twice');
  await assert.rejects(fs.readFile(f.d.notice), { code: 'ENOENT' });
  assert.ok(logs.some(m => /Claude 2\.1\.320 暂缓：已两次失败，等待更新版本/.test(m)));
});
test('A1 升级成功后不再显示这个程序之前的失败提示，文件核对提示不受版本检查影响', async t => {
  const f = await fixture(t); const ok = f.d.accept; f.d.accept = async () => ({ ok: false });
  await fs.writeFile(f.p('source.exe'), '2.1.319');
  await maintenance.versionCheck({}, f.d);
  assert.match(await fs.readFile(f.d.notice, 'utf8'), /自动升级没有成功/);
  await fs.writeFile(f.p('source.exe'), '2.1.320'); f.d.accept = ok; // 合成门禁只认 2.1.320
  f.advance(policy.VERSION_INTERVAL_MS);
  assert.equal(await maintenance.versionCheck({}, f.d), 'upgraded');
  await assert.rejects(fs.readFile(f.d.notice), { code: 'ENOENT' });
  f.d.gateOk = async () => false; await maintenance.runMaintenance('health', {}, f.d);
  assert.match(await fs.readFile(f.d.notice, 'utf8'), /不一致/);
});
test('A1 status 只读：列出暂缓的版本、下次可试时间和当前提示，不加锁不改文件', async t => {
  const f = await fixture(t); f.d.accept = async () => ({ ok: false, recordVersionFailure: false, failureKind: { stage: 'check', kind: 'unknown' } });
  await maintenance.versionCheck({}, f.d);
  f.calls.length = 0;
  const before = await fs.readFile(f.d.state, 'utf8'), noticeBefore = await fs.readFile(f.d.notice, 'utf8');
  const text = await maintenance.status(f.d);
  assert.match(text, /上次版本检查：11月15日 06:13/);
  assert.match(text, /Claude 2\.1\.320：原因不明的失败，只冷却不计次，11月18日 06:13 后可再试/);
  assert.match(text, /当前提示：Claude 2\.1\.320 自动升级没有成功/);
  assert.equal(await fs.readFile(f.d.state, 'utf8'), before); assert.equal(await fs.readFile(f.d.notice, 'utf8'), noticeBefore);
  assert.deepEqual(f.calls, []);
});
