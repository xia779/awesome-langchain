// modules/permissions.js - 权限控制系统
// 文件夹白名单 + 双模式权限控制（全权/询问）+ 操作审计日志
var fs = require('fs');
var path = require('path');

var Core = null;

// ===== 审计日志 =====
var auditLog = [];
var MAX_AUDIT_ENTRIES = 1000;

function getAuditLogPath() {
  if (!Core) return null;
  var base = Core.pathService.global();
  return path.join(base, 'audit-log.json');
}

function loadAuditLog() {
  var logPath = getAuditLogPath();
  if (!logPath || !fs.existsSync(logPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch (e) { return []; }
}

function saveAuditLog() {
  var logPath = getAuditLogPath();
  if (!logPath) return;
  try {
    // 只保留最近的条目
    if (auditLog.length > MAX_AUDIT_ENTRIES) {
      auditLog = auditLog.slice(-MAX_AUDIT_ENTRIES);
    }
    fs.writeFileSync(logPath, JSON.stringify(auditLog, null, 2), 'utf8');
  } catch (e) {
    console.warn('审计日志保存失败:', e.message);
  }
}

function addAuditEntry(action, target, result, details) {
  var entry = {
    timestamp: Date.now(),
    time: new Date().toLocaleString('zh-CN'),
    action: action,       // 'file_write' | 'file_delete' | 'command' | 'python' | 'file_read'
    target: target,       // 文件路径或命令
    result: result,       // 'success' | 'denied' | 'error' | 'cancelled'
    details: details || '',
    user: (Core && Core.currentUser) || 'admin',
  };
  auditLog.push(entry);
  // 异步保存，不阻塞操作
  setTimeout(saveAuditLog, 100);
  return entry;
}

// ===== 文件夹白名单 =====

function getDefaultAllowedDirs() {
  var dirs = [process.cwd()];
  if (Core) {
    if (Core._globalDataRoot) dirs.push(Core._globalDataRoot);
    if (Core.DATA_ROOT) dirs.push(Core.DATA_ROOT);
    if (Core.USERS_ROOT) dirs.push(Core.USERS_ROOT);
  }
  // 兼容默认安装路径
  dirs.push(Core.pathService.global());
  dirs.push('E:\\my-ai-desktop');
  // 用户桌面
  try {
    var os = require('os');
    dirs.push(path.join(os.homedir(), 'Desktop'));
    dirs.push(path.join(os.homedir(), 'Documents'));
    dirs.push(path.join(os.homedir(), 'Downloads'));
  } catch (e) {}
  return dirs;
}

function getConfiguredAllowedDirs() {
  if (!Core || !Core.config) return [];
  var dirs = Core.config.allowedDirs;
  if (Array.isArray(dirs)) return dirs;
  return [];
}

function getAllowedDirs() {
  var defaults = getDefaultAllowedDirs();
  var configured = getConfiguredAllowedDirs();
  // 合并去重
  var all = {};
  defaults.forEach(function(d) { if (d) all[path.resolve(d)] = true; });
  configured.forEach(function(d) { if (d) all[path.resolve(d)] = true; });
  return Object.keys(all);
}

function isPathAllowed(filePath) {
  if (!filePath) return false;
  var resolved = path.resolve(filePath);
  var allowed = getAllowedDirs();
  for (var i = 0; i < allowed.length; i++) {
    if (resolved.startsWith(allowed[i])) return true;
  }
  return false;
}

// 添加/移除白名单目录
function addAllowedDir(dirPath) {
  if (!Core || !Core.config) return false;
  var resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) return false;
  var dirs = getConfiguredAllowedDirs();
  if (dirs.indexOf(resolved) >= 0) return true; // 已存在
  dirs.push(resolved);
  Core.config.allowedDirs = dirs;
  if (Core.saveConfig) Core.saveConfig({ allowedDirs: dirs });
  console.log('✅ 已添加允许目录:', resolved);
  return true;
}

function removeAllowedDir(dirPath) {
  if (!Core || !Core.config) return false;
  var resolved = path.resolve(dirPath);
  var dirs = getConfiguredAllowedDirs();
  var idx = dirs.indexOf(resolved);
  if (idx < 0) return false;
  dirs.splice(idx, 1);
  Core.config.allowedDirs = dirs;
  if (Core.saveConfig) Core.saveConfig({ allowedDirs: dirs });
  console.log('✅ 已移除允许目录:', resolved);
  return true;
}

// ===== 权限模式 =====

function getPermissionMode() {
  if (!Core || !Core.config) return 'full';
  return Core.config.permissionMode || 'full'; // 'full' | 'ask'
}

function setPermissionMode(mode) {
  if (mode !== 'full' && mode !== 'ask') return false;
  if (!Core || !Core.config) return false;
  Core.config.permissionMode = mode;
  if (Core.saveConfig) Core.saveConfig({ permissionMode: mode });
  console.log('✅ 权限模式已切换:', mode === 'full' ? '全权模式' : '询问模式');
  return true;
}

// ===== 权限检查（核心拦截点）=====

// 同步确认弹窗（Electron 环境）
function askPermission(action, target, details) {
  if (getPermissionMode() === 'full') return true;

  // 'ask' 模式：弹出确认对话框
  var message = '权限确认\n\n';
  message += '操作: ' + action + '\n';
  message += '目标: ' + target + '\n';
  if (details) message += '详情: ' + details + '\n';
  message += '\n是否允许此操作？';

  // 在 Electron renderer 中使用 confirm
  if (typeof confirm === 'function') {
    var allowed = confirm(message);
    addAuditEntry(action, target, allowed ? 'success' : 'cancelled', details || '用户' + (allowed ? '允许' : '拒绝'));
    return allowed;
  }

  // 非浏览器环境（如 API 调用），默认允许
  return true;
}

// 异步版本（用于 async handler）
async function askPermissionAsync(action, target, details) {
  return askPermission(action, target, details);
}

// ===== 工具操作拦截器 =====

// 拦截文件写入
function checkFileWrite(filePath, content) {
  if (!isPathAllowed(filePath)) {
    addAuditEntry('file_write', filePath, 'denied', '路径不在白名单中');
    return { allowed: false, reason: '路径不在允许范围内: ' + filePath };
  }
  if (getPermissionMode() === 'ask') {
    var size = (content || '').length;
    var allowed = askPermission('写入文件', filePath, '内容大小: ' + size + ' 字符');
    if (!allowed) {
      return { allowed: false, reason: '用户拒绝写入操作' };
    }
  }
  addAuditEntry('file_write', filePath, 'success', '内容大小: ' + (content || '').length + ' 字符');
  return { allowed: true };
}

// 拦截命令执行
function checkCommandExec(command) {
  if (getPermissionMode() === 'ask') {
    var allowed = askPermission('执行命令', command, '');
    if (!allowed) {
      addAuditEntry('command', command, 'cancelled', '用户拒绝');
      return { allowed: false, reason: '用户拒绝执行命令' };
    }
  }
  addAuditEntry('command', command, 'success', '');
  return { allowed: true };
}

// 拦截 Python 执行
function checkPythonExec(code) {
  if (getPermissionMode() === 'ask') {
    var preview = (code || '').substring(0, 200);
    var allowed = askPermission('执行 Python', '代码片段', preview + (code.length > 200 ? '...' : ''));
    if (!allowed) {
      addAuditEntry('python', '代码执行', 'cancelled', '用户拒绝');
      return { allowed: false, reason: '用户拒绝执行 Python 代码' };
    }
  }
  addAuditEntry('python', '代码执行', 'success', '代码长度: ' + (code || '').length + ' 字符');
  return { allowed: true };
}

// ===== 导出 =====

module.exports = {
  init: function(_Core) {
    Core = _Core;

    // 确保默认配置
    if (Core.config && !Core.config.permissionMode) {
      Core.config.permissionMode = 'full';
    }
    if (Core.config && !Array.isArray(Core.config.allowedDirs)) {
      Core.config.allowedDirs = [];
    }

    // 加载审计日志
    auditLog = loadAuditLog();

    // 暴露 API
    Core.permissions = {
      // 路径检查
      isPathAllowed: isPathAllowed,
      getAllowedDirs: getAllowedDirs,
      addAllowedDir: addAllowedDir,
      removeAllowedDir: removeAllowedDir,

      // 权限模式
      getMode: getPermissionMode,
      setMode: setPermissionMode,

      // 操作拦截
      checkFileWrite: checkFileWrite,
      checkCommandExec: checkCommandExec,
      checkPythonExec: checkPythonExec,
      askPermission: askPermission,
      askPermissionAsync: askPermissionAsync,

      // 审计日志
      getAuditLog: function() { return auditLog.slice(-50); },
      clearAuditLog: function() { auditLog = []; saveAuditLog(); },
      getAuditStats: function() {
        var stats = { total: auditLog.length, denied: 0, success: 0, cancelled: 0 };
        auditLog.forEach(function(e) {
          if (e.result === 'denied') stats.denied++;
          else if (e.result === 'success') stats.success++;
          else if (e.result === 'cancelled') stats.cancelled++;
        });
        return stats;
      },
    };

    console.log('✅ 权限控制模块已加载 | 模式: ' + (getPermissionMode() === 'full' ? '全权' : '询问') + ' | 白名单: ' + getAllowedDirs().length + ' 个目录 | 审计日志: ' + auditLog.length + ' 条');
  },
};
