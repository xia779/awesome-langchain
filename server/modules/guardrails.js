// server/modules/guardrails.js — 三层安全防护：输入/输出/工具执行
// 🔧 P1-1: 规则集与检测器收敛到 shared/guardrails-rules.js（与主进程单事实源一致），
//          此处仅保留 server 专属的 WebSocket 处理器与 Core 暴露。
var Core = null;
var stats = { blocked: 0, warnings: 0, passed: 0 };
var RULES = require('../../shared/guardrails-rules');

// ===== Layer 1: 输入检测 — Prompt Injection =====
function checkInput(text) {
  if (!text || typeof text !== 'string') return { safe: true };
  var r = RULES.scanInjection(text);
  if (!r.safe) {
    stats.blocked++;
    console.warn(r.reason);
    return r;
  }
  stats.passed++;
  return { safe: true };
}

// ===== Layer 2: 输出检测 — 数据泄露 =====
function checkOutput(text) {
  if (!text || typeof text !== 'string') return { safe: true };
  var r = RULES.scanLeak(text);
  if (!r.safe) {
    stats.warnings++;
    var msg = '[Guardrails] 输出检测到 ' + r.leaks.length + ' 处潜在数据泄露';
    console.warn(msg, r.leaks.map(function (l) { return '规则#' + l.pattern; }));
    return r;
  }
  stats.passed++;
  return { safe: true };
}

// ===== Layer 3: 工具执行检测 — 危险命令 =====
function checkToolExecution(action, params) {
  if (!action) return { safe: true };

  if (action === 'run_command' || action === 'execute_command' || action === 'shell') {
    var cmd = (params && (params.command || params.cmd || params.shell)) || '';
    if (typeof cmd === 'string') {
      var block = RULES.scanCommand(cmd);
      if (!block.safe) {
        stats.blocked++;
        console.warn(block.reason);
        return { safe: false, reason: block.reason, command: block.reason };
      }
      var warn = RULES.scanProtectedDirs(cmd);
      if (warn) {
        stats.warnings++;
        console.warn(warn.warning);
        return { safe: true, warning: warn.warning };
      }
    }
  }

  if (action === 'write_file' || action === 'edit_file' || action === 'delete_file') {
    var filePath = (params && (params.path || params.file || params.filePath)) || '';
    if (typeof filePath === 'string' && RULES.isProtectedPath(filePath)) {
      stats.blocked++;
      var fmsg = '[Guardrails] 阻止对受保护路径的写操作: ' + filePath;
      console.warn(fmsg);
      return { safe: false, reason: fmsg };
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
  init: function (_Core, router) {
    Core = _Core;
    if (Core.config.guardrailsEnabled === undefined) {
      Core.config.guardrailsEnabled = true;
    }

    // Register WebSocket handlers
    if (router) {
      router.handle('guardrails.stats', function () {
        return getStats();
      });
      router.handle('guardrails.toggle', function () {
        var enabled = toggle();
        return { enabled: enabled };
      });
      router.handle('guardrails.reset', function () {
        resetStats();
        return { success: true };
      });
      router.handle('guardrails.checkInput', function (params) {
        return isEnabled() ? checkInput(params.text) : { safe: true };
      });
      router.handle('guardrails.checkOutput', function (params) {
        return isEnabled() ? checkOutput(params.text) : { safe: true };
      });
    }

    // Expose on Core for other server modules
    Core.guardrails = {
      checkInput: function (text) { return isEnabled() ? checkInput(text) : { safe: true }; },
      checkOutput: function (text) { return isEnabled() ? checkOutput(text) : { safe: true }; },
      checkToolExecution: function (a, p) { return isEnabled() ? checkToolExecution(a, p) : { safe: true }; },
      toggle: toggle,
      resetStats: resetStats,
      getStats: getStats,
      isEnabled: isEnabled,
    };
    console.log('[guardrails] initialized, enabled=' + Core.config.guardrailsEnabled);
  },
};
