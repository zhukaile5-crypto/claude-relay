'use strict';
// 合同测试只加载纯导出及模拟验收结果，不启动服务、进程或模型。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const probe = require('./acceptance/probe-model-handoff.cjs'), core = require('../tools/full-acceptance-core.cjs');
test('model-handoff 仅有两种低档真实验收型号（Claude 和 Gemini，GPT 已退出平台），且必需检查与独立验收名单完全一致', () => {
  assert.deepEqual(probe.MODELS, { anthropic: 'haiku', google: 'gemini-4-neon' });
  const step = core.STEPS.find(s => s.id === 'model-handoff');
  assert.equal(step.costly, true); assert.deepEqual(step.requiredChecks, [...probe.REQUIRED_CHECKS]);
  assert.equal(step.script, 'tests/acceptance/probe-model-handoff.cjs');
  assert.ok(core.STEPS.indexOf(step) > core.STEPS.findIndex(s => s.id === 'gemini') && core.STEPS.findIndex(s => s.id === 'gemini') >= 0);
  assert.deepEqual(step.answerChecks, ['claudeRecovery', 'geminiRecovery']);
  for (const name of probe.REQUIRED_CHECKS) assert.doesNotMatch(name, /gpt/i, name);
  // 探针自己的总预算要比步骤超时短，留出清理和写报告的时间
  assert.ok(probe.PROBE_BUDGET_MS + 5 * 60e3 <= step.timeoutMs);
  const checks = Object.fromEntries(probe.REQUIRED_CHECKS.map(name => [name, true]));
  assert.equal(core.evaluate(step, { status: 0, report: { checks } }).passed, true);
  for (const name of probe.REQUIRED_CHECKS) { const missing = { ...checks }; delete missing[name]; assert.equal(core.evaluate(step, { status: 0, report: { checks: missing } }).passed, false, name); }
  assert.equal(core.evaluate(step, { status: 1, report: { checks } }).passed, false);
  assert.equal(core.evaluate(step, { status: 0, report: { checks, failure: 'synthetic' } }).passed, false);
});
test('合成配置只在内存里沿用正式配置，替换所有账号、数据根、登录和外部副作用入口；不开 GPT，两个账号都用 Gemini', () => {
  const original = { secret: 'ORIGINAL_SECRET', openaiApiKey: 'SYNTHETIC_ONLY_API_KEY', users: [{ id: 'real-person', workDir: 'C:/real' }],
    workDir: 'C:/real', gptUsers: ['real-person'], geminiUsers: ['real-person'], agyPath: 'C:/pinned/agy.exe', prewarm: true, tunnel: { enabled: true }, wake: { alwaysAwake: true }, petHook: 'real-hook',
    isolation: { privateRoot: 'C:/real-private', gptHome: 'C:/real-gpt', geminiHome: 'C:/real-gemini' }, extraArgs: ['--fallback-model', 'large'] };
  const before = JSON.stringify(original), stage = path.join(os.tmpdir(), 'synthetic-model-probe'), c = probe.fixtureConfig(original, stage, 'C:/runtime/manifest.json');
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(c.secret, original.secret);
  assert.deepEqual(c.users.map(u => u.id), ['alice', 'bob']); assert.deepEqual(c.gptUsers, []); assert.deepEqual(c.gptModels, []);
  assert.deepEqual(c.geminiUsers, ['alice', 'bob']); assert.deepEqual(c.geminiModels.map(m => [m.id, m.efforts]), [['gemini-4-neon', ['low']]]);
  assert.equal(c.agyPath, original.agyPath, 'Gemini 用正式配置里的 agy 固定副本');
  // GPT 已退出平台：合成配置本身必须能过门槛这一条（probe-gemini.cjs 也用这份配置）
  assert.equal(require('../tools/check-isolation.cjs').gptRetirementReason(c), null);
  for (const u of c.users) { assert.equal(path.dirname(u.workDir), stage); assert.equal(u.password, 'SYNTHETIC_LOCAL_TEST_ONLY'); }
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 0); assert.equal(c.prewarm, false); assert.equal(c.tunnel.enabled, false);
  assert.equal(c.wake, undefined); assert.equal(c.petHook, ''); assert.equal(c.academicSearch, false); assert.deepEqual(c.extraArgs, []);
  for (const key of ['privateRoot', 'gptHome', 'geminiHome']) assert.equal(path.dirname(c.isolation[key]), stage, key);
  assert.equal(c.defaultModel, 'haiku'); assert.equal(c.defaultEffort, 'low');
});
test('合成目录必须是本副本data下面的独立物理目录，拒绝其他路径和联接', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-contract-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, 'data'); fs.mkdirSync(data); const good = fs.mkdtempSync(path.join(data, 'model-handoff-'));
  assert.equal(probe.verifyStage(good, base), good);
  for (const bad of [data, path.join(base, 'model-handoff-other'), path.join(data, 'model-handoff-../outside'), path.join(data, 'ordinary')]) assert.throws(() => probe.verifyStage(bad, base));
  const link = path.join(data, 'model-handoff-link');
  fs.symlinkSync(good, link, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => probe.verifyStage(link, base));
  fs.unlinkSync(link);
});
test('所有普通断言和未知失败属于check，不能伪装成网络错误反复花额度', () => {
  assert.deepEqual(probe.failureKind(Error('synthetic assertion')), { stage: 'check', kind: 'model-handoff-assertion' });
  for (const stage of ['check', 'boundary', 'infrastructure', 'model', 'interruption', 'model-answer']) assert.equal(probe.failureKind({ failureKind: { stage, kind: 'synthetic' } }).stage, stage);
  assert.equal(probe.failureKind({ failureKind: { stage: 'invented', kind: 'network' } }).stage, 'check');
});
test('图片夹具是真实左红右蓝PNG，不需要Python或图片服务', () => {
  const bytes = probe.redBluePng(); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8, idat, width, height;
  while (offset < bytes.length) { const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString(), value = bytes.subarray(offset + 8, offset + 8 + length); if (type === 'IHDR') { width = value.readUInt32BE(); height = value.readUInt32BE(4); } if (type === 'IDAT') idat = value; offset += length + 12; }
  assert.equal(width, 160); assert.equal(height, 80); const raw = zlib.inflateSync(idat);
  assert.deepEqual([...raw.subarray(1, 4)], [255, 0, 0]); assert.deepEqual([...raw.subarray(1 + 159 * 3, 4 + 159 * 3)], [0, 0, 255]);
});
test('探针保留真实模型入口，只有明确合成配置和辅助副作用替换；不执行维护或外部配置写入', () => {
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /purpose: 'synthetic-fixture-only'/);
  assert.match(text, /--config-source=/); assert.match(text, /globalThis\.__relayModelHandoffConfig/);
  assert.doesNotMatch(text, /writeFileSync\(configSource|maintain\.cjs|refresh-isolation-receipt|full-acceptance\.cjs|spawnSync\([^\n]*python/i);
  assert.doesNotMatch(text, /Claude云端传输/);
  assert.match(text, /handoff\.buildHandoff = function/); assert.match(text, /const result = build\(conv, provider, options\)/);
  assert.match(text, /--serve/); assert.match(text, /windowsHide: true/);
});

test('合成请求固定低档型号、显式禁止危险执行，轮次以唯一turnId识别', () => {
  assert.match(probe.SAFETY_PROMPT, /仅可使用Read、Write/);
  assert.match(probe.SAFETY_PROMPT, /禁止Python、安装器、包管理器、GUI\/UI/);
  assert.match(probe.SAFETY_PROMPT, /不改用其他程序或执行方式/);
  assert.equal(probe.matchesTurn({ turnId: 'a', startedAt: 5 }, { turnId: 'b', startedAt: 5 }), false);
  assert.equal(probe.matchesTurn({ turnId: 'a', startedAt: 5 }, { turnId: 'a', startedAt: 6 }), true);
  assert.equal(probe.matchesTurn({}, {}), false);
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /\.\.\.extra, message: SAFETY_PROMPT/);
  assert.match(text, /process.once\('disconnect'/);
  // Gemini 比 GPT 慢：总预算从 35 分钟放宽到 70 分钟，每轮最多等 5 分钟（和 probe-gemini 一样）
  assert.match(text, /PROBE_BUDGET_MS = 70 \* 60e3/); assert.equal(probe.PROBE_BUDGET_MS, 70 * 60e3);
  assert.equal(probe.TURN_WAIT_MS, 300000); assert.match(text, /TURN_WAIT_MS, 50\)/);
});

