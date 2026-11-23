const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const { versionCheck, isNewer, parseVersion, CHECK_EVERY } = require(path.join(root, 'tools/maintain.cjs'));

// 用文件内容当版本号，真实地互换文件；其余（验收、重启）都是假的
function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintain-'));
  const p = (n) => path.join(dir, n);
  fs.writeFileSync(p('pinned.exe'), '2.1.314'); fs.writeFileSync(p('source.exe'), '2.1.320'); fs.writeFileSync(p('receipt.json'), 'old-receipt');
  const calls = [];
  const d = {
    programs: [{ name: 'Claude', exe: p('pinned.exe'), source: p('source.exe'), root: p('pinned.exe'), sourceRoot: (x) => x, exeIn: (b) => b, signedIn: (b) => [b], signer: 'Anthropic, PBC' }],
    receipt: p('receipt.json'), state: p('state.json'), notice: p('notice.txt'),
    stoppedByOwner: () => false,
    power: async () => ({ running: 0, idleMinutes: 60 }),
    discover: async program => { calls.push('discover'); return { status: 'available', version: (await fsp.readFile(program.source, 'utf8')).trim() }; },
    prepareCandidate: async program => ({ status: 'ready', executable: program.source }),
    version: (f) => parseVersion(fs.readFileSync(f, 'utf8')),
    signedBy: () => true,
    gateOk: () => true,
    accept: ({ outputReceipt }) => { calls.push('accept'); fs.writeFileSync(outputReceipt, 'new-receipt'); return { ok: true, out: '' }; },
    restart: () => { calls.push('restart'); return true; },
    serving: async () => true,
    waitMs: 1, idleTimeoutMs: 50,
    now: () => 1e13,
    log: () => {},
    ...over,
  };
  return { d, p, calls, read: (n) => fs.readFileSync(p(n), 'utf8'), has: (n) => fs.existsSync(p(n)) };
}

test('version compare', () => {
  assert.deepEqual(parseVersion('2.1.314 (Claude Code)'), [2, 1, 314]);
  assert.equal(parseVersion('oops'), null);
  assert.ok(isNewer([2, 1, 320], [2, 1, 314]) && isNewer([3, 0, 0], [2, 9, 9]));
  assert.ok(!isNewer([2, 1, 314], [2, 1, 314]) && !isNewer([2, 1, 300], [2, 1, 314]));
});

test('new version: swapped in, accepted, restarted', async () => {
  const f = fixture();
  assert.equal(await versionCheck({}, f.d), 'upgraded');
  assert.equal(f.read('pinned.exe'), '2.1.320');
  assert.equal(f.read('pinned.exe.prev'), '2.1.314');
  assert.deepEqual(f.calls, ['discover', 'accept', 'restart']);
  assert.ok(!f.has('notice.txt'));
});

test('acceptance failure restores the program and receipt and tells the owner', async () => {
  const f = fixture({ accept: () => ({ ok: false, out: 'boom' }) });
  assert.equal(await versionCheck({}, f.d), 'acceptance-failed');
  assert.equal(f.read('pinned.exe'), '2.1.314');
  assert.equal(f.read('receipt.json'), 'old-receipt');
  assert.ok(!f.has('pinned.exe.prev') && !f.has('pinned.exe.new'));
  assert.match(f.read('notice.txt'), /已退回 2\.1\.314/);
});

test('service that will not come back after upgrade: rolled back and restarted again', async () => {
  let serving = 0;
  const f = fixture({ serving: async () => ++serving > 1 });
  assert.equal(await versionCheck({}, f.d), 'restart-failed');
  assert.equal(f.read('pinned.exe'), '2.1.314');
  assert.equal(f.read('receipt.json'), 'old-receipt');
  assert.deepEqual(f.calls.filter((c) => c === 'restart').length, 2);
  assert.ok(f.has('notice.txt'));
});

test('unsigned download never reaches the pinned copy', async () => {
  const f = fixture({ signedBy: () => false });
  assert.equal(await versionCheck({}, f.d), 'bad-signature');
  assert.equal(f.read('pinned.exe'), '2.1.314');
  assert.ok(!f.calls.includes('accept') && !f.has('pinned.exe.new'));
});

test('same version does nothing but records the check', async () => {
  const f = fixture(); fs.writeFileSync(f.p('source.exe'), '2.1.314');
  assert.equal(await versionCheck({}, f.d), 'up-to-date');
  assert.deepEqual(f.calls, ['discover']);
  assert.equal(JSON.parse(f.read('state.json')).lastCheckAt, 1e13);
});

test('gate drift is reported, not upgraded over', async () => {
  const f = fixture({ gateOk: () => false });
  assert.equal(await versionCheck({}, f.d), 'gate-drift');
  assert.equal(f.read('pinned.exe'), '2.1.314');
  assert.ok(!f.calls.includes('accept'));
  assert.match(f.read('notice.txt'), /受限模式/);
});

