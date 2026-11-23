'use strict';
// 全部为内存 fs / HTTP / Cloudflare binding 模拟，不连接线上、不发邮件。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const { notify, retryPending, normalize, identity } = require(path.join(root, 'tools/maintenance-notify.cjs'));
const workerModule = import(pathToFileURL(path.join(root, 'maintenance-mail-worker/worker.mjs')).href);
const DUMMY_SECRET = 'dummy_test_only_not_an_account_secret_0000';
const event = (extra = {}) => ({ type: 'upgrade-failed', program: 'claude', version: '2.1.999',
  reason: 'acceptance-failed', ...extra });
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

function memoryFs() {
  const files = new Map();
  return {
    files, async mkdir() {},
    async readFile(file) { if (!files.has(file)) throw missing(); return files.get(file); },
    async writeFile(file, value, options) {
      if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error(), { code: 'EEXIST' });
      files.set(file, value);
    },
    async rename(source, destination) {
      if (!files.has(source)) throw missing();
      files.set(destination, files.get(source)); files.delete(source);
    },
    async unlink(file) { files.delete(file); },
    async readdir(dir) { return [...files.keys()].filter(file => path.dirname(file) === dir).map(file => path.basename(file)); },
  };
}
function fixture() {
  let now = Date.now();
  const fs = memoryFs(), calls = [];
  const options = {
    fs, clock: () => now, env: { TEST_MAIL_SECRET: DUMMY_SECRET },
    config: { enabled: true, endpoint: 'https://mail.example.invalid/notify', secretEnv: 'TEST_MAIL_SECRET',
      stateDir: path.resolve(root, 'data/test-mail-never-written'), retryMs: 60000 },
    transport: async value => { calls.push(structuredClone(value)); return { ok: true }; },
  };
  return { fs, calls, options, advance: amount => { now += amount; } };
}
async function workerFixture(over = {}) {
  const { default: worker, MaintenanceMailGate } = await workerModule;
  let now = Date.now();
  const store = new Map(), sent = [];
  const storage = {
    async get(key) { return structuredClone(store.get(key)); },
    async put(key, value) { store.set(key, structuredClone(value)); },
  };
  const env = {
    NOTIFY_SECRET: DUMMY_SECRET, MAIL_FROM: 'relay@example.invalid', MAIL_TO: 'owner@example.invalid',
    EMAIL: { async send(message) { sent.push(structuredClone(message)); return { messageId: 'mock-id' }; } },
    ...over,
  };
  const state = { storage };
  let gate = new MaintenanceMailGate(state, env, { clock: () => now });
  env.MAIL_GATE = { idFromName: name => name, get: () => gate };
  const payload = (extra = {}) => normalize(event(extra), now);
  const request = (body = payload(), options = {}) => new Request('https://mail.example.invalid/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + DUMMY_SECRET },
    body: JSON.stringify(body), ...options,
  });
  return { worker, env, sent, store, storage, request, payload, gate: () => gate,
    restart: () => { gate = new MaintenanceMailGate(state, env, { clock: () => now }); },
    advance: amount => { now += amount; } };
}

test('M11 默认关闭且无文件、网络副作用', async () => {
  const throwOnUse = new Proxy({}, { get() { throw new Error('unexpected side effect'); } });
  assert.deepEqual(await notify(event(), { fs: throwOnUse, transport: throwOnUse }), { status: 'disabled' });
  assert.deepEqual(await retryPending({ fs: throwOnUse }), { status: 'disabled', results: [] });
});

test('M11 只接受三类事件、固定原因和安全配置', async () => {
  const f = fixture();
  for (const extra of [{ type: 'conversation' }, { reason: 'raw secret log' }, { version: '2.1.1\nsecret' },
    { program: 'anything' }, { issueFingerprint: 'private text' },
    { version: { toString: () => '2.1.999', privateContent: 'must-not-send' } }]) {
    assert.equal((await notify(event(extra), f.options)).status, 'ignored');
  }
  for (const endpoint of ['http://mail.example.invalid/notify', 'https://a:b@example.invalid/notify',
    'https://mail.example.invalid/notify?token=oops', 'https://mail.example.invalid/other']) {
    assert.equal((await notify(event(), { ...f.options, config: { ...f.options.config, endpoint } })).status, 'config-error');
  }
  assert.equal((await notify(event(), { ...f.options, env: {} })).status, 'config-error');
  assert.equal(f.calls.length, 0);
  assert.equal(f.fs.files.size, 0);
});

