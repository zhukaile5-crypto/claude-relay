'use strict';
// 对话分「聊天」和「工作」两种：聊天碰不到用户电脑上的文件，工作可以读、改用户电脑上的文件夹。
// 服务器：mode 的取值与默认、老对话的推断、新建后锁定、聊天模式下提示里不提文件夹也不让请求访问、编辑重试时带着 mode。
// 网页：顶栏的切换、默认值、没有桌面端时的限制、发第一条消息时带 mode、聊天模式下不带文件夹。
// 全部用合成账号和临时文件夹，不启动模型、不碰正式服务。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { fixture } = require('./model-server-fixture.cjs');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => JSON.parse(JSON.stringify(v));
const ID = 'a1b2c3d4e5f60718', FOLDER = [{ id: ID, name: '论文' }];

// ---------- 服务器 ----------
// 发一条消息，等模型那边收到提示；finish 让这一轮正常结束
async function chat(h, body) {
  const r = await h.route('/api/chat', 'POST', { message: '看看', model: 'sonnet', effort: 'high', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const child = h.calls.filter((c) => c.kind === 'claude').at(-1).child;
  await nap(30);
  const prompt = JSON.parse(child.input.trim().split('\n').pop()).message.content;
  return { id: r.body.conversationId, body: r.body, prompt, finish: async () => {
    child.stdout.write(JSON.stringify({ type: 'result', session_id: 's-' + r.body.msgIndex, result: '好', is_error: false }) + '\n');
    child.exitCode = 0; child.emit('close', 0); await nap(300);
  } };
}
const userMsgs = (h, id) => plain(h.api.loadConv(h.user, id).messages.filter((m) => m.role === 'user'));
const listed = (h) => JSON.parse(h.evaluate("JSON.stringify(listConvs(USERS.get('alice')))"));

test('服务器：mode 只认 chat 和 work；新建时没带就看这条消息带没带文件夹、项目是不是建在文件夹上', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '毕业论文', linked: FOLDER })).body;
  const plainProj = (await h.route('/api/projects', 'POST', { name: '随便聊聊' })).body;
  const cases = [
    [{ mode: 'chat' }, 'chat'], [{ mode: 'work' }, 'work'],
    [{ mode: 'chat', linked: FOLDER }, 'chat'],               // 用户明确选了聊天：带了文件夹也是聊天
    [{ mode: 'work', projectId: plainProj.id }, 'work'],
    [{}, 'chat'], [{ mode: 'admin' }, 'chat'], [{ mode: ['work'] }, 'chat'],
    [{ linked: FOLDER }, 'work'],                             // 旧页面：带着文件夹 → 工作
    [{ projectId: proj.id }, 'work'], [{ projectId: plainProj.id }, 'chat'],
  ];
  for (const [extra, want] of cases) {
    const c = await chat(h, extra);
    assert.equal(c.body.mode, want, JSON.stringify(extra));
    assert.equal(h.api.loadConv(h.user, c.id).mode, want, JSON.stringify(extra));
    await c.finish();
    assert.equal(h.api.loadConv(h.user, c.id).mode, want); // 这一轮结束保存时也还是它
  }
  // 对话列表（/api/state 里的 conversations 就是它）、单个对话、项目页的对话列表里都有 mode
  const list = listed(h);
  assert.equal(list.length, cases.length); assert.ok(list.every((c) => c.mode === 'chat' || c.mode === 'work'));
  const one = list.find((c) => c.mode === 'work' && !c.projectId);
  assert.equal((await h.route('/api/conversations/' + one.id)).body.mode, 'work');
  assert.deepEqual((await h.route('/api/projects/' + proj.id)).body.conversations.map((c) => c.mode), ['work']);
  assert.ok(source.includes('conversations: listConvs(u), projects: listProjects(u)')); // /api/state 给的就是这份列表
  assert.ok(source.includes("...(cid ? { conversation: conv ? withFileUrls(u, conv) : null } : {}),")); // 打开 App 时带回的那个对话也经过 withFileUrls，带着 mode
});

