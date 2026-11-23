'use strict';
// 完整边界验收的判定和记录生成。所有系统操作都由调用方注入，这里不启动模型、不重启服务。
// 结论只来自本轮新产生的证据：不读取、不沿用旧记录的 checks，也没有任何把结果直接标为通过的入口。
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const REPORT = ['{manifest}', '{out}'];
// boundary：失败后同一组文件不能靠重跑通过。costly：前面全部通过才运行（要花模型额度）。
// e2e 里混有账号边界断言：模型、网络类失败可重跑，断言失败（check、boundary）和边界步骤同样处理。
// answerChecks：真实模型偶尔答不中的那几项。只有它单独失败、其余检查全部通过才可以重跑，同一组文件最多容忍 MAX_ANSWER_MISSES 次，次数写进验收记录。
const MAX_ANSWER_MISSES = 2;
const STEPS = Object.freeze([
  { id: 'regression', covers: ['regression'], script: 'tests/run.cjs', args: [], timeoutMs: 10 * 60e3, boundary: true },
  { id: 'fs-view', covers: ['filesystemDeny'], script: 'tests/executor-view-boundary.cjs', args: ['{out}', '{stage}', '{manifest}'], timeoutMs: 10 * 60e3, boundary: true,
    requiredChecks: ['ownWrite', 'apiKeyAbsent', 'cachedContextTamperBlocked', 'restored', 'unlinkViewDenied', 'renameViewDenied', 'parentWriteDenied', 'parentJunctionDenied', 'outsideReadDenied', 'otherHashReadDenied', 'sharedBaseListDenied', 'escapeReadDenied'] },
  { id: 'fs-scratch', covers: ['filesystemDeny'], script: 'tests/executor-scratch-boundary.cjs', args: ['{out}', '{stage}', '{manifest}'], timeoutMs: 10 * 60e3, boundary: true,
    requiredChecks: ['physicalRoot', 'distinctAccounts', 'ownWritable', 'otherReadDenied', 'otherWriteDenied', 'baseListDenied', 'baseWriteDenied', 'rootRenameDenied', 'correctTemp', 'correctProfile', 'noKey', 'otherUnchanged'] },
  { id: 'network', covers: ['networkDeny'], script: 'tests/acceptance/probe-network.cjs', args: REPORT, timeoutMs: 5 * 60e3, boundary: true,
    requiredChecks: ['physicalRuntime', 'policyDisabled', 'ipv4TrustedControl', 'ipv4WorkerDenied', 'cleanupConfirmed'] },
  { id: 'desktop', covers: ['uiDesktopDeny'], script: 'tests/acceptance/probe-desktop.cjs', args: REPORT, timeoutMs: 5 * 60e3, boundary: true,
    requiredChecks: ['ownPrivateDesktop', 'notInteractiveStation', 'interactiveStationDenied', 'defaultDesktopDenied', 'peerDesktopDenied', 'distinctDesktops', 'cleanupConfirmed'] },
  { id: 'cancel', covers: ['cancellation'], script: 'tests/acceptance/probe-cancel.cjs', args: REPORT, timeoutMs: 5 * 60e3, boundary: true,
    requiredChecks: ['abortStopsTree', 'abortHeartbeatStopped', 'timeoutStopsTree', 'timeoutHeartbeatStopped', 'normalRunAfterCancel'] },
  { id: 'parent-death', covers: ['parentDeath'], script: 'tests/acceptance/probe-parent-death.cjs', args: REPORT, timeoutMs: 5 * 60e3, boundary: true,
    requiredChecks: ['workerStarted', 'treeStopped', 'heartbeatStopped'] },
  { id: 'powershell', covers: ['serverEndToEnd'], script: 'tests/acceptance/probe-powershell.cjs', args: REPORT, timeoutMs: 5 * 60e3,
    requiredChecks: ['plainWriteClean', 'dotnetReadClean', 'dotnetDirectoryClean', 'misleadingDenialExplained', 'stderrPreserved', 'fileMatchesAfterDenial', 'realFailureKept', 'timeoutExplained', 'notesExplainLimit'] },
  { id: 'tex', covers: ['tex'], script: 'tests/tex-compile-mxc.cjs', args: REPORT, timeoutMs: 20 * 60e3, minChecks: 8 },
  { id: 'tex-cancel', covers: ['tex', 'cancellation'], script: 'tests/tex-compile-cancel-mxc.cjs', args: REPORT, timeoutMs: 20 * 60e3, boundary: true,
    requiredChecks: ['activeStagePreserved', 'cancelledJobExited', 'cancelledStageExistsBefore', 'deadStageReclaimed', 'formerlyActiveStageReclaimed', 'noStagesRemain', 'normalPdf', 'recoveryReported'] },
  { id: 'docs', covers: ['ocr', 'scientific'], script: 'tests/acceptance/probe-python.cjs', args: [...REPORT, 'docs'], timeoutMs: 10 * 60e3, requiredChecks: ['ocr', 'scientific', 'cleanupConfirmed'] },
  { id: 'html', covers: ['html'], script: 'tests/acceptance/probe-python.cjs', args: [...REPORT, 'html'], timeoutMs: 10 * 60e3, requiredChecks: ['render', 'assets', 'escapeRefused', 'cleanupConfirmed'] },
  { id: 'gpu', covers: ['gpu', 'scientific'], script: 'tests/acceptance/probe-python.cjs', args: [...REPORT, 'gpu'], timeoutMs: 15 * 60e3, requiredChecks: ['cuda', 'matrix', 'smlm', 'cleanupConfirmed'] },
  { id: 'eve', covers: ['eve'], script: 'tests/acceptance/probe-python.cjs', args: [...REPORT, 'eve'], timeoutMs: 15 * 60e3, requiredChecks: ['fit', 'rawRoundTrip', 'cleanupConfirmed'] },
  { id: 'voice', covers: ['voiceOnline', 'voiceOffline', 'stt', 'media', 'cancellation'], script: 'tests/acceptance/probe-voice.cjs', args: REPORT, timeoutMs: 15 * 60e3,
    requiredChecks: ['voiceOnline', 'sttOnline', 'voiceOffline', 'sttOffline', 'voiceCancel', 'media'] },
  { id: 'research', covers: ['research'], script: 'tests/acceptance/probe-research.cjs', args: REPORT, timeoutMs: 10 * 60e3,
    requiredChecks: ['lookup', 'fallbackLabelled', 'download', 'privateAddressRefused'] },
  // 2026-11-23 GPT 退出平台：原来的 gpt-accounts 步骤（两个账号同时用 GPT 不串）随 gptApi、gptHistory 一起去掉；
  // 两个账号互不串的 Gemini 版在 gemini 步骤，Claude/Gemini 之间接力时的版本在 model-handoff 的 bothAccountsSwitchIsolated。
  { id: 'gemini', covers: ['geminiSubscription', 'geminiHistory'], script: 'tests/acceptance/probe-gemini.cjs', args: REPORT, timeoutMs: 30 * 60e3, costly: true, answerChecks: ['aliceContinues', 'retryKeepsHistory', 'builtinToolAttempted'],
    requiredChecks: ['aliceSeesGemini', 'bobSeesGemini', 'aliceHasConversation', 'relayToolFile', 'builtinToolsDenied', 'builtinToolAttempted', 'distinctConversations', 'noMemoryLeak', 'noFileLeak', 'forgedConversationIgnored', 'conversationDenied', 'fileDenied', 'aliceContinues', 'sameConversationResumed', 'retryUsesFreshConversation', 'retryKeepsHistory', 'gateExecuted', 'profilesSeparated', 'slashCommandsAreText', 'runFoldersCleaned', 'cleanupConfirmed'] },
  // 接力的另一方从 GPT 换成 Gemini（Claude → Gemini → Claude）。Gemini 比 GPT 慢、这一步约一半的轮次是它，超时放宽到 80 分钟（探针自己的总预算 70 分钟）。
  // crossConversationIsolated 原在 gpt-accounts 里（往别的账号的对话发消息必须 404），和模型无关，挪到这一步继续要求。
  { id: 'model-handoff', covers: ['claudeSubscription', 'claudeHistory', 'geminiSubscription', 'geminiHistory', 'serverEndToEnd'], script: 'tests/acceptance/probe-model-handoff.cjs', args: REPORT, timeoutMs: 80 * 60e3, costly: true, answerChecks: ['claudeRecovery', 'geminiRecovery'],
    requiredChecks: ['syntheticAccounts', 'claudeToolFile', 'fastSwitch', 'geminiReadPreviousFile', 'claudeReturnReadsGeminiFile', 'stoppedWorkPreserved', 'editedHistoryClean', 'projectHandoff', 'imageRead', 'longHistoryBounded', 'memoryOffNoTranscript', 'bothAccountsSwitchIsolated', 'conversationDenied', 'crossConversationIsolated', 'claudeRecovery', 'geminiRecovery', 'handoffExample', 'cleanupConfirmed', 'oneShotRetry', 'crossProviderReview'] },
  // 端到端只留 Claude（原来的 gptSwitchAndTools、gptContinuation、gptLatexWorkflow 去掉）；Gemini 由上面两步覆盖，日常上线本来也不覆盖 Gemini。
  { id: 'e2e', covers: ['pdf', 'stt', 'tex', 'claudeSubscription', 'claudeHistory', 'serverEndToEnd'], script: 'tests/server-isolation-e2e.cjs', args: [...REPORT, '--with-tex'], timeoutMs: 45 * 60e3, costly: true,
    requiredChecks: ['loginAndModels', 'crossTabMismatch', 'projects', 'uploadDownloadAccountBoundary', 'resumableUpload', 'signedHtml', 'officePreviews', 'voiceRoundTrip', 'claudeToolsAndChecklist', 'claudeContinuation', 'claudeLatexWorkflow', 'liveEvents', 'conversationSaved', 'conversationAccountBoundary'],
    requireStartup: true },
]);
const REVIEW_CHECK = 'candidateReview';
function coverage(required) {
  const map = Object.fromEntries(required.map(name => [name, []]));
  for (const step of STEPS) for (const name of step.covers) { if (!map[name]) throw Error('步骤覆盖了未知验收项：' + name); map[name].push(step.id); }
  const missing = required.filter(name => name !== REVIEW_CHECK && !map[name].length);
  if (missing.length) throw Error('这些验收项没有对应的步骤：' + missing.join('、'));
  if (!required.includes(REVIEW_CHECK)) throw Error('验收项缺少候选审查');
  return map;
}
const truthy = value => value !== false && value !== null && value !== undefined && !(typeof value === 'object' && value.passed === false);
// 脚本漏跑一项也算不通过：名单在这里，不由被测脚本决定。
function evaluate(step, { status, timedOut, report }) {
  const reasons = [];
  if (timedOut) reasons.push('超时');
  if (status !== 0) reasons.push('退出码 ' + status);
  if (step.requiredChecks || step.minChecks) {
    if (!report || typeof report !== 'object') reasons.push('没有可读的结果文件');
    else {
      if (report.failure) reasons.push('结果含失败记录');
      const checks = report.checks && typeof report.checks === 'object' ? report.checks : {}, names = Object.keys(checks);
      if (!names.length) reasons.push('结果没有检查项');
      for (const name of names) if (!truthy(checks[name])) reasons.push('未通过：' + name);
      for (const name of step.requiredChecks || []) if (!Object.hasOwn(checks, name)) reasons.push('缺少检查项：' + name);
      if (step.minChecks && names.length < step.minChecks) reasons.push('检查项数量不足');
      if (step.requireStartup && !(report.startup?.backfillComplete === true && report.startup?.existingUnchanged === true && report.startup?.healthMs < 20000)) reasons.push('冷启动检查未完成');
    }
  }
  return { passed: !reasons.length, reasons };
}
async function bindingOf(d) {
  const git = await d.gitState();
  if (git?.clean !== true || !/^[a-f0-9]{40,64}$/.test(git.head || '') || git.sourceMatchesHead !== true) throw Error('工作区必须干净且 server.js 等于 HEAD，才能开始或继续完整验收。');
  const files = d.gate.requiredFingerprintFiles(d.config, d.runtime, d.root).map(file => [file, d.gate.hashFile(file)]);
  const configuration = d.gate.configurationFingerprint(d.config, d.runtime, d.root);
  return { binding: sha(JSON.stringify({ head: git.head, configuration, files })), head: git.head, configuration, files };
}
const evidenceDir = (d, binding) => path.join(path.dirname(d.receiptPath), 'codex-security-artifacts-full-' + binding.slice(0, 24));
const stateFile = dir => path.join(dir, 'run.json');
async function loadRun(d, current) {
  const dir = evidenceDir(d, current.binding);
  let run;
  try { run = JSON.parse(await fs.readFile(stateFile(dir), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('验收运行记录损坏，保留文件待检查。'); }
  if (run && (run.schema !== 1 || run.binding !== current.binding || run.head !== current.head)) throw Error('验收运行记录与当前文件不一致。');
  return { dir, run: run || { schema: 1, binding: current.binding, head: current.head, createdAt: new Date(d.now()).toISOString(), approvals: [], attempts: {}, acknowledged: {}, review: null } };
}
async function saveRun(dir, run) {
  await fs.mkdir(dir, { recursive: true });
  const temp = stateFile(dir) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  await fs.writeFile(temp, JSON.stringify(run, null, 2), { flag: 'wx' });
  await fs.rename(temp, stateFile(dir));
}
const latest = (run, id) => run.attempts[id]?.at(-1);
const acknowledged = (run, id, attempt) => (run.acknowledged[id] || []).some(item => item.attempt === attempt);
const poisoned = (run, step) => (run.attempts[step.id] || []).some(item => !item.passed && !item.answerMiss && (step.boundary || item.hard) && !acknowledged(run, step.id, item.n));
// 探针自称答不中还不够：必须是这个步骤登记过的检查，且报告里没有别的检查失败。
function answerMissOf(step, report) {
  const kind = report?.failureKind;
  if (kind?.stage !== 'model-answer' || !step.answerChecks?.includes(kind.check)) return null;
  const checks = report.checks && typeof report.checks === 'object' ? report.checks : {};
  return Object.keys(checks).every(name => name === kind.check || truthy(checks[name])) ? kind.check : null;
}
function status(run) {
  return STEPS.map(step => ({ id: step.id, attempts: run.attempts[step.id]?.length || 0, passed: latest(run, step.id)?.passed === true, poisoned: poisoned(run, step), reasons: latest(run, step.id)?.reasons || [] }));
}
async function plan(d) {
  const map = coverage(d.gate.REQUIRED), problems = [];
  for (const step of STEPS) { try { await fs.access(path.join(d.root, step.script)); } catch { problems.push('缺少脚本：' + step.script); } }
  let current = null, run = null;
  try { current = await bindingOf(d); run = (await loadRun(d, current)).run; } catch (error) { problems.push(error.message); }
  return { coverage: map, problems, binding: current?.binding || null, head: current?.head || null, fileCount: current?.files.length || 0, steps: run ? status(run) : [], review: !!run?.review };
}
async function hashEvidence(file) { return { path: file, sha256: sha(await fs.readFile(file)) }; }
async function runSteps(options, d) {
  if (typeof options.ownerApproved !== 'string' || options.ownerApproved.trim().length < 2) throw Error('真实验收必须先取得机主同意，并用 --owner-approved 写明。');
  coverage(d.gate.REQUIRED);
  const current = await bindingOf(d), { dir, run } = await loadRun(d, current);
  run.approvals.push({ at: new Date(d.now()).toISOString(), note: options.ownerApproved.trim() });
  await saveRun(dir, run);
  const only = options.only ? new Set(options.only) : null;
  for (const id of only || []) if (!STEPS.some(step => step.id === id)) throw Error('未知步骤：' + id);
  // 明确确认某次边界失败来自基础设施（如机器睡眠）时才可重跑；原因写进最终记录，不会消失。
  for (const [id, reason] of Object.entries(options.acknowledge || {})) {
    const failed = (run.attempts[id] || []).filter(item => !item.passed && !acknowledged(run, id, item.n));
    if (!failed.length) throw Error('步骤没有待确认的失败：' + id);
    if (typeof reason !== 'string' || reason.trim().length < 4) throw Error('确认重跑必须写明原因。');
    run.acknowledged[id] = [...(run.acknowledged[id] || []), ...failed.map(item => ({ attempt: item.n, at: new Date(d.now()).toISOString(), reason: reason.trim() }))];
  }
  await saveRun(dir, run);
  for (const step of STEPS) {
    if (only ? !only.has(step.id) : latest(run, step.id)?.passed) continue;
    if (poisoned(run, step)) { d.log('已停止：' + step.id + ' 是边界检查，失败后不能靠重跑通过。修好代码（指纹变化）后重新开始。'); return { result: 'boundary-failed', step: step.id, run }; }
    if (step.costly && STEPS.slice(0, STEPS.indexOf(step)).some(other => latest(run, other.id)?.passed !== true)) { d.log('跳过 ' + step.id + '：前面的步骤还没有全部通过，不花模型额度。'); continue; }
    const n = (run.attempts[step.id]?.length || 0) + 1, stem = path.join(dir, step.id + '-attempt-' + n);
    const out = stem + '.json', logFile = stem + '.log';
    const stage = step.args.includes('{stage}') ? path.join(d.root, 'data', 'isolation-e2e-' + crypto.randomBytes(6).toString('hex')) : null;
    const args = step.args.map(value => value === '{manifest}' ? d.config.isolation.runtimeManifest : value === '{out}' ? out : value === '{stage}' ? stage : value);
    d.log('开始 ' + step.id + '（第 ' + n + ' 次）');
    const startedAt = d.now(), outcome = await d.runStep({ step, script: step.script, args, logFile, reportFile: out, timeoutMs: step.timeoutMs });
    let report = null;
    try { report = JSON.parse(await fs.readFile(out, 'utf8')); } catch {}
    const verdict = evaluate(step, { status: outcome.status, timedOut: outcome.timedOut, report });
    const after = await bindingOf(d);
    const evidence = [];
    for (const file of [out, logFile]) { try { evidence.push(await hashEvidence(file)); } catch {} }
    const missed = answerMissOf(step, report), earlierMisses = (run.attempts[step.id] || []).filter(item => item.answerMiss).length;
    const answerMiss = !verdict.passed && missed && earlierMisses < MAX_ANSWER_MISSES ? missed : null;
    // 报告里已经有检查项明确失败（不是没跑到），说明断言真的不成立：不管报告自称是什么类别，都不能靠重跑通过
    const failedCheck = Object.values(report?.checks && typeof report.checks === 'object' ? report.checks : {}).some(value => !truthy(value));
    const hard = !answerMiss && (failedCheck || ['check', 'boundary', 'model-answer'].includes(report?.failureKind?.stage));
    const attempt = { n, startedAt, finishedAt: d.now(), passed: verdict.passed && after.binding === current.binding, hard, ...(answerMiss ? { answerMiss } : {}), reasons: verdict.reasons, status: outcome.status, evidence };
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => d.log('临时目录未能删除：' + path.basename(stage)));
    (run.attempts[step.id] ||= []).push(attempt);
    await saveRun(dir, run);
    if (after.binding !== current.binding) { d.log('已停止：验收期间运行文件或提交变化，这一轮作废。'); return { result: 'files-changed', step: step.id, run }; }
    d.log(step.id + (attempt.passed ? ' 通过' : ' 未通过：' + verdict.reasons.slice(0, 6).join('；')));
    if (answerMiss) d.log(step.id + ' 只有模型回答没答中（' + answerMiss + '），第 ' + (earlierMisses + 1) + ' 次，可以重新运行；最多容忍 ' + MAX_ANSWER_MISSES + ' 次。');
    if (!attempt.passed && !answerMiss && (step.boundary || hard)) return { result: 'boundary-failed', step: step.id, run };
  }
  return { result: status(run).every(item => item.passed) ? 'all-passed' : 'incomplete', run };
}
function parseReview(text) {
  const field = name => (new RegExp('^' + name + ':[ \\t]*(.+)$', 'm').exec(text)?.[1] || '').trim();
  return { commit: field('Commit'), binding: field('Binding'), reviewer: field('Reviewer'), verdict: field('Verdict').toLowerCase(), disposition: field('Disposition') };
}
// 工具无法判断审查者是否独立，所以只核对绑定和结论，并把审查全文和审查者写进证据供人核查。
async function recordReview(options, d) {
  const current = await bindingOf(d), { dir, run } = await loadRun(d, current);
  const bytes = await fs.readFile(options.file), review = parseReview(bytes.toString('utf8'));
  if (review.commit !== current.head) throw Error('审查的提交不是当前 HEAD。');
  if (review.binding !== current.binding) throw Error('审查绑定的不是当前运行文件。');
  if (review.reviewer.length < 2) throw Error('审查记录缺少 Reviewer。');
  if (review.verdict !== 'approved') throw Error('审查结论不是 approved，不能写入验收。');
  if (review.disposition.length < 4) throw Error('审查记录缺少 Disposition。');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'candidate-review.md');
  await fs.writeFile(target, bytes);
  run.review = { reviewer: review.reviewer, disposition: review.disposition, at: new Date(d.now()).toISOString(), evidence: await hashEvidence(target) };
  await saveRun(dir, run);
  return run.review;
}
async function buildReceipt(run, current, d, previous) {
  const required = d.gate.REQUIRED, map = coverage(required), notPassed = [];
  for (const step of STEPS) {
    const attempt = latest(run, step.id);
    if (attempt?.passed !== true) notPassed.push(step.id);
    if (poisoned(run, step)) notPassed.push(step.id + '（边界失败未解决）');
  }
  if (!run.review) notPassed.push(REVIEW_CHECK);
  if (notPassed.length) throw Error('还不能写记录，未完成：' + [...new Set(notPassed)].join('、'));
  // 证据被改过就不算数；每条都重新核对字节。
  const verify = async item => { if ((await hashEvidence(item.path)).sha256 !== item.sha256) throw Error('证据文件已被改动：' + path.basename(item.path)); return item.path; };
  const checks = {};
  for (const name of required) {
    const files = name === REVIEW_CHECK ? [run.review.evidence] : map[name].flatMap(id => latest(run, id).evidence);
    if (!files.length) throw Error('验收项没有证据：' + name);
    const paths = [];
    for (const item of files) paths.push(await verify(item));
    checks[name] = { passed: true, evidence: [...new Set(paths)] };
  }
  const acknowledgements = Object.entries(run.acknowledged).flatMap(([id, rows]) => rows.map(row => ({ step: id, ...row })));
  const answerMisses = Object.entries(run.attempts).flatMap(([id, rows]) => rows.filter(row => row.answerMiss).map(row => ({ step: id, attempt: row.n, check: row.answerMiss })));
  const at = new Date(d.now()).toISOString();
  const revision = { at, kind: 'full-acceptance', head: current.head, binding: current.binding, reviewer: run.review.reviewer, approvals: run.approvals, acknowledgements, answerMisses,
    note: '全部 REQUIRED 在这组文件上重新运行；没有沿用旧结论。' };
  const receipt = { schema: d.gate.RECEIPT_SCHEMA, completedAt: at, configurationFingerprint: current.configuration, checks,
    fingerprints: current.files.map(([file, sha256]) => ({ path: file, sha256 })),
    limitations: Array.isArray(previous?.limitations) ? previous.limitations : [], reviewDisposition: run.review.disposition,
    revisions: [...(Array.isArray(previous?.revisions) ? previous.revisions : []), revision].slice(-10) };
  const dropped = (previous?.revisions?.length || 0) + 1 - receipt.revisions.length;
  if (previous?.archivedRevisionCount || dropped > 0) receipt.archivedRevisionCount = (previous?.archivedRevisionCount || 0) + Math.max(0, dropped);
  return receipt;
}
async function writeReceipt(options, d) {
  const current = await bindingOf(d), { dir, run } = await loadRun(d, current);
  if (!run.createdAt || !Object.keys(run.attempts).length) throw Error('这组文件还没有运行过完整验收。');
  let previousBytes = null, previous = null;
  try { previousBytes = await fs.readFile(d.receiptPath); previous = JSON.parse(previousBytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const receipt = await buildReceipt(run, current, d, previous);
  if (options.dryRun) return { result: 'ready', steps: STEPS.length };
  const text = JSON.stringify(receipt, null, 2) + '\n', candidate = path.join(dir, 'receipt.candidate.json');
  await fs.writeFile(candidate, text);
  const candidateReport = d.gate.check(d.config, candidate, d.root);
  if (!candidateReport.readyToEnableIsolation) throw Error('候选记录核对未通过，正式记录没有改动：' + candidateReport.remainingRequirements.slice(0, 5).join('；'));
  if ((await bindingOf(d)).binding !== current.binding) throw Error('写记录前文件变化，正式记录没有改动。');
  const stamp = new Date(d.now()).toISOString().replace(/[:.]/g, '-');
  if (previousBytes) await fs.writeFile(d.receiptPath + '.before-' + stamp, previousBytes, { flag: 'wx' });
  const temp = d.receiptPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  await fs.writeFile(temp, text, { flag: 'wx' });
  await fs.rename(temp, d.receiptPath);
  const installed = d.gate.check(d.config, d.receiptPath, d.root);
  if (!installed.readyToEnableIsolation) {
    if (previousBytes) await fs.writeFile(d.receiptPath, previousBytes); else await fs.rm(d.receiptPath, { force: true });
    throw Error('安装后核对未通过，已恢复原记录。');
  }
  return { result: 'installed', receipt: d.receiptPath, fingerprints: receipt.fingerprints.length };
}
module.exports = { STEPS, REVIEW_CHECK, coverage, evaluate, bindingOf, plan, runSteps, recordReview, writeReceipt, parseReview, status };
