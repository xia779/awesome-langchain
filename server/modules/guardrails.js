// server/modules/guardrails.js — 三层安全防护：输入/输出/工具执行
var Core = null;
var stats = { blocked: 0, warnings: 0, passed: 0 };

// ===== Layer 1: 输入检测 — Prompt Injection =====
var INJECTION_PATTERNS = [
  // English
  /\bignore\s+(all\s+)?previous\s+instructions/i,
  /\bdisregard\s+(all\s+)?prior\s+(instructions|rules)/i,
  /\bforget\s+(all\s+)?previous/i,
  /\byou\s+are\s+now\s+(a|an)\s+/i,
  /\bnew\s+instructions?\s*:/i,
  /\bsystem\s*prompt\s*:/i,
  /\bact\s+as\s+(if\s+)?(you\s+are|a)\s+/i,
  /\bdo\s+not\s+follow\s+(any|the)\s+(previous|prior)/i,
  /\boverride\s+(your|the)\s+(instructions|rules|guidelines)/i,
  /\breveal\s+(your\s+)?system\s+prompt/i,
  // Chinese
  /忽略(之前|以前|先前|所有)(的)?.{0,6}(指令|规则|设定)/,
  /无视(上面|之前|以前)(的)?(内容|指令|规则)/,
  /你(现在)?是(一个)?(?!.*的)/,
  /新的(指令|规则|设定)\s*[:：]/,
  /不要(遵循|遵守|听从)(之前|以前|上面)(的)?/,
  /覆盖(你(的)?)?(指令|规则|设定)/,
  /显示(你(的)?)?系统(提示|prompt)/,
  /输出(你(的)?)?(system|系统)\s*prompt/i,
];

function checkInput(text) {
  if (!text || typeof text !== 'string') return { safe: true };
  for (var i = 0; i < INJECTION_PATTERNS.length; i++) {
    if (INJECTION_PATTERNS[i].test(text)) {
      stats.blocked++;
      var msg = '[Guardrails] 检测到潜在 Prompt 注入: 匹配规则 #' + (i + 1);
      console.warn(msg);
      return { safe: false, reason: msg, pattern: i + 1 };
    }
  }
  stats.passed++;
  return { safe: true };
}

