// modules/context-manager.js - 上下文窗口管理（Token 估算 + 滑动窗口 + 摘要压缩）
'use strict';
var Core = null;

// ===== Token 估算 =====
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  var cjkCount = 0, otherCount = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF) || (code >= 0xAC00 && code <= 0xD7AF)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.ceil(cjkCount / 1.5 + otherCount / 4);
}

// ===== 滑动窗口构建 =====
var DEFAULT_TOKEN_BUDGET = 6000;
var MAX_MESSAGES = 40;
var MIN_MESSAGES = 3;

function buildContextWindow(messages, options) {
  options = options || {};
  var tokenBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
  var maxMessages = options.maxMessages || MAX_MESSAGES;
  var minMessages = options.minMessages || MIN_MESSAGES;
  if (!messages || messages.length === 0) return { window: [], summary: null, totalTokens: 0, skippedMessages: 0, totalMessages: 0 };

  var window = [];
  var usedTokens = 0;
  for (var i = messages.length - 1; i >= 0 && window.length < maxMessages; i--) {
    var msg = messages[i];
    var msgTokens = estimateTokens(msg.content || '') + 4;
    if (usedTokens + msgTokens > tokenBudget && window.length >= minMessages) break;
    window.unshift(msg);
    usedTokens += msgTokens;
  }

  var skippedCount = messages.length - window.length;
  var summaryText = null;
  if (skippedCount > 0) {
    summaryText = buildSummary(messages.slice(0, skippedCount));
  }

  return { window: window, summary: summaryText, totalTokens: usedTokens, skippedMessages: skippedCount, totalMessages: messages.length };
}

// ===== 摘要生成 =====
function buildSummary(messages) {
  if (!messages || messages.length === 0) return null;
  var summary = '【历史对话摘要】\n';
  var topicHints = [], keyPoints = [];
  messages.forEach(function(msg) {
    var content = (msg.content || '').trim();
    if (!content) return;
    var role = msg.role === 'user' ? '用户' : 'AI';
    var preview = content.substring(0, 120) + (content.length > 120 ? '...' : '');
    if (msg.role === 'user' && (content.indexOf('?') >= 0 || content.indexOf('？') >= 0)) {
      topicHints.push(preview.substring(0, 60));
    }
    keyPoints.push(role + ': ' + preview);
  });
  if (topicHints.length > 0) summary += '讨论主题: ' + topicHints.slice(0, 5).join(' | ') + '\n';
  var recentPoints = keyPoints.slice(-6);
  if (keyPoints.length > 6) summary += '（前 ' + (keyPoints.length - 6) + ' 条已省略）\n';
  summary += recentPoints.join('\n');
  return summary;
}

// ===== AI 摘要（异步，调用模型生成） =====
async function generateAISummary(messages) {
  if (!Core || !Core.api || !Core.api.callAPI) return buildSummary(messages);
  var condensed = messages.slice(-10).map(function(m) {
    return (m.role === 'user' ? '用户' : 'AI') + ': ' + (m.content || '').substring(0, 200);
  }).join('\n');
  try {
    var result = await Core.api.callAPI([
      { role: 'system', content: '你是一个对话摘要助手，请简洁地总结对话要点。' },
      { role: 'user', content: '请用2-3句话总结：\n\n' + condensed }
    ]);
    if (result && result.message && result.message.content) {
      return '【历史对话AI摘要】\n' + result.message.content;
    }
  } catch (e) {}
  return buildSummary(messages);
}

// ===== 摘要缓存 =====
var summaryCache = {};
var CACHE_TTL = 300000;

function getCachedSummary(sessionId, count) {
  var cached = summaryCache[sessionId];
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL) && cached.count === count) return cached.summary;
  return null;
}
function setCachedSummary(sessionId, summary, count) {
  summaryCache[sessionId] = { summary: summary, timestamp: Date.now(), count: count };
}

function getOptimizedContext(sessionId, options) {
  if (!Core || !Core.session || !Core.session.sessions) return null;
  var session = Core.session.sessions[sessionId];
  if (!session || !session.messages) return null;
  var result = buildContextWindow(session.messages, options);
  if (result.summary && sessionId) {
    var cached = getCachedSummary(sessionId, result.skippedMessages);
    if (cached) result.summary = cached;
    else setCachedSummary(sessionId, result.summary, result.skippedMessages);
  }
  return result;
}

function getTokenUsage(sessionId) {
  if (!Core || !Core.session || !Core.session.sessions) return null;
  var session = Core.session.sessions[sessionId];
  if (!session || !session.messages) return null;
  var totalTokens = 0;
  session.messages.forEach(function(m) { totalTokens += estimateTokens(m.content || ''); });
  var ctx = buildContextWindow(session.messages);
  return {
    totalMessages: session.messages.length,
    totalTokens: totalTokens,
    contextMessages: ctx.window.length,
    contextTokens: ctx.totalTokens,
    budget: DEFAULT_TOKEN_BUDGET,
    utilization: Math.round(ctx.totalTokens / DEFAULT_TOKEN_BUDGET * 100),
  };
}

module.exports = {
  init: function(_Core) {
    Core = _Core;
    Core.contextManager = {
      estimateTokens: estimateTokens,
      buildContextWindow: buildContextWindow,
      getOptimizedContext: getOptimizedContext,
      getTokenUsage: getTokenUsage,
      generateAISummary: generateAISummary,
      TOKEN_BUDGET: DEFAULT_TOKEN_BUDGET,
    };
    console.log('✅ 上下文管理模块已加载 | Token 预算: ' + DEFAULT_TOKEN_BUDGET);
  }
};
