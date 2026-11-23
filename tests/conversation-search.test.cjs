'use strict';
// B5：对话全文搜索。从 server.js 取出搜索函数在 vm 里跑，对话全是合成数据；路由只做源码核对。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('// ---------- 对话全文搜索 ----------'), end = source.indexOf('// ---------- 对话全文搜索结束 ----------');
function load() {
  assert.ok(start > 0 && end > start, '找不到 server.js 里的对话搜索');
  const ctx = { performance: { now: () => clock.t } }; const clock = { t: 0 }; ctx.clock = clock;
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.search = searchConversations;', ctx);
  return ctx;
}
const conv = (id, title, texts, extra = {}) => ({ id, title, updatedAt: extra.updatedAt || 1, projectId: extra.projectId || null,
  messages: texts.map((t, i) => i % 2 === 0 ? { role: 'user', text: t } : { role: 'assistant', events: [{ k: 'thinking', text: '思考里的秘密词 THINKONLY' }, { k: 'text', text: t }], result: '' }) });
function store(list) {
  const byId = new Map(list.map(c => [c.id, c]));
  return { metas: list.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, projectId: c.projectId })), read: async id => byId.get(id) };
}

test('标题和消息正文都能搜到，不分大小写；片段截在命中处前后，标出位置', async () => {
  const { search } = load();
  const s = store([conv('a'.repeat(16), '改写论文摘要', ['帮我把这段摘要改短', '好的，这是改写后的 Abstract 版本……'], { updatedAt: 3 }),
    conv('b'.repeat(16), '周报初稿', ['本周完成了 Welch t 检验和效应量计算，下周写讨论部分'], { updatedAt: 2 }),
    conv('c'.repeat(16), '无关对话', ['今天天气不错'], { updatedAt: 1 })]);
  let r = await search(s.metas, 'abstract', { read: s.read });
  assert.equal(JSON.stringify(r.results.map(x => [x.id[0], x.where])), JSON.stringify([['a', 'message']]));
  assert.match(r.results[0].snippet, /Abstract/);
  r = await search(s.metas, '论文', { read: s.read });
  assert.equal(r.results[0].where, 'title'); assert.equal(r.results[0].snippet, '');
  r = await search(s.metas, '效应量', { read: s.read });
  const hit = r.results[0]; assert.equal(hit.id, 'b'.repeat(16));
  assert.ok(hit.snippet.length <= 70, hit.snippet); assert.match(hit.snippet, /效应量/);
  assert.equal(r.partial, false);
});
test('思考过程、工具输出不参与搜索（那是过程，不是对话内容）', async () => {
  const { search } = load();
  const s = store([conv('d'.repeat(16), '题目', ['问题', '回答'])]);
  assert.equal((await search(s.metas, 'THINKONLY', { read: s.read })).results.length, 0);
});
test('查询太短、太长或不是字符串直接拒绝；结果最多 30 条，按列表顺序', async () => {
  const { search } = load();
  for (const q of ['', ' ', null, 'x'.repeat(101)]) assert.equal((await search([], q, { read: async () => null })).error, '搜索词长度要在 1 到 100 字之间');
  const many = Array.from({ length: 50 }, (_, i) => conv(i.toString(16).padStart(16, '0'), '合成 ' + i, ['共同关键词 KEY']));
  const s = store(many);
  const r = await search(s.metas, 'key', { read: s.read });
  assert.equal(r.results.length, 30); assert.equal(r.results[0].id, '0'.repeat(16)); assert.equal(r.partial, true);
});
test('扫描有上限：超时或超过文件数就停，标记部分结果；读坏的文件跳过', async () => {
  const ctx = load();
  const list = Array.from({ length: 10 }, (_, i) => conv(i.toString(16).padStart(16, '0'), 't' + i, ['needle']));
  const s = store(list);
  let reads = 0;
  const slow = async id => { reads++; ctx.clock.t += 100; return s.read(id); };
  const r = await ctx.search(s.metas, 'needle', { read: slow, budgetMs: 300 });
  assert.ok(reads <= 4, String(reads)); assert.equal(r.partial, true); assert.ok(r.results.length >= 1);
  ctx.clock.t = 0;
  const r2 = await ctx.search(s.metas, 'needle', { read: s.read, maxFiles: 3 });
  assert.equal(r2.results.length, 3); assert.equal(r2.partial, true);
  const broken = await ctx.search(s.metas, 'needle', { read: async id => { if (id.endsWith('1')) throw Error('坏文件'); return s.read(id); } });
  assert.equal(broken.results.length, 9);
});
test('路由：登录后才能用，只搜本账号，同一账号一次只跑一个，模型停用时也能搜历史', () => {
  assert.match(source, /if \(p === '\/api\/search' && req\.method === 'GET'\) \{/);
  const route = source.slice(source.indexOf("if (p === '/api/search' && req.method === 'GET') {"), source.indexOf("if (p === '/api/search' && req.method === 'GET') {") + 900);
  assert.match(route, /searchConversations\(listConvs\(u\),/);
  assert.match(route, /searching\.has\(u\.id\)/);
  assert.match(route, /readSearchConv\(u, /);
  assert.ok(source.indexOf("if (p === '/api/search'") > source.indexOf('const u = (url.searchParams.has'), '必须在登录检查之后');
  assert.match(source, /p === '\/api\/prefs' \|\| p === '\/api\/projects' \|\| p === '\/api\/search'/);
});
