'use strict';
// 只测试有类型的结果和合成时钟；不启动任何外部程序。
const test = require('node:test'), assert = require('node:assert/strict');
const acceptance = require('../tools/maintenance-acceptance.cjs');
const modelFailure = (kind = 'model-network', extra = {}) => ({ ok: false, status: 1, out: '合成失败输出',
  failure: { message: '原有错误文本契约保留' }, failureKind: { stage: 'model', kind, provider: 'claude', source: 'model-result', ...extra } });
for (const kind of ['model-network', 'model-timeout']) test('明确模型' + kind + '只重试一次并保留两次输出', async () => {
  const seen = [], saved = [];
  const result = await acceptance.runAttempts({ runCheck: async ({ attempt }) => {
    seen.push(attempt); return attempt === 1 ? { ...modelFailure(kind), out: '第一次合成输出', logFile: 'first.log' } : { ok: true, status: 0, out: '第二次合成输出', logFile: 'second.log' };
  }, onAttempt: entry => saved.push(entry) });
  assert.equal(result.ok, true); assert.equal(result.retried, true); assert.equal(result.recordVersionFailure, false);
  assert.deepEqual(seen, [1, 2]); assert.equal(saved.length, 2);
  assert.equal(result.attempts[0].result.out, '第一次合成输出'); assert.equal(result.attempts[1].result.out, '第二次合成输出');
  assert.equal(result.attempts[0].result.logFile, 'first.log'); assert.equal(result.attempts[1].result.logFile, 'second.log');
  assert.equal(result.attempts[0].result.failure.message, '原有错误文本契约保留');
});
test('两次模型失败就结束，不进行第三次验收', async () => {
  let called = 0;
  const result = await acceptance.runAttempts({ runCheck: async () => { called++; return modelFailure(); } });
  assert.equal(called, 2); assert.equal(result.ok, false); assert.equal(result.recordVersionFailure, true); assert.equal(result.attemptCount, 2);
});
test('首次通过只运行一次，不能把带失败证据的成功标记当作通过', async () => {
  let called = 0;
  const passed = await acceptance.runAttempts({ runCheck: async () => { called++; return { ok: true, status: 0, out: '合成通过' }; } });
  assert.equal(called, 1); assert.equal(passed.ok, true);
  const contradictory = await acceptance.runAttempts({ runCheck: async () => ({ ok: true, failure: { message: '存在失败' } }) });
  assert.equal(contradictory.ok, false); assert.equal(contradictory.retried, false);
});
test('边界拒绝和回归失败不能借模型重试掩盖', async () => {
  for (const options of [{ kind: 'regression', result: modelFailure() }, { kind: 'e2e', result: modelFailure('model-network', { stage: 'boundary' }) },
    { kind: 'e2e', result: modelFailure('boundary') }]) {
    let called = 0;
    const result = await acceptance.runAttempts({ kind: options.kind, runCheck: async () => { called++; return options.result; } });
    assert.equal(called, 1); assert.equal(result.ok, false); assert.equal(result.recordVersionFailure, false);
  }
});
test('日志写着超时或网络也不重试，本地 HTTP 故障不算模型网络', async () => {
  for (const value of [{ ok: false, out: 'model timeout network ECONNRESET', failure: { message: '真实模型超时' } },
    modelFailure('model-network', { stage: 'infrastructure', source: 'local-http' }),
    modelFailure('model-network', { source: 'local-http' }), modelFailure('model-timeout', { provider: 'other' })]) {
    let called = 0;
    const result = await acceptance.runAttempts({ runCheck: async () => { called++; return value; } });
    assert.equal(called, 1); assert.equal(result.ok, false);
  }
});
test('harness 明确的模型等待超时可重试，等待来源不能声称网络错误', async () => {
  const timeout = await acceptance.runAttempts({ runCheck: async () => modelFailure('model-timeout', { source: 'harness-model-wait' }) });
  assert.equal(timeout.attemptCount, 2);
  const network = await acceptance.runAttempts({ runCheck: async () => modelFailure('model-network', { source: 'harness-model-wait' }) });
  assert.equal(network.attemptCount, 1);
});
test('额度、登录、取消、用户文件问题不重试也不记坏版本', async () => {
  for (const kind of ['quota', 'auth', 'cancelled', 'user-file']) {
    const result = await acceptance.runAttempts({ runCheck: async () => modelFailure(kind) });
    assert.equal(result.attemptCount, 1); assert.equal(result.recordVersionFailure, false);
  }
});
test('墙钟和单调钟偏移提示睡眠或时间变更时，不通过、不重试、不记坏版本', async () => {
  let wallMs = 1000, monotonicMs = 1000;
  const result = await acceptance.runAttempts({ clock: () => ({ wallMs, monotonicMs }), runCheck: async () => {
    wallMs += 120000; monotonicMs += 100; return modelFailure('model-timeout');
  } });
  assert.equal(result.attemptCount, 1); assert.equal(result.interrupted, true); assert.equal(result.ok, false); assert.equal(result.recordVersionFailure, false);
});
test('两种时钟都包含睡眠时间时，长采样间隙也按不确定中断处理', async () => {
  let time = 1000;
  const result = await acceptance.runAttempts({ clock: () => ({ wallMs: time, monotonicMs: time }), runCheck: async () => { time += 120000; return { ok: true, status: 0 }; } });
  assert.equal(result.ok, false); assert.equal(result.interrupted, true); assert.equal(result.recordVersionFailure, false); assert.equal(result.attemptCount, 1);
});
test('已有睡眠标记不启动验收，运行中睡眠或状态变更不记坏版本', async () => {
  let called = 0;
  const asleep = await acceptance.runAttempts({ readHostState: async () => ({ sleeping: true }), runCheck: async () => { called++; return modelFailure(); } });
  assert.equal(called, 0); assert.equal(asleep.recordVersionFailure, false); assert.equal(asleep.interrupted, true);
  for (const changed of [{ sleeping: true, transition: 1 }, { sleeping: false, transition: 2 }]) {
    let state = { sleeping: false, transition: 1 };
    const result = await acceptance.runAttempts({ readHostState: async () => state, runCheck: async () => { state = changed; return modelFailure(); } });
    assert.equal(result.interrupted, true); assert.equal(result.recordVersionFailure, false); assert.equal(result.attemptCount, 1);
  }
});
test('无法确认睡眠状态或未分类的外层超时，不指责版本也不重试', async () => {
  let called = 0;
  const state = await acceptance.runAttempts({ readHostState: async () => { throw Error('合成不可读'); }, runCheck: async () => { called++; return { ok: true }; } });
  assert.equal(called, 0); assert.equal(state.ok, false); assert.equal(state.recordVersionFailure, false);
  const timeout = await acceptance.runAttempts({ runCheck: async () => ({ ok: false, timedOut: true }) });
  assert.equal(timeout.attemptCount, 1); assert.equal(timeout.recordVersionFailure, false);
});
test('第一次失败的快照不被第二次执行改写，保存失败不能继续重试', async () => {
  const first = modelFailure();
  const result = await acceptance.runAttempts({ runCheck: async ({ attempt }) => {
    if (attempt === 1) return first; first.out = '第二次修改'; first.failure.message = '被改写'; return { ok: true };
  } });
  assert.equal(result.attempts[0].result.out, '合成失败输出'); assert.equal(result.attempts[0].result.failure.message, '原有错误文本契约保留');
  let called = 0;
  await assert.rejects(acceptance.runAttempts({ runCheck: async () => { called++; return modelFailure(); }, onAttempt: async () => { throw Error('合成记录保存失败'); } }), /保存失败/);
  assert.equal(called, 1);
});
test('执行器抛出的未知错误不能被当成可重试网络错误', async () => {
  let called = 0;
  const result = await acceptance.runAttempts({ runCheck: async () => { called++; throw Error('network timeout 合成异常'); } });
  assert.equal(called, 1); assert.equal(result.ok, false); assert.equal(result.recordVersionFailure, false);
  assert.equal(result.failureKind.stage, 'infrastructure');
});
