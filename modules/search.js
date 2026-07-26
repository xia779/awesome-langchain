// modules/search.js (后端代理版 - 支持 DuckDuckGo + 博查 + Tavily)
// 🔧 DuckDuckGo 为默认免费引擎（无需 API Key），博查/Tavily 为付费增强选项
let Core = null;

// ===== 动态解析后端服务端口（统一走 Core.getBackendBase()，core-v10.js 中定义）=====
var _backendSearchHealthy = true;
var _backendUnhealthySince = 0; // 🔒 S12: 记录后端不可用的时间戳，用于定期重试
var _BACKEND_RETRY_MS = 3 * 60 * 1000; // 3 分钟后重新探测后端

// 异步探测后端搜索服务是否可用
async function _probeSearchBackend() {
  try {
    var base = _searchBackendBase();
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 2000);
    var resp = await fetch(base + '/health', { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    _backendSearchHealthy = resp.ok;
    if (resp.ok) _backendUnhealthySince = 0;
  } catch (e) {
    _backendSearchHealthy = false;
    if (!_backendUnhealthySince) _backendUnhealthySince = Date.now();
  }
  return _backendSearchHealthy;
}

function _searchBackendBase() {
  if (Core && typeof Core.refreshBackendPort === 'function') Core.refreshBackendPort();
  if (Core && typeof Core.getBackendBase === 'function') {
    var base = Core.getBackendBase();
    // 如果返回的端口是默认 8080 且健康标记为 false，大概率服务未启动
    if (base === 'http://127.0.0.1:8080' && !_backendSearchHealthy) {
      console.warn('⚠️ 本地搜索服务尚未就绪，跳过请求 8080');
    }
    return base;
  }
  return 'http://127.0.0.1:8080';
}

// ===== P1-4: 搜索结果 TTL 缓存（降低脆弱后端压力 + 后端不可用时返回近期缓存兜底）=====
var _SEARCH_CACHE_TTL = 10 * 60 * 1000;   // 10 分钟内直接复用，避免重复打后端
var _SEARCH_CACHE_STALE = 60 * 60 * 1000; // 后端不可用时，1 小时内的缓存仍可兜底
var _searchCache = new Map();

function _cacheKey(engine, query) { return engine + '|' + query; }

function _getCached(engine, query) {
  var hit = _searchCache.get(_cacheKey(engine, query));
  if (!hit) return null;
  var age = Date.now() - hit.ts;
  if (age < _SEARCH_CACHE_TTL) return { text: hit.text, stale: false };
  if (age < _SEARCH_CACHE_STALE && !_backendSearchHealthy) return { text: hit.text, stale: true };
  return null;
}

function _setCache(engine, query, text) {
  // 不缓存空结果 / 错误文案 / 提示语
  if (!text || text.length < 20) return;
  if (text.includes('未找到有效') || text.includes('搜索失败') || text.includes('请配置') || text.includes('请填写') || text.includes('暂不可用')) return;
  _searchCache.set(_cacheKey(engine, query), { ts: Date.now(), text: text });
  // 简单容量保护：超过 200 条时淘汰最旧一条
  if (_searchCache.size > 200) {
    var firstKey = _searchCache.keys().next().value;
    _searchCache.delete(firstKey);
  }
}

// ===== ⏰ 时效性增强：时效敏感查询的日期感知 + 短 TTL 缓存 =====
// 命中时效关键词且未自带明确日期的查询：① 自动追加当前日期，引导引擎返回最新结果；
// ② 缓存 TTL 收紧（2 分钟新鲜 / 10 分钟兜底），避免「今天的股价」命中昨天的缓存。
var _TIME_SENSITIVE_RE = /(今天|今日|现在|当前|最新|最近|近期|刚刚|新闻|快讯|头条|行情|股价|股票|大盘|涨跌|汇率|金价|油价|天气|气温|比分|赛程|本周|这周|本月|今年|明天|昨日|昨天|today|tonight|latest|recent|breaking|news|price|stock|weather|score)/i;
var _EXPLICIT_DATE_RE = /(20\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|20\d{2}[-\/.]\d{1,2})/;
var _TS_CACHE_TTL = 2 * 60 * 1000;    // 时效敏感：2 分钟新鲜缓存
var _TS_CACHE_STALE = 10 * 60 * 1000; // 时效敏感：后端不可用时最多兜底 10 分钟

function _isTimeSensitive(query) {
  return !!query && _TIME_SENSITIVE_RE.test(query) && !_EXPLICIT_DATE_RE.test(query);
}

// 为时效敏感查询追加当前日期上下文（不改变用户原始语义，仅引导搜索引擎时效排序）
function _augmentTimeSensitiveQuery(query) {
  if (!_isTimeSensitive(query)) return query;
  var now = new Date();
  var dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
  return query + ' ' + dateStr;
}

function _getCachedFresh(query) {
  // 时效敏感查询使用短 TTL，其余查询使用默认 TTL
  var sensitive = _isTimeSensitive(query);
  return {
    ttl: sensitive ? _TS_CACHE_TTL : _SEARCH_CACHE_TTL,
    stale: sensitive ? _TS_CACHE_STALE : _SEARCH_CACHE_STALE
  };
}

function _getCachedTimed(engine, query) {
  var hit = _searchCache.get(_cacheKey(engine, query));
  if (!hit) return null;
  var win = _getCachedFresh(query);
  var age = Date.now() - hit.ts;
  if (age < win.ttl) return { text: hit.text, stale: false };
  if (age < win.stale && !_backendSearchHealthy) return { text: hit.text, stale: true };
  return null;
}

// ===== 获取当前搜索引擎（自动降级：付费引擎无 Key 时回退 DuckDuckGo/Bing）=====
function getEffectiveEngine() {
  var engine = Core.config.searchEngine || 'bing';
  // 如果配置了付费引擎但没有 Key，自动回退免费引擎
  if (engine === 'bocha' && !Core.config.bochaApiKey) engine = 'bing';
  if (engine === 'tavily' && !Core.config.tavilyApiKey) engine = 'bing';
  return engine;
}

// ===== 主搜索函数：优先 IPC 直连（无需 HTTP），降级走后端代理 =====

// IPC 搜索：通过 preload 桥直接调用主进程，完全绕过 HTTP 代理
async function _searchViaIPC(query, engine) {
  try {
    var bridge = (typeof window !== 'undefined' && window.nodeBridge && window.nodeBridge.ipc) ? window.nodeBridge.ipc : null;
    if (!bridge || typeof bridge.invoke !== 'function') return null; // 非 Electron 环境
    var result = await bridge.invoke('search-execute', {
      query: query,
      engine: engine,
      apiKeys: { bochaApiKey: Core.config.bochaApiKey, tavilyApiKey: Core.config.tavilyApiKey }
    });
    if (result && result.success && result.results) {
      console.log('✅ IPC搜索成功 (' + engine + '): ' + result.results.length + ' 字符');
      return result.results;
    }
    return null; // IPC 可用但无结果，让调用方决定是否降级
  } catch (e) {
    console.warn('⚠️ IPC搜索异常:', e.message);
    return null;
  }
}

async function webSearch(query) {
  const engine = getEffectiveEngine();
  // ⏰ 时效性增强：时效敏感查询自动追加当前日期（缓存 key 也随之按天滚动失效）
  query = _augmentTimeSensitiveQuery(query);

  // P1-4: 命中新鲜缓存直接返回，降低脆弱后端压力；后端不可用时返回近期缓存兜底
  // ⏰ 时效敏感查询使用收紧的 TTL（2 分钟新鲜 / 10 分钟兜底）
  var _cached = _getCachedTimed(engine, query);
  if (_cached) {
    console.log((_cached.stale ? '♻️ 搜索服务不可达，返回近期缓存' : '⚡ 命中搜索缓存') + ' (' + engine + ')');
    return _cached.stale ? _cached.text + '\n\n（注：本地搜索服务暂不可达，以上为近期缓存结果）' : _cached.text;
  }

  // 🚀 Wave 2: 优先 IPC 直连（Electron 环境下无需 HTTP 代理）
  var ipcResult = await _searchViaIPC(query, engine);
  if (ipcResult) { _setCache(engine, query, ipcResult); return ipcResult; }
  // IPC 无结果时，对免费引擎尝试付费引擎 IPC 降级
  if (!ipcResult && (engine === 'bing' || engine === 'duckduckgo' || engine === 'searxng')) {
    if (Core.config.bochaApiKey) {
      var bochaIpc = await _searchViaIPC(query, 'bocha');
      if (bochaIpc) return bochaIpc;
    }
    if (Core.config.tavilyApiKey) {
      var tavilyIpc = await _searchViaIPC(query, 'tavily');
      if (tavilyIpc) return tavilyIpc;
    }
  }

  // 🔒 S12: 后端不可用时，超过 3 分钟自动重新探测（允许中途恢复）
  if (!_backendSearchHealthy) {
    if (_backendUnhealthySince && (Date.now() - _backendUnhealthySince > _BACKEND_RETRY_MS)) {
      console.log('🔄 重新探测本地搜索服务...');
      var recovered = await _probeSearchBackend();
      if (!recovered) {
        return await webSearchDirect(query, engine);
      }
      // 恢复成功，继续走后端代理
    } else {
      return await webSearchDirect(query, engine);
    }
  }

  try {
    const resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        engine: engine,
        apiKeys: {
          bochaApiKey: Core.config.bochaApiKey,
          tavilyApiKey: Core.config.tavilyApiKey
        }
      }),
      signal: AbortSignal.timeout(20000)
    });
    
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      console.error('❌ 后端搜索代理错误:', errData.error || resp.statusText);
      return await webSearchDirect(query, engine);
    }
    
    const data = await resp.json();
    if (data.results && typeof data.results === 'string' && data.results.trim()) {
      if (data.results.includes('no valid results') || data.results.includes('Search failed') || data.results.includes('请配置')) {
        return `关于"${query}"未找到有效的搜索结果。`;
      }
      console.log(`✅ 搜索成功 (${engine}): ${data.results.length} 字符`);
      _setCache(engine, query, data.results);
      return data.results;
    } else {
      return `关于"${query}"未找到有效的搜索结果。`;
    }
    
  } catch (err) {
    console.error('❌ 后端代理失败:', err.message);
    // 连接拒绝时标记后端不可用，避免 webSearchDirect 再次请求同一失败端口
    if (err && err.message && (err.message.includes('ECONNREFUSED') || err.message.includes('Failed to fetch'))) {
      _backendSearchHealthy = false;
      if (!_backendUnhealthySince) _backendUnhealthySince = Date.now();
    }
    let result = await webSearchDirect(query, engine);
    if ((result.includes('未找到有效') || result.includes('搜索失败') || result.includes('请填写')) && engine === 'bocha' && Core.config.tavilyApiKey) {
      console.log('🔄 博查失败，降级到 Tavily');
      result = await webSearchDirect(query, 'tavily');
    }
    return result;
  }
}