test('服务器：老对话没有 mode 时推断——关联过文件夹或在建在文件夹上的项目里是工作，否则聊天；只读不改存档，发消息时存上', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '项目', linked: FOLDER })).body;
  const mode = (conv) => h.evaluate(`conversationMode(USERS.get('alice'), ${JSON.stringify(conv)})`);
  assert.equal(mode({ id: 'x', messages: [] }), 'chat');
  assert.equal(mode({ id: 'x', messages: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b', linked: FOLDER }] }), 'work');
  assert.equal(mode({ id: 'x', messages: [{ role: 'user', linked: [{ id: 'bad', name: 'x' }] }] }), 'chat'); // 不像样的不算
  assert.equal(mode({ id: 'x', messages: [{ role: 'assistant', linked: FOLDER }] }), 'chat');
  assert.equal(mode({ id: 'x', projectId: proj.id, messages: [] }), 'work');
  assert.equal(mode({ id: 'x', mode: 'chat', projectId: proj.id, messages: [{ role: 'user', linked: FOLDER }] }), 'chat'); // 存着的为准
  assert.equal(mode({ id: 'x', mode: 'nope', messages: [] }), 'chat');
  assert.equal(h.evaluate(`conversationMode(undefined, { projectId: '${proj.id}', messages: [] })`), 'chat'); // 不知道账号时不去读项目
  // 存档里的老对话：列表和打开时都推断出来，但存档不改
  const old = { id: 'c'.repeat(16), title: '老对话', createdAt: 1, updatedAt: 2, titled: true, sessionId: null, model: 'sonnet', effort: 'high',
    messages: [{ role: 'user', text: '帮我改论文', linked: FOLDER }, { role: 'assistant', model: 'sonnet', status: 'done', result: '好', events: [] }] };
  const oldChat = { ...old, id: 'd'.repeat(16), messages: [{ role: 'user', text: '聊聊天' }, { role: 'assistant', model: 'sonnet', status: 'done', result: '好', events: [] }] };
  const oldInProject = { ...oldChat, id: 'e'.repeat(16), projectId: proj.id };
  for (const c of [old, oldChat, oldInProject]) h.api.saveConv(h.user, c);
  const modes = Object.fromEntries(listed(h).map((c) => [c.id, c.mode]));
  assert.deepEqual([modes[old.id], modes[oldChat.id], modes[oldInProject.id]], ['work', 'chat', 'work']);
  assert.equal((await h.route('/api/conversations/' + oldChat.id)).body.mode, 'chat');
  for (const c of [old, oldChat, oldInProject]) assert.equal(h.api.loadConv(h.user, c.id).mode, undefined); // 没有批量改写
  // 在老对话里发一条：mode 存上了，之后项目的文件夹再变也不跟着变
  const next = await chat(h, { conversationId: oldInProject.id });
  await next.finish();
  assert.equal(h.api.loadConv(h.user, oldInProject.id).mode, 'work');
  await h.route('/api/projects/' + proj.id, 'PATCH', { linked: [] });
  assert.equal((await h.route('/api/conversations/' + oldInProject.id)).body.mode, 'work');
});

test('服务器：对话建好后 mode 锁定——后面消息里带的 mode、PATCH 里的 mode 都不理；聊天的对话不存文件夹、不存 canTrust', async (t) => {
  const h = fixture(t);
  const first = await chat(h, { mode: 'chat', linked: FOLDER, canTrust: true });
  assert.ok(!first.prompt.includes('linked/') && !first.prompt.includes('请求访问'), first.prompt);
  await first.finish();
  const second = await chat(h, { conversationId: first.id, mode: 'work', linked: FOLDER, canTrust: true });
  assert.equal(second.body.mode, 'chat');
  assert.ok(!second.prompt.includes('已经关联到这个对话') && !second.prompt.includes('<<请求访问：'), second.prompt);
  await second.finish();
  const conv = h.api.loadConv(h.user, first.id);
  assert.equal(conv.mode, 'chat');
  for (const m of userMsgs(h, first.id)) { assert.equal(m.linked, undefined); assert.equal(m.canTrust, undefined); }
  const patched = await h.route('/api/conversations/' + first.id, 'PATCH', { mode: 'work', title: '改个名' });
  assert.equal(patched.status, 200); assert.equal(patched.body.conversation.mode, 'chat');
  assert.equal(h.api.loadConv(h.user, first.id).mode, 'chat'); assert.equal(h.api.loadConv(h.user, first.id).title, '改个名');
  // 工作的对话照旧：存文件夹和 canTrust，提示里都有；之后带 mode: 'chat' 也改不成聊天
  const work = await chat(h, { mode: 'work', linked: FOLDER, canTrust: true });
  assert.ok(work.prompt.includes(`文件夹「论文」已经关联到这个对话，它的副本在 ./linked/${ID}`)); assert.ok(work.prompt.includes('<<请求访问：桌面>>'));
  await work.finish();
  const again = await chat(h, { conversationId: work.id, mode: 'chat', linked: FOLDER, canTrust: true });
  assert.equal(again.body.mode, 'work'); assert.ok(again.prompt.includes('已经关联到这个对话'));
  await again.finish();
  assert.deepEqual(userMsgs(h, work.id).map((m) => [!!m.linked, m.canTrust]), [[true, true], [true, true]]);
});

test('服务器：buildPrompt——聊天的对话不提文件夹（项目建在文件夹上也不提）、不让请求访问；工作的照旧', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '项目', linked: FOLDER })).body;
  const prompt = (conv, linked, canTrust) => h.evaluate(`buildPrompt(USERS.get('alice'), ${JSON.stringify({ id: 'c0ffee00c0ffee00', ...conv })}, '整理一下', [], null, null, ${JSON.stringify(linked)}, ${canTrust})`);
  for (const conv of [{ mode: 'chat' }, { mode: 'chat', projectId: proj.id }]) {
    const p = prompt(conv, FOLDER, true);
    assert.ok(!p.includes('linked/'), p); assert.ok(!p.includes('请求访问'), p); assert.ok(!p.includes('用户电脑上'), p);
    assert.ok(p.includes('本对话的文件夹') && p.includes('outputs')); // 在服务器上做文件给用户下载照常
  }
  assert.ok(!prompt({ mode: 'chat', projectId: proj.id }, undefined, false).includes('linked/')); // 不走项目文件夹的回退
  const work = prompt({ mode: 'work' }, FOLDER, true);
  assert.ok(work.includes(`./linked/${ID}`)); assert.ok(work.includes('<<请求访问：桌面>>'));
  assert.ok(prompt({ mode: 'work', projectId: proj.id }, undefined, false).includes(`./linked/${ID}`)); // 项目的回退照旧
  assert.ok(prompt({ projectId: proj.id }, undefined, false).includes(`./linked/${ID}`)); // 老对话按推断
  assert.ok(!prompt({}, undefined, true).includes('请求访问'));                         // 老对话没关联过文件夹 → 聊天
});

