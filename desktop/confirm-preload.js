// 确认窗（confirm.html）只拿得到这三样：要显示的内容、报告自己的高度、回答是或否
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('confirmBox', {
  spec: () => ipcRenderer.invoke('spec'),
  size: (height) => ipcRenderer.send('size', height),
  answer: (yes) => ipcRenderer.send('answer', yes === true),
});
