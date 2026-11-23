// 服务看门狗：计划任务 ClaudeRelayServiceWatchdog 每 5 分钟（以及登录时）跑一次，经 service_watchdog.vbs 隐藏运行。
// 服务正常就不处理；受限时交给严格的 repair；不在就用 auto-start 拉起，不清除人工停止标记。
// 为什么需要：run-hidden.bat 只能在 node 崩溃后重启它，若整个隐藏的启动窗口被系统关掉（10-27 17:46 官方 Claude
// 自动更新时，Windows 把它当成卡死的 cmd.exe 关了），就没有任何东西会再启动服务，网站一直显示「Claude 在睡觉」。
// 机主用「停止服务.bat」手动停的（data/stopped-by-owner 存在）不管。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const maintenanceDispatch = require('./maintenance-dispatch.cjs');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'watchdog.log');
const port = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || 8765;
const log = (m) => { try { fs.appendFileSync(LOG, `[${new Date().toLocaleString()}] ${m}\n`); } catch {} };
const stoppedByOwner = () => {
  try { fs.statSync(path.join(ROOT, 'data', 'stopped-by-owner')); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};

const ping = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

const power = () => new Promise(resolve => {
  let finished = false;
  const finish = value => { if (!finished) { finished = true; resolve(value); } };
  const req = http.get({ host: '127.0.0.1', port, path: '/local/power', timeout: 5000 }, res => {
    if (res.statusCode !== 200) { res.resume(); finish(null); return; }
    let body = '';
    res.on('data', bytes => { body += bytes.toString('utf8'); if (body.length > 65536) { req.destroy(); finish(null); } });
    res.on('error', () => finish(null));
    res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
  });
  req.on('error', () => finish(null));
  req.on('timeout', () => { req.destroy(); finish(null); });
});
async function handleRunning() {
  if (!await ping()) return false;
  const state = await power();
  if (state && !stoppedByOwner()) {
    if (state.isolationBlocked === true) {
      log('发现受限状态 → 排入严格修复请求');
      await maintenanceDispatch.requestRepair(ROOT);
    }
    // 此看门狗真实上限只有5分钟；既有版本维护任务上限2小时，由它持锁处理。
    if (!stoppedByOwner() && !await maintenanceDispatch.startScheduled()) log('无法发起维护任务，请求保留供下一轮巡检处理。');
  }
  return true;
}

(async () => {
  if (stoppedByOwner()) return; // 手动停的，不管
  if (await handleRunning()) return;
  // 可能正好在 run-hidden.bat 的 5 秒重启间隙里：等一会儿再看一次，免得重复启动
  await new Promise((r) => setTimeout(r, 15000));
  if (stoppedByOwner()) return;
  if (await handleRunning()) return;
  if (stoppedByOwner()) return;
  log('服务没在运行 → 启动');
  execFile(process.execPath, [path.join(ROOT, 'control.js'), 'auto-start'], { cwd: ROOT, windowsHide: true, timeout: 300000 }, async (err, stdout) => {
    log((await ping()) ? '已恢复' : '启动后仍未运行，control.js 输出：' + String(stdout || err || '').split('\n').slice(-5).join(' | '));
  });
})().catch(() => log('巡检未能完成，请查看维护记录；没有请求重启。'));
