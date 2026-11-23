'use strict';
// M6：此模块只能在已有维护锁和重启屏障内调用；不扩大任何验收范围。
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const tx = require('./maintenance-transaction.cjs'), policy = require('./maintenance-policy.cjs');
const health = require('./runtime-health.cjs');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/, VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const now = d => (d.now || Date.now)();
const paths = d => ({
  state: d.runtimeState || path.join(path.dirname(d.state), 'runtime-upgrades.json'),
  events: d.runtimeEvents || path.join(path.dirname(d.state), 'runtime-events'),
});
const blank = () => ({ schema: 1, chain: [], counters: {}, processed: [], authNotified: {}, rollback: null, pendingNotice: null });
function binding(entry, d) {
  const transaction = entry?.transaction, program = d.programs.find(item => item.name === transaction?.program);
  const directory = tx.paths(d).directory;
  return program && entry.id === transaction.id && ID.test(entry.id) &&
    ['pending-commit', 'committed'].includes(entry.phase) && VERSION.test(entry.newVersion || '') &&
    Number.isSafeInteger(entry.at) && entry.at > 0 && transaction.schema === 1 &&
    same(transaction.programRoot, program.root) && same(transaction.receipt, d.receipt) &&
    same(transaction.backup, path.join(directory, entry.id, 'receipt.before.json')) &&
    same(transaction.outputReceipt, path.join(directory, entry.id, 'receipt.candidate.json')) &&
    ['oldProgramHash', 'candidateHash', 'receiptHash', 'acceptedReceiptHash'].every(key => HASH.test(transaction[key] || '')) &&
    VERSION.test(transaction.oldVersion || '') &&
    validWorld(entry.beforeWorld, d) && validWorld(entry.afterWorld, d) &&
    entry.beforeWorld[program.name].hash === transaction.oldProgramHash &&
    entry.afterWorld[program.name].hash === transaction.candidateHash &&
    d.programs.every(item => item.name === program.name || entry.beforeWorld[item.name].hash === entry.afterWorld[item.name].hash);
}
function validWorld(world, d) {
  return world && Object.keys(world).sort().join(',') === d.programs.map(item => item.name).sort().join(',') &&
    d.programs.every(item => same(world[item.name]?.root, item.root) && HASH.test(world[item.name]?.hash || ''));
}
function validateState(state, d) {
  const allowed = ['schema', 'chain', 'counters', 'processed', 'authNotified', 'rollback', 'pendingNotice', 'lastRefusal'];
  if (!state || Object.keys(state).some(key => !allowed.includes(key)) || state.schema !== 1 ||
      !Array.isArray(state.chain) || state.chain.length > 8 || !state.chain.every(entry => binding(entry, d)) ||
      !Array.isArray(state.processed) || state.processed.length > 512 ||
      !state.processed.every(name => /^\d{16}-[a-f0-9]{32}\.json$/.test(name)) ||
      !state.counters || typeof state.counters !== 'object' || Array.isArray(state.counters) ||
      !state.authNotified || typeof state.authNotified !== 'object' || Array.isArray(state.authNotified)) throw Error('runtime-state-invalid');
  if (new Set(state.chain.map(entry => entry.id)).size !== state.chain.length) throw Error('runtime-state-invalid');
  for (const [program, counter] of Object.entries(state.counters)) {
    if (!['Claude', 'Codex'].includes(program) || !ID.test(counter?.entryId || '') ||
        !Number.isSafeInteger(counter.failures) || counter.failures < 1 || counter.failures > 1000000 ||
        !Array.isArray(counter.sessions) || counter.sessions.length > 2 || !counter.sessions.every(value => HASH.test(value)))
      throw Error('runtime-state-invalid');
  }
  // Gemini（agy）只有登录提醒：它不经这里自动升级，所以不会有升级链和故障计数
  if (Object.entries(state.authNotified).some(([program, value]) => !['Claude', 'Codex', 'Gemini'].includes(program) || typeof value !== 'boolean'))
    throw Error('runtime-state-invalid');
  for (let i = 1; i < state.chain.length; i++) {
    const previous = state.chain[i - 1], current = state.chain[i];
    if (previous.phase !== 'committed' || previous.at > current.at ||
        previous.transaction.acceptedReceiptHash !== current.transaction.receiptHash ||
        JSON.stringify(previous.afterWorld) !== JSON.stringify(current.beforeWorld)) throw Error('runtime-state-invalid');
  }
  if (state.rollback) {
    const plan = state.rollback, index = state.chain.findIndex(entry => entry.id === plan.targetId);
    const steps = state.chain.slice(index).reverse().map(entry => entry.id);
    if (index < 0 || !Number.isInteger(plan.index) || plan.index < 0 || plan.index > steps.length ||
        !Number.isSafeInteger(plan.requestedAt) || plan.requestedAt <= 0 ||
        JSON.stringify(plan.steps) !== JSON.stringify(steps)) throw Error('runtime-state-invalid');
  }
  if (state.pendingNotice && (!ID.test(state.pendingNotice.id || '') ||
      !['Claude', 'Codex'].includes(state.pendingNotice.program) || !VERSION.test(state.pendingNotice.version || '') ||
      typeof state.pendingNotice.label !== 'string' || state.pendingNotice.label.length > 64 ||
      !/^(?:Claude|Codex)(?: → (?:Claude|Codex))*$/.test(state.pendingNotice.label))) throw Error('runtime-state-invalid');
  if (state.lastRefusal !== undefined && !HASH.test(state.lastRefusal)) throw Error('runtime-state-invalid');
  return state;
}
async function load(d) {
  try {
    const file = paths(d).state; await tx.physical(file);
    const bytes = await fs.readFile(file, 'utf8');
    if (bytes.length > 1024 * 1024) throw Error();
    return validateState(JSON.parse(bytes), d);
  } catch (error) { if (error.code === 'ENOENT') return blank(); throw Error('runtime-state-invalid'); }
}
async function pending(d) {
  // 供五分钟巡检使用：只读小状态/文件名；没有事件时不计算程序指纹。
  try {
    const names = await fs.readdir(paths(d).events);
    if (names.some(name => /^\d{16}-[a-f0-9]{32}\.json$/.test(name))) return true;
  } catch (error) { if (error.code !== 'ENOENT') return true; }
  try {
    const state = await load(d);
    return !!(state.rollback || state.pendingNotice || state.chain.some(entry => entry.phase === 'pending-commit'));
  } catch { return true; }
}
async function save(d, state) {
  const file = paths(d).state;
  await tx.physical(path.dirname(file), true); await fs.mkdir(path.dirname(file), { recursive: true });
  await tx.atomicWrite(file, JSON.stringify(state));
}
async function snapshot(d) {
  const world = {};
  for (const program of [...d.programs].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!['Claude', 'Codex'].includes(program.name)) throw Error('runtime-program-unsupported');
    world[program.name] = { root: path.resolve(program.root), hash: await tx.treeHash(program.root) };
  }
  return world;
}
async function matches(d, world, receiptHash) {
  try { return JSON.stringify(await snapshot(d)) === JSON.stringify(world) && await tx.fileHash(d.receipt) === receiptHash; }
  catch { return false; }
}
function prune(state, time) {
  if (state.rollback) return;
  while (state.chain[0]?.phase === 'committed' && time - state.chain[0].at >= WINDOW_MS) {
    const old = state.chain.shift();
    if (state.counters[old.transaction.program]?.entryId === old.id) delete state.counters[old.transaction.program];
  }
}
async function notice(d, message, event) {
  if (typeof d.runtimeNotice === 'function') await d.runtimeNotice(message);
  else if (typeof d.notice === 'string') {
    await tx.physical(path.dirname(d.notice), true); await fs.mkdir(path.dirname(d.notice), { recursive: true });
    await tx.atomicWrite(d.notice, message);
  }
  if (event && typeof d.notify === 'function') await d.notify(event);
}
async function refused(d, reason, state) {
  const key = digest(reason + ':' + (state?.chain || []).map(entry => entry.id).join(','));
  if (!state || state.lastRefusal !== key) {
    await notice(d, '升级后的自动退回暂未执行：证据或当前文件不兼容，需要机主检查。不会覆盖未知变化。', {
      type: 'isolation-blocked', program: 'relay', version: 'unknown', reason: 'fingerprint-mismatch', issueFingerprint: key,
    });
    if (state) { state.lastRefusal = key; await save(d, state); }
  }
  return { status: 'refused', reason };
}
async function reconcile(d) {
  let state;
  try {
    state = await load(d);
    const pending = state.chain.find(entry => entry.phase === 'pending-commit');
    if (!pending) return { status: 'ok', state };
    if (pending !== state.chain[state.chain.length - 1] || state.rollback) return refused(d, 'pending-chain-invalid', state);
    if (await tx.readJournal(d)) return { status: 'transaction-pending', state };
    if (await matches(d, pending.beforeWorld, pending.transaction.receiptHash) && await d.gateOk() === true) {
      state.chain.pop(); delete state.counters[pending.transaction.program]; await save(d, state);
      return { status: 'discarded-rolled-back-registration', state };
    }
    if (await matches(d, pending.afterWorld, pending.transaction.acceptedReceiptHash) && await d.gateOk() === true) {
      pending.phase = 'committed'; await save(d, state); return { status: 'confirmed', state };
    }
    return refused(d, 'pending-state-drift', state);
  } catch { return refused(d, 'runtime-state-invalid', state); }
}
async function canUpgrade(program, d) {
  const result = await reconcile(d);
  if (!result.state || !['ok', 'confirmed', 'discarded-rolled-back-registration'].includes(result.status))
    return { allowed: false, reason: result.reason || result.status };
  const state = result.state; prune(state, now(d)); await save(d, state);
  if (state.rollback) return { allowed: false, reason: 'runtime-rollback-pending' };
  if (state.chain.some(entry => entry.transaction.program === program.name))
    return { allowed: false, reason: 'runtime-watch-window', retryAt: state.chain.find(entry => entry.transaction.program === program.name).at + WINDOW_MS };
  const head = state.chain.at(-1);
  if (head && !await matches(d, head.afterWorld, head.transaction.acceptedReceiptHash))
    return { allowed: false, reason: 'runtime-checkpoint-drift' };
  return { allowed: true };
}
const TRANSACTION_FIELDS = ['schema', 'id', 'ownerPid', 'ownerStartedAt', 'program', 'programRoot', 'oldVersion',
  'receipt', 'backup', 'outputReceipt', 'oldProgramHash', 'candidateHash', 'receiptHash',
  'acceptedReceiptHash', 'createdAt', 'updatedAt', 'phase'];
