'use strict';
// 合成提示字符串的纯函数测试；不读真实记忆/项目，不启动模型或隔离进程。
const test = require('node:test'), assert = require('node:assert/strict');
const { buildModelInstructions, DEFAULT_MAX_CHARS, HANDOFF_RULES } = require('../tools/model-instructions.cjs');
const platform = 'SYNTHETIC_PROFILE: use Chinese, keep units and uncertainties, stay in this account workspace.';
const runtimeNotes = 'SYNTHETIC_PROTECTED_RUNTIME\nUse only account-scoped relay tools.\nNever use host desktop or direct worker networking.';
const long = prefix => Array.from({ length: 500 }, (_, i) => prefix + '-' + i + ': ' + '合成内容😀'.repeat(10)).join('\n');

test('H3 记忆和项目都超上限时，GPT 仍保留全部工具、隔离和交接说明', () => {
  const result = buildModelInstructions({ provider: 'openai', isolated: true, platform, runtimeNotes, memory: long('MEMORY'), project: long('PROJECT') });
  assert.ok(result.length <= DEFAULT_MAX_CHARS);
  for (const value of [runtimeNotes, platform, HANDOFF_RULES, 'TaskCreate, TaskUpdate, TaskList, TaskGet and Skill', 'Windows PowerShell']) assert.ok(result.includes(value), value);
  assert.ok(result.indexOf(runtimeNotes) < result.indexOf('# GPT tools'));
  assert.ok(result.indexOf('# GPT tools') < result.indexOf('MEMORY-0'));
  assert.ok(result.indexOf(HANDOFF_RULES) < result.indexOf('PROJECT-0'));
  assert.match(result, /记忆内容因长度限制有省略/); assert.match(result, /项目内容因长度限制有省略/);
  assert.doesNotMatch(result, /ToolSearch|\.venv|relay to Claude|Claude-only/);
});
test('H3 GPT 不接收传入的 Claude 专属工具用法', () => {
  const result = buildModelInstructions({ provider: 'openai', isolated: true, platform,
    claudeTools: 'Load ToolSearch first; use .venv/Scripts/python.exe from Bash; relay to Claude.' });
  assert.doesNotMatch(result, /ToolSearch|\.venv|from Bash|relay to Claude/);
  assert.match(result, /Call those tools directly/);
});
test('H3 原保护运行说明逐字保留，包括覆盖旧 .venv 路径的限制', () => {
  const notes = runtimeNotes + '\nProtected paths replace earlier .venv paths; do not fall back to the host.';
  const result = buildModelInstructions({ provider: 'openai', isolated: true, platform, runtimeNotes: notes, memory: long('MEMORY') });
  assert.ok(result.includes(notes)); assert.ok(result.indexOf(notes) < result.indexOf('# Platform and profile'));
});
test('H3 Claude 原角色与专属工具段保持原文，只增加前置运行和交接说明', () => {
  const persona = 'Treat the user as a technical peer. Reply in Chinese; show units and uncertainties. Files go in this conversation outputs.';
  const tools = 'For two or more steps first load TaskCreate/TaskUpdate via ToolSearch. Mark each task in_progress/completed. Python libraries are in .venv.';
  const result = buildModelInstructions({ provider: 'anthropic', platform: persona, claudeTools: tools, runtimeNotes,
    memory: '# Memory\nSYNTHETIC_MEMORY', project: '# Project\nSYNTHETIC_PROJECT' });
  assert.ok(result.includes(persona)); assert.ok(result.includes(tools)); assert.ok(result.includes(runtimeNotes));
  assert.match(result, /existing local subscription login/); assert.doesNotMatch(result, /# GPT tools|existing API connection/);
  assert.ok(result.indexOf(tools) < result.indexOf(persona));
  assert.ok(result.endsWith('# Memory\nSYNTHETIC_MEMORY\n\n# Project\nSYNTHETIC_PROJECT'));
});
test('H3 原短记忆和项目逐字保留，未超预算不虚报截断', () => {
  const memory = '\n\n# Memory\n合成记忆。', project = '\n\n# Project: 合成项目\n保留原资料路径。';
  const result = buildModelInstructions({ provider: 'openai', platform, memory, project });
  assert.ok(result.includes(memory)); assert.ok(result.endsWith(project)); assert.doesNotMatch(result, /因长度限制/);
});
test('H3 关闭记忆且没有项目时不增加任何记忆、记录路径或省略提示', () => {
  const result = buildModelInstructions({ provider: 'openai', isolated: true, platform, runtimeNotes });
  assert.doesNotMatch(result, /# Memory|# Project|\.memory|记忆内容|项目内容/);
  assert.ok(result.includes('this account and this conversation only'));
});
test('H3 配额不足时按完整行保留，不切开路径、中文或表情', () => {
  const base = buildModelInstructions({ provider: 'openai', platform });
  const memory = 'FIRST_COMPLETE_LINE\n' + 'SECOND_VERY_LONG_LINE_' + '😀'.repeat(200) + '\nSHOULD_NOT_SKIP_FORWARD';
  const result = buildModelInstructions({ provider: 'openai', platform, memory, maxChars: base.length + 100 });
  assert.ok(result.length <= base.length + 100); assert.match(result, /FIRST_COMPLETE_LINE/);
  assert.doesNotMatch(result, /SECOND_VERY|SHOULD_NOT_SKIP_FORWARD/);
  assert.match(result, /记忆内容因长度限制有省略/);
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result), false);
});
test('H3 单行超长上下文整体省略，不截成可能改变含义的半句话', () => {
  const base = buildModelInstructions({ provider: 'anthropic', platform });
  const result = buildModelInstructions({ provider: 'anthropic', platform, memory: 'UNBROKEN_' + '字'.repeat(40000), maxChars: base.length + 500 });
  assert.doesNotMatch(result, /UNBROKEN_/); assert.match(result, /记忆内容因长度限制有省略/);
  assert.ok(result.length <= base.length + 500);
});
test('H3 两块都有额度，较短项目未用完的额度留给记忆', () => {
  const base = buildModelInstructions({ provider: 'openai', platform });
  const memory = Array.from({ length: 50 }, (_, i) => 'MEM' + i + ' ' + '字'.repeat(40)).join('\n');
  const result = buildModelInstructions({ provider: 'openai', platform, memory, project: 'PROJECT_COMPLETE', maxChars: base.length + 1000 });
  assert.ok(result.includes('PROJECT_COMPLETE')); assert.ok(result.includes('MEM18 '));
  assert.doesNotMatch(result, /项目内容因长度限制/); assert.ok(result.length <= base.length + 1000);
});
test('H3 固定平台超过软预算仍完整，不能截掉权限规则和技能清单', () => {
  const fixed = 'FIXED_START\n' + '平台固定规则。'.repeat(5000) + '\nFIXED_END';
  const result = buildModelInstructions({ provider: 'openai', isolated: true, platform: fixed, runtimeNotes,
    skills: [{ name: 'synthetic-skill', desc: '合成文档技能', file: 'allowed/skills/example/SKILL.md' }],
    memory: 'PRIVATE_CONTEXT_' + '字'.repeat(1000), project: 'PROJECT_CONTEXT_' + '字'.repeat(1000), maxChars: 100 });
  assert.ok(result.length > 100); assert.ok(result.includes(fixed)); assert.ok(result.includes(runtimeNotes));
  assert.ok(result.includes('allowed/skills/example/SKILL.md')); assert.ok(result.includes(HANDOFF_RULES));
  assert.doesNotMatch(result, /PRIVATE_CONTEXT_|PROJECT_CONTEXT_/);
  assert.match(result, /记忆内容因长度限制有省略/); assert.match(result, /项目内容因长度限制有省略/);
});
test('H3 非隔离 GPT 不宣称存在 relay MCP 工具或 Claude 专属工具', () => {
  const result = buildModelInstructions({ provider: 'openai', platform, isolated: false });
  assert.match(result, /available planning tool/); assert.doesNotMatch(result, /TaskCreate|ToolSearch|relay MCP|\.venv|Claude-only/);
});
test('H3 输入不变且重复调用输出完全一致', () => {
  const options = Object.freeze({ provider: 'openai', isolated: true, platform, runtimeNotes, memory: long('M'), project: long('P'),
    skills: Object.freeze([Object.freeze({ name: 'skill', desc: '合成技能', file: 'skills/test/SKILL.md' })]) });
  const before = JSON.stringify(options), a = buildModelInstructions(options), b = buildModelInstructions(options);
  assert.equal(a, b); assert.equal(JSON.stringify(options), before);
});
test('H3 拒绝无效提供方、预算和块类型，不隐式把对象变成提示', () => {
  for (const patch of [{ provider: 'unknown' }, { maxChars: 0 }, { maxChars: NaN }, { maxChars: 1.2 }, { platform: {} }, { memory: [] }, { project: {} }, { skills: 'bad' }]) {
    assert.throws(() => buildModelInstructions({ provider: 'openai', platform, ...patch }));
  }
});

