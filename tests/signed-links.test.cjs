'use strict';
// 对话内互动网页的签名链接（/f/<token>/...）：只放行网页所在的那个文件夹，
// 根目录的网页只放行它自己，以 . 开头的记忆/配置文件夹一律不放行。只取出 server.js 里的函数在 vm 里跑，不启动服务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..'), 'server.js'), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source markers: ${start}`);
  return source.slice(a, b);
};
const workspacePath = require('../workspace-path');

function harness() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-signed-'));
  const put = (rel, text) => { const f = path.join(workDir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('report.html', '<p>root page</p>');
  put('notes.txt', 'root secret');
  put('.memory/memory.md', 'memory secret');
  put('chats/0123456789abcdef/outputs/site/index.html', '<p>site</p>');
  put('chats/0123456789abcdef/outputs/site/app.js', 'ok');
  put('chats/0123456789abcdef/outputs/site/.hidden/x.txt', 'hidden');
  put('chats/fedcba9876543210/outputs/other.txt', 'other conversation');
  const user = { id: 'alice', workDir };
  const secret = crypto.randomBytes(32).toString('hex');
  const served = [];
  const context = vm.createContext({
    path, fs, Buffer, Date, USERS: new Map([['alice', user]]), config: { isolation: { enabled: false } },
    sign: (v) => crypto.createHmac('sha256', secret).update(v).digest('hex'),
    safeEqual: (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); },
    resolveIn: (u, rel) => workspacePath(u.workDir, rel || ''),
    admitMaintenanceTask: () => true,
    serveWorkFile: (res, abs) => { served.push(abs); res.code = 200; res.body = fs.readFileSync(abs, "utf8"); return res; },
  });
  const route = between('  // 签名链接访问的文件', '  // 本机专用');
  vm.runInContext(between('const INLINE_EXTS = ', '// 给消息里的网页文件加上签名链接') +
    `\nasync function get(p) { const req = { method: 'GET' }; const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { if (b) this.body = b; return this; } }; let m;
${route} return res; }\nglobalThis.api = { signedUrl, checkSigned, get };`, context);
  const fetch = async (url) => (await context.api.get(url)).code === 200 ? 'ok' : 'denied';
  const sibling = (url, rel) => url.replace(/^(\/f\/[^/]+\/).*$/, `$1${rel}`);
  return { user, api: context.api, fetch, sibling, cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }) };
}

test('a root-level page is signed for itself only, not for the whole account', async (t) => {
  const h = harness(); t.after(h.cleanup);
  const url = h.api.signedUrl(h.user, 'report.html');
  assert.equal(await h.fetch(url), 'ok');
  for (const rel of ['notes.txt', '.memory/memory.md', 'chats/fedcba9876543210/outputs/other.txt', 'report.html/x'])
    assert.equal(await h.fetch(h.sibling(url, rel)), 'denied', rel);
});

test('a page inside a folder still loads its sibling resources but nothing outside', async (t) => {
  const h = harness(); t.after(h.cleanup);
  const url = h.api.signedUrl(h.user, 'chats/0123456789abcdef/outputs/site/index.html');
  assert.equal(await h.fetch(url), 'ok');
  assert.equal(await h.fetch(h.sibling(url, 'chats/0123456789abcdef/outputs/site/app.js')), 'ok');
  for (const rel of ['chats/0123456789abcdef/outputs/site/.hidden/x.txt', 'chats/fedcba9876543210/outputs/other.txt', '.memory/memory.md', 'notes.txt'])
    assert.equal(await h.fetch(h.sibling(url, rel)), 'denied', rel);
});

test('dot-prefixed path segments are refused even when the signature covers them', async (t) => {
  const h = harness(); t.after(h.cleanup);
  const url = h.api.signedUrl(h.user, '.memory/memory.md');
  assert.equal(await h.fetch(url), 'denied');
  assert.equal(await h.fetch(url.replace('.memory', '%2Ememory')), 'denied');
});

test('whole-account tokens issued before the fix are no longer accepted', async (t) => {
  const h = harness(); t.after(h.cleanup);
  // 按旧代码的格式手工签一个 dir 为 . 的链接（sign 在 vm 的全局里，用 vm 里的 Function 取出来）
  const legacy = (dir) => Buffer.from('alice\n' + dir).toString('base64url') + '.' + (Date.now() + 864e5);
  const ctxSign = h.api.signedUrl.constructor('return sign')();
  for (const dir of ['.', '']) {
    const payload = legacy(dir);
    const token = payload + '.' + ctxSign('f:' + payload).slice(0, 24);
    assert.equal(h.api.checkSigned(token, 'notes.txt'), null, JSON.stringify(dir));
    assert.equal(await h.fetch(`/f/${token}/notes.txt`), 'denied', JSON.stringify(dir));
  }
});
