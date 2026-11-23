'use strict';
// ocr、scientific、html、gpu、eve：在隔离任务里运行真实的固定工具和科研环境，只用合成数据。
const fs = require('node:fs'), path = require('node:path');
const { begin, finish, cleanupOk } = require('./common.cjs');
const role = process.argv[4];
if (!['docs', 'html', 'gpu', 'eve'].includes(role)) throw Error('未知探针角色');
const run = begin('python-' + role, process.argv.slice(0, 4)), { result, executor, users } = run;
const WORKER = "const cp=require('node:child_process');const r=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c',input.script],{input:JSON.stringify(input.request),encoding:'utf8',windowsHide:true,timeout:input.timeout,maxBuffer:8*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status===0?0:1;";
(async () => {
  try {
    const ctx = run.context(users[0]), rt = ctx.runtime;
    const interpreter = { docs: rt.python, html: rt.python, gpu: rt.gpuPython, eve: rt.evePython }[role];
    const script = fs.readFileSync(path.join(__dirname, 'runtime-probe.py'), 'utf8');
    const r = await executor.executeNode(ctx, WORKER, { input: { python: interpreter, script, timeout: 600000, request: { role, runtime: rt.runtimeRoot } }, timeoutMs: 660000, maxOutputBytes: 8 * 1024 * 1024 });
    const stdout = r.stdout.toString(), line = stdout.split(/\r?\n/).find(text => text.startsWith('RUNTIME_PROBE_RESULT '));
    result.stderr = String(r.stderr || '').slice(-2000);
    if (r.exitCode !== 0 || !line) throw Error('探针失败：' + (r.error || String(r.stderr || '').slice(-1500)));
    const report = JSON.parse(line.slice('RUNTIME_PROBE_RESULT '.length));
    result.report = report;
    Object.assign(result.checks, report.checks);
    result.checks.cleanupConfirmed = cleanupOk(r.cleanup);
  } catch (error) { await finish(run, error); return; }
  await finish(run);
})();
