// modules/deep-research.js - Deep Research 编排器（多步研究 + 并行检索 + 带引用报告）
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 配置 =====
const DEFAULT_CONFIG = {
  maxSubQuestions: 5,      // 最多拆解子问题数
  maxSourcesPerQuery: 6,   // 每个子问题最多保留来源数
  maxReadPages: 10,        // 最多深度阅读页面数
  maxReportLength: 8000,   // 报告最大字符数
  searchTimeout: 20000,    // 搜索超时 ms
  readTimeout: 15000,      // 页面读取超时 ms
  useKnowledgeBase: true,  // 是否同时检索本地知识库
  outputFormat: 'markdown' // markdown | word | pdf
};

// ===== 研究状态追踪 =====
let _activeResearch = null;

function getConfig() {
  var cfg = Object.assign({}, DEFAULT_CONFIG);
  if (Core && Core.config && Core.config.deepResearch) {
    Object.assign(cfg, Core.config.deepResearch);
  }
  return cfg;
}

// ===== 主入口：启动深度研究 =====
async function startResearch(topic, options) {
  if (!topic || !topic.trim()) {
    return { success: false, error: '研究主题不能为空' };
  }

  var cfg = getConfig();
  var opts = Object.assign({}, cfg, options || {});
  var onProgress = opts.onProgress || function() {};

  // 防止并发研究
  if (_activeResearch && _activeResearch.status === 'running') {
    return { success: false, error: '已有研究任务正在进行中，请等待完成' };
  }

  var research = {
    id: 'research_' + Date.now().toString(36),
    topic: topic.trim(),
    status: 'running',
    phase: 'planning',
    progress: 0,
    subQuestions: [],
    sources: [],
    report: null,
    startedAt: Date.now(),
    completedAt: null,
    error: null
  };
  _activeResearch = research;

  try {
    // Phase 1: 问题拆解
    onProgress({ phase: 'planning', progress: 5, message: '正在分析研究主题，拆解子问题...' });
    var plan = await _planResearch(topic, opts);
    research.subQuestions = plan.subQuestions;
    research.plan = plan;
    onProgress({ phase: 'planning', progress: 15, message: '已拆解为 ' + plan.subQuestions.length + ' 个子问题' });

    // Phase 2: 并行检索
    onProgress({ phase: 'searching', progress: 20, message: '正在并行检索 ' + plan.subQuestions.length + ' 个子问题...' });
    research.phase = 'searching';
    var searchResults = await _parallelSearch(plan.subQuestions, opts, onProgress);
    research.sources = searchResults.sources;
    onProgress({ phase: 'searching', progress: 50, message: '检索完成，收集到 ' + searchResults.sources.length + ' 个来源' });

    // Phase 3: 深度阅读（Top N 页面）
    onProgress({ phase: 'reading', progress: 55, message: '正在深度阅读重点来源...' });
    research.phase = 'reading';
    var readResults = await _deepRead(searchResults.sources, opts, onProgress);
    research.deepContent = readResults;
    onProgress({ phase: 'reading', progress: 70, message: '已阅读 ' + readResults.length + ' 个页面' });

    // Phase 4: 综合撰写报告
    onProgress({ phase: 'writing', progress: 75, message: '正在综合分析并撰写报告...' });
    research.phase = 'writing';
    var report = await _synthesizeReport(topic, plan, searchResults, readResults, opts);
    research.report = report;
    onProgress({ phase: 'writing', progress: 90, message: '报告撰写完成，正在保存...' });

    // Phase 5: 输出交付物
    research.phase = 'output';
    var output = await _saveOutput(topic, report, opts);
    research.output = output;
    research.status = 'done';
    research.completedAt = Date.now();
    research.progress = 100;
    onProgress({ phase: 'done', progress: 100, message: '研究完成！' });

    return {
      success: true,
      id: research.id,
      topic: topic,
      report: report.markdown,
      sources: searchResults.sources.length,
      subQuestions: plan.subQuestions.length,
      pagesRead: readResults.length,
      duration: research.completedAt - research.startedAt,
      output: output
    };

  } catch (e) {
    research.status = 'error';
    research.error = e.message;
    research.completedAt = Date.now();
    onProgress({ phase: 'error', progress: research.progress, message: '研究失败: ' + e.message });
    return { success: false, error: e.message, id: research.id };
  }
}

