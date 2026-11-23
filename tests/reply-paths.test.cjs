'use strict';
// 回答里这台电脑上的绝对路径：发给网页前换成相对工作文件夹的路径。只用合成账号和临时文件夹。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./model-server-fixture.cjs');

test('工作文件夹下的绝对路径换成相对路径：file:// 链接、正反斜杠、转义写法都认', (t) => {
  const h = fixture(t), root = h.workspace, fwd = root.replace(/\\/g, '/');
  const fix = (text) => h.evaluate(`relativeReplyPaths(USERS.get('alice'), ${JSON.stringify(text)})`);
  // Gemini 实际写出来的样子
  assert.equal(fix(`已修改 [说明.md](file:///${fwd}/linked/621419943f967c8d/说明.md)：末尾加了一行。`), '已修改 [说明.md](linked/621419943f967c8d/说明.md)：末尾加了一行。');
  assert.equal(fix(`文件在 ${root}\\chats\\abc\\outputs\\报告.docx 里`), '文件在 chats/abc/outputs/报告.docx 里');
  assert.equal(fix(`\`${fwd}/outputs/a.png\` 和 "${root}\\outputs\\b.png"`), '`outputs/a.png` 和 "outputs/b.png"');
  assert.equal(fix(`[图](file://${encodeURI(fwd).replace(':', '%3A')}/outputs/%E5%9B%BE.png)`), '[图](outputs/%E5%9B%BE.png)');
  assert.equal(fix(`大小写不同也认：${root.toUpperCase()}\\A.TXT`), '大小写不同也认：A.TXT');
  assert.equal(fix(`我的工作目录是 ${root}。`), '我的工作目录是 工作文件夹。');
  // 只是名字像：不动
  assert.equal(fix(`${root}2\\x.txt 和 ${root}.bak`), `${root}2\\x.txt 和 ${root}.bak`);
  // 没有路径的、别处的路径、不是文字的：原样
  for (const same of ['普通的一句话，outputs/报告.docx 在这里。', 'C:\\Windows\\System32\\cmd.exe', 'https://example.com/a/b', '']) assert.equal(fix(same), same);
  assert.equal(h.evaluate(`relativeReplyPaths(USERS.get('alice'), null)`), null);
  assert.ok(!fix(`${root}\\a ${fwd}/b file:///${fwd}/c`).includes(path.basename(root)));
});

test('下发对话时只改助手回答里的文字，存档原文、用户的话、工具记录都不动', (t) => {
  const h = fixture(t), root = h.workspace;
  h.context.sample = { messages: [
    { role: 'user', text: `我的文件在 ${root}\\uploads\\a.txt` },
    { role: 'assistant', status: 'done', result: `见 ${root}\\outputs\\r.md`, events: [
      { k: 'thinking', text: `先看 ${root}\\uploads\\a.txt` }, { k: 'tool', name: 'Read', input: { file_path: `${root}\\uploads\\a.txt` } },
      { k: 'text', text: `写好了：[r.md](file:///${root.replace(/\\/g, '/')}/outputs/r.md)` }] }] };
  const out = JSON.parse(h.evaluate(`JSON.stringify(withFileUrls(USERS.get('alice'), sample))`));
  assert.equal(out.messages[0].text, `我的文件在 ${root}\\uploads\\a.txt`);
  assert.equal(out.messages[1].events[0].text, '先看 uploads/a.txt');
  assert.equal(out.messages[1].events[1].input.file_path, `${root}\\uploads\\a.txt`);
  assert.equal(out.messages[1].events[2].text, '写好了：[r.md](outputs/r.md)');
  assert.equal(out.messages[1].result, '见 outputs/r.md');
  assert.ok(h.context.sample.messages[1].events[2].text.includes('file:///')); // 原对象没被改
});

test('隔离层给模型用的视图目录也算工作文件夹：GPT 实际写出来的那种路径换成相对路径', (t) => {
  const h = fixture(t), sep = String.fromCharCode(92), join = (...parts) => parts.join(sep);
  const view = join('C:', 'Users', 'someone', 'ClaudeRelayIsolation', 'w', 'bd844b37c64cbbc1c59c', 'view');
  h.ctx.executionRoot = view;
  const fix = (text) => h.evaluate(`relativeReplyPaths(USERS.get('alice'), ${JSON.stringify(text)})`);
  assert.equal(fix('新建了 [汇总.txt](' + join(view, 'linked', '4e7c13d30a7bd0aa', '汇总.txt') + ')，内容只有 17。'), '新建了 [汇总.txt](linked/4e7c13d30a7bd0aa/汇总.txt)，内容只有 17。');
  assert.equal(fix('在 ' + view.split(sep).join('/') + '/chats/abc/outputs/a.md'), '在 chats/abc/outputs/a.md');
  assert.equal(fix(join(h.workspace, 'outputs', 'b.md')), 'outputs/b.md'); // 原来的写法照样认
  // 别的账号的视图目录、临时目录不是这个工作文件夹：不动
  const other = join('C:', 'Users', 'someone', 'ClaudeRelayIsolation', 'w', 'ffffffffffffffffffff', 'view', 'x.txt'), scratch = join('C:', 'Users', 'someone', 'ClaudeRelayIsolation', 's', 'bd844b37c64cbbc1c59c', 't.txt');
  assert.equal(fix(other), other); assert.equal(fix(scratch), scratch);
});

test('三家的说明里都要求用相对路径；回复完成和取对话都经过这一步', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const notes = source.slice(source.indexOf('const GEMINI_NOTES = ['), source.indexOf('function modelInstructions('));
  assert.ok(source.includes("platform: systemPrompt(u) + ' ' + REPLY_PATH_NOTE + (provider === 'google' ? ' ' + GEMINI_NOTES : '')"));
  assert.match(notes, /relative to the working folder/); assert.match(notes, /never write absolute paths, drive letters or file:\/\/ links/);
  assert.ok(source.includes("broadcast({ type: 'done', convId: conv.id, msgIndex, message: withFileUrls(u, { messages: [msg] }, conversationMode(u, conv)).messages[0] }, u);")); // 只给一条回复时带上对话是聊天还是工作
  assert.ok(source.includes('return sendJSON(res, 200, withFileUrls(u, conv));'));
});

test('三家拿到的完整说明里都有这句', (t) => {
  const h = fixture(t);
  for (const provider of ['anthropic', 'openai', 'google']) assert.match(h.evaluate(`modelInstructions(USERS.get('alice'), null, '${provider}')`), /never write absolute paths, drive letters or file:\/\/ links/, provider);
});
