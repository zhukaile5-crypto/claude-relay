'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { canRecoverSession, isMissingSessionError, hasToolEvents, RECOVERY_NOTICE } = require('../tools/model-session-recovery.cjs');
// 实测于 2026-11-01：固定程序 Claude 2.1.316、Codex 0.166.0。只用合成 UUID。
const id = 'af146508-4562-47d2-8461-a9ab183d6af6';
const observedClaude = 'No conversation found with session ID: ' + id;
const observedCodex = 'Error: thread/fork: thread/fork failed: no rollout found for thread id ' + id + ' (code -32600)';
const claudeResult = { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: [observedClaude] };
const probe = (provider = 'anthropic') => ({ provider, resumeId: id, attempt: 0, cancelled: false, events: [], toolEventCount: 0,
  stderr: (provider === 'anthropic' ? observedClaude : observedCodex) + '\n', exitCode: 1 });
test('H4 实测 Claude 缺失会话 stderr 允许一次同提供方恢复', () => assert.equal(canRecoverSession(probe()), true));
test('H4 实测 Codex fork 缺失 rollout 允许一次同提供方恢复', () => assert.equal(canRecoverSession(probe('openai')), true));
test('H4 Claude 结构化零轮次错误也能识别，普通回答不能伪造它', () => {
  const p = { ...probe(), stderr: '', result: claudeResult };
  assert.equal(canRecoverSession(p), true);
  for (const result of [observedClaude, { result: observedClaude }, { ...claudeResult, is_error: false },
    { ...claudeResult, num_turns: 1 }, { ...claudeResult, subtype: 'success' }, { ...claudeResult, errors: [observedClaude, '401 Unauthorized'] }])
    assert.equal(canRecoverSession({ ...p, result }), false);
});
test('H4 不同会话、非法会话或未知提供方不会恢复', () => {
  for (const resumeId of ['', 'not-a-uuid', 'af146508-4562-47d2-8461-a9ab183d6af7', undefined])
    assert.equal(canRecoverSession({ ...probe(), resumeId }), false);
  assert.equal(canRecoverSession({ ...probe(), provider: 'unknown' }), false);
  assert.equal(canRecoverSession({ ...probe('openai'), stderr: observedClaude }), false);
});
test('H4 必须显式为首次尝试，恢复错误不形成循环', () => {
  for (const attempt of [1, 2, -1, undefined, null, '0']) assert.equal(canRecoverSession({ ...probe(), attempt }), false);
  assert.equal(canRecoverSession(), false);
});
test('H4 已取消、成功退出、未确定退出状态或缺失事件列表均不恢复', () => {
  assert.equal(canRecoverSession({ ...probe(), cancelled: true }), false);
  for (const exitCode of [0, null, undefined, '1']) assert.equal(canRecoverSession({ ...probe(), exitCode }), false);
  for (const events of [undefined, null, {}]) assert.equal(canRecoverSession({ ...probe(), events }), false);
});
test('H4 任何规范化工具、工具结果、任务清单或原始工具事件阻止重做', () => {
  const events = [{ k: 'tool' }, { k: 'tool_result' }, { k: 'plan' }, { type: 'tool_use' }, { type: 'tool_result' },
    { type: 'item.started', item: { type: 'command_execution' } }, { type: 'item.completed', item: { type: 'file_change' } },
    { type: 'item.started', item: { type: 'mcp_tool_call' } }, { type: 'item.completed', item: { type: 'todo_list' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }];
  for (const event of events) { assert.equal(hasToolEvents([event]), true); assert.equal(canRecoverSession({ ...probe(), events: [event] }), false); }
  assert.equal(canRecoverSession({ ...probe(), toolEventCount: 1 }), false);
  assert.equal(canRecoverSession({ ...probe(), toolEventCount: -1 }), false);
});
test('H4 thinking 和普通文本不会被误认工具，但其文本不能成为错误证据', () => {
  const events = [{ k: 'thinking', text: 'synthetic' }, { k: 'text', text: observedClaude }];
  assert.equal(hasToolEvents(events), false);
  assert.equal(canRecoverSession({ ...probe(), stderr: '', events }), false);
});
test('H4 网络、额度、认证、用户文件及泛化 not found 均不得重试', () => {
  for (const stderr of ['401 Unauthorized', 'insufficient_quota', 'budget exceeded', 'ECONNRESET', 'timed out',
    'File not found', 'Session not found', 'No conversation found', 'no rollout found', 'fork failed',
    observedClaude + '\n401 Unauthorized', 'Quoted: ' + observedClaude]) assert.equal(canRecoverSession({ ...probe(), stderr }), false, stderr);
});
test('H4 原始错误仅容忍空白和 UUID 大小写，精确匹配实测诊断', () => {
  assert.equal(canRecoverSession({ ...probe(), stderr: '\r\n' + observedClaude + '\r\n' }), true);
  assert.equal(canRecoverSession({ ...probe(), resumeId: id.toUpperCase() }), true);
  assert.equal(isMissingSessionError({ provider: 'openai', resumeId: id, stderr: observedCodex.replace('-32600', '-32603') }), false);
});
test('H4 恢复提示固定、不回显会话 ID、路径或内部错误', () => {
  assert.equal(RECOVERY_NOTICE, '原会话不可用，已从对话记录恢复');
  assert.equal(RECOVERY_NOTICE.includes(id), false);
});

test('H4 原始工具参数增量和子任务来源即阻止恢复，不依赖完整start事件', () => {
  const raw = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } },
    { type: 'input_json_delta', partial_json: '{' },
    { type: 'assistant', parent_tool_use_id: 'synthetic-parent', message: { content: [{ type: 'text', text: 'child work' }] } },
  ];
  for (const event of raw) { assert.equal(hasToolEvents([event]), true); assert.equal(canRecoverSession({ ...probe(), events: [event] }), false); }
  assert.equal(hasToolEvents([{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'normal text' }] } }]), false);
});

test('H4 stderr匹配也不能掩盖结构化额度、网络或认证错误', () => {
  for (const error of ['insufficient_quota', 'network connection reset', '401 Unauthorized']) {
    assert.equal(canRecoverSession({ ...probe(), result: { ...claudeResult, result: error, errors: [error] } }), false);
    assert.equal(canRecoverSession({ ...probe(), result: { ...claudeResult, result: error } }), false);
  }
  assert.equal(canRecoverSession({ ...probe(), result: claudeResult }), true);
  assert.equal(canRecoverSession({ ...probe(), result: { ...claudeResult, num_turns: 1 } }), false);
  assert.equal(canRecoverSession({ ...probe('openai'), result: claudeResult }), false);
});

test('H4 规范化错误若非同一缺失诊断不得重试，不能单独作为恢复依据', () => {
  for (const errorText of ['insufficient_quota', 'budget exceeded', 'timed out', '401 Unauthorized', 'file not found', {}])
    assert.equal(canRecoverSession({ ...probe(), errorText }), false);
  assert.equal(canRecoverSession({ ...probe(), errorText: observedClaude }), true);
  assert.equal(canRecoverSession({ ...probe('openai'), errorText: observedCodex }), true);
  assert.equal(canRecoverSession({ ...probe(), stderr: '', errorText: observedClaude }), false);
});
