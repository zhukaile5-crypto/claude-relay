'use strict';
// 只记录本进程的收尾承诺；不读取对话或账号数据。调用方负责授权与重新载入最新对话。
function createFinalizationBarrier({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();
  const keyOf = (accountId, conversationId) => JSON.stringify([accountId, conversationId]);
  function begin(accountId, conversationId, provider) {
    const key = keyOf(accountId, conversationId);
    let resolve;
    const entry = { provider, promise: new Promise(done => { resolve = done; }) };
    if (!pending.has(key)) pending.set(key, new Set());
    pending.get(key).add(entry);
    let closed = false;
    return (incomplete = false) => {
      if (closed) return;
      closed = true;
      const group = pending.get(key);
      group?.delete(entry);
      if (!group?.size) pending.delete(key);
      resolve({ incomplete: !!incomplete });
    };
  }
  async function wait(accountId, conversationId, provider, { timeoutMs = 5000 } = {}) {
    const entries = [...(pending.get(keyOf(accountId, conversationId)) || [])].filter(entry => entry.provider !== provider);
    if (!entries.length) return { waited: false, incomplete: false };
    let timer;
    try {
      return await Promise.race([
        Promise.all(entries.map(entry => entry.promise)).then(results => ({ waited: true, incomplete: results.some(result => result.incomplete) })),
        new Promise(resolve => { timer = setTimer(() => resolve({ waited: true, incomplete: true }), Math.max(0, Math.min(5000, timeoutMs))); }),
      ]);
    } finally { clearTimer(timer); }
  }
  return { begin, wait };
}
module.exports = { createFinalizationBarrier };
