/**
 * plugin-host.js - 主进程插件 Worker 管理器
 * 
 * 在 Electron 主进程中管理插件 Worker 线程池：
 * - 每个插件一个独立 Worker Thread（真正的进程级隔离）
 * - 强制超时：worker.terminate() 可杀死同步死循环
 * - 崩溃检测：worker 'exit' 事件 → 通知渲染进程
 * - IPC 桥接：渲染进程通过 preload 桥调用
 * 
 * IPC 通道：
 *   plugin-worker:load    (invoke) → { success, registeredHooks, error }
 *   plugin-worker:hook    (invoke) → { result, blocked, error }
 *   plugin-worker:destroy (invoke) → { success }
 *   plugin-worker:config  (send)   → 转发配置变更
 *   plugin-worker:crashed (on)     → 渲染进程监听崩溃通知
 *   plugin-worker:log     (on)     → 渲染进程监听插件日志
 *   plugin-worker:notify  (on)     → 渲染进程监听插件通知
 */

'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const { ipcMain } = require('electron');

// Worker 脚本路径
const WORKER_SCRIPT = path.join(__dirname, 'plugin-worker.js');

// 插件 Worker 池：pluginId → { worker, ready, hooks, pendingCalls }
const workerPool = {};

// RPC 调用 ID 计数器
let callIdCounter = 0;

// 超时配置
const INIT_TIMEOUT_MS = 8000;   // 插件初始化超时（含 Worker 启动）
const HOOK_TIMEOUT_MS = 10000;  // 单次 Hook 调用超时
const DESTROY_TIMEOUT_MS = 3000; // 销毁超时

// ===== 工具函数 =====
function nextCallId() {
  return 'call_' + (++callIdCounter) + '_' + Date.now();
}

function safeSerialize(obj) {
  try {
    // 尝试结构化克隆兼容的序列化
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    return null;
  }
}

// ===== Worker 生命周期管理 =====

/**
 * 加载插件到独立 Worker 线程
 * @returns {Promise<{success, registeredHooks?, error?}>}
 */
