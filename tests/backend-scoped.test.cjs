'use strict';
// Only extracts the reviewed helpers into isolated contexts; never starts server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const source = fs.readFileSync(path.join(process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..'), 'server.js'), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source markers: ${start}`);
  return source.slice(a, b);
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const workspacePath = require('../workspace-path');
const { createDrain } = require('../tools/maintenance-drain.cjs');

function uploadHarness(root, clock) {
  const context = vm.createContext({
    fs, path, ROOT: root, Buffer, config: {}, console: { log() {} },
    maintenanceDrain: createDrain({ now: () => clock.now }),
    Date: class extends Date { static now() { return clock.now; } },
    setInterval() {}, warmPreviews() {},
    resolveIn: (u, rel) => workspacePath(u.workDir, rel),
    toRel: (u, abs) => path.relative(u.workDir, abs).split(path.sep).join('/'),
    validId: (id) => /^[a-f0-9]{16}$/.test(id || ''),
    sendJSON: (res, code, body) => { res.code = code; res.body = plain(body); },
  });
  const route = between("  if (p === '/api/upload-part') {", "  if (p === '/api/upload' &&");
  vm.runInContext(
    between('function writeFileSafe(', 'function sendJSON(') +
    between('function readBody(', '// ---------- 上传 ----------') +
    between('// ---------- 上传 ----------', 'const readJSON =') +
    `\nasync function route(req, res, u, url) { const p = '/api/upload-part'; ${route} }\n` +
    'globalThis.api = { route, partPath, partReceiptPath, readPartReceipt, cleanPartReceipts, PART_RECEIPT_TTL };', context);
  return context.api;
}

function request(api, user, id, method, offset = 0) {
  const req = new PassThrough(); req.method = method; req.complete = true;
  const res = {};
  const url = new URL(`http://test/api/upload-part?id=${id}&offset=${offset}`);
  return { req, res, done: api.route(req, res, user, url) };
}

