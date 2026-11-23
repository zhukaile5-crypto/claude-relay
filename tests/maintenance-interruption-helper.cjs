'use strict';
// 这个文件只由测试 fork，生产 CLI 不引用它。
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { runMaintenance } = require('../tools/maintain.cjs'), { dependencies } = require('./maintenance-fixture.cjs');
const [directory, point] = process.argv.slice(2), { d, p } = dependencies(directory);
const hold = () => new Promise(() => { setInterval(() => {}, 1000); });
d.onPhase = async (phase, transaction) => {
  if (point !== 'accepting' && phase === point) { process.send({ checkpoint: phase, transaction }); await hold(); }
};
if (point === 'accepting') d.accept = async ({ outputReceipt }) => {
  // 故意让合成验收子进程活过父进程，以验证它晚写也只能碰候选文件。
  const code = "const fs=require('fs');const [out,release,done]=process.argv.slice(1);let n=0;const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);fs.writeFileSync(out,'new-receipt');fs.writeFileSync(done,'done');}else if(++n>600){clearInterval(timer);process.exitCode=1}},50);";
  const child = cp.spawn(process.execPath, ['-e', code, outputReceipt, p('release-late'), p('late-done')], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  process.send({ checkpoint: 'accepting', outputReceipt, latePid: child.pid });
  return hold();
};
runMaintenance('version-check', { force: true }, d).then(result => { process.send?.({ unexpectedResult: result }); process.exitCode = 2; }).catch(error => { process.send?.({ failure: error.message }); process.exitCode = 2; });
