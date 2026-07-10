// modules/image-search.js - 图片搜索模块（网络图片搜索 + 元数据提取）
var Core = null;
var https = require('https');
var http = require('http');
var url = require('url');

// ===== 搜索后端 =====

// 1. DuckDuckGo 图片搜索（免费、无需 API Key）
async function searchDuckDuckGo(query, options) {
  options = options || {};
  var count = options.count || 5;
  var safeSearch = options.safe !== false ? '1' : '-1';

  // DuckDuckGo Instant Answer API for images
  var token = await getDDGToken();
  if (!token) {
    // 降级到 HTML 解析
    return await searchDDGHtml(query, count, safeSearch);
  }

  var apiUrl = 'https://duckduckgo.com/i.js?l=cn-cn&o=json&q=' +
    encodeURIComponent(query) + '&vqd=' + token + '&f=,,,,,&p=' + safeSearch;

  var body = await httpGet(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  var data;
  try { data = JSON.parse(body); } catch (e) { return []; }

  var results = [];
  if (data.results) {
    for (var i = 0; i < Math.min(data.results.length, count); i++) {
      var r = data.results[i];
      results.push({
        title: r.title || '',
        imageUrl: r.image || '',
        thumbnailUrl: r.thumbnail || '',
        sourceUrl: r.url || '',
        hostname: extractHostname(r.url || ''),
        width: r.width || 0,
        height: r.height || 0,
        source: r.source || '',
      });
    }
  }
  return results;
}

async function getDDGToken() {
  try {
    var body = await httpGet('https://duckduckgo.com/?q=test&ia=images', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    var match = body.match(/vqd=['"]?(\d+-\d+-\d+)['"]?/);
    return match ? match[1] : null;
  } catch (e) { return null; }
}

async function searchDDGHtml(query, count, safeSearch) {
  try {
    var searchUrl = 'https://html.duckduckgo.com/html/?q=' +
      encodeURIComponent(query + ' image') + '&kp=' + safeSearch;
    var body = await httpGet(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    var results = [];
    // 提取结果链接
    var linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    var match;
    while ((match = linkRegex.exec(body)) && results.length < count) {
      var href = decodeURIComponent(match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0]);
      results.push({
        title: match[2].replace(/<[^>]+>/g, ''),
        imageUrl: '',
        thumbnailUrl: '',
        sourceUrl: href,
        hostname: extractHostname(href),
        width: 0, height: 0,
        source: 'duckduckgo',
      });
    }
    return results;
  } catch (e) { return []; }
}

// 2. Bing 图片搜索（需要 API Key）
async function searchBing(query, options) {
  options = options || {};
  var count = options.count || 5;
  var apiKey = options.apiKey || (Core.config && Core.config.bingSearchKey);
  if (!apiKey) throw new Error('需要 Bing Search API Key（设置面板 → 图片搜索）');

  var searchUrl = 'https://api.bing.microsoft.com/v7.0/images/search?q=' +
    encodeURIComponent(query) + '&count=' + count + '&safeSearch=Moderate';

  var body = await httpGet(searchUrl, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey }
  });

  var data;
  try { data = JSON.parse(body); } catch (e) { throw new Error('Bing 响应解析失败'); }

  var results = [];
  if (data.value) {
    for (var i = 0; i < data.value.length; i++) {
      var r = data.value[i];
      results.push({
        title: r.name || '',
        imageUrl: r.contentUrl || '',
        thumbnailUrl: r.thumbnailUrl || '',
        sourceUrl: r.hostPageUrl || '',
        hostname: extractHostname(r.hostPageUrl || ''),
        width: r.width || 0,
        height: r.height || 0,
        source: 'bing',
      });
    }
  }
  return results;
}

// 3. Unsplash 图片搜索（免费高质量图库）
async function searchUnsplash(query, options) {
  options = options || {};
  var count = options.count || 5;
  var accessKey = options.apiKey || (Core.config && Core.config.unsplashKey);

  if (!accessKey) {
    // 无 API Key 时使用 Source API（随机图片）
    return [{
      title: query + ' (Unsplash Source)',
      imageUrl: 'https://source.unsplash.com/1600x900/?' + encodeURIComponent(query),
      thumbnailUrl: 'https://source.unsplash.com/400x300/?' + encodeURIComponent(query),
      sourceUrl: 'https://unsplash.com/s/photos/' + encodeURIComponent(query),
      hostname: 'unsplash.com',
      width: 1600, height: 900,
      source: 'unsplash-source',
    }];
  }

  var searchUrl = 'https://api.unsplash.com/search/photos?query=' +
    encodeURIComponent(query) + '&per_page=' + count;

  var body = await httpGet(searchUrl, {
    headers: { 'Authorization': 'Client-ID ' + accessKey }
  });

  var data;
  try { data = JSON.parse(body); } catch (e) { throw new Error('Unsplash 响应解析失败'); }

  var results = [];
  if (data.results) {
    for (var i = 0; i < data.results.length; i++) {
      var r = data.results[i];
      results.push({
        title: r.alt_description || r.description || query,
        imageUrl: r.urls.regular || r.urls.full,
        thumbnailUrl: r.urls.small || r.urls.thumb,
        sourceUrl: r.links.html,
        hostname: 'unsplash.com',
        width: r.width || 0,
        height: r.height || 0,
        source: 'unsplash',
        photographer: r.user ? r.user.name : '',
      });
    }
  }
  return results;
}

// ===== 统一搜索接口 =====

async function searchImages(query, options) {
  options = options || {};
  var provider = options.provider || Core.config.imageSearchProvider || 'duckduckgo';
  var count = options.count || 5;

  console.log('🔍 图片搜索: provider=' + provider + ', query="' + query + '"');

  try {
    switch (provider) {
      case 'duckduckgo': return await searchDuckDuckGo(query, { count: count });
      case 'bing': return await searchBing(query, { count: count, apiKey: options.apiKey });
      case 'unsplash': return await searchUnsplash(query, { count: count, apiKey: options.apiKey });
      default: return await searchDuckDuckGo(query, { count: count });
    }
  } catch (e) {
    console.warn('⚠️ 图片搜索失败 (' + provider + '):', e.message);
    // 降级到 DuckDuckGo
    if (provider !== 'duckduckgo') {
      try { return await searchDuckDuckGo(query, { count: count }); } catch (e2) {}
    }
    return [];
  }
}

// ===== 图片下载 =====

async function downloadImage(imageUrl, destPath) {
  var fs = require('fs');
  var path = require('path');

  if (!imageUrl) throw new Error('图片 URL 为空');
  if (!destPath) throw new Error('目标路径为空');

  var dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return new Promise(function (resolve, reject) {
    var parsedUrl = url.parse(imageUrl);
    var client = parsedUrl.protocol === 'https:' ? https : http;

    var req = client.get(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 30000,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var buffer = Buffer.concat(chunks);
        fs.writeFileSync(destPath, buffer);
        resolve({
          success: true,
          path: destPath,
          size: buffer.length,
          contentType: res.headers['content-type'] || '',
        });
      });
    });

    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error('下载超时')); });
  });
}

