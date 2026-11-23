'use strict';
// 独立随机端口 + 合成账号的真实模型交接探针：Claude（haiku，本机订阅）和 Gemini（gemini-4-neon 低档，agy）互相接力。
// 2026-11-23 GPT 退出平台后，接力的另一方从 GPT 换成 Gemini（Claude → Gemini → Claude）；每一项检查要证明的事不变，只是换了接手的模型。
// Gemini 的写法照 probe-gemini.cjs：低档 Neon、每轮最多等 5 分钟、只有「复述标记」这类回答没答中才允许有限重跑。
// 此文件不运行完整验收、不写正式记录。
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const Module = require('node:module'), zlib = require('node:zlib');
const root = path.resolve(__dirname, '..', '..');
const MODELS = Object.freeze({ anthropic: 'haiku', google: 'gemini-4-neon' }), PW = 'SYNTHETIC_LOCAL_TEST_ONLY';
const SAFETY_PROMPT = '【合成验收执行限制】仅可使用Read、Write，以及受保护PowerShell中的整数运算、文本读写或Start-Sleep。禁止Python、安装器、包管理器、GUI/UI、桌面程序和下载；无需转换或额外依赖。遇到障碍先在上述范围内换写法重试，仍不行就如实报告；不改用其他程序或执行方式。';
const matchesTurn = (message, turn) => typeof turn?.turnId === 'string' && !!turn.turnId && message?.turnId === turn.turnId;
// Gemini 比 GPT 慢：每轮最多等 5 分钟（和 probe-gemini 一样，原来 4 分钟）；探针总预算从 35 分钟放宽到 70 分钟（步骤超时 80 分钟）。
const TURN_WAIT_MS = 300000;
const PROBE_BUDGET_MS = 70 * 60e3;
// relay 工具在网页事件里的名字：server.js 把 agy 的 call_mcp_tool（relay_relay）换成 relay 的工具名，search_web 换成 WebSearch。
// 其余名字是 agy 自带的工具（run_command、view_file 等）或别的 MCP 服务，隔离闸门一律拦下（见 withoutDeniedBuiltins）。
const RELAY_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'PowerShell', 'WebFetch', 'WebSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Skill', 'SearchPapers', 'VerifyReference', 'SynthesizeSpeech']);
// crossConversationIsolated 原在已删除的 gpt-accounts 步骤里（H5：往别的账号的对话里发消息必须明确 404），和模型无关，挪到这里继续要求。
const REQUIRED_CHECKS = Object.freeze(['syntheticAccounts', 'claudeToolFile', 'fastSwitch', 'geminiReadPreviousFile', 'claudeReturnReadsGeminiFile',
  'stoppedWorkPreserved', 'editedHistoryClean', 'projectHandoff', 'imageRead', 'longHistoryBounded', 'memoryOffNoTranscript',
  'bothAccountsSwitchIsolated', 'conversationDenied', 'crossConversationIsolated', 'claudeRecovery', 'geminiRecovery', 'handoffExample', 'cleanupConfirmed', 'oneShotRetry', 'crossProviderReview']);
