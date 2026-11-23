'use strict';
// 两层记忆：账号的总记忆和每个项目自己的记忆。提示里说清楚各管什么、什么时候动、怎么整理；
// 一轮回复动了哪一份，记在那条回复上。只用合成账号和内存替身，不启动模型。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./model-server-fixture.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('总记忆的说明：项目各有各的记忆，这里每个项目只留一行；在不在项目里说法不同', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '毕业论文' })).body;
  const outside = h.evaluate(`memoryPrompt(USERS.get('alice'))`), inside = h.evaluate(`memoryPrompt(USERS.get('alice'), '${proj.id}')`);
  for (const text of [outside, inside]) {
    assert.ok(text.includes('./.memory/memory.md'));
    assert.match(text, /projects has its own separate memory/); assert.match(text, /one line per project under a heading "项目"/);
  }
  assert.match(outside, /not inside a project: do not edit any project memory from here/);
  assert.ok(!outside.includes('inside the project "毕业论文"')); // 项目名只出现在项目清单里
  assert.ok(inside.includes('inside the project "毕业论文"')); assert.match(inside, /go into its project memory[^.]*, never here/);
  assert.ok(!inside.includes('not inside a project'));
  // 不认识的项目编号按普通对话处理
  assert.match(h.evaluate(`memoryPrompt(USERS.get('alice'), 'ffffffff')`), /not inside a project/);
});

test('项目记忆的说明：两份记忆分开维护，先分类再写，读了再改，合并和清理，固定的几个标题', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '毕业论文' })).body;
  await h.route('/api/projects/' + proj.id, 'PATCH', { memory: '- 题目已定：超分辨成像' });
  const text = h.evaluate(`projectPrompt(USERS.get('alice'), '${proj.id}')`);
  assert.ok(text.includes(`./projects/${proj.id}/.project/memory.md is this project's own memory`)); assert.match(text, /used nowhere else/);
  assert.match(text, /you use both memories and maintain both, each for its own purpose/);
  assert.match(text, /as the last step of a turn/); assert.match(text, /If not, change nothing/);
  assert.match(text, /- about this project \([^)]*\): project memory;/);
  assert.match(text, /- about the user beyond this project \([^)]*\): personal memory;/);
  assert.match(text, /- a change in the overall state of the project \([^)]*\): project memory in detail, plus this project's one line under "项目" in personal memory\./);
  assert.match(text, /Read the file before you write to it/); assert.match(text, /replace outdated items instead of appending/); assert.match(text, /never keep the same detail in both memories/);
  assert.ok(text.includes('目标与范围 / 已定的事 / 进展 / 待办与未决 / 资料要点'));
  assert.ok(text.includes('Current project memory:\n- 题目已定：超分辨成像'));
  // 三家拿到的完整说明里，总记忆在前、项目记忆在后，两段都在
  for (const provider of ['anthropic', 'openai', 'google']) {
    const full = h.evaluate(`modelInstructions(USERS.get('alice'), '${proj.id}', '${provider}')`);
    assert.ok(full.indexOf('# Memory') > 0 && full.indexOf('# Memory') < full.indexOf('# Project: 毕业论文'), provider);
    assert.ok(full.includes('inside the project "毕业论文"'), provider); assert.ok(full.includes('目标与范围 / 已定的事'), provider);
  }
});

test('账号关了总记忆：不带总记忆，项目记忆照常，说明里不再让它去动总记忆', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '毕业论文' })).body;
  assert.equal((await h.route('/api/memory', 'PUT', { enabled: false })).status, 200);
  assert.equal(h.evaluate(`memoryPrompt(USERS.get('alice'), '${proj.id}')`), '');
  const text = h.evaluate(`projectPrompt(USERS.get('alice'), '${proj.id}')`);
  assert.match(text, /Personal memory is turned off for this account: do not read or write \.\/\.memory\/memory\.md/);
  assert.match(text, /- about this project/); assert.ok(text.includes('目标与范围'));
  assert.doesNotMatch(text, /personal memory;|in personal memory\.|maintain both|Your personal memory about the user/);
});

