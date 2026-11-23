'use strict';
// 读取真实源码闭包，所有服务命令、PID、验收和文件修改都在内存中替代。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const record = (pid = 101, ppid = 100, startedAt = 12345) => ({ pid, ppid, startedAt });
function restartHarness({ firstOk = false, secondOk = true, before = JSON.stringify(record()), after = JSON.stringify(record(201, 200, 22345)), stopDuringRestart = false, stoppedInitially = false, stopDuringFallback = false } = {}) {
  const source = read('tools/maintain.cjs'), begin = source.indexOf('  d.restart = async () => {'), end = source.indexOf('\n  d.serving =', begin);
  assert.ok(begin >= 0 && end > begin, '实际重启闭包位置变化，需要更新测试提取范围');
  const calls = [], logs = []; let value = before, stopped = stoppedInitially;
  const d = { stoppedByOwner: () => stopped };
  const context = { d, root: 'C:\\synthetic-relay', path, JSON, log: message => logs.push(message),
    fsp: { readFile: async () => { if (value === null) throw Object.assign(Error('synthetic missing'), { code: 'ENOENT' }); return value; } },
    runNode: async args => { calls.push([...args]); if (args[1] === 'auto-restart') { value = after; stopped = stopDuringRestart; return { ok: firstOk, out: 'SYNTHETIC_RESTART_FAILURE' }; }
      stopped = stopped || stopDuringFallback; return { ok: secondOk, out: 'SYNTHETIC_START_FAILURE' }; } };
  vm.runInNewContext(source.slice(begin, end), context);
  return { run: () => d.restart(), calls, logs, d };
}
test('真实重启闭包成功且 PID 身份更新时不执行补启动', async () => {
  const h = restartHarness({ firstOk: true }); assert.equal(await h.run(), true);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1], 'auto-restart'); assert.equal(h.d.lastPidRecord.pid, 101);
});
test('真实重启闭包失败后自动补启动，并记录原错误输出', async () => {
  const h = restartHarness(); assert.equal(await h.run(), true);
  assert.deepEqual(h.calls.map(args => args[1]), ['auto-restart', 'auto-start']);
  assert.ok(h.logs.some(line => line.includes('SYNTHETIC_RESTART_FAILURE')));
});
test('补启动也失败时保留错误并返回失败', async () => {
  const h = restartHarness({ secondOk: false }); assert.equal(await h.run(), false);
  assert.ok(h.logs.some(line => line.includes('SYNTHETIC_START_FAILURE')));
});
for (const [name, after] of [
  ['PID 文件不变', JSON.stringify(record())], ['仅 JSON 格式变化', JSON.stringify(record(), null, 2)],
  ['PID 文件消失', null], ['PID 文件格式损坏', '{invalid'], ['PID 字段缺失', '{}'],
  ['PID 为零', JSON.stringify(record(0))], ['父 PID 为负数', JSON.stringify(record(201, -1))],
  ['启动时间缺失', JSON.stringify({ pid: 201, ppid: 200 })],
]) {
  for (const firstOk of [false, true]) test((firstOk ? 'restart 返回成功' : '补启动返回成功') + '但' + name + '仍然不算真正重启', async () => {
    const h = restartHarness({ firstOk, after }); assert.equal(await h.run(), false);
  });
}
test('重启失败期间新出现的人工停止阻止补启动', async () => {
  const h = restartHarness({ stopDuringRestart: true }); assert.equal(await h.run(), false); assert.equal(h.calls.length, 1);
});
test('已有人工停止时不调用重启；成功命令或补启动期间的新停止也不能报成功', async () => {
  const stopped = restartHarness({ stoppedInitially: true }); assert.equal(await stopped.run(), false); assert.deepEqual(stopped.calls, []);
  const restarted = restartHarness({ firstOk: true, stopDuringRestart: true }); assert.equal(await restarted.run(), false); assert.equal(restarted.calls.length, 1);
  const fallback = restartHarness({ stopDuringFallback: true }); assert.equal(await fallback.run(), false);
  assert.deepEqual(fallback.calls.map(args => args[1]), ['auto-restart', 'auto-start']);
});
test('有效的新启动时间能区分复用 PID，原记录缺失时必须取得完整新身份', async () => {
  const reused = restartHarness({ firstOk: true, after: JSON.stringify(record(101, 100, 22345)) });
  assert.equal(await reused.run(), true);
  const missing = restartHarness({ firstOk: true, before: null }); assert.equal(await missing.run(), true); assert.equal(missing.d.lastPidRecord, null);
  for (const after of [JSON.stringify(record(201.5)), JSON.stringify(record(201, 200, -1)),
    JSON.stringify(record(Number.MAX_SAFE_INTEGER + 1)), JSON.stringify(record(201, '200', 22345))]) {
    assert.equal(await restartHarness({ firstOk: true, after }).run(), false);
  }
});
test('restartAndVerify 仍要求非人工停止、进程启动、服务可用及验收核对', async () => {
  const { restartAndVerify } = require('../tools/maintain.cjs');
  for (const blocked of ['owner', 'restart', 'serving', 'gate', null]) {
    const calls = [], d = { stoppedByOwner: () => blocked === 'owner',
      restart: async () => { calls.push('restart'); return blocked !== 'restart'; },
      serving: async () => { calls.push('serving'); return blocked !== 'serving'; },
      gateOk: async () => { calls.push('gate'); return blocked !== 'gate'; } };
    assert.equal(await restartAndVerify(d), blocked === null);
    if (blocked === 'owner') assert.deepEqual(calls, []);
    if (blocked === 'restart') assert.deepEqual(calls, ['restart']);
    if (blocked === 'serving') assert.deepEqual(calls, ['restart', 'serving']);
  }
});

