'use strict';
// parentDeath：只杀启动任务的那个 Node 进程，整棵隔离进程树也要在几秒内全部停止。
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { begin, finish, HEARTBEAT, waitHeartbeat, heartbeatStopped, allAbsent, sleep } = require('./common.cjs');
if (process.argv[2] === '--owner') {
  // 被杀的父进程：用同一份配置启动任务，报告进程号后一直等着。
  const { config, stage, label } = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const { createIsolation } = require('../../isolation'), executor = require('../../isolation/executor');
  const iso = createIsolation(config, stage), ctx = iso.context(config.users[0]);
  const handle = executor.startNode(ctx, HEARTBEAT, { input: { dir: label }, timeoutMs: 120000, maxOutputBytes: 2000 });
  const report = () => { if (handle.keeper) fs.writeFileSync(path.join(path.dirname(process.argv[3]), 'owner-ready.json'), JSON.stringify({ workspace: ctx.workspaceRoot, host: handle.child.pid, keeper: handle.keeper.pid })); else setTimeout(report, 50); };
  report();
  setInterval(() => {}, 1000);
} else {
  const run = begin('parent-death'), { result, config, stage } = run;
  (async () => {
    let owner;
    try {
      const label = 'parent-death', control = path.join(stage, 'owner-control');
      fs.mkdirSync(control);
      const file = path.join(control, 'owner.json');
      fs.writeFileSync(file, JSON.stringify({ config, stage, label }));
      owner = cp.spawn(process.execPath, [__filename, '--owner', file], { cwd: run.root, windowsHide: true, stdio: 'ignore' });
      const readyFile = path.join(control, 'owner-ready.json'), until = Date.now() + 30000;
      while (!fs.existsSync(readyFile)) { if (Date.now() > until) throw Error('父进程没有准备好'); await sleep(100); }
      const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')), dir = path.join(ready.workspace, label);
      const workers = await waitHeartbeat(dir);
      result.checks.workerStarted = workers.every(pid => Number.isInteger(pid) && pid > 0);
      const killedAt = Date.now();
      owner.kill(); // 只杀父进程。
      const pids = [owner.pid, ready.host, ready.keeper, ...workers];
      result.checks.treeStopped = await allAbsent(pids, 10000);
      result.elapsedMs = Date.now() - killedAt;
      result.checks.heartbeatStopped = await heartbeatStopped(dir);
    } catch (error) { if (owner?.exitCode === null) owner.kill(); await finish(run, error); return; }
    await finish(run);
  })();
}
