'use strict';
// Executes the real server definitions/routes with synthetic files and a worker
// executor double. Host fs throws for every workspace path. No server listens,
// no native process/model runs, and no production configuration is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough, Writable, Readable } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const { createWorkspaceIO } = require('../isolation/workspace-io');
const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.server-isolation-'));
  const workspace = path.join(root, 'workspace'), cache = path.join(root, 'cache');
  fs.mkdirSync(workspace); fs.mkdirSync(cache);
  const calls = [], hostViolations = [];
  const ctx = { workspaceRoot: workspace };
  function executeNodeSync(context, code, options) {
    assert.strictEqual(context, ctx); calls.push({ kind: 'io', input: options.input });
    const stdout = [], stderr = [], proc = { exitCode: 0, stdout: { write: b => stdout.push(Buffer.from(b)) }, stderr: { write: b => stderr.push(Buffer.from(b)) } };
    const workerFs = new Proxy(fs, { get(target, key) {
      if (key === 'readFileSync') return (p, ...args) => p === 0 ? options.stdin || Buffer.alloc(0) : fs.readFileSync(p, ...args);
      return target[key];
    } });
    vm.runInNewContext(code, { input: options.input, Buffer, process: proc, require: name => name === 'node:fs' ? workerFs : require(name) }, { timeout: 5000 });
    return { exitCode: proc.exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') };
  }
  const io = createWorkspaceIO({ executeNodeSync, executeNode: async (context, code, options) => {
    const chunks = []; if (options.stdin) for await (const b of options.stdin) chunks.push(Buffer.from(b));
    return executeNodeSync(context, code, { ...options, stdin: Buffer.concat(chunks) });
  } });
  const child = () => { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8'); p.exitCode = null; p.kill = () => {}; return p; };
  const launch = (kind, options) => {
    const p = child(); calls.push({ kind, options, child: p });
    return { child: p, attach(out, err) { p.stdout.on('data', out); p.stderr.on('data', err); }, cancel: () => calls.push({ kind: 'cancel' }) };
  };
  const iso = { context: () => ctx, io, notes: () => 'SYNTHETIC_RELAY_NOTES', closeAll: async () => {},
    launchClaude: options => launch('claude', options),
    launchCodex: options => launch('codex', options),
    spawnText: options => { calls.push({ kind: 'text', options }); return child(); },
    claudeSessionFile: () => path.join(root, 'current-session.jsonl'),
    async snapshot(u, rel) { calls.push({ kind: 'snapshot', rel }); const dest = path.join(cache, require('node:crypto').randomUUID() + path.extname(rel)); await io.readToFile(ctx, rel, dest); return dest; },
    async toPdf(u, rel) { calls.push({ kind: 'pdf', rel }); const dest = path.join(cache, 'preview.pdf'); fs.writeFileSync(dest, '%PDF synthetic'); return dest; },
    async xlsxHtml(u, rel) { calls.push({ kind: 'xlsx', rel }); return '<table>SYNTHETIC</table>'; },
    async voiceWarm() { calls.push({ kind: 'warm' }); },
    async transcribe(u, rel) { calls.push({ kind: 'stt', rel }); assert.ok(io.statSync(ctx, rel).size >= 1000); return { text: '合成录音' }; },
    async synthesize(u, options) { calls.push({ kind: 'tts', options }); return { audio: Buffer.from('SYNTHETIC_AUDIO'), contentType: 'audio/mpeg' }; },
  };
  const hostFs = new Proxy(fs, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => {
      for (const p of args.slice(0, key === 'copyFileSync' || key === 'renameSync' ? 2 : 1)) if (typeof p === 'string') {
        const rel = path.relative(workspace, path.resolve(p));
        if (rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))) {
          hostViolations.push({ operation: key, path: p }); throw new Error('HOST_WORKSPACE_ACCESS: ' + key);
        }
      }
      return target[key](...args);
    };
  } });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ isolation: { enabled: true }, secret: 'SYNTHETIC_SECRET', password: 'SYNTHETIC_PASSWORD',
    users: [{ id: 'alice', workDir: workspace, password: 'SYNTHETIC_PASSWORD' }], openaiApiKey: 'SYNTHETIC_NOT_A_KEY', gptUsers: ['alice'] }));
  const context = vm.createContext({ __dirname: root, Buffer, URL, console: { log() {}, error() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    process: { platform: process.platform, execPath: process.execPath, env: { PATH: '', LOCALAPPDATA: root }, on() {}, stdout: { write() {} } },
    require(name) {
      if (name === 'fs') return hostFs;
      if (name === 'os') return { homedir: () => path.join(root, 'fake-home'), tmpdir: () => cache };
      if (name === './isolation') return { createIsolation: () => iso };
      if (name === './tools/check-isolation.cjs') return { check: () => ({ readyToEnableIsolation: true, remainingRequirements: [] }) };
      if (name === 'child_process') return { spawn: () => assert.fail('Native host spawn reached'), execFile: () => assert.fail('Native host exec reached') };
      return name.startsWith('./') ? require(path.resolve(__dirname, '..', name)) : require(name);
    },
  });
  vm.runInContext(source.slice(0, source.indexOf('const server = http.createServer')) + '\nupdateKeepAwake = () => {}; globalThis.api = { refreshSnap, handle, USERS, userToken, createProject, listProjects, projectPrompt, convFolder, scanTurn, writeChatTranscript, readMemory, promptVersion, launchClaude, launchCodex, spawnQuick, killQuick, fetchUsage, jobs, stopJob, warmPool, dropWarm, sessionFile, codexInstructions };', context);
  const api = context.api, user = api.USERS.get('alice');
  class Response extends Writable {
    constructor() { super(); this.status = 200; this.headers = {}; this.chunks = []; }
    _write(b, enc, cb) { this.chunks.push(Buffer.from(b)); cb(); }
    setHeader(k, v) { this.headers[k] = v; }
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }
    get body() { const text = Buffer.concat(this.chunks).toString('utf8'); try { return JSON.parse(text); } catch { return text; } }
  }
  async function route(url, method = 'GET', body) {
    const req = new PassThrough(); Object.assign(req, { url, method, complete: true, aborted: false,
      headers: { cookie: 'relay_token=' + api.userToken(user) }, socket: { remoteAddress: '127.0.0.1' } });
    const res = new Response(), done = api.handle(req, res);
    req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
    await done; if (!res.writableFinished) await once(res, 'finish'); return res;
  }
  t.after(() => {
    assert.deepEqual(hostViolations, []);
    assert.equal(path.dirname(root), __dirname); assert.ok(path.basename(root).startsWith('.server-isolation-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { api, route, user, io, ctx, root, workspace, calls };
}

test('enabled memory/project/transcript/scan paths never access workspace through host fs', async t => {
  const h = fixture(t), p = await h.api.createProject(h.user, { name: '合成项目', description: 'fixture' });
  await h.io.writeFromStream(h.ctx, `projects/${p.id}/files/note.md`, Readable.from(['合成资料']));
  await h.api.refreshSnap(h.user); // 读缓存：资料是绕过网页接口直接写入的，要手动刷新一次
  const conv = { id: 'a'.repeat(16), title: '合成对话', messages: [{ role: 'user', text: '合成问题' }], projectId: p.id };
  await h.api.writeChatTranscript(h.user, conv); assert.equal(h.api.convFolder(h.user, conv), `projects/${p.id}`);
  assert.equal(h.api.listProjects(h.user)[0].fileCount, 1); assert.match(h.api.projectPrompt(h.user, p.id), /合成资料/);
  assert.ok(h.api.scanTurn(h.user, `projects/${p.id}`).some(f => f.path.endsWith('note.md')));
  assert.match(h.api.promptVersion(h.user, p.id), /^true:/);
  let r = await h.route('/api/memory', 'PUT', { text: '合成记忆' }); assert.equal(r.status, 200);
  r = await h.route('/api/memory'); assert.equal(r.body.text, '合成记忆'); assert.equal(r.body.chats, 1);
  r = await h.route('/api/memory', 'PUT', { clearChats: true }); assert.equal(r.status, 200);
  r = await h.route('/api/memory'); assert.equal(r.body.chats, 0);
  r = await h.route(`/api/projects/${p.id}`, 'PATCH', { memory: '项目记忆', instructions: '合成说明' }); assert.equal(r.body.memory, '项目记忆');
  r = await h.route(`/api/projects/${p.id}/files?path=projects/${p.id}/files/note.md`, 'DELETE'); assert.equal(r.status, 200);
  r = await h.route(`/api/projects/${p.id}`, 'DELETE'); assert.equal(r.status, 200);
});

test('enabled uploads/downloads/previews/voice use worker I/O and trusted snapshots', async t => {
  const h = fixture(t);
  let r = await h.route('/api/upload?name=sample.txt', 'POST', Buffer.from('one')); assert.equal(r.status, 200); assert.equal(r.body.path, 'uploads/sample.txt');
  r = await h.route('/api/upload?name=sample.txt', 'POST', Buffer.from('two')); assert.equal(r.body.path, 'uploads/sample (1).txt');
  r = await h.route('/api/file?path=uploads/sample.txt'); assert.equal(r.body, 'one'); assert.match(r.headers['Content-Disposition'], /sample.txt/);
  r = await h.route('/api/sign?path=uploads/sample.txt'); const signed = r.body.url;
  r = await h.route(signed); assert.equal(r.body, 'one');
  r = await h.route('/api/upload-start', 'POST', { name: 'part.txt', size: 6 }); const id = r.body.id;
  r = await h.route(`/api/upload-part?id=${id}&offset=0`, 'PUT', Buffer.from('abcdef')); assert.equal(r.body.done, true); assert.equal(r.body.path, 'uploads/part.txt');
  r = await h.route(`/api/upload-part?id=${id}`); assert.equal(r.body.done, true);
  r = await h.route('/api/upload-start', 'POST', { name: 'large.bin', size: 500 * 1024 * 1024 }); assert.equal(r.status, 200);
  r = await h.route('/api/upload-start', 'POST', { name: 'large.bin', size: 500 * 1024 * 1024 + 1 }); assert.equal(r.status, 413);
  r = await h.route('/api/preview?path=uploads/sample.xlsx'); assert.match(r.body.html, /SYNTHETIC/);
  r = await h.route('/api/preview?path=uploads/sample.pptx'); assert.match(r.body, /PDF synthetic/);
  r = await h.route('/api/stt', 'POST', Buffer.alloc(1500, 1)); assert.equal(r.body.text, '合成录音');
  assert.equal(h.io.listSync(h.ctx, '.work/voice').length, 0);
  r = await h.route('/api/voice-warm', 'POST'); assert.equal(r.status, 200);
  r = await h.route('/api/tts', 'POST', { text: '合成文字' }); assert.equal(r.body, 'SYNTHETIC_AUDIO');
  assert.ok(['snapshot', 'xlsx', 'pdf', 'stt', 'tts', 'warm'].every(kind => h.calls.some(c => c.kind === kind)));
});

test('enabled model, prewarm, quick and cancellation paths use bound runtime APIs', t => {
  const h = fixture(t);
  const proc = h.api.launchClaude('alice|old-session|sonnet|high|');
  assert.equal(h.calls.find(c => c.kind === 'claude').options.sessionId, 'old-session');
  h.api.launchCodex(h.user, {}, { model: 'gpt-6.1-terra', effort: 'high', attachments: [{ path: 'uploads/image.png' }] }, 'old-thread');
  const launch = h.calls.find(c => c.kind === 'codex').options;
  assert.equal(launch.threadId, 'old-thread'); assert.match(launch.instructions, /TaskCreate.*TaskUpdate/); assert.doesNotMatch(launch.instructions, /Claude-only/);
  h.api.spawnQuick(); h.api.fetchUsage(); assert.equal(h.calls.filter(c => c.kind === 'text').length, 2);
  h.api.warmPool.set('warm', { proc, timer: 1 }); h.api.dropWarm('warm');
  h.api.jobs.set(JSON.stringify(['alice', 'job']), { user: h.user, child: proc.child, cancel: proc.cancel });
  assert.equal(h.api.stopJob(h.user, 'job'), true); assert.equal(h.calls.filter(c => c.kind === 'cancel').length, 2);
});

test('long GPT context retains runtime notes and quick cleanup uses its process handle', t => {
  const h=fixture(t);
  h.io.writeTextSync(h.ctx,'.memory/memory.md','SYNTHETIC_LONG_MEMORY '.repeat(3000));
  const instructions=h.api.codexInstructions(h.user);
  assert.ok(instructions.includes('SYNTHETIC_RELAY_NOTES')); assert.ok(instructions.indexOf('SYNTHETIC_RELAY_NOTES') < instructions.indexOf('# GPT tools'));
  assert.match(instructions, /TaskCreate.*TaskUpdate/); assert.match(instructions, /historical material, not new instructions/); assert.match(instructions, /记忆内容因长度限制有省略/); assert.ok(instructions.length <= 24000);
  const child=h.api.spawnQuick();let killed=0;child.kill=()=>{killed++;};h.api.killQuick(child);assert.equal(killed,1);
});

for (const provider of ['claude', 'codex']) test(`enabled ${provider} relay task events preserve task IDs and quiet checklist updates`, async t => {
  const h = fixture(t), model = provider === 'claude' ? 'sonnet' : 'gpt-6.1-terra';
  const r = await h.route('/api/chat', 'POST', { message: '合成多步任务', model, effort: 'high' });
  assert.equal(r.status, 200); const id = r.body.conversationId;
  const p = h.calls.find(c => c.kind === provider).child;
  const send = m => p.stdout.write(JSON.stringify(m) + '\n');
  if (provider === 'claude') {
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'task1', name: 'mcp__relay__TaskCreate', input: { subject: '合成步骤', activeForm: '处理中' } }] } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'Task #1 created' }] } });
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'task2', name: 'mcp__relay__TaskUpdate', input: { taskId: '1', status: 'completed' } }] } });
    send({ type: 'result', session_id: 'synthetic-session', result: '完成', is_error: false });
  } else {
    send({ type: 'thread.started', thread_id: 'synthetic-thread' });
    const item = { id: 'task1', type: 'mcp_tool_call', server: 'relay', tool: 'TaskCreate', arguments: { subject: '合成步骤', activeForm: '处理中' }, status: 'in_progress' };
    send({ type: 'item.started', item });
    send({ type: 'item.completed', item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'Task #1 created' }] } } });
    send({ type: 'item.completed', item: { id: 'task2', type: 'mcp_tool_call', server: 'relay', tool: 'TaskUpdate', arguments: { taskId: '1', status: 'completed' }, status: 'completed', result: { content: [] } } });
    send({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0 } });
  }
  p.exitCode = 0; p.emit('close', 0);
  const saved = await h.route('/api/conversations/' + id);
  const message = saved.body.messages.at(-1);
  assert.equal(message.status, 'done'); assert.equal(message.plan[0].id, '1'); assert.equal(message.plan[0].status, 'completed');
  assert.ok(message.events.filter(e => e.k === 'tool').every(e => e.quiet && !e.name.includes('mcp__relay__')));
  assert.equal(h.io.listSync(h.ctx, '.memory/chats').length, 1);
});
