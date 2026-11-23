'use strict';
// B3：命令行把以 - 开头的参数当成回执路径时，会报「完整验收记录尚未生成」，看起来像门禁坏了。现在直接报用法错误。
const test = require('node:test'), assert = require('node:assert/strict'), cp = require('node:child_process'), path = require('node:path');
const script = path.join(__dirname, '..', 'tools', 'check-isolation.cjs');
test('未知选项直接报错（退出码 64），不读配置、不做核对', () => {
  for (const arg of ['--status', '-h', '--help']) {
    const r = cp.spawnSync(process.execPath, [script, arg], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
    assert.equal(r.status, 64, arg + ' ' + r.stderr);
    assert.match(r.stderr, /用法：node tools\/check-isolation\.cjs \[回执文件路径\]/);
    assert.match(r.stderr, new RegExp('不认识的选项：' + arg.replace(/-/g, '\-')));
    assert.equal(r.stdout, '');
  }
});
