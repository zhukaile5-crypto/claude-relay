'use strict';
// 只使用 Node 临时文件和合成事件；不执行任何模型、外部程序或维护命令。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const health = require('../tools/runtime-health.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-runtime-health-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^relay-runtime-health-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cwd = path.join(directory, 'work');
  const executable = path.join(directory, 'program.exe');
  await fs.mkdir(cwd);
  await fs.writeFile(executable, '合成程序占位，绝不执行');
  return { directory, cwd, executable, eventsDir: path.join(directory, 'events') };
}

test('M6 外部原因优先排除，不因同时存在启动或协议错误而计为程序故障', async t => {
  const rows = [
    ['auth', { failureText: 'HTTP 401 authentication required' }],
    ['auth', { failureText: '登录凭证已过期' }],
    ['quota', { failureText: 'HTTP 429 rate limit exceeded' }],
    ['quota', { failureText: '额度不足' }],
    ['network', { failureText: 'ECONNRESET: connection reset' }],
    ['network', { failureText: '请求超时' }],
    ['userfile', { failureText: 'unsupported file format' }],
    ['userfile', { failureText: '文件格式损坏' }],
    ['cancel', { cancelled: true }],
    ...['auth', 'quota', 'network', 'userfile', 'cancel'].map(kind => [kind, { kind }]),
  ];
  for (const [expected, input] of rows) await t.test(expected + '：' + JSON.stringify(input), () => {
    const category = health.classifyOutcome({ spawnError: true, executableFailure: true,
      spawnCode: 'ENOENT', protocolErrors: 2, validEvents: 0, hasOutput: false,
      exitCode: 3221225781, ...input });
    assert.equal(category, expected);
    assert.equal(health.FAULTS.includes(category), false);
  });
});

test('M6 成功与明确取消会终止故障连续计数，失败文字本身不能伪造成功', () => {
  assert.equal(health.classifyOutcome({ success: true, protocolErrors: 4,
    hasOutput: false, failureText: 'network transient warning' }), 'success');
  assert.equal(health.classifyOutcome({ success: true, cancelled: true }), 'cancel');
  assert.equal(health.classifyOutcome({ success: false, failureText: 'success', exitCode: 1,
    hasOutput: false }), 'unknown');
  assert.equal(health.classifyOutcome({ success: 'true' }), 'unknown');
});

test('M6 协议错误和无输出退出只在明确条件下归为程序故障', () => {
  assert.equal(health.classifyOutcome({ protocolErrors: 1, validEvents: 0, hasOutput: false }), 'protocol');
  // 初始化不是用户可见输出；初始化后协议坏掉仍应统计。
  assert.equal(health.classifyOutcome({ protocolErrors: 1, validEvents: 1, hasOutput: false }), 'protocol');
  assert.equal(health.classifyOutcome({ protocolErrors: 1, validEvents: 0, hasOutput: true }), 'unknown');
  assert.equal(health.classifyOutcome({ protocolErrors: 1, validEvents: 0 }), 'unknown');
  assert.equal(health.classifyOutcome({ exitCode: 1, validEvents: 1, hasOutput: false }), 'no-output');
  assert.equal(health.classifyOutcome({ exitCode: 3221225477, hasOutput: false,
    failureText: 'native crash' }), 'no-output');
  assert.equal(health.classifyOutcome({ exitCode: -1073741515, hasOutput: false }), 'no-output');
  assert.equal(health.classifyOutcome({ exitCode: 0, hasOutput: false }), 'unknown');
  assert.equal(health.classifyOutcome({ exitCode: 1, hasOutput: true }), 'unknown');
  assert.equal(health.classifyOutcome({ exitCode: 1, hasOutput: false,
    failureText: 'unrecognized diagnostic' }), 'unknown');
  assert.equal(health.classifyOutcome({ exitCode: '1', hasOutput: false }), 'unknown');
});

