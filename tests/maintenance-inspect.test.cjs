'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { gitState, checkpointReport, digest } = require('../tools/maintenance-inspect.cjs');
async function fixture(t) {
  const base = os.tmpdir(), root = await fs.mkdtemp(path.join(base, 'relay-inspect-'));
  t.after(async () => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('relay-inspect-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'server.js'), program = path.join(root, 'program.exe'), model = path.join(root, 'model.bin'), user = path.join(root, 'user');
  const oldSource = path.join(root, 'old-server.js'), receiptFile = path.join(root, 'old-receipt.json');
  await fs.mkdir(user);
  await Promise.all([fs.writeFile(source, 'NEW_SOURCE'), fs.writeFile(oldSource, 'OLD_SOURCE'), fs.writeFile(program, 'PINNED_PROGRAM'), fs.writeFile(model, 'SYNTHETIC_MODEL')]);
  const receipt = { schema: 2, completedAt: new Date().toISOString(), configurationFingerprint: 'SYNTHETIC_BINDING',
    checks: { boundary: { passed: true }, regression: { passed: true } },
    fingerprints: [{ path: source, sha256: digest('OLD_SOURCE') }, { path: program, sha256: digest('PINNED_PROGRAM') }] };
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  const options = { root, config: { openaiApiKey: 'SYNTHETIC_NOT_A_CREDENTIAL', users: [{ id: 'synthetic', workDir: user }] }, runtime: { whisperModel: model },
    gate: { RECEIPT_SCHEMA: 2, REQUIRED: ['boundary','regression'], configurationFingerprint: () => 'SYNTHETIC_BINDING', requiredFingerprintFiles: () => [source, program] } };
  return { root, source, program, oldSource, receiptFile, receipt, options, checkpoint: { sourcePath: oldSource, receiptPath: receiptFile },
    writeReceipt: () => fs.writeFile(receiptFile, JSON.stringify(receipt)) };
}
test('M3 检查点核对旧源码和配套记录，不修改当前源码或正式记录', async t => {
  const f = await fixture(t), before = await fs.readFile(f.receiptFile);
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, true);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'NEW_SOURCE');
  assert.deepEqual(await fs.readFile(f.receiptFile), before);
});
test('M3 另一程序升级后旧记录不再兼容，不能宣称已恢复', async t => {
  const f = await fixture(t); await fs.writeFile(f.program, 'NEWER_PINNED_PROGRAM');
  const result = await checkpointReport(f.checkpoint, f.options);
  assert.equal(result.ok, false); assert.ok(result.reasons.some(reason => reason.includes('其他运行文件已变化')));
});
test('M3 旧源码不匹配自己的记录或检查点被改动均拒绝', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.oldSource, 'UNVERIFIED_SOURCE');
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, false);
  await fs.writeFile(f.oldSource, 'OLD_SOURCE');
  assert.equal((await checkpointReport({ ...f.checkpoint, receiptSha256: '0'.repeat(64) }, f.options)).ok, false);
});
test('M3 缺少必需项、缺少指纹、重复指纹及配置变化均拒绝', async t => {
  const f = await fixture(t);
  f.receipt.checks.boundary.passed = false; await f.writeReceipt();
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, false);
  f.receipt.checks.boundary.passed = true; f.receipt.fingerprints.pop(); await f.writeReceipt();
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, false);
  f.receipt.fingerprints.push({ path: f.program, sha256: digest('PINNED_PROGRAM') });
  f.receipt.fingerprints.push({ ...f.receipt.fingerprints[0] }); await f.writeReceipt();
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, false);
  f.receipt.fingerprints.pop(); f.receipt.configurationFingerprint = 'CHANGED_ACCOUNT'; await f.writeReceipt();
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, false);
});
test('M3 账号根目录不再是目录时不能通过检查点核对', async t => {
  const f = await fixture(t), user = f.options.config.users[0].workDir;
  await fs.rmdir(user); await fs.writeFile(user, 'SYNTHETIC_FILE');
  assert.equal((await checkpointReport(f.checkpoint, f.options)).ok, false);
});
test('M3 Git 查询失败与未提交代码均不提供自动验收资格', async t => {
  const f = await fixture(t);
  const run = async (exe, args) => {
    if (args.includes('status')) return { ok: true, bytes: Buffer.from(' M server.js\0') };
    if (args.includes('rev-parse')) return { ok: true, bytes: Buffer.from('a'.repeat(40)) };
    return { ok: true, bytes: Buffer.from('COMMITTED_SOURCE') };
  };
  const state = await gitState(f.root, { run });
  assert.equal(state.clean, false); assert.equal(state.sourceMatchesHead, false);
  const failed = await gitState(f.root, { run: async () => ({ ok: false }) });
  assert.equal(failed.clean, false); assert.equal(failed.sourceMatchesHead, false);
});
test('M3 Git 干净且源码逐字节等于 HEAD 才返回匹配', async t => {
  const f = await fixture(t);
  const run = async (exe, args) => ({ ok: true, bytes: args.includes('status') ? Buffer.alloc(0) : args.includes('rev-parse') ? Buffer.from('b'.repeat(40)) : Buffer.from('NEW_SOURCE') });
  const state = await gitState(f.root, { run });
  assert.equal(state.clean, true); assert.equal(state.sourceMatchesHead, true); assert.equal(state.headSourceSha256, digest('NEW_SOURCE'));
});
