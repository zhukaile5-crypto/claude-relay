'use strict';
// 调用方持有统一维护锁并优先执行 M1；每个完整文件状态的尝试凭据另用 wx 原子占位。
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const deployment = require('./maintenance-deploy.cjs');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const gitIdentity = git => ({ head: git?.head, clean: git?.clean, sourceMatchesHead: git?.sourceMatchesHead,
  headSourceSha256: git?.headSourceSha256, statusFingerprint: git?.statusFingerprint || null });
async function plainDirectory(directory) {
  if (!path.isAbsolute(directory)) throw Error('修复状态路径必须是绝对路径');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('修复状态目录已被重定向');
  }
}
async function claimAttempt(directory, id, record) {
  await plainDirectory(directory);
  let handle;
  try { handle = await fs.open(path.join(directory, id + '.json'), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  // 失败或进程中止时保留占位；不能因为结果未写完而对同一状态再次花费验收额度。
  try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  return true;
}
async function capture(d) {
  const before = await d.gitState(), snapshot = await d.repairSnapshot(), after = await d.gitState();
  if (hash(gitIdentity(before)) !== hash(gitIdentity(after))) throw Error('核对期间提交状态变化');
  if (snapshot?.readable !== true || !validHash(snapshot.fingerprint) || !validHash(snapshot.filesFingerprint) ||
      !validHash(snapshot.sourceSha256) || !validHash(snapshot.receiptSha256) || !Array.isArray(snapshot.changes))
    throw Error('文件状态不可读取');
  return { snapshot, git: after, identity: hash({ fingerprint: snapshot.fingerprint, git: gitIdentity(after) }) };
}
function eligible(value, d) {
  const { snapshot, git } = value, change = snapshot.changes[0];
  return snapshot.gateReady === false && snapshot.changes.length === 1 && change?.kind === 'server' &&
    typeof change.path === 'string' && samePath(change.path, d.sourcePath) && change.sha256 === snapshot.sourceSha256 &&
    git?.clean === true && git.sourceMatchesHead === true && /^[a-f0-9]{40,64}$/.test(git.head || '') &&
    git.headSourceSha256 === snapshot.sourceSha256;
}
// 受限状态只在服务启动时判定：文件恢复一致后进程不会自行解除。这里只重启，不验收、不改任何记录。
async function restartBlocked(initial, d, tell, directory) {
  const unchanged = async () => {
    if (await d.stoppedByOwner?.()) throw Error('机主已停止服务');
    if ((await capture(d)).identity !== initial.identity) throw Error('文件状态变化');
  };
  try {
    if (await d.waitNoJobs() !== true) { await tell('文件已恢复一致，但尚未等到安全空闲，服务暂未重启，下一轮巡检再试。'); return 'restart-pending'; }
    await unchanged();
  } catch { await tell('重启前文件或停止状态发生变化，未重启服务。'); return 'repair-refused'; }
  try {
    if (!await claimAttempt(directory, hash({ restart: initial.identity }), { schema: 1, kind: 'restart', fingerprint: initial.snapshot.fingerprint, at: (d.now || Date.now)() })) return 'repair-already-attempted';
  } catch { await tell('修复尝试状态无法安全保存，未重启服务。'); return 'repair-refused'; }
  try {
    if (await d.restartAndVerify() === true && (await d.power?.())?.isolationBlocked !== true) return 'repair-restarted';
  } catch {}
  await tell('文件已恢复一致，但重启后服务仍未解除受限；相同状态不会再次自动重启，请机主检查。');
  return 'repair-restart-failed';
}
async function repair(opts = {}, d) {
  const tell = async message => { d.log?.(message); if (d.notice) await d.notice(message); };
  if (d.recoverPending) {
    const recovery = await d.recoverPending();
    if (recovery?.fatal || recovery?.result === 'recovered') return recovery.result || 'recovery-refused';
    if (!recovery || recovery.pending === true || !['no-transaction', 'completed-cleanup'].includes(recovery.result)) {
      await tell('未完成升级尚未安全处理，暂不开始自动修复。'); return 'repair-refused';
    }
  }
  if (await d.stoppedByOwner?.()) return 'stopped-by-owner';
  let initial;
  try { initial = await capture(d); }
  catch { await tell('无法读取完整文件状态，自动修复已停止，请机主检查。'); return 'repair-refused'; }
  const directory = d.repairAttemptsDir || path.join(path.dirname(d.state), 'repair-attempts');
  if (initial.snapshot.gateReady === true && initial.snapshot.changes.length === 0) {
    if ((await d.power?.())?.isolationBlocked !== true) return 'repair-not-needed';
    return restartBlocked(initial, d, tell, directory);
  }
  if (!eligible(initial, d)) {
    await tell('受限状态不属于可自动修复的已提交源码变化；程序、隔离、运行环境、账号配置或未提交改动需要人工检查。');
    return 'repair-refused';
  }
  try {
    if (!await claimAttempt(directory, initial.identity, { schema: 1, fingerprint: initial.snapshot.fingerprint,
      filesFingerprint: initial.snapshot.filesFingerprint, head: initial.git.head, at: (d.now || Date.now)() })) return 'repair-already-attempted';
  } catch { await tell('修复尝试状态无法安全保存，未执行验收。'); return 'repair-refused'; }
  let starting = false, recoveryCheckpoint = null;
  async function stable(allowReceipt = false) {
    if (await d.stoppedByOwner?.()) throw Error('机主已停止服务');
    const current = await capture(d);
    if (current.identity === initial.identity) return current;
    if (allowReceipt && hash(gitIdentity(current.git)) === hash(gitIdentity(initial.git)) &&
        current.snapshot.filesFingerprint === initial.snapshot.filesFingerprint &&
        current.snapshot.gateReady === true && current.snapshot.changes.length === 0) return current;
    throw Error('自动修复期间文件或提交状态变化');
  }
  const guarded = { ...d,
    preview: async (...args) => { await stable(); const result = await d.preview(...args); await stable(); return result; },
    accept: async (...args) => { await stable(); const result = await d.accept(...args); await stable(); return result; },
    waitNoJobs: async (...args) => { await stable(true); const result = await d.waitNoJobs(...args); await stable(true); return result; },
    checkpointCompatible: async checkpoint => {
      if (await d.checkpointCompatible(checkpoint) !== true) return false;
      if (starting && checkpoint.sourceSha256 !== initial.snapshot.sourceSha256) recoveryCheckpoint = checkpoint;
      return true;
    },
    restartAndVerify: async () => {
      if (!starting) { await stable(true); starting = true; }
      else {
        // M3 允许恢复到旧提交，恢复后的源码因此可以与 HEAD 不同；完整旧记录仍必须通过当前核对。
        const current = await capture(d), checkpoint = recoveryCheckpoint;
        if (!checkpoint || current.git.head !== initial.git.head || current.snapshot.gateReady !== true ||
            current.snapshot.changes.length || current.snapshot.sourceSha256 !== checkpoint.sourceSha256 ||
            current.snapshot.receiptSha256 !== checkpoint.receiptSha256 || await d.stoppedByOwner?.())
          throw Error('恢复后状态未通过核对');
      }
      return d.restartAndVerify();
    },
  };
  try {
    await stable();
    const result = await (d.repairDeploy || deployment.deploy)({ ...opts, restart: true }, guarded);
    if (!['deployed', 'nothing-to-do'].includes(result)) await tell('自动修复未完成（' + result + '）；相同文件状态不会再次自动验收，请机主检查。');
    return result;
  } catch { await tell('自动修复因文件变化或执行失败停止；相同文件状态不会再次自动验收。'); return 'repair-failed'; }
}
module.exports = { repair };
