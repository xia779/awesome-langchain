// modules/search.js (后端代理版 - 支持 DuckDuckGo + 博查 + Tavily)
// 🔧 DuckDuckGo 为默认免费引擎（无需 API Key），博查/Tavily 为付费增强选项
let Core = null;

// ===== 获取当前搜索引擎（自动降级：付费引擎无 Key 时回退 DuckDuckGo/Bing）=====
function getEffectiveEngine() {
  var engine = Core.config.searchEngine || 'bing';
  // 如果配置了付费引擎但没有 Key，自动回退免费引擎
  if (engine === 'bocha' && !Core.config.bochaApiKey) engine = 'bing';
  if (engine === 'tavily' && !Core.config.tavilyApiKey) engine = 'bing';
  return engine;
}

// ===== 主搜索函数：优先走后端代理，降级直接请求 =====
async function webSearch(query) {
  const engine = getEffectiveEngine();
  console.log(`🔍 搜索代理: engine=${engine}, query="${query}"`);

  try {
    const resp = await fetch('http://127.0.0.1:8080/api/search', {
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
        console.log(`⚠️ 搜索返回提示信息: ${data.results.length} 字符`);
        return `关于"${query}"未找到有效的搜索结果。`;
      }
      console.log(`✅ 搜索成功 (${engine}): ${data.results.length} 字符`);
      return data.results;
    } else {
      console.log('⚠️ 搜索结果为空');
      return `关于"${query}"未找到有效的搜索结果。`;
    }
    
  } catch (err) {
    console.error('❌ 后端代理失败:', err.message);
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
  console.log('🔍 结构化搜索: engine=' + engine + ', query="' + query + '"');
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
    var validItems = items.filter(function(r) { return r.title; });
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
    var resp = await fetch('http://127.0.0.1:8080/api/search', {
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
    var resp = await fetch('http://127.0.0.1:8080/api/search', {
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

// ----- 博查结构化 -----
async function searchBochaStructured(query) {
  var apiKey = Core.config.bochaApiKey;
  if (!apiKey) throw new Error('\u8bf7\u586b\u5199\u535a\u67e5 API Key');
  var resp = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ query: query, count: 5 }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var data = await resp.json();
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
  // 新闻兜底
  if (data.data && data.data.news && data.data.news.length > 0) {
    return data.data.news.map(function(n) { return { title: n.name || '', snippet: n.snippet || '', url: '' }; });
  }
  if (data.news && data.news.length > 0) {
    return data.news.map(function(n) { return { title: n.name || n.title || '', snippet: n.snippet || n.summary || '', url: '' }; });
  }
  return [];
}

// ----- Tavily 结构化 -----
async function searchTavilyStructured(query) {
  var apiKey = Core.config.tavilyApiKey;
  if (!apiKey) throw new Error('\u8bf7\u586b\u5199 Tavily API Key');
  var resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query: query, max_results: 5, include_answer: true }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var data = await resp.json();
  var items = [];
  if (data.answer) {
    items.push({ title: '\u641c\u7d22\u6458\u8981', snippet: data.answer, url: '' });
  }
  if (data.results && data.results.length > 0) {
    data.results.forEach(function(r) {
      items.push({ title: r.title || '', snippet: r.content || '', url: r.url || '' });
    });
  }
  return items;
}

// ===== 降级：直接请求（当后端不可用时）=====
async function webSearchDirect(query, engine) {
  console.log(`🔄 降级直接请求: ${engine}`);
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
      case 'bocha':
      default:
        results = await searchBochaDirect(query);
        break;
    }
    return results || `关于"${query}"未找到有效的搜索结果。`;
  } catch (err) {
    return `联网搜索失败：${err.message}`;
  }
}

// ----- DuckDuckGo 直接请求（通过后端 /api/search）-----
async function searchDuckDuckGoDirect(query) {
  try {
    var resp = await fetch('http://127.0.0.1:8080/api/search', {
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
    var resp = await fetch('http://127.0.0.1:8080/api/search', {
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

// ----- 博查直接请求 -----
async function searchBochaDirect(query) {
  const apiKey = Core.config.bochaApiKey;
  if (!apiKey) throw new Error('请填写博查 API Key');
  const resp = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: 5 }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.data && data.data.webPages && data.data.webPages.value && data.data.webPages.value.length > 0) {
    return data.data.webPages.value.map(p => `${p.name}\n${p.snippet}\n${p.url || ''}`).join('\n\n');
  } else if (data.data && data.data.webPages && Array.isArray(data.data.webPages) && data.data.webPages.length > 0) {
    return data.data.webPages.map(p => `${p.name}\n${p.snippet}\n${p.url || ''}`).join('\n\n');
  } else if (data.data && data.data.news && data.data.news.length > 0) {
    return data.data.news.map(n => `${n.name}\n${n.snippet}`).join('\n\n');
  } else if (data.webPages && data.webPages.value && data.webPages.value.length > 0) {
    return data.webPages.value.map(p => `${p.name || p.title}\n${p.snippet || p.summary}\n${p.url || p.link || ''}`).join('\n\n');
  } else if (data.webPages && Array.isArray(data.webPages) && data.webPages.length > 0) {
    return data.webPages.map(p => `${p.name || p.title}\n${p.snippet || p.summary}\n${p.url || p.link || ''}`).join('\n\n');
  } else if (data.news && data.news.length > 0) {
    return data.news.map(n => `${n.name || n.title}\n${n.snippet || n.summary}`).join('\n\n');
  } else if (data.results && data.results.length > 0) {
    return data.results.map(r => `${r.title || r.name}\n${r.snippet || r.summary || r.content}\n${r.url || r.link || ''}`).join('\n\n');
  }
  return '';
}

// ----- Tavily 直接请求 -----
async function searchTavilyDirect(query) {
  const apiKey = Core.config.tavilyApiKey;
  if (!apiKey) throw new Error('请填写 Tavily API Key');
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query: query, max_results: 5, include_answer: true }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  let results = '';
  if (data.answer) results = `摘要：${data.answer}\n\n`;
  if (data.results && data.results.length > 0) {
    results += data.results.map(r => `${r.title}\n${r.content}\n${r.url || ''}`).join('\n\n');
  }
  return results;
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
    Core.saveConfig({ webSearch: false });
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
  init(_Core) {
    Core = _Core;
    console.log('🌐 search.js init 开始...');
    
    if (!Core.config.searchEngine || Core.config.searchEngine === '') {
      Core.config.searchEngine = 'bing';
      Core.saveConfig({ searchEngine: 'bing' });
    }
    console.log('🌐 当前搜索引擎:', getEffectiveEngine(), '(配置:', Core.config.searchEngine + ')');
    
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