test('H3 固定规则耗尽预算时，短上下文也省略而不是偷偷挤入', () => {
  const result = buildModelInstructions({ provider: 'openai', platform, memory: 'SHORT_MEMORY', project: 'SHORT_PROJECT', maxChars: 1 });
  assert.ok(result.includes(platform)); assert.doesNotMatch(result, /SHORT_MEMORY|SHORT_PROJECT/);
  assert.match(result, /记忆内容因长度限制有省略/); assert.match(result, /项目内容因长度限制有省略/);
});

test('PowerShell 拒绝访问只附加说明，原始错误和退出码保留，其他结果不变', () => {
  const { shellResult } = require('../isolation/mcp.js');
  const denied = shellResult(JSON.stringify({ exitCode: 0, stdout: 'done', stderr: 'New-Item : Access is denied' }));
  assert.equal(denied.exitCode, 0); assert.equal(denied.stderr, 'New-Item : Access is denied'); assert.match(denied.note, /does not prove failure/);
  assert.equal(shellResult(JSON.stringify({ exitCode: 1, stdout: '', stderr: 'syntax error' })).note, undefined);
  assert.equal(shellResult(JSON.stringify({ exitCode: 0, stdout: 'Access is denied', stderr: '' })).note, undefined);
  assert.equal(shellResult('不是 JSON'), '不是 JSON');
  const late = shellResult(JSON.stringify({ exitCode: null, stdout: '', stderr: '', error: 'spawnSync powershell ETIMEDOUT' }), 1000);
  assert.equal(late.error, 'spawnSync powershell ETIMEDOUT'); assert.match(late.note, /1000 ms.*milliseconds/);
  assert.equal(shellResult(JSON.stringify({ exitCode: 0, stdout: 'ETIMEDOUT', stderr: '' }), 1000).note, undefined);
});
