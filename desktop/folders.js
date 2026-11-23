'use strict';
// 关联文件夹（桌面端在用户电脑上的这一半）。
// 用户在桌面端选一个自己电脑上的文件夹；网页把里面的文件整个传到对话的工作区（超过下面的上限的，网页改成按需：
// 只传一份清单，模型用到哪个取哪个），模型读、改的是那份副本，改动再由网页按用户选的权限档位写回来。
// 这个文件只管用户电脑上的事：记住关联了哪些文件夹、扫描、读、写、
// 进回收站、备份和撤销。全部用相对路径，出不了用户选的那个文件夹；不依赖 Electron，方便在 Node 里测试。
//
// 权限档位（存在这里，网页改不了规则，只能请求换档；从严到宽）：
//   read 只读      —— 不往用户电脑上写任何东西
//   ask  每次问我   —— 每一处改动都要用户点头（由网页展示、用户确认后才调用 write / trash）
//   auto 自动审查   —— 新建、普通修改自动写回；删除、冲突、脚本、大改动仍然先问用户
//   all  全部允许   —— 都自动写回（删除进回收站）；两边都改过的仍然先问用户
// 不管哪一档：写之前先把原文件备份一份，删除一律进回收站，30 天内可以撤销。
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const TIERS = ['read', 'ask', 'auto', 'all'];
// 整个传过去的上限：一个文件夹最多 5000 个文件、共 5GB，单个文件 500MB（服务器那边单个文件的上限也是 500MB）。
// 超过的文件夹照样能关联（add 带 anySize），网页对它按需取文件
const LIMITS = { files: 5000, bytes: 5 * 1024 * 1024 * 1024, file: 500 * 1024 * 1024, visit: 60000, depth: 10, state: 8 * 1024 * 1024, keepDays: 30 };
const CHUNK_MAX = 8 * 1024 * 1024; // 分段读写时一段最多这么大
// 扫描时不看的名字（系统文件、依赖目录）；点开头的和 Office 的临时锁文件（~$ 开头）也不看
const SKIP = new Set(['node_modules', '__pycache__', '$recycle.bin', 'system volume information', 'thumbs.db', 'desktop.ini']);
// 不上传、也绝不写回的类型：程序、快捷方式、注册表文件。模型没有理由往用户电脑上放这些
const BLOCKED = new Set('.exe .dll .scr .msi .msp .com .pif .cpl .lnk .url .hta .reg .sys .drv .ocx .jar .scf .inf .chm'.split(' '));
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i; // Windows 的保留名
const ID = /^[a-f0-9]{16}$/, BATCH = /^\d{8}-\d{6}-[a-f0-9]{6}$/;

const fail = (code, userMessage) => Object.assign(new Error(userMessage), { code, userMessage });
const skipName = (name) => name.startsWith('.') || name.startsWith('~$') || SKIP.has(name.toLowerCase());
const blockedType = (rel) => BLOCKED.has(path.extname(rel).toLowerCase());
const stamp = (st) => ({ size: st.size, mtime: Math.round(st.mtimeMs) });
const sameStamp = (a, b) => (!a && !b) || (!!a && !!b && a.size === b.size && a.mtime === b.mtime);

