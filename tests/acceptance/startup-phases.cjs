'use strict';
// 冷启动分段计时：只在验收夹具的内存副本里插标记，server.js 本身不变。
// 每个标记都插在一条完整语句的前后；不能插在 try 块和 catch 之间。
const PHASES = [
  ["const readiness = require('./tools/check-isolation.cjs').check(config, undefined, ROOT, __dirname);", 'gate-start', false],
  ["if (!readiness.readyToEnableIsolation) isolationBlocked = readiness.remainingRequirements.slice(0, 20);", 'gate-done', true],
  // 插在 try 块里面：隔离环境真的建好了才记这一段。
  ["try { isolation = require('./isolation').createIsolation(config, ROOT);", 'isolation-ready', true],
  ['async function pageHtml() { return pageShell.get(); }', 'page-shell-created', false],
];

function instrumentStartup(source) {
  const missing = [];
  for (const [needle, mark, after] of PHASES) {
    if (!source.includes(needle)) { missing.push(mark); continue; }
    const tag = 'process.send({phase:' + JSON.stringify(mark) + '});';
    source = source.replace(needle, () => after ? needle + tag : tag + needle);
  }
  return { source, missing };
}

module.exports = { PHASES, instrumentStartup };
