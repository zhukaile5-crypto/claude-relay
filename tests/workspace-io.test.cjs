'use strict';

// Contract tests use synthetic files and an in-process executor double. They
// never launch a model, MXC, GUI or production server. They prove routing and
// worker behavior, not the operating-system isolation policy itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createWorkspaceIO, WORKER_SOURCE } = require('../isolation/workspace-io');

function fixture(t, limits = {}, overrides = {}) {
  const fixtureRoot = path.resolve(__dirname);
  const dir = fs.mkdtempSync(path.join(fixtureRoot, '.workspace-io-test-'));
  const work = path.join(dir, 'alice'), other = path.join(dir, 'bob'), cache = path.join(dir, 'trusted-cache');
  for (const p of [work, other, cache]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(other, 'canary.txt'), 'SYNTHETIC_OTHER_ACCOUNT');
  const context = Object.freeze({ workspaceRoot: work, policyId: 'synthetic-alice-policy' });
  const calls = [], fileCalls = [];
  function executeNodeSync(ctx, code, options) {
    assert.strictEqual(ctx, context); assert.strictEqual(code, WORKER_SOURCE);
    assert.equal(options.input.root, work);
    calls.push({ code, options });
    const out = [], err = [];
    const proc = { exitCode: 0, stdout: { write(b) { out.push(Buffer.from(b)); } }, stderr: { write(b) { err.push(Buffer.from(b)); } } };
    const workerFs = new Proxy(fs, { get(target, name) {
      if (typeof target[name] !== 'function') return target[name];
      if (name === 'realpathSync') {
        const resolve = (...args) => { fileCalls.push({ name: 'realpathSync', path: args[0] }); return target.realpathSync(...args); };
        resolve.native = (...args) => { fileCalls.push({ name: 'realpathSync.native', path: args[0] }); return target.realpathSync.native(...args); };
        return resolve;
      }
      return (...args) => {
        fileCalls.push({ name, path: args[0] });
        if (name === 'readFileSync' && args[0] === 0) return options.stdin || Buffer.alloc(0);
        if (overrides[name]) return overrides[name](...args);
        return target[name](...args);
      };
    } });
    vm.runInNewContext(code, {
      input: options.input, Buffer, process: proc,
      require(name) { return name === 'node:fs' ? workerFs : require(name); },
    }, { timeout: 5000 });
    return { exitCode: proc.exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
  }
  const api = createWorkspaceIO({ executeNodeSync, executeNode: async (ctx, code, options) => {
    if (options.stdin && !Buffer.isBuffer(options.stdin)) {
      const chunks = []; for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
      options = { ...options, stdin: Buffer.concat(chunks) };
    }
    return executeNodeSync(ctx, code, options);
  }, ...limits });
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), fixtureRoot); assert.ok(path.basename(dir).startsWith('.workspace-io-test-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return { api, context, calls, fileCalls, work, other, cache };
}

test('all synchronous workspace operations are executed by the supplied bound executor', (t) => {
  const h = fixture(t), { api, context } = h;
  api.mkdirSync(context, '.memory/chats');
  api.writeTextSync(context, '.memory/memory.md', '中文记忆🙂');
  assert.equal(api.readTextSync(context, '.memory/memory.md'), '中文记忆🙂');
  api.writeJsonSync(context, 'projects/abcd1234/.project/project.json', { id: 'abcd1234', title: 'synthetic' }, { parents: true });
  assert.deepEqual(api.readJsonSync(context, 'projects/abcd1234/.project/project.json'), { id: 'abcd1234', title: 'synthetic' });
  api.copySync(context, '.memory/memory.md', '.memory/chats/copy.md');
  assert.equal(api.statSync(context, '.memory/chats/copy.md').isFile, true);
  assert.equal(api.listSync(context, '.memory/chats')[0].name, 'copy.md');
  api.removeSync(context, '.memory/chats/copy.md');
  assert.equal(api.removeSync(context, '.memory/chats/copy.md', { force: true }), false);
  assert.ok(h.calls.length >= 10);
  assert.ok(h.fileCalls.some(c => c.name === 'renameSync'));
  assert.ok(h.fileCalls.every(c => typeof c.path !== 'string' || c.path.startsWith(h.work)));
});

test('batch results preserve per-operation errors and bounded UTF-8 project snapshots', (t) => {
  const { api, context } = fixture(t);
  const results = api.batchSync(context, [
    { type: 'mkdir', path: 'projects/abcd1234/files' },
    { type: 'writeText', path: 'projects/abcd1234/files/a.txt', text: '甲乙丙' },
    { type: 'writeText', path: 'projects/abcd1234/files/b.txt', text: 'abcdefghij' },
    { type: 'readText', path: 'missing.txt' },
    { type: 'stat', path: 'projects/abcd1234/files/a.txt' },
  ]);
  assert.equal(results.length, 5); assert.equal(results[3].ok, false); assert.equal(results[3].error.code, 'ENOENT');
  assert.equal(results[4].value.size, 9);
  const snapshot = api.snapshotSync(context, 'projects/abcd1234/files', { textExtensions: ['.txt'], textBudget: 9 });
  assert.equal(snapshot.files.length, 2); assert.deepEqual(snapshot.texts, [{ path: 'projects/abcd1234/files/a.txt', text: '甲乙丙' }]);
});

test('scan matches turn-file behavior, skips hidden files and bounds count and depth', (t) => {
  const { api, context } = fixture(t);
  for (const name of ['chats/c/outputs/a.txt', 'projects/p/outputs/b.txt', '.work/temp.txt', 'root.txt', 'deep/a/b/end.txt']) api.writeTextSync(context, name, 'x', { parents: true });
  assert.deepEqual(api.scanSync(context, '', { skip: ['chats', 'projects'], depth: 1 }).map(f => f.path), ['root.txt']);
  assert.equal(api.scanSync(context, '', { max: 2 }).length, 2);
  assert.equal(api.scanSync(context, '', { hidden: true }).some(f => f.path === '.work/temp.txt'), true);
});

test('path aliases, traversal, absolute destinations and root deletion fail inside the executor', (t) => {
  const h = fixture(t);
  for (const rel of ['../bob/canary.txt', '..\\bob\\canary.txt', h.other, 'C:\\outside', 'C:relative', '\\\\?\\C:\\outside', '\\\\.\\C:\\outside', 'a.txt:alternate', 'bad\0path']) {
    const before = h.calls.length;
    assert.throws(() => h.api.readTextSync(h.context, rel), e => ['INVALID_PATH', 'WORKSPACE_ESCAPE'].includes(e.code));
    assert.equal(h.calls.length, before + 1, 'path rejection must run behind the boundary');
  }
  assert.throws(() => h.api.removeSync(h.context, '', { recursive: true }), { code: 'WORKSPACE_ESCAPE' });
  assert.equal(fs.readFileSync(path.join(h.other, 'canary.txt'), 'utf8'), 'SYNTHETIC_OTHER_ACCOUNT');
});

test('external and dangling junctions fail closed; internal links remain usable for direct reads', (t) => {
  const h = fixture(t);
  fs.mkdirSync(path.join(h.work, 'internal')); fs.writeFileSync(path.join(h.work, 'internal', 'ok.txt'), 'owned');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(h.other, path.join(h.work, 'external'), kind);
  fs.symlinkSync(path.join(h.work, 'internal'), path.join(h.work, 'internal-link'), kind);
  fs.symlinkSync(path.join(h.other, 'missing'), path.join(h.work, 'dangling'), kind);
  assert.throws(() => h.api.readTextSync(h.context, 'external/canary.txt'), { code: 'WORKSPACE_ESCAPE' });
  assert.throws(() => h.api.writeTextSync(h.context, 'external/new.txt', 'no'), { code: 'WORKSPACE_ESCAPE' });
  assert.throws(() => h.api.writeTextSync(h.context, 'dangling/new.txt', 'no', { parents: true }), { code: 'WORKSPACE_ESCAPE' });
  assert.equal(h.api.readTextSync(h.context, 'internal-link/ok.txt'), 'owned');
  assert.deepEqual(h.api.scanSync(h.context, '').map(f => f.path), ['internal/ok.txt']);
  assert.equal(fs.existsSync(path.join(h.other, 'new.txt')), false);
});

test('async upload transports exact bytes on stdin and never overwrites an existing name', async (t) => {
  const h = fixture(t), expected = Buffer.from([0, 1, 2, 255, 13, 10]);
  const value = await h.api.writeFromStream(h.context, 'chats/c/uploads/input.bin', Readable.from([expected.subarray(0, 2), expected.subarray(2)]));
  assert.equal(value.size, expected.length); assert.deepEqual(h.calls.at(-1).options.stdin, expected);
  assert.deepEqual(await h.api.readBytes(h.context, value.path), expected);
  await assert.rejects(h.api.writeFromStream(h.context, value.path, Readable.from(['replacement'])), { code: 'EEXIST' });
  assert.deepEqual(await h.api.readBytes(h.context, value.path), expected);
});

test('readToFile copies only executor-returned bytes into a caller-chosen trusted cache', async (t) => {
  const h = fixture(t), destination = path.join(h.cache, 'preview-source.docx');
  h.api.writeTextSync(h.context, 'outputs/source.docx', 'synthetic office fixture', { parents: true });
  const result = await h.api.readToFile(h.context, 'outputs/source.docx', destination);
  assert.equal(result.size, 24); assert.equal(fs.readFileSync(destination, 'utf8'), 'synthetic office fixture');
  await assert.rejects(h.api.readToFile(h.context, 'outputs/source.docx', destination), { code: 'EEXIST' });
});

test('file, upload, metadata and batch limits reject without starting oversized upload writes', async (t) => {
  const h = fixture(t, { maxFileBytes: 8, maxOutputBytes: 512 });
  assert.throws(() => h.api.writeTextSync(h.context, 'too-big.txt', '123456789'), { code: 'FILE_TOO_LARGE' });
  h.api.writeTextSync(h.context, 'small.txt', '12345678');
  assert.throws(() => h.api.readTextSync(h.context, 'small.txt', { maxBytes: 7 }), { code: 'FILE_TOO_LARGE' });
  const before = h.calls.length;
  await assert.rejects(h.api.writeFromStream(h.context, 'upload.txt', Readable.from(['12345', '6789'])), { code: 'FILE_TOO_LARGE', statusCode: 413 });
  assert.equal(h.calls.length, before);
  assert.throws(() => h.api.batchSync(h.context, Array.from({ length: 257 }, () => ({ type: 'stat', path: 'small.txt' }))), { code: 'INVALID_OPERATION' });
});

test('aborted uploads and executor failures never trigger host workspace fallback', async (t) => {
  const h = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(h.api.writeFromStream(h.context, 'never-created.txt', Readable.from(['x']), { signal: controller.signal }), { code: 'UPLOAD_ABORTED' });
  assert.equal(h.calls.length, 0);
  const api = createWorkspaceIO({ executeNode: async () => ({ exitCode: 1, stderr: 'executor failed' }), executeNodeSync: () => ({ exitCode: 1, stderr: 'executor failed' }) });
  assert.throws(() => api.readTextSync(h.context, 'never-created.txt'), { code: 'WORKSPACE_EXECUTION_FAILED' });
  await assert.rejects(api.readToFile(h.context, 'never-created.txt', path.join(h.cache, 'none')), { code: 'WORKSPACE_EXECUTION_FAILED' });
  assert.equal(fs.existsSync(path.join(h.cache, 'none')), false);
});

test('unique upload naming selects and creates the target exclusively inside the worker', async (t) => {
  const h = fixture(t);
  const first = await h.api.writeFromStream(h.context, 'uploads/中文.txt', Readable.from(['first']), { uniqueName: true });
  const second = await h.api.writeFromStream(h.context, 'uploads/中文.txt', Readable.from(['second']), { uniqueName: true });
  assert.equal(first.path, 'uploads/中文.txt'); assert.equal(second.path, 'uploads/中文 (1).txt');
  assert.equal(fs.readFileSync(path.join(h.work, first.path), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(h.work, second.path), 'utf8'), 'second');
  assert.ok(h.calls.every(c => c.options.input.options.uniqueName === true));
});

test('upload limit errors retain 413 when the executor reports cancellation as a result', async (t) => {
  const h = fixture(t);
  const api = createWorkspaceIO({ executeNodeSync: () => assert.fail('Unexpected synchronous call'), executeNode: async (ctx, code, options) => {
    try { for await (const chunk of options.stdin) void chunk; } catch {}
    return { exitCode: null, stderr: '', error: 'execution cancelled' };
  } });
  await assert.rejects(api.writeFromStream(h.context, 'no-commit.txt', Readable.from(['12345']), { limitBytes: 4 }), { code: 'FILE_TOO_LARGE', statusCode: 413 });
  assert.equal(fs.existsSync(path.join(h.work, 'no-commit.txt')), false);
});

test('a failed atomic replacement preserves the previous file and removes its temporary file', (t) => {
  const h = fixture(t, {}, { renameSync() { throw Object.assign(new Error('synthetic rename refusal'), { code: 'EPERM' }); } });
  fs.writeFileSync(path.join(h.work, 'memory.md'), 'old synthetic data');
  assert.throws(() => h.api.writeTextSync(h.context, 'memory.md', 'new synthetic data'), { code: 'EPERM' });
  assert.equal(fs.readFileSync(path.join(h.work, 'memory.md'), 'utf8'), 'old synthetic data');
  assert.deepEqual(fs.readdirSync(h.work), ['memory.md']);
});

test('the host rejects malformed or oversized executor replies without writing a cache file', async (t) => {
  const h = fixture(t), options = { maxOutputBytes: 8 };
  const oversized = () => ({ exitCode: 0, stdout: Buffer.alloc(9), stderr: '' });
  const api = createWorkspaceIO({ ...options, executeNode: async () => oversized(), executeNodeSync: oversized });
  assert.throws(() => api.batchSync(h.context, []), { code: 'OUTPUT_TOO_LARGE' });
  await assert.rejects(api.readToFile(h.context, 'anything', path.join(h.cache, 'too-big'), { limitBytes: 8 }), { code: 'OUTPUT_TOO_LARGE' });
  assert.equal(fs.existsSync(path.join(h.cache, 'too-big')), false);
  const malformed = () => ({ exitCode: 0, stdout: Buffer.from('broken'), stderr: '' });
  const bad = createWorkspaceIO({ executeNode: async () => malformed(), executeNodeSync: malformed });
  assert.throws(() => bad.batchSync(h.context, []), { code: 'WORKSPACE_PROTOCOL_ERROR' });
});
