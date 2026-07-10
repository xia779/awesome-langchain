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
function setupGlobalErrorHandling() {
  // 捕获未处理的 Promise 错误
  window.addEventListener('unhandledrejection', function(event) {
    const error = event.reason;
    const msg = error && error.message ? error.message : String(error);
    logError('未处理的Promise拒绝', msg, { stack: error && error.stack });
    showErrorToast('异步操作失败: ' + msg.substring(0, 100));
  });
  
  // 捕获全局错误
  window.addEventListener('error', function(event) {
    const { message, filename, lineno, colno, error } = event;
    logError('全局错误', message, { filename, lineno, colno, stack: error && error.stack });
    // 不阻止默认处理（让控制台也显示）
  });
  
  // 拦截 console.error
  const originalError = console.error;
  console.error = function(...args) {
    originalError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (msg.length < 500) { // 避免大对象拖垮日志
      logError('console.error', msg.substring(0, 200));
    }
  };
  
  // 拦截 console.warn
  const originalWarn = console.warn;
  console.warn = function(...args) {
    originalWarn.apply(console, args);
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
    if (!_isLogging) saveErrorLogs();
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
    fs.writeFileSync(logPath, JSON.stringify(errorLogs.slice(-500), null, 2), 'utf8');
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
  } catch (e) {}
}

// ===== 统一 Toast 提示 =====
function showToast(message, type = 'info', duration = 3000) {
  // 移除已存在的 toast
  const existing = document.querySelectorAll('.app-toast');
  existing.forEach(el => el.remove());
  
  const toast = document.createElement('div');
  toast.className = 'app-toast toast-' + type;
  
  const icons = {
    error: '❌',
    success: '✅',
    warning: '⚠️',
    info: 'ℹ️'
  };
  
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${message}</span>`;
  
  // 样式
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(-20px);
    background: ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : type === 'warning' ? '#f59e0b' : '#3b82f6'};
    color: #fff;
    padding: 12px 24px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 10px;
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    max-width: 90%;
    word-break: break-word;
  `;
  
  document.body.appendChild(toast);
  
  // 动画进入
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  
  // 自动消失
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function showErrorToast(message) { showToast(message, 'error', 5000); }
function showSuccessToast(message) { showToast(message, 'success', 3000); }
function showWarningToast(message) { showToast(message, 'warning', 4000); }

module.exports = { name: 'error-handler', dependencies: [], init };
