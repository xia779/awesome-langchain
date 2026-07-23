// modules/sandbox.js - 轻量沙箱执行（目录隔离 + 资源限制 + 可选 Docker）
'use strict';
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

let Core = null;

// ===== 沙箱目录 =====
let _sandboxDir = '';
let _dockerAvailable = null;

function getSandboxDir() {
  if (!_sandboxDir) {
    _sandboxDir = path.join(Core.DATA_ROOT || 'E:\\my-ai-data', 'sandbox');
    if (!fs.existsSync(_sandboxDir)) fs.mkdirSync(_sandboxDir, { recursive: true });
  }
  return _sandboxDir;
}

// ===== 增强的 Python 安全检查 =====
// 比 tools.js 的简单黑名单更全面
const PYTHON_DANGEROUS_PATTERNS = [
  // 系统调用
  /os\.system\s*\(/, /os\.popen\s*\(/, /os\.exec[lv]?p?e?\s*\(/,
  /subprocess\.\w+\s*\(/, /commands\.getoutput/,
  // 动态执行
  /\beval\s*\(/, /\bexec\s*\(/, /\bcompile\s*\(/,
  /__import__\s*\(/, /importlib\.import_module/,
  /getattr\s*\(\s*\w+\s*,\s*['"](?:system|popen|exec)/,
  // 文件操作（沙箱外）
  /open\s*\(\s*['"](?!.*(?:sandbox|tmp))/,  // 允许沙箱内文件
  /shutil\.rmtree/, /os\.remove/, /os\.unlink/, /os\.rmdir/,
  // 网络（可选限制）
  /socket\.socket/, /http\.client/, /urllib\.request\.urlopen/,
  /requests\.(?:get|post|put|delete)\s*\(/,
  // 进程/线程
  /multiprocessing\.Process/, /threading\.Thread/,
  // 注册表/系统
  /winreg/, /ctypes\.windll/, /ctypes\.cdll/,
  // 环境变量泄露
  /os\.environ/,
  // 危险模块导入
  /import\s+(?:sys|os|subprocess|shutil|ctypes|winreg)\b/,
  /from\s+(?:sys|os|subprocess|shutil|ctypes|winreg)\s+import/
];

// 白名单：允许的安全导入
const PYTHON_SAFE_IMPORTS = [
  'math', 'json', 're', 'datetime', 'collections', 'itertools',
  'functools', 'string', 'random', 'statistics', 'decimal',
  'csv', 'base64', 'hashlib', 'hmac', 'uuid', 'time',
  'typing', 'dataclasses', 'enum', 'abc', 'copy',
  'numpy', 'pandas', 'matplotlib', 'scipy', 'sklearn'
];

function checkPythonSafety(code) {
  var issues = [];

  for (var i = 0; i < PYTHON_DANGEROUS_PATTERNS.length; i++) {
    if (PYTHON_DANGEROUS_PATTERNS[i].test(code)) {
      issues.push('匹配危险模式: ' + PYTHON_DANGEROUS_PATTERNS[i].source.substring(0, 40));
    }
  }

  // 检查文件路径是否逃逸沙箱
  var pathEscapes = code.match(/['"](?:[A-Z]:\\|\/(?:etc|usr|home|root|var|tmp))[^'"]*['"]/gi);
  if (pathEscapes) {
    issues.push('尝试访问沙箱外路径: ' + pathEscapes[0]);
  }

  return {
    safe: issues.length === 0,
    issues: issues,
    risk: issues.length === 0 ? 'low' : issues.length <= 2 ? 'medium' : 'high'
  };
}

// ===== 沙箱内执行 Python =====
function executePythonSandboxed(code, options) {
  var opts = Object.assign({ timeout: 30000, maxOutput: 5000 }, options || {});
  var sandbox = getSandboxDir();

  // 安全检查
  var safety = checkPythonSafety(code);
  if (safety.risk === 'high') {
    return Promise.resolve({
      success: false,
      output: '⛔ 代码被沙箱拦截（高风险）:\n' + safety.issues.join('\n'),
      blocked: true,
      issues: safety.issues
    });
  }

  // 注入沙箱环境（限制工作目录 + 环境变量）
  var sandboxedCode = _wrapPythonCode(code, sandbox);

  // 写入临时文件
  var tmpFile = path.join(sandbox, 'script_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '.py');
  fs.writeFileSync(tmpFile, sandboxedCode, 'utf8');

  return new Promise(function(resolve) {
    var startTime = Date.now();

    // 检测 Docker
    if (_dockerAvailable === true && Core.config && Core.config.sandbox && Core.config.sandbox.useDocker !== false) {
      _execInDocker(tmpFile, opts, function(result) {
        _cleanup(tmpFile);
        result.duration = Date.now() - startTime;
        result.sandbox = 'docker';
        resolve(result);
      });
    } else {
      // 本地沙箱执行
      var execOpts = {
        timeout: opts.timeout,
        cwd: sandbox,
        maxBuffer: 2 * 1024 * 1024,
        env: Object.assign({}, process.env, {
          PYTHONPATH: sandbox,
          SANDBOX_DIR: sandbox,
          // 限制：不传递敏感环境变量
          API_KEY: undefined,
          SECRET: undefined,
          TOKEN: undefined
        })
      };

      exec('python "' + tmpFile + '"', execOpts, function(error, stdout, stderr) {
        _cleanup(tmpFile);
        var output = (stdout || '') + (stderr ? '\n[STDERR]\n' + stderr : '');
        if (output.length > opts.maxOutput) {
          output = output.substring(0, opts.maxOutput) + '\n...(输出截断)';
        }
        resolve({
          success: !error,
          output: output || '(无输出)',
          error: error ? error.message : null,
          duration: Date.now() - startTime,
          sandbox: 'local',
          safety: safety
        });
      });
    }
  });
}

// ===== 沙箱内执行 Shell 命令 =====
function executeCommandSandboxed(command, options) {
  var opts = Object.assign({ timeout: 30000, maxOutput: 5000 }, options || {});
  var sandbox = getSandboxDir();

  // 命令安全检查
  var cmdCheck = _checkCommandSafety(command);
  if (cmdCheck.blocked) {
    return Promise.resolve({
      success: false,
      output: '⛔ 命令被沙箱拦截: ' + cmdCheck.reason,
      blocked: true
    });
  }

  return new Promise(function(resolve) {
    var startTime = Date.now();
    var execOpts = {
      timeout: opts.timeout,
      cwd: sandbox,
      maxBuffer: 2 * 1024 * 1024
    };

    exec(command, execOpts, function(error, stdout, stderr) {
      var output = (stdout || '') + (stderr ? '\n[STDERR]\n' + stderr : '');
      if (output.length > opts.maxOutput) {
        output = output.substring(0, opts.maxOutput) + '\n...(输出截断)';
      }
      resolve({
        success: !error,
        output: output || '(无输出)',
        error: error ? error.message : null,
        duration: Date.now() - startTime,
        sandbox: 'local'
      });
    });
  });
}

// ===== Docker 执行 =====
function _execInDocker(scriptPath, opts, callback) {
  var sandbox = getSandboxDir();
  var containerName = 'ai-sandbox-' + Date.now();
  var cmd = 'docker run --rm --name ' + containerName +
    ' --memory=256m --cpus=0.5 --network=none' +
    ' -v "' + sandbox + '":/sandbox' +
    ' -w /sandbox' +
    ' python:3.11-slim python /sandbox/' + path.basename(scriptPath);

  exec(cmd, { timeout: opts.timeout + 5000, maxBuffer: 2 * 1024 * 1024 }, function(error, stdout, stderr) {
    var output = (stdout || '') + (stderr ? '\n[STDERR]\n' + stderr : '');
    if (output.length > opts.maxOutput) {
      output = output.substring(0, opts.maxOutput) + '\n...(输出截断)';
    }
    callback({
      success: !error,
      output: output || '(无输出)',
      error: error ? error.message : null
    });
  });
}

// ===== 检测 Docker 可用性 =====
function detectDocker() {
  try {
    execSync('docker --version', { timeout: 5000, stdio: 'pipe' });
    _dockerAvailable = true;
    console.log('🐳 Docker 可用，沙箱将使用容器隔离');
  } catch (e) {
    _dockerAvailable = false;
    console.log('📦 Docker 不可用，使用本地目录沙箱');
  }
  return _dockerAvailable;
}

// ===== 辅助函数 =====
function _wrapPythonCode(code, sandbox) {
  // 注入沙箱路径变量 + 限制 os.chdir
  return '# Sandbox wrapper\n' +
    'import os as _os\n' +
    '_os.chdir(r"' + sandbox.replace(/\\/g, '\\\\') + '")\n' +
    'SANDBOX_DIR = r"' + sandbox.replace(/\\/g, '\\\\') + '"\n' +
    '# --- user code ---\n' +
    code + '\n';
}

function _checkCommandSafety(command) {
  var blocked = [
    /format\s+[a-z]:/i, /shutdown/i, /reboot/i, /fdisk/i, /mkfs/i,
    /rm\s+-rf\s+\//, /del\s+\/[sf]/i, /reg\s+delete/i,
    /net\s+stop/i, /taskkill\s+\/f/i, /cipher\s+\/w/i,
    /powershell.*invoke-expression/i, /curl.*\|\s*(?:ba)?sh/i
  ];
  for (var i = 0; i < blocked.length; i++) {
    if (blocked[i].test(command)) {
      return { blocked: true, reason: '匹配危险命令模式: ' + blocked[i].source };
    }
  }
  return { blocked: false };
}

function _cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
}

// ===== 沙箱状态 =====
function getSandboxStatus() {
  var sandbox = getSandboxDir();
  var files = [];
  try { files = fs.readdirSync(sandbox).filter(function(f) { return !f.startsWith('.'); }); } catch (e) {}
  return {
    dir: sandbox,
    dockerAvailable: _dockerAvailable,
    filesInSandbox: files.length,
    mode: _dockerAvailable ? 'docker' : 'local-directory'
  };
}

// ===== 清理沙箱 =====
function cleanSandbox() {
  var sandbox = getSandboxDir();
  var cleaned = 0;
  try {
    var files = fs.readdirSync(sandbox);
    files.forEach(function(f) {
      if (f.startsWith('script_') || f.startsWith('py_') || f.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(sandbox, f)); cleaned++; } catch (e) {}
      }
    });
  } catch (e) {}
  return { success: true, cleaned: cleaned };
}

// ===== 模块导出 =====
module.exports = {
  name: 'sandbox',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    getSandboxDir(); // 确保目录存在

    // 延迟检测 Docker（不阻塞启动）
    setTimeout(detectDocker, 3000);

    Core.sandbox = {
      executePython: executePythonSandboxed,
      executeCommand: executeCommandSandboxed,
      checkPython: checkPythonSafety,
      status: getSandboxStatus,
      clean: cleanSandbox,
      detectDocker: detectDocker,
      getDir: getSandboxDir
    };

    console.log('\u2705 \u6c99\u7bb1\u6267\u884c\u6a21\u5757\u5df2\u52a0\u8f7d\uff08\u76ee\u5f55: ' + getSandboxDir() + '\uff09');
  }
};