test('M6 启动故障要求确切的程序证据，不能仅凭 spawn 错误推断', () => {
  for (const spawnCode of ['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'ENOTDIR']) {
    assert.equal(health.classifyOutcome({ spawnError: true, spawnCode, executableFailure: true }), 'start');
    assert.equal(health.classifyOutcome({ spawnError: true, spawnCode }), 'unknown');
    assert.equal(health.classifyOutcome({ spawnError: false, spawnCode, executableFailure: true }), 'unknown');
  }
  assert.equal(health.classifyOutcome({ spawnError: true, spawnCode: 'EPIPE', executableFailure: true }), 'unknown');
});

test('M6 启动上下文只确认绝对程序路径匹配且工作目录有效的缺文件或格式错误', async t => {
  const f = await fixture(t);
  const missing = path.join(f.directory, 'missing.exe');
  const base = { spawnError: true, spawnCode: 'ENOENT', spawnPath: missing, executableFailure: true };
  const checked = await health.confirmSpawnContext(base, { executable: missing, cwd: f.cwd });
  assert.equal(checked.executableFailure, true);
  assert.equal(health.classifyOutcome(checked), 'start');
  assert.equal(base.executableFailure, true);
  assert.notEqual(checked, base);
  const format = await health.confirmSpawnContext({ ...base, spawnCode: 'ENOEXEC', spawnPath: f.executable },
    { executable: f.executable, cwd: f.cwd });
  assert.equal(format.executableFailure, true);
  assert.equal(health.classifyOutcome(format), 'start');
  const rows = [
    ['工作目录缺失', base, { executable: missing, cwd: path.join(f.directory, 'missing-work') }],
    ['工作目录是文件', base, { executable: missing, cwd: f.executable }],
    ['路径不匹配', base, { executable: f.executable, cwd: f.cwd }],
    ['配置路径相对', base, { executable: 'program.exe', cwd: f.cwd }],
    ['实际路径相对', { ...base, spawnPath: 'program.exe' }, { executable: missing, cwd: f.cwd }],
    ['程序仍然存在', { ...base, spawnPath: f.executable }, { executable: f.executable, cwd: f.cwd }],
    ['只有权限错误', { ...base, spawnCode: 'EACCES' }, { executable: missing, cwd: f.cwd }],
    ['格式错误但路径是目录', { ...base, spawnCode: 'ENOEXEC', spawnPath: f.cwd }, { executable: f.cwd, cwd: f.cwd }],
    ['没有启动失败', { ...base, spawnError: false }, { executable: missing, cwd: f.cwd }],
  ];
  for (const [name, input, context] of rows) await t.test(name, async () => {
    const result = await health.confirmSpawnContext(input, context);
    assert.equal(result.executableFailure, false);
    assert.equal(health.classifyOutcome(result), 'unknown');
  });
});

test('M6 健康事件只有固定白名单和会话散列，不保存原始输出或对话', () => {
  const now = 1700000000100;
  const sessionId = '合成对话标记，不能落盘';
  const record = health.eventRecord({ program: 'Claude', sessionId, startedAt: now - 25,
    category: 'protocol', failureText: '合成原始报错，不能落盘', output: '合成回答，不能落盘',
    prompt: '合成输入，不能落盘', apiKey: '合成凭证占位，不能落盘', user: '合成用户名' }, now);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'category', 'program', 'schema', 'sessionHash', 'startedAt']);
  assert.deepEqual(record, { schema: 1, program: 'Claude', category: 'protocol',
    sessionHash: crypto.createHash('sha256').update('Claude\0' + sessionId).digest('hex'), at: now, startedAt: now - 25 });
  assert.equal(health.validEvent(record), true);
  assert.equal(JSON.stringify(record).includes('合成'), false);
  assert.notEqual(health.eventRecord({ program: 'Codex', sessionId }, now).sessionHash, record.sessionHash);
  assert.equal(health.eventRecord({ program: 'Claude', sessionId }, now).sessionHash, record.sessionHash);
  assert.equal(health.eventRecord({ program: 'Claude', sessionId }, now).startedAt, now);
  assert.equal(health.eventRecord({ program: 'Claude', sessionId, category: 'raw-output',
    failureText: 'HTTP 429 quota' }, now).category, 'quota');
});

