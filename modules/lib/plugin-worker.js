/**
 * plugin-worker.js - 插件 Worker 线程执行环境
 * 
 * 在独立 Worker Thread 中运行插件代码，提供：
 * - 真正的崩溃隔离（插件崩溃不影响主进程/渲染进程）
 * - 强制超时（worker.terminate() 可杀死同步死循环）
 * - CPU 隔离（耗时计算不阻塞 UI）
 * 
 * 通信协议（parentPort.postMessage）：
 * 主线程 → Worker:
 *   { type: 'init', code, entryPath, pluginDir, manifest, permissions, pluginId }
 *   { type: 'hook', callId, hookName, args }
 *   { type: 'destroy' }
 *   { type: 'config-change', config }
 * 
 * Worker → 主线程:
 *   { type: 'init-success', registeredHooks: string[] }
 *   { type: 'init-error', error: string }
 *   { type: 'hook-result', callId, result, blocked }
 *   { type: 'hook-error', callId, error }
 *   { type: 'destroyed' }
 *   { type: 'log', level, args }
 *   { type: 'notify', title, body }
 *   { type: 'plugin-config-save', data }
 */

'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');

// ===== 沙箱模块白名单/黑名单 =====
const _BLOCKED_MODULES = [
  'child_process', 'cluster', 'dgram', 'dns', 'net', 'tls',
  'http', 'https', 'http2', 'worker_threads', 'wasi',
  'fs', 'fs/promises', 'node:fs', 'node:child_process', 'node:net',
  'node:http', 'node:https', 'node:worker_threads',
  'vm', 'node:vm', 'v8', 'node:v8', 'inspector', 'node:inspector',
  'process', 'node:process', 'repl', 'node:repl', 'perf_hooks',
  'node:perf_hooks', 'async_hooks', 'node:async_hooks',
  'module', 'node:module', 'trace_events', 'node:trace_events',
  'tty', 'node:tty', 'readline', 'node:readline',
  'electron', 'node:electron'
];
const _SAFE_MODULES = ['path', 'url', 'util', 'events', 'buffer', 'crypto', 'stream', 'querystring', 'assert', 'os', 'punycode', 'string_decoder', 'timers'];

// ===== 插件状态 =====
let pluginInstance = null;
let registeredHooks = [];
let pluginId = '';
let pluginPermissions = [];
let pluginConfig = {};

// ===== 日志转发 =====
function logToHost(level, args) {
  try {
    parentPort.postMessage({ type: 'log', level: level, args: args.map(function(a) {
      try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
      catch (e) { return String(a); }
    })});
  } catch (e) { /* worker 可能已断开 */ }
}

const pluginConsole = {
  log: function() { logToHost('log', Array.from(arguments)); },
  warn: function() { logToHost('warn', Array.from(arguments)); },
  error: function() { logToHost('error', Array.from(arguments)); },
  info: function() { logToHost('info', Array.from(arguments)); }
};

// ===== 权限控制的 API =====
function createWorkerPluginAPI(id) {
  var api = {
    id: id,
    registerHook: function(hookName, handler) {
      if (typeof handler !== 'function') return;
      registeredHooks.push({ name: hookName, handler: handler });
    },
    unregisterHook: function(hookName, handler) {
      registeredHooks = registeredHooks.filter(function(h) {
        if (h.name !== hookName) return true;
        if (handler && h.handler !== handler) return true;
        return false;
      });
    },
    getConfig: function() { return JSON.parse(JSON.stringify(pluginConfig)); },
    savePluginConfig: function(data) {
      parentPort.postMessage({ type: 'plugin-config-save', data: data });
    },
    loadPluginConfig: function() { return JSON.parse(JSON.stringify(pluginConfig)); },
    notify: function(title, body) {
      parentPort.postMessage({ type: 'notify', title: title, body: body });
    },
    log: function() { pluginConsole.log.apply(pluginConsole, ['[插件:' + id + ']'].concat(Array.from(arguments))); },
    warn: function() { pluginConsole.warn.apply(pluginConsole, ['[插件:' + id + ']'].concat(Array.from(arguments))); },
    error: function() { pluginConsole.error.apply(pluginConsole, ['[插件:' + id + ']'].concat(Array.from(arguments))); },
  };

  // 权限控制：网络访问
  if (pluginPermissions.indexOf('network') >= 0) {
    api.fetch = function(url, opts) {
      return fetch(url, opts);
    };
  }

  // 权限控制：存储
  if (pluginPermissions.indexOf('storage') >= 0) {
    var _storage = {};
    api.storage = {
      get: function(key) { return _storage[key]; },
      set: function(key, val) { _storage[key] = val; },
      delete: function(key) { delete _storage[key]; }
    };
  }

  return api;
}

