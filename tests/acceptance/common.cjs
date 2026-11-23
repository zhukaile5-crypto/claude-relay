'use strict';
// 完整验收探针的公共部分：合成账号、临时目录、结果文件。不读 config.json，也不用任何真实账号。
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const { createIsolation } = require('../../isolation');
const executor = require('../../isolation/executor');
function begin(name, argv = process.argv) {
  const manifest = path.resolve(argv[2] || ''), output = path.resolve(argv[3] || '');
  if (!fs.existsSync(manifest)) throw Error('需要明确的运行清单');
  if (!output.includes('codex-security-artifacts-')) throw Error('结果必须写入受管的证据目录');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, 'data', 'acceptance-' + name + '-'));
  const users = ['alice', 'bob'].map(id => ({ id, workDir: path.join(stage, id) }));
  for (const user of users) fs.mkdirSync(user.workDir, { recursive: true });
  const config = { users, academicSearch: false, isolation: { enabled: true, runtimeManifest: manifest, privateRoot: path.join(stage, 'private'), gptHome: path.join(stage, 'gpt') } };
  const iso = createIsolation(config, stage);
  const contexts = [];
  return { root, manifest, output, stage, users, config, iso, executor, contexts, context: user => { const ctx = iso.context(user); contexts.push(ctx); return ctx; }, result: { probe: name, checks: {} }, startedAt: Date.now() };
}
async function finish(run, failure) {
  const { iso, result, output, stage, root: base } = run;
  if (failure) { result.failure = failure.message || String(failure); process.exitCode = 1; }
  try { await iso.closeAll(); } catch (error) { result.failure ||= '清理失败：' + error.message; process.exitCode = 1; }
  if (Object.values(result.checks).some(value => value === false)) process.exitCode = 1;
  result.durationMs = Date.now() - run.startedAt;
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  // 只删自己建的目录；删不掉不影响结论，但要留痕。先拆工作目录视图（目录联接），不跟进目标。
  for (const ctx of new Set(run.contexts)) {
    try { fs.unlinkSync(ctx.executionRoot); fs.rmdirSync(path.dirname(ctx.executionRoot)); fs.rmSync(ctx.scratchRoot, { recursive: true, force: true }); } catch {}
  }
  const parent = path.join(base, 'data');
  if (path.dirname(stage).toLowerCase() === parent.toLowerCase() && path.basename(stage).startsWith('acceptance-')) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { console.log('临时目录未能删除：' + path.basename(stage)); }
  }
  console.log(JSON.stringify({ probe: result.probe, failure: result.failure, checks: result.checks, durationMs: result.durationMs }));
}
const cleanupOk = value => value?.confirmedExited === true && value?.pidAbsent === true;
const absent = pid => { if (!pid) return true; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 工作进程再启动普通和分离的子进程，都持续写心跳文件：用来证明整棵进程树都停了。
const HEARTBEAT = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const dir=path.resolve(input.dir);fs.mkdirSync(dir,{recursive:true});
const leaf="const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'.pid',String(process.pid));setInterval(()=>fs.appendFileSync(process.argv[1],'.'),40);";
for(const [i,detached] of [[0,false],[1,true]]){const p=cp.spawn(process.execPath,['-e',leaf,path.join(dir,'leaf'+i)],{detached,windowsHide:true,stdio:'ignore'});p.unref();}
fs.writeFileSync(path.join(dir,'worker.pid'),String(process.pid));setInterval(()=>fs.appendFileSync(path.join(dir,'worker'),'.'),40);
`;
async function waitHeartbeat(dir, ms = 30000) {
  const names = ['worker', 'leaf0', 'leaf1'], until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const ready = names.every(name => fs.statSync(path.join(dir, name)).size > 0 && fs.existsSync(path.join(dir, name + '.pid')));
      if (ready) return names.map(name => Number(fs.readFileSync(path.join(dir, name + '.pid'), 'utf8')));
    } catch {}
    await sleep(100);
  }
  throw Error('工作进程没有开始心跳');
}
async function heartbeatStopped(dir) {
  const sizes = () => ['worker', 'leaf0', 'leaf1'].map(name => fs.statSync(path.join(dir, name)).size);
  const first = sizes(); await sleep(600);
  return JSON.stringify(first) === JSON.stringify(sizes());
}
async function allAbsent(pids, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pids.every(absent)) return true; await sleep(100); }
  return pids.every(absent);
}
module.exports = { begin, finish, cleanupOk, absent, sleep, HEARTBEAT, waitHeartbeat, heartbeatStopped, allAbsent };
