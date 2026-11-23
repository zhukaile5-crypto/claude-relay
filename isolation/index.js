'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const executor = require('./executor');
const { createWorkspaceIO } = require('./workspace-io');
const { createVoiceService } = require('./voice');
const { tools } = require('./mcp');
const boundedJobs = require('../bounded-jobs');

const SETTINGS = Object.freeze({ disableAllHooks: true, autoMemoryEnabled: false,
  disableClaudeAiConnectors: true, disableCommandPluginSources: true, disableWorkflows: true,
  syncClaudeAiSkills: false, syncClaudeAiPlugins: false,
  enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } });
const normalize = value => value.replace(/\\/g, '/');
const quote = value => JSON.stringify(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function systemEnv() {
  const result = {};
  const keep = new Set(['systemroot','windir','systemdrive','comspec','number_of_processors','processor_architecture']);
  for (const [name,value] of Object.entries(process.env)) if (keep.has(name.toLowerCase())) result[name] = value;
  return result;
}
function modelEnv() {
  const env = systemEnv();
  for (const name of ['USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']) {
    const value = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (value) env[name] = value;
  }
  env.PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Git\\cmd';
  return env;
}
function protectedDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Isolation directory must be a real directory');
  return fs.realpathSync.native(directory);
}
function filesystemPolicy(context, profile = 'relay') {
  // Read only this account's immutable view metadata, not the shared view base
  // or other accounts. The original physical workspace keeps its write grant.
  const grants = [...new Map([path.dirname(context.nodePath), path.dirname(context.desktopHost), ...context.runtime.readRoots,
    ...(context.executionRoot ? [path.dirname(context.executionRoot)] : [])]
    .map(p => normalize(path.resolve(p))).map(p => [p.toLowerCase(), p])).values()];
  return [
    'approval_policy = "never"', 'default_permissions = ' + quote(profile),
    '[windows]', 'sandbox = "mxc"',
    `[permissions.${profile}.filesystem]`, '":root" = "deny"', '":minimal" = "read"',
    ...grants.map(p => quote(normalize(p)) + ' = "read"'),
    quote(normalize(context.workspaceRoot)) + ' = "write"',
    ...(context.scratchRoot ? [quote(normalize(context.scratchRoot)) + ' = "write"'] : []),
    `[permissions.${profile}.network]`, 'enabled = false',
  ].join('\n');
}
function nativeModelSettings() {
  return ['suppress_unstable_features_warning = true', 'allow_login_shell = false',
    'project_doc_max_bytes = 0', 'web_search = "live"',
    '[analytics]', 'enabled = false', '[feedback]', 'enabled = false', '[agents]', 'enabled = false',
    '[features]', ...['shell_tool','view_image','apps','plugins','hooks','multi_agent','multi_agent_v2','shell_snapshot','memories','workspace_dependencies','computer_use','browser_use','image_generation','goals','sleep_tool','remote_plugin','skill_mcp_dependency_install'].map(key => key + ' = false'),
    'skip_host_skill_discovery = true', 'code_mode_only = true', 'code_mode_only_strict_3p_tools = true',
    '[features.code_mode]', 'enabled = true', 'excluded_tool_namespaces = ["functions", "collaboration", "clock"]',
  ].join('\n');
}

// Codex 0.166 ignores standalone profiles as well as config.toml when
// --ignore-user-config is present. Keep the existing HOME for session continuity,
// but accept only the known legacy service settings before loading our profile.
function validateCodexBaseConfig(home) {
  const file = path.join(home, 'config.toml');
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Unsupported GPT base configuration');
  const expected = new Map([
    ['approval_policy', '"never"'], ['sandbox_mode', '"workspace-write"'],
    ['model_reasoning_summary', '"detailed"'], ['windows.sandbox', '"unelevated"'],
    ['sandbox_workspace_write.network_access', 'true'],
  ]);
  const seen = new Set(), tables = new Set(); let table = '';
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const section = /^\[(windows|sandbox_workspace_write)\]\s*(?:#.*)?$/.exec(line);
    if (section) {
      table = section[1];
      if (tables.has(table)) throw Error('Unsupported GPT base configuration');
      tables.add(table); continue;
    }
    const setting = /^([a-z_]+)\s*=\s*("[a-z-]+"|'[a-z-]+'|true)\s*(?:#.*)?$/.exec(line);
    const key = setting && (table ? table + '.' : '') + setting[1];
    const value = setting && setting[2].replace(/^'([^']+)'$/, '"$1"');
    if (!key || seen.has(key) || expected.get(key) !== value) throw Error('Unsupported GPT base configuration');
    seen.add(key);
  }
  if ((seen.size || tables.size) && seen.size !== expected.size) throw Error('Unsupported GPT base configuration');
}

