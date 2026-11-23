'use strict';
// 首页诗句：按时节和时辰挑。只取页面里的那一段代码在内存里跑，不碰服务。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = page.indexOf('const POEMS = ['), end = page.indexOf('let verseShift = 0', start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({});
vm.runInContext(page.slice(start, end) + '\nglobalThis.api = { POEMS, versesFor, verseSlot, verseSeason, FIRST_DAY_VERSE, FIRST_NIGHT_VERSE };', context);
const { POEMS, versesFor, verseSlot, verseSeason, FIRST_DAY_VERSE, FIRST_NIGHT_VERSE } = context.api;
const at = (month, day, hour) => new Date(2027, month - 1, day, hour, 30);
const SEASON_DAYS = { 春: [3, 20], 夏: [7, 10], 秋: [9, 25], 冬: [12, 20] }, SLOT_HOURS = { 早: 8, 午: 13, 暮: 17, 夜: 22 };

test('每条诗句的格式：五项齐全，时节、时辰、味道只用约定的字，没有重复的句子', () => {
  const seen = new Set();
  for (const p of POEMS) {
    assert.equal(p.length, 5, p[0]);
    assert.match(p[0], /^[一-鿿，；？、]+$/, p[0]); assert.ok(p[1].length >= 4, p[0]);
    assert.match(p[2], /^[春夏秋冬]*$/, p[0]); assert.match(p[3], /^[早午暮夜]*$/, p[0]); assert.ok(['', '墨', '星'].includes(p[4]), p[0]);
    assert.ok(!seen.has(p[0]), '重复：' + p[0]); seen.add(p[0]);
  }
  assert.ok(POEMS.length >= 75);
  for (const banned of ['偷得浮生半日闲', '沾衣欲湿杏花雨', '危楼高百尺']) assert.ok(!POEMS.some(p => p[0].includes(banned)), banned);
});

test('时节按四立分，时辰分早午暮夜', () => {
  assert.equal(verseSeason(at(2, 3, 9)), '冬'); assert.equal(verseSeason(at(2, 4, 9)), '春');
  assert.equal(verseSeason(at(5, 6, 9)), '夏'); assert.equal(verseSeason(at(8, 8, 9)), '秋');
  assert.equal(verseSeason(at(11, 7, 9)), '秋'); assert.equal(verseSeason(at(11, 22, 9)), '冬');
  assert.deepEqual([4, 5, 10, 11, 15, 16, 18, 19, 23].map(h => verseSlot(at(6, 1, h))).join(''), '夜早早午午暮暮夜夜');
});

test('三家在每个时节、每个时辰都有句子可挑，挑出来的都合时节和时辰', () => {
  for (const provider of ['anthropic', 'openai', 'google']) for (const [season, [m, d]] of Object.entries(SEASON_DAYS)) for (const [slot, hour] of Object.entries(SLOT_HOURS)) {
    const r = versesFor(provider, at(m, d, hour)), where = provider + ' ' + season + slot;
    assert.equal(r.season, season); assert.equal(r.slot, slot);
    assert.ok(r.list.length >= 4, where + ' 只有 ' + r.list.length + ' 句');
    assert.ok(r.seasonal >= 1, where + ' 没有应季的句子');
    for (const p of r.list) { assert.ok(!p[2] || p[2].includes(season), where + '：' + p[0]); assert.ok(!p[3] || p[3].includes(slot), where + '：' + p[0]); }
    r.list.slice(0, r.seasonal).forEach(p => assert.ok(p[2], where)); // 应季的排在前面
  }
});

test('味道：星月的句子 Claude 只在暮、夜用；水墨、星河先用自己那一味', () => {
  for (const hour of [8, 13]) assert.ok(!versesFor('anthropic', at(9, 25, hour)).list.some(p => p[4] === '星'));
  assert.ok(versesFor('anthropic', at(9, 25, 22)).list.some(p => p[4] === '星'));
  assert.ok(versesFor('google', at(9, 25, 22)).list.every(p => p[4] === '星'));
  assert.ok(versesFor('openai', at(12, 20, 8)).list.some(p => p[4] === '墨'));
  // 冬夜不会出现荷花，夏天的中午不会出现雪
  assert.ok(!versesFor('anthropic', at(12, 20, 22)).list.some(p => /荷|莲/.test(p[0])));
  assert.ok(!versesFor('anthropic', at(7, 10, 13)).list.some(p => /雪|梅/.test(p[0])));
});

test('第一次打开那天的两句还在', () => {
  assert.equal(FIRST_DAY_VERSE[0], '泉眼无声惜细流，树阴照水爱晴柔'); assert.equal(FIRST_NIGHT_VERSE[0], '海上生明月，天涯共此时');
});