test('upload receipts: lost final response, retries, ownership, concurrency and expiry', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '.backend-test-'));
  try {
    const clock = { now: 1700000000000 };
    let api = uploadHarness(root, clock);
    const alice = { id: 'alice', workDir: path.join(root, 'alice') };
    const bob = { id: 'bob', workDir: path.join(root, 'bob') };
    fs.mkdirSync(alice.workDir, { recursive: true });
    fs.mkdirSync(bob.workDir, { recursive: true });
    fs.mkdirSync(path.dirname(api.partPath('x')), { recursive: true });
    const id = 'a'.repeat(16), dir = path.join(alice.workDir, 'uploads');
    fs.writeFileSync(api.partPath(id), '');
    fs.writeFileSync(api.partPath(id) + '.json', JSON.stringify({ user: alice.id, dir, name: 'sample.txt', size: 6, createdAt: clock.now }));

    const first = request(api, alice, id, 'PUT', 0); first.req.end('abc'); await first.done;
    assert.deepEqual(first.res, { code: 200, body: { received: 3 } });
    const inProgress = request(api, alice, id, 'GET'); await inProgress.done;
    assert.deepEqual(inProgress.res, { code: 200, body: { received: 3, size: 6 } });
    const wrongOffset = request(api, alice, id, 'PUT', 0); wrongOffset.req.end('abc'); await wrongOffset.done;
    assert.deepEqual(wrongOffset.res, { code: 409, body: { received: 3 } });
    const wrongOwnerBefore = request(api, bob, id, 'PUT', 3); wrongOwnerBefore.req.end('def'); await wrongOwnerBefore.done;
    assert.equal(wrongOwnerBefore.res.code, 404);

    // The first final request is in flight when its retry arrives.
    const final = request(api, alice, id, 'PUT', 3);
    const parallelRetry = request(api, alice, id, 'PUT', 3); parallelRetry.req.end('def');
    final.req.end('def'); await Promise.all([final.done, parallelRetry.done]);
    const expected = { received: 6, done: true, path: 'uploads/sample.txt', name: 'sample.txt', size: 6 };
    assert.deepEqual(final.res, { code: 200, body: expected });
    assert.deepEqual(parallelRetry.res, final.res);
    assert.equal(fs.readFileSync(path.join(dir, 'sample.txt'), 'utf8'), 'abcdef');
    assert.deepEqual(fs.readdirSync(dir), ['sample.txt']);

    // Discard the first response and create a new context, as after a restart.
    api = uploadHarness(root, clock);
    for (const method of ['GET', 'PUT']) {
      const retry = request(api, alice, id, method, 3); retry.req.end('def'); await retry.done;
      assert.deepEqual(retry.res, { code: 200, body: expected });
      const denied = request(api, bob, id, method, 3); denied.req.end('def'); await denied.done;
      assert.equal(denied.res.code, 404);
      assert.ok(!JSON.stringify(denied.res.body).includes('sample.txt'));
    }
    assert.deepEqual(fs.readdirSync(dir), ['sample.txt']);
    clock.now += api.PART_RECEIPT_TTL - 1;
    assert.ok(api.readPartReceipt(id));
    clock.now += 1;
    const expired = request(api, alice, id, 'GET'); await expired.done;
    assert.equal(expired.res.code, 404);
    const expiredPut = request(api, alice, id, 'PUT', 3); expiredPut.req.end('def'); await expiredPut.done;
    assert.equal(expiredPut.res.code, 404);
    assert.equal(fs.existsSync(api.partReceiptPath(id)), false);
    assert.equal(fs.readFileSync(path.join(dir, 'sample.txt'), 'utf8'), 'abcdef');

    const expiredId = 'b'.repeat(16), validId = 'c'.repeat(16);
    fs.writeFileSync(api.partReceiptPath(expiredId), JSON.stringify({ user: 'alice', completedAt: clock.now - api.PART_RECEIPT_TTL, result: expected }));
    fs.writeFileSync(api.partReceiptPath(validId), JSON.stringify({ user: 'alice', completedAt: clock.now, result: expected }));
    api.cleanPartReceipts();
    assert.equal(fs.existsSync(api.partReceiptPath(expiredId)), false);
    assert.equal(fs.existsSync(api.partReceiptPath(validId)), true);

    const partialId = 'd'.repeat(16);
    fs.writeFileSync(api.partPath(partialId), '');
    fs.writeFileSync(api.partPath(partialId) + '.json', JSON.stringify({ user: alice.id, dir, name: 'partial.txt', size: 6, createdAt: clock.now }));
    const pendingPart = request(api, alice, partialId, 'PUT', 0);
    const concurrentPart = request(api, alice, partialId, 'PUT', 0); concurrentPart.req.end('abc');
    pendingPart.req.end('abc'); await Promise.all([pendingPart.done, concurrentPart.done]);
    assert.deepEqual(pendingPart.res, { code: 200, body: { received: 3 } });
    assert.deepEqual(concurrentPart.res, { code: 409, body: { received: 3 } });
    assert.equal(fs.readFileSync(api.partPath(partialId), 'utf8'), 'abc');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.backend-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.kill = () => {};
  return child;
}
function processContext(child, extras = {}) {
  return vm.createContext({
    spawn: () => child, config: { claudePath: 'test', titleModel: 'test' }, isolationBlocked: null,
    os: { tmpdir: () => 'test' }, path, ROOT: 'test', VENV_PY: 'test', TOOL_ENV: {}, QUICK_ARGS: [],
    process: { env: {} }, maintenanceDrain: createDrain(),
    setTimeout: () => 1, clearTimeout() {}, Date, ...extras,
  });
}

test('UTF-8 survives every byte boundary including prewarm buffers and stderr', async () => {
  const text = '中文测试😀 café 日本語';
  const bytes = Buffer.from(text);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const child = fakeChild();
    const ctx = processContext(child, { USERS: new Map([['u', { workDir: 'test' }]]), claudeArgs: () => [], promptVersion: () => '' });
    vm.runInContext(between('function launchClaude(', 'const warmPool =') + '\nglobalThis.proc = launchClaude("u|new|m|e|");', ctx);
    child.stdout.write(bytes.subarray(0, cut)); child.stderr.write(bytes.subarray(0, cut));
    let out = '', err = '';
    ctx.proc.attach((part) => { assert.equal(typeof part, 'string'); out += part; }, (part) => { err += part; });
    child.stdout.end(bytes.subarray(cut)); child.stderr.end(bytes.subarray(cut));
    assert.equal(out, text, `stdout cut ${cut}`); assert.equal(err, text, `stderr cut ${cut}`);
  }
});