function loadPluginWorker(pluginId, entryPath, pluginDir, manifest, permissions, pluginConfig) {
  return new Promise(function(resolve) {
    // 如果已有 Worker，先销毁
    if (workerPool[pluginId]) {
      try { workerPool[pluginId].worker.terminate(); } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
      delete workerPool[pluginId];
    }

    let settled = false;
    let worker;

    try {
      worker = new Worker(WORKER_SCRIPT);
    } catch (err) {
      resolve({ success: false, error: 'Worker 创建失败: ' + err.message });
      return;
    }

    const poolEntry = {
      worker: worker,
      ready: false,
      hooks: [],
      pendingCalls: {},  // callId → { resolve, timer }
      pluginId: pluginId
    };
    workerPool[pluginId] = poolEntry;

    // 初始化超时
    const initTimer = setTimeout(function() {
      if (!settled) {
        settled = true;
        console.error('⏰ 插件 ' + pluginId + ' Worker 初始化超时（>' + INIT_TIMEOUT_MS + 'ms），强制终止');
        worker.terminate();
        delete workerPool[pluginId];
        resolve({ success: false, error: '初始化超时（>' + INIT_TIMEOUT_MS + 'ms），可能包含死循环' });
      }
    }, INIT_TIMEOUT_MS);

    // Worker 消息处理
    worker.on('message', function(msg) {
      switch (msg.type) {
        case 'worker-ready':
          poolEntry.ready = true;
          // Worker 就绪后发送初始化数据
          worker.postMessage({
            type: 'init',
            pluginId: pluginId,
            entryPath: entryPath,
            pluginDir: pluginDir,
            manifest: manifest,
            permissions: permissions,
            pluginConfig: pluginConfig
          });
          break;

        case 'init-success':
          if (!settled) {
            settled = true;
            clearTimeout(initTimer);
            poolEntry.hooks = msg.registeredHooks || [];
            console.log('✅ 插件 ' + pluginId + ' 已在 Worker 线程中加载，注册钩子: [' + poolEntry.hooks.join(', ') + ']');
            resolve({ success: true, registeredHooks: poolEntry.hooks });
          }
          break;

        case 'init-error':
          if (!settled) {
            settled = true;
            clearTimeout(initTimer);
            console.error('❌ 插件 ' + pluginId + ' Worker 初始化失败:', msg.error);
            worker.terminate();
            delete workerPool[pluginId];
            resolve({ success: false, error: msg.error });
          }
          break;

        case 'hook-result': {
          const pending = poolEntry.pendingCalls[msg.callId];
          if (pending) {
            clearTimeout(pending.timer);
            delete poolEntry.pendingCalls[msg.callId];
            pending.resolve({ result: msg.result, blocked: msg.blocked });
          }
          break;
        }

        case 'hook-error': {
          const pending2 = poolEntry.pendingCalls[msg.callId];
          if (pending2) {
            clearTimeout(pending2.timer);
            delete poolEntry.pendingCalls[msg.callId];
            pending2.resolve({ result: undefined, blocked: false, error: msg.error });
          }
          break;
        }

        case 'destroyed':
          // 销毁确认
          break;

        case 'log': {
          // 转发插件日志到渲染进程
          const prefix = '[插件:' + pluginId + ']';
          const args = (msg.args || []).join(' ');
          if (msg.level === 'error') console.error(prefix, args);
          else if (msg.level === 'warn') console.warn(prefix, args);
          else console.log(prefix, args);
          // 通知渲染进程（可选）
          try {
            const { BrowserWindow } = require('electron');
            BrowserWindow.getAllWindows().forEach(function(win) {
              win.webContents.send('plugin-worker:log', { pluginId: pluginId, level: msg.level, args: msg.args });
            });
          } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
          break;
        }

        case 'notify':
          try {
            const { BrowserWindow } = require('electron');
            BrowserWindow.getAllWindows().forEach(function(win) {
              win.webContents.send('plugin-worker:notify', { pluginId: pluginId, title: msg.title, body: msg.body });
            });
          } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
          break;

        case 'plugin-config-save':
          try {
            const { BrowserWindow } = require('electron');
            BrowserWindow.getAllWindows().forEach(function(win) {
              win.webContents.send('plugin-worker:config-save', { pluginId: pluginId, data: msg.data });
            });
          } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
          break;
      }
    });

    // Worker 错误
    worker.on('error', function(err) {
      console.error('❌ 插件 ' + pluginId + ' Worker 错误:', err.message);
      if (!settled) {
        settled = true;
        clearTimeout(initTimer);
        delete workerPool[pluginId];
        resolve({ success: false, error: 'Worker 错误: ' + err.message });
      }
    });

    // Worker 退出（崩溃检测）
    worker.on('exit', function(code) {
      console.warn('⚠️ 插件 ' + pluginId + ' Worker 退出 (code=' + code + ')');
      // 清理所有待处理的调用
      Object.keys(poolEntry.pendingCalls).forEach(function(cid) {
        clearTimeout(poolEntry.pendingCalls[cid].timer);
        poolEntry.pendingCalls[cid].resolve({ result: undefined, blocked: false, error: 'Worker 已退出' });
      });
      delete workerPool[pluginId];

      // 通知渲染进程插件崩溃
      if (code !== 0) {
        try {
          const { BrowserWindow } = require('electron');
          BrowserWindow.getAllWindows().forEach(function(win) {
            win.webContents.send('plugin-worker:crashed', { pluginId: pluginId, code: code });
          });
        } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
      }
    });
  });
}

/**
 * 调用插件 Worker 中的钩子
 * @returns {Promise<{result, blocked, error?}>}
 */
