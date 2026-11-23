'use strict';
// 46 文件合成包；只读写临时夹具，绝不启动程序或更新正式验收记录。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises;
const path = require('node:path'), os = require('node:os');
const helper = require('../tools/codex-fingerprints.cjs'), gate = require('../tools/check-isolation.cjs');
const repair = require('../tools/maintenance-repair-inspect.cjs');
function packageAt(directory, version = '1.2.3') {
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true }); fs.mkdirSync(path.join(directory, 'resources'));
  fs.writeFileSync(path.join(directory, 'bin', 'codex.exe'), 'SYNTHETIC_CODEX_' + version);
  fs.writeFileSync(path.join(directory, 'codex-package.json'), JSON.stringify({ layoutVersion: 1, variant: 'codex', version,
    target: 'x86_64-pc-windows-msvc', entrypoint: 'bin/codex.exe' }));
  for (let i = 0; i < 44; i++) fs.writeFileSync(path.join(directory, 'resources', 'file-' + i + ['.json', '.md', '.dll', '.exe'][i % 4]), 'SYNTHETIC_RESOURCE_' + i);
  return path.join(directory, 'bin', 'codex.exe');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-m9-'));
  t.after(() => { const real = fs.realpathSync.native(root); assert.equal(path.dirname(real).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase()); assert.ok(path.basename(real).startsWith('relay-m9-')); fs.rmSync(real, { recursive: true, force: true }); });
  const exe = packageAt(path.join(root, 'codex')), runtimeRoot = path.join(root, 'runtime'), work = path.join(root, 'work');
  fs.mkdirSync(runtimeRoot); fs.mkdirSync(work);
  const entry = path.join(runtimeRoot, 'synthetic.exe'); fs.writeFileSync(entry, 'SYNTHETIC_RUNTIME');
  for (const relative of gate.SOURCE_FILES) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'SYNTHETIC_SOURCE_' + relative); }
  const runtime = Object.fromEntries(['desktopHost', 'nodePath', 'codexPath', 'claudePath', 'python', 'ffmpeg', 'libreOffice', 'xlsxScript'].map(name => [name, entry]));
  runtime.codexPath = exe; runtime.whisperModel = runtimeRoot;
  const config = { openaiApiKey: 'SYNTHETIC', users: [{ id: 'synthetic', workDir: work }], isolation: { enabled: true,
    runtimeManifest: path.join(root, 'runtime-manifest.json'), receipt: path.join(root, 'receipt.json') } };
  fs.writeFileSync(config.isolation.runtimeManifest, JSON.stringify(runtime)); fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const receipt = { schema: gate.RECEIPT_SCHEMA, completedAt: new Date().toISOString(), checks: Object.fromEntries(gate.REQUIRED.map(name => [name, { passed: true, evidence: ['SYNTHETIC_ONLY'] }])),
    configurationFingerprint: gate.configurationFingerprint(config, runtime, root),
    fingerprints: gate.requiredFingerprintFiles(config, runtime, root).map(file => ({ path: file, sha256: gate.hashFile(file) })) };
  const save = () => fs.writeFileSync(config.isolation.receipt, JSON.stringify(receipt)); save();
  return { root, exe, runtime, config, receipt, save, check: () => gate.check(config, undefined, root), packageRoot: path.dirname(path.dirname(exe)) };
}
test('完整合成包的 46 个文件逐一篡改都不能通过原验收核对', async t => {
  const f = fixture(t), files = helper.enumerateCodexFilesSync(f.exe);
  assert.equal(files.length, 46); assert.equal(f.check().readyToEnableIsolation, true);
  for (const file of files) await t.test(path.relative(f.packageRoot, file), () => {
    const original = fs.readFileSync(file); fs.appendFileSync(file, '\nSYNTHETIC_CHANGE');
    try { assert.equal(f.check().readyToEnableIsolation, false, file); } finally { fs.writeFileSync(file, original); }
  });
  assert.equal(f.check().readyToEnableIsolation, true);
});
test('新增和删除任意扩展名文件都失败，删除不能被忽略', t => {
  const f = fixture(t), extra = path.join(f.packageRoot, 'new.unknown-extension'), deleted = path.join(f.packageRoot, 'resources', 'file-1.md');
  fs.writeFileSync(extra, 'SYNTHETIC_NEW'); assert.equal(f.check().readyToEnableIsolation, false); fs.unlinkSync(extra);
  const original = fs.readFileSync(deleted); fs.unlinkSync(deleted); assert.equal(f.check().readyToEnableIsolation, false);
  fs.writeFileSync(deleted, original); assert.equal(f.check().readyToEnableIsolation, true);
});
test('重复指纹即使摘要相同也拒绝，所有 REQUIRED 项仍逐项必须完成', t => {
  const f = fixture(t); f.receipt.fingerprints.push({ ...f.receipt.fingerprints[0] }); f.save(); assert.equal(f.check().readyToEnableIsolation, false);
  f.receipt.fingerprints.pop();
  for (const name of gate.REQUIRED) {
    f.receipt.checks[name].passed = false; f.save(); assert.equal(f.check().readyToEnableIsolation, false, name); f.receipt.checks[name].passed = true;
  }
  f.save(); assert.equal(f.check().readyToEnableIsolation, true);
});
test('serviceRoot 绑定测试服务自身源码，异步修复枚举与同步 gate 完全一致', async t => {
  const f = fixture(t), sync = gate.requiredFingerprintFiles(f.config, f.runtime, f.root), asynchronous = await repair.requiredFiles(f.config, f.runtime, f.root, gate);
  assert.deepEqual(asynchronous, sync);
  for (const relative of gate.SOURCE_FILES) assert.ok(sync.includes(fs.realpathSync.native(path.join(f.root, relative))));
  assert.ok(!sync.includes(path.resolve(__dirname, '..', 'server.js')));
  assert.equal((await repair.inspectRepairState({ root: f.root, gate })).gateReady, true);
  fs.writeFileSync(path.join(f.packageRoot, 'added.json'), '{}');
  const report = await repair.inspectRepairState({ root: f.root, gate }); assert.equal(report.gateReady, false); assert.ok(report.changes.length);
});
test('测试服务数据根与实际加载代码根不同，必须由可信调用方显式绑定 sourceRoot', t => {
  const f = fixture(t), stage = path.join(f.root, 'synthetic-stage'); fs.mkdirSync(stage);
  f.receipt.configurationFingerprint = gate.configurationFingerprint(f.config, f.runtime, stage);
  f.receipt.fingerprints = gate.requiredFingerprintFiles(f.config, f.runtime, stage, f.root).map(file => ({ path: file, sha256: gate.hashFile(file) })); f.save();
  assert.equal(gate.check(f.config, undefined, stage, f.root).readyToEnableIsolation, true);
  assert.equal(gate.check(f.config, undefined, stage).readyToEnableIsolation, false);
  const untrusted = { ...f.config, sourceRoot: f.root, isolation: { ...f.config.isolation, sourceRoot: f.root } };
  assert.equal(gate.check(untrusted, undefined, stage).readyToEnableIsolation, false);
  fs.appendFileSync(path.join(f.root, 'server.js'), 'CHANGED_LOADED_SOURCE');
  assert.equal(gate.check(f.config, undefined, stage, f.root).readyToEnableIsolation, false);
});
test('目录联接及包祖先链接均拒绝，不读取或修改外部目标', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'untouched.txt'), 'SYNTHETIC_OUTSIDE');
  const link = path.join(f.packageRoot, 'link'); fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => helper.enumerateCodexFilesSync(f.exe), /链接|重定向/); await assert.rejects(helper.hashCodexPackage(f.exe), /链接|重定向/);
  fs.rmdirSync(link); const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.packageRoot, alias, 'junction');
  await assert.rejects(helper.enumerateCodexFiles(path.join(alias, 'bin', 'codex.exe')), /重定向/);
  fs.rmdirSync(alias); assert.equal(fs.readFileSync(path.join(outside, 'untouched.txt'), 'utf8'), 'SYNTHETIC_OUTSIDE');
});
test('文件硬链接和任意入口布局都拒绝', async t => {
  const f = fixture(t), extra = path.join(f.packageRoot, 'alias.dll'); fs.linkSync(f.exe, extra);
  await assert.rejects(helper.hashCodexPackage(f.exe), /链接/); fs.unlinkSync(extra);
  await assert.rejects(helper.hashCodexPackage(path.join(f.root, 'synthetic.exe')), /bin\/codex/);
  assert.throws(() => helper.enumerateCodexFilesSync(path.join(path.parse(f.root).root, 'bin', 'codex.exe')), /磁盘根/);
});
test('读取期间同尺寸改写并还原 mtime 仍由 ctime 拒绝', async t => {
  const f = fixture(t), file = path.join(f.packageRoot, 'resources', 'file-0.json'), before = fs.statSync(file), bytes = fs.readFileSync(file);
  const originalOpen = fsp.open; let changed = false;
  fsp.open = async function(target, flags, ...args) {
    const handle = await originalOpen.call(this, target, flags, ...args), read = handle.read.bind(handle);
    if (path.resolve(target) === file && flags === 'r') handle.read = async (...values) => {
      const result = await read(...values);
      if (!changed && result.bytesRead) { changed = true; fs.writeFileSync(file, Buffer.alloc(bytes.length, 88)); fs.utimesSync(file, before.atime, before.mtime); }
      return result;
    };
    return handle;
  };
  try { await assert.rejects(helper.hashCodexPackage(f.exe), /变化|替换/); assert.equal(changed, true); }
  finally { fsp.open = originalOpen; fs.writeFileSync(file, bytes); }
});
test('读取期间替换 inode 即使字节不变也拒绝', async t => {
  const f = fixture(t), file = path.join(f.packageRoot, 'resources', 'file-0.json'), moved = path.join(f.root, 'replaced-old-file'), bytes = fs.readFileSync(file);
  const originalOpen = fsp.open; let changed = false;
  fsp.open = async function(target, flags, ...args) {
    const handle = await originalOpen.call(this, target, flags, ...args), read = handle.read.bind(handle);
    if (path.resolve(target) === file && flags === 'r') handle.read = async (...values) => {
      const result = await read(...values);
      if (!changed && result.bytesRead) { changed = true; fs.renameSync(file, moved); fs.writeFileSync(file, bytes); }
      return result;
    };
    return handle;
  };
  try { await assert.rejects(helper.hashCodexPackage(f.exe), /变化|替换/); assert.equal(changed, true); }
  finally { fsp.open = originalOpen; }
});
test('候选完整快照支持文件新增和删除，映射回已验证正式包根且不改变任何验收结论', async t => {
  const f = fixture(t), previous = await helper.hashCodexPackage(f.exe), candidateExe = packageAt(path.join(f.root, 'candidate'), '1.2.4');
  const candidateRoot = path.dirname(path.dirname(candidateExe)); fs.unlinkSync(path.join(candidateRoot, 'resources', 'file-1.md'));
  fs.writeFileSync(path.join(candidateRoot, 'new-file.json'), '{}'); const current = await helper.hashCodexPackage(candidateExe);
  const result = helper.replaceCodexFingerprints(f.receipt, { previous, current, destination: previous });
  assert.equal(result.checks, f.receipt.checks); assert.equal(result.configurationFingerprint, f.receipt.configurationFingerprint);
  assert.ok(result.fingerprints.some(item => item.path === path.join(f.packageRoot, 'new-file.json')));
  assert.ok(!result.fingerprints.some(item => item.path === path.join(f.packageRoot, 'resources', 'file-1.md')));
  assert.ok(!result.fingerprints.some(item => item.path.startsWith(candidateRoot)));
  for (const item of f.receipt.fingerprints.filter(item => !item.path.startsWith(f.packageRoot + path.sep))) assert.ok(result.fingerprints.includes(item));
});
test('已验收的同根包可精确替换内部指纹，但不能接受伪造根、改造旧记录或任意祖先', async t => {
  const f = fixture(t), previous = await helper.hashCodexPackage(f.exe);
  fs.unlinkSync(path.join(f.packageRoot, 'resources', 'file-1.md')); fs.writeFileSync(path.join(f.packageRoot, 'new.json'), '{}');
  const current = await helper.hashCodexPackage(f.exe), result = helper.replaceAfterAcceptance(f.receipt, { current });
  assert.ok(result.fingerprints.some(item => item.path === path.join(f.packageRoot, 'new.json'))); assert.equal(result.checks, f.receipt.checks);
  assert.throws(() => helper.replaceAfterAcceptance(f.receipt, { current: { ...current, root: f.root } }), /真实完整包/);
  assert.throws(() => helper.replaceCodexFingerprints(f.receipt, { previous: current, current: previous }), /不匹配/);
  const unbound = { ...f.receipt, fingerprints: f.receipt.fingerprints.filter(item => item.path !== f.exe) };
  assert.throws(() => helper.replaceAfterAcceptance(unbound, { current }), /没有绑定/);
  const damaged = { ...f.receipt, fingerprints: [...f.receipt.fingerprints, { ...f.receipt.fingerprints[0] }] };
  assert.throws(() => helper.replaceAfterAcceptance(damaged, { current }), /重复/);
});
test('即使两个包分别核对通过，也拒绝互相包含的程序根目录', async t => {
  const f = fixture(t), nestedExe = packageAt(path.join(f.packageRoot, 'nested-package'));
  const previous = await helper.hashCodexPackage(f.exe), current = await helper.hashCodexPackage(nestedExe);
  const receipt = helper.replaceAfterAcceptance(f.receipt, { current: previous });
  assert.throws(() => helper.replaceCodexFingerprints(receipt, { previous, current, destination: previous }), /相互包含/);
});
