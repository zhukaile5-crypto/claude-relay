'use strict';
// 全部使用临时文本程序、合成门禁与验收替身；不运行真实 E2E、Python 或模型。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const candidate = require('../tools/maintenance-candidate.cjs');
const transaction = require('../tools/maintenance-transaction.cjs');
const packages = require('../tools/codex-fingerprints.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = file => path.resolve(file).toLowerCase();
async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-m7-')), p = file => path.join(root, file);
  await fsp.writeFile(p('fixture-only'), '仅合成候选测试');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('relay-m7-'));
    assert.equal((await fsp.realpath(root)).toLowerCase(), root.toLowerCase()); assert.equal((await fsp.lstat(root)).isSymbolicLink(), false);
    assert.equal(await fsp.readFile(p('fixture-only'), 'utf8'), '仅合成候选测试'); await fsp.rm(root, { recursive: true, force: true });
  });
  const folder = p('data/maintenance/transactions/' + crypto.randomBytes(16).toString('hex'));
  for (const directory of [folder, p('data/isolation'), p('codex/bin'), p('codex.new/bin')]) await fsp.mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries({ 'claude.exe': '旧Claude', 'claude.exe.new': '新Claude', 'codex/bin/codex.exe': '旧Codex', 'codex/bin/helper.exe': '旧辅助',
    'codex.new/bin/codex.exe': '新Codex', 'codex.new/bin/helper.exe': '新辅助', 'boundary.cjs': '合成边界', 'environment.exe': '合成环境', 'server.js': '合成服务' })) await fsp.writeFile(p(name), value);
  for (const directory of ['codex', 'codex.new']) await fsp.writeFile(p(directory + '/codex-package.json'), JSON.stringify({
    layoutVersion: 1, version: directory === 'codex' ? '0.166.0' : '0.166.1', target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe' }));
  const runtime = { claudePath: p('claude.exe'), codexPath: p('codex/bin/codex.exe'), nodePath: p('environment.exe'), policy: '原有范围' };
  const config = { isolation: { enabled: true, runtimeManifest: p('manifest.json') }, syntheticOnly: true,
    ...(options.absoluteOverride ? { claudePath: runtime.claudePath, codexPath: runtime.codexPath } : {}) };
  await fsp.writeFile(config.isolation.runtimeManifest, JSON.stringify(runtime)); await fsp.writeFile(p('config.json'), JSON.stringify(config));
  const gate = {
    RECEIPT_SCHEMA: 2,
    configurationFingerprint(c, r) { return hash(JSON.stringify({ manifest: c.isolation.runtimeManifest, claude: path.isAbsolute(c.claudePath || '') ? c.claudePath : r.claudePath,
      codex: path.isAbsolute(c.codexPath || '') ? c.codexPath : r.codexPath, policy: r.policy })); },
    requiredFingerprintFiles(c, r) { return [c.isolation.runtimeManifest, r.claudePath, ...packages.enumerateCodexFilesSync(r.codexPath), r.nodePath, p('boundary.cjs'), p('server.js')]; },
    check(c, receiptFile) {
      try {
        const r = JSON.parse(fs.readFileSync(c.isolation.runtimeManifest)), ticket = JSON.parse(fs.readFileSync(receiptFile));
        const entries = new Map(ticket.fingerprints.map(item => [key(item.path), item.sha256]));
        return { readyToEnableIsolation: ticket.configurationFingerprint === gate.configurationFingerprint(c, r) && ticket.checks.boundary.passed === true &&
          ticket.fingerprints.every(item => hash(fs.readFileSync(item.path)) === item.sha256) && gate.requiredFingerprintFiles(c, r).every(file => entries.has(key(file))) };
      } catch { return { readyToEnableIsolation: false }; }
    },
  };
  const receiptPath = p('data/isolation/acceptance.json');
  const receipt = { schema: 2, purpose: 'synthetic-test-only', configurationFingerprint: gate.configurationFingerprint(config, runtime),
    checks: Object.fromEntries(['boundary', 'serverEndToEnd', 'regression', 'claudeSubscription', 'claudeHistory', 'gptApi', 'gptHistory'].map(name => [name, { passed: true, evidence: ['合成既有证据'] }])),
    fingerprints: gate.requiredFingerprintFiles(config, runtime).map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) })) };
  await fsp.writeFile(receiptPath, JSON.stringify(receipt));
  const calls = [], outputReceipt = path.join(folder, 'receipt.candidate.json');
  const input = { root, config, receiptPath, program: options.program || 'Claude', outputReceipt };
  const deps = { gate, runCheck: async context => {
    calls.push(context.kind); await fsp.writeFile(context.logFile, '合成替身通过，不是真实验收');
    if (context.kind === 'e2e') {
      assert.equal(path.dirname(context.args[1]), path.dirname(config.isolation.runtimeManifest));
      const validated = await candidate.validateHarnessCandidate({ root, config, program: input.program, manifestPath: context.args[1], transactionId: path.basename(folder) });
      const selected = input.program === 'Claude' ? 'claudePath' : 'codexPath';
      assert.match(await fsp.readFile(validated.override[selected], 'utf8'), /^新/);
      assert.match(await fsp.readFile(runtime[selected], 'utf8'), /^旧/);
      const report = { syntheticOnly: true, checks: Object.fromEntries(candidate.E2E_REQUIRED.map(name => [name, true])), candidate: validated.evidence };
      if (options.report) options.report(report);
      await fsp.writeFile(context.args[2], JSON.stringify(report));
    }
    return options.run ? options.run(context, { root, p, input, runtime, config }) : { ok: true, status: 0 };
  } };
  return { root, p, input, deps, calls, receipt, runtime, folder };
}
async function writeBoundManifest(f, overrides = {}) {
  const p = candidate.candidatePaths({ ...f.input, runtime: f.runtime }), runtime = { ...f.runtime, [p.field]: p.candidateExe, ...overrides };
  await fsp.writeFile(p.manifest, JSON.stringify(runtime));
  const binding = { schema: 1, transactionId: p.transactionId, program: f.input.program, originalManifest: f.input.config.isolation.runtimeManifest,
    originalManifestHash: await transaction.fileHash(f.input.config.isolation.runtimeManifest), candidateManifest: p.manifest, candidateManifestHash: await transaction.fileHash(p.manifest),
    candidateProgramHash: await transaction.treeHash(p.candidateRoot), candidateExeHash: await transaction.fileHash(p.candidateExe) };
  await fsp.writeFile(p.binding, JSON.stringify(binding)); return { p, binding };
}
// GPT 退出平台后只有 Claude 候选；Codex 候选一律拒绝（见下面「GPT 退出平台」那条）
for (const program of ['Claude']) test(program + ' 在正式文件未换时验收候选，结果只含正式路径', async t => {
  const f = await fixture(t, { program, absoluteOverride: true }), before = await fsp.readFile(f.input.receiptPath);
  const result = await candidate.preacceptCandidate(f.input, f.deps);
  assert.equal(result.ok, true); assert.deepEqual(f.calls, ['regression', 'e2e']);
  assert.deepEqual(await fsp.readFile(f.input.receiptPath), before); assert.equal(f.deps.gate.check(f.input.config, f.input.receiptPath).readyToEnableIsolation, true);
  const output = JSON.parse(await fsp.readFile(f.input.outputReceipt)), field = program === 'Claude' ? 'claudePath' : 'codexPath';
  const selected = f.runtime[field], candidateFile = program === 'Claude' ? selected + '.new' : f.p('codex.new/bin/codex.exe');
  assert.equal(output.configurationFingerprint, f.receipt.configurationFingerprint);
  for (const entry of output.fingerprints) {
    const relative = path.relative(f.p('codex'), entry.path), inPackage = program === 'Codex' && !relative.startsWith('..') && !path.isAbsolute(relative);
    const expected = inPackage ? hash(await fsp.readFile(f.p(path.join('codex.new', relative)))) :
      key(entry.path) === key(selected) ? hash(await fsp.readFile(candidateFile)) : f.receipt.fingerprints.find(old => old.path === entry.path).sha256;
    assert.equal(entry.sha256, expected);
  }
  assert.equal(JSON.stringify(output).includes(candidateFile), false); assert.equal(JSON.stringify(output).includes('manifest.candidate.json'), false);
  assert.deepEqual(output.checks.boundary, f.receipt.checks.boundary);
  for (const name of require('../tools/maintenance-receipt-history.cjs').REFRESHED) {
    assert.deepEqual(output.checks[name].evidence, result.evidence); assert.equal(output.checks[name].passed, f.receipt.checks[name].passed);
  }
  // 端到端里已没有 GPT：旧记录里的 gptApi、gptHistory 原证据原样保留，不拿这次的 Claude 证据冒充
  for (const name of ['gptApi', 'gptHistory']) assert.deepEqual(output.checks[name], f.receipt.checks[name], name);
  const p = candidate.candidatePaths({ ...f.input, runtime: f.runtime }); assert.equal(fs.existsSync(p.manifest), false);
  assert.equal(f.deps.gate.check(f.input.config, f.input.outputReceipt).readyToEnableIsolation, false, '交换前不能谎称正式路径的新记录已经有效');
});
test('候选验收失败，正式文件和记录完全不动，不输出未来记录', async t => {
  for (const failedKind of ['regression', 'e2e']) {
    const f = await fixture(t, { run: async context => ({ ok: context.kind !== failedKind, status: context.kind === failedKind ? 1 : 0 }) });
    const before = await fsp.readFile(f.input.receiptPath);
    const result = await candidate.preacceptCandidate(f.input, f.deps);
    assert.equal(result.ok, false); assert.equal(result.stage, failedKind);
    assert.deepEqual(await fsp.readFile(f.input.receiptPath), before); assert.equal(await fsp.readFile(f.p('claude.exe'), 'utf8'), '旧Claude');
    assert.equal(fs.existsSync(f.input.outputReceipt), false); assert.equal(f.calls.length, failedKind === 'regression' ? 1 : 2);
    assert.equal(fs.existsSync(candidate.candidatePaths({ ...f.input, runtime: f.runtime }).manifest), false);
  }
});
test('正式边界、其他程序、环境或服务文件漂移均拒绝，不能借候选验收接受', async t => {
  for (const name of ['boundary.cjs', 'environment.exe', 'server.js', 'codex/bin/codex.exe']) {
    const f = await fixture(t); await fsp.writeFile(f.p(name), '未批准变化');
    await assert.rejects(candidate.preacceptCandidate(f.input, f.deps), /当前正式验收未通过/);
    assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.input.outputReceipt), false);
  }
});
test('验收中修改正式配置、清单、旧程序、候选或边界，结果作废', async t => {
  for (const name of ['config.json', 'manifest.json', 'claude.exe', 'claude.exe.new', 'boundary.cjs', 'data/isolation/acceptance.json']) {
    const f = await fixture(t, { run: async (context, local) => { if (context.kind === 'e2e') await fsp.appendFile(local.p(name), '未知变化'); return { ok: true, status: 0 }; } });
    const result = await candidate.preacceptCandidate(f.input, f.deps);
    assert.equal(result.ok, false); assert.equal(result.failureKind.stage, 'boundary'); assert.equal(result.recordVersionFailure, false);
    assert.equal(fs.existsSync(f.input.outputReceipt), false);
  }
});
test('临时清单不能改变环境或另一个程序，harness 也拒绝', async t => {
  const f = await fixture(t);
  for (const change of [{ nodePath: f.p('claude.exe.new') }, { codexPath: f.p('codex.new/bin/codex.exe') }]) {
    const { p } = await writeBoundManifest(f, change);
    await assert.rejects(candidate.validateHarnessCandidate({ root: f.root, config: f.input.config, program: 'Claude', manifestPath: p.manifest, transactionId: p.transactionId }), /入口以外/);
  }
});
test('harness 必须匹配事务标识、原清单和候选完整指纹', async t => {
  const f = await fixture(t), { p } = await writeBoundManifest(f);
  const options = { root: f.root, config: f.input.config, program: 'Claude', manifestPath: p.manifest, transactionId: p.transactionId };
  await assert.rejects(candidate.validateHarnessCandidate({ ...options, transactionId: undefined }), /事务标识/);
  await assert.rejects(candidate.validateHarnessCandidate({ ...options, transactionId: 'a'.repeat(32) }), /位置/);
  await fsp.appendFile(p.candidateExe, '未知修改');
  await assert.rejects(candidate.validateHarnessCandidate(options), /绑定不一致/);
});
test('清理只删除匹配事务名称和哈希的临时清单，可重复调用', async t => {
  const f = await fixture(t), { p, binding } = await writeBoundManifest(f);
  const options = { root: f.root, config: f.input.config, transactionId: p.transactionId };
  await fsp.writeFile(f.p('outside.json'), '保留');
  await fsp.writeFile(p.binding, JSON.stringify({ ...binding, candidateManifest: f.p('outside.json') }));
  await assert.rejects(candidate.cleanupCandidateManifest(options), /受信任路径/); assert.equal(await fsp.readFile(f.p('outside.json'), 'utf8'), '保留');
  await fsp.writeFile(p.binding, JSON.stringify(binding)); const original = await fsp.readFile(p.manifest);
  await fsp.appendFile(p.manifest, '未知修改'); await assert.rejects(candidate.cleanupCandidateManifest(options), /已被改动/);
  assert.equal(fs.existsSync(p.manifest), true); await fsp.writeFile(p.manifest, original);
  assert.equal(await candidate.cleanupCandidateManifest(options), true); assert.equal(await candidate.cleanupCandidateManifest(options), false);
});
test('临时清单与正式清单同目录，脚本枚举不会新增 JSON 指纹', async t => {
  const f = await fixture(t), { p } = await writeBoundManifest(f);
  assert.equal(path.dirname(p.manifest), path.dirname(f.input.config.isolation.runtimeManifest));
  const gateSource = await fsp.readFile(path.join(__dirname, '../tools/check-isolation.cjs'), 'utf8');
  const declaration = gateSource.split('\n').find(line => line.startsWith('const ENTRY_EXTENSIONS = '));
  const extensions = vm.runInNewContext(declaration + '\nENTRY_EXTENSIONS;');
  assert.equal(extensions.test(path.basename(p.manifest)), false);
  const isolationSource = await fsp.readFile(path.join(__dirname, '../isolation/index.js'), 'utf8');
  assert.ok(isolationSource.includes('RELAY_RUNTIME: path.dirname(manifestPath)'));
});
test('缺少检查、失败报告或不匹配候选身份不能产生正式候选记录', async t => {
  for (const modify of [report => { delete report.checks.voiceRoundTrip; }, report => { report.failure = { message: '合成失败' }; }, report => { report.candidate.executableSha256 = '0'.repeat(64); }]) {
    const f = await fixture(t, { report: modify });
    const result = await candidate.preacceptCandidate(f.input, f.deps);
    assert.equal(result.ok, false); assert.equal(result.recordVersionFailure, false); assert.equal(result.attemptCount, 1);
    assert.equal(fs.existsSync(f.input.outputReceipt), false);
  }
});
test('只读预览不创建清单、证据、候选记录，不运行验收', async t => {
  const f = await fixture(t), before = await fsp.readdir(f.folder);
  const result = await candidate.preacceptCandidate({ ...f.input, dryRun: true }, f.deps);
  assert.equal(result.dryRun, true); assert.deepEqual(f.calls, []); assert.deepEqual(await fsp.readdir(f.folder), before);
  assert.deepEqual(await fsp.readdir(path.dirname(f.input.receiptPath)), ['acceptance.json']);
});
test('普通 refresh 无变化时，dry-run 与 output 并用仍不写候选', async () => {
  const source = await fsp.readFile(path.join(__dirname, '../tools/refresh-isolation-receipt.cjs'), 'utf8');
  const branch = source.split('\n').find(line => line.startsWith('if (!changed.length)'));
  assert.ok(branch); let written = 0, exited = 0;
  const sandbox = { changed: [], outputReceipt: 'synthetic-only', receipt: {}, publishCandidate: () => { written++; }, console: { log() {} }, process: { argv: ['--dry-run'], exit: () => { exited++; } } };
  await vm.runInNewContext('(async function(){' + branch + '})()', sandbox);
  assert.equal(written, 0); assert.equal(exited, 0);
});
test('未知程序、任意输出路径、不同绝对配置入口均拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(candidate.preacceptCandidate({ ...f.input, program: '其他程序' }, f.deps), /只能是/);
  await assert.rejects(candidate.preacceptCandidate({ ...f.input, outputReceipt: f.p('outside.json') }, f.deps), /唯一维护事务目录/);
  await assert.rejects(candidate.preacceptCandidate({ ...f.input, config: { ...f.input.config, claudePath: f.p('other.exe') } }, f.deps), /配置/);
  assert.deepEqual(f.calls, []);
});
test('传入旧配置不能凭当前配置文件哈希通过候选验收', async t => {
  const f = await fixture(t);
  await fsp.writeFile(f.p('config.json'), JSON.stringify({ ...f.input.config, syntheticRevision: '已更改' }));
  await assert.rejects(candidate.preacceptCandidate(f.input, f.deps), /过期配置/);
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.input.outputReceipt), false);
});
test('候选链接与重复事务不被接受', async t => {
  // 原来用 Codex 的候选目录做；GPT 退出平台后只剩 Claude 候选，改成把 claude.exe.new 换成一个目录联接
  const f = await fixture(t);
  await fsp.writeFile(f.input.outputReceipt, '已有候选');
  await assert.rejects(candidate.preacceptCandidate(f.input, f.deps), /已有输出/);
  await fsp.unlink(f.input.outputReceipt);
  await fsp.rename(f.p('claude.exe.new'), f.p('saved-candidate.exe')); await fsp.mkdir(f.p('saved-candidate'));
  await fsp.symlink(f.p('saved-candidate'), f.p('claude.exe.new'), 'junction');
  try { await assert.rejects(candidate.preacceptCandidate(f.input, f.deps), /链接/); }
  finally { await fsp.unlink(f.p('claude.exe.new')); }
  assert.deepEqual(f.calls, []);
});
test('预算耗尽时不启动验收或输出记录', async t => {
  const f = await fixture(t);
  await assert.rejects(candidate.preacceptCandidate({ ...f.input, timeoutMs: 0 }, f.deps), /预算/);
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.input.outputReceipt), false);
});

