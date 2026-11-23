'use strict';
// 内存中的短期重启屏障。维护进程必须续租，崩溃后不会永久阻止新任务。
function createDrain({ now = () => Date.now(), leaseMs = 30000, uploadMs = 120000 } = {}) {
  let lease = null, active = 0;
  const uploads = new Map();
  const key = (user, id) => user + ':' + id;
  function expire() { if (lease && lease.until <= now()) lease = null; for (const [id, until] of uploads) if (until <= now()) uploads.delete(id); }
  function begin(token) {
    expire();
    if (!/^[a-f0-9]{64}$/.test(token || '') || lease && lease.token !== token) return false;
    lease = { token, until: now() + leaseMs }; return true;
  }
  function end(token) { expire(); if (!lease || lease.token !== token) return false; lease = null; return true; }
  function blocked() { expire(); return !!lease; }
  function upload(user, id) { if (/^[a-f0-9]{16}$/.test(id)) uploads.set(key(user, id), now() + uploadMs); }
  function completeUpload(user, id) { uploads.delete(key(user, id)); }
  function hasUpload(user, id) { expire(); return uploads.has(key(user, id)); }
  function enter() { active++; let done = false; return () => { if (!done) { done = true; active--; } }; }
  function trackRequest(res) {
    const release = enter(); let handlerDone = false, responseDone = false;
    const finish = () => { responseDone = true; if (handlerDone) release(); };
    res.once('finish', finish); res.once('close', finish);
    return () => { handlerDone = true; if (responseDone || res.writableFinished || res.destroyed) release(); };
  }
  async function background(work) { const release = enter(); try { return await (typeof work === 'function' ? work() : work); } finally { release(); } }
  function status(jobs = 0) { expire(); return { draining: !!lease, activeRequests: active, activeUploads: uploads.size, running: jobs + active + uploads.size }; }
  return { begin, end, blocked, upload, completeUpload, hasUpload, enter, trackRequest, background, status };
}
function taskRequest(method, pathname) {
  if (['/api/state','/api/events','/api/usage','/api/logout','/api/stop'].includes(pathname)) return false;
  if (method === 'GET' && /^\/api\/conversations\/[a-f0-9]{16}$/.test(pathname)) return false;
  return pathname.startsWith('/api/');
}
function localMaintenanceRequest(req) {
  return req.method === 'POST' && /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') &&
    !['origin', 'sec-fetch-site', 'cf-connecting-ip'].some(name => Object.hasOwn(req.headers, name));
}
module.exports = { createDrain, taskRequest, localMaintenanceRequest };