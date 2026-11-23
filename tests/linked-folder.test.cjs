'use strict';
// 关联文件夹（桌面端让模型读、改用户电脑上的一个文件夹）：桌面端本地模块、服务器上的副本接口、网页里的比对和权限规则。
// 全部用临时文件夹和合成账号，不启动模型、不碰正式服务，也不碰真实的回收站。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { fixture } = require('./model-server-fixture.cjs');
const folders = require('../desktop/folders.js');
const root = path.join(__dirname, '..');

// ---------- 桌面端：desktop/folders.js ----------
function desk(t, { files = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-folder-test-'));
  const home = path.join(base, 'home'), pick = path.join(home, '论文'), data = path.join(base, 'appdata'), bin = path.join(base, 'recycle');
  for (const d of [pick, data, bin]) fs.mkdirSync(d, { recursive: true });
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(pick, rel)), { recursive: true }); fs.writeFileSync(path.join(pick, rel), text); }
  const trashed = [];
  const api = folders.create({ dir: data, home, env: {}, trash: async (p) => { trashed.push(p); fs.renameSync(p, path.join(bin, trashed.length + '-' + path.basename(p))); } });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { api, base, home, pick, data, trashed, text: (rel) => fs.readFileSync(path.join(pick, rel), 'utf8') };
}

test('桌面端：关联一个文件夹，默认「每次问我」；同一个文件夹再选一次不会重复', (t) => {
  const d = desk(t, { files: { '第一章.md': '一', '图/a.png': 'png' } });
  const link = d.api.add(d.pick);
  assert.match(link.id, /^[a-f0-9]{16}$/); assert.equal(link.name, '论文'); assert.equal(link.tier, 'ask'); assert.equal(link.count, 2); assert.equal(link.existed, false);
  assert.equal(d.api.add(d.pick).existed, true); assert.equal(d.api.list().length, 1);
  assert.deepEqual(d.api.scan(link.id).files.map((f) => f.path), ['图/a.png', '第一章.md']);
});

