// modules/observability.js - 可观测性（工具调用追踪 + 指标统计 + 成本估算）
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 指标存储 =====
let _metrics = {
  toolCalls: [],       // 最近 500 次工具调用记录
  agentRuns: [],       // 最近 100 次 agent 运行记录
  tokenUsage: [],      // 最近 200 次 LLM 调用记录
  errors: [],          // 最近 100 次错误记录
  startTime: Date.now()
};

const MAX_TOOL_CALLS = 500;
const MAX_AGENT_RUNS = 100;
const MAX_TOKEN_RECORDS = 200;
const MAX_ERRORS = 100;

let _statsFile = '';
let _flushTimer = null;

// ===== 记录工具调用 =====
function trackToolCall(action, params, result, durationMs) {
  var isSuccess = !(result && (
    String(result).indexOf('\u274c') === 0 ||
    String(result).indexOf('\u26d4') === 0 ||
    String(result).indexOf('error') === 0
  ));

  var record = {
    action: action,
    success: isSuccess,
    duration: durationMs || 0,
    timestamp: Date.now(),
    paramsSize: params ? JSON.stringify(params).length : 0,
    resultSize: result ? String(result).length : 0
  };

  _metrics.toolCalls.push(record);
  if (_metrics.toolCalls.length > MAX_TOOL_CALLS) _metrics.toolCalls.shift();

  // 记录错误
  if (!isSuccess) {
    _metrics.errors.push({
      type: 'tool_error',
      action: action,
      message: String(result).substring(0, 200),
      timestamp: Date.now()
    });
    if (_metrics.errors.length > MAX_ERRORS) _metrics.errors.shift();
  }

  return record;
}

// ===== 记录 Agent 运行 =====
function trackAgentRun(task, steps, success, totalDurationMs) {
  var record = {
    task: (task || '').substring(0, 100),
    steps: steps || 0,
    success: !!success,
    duration: totalDurationMs || 0,
    timestamp: Date.now()
  };

  _metrics.agentRuns.push(record);
  if (_metrics.agentRuns.length > MAX_AGENT_RUNS) _metrics.agentRuns.shift();

  return record;
}

// ===== 记录 Token 使用 =====
function trackTokenUsage(model, promptTokens, completionTokens, provider) {
  var record = {
    model: model || 'unknown',
    provider: provider || 'unknown',
    promptTokens: promptTokens || 0,
    completionTokens: completionTokens || 0,
    totalTokens: (promptTokens || 0) + (completionTokens || 0),
    timestamp: Date.now()
  };

  _metrics.tokenUsage.push(record);
  if (_metrics.tokenUsage.length > MAX_TOKEN_RECORDS) _metrics.tokenUsage.shift();

  return record;
}

// ===== 记录错误 =====
function trackError(type, message, context) {
  _metrics.errors.push({
    type: type,
    message: (message || '').substring(0, 300),
    context: context || '',
    timestamp: Date.now()
  });
  if (_metrics.errors.length > MAX_ERRORS) _metrics.errors.shift();
}

// ===== 统计报告 =====
function getReport() {
  var now = Date.now();
  var uptime = now - _metrics.startTime;

  // 工具调用统计
  var toolStats = _computeToolStats();

  // Agent 运行统计
  var agentStats = _computeAgentStats();

  // Token 统计
  var tokenStats = _computeTokenStats();

  // 错误 Top5
  var errorTop5 = _computeErrorTop5();

  return {
    uptime: uptime,
    uptimeHuman: _formatDuration(uptime),
    tools: toolStats,
    agent: agentStats,
    tokens: tokenStats,
    errorsTop5: errorTop5,
    recentErrors: _metrics.errors.slice(-5).reverse()
  };
}

function _computeToolStats() {
  var calls = _metrics.toolCalls;
  if (calls.length === 0) return { total: 0 };

  var total = calls.length;
  var success = calls.filter(function(c) { return c.success; }).length;
  var fail = total - success;

  // 按工具分组
  var byAction = {};
  calls.forEach(function(c) {
    if (!byAction[c.action]) byAction[c.action] = { count: 0, fail: 0, totalMs: 0 };
    byAction[c.action].count++;
    if (!c.success) byAction[c.action].fail++;
    byAction[c.action].totalMs += c.duration;
  });

  // 失败 Top5
  var failTop5 = Object.entries(byAction)
    .filter(function(e) { return e[1].fail > 0; })
    .sort(function(a, b) { return b[1].fail - a[1].fail; })
    .slice(0, 5)
    .map(function(e) { return { action: e[0], fail: e[1].fail, total: e[1].count, rate: Math.round(e[1].fail / e[1].count * 100) + '%' }; });

  // 平均耗时
  var avgDuration = Math.round(calls.reduce(function(s, c) { return s + c.duration; }, 0) / total);

  return {
    total: total,
    success: success,
    fail: fail,
    successRate: Math.round(success / total * 100) + '%',
    avgDurationMs: avgDuration,
    failTop5: failTop5,
    byAction: byAction
  };
}

function _computeAgentStats() {
  var runs = _metrics.agentRuns;
  if (runs.length === 0) return { total: 0 };

  var total = runs.length;
  var success = runs.filter(function(r) { return r.success; }).length;
  var avgSteps = Math.round(runs.reduce(function(s, r) { return s + r.steps; }, 0) / total * 10) / 10;
  var avgDuration = Math.round(runs.reduce(function(s, r) { return s + r.duration; }, 0) / total);

  return {
    total: total,
    success: success,
    fail: total - success,
    successRate: Math.round(success / total * 100) + '%',
    avgSteps: avgSteps,
    avgDurationMs: avgDuration,
    avgDurationHuman: _formatDuration(avgDuration)
  };
}

