'use strict';

// This module never opens a user-workspace path in the host process. The trusted
// caller binds a context to an MXC policy and supplies its workspaceRoot/workDir.
// executeNode injects options.input as globalThis.input; stdin is binary data.
const fs = require('node:fs');
const { Readable } = require('node:stream');

const UPLOAD_LIMIT = 500 * 1024 * 1024;
const METADATA_LIMIT = 16 * 1024 * 1024;

function workspaceWorker() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const req = globalThis.input;
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const bounded = (n, maximum, fallback) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, maximum) : fallback;
  const errorValue = (e) => ({ code: String(e.code || 'WORKSPACE_IO_ERROR'), message: String(e.message || e).slice(0, 4000) });
  const inside = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
  if (!req || typeof req.root !== 'string' || !path.isAbsolute(req.root)) fail('INVALID_CONTEXT', 'A trusted absolute workspace root is required');
  // Node's JavaScript realpath walker enumerates parent directories, which a
  // default-deny MXC policy may correctly deny. The native handle-based path
  // resolver works for an explicitly granted workspace without that traversal.
  const root = path.resolve(req.root), realRoot = fs.realpathSync.native(root);
  function resolve(rel, { missing = false, allowRoot = true } = {}) {
    if (typeof rel !== 'string' || /[\0:]/.test(rel) || /^[\\/]/.test(rel) || path.isAbsolute(rel)) fail('INVALID_PATH', 'Use a workspace-relative path');
    const full = path.resolve(root, rel.replace(/\\/g, path.sep));
    if (!inside(root, full) || (!allowRoot && full === root)) fail('WORKSPACE_ESCAPE', 'The path is outside the allowed workspace operation');
    let ancestor = full;
    for (;;) {
      try {
        if (!inside(realRoot, fs.realpathSync.native(ancestor))) fail('WORKSPACE_ESCAPE', 'A path link leaves the workspace');
        return full;
      } catch (e) {
        if (e.code !== 'ENOENT' || !missing) throw e;
        try { if (fs.lstatSync(ancestor).isSymbolicLink()) fail('WORKSPACE_ESCAPE', 'A dangling link is not a new path'); }
        catch (lstatError) { if (lstatError.code !== 'ENOENT') throw lstatError; }
        const parent = path.dirname(ancestor);
        if (parent === ancestor || !inside(root, parent)) throw e;
        ancestor = parent;
      }
    }
  }
  const relative = (full) => path.relative(root, full).split(path.sep).join('/');
  function readBytes(rel, maxBytes) {
    const limit = bounded(maxBytes, req.maxFileBytes, req.maxFileBytes);
    const fd = fs.openSync(resolve(rel), 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) fail('NOT_A_FILE', 'The path is not a regular file');
      if (st.size > limit) fail('FILE_TOO_LARGE', 'The file exceeds the read limit');
      // Read through the descriptor, bounded even if another process grows it.
      const chunks = []; let total = 0;
      for (;;) {
        const buf = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        total += n;
        if (total > limit) fail('FILE_TOO_LARGE', 'The file grew beyond the read limit');
        chunks.push(buf.subarray(0, n));
      }
      return Buffer.concat(chunks, total);
    } finally { fs.closeSync(fd); }
  }
  function writeBytes(rel, bytes, options = {}) {
    if (bytes.length > req.maxFileBytes) fail('FILE_TOO_LARGE', 'The file exceeds the write limit');
    let full = resolve(rel, { missing: true, allowRoot: false });
    if (options.parents) fs.mkdirSync(path.dirname(full), { recursive: true });
    resolve(relative(path.dirname(full)));
    if (options.exclusive) {
      const ext = path.extname(full), stem = full.slice(0, full.length - ext.length);
      let fd, suffix = 0;
      for (;;) {
        try { fd = fs.openSync(full, 'wx'); break; }
        catch (e) {
          if (e.code !== 'EEXIST' || !options.uniqueName || suffix >= 10000) throw e;
          full = resolve(relative(stem + ' (' + (++suffix) + ')' + ext), { missing: true, allowRoot: false });
        }
      }
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    } else {
      const temp = path.join(path.dirname(full), '.relay-write-' + crypto.randomBytes(16).toString('hex'));
      let fd;
      try {
        fd = fs.openSync(temp, 'wx'); fs.writeFileSync(fd, bytes); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, full);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.rmSync(temp, { force: true }); } catch {}
      }
    }
    return { path: relative(full), size: bytes.length };
  }
  function scan(op) {
    const rows = [], max = bounded(op.max, 20000, 2000), maxDepth = bounded(op.depth, 16, 8);
    const skip = new Set(Array.isArray(op.skip) ? op.skip : []);
    function walk(dir, depth) {
      if (depth > maxDepth || rows.length >= max) return;
      for (const e of fs.readdirSync(resolve(relative(dir)), { withFileTypes: true })) {
        if (rows.length >= max) break;
        if ((!op.hidden && e.name.startsWith('.')) || e.name === 'node_modules' || e.name === '__pycache__' || (depth === 0 && skip.has(e.name))) continue;
        // Do not traverse reparse points while enumerating. Direct operations
        // can still resolve an internal link under the executor policy.
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) {
          try { const st = fs.statSync(resolve(relative(full))); rows.push({ path: relative(full), size: st.size, mtime: st.mtimeMs }); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      }
    }
    walk(resolve(op.path || ''), 0);
    return rows;
  }
  function operation(op) {
    if (!op || typeof op.type !== 'string') fail('INVALID_OPERATION', 'An operation type is required');
    if (op.type === 'readText') return readBytes(op.path, op.maxBytes).toString('utf8');
    if (op.type === 'readJson') return JSON.parse(readBytes(op.path, op.maxBytes).toString('utf8'));
    if (op.type === 'stat') {
      const st = fs.statSync(resolve(op.path));
      return { path: op.path, size: st.size, mtime: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory() };
    }
    if (op.type === 'list') return fs.readdirSync(resolve(op.path || ''), { withFileTypes: true }).slice(0, bounded(op.max, 20000, 20000)).map(e => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() }));
    if (op.type === 'scan') return scan(op);
    if (op.type === 'snapshot') {
      const files = scan(op), texts = [], extensions = new Set(op.textExtensions || []);
      let remaining = bounded(op.textBudget, req.maxFileBytes, 30000);
      for (const f of files) {
        if (!extensions.has(path.extname(f.path).toLowerCase()) || f.size > remaining) continue;
        try { const b = readBytes(f.path, remaining); remaining -= b.length; texts.push({ path: f.path, text: b.toString('utf8') }); }
        catch (e) { if (!['ENOENT', 'FILE_TOO_LARGE'].includes(e.code)) throw e; }
      }
      return { files, texts };
    }
    if (op.type === 'mkdir') { fs.mkdirSync(resolve(op.path, { missing: true }), { recursive: op.recursive !== false }); return true; }
    if (op.type === 'writeText' || op.type === 'writeJson') return writeBytes(op.path, Buffer.from(op.type === 'writeJson' ? JSON.stringify(op.value, null, op.pretty ? 2 : 0) : String(op.text), 'utf8'), op);
    if (op.type === 'remove') {
      let full;
      try { full = resolve(op.path, { allowRoot: false }); }
      catch (e) { if (op.force && e.code === 'ENOENT') return false; throw e; }
      fs.rmSync(full, { recursive: op.recursive === true, force: op.force === true }); return true;
    }
    if (op.type === 'copy') return writeBytes(op.to, readBytes(op.from, op.maxBytes), op);
    fail('INVALID_OPERATION', 'Unsupported workspace operation');
  }
  try {
    if (req.mode === 'readBytes') { process.stdout.write(readBytes(req.path, req.limitBytes)); return; }
    if (req.mode === 'writeBytes') {
      const data = fs.readFileSync(0);
      if (data.length > req.limitBytes) fail('FILE_TOO_LARGE', 'Upload exceeds the configured size limit');
      process.stdout.write(JSON.stringify(writeBytes(req.path, data, req.options))); return;
    }
    if (!Array.isArray(req.operations) || req.operations.length > 256) fail('INVALID_OPERATION', 'A batch must contain at most 256 operations');
    const results = req.operations.map(op => { try { return { ok: true, value: operation(op) }; } catch (e) { return { ok: false, error: errorValue(e) }; } });
    const out = Buffer.from(JSON.stringify(results));
    if (out.length > req.maxOutputBytes) fail('OUTPUT_TOO_LARGE', 'Workspace metadata exceeds the output limit');
    process.stdout.write(out);
  } catch (e) { process.stderr.write(JSON.stringify(errorValue(e))); process.exitCode = 1; }
}

