// Claude 远程传输服务：网页端提交需求 -> 本机 claude -p 在工作文件夹里执行 -> 结果实时回传网页
// 运行：node server.js （首次需要 npm install）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const capabilityUser = require('./url-capability');
const receiveFile = require('./upload-stream');
const boundedJobs = require('./bounded-jobs');
const workspacePath = require('./workspace-path');
const runtimeHealth = require('./tools/runtime-health.cjs');
const { buildHandoff } = require('./tools/model-handoff.cjs');
const { buildModelInstructions } = require('./tools/model-instructions.cjs');
const { REVIEW_PROMPT, collaborationRequest } = require('./tools/model-collaboration.cjs');
const { canRecoverSession, hasToolEvents, RECOVERY_NOTICE } = require('./tools/model-session-recovery.cjs');
const { createFinalizationBarrier } = require('./tools/model-finalization.cjs');
const modelFinalization = createFinalizationBarrier();
const { createPageShell } = require('./tools/page-shell.cjs');
const { createDrain, taskRequest, localMaintenanceRequest } = require('./tools/maintenance-drain.cjs');
const maintenanceDrain = createDrain();
const MAINTENANCE_REQUEST_DONE = Symbol('maintenance-request-done');
const DRAIN_MESSAGE = '服务准备更新，请稍后再试。正在进行的任务会先完成。';
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- 配置 ----------
// GPT（Codex）的思考深度：比 Claude 的五档多一档 ultra（最高，GPT-6 Luna 没有）
const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_CONFIG = {
  port: 8765,
  host: '0.0.0.0',
  password: '',
  userName: '',
  workDir: 'D:\\Claude_for_Friend',
  claudePath: 'claude',
  models: [
    { id: 'opus', label: 'Opus 5.5', desc: '最聪明，适合复杂、需要深度思考的任务' },
    { id: 'sonnet', label: 'Sonnet 5.5', desc: '又快又聪明，日常使用首选' },
    { id: 'haiku', label: 'Haiku 5.5', desc: '速度最快，适合简单问题' },
  ],
  // GPT（经 OpenAI 的 Codex 命令行，按 API 用量计费）：只给 gptUsers 里的账号看到；config.openaiApiKey 是 API 密钥。
  // price（可选）：每百万 token 的美元价格 { input, cachedInput, output }，填了才显示每轮花费
  // 定位来自 Codex 的模型列表，价格来自 OpenAI 官方价格页（2026-10-31，标准档；输入超过 27.2 万 token 时贵一倍左右，这里没算）
  gptModels: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', desc: 'OpenAI 最聪明，适合最难、最需要深度思考的任务',
      price: { input: 10, cachedInput: 1, output: 50 }, efforts: GPT_EFFORTS },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', desc: '主力模型，写作、分析、写代码、做文件都好用',
      price: { input: 2, cachedInput: 0.1, output: 10 }, efforts: GPT_EFFORTS },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', desc: '均衡省钱，价格约为 Sol 的一半',
      price: { input: 1, cachedInput: 0.05, output: 5 }, efforts: GPT_EFFORTS },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', desc: '最快最便宜，适合简单问题和小改动',
      price: { input: 0.1, cachedInput: 0.01, output: 0.5 }, efforts: GPT_EFFORTS.slice(0, 5) },
  ],
  gptUsers: [],
  codexPath: 'codex',
  // Gemini（经 Google Antigravity 的命令行 agy，用机主登录的 Google 账号额度）：只给 geminiUsers 里的账号看到，
  // 只在隔离模式下可用（agyPath 是固定副本的绝对路径）。id 加上思考深度后缀就是 agy 的型号名，如 gemini-4-neon-high；
  // efforts 是这个型号在 agy 里有的档位
  geminiModels: [
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon', desc: 'Google 最新的 Gemini 4，适合复杂、需要深度思考的任务', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon', desc: 'Gemini 4 的 Pro 档，擅长分析、写作和推理', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', desc: '擅长动手执行，适合步骤多的文件和代码任务', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
  geminiUsers: [],
  agyPath: '',
  defaultModel: 'sonnet',
  defaultEffort: 'medium',
  titleModel: 'haiku',
  // 轻量模式：不加载你账号里的插件、钩子和 MCP 服务器，首字快约 6 倍、费用低约 6 倍
  lightweight: true,
  // 实时显示思考摘要；translateThinking 会把英文摘要用 Haiku 翻译成中文
  showThinking: true,
  translateThinking: true,
  // 接入 Consensus 论文搜索和引用核查服务（mcp-servers.json），每条消息多约 1 秒
  academicSearch: true,
  // 用户打字时提前启动 Claude，第一个字能早出 2~3 秒
  prewarm: true,
  maxConcurrent: 2,
  // 每个账号最多同时回复几个（maxConcurrent 是所有账号加起来的上限）。以前只有总上限，一个人占满了另一个人就发不了
  maxPerUser: 2,
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'PowerShell',
    'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit', 'Task', 'Skill', 'ToolSearch'],
  // 不让远程任务动到你账号里的云端东西（Artifact 发布、Docs、定时任务、推送等）
  disallowedTools: ['Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync', 'PushNotification',
    'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'EnterWorktree', 'mcp__claude_ai_Claude_Docs'],
  extraArgs: [],
  // 桌面宠物（D:\mini-pet）的钩子脚本。回复被停止或出错时用它告诉宠物「这个会话结束了」，见 notifyPetEnded
  petHook: '',
  // 公网访问：运行「设置公网访问.bat」后自动填写
  tunnel: { enabled: false, name: '', hostname: '', cloudflaredPath: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' },
  secret: '',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  let changed = !fs.existsSync(CONFIG_PATH);
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) if (!(k in cfg)) { cfg[k] = v; changed = true; }
  if (!cfg.password && !(Array.isArray(cfg.users) && cfg.users.length)) { cfg.password = crypto.randomBytes(9).toString('base64url'); changed = true; }
  if (!cfg.secret) { cfg.secret = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (changed) writeFileSafe(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const config = loadConfig();
// Activation is explicit; the candidate is inert for existing installations.
// 验收没通过（比如 Claude Code 自动更新后文件指纹变了）时拒绝启动模型和工作区操作，但网站照常打开、历史对话能看：
// 不会退回到无隔离运行，也不会因为一次程序更新就让整个网站打不开。原因见 isolationBlocked，恢复办法见 blockedIsolation
let isolationBlocked = null;
if (config.isolation?.enabled) {
  const readiness = require('./tools/check-isolation.cjs').check(config, undefined, ROOT, __dirname);
  if (!readiness.readyToEnableIsolation) isolationBlocked = readiness.remainingRequirements.slice(0, 20);
}
const BLOCKED_MESSAGE = '暂时无法回复和处理文件，历史对话仍可查看。请稍后再试，或联系机主。';
function blockedReason(reason) {
  // 只展示已知检查类别，避免把启动异常中的路径、凭证或原始错误带到网页。
  const text = typeof reason === 'string' ? reason : '';
  const fixed = {
    '完整验收记录尚未生成。': '尚无完整验收记录',
    '验收记录格式无效。': '验收记录格式无效',
    '缺少已验收版本的文件指纹。': '验收记录缺少文件指纹',
    '验收文件无法读取或指纹无效。': '验收文件无法读取或指纹无效',
    '账号或执行路径与验收配置不一致。': '账号或执行路径与已验收配置不一致',
    '独立运行环境或执行入口尚未就绪。': '隔离运行环境或程序入口尚未就绪',
    'GPT 已退出验收范围：gptUsers 必须为空。': 'GPT 已退出平台，配置里仍给账号开着 GPT',
    '账号工作区映射缺失。': '账号工作区映射缺失',
    '账号映射无效。': '账号工作区映射无效',
    '运行组件缺失：whisperModel': '语音识别模型缺失',
  };
  if (Object.hasOwn(fixed, text)) return fixed[text];
  const checks = {
    pdf: 'PDF 转换', voiceOnline: '在线语音', voiceOffline: '离线语音', stt: '语音识别', ocr: '文字识别',
    scientific: '科研计算', media: '媒体处理', html: '网页制作', tex: '公式排版', gpu: 'GPU', eve: 'EVE',
    claudeSubscription: 'Claude 本机订阅', claudeHistory: 'Claude 历史', gptApi: 'GPT 原 API',
    gptHistory: 'GPT 历史', geminiSubscription: 'Gemini 本机登录', geminiHistory: 'Gemini 历史', research: '文献检索', serverEndToEnd: '完整使用流程',
    filesystemDeny: '文件访问边界', networkDeny: '网络访问边界', uiDesktopDeny: '桌面访问边界',
    cancellation: '任务取消', parentDeath: '父进程退出', regression: '回归测试', candidateReview: '候选审查',
  };
  if (text.startsWith('尚未通过：')) return Object.hasOwn(checks, text.slice(5))
    ? checks[text.slice(5)] + '尚未通过验收' : '仍有验收项目未通过';
  const file = /^(验收后文件已变化|版本指纹未覆盖|验收文件存在重复指纹)：(.+)$/.exec(text);
  if (file) {
    const names = { 'server.js': '服务代码', 'claude.exe': 'Claude 程序', 'codex.exe': 'Codex 程序',
      'codex-command-runner.exe': 'Codex 命令组件', 'codex-windows-sandbox-setup.exe': 'Codex 隔离组件',
      'codex-exec-server.exe': 'Codex 执行组件', 'check-isolation.cjs': '隔离核对代码' };
    const name = Object.hasOwn(names, file[2]) ? names[file[2]] : '程序或依赖文件';
    return name + (file[1] === '验收后文件已变化' ? '与已验收版本不一致' : file[1] === '版本指纹未覆盖' ? '未纳入完整验收' : '存在重复验收指纹');
  }
  if (text.startsWith('工作区根目录被重定向或不是目录：')) return '账号工作区路径被重定向或不是目录';
  if (text.startsWith('工作区不存在：')) return '账号工作区不存在';
  if (text.startsWith('隔离运行环境无法启动：')) return '隔离运行环境无法启动';
  return '隔离核对未通过，需在本机查看检查结果';
}
function blockedMessage(u) {
  if (u?.profile !== 'owner') return BLOCKED_MESSAGE;
  const reasons = [...new Set((Array.isArray(isolationBlocked) ? isolationBlocked : []).map(blockedReason))].slice(0, 6);
  return '模型和文件功能暂时停用，历史对话仍可查看。原因：' + (reasons.join('；') || '隔离核对未通过') +
    '。下一步：在本机运行 node tools/check-isolation.cjs 查看明细，再由 Claude 审查变化并完成对应验收后恢复。';
}

function blockedIsolation() {
  const fail = () => { throw Object.assign(new Error(BLOCKED_MESSAGE), { code: 'ISOLATION_BLOCKED', statusCode: 503 }); };
  const io = new Proxy({}, { get: () => fail });
  return new Proxy({ closeAll: async () => {} }, { get: (t, k) => (k === 'io' ? io : t[k] || fail) });
}
let isolation = null;
if (config.isolation?.enabled) {
  if (!isolationBlocked) {
    try { isolation = require('./isolation').createIsolation(config, ROOT); }
    catch (e) { isolationBlocked = ['隔离运行环境无法启动：' + e.message]; }
  }
  if (isolationBlocked) {
    isolation = blockedIsolation();
    console.log(' [隔离] 验收未通过，模型和工作区操作已停用，网站其余部分照常：\n  - ' + isolationBlocked.join('\n  - '));
  }
}

// 异步版：不卡住服务器（隔离下每次文件操作都要启动一个隔离进程，约 0.4 秒；同步调用期间所有人的回复都停着）
const workRows = (u, operations) => maintenanceDrain.background(() => isolation.io.batch(isolation.context(u), operations));
async function workAsync(u, operations) {
  const rows = await workRows(u, operations);
  for (const row of rows) if (!row.ok) throw Object.assign(new Error(row.error.message), { code: row.error.code });
  return rows.map((row) => row.value);
}

// ---------- 隔离模式的读缓存 ----------
// 记忆、项目信息、项目资料列表都在模型可写的工作文件夹里，所以必须经隔离进程读（防止被换成指向外面的链接）。
// 这些内容读得非常频繁（每次取状态、发消息、预热），改得很少（回复结束、上传、编辑时），所以在内存里留一份：
// 读的时候直接用，改的时候在后台异步刷新。读取方式和隔离边界都不变，只是不再每次都读
const accountSnaps = new Map(); // 账号 id -> { memory, memoryMtime, projects: Map(项目 id -> { p, memory, files, texts, version }), at }
const snapJobs = new Map(); // 账号 id -> { running, again }
const EMPTY_SNAP = { memory: '', memoryMtime: 0, projects: new Map(), at: Infinity }; // 验收没过：不碰工作区
const snapOf = (u) => (!config.isolation?.enabled ? null : isolationBlocked ? EMPTY_SNAP : accountSnaps.get(u.id) || null);
async function loadSnap(u) {
  const [mem, st, dir] = await workRows(u, [{ type: 'readText', path: '.memory/memory.md', maxBytes: 1024 * 1024 }, { type: 'stat', path: '.memory/memory.md' }, { type: 'list', path: 'projects' }]);
  if (!dir.ok && dir.error?.code !== 'ENOENT') throw new Error(dir.error?.message || '读取项目列表失败');
  const ids = dir.ok ? dir.value.filter((e) => e.isDirectory && !e.isSymbolicLink && validPid(e.name)).map((e) => e.name) : [];
  const projects = new Map();
  for (let start = 0; start < ids.length; start += 64) {
    const group = ids.slice(start, start + 64);
    const rows = await workRows(u, group.flatMap((id) => [
      { type: 'readJson', path: `projects/${id}/.project/project.json`, maxBytes: 1024 * 1024 },
      { type: 'readText', path: `projects/${id}/.project/memory.md`, maxBytes: 1024 * 1024 },
      { type: 'snapshot', path: `projects/${id}/files`, textExtensions: [...INLINE_TEXT_EXTS], textBudget: INLINE_BUDGET },
      { type: 'stat', path: `projects/${id}/.project/project.json` },
      { type: 'stat', path: `projects/${id}/.project/memory.md` },
      { type: 'stat', path: `projects/${id}/files` },
    ]));
    group.forEach((id, i) => {
      const r = rows.slice(i * 6, i * 6 + 6);
      if (!r[0]?.ok || !r[0].value) return;
      const mt = (x) => (x?.ok ? x.value.mtime : 0);
      projects.set(id, { p: r[0].value, memory: r[1]?.ok ? r[1].value : '', files: (r[2]?.value?.files || []).sort((a, b) => b.mtime - a.mtime),
        texts: r[2]?.value?.texts || [], version: `${mt(r[3])}:${mt(r[4])}:${mt(r[5])}` });
    });
  }
  accountSnaps.set(u.id, { memory: mem?.ok ? mem.value : '', memoryMtime: st?.ok ? st.value.mtime : 0, projects, at: Date.now() });
}
// 同时只刷一次；刷的过程中又有改动就再刷一遍，保证返回后看到的是调用之后的内容
function refreshSnap(u) {
  if (!config.isolation?.enabled || isolationBlocked) return Promise.resolve();
  let job = snapJobs.get(u.id);
  if (job) { job.again = true; return job.running; }
  job = { again: false, running: null };
  snapJobs.set(u.id, job);
  job.running = maintenanceDrain.background(async () => {
    try { do { job.again = false; await loadSnap(u); } while (job.again); }
    catch (e) { console.log(` [${u.id}] 刷新工作区缓存失败：${e.message}`); }
    finally { snapJobs.delete(u.id); }
  });
  return job.running;
}
// 取状态前用：第一次等它读好（不卡别人），之后直接用，旧了在后台刷新
async function freshEnoughSnap(u) {
  if (!config.isolation?.enabled || isolationBlocked || maintenanceDrain.blocked()) return;
  const snap = accountSnaps.get(u.id);
  if (!snap) await refreshSnap(u);
  else if (Date.now() - snap.at > 30e3) refreshSnap(u);
}

// 同步的隔离文件操作会让整个服务停住等它（平时约 0.4 秒）。隔离进程偶尔卡住时，默认 60 秒的时限加上执行层自己的
// 余量，要一分多钟才报错，这期间网站对所有人都没反应（2026-11-21 早上出过一次）。server.js 里所有同步的隔离调用都用
// 这个 10 秒的时限：执行层还会再加几秒到二十几秒的余量，所以实际是十几秒报错，最坏三十多秒。
// 简写（listSync、scanSync、readJsonSync）传不了时限，这里一律写成 operationSync / batchSync
const SYNC_IO = { timeoutMs: 10000 };
function workOperation(u, type, absolute, extra = {}) {
  return isolation.io.operationSync(isolation.context(u), { type, path: toRel(u, absolute), ...extra }, SYNC_IO);
}
function workBatch(u, operations) {
  const rows = isolation.io.batchSync(isolation.context(u), operations, SYNC_IO);
  for (const row of rows) if (!row.ok) throw Object.assign(new Error(row.error.message), { code: row.error.code });
  return rows.map(row => row.value);
}
function workExists(u, absolute) {
  if (!config.isolation?.enabled) return fs.existsSync(absolute);
  try { workOperation(u, 'stat', absolute); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function workText(u, absolute, maxBytes = 1024 * 1024) {
  return config.isolation?.enabled ? workOperation(u, 'readText', absolute, { maxBytes }) : fs.readFileSync(absolute, 'utf8');
}
function workWrite(u, absolute, text) {
  return config.isolation?.enabled ? workOperation(u, 'writeText', absolute, { text, parents: true }) : fs.writeFileSync(absolute, text, 'utf8');
}
function workRemove(u, absolute, options = {}) {
  return config.isolation?.enabled ? workOperation(u, 'remove', absolute, options) : fs.rmSync(absolute, options);
}

// ---------- 账号 ----------
// config.users：每个账号有自己的密码、工作文件夹、对话、记忆和 Claude 配置。
//   profile 'guest'：给不懂技术的用户的那套（文档类技能、聊天风格、只在自己文件夹里工作）
//   profile 'owner'：机主自己远程用（技术向；和访客账号一样只在自己的工作文件夹里工作，见 OWNER_PROMPT 和 tools/memory_guard.js）
//   lightweight：不写就用全局 config.lightweight；false = 加载机主本机 Claude Code 的全部插件/技能/MCP（慢约 10 秒）
if (!Array.isArray(config.users) || !config.users.length) {
  config.users = [{ id: 'user', name: config.userName || '', password: config.password, workDir: config.workDir, profile: 'guest' }];
}
// 工具箱（Python 虚拟环境、Node 包、语音模型）只装一份，放在 toolboxDir 里，各账号共用
const TOOLBOX_DIR = path.resolve(config.toolboxDir || config.workDir || config.users[0].workDir);

function makeUser(u) {
  const workDir = path.resolve(u.workDir);
  const dataDir = path.join(ROOT, 'data', 'users', u.id);
  const memDir = path.join(workDir, '.memory');
  const user = {
    id: u.id, name: u.name || u.id, password: String(u.password || ''), profile: u.profile || 'guest',
    lightweight: typeof u.lightweight === 'boolean' ? u.lightweight : config.lightweight,
    workDir, convDir: path.join(dataDir, 'conversations'), prefsFile: path.join(dataDir, 'prefs.json'),
    memoryFile: path.join(memDir, 'memory.md'), chatsDir: path.join(memDir, 'chats'),
  };
  fs.mkdirSync(user.convDir, { recursive: true });
  if (isolationBlocked) { /* 验收没过：不碰工作区 */ }
  else if (config.isolation?.enabled) {
    // Explicit relative paths also avoid accessing const helpers before startup initialization.
    const ctx = isolation.context(user);
    const rows = isolation.io.batchSync(ctx, [{ type: 'mkdir', path: '.memory/chats' }, { type: 'mkdir', path: 'chats' },
      { type: 'writeText', path: '.memory/memory.md', text: '', exclusive: true }]);
    for (const row of rows) if (!row.ok && row.error.code !== 'EEXIST') throw new Error(row.error.message);
  } else {
    for (const d of [user.chatsDir, path.join(workDir, 'chats')]) fs.mkdirSync(d, { recursive: true });
    if (!fs.existsSync(user.memoryFile)) fs.writeFileSync(user.memoryFile, '', 'utf8');
  }
  return user;
}
const USERS = new Map(config.users.map((u) => [u.id, makeUser(u)]));

// 访客（guest 配置）的系统提示：给不懂技术的用户
const GUEST_PROMPT = (u) => [
  'You are being used through a private chat web page that mirrors claude.ai, by a non-technical user the owner shares this service with.',
  'Treat it like a normal conversation: answer questions directly and conversationally; only use tools when the request needs files, code, research or other real work.',
  'The user cannot see this terminal or approve permission prompts, and cannot reply until your turn ends, so finish tasks in one go with sensible assumptions (state them briefly).',
  `Work only inside the current working directory (${u.workDir}); never read or change files outside it.`,
  'Every conversation has its own folder, named in a note at the end of each user message: files the user attaches are in its uploads subfolder (read images with the Read tool to see them),',
  'and every deliverable file must be saved in its outputs subfolder; mention the file names. Do not read or change other conversations\' folders unless the user asks.',
  'The page shows the user the files you created or changed so they can be previewed and downloaded. Never tell the user to open a terminal or run commands themselves.',
  'Reply in the language the user writes in (usually Simplified Chinese), formatted in Markdown; LaTeX math with $...$ or $$...$$ renders on the page.',
  // 回答的样子（2026-11-21 加）：先说结论、长短跟着问题走、少堆格式；引文必须准确；能猜对的不反问
  'Answer the way a knowledgeable, friendly expert would. Lead with the answer or the result, then give the reasoning the user needs; match the length to the question, so a short question gets a short answer.',
  'Write connected prose for conversation and explanation. Keep headings, bullet lists and tables for content that really has that shape (steps, comparisons, reference material), and do not pile up bold text, emoji or closing offers of more help.',
  'When you quote a poem, a classical text, a book or a scholar, quote it exactly and name the source; if you are not sure of the wording or where it comes from, look it up or say so instead of rebuilding it from memory. Keep what a text says separate from your own reading of it.',
  'If a request is ambiguous but answerable, take the most likely reading, answer it and name the assumption in a short clause; ask first only when a wrong guess would waste real work.',
  'Each message ends with a note giving the user\'s current local date and time when the page provides it; use it for anything about today, deadlines or schedules.',
  'After file work, say in a sentence or two what you made and which choices matter; do not paste the whole file into the chat or recount every internal step.',
  'The page shows your task list as a live progress checklist, which the user relies on to follow longer jobs. Whenever a request involves real work with two or more steps',
  '(creating or editing more than one file, research then writing, building an app or game, multi-part documents), first create one task per step',
  'with a short subject and activeForm in the user\'s language,',
  'then mark each task in_progress right before you start it and completed right after it is done. Only skip the list for plain questions and single quick edits.',
  'Between steps, write one short sentence about what you are doing next so the user can follow along.',
  'Skills are installed for Word/PPT/Excel/PDF files, learning, reading notes, citations, essays and literature reviews, data analysis,',
  'and making images and narrated videos (media-maker); use them when relevant.',
  'Node packages docx and pptxgenjs resolve via NODE_PATH; ffmpeg, Edge, LibreOffice (soffice), pandoc and Chinese fonts are installed.',
  'OCR (images/scanned PDFs) and speech-to-text (lectures/interviews) are available offline via the ocr-and-transcribe skill. Do not pip/npm install unless something is truly missing.',
  'For academic questions you can search real papers with the consensus tools and verify references with the reference-lookup tools; prefer real sources over memory, and never invent citations.',
  'Keep scratch and intermediate files (scripts, temp renders, unpacked files) in ./.work, which is hidden from the user\'s file list; only finished deliverables go in the outputs folder.',
].join(' ');

// 机主（owner 配置）的系统提示：理工科研究者；这个网页只是 Claude 的中转，和访客账号一样只在自己的文件夹里工作，不读本机其他文件
const OWNER_PROMPT = (u) => [
  `You are being used through a private chat web page (a claude.ai-like UI) by the owner of this Windows PC${u.name ? ` (${u.name})` : ''}, a STEM researcher`,
  'working on super-resolution fluorescence microscopy: event-based single-molecule localization microscopy (EBS-SMLM) with Prophesee event cameras and the EVE software,',
  'and simulation of frame- and event-based acquisition. Treat him as a technical peer: be precise and concise, show the math (LaTeX with $...$ / $$...$$ renders on his page),',
  'give units and uncertainties, and say clearly what you verified versus what you assume. Reply in the language he writes in, formatted in Markdown.',
  // 回答的样子（2026-11-21 加）
  'Lead with the result, then the derivation or evidence he needs to check it; do not restate the question or pad the end with summaries and offers. Use tables for comparisons and numbered steps for procedures, plain prose otherwise.',
  'When something is uncertain, say what measurement, test or source would settle it. Each message ends with a note giving his current local date and time when the page provides it; use it for anything about today or deadlines.',
  'He cannot see this terminal or approve permission prompts, and cannot reply until your turn ends, so finish tasks in one go and state assumptions briefly.',
  `Your working directory is ${u.workDir}. Every conversation has its own folder, named in a note at the end of each of his messages: attachments are in its uploads subfolder,`,
  'and deliverable files (figures, tables, PDFs, code, results) go in its outputs subfolder — name them, his page lists them for preview and download. Scratch files go in ./.work.',
  'Python: use D:\\conda_envs\\gpu312 (PyTorch with CUDA on an RTX 4090 24 GB, numpy/scipy/pandas/matplotlib/scikit-image/scikit-learn/opencv/h5py/tifffile) for everything,',
  'except Prophesee RAW decoding, which needs D:\\Miniconda3\\envs\\eve39 (Metavision Python bindings and the eve-SMLM package). Never install into or change eve39; only pip install into gpu312 if something is truly missing.',
  'Also installed: TeX Live 2026 (xelatex/latexmk/biber), LibreOffice, pandoc, ffmpeg.',
  'Project skills: smlm-analysis (render, NeNA, FRC, RCC drift, DBSCAN), event-camera-data (EVE HDF5, RAW conversion, EVE runs), latex-paper, media-maker, ocr-and-transcribe,',
  'plus the document, data, research-desk and engineering skills from his global setup. For literature use the consensus and reference-lookup tools (arXiv included) and never invent citations.',
  `This page is only an assistant relay for him (he works from other computers), exactly like the other account: work only inside your working directory (${u.workDir}). Do not read, search, change or run anything elsewhere on this PC — no files outside that folder, no other projects or data on the disks — beyond calling the installed programs and Python environments named here. The data you work on is what he attaches or what you create in this folder.`,
  'His page shows your task list as a live checklist: for work with two or more steps,',
  'create one task per step, and mark each in_progress/completed as you go.',
].join(' ');

const systemPrompt = (u) => (u.profile === 'owner' ? OWNER_PROMPT(u) : GUEST_PROMPT(u));
const claudeToolPrompt = (u) => [
  'For multi-step work, first load the task tools with ToolSearch (query "select:TaskCreate,TaskUpdate"), then create the tasks required by the profile below.',
  u.profile === 'owner' ? '' : 'Python libraries are in .venv (call .venv/Scripts/python.exe from Bash). Protected runtime rules above take priority when isolation is enabled.',
].filter(Boolean).join(' ');

// 计划清单用的工具（延迟加载，需要先 ToolSearch）
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
// 不在「工作过程」里单独列出的内部工具
const QUIET_TOOLS = new Set([...TASK_TOOLS, 'ToolSearch', 'TodoWrite']);
// 工作文件夹里的工具箱：.venv（Python 文档/图表/音视频库）和 .tools/node_modules（docx、pptxgenjs）
const VENV_BIN = path.join(TOOLBOX_DIR, '.venv', 'Scripts');
const VENV_PY = path.join(VENV_BIN, 'python.exe');
const SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const TOOL_ENV = {
  ...process.env,
  PATH: [VENV_BIN, path.dirname(SOFFICE), path.join(process.env.LOCALAPPDATA || '', 'Pandoc'), process.env.PATH].join(path.delimiter),
  VIRTUAL_ENV: path.join(TOOLBOX_DIR, '.venv'),
  NODE_PATH: path.join(TOOLBOX_DIR, '.tools', 'node_modules'),
  HF_HOME: path.join(TOOLBOX_DIR, '.tools', 'hf'),
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};
// 轻量模式下额外接入的学术检索服务（论文搜索、引用核查）
const MCP_FILE = path.join(ROOT, 'mcp-servers.json');
const QUICK_ARGS = ['--strict-mcp-config', '--setting-sources', 'project,local']; // 起标题、翻译等一次性小任务永远用轻量
const LIGHT_ARGS = (u) => (u.lightweight
  ? [...QUICK_ARGS, ...(config.academicSearch && fs.existsSync(MCP_FILE) ? ['--mcp-config', MCP_FILE] : [])]
  : []);

// ---------- 工具函数 ----------
const sign = (v) => crypto.createHmac('sha256', config.secret).update(v).digest('hex');
// 登录 cookie：「账号.签名」；签名里含密码，改密码后旧 cookie 自动失效
const userToken = (u) => u.id + '.' + sign('relay-auth:' + u.id + ':' + u.password);
// 改成多账号之前签发的 cookie（只按密码签名），对应用同一密码的那个账号，免得用户要重新登录
const legacyToken = (u) => sign('relay-auth:' + u.password);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// 返回当前登录的账号，没登录返回 null
// 登录凭证从哪来：优先 cookie；有的手机内置浏览器（微信等）存不住 cookie，就用请求头 X-Relay-Token，
// 实时推送和文件链接使用独立的限时资源签名，网址不接受账号登录凭证
function reqToken(req) {
  const c = parseCookies(req).relay_token;
  if (c) { req.authVia = 'cookie'; return c; }
  if (req.headers['x-relay-token']) { req.authVia = 'header'; return String(req.headers['x-relay-token']); }
  return '';
}
function authUser(req) {
  const tok = reqToken(req);
  const id = tok.includes('.') ? tok.slice(0, tok.indexOf('.')) : '';
  if (id) { const u = USERS.get(id); return u && safeEqual(tok, userToken(u)) ? u : null; }
  for (const u of USERS.values()) if (tok && safeEqual(tok, legacyToken(u))) return u;
  return null;
}
// 日志里简单标一下是什么浏览器（排查登录问题用）
function shortUA(req) {
  const ua = String(req.headers['user-agent'] || '');
  const tags = [/MicroMessenger/.test(ua) && '微信', /MQQBrowser|QQ\//.test(ua) && 'QQ', /HuaweiBrowser|HONOR/.test(ua) && '华为/荣耀浏览器',
    /MiuiBrowser|XiaoMi/.test(ua) && '小米浏览器', /HeyTapBrowser|OPPO/.test(ua) && 'OPPO 浏览器', /VivoBrowser/.test(ua) && 'vivo 浏览器',
    /UCBrowser/.test(ua) && 'UC', /Quark/.test(ua) && '夸克', /EdgA?\//.test(ua) && 'Edge', /Chrome\//.test(ua) && 'Chrome内核', /Safari\//.test(ua) && !/Chrome/.test(ua) && 'Safari',
    /Android/.test(ua) && '安卓', /iPhone|iPad/.test(ua) && 'iOS', /Windows/.test(ua) && 'Windows'].filter(Boolean);
  return tags.length ? tags.join('/') : ua.slice(0, 60) || '未知浏览器';
}
// 登录 cookie：SameSite=Lax，这样从微信等别的应用点链接打开时也会带上（Strict 不会）
function setAuthCookie(req, res, u) {
  res.setHeader('Set-Cookie', `relay_token=${userToken(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${isHttps(req) ? '; Secure' : ''}`);
}
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
// 经 Cloudflare 隧道进来的请求，真实 IP 在 cf-connecting-ip 里
const clientIp = (req) => (isLoopback(req.socket.remoteAddress) && req.headers['cf-connecting-ip']) || req.socket.remoteAddress;
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /"https"/.test(req.headers['cf-visitor'] || '');

// 存档写到一半断电/重启，文件会只剩半截（对话就打不开了）。所以先完整写进旁边的临时文件、刷到磁盘，
// 再一步改名换掉旧文件：任何时候磁盘上要么是旧的完整版，要么是新的完整版。改名偶尔被杀毒软件占着失败时退回直接写
function writeFileSafe(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, data, 'utf8'); fs.rmSync(tmp, { force: true }); }
}

// ---------- 给网页的错误文字 ----------
// 程序启动失败、接口出错时的原始文字里常有这台电脑的路径（用户名、工作目录）甚至密钥形状的字符串。
// 发给网页前去掉这些，只留末尾 600 字；前端靠来分类的关键词（quota、Prompt is too long、ECONNRESET 等）保留。原文只写 relay.log。
function pageErrorText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\\\\[^\\\s"'<>|]+\\[^\s"'<>|]*/g, '<本机路径>')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, '<本机路径>')
    .replace(/(^|[\s"'(=])\/(?:Users|home|root|mnt|tmp|var)\/[^\s"'<>|]*/g, '$1<本机路径>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<已隐藏>')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <已隐藏>')
    .replace(/\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<已隐藏>')
    .slice(-600);
}
// ---------- 给网页的错误文字结束 ----------
// ---------- 压缩 ----------
// 网站经公网隧道出去，这一段最慢（电脑 → 代理 → Cloudflare）。文字类的回应在本机先压好再发：首页约 40 万字节压到
// 11 万左右，对话和列表的 JSON 通常能小到五分之一。Cloudflare 把压好的内容原样交给浏览器。实时推送（SSE）不压，
// 压了会攒着不发。浏览器不收压缩内容（没带 Accept-Encoding）就照旧发原文
const acceptedEncoding = (req) => { const a = String(req?.headers?.['accept-encoding'] || ''); return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null; };
// quality：现压现发的（JSON）用 4，又快又比 gzip 小；压一次存起来反复用的（首页、前端库）用 9
function compressSync(buffer, encoding, quality = 4) {
  return encoding === 'br'
    ? zlib.brotliCompressSync(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length } })
    : zlib.gzipSync(buffer, { level: quality >= 9 ? 9 : 6 });
}
// 压一次、反复发的内容：按「名字 + 版本 + 编码」记在内存里。版本变了（页面更新、文件改了）旧的那份就丢掉
const compressedCache = new Map();
// buffer 可以是内容，也可以是一个返回内容的函数（命中缓存时不用读文件）
function compressedCopy(name, version, buffer, encoding) {
  const hit = compressedCache.get(name + '|' + encoding);
  if (hit && hit.version === version) return hit.body;
  const body = compressSync(typeof buffer === 'function' ? buffer() : buffer, encoding, 9);
  compressedCache.set(name + '|' + encoding, { version, body });
  return body;
}
// 文字类的静态文件（前端库、样式、Service Worker、清单、SVG）：压好的那份记住，文件没变就一直用
const COMPRESSIBLE_EXT = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.html', '.txt']);
function sendStaticFile(req, res, file, headers) {
  const compressible = COMPRESSIBLE_EXT.has(path.extname(file).toLowerCase()), encoding = compressible ? acceptedEncoding(req) : null;
  const plain = () => { res.writeHead(200, compressible ? { ...headers, Vary: 'Accept-Encoding' } : headers); return fs.createReadStream(file).pipe(res); };
  if (!encoding) return plain();
  let stat, body;
  try { stat = fs.statSync(file); body = stat.size > 1024 && stat.size < 8 * 1024 * 1024 ? compressedCopy(file, stat.size + ':' + stat.mtimeMs, () => fs.readFileSync(file), encoding) : null; }
  catch { body = null; }
  if (!body) return plain();
  res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length, Vary: 'Accept-Encoding' });
  return res.end(body);
}
function sendJSON(res, code, obj) {
  if (code >= 400 && obj && typeof obj.error === 'string') obj = { ...obj, error: pageErrorText(obj.error) };
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const text = JSON.stringify(obj);
  // 小的回应不值得压；大的（对话全文、列表、文件清单）压了再发。不压的那条路和原来一字不差
  // /api/state 里有登录令牌，也照样压（它带着上次那个对话的全文，是打开网页时最大的一个 JSON）。把令牌和别的内容压在
  // 一起，理论上回应长度会泄露一点点信息（BREACH 那一类办法），在这里不成立：回应不回显请求里的任何内容，Cookie 是
  // HttpOnly + SameSite=Lax、没有 CORS，跨站发不了带登录的请求；Cloudflare 本来也会在边缘把 JSON 压了再给浏览器
  const encoding = typeof text === 'string' && text.length > 1400 ? acceptedEncoding(res.req) : null;
  if (encoding) {
    let body = null;
    try { body = compressSync(Buffer.from(text, 'utf8'), encoding); } catch { /* 压不了就发原文 */ }
    if (body) { res.writeHead(code, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length, Vary: 'Accept-Encoding' }); return res.end(body); }
  }
  res.writeHead(code, headers);
  res.end(text);
}

// raw：返回原始字节（上传的数据块），否则按 UTF-8 文字返回。请求中途断开（用户切走了网页）时 reject，不会挂着
function readBody(req, limit = 1e6, raw = false) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); resolve(raw ? b : b.toString('utf8')); });
    req.on('close', () => { if (!req.complete) reject(new Error('aborted')); });
    req.on('error', reject);
  });
}