const CONVERT = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
const work=process.cwd(),source=path.resolve(work,input.file),rel=path.relative(work,source);
if(path.isAbsolute(rel)||rel.split(/[\\/]/).includes('..'))throw Error('Outside workspace');
const dir=path.join(process.env.TEMP,'pdf-'+input.id),profile=path.join(dir,'p');
if(profile.length>140||(process.env.TEMP||'').length>140)throw Error('PDF conversion requires a shorter workspace temporary path');
fs.mkdirSync(dir,{recursive:true});
try{
 const file=path.join(dir,'document'+path.extname(source));fs.copyFileSync(source,file);
 const out=path.join(dir,'out');fs.mkdirSync(out);
 const r=cp.spawnSync(input.libreOffice,['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to','pdf','--outdir',out,file],{cwd:dir,windowsHide:true,timeout:110000,maxBuffer:200000,encoding:'utf8'});
 if(r.status!==0||r.error)throw Error('PDF conversion failed: '+(r.error?.message||r.stderr||r.status));
 const pdf=fs.readFileSync(path.join(out,'document.pdf'));if(pdf.length<100||pdf.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF output');process.stdout.write(pdf);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
`;
const XLSX = String.raw`
const path=require('node:path'),cp=require('node:child_process');
const file=path.resolve(process.cwd(),input.file),rel=path.relative(process.cwd(),file);if(path.isAbsolute(rel)||rel.split(/[\\/]/).includes('..'))throw Error('Outside workspace');
const r=cp.spawnSync(input.python,['-X','utf8','-I','-S',input.script,file],{windowsHide:true,encoding:'utf8',timeout:40000,maxBuffer:8*1024*1024});if(r.status!==0||r.error)throw Error(r.stderr||r.error?.message||'Workbook preview failed');process.stdout.write(r.stdout);
`;

function createIsolation(config, root) {
  if (!config.isolation?.enabled) throw Error('Isolation is not enabled');
  const options = config.isolation;
  const manifestPath = options.runtimeManifest;
  if (!path.isAbsolute(manifestPath || '')) throw Error('A verified isolation runtime is required');
  const runtime = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const key of ['python','ffmpeg','whisperModel','desktopHost','nodePath','codexPath','libreOffice','xlsxScript']) {
    if (!path.isAbsolute(runtime[key] || '') || !fs.existsSync(runtime[key])) throw Error('Isolation runtime component missing: ' + key);
  }
  if (!Array.isArray(runtime.readRoots) || !runtime.readRoots.length || runtime.readRoots.some(p => !path.isAbsolute(p))) throw Error('Invalid isolation read roots');
  const claudePath = path.isAbsolute(config.claudePath || '') ? config.claudePath : runtime.claudePath;
  if (!path.isAbsolute(claudePath || '') || !fs.existsSync(claudePath)) throw Error('A verified absolute Claude executable is required');
  const codexPath = path.isAbsolute(config.codexPath || '') ? config.codexPath : runtime.codexPath;
  const privateRoot = protectedDirectory(options.privateRoot || path.join(root, 'data', 'isolation'));
  const gptHome = protectedDirectory(options.gptHome || path.join(root, 'data', 'codex-home'));
  // Gemini (Antigravity CLI) gets its own profile root: its history, schema cache and
  // settings stay apart from the owner's interactive agy. The login itself lives in the
  // Windows credential store, not in this directory.
  const agyPath = path.isAbsolute(config.agyPath || '') ? config.agyPath : null;
  const geminiHome = agyPath ? protectedDirectory(options.geminiHome || path.join(root, 'data', 'gemini-home')) : null;
  const gate = path.join(__dirname, 'gemini-gate.js');
  const active = new Set(), contexts = new Map(), snapshots = new Set();
  const previews = boundedJobs({ concurrency: 1, maxPending: 8 });
  const io = createWorkspaceIO(executor);
  const researchConfig = config.academicSearch ? path.join(root, 'mcp-servers.json') : undefined;
  const voice = createVoiceService({ executeNode: executor.executeNode, desktopHost: runtime.desktopHost, privateRoot: path.join(privateRoot, 'speech') });
  const configured = new Map((config.users || []).map(u => [u.id, path.resolve(u.workDir)]));

  function context(u) {
    if (!u || !/^[A-Za-z0-9_-]{1,80}$/.test(u.id) || configured.get(u.id)?.toLowerCase() !== path.resolve(u.workDir).toLowerCase()) throw Error('Unknown isolated account');
    if (contexts.has(u.id)) return contexts.get(u.id);
    const workspaceRoot = fs.realpathSync.native(u.workDir);
    if (workspaceRoot.toLowerCase() !== path.resolve(u.workDir).toLowerCase() || fs.lstatSync(u.workDir).isSymbolicLink()) throw Error('Workspace root cannot be redirected');
    // A fixed C: junction is only a process working-directory view. On this
    // Windows MXC runtime CreateProcess rejects D: cwd even when D: file I/O is
    // granted. Data and filesystem policy remain bound to the original root.
    const viewKey = crypto.createHash('sha256').update(JSON.stringify([path.resolve(root), u.id, workspaceRoot])).digest('hex').slice(0,20);
    // Avoid LocalAppData: a packaged desktop host may virtualize that spelling
    // into its MSIX LocalCache, which independent native children cannot resolve.
    const viewsRoot = protectedDirectory(path.join(os.homedir(), 'ClaudeRelayIsolation', 'w'));
    const viewParent = protectedDirectory(path.join(viewsRoot, viewKey));
    const executionRoot = path.join(viewParent, 'view');
    if (executionRoot.length > 105) throw Error('Execution view requires a shorter trusted path');
    try {
      const link = fs.lstatSync(executionRoot);
      if (!link.isSymbolicLink() || fs.realpathSync.native(executionRoot).toLowerCase() !== workspaceRoot.toLowerCase()) throw Error('Execution view cannot be redirected');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // An existing dangling junction is not silently repaired or replaced.
      try { fs.lstatSync(executionRoot); throw Error('Execution view target is unavailable'); } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      fs.symlinkSync(workspaceRoot, executionRoot, 'junction');
    }
    const scratchPath = path.join(os.homedir(), 'ClaudeRelayIsolation', 's', viewKey);
    const scratchRoot = protectedDirectory(scratchPath);
    if (scratchRoot.toLowerCase() !== path.resolve(scratchPath).toLowerCase() || scratchRoot.length > 95) throw Error('Scratch root must be a short physical directory');
    for (const work of configured.values()) {
      const candidate = fs.existsSync(work) ? fs.realpathSync.native(work) : path.resolve(work);
      const relative = path.relative(candidate, scratchRoot);
      if (!relative || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'))) throw Error('Scratch root cannot be inside an account workspace');
    }
    const controlRoot = protectedDirectory(path.join(privateRoot, u.id));
    const policyHome = protectedDirectory(path.join(controlRoot, 'worker-policy'));
    const harnessRoot = protectedDirectory(path.join(controlRoot, 'model'));
    const cacheRoot = protectedDirectory(path.join(controlRoot, 'cache'));
    // Recover only our own stale, random-named artifacts after an interrupted
    // service run. Normal responses release snapshots as their streams close.
    for (const name of fs.readdirSync(cacheRoot)) if (/^[a-f0-9-]{36}(?:\.[a-z0-9]{1,15})?$/i.test(name)) {
      const file = path.join(cacheRoot,name), stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && Date.now()-stat.mtimeMs>86400000) fs.rmSync(file,{force:true});
    }
    for (const p of [privateRoot, gptHome, ...(geminiHome ? [geminiHome] : []), ...runtime.readRoots]) {
      const r = path.relative(workspaceRoot, path.resolve(p));
      if (!r || (!path.isAbsolute(r) && !r.split(path.sep).includes('..'))) throw Error('Trusted runtime must be outside every user workspace');
    }
    // These directories contain no credentials; only the isolated worker can use
    // user-controlled contents within them. Native startup ignores profile scripts.
    const profile = path.join(scratchRoot, 'profile'), temp = path.join(scratchRoot, 'temp');
    const workerEnv = { ...systemEnv(), PATH: [...(runtime.pathDirs || []), path.dirname(runtime.nodePath), path.dirname(runtime.python), 'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';'),
      USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local'), TEMP: temp, TMP: temp,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1',
      NODE_PATH: runtime.nodeModules || '', NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HOME: path.join(profile, 'hf'),
      MPLBACKEND: 'Agg', MPLCONFIGDIR: path.join(profile, 'matplotlib'), SAL_USE_VCLPLUGIN: 'svp', SAL_DISABLESKIA: '1',
      RELAY_WORKSPACE: workspaceRoot, RELAY_EXECUTION_ROOT: executionRoot, RELAY_PYTHON: runtime.python, RELAY_RUNTIME: path.dirname(manifestPath),
    };
    const ctx = { workspaceRoot, workDir: workspaceRoot, executionRoot, scratchRoot, controlRoot, policyHome, harnessRoot, cacheRoot, workerEnv,
      runtime, codexPath: runtime.codexPath, nodePath: runtime.nodePath, desktopHost: runtime.desktopHost };
    fs.writeFileSync(path.join(policyHome, 'config.toml'), filesystemPolicy(ctx), 'utf8');
    contexts.set(u.id, ctx);
    try {
      // Bootstrap creates the private physical profile/temp inside the worker;
      // this first operation also initializes the persistent D: work directory.
      const results = io.batchSync(ctx, [{ type: 'mkdir', path: '.work' }]);
      for (const result of results) if (!result.ok) throw Error(result.error.message);
    } catch (error) { contexts.delete(u.id); throw error; }
    return ctx;
  }

  function launch(exe, args, ctx, env, runRoot, cleanup = () => {}, cwd = ctx.harnessRoot) {
    const launchFile = path.join(runRoot, 'launch.json');
    // The API secret travels only through the two process environments. The
    // launcher reads this one named variable from its parent; it is never
    // serialized into the launch request or any runtime/profile file.
    const storedEnv = { ...env }, launcherEnv = systemEnv(), inheritEnvKeys = [];
    if (Object.prototype.hasOwnProperty.call(storedEnv, 'CODEX_API_KEY')) {
      launcherEnv.CODEX_API_KEY = storedEnv.CODEX_API_KEY;
      delete storedEnv.CODEX_API_KEY;
      inheritEnvKeys.push('CODEX_API_KEY');
    }
    fs.writeFileSync(launchFile, JSON.stringify({ root: runRoot, desktop: 'RelayPrivate_Model_' + crypto.randomBytes(12).toString('hex'),
      jobName: 'Local\\RelayIsolation_' + crypto.randomUUID(), exe, args, cwd, env: storedEnv, inheritEnvKeys, stdio: true, timeoutMs: 2 * 60 * 60 * 1000 }), { flag: 'wx' });
    const child = cp.spawn(runtime.desktopHost, [launchFile], { cwd: ctx.harnessRoot, env: launcherEnv, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.on('error', () => {});
    const early = { out: [], err: [] }; let buffered = 0;
    const onOut = data => { buffered += data.length; if (buffered > 8 * 1024 * 1024) child.kill(); else early.out.push(data); };
    const onErr = data => { if (early.err.join('').length < 16000) early.err.push(data); };
    child.stdout.on('data', onOut); child.stderr.on('data', onErr);
    let closed = false, resolveClose;
    const close = new Promise(resolve => { resolveClose = resolve; });
    const handle = { child, attach(out, err) { child.stdout.off('data',onOut); child.stderr.off('data',onErr); early.out.forEach(out); early.err.forEach(err); early.out.length = 0; early.err.length = 0; child.stdout.on('data',out); child.stderr.on('data',err); },
      async cancel() { if (closed) return; try { child.kill(); } catch {} let timer; await Promise.race([close,new Promise(resolve => { timer=setTimeout(resolve,3000); })]);clearTimeout(timer); if (!closed) throw Error('Model process cleanup not confirmed'); } };
    active.add(handle);
    child.once('close', () => { closed = true; active.delete(handle); resolveClose(); try { cleanup(); } catch {} });
    return handle;
  }
  function prepare(u) {
    const ctx = context(u), runRoot = fs.mkdtempSync(path.join(ctx.controlRoot, 'model-run-'));
    const brokerFile = path.join(runRoot, 'broker.json');
    fs.writeFileSync(brokerFile, JSON.stringify({ context: ctx, researchConfig }));
    const broker = { command: runtime.nodePath, args: [path.join(__dirname,'mcp.js'),brokerFile], env: { ...systemEnv(), PATH: path.dirname(runtime.nodePath)+';C:\\Windows\\System32', USERPROFILE: runRoot, APPDATA: runRoot, LOCALAPPDATA: runRoot, TEMP: runRoot, TMP: runRoot } };
    return { ctx, runRoot, broker };
  }
  function claudeBase(model, enabledTools, mcp, stream = true) {
    return ['-p','--restricted','--tools',enabledTools ? 'WebSearch' : '', '--strict-mcp-config','--mcp-config',JSON.stringify(mcp),
      '--setting-sources','','--settings',JSON.stringify(SETTINGS),'--disable-slash-commands','--no-chrome',
      '--permission-mode','dontAsk','--permission-prompts','none','--model',model,
      ...(stream ? ['--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages'] : []),
      '--system-prompt-snapshot','off'];
  }
  function claudeEnvironment() { return { ...modelEnv(), CLAUDE_CODE_GIT_BASH_PATH: runtime.gitBash || 'C:\\Program Files\\Git\\bin\\bash.exe', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ENABLE_TOOL_SEARCH: 'false' }; }
  function launchClaude({ u, sessionId, model, effort, systemPrompt }) {
    if (sessionId && !uuid(sessionId)) throw Error('Invalid Claude session');
    const { ctx,runRoot,broker } = prepare(u);
    const mcp = { mcpServers: { relay: broker } };
    // The existing remote Consensus integration authenticates in the trusted
    // Claude process using its existing local account; no token enters workers.
    if (researchConfig) {
      const remote = JSON.parse(fs.readFileSync(researchConfig,'utf8')).mcpServers?.consensus;
      if (remote?.type === 'http' && remote.url === 'https://mcp.consensus.app/mcp' && !remote.headers) mcp.mcpServers.consensus = remote;
    }
    const promptFile = path.join(runRoot,'instructions.txt'); fs.writeFileSync(promptFile,systemPrompt || '', 'utf8');
    const allowed = ['WebSearch', ...tools.map(t=>'mcp__relay__'+t.name), ...(mcp.mcpServers.consensus ? ['mcp__consensus__*'] : [])];
    const args = [...claudeBase(model,true,mcp), '--allowedTools',allowed.join(','),'--effort',effort || 'medium','--append-system-prompt-file',promptFile];
    if (config.showThinking) args.push('--thinking-display','summarized');
    if (sessionId) args.push('--resume',sessionId,'--fork-session');
    return launch(claudePath,args,ctx,claudeEnvironment(),runRoot,()=>fs.rmSync(runRoot,{recursive:true,force:true}));
  }
  function snapshotSync(u, file) {
    const ctx = context(u), name = crypto.randomUUID() + path.extname(file).slice(0,16), dest = path.join(ctx.cacheRoot,name);
    const bytes = io.readBytesSync ? io.readBytesSync(ctx,file) : null;
    if (bytes) fs.writeFileSync(dest,bytes);
    else {
      const r = executor.executeNodeSync(ctx,"const fs=require('node:fs'),path=require('node:path');const p=path.resolve(process.cwd(),input.file),r=path.relative(process.cwd(),p);if(path.isAbsolute(r)||r.split(/[\\\\/]/).includes('..'))throw Error('Outside workspace');const s=fs.statSync(p);if(!s.isFile()||s.size>500*1024*1024)throw Error('File too large');process.stdout.write(fs.readFileSync(p));",{input:{file},maxOutputBytes:500*1024*1024});
      if (r.exitCode !== 0 || r.cancelled) throw Error(r.error || 'File snapshot failed'); fs.writeFileSync(dest,r.stdout);
    }
    snapshots.add(dest); return dest;
  }
  async function snapshot(u, file) { const ctx = context(u), dest = path.join(ctx.cacheRoot,crypto.randomUUID()+path.extname(file).slice(0,16)); await io.readToFile(ctx,file,dest); snapshots.add(dest); return dest; }
  function releaseSnapshot(file) {
    if (!snapshots.has(file)) return false;
    try { fs.rmSync(file,{force:true}); snapshots.delete(file); return true; } catch { return false; }
  }
  function launchCodex({ u, threadId, model, effort, instructions, attachments = [] }) {
    if (!config.openaiApiKey) throw Error('The existing GPT API is unavailable');
    if (threadId && !uuid(threadId)) throw Error('Invalid GPT session');
    validateCodexBaseConfig(gptHome);
    const { ctx,runRoot,broker } = prepare(u);
    const profileName = 'relay-'+crypto.randomBytes(12).toString('hex'), profileFile=path.join(gptHome,profileName+'.config.toml');
    const profile = [
      'developer_instructions = '+quote(instructions || ''), 'model_reasoning_summary = "detailed"',
      'approval_policy = "never"', 'default_permissions = "relay"',
      nativeModelSettings(), filesystemPolicy(ctx).split('\n').slice(2).join('\n'),
      '[mcp_servers.relay]', 'command = '+quote(broker.command), 'args = '+JSON.stringify(broker.args),
      'required = true','startup_timeout_sec = 30','tool_timeout_sec = 1800',
      'enabled_tools = '+JSON.stringify(tools.map(t=>t.name)),
      '[mcp_servers.relay.env]', ...Object.entries(broker.env).map(([k,v])=>quote(k)+' = '+quote(v)),
      ...tools.flatMap(t=>['[mcp_servers.relay.tools.'+t.name+']','approval_mode = "approve"']),
    ].join('\n');
    fs.writeFileSync(profileFile,profile,{flag:'wx'});
    const args=['exec','--json','--strict-config','--ignore-rules','--skip-git-repo-check','-p',profileName,'-m',model,'-c','model_reasoning_effort='+quote(effort||'medium'),'-C',ctx.harnessRoot];
    const images=[];
    for(const item of attachments)if(/\.(png|jpe?g|gif|webp)$/i.test(item.path)){const image=snapshotSync(u,item.path);images.push(image);args.push('-i',image);}
    if(threadId)args.push('fork',threadId);args.push('-');
    return launch(codexPath,args,ctx,{...modelEnv(),CODEX_HOME:gptHome,CODEX_API_KEY:config.openaiApiKey},runRoot,()=>{fs.rmSync(profileFile,{force:true});for(const file of images)releaseSnapshot(file);fs.rmSync(runRoot,{recursive:true,force:true});});
  }
  // Gemini through agy: the run folder carries a private workspace plugin that mounts
  // only the relay MCP server, a PreToolUse gate denying every other tool, and the
  // platform instructions as its rules. The folder sits outside any git repository so
  // agy discovers no other rules or customizations. agy cannot fork a conversation;
  // the service resumes one only while it still matches the chat.
  // Each account has its own agy profile under geminiHome: agy keeps cross-conversation
  // knowledge and summaries in its profile, so one shared profile could carry one
  // account's material into the other's conversations.
  function geminiAccountHome(u) {
    context(u); // validates the account id and workspace mapping
    return protectedDirectory(path.join(geminiHome, u.id));
  }
  function geminiConversationExists(u, conversationId) {
    if (!geminiHome || !uuid(conversationId)) return false;
    return fs.existsSync(path.join(geminiAccountHome(u), '.gemini', 'antigravity-cli', 'conversations', conversationId + '.db'));
  }
  // Before every run, the account's agy profile must hold no customizations of its own:
  // no installed plugins, MCP servers, hooks, skills or rules. Built-in plugins (such as
  // swarm) are switched off in config.json; only the per-run relay plugin is active.
  // Slash commands are disabled at launch, so a message cannot install anything here.
  function checkGeminiProfile(home) {
    const config = path.join(home, '.gemini', 'config');
    fs.mkdirSync(config, { recursive: true });
    const present = name => fs.existsSync(path.join(config, name));
    for (const name of ['hooks.json', 'skills.json', 'plugins.json', 'skills', 'rules', 'GEMINI.md', 'AGENTS.md'])
      if (present(name)) throw Error('Unexpected Gemini profile customization');
    if (present('plugins') && fs.readdirSync(path.join(config, 'plugins')).length) throw Error('Unexpected Gemini profile plugin');
    if (present('mcp_config.json')) {
      const text = fs.readFileSync(path.join(config, 'mcp_config.json'), 'utf8').trim();
      let servers = {};
      if (text) { try { servers = JSON.parse(text).mcpServers || {}; } catch { throw Error('Unreadable Gemini MCP configuration'); } }
      if (Object.keys(servers).length) throw Error('Unexpected Gemini MCP server');
    }
    const file = path.join(config, 'config.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw Error('Unreadable Gemini profile settings'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Unreadable Gemini profile settings');
    const plugins = settings.plugins && typeof settings.plugins === 'object' && !Array.isArray(settings.plugins) ? settings.plugins : {};
    const wanted = { ...plugins, swarm: { enabled: false } };
    for (const name of Object.keys(wanted)) if (name !== 'relay') wanted[name] = { ...(typeof wanted[name] === 'object' ? wanted[name] : {}), enabled: false };
    delete wanted.relay;
    if (JSON.stringify(wanted) !== JSON.stringify(plugins)) fs.writeFileSync(file, JSON.stringify({ ...settings, plugins: wanted }, null, 2));
  }
  // Run folders are removed when each run ends; ones left by a service crash are swept
  // once per service start (only our own r-* folders older than 12 hours).
  let geminiSwept = false;
  function sweepGeminiRuns(runsRoot) {
    if (geminiSwept) return; geminiSwept = true;
    try {
      for (const name of fs.readdirSync(runsRoot)) if (/^r-[A-Za-z0-9]{6}$/.test(name)) {
        const dir = path.join(runsRoot, name), stat = fs.lstatSync(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 12 * 3600 * 1000) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
  }
  function launchGemini({ u, conversationId, model, instructions }) {
    if (!agyPath || !fs.existsSync(agyPath)) throw Error('The Gemini runtime is unavailable');
    if (conversationId && !uuid(conversationId)) throw Error('Invalid Gemini session');
    if (typeof model !== 'string' || !/^gemini-[a-z0-9.-]{1,60}$/.test(model)) throw Error('Invalid Gemini model');
    const home = geminiAccountHome(u);
    checkGeminiProfile(home);
    const { ctx,runRoot,broker } = prepare(u);
    let workRoot = null;
    const cleanup = () => { if (workRoot) fs.rmSync(workRoot,{recursive:true,force:true}); fs.rmSync(runRoot,{recursive:true,force:true}); };
    try {
      const runsRoot = protectedDirectory(path.join(os.homedir(), 'ClaudeRelayIsolation', 'g'));
      for (const p of [runsRoot, home]) for (const work of configured.values()) {
        const r = path.relative(fs.existsSync(work) ? fs.realpathSync.native(work) : path.resolve(work), p);
        if (!r || (!path.isAbsolute(r) && !r.split(path.sep).includes('..'))) throw Error('Gemini runtime folders must be outside every user workspace');
      }
      sweepGeminiRuns(runsRoot);
      workRoot = fs.mkdtempSync(path.join(runsRoot, 'r-'));
      const plugin = path.join(workRoot, '.agents', 'plugins', 'relay');
      fs.mkdirSync(path.join(plugin, 'rules'), { recursive: true });
      const schemaRoot = path.join(home, '.gemini', 'antigravity-cli', 'mcp', 'relay_relay');
      fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ name: 'relay' }));
      fs.writeFileSync(path.join(plugin, 'mcp_config.json'), JSON.stringify({ mcpServers: { relay: { command: broker.command, args: broker.args, env: broker.env } } }));
      fs.writeFileSync(path.join(plugin, 'hooks.json'), JSON.stringify({ 'relay-gate': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command',
        command: [runtime.nodePath, gate, schemaRoot, path.join(home, 'gate-audit.jsonl')].map(p => { if (/["\r\n]/.test(p)) throw Error('Unsupported Gemini gate path'); return '"' + p + '"'; }).join(' '), timeout: 15 }] }] } }));
      fs.writeFileSync(path.join(plugin, 'rules', 'AGENTS.md'), instructions || '', 'utf8');
      for (const dir of ['Roaming', 'Local']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    } catch (error) { cleanup(); throw error; }
    // --disable-slash-commands: a message starting with "/" goes to the model as text, never
    // runs as an agy command (/plugin, /mcp ...) under the trusted service user.
    const args = ['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--dangerously-skip-permissions', '--disable-slash-commands'];
    if (conversationId) args.push('--conversation', conversationId);
    const env = { ...modelEnv(), USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'Roaming'),
      LOCALAPPDATA: path.join(home, 'Local'), AGY_CLI_DISABLE_AUTO_UPDATE: '1' };
    return launch(agyPath, args, ctx, env, runRoot, cleanup, workRoot);
  }
  function spawnText({model,usage=false}) {
    const harnessRoot=protectedDirectory(path.join(privateRoot,'text'));
    const runRoot=fs.mkdtempSync(path.join(harnessRoot,'run-'));
    // This path receives only the service's fixed /usage command. The switch
    // must stay on for title/translation prompts, which may contain user text.
    const args=[...claudeBase(model,false,{mcpServers:{}},!usage),'--no-session-persistence','--effort','low'].filter(arg=>!usage||arg!=='--disable-slash-commands');
    return launch(claudePath,args,{harnessRoot},claudeEnvironment(),runRoot,()=>fs.rmSync(runRoot,{recursive:true,force:true})).child;
  }
  function notes(u) {
    const ctx=context(u);return ['All file and program tools belong to this account: '+ctx.workspaceRoot+'. Use relay tools; PowerShell executes only inside this boundary.',
      'Program working directory: '+ctx.executionRoot+' (a protected view of the same files). Keep this default working directory for subprocesses; do not cd to the older D: spelling. File APIs can still read and write the original workspace paths.',
      'Temporary runtime profile and files: '+ctx.scratchRoot+'. Keep deliverables in the workspace; this account-only temporary area contains no service credentials.',
      'The worker cannot use the network directly. Use WebSearch, WebFetch (save_path for downloads), SearchPapers or VerifyReference. Never attempt desktop interaction.',
      'Use Windows PowerShell syntax for commands. Git Bash/MSYS is not supported in this Windows process container and is not offered as a tool; do not retry it, weaken isolation or copy Bash syntax unchanged into PowerShell. Python and Node programs remain available through PowerShell.',
      'PowerShell file limits in this runtime: cmdlets that inspect an existing workspace path (Test-Path, Get-Content, Get-Item, Get-ChildItem with a path, Set-Location, Copy-Item, Move-Item, Rename-Item, Remove-Item) report Access is denied even though the path is fine, and Add-Content or New-Item -Force can report it after actually succeeding. So that message does not by itself prove a failure: confirm the real result with the Read or Glob tool before telling the user something failed. Prefer the Read, Write, Edit, Glob and Grep tools for files. Inside PowerShell use Set-Content, Out-File or > to write, and [IO.File] / [IO.Directory] methods to read, check, copy, move, delete or create folders. The conversation folder and its uploads and outputs subfolders already exist; do not create them.',
      'Protected runtime: Python '+runtime.python+'; Node '+runtime.nodePath+'; LibreOffice '+runtime.libreOffice+'; FFmpeg '+runtime.ffmpeg+'.',
      ...Object.entries({GPU_Python:runtime.gpuPython,EVE_Python:runtime.evePython,...(runtime.tools||{})}).filter(([,v])=>v).map(([name,value])=>name+': '+value),
      'The protected paths above replace earlier .venv, .tools and Miniconda program paths, including older system notes and conversation history. Python and Node packages are configured in the worker environment; use these protected programs for commands.',
      'Use Python -X utf8 for Chinese console output and UTF-8 text files. The runtime paths remain read-only; write outputs in the account workspace.',
      'For LaTeX, read Skill latex-paper and run the protected compile_latex Python helper with workspace-relative --source, --project-root and --output paths. It handles Chinese paths, references and final PDF output. The older native latexmk/xelatex/biber launch commands are incompatible with this worker; do not use them or fall back to the host.',
      'Skill guides: '+Object.keys(runtime.skills||{}).join(', ')+'. Call Skill with a listed name. TaskCreate/TaskUpdate/TaskList/TaskGet drive the live checklist.',
    ].join('\n');
  }
  async function toPdf(u,file) {
    return previews('pdf:'+crypto.randomUUID(),async()=>{
      const ctx=context(u),r=await executor.executeNode(ctx,CONVERT,{input:{file,id:crypto.randomBytes(6).toString('hex'),libreOffice:runtime.libreOffice},timeoutMs:120000,maxOutputBytes:100*1024*1024});
      if(r.exitCode!==0||r.cancelled)throw Error(r.error||r.stderr||'PDF conversion failed');
      const dest=path.join(ctx.cacheRoot,crypto.randomUUID()+'.pdf');fs.writeFileSync(dest,r.stdout);snapshots.add(dest);return dest;
    });
  }
  async function xlsxHtml(u,file) { return previews('xlsx:'+u.id+':'+file,async()=>{const ctx=context(u),r=await executor.executeNode(ctx,XLSX,{input:{file,python:runtime.python,script:runtime.xlsxScript},timeoutMs:45000,maxOutputBytes:8*1024*1024});if(r.exitCode!==0||r.cancelled)throw Error(r.error||r.stderr||'Workbook preview failed');return r.stdout.toString('utf8');}); }
  return { context,io,launchClaude,launchCodex,launchGemini,geminiConversationExists,spawnText,notes,snapshot,snapshotSync,releaseSnapshot,toPdf,xlsxHtml,
    claudeSessionFile(u,sid){if(!uuid(sid))throw Error('Invalid session');return path.join(os.homedir(),'.claude','projects',context(u).harnessRoot.replace(/[^a-zA-Z0-9]/g,'-'),sid+'.jsonl');},
    async voiceWarm(u){context(u);}, transcribe(u,file){return voice.transcribe(context(u),{file});},synthesize(u,args){return voice.synthesize(context(u),args);},
    async closeAll(){await Promise.allSettled([...active].map(h=>h.cancel()));await executor.closeAll();for(const file of snapshots)releaseSnapshot(file);},
  };
}
module.exports = { createIsolation, filesystemPolicy, nativeModelSettings, validateCodexBaseConfig, systemEnv, modelEnv, SETTINGS };
