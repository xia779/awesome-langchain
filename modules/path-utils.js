// modules/path-utils.js — 统一的路径和文件 I/O 工具（消除 core-v10.js 与 main.js 重复）

const fs = require('fs');
const path = require('path');

// ===== 动态获取数据根目录 =====
var _app = null;
try {
  var electron = require('electron');
  _app = electron.app || (electron.remote && electron.remote.app);
} catch (e) {
  // 非 Electron 环境（如 web-server.js），忽略
}

function getDataRoot() {
  // 优先级：环境变量 > 已存在的默认路径 > Electron userData > 最终兜底
  if (process.env.AI_AGENT_DATA_ROOT) {
    return process.env.AI_AGENT_DATA_ROOT;
  }
  var defaultPath = 'E:\\my-ai-data';
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  try {
    if (_app) {
      var fallback = path.join(_app.getPath('userData'), 'ai-data');
      return fallback;
    }
  } catch (e) {
    console.warn('[path-utils] 获取 userData 路径失败:', e.message);
  }
  return defaultPath;
}

// ===== 安全文件写入（自动处理 EISDIR + 创建父目录）=====
function safeWriteFile(filePath, content) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    console.warn('[path-utils] ' + path.basename(filePath) + ' 是目录，正在清理...');
    fs.rmSync(filePath, { recursive: true, force: true });
  }
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// ===== 安全文件读取（自动处理 EISDIR + 写入默认值）=====
function safeReadFile(filePath, defaultContent) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    console.warn('[path-utils] ' + path.basename(filePath) + ' 是目录，正在清理...');
    fs.rmSync(filePath, { recursive: true, force: true });
  }
  if (!fs.existsSync(filePath)) {
    safeWriteFile(filePath, defaultContent);
    return defaultContent;
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ===== 确保目录存在 =====
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Node.js require 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    name: 'path-utils',
    dependencies: [],
    getDataRoot: getDataRoot,
    safeWriteFile: safeWriteFile,
    safeReadFile: safeReadFile,
    ensureDir: ensureDir,
  };
}

// 模块 init（供 Core.loadModules 调用）
module.exports.init = function(_Core) {
  _Core.pathUtils = {
    getDataRoot: getDataRoot,
    safeWriteFile: safeWriteFile,
    safeReadFile: safeReadFile,
    ensureDir: ensureDir,
  };
};
