// preload.js - Electron 预加载脚本（安全桥接层）
// #8: 渐进式安全迁移基础设施
// 当前阶段: contextIsolation=false，preload 与渲染进程共享上下文
// 目标阶段: contextIsolation=true，通过 contextBridge 暴露安全 API
'use strict';

const { ipcRenderer, contextBridge } = require('electron');

// ===== 安全 API 表面（仅暴露必要能力，不暴露 require/process/fs）=====
const electronAPI = {
  // IPC 通信（渲染进程 -> 主进程）
  ipc: {
    send: (channel, ...args) => {
      const allowed = [
        'show-notification', 'get-user-data-path', 'get-server-port',
        'get-auth-token', 'app:get-path-sync', 'list-plugin-dirs',
        'copy-plugin-dir', 'delete-plugin-dir', 'open-external',
        'open-devtools', 'app-minimize', 'app-maximize', 'app-close',
        'select-directory', 'select-file', 'get-app-version'
      ];
      if (allowed.includes(channel)) {
        ipcRenderer.send(channel, ...args);
      } else {
        console.warn('[preload] blocked IPC channel:', channel);
      }
    },
    sendSync: (channel, ...args) => {
      const allowedSync = [
        'app:get-path-sync', 'get-user-data-path', 'get-server-port', 'get-auth-token'
      ];
      if (allowedSync.includes(channel)) {
        return ipcRenderer.sendSync(channel, ...args);
      }
      console.warn('[preload] blocked sync IPC channel:', channel);
      return null;
    },
    on: (channel, callback) => {
      const allowedOn = [
        'server:port', 'agent:response', 'agent:step', 'agent:error',
        'agent:done', 'agent:typing', 'config:changed', 'session:updated',
        'notification', 'tray:action'
      ];
      if (allowedOn.includes(channel)) {
        const sub = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, sub);
        return () => ipcRenderer.removeListener(channel, sub);
      }
      console.warn('[preload] blocked IPC listener:', channel);
      return () => {};
    },
    invoke: (channel, ...args) => {
      const allowedInvoke = ['select-directory', 'select-file', 'get-app-info'];
      if (allowedInvoke.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      console.warn('[preload] blocked IPC invoke:', channel);
      return Promise.reject(new Error('Channel not allowed: ' + channel));
    }
  },

  // 平台信息（只读）
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('app-minimize'),
    maximize: () => ipcRenderer.send('app-maximize'),
    close: () => ipcRenderer.send('app-close')
  }
};

// ===== 暴露方式（兼容当前和未来模式）=====
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} else {
  window.electronAPI = electronAPI;
}
