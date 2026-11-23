'use strict';
// 自动维护入口。每次先在锁内处理未完成事务，再判断版本检查是否到期。
// 正式验收范围仍由 refresh 工具决定；维护器不接受新的隔离边界变化。
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), cp = require('node:child_process'), http = require('node:http'), crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const tx = require('./maintenance-transaction.cjs');
const policy = require('./maintenance-policy.cjs');
const acquisition = require('./maintenance-acquisition.cjs'), download = require('./maintenance-download.cjs');
const repairModule = require('./maintenance-repair.cjs');
const runtimeMonitor = require('./maintenance-runtime.cjs'), dispatch = require('./maintenance-dispatch.cjs');
const deployment = require('./maintenance-deploy.cjs'), inspect = require('./maintenance-inspect.cjs');
const root = path.resolve(__dirname, '..'), dir = path.join(root, 'data', 'maintenance');
const LOCK = path.join(dir, 'running.lock'), STATE = path.join(dir, 'version-check.json'), NOTICE = path.join(dir, 'notice.txt'), LOG = path.join(root, 'logs', 'maintenance.log');
const CHECK_EVERY = policy.VERSION_INTERVAL_MS, IDLE_MINUTES = 15;
// 原计划任务两小时终止。正常工作最多100分钟，给恢复再留10分钟，不改真实计划任务。
const RUN_BUDGET_MS = 100 * 60e3, RECOVERY_BUDGET_MS = 10 * 60e3;
const appendLog = require('./maintenance-retention.cjs').boundedLogger(LOG);
const log = m => { console.log(m); return appendLog(m).catch(() => {}); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const parseVersion = s => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s)); return m ? m.slice(1).map(Number) : null; };
const isNewer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
const label = v => v ? v.join('.') : '未知';
// 自动维护（查新版、下载候选、候选验收、交换固定副本）只管这里列的程序。2026-11-23 GPT 退出平台后只剩 Claude：
// Codex 固定副本原样留着（isolation/index.js 启动时要求它在，验收指纹照旧核对它没被改动），但不再查新版、不再下载、不再尝试升级。
// 写死在这里，不看 d.programs：d.programs 里仍有 Codex，因为运行监测的升级链（runtime-upgrades.json）和中断事务的恢复按那份程序集合核对，
// 拿掉它，已有的记录会全部判成无效，自动维护就停在「退回暂未执行」。
const UPGRADABLE_PROGRAMS = Object.freeze(['Claude']);
const upgradable = name => UPGRADABLE_PROGRAMS.includes(name);
// 提示和日志里的时间一律用北京时间（机主在国内看），精确到分钟；同一事件每次生成的文字都一样
const bjTime = ms => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return p.month + '月' + p.day + '日 ' + p.hour + ':' + p.minute; };
function budget(d) {
  const now = (d.budgetNow || (() => performance.now()))();
  if (!d.budget) d.budget = { started: now, limit: d.runBudgetMs ?? RUN_BUDGET_MS, recovery: d.recoveryBudgetMs ?? RECOVERY_BUDGET_MS };
  return Math.max(0, d.budget.started + d.budget.limit + (d.cleanupMode ? d.budget.recovery : 0) - now);
}
async function runCommand(exe, args, options = {}) {
  if (!(options.timeoutMs > 0)) return { ok: false, status: null, budgetExceeded: true, out: '维护运行预算已用完' };
  return new Promise(resolve => {
    let out = '', settled = false, timedOut = false;
    const child = cp.spawn(exe, args, { cwd: options.cwd || root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env || process.env });
    const finish = status => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: status === 0 && !timedOut, status, timedOut, out }); };
    const collect = bytes => { out += bytes.toString('utf8'); if (out.length > 64e6) { out = out.slice(-64e6); timedOut = true; child.kill(); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; out += '\n维护子进程超时'; child.kill(); child.stdout.destroy(); child.stderr.destroy(); finish(null); }, options.timeoutMs);
    child.once('error', error => { out += '\n' + error.message; finish(null); }); child.once('close', finish);
  });
}
const node = (args, timeout = 45 * 60e3) => runCommand(process.execPath, args, { timeoutMs: timeout });
const port = () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).port || 8765;
const localGet = p => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: port(), path: p, timeout: 5000 }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
});
const localPost = (p, value) => new Promise(resolve => {
  const body = JSON.stringify(value); let finished = false;
  const done = result => { if (!finished) { finished = true; resolve(result); } };
  const req = http.request({ host: '127.0.0.1', port: port(), path: p, method: 'POST', timeout: 5000,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    let text = '', size = 0; res.on('data', bytes => { size += bytes.length; if (size > 4096) { req.destroy(); done(null); } else text += bytes.toString('utf8'); });
    res.on('end', () => { try { done(res.statusCode === 200 ? JSON.parse(text) : null); } catch { done(null); } });
    res.on('error', () => done(null));
  });
  req.on('error', () => done(null)); req.on('timeout', () => { req.destroy(); done(null); }); req.end(body);
});
function realDeps() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(config.isolation.runtimeManifest, 'utf8'));
  const d = {
    programs: [
      { name: 'Claude', exe: manifest.claudePath, signer: 'Anthropic, PBC',
        exeIn: base => base, signedIn: base => [base], root: manifest.claudePath, sourceRoot: exe => exe },
      // Codex 只留作运行监测和旧事务恢复时核对用；versionCheck 只处理 UPGRADABLE_PROGRAMS（Claude），不会查它的新版或升级它
      { name: 'Codex', exe: manifest.codexPath, signer: 'OpenAI OpCo, LLC',
        exeIn: base => path.join(base, 'bin', 'codex.exe'),
        signedIn: base => ['bin/codex.exe','bin/codex-exec-server.exe','codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe'].map(file => path.join(base, file)),
        root: path.dirname(path.dirname(manifest.codexPath)), sourceRoot: async exe => path.dirname(path.dirname(await fsp.realpath(exe))) },
    ],
    receipt: config.isolation.receipt || path.join(root, 'data', 'isolation', 'acceptance.json'),
    state: STATE, notice: NOTICE, lock: LOCK, root, runtimeMonitoring: true,
    sourcePath: path.join(root, 'server.js'), lastGoodDir: path.join(dir, 'last-good'), transactionsDir: path.join(dir, 'transactions'),
    stoppedByOwner: () => fs.existsSync(path.join(root, 'data', 'stopped-by-owner')),
    power: async () => { const r = await localGet('/local/power'); try { return JSON.parse(r.body); } catch { return null; } },
    waitMs: 2000, idleTimeoutMs: 30 * 60e3, now: () => Date.now(),
  };
  const drainClient = require('./maintenance-drain-client.cjs').createClient({ request: body => localPost('/local/maintenance', body) });
  d.beginDrain = drainClient.begin; d.drainIdle = drainClient.idle; d.endDrain = drainClient.end;
  d.remainingBudget = () => budget(d);
  // Gemini 的固定程序会被它自带的更新程序换掉，见 pinned-programs.cjs
  d.restorePinned = () => require('./pinned-programs.cjs').restore({ root, config, log });
  const mail = require('./maintenance-mail-config.cjs').createMaintenanceMail({ root, remainingBudget: d.remainingBudget, log });
  d.notify = mail.notify; d.retryNotifications = mail.retry;
  const run = (exe, args, timeoutMs, env) => runCommand(exe, args, { timeoutMs: Math.min(timeoutMs, budget(d)), env });
  const runNode = (args, timeoutMs = 45 * 60e3) => run(process.execPath, args, timeoutMs);
  const downloadRoots = new Set();
  d.discover = program => download.discover(program.name, { remainingBudget: d.remainingBudget });
  d.prepareCandidate = async (program, version) => {
    const destination = path.join(dir, 'candidates', crypto.randomBytes(16).toString('hex'));
    downloadRoots.add(destination);
    return download.prepareCandidate(program.name, destination, { version: label(version), signedBy: d.signedBy, remainingBudget: d.remainingBudget });
  };
  d.cleanupMaintenance = () => require('./maintenance-retention.cjs').cleanup({ receipt: d.receipt, maintenanceDir: dir, runtimeContext: d, maintenanceLockHeld: true, activeDownloads: downloadRoots.size });
  d.releaseDownloads = async () => {
    for (const destination of downloadRoots) { await tx.safeRemove(destination, [destination]); downloadRoots.delete(destination); }
  };
  d.version = async exe => { const result = await run(exe, ['--version'], 60e3); return result.ok ? parseVersion(result.out) : null; };
  d.signedBy = async (file, org) => {
    const script = '$s=Get-AuthenticodeSignature -LiteralPath $env:RELAY_SIGNED_FILE; if($s.Status -eq \'Valid\' -and $s.SignerCertificate.Subject -like (\'*O="\' + $env:RELAY_SIGNER + \'"*\')){exit 0}else{exit 1}';
    return (await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], 120e3, { ...process.env, RELAY_SIGNED_FILE: file, RELAY_SIGNER: org })).ok;
  };
  d.gateOk = async () => (await runNode(['tools/check-isolation.cjs'], 5 * 60e3)).ok;
  d.accept = async ({ outputReceipt, timeoutMs } = {}) => {
    const result = await runNode(['tools/refresh-isolation-receipt.cjs', ...(outputReceipt ? ['--output-receipt=' + outputReceipt] : [])], timeoutMs || 45 * 60e3);
    const summary = require('./maintenance-acceptance.cjs').parseResultOutput(result.out);
    return summary ? { ...result, ...summary, ok: result.ok && summary.ok } : result;
  };
  d.acceptCandidate = async ({ program, outputReceipt, timeoutMs }) => {
    const freshConfig = JSON.parse(await fsp.readFile(path.join(root, 'config.json'), 'utf8'));
    return require('./maintenance-candidate.cjs').preacceptCandidate({ root, config: freshConfig, receiptPath: d.receipt, program: program.name, outputReceipt, timeoutMs });
  };
  d.cleanupCandidate = transactionId => require('./maintenance-candidate.cjs').cleanupCandidateManifest({ root, config, transactionId });
  d.gitState = () => inspect.gitState(root);
  d.getBoundaryContext = async () => {
    const currentConfig = JSON.parse(await fsp.readFile(path.join(root, 'config.json'), 'utf8'));
    return { root, config: currentConfig, runtime: JSON.parse(await fsp.readFile(currentConfig.isolation.runtimeManifest, 'utf8')), gate: require('./check-isolation.cjs') };
  };
  d.validateProgramPaths = async program => {
    if (program.name !== 'Codex') return true;
    const context = await d.getBoundaryContext();
    const expected = context.runtime.codexPath;
    if (!path.isAbsolute(expected || '') || path.resolve(expected).toLowerCase() !== path.resolve(program.exe).toLowerCase() ||
        path.resolve(program.root).toLowerCase() !== path.dirname(path.dirname(path.resolve(expected))).toLowerCase() ||
        path.isAbsolute(context.config.codexPath || '') && path.resolve(context.config.codexPath).toLowerCase() !== path.resolve(expected).toLowerCase()) throw Error('Codex维护入口与当前配置不一致');
    await require('./maintenance-refresh-plan.cjs').assertPackageBoundaries({ ...context, receiptPath: d.receipt,
      packageRoots: [program.root, program.root + '.new', program.root + '.prev', program.root + '.failed'] });
    return true;
  };
  d.repairSnapshot = () => require('./maintenance-repair-inspect.cjs').inspectRepairState({ root, gate: require('./check-isolation.cjs') });
  d.preview = async () => {
    const result = await runNode(['tools/refresh-isolation-receipt.cjs', '--dry-run'], 5 * 60e3);
    return { ...result, changed: !result.out.includes('不需要重新验收') };
  };
  d.checkpointCompatible = async checkpoint => {
    try {
      const currentConfig = JSON.parse(await fsp.readFile(path.join(root, 'config.json'), 'utf8'));
      const currentRuntime = JSON.parse(await fsp.readFile(currentConfig.isolation.runtimeManifest, 'utf8'));
      return (await inspect.checkpointReport(checkpoint, { root, config: currentConfig, runtime: currentRuntime, gate: require('./check-isolation.cjs') })).ok === true;
    } catch { return false; }
  };
  d.serviceGone = async () => {
    let current;
    try { current = JSON.parse(await fsp.readFile(path.join(root, 'data', 'server.pid'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') return false; }
    return inspect.processesAbsent([d.lastPidRecord, current]);
  };
  d.restart = async () => {
    const pid = async () => {
      try {
        const value = JSON.parse(await fsp.readFile(path.join(root, 'data', 'server.pid'), 'utf8'));
        if (!value || ['pid', 'ppid', 'startedAt'].some(key => !Number.isSafeInteger(value[key]) || value[key] <= 0)) return null;
        return { pid: value.pid, ppid: value.ppid, startedAt: value.startedAt };
      } catch { return null; }
    };
    const changed = (before, after) => !!after && (!before ||
      before.pid !== after.pid || before.ppid !== after.ppid || before.startedAt !== after.startedAt);
    if (d.stoppedByOwner()) { log('机主已手动停止服务，未执行维护重启。'); return false; }
    const before = await pid();
    d.lastPidRecord = before;
    if (d.stoppedByOwner()) { log('读取进程记录期间出现手动停止，未执行维护重启。'); return false; }
    const first = await runNode(['control.js','auto-restart'], 5 * 60e3);
    if (first.ok) {
      const after = await pid();
      if (d.stoppedByOwner()) { log('重启期间出现手动停止，不继续维护启动。'); return false; }
      if (changed(before, after)) return true;
      log('重启命令返回成功，但没有新的有效进程身份，不能确认重启完成。');
      return false;
    }
    log('重启没有成功：\n' + String(first.out || '').slice(-1500));
    if (d.stoppedByOwner()) { log('重启期间出现手动停止，不执行自动补启动。'); return false; }
    log('尝试自动补启动服务。');
    const second = await runNode(['control.js','auto-start'], 5 * 60e3);
    if (!second.ok) { log('自动补启动也失败：\n' + String(second.out || '').slice(-1500)); return false; }
    const after = await pid();
    if (d.stoppedByOwner()) { log('自动补启动期间出现手动停止，不能确认维护重启完成。'); return false; }
    if (changed(before, after)) return true;
    log('自动补启动命令返回成功，但没有新的有效进程身份，不能确认重启完成。');
    return false;
  };
  d.serving = async () => { for (let i = 0; i < 15 && budget(d) > 0; i++) { const r = await localGet('/'); if (r?.status === 200) return true; await sleep(Math.min(2000, budget(d))); } return false; };
  return d;
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
async function notifyEvent(d, event) { if (d.notify) { try { await d.notify(event); } catch { (d.log || log)('主动通知未完成，维护继续；网页提示保留。'); } } }
async function notifyBlocked(d) {
  let issueFingerprint;
  try { const snapshot = await d.repairSnapshot?.(); if (/^[a-f0-9]{64}$/.test(snapshot?.fingerprint || '')) issueFingerprint = snapshot.fingerprint; } catch {}
  // 读不到文件状态时按天区分，否则第一次之后同类故障再也不会发邮件。
  issueFingerprint ||= issueDigest(['blocked-unreadable', new Date((d.now || Date.now)()).toISOString().slice(0, 10)]);
  await notifyEvent(d, { type: 'isolation-blocked', program: 'runtime', version: 'unknown', reason: 'fingerprint-mismatch', issueFingerprint });
}
const issueDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// 部署和修复没有版本号：按结果和提交区分，同一提交不重复，新提交再失败仍会通知。
async function notifyRelay(d, type, reason, result) {
  let head = '';
  try { head = (await d.gitState?.())?.head || ''; } catch {}
  await notifyEvent(d, { type, program: 'relay', version: 'unknown', reason, issueFingerprint: issueDigest(['relay', result, head]) });
}
async function setNotice(d, text) {
  await fsp.mkdir(path.dirname(d.notice), { recursive: true });
  if (text) await tx.atomicWrite(d.notice, text); else await fsp.rm(d.notice, { force: true });
}
async function record(d, result, extra = {}) {
  await fsp.mkdir(path.dirname(d.state), { recursive: true });
  await tx.atomicWrite(d.state, JSON.stringify({ ...readJson(d.state), lastCheckAt: d.now(), lastVersionCheckAt: d.now(), result, ...extra }, null, 2));
  (d.log || log)('版本校验：' + result + (extra.detail ? '（' + extra.detail + '）' : ''));
  return result;
}
async function waitNoJobs(d, options = {}) {
  if (d.stoppedByOwner()) return false;
  if (d.beginDrain && !await d.beginDrain()) return options.allowStopped === true && d.serviceGone && await d.serviceGone() === true;
  for (const end = d.now() + d.idleTimeoutMs; d.now() < end && budget(d) > 0; await sleep(Math.min(d.waitMs, budget(d)))) {
    if (d.stoppedByOwner()) return false;
    const power = await d.power(); if (power && power.running === 0 && (!d.beginDrain || power.draining === true)) return true;
    if (!power && options.allowStopped === true && d.serviceGone && await d.serviceGone() === true) return true;
  }
  return false;
}
const restartAndVerify = async d => {
  if (d.stoppedByOwner()) return false;
  if (d.drainIdle && !await d.drainIdle() && (!d.serviceGone || !await d.serviceGone())) return false;
  return !d.stoppedByOwner() && await d.restart() && await d.serving() && await d.gateOk();
};
async function rollback(d, result, why, extra = {}) {
  d.cleanupMode = true;
  const restored = await tx.recover(d, { own: true });
  d.cleanupMode = false;
  if (restored.fatal) return { result: 'rollback-failed', fatal: true, why: why + '；' + restored.why, ...extra };
  return { result, why, ...extra };
}
function runtimeDeps(d) {
  return { ...d, runtimeNotice: message => setNotice(d, message), waitNoJobs: options => waitNoJobs(d, options), restartAndVerify: () => restartAndVerify(d) };
}
async function commitUpgrade(d, transaction, latest) {
  if (d.runtimeMonitoring) await runtimeMonitor.registerUpgrade(transaction, label(latest), runtimeDeps(d));
  await tx.finish(d, transaction);
  if (d.runtimeMonitoring) {
    const confirmation = await runtimeMonitor.confirmUpgrade(transaction.id, runtimeDeps(d));
    if (confirmation.status !== 'monitoring') return { monitorPending: true, notice: '程序升级已提交，但运行监测记录尚待核对；请机主查看维护提示。' };
  }
  return {};
}
async function upgradeOne(program, latest, d) {
  // 不再维护的程序（GPT 退出平台后的 Codex）一律不动：versionCheck 已经不会走到这里，这里再挡一道
  if (!upgradable(program?.name)) return { result: 'program-retired', why: (program?.name || '这个程序') + ' 已不再自动升级；未改动文件', unchanged: true, recordVersionFailure: false };
  if (d.runtimeMonitoring) {
    const permission = await runtimeMonitor.canUpgrade(program, runtimeDeps(d));
    if (!permission.allowed) return { result: permission.reason, deferred: true, notice: program.name + ' 的回退证据仍需保留或状态待核对，暂不开始另一轮升级。' };
  }
  const candidate = program.root + '.new';
  if (budget(d) <= 0) return { result: 'budget-exhausted', why: '运行预算已用完，未开始交换' };
  if (d.validateProgramPaths) {
    try { if (await d.validateProgramPaths(program) !== true) throw Error(); }
    catch { return { result: 'boundary-refused', why: '程序维护路径与独立运行组件重叠或无法确认；未改动文件', unchanged: true, recordVersionFailure: false }; }
  }
  await tx.safeRemove(candidate, [candidate]);
  await tx.physical(path.dirname(candidate));
  await fsp.cp(await program.sourceRoot(program.source), candidate, { recursive: true, dereference: true });
  for (const file of program.signedIn(candidate)) if (!await d.signedBy(file, program.signer)) {
    await tx.safeRemove(candidate, [candidate]); return { result: 'bad-signature', why: '新版本的 ' + program.signer + ' 签名核对不通过' };
  }
  if (label(await d.version(program.exeIn(candidate))) !== label(latest)) {
    await tx.safeRemove(candidate, [candidate]); return { result: 'copy-mismatch', why: '复制出来的版本号不对' };
  }
  if (budget(d) <= 0) { await tx.safeRemove(candidate, [candidate]); return { result: 'budget-exhausted', why: '运行预算已用完，未开始交换' }; }
  const transaction = await tx.begin(d, program, candidate, label(await d.version(program.exe)));
  try {
    await tx.writeJournal(d, transaction, 'accepting');
    const accepted = await (d.acceptCandidate || d.accept)({ program, outputReceipt: transaction.outputReceipt, timeoutMs: Math.min(45 * 60e3, budget(d)) });
    if (!accepted.ok) return await rollback(d, accepted.timedOut && budget(d) <= 0 ? 'budget-exhausted' : 'acceptance-failed', '新版本没有通过验收', { tail: String(accepted.out || '').slice(-1500), recordVersionFailure: accepted.recordVersionFailure, interrupted: accepted.interrupted, failureKind: accepted.failureKind });
    await tx.writeJournal(d, transaction, 'accepted');
    await tx.writeJournal(d, transaction, 'waiting-idle');
    if (!await waitNoJobs(d)) return await rollback(d, d.stoppedByOwner() ? 'stopped-by-owner' : 'upgrade-deferred', '当前仍有任务或排空状态不可确认，未替换程序，稍后再试', { deferred: true });
    await tx.swapIn(d, program, transaction);
    await tx.installReceipt(d, transaction);
    if (!await d.gateOk()) return await rollback(d, 'acceptance-failed', '候选记录安装后核对不通过');
    await tx.writeJournal(d, transaction, 'restarting');
    if (!await restartAndVerify(d)) {
      const restored = await rollback(d, 'restart-failed', '换上新版本后服务没有正常启动');
      if (restored.fatal || d.stoppedByOwner()) return restored;
      d.cleanupMode = true; const back = await restartAndVerify(d); d.cleanupMode = false;
      return { ...restored, result: back ? 'restart-failed' : 'restart-and-rollback-failed', fatal: !back };
    }
    return { result: 'upgraded', ...await commitUpgrade(d, transaction, latest) };
  } catch (error) { return await rollback(d, budget(d) <= 0 ? 'budget-exhausted' : 'upgrade-failed', '升级过程出错：' + error.message, { recordVersionFailure: false }); } finally { if (d.endDrain) await d.endDrain(); }
}
async function versionCheck(opts, d) {
  budget(d);
  if (!policy.versionCheckDue(readJson(d.state), d.now(), opts.force)) return 'not-due';
  if (d.stoppedByOwner()) return 'stopped-by-owner';
  const power = await d.power(); if (!power) return 'service-down';
  if (!opts.force && (power.running > 0 || power.idleMinutes < IDLE_MINUTES)) return 'busy';
  const found = [];
  for (const program of d.programs.filter(item => upgradable(item.name))) {
    if (budget(d) <= 0) return 'budget-exhausted';
    found.push(await acquisition.scan(program, d));
  }
  const acquisitionNotes = [];
  for (const f of found) {
    if (f.acquisitionError) {
      const counted = await acquisition.recordOutcome(d, f.p, false, f.acquisitionError);
      if (counted.notified) acquisitionNotes.push(f.p.name + ' 连续获取或读取版本失败，请机主检查官方下载和本机运行环境。');
    } else if (!isNewer(f.latest, f.pinned)) await acquisition.recordOutcome(d, f.p, true);
  }
  const versions = Object.fromEntries(found.map(f => [f.p.name, { pinned: label(f.pinned), latest: label(f.latest), updated: f.updated }]));
  const unreadable = found.filter(f => !f.pinned || !f.latest).map(f => f.p.name), gate = await d.gateOk();
  if (!gate) await notifyBlocked(d);
  const drift = '验收记录和电脑上的文件对不上（可能是运行环境更新了）。服务下次重启会进入受限模式，请处理。详情见 logs\\maintenance.log。';
  const newer = found.filter(f => f.pinned && f.latest && isNewer(f.latest, f.pinned));
  const unreadableNote = [unreadable.length ? '读不到 ' + unreadable.join('、') + ' 的版本号，这次没有检查它。' : '', ...acquisitionNotes].filter(Boolean).join(' ');
  if (!newer.length) { await setNotice(d, gate ? unreadableNote : drift); return record(d, !gate ? 'gate-drift' : unreadable.length ? 'version-unreadable' : 'up-to-date', { versions }); }
  if (opts.checkOnly) return record(d, 'newer-available', { versions });
  if (!gate) { await setNotice(d, newer.map(f => f.p.name + ' ' + label(f.latest)).join('、') + ' 已发布，但没有自动升级：' + drift); return record(d, 'gate-drift', { versions }); }
  const notes = unreadable.length ? [unreadableNote] : [], results = [];
  for (const f of newer) {
    const permission = policy.canAttemptVersion(readJson(d.state), f.p.name, label(f.latest), d.now());
    if (!permission.allowed) {
      versions[f.p.name].result = permission.reason;
      if (permission.retryAt) versions[f.p.name].retryAt = permission.retryAt;
      results.push(permission.reason);
      // 暂缓不需要机主处理：只写日志，不挂首页横幅（失败当时已经提示过、发过邮件）
      (d.log || log)(f.p.name + ' ' + label(f.latest) + ' 暂缓：' + (permission.reason === 'failed-twice' ? '已两次失败，等待更新版本' : '冷却中，' + bjTime(permission.retryAt) + ' 后可再试'));
      continue;
    }
    if (d.runtimeMonitoring) {
      const monitoring = await runtimeMonitor.canUpgrade(f.p, runtimeDeps(d));
      if (!monitoring.allowed) {
        results.push(monitoring.reason); versions[f.p.name].result = monitoring.reason;
        notes.push(f.p.name + ' 仍在升级观察期或回退记录待核对，保留上一版本，暂不下载另一候选。');
        continue;
      }
    }
    const prepared = await acquisition.prepare(f.p, f.latest, d);
    if (!prepared.ok) {
      const counted = await acquisition.recordOutcome(d, f.p, false, prepared.reason);
      versions[f.p.name].result = prepared.reason; results.push(prepared.reason);
      if (counted.notified) notes.push(f.p.name + ' 连续获取候选或读取版本失败，请机主检查下载和运行环境。');
      continue;
    }
    await acquisition.recordOutcome(d, f.p, true);
    const result = await upgradeOne(prepared.program, f.latest, d);
    let history = readJson(d.state);
    if (['upgraded', 'upgraded-restart-pending'].includes(result.result)) history = policy.recordVersionSuccess(history, f.p.name, label(f.latest), d.now());
    else if (!['stopped-by-owner', 'budget-exhausted', 'interrupted', 'sleep', 'cancelled'].includes(result.result) && !result.interrupted && !result.deferred && result.recordVersionFailure !== false) {
      history = policy.recordVersionFailure(history, f.p.name, label(f.latest), d.now(), { kind: result.failureKind?.kind || result.failureKind || result.result });
    } else if (result.result === 'acceptance-failed' && !result.interrupted && !result.deferred && !['auth', 'quota', 'cancelled', 'user-file'].includes(result.failureKind?.kind)) {
      history = policy.recordVersionInconclusive(history, f.p.name, label(f.latest), d.now(), { kind: result.failureKind?.kind });
    }
    await fsp.mkdir(path.dirname(d.state), { recursive: true });
    await tx.atomicWrite(d.state, JSON.stringify(history, null, 2));
    results.push(result.result); versions[f.p.name].result = result.result;
    (d.log || log)(f.p.name + ' ' + label(f.pinned) + ' → ' + label(f.latest) + '：' + result.result + (result.why ? '（' + result.why + '）' : '') + (result.tail ? '\n' + result.tail : ''));
    if (!['upgraded','upgraded-restart-pending','stopped-by-owner','budget-exhausted','interrupted'].includes(result.result) && !result.deferred && !result.interrupted) {
      const reason = /restart/.test(result.result) ? 'restart-failed' : result.result === 'acceptance-failed' ? 'acceptance-failed' : 'unknown';
      await notifyEvent(d, { type: 'upgrade-failed', program: f.p.name.toLowerCase(), version: label(f.latest), reason });
    }
    if (result.notice) notes.push(result.notice);
    if (result.why) notes.push(f.p.name + ' ' + label(f.latest) + ' 自动升级没有成功（' + bjTime(d.now()) + '），' + (result.fatal ? '自动恢复未完成' : result.unchanged ? '保留 ' + label(f.pinned) : '已退回 ' + label(f.pinned)) + '。原因：' + result.why + '。详情见 logs\\maintenance.log。');
    if (result.fatal || budget(d) <= 0) break;
  }
  await setNotice(d, notes.join(' ')); return record(d, results.join(','), { versions, pendingUpgrade: results.includes('upgrade-deferred') });
}
// 只读：给机主看版本检查的状态。不加锁、不写文件、不联网。
async function status(d) {
  const state = readJson(d.state), now = d.now(), lines = [];
  lines.push('上次版本检查：' + (state.lastVersionCheckAt ? bjTime(state.lastVersionCheckAt) + '，结果 ' + (state.result || '未知') : '还没有'));
  // 不再维护的程序（Codex）留在数据文件里的旧记录照样留着，只是不显示：它不会再被查新版或重试，显示出来只会让人以为还在等它
  const shown = key => upgradable(String(key).split('@')[0]);
  for (const [name, v] of Object.entries(state.versions || {})) if (upgradable(name)) lines.push(name + '：检查时 ' + v.pinned + '，官方最新 ' + v.latest + (v.result ? '，结果 ' + v.result : ''));
  const paused = [];
  for (const [key, e] of Object.entries(state.failedVersions || {})) {
    if (!shown(key)) continue;
    const at = Number(e.lastFailedAt) + policy.FAILURE_COOLDOWN_MS;
    paused.push(key.replace('@', ' ') + '：' + (e.failures >= 2 ? '已两次失败，不再自动尝试' : '失败 1 次，' + (at > now ? bjTime(at) + ' 后可再试' : '已可再试')));
  }
  for (const [key, e] of Object.entries(state.inconclusiveVersions || {})) {
    if (state.failedVersions?.[key] || !shown(key)) continue;
    const at = Number(e.lastAt) + policy.FAILURE_COOLDOWN_MS;
    if (at > now) paused.push(key.replace('@', ' ') + '：原因不明的失败，只冷却不计次，' + bjTime(at) + ' 后可再试');
  }
  lines.push(paused.length ? '暂缓的版本：\n  ' + paused.join('\n  ') : '暂缓的版本：无');
  let notice = ''; try { notice = (await fsp.readFile(d.notice, 'utf8')).trim(); } catch {}
  lines.push('当前提示：' + (notice || '无'));
  return lines.join('\n');
}
const healthDue = d => d.now() - (readJson(d.state).lastHealthCheckAt || 0) >= 3600000;
const HEALTH_DRIFT = '验收记录与电脑上的文件不一致，模型和文件操作可能受限。请机主检查维护记录；不会自动接受运行环境变化。';
// 每小时只核对指纹；不会查新版、验收、启动模型或重启。
async function health(opts, d) {
  let ready = false;
  try { ready = await d.gateOk() === true; } catch { /* 读取失败同样通知，不能视作正常。 */ }
  const state = readJson(d.state), result = ready ? 'healthy' : 'gate-drift';
  await fsp.mkdir(path.dirname(d.state), { recursive: true });
  await tx.atomicWrite(d.state, JSON.stringify({ ...state, lastHealthCheckAt: d.now(), healthResult: result }, null, 2));
  if (!ready) await notifyBlocked(d);
  if (!ready) await setNotice(d, HEALTH_DRIFT);
  else if (d.notice) {
    // 只清这条核对提示；其他维护提示留到各自的流程处理。
    let current = null;
    try { current = await fsp.readFile(d.notice, 'utf8'); } catch {}
    if (current === HEALTH_DRIFT) await setNotice(d, '');
  }
  (d.log || log)('运行文件核对：' + result);
  return result;
}
// 部署只使用已提交源码；验收失败提示磁盘风险，重启失败恢复配套快照。
async function deploy(opts, d) {
  const result = await deployment.deploy(opts, { ...d,
    log: d.log || log,
    notice: message => setNotice(d, message),
    waitNoJobs: options => waitNoJobs(d, options),
    restartAndVerify: () => restartAndVerify(d),
  });
  if (result === 'restart-failed-restored') await notifyRelay(d, 'rolled-back', 'restart-failed', result);
  else if (/failed|refused|incompatible/.test(result)) await notifyRelay(d, 'upgrade-failed', /restart/.test(result) ? 'restart-failed' : 'acceptance-failed', result);
  return result;
}
async function repair(opts, d) {
  const result = await repairModule.repair(opts, { ...d, log: d.log || log, notice: message => setNotice(d, message),
    waitNoJobs: options => waitNoJobs(d, options), restartAndVerify: () => restartAndVerify(d) });
  if (result === 'restart-failed-restored') await notifyRelay(d, 'rolled-back', 'restart-failed', result);
  else if (/failed/.test(result)) await notifyRelay(d, 'upgrade-failed', /restart/.test(result) ? 'restart-failed' : 'acceptance-failed', result);
  else if (/refused|already-attempted/.test(result)) await notifyBlocked(d);
  else if (['deployed', 'repair-restarted'].includes(result) && d.notice) await setNotice(d, '');
  return result;
}
async function scheduled(opts, d) {
  const serviceRoot = d.root || path.dirname(d.state), request = await dispatch.readRequest(serviceRoot);
  if (request) {
    const result = await repair(opts, d);
    await dispatch.completeRequest(serviceRoot, request);
    return result;
  }
  if (healthDue(d)) await health(opts, d);
  return versionCheck(opts, d);
}
async function runMaintenance(cmd, opts, d) {
  budget(d);
  let lease;
  try { lease = await tx.acquireLock(d); } catch (error) { await setNotice(d, '维护锁无法安全接管：' + error.message); return 'recovery-refused'; }
  if (!lease) return 'maintenance-busy';
  try {
    if (d.restorePinned) { try { await d.restorePinned(); } catch (error) { (d.log || log)('固定程序自动恢复未完成：' + (error.code || error.message)); } }
    if (d.runtimeMonitoring || d.validateProgramPaths) d.recoveryGuard = async (transaction, program) => {
      try { if (d.validateProgramPaths && await d.validateProgramPaths(program) !== true) return false;
        return !d.runtimeMonitoring || await runtimeMonitor.recoveryGuard(transaction, program, runtimeDeps(d));
      } catch { return false; }
    };
    let interruptedTransaction;
    if (d.cleanupCandidate) { try { interruptedTransaction = (await tx.readJournal(d))?.tx; } catch { /* recover统一报告损坏日志。 */ } }
    const recovery = await tx.recover(d);
    if (recovery.fatal) { await setNotice(d, '升级中断后未能自动恢复：' + recovery.why); await notifyBlocked(d); return recovery.result; }
    if (interruptedTransaction && ['recovered', 'completed-cleanup'].includes(recovery.result)) await d.cleanupCandidate(interruptedTransaction.id);
    if (d.retryNotifications) await d.retryNotifications();
    if (d.runtimeMonitoring) {
      // 运行回退卡住时不验收、不升级、不修复；但小时核对只读，不能跟着一起停。
      const halted = async status => {
        if (cmd === 'health' || cmd === 'scheduled' && healthDue(d)) await health(opts, d);
        return 'runtime-' + status;
      };
      const reconciled = await runtimeMonitor.reconcile(runtimeDeps(d));
      if (!['ok', 'confirmed', 'discarded-rolled-back-registration'].includes(reconciled.status)) return await halted(reconciled.status);
      if (await runtimeMonitor.pending(runtimeDeps(d))) {
        const runtimeResult = await runtimeMonitor.processRuntime(runtimeDeps(d));
        if (runtimeResult.status !== 'idle') return await halted(runtimeResult.status);
      }
    }
    if (recovery.result === 'recovered') { await notifyEvent(d, { type: 'rolled-back', program: recovery.program?.toLowerCase() || 'relay', version: 'unknown', reason: 'interrupted', ...(interruptedTransaction ? { issueFingerprint: crypto.createHash('sha256').update(interruptedTransaction.id).digest('hex') } : {}) }); await setNotice(d, recovery.program + ' 的未完成升级已退回 ' + recovery.oldVersion + '；原手动停止状态保持不变。'); return 'recovered'; }
    if (cmd === 'runtime-check') return 'runtime-idle';
    if (cmd === 'scheduled') return await scheduled(opts, d);
    return cmd === 'deploy' ? await deploy(opts, d) : cmd === 'health' ? await health(opts, d) : cmd === 'repair' ? await repair(opts, d) : await versionCheck(opts, d);
  } finally {
    try { if (d.endDrain) await d.endDrain(); }
    finally {
      try { if (d.releaseDownloads) await d.releaseDownloads(); }
      finally {
        try { if (d.cleanupMaintenance) await d.cleanupMaintenance(); }
        catch { await (d.log || log)('维护清理未完成，已保留不能安全确认的备份和证据。'); }
        finally { await tx.releaseLock(lease); }
      }
    }
  }
}
async function runWindowsMutex(args) {
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  const name = 'Global\\ClaudeRelayMaintenance-' + crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24);
  const script = "$ErrorActionPreference='Stop'\n$mutex=[Threading.Mutex]::new($false," + quote(name) + ")\n$held=$false\ntry {\n try {$held=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$held=$true}\n if (!$held) {Write-Output '另一个维护任务正在运行';exit 0}\n & " + quote(process.execPath) + ' ' + quote(__filename) + ' ' + args.map(quote).join(' ') + " '--maintenance-lock-held'\n exit $LASTEXITCODE\n} finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}";
  const result = await runCommand('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], { timeoutMs: RUN_BUDGET_MS + RECOVERY_BUDGET_MS + 60e3 });
  process.stdout.write(result.out); process.exitCode = result.ok ? 0 : 1;
}
if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'status') { console.log(await status({ state: STATE, notice: NOTICE, now: Date.now })); return; } // 只读：不读配置、不加锁
    if (!['deploy','version-check','health','repair','runtime-check','scheduled'].includes(cmd)) { console.error('用法：node tools/maintain.cjs status | deploy [--restart] | health | repair | runtime-check | scheduled | version-check [--force] [--check-only]'); process.exitCode = 2; return; }
    if (process.platform === 'win32' && !rest.includes('--maintenance-lock-held')) return runWindowsMutex(process.argv.slice(2));
    const result = await runMaintenance(cmd, { force: rest.includes('--force'), checkOnly: rest.includes('--check-only'), restart: rest.includes('--restart') }, realDeps());
    console.log('结果：' + result);
    if (/failed|refused/.test(result) || (cmd === 'deploy' && !['deployed','nothing-to-do','recovered','maintenance-busy'].includes(result))) process.exitCode = 1;
  })().catch(error => { log('维护工具出错：' + (error.stack || error)); process.exitCode = 1; });
}
module.exports = { UPGRADABLE_PROGRAMS, status, bjTime, notifyEvent, notifyBlocked, notifyRelay, scheduled, runtimeDeps, repair, health, versionCheck, deploy, upgradeOne, runMaintenance, realDeps, runCommand, budget, setNotice, record, waitNoJobs, restartAndVerify, isNewer, parseVersion, CHECK_EVERY, IDLE_MINUTES, RUN_BUDGET_MS, RECOVERY_BUDGET_MS };