// 原来用 --codex-moved-from 测迁移；2026-11-23 GPT 退出平台后 Codex 不再迁移（见下面的拒绝测试），迁移的整套核对改用 --claude-moved-from 测。
// Codex 固定副本照旧在运行环境里：完整包、包根界限和指纹都还在，只是不能变。
async function refreshHarness({ mutate, publish = false, t, movedFlag = '--claude-moved-from=' } = {}) {
  const fsp = fs.promises, source = read('tools/refresh-isolation-receipt.cjs');
  const fakeRoot = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'relay-refresh-vm-'));
  t.after(async () => {
    assert.equal(path.dirname(fakeRoot), path.resolve(require('node:os').tmpdir()));
    assert.match(path.basename(fakeRoot), /^relay-refresh-vm-/);
    assert.equal((await fsp.realpath(fakeRoot)).toLowerCase(), fakeRoot.toLowerCase());
    await fsp.rm(fakeRoot, { recursive: true, force: true });
  });
  const configPath = path.join(fakeRoot, 'config.json'), manifest = path.join(fakeRoot, 'runtime', 'manifest.json');
  const receiptPath = path.join(fakeRoot, 'data', 'isolation', 'acceptance.json');
  const oldPath = path.join(fakeRoot, 'owner-claude', 'current', 'claude.exe'), oldReal = path.join(fakeRoot, 'owner-claude', 'releases', 'old', 'claude.exe');
  const newPath = path.join(fakeRoot, 'pinned-claude', 'claude.exe'), guard = path.join(fakeRoot, 'isolation', 'guard.js'), server = path.join(fakeRoot, 'server.js');
  const codexPath = path.join(fakeRoot, 'pinned-codex', 'bin', 'codex.exe'), codexRoot = path.dirname(path.dirname(codexPath));
  const runtime = { codexPath, claudePath: newPath, nodePath: path.join(fakeRoot, 'node.exe') };
  const config = { users: [{ id: 'synthetic', workDir: path.join(fakeRoot, 'work') }], isolation: { enabled: true, runtimeManifest: manifest, receipt: receiptPath } };
  const projection = (cfg, rt) => sha(JSON.stringify({ users: cfg.users, runtime: rt }));
  const oldManifest = JSON.stringify({ ...runtime, claudePath: oldPath }, null, 2), files = new Map();
  const meta = JSON.stringify({ layoutVersion: 1, version: '0.166.0', target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/codex.exe' });
  const codexFiles = [codexPath, path.join(codexRoot, 'codex-package.json'), path.join(codexRoot, 'helper.dll')];
  for (const [file, bytes] of [[manifest, JSON.stringify(runtime, null, 2)], [newPath, 'NEW_CLAUDE'], [oldReal, 'OLD_CLAUDE'], [guard, 'GUARD'], [server, 'SERVER'],
    [runtime.nodePath, 'NODE'], [codexPath, 'CODEX'], [path.join(codexRoot, 'codex-package.json'), meta], [path.join(codexRoot, 'helper.dll'), 'CODEX_HELPER']]) files.set(file, bytes);
  const receipt = { schema: 2, configurationFingerprint: projection(config, { ...runtime, claudePath: oldPath }),
    checks: { boundary: { passed: true, evidence: ['synthetic-original'] } },
    fingerprints: [manifest, oldReal, ...codexFiles, guard, server, runtime.nodePath]
      .map(file => ({ path: file, sha256: sha(file === manifest ? oldManifest : files.get(file)) })) };
  const required = [manifest, newPath, ...codexFiles, guard, server, runtime.nodePath];
  const calls = [], writes = [], logs = [], output = path.join(fakeRoot, 'data', 'maintenance', 'transactions', 'a'.repeat(32), 'receipt.candidate.json');
  const f = { config, runtime, receipt, files, required, oldPath, oldReal, newPath, codexPath, manifest, guard, server, output, calls, writes, logs };
  if (mutate) mutate(f);
  files.set(configPath, JSON.stringify(config)); files.set(receiptPath, JSON.stringify(receipt));
  for (const [file, bytes] of files) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, bytes); }
  await fsp.mkdir(config.users[0].workDir, { recursive: true });
  await fsp.mkdir(path.dirname(path.dirname(oldPath)), { recursive: true });
  await fsp.symlink(path.dirname(oldReal), path.dirname(oldPath), 'junction');
  const gate = { RECEIPT_SCHEMA: 2, REQUIRED: ['boundary'], configurationFingerprint: projection, requiredFingerprintFiles: () => required,
    hashFile: file => sha(fs.readFileSync(file)) };
  const modules = { 'node:path': path, 'node:crypto': crypto, './check-isolation.cjs': gate,
    'node:fs': { ...fs, promises: { ...fsp, mkdir: async (...args) => { writes.push(['mkdir', args[0]]); return fsp.mkdir(...args); } },
      copyFileSync() { throw Error('正式记录不得写入'); }, renameSync() { throw Error('正式记录不得替换'); }, writeFileSync() { throw Error('正式记录不得写入'); } },
    './maintenance-refresh-plan.cjs': require('../tools/maintenance-refresh-plan.cjs'),
    './maintenance-receipt-history.cjs': require('../tools/maintenance-receipt-history.cjs'),
    './maintenance-acceptance.cjs': {
      runEvidence: async options => {
        await options.beforeAttempt({ kind: 'regression', attempt: 1 }); calls.push(['tests/run.cjs']);
        await options.beforeAttempt({ kind: 'e2e', attempt: 1 });
        const e2eFile = path.join(options.evidenceDir, 'e2e-attempt-1.json');
        calls.push(['tests/server-isolation-e2e.cjs', options.manifestPath, e2eFile]);
        return { ok: true, status: 0, evidence: [path.join(options.evidenceDir, 'regression.log'), e2eFile], recordVersionFailure: false, interrupted: false, attemptCount: 1 };
      },
      formatResult: result => require('../tools/maintenance-acceptance.cjs').formatResult(result),
    },
    './maintenance-transaction.cjs': { writeCandidateReceipt: async value => { f.published = value; } },
  };
  const args = ['node', 'refresh', movedFlag + oldPath, ...(publish ? ['--output-receipt=' + output] : ['--dry-run'])];
  const context = { require: name => { assert.ok(modules[name], '不得加载真实依赖：' + name); return modules[name]; }, __dirname: path.join(fakeRoot, 'tools'),
    process: { argv: args, execPath: process.execPath, exit: code => { throw Object.assign(Error('synthetic exit'), { syntheticExit: code }); } },
    console: { log: text => logs.push(text), error: text => logs.push(text) }, Buffer, Date, JSON };
  f.run = async () => { try { await vm.runInNewContext('(function(){' + source + '\n})()', context); return { code: context.process.exitCode || 0 }; }
    catch (error) { if (Number.isInteger(error.syntheticExit)) return { code: error.syntheticExit }; throw error; } };
  return f;
}
test('真实 --claude-moved-from 预检查接受唯一的程序路径迁移且不运行验收', async t => {
  const h = await refreshHarness({ t }); assert.equal((await h.run()).code, 0, h.logs.join('\n')); assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
  assert.ok(h.logs.some(line => line.includes(h.newPath)));
});
test('GPT 退出平台：--codex-moved-from 直接拒绝，不核对、不运行验收、不写任何文件', async t => {
  for (const publish of [false, true]) {
    const h = await refreshHarness({ t, publish, movedFlag: '--codex-moved-from=' });
    assert.equal((await h.run()).code, 3); assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []); assert.equal(h.published, undefined);
    assert.ok(h.logs.some(line => /Codex 程序不再升级或迁移/.test(line)), h.logs.join('\n'));
  }
});
for (const [name, mutate] of [
  ['清单另有改动', f => { f.files.set(f.manifest, JSON.stringify({ ...f.runtime, extra: true }, null, 2)); }],
  ['账号配置改动', f => { f.config.users[0].id = 'other'; }],
  ['缺少旧程序指纹', f => { f.receipt.fingerprints = f.receipt.fingerprints.filter(item => item.path !== f.oldReal); }],
  ['隔离文件改动', f => { f.files.set(f.guard, 'CHANGED_GUARD'); }],
  ['新增未覆盖文件', f => { f.required.push(path.join(path.dirname(f.guard), 'new.js')); }],
  ['新程序无法读取', f => { f.files.delete(f.newPath); }],
  ['Codex 程序改动（GPT 已退出平台，不再接受）', f => { f.files.set(f.codexPath, 'CHANGED_CODEX'); }],
]) test('--claude-moved-from 拒绝' + name + '，无模型和正式文件修改', async t => {
  const h = await refreshHarness({ mutate, t }); assert.equal((await h.run()).code, 3); assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
});
test('真实迁移验收流程只发布候选记录，并把新程序指纹和配置写成配套状态', async t => {
  const h = await refreshHarness({ publish: true, t }); assert.equal((await h.run()).code, 0, h.logs.join('\n'));
  assert.deepEqual(h.calls.map(args => args[0]), ['tests/run.cjs', 'tests/server-isolation-e2e.cjs']);
  assert.equal(h.published.output, h.output);
  assert.ok(h.published.receipt.fingerprints.some(item => item.path === h.newPath && item.sha256 === sha('NEW_CLAUDE')));
  assert.ok(!h.published.receipt.fingerprints.some(item => item.path === h.oldReal));
  assert.ok(h.published.receipt.fingerprints.some(item => item.path === h.codexPath && item.sha256 === sha('CODEX')), 'Codex 固定副本照旧绑定、不变');
  assert.equal(h.published.receipt.revisions[0].claudeMovedFrom, h.oldPath);
});

