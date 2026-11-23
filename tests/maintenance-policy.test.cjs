'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { VERSION_INTERVAL_MS: DAY, FAILURE_COOLDOWN_MS, versionCheckDue, canAttemptVersion, recordVersionFailure, recordVersionSuccess } = require('../tools/maintenance-policy.cjs');
test('M4 每日查新版且兼容旧状态，小时核对无需消费这个时钟', () => {
  const now = 1e13;
  assert.equal(versionCheckDue({ lastCheckAt: now - DAY + 1 }, now), false);
  assert.equal(versionCheckDue({ lastCheckAt: now - DAY }, now), true);
  assert.equal(versionCheckDue({ lastVersionCheckAt: now, lastHealthAt: now - DAY }, now), false);
  assert.equal(versionCheckDue({ lastVersionCheckAt: now, pendingUpgrade: true }, now), true);
});
test('M4 首次失败三天内不重复验收，满三天只允许再次尝试', () => {
  const at = 1e13, state = recordVersionFailure({}, 'Claude', '2.1.320', at);
  assert.equal(canAttemptVersion(state, 'Claude', '2.1.320', at + FAILURE_COOLDOWN_MS - 1).allowed, false);
  assert.equal(canAttemptVersion(state, 'Claude', '2.1.320', at + FAILURE_COOLDOWN_MS).allowed, true);
  assert.equal(state.failedVersions['Claude@2.1.320'].failures, 1);
});
test('M4 第二次失败永久停止自动重试这个版本，但新版不继承禁用', () => {
  let state = recordVersionFailure({}, 'Claude', '2.1.320', 1e13);
  state = recordVersionFailure(state, 'Claude', '2.1.320', 1e13 + FAILURE_COOLDOWN_MS);
  assert.deepEqual(canAttemptVersion(state, 'Claude', '2.1.320', 2e13), { allowed: false, reason: 'failed-twice' });
  assert.equal(canAttemptVersion(state, 'Claude', '2.1.321', 1e13 + FAILURE_COOLDOWN_MS).allowed, true);
});
test('M4 程序、版本状态各自独立，成功和普通状态写入不清掉失败历史', () => {
  let state = recordVersionFailure({ versions: { Claude: { pinned: '2.1.314' } } }, 'Claude', '2.1.320', 1e13);
  state = recordVersionFailure(state, 'Codex', '0.170.0', 1e13 + 1);
  state = recordVersionSuccess(state, 'Codex', '0.171.0', 1e13 + 2);
  assert.equal(state.failedVersions['Claude@2.1.320'].failures, 1);
  assert.equal(state.failedVersions['Codex@0.170.0'].failures, 1);
  assert.equal(state.versions.Claude.pinned, '2.1.314');
  assert.equal(state.successfulVersions['Codex@0.171.0'].verifiedAt, 1e13 + 2);
});
test('M4 睡眠、被中断、用户取消及总预算收尾不判为坏版本', () => {
  for (const kind of ['sleep', 'interrupted', 'cancelled', 'budget-exhausted']) {
    const state = recordVersionFailure({}, 'Codex', '0.170.0', 1e13, { kind });
    assert.equal(state.failedVersions, undefined);
  }
  assert.equal(recordVersionFailure({}, 'Claude', '2.1.320', 1e13, { interrupted: true }).failedVersions, undefined);
});
test('M4 无效身份不成为可写状态键', () => {
  assert.throws(() => canAttemptVersion({}, '__proto__', '2.0.0', 0));
  assert.throws(() => recordVersionFailure({}, 'Claude', '../anything', 0));
});