async function registerUpgrade(transaction, newVersion, d) {
  if (!VERSION.test(newVersion || '')) throw Error('runtime-version-invalid');
  const state = await load(d);
  const existing = state.chain.find(entry => entry.id === transaction.id);
  if (existing) return { status: existing.phase, id: existing.id };
  prune(state, now(d));
  if (state.rollback || state.chain.some(entry => entry.phase !== 'committed' || entry.transaction.program === transaction.program))
    throw Error('runtime-evidence-still-needed');
  const journal = await tx.readJournal(d);
  if (!journal || journal.tx.id !== transaction.id || !HASH.test(journal.tx.acceptedReceiptHash || ''))
    throw Error('runtime-transaction-unbound');
  const bound = Object.fromEntries(TRANSACTION_FIELDS.filter(key => journal.tx[key] !== undefined).map(key => [key, journal.tx[key]]));
  const afterWorld = await snapshot(d), beforeWorld = structuredClone(afterWorld);
  beforeWorld[bound.program].hash = bound.oldProgramHash;
  const entry = { id: bound.id, phase: 'pending-commit', at: now(d), newVersion, transaction: bound, beforeWorld, afterWorld };
  if (!binding(entry, d) || await tx.treeHash(journal.program.root + '.prev') !== bound.oldProgramHash ||
      !await matches(d, afterWorld, bound.acceptedReceiptHash) || await d.gateOk() !== true)
    throw Error('runtime-checkpoint-invalid');
  const previous = state.chain.at(-1);
  if (previous && (previous.transaction.acceptedReceiptHash !== bound.receiptHash ||
      JSON.stringify(previous.afterWorld) !== JSON.stringify(beforeWorld))) throw Error('runtime-chain-broken');
  state.chain.push(entry); await save(d, state);
  return { status: 'pending-commit', id: bound.id };
}
async function confirmUpgrade(id, d) {
  const result = await reconcile(d);
  return { status: result.state?.chain.find(entry => entry.id === id)?.phase === 'committed'
    ? 'monitoring' : result.status, reason: result.reason };
}
async function consumeEvents(d, state) {
  let names;
  try { await tx.physical(paths(d).events); names = await fs.readdir(paths(d).events); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const pending = names.filter(name => /^\d{16}-[a-f0-9]{32}\.json$/.test(name)).sort().slice(0, 256);
  for (const name of pending) {
    if (state.processed.includes(name)) continue;
    const file = path.join(paths(d).events, name); await tx.physical(file);
    const content = await fs.readFile(file, 'utf8');
    if (content.length > 2048) throw Error('runtime-event-invalid');
    const event = JSON.parse(content);
    if (!health.validEvent(event) || event.at > now(d) + 300000) throw Error('runtime-event-invalid');
    if (event.category === 'auth' && !state.authNotified[event.program]) {
      await notice(d, event.program + ' 的登录可能已过期，请机主重新确认登录。不会因此自动退回程序。');
      state.authNotified[event.program] = true;
    }
    if (event.category === 'success') state.authNotified[event.program] = false;
    const entry = state.chain.findLast(item => item.phase === 'committed' && item.transaction.program === event.program);
    if (entry && event.startedAt >= entry.at && event.at >= entry.at && event.at - entry.at < WINDOW_MS) {
      if (!health.FAULTS.includes(event.category)) delete state.counters[event.program];
      else {
        let counter = state.counters[event.program];
        if (!counter || counter.entryId !== entry.id) counter = { entryId: entry.id, failures: 0, sessions: [] };
        counter.failures = Math.min(counter.failures + 1, 1000000);
        counter.sessions = [...new Set([...counter.sessions, event.sessionHash])].slice(0, 2);
        state.counters[event.program] = counter;
        if (!state.rollback && counter.failures >= 3 && counter.sessions.length >= 2) {
          const index = state.chain.findIndex(item => item.id === entry.id);
          state.rollback = { targetId: entry.id, steps: state.chain.slice(index).reverse().map(item => item.id), index: 0, requestedAt: now(d) };
        }
      }
    }
    state.processed.push(name);
  }
  await save(d, state); // 先记消费，再删除事件；中断后不会重复计数。
  for (const name of [...state.processed]) {
    try {
      const file = path.join(paths(d).events, name); await tx.physical(file); await fs.unlink(file);
      state.processed = state.processed.filter(item => item !== name);
    } catch (error) { if (error.code === 'ENOENT') state.processed = state.processed.filter(item => item !== name); }
  }
  await save(d, state);
}
async function markFailed(d, entry) {
  let state = {};
  try { await tx.physical(d.state); state = JSON.parse(await fs.readFile(d.state, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('version-state-invalid'); }
  if (state.runtimeFailureIds?.[entry.id]) return;
  state = policy.recordVersionFailure(state, entry.transaction.program, entry.newVersion, now(d), { kind: 'runtime-failure' });
  state.runtimeFailureIds = { ...(state.runtimeFailureIds || {}), [entry.id]: true };
  await tx.atomicWrite(d.state, JSON.stringify(state));
}
async function backupsValid(d, entries) {
  try {
    for (const entry of entries) {
      if (!binding(entry, d) || await tx.fileHash(entry.transaction.backup) !== entry.transaction.receiptHash ||
          await tx.fileHash(entry.transaction.outputReceipt) !== entry.transaction.acceptedReceiptHash ||
          await tx.treeHash(entry.transaction.programRoot + '.prev') !== entry.transaction.oldProgramHash) return false;
    }
    return true;
  } catch { return false; }
}
async function flushNotice(d, state) {
  if (!state.pendingNotice) return;
  const event = state.pendingNotice;
  await notice(d, event.label + ' 升级后连续发生程序故障，已按升级顺序反向恢复程序和验收记录，并核对服务。', {
    type: 'rolled-back', program: event.program.toLowerCase(), version: event.version,
    reason: 'runtime-failure', issueFingerprint: digest(event.id),
  });
  state.pendingNotice = null; await save(d, state);
}
async function processRuntime(d) {
  let state;
  try {
    const reconciled = await reconcile(d);
    if (!reconciled.state || !['ok', 'confirmed', 'discarded-rolled-back-registration'].includes(reconciled.status)) return reconciled;
    state = reconciled.state; await flushNotice(d, state);
    await consumeEvents(d, state); prune(state, now(d)); await save(d, state);
    if (!state.rollback) return { status: 'idle' };
    if (d.stoppedByOwner?.()) return { status: 'stopped-by-owner' };
    if (typeof d.waitNoJobs !== 'function' || await d.waitNoJobs({ allowStopped: true }) !== true)
      return { status: 'waiting-idle' };
    const plan = state.rollback, target = state.chain.find(entry => entry.id === plan.targetId);
    const steps = plan.steps.map(id => state.chain.find(entry => entry.id === id));

    for (; plan.index < steps.length; ) {
      const entry = steps[plan.index], transaction = entry.transaction;
      // M1可能已完成上次中断的这一层；只有全局程序集合及receipt都符合before才确认。
      if (await matches(d, entry.beforeWorld, transaction.receiptHash) && await d.gateOk() === true) {
        if (await tx.readJournal(d)) return refused(d, 'unfinished-recovery-journal', state);
        if (!await recoveryGuard(transaction, d.programs.find(item => item.name === transaction.program), d))
          return refused(d, 'runtime-boundary-drift', state);
        await markFailed(d, target);
        plan.index++; await save(d, state); continue;
      }
      if (!await matches(d, entry.afterWorld, transaction.acceptedReceiptHash) || await d.gateOk() !== true)
        return refused(d, 'runtime-current-drift', state);
      if (!await backupsValid(d, steps.slice(plan.index))) return refused(d, 'runtime-backup-drift', state);
      if (await tx.readJournal(d)) return refused(d, 'another-transaction-active', state);
      if (d.stoppedByOwner?.() || await d.waitNoJobs({ allowStopped: true }) !== true) return { status: 'waiting-idle' };
      if (!await matches(d, entry.afterWorld, transaction.acceptedReceiptHash) || await d.gateOk() !== true ||
          !await backupsValid(d, steps.slice(plan.index))) return refused(d, 'runtime-drift-after-wait', state);
      // 同一种日志格式交给M1；中断后先由维护入口的M1恢复，再由上面的before分支续链。
      const restoredTx = { ...transaction, ownerPid: process.pid,
        ownerStartedAt: await (d.processIdentity || tx.processIdentity)(process.pid) };
      if (!await recoveryGuard(restoredTx, d.programs.find(item => item.name === restoredTx.program), d))
        return refused(d, 'runtime-boundary-drift', state);
      await markFailed(d, target);
      await tx.writeJournal(d, restoredTx, 'recovering');
      const recovered = await tx.recover({ ...d, recoveryGuard: (record, item) => recoveryGuard(record, item, d) }, { own: true });
      if (recovered.fatal || recovered.result !== 'recovered') return refused(d, 'runtime-recovery-incomplete', state);
      if (!await matches(d, entry.beforeWorld, transaction.receiptHash) || await d.gateOk() !== true)
        return refused(d, 'runtime-after-rollback-drift', state);
      plan.index++; await save(d, state);
      if (d.onRuntimeStep) await d.onRuntimeStep(entry.id, plan.index);
    }
    const oldest = steps.at(-1);
    if (!await matches(d, oldest.beforeWorld, oldest.transaction.receiptHash) || await d.gateOk() !== true)
      return refused(d, 'runtime-final-drift', state);
    if (d.stoppedByOwner?.() || await d.waitNoJobs({ allowStopped: true }) !== true) return { status: 'waiting-idle' };
    if (!await matches(d, oldest.beforeWorld, oldest.transaction.receiptHash) || await d.gateOk() !== true)
      return refused(d, 'runtime-drift-before-restart', state);
    const gitBeforeRestart = typeof d.gitState === 'function' ? await d.gitState() : null;
    if (gitBeforeRestart?.clean !== true || gitBeforeRestart.sourceMatchesHead !== true) return refused(d, 'runtime-source-uncommitted', state);
    if (typeof d.restartAndVerify !== 'function' || await d.restartAndVerify() !== true)
      return refused(d, 'runtime-restart-failed', state);
    if (!await matches(d, oldest.beforeWorld, oldest.transaction.receiptHash) || await d.gateOk() !== true)
      return refused(d, 'runtime-after-restart-drift', state);
    const count = steps.length, index = state.chain.findIndex(entry => entry.id === target.id);
    for (const entry of state.chain.slice(index)) delete state.counters[entry.transaction.program];
    state.chain = state.chain.slice(0, index); state.rollback = null;
    state.pendingNotice = { id: target.id, program: target.transaction.program, version: target.newVersion,
      label: steps.map(entry => entry.transaction.program).join(' → ') };
    await save(d, state); await flushNotice(d, state);
    return { status: 'rolled-back', program: target.transaction.program, steps: count };
  } catch { return refused(d, 'runtime-processing-failed', state); }
}

async function receiptBoundaryGuard(receiptPath, context, skipProgramRoot) {
  try {
    const { root, config, runtime, gate } = context || {};
    if (!path.isAbsolute(root || '') || !config || !runtime || !gate || !Array.isArray(gate.REQUIRED)) return false;
    const inspect = require('./maintenance-repair-inspect.cjs');
    const bytes = await fs.readFile(receiptPath);
    if (bytes.length > 8 * 1024 * 1024) return false;
    const receipt = JSON.parse(bytes);
    if (receipt.schema !== gate.RECEIPT_SCHEMA || !Number.isFinite(Date.parse(receipt.completedAt)) ||
        gate.REQUIRED.some(name => receipt.checks?.[name]?.passed !== true) ||
        receipt.configurationFingerprint !== await inspect.configurationFingerprint(config, runtime, root) ||
        // 和门槛一致：GPT 已退出平台，不再要求 openaiApiKey，而是要求没有账号开着 GPT
        require('./check-isolation.cjs').gptRetirementReason(config) || !Array.isArray(receipt.fingerprints) || !receipt.fingerprints.length) return false;
    const required = await inspect.requiredFiles(config, runtime, root, gate, { skipProgramRoot });
    const key = file => path.resolve(file).toLowerCase(), ignored = key(skipProgramRoot);
    const claudeFile = [runtime.claudePath, config.claudePath].some(file => path.isAbsolute(file || '') && key(file) === ignored);
    const skip = file => key(file) === ignored || (!claudeFile && key(file).startsWith(ignored + path.sep));
    const covered = new Set(), checked = [];
    for (const item of receipt.fingerprints) {
      if (!path.isAbsolute(item?.path || '') || !HASH.test(item.sha256 || '') || covered.has(key(item.path))) return false;
      covered.add(key(item.path));
      if (!skip(item.path)) {
        if (await tx.fileHash(item.path) !== item.sha256) return false;
        checked.push(item);
      }
    }
    if (!covered.has(key(path.join(root, 'server.js'))) || required.some(file => !covered.has(key(file)))) return false;
    if (!path.isAbsolute(runtime.whisperModel || '')) return false;
    await fs.access(runtime.whisperModel);
    const ids = new Set();
    if (!Array.isArray(config.users) || !config.users.length) return false;
    for (const user of config.users) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(user.id || '') || ids.has(user.id) || !path.isAbsolute(user.workDir || '')) return false;
      ids.add(user.id); await tx.physical(user.workDir);
      if (!(await fs.lstat(user.workDir)).isDirectory()) return false;
    }
    // 第二遍只读，防止把跨文件变化拼成可恢复的快照；不生成临时验收记录。
    for (const item of checked) if (await tx.fileHash(item.path) !== item.sha256) return false;
    return bytes.equals(await fs.readFile(receiptPath));
  } catch { return false; }
}
async function recoveryGuard(transaction, program, d) {
  try {
    const state = await load(d), entry = state.chain.find(item => item.id === transaction.id);
    if (!entry) return !state.rollback; // 没有M6记录的普通M1事务仍使用原M1约束。
    if (state.rollback) {
      if (state.rollback.steps[state.rollback.index] !== entry.id) return false;
    } else if (entry.phase !== 'pending-commit') return false;
    if (!binding(entry, d) || program.name !== entry.transaction.program ||
        !same(program.root, entry.transaction.programRoot) ||
        ['oldProgramHash', 'candidateHash', 'receiptHash', 'acceptedReceiptHash'].some(key => transaction[key] !== entry.transaction[key])) return false;
    const currentReceipt = await tx.fileHash(d.receipt);
    if (![entry.transaction.receiptHash, entry.transaction.acceptedReceiptHash].includes(currentReceipt)) return false;
    for (const configured of d.programs) {
      const current = await tx.exists(configured.root) ? await tx.treeHash(configured.root) : null;
      if (configured.name === program.name) {
        if (current !== null && ![entry.transaction.oldProgramHash, entry.transaction.candidateHash].includes(current)) return false;
      } else if (current !== entry.beforeWorld[configured.name].hash) return false;
    }
    if (await tx.fileHash(entry.transaction.backup) !== entry.transaction.receiptHash ||
        await tx.fileHash(entry.transaction.outputReceipt) !== entry.transaction.acceptedReceiptHash) return false;
    const git = typeof d.gitState === 'function' ? await d.gitState() : null;
    if (git?.clean !== true || git.sourceMatchesHead !== true) return false;
    const context = typeof d.getBoundaryContext === 'function' ? await d.getBoundaryContext() : null;
    if (!context && typeof d.runtimeBoundaryCheck !== 'function') return false;
    const check = d.runtimeBoundaryCheck || receiptBoundaryGuard;
    // 比较摘要只在内存中进行，配置或凭证内容绝不写入事件/状态。
    const contextHash = value => digest(JSON.stringify({ root: value.root, config: value.config, runtime: value.runtime }));
    const beforeContext = context ? contextHash(context) : null;
    if (await check(entry.transaction.backup, context, program.root) !== true) return false;
    if (context) {
      const fresh = await d.getBoundaryContext();
      if (!fresh || contextHash(fresh) !== beforeContext) return false;
      const inspect = require('./maintenance-repair-inspect.cjs');
      if (await inspect.configurationFingerprint(fresh.config, fresh.runtime, fresh.root) !==
          await inspect.configurationFingerprint(context.config, context.runtime, context.root)) return false;
    }
    const afterGit = await d.gitState();
    if (afterGit?.clean !== true || afterGit.sourceMatchesHead !== true) return false;
    if (await tx.fileHash(d.receipt) !== currentReceipt) return false;
    for (const configured of d.programs) {
      if (configured.name !== program.name && await tx.treeHash(configured.root) !== entry.beforeWorld[configured.name].hash) return false;
    }
    return true;
  } catch { return false; }
}

module.exports = { WINDOW_MS, paths, validateState, pending, recoveryGuard, receiptBoundaryGuard, canUpgrade, registerUpgrade, confirmUpgrade, reconcile, processRuntime };
