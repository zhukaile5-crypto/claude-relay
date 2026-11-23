// 后台服务管理：node control.js start | auto-start | stop | restart | auto-restart | status
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
const LOG_FILE = path.join(ROOT, 'logs', 'relay.log');
const STOP_FLAG = path.join(ROOT, 'data', 'stopped-by-owner');
const CONTROL_LOG = path.join(ROOT, 'logs', 'control.log');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const STOP_MUTEX = 'Global\\ClaudeRelayControl-' + crypto.createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 24);

// 启停失败单独留档，不把整个编码后的 PowerShell 命令重复写入日志。
function controlError(message, error) {
  const detail = error ? [
    error.message && !/^Command failed:/.test(error.message) ? error.message : '',
    error.code ? 'code=' + error.code : '',
    Number.isInteger(error.status) ? 'status=' + error.status : '',
    error.stderr, error.stdout, error.controlOutput,
  ].filter(Boolean).map(value => String(value).trim()).filter(Boolean).join('\n').slice(-8000) : '';
  const text = message + (detail ? '\n' + detail : '');
  console.error(text);
  try {
    fs.mkdirSync(path.dirname(CONTROL_LOG), { recursive: true });
    fs.appendFileSync(CONTROL_LOG, '[' + new Date().toISOString() + '] ' + text + '\n');
  } catch (logError) { console.error('无法保存启停错误日志：' + logError.message); }
}

