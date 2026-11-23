'use strict';

// M3：只负责部署事务；所有验收、Git 和启停操作都由调用者注入。
// 快照使用不可变分代目录，current.json 是唯一发布点，避免两个文件各更新一半。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const codeOf = error => error?.code || error?.name || 'UNKNOWN';
const refusal = (message, code = 'DEPLOY_REFUSED') => Object.assign(new Error(message), { code });

async function directory(full, create = false) {
  full = path.resolve(full);
  if (create) await fs.mkdir(full, { recursive: true });
  const stat = await fs.lstat(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(full), full)) {
    throw refusal('维护目录不是独立的真实目录。', 'UNSAFE_DIRECTORY');
  }
  return full;
}

async function readFile(full, maxBytes = 16 * 1024 * 1024) {
  full = path.resolve(full);
  await directory(path.dirname(full));
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw refusal('维护文件类型或大小无效。', 'INVALID_FILE');
  const handle = await fs.open(full, 'r');
  try {
    const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat();
    const current = await fs.lstat(full);
    if (bytes.length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.isSymbolicLink()) {
      throw refusal('读取维护文件时内容发生变化。', 'FILES_CHANGED');
    }
    return bytes;
  } finally { await handle.close(); }
}

async function atomicWrite(full, bytes) {
  await directory(path.dirname(full), true);
  try { const stat = await fs.lstat(full); if (!stat.isFile() || stat.isSymbolicLink()) throw refusal('拒绝替换非普通文件。', 'INVALID_FILE'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = full + '.' + crypto.randomBytes(16).toString('hex') + '.tmp';
  let handle;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, full);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function inform(d, message) {
  if (d.log) await d.log(message);
  if (d.notice) {
    try { await d.notice(message); }
    catch (error) { if (d.log) await d.log('保存部署提示失败：' + codeOf(error)); }
  }
}

function validateDependencies(d) {
  for (const name of ['sourcePath', 'receipt', 'lastGoodDir']) if (!path.isAbsolute(d[name] || '')) throw refusal('缺少绝对路径：' + name);
  if (d.transactionsDir && !path.isAbsolute(d.transactionsDir)) throw refusal('候选事务目录必须是绝对路径。');
  if (samePath(path.resolve(d.sourcePath), path.resolve(d.receipt))) throw refusal('代码与验收记录不能共用同一路径。');
  for (const name of ['gitState', 'preview', 'accept', 'waitNoJobs', 'restartAndVerify', 'gateOk', 'checkpointCompatible']) {
    if (typeof d[name] !== 'function') throw refusal('缺少部署依赖：' + name);
  }
}

async function capture(d) {
  const source = await readFile(d.sourcePath), receipt = await readFile(d.receipt);
  const git = await d.gitState();
  const sourceAfter = await readFile(d.sourcePath), receiptAfter = await readFile(d.receipt);
  if (hash(source) !== hash(sourceAfter) || hash(receipt) !== hash(receiptAfter)) throw refusal('检查工作区期间文件发生变化。', 'FILES_CHANGED');
  if (git?.clean !== true) throw refusal('工作区有未提交改动或无法可靠读取 Git 状态，不自动验收或覆盖。', 'DIRTY_WORKTREE');
  if (git.sourceMatchesHead !== true || !/^[a-f0-9]{7,64}$/i.test(git.head || '') ||
      (git.headSourceSha256 && git.headSourceSha256 !== hash(source))) {
    throw refusal('server.js 与 Git HEAD 不一致，不自动验收或覆盖。', 'SOURCE_NOT_HEAD');
  }
  return { source, receipt, sourceSha256: hash(source), receiptSha256: hash(receipt), git };
}

async function unchanged(d, expected) {
  const actual = await capture(d);
  if (actual.git.head !== expected.git.head || actual.sourceSha256 !== expected.sourceSha256 || actual.receiptSha256 !== expected.receiptSha256) {
    throw refusal('部署等待期间 Git、server.js 或验收记录发生变化，已停止自动覆盖。', 'FILES_CHANGED');
  }
  return actual;
}

async function pairStillMatches(d, expectedSource, expectedReceipt) {
  return hash(await readFile(d.sourcePath)) === hash(expectedSource) && hash(await readFile(d.receipt)) === hash(expectedReceipt);
}

async function publishCheckpoint(d, state) {
  await directory(d.lastGoodDir, true);
  const generation = crypto.randomBytes(16).toString('hex');
  const stage = path.join(d.lastGoodDir, '.pending-' + generation), destination = path.join(d.lastGoodDir, generation);
  await directory(stage, true);
  const metadata = { schema: 1, generation, createdAt: new Date(d.now ? d.now() : Date.now()).toISOString(), head: state.git.head,
    sourceDestination: path.resolve(d.sourcePath), receiptDestination: path.resolve(d.receipt),
    sourceSha256: state.sourceSha256, receiptSha256: state.receiptSha256 };
  try {
    await atomicWrite(path.join(stage, 'server.js'), state.source);
    await atomicWrite(path.join(stage, 'acceptance.json'), state.receipt);
    await atomicWrite(path.join(stage, 'checkpoint.json'), JSON.stringify(metadata, null, 2) + '\n');
    await fs.rename(stage, destination);
    await atomicWrite(path.join(d.lastGoodDir, 'current.json'), JSON.stringify({ schema: 1, generation }) + '\n');
  } finally {
    // 只清理由本次随机目录创建的已知文件；未知内容留下，不递归删除。
    for (const name of ['server.js', 'acceptance.json', 'checkpoint.json']) await fs.rm(path.join(stage, name), { force: true }).catch(() => {});
    await fs.rmdir(stage).catch(() => {});
  }
  return loadCheckpoint(d);
}

async function loadCheckpoint(d) {
  let pointer;
  try { pointer = JSON.parse((await readFile(path.join(d.lastGoodDir, 'current.json'), 4096)).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (pointer.schema !== 1 || !/^[a-f0-9]{32}$/.test(pointer.generation || '')) throw refusal('可用版本指针损坏。', 'CHECKPOINT_INVALID');
  const folder = await directory(path.join(d.lastGoodDir, pointer.generation));
  const metadata = JSON.parse((await readFile(path.join(folder, 'checkpoint.json'), 16384)).toString('utf8'));
  const sourcePath = path.join(folder, 'server.js'), receiptPath = path.join(folder, 'acceptance.json');
  const source = await readFile(sourcePath), receipt = await readFile(receiptPath);
  if (metadata.schema !== 1 || metadata.generation !== pointer.generation || !/^[a-f0-9]{7,64}$/i.test(metadata.head || '') ||
      !samePath(metadata.sourceDestination || '', path.resolve(d.sourcePath)) || !samePath(metadata.receiptDestination || '', path.resolve(d.receipt)) ||
      metadata.sourceSha256 !== hash(source) || metadata.receiptSha256 !== hash(receipt)) {
    throw refusal('可用版本快照内容或归属核对失败。', 'CHECKPOINT_INVALID');
  }
  return { ...metadata, sourcePath, receiptPath, source, receipt };
}

async function rollback(d, expected) {
  let checkpoint;
  try {
    checkpoint = await loadCheckpoint(d);
    if (!checkpoint) throw refusal('没有已验证的上一可用版本，不能伪造回退基线。', 'NO_CHECKPOINT');
    if (await d.checkpointCompatible(checkpoint) !== true) throw refusal('上一版本记录与当前程序、运行环境或配置不兼容，不能自动接受旧记录。', 'CHECKPOINT_INCOMPATIBLE');
    if (await d.waitNoJobs({ allowStopped: true }) !== true) throw refusal('尚未确认可以安全恢复，未覆盖任何代码。', 'ROLLBACK_BUSY');
    await unchanged(d, expected);
    // 空闲等待可能很长，恢复前重新读取快照并重新核对兼容性。
    const fresh = await loadCheckpoint(d);
    if (!fresh || fresh.generation !== checkpoint.generation || await d.checkpointCompatible(fresh) !== true) {
      throw refusal('等待恢复期间可用版本快照或运行环境发生变化。', 'CHECKPOINT_CHANGED');
    }
    checkpoint = fresh;
    await unchanged(d, expected);
  } catch (error) {
    await inform(d, '重启失败，未自动覆盖文件：' + error.message + ' 当前磁盘和运行状态需要机主检查。');
    return 'rollback-refused';
  }

  let sourceRestored = false;
  try {
    await atomicWrite(d.sourcePath, checkpoint.source); sourceRestored = true;
    if (!await pairStillMatches(d, checkpoint.source, expected.receipt)) throw refusal('恢复代码后文件又被修改，停止后续覆盖。', 'FILES_CHANGED');
    await atomicWrite(d.receipt, checkpoint.receipt);
    if (!await pairStillMatches(d, checkpoint.source, checkpoint.receipt) || await d.gateOk() !== true) throw refusal('回退后的代码和记录核对失败。', 'ROLLBACK_GATE_FAILED');
    if (await d.restartAndVerify() !== true) throw refusal('已恢复旧代码和旧记录，但服务仍未正常启动。', 'ROLLBACK_START_FAILED');
    await inform(d, '本次部署重启失败，已恢复上一可用代码和对应验收记录并重新启动。工作区现在保留旧版差异，未执行 Git reset 或提交。');
    return 'restart-failed-restored';
  } catch (error) {
    // 第二个文件还没替换时尽量回到恢复前的完整状态；发现编辑则不再覆盖。
    if (sourceRestored && await pairStillMatches(d, checkpoint.source, expected.receipt).catch(() => false)) {
      await atomicWrite(d.sourcePath, expected.source).catch(() => {});
    }
    await inform(d, '自动恢复未完成：' + error.message + ' 不再继续重启或覆盖，请机主检查代码、记录和服务。');
    return 'rollback-failed';
  }
}

async function deploy(opts, d) {
  validateDependencies(d);
  opts ||= {};
  let initial, transaction, candidatePath;
  try {
    initial = await capture(d);
    const preview = await d.preview();
    await unchanged(d, initial);
    if (preview?.ok !== true || typeof preview.changed !== 'boolean') {
      await inform(d, '上线预检查拒绝本次改动。未验收、未重启，也未覆盖工作区；已改动的磁盘代码可能仍与旧记录不一致，下次重启可能进入受限模式。请检查不一致类别。');
      return 'refused';
    }

    const gateBefore = await d.gateOk();
    await unchanged(d, initial);
    let hasCheckpoint = true, baselineCreated = false;
    try { hasCheckpoint = !!await loadCheckpoint(d); } catch { /* 损坏的旧快照不能冒充首次基线。 */ }
    if (!hasCheckpoint && gateBefore === true) {
      await publishCheckpoint(d, initial);
      baselineCreated = true;
      await unchanged(d, initial);
    }

    let candidate;
    if (preview.changed) {
      const transactionRoot = d.transactionsDir || path.join(path.dirname(d.lastGoodDir), 'transactions');
      await directory(transactionRoot, true);
      transaction = path.join(transactionRoot, crypto.randomBytes(16).toString('hex'));
      await directory(transaction, true);
      candidatePath = path.join(transaction, 'receipt.candidate.json');
      let accepted;
      try { accepted = await d.accept({ outputReceipt: candidatePath }); }
      catch (error) { accepted = { ok: false }; if (d.log) await d.log('验收执行异常：' + codeOf(error)); }
      await unchanged(d, initial);
      if (accepted?.ok !== true) {
        await inform(d, '验收未通过，没有重启或覆盖代码。当前进程可能仍运行旧代码，但磁盘上已是新 server.js、配旧记录，之后崩溃或重启可能进入受限模式；请机主处理。');
        return 'acceptance-failed';
      }
      candidate = await readFile(candidatePath);
      const candidatePair = { sourcePath: d.sourcePath, receiptPath: candidatePath, source: initial.source, receipt: candidate,
        sourceSha256: initial.sourceSha256, receiptSha256: hash(candidate), head: initial.git.head };
      if (await d.checkpointCompatible(candidatePair) !== true) {
        await inform(d, '候选验收记录未通过只读兼容性检查，未安装记录、未重启。');
        return 'candidate-incompatible';
      }
    } else if (gateBefore !== true) {
      await inform(d, '当前记录核对失败，不能把无需验收当成已验证。未重启。');
      return 'refused';
    } else if (!opts.restart) {
      const stable = await unchanged(d, initial);
      if (!baselineCreated) await publishCheckpoint(d, stable);
      if (d.log) await d.log('文件与验收记录一致，已保存可用版本快照，无需重启。');
      return 'nothing-to-do';
    }

    if (await d.waitNoJobs() !== true) {
      await inform(d, '尚未等到安全空闲，本次没有安装候选记录或重启。磁盘代码可能仍与正式记录不一致，请勿把本次当作已上线。');
      return 'restart-pending';
    }
    await unchanged(d, initial);
    if (candidate) {
      if (hash(await readFile(candidatePath)) !== hash(candidate)) throw refusal('等待期间候选记录被修改。', 'FILES_CHANGED');
      await atomicWrite(d.receipt, candidate);
    }
    const installed = { ...initial, receipt: candidate || initial.receipt, receiptSha256: hash(candidate || initial.receipt) };
    await unchanged(d, installed);
    if (await d.gateOk() !== true) {
      await inform(d, '安装候选记录后核对失败，未重启，未自动覆盖源码；需要机主检查。');
      return 'gate-failed-before-restart';
    }
    await unchanged(d, installed);
    let restarted = false;
    try { restarted = await d.restartAndVerify(); }
    catch (error) { if (d.log) await d.log('本次重启抛出异常：' + codeOf(error)); }
    if (restarted !== true) return await rollback(d, installed);
    const verified = await unchanged(d, installed);
    if (await d.gateOk() !== true) throw refusal('启动后运行文件又发生变化，未更新可用版本快照。', 'FILES_CHANGED');
    await unchanged(d, verified);
    await publishCheckpoint(d, verified);
    if (d.log) await d.log('已上线：服务和记录核对通过，可用版本快照已成对更新。');
    return 'deployed';
  } catch (error) {
    await inform(d, '部署已停止：' + error.message + ' 未自动覆盖用户未提交的修改，也未伪造可用版本。若磁盘代码已变化但正式记录尚未更新，下次重启可能进入受限模式。');
    return 'deploy-refused';
  } finally {
    if (candidatePath) await fs.rm(candidatePath, { force: true }).catch(() => {});
    if (transaction) await fs.rmdir(transaction).catch(() => {});
  }
}

module.exports = { deploy, loadCheckpoint };