// 相对路径（用 / 分隔）逐段检查，规则和服务器收文件时一致：不许空段、. 和 ..、点开头、Windows 不认的字符
function relParts(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return null;
  const parts = rel.split('/');
  if (parts.length > 12) return null;
  for (const s of parts) {
    if (!s || s.length > 200 || skipName(s) || /[<>:"\\|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || DEVICE.test(s)) return null;
  }
  return parts;
}

function create({ dir, home = '', env = process.env, trash, now = () => new Date() }) {
  if (!dir || typeof trash !== 'function') throw new TypeError('需要数据目录和回收站函数');
  const linksFile = path.join(dir, 'links.json');
  const under = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const atomic = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try { fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, file); } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  };
  const load = () => {
    try { const v = JSON.parse(fs.readFileSync(linksFile, 'utf8')); return Array.isArray(v.links) ? v.links.filter((l) => l && ID.test(l.id) && typeof l.root === 'string' && TIERS.includes(l.tier)) : []; }
    catch { return []; }
  };
  const save = (links) => atomic(linksFile, JSON.stringify({ links }, null, 1));
  const exists = (root) => { try { return fs.statSync(root).isDirectory(); } catch { return false; } };
  const view = (l) => ({ id: l.id, name: l.name, path: l.root, tier: l.tier, scope: l.scope || '', addedAt: l.addedAt || 0, missing: !exists(l.root) });
  // 授权是按「范围」分开的：一个对话（或一个项目）一份。同一个文件夹给两个对话用，是两条各自独立的授权，
  // 各有各的档位、各自的副本和同步记录，互不影响；一个对话授权过，另一个对话还得用户再点一次头
  const scopeOf = (scope) => (typeof scope === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(scope) ? scope : '');
  const need = (id) => {
    const link = ID.test(id || '') && load().find((l) => l.id === id);
    if (!link) throw fail('NO_LINK', '这个文件夹已经不在关联列表里了');
    return link;
  };
  const needRoot = (link) => { if (!exists(link.root)) throw fail('MISSING', `找不到文件夹「${link.name}」，它可能被移走或改名了`); return link; };

  // 哪些文件夹不让关联：整个盘、整个用户文件夹（或它的上级）、系统和程序目录、应用自己的数据目录。
  // 关联的文件夹里的文件会传到对话里、也会被改，范围太大既慢又不安全
  function checkRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('BAD_ROOT', '文件夹路径不对');
    root = path.resolve(root);
    let st; try { st = fs.lstatSync(root); } catch { throw fail('BAD_ROOT', '找不到这个文件夹'); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw fail('BAD_ROOT', '请选一个普通的文件夹（不能是快捷方式或链接）');
    if (path.parse(root).root === root) throw fail('TOO_WIDE', '不能关联整个盘，请选里面的一个文件夹');
    if (home && under(root, path.resolve(home))) throw fail('TOO_WIDE', '这个文件夹范围太大了（包含整个用户文件夹），请选里面的一个文件夹');
    const guarded = [env.WINDIR, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.APPDATA, env.LOCALAPPDATA, dir]
      .filter(Boolean).map((p) => path.resolve(p));
    if (home) guarded.push(path.join(path.resolve(home), 'AppData'));
    for (const g of guarded) if (under(g, root) || under(root, g)) throw fail('SYSTEM', '系统和程序的文件夹不能关联');
    return root;
  }

  // 相对路径 → 用户电脑上的绝对路径。路上任何一级是链接（符号链接、目录联接）都不走，最后再用真实路径核对一遍
  function target(link, rel) {
    const parts = relParts(rel);
    if (!parts) throw fail('BAD_PATH', '文件名或路径不合适：' + String(rel).slice(0, 80));
    let cur = link.root, deepest = link.root;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      let st; try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
      if (st.isSymbolicLink()) throw fail('LINK', '路径里有链接，不能读写：' + rel);
      if (i < parts.length - 1 && !st.isDirectory()) throw fail('BAD_PATH', '路径不对：' + rel);
      deepest = cur;
    }
    if (!under(fs.realpathSync(link.root), fs.realpathSync(deepest))) throw fail('LINK', '路径跑到文件夹外面去了：' + rel);
    return path.join(link.root, ...parts);
  }
  const statFile = (abs) => {
    try { const st = fs.statSync(abs); if (!st.isFile()) throw fail('BAD_PATH', '这不是一个文件'); return stamp(st); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };

  // ---- 备份：每一批写回一个文件夹，里面是被改、被删文件的原样，外加一份记录（撤销时照着它还原）----
  const backupRoot = (link) => path.join(dir, 'backups', link.id);
  function batchOf(link, id) {
    if (!BATCH.test(id || '') || !fs.existsSync(path.join(backupRoot(link), id, 'log.json'))) {
      const d = now(), p2 = (n) => String(n).padStart(2, '0');
      id = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
      atomic(path.join(backupRoot(link), id, 'log.json'), JSON.stringify({ at: d.getTime(), entries: [] }));
    }
    return { id, dir: path.join(backupRoot(link), id) };
  }
  const readLog = (batch) => JSON.parse(fs.readFileSync(path.join(batch.dir, 'log.json'), 'utf8'));
  const record = (batch, entry) => { const log = readLog(batch); log.entries.push(entry); atomic(path.join(batch.dir, 'log.json'), JSON.stringify(log)); };
  const backupPath = (batch, rel) => path.join(batch.dir, 'files', ...rel.split('/'));
  function keepCopy(batch, rel, abs) { const to = backupPath(batch, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(abs, to); }
  function putBytes(abs, bytes) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), '.claude-write-' + crypto.randomBytes(6).toString('hex'));
    try { fs.writeFileSync(tmp, bytes, { flag: 'wx' }); fs.renameSync(tmp, abs); }
    catch (e) { if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw fail('BUSY', '写不进去：' + path.basename(abs) + ' 可能正被别的程序打开，关掉后再试'); throw e; }
    finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }
  // 写这个文件要新建哪些文件夹（从最里面的开始）。撤销「新建」时把它们一起收走，不在用户那里留下空文件夹
  const newDirs = (link, abs) => {
    const out = [];
    for (let p = path.dirname(abs); p.length > link.root.length && !fs.existsSync(p); p = path.dirname(p)) out.push(path.relative(link.root, p).split(path.sep).join('/'));
    return out;
  };
  // 分段写回时还没写完的那些（见 writeStart）：token → 攒到哪了
  const pendingWrites = new Map();
  const dropWrite = (token) => {
    const w = pendingWrites.get(token); if (!w) return;
    pendingWrites.delete(token);
    try { if (w.fd !== null) fs.closeSync(w.fd); } catch {}
    try { fs.rmSync(w.tmp, { force: true }); } catch {}
  };
  const writable = (link) => { if (link.tier === 'read') throw fail('READ_ONLY', `「${link.name}」现在是只读，不会改动你电脑上的文件`); return link; };

  const api = {
    TIERS, LIMITS,
    list: () => load().map(view),

    // 关联一个文件夹（路径只能来自系统的选文件夹对话框、或用户在确认窗里点了信任的位置，由 main.js 保证）。
    // 返回里带着 count、bytes、tooMany：网页据此决定整个传过去（没超上限），还是按需取文件（tooMany，只传清单）。
    // anySize：超过上限的也让关联（桌面端的两个入口都带它，超了的由网页改成按需）；不带时太大的直接拒绝。tier：一开始就用这个档位
    add(root, { anySize = false, tier, scope } = {}) {
      scope = scopeOf(scope);
      root = checkRoot(root);
      const links = load(), had = links.find((l) => (l.scope || '') === scope && path.resolve(l.root).toLowerCase() === root.toLowerCase());
      if (had) return { ...view(had), existed: true, ...summary(had) };
      const link = { id: crypto.randomBytes(8).toString('hex'), root, name: path.basename(root).slice(0, 60) || '文件夹', tier: 'ask', addedAt: now().getTime(), ...(scope ? { scope } : {}) };
      const sum = summary(link);
      if (tier !== undefined && !TIERS.includes(tier)) throw fail('BAD_TIER', '没有这个权限档位');
      if (tier) link.tier = tier;
      if (sum.tooMany && !anySize) throw fail('TOO_BIG', `这个文件夹太大了（超过 ${LIMITS.files} 个文件或 ${LIMITS.bytes / 1048576}MB），换里面一个小一点的文件夹试试`);
      save([...links, link]);
      return { ...view(link), existed: false, ...sum };
    },
    // 关联之前先看一眼：这个位置能不能关联、里面有多少东西（模型请求访问某个位置时，确认框里要写给用户看）。
    // 给的是一个文件就取它所在的文件夹
    preview(where, scope) {
      scope = scopeOf(scope);
      if (typeof where !== 'string' || !path.isAbsolute(where) || where.length > 400) throw fail('BAD_ROOT', '这个位置的路径不对');
      let at = path.resolve(where);
      try { if (fs.statSync(at).isFile()) at = path.dirname(at); } catch { throw fail('BAD_ROOT', '你的电脑上找不到这个位置：' + where.slice(0, 120)); }
      at = checkRoot(at);
      const had = load().find((l) => (l.scope || '') === scope && path.resolve(l.root).toLowerCase() === at.toLowerCase());
      const sum = summary({ root: at });
      return { root: at, name: path.basename(at).slice(0, 60) || '文件夹', existed: !!had, id: had ? had.id : null, ...sum };
    },
    remove(id) {
      const links = load();
      if (!links.some((l) => l.id === id)) return false;
      save(links.filter((l) => l.id !== id));
      try { fs.rmSync(path.join(dir, 'state', id + '.json'), { force: true }); } catch {}
      return true; // 备份留着，到期自己清
    },
    setTier(id, tier) {
      if (!TIERS.includes(tier)) throw fail('BAD_TIER', '没有这个权限档位');
      const links = load(), link = links.find((l) => l.id === id);
      if (!link) throw fail('NO_LINK', '这个文件夹已经不在关联列表里了');
      link.tier = tier; save(links);
      return view(link);
    },
    get: (id) => view(need(id)),
    rootOf: (id) => needRoot(need(id)).root,
    resolve: (id, rel) => target(needRoot(need(id)), rel),

    // 列出文件夹里要同步的文件。不跟着链接走；跳过的（太大、名字不合适、类型不收）另外报给网页，让用户知道
    // 不带 all：按「整个同步」的上限扫，超了就停、回 tooMany（网页据此决定整个同步还是按需）；
    // all：不按这个上限截断（按需取文件的文件夹要一份完整的清单）
    scan(id, { all = false } = {}) { return scanLink(needRoot(need(id)), all === true); },

    read(id, rel) {
      const link = needRoot(need(id));
      if (blockedType(rel)) throw fail('BLOCKED_TYPE', '这种类型的文件不同步：' + rel);
      const abs = target(link, rel), fd = fs.openSync(abs, 'r');
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw fail('BAD_PATH', '这不是一个文件');
        if (st.size > LIMITS.file) throw fail('TOO_BIG', '文件太大，不同步：' + rel);
        const bytes = Buffer.alloc(st.size);
        let got = 0; while (got < st.size) { const n = fs.readSync(fd, bytes, got, st.size - got, got); if (!n) break; got += n; }
        return { bytes: got === st.size ? bytes : bytes.subarray(0, got), ...stamp(st) };
      } finally { fs.closeSync(fd); }
    },

    // ---- 大文件：一段一段读、一段一段写，不把几百 MB 整个放进内存 ----
    stat(id, rel) { return statFile(target(needRoot(need(id)), rel)); },
    readChunk(id, rel, offset, length) {
      const link = needRoot(need(id));
      if (blockedType(rel)) throw fail('BLOCKED_TYPE', '这种类型的文件不同步：' + rel);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > CHUNK_MAX) throw fail('BAD_RANGE', '读取范围不对');
      const abs = target(link, rel), fd = fs.openSync(abs, 'r');
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw fail('BAD_PATH', '这不是一个文件');
        if (st.size > LIMITS.file) throw fail('TOO_BIG', '文件太大，不同步：' + rel);
        const want = Math.max(0, Math.min(length, st.size - offset)), bytes = Buffer.alloc(want);
        let got = 0; while (got < want) { const n = fs.readSync(fd, bytes, got, want - got, offset + got); if (!n) break; got += n; }
        return { bytes: bytes.subarray(0, got), ...stamp(st) };
      } finally { fs.closeSync(fd); }
    },
    // 文件内容的指纹（sha256）：大文件要看两边是不是一样时用它，不用把内容搬来搬去
    hash(id, rel) {
      const link = needRoot(need(id)), abs = target(link, rel), fd = fs.openSync(abs, 'r');
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw fail('BAD_PATH', '这不是一个文件');
        if (st.size > LIMITS.file) throw fail('TOO_BIG', '文件太大：' + rel);
        const sum = crypto.createHash('sha256'), buf = Buffer.alloc(1024 * 1024);
        for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; sum.update(buf.subarray(0, n)); }
        return { sha: sum.digest('hex'), ...stamp(st) };
      } finally { fs.closeSync(fd); }
    },
    // 分段写回：内容先攒在应用自己的数据目录里（中途断了不会在用户的文件夹里留下半个文件），收齐、核对过再换进去。
    // 规则和 write 一样：只读档不写、程序类不写、用户刚改过的不覆盖、原文件先备份
    writeStart(id, rel, { batch, expect, size } = {}) {
      const link = writable(needRoot(need(id)));
      if (blockedType(rel)) throw fail('BLOCKED_TYPE', '这种类型的文件不会写到你的电脑上：' + rel);
      if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.file) throw fail('TOO_BIG', '文件太大，不写回：' + rel);
      const before = statFile(target(link, rel));
      if (expect !== undefined && !sameStamp(before, expect)) return { conflict: true, now: before };
      for (const [old, w] of pendingWrites) if (now().getTime() - w.startedAt > 3600000) dropWrite(old); // 一小时前没写完的不要了
      const token = crypto.randomBytes(8).toString('hex'), tmp = path.join(dir, 'tmp', token);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      pendingWrites.set(token, { id, rel, tmp, fd: fs.openSync(tmp, 'wx'), size, got: 0, batch, expect, startedAt: now().getTime() });
      return { token };
    },
    writeChunk(token, bytes) {
      const w = pendingWrites.get(token);
      if (!w) throw fail('NO_WRITE', '这次写回已经失效，请重试');
      if (!(bytes instanceof Uint8Array) || w.got + bytes.length > w.size) { dropWrite(token); throw fail('BAD_DATA', '文件内容不对'); }
      fs.writeSync(w.fd, bytes); w.got += bytes.length;
      return { received: w.got };
    },
    writeEnd(token) {
      const w = pendingWrites.get(token);
      if (!w) throw fail('NO_WRITE', '这次写回已经失效，请重试');
      try {
        fs.closeSync(w.fd); w.fd = null;
        if (w.got !== w.size) throw fail('BAD_DATA', '文件没有收全，没有写回');
        const link = writable(needRoot(need(w.id))), abs = target(link, w.rel), before = statFile(abs);
        if (w.expect !== undefined && !sameStamp(before, w.expect)) return { conflict: true, now: before };
        const b = batchOf(link, w.batch);
        if (before) keepCopy(b, w.rel, abs);
        const dirs = before ? [] : newDirs(link, abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const side = path.join(path.dirname(abs), '.claude-write-' + crypto.randomBytes(6).toString('hex'));
        try { fs.copyFileSync(w.tmp, side, fs.constants.COPYFILE_EXCL); fs.renameSync(side, abs); }
        catch (e) { if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw fail('BUSY', '写不进去：' + path.basename(abs) + ' 可能正被别的程序打开，关掉后再试'); throw e; }
        finally { try { fs.rmSync(side, { force: true }); } catch {} }
        const after = statFile(abs);
        record(b, { path: w.rel, kind: before ? 'modified' : 'created', after, ...(dirs.length ? { dirs } : {}) });
        return { ...after, batch: b.id };
      } finally { dropWrite(token); }
    },
    writeAbort(token) { dropWrite(token); return true; },

    // 把模型改好的内容写回用户的文件。expect：网页看到的这个文件现在的样子（没有就是 null）；对不上说明用户刚刚自己改过，
    // 不覆盖，回 conflict 让网页重新比对。原文件先备份
    write(id, rel, bytes, { batch, expect } = {}) {
      const link = writable(needRoot(need(id)));
      if (blockedType(rel)) throw fail('BLOCKED_TYPE', '这种类型的文件不会写到你的电脑上：' + rel);
      if (!(bytes instanceof Uint8Array)) throw fail('BAD_DATA', '文件内容不对');
      if (bytes.length > LIMITS.file) throw fail('TOO_BIG', '文件太大，不写回：' + rel);
      const abs = target(link, rel), before = statFile(abs);
      if (expect !== undefined && !sameStamp(before, expect)) return { conflict: true, now: before };
      const b = batchOf(link, batch);
      if (before) keepCopy(b, rel, abs);
      const dirs = before ? [] : newDirs(link, abs);
      putBytes(abs, bytes);
      const after = statFile(abs);
      record(b, { path: rel, kind: before ? 'modified' : 'created', after, ...(dirs.length ? { dirs } : {}) });
      return { ...after, batch: b.id };
    },

    // 删除 = 进回收站（先留一份备份，撤销时不用去回收站里找）
    async trash(id, rel, { batch, expect } = {}) {
      const link = writable(needRoot(need(id)));
      const abs = target(link, rel), before = statFile(abs);
      if (!before) return { gone: true };
      if (expect !== undefined && !sameStamp(before, expect)) return { conflict: true, now: before };
      const b = batchOf(link, batch);
      if (before.size <= LIMITS.file) keepCopy(b, rel, abs);
      await trash(abs);
      record(b, { path: rel, kind: 'deleted', kept: before.size <= LIMITS.file });
      return { batch: b.id };
    },

    // 撤销一批写回：改过的还原、新建的进回收站、删掉的放回来。写回之后用户自己又动过的文件不碰，原样报给用户
    async undo(id, batchId) {
      const link = needRoot(need(id));
      if (!BATCH.test(batchId || '')) throw fail('NO_BATCH', '找不到这次写回的记录');
      const batch = { id: batchId, dir: path.join(backupRoot(link), batchId) };
      let log; try { log = readLog(batch); } catch { throw fail('NO_BATCH', '这次写回的备份已经过期，不能撤销了'); }
      if (log.undone) throw fail('UNDONE', '这次写回已经撤销过了');
      const restored = [], skipped = [];
      for (const e of [...log.entries].reverse()) {
        try {
          const abs = target(link, e.path), cur = statFile(abs);
          if (e.kind === 'deleted') {
            if (cur || !e.kept) { skipped.push(e.path); continue; }
            putBytes(abs, fs.readFileSync(backupPath(batch, e.path)));
          } else if (!sameStamp(cur, e.after)) { skipped.push(e.path); continue; }
          else if (e.kind === 'created') {
            await trash(abs);
            for (const d of e.dirs || []) { try { fs.rmdirSync(target(link, d)); } catch { break; } } // 只收空的；里面还有东西就留着
          }
          else putBytes(abs, fs.readFileSync(backupPath(batch, e.path)));
          restored.push(e.path);
        } catch { skipped.push(e.path); }
      }
      log.undone = true; atomic(path.join(batch.dir, 'log.json'), JSON.stringify(log));
      return { restored, skipped };
    },

    // 网页存放的同步记录（上次同步时每个文件两边的大小和时间）。内容由网页定，这里只是替它存在本机
    getState(id) { need(id); try { return fs.readFileSync(path.join(dir, 'state', id + '.json'), 'utf8'); } catch { return ''; } },
    setState(id, text) {
      need(id);
      if (typeof text !== 'string' || text.length > LIMITS.state) throw fail('BAD_STATE', '同步记录太大');
      atomic(path.join(dir, 'state', id + '.json'), text); return true;
    },

    // 清掉过期的备份（启动时调一次）
    prune() {
      const cutoff = now().getTime() - LIMITS.keepDays * 86400000; let removed = 0;
      // 上次没写完的分段写回（应用被关掉了）：攒着的内容清掉
      try { for (const name of fs.readdirSync(path.join(dir, 'tmp'))) if (!pendingWrites.has(name)) fs.rmSync(path.join(dir, 'tmp', name), { force: true }); } catch {}
      let ids; try { ids = fs.readdirSync(path.join(dir, 'backups')); } catch { return 0; }
      for (const id of ids) {
        let batches; try { batches = fs.readdirSync(path.join(dir, 'backups', id)); } catch { continue; }
        for (const b of batches) {
          const full = path.join(dir, 'backups', id, b);
          try { if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { recursive: true, force: true }); removed++; } } catch {}
        }
      }
      return removed;
    },
  };

  function scanLink(link, all = false) {
    const files = [], skipped = []; let bytes = 0, visited = 0, tooMany = false, skippedCount = 0;
    const skip = (p, why, size) => { skippedCount++; if (skipped.length < 100) skipped.push({ path: p, why, ...(size ? { size } : {}) }); };
    (function walk(folder, base, depth) {
      let entries; try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (tooMany) return;
        if (++visited > LIMITS.visit) { tooMany = true; return; }
        if (skipName(e.name)) continue;
        const rel = base ? base + '/' + e.name : e.name, full = path.join(folder, e.name);
        if (e.isSymbolicLink()) { skip(rel, 'link'); continue; }
        if (!relParts(rel)) { skip(rel, 'name'); continue; }
        if (e.isDirectory()) { if (depth >= LIMITS.depth) skip(rel, 'deep'); else walk(full, rel, depth + 1); continue; }
        if (!e.isFile()) continue;
        if (blockedType(rel)) { skip(rel, 'type'); continue; }
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (st.size > LIMITS.file) { skip(rel, 'big', st.size); continue; }
        if (!all && (files.length >= LIMITS.files || bytes + st.size > LIMITS.bytes)) { tooMany = true; return; }
        files.push({ path: rel, ...stamp(st) }); bytes += st.size;
      }
    })(link.root, '', 0);
    return { files, bytes, skipped, skippedCount, tooMany };
  }
  function summary(link) { const s = scanLink(link); return { count: s.files.length, bytes: s.bytes, skippedCount: s.skippedCount, tooMany: s.tooMany }; }

  return api;
}

module.exports = { create, relParts, TIERS, LIMITS, BLOCKED, CHUNK_MAX };
