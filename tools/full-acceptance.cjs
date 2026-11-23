'use strict';
// 完整边界验收入口：改了隔离模块、运行环境或核对代码之后，refresh 会拒绝，要用这个工具重新跑全部 REQUIRED。
// 它会真实启动隔离进程、花模型额度，所以 run 必须写明机主同意。工具本身不重启服务。
//
//   node tools/full-acceptance.cjs plan                            只读：列步骤、绑定值和当前进度
//   node tools/full-acceptance.cjs run --owner-approved="说明"     运行还没通过的步骤，可重复运行以继续
//     [--only=voice,research]                                      只跑指定步骤
//     [--acknowledge=desktop --reason="机器睡眠导致"]              确认某次边界失败来自基础设施，才允许重跑；原因写进记录
//   node tools/full-acceptance.cjs review --file=审查.md           记录独立审查，文件要含 Commit/Binding/Reviewer/Verdict/Disposition
//   node tools/full-acceptance.cjs write [--dry-run]               全部通过后生成并安装验收记录；之后用 maintain.cjs deploy --restart 上线
//   node tools/full-acceptance.cjs hold --owner-approved="说明"    验收开始前先立记号：期间不把 Gemini 的固定程序换回旧版（见 pinned-programs.cjs）；run 会自动续上
//   node tools/full-acceptance.cjs release                         放弃这一轮：删掉记号，定时维护恢复「换掉了就换回来」
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const core = require('./full-acceptance-core.cjs'), tx = require('./maintenance-transaction.cjs'), inspect = require('./maintenance-inspect.cjs');
const root = path.resolve(__dirname, '..');
const option = (args, name) => { const hit = args.find(arg => arg.startsWith('--' + name + '=')); return hit ? hit.slice(name.length + 3) : undefined; };
function deps() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  if (config.isolation?.enabled !== true) throw Error('隔离没有启用，不需要完整验收。');
  return { root, config, runtime: JSON.parse(fs.readFileSync(config.isolation.runtimeManifest, 'utf8')), gate: require('./check-isolation.cjs'),
    receiptPath: config.isolation.receipt || path.join(root, 'data', 'isolation', 'acceptance.json'),
    gitState: () => inspect.gitState(root), now: () => Date.now(), log: message => console.log(message),
    runStep: ({ script, args, logFile, timeoutMs }) => new Promise(resolve => {
      const log = fs.openSync(logFile, 'wx');
      const child = cp.spawn(process.execPath, [script, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', log, log] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      const done = status => { clearTimeout(timer); fs.closeSync(log); resolve({ status, timedOut }); };
      child.once('error', () => done(null)); child.once('close', done);
    }) };
}
(async () => {
  const [command, ...args] = process.argv.slice(2), d = deps();
  if (command === 'plan') {
    const plan = await core.plan(d);
    console.log('提交：' + (plan.head || '未知') + '\n绑定：' + (plan.binding || '未知') + '\n运行文件：' + plan.fileCount);
    for (const step of core.STEPS) { const row = plan.steps.find(item => item.id === step.id);
      console.log((row?.passed ? '[通过] ' : row?.poisoned ? '[边界失败] ' : row?.attempts ? '[未通过] ' : '[未运行] ') + step.id + ' → ' + step.covers.join('、') + (step.costly ? '（花模型额度）' : '')); }
    console.log((plan.review ? '[通过] ' : '[未运行] ') + core.REVIEW_CHECK);
    for (const problem of plan.problems) console.log('问题：' + problem);
    process.exitCode = plan.problems.length ? 1 : 0; return;
  }
  const pinned = require('./pinned-programs.cjs');
  if (command === 'hold') { pinned.setHold(root, option(args, 'owner-approved')); console.log('已立记号：完整验收期间不把 Gemini 的固定程序换回旧版（最长 3 小时）。'); return; }
  if (command === 'release') { pinned.clearHold(root); console.log('已删掉记号。'); return; }
  if (!['run', 'review', 'write'].includes(command)) { console.error('用法见文件开头的说明。'); process.exitCode = 2; return; }
  // 与自动维护共用一把锁：验收期间不升级、不重启，也不会让电脑自动睡眠。
  const maintenance = path.join(root, 'data', 'maintenance'), lease = await tx.acquireLock({ state: path.join(maintenance, 'version-check.json'), lock: path.join(maintenance, 'running.lock') });
  if (!lease) { console.error('另一个维护任务正在运行，稍后再试。'); process.exitCode = 1; return; }
  try {
    if (command === 'run') {
      const acknowledge = option(args, 'acknowledge');
      if ((option(args, 'owner-approved') || '').trim().length >= 4) pinned.setHold(root, option(args, 'owner-approved')); // 机主同意了才立记号；没写同意的话 runSteps 自己会拒绝
      const result = await core.runSteps({ ownerApproved: option(args, 'owner-approved'), only: option(args, 'only')?.split(',').filter(Boolean),
        acknowledge: acknowledge ? { [acknowledge]: option(args, 'reason') } : undefined }, d);
      console.log('结果：' + result.result); process.exitCode = result.result === 'all-passed' ? 0 : 1;
    } else if (command === 'review') {
      const review = await core.recordReview({ file: path.resolve(option(args, 'file') || '') }, d);
      console.log('已记录审查：' + review.reviewer);
    } else {
      const result = await core.writeReceipt({ dryRun: args.includes('--dry-run') }, d);
      if (result.result === 'installed') pinned.clearHold(root); // 新记录认的是现在这份 agy，之后照旧「换掉了就换回来」
      console.log('结果：' + result.result + (result.result === 'installed' ? '。下一步：node tools/maintain.cjs deploy --restart' : ''));
    }
  } finally { await tx.releaseLock(lease); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