test('桌面端：整个盘、整个用户文件夹、系统目录、应用自己的数据目录都不让关联', (t) => {
  const d = desk(t);
  const code = (p, env) => { try { folders.create({ dir: d.data, home: d.home, env: env || {}, trash: async () => {} }).add(p); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(path.parse(d.base).root), 'TOO_WIDE');
  assert.equal(code(d.home), 'TOO_WIDE'); assert.equal(code(d.base), 'TOO_WIDE'); // 用户文件夹和它的上级
  assert.equal(code(d.data), 'SYSTEM');
  const win = path.join(d.base, 'Windows'); fs.mkdirSync(path.join(win, 'sub'), { recursive: true });
  assert.equal(code(path.join(win, 'sub'), { WINDIR: win }), 'SYSTEM');
  assert.equal(code(path.join(d.home, 'AppData')), 'BAD_ROOT'); // 不存在
  fs.mkdirSync(path.join(d.home, 'AppData', 'Roaming'), { recursive: true });
  assert.equal(code(path.join(d.home, 'AppData', 'Roaming')), 'SYSTEM');
  assert.equal(code('relative/path'), 'BAD_ROOT');
});

test('桌面端：扫描跳过隐藏文件、系统文件、Office 锁文件、程序和快捷方式，太大的文件夹直接拒绝', (t) => {
  const d = desk(t, { files: { 'a.txt': 'a', '.git/config': 'x', 'node_modules/m/i.js': 'x', '~$草稿.docx': 'lock', 'Thumbs.db': 'x', 'setup.exe': 'MZ', '链接.lnk': 'x', 'sub/b.txt': 'b' } });
  const link = d.api.add(d.pick), scan = d.api.scan(link.id);
  assert.deepEqual(scan.files.map((f) => f.path), ['a.txt', 'sub/b.txt']);
  assert.deepEqual(scan.skipped.map((s) => s.why + ':' + s.path).sort(), ['type:setup.exe', 'type:链接.lnk']);
  const many = desk(t);
  for (let i = 0; i <= folders.LIMITS.files; i++) fs.writeFileSync(path.join(many.pick, 'f' + i + '.txt'), '');
  assert.throws(() => many.api.add(many.pick), (e) => e.code === 'TOO_BIG');
  assert.equal(many.api.list().length, 0);
});

test('桌面端：路径出不了关联的文件夹（.. 、绝对路径、盘符、保留名、链接都不行）', (t) => {
  const d = desk(t, { files: { 'a.txt': 'a' } });
  const link = d.api.add(d.pick), outside = path.join(d.base, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  for (const rel of ['../outside.txt', '..', 'sub/../../outside.txt', '/etc/passwd', 'C:/x.txt', 'a\\b.txt', '', '.hidden', 'x/.git/config', 'con', 'nul.txt', 'a.txt ', 'a.', 'x//y', 'a:b']) {
    assert.equal(folders.relParts(rel), null, rel);
    assert.throws(() => d.api.read(link.id, rel), (e) => e.code === 'BAD_PATH', rel);
    assert.throws(() => d.api.write(link.id, rel, Buffer.from('x')), (e) => ['BAD_PATH', 'BLOCKED_TYPE'].includes(e.code), rel);
  }
  // 文件夹里放一个指向外面的目录联接：扫描不进去，读写也不走
  const outDir = path.join(d.base, 'elsewhere'); fs.mkdirSync(outDir); fs.writeFileSync(path.join(outDir, 'x.txt'), 'x');
  let linked = true; try { fs.symlinkSync(outDir, path.join(d.pick, 'jump'), 'junction'); } catch { linked = false; }
  if (linked) {
    assert.ok(!d.api.scan(link.id).files.some((f) => f.path.startsWith('jump/')));
    assert.throws(() => d.api.read(link.id, 'jump/x.txt'), (e) => e.code === 'LINK');
    assert.throws(() => d.api.write(link.id, 'jump/new.txt', Buffer.from('x')), (e) => e.code === 'LINK');
    assert.ok(!fs.existsSync(path.join(outDir, 'new.txt')));
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
});

test('桌面端：写回前先备份，用户刚改过的不覆盖，程序类文件不写，只读档什么都不写', async (t) => {
  const d = desk(t, { files: { 'a.txt': '原文' } });
  const link = d.api.add(d.pick), before = d.api.scan(link.id).files[0];
  const r = d.api.write(link.id, 'a.txt', Buffer.from('模型改的'), { expect: { size: before.size, mtime: before.mtime } });
  assert.equal(d.text('a.txt'), '模型改的'); assert.match(r.batch, /^\d{8}-\d{6}-[a-f0-9]{6}$/);
  assert.equal(fs.readFileSync(path.join(d.data, 'backups', link.id, r.batch, 'files', 'a.txt'), 'utf8'), '原文');
  // 对不上（用户这边的文件和网页比对时不一样了）：不动
  assert.deepEqual(d.api.write(link.id, 'a.txt', Buffer.from('再改'), { expect: { size: before.size, mtime: before.mtime } }).conflict, true);
  assert.equal(d.api.write(link.id, 'new.txt', Buffer.from('x'), { expect: { size: 1, mtime: 1 } }).conflict, true);
  assert.equal(d.text('a.txt'), '模型改的'); assert.ok(!fs.existsSync(path.join(d.pick, 'new.txt')));
  // 新建带子文件夹的文件
  d.api.write(link.id, '图/说明.md', Buffer.from('新的'), { batch: r.batch, expect: null });
  assert.equal(d.text('图/说明.md'), '新的');
  assert.throws(() => d.api.write(link.id, 'run.exe', Buffer.from('MZ')), (e) => e.code === 'BLOCKED_TYPE');
  assert.throws(() => d.api.write(link.id, 'a.txt', 'not bytes'), (e) => e.code === 'BAD_DATA');
  d.api.setTier(link.id, 'read');
  assert.throws(() => d.api.write(link.id, 'a.txt', Buffer.from('x')), (e) => e.code === 'READ_ONLY');
  await assert.rejects(d.api.trash(link.id, 'a.txt'), (e) => e.code === 'READ_ONLY');
  assert.equal(d.text('a.txt'), '模型改的'); assert.equal(d.api.read(link.id, 'a.txt').bytes.toString(), '模型改的'); // 只读档照样能读
  assert.throws(() => d.api.setTier(link.id, 'root'), (e) => e.code === 'BAD_TIER');
  // 文件夹里没有留下临时文件
  assert.deepEqual(fs.readdirSync(d.pick).sort(), ['a.txt', '图']);
});

test('桌面端：撤销一批写回——改过的还原、新建的进回收站、删掉的放回来；之后用户又动过的不碰', async (t) => {
  const d = desk(t, { files: { 'keep.txt': '原样', 'gone.txt': '要被删', 'mine.txt': '旧' } });
  const link = d.api.add(d.pick);
  const first = d.api.write(link.id, 'keep.txt', Buffer.from('改了'));
  d.api.write(link.id, 'made.txt', Buffer.from('新建'), { batch: first.batch });
  d.api.write(link.id, '新的/里面/note.md', Buffer.from('新建'), { batch: first.batch });
  d.api.write(link.id, '新的/用户后来放的.txt', Buffer.from('x'), { batch: first.batch }); fs.writeFileSync(path.join(d.pick, '新的', '用户后来放的.txt'), '用户改过，撤销时不动');
  d.api.write(link.id, 'mine.txt', Buffer.from('模型的'), { batch: first.batch });
  const del = await d.api.trash(link.id, 'gone.txt', { batch: first.batch });
  assert.equal(del.batch, first.batch); assert.ok(!fs.existsSync(path.join(d.pick, 'gone.txt'))); assert.equal(d.trashed.length, 1);
  fs.writeFileSync(path.join(d.pick, 'mine.txt'), '用户后来自己又写了很多'); // 写回之后用户又改了
  const r = await d.api.undo(link.id, first.batch);
  assert.deepEqual(r.restored.sort(), ['gone.txt', 'keep.txt', 'made.txt', '新的/里面/note.md']); assert.deepEqual(r.skipped.sort(), ['mine.txt', '新的/用户后来放的.txt']);
  // 为新建文件建的空文件夹一起收走；里面还有用户的东西的留着
  assert.ok(!fs.existsSync(path.join(d.pick, '新的', '里面'))); assert.ok(fs.existsSync(path.join(d.pick, '新的', '用户后来放的.txt')));
  assert.equal(d.text('keep.txt'), '原样'); assert.equal(d.text('gone.txt'), '要被删'); assert.equal(d.text('mine.txt'), '用户后来自己又写了很多');
  assert.ok(!fs.existsSync(path.join(d.pick, 'made.txt'))); assert.equal(d.trashed.length, 3);
  await assert.rejects(d.api.undo(link.id, first.batch), (e) => e.code === 'UNDONE');
  await assert.rejects(d.api.undo(link.id, '20260101-000000-abcdef'), (e) => e.code === 'NO_BATCH');
  await assert.rejects(d.api.undo(link.id, '../../x'), (e) => e.code === 'NO_BATCH');
});

test('桌面端：同步记录替网页存在本机；取消关联后不认；过期备份会清', (t) => {
  let today = new Date(2026, 10, 22, 9, 0, 0);
  const d = desk(t, { files: { 'a.txt': 'a' } });
  const api = folders.create({ dir: d.data, home: d.home, env: {}, trash: async () => {}, now: () => today });
  const link = api.add(d.pick);
  assert.equal(api.getState(link.id), ''); api.setState(link.id, '{"v":1}'); assert.equal(api.getState(link.id), '{"v":1}');
  assert.throws(() => api.setState(link.id, 'x'.repeat(folders.LIMITS.state + 1)), (e) => e.code === 'BAD_STATE');
  const w = api.write(link.id, 'a.txt', Buffer.from('b'));
  assert.equal(api.prune(), 0);
  const old = new Date(Date.now() - 40 * 86400000); fs.utimesSync(path.join(d.data, 'backups', link.id, w.batch), old, old);
  today = new Date();
  assert.equal(api.prune(), 1); assert.ok(!fs.existsSync(path.join(d.data, 'backups', link.id, w.batch)));
  assert.equal(api.remove(link.id), true); assert.equal(api.remove(link.id), false);
  assert.throws(() => api.scan(link.id), (e) => e.code === 'NO_LINK'); assert.throws(() => api.getState(link.id), (e) => e.code === 'NO_LINK');
  assert.equal(fs.readFileSync(path.join(d.pick, 'a.txt'), 'utf8'), 'b'); // 取消关联不动用户的文件
  assert.throws(() => api.scan('../../etc'), (e) => e.code === 'NO_LINK');
});

test('桌面端：只有主窗口里自己网站的页面能调用；文件夹只能从系统对话框来；调宽权限要系统对话框确认', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8'), preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
  assert.match(main, /const fromPage = \(e\) => !!win && e\.sender === win\.webContents && e\.senderFrame === win\.webContents\.mainFrame && sameOrigin\(e\.senderFrame\.url\);/);
  assert.match(main, /if \(!fromPage\(e\)\) return \{ error: '不允许', code: 'FORBIDDEN' \};/);
  // 没有任何动作接受网页给的绝对路径：add 只出现在选文件夹对话框的结果上
  assert.equal(main.split('folders.add(').length - 1, 2); // 只有两处：用户自己选的文件夹、用户在确认框里点了「信任」的位置
  assert.match(main, /const trusted = await confirmBox\(\{[\s\S]{0,700}cancel: '不允许', ok: '信任这个位置',\s*\}\);\s*return trusted \? folders\.add\(view\.root, \{ anySize: true, tier, scope \}\) : null;/); assert.match(main, /dialog\.showOpenDialog\(win,[^)]*\)[\s\S]{0,160}folders\.add\(r\.filePaths\[0\], \{ anySize: true, scope \}\)/);
  // 调宽权限：单个文件夹、整个对话两条路都先过确认窗，用户不点「改成」就原样返回
  assert.match(main, /const wider = \(link, tier\) => folders\.TIERS\.indexOf\(tier\) > folders\.TIERS\.indexOf\(link\.tier\);/);
  assert.match(main, /if \(wider\(link, tier\) && !\(await confirmBox\(\{[\s\S]{0,300}\}\)\)\) return link;\s*return folders\.setTier\(id, tier\);/);
  assert.match(main, /raise = links\.filter\(\(l\) => wider\(l, tier\)\);\s*if \(raise\.length && !\(await confirmBox\(\{[\s\S]{0,400}\}\)\)\) return links;\s*return ids\.map\(\(id\) => folders\.setTier\(id, tier\)\);/);
  assert.equal(main.split('folders.setTier(').length - 1, 2); assert.ok(!main.includes('showMessageBox'));
  // 确认窗是桌面端自己开的另一个窗口，内容是安装包里的文件；网页拿不到它，它也只有三个动作。回答只认它自己发来的 true
  assert.match(main, /box\.webContents\.ipc\.on\('answer', \(_e, yes\) => \{ answer = yes === true;/); assert.match(main, /box\.loadFile\(path\.join\(__dirname, 'confirm\.html'\)\);/);
  assert.match(main, /preload: path\.join\(__dirname, 'confirm-preload\.js'\), contextIsolation: true, sandbox: true, nodeIntegration: false/);
  assert.match(main, /box\.webContents\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\);/); assert.match(main, /if \(asking \|\| !win \|\| win\.isDestroyed\(\)\) return Promise\.resolve\(false\);/);
  const boxPreload = fs.readFileSync(path.join(root, 'desktop', 'confirm-preload.js'), 'utf8'), boxPage = fs.readFileSync(path.join(root, 'desktop', 'confirm.html'), 'utf8');
  assert.deepEqual([...boxPreload.matchAll(/ipcRenderer\.(?:invoke|send)\('(\w+)'/g)].map((m) => m[1]), ['spec', 'size', 'answer']);
  assert.ok(!boxPage.includes('innerHTML')); assert.match(boxPage, /default-src 'none'/); assert.match(boxPage, /cancel\.focus\(\);/); // 内容只当文字放；默认停在「不」上
  // 测试用的捷径（不弹确认窗、换数据目录）都挂在 DEV_ORIGIN 上，打了包它就是空的
  const envUses = main.split('process.env.RELAY_DESKTOP_').length - 1, guarded = main.split('DEV_ORIGIN && process.env.RELAY_DESKTOP_').length - 1;
  assert.equal(guarded, 3); assert.equal(envUses, guarded + 4); // 另外四处：DEV_ORIGIN 自己那一行两次，两个已经判断过之后取值的地方
  assert.match(main, /if \(DEV_ORIGIN && process\.env\.RELAY_DESKTOP_TEST_CONFIRM\) return Promise\.resolve\(true\);/);
  // 没有系统标题栏：右上角三个按钮底下透明，拖动窗口的那一条由桌面端塞进每个页面
  assert.match(main, /titleBarStyle: 'hidden', titleBarOverlay: chrome\(\),/); assert.match(main, /win\.webContents\.on\('dom-ready', \(\) => \{ win\.webContents\.insertCSS\(DRAG_CSS\)/);
  assert.match(page, /#app:not\(\.panel-open\) \.topbar \{ padding-right: calc\(10px \+ 100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\); \}/);
  // 这种窗口里右上角不放加号：侧边栏开着时不显示，收起时挪到左边；别的地方（浏览器、手机）没有 wco 这个类，照旧
  assert.ok(page.includes('html.wco #topNew { display: none; }')); assert.ok(page.includes('html.wco #app.side-collapsed #topNew { display: grid; }'));
  assert.match(page, /classList\.toggle\('wco', !!navigator\.windowControlsOverlay\.visible\)/);
  // 调试用的本机地址只在没打包时认
  assert.match(main, /!app\.isPackaged \? process\.env\.RELAY_DESKTOP_ORIGIN : ''/);
  for (const name of ['list', 'pick', 'trust', 'remove', 'setTier', 'setTierAll', 'scan', 'read', 'stat', 'readChunk', 'hash', 'write', 'writeStart', 'writeChunk', 'writeEnd', 'writeAbort', 'trash', 'undo', 'getState', 'setState', 'reveal']) {
    assert.ok(main.includes(`folderAction('${name}'`), name); assert.ok(preload.includes(`'${name}'`), name);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
  for (const f of ['folders.js', 'confirm.html', 'confirm-preload.js']) assert.ok(pkg.build.files.includes(f), f); // 确认窗的两个文件也要进安装包
  assert.equal(pkg.version, '0.9.0');
  // 确认窗里的说法和新做法一致：没超上限的整个传过去，超了的只给清单
  assert.ok(main.includes("'里面的 ' + view.count + ' 个文件（共 ' + sizeText(view.bytes) + '）会传给 Claude，之后两边的改动互相同步。'"));
  assert.ok(main.includes("'这个位置里文件很多，Claude 会先只拿到文件清单，用到哪个再取哪个。'")); assert.ok(!main.includes('要读哪个才取哪个'));
});

// ---------- 服务器：linked/<编号>/ 这份副本 ----------
const ID = 'a1b2c3d4e5f60718';
test('服务器：路径规则——只认 16 位编号，逐段检查，出不了 linked/<编号>', (t) => {
  const h = fixture(t), rel = (id, p) => h.evaluate(`linkedRel(${JSON.stringify(id)}${p === undefined ? '' : ', ' + JSON.stringify(p)})`);
  assert.equal(rel(ID), 'linked/' + ID); assert.equal(rel(ID, '第一章/图 1.png'), `linked/${ID}/第一章/图 1.png`);
  for (const bad of ['../x', 'a/../../x', '/abs', 'a//b', '.git/config', 'a/.env', 'a\\b', 'C:/x', 'a:b', 'x?', 'a.', 'a ', 'node_modules/x.js', 'x'.repeat(401), Array(14).fill('d').join('/')]) assert.equal(rel(ID, bad), null, bad);
  for (const bad of ['', 'abc', '../' + ID, ID.toUpperCase(), ID + '0']) assert.equal(rel(bad, 'a.txt'), null, bad);
  assert.equal(h.evaluate(`JSON.stringify(linkedOf({ id: '${ID}', name: ' 论文[草稿]\\n' }))`), JSON.stringify({ id: ID, name: '论文 草稿' }));
  assert.equal(h.evaluate(`linkedOf({ id: 'nope', name: 'x' })`), null); assert.equal(h.evaluate(`linkedOf({ id: '${ID}', name: '  ' })`), null); assert.equal(h.evaluate(`linkedOf(null)`), null);
});

test('服务器：收文件（保留子文件夹、同名覆盖）、列出、取回、删除；文件面板不列这些文件', async (t) => {
  const h = fixture(t), q = (p) => `/api/linked?id=${ID}&path=${encodeURIComponent(p)}`;
  assert.deepEqual((await h.route(`/api/linked?id=${ID}`)).body, { files: [], truncated: false }); // 还没有副本
  const first = (await h.route(q('第一章/正文.md'), 'PUT', Buffer.from('初稿'))).body;
  assert.equal(first.size, 6); assert.ok(first.mtime > 0); assert.deepEqual(Object.keys(first).sort(), ['mtime', 'size']);
  assert.equal((await h.route(q('a.txt'), 'PUT', Buffer.from('1'))).status, 200);
  const again = (await h.route(q('第一章/正文.md'), 'PUT', Buffer.from('改过的第二稿'))).body; // 覆盖，不会变成「正文 (1).md」
  assert.equal(again.size, 18);
  const list = (await h.route(`/api/linked?id=${ID}`)).body;
  assert.deepEqual(list.files.map((f) => [f.path, f.size]).sort(), [['a.txt', 1], ['第一章/正文.md', 18]]);
  assert.ok(list.files.every((f) => typeof f.mtime === 'number'));
  // PUT 回的大小和时间就是列出来的那一对：网页拿到当场记下，不用批末再问一次列表
  assert.equal(list.files.find((f) => f.path === '第一章/正文.md').mtime, again.mtime);
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8'), put = source.slice(source.indexOf("if (p === '/api/linked' && req.method === 'PUT') {"), source.indexOf("if (p === '/api/linked/remove'"));
  assert.ok(put.includes("try { mtime = (await workRows(u, [{ type: 'stat', path: rel }]))[0]?.value?.mtime || 0; } catch {}")); // 隔离开着的那条路也回
  assert.ok(put.includes('return sendJSON(res, 200, mtime ? { size, mtime } : { size });'));
  assert.equal(fs.readFileSync(path.join(h.workspace, 'linked', ID, '第一章', '正文.md'), 'utf8'), '改过的第二稿');
  const got = await h.route('/api/file?path=' + encodeURIComponent(`linked/${ID}/第一章/正文.md`) + '&download=1');
  assert.equal(Buffer.concat(got.chunks).toString('utf8'), '改过的第二稿');
  // 文件面板：只列对话里做出来的文件
  await h.io.writeFromStream(h.ctx, 'uploads/note.txt', require('node:stream').Readable.from([Buffer.from('n')]));
  assert.deepEqual((await h.route('/api/files')).body.files.map((f) => f.path), ['uploads/note.txt']);
  // 路径不对的一律拒绝，工作区里也不会多出东西
  for (const bad of ['../../escape.txt', '.relay/x.json', 'a\\b.txt', '']) assert.equal((await h.route(q(bad), 'PUT', Buffer.from('x'))).status, 400, bad);
  assert.equal((await h.route(`/api/linked?id=nope&path=a.txt`, 'PUT', Buffer.from('x'))).status, 400);
  assert.equal((await h.route(`/api/linked?id=nope`)).status, 400);
  assert.ok(!fs.existsSync(path.join(h.workspace, 'escape.txt'))); assert.ok(!fs.existsSync(path.join(h.workspace, '.relay')));
  // 删除：指定的文件；路径不对的忽略；all 删整份副本
  assert.deepEqual((await h.route('/api/linked/remove', 'POST', { id: ID, paths: ['a.txt', '../../uploads/note.txt', ''] })).body, { removed: 1 });
  assert.ok(!fs.existsSync(path.join(h.workspace, 'linked', ID, 'a.txt'))); assert.ok(fs.existsSync(path.join(h.workspace, 'uploads', 'note.txt')));
  assert.equal((await h.route('/api/linked/remove', 'POST', { id: 'nope', all: true })).status, 400);
  assert.deepEqual((await h.route('/api/linked/remove', 'POST', { id: ID, all: true })).body, { removed: 1 });
  assert.ok(!fs.existsSync(path.join(h.workspace, 'linked', ID))); assert.ok(fs.existsSync(path.join(h.workspace, 'uploads', 'note.txt')));
});

test('服务器：消息带着关联的文件夹时，提示里告诉模型副本在哪、改动会写回；没带就不提', (t) => {
  const h = fixture(t);
  // 只有「工作」的对话才提文件夹（聊天的见 chat-work-mode.test.cjs）
  const prompt = (linked) => h.evaluate(`buildPrompt(USERS.get('alice'), { id: 'c0ffee00c0ffee00', mode: 'work' }, '帮我改第三章', [], null, null, ${JSON.stringify(linked)})`);
  const withFolder = prompt({ id: ID, name: '论文草稿' });
  assert.ok(withFolder.includes(`文件夹「论文草稿」已经关联到这个对话，它的副本在 ./linked/${ID}`)); assert.ok(withFolder.includes('不要另存到 outputs'));
  assert.ok(withFolder.indexOf('本对话的文件夹') < withFolder.indexOf('已经关联到这个对话'));
  for (const none of [undefined, null, { id: 'bad', name: 'x' }, { id: ID }]) assert.ok(!prompt(none).includes('linked/'), JSON.stringify(none));
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(source.includes('if (linkedList(body.linked).length) userMsg.linked = linkedList(body.linked);'));
  assert.ok(source.includes('userMsg.attachments, userMsg.tool, userMsg.tz, userMsg.linked, userMsg.canTrust);'));
});

test('服务器：一个对话可以带几个文件夹，提示里逐个列出；单个对象和数组都认，最多 6 个', (t) => {
  const h = fixture(t), ID2 = 'b2c3d4e5f6071829';
  const list = (v) => JSON.parse(h.evaluate(`JSON.stringify(linkedList(${JSON.stringify(v)}))`));
  assert.deepEqual(list({ id: ID, name: '论文' }), [{ id: ID, name: '论文' }]);
  assert.deepEqual(list([{ id: ID, name: '论文' }, { id: ID, name: '重复的' }, { id: 'bad', name: 'x' }, { id: ID2, name: '数据' }]), [{ id: ID, name: '论文' }, { id: ID2, name: '数据' }]);
  assert.deepEqual(list(null), []); assert.deepEqual(list('x'), []);
  assert.equal(list(Array.from({ length: 9 }, (_, i) => ({ id: 'a1b2c3d4e5f6071' + i, name: 'n' + i }))).length, 6);
  const prompt = h.evaluate(`buildPrompt(USERS.get('alice'), { id: 'c0ffee00c0ffee00', mode: 'work' }, '整理一下', [], null, null, ${JSON.stringify([{ id: ID, name: '论文' }, { id: ID2, name: '数据' }])})`);
  assert.ok(prompt.includes(`用户电脑上的2 个文件夹已经关联到这个对话，副本分别在：「论文」→ ./linked/${ID}；「数据」→ ./linked/${ID2}（子文件夹照原样）`), prompt);
  assert.ok(prompt.includes('直接在对应的副本里做'));
});

test('服务器：项目可以建在文件夹上——新建时带、之后能改，列表里看得到，项目里的对话没带也会告诉模型', async (t) => {
  const h = fixture(t), ID2 = 'b2c3d4e5f6071829';
  const made = (await h.route('/api/projects', 'POST', { name: '毕业论文', linked: [{ id: ID, name: '论文' }, { id: 'nope', name: 'x' }] })).body;
  assert.deepEqual(made.linked, [{ id: ID, name: '论文' }]);
  assert.deepEqual((await h.route('/api/projects')).body.projects.find((p) => p.id === made.id).linked, [{ id: ID, name: '论文' }]);
  const plain = (await h.route('/api/projects', 'POST', { name: '普通项目' })).body;
  assert.equal(plain.linked, undefined);
  assert.deepEqual((await h.route('/api/projects')).body.projects.find((p) => p.id === plain.id).linked, []);
  // 加一个、再全部去掉；不带 linked 的修改不动它
  let r = (await h.route('/api/projects/' + made.id, 'PATCH', { linked: [{ id: ID, name: '论文' }, { id: ID2, name: '数据' }] })).body;
  assert.deepEqual(r.project.linked.map((x) => x.name), ['论文', '数据']);
  r = (await h.route('/api/projects/' + made.id, 'PATCH', { description: '改个简介' })).body;
  assert.equal(r.project.linked.length, 2);
  // 项目里的对话：消息自己没带（比如在手机上发的），提示里用项目的；自己带了就用自己的
  const prompt = (linked) => h.evaluate(`buildPrompt(USERS.get('alice'), { id: 'c0ffee00c0ffee00', projectId: '${made.id}' }, '继续写', [], null, null, ${JSON.stringify(linked)})`);
  assert.ok(prompt(undefined).includes(`「论文」→ ./linked/${ID}；「数据」→ ./linked/${ID2}`));
  assert.ok(prompt([{ id: ID2, name: '数据' }]).includes(`文件夹「数据」已经关联到这个对话，它的副本在 ./linked/${ID2}`));
  assert.ok(!h.evaluate(`buildPrompt(USERS.get('alice'), { id: 'c0ffee00c0ffee00', projectId: '${plain.id}' }, '继续写', [], null, null, undefined)`).includes('linked/'));
  r = (await h.route('/api/projects/' + made.id, 'PATCH', { linked: [] })).body;
  assert.deepEqual(r.project.linked, []); assert.ok(!prompt(undefined).includes('linked/'));
});

// ---------- 网页：比对和权限规则（只取页面里的那一段代码在内存里跑）----------
const page = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const from = page.indexOf('const LF_TIERS = ['), to = page.indexOf('// ---- 授权按对话分开', from);
assert.ok(from > 0 && to > from);
const ctx = vm.createContext({ TextDecoder, Uint32Array, Uint8Array });
vm.runInContext('const extOf = (p) => (p.match(/\\.([^./]+)$/) || [, \'\'])[1].toLowerCase();\n' + page.slice(from, to) +
  '\nglobalThis.lf = { lfCompare, lfReasons, lfUnwritable, lfLineDiff, lfText, lfSameBytes, LF_TIERS, LF_BLOCKED: [...LF_BLOCKED] };', ctx);
const lf = ctx.lf, f = (size, mtime) => ({ size, mtime }), plain = (v) => JSON.parse(JSON.stringify(v));

test('网页：三方比对——用户改的往上传，模型改的等写回，两边都改的单独拎出来', () => {
  const files = { 'same.txt': [1, 10, 1, 100], 'mine.txt': [1, 10, 1, 100], 'model.txt': [1, 10, 1, 100], 'both.txt': [1, 10, 1, 100],
    'i-deleted.txt': [1, 10, 1, 100], 'model-deleted.txt': [1, 10, 1, 100], 'both-gone.txt': [1, 10, 1, 100] };
  const local = new Map([['same.txt', f(1, 10)], ['mine.txt', f(2, 11)], ['model.txt', f(1, 10)], ['both.txt', f(3, 12)], ['model-deleted.txt', f(1, 10)], ['i-made.txt', f(5, 5)]]);
  const server = new Map([['same.txt', f(1, 100)], ['mine.txt', f(1, 100)], ['model.txt', f(9, 200)], ['both.txt', f(4, 300)], ['i-deleted.txt', f(1, 100)], ['model-made.txt', f(7, 7)]]);
  const r = plain(lf.lfCompare(files, local, server)), by = (list) => Object.fromEntries(list.map((x) => [x.path, x.kind]));
  assert.deepEqual(by(r.up), { 'mine.txt': 'put', 'i-deleted.txt': 'remove', 'i-made.txt': 'put' });
  assert.deepEqual(by(r.down), { 'model.txt': 'modified', 'model-deleted.txt': 'deleted', 'model-made.txt': 'created' });
  assert.deepEqual(r.both.map((x) => x.path), ['both.txt']); assert.deepEqual(r.forget, ['both-gone.txt']);
  // 第一次关联：没有记录，本地的全部往上传，不会有「模型的改动」
  const first = plain(lf.lfCompare({}, local, new Map()));
  assert.equal(first.up.length, local.size); assert.ok(first.up.every((x) => x.kind === 'put')); assert.deepEqual(first.down, []);
});

test('网页：自动审查只放行普通的新建和修改；全部允许也不放行冲突、程序和一次删太多', () => {
  const mod = (extra = {}) => ({ path: 'a.md', kind: 'modified', local: f(4000, 1), server: f(4100, 2), ...extra });
  const why = (tier, c, all) => plain(lf.lfReasons(tier, c, all || [c]));
  assert.deepEqual(why('auto', mod()), []);
  assert.deepEqual(why('auto', { path: 'new/图.png', kind: 'created', local: null, server: f(900, 2) }), []);
  assert.deepEqual(why('auto', { path: 'a.md', kind: 'deleted', local: f(1, 1), server: null }), ['要删除文件']);
  assert.deepEqual(why('auto', mod({ conflict: true })), ['两边都改过']);
  assert.deepEqual(why('auto', mod({ path: 'run.ps1' })), ['脚本文件']);
  assert.deepEqual(why('auto', mod({ server: f(60 * 1048576, 2), local: f(57 * 1048576, 1) })), []); // 文件大不是先问的理由
  assert.deepEqual(why('auto', { path: '备份/答辩.pptx', kind: 'created', local: null, server: f(57 * 1048576, 2) }), []);
  assert.deepEqual(why('auto', mod({ server: f(500, 2) })), ['内容少了一大半']);
  assert.deepEqual(why('auto', mod(), Array(31).fill(mod())), ['一次改得太多']);
  assert.deepEqual(why('all', mod({ path: 'run.ps1', server: f(500, 2) })), []);
  assert.deepEqual(why('all', { path: 'a.md', kind: 'deleted', local: f(1, 1), server: null }), []);
  const six = Array(6).fill({ path: 'x.md', kind: 'deleted', local: f(1, 1), server: null });
  assert.deepEqual(why('all', six[0], six), ['一次删得太多']);
  assert.deepEqual(why('all', mod({ conflict: true })), ['两边都改过']);
  for (const tier of ['auto', 'all']) {
    assert.deepEqual(why(tier, { path: 'tool.exe', kind: 'created', local: null, server: f(10, 1) })[0], '这类文件不写回');
    assert.ok(why(tier, mod({ server: f(501 * 1048576, 2) })).includes('文件太大'));
    assert.ok(!why(tier, mod({ server: f(400 * 1048576, 2), local: f(400 * 1048576, 1) })).includes('文件太大')); // 500MB 以内不算太大
  }
  assert.equal(lf.lfUnwritable({ path: 'a.LNK', server: f(1, 1) }), true); assert.equal(lf.lfUnwritable(mod()), false);
  assert.deepEqual(plain(lf.LF_TIERS.map((x) => x[0])), folders.TIERS); // 网页和桌面端的档位一致
  assert.deepEqual(plain(lf.LF_BLOCKED).sort(), [...folders.BLOCKED].map((x) => x.slice(1)).sort()); // 不写回的类型也一致
  assert.deepEqual(why('auto', mod({ path: '表.xlsm' })), ['脚本文件']); // 带宏的 Office 文件也先问
});

test('网页：逐行比较和文本识别', () => {
  const d = lf.lfLineDiff(['一', '二', '三', '四', '五'], ['一', '二', '三点五', '四', '五', '六']);
  assert.equal(d.added, 2); assert.equal(d.removed, 1);
  assert.deepEqual(plain(d.rows), [[' ', '一'], [' ', '二'], ['-', '三'], ['+', '三点五'], [' ', '四'], [' ', '五'], ['+', '六']]);
  assert.equal(lf.lfLineDiff(['a'], ['a']).rows.filter((r) => r[0] !== ' ').length, 0);
  const big = (n, tag) => Array.from({ length: n }, (_, i) => tag + i);
  assert.equal(lf.lfLineDiff(big(3000, 'x'), big(3000, 'y')), null);
  assert.equal(lf.lfText(new TextEncoder().encode('你好\nhello')), '你好\nhello');
  assert.equal(lf.lfText(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3])), '你好'); // GBK 的「你好」
  assert.equal(lf.lfText(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), null); // 压缩包、Office 文件
  assert.equal(lf.lfText(new Uint8Array(500 * 1024)), null);
  assert.equal(lf.lfSameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2])), true); assert.equal(lf.lfSameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])), false);
});