test('原 GPT 双账号探针已删除；和模型无关的跨账号发送检查挪到 model-handoff，其余由 gemini 步骤覆盖', () => {
  assert.equal(core.STEPS.some(s => s.id === 'gpt-accounts' || /gpt/i.test(s.script)), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'acceptance/probe-gpt-accounts.cjs')), false);
  assert.ok(probe.REQUIRED_CHECKS.includes('crossConversationIsolated'));
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /check\('crossConversationIsolated', cross\.status === 404 && \(await getConv\(accountIds\.alice\)\)\.messages\.length === countBefore\)/);
  const gemini = core.STEPS.find(s => s.id === 'gemini');
  for (const name of ['aliceSeesGemini', 'bobSeesGemini', 'distinctConversations', 'noMemoryLeak', 'noFileLeak', 'forgedConversationIgnored', 'conversationDenied', 'fileDenied', 'aliceContinues', 'profilesSeparated'])
    assert.ok(gemini.requiredChecks.includes(name), name);
  const geminiText = fs.readFileSync(path.join(__dirname, 'acceptance/probe-gemini.cjs'), 'utf8');
  assert.match(geminiText, /fixtureConfig\(original, stage, manifest\)/);
});

test('Gemini 被闸门拦下的自带工具不算本轮工具失败，也不能冒充 relay 的 Read；没被拦下的报出来', () => {
  assert.deepEqual([...probe.RELAY_TOOLS].sort(), [...require('../isolation/mcp').tools.map(t => t.name), 'WebSearch'].sort());
  const events = [{ k: 'tool', id: 'gemini-1', name: 'read_file' }, { k: 'tool_result', id: 'gemini-1', error: true, preview: 'denied by hook' },
    { k: 'tool', id: 'gemini-2', name: 'Read' }, { k: 'tool_result', id: 'gemini-2', error: false, preview: 'ok' }, { k: 'text', text: '读到了' }];
  const screened = probe.withoutDeniedBuiltins({ status: 'done', provider: 'google', events });
  assert.deepEqual(screened.attempts, [{ name: 'read_file', denied: true }]); assert.deepEqual(screened.escaped, []);
  assert.deepEqual(screened.msg.events.map(e => e.id || e.k), ['gemini-2', 'gemini-2', 'text']);
  assert.equal(probe.toolTurnResolved(screened.msg).ok, true);
  // 只试了自带的 read_file（被拦下）而没用 relay 的 Read：拿掉之后不再算「用过 Read」
  const onlyBuiltin = probe.withoutDeniedBuiltins({ status: 'done', events: events.slice(0, 2) });
  assert.equal(onlyBuiltin.msg.events.some(e => e.k === 'tool'), false);
  const escaped = probe.withoutDeniedBuiltins({ status: 'done', events: [{ k: 'tool', id: 'gemini-3', name: 'run_command' }, { k: 'tool_result', id: 'gemini-3', error: false, preview: 'ran' }] });
  assert.deepEqual(escaped.escaped, ['run_command']);
  const unanswered = probe.withoutDeniedBuiltins({ status: 'done', events: [{ k: 'tool', id: 'gemini-4', name: 'view_file' }] });
  assert.deepEqual(unanswered.attempts, [{ name: 'view_file', denied: null }]); assert.deepEqual(unanswered.escaped, []);
  const plain = { status: 'done', events: events.slice(2) }; assert.equal(probe.withoutDeniedBuiltins(plain).msg, plain);
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /if \(screened\.escaped\.length\) throw Object\.assign\(Error\('Gemini 自带工具没有被闸门拦下'\), \{ failureKind: \{ stage: 'boundary', kind: 'boundary' \} \}\)/);
});

