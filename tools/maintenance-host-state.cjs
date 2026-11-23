'use strict';
// M8：只读电源事件的固定元数据，不读取/返回事件正文、设备、用户名或唤醒来源。
// Get-WinEvent筛选契约：https://learn.microsoft.com/powershell/module/microsoft.powershell.diagnostics/get-winevent
// RecordId契约：https://learn.microsoft.com/dotnet/api/system.diagnostics.eventing.reader.eventlogrecord.recordid
// 2026-11-01只读本机提供者静态schema确认：Kernel-Power 42/107/506/507与Power-Troubleshooter 1的System通道。
// 这里只检测已写入日志的转换；日志不可读、无记录或输出不符合固定结构时拒绝给出可用快照。
const cp = require('node:child_process'), path = require('node:path'), crypto = require('node:crypto');
const MAX_OUTPUT_BYTES = 2048, DEFAULT_TIMEOUT_MS = 5000;
const QUERY_SCRIPT = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';",
  "try {",
  "  $log = Microsoft.PowerShell.Diagnostics\\Get-WinEvent -ListLog System -ErrorAction Stop;",
  "  if (-not $log.IsEnabled) { exit 2 };",
  "  $filters = @(@{LogName='System';ProviderName='Microsoft-Windows-Kernel-Power';Id=@(42,107,506,507)},@{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1});",
  "  $event = Microsoft.PowerShell.Diagnostics\\Get-WinEvent -FilterHashtable $filters -MaxEvents 1 -ErrorAction Stop;",
  "  if ($null -eq $event.RecordId -or $null -eq $event.TimeCreated) { exit 2 };",
  "  $provider = if ($event.ProviderName -ceq 'Microsoft-Windows-Kernel-Power') { 'kernel-power' } elseif ($event.ProviderName -ceq 'Microsoft-Windows-Power-Troubleshooter') { 'power-troubleshooter' } else { exit 2 };",
  "  $snapshot = [ordered]@{schema=1;provider=$provider;eventId=[int]$event.Id;recordId=$event.RecordId.ToString([Globalization.CultureInfo]::InvariantCulture);ticks=$event.TimeCreated.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)};",
  "  [Console]::Out.Write(($snapshot | ConvertTo-Json -Compress));",
  "} catch { exit 2 }",
].join('\n');
function parseSnapshot(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) return null;
  let value; try { value = JSON.parse(output.trim()); } catch { return null; }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'eventId,provider,recordId,schema,ticks' || value.schema !== 1) return null;
  const ids = value.provider === 'kernel-power' ? [42,107,506,507] : value.provider === 'power-troubleshooter' ? [1] : [];
  if (!Number.isInteger(value.eventId) || !ids.includes(value.eventId)) return null;
  for (const name of ['recordId','ticks']) if (typeof value[name] !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value[name])) return null;
  if (BigInt(value.recordId) > 9223372036854775807n || BigInt(value.ticks) > 3155378975999999999n) return null;
  return { schema: 1, provider: value.provider, eventId: value.eventId, recordId: value.recordId, ticks: value.ticks };
}
function createHostStateReader({ execFile = cp.execFile, platform = process.platform,
  systemRoot = process.env.SystemRoot || 'C:\\Windows', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const unavailable = () => ({ unavailable: true });
  const normalized = typeof systemRoot === 'string' ? path.win32.normalize(systemRoot) : '';
  const rootValid = /^[A-Za-z]:\\[^:*?"<>|\r\n]+$/.test(normalized) &&
    normalized.toLowerCase() === String(systemRoot).replace(/\\$/, '').toLowerCase() &&
    !normalized.split('\\').some(part => part === '.' || part === '..');
  const executable = rootValid ? path.win32.join(normalized, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  return async function readHostState() {
    if (platform !== 'win32' || !executable || typeof execFile !== 'function' ||
        !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) return unavailable();
    const output = await new Promise(resolve => {
      try {
        execFile(executable, ['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',QUERY_SCRIPT],
          { windowsHide: true, shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
          (error, stdout, stderr) => resolve(error || typeof stderr === 'string' && stderr.trim() ? null : stdout));
      } catch { resolve(null); }
    });
    const snapshot = parseSnapshot(output);
    if (!snapshot) return unavailable();
    // 进程能读取快照只说明此刻在运行；sleeping=false不是对历史事件的状态推断。
    // 只公开稳定摘要，日志滚动/清除或五秒睡眠产生的新事件都会改变摘要或变为unavailable。
    const transition = 'windows-power-v1:' + crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    return { sleeping: false, transition };
  };
}
const readHostState = createHostStateReader();
module.exports = { readHostState, createHostStateReader, parseSnapshot, MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS };
