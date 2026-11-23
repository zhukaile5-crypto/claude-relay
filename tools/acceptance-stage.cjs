'use strict';
// 验收用的合成工作目录（data\isolation-e2e-*）的安全删除。
// 目录里的 public、node_modules 是指向正式目录的目录联接：只删联接本身，绝不进入联接删东西。
const fs = require('node:fs'), path = require('node:path');
const NAME = /^isolation-e2e-[A-Za-z0-9]{6,32}$/;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// 只认 <root>\data\isolation-e2e-xxx 这一种形状，且它本身和上层都不能是联接。
function assertStage(root, stage) {
  const dataDir = path.join(path.resolve(root), 'data'), full = path.resolve(stage);
  if (!same(path.dirname(full), dataDir) || !NAME.test(path.basename(full))) throw Error('不是验收合成目录：' + full);
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink() || !st.isDirectory()) throw Error('验收合成目录本身是联接或不是目录：' + full);
  if (!same(fs.realpathSync.native(full), full)) throw Error('验收合成目录的上层含联接：' + full);
  return full;
}
function removeTree(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EISDIR') throw e; fs.rmdirSync(p); } return; }
  if (st.isDirectory()) { for (const name of fs.readdirSync(p)) removeTree(path.join(p, name)); fs.rmdirSync(p); return; }
  fs.unlinkSync(p);
}
// 返回 { removed, error }，不抛错：验收结果比清理重要，删不掉就留着并报告。
function removeStage(root, stage) {
  try { removeTree(assertStage(root, stage)); return { removed: true }; }
  catch (e) { return { removed: false, error: e.code ? e.code + ' ' + path.basename(e.path || '') : e.message }; }
}
// 列出可清理的残留：跳过最近 maxAgeMs 内改动过的（可能正被一次验收使用）。
function listStages(root, { now = Date.now(), minAgeMs = 6 * 3600e3 } = {}) {
  const dataDir = path.join(path.resolve(root), 'data');
  return fs.readdirSync(dataDir).filter(n => NAME.test(n)).map(name => {
    const full = path.join(dataDir, name), st = fs.lstatSync(full);
    return { name, full, mtimeMs: st.mtimeMs, recent: now - st.mtimeMs < minAgeMs, link: st.isSymbolicLink() };
  }).sort((a, b) => a.mtimeMs - b.mtimeMs);
}
module.exports = { assertStage, removeStage, listStages, NAME };