test('文件存在不能掩盖工具失败或模型报告失败，PowerShell嵌套结果也要检查', () => {
  const make = (preview, text = '已写入文件', error = false) => ({ status: 'done', result: text, events: [{ k: 'tool', name: 'PowerShell' }, { k: 'tool_result', preview, error }] });
  assert.equal(probe.firstTurnSucceeded(make('{"exitCode":0,"stdout":"","stderr":""}')), true);
  for (const m of [make('{"exitCode":0,"stderr":"Access is denied"}'), make('{"exitCode":1,"stderr":""}'), make('ok', '无法写入文件，文件没有生成'), make('ok', '已写入文件', true), { status: 'done', result: '已写入文件', events: [{ k: 'tool' }] }]) assert.equal(probe.firstTurnSucceeded(m), false);
  assert.equal(probe.toolTurnOutcome(make('{"exitCode":0,"stderr":"Access is denied"}')).failed, true);
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /scenario === 'full'/);
  assert.match(text, /requiredForRun\.every/);
  assert.match(text, /firstTurnSucceeded\(first\.msg\)/);
});

test('H9真实探针保留原17项（GPT 一方换成 Gemini）并增两项，定向协作不能冒充全流程报告', () => {
  for (const name of ['syntheticAccounts', 'claudeToolFile', 'fastSwitch', 'geminiReadPreviousFile', 'claudeReturnReadsGeminiFile', 'stoppedWorkPreserved', 'editedHistoryClean', 'projectHandoff', 'imageRead', 'longHistoryBounded', 'memoryOffNoTranscript', 'bothAccountsSwitchIsolated', 'conversationDenied', 'claudeRecovery', 'geminiRecovery', 'handoffExample', 'cleanupConfirmed']) assert.ok(probe.REQUIRED_CHECKS.includes(name), name);
  assert.ok(probe.REQUIRED_CHECKS.includes('oneShotRetry')); assert.ok(probe.REQUIRED_CHECKS.includes('crossProviderReview'));
  assert.equal(probe.REQUIRED_CHECKS.length, 20, '原 19 项 + 从 gpt-accounts 挪来的 crossConversationIsolated');
  const step = core.STEPS.find(s => s.id === 'model-handoff');
  const subset = { syntheticAccounts: true, oneShotRetry: true, crossProviderReview: true, originalModelAfterReview: true, cleanupConfirmed: true };
  assert.equal(core.evaluate(step, { status: 0, report: { checks: subset } }).passed, false);
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /retryWithModel: true, retryTurnId: initial\.msg\.turnId, fromIndex: 0/);
  assert.match(text, /action: 'review', reviewIndex: initial\.conv\.messages\.length - 1, reviewTurnId: initial\.msg\.turnId/);
  assert.match(text, /reviewUser\.text === fixedPrompt/);
  assert.match(text, /next\.msg\.model === MODELS\.anthropic/);
  assert.match(text, /failedTurnEvidence/);
});

