'use strict';

// All argv, policy locations and launch settings originate in the trusted relay.
// Untrusted program text is evaluated only by Node inside the OS boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const MAX_HEADER = 2 * 1024 * 1024;
const active = new Set();

function checkContext(context) {
  for (const key of ['workspaceRoot', 'controlRoot', 'policyHome', 'codexPath', 'nodePath', 'desktopHost']) {
    if (typeof context?.[key] !== 'string' || !path.isAbsolute(context[key])) throw new Error('Invalid execution context: ' + key);
  }
  if (context.executionRoot !== undefined && (typeof context.executionRoot !== 'string' || !path.isAbsolute(context.executionRoot))) throw new Error('Invalid execution root');
  if (context.scratchRoot !== undefined && (typeof context.scratchRoot !== 'string' || !path.isAbsolute(context.scratchRoot))) throw new Error('Invalid scratch root');
  if (!context.workerEnv || typeof context.workerEnv !== 'object') throw new Error('Missing worker environment');
}

function bootstrap(desktopHost, desktop, workspaceRoot, executionRoot, scratchRoot, nonce, workerEnv) {
  return `const fs=require('node:fs'),cp=require('node:child_process');
const check=cp.spawnSync(${JSON.stringify(desktopHost)},['--check-desktop',${JSON.stringify(desktop)}],{windowsHide:true,encoding:'utf8',timeout:5000});
if(check.status!==0)throw Error('Non-interactive desktop was not established');
const expectedRoot=${JSON.stringify(workspaceRoot)};
const executionRoot=${JSON.stringify(executionRoot)};
if(fs.realpathSync.native(executionRoot).toLowerCase()!==expectedRoot.toLowerCase())throw Error('Execution root no longer matches the bound workspace');
if(process.cwd().toLowerCase()!==executionRoot.toLowerCase())process.chdir(executionRoot);
if(fs.realpathSync.native(process.cwd()).toLowerCase()!==expectedRoot.toLowerCase())throw Error('Execution working directory changed');
const scratchRoot=${JSON.stringify(scratchRoot || null)};
if(scratchRoot){const st=fs.lstatSync(scratchRoot);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync.native(scratchRoot).toLowerCase()!==scratchRoot.toLowerCase())throw Error('Scratch root is no longer a physical account directory');}
for(const [key,value] of Object.entries(${JSON.stringify(workerEnv)}))process.env[key]=value;
for(const key of ['TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'])if(process.env[key])fs.mkdirSync(process.env[key],{recursive:true});
process.stderr.write(${JSON.stringify(nonce + '\n')});
function exact(n){const b=Buffer.alloc(n);let p=0;while(p<n){const k=fs.readSync(0,b,p,n-p,null);if(!k)throw Error('Truncated input');p+=k;}return b;}
const length=exact(4).readUInt32BE(0);if(length>${MAX_HEADER})throw Error('Input header too large');
const request=JSON.parse(exact(length).toString('utf8'));globalThis.input=request.input;
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
Promise.resolve(new AsyncFunction('require','input',request.code)(require,request.input)).catch(e=>{process.stderr.write(String(e.stack||e)+'\\n');process.exitCode=1;});`;
}