// ===== 沙箱 require =====
function createSandboxRequire(pluginDirPath) {
  return function sandboxRequire(mod) {
    // 阻止危险模块
    if (_BLOCKED_MODULES.indexOf(mod) !== -1) {
      throw new Error('🚫 插件沙箱: 禁止访问模块 "' + mod + '"');
    }
    if (mod === 'module') throw new Error('[sandbox] require("module") 被禁止');

    // 路径逃逸检测
    if (mod.indexOf('..') >= 0) {
      var _resolved = path.resolve(pluginDirPath, mod);
      if (_resolved.indexOf(pluginDirPath) !== 0) {
        throw new Error('[sandbox] 路径逃逸被阻止: ' + mod);
      }
    }

    // 相对路径：限制在插件目录内
    if (mod.startsWith('.') || mod.startsWith('/')) {
      var resolved = path.resolve(pluginDirPath, mod);
      var normalizedPluginDir = path.resolve(pluginDirPath);
      if (!resolved.startsWith(normalizedPluginDir + path.sep) && resolved !== normalizedPluginDir) {
        throw new Error('🚫 插件沙箱: 禁止访问插件目录外的文件 (' + resolved + ')');
      }
      // 补全扩展名
      if (!fs.existsSync(resolved)) {
        if (fs.existsSync(resolved + '.js')) resolved += '.js';
        else if (fs.existsSync(resolved + '.json')) resolved += '.json';
        else if (fs.existsSync(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
      }
      if (resolved.endsWith('.json')) {
        return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      }
      // 递归加载（同目录内的子模块）
      return executePluginCode(resolved, pluginDirPath);
    }

    // 安全白名单模块
    if (_SAFE_MODULES.indexOf(mod) !== -1) {
      return require(mod);
    }

    // 其他 node_modules：允许纯 JS 库
    if (mod.indexOf('child_process') !== -1 || mod.indexOf('/fs') !== -1) {
      throw new Error('🚫 插件沙箱: 禁止访问 "' + mod + '"');
    }
    try { return require(mod); } catch (e) {
      throw new Error('插件沙箱: 无法加载模块 "' + mod + '": ' + e.message);
    }
  };
}

// ===== 执行插件代码（CommonJS 包装）=====
function executePluginCode(entryPath, pluginDirPath) {
  var code = fs.readFileSync(entryPath, 'utf-8');
  var dirName = path.dirname(entryPath);
  var sandboxRequire = createSandboxRequire(pluginDirPath);

  var moduleObj = { exports: {} };

  // 受限 Function 存根
  var RestrictedFunction = function() {
    throw new Error('[sandbox] Function 构造器被禁止');
  };

  var wrapper = 'return (function(module, exports, require, __dirname, __filename, console, ' +
    'setTimeout, clearTimeout, setInterval, clearInterval, process, global, globalThis, Buffer, Function) {\n' +
    code + '\n})';

  var factory = new Function(wrapper);
  var fn = factory();
  fn(moduleObj, moduleObj.exports, sandboxRequire, dirName, entryPath,
    pluginConsole, setTimeout, clearTimeout, setInterval, clearInterval,
    undefined, // process
    undefined, // global
    undefined, // globalThis
    { from: function() {}, alloc: function() {}, allocUnsafe: function() {} }, // Buffer 存根
    RestrictedFunction
  );

  return moduleObj.exports;
}

// ===== 初始化插件 =====
function initPlugin(data) {
  pluginId = data.pluginId;
  pluginPermissions = data.permissions || [];
  pluginConfig = data.pluginConfig || {};

  try {
    var PluginClass = executePluginCode(data.entryPath, data.pluginDir);

    if (typeof PluginClass === 'function') {
      var api = createWorkerPluginAPI(data.pluginId);
      pluginInstance = new PluginClass(api);

      // 调用 init()
      if (pluginInstance.init && typeof pluginInstance.init === 'function') {
        pluginInstance.init();
      }

      // 报告注册成功的钩子
      var hookNames = registeredHooks.map(function(h) { return h.name; });
      parentPort.postMessage({ type: 'init-success', registeredHooks: hookNames });
    } else if (PluginClass && typeof PluginClass === 'object') {
      // 支持导出对象形式（带 init/destroy 方法）
      pluginInstance = PluginClass;
      if (pluginInstance.init && typeof pluginInstance.init === 'function') {
        pluginInstance.init();
      }
      var hookNames2 = registeredHooks.map(function(h) { return h.name; });
      parentPort.postMessage({ type: 'init-success', registeredHooks: hookNames2 });
    } else {
      parentPort.postMessage({ type: 'init-error', error: '插件未导出构造函数或对象' });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'init-error', error: err.message || String(err) });
  }
}

// ===== 调用钩子 =====
function invokeHook(callId, hookName, args) {
  var handlers = registeredHooks.filter(function(h) { return h.name === hookName; });
  if (handlers.length === 0) {
    parentPort.postMessage({ type: 'hook-result', callId: callId, result: args[0], blocked: false });
    return;
  }

  // 链式调用（与主线程 callHook 逻辑一致）
  var result = args.length > 0 ? args[0] : undefined;
  var blocked = false;

  function runNext(idx) {
    if (idx >= handlers.length) {
      parentPort.postMessage({ type: 'hook-result', callId: callId, result: result, blocked: blocked });
      return;
    }
    try {
      var ret = handlers[idx].handler(result, args.length > 1 ? args[1] : undefined);
      // 支持 Promise 返回值
      if (ret && typeof ret.then === 'function') {
        ret.then(function(resolved) {
          if (resolved === null) {
            blocked = true;
            parentPort.postMessage({ type: 'hook-result', callId: callId, result: null, blocked: true });
            return;
          }
          if (resolved !== undefined) result = resolved;
          runNext(idx + 1);
        }).catch(function(err) {
          logToHost('error', ['[插件:' + pluginId + '] 钩子 ' + hookName + ' 执行失败: ' + err.message]);
          runNext(idx + 1);
        });
      } else {
        if (ret === null) {
          blocked = true;
          parentPort.postMessage({ type: 'hook-result', callId: callId, result: null, blocked: true });
          return;
        }
        if (ret !== undefined) result = ret;
        runNext(idx + 1);
      }
    } catch (err) {
      logToHost('error', ['[插件:' + pluginId + '] 钩子 ' + hookName + ' 执行失败: ' + err.message]);
      runNext(idx + 1);
    }
  }

  runNext(0);
}

// ===== 销毁插件 =====
function destroyPlugin() {
  try {
    if (pluginInstance && pluginInstance.destroy && typeof pluginInstance.destroy === 'function') {
      pluginInstance.destroy();
    }
  } catch (e) {
    logToHost('warn', ['插件销毁时出错: ' + e.message]);
  }
  pluginInstance = null;
  registeredHooks = [];
  parentPort.postMessage({ type: 'destroyed' });
}

// ===== 消息处理 =====
parentPort.on('message', function(msg) {
  switch (msg.type) {
    case 'init':
      initPlugin(msg);
      break;
    case 'hook':
      invokeHook(msg.callId, msg.hookName, msg.args || []);
      break;
    case 'destroy':
      destroyPlugin();
      break;
    case 'config-change':
      pluginConfig = msg.config || {};
      // 通知插件配置变更
      var configHandlers = registeredHooks.filter(function(h) { return h.name === 'onConfigChange'; });
      configHandlers.forEach(function(h) {
        try { h.handler(msg.config); } catch (e) { console.warn('⚠️ [plugin-worker] 操作失败:', e.message || e); }
      });
      break;
    default:
      logToHost('warn', ['未知消息类型: ' + msg.type]);
  }
});

// 通知主线程 Worker 已就绪
parentPort.postMessage({ type: 'worker-ready' });
