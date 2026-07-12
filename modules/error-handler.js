// modules/error-handler.js - 全局错误处理与日志系统
let Core = null;

// 错误日志存储（内存+文件）
let errorLogs = [];
const MAX_LOGS = 1000;

function init(_Core) {
  Core = _Core;
  
  // 挂载到 Core
  Core.errorHandler = {
    logError,
    logInfo,
    logWarn,
    getLogs,
    clearLogs,
    exportLogs,
    showErrorToast,
    showSuccessToast,
    showWarningToast,
  };
  
  // 全局错误捕获
  setupGlobalErrorHandling();
  
  // 加载历史错误日志
  loadErrorLogs();
  
  console.log('✅ 错误处理模块已加载');
}

// ===== 全局错误捕获 =====
// 🔧 防级联崩溃：限制每分钟最多处理 N 个未处理异常，超出后静默忽略
var _unhandledCount = 0;
var _unhandledResetTimer = null;
var MAX_UNHANDLED_PER_MINUTE = 10;

function _canHandleError() {
  _unhandledCount++;
  if (!_unhandledResetTimer) {
    _unhandledResetTimer = setTimeout(function() {
      _unhandledCount = 0;
      _unhandledResetTimer = null;
    }, 60000);
  }
  return _unhandledCount <= MAX_UNHANDLED_PER_MINUTE;
}

function setupGlobalErrorHandling() {
  // 捕获未处理的 Promise 错误
  window.addEventListener('unhandledrejection', function(event) {
    if (!_canHandleError()) return; // 防止级联循环
    const error = event.reason;
    const msg = error && error.message ? error.message : String(error);
    logError('未处理的Promise拒绝', msg, { stack: error && error.stack });
    showErrorToast('异步操作失败: ' + msg.substring(0, 100));
  });

  // 捕获全局错误
  window.addEventListener('error', function(event) {
    if (!_canHandleError()) return;
    const { message, filename, lineno, colno, error } = event;
    logError('全局错误', message, { filename, lineno, colno, stack: error && error.stack });
    // 不阻止默认处理（让控制台也显示）
  });

  // 拦截 console.error
  const originalError = console.error;
  console.error = function(...args) {
    originalError.apply(console, args);
    if (_isLogging) return; // 防止递归
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (msg.length < 500) { // 避免大对象拖垮日志
      logError('console.error', msg.substring(0, 200));
    }
  };

  // 拦截 console.warn
  const originalWarn = console.warn;
  console.warn = function(...args) {
    originalWarn.apply(console, args);
    if (_isLogging) return; // 防止递归
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (msg.length < 500) {
      logWarn('console.warn', msg.substring(0, 200));
    }
  };
}

// ===== 日志记录 =====
// 🔒 安全修复：防止 console.error 拦截器递归调用
let _isLogging = false;
// 🔧 性能优化：日志写入防抖，减少磁盘 IO
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000; // 2秒内批量写入一次

function logError(type, message, details = {}) {
  addLog({ level: 'error', type, message, details, timestamp: Date.now() });
}

function logInfo(type, message, details = {}) {
  addLog({ level: 'info', type, message, details, timestamp: Date.now() });
}

function logWarn(type, message, details = {}) {
  addLog({ level: 'warn', type, message, details, timestamp: Date.now() });
}

function addLog(entry) {
  // 🔒 防止递归：如果已经在处理日志，直接跳过
  if (_isLogging) return;
  _isLogging = true;
  try {
    errorLogs.push(entry);
    if (errorLogs.length > MAX_LOGS) {
      errorLogs = errorLogs.slice(-MAX_LOGS);
    }
  } finally {
    _isLogging = false;
  }
  
  // 🔧 性能优化：防抖写入磁盘，2秒内的日志批量写入一次
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    // 🔒 _isLogging 覆盖磁盘写入阶段，防止 logger.js console.error → addLog 反馈循环
    if (_isLogging) return;
    _isLogging = true;
    try { saveErrorLogs(); } finally { _isLogging = false; }
  }, SAVE_DEBOUNCE_MS);
}

function getLogs(options = {}) {
  const { level, limit = 100, since } = options;
  let logs = [...errorLogs];
  
  if (level) logs = logs.filter(l => l.level === level);
  if (since) logs = logs.filter(l => l.timestamp >= since);
  
  return logs.slice(-limit).sort((a, b) => b.timestamp - a.timestamp);
}

function clearLogs() {
  errorLogs = [];
  saveErrorLogs();
  console.log('🧹 错误日志已清空');
}

function exportLogs() {
  const logs = getLogs({ limit: MAX_LOGS });
  return JSON.stringify(logs, null, 2);
}

// ===== 文件持久化 =====
function saveErrorLogs() {
  try {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(Core.DATA_ROOT, 'error-logs.json');
    fs.promises.writeFile(logPath, JSON.stringify(errorLogs.slice(-500), null, 2), 'utf8').catch(function() {});
  } catch (e) {}
}

function loadErrorLogs() {
  try {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(Core.DATA_ROOT, 'error-logs.json');
    if (fs.existsSync(logPath)) {
      const data = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      if (Array.isArray(data)) errorLogs = data;
    }
  } catch (e) {
    console.warn('[ErrorHandler] Failed to load error logs:', e.message);
  }
}

// ===== Toast 提示：委托给 Core.showToast（统一实现）=====
// 🔧 防级联：如果 showToast 本身抛出异常，不能让它再触发错误处理循环
var _isToasting = false;
function showErrorToast(message) {
  if (_isToasting) return;
  _isToasting = true;
  try {
    if (Core && Core.showToast) Core.showToast(message, 'error', 5000);
  } catch (e) {
    // 静默处理 — 不能再抛异常，否则会触发 unhandledrejection → 无限循环
  } finally {
    _isToasting = false;
  }
}
function showSuccessToast(message) {
  if (_isToasting) return;
  _isToasting = true;
  try {
    if (Core && Core.showToast) Core.showToast(message, 'success', 3000);
  } catch (e) { /* 静默 */ } finally { _isToasting = false; }
}
function showWarningToast(message) {
  if (_isToasting) return;
  _isToasting = true;
  try {
    if (Core && Core.showToast) Core.showToast(message, 'warning', 4000);
  } catch (e) { /* 静默 */ } finally { _isToasting = false; }
}

module.exports = { name: 'error-handler', dependencies: [], init };
