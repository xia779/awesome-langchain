// preload-hud.js — HUD 悬浮窗专用轻量预加载
// 仅暴露 HUD 所需的最小 IPC 通道，避免在主进程中加载原生模块（better-sqlite3 等），
// 同时缩小 HUD 窗口的攻击面。HUD 视图（public/hud/index.html）通过 window.nodeBridge.ipc 通信。
const { ipcRenderer, contextBridge } = require('electron');

// HUD 视图 → 主进程
const ALLOWED_SEND = ['hud-ready', 'hud-input', 'hud-voice'];
// 主进程 → HUD 视图
const ALLOWED_ON = ['hud-state'];

contextBridge.exposeInMainWorld('nodeBridge', {
  ipc: {
    send: (channel, ...args) => {
      if (ALLOWED_SEND.includes(channel)) {
        ipcRenderer.send(channel, ...args);
      } else {
        console.warn('[preload-hud] blocked send channel:', channel);
      }
    },
    on: (channel, callback) => {
      if (ALLOWED_ON.includes(channel)) {
        const sub = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, sub);
        return () => ipcRenderer.removeListener(channel, sub);
      }
      console.warn('[preload-hud] blocked on channel:', channel);
      return () => {};
    }
  },
  platform: process.platform
});

console.log('[preload-hud] HUD bridge exposed');