function callPluginHook(pluginId, hookName, args) {
  return new Promise(function(resolve) {
    const entry = workerPool[pluginId];
    if (!entry || !entry.ready) {
      resolve({ result: args && args.length > 0 ? args[0] : undefined, blocked: false, error: 'Worker 未就绪' });
      return;
    }

    const callId = nextCallId();
    const timer = setTimeout(function() {
      delete entry.pendingCalls[callId];
      console.error('⏰ 插件 ' + pluginId + ' 钩子 ' + hookName + ' 调用超时（>' + HOOK_TIMEOUT_MS + 'ms）');
      // 超时时终止 Worker（保护主进程）
      try { entry.worker.terminate(); } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
      delete workerPool[pluginId];
      resolve({ result: args && args.length > 0 ? args[0] : undefined, blocked: false, error: '钩子调用超时' });
    }, HOOK_TIMEOUT_MS);

    entry.pendingCalls[callId] = { resolve: resolve, timer: timer };

    // 序列化参数（确保可跨线程传输）
    let safeArgs;
    try {
      safeArgs = safeSerialize(args) || [];
    } catch (e) {
      safeArgs = [];
    }

    entry.worker.postMessage({ type: 'hook', callId: callId, hookName: hookName, args: safeArgs });
  });
}

/**
 * 销毁插件 Worker
 */
function destroyPluginWorker(pluginId) {
  return new Promise(function(resolve) {
    const entry = workerPool[pluginId];
    if (!entry) {
      resolve({ success: true });
      return;
    }

    const timer = setTimeout(function() {
      // 超时强制终止
      try { entry.worker.terminate(); } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
      delete workerPool[pluginId];
      resolve({ success: true });
    }, DESTROY_TIMEOUT_MS);

    // 监听销毁完成
    entry.worker.once('exit', function() {
      clearTimeout(timer);
      delete workerPool[pluginId];
      resolve({ success: true });
    });

    entry.worker.postMessage({ type: 'destroy' });
  });
}

/**
 * 向插件 Worker 发送配置变更
 */
function sendConfigChange(pluginId, config) {
  const entry = workerPool[pluginId];
  if (entry && entry.ready) {
    try {
      entry.worker.postMessage({ type: 'config-change', config: safeSerialize(config) || {} });
    } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
  }
}

/**
 * 获取插件 Worker 状态
 */
function getWorkerStatus(pluginId) {
  const entry = workerPool[pluginId];
  if (!entry) return { running: false };
  return { running: true, ready: entry.ready, hooks: entry.hooks };
}

/**
 * 获取所有活跃 Worker 信息
 */
function listActiveWorkers() {
  return Object.keys(workerPool).map(function(id) {
    return { pluginId: id, ready: workerPool[id].ready, hooks: workerPool[id].hooks };
  });
}

/**
 * 终止所有 Worker（应用退出时调用）
 */
function terminateAllWorkers() {
  Object.keys(workerPool).forEach(function(id) {
    try { workerPool[id].worker.terminate(); } catch (e) { console.warn('⚠️ [plugin-host] 操作失败:', e.message || e); }
  });
  Object.keys(workerPool).forEach(function(id) { delete workerPool[id]; });
}

// ===== IPC 注册 =====
function registerIPC() {
  // 加载插件到 Worker
  ipcMain.handle('plugin-worker:load', async function(event, data) {
    const { pluginId, entryPath, pluginDir, manifest, permissions, pluginConfig } = data;
    return await loadPluginWorker(pluginId, entryPath, pluginDir, manifest, permissions, pluginConfig);
  });

  // 调用钩子
  ipcMain.handle('plugin-worker:hook', async function(event, data) {
    const { pluginId, hookName, args } = data;
    return await callPluginHook(pluginId, hookName, args);
  });

  // 销毁插件 Worker
  ipcMain.handle('plugin-worker:destroy', async function(event, data) {
    return await destroyPluginWorker(data.pluginId);
  });

  // 配置变更
  ipcMain.on('plugin-worker:config', function(event, data) {
    sendConfigChange(data.pluginId, data.config);
  });

  // 获取状态
  ipcMain.handle('plugin-worker:status', async function(event, data) {
    if (data.pluginId) return getWorkerStatus(data.pluginId);
    return listActiveWorkers();
  });
}

// ===== 导出 =====
module.exports = {
  registerIPC,
  loadPluginWorker,
  callPluginHook,
  destroyPluginWorker,
  sendConfigChange,
  getWorkerStatus,
  listActiveWorkers,
  terminateAllWorkers
};
