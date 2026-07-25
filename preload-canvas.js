// preload-canvas.js — 画布独立窗口专用轻量预加载
// 仅暴露画布窗口所需的最小 IPC 通道，缩小攻击面（对齐 preload-hud.js 范式）。
// 画布视图（public/canvas/index.html）通过 window.nodeBridge.ipc 与主进程中继通信。
const { ipcRenderer, contextBridge } = require('electron');

// 画布窗口 → 主进程
const ALLOWED_SEND = ['canvas-ready', 'canvas-op'];
// 主进程 → 画布窗口
const ALLOWED_ON = ['canvas-state'];

contextBridge.exposeInMainWorld('nodeBridge', {
  ipc: {
    send: (channel, ...args) => {
      if (ALLOWED_SEND.includes(channel)) {
        ipcRenderer.send(channel, ...args);
      } else {
        console.warn('[preload-canvas] blocked send channel:', channel);
      }
    },
    on: (channel, callback) => {
      if (ALLOWED_ON.includes(channel)) {
        const sub = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, sub);
        return () => ipcRenderer.removeListener(channel, sub);
      }
      console.warn('[preload-canvas] blocked on channel:', channel);
      return () => {};
    }
  },
  platform: process.platform
});

console.log('[preload-canvas] canvas bridge exposed');