// ---------- 上传 ----------
const UPLOAD_LIMIT = 500 * 1024 * 1024;
const PART_MAX = 8 * 1024 * 1024; // 分块上传每块的上限（网页每块发 4MB）
const PART_DIR = path.join(ROOT, 'data', 'uploads-partial'); // 还没传完的文件，<id> 是已收到的部分，<id>.json 记着传到哪、叫什么
const partPath = (id) => path.join(PART_DIR, id);
const readPartMeta = (id) => { try { return fs.existsSync(partPath(id)) ? JSON.parse(fs.readFileSync(partPath(id) + '.json', 'utf8')) : null; } catch { return null; } };
const PART_RECEIPT_TTL = 3600e3; // 最后一块的成功响应丢失时，一小时内仍能找回同一份已上传文件
const partReceiptPath = (id) => partPath(id) + '.done.json';
function readPartReceipt(id) {
  try {
    const receipt = JSON.parse(fs.readFileSync(partReceiptPath(id), 'utf8'));
    if (!Number.isFinite(receipt.completedAt) || Date.now() - receipt.completedAt >= PART_RECEIPT_TTL) {
      fs.rmSync(partReceiptPath(id), { force: true });
      return null;
    }
    return receipt;
  } catch { return null; }
}
function cleanPartReceipts() {
  try {
    for (const f of fs.readdirSync(PART_DIR)) if (/^[a-f0-9]{16}\.done\.json$/.test(f)) readPartReceipt(f.slice(0, 16));
  } catch {}
}
const cleanName = (name) => path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
// 附件放哪：项目里的 → 项目共用的 uploads（to=files 时放进项目资料）；普通对话 → 它自己的 uploads
function uploadDir(u, pid, cid, to) {
  if (pid && !loadProject(u, pid)) return { error: '项目不存在', code: 404 };
  if (cid && !validId(cid)) return { error: '对话编号不对', code: 400 };
  const dir = pid ? (to === 'files' ? projFilesDir(u, pid) : path.join(projDir(u, pid), 'uploads'))
    : cid ? path.join(u.workDir, 'chats', cid, 'uploads') : path.join(u.workDir, 'uploads');
  return resolveIn(u, dir) ? { dir } : { error: '上传位置不在当前账号的文件夹内', code: 403 };
}
// ---------- 关联文件夹（桌面端）----------
// 用户在桌面端选一个自己电脑上的文件夹，桌面端把里面的文件传到 工作文件夹/linked/<编号>/（子文件夹照原样，同名覆盖）。
// 模型读、改的是这份副本；改动由桌面端按用户选的权限档位写回用户的电脑。服务器这边只管副本：列出、收文件、删除
const LINKED_FILE_LIMIT = UPLOAD_LIMIT; // 单个文件 500MB（超过 4MB 的走分块，每个请求只有一块，不受 Cloudflare 单个请求 100MB 的限制）
const LINKED_MAX_FILES = 6000; // 桌面端一个文件夹最多 5000 个文件，留一点余量给模型新建的
const linkedName = (name) => (typeof name === 'string' ? name.replace(/[\x00-\x1f\[\]「」]/g, ' ').trim().slice(0, 60) : '');
// 相对路径逐段检查：不许空段、. 和 ..、点开头（列文件时会被跳过，传了也看不见）、Windows 不认的字符。rel 留空 = 这个文件夹本身
function linkedRel(id, rel = '') {
  if (!validId(id) || typeof rel !== 'string' || rel.length > 400) return null;
  const parts = rel ? rel.split('/') : [];
  if (parts.length > 12 || parts.some((x) => !x || x.length > 200 || x.startsWith('.') || /[<>:"\\|?*\x00-\x1f]/.test(x) || /[. ]$/.test(x) || x === 'node_modules' || x === '__pycache__')) return null;
  return ['linked', id, ...parts].join('/');
}
// 模型请求访问用户电脑上某个位置时在回答末尾写的标记（见 buildPrompt）。下发给网页时取出来放在 accessRequest 上，正文里去掉
const ACCESS_OPEN = '<<请求访问：', ACCESS_CLOSE = '>>';
function takeAccessRequest(text) {
  let found = '';
  const rest = String(text).replace(/[ \t]*<<请求访问[:：][ \t]*([^<>\r\n]{1,300}?)[ \t]*>>[ \t]*/g, (all, where) => { found = where.trim(); return ''; });
  return found ? { text: rest.replace(/\s+$/, ''), where: found } : null;
}
// 模型要按需文件夹里的文件时写的标记（见 buildPrompt）：同样取出来放在回复的 fileRequests 上
function takeFileRequests(text) {
  const files = [];
  const rest = String(text).replace(/[ \t]*<<需要文件[:：][ \t]*([^<>\r\n]{1,400}?)[ \t]*>>[ \t]*/g, (all, file) => { if (files.length < 20) files.push(file.trim()); return ''; });
  return files.length ? { text: rest.replace(/\s+$/, ''), files } : null;
}
// lazy：按需取文件的文件夹（副本里只有模型要过的文件和一份清单），见 buildPrompt
const linkedOf = (value) => { const name = linkedName(value?.name); return linkedRel(value?.id) && name ? { id: value.id, name, ...(value.lazy === true ? { lazy: true } : {}) } : null; };
// 一个对话、一个项目可以带几个文件夹（最多 6 个）。收的时候单个对象和数组都认，存的时候一律是数组
const LINKED_MAX_FOLDERS = 6;
function linkedList(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : value ? [value] : []) {
    const one = linkedOf(item);
    if (one && !out.some((x) => x.id === one.id) && out.length < LINKED_MAX_FOLDERS) out.push(one);
  }
  return out;
}
// ---------- 关联文件夹的版本历史 ----------
// 副本里每个文件的历次版本另存一份，放在工作文件夹外面（data/users/<账号>/linked-history/<文件夹编号>/），模型碰不到：
//   objects/<sha256>  文件内容，按内容取名，同样的内容只存一份
//   index.json        { files: { 相对路径: [ { v, at, by, sha, size, model?, conv?, from?, deleted? } … ] }, bytes }
// by：user 用户传上来的（含用户自己手动改的）、model 模型改的、restore 从旧版本恢复的。deleted 是一条「删掉了」的记录。
// 用处：用户的电脑坏了、或者想回到几天前的样子，这里都有；恢复 = 把旧内容写回副本，再照常按用户的权限档位写回用户的电脑。
// 上限（config.linkedHistory 可改；设成 false 就不存）：每个文件最多留 200 个版本、3 年，每个文件夹 200GB，一个账号合计 800GB（按一个账号最多分到 1TB 磁盘估的）；
// 超了先清最旧的，每个文件现在的那一版永远留着
const HISTORY_DEFAULTS = { perFile: 200, days: 1095, folderBytes: 200 * 1024 ** 3, totalBytes: 800 * 1024 ** 3 };
const historyLimits = () => (config.linkedHistory === false ? null : { ...HISTORY_DEFAULTS, ...(config.linkedHistory && typeof config.linkedHistory === 'object' ? config.linkedHistory : {}) });
const historyRoot = (u) => path.join(ROOT, 'data', 'users', u.id, 'linked-history');
const historyDir = (u, id) => path.join(historyRoot(u), id);
const historyObject = (u, id, sha) => path.join(historyDir(u, id), 'objects', sha);
function readHistory(u, id) {
  try { const h = JSON.parse(fs.readFileSync(path.join(historyDir(u, id), 'index.json'), 'utf8')); if (h && h.files && typeof h.files === 'object') return h; } catch {}
  return { files: {}, bytes: 0 };
}
// 一个文件夹的历史一次只改一处（用户三个文件一起传时不会互相盖掉记录）
const historyQueues = new Map();
function withHistory(u, id, work) {
  const key = u.id + '|' + id, next = (historyQueues.get(key) || Promise.resolve()).then(work);
  historyQueues.set(key, next.catch(() => {}));
  return next;
}
const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (b) => hash.update(b)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
// 收文件时先落在这里（工作文件夹外面的临时文件），写进副本后交给历史
function historyTemp(u, id) {
  const dir = path.join(historyDir(u, id), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.randomBytes(8).toString('hex'));
}
// 别的文件夹已经占了多少（账号合计的上限要用）
function historyOtherBytes(u, id) {
  let total = 0;
  try { for (const name of fs.readdirSync(historyRoot(u))) if (name !== id && validId(name)) total += readHistory(u, name).bytes || 0; } catch {}
  return total;
}
// 清理：每个文件留最近 perFile 个、days 天以内的；总量超了就从最旧的清起。每个文件最新的一条不动
function pruneHistory(u, id, h, limits = historyLimits() || HISTORY_DEFAULTS) {
  const cutoff = Date.now() - limits.days * 864e5;
  for (const rel of Object.keys(h.files)) {
    const list = h.files[rel];
    h.files[rel] = list.filter((x, i) => i === list.length - 1 || (i >= list.length - limits.perFile && x.at >= cutoff));
    // 一个文件最后只剩一条「删掉了」而且过了期：整条记录不要了
    if (h.files[rel].length === 1 && h.files[rel][0].deleted && h.files[rel][0].at < cutoff) delete h.files[rel];
  }
  const sizes = () => { const seen = new Map(); for (const list of Object.values(h.files)) for (const x of list) if (x.sha) seen.set(x.sha, x.size || 0); return seen; };
  const cap = Math.max(0, Math.min(limits.folderBytes, limits.totalBytes - historyOtherBytes(u, id)));
  let used = [...sizes().values()].reduce((a, b) => a + b, 0);
  if (used > cap) {
    const old = Object.entries(h.files).flatMap(([rel, list]) => list.slice(0, -1).map((x) => ({ rel, x }))).sort((a, b) => a.x.at - b.x.at);
    for (const { rel, x } of old) {
      if (used <= cap) break;
      h.files[rel] = h.files[rel].filter((y) => y !== x);
      used = [...sizes().values()].reduce((a, b) => a + b, 0);
    }
  }
  const keep = sizes();
  h.bytes = [...keep.values()].reduce((a, b) => a + b, 0);
  try { for (const name of fs.readdirSync(path.join(historyDir(u, id), 'objects'))) if (!keep.has(name)) fs.rmSync(historyObject(u, id, name), { force: true }); } catch {}
}
// 记一个版本。file：装着内容的临时文件（记完就归历史了）；或者 sha + size：内容历史里已经有（恢复旧版本时）；或者 deleted。
// 和这个文件最新的一版内容一样就不重复记
function historyAdd(u, id, rel, { file, sha, size, by, model, conv, from, deleted } = {}) {
  const drop = () => { if (file) { try { fs.rmSync(file, { force: true }); } catch {} } };
  if (!historyLimits() || !validId(id)) { drop(); return Promise.resolve(null); }
  return withHistory(u, id, async () => {
    const h = readHistory(u, id), list = h.files[rel] || [], last = list[list.length - 1];
    const entry = { v: (last?.v || 0) + 1, at: Date.now(), by, ...(model ? { model } : {}), ...(conv ? { conv } : {}), ...(from ? { from } : {}) };
    if (deleted) { if (!last || last.deleted) return null; entry.deleted = true; }
    else {
      if (file) { sha = await sha256File(file); size = fs.statSync(file).size; }
      if (!/^[a-f0-9]{64}$/.test(sha || '')) { drop(); return null; }
      if (last && !last.deleted && last.sha === sha) { drop(); return null; }
      const object = historyObject(u, id, sha);
      if (file) { fs.mkdirSync(path.dirname(object), { recursive: true }); if (fs.existsSync(object)) drop(); else fs.renameSync(file, object); }
      else if (!fs.existsSync(object)) return null;
      entry.sha = sha; entry.size = size;
    }
    h.files[rel] = [...list, entry];
    pruneHistory(u, id, h);
    fs.mkdirSync(historyDir(u, id), { recursive: true });
    writeFileSafe(path.join(historyDir(u, id), 'index.json'), JSON.stringify(h));
    return entry;
  }).catch((e) => { drop(); console.log(' 记版本历史失败：' + e.message); return null; });
}
// 一轮回复之后：模型改过、删过的副本文件各记一版（在后台做，不拖住回复）
async function historyAfterTurn(u, conv, msg, changedPaths, removedPaths) {
  if (!historyLimits()) return;
  const split = (p) => { const m = /^linked\/([a-f0-9]{16})\/(.+)$/.exec(p); return m && linkedRel(m[1], m[2]) === p ? { id: m[1], rel: m[2] } : null; };
  for (const p of changedPaths.slice(0, 300)) {
    const at = split(p); if (!at) continue;
    const temp = historyTemp(u, at.id);
    try {
      if (config.isolation?.enabled) await isolation.io.readToFile(isolation.context(u), p, temp, { limitBytes: LINKED_FILE_LIMIT });
      else fs.copyFileSync(path.join(u.workDir, p), temp);
      await historyAdd(u, at.id, at.rel, { file: temp, by: 'model', model: msg.model, conv: conv.id });
    } catch { try { fs.rmSync(temp, { force: true }); } catch {} }
  }
  for (const p of removedPaths.slice(0, 300)) { const at = split(p); if (at) await historyAdd(u, at.id, at.rel, { deleted: true, by: 'model', model: msg.model, conv: conv.id }); }
}
// 过了保留期限一直没动过的历史整个清掉（用户取消关联之后副本没了，历史照样留到期满）
function cleanHistory() {
  const limits = historyLimits() || HISTORY_DEFAULTS;
  try {
    for (const user of fs.readdirSync(path.join(ROOT, 'data', 'users'))) {
      const root = path.join(ROOT, 'data', 'users', user, 'linked-history');
      let ids; try { ids = fs.readdirSync(root); } catch { continue; }
      for (const id of ids) {
        try { if (validId(id) && Date.now() - fs.statSync(path.join(root, id, 'index.json')).mtimeMs > limits.days * 864e5) fs.rmSync(path.join(root, id), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}
function uniqueTarget(dir, name) {
  let target = path.join(dir, name);
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${stem} (${n})${ext}`);
  return target;
}
// 三天都没传完的（用户不要了）清掉；顺便清掉一个月前的朗读音频和 Office 预览（要用时会重新生成）
function cleanParts() {
  cleanPartReceipts();
  for (const [dir, days] of [[PART_DIR, 3], [TTS_DIR, 30], [PREVIEW_DIR, 30]]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (Date.now() - fs.statSync(full).mtimeMs > days * 864e5) fs.rmSync(full, { force: true });
      }
    } catch {}
  }
}
setInterval(cleanParts, 6 * 3600e3);
setInterval(() => cleanHistory(), 24 * 3600e3);
setInterval(cleanPartReceipts, 15 * 60e3);
const partBusy = new Map(); // 上传 id -> 正在收的那一块（Promise）

// 收一块数据并接到已收到的部分后面；收齐了就挪到对话（或项目）的文件夹里，重名的加编号
async function receivePart(u, id, meta, offset, req, res) {
  const received = fs.statSync(partPath(id)).size;
  if (offset !== received) { req.resume(); return sendJSON(res, 409, { received }); } // 两边对不上：告诉网页从哪接着发
  const chunk = await readBody(req, PART_MAX, true).catch(() => null);
  if (!chunk) return sendJSON(res, 413, { error: '数据块太大' });
  if (received + chunk.length > meta.size) return sendJSON(res, 400, { error: '数据比文件大小多' });
  fs.appendFileSync(partPath(id), chunk);
  const now = received + chunk.length;
  if (now < meta.size) { maintenanceDrain.upload(u.id, id); return sendJSON(res, 200, { received: now }); }
  if (!resolveIn(u, meta.dir)) return sendJSON(res, 403, { error: '上传位置已失效' });
  if (meta.linked) {
    const [, linkId, ...inside] = meta.linked.split('/'); // 'linked/<编号>/<里面的路径>'，落盘前再核对一遍
    if (linkedRel(linkId, inside.join('/')) !== meta.linked || !resolveIn(u, meta.linked)) return sendJSON(res, 403, { error: '上传位置已失效' });
    let mtime = 0;
    if (config.isolation?.enabled) {
      await isolation.io.writeFromStream(isolation.context(u), meta.linked, fs.createReadStream(partPath(id)), { limitBytes: LINKED_FILE_LIMIT, exclusive: false });
      mtime = (await workRows(u, [{ type: 'stat', path: meta.linked }]))[0]?.value?.mtime || 0;
    } else {
      const abs = path.join(u.workDir, meta.linked);
      fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(partPath(id), abs);
      mtime = fs.statSync(abs).mtimeMs;
    }
    { const temp = historyTemp(u, linkId); fs.renameSync(partPath(id), temp); historyAdd(u, linkId, inside.join('/'), { file: temp, by: 'user' }); } // 收齐的这份归版本历史
    const result = { received: now, done: true, linked: true, size: now, mtime };
    writeFileSafe(partReceiptPath(id), JSON.stringify({ user: u.id, completedAt: Date.now(), result }));
    fs.rmSync(partPath(id) + '.json', { force: true });
    maintenanceDrain.completeUpload(u.id, id);
    return sendJSON(res, 200, result);
  }
  let target;
  if (config.isolation?.enabled) {
    const saved = await isolation.io.writeFromStream(isolation.context(u), toRel(u, path.join(meta.dir, meta.name)), fs.createReadStream(partPath(id)),
      { limitBytes: UPLOAD_LIMIT, exclusive: true, uniqueName: true });
    target = path.join(u.workDir, saved.path);
    fs.rmSync(partPath(id), { force: true });
    if (saved.path.startsWith('projects/')) await refreshSnap(u); // 项目资料列表和提示词要跟上
  } else {
    fs.mkdirSync(meta.dir, { recursive: true });
    target = uniqueTarget(meta.dir, meta.name);
    fs.renameSync(partPath(id), target);
  }
  const result = { received: now, done: true, path: toRel(u, target), name: path.basename(target), size: now };
  writeFileSafe(partReceiptPath(id), JSON.stringify({ user: u.id, completedAt: Date.now(), result }));
  fs.rmSync(partPath(id) + '.json', { force: true });
  maintenanceDrain.completeUpload(u.id, id);
  console.log(`[上传] ${u.id}: ${toRel(u, target)} (${(now / 1024).toFixed(1)} KB，分块)`);
  warmPreviews(u, [toRel(u, target)]);
  return sendJSON(res, 200, result);
}
const readJSON = async (req) => JSON.parse((await readBody(req)) || '{}');

// 把网页传来的相对路径限制在该账号的工作文件夹内
function resolveIn(u, rel) {
  if (config.isolation?.enabled) {
    if (typeof rel !== 'string' || rel.includes('\0')) return null;
    const absolute = path.resolve(u.workDir, rel || '.');
    const relative = path.relative(u.workDir, absolute);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || relative.includes(':')) return null;
    // This only normalizes an identifier. Every actual read/write resolves and
    // accesses the path inside the OS policy, including reparse-point checks.
    return absolute;
  }
  return workspacePath(u.workDir, rel || '');
}

const toRel = (u, abs) => path.relative(u.workDir, abs).split(path.sep).join('/');

// 列出账号工作文件夹里的文件（跳过 .venv、.memory 等隐藏目录）。skip：第一层要跳过的文件夹名
function walk(u, dir = u.workDir, out = [], depth = 0, { skip = null, max = 2000 } = {}) {
  if (config.isolation?.enabled) {
    try { out.push(...isolation.io.operationSync(isolation.context(u), { type: 'scan', path: toRel(u, dir), depth: Math.max(0, 8 - depth), max: Math.max(0, max - out.length), skip: skip ? [...skip] : [] }, SYNC_IO)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return out;
  }
  if (depth > 8 || out.length > max) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
    if (depth === 0 && skip && skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(u, full, out, depth + 1, { max });
    else if (e.isFile()) {
      try { const st = fs.statSync(full); out.push({ path: toRel(u, full), size: st.size, mtime: st.mtimeMs }); } catch {}
    }
  }
  return out;
}
// 一轮回复前后用来对比「改了哪些文件」：这个对话（或项目）自己的文件夹，加上工作文件夹里不属于任何对话/项目的部分。
// 以前每轮都把整个工作文件夹扫两遍：扫的时候所有回复的输出都停着，文件超过 2000 个以后新做的文件还会漏掉
const scanTurn = (u, convRel) => config.isolation?.enabled
  ? workBatch(u, [{ type: 'scan', path: convRel, max: 20000 }, { type: 'scan', path: '', max: 20000, skip: ['chats', 'projects'] }]).flat()
  : walk(u, u.workDir, walk(u, path.join(u.workDir, convRel), [], 0, { max: 20000 }), 0, { skip: new Set(['chats', 'projects']), max: 20000 });

const scanTurnAsync = async (u, convRel) => (config.isolation?.enabled
  ? (await workAsync(u, [{ type: 'scan', path: convRel, max: 20000 }, { type: 'scan', path: '', max: 20000, skip: ['chats', 'projects'] }])).flat()
  : scanTurn(u, convRel));

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.mov': 'video/quicktime', '.srt': 'text/plain', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.py': 'text/plain', '.log': 'text/plain', '.xml': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.zip': 'application/zip',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// 前端用到的第三方库，全部从本机提供，不依赖外网 CDN
const NM = path.join(ROOT, 'node_modules');
const VENDOR = {
  'sha256-0.11.1.js': path.join(PUBLIC_DIR, 'vendor', 'sha256-0.11.1.js'),
  'scoped-links.js': path.join(PUBLIC_DIR, 'scoped-links.js'),
  'marked.js': path.join(NM, 'marked', 'lib', 'marked.umd.js'),
  'purify.js': path.join(NM, 'dompurify', 'dist', 'purify.min.js'),
  'highlight.js': path.join(NM, '@highlightjs', 'cdn-assets', 'highlight.min.js'),
  'hl-light.css': path.join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github.min.css'),
  'hl-dark.css': path.join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'),
  'katex.js': path.join(NM, 'katex', 'dist', 'katex.min.js'),
  'katex.css': path.join(NM, 'katex', 'dist', 'katex.min.css'),
  'mammoth.js': path.join(NM, 'mammoth', 'mammoth.browser.min.js'),
};
const KATEX_FONTS = path.join(NM, 'katex', 'dist', 'fonts');

function pipeWorkFile(res, abs) {
  const input = fs.createReadStream(abs);
  const release = () => { if (config.isolation?.enabled) isolation.releaseSnapshot?.(abs); };
  input.once('close', release);
  input.once('error', (error) => { if (!res.destroyed) res.destroy(error); });
  res.once('close', () => input.destroy());
  if (res.destroyed) input.destroy(); else input.pipe(res);
  return res;
}
function serveWorkFile(res, abs, { raw, download, filename }) {
  const ext = path.extname(filename || abs).toLowerCase();
  const type = raw ? 'text/plain' : (MIME[ext] || 'application/octet-stream');
  const headers = {
    'Content-Type': type + (/^text\/|json|javascript|svg/.test(type) ? '; charset=utf-8' : ''),
    'Content-Length': fs.statSync(abs).size,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename || path.basename(abs))}`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  // 网页/SVG 放进沙箱运行：可以跑脚本，但拿不到登录 cookie、也碰不到主页面
  if (!raw && INLINE_EXTS.has(ext)) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-pointer-lock allow-downloads';
  res.writeHead(200, headers);
  pipeWorkFile(res, abs);
}

// ---------- 手机安装 ----------
// 对外的网址：开了公网隧道就用固定域名，否则用用户访问时的地址
const publicOrigin = (req) => (config.tunnel && config.tunnel.enabled && config.tunnel.hostname
  ? 'https://' + config.tunnel.hostname
  : (isHttps(req) ? 'https://' : 'http://') + (req.headers.host || 'localhost:' + config.port));

// iPhone 描述文件：一个全屏打开的「网页快捷方式」(Web Clip)，安装后主屏幕出现 Claude 图标
function webClipProfile(origin) {
  const uuid = (tag) => { const h = sign('webclip:' + tag); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase(); };
  const icon = fs.readFileSync(path.join(PUBLIC_DIR, 'icons', 'apple-touch-icon.png')).toString('base64');
  const host = origin.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '');
  const id = host.split('.').reverse().join('.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>FullScreen</key><true/>
      <key>Icon</key><data>${icon}</data>
      <key>IsRemovable</key><true/>
      <key>Label</key><string>Claude</string>
      <key>Precomposed</key><true/>
      <key>URL</key><string>${origin}/?source=app</string>
      <key>PayloadDisplayName</key><string>Claude 桌面图标</string>
      <key>PayloadIdentifier</key><string>${id}.webclip</string>
      <key>PayloadType</key><string>com.apple.webClip.managed</string>
      <key>PayloadUUID</key><string>${uuid('clip')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>在主屏幕上添加 Claude 图标，点开就是全屏的 App。只包含这一个快捷方式，随时可以在「设置 - 通用 - VPN与设备管理」里删除。</string>
  <key>PayloadDisplayName</key><string>Claude</string>
  <key>PayloadIdentifier</key><string>${id}.profile</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid('profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

// ---------- 对话内互动内容的签名链接 ----------
// 沙箱里的网页请求同目录的 css/js/图片时不带登录 cookie，所以给「这个文件夹」签一个 7 天有效的链接，
// 形如 /f/<token>/outputs/小网站/index.html，相对路径都能正常加载，且只能访问这个文件夹。
const INLINE_EXTS = new Set(['.html', '.htm', '.svg']);
// 签名里同时记下账号和文件夹，只能访问这个账号的这个文件夹。
// 放在工作区根目录的网页，「它的文件夹」就是整个账号（记忆、所有对话的文件）：这种只签这一个文件，同目录资源不放行
function signedUrl(u, rel) {
  const parent = path.posix.dirname(rel);
  const dir = parent === '.' || parent === '' ? rel : parent;
  const payload = Buffer.from(u.id + '\n' + dir).toString('base64url') + '.' + (Date.now() + 7 * 864e5);
  const token = payload + '.' + sign('f:' + payload).slice(0, 24);
  return '/f/' + token + '/' + rel.split('/').map(encodeURIComponent).join('/');
}
// 校验签名链接，通过时返回对应账号
function checkSigned(token, rel) {
  const [b64, exp, sig] = token.split('.');
  if (!b64 || !exp || !sig || +exp < Date.now() || !safeEqual(sig, sign('f:' + b64 + '.' + exp).slice(0, 24))) return null;
  const [uid, dir] = Buffer.from(b64, 'base64url').toString().split('\n');
  const u = USERS.get(uid);
  // 以前签出的「整个账号」链接（dir 为 . 或空）一律作废
  if (!u || !dir || dir === '.') return null;
  return rel === dir || rel.startsWith(dir + '/') ? u : null;
}
// 给消息里的网页文件加上签名链接（返回副本，不写进存档）
// 模型的回答里偶尔带着这台电脑上的绝对路径（Gemini 爱把文件写成 file:///D:/…/工作文件夹/… 的链接）：用户在另一台设备上
// 点不开，还把机主电脑上工作文件夹的位置露了出去。发给网页前换成相对工作文件夹的路径——网页认得相对路径，点了能预览。
// 存档里的原文不改；只认这个账号自己的工作文件夹，正反斜杠、网址里的转义写法都认
const replyPathPatterns = new Map();
// 工作文件夹在这台电脑上有几种写法：账号配置里的路径，以及隔离层给模型用的那个「视图」目录
// （C:\\Users\\…\\ClaudeRelayIsolation\\w\\<编号>\\view，是指向工作文件夹的联接；GPT 报路径时爱用它）。都换掉
function replyRoots(u) {
  const roots = [u.workDir];
  if (config.isolation?.enabled) { try { const ctx = isolation.context(u); roots.push(ctx?.executionRoot, ctx?.workspaceRoot); } catch {} }
  return [...new Set(roots.filter((x) => typeof x === 'string' && x).map((x) => path.resolve(x)))].sort((x, y) => y.length - x.length);
}
function relativeReplyPaths(u, text) {
  if (typeof text !== 'string' || text.length < 4 || !u?.workDir) return text;
  let pattern = replyPathPatterns.get(u.id || u.workDir);
  if (!pattern) {
    const quote = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = (root) => root.split(/[\\/]+/).filter(Boolean).map((x) => { const enc = encodeURIComponent(x); return enc === x ? quote(x) : '(?:' + quote(x) + '|' + quote(enc) + ')'; }).join('[\\\\/]+');
    pattern = new RegExp('(?:file:/{2,3})?(?:' + replyRoots(u).map(body).join('|') + ')(?![\\w.-])([\\\\/]+[^\\s"\'<>|)\\]]*)?', 'gi');
    replyPathPatterns.set(u.id || u.workDir, pattern);
  }
  return text.replace(pattern, (all, rest) => { const rel = (rest || '').replace(/\\/g, '/').replace(/^\/+/, ''); return rel || '工作文件夹'; });
}
// mode：这个对话是聊天还是工作（只给一条回复时由调用方给；不给就按对话推断）。下发的副本上带着它，网页据此锁定顶栏的切换。
// 聊天的对话里回答末尾的请求标记照样从正文里去掉，但不当成请求（不放 accessRequest / fileRequests），网页也就不会去开放或取文件
function withFileUrls(u, conv, mode = conversationMode(u, conv)) {
  const c = JSON.parse(JSON.stringify(conv)), work = mode === 'work';
  c.mode = mode;
  for (const m of c.messages) {
    if (m.role !== 'assistant') continue;
    for (const ev of m.events || []) if ((ev.k === 'text' || ev.k === 'thinking') && typeof ev.text === 'string') ev.text = relativeReplyPaths(u, ev.text);
    if (m.status !== 'running') for (const ev of m.events || []) { // 回答完了才取：模型请求访问用户电脑上的某个位置
      const asked = ev.k === 'text' && typeof ev.text === 'string' ? takeAccessRequest(ev.text) : null;
      if (asked) { ev.text = asked.text; if (work) m.accessRequest = asked.where; }
      const wanted = ev.k === 'text' && typeof ev.text === 'string' ? takeFileRequests(ev.text) : null;
      if (wanted) { ev.text = wanted.text; if (work) m.fileRequests = [...(m.fileRequests || []), ...wanted.files].slice(0, 20); }
    }
    if (typeof m.result === 'string') m.result = relativeReplyPaths(u, m.result);
  }
  // 旧对话里存的原始错误文字不迁移，下发时一样去掉路径和密钥
  for (const m of c.messages) { if (typeof m.errorText === 'string') m.errorText = pageErrorText(m.errorText); for (const f of m.files || []) if (INLINE_EXTS.has(path.extname(f.path).toLowerCase())) f.url = signedUrl(u, f.path); }
  return c;
}

// ---------- 对话存储（每个账号一个文件夹）----------
const convPath = (u, id) => path.join(u.convDir, id + '.json');
const validId = (id) => /^[a-f0-9]{16}$/.test(id || '');

function loadConv(u, id) {
  if (!validId(id)) return null;
  const job = jobs.get(jobKey(u, id));
  if (job) return job.user === u ? job.conv : null;
  if (!fs.existsSync(convPath(u, id))) return null;
  try { return JSON.parse(fs.readFileSync(convPath(u, id), 'utf8')); }
  catch (e) { console.log(`[存档损坏] ${u.id} 的对话 ${id} 读不出来：${e.message}`); return null; }
}
// 对话列表（标题、时间、收藏、所属项目）常驻内存：第一次用时把文件读一遍，之后随保存/删除更新。
// 以前每次取列表都把所有对话文件整个读一遍，历史越多越慢，读的时候整个服务（包括正在输出的回复）都会卡住
const convIndex = new Map(); // 账号 id -> Map(对话 id -> 列表项)
// ---------- 聊天 / 工作 ----------
// 对话分两种（conv.mode）：'chat' 只聊天，碰不到用户电脑上的文件；'work' 可以读、改用户电脑上关联的文件夹（见上面「关联文件夹」）。
// 新建对话时定下来（请求里的 mode；没带就看这条消息带没带文件夹、所在项目是不是建在文件夹上），之后不再变：后面消息里带的 mode 一律不理。
// 聊天的对话由服务器把住，不靠网页自觉：消息上不存 linked / canTrust，提示里不提文件夹、不让模型请求访问，回答里的请求标记去掉、不下发。
// 在服务器工作区里做文件给用户下载（outputs）不算碰用户电脑上的文件，两种都照常
const CONV_MODES = new Set(['chat', 'work']);
const validMode = (mode) => (CONV_MODES.has(mode) ? mode : null);
const projectHasFolders = (u, pid) => !!u && !!pid && linkedList(loadProject(u, pid)?.linked).length > 0;
// 老对话（有 mode 之前建的）没有这个属性：用户在里面关联过文件夹，或者它在建在文件夹上的项目里 → 工作，否则聊天。
// 不批量改写存档；用户下次在里面发消息时顺手存上（见 /api/chat），之后项目的文件夹再怎么变也不会跟着变。
// hasFolders：项目建没建在文件夹上（一次读很多对话时由调用方传一个带缓存的）
function conversationMode(u, conv, hasFolders = (pid) => projectHasFolders(u, pid)) {
  const own = validMode(conv?.mode);
  if (own) return own;
  if ((conv?.messages || []).some((m) => m?.role === 'user' && linkedList(m.linked).length)) return 'work';
  return conv?.projectId && hasFolders(conv.projectId) ? 'work' : 'chat';
}
// sortAt：用户在侧边栏里拖过这个对话时记下的「排序时间」，列表按它（没拖过就按最后活动时间）从新到旧排；
// 这个对话再发消息时清掉，又回到按活动时间排。mode：聊天还是工作，网页据此显示顶栏的切换并锁定
const convMeta = (c, u, hasFolders) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, starred: !!c.starred, projectId: c.projectId || null, mode: conversationMode(u, c, hasFolders), ...conversationSelection(c), ...(c.sortAt ? { sortAt: c.sortAt } : {}) });
const sortKey = (c) => c.sortAt || c.updatedAt;
function indexOf(u) {
  let idx = convIndex.get(u.id);
  if (!idx) {
    idx = new Map();
    const folders = new Map(), hasFolders = (pid) => { if (!folders.has(pid)) folders.set(pid, projectHasFolders(u, pid)); return folders.get(pid); }; // 同一个项目只读一次
    for (const f of fs.readdirSync(u.convDir)) {
      if (!f.endsWith('.json')) continue;
      try { const c = JSON.parse(fs.readFileSync(path.join(u.convDir, f), 'utf8')); idx.set(c.id, convMeta(c, u, hasFolders)); } catch {}
    }
    convIndex.set(u.id, idx);
  }
  return idx;
}
// touch=false：只改了标题、收藏、所属项目、排序这类属性，不算一次活动，不把它顶到列表最上面
function saveConv(u, conv, touch = true) {
  if (touch) conv.updatedAt = Date.now();
  writeFileSafe(convPath(u, conv.id), JSON.stringify(conv));
  indexOf(u).set(conv.id, convMeta(conv, u));
}
// 授权按对话分开之后，一份副本只属于一个对话（或一个项目）：对话、项目删了，它名下的副本一起删。
// 版本历史不在这里删（那是备份，到期自己清）；用户电脑上的文件更不会动
function removeLinkedCopies(u, ids) {
  const targets = [...new Set(ids)].map((id) => linkedRel(id)).filter(Boolean);
  if (!targets.length) return;
  if (config.isolation?.enabled) workRows(u, targets.map((target) => ({ type: 'remove', path: target, recursive: true, force: true }))).catch(() => {});
  else for (const target of targets) { try { fs.rmSync(path.join(u.workDir, target), { recursive: true, force: true }); } catch {} }
}
function removeConv(u, id) {
  let copies = [];
  try { const conv = loadConv(u, id); if (conv && !conv.projectId) copies = conv.messages.flatMap((m) => linkedList(m.linked).map((x) => x.id)); } catch {} // 项目里的对话用的是项目的副本，归项目
  if (copies.length) removeLinkedCopies(u, copies);
  fs.rmSync(convPath(u, id), { force: true });
  if (config.isolation?.enabled) workRows(u, [{ type: 'remove', path: toRel(u, path.join(u.chatsDir, id + '.md')), force: true }]).catch(() => {});
  else fs.rmSync(path.join(u.chatsDir, id + '.md'), { force: true });
  indexOf(u).delete(id);
}
const listConvs = (u) => [...indexOf(u).values()].sort((a, b) => sortKey(b) - sortKey(a));
// ---------- 对话全文搜索 ----------
// 只搜对话本身：标题、用户发的消息、回复的正文（思考过程和工具输出不算）。按列表顺序逐个读，
// 读满 maxFiles 个或超过 budgetMs 就停，告诉网页「只是部分结果」；读坏的文件跳过。读取方式由调用方注入。
async function searchConversations(metas, query, { read, budgetMs = 300, maxFiles = 2000, limit = 30 } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q || q.length > 100) return { error: '搜索词长度要在 1 到 100 字之间' };
  const needle = q.toLowerCase(), began = performance.now(), results = [];
  const flat = (s) => String(s || '').replace(/\s+/g, ' ');
  const snippet = (text, at) => { const from = Math.max(0, at - 30), to = Math.min(text.length, at + q.length + 30); return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : ''); };
  let scanned = 0, partial = false;
  for (const meta of metas) {
    if (results.length >= limit) { partial = true; break; }
    if (String(meta.title || '').toLowerCase().includes(needle)) { results.push({ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, projectId: meta.projectId || null, where: 'title', snippet: '' }); continue; }
    if (scanned >= maxFiles || performance.now() - began > budgetMs) { partial = true; break; }
    scanned++;
    let conv; try { conv = await read(meta.id); } catch { continue; }
    for (const m of conv?.messages || []) {
      const text = flat(m.role === 'user' ? m.text : (m.events || []).filter((e) => e.k === 'text').map((e) => e.text).join(' ') || m.result);
      const at = text.toLowerCase().indexOf(needle);
      if (at >= 0) { results.push({ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, projectId: meta.projectId || null, where: 'message', snippet: snippet(text, at) }); break; }
    }
  }
  return { results, partial };
}
// ---------- 对话全文搜索结束 ----------
// 正在回复的对话用内存里的最新内容，其余直接读存档（服务自己的数据，不在工作区里）
async function readSearchConv(u, id) {
  if (!validId(id)) return null;
  const job = jobs.get(jobKey(u, id));
  if (job) return job.user === u ? job.conv : null;
  return JSON.parse(await fs.promises.readFile(convPath(u, id), 'utf8'));
}
const searching = new Set(); // 每个账号同一时间只跑一个搜索
// 服务退出（重启、电脑关机）时正在进行的回复，存档里还标着「回复中」，网页会一直转圈。启动时把它们改成中断，
// 会话停在上一轮（回复没完成不会前进），用户点「重新回答」就能接着来。不改 updatedAt，列表顺序不变
function markInterrupted(u) {
  for (const { id } of indexOf(u).values()) {
    const conv = loadConv(u, id);
    if (!conv) continue;
    let n = 0;
    for (const m of conv.messages) {
      if (m.role !== 'assistant' || m.status !== 'running') continue;
      for (const ev of m.events || []) { delete ev.building; delete ev.live; }
      Object.assign(m, { status: 'error', errorText: '电脑或服务重启了，这条回复没做完。点「重新回答」可以再来一次。', finishedAt: Date.now() });
      n++;
    }
    if (n) { writeFileSafe(convPath(u, id), JSON.stringify(conv)); console.log(` 对话 ${conv.id} 里有 ${n} 条回复因为重启中断了`); }
  }
}
const runningIds = (u) => [...jobs.values()].filter((j) => j.user === u).map((j) => j.conv.id);

// ---------- 跨对话记忆（每个账号自己的）----------
// <工作文件夹>/.memory/memory.md：Claude 记住的关于这个人的事，每次对话开始时带上；Claude 自己用编辑工具更新它。
// <工作文件夹>/.memory/chats/<id>.md：每个对话的文字版，Claude 需要回忆以前聊过什么时可以搜索。
const loadPrefs = (u) => { try { return JSON.parse(fs.readFileSync(u.prefsFile, 'utf8')); } catch { return {}; } };
const savePrefs = (u, p) => writeFileSafe(u.prefsFile, JSON.stringify(p, null, 2));
const memoryEnabled = (u) => loadPrefs(u).memory !== false;
// 选的模型和思考深度跟着账号走（网页、桌面端、手机 App 一致）。config.defaultsVersion 变了说明机主调整过默认值，旧选择作废
const savedChoice = (u) => {
  const c = loadPrefs(u).choice;
  if (!c || c.dv !== (config.defaultsVersion || 1)) return null;
  return modelsFor(u).some((m) => m.id === c.model) && effortOk(c.model, c.effort) ? { model: c.model, effort: c.effort } : null;
};
const readMemory = (u) => { const snap = snapOf(u); if (snap) return snap.memory; try { return config.isolation?.enabled ? workText(u, u.memoryFile) : fs.readFileSync(u.memoryFile, 'utf8'); } catch { return ''; } };
// 记忆或开关变了，预热好的进程里的提示词就过期了
const memoryVersion = (u) => snapOf(u) ? `${memoryEnabled(u)}:${snapOf(u).memoryMtime}` : config.isolation?.enabled
  ? `${memoryEnabled(u)}:${isolation.io.batchSync(isolation.context(u), [{ type: 'stat', path: '.memory/memory.md' }], SYNC_IO)[0]?.value?.mtime || 0}`
  : `${memoryEnabled(u)}:${fs.existsSync(u.memoryFile) ? fs.statSync(u.memoryFile).mtimeMs : 0}`;

// pid：这个对话所在的项目（没有就是普通对话）。总记忆和项目记忆分开记：项目的细节进项目记忆，
// 总记忆里每个项目只留一行现状，这样不在项目里的对话也知道用户手上有哪些事、各到哪一步了
function memoryPrompt(u, pid) {
  if (!memoryEnabled(u)) return '';
  const inProject = validPid(pid) ? loadProject(u, pid) : null;
  const p = u.profile === 'owner' ? { them: 'him', their: 'his', they: 'he' } : { them: 'the user', their: 'the user\'s', they: 'the user' };
  const mem = readMemory(u).trim();
  const recent = listConvs(u).slice(0, 15)
    .map((c) => `- ${new Date(c.updatedAt).toLocaleDateString('zh-CN')} ${c.title}`).join('\n');
  let projects = ''; try { projects = listProjects(u).slice(0, 12).map((x) => `- ${x.name}${x.description ? `（${String(x.description).slice(0, 60)}）` : ''}${inProject && x.id === inProject.id ? ' <- this conversation' : ''}`).join('\n'); } catch {}
  return [
    '\n\n# Memory',
    `You have a persistent memory about ${p.them} in ./.memory/memory.md. When ${p.they} shares something worth remembering long-term`,
    `(${p.their} name, studies or work, ongoing projects and deadlines, preferences about how you answer, people and things ${p.they} often mentions),`,
    'or asks you to remember or forget something, update that file with your edit tools: concise Chinese bullet points grouped under a few',
    'headings, at most about 80 lines, merging and pruning old items. Never store passwords, ID numbers or other sensitive data.',
    'Do not talk about the file itself; just say naturally that you will remember (or have forgotten). Use memories naturally when relevant',
    `and never recite the list unprompted. Transcripts of ${p.their} earlier conversations are in ./.memory/chats (one Markdown file per chat);`,
    `when ${p.they} refers to something from before ("上次", "之前说的"), search them with Grep/Read instead of guessing.`,
    `Each of ${p.their} projects has its own separate memory. Personal memory holds what is true across everything ${p.they} does, plus one line per project under a heading "项目": the project's name and one sentence on where it stands.`,
    inProject ? `This conversation is inside the project "${inProject.name}": details of the project go into its project memory (see the project section below), never here. Touch this project's line under "项目" only when its overall state changes.`
      : 'This conversation is not inside a project: do not edit any project memory from here.',
    mem ? `\n## What you currently remember about ${p.them}\n${mem}` : '\n(Memory is empty so far.)',
    projects ? `\n## ${p.their[0].toUpperCase() + p.their.slice(1)} projects (each keeps its own project memory)\n${projects}` : '',
    recent ? `\n## ${p.their[0].toUpperCase() + p.their.slice(1)} recent conversations\n${recent}` : '',
  ].join('\n');
}

// 把对话写成 Markdown，方便 Claude 以后搜索
function chatTranscriptText(u, conv) {
  const who = u.profile === 'owner' ? '机主说' : '用户说';
  const lines = [`# ${conv.title}`, `日期：${new Date(conv.createdAt || Date.now()).toLocaleString('zh-CN')}`, ''];
  for (const m of conv.messages) {
    if (m.role === 'user') lines.push(`## ${who}\n${m.text}${(m.attachments || []).length ? `\n（附件：${m.attachments.map((a) => a.path).join('、')}）` : ''}\n`);
    else {
      const text = (m.events || []).filter((e) => e.k === 'text').map((e) => e.text).join('\n\n') || m.result || '';
      if (text) lines.push(`## ${providerOf(m.model) === 'anthropic' ? 'Claude' : modelName(m.model)}\n${text}${(m.files || []).length ? `\n（文件：${m.files.map((f) => f.path).join('、')}）` : ''}\n`);
    }
  }
  return lines.join('\n');
}
function writeChatTranscript(u, conv) {
  if (!memoryEnabled(u)) return;
  const text = chatTranscriptText(u, conv);
  if (config.isolation?.enabled) return workAsync(u, [{ type: 'writeText', path: toRel(u, path.join(u.chatsDir, conv.id + '.md')), text, parents: true }]);
  else fs.writeFileSync(path.join(u.chatsDir, conv.id + '.md'), text, 'utf8');
}

let transcriptBackfillStopped = false;
async function backfillIsolatedTranscripts() {
  const summary = { checked: 0, written: 0, raced: 0 };
  for (const u of USERS.values()) {
    if (transcriptBackfillStopped) break;
    if (!memoryEnabled(u)) continue;
    try {
      const conversations = listConvs(u);
      if (!conversations.length) continue;
      const ctx = isolation.context(u);
      for (let start = 0; start < conversations.length && !transcriptBackfillStopped; start += 256) {
        const group = conversations.slice(start, start + 256);
        const rows = await isolation.io.batch(ctx, group.map(c => ({ type: 'stat', path: toRel(u, path.join(u.chatsDir, c.id + '.md')) })));
        if (transcriptBackfillStopped) break;
        summary.checked += group.length;
        const failures = rows.filter(row => !row.ok && row.error?.code !== 'ENOENT');
        if (failures.length) throw Error('检查文字记录失败：' + failures.map(row => row.error?.code || 'WORKSPACE_IO_ERROR').join(', '));
        let pending = [], bytes = 0;
        const flush = async () => {
          if (!pending.length || transcriptBackfillStopped) return;
          const results = await isolation.io.batch(ctx, pending);
          pending = []; bytes = 0;
          summary.written += results.filter(row => row.ok).length;
          summary.raced += results.filter(row => !row.ok && row.error?.code === 'EEXIST').length;
          const failures = results.filter(row => !row.ok && row.error?.code !== 'EEXIST');
          if (failures.length) throw Error('写入文字记录失败：' + failures.map(row => row.error?.code || 'WORKSPACE_IO_ERROR').join(', '));
        };
        for (let i = 0; i < group.length && !transcriptBackfillStopped; i++) {
          if (rows[i].ok) continue;
          const conv = loadConv(u, group[i].id);
          if (!conv) continue;
          const text = chatTranscriptText(u, conv), size = Buffer.byteLength(text, 'utf8');
          if (pending.length && (pending.length >= 32 || bytes + size > 1024 * 1024)) await flush();
          if (transcriptBackfillStopped) break;
          pending.push({ type: 'writeText', path: toRel(u, path.join(u.chatsDir, conv.id + '.md')), text, parents: true, exclusive: true });
          bytes += size;
        }
        await flush();
      }
    } catch (error) {
      if (!transcriptBackfillStopped) console.log(' [' + u.id + '] 补齐文字记录失败：' + error.message);
    }
  }
  return summary;
}

// ---------- 项目 ----------
// 每个项目一个文件夹 <工作文件夹>/projects/<id>/：
//   files/            用户放进来的项目资料，项目里的每个对话都能用
//   uploads/          项目里各个对话上传的附件（项目内共享）
//   outputs/          这个项目做出来的文件（项目内共享）
//   .project/project.json  名称、简介、项目说明（长期生效的要求）
//   .project/memory.md     项目记忆：Claude 记下的决定、进展、资料要点
// 项目内对话的文字版和普通对话一样放在账号记忆 .memory/chats 里
const validPid = (id) => /^[a-f0-9]{8}$/.test(id || '');
const projDir = (u, id) => path.join(u.workDir, 'projects', id);
const projMeta = (u, id) => path.join(projDir(u, id), '.project');
const projMemoryFile = (u, id) => path.join(projMeta(u, id), 'memory.md');
const projFilesDir = (u, id) => path.join(projDir(u, id), 'files');

function loadProject(u, id) {
  if (!validPid(id)) return null;
  const snap = snapOf(u);
  if (snap) { const entry = snap.projects.get(id); return entry ? JSON.parse(JSON.stringify(entry.p)) : null; } // 调用方可能改它，给一份副本
  if (config.isolation?.enabled) { try { return isolation.io.operationSync(isolation.context(u), { type: 'readJson', path: `projects/${id}/.project/project.json`, maxBytes: 1024 * 1024 }, SYNC_IO); } catch { return null; } }
  try { return JSON.parse(fs.readFileSync(path.join(projMeta(u, id), 'project.json'), 'utf8')); } catch { return null; }
}
function saveProject(u, p) {
  p.updatedAt = Date.now();
  if (config.isolation?.enabled) {
    const entry = accountSnaps.get(u.id)?.projects.get(p.id);
    if (entry) entry.p = JSON.parse(JSON.stringify(p)); // 马上生效，磁盘内容等下面的后台刷新
    return workAsync(u, [{ type: 'writeJson', path: `projects/${p.id}/.project/project.json`, value: p, parents: true, pretty: true }]).then(() => refreshSnap(u));
  }
  writeFileSafe(path.join(projMeta(u, p.id), 'project.json'), JSON.stringify(p, null, 2));
}
async function createProject(u, { name, description, linked }) {
  const p = { id: crypto.randomBytes(4).toString('hex'), name, description: description || '', instructions: '', createdAt: Date.now() };
  if (linkedList(linked).length) p.linked = linkedList(linked); // 建在用户电脑上的文件夹上：项目里的每个对话都带着它们
  if (config.isolation?.enabled) {
    await workAsync(u, ['files', 'uploads', 'outputs', '.project'].map(d => ({ type: 'mkdir', path: `projects/${p.id}/${d}` })).concat(
      [{ type: 'writeText', path: `projects/${p.id}/.project/memory.md`, text: '', exclusive: true }]));
    await saveProject(u, p); return p;
  }
  for (const d of [projFilesDir(u, p.id), path.join(projDir(u, p.id), 'uploads'), path.join(projDir(u, p.id), 'outputs'), projMeta(u, p.id)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(projMemoryFile(u, p.id), '', 'utf8');
  saveProject(u, p);
  return p;
}
const readProjMemory = (u, id) => { const snap = snapOf(u); if (snap) return snap.projects.get(id)?.memory || ''; try { return config.isolation?.enabled ? workText(u, projMemoryFile(u, id)) : fs.readFileSync(projMemoryFile(u, id), 'utf8'); } catch { return ''; } };
const projectFiles = (u, id) => (snapOf(u) ? snapOf(u).projects.get(id)?.files || [] : walk(u, projFilesDir(u, id)).sort((a, b) => b.mtime - a.mtime));
function listProjects(u) {
  const snap = snapOf(u);
  if (snap) {
    const convs = listConvs(u);
    return [...snap.projects].map(([id, { p, files }]) => {
      const mine = convs.filter((c) => c.projectId === id);
      return { id, name: p.name, description: p.description, linked: linkedList(p.linked), convCount: mine.length, fileCount: files.length, updatedAt: Math.max(p.updatedAt || 0, ...mine.map((c) => c.updatedAt)) };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  if (config.isolation?.enabled) {
    const ctx = isolation.context(u); let ids;
    try { ids = isolation.io.operationSync(ctx, { type: 'list', path: 'projects' }, SYNC_IO).filter(e => e.isDirectory && !e.isSymbolicLink && validPid(e.name)).map(e => e.name); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const convs = listConvs(u), result = [];
    for (let start = 0; start < ids.length; start += 128) {
      const group = ids.slice(start, start + 128);
      const rows = isolation.io.batchSync(ctx, group.flatMap(id => [{ type: 'readJson', path: `projects/${id}/.project/project.json`, maxBytes: 1024 * 1024 }, { type: 'scan', path: `projects/${id}/files` }]), SYNC_IO);
      group.forEach((id, i) => { const p = rows[i * 2]?.value; if (!rows[i * 2]?.ok || !p) return;
        const mine = convs.filter(c => c.projectId === id);
        result.push({ id, name: p.name, description: p.description, linked: linkedList(p.linked), convCount: mine.length, fileCount: rows[i * 2 + 1]?.value?.length || 0,
          updatedAt: Math.max(p.updatedAt || 0, ...mine.map(c => c.updatedAt)) }); });
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  let ids = [];
  try { ids = fs.readdirSync(path.join(u.workDir, 'projects')).filter(validPid); } catch {}
  const convs = listConvs(u);
  return ids.map((id) => loadProject(u, id)).filter(Boolean).map((p) => {
    const mine = convs.filter((c) => c.projectId === p.id);
    return { id: p.id, name: p.name, description: p.description, linked: linkedList(p.linked), convCount: mine.length, fileCount: projectFiles(u, p.id).length,
      updatedAt: Math.max(p.updatedAt || 0, ...mine.map((c) => c.updatedAt)) };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

// 项目资料里的小文本文件直接放进提示词（像 claude.ai 那样），大的或二进制文件只列出来，需要时 Claude 自己读
const INLINE_TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.tex', '.bib']);
const INLINE_BUDGET = 30000;

// inline=false：小文本资料不放全文（GPT 的说明走命令行参数，有长度上限），只列出来让它需要时自己读
function projectPrompt(u, id, inline = true) {
  const cached = snapOf(u)?.projects.get(id);
  const snapshot = cached ? [{ value: cached.p }, { value: cached.memory }, { value: { files: [...cached.files], texts: inline ? cached.texts : [] } }]
    : config.isolation?.enabled && validPid(id) ? isolation.io.batchSync(isolation.context(u), [
    { type: 'readJson', path: `projects/${id}/.project/project.json`, maxBytes: 1024 * 1024 },
    { type: 'readText', path: `projects/${id}/.project/memory.md`, maxBytes: 1024 * 1024 },
    { type: 'snapshot', path: `projects/${id}/files`, textExtensions: [...INLINE_TEXT_EXTS], textBudget: inline ? INLINE_BUDGET : 0 },
  ], SYNC_IO) : null;
  const p = snapshot ? snapshot[0]?.value : loadProject(u, id);
  if (!p) return '';
  const rel = `./projects/${id}`;
  const who = u.profile === 'owner' ? 'his' : 'the user\'s', personal = memoryEnabled(u);
  const mem = (snapshot ? snapshot[1]?.value || '' : readProjMemory(u, id)).trim();
  const files = snapshot ? (snapshot[2]?.value?.files || []).sort((a, b) => b.mtime - a.mtime) : projectFiles(u, id);
  let budget = inline ? INLINE_BUDGET : 0;
  const inlined = [];
  for (const f of files) {
    if (!INLINE_TEXT_EXTS.has(path.extname(f.path).toLowerCase()) || f.size > budget) continue;
    try {
      const text = snapshot ? snapshot[2]?.value?.texts?.find(t => t.path === f.path)?.text : fs.readFileSync(path.join(u.workDir, f.path), 'utf8');
      if (typeof text !== 'string') continue;
      if (text.length > budget) continue;
      budget -= text.length;
      inlined.push(`<file path="${f.path}">\n${text}\n</file>`);
    } catch {}
  }
  const convs = listConvs(u).filter((c) => c.projectId === id).slice(0, 20)
    .map((c) => `- ${new Date(c.updatedAt).toLocaleDateString('zh-CN')} ${c.title} (./.memory/chats/${c.id}.md)`).join('\n');
  return [
    `\n\n# Project: ${p.name}`,
    `This conversation belongs to ${who} project "${p.name}"${p.description ? ` (${p.description})` : ''}. Its folder is ${rel}.`,
    `This folder is shared by every conversation in the project: reference files are in ${rel}/files, attachments from any of its conversations in ${rel}/uploads,`,
    `and deliverables go in ${rel}/outputs, so files made in earlier project conversations are available here too.`,
    personal ? 'Your personal memory about the user (above) still applies; the project memory below adds detail specific to this project.' : '',
    p.instructions.trim() ? `\n## Project instructions (always follow these)\n${p.instructions.trim()}` : '',
    '\n## Project memory',
    `${rel}/.project/memory.md is this project's own memory: carried into every conversation in the project and used nowhere else.`,
    personal ? 'Personal memory (./.memory/memory.md, above) is about the user and is shared by all conversations. In this project you use both memories and maintain both, each for its own purpose.'
      : 'Personal memory is turned off for this account: do not read or write ./.memory/memory.md; keep everything durable about the project here.',
    'Maintain memory deliberately, as the last step of a turn: once you have finished what the user asked, check whether the turn produced anything durable. If not, change nothing. Otherwise sort each item:',
    '- about this project (goal and scope, structure, decisions, progress, conclusions drawn from the reference files, open questions, next steps): project memory;',
    personal ? '- about the user beyond this project (preferences, background, people, deadlines that matter elsewhere): personal memory;' : '',
    personal ? '- a change in the overall state of the project (started, a milestone reached, direction changed, finished): project memory in detail, plus this project\'s one line under "项目" in personal memory.' : '',
    'Read the file before you write to it. Merge with what is there: replace outdated items instead of appending, drop finished or superseded ones' + (personal ? ', and never keep the same detail in both memories.' : '.'),
    'Write project memory as concise bullet points in the user\'s language under the headings 目标与范围 / 已定的事 / 进展 / 待办与未决 / 资料要点 (leave out empty ones), at most about 60 lines. Do not mention the memory files themselves.',
    mem ? `Current project memory:\n${mem}` : '(Project memory is empty so far.)',
    files.length ? `\n## Reference files (${files.length})\n${files.slice(0, 150).map((f) => `- ${f.path} (${(f.size / 1024).toFixed(0)} KB)`).join('\n')}` : '\n(No reference files yet.)',
    files.length ? 'Read the relevant ones when a request needs them (use the skills for PDF/Word/PowerPoint/Excel); do not read everything up front.' : '',
    inlined.length ? `\nSmall text files, included in full:\n${inlined.join('\n')}` : '',
    convs ? `\n## Earlier conversations in this project\n${convs}\nRead those transcripts when earlier work in this project is referred to.` : '',
  ].join('\n');
}
// 一轮回复前后各看一眼两份记忆：哪份变了（account 总记忆、project 这个项目的记忆）。只比内容，空白的增减不算
function memoryChanges(before, after) {
  const changed = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim() !== b.trim();
  return [...(changed(before?.account, after?.account) ? ['account'] : []), ...(changed(before?.project, after?.project) ? ['project'] : [])];
}
// 这一轮在一份记忆里加了、删了哪几条（按行比，顺序和空白不算）：给用户看的，各最多 12 条
function memoryDelta(before, after) {
  const lines = (t) => String(t || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const a = lines(before), b = lines(after), had = new Set(a), has = new Set(b);
  const added = b.filter((x) => !had.has(x)), removed = a.filter((x) => !has.has(x)), clip = (list) => list.slice(0, 12).map((x) => x.slice(0, 200));
  return { added: clip(added), removed: clip(removed), more: Math.max(0, added.length - 12) + Math.max(0, removed.length - 12) };
}
// 同一个账号同时有别的对话在回复时，内容变了不一定是这一轮改的：这时要在这一轮自己的操作记录里看到它碰过那个文件才算
function memoryTouchedBy(events, kind) {
  const trace = JSON.stringify(events || []).replace(/\\\\/g, '/').replace(/\/+/g, '/');
  return trace.includes(kind === 'account' ? '.memory/memory.md' : '.project/memory.md');
}
const memoryState = (u, pid) => ({ account: readMemory(u), project: validPid(pid) && loadProject(u, pid) ? readProjMemory(u, pid) : null });
// 提示词依赖的内容（个人记忆、项目说明/记忆/资料）变了，预热好的进程就过期了
function promptVersion(u, pid) {
  const snap = snapOf(u);
  if (snap) return `${memoryEnabled(u)}:${snap.memoryMtime}|${validPid(pid) ? snap.projects.get(pid)?.version || '' : ''}`;
  if (config.isolation?.enabled) {
    const paths = ['.memory/memory.md', ...(validPid(pid) ? [`projects/${pid}/.project/project.json`, `projects/${pid}/.project/memory.md`, `projects/${pid}/files`] : [])];
    return `${memoryEnabled(u)}:` + isolation.io.batchSync(isolation.context(u), paths.map(path => ({ type: 'stat', path })), SYNC_IO).map(r => r.ok ? r.value.mtime : 0).join(':');
  }
  const mt = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return memoryVersion(u) + (validPid(pid) ? `|${mt(path.join(projMeta(u, pid), 'project.json'))}:${mt(projMemoryFile(u, pid))}:${mt(projFilesDir(u, pid))}` : '');
}

// ---------- SSE 广播 ----------
// 每个网页连接记下是哪个账号；对话相关的消息只发给这个账号自己的网页，额度这类共用信息发给所有人
const clients = new Map(); // res -> user
function broadcast(obj, u) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const [res, owner] of clients) if (!u || owner === u) res.write(data);
}
// 心跳：网页靠它判断连接是不是还活着（注释行网页的脚本看不见，所以发一个具名事件；旧网页不监听它，不受影响）
setInterval(() => { for (const res of clients.keys()) res.write('event: ping\ndata: 1\n\n'); }, 20000);

// ---------- 执行 Claude ----------
const jobs = new Map(); // [userId, convId] -> { child, conv, msg, user, stopped }
const jobKey = (u, id) => JSON.stringify([u.id, id]);

// ---------- 保持清醒 ----------
// 电脑被定时唤醒后，Windows 约 2 分钟没人碰就会自己睡回去。有回复在进行、或最近有人用过网页时，
// 用一个后台小进程向系统声明「需要保持运行」（不点亮屏幕）；空闲够久就撤掉，交给巡检脚本决定要不要睡。
// 用户手动按睡眠永远优先，不受影响。
let lastActivity = Date.now();
let awakeProc = null;
// 有人按过「叫醒」：保持清醒直到下一次睡眠。标记本身睡眠后仍留在内存里，巡检脚本用 stayAwakeSince 和系统最近一次
// 醒来的时间比较来判断它对这次醒来是否有效；巡检决定睡回去前调用 /local/sleeping 清掉它
let stayAwake = false, stayAwakeSince = 0; // since：什么时候被叫的
const idleMs = () => Date.now() - lastActivity;
function updateKeepAwake() {
  if (process.platform !== 'win32') return;
  // wake.alwaysAwake：不管有没有人叫都一直开着（目前关闭，机主选的是「被叫醒后保持清醒，直到下一次睡眠」）
  const want = !!(config.wake && config.wake.alwaysAwake) || stayAwake || maintenanceDrain.status(jobs.size).running > 0 || idleMs() < ((config.wake && config.wake.idleMinutes) || 30) * 60e3;
  if (want && !awakeProc) {
    awakeProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint s);'; " +
      '[W.P]::SetThreadExecutionState([uint32]2147483649) | Out-Null; while ($true) { Start-Sleep -Seconds 3600 }'], { windowsHide: true, stdio: 'ignore' });
    awakeProc.on('exit', () => { awakeProc = null; });
  } else if (!want && awakeProc) {
    execFile('taskkill', ['/pid', String(awakeProc.pid), '/T', '/F'], () => {});
    awakeProc = null;
  }
}
setInterval(updateKeepAwake, 60e3);
setTimeout(updateKeepAwake, 3000);
// ---------- 额度（用量）----------
// 两个来源：每次回复时 Claude 返回的 rate_limit_event（实时、精确），以及 `claude -p "/usage"`（不调用模型、不花钱，
// 用来在用户没聊天时刷新）。只把百分比和重置时间给网页；/usage 里关于这台电脑使用习惯的统计不外传。
const USAGE_FILE = path.join(ROOT, 'data', 'usage.json');
let usage = (() => { try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return { windows: {}, updatedAt: 0 }; } })();
let usageFetching = null;

function saveUsage(source) {
  usage.updatedAt = Date.now();
  usage.source = source;
  try { writeFileSafe(USAGE_FILE, JSON.stringify(usage)); } catch {}
  broadcast({ type: 'usage', usage });
}

// 把「Oct 23, 3:19am (America/Los_Angeles)」这种某时区的墙上时间换成时间戳
function zonedToEpoch(text) {
  const m = String(text).match(/(?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return null;
  const [, mon, day, hh, mm, ap, tz] = m;
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const partsIn = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, +p.value]));
  let now;
  try { now = partsIn(Date.now()); } catch { return null; }
  let h = +hh % 12 + (ap.toLowerCase() === 'pm' ? 12 : 0);
  const month = mon ? months.indexOf(mon) : now.month - 1, d = day ? +day : now.day;
  const wallUtc = (y) => Date.UTC(y, month, d, h, +(mm || 0));
  const toEpoch = (y) => { // 迭代修正时区偏移（含夏令时）
    let t = wallUtc(y);
    for (let i = 0; i < 2; i++) { const p = partsIn(t); t += wallUtc(y) - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); }
    return t;
  };
  let t = toEpoch(now.year);
  if (t < Date.now() - 36 * 3600e3) t = toEpoch(now.year + 1); // 跨年
  return t;
}

// 解析 /usage 的输出：「Current session: 45% used · resets …」「Current week (all models): 24% used · resets …」等
function parseUsageText(text) {
  const windows = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*Current (session|week)(?: \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?/i);
    if (!m) continue;
    const scope = (m[2] || '').toLowerCase();
    const key = m[1].toLowerCase() === 'session' ? 'session' : (!scope || scope === 'all models' ? 'week' : 'week_' + scope.replace(/\W+/g, '_'));
    windows[key] = { pct: Math.round(+m[3]), resetsAt: m[4] ? zonedToEpoch(m[4]) : null, label: scope && scope !== 'all models' ? m[2] : '' };
  }
  return windows;
}

function fetchUsage({ probe = false } = {}) {
  if (usageFetching) { if (probe) usageWantProbe = true; return usageFetching; }
  if (isolationBlocked || maintenanceDrain.blocked()) return Promise.resolve(usage);
  usageWantProbe = probe;
  usageFetching = maintenanceDrain.background(() => new Promise((resolve) => {
    const child = config.isolation?.enabled ? isolation.spawnText({ model: config.titleModel, usage: true })
      : spawn(config.claudePath, ['-p', '--strict-mcp-config', '--setting-sources', 'project,local'], { cwd: os.tmpdir(), windowsHide: true, env: TOOL_ENV });
    let out = '';
    const timer = setTimeout(() => child.kill(), 60e3);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => {});
    child.on('close', async () => {
      clearTimeout(timer);
      const windows = parseUsageText(out);
      if (Object.keys(windows).length) { usage.windows = { ...usage.windows, ...windows }; saveUsage('usage-command'); }
      else if (usageWantProbe && !maintenanceDrain.blocked()) await probeUsage().catch(() => {}); // 重启屏障期间不启动新进程
      usageWantProbe = false;
      resolve(usage);
    });
    child.stdin.end('/usage\n', 'utf8');
  })).finally(() => { usageFetching = null; });
  return usageFetching;
}
// 2.1.316 起，非交互的 /usage 不再给百分比，真实额度只在回复的 rate_limit_event 里。手动刷新和长时间没更新时，
// 发一条最小的 Haiku 请求拿这个事件。它会用一点点额度，所以自动的最多 30 分钟一次，且最近有人在用才发
const USAGE_PROBE_EVERY = 30 * 60e3;
let usageProbeAt = 0, usageWantProbe = false;
const usageProbeDue = () => Date.now() - (usage.updatedAt || 0) >= USAGE_PROBE_EVERY && Date.now() - usageProbeAt >= USAGE_PROBE_EVERY && idleMs() < USAGE_PROBE_EVERY;
function probeUsage() {
  usageProbeAt = Date.now();
  return new Promise((resolve) => {
    const child = spawnQuick();
    const timer = setTimeout(() => killQuick(child), 60e3);
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: '只回答：好' } }) + '\n', 'utf8');
    child.result.then(() => { clearTimeout(timer); resolve(); });
  });
}

// 回复过程中收到的 rate_limit_event：five_hour = 当前时段，seven_day = 本周
function onRateLimitEvent(info) {
  const w = info && info.unifiedWindows;
  if (!w) return;
  let seen = false;
  for (const [src, key] of [['five_hour', 'session'], ['seven_day', 'week']]) {
    if (!w[src] || typeof w[src].utilization !== 'number') continue;
    const pct = Math.round(w[src].utilization * 100), resetsAt = w[src].resetsAt ? w[src].resetsAt * 1000 : null;
    usage.windows[key] = { ...(usage.windows[key] || {}), pct, resetsAt };
    seen = true;
  }
  // 数字没变也算刚核对过，「更新于」要跟着变
  if (seen) saveUsage('reply');
}

// 有网页开着时，每 10 分钟刷新一次（不花钱）
setInterval(() => { if (clients.size) fetchUsage({ probe: usageProbeDue() }).catch(() => {}); }, 10 * 60e3);

function summarizeTool(name, input = {}, u) {
  name = String(name).replace(/^mcp__relay__/, '').replace(/^relay:/, '');
  const rel = (p) => (p ? (u ? toRel(u, path.resolve(u.workDir, p)) : String(p)) : '');
  switch (name) {
    case 'Bash': case 'PowerShell': return input.description || input.command || '';
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return rel(input.file_path || input.notebook_path);
    case 'Glob': case 'Grep': return input.pattern || '';
    case 'WebSearch': return input.query || '';
    case 'WebFetch': return input.url || '';
    case 'TodoWrite': return (input.todos || []).map((t) => (t.status === 'completed' ? '✓ ' : '· ') + t.content).join('\n');
    case 'Task': case 'Agent': return input.description || '';
    case 'Skill': return input.skill || '';
    default: { const s = JSON.stringify(input); return s.length > 200 ? s.slice(0, 200) + '…' : s; }
  }
}

function resultPreview(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') : '';
  return text.length > 1500 ? text.slice(0, 1500) + '…' : text;
}

// 输入框上的「工具」：选了某个工具，就在这条消息后面告诉 Claude 用哪个技能、交付什么
const GUEST_TOOLS = [
  { id: 'ppt', label: '做 PPT', emoji: '📊', hint: '想做一份什么主题的 PPT？',
    prompt: 'Use the pptx skill to build a polished, well-designed PowerPoint deck (.pptx) for this request and save it in the outputs folder.' },
  { id: 'word', label: '写 Word', emoji: '📄', hint: '要写一份什么文档？',
    prompt: 'Use the docx skill to produce a properly formatted Word document (.docx) for this request (headings, paragraphs, tables where useful) and save it in the outputs folder.' },
  { id: 'excel', label: '表格图表', emoji: '📈', hint: '要整理什么数据，或者画什么图？',
    prompt: 'Use the xlsx skill for spreadsheets (.xlsx) and the data-visualization skill for charts (PNG); deliver the files in the outputs folder.' },
  { id: 'papers', label: '查文献', emoji: '📚', hint: '想找哪方面的文献？',
    prompt: 'Search real academic literature with the consensus and reference-lookup tools. List real papers with authors, year, venue and links, verify every reference, and never invent citations.' },
  { id: 'image', label: '生成图片', emoji: '🎨', hint: '想要一张什么样的图？',
    prompt: 'Use the media-maker skill to create the image(s) described and save them in the outputs folder.' },
  { id: 'transcribe', label: '转文字', emoji: '🎙️', hint: '附上录音、视频或扫描件，说说要怎么整理',
    prompt: 'Use the ocr-and-transcribe skill to turn the attached audio, video, images or scanned PDFs into text, tidy it as asked, and save the text as a file in the outputs folder.' },
  { id: 'notes', label: '读书笔记', emoji: '📝', hint: '附上文章或说出书名，想重点关注什么？',
    prompt: 'Use the research-litnote skill to write structured reading notes (main argument, key points with page references, quotes worth keeping, questions); save them as a Word document in the outputs folder.' },
];
// 机主（事件相机单分子定位超分辨显微研究）
const OWNER_TOOLS = [
  { id: 'paper', label: '读论文', emoji: '📄', hint: '附上 PDF 或给出论文，想重点看什么？',
    prompt: 'Use the research-litnote skill to write a rigorous literature note on the attached or named paper: problem, method (with the key equations), data, results with numbers and figure/page references, assumptions, limitations, and how it relates to event-based SMLM. Save it as Markdown in the outputs folder.' },
  { id: 'papers', label: '查文献', emoji: '📚', hint: '想找哪方面的文献？',
    prompt: 'Search real literature (consensus and reference-lookup tools, including arXiv). Return a ranked list of real papers with authors, year, venue, DOI/arXiv link and one line on relevance, verify every entry, and also save the entries as a BibTeX file in the outputs folder. Never invent citations.' },
  { id: 'smlm', label: '定位分析', emoji: '🔬', hint: '附上或指明定位结果 CSV，要分析什么？',
    prompt: 'Use the smlm-analysis skill (its smlm_tools.py with the gpu312 Python) for this localization data. Report every number with the parameters used, and save figures and tables in the outputs folder.' },
  { id: 'events', label: '事件数据', emoji: '⚡', hint: '附上或指明事件文件 / RAW，要做什么？',
    prompt: 'Use the event-camera-data skill for this event-camera / EVE task. Work on the attached files (never outside this folder); write results to the outputs folder.' },
  { id: 'figure', label: '科研绘图', emoji: '📈', hint: '要画什么图？数据在哪？',
    prompt: 'Make publication-quality figures with matplotlib in the gpu312 environment: consistent fonts, labelled axes with units, colour-blind-safe palettes, scale bars on microscopy images, no chart junk. Save PNG at 300 dpi plus a vector PDF in the outputs folder, and keep the plotting script next to them.' },
  { id: 'latex', label: '写 LaTeX', emoji: '✍️', hint: '要写哪一部分？期刊或模板有要求吗？',
    prompt: 'Use the latex-paper skill: write the LaTeX source, compile it with latexmk, fix any errors until it compiles, and deliver the .tex, .bib and PDF in the outputs folder.' },
  { id: 'slides', label: '组会 PPT', emoji: '📊', hint: '这次组会讲什么？有哪些结果和图？',
    prompt: 'Use the pptx skill to build a clean group-meeting deck (.pptx, 16:9): title, motivation, method, results with figures and numbers, issues and next steps. Use real figures from his attachments or the outputs of this conversation where available, and save it in the outputs folder.' },
  { id: 'code', label: '代码审查', emoji: '🧑‍💻', hint: '要看哪段代码或哪个仓库？关注什么？',
    prompt: 'Review the specified code for correctness first (numerical errors, unit and coordinate mistakes, off-by-one, dtype/overflow, sorting and time-base assumptions, silent failures), then performance and clarity. Cite file:line, explain each issue with a concrete failing case, and propose minimal fixes. Never edit the original files; put proposed patches or corrected copies in the outputs folder.' },
];
const toolsFor = (u) => (u.profile === 'owner' ? OWNER_TOOLS : GUEST_TOOLS);
const toolById = (u, id) => toolsFor(u).find((t) => t.id === id);

// 对话的文件夹：项目内的对话共用项目文件夹，其余每个对话一个
const readyFolders = new Set(); // 隔离下建过的对话文件夹（`账号|路径`），不用每轮再建一遍
const convFolderRel = (u, conv) => (conv.projectId && loadProject(u, conv.projectId) ? `projects/${conv.projectId}` : `chats/${conv.id}`);
// 发消息前先异步建好文件夹，后面 convFolder 就不用同步建了
async function ensureConvFolder(u, conv) {
  if (!config.isolation?.enabled) return;
  const rel = convFolderRel(u, conv), key = u.id + '|' + rel;
  if (readyFolders.has(key)) return;
  await workAsync(u, ['uploads', 'outputs'].map((d) => ({ type: 'mkdir', path: `${rel}/${d}` })));
  readyFolders.add(key);
}
function convFolder(u, conv) {
  const rel = convFolderRel(u, conv);
  if (config.isolation?.enabled) {
    const key = u.id + '|' + rel;
    if (!readyFolders.has(key)) { workBatch(u, ['uploads', 'outputs'].map(d => ({ type: 'mkdir', path: `${rel}/${d}` }))); readyFolders.add(key); }
    return rel;
  }
  for (const d of ['uploads', 'outputs']) fs.mkdirSync(path.join(u.workDir, rel, d), { recursive: true });
  return rel;
}

// 网页把浏览器所在的时区随消息带来（Intl 认得才用）。模型自己不知道现在几点：Claude Code 给的日期是这台电脑的
// （太平洋时间），和用户那边可能差一天。带上之后「今天」「明天」「这周五前」才算得对
function userTimeZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(value)) return null;
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }); return value; } catch { return null; }
}
function nowNote(tz) {
  if (!userTimeZone(tz)) return '';
  const when = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return '\n\n[现在是 ' + when + '（用户所在时区 ' + tz + '）]';
}
function buildPrompt(u, conv, text, attachments, tool, tz, linked, canTrust) {
  const dir = convFolder(u, conv);
  let out = text;
  const t = toolById(u, tool);
  if (t) out += `\n\n[工具：${t.label}] ${t.prompt}`;
  if (attachments && attachments.length) out += '\n\n[附上的文件：' + attachments.map((a) => a.path).join('、') + ']';
  const shared = dir.startsWith('projects/') ? '，这是项目共用的文件夹，资料在 files' : '';
  // 聊天的对话碰不到用户电脑上的文件：不提文件夹（项目建在文件夹上也不提）、不让请求访问。消息上本来也不会存这些（见 /api/chat），这里再把一道关
  const work = conversationMode(u, conv) === 'work';
  let folders = work ? linkedList(linked) : [];
  if (work && !folders.length && conv.projectId) folders = linkedList(loadProject(u, conv.projectId)?.linked);
  const where = folders.length === 1 ? `文件夹「${folders[0].name}」已经关联到这个对话，它的副本在 ./linked/${folders[0].id}`
    : `${folders.length} 个文件夹已经关联到这个对话，副本分别在：` + folders.map((x) => `「${x.name}」→ ./linked/${x.id}`).join('；');
  const linkedNote = !folders.length ? '' : `\n\n[用户电脑上的${where}（子文件夹照原样）。要读、要改、要新建文件，直接在${folders.length === 1 ? '这份副本' : '对应的副本'}里做，不要另存到 outputs（除非用户要一份单独的）。你的改动会按用户设的权限写回用户的电脑，可能要先经用户同意，所以回答里说清楚改了哪些文件、各改了什么；不需要的文件不要动，也不要删` +
    (folders.some((x) => x.lazy) ? `。${folders.filter((x) => x.lazy).map((x) => `「${x.name}」`).join('、')}是按需取文件的：副本里只有已经取来的文件，其余的列在该目录下的「_还没取来的文件清单.md」里。要读或改清单里的文件，在回答的最后单独写一行 <<需要文件：linked/编号/相对路径>>（路径照清单里写的，可以连写几行），然后停下，取来后再继续；只是往里新建文件不用取` : '') + ']';
  // 用户在电脑上的 Claude 里（canTrust）：模型需要用到用户电脑上还没关联的位置时，可以提出来，由用户点头后关联
  const trustNote = !work || canTrust !== true ? '' : `\n\n[用户正在用电脑上的 Claude。如果这件事要读或写用户自己电脑上的某个位置（桌面、文档、下载、图片，或一个完整路径），而它不在上面已关联的文件夹里：不要说做不到，也不要让用户自己去下载再拖过去。在回答的最后单独写一行 ${ACCESS_OPEN}桌面${ACCESS_CLOSE}（把「桌面」换成 文档 / 下载 / 图片，或那个完整路径），前面用一句话说明要用它做什么，然后就此停下。用户同意后，那个位置会作为关联文件夹出现在下一条消息里，到时再接着做。一次只请求一个位置]`;
  return out + `\n\n[本对话的文件夹：./${dir}（附件在 uploads${shared}；做好的文件存到 ./${dir}/outputs）]` + linkedNote + trustNote + nowNote(tz);
}

