// modules/model-router.js - 智能模型路由 (P6-3)
// 延迟感知 + 负载均衡 + 配额管理 + 自动降级
'use strict';

var Core = null;
var fs = null;
var path = null;

var ROUTER_FILE = '';
var _providers = [];   // [{ id, name, baseUrl, models[], priority, weight, enabled, stats }]
var _latencyHistory = {};  // { providerId: [ms, ...] }
var _quotas = {};      // { providerId: { used, limit, resetAt } }
var ROUTER_CONFIG = {
  strategy: 'weighted-latency',  // priority | round-robin | weighted-latency | cost-optimal
  latencyWindow: 20,             // 保留最近N次延迟记录
  timeoutMs: 30000,
  maxRetries: 2,
  cooldownAfterFailure: 60000    // 失败后冷却期
};

// ===== 持久化 =====
function loadRouterState() {
  if (!Core || !Core.DATA_ROOT) return;
  ROUTER_FILE = path.join(Core.DATA_ROOT, 'model-router.json');
  try {
    if (fs.existsSync(ROUTER_FILE)) {
      var data = JSON.parse(fs.readFileSync(ROUTER_FILE, 'utf8'));
      if (Array.isArray(data.providers)) _providers = data.providers;
      if (data.config) Object.assign(ROUTER_CONFIG, data.config);
      if (data.quotas) _quotas = data.quotas;
    }
  } catch (e) { /* fresh */ }
}

function saveRouterState() {
  try {
    if (ROUTER_FILE) fs.writeFileSync(ROUTER_FILE, JSON.stringify({
      providers: _providers, config: ROUTER_CONFIG, quotas: _quotas
    }, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

// ===== Provider 管理 =====
function addProvider(config) {
  var provider = {
    id: 'prov_' + Date.now().toString(36),
    name: config.name || 'New Provider',
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '',
    models: config.models || [],
    priority: config.priority || 50,
    weight: config.weight || 1,
    enabled: config.enabled !== false,
    stats: { requests: 0, successes: 0, failures: 0, totalLatency: 0, lastFailure: 0 }
  };
  _providers.push(provider);
  _providers.sort(function(a, b) { return b.priority - a.priority; });
  saveRouterState();
  return provider;
}

function removeProvider(id) {
  _providers = _providers.filter(function(p) { return p.id !== id; });
  saveRouterState();
  return { success: true };
}

function listProviders() {
  return _providers.map(function(p) {
    return {
      id: p.id, name: p.name, models: p.models, priority: p.priority,
      weight: p.weight, enabled: p.enabled,
      avgLatency: getAvgLatency(p.id),
      successRate: p.stats.requests > 0 ? Math.round(p.stats.successes / p.stats.requests * 100) : 100,
      quota: _quotas[p.id] || null
    };
  });
}

// ===== 路由选择 =====
function selectProvider(model, taskType) {
  var candidates = _providers.filter(function(p) {
    if (!p.enabled) return false;
    // 冷却期检查
    if (p.stats.lastFailure && (Date.now() - p.stats.lastFailure) < ROUTER_CONFIG.cooldownAfterFailure) return false;
    // 配额检查
    var quota = _quotas[p.id];
    if (quota && quota.limit > 0 && quota.used >= quota.limit && quota.resetAt > Date.now()) return false;
    // 模型匹配
    if (model && p.models.length > 0 && p.models.indexOf(model) < 0) return false;
    return true;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  switch (ROUTER_CONFIG.strategy) {
    case 'priority':
      return candidates[0];

    case 'round-robin':
      var rrIdx = (Date.now() / 1000 | 0) % candidates.length;
      return candidates[rrIdx];

    case 'weighted-latency':
      return _selectByWeightedLatency(candidates);

    case 'cost-optimal':
      return _selectByCost(candidates);

    default:
      return candidates[0];
  }
}

function _selectByWeightedLatency(candidates) {
  // 得分 = weight * (1 / normalizedLatency) * successRate
  var scored = candidates.map(function(p) {
    var avgLat = getAvgLatency(p.id) || 1000;
    var successRate = p.stats.requests > 0 ? p.stats.successes / p.stats.requests : 1;
    var score = p.weight * (1000 / avgLat) * successRate;
    return { provider: p, score: score };
  });
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored[0].provider;
}

function _selectByCost(candidates) {
  // 简单成本模型：优先级越高越贵，选最便宜且可用的
  var sorted = candidates.slice().sort(function(a, b) { return a.priority - b.priority; });
  return sorted[0];
}

// ===== 延迟追踪 =====
function recordLatency(providerId, latencyMs, success) {
  if (!_latencyHistory[providerId]) _latencyHistory[providerId] = [];
  _latencyHistory[providerId].push(latencyMs);
  if (_latencyHistory[providerId].length > ROUTER_CONFIG.latencyWindow) {
    _latencyHistory[providerId] = _latencyHistory[providerId].slice(-ROUTER_CONFIG.latencyWindow);
  }

  var provider = _providers.find(function(p) { return p.id === providerId; });
  if (provider) {
    provider.stats.requests++;
    if (success) {
      provider.stats.successes++;
      provider.stats.totalLatency += latencyMs;
    } else {
      provider.stats.failures++;
      provider.stats.lastFailure = Date.now();
    }
    saveRouterState();
  }
}

function getAvgLatency(providerId) {
  var history = _latencyHistory[providerId] || [];
  if (history.length === 0) return null;
  var sum = history.reduce(function(a, b) { return a + b; }, 0);
  return Math.round(sum / history.length);
}

// ===== 配额管理 =====
function setQuota(providerId, limit, periodMs) {
  _quotas[providerId] = { used: 0, limit: limit, resetAt: Date.now() + (periodMs || 86400000), period: periodMs || 86400000 };
  saveRouterState();
}

function consumeQuota(providerId) {
  var quota = _quotas[providerId];
  if (!quota) return true;
  if (quota.resetAt < Date.now()) {
    quota.used = 0;
    quota.resetAt = Date.now() + quota.period;
  }
  quota.used++;
  saveRouterState();
  return quota.used <= quota.limit;
}

// ===== Fallback 链 =====
function getFallbackChain(model) {
  var all = _providers.filter(function(p) { return p.enabled; });
  if (model) {
    var matching = all.filter(function(p) { return p.models.length === 0 || p.models.indexOf(model) >= 0; });
    if (matching.length > 0) all = matching;
  }
  // 按策略排序
  return all.map(function(p) {
    var avgLat = getAvgLatency(p.id) || 2000;
    var successRate = p.stats.requests > 0 ? p.stats.successes / p.stats.requests : 1;
    return { provider: p, score: p.priority * successRate * (2000 / avgLat) };
  }).sort(function(a, b) { return b.score - a.score; }).map(function(s) { return s.provider; });
}

// ===== 路由统计 =====
function getRouterStats() {
  return {
    strategy: ROUTER_CONFIG.strategy,
    providerCount: _providers.length,
    activeProviders: _providers.filter(function(p) { return p.enabled; }).length,
    providers: listProviders(),
    totalRequests: _providers.reduce(function(sum, p) { return sum + p.stats.requests; }, 0),
    avgGlobalLatency: Math.round(_providers.reduce(function(sum, p) {
      var lat = getAvgLatency(p.id);
      return sum + (lat || 0);
    }, 0) / Math.max(1, _providers.filter(function(p) { return getAvgLatency(p.id); }).length))
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'model-router',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }
    loadRouterState();
    Core.modelRouter = {
      select: selectProvider,
      addProvider: addProvider,
      removeProvider: removeProvider,
      list: listProviders,
      recordLatency: recordLatency,
      getAvgLatency: getAvgLatency,
      setQuota: setQuota,
      consumeQuota: consumeQuota,
      getFallbackChain: getFallbackChain,
      stats: getRouterStats,
      CONFIG: ROUTER_CONFIG
    };
    console.log('\u2705 model-router \u5df2\u52a0\u8f7d\uff08\u667a\u80fd\u8def\u7531: ' + _providers.length + ' \u4e2a provider, \u7b56\u7565: ' + ROUTER_CONFIG.strategy + '\uff09');
  }
};
