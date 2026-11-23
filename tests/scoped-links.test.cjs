const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const links = require(path.join(root, 'public/scoped-links.js'));
const verify = require(path.join(root, 'url-capability.js'));
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pageShellSource = fs.readFileSync(path.join(root, 'tools/page-shell.cjs'), 'utf8');
const { createDrain, taskRequest } = require(path.join(root, 'tools/maintenance-drain.cjs'));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const browser = vm.createContext({ window: {}, URL, Date, Map, ArrayBuffer, Uint8Array });
vm.runInContext(fs.readFileSync(path.join(root, 'public/vendor/sha256-0.11.1.js'), 'utf8'), browser);
const hmac = (k, m) => browser.window.sha256.hmac(k, m);
const origin = 'https://relay.test';
let clock = 1700000000000;
const users = new Map([['one', { id: 'one', workDir: 'C:\\test\\one', password: 'a' }], ['two', { id: 'two', workDir: 'C:\\test\\two', password: 'b' }]]);
const tokenFor = (u) => u.id + '.' + crypto.createHmac('sha256', 'test-only-server-secret').update(u.password).digest('hex');
const user = users.get('one');
const signer = () => links.create({ origin, token: () => tokenFor(user), enabled: () => true, now: () => clock, hmac });
const request = (input, method = 'GET') => { const req = { method }; const url = new URL(input, origin); return { user: verify(req, url, users, tokenFor, clock), req, url }; };
const change = (input, key, value) => { const u = new URL(input, origin); u.searchParams.set(key, value); return u.href; };

test('browser HMAC agrees with Node including Unicode and long keys', () => {
  for (const key of ['key', tokenFor(user), 'k'.repeat(200), '中文密钥🔑']) {
    for (const msg of ['', 'abc', '中文 空格 + % # 😀', 'x'.repeat(1000)]) {
      assert.equal(hmac(key, msg), crypto.createHmac('sha256', key).update(msg).digest('hex'));
    }
  }
});
test('file links contain no account bearer and authorize only the signed file/flags', () => {
  const sign = signer();
  for (const name of ['outputs/a.html', '中文 空格+%#😀.pdf', 'a%2Fb.txt', 'sub\\a.txt']) {
    const url = sign.sign('/api/file?path=' + encodeURIComponent(name) + '&raw=1');
    assert.ok(!url.includes(tokenFor(user)) && !new URL(url, origin).searchParams.has('rt'));
    assert.equal(request(url).user, user);
    assert.equal(request(change(url, 'path', 'other.txt')).user, null);
    assert.equal(request(change(url, 'raw', '0')).user, null);
    assert.equal(request(change(url, 'download', '1')).user, null);
    assert.equal(request(url, 'POST').user, null);
    for (const endpoint of ['/api/state', '/api/sign', '/api/chat', '/api/upload', '/api/resume', '/api/events', '/api/preview']) {
      const moved = new URL(url, origin); moved.pathname = endpoint;
      assert.equal(request(moved).user, null, endpoint);
    }
  }
});
test('preview and SSE tickets are separate, expire, and invalidate after password change', () => {
  const sign = signer();
  const preview = sign.sign('/api/preview?path=presentation.pptx');
  const events = sign.sign('/api/events');
  assert.equal(request(preview).user, user);
  assert.equal(request(events).user, user);
  const u = new URL(events, origin); u.pathname = '/api/file'; u.searchParams.set('path', 'secret.txt');
  assert.equal(request(u).user, null);
  const saved = clock; clock += links.TTL;
  assert.equal(request(preview).user, null); assert.equal(request(events).user, null);
  clock = saved;
  user.password = 'changed'; assert.equal(request(preview).user, null); user.password = 'a';
});
test('tampered identity, expiry, MAC and duplicate selectors fail closed', () => {
  const signed = signer().sign('/api/file?path=a.txt');
  const parsed = JSON.parse(new URL(signed, origin).searchParams.get('cap'));
  for (const cap of [[...parsed, 'extra'], ['two', parsed[1], parsed[2]], [parsed[0], 'Infinity', parsed[2]], [parsed[0], parsed[1] + 1, parsed[2]], [parsed[0], clock + links.TTL * 2, parsed[2]], [parsed[0], parsed[1], '0'.repeat(64)]]) {
    assert.equal(request(change(signed, 'cap', JSON.stringify(cap))).user, null);
  }
  for (const key of ['cap', 'path', 'raw', 'download']) {
    const u = new URL(signed, origin);
    if (!u.searchParams.has(key)) u.searchParams.append(key, '0');
    u.searchParams.append(key, 'anything');
    assert.equal(request(u).user, null);
  }
  assert.equal(request(change(signed, 'cap', '{')).user, null);
});
test('URLs stay stable during rendering and renew stale anchors/resources', () => {
  const sign = signer(); const first = sign.sign('/api/file?path=a.pdf&download=1');
  assert.equal(sign.sign('/api/file?path=a.pdf&download=1'), first);
  const attrs = { href: first }; const el = { getAttribute: (k) => attrs[k], setAttribute: (k, v) => attrs[k] = v };
  assert.equal(sign.renewElement(el, 'href'), false);
  const saved = clock; clock += links.TTL + 1;
  assert.equal(sign.renewElement(el, 'href'), true);
  assert.equal(request(attrs.href).user, user); assert.notEqual(attrs.href, first);
  attrs.src = first; assert.equal(sign.renewElement(el, 'src'), true); assert.equal(request(attrs.src).user, user);
  clock = saved;
  assert.equal(sign.sign('https://other.test/api/file?path=a'), 'https://other.test/api/file?path=a');
});

