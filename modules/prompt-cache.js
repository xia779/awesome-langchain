// modules/prompt-cache.js - Prompt 缓存（减少重复上下文的 token 消耗）
'use strict';
const crypto = require('crypto');

let Core = null;

// ===== 缓存存储 =====
let _cache = new Map();  // hash → { messages, timestamp, hits }
const MAX_CACHE_SIZE = 50;
const CACHE_TTL = 600000; // 10 分钟

// ===== 缓存键生成 =====
function _cacheKey(messages) {
  if (!messages || messages.length === 0) return null;
  // 用 system + 前 N 条消息的 hash 作为键
  var stable = messages.slice(0, Math.min(messages.length - 1, 5));
  var raw = stable.map(function(m) { return m.role + ':' + (m.content || '').substring(0, 200); }).join('|');
  return crypto.createHash('md5').update(raw).digest('hex');
}

// ===== 检查缓存 =====
function getCachedContext(messages) {
  var key = _cacheKey(messages);
  if (!key) return null;

  var entry = _cache.get(key);
  if (!entry) return null;

  // TTL 检查
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    _cache.delete(key);
    return null;
  }

  entry.hits++;
  return {
    hit: true,
    cachedMessages: entry.messages,
    cacheKey: key,
    hits: entry.hits
  };
}

// ===== 存入缓存 =====
function setCachedContext(messages, response) {
  var key = _cacheKey(messages);
  if (!key) return;

  // LRU 淘汰
  if (_cache.size >= MAX_CACHE_SIZE) {
    var oldest = null, oldestTime = Infinity;
    _cache.forEach(function(v, k) {
      if (v.timestamp < oldestTime) { oldestTime = v.timestamp; oldest = k; }
    });
    if (oldest) _cache.delete(oldest);
  }

  _cache.set(key, {
    messages: messages,
    response: response,
    timestamp: Date.now(),
    hits: 0
  });
}

// ===== 为 Ollama 请求添加缓存提示 =====
function enhanceOllamaRequest(payload) {
  // Ollama 0.6+ 支持 keep_alive 保持模型加载（减少冷启动）
  if (!payload.options) payload.options = {};
  if (!payload.options.keep_alive) {
    payload.options.keep_alive = '5m';
  }
  return payload;
}

// ===== 为 DashScope 请求添加缓存标记 =====
function enhanceDashScopeRequest(payload) {
  // DashScope 支持 enable_search 和 cache 参数
  if (payload.parameters === undefined) payload.parameters = {};
  // 启用 prompt cache（如果模型支持）
  payload.parameters.enable_prompt_cache = true;
  return payload;
}

// ===== 缓存统计 =====
function getStats() {
  var totalHits = 0;
  _cache.forEach(function(v) { totalHits += v.hits; });
  return {
    size: _cache.size,
    maxSize: MAX_CACHE_SIZE,
    totalHits: totalHits,
    ttlMs: CACHE_TTL
  };
}

// ===== 清空缓存 =====
function clearCache() {
  _cache.clear();
  return { success: true };
}

// ===== 模块导出 =====
module.exports = {
  name: 'prompt-cache',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;

    Core.promptCache = {
      get: getCachedContext,
      set: setCachedContext,
      enhanceOllama: enhanceOllamaRequest,
      enhanceDashScope: enhanceDashScopeRequest,
      stats: getStats,
      clear: clearCache
    };

    console.log('\u2705 Prompt \u7f13\u5b58\u6a21\u5757\u5df2\u52a0\u8f7d\uff08LRU ' + MAX_CACHE_SIZE + ' \u6761, TTL ' + CACHE_TTL / 60000 + 'min\uff09');
  }
};
