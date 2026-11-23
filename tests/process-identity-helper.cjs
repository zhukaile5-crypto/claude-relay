'use strict';

// Execute the actual PowerShell identity policy with fake process rows and fake
// held handles. The only real child is this test's PowerShell interpreter: every
// OS process lookup/termination operation in the source is replaced before use.
module.exports = function checkIdentityPolicy(script, mutexScripts, fakeRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const heldStart = script.indexOf('function Hold-Process($row) {');
  const heldEnd = script.indexOf('function Has-Argument', heldStart);
  assert(heldStart >= 0 && heldEnd > heldStart);
  const fakeHold = `function Hold-Process($row) {
  if ($row.HandleChanged) { throw 'Process identity changed' }
  $proc = [pscustomobject]@{ Id=[int]$row.ProcessId; StartTime=$row.CreationDate; HasExited=$false; KillThrows=[bool]$row.KillThrows }
  $proc | Add-Member ScriptMethod Kill { if ($this.KillThrows) { throw 'SYNTHETIC_CHILD_KILL_FAILURE' }; $script:killed.Add($this.Id); $this.HasExited=$true }
  $proc | Add-Member ScriptMethod Dispose { }
  $held.Add($proc)
  return $proc
}
`;
  const mocked = script.slice(0, heldStart) + fakeHold + script.slice(heldEnd);
  assert(!mocked.includes('[Diagnostics.Process]'));
  assert(!mocked.includes('taskkill'));
  assert(script.includes('$null = $proc.Handle'));
  assert(script.includes('$proc.StartTime.ToUniversalTime() - $created'));
  const startedAt = 1700000000000;
  const row = (ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, ms) => ({
    ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate: new Date(ms).toISOString(),
  });
  const node = row(101, 100, 'node.exe', process.execPath, 'node server.js', startedAt - 100);
  const parent = row(100, 99, 'cmd.exe', 'C:\\Windows\\System32\\cmd.exe',
    'cmd /c "' + path.join(fakeRoot, 'run-hidden.bat') + '"', startedAt - 1000);
  const child = row(102, 101, 'claude.exe', 'C:\\mock\\claude.exe', 'claude -p', startedAt + 100);
  const sibling = row(103, 100, 'unrelated.exe', 'C:\\mock\\unrelated.exe', 'unrelated', startedAt + 100);
  const cases = [
    { name: 'verified wrapper and node descendants only', rows: [node, parent, child, sibling], state: 'stopped', kills: [100, 101, 102] },
    { name: 'reused node PID rejected', rows: [{ ...node, CreationDate: new Date(startedAt + 1).toISOString() }, parent], state: 'refused', kills: [] },
    { name: 'wrong executable rejected', rows: [{ ...node, ExecutablePath: 'C:\\other\\node.exe' }, parent], state: 'refused', kills: [] },
    { name: 'wrong command rejected', rows: [{ ...node, CommandLine: 'node other-server.js' }, parent], state: 'refused', kills: [] },
    { name: 'changed parent relationship rejected', rows: [{ ...node, ParentProcessId: 200 }, parent], state: 'refused', kills: [] },
    { name: 'unrelated parent is preserved', rows: [node, { ...parent, CommandLine: 'cmd /c another-script.bat' }, child], state: 'stopped', kills: [101, 102] },
    { name: 'reused parent PID is preserved', rows: [node, { ...parent, CreationDate: new Date(startedAt + 1).toISOString() }, child], state: 'stopped', kills: [101, 102] },
    { name: 'missing node produces no termination', rows: [parent], state: 'gone', kills: [] },
    { name: 'changed descendant handle is never killed', rows: [node, parent, { ...child, HandleChanged: true }], state: 'stopped', kills: [100, 101] },
    { name: '子进程终止异常不阻断主进程停止并保留错误', rows: [node, parent, { ...child, KillThrows: true }], state: 'stopped', kills: [100, 101], warning: 'SYNTHETIC_CHILD_KILL_FAILURE' },
  ];
  const payload = Buffer.from(JSON.stringify({ cases, original: script, mutexScripts })).toString('base64');
  const runner = `$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
# Parse the unmodified production scripts too, without executing them.
foreach ($source in @($data.original) + @($data.mutexScripts)) {
  $tokens = $null; $errors = $null
  $null = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
function Get-CimInstance([string]$ClassName, [string]$Filter) {
  if ($Filter) { $wanted = [int]($Filter -replace '^ProcessId=', ''); return @($script:rows | Where-Object { $_.ProcessId -eq $wanted }) }
  return $script:rows
}
$results = @()
foreach ($case in $data.cases) {
  $script:rows = @($case.rows)
  foreach ($row in $script:rows) { $row.CreationDate = [datetime]$row.CreationDate }
  $script:killed = [Collections.Generic.List[int]]::new()
  $result = & {
${mocked}
  }
  $results += [pscustomobject]@{ name=$case.name; result=($result | ConvertFrom-Json); kills=@($script:killed.ToArray()) }
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $source = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($source))'],
  { input: runner, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const results = JSON.parse(output.trim());
  assert.equal(results.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    assert.equal(results[i].result.state, cases[i].state, cases[i].name);
    assert.deepEqual(results[i].kills, cases[i].kills, cases[i].name);
    if (cases[i].warning) assert(results[i].result.warnings.some(value => value.includes(cases[i].warning)), cases[i].name);
  }
};
