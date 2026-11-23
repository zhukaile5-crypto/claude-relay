'use strict';
// 完整验收工具的判定逻辑：临时文件 + 替身执行器，不启动隔离进程、模型或服务。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), fss = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const core = require('../tools/full-acceptance-core.cjs'), realGate = require('../tools/check-isolation.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-full-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'data', 'isolation', 'acceptance.json'), source = path.join(root, 'server.js');
  await fs.mkdir(path.dirname(receiptPath), { recursive: true }); await fs.writeFile(source, 'source-v1');
  for (const step of core.STEPS) { await fs.mkdir(path.dirname(path.join(root, step.script)), { recursive: true }); await fs.writeFile(path.join(root, step.script), ''); }
  const old = { schema: 2, limitations: ['旧限制说明保留'], revisions: [{ at: 'old' }], checks: Object.fromEntries(realGate.REQUIRED.map(name => [name, { passed: true, evidence: ['旧证据'] }])), fingerprints: [] };
  await fs.writeFile(receiptPath, JSON.stringify(old));
  const f = { root, source, receiptPath, old, head: 'a'.repeat(40), clean: true, runs: [], fail: {}, now: 1700000000000, gateFails: false, logs: [] };
  f.gate = { REQUIRED: realGate.REQUIRED, RECEIPT_SCHEMA: 2, hashFile: file => digest(fss.readFileSync(file)),
    requiredFingerprintFiles: () => [source], configurationFingerprint: () => 'c'.repeat(64),
    check: (config, receipt) => { const value = JSON.parse(fss.readFileSync(receipt, 'utf8')); const missing = realGate.REQUIRED.filter(name => value.checks?.[name]?.passed !== true);
      const stale = value.fingerprints.some(item => digest(fss.readFileSync(item.path)) !== item.sha256);
      return { readyToEnableIsolation: !f.gateFails && !missing.length && !stale, remainingRequirements: missing }; } };
  f.d = { root, config: { isolation: { runtimeManifest: path.join(root, 'manifest.json') } }, runtime: {}, gate: f.gate, receiptPath,
    gitState: async () => ({ clean: f.clean, head: f.head, sourceMatchesHead: true }), now: () => f.now, log: message => f.logs.push(message),
    runStep: async ({ step, logFile, reportFile }) => {
      f.runs.push(step.id); await fs.writeFile(logFile, 'log');
      const behavior = f.fail[step.id];
      if (behavior?.mutate) await behavior.mutate();
      if (step.requiredChecks || step.minChecks) {
        const names = [...(step.requiredChecks || [])];
        for (let i = names.length; i < (step.minChecks || 0); i++) names.push('extra' + i);
        const report = behavior?.report || { checks: Object.fromEntries(names.map(name => [name, true])), ...(step.requireStartup ? { startup: { backfillComplete: true, existingUnchanged: true, healthMs: 1000 } } : {}) };
        await fs.writeFile(reportFile, JSON.stringify(report));
      }
      return { status: behavior?.status ?? 0 };
    } };
  f.run = extra => core.runSteps({ ownerApproved: '机主同意（测试）', ...extra }, f.d);
  f.review = async (over = {}) => { const current = await core.bindingOf(f.d), file = path.join(root, 'review.md');
    const fields = { Commit: current.head, Binding: current.binding, Reviewer: 'fresh-session', Verdict: 'approved', Disposition: '未发现新问题', ...over };
    await fs.writeFile(file, Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n')); return core.recordReview({ file }, f.d); };
  return f;
}
const receipt = f => JSON.parse(fss.readFileSync(f.receiptPath, 'utf8'));
test('每个 REQUIRED 都有步骤或审查，脚本都在仓库里，探针没有写死正式目录', async () => {
  const map = core.coverage(realGate.REQUIRED), root = path.resolve(__dirname, '..');
  for (const name of realGate.REQUIRED) if (name !== core.REVIEW_CHECK) assert.ok(map[name].length, name);
  for (const step of core.STEPS) {
    const text = await fs.readFile(path.join(root, step.script), 'utf8');
    assert.equal(text.includes('Claude云端传输'), false, step.script);
    assert.ok(Array.isArray(step.covers) && step.covers.length);
  }
  for (const id of ['fs-view', 'fs-scratch', 'network', 'desktop', 'cancel', 'parent-death']) assert.equal(core.STEPS.find(step => step.id === id).boundary, true, id);
  assert.throws(() => core.coverage([...realGate.REQUIRED, '新增未覆盖项']));
});
test('判定：退出码、失败记录、缺项、假值、超时都不算通过', () => {
  const step = { requiredChecks: ['a', 'b'] }, good = { checks: { a: true, b: { passed: true } } };
  assert.equal(core.evaluate(step, { status: 0, report: good }).passed, true);
  for (const [outcome, label] of [[{ status: 1, report: good }, '退出码'], [{ status: 0, report: { ...good, failure: 'x' } }, '失败记录'], [{ status: 0, report: { checks: { a: true } } }, '缺项'],
    [{ status: 0, report: { checks: { a: true, b: false } } }, '假值'], [{ status: 0, report: { checks: { a: true, b: { passed: false } } } }, '对象假值'], [{ status: 0, report: { checks: { a: true, b: true, c: false } } }, '多余失败项'],
    [{ status: 0, timedOut: true, report: good }, '超时'], [{ status: 0, report: null }, '没有结果']]) assert.equal(core.evaluate(step, outcome).passed, false, label);
});
test('没有写明机主同意就不运行任何步骤', async t => {
  const f = await fixture(t);
  for (const ownerApproved of [undefined, '', ' ']) await assert.rejects(core.runSteps({ ownerApproved }, f.d), /机主同意/);
  assert.deepEqual(f.runs, []);
});
test('工作区不干净时不开始，也不写记录', async t => {
  const f = await fixture(t); f.clean = false;
  await assert.rejects(f.run(), /干净/); assert.deepEqual(f.runs, []);
  await assert.rejects(core.writeReceipt({}, f.d), /干净/);
});
test('全部通过并有审查后才写记录，记录只引用本轮证据，保留限制说明和历史', async t => {
  const f = await fixture(t), before = fss.readFileSync(f.receiptPath);
  assert.equal((await f.run()).result, 'all-passed');
  await assert.rejects(core.writeReceipt({}, f.d), /candidateReview/);
  assert.deepEqual(fss.readFileSync(f.receiptPath), before);
  await f.review();
  assert.equal((await core.writeReceipt({ dryRun: true }, f.d)).result, 'ready');
  assert.deepEqual(fss.readFileSync(f.receiptPath), before);
  assert.equal((await core.writeReceipt({}, f.d)).result, 'installed');
  const value = receipt(f), current = await core.bindingOf(f.d), dir = path.join(path.dirname(f.receiptPath), 'codex-security-artifacts-full-' + current.binding.slice(0, 24));
  assert.deepEqual(Object.keys(value.checks).sort(), [...realGate.REQUIRED].sort());
  for (const check of Object.values(value.checks)) { assert.equal(check.passed, true); assert.ok(check.evidence.length); for (const file of check.evidence) { assert.ok(file.startsWith(dir), file); assert.notEqual(file, '旧证据'); await fs.access(file); } }
  assert.deepEqual(value.limitations, f.old.limitations); assert.equal(value.reviewDisposition, '未发现新问题');
  assert.equal(value.revisions.length, 2); assert.equal(value.revisions[1].kind, 'full-acceptance'); assert.equal(value.revisions[1].approvals[0].note, '机主同意（测试）');
  assert.deepEqual(value.fingerprints.map(item => item.path), [f.source]);
  assert.ok(fss.readdirSync(path.dirname(f.receiptPath)).some(name => name.startsWith('acceptance.json.before-')));
});
test('旧记录全部通过也不能代替本轮：没跑过就拒绝写', async t => {
  const f = await fixture(t);
  await assert.rejects(core.writeReceipt({}, f.d), /没有运行过/);
  f.fail.network = { status: 1 }; await f.run();
  await assert.rejects(core.writeReceipt({}, f.d), /network/);
});
test('边界失败后同一组文件重跑也不通过；修好代码换了指纹才重新开始', async t => {
  const f = await fixture(t); f.fail.network = { report: { checks: { ipv4WorkerDenied: false } } };
  assert.equal((await f.run()).result, 'boundary-failed');
  const after = f.runs.indexOf('network'); assert.equal(f.runs.length, after + 1, '边界失败后不继续跑后面的步骤');
  delete f.fail.network;
  assert.equal((await f.run()).result, 'boundary-failed');
  assert.equal((await f.run({ only: ['network'] })).result, 'boundary-failed');
  assert.equal(f.runs.filter(id => id === 'network').length, 1);
  await fs.writeFile(f.source, 'source-v2');
  assert.equal((await f.run()).result, 'all-passed');
});
test('确认基础设施原因后才可重跑边界步骤，原因写进记录', async t => {
  const f = await fixture(t); f.fail.desktop = { status: 1 }; await f.run(); delete f.fail.desktop;
  await assert.rejects(f.run({ acknowledge: { desktop: '' } }), /原因/);
  await assert.rejects(f.run({ acknowledge: { network: '机器睡眠' } }), /待确认/);
  assert.equal((await f.run({ acknowledge: { desktop: '机器睡眠导致' } })).result, 'all-passed');
  await f.review(); await core.writeReceipt({}, f.d);
  assert.equal(receipt(f).revisions.at(-1).acknowledgements[0].reason, '机器睡眠导致');
});
test('网络类步骤可以重跑，每次尝试都留档', async t => {
  const f = await fixture(t); f.fail.research = { status: 1 };
  assert.equal((await f.run()).result, 'incomplete');
  assert.equal(f.runs.includes('e2e'), false, '前面没过不花模型额度');
  delete f.fail.research;
  assert.equal((await f.run()).result, 'all-passed');
  assert.equal(f.runs.filter(id => id === 'research').length, 2); assert.equal(f.runs.filter(id => id === 'regression').length, 1);
});
test('e2e：模型类失败可重跑，断言类失败（含账号边界）不能重跑', async t => {
  const f = await fixture(t);
  f.fail.e2e = { status: 1, report: { failure: { message: 'x' }, failureKind: { stage: 'model', kind: 'model-network' }, checks: {} } };
  assert.equal((await f.run()).result, 'incomplete');
  f.fail.e2e.report.failureKind = { stage: 'check', kind: 'unknown' };
  assert.equal((await f.run()).result, 'boundary-failed');
  delete f.fail.e2e;
  assert.equal((await f.run()).result, 'boundary-failed');
});
test('验收期间文件或提交变化：这一轮作废，结果不能用', async t => {
  const f = await fixture(t); f.fail['fs-view'] = { mutate: () => fs.writeFile(f.source, 'changed-during-run') };
  assert.equal((await f.run()).result, 'files-changed');
  await assert.rejects(core.writeReceipt({}, f.d), /没有运行过/);
  delete f.fail['fs-view']; await f.run();
  f.head = 'b'.repeat(40);
  await assert.rejects(core.writeReceipt({}, f.d), /没有运行过/);
});
test('证据被改过就拒绝写记录', async t => {
  const f = await fixture(t); await f.run(); await f.review();
  const current = await core.bindingOf(f.d), dir = path.join(path.dirname(f.receiptPath), 'codex-security-artifacts-full-' + current.binding.slice(0, 24));
  await fs.writeFile(path.join(dir, 'network-attempt-1.json'), JSON.stringify({ checks: { forged: true } }));
  await assert.rejects(core.writeReceipt({}, f.d), /被改动/);
});
for (const [label, over, pattern] of [['提交不对', { Commit: 'f'.repeat(40) }, /HEAD/], ['绑定不对', { Binding: 'f'.repeat(64) }, /运行文件/], ['没有审查者', { Reviewer: '' }, /Reviewer/], ['结论不是通过', { Verdict: 'blocked' }, /approved/], ['没有处置说明', { Disposition: '' }, /Disposition/]]) {
  test('审查记录' + label + '时拒绝', async t => { const f = await fixture(t); await assert.rejects(f.review(over), pattern); });
}
test('门禁不认候选或安装后核对失败时，正式记录保持或恢复原样', async t => {
  const f = await fixture(t); await f.run(); await f.review();
  const before = fss.readFileSync(f.receiptPath); f.gateFails = true;
  await assert.rejects(core.writeReceipt({}, f.d), /候选记录/);
  assert.deepEqual(fss.readFileSync(f.receiptPath), before);
  f.gateFails = false; const check = f.gate.check; let calls = 0;
  f.gate.check = (...args) => (++calls === 1 ? check(...args) : { readyToEnableIsolation: false, remainingRequirements: [] });
  await assert.rejects(core.writeReceipt({}, f.d), /恢复/);
  assert.deepEqual(fss.readFileSync(f.receiptPath), before);
});
test('普通 refresh 仍然不能代替完整验收：工具不提供直接标记通过的入口', () => {
  const exported = Object.keys(core);
  for (const name of exported) assert.doesNotMatch(name, /force|skip|mark|bypass/i);
});

test('model-handoff 在前面的账号探针未通过时不花额度', async t => {
  const f = await fixture(t);
  // GPT 退出平台后，model-handoff 前面的账号探针是 gemini（原来是 gpt-accounts）
  f.fail.gemini = { status: 1, report: { checks: {}, failure: 'synthetic', failureKind: { stage: 'model', kind: 'model-network' } } };
  assert.equal((await f.run()).result, 'incomplete');
  assert.equal(f.runs.includes('model-handoff'), false);
  assert.equal(f.runs.includes('e2e'), false);
  delete f.fail.gemini;
  assert.equal((await f.run()).result, 'all-passed');
  assert.equal(f.runs.filter(id => id === 'model-handoff').length, 1);
});

test('model-handoff 的内容或账号断言失败不能靠同文件重跑通过', async t => {
  const f = await fixture(t);
  f.fail['model-handoff'] = { status: 1, report: { checks: {}, failure: 'synthetic', failureKind: { stage: 'check', kind: 'model-handoff-assertion' } } };
  assert.equal((await f.run()).result, 'boundary-failed');
  delete f.fail['model-handoff'];
  assert.equal((await f.run()).result, 'boundary-failed');
  assert.equal(f.runs.filter(id => id === 'model-handoff').length, 1);
  assert.equal(f.runs.includes('e2e'), false);
});

const answerMiss = (check, checks = {}) => ({ status: 1, report: { checks, failure: 'synthetic', failureKind: { stage: 'model-answer', kind: 'model-answer-miss', check } } });
test('模型回答没答中可以有限重跑，次数写进验收记录', async t => {
  const f = await fixture(t);
  f.fail['model-handoff'] = answerMiss('geminiRecovery');
  assert.equal((await f.run()).result, 'incomplete');
  delete f.fail['model-handoff'];
  assert.equal((await f.run()).result, 'all-passed');
  assert.equal(f.runs.filter(id => id === 'model-handoff').length, 2);
  await f.review(); await core.writeReceipt({}, f.d);
  assert.deepEqual(receipt(f).revisions.at(-1).answerMisses, [{ step: 'model-handoff', attempt: 1, check: 'geminiRecovery' }]);
});
test('同一组文件第三次答不中就停，不能一直重跑', async t => {
  const f = await fixture(t);
  f.fail['model-handoff'] = answerMiss('geminiRecovery');
  assert.equal((await f.run()).result, 'incomplete');
  assert.equal((await f.run()).result, 'incomplete');
  assert.equal((await f.run()).result, 'boundary-failed');
  delete f.fail['model-handoff'];
  assert.equal((await f.run()).result, 'boundary-failed');
  assert.equal(f.runs.filter(id => id === 'model-handoff').length, 3);
});
test('自称答不中不能掩盖其他失败：未登记的检查和带其他失败的报告都按断言失败处理', async t => {
  for (const [step, behavior] of [
    ['model-handoff', answerMiss('bothAccountsSwitchIsolated')],
    ['model-handoff', answerMiss('geminiRecovery', { conversationDenied: false })],
    ['model-handoff', answerMiss('gptRecovery')],
    ['gemini', answerMiss('noFileLeak')],
    ['gemini', answerMiss('aliceContinues', { noMemoryLeak: false })],
    ['gemini', answerMiss('geminiRecovery')]]) {
    const f = await fixture(t);
    f.fail[step] = behavior;
    assert.equal((await f.run()).result, 'boundary-failed', step + ' ' + behavior.report.failureKind.check);
  }
});
test('边界步骤不接受答不中的说法', async t => {
  const f = await fixture(t);
  f.fail.network = answerMiss('aliceContinues');
  assert.equal((await f.run()).result, 'boundary-failed');
});
test('A4 报告里已有检查项明确失败时，即使自称是模型或网络问题也按断言失败处理，不能重跑', async t => {
  const f = await fixture(t);
  f.fail.e2e = { status: 1, report: { failure: { message: 'x' }, failureKind: { stage: 'model', kind: 'model-network' }, checks: { loginAndModels: true, conversationAccountBoundary: false } } };
  assert.equal((await f.run()).result, 'boundary-failed');
  const attempt = JSON.parse(fss.readFileSync(path.join(path.dirname(f.receiptPath), fss.readdirSync(path.dirname(f.receiptPath)).find(n => n.startsWith('codex-security-artifacts-full-')), 'run.json'), 'utf8')).attempts.e2e[0];
  assert.equal(attempt.hard, true);
  delete f.fail.e2e;
  assert.equal((await f.run()).result, 'boundary-failed', '同一组文件重跑也不通过');
});
test('A4 只是检查还没跑到（缺项）的模型失败仍可重跑', async t => {
  const f = await fixture(t);
  f.fail.e2e = { status: 1, report: { failure: { message: 'x' }, failureKind: { stage: 'model', kind: 'model-timeout' }, checks: { loginAndModels: true } } };
  assert.equal((await f.run()).result, 'incomplete');
  delete f.fail.e2e;
  assert.equal((await f.run()).result, 'all-passed');
});
test('A4 探针里不再有恒真的检查：stderrPreserved 自己造输出再核对，fastSwitch 量服务端', async () => {
  const root = path.resolve(__dirname, '..');
  const ps = await fs.readFile(path.join(root, 'tests/acceptance/probe-powershell.cjs'), 'utf8');
  const line = ps.split('\n').find(l => l.includes('result.checks.stderrPreserved ='));
  assert.ok(line && !/!result\.forceOnExistingDenied \|\| denied\(mkdir\)/.test(line), line);
  assert.match(line, /noisy\.exitCode === 5/); assert.match(line, /SYNTH_STDERR_7/); assert.match(line, /noisy\.note/);
  const handoff = await fs.readFile(path.join(root, 'tests/acceptance/probe-model-handoff.cjs'), 'utf8');
  const fast = handoff.split('\n').find(l => l.includes("check('fastSwitch'"));
  assert.match(fast, /switchDelay <= 1000/); assert.match(fast, /acceptDelay <= 6000/); // 服务端换模型最多等 5 秒，不能用 1 秒卡
  assert.ok(handoff.indexOf('switchTiming = {') < handoff.indexOf("check('fastSwitch'"), '计时要在检查之前记下');
  assert.match(await fs.readFile(path.join(root, 'tools/model-finalization.cjs'), 'utf8'), /timeoutMs = 5000/, '等待上限变了要同步改探针的 6 秒');
  assert.match(handoff, /const acceptDelay = secondTurn\.startedAt - secondTurn\.requestedAt;/);
});