// 「继续」从哪个会话接着：最后一条回复被停止/出错时，它自己 fork 出来的会话里有已经做完的部分（读过的文件、
// 跑过的命令、写了一半的回答）。Claude Code 把会话记录写在 ~/.claude/projects/<工作文件夹路径换成 - 号>/<id>.jsonl，
// 回复刚开始就被打断时这个文件可能还没写出来，那就退回上一轮完成的会话
const sessionFile = (u, sid) => {
  const legacy = path.join(os.homedir(), '.claude', 'projects', u.workDir.replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
  if (!config.isolation?.enabled) return legacy;
  const current = isolation.claudeSessionFile(u, sid);
  return fs.existsSync(current) ? current : legacy;
};
// model：这次用哪个模型继续。被打断的那条是同一家的模型答的，就从它自己的会话接着；换了另一家，就从那一家
// 上一轮完成的会话接着，被打断的部分由 结构化交接 补给它
function resumeSession(u, conv, model) {
  const last = conv.messages[conv.messages.length - 1];
  if (!last || last.role !== 'assistant' || (last.status !== 'stopped' && last.status !== 'error')) return null;
  const sameProvider = providerOf(last.model) === providerOf(model);
  if (providerOf(model) === 'google') {
    const sid = geminiResumeId(u, conv);
    return { sid, resumesInterrupted: !!(sameProvider && sid && last.geminiConvId === sid) };
  }
  if (providerOf(model) === 'openai') {
    const resumesInterrupted = !!(sameProvider && last.threadId);
    return { sid: resumesInterrupted ? last.threadId : conv.codexThreadId || null, resumesInterrupted };
  }
  const resumesInterrupted = !!(sameProvider && last.sessionId && fs.existsSync(sessionFile(u, last.sessionId)));
  return { sid: resumesInterrupted ? last.sessionId : conv.sessionId || null, resumesInterrupted };
}
// Gemini（agy）不能 fork 会话，一个 agy 对话只能顺着往下接。所以记下它接到了哪一条回复（conv.geminiTurnId）：
// 对话里最后一条 Gemini 的回复还是那一条（中间没被编辑、重试替换掉），才接着这个 agy 对话；否则开新对话，
// 前面的内容全部由结构化交接补给它
function geminiResumeId(u, conv) {
  const id = conv?.geminiConvId;
  if (!id || !config.isolation?.enabled) return null;
  // 正在回复的这一条（startJob 已经放进对话）不算
  const last = conv.messages.findLast((m) => m.role === 'assistant' && m.status !== 'running' && providerOf(m.model) === 'google');
  if (!last || !last.turnId || last.turnId !== conv.geminiTurnId) return null;
  try { return isolation.geminiConversationExists(u, id) ? id : null; } catch { return null; }
}
const CONTINUE_PROMPT = '继续。（上一轮回复被中断了：先看看已经做完了哪些、文件是否已经写好，再从中断的地方接着把这件事做完，不要从头重来。）';

// ---------- GPT（OpenAI Codex 命令行）----------
// 选了 GPT 模型的回复不启动 Claude Code，而是在同一个工作文件夹里启动 `codex exec`：它也能读写文件、跑命令（Python、
// LibreOffice 等），所以 PPT/Word/PDF 照样能做。Codex 用自己的配置目录 data/codex-home（和机主平时用的 ~/.codex 分开，
// 里面是 API 密钥登录和 config.toml：Windows 非提权沙箱、只能写工作文件夹、不弹确认）。每一轮像 Claude 一样从上一轮
// fork 出新会话，编辑/重试可以从任意一轮重来。一个对话里可以交替用 Claude 和 GPT：各自只记得自己答过的那几轮，
// 另一个模型答的部分在发消息时补给它（结构化交接）
const CODEX_HOME = path.join(ROOT, 'data', 'codex-home');
const gptModel = (id) => (config.gptModels || []).find((m) => m.id === id);
const gptAllowed = (u) => !!config.openaiApiKey && (config.gptUsers || []).includes(u.id);
// Gemini：经 Antigravity 命令行（agy），只在隔离模式下提供（agy 自带的终端、浏览器等工具要靠隔离层的插件和闸门拦住）
const geminiModel = (id) => (config.geminiModels || []).find((m) => m.id === id);
const geminiAllowed = (u) => !!config.isolation?.enabled && path.isAbsolute(config.agyPath || '') && (config.geminiUsers || []).includes(u.id);
const modelsFor = (u) => [...config.models, ...(gptAllowed(u) ? (config.gptModels || []).map((m) => ({ ...m, provider: 'openai' })) : []), ...(geminiAllowed(u) ? (config.geminiModels || []).map((m) => ({ ...m, provider: 'google' })) : [])];
// 接力仅提供当前账号可用的显式型号；未配置时使用约定默认值。
function fallbackModelsFor(u) {
  const configured = config.fallbackModels || {}, available = modelsFor(u);
  const choose = (provider, fallback) => {
    const id = Object.hasOwn(configured, provider) ? configured[provider] : fallback;
    return available.some(m => m.id === id && (m.provider || 'anthropic') === provider) ? id : null;
  };
  // Gemini 没在配置里指定时用列表里的第一个 Gemini 型号（用 Google 账号，不按量计费，Claude 额度用完时最顺手的接手人选）
  return { anthropic: choose('anthropic', 'sonnet'), openai: choose('openai', 'gpt-6.1-terra'),
    google: choose('google', available.find(m => m.provider === 'google')?.id) };
}
// 这个模型能不能用这一档；不能时换成能用的（ultra → max，其余不认识的 → 默认）
const effortOk = (model, e) => geminiModel(model) ? (geminiModel(model).efforts || []).includes(e)
  : EFFORTS.includes(e) || (!!gptModel(model) && (gptModel(model).efforts || EFFORTS).includes(e));
// Gemini 的档位少（没有 max，有的型号也没有 xhigh）：选了没有的档位就往下找最近的一档
function pickEffort(model, e) {
  if (effortOk(model, e)) return e;
  const gm = geminiModel(model);
  if (gm) {
    const order = [...EFFORTS, 'ultra'], have = gm.efforts || [], at = order.indexOf(e);
    const lower = at < 0 ? [] : order.slice(0, at + 1).reverse().filter((x) => have.includes(x));
    return lower[0] || (have.includes(config.defaultEffort) ? config.defaultEffort : have[0] || 'medium');
  }
  return e === 'ultra' ? 'max' : config.defaultEffort;
}
function conversationSelection(conv) {
  if (conv?.model) return { model: conv.model, effort: conv.effort };
  const last = conv?.messages?.findLast(m => m.role === 'assistant' && m.model);
  return last ? { model: last.model, effort: last.effort } : null;
}
// 版本记录显式选择的先后；旧存档没有这个字段时视为第一版之前。
const conversationChoiceRevision = conv => Number.isSafeInteger(conv?.choiceRevision) && conv.choiceRevision >= 0 ? conv.choiceRevision : 0;
function setConversationSelection(conv, choice) {
  conv.model = choice.model; conv.effort = choice.effort;
  conv.choiceRevision = conversationChoiceRevision(conv) + 1;
}
function defaultChoiceFor(u) {
  const saved = savedChoice(u), available = modelsFor(u);
  const model = saved?.model || (available.some(m => m.id === config.defaultModel) ? config.defaultModel : available[0]?.id);
  return { model, effort: pickEffort(model, saved?.effort || config.defaultEffort) };
}
function requestModelChoice(u, conv, body) {
  let requested;
  if (Object.hasOwn(body, 'model')) requested = { model: body.model, effort: body.effort };
  else {
    const original = conv && (Number.isInteger(body.fromIndex) ? conv.messages[body.fromIndex + 1] : body.continue ? conv.messages.at(-1) : null);
    requested = original?.role === 'assistant' ? { model: original.model, effort: original.effort } : conversationSelection(conv) || defaultChoiceFor(u);
    if (Object.hasOwn(body, 'effort')) requested = { ...requested, effort: body.effort };
  }
  if (!modelsFor(u).some(m => m.id === requested.model)) return { unavailable: true, choice: defaultChoiceFor(u) };
  return { choice: { model: requested.model, effort: pickEffort(requested.model, requested.effort) } };
}
function unavailableModel(res, choice) {
  return sendJSON(res, 409, { code: 'MODEL_UNAVAILABLE', error: '原来的模型现已不可用，请确认可用模型后再发送。', choice });
}
const providerOf = (model) => (gptModel(model) ? 'openai' : geminiModel(model) ? 'google' : 'anthropic');
const modelName = (model) => { const m = gptModel(model) || geminiModel(model) || config.models.find((x) => x.id === model); return m ? (gptModel(model) || geminiModel(model) ? m.label : 'Claude ' + m.label) : model || ''; };

// Codex 的配置：不弹确认（没人能点）、只能写工作文件夹、Windows 用非提权沙箱（不设这项，沙箱会退成只读，写不了文件）、
// 允许联网（查资料、下载字体等），思考摘要尽量详细
const CODEX_CONFIG = `# 由 server.js 自动生成，改了会被覆盖（见 ensureCodexLogin）
approval_policy = "never"
sandbox_mode = "workspace-write"
model_reasoning_summary = "detailed"

[windows]
sandbox = "unelevated"

[sandbox_workspace_write]
network_access = true
`;
// 密钥写进 Codex 的配置目录（只在密钥变了时重新登录；data/ 不进 git）
function ensureCodexLogin() {
  if (config.isolation?.enabled) return; // The isolation runtime owns the API-only homes.
  if (!config.openaiApiKey) return;
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const cfgFile = path.join(CODEX_HOME, 'config.toml');
  if ((() => { try { return fs.readFileSync(cfgFile, 'utf8'); } catch { return ''; } })() !== CODEX_CONFIG) fs.writeFileSync(cfgFile, CODEX_CONFIG, 'utf8');
  const mark = path.join(CODEX_HOME, '.key-sha256'), hash = crypto.createHash('sha256').update(config.openaiApiKey).digest('hex');
  try { if (fs.readFileSync(mark, 'utf8') === hash && fs.existsSync(path.join(CODEX_HOME, 'auth.json'))) return; } catch {}
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const child = spawn(config.codexPath || 'codex', ['login', '--with-api-key'], { env: { ...process.env, CODEX_HOME }, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', (e) => console.log(' [GPT] 找不到 Codex 命令行：' + e.message));
  child.on('close', (code) => { if (code === 0) { fs.writeFileSync(mark, hash); console.log(' [GPT] Codex 已用 API 密钥登录'); } else console.log(' [GPT] Codex 登录失败，退出码 ' + code); });
  child.stdin.end(config.openaiApiKey);
}

// 技能说明（SKILL.md）：Claude 那边的技能是普通的说明文档加脚本，GPT 也能照着用。找工作文件夹里的项目技能和
// 机主全局的 Office/PDF 技能，把名字、用途和路径列给它
let skillCache = null;
function skillDocs(u) {
  if (config.isolation?.enabled) return []; // Runtime notes advertise the protected skill service.
  if (!skillCache) skillCache = new Map();
  if (skillCache.has(u.id)) return skillCache.get(u.id);
  const found = [];
  const look = (dir, depth, want) => {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'SKILL.md' && (!want || want.test(path.basename(dir)))) found.push(full);
      else if (e.isDirectory() && depth > 0) look(full, depth - 1, want);
    }
  };
  look(path.join(u.workDir, '.claude', 'skills'), 2);
  // 机主全局的 Office/PDF 技能在工作文件夹外面，Codex 的沙箱读不到：复制一份到工作文件夹的隐藏目录 .tools/skills
  // （以点开头，不出现在网页的文件列表里），每次服务启动时更新
  const globalSkills = [];
  look(path.join(os.homedir(), '.claude', 'skills'), 4, /^(pptx|docx|pdf|xlsx)$/);
  for (let i = found.length - 1; i >= 0; i--) {
    if (found[i].startsWith(u.workDir + path.sep)) continue;
    const src = path.dirname(found[i]), dest = path.join(u.workDir, '.tools', 'skills', path.basename(src));
    try { fs.cpSync(src, dest, { recursive: true, force: true }); globalSkills.push(path.join(dest, 'SKILL.md')); } catch {}
    found.splice(i, 1);
  }
  found.push(...globalSkills);
  const seen = new Set();
  const list = found.map((f) => {
    const head = (() => { try { return fs.readFileSync(f, 'utf8').slice(0, 1500); } catch { return ''; } })();
    const name = (head.match(/^name:\s*(.+)$/m) || [, path.basename(path.dirname(f))])[1].trim();
    const desc = (head.match(/^description:\s*(.+)$/m) || [, ''])[1].trim().replace(/^["']|["']$/g, '').slice(0, 160);
    return { name, desc, file: f };
  }).filter((s) => !seen.has(s.name) && seen.add(s.name));
  skillCache.set(u.id, list);
  return list;
}

// Gemini 经 agy 运行时的几个毛病，单独提醒它：把工具管道的名字说给用户听、说完计划就停、开头结尾的客套话
const GEMINI_NOTES = [
  'Notes for Gemini in this environment: never mention call_mcp_tool, server names, tool names or other plumbing to the user; say what you did in everyday words.',
  'Do not announce a plan and then stop: the user cannot reply until your turn ends, so carry the task through to the finished result in this turn.',
  'Skip filler openings and closings (no "好的，我来…", no "希望对你有帮助"); start with the substance.',
  'When you take over from another model in this conversation, read the handoff, check which files already exist, and continue from there in the same voice; do not redo finished work or comment on the earlier model.',
].join(' ');
// 三家都提醒：提到文件用相对路径。真实对话里 Gemini 写过 file:///D:/… 的链接，GPT 写过隔离层视图目录的绝对路径
const REPLY_PATH_NOTE = 'Refer to files by their path relative to the working folder (for example outputs/报告.docx), as plain text or a relative Markdown link; never write absolute paths, drive letters or file:// links, because the user is on another device and cannot open them.';
function modelInstructions(u, pid, provider) {
  const isolated = !!config.isolation?.enabled;
  return buildModelInstructions({
    provider, platform: systemPrompt(u) + ' ' + REPLY_PATH_NOTE + (provider === 'google' ? ' ' + GEMINI_NOTES : ''), claudeTools: claudeToolPrompt(u),
    memory: memoryPrompt(u, pid), project: pid ? projectPrompt(u, pid, provider === 'anthropic') : '',
    runtimeNotes: isolated ? isolation.notes(u) : '', isolated,
    skills: provider === 'openai' ? skillDocs(u) : [],
    // 总长限制：GPT 的说明走命令行，守默认的 24000；Claude 原来不截记忆和项目（项目内联文件上限就有 30000 字），不能因此变差。
    // Gemini 的说明写在文件里（不走命令行），给到 36000：这次加的回答风格和 Gemini 提醒占了一千多字，不能挤掉记忆和项目
    ...(provider === 'anthropic' ? { maxChars: Number.MAX_SAFE_INTEGER } : provider === 'google' ? { maxChars: 36000 } : {}),
  });
}
function codexInstructions(u, pid) { return modelInstructions(u, pid, 'openai'); }

// Gemini 的 agy 对话不能 fork：只要还接着同一个 agy 对话（resumeId，见 geminiResumeId），对话里最后一条 Gemini 回复
// 不管答没答完，agy 自己都记得。而交接是按「这个模型最后一次答完」来算缺哪几轮的，所以那条没答完的回复要先当成
// 答完的，否则它那一轮会再交接一遍：紧挨着的上一条是它，或者中间隔了 Claude、GPT 的回复再回到 Gemini，都一样。
// 要有它确实处理过那一轮的证据：那条回复记着同一个 agy 对话编号，而且里面至少有一条它产生的内容（文字、思考或工具）。
// agy 一报出对话编号就会记下 geminiTurnId，但那时它未必已经把这一轮的消息存进对话；刚开始就被停掉的，照旧交接一遍
// （重复比遗漏安全）。返回只给交接用的对话视图，不改原来的对话
function geminiHandoffView(conv, resumeId) {
  if (!resumeId || !Array.isArray(conv?.messages)) return conv;
  const at = conv.messages.findLastIndex((m) => m?.role === 'assistant' && m.status !== 'running' && providerOf(m.model) === 'google');
  const last = at >= 0 ? conv.messages[at] : null;
  if (!last || last.status === 'done' || !last.turnId || last.turnId !== conv.geminiTurnId || last.geminiConvId !== resumeId
      || !Array.isArray(last.events) || !last.events.length) return conv;
  const messages = conv.messages.slice();
  messages[at] = { ...last, status: 'done' };
  return { ...conv, messages };
}
// 这个模型自己的会话里缺的几轮：从它最后一次答完（或要接着的那条被打断的回复）之后，到这条新消息之前
function handoffFor(u, conv, provider, options = {}) {
  return buildHandoff(conv, provider, {
    // GPT 按 API 用量计费，交接内容守着 24000 字；Claude（订阅）和 Gemini（Google 账号）不按量计费，上下文也大，
    // 给到 60000 字：较早几轮的要求、回答、做过的操作和文件清单能留下更多，接手的模型少猜、少重做
    maxChars: config.handoffMaxChars ?? (provider === 'openai' ? 24000 : 60000),
    nonce: crypto.randomBytes(16).toString('hex'),
    memoryEnabled: memoryEnabled(u), excludeCurrent: true,
    providerOf, modelLabel: modelName,
    toolLabel: id => toolById(u, id)?.label || id,
    ...options,
  });
}

// Codex 的推理强度和网页上的五档一一对应（这几个型号都支持 low/medium/high/xhigh/max，另有更高的 ultra 不开放）
const codexEffort = (e) => (GPT_EFFORTS.includes(e) ? e : 'medium');
// 启动一轮 Codex；接口和 launchClaude 一样（child + attach）
function launchCodex(u, conv, userMsg, threadId) {
  const startedAt = Date.now();
  if (config.isolation?.enabled) return { ...isolation.launchCodex({ u, threadId, model: userMsg.model, effort: codexEffort(userMsg.effort),
    instructions: codexInstructions(u, conv.projectId), attachments: userMsg.attachments || [] }), startedAt };
  const args = ['exec', '--json', '--skip-git-repo-check', '-m', userMsg.model, '-c', `model_reasoning_effort="${codexEffort(userMsg.effort)}"`,
    '-c', 'developer_instructions=' + JSON.stringify(codexInstructions(u, conv.projectId)), '-C', u.workDir];
  for (const a of userMsg.attachments || []) if (/\.(png|jpe?g|gif|webp)$/i.test(a.path)) { const abs = resolveIn(u, a.path); if (abs) args.push('-i', abs); }
  if (threadId) args.push('fork', threadId);
  args.push('-');
  const child = spawn(config.codexPath || 'codex', args, { cwd: u.workDir, windowsHide: true, env: { ...TOOL_ENV, CODEX_HOME } });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.on('error', () => {});
  return { child, startedAt, attach(out, err) { child.stdout.on('data', out); child.stderr.on('data', err); } };
}
// ---------- Gemini（Google Antigravity 命令行 agy）----------
// 只在隔离模式下运行：agy 在私有桌面里启动，工作目录里放一个私有插件，只挂 relay 工具服务，其他自带工具一律被
// 闸门拦下（见 isolation/index.js 的 launchGemini）。型号名 = 配置里的 id + 思考深度后缀，如 gemini-4-neon-high
const geminiAgyModel = (model, effort) => {
  const have = geminiModel(model)?.efforts || [];
  return model + '-' + (have.includes(effort) ? effort : have.includes('medium') ? 'medium' : have[0] || 'medium');
};
function launchGemini(u, conv, userMsg, conversationId) {
  const startedAt = Date.now();
  if (!config.isolation?.enabled) throw Error('Gemini 只在隔离模式下可用');
  return { ...isolation.launchGemini({ u, conversationId, model: geminiAgyModel(userMsg.model, userMsg.effort),
    instructions: modelInstructions(u, conv.projectId, 'google') }), startedAt };
}
// 显示命令时去掉外面那层 powershell.exe -Command "…"
const shellSummary = (cmd) => String(cmd || '').replace(/^"?[^"\s]*powershell(?:\.exe)?"?\s+-Command\s+/i, '').replace(/^"([\s\S]*)"$/, '$1').slice(0, 400);
// 按 config.gptModels[].price（每百万 token 美元）算这一轮的花费，没填价格就不算
function gptCost(model, usage) {
  const p = gptModel(model)?.price;
  if (!p || !usage) return undefined;
  const cached = usage.cached_input_tokens || 0;
  return ((usage.input_tokens - cached) * (p.input || 0) + cached * (p.cachedInput ?? p.input ?? 0) + (usage.output_tokens || 0) * (p.output || 0)) / 1e6;
}

// Gemini 最常见的中断不是额度，而是 Google 那边没有空闲的机器（HTTP 503 No capacity available / high traffic），agy 自己试几次就放弃了。
// 这种失败如果发生在模型还什么都没做的时候（没有文字、没有工具动作），就等一等自动再发一遍，用户不用自己点「继续」：
// 隔 20 秒、45 秒、90 秒各试一次，都不行才报错。已经做了一部分的不自动重来（重发会把做过的事再做一遍），留给用户点「继续」。
const GEMINI_CAPACITY = /no capacity available|high traffic|\b503\b|\bUNAVAILABLE\b/i;
const GEMINI_CAPACITY_WAITS = [20e3, 45e3, 90e3];
function startJob(u, conv, userMsg, recovery = null) {
  const msg = recovery?.msg || { role: 'assistant', turnId: crypto.randomUUID(), events: [], status: 'running', model: userMsg.model, effort: userMsg.effort, startedAt: Date.now() };
  if (!recovery) conv.messages.push(msg);
  const msgIndex = conv.messages.length - 1;

  const provider = providerOf(userMsg.model), gpt = provider === 'openai', gemini = provider === 'google';
  if (provider !== 'anthropic') msg.provider = provider;
  const resumeId = gpt ? conv.codexThreadId : gemini ? geminiResumeId(u, conv) : conv.sessionId;
  const recoveryAttempt = recovery?.attempt || 0;
  // 另一个模型答过、这个模型的会话里没有的几轮，放在这条消息前面补给它。Gemini 接不上原来的 agy 对话时（新对话、
  // 编辑或重试过），它什么都不记得，前面的内容全部补给它
  // Gemini 接着同一个 agy 对话时，它没答完的那一轮不再交接一遍（见 geminiHandoffView）
  const handoffConv = gemini && !recovery ? geminiHandoffView(conv, resumeId) : conv;
  const handoffPacket = handoffFor(u, handoffConv, provider, { resumesInterrupted: userMsg.resumesInterrupted === true, filesIncomplete: !!userMsg.handoffFilesIncomplete, fullHistory: recoveryAttempt > 0 || (gemini && !resumeId) });
  if (recoveryAttempt || (handoffPacket.stats.from && providerOf(handoffPacket.stats.from) !== providerOf(userMsg.model))) {
    msg.handoff = { ...handoffPacket.stats, recovered: false };
  }
  saveConv(u, conv); // 交接统计随回答持久化；正文仅发送给模型，不写进回答。
  const missed = handoffPacket.text;
  let proc;
  try {
    if (gpt) proc = launchCodex(u, conv, userMsg, conv.codexThreadId);
    else if (gemini) proc = launchGemini(u, conv, userMsg, resumeId);
    else {
      const key = warmKey(u, conv.sessionId, userMsg.model, userMsg.effort, conv.projectId);
      proc = takeWarm(key) || launchClaude(key);
      if (proc.warm) console.log('  （使用预热好的 Claude）');
    }
  } catch (error) {
    const runtimeDetails = { spawnError: true, spawnCode: error.code, spawnPath: error.path, failureText: error.message };
    msg.maintenanceFailureKind = runtimeHealth.classifyOutcome(runtimeDetails);
    maintenanceDrain.background(() => runtimeHealth.recordOutcome({ ...runtimeDetails, program: gpt ? 'Codex' : gemini ? 'Gemini' : 'Claude', sessionId: u.id + ':' + conv.id, startedAt: msg.startedAt },
      { eventsDir: path.join(ROOT, 'data', 'maintenance', 'runtime-events'), spawnContext: { executable: gpt ? config.codexPath : gemini ? config.agyPath : config.claudePath, cwd: u.workDir } })).catch(() => {});
    saveConv(u, conv);
    throw error; // 仍由原调用方处理启动异常；记录失败不改变请求结果。
  }

  const child = proc.child;
  // 最终结果先返回给用户时进程仍可能在收尾，计数保留到退出后的扫描和存档全部结束。
  const releaseModel = maintenanceDrain.enter();
  const finishFinalization = modelFinalization.begin(u.id, conv.id, provider);
  // 流式文字攒 50 毫秒合成一条推送：经隧道的消息少一个数量级，手机端也少重绘几次。
  // 别的推送发出前、以及网页来取这个对话的存档前（flush），先把攒着的推出去，顺序和内容才对得上
  let pend = null, pendTimer = null;
  const flushDelta = () => {
    clearTimeout(pendTimer); pendTimer = null;
    if (!pend) return;
    const p = pend; pend = null;
    broadcast({ type: 'delta', convId: conv.id, msgIndex, eventIndex: p.i, text: p.text }, u);
  };
  const sendDelta = (i, text) => {
    if (pend && pend.i !== i) flushDelta();
    if (pend) pend.text += text; else pend = { i, text };
    if (!pendTimer) pendTimer = setTimeout(flushDelta, 50);
  };
  const job = { child, cancel: proc.cancel, conv, msg, user: u, stopped: false, flush: flushDelta };
  for (const other of jobs.values()) if (other.user === u && other !== job && other.conv?.id !== conv.id) { other.overlapped = true; job.overlapped = true; } // 见 memoryTouchedBy
  jobs.set(jobKey(u, conv.id), job);
  broadcast({ type: 'job', convId: conv.id, running: true }, u);
  ensureQuickSpare(); // 回复过程中马上要用到（翻译思考、起标题）
  console.log(`\n[${new Date().toLocaleTimeString()}] 新消息 · ${u.id} · 对话 ${conv.id} · ${userMsg.model}/${userMsg.effort} · ${userMsg.text.length} 字符`);

  const push = (ev) => {
    flushDelta();
    msg.events.push(ev);
    broadcast({ type: 'event', convId: conv.id, msgIndex, event: ev }, u);
  };
  // 某个已有事件整体变化（工具参数生成完、思考翻译好等）时整条重发
  const update = (ev) => { flushDelta(); broadcast({ type: 'evupdate', convId: conv.id, msgIndex, eventIndex: msg.events.indexOf(ev), event: ev }, u); };
  const blocks = new Map(); // `${apiMsgId}:${index}` -> { kind, ev, json, lastSent }
  const toolsById = new Map();
  let saveTimer = null, releaseSave = null;
  // 回复结束后还可能有迟到的更新（思考翻译）。那时对话可能已经开始了下一轮（存档和内存里是新的对象），
  // 所以只把这条回复放回最新的对话里，而不是用这里的旧对象整个覆盖；对话已被删掉就不再写回，免得「复活」
  const saveSoon = () => {
    if (saveTimer) return;
    releaseSave = maintenanceDrain.enter();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
      if (jobs.get(jobKey(u, conv.id)) === job) return saveConv(u, conv);
      const cur = loadConv(u, conv.id); // 下一轮正在回复时拿到的是它在内存里的对话，它结束时会自己保存
      if (!cur) return;
      const i = cur.messages.findIndex((x) => x.role === 'assistant' && x.turnId === msg.turnId);
      if (i < 0) return; // 这一轮已经被编辑/重试替换掉了
      cur.messages[i] = msg;
      if (!jobs.has(jobKey(u, cur.id))) saveConv(u, cur);
      } finally { releaseSave?.(); releaseSave = null; }
    }, 3000);
  };

  // 任务清单：TaskCreate 的结果里才有编号，所以先记下待定的创建请求
  const pendingCreates = new Map(); // tool_use_id -> { subject, activeForm }
  const sendPlan = () => { flushDelta(); broadcast({ type: 'plan', convId: conv.id, msgIndex, plan: msg.plan }, u); saveSoon(); };
  const ensurePlan = () => {
    if (msg.plan) return;
    // 接着上一轮的清单继续更新
    const prev = [...conv.messages].reverse().find((x) => x !== msg && x.plan);
    msg.plan = prev ? prev.plan.map((t) => ({ ...t })) : [];
  };
  let createdHere = false; // 这一轮自己建过任务没有
  function onTaskTool(name, id, input) {
    if (name === 'TaskCreate') pendingCreates.set(id, { subject: input.subject || '', activeForm: input.activeForm || '' });
    else if (name === 'TaskUpdate' && input.taskId != null) {
      ensurePlan();
      const t = msg.plan.findLast((x) => String(x.id) === String(input.taskId));
      if (!t) return;
      if (input.status === 'deleted') msg.plan.splice(msg.plan.indexOf(t), 1);
      else {
        if (input.status) t.status = input.status;
        if (input.subject) t.subject = input.subject;
        if (input.activeForm) t.activeForm = input.activeForm;
      }
      sendPlan();
    }
  }
  function onTaskResult(id, content, isError) {
    const pc = pendingCreates.get(id);
    if (!pc) return;
    pendingCreates.delete(id);
    const num = !isError && resultPreview(content).match(/#(\d+)/);
    if (!num) return;
    // 每一轮都是新的 Claude 进程，任务编号又从 #1 开始，和接过来的上一轮清单对不上（会把完成标到旧任务上）。
    // 所以这一轮一旦自己建了任务，就换成这一轮自己的清单；上一轮的清单仍显示在上一条回复里
    if (!createdHere) { createdHere = true; msg.plan = []; }
    msg.plan.push({ id: num[1], subject: pc.subject, activeForm: pc.activeForm, status: 'pending' });
    sendPlan();
  }

  const prompt = missed + buildPrompt(u, conv, userMsg.cont ? CONTINUE_PROMPT : userMsg.text, userMsg.attachments, userMsg.tool, userMsg.tz, userMsg.linked, userMsg.canTrust);
  if (gpt) child.stdin.end(prompt, 'utf8'); // Codex 从标准输入读这一轮的消息
  else if (gemini) child.stdin.end(JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n', 'utf8'); // agy 的 stream-json 输入
  else child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n', 'utf8');
  // 记下工作文件夹里现有的文件，回复结束后对比出这一轮新建/改动了哪些。放在把消息交给 Claude 之后，
  // 免得文件多时先扫一遍文件夹才开始回复（Claude 的第一个动作至少在一两秒之后，不会漏掉改动）
  const convRel = convFolder(u, conv);
  const memoryBefore = memoryState(u, conv.projectId); // 见 memoryChanges
  const beforeScan = scanTurnAsync(u, convRel).then((list) => new Map(list.map((f) => [f.path, f.mtime + ':' + f.size]))).catch(() => null);

  let buf = '', stderr = '', finished = false;
  let runtimeSpawnCode = null, runtimeSpawnPath = null, runtimeCompleted = false, protocolErrors = 0, validEvents = 0, protocolDiagnostic = '';
  let toolEventCount = 0, lastResult = null;
  // Codex 的事件（codex exec --json）翻译成和 Claude 一样的显示：文字、思考、工具步骤及结果、任务清单。
  // Codex 不逐字推送，回答是一段一段（每条消息完整地）出来的
  const codexItems = new Map(); // item id -> 已推给网页的事件
  const codexText = (item, kind) => {
    const ev = codexItems.get(item.id), text = item.text || '';
    if (!ev) {
      const nev = kind === 'thinking' ? { k: 'thinking', text } : { k: 'text', text };
      codexItems.set(item.id, nev); push(nev); return nev;
    }
    if (text.startsWith(ev.text) && text.length > ev.text.length) { sendDelta(msg.events.indexOf(ev), text.slice(ev.text.length)); ev.text = text; }
    else if (text !== ev.text) { ev.text = text; update(ev); }
    saveSoon();
    return ev;
  };
  const codexTool = (item, name, summary) => {
    let ev = codexItems.get(item.id);
    if (!ev) { ev = { k: 'tool', id: item.id, name, summary }; codexItems.set(item.id, ev); toolsById.set(ev.id, ev); push(ev); process.stdout.write(`  · ${name} ${summary.split('\n')[0].slice(0, 100)}\n`); }
    return ev;
  };
  function onCodex(m) {
    const item = m.item || {};
    if (m.type === 'thread.started') msg.threadId = m.thread_id;
    else if (m.type === 'item.started' || m.type === 'item.updated' || m.type === 'item.completed') {
      const done = m.type === 'item.completed';
      if (item.type === 'agent_message') { codexText(item, 'text'); if (done) msg.result = item.text || msg.result; }
      else if (item.type === 'reasoning') {
        const ev = codexText(item, 'thinking');
        if (done && config.translateThinking && /[a-z]{3}/i.test(ev.text) && !/[一-鿿]{4}/.test(ev.text.slice(0, 80))) translateThinking(ev.text, (zh) => { ev.zh = zh; update(ev); saveSoon(); });
      } else if (item.type === 'command_execution') {
        codexTool(item, 'PowerShell', shellSummary(item.command));
        if (done) push({ k: 'tool_result', id: item.id, error: item.exit_code !== 0, preview: resultPreview(item.aggregated_output || '') });
      } else if (item.type === 'file_change' && done) {
        codexTool(item, 'Edit', (item.changes || []).map((c) => toRel(u, path.resolve(u.workDir, c.path || ''))).join('\n'));
        push({ k: 'tool_result', id: item.id, error: item.status === 'failed', preview: '' });
      } else if (item.type === 'web_search') codexTool(item, 'WebSearch', item.query || '');
      else if (item.type === 'mcp_tool_call') {
        const name = item.server === 'relay' ? String(item.tool || '').replace(/^mcp__relay__/, '') : `${item.server || 'mcp'}:${item.tool || ''}`;
        let input = item.arguments || item.input || {};
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
        const first = !codexItems.has(item.id);
        const ev = codexTool(item, name, summarizeTool(name, input, u));
        if (QUIET_TOOLS.has(name) && !ev.quiet) { ev.quiet = true; update(ev); }
        if (first && TASK_TOOLS.includes(name)) onTaskTool(name, item.id, input);
        if (done) {
          const result = item.result?.content || item.result || item.error || '';
          const failed = item.status === 'failed' || !!item.error || !!item.result?.isError;
          onTaskResult(item.id, result, failed);
          push({ k: 'tool_result', id: item.id, error: failed, preview: resultPreview(result) });
        }
      }
      else if (item.type === 'todo_list') {
        // Codex 的计划 → 网页上的任务清单（第一个没做完的当作进行中）
        const list = item.items || [];
        const cur = list.findIndex((t) => !t.completed);
        msg.plan = list.map((t, i) => ({ id: String(i + 1), subject: t.text || '', activeForm: t.text || '', status: t.completed ? 'completed' : i === cur ? 'in_progress' : 'pending' }));
        sendPlan();
      } else if (item.type === 'error' && done && !/Model metadata/.test(item.message || '')) stderr += '\n' + item.message;
    } else if (m.type === 'turn.completed') {
      runtimeCompleted = true;
      msg.usage = m.usage; msg.cost = gptCost(msg.model, m.usage); msg.durationMs = Date.now() - msg.startedAt;
      if (!job.stopped) finish(0);
    } else if (m.type === 'turn.failed' || m.type === 'error') {
      msg.isError = true; msg.result = (m.error && m.error.message) || m.message || msg.result;
    }
  }
  // Gemini（agy -p --output-format stream-json）的事件：init（对话编号）、step_update（一步一步：回答文字逐段推送、
  // 工具调用开始和结束）、result（最终结果和用量）。agy 不推送思考内容，只给思考用了多少 token
  const geminiSteps = new Map(); // step_index -> 已推给网页的事件（{ skip: true } 表示不显示的内部步骤）
  const geminiResulted = new Set();
  let geminiLost = false; // 要接着的 agy 对话已经不在了，agy 悄悄开了个新对话：这一轮作废，带上完整历史重来
  const GEMINI_SCHEMA_READ = /[\\/]antigravity-cli[\\/]mcp[\\/]relay_relay[\\/][A-Za-z][A-Za-z0-9_]*\.json$/i;
  function onGemini(m) {
    if (m.event === 'init') {
      const id = typeof m.conversation_id === 'string' ? m.conversation_id : '';
      if (id) msg.geminiConvId = id;
      if (resumeId && id && id !== resumeId) { geminiLost = true; try { child.kill(); } catch {} }
      return;
    }
    if (geminiLost) return;
    if (m.event === 'result') {
      const r = m.result || {};
      if (typeof r.conversation_id === 'string' && r.conversation_id) msg.geminiConvId = r.conversation_id;
      const usage = r.usage || {};
      msg.usage = { input_tokens: usage.input_tokens || 0, cached_input_tokens: usage.cache_read_tokens || 0, output_tokens: usage.output_tokens || 0, thinking_tokens: usage.thinking_tokens || 0 };
      msg.durationMs = Date.now() - msg.startedAt;
      if (r.status === 'SUCCESS') { msg.result = r.response || ''; runtimeCompleted = true; if (!job.stopped) finish(0); }
      else { msg.isError = true; msg.result = String(r.error || r.response || 'Gemini 的回复没有完成'); }
      return;
    }
    const s = m.step_update || {};
    if (typeof s.conversation_id === 'string' && s.conversation_id && !msg.geminiConvId) msg.geminiConvId = s.conversation_id;
    const stepIndex = Number.isInteger(s.step_index) ? s.step_index : -1;
    if (s.step_type === 'agent_response') {
      const t = typeof s.text_delta === 'string' ? s.text_delta : '';
      let ev = geminiSteps.get(stepIndex);
      if (!ev && t.trim()) { ev = { k: 'text', text: '' }; geminiSteps.set(stepIndex, ev); push(ev); }
      if (ev && t) { ev.text += t; sendDelta(msg.events.indexOf(ev), t); saveSoon(); }
      return;
    }
    if (s.step_type !== 'tool') return;
    const info = s.tool_info || {}, raw = String(s.tool_name || info.name || ''), p = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
    const id = 'gemini-' + stepIndex;
    let ev = geminiSteps.get(stepIndex);
    if (!ev) {
      if (raw === 'read_file' && GEMINI_SCHEMA_READ.test(String(p.Path || ''))) { geminiSteps.set(stepIndex, { skip: true }); return; } // 调工具前先读工具说明
      let name = raw, input = p;
      if (raw === 'call_mcp_tool') {
        name = String(p.ToolName || 'mcp'); input = p.Arguments && typeof p.Arguments === 'object' ? p.Arguments : {};
        if (p.ServerName !== 'relay_relay') name = (p.ServerName || 'mcp') + ':' + name;
      } else if (raw === 'search_web') { name = 'WebSearch'; input = { query: p.query || p.Query || '' }; }
      ev = { k: 'tool', id, name, summary: summarizeTool(name, input, u) };
      // agy 自带的工具在这里都被隔离层拦下了，只是它偶尔会试一下：不打扰用户，收起来显示
      if (QUIET_TOOLS.has(name) || (raw !== 'call_mcp_tool' && raw !== 'search_web')) ev.quiet = true;
      geminiSteps.set(stepIndex, ev); toolsById.set(id, ev); push(ev); toolEventCount++;
      if (TASK_TOOLS.includes(name)) onTaskTool(name, id, input);
      if (!ev.quiet) process.stdout.write(`  · ${name} ${ev.summary.split('\n')[0].slice(0, 100)}\n`);
    }
    if (ev.skip || (s.state !== 'DONE' && s.state !== 'ERROR') || geminiResulted.has(id)) return;
    geminiResulted.add(id);
    const failed = s.state === 'ERROR' || !!info.error;
    const out = failed ? String(info.error?.message || '工具调用失败') : info.output ?? '';
    onTaskResult(id, out, failed);
    push({ k: 'tool_result', id, error: failed, preview: resultPreview(out) });
  }
  proc.attach((d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { protocolErrors++; protocolDiagnostic = line.slice(-2000); continue; }
      if (gemini) {
        if (!m || typeof m !== 'object' || !['init', 'step_update', 'result'].includes(m.event)) { protocolErrors++; protocolDiagnostic = line.slice(-2000); continue; }
        validEvents++; onGemini(m); continue;
      }
      if (hasToolEvents([m])) toolEventCount++;
      if (m?.type === 'result') lastResult = m;
      const knownTypes = gpt ? ['thread.started', 'item.started', 'item.updated', 'item.completed', 'turn.started', 'turn.completed', 'turn.failed', 'error'] : ['system', 'stream_event', 'assistant', 'user', 'rate_limit_event', 'result'];
      if (!m || typeof m !== 'object' || !knownTypes.includes(m.type)) { protocolErrors++; protocolDiagnostic = line.slice(-2000); continue; }
      validEvents++;
      if (gpt) { onCodex(m); continue; }
      if (m.parent_tool_use_id) continue; // 子任务内部细节不展示
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) msg.sessionId = m.session_id;
      else if (m.type === 'stream_event') {
        const e = m.event, key = m.api_message_id + ':' + e.index;
        if (e.type === 'content_block_start') {
          const cb = e.content_block;
          if (cb.type === 'text') {
            const ev = { k: 'text', text: '' }; blocks.set(key, { kind: 'text', ev }); push(ev);
          } else if (cb.type === 'thinking') {
            const ev = { k: 'thinking', text: '', startedAt: Date.now(), live: true }; blocks.set(key, { kind: 'thinking', ev }); push(ev);
          } else if (cb.type === 'tool_use') {
            // 工具调用一开始就显示出来；写大文件时参数要生成很久，期间实时报告进度
            const name = String(cb.name).replace(/^mcp__relay__/, '');
            const ev = { k: 'tool', id: cb.id, name, summary: '', chars: 0, building: true };
            if (QUIET_TOOLS.has(name)) ev.quiet = true;
            blocks.set(key, { kind: 'tool', ev, json: '', lastSent: 0 });
            toolsById.set(ev.id, ev);
            push(ev);
          }
        } else if (e.type === 'content_block_delta' && blocks.has(key)) {
          const b = blocks.get(key), dl = e.delta;
          if (dl.type === 'text_delta' || (dl.type === 'thinking_delta' && dl.thinking)) {
            const t = dl.type === 'text_delta' ? dl.text : dl.thinking;
            b.ev.text += t;
            sendDelta(msg.events.indexOf(b.ev), t);
            saveSoon();
          } else if (dl.type === 'input_json_delta') {
            b.json += dl.partial_json;
            b.ev.chars = b.json.length;
            if (!b.ev.summary) {
              const fm = b.json.match(/"(file_path|notebook_path|command|query|url|pattern|description)"\s*:\s*"((?:[^"\\]|\\.){1,300})"/);
              if (fm) { try { b.ev.summary = summarizeTool(b.ev.name, { [fm[1]]: JSON.parse('"' + fm[2] + '"') }, u); } catch {} }
            }
            if (Date.now() - b.lastSent > 400) {
              b.lastSent = Date.now();
              flushDelta();
              broadcast({ type: 'toolprogress', convId: conv.id, msgIndex, eventIndex: msg.events.indexOf(b.ev), chars: b.ev.chars, summary: b.ev.summary }, u);
            }
          }
        } else if (e.type === 'content_block_stop' && blocks.has(key)) {
          const b = blocks.get(key);
          if (b.kind === 'thinking') {
            b.ev.durationMs = Date.now() - b.ev.startedAt;
            delete b.ev.live;
            update(b.ev);
            // 思考摘要是英文的，翻译成中文后替换显示
            if (config.translateThinking && /[a-z]{3}/i.test(b.ev.text) && !/[一-鿿]{4}/.test(b.ev.text.slice(0, 80))) {
              translateThinking(b.ev.text, (zh) => { b.ev.zh = zh; update(b.ev); saveSoon(); });
            }
          }
        }
      } else if (m.type === 'assistant' && m.message) {
        for (const c of m.message.content || []) {
          if (c.type !== 'tool_use') continue;
          const name = String(c.name).replace(/^mcp__relay__/, '');
          const summary = summarizeTool(name, c.input, u);
          const existing = toolsById.get(c.id);
          if (existing) { existing.summary = summary; delete existing.building; update(existing); }
          else push({ k: 'tool', id: c.id, name, summary, ...(QUIET_TOOLS.has(name) ? { quiet: true } : {}) });
          if (TASK_TOOLS.includes(name)) onTaskTool(name, c.id, c.input || {});
          if (!QUIET_TOOLS.has(name)) process.stdout.write(`  · ${name} ${summary.split('\n')[0].slice(0, 100)}\n`);
        }
      } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
        for (const c of m.message.content) {
          if (c.type !== 'tool_result') continue;
          onTaskResult(c.tool_use_id, c.content, c.is_error);
          push({ k: 'tool_result', id: c.tool_use_id, error: !!c.is_error, preview: resultPreview(c.content) });
        }
      } else if (m.type === 'rate_limit_event' && m.rate_limit_info) {
        onRateLimitEvent(m.rate_limit_info);
      } else if (m.type === 'result') {
        if (m.session_id) msg.sessionId = m.session_id;
        msg.result = m.result || '';
        msg.isError = !!m.is_error;
        msg.cost = m.total_cost_usd;
        msg.durationMs = m.duration_ms;
        // 成功拿到最终结果就收尾：进程还要约半秒才退出（关 MCP 连接等），不让用户白等。出错的等进程退出，错误信息才完整
        if (!msg.isError && !job.stopped) { runtimeCompleted = true; finish(0); }
      }
    }
  }, (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });

  // 这一轮结束：定状态、存档、通知网页。之后就可以接着发下一条了
  function finish(code) {
    if (finished) return;
    finished = true;
    flushDelta();
    clearTimeout(saveTimer); saveTimer = null;
    releaseSave?.(); releaseSave = null;
    for (const ev of toolsById.values()) delete ev.building;
    for (const ev of msg.events) if (ev.k === 'thinking' && ev.live) { delete ev.live; ev.durationMs = Date.now() - ev.startedAt; }
    msg.status = job.stopped ? 'stopped' : (code === 0 && !msg.isError ? 'done' : 'error');
    // 诊断只瞬时分类；健康文件只保存类别、会话摘要和时间，不保存输出正文。
    const runtimeDetails = { success: runtimeCompleted && msg.status === 'done', cancelled: job.stopped,
      spawnError: !!runtimeSpawnCode, spawnCode: runtimeSpawnCode, spawnPath: runtimeSpawnPath, exitCode: code,
      protocolErrors, validEvents, hasOutput: msg.events.length > 0 || (!msg.isError && typeof msg.result === 'string' && msg.result.trim().length > 0),
      failureText: stderr + '\n' + (msg.isError ? msg.result || '' : '') + '\n' + protocolDiagnostic };
    msg.maintenanceFailureKind = runtimeHealth.classifyOutcome(runtimeDetails);
    maintenanceDrain.background(() => runtimeHealth.recordOutcome({ ...runtimeDetails, program: gpt ? 'Codex' : gemini ? 'Gemini' : 'Claude', sessionId: u.id + ':' + conv.id, startedAt: proc.startedAt || msg.startedAt },
      { eventsDir: path.join(ROOT, 'data', 'maintenance', 'runtime-events'), spawnContext: { executable: gpt ? config.codexPath : gemini ? config.agyPath : config.claudePath, cwd: u.workDir } })).catch(() => {});
    // 只有成功时才前进到新会话；失败/停止则保留上一轮的会话，下次从那里继续
    if (msg.status === 'done' && msg.sessionId) conv.sessionId = msg.sessionId;
    if (msg.status === 'done' && msg.threadId) conv.codexThreadId = msg.threadId; // GPT 的会话各走各的
    // agy 的对话不能 fork：这一轮不管成没成功都已经写进了那个对话，所以都记下（见 geminiResumeId）
    if (gemini && msg.geminiConvId && !geminiLost) { conv.geminiConvId = msg.geminiConvId; conv.geminiTurnId = msg.turnId; }
    if (msg.status === 'error') { const rawError = (msg.result || stderr.trim() || `退出码 ${code}`).slice(-3000); msg.errorText = pageErrorText(rawError); console.log(`[回复出错] ${u.id} ${conv.id}：` + rawError.slice(-2000).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<已隐藏>')); }
    // 程序根本没启动起来（找不到、没权限），一个事件都没有：没有可以「继续」的东西
    if (msg.status === 'error' && runtimeSpawnCode && !msg.events.length) msg.resumable = false;
    if (recoveryAttempt) {
      msg.recoveryNotice = msg.status === 'done' ? RECOVERY_NOTICE : '原会话不可用，已尝试从对话记录恢复，但本次回复未完成';
      if (msg.handoff) msg.handoff.recovered = msg.status === 'done';
    }
    msg.finishedAt = Date.now();
    jobs.delete(jobKey(u, conv.id));
    saveConv(u, conv);
    broadcast({ type: 'done', convId: conv.id, msgIndex, message: withFileUrls(u, { messages: [msg] }, conversationMode(u, conv)).messages[0] }, u);
    broadcast({ type: 'job', convId: conv.id, running: false }, u);
    if (msg.status === 'done' && !conv.titled) generateTitle(u, conv);
  }

  child.on('error', (err) => { runtimeSpawnCode = err.code || null; runtimeSpawnPath = err.path || null; stderr += '\n' + err.message; });
  child.on('close', async (code) => {
    let finalizationIncomplete = false;
    try {
    if (!finished && jobs.get(jobKey(u, conv.id)) === job && ((gemini && geminiLost && !recoveryAttempt && !job.stopped) || canRecoverSession({
      provider, resumeId, attempt: recoveryAttempt,
      cancelled: job.stopped, events: msg.events, toolEventCount, stderr, result: lastResult, errorText: msg.isError ? msg.result : '', exitCode: code,
    }))) {
      // 首次启动失败且没有任何工具动作（Gemini 还有一种：要接着的 agy 对话已经不在了）：沿用同一条回复，清掉失效会话后只重试一次。
      clearTimeout(saveTimer); saveTimer = null; releaseSave?.(); releaseSave = null;
      clearTimeout(pendTimer); pendTimer = null; pend = null;
      if (gpt) conv.codexThreadId = null; else if (gemini) conv.geminiConvId = null; else conv.sessionId = null;
      for (const field of ['sessionId','threadId','geminiConvId','result','isError','errorText','usage','cost','durationMs','maintenanceFailureKind']) delete msg[field];
      msg.events = []; msg.status = 'running'; msg.sessionRecoveryAttempted = true;
      try { startJob(u, conv, userMsg, { msg, attempt: 1 }); }
      catch { msg.isError = true; msg.result = '原会话不可用，重新开始回复未成功，请稍后再试'; finish(1); }
      return;
    }
    // Google 那边没空位、而且这一轮还什么都没做：等一等自动再试（见 GEMINI_CAPACITY）。等的时候用户点「停止」照常能停
    if (!finished && jobs.get(jobKey(u, conv.id)) === job && gemini && !job.stopped && !geminiLost && (recovery?.capacityTries || 0) < GEMINI_CAPACITY_WAITS.length &&
        !msg.events.some((ev) => ev.k === 'tool' || (ev.k === 'text' && String(ev.text || '').trim())) && GEMINI_CAPACITY.test((msg.isError ? msg.result || '' : '') + ' ' + stderr)) {
      clearTimeout(saveTimer); saveTimer = null; releaseSave?.(); releaseSave = null;
      clearTimeout(pendTimer); pendTimer = null; pend = null;
      const capacityTries = recovery?.capacityTries || 0;
      console.log(`[Gemini 没有空位] ${u.id} ${conv.id}：${GEMINI_CAPACITY_WAITS[capacityTries] / 1000} 秒后自动再试（第 ${capacityTries + 1} 次）`);
      const failedText = msg.result;
      for (const field of ['sessionId','threadId','geminiConvId','result','isError','errorText','usage','cost','durationMs','maintenanceFailureKind']) delete msg[field];
      msg.events = []; msg.status = 'running'; msg.capacityRetries = capacityTries + 1;
      const giveUp = () => { msg.isError = true; msg.result = failedText || 'Gemini 的回复没有完成'; finish(1); };
      const timer = setTimeout(() => {
        if (finished || job.stopped || jobs.get(jobKey(u, conv.id)) !== job) return;
        try { startJob(u, conv, userMsg, { msg, attempt: recoveryAttempt, capacityTries: capacityTries + 1 }); } catch { giveUp(); }
      }, GEMINI_CAPACITY_WAITS[capacityTries]);
      job.cancel = async () => { clearTimeout(timer); if (!finished) finish(1); }; // 等的时候点了停止：stopJob 已经把 job.stopped 记上，这里收尾成「已停止」
      return;
    }
    finish(code);
    await refreshSnap(u); // 这一轮可能改了记忆、项目记忆或资料
    // 进程退出后才统计这一轮改动的文件。这时下一轮可能已经开始了，所以和迟到的更新一样，
    // 把文件列表写进最新的对话里这条回复上（按开始时间找），再单独推给网页
    let changed = [];
    try {
      const before = await beforeScan;
      if (before) {
        const after = await scanTurnAsync(u, convRel), present = new Set(after.map((f) => f.path));
        changed = after.filter((f) => before.get(f.path) !== f.mtime + ':' + f.size).map((f) => ({ path: f.path, size: f.size }));
        const touched = changed.filter((f) => f.path.startsWith('linked/') && f.size <= LINKED_FILE_LIMIT).map((f) => f.path);
        const gone = [...before.keys()].filter((p) => p.startsWith('linked/') && !present.has(p));
        if (touched.length || gone.length) historyAfterTurn(u, conv, msg, touched, gone).catch(() => {}); // 版本历史：模型的每次改动各记一版
      } else finalizationIncomplete = true;
    } catch (e) { finalizationIncomplete = true; console.log(' 统计改动文件失败：' + e.message); }
    msg.files = changed;
    let memoryUpdated = [], memoryDeltas = null;
    try {
      const memoryAfter = memoryState(u, conv.projectId);
      memoryUpdated = memoryChanges(memoryBefore, memoryAfter).filter((kind) => !job.overlapped || memoryTouchedBy(msg.events, kind));
      if (memoryUpdated.length) memoryDeltas = Object.fromEntries(memoryUpdated.map((kind) => [kind, memoryDelta(memoryBefore[kind], memoryAfter[kind])]));
    } catch {}
    if (memoryUpdated.length) { msg.memoryUpdated = memoryUpdated; msg.memoryDelta = memoryDeltas; }
    const cur = loadConv(u, conv.id);
    const i = cur ? cur.messages.findIndex((x) => x.role === 'assistant' && x.turnId === msg.turnId) : -1;
    if (i >= 0) {
      cur.messages[i].files = changed;
      if (memoryUpdated.length) { cur.messages[i].memoryUpdated = memoryUpdated; cur.messages[i].memoryDelta = memoryDeltas; }
      if (!jobs.has(jobKey(u, cur.id))) saveConv(u, cur);
      if (memoryUpdated.length) broadcast({ type: 'memory', convId: conv.id, msgIndex: i, turnId: msg.turnId, memory: memoryUpdated, delta: memoryDeltas }, u);
      if (changed.length) broadcast({ type: 'files', convId: conv.id, msgIndex: i, startedAt: msg.startedAt, turnId: msg.turnId, files: withFileUrls(u, { messages: [{ files: changed }] }).messages[0].files }, u);
    }
    if (msg.status !== 'done' && provider === 'anthropic') notifyPetEnded(msg.sessionId, u);
    console.log(`[${new Date().toLocaleTimeString()}] 回复结束：${msg.status}` + (changed.length ? `，改动文件 ${changed.length} 个` : '') + (msg.cost ? `，花费 $${msg.cost.toFixed(3)}` : '')
      + (msg.usage ? `，token 输入 ${msg.usage.input_tokens}（缓存 ${msg.usage.cached_input_tokens || 0}）/ 输出 ${msg.usage.output_tokens}` : ''));
    warmPreviews(u, changed.map((f) => f.path));
    try { if (cur && i >= 0) await writeChatTranscript(u, cur); } catch { finalizationIncomplete = true; }
    } catch { finalizationIncomplete = true; }
    finally {
      try {
        if (finalizationIncomplete) {
          msg.filesIncomplete = true;
          const latest = loadConv(u, conv.id);
          const saved = latest?.messages.find(x => x.role === 'assistant' && x.turnId === msg.turnId);
          if (saved) { saved.filesIncomplete = true; if (!jobs.has(jobKey(u, conv.id))) saveConv(u, latest); }
        }
      } catch { /* 状态保存失败也必须释放等待和排空计数。 */ }
      finally { finishFinalization(finalizationIncomplete); releaseModel(); }
    }
  });
}

// 桌面宠物靠 Claude Code 的钩子和 ~/.claude/projects 里的会话记录显示进度。轻量模式的账号不加载钩子，
// 回复被停止（强制结束进程）或出错时，会话记录停在半路，宠物会一直以为 Claude 还在想。
// 这时替 Claude 发一个 SessionEnd 给宠物的钩子脚本；正常完成的回复记录里有结束标记，不用发
function notifyPetEnded(sessionId, u) {
  if (config.isolation?.enabled) return; // User work cannot trigger host desktop hooks.
  if (!sessionId || !config.petHook || !fs.existsSync(config.petHook)) return;
  try {
    const child = spawn(process.execPath, [config.petHook], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, CLAUDE_PET_NO_LAUNCH: '1' } });
    child.on('error', () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd: u.workDir, reason: 'relay-stopped' }));
  } catch {}
}