function _computeTokenStats() {
  var usage = _metrics.tokenUsage;
  if (usage.length === 0) return { totalCalls: 0, totalTokens: 0 };

  var totalPrompt = usage.reduce(function(s, u) { return s + u.promptTokens; }, 0);
  var totalCompletion = usage.reduce(function(s, u) { return s + u.completionTokens; }, 0);
  var totalTokens = totalPrompt + totalCompletion;

  // 按模型分组
  var byModel = {};
  usage.forEach(function(u) {
    if (!byModel[u.model]) byModel[u.model] = { calls: 0, tokens: 0 };
    byModel[u.model].calls++;
    byModel[u.model].tokens += u.totalTokens;
  });

  // 成本估算（基于常见定价，单位：美元）
  var estimatedCost = _estimateCost(usage);

  return {
    totalCalls: usage.length,
    totalTokens: totalTokens,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    avgTokensPerCall: Math.round(totalTokens / usage.length),
    byModel: byModel,
    estimatedCostUsd: estimatedCost
  };
}

function _estimateCost(usage) {
  // 简化的成本估算（基于 2026 年常见定价）
  var cost = 0;
  usage.forEach(function(u) {
    var model = (u.model || '').toLowerCase();
    if (model.indexOf('gpt-4') !== -1 || model.indexOf('o1') !== -1) {
      cost += u.promptTokens * 0.00003 + u.completionTokens * 0.00006;
    } else if (model.indexOf('gpt-3') !== -1 || model.indexOf('turbo') !== -1) {
      cost += u.promptTokens * 0.0000015 + u.completionTokens * 0.000002;
    } else if (model.indexOf('deepseek') !== -1) {
      cost += u.promptTokens * 0.0000005 + u.completionTokens * 0.000001;
    } else if (model.indexOf('qwen') !== -1 || model.indexOf('dashscope') !== -1) {
      cost += u.promptTokens * 0.000001 + u.completionTokens * 0.000002;
    } else if (model.indexOf('glm') !== -1) {
      cost += u.promptTokens * 0.000001 + u.completionTokens * 0.000001;
    } else {
      // 本地模型（Ollama）= 免费
      cost += 0;
    }
  });
  return Math.round(cost * 10000) / 10000; // 4位小数
}

function _computeErrorTop5() {
  var errorCounts = {};
  _metrics.errors.forEach(function(e) {
    var key = e.type + ':' + (e.action || e.message || '').substring(0, 50);
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  });
  return Object.entries(errorCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 5)
    .map(function(e) { return { error: e[0], count: e[1] }; });
}

// ===== 格式化 =====
function _formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

// ===== 持久化 =====
function _flush() {
  try {
    var data = {
      toolCalls: _metrics.toolCalls.slice(-100),
      agentRuns: _metrics.agentRuns.slice(-50),
      tokenUsage: _metrics.tokenUsage.slice(-50),
      errors: _metrics.errors.slice(-30),
      flushedAt: Date.now()
    };
    fs.writeFileSync(_statsFile, JSON.stringify(data), 'utf8');
  } catch (e) { console.warn('⚠️ [observability] 操作失败:', e.message || e); }
}

function _load() {
  try {
    if (fs.existsSync(_statsFile)) {
      var data = JSON.parse(fs.readFileSync(_statsFile, 'utf8'));
      _metrics.toolCalls = data.toolCalls || [];
      _metrics.agentRuns = data.agentRuns || [];
      _metrics.tokenUsage = data.tokenUsage || [];
      _metrics.errors = data.errors || [];
    }
  } catch (e) { console.warn('⚠️ [observability] 操作失败:', e.message || e); }
}

// ===== 重置 =====
function resetMetrics() {
  _metrics.toolCalls = [];
  _metrics.agentRuns = [];
  _metrics.tokenUsage = [];
  _metrics.errors = [];
  _metrics.startTime = Date.now();
  _flush();
  return { success: true };
}

// ===== 模块导出 =====
module.exports = {
  name: 'observability',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    _statsFile = Core.pathService.perUser('observability.json');
    _load();

    Core.observability = {
      trackTool: trackToolCall,
      trackAgent: trackAgentRun,
      trackTokens: trackTokenUsage,
      trackError: trackError,
      report: getReport,
      reset: resetMetrics,
      // 🔧 B18: 提供销毁接口，模块卸载/热更新时清理定时器
      destroy: function() { if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; _flush(); } }
    };

    // 定期持久化（每 2 分钟）
    _flushTimer = setInterval(_flush, 120000);

    // 🔧 B18: 进程退出时也 flush 一次
    if (typeof process !== 'undefined' && process.on) {
      process.on('beforeExit', function() { if (_flushTimer) _flush(); });
    }

    console.log('\u2705 \u53ef\u89c2\u6d4b\u6027\u6a21\u5757\u5df2\u52a0\u8f7d\uff08\u5de5\u5177: ' + _metrics.toolCalls.length + ', Agent: ' + _metrics.agentRuns.length + ', Token: ' + _metrics.tokenUsage.length + '\uff09');
  }
};