// Named mutexes are released by Windows even after a crash. All changing commands,
// including the watchdog's auto-start, enter the same mutex before reading intent.
function runLockedCommand(command) {
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$mutex = [Threading.Mutex]::new($false, ${psQuote(STOP_MUTEX)})
$locked = $false
try {
  try { $locked = $mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (!$locked) { throw 'Another service operation is still running; try again shortly.' }
  & ${psQuote(process.execPath)} ${psQuote(__filename)} ${psQuote(command)} '--control-lock-held'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}`;
  try { execFileSync('powershell.exe', psArgs(script), { windowsHide: true, stdio: 'inherit' }); }
  catch (e) {
    // The child already printed its reason. Do not repeat the encoded script.
    if (Number.isInteger(e.status) && e.status > 0) { process.exitCode = e.status; return; }
    throw e;
  }
}

function stoppedByOwner() {
  try { fs.statSync(STOP_FLAG); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

function readPid() {
  try {
    const p = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return Number.isInteger(p.pid) && p.pid > 0 && Number.isInteger(p.ppid) && p.ppid > 0
      && Number.isFinite(p.startedAt) && p.startedAt > 0 ? p : null;
  } catch { return null; }
}

// Keep inspection and termination in one process. Each selected process is held
// by a handle and its creation time is checked, so a recycled PID cannot be killed.
function verifiedStop(p) {
  const expected = { ...p, nodePath: process.execPath, serverPath: path.join(ROOT, 'server.js'),
    launchers: [path.join(ROOT, 'run-hidden.bat'), path.join(ROOT, '启动.bat')] };
  const encoded = Buffer.from(JSON.stringify(expected), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$held = [Collections.Generic.List[object]]::new()
$stopWarnings = [Collections.Generic.List[string]]::new()
function Finish($state, $reason, $parentStopped = $false) {
  [pscustomobject]@{ state=$state; reason=$reason; parentStopped=$parentStopped; warnings=@($stopWarnings.ToArray()) } | ConvertTo-Json -Compress
}
function Hold-Process($row) {
  $proc = [Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
  try {
    $null = $proc.Handle
    $created = $row.CreationDate.ToUniversalTime()
    if ([Math]::Abs(($proc.StartTime.ToUniversalTime() - $created).TotalMilliseconds) -gt 1) { throw 'Process identity changed' }
    $held.Add($proc)
    return $proc
  } catch { $proc.Dispose(); throw }
}
function Has-Argument([string]$line, [string]$arg) {
  $normal = $line.Replace('/', '\\')
  $pattern = '(?i)(?:^|[\\s\\x22])' + [regex]::Escape($arg.Replace('/', '\\')) + '(?=[\\s\\x22]|$)'
  return $normal -match $pattern
}
try {
  $row = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$expected.pid)
  if ($null -eq $row) { Finish 'gone' 'Recorded process no longer exists'; return }
  $node = Hold-Process $row
  $recorded = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$expected.startedAt).UtcDateTime
  $commandOk = (Has-Argument $row.CommandLine $expected.serverPath) -or (Has-Argument $row.CommandLine 'server.js')
  if ($row.Name -ine 'node.exe' -or $row.ExecutablePath -ine $expected.nodePath -or !$commandOk -or
      $row.ParentProcessId -ne [int]$expected.ppid -or $node.StartTime.ToUniversalTime() -gt $recorded) {
    Finish 'refused' 'Recorded PID does not identify this relay'; return
  }
  $parent = $null
  $parentRow = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$expected.ppid)
  if ($null -ne $parentRow -and $parentRow.Name -ieq 'cmd.exe' -and
      $parentRow.CreationDate.ToUniversalTime() -le $row.CreationDate.ToUniversalTime() -and
      (@($expected.launchers | Where-Object { Has-Argument $parentRow.CommandLine $_ }).Count -gt 0)) {
    $parent = Hold-Process $parentRow
  }
  # Capture only descendants of the verified relay, not unrelated siblings of it.
  $all = @(Get-CimInstance Win32_Process)
  $ids = [Collections.Generic.HashSet[int]]::new()
  $null = $ids.Add([int]$row.ProcessId)
  do {
    $added = $false
    foreach ($child in $all) {
      if ($ids.Contains([int]$child.ParentProcessId) -and !$ids.Contains([int]$child.ProcessId) -and
          $child.CreationDate.ToUniversalTime() -ge $row.CreationDate.ToUniversalTime()) {
        try { $null = Hold-Process $child; $null = $ids.Add([int]$child.ProcessId); $added = $true } catch { }
      }
    }
  } while ($added)
  # Stop the verified restart wrapper first, so it cannot replace Node mid-stop.
  if ($null -ne $parent -and !$parent.HasExited) { $parent.Kill() }
  if (!$node.HasExited) { $node.Kill() }
  # 主进程已终止：单个子进程退出竞争不阻断重启，但错误必须保留。
  foreach ($proc in $held) { if ($proc -ne $parent -and $proc -ne $node -and !$proc.HasExited) { try { $proc.Kill() } catch { $stopWarnings.Add(('PID ' + $proc.Id + ': ' + $_.Exception.Message)) } } }
  Finish 'stopped' 'Verified relay processes stopped' ($null -ne $parent)
} finally { foreach ($proc in $held) { $proc.Dispose() } }
`;
  const out = execFileSync('powershell.exe', psArgs(script), { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  try {
    const result = JSON.parse(out.trim());
    if (!result || typeof result.state !== 'string') throw Error('无效的停止结果');
    return result;
  }
  catch (error) {
    error.message = '停止进程的返回结果不是有效 JSON。';
    error.controlOutput = out;
    throw error;
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: config.port, path: '/', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function tailLog(n) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; }
}

async function status(knownHealth) {
  const p = readPid(), up = typeof knownHealth === 'boolean' ? knownHealth : await ping();
  console.log(up ? '● 服务正在运行' : '○ 服务没有运行');
  if (p) console.log(`  进程: ${p.pid}，启动于 ${new Date(p.startedAt).toLocaleString()}`);
  if (up) {
    console.log(`  本机地址: http://localhost:${config.port}`);
    if (config.tunnel && config.tunnel.enabled) {
      const log = tailLog(400);
      const lastStart = log.map((l, i) => (/服务已启动/.test(l) ? i : -1)).filter((i) => i >= 0).pop() || 0;
      const tunnelOk = log.slice(lastStart).some((l) => /隧道已连接/.test(l));
      console.log(`  公网地址: https://${config.tunnel.hostname}  ${tunnelOk ? '(隧道已连接)' : '(隧道未连接，看下面日志)'}`);
    }
  }
  const lines = tailLog(15);
  if (lines.length) console.log('\n最近日志（完整日志在 logs\\relay.log）：\n' + lines.map((l) => '  ' + l).join('\n'));
  return up;
}

async function stop({ manual = true, onFailure = () => {} } = {}) {
  // 机主手动停的：即使服务已退出，也要阻止看门狗再次拉起
  if (manual) fs.writeFileSync(STOP_FLAG, new Date().toISOString());
  const p = readPid();
  if (!p) {
    const up = await ping();
    if (up) controlError('服务仍在响应，但无法确认进程身份，未终止任何进程。');
    else console.log('服务没有在运行');
    return !up;
  }
  let result;
  try { result = verifiedStop(p); }
  catch (e) {
    controlError('无法安全确认或停止服务进程。' + (manual ? '人工停止标记已保留。' : '未设置人工停止标记，看门狗仍可接手。'), e);
    onFailure({ kind: 'exception', pid: p });
    return false;
  }
  if (Array.isArray(result.warnings) && result.warnings.length) controlError('停止子进程时出现异常：\n' + result.warnings.join('\n'));
  if (!['stopped', 'gone'].includes(result.state)) {
    controlError('进程身份与记录不符，未终止任何进程。' + (manual ? '人工停止标记已保留。' : '未启动另一个服务，请检查进程记录；看门狗未被禁用。'));
    onFailure({ kind: 'refused', pid: p });
    return false;
  }
  for (let i = 0; i < 20 && (await ping()); i++) await sleep(250);
  if (await ping()) { controlError('停止后端口仍有响应，未删除进程记录。'); return false; }
  // Never delete a newer instance's PID record.
  const current = readPid();
  if (current && current.pid === p.pid && current.startedAt === p.startedAt) { try { fs.rmSync(PID_FILE); } catch {} }
  console.log('服务已停止');
  return true;
}

// 失败恢复只探测进程是否存在，不凭旧 PID 终止任何进程。
function restartProcessesAbsent(recorded) {
  const current = readPid();
  const ids = new Set([recorded?.pid, recorded?.ppid, current?.pid, current?.ppid].filter(Number.isInteger));
  if (!ids.size) return false;
  for (const pid of ids) {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return true;
}

async function restart(automatic = false) {
  // 此处在控制互斥锁内：维护等待锁时新出现的人工停止必须保留。
  if (automatic && stoppedByOwner()) { console.log('服务由机主停止，跳过自动重启。'); return false; }
  // 只有机主显式重启才撤销已有的人工停止意图。
  if (!automatic) fs.rmSync(STOP_FLAG, { force: true });
  let failure;
  const stopped = await stop({ manual: false, onFailure: value => { failure = value; } });
  if (!stopped) {
    if (failure?.kind !== 'exception') return false;
    if (!restartProcessesAbsent(failure.pid) || await ping()) {
      controlError('停止失败后仍有相关进程、端口响应或无法确认退出，未启动另一个服务；看门狗未被禁用。');
      return false;
    }
    controlError('停止过程发生错误，但原服务及启动进程均已退出，继续尝试启动。');
  }
  await sleep(1000);
  // 清除旧意图后若又出现手动停止请求，仍应尊重；自动启动不会抹掉它。
  if (!(await start(true))) {
    controlError('重启未完成，请查看 logs\\control.log 和 logs\\relay.log；未新增人工停止标记。');
    return false;
  }
  return true;
}

// A first HTTP 200 does not establish a stable startup. A short disconnect resets
// the four-second window, and the overall deadline prevents an endless wait.
async function waitForReady(automatic = false) {
  const deadline = Date.now() + 20000;
  let healthySince = null;
  while (Date.now() < deadline) {
    await sleep(500);
    if (automatic && stoppedByOwner()) return false;
    const up = await ping(), now = Date.now();
    if (automatic && stoppedByOwner()) return false;
    if (now > deadline) return false;
    if (!up) { healthySince = null; continue; }
    if (healthySince === null) healthySince = now;
    if (now - healthySince >= 4000) return true;
  }
  return false;
}

async function start(automatic = false) {
  if (automatic && stoppedByOwner()) { console.log('服务由机主停止，跳过自动启动。'); return false; }
  if (!automatic) fs.rmSync(STOP_FLAG, { force: true });
  if (await ping()) { console.log('服务已经在运行了'); return status(true); }
  // Recheck after the awaited health probe; automatic recovery never clears intent.
  if (automatic && stoppedByOwner()) { console.log('服务由机主停止，跳过自动启动。'); return false; }
  // 用 wscript 隐藏窗口运行，并与当前窗口脱离，关掉当前窗口也不影响
  spawn('wscript.exe', [path.join(ROOT, 'start-hidden.vbs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.stdout.write('正在启动');
  if (await waitForReady(automatic)) { console.log('\n'); return status(true); }
  if (automatic && stoppedByOwner()) { console.log('\n服务由机主停止，跳过自动启动。'); return false; }
  console.log('\n启动失败，最近日志：\n' + tailLog(20).join('\n'));
  return false;
}

(async () => {
  const cmd = process.argv[2] || 'status';
  if (['start', 'auto-start', 'stop', 'restart', 'auto-restart'].includes(cmd) && !process.argv.includes('--control-lock-held')) return runLockedCommand(cmd);
  if (cmd === 'start') { if (!(await start())) process.exitCode = 1; }
  else if (cmd === 'auto-start') await start(true);
  else if (cmd === 'stop') { if (!(await stop())) process.exitCode = 1; }
  else if (cmd === 'restart') { if (!(await restart())) process.exitCode = 1; }
  else if (cmd === 'auto-restart') { if (!(await restart(true))) process.exitCode = 1; }
  else await status();
})().catch((e) => { controlError('启停命令失败。', e); process.exitCode = 1; });