// ---------- 启动 Claude 与预热 ----------
// 进程以 stream-json 输入模式启动，启动后静候第一条消息；所以可以提前启动（用户打字时），
// 消息一到直接写进 stdin，省掉加载时间。key 由「从哪个会话继续 + 模型 + 思考深度」决定。
const warmKey = (u, sessionId, model, effort, pid) => `${u.id}|${sessionId || 'new'}|${model}|${effort}|${validPid(pid) ? pid : ''}`;

function claudeArgs(key) {
  const [uid, sessionId, model, effort, pid] = key.split('|');
  const u = USERS.get(uid);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', config.permissionMode, '--append-system-prompt', modelInstructions(u, pid, 'anthropic'),
    '--model', model, '--effort', effort, ...LIGHT_ARGS(u)];
  if (config.showThinking) args.push('--thinking-display', 'summarized');
  args.push('--allowedTools', [...new Set([...config.allowedTools, ...TASK_TOOLS])].join(','));
  if (config.disallowedTools.length) args.push('--disallowedTools', config.disallowedTools.join(','));
  // 每一轮都 fork 出新会话：旧会话原样保留，编辑/重试时可以从任意一轮重新开始
  if (sessionId !== 'new') args.push('--resume', sessionId, '--fork-session');
  return [...args, ...config.extraArgs];
}