// ===== Phase 1: 问题拆解 =====
async function _planResearch(topic, opts) {
  var systemMsg = '你是一个研究规划专家。用户给你一个研究主题，你需要将其拆解为3-' + opts.maxSubQuestions + '个可独立检索的子问题。\n' +
    '要求：\n' +
    '1. 子问题应覆盖主题的不同维度（背景、现状、数据、对比、趋势、风险等）\n' +
    '2. 每个子问题应具体、可搜索，避免过于宽泛\n' +
    '3. 子问题之间尽量不重叠\n' +
    '4. 同时给出3-5个推荐搜索关键词（中英文混合）\n\n' +
    '严格以JSON格式回复：\n' +
    '{"subQuestions": ["子问题1", "子问题2", ...], "keywords": ["关键词1", "关键词2", ...], "researchAngle": "一句话描述研究角度"}';

  var result = await Core.api.callAPI(
    '研究主题：' + topic,
    systemMsg,
    0.3,
    null, null,
    [{ role: 'system', content: systemMsg }, { role: 'user', content: '研究主题：' + topic + '\n\n请拆解子问题。' }],
    { disableTools: true, _background: true }
  );

  var content = (result && result.message && result.message.content) || '';
  var parsed = _extractJSON(content);

  if (!parsed || !parsed.subQuestions || !Array.isArray(parsed.subQuestions)) {
    // Fallback: 直接用主题作为单一查询
    return {
      subQuestions: [topic],
      keywords: [topic],
      researchAngle: '综合研究'
    };
  }

  // 限制子问题数量
  parsed.subQuestions = parsed.subQuestions.slice(0, opts.maxSubQuestions);
  parsed.keywords = (parsed.keywords || []).slice(0, 8);
  parsed.researchAngle = parsed.researchAngle || '综合研究';

  return parsed;
}

// ===== 来源重排序（词重叠 rerank + 时效加权）=====
function _rankSources(sources, queries) {
  var nowYear = new Date().getFullYear();
  sources.forEach(function(s) {
    var text = ((s.title || '') + ' ' + (s.snippet || '') + ' ' + (s.url || '') + ' ' + (s.query || '')).toLowerCase();
    var score = 0;
    queries.forEach(function(q) {
      var terms = String(q).toLowerCase().split(/\s+/).filter(function(t) { return t.length > 1; });
      terms.forEach(function(t) {
        if (text.indexOf(t) !== -1) {
          // 词边界命中加权（前后有空格或位于开头）
          var boundary = (text.indexOf(' ' + t + ' ') !== -1) || text.indexOf(t + ' ') === 0 || text.lastIndexOf(' ' + t) === text.length - (' ' + t).length;
          score += boundary ? 2 : 1;
        }
      });
    });
    // 时效加权：近三年年份命中（当年最高）
    for (var y = 0; y < 3; y++) {
      var yr = String(nowYear - y);
      if (text.indexOf(yr) !== -1) score += (3 - y) * 1.5;
    }
    s._rankScore = score;
    // 回写用于下游（如深度阅读的优选顺序）
    if (typeof s.relevanceScore === 'number') s.relevanceScore = score;
  });
  sources.sort(function(a, b) {
    if (a.isLocal && !b.isLocal) return -1;
    if (!a.isLocal && b.isLocal) return 1;
    return (b._rankScore || 0) - (a._rankScore || 0);
  });
  return sources;
}

