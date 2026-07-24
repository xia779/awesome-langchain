// modules/capability-registry.js - 统一能力注册表
// 解决"散落技能点"问题：所有模块在此声明能力，agent-loop 动态发现，健康检查自动化
let Core = null;

// ===== 能力存储 =====
var _capabilities = {};   // id → capability definition
var _healthCache = {};    // id → { healthy, lastCheck, error }
var _HEALTH_TTL = 60000;  // 健康缓存 60 秒

// ===== 注册能力 =====
function register(cap) {
  if (!cap || !cap.id) {
    console.warn('⚠️ [capabilities] register: 缺少 id');
    return;
  }
  _capabilities[cap.id] = {
    id: cap.id,
    type: cap.type || 'tool',           // tool | data-source | role | command | ui
    description: cap.description || '',
    provider: cap.provider || 'unknown', // 来源模块名
    healthCheck: cap.healthCheck || null, // async () => boolean
    fallback: cap.fallback || [],         // 降级能力 id 列表
    input: cap.input || null,
    output: cap.output || null,
    priority: cap.priority || 50,         // 同类型排序（越高越优先）
    registeredAt: Date.now()
  };
}

// ===== 发现能力 =====
function discover(type) {
  var results = [];
  for (var id in _capabilities) {
    var cap = _capabilities[id];
    if (!type || cap.type === type) {
      results.push(cap);
    }
  }
  // 按优先级降序
  results.sort(function(a, b) { return b.priority - a.priority; });
  return results;
}

function get(id) {
  return _capabilities[id] || null;
}

// ===== 健康检查 =====
async function checkHealth(id) {
  var cap = _capabilities[id];
  if (!cap) return { healthy: false, error: '能力未注册: ' + id };

  // 缓存未过期则直接返回
  var cached = _healthCache[id];
  if (cached && (Date.now() - cached.lastCheck < _HEALTH_TTL)) {
    return cached;
  }

  if (!cap.healthCheck) {
    // 无健康检查函数，默认健康
    var result = { healthy: true, lastCheck: Date.now(), error: null };
    _healthCache[id] = result;
    return result;
  }

  try {
    var healthy = await cap.healthCheck();
    var result = { healthy: !!healthy, lastCheck: Date.now(), error: null };
    _healthCache[id] = result;
    return result;
  } catch (e) {
    var result = { healthy: false, lastCheck: Date.now(), error: e.message };
    _healthCache[id] = result;
    return result;
  }
}

// ===== 获取可用能力（健康 + 按优先级排序）=====
async function getAvailable(type) {
  var caps = discover(type);
  var available = [];
  for (var i = 0; i < caps.length; i++) {
    var health = await checkHealth(caps[i].id);
    if (health.healthy) {
      available.push(caps[i]);
    }
  }
  return available;
}

// ===== 带降级的能力解析 =====
async function resolve(id) {
  var cap = _capabilities[id];
  if (!cap) return null;

  var health = await checkHealth(id);
  if (health.healthy) return cap;

  // 尝试 fallback 链
  for (var i = 0; i < cap.fallback.length; i++) {
    var fbId = cap.fallback[i];
    var fbHealth = await checkHealth(fbId);
    if (fbHealth.healthy) {
      console.log('🔄 能力 ' + id + ' 不可用，降级到 ' + fbId);
      return _capabilities[fbId];
    }
  }
  return null;
}

// ===== 状态总览 =====
function getStatus() {
  var summary = { total: 0, byType: {}, providers: [] };
  for (var id in _capabilities) {
    var cap = _capabilities[id];
    summary.total++;
    summary.byType[cap.type] = (summary.byType[cap.type] || 0) + 1;
    if (summary.providers.indexOf(cap.provider) === -1) {
      summary.providers.push(cap.provider);
    }
  }
  return summary;
}

function listAll() {
  return Object.values(_capabilities).map(function(c) {
    return { id: c.id, type: c.type, description: c.description, provider: c.provider, priority: c.priority };
  });
}

