'use strict';
// 用真实的 index.html 片段和真实的 marked，核对中文标点旁边的加粗。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Marked } = require('marked');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('const CJK_CHAR ='), end = html.indexOf('DOMPurify.addHook(', start);
assert.ok(start > 0 && end > start, '找不到加粗规则');
const context = { marked: new Marked({ gfm: true, breaks: false }) };
vm.runInNewContext(html.slice(start, end), context);
const inline = text => context.marked.parseInline(text);
const block = text => context.marked.parse(text);

test('规则判定失败的中文加粗能正常显示', () => {
  for (const [source, expected] of [
    ['让**"取景器"从第一句话就出现**，这样', '让<strong>&quot;取景器&quot;从第一句话就出现</strong>，这样'],
    ['**核心转换：**问题不再是', '<strong>核心转换：</strong>问题不再是'],
    ['这是**“引号”**后面', '这是<strong>“引号”</strong>后面'],
    ['这是**（括号）**后面', '这是<strong>（括号）</strong>后面'],
    ['**注意！**请看，**提示：**继续', '<strong>注意！</strong>请看，<strong>提示：</strong>继续'],
    ['**"a"**中文', '<strong>&quot;a&quot;</strong>中文'],
  ]) assert.equal(inline(source), expected, source);
});

test('加粗里面的代码和链接照常解析', () => {
  assert.equal(inline('**配置`a*b`：**后面'), '<strong>配置<code>a*b</code>：</strong>后面');
  assert.equal(inline('让**"[链接](https://example.com)"说明**后'), '让<strong>&quot;<a href="https://example.com">链接</a>&quot;说明</strong>后');
});

test('本来就对的写法不变', () => {
  assert.equal(inline('让**取景器**出现'), '让<strong>取景器</strong>出现');
  assert.equal(inline('**加粗**：说明'), '<strong>加粗</strong>：说明');
  assert.equal(inline('说明：**"引号结尾"**。'), '说明：<strong>&quot;引号结尾&quot;</strong>。');
  assert.equal(inline('2**3**4'), '2<strong>3</strong>4');
  assert.equal(inline('***都加***后'), '<em><strong>都加</strong></em>后');
});

test('不是加粗的内容不被误伤', () => {
  assert.equal(inline('`**"不要改"**中文`'), '<code>**&quot;不要改&quot;**中文</code>');
  assert.equal(inline('x**(y)**z'), 'x**(y)**z');
  assert.equal(inline('a ** b ** c'), 'a ** b ** c');
  assert.equal(inline('只有开头**"没有结尾'), '只有开头**&quot;没有结尾');
  assert.equal(inline('\\*\\*"转义"\\*\\*中文'), '**&quot;转义&quot;**中文');
  assert.equal(inline('** "前面有空格"**中文'), '** &quot;前面有空格&quot;**中文');
  assert.match(block('```\n**"代码块"**中文\n```'), /\*\*&quot;代码块&quot;\*\*中文/);
  assert.match(block('    **"缩进代码"**中文'), /<code>\*\*&quot;缩进代码&quot;\*\*中文/);
});

test('不跨段落配对，表格和列表里也能用', () => {
  assert.doesNotMatch(block('让**"第一段\n\n第二段"**后'), /<strong>/);
  assert.match(block('- **说明：**内容'), /<li><strong>说明：<\/strong>内容<\/li>/);
  assert.match(block('| a |\n|---|\n| **说明：**内容 |'), /<td><strong>说明：<\/strong>内容<\/td>/);
});