// probe-gemini.cjs 也用这份合成配置。GPT 已退出平台：合成服务里同样没有 GPT（gptUsers 不为空时门槛直接不通过）；
// Gemini 用正式配置里的 agy 固定副本（agyPath，随 ...original 带过来），每个合成账号的 agy 目录在合成目录下的 gemini 里。
function fixtureConfig(original, stage, manifest) {
  return { ...original, host: '127.0.0.1', port: 0, secret: crypto.randomBytes(32).toString('hex'),
    users: [['alice', 'owner'], ['bob', 'guest']].map(([id, profile]) => ({ id, name: 'Synthetic ' + id, password: PW, workDir: path.join(stage, id), profile, lightweight: true })),
    workDir: path.join(stage, 'alice'), toolboxDir: path.join(stage, 'alice'), gptUsers: [], gptModels: [],
    geminiUsers: ['alice', 'bob'], geminiModels: [{ id: MODELS.google, label: 'Gemini 4 Neon', efforts: ['low'] }],
    defaultModel: MODELS.anthropic, defaultEffort: 'low', titleModel: MODELS.anthropic,
    models: [{ id: MODELS.anthropic, label: 'Claude Haiku' }],
    prewarm: false, translateThinking: false, showThinking: false, extraArgs: [], maxConcurrent: 2, maxPerUser: 2,
    tunnel: { enabled: false }, wake: undefined, petHook: '', academicSearch: false,
    isolation: { enabled: true, runtimeManifest: manifest, privateRoot: path.join(stage, 'private'), gptHome: path.join(stage, 'gpt'), geminiHome: path.join(stage, 'gemini') } };
}
function verifyStage(stage, projectRoot = root) {
  const absolute = path.resolve(stage), parent = path.resolve(projectRoot, 'data');
  if (path.dirname(absolute) !== parent || !/^model-handoff-[A-Za-z0-9]+$/.test(path.basename(absolute))) throw Error('必须使用本副本的合成目录');
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) throw Error('合成目录不可重定向');
  return absolute;
}
function failureKind(error) {
  if (error?.failureKind && ['model', 'interruption', 'infrastructure', 'check', 'boundary', 'model-answer'].includes(error.failureKind.stage)) return error.failureKind;
  return { stage: 'check', kind: 'model-handoff-assertion' };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const answerText = msg => (msg?.events || []).filter(e => e.k === 'text').map(e => e.text || '').join('\n') || msg?.result || '';
const hasTool = (msg, name) => (msg?.events || []).some(e => e.k === 'tool' && (!name || new RegExp(name, 'i').test(e.name || '')));
function toolTurnOutcome(msg) {
  const results = (msg?.events || []).filter(e => e.k === 'tool_result');
  const failed = results.some(e => {
    if (e.error) return true;
    let value; try { value = JSON.parse(e.preview); } catch {}
    if (value && typeof value === 'object' && (Number.isInteger(value.exitCode) && value.exitCode !== 0 || !!value.error || typeof value.stderr === 'string' && value.stderr.trim())) return true;
    return /Access is denied|UnauthorizedAccessException|Permission denied|拒绝访问/i.test(String(e.preview || ''));
  });
  return { toolCount: (msg?.events || []).filter(e => e.k === 'tool').length, toolResultCount: results.length, failed };
}
const FAILURE_CLAIM = /无法|失败|没有生成|未生成|没有写入|未写入|Access is denied|Permission denied|cannot|unable|failed/i;
const MISSING_FILE = /ENOENT|cannot find|does not exist|找不到|不存在/i;
// 模型碰到运行环境的已知限制后自己改写法、续做前先查文件在不在，都是正常的。
// 最后一步仍是真失败才判失败；回答和文件是否正确由各场景核对，第一轮仍由 firstTurnSucceeded 要求完全干净。
function toolTurnResolved(msg) {
  const results = (msg?.events || []).filter(e => e.k === 'tool_result');
  const failedAt = e => toolTurnOutcome({ events: [e] }).failed;
  const failures = results.filter(failedAt);
  if (!failures.length) return { ok: true, corrected: 0, denied: 0, missing: 0 };
  const last = results.at(-1), denied = failures.filter(e => /Access is denied|UnauthorizedAccess|Permission denied|拒绝访问/i.test(String(e.preview || ''))).length, missing = failures.filter(e => MISSING_FILE.test(String(e.preview || ''))).length;
  return { ok: !failedAt(last) || MISSING_FILE.test(String(last.preview || '')), corrected: failures.length, denied, missing };
}
function firstTurnSucceeded(msg) {
  const outcome = toolTurnOutcome(msg), answer = answerText(msg);
  return msg?.status === 'done' && outcome.toolCount > 0 && outcome.toolResultCount >= outcome.toolCount && !outcome.failed
    && answer.includes('已写入文件') && !FAILURE_CLAIM.test(answer);
}
// Gemini（agy）偶尔先试它自带的工具或别的 MCP 服务，隔离闸门一律拦下，网页上是一对「工具 + 失败结果」。这是闸门在起作用，
// 不是这一轮做事失败：判断工具结果、找用过哪些工具之前，先拿掉这些调用（另记进报告），也不让 read_file 之类的名字冒充 relay 的 Read。
// 自带工具有结果却不是失败，说明闸门漏了，由调用方按边界失败处理（escaped）；没有结果的同样拿掉、记进报告。
function withoutDeniedBuiltins(msg) {
  const events = Array.isArray(msg?.events) ? msg.events : [];
  const builtin = events.filter(e => e?.k === 'tool' && !RELAY_TOOLS.includes(e.name));
  if (!builtin.length) return { msg, attempts: [], escaped: [] };
  const ids = new Set(builtin.map(e => e.id));
  const attempts = builtin.map(e => {
    const own = events.filter(r => r?.k === 'tool_result' && r.id === e.id);
    return { name: String(e.name || ''), denied: own.length ? own.every(r => !!r.error) : null };
  });
  return { msg: { ...msg, events: events.filter(e => !((e?.k === 'tool' || e?.k === 'tool_result') && ids.has(e.id))) },
    attempts, escaped: attempts.filter(a => a.denied === false).map(a => a.name) };
}
function redBluePng() {
  const width = 160, height = 80, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width * 3 + 1) + 1 + x * 3 + (x < width / 2 ? 0 : 2)] = 255;
  const crc = data => { let n = 0xffffffff; for (const byte of data) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const tag = Buffer.from(name), length = Buffer.alloc(4), end = Buffer.alloc(4); length.writeUInt32BE(data.length); end.writeUInt32BE(crc(Buffer.concat([tag, data]))); return Buffer.concat([length, tag, data, end]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function replaceOnce(source, oldText, newText) {
  if (source.split(oldText).length !== 2) throw Error('合成服务入口变化，需要重新审查探针');
  return source.replace(oldText, newText);
}
async function serve(stage, manifest, configSource) {
  verifyStage(stage);
  const original = JSON.parse(fs.readFileSync(configSource, 'utf8'));
  const fixture = fixtureConfig(original, stage, manifest);
  if (!path.isAbsolute(fixture.agyPath || '') || !fs.existsSync(fixture.agyPath)) throw Error('没有 agy 固定副本的绝对路径（agyPath）');
  globalThis.__relayModelHandoffConfig = fixture;
  for (const id of ['alice', 'bob']) {
    fs.mkdirSync(path.join(stage, id), { recursive: true });
    const prefs = path.join(stage, 'data', 'users', id); fs.mkdirSync(prefs, { recursive: true });
    fs.writeFileSync(path.join(prefs, 'prefs.json'), JSON.stringify({ memory: id !== 'bob' }));
  }
  const gate = require('../../tools/check-isolation.cjs'), runtime = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fixture.isolation.receipt = path.join(stage, 'synthetic-acceptance.json');
  // 只为明确的合成副本提供启动夹具；不是完整验收记录，绝不复制到正式服务。
  fs.writeFileSync(fixture.isolation.receipt, JSON.stringify({ schema: gate.RECEIPT_SCHEMA, purpose: 'synthetic-fixture-only', completedAt: new Date().toISOString(),
    configurationFingerprint: gate.configurationFingerprint(fixture, runtime, stage), checks: Object.fromEntries(gate.REQUIRED.map(key => [key, { passed: true }])),
    fingerprints: gate.requiredFingerprintFiles(fixture, runtime, stage, root).map(file => ({ path: file, sha256: gate.hashFile(file) })) }));
  for (const name of ['public', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(stage, name), 'junction');
  const handoff = require('../../tools/model-handoff.cjs'), build = handoff.buildHandoff;
  // maxChars：服务这一轮实际用的交接上限（Gemini 默认 60000 字），longHistoryBounded 按它核对
  handoff.buildHandoff = function(conv, provider, options) {
    const result = build(conv, provider, options);
    if (result.text) process.send?.({ syntheticHandoff: { convId: conv.id, provider, text: result.text, stats: result.stats, maxChars: options?.maxChars } });
    return result;
  };
  let source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  source = replaceOnce(source, 'const ROOT = __dirname;', 'const ROOT = ' + JSON.stringify(stage) + ';');
  source = replaceOnce(source, 'const config = loadConfig();', 'const config = globalThis.__relayModelHandoffConfig;');
  source = replaceOnce(source, 'function updateKeepAwake() {', 'function updateKeepAwake() { return;');
  source = replaceOnce(source, 'function generateTitle(u, conv) {', 'function generateTitle(u, conv) { return;');
  source += `\nconst syntheticOriginalModelInstructions=modelInstructions;
modelInstructions=(u,pid,provider)=>syntheticOriginalModelInstructions(u,pid,provider)+'\\n'+${JSON.stringify(SAFETY_PROMPT)};
server.on('listening',()=>process.send({ready:true,port:server.address().port}));
process.once('disconnect',()=>process.emit('SIGINT'));
process.on('message',async m=>{
 if(m?.stop){process.emit('SIGINT');return;}
 if(!m?.fixture)return; const f=m.fixture;
 try {
  if(!['alice','bob'].includes(f.who)||!validId(f.conv?.id||f.convId))throw Error('合成账号或编号无效');
  const u=USERS.get(f.who),id=f.conv?.id||f.convId;let value;
  if(jobs.has(jobKey(u,id)))throw Error('合成对话仍在运行');
  if(f.op==='seed'){
   if(!String(f.conv.title||'').startsWith('Synthetic ')||!Array.isArray(f.conv.messages)||f.conv.messages.length>160)throw Error('合成数据无效');
   saveConv(u,f.conv,false);
  }else if(f.op==='directory-diagnostic'){
   const c=loadConv(u,id);if(!c)throw Error('合成对话不存在');
   await ensureConvFolder(u,c); const rel=convFolderRel(u,c), out=rel+'/outputs';
   const command="$taskOutput='"+out+"'; New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null; Set-Content -LiteralPath ($taskOutput + '/directory-diagnostic.txt') -Value 'DIRECTORY_DIAGNOSTIC_ONLY' -Encoding UTF8";
   const broker=require('./isolation/mcp').createBroker(isolation.context(u));
   const response=await broker.call('PowerShell',{command,description:'Synthetic existing-directory diagnostic',timeout:15000});
   const result=JSON.parse(response.content.find(x=>x.type==='text').text);
   value={exitCode:result.exitCode,accessDenied:/Access is denied|UnauthorizedAccess|拒绝访问/i.test(result.stderr||''),stderrPresent:!!String(result.stderr||'').trim(),fileWritten:fs.existsSync(path.join(u.workDir,out,'directory-diagnostic.txt'))};
  }else if(f.op==='session'){
   if(!/^[a-f0-9-]{36}$/.test(f.missing)||f.provider!=='anthropic')throw Error('合成会话无效');
   const c=loadConv(u,id);if(!c)throw Error('合成对话不存在');
   c.sessionId=f.missing;saveConv(u,c,false);
  }else throw Error('未知合成操作');
  process.send({fixtureReply:f.requestId,ok:true,value});
 }catch{process.send({fixtureReply:f.requestId,ok:false});}
});\n`;
  const mod = new Module(path.join(root, 'server.js'), module); mod.filename = path.join(root, 'server.js'); mod.paths = Module._nodeModulePaths(root); mod._compile(source, mod.filename);
}
async function runProbe({ manifest, output, configSource = path.join(root, 'config.json'), scenario = 'full' }) {
  if (!['full', 'first-switch', 'collaboration'].includes(scenario)) throw Error('未知合成探针范围');
  const requiredForRun = scenario === 'full' ? REQUIRED_CHECKS : scenario === 'collaboration' ? ['syntheticAccounts', 'oneShotRetry', 'crossProviderReview', 'originalModelAfterReview', 'cleanupConfirmed'] : ['syntheticAccounts', 'claudeToolFile', 'fastSwitch', 'geminiReadPreviousFile', 'claudeReturnReadsGeminiFile', 'handoffExample', 'cleanupConfirmed'];
  manifest = path.resolve(manifest); output = path.resolve(output); configSource = path.resolve(configSource);
  if (!fs.existsSync(manifest) || !fs.existsSync(configSource) || !/^codex-security-artifacts-/.test(path.basename(path.dirname(output)))) throw Error('需要运行清单、配置来源和受管证据目录');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, 'data', 'model-handoff-')); verifyStage(stage);
  const checks = {}, captures = [], cookies = {}, rpc = new Map(), startedAt = Date.now(), geminiBuiltinAttempts = []; let child, base, example, firstTurnEvidence, directoryDiagnostic, failedTurnEvidence, failure, classification, currentStep = 'startup', sequence = 0, stopped = false, recoveryEvidence, switchTiming; const correctedToolFailures = { total: 0, denied: 0, missingFile: 0, geminiBuiltinDenied: 0 };
  const deadline = startedAt + PROBE_BUDGET_MS;
  const budget = () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw Object.assign(Error('合成探针总预算到期'), { failureKind: { stage: 'infrastructure', kind: 'probe-budget' } }); return remaining; };
  function enterStep(name) { currentStep = name; console.log(JSON.stringify({ probe: 'model-handoff', stage: name, at: new Date().toISOString() })); }
  function check(name, value) { if (!value) { const error = Error(name); error.failureKind = { stage: /Account|Isolated|Denied/.test(name) ? 'boundary' : 'check', kind: 'model-handoff-assertion' }; throw error; } checks[name] = true; }
  async function waitFor(fn, timeout = 240000, interval = 100) { const until = Date.now() + Math.min(timeout, budget()); while (Date.now() < until) { budget(); const value = await fn(); if (value) return value; await sleep(Math.min(interval, budget())); } throw Object.assign(Error('等待超时'), { failureKind: { stage: 'infrastructure', kind: 'probe-timeout' } }); }
  async function request(route, method = 'GET', body, who = 'alice') {
    const headers = cookies[who] ? { cookie: cookies[who], 'x-relay-user': who } : {};
    if (body !== undefined && !Buffer.isBuffer(body)) { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
    let response; try { response = await fetch(base + route, { method, headers, body, signal: AbortSignal.timeout(Math.min(30000, budget())) }); }
    catch { throw Object.assign(Error('本地请求未完成'), { failureKind: { stage: 'infrastructure', kind: 'local-http' } }); }
    const bytes = Buffer.from(await response.arrayBuffer()); let value = bytes; try { value = JSON.parse(bytes.toString('utf8')); } catch {}
    return { status: response.status, headers: response.headers, value };
  }
  function ok(response) { if (response.status !== 200) throw Error('合成接口返回 ' + response.status); return response.value; }
  const getConv = async (id, who = 'alice') => ok(await request('/api/conversations/' + id, 'GET', undefined, who));
  // agy 交出最终结果后进程还要一会儿才退出，等空闲放宽到 2 分钟（原来 1 分钟）
  async function idle() { await waitFor(async () => ok(await request('/local/power')).running === 0, 120000); }
  async function fixture(op, who, data) { await idle(); const requestId = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { rpc.delete(requestId); reject(Error('合成数据注入超时')); }, op === 'directory-diagnostic' ? 30000 : 5000);
    rpc.set(requestId, m => { clearTimeout(timer); m.ok ? resolve(m.value) : reject(Error('合成数据注入被拒绝')); }); child.send({ fixture: { op, who, ...data, requestId } }); }); }
  async function seed(who, messages = [], extra = {}) { const id = extra.id || crypto.randomBytes(8).toString('hex'); await fixture('seed', who, { conv: { id, title: 'Synthetic model handoff', titled: true, createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, messages, ...extra } }); return id; }
  async function begin(who, message, provider, conversationId, extra = {}) {
    if (!Object.hasOwn(MODELS, provider)) throw Error('不允许的探针型号');
    const requestedAt = Date.now(); const data = ok(await request('/api/chat', 'POST', { ...extra, message: SAFETY_PROMPT + '\n' + message, model: MODELS[provider], effort: 'low', conversationId }, who));
    if (typeof data.turnId !== 'string' || !data.turnId) throw Error('本轮没有唯一身份');
    return { id: data.conversationId, who, requestedAt, startedAt: data.startedAt, turnId: data.turnId };
  }
  async function finish(turn, { allowStopped = false, waitFiles = true } = {}) {
    let conv;
    try { conv = await waitFor(async () => { const c = await getConv(turn.id, turn.who), m = c.messages.at(-1); return matchesTurn(m, turn) && ['done', 'error', 'stopped'].includes(m.status) && (!waitFiles || Array.isArray(m.files)) && c; }, TURN_WAIT_MS, 50); }
    catch (error) { if (error.failureKind?.kind === 'probe-timeout') error.failureKind = { stage: 'model', kind: 'model-timeout' }; throw error; }
    const raw = conv.messages.at(-1), gemini = raw.provider === 'google';
    if (raw.status !== 'done' && !(allowStopped && raw.status === 'stopped')) {
      const acceptance = require('../../tools/maintenance-acceptance.cjs'); throw Object.assign(Error('模型没有完成合成步骤'), { failureKind: acceptance.modelFailureKind(raw.maintenanceFailureKind, gemini ? 'gemini' : 'claude') });
    }
    const screened = gemini ? withoutDeniedBuiltins(raw) : { msg: raw, attempts: [], escaped: [] };
    if (screened.attempts.length) { geminiBuiltinAttempts.push({ step: currentStep, turnId: raw.turnId, attempts: screened.attempts }); correctedToolFailures.geminiBuiltinDenied += screened.attempts.filter(a => a.denied === true).length; }
    if (screened.escaped.length) throw Object.assign(Error('Gemini 自带工具没有被闸门拦下'), { failureKind: { stage: 'boundary', kind: 'boundary' } });
    const msg = screened.msg;
    if (msg.status === 'done' && toolTurnOutcome(msg).failed) { const seen = toolTurnResolved(msg); correctedToolFailures.total += seen.corrected; correctedToolFailures.denied += seen.denied; correctedToolFailures.missingFile += seen.missing; }
    if (msg.status === 'done' && !toolTurnResolved(msg).ok) { failedTurnEvidence = { model: msg.model, turnId: msg.turnId, ...toolTurnOutcome(msg), answer: answerText(msg).slice(0, 400), tools: (msg.events || []).filter(e => e.k === 'tool').map(e => ({ name: e.name, summary: String(e.summary || '').slice(0, 200) })), toolResults: (msg.events || []).filter(e => e.k === 'tool_result').map(e => { let value; try { value = JSON.parse(e.preview); } catch {} return { tool: (msg.events || []).find(t => t.k === 'tool' && t.id === e.id)?.name || 'unknown', error: !!e.error, exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null, stderrPresent: !!String(value?.stderr || '').trim(), accessDenied: /Access is denied|UnauthorizedAccess|Permission denied|拒绝访问/i.test(String(e.preview || '')), missingFile: /ENOENT|cannot find|找不到/i.test(String(e.preview || '')) }; }) }; throw Object.assign(Error('工具结果含失败'), { failureKind: { stage: 'check', kind: 'tool-result-failed' } }); }
    return { ...turn, conv, msg };
  }
  const chat = async (who, message, provider, id, extra, options) => finish(await begin(who, message, provider, id, extra), options);
  const file = async (who, relative) => { const value = ok(await request('/api/file?path=' + encodeURIComponent(relative), 'GET', undefined, who)); return Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value); };
  const capture = (id, provider) => captures.filter(c => c.convId === id && c.provider === provider).at(-1);
  const geminiConversation = turn => turn.conv.geminiConvId || turn.msg.geminiConvId || null;
  // 每个账号的 agy 对话只存在它自己的 agy 目录里（照 probe-gemini 的 profilesSeparated）
  const inProfile = (who, id) => !!id && fs.existsSync(path.join(stage, 'gemini', who, '.gemini', 'antigravity-cli', 'conversations', id + '.db'));
  try {
    child = cp.fork(__filename, ['--serve', stage, manifest, '--config-source=' + configSource], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    child.on('message', m => { if (m?.syntheticHandoff) captures.push(m.syntheticHandoff); if (m?.fixtureReply && rpc.has(m.fixtureReply)) { const callback = rpc.get(m.fixtureReply); rpc.delete(m.fixtureReply); callback(m); } });
    const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('合成服务启动超时')), 60000); child.on('message', m => { if (m?.ready) { clearTimeout(timer); resolve(m.port); } }); child.once('exit', () => { clearTimeout(timer); reject(Error('合成服务启动退出')); }); });
    base = 'http://127.0.0.1:' + port;
    console.log(JSON.stringify({ probe: 'model-handoff', stage: 'service-ready', servicePid: child.pid, port }));
    // 两个合成账号都看得到 Gemini，而且看不到任何 GPT（GPT 已退出平台）
    for (const who of ['alice', 'bob']) { const response = await request('/api/login', 'POST', { username: who, password: PW }, who); ok(response); cookies[who] = response.headers.get('set-cookie').split(';')[0]; const state = ok(await request('/api/state', 'GET', undefined, who)); check(who + 'Synthetic', state.userId === who && state.models.some(m => m.id === MODELS.google && m.provider === 'google') && !state.models.some(m => m.provider === 'openai')); }
    check('syntheticAccounts', checks.aliceSynthetic && checks.bobSynthetic);
    if (scenario !== 'collaboration') {
    if (scenario === 'first-switch') { enterStep('existing-output-directory-diagnostic'); const diagId = await seed('alice'); directoryDiagnostic = await fixture('directory-diagnostic', 'alice', { convId: diagId }); }
    enterStep('claude-gemini-claude'); const firstId = await seed('alice');
    const claudeFile = 'chats/' + firstId + '/outputs/claude-result.txt', geminiFile = 'chats/' + firstId + '/outputs/gemini-result.txt';
    const first = await chat('alice', '这是合成验收。服务已经创建本对话的outputs文件夹，不要再创建目录。仅用PowerShell执行以下命令：$ErrorActionPreference=\'Stop\'; $taskResult=37*19; Set-Content -LiteralPath \'./chats/' + firstId + '/outputs/claude-result.txt\' -Value $taskResult -Encoding UTF8。成功后最终只回复“已写入文件”，不要在回答中写数字；执行失败应如实报告。', 'anthropic', firstId, {}, { waitFiles: false });
    // Gemini 写文件给出完整的相对路径（本对话的 outputs），少一处它把文件放错地方的机会；要核对的事不变
    const secondTurn = await begin('alice', '上一轮做了什么，结果在哪？请用Read读取上一轮结果文件，并把读到的数字加1，用Write写到' + geminiFile + '。简短回答结果和来源文件。', 'google', firstId);
    const switchDelay = secondTurn.requestedAt - first.msg.finishedAt;
    const second = await finish(secondTurn);
    firstTurnEvidence = { ...toolTurnOutcome(first.msg), successAnswer: firstTurnSucceeded(first.msg) };
    check('claudeToolFile', firstTurnSucceeded(first.msg) && hasTool(first.msg, 'PowerShell') && !answerText(first.msg).includes('703') && (await file('alice', claudeFile)).trim() === '703');
    // 场景前提：上一轮一结束（1 秒内）就换模型，测的是「立刻换」。服务端换模型时会先等上一轮的文件落定（model-finalization 最多 5 秒），
    // 所以服务端接受耗时只设宽松上限（5 秒 + 1 秒余量）抓卡死；真正的断言是交接内容里有上一轮的文件。计时先记下，检查失败也看得到。
    const acceptDelay = secondTurn.startedAt - secondTurn.requestedAt;
    switchTiming = { clientDelayMs: switchDelay, serverAcceptMs: acceptDelay };
    check('fastSwitch', switchDelay >= 0 && switchDelay <= 1000 && Number.isFinite(acceptDelay) && acceptDelay >= -50 && acceptDelay <= 6000 && capture(firstId, 'google')?.text.includes('claude-result.txt'));
    check('geminiReadPreviousFile', hasTool(second.msg, 'Read') && (await file('alice', geminiFile)).trim() === '704' && answerText(second.msg).includes('claude-result.txt'));
    example = capture(firstId, 'google'); check('handoffExample', !!example?.text && example.stats?.files >= 1 && example.stats?.tools >= 1);
    const third = await chat('alice', '请读取上一轮Gemini做的gemini-result.txt，把数值再加1写到outputs/claude-return.txt。回答说明上一轮由Gemini做了什么。', 'anthropic', firstId);
    check('claudeReturnReadsGeminiFile', hasTool(third.msg, 'Read') && (await file('alice', 'chats/' + firstId + '/outputs/claude-return.txt')).trim() === '705');

    if (scenario === 'full') {
    // 编辑早先的一轮后，后面几轮（含一条只存在于存档里的标记）不能出现在对话和交接里。Gemini 的 agy 对话不能 fork：
    // 原来那一轮被截掉后，服务不再接旧的 agy 对话，而是开新对话、从记录交接
    enterStep('edit-history'); const removed = 'REMOVED_' + crypto.randomBytes(8).toString('hex');
    const stored = await getConv(firstId); stored.messages.push({ role: 'user', text: removed, model: MODELS.google, effort: 'low', sessionBefore: stored.sessionId }, { role: 'assistant', model: MODELS.google, provider: 'google', result: removed, status: 'done', events: [], files: [] });
    await fixture('seed', 'alice', { conv: stored });
    const edited = await chat('alice', '只复述最早一轮计算题，不用工具。', 'google', firstId, { fromIndex: 2 });
    check('editedHistoryClean', edited.conv.messages.length === 4 && !!capture(firstId, 'google')?.text && !JSON.stringify(edited.conv.messages).includes(removed) && !capture(firstId, 'google').text.includes(removed));

    enterStep('stopped-work'); const stopId = await seed('alice'), ready = 'READY_' + crypto.randomBytes(6).toString('hex'), stopOutputs = 'chats/' + stopId + '/outputs/';
    const stopping = await begin('alice', '合成任务按顺序做：1) Write把字符串' + ready + '写入' + stopOutputs + 'already.txt；2) 用PowerShell执行Start-Sleep -Seconds 60；3) Write把DONE写入' + stopOutputs + 'remaining.txt。已经完成的文件不要改写。', 'anthropic', stopId);
    const ownedReady = path.join(stage, 'alice', 'chats', stopId, 'outputs', 'already.txt');
    await waitFor(() => fs.existsSync(ownedReady) && fs.readFileSync(ownedReady, 'utf8').trim() === ready, 120000);
    const beforeStop = fs.statSync(ownedReady).mtimeMs; ok(await request('/api/stop', 'POST', { conversationId: stopId }));
    const stoppedTurn = await finish(stopping, { allowStopped: true }); check('stoppedAtTool', stoppedTurn.msg.status === 'stopped');
    const continued = await chat('alice', '继续', 'google', stopId, { continue: true });
    check('stoppedWorkPreserved', fs.statSync(ownedReady).mtimeMs === beforeStop && fs.readFileSync(ownedReady, 'utf8').trim() === ready && (await file('alice', stopOutputs + 'remaining.txt')).trim() === 'DONE' && capture(stopId, 'google')?.text.includes('被中断') && hasTool(continued.msg));

    enterStep('project'); const project = ok(await request('/api/projects', 'POST', { name: 'Synthetic handoff project', description: 'Synthetic only' }));
    const projectId = await seed('alice', [], { projectId: project.id }), otherMarker = 'OTHER_CONVERSATION_' + crypto.randomBytes(8).toString('hex');
    await seed('alice', [{ role: 'user', text: otherMarker }, { role: 'assistant', model: MODELS.anthropic, status: 'done', result: otherMarker }], { projectId: project.id });
    await chat('alice', '用Write把PROJECT_42写入本项目outputs/shared.txt，只回复完成。', 'anthropic', projectId);
    const projected = await chat('alice', '用Read读取上一轮的shared.txt，复述文件内容和路径。', 'google', projectId);
    check('projectHandoff', answerText(projected.msg).includes('PROJECT_42') && capture(projectId, 'google')?.text.includes('shared.txt') && !capture(projectId, 'google')?.text.includes(otherMarker) && (await file('alice', 'projects/' + project.id + '/outputs/shared.txt')).trim() === 'PROJECT_42');

    enterStep('image'); const imageId = await seed('alice'); // 和网页一样带对话编号上传，附件才在平台说明的 uploads 里
    const image = ok(await request('/api/upload?name=synthetic-colors.png&conv=' + imageId, 'POST', redBluePng()));
    await chat('alice', '这是一张合成附件，先只回复收到，不描述图片，不用工具。', 'anthropic', imageId, { attachments: [{ path: image.path, name: 'synthetic-colors.png', size: redBluePng().length }] });
    // Gemini 经 relay 的 Read 拿到的是 MCP 图片内容（isolation/mcp.js），能不能看懂只有真跑才知道
    const imageReply = await chat('alice', '请用Read打开上一轮附的图片。只回答左半边和右半边各是什么颜色。', 'google', imageId);
    check('imageRead', hasTool(imageReply.msg, 'Read') && /红|red/i.test(answerText(imageReply.msg)) && /蓝|blue/i.test(answerText(imageReply.msg)) && capture(imageId, 'google')?.text.includes(image.path));

    enterStep('long-memory-off'); const firstMarker = 'FIRST_REQUIREMENT_' + crypto.randomBytes(6).toString('hex'), history = [];
    for (let i = 0; i < 45; i++) history.push({ role: 'user', text: i ? '合成历史用户要求第' + i + '轮。' : '最初要求：请记住' + firstMarker }, { role: 'assistant', model: MODELS.anthropic, status: 'done', result: ('合成较长回答段落。\n').repeat(240), events: [], files: [] });
    const longId = await seed('bob', history); const long = await chat('bob', '不用工具，只复述第一条用户要求里的FIRST_REQUIREMENT_标记。', 'google', longId), longPack = capture(longId, 'google');
    // 交接的上限 GPT 是 24000 字、Gemini 是 60000 字（config.handoffMaxChars 写了就用它）：按服务这一轮实际用的上限核对，仍要求截短过、首条要求留着
    check('longHistoryBounded', !!longPack && Number.isSafeInteger(longPack.maxChars) && longPack.maxChars > 0 && longPack.text.length <= longPack.maxChars && longPack.stats.truncated && longPack.text.includes(firstMarker) && answerText(long.msg).includes(firstMarker));
    await idle(); check('memoryOffNoTranscript', !longPack.text.includes('.memory/chats/') && !fs.existsSync(path.join(stage, 'bob', '.memory', 'chats', longId + '.md')));

    enterStep('accounts'); const accountIds = {}, tokens = {};
    for (const who of ['alice', 'bob']) { accountIds[who] = await seed(who); tokens[who] = who.toUpperCase() + '_' + crypto.randomBytes(8).toString('hex'); }
    await Promise.all(['alice', 'bob'].map(who => chat(who, '合成验收。用Write把' + tokens[who] + '写入本对话outputs/account.txt。只回复完成。', 'anthropic', accountIds[who])));
    const accountReplies = await Promise.all(['alice', 'bob'].map(who => chat(who, '用Read读取上一轮的account.txt，仅复述其中标记。', 'google', accountIds[who])));
    const [aliceGemini, bobGemini] = accountReplies.map(geminiConversation);
    check('bothAccountsSwitchIsolated', accountReplies.every((r, i) => { const who = ['alice', 'bob'][i], other = who === 'alice' ? 'bob' : 'alice'; return answerText(r.msg).includes(tokens[who]) && !JSON.stringify(r.conv).includes(tokens[other]) && capture(r.id, 'google')?.text.includes(tokens[who]) && !capture(r.id, 'google').text.includes(tokens[other]); })
      && !!aliceGemini && !!bobGemini && aliceGemini !== bobGemini && inProfile('alice', aliceGemini) && !inProfile('bob', aliceGemini) && inProfile('bob', bobGemini) && !inProfile('alice', bobGemini));
    check('conversationDenied', (await request('/api/conversations/' + accountIds.alice, 'GET', undefined, 'bob')).status === 404);
    // H5（原 gpt-accounts）：bob 指定 alice 的对话编号发消息，必须明确 404，alice 的对话一条不多；服务在启动模型之前就拒绝
    const countBefore = (await getConv(accountIds.alice)).messages.length;
    const cross = await request('/api/chat', 'POST', { message: SAFETY_PROMPT + '\n接着聊。不用工具，说出合成标记。', model: MODELS.google, effort: 'low', conversationId: accountIds.alice }, 'bob');
    check('crossConversationIsolated', cross.status === 404 && (await getConv(accountIds.alice)).messages.length === countBefore);

    enterStep('session-recovery');
    // 恢复本身都对、只是模型这次没复述标记：单独归类，由验收工具决定能否重跑。
    const settleRecovery = (checkName, provider, recovered, conditions) => {
      if (!Object.values(conditions).every(Boolean)) recoveryEvidence = { provider, conditions, status: recovered.msg.status, answer: answerText(recovered.msg).slice(0, 400), events: (recovered.msg.events || []).map(e => e.k) };
      if (Object.entries(conditions).every(([name, value]) => value || name === 'answerHasMarker') && !conditions.answerHasMarker) throw Object.assign(Error(checkName), { failureKind: { stage: 'model-answer', kind: 'model-answer-miss', check: checkName } });
      check(checkName, Object.values(conditions).every(Boolean));
    };
    {
      // Claude：会话编号指向不存在的会话，服务认出实测的「缺会话」错误，清掉编号、从对话记录恢复一次，并给出恢复提示
      const id = await seed('alice', [{ role: 'user', text: '合成恢复的第一条要求：记住RECOVER_42。' }, { role: 'assistant', model: MODELS.anthropic, status: 'done', result: '收到', events: [], files: [] }]);
      await fixture('session', 'alice', { convId: id, provider: 'anthropic', missing: crypto.randomUUID() });
      const recovered = await chat('alice', '不用工具，复述最初要求中的合成标记。', 'anthropic', id);
      settleRecovery('claudeRecovery', 'anthropic', recovered, { fourMessages: recovered.conv.messages.length === 4, recovered: recovered.msg.handoff?.recovered === true, notice: recovered.msg.recoveryNotice === '原会话不可用，已从对话记录恢复', answerHasMarker: answerText(recovered.msg).includes('RECOVER_42'), packHasMarker: !!capture(id, 'anthropic')?.text.includes('RECOVER_42') });
    }
    {
      // Gemini：对话里记着的 agy 对话已经不在了（这里是一个不存在的编号，账号的 agy 目录里没有它的 .db）。服务不去接它，
      // 而是开新的 agy 对话，把整段对话记录从第一轮交接过去（stats.recovered 为真）。这条路服务端本来就不显示「原会话不可用」的提示，
      // 所以没有 Claude 那两项（notice、handoff.recovered）；换成「没有接旧编号」和「交接从第一轮开始」
      const missing = crypto.randomUUID(), heldTurn = crypto.randomUUID();
      const id = await seed('alice', [{ role: 'user', text: '合成恢复的第一条要求：记住RECOVER_42。' }, { role: 'assistant', model: MODELS.google, provider: 'google', status: 'done', result: '收到', events: [], files: [], turnId: heldTurn, geminiConvId: missing }],
        { geminiConvId: missing, geminiTurnId: heldTurn });
      const recovered = await chat('alice', '不用工具，复述最初要求中的合成标记。', 'google', id), pack = capture(id, 'google'), fresh = geminiConversation(recovered);
      settleRecovery('geminiRecovery', 'google', recovered, { fourMessages: recovered.conv.messages.length === 4, freshConversation: !!fresh && fresh !== missing, fromFirstTurn: pack?.stats?.recovered === true, answerHasMarker: answerText(recovered.msg).includes('RECOVER_42'), packHasMarker: !!pack?.text.includes('RECOVER_42') });
    }
    }
    }
    if (scenario === 'full' || scenario === 'collaboration') {
      enterStep('collaboration');
      const h9Id = await seed('alice'), token = 'COLLAB_' + crypto.randomBytes(8).toString('hex'), removed = 'TRUNCATE_H9_' + crypto.randomBytes(6).toString('hex');
      const task = '只用Write把' + token + '写入本对话outputs/collaboration.txt，然后说明文件路径和内容。无需运行任何程序或转换文件。';
      const initial = await chat('alice', task, 'anthropic', h9Id);
      const owned = path.join(stage, 'alice', 'chats', h9Id, 'outputs', 'collaboration.txt'), beforeReview = fs.statSync(owned).mtimeMs;
      const review = await chat('alice', '此文字应被服务端固定复核请求替换。', 'google', h9Id,
        { action: 'review', reviewIndex: initial.conv.messages.length - 1, reviewTurnId: initial.msg.turnId });
      const fixedPrompt = require('../../tools/model-collaboration.cjs').REVIEW_PROMPT, reviewUser = review.conv.messages.at(-2);
      check('crossProviderReview', review.conv.model === MODELS.anthropic && review.msg.model === MODELS.google && reviewUser.action === 'review'
        && reviewUser.text === fixedPrompt && !reviewUser.cont && review.conv.messages.length === 4 && hasTool(review.msg, 'Read')
        && answerText(review.msg).trim().length > 0 && (review.msg.events || []).some(e => e.k === 'tool_result' && !e.error && String(e.preview || '').includes(token) && (review.msg.events || []).some(t => t.k === 'tool' && t.id === e.id && /Read/i.test(t.name))) && capture(h9Id, 'google')?.text.includes('collaboration.txt') && review.msg.handoff?.from === MODELS.anthropic
        && fs.statSync(owned).mtimeMs === beforeReview);
      // 明确不发送model：复核以后普通发送必须继续使用对话原来的选择。
      const startedAt = Date.now(), data = ok(await request('/api/chat', 'POST', { message: SAFETY_PROMPT + '\n不用工具，只复述文件里的COLLAB_标记。合成截断检查标记：' + removed, conversationId: h9Id }));
      if (!data.turnId) throw Error('普通继续没有唯一轮次');
      const next = await finish({ id: data.conversationId, who: 'alice', requestedAt: startedAt, startedAt: data.startedAt, turnId: data.turnId });
      check('originalModelAfterReview', next.conv.model === MODELS.anthropic && next.msg.model === MODELS.anthropic && answerText(next.msg).includes(token));
      const retry = await chat('alice', task, 'google', h9Id, { retryWithModel: true, retryTurnId: initial.msg.turnId, fromIndex: 0 });
      check('oneShotRetry', retry.conv.model === MODELS.anthropic && retry.msg.model === MODELS.google && retry.conv.messages.length === 2
        && retry.conv.messages[0].retryWithModel === true && retry.msg.turnId !== initial.msg.turnId && !JSON.stringify(retry.conv.messages).includes(removed)
        && !capture(h9Id, 'google')?.text.includes(removed) && answerText(retry.msg).includes(token)
        && (await file('alice', 'chats/' + h9Id + '/outputs/collaboration.txt')).trim() === token);
    }
  } catch (error) { failure = { step: currentStep, message: '模型交接合成验收未完成或检查未通过', ...(REQUIRED_CHECKS.includes(error.message) ? { check: error.message } : {}) }; classification = failureKind(error); }
  finally {
    if (child && child.exitCode === null) {
      try { child.send({ stop: true }); } catch {}
      stopped = await new Promise(resolve => { const timer = setTimeout(() => resolve(false), 12000); child.once('exit', () => { clearTimeout(timer); resolve(true); }); });
      if (!stopped) { child.kill(); await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
    } else stopped = !child || child.exitCode !== null;
    if (stopped) {
      try {
        verifyStage(stage);
        for (const name of ['public', 'node_modules']) { const target = path.join(stage, name); if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target); }
        for (let n = 0; n < 5; n++) { try { fs.rmSync(stage, { recursive: true, force: true }); break; } catch { await sleep(500); } }
        checks.cleanupConfirmed = !fs.existsSync(stage);
      } catch { checks.cleanupConfirmed = false; }
    } else checks.cleanupConfirmed = false;
    if (!checks.cleanupConfirmed) { failure ||= { step: 'cleanup', message: '合成服务或目录清理未确认' }; classification = { stage: 'infrastructure', kind: 'cleanup-unconfirmed' }; }
  }
  const result = { probe: 'model-handoff', syntheticOnly: true, scenario, testOnlyInstructionAppend: true, models: MODELS, effort: 'low', checks, correctedToolFailures, ...(firstTurnEvidence ? { firstTurnEvidence } : {}), ...(directoryDiagnostic ? { directoryDiagnostic } : {}), ...(failedTurnEvidence ? { failedTurnEvidence } : {}), ...(recoveryEvidence ? { recoveryEvidence } : {}), ...(switchTiming ? { switchTiming } : {}),
    ...(geminiBuiltinAttempts.length ? { geminiBuiltinAttempts } : {}), ...(failure ? { failure, failureKind: classification } : {}), ...(example ? { handoffExample: example } : {}), durationMs: Date.now() - startedAt };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ probe: result.probe, checks, failure, durationMs: result.durationMs }));
  return { result, exitCode: !failure && requiredForRun.every(name => checks[name] === true) ? 0 : 1 };
}
module.exports = { REQUIRED_CHECKS, MODELS, SAFETY_PROMPT, RELAY_TOOLS, TURN_WAIT_MS, PROBE_BUDGET_MS, matchesTurn, fixtureConfig, verifyStage, failureKind, toolTurnOutcome, toolTurnResolved, firstTurnSucceeded, withoutDeniedBuiltins, redBluePng, runProbe };
if (require.main === module) {
  const configSource = process.argv.find(arg => arg.startsWith('--config-source='))?.slice('--config-source='.length) || path.join(root, 'config.json');
  const task = process.argv[2] === '--serve' ? serve(process.argv[3], process.argv[4], configSource) : runProbe({ manifest: process.argv[2], output: process.argv[3], configSource, scenario: process.argv.find(arg => arg.startsWith('--scenario='))?.slice('--scenario='.length) || 'full' }).then(({ exitCode }) => { process.exitCode = exitCode; });
  task.catch(() => { console.error('模型交接探针无法启动；请检查独立依赖、明确的清单及配置来源。'); process.exitCode = 1; });
}