test('机主通知仅对 owner 可见，其他账号不会读取通知文件', async () => {
  const source = read('server.js'), match = source.match(/(?:async )?function ownerNotice\(u\) \{[\s\S]*?\n\}/);
  assert.ok(match, '机主通知函数位置变化，需要更新测试');
  let reads = 0, fail = false; const file = path.join(root, 'data', 'maintenance', 'notice.txt');
  const readNotice = target => { assert.equal(target, file); reads++; if (fail) throw Error('synthetic missing'); return '  SYNTHETIC_OWNER_NOTICE  '; };
  const context = { __dirname: root, ROOT: root, path, fs: { readFileSync: readNotice, promises: { readFile: async target => readNotice(target) } } };
  vm.runInNewContext(match[0] + ';globalThis.readNotice=ownerNotice;', context);
  for (const u of [{ id: 'friend' }, { id: 'owner', profile: 'ordinary' }, { profile: 'Owner' }, { profile: 'guest' }]) assert.equal(await context.readNotice(u), '');
  assert.equal(reads, 0); assert.equal(await context.readNotice({ profile: 'owner' }), 'SYNTHETIC_OWNER_NOTICE'); assert.equal(reads, 1);
  fail = true; assert.equal(await context.readNotice({ profile: 'owner' }), '');
});
test('实际 wake_check 锁条件区分不存在、活进程和已退出进程；没有调用睡眠或查询真实进程', { skip: process.platform !== 'win32' }, () => {
  const source = read('tools/wake_check.ps1'), match = source.match(/\$maintLock =[^\r\n]+[\s\S]*?(?=\r?\n#)/);
  assert.ok(match, '维护锁条件位置变化，需要更新测试');
  const condition = match[0].replace(/exit 0/g, "throw 'SYNTHETIC_KEEP_AWAKE'");
  assert.ok(!/SetSuspendState|Invoke-RestMethod|Add-Type|SetThreadExecutionState/.test(condition));
  const cases = [{ name: 'missing', exists: false, alive: false, value: '321', kept: false },
    { name: 'alive', exists: true, alive: true, value: '321', kept: true },
    { name: 'dead', exists: true, alive: false, value: '321', kept: false }];
  const code = `$ErrorActionPreference='Stop'\n$cases=ConvertFrom-Json '${JSON.stringify(cases)}'\n$results=@()\n` +
    `function Test-Path { param($Path) return $script:case.exists }\nfunction Get-Content { param($Path,[switch]$Raw) return $script:case.value }\n` +
    `function Get-Process { param($Id,$ErrorAction) $script:queries++; if($script:case.alive){ return @{Id=$Id} } return $null }\nfunction Log { param($Message) }\n` +
    `foreach($case in $cases){$script:case=$case;$script:queries=0;$root='C:\\synthetic-relay';$kept=$false;try{${condition}}catch{if($_.Exception.Message -eq 'SYNTHETIC_KEEP_AWAKE'){$kept=$true}else{throw}}\n` +
    `$results+=@{name=$case.name;kept=$kept;queries=$script:queries}}\nConvertTo-Json -InputObject @($results) -Compress`;
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = cp.spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); const rows = JSON.parse(result.stdout);
  for (let index = 0; index < cases.length; index++) { assert.equal(rows[index].kept, cases[index].kept); assert.equal(rows[index].queries, cases[index].exists ? 1 : 0); }
});