test('服务器：聊天的对话里，回答末尾的请求访问、要文件的标记从正文里去掉，但不当成请求下发', async (t) => {
  const h = fixture(t);
  const reply = { role: 'assistant', status: 'done', events: [{ k: 'text', text: '先说明一下。\n<<请求访问：桌面>>' }, { k: 'text', text: '还要这个\n<<需要文件：linked/' + ID + '/a.md>>' }] };
  const out = (conv, extra = '') => JSON.parse(h.evaluate(`JSON.stringify(withFileUrls(USERS.get('alice'), ${JSON.stringify(conv)}${extra}))`));
  const asChat = out({ mode: 'chat', messages: [reply] });
  assert.equal(asChat.mode, 'chat');
  assert.equal(asChat.messages[0].accessRequest, undefined); assert.equal(asChat.messages[0].fileRequests, undefined);
  assert.equal(asChat.messages[0].events[0].text, '先说明一下。'); assert.equal(asChat.messages[0].events[1].text, '还要这个');
  const asWork = out({ mode: 'work', messages: [reply] });
  assert.equal(asWork.messages[0].accessRequest, '桌面'); assert.deepEqual(asWork.messages[0].fileRequests, ['linked/' + ID + '/a.md']);
  // 只给一条回复时由调用方给 mode（回复完成时推给网页的那条）
  assert.equal(out({ messages: [reply] }, ", 'work'").messages[0].accessRequest, '桌面');
  assert.equal(out({ messages: [reply] }).messages[0].accessRequest, undefined);
  assert.ok(source.includes("message: withFileUrls(u, { messages: [msg] }, conversationMode(u, conv)).messages[0]"));
});

