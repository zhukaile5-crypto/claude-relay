'use strict';
// Read the actual patched functions; all requests, storage and DOM stay in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = process.argv[2] || path.join(process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..'), 'public', 'index.html');
const source = fs.readFileSync(sourcePath, 'utf8');
const extract = (name) => {
  const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}', 'm'));
  assert.ok(match, 'Missing source function: ' + name);
  return match[0];
};
const plain = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

function sendHarness({ fresh = false } = {}) {
  const storage = new Map();
  const elements = { '#input': { value: 'pending message' }, '#sendBtn': { disabled: false }, '#perch .crab': {} };
  const attachment = { path: 'chats/original/uploads/a.txt', name: 'a.txt', size: 9 };
  let rejectRequest, rejectRefresh;
  const ctx = {
    authState: { epoch: 0, user: 'synthetic' }, accountCurrent: () => true,
    choiceSerial: 0, flushChoice() {}, cancelPendingChoices() {}, restoreConversationChoice() {}, selectedChoice() {},
    captureConversationChoice: () => ({ current: () => true }), reconcileConversationChoice: (conv) => conv, restorePendingChoices() {},
    S: { nav: 4, convId: fresh ? null : 'original', conv: fresh ? null : { id: 'original', title: 'Original', messages: [{ role: 'user', text: 'earlier message' }] },
      draftFor: fresh ? 'n' : 'c:original', draftId: fresh ? 'draft-one' : null, projectId: null, view: 'chat',
      model: 'test-model', effort: 'low', tool: 'word', atts: [attachment], skew: 0, running: new Set(), convs: [] },
    $: (selector) => elements[selector],
    ls: { get: (key, fallback) => storage.get(key) ?? fallback, set: (key, value) => storage.set(key, value), del: (key) => storage.delete(key) },
    local: { user: () => 'test-user' },
    post: () => new Promise((_resolve, reject) => { rejectRequest = reject; }),
    api: () => new Promise((_resolve, reject) => { rejectRefresh = reject; }),
    renderThread: () => {}, renderAtts: () => {}, updateSendBtn: () => {}, hop: () => {}, autoGrow: () => {}, toast: () => {},
    setTool: (value) => { ctx.S.tool = value; }, setView: (value) => { ctx.S.view = value; },
    newDraftId: () => 'generated-draft', clearTimeout,
  };
  vm.createContext(ctx);
  const draftSource = source.slice(source.indexOf('const draftLsKey ='), source.indexOf('const saveDraftSoon ='));
  assert.ok(draftSource.includes('function saveDraft'));
  vm.runInContext(draftSource + '\n' + extract('send') + '\n' + extract('openConv'), ctx);
  return { ctx, elements, storage, attachment, fail: () => rejectRequest(new Error('simulated network failure')),
    endRefresh: () => rejectRefresh(new Error('simulated refresh failure')) };
}

function mathHarness() {
  const calls = [];
  const ctx = {
    texCache: new Map(),
    marked: { parse: (text) => '<p>' + text + '</p>' },
    DOMPurify: { sanitize: (html) => html },
    katex: { renderToString: (tex, options) => { calls.push({ tex, display: options.displayMode }); return '<math>' + tex + '</math>'; } },
    esc: (value) => String(value),
    document: { createElement: () => ({ innerHTML: '', className: '', querySelectorAll: () => [] }) },
  };
  vm.createContext(ctx); vm.runInContext(extract('renderMd'), ctx);
  return { render: (text) => ctx.renderMd(text).innerHTML, calls };
}

