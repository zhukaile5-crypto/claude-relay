// 给网页的桌面功能接口：网页用 window.relayDesktop 判断自己是不是在桌面端里
const { contextBridge, ipcRenderer } = require('electron');

// 版本号由 main.js 通过启动参数传进来（取自 package.json），改版本时不用再改这里
const versionArg = process.argv.find((a) => a.startsWith('--relay-version='));

// 关联文件夹：每个动作回 { ok, value } 或 { error, code }；这里换成「成功给结果、失败抛错」
const folderCall = (name) => async (...args) => {
  const r = await ipcRenderer.invoke('folders:' + name, ...args);
  if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || '操作没成功'), { code: (r && r.code) || 'FAILED' });
  return r.value;
};

contextBridge.exposeInMainWorld('relayDesktop', {
  version: versionArg ? versionArg.slice('--relay-version='.length) : '',
  show: () => ipcRenderer.send('desktop:show'),           // 点通知时把窗口拉出来
  attention: () => ipcRenderer.send('desktop:attention'), // 任务栏图标闪烁
  retry: () => ipcRenderer.send('desktop:retry'),         // 离线页的「重试」
  // 让模型读、改用户电脑上某个文件夹里的文件（规则和权限档位见 folders.js）。网页里用 window.relayDesktop.folders
  folders: Object.fromEntries(['list', 'pick', 'trust', 'remove', 'setTier', 'setTierAll', 'scan', 'read', 'stat', 'readChunk', 'hash', 'write', 'writeStart', 'writeChunk', 'writeEnd', 'writeAbort', 'trash', 'undo', 'getState', 'setState', 'reveal']
    .map((name) => [name, folderCall(name)])),
});
