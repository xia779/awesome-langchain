// modules/python.js - 安全版（spawn 替代 exec）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let Core = null;

// 检测可用的 Python 命令（优先 python3，回退 python）
var _pythonCmd = null;
function detectPythonCmd() {
  if (_pythonCmd) return _pythonCmd;
  return new Promise(function(resolve) {
    var p3 = spawn('python3', ['--version']);
    p3.on('close', function(code) { if (code === 0) { _pythonCmd = 'python3'; resolve('python3'); } });
    p3.on('error', function() {
      var p = spawn('python', ['--version']);
      p.on('close', function(code) { if (code === 0) { _pythonCmd = 'python'; resolve('python'); } });
      p.on('error', function() { _pythonCmd = 'python'; resolve('python'); });
    });
  });
}

// 执行 Python 代码（返回 Promise）
function runPython(code) {
  return new Promise(async function(resolve, reject) {
    if (!code || typeof code !== 'string') {
      reject('无效代码输入');
      return;
    }

    var pythonCmd = await detectPythonCmd();
    var baseDir = Core.pathService.global();
    var tempDir = path.join(baseDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      try { fs.mkdirSync(tempDir, { recursive: true }); } catch (e) { console.warn('[Python] Failed to create temp dir:', e.message); }
    }
    var tempFile = path.join(tempDir, 'py_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.py');
    try {
      fs.writeFileSync(tempFile, code);
    } catch (e) {
      reject('无法写入临时文件: ' + e.message);
      return;
    }

    var stdout = '';
    var stderr = '';
    var child = spawn(pythonCmd, [tempFile], { timeout: 30000 });

    child.stdout.on('data', function(data) { stdout += data.toString(); });
    child.stderr.on('data', function(data) { stderr += data.toString(); });

    child.on('error', function(err) {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { console.warn('⚠️ [python] 操作失败:', e.message || e); }
      reject('Python 执行失败: ' + err.message);
    });

    child.on('close', function(exitCode) {
      // 清理临时文件
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { /* 可忽略：清理路径，失败不影响主流程 */ }

      if (exitCode !== 0) {
        reject(stderr || 'Python 退出码: ' + exitCode);
      } else {
        resolve(stdout);
      }
    });
  });
}

// 检查 Python 是否可用
function checkPython() {
  return new Promise(async function(resolve) {
    var pythonCmd = await detectPythonCmd();
    var child = spawn(pythonCmd, ['--version']);
    var stdout = '';

    child.stdout.on('data', function(data) { stdout += data.toString(); });
    child.on('error', function() { resolve({ available: false, version: null }); });
    child.on('close', function(code) {
      if (code === 0) {
        resolve({ available: true, version: stdout.trim(), command: pythonCmd });
      } else {
        resolve({ available: false, version: null });
      }
    });
  });
}

module.exports = {
  init(_Core) {
    Core = _Core;
    // 挂载到 Core 对象
    Core.python = {
      runPython: runPython,
      checkPython: checkPython,
    };
    // 启动时检查 Python 可用性
    checkPython().then(result => {
      if (result.available) {
        console.log(`✅ Python 已就绪: ${result.version}`);
      } else {
        console.warn('⚠️ Python 未安装或不在 PATH 中');
      }
    });
    console.log('✅ Python 模块已加载');
  }
};