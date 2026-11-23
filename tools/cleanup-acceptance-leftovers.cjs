'use strict';
// 机主手动运行：清理以前验收留下的合成工作目录 data\isolation-e2e-*。
//   node tools/cleanup-acceptance-leftovers.cjs          只列出，不删除
//   node tools/cleanup-acceptance-leftovers.cjs --apply  真的删除
// 最近 6 小时内改动过的目录会跳过（可能正被一次验收使用）；维护任务正在运行时拒绝删除。
const fs = require('node:fs'), path = require('node:path');
const { listStages, removeStage } = require('./acceptance-stage.cjs');
const root = path.resolve(process.argv.find(a => a.startsWith('--root='))?.slice(7) || path.join(__dirname, '..'));
const apply = process.argv.includes('--apply');
const size = dir => { let total = 0; const walk = p => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); } else total += st.size; }; try { walk(dir); } catch {} return total; };
const day = ms => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const rows = listStages(root);
if (!rows.length) { console.log('没有验收残留目录。'); process.exit(0); }
if (apply && fs.existsSync(path.join(root, 'data', 'maintenance', 'running.lock'))) { console.log('维护任务正在运行（有 running.lock），这次不删除，稍后再试。'); process.exitCode = 1; process.exit(); }
let freed = 0, removed = 0, kept = 0;
for (const r of rows) {
  const bytes = size(r.full), mb = (bytes / 1e6).toFixed(1) + ' MB';
  if (r.recent || r.link) { kept++; console.log('跳过 ' + r.name + '（' + day(r.mtimeMs) + '，' + (r.link ? '是联接' : '6 小时内改动过') + '）'); continue; }
  if (!apply) { console.log('将删除 ' + r.name + '（' + day(r.mtimeMs) + '，' + mb + '）'); freed += bytes; continue; }
  const result = removeStage(root, r.full);
  if (result.removed) { removed++; freed += bytes; console.log('已删除 ' + r.name + '（' + mb + '）'); }
  else { kept++; console.log('没删掉 ' + r.name + '：' + result.error); }
}
console.log(apply ? `完成：删除 ${removed} 个，保留 ${kept} 个，释放约 ${(freed / 1e6).toFixed(0)} MB。` : `共 ${rows.length - kept} 个可删除，约 ${(freed / 1e6).toFixed(0)} MB；确认后加 --apply 再运行。`);