// ===== 结构化搜索：返回 {text, items:[{title,snippet,url}]} =====
async function webSearchWithMeta(query) {
  var engine = getEffectiveEngine();
  // ⏰ 时效性增强：时效敏感查询自动追加当前日期
  query = _augmentTimeSensitiveQuery(query);
  try {
    var items = [];
    switch (engine) {
      case 'bing':
        items = await searchBingStructured(query);
        break;
      case 'duckduckgo':
        items = await searchDuckDuckGoStructured(query);
        break;
      case 'tavily':
        items = await searchTavilyStructured(query);
        break;
      case 'searxng':
        items = await searchSearXNGStructured(query);
        break;
      case 'bocha':
      default:
        items = await searchBochaStructured(query);
        break;
    }
    // 付费引擎失败，降级 DuckDuckGo
    if (items.length === 0 && engine !== 'duckduckgo') {
      console.log('🔄 付费引擎无结果，降级 DuckDuckGo');
      try { items = await searchDuckDuckGoStructured(query); } catch (e2) { /* ignore */ }
    }
    // 博查降级 tavily
    if (items.length === 0 && engine === 'bocha' && Core.config.tavilyApiKey) {
      console.log('🔄 博查结构化搜索无结果，降级 Tavily');
      try { items = await searchTavilyStructured(query); } catch (e2) { /* ignore */ }
    }
    // 🔧 检索正确性：按 URL（无 URL 时按标题）去重，避免同一来源重复注入上下文污染回答
    var seenKeys = {};
    var validItems = items.filter(function(r) {
      if (!r.title) return false;
      var key = r.url ? String(r.url).replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
                      : 't:' + String(r.title).trim().toLowerCase();
      if (seenKeys[key]) return false;
      seenKeys[key] = true;
      return true;
    });
    var text = validItems.map(function(r) {
      return r.title + '\n' + r.snippet + (r.url ? '\n' + r.url : '');
    }).join('\n\n');
    if (!text) {
      text = '\u5173\u4e8e\u201c' + query + '\u201d\u672a\u627e\u5230\u6709\u6548\u7684\u641c\u7d22\u7ed3\u679c\u3002';
    }
    return { text: text, items: validItems };
  } catch (err) {
    console.error('\u274c \u7ed3\u6784\u5316\u641c\u7d22\u5931\u8d25:', err.message);
    return { text: '\u8054\u7f51\u641c\u7d22\u5931\u8d25\uff1a' + err.message, items: [] };
  }
}

