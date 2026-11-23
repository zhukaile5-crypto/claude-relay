'use strict';
// Executes the real server definitions/routes with synthetic files and a worker
// executor double. Host fs throws for every workspace path. No server listens,
// no native process/model runs, and no production configuration is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough, Writable, Readable } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const { createWorkspaceIO } = require('../isolation/workspace-io');
const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');

function fixture(t, options = {}) {
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
  const child = () => { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8'); p.input = ''; p.stdin.on('data', chunk => { p.input += chunk.toString('utf8'); }); p.exitCode = null; p.kill = () => {}; return p; };
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
    users: [{ id: 'alice', workDir: workspace, password: 'SYNTHETIC_PASSWORD' }], openaiApiKey: 'SYNTHETIC_NOT_A_KEY', gptUsers: ['alice'], ...options.config }));
  const context = vm.createContext({ __dirname: root, Buffer, URL, console: { log() {}, error() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    process: { platform: process.platform, execPath: process.execPath, env: { PATH: '', LOCALAPPDATA: root }, on() {}, stdout: { write() {} } },
    require(name) {
      if (name === './tools/model-finalization.cjs' && options.finalizationFactory) return { createFinalizationBarrier: options.finalizationFactory };
      if (name === 'fs') return hostFs;
      if (name === 'os') return { homedir: () => path.join(root, 'fake-home'), tmpdir: () => cache };
      if (name === './isolation') return { createIsolation: () => iso };
      if (name === './tools/check-isolation.cjs') return { check: () => ({ readyToEnableIsolation: true, remainingRequirements: [] }) };
      if (name === 'child_process') return { spawn: () => assert.fail('Native host spawn reached'), execFile: () => assert.fail('Native host exec reached') };
      return name.startsWith('./') ? require(path.resolve(__dirname, '..', name)) : require(name);
    },
  });
  vm.runInContext(source.slice(0, source.indexOf('const server = http.createServer')) + '\nupdateKeepAwake = () => {}; globalThis.api = { refreshSnap, handle, USERS, userToken, createProject, listProjects, projectPrompt, convFolder, scanTurn, writeChatTranscript, readMemory, promptVersion, launchClaude, launchCodex, spawnQuick, killQuick, fetchUsage, jobs, stopJob, warmPool, dropWarm, sessionFile, codexInstructions, modelFinalization, startJob, loadConv, saveConv };', context);
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
  return { api, route, user, io, ctx, root, workspace, calls, evaluate: code => vm.runInContext(code, context), context };
}


module.exports = { fixture };
