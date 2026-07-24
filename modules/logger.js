// modules/logger.js - 分级日志系统（最小改动版）
// 原则：不替换 console.log，新增 logger 接口用于持久化日志

const fs = require('fs');
const path = require('path');

let Core = null;
let logDir = '';
let logFile = '';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = 1; // 默认 info

// ===== 初始化 =====
function init(dataRoot) {
  logDir = path.join(dataRoot, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  
  const date = new Date().toISOString().slice(0, 10);
  logFile = path.join(logDir, `ai-agent-${date}.log`);
  
  // 清理超过 7 天的旧日志
  cleanupOldLogs();
  
  console.log('[logger] 日志系统已初始化:', logFile);
}

// ===== 写入日志（线程安全：同步写入）=====
function writeLog(level, message, meta) {
  if (LOG_LEVELS[level] < currentLevel) return;
  
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ' | ' + JSON.stringify(meta) : '';
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
  
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (err) {
    // 如果连日志都写不了，静默失败，避免死循环
  }
  
  // 同时输出到控制台（保持开发体验）
  if (level === 'error') console.error('[LOG]', message, meta || '');
  else if (level === 'warn') console.warn('[LOG]', message, meta || '');
  else console.log('[LOG]', message, meta || '');
}

// ===== 清理旧日志 =====
function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(logDir);
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 天
    
    for (const file of files) {
      if (!file.startsWith('ai-agent-') || !file.endsWith('.log')) continue;
      const filePath = path.join(logDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtime.getTime() > maxAge) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (e) {
    console.warn('[Logger] Log rotation failed:', e.message);
  }
}

// ===== 日志 API =====
function debug(msg, meta) { writeLog('debug', msg, meta); }
function info(msg, meta) { writeLog('info', msg, meta); }
function warn(msg, meta) { writeLog('warn', msg, meta); }
function error(msg, meta) { writeLog('error', msg, meta); }

// 设置日志级别
function setLevel(level) {
  if (LOG_LEVELS[level] !== undefined) currentLevel = LOG_LEVELS[level];
}

module.exports = {
  init(_Core) {
    Core = _Core;
    // 自动初始化，使用 DATA_ROOT
    init(Core.pathService.perUser());
    
    Core.logger = {
      debug, info, warn, error,
      setLevel,
    };
    
    console.log('✅ 日志模块已加载');
  }
};
