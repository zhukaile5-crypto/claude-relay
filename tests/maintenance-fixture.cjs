'use strict';
// 仅为 M1 故障注入提供合成依赖；不使用真实配置、程序或模型。
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const { parseVersion } = require('../tools/maintain.cjs');
function dependencies(directory, overrides = {}) {
  if (!path.basename(directory).startsWith('relay-m1-') || !fs.existsSync(path.join(directory, 'fixture-only'))) throw Error('必须是专用合成测试目录');
  const p = name => path.join(directory, name), calls = [];
  const d = {
    programs: [{ name: 'Claude', root: p('pinned.exe'), exe: p('pinned.exe'), source: p('source.exe'), sourceRoot: file => file, exeIn: file => file, signedIn: file => [file], signer: '合成签名' }],
    receipt: p('receipt.json'), state: p('state.json'), notice: p('notice.txt'), lock: p('running.lock'),
    stoppedByOwner: () => fs.existsSync(p('manual-stop')),
    power: async () => ({ running: 0, idleMinutes: 60 }),
    discover: async program => { calls.push('discover'); return { status: 'available', version: (await fsp.readFile(program.source, 'utf8')).trim() }; },
    prepareCandidate: async program => ({ status: 'ready', executable: program.source }),
    version: async file => parseVersion(await fsp.readFile(file, 'utf8')),
    signedBy: () => true,
    accept: async ({ outputReceipt }) => { calls.push('accept'); await fsp.writeFile(outputReceipt, 'new-receipt'); return { ok: true, out: '' }; },
    gateOk: async () => { const program = await fsp.readFile(p('pinned.exe'), 'utf8'), receipt = await fsp.readFile(p('receipt.json'), 'utf8'); return (program === '2.1.314' && receipt === 'old-receipt') || (program === '2.1.320' && receipt === 'new-receipt'); },
    restart: () => { calls.push('restart'); return true; }, serving: async () => true,
    waitMs: 1, idleTimeoutMs: 20, now: () => Date.now(), log: () => {},
    ...overrides,
  };
  return { d, p, calls };
}
module.exports = { dependencies };
