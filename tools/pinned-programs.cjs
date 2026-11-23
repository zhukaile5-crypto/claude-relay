'use strict';
// Gemini 的固定程序（config.agyPath）会被它自带的更新程序换掉：启动时已经设了 AGY_CLI_DISABLE_AUTO_UPDATE，对现在的版本
// 不起作用；只读属性也挡不住（2026-11-21 两次实测）。换掉以后网站照常能用，但服务一重启，验收核对不过，就进受限模式。
// 这里的办法是「换掉了就换回来」：固定程序和验收记录一致时，留一份底本（data/maintenance/pinned/<sha256>.bin）；
// 不一致时，如果底本的校验值和验收记录一致，就用底本换回去。正在运行的程序换不动，下次再试。
// 调用的地方：服务启动前（start-hidden.vbs）、服务退出后重开前（run-hidden.bat）、每次定时维护开始时（maintain.cjs）。
// 这个文件、启动脚本和 maintain.cjs 都不在验收指纹里；它只会把文件恢复成验收记录认的那一份，绝不放进别的内容。
// 例外——完整验收期间不换回去（2026-11-23）：agy 一运行就自己升级，完整验收要用它跑两步；如果这边每五分钟把它换回旧版，
// 验收绑定的文件就一直在变，永远跑不完（当晚实测两轮都因此作废）。所以机主同意跑完整验收时，full-acceptance.cjs 会写一个
// 有期限的记号 data/maintenance/acceptance-hold.json（最长 6 小时，过期自动失效），记号有效期间 restore 什么都不做（返回 held）。
// 验收写好新记录（write）或放弃（release）时记号删掉；新记录认的是升级后的 agy，之后照旧「换掉了就换回来」。
//   node tools/pinned-programs.cjs restore   恢复（没事发生时不出声）
//   node tools/pinned-programs.cjs status    只看现在是什么状态
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha256 = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * 结果：not-configured（没配置固定程序）、no-record（验收记录里没有它）、ok（一致）、restored（换回去了）、
 * busy（正在运行，换不动）、no-baseline（没有底本）、baseline-corrupt（底本和记录不一致，没动固定程序）。
 * dryRun 为真时不写任何文件，不一致时返回 drift。
 */
async function restore({ root, config, dryRun = false, log = () => {}, deps = {} } = {}) {
  const hash = deps.hash || sha256, rename = deps.rename || fsp.rename;
  const pinned = config?.agyPath;
  if (typeof pinned !== 'string' || !path.isAbsolute(pinned)) return 'not-configured';
  if (holdActive(root, deps.now ? deps.now() : Date.now())) return 'held';
  const receipt = readJson(config.isolation?.receipt || path.join(root, 'data', 'isolation', 'acceptance.json'));
  const expected = receipt?.fingerprints?.find(item => typeof item?.path === 'string' && same(item.path, pinned))?.sha256;
  if (!/^[a-f0-9]{64}$/.test(expected || '')) return 'no-record';
  const dir = path.join(root, 'data', 'maintenance', 'pinned'), baseline = path.join(dir, expected + '.bin'), stateFile = path.join(dir, 'state.json');
  let stat = null; try { stat = await fsp.stat(pinned); } catch { /* 更新程序换到一半时文件可能暂时不在 */ }
  // 上次核对过、之后大小和修改时间都没变：不再算一遍校验值（两亿多字节，每五分钟算一次没有必要）
  const state = readJson(stateFile);
  const unchanged = stat && state?.sha256 === expected && state.size === stat.size && state.mtimeMs === stat.mtimeMs && fs.existsSync(baseline);
  if (unchanged) return 'ok';
  if (stat && await hash(pinned) === expected) {
    if (dryRun) return 'ok';
    await fsp.mkdir(dir, { recursive: true });
    if (!fs.existsSync(baseline) || await hash(baseline) !== expected) {
      const temp = baseline + '.tmp-' + process.pid;
      await fsp.copyFile(pinned, temp); await fsp.rename(temp, baseline);
      for (const name of await fsp.readdir(dir)) if (/^[a-f0-9]{64}\.bin$/.test(name) && name !== expected + '.bin') await fsp.rm(path.join(dir, name), { force: true });
      log('已为 Gemini 的固定程序留好底本。');
    }
    await fsp.writeFile(stateFile, JSON.stringify({ path: pinned, sha256: expected, size: stat.size, mtimeMs: stat.mtimeMs }));
    return 'ok';
  }
  if (dryRun) return 'drift';
  if (!fs.existsSync(baseline)) { log('Gemini 的固定程序和验收记录不一致，没有底本可以恢复。'); return 'no-baseline'; }
  const temp = pinned + '.restore-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    await fsp.copyFile(baseline, temp);
    if (await hash(temp) !== expected) { log('Gemini 固定程序的底本和验收记录不一致，没有动固定程序。'); return 'baseline-corrupt'; }
    try { await rename(temp, pinned); }
    catch (error) { if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return 'busy'; throw error; }
  } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
  const after = await fsp.stat(pinned);
  await fsp.writeFile(stateFile, JSON.stringify({ path: pinned, sha256: expected, size: after.size, mtimeMs: after.mtimeMs }));
  log('Gemini 的固定程序被换掉了，已恢复成验收时的那一份。');
  return 'restored';
}
// 完整验收期间的记号：{ until: 到期时间（毫秒）, approved: 机主同意的说明, at }。只认还没到期、而且离到期不超过 6 小时的；读不出来就当没有
const HOLD_MAX_MS = 6 * 3600e3;
const holdFile = root => path.join(root, 'data', 'maintenance', 'acceptance-hold.json');
function holdActive(root, now = Date.now()) {
  const hold = readJson(holdFile(root));
  return !!hold && Number.isFinite(hold.until) && typeof hold.approved === 'string' && hold.approved.trim().length >= 4 && now < hold.until && hold.until - now <= HOLD_MAX_MS;
}
function setHold(root, approved, ms = 3 * 3600e3, now = Date.now()) {
  if (typeof approved !== 'string' || approved.trim().length < 4) throw Error('需要机主同意的说明');
  fs.mkdirSync(path.dirname(holdFile(root)), { recursive: true });
  fs.writeFileSync(holdFile(root), JSON.stringify({ until: now + Math.min(ms, HOLD_MAX_MS), approved: approved.trim().slice(0, 400), at: new Date(now).toISOString() }));
}
const clearHold = root => fs.rmSync(holdFile(root), { force: true });
module.exports = { restore, holdActive, setHold, clearHold, HOLD_MAX_MS };

if (require.main === module) {
  const root = path.resolve(__dirname, '..'), command = process.argv[2] || 'status';
  const stamp = () => '[' + new Date().toLocaleString() + '] ';
  (async () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const result = await restore({ root, config, dryRun: command !== 'restore', log: line => console.log(stamp() + line) });
    if (command !== 'restore') console.log(result);
  })().catch(error => { console.log(stamp() + '固定程序自动恢复未完成：' + (error.code || error.message)); }); // 永远不拦着服务启动
}
