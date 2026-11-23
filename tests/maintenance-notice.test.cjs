'use strict';
// 仅在VM执行抽出的真实路由/提示函数；不监听端口，不读取正式配置或通知，不启动程序。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sourcePromise = fs.readFile(path.join(root, 'server.js'), 'utf8');

async function harness({ user = { id: 'owner-fixture', name: '机主', profile: 'owner' }, blocked = null, notice = '机主维护提醒', readFails = false } = {}) {
  const source = await sourcePromise;
  const helperStart = source.indexOf('const BLOCKED_MESSAGE = '), helperEnd = source.indexOf('function blockedIsolation()', helperStart);
  const owner = source.match(/(?:async )?function ownerNotice\(u\) \{[\s\S]*?\n\}/);
  const routeStart = source.indexOf('async function handle(req, res)'), routeEnd = source.indexOf('\nconst server = http.createServer', routeStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && owner && routeStart >= 0 && routeEnd > routeStart);
  let reads = 0;
  const dataRoot = path.join(root, 'synthetic-stage'), notices = [];
  const context = { URL, path, ROOT: dataRoot, __dirname: path.join(root, 'wrong-source-root'), isolationBlocked: blocked,
    fs: { promises: { readFile: async target => {
      reads++; assert.equal(target, path.join(dataRoot, 'data', 'maintenance', 'notice.txt'));
      if (readFails) throw Error('synthetic missing');
      return typeof notice === 'function' ? notice(reads) : notice;
    } } },
    maintenanceDrain: { blocked: () => false }, taskRequest: () => false,
    authUser: () => user, USERS: new Map(), jobs: new Map(), lastActivity: 0,
    updateKeepAwake() {}, freshEnoughSnap: async () => {}, loadConv: () => null,
    listConvs: () => [], listProjects: () => [], runningIds: () => [],
    pageHtml: () => ({ build: 'fixture-page' }), modelsFor: () => [], fallbackModelsFor: () => ({ anthropic: null, openai: null }), toolsFor: () => [],
    config: {}, savedChoice: () => ({}), usage: {}, userToken: () => 'synthetic-session-placeholder',
    console: { log() {}, error() {} }, shortUA: () => 'fixture',
    sendJSON: (_res, status, body) => { const result = { status, body }; notices.push(result); return result; },
  };
  vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n' + owner[0] + '\n' +
    source.slice(routeStart, routeEnd) + '\nglobalThis.invoke=handle;globalThis.owner=ownerNotice;globalThis.reason=blockedReason;', context);
  const call = (url = '/api/state', method = 'GET') => context.invoke({ url, method, headers: {}, socket: {}, resume() {} }, { setHeader() {} });
  return { call, context, reads: () => reads, notices };
}

test('M12 普通账号受限时仅有简洁说明，仍可获取历史页面状态', async () => {
  const h = await harness({ user: { id: 'ordinary-fixture' }, blocked: ['验收后文件已变化：server.js', '隔离运行环境无法启动：SYNTHETIC_PRIVATE_DETAIL'] });
  const result = await h.call();
  assert.equal(result.status, 200);
  assert.match(result.body.serviceNotice, /历史对话仍可查看/);
  assert.doesNotMatch(result.body.serviceNotice, /node|tools|server\.js|SYNTHETIC_PRIVATE_DETAIL|原因：|下一步/);
  assert.equal(h.reads(), 0);
  const denied = await h.call('/api/send', 'POST');
  assert.equal(denied.status, 503);
  assert.equal(denied.body.error, result.body.serviceNotice);
});

