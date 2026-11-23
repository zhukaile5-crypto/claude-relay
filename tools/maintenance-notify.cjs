'use strict';
// M11：仅发送固定结构的维护事件；未配置时零网络、零文件写入。
const crypto = require('node:crypto');
const path = require('node:path');
const defaultFs = require('node:fs/promises');
const TYPES = new Set(['isolation-blocked', 'upgrade-failed', 'rolled-back']);
const PROGRAMS = new Set(['claude', 'codex', 'relay', 'runtime']);
const REASONS = new Set(['fingerprint-mismatch', 'acceptance-failed', 'download-failed',
  'version-unreadable', 'restart-failed', 'runtime-failure', 'interrupted', 'unknown']);
const queues = new Map();
const VERSION = /^(?:unknown|\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9.-]{1,32})?)$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = event => digest(JSON.stringify([
  event.type, event.program, event.version, event.reason, event.issueFingerprint,
]));

function normalize(event, now) {
  if (!event || !TYPES.has(event.type)) return null;
  const program = event.program || 'relay', version = event.version || 'unknown';
  const reason = event.reason || 'unknown';
  if (!PROGRAMS.has(program) || typeof version !== 'string' || !VERSION.test(version) || !REASONS.has(reason)) return null;
  const issueFingerprint = event.issueFingerprint === undefined
    ? digest(JSON.stringify([event.type, program, version, reason])) : event.issueFingerprint;
  if (typeof issueFingerprint !== 'string' || !HASH.test(issueFingerprint)) return null;
  // 不复制原始 event：error、日志、账号、路径等内容都不会进入状态或邮件。
  return { schema: 1, type: event.type, program, version, reason, issueFingerprint,
    occurredAt: new Date(now).toISOString() };
}

function settings(options) {
  const config = options.config || {};
  if (config.enabled !== true) return { disabled: true };
  try {
    const url = new URL(config.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search ||
        url.hash || url.pathname !== '/notify') throw new Error();
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(config.secretEnv || '')) throw new Error();
    const token = (options.env || process.env)[config.secretEnv];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error();
    if (typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) throw new Error();
    const retryMs = config.retryMs === undefined ? 900000 : config.retryMs;
    if (!Number.isSafeInteger(retryMs) || retryMs < 60000 || retryMs > 86400000) throw new Error();
    return { endpoint: url.href, token, stateDir: config.stateDir, retryMs };
  } catch { return { invalid: true }; }
}

// 实测一次发信约 7 秒；留足余量。重试循环按这个时长判断剩余预算够不够再发一封
const SEND_TIMEOUT_MS = 30000;
async function httpsTransport({ url, token, payload }) {
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!response.ok) return { ok: false };
  // 只承认专用端点的确认；不记录服务端响应文本或异常内容。
  const reader = response.body?.getReader();
  if (!reader) return { ok: false };
  let body = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return { ok: false }; }
      body += new TextDecoder().decode(value, { stream: true });
    }
    const result = JSON.parse(body);
    return { ok: result.ok === true && ['sent', 'duplicate'].includes(result.status) };
  } catch { return { ok: false }; }
}

function serialized(key, action) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(key, current);
  return current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
}

async function writeAtomic(fs, file, record) {
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    try { await fs.unlink(temporary); } catch {}
    throw error;
  }
}

function validRecord(record, id) {
  return record?.schema === 1 && ['pending', 'sent'].includes(record.status) &&
    Number.isSafeInteger(record.attempts) && record.attempts >= 1 &&
    Number.isFinite(record.nextAttemptAt) && record.payload?.schema === 1 &&
    Object.keys(record.payload).sort().join(',') ===
      'issueFingerprint,occurredAt,program,reason,schema,type,version' &&
    typeof record.payload.occurredAt === 'string' &&
    Number.isFinite(Date.parse(record.payload.occurredAt)) &&
    normalize(record.payload, 0) && identity(record.payload) === id;
}

async function readRecord(fs, file, id) {
  try {
    const value = await fs.readFile(file, 'utf8');
    if (value.length > 8192) throw new Error();
    const record = JSON.parse(value);
    if (!validRecord(record, id)) throw new Error();
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('invalid-notification-state');
  }
}

async function deliver(payload, options, config) {
  const fs = options.fs || defaultFs, clock = options.clock || Date.now;
  const id = identity(payload), file = path.join(config.stateDir, id + '.json');
  return serialized(file, async () => {
    let record;
    try {
      await fs.mkdir(config.stateDir, { recursive: true });
      record = await readRecord(fs, file, id);
    } catch { return { status: 'state-error', code: 'state-unavailable' }; }
    const now = clock();
    if (record?.status === 'sent') return { status: 'duplicate', id };
    if (record && now < record.nextAttemptAt) return { status: 'deferred', id };
    record = { schema: 1, status: 'pending', payload: record?.payload || payload,
      attempts: Math.min((record?.attempts || 0) + 1, 1000000),
      nextAttemptAt: now + config.retryMs };
    // 先记下本次尝试，进程中断后仍按退避时间重试同一 id。
    try { await writeAtomic(fs, file, record); }
    catch { return { status: 'state-error', code: 'state-unavailable' }; }
    let ok = false;
    try {
      ok = (await (options.transport || httpsTransport)({
        url: config.endpoint, token: config.token, payload: record.payload,
      }))?.ok === true;
    } catch {}
    if (!ok) return { status: 'pending', id, code: 'delivery-failed' };
    record.status = 'sent';
    record.sentAt = clock();
    try { await writeAtomic(fs, file, record); }
    catch { return { status: 'state-error', id, code: 'ack-save-failed' }; }
    return { status: 'sent', id };
  });
}

async function notify(event, options = {}) {
  const config = settings(options);
  if (config.disabled) return { status: 'disabled' };
  if (config.invalid) return { status: 'config-error' };
  const payload = normalize(event, (options.clock || Date.now)());
  if (!payload) return { status: 'ignored', code: 'unsupported-event' };
  return deliver(payload, options, config);
}

async function retryPending(options = {}) {
  const config = settings(options);
  if (config.disabled) return { status: 'disabled', results: [] };
  if (config.invalid) return { status: 'config-error', results: [] };
  const fs = options.fs || defaultFs;
  let names;
  try { names = await fs.readdir(config.stateDir); }
  catch (error) {
    return { status: error.code === 'ENOENT' ? 'ok' : 'state-error', results: [] };
  }
  const results = [];
  // 有界扫描，每次只尝试 100 个待发事件；不读取其他维护文件。
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts >= 1 ? Math.min(100, options.maxAttempts) : 100;
    if (results.length >= maxAttempts || options.remainingBudget && options.remainingBudget() < SEND_TIMEOUT_MS + 5000) break;
    try {
      const record = await readRecord(fs, path.join(config.stateDir, name), name.slice(0, -5));
      if (record?.status === 'pending') results.push(await deliver(record.payload, options, config));
    } catch { results.push({ status: 'state-error', code: 'state-unavailable' }); }
  }
  return { status: 'ok', results };
}
module.exports = { notify, retryPending, normalize, identity, SEND_TIMEOUT_MS };