// 原来这里是两条 Codex 候选的 M9 测试（候选包增删映射回正式根、验收中改包作废）。2026-11-23 GPT 退出平台后，
// Codex 仍是每次执行的沙箱宿主，它的变化要走完整验收（重跑边界探针）；Codex 候选在任何验收开始之前就被拒绝。
test('GPT 退出平台：Codex 候选一律拒绝，不运行验收、不写清单和记录，正式文件不动', async t => {
  const f = await fixture(t, { program: 'Codex' }), original = await fsp.readFile(f.input.receiptPath);
  const codexBefore = await packages.hashCodexPackage(f.p('codex/bin/codex.exe'));
  for (const input of [f.input, { ...f.input, dryRun: true }]) await assert.rejects(candidate.preacceptCandidate(input, f.deps), /只能是 Claude：GPT 已退出平台，Codex 程序不再升级/);
  assert.throws(() => candidate.candidatePaths({ ...f.input, runtime: f.runtime }), /只能是 Claude/);
  await assert.rejects(candidate.validateHarnessCandidate({ root: f.root, config: f.input.config, program: 'Codex', manifestPath: f.p('manifest.json'), transactionId: path.basename(f.folder) }), /只能是 Claude/);
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.input.outputReceipt), false);
  assert.deepEqual(await fsp.readdir(f.folder), []); assert.deepEqual(await fsp.readFile(f.input.receiptPath), original);
  assert.equal((await packages.hashCodexPackage(f.p('codex/bin/codex.exe'))).fingerprint, codexBefore.fingerprint);
  assert.equal(await fsp.readFile(f.p('codex.new/bin/codex.exe'), 'utf8'), '新Codex', '候选目录也不碰');
  assert.equal(candidate.E2E_REQUIRED.some(name => /gpt/i.test(name)), false);
});
