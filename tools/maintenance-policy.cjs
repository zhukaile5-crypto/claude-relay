'use strict';
// 维护节奏与版本退避只处理已观测到的状态，不访问网络、不接受任何文件变化。
const VERSION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 3 * VERSION_INTERVAL_MS;
const RECOVERABLE_INTERRUPTS = new Set(['sleep', 'interrupted', 'cancelled', 'budget-exhausted']);
function versionCheckDue(state, now, force = false) {
  if (force || state?.pendingUpgrade) return true;
  const last = Number(state?.lastVersionCheckAt ?? state?.lastCheckAt ?? 0);
  return !last || now - last >= VERSION_INTERVAL_MS;
}
function versionKey(program, version) {
  if (!['Claude', 'Codex'].includes(program) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw Error('无效的程序或版本标识');
  return program + '@' + version;
}
function canAttemptVersion(state, program, version, now) {
  const key = versionKey(program, version);
  const entry = state?.failedVersions?.[key], pause = state?.inconclusiveVersions?.[key];
  if (entry?.failures >= 2) return { allowed: false, reason: 'failed-twice' };
  const retryAt = Math.max(entry ? Number(entry.lastFailedAt) + FAILURE_COOLDOWN_MS : 0, pause ? Number(pause.lastAt) + FAILURE_COOLDOWN_MS : 0);
  if (now < retryAt) return { allowed: false, reason: 'cooldown', retryAt };
  return { allowed: true, reason: entry || pause ? 'retry-after-cooldown' : 'new-version' };
}
// 没有证据说明版本坏了，但重跑仍要花验收额度：只冷却，不计入两次失败上限。
function recordVersionInconclusive(state, program, version, now, { kind } = {}) {
  const key = versionKey(program, version);
  return { ...state, inconclusiveVersions: { ...(state?.inconclusiveVersions || {}), [key]: { lastAt: now, kind: kind || 'unknown' } } };
}
function recordVersionFailure(state, program, version, now, { kind, interrupted = false } = {}) {
  const next = { ...state };
  if (interrupted || RECOVERABLE_INTERRUPTS.has(kind)) return next;
  const key = versionKey(program, version), previous = state?.failedVersions?.[key];
  next.failedVersions = { ...(state?.failedVersions || {}), [key]: {
    failures: Math.min(2, (Number(previous?.failures) || 0) + 1),
    firstFailedAt: previous?.firstFailedAt ?? now,
    lastFailedAt: now, kind: kind || 'acceptance-failed',
  } };
  return next;
}
function recordVersionSuccess(state, program, version, now) {
  const key = versionKey(program, version);
  return { ...state, successfulVersions: { ...(state?.successfulVersions || {}), [key]: { verifiedAt: now } } };
}
module.exports = { VERSION_INTERVAL_MS, FAILURE_COOLDOWN_MS, versionCheckDue, canAttemptVersion, recordVersionFailure, recordVersionInconclusive, recordVersionSuccess, versionKey };