test('服务器：编辑、重试还是同一个对话，带着原来的 mode；老对话在截断之前推断；新建对话只有一处，那里定 mode', async (t) => {
  const h = fixture(t);
  // 老对话：文件夹是在第二轮才关联的。从第二轮重来（把那一轮截掉）也还是工作
  const old = { id: 'f'.repeat(16), title: '老对话', createdAt: 1, updatedAt: 2, titled: true, sessionId: null, model: 'sonnet', effort: 'high', messages: [
    { role: 'user', text: '第一轮' }, { role: 'assistant', model: 'sonnet', status: 'done', result: '好', events: [] },
    { role: 'user', text: '第二轮', linked: FOLDER }, { role: 'assistant', model: 'sonnet', status: 'done', result: '好', events: [] }] };
  h.api.saveConv(h.user, old);
  const edit = await chat(h, { conversationId: old.id, fromIndex: 2, message: '第二轮改一下', linked: FOLDER });
  assert.equal(edit.body.mode, 'work'); assert.ok(edit.prompt.includes('已经关联到这个对话'));
  await edit.finish();
  assert.equal(h.api.loadConv(h.user, old.id).mode, 'work'); assert.equal(h.api.loadConv(h.user, old.id).messages.length, 4);
  // 聊天的对话重试：还是聊天
  const c = await chat(h, { mode: 'chat' }); await c.finish();
  const retry = await chat(h, { conversationId: c.id, fromIndex: 0, mode: 'work', linked: FOLDER, canTrust: true });
  assert.equal(retry.body.mode, 'chat'); assert.ok(!retry.prompt.includes('linked/'));
  await retry.finish();
  assert.equal(h.api.loadConv(h.user, c.id).mode, 'chat');
  // 服务器里只有一个地方造新对话；以后加「分支」「复制」之类的地方，要记得把 mode 带过去
  assert.equal(source.split('sessionId: null, messages: [] };').length - 1, 1);
  const made = source.indexOf('sessionId: null, messages: [] };');
  assert.ok(source.slice(made, made + 600).includes("conv.mode = validMode(body.mode) || (linkedList(body.linked).length || projectHasFolders(u, conv.projectId) ? 'work' : 'chat');"));
  const handler = source.slice(source.indexOf("if (p === '/api/chat' && req.method === 'POST') {"), source.indexOf("if (p === '/api/projects') {"));
  assert.ok(handler.indexOf('const mode = conversationMode(u, conv);') < handler.indexOf('conv.messages = conv.messages.slice(0, body.fromIndex);')); // 截断之前
  assert.match(handler, /if \(mode === 'work'\) \{[^}]*userMsg\.linked = linkedList\(body\.linked\);[^}]*userMsg\.canTrust = true;/);
});

