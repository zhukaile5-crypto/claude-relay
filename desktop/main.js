// Claude 桌面端（claude-relay.example 的桌面外壳）
// 窗口里加载 https://claude-relay.example，界面、账号、对话都和网页版一样；桌面端只补浏览器给不了的东西：
// 长期登录、托盘常驻、回复完成提醒、开机启动、右键菜单，以及「关联文件夹」——让模型读、改用户自己电脑上
// 某个文件夹里的文件（用户选的那个文件夹之外一概碰不到，见 folders.js）。
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, session, ipcMain, clipboard, screen, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 调试用：RELAY_DESKTOP_ORIGIN 指到本机的测试服务（只认 localhost）。只有没打包、从源码启动时才认；装到用户电脑上的版本
// 里 DEV_ORIGIN 永远是空的，下面几处「测试用」的分支都走不到
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(process.env.RELAY_DESKTOP_ORIGIN || '') && !app.isPackaged ? process.env.RELAY_DESKTOP_ORIGIN : '';
const ORIGIN = DEV_ORIGIN || 'https://claude-relay.example';
const APP_ID = 'org.clauderelay.desktop';
const startHidden = process.argv.includes('--hidden');   // 开机自启时只进托盘

// 数据文件夹（登录 cookie、窗口位置等）固定用「Claude Relay」：产品名是 Claude，Electron 默认会用
// %APPDATA%\Claude，那是官方 Claude 桌面应用的数据文件夹，两个程序混用会互相弄坏。
// 必须在单实例锁之前设置（锁也放在这个文件夹里）
app.setPath('userData', DEV_ORIGIN && process.env.RELAY_DESKTOP_USERDATA ? path.resolve(process.env.RELAY_DESKTOP_USERDATA) : path.join(app.getPath('appData'), 'Claude Relay'));

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId(APP_ID);   // Windows 通知要靠它显示应用名

let win = null, tray = null, quitting = false;
const iconPath = path.join(__dirname, 'icons', 'icon.png');
const statePath = () => path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } };
const writeState = (s) => { try { fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...s })); } catch {} };
const sameOrigin = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// 窗口不用系统那条标题栏（颜色跟着系统走，和页面的纸色接不上，机主说「非常难看」）：页面顶到窗口最上面，
// 右上角只留最小化 / 最大化 / 关闭三个按钮，底下透明、露出页面自己的颜色。页面那边用 env(titlebar-area-width)
// 给这三个按钮让出位置（public/index.html）。
const CHROME_H = 44;
const chrome = () => ({ color: 'rgba(0,0,0,0)', symbolColor: nativeTheme.shouldUseDarkColors ? '#d8d4ca' : '#4a4843', height: CHROME_H });
// 没了标题栏就得自己留一条能拖动窗口的地方。由桌面端塞进每个页面，不靠页面自己写：电脑睡着时的提示页、
// 断网页、登录页也都拖得动。按钮、链接、输入框照常能点
const DRAG_CSS = 'html::before { content: ""; position: fixed; top: 0; left: 0; right: 0; height: ' + CHROME_H + 'px; -webkit-app-region: drag; pointer-events: none; z-index: 2147483647; }\n' +
  'button, a, input, textarea, select, summary, label, [role="button"], [contenteditable] { -webkit-app-region: no-drag; }';
nativeTheme.on('updated', () => { try { if (win && !win.isDestroyed()) win.setTitleBarOverlay(chrome()); } catch {} });

function createWindow() {
  const st = readState(), work = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    titleBarStyle: 'hidden', titleBarOverlay: chrome(),
    width: st.width || Math.min(1200, Math.round(work.width * 0.8)), height: st.height || Math.min(860, Math.round(work.height * 0.85)), x: st.x, y: st.y,
    minWidth: 380, minHeight: 500,
    // 底色和网页的 --bg 一致，系统是深色模式时打开窗口不会先闪一下白
    title: 'Claude', icon: iconPath, backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      additionalArguments: ['--relay-version=' + app.getVersion()], // preload 从这里读版本号，不用再写死
    },
  });
  // 记住缩放：每次加载完恢复上次的缩放比例（Ctrl + 加号 / 减号 / 0 调的）
  win.webContents.on('did-finish-load', () => { const z = readState().zoom; if (typeof z === 'number') win.webContents.setZoomLevel(z); });
  win.webContents.on('dom-ready', () => { win.webContents.insertCSS(DRAG_CSS).catch(() => {}); });
  win.setMenu(null);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.loadURL(ORIGIN + '/');

  // 网络不通（用户这边断网 / 域名解析失败）时显示本地提示页；电脑睡着由 Cloudflare 的睡觉页面处理，不走这里
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && sameOrigin(url)) win.loadFile(path.join(__dirname, 'offline.html'));
  });

  // 站内链接留在应用里（文件预览开新窗口），站外链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: iconPath, width: 1000, height: 760 } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url) && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('did-create-window', (child) => { child.setMenu(null); attachHelpers(child.webContents); });
  attachHelpers(win.webContents);

  const save = () => { if (!win.isMaximized() && !win.isMinimized()) writeState(win.getBounds()); writeState({ maximized: win.isMaximized() }); };
  win.on('resize', save); win.on('move', save);
  // 关窗口 = 收进托盘，回复好了照样提醒；真正退出用托盘菜单
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!readState().trayTipShown) {
      tray?.displayBalloon({ title: 'Claude 还在托盘里', content: '回复好了会提醒你。右键托盘图标可以退出。', iconType: 'info' });
      writeState({ trayTipShown: true });
    }
  });
  win.on('focus', () => win.flashFrame(false));
}

