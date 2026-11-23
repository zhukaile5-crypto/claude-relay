'use strict';

// These checks load pure helpers and selected server functions only. They never
// start the relay, contact a model, or read production credentials/chat records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { PassThrough, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { setImmediate: nextTurn } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const receiveFile = require('../upload-stream');
const boundedJobs = require('../bounded-jobs');
const workspacePath = require('../workspace-path');
const capabilityUser = require('../url-capability');
const scopedLinks = require('../public/scoped-links');
const { createDrain, taskRequest } = require('../tools/maintenance-drain.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));

function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Source function boundary not found: ${start}`);
  return source.slice(a, b);
}
function declaration(name) {
  const line = source.split(/\r?\n/).find((text) => text.startsWith(`const ${name} =`));
  assert.ok(line, `Source declaration not found: ${name}`);
  return line;
}

function jobHarness() {
  const files = new Map(), jobs = new Map(), killed = [];
  const context = vm.createContext({
    fs: { existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p) },
    jobs, console, process: { platform: 'win32' },
    execFile: (exe, args) => killed.push({ exe, args }),
    convPath: (u, id) => `${u.id}/${id}`,
    validId: (id) => /^[a-f0-9]{16}$/.test(id || ''),
  });
  vm.runInContext(declaration('jobKey') + '\n' +
    between('function loadConv(', '// 对话列表') + '\n' +
    between('function stopJob(', '// ---------- 登录') + '\n' +
    'globalThis.api = { loadConv, stopJob, jobKey };', context);
  return { ...context.api, files, jobs, killed };
}
const sameId = '0123456789abcdef';
test('same conversation ID in two accounts does not hide a saved conversation', () => {
  const h = jobHarness(), alice = { id: 'alice' }, bob = { id: 'bob' };
  h.files.set(`alice/${sameId}`, JSON.stringify({ id: sameId, title: 'Alice saved' }));
  h.jobs.set(h.jobKey(bob, sameId), { user: bob, conv: { id: sameId, title: 'Bob running' } });
  assert.equal(h.loadConv(alice, sameId).title, 'Alice saved');
  assert.equal(h.loadConv(bob, sameId).title, 'Bob running');
});
test('two accounts can independently read and stop running jobs with the same ID', () => {
  const h = jobHarness(), alice = { id: 'alice' }, bob = { id: 'bob' };
  const a = { user: alice, conv: { id: sameId, title: 'Alice' }, child: { pid: 11 } };
  const b = { user: bob, conv: { id: sameId, title: 'Bob' }, child: { pid: 22 } };
  h.jobs.set(h.jobKey(alice, sameId), a); h.jobs.set(h.jobKey(bob, sameId), b);
  assert.strictEqual(h.loadConv(alice, sameId), a.conv);
  assert.strictEqual(h.loadConv(bob, sameId), b.conv);
  assert.equal(h.stopJob(alice, sameId), true);
  assert.equal(a.stopped, true); assert.equal(b.stopped, undefined);
  assert.deepEqual(plain(h.killed), [{ exe: 'taskkill', args: ['/pid', '11', '/T', '/F'] }]);
});
test('an account cannot stop the other account job when it has no matching job', () => {
  const h = jobHarness(), alice = { id: 'alice' }, bob = { id: 'bob' };
  h.jobs.set(h.jobKey(bob, sameId), { user: bob, child: { pid: 22 } });
  assert.equal(h.stopJob(alice, sameId), false);
  assert.equal(h.killed.length, 0);
});
test('compound job keys distinguish delimiters and invalid conversation IDs stay rejected', () => {
  const h = jobHarness();
  assert.notEqual(h.jobKey({ id: 'a:b' }, 'c'), h.jobKey({ id: 'a' }, 'b:c'));
  assert.equal(h.loadConv({ id: 'alice' }, '../../outside'), null);
});

function accountRouteHarness() {
  const alice = { id: 'alice', password: 'alice-fixture-password' }, bob = { id: 'bob', password: 'bob-fixture-password' };
  const effects = { bodyReads: 0, saves: [], broadcasts: 0, awake: 0, fileReads: 0 };
  const maintenanceDrain = createDrain(), requestDone = Symbol('test-request-done');
  const context = vm.createContext({
    URL, Buffer, crypto, console, config: { secret: 'fixture-secret-only' }, USERS: new Map([['alice', alice], ['bob', bob]]), capabilityUser,
    lastActivity: 0, updateKeepAwake: () => { effects.awake++; },
    maintenanceDrain, taskRequest, MAINTENANCE_REQUEST_DONE: requestDone, DRAIN_MESSAGE: '维护中',
    readJSON: async () => { effects.bodyReads++; return { model: 'sonnet', effort: 'high' }; },
    modelsFor: () => [{ id: 'sonnet' }], effortOk: () => true, loadPrefs: () => ({}),
    isolationBlocked: null, savePrefs: (user, prefs) => effects.saves.push({ user: user.id, prefs }), broadcast: () => { effects.broadcasts++; },
    resolveIn: () => { effects.fileReads++; return null; },
    sendJSON: (res, status, body) => ({ status, body }),
  });
  vm.runInContext(between('const sign =', '// 日志里简单标') + '\n' +
    between('function admitMaintenanceTask(', 'const server = http.createServer') + '\n' +
    'globalThis.api = { handle, userToken };', context);
  const run = async (headers, url = '/api/prefs', method = 'PUT') => {
    const req = { method, url, headers, socket: { remoteAddress: '127.0.0.1' } };
    const res = Object.assign(new EventEmitter(), { setHeader() {} });
    try { return await context.api.handle(req, res); }
    finally { res.emit('finish'); req[requestDone]?.(); }
  };
  return { ...context.api, run, effects, context, alice, bob, bobCookie: 'relay_token=' + context.api.userToken(bob) };
}
test('an old tab cannot mutate Bob when its fixed account header still identifies Alice', async () => {
  const h = accountRouteHarness();
  const result = await h.run({ cookie: h.bobCookie, 'x-relay-user': 'alice' });
  assert.equal(result.status, 409); assert.match(result.body.error, /账号.*切换.*刷新/);
  assert.deepEqual(h.effects, { bodyReads: 0, saves: [], broadcasts: 0, awake: 0, fileReads: 0 });
  assert.equal(h.context.lastActivity, 0);
});
test('matching cookie and fixed account header retain normal authenticated mutations', async () => {
  const h = accountRouteHarness();
  const result = await h.run({ cookie: h.bobCookie, 'x-relay-user': 'bob' });
  assert.equal(result.status, 200); assert.equal(h.effects.bodyReads, 1); assert.equal(h.effects.saves.length, 1);
  assert.equal(h.effects.saves[0].user, 'bob'); assert.equal(h.effects.awake, 1);
});
test('legacy clients without a fixed account header remain compatible', async () => {
  const h = accountRouteHarness();
  const result = await h.run({ cookie: h.bobCookie });
  assert.equal(result.status, 200); assert.equal(h.effects.saves[0].user, 'bob');
});
test('resource capability authentication also rejects a mismatched fixed account header before file access', async () => {
  const h = accountRouteHarness(), url = new URL('http://fixture/api/file?path=outputs/fixture.txt');
  const expires = Date.now() + 60000;
  const signature = crypto.createHmac('sha256', h.userToken(h.bob)).update(scopedLinks.message('bob', expires, scopedLinks.scope(url))).digest('hex');
  url.searchParams.set('cap', JSON.stringify(['bob', expires, signature]));
  const result = await h.run({ 'x-relay-user': 'alice' }, url.pathname + url.search, 'GET');
  assert.equal(result.status, 409);
  assert.deepEqual(h.effects, { bodyReads: 0, saves: [], broadcasts: 0, awake: 0, fileReads: 0 });
});

function historyHarness(existing = []) {
  const context = vm.createContext({
    fs: { existsSync: (file) => existing.includes(file) },
    sessionFile: (u, sid) => `${u.id}/${sid}`,
    providerOf: (model) => model?.startsWith('gpt') ? 'openai' : 'anthropic',
    modelName: (model) => model,
  });
  vm.runInContext(between('function resumeSession(', 'const CONTINUE_PROMPT') + '\n' +
    'globalThis.api = { resumeSession };', context);
  context.api.catchUp = (conv, provider, resumesInterrupted) => require('../tools/model-handoff.cjs').buildHandoff(conv, provider, { nonce: '0123456789abcdef', providerOf: context.providerOf, modelLabel: context.modelName, resumesInterrupted, excludeCurrent: true }).text;
  return context.api;
}
const userMessage = (text, extra = {}) => ({ role: 'user', text, ...extra });
const answer = (model, status, text, extra = {}) => ({ role: 'assistant', model, status, events: [{ k: 'text', text }], ...extra });
function appendContinuation(conv) {
  return { ...conv, messages: [...conv.messages, userMessage('继续', { cont: true }), answer('sonnet', 'running', '')] };
}
test('continuing a first Claude turn without a saved session includes the original task and attachment', () => {
  const h = historyHarness();
  const conv = { messages: [userMessage('请根据附件完成任务甲', { attachments: [{ path: 'uploads/source.docx' }] }), answer('sonnet', 'stopped', '已完成第一步', { sessionId: 'missing' })] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'sonnet');
  assert.deepEqual(plain(resumed), { sid: null, resumesInterrupted: false });
  const missed = h.catchUp(appendContinuation(conv), 'anthropic', resumed.resumesInterrupted);
  assert.match(missed, /任务甲/); assert.match(missed, /uploads\/source\.docx/); assert.match(missed, /已完成第一步/);
});
test('fallback to a previous Claude session sends only the missing interrupted task', () => {
  const h = historyHarness();
  const conv = { sessionId: 'previous', messages: [userMessage('旧任务'), answer('sonnet', 'done', '旧回答'), userMessage('中断的新任务'), answer('sonnet', 'error', '部分回答', { sessionId: 'missing' })] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'sonnet');
  assert.deepEqual(plain(resumed), { sid: 'previous', resumesInterrupted: false });
  const missed = h.catchUp(appendContinuation(conv), 'anthropic', resumed.resumesInterrupted);
  assert.match(missed, /中断的新任务/); assert.match(missed, /部分回答/); assert.doesNotMatch(missed, /旧任务|旧回答/);
});
test('a real interrupted Claude session does not duplicate its already saved task', () => {
  const h = historyHarness(['alice/interrupted']);
  const conv = { sessionId: 'previous', messages: [userMessage('任务乙'), answer('sonnet', 'stopped', '部分回答', { sessionId: 'interrupted' })] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'sonnet');
  assert.deepEqual(plain(resumed), { sid: 'interrupted', resumesInterrupted: true });
  assert.equal(h.catchUp(appendContinuation(conv), 'anthropic', resumed.resumesInterrupted), '');
});
test('switching provider after an interrupted answer preserves its task, answer and files', () => {
  const h = historyHarness();
  const conv = { sessionId: 'claude-previous', messages: [userMessage('Claude旧任务'), answer('sonnet', 'done', 'Claude旧答'), userMessage('改用GPT完成图表'), answer('gpt-test', 'error', '已整理数据', { files: [{ path: 'outputs/chart.csv' }] })] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'sonnet');
  const missed = h.catchUp(appendContinuation(conv), 'anthropic', resumed.resumesInterrupted);
  assert.equal(resumed.sid, 'claude-previous'); assert.equal(resumed.resumesInterrupted, false);
  assert.match(missed, /改用GPT完成图表/); assert.match(missed, /已整理数据/); assert.match(missed, /outputs\/chart\.csv/);
  assert.doesNotMatch(missed, /Claude旧任务/);
});
test('GPT without an interrupted thread falls back to its previous thread and preserves the missing task', () => {
  const h = historyHarness();
  const conv = { codexThreadId: 'previous', messages: [userMessage('GPT旧任务'), answer('gpt-test', 'done', 'GPT旧答'), userMessage('GPT新任务'), answer('gpt-test', 'stopped', '新任务部分结果')] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'gpt-test');
  assert.deepEqual(plain(resumed), { sid: 'previous', resumesInterrupted: false });
  const missed = h.catchUp(appendContinuation(conv), 'openai', resumed.resumesInterrupted);
  assert.match(missed, /GPT新任务/); assert.match(missed, /新任务部分结果/); assert.doesNotMatch(missed, /GPT旧任务|GPT旧答/);
});
test('continuing a first GPT turn without a saved thread includes its original task', () => {
  const h = historyHarness();
  const conv = { messages: [userMessage('GPT首轮任务'), answer('gpt-test', 'error', '未保存成功的部分结果')] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'gpt-test');
  assert.deepEqual(plain(resumed), { sid: null, resumesInterrupted: false });
  const missed = h.catchUp(appendContinuation(conv), 'openai', resumed.resumesInterrupted);
  assert.match(missed, /GPT首轮任务/); assert.match(missed, /未保存成功的部分结果/);
});
test('an interrupted GPT thread resumes without duplicating its saved task', () => {
  const h = historyHarness();
  const conv = { codexThreadId: 'previous', messages: [userMessage('GPT原任务'), answer('gpt-test', 'stopped', '部分回答', { threadId: 'interrupted' })] };
  const resumed = h.resumeSession({ id: 'alice' }, conv, 'gpt-test');
  assert.deepEqual(plain(resumed), { sid: 'interrupted', resumesInterrupted: true });
  assert.equal(h.catchUp(appendContinuation(conv), 'openai', true), '');
});
test('completed answers cannot be resumed as interrupted work and history is bounded', () => {
  const h = historyHarness();
  assert.equal(h.resumeSession({ id: 'alice' }, { messages: [answer('sonnet', 'done', '完成')] }, 'sonnet'), null);
  const conv = { messages: [userMessage('x'.repeat(20000)), answer('gpt-test', 'done', 'tail')] };
  const missed = h.catchUp(appendContinuation(conv), 'anthropic', false);
  assert.ok(missed.length <= 24000); assert.match(missed, /x{100}/); assert.match(missed, /省略/); assert.match(missed, /tail/);
});

class ControlledSink extends Writable {
  constructor() { super(); this.chunks = []; this.release = null; }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  _destroy(error, callback) { this.release = () => callback(error); }
}
function uploadHarness(limit = 8, requestOptions = {}) {
  const req = Object.assign(new PassThrough(), requestOptions), sink = new ControlledSink();
  let options, settled = false;
  const done = receiveFile(req, 'virtual-upload', limit, { createWriteStream(file, opts) { assert.equal(file, 'virtual-upload'); options = opts; return sink; } });
  const observed = done.then((size) => { settled = true; return { size }; }, (error) => { settled = true; return { error }; });
  return { req, sink, done, observed, get settled() { return settled; }, get options() { return options; } };
}
async function releaseSink(h) { await nextTurn(); assert.equal(typeof h.sink.release, 'function'); h.sink.release(); return h.observed; }
test('upload success waits for the destination close and preserves exact bytes', { timeout: 2000 }, async () => {
  const h = uploadHarness(); h.req.end(Buffer.from('中文'));
  await nextTurn(); assert.equal(h.settled, false); assert.equal(h.sink.writableFinished, true);
  assert.equal(h.options.flags, 'wx');
  const result = await releaseSink(h);
  assert.equal(result.size, 6); assert.equal(Buffer.concat(h.sink.chunks).toString(), '中文');
  for (const event of ['data', 'aborted', 'close', 'error']) assert.equal(h.req.listenerCount(event), 0);
});
for (const event of ['aborted', 'close', 'error']) test(`upload request ${event} settles only after destination close`, { timeout: 2000 }, async () => {
  const h = uploadHarness(); h.req.write('abc');
  if (event === 'error') h.req.emit(event, new Error('request failed'));
  else h.req.emit(event);
  await nextTurn(); assert.equal(h.settled, false); assert.equal(h.sink.destroyed, true);
  const result = await releaseSink(h);
  assert.ok(result.error);
  assert.match(result.error.message, event === 'error' ? /request failed/ : /中断/);
});
test('upload over the size limit returns 413 only after destination close', { timeout: 2000 }, async () => {
  const h = uploadHarness(3); h.req.end('four');
  await nextTurn(); assert.equal(h.settled, false);
  const result = await releaseSink(h); assert.equal(result.error.statusCode, 413);
});
test('upload destination failures are propagated after the descriptor closes', { timeout: 2000 }, async () => {
  const h = uploadHarness(); h.req.write('abc'); h.sink.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await nextTurn(); assert.equal(h.settled, false);
  const result = await releaseSink(h); assert.equal(result.error.code, 'ENOSPC');
});
test('a request already aborted before upload starts is rejected without piping bytes', { timeout: 2000 }, async () => {
  const h = uploadHarness(8, { aborted: true });
  const result = await releaseSink(h); assert.equal(result.error.code, 'UPLOAD_ABORTED');
  assert.equal(h.sink.chunks.length, 0);
});
test('the speech endpoint removes a partial upload only after receiveFile has settled', { timeout: 2000 }, async () => {
  let release, removed = false;
  const pending = new Promise((resolve, reject) => { release = () => reject(Object.assign(new Error('中断'), { code: 'UPLOAD_ABORTED' })); });
  const context = vm.createContext({
    p: '/api/stt', req: { method: 'POST', aborted: true }, res: {}, path, config: {},
    os: { tmpdir: () => 'virtual' }, crypto: { randomBytes: () => ({ toString: () => 'test' }) },
    receiveFile: () => pending, fs: { rmSync: () => { removed = true; } },
    sendJSON: () => assert.fail('An aborted request must not send a response'),
  });
  const done = vm.runInContext('(async () => {' + between("  if (p === '/api/stt'", "  if (p === '/api/voice-warm'") + '\n})()', context);
  await nextTurn(); assert.equal(removed, false); release(); await done; assert.equal(removed, true);
});

function deferred() { let resolve, reject; const promise = new Promise((ok, bad) => { resolve = ok; reject = bad; }); return { promise, resolve, reject }; }
test('preview queue deduplicates keys and enforces concurrency', async () => {
  const enqueue = boundedJobs({ concurrency: 2, maxPending: 4 });
  const gates = [deferred(), deferred(), deferred()]; const started = [];
  const a = enqueue('a', () => { started.push('a'); return gates[0].promise; });
  assert.strictEqual(enqueue('a', () => assert.fail('Duplicate key ran twice')), a);
  const b = enqueue('b', () => { started.push('b'); return gates[1].promise; });
  const c = enqueue('c', () => { started.push('c'); return gates[2].promise; });
  await nextTurn(); assert.deepEqual(started, ['a', 'b']);
  gates[0].resolve('A'); assert.equal(await a, 'A'); await nextTurn(); assert.deepEqual(started, ['a', 'b', 'c']);
  gates[1].resolve('B'); gates[2].resolve('C'); assert.deepEqual(await Promise.all([b, c]), ['B', 'C']);
});
test('full preview queue rejects new keys with 503 but still deduplicates an existing key', async () => {
  const enqueue = boundedJobs({ concurrency: 1, maxPending: 2 }), first = deferred(), second = deferred();
  const a = enqueue('a', () => first.promise), b = enqueue('b', () => second.promise);
  assert.strictEqual(enqueue('b', () => assert.fail('Duplicate queued job ran')), b);
  await assert.rejects(enqueue('c', () => assert.fail('Full queue work ran')), { statusCode: 503 });
  first.resolve(1); await a; second.resolve(2); await b;
});
test('preview failures release their key and slot so later work succeeds', async () => {
  const enqueue = boundedJobs({ concurrency: 1, maxPending: 2 });
  const a = enqueue('bad', () => { throw new Error('converter failed'); });
  const b = enqueue('next', () => 42);
  await assert.rejects(a, /converter failed/); assert.equal(await b, 42); await nextTurn();
  assert.equal(await enqueue('bad', () => 'retry succeeds'), 'retry succeeds');
});

test('GPT remains API-gated and keeps configured usage prices in the model menu', () => {
  const config = { openaiApiKey: 'TEST-ONLY-KEY', gptUsers: ['allowed'], models: [{ id: 'sonnet' }], gptModels: [{ id: 'gpt-test', price: { input: 2, cachedInput: 0.1, output: 10 } }] };
  const context = vm.createContext({ config });
  vm.runInContext(declaration('gptAllowed') + '\n' + declaration('geminiAllowed') + '\n' + declaration('modelsFor') + '\nglobalThis.menu = modelsFor;', context);
  assert.equal(context.menu({ id: 'other' }).length, 1);
  const menu = plain(context.menu({ id: 'allowed' }));
  assert.equal(menu[1].provider, 'openai'); assert.deepEqual(menu[1].price, config.gptModels[0].price);
  config.openaiApiKey = ''; assert.equal(context.menu({ id: 'allowed' }).length, 1);
});
test('Gemini is offered only to listed accounts, only with isolation and a fixed agy copy', () => {
  const config = { models: [{ id: 'sonnet' }], geminiUsers: ['allowed'], geminiModels: [{ id: 'gemini-test', efforts: ['low', 'high'] }],
    isolation: { enabled: true }, agyPath: 'C:\\fixed\\agy.exe' };
  const context = vm.createContext({ config, path, gptAllowed: () => false });
  vm.runInContext(declaration('geminiAllowed') + '\n' + declaration('modelsFor') + '\nglobalThis.menu = modelsFor;', context);
  assert.equal(context.menu({ id: 'other' }).length, 1);
  const menu = plain(context.menu({ id: 'allowed' }));
  assert.equal(menu[1].provider, 'google'); assert.deepEqual(menu[1].efforts, ['low', 'high']);
  config.isolation.enabled = false; assert.equal(context.menu({ id: 'allowed' }).length, 1);
  config.isolation.enabled = true; config.agyPath = 'agy'; assert.equal(context.menu({ id: 'allowed' }).length, 1);
});
test('GPT API cost separates cached input from uncached input and includes output', () => {
  const context = vm.createContext({ gptModel: (id) => id === 'priced' ? { price: { input: 2, cachedInput: 0.1, output: 10 } } : null });
  vm.runInContext(between('function gptCost(', 'function startJob('), context);
  assert.equal(context.gptCost('priced', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 }), 0.00148);
  assert.equal(context.gptCost('priced', { input_tokens: 1000, output_tokens: 100 }), 0.003);
  assert.equal(context.gptCost('unpriced', { input_tokens: 1000 }), undefined);
  assert.equal(context.gptCost('priced', null), undefined);
});
test('GPT launch preserves the dedicated API home, chosen model, image and fork parameters', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let launched;
  const context = vm.createContext({
    config: { codexPath: 'mock-codex' }, CODEX_HOME: 'dedicated-api-home', TOOL_ENV: { PATH: 'tool-path' },
    codexEffort: (value) => value, codexInstructions: () => 'test instructions',
    resolveIn: (u, rel) => path.join(u.workDir, rel),
    spawn: (command, args, options) => { launched = { command, args, options }; return child; },
  });
  vm.runInContext(between('function launchCodex(', '// 显示命令时'), context);
  const workDir = path.resolve('virtual-work');
  const proc = context.launchCodex({ workDir }, {}, { model: 'gpt-test', effort: 'high', attachments: [{ path: 'image.png' }] }, 'previous-api-thread');
  assert.strictEqual(proc.child, child); assert.equal(launched.command, 'mock-codex');
  assert.deepEqual(plain(launched.options), { cwd: workDir, windowsHide: true, env: { PATH: 'tool-path', CODEX_HOME: 'dedicated-api-home' } });
  assert.equal(launched.args[0], 'exec');
  assert.equal(launched.args[launched.args.indexOf('-m') + 1], 'gpt-test');
  assert.ok(launched.args.includes('model_reasoning_effort="high"'));
  assert.equal(launched.args[launched.args.indexOf('-i') + 1], path.join(workDir, 'image.png'));
  assert.deepEqual(plain(launched.args.slice(-3)), ['fork', 'previous-api-thread', '-']);
  assert.equal(launched.args.some((arg) => /forced_login_method|subscription|chatgpt/.test(arg)), false);
  assert.equal(child.stdout.readableEncoding, 'utf8'); assert.equal(child.stderr.readableEncoding, 'utf8');
});
test('GPT API login uses only a synthetic key on stdin and reuses unchanged API credentials', () => {
  const files = new Map(), child = new EventEmitter(), launched = [];
  let stdinValue;
  child.stdin = { end: (value) => { stdinValue = value; } };
  const apiHome = path.resolve('virtual-api-home'), testKey = 'TEST-ONLY-NOT-A-REAL-KEY';
  const context = vm.createContext({
    CODEX_HOME: apiHome, CODEX_CONFIG: 'mock config', crypto, path,
    config: { openaiApiKey: testKey, codexPath: 'mock-codex' }, process: { env: { PATH: 'safe' } }, console: { log() {} },
    fs: { mkdirSync() {}, existsSync: (file) => files.has(file), writeFileSync: (file, text) => files.set(file, text),
      readFileSync: (file) => { if (!files.has(file)) throw new Error('missing fixture'); return files.get(file); } },
    spawn: (command, args, options) => { launched.push({ command, args, options }); return child; },
  });
  vm.runInContext(between('function ensureCodexLogin(', '// 技能说明'), context);
  context.ensureCodexLogin();
  assert.equal(launched.length, 1); assert.deepEqual(plain(launched[0].args), ['login', '--with-api-key']);
  assert.equal(stdinValue, testKey); assert.ok(!JSON.stringify(launched).includes(testKey));
  assert.equal(launched[0].options.env.CODEX_HOME, apiHome);
  child.emit('close', 0); files.set(path.join(apiHome, 'auth.json'), 'mock auth exists');
  context.ensureCodexLogin(); assert.equal(launched.length, 1);
});

function withPathFixture(run) {
  const tempParent = path.resolve(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempParent, 'relay-path-test-'));
  const work = path.join(temp, 'workspace'), outside = path.join(temp, 'outside');
  try {
    fs.mkdirSync(path.join(work, 'nested'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(work, 'nested', 'note.txt'), 'fixture');
    fs.writeFileSync(path.join(outside, 'other.txt'), 'outside fixture');
    return run({ temp, work, outside });
  } finally {
    // Both junction targets and all files belong to this one generated fixture.
    assert.equal(path.dirname(path.resolve(temp)), tempParent);
    assert.ok(path.basename(temp).startsWith('relay-path-test-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
test('workspace paths permit existing files and missing descendants of a real owned directory', () => {
  withPathFixture(({ work }) => {
    assert.equal(workspacePath(work, ''), work);
    assert.equal(workspacePath(work, 'nested/note.txt'), path.join(work, 'nested', 'note.txt'));
    assert.equal(workspacePath(work, 'nested/new/deeper/file.txt'), path.join(work, 'nested', 'new', 'deeper', 'file.txt'));
  });
});
test('workspace paths reject lexical escapes, invalid inputs and Windows alternate streams', () => {
  withPathFixture(({ work, outside }) => {
    for (const input of ['../outside/other.txt', outside, null, 9, 'bad\0file']) assert.equal(workspacePath(work, input), null);
    if (path.sep === '\\') assert.equal(workspacePath(work, 'nested/note.txt:secret'), null);
  });
});
test('workspace paths allow internal junctions and reject external junctions even for new descendants', () => {
  withPathFixture(({ work, outside }) => {
    fs.symlinkSync(path.join(work, 'nested'), path.join(work, 'internal-link'), 'junction');
    fs.symlinkSync(outside, path.join(work, 'external-link'), 'junction');
    assert.equal(workspacePath(work, 'internal-link/note.txt'), path.join(work, 'internal-link', 'note.txt'));
    assert.equal(workspacePath(work, 'external-link/other.txt'), null);
    assert.equal(workspacePath(work, 'external-link/new/sub/file.txt'), null);
    assert.equal(fs.readFileSync(path.join(outside, 'other.txt'), 'utf8'), 'outside fixture');
  });
});
test('workspace paths reject dangling junctions instead of treating them as safe missing directories', () => {
  withPathFixture(({ temp, work }) => {
    fs.symlinkSync(path.join(temp, 'does-not-exist'), path.join(work, 'dangling-link'), 'junction');
    assert.equal(workspacePath(work, 'dangling-link'), null);
    assert.equal(workspacePath(work, 'dangling-link/new.txt'), null);
  });
});