function functionText(name, next) { return source.slice(source.indexOf('function ' + name + '('), source.indexOf(next, source.indexOf('function ' + name + '('))); }
function harness() {
  const timers = [], clients = new Map(), maintenanceDrain = createDrain(), requestDone = Symbol('test-request-done');
  const context = vm.createContext({ URL, Buffer, crypto, config: {}, isolationBlocked: null, freshEnoughSnap: async () => {}, Date: class extends Date { static now() { return clock; } },
    USERS: users, userToken: tokenFor, legacyToken: () => 'legacy-test-token', capabilityUser: (req, url, us, tf) => verify(req, url, us, tf, clock),
    setTimeout: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.cleared = true; },
    lastActivity: 0, updateKeepAwake() {}, clients, runningIds: () => [], shortUA: () => 'test', console: { log() {} },
    maintenanceDrain, taskRequest, MAINTENANCE_REQUEST_DONE: requestDone, DRAIN_MESSAGE: '维护中',
    fs: { existsSync: () => true, statSync: () => ({ isFile: () => true }) },
    resolveIn: (u, rel) => u.workDir + '/' + rel,
    serveWorkFile: (res, abs, options) => { res.file = { abs, options }; res.code = 200; },
    sendJSON: (res, code, body) => { res.code = code; res.body = body; },
  });
  for (const [name, next] of [['parseCookies', 'function safeEqual'], ['safeEqual', '// 返回当前'], ['reqToken', 'function authUser'], ['authUser', '// 日志里']]) vm.runInContext(functionText(name, next), context);
  vm.runInContext(functionText('admitMaintenanceTask', 'async function handle('), context);
  vm.runInContext(source.slice(source.indexOf('async function handle('), source.indexOf('const server = http.createServer')), context);
  return { context, timers, clients, async call(url, headers = {}, method = 'GET') {
    const req = { url, headers, method, on: (event, cb) => { req[event] = cb; } };
    const res = Object.assign(new EventEmitter(), { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); }, write() {}, end() { this.ended = true; this.writableFinished = true; this.emit('finish'); } });
    try { await context.handle(req, res); } finally { req[requestDone]?.(); }
    return { req, res };
  } };
}
test('actual HTTP handler rejects legacy URL bearer and cap reuse, keeps cookie/header access', async () => {
  const h = harness(); const signed = signer().sign('/api/file?path=a.html');
  let r = await h.call(signed); assert.equal(r.res.code, 200); assert.match(r.res.file.abs, /a.html$/);
  r = await h.call('/api/file?path=a.html&rt=' + encodeURIComponent(tokenFor(user))); assert.equal(r.res.code, 401);
  r = await h.call('/api/file?path=a.html', { 'x-relay-token': tokenFor(user) }); assert.equal(r.res.code, 200);
  r = await h.call('/api/file?path=a.html', { cookie: 'relay_token=' + tokenFor(user) }); assert.equal(r.res.code, 200);
  for (const endpoint of ['/api/state', '/api/sign', '/api/chat']) {
    const u = new URL(signed, origin); u.pathname = endpoint;
    r = await h.call(u.pathname + u.search); assert.equal(r.res.code, 401);
  }
});
test('actual SSE route expires capability sessions and removes connected client', async () => {
  const h = harness(); const r = await h.call(signer().sign('/api/events'));
  assert.equal(r.res.code, 200); assert.equal(h.clients.size, 1);
  assert.equal(h.timers[0].delay, links.TTL);
  h.timers[0].fn(); assert.equal(r.res.ended, true); assert.equal(h.clients.size, 0);
  r.req.close(); assert.equal(h.timers[0].cleared, true);
});
test('client compiles, renews SSE before expiry, and cancels renewal on login', () => {
  new vm.Script(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')));
  assert.match(html, /clearTimeout\(esRenewTimer\)/);
  assert.match(html, /expires - Date\.now\(\) - S\.skew - 30e3/);
  assert.doesNotMatch(html, /authQS|['"]rt=['"]|\?rt=/);
});

test('long-lived pages can discover a new version', () => {
  assert.equal(html.split('__PAGE_BUILD__').length - 1, 1); // 服务器只替换第一处，页面里只能有这一处
  assert.match(html, /const PAGE_BUILD = '__PAGE_BUILD__'/);
  assert.match(html, /!cached && s\.pageBuild && .*s\.pageBuild !== PAGE_BUILD/);
  // 页面替换与依赖指纹已归入异步外壳；服务的首页和状态必须读取同一个入口。
  assert.match(pageShellSource, /raw\.replace\('__PAGE_BUILD__',\s*build\)/);
  assert.match(source, /const \{ createPageShell \} = require\('\.\/tools\/page-shell\.cjs'\)/);
  assert.match(source, /async function pageHtml\(\) \{ return pageShell\.get\(\); \}/);
  assert.match(source, /const page = await pageHtml\(\)/);
  assert.match(source, /pageBuild: \(await pageHtml\(\)\)\.build/);
});
