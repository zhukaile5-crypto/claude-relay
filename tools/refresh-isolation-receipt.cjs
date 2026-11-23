'use strict';
// 重新验收：改了 server.js，或者 Claude Code 自动更新替换了 claude.exe 之后，文件指纹对不上，服务只开网站、不跑模型。
// 这个工具真实跑一遍回归测试和端到端验收（虚拟账号 + 真实 Claude，会花一点额度），通过了才更新验收记录。
//
// 它只接受两种变化：server.js 和 Claude 程序本身。隔离模块（isolation/）、运行环境、账号和路径配置变了就拒绝：
// 那些是隔离边界本身，端到端测试证明不了边界没破，要重新做边界测试和人工审查。
// 2026-11-23 GPT 退出平台：Codex 程序除了曾经用来跑 GPT，还是每次执行工具时的沙箱宿主（isolation/executor.js 用它起 windows.sandbox=mxc 的 app-server，Claude 和 Gemini 的文件、命令工具都经过它）。换沙箱宿主应当重跑边界探针，光靠端到端不够，所以 Codex 程序（完整包）也和其他运行环境文件一样，
// 必须和验收记录一字不差，变了就拒绝；--codex-moved-from 也不再接受。Codex 固定副本留在运行环境里，照旧被指纹核对。
// 用法：node tools/refresh-isolation-receipt.cjs        （先用 --dry-run 只看有什么变化）
// 只换了 Claude 程序的路径时（固定副本）：加 --claude-moved-from=<原路径>。工具会证明清单和配置除了这个路径之外一个字都没变
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const gate = require('./check-isolation.cjs');
const key = (p) => path.resolve(p).toLowerCase();
const die = (code, message) => { console.error(message); process.exit(code); };
// 端到端测试必须全部走到的步骤（和 maintenance-candidate.cjs 的 E2E_REQUIRED 一致；GPT 退出平台后去掉了 gptContinuation）
const E2E_REQUIRED = ['loginAndModels', 'crossTabMismatch', 'projects', 'uploadDownloadAccountBoundary', 'resumableUpload', 'signedHtml', 'officePreviews',
  'voiceRoundTrip', 'claudeContinuation', 'liveEvents', 'conversationSaved', 'conversationAccountBoundary'];

const configSource = fs.readFileSync(path.join(root, 'config.json'), 'utf8'), config = JSON.parse(configSource);
if (!config.isolation?.enabled) die(2, '隔离没有启用，不需要验收。');
const receiptPath = config.isolation.receipt || path.join(root, 'data', 'isolation', 'acceptance.json');
const outputs = process.argv.filter(a => a.startsWith('--output-receipt='));
if (outputs.length > 1) die(2, '候选记录输出参数不能重复。');
const outputReceipt = outputs.length ? path.resolve(outputs[0].slice('--output-receipt='.length)) : null;
if (outputReceipt) {
  const folder = path.dirname(outputReceipt);
  if (path.basename(outputReceipt) !== 'receipt.candidate.json' || !/^[a-f0-9]{32}$/.test(path.basename(folder)) ||
      key(path.dirname(folder)) !== key(path.join(root, 'data', 'maintenance', 'transactions'))) die(2, '候选记录只能输出到维护事务目录。');
}
const candidatePrograms = process.argv.filter(a => a.startsWith('--candidate-program='));
if (candidatePrograms.length > 1) die(2, '候选程序参数不能重复。');
if (candidatePrograms.length) {
  if (!outputReceipt || process.argv.some(a => /^--(claude|codex)-moved-from=/.test(a))) die(2, '候选验收必须单独输出记录，不能同时移动正式程序路径。');
  return require('./maintenance-candidate.cjs').preacceptCandidate({ root, config, receiptPath, outputReceipt,
    program: candidatePrograms[0].slice('--candidate-program='.length), dryRun: process.argv.includes('--dry-run') })
    .then(result => { console.log(result.out); console.log(require('./maintenance-acceptance.cjs').formatResult(result)); if (!result.ok) process.exitCode = 4; })
    .catch(() => { console.log(require('./maintenance-acceptance.cjs').formatResult({ ok: false, failureKind: { stage: 'infrastructure', kind: 'candidate-refused' } })); die(4, '候选范围核对或清理未完成，正式程序未自动接受。'); });
}
const publishCandidate = record => require('./maintenance-transaction.cjs').writeCandidateReceipt({ root, output: outputReceipt, receipt: record, config, gate })
  .then(() => { console.log('\n验收通过，候选记录已写出；正式记录未改动。'); console.log(require('./maintenance-acceptance.cjs').formatResult({ ok: true })); })
  .catch(error => die(4, error.message));