// ---------- 网页 ----------
const line = (prefix) => { const i = page.indexOf(prefix); assert.ok(i >= 0, prefix); return page.slice(i, page.indexOf('\n', i)); };
const fn = (name) => { const m = page.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}', 'm')); assert.ok(m, name); return m[0]; };
const section = (() => { const a = page.indexOf('// ---------- 聊天 / 工作 ----------'), b = page.indexOf('// ---------- 关联文件夹（只有桌面端有）', a); assert.ok(a > 0 && b > a); return page.slice(a, b); })();

function fakeToggle() {
  const cls = () => { const set = new Set(); return { toggle: (k, on) => { if (on) set.add(k); else set.delete(k); }, contains: (k) => set.has(k) }; };
  const button = (m) => ({ dataset: { m }, classList: cls(), attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } });
  const buttons = [button('chat'), button('work')];
  return { dataset: {}, classList: cls(), buttons, querySelectorAll: () => buttons };
}
// 页面里「聊天 / 工作」这一段，连同它用到的 lfInfos、lfProject、draftKey，放在内存里跑
function modeHarness() {
  const c = vm.createContext({ toasts: [], renders: [] });
  vm.runInContext(`var S = {}, LF = { api: null }, store = {}, box = null;
    const ls = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };
    const $ = (sel) => (sel === '#chatMode' ? box : null);
    const toast = (t) => toasts.push(t), lfRender = () => renders.push(1);
    ${line('const lfInfos = ')}
    ${fn('lfProject')}
    ${line('const draftKey = ')}
    ${section}
    globalThis.m = { convModeOf, chatModeOfConv, chatModeOpen, chatModeCanWork, chatModeNow, renderChatMode, setChatMode,
      set: (s, api, st, b) => { S = s; LF = { api }; store = st; box = b || null; }, store: () => store, S: () => S };`, c);
  return c.m;
}
const PROJ = { id: 'abcd1234', name: '毕业论文', linked: [{ id: ID, name: '论文' }] }, BARE = { id: 'bcde2345', name: '随便', linked: [] };
const fresh = (extra = {}) => ({ view: 'chat', convId: null, conv: null, projectId: null, projects: [PROJ, BARE], convs: [], draftMode: null, ...extra });

test('网页：新对话默认用用户上次选的；建在文件夹上的项目里默认工作（不记）；切了就记下', () => {
  const m = modeHarness();
  m.set(fresh(), {}, {}); assert.equal(m.chatModeNow(), 'chat'); assert.equal(m.chatModeOpen(), true);
  m.set(fresh(), {}, { chatMode: 'work' }); assert.equal(m.chatModeNow(), 'work');
  m.set(fresh(), {}, { chatMode: 'whatever' }); assert.equal(m.chatModeNow(), 'chat');
  // 项目页的输入框：项目建在文件夹上 → 工作；普通项目 → 用户上次选的
  m.set(fresh({ view: 'project', projectId: PROJ.id }), {}, { chatMode: 'chat' }); assert.equal(m.chatModeNow(), 'work');
  assert.deepEqual(plain(m.store()), { chatMode: 'chat' }); // 因为项目有文件夹而默认成工作的不记
  m.set(fresh({ view: 'project', projectId: BARE.id }), {}, { chatMode: 'chat' }); assert.equal(m.chatModeNow(), 'chat');
  // 在项目里点了聊天：这个输入框就是聊天，也记下来
  m.set(fresh({ view: 'project', projectId: PROJ.id }), {}, {});
  m.setChatMode('chat'); assert.equal(m.chatModeNow(), 'chat'); assert.equal(m.store().chatMode, 'chat');
  assert.deepEqual(plain(m.S().draftMode), { key: 'p:' + PROJ.id, mode: 'chat' });
  // 换到别的输入框（新对话页），用户在项目里的那次点选不跟过去
  Object.assign(m.S(), { view: 'chat', projectId: null }); m.store().chatMode = 'work'; assert.equal(m.chatModeNow(), 'work');
});