// ===== 工具函数 =====

function extractHostname(urlStr) {
  try {
    var parsed = url.parse(urlStr);
    return parsed.hostname || '';
  } catch (e) { return ''; }
}

function httpGet(urlStr, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var parsedUrl = url.parse(urlStr);
    var client = parsedUrl.protocol === 'https:' ? https : http;

    var req = client.get(urlStr, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
      }, options.headers || {}),
      timeout: 15000,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, options).then(resolve).catch(reject);
        return;
      }
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    });

    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error('请求超时')); });
  });
}

// ===== 格式化输出 =====

function formatResults(results) {
  if (!results || results.length === 0) return '未找到图片';
  return results.map(function (r, i) {
    var dims = (r.width && r.height) ? ' (' + r.width + '×' + r.height + ')' : '';
    return (i + 1) + '. ' + (r.title || '无标题') + dims + '\n' +
      '   🔗 ' + (r.imageUrl || r.sourceUrl) + '\n' +
      '   📍 ' + r.hostname;
  }).join('\n\n');
}

// ===== Agent 工具注册 =====

function registerAgentTools() {
  if (!Core.mcp || !Core.mcp.registerTool) return;

  Core.mcp.registerTool('image_search', {
    description: '搜索网络图片。返回图片 URL、缩略图、来源等信息。支持 DuckDuckGo（免费）、Bing（需 API Key）、Unsplash（高质量图库）。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        provider: { type: 'string', enum: ['duckduckgo', 'bing', 'unsplash'], description: '搜索引擎，默认 duckduckgo' },
        count: { type: 'number', description: '返回结果数量，默认 5' },
      },
      required: ['query'],
    },
    handler: async function (args) {
      try {
        var results = await searchImages(args.query, {
          provider: args.provider,
          count: args.count || 5,
        });
        if (results.length === 0) return { success: false, error: '未找到图片' };
        return { success: true, count: results.length, results: results };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  });

  Core.mcp.registerTool('image_download', {
    description: '下载网络图片到本地文件。',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片 URL' },
        dest: { type: 'string', description: '目标文件路径' },
      },
      required: ['url', 'dest'],
    },
    handler: async function (args) {
      try {
        return await downloadImage(args.url, args.dest);
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  });
}

// ===== 命令处理 =====

function handleCommand(args) {
  var parts = args.trim().split(/\s+/);
  var cmd = parts[0] || 'help';

  switch (cmd) {
    case 'search':
    case 's':
      var query = parts.slice(1).join(' ');
      if (!query) return '用法: /img search <关键词>';
      return searchImages(query, { count: 5 }).then(function (results) {
        return '🔍 图片搜索结果 (' + results.length + ' 条):\n\n' + formatResults(results);
      });

    case 'download':
    case 'dl':
      if (parts.length < 3) return '用法: /img download <URL> <目标路径>';
      return downloadImage(parts[1], parts.slice(2).join(' ')).then(function (r) {
        return r.success ? '✅ 图片已下载: ' + r.path + ' (' + (r.size / 1024).toFixed(1) + ' KB)' :
          '❌ 下载失败: ' + r.error;
      });

    case 'provider':
      if (parts[1]) {
        if (Core.config) Core.config.imageSearchProvider = parts[1];
        return '✅ 搜索引擎已切换: ' + parts[1];
      }
      return '当前搜索引擎: ' + (Core.config.imageSearchProvider || 'duckduckgo') +
        '\n可选: duckduckgo, bing, unsplash';

    default:
      return '🔍 图片搜索命令\n' +
        '/img search <关键词> — 搜索图片\n' +
        '/img download <URL> <路径> — 下载图片\n' +
        '/img provider [duckduckgo|bing|unsplash] — 设置搜索引擎';
  }
}

// ===== 模块导出 =====

module.exports = {
  name: 'image-search',
  dependencies: ['routing'],
  init(_Core) {
    Core = _Core;
    Core.imageSearch = {
      search: searchImages,
      download: downloadImage,
      formatResults: formatResults,
    };

    // 注册 Agent 工具
    setTimeout(registerAgentTools, 1000);

    // 注册命令
    if (Core.routing && Core.routing.register) {
      Core.routing.register('/img', handleCommand, '图片搜索（DuckDuckGo/Bing/Unsplash）');
    }

    console.log('✅ Image-Search 模块已加载（DuckDuckGo/Bing/Unsplash）');
  }
};