const WORKER_SOURCE = '(' + workspaceWorker.toString() + ')();';

function createWorkspaceIO({ executeNode, executeNodeSync, maxFileBytes = UPLOAD_LIMIT, maxOutputBytes = METADATA_LIMIT } = {}) {
  if (typeof executeNode !== 'function' || typeof executeNodeSync !== 'function') throw new TypeError('Both isolated executor functions are required');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > UPLOAD_LIMIT) throw new RangeError('Invalid workspace file limit');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024 * 1024) throw new RangeError('Invalid workspace metadata limit');
  const fileLimit = (options) => {
    const value = options.limitBytes ?? maxFileBytes;
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid file operation limit');
    return Math.min(value, maxFileBytes);
  };
  function input(context, request) {
    const root = context && (context.workspaceRoot || context.workDir);
    if (typeof root !== 'string' || !root) throw new TypeError('The trusted context must bind its workspaceRoot');
    return { ...request, root, maxFileBytes, maxOutputBytes: request.mode === 'readBytes' ? request.limitBytes : maxOutputBytes };
  }
  function resultBytes(result, limit = maxOutputBytes) {
    if (!result || result.exitCode !== 0) {
      let detail; try { detail = JSON.parse(String(result?.stderr || '')); } catch {}
      const error = new Error(detail?.message || 'The isolated workspace operation failed');
      error.code = detail?.code || 'WORKSPACE_EXECUTION_FAILED'; throw error;
    }
    const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
    if (bytes.length > limit) throw Object.assign(new Error('The isolated operation exceeded its output limit'), { code: 'OUTPUT_TOO_LARGE' });
    return bytes;
  }
  const decode = (result) => {
    const bytes = resultBytes(result);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw Object.assign(new Error('The isolated workspace reply was not valid JSON'), { code: 'WORKSPACE_PROTOCOL_ERROR' }); }
  };
  function run(context, request, options = {}, sync = false) {
    const task = { timeoutMs: 60000, ...options, input: input(context, request), maxOutputBytes: request.mode === 'readBytes' ? request.limitBytes : maxOutputBytes };
    return (sync ? executeNodeSync : executeNode)(context, WORKER_SOURCE, task);
  }
  const api = {
    batchSync(context, operations, options) { return decode(run(context, { operations }, options, true)); },
    async batch(context, operations, options) { return decode(await run(context, { operations }, options)); },
    operationSync(context, operation, options) {
      const row = api.batchSync(context, [operation], options)[0];
      if (!row?.ok) { const e = new Error(row?.error?.message || 'Workspace operation failed'); e.code = row?.error?.code || 'WORKSPACE_IO_ERROR'; throw e; }
      return row.value;
    },
    async readToFile(context, relativePath, trustedDestination, options = {}) {
      const limitBytes = fileLimit(options);
      const bytes = resultBytes(await run(context, { mode: 'readBytes', path: relativePath, limitBytes }, options), limitBytes);
      if (bytes.length > limitBytes) throw Object.assign(new Error('Workspace output exceeded the read limit'), { code: 'FILE_TOO_LARGE' });
      // trustedDestination is selected by the service, never by a request or
      // model argument. No workspace path is opened by this host-side write.
      await fs.promises.writeFile(trustedDestination, bytes, { flag: options.exclusive === false ? 'w' : 'wx' });
      return { size: bytes.length };
    },
    async readBytes(context, relativePath, options = {}) {
      const limitBytes = fileLimit(options);
      const bytes = resultBytes(await run(context, { mode: 'readBytes', path: relativePath, limitBytes }, options), limitBytes);
      if (bytes.length > limitBytes) throw Object.assign(new Error('Workspace output exceeded the read limit'), { code: 'FILE_TOO_LARGE' });
      return bytes;
    },
    async writeFromStream(context, relativePath, stream, options = {}) {
      const limitBytes = fileLimit(options);
      if (options.signal?.aborted || stream.aborted) throw Object.assign(new Error('Upload was cancelled'), { code: 'UPLOAD_ABORTED' });
      let inputError;
      async function* payload() {
        try {
          let total = 0;
          for await (const chunk of stream) {
            if (options.signal?.aborted) throw Object.assign(new Error('Upload was cancelled'), { code: 'UPLOAD_ABORTED' });
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += bytes.length;
            if (total > limitBytes) throw Object.assign(new Error('Upload exceeds the configured size limit'), { code: 'FILE_TOO_LARGE', statusCode: 413 });
            yield bytes;
          }
          if (options.signal?.aborted || stream.aborted) throw Object.assign(new Error('Upload was cancelled'), { code: 'UPLOAD_ABORTED' });
        } catch (e) { inputError = e; throw e; }
      }
      // The executor must cancel on input-stream errors, never close stdin as
      // successful EOF. The worker commits only after it has received all input.
      // The host streams; the current worker still buffers up to maxFileBytes.
      const result = await run(context, { mode: 'writeBytes', path: relativePath, limitBytes, options: { exclusive: options.exclusive !== false, parents: options.parents !== false, uniqueName: options.uniqueName === true } }, { ...options, stdin: Readable.from(payload()) });
      if (inputError) throw inputError;
      return decode(result);
    },
  };
  const simple = { readText: ['path', 'options'], readJson: ['path', 'options'], stat: ['path', 'options'], list: ['path', 'options'], scan: ['path', 'options'], snapshot: ['path', 'options'], mkdir: ['path', 'options'], remove: ['path', 'options'] };
  for (const type of Object.keys(simple)) api[type + 'Sync'] = (context, path, options = {}) => api.operationSync(context, { ...options, type, path });
  api.writeTextSync = (context, path, text, options = {}) => api.operationSync(context, { ...options, type: 'writeText', path, text });
  api.writeJsonSync = (context, path, value, options = {}) => api.operationSync(context, { ...options, type: 'writeJson', path, value });
  api.copySync = (context, from, to, options = {}) => api.operationSync(context, { ...options, type: 'copy', from, to });
  return api;
}

module.exports = { createWorkspaceIO, WORKER_SOURCE, UPLOAD_LIMIT, METADATA_LIMIT };
