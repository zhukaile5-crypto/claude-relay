'use strict';
// M5 的只读状态快照；使用异步文件操作，不生成或修改验收记录。
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const codexFingerprints = require('./codex-fingerprints.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const key = value => path.resolve(value).toLowerCase();
const entries = ['desktopHost', 'nodePath', 'codexPath', 'claudePath', 'python', 'ffmpeg', 'libreOffice', 'xlsxScript'];
const optional = ['gpuPython', 'evePython', 'ffprobe', 'gitBash', 'pandoc', 'texPerl'];
const executableExtension = /\.(?:exe|com|dll|cmd|bat|ps1|py|pyw|js|cjs|mjs|vbs|sh|pl|pm|bs|al|ix|lua|tlu|rb)$/i;
async function canonical(file, missing = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('路径无效');
  const full = path.resolve(file);
  try { return await fs.realpath(full); }
  catch (error) {
    if (!missing || error.code !== 'ENOENT' || path.dirname(full) === full) throw error;
    return path.join(await canonical(path.dirname(full), true), path.basename(full));
  }
}
async function hashFile(file) {
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true }), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    if (!before.isFile()) throw Error('不是普通文件');
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    const after = await handle.stat({ bigint: true }), current = await fs.stat(file, { bigint: true });
    const same = value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(field => before[field] === value[field]);
    if (!same(after) || !same(current)) throw Error('读取期间发生变化');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