// 缩放；主窗口的缩放比例记下来，下次打开沿用（文件预览等小窗口不记）
function zoom(wc, level) {
  wc.setZoomLevel(level);
  if (win && wc === win.webContents) writeState({ zoom: level });
}

// 右键菜单（复制粘贴）和快捷键（刷新、缩放、调试）
function attachHelpers(wc) {
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) items.push({ label: '复制链接', click: () => clipboard.writeText(p.linkURL) });
    if (p.isEditable) items.push({ label: '剪切', role: 'cut', enabled: p.editFlags.canCut }, { label: '复制', role: 'copy', enabled: p.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { label: '全选', role: 'selectAll' });
    else if (p.selectionText) items.push({ label: '复制', role: 'copy' });
    if (p.mediaType === 'image' && p.srcURL) items.push({ label: '复制图片', click: () => wc.copyImageAt(p.x, p.y) });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key.toLowerCase();
    if (k === 'f5' || (i.control && k === 'r')) { wc.reload(); e.preventDefault(); }
    else if (i.control && (k === '=' || k === '+')) { zoom(wc, wc.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (i.control && k === '-') { zoom(wc, wc.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (i.control && k === '0') { zoom(wc, 0); e.preventDefault(); }
    else if (i.control && i.shift && k === 'i') { wc.toggleDevTools(); e.preventDefault(); }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Claude');
  const menu = () => Menu.buildFromTemplate([
    { label: '打开 Claude', click: show },
    { label: '开机时自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', show);
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

// ---------- 关联文件夹 ----------
// 网页只拿得到这几个动作，而且只认主窗口里自己网站的页面（文件预览的小窗口、别的来源一律不理）。
// 文件夹只能由用户在系统的对话框里亲手选；把权限调宽也要用户在系统的对话框里再点一次确定——页面自己做不了这两件事
const folders = require('./folders').create({
  dir: path.join(app.getPath('userData'), 'folders'), home: app.getPath('home'), trash: (p) => shell.trashItem(p),
});
const TIER_TEXT = { read: '只读', ask: '每次问我', auto: '自动审查', all: '全部允许' };
const TIER_DETAIL = {
  read: 'Claude 只能看，不会改动你电脑上的任何文件。',
  ask: '每一处改动都会先给你看，你点了才写回。',
  auto: '新建和普通修改会直接写回你的电脑；删除、脚本、内容少了一大半、一次改得太多，或者两边都改过的文件，仍然先问你。原文件都会备份，30 天内可以撤销。',
  all: '所有改动（包括删除，删除的进回收站）都会直接写回你的电脑，只有两边都改过的文件先问你。原文件都会备份，30 天内可以撤销。',
};
const fromPage = (e) => !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame && sameOrigin(e.senderFrame.url);
// 确认窗关掉以后，网页里的输入框有时点得进去却打不了字：把焦点还给页面
const refocus = () => { if (win && !win.isDestroyed()) { win.webContents.focus(); } };

// ---------- 确认窗 ----------
// 原来用系统的消息框（机主说「很丑」）。换成自己画的一个小窗口，样子和页面一致；要紧的那一点没变：它是桌面端
// 自己开的另一个窗口，内容是安装包里的 confirm.html，网页碰不到它、也替用户点不了。一次只问一件事，
// 关掉、按 Esc 都算「不」。spec：{ title, path, paras: [文字], facts: [[名, 值, 说明]], note, cancel, ok }
let asking = null;
const BOX_W = 500;
function confirmBox(spec) {
  if (DEV_ORIGIN && process.env.RELAY_DESKTOP_TEST_CONFIRM) return Promise.resolve(true); // 测试用：自动化不去点确认窗
  if (asking || !win || win.isDestroyed()) return Promise.resolve(false);
  asking = new Promise((resolve) => {
    show(); // 窗口收在托盘里时先拿出来，确认窗才有地方挂
    const dark = nativeTheme.shouldUseDarkColors;
    const box = new BrowserWindow({
      parent: win, modal: true, width: BOX_W, height: 280, useContentSize: true, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, show: false, title: 'Claude', icon: iconPath, backgroundColor: dark ? '#30302e' : '#fffefb',
      webPreferences: { preload: path.join(__dirname, 'confirm-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    box.setMenu(null);
    let answer = false, dim = null;
    // 后面的页面压暗一点，看得出现在要先回答这个
    win.webContents.insertCSS('html::after { content: ""; position: fixed; inset: 0; background: rgba(20,18,14,.26); z-index: 2147483646; }').then((key) => { if (box.isDestroyed()) win?.webContents.removeInsertedCSS(key).catch(() => {}); else dim = key; }, () => {});
    box.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    box.webContents.on('will-navigate', (e) => e.preventDefault());
    box.webContents.ipc.handle('spec', () => spec);
    box.webContents.ipc.on('size', (_e, h) => { // 内容排好以后按实际高度定窗口大小，摆在主窗口正中
      if (box.isDestroyed() || box.isVisible()) return;
      const height = Math.max(150, Math.min(Math.round(Number(h) || 0), 620)), p = win.getBounds();
      box.setContentSize(BOX_W, height);
      const b = box.getBounds();
      box.setPosition(Math.round(p.x + (p.width - b.width) / 2), Math.round(p.y + (p.height - b.height) / 2));
      box.show(); box.focus();
    });
    box.webContents.ipc.on('answer', (_e, yes) => { answer = yes === true; if (!box.isDestroyed()) box.close(); });
    box.on('closed', () => {
      if (dim && win && !win.isDestroyed()) win.webContents.removeInsertedCSS(dim).catch(() => {});
      asking = null; refocus(); resolve(answer);
    });
    box.loadFile(path.join(__dirname, 'confirm.html'));
  });
  return asking;
}
function folderAction(name, fn) {
  ipcMain.handle('folders:' + name, async (e, ...args) => {
    if (!fromPage(e)) return { error: '不允许', code: 'FORBIDDEN' };
    try { return { ok: true, value: await fn(...args) }; }
    catch (err) { if (!err.userMessage) console.error('[关联文件夹]', name, err); return { error: err.userMessage || '操作没成功', code: err.code || 'FAILED' }; }
  });
}
folderAction('list', () => folders.list());
folderAction('pick', async (scope) => { // scope：这次授权给哪个对话（或项目）
  const r = DEV_ORIGIN && process.env.RELAY_DESKTOP_TEST_PICK ? { filePaths: [process.env.RELAY_DESKTOP_TEST_PICK] } // 测试用：自动化点不了系统对话框
    : await dialog.showOpenDialog(win, { title: '选择要让 Claude 读和改的文件夹', buttonLabel: '关联这个文件夹', properties: ['openDirectory'] });
  refocus();
  // 没超上限的，网页会把整个文件夹传过去；超了的（tooMany）也让用户关联，网页改成按需——先只传清单，用到哪个取哪个。所以这里不限大小
  return r.canceled || !r.filePaths[0] ? null : folders.add(r.filePaths[0], { anySize: true, scope });
});
// 大小的写法和页面一致：KB / MB / GB，一位小数
const sizeText = (n) => (!n ? '0 B' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB');
// 模型说它需要用到用户电脑上的某个位置（「桌面」「文档」这类名字，或一个完整路径）：把这个位置原原本本给用户看，
// 用户在系统的确认框里点了「信任」才关联。页面只能提出请求，点不了这个确认框
const KNOWN_PLACES = { desktop: 'desktop', documents: 'documents', downloads: 'downloads', pictures: 'pictures', music: 'music', videos: 'videos' };
folderAction('trust', async (where, tier, scope) => {
  if (!folders.TIERS.includes(tier)) tier = 'ask'; // 这个对话现在的总权限：新信任的位置直接用它，确认框里写明
  if (typeof where !== 'string' || !where || where.length > 400) return null;
  const view = folders.preview(Object.hasOwn(KNOWN_PLACES, where) ? app.getPath(KNOWN_PLACES[where]) : where, scope);
  if (view.existed) return { ...folders.get(view.id), existed: true, count: view.count, bytes: view.bytes, skippedCount: view.skippedCount };
  // 页面只能提出请求，点不了确认窗
  const trusted = await confirmBox({
    title: '允许这个对话里的 Claude 读取这个位置吗？', path: view.root,
    // 和网页的做法一致：没超上限的整个传过去、之后双向同步；超了的只传清单，用到哪个取哪个
    paras: [view.tooMany ? '这个位置里文件很多，Claude 会先只拿到文件清单，用到哪个再取哪个。' : '里面的 ' + view.count + ' 个文件（共 ' + sizeText(view.bytes) + '）会传给 Claude，之后两边的改动互相同步。'],
    facts: [['权限', TIER_TEXT[tier], TIER_DETAIL[tier]]], // 用的是这个对话现在的总权限，在这里写明
    note: '只对这个对话有效，别的对话要用得另外允许；之后可以随时取消。',
    cancel: '不允许', ok: '信任这个位置',
  });
  return trusted ? folders.add(view.root, { anySize: true, tier, scope }) : null; // 超上限的也能信任（网页对它按需取文件）
});
folderAction('remove', (id) => folders.remove(id));
const wider = (link, tier) => folders.TIERS.indexOf(tier) > folders.TIERS.indexOf(link.tier);
folderAction('setTier', async (id, tier) => {
  const link = folders.get(id);
  if (wider(link, tier) && !(await confirmBox({
    title: '把「' + link.name + '」的权限改成「' + (TIER_TEXT[tier] || tier) + '」？', paras: [TIER_DETAIL[tier] || ''], cancel: '取消', ok: '改成「' + (TIER_TEXT[tier] || tier) + '」',
  }))) return link;
  return folders.setTier(id, tier);
});
// 换这个对话的总权限：几个文件夹一起改，只问一次（原来有几个文件夹就弹几次）。用户不同意就一个都不改
folderAction('setTierAll', async (ids, tier) => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 || !folders.TIERS.includes(tier)) return [];
  const links = ids.map((id) => folders.get(id)), raise = links.filter((l) => wider(l, tier));
  if (raise.length && !(await confirmBox({
    title: '把这个对话的权限改成「' + TIER_TEXT[tier] + '」？', paras: [TIER_DETAIL[tier]],
    facts: [[raise.length > 1 ? raise.length + ' 个文件夹' : '文件夹', raise.map((l) => l.name).join('、')]], cancel: '取消', ok: '改成「' + TIER_TEXT[tier] + '」',
  }))) return links;
  return ids.map((id) => folders.setTier(id, tier));
});
folderAction('scan', (id, opts) => folders.scan(id, opts || {}));
folderAction('read', (id, rel) => folders.read(id, rel));
folderAction('stat', (id, rel) => folders.stat(id, rel));
folderAction('readChunk', (id, rel, offset, length) => folders.readChunk(id, rel, offset, length));
folderAction('hash', (id, rel) => folders.hash(id, rel));
folderAction('writeStart', (id, rel, opts) => folders.writeStart(id, rel, opts || {}));
folderAction('writeChunk', (token, bytes) => folders.writeChunk(token, bytes));
folderAction('writeEnd', (token) => folders.writeEnd(token));
folderAction('writeAbort', (token) => folders.writeAbort(token));
folderAction('write', (id, rel, bytes, opts) => folders.write(id, rel, bytes, opts || {}));
folderAction('trash', (id, rel, opts) => folders.trash(id, rel, opts || {}));
folderAction('undo', (id, batch) => folders.undo(id, batch));
folderAction('getState', (id) => folders.getState(id));
folderAction('setState', (id, text) => folders.setState(id, text));
folderAction('reveal', (id, rel) => { if (rel) shell.showItemInFolder(folders.resolve(id, rel)); else shell.openPath(folders.rootOf(id)); return true; });

// 网页通过 preload 调用的几个桌面功能
ipcMain.on('desktop:show', show);
ipcMain.on('desktop:attention', () => { if (win && !win.isFocused()) win.flashFrame(true); });
ipcMain.on('desktop:retry', () => win?.loadURL(ORIGIN + '/'));

app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(() => {
  // 网页要的权限：只给自己网站的通知、麦克风（语音输入）、剪贴板
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => {
    cb(sameOrigin(d.requestingUrl || wc.getURL()) && ['notifications', 'media', 'clipboard-sanitized-write', 'clipboard-read'].includes(perm));
  });
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent() + ' clauderelayDesktop/' + app.getVersion());
  createTray();
  createWindow();
  setTimeout(() => { try { folders.prune(); } catch {} }, 30000); // 过期的写回备份清一清
});