test('网页：没有桌面端时新对话只能聊天，建在文件夹上的项目除外；已经是工作的老对话照常显示为工作', () => {
  const m = modeHarness(), box = fakeToggle();
  m.set(fresh(), null, { chatMode: 'work' }, box);
  assert.equal(m.chatModeNow(), 'chat'); assert.equal(m.chatModeCanWork(), false);
  m.renderChatMode();
  const [chatBtn, workBtn] = box.buttons;
  assert.equal(chatBtn.classList.contains('on'), true); assert.equal(workBtn.attrs['aria-disabled'], 'true');
  assert.equal(workBtn.title, '工作模式要在电脑上的 Claude 里用'); assert.equal(chatBtn.title, '只聊天，不碰你电脑上的文件');
  m.setChatMode('work'); assert.equal(m.chatModeNow(), 'chat'); // 点不动
  m.set(fresh({ view: 'project', projectId: PROJ.id }), null, {}, box);
  assert.equal(m.chatModeCanWork(), true); assert.equal(m.chatModeNow(), 'work');
  m.renderChatMode(); assert.equal(box.buttons[1].attrs['aria-disabled'], 'false'); assert.equal(box.buttons[1].title, '可以读和改你电脑上的文件夹');
  m.set(fresh({ convId: 'c0ffee00c0ffee00', conv: { id: 'c0ffee00c0ffee00', mode: 'work', messages: [] } }), null, {}, box);
  assert.equal(m.chatModeNow(), 'work');
});

test('网页：对话开始后锁住——显示它的 mode，两个都点不动，提示「对话开始后不能换模式」；正在发第一条时就锁', () => {
  const m = modeHarness(), box = fakeToggle();
  m.set(fresh({ convId: 'c1', conv: { id: 'c1', mode: 'chat', messages: [{ role: 'user', linked: [{ id: ID, name: 'x' }] }] } }), {}, { chatMode: 'work' }, box);
  assert.equal(m.chatModeOpen(), false); assert.equal(m.chatModeNow(), 'chat'); // 服务器给的为准
  m.renderChatMode();
  assert.ok(box.classList.contains('locked'));
  for (const b of box.buttons) { assert.equal(b.attrs['aria-disabled'], 'true'); assert.equal(b.title, '对话开始后不能换模式'); }
  assert.equal(box.buttons[0].classList.contains('on'), true); assert.equal(box.buttons[1].classList.contains('on'), false);
  m.setChatMode('work'); assert.equal(m.chatModeNow(), 'chat'); assert.equal(m.store().chatMode, 'work');
  // 发第一条的那一刻：S.convId 还没有，但 S.conv 已经有编号和 mode
  m.set(fresh({ conv: { id: 'draft1', mode: 'work', messages: [] } }), {}, { chatMode: 'chat' }, fakeToggle());
  assert.equal(m.chatModeOpen(), false); assert.equal(m.chatModeNow(), 'work');
  // 项目列表页没有输入框：不显示
  const hidden = fakeToggle(); m.set(fresh({ view: 'projects' }), {}, {}, hidden); m.renderChatMode(); assert.ok(hidden.classList.contains('hidden'));
});

test('网页：本机缓存里的老对话没有 mode——先看列表，再照服务器的规则推断', () => {
  const m = modeHarness();
  m.set(fresh({ convs: [{ id: 'c1', mode: 'work' }, { id: 'c2' }], projects: [PROJ] }), {}, {});
  assert.equal(m.convModeOf({ id: 'c1', messages: [] }), 'work');
  assert.equal(m.convModeOf({ id: 'c2', messages: [{ role: 'user', linked: [{ id: ID, name: '论文' }] }] }), 'work');
  assert.equal(m.convModeOf({ id: 'c2', projectId: PROJ.id, messages: [] }), 'work');
  assert.equal(m.convModeOf({ id: 'c2', messages: [{ role: 'user', text: 'hi' }] }), 'chat');
  assert.equal(m.chatModeOfConv('c1'), 'work'); assert.equal(m.chatModeOfConv('nope'), 'chat');
});