test('网页：发消息前同步、回复结束后比对、换账号重读；没有桌面端接口时什么都不做', () => {
  assert.ok(page.includes("if (typeof lfBeforeSend === 'function') await lfBeforeSend(body, sendConvId);"));
  assert.ok(page.indexOf('await lfBeforeSend(body, sendConvId)') < page.indexOf("const r = await post('/api/chat', body);"));
  assert.ok(page.includes("if ((ev.type === 'done' || ev.type === 'files') && typeof lfAfterReply === 'function') lfAfterReply(ev.convId);"));
  assert.ok(page.includes("if (typeof lfWake === 'function') lfWake().catch(() => {});"));
  assert.ok(page.includes("if (!ev.running && typeof lfAfterReply === 'function') lfAfterReply(ev.convId);")); // 没打开着的对话回复完也比对
  assert.match(page, /const LF = \{ api: \(typeof window !== 'undefined' && window\.relayDesktop\?\.folders\) \|\| null,/);
  assert.match(page, /function lfCurrentAll\(\) \{ return LF\.api \? /);
  assert.match(page, /<button class="tool-btn hidden" id="folderBtn"/); assert.match(page, /<div class="folder-bar hidden" id="folderBar"><\/div>/);
  // 副本整个不见时重传（记成 filling，不是 initial），不当成模型删了文件
  assert.ok(page.includes('if (!sv.map.size && Object.keys(st.files).length) { st.files = {}; if (!st.initial) st.filling = true; }'));
  // 换了账号的关联不显示：只认记着这个账号的；没记账号的老授权，范围是这个账号的才认下来，认不出来的不算谁的
  assert.ok(page.includes('if (user && st.user === user) mine.push(l);'));
  assert.ok(page.includes('else if (user && !st.user && lfScopeHere(l.scope)) { st.user = user; mine.push(l);'));
  assert.ok(!page.includes('if (!st.user || st.user === authState.user) mine.push(l);'));
  // 退出、换账号时页面上不留上一个账号的授权和进度
  assert.ok(page.includes("if (typeof lfForget === 'function') lfForget();"));
});

// ---------- 网页：授权按对话分开 ----------
function scopeHarness() {
  const a = page.indexOf('// ---- 授权按对话分开'), b = page.indexOf('function lfStatus(link, patch)', a);
  assert.ok(a > 0 && b > a);
  const c = vm.createContext({});
  vm.runInContext('var S, LF; let made = 0; const newDraftId = () => "draft" + String(++made).padStart(11, "0");\n' + page.slice(a, b) +
    '\nglobalThis.w = { lfScope, lfScoped, lfWanted, lfCurrentAll, lfIdsOfConv, lfWants, set: (st, lf) => { S = st; LF = lf; } };', c);
  return c.w;
}
const CA = 'c0ffee00c0ffee00', CB = 'deadbeefdeadbeef';

test('网页：每个对话只认自己授权的文件夹——同一个文件夹给两个对话用是两份，互不相干', () => {
  const w = scopeHarness();
  const links = [{ id: 'a'.repeat(16), name: 'Desktop', path: 'C:\\Users\\x\\Desktop', scope: CA }, { id: 'b'.repeat(16), name: 'Desktop', path: 'C:\\Users\\x\\Desktop', scope: CB }, { id: 'c'.repeat(16), name: '论文', path: 'D:\\论文', scope: CB }];
  const S = { convId: CA, conv: { id: CA, messages: [] }, projects: [], convs: [{ id: CA }, { id: CB }] }, LF = { api: {}, links };
  w.set(S, LF);
  assert.equal(w.lfScope(), CA);
  assert.deepEqual(plain(w.lfCurrentAll()).map((l) => l.id), ['a'.repeat(16)]);                  // 对话 A 只有自己那一份 Desktop
  S.convId = CB; S.conv = { id: CB, messages: [] };
  assert.deepEqual(plain(w.lfCurrentAll()).map((l) => l.id), ['b'.repeat(16), 'c'.repeat(16)]);   // 对话 B 是另一份 Desktop，外加它自己的「论文」
  assert.deepEqual(plain(w.lfIdsOfConv(CA)), ['a'.repeat(16)]); assert.deepEqual(plain(w.lfIdsOfConv(CB)), ['b'.repeat(16), 'c'.repeat(16)]);
  // 还没授权过任何东西的新对话：一个都没有，也不会顺手领编号；要授权时才领，发消息用的就是这个编号
  S.convId = null; S.conv = null; S.draftId = null;
  assert.equal(w.lfScope(), ''); assert.deepEqual(plain(w.lfCurrentAll()), []); assert.equal(S.draftId, null);
  const scope = w.lfScope(true); assert.equal(scope, S.draftId); assert.match(scope, /^draft/); assert.equal(w.lfScope(true), scope);
  // 浏览器、手机上没有接口：一个都不同步，只按最后一条提问显示名字
  LF.api = null; S.convId = CA; S.conv = { id: CA, messages: [{ role: 'user', linked: [{ id: 'f'.repeat(16), name: '别处授权的' }] }] };
  assert.deepEqual(plain(w.lfCurrentAll()), []); assert.deepEqual(plain(w.lfWanted()), [{ id: 'f'.repeat(16), name: '别处授权的' }]);
});

test('网页：项目里的对话共用项目自己的授权；项目信息里记着而这台电脑上没有的只显示名字', () => {
  const w = scopeHarness();
  const proj = { id: 'abcd1234', name: '毕业论文', linked: [{ id: 'a'.repeat(16), name: '论文' }, { id: 'e'.repeat(16), name: '在另一台电脑上授权的' }] };
  const links = [{ id: 'a'.repeat(16), name: '论文', path: 'D:\\论文', scope: 'p:abcd1234' }, { id: 'b'.repeat(16), name: '论文', path: 'D:\\论文', scope: CB }];
  const S = { convId: null, conv: null, projectId: proj.id, projects: [proj], convs: [{ id: CA, projectId: proj.id }, { id: CB, projectId: null }] }, LF = { api: {}, links };
  w.set(S, LF);
  assert.equal(w.lfScope(), 'p:abcd1234');                                                     // 项目页
  assert.deepEqual(plain(w.lfCurrentAll()).map((l) => l.id), ['a'.repeat(16)]);
  assert.deepEqual(plain(w.lfWanted()).map((x) => x.name), ['论文', '在另一台电脑上授权的']);
  S.convId = CA; S.conv = { id: CA, projectId: proj.id, messages: [] }; S.projectId = null;       // 项目里的对话
  assert.equal(w.lfScope(), 'p:abcd1234'); assert.deepEqual(plain(w.lfIdsOfConv(CA)), ['a'.repeat(16)]);
  assert.deepEqual(plain(w.lfIdsOfConv(CB)), ['b'.repeat(16)]);                                  // 普通对话用的是它自己那一份
});

test('网页：要过的可以是文件也可以是子文件夹；打开应用不再同步所有文件夹，换到哪个对话才同步哪个的', () => {
  const w = scopeHarness();
  assert.equal(w.lfWants(['a.md', '图'], 'a.md'), true); assert.equal(w.lfWants(['图'], '图/1.png'), true); assert.equal(w.lfWants(['图/'], '图/子/2.png'), true);
  assert.equal(w.lfWants(['图'], '图片/1.png'), false); assert.equal(w.lfWants(['a.md'], 'a.md.bak'), false); assert.equal(w.lfWants([], 'a.md'), false);
  const wake = page.slice(page.indexOf('async function lfWake() {'), page.indexOf('// ---- 界面 ----'));
  // 启动时不同步所有文件夹；只有整个传一遍上次没传完的（刷新、关掉了）接着传，而且只接着传这个账号自己的
  const resume = 'for (const l of LF.links) { const st = LF.state.get(l.id); if (lfOwned(st) && (st.initial || st.filling) && !l.missing) lfRun(l).catch(() => {}); }';
  assert.ok(wake.includes(resume)); assert.ok(!wake.replace(resume, '').includes('lfRun('));
  assert.ok(wake.includes("if (!alive && Date.now() - (l.addedAt || 0) > 86400000) await lfDrop(l).catch(() => {});"));
  assert.ok(page.includes('if (LF.api && scope !== LF.scope) {'));
  assert.ok(page.includes('const scope = lfScope(true), mode = lfMode();')); assert.ok(page.includes('try { r = await LF.api.pick(scope); }'));
  assert.ok(page.includes("label: '让这个' + (lfProject() ? '项目' : '对话') + '也用「' + l.name + '」', run: () => lfTrustPath(l.path)")); // 别的对话用过的文件夹：这个对话要用还得再授权
  assert.ok(page.includes("if (typeof lfDropScope === 'function') lfDropScope(c.id).catch(() => {});")); assert.ok(page.includes("lfDropScope('p:' + p.id)"));
  assert.ok(page.includes("${typeof lfProjectBox === 'function' ? lfProjectBox(p) : ''}")); assert.ok(page.includes('body.linked = links.map((l) => ({ id: l.id, name: l.name,'));
  assert.ok(!/lfUseMap|lfSetUse|LF\.draft/.test(page));
});

test('桌面端：同一个文件夹授权给两个对话是两条独立的授权，各有各的档位和记录；收回一条不影响另一条', (t) => {
  const d = desk(t, { files: { 'a.txt': 'a' } });
  const one = d.api.add(d.pick, { scope: CA }), two = d.api.add(d.pick, { scope: CB, tier: 'auto' }), again = d.api.add(d.pick, { scope: CA });
  assert.notEqual(one.id, two.id); assert.equal(again.id, one.id); assert.equal(again.existed, true);
  assert.deepEqual(d.api.list().map((l) => [l.scope, l.tier]), [[CA, 'ask'], [CB, 'auto']]);
  d.api.setState(one.id, '{"v":1,"want":["a.txt"]}'); assert.equal(d.api.getState(two.id), '');
  assert.equal(d.api.preview(d.pick, CA).existed, true); assert.equal(d.api.preview(d.pick, 'p:abcd1234').existed, false); // 换个范围就是没授权过
  d.api.setTier(one.id, 'read');
  assert.throws(() => d.api.write(one.id, 'a.txt', Buffer.from('x')), (e) => e.code === 'READ_ONLY'); assert.equal(d.api.write(two.id, 'a.txt', Buffer.from('b')).size, 1);
  d.api.remove(one.id); assert.deepEqual(d.api.list().map((l) => l.scope), [CB]);
  assert.equal(d.api.add(d.pick, { scope: '../x' }).scope, ''); // 不像样的范围不认
});

test('服务器：删对话时把它名下的副本一起删，项目里的对话不删项目的副本；删项目时删项目的', async (t) => {
  const h = fixture(t), ID2 = 'b2c3d4e5f6071829', dir = (id) => path.join(h.workspace, 'linked', id);
  const put = (id) => h.route('/api/linked?id=' + id + '&path=a.md', 'PUT', Buffer.from('内容'));
  const chat = async (body) => { const r = await h.route('/api/chat', 'POST', { message: '看看', model: 'sonnet', effort: 'high', ...body }); assert.equal(r.status, 200); const p = h.calls.filter((c) => c.kind === 'claude').at(-1).child; p.stdout.write(JSON.stringify({ type: 'result', session_id: 's', result: '好', is_error: false }) + '\n'); p.exitCode = 0; p.emit('close', 0); await new Promise((r2) => setTimeout(r2, 300)); return r.body.conversationId; };
  await put(ID); await put(ID2);
  const proj = (await h.route('/api/projects', 'POST', { name: '项目', linked: [{ id: ID2, name: '项目的文件夹' }] })).body;
  const plainConv = await chat({ linked: [{ id: ID, name: '对话的文件夹' }] }), inProject = await chat({ projectId: proj.id, linked: [{ id: ID2, name: '项目的文件夹' }] });
  assert.equal((await h.route('/api/conversations/' + inProject, 'DELETE')).status, 200); await new Promise((r) => setTimeout(r, 150));
  assert.ok(fs.existsSync(dir(ID2))); assert.ok(fs.existsSync(dir(ID)));                 // 项目里的对话删了，项目的副本还在
  assert.equal((await h.route('/api/conversations/' + plainConv, 'DELETE')).status, 200); await new Promise((r) => setTimeout(r, 150));
  assert.ok(!fs.existsSync(dir(ID))); assert.ok(fs.existsSync(dir(ID2)));                // 普通对话删了，它的副本跟着删
  assert.ok(fs.existsSync(path.join(h.root, 'data', 'users', 'alice', 'linked-history', ID, 'index.json'))); // 版本历史是备份，留着
  assert.equal((await h.route('/api/projects/' + proj.id, 'DELETE')).status, 200); await new Promise((r) => setTimeout(r, 150));
  assert.ok(!fs.existsSync(dir(ID2)));
});

// ---------- 大文件分块传到副本 ----------
test('服务器：关联文件夹的大文件分块上传——放到指定位置、覆盖旧的、回大小和时间；路径不对、太大的拒绝', async (t) => {
  const h = fixture(t), crypto = require('node:crypto');
  const start = (body) => h.route('/api/upload-start', 'POST', body);
  const part = (id, offset, bytes) => h.route('/api/upload-part?id=' + id + '&offset=' + offset, 'PUT', bytes);
  const data = crypto.randomBytes(9 * 1024 * 1024), rel = '答辩/最终版.pptx', abs = path.join(h.workspace, 'linked', ID, '答辩', '最终版.pptx');
  let r = await start({ linked: { id: ID, path: rel }, name: 'file', size: data.length });
  assert.equal(r.status, 200); const id = r.body.id;
  r = await part(id, 0, data.subarray(0, 4 * 1024 * 1024)); assert.deepEqual(r.body, { received: 4 * 1024 * 1024 });
  assert.ok(!fs.existsSync(abs)); // 没传完之前副本里没有半个文件
  r = await part(id, 0, data.subarray(0, 100)); assert.equal(r.status, 409); assert.equal(r.body.received, 4 * 1024 * 1024); // 位置对不上：告诉网页从哪接着发
  r = await part(id, 4 * 1024 * 1024, data.subarray(4 * 1024 * 1024, 8 * 1024 * 1024));
  r = await part(id, 8 * 1024 * 1024, data.subarray(8 * 1024 * 1024));
  assert.equal(r.status, 200); assert.equal(r.body.done, true); assert.equal(r.body.linked, true); assert.equal(r.body.size, data.length); assert.ok(r.body.mtime > 0);
  assert.equal(Buffer.compare(fs.readFileSync(abs), data), 0);
  const listed = (await h.route('/api/linked?id=' + ID)).body.files.find((x) => x.path === rel);
  assert.equal(listed.size, data.length); assert.equal(listed.mtime, r.body.mtime); // 回的时间和列出来的一致，网页才能据此记进度
  assert.deepEqual((await part(id, 0, Buffer.alloc(1))).body, r.body); // 最后一块的回应丢了：再问一次拿到同一个结果
  // 同名再传一次：覆盖，不会变成「最终版 (1).pptx」
  const again = Buffer.from('第二版');
  const id2 = (await start({ linked: { id: ID, path: rel }, size: again.length })).body.id;
  assert.equal((await part(id2, 0, again)).body.done, true);
  assert.equal(fs.readFileSync(abs, 'utf8'), '第二版'); assert.deepEqual(fs.readdirSync(path.dirname(abs)), ['最终版.pptx']);
  // 拒绝的情况
  for (const bad of [{ id: ID, path: '../../escape.txt' }, { id: ID, path: '.relay/x.json' }, { id: ID, path: '' }, { id: 'nope', path: 'a.txt' }, { id: ID }]) assert.equal((await start({ linked: bad, size: 3 })).status, 400, JSON.stringify(bad));
  assert.equal((await start({ linked: { id: ID, path: 'big.bin' }, size: 501 * 1024 * 1024 })).status, 413);
  assert.equal((await start({ linked: { id: ID, path: 'big.bin' }, size: 400 * 1024 * 1024 })).status, 200); // 单个文件放宽到 500MB
  assert.ok(!fs.existsSync(path.join(h.workspace, 'escape.txt')));
  // 普通附件的分块上传不受影响：还是进对话的 uploads、同名不覆盖
  const plainId = (await start({ name: 'a.txt', size: 2 })).body.id;
  const done = (await part(plainId, 0, Buffer.from('hi'))).body;
  assert.equal(done.path, 'uploads/a.txt'); assert.equal(done.linked, undefined);
});

test('网页：大文件分块传、传完一个记一个、显示百分比；一个失败不再让其余的白传', () => {
  const a = page.indexOf('async function lfPush(link, st, ups, base = null) {'), body = page.slice(a, page.indexOf('\n// 按需的文件夹放在副本里的那份清单', a));
  assert.ok(a > 0);
  assert.ok(body.includes('if (f.bytes.length > CHUNK) {')); assert.ok(body.includes('sendInChunks(new Blob([f.bytes]), { linked: { id: link.id, path: u.path } }'));
  assert.ok(body.includes('if (r && r.mtime) st.files[rel] = [mine.size, mine.mtime, r.size, r.mtime]; else sent.set(rel, mine);')); // 服务器回了时间就当场记下
  assert.ok(body.includes('if (++unsaved >= 25 || Date.now() - saved >= 3000) {')); // 至少每 3 秒或每 25 个文件存一次盘
  assert.ok(body.includes('const puts = ups.filter((u) => u.kind === \'put\')') && body.includes('back = await lfSlot();')); // 拿到全局的上传名额才传
  assert.ok(body.includes("'（大文件 ' + Math.round(100 * Math.min(...big)) + '%）'"));
  assert.ok(body.includes('while (next < puts.length && !failure) {')); // 有一个失败，别的不再开始新文件
  assert.match(body, /\} finally \{[\s\S]*await lfSaveState\(link, st\);/); // 成没成都把已经传好的记下来（存它自己手里那份记录）
  assert.ok(page.includes("fetch(`/api/upload-part?id=${id}&offset=${received}`")); // 用的是附件上传那套能续传的分块
});

test('网页：等同步时回复处写进度；项目页的文件夹一栏显示实时状态；出错能重试；项目卡片写着文件夹数', () => {
  assert.ok(page.includes("${(typeof lfWaitText === 'function' && lfWaitText(msg)) || (items.length ? '继续思考…' : '思考中…')}</span>${typeof lfWaitBar === 'function' ? lfWaitBar(msg) : ''}"));
  assert.ok(page.includes("return '先同步「' + link.name + '」';"));
  assert.match(page, /const wait = reply\?\.role === 'assistant' \? \{ index, id: null \} : null;\s*if \(wait\) LF\.waits\.set\(reply, wait\);[\s\S]{0,1200}\} finally \{\s*if \(wait\) \{ LF\.waits\.delete\(reply\);/);
  assert.ok(page.includes('function lfRefreshProjectBox() {')); assert.match(page, /bar\.classList\.toggle\('hidden', !html\);\s*lfRefreshProjectBox\(\);/);
  assert.ok(page.includes("if (e.target.closest('[data-review]')) return lfReview(id);"));
  assert.ok(page.includes('<button class="fb-act quiet" data-a="sync"')); assert.ok(page.includes("else if (a === 'sync') lfRun(link).catch(() => {});"));
  assert.ok(page.includes("${(p.linked || []).length ? ' · ' + p.linked.length + ' 个文件夹' : ''}"));
  // 账号是授权时记的（lfAdopt，在任何上传之前），同步完不再改记成「现在登录的账号」
  assert.ok(page.includes('const st = await lfLoadState(link);\n  st.user = authState.user;'));
  assert.ok(!page.includes('st.user = authState.user; st.at = Date.now();'));
});

// ---------- 版本历史 ----------
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function historyOf(h, rel, want) { // 版本是在后台记的：等到条数对上
  let body;
  for (let i = 0; i < 80; i++) { body = (await h.route('/api/linked/history?id=' + ID + (rel ? '&path=' + encodeURIComponent(rel) : ''))).body; if (want === undefined || (rel ? body.versions.length : body.files.length) >= want) break; await nap(25); }
  return body;
}
const putCopy = (h, rel, text) => h.route('/api/linked?id=' + ID + '&path=' + encodeURIComponent(rel), 'PUT', Buffer.from(text));

test('版本历史：用户传上来的每一版都存下来，内容一样不重复记；存在工作文件夹外面', async (t) => {
  const h = fixture(t), rel = '第一章.md';
  await putCopy(h, rel, '第一稿'); await historyOf(h, rel, 1);
  await putCopy(h, rel, '第二稿'); await historyOf(h, rel, 2);
  await putCopy(h, rel, '第二稿'); await nap(120); // 一模一样的内容
  const one = await historyOf(h, rel, 2);
  assert.deepEqual(one.versions.map((x) => [x.v, x.by, x.size, x.current]), [[2, 'user', 9, true], [1, 'user', 9, false]]);
  const all = await historyOf(h, '', 1);
  assert.equal(all.enabled, true); assert.equal(all.files.length, 1); assert.equal(all.files[0].path, rel); assert.equal(all.files[0].count, 2); assert.equal(all.bytes, 18);
  assert.equal(all.limits.perFile, 200); assert.equal(all.limits.days, 1095); assert.equal(all.limits.folderBytes, 200 * 1024 ** 3);
  assert.equal(h.evaluate('HISTORY_DEFAULTS.totalBytes'), 800 * 1024 ** 3); // 一个账号合计的历史最多占 800GB
  const store = path.join(h.root, 'data', 'users', 'alice', 'linked-history', ID);
  assert.ok(fs.existsSync(path.join(store, 'index.json'))); assert.equal(fs.readdirSync(path.join(store, 'objects')).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(store, 'tmp')), []); // 收文件用的临时文件没有留下
  assert.ok(!fs.existsSync(path.join(h.workspace, 'linked-history'))); assert.ok(!path.resolve(store).startsWith(path.resolve(h.workspace) + path.sep));
  // 取某一版的内容
  const v1 = await h.route('/api/linked/version?id=' + ID + '&path=' + encodeURIComponent(rel) + '&v=1');
  assert.equal(Buffer.concat(v1.chunks).toString('utf8'), '第一稿'); assert.match(v1.headers['Content-Disposition'], /^attachment;/);
  assert.equal((await h.route('/api/linked/version?id=' + ID + '&path=' + encodeURIComponent(rel) + '&v=9')).status, 404);
  for (const bad of ['/api/linked/history?id=nope', '/api/linked/history?id=' + ID + '&path=' + encodeURIComponent('../x'), '/api/linked/version?id=' + ID + '&path=&v=1', '/api/linked/version?id=' + ID + '&path=' + encodeURIComponent('.relay/x') + '&v=1']) assert.equal((await h.route(bad)).status, 400, bad);
});

test('版本历史：大文件分块传上来的也记；用户删掉的记一条「删掉了」', async (t) => {
  const h = fixture(t), rel = '答辩/最终版.pptx', data = require('node:crypto').randomBytes(5 * 1024 * 1024);
  const id = (await h.route('/api/upload-start', 'POST', { linked: { id: ID, path: rel }, size: data.length })).body.id;
  await h.route('/api/upload-part?id=' + id + '&offset=0', 'PUT', data.subarray(0, 4 * 1024 * 1024));
  assert.equal((await h.route('/api/upload-part?id=' + id + '&offset=' + 4 * 1024 * 1024, 'PUT', data.subarray(4 * 1024 * 1024))).body.done, true);
  const one = await historyOf(h, rel, 1);
  assert.deepEqual(one.versions.map((x) => [x.by, x.size]), [['user', data.length]]);
  const got = await h.route('/api/linked/version?id=' + ID + '&path=' + encodeURIComponent(rel) + '&v=1');
  assert.equal(Buffer.compare(Buffer.concat(got.chunks), data), 0);
  await h.route('/api/linked/remove', 'POST', { id: ID, paths: [rel] });
  const after = await historyOf(h, rel, 2);
  assert.deepEqual(after.versions.map((x) => [x.v, x.by, !!x.deleted, x.current]), [[2, 'user', true, true], [1, 'user', false, false]]);
  assert.equal((await h.route('/api/linked/version?id=' + ID + '&path=' + encodeURIComponent(rel) + '&v=2')).status, 404); // 「删掉了」没有内容可取
});

test('版本历史：模型一轮里改的、删的各记一版，写着是哪家模型；恢复旧版写回副本并再记一版', async (t) => {
  const h = fixture(t);
  await putCopy(h, 'a.md', '用户的原文'); await putCopy(h, 'b.md', '要被删的'); await historyOf(h, '', 2);
  const r = await h.route('/api/chat', 'POST', { message: '改一下 a.md，删掉 b.md', model: 'sonnet', effort: 'high', linked: [{ id: ID, name: '论文' }] });
  assert.equal(r.status, 200);
  const child = h.calls.filter((c) => c.kind === 'claude').at(-1).child;
  h.io.writeTextSync(h.ctx, 'linked/' + ID + '/a.md', '模型改过的内容', { parents: true });
  h.io.removeSync(h.ctx, 'linked/' + ID + '/b.md', { force: true });
  child.stdout.write(JSON.stringify({ type: 'result', session_id: 'synthetic', result: '好了', is_error: false }) + '\n'); child.exitCode = 0; child.emit('close', 0);
  const a = await historyOf(h, 'a.md', 2), b = await historyOf(h, 'b.md', 2);
  assert.deepEqual(a.versions.map((x) => [x.v, x.by, x.model || '', x.current]), [[2, 'model', 'sonnet', true], [1, 'user', '', false]]);
  assert.deepEqual(b.versions.map((x) => [x.by, !!x.deleted]), [['model', true], ['user', false]]);
  // 恢复 a.md 的第 1 版、把 b.md 找回来
  assert.deepEqual((await h.route('/api/linked/restore', 'POST', { id: ID, path: 'a.md', v: 1 })).body, { ok: true, size: Buffer.byteLength('用户的原文') });
  assert.equal(fs.readFileSync(path.join(h.workspace, 'linked', ID, 'a.md'), 'utf8'), '用户的原文');
  assert.equal((await h.route('/api/linked/restore', 'POST', { id: ID, path: 'b.md', v: 1 })).status, 200);
  assert.equal(fs.readFileSync(path.join(h.workspace, 'linked', ID, 'b.md'), 'utf8'), '要被删的');
  const a2 = await historyOf(h, 'a.md', 3);
  assert.deepEqual(a2.versions.map((x) => [x.v, x.by, x.from || 0]), [[3, 'restore', 1], [2, 'model', 0], [1, 'user', 0]]); // 模型那一版还在，可以再换回去
  assert.equal((await h.route('/api/linked/restore', 'POST', { id: ID, path: 'a.md', v: 99 })).status, 404);
  assert.equal((await h.route('/api/linked/restore', 'POST', { id: ID, path: 'b.md', v: 2 })).status, 404); // 不能「恢复」成删掉了
  assert.equal((await h.route('/api/linked/restore', 'POST', { id: ID, path: '../../x', v: 1 })).status, 400);
});

test('版本历史：每个文件只留最近几版，清掉的内容文件一起删；超过总量先清最旧的；可以整个关掉', async (t) => {
  const h = fixture(t, { config: { linkedHistory: { perFile: 3 } } }), store = path.join(h.root, 'data', 'users', 'alice', 'linked-history', ID);
  for (let i = 1; i <= 5; i++) { await putCopy(h, 'a.md', '第 ' + i + ' 稿'); await historyOf(h, 'a.md', Math.min(i, 3)); await nap(20); }
  const kept = await historyOf(h, 'a.md', 3);
  assert.deepEqual(kept.versions.map((x) => x.v), [5, 4, 3]); assert.equal(fs.readdirSync(path.join(store, 'objects')).length, 3);
  // 总量上限：两个文件各两版，上限只够放三份 → 最旧的那一版被清，每个文件现在的一版都还在
  const tight = fixture(t, { config: { linkedHistory: { folderBytes: 35 } } });
  for (const [rel, text] of [['x.md', '0123456789'], ['y.md', 'abcdefghij'], ['x.md', 'ABCDEFGHIJ'], ['y.md', '9876543210']]) { await putCopy(tight, rel, text); await nap(40); }
  await nap(150);
  const x = await historyOf(tight, 'x.md'), y = await historyOf(tight, 'y.md');
  assert.deepEqual(x.versions.map((v) => v.v), [2]); assert.deepEqual(y.versions.map((v) => v.v), [2, 1]);
  assert.ok((await historyOf(tight, '')).bytes <= 35);
  // 关掉：照常同步，但什么都不记
  const off = fixture(t, { config: { linkedHistory: false } });
  assert.equal((await putCopy(off, 'a.md', '内容')).status, 200); await nap(120);
  assert.deepEqual(await historyOf(off, ''), { enabled: false, files: [], bytes: 0, limits: null });
  assert.equal(fs.readFileSync(path.join(off.workspace, 'linked', ID, 'a.md'), 'utf8'), '内容');
});

test('网页：文件夹面板、别的设备上的文件夹名字、项目页那一行都能打开历史版本', () => {
  assert.ok(page.includes('async function lfHistory(id, name) {'));
  assert.ok(page.includes('<button class="btn" data-do="history">历史版本</button>')); assert.ok(page.includes("else if (act === 'history') lfHistory(link.id, link.name);"));
  assert.ok(page.includes("if (a === 'history') return lfHistory(hit.dataset.id, hit.dataset.name);"));
  assert.ok(page.includes("if (!link) return lfHistory(id, row.querySelector('.nm').textContent);"));
  assert.ok(page.includes("await post('/api/linked/restore', { id, path: rel, v });")); assert.ok(page.includes('if (link && !link.missing) lfRun(link).catch(() => {});'));
  assert.ok(page.includes("'/api/linked/version?id=' + id + '&path=' + encodeURIComponent(rel) + '&v=' + v"));
});

// ---------- 大文件：分段读、分段写、用指纹比较 ----------
test('桌面端：上限是 5000 个文件、5GB、单个 500MB；大文件能分段读、算指纹', (t) => {
  assert.deepEqual([folders.LIMITS.files, folders.LIMITS.bytes, folders.LIMITS.file], [5000, 5 * 1024 ** 3, 500 * 1024 ** 2]);
  const data = require('node:crypto').randomBytes(3 * 1024 * 1024 + 123), d = desk(t);
  fs.writeFileSync(path.join(d.pick, '大.bin'), data);
  const link = d.api.add(d.pick), st = d.api.stat(link.id, '大.bin');
  assert.equal(st.size, data.length); assert.equal(d.api.stat(link.id, '没有.bin'), null);
  const parts = []; let at = 0;
  for (;;) { const p = d.api.readChunk(link.id, '大.bin', at, 1024 * 1024); assert.deepEqual([p.size, p.mtime], [st.size, st.mtime]); if (!p.bytes.length) break; parts.push(p.bytes); at += p.bytes.length; }
  assert.equal(parts.length, 4); assert.equal(Buffer.compare(Buffer.concat(parts), data), 0);
  assert.equal(d.api.hash(link.id, '大.bin').sha, require('node:crypto').createHash('sha256').update(data).digest('hex'));
  for (const [off, len] of [[-1, 10], [0, 0], [0, folders.CHUNK_MAX + 1], [1.5, 10]]) assert.throws(() => d.api.readChunk(link.id, '大.bin', off, len), (e) => e.code === 'BAD_RANGE');
  for (const fn of ['stat', 'hash']) assert.throws(() => d.api[fn](link.id, '../x'), (e) => e.code === 'BAD_PATH');
  assert.throws(() => d.api.readChunk(link.id, '../x', 0, 10), (e) => e.code === 'BAD_PATH');
  assert.throws(() => d.api.readChunk(link.id, 'a.exe', 0, 10), (e) => e.code === 'BLOCKED_TYPE');
});

test('桌面端：分段写回——收齐核对过才换进用户的文件夹，先备份；用户刚改过、没收全、只读、程序类都不写；中途放弃不留痕迹', async (t) => {
  const d = desk(t, { files: { 'a.bin': '原来的内容' } });
  const link = d.api.add(d.pick), before = d.api.stat(link.id, 'a.bin'), data = Buffer.from('模型改好的很长的内容'.repeat(1000));
  const tmpDir = path.join(d.data, 'tmp'), left = () => (fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []);
  const s1 = d.api.writeStart(link.id, 'a.bin', { size: data.length, expect: before });
  assert.match(s1.token, /^[a-f0-9]{16}$/);
  d.api.writeChunk(s1.token, data.subarray(0, 5000));
  assert.equal(d.text('a.bin'), '原来的内容'); assert.deepEqual(fs.readdirSync(d.pick), ['a.bin']); // 没收齐之前用户的文件夹里什么都没变
  assert.deepEqual(d.api.writeChunk(s1.token, data.subarray(5000)), { received: data.length });
  const done = d.api.writeEnd(s1.token);
  assert.equal(done.size, data.length); assert.equal(Buffer.compare(fs.readFileSync(path.join(d.pick, 'a.bin')), data), 0);
  assert.equal(fs.readFileSync(path.join(d.data, 'backups', link.id, done.batch, 'files', 'a.bin'), 'utf8'), '原来的内容');
  assert.deepEqual(left(), []); assert.deepEqual(fs.readdirSync(d.pick), ['a.bin']);
  assert.throws(() => d.api.writeChunk(s1.token, Buffer.from('x')), (e) => e.code === 'NO_WRITE'); // 用过的凭据作废
  // 新建到子文件夹里，撤销时文件和空文件夹一起收走
  const s2 = d.api.writeStart(link.id, '新的/b.bin', { size: 3, expect: null, batch: done.batch });
  d.api.writeChunk(s2.token, Buffer.from('abc')); assert.equal(d.api.writeEnd(s2.token).batch, done.batch);
  assert.equal(d.text('新的/b.bin'), 'abc');
  const undone = await d.api.undo(link.id, done.batch);
  assert.deepEqual(undone.restored.sort(), ['a.bin', '新的/b.bin']); assert.equal(d.text('a.bin'), '原来的内容'); assert.ok(!fs.existsSync(path.join(d.pick, '新的')));
  // 开始时就对不上；开始后用户又改了（结束时再核对一次）
  assert.equal(d.api.writeStart(link.id, 'a.bin', { size: 1, expect: { size: 1, mtime: 1 } }).conflict, true);
  const s3 = d.api.writeStart(link.id, 'a.bin', { size: 2, expect: d.api.stat(link.id, 'a.bin') });
  d.api.writeChunk(s3.token, Buffer.from('zz')); fs.writeFileSync(path.join(d.pick, 'a.bin'), '用户在这中间自己改了一大段');
  assert.equal(d.api.writeEnd(s3.token).conflict, true); assert.equal(d.text('a.bin'), '用户在这中间自己改了一大段');
  // 没收全、多给了
  const s4 = d.api.writeStart(link.id, 'c.bin', { size: 10, expect: null }); d.api.writeChunk(s4.token, Buffer.from('12345'));
  assert.throws(() => d.api.writeEnd(s4.token), (e) => e.code === 'BAD_DATA'); assert.ok(!fs.existsSync(path.join(d.pick, 'c.bin')));
  const s5 = d.api.writeStart(link.id, 'c.bin', { size: 2, expect: null });
  assert.throws(() => d.api.writeChunk(s5.token, Buffer.from('123')), (e) => e.code === 'BAD_DATA');
  // 中途放弃
  const s6 = d.api.writeStart(link.id, 'c.bin', { size: 5, expect: null }); d.api.writeChunk(s6.token, Buffer.from('12'));
  assert.equal(left().length, 1); assert.equal(d.api.writeAbort(s6.token), true); assert.deepEqual(left(), []);
  // 不该写的
  assert.throws(() => d.api.writeStart(link.id, 'run.exe', { size: 1 }), (e) => e.code === 'BLOCKED_TYPE');
  assert.throws(() => d.api.writeStart(link.id, '../out.bin', { size: 1 }), (e) => e.code === 'BAD_PATH');
  assert.throws(() => d.api.writeStart(link.id, 'c.bin', { size: folders.LIMITS.file + 1 }), (e) => e.code === 'TOO_BIG');
  d.api.setTier(link.id, 'read');
  assert.throws(() => d.api.writeStart(link.id, 'c.bin', { size: 1 }), (e) => e.code === 'READ_ONLY');
  assert.deepEqual(fs.readdirSync(d.pick), ['a.bin']); assert.deepEqual(left(), []);
  // 应用被关掉时没写完的：下次启动清掉
  fs.mkdirSync(tmpDir, { recursive: true }); fs.writeFileSync(path.join(tmpDir, 'deadbeefdeadbeef'), '半个文件'); d.api.prune(); assert.deepEqual(left(), []);
});

test('服务器和网页：单个文件 500MB；版本列表带指纹；网页大文件分段读、分段写、比指纹，旧版桌面端照旧能用', async (t) => {
  const h = fixture(t);
  await h.route('/api/linked?id=' + ID + '&path=a.md', 'PUT', Buffer.from('内容'));
  let v; for (let i = 0; i < 80 && !(v = (await h.route('/api/linked/history?id=' + ID + '&path=a.md')).body.versions[0]); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(v.sha, require('node:crypto').createHash('sha256').update('内容').digest('hex'));
  assert.equal(h.evaluate('LINKED_FILE_LIMIT'), 500 * 1024 * 1024); assert.equal(h.evaluate('LINKED_MAX_FILES'), 6000);
  assert.ok(page.includes('const LF_FILE_MAX = 500 * 1048576, LF_BIG = 32 * 1048576;'));
  assert.ok(page.includes('if (u.local && u.local.size > CHUNK && LF.api.readChunk) {')); // 没有分段读的旧版桌面端走整份读的老路
  assert.ok(page.includes("const part = await LF.api.readChunk(link.id, rel, received, CHUNK);"));
  assert.ok(page.includes("if (part.size !== first.size || part.mtime !== first.mtime) throw new Error("));
  assert.ok(page.includes('r = c.server.size > LF_BIG && LF.api.writeStart ? await lfWriteBig(link, c, batch, expect, report) :'));
  assert.ok(page.includes("} catch (e) { await LF.api.writeAbort(start.token).catch(() => {}); throw e; }"));
  assert.ok(page.includes('if (!now || now.deleted || now.sha !== mine.sha) return false;'));
  assert.ok(page.includes("if (Math.max(c.local?.size || 0, c.server?.size || 0) > 400 * 1024) {"));
});

// ---------- 模型按需请求访问用户电脑上的位置 ----------
test('桌面端：请求访问前先看一眼那个位置——给的是文件就取所在文件夹，系统目录和太宽的照样拒绝', (t) => {
  const d = desk(t, { files: { 'a.txt': 'a', 'sub/b.txt': 'b' } });
  const v = d.api.preview(path.join(d.pick, 'sub', 'b.txt'));
  assert.equal(v.root, path.join(d.pick, 'sub')); assert.equal(v.name, 'sub'); assert.equal(v.count, 1); assert.equal(v.existed, false);
  assert.equal(d.api.list().length, 0); // 只是看，不会关联
  const link = d.api.add(d.pick), again = d.api.preview(d.pick);
  assert.equal(again.existed, true); assert.equal(again.id, link.id); assert.equal(again.count, 2);
  for (const [bad, code] of [[d.home, 'TOO_WIDE'], [path.parse(d.base).root, 'TOO_WIDE'], [d.data, 'SYSTEM'], ['relative/x', 'BAD_ROOT'], [path.join(d.pick, '没有这个'), 'BAD_ROOT'], [42, 'BAD_ROOT']]) assert.throws(() => d.api.preview(bad), (e) => e.code === code, String(bad));
});

test('服务器：用户在桌面端里时告诉模型可以请求访问；回答末尾的请求取出来放在回复上，正文里去掉', (t) => {
  const h = fixture(t);
  const prompt = (can) => h.evaluate(`buildPrompt(USERS.get('alice'), { id: 'c0ffee00c0ffee00', mode: 'work' }, '把这个文件放到我桌面', [], null, null, undefined, ${can})`);
  assert.ok(prompt(true).includes('<<请求访问：桌面>>')); assert.match(prompt(true), /不要说做不到/); assert.match(prompt(true), /然后就此停下/);
  for (const off of [false, undefined, '"yes"']) assert.ok(!prompt(off).includes('请求访问'), String(off));
  const take = (text) => JSON.parse(h.evaluate(`JSON.stringify(takeAccessRequest(${JSON.stringify(text)}))`));
  assert.deepEqual(take('我需要把副本放到你的桌面。\n\n<<请求访问：桌面>>'), { text: '我需要把副本放到你的桌面。', where: '桌面' });
  assert.deepEqual(take('要读这个文件夹。\n<<请求访问: D:\\资料\\论文 >>\n'), { text: '要读这个文件夹。', where: 'D:\\资料\\论文' });
  assert.equal(take('普通的回答，没有请求。'), null); assert.equal(take('<<请求访问：>>'), null);
  h.context.sample = { mode: 'work', messages: [{ role: 'user', text: '<<请求访问：桌面>>' }, { role: 'assistant', status: 'done', events: [{ k: 'text', text: '先说明一下。\n<<请求访问：下载>>' }] },
    { role: 'assistant', status: 'running', events: [{ k: 'text', text: '还在写 <<请求访问：文档>>' }] }] };
  const out = JSON.parse(h.evaluate(`JSON.stringify(withFileUrls(USERS.get('alice'), sample))`));
  assert.equal(out.messages[0].text, '<<请求访问：桌面>>'); assert.equal(out.messages[0].accessRequest, undefined); // 用户自己打的不算
  assert.equal(out.messages[1].accessRequest, '下载'); assert.equal(out.messages[1].events[0].text, '先说明一下。');
  assert.equal(out.messages[2].accessRequest, undefined); // 还没答完的不取
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(source.includes('if (body.canTrust === true) userMsg.canTrust = true;'));
});

test('网页：回复下面的「允许」按钮只在桌面端出现，点了经桌面端确认后关联、同步，再让模型接着做', () => {
  assert.ok(page.includes("if (!running && msg.accessRequest && !msg.accessGranted && typeof lfGrant === 'function' && LF.api?.trust && chatModeNow() === 'work') {")); // 聊天的对话里不给
  assert.ok(page.includes('if (LF.api?.trust) body.canTrust = true;'));
  assert.ok(page.indexOf('if (LF.api?.trust) body.canTrust = true;') < page.indexOf('const links = lfCurrentAll(); if (!links.length) return;\n  body.linked')); // 没关联任何文件夹时也要告诉服务器
  assert.ok(page.includes('const scope = lfScope(true), r = await LF.api.trust(LF_PLACES[key] || where, mode, scope);'));
  assert.ok(page.includes("if (!r || lfOldDesktop(r, scope)) { if (button) button.disabled = false; return; }"));
  assert.match(page, /await lfAdopt\(link, r\); await lfIdle\(link\);[\s\S]{0,260}send\(\{ text: '已经允许你用我电脑上的「' \+ link\.name/);
  assert.ok(page.includes("if (S.conv && S.conv.id === convId && !S.running.has(convId)) send(")); // 传得久，用户去了别的对话：不在别的对话里替用户说话
  assert.match(page, /const LF_PLACES = \{ 桌面: 'desktop', 文档: 'documents'/);
});

// ---------- 按需取文件：整个文件夹都认，但要哪个传哪个 ----------
test('服务器：按需的文件夹在提示里说明去看清单、怎么要文件；回答末尾要的文件取出来放在回复上', (t) => {
  const h = fixture(t);
  const prompt = (linked) => h.evaluate(`buildPrompt(USERS.get('alice'), { id: 'c0ffee00c0ffee00', mode: 'work' }, '看看桌面上的报告', [], null, null, ${JSON.stringify(linked)}, true)`);
  const lazy = prompt([{ id: ID, name: 'Desktop', lazy: true }]);
  assert.ok(lazy.includes('「Desktop」是按需取文件的')); assert.ok(lazy.includes('_还没取来的文件清单.md')); assert.ok(lazy.includes('<<需要文件：linked/编号/相对路径>>'));
  assert.ok(!prompt([{ id: ID, name: '论文' }]).includes('按需取文件'));
  assert.deepEqual(JSON.parse(h.evaluate(`JSON.stringify(linkedList([{ id: '${ID}', name: 'Desktop', lazy: true }, { id: 'b2c3d4e5f6071829', name: '论文', lazy: 'yes' }]))`)), [{ id: ID, name: 'Desktop', lazy: true }, { id: 'b2c3d4e5f6071829', name: '论文' }]);
  const take = (text) => JSON.parse(h.evaluate(`JSON.stringify(takeFileRequests(${JSON.stringify(text)}))`));
  assert.deepEqual(take('我先看一下这两个文件。\n<<需要文件：linked/' + ID + '/报告.docx>>\n<<需要文件: linked/' + ID + '/数据/表 1.xlsx >>'), { text: '我先看一下这两个文件。', files: ['linked/' + ID + '/报告.docx', 'linked/' + ID + '/数据/表 1.xlsx'] });
  assert.equal(take('没有要文件。'), null);
  h.context.sample = { mode: 'work', messages: [{ role: 'assistant', status: 'done', events: [{ k: 'text', text: '需要它。\n<<需要文件：linked/' + ID + '/a.md>>' }] }] };
  const out = JSON.parse(h.evaluate(`JSON.stringify(withFileUrls(USERS.get('alice'), sample))`));
  assert.deepEqual(out.messages[0].fileRequests, ['linked/' + ID + '/a.md']); assert.equal(out.messages[0].events[0].text, '需要它。');
});

test('网页：按需的文件夹只传要过的和已取来的，其余进清单；模型要文件时自动取来再让它继续', () => {
  assert.ok(page.includes("const LF_INDEX = '_还没取来的文件清单.md';"));
  assert.ok(page.includes('const want = st.lazy ? st.want || [] : [], tracked = (k) => !st.lazy || !!st.files[k] || lfWants(want, k);'));
  assert.ok(page.includes('let L = st.lazy ? new Map([...all].filter(([k]) => tracked(k))) : all;'));
  assert.ok(page.includes('sv.map.delete(LF_INDEX);')); // 清单不算文件夹里的文件，不会被写回用户的电脑
  assert.ok(page.includes('if (st.lazy) L = new Map([...all].filter(([k]) => tracked(k) || sv.map.has(k)));'));
  assert.ok(page.includes("if (!st.lazy || st.files[m[2]] || lfWants(st.want || [], m[2])) continue;"));
  assert.ok(page.includes('lfRun(link).catch(() => {}).then(() => lfFetchRequested(convId)).catch(() => {});'));
  assert.match(page, /if \(r\.tooMany \|\| st\.lazy\) \{[\s\S]{0,200}st\.lazy = true;/); // 模型请求访问时信任的位置：超上限的才按需，其余整个同步
  // 清单的内容：只列还没取来的
  const a = page.indexOf("const LF_INDEX = '_还没取来的文件清单.md';"), b = page.indexOf('// 模型在回答末尾要了文件', a);
  const c = vm.createContext({}); vm.runInContext('const fmtSize = (n) => n + ' + "' B'" + ';\nconst lfWants = (want, k) => want.some((w) => k === w || k.startsWith(String(w).replace(/\\/+$/, "") + "/"));\n' + page.slice(a, b) + '\nglobalThis.x = { lfIndexText };', c);
  const text = c.x.lfIndexText({ id: ID, name: 'Desktop' }, new Map([['a.md', { path: 'a.md', size: 3 }], ['已取/b.md', { path: '已取/b.md', size: 5 }], ['要了/c.md', { path: '要了/c.md', size: 7 }]]), { files: { '已取/b.md': [5, 1, 5, 1] }, want: ['要了/c.md'] });
  assert.ok(text.includes('- a.md（3 B）')); assert.ok(!text.includes('b.md')); assert.ok(!text.includes('c.md')); assert.ok(text.includes('<<需要文件：linked/' + ID + '/相对路径>>'));
});

// ---------- 对话的总权限；信任的位置不限大小 ----------
test('桌面端：信任一个位置时可以直接带上权限档位，里面东西再多也行；清单可以要完整的', (t) => {
  const d = desk(t);
  for (let i = 0; i <= folders.LIMITS.files; i++) fs.writeFileSync(path.join(d.pick, 'f' + String(i).padStart(5, '0') + '.txt'), '');
  assert.throws(() => d.api.add(d.pick), (e) => e.code === 'TOO_BIG'); // 用户自己选来整个同步的文件夹照旧有上限
  const link = d.api.add(d.pick, { anySize: true, tier: 'auto' });
  assert.equal(link.tier, 'auto'); assert.equal(d.api.list()[0].tier, 'auto');
  assert.equal(d.api.scan(link.id).tooMany, true);
  const all = d.api.scan(link.id, { all: true });
  assert.equal(all.tooMany, false); assert.equal(all.files.length, folders.LIMITS.files + 1);
  const other = desk(t, { files: { 'a.txt': 'a' } });
  assert.throws(() => other.api.add(other.pick, { tier: 'root' }), (e) => e.code === 'BAD_TIER'); assert.equal(other.api.list().length, 0);
  assert.equal(other.api.add(other.pick).tier, 'ask'); // 不带就还是「每次问我」
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
  assert.ok(main.includes("if (!folders.TIERS.includes(tier)) tier = 'ask';")); assert.ok(main.includes("facts: [['权限', TIER_TEXT[tier], TIER_DETAIL[tier]]]")); // 确认窗里写明用哪个档位
  assert.ok(!main.includes("请改成里面的一个文件夹"));
});

test('网页：权限在输入框底部，是这个对话的总权限；换档对所有文件夹生效，新信任和新选的文件夹直接用它', () => {
  assert.match(page, /<button class="tool-btn mode-btn hidden" id="modeBtn"/);
  const a = page.indexOf('function lfMode() {'), b = page.indexOf('// 一个文件夹刚授权给这个输入框', a);
  const store = {}, c = vm.createContext({});
  vm.runInContext('var links = []; const ls = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } }; var store = {}; const lfCurrentAll = () => links; const LF_TIERS = [["read"],["ask"],["auto"],["all"]];\n' +
    page.slice(a, page.indexOf('// 换总权限：', a)) + '\nglobalThis.m = { lfMode, set: (l, s) => { links = l; store = s; } };', c);
  c.m.set([], {}); assert.equal(c.m.lfMode(), 'ask');
  c.m.set([], { lfMode: 'auto' }); assert.equal(c.m.lfMode(), 'auto'); // 还没有文件夹：用用户上次选的
  c.m.set([], { lfMode: 'root' }); assert.equal(c.m.lfMode(), 'ask');
  c.m.set([{ tier: 'all' }, { tier: 'all' }], { lfMode: 'ask' }); assert.equal(c.m.lfMode(), 'all'); // 有文件夹：看它们实际的档位
  c.m.set([{ tier: 'all' }, { tier: 'read' }], {}); assert.equal(c.m.lfMode(), 'mixed');
  assert.ok(b > a);
  assert.ok(page.includes("for (const l of links) await LF.api.setTier(l.id, tier);"));
  assert.ok(page.includes("r = await LF.api.trust(LF_PLACES[key] || where, mode, scope);"));
  assert.ok(page.includes("if (mode !== 'mixed' && link.tier !== mode) { await LF.api.setTier(link.id, mode).catch(() => {}); await lfReload();"));
  assert.ok(page.includes("let local = await LF.api.scan(link.id);")); assert.ok(page.includes("local = await LF.api.scan(link.id, { all: true });")); // 先按上限扫，超了再要完整的清单
  assert.ok(page.includes("${mode === 'mixed' ? `<small>${esc(lfTierName(link.tier))}</small>` : ''}</button>`;")); // 档位都一样时不在每个文件夹名字后面重复写
});

test('网页：写回进行中有进度，正在自动写回的不算「等你确认」，确认面板里点了立刻有反应', () => {
  assert.ok(page.includes("lfAutoList(link).forEach((c) => { c.applying = true; });"));
  assert.ok(page.includes('const lfWaiting = (link) => (LF.pending.get(link.id) || []).filter((c) => !c.applying);'));
  assert.ok(page.includes("pend = lfWaiting(link).length, at = ")); assert.ok(page.includes("pend = lfWaiting(link).length, saved = LF.state.get(link.id), count"));
  assert.ok(page.includes("text: '正在写回 ' + Math.min(done.length + failed.length + 1, changes.length) + '/' + changes.length"));
  assert.ok(page.includes('LF.pending.set(link.id, (LF.pending.get(link.id) || []).filter((x) => x !== c));')); // 写完一个去掉一个
  assert.ok(page.includes("c.applying = false; c.failed = e.message || '没写回成功';")); // 没成的留给用户手动处理，不会一直显示成正在写回
  assert.ok(page.includes('const mark = (list) => { list.forEach((x) => { x.applying = true; }); draw(); lfRender(); return list; };'));
  assert.ok(page.includes('if (LF.reviewDraw) LF.reviewDraw();')); assert.ok(page.includes('<span class="lf-doing">正在处理…</span>'));
});

test('网页：关联文件夹这一段里用到的每个函数都有定义（防止改动时误删一整个函数）', () => {
  const a = page.indexOf('// ---------- 关联文件夹（只有桌面端有）'), b = page.indexOf('function sheet(html) {', a), part = page.slice(a, b);
  const defined = new Set([...part.matchAll(/^(?:async )?function (lf\w+)\(|^const (lf\w+) = /gm)].map((m) => m[1] || m[2]));
  const used = new Set([...part.matchAll(/(?<![\w.])(lf[A-Z]\w*)\(/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((n) => !defined.has(n)), []);
  for (const must of ['lfReview', 'lfHistory', 'lfPanel', 'lfGrant', 'lfSync', 'lfApply', 'lfFetchRequested']) assert.ok(defined.has(must), must);
});

// ---------- 网页（内存里跑）：授权后整个文件夹传过来、进度、每个文件夹一条队、中断后接着传 ----------
// 把页面里关联文件夹这一整段放进内存里跑。桌面端（用户的电脑）和服务器（副本）都是假的、在内存里；
// 刷新页面 = 再开一个页面实例，共用同一个桌面端和服务器。只用桌面端旧版（0.8.1）就有的接口：不给 readChunk、hash、writeStart。
// 服务器上每个账号一份工作区（副本按账号分开放）；一个请求属于发出那一刻登录着的账号，回来时已经换了账号就作废（和页面里的 fetch 包装一样）
const lfLine = (prefix) => { const i = page.indexOf(prefix); assert.ok(i >= 0, prefix); return page.slice(i, page.indexOf('\n', i)); };
const LF_SECTION = page.slice(page.indexOf('// ---------- 关联文件夹（只有桌面端有）'), page.indexOf('function sheet(html) {'));
const ACCOUNT = page.slice(page.indexOf('const staleAccount = '), page.indexOf('const scopedLinks = ')); // staleAccount、accountCurrent、checkAccount
assert.ok(ACCOUNT.includes('const accountCurrent = ') && ACCOUNT.includes('function checkAccount('));
const later = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('等不到'); await later(5); } };
const CONV = (id) => ({ convId: id, conv: { id, messages: [] }, convs: [{ id: CA }, { id: CB }] });

function lfWorld({ limit = 50, oldServer = false } = {}) {
  const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
  let clock = 1000, inflight = 0;
  const disks = new Map(), links = [], states = new Map(), trashed = [], scans = [], spaces = new Map(), projects = new Map();
  const calls = { put: [], putBy: [], list: 0, download: 0, remove: [], project: [] };
  const disk = (root) => { if (!disks.has(root)) disks.set(root, new Map()); return disks.get(root); };
  const space = (user) => { if (!spaces.has(user)) spaces.set(user, new Map()); return spaces.get(user); }; // 一个账号的工作区：授权编号 → 副本
  const copies = space('synthetic');
  const copy = (id, user = 'synthetic') => { const sp = space(user); if (!sp.has(id)) sp.set(id, new Map()); return sp.get(id); };
  const stale = () => Object.assign(new Error(''), { name: 'AbortError', staleAccount: true });
  const stamp = (f) => ({ size: f.bytes.length, mtime: f.mtime });
  const linkOf = (id) => { const l = links.find((x) => x.id === id); if (!l) throw Object.assign(new Error('这个文件夹已经不在关联列表里了'), { code: 'NO_LINK' }); return l; };
  const listOf = (root) => [...disk(root)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => ({ path: p, ...stamp(f) }));
  const view = (l) => ({ id: l.id, name: l.name, path: l.root, tier: l.tier, scope: l.scope, addedAt: l.addedAt, missing: false });
  const summary = (root) => { const files = listOf(root); return { count: Math.min(files.length, limit), bytes: files.reduce((s, f) => s + f.size, 0), skippedCount: 0, tooMany: files.length > limit }; };
  // 桌面端：上限是 limit 个文件（真的是 5000 个、5GB；这里调小，不用造几千个文件）
  const desk = {
    list: async () => links.map(view),
    getState: async (id) => { linkOf(id); return states.get(id) || ''; },
    setState: async (id, text) => { linkOf(id); states.set(id, text); return true; },
    scan: async (id, { all = false } = {}) => {
      const l = linkOf(id); scans.push({ id, all }); if (world.onScan) world.onScan(id, all);
      const files = listOf(l.root), tooMany = !all && files.length > limit;
      return { files: tooMany ? files.slice(0, limit) : files, bytes: 0, skipped: [], skippedCount: 0, tooMany };
    },
    read: async (id, rel) => { const f = disk(linkOf(id).root).get(rel); if (!f) throw new Error('读不到 ' + rel); return { bytes: f.bytes, ...stamp(f) }; },
    write: async (id, rel, bytes, { batch, expect } = {}) => {
      const l = linkOf(id), cur = disk(l.root).get(rel);
      if (l.tier === 'read') throw new Error('只读');
      if (expect !== undefined && (expect ? !cur || cur.bytes.length !== expect.size || cur.mtime !== expect.mtime : !!cur)) return { conflict: true };
      const f = { bytes: Uint8Array.from(bytes), mtime: ++clock }; disk(l.root).set(rel, f);
      return { ...stamp(f), batch: batch || '20261123-000000-abcdef' };
    },
    trash: async (id, rel) => { trashed.push(rel); disk(linkOf(id).root).delete(rel); return { batch: '20261123-000000-abcdef' }; },
    remove: async (id) => { const i = links.findIndex((x) => x.id === id); if (i >= 0) links.splice(i, 1); states.delete(id); return true; },
    setTier: async (id, tier) => { const l = linkOf(id); l.tier = tier; return view(l); },
    trust: async () => null,
  };
  // 服务器：每个账号一份工作区，每条授权一份副本。PUT 回 { size, mtime }（oldServer：只回 size，像改版之前）。
  // auth 是发请求的那个页面的登录状态：请求属于发出那一刻的账号；等着的时候换了账号，页面会把它掐掉——当它没传到、作废
  async function api(auth, url, opts = {}) {
    const user = auth.user, epoch = auth.epoch;
    if (!user) throw new Error('请先登录');
    const done = (v) => { if (auth.epoch !== epoch) throw stale(); return v; };
    const u = new URL(url, 'http://local'), id = u.searchParams.get('id'), rel = u.searchParams.get('path');
    if (u.pathname === '/api/linked' && !opts.method) { calls.list++; return done({ files: [...copy(id, user)].map(([p, f]) => ({ path: p, ...stamp(f) })), truncated: false }); }
    if (u.pathname === '/api/linked' && opts.method === 'PUT') {
      calls.put.push(rel); calls.putBy.push(user + ':' + id + ':' + rel); inflight++; world.maxInflight = Math.max(world.maxInflight, inflight);
      try {
        if (world.onPut) await world.onPut(id, rel, user);
        if (auth.epoch !== epoch) throw stale();
        const f = { bytes: Uint8Array.from(opts.body), mtime: ++clock }; copy(id, user).set(rel, f);
        return oldServer ? { size: f.bytes.length } : stamp(f);
      } finally { inflight--; }
    }
    if (u.pathname === '/api/linked/remove') {
      const b = JSON.parse(opts.body);
      if (b.all) { calls.remove.push('*'); space(user).delete(b.id); return done({ removed: 1 }); }
      for (const p of b.paths || []) { calls.remove.push(p); copy(b.id, user).delete(p); }
      return done({ removed: (b.paths || []).length });
    }
    if (/^\/api\/projects\/[\w-]+$/.test(u.pathname) && opts.method === 'PATCH') { // 改项目建在哪些文件夹上
      const pid = u.pathname.split('/').pop(), b = JSON.parse(opts.body);
      calls.project.push({ user, pid, linked: b.linked });
      if (!projects.has(user)) projects.set(user, new Map());
      projects.get(user).set(pid, b.linked);
      return done({ project: { id: pid, linked: b.linked } });
    }
    throw new Error('没有模拟这个接口：' + url);
  }
  const download = async (auth, url) => {
    calls.download++;
    const m = /^linked\/([a-f0-9]{16})\/(.+)$/.exec(new URL(url, 'http://local').searchParams.get('path') || ''), f = m && copy(m[1], auth.user).get(m[2]);
    return { ok: !!f, arrayBuffer: async () => f.bytes.slice().buffer };
  };
  const world = {
    disks, links, states, copies, calls, trashed, scans, desk, maxInflight: 0, onPut: null, onScan: null,
    get inflight() { return inflight; },
    spaceIds: (user) => [...space(user)].filter(([, m]) => m.size).map(([id]) => id), // 这个账号的工作区里有文件的副本
    projectLinked: (user, pid) => (projects.get(user) || new Map()).get(pid) || null,
    put(root, rel, text) { disk(root).set(rel, { bytes: typeof text === 'string' ? enc(text) : text, mtime: ++clock }); },
    local: (root, rel) => (disk(root).get(rel) ? dec(disk(root).get(rel).bytes) : null),
    localStamp: (root, rel) => stamp(disk(root).get(rel)),
    // 副本：默认看 synthetic 这个账号的工作区，user 指定看别的账号的
    copyText: (id, rel, user) => (copy(id, user).get(rel) ? dec(copy(id, user).get(rel).bytes) : null),
    copyStamp: (id, rel) => stamp(copy(id).get(rel)),
    setCopy(id, rel, text) { const f = { bytes: enc(text), mtime: ++clock }; copy(id).set(rel, f); return stamp(f); },
    copyNames: (id, user) => [...copy(id, user).keys()].sort(),
    saved: (id) => JSON.parse(states.get(id) || 'null'),
    grant(root, scope, tier = 'ask') {
      const had = links.find((l) => l.root === root && l.scope === scope);
      if (had) return { ...view(had), existed: true, ...summary(root) };
      const l = { id: require('node:crypto').randomBytes(8).toString('hex'), root, name: root.split('/').pop(), tier, scope, addedAt: Date.now() };
      links.push(l); return { ...view(l), existed: false, ...summary(root) };
    },
    // 开一个页面（S 是页面状态里要覆盖的部分；user 是在这个页面上登录的账号）
    page(S = {}, { user = 'synthetic' } = {}) {
      const toasts = [], sheets = [], clicks = [], rerenders = [], mode = { of: {} }, els = {}, auth = { user, epoch: 0 };
      const bar = { dataset: {}, innerHTML: '', classList: { toggle() {} } }, btn = { dataset: {}, classList: { toggle() {} } };
      const ctx = vm.createContext({
        TextEncoder, TextDecoder, Uint8Array, Uint32Array, URL, setTimeout, clearTimeout, console, __desk: desk,
        S: { view: 'chat', convId: null, conv: null, projectId: null, projects: [], convs: [], running: new Set(), draftId: null, ...S },
        authState: auth, api: (url, opts) => api(auth, url, opts), post: (url, body, method = 'POST') => api(auth, url, { method, body: JSON.stringify(body || {}) }), fetch: (url) => download(auth, url),
        // 面板（sheet）里点按钮：记下面板的点击处理，测试里用 click() 模拟点了哪个
        toast: (t) => toasts.push(t), sheet: (html) => { sheets.push(html); const box = { classList: { add() {} }, addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn); } }; return { querySelector: () => box, remove() {} }; },
        CHUNK: 4 * 1024 * 1024, sendInChunks: async () => { throw new Error('这里不该走到大文件'); }, rerenderMsg: (i) => rerenders.push(i),
        renderChatMode() {}, chatModeNow: () => 'work', chatModeOfConv: (id) => mode.of[id] || 'work',
        $: (sel) => els[sel] || null, icon: () => '', fmtDay: () => '今天', ls: { get: (k, d) => (k === 'lastUserId' ? auth.user : d), set() {} }, newDraftId: () => 'draft00000000001',
        openProject() {}, openConv() {}, newChat() {},
      });
      vm.runInContext([lfLine('const esc = '), lfLine('const fmtSize = '), lfLine('const extOf = '), ACCOUNT, LF_SECTION, 'LF.api = __desk;',
        'globalThis.h = { LF, lfReload, lfAdopt, lfSync, lfRun, lfIdle, lfDrop, lfBeforeSend, lfAfterReply, lfRender, lfWake, lfWaitText, lfWaitBar, lfBarHtml, lfProgText, lfForget, lfPanel, lfTransfers, lfScopeHere };'].join('\n'), ctx);
      return { h: ctx.h, S: ctx.S, auth, toasts, sheets, rerenders, mode, bar,
        link: (id) => ctx.h.LF.links.find((l) => l.id === id),
        showBar() { els['#folderBar'] = bar; els['#folderBtn'] = btn; },
        // 在面板里点了 data-do="act" 的那个按钮
        click: (act) => clicks.at(-1)({ target: { closest: (sel) => (sel === '[data-do]' ? { dataset: { do: act } } : null) } }),
        // 同一页上换了账号（登录失效后换人登录，页面没刷新）：页面里 resetAccount 做的那几件和这里有关的事，再换上新账号的对话列表
        switchTo(next, S2 = {}) {
          auth.epoch++; auth.user = next; ctx.h.lfForget();
          Object.assign(ctx.S, { view: 'chat', convId: null, conv: null, projectId: null, projects: [], convs: [], draftId: null, draftOwnerId: null, ...S2 });
        } };
    },
  };
  return world;
}

test('网页（内存里跑）：新授权的文件夹整个传过来；传完之前记着 initial，传完清掉；不下载回来比、不留清单', async () => {
  const w = lfWorld(), root = 'D:/资料/论文';
  w.put(root, '第一章.md', '# 第一章\n引言'); w.put(root, '图/1.png', 'PNG'); w.put(root, '数据.csv', 'x,y\n1,2\n');
  const p = w.page(CONV(CA)), info = w.grant(root, CA);
  assert.equal(info.tooMany, false);
  await p.h.lfReload(); const link = p.link(info.id);
  let during = null; w.onPut = (id) => { during = during || w.saved(id); };
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  assert.equal(during.initial, true); // 传的时候记着「第一次整传还没传完」
  assert.deepEqual(w.copyNames(info.id), ['图/1.png', '数据.csv', '第一章.md']);
  for (const rel of w.copyNames(info.id)) assert.equal(w.copyText(info.id, rel), w.local(root, rel));
  const st = w.saved(info.id);
  assert.equal(st.initial, undefined); assert.equal(st.lazy, undefined); assert.equal(Object.keys(st.files).length, 3);
  assert.equal(w.calls.download, 0); assert.deepEqual(p.sheets, []); assert.deepEqual(w.calls.remove, []);
  assert.equal(p.h.LF.status.get(info.id).phase, 'idle'); assert.equal(p.h.LF.status.get(info.id).progress, null);
  const body = {}; await p.h.lfBeforeSend(body, CA);
  assert.deepEqual(plain(body.linked), [{ id: info.id, name: '论文' }]); // 不是按需的，不带 lazy
});

test('网页（内存里跑）：超过上限的文件夹退回按需——只传清单，当场弹一次说明，文件夹条上一直写着', async () => {
  const w = lfWorld({ limit: 3 }), root = 'D:/资料/照片';
  for (let i = 1; i <= 5; i++) w.put(root, 'p' + i + '.jpg', 'img' + i);
  const p = w.page(CONV(CA)), info = w.grant(root, CA);
  assert.equal(info.tooMany, true);
  await p.h.lfReload(); const link = p.link(info.id);
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  assert.deepEqual(w.copyNames(info.id), ['_还没取来的文件清单.md']);
  assert.ok(w.copyText(info.id, '_还没取来的文件清单.md').includes('- p5.jpg'));
  assert.equal(w.saved(info.id).lazy, true); assert.equal(w.saved(info.id).initial, undefined);
  assert.equal(p.sheets.length, 1); assert.ok(p.sheets[0].includes('里的文件太多了') && p.sheets[0].includes('超过 5000 个文件或 5GB'));
  p.showBar(); p.h.LF.scope = CA; p.h.lfRender();
  assert.ok(p.bar.innerHTML.includes('文件太多，只传了清单，Claude 用到哪个取哪个'), p.bar.innerHTML);
  const body = {}; await p.h.lfBeforeSend(body, CA);
  assert.equal(body.linked[0].lazy, true);
  // 已经授权过的位置再授权一次：不再弹
  await p.h.lfAdopt(link, { ...w.grant(root, CA) }); await p.h.lfIdle(link);
  assert.equal(p.sheets.length, 1);
  // 真超了上限的：面板里写「文件太多」，没有「整个传过来」
  assert.equal(w.saved(info.id).fits, false);
  p.h.lfPanel(info.id); assert.ok(p.sheets.at(-1).includes('文件太多（超过 5000 个或 5GB）') && !p.sheets.at(-1).includes('data-do="whole"'));
});

test('网页（内存里跑）：老的按需授权（文件夹其实没超上限）同步后仍是按需，不悄悄改成整个上传；用户在面板里点了「整个传过来」才整传', async () => {
  const w = lfWorld(), root = 'D:/桌面';
  w.put(root, 'a.md', '甲'); w.put(root, 'b.md', '乙'); w.put(root, 'sub/c.md', '丙');
  const info = w.grant(root, CA), a = w.localStamp(root, 'a.md'), ca = w.setCopy(info.id, 'a.md', '甲');
  w.setCopy(info.id, '_还没取来的文件清单.md', '# 还没取来的文件\n- b.md\n- sub/c.md\n');
  w.states.set(info.id, JSON.stringify({ v: 1, user: 'synthetic', files: { 'a.md': [a.size, a.mtime, ca.size, ca.mtime] }, lazy: true, want: ['a.md'], indexSig: '1:2' }));
  const p = w.page(CONV(CA)); await p.h.lfReload(); const link = p.link(info.id);
  const body = {}; await p.h.lfBeforeSend(body, CA); // 发消息前同步了一次：照旧按需
  assert.equal(body.linked[0].lazy, true);
  assert.deepEqual(w.copyNames(info.id), ['_还没取来的文件清单.md', 'a.md']); // 没取过的 b、c 没有传上去
  assert.ok(!w.calls.put.includes('b.md') && !w.calls.put.includes('sub/c.md')); assert.deepEqual(w.calls.remove, []);
  let st = w.saved(info.id);
  assert.equal(st.lazy, true); assert.equal(st.fits, true); // 记下了「其实没超上限」
  await p.h.lfRun(link); assert.equal(w.saved(info.id).lazy, true); // 再同步一次也一样
  // 文件夹条上：只说只传了清单（提示可以整个传过来），不说「文件太多」
  p.showBar(); p.h.LF.scope = CA; p.h.lfRender();
  assert.ok(p.bar.innerHTML.includes('只传了清单，点名字可以整个传过来') && !p.bar.innerHTML.includes('文件太多'), p.bar.innerHTML);
  // 面板里有「整个传过来」和一句说明；用户点了才整个传过来（进度从已经取来的那些算起）
  p.h.lfPanel(info.id); const panel = p.sheets.at(-1);
  assert.ok(panel.includes('<button class="btn" data-do="whole">整个传过来</button>'), panel);
  assert.ok(panel.includes('现在只传了清单。点了以后里面的文件都会传给 Claude，之后两边互相同步') && !panel.includes('文件太多'));
  let first = null; w.onPut = (id) => { first = first || plain(p.h.LF.status.get(id).progress); };
  await p.click('whole'); await p.h.lfIdle(link);
  assert.deepEqual([first.kind, first.done, first.total], ['upload', 1, 3]);
  assert.deepEqual(w.copyNames(info.id), ['a.md', 'b.md', 'sub/c.md']);
  assert.deepEqual(w.calls.remove, ['_还没取来的文件清单.md']); // 清单删掉了，不算「模型删了文件」
  st = w.saved(info.id);
  for (const k of ['lazy', 'want', 'indexSig', 'fits', 'filling', 'initial']) assert.equal(st[k], undefined, k);
  assert.equal(Object.keys(st.files).length, 3);
  assert.deepEqual(plain(p.h.LF.pending.get(info.id)), []); assert.deepEqual(w.trashed, []); assert.equal(w.disks.get(root).size, 3); // 用户电脑上什么都没动
  assert.ok(p.toasts.some((t) => t.includes('「桌面」整个传过来了')), p.toasts.join('|'));
  const body2 = {}; await p.h.lfBeforeSend(body2, CA); assert.equal(body2.linked[0].lazy, undefined); // 之后告诉服务器的是整个同步
  p.h.lfRender(); assert.ok(!p.bar.innerHTML.includes('只传了清单'));
  p.h.lfPanel(info.id); assert.ok(!p.sheets.at(-1).includes('data-do="whole"')); // 整个同步的没有这个按钮
});

test('网页（内存里跑）：整个同步的文件夹后来涨过了上限——不报错卡住，转成按需，传过的照旧跟踪，并告诉用户', async () => {
  const w = lfWorld({ limit: 3 }), root = 'D:/项目';
  w.put(root, 'a.md', '1'); w.put(root, 'b.md', '2'); w.put(root, 'c.md', '3');
  const p = w.page(CONV(CA)), info = w.grant(root, CA); await p.h.lfReload(); const link = p.link(info.id);
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  assert.deepEqual(w.copyNames(info.id), ['a.md', 'b.md', 'c.md']);
  w.put(root, 'a.md', '1 改过'); w.put(root, 'd.md', '4'); w.put(root, 'e.md', '5');
  await p.h.lfRun(link);
  assert.notEqual(p.h.LF.status.get(info.id).phase, 'error');
  assert.equal(w.saved(info.id).lazy, true); assert.ok(p.toasts.some((t) => t.includes('改成只传清单')), p.toasts.join('|'));
  assert.equal(w.copyText(info.id, 'a.md'), '1 改过'); assert.equal(w.copyText(info.id, 'd.md'), null);
  const index = w.copyText(info.id, '_还没取来的文件清单.md');
  assert.ok(index.includes('- d.md') && index.includes('- e.md') && !index.includes('- a.md'), index);
});

test('网页（内存里跑）：每个文件夹一条队——甲的文件夹卡在传输上，乙发消息不等；同一个文件夹的事照顺序来，重复的同步不多排', async () => {
  const w = lfWorld(), A = 'D:/大文件夹', B = 'D:/小文件夹';
  w.put(A, 'a1.md', 'A1'); w.put(B, 'b1.md', 'B1');
  const p = w.page(CONV(CB)), ia = w.grant(A, CA), ib = w.grant(B, CB);
  await p.h.lfReload(); const la = p.link(ia.id), lb = p.link(ib.id);
  await p.h.lfAdopt(la, ia); await p.h.lfAdopt(lb, ib); await Promise.all([p.h.lfIdle(la), p.h.lfIdle(lb)]);
  for (let i = 0; i < 6; i++) w.put(A, 'new' + i + '.md', 'x' + i);
  let open; const gate = new Promise((r) => { open = r; });
  w.onPut = (id) => (id === ia.id ? gate : null);
  const runA = p.h.lfRun(la);
  await until(() => w.inflight === 3); // 甲自己最多同时传 3 个，都卡住了
  w.put(B, 'b1.md', 'B1 改过');
  await p.h.lfBeforeSend({ conversationId: CB }, CB); // 乙发消息：不等甲
  assert.equal(w.copyText(ib.id, 'b1.md'), 'B1 改过');
  assert.ok(!w.copyNames(ia.id).some((n) => n.startsWith('new')));
  const order = [], after = p.h.lfRun(la, {}, async () => { order.push(w.copyNames(ia.id).filter((n) => n.startsWith('new')).length); });
  const scansBefore = w.scans.filter((s) => s.id === ia.id).length;
  const more = [p.h.lfRun(la), p.h.lfRun(la), p.h.lfRun(la, { quick: true })]; // 来回切对话、发消息前：搭同一次的车
  assert.equal(p.h.LF.queues.get(ia.id).next.quick, false);
  open(); await Promise.all([runA, after, ...more]);
  assert.deepEqual(order, [6]); // 排在后面的事等前面的传完才做
  assert.equal(w.scans.filter((s) => s.id === ia.id).length, scansBefore + 1);
  assert.equal(w.copyNames(ia.id).filter((n) => n.startsWith('new')).length, 6);
});

test('网页（内存里跑）：所有文件夹合起来同时最多传 4 个文件', async () => {
  const w = lfWorld(), A = 'D:/甲', B = 'D:/乙';
  for (let i = 0; i < 8; i++) { w.put(A, 'a' + i + '.md', 'A' + i); w.put(B, 'b' + i + '.md', 'B' + i); }
  const p = w.page(CONV(CA)), ia = w.grant(A, CA), ib = w.grant(B, CB);
  await p.h.lfReload(); const la = p.link(ia.id), lb = p.link(ib.id);
  let open; const gate = new Promise((r) => { open = r; }); w.onPut = () => gate;
  await p.h.lfAdopt(la, ia); await p.h.lfAdopt(lb, ib);
  await until(() => w.inflight === 4); await later(30);
  assert.equal(w.inflight, 4); assert.equal(p.h.LF.busy, 4); assert.ok(p.h.LF.slotWait.length > 0);
  assert.ok(w.calls.put.some((r) => r.startsWith('a')) && w.calls.put.some((r) => r.startsWith('b'))); // 一个文件夹占不满，另一个也在传
  open(); await Promise.all([p.h.lfIdle(la), p.h.lfIdle(lb)]);
  assert.equal(w.maxInflight, 4); assert.equal(p.h.LF.busy, 0);
  assert.equal(w.copyNames(ia.id).length, 8); assert.equal(w.copyNames(ib.id).length, 8);
});

test('网页（内存里跑）：第一次整传中途断了——刷新后从断的地方接着传，传好的不重传、不下载回来比', async () => {
  const w = lfWorld(), root = 'D:/毕业论文', name = (i) => 'f' + String(i).padStart(2, '0') + '.md';
  for (let i = 1; i <= 30; i++) w.put(root, name(i), '内容' + i);
  const info = w.grant(root, CA), p = w.page(CONV(CA)); await p.h.lfReload(); const link = p.link(info.id);
  let midSaved = -1;
  w.onPut = (id, rel) => { if (rel === 'f30.md') { midSaved = Object.keys(w.saved(id).files).length; throw new Error('网络断了'); } };
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  assert.ok(midSaved >= 25, '传的过程中就存过盘：' + midSaved); // 不是等整批传完才存
  assert.equal(p.h.LF.status.get(info.id).phase, 'error');
  // 模拟刷新得更突然：最后三个传上去了，但还没来得及记；其中一个用户之后又改了（大小变了）
  const st = w.saved(info.id); assert.equal(st.initial, true); assert.equal(st.user, 'synthetic');
  for (const rel of ['f27.md', 'f28.md', 'f29.md']) delete st.files[rel];
  w.states.set(info.id, JSON.stringify(st)); w.put(root, 'f29.md', '内容29，用户后来又加了一句');
  // 刷新：新页面，打开应用就接着传（不管现在开着哪个对话）
  w.onPut = null; const puts = w.calls.put.length, dl = w.calls.download;
  const p2 = w.page(CONV(CB)); let first = null;
  w.onPut = (id) => { first = first || plain(p2.h.LF.status.get(id).progress); };
  await p2.h.lfWake(); await p2.h.lfIdle(p2.link(info.id));
  assert.deepEqual(w.calls.put.slice(puts).sort(), ['f30.md']); // 只传没传上去的
  assert.equal(w.calls.download, dl);                             // 一个都没下载回来比
  assert.deepEqual([first.done, first.total], [28, 29]);           // 进度从已经传好的那里接着算
  // f27、f28：两边都有、大小一样、没有记录——只有这一种直接补记录。f29 两边大小不同：不拿用户的直接盖，当成「两边都改过」等用户选
  const done = w.saved(info.id);
  assert.equal(done.initial, undefined); assert.equal(Object.keys(done.files).length, 29); assert.equal(done.files['f29.md'], undefined);
  assert.deepEqual(done.files['f27.md'].slice(2), [w.copyStamp(info.id, 'f27.md').size, w.copyStamp(info.id, 'f27.md').mtime]); // 补的记录用的是服务器列表里的大小和时间
  for (let i = 1; i <= 30; i++) if (i !== 29) assert.equal(w.copyText(info.id, name(i)), w.local(root, name(i)));
  assert.equal(w.copyText(info.id, 'f29.md'), '内容29');
  assert.deepEqual(plain(p2.h.LF.pending.get(info.id)).map((c) => c.kind + ':' + c.path + (c.conflict ? '（两边都改过）' : '')), ['modified:f29.md（两边都改过）']);
  // 标记不在（第一次整传早就传完了）时照旧：两边都有、没有记录的，下载回来比内容
  const st2 = w.saved(info.id); delete st2.files['f01.md']; w.states.set(info.id, JSON.stringify(st2));
  const p3 = w.page(CONV(CA)); await p3.h.lfReload(); const dl2 = w.calls.download, puts2 = w.calls.put.length;
  await p3.h.lfRun(p3.link(info.id));
  assert.equal(w.calls.download, dl2 + 1); assert.equal(w.calls.put.length, puts2); assert.ok(w.saved(info.id).files['f01.md']);
});

test('网页（内存里跑）：服务器回了大小和时间就当场记下，批末不再问一次列表；旧服务器不回时退回老办法', async () => {
  for (const oldServer of [false, true]) {
    const w = lfWorld({ oldServer }), root = 'D:/资料';
    for (let i = 0; i < 12; i++) w.put(root, 'n' + String(i).padStart(2, '0') + '.txt', 'n' + i);
    const p = w.page(CONV(CA)), info = w.grant(root, CA); await p.h.lfReload(); const link = p.link(info.id);
    await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
    const st = w.saved(info.id);
    assert.equal(Object.keys(st.files).length, 12, String(oldServer));
    for (const [rel, rec] of Object.entries(st.files)) assert.deepEqual(rec.slice(2), [w.copyStamp(info.id, rel).size, w.copyStamp(info.id, rel).mtime]);
    assert.equal(w.calls.list, oldServer ? 2 : 1, String(oldServer));
  }
});

test('网页（内存里跑）：进度按字节算、给出文件数，随上传往前走；核对时是「正在核对文件…」；进度条的样子', async () => {
  const w = lfWorld(), root = 'D:/资料';
  for (let i = 0; i < 10; i++) w.put(root, 'z' + i + '.txt', 'x'.repeat(100 * (i + 1)));
  const total = Array.from({ length: 10 }, (_, i) => 100 * (i + 1)).reduce((a, b) => a + b, 0);
  const p = w.page(CONV(CA)), info = w.grant(root, CA); await p.h.lfReload(); const link = p.link(info.id);
  const snaps = []; let scanning = null, bar = '';
  w.onScan = (id, all) => { if (!all && !scanning) scanning = plain(p.h.LF.status.get(id).progress); };
  w.onPut = (id) => { snaps.push(plain(p.h.LF.status.get(id).progress)); bar = p.h.lfBarHtml(id, true); };
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  assert.equal(scanning.kind, 'scan'); assert.equal(p.h.lfProgText(scanning), '正在核对文件…');
  assert.equal(snaps.length, 10);
  assert.ok(snaps.every((s) => s.kind === 'upload' && s.total === 10 && s.totalBytes === total), JSON.stringify(snaps[0]));
  for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i].done >= snaps[i - 1].done && snaps[i].bytes >= snaps[i - 1].bytes);
  assert.ok(snaps.at(-1).done >= 7 && snaps.at(-1).bytes > 0);
  assert.match(bar, /^<span class="lf-prog" data-lfp="[a-f0-9]{16}" data-painted="1"><span class="lf-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="\d+"><i style="width:[\d.]+%"><\/i><\/span><small>正在传 \d+ \/ 10 个 · [\d.]+ KB \/ 5\.4 KB<\/small><\/span>$/);
  assert.equal(p.h.LF.status.get(info.id).progress, null); // 传完收起
  assert.equal(p.h.lfProgText({ kind: 'upload', done: 128, total: 560, bytes: 1.2 * 2 ** 30, totalBytes: 3.4 * 2 ** 30 }), '正在传 128 / 560 个 · 1.2 GB / 3.4 GB');
  assert.equal(p.h.lfProgText({ kind: 'writeback', done: 3, total: 10, bytes: 12 * 2 ** 20, totalBytes: 40 * 2 ** 20 }), '正在写回 3 / 10 个 · 12.0 MB / 40.0 MB');
  assert.match(p.h.lfBarHtml('0123456789abcdef'), /<i><\/i><\/span><small><\/small>/); // 文件夹条上的是空架子，进度由 lfPaint 填，不跟着进度重画
});

test('网页（内存里跑）：别的对话写回到用户电脑上的改动，打开这个对话、发消息之前都会传进这个对话的副本；两边都改过的等用户选', async () => {
  const w = lfWorld(), root = 'D:/论文';
  w.put(root, 'a.md', '原文 A'); w.put(root, 'b.md', '原文 B'); w.put(root, 'c.md', '原文 C');
  const p = w.page(CONV(CB)), ia = w.grant(root, CA), ib = w.grant(root, CB, 'all');
  await p.h.lfReload(); const la = p.link(ia.id), lb = p.link(ib.id);
  await p.h.lfAdopt(la, ia); await p.h.lfAdopt(lb, ib); await Promise.all([p.h.lfIdle(la), p.h.lfIdle(lb)]);
  // 对话乙（全部允许）里 Claude 改了 a.md：自动写回用户的电脑；对话甲的副本这时还是旧的
  w.setCopy(ib.id, 'a.md', '乙对话里 Claude 改的'); await p.h.lfRun(lb);
  assert.equal(w.local(root, 'a.md'), '乙对话里 Claude 改的'); assert.equal(w.copyText(ia.id, 'a.md'), '原文 A');
  // 打开对话甲：文件夹条上先显示「正在核对文件…」，核对完这个改动传进甲的副本；没有别的变化，核对完不留字
  p.showBar(); p.h.LF.scope = CB;
  let shown = null; w.onScan = (id, all) => { if (id === ia.id && !all && !shown) shown = { html: p.bar.innerHTML, text: p.h.lfProgText(p.h.LF.status.get(id).progress) }; };
  Object.assign(p.S, CONV(CA)); p.h.lfRender(); await p.h.lfIdle(la);
  assert.ok(shown.html.includes(`data-lfp="${ia.id}"`), shown.html); assert.equal(shown.text, '正在核对文件…');
  assert.equal(w.copyText(ia.id, 'a.md'), '乙对话里 Claude 改的');
  p.h.lfRender(); assert.ok(!p.bar.innerHTML.includes('data-lfp') && !p.bar.innerHTML.includes('正在'), p.bar.innerHTML);
  w.onScan = null;
  // 乙又写回了 b.md；用户在甲里发消息：先把这个改动传进甲的副本，等着的那条回复上写着在等什么、带着进度条
  w.setCopy(ib.id, 'b.md', '乙又改了 B'); await p.h.lfRun(lb);
  const reply = { role: 'assistant', status: 'running' }; p.S.conv = { id: CA, messages: [{ role: 'user', text: '继续' }, reply] };
  let during = null; w.onPut = (id) => { if (id === ia.id) during = { text: p.h.lfWaitText(reply), bar: p.h.lfWaitBar(reply) }; };
  await p.h.lfBeforeSend({ conversationId: CA }, CA);
  assert.equal(w.copyText(ia.id, 'b.md'), '乙又改了 B');
  assert.equal(during.text, '先同步「论文」'); assert.ok(during.bar.includes('正在传 1 / 1 个') || during.bar.includes('正在传 0 / 1 个'), during.bar);
  assert.equal(p.h.LF.waits.size, 0); assert.ok(p.rerenders.includes(1)); assert.equal(p.h.lfWaitText(reply), '');
  w.onPut = null;
  // 甲的副本里有 Claude 还没写回的改动（甲是「每次问我」），乙又改了同一个文件并写回：算两边都改过，等用户选，哪边都不盖
  w.setCopy(ia.id, 'c.md', '甲对话里 Claude 改的'); await p.h.lfRun(la);
  assert.deepEqual(plain(p.h.LF.pending.get(ia.id)).map((c) => c.kind + ':' + c.path), ['modified:c.md']);
  w.setCopy(ib.id, 'c.md', '乙对话里 Claude 改的 C，长一点'); await p.h.lfRun(lb);
  assert.equal(w.local(root, 'c.md'), '乙对话里 Claude 改的 C，长一点');
  await p.h.lfBeforeSend({ conversationId: CA }, CA);
  const pend = plain(p.h.LF.pending.get(ia.id));
  assert.equal(pend.length, 1); assert.equal(pend[0].path, 'c.md'); assert.equal(pend[0].conflict, true);
  assert.equal(w.copyText(ia.id, 'c.md'), '甲对话里 Claude 改的'); assert.equal(w.local(root, 'c.md'), '乙对话里 Claude 改的 C，长一点');
});

test('网页（内存里跑）：传到一半收回授权——不再开始新的文件，手上的传完之后副本再删一遍', async () => {
  const w = lfWorld(), root = 'D:/资料';
  for (let i = 0; i < 12; i++) w.put(root, 'r' + String(i).padStart(2, '0') + '.md', 'x' + i);
  const p = w.page(CONV(CA)), info = w.grant(root, CA); await p.h.lfReload(); const link = p.link(info.id);
  let open; const gate = new Promise((r) => { open = r; }); w.onPut = () => gate;
  await p.h.lfAdopt(link, info); await until(() => w.inflight === 3);
  const tail = p.h.lfIdle(link);
  await p.h.lfDrop(link);
  assert.equal(p.h.LF.links.length, 0); assert.equal(w.links.length, 0);
  open(); await tail; await later(20);
  assert.equal(w.calls.put.length, 3); // 只有已经在路上的那 3 个
  assert.ok(!w.copies.has(info.id) || w.copyNames(info.id).length === 0, String(w.copies.has(info.id) && w.copyNames(info.id))); // 它们落地之后，副本又删了一遍
  assert.equal(p.h.LF.busy, 0);
});

test('网页（内存里跑）：聊天的对话照旧不碰文件夹——不带、不同步、回复结束也不比对', async () => {
  const w = lfWorld(), root = 'D:/论文'; w.put(root, 'a.md', '原文');
  const p = w.page(CONV(CA)), info = w.grant(root, CA); await p.h.lfReload(); const link = p.link(info.id);
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  p.mode.of[CA] = 'chat'; w.put(root, 'a.md', '用户改过');
  const scans = w.scans.length, body = { conversationId: CA };
  await p.h.lfBeforeSend(body, CA); p.h.lfAfterReply(CA);
  assert.equal(body.linked, undefined); assert.equal(body.canTrust, undefined);
  assert.equal(w.scans.length, scans); assert.deepEqual(Object.keys(p.h.LF.timers), []);
  assert.equal(w.copyText(info.id, 'a.md'), '原文');
});

// ---------- 网页（内存里跑）：授权跟着账号走 ----------
// 桌面端不分账号：同一台电脑上谁登录，桌面端给的都是同一份授权列表。哪条是谁的，只看同步记录里的 st.user
const OTHER = 'feedfacefeedface'; // 另一个账号的对话

test('网页（内存里跑）：账号甲第一次整传到一半关了应用，账号乙在这台电脑上登录——乙这边不显示、不同步、不接着传甲的授权，乙的工作区里没有甲的文件；换回甲接着传完', async () => {
  const w = lfWorld(), root = 'D:/甲的论文', name = (i) => 'g' + String(i).padStart(2, '0') + '.md';
  for (let i = 1; i <= 20; i++) w.put(root, name(i), '甲的内容' + i);
  const pa = w.page(CONV(CA), { user: 'alice' }), info = w.grant(root, CA); await pa.h.lfReload(); const link = pa.link(info.id);
  let first = null;
  w.onPut = (id) => { first = first || w.saved(id); if (w.calls.put.length > 8) throw new Error('网络断了'); };
  await pa.h.lfAdopt(link, info); await pa.h.lfIdle(link);
  assert.equal(first.user, 'alice'); assert.equal(first.initial, true); // 授权一建立就记了账号：第一个文件上传之前就存了盘
  const half = w.saved(info.id), recorded = Object.keys(half.files);
  assert.equal(half.user, 'alice'); assert.equal(half.initial, true); assert.equal(recorded.length, 8);
  // 乙登录（重新打开的页面；乙自己的对话里没有甲的那个）。甲的授权已经放了好几天
  w.onPut = null; const puts = w.calls.put.length;
  w.links.find((l) => l.id === info.id).addedAt = Date.now() - 3 * 86400000;
  const pb = w.page({ convId: OTHER, conv: { id: OTHER, messages: [] }, convs: [{ id: OTHER }] }, { user: 'bob' }); pb.showBar();
  await pb.h.lfWake(); await later(30);
  assert.deepEqual(plain(pb.h.LF.links), []); assert.deepEqual(plain(pb.h.LF.strays), []); // 记着甲的账号：在乙这边就是别人的
  assert.equal(w.calls.put.length, puts); assert.deepEqual(w.spaceIds('bob'), []);             // 一个文件都没往乙那里传
  assert.equal(w.links.length, 1); assert.deepEqual(w.calls.remove, []);                      // 也没被当成「对话不在了」收回
  const still = w.saved(info.id);
  assert.equal(still.user, 'alice'); assert.equal(still.initial, true); assert.deepEqual(Object.keys(still.files), recorded); // 记录没被改记到乙名下
  pb.h.LF.scope = null; pb.h.lfRender();
  assert.ok(!pb.bar.innerHTML.includes('甲的论文')); assert.deepEqual(plain(pb.h.lfTransfers()), []); // 文件夹条、顶栏的传输指示都没有
  // 换回甲：打开应用就接着传完，传过的不重传
  const pa2 = w.page(CONV(CA), { user: 'alice' }); await pa2.h.lfWake(); await pa2.h.lfIdle(pa2.link(info.id));
  const after = w.calls.put.slice(puts);
  assert.equal(after.length, 12); assert.ok(after.every((rel) => !recorded.includes(rel)), after.join());
  for (let i = 1; i <= 20; i++) assert.equal(w.copyText(info.id, name(i), 'alice'), w.local(root, name(i)));
  const done = w.saved(info.id);
  assert.equal(done.user, 'alice'); assert.equal(done.initial, undefined); assert.equal(Object.keys(done.files).length, 20);
  assert.deepEqual(w.spaceIds('bob'), []);
  assert.ok(w.calls.putBy.every((x) => x.startsWith('alice:')), w.calls.putBy.join());
});

test('网页（内存里跑）：没记账号的老授权——范围是这个账号的对话才显示、同步，并补记账号；认不出来的不显示、不同步、也不清理；草稿的等这个账号打开那个草稿再认', async () => {
  const w = lfWorld(), mine = 'D:/我的', other = 'D:/别人的', draft = 'D:/草稿里的', DRAFT = 'draft00000000007';
  w.put(mine, 'a.md', '我的'); w.put(other, 'b.md', '别人的'); w.put(draft, 'c.md', '草稿里的');
  const im = w.grant(mine, CA), io = w.grant(other, OTHER), idr = w.grant(draft, DRAFT);
  for (const l of w.links) l.addedAt = Date.now() - 3 * 86400000; // 都放了好几天
  for (const x of [im, io, idr]) w.states.set(x.id, JSON.stringify({ v: 1, user: '', files: {}, initial: true })); // 修之前留下的：第一次整传没传完，没记账号
  const p = w.page(CONV(CA)); p.showBar();
  await p.h.lfWake(); await p.h.lfIdle(p.link(im.id));
  assert.deepEqual(plain(p.h.LF.links.map((l) => l.id)), [im.id]);
  assert.deepEqual(plain(p.h.LF.strays.map((l) => l.id)).sort(), [io.id, idr.id].sort());
  assert.equal(w.saved(im.id).user, 'synthetic');                                                  // 认下来，补记了账号
  assert.equal(w.copyText(im.id, 'a.md'), '我的'); assert.equal(w.saved(im.id).initial, undefined);  // 照常接着传完
  assert.equal(w.saved(io.id).user, ''); assert.equal(w.saved(idr.id).user, '');                    // 认不出来的：不补记
  assert.deepEqual(w.copyNames(io.id), []); assert.deepEqual(w.copyNames(idr.id), []);               // 不同步、不接着传
  assert.equal(w.links.length, 3); assert.deepEqual(w.calls.remove, []);                             // 也不清理（可能是别的账号的）
  p.h.LF.scope = null; p.h.lfRender();
  assert.ok(p.bar.innerHTML.includes('我的') && !p.bar.innerHTML.includes('别人的') && !p.bar.innerHTML.includes('草稿里的'), p.bar.innerHTML);
  // 这个账号回到了那个新对话草稿：这时才认下来、同步
  Object.assign(p.S, { convId: null, conv: null, draftId: DRAFT }); p.h.lfRender();
  await until(() => !!p.link(idr.id)); await p.h.lfIdle(p.link(idr.id));
  assert.equal(w.saved(idr.id).user, 'synthetic'); assert.equal(w.copyText(idr.id, 'c.md'), '草稿里的');
  assert.deepEqual(plain(p.h.LF.strays.map((l) => l.id)), [io.id]);
  assert.equal(w.saved(io.id).user, ''); assert.deepEqual(w.copyNames(io.id), []); assert.equal(w.links.length, 3);
});

test('网页（内存里跑）：同步途中换了账号（登录失效后换人登录，页面没刷新）——手上的请求作废，不再开始新的文件，一个都不传进新账号；换回来接着传', async () => {
  const w = lfWorld(), root = 'D:/资料';
  for (let i = 0; i < 12; i++) w.put(root, 's' + String(i).padStart(2, '0') + '.md', 'x' + i);
  const p = w.page(CONV(CA), { user: 'alice' }), info = w.grant(root, CA); await p.h.lfReload(); const link = p.link(info.id);
  let open; const gate = new Promise((r) => { open = r; }); w.onPut = () => gate;
  await p.h.lfAdopt(link, info); await until(() => w.inflight === 3);
  assert.equal(p.h.lfTransfers().length, 1);
  const tail = p.h.lfIdle(link);
  p.switchTo('bob', { convId: OTHER, conv: { id: OTHER, messages: [] }, convs: [{ id: OTHER }] });
  assert.deepEqual(plain(p.h.LF.links), []); assert.deepEqual(plain(p.h.lfTransfers()), []); // 页面上马上不留甲的授权和进度
  open(); await tail; await later(20);
  assert.equal(w.calls.put.length, 3);                                      // 只有换账号之前已经在路上的 3 个，而且都作废了
  assert.deepEqual(w.spaceIds('bob'), []); assert.deepEqual(w.copyNames(info.id, 'alice'), []);
  assert.ok(w.calls.putBy.every((x) => x.startsWith('alice:')), w.calls.putBy.join());
  assert.equal(p.h.LF.busy, 0); assert.equal(p.h.LF.status.size, 0);       // 名额都还回去了，进度也没留下
  const st = w.saved(info.id); assert.equal(st.user, 'alice'); assert.equal(st.initial, true);
  await p.h.lfWake(); await later(20);                                        // 乙这边醒来：不认甲的，也不接着传
  assert.deepEqual(plain(p.h.LF.links), []); assert.equal(w.calls.put.length, 3);
  // 同一页上换回甲：接着传完
  w.onPut = null; p.switchTo('alice', CONV(CA)); await p.h.lfWake(); await p.h.lfIdle(p.link(info.id));
  assert.equal(w.copyNames(info.id, 'alice').length, 12); assert.equal(w.saved(info.id).initial, undefined); assert.equal(w.saved(info.id).user, 'alice');
  assert.deepEqual(w.spaceIds('bob'), []);
});

test('网页（内存里跑）：项目的文件夹第一次整传传完了才记到项目信息上；传到一半关掉、下次接着传完时补记；按需的照旧马上记', async () => {
  const w = lfWorld({ limit: 20 }), PID = 'abcd1234', root = 'D:/项目资料', big = 'D:/很多资料', root3 = 'D:/第三份';
  for (let i = 0; i < 10; i++) w.put(root, 'p' + i + '.md', 'x' + i);
  for (let i = 0; i < 25; i++) w.put(big, 'q' + String(i).padStart(2, '0') + '.md', 'y' + i);
  w.put(root3, 'r.md', 'z');
  const at = () => ({ view: 'project', projectId: PID, projects: [{ id: PID, name: '毕业论文', linked: [] }], convs: [] });
  const p = w.page(at()), info = w.grant(root, 'p:' + PID); await p.h.lfReload(); const link = p.link(info.id);
  let during = null;
  w.onPut = () => { during = during || plain(w.calls.project); if (w.calls.put.length > 4) throw new Error('网络断了'); };
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  assert.deepEqual(during, []); assert.deepEqual(w.calls.project, []); // 传的时候、没传完的时候，项目信息里都没有它（别的设备上的对话不会知道它）
  assert.deepEqual(plain(p.S.projects[0].linked), []);
  const st = w.saved(info.id); assert.equal(st.initial, true); assert.equal(st.unlisted, true);
  p.showBar(); p.h.LF.scope = 'p:' + PID; p.h.lfRender(); assert.ok(p.bar.innerHTML.includes('项目资料'), p.bar.innerHTML); // 这台电脑上照样看得到它
  // 关掉应用，下次打开接着传完：这时才记上
  w.onPut = null;
  const p2 = w.page(at()); await p2.h.lfWake(); await p2.h.lfIdle(p2.link(info.id));
  assert.equal(w.copyNames(info.id).length, 10);
  assert.deepEqual(w.calls.project.map((c) => [c.user, c.pid, c.linked.map((x) => x.id)]), [['synthetic', PID, [info.id]]]);
  assert.deepEqual(plain(p2.S.projects[0].linked), [{ id: info.id, name: '项目资料' }]);
  const done = w.saved(info.id); assert.equal(done.initial, undefined); assert.equal(done.unlisted, undefined);
  await p2.h.lfRun(p2.link(info.id)); assert.equal(w.calls.project.length, 1); // 之后再同步不会再记一遍
  // 一口气传完的：也是传完才记
  const i3 = w.grant(root3, 'p:' + PID); await p2.h.lfReload();
  let mid = null; w.onPut = (id) => { if (id === i3.id && mid === null) mid = w.calls.project.length; };
  await p2.h.lfAdopt(p2.link(i3.id), i3); await p2.h.lfIdle(p2.link(i3.id));
  assert.equal(mid, 1); assert.deepEqual(w.calls.project.at(-1).linked.map((x) => x.id), [info.id, i3.id]);
  // 超过上限的（按需，只传清单）：照旧授权时马上记
  w.onPut = null; const i2 = w.grant(big, 'p:' + PID); assert.equal(i2.tooMany, true);
  await p2.h.lfReload(); const before = w.calls.project.length;
  await p2.h.lfAdopt(p2.link(i2.id), i2);
  assert.equal(w.calls.project.length, before + 1); assert.deepEqual(w.calls.project.at(-1).linked.map((x) => x.id), [info.id, i3.id, i2.id]);
  assert.equal(w.saved(i2.id).unlisted, undefined); await p2.h.lfIdle(p2.link(i2.id));
});

test('网页（内存里跑）：第一次整传没传完时副本里冒出来的东西——用户这边没有的不删、算 Claude 新建的；大小不同的不直接盖、算两边都改过；只有大小一样、没有记录的直接补记录', async () => {
  const w = lfWorld(), root = 'D:/论文';
  w.put(root, 'a.md', '用户的 A'); w.put(root, 'b.md', '用户的 B'); w.put(root, 'c.md', '用户的 C'); w.put(root, 'd.md', '用户的 D');
  const info = w.grant(root, CA);
  // 上次传到一半：a 传上去、记下了；b 传上去了还没来得及记（大小一样）。之后模型往副本里写了 new.md，又把 c 改长了
  const a = w.localStamp(root, 'a.md'), ca = w.setCopy(info.id, 'a.md', '用户的 A');
  w.setCopy(info.id, 'b.md', '用户的 B'); w.setCopy(info.id, 'new.md', 'Claude 写的新文件'); w.setCopy(info.id, 'c.md', 'Claude 改过的 C，长了不少');
  w.states.set(info.id, JSON.stringify({ v: 1, user: 'synthetic', files: { 'a.md': [a.size, a.mtime, ca.size, ca.mtime] }, initial: true }));
  const p = w.page(CONV(CA)); await p.h.lfWake(); await p.h.lfIdle(p.link(info.id));
  assert.equal(w.copyText(info.id, 'new.md'), 'Claude 写的新文件');           // 没删
  assert.equal(w.copyText(info.id, 'c.md'), 'Claude 改过的 C，长了不少');      // 没拿用户的盖
  assert.equal(w.copyText(info.id, 'd.md'), '用户的 D');                        // 没传过的照常传
  assert.deepEqual(w.calls.put, ['d.md']); assert.deepEqual(w.calls.remove, []); assert.equal(w.calls.download, 0); // b：直接补记录，不重传、不下载回来比
  assert.deepEqual(plain(p.h.LF.pending.get(info.id)).map((c) => c.kind + ':' + c.path + (c.conflict ? '（两边都改过）' : '')), ['modified:c.md（两边都改过）', 'created:new.md']);
  const st = w.saved(info.id);
  assert.equal(st.initial, undefined); assert.ok(st.files['b.md']); assert.equal(st.files['c.md'], undefined); assert.equal(st.files['new.md'], undefined);
  assert.equal(w.local(root, 'c.md'), '用户的 C'); assert.equal(w.local(root, 'new.md'), null); // 「每次问我」：用户电脑上还没动，等用户确认
});

test('网页（内存里跑）：副本整个不见了——整个重传记成 filling（不是第一次整传）：打开应用接着传；副本里冒出来的同样大小的文件也下载回来比', async () => {
  const w = lfWorld(), root = 'D:/论文';
  for (let i = 0; i < 6; i++) w.put(root, 'f' + i + '.md', '内容' + i);
  const info = w.grant(root, CA), p = w.page(CONV(CA)); await p.h.lfReload(); const link = p.link(info.id);
  await p.h.lfAdopt(link, info); await p.h.lfIdle(link);
  w.copies.delete(info.id); // 那边被清过
  w.onPut = (id, rel) => { if (['f3.md', 'f4.md', 'f5.md'].includes(rel)) throw new Error('网络断了'); }; // 重传到一半断了：f0–f2 传上去了
  await p.h.lfRun(link);
  const st = w.saved(info.id); assert.equal(st.filling, true); assert.equal(st.initial, undefined); assert.deepEqual(Object.keys(st.files).sort(), ['f0.md', 'f1.md', 'f2.md']);
  assert.match(p.h.LF.status.get(info.id).text, /网络断了/);
  // 别的设备上的对话往副本里写了一个和用户的 f4 一样大、内容不同的文件
  w.setCopy(info.id, 'f4.md', '内容X'); assert.equal(w.copyStamp(info.id, 'f4.md').size, w.localStamp(root, 'f4.md').size);
  w.onPut = null; const dl = w.calls.download;
  const p2 = w.page(CONV(CB)); await p2.h.lfWake(); await p2.h.lfIdle(p2.link(info.id)); // 打开应用就接着传
  assert.equal(w.saved(info.id).filling, undefined);
  assert.ok(w.calls.download > dl);                                             // 没走「大小一样就补记录」的捷径
  assert.equal(w.copyText(info.id, 'f4.md'), '内容X');
  assert.deepEqual(plain(p2.h.LF.pending.get(info.id)).map((c) => c.path + (c.conflict ? '（两边都改过）' : '')), ['f4.md（两边都改过）']);
  for (const i of [0, 1, 2, 3, 5]) assert.equal(w.copyText(info.id, 'f' + i + '.md'), '内容' + i);
});
