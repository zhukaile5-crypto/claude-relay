'use strict';

// Read-only activation gate. Configuration binding intentionally excludes keys,
// passwords, login tokens and conversation contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codexFingerprints = require('./codex-fingerprints.cjs');
const root = path.resolve(__dirname, '..');
const RECEIPT_SCHEMA = 2;
// 2026-11-23 机主决定 GPT 退出平台（以后也不会再有 GPT 额度）：gptApi、gptHistory 不再是验收项。
// 这件事写死在这里，不看任何配置开关；反过来，配置里只要还给账号开着 GPT，门槛就不通过（见 gptRetirementReason）。
const RETIRED_CHECKS = Object.freeze(['gptApi', 'gptHistory']);
const REQUIRED = ['pdf', 'voiceOnline', 'voiceOffline', 'stt', 'ocr', 'scientific', 'media', 'html', 'tex', 'gpu', 'eve',
  'claudeSubscription', 'claudeHistory', 'geminiSubscription', 'geminiHistory', 'research', 'serverEndToEnd',
  'filesystemDeny', 'networkDeny', 'uiDesktopDeny', 'cancellation', 'parentDeath', 'regression', 'candidateReview'];
const GPT_RETIRED_REASON = 'GPT 已退出验收范围：gptUsers 必须为空。';
// server.js 的 gptAllowed 只看 openaiApiKey 和 (config.gptUsers || []).includes(账号)：空数组或假值才算真的关着。
// 其他任何值（非空数组，或字符串之类能 includes 到账号的东西）都可能让 GPT 重新出现，没经过验收，一律不通过。
function gptRetirementReason(config) {
  const users = config?.gptUsers;
  return users && !(Array.isArray(users) && users.length === 0) ? GPT_RETIRED_REASON : null;
}
const SOURCE_FILES = ['server.js', 'url-capability.js', 'workspace-path.js', 'upload-stream.js', 'bounded-jobs.js',
  'isolation/index.js', 'isolation/executor.js', 'isolation/executor-sync.js', 'isolation/mcp.js',
  'isolation/workspace-io.js', 'isolation/voice.js', 'isolation/research.js', 'isolation/public-network.js', 'isolation/gemini-gate.js',
  'tools/check-isolation.cjs', 'tools/codex-fingerprints.cjs', 'tools/runtime-health.cjs', 'tools/maintenance-transaction.cjs', 'tools/maintenance-drain.cjs', 'tools/page-shell.cjs', 'tools/model-handoff.cjs', 'tools/model-finalization.cjs', 'tools/model-instructions.cjs', 'tools/model-session-recovery.cjs', 'tools/model-collaboration.cjs'];