test('网页：顶栏有两段的切换，各有说明；发第一条消息时带 mode（在换到对话页之前取），之后的消息不带', async () => {
  assert.match(page, /<div id="convTitle"><\/div>\s*<button type="button" class="lf-global hidden" id="lfGlobal"[^>]*>[\s\S]{0,400}?<\/button>\s*<div class="chat-mode" id="chatMode" role="group" aria-label="对话模式"><svg class="icon cm-lock" aria-hidden="true"><use href="#i-lock"\/><\/svg><button type="button" data-m="chat" title="只聊天，不碰你电脑上的文件">聊天<\/button><button type="button" data-m="work" title="可以读和改你电脑上的文件夹">工作<\/button><\/div>\s*<button class="ibtn" id="topNew"/);
  assert.match(page, /\.chat-mode button \{ height: 26px; padding: 0 11px; border-radius: 7px; font-size: 13px;/);
  assert.ok(page.includes('html.wco #app.side-collapsed #chatMode { order: 2; }'));
  assert.ok(page.includes("if (typeof renderChatMode === 'function') renderChatMode(); // 顶栏右边的「聊天 / 工作」跟着标题一起画"));
  const send = fn('send');
  assert.ok(send.indexOf("if (!S.convId && typeof chatModeNow === 'function') body.mode = chatModeNow();") < send.indexOf("if (S.view !== 'chat') setView('chat');"));
  // 真把 send 跑一遍：项目页的新对话、已有的对话
  const run = async (S, mode) => {
    const posted = [], seen = [], storage = new Map();
    const ctx = vm.createContext({
      authState: { epoch: 0, user: 'synthetic' }, accountCurrent: () => true, choiceSerial: 0, flushChoice() {}, restoreConversationChoice() {}, selectedChoice() {},
      S: { nav: 1, draftId: null, model: 'm', effort: 'low', tool: null, atts: [], skew: 0, running: new Set(), convs: [], ...S },
      $: (s) => ({ '#input': { value: '你好' }, '#sendBtn': {}, '#perch .crab': {} })[s], ls: { get: (k, d) => storage.get(k) ?? d, set: (k, v) => storage.set(k, v), del: (k) => storage.delete(k) },
      local: { user: () => 'synthetic' }, newDraftId: () => 'd'.repeat(16), clearTimeout,
      chatModeNow: () => { seen.push(ctx.S.view); return mode; },
      lfBeforeSend: async (body) => { posted.push({ before: true, mode: body.mode }); },
      post: async (url, body) => { posted.push(plain(body)); return { conversationId: body.conversationId || body.newId, msgIndex: ctx.S.conv.messages.length - 1, title: '你好', startedAt: 1, mode: body.mode }; },
      renderThread() {}, renderAtts() {}, updateSendBtn() {}, hop() {}, autoGrow() {}, toast() {}, setTool() {}, setView: (v) => { ctx.S.view = v; },
      setTopTitle() {}, renderSidebar() {}, updatePerch() {}, rerenderMsg() {},
    });
    vm.runInContext(page.slice(page.indexOf('const draftLsKey ='), page.indexOf('const saveDraftSoon =')) + '\n' + send, ctx);
    await ctx.send();
    return { posted, seen, S: ctx.S };
  };
  const first = await run({ view: 'project', projectId: PROJ.id, convId: null, conv: null, draftFor: 'p:' + PROJ.id, draftMode: { key: 'p:' + PROJ.id, mode: 'chat' } }, 'chat');
  assert.deepEqual(first.seen, ['project']); // 取的是项目页输入框的
  const body = first.posted.find((x) => !x.before);
  assert.equal(body.mode, 'chat'); assert.equal(body.newId, 'd'.repeat(16)); assert.equal(body.projectId, PROJ.id);
  assert.equal(first.posted[0].mode, 'chat'); // lfBeforeSend 看得到
  assert.equal(first.S.conv.mode, 'chat'); assert.equal(first.S.convs[0].mode, 'chat'); assert.equal(first.S.draftMode, null);
  const later = await run({ view: 'chat', convId: 'c1', conv: { id: 'c1', mode: 'work', messages: [] }, draftFor: 'c:c1' }, 'chat');
  assert.deepEqual(later.seen, []); assert.equal(later.posted.find((x) => !x.before).mode, undefined);
});

test('网页：聊天模式下发消息不带文件夹、不带 canTrust、不同步；新对话里切回聊天发出去时收回草稿的授权，项目的不收', async () => {
  const c = vm.createContext({ dropped: [], runs: [] });
  vm.runInContext(`var S = { conv: null, convs: [] }, LF, modes = {};
    const chatModeOfConv = (id) => modes[id] || 'work';
    const lfScoped = (scope) => LF.links.filter((l) => l.scope === scope);
    const lfDropScope = async (scope) => { dropped.push(scope); };
    const lfCurrentAll = () => LF.links.filter((l) => l.scope === LF.cur);
    const lfStatus = () => {}, lfRun = async (l) => { runs.push(l.id); }, rerenderMsg = () => {};
    ${fn('lfBeforeSend')}
    globalThis.h = { lfBeforeSend, set: (lf, m) => { LF = lf; modes = m || {}; } };`, c);
  const lf = (cur, scope = cur) => ({ api: { trust() {} }, links: [{ id: ID, name: '论文', scope }], state: new Map(), status: new Map(), cur });
  let body = { mode: 'chat', newId: 'draft0000000001' };
  c.h.set(lf('draft0000000001')); await c.h.lfBeforeSend(body, body.newId);
  assert.equal(body.canTrust, undefined); assert.equal(body.linked, undefined); assert.deepEqual(plain(c.dropped), ['draft0000000001']); assert.deepEqual(plain(c.runs), []);
  body = { mode: 'chat', newId: 'draft0000000002', projectId: 'abcd1234' };
  c.h.set(lf('p:abcd1234')); await c.h.lfBeforeSend(body, body.newId);
  assert.equal(body.linked, undefined); assert.deepEqual(plain(c.dropped), ['draft0000000001']); // 项目的授权不动
  body = { conversationId: 'c1' };
  c.h.set(lf('c1'), { c1: 'chat' }); await c.h.lfBeforeSend(body, 'c1');
  assert.equal(body.linked, undefined); assert.equal(body.canTrust, undefined); assert.deepEqual(plain(c.runs), []);
  // 工作：照旧带上、先同步
  body = { mode: 'work', newId: 'draft0000000003' };
  c.h.set(lf('draft0000000003')); await c.h.lfBeforeSend(body, body.newId);
  assert.equal(body.canTrust, true); assert.deepEqual(plain(body.linked), [{ id: ID, name: '论文' }]); assert.deepEqual(plain(c.runs), [ID]);
  // 聊天时选文件夹、权限、文件夹条都收起来，回复结束不比对，请求访问的卡片不出
  const render = fn('lfRender');
  assert.ok(render.includes("btn.classList.toggle('hidden', !LF.api || !work);")); assert.ok(render.includes("modeBtn.classList.toggle('hidden', !LF.api || !work);"));
  assert.ok(render.includes('for (const info of work ? lfWanted() : []) {')); assert.ok(render.includes('if (!work) LF.scope = null;'));
  assert.ok(fn('lfAfterReply').includes("if (!LF.api || chatModeOfConv(convId) === 'chat') return;"));
  assert.ok(page.includes("typeof lfGrant === 'function' && LF.api?.trust && chatModeNow() === 'work') {"));
});
