'use strict';
// networkDeny：本机监听器先用宿主连通做正向对照，再证明隔离任务连不上，监听器也没收到连接。
const fs = require('node:fs'), net = require('node:net');
const { filesystemPolicy } = require('../../isolation');
const { begin, finish, cleanupOk, sleep } = require('./common.cjs');
const run = begin('network'), { result, executor, users } = run;
async function listener(host, family) {
  const state = { host, family, trustedAccepts: 0, workerAccepts: 0, phase: 'trusted' };
  state.server = net.createServer(socket => { state[state.phase === 'worker' ? 'workerAccepts' : 'trustedAccepts']++; socket.on('error', () => {}); socket.end('SYNTHETIC'); });
  try { await new Promise((resolve, reject) => { state.server.once('error', reject); state.server.listen({ host, port: 0, ipv6Only: family === 6 }, resolve); }); }
  catch (error) { if (family === 6) { state.unsupported = error.code; return state; } throw error; }
  state.port = state.server.address().port;
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port: state.port }); let connected = false;
      socket.setTimeout(3000, () => { socket.destroy(); reject(Error('对照连接超时')); });
      socket.once('connect', () => { connected = true; }); socket.on('data', () => {}); socket.once('error', reject);
      socket.once('close', () => connected ? resolve() : reject(Error('对照连接失败')));
    });
    state.trusted = true;
  } catch (error) { if (family !== 6) throw error; state.controlFailure = error.code || error.message; }
  state.phase = 'worker';
  return state;
}
const WORKER = "const net=require('node:net');const rows=await Promise.all(input.endpoints.map(e=>new Promise(resolve=>{const s=net.connect({host:e.host,port:e.port,family:e.family});let done=false;const finish=v=>{if(done)return;done=true;s.destroy();resolve({...e,...v});};s.once('connect',()=>finish({connected:true}));s.once('error',x=>finish({connected:false,code:x.code}));s.setTimeout(3000,()=>finish({connected:false,code:'TIMEOUT'}));})));process.stdout.write(JSON.stringify(rows));";
(async () => {
  const listeners = [];
  try {
    listeners.push(await listener('127.0.0.1', 4), await listener('::1', 6));
    const ctx = run.context(users[0]);
    result.checks.physicalRuntime = fs.realpathSync.native(ctx.desktopHost).toLowerCase() === ctx.desktopHost.replace(/\//g, '\\').toLowerCase();
    result.checks.policyDisabled = filesystemPolicy(ctx).includes('[permissions.relay.network]\nenabled = false');
    const r = await executor.executeNode(ctx, WORKER, { input: { endpoints: listeners.filter(item => item.trusted).map(({ host, port, family }) => ({ host, port, family })) }, timeoutMs: 15000, maxOutputBytes: 3000 });
    if (r.exitCode !== 0) throw Error('隔离任务没有运行：' + (r.error || r.stderr));
    result.workerResults = JSON.parse(r.stdout.toString());
    await sleep(150);
    for (const state of listeners) {
      result[state.family === 6 ? 'ipv6' : 'ipv4'] = { trusted: !!state.trusted, unsupported: state.unsupported, controlFailure: state.controlFailure, trustedAccepts: state.trustedAccepts, workerAccepts: state.workerAccepts };
      if (!state.trusted) continue; // 没有正向对照时不声称验证过 IPv6，记录里的限制说明保持不变。
      const row = result.workerResults.find(item => item.family === state.family), name = 'ipv' + state.family;
      result.checks[name + 'TrustedControl'] = state.trustedAccepts === 1;
      result.checks[name + 'WorkerDenied'] = row.connected === false && ['EACCES', 'EPERM'].includes(row.code) && state.workerAccepts === 0;
    }
    result.checks.cleanupConfirmed = cleanupOk(r.cleanup);
  } catch (error) { await finish(run, error); return; }
  finally { for (const state of listeners) if (state.server.listening) await new Promise(resolve => state.server.close(resolve)); }
  await finish(run);
})();
