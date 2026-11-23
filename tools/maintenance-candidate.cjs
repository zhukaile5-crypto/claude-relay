'use strict';
// 候选验收只替换测试清单中的一个已批准程序入口，正式配置与程序保持原状。
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const tx = require('./maintenance-transaction.cjs');
const packages = require('./codex-fingerprints.cjs');
const acceptance = require('./maintenance-acceptance.cjs');
const { isDeepStrictEqual } = require('node:util');
// 和 refresh-isolation-receipt.cjs 的 E2E_REQUIRED 一致；GPT 退出平台后去掉了 gptContinuation
const E2E_REQUIRED = ['loginAndModels', 'crossTabMismatch', 'projects', 'uploadDownloadAccountBoundary', 'resumableUpload', 'signedHtml', 'officePreviews',
  'voiceRoundTrip', 'claudeContinuation', 'liveEvents', 'conversationSaved', 'conversationAccountBoundary'];
const key = file => path.resolve(file).toLowerCase();
const copy = value => JSON.parse(JSON.stringify(value));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function candidatePaths({ root, runtime, config, program, outputReceipt }) {
  // 2026-11-23 GPT 退出平台：只接受 Claude 候选。Codex 程序除了曾经用来跑 GPT，还是每次执行工具时的沙箱宿主（isolation/executor.js 用它起 windows.sandbox=mxc 的 app-server，Claude 和 Gemini 的文件、命令工具都经过它）。换沙箱宿主应当重跑边界探针，光靠端到端不够，所以 Codex 的任何变化都要走完整验收，不能当候选自动升级。
  // 下面 Codex 包的路径推导留着不删（清理旧事务时 cleanupCandidateManifest 仍认得 Codex 记录），但走不到。
  const field = { Claude: 'claudePath' }[program];
  if (!field) throw Error(program === 'Codex' ? '候选程序只能是 Claude：GPT 已退出平台，Codex 程序不再升级' : '候选程序只能是 Claude');
  if (!path.isAbsolute(runtime[field] || '')) throw Error('正式程序入口必须是绝对路径');
  const executable = path.resolve(runtime[field]);
  if (path.isAbsolute(config[field] || '') && key(config[field]) !== key(executable)) throw Error('配置覆盖了清单程序入口，不能自动候选验收');
  const programRoot = program === 'Claude' ? executable : path.dirname(path.dirname(executable));
  if (program === 'Codex' && (path.basename(executable).toLowerCase() !== 'codex.exe' || path.basename(path.dirname(executable)).toLowerCase() !== 'bin')) throw Error('Codex 固定副本结构不符合维护约定');
  const candidateRoot = programRoot + '.new', candidateExe = program === 'Claude' ? candidateRoot : path.join(candidateRoot, 'bin', 'codex.exe');
  const folder = path.dirname(path.resolve(outputReceipt));
  if (path.basename(outputReceipt) !== 'receipt.candidate.json' || !/^[a-f0-9]{32}$/.test(path.basename(folder)) ||
      key(path.dirname(folder)) !== key(path.join(root, 'data', 'maintenance', 'transactions'))) throw Error('候选输出必须位于唯一维护事务目录');
  const transactionId = path.basename(folder);
  // 与正式清单同目录，保持隔离工具推导的 RELAY_RUNTIME 不变。
  return { field, programRoot, executable, candidateRoot, candidateExe, folder, transactionId,
    manifest: path.join(path.dirname(config.isolation.runtimeManifest), '.claude-relay-candidate-' + transactionId + '.json'),
    binding: path.join(folder, 'candidate-binding.json'), projectedReceipt: path.join(folder, 'receipt.projection.json') };
}
function candidateConfiguration(config, field, executable, manifest) {
  return { ...config, [field]: executable, isolation: { ...config.isolation, runtimeManifest: manifest } };
}
async function validateHarnessCandidate({ root, config, program, manifestPath, transactionId }) {
  if (!/^[a-f0-9]{32}$/.test(transactionId || '')) throw Error('候选验收缺少合法事务标识');
  const runtime = JSON.parse(await fsp.readFile(config.isolation.runtimeManifest, 'utf8'));
  const expectedOutput = path.join(root, 'data', 'maintenance', 'transactions', transactionId, 'receipt.candidate.json');
  const p = candidatePaths({ root, runtime, config, program, outputReceipt: expectedOutput });
  if (key(p.manifest) !== key(manifestPath)) throw Error('候选清单位置不符合维护约定');
  await tx.physical(p.manifest); await tx.physical(p.candidateRoot); await tx.physical(p.binding);
  const bound = JSON.parse(await fsp.readFile(p.binding, 'utf8'));
  if (bound.schema !== 1 || bound.transactionId !== transactionId || bound.program !== program ||
      key(bound.originalManifest) !== key(config.isolation.runtimeManifest) || key(bound.candidateManifest) !== key(p.manifest) ||
      bound.originalManifestHash !== await tx.fileHash(config.isolation.runtimeManifest) || bound.candidateManifestHash !== await tx.fileHash(p.manifest) ||
      bound.candidateProgramHash !== await tx.treeHash(p.candidateRoot) || bound.candidateExeHash !== await tx.fileHash(p.candidateExe)) throw Error('候选清单与维护事务绑定不一致');
  const candidateRuntime = JSON.parse(await fsp.readFile(p.manifest, 'utf8'));
  if (JSON.stringify(candidateRuntime) !== JSON.stringify({ ...runtime, [p.field]: p.candidateExe })) throw Error('临时清单改变了程序入口以外的内容');
  return { override: { [p.field]: p.candidateExe }, evidence: { program, manifestSha256: await tx.fileHash(p.manifest), executableSha256: await tx.fileHash(p.candidateExe) } };
}
async function cleanupCandidateManifest({ root, config, transactionId }) {
  if (!/^[a-f0-9]{32}$/.test(transactionId || '')) throw Error('候选清理事务标识无效');
  const folder = path.join(root, 'data', 'maintenance', 'transactions', transactionId), bindingFile = path.join(folder, 'candidate-binding.json');
  if (!await tx.exists(bindingFile)) return false;
  await tx.physical(bindingFile); const bound = JSON.parse(await fsp.readFile(bindingFile, 'utf8'));
  const manifest = path.join(path.dirname(config.isolation.runtimeManifest), '.claude-relay-candidate-' + transactionId + '.json');
  if (bound.schema !== 1 || bound.transactionId !== transactionId || !['Claude','Codex'].includes(bound.program) ||
      key(bound.originalManifest) !== key(config.isolation.runtimeManifest) || key(bound.candidateManifest) !== key(manifest) ||
      !/^[a-f0-9]{64}$/.test(bound.candidateManifestHash || '')) throw Error('候选清理记录不符合受信任路径');
  if (!await tx.exists(manifest)) return false;
  if (await tx.fileHash(manifest) !== bound.candidateManifestHash) throw Error('候选清单已被改动，保留文件供人工检查');
  await fsp.unlink(manifest); return true;
}
async function createManifest(file, bytes) {
  await tx.physical(file, true);
  const handle = await fsp.open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
const runCheck = acceptance.runNodeCheck;
async function preacceptCandidate(options, dependencies = {}) {
  const root = path.resolve(options.root), config = options.config, receiptPath = path.resolve(options.receiptPath), program = options.program;
  const gate = dependencies.gate || require('./check-isolation.cjs'), run = dependencies.runCheck || runCheck;
  const configFile = path.join(root, 'config.json'), manifestPath = config.isolation.runtimeManifest;
  const start = performance.now(), remaining = () => Math.max(0, (options.timeoutMs ?? 45 * 60e3) - (performance.now() - start));
  const requireTime = () => { if (!remaining()) throw Error('候选验收运行预算已用完'); };
  const configBytes = await fsp.readFile(configFile);
  if (!isDeepStrictEqual(JSON.parse(configBytes.toString('utf8')), config)) throw Error('传入配置与当前磁盘配置不同，拒绝使用过期配置验收');
  const manifestBytesBefore = await fsp.readFile(manifestPath), runtime = JSON.parse(manifestBytesBefore.toString('utf8'));
  const p = candidatePaths({ root, runtime, config, program, outputReceipt: options.outputReceipt });
  const checkProgramBoundaries = () => program === 'Codex' ? require('./maintenance-refresh-plan.cjs').assertPackageBoundaries({
    root, config, runtime, receiptPath, gate, packageRoots: [p.programRoot, p.candidateRoot] }) : Promise.resolve(true);
  await checkProgramBoundaries();
  await tx.physical(p.folder); await tx.physical(p.programRoot); await tx.physical(p.candidateRoot);
  if (await tx.exists(options.outputReceipt) || await tx.exists(p.manifest) || await tx.exists(p.projectedReceipt) || await tx.exists(p.binding)) throw Error('候选事务已有输出，不能重复使用');
  const baseline = gate.check(config, receiptPath, root);
  if (!baseline.readyToEnableIsolation) throw Error('当前正式验收未通过，不能自动接受候选程序');
  const receiptBytes = await fsp.readFile(receiptPath), receipt = JSON.parse(receiptBytes);
  const oldConfiguration = gate.configurationFingerprint(config, runtime, root);
  if (receipt.schema !== gate.RECEIPT_SCHEMA || receipt.configurationFingerprint !== oldConfiguration) throw Error('当前正式记录格式或配置绑定无效');
  // Claude 仍是单文件；Codex 仅接受严格枚举的完整包，不能上溯扩大范围。
  const targetEntries = receipt.fingerprints.filter(item => key(item.path) === key(p.executable));
  const manifestEntries = receipt.fingerprints.filter(item => key(item.path) === key(manifestPath));
  if (targetEntries.length !== 1 || manifestEntries.length !== 1) throw Error('正式记录必须唯一覆盖程序入口和清单');
  const previousPackage = program === 'Codex' ? await packages.hashCodexPackage(p.executable) : null;
  const currentPackage = program === 'Codex' ? await packages.hashCodexPackage(p.candidateExe) : null;
  if (previousPackage) packages.replaceCodexFingerprints(receipt, { previous: previousPackage, current: currentPackage });
  const binding = { programHash: await tx.treeHash(p.programRoot), candidateHash: await tx.treeHash(p.candidateRoot), receiptHash: digest(receiptBytes),
    configHash: digest(configBytes), manifestHash: digest(manifestBytesBefore), candidateExeHash: await tx.fileHash(p.candidateExe) };
  if (options.dryRun) return { ok: true, status: 0, dryRun: true, out: '候选范围核对通过；只读预览未运行验收、未写记录。' };
  requireTime();
  const candidateRuntime = { ...runtime, [p.field]: p.candidateExe };
  const manifestBytes = JSON.stringify(candidateRuntime, null, 2), manifestHash = digest(manifestBytes);
  await tx.atomicWrite(p.binding, JSON.stringify({ schema: 1, transactionId: p.transactionId, program, originalManifest: path.resolve(manifestPath),
    originalManifestHash: binding.manifestHash, candidateManifest: p.manifest, candidateManifestHash: manifestHash,
    candidateProgramHash: binding.candidateHash, candidateExeHash: binding.candidateExeHash }, null, 2));
  // 先绑定预计内容，再以独占创建写入；中断后的清理不能信任任意日志路径。
  await createManifest(p.manifest, manifestBytes);
  try {
  const candidateConfig = candidateConfiguration(config, p.field, p.candidateExe, p.manifest);
  const projection = previousPackage ? packages.replaceCodexFingerprints(copy(receipt), { previous: previousPackage, current: currentPackage }) : copy(receipt);
  projection.purpose = 'maintenance-candidate-projection-only';
  projection.configurationFingerprint = gate.configurationFingerprint(candidateConfig, candidateRuntime, root);
  if (!previousPackage) projection.fingerprints = projection.fingerprints.map(item => key(item.path) === key(p.executable) ? { path: p.candidateExe, sha256: binding.candidateExeHash } : item);
  projection.fingerprints = projection.fingerprints.map(item => key(item.path) === key(manifestPath) ? { path: p.manifest, sha256: manifestHash } : item);
  await tx.atomicWrite(p.projectedReceipt, JSON.stringify(projection, null, 2));
  if (!gate.check(candidateConfig, p.projectedReceipt, root).readyToEnableIsolation) throw Error('候选投影存在未批准的变化，拒绝验收');
  const evidenceDir = path.join(path.dirname(receiptPath), 'codex-security-artifacts-candidate-' + path.basename(p.folder));
  await tx.physical(evidenceDir, true); await fsp.mkdir(evidenceDir);
  async function assertBinding() {
    await checkProgramBoundaries();
    if (await tx.fileHash(configFile) !== binding.configHash || await tx.fileHash(manifestPath) !== binding.manifestHash ||
      await tx.fileHash(receiptPath) !== binding.receiptHash || await tx.treeHash(p.programRoot) !== binding.programHash ||
      await tx.treeHash(p.candidateRoot) !== binding.candidateHash || await tx.fileHash(p.manifest) !== manifestHash ||
      !gate.check(config, receiptPath, root).readyToEnableIsolation || !gate.check(candidateConfig, p.projectedReceipt, root).readyToEnableIsolation) throw Error('验收期间正式文件、候选或边界有变化，结果作废');
    if (previousPackage && ((await packages.hashCodexPackage(p.executable)).fingerprint !== previousPackage.fingerprint ||
        (await packages.hashCodexPackage(p.candidateExe)).fingerprint !== currentPackage.fingerprint)) throw Error('验收期间 Codex 完整包变化，结果作废');
    if (await tx.fileHash(configFile) !== binding.configHash || await tx.fileHash(manifestPath) !== binding.manifestHash ||
        await tx.fileHash(receiptPath) !== binding.receiptHash || !gate.check(config, receiptPath, root).readyToEnableIsolation ||
        !gate.check(candidateConfig, p.projectedReceipt, root).readyToEnableIsolation) throw Error('验收期间边界或记录变化，结果作废');
    await checkProgramBoundaries();
  }
  const accepted = await acceptance.runEvidence({ root, evidenceDir, manifestPath: p.manifest, requiredChecks: E2E_REQUIRED,
    extraArgs: ['--candidate-program=' + program, '--candidate-transaction=' + p.transactionId],
    candidateEvidence: { program, manifestSha256: manifestHash, executableSha256: binding.candidateExeHash },
    remaining, runCheck: run, beforeAttempt: assertBinding, readHostState: dependencies.readHostState, clock: dependencies.clock });
  if (!accepted.ok) return accepted;
  requireTime(); await assertBinding();
  let result = previousPackage ? packages.replaceCodexFingerprints(copy(receipt), { previous: previousPackage, current: currentPackage, destination: previousPackage }) : copy(receipt);
  if (!previousPackage) result.fingerprints = result.fingerprints.map(item => key(item.path) === key(p.executable) ? { ...item, sha256: binding.candidateExeHash } : item);
  const evidence = accepted.evidence;
  const changed = previousPackage ? [...new Set([...previousPackage.files, ...currentPackage.files].map(item => path.join(previousPackage.root, ...item.relative.split('/'))))] : [p.executable];
  result = require('./maintenance-receipt-history.cjs').refreshedEvidence(result, evidence, { at: new Date().toISOString(), changed, evidence,
    note: '替换前已用临时清单验证一个候选程序；正式记录保留正式路径，隔离边界结论沿用当前有效记录。' });
  if (result.configurationFingerprint !== oldConfiguration || result.fingerprints.some(item => key(item.path) === key(p.manifest) || key(item.path) === key(p.candidateRoot) || key(item.path).startsWith(key(p.candidateRoot) + path.sep))) throw Error('正式候选记录混入临时路径');
  // 这里尚未替换程序，因此不能用正式路径的当前文件谎称未来记录已生效。
  // 只输出已验证的精确投影，交换后由维护器再次核对并安装。
  await tx.atomicWrite(options.outputReceipt, JSON.stringify(result, null, 2));
  return { ...acceptance.resultSummary(accepted), status: 0, evidence, out: '候选已通过替换前验收；正式程序与记录未改动。' };
  } finally { await cleanupCandidateManifest({ root, config, transactionId: p.transactionId }); }
}
module.exports = { E2E_REQUIRED, candidatePaths, candidateConfiguration, validateHarnessCandidate, cleanupCandidateManifest, runCheck, preacceptCandidate };
