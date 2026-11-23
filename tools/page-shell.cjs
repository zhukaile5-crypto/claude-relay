'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
// 页面内容与依赖共同决定版本；异步读取、合并并发刷新，避免状态轮询反复阻塞。
function createPageShell({ publicDir, assets = [], assetDirectories = [], backgroundRefresh = false, intervalMs = 5000, now = () => Date.now() }) {
  let cached, pending, nextCheck = 0;
  const hashes = new Map();
  async function inventory() {
    const files = new Set([path.join(publicDir, 'index.html'), path.join(publicDir, 'sw.js'), path.join(publicDir, 'scoped-links.js'), ...assets]), metadataOnly = new Set();
    async function walk(folder, light = false) {
      let entries; try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw Error('前端资源目录不能包含链接');
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file, light); else if (entry.isFile()) { if (light && !files.has(file)) metadataOnly.add(file); files.add(file); }
        if (files.size > 10000) throw Error('前端资源过多');
      }
    }
    await walk(path.join(publicDir, 'vendor'));
    // 字体有数千个、近百兆，每次启动全读一遍会挡住首个请求；它们只随 npm 安装变化，大小和时间足以发现。
    for (const folder of assetDirectories) await walk(folder, true);
    return { files: [...files].sort(), metadataOnly };
  }
  async function rebuild() {
    const { files, metadataOnly } = await inventory(), aggregate = crypto.createHash('sha256');
    let raw;
    for (const file of files) {
      const stat = await fs.stat(file), prior = hashes.get(file); let entry = prior;
      if (metadataOnly.has(file)) {
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: 'metadata:' + stat.size + ':' + stat.mtimeMs };
        hashes.set(file, entry);
      } else if (!prior || prior.size !== stat.size || prior.mtimeMs !== stat.mtimeMs || prior.ctimeMs !== stat.ctimeMs) {
        const bytes = await fs.readFile(file), after = await fs.stat(file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('资源读取期间被替换');
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: crypto.createHash('sha256').update(bytes).digest('hex'), text: file === path.join(publicDir,'index.html') ? bytes.toString('utf8') : undefined };
        hashes.set(file, entry);
      }
      aggregate.update(path.relative(publicDir,file).replace(/\\/g,'/') + '\0' + entry.hash + '\0');
      if (file === path.join(publicDir,'index.html')) raw = entry.text;
    }
    for (const file of hashes.keys()) if (!files.includes(file)) hashes.delete(file);
    const build = aggregate.digest('hex').slice(0,16);
    const html = raw.replace('__PAGE_BUILD__',build).replace(/((?:src|href)=["'])(\/vendor\/[^"'?]+)(?:\?[^"']*)?(["'])/g, '$1$2?build=' + build + '$3');
    cached = { build, body: Buffer.from(html, 'utf8') }; return cached;
  }
  async function get() {
    if (pending) return backgroundRefresh && cached ? cached : pending;
    if (cached && now() < nextCheck) return cached;
    pending = rebuild().catch(error => { if (cached) return cached; throw error; }).finally(() => { nextCheck = now() + intervalMs; pending = null; });
    return backgroundRefresh && cached ? cached : pending;
  }
  return { get };
}
module.exports = { createPageShell };