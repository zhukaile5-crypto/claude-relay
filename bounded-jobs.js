'use strict';

// Identical work shares one promise. Limit both running jobs and queued work;
// a failed job releases its slot and never poisons later requests.
module.exports = function boundedJobs({ concurrency = 1, maxPending = 8 } = {}) {
  const pending = new Map(), queue = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && queue.length) {
      const { key, work, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        active--; pending.delete(key); pump();
      });
    }
  };
  return (key, work) => {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) return Promise.reject(Object.assign(new Error('预览任务较多，请稍后再试'), { statusCode: 503 }));
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    pending.set(key, promise); queue.push({ key, work, resolve, reject }); pump();
    return promise;
  };
};
