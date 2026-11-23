'use strict';

// Gemini (Antigravity agy) integration: the tool gate, effort mapping, conversation
// resume rules and acceptance binding. Pure checks only: no agy, no model, no service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const gatePath = path.join(root, 'isolation', 'gemini-gate.js');
const { decide, RELAY_SERVER } = require(gatePath);
const checker = require('../tools/check-isolation.cjs');
const { buildModelInstructions } = require('../tools/model-instructions.cjs');
const { buildHandoff } = require('../tools/model-handoff.cjs');

function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Source boundary not found: ${start}`);
  return source.slice(a, b);
}
const schemaRoot = path.join('C:', 'relay', 'data', 'gemini-home', '.gemini', 'antigravity-cli', 'mcp', 'relay_relay');
const call = (name, args = {}) => ({ hookEventName: 'PreToolUse', toolCall: { id: 't1', name, args } });

test('gate allows only relay MCP calls, relay schema reads and web search', () => {
  assert.equal(decide(call('call_mcp_tool', { ServerName: RELAY_SERVER, ToolName: 'Read', Arguments: { file_path: 'a.txt' } }), schemaRoot), true);
  assert.equal(decide(call('read_file', { Path: path.join(schemaRoot, 'Read.json') }), schemaRoot), true);
  assert.equal(decide(call('search_web', { query: 'x' }), schemaRoot), true);
  for (const name of ['run_command', 'write_to_file', 'replace_file_content', 'view_file', 'open_browser_url', 'execute_browser_javascript',
    'send_message', 'manage_inbox', 'schedule', 'invoke_subagent', 'browser_subagent', 'read_url_content', 'generate_image', 'finish', 'ask_question', ''])
    assert.equal(decide(call(name, { CommandLine: 'whoami' }), schemaRoot), false, name);
});
test('gate refuses other MCP servers, odd tool names and reads outside the schema folder', () => {
  assert.equal(decide(call('call_mcp_tool', { ServerName: 'science_biomolecular', ToolName: 'Read' }), schemaRoot), false);
  assert.equal(decide(call('call_mcp_tool', { ServerName: RELAY_SERVER, ToolName: '../Read' }), schemaRoot), false);
  assert.equal(decide(call('call_mcp_tool', { ServerName: RELAY_SERVER }), schemaRoot), false);
  for (const p of [path.join(schemaRoot, '..', 'other', 'Read.json'), path.join(schemaRoot, 'sub', 'Read.json'), path.join(schemaRoot, 'Read.txt'),
    path.join(schemaRoot, '..', 'relay_relay2', 'Read.json'), 'relay_relay/Read.json', path.join('C:', 'Users', 'x', '.ssh', 'id_rsa')])
    assert.equal(decide(call('read_file', { Path: p }), schemaRoot), false, p);
  assert.equal(decide(call('read_file', { Path: path.join(schemaRoot, 'Read.json') }), undefined), false);
  assert.equal(decide(null, schemaRoot), false);
  assert.equal(decide({ toolCall: { name: 'call_mcp_tool', args: [] } }, schemaRoot), false);
});
test('gate rejects extra or differently-spelled argument keys (Go decodes field names case-insensitively)', () => {
  const schema = path.join(schemaRoot, 'Read.json'), secret = path.join('D:', 'other-account', 'secret.txt');
  for (const args of [
    { Path: schema, AbsolutePath: secret }, { Path: schema, path: secret }, { Path: schema, PATH: secret }, { path: schema },
    { Path: schema, StartLine: '1' }, { Path: schema, toolSummary: { x: 1 } }, { Path: schema, Uri: 'file:///' + secret },
    { Path: '\\\\server\\share\\relay_relay\\Read.json' }, { Path: path.join(schemaRoot, 'Re*d.json') }])
    assert.equal(decide(call('read_file', args), schemaRoot), false, JSON.stringify(args));
  assert.equal(decide(call('read_file', { Path: schema, StartLine: 1, EndLine: 50, toolSummary: 'read' }), schemaRoot), true);
  for (const args of [
    { ServerName: RELAY_SERVER, servername: 'science', ToolName: 'Read', Arguments: {} }, { ServerName: RELAY_SERVER, ToolName: 'Read', Server: 'x', Arguments: {} },
    { ServerName: RELAY_SERVER, ToolName: 'Read', Arguments: 'x' }, { ServerName: RELAY_SERVER, ToolName: 'Read', Arguments: [] }])
    assert.equal(decide(call('call_mcp_tool', args), schemaRoot), false, JSON.stringify(args));
  assert.equal(decide(call('search_web', { query: 'x', url: 'http://127.0.0.1' }), schemaRoot), false);
  assert.equal(decide(call('search_web', { Query: 'x' }), schemaRoot), false);
});
test('gate records only tool names and decisions in its audit file', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gate-audit-')), file = path.join(dir, 'audit.jsonl');
  try {
    spawnSync(process.execPath, [gatePath, schemaRoot, file], { input: JSON.stringify(call('run_command', { CommandLine: 'type SECRET_ARG' })), encoding: 'utf8' });
    spawnSync(process.execPath, [gatePath, schemaRoot, file], { input: JSON.stringify(call('call_mcp_tool', { ServerName: RELAY_SERVER, ToolName: 'Glob', Arguments: {} })), encoding: 'utf8' });
    const text = fs.readFileSync(file, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => [r.tool, r.decision]), [['run_command', 'deny'], ['call_mcp_tool', 'allow']]);
    assert.ok(!text.includes('SECRET_ARG'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('gate process answers allow or deny as JSON and denies malformed input', () => {
  const run = (input) => JSON.parse(spawnSync(process.execPath, [gatePath, schemaRoot], { input, encoding: 'utf8' }).stdout);
  assert.deepEqual(run(JSON.stringify(call('call_mcp_tool', { ServerName: RELAY_SERVER, ToolName: 'Glob' }))), { decision: 'allow' });
  assert.equal(run(JSON.stringify(call('run_command', { CommandLine: 'dir' }))).decision, 'deny');
  assert.equal(run('not json').decision, 'deny');
});

test('Gemini effort falls back to the nearest lower level the model has', () => {
  const context = vm.createContext({ EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'], config: { defaultEffort: 'medium' },
    gptModel: () => null, geminiModel: (id) => ({ 'gemini-a': { efforts: ['low', 'medium', 'high'] }, 'gemini-n': { efforts: ['low', 'medium', 'high', 'xhigh'] } })[id] || null });
  vm.runInContext(between('const effortOk =', 'function conversationSelection(') + '\nglobalThis.pick = pickEffort;', context);
  assert.equal(context.pick('gemini-a', 'max'), 'high');
  assert.equal(context.pick('gemini-a', 'xhigh'), 'high');
  assert.equal(context.pick('gemini-n', 'max'), 'xhigh');
  assert.equal(context.pick('gemini-n', 'ultra'), 'xhigh');
  assert.equal(context.pick('gemini-n', 'low'), 'low');
  assert.equal(context.pick('gemini-n', 'bogus'), 'medium');
  assert.equal(context.pick('sonnet', 'max'), 'max');
});
test('agy model name is the configured id plus a supported effort suffix', () => {
  const context = vm.createContext({ geminiModel: (id) => id === 'gemini-4-argon' ? { efforts: ['low', 'medium', 'high'] } : null });
  vm.runInContext(between('const geminiAgyModel =', 'function launchGemini(') + '\nglobalThis.name = geminiAgyModel;', context);
  assert.equal(context.name('gemini-4-argon', 'high'), 'gemini-4-argon-high');
  assert.equal(context.name('gemini-4-argon', 'xhigh'), 'gemini-4-argon-medium');
});

test('Gemini resumes its agy conversation only while the last Gemini answer is the one it holds', () => {
  let exists = true;
  const context = vm.createContext({ config: { isolation: { enabled: true } }, isolation: { geminiConversationExists: (u, conversationId) => exists && u.id === 'alice' && !!conversationId },
    providerOf: (model) => /^gemini-/.test(model) ? 'google' : 'anthropic' });
  vm.runInContext(between('function geminiResumeId(', 'const CONTINUE_PROMPT') + '\nglobalThis.resume = (conv) => geminiResumeId({ id: "alice" }, conv);', context);
  const id = '11111111-2222-4333-8444-555555555555';
  const conv = { geminiConvId: id, geminiTurnId: 't2', messages: [
    { role: 'user' }, { role: 'assistant', model: 'gemini-x', turnId: 't1' },
    { role: 'user' }, { role: 'assistant', model: 'gemini-x', turnId: 't2' },
    { role: 'user' }, { role: 'assistant', model: 'sonnet', turnId: 't3' }] };
  assert.equal(context.resume(conv), id, 'a later Claude turn does not break the Gemini chain');
  const starting = { ...conv, messages: [...conv.messages, { role: 'user' }, { role: 'assistant', model: 'gemini-x', turnId: 't4', status: 'running' }] };
  assert.equal(context.resume(starting), id, 'the reply being started is not the held answer');
  assert.equal(context.resume({ ...conv, messages: conv.messages.slice(0, 2) }), null, 'edit or retry removed the held answer');
  assert.equal(context.resume({ ...conv, geminiConvId: null }), null);
  exists = false; assert.equal(context.resume(conv), null, 'agy no longer has the conversation');
});
test('without a usable agy conversation, Gemini receives the full history', () => {
  const conv = { messages: [
    { role: 'user', text: '第一条要求' }, { role: 'assistant', model: 'gemini-4-neon', status: 'done', events: [{ k: 'text', text: '早先的回答' }] },
    { role: 'user', text: '第二条' }, { role: 'assistant', model: 'gemini-4-neon', status: 'running', events: [] }] };
  const options = { nonce: 'abcdefghijklmnop1234', excludeCurrent: true };
  assert.equal(buildHandoff(conv, 'google', options).text, '');
  assert.match(buildHandoff(conv, 'google', { ...options, fullHistory: true }).text, /第一条要求/);
});

test('Gemini instructions keep the runtime rules and tell the model to use only relay tools', () => {
  const text = buildModelInstructions({ provider: 'google', isolated: true, runtimeNotes: 'RUNTIME-NOTE', platform: 'PLATFORM' });
  assert.match(text, /RUNTIME-NOTE/); assert.match(text, /# Gemini tools/); assert.match(text, /relay_relay/);
  assert.match(text, /Claude, GPT or Gemini/);
});
test('acceptance binds the gate script always and the agy copy and its home only when Gemini is configured', () => {
  assert.ok(checker.SOURCE_FILES.includes('isolation/gemini-gate.js'));
  const runtime = { claudePath: 'C:\\r\\claude.exe', codexPath: 'C:\\r\\codex.exe', nodePath: process.execPath };
  const base = { users: [], isolation: { runtimeManifest: 'C:\\r\\manifest.json' } };
  const without = checker.configurationProjection(base, runtime, 'C:\\svc');
  assert.equal(without.executables.agy, undefined); assert.equal(without.geminiHome, undefined);
  const withAgy = checker.configurationProjection({ ...base, agyPath: 'C:\\fixed\\agy.exe' }, runtime, 'C:\\svc');
  assert.equal(withAgy.executables.agy, 'c:/fixed/agy.exe'); assert.equal(withAgy.geminiHome, 'c:/svc/data/gemini-home');
});

test('agy is launched with slash commands disabled and only after the profile check', () => {
  const iso = fs.readFileSync(path.join(root, 'isolation', 'index.js'), 'utf8');
  const launch = iso.slice(iso.indexOf('function launchGemini('), iso.indexOf('function spawnText('));
  assert.match(launch, /'--disable-slash-commands'/);
  assert.ok(launch.indexOf('checkGeminiProfile(home)') > 0 && launch.indexOf('checkGeminiProfile(home)') < launch.indexOf('launch(agyPath'));
  assert.match(launch, /outside every user workspace/);
});