// ----- Bing China 结构化（通过后端代理）-----
async function searchBingStructured(query) {
  try {
    var resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, engine: 'bing', apiKeys: {} }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      var data = await resp.json();
      if (data.results && typeof data.results === 'string' && data.results.length > 20) {
        var blocks = data.results.split('\n\n');
        return blocks.map(function(block) {
          var lines = block.split('\n');
          return { title: lines[0] || '', snippet: lines[1] || '', url: lines[2] || '' };
        }).filter(function(r) { return r.title; });
      }
    }
  } catch (e) {
    console.warn('Bing 后端搜索失败:', e.message);
  }
  return [];
}

// ----- DuckDuckGo 结构化（通过后端代理）-----
async function searchDuckDuckGoStructured(query) {
  // 优先通过后端代理
  try {
    var resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, engine: 'duckduckgo', apiKeys: {} }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      var data = await resp.json();
      if (data.results && typeof data.results === 'string' && data.results.length > 20) {
        // 解析后端返回的文本格式结果
        var blocks = data.results.split('\n\n');
        return blocks.map(function(block) {
          var lines = block.split('\n');
          return { title: lines[0] || '', snippet: lines[1] || '', url: lines[2] || '' };
        }).filter(function(r) { return r.title; });
      }
    }
  } catch (e) {
    console.warn('DuckDuckGo 后端搜索失败:', e.message);
  }
  // 降级：直接请求后端 TTS/ASR 的 Python 脚本
  return [];
}