test('M11 仅序列化白名单字段，成功后持久去重，不保存密钥', async () => {
  const f = fixture();
  const result = await notify(event({ error: 'raw-password-dialogue', token: 'raw-api-token' }), f.options);
  assert.equal(result.status, 'sent');
  f.advance(86400000);
  assert.equal((await notify(event(), f.options)).status, 'duplicate');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0].payload).sort(),
    ['issueFingerprint', 'occurredAt', 'program', 'reason', 'schema', 'type', 'version']);
  const stored = [...f.fs.files.values()].join('');
  assert.ok(!stored.includes(DUMMY_SECRET));
  assert.ok(!stored.includes('raw-password-dialogue'));
  assert.ok(!stored.includes('raw-api-token'));
});

test('M11 同一进程并发不重复发送；不同问题独立发送', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => notify(event(), f.options)));
  assert.equal(results.filter(value => value.status === 'sent').length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal((await notify(event({ issueFingerprint: 'a'.repeat(64) }), f.options)).status, 'sent');
  assert.equal(f.calls.length, 2);
});

test('M11 失败留下待发记录，限速后重试成功，不记录异常原文', async () => {
  const f = fixture();
  f.options.transport = async () => { throw new Error('sensitive response'); };
  assert.equal((await notify(event(), f.options)).status, 'pending');
  assert.equal((await notify(event(), f.options)).status, 'deferred');
  assert.equal((await retryPending(f.options)).results[0].status, 'deferred');
  f.advance(60001);
  f.options.transport = async value => { f.calls.push(value); return { ok: true }; };
  assert.equal((await retryPending(f.options)).results[0].status, 'sent');
  assert.equal((await retryPending(f.options)).results.length, 0);
  assert.equal(f.calls.length, 1);
  assert.ok(![...f.fs.files.values()].join('').includes('sensitive response'));
});

test('M11 写状态失败先停止，不冒险发送；损坏或注入状态也拒绝', async () => {
  const f = fixture();
  const options = { ...f.options, fs: { ...f.fs, writeFile: async () => { throw new Error('disk'); } } };
  assert.equal((await notify(event(), options)).status, 'state-error');
  assert.equal(f.calls.length, 0);
  f.options.transport = async () => ({ ok: false });
  await notify(event(), f.options);
  const file = [...f.fs.files.keys()][0], record = JSON.parse(f.fs.files.get(file));
  record.payload.log = 'untrusted secret file contents';
  f.fs.files.set(file, JSON.stringify(record));
  f.advance(60001);
  assert.equal((await retryPending(f.options)).results[0].status, 'state-error');
  assert.equal(f.calls.length, 0);
});

test('M11 HTTP 仅用HTTPS POST、不跟随重定向、只承认专用成功响应（模拟fetch）', async () => {
  const f = fixture(), original = global.fetch;
  delete f.options.transport;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true, status: 'sent' }), { status: 200 });
  };
  try {
    assert.equal((await notify(event(), f.options)).status, 'sent');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[0].options.headers.authorization, 'Bearer ' + DUMMY_SECRET);
    global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    assert.equal((await notify(event({ version: '2.1.998' }), f.options)).status, 'pending');
  } finally { global.fetch = original; }
});

test('M11 Worker 方法、鉴权、内容类型拒绝且不会发信', async () => {
  const f = await workerFixture();
  for (const [request, status] of [
    [new Request('https://mail.example.invalid/notify'), 405],
    [f.request(f.payload(), { headers: { 'content-type': 'application/json' } }), 401],
    [f.request(f.payload(), { headers: { 'content-type': 'text/plain', authorization: 'Bearer ' + DUMMY_SECRET } }), 415],
    [new Request('https://mail.example.invalid/other', { method: 'POST' }), 404],
  ]) assert.equal((await f.worker.fetch(request, f.env)).status, status);
  assert.equal(f.sent.length, 0);
});

test('M11 Worker 拒绝任意收件人、原始日志、伪造类别和未来时间', async () => {
  const f = await workerFixture();
  const invalid = [
    { ...f.payload(), to: 'attacker@example.invalid' },
    { ...f.payload(), log: 'raw dialogue' },
    { ...f.payload(), type: 'marketing' },
    { ...f.payload(), reason: 'arbitrary contents' },
    { ...f.payload(), occurredAt: new Date(Date.now() + 86400000).toISOString() },
    { ...f.payload(), occurredAt: '2026-11-01' },
    { ...f.payload(), schema: 2 },
  ];
  for (const payload of invalid) assert.equal((await f.worker.fetch(f.request(payload), f.env)).status, 400);
  assert.equal(f.sent.length, 0);
});

