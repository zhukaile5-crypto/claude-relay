'use strict';
// cancellation：主动取消和超时都要停掉整棵进程树（包括分离的子进程），之后同一账号还能正常运行新任务。
const path = require('node:path');
const { begin, finish, cleanupOk, HEARTBEAT, waitHeartbeat, heartbeatStopped, allAbsent } = require('./common.cjs');
const run = begin('cancel'), { result, executor, users } = run;
async function scenario(ctx, label, options, stop) {
  const dir = path.join(ctx.workspaceRoot, label);
  const handle = executor.startNode(ctx, HEARTBEAT, { input: { dir: label }, maxOutputBytes: 2000, ...options });
  const pids = await waitHeartbeat(dir);
  stop?.();
  const finished = await handle.result;
  const stopped = await allAbsent(pids);
  result[label] = { cancelled: finished.cancelled, exitCode: finished.exitCode, error: finished.error, cleanup: finished.cleanup, stopped };
  // 超时由执行层结束任务，退出码非 0 但 cancelled 不一定为真；两种情况都不能算正常完成。
  return { tree: stopped && (finished.cancelled === true || finished.exitCode !== 0) && cleanupOk(finished.cleanup), heartbeat: await heartbeatStopped(dir) };
}
(async () => {
  try {
    const ctx = run.context(users[0]), abort = new AbortController();
    const aborted = await scenario(ctx, 'abort', { signal: abort.signal, timeoutMs: 60000 }, () => abort.abort());
    result.checks.abortStopsTree = aborted.tree; result.checks.abortHeartbeatStopped = aborted.heartbeat;
    const timed = await scenario(ctx, 'timeout', { timeoutMs: 4000 });
    result.checks.timeoutStopsTree = timed.tree; result.checks.timeoutHeartbeatStopped = timed.heartbeat;
    const normal = await executor.executeNode(ctx, "process.stdout.write('AFTER_CANCEL_OK')", { timeoutMs: 20000, maxOutputBytes: 200 });
    result.checks.normalRunAfterCancel = normal.exitCode === 0 && normal.stdout.toString() === 'AFTER_CANCEL_OK' && cleanupOk(normal.cleanup);
  } catch (error) { await finish(run, error); return; }
  await finish(run);
})();