// ----- SearXNG 结构化（通过后端代理）-----
async function searchSearXNGStructured(query) {
  try {
    var searxngBaseUrl = Core.config.searxngBaseUrl || 'https://searx.be';
    var resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, engine: 'searxng', apiKeys: { searxngBaseUrl: searxngBaseUrl } }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      var data = await resp.json();
      if (data.results && typeof data.results === 'string' && data.results.length > 20) {
        var blocks = data.results.split('\n\n');
        return blocks.map(function(block) {
          var lines = block.split('\n');
          return { title: lines[0] || '', snippet: lines[1] || '', url: lines[2] || '' };
        }).filter(function(item) { return item.title || item.snippet; });
      }
    }
  } catch (e) {
    console.warn('SearXNG 后端搜索失败:', e.message);
  }
  return [];
}

// 🔒 #27 修复：提取搜索引擎公共逻辑，消除 structured/direct 重复代码
async function _searchEngineRequest(engine, query, options) {
  options = options || {};
  switch (engine) {
    case 'bocha': {
      var apiKey = Core.config.bochaApiKey;
      if (!apiKey) throw new Error('请填写博查 API Key');
      var resp = await fetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ query: query, count: options.count || 5 }),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    }
    case 'tavily': {
      var tApiKey = Core.config.tavilyApiKey;
      if (!tApiKey) throw new Error('请填写 Tavily API Key');
      var tResp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tApiKey, query: query, max_results: options.count || 5, include_answer: true }),
        signal: AbortSignal.timeout(15000)
      });
      if (!tResp.ok) throw new Error('HTTP ' + tResp.status);
      return await tResp.json();
    }
    default:
      throw new Error('不支持的搜索引擎: ' + engine);
  }
}

