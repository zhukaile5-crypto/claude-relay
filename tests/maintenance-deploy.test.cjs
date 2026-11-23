'use strict';

// M3：真实临时文件读写；Git、验收、进程启动和可用性均是明确的替身。
// 不读取正式 config，不启动服务，也不调用 refresh 或 maintain 的 CLI。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { deploy, loadCheckpoint } = require('../tools/maintenance-deploy.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const temp = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'relay-m3-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^relay-m3-/);
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, 'server.js'), receipt = path.join(root, 'data', 'isolation', 'acceptance.json');
  const lastGoodDir = path.join(root, 'data', 'maintenance', 'last-good');
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  const state = { head: 'a'.repeat(40), headSource: 'SYNTHETIC_OLD_SERVER\n', dirty: false, pretendClean: false,
    runtime: 'SYNTHETIC_RUNTIME_1', restartResults: [true], waitResults: [true] };
  const calls = { preview: 0, accept: 0, wait: [], restart: [], notices: [], logs: [], candidates: [] };
  const record = (source, runtime = state.runtime) => Buffer.from(JSON.stringify({ syntheticTestOnly: true, sourceSha256: hash(source), runtime }));
  const readSource = () => fs.readFile(sourcePath, 'utf8'), readReceipt = () => fs.readFile(receipt);
  await fs.writeFile(sourcePath, state.headSource); await fs.writeFile(receipt, record(state.headSource));
  const compatible = (source, contents) => { try { const r = JSON.parse(contents); return r.syntheticTestOnly === true && r.sourceSha256 === hash(source) && r.runtime === state.runtime; } catch { return false; } };
  const d = {
    sourcePath, receipt, lastGoodDir,
    gitState: async () => { const matches = await readSource() === state.headSource; return {
      clean: !state.dirty && (state.pretendClean || matches), head: state.head, sourceMatchesHead: matches, headSourceSha256: hash(state.headSource),
    }; },
    preview: async () => { calls.preview++; return { ok: true, changed: !await d.gateOk() }; },
    gateOk: async () => compatible(await fs.readFile(sourcePath), await readReceipt()),
    checkpointCompatible: async checkpoint => compatible(await fs.readFile(checkpoint.sourcePath), await fs.readFile(checkpoint.receiptPath)),
    accept: async ({ outputReceipt }) => {
      calls.accept++; calls.candidates.push(outputReceipt);
      assert.equal(path.basename(outputReceipt), 'receipt.candidate.json');
      assert.match(path.basename(path.dirname(outputReceipt)), /^[a-f0-9]{32}$/);
      assert.equal(path.dirname(path.dirname(outputReceipt)), path.join(root, 'data', 'maintenance', 'transactions'));
      await fs.writeFile(outputReceipt, record(await fs.readFile(sourcePath)));
      return { ok: true, out: '合成验收替身通过' };
    },
    waitNoJobs: async options => { calls.wait.push(options); if (state.onWait) await state.onWait(calls.wait.length, options); return state.waitResults[Math.min(calls.wait.length - 1, state.waitResults.length - 1)]; },
    restartAndVerify: async () => {
      calls.restart.push({ source: await readSource(), receipt: JSON.parse(await readReceipt()) });
      const result = state.restartResults[Math.min(calls.restart.length - 1, state.restartResults.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
    log: message => { calls.logs.push(message); }, notice: message => { calls.notices.push(message); },
    now: () => 1700000000000,
  };
  const commit = async (contents = 'SYNTHETIC_NEW_SERVER\n') => { state.head = 'b'.repeat(40); state.headSource = contents; await fs.writeFile(sourcePath, contents); };
  const baseline = async () => { assert.equal(await deploy({}, d), 'nothing-to-do'); return loadCheckpoint(d); };
  return { root, d, state, calls, record, readSource, readReceipt, commit, baseline };
}

test('M3 干净且核对通过的首次部署可建立成对基线，无需重启', async t => {
  const h = await fixture(t), cp = await h.baseline();
  assert.equal(cp.source.toString(), h.state.headSource);
  assert.equal(cp.sourceSha256, hash(cp.source)); assert.equal(cp.receiptSha256, hash(cp.receipt));
  assert.equal(cp.head, h.state.head);
  assert.equal(h.calls.accept, 0); assert.equal(h.calls.restart.length, 0);
  const names = await fs.readdir(h.d.lastGoodDir);
  assert.equal(names.filter(name => /^[a-f0-9]{32}$/.test(name)).length, 1);
  assert(!names.some(name => name.startsWith('.pending-')));
});

test('M3 成功部署后才将新源码和新记录成对发布为可用版本', async t => {
  const h = await fixture(t), before = await h.baseline(); await h.commit();
  assert.equal(await deploy({}, h.d), 'deployed');
  const after = await loadCheckpoint(h.d);
  assert.notEqual(after.generation, before.generation);
  assert.equal(after.source.toString(), h.state.headSource);
  assert.deepEqual(after.receipt, await h.readReceipt());
  assert.equal(h.calls.accept, 1); assert.equal(h.calls.restart.length, 1);
  assert.equal(h.calls.restart[0].source, h.state.headSource);
  assert.equal(h.calls.restart[0].receipt.sourceSha256, hash(h.state.headSource));
  assert.equal(await fs.readFile(before.sourcePath, 'utf8'), 'SYNTHETIC_OLD_SERVER\n');
  await assert.rejects(fs.stat(h.calls.candidates[0]), { code: 'ENOENT' });
});

test('M3 验收失败保留磁盘新代码和旧记录，并明确下次启动风险', async t => {
  const h = await fixture(t), before = await h.baseline(), receipt = await h.readReceipt(); await h.commit();
  h.d.accept = async () => { h.calls.accept++; return { ok: false }; };
  assert.equal(await deploy({}, h.d), 'acceptance-failed');
  assert.equal(await h.readSource(), h.state.headSource); assert.deepEqual(await h.readReceipt(), receipt);
  assert.equal((await loadCheckpoint(h.d)).generation, before.generation);
  assert.equal(h.calls.restart.length, 0);
  assert.match(h.calls.notices.at(-1), /磁盘上已是新 server.js、配旧记录/);
});

test('M3 验收进程抛异常按验收失败处理，不安装候选记录', async t => {
  const h = await fixture(t), oldReceipt = await h.readReceipt(); await h.commit();
  h.d.accept = async () => { throw Object.assign(new Error('合成验收中断'), { code: 'SYNTHETIC_INTERRUPTION' }); };
  assert.equal(await deploy({}, h.d), 'acceptance-failed');
  assert.deepEqual(await h.readReceipt(), oldReceipt); assert.equal(h.calls.restart.length, 0);
  assert.equal(await loadCheckpoint(h.d), null);
});

test('M3 重启失败时恢复完整旧版本并启动，保留预期 Git 差异', async t => {
  const h = await fixture(t), before = await h.baseline(); await h.commit(); h.state.restartResults = [false, true];
  assert.equal(await deploy({}, h.d), 'restart-failed-restored');
  assert.deepEqual(await fs.readFile(h.d.sourcePath), before.source); assert.deepEqual(await h.readReceipt(), before.receipt);
  assert.equal(h.calls.restart.length, 2);
  assert.equal(h.calls.restart[1].source, before.source.toString());
  assert.equal(h.calls.restart[1].receipt.sourceSha256, before.sourceSha256);
  assert.deepEqual(h.calls.wait.at(-1), { allowStopped: true });
  assert.equal((await h.d.gitState()).sourceMatchesHead, false);
  assert.equal((await loadCheckpoint(h.d)).generation, before.generation);
});

test('M3 重启抛异常也走同一安全恢复分支', async t => {
  const h = await fixture(t); await h.baseline(); await h.commit(); h.state.restartResults = [new Error('合成启停异常'), true];
  assert.equal(await deploy({}, h.d), 'restart-failed-restored');
  assert.equal(h.calls.restart.length, 2); assert.equal(await h.d.gateOk(), true);
});

test('M3 未提交改动禁止自动验收、重启或覆盖', async t => {
  const h = await fixture(t); h.state.dirty = true;
  const source = await h.readSource(), receipt = await h.readReceipt();
  assert.equal(await deploy({}, h.d), 'deploy-refused');
  assert.equal(h.calls.preview, 0); assert.equal(h.calls.accept, 0); assert.equal(h.calls.restart.length, 0);
  assert.equal(await h.readSource(), source); assert.deepEqual(await h.readReceipt(), receipt);
  assert.match(h.calls.notices.at(-1), /未提交改动/);
});

test('M3 即使 Git 报干净，server.js 不等于 HEAD 也不得验收', async t => {
  const h = await fixture(t); h.state.pretendClean = true; await fs.writeFile(h.d.sourcePath, 'SYNTHETIC_HIDDEN_EDIT');
  assert.equal(await deploy({}, h.d), 'deploy-refused');
  assert.equal(h.calls.accept, 0); assert.equal(h.calls.restart.length, 0);
  assert.equal(await h.readSource(), 'SYNTHETIC_HIDDEN_EDIT');
});

test('M3 等空闲时出现新编辑，不安装记录也不覆盖用户代码', async t => {
  const h = await fixture(t); await h.baseline(); await h.commit(); const receipt = await h.readReceipt();
  h.state.onWait = async () => { await fs.writeFile(h.d.sourcePath, 'SYNTHETIC_USER_DRAFT'); };
  assert.equal(await deploy({}, h.d), 'deploy-refused');
  assert.equal(await h.readSource(), 'SYNTHETIC_USER_DRAFT'); assert.deepEqual(await h.readReceipt(), receipt);
  assert.equal(h.calls.restart.length, 0);
});

test('M3 等空闲时记录被改写，不覆盖这份新记录', async t => {
  const h = await fixture(t); await h.baseline(); await h.commit();
  h.state.onWait = async () => { await fs.writeFile(h.d.receipt, 'SYNTHETIC_RECEIPT_EDIT'); };
  assert.equal(await deploy({}, h.d), 'deploy-refused');
  assert.equal((await h.readReceipt()).toString(), 'SYNTHETIC_RECEIPT_EDIT');
  assert.equal(h.calls.restart.length, 0);
});

test('M3 重启失败后的恢复等待中出现编辑，不覆盖草稿', async t => {
  const h = await fixture(t); await h.baseline(); await h.commit(); h.state.restartResults = [false];
  h.state.onWait = async count => { if (count === 2) await fs.writeFile(h.d.sourcePath, 'SYNTHETIC_RECOVERY_DRAFT'); };
  assert.equal(await deploy({}, h.d), 'rollback-refused');
  assert.equal(await h.readSource(), 'SYNTHETIC_RECOVERY_DRAFT'); assert.equal(h.calls.restart.length, 1);
});

test('M3 首次已漂移且没有快照时，失败后不能把当前 HEAD 伪装成旧可用版本', async t => {
  const h = await fixture(t); await h.commit(); h.state.restartResults = [false];
  assert.equal(await deploy({}, h.d), 'rollback-refused');
  assert.equal(await loadCheckpoint(h.d), null);
  assert.equal(await h.readSource(), h.state.headSource); assert.equal(h.calls.restart.length, 1);
  assert.match(h.calls.notices.at(-1), /没有已验证的上一可用版本/);
});

test('M3 损坏的快照被拒绝，不用其内容恢复服务', async t => {
  const h = await fixture(t), cp = await h.baseline();
  await fs.writeFile(cp.sourcePath, 'SYNTHETIC_CORRUPTED_BACKUP'); await h.commit(); h.state.restartResults = [false];
  assert.equal(await deploy({}, h.d), 'rollback-refused');
  assert.equal(await h.readSource(), h.state.headSource); assert.equal(h.calls.restart.length, 1);
  assert.match(h.calls.notices.at(-1), /核对失败/);
});

test('M3 程序升级后旧全局验收记录不兼容时只报告，不自动接受旧记录', async t => {
  const h = await fixture(t); await h.baseline(); h.state.runtime = 'SYNTHETIC_RUNTIME_2';
  await fs.writeFile(h.d.receipt, h.record(await h.readSource())); await h.commit(); h.state.restartResults = [false];
  assert.equal(await deploy({}, h.d), 'rollback-refused');
  assert.equal(await h.readSource(), h.state.headSource);
  assert.equal(JSON.parse(await h.readReceipt()).runtime, 'SYNTHETIC_RUNTIME_2');
  assert.equal(h.calls.restart.length, 1); assert.match(h.calls.notices.at(-1), /不兼容/);
});

test('M3 等待恢复时运行环境变化，需要重新核对而不是沿用旧兼容结论', async t => {
  const h = await fixture(t); await h.baseline(); await h.commit(); h.state.restartResults = [false];
  h.state.onWait = count => { if (count === 2) h.state.runtime = 'SYNTHETIC_RUNTIME_2'; };
  assert.equal(await deploy({}, h.d), 'rollback-refused');
  assert.equal(await h.readSource(), h.state.headSource); assert.equal(h.calls.restart.length, 1);
});

test('M3 旧文件恢复后仍启动失败时保留旧配对并明确失败，不无限重启', async t => {
  const h = await fixture(t), cp = await h.baseline(); await h.commit(); h.state.restartResults = [false, false];
  assert.equal(await deploy({}, h.d), 'rollback-failed');
  assert.deepEqual(await fs.readFile(h.d.sourcePath), cp.source); assert.deepEqual(await h.readReceipt(), cp.receipt);
  assert.equal(h.calls.restart.length, 2); assert.equal(await h.d.gateOk(), true);
  assert.match(h.calls.notices.at(-1), /服务仍未正常启动/);
});

test('M3 不兼容候选记录不进入正式路径', async t => {
  const h = await fixture(t), receipt = await h.readReceipt(); await h.commit();
  h.d.accept = async ({ outputReceipt }) => { await fs.writeFile(outputReceipt, h.record('SYNTHETIC_WRONG_SOURCE')); return { ok: true }; };
  assert.equal(await deploy({}, h.d), 'candidate-incompatible');
  assert.deepEqual(await h.readReceipt(), receipt); assert.equal(h.calls.restart.length, 0);
});

test('M3 等待空闲超时不发布记录或快照', async t => {
  const h = await fixture(t), receipt = await h.readReceipt(); await h.commit(); h.state.waitResults = [false];
  assert.equal(await deploy({}, h.d), 'restart-pending');
  assert.deepEqual(await h.readReceipt(), receipt); assert.equal(h.calls.restart.length, 0);
  assert.equal(await loadCheckpoint(h.d), null);
});

test('M3 快照指针不能越出分代目录', async t => {
  const h = await fixture(t); await h.baseline();
  await fs.writeFile(path.join(h.d.lastGoodDir, 'current.json'), JSON.stringify({ schema: 1, generation: '../outside' }));
  await assert.rejects(loadCheckpoint(h.d), { code: 'CHECKPOINT_INVALID' });
});

test('M3 不能省略真实兼容性检查依赖', async t => {
  const h = await fixture(t); delete h.d.checkpointCompatible;
  await assert.rejects(deploy({}, h.d), /checkpointCompatible/);
  assert.equal(h.calls.accept, 0); assert.equal(h.calls.restart.length, 0);
});

test('M3 兼容性适配器返回报告对象时不能被误当作通过', async t => {
  const h = await fixture(t), receipt = await h.readReceipt(); await h.commit();
  h.d.checkpointCompatible = async () => ({ readyToEnableIsolation: false });
  assert.equal(await deploy({}, h.d), 'candidate-incompatible');
  assert.deepEqual(await h.readReceipt(), receipt); assert.equal(h.calls.restart.length, 0);
});

test('M3 核对返回非布尔值时不能建立首次可用基线', async t => {
  const h = await fixture(t);
  h.d.preview = async () => ({ ok: true, changed: false });
  h.d.gateOk = async () => ({ readyToEnableIsolation: false });
  assert.equal(await deploy({}, h.d), 'refused');
  assert.equal(await loadCheckpoint(h.d), null); assert.equal(h.calls.restart.length, 0);
});

test('M3 Git clean 必须明确为 true，字符串不能绕过未提交检查', async t => {
  const h = await fixture(t), original = h.d.gitState;
  h.d.gitState = async () => ({ ...await original(), clean: 'true' });
  assert.equal(await deploy({}, h.d), 'deploy-refused');
  assert.equal(h.calls.accept, 0); assert.equal(h.calls.restart.length, 0);
});