// ===== Phase 2: 并行检索 =====
async function _parallelSearch(subQuestions, opts, onProgress) {
  var allSources = [];
  var seenUrls = {};
  var completed = 0;

  // 并行搜索所有子问题
  var searchPromises = subQuestions.map(function(q, idx) {
    return _searchOneQuestion(q, idx, opts).then(function(results) {
      completed++;
      if (onProgress) {
        onProgress({ phase: 'searching', progress: 20 + Math.floor(30 * completed / subQuestions.length), message: '检索进度: ' + completed + '/' + subQuestions.length });
      }
      return results;
    });
  });

  var results = await Promise.all(searchPromises);

  // 合并去重
  results.forEach(function(r) {
    (r.items || []).forEach(function(item) {
      if (item.url && !seenUrls[item.url]) {
        seenUrls[item.url] = true;
        allSources.push({
          title: item.title || '',
          url: item.url,
          snippet: item.snippet || '',
          query: r.query,
          relevanceScore: 0
        });
      }
    });
  });

  // 知识库检索补充
  if (opts.useKnowledgeBase && Core.knowledge && Core.knowledge.searchWithCitations) {
    try {
      var kbResult = Core.knowledge.searchWithCitations(subQuestions.join(' '), 5);
      if (kbResult && kbResult.results && kbResult.results.length > 0) {
        kbResult.results.forEach(function(kb) {
          allSources.push({
            title: kb.fileName || '本地知识库',
            url: 'knowledge://' + (kb.docId || 'local'),
            snippet: (kb.text || '').substring(0, 200),
            query: '本地知识库',
            relevanceScore: kb.score || 0,
            isLocal: true,
            fullText: kb.text
          });
        });
      }
    } catch (e) {
      console.warn('Deep Research: 知识库检索失败', e.message);
    }
  }

  // 按相关性排序（本地知识优先 + 词重叠 rerank + 时效加权）
  allSources = _rankSources(allSources, subQuestions);

  // 限制总数
  allSources = allSources.slice(0, opts.maxSourcesPerQuery * subQuestions.length);

  return { sources: allSources };
}

async function _searchOneQuestion(query, idx, opts) {
  try {
    if (Core.webSearchWithMeta) {
      var result = await Core.webSearchWithMeta(query);
      return { query: query, items: (result && result.items) || [] };
    } else if (Core.webSearch) {
      var text = await Core.webSearch(query);
      var items = _parseSearchText(text);
      return { query: query, items: items };
    }
    return { query: query, items: [] };
  } catch (e) {
    console.warn('Deep Research: 搜索失败 [' + query + ']', e.message);
    return { query: query, items: [] };
  }
}