test('比对两份记忆：哪份内容变了；只多了空白不算，没有项目时不比项目', (t) => {
  const h = fixture(t), diff = (a, b) => JSON.parse(h.evaluate(`JSON.stringify(memoryChanges(${JSON.stringify(a)}, ${JSON.stringify(b)}))`));
  assert.deepEqual(diff({ account: 'a', project: 'p' }, { account: 'a', project: 'p' }), []);
  assert.deepEqual(diff({ account: 'a', project: 'p' }, { account: 'a\n- 新的一条', project: 'p' }), ['account']);
  assert.deepEqual(diff({ account: 'a', project: 'p' }, { account: 'a', project: 'p2' }), ['project']);
  assert.deepEqual(diff({ account: '', project: '' }, { account: 'x', project: 'y' }), ['account', 'project']);
  assert.deepEqual(diff({ account: 'a', project: 'p' }, { account: 'a\n\n', project: ' p ' }), []);
  assert.deepEqual(diff({ account: 'a', project: null }, { account: 'a', project: null }), []);
  assert.deepEqual(diff({ account: 'a', project: null }, { account: 'b', project: 'p' }), ['account']);
});

// 跑一轮合成对话：回复过程中由「模型」改记忆文件，结束后看那条回复上记了什么
async function turn(h, body, edit) {
  const before = h.calls.filter((c) => c.kind === 'claude').length;
  const r = await h.route('/api/chat', 'POST', { model: 'sonnet', effort: 'high', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = h.calls.filter((c) => c.kind === 'claude')[before].child;
  edit();
  p.stdout.write(JSON.stringify({ type: 'result', session_id: 'synthetic-' + before, result: '好的', is_error: false }) + '\n');
  p.exitCode = 0; p.emit('close', 0);
  let message;
  for (let i = 0; i < 60; i++) { // 改动的文件和记忆要等进程退出后才统计好
    message = (await h.route('/api/conversations/' + r.body.conversationId)).body.messages.at(-1);
    if (message.status === 'done' && Array.isArray(message.files)) break;
    await sleep(50);
  }
  return { id: r.body.conversationId, message };
}
const write = (h, rel, text) => h.io.writeTextSync(h.ctx, rel, text, { parents: true });

test('项目里的一轮对话：只动了项目记忆、两份都动了、都没动，分别记在那条回复上', async (t) => {
  const h = fixture(t);
  const proj = (await h.route('/api/projects', 'POST', { name: '毕业论文' })).body, pm = `projects/${proj.id}/.project/memory.md`;
  const first = await turn(h, { message: '第三章就按时间顺序写', projectId: proj.id }, () => write(h, pm, '## 已定的事\n- 第三章按时间顺序写\n'));
  assert.equal(first.message.status, 'done'); assert.deepEqual(first.message.memoryUpdated, ['project']);
  assert.deepEqual(first.message.memoryDelta, { project: { added: ['## 已定的事', '- 第三章按时间顺序写'], removed: [], more: 0 } });
  const second = await turn(h, { message: '另外我以后都想要简短的回答；论文初稿写完了', conversationId: first.id }, () => {
    write(h, '.memory/memory.md', '## 偏好\n- 回答要简短\n## 项目\n- 毕业论文：初稿已完成\n');
    write(h, pm, '## 已定的事\n- 第三章按时间顺序写\n## 进展\n- 初稿完成\n');
  });
  assert.deepEqual(second.message.memoryUpdated, ['account', 'project']);
  assert.deepEqual(second.message.memoryDelta.project, { added: ['## 进展', '- 初稿完成'], removed: [], more: 0 }); // 只列新加的两行，原有的不重复
  assert.deepEqual(second.message.memoryDelta.account.added, ['## 偏好', '- 回答要简短', '## 项目', '- 毕业论文：初稿已完成']);
  const third = await turn(h, { message: '谢谢', conversationId: first.id }, () => {});
  assert.equal(third.message.memoryUpdated, undefined); assert.equal(third.message.memoryDelta, undefined);
  // 下一轮的说明里带着更新后的两份记忆
  const full = h.evaluate(`modelInstructions(USERS.get('alice'), '${proj.id}', 'anthropic')`);
  assert.ok(full.includes('- 毕业论文：初稿已完成')); assert.ok(full.includes('- 初稿完成'));
  // 项目记忆不会跑到别的项目或普通对话里
  const other = (await h.route('/api/projects', 'POST', { name: '另一个项目' })).body;
  assert.ok(!h.evaluate(`modelInstructions(USERS.get('alice'), '${other.id}', 'anthropic')`).includes('第三章按时间顺序写'));
  const plain = h.evaluate(`modelInstructions(USERS.get('alice'), null, 'anthropic')`);
  assert.ok(!plain.includes('第三章按时间顺序写')); assert.ok(plain.includes('- 毕业论文：初稿已完成')); // 普通对话只从总记忆里那一行知道这个项目
});

test('普通对话：只可能动总记忆', async (t) => {
  const h = fixture(t);
  const r = await turn(h, { message: '记住我叫小林' }, () => write(h, '.memory/memory.md', '- 叫小林\n'));
  assert.deepEqual(r.message.memoryUpdated, ['account']);
});

test('网页：回复下面标出更新了哪份记忆，点了能去看；两处说明文字讲清两份记忆各管什么', () => {
  assert.ok(page.includes("if (!running && (msg.memoryUpdated || []).length) {"));
  assert.ok(page.includes("kinds.map((k) => (k === 'project' ? '项目记忆' : '总记忆')).join('、')"));
  assert.match(page, /function openMemoryNote\(anchor, kinds, msg\) \{/); assert.ok(page.includes("openMemoryNote(e.currentTarget, kinds, msg)"));
  assert.ok(page.includes("...d.removed.map((x) => ['del', '−', x]), ...d.added.map((x) => ['add', '+', x])")); // 点开列出删了、加了哪几条
  assert.ok(page.includes('if (!kinds.some((k) => delta[k])) {')); // 没记下具体改动的旧回复：直接去看那份记忆
  assert.ok(page.includes("} else if (ev.type === 'memory') {")); assert.ok(page.includes('msg.memoryUpdated = ev.memory; if (ev.delta) msg.memoryDelta = ev.delta; rerenderMsg(ev.msgIndex); cacheConv(S.conv);'));
  assert.ok(page.includes('这个项目自己的记忆，只在这个项目的对话里用')); assert.ok(page.includes('这是所有对话共用的总记忆。每个项目另有自己的项目记忆'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("broadcast({ type: 'memory', convId: conv.id, msgIndex: i, turnId: msg.turnId, memory: memoryUpdated, delta: memoryDeltas }, u);"));
});

test('这一轮加了、删了哪几条：按行比，顺序和空白不算，替换的一条算一删一加，太多只列前 12 条', (t) => {
  const h = fixture(t), delta = (a, b) => JSON.parse(h.evaluate(`JSON.stringify(memoryDelta(${JSON.stringify(a)}, ${JSON.stringify(b)}))`));
  assert.deepEqual(delta('- 甲\n- 乙\n', '- 乙\n\n  - 甲  \n'), { added: [], removed: [], more: 0 });
  assert.deepEqual(delta('- 截止 12 月 1 日\n- 用 GB/T 7714', '- 截止 12 月 15 日\n- 用 GB/T 7714\n- 导师姓王'), { added: ['- 截止 12 月 15 日', '- 导师姓王'], removed: ['- 截止 12 月 1 日'], more: 0 });
  assert.deepEqual(delta('', '- 新的'), { added: ['- 新的'], removed: [], more: 0 });
  const many = delta('', Array.from({ length: 20 }, (_, i) => '- 第 ' + i + ' 条').join('\n'));
  assert.equal(many.added.length, 12); assert.equal(many.more, 8);
  assert.equal(delta('', '- ' + '长'.repeat(500)).added[0].length, 200);
});

test('同时有别的对话在回复：内容变了还要在这一轮自己的操作记录里看到它碰过那份记忆才算', async (t) => {
  const h = fixture(t), touched = (events, kind) => h.evaluate(`memoryTouchedBy(${JSON.stringify(events)}, '${kind}')`);
  const edit = [{ k: 'tool', name: 'Edit', input: { file_path: 'D:\\Claude_for_X\\.memory\\memory.md' } }], projEdit = [{ k: 'tool', name: 'Edit', input: { file_path: './projects/abcd1234/.project/memory.md' } }];
  assert.equal(touched(edit, 'account'), true); assert.equal(touched(edit, 'project'), false);
  assert.equal(touched(projEdit, 'project'), true); assert.equal(touched(projEdit, 'account'), false);
  assert.equal(touched([{ k: 'text', text: '好的' }], 'account'), false); assert.equal(touched(null, 'account'), false);
  // 两个对话同时在跑，其中一个改了总记忆：另一个（没碰过记忆文件）不标
  const start = async (message) => { const r = await h.route('/api/chat', 'POST', { message, model: 'sonnet', effort: 'high' }); assert.equal(r.status, 200); return r.body.conversationId; };
  const a = await start('记住我喜欢简短的回答'), b = await start('随便聊聊');
  const [pa, pb] = h.calls.filter((c) => c.kind === 'claude').slice(-2).map((c) => c.child);
  pa.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: './.memory/memory.md', old_string: '', new_string: '- 喜欢简短的回答' } }] } }) + '\n');
  write(h, '.memory/memory.md', '- 喜欢简短的回答\n');
  for (const p of [pa, pb]) { p.stdout.write(JSON.stringify({ type: 'result', session_id: 'synthetic', result: '好的', is_error: false }) + '\n'); p.exitCode = 0; p.emit('close', 0); }
  const last = async (id) => { let m; for (let i = 0; i < 60; i++) { m = (await h.route('/api/conversations/' + id)).body.messages.at(-1); if (m.status === 'done' && Array.isArray(m.files)) break; await sleep(50); } return m; };
  const [ma, mb] = [await last(a), await last(b)];
  assert.deepEqual(ma.memoryUpdated, ['account']); assert.deepEqual(ma.memoryDelta.account.added, ['- 喜欢简短的回答']);
  assert.equal(mb.memoryUpdated, undefined);
});