// 启动一个 Claude 进程；在 attach 之前收到的输出先缓存起来，attach 时补发
function launchClaude(key) {
  const [uid, sessionId, model, effort, pid] = key.split('|');
  const u = USERS.get(uid);
  if (config.isolation?.enabled) {
    const proc = isolation.launchClaude({ u, sessionId: sessionId === 'new' ? null : sessionId, model, effort,
      systemPrompt: modelInstructions(u, pid, 'anthropic') });
    return { ...proc, key, user: u, pid, startedAt: Date.now(), memVersion: promptVersion(u, pid) };
  }
  const child = spawn(config.claudePath, claudeArgs(key), { cwd: u.workDir, windowsHide: true, env: TOOL_ENV });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const early = { out: [], err: [] };
  const onOut = (d) => early.out.push(d), onErr = (d) => early.err.push(d);
  child.stdout.on('data', onOut);
  child.stderr.on('data', onErr);
  child.on('error', () => {});
  return {
    child, key, user: u, pid, startedAt: Date.now(), memVersion: promptVersion(u, pid),
    attach(out, err) {
      child.stdout.off('data', onOut); child.stderr.off('data', onErr);
      early.out.forEach(out); early.err.forEach(err);
      child.stdout.on('data', out); child.stderr.on('data', err);
    },
  };
}