// ===== Layer 2: 输出检测 — 数据泄露 =====
var LEAK_PATTERNS = [
  // API keys (common formats)
  /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi,
  // sk-xxx (OpenAI style)
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // Bearer tokens in output
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/,
  // Windows user paths
  /C:\\Users\\[^\\'"\s]+/gi,
  // Unix home paths
  /\/home\/[^/\s'"\\]+/g,
  // .env file contents
  /^[A-Z_]+=.+$/m,
  // Private keys
  /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/,
  // Database connection strings
  /(?:mongodb|mysql|postgres|redis):\/\/[^\s'"\\]+/i,
];

function checkOutput(text) {
  if (!text || typeof text !== 'string') return { safe: true };
  var leaks = [];
  for (var i = 0; i < LEAK_PATTERNS.length; i++) {
    var m = text.match(LEAK_PATTERNS[i]);
    if (m) {
      leaks.push({ pattern: i + 1, matches: m.slice(0, 3) });
    }
  }
  if (leaks.length > 0) {
    stats.warnings++;
    var msg = '[Guardrails] 输出检测到 ' + leaks.length + ' 处潜在数据泄露';
    console.warn(msg, leaks.map(function(l) { return '规则#' + l.pattern; }));
    // Redact sensitive info
    var cleaned = text;
    for (var j = 0; j < leaks.length; j++) {
      var pat = LEAK_PATTERNS[leaks[j].pattern - 1];
      pat.lastIndex = 0;
      cleaned = cleaned.replace(pat, function(match) {
        if (match.length > 8) return match.substring(0, 4) + '****' + match.substring(match.length - 4);
        return '****';
      });
    }
    return { safe: false, reason: msg, leaks: leaks, cleaned: cleaned };
  }
  stats.passed++;
  return { safe: true };
}

// ===== Layer 3: 工具执行检测 — 危险命令 =====
var DANGEROUS_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'format', 'fdisk', 'mkfs',
  'dd if=', ':(){', 'fork bomb',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init 0', 'init 6',
  'net stop', 'taskkill /f /im', 'del /s /q',
  'reg delete', 'bcdedit', 'cipher /w',
  'curl.*|.*sh', 'wget.*|.*sh', 'powershell.*invoke-expression',
  'chmod 777 /', 'chown -R',
];

var PROTECTED_DIRS = [
  'c:/windows', 'c:/program files', 'c:/programdata',
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/sys',
];

function checkToolExecution(action, params) {
  if (!action) return { safe: true };

  // Check dangerous commands in run_command / shell actions
  if (action === 'run_command' || action === 'execute_command' || action === 'shell') {
    var cmd = (params && (params.command || params.cmd || params.shell)) || '';
    if (typeof cmd === 'string') {
      var cmdLower = cmd.toLowerCase().replace(/\\/g, '/');
      for (var i = 0; i < DANGEROUS_COMMANDS.length; i++) {
        if (cmdLower.indexOf(DANGEROUS_COMMANDS[i].toLowerCase()) !== -1) {
          stats.blocked++;
          var msg = '[Guardrails] 阻止危险命令: ' + DANGEROUS_COMMANDS[i];
          console.warn(msg);
          return { safe: false, reason: msg, command: DANGEROUS_COMMANDS[i] };
        }
      }
      // Check protected dirs
      for (var j = 0; j < PROTECTED_DIRS.length; j++) {
        if (cmdLower.indexOf(PROTECTED_DIRS[j].toLowerCase()) !== -1) {
          stats.warnings++;
          var wmsg = '[Guardrails] 警告：命令涉及受保护目录 ' + PROTECTED_DIRS[j];
          console.warn(wmsg);
          return { safe: true, warning: wmsg };
        }
      }
    }
  }

  // Check file operations targeting sensitive paths
  if (action === 'write_file' || action === 'edit_file' || action === 'delete_file') {
    var filePath = (params && (params.path || params.file || params.filePath)) || '';
    if (typeof filePath === 'string') {
      var fpLower = filePath.toLowerCase().replace(/\\/g, '/');
      for (var k = 0; k < PROTECTED_DIRS.length; k++) {
        if (fpLower.indexOf(PROTECTED_DIRS[k].toLowerCase()) !== -1) {
          stats.blocked++;
          var fmsg = '[Guardrails] 阻止对受保护路径的写操作: ' + filePath;
          console.warn(fmsg);
          return { safe: false, reason: fmsg };
        }
      }
    }
  }

  stats.passed++;
  return { safe: true };
}

// ===== 控制 =====
function toggle() {
  var enabled = !Core.config.guardrailsEnabled;
  Core.saveConfig({ guardrailsEnabled: enabled });
  return enabled;
}

function resetStats() {
  stats = { blocked: 0, warnings: 0, passed: 0 };
}

function getStats() {
  return { blocked: stats.blocked, warnings: stats.warnings, passed: stats.passed };
}

function isEnabled() {
  return Core && Core.config && Core.config.guardrailsEnabled !== false;
}

// ===== 模块导出 =====
module.exports = {
  name: 'guardrails',
  dependencies: [],
  init: function(_Core, router) {
    Core = _Core;
    // Default enabled
    if (Core.config.guardrailsEnabled === undefined) {
      Core.config.guardrailsEnabled = true;
    }

    // Register WebSocket handlers
    if (router) {
      router.handle('guardrails.stats', function() {
        return getStats();
      });
      router.handle('guardrails.toggle', function() {
        var enabled = toggle();
        return { enabled: enabled };
      });
      router.handle('guardrails.reset', function() {
        resetStats();
        return { success: true };
      });
      router.handle('guardrails.checkInput', function(params) {
        return isEnabled() ? checkInput(params.text) : { safe: true };
      });
      router.handle('guardrails.checkOutput', function(params) {
        return isEnabled() ? checkOutput(params.text) : { safe: true };
      });
    }

    // Expose on Core for other server modules
    Core.guardrails = {
      checkInput: function(text) { return isEnabled() ? checkInput(text) : { safe: true }; },
      checkOutput: function(text) { return isEnabled() ? checkOutput(text) : { safe: true }; },
      checkToolExecution: function(a, p) { return isEnabled() ? checkToolExecution(a, p) : { safe: true }; },
      toggle: toggle,
      resetStats: resetStats,
      getStats: getStats,
      isEnabled: isEnabled,
    };
    console.log('[guardrails] initialized, enabled=' + Core.config.guardrailsEnabled);
  },
};