test('M12 机主受限提示含具体已知原因和只读核对下一步，操作错误保持一致', async () => {
  const h = await harness({ blocked: ['验收后文件已变化：server.js', '尚未通过：filesystemDeny'] });
  const state = await h.call(), denied = await h.call('/api/send', 'POST');
  assert.match(state.body.serviceNotice, /服务代码与已验收版本不一致/);
  assert.match(state.body.serviceNotice, /文件访问边界尚未通过验收/);
  assert.match(state.body.serviceNotice, /下一步：.*node tools\/check-isolation\.cjs/);
  assert.doesNotMatch(state.body.serviceNotice, /refresh-isolation-receipt|maintain\.cjs deploy/);
  assert.equal(denied.status, 503); assert.equal(denied.body.error, state.body.serviceNotice);
  assert.equal(h.reads(), 0);
});

test('M12 未知启动异常/路径/文件名不作为原文展示给机主', async () => {
  const h = await harness({ blocked: [
    '隔离运行环境无法启动：SYNTHETIC_PRIVATE_DETAIL',
    '验收后文件已变化：SYNTHETIC_PRIVATE_FILENAME',
    '尚未通过：SYNTHETIC_PRIVATE_CHECK',
    '工作区不存在：SYNTHETIC_PRIVATE_USER',
    'SYNTHETIC_UNKNOWN_REASON',
  ] });
  const result = await h.call();
  assert.match(result.body.serviceNotice, /隔离运行环境无法启动/);
  assert.match(result.body.serviceNotice, /程序或依赖文件与已验收版本不一致/);
  assert.doesNotMatch(result.body.serviceNotice, /SYNTHETIC_/);
});

test('M12 正常机主状态每个请求只异步读取通知一次，下一请求可看到更新', async () => {
  const h = await harness({ notice: count => '  第' + count + '次维护提醒  ' });
  assert.equal((await h.call()).body.serviceNotice, '第1次维护提醒');
  assert.equal(h.reads(), 1);
  assert.equal((await h.call()).body.serviceNotice, '第2次维护提醒');
  assert.equal(h.reads(), 2);
});

test('M12 普通账号和未登录请求不读取机主通知', async () => {
  for (const user of [{ id: 'ordinary-fixture' }, { profile: 'Owner' }, { id: 'owner', profile: 'ordinary' }, null]) {
    const h = await harness({ user });
    const result = await h.call();
    assert.equal(result.status, user ? 200 : 401);
    assert.equal(result.body.serviceNotice, undefined); assert.equal(h.reads(), 0);
  }
});

test('M12 空通知/读取失败不影响状态请求；通知长度继续受限', async () => {
  for (const options of [{ notice: ' \n ' }, { readFails: true }]) {
    const h = await harness(options), result = await h.call();
    assert.equal(result.status, 200); assert.equal(result.body.serviceNotice, undefined); assert.equal(h.reads(), 1);
  }
  const h = await harness({ notice: '提'.repeat(800) });
  assert.equal((await h.call()).body.serviceNotice.length, 500);
  assert.equal(h.reads(), 1);
});
test('M12 服务通知在新对话首页也显示，不只在对话页的提示条里', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const hero = page.slice(page.indexOf('<section id="hero">'), page.indexOf('</section>', page.indexOf('<section id="hero">')));
  assert.ok(hero.includes('id="heroNotice"'));
  const render = page.slice(page.indexOf('function renderBanner()'), page.indexOf('let usageRefreshing'));
  assert.match(render, /\$\('#heroNotice'\)\.innerHTML = S\.serviceNotice \?/);
  assert.match(render, /esc\(S\.serviceNotice\)/);
});