function startNode(context, code, options = {}) {
  checkContext(context);
  if (typeof code !== 'string') throw new TypeError('Program must be a string');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 60000, 500), 1800000);
  const maxOutputBytes = Math.min(options.maxOutputBytes || 8 * 1024 * 1024, 600 * 1024 * 1024);
  const header = Buffer.from(JSON.stringify({ code, input: options.input ?? null }), 'utf8');
  if (header.length > MAX_HEADER) throw new Error('Execution request too large');
  const headerSize = Buffer.alloc(4); headerSize.writeUInt32BE(header.length);
  const runId = crypto.randomUUID();
  const runDir = fs.mkdtempSync(path.join(context.controlRoot, 'run-'));
  const desktop = 'RelayPrivate_' + crypto.randomBytes(12).toString('hex');
  const jobName = 'Local\\RelayIsolation_' + crypto.randomBytes(16).toString('hex');
  const guardNonce = crypto.randomBytes(24).toString('hex');
  const launchFile = path.join(runDir, 'launch.json');
  const environment = { ...context.workerEnv, CODEX_HOME: context.policyHome };
  fs.writeFileSync(launchFile, JSON.stringify({ root: runDir, desktop, jobName,
    exe: context.codexPath, args: ['-c', 'windows.sandbox=mxc', 'app-server', '--listen', 'stdio://'],
    cwd: context.controlRoot, env: environment, timeoutMs: timeoutMs + 20000, stdio: true }), { flag: 'wx' });
  const child = cp.spawn(context.desktopHost, [launchFile], { cwd: context.controlRoot,
    env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const startedAt = Date.now(), processId = runId, readyToken = 'RELAY_INPUT_READY_' + runId;
  let sequence = 0, protocol = '', launcherError = '', stderr = '', stdoutBytes = 0;
  const stdout = [], pending = new Map();
  let exited = false, closed = false, exitInfo, stopping = false, stopReason, cleanupPromise;
  let commandStarted = false, commandComplete = false, readyResolve;
  let guardResolve, guardInfo, executionDesktop, keeper, keeperExited = false, keeperClosed = false;
  let keeperExitResolve, keeperCloseResolve, handshakeBuffer = '', payloadSent = false;
  const guardPromise = new Promise((resolve) => { guardResolve = resolve; });
  const keeperExitPromise = new Promise((resolve) => { keeperExitResolve = resolve; });
  const keeperClosePromise = new Promise((resolve) => { keeperCloseResolve = resolve; });
  let resolveExit, resolveClose;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const closePromise = new Promise((resolve) => { resolveClose = resolve; });
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  const finishPending = (message) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ error: { message } }); }
    pending.clear();
  };
  child.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; finishPending('Execution host exited'); resolveExit(exitInfo); if (!stopping) void shutdown('host_exited'); });
  child.on('close', () => { closed = true; finishPending('Execution host closed'); resolveClose(); });
  child.on('error', (error) => { launcherError = error.message; finishPending(error.message); void shutdown('launch_error'); });
  child.stdin.on('error', () => {});
  child.stderr.on('data', (data) => { launcherError = (launcherError + data).slice(-8000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    protocol += data;
    if (protocol.length > 8 * 1024 * 1024) { protocol = ''; void shutdown('protocol_output_limit'); return; }
    let end;
    while ((end = protocol.indexOf('\n')) >= 0) {
      const line = protocol.slice(0, end); protocol = protocol.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); item.resolve(message);
      } else if (message.method === 'command/exec/outputDelta' && message.params?.processId === processId) {
        const bytes = Buffer.from(message.params.deltaBase64 || '', 'base64');
        if (message.params.stream === 'stdout') {
          stdoutBytes += bytes.length;
          if (stdoutBytes > maxOutputBytes) { void shutdown('output_limit'); continue; }
          if (options.onStdout) {
            try { options.onStdout(bytes); } catch { void shutdown('output_sink_error'); }
          } else stdout.push(bytes);
        } else {
          if (payloadSent) { stderr = (stderr + bytes.toString('utf8')).slice(-16000); continue; }
          handshakeBuffer += bytes.toString('utf8');
          if (handshakeBuffer.length > 64000) { void shutdown('invalid_guard_output'); continue; }
          let at;
          while ((at = handshakeBuffer.indexOf('\n')) >= 0) {
            const line = handshakeBuffer.slice(0, at).replace(/\r$/, ''); handshakeBuffer = handshakeBuffer.slice(at + 1);
            if (line.startsWith('RELAY_GUARD_READY ') && !guardInfo) {
              try { guardInfo = JSON.parse(line.slice(18)); guardResolve(guardInfo); }
              catch { void shutdown('invalid_guard_identity'); }
            } else if (line.startsWith('RELAY_GUARD_LAUNCHED ')) {
              try {
                const value = JSON.parse(line.slice(21));
                if (!executionDesktop || value.desktop !== executionDesktop || value.station !== guardInfo.station || value.appContainerSid !== guardInfo.appContainerSid) void shutdown('invalid_execution_desktop');
              } catch { void shutdown('invalid_execution_desktop'); }
            } else if (line === readyToken) readyResolve(true);
            else stderr = (stderr + line + '\n').slice(-16000);
          }
        }
      }
    }
  });
  function request(method, params, deadlineMs, duringShutdown = false) {
    if (exited || child.stdin.destroyed || (stopping && !duringShutdown)) return Promise.resolve({ error: { message: 'Execution host unavailable' } });
    const id = ++sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: method + ' timed out' } }); }, deadlineMs);
      pending.set(id, { timer, resolve });
      try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (error) { pending.delete(id); clearTimeout(timer); resolve({ error: { message: error.message } }); }
    });
  }
  async function bounded(promise, ms) {
    let timer; const result = await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
    clearTimeout(timer); return result;
  }
  async function waitValue(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function establishDesktop(identity) {
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d{10,20}$/.test(identity.created) ||
        !/^S-1-15-2-(?:\d+-){6}\d+$/.test(identity.appContainerSid) || !/^Service-[A-Za-z0-9$-]+$/.test(identity.station) ||
        identity.nonce !== guardNonce || identity.bootstrapDesktop !== desktop) throw Error('Invalid isolated guard identity');
    if (stopping) throw Error('Execution cancelled');
    // The fixed helper checks process creation time, executable, AppContainer SID and membership
    // in this launcher's Job before creating a fresh desktop that grants only that container.
    keeper = cp.spawn(context.desktopHost, ['--keep', String(identity.pid), identity.created, context.desktopHost,
      identity.appContainerSid, identity.station, jobName], { cwd: context.controlRoot, env: environment,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    keeper.stdin.on('error', () => {});
    keeper.on('exit', () => { keeperExited = true; keeperExitResolve(); if (!stopping) void shutdown('desktop_keeper_exited'); });
    keeper.on('close', () => { keeperClosed = true; keeperCloseResolve(); });
    keeper.on('error', error => { launcherError = error.message; void shutdown('desktop_keeper_error'); });
    keeper.stderr.on('data', data => { launcherError = (launcherError + data).slice(-8000); });
    let text = '';
    const value = await waitValue(new Promise(resolve => {
      keeper.stdout.setEncoding('utf8');
      keeper.stdout.on('data', data => {
        text += data;
        if (text.length > 64000) { resolve(null); return; }
        if (text.includes('\n')) { try { resolve(JSON.parse(text.split('\n')[0])); } catch { resolve(null); } }
      });
      keeper.once('exit', () => resolve(null)); keeper.once('error', () => resolve(null));
    }), 10000);
    if (!value?.ok || value.jobVerified !== true || !/^RelayExec_[a-f0-9]{32}$/.test(value.desktop) ||
        value.pid !== identity.pid || value.created !== identity.created || value.appContainerSid !== identity.appContainerSid ||
        value.station !== identity.station || keeperExited || stopping) throw Error('Private execution desktop was not established');
    executionDesktop = value.desktop;
  }
  function shutdown(reason) {
    if (cleanupPromise) return cleanupPromise;
    stopping = true; stopReason = reason; clearTimeout(overallTimer);
    finishPending('Stopped: ' + reason); readyResolve(false); guardResolve(null);
    cleanupPromise = (async () => {
      if (commandStarted && !commandComplete && !exited) await request('command/exec/terminate', { processId }, 500, true);
      try { if (!child.stdin.destroyed) child.stdin.end(); } catch {}
      if (!exited && !await bounded(exitPromise, 1500)) {
        try { child.kill(); } catch {}
        await bounded(exitPromise, 1000);
      }
      finishPending('Execution cleanup finished');
      if (!closed) {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (!exited) child.unref();
        await bounded(closePromise, 100);
      }
      // Keep the private desktop alive until the outer Job has stopped all workers.
      if (keeper) {
        try { keeper.stdin.end(); } catch {}
        if (!keeperExited && !await bounded(keeperExitPromise, 500)) {
          try { keeper.kill(); } catch {}
          await bounded(keeperExitPromise, 1000);
        }
        keeper.stdin.destroy(); keeper.stdout.destroy(); keeper.stderr.destroy();
        if (!keeperClosed) await bounded(keeperClosePromise, 100);
      }
      let absent = false;
      try { process.kill(child.pid, 0); } catch (e) { absent = !child.pid || e.code === 'ESRCH'; }
      let keeperAbsent = !keeper;
      if (keeper) { try { process.kill(keeper.pid, 0); } catch (e) { keeperAbsent = !keeper.pid || e.code === 'ESRCH'; } }
      return { confirmedExited: exited, pidAbsent: absent, pipesClosed: closed, pending: pending.size, exitInfo,
        keeperExited: !keeper || keeperExited, keeperAbsent, keeperPipesClosed: !keeper || keeperClosed };
    })();
    return cleanupPromise;
  }
  const overallTimer = setTimeout(() => { void shutdown('overall_timeout'); }, timeoutMs + 15000);
  const onAbort = () => { void shutdown('cancelled'); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  async function writeBytes(buffer, closeStdin = false) {
    for (let offset = 0; offset < buffer.length; offset += 128 * 1024) {
      if (stopping) throw new Error('Execution cancelled');
      const r = await request('command/exec/write', { processId, deltaBase64: buffer.subarray(offset, offset + 128 * 1024).toString('base64') }, 10000);
      if (r.error) throw new Error(r.error.message);
    }
    if (closeStdin) {
      const r = await request('command/exec/write', { processId, closeStdin: true }, 10000);
      if (r.error && !commandComplete) throw new Error(r.error.message);
    }
  }
  const handle = { cancel: shutdown, child, get keeper() { return keeper; }, result: null };
  active.add(handle);
  handle.result = (async () => {
    let exitCode = null, failure;
    try {
      const init = await request('initialize', { clientInfo: { name: 'claude_relay_executor', version: '1' } }, 10000);
      if (init.error) throw new Error(init.error.message);
      if (stopping) throw new Error('Execution cancelled');
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      commandStarted = true;
      const responsePromise = request('command/exec', {
        command: [context.desktopHost, '--guard', desktop, guardNonce],
        cwd: path.dirname(context.nodePath), processId, streamStdin: true, streamStdoutStderr: true,
        // The private guard handshake uses stderr before user output begins.
        // Keep its fixed budget separate from the caller's stdout byte limit.
        timeoutMs, outputBytesCap: maxOutputBytes + 64 * 1024,
      }, timeoutMs + 3000).then((response) => { commandComplete = !response.error; readyResolve(false); guardResolve(null); return response; });
      await establishDesktop(await waitValue(guardPromise, 10000));
      const guardHeader = Buffer.from(JSON.stringify({ nonce: guardNonce, desktop: executionDesktop, exe: context.nodePath,
        args: ['--preserve-symlinks', '--preserve-symlinks-main', '-e', bootstrap(context.desktopHost, executionDesktop, context.workspaceRoot, context.executionRoot || context.workspaceRoot, context.scratchRoot, readyToken, context.workerEnv)],
        // Start directly in the trusted C: view. This Windows MXC runtime
        // rejects D: process cwd and changing cwd through a junction, while
        // inherited C: view cwd works. Bootstrap verifies the physical D: root.
        cwd: context.executionRoot || path.dirname(context.nodePath) }));
      if (guardHeader.length > 64000) throw Error('Guard request too large');
      const guardSize = Buffer.alloc(4); guardSize.writeUInt32BE(guardHeader.length);
      await writeBytes(Buffer.concat([guardSize, guardHeader]));
      let readyTimer;
      const ready = await Promise.race([readyPromise, new Promise((resolve) => { readyTimer = setTimeout(() => resolve(false), 10000); })]);
      clearTimeout(readyTimer);
      if (!ready) throw new Error('Isolated worker did not become ready');
      payloadSent = true;
      stderr = (stderr + handshakeBuffer).slice(-16000); handshakeBuffer = '';
      await writeBytes(Buffer.concat([headerSize, header]));
      if (options.stdin && !Buffer.isBuffer(options.stdin) && typeof options.stdin !== 'string') {
        for await (const chunk of options.stdin) await writeBytes(Buffer.from(chunk));
      } else if (options.stdin) await writeBytes(Buffer.from(options.stdin));
      await writeBytes(Buffer.alloc(0), true);
      const response = await responsePromise;
      if (response.error) throw new Error(response.error.message);
      exitCode = response.result.exitCode;
    } catch (e) { failure = e.message; }
    finally {
      clearTimeout(overallTimer); options.signal?.removeEventListener('abort', onAbort);
      await shutdown(stopping ? stopReason : failure ? 'execution_error' : 'completed'); active.delete(handle);
    }
    const cleanup = await cleanupPromise;
    if (!cleanup.confirmedExited || !cleanup.pidAbsent || !cleanup.keeperExited || !cleanup.keeperAbsent || cleanup.pending) failure ||= 'Execution cleanup could not be confirmed';
    // Only our generated control directory is removed; the workspace is never a cleanup target.
    if (cleanup.confirmedExited) {
      try {
        const base = fs.realpathSync(context.controlRoot), target = fs.realpathSync(runDir);
        const relative = path.relative(base, target);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('run-')) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {}
    }
    return { exitCode: failure ? null : exitCode, stdout: Buffer.concat(stdout), stderr: stderr || launcherError,
      error: failure, cancelled: stopReason !== 'completed', cleanup, durationMs: Date.now() - startedAt };
  })();
  return handle;
}

async function executeNode(context, code, options) { return startNode(context, code, options).result; }
function executeNodeSync(context, code, options = {}) {
  checkContext(context);
  if (options.stdin && !Buffer.isBuffer(options.stdin) && typeof options.stdin !== 'string') throw new TypeError('Synchronous execution cannot consume a stream');
  const wire = JSON.stringify({ context, code, options: { input: options.input, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes,
    stdinBase64: options.stdin ? Buffer.from(options.stdin).toString('base64') : undefined } });
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'executor-sync.js')], { input: wire,
    encoding: 'utf8', windowsHide: true, cwd: context.controlRoot,
    env: context.workerEnv, timeout: (options.timeoutMs || 60000) + 25000,
    maxBuffer: Math.ceil((options.maxOutputBytes || 8 * 1024 * 1024) * 1.5) + 1024 * 1024 });
  if (r.error || r.status !== 0) throw r.error || new Error(r.stderr || 'Isolated I/O failed');
  const value = JSON.parse(r.stdout); value.stdout = Buffer.from(value.stdoutBase64, 'base64'); delete value.stdoutBase64;
  return value;
}
async function closeAll() { await Promise.allSettled([...active].map((handle) => handle.cancel('service_stopping'))); }
module.exports = { startNode, executeNode, executeNodeSync, closeAll };
