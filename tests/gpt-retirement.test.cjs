'use strict';
// 2026-11-23 GPT 退出平台：把门槛、完整验收、日常重新验收和自动维护里「不再要求 GPT、也不能悄悄把 GPT 打开」的样子钉死。
// 只读源码和临时合成数据，不启动服务、隔离进程或模型，不读正式配置。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const gate = require('../tools/check-isolation.cjs'), core = require('../tools/full-acceptance-core.cjs');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const absentReceipt = () => path.join(os.tmpdir(), 'relay-gpt-retired-absent-' + process.pid + '-' + Date.now() + '.json');

// 去掉 GPT 之前（8c7ef0a）的 REQUIRED，逐项照抄；拿它钉死「只少了两项，其余一项没少」。
const BEFORE = ['pdf', 'voiceOnline', 'voiceOffline', 'stt', 'ocr', 'scientific', 'media', 'html', 'tex', 'gpu', 'eve',
  'claudeSubscription', 'claudeHistory', 'gptApi', 'gptHistory', 'geminiSubscription', 'geminiHistory', 'research', 'serverEndToEnd',
  'filesystemDeny', 'networkDeny', 'uiDesktopDeny', 'cancellation', 'parentDeath', 'regression', 'candidateReview'];

test('REQUIRED 只少了 gptApi、gptHistory 两项，其余一项没少、顺序不变', () => {
  assert.deepEqual([...gate.RETIRED_CHECKS], ['gptApi', 'gptHistory']);
  assert.deepEqual(BEFORE.filter(name => !gate.REQUIRED.includes(name)), ['gptApi', 'gptHistory']);
  assert.deepEqual(gate.REQUIRED.filter(name => !BEFORE.includes(name)), []);
  assert.deepEqual(gate.REQUIRED, BEFORE.filter(name => !gate.RETIRED_CHECKS.includes(name)));
  for (const name of gate.REQUIRED) assert.doesNotMatch(name, /gpt|codex|openai/i);
});

test('配置里给账号开着 GPT（gptUsers 不是空的）时门槛给出原因；关着时没有这条', () => {
  const base = { isolation: { enabled: true }, users: [] };
  assert.equal(gate.GPT_RETIRED_REASON, 'GPT 已退出验收范围：gptUsers 必须为空。');
  // server.js 的 gptAllowed 用 (gptUsers || []).includes(账号)：字符串之类也能 includes 到账号，同样算开着
  for (const gptUsers of [['alice'], ['alice', 'bob'], 'alice', { alice: true }, 1]) {
    const report = gate.check({ ...base, gptUsers, openaiApiKey: 'SYNTHETIC_ONLY' }, absentReceipt());
    assert.ok(report.remainingRequirements.includes(gate.GPT_RETIRED_REASON), JSON.stringify(gptUsers));
    assert.equal(report.readyToEnableIsolation, false);
  }
  for (const gptUsers of [[], undefined, null, '', false, 0]) {
    assert.equal(gate.gptRetirementReason({ ...base, gptUsers }), null, JSON.stringify(gptUsers));
    assert.ok(!gate.check({ ...base, gptUsers }, absentReceipt()).remainingRequirements.includes(gate.GPT_RETIRED_REASON));
  }
  assert.ok(!gate.check(base, absentReceipt()).remainingRequirements.some(reason => /GPT|API/.test(reason)), '没有密钥不再是原因');
});

function readyFixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gpt-retired-'));
  t.after(() => { const real = fs.realpathSync.native(temp); assert.ok(path.basename(real).startsWith('relay-gpt-retired-')); fs.rmSync(real, { recursive: true, force: true }); });
  const bin = path.join(temp, 'bin'), work = path.join(temp, 'work'), codexBin = path.join(temp, 'codex', 'bin');
  for (const dir of [bin, work, codexBin]) fs.mkdirSync(dir, { recursive: true });
  const component = path.join(bin, 'synthetic.exe'), script = path.join(bin, 'entry.py');
  fs.writeFileSync(component, 'SYNTHETIC_COMPONENT'); fs.writeFileSync(script, 'print(42)\n'); fs.writeFileSync(path.join(codexBin, 'codex.exe'), 'SYNTHETIC_CODEX');
  fs.writeFileSync(path.join(temp, 'codex', 'codex-package.json'), JSON.stringify({ layoutVersion: 1, variant: 'codex', version: '1.2.3', target: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe' }));
  const runtime = { ...Object.fromEntries(['desktopHost', 'nodePath', 'claudePath', 'python', 'ffmpeg', 'libreOffice'].map(name => [name, component])),
    codexPath: path.join(codexBin, 'codex.exe'), whisperModel: bin, xlsxScript: script };
  const manifest = path.join(temp, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify(runtime));
  const receiptPath = path.join(temp, 'receipt.json');
  const config = { users: [{ id: 'synthetic', workDir: work }], gptUsers: [],
    isolation: { enabled: true, runtimeManifest: manifest, receipt: receiptPath, privateRoot: path.join(temp, 'private'), gptHome: path.join(temp, 'gpt') } };
  fs.writeFileSync(receiptPath, JSON.stringify({ schema: gate.RECEIPT_SCHEMA, completedAt: new Date().toISOString(), configurationFingerprint: gate.configurationFingerprint(config, runtime),
    checks: Object.fromEntries(gate.REQUIRED.map(name => [name, { passed: true }])), fingerprints: gate.requiredFingerprintFiles(config, runtime).map(file => ({ path: file, sha256: gate.hashFile(file) })) }));
  return { config, runtime, codexExe: runtime.codexPath };
}
test('没有 openaiApiKey 不再是门槛的原因：GPT 关着、其余都齐就能通过；同一份记录只把 GPT 打开就不过', t => {
  const f = readyFixture(t);
  assert.equal('openaiApiKey' in f.config, false);
  const report = gate.check(f.config);
  assert.deepEqual(report.remainingRequirements, []); assert.equal(report.readyToEnableIsolation, true);
  assert.deepEqual(report.authenticationPolicy, { claude: 'local-subscription', gemini: 'agy-google-account', gpt: 'retired' });
  const reopened = gate.check({ ...f.config, gptUsers: ['synthetic'], openaiApiKey: 'SYNTHETIC_ONLY' });
  assert.deepEqual(reopened.remainingRequirements, [gate.GPT_RETIRED_REASON]); assert.equal(reopened.readyToEnableIsolation, false);
  // Codex 程序仍在运行环境里，照旧被指纹核对：改了它门槛照样不过
  fs.appendFileSync(f.codexExe, 'CHANGED');
  assert.ok(gate.check(f.config).remainingRequirements.some(reason => reason.startsWith('验收后文件已变化：codex.exe')));
});

test('完整验收的步骤：每个 REQUIRED 都有步骤覆盖，没有任何步骤、探针或必需检查再要求 GPT', () => {
  const map = core.coverage(gate.REQUIRED);
  for (const name of gate.REQUIRED) if (name !== core.REVIEW_CHECK) assert.ok(map[name].length, name);
  assert.deepEqual(core.STEPS.map(step => step.id), ['regression', 'fs-view', 'fs-scratch', 'network', 'desktop', 'cancel', 'parent-death', 'powershell', 'tex', 'tex-cancel',
    'docs', 'html', 'gpu', 'eve', 'voice', 'research', 'gemini', 'model-handoff', 'e2e']);
  assert.deepEqual(map.claudeSubscription, ['model-handoff', 'e2e']); assert.deepEqual(map.claudeHistory, ['model-handoff', 'e2e']);
  assert.deepEqual(map.geminiSubscription, ['gemini', 'model-handoff']); assert.deepEqual(map.geminiHistory, ['gemini', 'model-handoff']);
  assert.deepEqual(map.serverEndToEnd, ['powershell', 'model-handoff', 'e2e']);
  for (const step of core.STEPS) {
    assert.doesNotMatch(JSON.stringify({ id: step.id, script: step.script, covers: step.covers, requiredChecks: step.requiredChecks, answerChecks: step.answerChecks }), /gpt|codex|openai/i, step.id);
    assert.ok(fs.existsSync(path.join(root, step.script)), step.script);
  }
  for (const retired of gate.RETIRED_CHECKS) assert.throws(() => core.coverage([...gate.REQUIRED, retired]), /没有对应的步骤/);
  assert.equal(fs.existsSync(path.join(root, 'tests/acceptance/probe-gpt-accounts.cjs')), false);
  // 花模型额度的三步都在边界步骤之后，前面全过才跑
  assert.deepEqual(core.STEPS.filter(step => step.costly).map(step => step.id), ['gemini', 'model-handoff', 'e2e']);
  assert.ok(core.STEPS.findIndex(step => step.costly) > core.STEPS.findLastIndex(step => step.boundary));
});

test('日常上线和候选验收的端到端必需项一致、不含 GPT；端到端脚本每项都会写出，完整验收的 e2e 步骤也都要求', () => {
  const declaration = read('tools/refresh-isolation-receipt.cjs').match(/const E2E_REQUIRED = (\[[\s\S]*?\]);/);
  assert.ok(declaration, '日常上线的端到端必需项位置变化，需要更新测试');
  const refresh = JSON.parse(JSON.stringify(vm.runInNewContext(declaration[1])));
  assert.deepEqual(refresh, [...require('../tools/maintenance-candidate.cjs').E2E_REQUIRED]);
  assert.equal(refresh.some(name => /gpt/i.test(name)), false);
  const e2e = core.STEPS.find(step => step.id === 'e2e'), script = read('tests/server-isolation-e2e.cjs');
  for (const name of refresh) { assert.ok(e2e.requiredChecks.includes(name), name); assert.match(script, new RegExp('checks\\.' + name + '='), name); }
  for (const name of e2e.requiredChecks) assert.match(script, name === 'claudeLatexWorkflow' ? /checks\[provider\+'LatexWorkflow'\]=/ : new RegExp('checks\\.' + name + '='), name);
  assert.doesNotMatch(script, /gpt-6|gptUsers:\['/);
  assert.match(script, /gptUsers:\[\]/);
  assert.match(script, /assert\.ok\(!state\.models\.some\(m=>m\.provider==='openai'\)\)/);
  assert.match(script, /of \[\['claude','haiku','BibTeX plain'\]\]/);
});

test('自动维护的程序清单只有 Claude：Codex 不查新版、不升级；status 不显示 Codex 的旧记录，也不报错、不改文件', async t => {
  const maintenance = require('../tools/maintain.cjs');
  assert.deepEqual([...maintenance.UPGRADABLE_PROGRAMS], ['Claude']);
  assert.match(read('tools/maintain.cjs'), /for \(const program of d\.programs\.filter\(item => upgradable\(item\.name\)\)\)/);
  // 即使有人把 Codex 直接交给 upgradeOne，也在碰任何文件或依赖之前就返回
  const retired = await maintenance.upgradeOne({ name: 'Codex', root: path.join(os.tmpdir(), 'relay-never-touched') }, [0, 170, 0], {});
  assert.deepEqual(retired, { result: 'program-retired', why: 'Codex 已不再自动升级；未改动文件', unchanged: true, recordVersionFailure: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gpt-retired-status-'));
  t.after(() => { assert.ok(path.basename(dir).startsWith('relay-gpt-retired-status-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = path.join(dir, 'version-check.json'), notice = path.join(dir, 'notice.txt'), now = 1700000000000;
  fs.writeFileSync(state, JSON.stringify({ lastVersionCheckAt: now, result: 'up-to-date',
    versions: { Claude: { pinned: '2.1.320', latest: '2.1.320' }, Codex: { pinned: '0.166.0', latest: '0.170.0', result: 'cooldown' } },
    failedVersions: { 'Codex@0.170.0': { failures: 2, lastFailedAt: now }, 'Claude@2.1.319': { failures: 1, lastFailedAt: now } },
    inconclusiveVersions: { 'Codex@0.171.0': { lastAt: now } }, acquisition: { Codex: { failures: 3 } } }));
  const before = fs.readFileSync(state, 'utf8'), text = await maintenance.status({ state, notice, now: () => now });
  assert.doesNotMatch(text, /Codex/); assert.match(text, /Claude：检查时 2\.1\.320/); assert.match(text, /Claude 2\.1\.319：失败 1 次/);
  assert.equal(fs.readFileSync(state, 'utf8'), before, '旧记录原样留着'); assert.equal(fs.existsSync(notice), false);
});

test('门槛的几处镜像（部署检查点、修复快照、运行回退）跟门槛一致：不再要密钥，gptUsers 非空就不过；日常重新验收不再刷新 GPT 的证据', () => {
  for (const file of ['tools/check-isolation.cjs', 'tools/maintenance-inspect.cjs', 'tools/maintenance-repair-inspect.cjs', 'tools/maintenance-runtime.cjs']) {
    const source = read(file);
    assert.doesNotMatch(source, /config\.openaiApiKey/, file);
    if (file !== 'tools/check-isolation.cjs') assert.match(source, /require\('\.\/check-isolation\.cjs'\)\.gptRetirementReason\(config\)/, file);
  }
  assert.deepEqual([...require('../tools/maintenance-receipt-history.cjs').REFRESHED].sort(), ['claudeHistory', 'claudeSubscription', 'regression', 'serverEndToEnd']);
});

test('机主看到的受限原因把「GPT 又被打开」翻成看得懂的话', () => {
  const source = read('server.js'), start = source.indexOf('const BLOCKED_MESSAGE = '), end = source.indexOf('function blockedIsolation()', start);
  assert.ok(start >= 0 && end > start);
  const context = { isolationBlocked: null };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.reason = blockedReason;', context);
  assert.equal(context.reason(gate.GPT_RETIRED_REASON), 'GPT 已退出平台，配置里仍给账号开着 GPT');
});
