'use strict';
// 只构造允许范围内的验收计划；不执行模型、发布记录或生成新的通过结论。
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const tx = require('./maintenance-transaction.cjs'), packages = require('./codex-fingerprints.cjs');
const key = file => path.resolve(file).toLowerCase();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const inside = (directory, file) => { const rel = path.relative(directory, file); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
async function canonical(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}
async function assertPackageBoundaries({ root, config, runtime, receiptPath, packageRoots, gate = require('./check-isolation.cjs') }) {
  if (!Array.isArray(packageRoots) || !packageRoots.length || packageRoots.some(file => !path.isAbsolute(file || '') || path.parse(file).root === path.resolve(file))) throw Error('程序包边界无效。');
  receiptPath ||= config.isolation?.receipt || path.join(root, 'data', 'isolation', 'acceptance.json');
  const points = new Set(), recursive = new Set();
  const add = file => { if (typeof file === 'string' && path.isAbsolute(file)) points.add(path.resolve(file)); };
  const tree = file => { add(file); if (typeof file === 'string' && path.isAbsolute(file)) recursive.add(path.resolve(file)); };
  // 不按字段名猜漏嵌套工具、技能、读取根或配置覆盖；唯一例外是本次正式 Codex 入口。
  function collect(value, skip, trail = []) {
    if (typeof value === 'string') { if (!skip(trail, value)) add(value); return; }
    if (!value || typeof value !== 'object') return;
    if (trail.length > 32) throw Error('配置嵌套范围无法安全核对。');
    for (const [name, item] of Object.entries(value)) collect(item, skip, [...trail, name]);
  }
  collect(runtime, trail => trail.length === 1 && trail[0] === 'codexPath');
  collect(config, (trail, value) => trail.length === 1 && trail[0] === 'codexPath' && key(value) === key(runtime.codexPath));
  for (const file of [root, path.join(root, 'config.json'), config.isolation?.runtimeManifest, receiptPath, process.execPath,
    ...(gate.SOURCE_FILES || ['server.js']).map(file => path.join(root, file)),
    ...(config.academicSearch ? [path.join(root, 'mcp-servers.json')] : [])]) add(file);
  tree(config.isolation?.privateRoot || path.join(root, 'data', 'isolation'));
  tree(config.isolation?.gptHome || path.join(root, 'data', 'codex-home'));
  for (const user of config.users || []) tree(user.workDir);
  // 与 gate 的脚本枚举一致：工具/技能父目录和 codeRoots 为递归执行范围。
  for (const file of [...Object.values(runtime.tools || {}), ...Object.values(runtime.skills || {})]) {
    if (!path.isAbsolute(file || '')) throw Error('非 Codex 运行入口无效。');
    tree(path.dirname(file)); tree(path.dirname(await canonical(file)));
  }
  for (const directory of runtime.codeRoots || []) tree(directory);
  if (runtime.nodeModules) tree(runtime.nodeModules);
  // PATH/TeX 只枚举当前目录；不把其上层目录任意扩为递归授权。
  for (const directory of runtime.pathDirs || []) add(directory);
  if (runtime.texBin) add(runtime.texBin);
  if (runtime.texGhostscript) add(path.join(runtime.texGhostscript, 'bin'));
  // 解释器和 Office 的同目录依赖可能经外部别名指入包，逐个解析真实目标。
  for (const interpreter of [runtime.python, runtime.gpuPython, runtime.evePython].filter(Boolean)) {
    const directory = path.dirname(await canonical(interpreter)); add(directory);
    for (const name of await fs.readdir(directory)) if (/\._pth$/i.test(name) || /^python\d*(?:_d)?\.dll$/i.test(name)) add(path.join(directory, name));
  }
  if (runtime.libreOffice) {
    const directory = path.dirname(await canonical(runtime.libreOffice)); add(directory);
    for (const name of ['soffice.exe', 'soffice.com', 'soffice.bin']) add(path.join(directory, name));
  }
  const roots = await Promise.all(packageRoots.map(file => canonical(path.resolve(file))));
  for (const file of points) {
    const real = await canonical(file), isTree = recursive.has(file);
    for (const base of roots) if (key(base) === key(real) || inside(base, real) || isTree && inside(real, base))
      throw Error('Codex 包根覆盖了服务、账号或其他运行组件，不能自动接受此范围。');
  }
  return true;
}
function validateReceipt(receipt, gate) {
  if (receipt?.schema !== gate.RECEIPT_SCHEMA || !Array.isArray(gate.REQUIRED) ||
      gate.REQUIRED.some(name => receipt.checks?.[name]?.passed !== true) ||
      !Array.isArray(receipt.fingerprints) || !receipt.fingerprints.length) throw Error('验收记录格式或原有边界结论不完整，需要完整重新验收。');
  const seen = new Set();
  for (const item of receipt.fingerprints) {
    if (!path.isAbsolute(item?.path || '') || !/^[a-f0-9]{64}$/i.test(item.sha256 || '') || seen.has(key(item.path))) throw Error('验收指纹缺失、重复或无效，需要完整重新验收。');
    seen.add(key(item.path));
  }
}
async function prepareRefresh(options, dependencies = {}) {
  const root = path.resolve(options.root), gate = dependencies.gate || require('./check-isolation.cjs');
  const configPath = path.join(root, 'config.json'), receiptPath = path.resolve(options.receiptPath);
  const configBytes = await fs.readFile(configPath), config = JSON.parse(configBytes);
  if (!isDeepStrictEqual(config, options.config) || !config.isolation?.enabled) throw Error('配置在读取期间发生变化，拒绝验收。');
  const manifestPath = config.isolation.runtimeManifest;
  const manifestBytes = await fs.readFile(manifestPath), runtime = JSON.parse(manifestBytes);
  const receiptBytes = await fs.readFile(receiptPath), original = JSON.parse(receiptBytes);
  validateReceipt(original, gate);
  const bound = new Map([[key(configPath), { file: configPath, sha256: hash(configBytes) }],
    [key(manifestPath), { file: manifestPath, sha256: hash(manifestBytes) }],
    [key(receiptPath), { file: receiptPath, sha256: hash(receiptBytes) }]]);
  const movedField = options.movedField, movedFrom = options.movedFrom;
  // 2026-11-23 GPT 退出平台：Codex 不再经 refresh 升级或迁移。Codex 程序除了曾经用来跑 GPT，还是每次执行工具时的沙箱宿主（isolation/executor.js 用它起 windows.sandbox=mxc 的 app-server，Claude 和 Gemini 的文件、命令工具都经过它）。换沙箱宿主应当重跑边界探针，光靠端到端不够，所以它的变化要走完整验收。
  if (movedField === 'codexPath') throw Error('GPT 已退出平台，Codex 程序不再升级或迁移，需要完整重新验收。');
  if (!!movedField !== !!movedFrom || movedField && movedField !== 'claudePath') throw Error('程序路径迁移参数无效。');
  let oldReal = null;
  if (movedFrom) {
    if (!path.isAbsolute(movedFrom) || !path.isAbsolute(runtime[movedField] || '')) throw Error('程序迁移入口必须是绝对路径。');
    const text = manifestBytes.toString('utf8'), current = `"${movedField}": ${JSON.stringify(runtime[movedField])}`;
    if (text.split(current).length !== 2) throw Error('清单格式不对，无法证明只改变一个程序路径。');
    const restored = text.replace(current, () => `"${movedField}": ${JSON.stringify(movedFrom)}`);
    const entry = original.fingerprints.find(item => key(item.path) === key(manifestPath));
    if (!entry || hash(restored) !== entry.sha256.toLowerCase()) throw Error('清单除了这个程序路径之外还有变化，需要完整重新验收。');
    if (original.configurationFingerprint !== gate.configurationFingerprint(config, { ...runtime, [movedField]: movedFrom }, root)) throw Error('账号或执行路径配置发生变化，需要完整重新验收。');
    oldReal = await fs.realpath(movedFrom);
    if (!original.fingerprints.some(item => key(item.path) === key(oldReal))) throw Error('验收记录没有绑定原程序入口。');
  } else if (original.configurationFingerprint !== gate.configurationFingerprint(config, runtime, root)) {
    throw Error('账号或执行路径配置发生变化，需要完整重新验收。');
  }
  // Codex 完整包：仍核对包根不吞入服务、账号和其他运行组件，验收期间整包不能变（assertUnchanged）。
  // GPT 退出平台后不再接受包内任何变化：包里的文件和其他运行环境文件一样走下面的逐个核对，改动、删除会被拒绝，
  // 新增的文件不在原记录里，由「必需文件都要被原记录覆盖」那一步拒绝。原来按当前包重写指纹的那一步（replaceAfterAcceptance）不再调用。
  const current = await packages.hashCodexPackage(runtime.codexPath);
  const checkBoundaries = () => assertPackageBoundaries({ root, config, runtime, receiptPath, gate, packageRoots: [current.root] });
  await checkBoundaries();
  let projected = clone(original);
  if (movedField === 'claudePath') {
    const oldHash = await tx.fileHash(oldReal);
    const oldEntry = original.fingerprints.find(item => key(item.path) === key(oldReal));
    if (oldHash !== oldEntry.sha256.toLowerCase()) throw Error('原 Claude 程序与验收记录不同，不能证明路径迁移。');
    bound.set(key(oldReal), { file: oldReal, sha256: oldHash });
    projected.fingerprints = projected.fingerprints.filter(item => key(item.path) !== key(oldReal));
    projected.fingerprints.push({ path: path.resolve(runtime.claudePath), sha256: await tx.fileHash(runtime.claudePath) });
  }
  const allowed = new Set([key(path.join(root, 'server.js')), key(runtime.claudePath), ...(movedFrom ? [key(manifestPath)] : [])]);
  const refused = [];
  for (const item of original.fingerprints) {
    if (movedField === 'claudePath' && key(item.path) === key(oldReal)) continue;
    let actual = null; try { actual = await tx.fileHash(item.path); } catch {}
    if (!actual || actual !== item.sha256.toLowerCase() && !allowed.has(key(item.path))) refused.push(item.path);
    if (actual) {
      const prior = bound.get(key(item.path));
      if (prior && prior.sha256 !== actual) throw Error('配置或记录在核对期间发生变化，拒绝验收。');
      bound.set(key(item.path), { file: item.path, sha256: actual });
    }
  }
  // 已经被拒绝的条目（比如被删掉的 Codex 包文件）不再重算指纹，免得报成读不到文件；下面统一列进拒绝原因
  const refusedKeys = new Set(refused.map(key));
  for (const item of projected.fingerprints) {
    if (refusedKeys.has(key(item.path))) continue;
    const existing = bound.get(key(item.path));
    if (existing) item.sha256 = existing.sha256;
    else {
      const actual = await tx.fileHash(item.path);
      bound.set(key(item.path), { file: item.path, sha256: actual }); item.sha256 = actual;
    }
  }
  const requiredFiles = () => gate.requiredFingerprintFiles(config, runtime, root);
  const required = requiredFiles().map(key).sort();
  const covered = new Set(projected.fingerprints.map(item => key(item.path)));
  for (const file of requiredFiles()) if (!covered.has(key(file))) refused.push(file);
  if (refused.length) throw Error('这些隔离边界或运行环境文件不能自动验收：' + refused.slice(0, 30).join('；'));
  if (movedFrom) projected.configurationFingerprint = gate.configurationFingerprint(config, runtime, root);
  validateReceipt(projected, gate);
  const oldRows = new Map(original.fingerprints.map(item => [key(item.path), item]));
  const newRows = new Map(projected.fingerprints.map(item => [key(item.path), item]));
  const changed = [];
  for (const [name, item] of oldRows) if (!newRows.has(name)) changed.push({ path: item.path, sha256: null, change: 'deleted' });
  for (const [name, item] of newRows) if (oldRows.get(name)?.sha256.toLowerCase() !== item.sha256.toLowerCase())
    changed.push({ path: item.path, sha256: item.sha256, change: oldRows.has(name) ? 'modified' : 'added' });
  async function assertUnchanged() {
    await checkBoundaries();
    for (const value of bound.values()) if (await tx.fileHash(value.file) !== value.sha256) throw Error('验收期间文件变化，结果作废。');
    if ((await packages.hashCodexPackage(current.exe)).fingerprint !== current.fingerprint ||
        JSON.stringify(requiredFiles().map(key).sort()) !== JSON.stringify(required)) throw Error('验收期间程序完整目录或运行入口变化，结果作废。');
    // 程序较大，末尾再核对全部非包文件，避免包哈希等待期间混入边界或配置变化。
    for (const value of bound.values()) if (await tx.fileHash(value.file) !== value.sha256) throw Error('验收期间边界、配置或记录变化，结果作废。');
    await checkBoundaries();
  }
  await assertUnchanged();
  return { config, runtime, manifestPath, changed, receipt: clone(projected), assertUnchanged,
    async finalReceipt() { await assertUnchanged(); return clone(projected); } };
}
module.exports = { prepareRefresh, assertPackageBoundaries };
