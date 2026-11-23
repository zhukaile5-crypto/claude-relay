'use strict';
// Gemini 固定程序的自动恢复：只用临时目录里的假文件，不碰真正的程序和正式服务。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { restore } = require('../tools/pinned-programs.cjs');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function stage(t, { record = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pinned = path.join(root, 'bin', 'agy.exe'), receipt = path.join(root, 'data', 'isolation', 'acceptance.json');
  fs.mkdirSync(path.dirname(pinned), { recursive: true }); fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(pinned, 'ACCEPTED');
  fs.writeFileSync(receipt, JSON.stringify({ fingerprints: record ? [{ path: pinned.toUpperCase(), sha256: sha('ACCEPTED') }] : [] }));
  const logs = [], config = { agyPath: pinned, isolation: { receipt } };
  const baseline = path.join(root, 'data', 'maintenance', 'pinned', sha('ACCEPTED') + '.bin');
  return { root, pinned, baseline, logs, run: (extra = {}) => restore({ root, config, log: line => logs.push(line), ...extra }) };
}

test('一致时留底本；被换掉后用底本换回去', async t => {
  const s = stage(t);
  assert.equal(await s.run(), 'ok'); assert.equal(fs.readFileSync(s.baseline, 'utf8'), 'ACCEPTED');
  let hashed = 0; const counting = { hash: async file => { hashed++; return sha(fs.readFileSync(file)); } };
  assert.equal(await s.run({ deps: counting }), 'ok'); assert.equal(hashed, 0); // 没变就不重算校验值
  fs.writeFileSync(s.pinned, 'UPDATED BY ITS OWN UPDATER');
  assert.equal(await s.run({ dryRun: true }), 'drift'); assert.equal(fs.readFileSync(s.pinned, 'utf8'), 'UPDATED BY ITS OWN UPDATER');
  assert.equal(await s.run(), 'restored'); assert.equal(fs.readFileSync(s.pinned, 'utf8'), 'ACCEPTED');
  assert.match(s.logs.at(-1), /已恢复成验收时的那一份/);
  assert.deepEqual(fs.readdirSync(path.dirname(s.pinned)), ['agy.exe']); // 不留临时文件
  assert.equal(await s.run(), 'ok');
  fs.rmSync(s.pinned); assert.equal(await s.run(), 'restored'); // 文件被拿走了也能放回去
});

test('正在运行换不动、没有底本、底本坏了：都不放进别的内容', async t => {
  const s = stage(t); await s.run();
  fs.writeFileSync(s.pinned, 'UPDATED');
  const busy = { rename: async () => { throw Object.assign(new Error('in use'), { code: 'EPERM' }); } };
  assert.equal(await s.run({ deps: busy }), 'busy'); assert.equal(fs.readFileSync(s.pinned, 'utf8'), 'UPDATED');
  assert.deepEqual(fs.readdirSync(path.dirname(s.pinned)), ['agy.exe']);
  fs.writeFileSync(s.baseline, 'TAMPERED');
  assert.equal(await s.run(), 'baseline-corrupt'); assert.equal(fs.readFileSync(s.pinned, 'utf8'), 'UPDATED');
  fs.rmSync(s.baseline);
  assert.equal(await s.run(), 'no-baseline'); assert.equal(fs.readFileSync(s.pinned, 'utf8'), 'UPDATED');
});

test('没配置、验收记录里没有它：什么都不做', async t => {
  const s = stage(t, { record: false });
  assert.equal(await s.run(), 'no-record'); assert.equal(fs.existsSync(s.baseline), false);
  assert.equal(await restore({ root: s.root, config: {} }), 'not-configured');
  assert.equal(await restore({ root: s.root, config: { agyPath: 'relative\\agy.exe' } }), 'not-configured');
});

test('接在三个地方：定时维护开始时、服务启动前、服务退出后重开前', () => {
  const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('tools/maintain.cjs'), /if \(d\.restorePinned\) \{ try \{ await d\.restorePinned\(\); \}/);
  assert.match(read('start-hidden.vbs'), /pinned-programs\.cjs"" restore/);
  const bat = read('run-hidden.bat'), lines = bat.split(/\r?\n/);
  // 只能加在等待那一行后面：正在运行的批处理按字节位置接着读，前面的内容一个字节都不能动
  assert.ok(lines.indexOf('node tools\\pinned-programs.cjs restore >> logs\\relay.log 2>&1') > lines.findIndex(line => line.startsWith('ping -n 6')));
  assert.ok(bat.startsWith('@echo off') && bat.includes('node server.js >> logs\\relay.log 2>&1'));
});

test('完整验收期间的记号：有效期内不换回去，过期、超长、没写同意说明的记号不算', async t => {
  const { holdActive, setHold, clearHold, HOLD_MAX_MS } = require('../tools/pinned-programs.cjs');
  const s = stage(t);
  assert.equal(await s.run(), 'ok');
  fs.writeFileSync(s.pinned, 'UPDATED BY ITS OWN UPDATER');
  const now = Date.now(), file = path.join(s.root, 'data', 'maintenance', 'acceptance-hold.json');
  setHold(s.root, '机主同意跑完整验收', 3 * 3600e3, now);
  assert.equal(holdActive(s.root, now + 1000), true);
  assert.equal(await s.run(), 'held'); assert.equal(fs.readFileSync(s.pinned, 'utf8'), 'UPDATED BY ITS OWN UPDATER'); // 没被换回去
  assert.equal(await s.run({ deps: { now: () => now + 3 * 3600e3 + 1 } }), 'restored'); // 到期自动失效
  fs.writeFileSync(s.pinned, 'UPDATED AGAIN');
  fs.writeFileSync(file, JSON.stringify({ until: now + HOLD_MAX_MS + 60e3, approved: '太长的记号' })); // 超过 6 小时的不认
  assert.equal(await s.run(), 'restored');
  fs.writeFileSync(s.pinned, 'UPDATED AGAIN');
  fs.writeFileSync(file, JSON.stringify({ until: now + 3600e3 })); // 没有同意说明的不认
  assert.equal(await s.run(), 'restored');
  fs.writeFileSync(file, '不是 JSON'); assert.equal(holdActive(s.root), false);
  assert.throws(() => setHold(s.root, ''), /机主同意/);
  setHold(s.root, '再来一次', 99 * 3600e3, now); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).until, now + HOLD_MAX_MS); // 最长也只到 6 小时
  clearHold(s.root); assert.equal(fs.existsSync(file), false); assert.equal(holdActive(s.root), false);
});