test('M6 无效事件、未来启动时间及额外字段均被拒绝', () => {
  const now = 1700000000100, event = { program: 'Codex', sessionId: 'session-a', startedAt: now - 1, category: 'success' };
  for (const changes of [{ program: 'Other' }, { sessionId: '' }, { sessionId: 42 },
    { sessionId: 'x'.repeat(4097) }, { startedAt: now + 1 }, { startedAt: 0 },
    { startedAt: -1 }, { startedAt: 1.5 }, { startedAt: NaN }, { startedAt: '1' }]) {
    assert.equal(health.eventRecord({ ...event, ...changes }, now), null);
  }
  for (const badNow of [0, -1, 1.5, NaN, Infinity, '1700000000100']) {
    assert.equal(health.eventRecord(event, badNow), null);
  }
  const valid = health.eventRecord(event, now);
  for (const changes of [{ schema: 2 }, { program: 'Other' }, { category: 'raw' },
    { sessionHash: 'A'.repeat(64) }, { sessionHash: 'a'.repeat(63) }, { startedAt: now + 1 },
    { at: 0 }, { startedAt: '1' }, { extra: 'raw' }]) {
    assert.equal(Boolean(health.validEvent({ ...valid, ...changes })), false);
  }
  const missing = { ...valid }; delete missing.startedAt;
  assert.equal(Boolean(health.validEvent(missing)), false);
  assert.equal(Boolean(health.validEvent(null)), false);
});

test('M6 同毫秒并发事件按调用顺序写入，异步上下文核对不会颠倒连续故障', async t => {
  const f = await fixture(t), now = 1700000000200;
  const missing = path.join(f.directory, 'missing.exe');
  const expected = ['start', 'success', 'protocol', 'network', 'no-output'];
  const inputs = [
    { spawnError: true, spawnCode: 'ENOENT', spawnPath: missing },
    { success: true },
    { protocolErrors: 1, hasOutput: false, validEvents: 0 },
    { failureText: 'network timeout', exitCode: 1, hasOutput: false },
    { exitCode: 1, hasOutput: false },
  ];
  const results = await Promise.all(inputs.map((input, index) => health.recordOutcome({
    ...input, program: 'Codex', sessionId: 'ordered-' + index, startedAt: now - 10,
    output: '合成输出，不得写入',
  }, { eventsDir: f.eventsDir, clock: () => now,
    ...(index === 0 ? { spawnContext: { executable: missing, cwd: f.cwd } } : {}) })));
  assert.deepEqual(results.map(value => value.status), inputs.map(() => 'recorded'));
  assert.deepEqual(results.map(value => value.category), expected);
  const names = (await fs.readdir(f.eventsDir)).sort();
  assert.equal(names.length, inputs.length);
  assert.equal(new Set(names).size, inputs.length);
  const records = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(f.eventsDir, name), 'utf8'))));
  assert.deepEqual(records.map(value => value.category), expected);
  assert.deepEqual(records.map(value => value.at), inputs.map(() => now));
  assert.equal(records.every(health.validEvent), true);
  assert.equal(JSON.stringify(records).includes('合成输出'), false);
});

test('M6 时钟倒退保持事件顺序，无效事件不污染目录也不阻断下一次写入', async t => {
  const f = await fixture(t), now = 1700000000300;
  const first = await health.recordOutcome({ program: 'Claude', sessionId: 'first', success: true,
    startedAt: now - 100 }, { eventsDir: f.eventsDir, clock: () => now });
  const ignored = await health.recordOutcome({ program: 'Other', sessionId: 'invalid' },
    { eventsDir: f.eventsDir, clock: () => now - 1 });
  const next = await health.recordOutcome({ program: 'Claude', sessionId: 'next', category: 'protocol',
    startedAt: now - 100 }, { eventsDir: f.eventsDir, clock: () => now - 2 });
  assert.equal(first.status, 'recorded'); assert.equal(ignored.status, 'ignored'); assert.equal(next.status, 'recorded');
  const names = (await fs.readdir(f.eventsDir)).sort();
  const records = await Promise.all(names.map(async name => JSON.parse(await fs.readFile(path.join(f.eventsDir, name), 'utf8'))));
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(value => value.category), ['success', 'protocol']);
  assert.deepEqual(records.map(value => value.at), [now, now]);
});

test('M6 无法写事件时返回明确失败，修好临时目录后后续事件仍可写入', async t => {
  const f = await fixture(t), blocked = path.join(f.directory, 'blocked');
  await fs.writeFile(blocked, '合成阻挡文件');
  const event = { program: 'Claude', sessionId: 'retry', category: 'auth' };
  const failed = await health.recordOutcome(event, { eventsDir: blocked, clock: () => 1700000000400 });
  assert.deepEqual(failed, { status: 'record-failed', category: 'auth' });
  await fs.unlink(blocked);
  const result = await health.recordOutcome(event, { eventsDir: blocked, clock: () => 1700000000401 });
  assert.deepEqual(result, { status: 'recorded', category: 'auth' });
  assert.equal((await fs.readdir(blocked)).length, 1);
});
