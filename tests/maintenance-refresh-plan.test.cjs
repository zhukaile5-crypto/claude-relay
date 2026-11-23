'use strict';
// 完整临时包和真实异步指纹；门禁配置为合成数据，不运行 refresh、模型或验收。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { prepareRefresh, assertPackageBoundaries } = require('../tools/maintenance-refresh-plan.cjs');
const packages = require('../tools/codex-fingerprints.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// move：false（普通重新验收）、'codex'（GPT 退出平台后应被拒绝）或 'claude'（仍可接受的程序路径迁移）
async function fixture(t, { move = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-refresh-plan-')), p = file => path.join(root, file);
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^relay-refresh-plan-/);
    assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = { users: [{ id: 'synthetic', workDir: p('work') }], isolation: { enabled: true, runtimeManifest: p('manifest.json') } };
  await fs.mkdir(p('work'));
  for (const name of ['codex', 'old-codex']) {
    await fs.mkdir(p(name + '/bin'), { recursive: true });
    const files = { 'bin/codex.exe': 'synthetic-codex', 'bin/helper.dll': 'synthetic-dll', 'manual.md': 'synthetic-manual',
      'codex-package.json': JSON.stringify({ layoutVersion: 1, version: '0.166.0', target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe' }) };
    for (const [file, content] of Object.entries(files)) await fs.writeFile(p(name + '/' + file), content);
  }
  for (const name of ['server.js', 'boundary.js', 'claude.exe', 'old-claude.exe', 'node.exe']) await fs.writeFile(p(name), 'synthetic-' + name);
  const runtime = { codexPath: p('codex/bin/codex.exe'), claudePath: p('claude.exe'), nodePath: p('node.exe') };
  const oldRuntime = { ...runtime, ...(move === 'codex' ? { codexPath: p('old-codex/bin/codex.exe') } : move === 'claude' ? { claudePath: p('old-claude.exe') } : {}) };
  const gate = { RECEIPT_SCHEMA: 2, REQUIRED: ['boundary', 'regression', 'serverEndToEnd'],
    configurationFingerprint: (c, r) => hash(JSON.stringify({ users: c.users, isolation: c.isolation, runtime: r })),
    requiredFingerprintFiles: (c, r) => [p('server.js'), p('boundary.js'), c.isolation.runtimeManifest, r.claudePath, r.nodePath, ...packages.enumerateCodexFilesSync(r.codexPath)] };
  const oldManifest = JSON.stringify(oldRuntime, null, 2);
  await fs.writeFile(p('config.json'), JSON.stringify(config)); await fs.writeFile(p('manifest.json'), JSON.stringify(runtime, null, 2));
  const receipt = { schema: 2, completedAt: '2026-11-01T00:00:00.000Z', configurationFingerprint: gate.configurationFingerprint(config, oldRuntime),
    checks: Object.fromEntries(gate.REQUIRED.map(name => [name, { passed: true, evidence: ['synthetic-original'] }])), fingerprints: [] };
  for (const file of gate.requiredFingerprintFiles(config, oldRuntime)) receipt.fingerprints.push({ path: file, sha256: hash(file === p('manifest.json') ? oldManifest : await fs.readFile(file)) });
  const receiptPath = p('acceptance.json'); await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const movedField = { codex: 'codexPath', claude: 'claudePath' }[move];
  const options = { root, config, receiptPath, ...(movedField ? { movedField, movedFrom: oldRuntime[movedField] } : {}) };
  return { root, p, config, runtime, receipt, gate, options, plan: () => prepareRefresh(options, { gate }) };
}
test('M9 普通无变化计划只读且不修改原有边界结论', async t => {
  const f = await fixture(t), before = await fs.readFile(f.options.receiptPath), plan = await f.plan();
  assert.deepEqual(plan.changed, []); assert.deepEqual((await plan.finalReceipt()).checks, f.receipt.checks);
  assert.deepEqual(await fs.readFile(f.options.receiptPath), before);
});
// 原来是「M9 Codex 普通更新支持非 exe 修改、任意扩展新增和删除」。2026-11-23 GPT 退出平台后，Codex 的变化不再经 refresh 接受（它仍是每次执行的沙箱宿主，要走完整验收），
// 包内任何变化都和其他运行环境文件一样拒绝，要完整重新验收。
test('GPT 退出平台：Codex 包内改 exe、改其他文件、任意扩展新增或删除都拒绝，记录不动', async t => {
  for (const mode of ['exe', 'modify', 'add', 'delete']) {
    const f = await fixture(t), before = await fs.readFile(f.options.receiptPath);
    if (mode === 'exe') await fs.writeFile(f.p('codex/bin/codex.exe'), 'changed');
    if (mode === 'modify') await fs.writeFile(f.p('codex/bin/helper.dll'), 'changed');
    if (mode === 'add') await fs.writeFile(f.p('codex/new.json'), 'new');
    if (mode === 'delete') await fs.unlink(f.p('codex/manual.md'));
    await assert.rejects(f.plan(), /隔离边界或运行环境/, mode);
    assert.deepEqual(await fs.readFile(f.options.receiptPath), before);
  }
});
test('M9 server 与 Claude 单文件变化仍可计划，隔离或环境变化仍拒绝', async t => {
  for (const file of ['server.js', 'claude.exe', 'boundary.js', 'node.exe']) {
    const f = await fixture(t); await fs.writeFile(f.p(file), 'changed');
    if (['server.js', 'claude.exe'].includes(file)) assert.ok((await f.plan()).changed.some(item => item.path === f.p(file)));
    else await assert.rejects(f.plan(), /隔离边界或运行环境/);
  }
});
test('M9 不接受遗漏的新增边界文件、重复指纹或不完整 REQUIRED', async t => {
  for (const mode of ['missing', 'duplicate', 'required']) {
    const f = await fixture(t);
    if (mode === 'missing') { const previous = f.gate.requiredFingerprintFiles; await fs.writeFile(f.p('new-boundary.js'), 'new'); f.gate.requiredFingerprintFiles = (c, r) => [...previous(c, r), f.p('new-boundary.js')]; }
    else if (mode === 'duplicate') f.receipt.fingerprints.push({ ...f.receipt.fingerprints[0] });
    else f.receipt.checks.boundary.passed = false;
    await fs.writeFile(f.options.receiptPath, JSON.stringify(f.receipt));
    await assert.rejects(f.plan());
  }
});
test('GPT 退出平台：Codex 路径迁移不再接受，哪怕清单和配置只换了这一个路径', async t => {
  const f = await fixture(t, { move: 'codex' }), before = await fs.readFile(f.options.receiptPath);
  await assert.rejects(f.plan(), /Codex 程序不再升级或迁移/);
  assert.deepEqual(await fs.readFile(f.options.receiptPath), before);
});
// 迁移的逐字节证明原来用 Codex 测；GPT 退出平台后只剩 Claude 这一种迁移，改用 Claude 测同样的证明
test('Claude 程序路径迁移：清单和配置逐字节证明只换了这一个路径，新入口写进记录、旧入口拿掉', async t => {
  const f = await fixture(t, { move: 'claude' }), plan = await f.plan(), receipt = await plan.finalReceipt();
  assert.ok(!receipt.fingerprints.some(item => item.path === f.p('old-claude.exe')));
  assert.equal(receipt.fingerprints.find(item => item.path === f.p('claude.exe')).sha256, hash(await fs.readFile(f.p('claude.exe'))));
  assert.equal(receipt.configurationFingerprint, f.gate.configurationFingerprint(f.config, f.runtime));
  assert.equal(receipt.fingerprints.find(item => item.path === f.p('manifest.json')).sha256, hash(await fs.readFile(f.p('manifest.json'))));
  assert.deepEqual(receipt.checks, f.receipt.checks);
  assert.deepEqual(plan.changed.map(item => [path.basename(item.path), item.change]).sort(), [['claude.exe', 'added'], ['manifest.json', 'modified'], ['old-claude.exe', 'deleted']]);
});
test('迁移拒绝旧程序已漂移、额外清单变更、账号变化及旧程序证据缺失', async t => {
  for (const mode of ['old-drift', 'manifest', 'account', 'old-missing']) {
    const f = await fixture(t, { move: 'claude' });
    if (mode === 'old-drift') await fs.writeFile(f.p('old-claude.exe'), 'changed');
    if (mode === 'manifest') await fs.writeFile(f.p('manifest.json'), JSON.stringify({ ...f.runtime, extra: true }, null, 2));
    if (mode === 'account') { f.config.users[0].id = 'other'; await fs.writeFile(f.p('config.json'), JSON.stringify(f.config)); }
    if (mode === 'old-missing') { f.receipt.fingerprints = f.receipt.fingerprints.filter(item => item.path !== f.p('old-claude.exe')); await fs.writeFile(f.options.receiptPath, JSON.stringify(f.receipt)); }
    await assert.rejects(f.plan(), undefined, mode);
  }
});
test('M9 包根不能吞入其他环境入口，即使旧记录原本包含它', async t => {
  const f = await fixture(t); f.runtime.nodePath = f.p('codex/bin/helper.dll');
  await fs.writeFile(f.p('manifest.json'), JSON.stringify(f.runtime, null, 2));
  f.receipt.configurationFingerprint = f.gate.configurationFingerprint(f.config, f.runtime);
  f.receipt.fingerprints.find(item => item.path === f.p('manifest.json')).sha256 = hash(await fs.readFile(f.p('manifest.json')));
  await fs.writeFile(f.options.receiptPath, JSON.stringify(f.receipt));
  await assert.rejects(f.plan(), /覆盖了服务、账号或其他运行组件/);
});
test('M9 验收等待期间新增、删除、改包文件或改边界、配置、记录均让结果作废', async t => {
  for (const mode of ['add', 'delete', 'package', 'boundary.js', 'config.json', 'manifest.json', 'acceptance.json']) {
    const f = await fixture(t), plan = await f.plan();
    if (mode === 'add') await fs.writeFile(f.p('codex/late.md'), 'late');
    else if (mode === 'delete') await fs.unlink(f.p('codex/manual.md'));
    else await fs.appendFile(f.p(mode === 'package' ? 'codex/bin/helper.dll' : mode), 'late');
    await assert.rejects(plan.finalReceipt());
  }
});

async function realGateFixture(t, mode, configure = async () => {}) {
  const gate = require('../tools/check-isolation.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-package-boundary-')), p = file => path.join(root, file);
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^relay-package-boundary-/);
    assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
  for (const file of gate.SOURCE_FILES) await write(p(file), '合成源码 ' + file);
  await write(p('runtime/synthetic.exe'), '合成运行环境，绝不执行'); await fs.mkdir(p('work'));
  const packageRoot = p(mode === 'source' ? 'isolation' : 'codex');
  await write(path.join(packageRoot, 'bin/codex.exe'), '合成 Codex，绝不执行');
  await write(path.join(packageRoot, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, version: '0.166.0', target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe' }));
  await fs.mkdir(path.join(packageRoot, 'resources'));
  const tool = path.join(packageRoot, 'resources/tool.js');
  if (mode !== 'candidate-empty') await write(tool, '原始独立工具');
  const runtime = Object.fromEntries(['desktopHost', 'nodePath', 'claudePath', 'python', 'ffmpeg', 'libreOffice', 'xlsxScript'].map(name => [name, p('runtime/synthetic.exe')]));
  runtime.codexPath = path.join(packageRoot, 'bin/codex.exe'); runtime.whisperModel = p('runtime'); runtime.readRoots = [p('runtime')];
  const config = { openaiApiKey: 'SYNTHETIC_ONLY', users: [{ id: 'synthetic', workDir: p('work') }], isolation: { enabled: true, runtimeManifest: p('manifest.json'), receipt: p('acceptance.json') } };
  await configure({ root, p, packageRoot, tool, runtime, config, write });
  await write(config.isolation.runtimeManifest, JSON.stringify(runtime, null, 2)); await write(p('config.json'), JSON.stringify(config));
  const receipt = { schema: gate.RECEIPT_SCHEMA, completedAt: new Date().toISOString(), configurationFingerprint: gate.configurationFingerprint(config, runtime, root),
    checks: Object.fromEntries(gate.REQUIRED.map(name => [name, { passed: true, evidence: ['SYNTHETIC_ONLY'] }])),
    fingerprints: gate.requiredFingerprintFiles(config, runtime, root).map(file => ({ path: file, sha256: gate.hashFile(file) })) };
  await write(config.isolation.receipt, JSON.stringify(receipt)); assert.equal(gate.check(config, undefined, root).readyToEnableIsolation, true);
  const options = { root, config, runtime, gate, receiptPath: config.isolation.receipt, packageRoots: [packageRoot] };
  return { root, p, packageRoot, tool, runtime, config, gate, receipt, write, options };
}
test('M9 真实 gate 的源码、工具、技能、递归父目录和环境范围不得被整包授权吞入', async t => {
  const rows = [
    ['source', async () => {}],
    ['tools', async f => { f.runtime.tools = { task: f.tool }; }],
    ['skills', async f => { f.runtime.skills = { guide: f.tool }; }],
    ['tools-parent', async f => { await f.write(f.p('outside.js'), '独立工具'); f.runtime.tools = { task: f.p('outside.js') }; }],
    ['codeRoots-parent', async f => { f.runtime.codeRoots = [f.root]; }],
    ['codeRoots', async f => { f.runtime.codeRoots = [path.dirname(f.tool)]; }],
    ['pathDirs', async f => { f.runtime.pathDirs = [path.dirname(f.tool)]; }],
    ['texBin', async f => { f.runtime.texBin = path.dirname(f.tool); }],
    ['texGhostscript', async f => { f.runtime.texGhostscript = f.packageRoot; }],
    ['nodePath', async f => { f.runtime.nodePath = f.tool; }],
    ['python', async f => { f.runtime.python = f.tool; }],
    ['nodeModules', async f => { f.runtime.nodeModules = f.root; }],
    ['config-claude', async f => { f.config.claudePath = f.tool; }],
    ['readRoots', async f => { f.runtime.readRoots = [path.dirname(f.tool)]; }],
    ['privateRoot', async f => { f.config.isolation.privateRoot = path.join(f.packageRoot, 'private'); }],
    ['gptHome', async f => { f.config.isolation.gptHome = path.join(f.packageRoot, 'home'); }],
    ['account', async f => { f.config.users[0].workDir = path.dirname(f.tool); }],
  ];
  for (const [mode, configure] of rows) await t.test(mode, async t => {
    const f = await realGateFixture(t, mode, configure);
    const file = mode === 'source' ? f.p('isolation/executor.js') : f.tool;
    await fs.writeFile(file, '改变后不得自动接受'); assert.equal(f.gate.check(f.config, undefined, f.root).readyToEnableIsolation, false);
    await assert.rejects(prepareRefresh(f.options), /覆盖了服务、账号或其他运行组件/);
    assert.deepEqual(JSON.parse(await fs.readFile(f.config.isolation.receipt)), f.receipt);
  });
});
test('M9 外部目录联接和解释器同目录 DLL 的真实目标不能藏入程序包', async t => {
  for (const mode of ['tool-alias', 'python-dll']) {
    const f = await realGateFixture(t, mode, async f => {
      if (mode === 'tool-alias') {
        const alias = f.p('outside-alias'); await fs.symlink(path.dirname(f.tool), alias, 'junction');
        f.runtime.tools = { task: path.join(alias, 'tool.js') };
      } else {
        await f.write(path.join(path.dirname(f.tool), 'python.exe'), '合成解释器');
        await f.write(path.join(path.dirname(f.tool), 'python314.dll'), '合成解释器依赖');
        const alias = f.p('python-alias'); await fs.symlink(path.dirname(f.tool), alias, 'junction');
        f.runtime.python = path.join(alias, 'python.exe');
      }
    });
    await fs.writeFile(f.tool, '修改别名实际目标');
    await assert.rejects(prepareRefresh(f.options), /覆盖了服务、账号或其他运行组件/);
  }
});
// 原来这里允许 Codex 包内的变化；GPT 退出平台后包内变化一律拒绝。仍然核对「根目录和字符串前缀相近」不会误伤：
// 旁边的 codex-other 独立工具目录在，只改 server.js 时照常可以计划和产出能过真实 gate 的记录。
test('干净的独立程序包旁边有前缀相近的目录时，server.js 变化照常可计划；Codex 包内变化（GPT 已退出平台）拒绝', async t => {
  const configure = async f => { await f.write(f.p('codex-other/tool.js'), '独立环境'); f.runtime.tools = { task: f.p('codex-other/tool.js') }; };
  const changedPackage = await realGateFixture(t, 'plain', configure);
  await fs.writeFile(changedPackage.tool, '程序内部变化，不再自动接受');
  await assert.rejects(prepareRefresh(changedPackage.options), /隔离边界或运行环境/);
  assert.deepEqual(JSON.parse(await fs.readFile(changedPackage.config.isolation.receipt)), changedPackage.receipt);
  const f = await realGateFixture(t, 'plain', configure);
  await fs.writeFile(f.p('server.js'), '允许的服务代码变化');
  const plan = await prepareRefresh(f.options), result = await plan.finalReceipt(), output = f.p('projected.json');
  assert.deepEqual(plan.changed.map(item => path.basename(item.path)), ['server.js']);
  await fs.writeFile(output, JSON.stringify(result)); assert.equal(f.gate.check(f.config, output, f.root).readyToEnableIsolation, true);
});
test('M9 sidecar 尚未交换时也拒绝清理声明为独立环境的目录，包括未创建子路径', async t => {
  for (const suffix of ['.new', '.prev', '.failed']) {
    const f = await realGateFixture(t, 'sidecar', async f => {
      const other = f.packageRoot + suffix; await f.write(path.join(other, 'tool.js'), '独立环境，不得删除');
      f.runtime.tools = { task: path.join(other, 'tool.js') };
    });
    await assert.rejects(assertPackageBoundaries({ ...f.options, packageRoots: [f.packageRoot, f.packageRoot + suffix] }), /覆盖了服务、账号或其他运行组件/);
    assert.equal(await fs.readFile(path.join(f.packageRoot + suffix, 'tool.js'), 'utf8'), '独立环境，不得删除');
  }
  const f = await realGateFixture(t, 'missing-sidecar');
  const config = { ...f.config, isolation: { ...f.config.isolation, gptHome: path.join(f.packageRoot + '.new', 'future-home') } };
  await assert.rejects(assertPackageBoundaries({ ...f.options, config, packageRoots: [f.packageRoot, f.packageRoot + '.new'] }), /覆盖了服务、账号或其他运行组件/);
});
// GPT 退出平台后 Codex 候选在任何核对之前就被拒绝（只能是 Claude）；这里仍要求：不运行验收、不产出记录
test('M9 候选在独立 PATH 空目录新增脚本也必须在验收前拒绝', async t => {
  const candidate = require('../tools/maintenance-candidate.cjs');
  const f = await realGateFixture(t, 'candidate-empty', async f => { f.runtime.pathDirs = [path.dirname(f.tool)]; });
  await fs.cp(f.packageRoot, f.packageRoot + '.new', { recursive: true });
  await f.write(path.join(f.packageRoot + '.new', 'resources/tool.js'), '候选新增的独立环境脚本');
  const folder = f.p('data/maintenance/transactions/' + 'b'.repeat(32)); await fs.mkdir(folder, { recursive: true });
  const calls = [], outputReceipt = path.join(folder, 'receipt.candidate.json');
  const options = { root: f.root, config: f.config, receiptPath: f.config.isolation.receipt, program: 'Codex', outputReceipt };
  const runCheck = async request => {
    calls.push(request.kind); await fs.writeFile(request.logFile, '合成替身，未执行模型');
    if (request.kind === 'e2e') {
      const bound = await candidate.validateHarnessCandidate({ root: f.root, config: f.config, program: 'Codex', manifestPath: request.args[1], transactionId: 'b'.repeat(32) });
      await fs.writeFile(request.args[2], JSON.stringify({ checks: Object.fromEntries(candidate.E2E_REQUIRED.map(name => [name, true])), candidate: bound.evidence }));
    }
    return { ok: true, status: 0 };
  };
  await assert.rejects(candidate.preacceptCandidate(options, { gate: f.gate, runCheck }), /只能是 Claude：GPT 已退出平台/);
  assert.deepEqual(calls, []); await assert.rejects(fs.access(outputReceipt));
});