const warmPool = new Map(); // key -> { proc, timer }
// 每个账号各留 2 个名额（以前两个账号共用 2 个，会互相挤掉）
const WARM_PER_USER = 2, WARM_TTL = 8 * 60e3;

function dropWarm(key) {
  const w = warmPool.get(key);
  if (!w) return;
  clearTimeout(w.timer);
  warmPool.delete(key);
  if (w.proc.cancel) { void w.proc.cancel(); return; }
  if (w.proc.child.exitCode === null) {
    try { w.proc.child.stdin.end(); } catch {}
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(w.proc.child.pid), '/T', '/F'], () => {});
    else w.proc.child.kill();
  }
}

function prewarm(key) {
  if (!config.prewarm || maintenanceDrain.blocked()) return;
  const w = warmPool.get(key);
  if (w && w.proc.child.exitCode === null && w.proc.memVersion === promptVersion(w.proc.user, w.proc.pid)) {  // 已经热着，续期
    clearTimeout(w.timer);
    w.timer = setTimeout(() => dropWarm(key), WARM_TTL);
    return;
  }
  if (w) dropWarm(key);
  const mine = () => [...warmPool.keys()].filter((k) => k.startsWith(key.split('|')[0] + '|'));
  while (mine().length >= WARM_PER_USER) dropWarm(mine()[0]); // 这个账号最早的先让位
  const proc = launchClaude(key);
  proc.warm = true;
  proc.child.on('close', () => { if (warmPool.get(key)?.proc === proc) { clearTimeout(warmPool.get(key).timer); warmPool.delete(key); } });
  warmPool.set(key, { proc, timer: setTimeout(() => dropWarm(key), WARM_TTL) });
}

function takeWarm(key) {
  const w = warmPool.get(key);
  if (!w) return null;
  if (w.proc.memVersion !== promptVersion(w.proc.user, w.proc.pid)) { dropWarm(key); return null; } // 记忆或项目更新过，提示词已过期
  clearTimeout(w.timer);
  warmPool.delete(key);
  return w.proc.child.exitCode === null ? w.proc : null;
}

// ---------- Office 文件预览 ----------
// PPT 及旧格式用 LibreOffice 转 PDF（这台电脑上每次约 17 秒），所以结果缓存，并在文件生成后就提前转好；
// Excel 用 Python 转 HTML 表格；Word(.docx) 在浏览器里直接渲染，不经过这里。
const PREVIEW_DIR = path.join(ROOT, 'data', 'previews');
const PDF_PREVIEW_EXTS = new Set(['.pptx', '.ppt', '.pps', '.ppsx', '.odp', '.doc', '.odt', '.rtf', '.xls', '.ods']);
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
const previewId = (abs) => { const st = fs.statSync(abs); return crypto.createHash('sha1').update(abs + '|' + st.mtimeMs + '|' + st.size).digest('hex'); };
const pdfJobs = new Map(); // previewId -> Promise
let pdfChain = Promise.resolve(); // LibreOffice 一次只转一个

function toPdf(abs) {
  const id = previewId(abs), out = path.join(PREVIEW_DIR, id + '.pdf');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (pdfJobs.has(id)) return pdfJobs.get(id);
  const job = (pdfChain = pdfChain.then(() => new Promise((resolve, reject) => {
    if (!fs.existsSync(SOFFICE)) return reject(new Error('没有安装 LibreOffice'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lo_out_'));
    const profile = 'file:///' + path.join(os.tmpdir(), 'lo_relay_profile').replace(/\\/g, '/');
    const child = spawn(SOFFICE, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, abs], { windowsHide: true });
    const timer = setTimeout(() => child.kill(), 180e3);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const made = fs.readdirSync(tmp).find((f) => f.toLowerCase().endsWith('.pdf'));
        if (!made) return reject(new Error('转换失败'));
        fs.copyFileSync(path.join(tmp, made), out); // 临时目录在 C 盘，不能直接 rename 到 D 盘
        resolve(out);
      } catch (e) { reject(e); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  })).catch((e) => { throw e; }));
  pdfChain = pdfChain.catch(() => {});
  pdfJobs.set(id, job);
  job.finally(() => pdfJobs.delete(id)).catch(() => {});
  return job;
}

const xlsxQueue = boundedJobs({ concurrency: 1, maxPending: 8 });
function xlsxHtml(abs) {
  const id = previewId(abs), out = path.join(PREVIEW_DIR, id + '.html');
  if (fs.existsSync(out)) return Promise.resolve(fs.readFileSync(out, 'utf8'));
  return xlsxQueue(id, () => new Promise((resolve, reject) => {
    execFile(VENV_PY, [path.join(ROOT, 'tools', 'xlsx_html.py'), abs], { env: TOOL_ENV, maxBuffer: 12e6, timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(new Error(err.killed ? '表格预览超时，请下载后查看' : '表格较大或格式异常，请下载后查看'));
      try { writeFileSafe(out, stdout); resolve(stdout); } catch (e) { reject(e); }
    });
  }));
}

// 新生成/上传的 PPT 等文件，提前在后台转好预览
function warmPreviews(u, relPaths) {
  if (config.isolation?.enabled) {
    // Isolated previews are request-owned snapshots. Converting here would do
    // the work twice and leave an unconsumed artifact without a response owner.
    return;
  }
  for (const rel of relPaths) {
    const abs = resolveIn(u, rel);
    if (abs && PDF_PREVIEW_EXTS.has(path.extname(abs).toLowerCase())) maintenanceDrain.background(() => toPdf(abs)).catch(() => {});
  }
}

// ---------- 语音：说话转文字、朗读 ----------
// 常驻一个 Python 进程（语音识别模型加载一次后常驻），10 分钟没用就退出
const TTS_DIR = path.join(ROOT, 'data', 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
let voiceProc = null, voiceSeq = 0, voiceIdle = null;
const voiceWaiters = new Map();

function voice(reqObj, timeoutMs = 120e3) {
  if (!voiceProc || voiceProc.exitCode !== null) {
    voiceProc = spawn(VENV_PY, [path.join(ROOT, 'tools', 'voice_worker.py')], { env: TOOL_ENV, windowsHide: true });
    voiceProc.stdout.setEncoding('utf8');
    let buf = '';
    voiceProc.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const r = JSON.parse(line); const w = voiceWaiters.get(r.id); if (w) { voiceWaiters.delete(r.id); w(r); } } catch {}
      }
    });
    voiceProc.stderr.on('data', () => {});
    voiceProc.on('close', () => { for (const w of voiceWaiters.values()) w({ error: '语音服务退出了' }); voiceWaiters.clear(); });
  }
  clearTimeout(voiceIdle);
  voiceIdle = setTimeout(() => { if (voiceProc) voiceProc.stdin.end(); }, 10 * 60e3);
  const id = ++voiceSeq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { voiceWaiters.delete(id); reject(new Error('处理超时')); }, timeoutMs);
    voiceWaiters.set(id, (r) => { clearTimeout(t); r.error ? reject(new Error(r.error)) : resolve(r); });
    voiceProc.stdin.write(JSON.stringify({ ...reqObj, id }) + '\n');
  });
}

