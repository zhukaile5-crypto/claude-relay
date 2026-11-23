'use strict';
// 重试只依据 harness 明确给出的阶段和类别，不解析模型文本或整份日志。
const { performance } = require('node:perf_hooks');
const fs = require('node:fs/promises'), path = require('node:path'), cp = require('node:child_process');
const tx = require('./maintenance-transaction.cjs');
const MAX_ATTEMPTS = 2, DEFAULT_GAP_MS = 30000;
const defaultClock = () => ({ wallMs: Date.now(), monotonicMs: performance.now() });
function classifyResult(result, { kind = 'e2e', interruption = null } = {}) {
  if (interruption) return { category: 'interrupted', retryable: false, recordVersionFailure: false, reason: interruption };
  if (result?.ok === true && !result.failure && !result.failureKind) return { category: 'passed', retryable: false, recordVersionFailure: false };
  if (kind !== 'e2e') return { category: 'regression', retryable: false, recordVersionFailure: false };
  const failure = result?.failureKind;
  if (!failure || typeof failure !== 'object') return { category: result?.timedOut ? 'unclassified-timeout' : 'unknown', retryable: false, recordVersionFailure: false };
  if (failure.stage === 'interruption' || ['sleep', 'host-interrupted'].includes(failure.kind)) return { category: 'interrupted', retryable: false, recordVersionFailure: false, reason: failure.kind };
  if (failure.stage === 'boundary' || failure.kind === 'boundary') return { category: 'boundary', retryable: false, recordVersionFailure: false };
  if (failure.stage !== 'model') return { category: 'infrastructure', retryable: false, recordVersionFailure: false };
  if (['auth', 'quota', 'cancelled', 'user-file'].includes(failure.kind)) return { category: failure.kind, retryable: false, recordVersionFailure: false };
  const knownProvider = ['claude', 'gpt'].includes(failure.provider);
  const explicitSource = failure.source === 'model-result' || failure.source === 'harness-model-wait' && failure.kind === 'model-timeout';
  const retryable = knownProvider && explicitSource && ['model-timeout', 'model-network'].includes(failure.kind);
  const knownFailure = ['model-timeout','model-network','model-start','model-protocol','model-no-output'].includes(failure.kind);
  return { category: failure.kind || 'unknown', retryable, recordVersionFailure: knownProvider && explicitSource && knownFailure };
}
function createInterruptionMonitor({ clock = defaultClock, sampleIntervalMs = 1000, gapLimitMs = DEFAULT_GAP_MS } = {}) {
  let previous, interruption = null;
  const sample = () => {
    let current;
    try { current = clock(); } catch { interruption ||= 'clock-unavailable'; return; }
    if (!Number.isFinite(current?.wallMs) || !Number.isFinite(current?.monotonicMs)) { interruption ||= 'clock-unavailable'; return; }
    if (previous) {
      const wall = current.wallMs - previous.wallMs, monotonic = current.monotonicMs - previous.monotonicMs;
      if (wall < 0 || monotonic < 0 || Math.abs(wall - monotonic) > gapLimitMs) interruption ||= 'clock-discontinuity';
      // Windows 单调钟可能包含睡眠时间；长采样间隙同样按不确定中断处理。
      else if (wall > gapLimitMs || monotonic > gapLimitMs) interruption ||= 'execution-gap';
    }
    previous = current;
  };
  sample();
  const timer = setInterval(sample, Math.max(10, sampleIntervalMs)); timer.unref?.();
  return { check() { sample(); return interruption; }, finish() { clearInterval(timer); sample(); return interruption; } };
}
async function hostState(readHostState) {
  if (!readHostState) return { sleeping: false };
  try {
    const state = await readHostState();
    if (!state || typeof state.sleeping !== 'boolean') return { unavailable: true };
    return state;
  } catch { return { unavailable: true }; }
}
function hostInterruption(before, after) {
  if (before.unavailable || after.unavailable) return 'host-state-unavailable';
  if (before.sleeping || after.sleeping) return 'sleep';
  if (before.transition !== undefined && after.transition !== before.transition) return 'host-transition';
  return null;
}
function snapshot(result) {
  // 保留每次结构化结果和输出副本；调用方不能随后改写第一次结果。
  try { return structuredClone(result); }
  catch { return { ok: false, status: null, failureKind: { stage: 'infrastructure', kind: 'invalid-result' }, out: '验收返回了不可保存的结果。' }; }
}
async function runAttempts({ kind = 'e2e', runCheck, onAttempt, readHostState, clock, sampleIntervalMs, gapLimitMs } = {}) {
  if (typeof runCheck !== 'function') throw Error('必须提供独立验收执行函数');
  const attempts = []; let finalResult, classification;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const before = await hostState(readHostState);
    const monitor = createInterruptionMonitor({ clock, sampleIntervalMs, gapLimitMs });
    let returned;
    try {
      if (before.sleeping || before.unavailable) returned = { ok: false, status: null, out: '运行环境正在睡眠或状态不可确认，未启动验收。' };
      else returned = await runCheck({ attempt });
    } catch {
      // 未经结构化的执行异常不能当作真实模型网络错误重试。
      returned = { ok: false, status: null, failureKind: { stage: 'infrastructure', kind: 'runner-error' }, out: '验收执行异常；保留本次失败，不自动重试。' };
    }
    const after = await hostState(readHostState), observed = monitor.finish();
    const interruption = hostInterruption(before, after) || observed;
    finalResult = snapshot(returned || { ok: false, status: null });
    classification = classifyResult(finalResult, { kind, interruption });
    if (classification.category !== 'passed') finalResult.ok = false;
    if (interruption) finalResult.failureKind = { stage: 'interruption', kind: interruption === 'sleep' ? 'sleep' : 'host-interrupted' };
    const entry = { attempt, result: snapshot(finalResult), classification: { ...classification } };
    attempts.push(entry);
    if (onAttempt) await onAttempt(snapshot(entry));
    if (classification.category === 'passed' || !classification.retryable || attempt === MAX_ATTEMPTS) break;
  }
  return { ...finalResult, attempts, attemptCount: attempts.length, retried: attempts.length > 1,
    recordVersionFailure: finalResult.ok !== true && classification.recordVersionFailure,
    interrupted: classification.category === 'interrupted' };
}
function modelFailureKind(kind, provider) {
  const mapped = { network: 'model-network', auth: 'auth', quota: 'quota', cancel: 'cancelled', userfile: 'user-file', start: 'model-start', protocol: 'model-protocol', 'no-output': 'model-no-output' };
  return { stage: 'model', kind: mapped[kind] || 'unknown', provider, source: 'model-result' };
}
function modelWaitFailureKind({ provider, health, interruption }) {
  if (interruption) return { stage: 'interruption', kind: 'host-interrupted' };
  if (health?.isolationBlocked === true) return { stage: 'boundary', kind: 'boundary' };
  if (health?.isolationBlocked !== false || typeof health.running !== 'number') return { stage: 'infrastructure', kind: 'local-health-unknown' };
  return { stage: 'model', kind: 'model-timeout', provider, source: 'harness-model-wait' };
}
async function runNodeCheck({ args, root, logFile, timeoutMs }) {
  if (!(timeoutMs > 0)) return { ok: false, status: null, timedOut: true };
  const handle = await fs.open(logFile, 'wx');
  try {
    return await new Promise(resolve => {
      let ended = false, timer;
      const child = cp.spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', handle.fd, handle.fd] });
      const finish = result => { if (!ended) { ended = true; clearTimeout(timer); resolve(result); } };
      child.once('error', () => finish({ ok: false, status: null, spawnFailed: true }));
      child.once('close', status => finish({ ok: status === 0, status }));
      timer = setTimeout(() => { child.kill(); finish({ ok: false, status: null, timedOut: true }); }, timeoutMs);
    });
  } finally { await handle.close(); }
}
async function readReport(file) {
  await tx.physical(file); const before = await fs.stat(file);
  if (!before.isFile() || before.size > 4 * 1024 * 1024) throw Error('验收报告大小无效');
  const bytes = await fs.readFile(file), after = await fs.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw Error('验收报告仍在写入');
  return JSON.parse(bytes.toString('utf8'));
}
const RESULT_PREFIX = 'RELAY_ACCEPTANCE_RESULT ';
function resultSummary(result) {
  const summary = { schema: 1, ok: result?.ok === true, interrupted: result?.interrupted === true,
    recordVersionFailure: result?.recordVersionFailure === true, attemptCount: Number.isInteger(result?.attemptCount) ? result.attemptCount : 0 };
  const failure = result?.failureKind;
  if (failure && ['model','boundary','interruption','infrastructure','check'].includes(failure.stage) && typeof failure.kind === 'string' && /^[a-z-]{1,64}$/.test(failure.kind)) {
    summary.failureKind = { stage: failure.stage, kind: failure.kind };
    if (['claude','gpt'].includes(failure.provider)) summary.failureKind.provider = failure.provider;
    if (['model-result','harness-model-wait'].includes(failure.source)) summary.failureKind.source = failure.source;
  }
  return summary;
}
function formatResult(result) { return RESULT_PREFIX + JSON.stringify(resultSummary(result)); }
function parseResultOutput(output) {
  const lines = String(output || '').split(/\r?\n/).filter(line => line.startsWith(RESULT_PREFIX));
  if (lines.length !== 1 || lines[0].length > 4096) return null;
  try {
    const value = JSON.parse(lines[0].slice(RESULT_PREFIX.length));
    if (value.schema !== 1 || typeof value.ok !== 'boolean' || typeof value.interrupted !== 'boolean' || typeof value.recordVersionFailure !== 'boolean' ||
        !Number.isInteger(value.attemptCount) || value.attemptCount < 0 || value.attemptCount > MAX_ATTEMPTS || JSON.stringify(value) !== JSON.stringify(resultSummary(value))) return null;
    return value;
  } catch { return null; }
}
async function runEvidence({ root, evidenceDir, manifestPath, requiredChecks, extraArgs = [], candidateEvidence, remaining,
  runCheck = runNodeCheck, beforeAttempt = async () => {}, readHostState, clock, sampleIntervalMs, gapLimitMs }) {
  await tx.physical(evidenceDir);
  const started = performance.now(), allowance = remaining ? remaining() : 45 * 60e3;
  const remainingBudget = () => Math.max(0, Math.min(allowance - (performance.now() - started), remaining ? remaining() : Infinity));
  const hostReader = readHostState === undefined && runCheck === runNodeCheck
    ? require('./maintenance-host-state.cjs').readHostState : readHostState;
  const monitoring = { readHostState: hostReader, clock, sampleIntervalMs, gapLimitMs }, entries = [];
  const summaryFile = path.join(evidenceDir, 'attempts.json');
  const save = async entry => { entries.push(entry); await tx.atomicWrite(summaryFile, JSON.stringify({ schema: 1, attempts: entries }, null, 2)); };
  async function checkedRun(context) {
    try { await beforeAttempt({ kind: context.kind, attempt: context.attempt }); }
    catch { return { ok: false, status: null, executed: false, failureKind: { stage: 'boundary', kind: 'boundary' }, out: '验收文件绑定已经变化，拒绝继续。' }; }
    const timeoutMs = remainingBudget();
    if (!(timeoutMs > 0)) return { ok: false, status: null, timedOut: true, executed: false, failureKind: { stage: 'interruption', kind: 'budget-exhausted' }, out: '验收总运行预算已用完。' };
    const result = await runCheck({ ...context, root, timeoutMs });
    try { await beforeAttempt({ kind: context.kind, attempt: context.attempt, after: true }); }
    catch { return { ...result, ok: false, failureKind: { stage: 'boundary', kind: 'boundary' }, out: '验收期间文件绑定变化，结果作废。' }; }
    return result;
  }
  const regressionLog = path.join(evidenceDir, 'regression.log');
  const regression = await runAttempts({ ...monitoring, kind: 'regression',
    runCheck: () => checkedRun({ kind: 'regression', attempt: 1, args: ['tests/run.cjs'], logFile: regressionLog }),
    onAttempt: entry => save({ kind: 'regression', ...entry }) });
  if (!regression.ok) return { ...regression, stage: 'regression', evidence: [regressionLog, summaryFile], out: '回归未通过，正式记录没有改动。' };
  const outputFiles = [];
  const accepted = await runAttempts({ ...monitoring, kind: 'e2e', runCheck: async ({ attempt }) => {
    const reportFile = path.join(evidenceDir, 'e2e-attempt-' + attempt + '.json'), logFile = path.join(evidenceDir, 'e2e-attempt-' + attempt + '.log');
    if (await tx.exists(reportFile) || await tx.exists(logFile)) return { ok: false, failureKind: { stage: 'infrastructure', kind: 'output-exists' }, out: '该次验收输出已存在，拒绝覆盖。' };
    outputFiles.push(reportFile, logFile);
    const result = await checkedRun({ kind: 'e2e', attempt, args: ['tests/server-isolation-e2e.cjs', manifestPath, reportFile, ...extraArgs], logFile });
    let report;
    try { report = await readReport(reportFile); }
    catch { return { ...result, ok: false, reportFile, logFile, failureKind: result.failureKind || { stage: 'infrastructure', kind: 'evidence-unreadable' } }; }
    if (result.failureKind) return { ...result, ok: false, reportFile, logFile, report };
    if (result.timedOut || result.spawnFailed) return { ...result, ok: false, reportFile, logFile, report,
      failureKind: { stage: 'infrastructure', kind: result.timedOut ? 'runner-timeout' : 'runner-start' } };
    if (candidateEvidence && JSON.stringify(report.candidate) !== JSON.stringify(candidateEvidence)) return { ...result, ok: false, reportFile, logFile, report,
      failureKind: { stage: 'boundary', kind: 'boundary' }, out: '验收证据没有绑定本次候选。' };
    if (Array.isArray(requiredChecks) && requiredChecks.some(name => report.checks?.[name] === false || report.checks?.[name]?.passed === false)) return { ...result, ok: false, reportFile, logFile, report,
      failureKind: { stage: 'boundary', kind: 'boundary' }, out: '已有检查明确失败，不能用模型重试掩盖。' };
    const complete = Array.isArray(requiredChecks) && requiredChecks.every(name => !!report.checks?.[name]);
    const ok = result.ok === true && complete && !report.failure && !report.failureKind;
    return { ...result, ok, reportFile, logFile, report, ...(report.failureKind ? { failureKind: report.failureKind } : {}),
      ...(!ok && !report.failureKind ? { failureKind: { stage: 'check', kind: 'incomplete-evidence' } } : {}) };
  }, onAttempt: entry => save({ kind: 'e2e', ...entry }) });
  return { ...accepted, stage: 'e2e', evidence: [regressionLog, ...outputFiles, summaryFile],
    out: accepted.ok ? '回归和端到端验收通过。' : '端到端验收未通过，正式记录没有改动。' };
}
module.exports = { MAX_ATTEMPTS, DEFAULT_GAP_MS, classifyResult, createInterruptionMonitor, runAttempts, modelFailureKind, modelWaitFailureKind,
  runNodeCheck, runEvidence, resultSummary, formatResult, parseResultOutput };
