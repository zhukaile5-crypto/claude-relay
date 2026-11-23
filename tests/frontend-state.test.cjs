'use strict';
// Actual frontend functions with in-memory DOM, storage and requests. No production I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const extract = (name) => {
  const m = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}', 'm'));
  assert.ok(m, 'Missing function: ' + name);
  return m[0];
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function harness() {
  const storage = new Map([['lastUserId', 'alice'], ['relayToken', 'alice.token']]);
  const elements = new Map(), cacheData = new Map(), cacheOps = [], blobData = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} },
      replaceChildren() {}, focus() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false, appendChild() {}, remove() {} });
    return elements.get(key);
  };
  const ctx = {
    choiceSerial: 0, flushChoice() {}, cancelPendingChoices() {}, restoreConversationChoice() {}, selectedChoice() {},
    captureConversationChoice: () => ({ current: () => true }), reconcileConversationChoice: (conv) => conv, restorePendingChoices() {},
    S: { nav: 1, draftUser: 'alice', draftFor: 'n', draftId: null, draftOwnerId: null, conv: null, convId: null, projectId: null,
      view: 'chat', atts: [], tools: [], tool: null, convs: [], projects: [], running: new Set(), open: new Map(), panel: null },
    $: element, innerWidth: 1200, Response, AbortController, Headers, URL, Map, Set,
    document: { title: '', querySelectorAll: () => [], querySelector: () => null },
    ls: { get: (k, d) => storage.get(k) ?? d, set: (k, v) => storage.set(k, v), del: (k) => storage.delete(k) },
    localStorage: { get length() { return storage.size; }, key: (i) => [...storage.keys()][i], getItem: (k) => storage.get(k), removeItem: (k) => storage.delete(k) },
    caches: { async open(name) {
      cacheOps.push(['open', name]);
      return { match: async (k) => cacheData.has(k) ? new Response(cacheData.get(k)) : undefined,
        put: async (k, value) => { cacheOps.push(['put', k]); cacheData.set(k, await value.text()); },
        delete: async (k) => cacheData.delete(k) };
    }, async delete(name) { cacheOps.push(['clear', name]); if (name === 'data') cacheData.clear(); } },
    blobs: { put: async (k, v) => blobData.set(k, v), get: async (k) => blobData.get(k), del: (k) => blobData.delete(k), clear: () => blobData.clear() },
    pendingUploads: new Map(), activeUploads: new Map(), CHUNK: 4,
    newDraftId: (() => { let n = 0; return () => 'draft-' + (++n); })(),
    resumeUploads() {}, renderAtts() {}, renderThread() {}, renderSidebar() {}, renderProject() {}, updateSendBtn() {}, updatePerch() {}, hop() {}, loadState() {}, autoGrow() {}, toast() {},
    setTool: (v) => { ctx.S.tool = v; }, setView: (v) => { ctx.S.view = v; }, setPview() {},
    isImg: () => false, fileUrl: (p) => '/api/file?path=' + p, newProjectSheet() {},
    es: null, reloadTimer: 0, esRenewTimer: 0, esRetryTimer: 0, notifyDone: {}, cookieless: false,
    cancelMic() {}, stopSpeaking() {}, closeMenu() {}, pickSavedAccount() {}, lastWarm: {}, requestPrewarm() {},
    clearTimeout() {}, clearInterval() {}, setTimeout() {},
    cachedConv: async () => null, cacheConv() {}, convSig: (c) => c && c.id,
    refreshConv: (c) => { ctx.S.conv = c; }, setTopTitle() {},
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const authState ='), source.indexOf('const scopedLinks =')) + '\nthis.authState = authState;', ctx);
  vm.runInContext(source.slice(source.indexOf('const local ='), source.indexOf('const CONV_CACHE_MAX')) + '\nthis.local = local;', ctx);
  vm.runInContext(source.slice(source.indexOf('const draftLsKey ='), source.indexOf('async function send(')), ctx);
  vm.runInContext(['send', 'resetAccount', 'showLogin', 'upload', 'runUpload', 'removeAtt', 'attChanged', 'showConv', 'openConv', 'newChat', 'openProject', 'openProjects'].map(extract).join('\n'), ctx);
  return { ctx, storage, elements, element, cacheData, cacheOps, blobData };
}
(async () => {
  await check('expired auth clears old new-chat draft, attachment, pending requests and wake identity before next login', async () => {
    const h = harness(), c = h.ctx, pending = new AbortController();
    h.element('#input').value = 'Alice private draft';
    c.S.atts = [{ path: 'private.txt' }]; c.S.draftId = 'alice-draft';
    h.storage.set('draft@alice:n', JSON.stringify({ text: 'private', atts: [] }));
    h.storage.set('relayWakeToken', 'old-wake');
    c.authState.requests.add(pending); c.pendingUploads.set('p', { cancelled: false });
    c.showLogin();
    assert.equal(pending.signal.aborted, true);
    assert.equal(c.S.draftFor, null); assert.equal(c.S.atts.length, 0); assert.equal(h.element('#input').value, '');
    assert.equal(h.storage.has('draft@alice:n'), false); assert.equal(h.storage.has('relayWakeToken'), false);
    c.authState.user = 'bob'; h.storage.set('lastUserId', 'bob'); c.newChat();
    assert.equal(h.element('#input').value, ''); assert.equal(c.S.atts.length, 0);
    assert.equal(c.S.draftId, null); assert.equal(c.S.draftFor, 'n');
    await c.local.queue;
  });
  await check('queued old cache writes cannot reappear under a new account', async () => {
    const h = harness(), c = h.ctx;
    c.local.put('state', { private: 'Alice' });
    c.resetAccount('bob'); c.local.put('state', { private: 'Bob' });
    await c.local.queue;
    assert.deepEqual([...h.cacheData.keys()], ['/__data/bob/state']);
    assert.equal(JSON.parse(h.cacheData.get('/__data/bob/state')).private, 'Bob');
    assert.ok(!h.cacheOps.some((x) => x[0] === 'put' && x[1].includes('alice')));
  });
  await check('cache writes already in progress are cleared before new account writes', async () => {
    const h = harness(), c = h.ctx, gate = deferred();
    const originalOpen = c.caches.open;
    c.caches.open = async (name) => { if (name === 'data') await gate.promise; return originalOpen(name); };
    c.local.put('conv/a', { private: 'Alice' }); await tick();
    c.resetAccount('bob'); c.local.put('state', { private: 'Bob' }); gate.resolve();
    await c.local.queue;
    assert.deepEqual([...h.cacheData.keys()], ['/__data/bob/state']);
  });
  await check('normal cache write/read stays available to its owner', async () => {
    const h = harness();
    await h.ctx.local.put('state', { name: 'Alice' });
    assert.equal((await h.ctx.local.get('state')).name, 'Alice');
  });
  await check('batch destinations and draft persistence remain attached to original conversation after navigation', async () => {
    const h = harness(), c = h.ctx, destinations = [], tasks = [];
    c.S.conv = { id: 'a' }; c.S.convId = 'a'; c.S.draftFor = 'c:a';
    h.element('#input').value = 'Alice original text';
    c.post = async (_url, body) => { destinations.push(body); return { id: 'server-' + destinations.length }; };
    c.runUpload = (a) => new Promise((resolve) => tasks.push(() => {
      Object.assign(a, { path: 'chats/a/uploads/' + a.name, uploading: false, uploadId: undefined });
      c.attChanged(a); resolve();
    }));
    const job = c.upload([{ name: 'one.txt', size: 1, type: 'text/plain' }, { name: 'two.txt', size: 1, type: 'text/plain' }]);
    await tick();
    c.showConv({ id: 'b', messages: [] }, true); h.element('#input').value = 'Bob context draft';
    tasks.shift()(); await tick(); tasks.shift()(); await job;
    assert.deepEqual(destinations.map((d) => d.conv), ['a', 'a']);
    assert.equal(c.S.convId, 'b'); assert.equal(c.S.atts.length, 0); assert.equal(h.element('#input').value, 'Bob context draft');
    c.showConv({ id: 'a', messages: [] }, true);
    assert.equal(c.S.atts.length, 2); assert.ok(c.S.atts.every((a) => a.path.startsWith('chats/a/uploads/')));
    assert.equal(h.element('#input').value, 'Alice original text');
  });
  await check('new-chat upload retains its server folder identity after leaving and returning', async () => {
    const h = harness(), c = h.ctx, gate = deferred();
    c.post = async () => ({ id: 'server-one' });
    c.runUpload = async (a) => { await gate.promise; Object.assign(a, { path: 'chats/original/uploads/a.txt', uploading: false, uploadId: undefined }); c.attChanged(a); };
    const job = c.upload([{ name: 'a.txt', size: 1, type: 'text/plain' }]); await tick();
    const original = c.S.draftId;
    c.showConv({ id: 'other', messages: [] }, true); gate.resolve(); await job; c.newChat();
    assert.equal(c.S.draftId, original); assert.equal(c.S.atts.length, 1); assert.ok(c.S.atts[0].path);
  });
  await check('batch aborted by account switch never starts the remaining file with the new credentials', async () => {
    const h = harness(), c = h.ctx, gate = deferred(), requests = [];
    c.post = async (_url, data) => { requests.push(data); return gate.promise; };
    const job = c.upload([{ name: 'one.txt', size: 1, type: 'text/plain' }, { name: 'two.txt', size: 1, type: 'text/plain' }]);
    c.resetAccount('bob'); gate.resolve({ id: 'old-upload' }); await job;
    assert.equal(requests.length, 1); assert.equal(h.blobData.size, 0); assert.equal(c.S.atts.length, 0);
  });
  await check('removing a queued batch attachment prevents its upload-start request', async () => {
    const h = harness(), c = h.ctx, gate = deferred(), names = [];
    c.post = async (_url, data) => { names.push(data.name); return { id: 'upload-one' }; };
    c.runUpload = async (a) => { await gate.promise; a.uploading = false; };
    const job = c.upload([{ name: 'one.txt', size: 1, type: 'text/plain' }, { name: 'two.txt', size: 1, type: 'text/plain' }]);
    c.removeAtt(c.S.atts[1]); await tick(); gate.resolve(); await job;
    assert.deepEqual(names, ['one.txt']);
  });
  await check('completed upload receipt does not send another chunk', async () => {
    const h = harness(), c = h.ctx, methods = [];
    const a = { uploadId: 'one', name: 'a.txt', uploading: true, size: 1, owner: 'alice', epoch: 0, draftKey: 'n' };
    c.S.atts = [a];
    c.fetch = async (_url, opts) => { methods.push(opts.method || 'GET'); return { ok: true, status: 200, json: async () => ({ done: true, received: 1, path: 'a.txt', name: 'a.txt', size: 1 }) }; };
    await c.runUpload(a, { slice() { throw Error('no chunk expected'); } });
    assert.deepEqual(methods, ['GET']); assert.equal(a.uploading, false); assert.equal(a.path, 'a.txt');
  });
  await check('upload status arriving after account reset cannot send a chunk', async () => {
    const h = harness(), c = h.ctx, gate = deferred(), methods = [];
    const a = { uploadId: 'one', name: 'a.txt', uploading: true, size: 1, owner: 'alice', epoch: 0, draftKey: 'n' };
    c.S.atts = [a];
    c.fetch = async (_url, opts) => { methods.push(opts.method || 'GET'); return gate.promise; };
    const job = c.runUpload(a, { slice: () => 'content' });
    await tick(); c.resetAccount('bob');
    gate.resolve({ ok: true, status: 200, json: async () => ({ received: 0 }) }); await job;
    assert.deepEqual(methods, ['GET']); assert.equal(c.S.atts.length, 0);
  });
  await check('late project response cannot override a later chat navigation', async () => {
    const h = harness(), c = h.ctx, project = deferred();
    c.api = (url) => url.includes('/projects/') ? project.promise : Promise.resolve({ id: 'chat-b', messages: [] });
    const first = c.openProject('project-a'); await c.openConv('chat-b', true);
    project.resolve({ project: { id: 'project-a' } }); await first;
    assert.equal(c.S.view, 'chat'); assert.equal(c.S.convId, 'chat-b');
  });
  await check('late chat response cannot override a later project navigation', async () => {
    const h = harness(), c = h.ctx, chat = deferred();
    c.api = (url) => url.includes('/conversations/') ? chat.promise : Promise.resolve({ project: { id: 'project-b' } });
    const first = c.openConv('chat-a', true); await tick(); await c.openProject('project-b');
    chat.resolve({ id: 'chat-a', messages: [] }); await first;
    assert.equal(c.S.view, 'project'); assert.equal(c.S.projectId, 'project-b'); assert.equal(c.S.convId, null);
  });
  await check('project list navigation invalidates a pending project detail request', async () => {
    const h = harness(), c = h.ctx, project = deferred();
    c.api = (url) => url === '/api/projects' ? Promise.resolve({ projects: [] }) : project.promise;
    c.esc = (x) => x; c.icon = c.crab = () => '';
    const first = c.openProject('project-a'); await c.openProjects();
    project.resolve({ project: { id: 'project-a' } }); await first;
    assert.equal(c.S.view, 'projects'); assert.equal(c.S.projectId, null);
  });
  await check('background chat refresh cannot steal a completed project navigation', async () => {
    const h = harness(), c = h.ctx, refresh = deferred();
    c.S.convId = 'chat-a'; c.S.conv = { id: 'chat-a' };
    c.api = (url) => url.includes('/conversations/') ? refresh.promise : Promise.resolve({ project: { id: 'project-b' } });
    const bg = c.openConv('chat-a', true, true); await c.openProject('project-b');
    refresh.resolve({ id: 'chat-a', messages: [] }); await bg;
    assert.equal(c.S.view, 'project'); assert.equal(c.S.projectId, 'project-b');
  });
  await check('current project and chat navigations still succeed', async () => {
    const h = harness(), c = h.ctx;
    c.api = async (url) => url.includes('/projects/') ? { project: { id: 'p' } } : { id: 'c', messages: [] };
    await c.openProject('p'); assert.equal(c.S.projectId, 'p'); assert.equal(c.S.view, 'project');
    await c.openConv('c', true); assert.equal(c.S.convId, 'c'); assert.equal(c.S.view, 'chat');
  });
  await check('fetch rejects old response bodies and aborts their transport at identity reset', async () => {
    const h = harness(), c = h.ctx, body = deferred();
    let signal;
    const response = { headers: new Headers(), body: {}, json: () => body.promise, text: () => body.promise,
      blob: () => body.promise, arrayBuffer: () => body.promise, formData: () => body.promise };
    c.window = c; c.fetch = async (_input, init) => { signal = init.signal; return response; };
    const begin = source.indexOf('{\n  const nativeFetch = window.fetch.bind(window);');
    assert.ok(begin >= 0);
    vm.runInContext(source.slice(begin, source.indexOf('// 像素小螃蟹', begin)), c);
    const r = await c.fetch('/api/state'), pending = r.json();
    c.resetAccount('bob'); body.resolve({ userId: 'alice', secret: 'private' });
    await assert.rejects(pending, (e) => e.staleAccount === true);
    assert.equal(signal.aborted, true);
  });

  await check('delayed first chat acknowledgement preserves a separate new draft and its uploaded file folder', async () => {
    const h = harness(), c = h.ctx, chatRequests = [], uploadTargets = [];
    c.S.draftId = 'first-draft'; c.S.draftOwnerId = 'first-draft';
    h.element('#input').value = 'first message';
    c.post = (url, body) => {
      if (url === '/api/chat') { const wait = deferred(); chatRequests.push({ body, wait }); return wait.promise; }
      uploadTargets.push(body.conv); return Promise.resolve({ id: 'upload-second' });
    };
    c.runUpload = async (a) => { Object.assign(a, { path: 'chats/' + uploadTargets.at(-1) + '/uploads/' + a.name, uploading: false, uploadId: undefined }); c.attChanged(a); };
    const first = c.send();
    assert.equal(c.S.draftId, null); assert.equal(c.S.draftOwnerId, null); assert.equal(c.S.draftFor, 'c:first-draft');
    c.newChat(); h.element('#input').value = 'second message';
    await c.upload([{ name: 'second.txt', size: 1, type: 'text/plain' }]);
    const secondId = c.S.draftId;
    assert.notEqual(secondId, 'first-draft'); assert.equal(uploadTargets[0], secondId);
    chatRequests[0].wait.resolve({ conversationId: 'first-draft', msgIndex: 1, title: 'First', startedAt: 1 });
    await first;
    assert.equal(c.S.conv, null); assert.equal(c.S.draftId, secondId); assert.equal(c.S.draftOwnerId, secondId);
    assert.equal(h.element('#input').value, 'second message');
    const second = c.send();
    assert.equal(chatRequests[1].body.newId, secondId);
    assert.equal(chatRequests[1].body.attachments[0].path, 'chats/' + secondId + '/uploads/second.txt');
    chatRequests[1].wait.resolve({ conversationId: secondId, msgIndex: 1, title: 'Second', startedAt: 2 });
    await second;
    assert.equal(c.S.convId, secondId); assert.equal(c.S.conv.id, secondId);
  });
  await check('reverse-order acknowledgements never replace the newer optimistic conversation', async () => {
    const h = harness(), c = h.ctx, requests = [];
    c.post = (_url, body) => { const wait = deferred(); requests.push({ body, wait }); return wait.promise; };
    h.element('#input').value = 'first'; const first = c.send(), firstId = requests[0].body.newId;
    c.newChat(); h.element('#input').value = 'second'; const second = c.send(), secondId = requests[1].body.newId;
    assert.notEqual(firstId, secondId);
    const optimisticSecond = c.S.conv;
    requests[1].wait.resolve({ conversationId: secondId, msgIndex: 1, title: 'Second', startedAt: 2 }); await second;
    requests[0].wait.resolve({ conversationId: firstId, msgIndex: 1, title: 'First', startedAt: 1 }); await first;
    assert.equal(c.S.conv, optimisticSecond); assert.equal(c.S.convId, secondId); assert.equal(c.S.conv.title, 'Second');
  });
  await check('uploads during first-send confirmation stay with that conversation and duplicate submit is blocked', async () => {
    const h = harness(), c = h.ctx, acknowledgement = deferred(), chatBodies = [], uploads = [];
    c.post = (url, body) => {
      if (url === '/api/chat') { chatBodies.push(body); return acknowledgement.promise; }
      uploads.push(body.conv); return Promise.resolve({ id: 'upload-followup' });
    };
    c.runUpload = async (a) => { Object.assign(a, { path: 'chats/' + uploads.at(-1) + '/uploads/' + a.name, uploading: false, uploadId: undefined }); c.attChanged(a); };
    h.element('#input').value = 'first'; const first = c.send(), id = chatBodies[0].newId;
    h.element('#input').value = 'next message'; await c.send();
    assert.equal(chatBodies.length, 1);
    await c.upload([{ name: 'followup.txt', size: 1, type: 'text/plain' }]);
    assert.equal(uploads[0], id); assert.equal(c.S.draftFor, 'c:' + id);
    acknowledgement.resolve({ conversationId: id, msgIndex: 1, title: 'First', startedAt: 1 }); await first;
    assert.equal(c.S.convId, id); assert.equal(c.S.atts.length, 1); assert.equal(h.element('#input').value, 'next message');
  });
  await check('failed first submit restores its identity without dropping a followup draft or upload', async () => {
    const h = harness(), c = h.ctx, acknowledgement = deferred(), uploads = [];
    let body;
    c.post = (url, data) => {
      if (url === '/api/chat') { body = data; return acknowledgement.promise; }
      uploads.push(data.conv); return Promise.resolve({ id: 'upload-followup' });
    };
    c.runUpload = async (a) => { Object.assign(a, { path: 'chats/' + uploads.at(-1) + '/uploads/' + a.name, uploading: false, uploadId: undefined }); c.attChanged(a); };
    h.element('#input').value = 'submitted'; const first = c.send();
    h.element('#input').value = 'unsent followup';
    await c.upload([{ name: 'followup.txt', size: 1, type: 'text/plain' }]);
    acknowledgement.reject(new Error('connection failed')); await first;
    assert.equal(c.S.conv, null); assert.equal(c.S.draftId, body.newId); assert.equal(c.S.draftOwnerId, body.newId);
    assert.equal(c.S.draftFor, 'n'); assert.equal(h.element('#input').value, 'unsent followup');
    assert.equal(c.S.atts[0].path, 'chats/' + body.newId + '/uploads/followup.txt');
    const draft = JSON.parse(h.storage.get('draft@alice:n'));
    assert.equal(draft.draftId, body.newId); assert.equal(draft.text, 'unsent followup');
  });
  await check('cross-tab account switch cancels the old draft timer without deleting the new account data', async () => {
    const h = harness(), c = h.ctx, timers = [], cancelled = new Set(), handlers = {};
    c.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    c.clearTimeout = (id) => cancelled.add(id);
    c.addEventListener = (name, fn) => { handlers[name] = fn; };
    let reloads = 0;
    c.location = { reload: () => reloads++ };
    h.element('#input').value = 'Alice private unsent draft';
    c.S.draftUser = 'alice'; c.S.draftFor = 'n';
    vm.runInContext('saveDraftSoon()', c);
    h.storage.set('lastUserId', 'bob'); h.storage.set('relayToken', 'bob-token');
    h.storage.set('draft@bob:n', JSON.stringify({ text: 'Bob own draft', atts: [] }));
    // 即使旧 timer 已经进入事件队列、先于 storage 回调运行，也不能按共享的新账号写入。
    timers[0]();
    assert.equal(vm.runInContext("accountCurrent(0, 'alice')", c), false);
    assert.equal(JSON.parse(h.storage.get('draft@bob:n')).text, 'Bob own draft');
    const begin = source.indexOf("addEventListener('storage', (e) => {");
    assert.ok(begin >= 0);
    vm.runInContext(source.slice(begin, source.indexOf('let dragDepth', begin)), c);
    handlers.storage({ key: 'lastUserId', oldValue: 'alice', newValue: 'bob' });
    assert.equal(reloads, 1); assert.ok(cancelled.has(1));
    assert.equal(h.element('#input').value, ''); assert.equal(c.S.draftFor, null); assert.equal(c.S.atts.length, 0);
    timers[0](); // 模拟 reload 尚未完成、已出队旧回调仍被执行。
    assert.equal(h.storage.get('lastUserId'), 'bob'); assert.equal(h.storage.get('relayToken'), 'bob-token');
    assert.equal(JSON.parse(h.storage.get('draft@bob:n')).text, 'Bob own draft');
    assert.equal(h.storage.has('draft@:n'), false);
  });


  await check('API identity mismatch rejects before transport and does not throw synchronously', async () => {
    const h = harness(), c = h.ctx;
    let transportCalls = 0;
    c.window = c; c.fetch = async () => { transportCalls++; return new Response('{}'); };
    const begin = source.indexOf('{\n  const nativeFetch = window.fetch.bind(window);');
    vm.runInContext(source.slice(begin, source.indexOf('// 像素小螃蟹', begin)), c);
    h.storage.set('lastUserId', 'bob'); h.storage.set('relayToken', 'bob-token');
    let result;
    assert.doesNotThrow(() => { result = c.fetch('/api/chat', { method: 'POST', body: '{"message":"Alice private draft"}' }); });
    assert.equal(typeof result.then, 'function');
    await assert.rejects(result, (e) => e.staleAccount === true);
    assert.equal(transportCalls, 0); assert.equal(c.authState.requests.size, 0);
  });
  await check('API requests assert their originating account while anonymous login omits the assertion', async () => {
    const h = harness(), c = h.ctx, calls = [];
    c.window = c; c.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
    const begin = source.indexOf('{\n  const nativeFetch = window.fetch.bind(window);');
    vm.runInContext(source.slice(begin, source.indexOf('// 像素小螃蟹', begin)), c);
    await (await c.fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-User': 'wrong-account' }, body: '{}' })).json();
    assert.equal(calls[0].init.headers.get('X-Relay-User'), 'alice');
    assert.equal(calls[0].init.headers.get('X-Relay-Token'), 'alice.token');
    assert.equal(calls[0].init.headers.get('Content-Type'), 'application/json');
    c.resetAccount();
    await (await c.fetch('/api/login', { method: 'POST', headers: { 'X-Relay-User': 'old-account' }, body: '{}' })).json();
    assert.equal(calls[1].init.headers.has('X-Relay-User'), false);
    assert.equal(calls[1].init.headers.has('X-Relay-Token'), false);
  });

  await check('GPT keeps API pricing and displays the recorded API cost with token usage', () => {
    const begin = source.indexOf('    const secs =');
    const end = source.indexOf('    acts.innerHTML', begin);
    const ctx = vm.createContext({ fmtElapsed: () => '1 秒', fmtTokens: (n) => String(n) });
    vm.runInContext('function label(msg) { ' + source.slice(begin, end) + ' return secs; }', ctx);
    assert.equal(ctx.label({ provider: 'openai', cost: 0.125, usage: { input_tokens: 20, output_tokens: 10 } }), ' · 30 tokens · $0.125');
    assert.equal(ctx.label({ provider: 'anthropic', cost: 2 }), '');
    assert.ok(source.includes('GPT · OpenAI，按 API 用量计费'));
    assert.ok(!source.includes('使用本机 ChatGPT 订阅额度'));
  });
  console.log('All ' + passed + ' frontend state checks passed (actual source, in-memory dependencies).');
})().catch((error) => { console.error(error); process.exitCode = 1; });
