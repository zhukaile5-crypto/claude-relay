'use strict';
// 维护事务只操作受信任程序配置推导的路径，不能由日志扩大范围。
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const missing = error => error.code === 'ENOENT';
async function exists(file) { try { await fsp.lstat(file); return true; } catch (e) { if (missing(e)) return false; throw e; } }
async function physical(file, allowMissing = false) {
  const full = path.resolve(file); let cursor = full;
  for (;;) {
    try { const stat = await fsp.lstat(cursor); if (stat.isSymbolicLink()) throw Error('维护路径不能经过链接'); }
    catch (e) { if (!allowMissing || !missing(e)) throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (await exists(full) && !same(await fsp.realpath(full), full)) throw Error('维护路径被重定向');
  return full;
}
async function fileHash(file) {
  await physical(file);
  const handle = await fsp.open(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = await handle.stat(); if (!before.isFile()) throw Error('预期为普通文件');
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('计算指纹期间文件改变');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
async function treeHash(base) {
  await physical(base);
  const hash = crypto.createHash('sha256'); let count = 0;
  async function visit(file, rel) {
    if (++count > 100000) throw Error('程序文件数量超出维护检查范围');
    const stat = await fsp.lstat(file); if (stat.isSymbolicLink()) throw Error('程序副本不能包含链接');
    if (stat.isDirectory()) {
      hash.update('目录\0' + rel + '\0');
      for (const name of (await fsp.readdir(file)).sort()) await visit(path.join(file, name), rel ? rel + '/' + name : name);
    } else if (stat.isFile()) hash.update('文件\0' + rel + '\0' + await fileHash(file) + '\0');
    else throw Error('程序副本包含不支持的文件类型');
  }
  await visit(base, ''); return hash.digest('hex');
}
async function atomicWrite(file, data) {
  await physical(file, true);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp', handle = await fsp.open(temporary, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try { await fsp.rename(temporary, file); } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
}
async function safeRemove(file, allowed) {
  if (!allowed.some(p => same(p, file))) throw Error('拒绝清理未绑定的维护路径');
  if (!await exists(file)) return;
  await treeHash(file); // 拒绝根或后代链接，不跟随目录联接清理外部目录。
  await fsp.rm(file, { recursive: true, force: true });
}
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : true; }
};
async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  if (process.platform !== 'win32') {
    try { return (await fsp.readFile('/proc/' + pid + '/stat', 'utf8')).split(') ').pop().split(' ')[19] || null; } catch { return null; }
  }
  return new Promise(resolve => {
    // 只查询指定进程的出生时间；查询失败时不把活进程当成陈旧锁。
    const script = '$p=Get-Process -Id ' + pid + ' -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks';
    cp.execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 3000, maxBuffer: 1024 }, (error, stdout) => {
      const value = String(stdout || '').trim(); resolve(!error && /^\d+$/.test(value) ? value : null);
    });
  });
}
let ownIdentityPromise;
const ownIdentity = d => d.processIdentity ? d.processIdentity(process.pid) : (ownIdentityPromise ||= processIdentity(process.pid));
async function ownerAlive(d, pid, startedAt) {
  if ((d.pidAlive || pidAlive)(pid) === false) return false;
  if (!startedAt) return true;
  const current = pid === process.pid ? await ownIdentity(d) : await (d.processIdentity || processIdentity)(pid);
  return !current || current === startedAt;
}
function paths(d) {
  const directory = path.resolve(d.transactionDir || path.join(path.dirname(d.state), 'transactions'));
  return { directory, journal: path.join(directory, 'upgrade.json') };
}
async function readJournal(d) {
  const p = paths(d); if (!await exists(p.journal)) return null;
  await physical(p.journal); let tx;
  try { tx = JSON.parse(await fsp.readFile(p.journal, 'utf8')); } catch { throw Error('升级日志损坏，保留文件并等待人工处理'); }
  if (tx.schema !== 1 || !/^[a-f0-9]{32}$/.test(tx.id || '') || !Number.isInteger(tx.ownerPid) || tx.ownerPid <= 0 ||
      (tx.ownerStartedAt != null && (typeof tx.ownerStartedAt !== 'string' || !/^\d+$/.test(tx.ownerStartedAt))) ||
      typeof tx.program !== 'string' || !/^[a-f0-9]{64}$/.test(tx.oldProgramHash || '') ||
      !/^[a-f0-9]{64}$/.test(tx.candidateHash || '') || !/^[a-f0-9]{64}$/.test(tx.receiptHash || '')) throw Error('升级日志字段无效，不能自动恢复');
  const program = d.programs.find(item => item.name === tx.program);
  if (!program || !same(tx.programRoot, program.root) || !same(tx.receipt, d.receipt)) throw Error('升级日志与受信任程序配置不一致');
  const folder = path.join(p.directory, tx.id);
  if (!same(tx.backup, path.join(folder, 'receipt.before.json')) || !same(tx.outputReceipt, path.join(folder, 'receipt.candidate.json'))) throw Error('升级日志的备份位置不合法');
  if (!['prepared','moving-old','moving-new','swapped','accepting','accepted','installing-receipt','receipt-installed','waiting-idle','restarting','committed','recovering'].includes(tx.phase)) throw Error('升级日志阶段无效');
  await physical(program.root, true); await physical(folder); await physical(tx.backup);
  if (await fileHash(tx.backup) !== tx.receiptHash) throw Error('升级记录备份损坏，不能自动恢复');
  return { tx, program, ...p };
}
async function writeJournal(d, tx, phase) {
  tx.phase = phase; tx.updatedAt = Date.now();
  await atomicWrite(paths(d).journal, JSON.stringify(tx, null, 2));
  if (d.onPhase) await d.onPhase(phase, { ...tx });
}
async function begin(d, program, candidate, oldVersion) {
  const p = paths(d); await fsp.mkdir(p.directory, { recursive: true }); await physical(p.directory);
  if (await exists(p.journal)) throw Error('已有未完成的升级事务');
  await physical(program.root); await physical(candidate); await physical(d.receipt);
  const id = crypto.randomBytes(16).toString('hex'), folder = path.join(p.directory, id);
  await fsp.mkdir(folder); const oldReceipt = await fsp.readFile(d.receipt);
  const tx = { schema: 1, id, ownerPid: process.pid, ownerStartedAt: await ownIdentity(d), program: program.name, programRoot: path.resolve(program.root),
    oldVersion, receipt: path.resolve(d.receipt), backup: path.join(folder, 'receipt.before.json'),
    outputReceipt: path.join(folder, 'receipt.candidate.json'), oldProgramHash: await treeHash(program.root),
    candidateHash: await treeHash(candidate), receiptHash: hashBytes(oldReceipt), createdAt: Date.now() };
  await atomicWrite(tx.backup, oldReceipt); await writeJournal(d, tx, 'prepared'); return tx;
}
async function renameBounded(d, from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(from, to); return; }
    catch (error) {
      const remaining = d.remainingBudget ? d.remainingBudget() : Infinity;
      if (attempt >= 10 || remaining <= 0 || !['EPERM','EBUSY','EACCES'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(d.waitMs || 2000, remaining)));
    }
  }
}
async function swapIn(d, program, tx) {
  const candidate = program.root + '.new', previous = program.root + '.prev';
  if (await treeHash(program.root) !== tx.oldProgramHash || await treeHash(candidate) !== tx.candidateHash) throw Error('程序在交换前发生变化');
  await writeJournal(d, tx, 'moving-old'); await safeRemove(previous, [previous]);
  await renameBounded(d, program.root, previous); await writeJournal(d, tx, 'moving-new');
  await renameBounded(d, candidate, program.root); await writeJournal(d, tx, 'swapped');
}
async function installReceipt(d, tx) {
  const current = await readJournal(d);
  if (!current || current.tx.id !== tx.id || current.tx.ownerPid !== process.pid ||
      current.tx.ownerStartedAt && current.tx.ownerStartedAt !== await ownIdentity(d)) throw Error('升级事务已失效，拒绝安装迟到验收记录');
  if (await treeHash(current.program.root) !== tx.candidateHash || await fileHash(d.receipt) !== tx.receiptHash) throw Error('验收后程序或正式记录又有变化');
  await physical(tx.outputReceipt); const bytes = await fsp.readFile(tx.outputReceipt);
  tx.acceptedReceiptHash = hashBytes(bytes); await writeJournal(d, tx, 'installing-receipt');
  await atomicWrite(d.receipt, bytes); await writeJournal(d, tx, 'receipt-installed');
}
async function finish(d, tx) { await writeJournal(d, tx, 'committed'); await fsp.unlink(paths(d).journal); }
async function recover(d, { own = false } = {}) {
  let parsed;
  try { parsed = await readJournal(d); } catch (error) { return { result: 'recovery-refused', fatal: true, why: error.message }; }
  if (!parsed) return { result: 'no-transaction' };
  const { tx, program, journal } = parsed;
  if (!own && await ownerAlive(d, tx.ownerPid, tx.ownerStartedAt)) return { result: 'transaction-active', fatal: true, why: '升级进程仍存活或无法确认已经退出' };
  if (own && (tx.ownerPid !== process.pid || tx.ownerStartedAt && tx.ownerStartedAt !== await ownIdentity(d))) return { result: 'recovery-refused', fatal: true, why: '不能接管其他活进程的事务' };
  const previous = program.root + '.prev', candidate = program.root + '.new', failed = program.root + '.failed';
  try {
    if (d.recoveryGuard && await d.recoveryGuard(tx, program) !== true) throw Error('恢复前全局边界核对未通过，未修改程序或记录');
    if (tx.phase === 'committed') {
      if (await treeHash(program.root) !== tx.candidateHash || !tx.acceptedReceiptHash ||
          await fileHash(d.receipt) !== tx.acceptedReceiptHash || !await d.gateOk()) throw Error('已提交事务的文件不一致');
      await safeRemove(candidate, [candidate]); await safeRemove(failed, [failed]);
      await fsp.unlink(journal); return { result: 'completed-cleanup' };
    }
    // 阶段写入可能落后于 rename；完整指纹是恢复的判断依据。
    const receiptNow = await exists(d.receipt) ? await fileHash(d.receipt) : null;
    if (receiptNow && receiptNow !== tx.receiptHash && receiptNow !== tx.acceptedReceiptHash) throw Error('正式记录含未知修改，不能自动覆盖');
    const currentHash = await exists(program.root) ? await treeHash(program.root) : null;
    const previousHash = await exists(previous) ? await treeHash(previous) : null;
    if (currentHash !== tx.oldProgramHash && previousHash !== tx.oldProgramHash) throw Error('找不到与日志绑定的旧程序，保留所有文件');
    if (currentHash && currentHash !== tx.oldProgramHash && currentHash !== tx.candidateHash) throw Error('当前程序含未知修改，不能自动覆盖');
    if (await exists(failed) && await treeHash(failed) !== tx.candidateHash) throw Error('失败副本含未知内容，不能清理');
    if (await exists(candidate) && await treeHash(candidate) !== tx.candidateHash) throw Error('候选副本含未知内容，不能清理');
    await writeJournal(d, tx, 'recovering');
    if (currentHash !== tx.oldProgramHash) {
      if (currentHash) { await safeRemove(failed, [failed]); await renameBounded(d, program.root, failed); }
      await renameBounded(d, previous, program.root);
    }
    await atomicWrite(d.receipt, await fsp.readFile(tx.backup));
    if (await treeHash(program.root) !== tx.oldProgramHash || await fileHash(d.receipt) !== tx.receiptHash || !await d.gateOk()) throw Error('恢复后核对不通过，保留事务以供检查');
    await safeRemove(candidate, [candidate]); await safeRemove(failed, [failed]);
    await fsp.unlink(journal);
    // 孤儿验收可以晚写唯一候选文件，但失去活日志后不能安装至正式记录。
    return { result: 'recovered', program: program.name, oldVersion: tx.oldVersion };
  } catch (error) { return { result: 'recovery-failed', fatal: true, why: error.message }; }
}
async function acquireLock(d) {
  const file = path.resolve(d.lock || path.join(path.dirname(d.state), 'running.lock'));
  await fsp.mkdir(path.dirname(file), { recursive: true }); await physical(path.dirname(file));
  // 保留纯 PID 格式，现有 wake_check.ps1 仍可据此阻止维护期间自动睡眠。
  const ownerFile = file + '.owner.json', token = crypto.randomUUID(), content = String(process.pid);
  const ownerStartedAt = await ownIdentity(d);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(file, 'wx'); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      const stat = await fsp.stat(file), owner = { pid: process.pid, token, ownerStartedAt, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs };
      await atomicWrite(ownerFile, JSON.stringify(owner));
      return { file, ownerFile, token, content, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await physical(file); const previous = await fsp.readFile(file, 'utf8');
    let pid; try { const parsed = JSON.parse(previous); pid = typeof parsed === 'number' ? parsed : parsed.pid; } catch { throw Error('维护锁内容损坏，保留文件并等待人工处理'); }
    if (!Number.isInteger(pid) || pid <= 0) throw Error('维护锁内容损坏，保留文件并等待人工处理');
    let startedAt = null;
    try {
      await physical(ownerFile); const owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8')), stat = await fsp.stat(file);
      // 旧 sidecar 不能套到后来新建的锁；不匹配时保守按纯 PID 处理。
      if (owner.pid === pid && owner.birthtimeMs === stat.birthtimeMs && owner.mtimeMs === stat.mtimeMs && /^\d+$/.test(owner.ownerStartedAt || '')) startedAt = owner.ownerStartedAt;
    } catch { /* 缺少或损坏身份文件时不能推定活锁已失效。 */ }
    if (await ownerAlive(d, pid, startedAt)) return null;
    // Windows CLI 外层命名互斥锁串行化旧锁接管。
    if (await fsp.readFile(file, 'utf8') !== previous) return null;
    await fsp.unlink(file);
  }
  return null;
}
async function releaseLock(lease) {
  if (!lease) return;
  try {
    const stat = await fsp.stat(lease.file), owner = JSON.parse(await fsp.readFile(lease.ownerFile, 'utf8'));
    if (await fsp.readFile(lease.file, 'utf8') === lease.content && owner.token === lease.token && stat.birthtimeMs === lease.birthtimeMs && stat.mtimeMs === lease.mtimeMs) {
      await fsp.unlink(lease.file); await fsp.unlink(lease.ownerFile);
    }
  } catch (e) { if (!missing(e)) throw e; }
}
async function writeCandidateReceipt({ root, output, receipt, config, gate }) {
  const parent = path.join(path.resolve(root), 'data', 'maintenance', 'transactions');
  const full = path.resolve(output), folder = path.dirname(full);
  if (path.basename(full) !== 'receipt.candidate.json' || !/^[a-f0-9]{32}$/.test(path.basename(folder)) ||
      !same(path.dirname(folder), parent)) throw Error('候选验收记录只能写到维护事务目录');
  await physical(folder); if (await exists(full)) throw Error('候选验收记录已存在，拒绝覆盖');
  await atomicWrite(full, JSON.stringify(receipt, null, 2));
  const report = gate.check(config, full, root);
  if (!report.readyToEnableIsolation) { await fsp.unlink(full); throw Error('候选记录核对未通过：' + report.remainingRequirements.join('；')); }
}
module.exports = { readJournal, paths, physical, exists, fileHash, treeHash, atomicWrite, safeRemove, begin, writeJournal, swapIn, installReceipt, finish, recover, acquireLock, releaseLock, pidAlive, processIdentity, writeCandidateReceipt };
