// modules/crawl-service.js - 统一网页爬取与内容清洗服务
// 解决 P-02(无JS渲染) + P-06(无递归爬取) + P-07(无内容清洗)
// 架构：Playwright 渲染 → 正文评分提取 → 结构化输出 → 可选 LLM 摘要 → 知识库入库
let Core = null;

// 🔧 M8: callAPI 返回 { message: { content } }（或 OpenAI choices 形状），统一提取纯文本
function _textOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (r.content) return r.content;
  if (r.message && r.message.content) return r.message.content;
  if (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) return r.choices[0].message.content;
  return '';
}

// ===== 配置 =====
var DEFAULT_OPTIONS = {
  maxDepth: 2,          // 最大爬取深度
  maxPages: 10,         // 最大页面数
  rateLimitMs: 1000,    // 请求间隔（毫秒）
  maxLength: 30000,     // 单页最大字符数
  sameDomainOnly: true, // 仅同域名
  summarize: false,     // 是否 LLM 摘要
  saveToKnowledge: false, // 是否自动入知识库
  timeout: 25000        // 单页超时
};

// ===== 正文提取脚本（在 Playwright page.evaluate 中执行）=====
// 基于 DOM 评分的 Readability 简化版：对每个块级元素评分，取最高分子树
var EXTRACT_SCRIPT = `() => {
  // 移除无用元素
  var removeTags = ['script','style','noscript','nav','footer','header','aside','iframe','svg'];
  removeTags.forEach(tag => {
    document.querySelectorAll(tag).forEach(el => el.remove());
  });
  // 移除隐藏元素和广告类
  document.querySelectorAll('[style*="display:none"],[style*="display: none"],[hidden],.ad,.ads,.advertisement,.sidebar,.nav,.menu,.footer,.header,.cookie,.popup,.modal').forEach(el => el.remove());

  // 评分：对每个 p/div/article/section/main 计算文本密度
  var candidates = document.querySelectorAll('p, div, article, section, main, td');
  var best = null, bestScore = 0;
  candidates.forEach(el => {
    var text = el.innerText || '';
    var textLen = text.trim().length;
    if (textLen < 50) return;
    // 文本密度 = 文本长度 / 标签数
    var tags = el.querySelectorAll('*').length || 1;
    var density = textLen / tags;
    // 加分：含有关键词的元素
    var bonus = 0;
    var cls = (el.className || '') + ' ' + (el.id || '');
    if (/article|content|main|body|post|text|entry/i.test(cls)) bonus += 30;
    if (/comment|sidebar|widget|related|recommend/i.test(cls)) bonus -= 50;
    // 段落数加分
    var paras = el.querySelectorAll('p').length;
    bonus += Math.min(paras * 3, 30);
    var score = density + bonus + Math.min(textLen / 100, 20);
    if (score > bestScore) { bestScore = score; best = el; }
  });

  if (!best) return { title: document.title, content: document.body.innerText.substring(0, 30000), links: [] };

  // 提取正文
  var content = best.innerText.trim();
  // 提取标题
  var title = document.title || '';
  var h1 = document.querySelector('h1');
  if (h1 && h1.innerText.trim().length > 3) title = h1.innerText.trim();
  // 提取 meta
  var metaDesc = '';
  var md = document.querySelector('meta[name="description"]');
  if (md) metaDesc = md.getAttribute('content') || '';
  var author = '';
  var ma = document.querySelector('meta[name="author"],[rel="author"]');
  if (ma) author = ma.getAttribute('content') || ma.innerText || '';
  var date = '';
  var md2 = document.querySelector('meta[property="article:published_time"],time[datetime]');
  if (md2) date = md2.getAttribute('content') || md2.getAttribute('datetime') || '';
  // 提取链接（同域）
  var links = [];
  var origin = location.origin;
  document.querySelectorAll('a[href]').forEach(a => {
    var href = a.href;
    if (href && href.startsWith(origin) && !href.includes('#') && href !== location.href) {
      var text = (a.innerText || '').trim().substring(0, 80);
      if (text.length > 2) links.push({ url: href, text: text });
    }
  });
  // 去重链接
  var seen = {};
  links = links.filter(l => { if (seen[l.url]) return false; seen[l.url] = true; return true; }).slice(0, 50);

  return { title: title, content: content.substring(0, 30000), meta: { description: metaDesc, author: author, date: date }, links: links };
}`;

// ===== 单页抓取（Playwright 渲染 + 正文提取）=====
async function fetch(url, options) {
  options = Object.assign({}, DEFAULT_OPTIONS, options || {});
  var startTime = Date.now();

  // 优先 Playwright 渲染
  if (Core.browserPro && typeof Core.browserPro.navigate === 'function') {
    try {
      var navResult = await Core.browserPro.navigate(url, { page: 'crawl', timeout: options.timeout, waitUntil: 'domcontentloaded' });
      if (navResult && navResult.success) {
        // 等待动态内容加载
        await new Promise(r => setTimeout(r, 1500));
        var extractResult = await Core.browserPro.evaluate(EXTRACT_SCRIPT, { page: 'crawl' });
        if (extractResult && extractResult.success && extractResult.result && extractResult.result.content) {
          var data = extractResult.result;
          return {
            success: true,
            url: url,
            title: data.title || '',
            content: (data.content || '').substring(0, options.maxLength),
            meta: data.meta || {},
            links: data.links || [],
            method: 'playwright',
            duration: Date.now() - startTime
          };
        }
      }
    } catch (e) {
      console.warn('⚠️ [crawl] Playwright 抓取失败:', e.message);
    }
  }

  // 回退：基础 HTTP（通过 tools.js read_url）
  if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
    try {
      var result = await Core.toolsRegistry.executeTool('read_url', { url: url, max_length: options.maxLength });
      if (result && result.indexOf('\u274c') === -1) {
        var text = result.replace(/^\ud83c\udf10 网页内容: [^\n]+\n\n/, '');
        return {
          success: true,
          url: url,
          title: '',
          content: text.substring(0, options.maxLength),
          meta: {},
          links: [],
          method: 'http-basic',
          duration: Date.now() - startTime
        };
      }
    } catch (e) {
      console.warn('⚠️ [crawl] HTTP 抓取失败:', e.message);
    }
  }

  return { success: false, url: url, error: '所有抓取方式均失败', duration: Date.now() - startTime };
}