function _parseSearchText(text) {
  if (!text) return [];
  var blocks = text.split(/\n\n+/);
  var items = [];
  blocks.forEach(function(block) {
    var lines = block.trim().split('\n');
    if (lines.length >= 2) {
      var title = lines[0] || '';
      var url = '';
      var snippet = '';
      for (var i = 1; i < lines.length; i++) {
        if (lines[i].match(/^https?:\/\//)) { url = lines[i].trim(); }
        else { snippet += lines[i].trim() + ' '; }
      }
      if (title && url) {
        items.push({ title: title, url: url, snippet: snippet.trim().substring(0, 300) });
      }
    }
  });
  return items;
}

// ===== Phase 3: 深度阅读 =====
async function _deepRead(sources, opts, onProgress) {
  // 选择要深度阅读的页面（排除本地知识、优先有 snippet 的外部来源）
  var candidates = sources.filter(function(s) {
    return !s.isLocal && s.url && s.url.startsWith('http');
  }).slice(0, opts.maxReadPages);

  var readResults = [];
  var completed = 0;

  for (var i = 0; i < candidates.length; i++) {
    var src = candidates[i];
    try {
      var content = await _fetchPage(src.url, opts);
      if (content && content.length > 100) {
        readResults.push({
          url: src.url,
          title: src.title,
          content: content.substring(0, 20000),
          query: src.query
        });
      }
    } catch (e) {
      // 跳过失败页面
    }
    completed++;
    if (onProgress && completed % 3 === 0) {
      onProgress({ phase: 'reading', progress: 55 + Math.floor(15 * completed / candidates.length), message: '阅读进度: ' + completed + '/' + candidates.length });
    }
  }

  // 本地知识直接加入
  sources.filter(function(s) { return s.isLocal && s.fullText; }).forEach(function(s) {
    readResults.push({
      url: s.url,
      title: s.title,
      content: s.fullText.substring(0, 20000),
      query: s.query,
      isLocal: true
    });
  });

  return readResults;
}

async function _fetchPage(url, opts) {
  // 优先使用 Playwright 渲染抓取（支持 SPA/动态页面）
  if (Core.browserPro && typeof Core.browserPro.navigate === 'function') {
    try {
      var navResult = await Core.browserPro.navigate(url, { page: 'research', timeout: 20000, waitUntil: 'domcontentloaded' });
      if (navResult && navResult.success) {
        var extractResult = await Core.browserPro.extract({ page: 'research', maxLength: 15000 });
        if (extractResult && extractResult.success && extractResult.text && extractResult.text.length > 100) {
          return extractResult.text;
        }
      }
    } catch (e) {
      console.warn('⚠️ [deep-research] Playwright抓取失败，回退read_url:', e.message || e);
    }
  }
  // 回退：基础 HTTP 抓取（无 JS 渲染）
  if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
    try {
      var result = await Core.toolsRegistry.executeTool('read_url', { url: url, max_length: 15000 });
      if (result && result.indexOf('\u274c') === -1) {
        // 去掉前缀 "🌐 网页内容: url\n\n"
        var text = result.replace(/^\ud83c\udf10 网页内容: [^\n]+\n\n/, '');
        return text;
      }
    } catch (e) { console.warn('⚠️ [deep-research] read_url抓取失败:', e.message || e); }
  }
  return null;
}

// ===== Phase 4: 综合撰写 =====
async function _synthesizeReport(topic, plan, searchResults, readResults, opts) {
  // 构建来源摘要
  var sourceSummary = searchResults.sources.slice(0, 20).map(function(s, i) {
    return '[' + (i + 1) + '] ' + s.title + ' (' + s.url + ')\n    ' + (s.snippet || '').substring(0, 150);
  }).join('\n');

  // 构建深度阅读内容
  var readContent = readResults.map(function(r, i) {
    return '--- 来源 ' + (i + 1) + ': ' + r.title + ' (' + r.url + ') ---\n' + r.content.substring(0, 12000);
  }).join('\n\n');

  // 截断避免超长
  if (readContent.length > 60000) readContent = readContent.substring(0, 60000) + '\n...(内容截断)';
  if (sourceSummary.length > 8000) sourceSummary = sourceSummary.substring(0, 8000);

  var systemMsg = '你是一个资深研究分析师。根据提供的检索结果和深度阅读内容，撰写一份结构化的深度研究报告。\n\n' +
    '【报告要求】\n' +
    '1. 结构：摘要 → 各子主题分析 → 综合结论 → 参考来源\n' +
    '2. 每个论点必须标注引用来源，格式：[编号]\n' +
    '3. 数据必须来自提供的材料，严禁编造数字\n' +
    '4. 如果材料不足以支撑某个论点，明确说明"现有资料不足"\n' +
    '5. 语言：中文，专业但易读\n' +
    '6. 长度：' + Math.floor(opts.maxReportLength * 0.7) + '-' + opts.maxReportLength + ' 字\n' +
    '7. 在报告末尾列出所有参考来源（编号 + 标题 + URL）\n\n' +
    '【输出格式】\n' +
    '直接输出 Markdown 格式的报告正文，不要包裹在代码块中。';

  var userMsg = '【研究主题】\n' + topic + '\n\n' +
    '【研究角度】\n' + (plan.researchAngle || '综合研究') + '\n\n' +
    '【子问题】\n' + plan.subQuestions.map(function(q, i) { return (i + 1) + '. ' + q; }).join('\n') + '\n\n' +
    '【检索来源摘要】\n' + sourceSummary + '\n\n' +
    '【深度阅读内容】\n' + readContent + '\n\n' +
    '请基于以上材料撰写深度研究报告。';

  var result = await Core.api.callAPI(
    userMsg,
    systemMsg,
    0.5,
    null, null,
    [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
    { disableTools: true, _background: true }
  );

  var markdown = (result && result.message && result.message.content) || '';

  // 清理可能的代码块包裹
  markdown = markdown.replace(/^```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  return {
    markdown: markdown,
    sourceCount: searchResults.sources.length,
    pagesRead: readResults.length
  };
}

// ===== Phase 5: 输出交付物 =====
async function _saveOutput(topic, report, opts) {
  var output = { files: [] };

  // 生成安全文件名
  var safeName = topic.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
  var timestamp = new Date().toISOString().slice(0, 10);

  // 保存 Markdown
  if (Core.deliverables) {
    var mdDir = Core.deliverables.getOutputDir('report');
    var mdPath = path.join(mdDir, timestamp + '_' + safeName + '_research.md');
    try {
      fs.writeFileSync(mdPath, report.markdown, 'utf8');
      output.files.push({ type: 'markdown', path: mdPath });

      Core.deliverables.register({
        type: 'report',
        title: '深度研究: ' + topic.substring(0, 40),
        filePath: mdPath,
        metadata: { format: 'markdown', sources: report.sourceCount, pagesRead: report.pagesRead }
      });
    } catch (e) {
      console.warn('Deep Research: 保存 Markdown 失败', e.message);
    }

    // 可选：导出 Word
    if (opts.outputFormat === 'word' && Core.pipelineReport && Core.pipelineReport.generateWord) {
      try {
        var wordPath = path.join(mdDir, timestamp + '_' + safeName + '_research.docx');
        await Core.pipelineReport.generateWord(report.markdown, wordPath, { title: '深度研究: ' + topic });
        output.files.push({ type: 'word', path: wordPath });
        Core.deliverables.register({
          type: 'report',
          title: '深度研究(Word): ' + topic.substring(0, 40),
          filePath: wordPath,
          metadata: { format: 'word' }
        });
      } catch (e) {
        console.warn('Deep Research: Word 导出失败', e.message);
      }
    }
  }

  return output;
}

// ===== 工具函数 =====
function _extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (e) { console.warn('⚠️ [deep-research] 操作失败:', e.message || e); }
  var match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch (e) { console.warn('⚠️ [deep-research] 操作失败:', e.message || e); } }
  var start = text.indexOf('{');
  if (start !== -1) {
    var depth = 0, end = -1;
    for (var i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { console.warn('⚠️ [deep-research] 操作失败:', e.message || e); }
    }
  }
  return null;
}

// ===== 查询研究状态 =====
function getResearchStatus() {
  if (!_activeResearch) return { active: false };
  return {
    active: _activeResearch.status === 'running',
    id: _activeResearch.id,
    topic: _activeResearch.topic,
    status: _activeResearch.status,
    phase: _activeResearch.phase,
    progress: _activeResearch.progress,
    subQuestions: _activeResearch.subQuestions.length,
    sources: _activeResearch.sources.length,
    duration: _activeResearch.completedAt ? _activeResearch.completedAt - _activeResearch.startedAt : Date.now() - _activeResearch.startedAt,
    error: _activeResearch.error
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'deep-research',
  dependencies: ['api', 'search', 'knowledge', 'deliverables'],
  init: function(_Core) {
    Core = _Core;

    Core.deepResearch = {
      start: startResearch,
      status: getResearchStatus,
      getConfig: getConfig
    };

    console.log('\u2705 Deep Research \u7f16\u6392\u5668\u5df2\u52a0\u8f7d\uff08\u591a\u6b65\u7814\u7a76 + \u5e76\u884c\u68c0\u7d22 + \u5e26\u5f15\u7528\u62a5\u544a\uff09');
  }
};
