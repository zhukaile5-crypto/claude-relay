'use strict';
// 只读核对源码提交与“源码 + 验收记录”检查点；不改写或补造验收结论。
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = file => path.resolve(file).toLowerCase();
async function hashFile(file) {
  const before = await fsp.stat(file);
  if (!before.isFile()) throw Error('不是普通文件');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const after = await fsp.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('核对期间文件发生变化');
  return hash.digest('hex');
}
function command(exe, args, cwd) {
  return new Promise(resolve => {
    const child = cp.spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); }, 15000);
    child.stdout.on('data', data => { size += data.length; if (size > 8 * 1024 * 1024) { stopped = true; child.kill(); } else chunks.push(data); });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: !stopped && code === 0, bytes: Buffer.concat(chunks) }); });
  });
}
async function gitState(root, { run = command } = {}) {
  const args = ['-c', 'core.fsmonitor=false'];
  try {
    const [status, head, source] = await Promise.all([
      run('git', [...args, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
      run('git', [...args, 'rev-parse', '--verify', 'HEAD'], root),
      run('git', [...args, 'show', 'HEAD:server.js'], root),
    ]);
    if (![status, head, source].every(result => result.ok)) return { clean: false, sourceMatchesHead: false, reason: 'git-unavailable' };
    const commit = head.bytes.toString('utf8').trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return { clean: false, sourceMatchesHead: false, reason: 'invalid-head' };
    const current = await fsp.readFile(path.join(root, 'server.js'));
    const headSourceSha256 = digest(source.bytes);
    return { clean: status.bytes.length === 0, head: commit, headSourceSha256, sourceMatchesHead: digest(current) === headSourceSha256 };
  } catch { return { clean: false, sourceMatchesHead: false, reason: 'git-unavailable' }; }
}
async function checkpointReport(checkpoint, { root, config, runtime, gate }) {
  const reasons = [];
  try {
    const source = await fsp.readFile(checkpoint.sourcePath), receiptBytes = await fsp.readFile(checkpoint.receiptPath);
    const sourceSha = digest(source), receiptSha = digest(receiptBytes), receipt = JSON.parse(receiptBytes);
    if (checkpoint.sourceSha256 && sourceSha !== checkpoint.sourceSha256) reasons.push('源码快照已变化');
    if (checkpoint.receiptSha256 && receiptSha !== checkpoint.receiptSha256) reasons.push('验收快照已变化');
    if (receipt.schema !== gate.RECEIPT_SCHEMA || !Number.isFinite(Date.parse(receipt.completedAt))) reasons.push('验收快照格式无效');
    for (const name of gate.REQUIRED) if (receipt.checks?.[name]?.passed !== true) reasons.push('验收项未通过：' + name);
    if (receipt.configurationFingerprint !== gate.configurationFingerprint(config, runtime, root)) reasons.push('账号或路径配置已变化');
    // 和门槛（check-isolation 的 gptRetirementReason）一致：GPT 已退出平台，不再要求密钥，而是要求没有账号开着 GPT
    const gptRetired = require('./check-isolation.cjs').gptRetirementReason(config);
    if (gptRetired) reasons.push(gptRetired);
    if (!path.isAbsolute(runtime.whisperModel || '')) reasons.push('语音模型路径无效');
    else { try { await fsp.access(runtime.whisperModel); } catch { reasons.push('语音模型缺失'); } }
    const ids = new Set();
    if (!Array.isArray(config.users) || !config.users.length) reasons.push('账号映射缺失');
    for (const user of config.users || []) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(user.id || '') || ids.has(user.id)) reasons.push('账号映射无效');
      ids.add(user.id);
      try {
        if (!path.isAbsolute(user.workDir)) throw Error();
        const stat = await fsp.lstat(user.workDir), real = await fsp.realpath(user.workDir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || key(real) !== key(user.workDir)) throw Error();
      } catch { reasons.push('账号目录不存在或已重定向'); }
    }
    const sourceKey = key(await fsp.realpath(path.join(root, 'server.js'))), covered = new Map();
    if (!Array.isArray(receipt.fingerprints) || !receipt.fingerprints.length) reasons.push('验收快照缺少文件指纹');
    for (const item of receipt.fingerprints || []) {
      if (!item || !path.isAbsolute(item.path || '') || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) { reasons.push('验收快照含无效指纹'); continue; }
      const fileKey = key(item.path), sha = item.sha256.toLowerCase();
      if (covered.has(fileKey)) { reasons.push('验收快照含重复指纹'); continue; }
      covered.set(fileKey, sha);
      // 唯一替换视图是检查点自己的 server.js 字节，其余条目逐一对照当前真实文件。
      if (fileKey === sourceKey) { if (sourceSha !== sha) reasons.push('源码与验收快照不配套'); continue; }
      try { if (await hashFile(item.path) !== sha) reasons.push('其他运行文件已变化：' + path.basename(item.path)); }
      catch { reasons.push('其他运行文件不可读取：' + path.basename(item.path)); }
    }
    if (!covered.has(sourceKey)) reasons.push('验收快照未绑定源码');
    for (const file of gate.requiredFingerprintFiles(config, runtime, root)) {
      if (!covered.has(key(file))) reasons.push('验收快照遗漏当前必需文件：' + path.basename(file));
    }
  } catch { reasons.push('无法核对检查点'); }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
function processesAbsent(records, probe = pid => process.kill(pid, 0)) {
  const ids = new Set();
  for (const record of records) {
    if (!record) continue;
    if (!Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.ppid) || record.ppid <= 0 ||
        !Number.isFinite(record.startedAt) || record.startedAt <= 0) return false;
    ids.add(record.pid); ids.add(record.ppid);
  }
  if (!ids.size) return false;
  for (const pid of ids) {
    try { probe(pid); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return true;
}
module.exports = { processesAbsent, gitState, checkpointReport, hashFile, digest };