test('voice, quick-task and usage readers preserve split UTF-8 output', async () => {
  const text = '识别与标题😀 café';
  const line = Buffer.from(JSON.stringify({ id: 1, text, type: 'result', result: text }) + '\n');
  for (let cut = 0; cut <= line.length; cut++) {
    const voiceChild = fakeChild(), voiceCtx = processContext(voiceChild);
    vm.runInContext('let voiceProc = null, voiceSeq = 0, voiceIdle = null; const voiceWaiters = new Map();\n' + between('function voice(', '// 朗读前') + '\nglobalThis.pending = voice({op:"stt"});', voiceCtx);
    voiceChild.stdout.write(line.subarray(0, cut)); voiceChild.stdout.end(line.subarray(cut));
    assert.equal((await voiceCtx.pending).text, text);

    const quickChild = fakeChild(), quickCtx = processContext(quickChild);
    vm.runInContext(between('function spawnQuick(', 'function killQuick(') + '\nglobalThis.child = spawnQuick();', quickCtx);
    quickChild.stdout.write(line.subarray(0, cut)); quickChild.stdout.end(line.subarray(cut)); quickChild.emit('close', 0);
    assert.equal(await quickCtx.child.result, text);

    let decoded;
    const usageChild = fakeChild(), usageCtx = processContext(usageChild, { usage: { windows: {} }, parseUsageText: (output) => { decoded = output; return {}; }, saveUsage() {} });
    vm.runInContext('let usageFetching = null;\n' + between('function fetchUsage(', '// 回复过程中收到') + '\nglobalThis.pending = fetchUsage();', usageCtx);
    usageChild.stdout.write(line.subarray(0, cut)); usageChild.stdout.end(line.subarray(cut)); usageChild.emit('close', 0);
    await usageCtx.pending;
    assert.equal(decoded, line.toString('utf8'));
  }
});

test('message and speech log entries include metadata, never original text or title', () => {
  const secret = 'UNIQUE_PRIVATE_CONTENT_秘密';
  const lines = source.split(/\r?\n/);
  const snippets = [lines.find((s) => s.includes('console.log(`\\n[') && s.includes('新消息')), lines.find((s) => s.includes('console.log(`[语音输入]'))];
  assert.ok(snippets.every(Boolean));
  const logs = [];
  vm.runInNewContext(snippets.join('\n'), { console: { log: (s) => logs.push(s) }, Date, u: { id: 'u' }, conv: { id: 'c', title: secret }, userMsg: { text: secret, model: 'm', effort: 'high' }, text: secret, size: 2048, t0: Date.now() });
  assert.equal(logs.length, 2);
  for (const log of logs) { assert.ok(!log.includes(secret)); assert.ok(log.includes(`${secret.length} 字符`)); }
});

test('usage refresh falls back to the rate-limit event when /usage has no percentages', async () => {
  const run = (out, options) => {
    const usageChild = fakeChild(), probes = [];
    const ctx = processContext(usageChild, { usage: { windows: {}, updatedAt: 0 }, parseUsageText: () => ({}), saveUsage() {}, idleMs: () => 0,
      spawnQuick: () => { const child = fakeChild(); child.result = Promise.resolve(''); probes.push(child); return child; }, killQuick() {} });
    vm.runInContext('let usageFetching = null;\n' + between('function fetchUsage(', '// 回复过程中收到') + '\nglobalThis.pending = fetchUsage(' + options + ');', ctx);
    usageChild.stdout.end(out); usageChild.emit('close', 0);
    return ctx.pending.then(() => probes);
  };
  assert.equal((await run('statistics only', '{ probe: true }')).length, 1);
  assert.equal((await run('statistics only', '')).length, 0);
});

test('rate-limit events always refresh the update time and quick tasks report them', async () => {
  let saved = 0;
  const ctx = vm.createContext({ usage: { windows: { session: { pct: 43, resetsAt: 1000000 } } }, saveUsage: () => { saved++; } });
  vm.runInContext(between('function onRateLimitEvent(', '// 有网页开着时') + '\nglobalThis.on = onRateLimitEvent;', ctx);
  ctx.on({ unifiedWindows: { five_hour: { utilization: 0.43, resetsAt: 1000 }, seven_day: { utilization: 0.62, resetsAt: 2000 } } });
  assert.equal(saved, 1, '数字没变也要更新时间');
  assert.equal(ctx.usage.windows.week.pct, 62); assert.equal(ctx.usage.windows.session.resetsAt, 1000000);
  ctx.on({}); ctx.on({ unifiedWindows: {} });
  assert.equal(saved, 1, '没有额度数据时不算更新');

  const events = [], quickChild = fakeChild(), quickCtx = processContext(quickChild, { onRateLimitEvent: (info) => events.push(info) });
  vm.runInContext(between('function spawnQuick(', 'function killQuick(') + '\nglobalThis.child = spawnQuick();', quickCtx);
  quickChild.stdout.end(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { marker: 1 } }) + '\n' + JSON.stringify({ type: 'result', result: '好' }) + '\n');
  quickChild.emit('close', 0);
  assert.equal(await quickCtx.child.result, '好');
  assert.equal(events.length, 1); assert.equal(events[0].marker, 1);
});
