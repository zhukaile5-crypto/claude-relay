'use strict';

// Explicit synthetic smoke runner. Takes an existing synthetic executor result;
// never reads service config, credentials or user-workspace data.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const assert = require('node:assert/strict');
const executor = require('../isolation/executor');
const { createWorkspaceIO } = require('../isolation/workspace-io');

(async () => {
  const source = path.resolve(process.argv[2] || '');
  if (path.basename(source) !== 'executor-smoke-result.json' || !source.includes('codex-security-artifacts-')) throw Error('Expected an explicitly managed synthetic executor fixture');
  const { context } = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!context.workspaceRoot.includes('codex-security-artifacts-') || !context.workspaceRoot.includes('executor-')) throw Error('Refusing a non-synthetic workspace');
  const io = createWorkspaceIO(executor), prefix = 'workspace-io-smoke-' + crypto.randomBytes(6).toString('hex');
  const checks = {}, started = Date.now(), result = { prefix, checks };
  try {
    const rows = io.batchSync(context, [
      { type: 'mkdir', path: prefix + '/files' },
      { type: 'writeText', path: prefix + '/files/notes.txt', text: '中文 fixture 42🙂' },
      { type: 'readText', path: prefix + '/files/notes.txt' },
      { type: 'writeJson', path: prefix + '/files/meta.json', value: { n: 42 } },
      { type: 'readJson', path: prefix + '/files/meta.json' },
    ]);
    assert.ok(rows.every(r => r.ok)); assert.equal(rows[2].value, '中文 fixture 42🙂'); assert.equal(rows[4].value.n, 42); checks.syncBatch = true;
    const bytes = Buffer.from([0, 255, 17, 13, 10, 91]);
    const uploaded = await io.writeFromStream(context, prefix + '/files/upload.bin', Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]));
    assert.equal(uploaded.size, bytes.length); assert.deepEqual(await io.readBytes(context, uploaded.path), bytes); checks.asyncUploadRead = true;
    const snapshot = io.snapshotSync(context, prefix, { textExtensions: ['.txt'], textBudget: 100 });
    assert.equal(snapshot.files.length, 3); assert.equal(snapshot.texts[0].text, '中文 fixture 42🙂'); checks.snapshot = true;
    assert.throws(() => io.readTextSync(context, '../outside/canary.txt'), { code: 'WORKSPACE_ESCAPE' }); checks.outsideRejected = true;
    await assert.rejects(io.writeFromStream(context, uploaded.path, Readable.from(['no overwrite'])), { code: 'EEXIST' }); checks.exclusive = true;
    const cache = path.join(path.dirname(source), prefix + '-cache.bin');
    await io.readToFile(context, uploaded.path, cache); assert.deepEqual(fs.readFileSync(cache), bytes); checks.cacheBytes = true;
    const cancel = new AbortController();
    async function* interrupted() { yield Buffer.from('partial'); await new Promise(r => setTimeout(r, 80)); cancel.abort(); yield Buffer.from('never'); }
    await assert.rejects(io.writeFromStream(context, prefix + '/files/cancelled.bin', Readable.from(interrupted()), { signal: cancel.signal }));
    const missing = io.batchSync(context, [{ type: 'stat', path: prefix + '/files/cancelled.bin' }])[0];
    assert.equal(missing.ok, false); assert.equal(missing.error.code, 'ENOENT'); checks.abortNoCommit = true;
    io.copySync(context, prefix + '/files/notes.txt', prefix + '/copy.txt');
    assert.equal(io.readTextSync(context, prefix + '/copy.txt'), '中文 fixture 42🙂'); checks.copy = true;
  } catch (e) { result.error = { code: e.code, message: e.message, stack: e.stack }; process.exitCode = 1; }
  finally {
    try { io.removeSync(context, prefix, { recursive: true, force: true }); result.cleaned = true; } catch (e) { result.cleanupError = e.message; process.exitCode = 1; }
    await executor.closeAll();
    result.durationMs = Date.now() - started;
    const output = path.join(path.dirname(source), 'workspace-io-mxc-smoke-result.json');
    fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify({ output, ...result }, null, 2));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