test('busy or stopped service is left alone and retried later', async () => {
  for (const [power, want] of [[{ running: 1, idleMinutes: 60 }, 'busy'], [{ running: 0, idleMinutes: 3 }, 'busy'], [null, 'service-down']]) {
    const f = fixture({ power: async () => power });
    assert.equal(await versionCheck({}, f.d), want);
    assert.ok(!f.has('state.json') && !f.calls.length);
  }
  const f = fixture({ stoppedByOwner: () => true });
  assert.equal(await versionCheck({}, f.d), 'stopped-by-owner');
});

test('checks at most once per day', async () => {
  const f = fixture();
  fs.writeFileSync(f.d.state, JSON.stringify({ lastCheckAt: 1e13 - CHECK_EVERY + 1000 }));
  assert.equal(await versionCheck({}, f.d), 'not-due');
  assert.ok(!f.calls.length);
  fs.writeFileSync(f.d.state, JSON.stringify({ lastCheckAt: 1e13 - CHECK_EVERY }));
  assert.equal(await versionCheck({}, f.d), 'upgraded');
});

test('busy after acceptance: keep old program and receipt, defer replacement', async () => {
  let n = 0;
  const f = fixture({ power: async () => (n++ ? { running: 1, idleMinutes: 0 } : { running: 0, idleMinutes: 60 }), now: () => 1e13 + n * 100 });
  assert.equal(await versionCheck({}, f.d), 'upgrade-deferred');
  assert.equal(f.read('pinned.exe'), '2.1.314');
  assert.equal(f.read('receipt.json'), 'old-receipt');
  assert.equal(JSON.parse(f.read('state.json')).pendingUpgrade, true);
  assert.ok(!f.calls.includes('restart'));
});

// Codex 是一个文件夹：官方安装的是版本号文件夹，固定副本是 app。2026-11-23 GPT 退出平台后 Codex 不再自动升级：
// 它仍在 d.programs 里（运行监测和旧事务恢复按那份程序集合核对），但版本检查只处理 Claude。原来这里的四条 Codex 升级测试改成下面的新预期。
function codexFixture(over = {}) {
  const f = fixture(over);
  const mk = (base, v) => { fs.mkdirSync(path.join(base, 'bin'), { recursive: true }); fs.writeFileSync(path.join(base, 'bin', 'codex.exe'), v); fs.writeFileSync(path.join(base, 'bin', 'helper.exe'), 'helper-' + v); };
  mk(f.p('app'), '0.166.0'); mk(f.p('release'), '0.170.0');
  const codex = { name: 'Codex', exe: path.join(f.p('app'), 'bin', 'codex.exe'), source: path.join(f.p('release'), 'bin', 'codex.exe'), root: f.p('app'),
    sourceRoot: (x) => path.dirname(path.dirname(x)), exeIn: (b) => path.join(b, 'bin', 'codex.exe'), signedIn: (b) => [path.join(b, 'bin', 'codex.exe')], signer: 'OpenAI OpCo, LLC' };
  fs.writeFileSync(f.p('source.exe'), '2.1.314'); // Claude 没有新版
  f.d.programs.push(codex);
  return f;
}
const untouchedCodex = f => {
  assert.equal(f.read('app/bin/codex.exe'), '0.166.0'); assert.equal(f.read('app/bin/helper.exe'), 'helper-0.166.0');
  assert.ok(!f.has('app.prev') && !f.has('app.new') && !f.has('app.failed'));
  assert.equal(JSON.parse(f.read('state.json')).versions.Codex, undefined);
};

test('GPT 退出平台：Codex 有新版也不查、不下载、不交换，固定副本原样留着', async () => {
  const seen = [];
  const f = codexFixture({ discover: async program => { seen.push(program.name); f.calls.push('discover'); return { status: 'available', version: (await fsp.readFile(program.source, 'utf8')).trim() }; },
    prepareCandidate: async program => { seen.push('prepare:' + program.name); return { status: 'ready', executable: program.source }; } });
  assert.equal(await versionCheck({}, f.d), 'up-to-date');
  assert.deepEqual(seen, ['Claude']); assert.ok(!f.calls.includes('accept'));
  untouchedCodex(f);
});

test('只有 Claude 进入升级：Claude 验收失败时 Codex 也不被碰', async () => {
  const f = codexFixture({ accept: () => ({ ok: false, out: 'boom' }) });
  fs.writeFileSync(f.p('source.exe'), '2.1.320');
  assert.equal(await versionCheck({}, f.d), 'acceptance-failed');
  assert.equal(f.read('pinned.exe'), '2.1.314');
  assert.match(f.read('notice.txt'), /Claude 2\.1\.320/); assert.doesNotMatch(f.read('notice.txt'), /Codex/);
  untouchedCodex(f);
});

test('签名只按 Claude 自己的发布方核对，不再出现 OpenAI 的签名核对', async () => {
  const seen = [];
  const f = codexFixture({ signedBy: (file, org) => { seen.push(org); return true; } });
  fs.writeFileSync(f.p('source.exe'), '2.1.320');
  assert.equal(await versionCheck({}, f.d), 'upgraded');
  assert.deepEqual(seen, ['Anthropic, PBC']);
  assert.equal(f.read('pinned.exe'), '2.1.320');
  untouchedCodex(f);
});