(async () => {
  await check('same conversation failure restores text, attachment, tool and saved draft', async () => {
    const h = sendHarness(), before = plain(h.ctx.S.conv);
    const pending = h.ctx.send();
    assert.equal(h.elements['#input'].value, ''); assert.equal(h.ctx.S.atts.length, 0);
    h.fail(); await pending;
    assert.deepEqual(plain(h.ctx.S.conv), before);
    assert.equal(h.ctx.S.convId, 'original');
    assert.equal(h.elements['#input'].value, 'pending message');
    assert.equal(h.ctx.S.atts[0], h.attachment); assert.equal(h.ctx.S.tool, 'word');
    const draft = JSON.parse(h.storage.get('draft@test-user:c:original'));
    assert.equal(draft.text, 'pending message'); assert.deepEqual(draft.atts, [h.attachment]); assert.equal(draft.tool, 'word');
  });

  await check('same-conversation background refresh increments nav but still allows pending-send recovery', async () => {
    const h = sendHarness(), before = plain(h.ctx.S.conv), nav = h.ctx.S.nav;
    const pending = h.ctx.send();
    const optimistic = h.ctx.S.conv, refresh = h.ctx.openConv('original', true);
    assert.equal(h.ctx.S.nav, nav + 1); assert.equal(h.ctx.S.conv, optimistic);
    h.fail(); await pending;
    assert.deepEqual(plain(h.ctx.S.conv), before);
    assert.equal(h.elements['#input'].value, 'pending message'); assert.equal(h.ctx.S.atts[0], h.attachment); assert.equal(h.ctx.S.tool, 'word');
    h.endRefresh(); await refresh;
  });

  for (const kind of ['text', 'attachment', 'tool', 'combined']) {
    await check('same-conversation failure preserves the new ' + kind + ' draft while rolling back optimistic messages', async () => {
      const h = sendHarness(), before = plain(h.ctx.S.conv), pending = h.ctx.send();
      if (kind === 'text' || kind === 'combined') h.elements['#input'].value = 'next message draft';
      if (kind === 'attachment' || kind === 'combined') h.ctx.S.atts = [{ path: 'next.txt', name: 'next.txt', size: 3 }];
      if (kind === 'tool' || kind === 'combined') h.ctx.S.tool = 'slides';
      vm.runInContext('saveDraft()', h.ctx);
      const nextText = h.elements['#input'].value, nextAtts = h.ctx.S.atts, nextTool = h.ctx.S.tool;
      const saved = h.storage.get('draft@test-user:c:original');
      h.fail(); await pending;
      assert.deepEqual(plain(h.ctx.S.conv), before);
      assert.equal(h.elements['#input'].value, nextText); assert.equal(h.ctx.S.atts, nextAtts); assert.equal(h.ctx.S.tool, nextTool);
      assert.equal(h.storage.get('draft@test-user:c:original'), saved);
    });
  }

  await check('a fresh server object for the same conversation is never replaced by the old snapshot', async () => {
    const h = sendHarness(), pending = h.ctx.send();
    const fresh = { id: 'original', title: 'Updated on server', messages: [{ role: 'assistant', text: 'fresh server reply' }] };
    h.ctx.S.conv = fresh;
    h.fail(); await pending;
    assert.equal(h.ctx.S.conv, fresh); assert.equal(h.ctx.S.convId, 'original');
    assert.equal(h.elements['#input'].value, ''); assert.equal(h.ctx.S.atts.length, 0); assert.equal(h.ctx.S.tool, null);
    assert.equal(h.storage.has('draft@test-user:c:original'), false);
  });

  await check('failure after switching conversations leaves the new conversation and draft intact', async () => {
    const h = sendHarness(), pending = h.ctx.send();
    h.ctx.S.nav++; h.ctx.S.convId = 'other'; h.ctx.S.conv = { id: 'other', messages: [{ role: 'user', text: 'other content' }] };
    h.ctx.S.draftFor = 'c:other'; h.ctx.S.atts = [{ path: 'other.txt' }]; h.ctx.S.tool = 'slides'; h.elements['#input'].value = 'new draft';
    const state = plain(h.ctx.S.conv), atts = h.ctx.S.atts;
    h.fail(); await pending;
    assert.deepEqual(plain(h.ctx.S.conv), state); assert.equal(h.ctx.S.convId, 'other');
    assert.equal(h.elements['#input'].value, 'new draft'); assert.equal(h.ctx.S.atts, atts); assert.equal(h.ctx.S.tool, 'slides');
    assert.equal(h.storage.has('draft@test-user:c:other'), false);
  });

  await check('same new-conversation failure restores the original composer and draft identity', async () => {
    const h = sendHarness({ fresh: true }), pending = h.ctx.send();
    assert.equal(h.ctx.S.conv.id, 'draft-one');
    h.fail(); await pending;
    assert.equal(h.ctx.S.conv, null); assert.equal(h.ctx.S.convId, null); assert.equal(h.ctx.S.draftId, 'draft-one');
    assert.equal(h.elements['#input'].value, 'pending message'); assert.equal(h.ctx.S.atts[0], h.attachment);
    assert.equal(JSON.parse(h.storage.get('draft@test-user:n')).draftId, 'draft-one');
  });

  await check('two new conversations with null convId are distinguished by navigation and draft identity', async () => {
    const h = sendHarness({ fresh: true }), pending = h.ctx.send();
    h.ctx.S.nav++; h.ctx.S.conv = null; h.ctx.S.draftId = 'draft-two'; h.elements['#input'].value = 'second new draft';
    h.fail(); await pending;
    assert.equal(h.ctx.S.conv, null); assert.equal(h.ctx.S.convId, null); assert.equal(h.ctx.S.draftId, 'draft-two');
    assert.equal(h.elements['#input'].value, 'second new draft'); assert.equal(h.storage.has('draft@test-user:n'), false);
  });

  await check('different optimistic draft identity is protected even without a navigation increment', async () => {
    const h = sendHarness({ fresh: true }), pending = h.ctx.send();
    h.ctx.S.conv = { id: 'draft-two', messages: [] }; h.ctx.S.draftId = 'draft-two'; h.elements['#input'].value = 'second draft';
    h.fail(); await pending;
    assert.equal(h.ctx.S.conv.id, 'draft-two'); assert.equal(h.elements['#input'].value, 'second draft');
  });

  await check('retry/edit failure restores original messages without changing the composer', async () => {
    const h = sendHarness(), before = plain(h.ctx.S.conv);
    const pending = h.ctx.send({ text: 'edited message', attachments: [], fromIndex: 0 });
    h.fail(); await pending;
    assert.deepEqual(plain(h.ctx.S.conv), before); assert.equal(h.elements['#input'].value, 'pending message');
    assert.equal(h.ctx.S.atts[0], h.attachment);
  });

  await check('literal math placeholders do not crash or change text', () => {
    const h = mathHarness();
    const html = h.render('Literal @@MATH0@@ and @@MATH999@@ and @@MATH_0@@');
    assert.ok(html.includes('@@MATH0@@')); assert.ok(html.includes('@@MATH999@@')); assert.ok(html.includes('@@MATH_0@@')); assert.equal(h.calls.length, 0);
  });

  await check('literal placeholders and valid formulas coexist without replacing literal text', () => {
    const h = mathHarness(), html = h.render('@@MATH0@@ @@MATH_0@@ and $x+1$ then $$y^2$$');
    assert.ok(html.includes('@@MATH0@@')); assert.ok(html.includes('@@MATH_0@@'));
    assert.ok(html.includes('<math>x+1</math>')); assert.ok(html.includes('<math>y^2</math>'));
    assert.deepEqual(h.calls.map((x) => [x.tex, x.display]).sort(), [['x+1', false], ['y^2', true]]);
  });

  await check('valid inline and display formulas still render; code remains excluded', () => {
    const h = mathHarness(), html = h.render('Inline \\(x\\) display \\[z\\] code `$a$ @@MATH0@@`');
    assert.ok(html.includes('<math>x</math>')); assert.ok(html.includes('<math>z</math>')); assert.ok(html.includes('$a$ @@MATH0@@'));
    assert.deepEqual(h.calls.map((x) => [x.tex, x.display]).sort(), [['x', false], ['z', true]]);
  });
  console.log(`All ${passed} frontend regression checks passed (actual source, in-memory dependencies).`);
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