test('总记忆的说明里带着项目清单，在项目里时标出是哪一个；没有项目就不带这一段', async (t) => {
  const h = fixture(t);
  assert.ok(!h.evaluate(`memoryPrompt(USERS.get('alice'))`).includes('projects (each keeps its own project memory)'));
  const one = (await h.route('/api/projects', 'POST', { name: '毕业论文', description: '超分辨成像方向' })).body;
  await h.route('/api/projects', 'POST', { name: '旅行计划' });
  const outside = h.evaluate(`memoryPrompt(USERS.get('alice'))`), inside = h.evaluate(`memoryPrompt(USERS.get('alice'), '${one.id}')`);
  assert.match(outside, /## His projects \(each keeps its own project memory\)|## The user's projects \(each keeps its own project memory\)/);
  assert.ok(outside.includes('- 毕业论文（超分辨成像方向）')); assert.ok(outside.includes('- 旅行计划')); assert.ok(!outside.includes('<- this conversation'));
  assert.ok(inside.includes('- 毕业论文（超分辨成像方向） <- this conversation')); assert.ok(!inside.includes('- 旅行计划 <- this conversation'));
});

test('网页：项目页的刷新真的会重画，用户在编辑或打字时不动', () => {
  const a = page.indexOf('async function refreshProject() {'), body = page.slice(a, page.indexOf('\nfunction renderProject(', a));
  assert.ok(a > 0); assert.ok(!body.includes("!$('#pview textarea')")); // 原来的判断在项目页永远不成立
  assert.ok(body.includes("$('#pview [data-text]')")); assert.ok(body.includes("if (document.activeElement === $('#input') && $('#input').value) return;"));
  assert.ok(body.includes("const top = $('#pview').scrollTop")); assert.ok(body.includes("$('#pview').scrollTop = top;"));
});
