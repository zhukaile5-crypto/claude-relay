# 定时巡检（任务计划程序在北京时间 08:00–00:45 每 15 分钟运行一次，睡眠中也会把电脑叫醒）。规则：
#   1. 每次都去 Cloudflare 查有没有叫醒命令。
#   2. 有 → 保持清醒，直到下一次睡眠（之后的巡检照常查，但不改变清醒状态）。
#   3. 没有，而且这次是巡检把电脑叫醒的（这次醒来后也没人叫过）→ 睡回去。
#      电脑是机主自己开的（按电源键等）就一直开着，只有机主按睡眠才睡。
#      保护：巡检叫醒后如果网页上有人用过（只算这次醒来之后的）/ 有回复在进行，不睡。
# 「直到下一次睡眠」的判断：服务记下被叫的时间；它晚于系统最近一次醒来的时间，说明从那以后没睡过。
param([switch]$DryRun, [double]$UserIdleMin = 10, [int]$WebIdleMin = -1, [switch]$AssumeTimerWake)  # 后三个只用于测试
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'logs\wake.log'
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m) -Encoding utf8 }

Add-Type -Name N -Namespace W -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint s);
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
'@
# 巡检期间先别让系统睡过去（被定时器叫醒后，Windows 约 2 分钟没人碰就会自己睡）
[W.N]::SetThreadExecutionState([uint32]2147483649) | Out-Null

$cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding utf8 | ConvertFrom-Json
$webIdle = if ($WebIdleMin -ge 0) { $WebIdleMin } else { [int]$cfg.wake.idleMinutes }
$api = 'http://127.0.0.1:8765/local'

# 最近一次从睡眠醒来：什么时候、是不是巡检任务叫醒的
$resumeMs = 0; $resumedMin = 99999; $byPatrol = $false
$e = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; Id = 1 } -MaxEvents 1 -ErrorAction SilentlyContinue
if ($e) {
  $resumeMs = [DateTimeOffset]::new($e.TimeCreated.ToUniversalTime()).ToUnixTimeMilliseconds()
  $resumedMin = ((Get-Date) - $e.TimeCreated).TotalMinutes
  $byPatrol = $e.Message -match 'ClaudeRelayWake'   # 唤醒源是巡检任务
}
# 机主多久没碰键盘鼠标（Windows 醒来时会把它重置成醒来那一刻，所以「醒来后没碰过」≈ 它和醒来时长差不多）
$li = New-Object W.N+LASTINPUTINFO; $li.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($li); [void][W.N]::GetLastInputInfo([ref]$li)
$userIdle = ([Environment]::TickCount - [int]$li.dwTime) / 60000
# 这次清醒是巡检叫起来的：唤醒源是巡检任务，而且醒来后机主没碰过电脑（不管醒了多久）
$patrolSession = $byPatrol -and ($userIdle -ge $resumedMin - 1)
if ($AssumeTimerWake) { $patrolSession = $true }

# 1. 查叫醒命令（刚醒时网络可能还没连上，最多等 60 秒）
$wake = $null
for ($t = 0; $t -lt 12 -and $null -eq $wake; $t++) {
  try { $wake = Invoke-RestMethod -Uri ("{0}/poll?key={1}" -f $cfg.wake.url, $cfg.wake.pcKey) -TimeoutSec 8 } catch { Start-Sleep -Seconds 5 }
}
# 2. 有 → 保持清醒，直到下一次睡眠
if ($wake -and $wake.wake) {
  Log ("收到叫醒命令（{0:N0} 分钟前按的）→ 保持清醒，直到下一次睡眠" -f (($wake.now - $wake.requestedAt) / 60000))
  try { Invoke-RestMethod -Method Post -Uri "$api/touch?sticky=1" -TimeoutSec 5 | Out-Null } catch { Log '中转服务没响应' }
  exit 0
}
if ($null -eq $wake) { Log '连不上 Cloudflare，这次查不到叫醒命令' }

$power = $null
try { $power = Invoke-RestMethod -Uri "$api/power" -TimeoutSec 5 } catch {}
if ($cfg.wake.alwaysAwake) { Log '没有叫醒命令；设置为一直开着，不睡'; exit 0 }
# 这次醒来之后有人叫过 → 继续清醒
if ($power -and $power.stayAwake -and [double]$power.stayAwakeSince -ge $resumeMs) { Log '没有新命令；这次醒来后有人叫过 → 继续清醒'; exit 0 }

# 3. 没有命令：只有「这次是巡检把电脑叫醒的」才睡回去。电脑是机主自己开的（按电源键等），就一直开着，只等机主自己按睡眠
if (-not $patrolSession) { Log '没有叫醒命令；电脑是机主自己开的 → 不睡（只有机主按睡眠才睡）'; exit 0 }
if ($power -and $power.running -gt 0) { Log "没有叫醒命令；有 $($power.running) 个回复在进行 → 不睡"; exit 0 }
# 自动维护（tools/maintain.cjs）正在验收或升级，睡了会让它失败。锁里是进程号，进程不在了就当没有
$maintLock = Join-Path $root 'data\maintenance\running.lock'
if ((Test-Path $maintLock) -and (Get-Process -Id ([int](Get-Content $maintLock -Raw)) -ErrorAction SilentlyContinue)) { Log '没有叫醒命令；自动维护正在进行 → 不睡'; exit 0 }
# 这次醒来之后网页上有人用过（睡前的活动不算）
if ($power -and [double]$power.lastActivityAt -ge $resumeMs -and $WebIdleMin -ne 0) { Log '没有叫醒命令；这次醒来后网页上有人在用 → 不睡'; exit 0 }

Log '巡检把电脑叫醒，没有叫醒命令 → 睡回去'
if ($DryRun) { Log '（演练模式，不真的睡）'; exit 0 }
try { Invoke-RestMethod -Method Post -Uri "$api/sleeping" -TimeoutSec 5 | Out-Null } catch {}   # 清掉之前的「一直清醒」
[W.N]::SetThreadExecutionState([uint32]2147483648) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)