const REQUIRED_RUNTIME = ['desktopHost', 'nodePath', 'codexPath', 'claudePath', 'python', 'ffmpeg', 'libreOffice', 'xlsxScript'];
const OPTIONAL_ENTRIES = ['gpuPython', 'evePython', 'ffprobe', 'gitBash', 'pandoc', 'texPerl'];
const ENTRY_EXTENSIONS = /\.(?:exe|com|dll|cmd|bat|ps1|py|pyw|js|cjs|mjs|vbs|sh|pl|pm|bs|al|ix|lua|tlu|rb)$/i;
const keyOf = value => path.resolve(value).toLowerCase();

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('必须使用绝对运行路径。');
  return path.resolve(value);
}
function canonical(value, allowMissing = false) {
  const full = absolute(value);
  try { return fs.realpathSync.native(full); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    const parent = path.dirname(full);
    if (parent === full) throw error;
    return path.join(canonical(parent, true), path.basename(full));
  }
}
function effectiveExecutables(config, runtime) {
  return {
    claude: path.isAbsolute(config.claudePath || '') ? config.claudePath : runtime.claudePath,
    codex: path.isAbsolute(config.codexPath || '') ? config.codexPath : runtime.codexPath,
    node: runtime.nodePath,
    hostNode: process.execPath,
    // Gemini（agy 固定副本）只在配置了 agyPath 时启用，也只在那时进入指纹和配置绑定。
    ...(path.isAbsolute(config.agyPath || '') ? { agy: config.agyPath } : {}),
  };
}
function configurationProjection(config, runtime, serviceRoot = root) {
  const options = config.isolation || {};
  const normalized = value => canonical(value, true).replace(/\\/g, '/').toLowerCase();
  const users = (config.users || []).map(user => ({ id: user.id, workDir: normalized(user.workDir) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    schema: 1, users,
    privateRoot: normalized(options.privateRoot || path.join(serviceRoot, 'data', 'isolation')),
    gptHome: normalized(options.gptHome || path.join(serviceRoot, 'data', 'codex-home')),
    ...(path.isAbsolute(config.agyPath || '') ? { geminiHome: normalized(options.geminiHome || path.join(serviceRoot, 'data', 'gemini-home')) } : {}),
    runtimeManifest: normalized(options.runtimeManifest),
    academicSearch: !!config.academicSearch,
    researchConfig: config.academicSearch ? normalized(path.join(serviceRoot, 'mcp-servers.json')) : null,
    executables: Object.fromEntries(Object.entries(effectiveExecutables(config, runtime)).map(([name, file]) => [name, normalized(file)])),
  };
}
function configurationFingerprint(config, runtime, serviceRoot = root) {
  return crypto.createHash('sha256').update(JSON.stringify(configurationProjection(config, runtime, serviceRoot))).digest('hex');
}
function hashFile(file) {
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw Error('指纹目标不是文件。');
    for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.statSync(file, { bigint: true });
    const same = value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(field => before[field] === value[field]);
    if (!same(after) || !same(current)) throw Error('计算指纹时文件发生变化。');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

// Covers direct executable/interpreter entries and maintained scripts, without
// traversing the multi-gigabyte third-party package/model inventory.
function requiredFingerprintFiles(config, runtime, serviceRoot = root, sourceRoot = serviceRoot) {
  const files = new Map();
  function add(file) {
    const real = canonical(file);
    if (!fs.statSync(real).isFile()) throw Error('运行入口不是文件：' + path.basename(file));
    files.set(keyOf(real), real);
  }
  function addIfPresent(file) { if (fs.existsSync(file)) add(file); }
  let entries = 0;
  const visited = new Set();
  function scripts(directory, recursive = false, depth = 0) {
    const real = canonical(directory);
    if (visited.has(keyOf(real))) return;
    visited.add(keyOf(real));
    if (depth > 12 || visited.size > 1024) throw Error('运行脚本目录超出有限检查范围。');
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (++entries > 20000) throw Error('运行脚本条目超出有限检查范围。');
      const full = path.join(real, entry.name);
      if (entry.isSymbolicLink()) throw Error('运行脚本目录含未绑定链接：' + entry.name);
      if (entry.isDirectory()) { if (recursive && !['node_modules', '__pycache__', '.git'].includes(entry.name)) scripts(full, true, depth + 1); }
      else if (entry.isFile() && ENTRY_EXTENSIONS.test(entry.name)) add(full);
    }
  }
  // sourceRoot 只接受受信任调用方显式指定，不读取配置或环境变量。
  for (const file of SOURCE_FILES) add(path.join(sourceRoot, file));
  add(config.isolation?.runtimeManifest);
  if (config.academicSearch) add(path.join(serviceRoot, 'mcp-servers.json'));
  for (const key of REQUIRED_RUNTIME) add(runtime[key]);
  for (const key of OPTIONAL_ENTRIES) if (runtime[key] !== undefined) add(runtime[key]);
  for (const [key, value] of Object.entries(runtime)) if (/Script$/.test(key)) add(value);
  for (const file of Object.values(effectiveExecutables(config, runtime))) add(file);
  // 程序包所有文件都影响执行；配置覆盖入口和清单入口均必须完整绑定。
  for (const exe of new Set([runtime.codexPath, effectiveExecutables(config, runtime).codex]))
    for (const file of codexFingerprints.enumerateCodexFilesSync(exe)) add(file);
  for (const file of Object.values(runtime.tools || {})) { add(file); scripts(path.dirname(file), true); }
  for (const file of Object.values(runtime.skills || {})) { add(file); scripts(path.dirname(file), true); }
  for (const interpreter of [runtime.python, runtime.gpuPython, runtime.evePython].filter(Boolean)) {
    const directory = path.dirname(canonical(interpreter));
    for (const name of fs.readdirSync(directory)) if (/\._pth$/i.test(name) || /^python\d*(?:_d)?\.dll$/i.test(name)) add(path.join(directory, name));
  }
  const office = path.dirname(canonical(runtime.libreOffice));
  for (const name of ['soffice.exe', 'soffice.com', 'soffice.bin']) addIfPresent(path.join(office, name));
  for (const directory of runtime.pathDirs || []) scripts(directory);
  for (const directory of runtime.codeRoots || []) scripts(directory, true);
  if (runtime.texBin) scripts(runtime.texBin);
  if (runtime.texGhostscript) scripts(path.join(runtime.texGhostscript, 'bin'));
  return [...files.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function check(config, receiptPath, serviceRoot = root, sourceRoot = serviceRoot) {
  receiptPath ||= config.isolation?.receipt || path.join(serviceRoot, 'data', 'isolation', 'acceptance.json');
  const reasons = [], checks = {};
  let receipt, runtime;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { reasons.push('完整验收记录尚未生成。'); }
  if (receipt) {
    if (receipt.schema !== RECEIPT_SCHEMA || !receipt.completedAt || !Number.isFinite(Date.parse(receipt.completedAt))) reasons.push('验收记录格式无效。');
    for (const key of REQUIRED) { checks[key] = receipt.checks?.[key]?.passed === true; if (!checks[key]) reasons.push('尚未通过：' + key); }
  }
  const covered = new Map();
  if (receipt) {
    if (!Array.isArray(receipt.fingerprints) || !receipt.fingerprints.length) reasons.push('缺少已验收版本的文件指纹。');
    else for (const item of receipt.fingerprints) {
      try {
        if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw Error();
        const file = canonical(item.path), key = keyOf(file);
        if (covered.has(key)) { reasons.push('验收文件存在重复指纹：' + path.basename(file)); continue; }
        covered.set(key, item.sha256.toLowerCase());
        if (hashFile(file) !== item.sha256.toLowerCase()) reasons.push('验收后文件已变化：' + path.basename(file));
      } catch { reasons.push('验收文件无法读取或指纹无效。'); }
    }
  }
  try {
    const manifest = absolute(config.isolation?.runtimeManifest);
    runtime = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!path.isAbsolute(runtime.whisperModel || '') || !fs.existsSync(runtime.whisperModel)) reasons.push('运行组件缺失：whisperModel');
    const required = requiredFingerprintFiles(config, runtime, serviceRoot, sourceRoot);
    if (receipt) for (const file of required) if (!covered.has(keyOf(file))) reasons.push('版本指纹未覆盖：' + path.basename(file));
    if (receipt && receipt.configurationFingerprint !== configurationFingerprint(config, runtime, serviceRoot)) reasons.push('账号或执行路径与验收配置不一致。');
  } catch { reasons.push('独立运行环境或执行入口尚未就绪。'); }
  // GPT 已退出平台：不再要求 openaiApiKey 存在，而是要求没有账号能看到 GPT（Codex 程序仍在运行环境里，照旧受上面的指纹核对）。
  const retired = gptRetirementReason(config);
  if (retired) reasons.push(retired);
  const ids = new Set();
  if (!Array.isArray(config.users) || !config.users.length) reasons.push('账号工作区映射缺失。');
  for (const user of Array.isArray(config.users) ? config.users : []) {
    if (typeof user?.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(user.id) || ids.has(user.id)) reasons.push('账号映射无效。');
    ids.add(user?.id);
    try {
      const full = absolute(user.workDir), stat = fs.lstatSync(full);
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(full).toLowerCase() !== full.toLowerCase()) reasons.push('工作区根目录被重定向或不是目录：' + user.id);
    } catch { reasons.push('工作区不存在：' + (user?.id || '?')); }
  }
  return { authenticationPolicy: { claude: 'local-subscription', gemini: 'agy-google-account', gpt: 'retired' },
    isolationEnabled: config.isolation?.enabled === true, readyToEnableIsolation: reasons.length === 0,
    receipt: receipt ? receiptPath : null, verifiedAt: receipt?.completedAt || null,
    checks, remainingRequirements: [...new Set(reasons)], limitations: receipt?.limitations || [] };
}
if (require.main === module) {
  // 以前 --status 之类会被当成回执路径，报「完整验收记录尚未生成」，像是门禁坏了
  const option = process.argv.slice(2).find(arg => arg.startsWith('-'));
  if (option) { console.error('不认识的选项：' + option + '\n用法：node tools/check-isolation.cjs [回执文件路径]（不带参数时核对正式回执，只读）'); process.exit(64); }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const report = check(config, process.argv[2]); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.readyToEnableIsolation ? 0 : 2;
}
module.exports = { check, REQUIRED, RETIRED_CHECKS, GPT_RETIRED_REASON, gptRetirementReason, RECEIPT_SCHEMA, SOURCE_FILES, configurationProjection, configurationFingerprint, requiredFingerprintFiles, hashFile };
