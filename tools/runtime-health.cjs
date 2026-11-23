'use strict';
// M6：诊断文本只用于排除外部原因，绝不写入健康事件。
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const tx = require('./maintenance-transaction.cjs');
const CATEGORIES = Object.freeze(['network', 'auth', 'quota', 'cancel', 'userfile', 'unknown', 'start', 'protocol', 'no-output', 'success']);
const FAULTS = Object.freeze(['start', 'protocol', 'no-output']);
const root = path.resolve(__dirname, '..');
function classifyOutcome(input = {}) {
  if (input.cancelled === true || input.kind === 'cancel') return 'cancel';
  if (input.success === true) return 'success';
  const text = String(input.failureText || '').slice(-24000);
  if (input.kind === 'auth' || /unauthori[sz]ed|unauthenticated|authentication|invalid.?api.?key|token.{0,30}expir|login.{0,20}(?:expired|required)|not logged|\b401\b|\b403\b|登录|认证|凭证/i.test(text)) return 'auth';
  if (input.kind === 'quota' || /quota|rate.?limit|overloaded|too many requests|\b429\b|usage limit|insufficient.{0,10}credit|billing|限流|额度|配额/i.test(text)) return 'quota';
  if (input.kind === 'network' || /network|timed? out|timeout|socket|fetch failed|connection|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|\b502\b|\b503\b|\b504\b|网络|超时|连接/i.test(text)) return 'network';
  if (input.kind === 'userfile' || /user.?file|invalid (?:image|pdf|file)|unsupported (?:file|format)|file too large|文件.{0,15}(?:不存在|格式|损坏|过大)/i.test(text)) return 'userfile';
  if (input.spawnError && input.executableFailure === true && ['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'ENOTDIR'].includes(input.spawnCode)) return 'start';
  if (input.protocolErrors > 0 && input.hasOutput === false) return 'protocol';
  const abnormal = Number.isInteger(input.exitCode) && input.exitCode !== 0;
  const nativeCrash = [3221225477, 3221225781, -1073741819, -1073741515].includes(input.exitCode);
  if (abnormal && input.hasOutput === false && (nativeCrash || !text.trim())) return 'no-output';
  return 'unknown';
}
function eventRecord(event, now) {
  if (!['Claude', 'Codex', 'Gemini'].includes(event.program) || typeof event.sessionId !== 'string' ||
      !event.sessionId || event.sessionId.length > 4096 || !Number.isSafeInteger(now) || now <= 0) return null;
  const startedAt = event.startedAt === undefined ? now : event.startedAt;
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > now) return null;
  const category = CATEGORIES.includes(event.category) ? event.category : classifyOutcome(event);
  return { schema: 1, program: event.program, category,
    sessionHash: crypto.createHash('sha256').update(event.program + '\0' + event.sessionId).digest('hex'), at: now, startedAt };
}
function validEvent(value) {
  return value && Object.keys(value).sort().join(',') === 'at,category,program,schema,sessionHash,startedAt' &&
    value.schema === 1 && ['Claude', 'Codex', 'Gemini'].includes(value.program) &&
    CATEGORIES.includes(value.category) && /^[a-f0-9]{64}$/.test(value.sessionHash || '') &&
    Number.isSafeInteger(value.at) && value.at > 0 && Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && value.startedAt <= value.at;
}
async function confirmSpawnContext(input, context) {
  const checked = { ...input, executableFailure: false };
  if (!input.spawnError || typeof context?.executable !== 'string' || !path.isAbsolute(context.executable) ||
      typeof input.spawnPath !== 'string' || !path.isAbsolute(input.spawnPath) ||
      path.resolve(context.executable).toLowerCase() !== path.resolve(input.spawnPath).toLowerCase()) return checked;
  try {
    if (!(await fs.stat(context.cwd)).isDirectory()) return checked;
    let executable;
    try { executable = await fs.stat(context.executable); }
    catch (error) { if (error.code !== 'ENOENT') return checked; }
    checked.executableFailure = input.spawnCode === 'ENOENT' ? !executable :
      input.spawnCode === 'ENOEXEC' && executable?.isFile() === true;
  } catch {}
  return checked;
}

const writers = new Map(), writerId = crypto.randomBytes(8).toString('hex');
function recordOutcome(event, options = {}) {
  const directory = options.eventsDir || path.join(root, 'data', 'maintenance', 'runtime-events');
  let writer = writers.get(directory);
  if (!writer) { writer = { queue: Promise.resolve(), sequence: 0n, lastAt: 0 }; writers.set(directory, writer); }
  const at = Math.max((options.clock || Date.now)(), writer.lastAt);
  writer.lastAt = at;
  const name = String(at).padStart(16, '0') + '-' + writerId + (++writer.sequence).toString(16).padStart(16, '0') + '.json';
  const operation = writer.queue.catch(() => {}).then(async () => {
    const classified = options.spawnContext ? await confirmSpawnContext(event, options.spawnContext) : event;
    const value = eventRecord(classified, at);
    if (!value) return { status: 'ignored' };
    try {
      await tx.physical(directory, true); await fs.mkdir(directory, { recursive: true }); await tx.physical(directory);
      await tx.atomicWrite(path.join(directory, name), JSON.stringify(value));
      return { status: 'recorded', category: value.category };
    } catch { return { status: 'record-failed', category: value.category }; }
  });
  writer.queue = operation.catch(() => {});
  return operation;
}
module.exports = { classifyOutcome, recordOutcome, eventRecord, validEvent, confirmSpawnContext, CATEGORIES, FAULTS };