// ===== 初始化：注册核心能力 =====
function init(_Core) {
  Core = _Core;

  Core.capabilities = {
    register: register,
    discover: discover,
    get: get,
    checkHealth: checkHealth,
    getAvailable: getAvailable,
    resolve: resolve,
    getStatus: getStatus,
    listAll: listAll
  };

  // 注册核心数据源能力
  register({
    id: 'web-search',
    type: 'data-source',
    description: '联网搜索（多引擎）',
    provider: 'search.js',
    priority: 80,
    healthCheck: function() {
      // IPC 搜索始终可用（主进程），HTTP 代理可能不可用
      return !!(typeof window !== 'undefined' && window.nodeBridge && window.nodeBridge.ipc);
    },
    fallback: ['search-bocha', 'search-tavily']
  });

  register({
    id: 'search-bocha',
    type: 'data-source',
    description: '博查搜索（付费直连）',
    provider: 'search.js',
    priority: 70,
    healthCheck: function() { return !!(Core.config && Core.config.bochaApiKey); }
  });

  register({
    id: 'search-tavily',
    type: 'data-source',
    description: 'Tavily 搜索（付费直连）',
    provider: 'search.js',
    priority: 65,
    healthCheck: function() { return !!(Core.config && Core.config.tavilyApiKey); }
  });

  register({
    id: 'page-fetch',
    type: 'data-source',
    description: '网页内容抓取（Playwright 渲染 + HTTP 回退）',
    provider: 'deep-research.js + browser-pro.js',
    priority: 90,
    healthCheck: function() { return !!(Core.browserPro || Core.toolsRegistry); },
    fallback: ['page-fetch-basic']
  });

  register({
    id: 'page-fetch-basic',
    type: 'data-source',
    description: '基础 HTTP 网页抓取（无 JS 渲染）',
    provider: 'tools.js (read_url)',
    priority: 40,
    healthCheck: function() { return !!(Core.toolsRegistry); }
  });

  register({
    id: 'knowledge-retrieval',
    type: 'data-source',
    description: '本地知识库混合检索（BM25 + 向量 + RRF）',
    provider: 'knowledge.js',
    priority: 95,
    healthCheck: function() { return !!(Core.knowledge); }
  });

  register({
    id: 'stock-data',
    type: 'data-source',
    description: 'A股实时行情（腾讯接口）',
    provider: 'stock-quote.js',
    priority: 90,
    healthCheck: function() { return !!(Core.stockQuote); }
  });

  register({
    id: 'deterministic-time',
    type: 'data-source',
    description: '系统时间（确定性，无需网络）',
    provider: 'tools.js (get_current_time)',
    priority: 100,
    healthCheck: function() { return true; }
  });

  register({
    id: 'deterministic-calc',
    type: 'data-source',
    description: '数学计算（确定性，无需网络）',
    provider: 'tools.js (calculate)',
    priority: 100,
    healthCheck: function() { return true; }
  });

  // 注册工具能力
  register({
    id: 'agent-tools',
    type: 'tool',
    description: 'Agent 工具集（文件/命令/浏览器/GitHub/图片）',
    provider: 'tools.js',
    priority: 90,
    healthCheck: function() { return !!(Core.toolsRegistry); }
  });

  register({
    id: 'deep-research',
    type: 'tool',
    description: '深度研究（多阶段流水线）',
    provider: 'deep-research.js',
    priority: 80,
    healthCheck: function() { return !!(Core.deepResearch); }
  });

  register({
    id: 'browser-automation',
    type: 'tool',
    description: 'Playwright 浏览器自动化',
    provider: 'browser-pro.js',
    priority: 70,
    healthCheck: function() { return !!(Core.browserPro); }
  });

  // 注册角色能力
  register({
    id: 'agent-loop',
    type: 'role',
    description: 'ReAct 自主循环（工具调用 + 推理）',
    provider: 'agent-loop.js',
    priority: 100,
    healthCheck: function() { return !!(Core.agentLoop); }
  });

  var status = getStatus();
  console.log('✅ 能力注册表已加载 | ' + status.total + ' 项能力, ' + status.providers.length + ' 个提供者');
}

module.exports = {
  name: 'capability-registry',
  dependencies: [],
  init: init
};