function _formatBochaResults(data) {
  var rawPages = null;
  if (data.data && data.data.webPages) {
    if (data.data.webPages.value && data.data.webPages.value.length > 0) rawPages = data.data.webPages.value;
    else if (Array.isArray(data.data.webPages) && data.data.webPages.length > 0) rawPages = data.data.webPages;
  } else if (data.webPages) {
    if (data.webPages.value && data.webPages.value.length > 0) rawPages = data.webPages.value;
    else if (Array.isArray(data.webPages) && data.webPages.length > 0) rawPages = data.webPages;
  }
  if (rawPages) {
    return rawPages.map(function(p) {
      return { title: p.name || p.title || '', snippet: p.snippet || p.summary || '', url: p.url || p.link || '' };
    });
  }
  if (data.data && data.data.news && data.data.news.length > 0) {
    return data.data.news.map(function(n) { return { title: n.name || '', snippet: n.snippet || '', url: '' }; });
  }
  if (data.news && data.news.length > 0) {
    return data.news.map(function(n) { return { title: n.name || n.title || '', snippet: n.snippet || n.summary || '', url: '' }; });
  }
  return [];
}

function _formatTavilyResults(data) {
  var items = [];
  if (data.answer) items.push({ title: '搜索摘要', snippet: data.answer, url: '' });
  if (data.results && data.results.length > 0) {
    data.results.forEach(function(r) {
      items.push({ title: r.title || '', snippet: r.content || '', url: r.url || '' });
    });
  }
  return items;
}

// ----- 博查结构化 -----
async function searchBochaStructured(query) {
  // 🔒 #27: 使用公共请求函数
  var data = await _searchEngineRequest('bocha', query);
  return _formatBochaResults(data);
}

// ----- Tavily 结构化 -----
async function searchTavilyStructured(query) {
  // 🔒 #27: 使用公共请求函数
  var data = await _searchEngineRequest('tavily', query);
  return _formatTavilyResults(data);
}

// ===== 快速探测后端搜索代理是否可用 =====
async function _probeSearchBackend() {
  try {
    var base = _searchBackendBase();
    var resp = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
    _backendSearchHealthy = resp.ok;
    return _backendSearchHealthy;
  } catch (e) {
    _backendSearchHealthy = false;
    return false;
  }
}

