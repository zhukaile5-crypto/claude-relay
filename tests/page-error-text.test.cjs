'use strict';
// B1：发给网页的错误文字不带本机路径和密钥样式的字符串；原文只进 relay.log。从 server.js 源码取函数，在 vm 里测。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('// ---------- 给网页的错误文字 ----------'), end = source.indexOf('// ---------- 给网页的错误文字结束 ----------');
const pageError = (() => { assert.ok(start > 0 && end > start, '找不到 server.js 里的 pageErrorText'); const ctx = {}; vm.runInNewContext(source.slice(start, end) + '\nglobalThis.f = pageErrorText;', ctx); return ctx.f; })();

test('本机绝对路径（反斜杠、正斜杠、UNC、用户目录）换成占位，相对路径和普通文字不动', () => {
  const raw = 'spawn C:\\Users\\user\\AppData\\Local\\Temp\\claude\\x\\no-such-program.exe ENOENT; also D:/Claude云端传输/data/x.json and \\\\server\\share\\a.txt and /Users/bob/.claude/a';
  const out = pageError(raw);
  for (const leaked of ['user', 'AppData', 'Claude云端传输', 'server\\share', '/Users/bob']) assert.equal(out.includes(leaked), false, leaked);
  assert.match(out, /spawn <本机路径> ENOENT/);
  assert.equal(pageError('文件不存在：chats/c1/outputs/a.txt'), '文件不存在：chats/c1/outputs/a.txt');
  assert.equal(pageError('Prompt is too long'), 'Prompt is too long');
});
test('密钥样式的字符串隐藏，前端靠来分类的关键词保留', () => {
  const out = pageError('Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz0123 (invalid_api_key) Authorization: Bearer abc.def.ghi-123456 token 0123456789abcdef0123456789abcdef01');
  for (const leaked of ['abcdefghijklmnop', 'abc.def.ghi', '0123456789abcdef0123456789abcdef']) assert.equal(out.includes(leaked), false, leaked);
  assert.match(out, /Incorrect API key provided/); assert.match(out, /invalid_api_key/);
  for (const keep of ['You exceeded your current quota', 'usage limit reached', 'Overloaded (529)', 'ECONNRESET', 'rate_limit_exceeded'])
    assert.equal(pageError(keep), keep);
});
test('只保留末尾 600 字，非字符串给空串', () => {
  const out = pageError('错误 '.repeat(2000) + 'END');
  assert.equal(out.length, 600); assert.ok(out.endsWith('END'));
  assert.equal(pageError(undefined), ''); assert.equal(pageError({ a: 1 }), '');
});
test('接到 server.js：回复出错、对话下发、所有 4xx/5xx 的 error 字段都过一遍；原文写进日志', () => {
  assert.match(source, /if \(msg\.status === 'error'\) \{ const rawError = [^\n]*; msg\.errorText = pageErrorText\(rawError\);/);
  assert.match(source, /console\.log\(`\[回复出错\] /);
  assert.match(source, /for \(const m of c\.messages\) \{ if \(typeof m\.errorText === 'string'\) m\.errorText = pageErrorText\(m\.errorText\);/);
  const send = source.slice(source.indexOf('function sendJSON('), source.indexOf('\n}\n', source.indexOf('function sendJSON(')));
  assert.match(send, /code >= 400 && obj && typeof obj\.error === 'string'/);
  assert.match(send, /pageErrorText\(obj\.error\)/);
  assert.match(source, /sendJSON\(res, 500, \{ error: '服务器出错了，请稍后再试' \}\)/);
});
test('程序根本没启动（没有任何输出）时告诉网页不能「继续」', () => {
  assert.match(source, /if \(msg\.status === 'error' && runtimeSpawnCode && !msg\.events\.length\) msg\.resumable = false;/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /if \(msg\.resumable === false\) error\.resumable = false;/);
});