// ===== 递归爬取（BFS，带深度/页数/域名限制）=====
async function crawl(startUrl, options) {
  options = Object.assign({}, DEFAULT_OPTIONS, options || {});
  var startTime = Date.now();
  var startOrigin = '';
  try { startOrigin = new URL(startUrl).origin; } catch (e) {
    return { success: false, error: '无效 URL: ' + startUrl, pages: [] };
  }

  var visited = {};       // URL 去重
  var queue = [{ url: startUrl, depth: 0 }];
  var pages = [];
  var errors = [];

  while (queue.length > 0 && pages.length < options.maxPages) {
    var item = queue.shift();
    if (visited[item.url]) continue;
    visited[item.url] = true;

    // 域名限制
    if (options.sameDomainOnly) {
      try {
        var itemOrigin = new URL(item.url).origin;
        if (itemOrigin !== startOrigin) continue;
      } catch (e) { continue; }
    }

    // 抓取
    var result = await fetch(item.url, options);
    if (result.success) {
      pages.push(result);
      // 收集子链接（深度未超限时）
      if (item.depth < options.maxDepth && result.links) {
        result.links.forEach(function(link) {
          if (!visited[link.url] && queue.length < options.maxPages * 2) {
            queue.push({ url: link.url, depth: item.depth + 1 });
          }
        });
      }
    } else {
      errors.push({ url: item.url, error: result.error });
    }

    // 速率限制
    if (queue.length > 0 && pages.length < options.maxPages) {
      await new Promise(r => setTimeout(r, options.rateLimitMs));
    }
  }

  // 可选：LLM 摘要
  if (options.summarize && pages.length > 0 && Core.api && Core.api.callAPI) {
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].content.length > 3000) {
        try {
          var summary = _textOf(await Core.api.callAPI(
            '请用3-5句话概括以下网页的核心内容，保留关键数据和事实：\n\n' + pages[i].content.substring(0, 8000),
            '你是一个内容摘要专家，输出简洁准确的中文摘要。',
            0.3, null, null, null, { disableTools: true }
          ));
          if (summary && summary.length > 20) pages[i].summary = summary;
        } catch (e) { /* 摘要失败不影响主流程 */ }
      }
    }
  }

  // 可选：自动入知识库
  if (options.saveToKnowledge && pages.length > 0 && Core.knowledge) {
    var savedCount = 0;
    for (var j = 0; j < pages.length; j++) {
      var pg = pages[j];
      if (pg.content && pg.content.length > 200) {
        try {
          var docContent = '# ' + (pg.title || pg.url) + '\n\n来源: ' + pg.url + '\n\n' + pg.content;
          await Core.knowledge.uploadDocument({
            content: docContent,
            fileName: (pg.title || 'crawl_' + Date.now()).substring(0, 50).replace(/[\\/:*?"<>|]/g, '_') + '.md'
          });
          savedCount++;
        } catch (e) { console.warn('⚠️ [crawl] 知识库保存失败:', e.message); }
      }
    }
    if (savedCount > 0) console.log('✅ [crawl] ' + savedCount + ' 页已存入知识库');
  }

  return {
    success: true,
    startUrl: startUrl,
    totalPages: pages.length,
    errors: errors.length,
    pages: pages,
    duration: Date.now() - startTime
  };
}

// ===== 智能抓取（单页 + 自动摘要，供 agent 工具调用）=====
async function smartFetch(url, options) {
  options = Object.assign({ summarize: true, maxLength: 20000 }, options || {});
  var result = await fetch(url, options);
  if (!result.success) return '❌ 抓取失败: ' + (result.error || '未知错误') + ' (' + url + ')';

  var output = '📄 ' + (result.title || url) + '\n';
  output += '来源: ' + url + '\n';
  output += '方式: ' + result.method + ' | 耗时: ' + result.duration + 'ms\n';
  if (result.meta.date) output += '发布: ' + result.meta.date + '\n';
  if (result.meta.author) output += '作者: ' + result.meta.author + '\n';
  output += '\n---\n\n';
  output += result.content;

  // LLM 摘要（长文）
  if (result.content.length > 5000 && Core.api && Core.api.callAPI) {
    try {
      var summary = _textOf(await Core.api.callAPI(
        '请用3-5句话概括以下内容的核心要点：\n\n' + result.content.substring(0, 10000),
        '你是内容分析专家，输出简洁准确的中文摘要，保留关键数据。',
        0.3, null, null, null, { disableTools: true }
      ));
      if (summary && summary.length > 20) {
        output = '📋 摘要: ' + summary + '\n\n---\n\n' + output;
      }
    } catch (e) { /* 摘要失败不影响 */ }
  }

  return output;
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;

  Core.crawlService = {
    fetch: fetch,
    crawl: crawl,
    smartFetch: smartFetch
  };

  console.log('✅ crawl-service.js 已加载 | Playwright 渲染 + 正文评分 + 递归爬取 + 知识闭环');
}

module.exports = {
  name: 'crawl-service',
  dependencies: ['tools', 'browser-pro'],
  init: init
};