// ===== 降级：直接请求（当后端不可用时）=====
async function webSearchDirect(query, engine) {
  console.log(`🔄 降级直接请求: ${engine}`);

  // 🔒 #4 修复：明确标注 Bing/DuckDuckGo/SearXNG 依赖后端代理，非真正直连
  if (engine === 'duckduckgo' || engine === 'bing' || engine === 'searxng') {
    await _probeSearchBackend();
    if (!_backendSearchHealthy) {
      console.warn('⚠️ [' + engine + '] 依赖后端搜索代理（非直连），代理未启动，尝试付费引擎降级');
      // 自动降级到付费引擎（如果配置了 Key）
      if (Core.config.bochaApiKey) {
        console.log('🔄 自动降级到博查搜索');
        try {
          var bochaResult = await searchBochaDirect(query);
          if (bochaResult && bochaResult.length > 20 && !bochaResult.includes('未找到有效')) return bochaResult;
        } catch (e) { console.warn('⚠️ 博查降级失败:', e.message); }
      }
      if (Core.config.tavilyApiKey) {
        console.log('🔄 自动降级到 Tavily 搜索');
        try {
          var tavilyResult = await searchTavilyDirect(query);
          if (tavilyResult && tavilyResult.length > 20 && !tavilyResult.includes('未找到有效')) return tavilyResult;
        } catch (e) { console.warn('⚠️ Tavily降级失败:', e.message); }
      }
      // 所有引擎都不可用
      return `联网搜索暂时不可用：${engine} 引擎依赖本地搜索代理（端口 ${_searchBackendBase().split(':').pop()} 无响应），且未配置可用的付费搜索 Key。\n请在设置 → 搜索引擎中配置博查或 Tavily API Key 以实现无代理搜索，或等待应用完全启动后重试。`;
    }
  }

  try {
    let results = '';
    switch (engine) {
      case 'duckduckgo':
        // DuckDuckGo 直接请求走后端 Python（前端无法直接调用）
        results = await searchDuckDuckGoDirect(query);
        break;
      case 'bing':
        // Bing China 也走后端代理
        results = await searchBingDirect(query);
        break;
      case 'tavily':
        results = await searchTavilyDirect(query);
        break;
      case 'searxng':
        results = await searchSearXNGDirect(query);
        break;
      case 'bocha':
      default:
        results = await searchBochaDirect(query);
        break;
    }
    if (results && results.length > 20 && !results.includes('未找到有效')) _setCache(engine, query, results);
    return results || `关于"${query}"未找到有效的搜索结果。`;
  } catch (err) {
    return `联网搜索失败：${err.message}`;
  }
}

// ----- DuckDuckGo 直接请求（通过后端 /api/search）-----
async function searchDuckDuckGoDirect(query) {
  try {
    var resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, engine: 'duckduckgo', apiKeys: {} }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      var data = await resp.json();
      if (data.results && typeof data.results === 'string' && data.results.length > 20) {
        return data.results;
      }
    }
  } catch (e) {
    console.warn('DuckDuckGo direct failed:', e.message);
  }
  return '';
}

// ----- Bing China 直接请求（通过后端 /api/search）-----
async function searchBingDirect(query) {
  try {
    var resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, engine: 'bing', apiKeys: {} }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      var data = await resp.json();
      if (data.results && typeof data.results === 'string' && data.results.length > 20) {
        return data.results;
      }
    }
  } catch (e) {
    console.warn('Bing direct failed:', e.message);
  }
  return '';
}

// ----- SearXNG 直接请求（通过后端代理）-----
async function searchSearXNGDirect(query) {
  try {
    var searxngBaseUrl = Core.config.searxngBaseUrl || 'https://searx.be';
    var resp = await fetch(_searchBackendBase() + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, engine: 'searxng', apiKeys: { searxngBaseUrl: searxngBaseUrl } }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      var data = await resp.json();
      if (data.results && typeof data.results === 'string' && data.results.length > 20) {
        return data.results;
      }
    }
  } catch (e) {
    console.warn('SearXNG direct failed:', e.message);
  }
  return '';
}

// ----- 博查直接请求 -----
async function searchBochaDirect(query) {
  // 🔒 #27: 使用公共请求函数 + 格式化
  var data = await _searchEngineRequest('bocha', query);
  var results = _formatBochaResults(data);
  if (results.length > 0) {
    return results.map(function(r) { return r.title + '\n' + r.snippet + '\n' + (r.url || ''); }).join('\n\n');
  }
  // 兜底：检查其他格式
  if (data.results && data.results.length > 0) {
    return data.results.map(function(r) { return (r.title || r.name) + '\n' + (r.snippet || r.summary || r.content) + '\n' + (r.url || r.link || ''); }).join('\n\n');
  }
  return '';
}