test('M11 Worker 限制真实请求体大小，不能靠省略Content-Length绕过', async () => {
  const f = await workerFixture();
  const request = f.request(null, { body: ' '.repeat(3000) });
  assert.equal((await f.worker.fetch(request, f.env)).status, 413);
  const declared = f.request(f.payload(), { headers: {
    'content-type': 'application/json', authorization: 'Bearer ' + DUMMY_SECRET, 'content-length': '999999',
  } });
  assert.equal((await f.worker.fetch(declared, f.env)).status, 413);
  assert.equal(f.sent.length, 0);
});

test('M11 Worker 固定发件人、收件人和纯文本模板，按官方结构化send接口调用', async () => {
  const f = await workerFixture();
  const response = await f.worker.fetch(f.request(), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, status: 'sent' });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['from', 'subject', 'text', 'to']);
  assert.equal(f.sent[0].to, 'owner@example.invalid');
  assert.equal(f.sent[0].from, 'relay@example.invalid');
  assert.match(f.sent[0].text, /候选验收失败/);
  assert.ok(!JSON.stringify(f.sent[0]).includes(DUMMY_SECRET));
});

test('M11 Worker 并发请求、对象重建和时间变化均持久去重', async () => {
  const f = await workerFixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.gate().fetch(f.request())));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.sent.length, 1);
  f.restart(); f.advance(86400000);
  assert.equal((await f.gate().fetch(f.request())).status, 200);
  assert.equal(f.sent.length, 1);
});

test('M11 Worker 发送失败保留待重试且限速，失败内容不会进入响应或状态', async () => {
  const f = await workerFixture({ EMAIL: { send: async () => { throw new Error('secret from provider'); } } });
  const first = await f.gate().fetch(f.request());
  assert.equal(first.status, 503);
  assert.ok(!(await first.text()).includes('secret from provider'));
  assert.equal((await f.gate().fetch(f.request())).status, 429);
  f.advance(300001);
  f.env.EMAIL = { send: async value => { f.sent.push(value); } };
  assert.equal((await f.gate().fetch(f.request())).status, 200);
  assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify([...f.store]).includes('secret from provider'));
});

test('M11 Worker 不同问题共享一分钟限速，去重记录容量满后停止发送', async () => {
  const f = await workerFixture();
  assert.equal((await f.gate().fetch(f.request())).status, 200);
  const other = f.payload({ version: '2.1.998' });
  assert.equal((await f.gate().fetch(f.request(other))).status, 429);
  f.advance(60001);
  assert.equal((await f.gate().fetch(f.request(other))).status, 200);
  const issues = {};
  for (let i = 0; i < 512; i++) issues[i.toString(16).padStart(64, '0')] = { status: 'sent', sentAt: 1 };
  f.store.set('ledger', { issues, nextAttemptAt: 0 });
  assert.equal((await f.gate().fetch(f.request(f.payload({ version: '2.1.997' })))).status, 503);
  assert.equal(f.sent.length, 2);
});

test('M11 Worker 存储不可用或未配置时不发送；本机与Worker使用同一指纹算法', async () => {
  const f = await workerFixture();
  f.storage.put = async () => { throw new Error('storage failure'); };
  assert.equal((await f.gate().fetch(f.request())).status, 503);
  assert.equal(f.sent.length, 0);
  const noConfig = { ...f.env, NOTIFY_SECRET: '' };
  assert.equal((await f.worker.fetch(f.request(), noConfig)).status, 503);
  const { issueId } = await workerModule;
  assert.equal(await issueId(f.payload()), identity(f.payload()));
});

test('A3 发信超时留足 30 秒（实测约 7 秒，原来 10 秒太紧），预算不够一次发信就不再尝试', async () => {
  const f = fixture(), original = global.fetch, originalTimeout = AbortSignal.timeout;
  delete f.options.transport;
  const asked = [];
  AbortSignal.timeout = ms => { asked.push(ms); return originalTimeout.call(AbortSignal, ms); };
  global.fetch = async () => new Response(JSON.stringify({ ok: true, status: 'sent' }), { status: 200 });
  try {
    assert.equal((await notify(event(), f.options)).status, 'sent');
    assert.deepEqual(asked, [30000]);
  } finally { global.fetch = original; AbortSignal.timeout = originalTimeout; }
  const g = fixture(); g.options.transport = async () => ({ ok: false });
  await notify(event(), g.options);
  let sends = 0; g.options.transport = async () => { sends++; return { ok: true }; };
  g.options.remainingBudget = () => 20000;
  await retryPending({ ...g.options, clock: () => Date.now() + 3600e3 });
  assert.equal(sends, 0, '剩余 20 秒不够一次 30 秒的发信');
  g.options.remainingBudget = () => 60000;
  await retryPending({ ...g.options, clock: () => Date.now() + 3600e3 });
  assert.equal(sends, 1);
});