test('通知条可以在这台设备上关掉：内容变了会再出现，「暂时无法回复」这类停用提示不能关', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const source = page.slice(page.indexOf('function renderBanner()'), page.indexOf('let usageRefreshing'));
  const store = new Map(), boxes = {};
  const box = () => { const el = { innerHTML: '', button: {}, querySelector(q) { return q === '.bx' && el.innerHTML.includes('class="bx"') ? el.button : null; } }; return el; };
  const context = { S: { serviceNotice: '' }, ls: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, esc: (v) => String(v).replace(/</g, '&lt;'), icon: () => '',
    usageWindows: () => [], usageName: () => '', fmtReset: () => '', $: (sel) => (boxes[sel] ||= box()) };
  require('node:vm').runInNewContext(source + '\nglobalThis.render = renderBanner;', context);
  const show = (text) => { context.S.serviceNotice = text; context.render(); return [boxes['#heroNotice'], boxes['#banner']]; };
  let [hero, dock] = show('Claude 9.9.9 自动升级没有成功 <b>');
  for (const el of [hero, dock]) { assert.match(el.innerHTML, /自动升级没有成功 &lt;b>/); assert.ok(el.querySelector('.bx')); }
  hero.button.onclick();
  assert.equal(hero.innerHTML, ''); assert.equal(dock.innerHTML, '');
  [hero, dock] = show('Claude 9.9.9 自动升级没有成功 <b>');
  assert.equal(hero.innerHTML, ''); assert.equal(dock.innerHTML, '');
  [hero, dock] = show('Claude 9.9.9 处于三天重试冷却期。');
  assert.match(hero.innerHTML, /冷却期/); assert.match(dock.innerHTML, /冷却期/);
  const blocked = '暂时无法回复和处理文件，历史对话仍可查看。请稍后再试，或联系机主。';
  store.set('noticeOff', blocked);
  [hero, dock] = show(blocked);
  for (const el of [hero, dock]) { assert.match(el.innerHTML, /暂时无法回复/); assert.equal(el.querySelector('.bx'), null); }
  const owner = '模型和文件功能暂时停用，历史对话仍可查看。原因：隔离核对未通过';
  store.set('noticeOff', owner);
  [hero, dock] = show(owner);
  for (const el of [hero, dock]) { assert.match(el.innerHTML, /暂时停用/); assert.equal(el.querySelector('.bx'), null); }
});

test('B2 服务通知带类别：受限是 blocked，机主维护提示是 maintenance，没有通知就没有类别', async () => {
  let h = await harness({ user: { id: 'ordinary-fixture' }, blocked: ['尚未通过：filesystemDeny'] });
  assert.equal((await h.call()).body.serviceNoticeKind, 'blocked');
  h = await harness({ blocked: ['尚未通过：filesystemDeny'] });
  assert.equal((await h.call()).body.serviceNoticeKind, 'blocked');
  h = await harness({ notice: 'Claude 9.9.9 自动升级没有成功（11月15日 06:13）' });
  assert.equal((await h.call()).body.serviceNoticeKind, 'maintenance');
  h = await harness({ readFails: true });
  assert.equal((await h.call()).body.serviceNoticeKind, undefined);
});

test('B2 网页按类别决定能不能关：blocked 不能关，maintenance 能关，旧服务没有类别时退回按文字判断', () => {
  return (async () => {
    const page = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
    const source = page.slice(page.indexOf('function renderBanner()'), page.indexOf('let usageRefreshing'));
    const store = new Map(), boxes = {};
    const box = () => { const el = { innerHTML: '', button: {}, querySelector(q) { return q === '.bx' && el.innerHTML.includes('class="bx"') ? el.button : null; } }; return el; };
    const context = { S: {}, ls: { get: k => store.get(k), set: (k, v) => store.set(k, v) }, esc: v => String(v), icon: () => '', usageWindows: () => [], usageName: () => '', fmtReset: () => '', $: sel => (boxes[sel] ||= box()) };
    vm.runInNewContext(source + '\nglobalThis.render = renderBanner;', context);
    const closable = (text, kind) => { context.S = { serviceNotice: text, serviceNoticeKind: kind }; context.render(); return !!boxes['#banner'].querySelector('.bx'); };
    assert.equal(closable('任何文字都行', 'blocked'), false);
    assert.equal(closable('暂时无法回复（就算文字像停用提示）', 'maintenance'), true);
    assert.equal(closable('暂时无法回复和处理文件', undefined), false);
    assert.equal(closable('Claude 9.9.9 处于冷却', undefined), true);
  })();
});