// ----- Tavily 直接请求 -----
async function searchTavilyDirect(query) {
  // 🔒 #27: 使用公共请求函数 + 格式化
  var data = await _searchEngineRequest('tavily', query);
  var results = _formatTavilyResults(data);
  if (results.length > 0) {
    return results.map(function(r) { return r.title + '\n' + r.snippet + '\n' + (r.url || ''); }).join('\n\n');
  }
  return '';
}

// ===== 更新联网按钮状态 =====
function updateWebSearchAvailability() {
  const engine = getEffectiveEngine();
  const btn = Core.dom.webSearchBtn || document.getElementById('webSearchBtn');
  if (!btn) { console.warn('⚠️ updateWebSearchAvailability: 按钮未找到'); return; }
  
  let canWebSearch = true;
  let tooltip = '点击开启联网搜索';
  
  if (engine === 'duckduckgo' || engine === 'bing') {
    canWebSearch = true; tooltip = engine === 'bing' ? 'Bing 搜索（免费）' : 'DuckDuckGo 搜索（免费）';
  } else if (engine === 'bocha' && !Core.config.bochaApiKey) {
    canWebSearch = false; tooltip = '请填写博查 API Key';
  } else if (engine === 'tavily' && !Core.config.tavilyApiKey) {
    canWebSearch = false; tooltip = '请填写 Tavily API Key';
  }
  
  btn.title = tooltip;
  Core._updatingWebSearch = true;
  
  if (!canWebSearch) {
    btn.disabled = true;
    btn.classList.remove('active');
    Core.config.webSearch = false;
    // 不在此处调用 saveConfig — 避免 configChanged → saveConfig → configChanged 递归
    // 持久化会在下次自然 saveConfig 时顺带写入
  } else if (btn.disabled) {
    btn.disabled = false;
  }
  
  setTimeout(function() { Core._updatingWebSearch = false; }, 100);
}

function toggleWebSearch() {
  if (Core.dom.webSearchBtn.disabled) return;
  Core.dom.webSearchBtn.classList.toggle('active');
  Core.config.webSearch = Core.dom.webSearchBtn.classList.contains('active');
  Core._updatingWebSearch = true;
  Core.saveConfig({ webSearch: Core.config.webSearch });
  setTimeout(function() { Core._updatingWebSearch = false; }, 100);
  
  const status = document.getElementById('status');
  if (status) {
    status.textContent = Core.config.webSearch ? '🌐 联网搜索已开启' : '🌐 联网搜索已关闭';
    setTimeout(function() { status.textContent = '✅ 已就绪'; }, 1500);
  }
}

module.exports = {
  name: 'search',
  dependencies: [],
  // 测试钩子（纯函数，不依赖 Core）
  _isTimeSensitive: _isTimeSensitive,
  _augmentTimeSensitiveQuery: _augmentTimeSensitiveQuery,
  init(_Core) {
    Core = _Core;
    
    if (!Core.config.searchEngine || Core.config.searchEngine === '') {
      Core.config.searchEngine = 'bing';
      // 启动时不触发 saveConfig — 避免 configChanged 级联，下次 saveConfig 时自然持久化
    }
    
    var btn = Core.dom.webSearchBtn || document.getElementById('webSearchBtn');
    updateWebSearchAvailability();
    
    if (btn && !btn._searchEventBound) {
      btn.addEventListener('click', toggleWebSearch);
      btn._searchEventBound = true;
    }

    if (btn && Core.config.webSearch !== undefined) {
      if (Core.config.webSearch) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    
    Core.on('configChanged', function() {
      if (Core._updatingWebSearch) return;
      updateWebSearchAvailability();
    });
    
    Core.webSearch = webSearch;
    Core.webSearchWithMeta = webSearchWithMeta;
    console.log('✅ 搜索模块已加载（Bing免费 + DuckDuckGo + 博查 + Tavily + 自动降级）');
    setTimeout(function() { Core.emit('searchReady', webSearch); }, 300);
  }
};