return (async () => {
const movedArgs = process.argv.filter(a => /^--(claude|codex)-moved-from=/.test(a));
if (movedArgs.length > 1) { console.error('一次只能迁移一个程序路径。'); process.exitCode = 3; return; }
if (movedArgs.some(a => a.startsWith('--codex-moved-from='))) { console.error('GPT 已退出平台，Codex 程序不再升级或迁移；它的变化不能用 refresh 验收，需要完整重新验收。'); process.exitCode = 3; return; }
const movedArg = movedArgs[0], movedField = movedArg ? (movedArg.startsWith('--claude') ? 'claudePath' : 'codexPath') : null;
const movedFrom = movedArg ? movedArg.slice(movedArg.indexOf('=') + 1) : null;
let plan;
try { plan = await require('./maintenance-refresh-plan.cjs').prepareRefresh({ root, config, receiptPath, movedField, movedFrom }, { gate }); }
catch (error) { console.error(error.message); process.exitCode = 3; return; }
const manifestPath = plan.manifestPath, runtime = plan.runtime, changed = plan.changed;
let receipt = plan.receipt;
if (!changed.length) { if (outputReceipt && !process.argv.includes('--dry-run')) return publishCandidate(await plan.finalReceipt()); console.log('所有文件都和验收时一致，不需要重新验收。'); return; }
console.log('有变化的文件：\n  ' + changed.map(f => f.path).join('\n  '));
if (process.argv.includes('--dry-run')) return;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(path.dirname(receiptPath), 'codex-security-artifacts-refresh-' + stamp);
const acceptance = require('./maintenance-acceptance.cjs');
await fs.promises.mkdir(evidenceDir, { recursive: true });
// 重试前后均重新核对完整包和所有原边界；包内新增、删除也必须保持不变。
const beforeAttempt = plan.assertUnchanged;
const accepted = await acceptance.runEvidence({ root, evidenceDir, manifestPath, requiredChecks: E2E_REQUIRED, beforeAttempt });
if (!accepted.ok) { console.log(acceptance.formatResult(accepted)); console.error(accepted.out); process.exitCode = 4; return; }
receipt = await plan.finalReceipt();
if (!outputReceipt) fs.copyFileSync(receiptPath, receiptPath + '.before-' + stamp);
const shas = new Map(changed.map((f) => [key(f.path), f.sha256]));
for (const item of receipt.fingerprints) if (shas.has(key(item.path))) item.sha256 = shas.get(key(item.path));
if (movedFrom) receipt.configurationFingerprint = gate.configurationFingerprint(config, runtime, root);
const evidence = accepted.evidence;
receipt = require('./maintenance-receipt-history.cjs').refreshedEvidence(receipt, evidence, { at: new Date().toISOString(), changed: changed.map((f) => f.path), ...(movedFrom ? { [movedField.replace('Path', 'MovedFrom')]: movedFrom } : {}), evidence,
  note: '只重新验证了回归和端到端；文件系统/网络/桌面拒绝等边界测试和人工审查沿用原结论，因为隔离模块和运行环境没有变化。' });
if (outputReceipt) {
  await require('./maintenance-transaction.cjs').writeCandidateReceipt({ root, output: outputReceipt, receipt, config, gate });
  console.log(acceptance.formatResult(accepted)); console.log('\n验收通过，候选记录已写出；正式记录未改动。'); return;
}
const tmp = receiptPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
fs.renameSync(tmp, receiptPath);

const report = gate.check(config, receiptPath, root);
if (!report.readyToEnableIsolation) {
  fs.copyFileSync(receiptPath + '.before-' + stamp, receiptPath);
  console.log(acceptance.formatResult({ ok: false, failureKind: { stage: 'boundary', kind: 'boundary' } }));
  console.error('更新后验收检查仍未通过，已恢复原记录。'); process.exitCode = 4; return;
}
console.log(acceptance.formatResult(accepted));
console.log('\n验收通过，记录已更新。重启服务后生效：node control.js restart');
})().catch(() => {
  console.log(require('./maintenance-acceptance.cjs').formatResult({ ok: false, failureKind: { stage: 'infrastructure', kind: 'acceptance-runner-error' } }));
  console.error('验收过程未完成，请检查本次证据目录；没有把未知错误当成版本故障。'); process.exitCode = 4;
});
