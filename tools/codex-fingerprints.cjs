'use strict';
// 完整 Codex 包的目录界限与稳定指纹。替换函数只是构造候选数据，不授予验收权限。
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const snapshots = new WeakSet(), MAX_FILES = 100000, MAX_DEPTH = 32;
const key = file => path.resolve(file).toLowerCase();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
function packageRoot(exe) {
  if (typeof exe !== 'string' || !path.isAbsolute(exe) || path.basename(exe).toLowerCase() !== 'codex.exe' || path.basename(path.dirname(exe)).toLowerCase() !== 'bin') throw Error('Codex 入口必须位于完整包的 bin/codex.exe');
  const root = path.dirname(path.dirname(path.resolve(exe)));
  if (root === path.parse(root).root) throw Error('Codex 包不能是磁盘根目录');
  return root;
}
function checkNode(file, stat, real, root, seen) {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1n)) throw Error('Codex 包含链接或特殊文件');
  if (key(real) !== key(file) || (key(file) !== key(root) && !within(root, file))) throw Error('Codex 包路径越界或被重定向');
  const name = key(file); if (seen.has(name)) throw Error('Codex 包含重复路径'); seen.add(name);
}
function checkMetadata(bytes) {
  if (bytes.length > 16384) throw Error('Codex 包元数据过大');
  let data; try { data = JSON.parse(bytes); } catch { throw Error('Codex 包元数据无效'); }
  if (data.layoutVersion !== 1 || data.entrypoint !== 'bin/codex.exe' || data.variant !== 'codex' ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(data.version || '') || !['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(data.target)) throw Error('Codex 包布局无法确认');
}
function ancestorList(root) {
  const result = []; let current = root;
  for (;;) { result.push(current); const parent = path.dirname(current); if (parent === current) return result.reverse(); current = parent; }
}
function scanSync(exe) {
  const root = packageRoot(exe), seen = new Set(), nodes = [], files = [];
  for (const directory of ancestorList(root)) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(fs.realpathSync.native(directory)) !== key(directory)) throw Error('Codex 包的祖先目录被重定向');
  }
  function visit(file, depth) {
    if (depth > MAX_DEPTH || nodes.length >= MAX_FILES) throw Error('Codex 包超过有限枚举范围');
    const stat = fs.lstatSync(file, { bigint: true }); checkNode(file, stat, fs.realpathSync.native(file), root, seen);
    nodes.push([file, identity(stat)]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), depth + 1);
    else files.push(file);
  }
  visit(root, 0); checkMetadata(fs.readFileSync(path.join(root, 'codex-package.json')));
  if (!files.some(file => key(file) === key(exe))) throw Error('Codex 包缺少入口');
  return { root, files, nodes };
}
async function scan(exe) {
  const root = packageRoot(exe), seen = new Set(), nodes = [], files = [];
  for (const directory of ancestorList(root)) {
    const stat = await fsp.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(await fsp.realpath(directory)) !== key(directory)) throw Error('Codex 包的祖先目录被重定向');
  }
  async function visit(file, depth) {
    if (depth > MAX_DEPTH || nodes.length >= MAX_FILES) throw Error('Codex 包超过有限枚举范围');
    const stat = await fsp.lstat(file, { bigint: true }); checkNode(file, stat, await fsp.realpath(file), root, seen);
    nodes.push([file, identity(stat)]);
    if (stat.isDirectory()) for (const name of (await fsp.readdir(file)).sort()) await visit(path.join(file, name), depth + 1);
    else files.push(file);
  }
  await visit(root, 0); checkMetadata(await fsp.readFile(path.join(root, 'codex-package.json')));
  if (!files.some(file => key(file) === key(exe))) throw Error('Codex 包缺少入口');
  return { root, files, nodes };
}
function enumerationMatches(before, after) { return before.root === after.root && JSON.stringify(before.nodes) === JSON.stringify(after.nodes); }
function enumerateCodexFilesSync(exe) {
  const before = scanSync(exe), after = scanSync(exe);
  if (!enumerationMatches(before, after)) throw Error('Codex 包在枚举期间发生变化');
  return before.files;
}
async function enumerateCodexFiles(exe) {
  const before = await scan(exe), after = await scan(exe);
  if (!enumerationMatches(before, after)) throw Error('Codex 包在枚举期间发生变化');
  return before.files;
}
async function hashCodexPackage(exe) {
  const before = await scan(exe), expected = new Map(before.nodes), files = [];
  for (const file of before.files) {
    const handle = await fsp.open(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    try {
      if (identity(await handle.stat({ bigint: true })) !== expected.get(file)) throw Error('Codex 文件在读取前被替换');
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
      if (identity(await handle.stat({ bigint: true })) !== expected.get(file) || identity(await fsp.lstat(file, { bigint: true })) !== expected.get(file)) throw Error('Codex 文件在读取期间变化');
      files.push(Object.freeze({ path: file, relative: path.relative(before.root, file).split(path.sep).join('/'), sha256: hash.digest('hex') }));
    } finally { await handle.close(); }
  }
  if (!enumerationMatches(before, await scan(exe))) throw Error('Codex 包在计算指纹期间变化');
  const snapshot = Object.freeze({ root: before.root, exe: path.resolve(exe), files: Object.freeze(files), fingerprint: digest(JSON.stringify(files.map(file => [file.relative, file.sha256]))) });
  snapshots.add(snapshot); return snapshot;
}
function verified(snapshot) { if (!snapshot || !snapshots.has(snapshot)) throw Error('程序根目录必须来自本次真实完整包核对'); return snapshot; }
function itemsOf(receipt) {
  if (!Array.isArray(receipt?.fingerprints) || !receipt.fingerprints.length) throw Error('缺少原验收指纹');
  const seen = new Set();
  for (const item of receipt.fingerprints) {
    if (!item || !path.isAbsolute(item.path || '') || !/^[a-f0-9]{64}$/i.test(item.sha256 || '') || seen.has(key(item.path))) throw Error('原验收指纹无效或重复');
    seen.add(key(item.path));
  }
  return receipt.fingerprints;
}
function replaced(receipt, previous, current, destination) {
  const old = verified(previous), next = verified(current), target = verified(destination), rows = itemsOf(receipt);
  const roots = [old.root, next.root, target.root];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
    if (key(roots[i]) !== key(roots[j]) && (within(roots[i], roots[j]) || within(roots[j], roots[i]))) throw Error('程序包根目录不能相互包含');
  const kept = rows.filter(item => !within(old.root, item.path));
  const added = next.files.map(file => ({ path: path.join(target.root, ...file.relative.split('/')), sha256: file.sha256 }));
  const all = [...kept, ...added], keys = new Set();
  for (const item of all) { if (keys.has(key(item.path))) throw Error('新程序指纹与非程序条目冲突'); keys.add(key(item.path)); }
  return { ...receipt, fingerprints: all };
}
function replaceCodexFingerprints(receipt, { previous, current, destination = current }) {
  verified(previous); verified(current); verified(destination);
  const oldRows = itemsOf(receipt).filter(item => within(previous.root, item.path));
  const expected = new Map(previous.files.map(file => [key(file.path), file.sha256]));
  if (oldRows.length !== expected.size || oldRows.some(item => expected.get(key(item.path)) !== item.sha256.toLowerCase())) throw Error('原验收记录与旧程序快照不匹配');
  return replaced(receipt, previous, current, destination);
}
function replaceAfterAcceptance(receipt, { current }) {
  verified(current);
  if (!itemsOf(receipt).some(item => key(item.path) === key(current.exe))) throw Error('原记录没有绑定这个程序包入口');
  // 此函数不能决定是否允许升级；调用方必须先拒绝所有边界变化、完成验收并再次核对原记录和全包指纹。
  return replaced(receipt, current, current, current);
}
module.exports = { enumerateCodexFilesSync, enumerateCodexFiles, hashCodexPackage, replaceCodexFingerprints, replaceAfterAcceptance };
