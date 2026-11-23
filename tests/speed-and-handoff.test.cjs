'use strict';
// 2026-11-21 的一批改动：本机压缩、消息里的当地时间、交接长度按提供方区分、Gemini 进接力名单。
// 只用合成账号和内存替身，不启动模型、不碰正式服务。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./model-server-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const sendWith = (h, encodingHeader, payload) => JSON.parse(h.evaluate(`(() => {
  const out = {};
  const res = { req: { headers: ${JSON.stringify(encodingHeader === null ? {} : { 'accept-encoding': encodingHeader })} },
    writeHead(code, headers) { out.code = code; out.headers = headers; }, end(body) { out.body = body; } };
  sendJSON(res, 200, ${JSON.stringify(payload)});
  const encoding = out.headers['Content-Encoding'] || null;
  const plain = encoding === 'br' ? zlib.brotliDecompressSync(out.body).toString('utf8') : encoding === 'gzip' ? zlib.gunzipSync(out.body).toString('utf8') : String(out.body);
  return JSON.stringify({ encoding, isString: typeof out.body === 'string', sent: out.body.length, length: out.headers['Content-Length'] ?? null, vary: out.headers.Vary || null, plain });
})()`));

test('大的 JSON 回应按浏览器能收的编码压缩，内容还原后一字不差', t => {
  const h = fixture(t), payload = { text: '同一段文字反复出现。'.repeat(600), n: 7 };
  const br = sendWith(h, 'gzip, deflate, br', payload);
  assert.equal(br.encoding, 'br'); assert.equal(br.vary, 'Accept-Encoding'); assert.equal(br.length, br.sent);
  assert.deepEqual(JSON.parse(br.plain), payload); assert.ok(br.sent < JSON.stringify(payload).length / 5);
  const gz = sendWith(h, 'gzip', payload);
  assert.equal(gz.encoding, 'gzip'); assert.deepEqual(JSON.parse(gz.plain), payload);
});

test('小的回应和不收压缩内容的请求照旧发原文字符串', t => {
  const h = fixture(t);
  const small = sendWith(h, 'gzip, br', { ok: true });
  assert.equal(small.encoding, null); assert.equal(small.isString, true); assert.equal(small.plain, '{"ok":true}');
  const plain = sendWith(h, null, { text: 'x'.repeat(5000) });
  assert.equal(plain.encoding, null); assert.equal(plain.isString, true); assert.equal(JSON.parse(plain.plain).text.length, 5000);
});

test('首页和文字类静态文件走压缩，实时推送不压', () => {
  assert.match(source, /compressedCopy\('page', page\.build, page\.body, encoding\)/);
  for (const file of ["'sw.js'", "'manifest.webmanifest'", "'favicon.svg'"]) assert.ok(source.includes('sendStaticFile(req, res, path.join(PUBLIC_DIR, ' + file));
  const sse = source.slice(source.indexOf("'Content-Type': 'text/event-stream'") - 200, source.indexOf("'Content-Type': 'text/event-stream'") + 200);
  assert.doesNotMatch(sse, /Content-Encoding/);
});

test('消息末尾的当地时间：只接受 Intl 认得的时区，认不出就不加', t => {
  const h = fixture(t);
  assert.match(h.evaluate("nowNote('Asia/Shanghai')"), /^\n\n\[现在是 \d{4}年\d{1,2}月\d{1,2}日星期. \d{2}:\d{2}（用户所在时区 Asia\/Shanghai）\]$/);
  for (const bad of ['Not/AZone', '../etc/passwd', '', 'A'.repeat(80), 'Asia/Shanghai; rm']) assert.equal(h.evaluate('nowNote(' + JSON.stringify(bad) + ')'), '');
  assert.equal(h.evaluate('nowNote(undefined)'), '');
  assert.equal(h.evaluate("userTimeZone('America/Los_Angeles')"), 'America/Los_Angeles');
});

test('交接长度：GPT 守 24000 字，Claude 和 Gemini 给到 60000 字', t => {
  const h = fixture(t);
  const stats = provider => JSON.parse(h.evaluate(`(() => {
    const messages = [];
    for (let i = 0; i < 18; i++) {
      messages.push({ role: 'user', text: '第' + i + '个要求：' + '请继续完善这一节。'.repeat(60) });
      messages.push({ role: 'assistant', model: ${JSON.stringify(provider === 'anthropic' ? 'gpt-6.1-terra' : 'haiku')}, status: 'done', turnId: 't' + i,
        events: [{ k: 'text', text: ('这是第' + i + '轮的回答。\\n').repeat(260) }] });
    }
    messages.push({ role: 'user', text: '现在换你来' }, { role: 'assistant', model: 'x', status: 'running', events: [] });
    return JSON.stringify(handoffFor(api.USERS.get('alice'), { id: 'c'.repeat(16), messages }, ${JSON.stringify(provider)}).stats);
  })()`));
  const gpt = stats('openai'), gemini = stats('google'), claude = stats('anthropic');
  assert.ok(gpt.chars > 0 && gpt.chars <= 24000);
  assert.ok(gemini.chars > 24000 && gemini.chars <= 60000);
  assert.ok(claude.chars > 24000 && claude.chars <= 60000);
  assert.equal(gpt.truncated, true); // 同样的历史，GPT 那份省略得更多
  assert.ok(gemini.chars > gpt.chars);
});

test('接力名单带上 Gemini：没配置 Gemini 时为空，不影响原来的两家', t => {
  const h = fixture(t);
  assert.deepEqual(JSON.parse(h.evaluate("JSON.stringify(fallbackModelsFor(api.USERS.get('alice')))")), { anthropic: 'sonnet', openai: 'gpt-6.1-terra', google: null });
  assert.match(source, /google: choose\('google', available\.find\(m => m\.provider === 'google'\)\?\.id\)/);
});

// 合成对话：Gemini 答完第一轮；第二轮被打断（agy 对话里已经有它）；第三轮交给 Claude；现在第四轮回到 Gemini
const GEMINI_CONFIG = { geminiModels: [{ id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high'] }] };
const geminiHandoff = (h, { between = true, interrupted = {}, conv = {}, resumeId = 'agy-1' } = {}) => JSON.parse(h.evaluate(`(() => {
  const u = api.USERS.get('alice');
  const gemini = (turnId, status, extra = {}) => ({ role: 'assistant', model: 'gemini-4-neon', provider: 'google', status, turnId, geminiConvId: 'agy-1',
    events: [{ k: 'text', text: 'Gemini 的回答 ' + turnId }], ...extra });
  const messages = [
    { role: 'user', text: '第一问：先定提纲' }, gemini('g1', 'done'),
    { role: 'user', text: '第二问：这一轮被打断' }, gemini('g2', 'stopped', ${JSON.stringify(interrupted)}),
    ...(${JSON.stringify(between)} ? [{ role: 'user', text: '第三问：交给别家' }, { role: 'assistant', model: 'haiku', status: 'done', turnId: 'c3', events: [{ k: 'text', text: 'Claude 写的第三轮回答' }] }] : []),
    { role: 'user', text: '第四问：回到 Gemini' }, { role: 'assistant', model: 'gemini-4-neon', provider: 'google', status: 'running', turnId: 'g4', events: [] },
  ];
  const conv = { id: 'd'.repeat(16), geminiConvId: 'agy-1', geminiTurnId: 'g2', messages, ...${JSON.stringify(conv)} };
  const before = JSON.stringify(conv);
  const view = geminiHandoffView(conv, ${JSON.stringify(resumeId)});
  return JSON.stringify({ withView: handoffFor(u, view, 'google').text, without: handoffFor(u, conv, 'google').text, same: view === conv, untouched: JSON.stringify(conv) === before });
})()`));

test('Gemini 接着同一个 agy 对话：没答完的那一轮不重复交接，中间隔了别家的回复也一样', t => {
  const h = fixture(t, { config: GEMINI_CONFIG });
  assert.equal(h.evaluate("providerOf('gemini-4-neon')"), 'google');
  // 隔了 Claude 的一轮再回到 Gemini：只交接 Claude 那一轮，被打断的第二轮不再给一遍
  const across = geminiHandoff(h);
  assert.match(across.without, /第二问：这一轮被打断/); // 不处理的话会重复
  assert.doesNotMatch(across.withView, /第二问|Gemini 的回答 g2|第一问/);
  assert.match(across.withView, /第三问：交给别家/); assert.match(across.withView, /Claude 写的第三轮回答/);
  assert.equal(across.same, false); assert.equal(across.untouched, true); // 只是给交接用的视图，原对话不动
  // 紧挨着的上一条就是被打断的那条：没有要交接的
  const direct = geminiHandoff(h, { between: false });
  assert.match(direct.without, /第二问：这一轮被打断/); assert.equal(direct.withView, '');
});

test('没有证据表明 agy 记得那一轮时，照旧交接（重复比遗漏安全）', t => {
  const h = fixture(t, { config: GEMINI_CONFIG });
  const keeps = result => { assert.equal(result.same, true); assert.match(result.withView, /第二问：这一轮被打断/); };
  keeps(geminiHandoff(h, { resumeId: null }));                               // 接不上原来的 agy 对话
  keeps(geminiHandoff(h, { interrupted: { events: [] } }));                  // 刚开始就被停掉，没有它产生的内容
  keeps(geminiHandoff(h, { interrupted: { geminiConvId: 'agy-other' } }));   // 那条回复属于另一个 agy 对话
  keeps(geminiHandoff(h, { interrupted: { geminiConvId: null } }));     // 老记录没有对话编号
  keeps(geminiHandoff(h, { conv: { geminiTurnId: 'g1' } }));                 // 记下的不是这一条（编辑、重试过）
  keeps(geminiHandoff(h, { interrupted: { turnId: null } }));                    // 老记录没有轮次编号
  // 那条本来就答完了：视图原样返回，交接从它之后算
  const done = geminiHandoff(h, { interrupted: { status: 'done' } });
  assert.equal(done.same, true); assert.doesNotMatch(done.withView, /第二问/); assert.match(done.withView, /第三问：交给别家/);
});

test('startJob 用视图算 Gemini 的交接；恢复重来时仍带完整历史；同步隔离调用都带时限', () => {
  assert.match(source, /const handoffConv = gemini && !recovery \? geminiHandoffView\(conv, resumeId\) : conv;/);
  assert.match(source, /handoffFor\(u, handoffConv, provider, \{ resumesInterrupted: userMsg\.resumesInterrupted === true, /);
  assert.match(source, /fullHistory: recoveryAttempt > 0 \|\| \(gemini && !resumeId\)/);
  assert.doesNotMatch(source, /geminiRemembersLast|previousReply/);
  assert.match(source, /const SYNC_IO = \{ timeoutMs: 10000 \};/);
  assert.equal(source.split(', SYNC_IO)').length - 1, 9);
  // 简写（listSync、scanSync 这些）传不了时限：server.js 里不再用它们
  assert.doesNotMatch(source, /isolation\.io\.(?:list|scan|readJson|readText|stat|mkdir|remove|writeText|writeJson|copy)Sync\(/);
  // 同一行里没写时限的只有两处：启动时建账号文件夹（启动失败就该报错退出），以及时限写在下面几行的 projectPrompt
  const untimed = source.split('\n').filter(line => /isolation\.io\.(?:batch|operation)Sync\(/.test(line) && !line.includes('SYNC_IO'));
  assert.equal(untimed.length, 2);
  assert.ok(untimed.some(line => line.includes(".memory/chats")));
});

test('带登录令牌的大回应（/api/state）也压缩，内容还原后一字不差', t => {
  const h = fixture(t), payload = { sessionToken: 'SYNTHETIC_TOKEN', wakeToken: 'SYNTHETIC_WAKE', conversation: { text: '上次那个对话的全文。'.repeat(700) } };
  const sent = sendWith(h, 'gzip, br', payload);
  assert.equal(sent.encoding, 'br'); assert.deepEqual(JSON.parse(sent.plain), payload);
});

test('文字类静态文件：命中缓存不再读文件，没压的那条路也带 Vary', () => {
  assert.match(source, /compressedCopy\(file, stat\.size \+ ':' \+ stat\.mtimeMs, \(\) => fs\.readFileSync\(file\), encoding\)/);
  assert.match(source, /compressible \? \{ \.\.\.headers, Vary: 'Accept-Encoding' \} : headers/);
});