test('接力的另一方是 Gemini：所有被接手的轮次和检查都指向 Gemini，Gemini 的恢复走「开新 agy 对话 + 从第一轮交接」', () => {
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.doesNotMatch(text, /MODELS\.openai|gpt-6|codexThreadId/);
  assert.doesNotMatch(text, /[,(]\s*'openai'\s*[,)]/, '没有任何一轮或一次核对用 GPT');
  assert.match(text, /!state\.models\.some\(m => m\.provider === 'openai'\)/, '合成账号看不到 GPT');
  assert.match(text, /check\('editedHistoryClean'[^\n]*capture\(firstId, 'google'\)/);
  assert.match(text, /check\('longHistoryBounded', !!longPack && Number\.isSafeInteger\(longPack\.maxChars\)[^\n]*longPack\.text\.length <= longPack\.maxChars && longPack\.stats\.truncated/);
  assert.match(text, /freshConversation: !!fresh && fresh !== missing, fromFirstTurn: pack\?\.stats\?\.recovered === true/);
  assert.match(text, /\{ geminiConvId: missing, geminiTurnId: heldTurn \}/);
  assert.match(text, /aliceGemini !== bobGemini && inProfile\('alice', aliceGemini\) && !inProfile\('bob', aliceGemini\)/);
  // 合成服务里的「换会话编号」夹具只剩 Claude 一种
  assert.match(text, /f\.provider!=='anthropic'/);
});

test('固定复核会覆盖用户文本，合成服务另在实际模型指令结果末尾追加安全限制', () => {
  const text = fs.readFileSync(path.join(__dirname, 'acceptance/probe-model-handoff.cjs'), 'utf8');
  assert.match(text, /syntheticOriginalModelInstructions=modelInstructions/);
  assert.match(text, /syntheticOriginalModelInstructions\(u,pid,provider\)/);
  assert.match(text, /JSON\.stringify\(SAFETY_PROMPT\)/);
  assert.match(text, /testOnlyInstructionAppend: true/);
});

test('工具报错后：最后一步真失败才算没解决，第一轮仍要求完全干净', () => {
  const { toolTurnResolved, firstTurnSucceeded } = require('./acceptance/probe-model-handoff.cjs');
  const denied = { k: 'tool_result', id: 'a', preview: JSON.stringify({ exitCode: 1, stdout: '', stderr: 'Get-Content : Access is denied' }) };
  const good = { k: 'tool_result', id: 'b', preview: JSON.stringify({ exitCode: 0, stdout: '704', stderr: '' }) };
  const tools = [{ k: 'tool', id: 'a', name: 'PowerShell' }, { k: 'tool', id: 'b', name: 'PowerShell' }];
  const turn = (results, text) => ({ status: 'done', result: text, events: [...tools, ...results, { k: 'text', text }] });
  const missing = { k: 'tool_result', id: 'b', error: true, preview: 'ENOENT: no such file' };
  assert.deepEqual(toolTurnResolved(turn([denied, good], '已写入文件')), { ok: true, corrected: 1, denied: 1, missing: 0 });
  assert.equal(toolTurnResolved(turn([good, denied], '已写入文件')).ok, false, '最后一步被拒绝不算解决');
  assert.equal(toolTurnResolved(turn([denied, good], 'PowerShell 失败后改用 Write，已写好')).ok, true, '如实说明纠正过程不算失败');
  assert.deepEqual(toolTurnResolved(turn([good, missing], '还没写')), { ok: true, corrected: 1, denied: 0, missing: 1 }, '续做前查文件不存在，由场景核对最终文件');
  assert.deepEqual(toolTurnResolved(turn([good], '完成')), { ok: true, corrected: 0, denied: 0, missing: 0 });
  assert.equal(firstTurnSucceeded(turn([denied, good], '已写入文件')), false, '第一轮不能有任何报错');
});
