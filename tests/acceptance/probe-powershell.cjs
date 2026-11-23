'use strict';
// 固定 PowerShell 工具在隔离任务里的真实行为：工具结果、实际文件和给模型的说明必须一致。合成账号，不调用模型。
const fs = require('node:fs'), path = require('node:path');
const { createBroker, tools } = require('../../isolation/mcp');
const { begin, finish } = require('./common.cjs');
const run = begin('powershell'), { result, users } = run;
(async () => {
  try {
    const ctx = run.context(users[0]), broker = createBroker(ctx), outputs = path.join(ctx.workspaceRoot, 'chats', 'c1', 'outputs');
    fs.mkdirSync(outputs, { recursive: true });
    const shell = async command => JSON.parse((await broker.call('PowerShell', { command, timeout: 30000 })).content[0].text);
    const denied = value => /Access is denied|UnauthorizedAccess|拒绝访问/i.test(value.stderr || '');
    const written = await shell("Set-Content -LiteralPath 'chats/c1/outputs/plain.txt' -Value 703 -Encoding UTF8");
    result.checks.plainWriteClean = written.exitCode === 0 && !written.stderr.trim() && !written.note && fs.readFileSync(path.join(outputs, 'plain.txt'), 'utf8').trim().endsWith('703');
    const netRead = await shell("[IO.File]::ReadAllText('chats/c1/outputs/plain.txt')");
    result.checks.dotnetReadClean = netRead.exitCode === 0 && netRead.stdout.includes('703') && !netRead.stderr.trim();
    const netDir = await shell("[void][IO.Directory]::CreateDirectory('chats/c1/outputs/sub'); [IO.Directory]::Exists('chats/c1/outputs/sub')");
    result.checks.dotnetDirectoryClean = netDir.exitCode === 0 && /True/.test(netDir.stdout) && !netDir.stderr.trim();
    // 记录已知限制：如果将来这条命令不再报错，探针仍通过，说明可以删掉提示。
    const mkdir = await shell("New-Item -ItemType Directory -Force -Path 'chats/c1/outputs' | Out-Null; Set-Content -LiteralPath 'chats/c1/outputs/after-force.txt' -Value OK");
    result.forceOnExistingDenied = denied(mkdir);
    result.checks.misleadingDenialExplained = !denied(mkdir) || mkdir.note?.includes('does not prove failure') === true;
    // 附加说明时原始 stderr 和退出码必须原样保留（以前这项写成 !x || x，恒为真）。自己造一条像拒绝访问的 stderr，每次都能检查到。
    const noisy = await shell("[Console]::Error.WriteLine('Access is denied. SYNTH_STDERR_7'); Write-Output 'SYNTH_OUT_7'; exit 5");
    result.checks.stderrPreserved = noisy.exitCode === 5 && noisy.stdout.includes('SYNTH_OUT_7') && noisy.stderr.includes('Access is denied. SYNTH_STDERR_7') && typeof noisy.note === 'string' && noisy.note.length > 0;
    result.checks.fileMatchesAfterDenial = fs.existsSync(path.join(outputs, 'after-force.txt'));
    const real = await shell("Set-Content -LiteralPath 'Z:/not/a/real/path.txt' -Value 1; exit 3");
    result.checks.realFailureKept = real.exitCode === 3 && !!real.stderr.trim();
    // 模型把 timeout 当成秒传 60 时会被抬到 1000 毫秒，结果要说清单位，模型才知道怎么改。
    const late = JSON.parse((await broker.call('PowerShell', { command: 'Start-Sleep -Seconds 5', timeout: 60 })).content[0].text);
    result.checks.timeoutExplained = /ETIMEDOUT/.test(late.error || '') && /1000 ms/.test(late.note || '') && /milliseconds/.test(createBrokerDescription());
    result.checks.notesExplainLimit = iso().notes(users[0]).includes('PowerShell file limits') && iso().notes(users[0]).includes('already exist');
  } catch (error) { await finish(run, error); return; }
  await finish(run);
})();
function iso() { return run.iso; }
function createBrokerDescription() { return tools.find(t => t.name === 'PowerShell').description; }
