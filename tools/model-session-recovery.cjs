'use strict';
// H4：仅识别本机固定程序实测到的缺失会话错误，不把网络、认证或任意 not found 当作恢复依据。
// 2026-11-01：Claude Code 2.1.316 / codex-cli 0.166.0，随机不存在 UUID，均退出 1、无工具。
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RECOVERY_NOTICE = '原会话不可用，已从对话记录恢复';
const TOOL_KINDS = new Set(['tool', 'tool_result', 'plan']);
const TOOL_TYPES = new Set(['tool_use', 'tool_result', 'command_execution', 'mcp_tool_call', 'dynamic_tool_call',
  'function_call', 'function_call_output', 'code_execution', 'file_change', 'web_search', 'todo_list', 'input_json_delta']);
function hasToolEvents(events) {
  if (!Array.isArray(events)) return true; // 没有完整事件列表时不推定可以重试。
  return events.some(event => event && (TOOL_KINDS.has(event.k) || TOOL_TYPES.has(event.type) ||
    (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null && event.parent_tool_use_id !== '') ||
    TOOL_TYPES.has(event.item?.type) || TOOL_TYPES.has(event.event?.content_block?.type) || TOOL_TYPES.has(event.event?.delta?.type) ||
    TOOL_TYPES.has(event.delta?.type) || (Array.isArray(event.message?.content) && event.message.content.some(item => TOOL_TYPES.has(item?.type)))));
}
function missingSessionMessage(provider, resumeId) {
  if (typeof resumeId !== 'string' || !UUID.test(resumeId)) return null;
  if (provider === 'anthropic') return 'No conversation found with session ID: ' + resumeId;
  if (provider === 'openai') return 'Error: thread/fork: thread/fork failed: no rollout found for thread id ' + resumeId + ' (code -32600)';
  return null;
}
function isMissingSessionError({ provider, resumeId, stderr = '', result }) {
  const expected = missingSessionMessage(provider, resumeId);
  if (!expected || typeof stderr !== 'string') return false;
  const matches = value => typeof value === 'string' && value.trim().toLowerCase() === expected.toLowerCase();
  const diagnostic = stderr.trim();
  // stderr 和结构化错误必须彼此一致，不能让一个缺会话诊断掩盖额度/网络/认证错误。
  if (diagnostic && !matches(diagnostic)) return false;
  if (result !== undefined && result !== null) {
    // Claude 实测提供零轮次 errors；Codex 未实测到这种结构，不猜测接受。
    if (provider !== 'anthropic' || typeof result !== 'object' || result.type !== 'result' ||
        result.subtype !== 'error_during_execution' || result.is_error !== true || result.num_turns !== 0 ||
        !Array.isArray(result.errors) || result.errors.length !== 1 || !matches(result.errors[0]) ||
        (result.result !== undefined && result.result !== '' && !matches(result.result))) return false;
    return true;
  }
  return !!diagnostic;
}
function canRecoverSession({ provider, resumeId, attempt, cancelled, events, toolEventCount = 0, stderr = '', result, errorText = '', exitCode } = {}) {
  if (attempt !== 0 || cancelled || !Number.isInteger(exitCode) || exitCode === 0 ||
      !Number.isInteger(toolEventCount) || toolEventCount !== 0 || hasToolEvents(events)) return false;
  const expected = missingSessionMessage(provider, resumeId);
  if (typeof errorText !== 'string' || (errorText.trim() && (!expected || errorText.trim().toLowerCase() !== expected.toLowerCase()))) return false;
  return isMissingSessionError({ provider, resumeId, stderr, result });
}
module.exports = { canRecoverSession, isMissingSessionError, hasToolEvents, RECOVERY_NOTICE };
