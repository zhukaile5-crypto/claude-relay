'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createFinalizationBarrier } = require('../tools/model-finalization.cjs');
function clock() {
  let now = 0, id = 0; const timers = new Map();
  return { setTimer(fn, ms) { timers.set(++id, { at: now + ms, fn }); return id; }, clearTimer(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } }, count: () => timers.size };
}
test('H2 两秒收尾完成后交接可看见刚产生的文件和记录', async () => {
  const c = clock(), barrier = createFinalizationBarrier(c), files = [];
  const done = barrier.begin('alice', 'same', 'anthropic');
  const waiting = barrier.wait('alice', 'same', 'openai'); let settled = false;
  waiting.then(() => { settled = true; }); c.advance(1999); await Promise.resolve(); assert.equal(settled, false);
  c.advance(1); files.push('outputs/result.txt'); done();
  assert.deepEqual(await waiting, { waited: true, incomplete: false }); assert.deepEqual(files, ['outputs/result.txt']); assert.equal(c.count(), 0);
});
test('H2 十秒扫描最多等待五秒并明确可能不全，迟到完成能清理', async () => {
  const c = clock(), barrier = createFinalizationBarrier(c), done = barrier.begin('alice','same','anthropic');
  const waiting = barrier.wait('alice','same','openai'); c.advance(5000);
  assert.deepEqual(await waiting, { waited: true, incomplete: true }); c.advance(5000); done();
  assert.deepEqual(await barrier.wait('alice','same','openai'), { waited: false, incomplete: false });
});
test('H2 同提供方与其他账号/对话不等待，账号键不能靠分隔符碰撞', async () => {
  const c = clock(), barrier = createFinalizationBarrier(c), done = barrier.begin('a|b','c','anthropic');
  for (const args of [['a|b','c','anthropic'],['a','b|c','openai'],['a|b','other','openai']]) assert.deepEqual(await barrier.wait(...args), { waited: false, incomplete: false });
  assert.equal(c.count(), 0); done(); done();
});
test('H2 多个收尾都完成才放行，失败标记保留给正在等待的请求', async () => {
  const c=clock(), b=createFinalizationBarrier(c), a=b.begin('alice','same','anthropic'), d=b.begin('alice','same','anthropic');
  const waiting=b.wait('alice','same','openai'); a(true); d();
  assert.deepEqual(await waiting,{waited:true,incomplete:true}); assert.equal(c.count(),0);
});