// 朗读前去掉 Markdown 符号、代码块和链接地址
function speakableText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/\$\$[\s\S]*?\$\$/g, '（公式略）')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' ').replace(/[-:]{3,}/g, ''))
    .replace(/[#>*_`~]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 6000);
}

// 用小模型快速做一次性的文字处理（起标题、翻译思考摘要），不带工具、不留会话。
// 和主回复一样提前备好一个进程等着（启动要约 3 秒），用掉就补一个；空闲 10 分钟收掉。最多同时跑 2 个，多的排队，
// 免得长回复里每段思考都开一个进程，和主任务抢电脑
const QUICK_MAX = 2, QUICK_IDLE = 10 * 60e3;
let quickSpare = null, quickIdle = null, quickRunning = 0;
const quickQueue = [];
function spawnQuick() {
  const child = config.isolation?.enabled ? isolation.spawnText({ model: config.titleModel }) : spawn(config.claudePath, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', config.titleModel, '--effort', 'low', '--no-session-persistence', '--tools', '', ...QUICK_ARGS], { cwd: os.tmpdir(), windowsHide: true });
  child.stdout.setEncoding('utf8');
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  child.on('error', () => {});
  child.result = new Promise((resolve) => child.on('close', () => {
    const events = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
    // 起标题、翻译思考这些轻量任务也带额度信息，顺手更新
    for (const m of events) if (m && m.type === 'rate_limit_event' && m.rate_limit_info) onRateLimitEvent(m.rate_limit_info);
    const r = events.find((m) => m && m.type === 'result');
    resolve(r && !r.is_error && typeof r.result === 'string' ? r.result.trim() : '');
  }));
  return child;
}
function killQuick(child) {
  try { child.stdin.end(); } catch {}
  if (config.isolation?.enabled) { try { child.kill(); } catch {} return; }
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); else child.kill();
}
function ensureQuickSpare() {
  if (maintenanceDrain.blocked()) return;
  clearTimeout(quickIdle);
  quickIdle = setTimeout(() => { if (quickSpare) { killQuick(quickSpare); quickSpare = null; } }, QUICK_IDLE);
  if (!quickSpare || quickSpare.exitCode !== null) quickSpare = spawnQuick();
}
function runQuick() {
  if (quickRunning >= QUICK_MAX || !quickQueue.length) return;
  const { prompt, cb, release } = quickQueue.shift();
  quickRunning++;
  let child;
  try {
    child = quickSpare && quickSpare.exitCode === null ? quickSpare : spawnQuick();
    quickSpare = null;
  } catch { quickRunning--; release(); runQuick(); return; }
  try { ensureQuickSpare(); } catch {} // 补预热失败不影响已开始的轻量任务。
  try { child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n', 'utf8'); }
  catch { try { child.kill(); } catch {} } // 仍等close和回调完成，不提前报空闲。
  Promise.resolve(child.result).then(async text => { if (text) await cb(text); }).catch(() => {})
    .finally(() => { quickRunning--; release(); runQuick(); });
}
function quickAsk(prompt, cb) {
  quickQueue.push({ prompt, cb, release: maintenanceDrain.enter() });
  runQuick();
}

function translateThinking(text, cb) {
  quickAsk('把下面这段 AI 思考过程的摘要翻译成自然流畅的简体中文。保留段落，人名地名用中文常用译名，只输出译文：\n\n' + text.slice(0, 4000), cb);
}

// 像 claude.ai 一样，第一轮对话后自动起个标题
function generateTitle(u, conv) {
  const first = conv.messages.find((m) => m.role === 'user');
  if (!first) return;
  conv.titled = true;
  const zh = /[一-鿿]/.test(first.text);
  const prompt = (zh ? '为下面这条消息开启的对话起一个简短的简体中文标题（不超过12个字，必须用中文），'
    : 'Write a short title (at most 6 words, in the same language as the message) for the conversation started by the message below. ')
    + (zh ? '只输出标题本身，不要引号和标点：' : 'Output only the title, no quotes or punctuation:') + '\n\n' + first.text.slice(0, 1500);
  quickAsk(prompt, (out) => {
    const title = out.split('\n').pop().replace(/^["'“「《]|["'”」》。.]$/g, '').trim();
    if (!title || title.length > 40) return;
    const cur = loadConv(u, conv.id);
    if (!cur || cur.renamed) return;
    cur.title = title; cur.titled = true;
    if (!jobs.has(jobKey(u, cur.id))) saveConv(u, cur);
    broadcast({ type: 'title', convId: cur.id, title }, u);
  });
}

function stopJob(u, convId) {
  const job = jobs.get(jobKey(u, convId));
  if (!job) return false;
  job.stopped = true;
  if (job.cancel) { void job.cancel(); return true; }
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], () => {});
  else job.child.kill('SIGTERM');
  return true;
}

// ---------- 登录防爆破 ----------
// 两层：同一个 IP 错 8 次锁 15 分钟；同一个账号一小时内（来自各处）累计错 50 次，这个账号的密码登录暂停到这一小时结束。
// 以前第二层是所有账号共用一个计数，而且「用本地凭证恢复登录」也要过它：外面的人猜够 50 次，所有账号都登不上、
// cookie 丢了的设备也恢复不了。现在只锁被猜的那个账号的密码登录，凭证恢复只受 IP 那一层限制
const loginFails = new Map(); // ip -> { n, until }
const accountFails = new Map(); // 账号（不存在的账号名都记在 '?' 下）-> { n, since }

function ipBlocked(ip) {
  const f = loginFails.get(ip);
  return !!(f && f.until > Date.now());
}
function accountBlocked(name) {
  const f = accountFails.get(name);
  if (f && Date.now() - f.since > 3600e3) accountFails.delete(name);
  return (accountFails.get(name)?.n || 0) >= 50;
}
function recordFail(ip, account) {
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 8) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  loginFails.set(ip, f);
  if (account === undefined) return;
  const a = accountFails.get(account) || { n: 0, since: Date.now() };
  a.n++;
  accountFails.set(account, a);
}

// 首页：把内容的指纹写进页面（PAGE_BUILD），状态接口也带上当前指纹。一直开着的页面（手机 App 退到后台并不会退出）
// 首页、脚本和字体共同决定版本；异步缓存后台刷新，修改静态资源不需要重启服务。
// 自动维护（tools/maintain.cjs）出问题时写的提示，只给机主看
async function ownerNotice(u) {
  if (u.profile !== 'owner') return '';
  try { return (await fs.promises.readFile(path.join(ROOT, 'data', 'maintenance', 'notice.txt'), 'utf8')).trim().slice(0, 500); } catch { return ''; }
}
const pageShell = createPageShell({
  publicDir: PUBLIC_DIR, backgroundRefresh: true,
  assets: [...Object.values(VENDOR), path.join(PUBLIC_DIR, 'favicon.svg'), path.join(PUBLIC_DIR, 'manifest.webmanifest')],
  assetDirectories: [KATEX_FONTS, path.join(PUBLIC_DIR, 'icons'),
    ...['source-serif-4', 'inter', 'noto-serif-sc'].map(name => path.join(NM, '@fontsource', name))],
});
async function pageHtml() { return pageShell.get(); }

// ---------- HTTP 路由 ----------
function admitMaintenanceTask(req, res, continuingUpload = false) {
  if (maintenanceDrain.blocked() && !continuingUpload) {
    req.resume(); res.setHeader('Retry-After', '5');
    sendJSON(res, 503, { error: DRAIN_MESSAGE }); return false;
  }
  req[MAINTENANCE_REQUEST_DONE] = maintenanceDrain.trackRequest(res);
  return true;
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const page = await pageHtml();
    // 首页压一次存着（按页面版本），之后每次打开直接发压好的那份
    const encoding = acceptedEncoding(req);
    let body = page.body;
    if (encoding) { try { body = compressedCopy('page', page.build, page.body, encoding); } catch { body = page.body; } }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store',
      ...(body !== page.body ? { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } : {}) });
    return res.end(body);
  }
  // 手机安装页（不需要登录）、扫码用的二维码、iPhone 一键安装描述文件
  if (req.method === 'GET' && p === '/install') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'install.html')).pipe(res);
  }
  if (req.method === 'GET' && p === '/qr.svg') {
    const svg = await require('qrcode').toString(publicOrigin(req) + '/install', { type: 'svg', margin: 1, color: { dark: '#141413', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }
  if (req.method === 'GET' && p === '/claude.mobileconfig') {
    res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="Claude.mobileconfig"', 'Cache-Control': 'no-cache' });
    return res.end(webClipProfile(publicOrigin(req)));
  }
  // 「添加到主屏幕」需要的文件
  if (req.method === 'GET' && p === '/manifest.webmanifest') {
    return sendStaticFile(req, res, path.join(PUBLIC_DIR, 'manifest.webmanifest'), { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  if (req.method === 'GET' && p === '/sw.js') {
    return sendStaticFile(req, res, path.join(PUBLIC_DIR, 'sw.js'), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  }
  const iconMatch = req.method === 'GET' && p.match(/^\/icons\/([\w-]+\.png)$/);
  if (iconMatch) {
    const file = path.join(PUBLIC_DIR, 'icons', iconMatch[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && p === '/apple-touch-icon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'icons', 'apple-touch-icon.png')).pipe(res);
  }
  if (req.method === 'GET' && p === '/favicon.svg') {
    return sendStaticFile(req, res, path.join(PUBLIC_DIR, 'favicon.svg'), { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
  }
  let m;
  // 开源字体（按 unicode 范围切片，浏览器只下载用到的字）
  if (req.method === 'GET' && (m = p.match(/^\/vendor\/fs\/(source-serif-4|inter|noto-serif-sc)\/((?:files\/)?[\w.-]+\.(?:css|woff2|woff))$/))) {
    const file = path.join(NM, '@fontsource', m[1], m[2]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    return sendStaticFile(req, res, file, { 'Content-Type': m[2].endsWith('.css') ? 'text/css; charset=utf-8' : 'font/' + path.extname(file).slice(1), 'Cache-Control': 'max-age=2592000' });
  }
  if (req.method === 'GET' && (m = p.match(/^\/vendor\/(?:fonts\/([\w.-]+)|([\w.-]+))$/))) {
    const file = m[1] ? path.join(KATEX_FONTS, m[1]) : VENDOR[m[2]];
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    return sendStaticFile(req, res, file, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'max-age=604800' });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (ipBlocked(ip)) return sendJSON(res, 429, { error: '尝试次数太多了，过一会儿再试吧' });
    const { username, password } = await readJSON(req);
    const name = String(username || '').trim().toLowerCase();
    const bucket = USERS.has(name) ? name : '?';
    if (accountBlocked(bucket)) return sendJSON(res, 429, { error: '这个账号最近被试错了太多次，暂停一会儿，过一段时间再试吧' });
    // 新版网页带账号；老版网页（手机上缓存的旧页面）只带密码，就按密码找唯一对应的账号
    const u = name ? USERS.get(name) : [...USERS.values()].filter((x) => safeEqual(password || '', x.password))[0];
    if (!u || !safeEqual(password || '', u.password)) {
      recordFail(ip, bucket);
      console.log(`[登录失败] 账号 ${name || '(未填)'}，来自 ${ip}`);
      await new Promise((r) => setTimeout(r, 800));
      return sendJSON(res, 401, { error: '账号或密码不对' });
    }
    loginFails.delete(ip);
    console.log(`[登录成功] ${u.id}，来自 ${ip}，${shortUA(req)}`);
    setAuthCookie(req, res, u);
    // 凭证也交给网页存一份：微信等内置浏览器经常清掉 cookie，下次打开用它换回 cookie（/api/resume）
    return sendJSON(res, 200, { ok: true, token: userToken(u) });
  }

  // 用网页本地存的凭证恢复登录（cookie 丢了的时候）
  if (p === '/api/resume' && req.method === 'POST') {
    const ip = clientIp(req);
    if (ipBlocked(ip)) return sendJSON(res, 429, { error: '尝试次数太多了，过一会儿再试吧' });
    const { token } = await readJSON(req);
    const u = authUser({ headers: { cookie: 'relay_token=' + String(token || '').replace(/[;\s]/g, '') } });
    if (!u) { recordFail(ip); return sendJSON(res, 401, { error: '登录已失效，请重新登录' }); }
    setAuthCookie(req, res, u);
    return sendJSON(res, 200, { ok: true });
  }

  // 签名链接访问的文件（对话里的互动网页及其同目录资源），不需要 cookie
  if (req.method === 'GET' && (m = p.match(/^\/f\/([\w.-]+)\/(.+)$/))) {
    let parts;
    try { parts = m[2].split('/').map(decodeURIComponent); } catch { res.writeHead(400); return res.end(); }
    // 每一段都得是普通的名字：解码后藏着 / 或 \、是 . 或 ..、带冒号（盘符、NTFS 数据流）的一律不认，
    // 否则「outputs/..%2F..%2F.memory%2Fmemory.md」这种路径能通过下面的文件夹检查，再被解析到文件夹外面
    // 以 . 开头的（.memory、.claude、项目的 .project 等）是记忆和配置，不是互动网页的资源，也不放行
    if (parts.some((s) => !s || s.startsWith('.') || /[\\/:]/.test(s))) { res.writeHead(404); return res.end('Not found'); }
    const rel = parts.join('/');
    const owner = checkSigned(m[1], rel);
    const abs = owner && resolveIn(owner, rel);
    if (abs && !admitMaintenanceTask(req, res)) return;
    if (config.isolation?.enabled) {
      if (!abs) { res.writeHead(404); return res.end('Not found'); }
      try { return serveWorkFile(res, await isolation.snapshot(owner, rel), { filename: path.basename(abs) }); }
      catch { res.writeHead(404); return res.end('Not found'); }
    }
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end('Not found'); }
    return serveWorkFile(res, abs, {});
  }

  // 本机专用（定时巡检脚本用）：只接受本机直接访问，经过隧道来的请求一律当作不存在
  if (p.startsWith('/local/')) {
    if (!isLoopback(req.socket.remoteAddress) || req.headers['cf-connecting-ip']) { res.writeHead(404); return res.end('Not found'); }
    if (p === '/local/maintenance') {
      if (!localMaintenanceRequest(req)) { req.resume(); return sendJSON(res, 403, { error: '不允许的维护请求' }); }
      let body;
      try { body = JSON.parse((await readBody(req, 1024)) || '{}'); }
      catch { if (!res.destroyed) return sendJSON(res, 400, { error: '维护请求无效' }); return; }
      if (!body || !['begin', 'end'].includes(body.action) || !/^[a-f0-9]{64}$/.test(body.token || ''))
        return sendJSON(res, 400, { error: '维护请求无效' });
      const ok = body.action === 'begin' ? maintenanceDrain.begin(body.token) : maintenanceDrain.end(body.token);
      return sendJSON(res, ok ? 200 : 409, { ok, ...maintenanceDrain.status(jobs.size) });
    }
    if (p === '/local/power' && req.method === 'GET') return sendJSON(res, 200, { ...maintenanceDrain.status(jobs.size), idleMinutes: Math.round(idleMs() / 60e3), keepingAwake: !!awakeProc, stayAwake, stayAwakeSince, lastActivityAt: lastActivity,
      isolationBlocked: !!isolationBlocked, isolationReasons: isolationBlocked ? isolationBlocked.slice(0, 20) : [] });
    // 有人按了叫醒（sticky=1 表示保持清醒，直到下一次睡眠）
    if (p === '/local/touch' && req.method === 'POST') { lastActivity = Date.now(); if (url.searchParams.get('sticky') === '1') { stayAwake = true; stayAwakeSince = Date.now(); } updateKeepAwake(); return sendJSON(res, 200, { ok: true, stayAwake }); }
    // 巡检定时醒来、没人叫、马上要睡回去：清掉「一直开着」和最近活动，交还给系统
    if (p === '/local/sleeping' && req.method === 'POST') { stayAwake = false; lastActivity = 0; updateKeepAwake(); return sendJSON(res, 200, { ok: true }); }
    res.writeHead(404); return res.end('Not found');
  }

  if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
  // 网址带资源签名的先按签名认；签名过期/不对时再看 cookie、请求头（浏览器其实带着 cookie 时，旧链接照样能打开）
  const u = (url.searchParams.has('cap') && capabilityUser(req, url, USERS, userToken)) || authUser(req);
  if (!u) {
    if (p === '/api/state') console.log(`[未登录] /api/state，带 cookie：${!!req.headers.cookie}，带凭证头：${!!req.headers['x-relay-token']}，${shortUA(req)}`);
    return sendJSON(res, 401, { error: '请先登录' });
  }
  // A different tab can replace the shared cookie before its storage event is
  // delivered. Never apply the old page's operation to that newly logged-in user.
  if (req.headers['x-relay-user'] && req.headers['x-relay-user'] !== u.id) {
    return sendJSON(res, 409, { error: '账号已在其他窗口切换，请刷新后再操作' });
  }
  if (taskRequest(req.method, p)) {
    const continuingUpload = p === '/api/upload-part' && ['GET', 'PUT'].includes(req.method) &&
      maintenanceDrain.hasUpload(u.id, url.searchParams.get('id') || '');
    if (!admitMaintenanceTask(req, res, continuingUpload)) return;
  }
  res.setHeader('X-Auth-Via', req.authVia || 'cookie'); // 网页据此判断这个浏览器存不存得住 cookie
  // 有人在用网页：推迟睡眠（实时推送连接和额度轮询不算）
  if (p !== '/api/events' && p !== '/api/usage') { lastActivity = Date.now(); updateKeepAwake(); }

  // 验收没过：只留登录、看历史对话、改名和收藏、选模型这些不碰工作区的功能
  if (isolationBlocked && !(p === '/api/logout' || p === '/api/state' || p === '/api/usage' || p === '/api/events' || p === '/api/prefs' || p === '/api/projects' || p === '/api/search'
    || (/^\/api\/conversations\/[a-f0-9]{16}$/.test(p) && (req.method === 'GET' || req.method === 'PATCH')))) {
    req.resume();
    return sendJSON(res, 503, { error: blockedMessage(u) });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'relay_token=; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  // 搜索对话内容（侧边栏的搜索框原来只比对标题）。只读本账号的对话存档
  if (p === '/api/search' && req.method === 'GET') {
    if (searching.has(u.id)) return sendJSON(res, 429, { error: '上一次搜索还没完成' });
    searching.add(u.id);
    try {
      const found = await searchConversations(listConvs(u), url.searchParams.get('q'), { read: (id) => readSearchConv(u, id) });
      return sendJSON(res, found.error ? 400 : 200, found);
    } finally { searching.delete(u.id); }
  }

  if (p === '/api/state' && req.method === 'GET') {
    await freshEnoughSnap(u);
    // ?conv=<id>：网页打开时把上次看的对话一起带回去，省一次往返（对话不存在就是 null）
    const cid = url.searchParams.get('conv');
    const conv = cid ? loadConv(u, cid) : null;
    const serviceNotice = isolationBlocked ? blockedMessage(u) : await ownerNotice(u);
    if (conv && jobs.get(jobKey(u, conv.id))) jobs.get(jobKey(u, conv.id)).flush();
    return sendJSON(res, 200, {
      ...(cid ? { conversation: conv ? withFileUrls(u, conv) : null } : {}),
      conversations: listConvs(u), projects: listProjects(u), running: runningIds(u), userName: u.name, userId: u.id,
      // 类别让网页判断能不能关：受限（blocked）必须一直显示，机主的维护提示（maintenance）看过可以关
      ...(serviceNotice ? { serviceNotice, serviceNoticeKind: isolationBlocked ? 'blocked' : 'maintenance' } : {}),
      pageBuild: (await pageHtml()).build,
      models: modelsFor(u), fallbackModels: fallbackModelsFor(u), tools: toolsFor(u).map(({ prompt, ...t }) => t), defaultModel: config.defaultModel, defaultEffort: config.defaultEffort, defaultsVersion: config.defaultsVersion || 1, choice: savedChoice(u), usage,
      wakeToken: (config.wake && config.wake.token) || null,
      sessionToken: userToken(u), // 网页存一份，cookie 丢了时用 /api/resume 恢复（之前就登录着的设备也能补上）
    });
  }

  if (p === '/api/usage' && req.method === 'GET') {
    const age = Date.now() - (usage.updatedAt || 0);
    if (url.searchParams.get('refresh') === '1' && age > 30e3) await fetchUsage({ probe: true }); // 手动刷新：等结果
    else if (age > 2 * 60e3) fetchUsage({ probe: usageProbeDue() }).catch(() => {});                                        // 旧了：后台刷新，结果走 SSE 推送
    return sendJSON(res, 200, usage);
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'hello', running: runningIds(u) })}\n\n`);
    clients.set(res, u);
    const expires = req.authExpiresAt && setTimeout(() => { clients.delete(res); res.end(); }, Math.max(0, req.authExpiresAt - Date.now()));
    req.on('close', () => { clearTimeout(expires); clients.delete(res); });
    return;
  }

  if ((m = p.match(/^\/api\/conversations\/([a-f0-9]{16})$/))) {
    let conv = loadConv(u, m[1]);
    if (!conv) return sendJSON(res, 404, { error: '对话不存在' });
    if (req.method === 'GET') {
      if (jobs.get(jobKey(u, conv.id))) jobs.get(jobKey(u, conv.id)).flush(); // 攒着没推的文字先推出去，网页拿到的存档和之后的推送才接得上
      return sendJSON(res, 200, withFileUrls(u, conv));
    }
    if (req.method === 'DELETE') {
      if (jobs.has(jobKey(u, conv.id))) return sendJSON(res, 409, { error: '这个对话正在回复，先停止它' });
      removeConv(u, conv.id);
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const body = await readJSON(req);
      conv = loadConv(u, m[1]);
      if (!conv) return sendJSON(res, 404, { error: '对话不存在' });
      let choice;
      if (Object.hasOwn(body, 'model') || Object.hasOwn(body, 'effort')) {
        const selected = requestModelChoice(u, conv, body);
        if (selected.unavailable) return unavailableModel(res, selected.choice);
        choice = selected.choice; setConversationSelection(conv, choice);
      }
      if (typeof body.title === 'string' && body.title.trim()) { conv.title = body.title.trim().slice(0, 80); conv.renamed = true; }
      if (typeof body.starred === 'boolean') conv.starred = body.starred;
      // 对话属于哪个项目只在新建时定，之后不能移进/移出（10-31 起取消了这个功能：文件分散在两处，管理起来乱）。聊天 / 工作（mode）也一样，这里不认
      // 侧边栏里拖动后的位置（数字），null 表示回到按活动时间排
      if ('sortAt' in body) {
        if (body.sortAt === null) delete conv.sortAt;
        else if (Number.isFinite(body.sortAt) && body.sortAt > 0) conv.sortAt = Math.round(body.sortAt);
      }
      // 正在回复的对话：存档等这一轮结束时一起写，列表这边先改好，侧边栏马上就对
      if (!jobs.has(jobKey(u, conv.id))) saveConv(u, conv, false); else indexOf(u).set(conv.id, convMeta(conv, u));
      if (choice) broadcast({ type: 'conversation-choice', convId: conv.id, choice }, u);
      broadcast({ type: 'title', convId: conv.id, title: conv.title }, u);
      broadcast({ type: 'list' }, u); // 同一账号的其他设备刷新列表（排序、收藏变了）
      return sendJSON(res, 200, { ok: true, conversation: convMeta(conv, u), ...(choice ? { choice } : {}) });
    }
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJSON(req);
    let text = String(body.message || '').trim();
    const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
      .filter((a) => a && typeof a.path === 'string' && resolveIn(u, a.path))
      .map((a) => ({ path: a.path, name: String(a.name || path.basename(a.path)), size: +a.size || 0 }));
    if (!text && !attachments.length && body.action !== 'review') return sendJSON(res, 400, { error: '内容是空的' });
    let conv = body.conversationId ? loadConv(u, body.conversationId) : null;
    if (body.conversationId && !conv) return sendJSON(res, 404, { error: '对话不存在' });
    const selected = requestModelChoice(u, conv, body);
    if (selected.unavailable) return unavailableModel(res, selected.choice);
    const { model, effort } = selected.choice;
    const collaboration = collaborationRequest(conv, body, { providerOf, model });
    if (collaboration.error) return sendJSON(res, 400, { error: collaboration.error });
    if (collaboration.kind === 'review') text = REVIEW_PROMPT;
    const existingConversation = !!conv, initialChoiceRevision = conversationChoiceRevision(conv);
    if (conv && jobs.has(jobKey(u, conv.id))) return sendJSON(res, 409, { error: '这个对话还在回复中' });
    const mine = runningIds(u).length;
    if (mine >= config.maxPerUser) return sendJSON(res, 409, { error: `你同时进行的对话最多 ${config.maxPerUser} 个，等一个完成吧` });
    if (jobs.size >= config.maxConcurrent) return sendJSON(res, 409, { error: '电脑这会儿同时在回复好几个对话，等一个完成再发吧' });
    if (!conv) {
      await freshEnoughSnap(u);
      const newId = validId(body.newId) && !fs.existsSync(convPath(u, body.newId)) && !jobs.has(jobKey(u, body.newId)) ? body.newId : crypto.randomBytes(8).toString('hex');
      conv = { id: newId, title: (text || attachments[0].name).replace(/\s+/g, ' ').slice(0, 30), createdAt: Date.now(), sessionId: null, messages: [] };
      if (loadProject(u, body.projectId)) conv.projectId = body.projectId;
      // 聊天还是工作：只在这里定，之后不再变。网页带着用户选的；没带（旧页面）就看这条消息带没带文件夹、所在项目是不是建在文件夹上
      conv.mode = validMode(body.mode) || (linkedList(body.linked).length || projectHasFolders(u, conv.projectId) ? 'work' : 'chat');
    }
    // 只在换提供方时等待上一轮扫描与文字记录；等待后重读，不能用旧对象覆盖迟到文件或删除。
    let handoffFilesIncomplete = false;
    if (Number.isInteger(body.fromIndex) && conv.messages[body.fromIndex]?.role !== 'user') return sendJSON(res, 400, { error: '找不到要编辑的消息' });
    const retainedHistory = value => Number.isInteger(body.fromIndex) ? value.messages.slice(0, body.fromIndex) : value.messages;
    const previousAnswer = retainedHistory(conv).findLast(m => m.role === 'assistant');
    if (previousAnswer && providerOf(previousAnswer.model) !== providerOf(model)) {
      const settling = await modelFinalization.wait(u.id, conv.id, providerOf(model));
      const latest = loadConv(u, conv.id);
      if (!latest) return sendJSON(res, 404, { error: '对话已不存在，请重新打开' });
      conv = latest;
      handoffFilesIncomplete = settling.incomplete || !!retainedHistory(conv).findLast(m => m.role === 'assistant')?.filesIncomplete;
    }
    // 第一次在这个文件夹里发消息：先异步建好（不卡服务器）。等的时候可能有别的请求进来，所以再查一遍名额
    await ensureConvFolder(u, conv);
    if (existingConversation) {
      const latest = loadConv(u, conv.id);
      if (!latest) return sendJSON(res, 404, { error: '对话已不存在，请重新打开' });
      conv = latest;
    }
    if (jobs.has(jobKey(u, conv.id))) return sendJSON(res, 409, { error: '这个对话还在回复中' });
    if (runningIds(u).length >= config.maxPerUser) return sendJSON(res, 409, { error: `你同时进行的对话最多 ${config.maxPerUser} 个，等一个完成吧` });
    if (jobs.size >= config.maxConcurrent) return sendJSON(res, 409, { error: '电脑这会儿同时在回复好几个对话，等一个完成再发吧' });
    const confirmedCollaboration = collaborationRequest(conv, body, { providerOf, model });
    if (confirmedCollaboration.error) return sendJSON(res, 400, { error: confirmedCollaboration.error });
    // 已有的对话用它自己的 mode，这次请求里带的 mode 不理。老对话还没有：在截断（编辑、重试）之前按它原来的样子推断，
    // 存上（这一轮保存对话时一起写），之后就固定了
    const mode = conversationMode(u, conv);
    conv.mode = mode;
    // 旧对话可能还没有 model 字段；截断或复核之前先固定原来的选择。
    if (collaboration.preserveChoice && !conv.model) {
      const previousChoice = conversationSelection(conv) || defaultChoiceFor(u);
      Object.assign(conv, previousChoice);
    }
    let resumesInterrupted = false;
    // 编辑 / 重试：从第 fromIndex 条用户消息起截断，并回到那一轮之前的会话状态
    if (Number.isInteger(body.fromIndex)) {
      const target = conv.messages[body.fromIndex];
      if (!target || target.role !== 'user') return sendJSON(res, 400, { error: '找不到要编辑的消息' });
      conv.sessionId = target.sessionBefore || null;
      conv.codexThreadId = target.codexBefore || null;
      conv.messages = conv.messages.slice(0, body.fromIndex);
    } else if (body.continue) {
      const r = resumeSession(u, conv, model);
      if (!r) return sendJSON(res, 400, { error: '没有可以继续的回复' });
      if (providerOf(model) === 'openai') conv.codexThreadId = r.sid; else if (providerOf(model) === 'anthropic') conv.sessionId = r.sid;
      resumesInterrupted = r.resumesInterrupted;
    }
    delete conv.sortAt; // 又聊起来了：回到按活动时间排，出现在最上面
    const userMsg = { role: 'user', text, attachments, model, effort, time: Date.now(), sessionBefore: conv.sessionId, codexBefore: conv.codexThreadId || null };
    if (collaboration.kind === 'review') userMsg.action = 'review';
    if (collaboration.kind === 'retry') userMsg.retryWithModel = true;
    if (handoffFilesIncomplete) userMsg.handoffFilesIncomplete = true;
    if (body.continue && !Number.isInteger(body.fromIndex)) { userMsg.cont = true; userMsg.resumesInterrupted = resumesInterrupted; }
    if (toolById(u, body.tool)) userMsg.tool = body.tool;
    if (userTimeZone(body.tz)) userMsg.tz = body.tz; // 用户那边的时区，见 nowNote
    if (mode === 'work') { // 聊天的对话碰不到用户电脑上的文件：网页带来了文件夹、能请求访问的标记也不收
      if (linkedList(body.linked).length) userMsg.linked = linkedList(body.linked); // 桌面端关联的文件夹，见 buildPrompt
      if (body.canTrust === true) userMsg.canTrust = true; // 用户在桌面端里：模型可以请求访问用户电脑上别的位置，见 buildPrompt
    }
    // 本轮照请求执行；等待期间另一次明确选择决定后续对话，不能被旧发送覆盖。
    if (!collaboration.preserveChoice && conversationChoiceRevision(conv) === initialChoiceRevision && (conv.model !== model || conv.effort !== effort)) setConversationSelection(conv, { model, effort });
    conv.messages.push(userMsg);
    startJob(u, conv, userMsg);
    broadcast({ type: 'conversation-choice', convId: conv.id, choice: conversationSelection(conv) }, u);
    // 网页据此确认它乐观显示的消息和服务器一致，就不必再取一遍整段对话
    const last = conv.messages[conv.messages.length - 1];
    return sendJSON(res, 200, { conversationId: conv.id, msgIndex: conv.messages.length - 1, startedAt: last.startedAt, turnId: last.turnId, title: conv.title, mode: conv.mode, ...(last.handoff ? { handoff: last.handoff } : {}) });
  }

  if (p === '/api/projects') {
    if (req.method === 'GET') { await freshEnoughSnap(u); return sendJSON(res, 200, { projects: listProjects(u) }); }
    if (req.method === 'POST') {
      const body = await readJSON(req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return sendJSON(res, 400, { error: '给项目起个名字吧' });
      const proj = await createProject(u, { name, description: String(body.description || '').trim().slice(0, 300), linked: body.linked });
      console.log(`[项目] ${u.id} 新建「${name}」`);
      return sendJSON(res, 200, proj);
    }
  }
  if ((m = p.match(/^\/api\/projects\/([a-f0-9]{8})(\/files)?$/))) {
    await freshEnoughSnap(u);
    const proj = loadProject(u, m[1]);
    if (!proj) return sendJSON(res, 404, { error: '项目不存在' });
    if (m[2]) { // 删除一份项目资料
      if (req.method !== 'DELETE') return sendJSON(res, 405, { error: '不支持' });
      const abs = resolveIn(u, url.searchParams.get('path'));
      if (!abs || !abs.startsWith(projFilesDir(u, proj.id) + path.sep)) return sendJSON(res, 404, { error: '文件不存在' });
      if (config.isolation?.enabled) {
        const [st] = await workRows(u, [{ type: 'stat', path: toRel(u, abs) }]);
        if (!st?.ok) return sendJSON(res, 404, { error: '文件不存在' });
        await workAsync(u, [{ type: 'remove', path: toRel(u, abs), force: true }]);
        await refreshSnap(u);
      } else {
        if (!fs.existsSync(abs)) return sendJSON(res, 404, { error: '文件不存在' });
        fs.rmSync(abs, { force: true });
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      refreshSnap(u); // 先用缓存马上返回，后台刷新。上传资料和编辑时已经等刷新完了，这里看到的就是新的
      return sendJSON(res, 200, { project: loadProject(u, proj.id) || proj, memory: readProjMemory(u, proj.id), files: projectFiles(u, proj.id),
        conversations: listConvs(u).filter((c) => c.projectId === proj.id) });
    }
    if (req.method === 'PATCH') {
      const body = await readJSON(req);
      if (typeof body.name === 'string' && body.name.trim()) proj.name = body.name.trim().slice(0, 60);
      if (typeof body.description === 'string') proj.description = body.description.trim().slice(0, 300);
      if (typeof body.instructions === 'string') proj.instructions = body.instructions.slice(0, 20000);
      if (body.linked !== undefined) proj.linked = linkedList(body.linked); // 项目建在哪些文件夹上（空数组 = 一个都不带）
      if (typeof body.memory === 'string') {
        if (config.isolation?.enabled) await workAsync(u, [{ type: 'writeText', path: toRel(u, projMemoryFile(u, proj.id)), text: body.memory.slice(0, 20000), parents: true }]);
        else fs.writeFileSync(projMemoryFile(u, proj.id), body.memory.slice(0, 20000), 'utf8');
      }
      await saveProject(u, proj);
      await refreshSnap(u);
      return sendJSON(res, 200, { project: proj, memory: readProjMemory(u, proj.id) });
    }
    if (req.method === 'DELETE') {
      const convs = listConvs(u).filter((c) => c.projectId === proj.id);
      if (convs.some((c) => jobs.has(jobKey(u, c.id)))) return sendJSON(res, 409, { error: '项目里有对话正在回复，先停止它' });
      for (const c of convs) removeConv(u, c.id);
      removeLinkedCopies(u, linkedList(proj.linked).map((x) => x.id)); // 项目名下授权过的文件夹副本
      if (config.isolation?.enabled) {
        await workAsync(u, [{ type: 'remove', path: toRel(u, projDir(u, proj.id)), recursive: true, force: true }]);
        accountSnaps.get(u.id)?.projects.delete(proj.id);
        refreshSnap(u);
      }
      else fs.rmSync(projDir(u, proj.id), { recursive: true, force: true });
      console.log(`[项目] ${u.id} 删除「${proj.name}」及其 ${convs.length} 个对话`);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (p === '/api/prefs' && req.method === 'PUT') {
    const body = await readJSON(req);
    if (!modelsFor(u).some((m) => m.id === body.model) || !effortOk(body.model, body.effort)) return sendJSON(res, 400, { error: '模型或思考深度不对' });
    const choice = { model: body.model, effort: body.effort, dv: config.defaultsVersion || 1 };
    savePrefs(u, { ...loadPrefs(u), choice });
    broadcast({ type: 'choice', choice: { model: choice.model, effort: choice.effort } }, u); // 仅同步新对话默认值
    return sendJSON(res, 200, { ok: true, choice: { model: choice.model, effort: choice.effort } });
  }

  if (p === '/api/memory') {
    if (config.isolation?.enabled) {
      if (req.method === 'GET') {
        const rows = await workRows(u, [{ type: 'readText', path: '.memory/memory.md', maxBytes: 1024 * 1024 }, { type: 'list', path: '.memory/chats' }]);
        return sendJSON(res, 200, { enabled: memoryEnabled(u), text: rows[0]?.value || '', chats: rows[1]?.value?.length || 0 });
      }
      if (req.method === 'PUT') {
        const body = await readJSON(req);
        if (typeof body.enabled === 'boolean') savePrefs(u, { ...loadPrefs(u), memory: body.enabled });
        const operations = [];
        if (typeof body.text === 'string') operations.push({ type: 'writeText', path: '.memory/memory.md', text: body.text.slice(0, 20000), parents: true });
        if (body.clearChats) operations.push({ type: 'remove', path: '.memory/chats', recursive: true, force: true }, { type: 'mkdir', path: '.memory/chats' });
        if (operations.length) await workAsync(u, operations);
        await refreshSnap(u);
        return sendJSON(res, 200, { enabled: memoryEnabled(u), text: readMemory(u) });
      }
    }
    if (req.method === 'GET') return sendJSON(res, 200, { enabled: memoryEnabled(u), text: readMemory(u), chats: fs.readdirSync(u.chatsDir).length });
    if (req.method === 'PUT') {
      const body = await readJSON(req);
      if (typeof body.enabled === 'boolean') savePrefs(u, { ...loadPrefs(u), memory: body.enabled });
      if (typeof body.text === 'string') fs.writeFileSync(u.memoryFile, body.text.slice(0, 20000), 'utf8');
      if (body.clearChats) for (const f of fs.readdirSync(u.chatsDir)) fs.rmSync(path.join(u.chatsDir, f), { force: true });
      return sendJSON(res, 200, { enabled: memoryEnabled(u), text: readMemory(u) });
    }
  }

  if (p === '/api/stt' && req.method === 'POST') {
    if (config.isolation?.enabled) {
      const relative = '.work/voice/' + crypto.randomUUID() + '.audio';
      try {
        const { size } = await isolation.io.writeFromStream(isolation.context(u), relative, req, { limitBytes: 30e6, exclusive: true });
        if (size < 1000) throw new Error('没有录到声音');
        const { text } = await isolation.transcribe(u, relative);
        return sendJSON(res, 200, { text });
      } catch (e) {
        if (req.aborted || res.destroyed || e.code === 'UPLOAD_ABORTED') return;
        return sendJSON(res, e.statusCode || 500, { error: e.statusCode === 413 ? '录音太长了，分几段说吧' : e.message });
      } finally { await workRows(u, [{ type: 'remove', path: relative, force: true }]).catch(() => {}); }
    }
    // 浏览器录的音（webm/mp4/ogg），存到临时文件交给语音识别
    const tmp = path.join(os.tmpdir(), `stt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.audio`);
    try {
      const size = await receiveFile(req, tmp, 30e6);
      if (size < 1000) throw new Error('没有录到声音');
      const t0 = Date.now();
      const { text } = await voice({ op: 'stt', path: tmp }, 300e3);
      console.log(`[语音输入] ${(size / 1024).toFixed(0)} KB，${Date.now() - t0} ms，${text.length} 字符`);
      return sendJSON(res, 200, { text });
    } catch (e) {
      if (req.aborted || res.destroyed || e.code === 'UPLOAD_ABORTED') return;
      return sendJSON(res, e.statusCode || 500, { error: e.statusCode === 413 ? '录音太长了，分几段说吧' : e.message });
    }
    finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }

  if (p === '/api/voice-warm' && req.method === 'POST') {
    maintenanceDrain.background(() => config.isolation?.enabled ? isolation.voiceWarm(u) : voice({ op: 'ping' }, 120e3)).catch(() => {});
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/tts' && req.method === 'POST') {
    const body = await readJSON(req);
    const text = speakableText(body.text);
    if (!text) return sendJSON(res, 400, { error: '没有可以朗读的文字' });
    const voiceName = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(body.voice || '') ? body.voice : 'zh-CN-XiaoxiaoNeural';
    if (config.isolation?.enabled) {
      try {
        const { audio, contentType } = await isolation.synthesize(u, { text, voice: voiceName });
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
        return res.end(audio);
      } catch (e) { return sendJSON(res, 500, { error: '朗读失败：' + e.message }); }
    }
    const out = path.join(TTS_DIR, crypto.createHash('sha1').update(voiceName + text).digest('hex') + '.mp3');
    try {
      if (!fs.existsSync(out)) await voice({ op: 'tts', text, out, voice: voiceName }, 180e3);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(out).size, 'Cache-Control': 'no-store' });
      return fs.createReadStream(out).pipe(res);
    } catch (e) { return sendJSON(res, 500, { error: '朗读失败：' + e.message }); }
  }

  if (p === '/api/prewarm' && req.method === 'POST') {
    const body = await readJSON(req);
    const conv = body.conversationId ? loadConv(u, body.conversationId) : null;
    if (conv && jobs.has(jobKey(u, conv.id))) return sendJSON(res, 200, { ok: false });
    if (body.conversationId && !conv) return sendJSON(res, 404, { error: '对话不存在' });
    const selected = requestModelChoice(u, conv, body);
    if (selected.unavailable) return unavailableModel(res, selected.choice);
    const { model, effort } = selected.choice;
    const pid = conv ? conv.projectId : (loadProject(u, body.projectId) ? body.projectId : null);
    // fromIndex：用户点开了编辑/重试，要从那一轮之前的会话重新开始
    const target = conv && Number.isInteger(body.fromIndex) ? conv.messages[body.fromIndex] : null;
    if (providerOf(model) !== 'anthropic') return sendJSON(res, 200, { ok: false }); // GPT、Gemini 不预热：每轮按需启动
    const cont = conv && body.continue ? resumeSession(u, conv, model) : null;
    const sessionId = target && target.role === 'user' ? target.sessionBefore : cont ? cont.sid : conv ? conv.sessionId : null;
    prewarm(warmKey(u, sessionId, model, effort, pid));
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/preview' && req.method === 'GET') {
    const abs = resolveIn(u, url.searchParams.get('path'));
    if (config.isolation?.enabled) {
      if (!abs) return sendJSON(res, 404, { error: '文件不存在' });
      const relative = toRel(u, abs), ext = path.extname(abs).toLowerCase();
      try {
        if (ext === '.xlsx' || ext === '.xlsm') return sendJSON(res, 200, { html: await isolation.xlsxHtml(u, relative) });
        if (!PDF_PREVIEW_EXTS.has(ext) && ext !== '.docx') return sendJSON(res, 400, { error: '这种文件不支持预览' });
        const pdf = await isolation.toPdf(u, relative);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': fs.statSync(pdf).size, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs, ext) + '.pdf')}` });
        return pipeWorkFile(res, pdf);
      } catch (e) { return sendJSON(res, e.code === 'ENOENT' ? 404 : e.statusCode || 500, { error: e.message }); }
    }
    if (!abs || !fs.existsSync(abs)) return sendJSON(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    try {
      if (ext === '.xlsx' || ext === '.xlsm') return sendJSON(res, 200, { html: await xlsxHtml(abs) });
      if (!PDF_PREVIEW_EXTS.has(ext) && ext !== '.docx' && ext !== '.xlsx') return sendJSON(res, 400, { error: '这种文件不支持预览' });
      const pdf = await toPdf(abs);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': fs.statSync(pdf).size, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs, ext) + '.pdf')}` });
      return fs.createReadStream(pdf).pipe(res);
    } catch (e) { return sendJSON(res, e.statusCode || 500, { error: e.message }); }
  }

  if (p === '/api/stop' && req.method === 'POST') {
    const { conversationId } = await readJSON(req);
    const job = jobs.get(jobKey(u, conversationId));
    return sendJSON(res, 200, { stopped: !!job && job.user === u && stopJob(u, conversationId) });
  }

  if (p === '/api/files' && req.method === 'GET') {
    const titles = new Map(listConvs(u).map((c) => [c.id, c.title]));
    const pnames = new Map(listProjects(u).map((x) => [x.id, x.name]));
    const all = config.isolation?.enabled ? (await workAsync(u, [{ type: 'scan', path: '', max: 2000, skip: ['linked'] }]))[0] : walk(u, u.workDir, [], 0, { skip: new Set(['linked']) });
    const files = all.sort((a, b) => b.mtime - a.mtime).map((f) => {
      const [top, id] = f.path.split('/');
      if (top === 'chats' && validId(id)) return { ...f, group: 'c:' + id, label: titles.get(id) || '已删除的对话', base: `chats/${id}/` };
      if (top === 'projects' && validPid(id)) return { ...f, group: 'p:' + id, label: '项目 · ' + (pnames.get(id) || '已删除的项目'), base: `projects/${id}/` };
      return { ...f, group: 'other', label: '其他文件', base: '' };
    });
    return sendJSON(res, 200, { files });
  }

  if (p === '/api/file' && req.method === 'GET') {
    const abs = resolveIn(u, url.searchParams.get('path'));
    if (config.isolation?.enabled) {
      if (!abs) return sendJSON(res, 404, { error: '文件不存在' });
      try { return serveWorkFile(res, await isolation.snapshot(u, toRel(u, abs)), { raw: url.searchParams.get('raw') === '1', download: url.searchParams.get('download') === '1', filename: path.basename(abs) }); }
      catch { return sendJSON(res, 404, { error: '文件不存在' }); }
    }
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJSON(res, 404, { error: '文件不存在' });
    return serveWorkFile(res, abs, { raw: url.searchParams.get('raw') === '1', download: url.searchParams.get('download') === '1' });
  }

  if (p === '/api/sign' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    if (!resolveIn(u, rel)) return sendJSON(res, 400, { error: '路径不对' });
    return sendJSON(res, 200, { url: signedUrl(u, rel) });
  }

  // 分块上传（可续传）：大文件切成小块逐块发，每块到了就落盘。中途断了（用户切走了网页、网络断了、页面被关掉）
  // 回来后问一下已经收到多少（GET），从那里接着发（PUT ?offset=）。单个请求也就小于 Cloudflare 免费版 100MB 的上限
  if (p === '/api/upload-start' && req.method === 'POST') {
    const body = await readJSON(req);
    // 关联文件夹的大文件也走分块（一次性上传几十 MB，慢的线路上传到一半会被掐断，又得从头来）：linked = { id, path }
    const linked = body.linked ? (body.linked.path ? linkedRel(body.linked.id, body.linked.path) : null) : undefined;
    if (linked === null || (linked && !resolveIn(u, linked))) return sendJSON(res, 400, { error: '文件路径不对' });
    const dir = linked ? { dir: path.join(u.workDir, path.dirname(linked)) } : uploadDir(u, body.project, body.conv, body.to);
    if (dir.error) return sendJSON(res, dir.code, { error: dir.error });
    const size = Math.floor(+body.size);
    if (!(size >= 0)) return sendJSON(res, 400, { error: '文件大小不对' });
    if (size > (linked ? LINKED_FILE_LIMIT : UPLOAD_LIMIT)) return sendJSON(res, 413, { error: linked ? '文件太大（关联文件夹里单个文件上限 500MB）' : '文件太大（上限 500MB）' });
    const id = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(PART_DIR, { recursive: true });
    fs.writeFileSync(partPath(id) + '.json', JSON.stringify({ user: u.id, dir: dir.dir, name: linked ? path.basename(linked) : cleanName(body.name), size, createdAt: Date.now(), ...(linked ? { linked } : {}) }));
    fs.writeFileSync(partPath(id), '');
    maintenanceDrain.upload(u.id, id);
    return sendJSON(res, 200, { id, received: 0 });
  }
  if (p === '/api/upload-part') {
    const id = url.searchParams.get('id') || '';
    const receipt = validId(id) ? readPartReceipt(id) : null;
    if (receipt) {
      if (receipt.user !== u.id) return sendJSON(res, 404, { error: '这次上传已经失效，请重新选择文件' });
      if (req.method !== 'GET' && req.method !== 'PUT') return sendJSON(res, 405, { error: '不支持' });
      req.resume(); maintenanceDrain.completeUpload(u.id, id);
      return sendJSON(res, 200, receipt.result);
    }
    const meta = validId(id) ? readPartMeta(id) : null;
    if (!meta || meta.user !== u.id) return sendJSON(res, 404, { error: '这次上传已经失效，请重新选择文件' });
    if (['GET', 'PUT'].includes(req.method)) maintenanceDrain.upload(u.id, id);
    if (req.method === 'GET') return sendJSON(res, 200, { received: fs.statSync(partPath(id)).size, size: meta.size });
    if (req.method !== 'PUT') return sendJSON(res, 405, { error: '不支持' });
    // 同一个上传同时来了两块（同一台设备开着两个页面都在续传）：两块都对得上同一个位置，会被写两遍、拼坏文件。
    // 所以一次只收一块；后来的等前一块收完，再告诉它现在传到哪了
    if (partBusy.has(id)) {
      req.resume();
      await partBusy.get(id);
      const done = readPartReceipt(id);
      if (done && done.user === u.id) return sendJSON(res, 200, done.result);
      return sendJSON(res, 409, { received: fs.existsSync(partPath(id)) ? fs.statSync(partPath(id)).size : 0 });
    }
    const work = receivePart(u, id, meta, +url.searchParams.get('offset'), req, res);
    partBusy.set(id, work.catch(() => {}));
    try { return await work; } finally { partBusy.delete(id); }
  }

  // 关联文件夹的副本：列出（GET）、收一个文件（PUT，覆盖）、删除（POST /remove）。见上面的 linkedRel
  if (p === '/api/linked' && req.method === 'GET') {
    const base = linkedRel(url.searchParams.get('id'));
    if (!base) return sendJSON(res, 400, { error: '文件夹编号不对' });
    let rows = [];
    if (config.isolation?.enabled) {
      try { rows = (await workAsync(u, [{ type: 'scan', path: base, max: LINKED_MAX_FILES + 1, depth: 12 }]))[0]; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else rows = walk(u, path.join(u.workDir, base), [], 0, { max: LINKED_MAX_FILES });
    const truncated = rows.length > LINKED_MAX_FILES;
    return sendJSON(res, 200, { files: rows.slice(0, LINKED_MAX_FILES).map((x) => ({ path: x.path.slice(base.length + 1), size: x.size, mtime: x.mtime })), truncated });
  }
  if (p === '/api/linked' && req.method === 'PUT') {
    const sub = url.searchParams.get('path') || '', rel = sub ? linkedRel(url.searchParams.get('id'), sub) : null;
    if (!rel || !resolveIn(u, rel)) { req.resume(); return sendJSON(res, 400, { error: '文件路径不对' }); }
    const linkId = url.searchParams.get('id'), temp = historyTemp(u, linkId);
    try {
      const size = await receiveFile(req, temp, LINKED_FILE_LIMIT, { fd: fs.openSync(temp, 'wx') });
      // 回副本里这个文件现在的大小和时间（和 GET 列出来的一致）：网页拿到就能当场记下「这个已经同步好了」，
      // 不用等一批传完再问一次列表——中途刷新、关掉，下次从断的地方接着传。时间取不到时只回大小，网页退回老办法
      let mtime = 0;
      if (config.isolation?.enabled) {
        await isolation.io.writeFromStream(isolation.context(u), rel, fs.createReadStream(temp), { limitBytes: LINKED_FILE_LIMIT, exclusive: false });
        try { mtime = (await workRows(u, [{ type: 'stat', path: rel }]))[0]?.value?.mtime || 0; } catch {}
      } else {
        const abs = path.join(u.workDir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(temp, abs);
        try { mtime = fs.statSync(abs).mtimeMs; } catch {}
      }
      historyAdd(u, linkId, sub, { file: temp, by: 'user' }); // 在后台记一版，不让用户等
      return sendJSON(res, 200, mtime ? { size, mtime } : { size });
    } catch (e) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      if (!req.aborted && !res.destroyed && e.code !== 'UPLOAD_ABORTED') sendJSON(res, e.statusCode || 500, { error: e.statusCode === 413 ? '文件太大（关联文件夹里单个文件上限 500MB）' : '保存失败' });
      return;
    }
  }
  if (p === '/api/linked/remove' && req.method === 'POST') {
    const body = await readJSON(req), base = linkedRel(body.id), all = body.all === true;
    if (!base) return sendJSON(res, 400, { error: '文件夹编号不对' });
    const targets = all ? [base] : (Array.isArray(body.paths) ? body.paths : []).slice(0, LINKED_MAX_FILES).map((x) => (x ? linkedRel(body.id, x) : null)).filter(Boolean);
    if (config.isolation?.enabled) {
      for (let i = 0; i < targets.length; i += 200) await workAsync(u, targets.slice(i, i + 200).map((target) => ({ type: 'remove', path: target, recursive: all, force: true })));
    } else for (const target of targets) fs.rmSync(path.join(u.workDir, target), { recursive: all, force: true });
    if (!all) for (const target of targets) historyAdd(u, body.id, target.slice(base.length + 1), { deleted: true, by: 'user' });
    return sendJSON(res, 200, { removed: targets.length });
  }

  // 关联文件夹的版本历史：列出（GET /history）、取某一版的内容（GET /version）、恢复到某一版（POST /restore）
  if (p === '/api/linked/history' && req.method === 'GET') {
    const id = url.searchParams.get('id'), rel = url.searchParams.get('path') || '';
    if (!linkedRel(id) || (rel && !linkedRel(id, rel))) return sendJSON(res, 400, { error: '文件夹编号或路径不对' });
    const h = readHistory(u, id), limits = historyLimits();
    const show = (x, list) => ({ v: x.v, at: x.at, by: x.by, ...(x.model ? { model: x.model } : {}), ...(x.from ? { from: x.from } : {}), ...(x.deleted ? { deleted: true } : { size: x.size, sha: x.sha }), current: x === list[list.length - 1] });
    if (rel) { const list = h.files[rel] || []; return sendJSON(res, 200, { path: rel, versions: list.map((x) => show(x, list)).reverse() }); }
    const files = Object.entries(h.files).map(([file, list]) => ({ path: file, count: list.length, ...show(list[list.length - 1], list) })).sort((a, b) => b.at - a.at);
    return sendJSON(res, 200, { enabled: !!limits, files, bytes: h.bytes || 0, limits: limits && { perFile: limits.perFile, days: limits.days, folderBytes: limits.folderBytes } });
  }
  if (p === '/api/linked/version' && req.method === 'GET') {
    const id = url.searchParams.get('id'), rel = url.searchParams.get('path') || '';
    if (!rel || !linkedRel(id, rel)) return sendJSON(res, 400, { error: '文件夹编号或路径不对' });
    const entry = (readHistory(u, id).files[rel] || []).find((x) => x.v === +url.searchParams.get('v'));
    const object = entry && !entry.deleted && historyObject(u, id, entry.sha);
    if (!object || !fs.existsSync(object)) return sendJSON(res, 404, { error: '这个版本已经不在了' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(object).size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}` });
    return fs.createReadStream(object).on('error', (e) => res.destroy(e)).pipe(res);
  }
  if (p === '/api/linked/restore' && req.method === 'POST') {
    const body = await readJSON(req), rel = body.path ? linkedRel(body.id, body.path) : null;
    if (!rel || !resolveIn(u, rel)) return sendJSON(res, 400, { error: '文件夹编号或路径不对' });
    const entry = (readHistory(u, body.id).files[body.path] || []).find((x) => x.v === +body.v);
    const object = entry && !entry.deleted && historyObject(u, body.id, entry.sha);
    if (!object || !fs.existsSync(object)) return sendJSON(res, 404, { error: '这个版本已经不在了' });
    if (config.isolation?.enabled) await isolation.io.writeFromStream(isolation.context(u), rel, fs.createReadStream(object), { limitBytes: LINKED_FILE_LIMIT, exclusive: false });
    else { const abs = path.join(u.workDir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(object, abs); }
    await historyAdd(u, body.id, body.path, { sha: entry.sha, size: entry.size, by: 'restore', from: entry.v });
    console.log(`[版本历史] ${u.id} 把 ${rel} 恢复到第 ${entry.v} 版`);
    return sendJSON(res, 200, { ok: true, size: entry.size });
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const dirR = uploadDir(u, url.searchParams.get('project'), url.searchParams.get('conv'), url.searchParams.get('to'));
    if (dirR.error) return sendJSON(res, dirR.code, { error: dirR.error });
    if (config.isolation?.enabled) {
      try {
        const saved = await isolation.io.writeFromStream(isolation.context(u), toRel(u, path.join(dirR.dir, cleanName(url.searchParams.get('name')))), req,
          { limitBytes: UPLOAD_LIMIT, exclusive: true, uniqueName: true });
        if (saved.path.startsWith('projects/')) await refreshSnap(u);
        sendJSON(res, 200, { path: saved.path, name: path.basename(saved.path), size: saved.size });
        warmPreviews(u, [saved.path]);
      } catch (e) {
        if (!req.aborted && !res.destroyed && e.code !== 'UPLOAD_ABORTED') sendJSON(res, e.statusCode || 500, { error: e.statusCode === 413 ? '文件太大（上限 500MB）' : '保存失败' });
      }
      return;
    }
    fs.mkdirSync(dirR.dir, { recursive: true });
    const target = uniqueTarget(dirR.dir, cleanName(url.searchParams.get('name')));
    // Reserve synchronously and exclusively before awaiting any request bytes.
    // Concurrent uploads can then never truncate an existing same-name file.
    const fd = fs.openSync(target, 'wx');
    try {
      const size = await receiveFile(req, target, UPLOAD_LIMIT, { fd });
      console.log(`[上传] ${u.id}: ${toRel(u, target)} (${(size / 1024).toFixed(1)} KB)`);
      sendJSON(res, 200, { path: toRel(u, target), name: path.basename(target), size });
      warmPreviews(u, [toRel(u, target)]);
    } catch (e) {
      try { fs.rmSync(target, { force: true }); } catch {}
      if (!req.aborted && !res.destroyed && e.code !== 'UPLOAD_ABORTED') sendJSON(res, e.statusCode || 500, { error: e.statusCode === 413 ? '文件太大（上限 500MB）' : '保存失败' });
    }
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => { console.error(err); if (!res.headersSent) sendJSON(res, 500, { error: '服务器出错了，请稍后再试' }); })
    .finally(() => { req[MAINTENANCE_REQUEST_DONE]?.(); });
});

// ---------- 公网隧道 ----------
let tunnelProc = null;
function startTunnel() {
  const t = config.tunnel || {};
  if (!t.enabled || !t.name) return;
  const cfgFile = path.join(ROOT, 'cloudflared', 'config.yml');
  if (!fs.existsSync(cfgFile)) { console.log(' [公网] 未找到 cloudflared/config.yml，请先运行「设置公网访问.bat」'); return; }
  // TUNNEL_DNS_RESOLVER_ADDRS（= run 的 --dns-resolver-addrs）：那个解析器只给 Cloudflare「私有网络」功能用，
  // 本隧道用不到；写死地址后 cloudflared 就不会每 5 分钟去探测（探测查询会被 Clash 拦截而超时）。
  // 用环境变量而不是命令行参数：config.yml 里写不生效，而 D:\ClaudeRelayGuard 守护程序要求命令行保持「run <隧道ID>」原样。
  tunnelProc = spawn(t.cloudflaredPath || 'cloudflared', ['tunnel', '--config', cfgFile, '--protocol', 'http2', 'run', t.name],
    { windowsHide: true, env: { ...process.env, TUNNEL_DNS_RESOLVER_ADDRS: '1.1.1.1:53' } });
  let connected = false;
  tunnelProc.stderr.setEncoding('utf8');
  tunnelProc.stderr.on('data', (d) => {
    const s = d;
    if (!connected && /Registered tunnel connection/.test(s)) { connected = true; console.log(` [公网] 隧道已连接：https://${t.hostname}`); }
    if (/ERR/.test(s)) process.stdout.write(' [公网] ' + s.split('\n').filter((l) => /ERR/.test(l)).join('\n [公网] ') + '\n');
  });
  tunnelProc.on('error', (e) => console.log(' [公网] 启动 cloudflared 失败：' + e.message));
  tunnelProc.on('close', (code) => { console.log(` [公网] 隧道已退出（${code}），10 秒后重连`); tunnelProc = null; setTimeout(startTunnel, 10000); });
}
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
const cleanup = () => {
  transcriptBackfillStopped = true;
  const isolatedCleanup = config.isolation?.enabled ? isolation.closeAll() : undefined;
  try { if (JSON.parse(fs.readFileSync(PID_FILE, 'utf8')).pid === process.pid) fs.rmSync(PID_FILE); } catch {}
  if (tunnelProc) { tunnelProc.removeAllListeners('close'); tunnelProc.kill(); }
  for (const job of jobs.values()) stopJob(job.user, job.conv.id);
  for (const k of [...warmPool.keys()]) dropWarm(k);
  if (quickSpare) killQuick(quickSpare);
  if (voiceProc && voiceProc.exitCode === null) voiceProc.kill();
  return isolatedCleanup;
};
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
// 单个请求里的意外错误只记录，不让整个服务退出
process.on('uncaughtException', (err) => console.error(`[${new Date().toLocaleTimeString()}] 意外错误：`, err));
process.on('exit', cleanup);

if (!fs.existsSync(VENDOR['marked.js'])) {
  console.log('缺少依赖，请先在本文件夹运行：npm install');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`端口 ${config.port} 已被占用：服务可能已经在另一个窗口里运行了。`);
    process.exit(2); // 启动.bat / run-hidden.bat 看到退出码 2 就不再自动重启
  }
  throw err;
});

// 自动恢复和延迟启动都必须尊重机主的停止标记；手动 start 由 control.js 清除。
if (fs.existsSync(path.join(ROOT, 'data', 'stopped-by-owner'))) process.exit(2);
server.listen(config.port, config.host, () => {
  console.log('==============================================');
  console.log(' Claude 远程传输服务已启动');
  for (const x of USERS.values()) console.log(` 账号 ${x.id.padEnd(10)} ${x.profile === 'owner' ? '机主' : '    '}  工作文件夹: ${x.workDir}${x.lightweight ? '' : '（完整配置）'}`);
  console.log(' 密码在 config.json 的 users 里修改');
  if (config.tunnel && config.tunnel.enabled) console.log(` 公网地址:   https://${config.tunnel.hostname}`);
  console.log(` 本机地址:   http://localhost:${config.port}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !/^(192\.168|10\.|100\.)/.test(a.address)) continue;
      console.log(` ${a.address.startsWith('100.') ? 'Tailscale' : '局域网  '}:   http://${a.address}:${config.port}   (${name})`);
    }
  }
  for (const x of USERS.values()) if (config.tunnel && config.tunnel.enabled && x.password.length < 12) console.log(` ⚠ 已开启公网访问，建议把账号 ${x.id} 的密码改成 12 位以上`);
  console.log(`==============================================  [${new Date().toLocaleString()}]`);
  // control.js 靠这个文件找到服务；ppid 是外层的启动脚本，停止时连它一起结束，避免被自动重启
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, ppid: process.ppid, startedAt: Date.now() }));
  for (const x of USERS.values()) { try { markInterrupted(x); } catch (e) { console.log(' 检查中断的回复失败：' + e.message); } }
  // 补齐以前对话的文字版，方便 Claude 回忆
  if (!config.isolation?.enabled) for (const x of USERS.values()) for (const c of listConvs(x)) {
    if (!fs.existsSync(path.join(x.chatsDir, c.id + '.md'))) { try { writeChatTranscript(x, loadConv(x, c.id)); } catch {} }
  }
  cleanParts();
  try { ensureCodexLogin(); } catch (e) { console.log(' [GPT] ' + e.message); }
  startTunnel();
  // Existing histories can contain thousands of records. Let health checks and
  // requests run while bounded worker batches fill only the missing transcripts.
  if (config.isolation?.enabled && !isolationBlocked) {
    setImmediate(() => { if (!maintenanceDrain.blocked()) maintenanceDrain.background(() => backfillIsolatedTranscripts()).catch(() => {}); });
    for (const x of USERS.values()) refreshSnap(x); // 提前读好，第一个打开网页的人不用等
  }
});
