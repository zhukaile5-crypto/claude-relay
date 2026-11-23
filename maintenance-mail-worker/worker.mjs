// M11：专用邮件入口。独立部署；不改变现有叫醒 Worker。
const TYPES = new Set(['isolation-blocked', 'upgrade-failed', 'rolled-back']);
const PROGRAMS = new Set(['claude', 'codex', 'relay', 'runtime']);
const REASONS = new Set(['fingerprint-mismatch', 'acceptance-failed', 'download-failed',
  'version-unreadable', 'restart-failed', 'runtime-failure', 'interrupted', 'unknown']);
const KEYS = ['schema', 'type', 'program', 'version', 'reason', 'issueFingerprint', 'occurredAt'];
const MAX_BODY = 2048, RETRY_MS = 300000, SPACING_MS = 60000, MAX_ISSUES = 512;
const reply = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const generic = (status, code) => reply(status, { ok: false, code });

function configured(env) {
  return /^[A-Za-z0-9_-]{32,256}$/.test(env.NOTIFY_SECRET || '') &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(env.MAIL_FROM || '') &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(env.MAIL_TO || '') &&
    ![env.MAIL_FROM, env.MAIL_TO].some(value => /[\r\n]/.test(value));
}
async function authorized(request, env) {
  if (!configured(env)) return false;
  // 固定长度摘要比较；不输出原始 header 或配置。
  const header = request.headers.get('authorization') || '';
  if (header.length > 300) return false;
  const bytes = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', bytes.encode(header)),
    crypto.subtle.digest('SHA-256', bytes.encode('Bearer ' + env.NOTIFY_SECRET)),
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < av.length; i++) difference |= av[i] ^ bv[i];
  return difference === 0;
}
export function validPayload(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key))) return false;
  const time = Date.parse(value.occurredAt);
  return value.schema === 1 && TYPES.has(value.type) && PROGRAMS.has(value.program) &&
    typeof value.version === 'string' &&
    /^(?:unknown|\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9.-]{1,32})?)$/.test(value.version) &&
    REASONS.has(value.reason) && typeof value.issueFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.issueFingerprint) &&
    typeof value.occurredAt === 'string' && value.occurredAt.length === 24 &&
    Number.isFinite(time) && new Date(time).toISOString() === value.occurredAt &&
    time <= now + 300000;
}
async function readPayload(request) {
  const advertised = request.headers.get('content-length');
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BODY)) return { tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return {};
  let length = 0, chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); return { tooLarge: true }; }
      chunks.push(value);
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) };
  } catch { return {}; }
}
async function validateRequest(request, env, now = Date.now()) {
  const url = new URL(request.url);
  if (url.pathname !== '/notify' || url.search) return { error: generic(404, 'not-found') };
  if (request.method !== 'POST') return { error: generic(405, 'method-not-allowed') };
  if (!configured(env)) return { error: generic(503, 'not-configured') };
  if (!await authorized(request, env)) return { error: generic(401, 'unauthorized') };
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || ''))
    return { error: generic(415, 'content-type') };
  const parsed = await readPayload(request);
  if (parsed.tooLarge) return { error: generic(413, 'body-too-large') };
  if (!validPayload(parsed.value, now)) return { error: generic(400, 'invalid-event') };
  return { value: parsed.value };
}
export async function issueId(value) {
  const source = JSON.stringify([value.type, value.program, value.version, value.reason, value.issueFingerprint]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), item => item.toString(16).padStart(2, '0')).join('');
}
export function emailFor(value, env) {
  const types = { 'isolation-blocked': '进入受限模式', 'upgrade-failed': '升级失败', 'rolled-back': '已自动退回' };
  const reasons = { 'fingerprint-mismatch': '验收指纹不一致', 'acceptance-failed': '候选验收失败',
    'download-failed': '获取候选版本失败', 'version-unreadable': '无法读取版本',
    'restart-failed': '服务重启失败', 'runtime-failure': '程序连续运行失败',
    interrupted: '维护被中断', unknown: '需要机主检查' };
  return { to: env.MAIL_TO, from: env.MAIL_FROM,
    subject: '[Claude Relay] ' + types[value.type],
    text: ['维护提醒：' + types[value.type], '程序：' + value.program, '版本：' + value.version,
      '原因：' + reasons[value.reason], '时间（UTC）：' + value.occurredAt,
      '', '请打开平台查看机主提示。此邮件不包含对话、日志、密码或文件内容。'].join('\n') };
}
export default {
  async fetch(request, env) {
    const checked = await validateRequest(request, env);
    if (checked.error) return checked.error;
    if (!env.MAIL_GATE?.idFromName || !env.MAIL_GATE?.get) return generic(503, 'not-configured');
    try {
      const gate = env.MAIL_GATE.get(env.MAIL_GATE.idFromName('maintenance-owner'));
      return await gate.fetch(new Request('https://internal/notify', {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: 'Bearer ' + env.NOTIFY_SECRET }, body: JSON.stringify(checked.value),
      }));
    } catch { return generic(503, 'delivery-unavailable'); }
  },
};
export class MaintenanceMailGate {
  constructor(state, env, deps = {}) { this.state = state; this.env = env; this.clock = deps.clock || Date.now; this.queue = Promise.resolve(); }
  fetch(request) {
    // 一个机主共用一个对象；串行覆盖所有 await，避免并发绕过去重和频率限制。
    const operation = this.queue.catch(() => {}).then(() => this.handle(request));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async handle(request) {
    const now = this.clock(), checked = await validateRequest(request, this.env, now);
    if (checked.error) return checked.error;
    if (!this.env.EMAIL?.send) return generic(503, 'not-configured');
    const value = checked.value, id = await issueId(value);
    try {
      const ledger = await this.state.storage.get('ledger') || { issues: {}, nextAttemptAt: 0 };
      if (!ledger.issues || typeof ledger.issues !== 'object' || Array.isArray(ledger.issues) ||
          !Number.isFinite(ledger.nextAttemptAt)) return generic(503, 'state-unavailable');
      const previous = ledger.issues[id];
      if (previous?.status === 'sent') return reply(200, { ok: true, status: 'duplicate' });
      if (now < ledger.nextAttemptAt || (previous && now < previous.nextAttemptAt))
        return generic(429, 'retry-later');
      if (!previous && Object.keys(ledger.issues).length >= MAX_ISSUES) return generic(503, 'ledger-full');
      ledger.issues[id] = { status: 'pending', nextAttemptAt: now + RETRY_MS };
      ledger.nextAttemptAt = now + SPACING_MS;
      await this.state.storage.put('ledger', ledger);
      try { await this.env.EMAIL.send(emailFor(value, this.env)); }
      catch { return generic(503, 'delivery-unavailable'); }
      ledger.issues[id] = { status: 'sent', sentAt: now };
      await this.state.storage.put('ledger', ledger);
      return reply(200, { ok: true, status: 'sent' });
    } catch { return generic(503, 'state-unavailable'); }
  }
}