const executables = (config, runtime) => ({
  claude: path.isAbsolute(config.claudePath || '') ? config.claudePath : runtime.claudePath,
  codex: path.isAbsolute(config.codexPath || '') ? config.codexPath : runtime.codexPath,
  node: runtime.nodePath, hostNode: process.execPath,
});
async function configurationFingerprint(config, runtime, root) {
  const normalized = async file => (await canonical(file, true)).replace(/\\/g, '/').toLowerCase();
  const options = config.isolation || {}, users = [];
  for (const user of config.users || []) users.push({ id: user.id, workDir: await normalized(user.workDir) });
  users.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const programPaths = {};
  for (const [name, file] of Object.entries(executables(config, runtime))) programPaths[name] = await normalized(file);
  return digest(JSON.stringify({ schema: 1, users,
    privateRoot: await normalized(options.privateRoot || path.join(root, 'data', 'isolation')),
    gptHome: await normalized(options.gptHome || path.join(root, 'data', 'codex-home')),
    runtimeManifest: await normalized(options.runtimeManifest), academicSearch: !!config.academicSearch,
    researchConfig: config.academicSearch ? await normalized(path.join(root, 'mcp-servers.json')) : null,
    executables: programPaths,
  }));
}
async function requiredFiles(config, runtime, root, gate, options = {}) {
  let skippedRoot = null, skippedDirectory = false;
  if (options.skipProgramRoot !== undefined) {
    const requested = key(options.skipProgramRoot);
    const claude = [runtime.claudePath, executables(config, runtime).claude].filter(file => path.isAbsolute(file || ''));
    if (claude.some(file => key(file) === requested)) skippedRoot = requested;
    else {
      const codex = [runtime.codexPath, executables(config, runtime).codex].filter(file =>
        path.isAbsolute(file || '') && path.basename(file).toLowerCase() === 'codex.exe' && path.basename(path.dirname(file)).toLowerCase() === 'bin');
      const match = codex.find(file => key(path.dirname(path.dirname(file))) === requested &&
        path.dirname(path.dirname(file)) !== path.parse(file).root);
      if (!match) throw Error('跳过范围必须是已配置的单个Claude或完整Codex包根');
      // 回退中包根可能暂时缺失；必须能从当前包或.prev验证同一固定根的真实布局。
      let verified = false;
      for (const base of [path.dirname(path.dirname(match)), path.dirname(path.dirname(match)) + '.prev']) {
        try {
          // M6自足的最小布局核对；完整旧包另由事务treeHash绑定，不依赖后续M9枚举模块。
          for (const directory of [base, path.join(base, 'bin')]) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || key(await fs.realpath(directory)) !== key(directory)) throw Error();
          }
          for (const file of [path.join(base, 'bin', 'codex.exe'), path.join(base, 'codex-package.json')]) {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || key(await fs.realpath(file)) !== key(file)) throw Error();
          }
          const bytes = await fs.readFile(path.join(base, 'codex-package.json'));
          if (bytes.length > 16384) throw Error();
          const meta = JSON.parse(bytes);
          if (meta.layoutVersion !== 1 || meta.entrypoint !== 'bin/codex.exe' || meta.variant !== 'codex' ||
              !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(meta.version || '') ||
              !['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(meta.target)) throw Error();
          verified = true; break;
        } catch {}
      }
      if (!verified) throw Error('无法确认被回退的Codex包布局');
      skippedRoot = requested; skippedDirectory = true;
    }
  }
  const skip = file => skippedRoot && typeof file === 'string' &&
    (key(file) === skippedRoot || (skippedDirectory && key(file).startsWith(skippedRoot + path.sep)));

  const files = new Map(), visited = new Set(); let count = 0;
  const add = async file => { if (skip(file)) return; const real = await canonical(file); if (!(await fs.stat(real)).isFile()) throw Error('运行入口无效'); files.set(key(real), real); };
  async function scripts(directory, recursive = false, depth = 0) {
    if (skip(directory)) return;
    const real = await canonical(directory);
    if (visited.has(key(real))) return;
    visited.add(key(real));
    if (depth > 12 || visited.size > 1024) throw Error('脚本目录超限');
    for (const entry of await fs.readdir(real, { withFileTypes: true })) {
      if (++count > 20000 || entry.isSymbolicLink()) throw Error('脚本目录不可安全核对');
      const full = path.join(real, entry.name);
      if (entry.isDirectory()) { if (recursive && !['node_modules', '__pycache__', '.git'].includes(entry.name)) await scripts(full, true, depth + 1); }
      else if (entry.isFile() && executableExtension.test(entry.name)) await add(full);
    }
  }
  for (const relative of gate.SOURCE_FILES) await add(path.join(root, relative));
  await add(config.isolation.runtimeManifest);
  if (config.academicSearch) await add(path.join(root, 'mcp-servers.json'));
  for (const name of entries) await add(runtime[name]);
  for (const name of optional) if (runtime[name] !== undefined) await add(runtime[name]);
  for (const [name, value] of Object.entries(runtime)) if (/Script$/.test(name)) await add(value);
  for (const file of Object.values(executables(config, runtime))) await add(file);
  for (const exe of new Set([runtime.codexPath, executables(config, runtime).codex]))
    if (!skip(exe)) for (const file of await codexFingerprints.enumerateCodexFiles(exe)) await add(file);
  for (const file of [...Object.values(runtime.tools || {}), ...Object.values(runtime.skills || {})]) { await add(file); await scripts(path.dirname(file), true); }
  for (const interpreter of [runtime.python, runtime.gpuPython, runtime.evePython].filter(Boolean)) {
    const directory = path.dirname(await canonical(interpreter));
    for (const name of await fs.readdir(directory)) if (/\._pth$/i.test(name) || /^python\d*(?:_d)?\.dll$/i.test(name)) await add(path.join(directory, name));
  }
  for (const name of ['soffice.exe', 'soffice.com', 'soffice.bin']) {
    const file = path.join(path.dirname(await canonical(runtime.libreOffice)), name);
    try { await fs.access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await add(file);
  }
  for (const directory of runtime.pathDirs || []) await scripts(directory);
  for (const directory of runtime.codeRoots || []) await scripts(directory, true);
  if (runtime.texBin) await scripts(runtime.texBin);
  if (runtime.texGhostscript) await scripts(path.join(runtime.texGhostscript, 'bin'));
  return [...files.values()].sort((a, b) => key(a).localeCompare(key(b)));
}
async function inspectRepairState({ root, gate, configPath = path.join(root, 'config.json') }) {
  const changes = [], reasons = [], files = [], unreadable = [];
  try {
    const configBytes = await fs.readFile(configPath), config = JSON.parse(configBytes);
    if (config.isolation?.enabled !== true) throw Error('隔离未启用');
    const manifestPath = config.isolation.runtimeManifest, manifestBytes = await fs.readFile(manifestPath), runtime = JSON.parse(manifestBytes);
    const receiptPath = config.isolation.receipt || path.join(root, 'data', 'isolation', 'acceptance.json');
    const receiptBytes = await fs.readFile(receiptPath), receipt = JSON.parse(receiptBytes);
    const sourcePath = await canonical(path.join(root, 'server.js')), sourceKey = key(sourcePath);
    const programs = new Set();
    for (const file of [runtime.claudePath, runtime.codexPath, ...Object.values(executables(config, runtime)).slice(0, 2)]) programs.add(key(await canonical(file)));
    const kind = file => key(file) === sourceKey ? 'server' : programs.has(key(file)) ? 'program' : key(file).startsWith(key(path.join(root, 'isolation')) + path.sep) || gate.SOURCE_FILES.some(relative => key(path.join(root, relative)) === key(file)) ? 'isolation' : 'runtime';
    const problem = (reason, category = 'unknown') => { reasons.push(reason); changes.push({ kind: category }); };
    if (receipt.schema !== gate.RECEIPT_SCHEMA || !Number.isFinite(Date.parse(receipt.completedAt))) problem('验收记录格式无效');
    for (const name of gate.REQUIRED) if (receipt.checks?.[name]?.passed !== true) problem('验收项未完成');
    if (receipt.configurationFingerprint !== await configurationFingerprint(config, runtime, root)) problem('账号或执行路径配置不一致', 'config');
    // 和门槛（check-isolation 的 gptRetirementReason）一致：GPT 已退出平台，不再要求密钥，而是要求没有账号开着 GPT
    const gptRetired = require('./check-isolation.cjs').gptRetirementReason(config);
    if (gptRetired) problem(gptRetired, 'config');
    if (!path.isAbsolute(runtime.whisperModel || '')) problem('语音模型入口无效', 'runtime');
    else { try { await fs.access(runtime.whisperModel); } catch { problem('语音模型不可读取', 'runtime'); } }
    const ids = new Set();
    if (!Array.isArray(config.users) || !config.users.length) problem('账号映射缺失', 'config');
    for (const user of config.users || []) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(user?.id || '') || ids.has(user.id)) problem('账号映射无效', 'config');
      ids.add(user.id);
      try {
        const stat = await fs.lstat(user.workDir), real = await canonical(user.workDir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || key(real) !== key(user.workDir)) throw Error();
      } catch { problem('账号工作目录不可安全使用', 'config'); }
    }
    if (!Array.isArray(receipt.fingerprints) || !receipt.fingerprints.length) throw Error('缺少验收文件指纹');
    const covered = new Set();
    for (const item of receipt.fingerprints) {
      if (!item || !path.isAbsolute(item.path || '') || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) throw Error('验收指纹格式无效');
      let file;
      try { file = await canonical(item.path); } catch { unreadable.push(key(item.path)); continue; }
      if (covered.has(key(file))) throw Error('验收指纹重复');
      covered.add(key(file));
      try {
        const sha256 = await hashFile(file); files.push([key(file), sha256]);
        if (sha256 !== item.sha256.toLowerCase()) changes.push({ kind: kind(file), path: file, sha256 });
      } catch { unreadable.push(key(file)); }
    }
    for (const file of await requiredFiles(config, runtime, root, gate)) if (!covered.has(key(file))) problem('必需文件未纳入原验收记录', kind(file));
    if (!covered.has(sourceKey)) problem('源码未纳入原验收记录');
    if (unreadable.length) throw Error('文件状态不可读取');
    // 再读每个文件，避免把一次跨文件变化混成可自动验收的稳定快照。
    for (const [file, sha256] of files) if (await hashFile(file) !== sha256) throw Error('文件状态在核对期间变化');
    if (!configBytes.equals(await fs.readFile(configPath)) || !manifestBytes.equals(await fs.readFile(manifestPath)) || !receiptBytes.equals(await fs.readFile(receiptPath))) throw Error('配置或记录在核对期间变化');
    files.sort((a, b) => a[0].localeCompare(b[0]));
    const filesFingerprint = digest(JSON.stringify({ files, config: digest(configBytes), manifest: digest(manifestBytes) }));
    return { readable: true, gateReady: changes.length === 0, filesFingerprint,
      fingerprint: digest(JSON.stringify({ filesFingerprint, receipt: digest(receiptBytes) })),
      sourceSha256: files.find(([file]) => file === sourceKey)?.[1], receiptSha256: digest(receiptBytes), changes, reasons: [...new Set(reasons)] };
  } catch {
    // 不把部分读取的状态当作稳定指纹，也不泄露配置内容或系统错误中的敏感值。
    return { readable: false, gateReady: false, fingerprint: null, filesFingerprint: null,
      changes: [{ kind: 'unknown' }], reasons: ['无法取得完整且稳定的文件状态，需机主检查。'] };
  }
}
module.exports = { inspectRepairState, configurationFingerprint, requiredFiles };
