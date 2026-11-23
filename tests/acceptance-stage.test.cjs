'use strict';
// 验收合成目录的删除：只删联接本身，不进入联接；只认 data\isolation-e2e-* 的形状。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const stage = require('../tools/acceptance-stage.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stage-'));
  t.after(() => { assert.match(path.basename(root), /^relay-stage-/); fs.rmSync(root, { recursive: true, force: true }); });
  const outside = path.join(root, 'live'); fs.mkdirSync(path.join(outside, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'node_modules', 'precious.js'), '正式依赖');
  const s = path.join(root, 'data', 'isolation-e2e-AbC123'); fs.mkdirSync(path.join(s, 'alice', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(s, 'alice', 'deep', 'note.md'), '合成'); fs.writeFileSync(path.join(s, 'synthetic-acceptance.json'), '{}');
  fs.symlinkSync(path.join(outside, 'node_modules'), path.join(s, 'node_modules'), 'junction');
  return { root, outside, s };
}
test('删除合成目录时只删联接，联接指向的正式目录原样保留', t => {
  const f = fixture(t);
  assert.deepEqual(stage.removeStage(f.root, f.s), { removed: true });
  assert.equal(fs.existsSync(f.s), false);
  assert.equal(fs.readFileSync(path.join(f.outside, 'node_modules', 'precious.js'), 'utf8'), '正式依赖');
});
test('名字或位置不对、或本身是联接的目录一律不删', t => {
  const f = fixture(t);
  const other = path.join(f.root, 'data', 'conversations'); fs.mkdirSync(other);
  assert.equal(stage.removeStage(f.root, other).removed, false); assert.ok(fs.existsSync(other));
  const nested = path.join(f.root, 'data', 'x', 'isolation-e2e-AbC999'); fs.mkdirSync(nested, { recursive: true });
  assert.equal(stage.removeStage(f.root, nested).removed, false); assert.ok(fs.existsSync(nested));
  const linked = path.join(f.root, 'data', 'isolation-e2e-Link01'); fs.symlinkSync(f.outside, linked, 'junction');
  const r = stage.removeStage(f.root, linked); assert.equal(r.removed, false); assert.match(r.error, /联接/);
  assert.ok(fs.existsSync(path.join(f.outside, 'node_modules', 'precious.js')));
});
test('列出残留时把最近改动过的标出来，清理脚本默认只列不删', t => {
  const f = fixture(t); const old = path.join(f.root, 'data', 'isolation-e2e-Old001'); fs.mkdirSync(old);
  const past = new Date(Date.now() - 2 * 86400e3); fs.utimesSync(old, past, past);
  const rows = stage.listStages(f.root);
  assert.deepEqual(rows.map(r => [r.name, r.recent]), [['isolation-e2e-Old001', false], ['isolation-e2e-AbC123', true]]);
  const run = args => require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'cleanup-acceptance-leftovers.cjs'), '--root=' + f.root, ...args], { encoding: 'utf8' });
  let out = run([]); assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /将删除 isolation-e2e-Old001/); assert.match(out.stdout, /跳过 isolation-e2e-AbC123/);
  assert.ok(fs.existsSync(old));
  fs.mkdirSync(path.join(f.root, 'data', 'maintenance')); fs.writeFileSync(path.join(f.root, 'data', 'maintenance', 'running.lock'), '{}');
  out = run(['--apply']); assert.equal(out.status, 1); assert.ok(fs.existsSync(old));
  fs.rmSync(path.join(f.root, 'data', 'maintenance', 'running.lock'));
  out = run(['--apply']); assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /删除 1 个/);
  assert.equal(fs.existsSync(old), false); assert.ok(fs.existsSync(f.s));
});
test('两个端到端脚本通过时清理合成目录，失败或子进程未退出时保留', () => {
  for (const name of ['server-isolation-e2e.cjs', 'isolation-readiness-startup.cjs']) {
    const s = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.match(s, /require\('\.\.\/tools\/acceptance-stage\.cjs'\)\.removeStage\(root,stage\)/, name);
    assert.match(s, /stageRemoved/, name);
    const at = s.indexOf('removeStage(root,stage)'), guard = s.lastIndexOf('failure', at);
    assert.ok(guard > 0 && at - guard < 120, name + '：删除前要先看有没有失败');
    assert.ok(/child\.exitCode!==null/.test(s.slice(guard - 40, at)), name + '：要等子进程退出');
  }
});
