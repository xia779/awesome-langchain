// modules/deep-research.js - Deep Research 编排器（多步研究 + 并行检索 + 反思循环 + 带引用报告）
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 配置 =====
const DEFAULT_CONFIG = {
  maxSubQuestions: 5,
  maxSourcesPerQuery: 6,
  maxReadPages: 10,
  maxReportLength: 8000,
  searchTimeout: 20000,
  readTimeout: 15000,
  useKnowledgeBase: true,
  outputFormat: 'markdown',
  // P4-1: 反思循环配置
  reflection: {
    enabled: true,
    maxIterations: 2,
    minConfidence: 0.7,
    minSources: 3,
    crossValidate: true
  }
};

// ===== 研究状态追踪 =====
let _activeResearch = null;

function getConfig() {
  var cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (Core && Core.config && Core.config.deepResearch) {
    Object.assign(cfg, Core.config.deepResearch);
    if (Core.config.deepResearch.reflection) {
      Object.assign(cfg.reflection, Core.config.deepResearch.reflection);
    }
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
  if (options && options.reflection) {
    opts.reflection = Object.assign({}, cfg.reflection, options.reflection);
  }
  var onProgress = opts.onProgress || function() {};

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
    reflections: [],
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

    // Phase 3: 深度阅读
    onProgress({ phase: 'reading', progress: 55, message: '正在深度阅读重点来源...' });
    research.phase = 'reading';
    var readResults = await _deepRead(searchResults.sources, opts, onProgress);
    research.deepContent = readResults;
    onProgress({ phase: 'reading', progress: 70, message: '已阅读 ' + readResults.length + ' 个页面' });

    // ===== P4-1: 反思循环 =====
    var reflectionCfg = opts.reflection || DEFAULT_CONFIG.reflection;
    var iteration = 0;
    var reflectionResult = null;

    if (reflectionCfg.enabled) {
      while (iteration < reflectionCfg.maxIterations) {
        iteration++;
        onProgress({ phase: 'reflecting', progress: 70 + iteration * 3, message: '反思评估 (第' + iteration + '轮)...' });
        research.phase = 'reflecting';

        reflectionResult = await _reflectOnResearch(topic, plan, searchResults, readResults, opts, iteration);
        research.reflections.push(reflectionResult);

        if (reflectionResult.confidence >= reflectionCfg.minConfidence && reflectionResult.gaps.length === 0) {
          onProgress({ phase: 'reflecting', progress: 75, message: '反思通过 (置信度: ' + Math.round(reflectionResult.confidence * 100) + '%)' });
          break;
        }

        // 质量不足：补充检索
        if (reflectionResult.gaps.length > 0 && iteration < reflectionCfg.maxIterations) {
          onProgress({ phase: 'supplementing', progress: 72 + iteration * 3, message: '补充检索 ' + reflectionResult.gaps.length + ' 个知识缺口...' });
          research.phase = 'supplementing';

          var supplementResults = await _supplementSearch(reflectionResult.gaps, opts, onProgress);
          if (supplementResults.sources.length > 0) {
            searchResults.sources = searchResults.sources.concat(supplementResults.sources);
            research.sources = searchResults.sources;
          }
          if (supplementResults.readResults.length > 0) {
            readResults = readResults.concat(supplementResults.readResults);
            research.deepContent = readResults;
          }
        }
      }
    }

    // P4-2: 多源交叉验证
    var crossValidation = null;
    if (reflectionCfg.crossValidate && readResults.length >= 2) {
      onProgress({ phase: 'validating', progress: 78, message: '多源交叉验证...' });
      research.phase = 'validating';
      crossValidation = await _crossValidateSources(topic, readResults, opts);
      research.crossValidation = crossValidation;
    }

    // Phase 4: 综合撰写报告
    onProgress({ phase: 'writing', progress: 80, message: '正在综合分析并撰写报告...' });
    research.phase = 'writing';
    var report = await _synthesizeReport(topic, plan, searchResults, readResults, opts, reflectionResult, crossValidation);
    research.report = report;
    onProgress({ phase: 'writing', progress: 92, message: '报告撰写完成，正在保存...' });

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
      output: output,
      reflections: research.reflections.length,
      confidence: reflectionResult ? reflectionResult.confidence : null,
      crossValidation: crossValidation
    };

  } catch (e) {
    research.status = 'error';
    research.error = e.message;
    research.completedAt = Date.now();
    onProgress({ phase: 'error', progress: research.progress, message: '研究失败: ' + e.message });
    return { success: false, error: e.message, id: research.id };
  }
}

// ===== P4-1: 反思评估 =====
async function _reflectOnResearch(topic, plan, searchResults, readResults, opts, iteration) {
  var sourceSummary = searchResults.sources.slice(0, 15).map(function(s, i) {
    return '[' + (i + 1) + '] ' + s.title + ' \u2014 ' + (s.snippet || '').substring(0, 80);
  }).join('\n');

  var contentDigest = readResults.slice(0, 8).map(function(r, i) {
    return '\u6765\u6e90' + (i + 1) + ' (' + r.title + '): ' + (r.content || '').substring(0, 300);
  }).join('\n\n');

  var systemMsg = '\u4f60\u662f\u4e00\u4e2a\u7814\u7a76\u8d28\u91cf\u8bc4\u4f30\u4e13\u5bb6\u3002\u8bf7\u8bc4\u4f30\u5f53\u524d\u7814\u7a76\u6750\u6599\u7684\u5145\u5206\u6027\u3002\n\n' +
    '\u8bc4\u4f30\u7ef4\u5ea6\uff1a\n' +
    '1. \u8986\u76d6\u5ea6\uff1a\u5b50\u95ee\u9898\u662f\u5426\u90fd\u6709\u8db3\u591f\u7684\u6750\u6599\u652f\u6491\uff1f\n' +
    '2. \u6df1\u5ea6\uff1a\u6750\u6599\u662f\u5426\u63d0\u4f9b\u4e86\u5177\u4f53\u6570\u636e/\u6848\u4f8b/\u8bba\u636e\uff1f\n' +
    '3. \u65f6\u6548\u6027\uff1a\u6765\u6e90\u662f\u5426\u8db3\u591f\u65b0\uff1f\n' +
    '4. \u591a\u5143\u6027\uff1a\u662f\u5426\u6709\u4e0d\u540c\u89c2\u70b9/\u6765\u6e90\uff1f\n\n' +
    '\u4e25\u683c\u4ee5JSON\u683c\u5f0f\u56de\u590d\uff1a\n' +
    '{"confidence": 0.0-1.0, "gaps": ["\u77e5\u8bc6\u7f3a\u53e31", "\u77e5\u8bc6\u7f3a\u53e32"], "strengths": ["\u4f18\u52bf1"], "suggestions": ["\u6539\u8fdb\u5efa\u8bae1"], "needsMoreSources": true/false}';

  var userMsg = '\u3010\u7814\u7a76\u4e3b\u9898\u3011' + topic + '\n' +
    '\u3010\u5b50\u95ee\u9898\u3011' + plan.subQuestions.join('; ') + '\n' +
    '\u3010\u5df2\u6536\u96c6\u6765\u6e90 (' + searchResults.sources.length + '\u4e2a)\u3011\n' + sourceSummary + '\n\n' +
    '\u3010\u6df1\u5ea6\u9605\u8bfb\u6458\u8981 (' + readResults.length + '\u9875)\u3011\n' + contentDigest.substring(0, 8000) + '\n\n' +
    '\u3010\u5f53\u524d\u8fed\u4ee3\u3011\u7b2c' + iteration + '\u8f6e\u53cd\u601d\n\n' +
    '\u8bf7\u8bc4\u4f30\u7814\u7a76\u6750\u6599\u5145\u5206\u6027\u3002';

  try {
    var result = await Core.api.callAPI(
      userMsg, systemMsg, 0.2, null, null,
      [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
      { disableTools: true, _background: true }
    );

    var content = (result && result.message && result.message.content) || '';
    var parsed = _extractJSON(content);

    if (parsed && typeof parsed.confidence === 'number') {
      return {
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 5) : [],
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        needsMoreSources: !!parsed.needsMoreSources,
        iteration: iteration,
        timestamp: Date.now()
      };
    }
  } catch (e) {
    console.warn('Deep Research: \u53cd\u601d\u8bc4\u4f30\u5931\u8d25', e.message);
  }

  // Fallback: 基于规则的简单评估
  var sourceCount = searchResults.sources.length;
  var readCount = readResults.length;
  var heuristicConfidence = Math.min(1, (sourceCount / 10) * 0.4 + (readCount / 5) * 0.4 + 0.2);
  var gaps = [];
  var minSrc = (opts.reflection || DEFAULT_CONFIG.reflection).minSources || 3;
  if (sourceCount < minSrc) gaps.push('\u6765\u6e90\u6570\u91cf\u4e0d\u8db3\uff0c\u9700\u8981\u66f4\u591a\u68c0\u7d22');
  if (readCount < 2) gaps.push('\u6df1\u5ea6\u9605\u8bfb\u4e0d\u8db3\uff0c\u9700\u8981\u9605\u8bfb\u66f4\u591a\u9875\u9762');

  return {
    confidence: heuristicConfidence,
    gaps: gaps,
    strengths: [],
    suggestions: [],
    needsMoreSources: sourceCount < 5,
    iteration: iteration,
    timestamp: Date.now(),
    heuristic: true
  };
}

// ===== P4-1: 补充检索 =====
async function _supplementSearch(gaps, opts, onProgress) {
  var supplementSources = [];
  var supplementReads = [];

  for (var i = 0; i < gaps.length && i < 3; i++) {
    var gap = gaps[i];
    try {
      var searchResult = await _searchOneQuestion(gap, i, opts);
      (searchResult.items || []).forEach(function(item) {
        if (item.url) {
          supplementSources.push({
            title: item.title || '',
            url: item.url,
            snippet: item.snippet || '',
            query: gap,
            relevanceScore: 0,
            isSupplement: true
          });
        }
      });
    } catch (e) {
      console.warn('Deep Research: \u8865\u5145\u68c0\u7d22\u5931\u8d25 [' + gap + ']', e.message);
    }
  }

  var toRead = supplementSources.filter(function(s) {
    return s.url && s.url.startsWith('http');
  }).slice(0, 3);

  for (var j = 0; j < toRead.length; j++) {
    try {
      var content = await _fetchPage(toRead[j].url, opts);
      if (content && content.length > 100) {
        supplementReads.push({
          url: toRead[j].url,
          title: toRead[j].title,
          content: content.substring(0, 20000),
          query: toRead[j].query,
          isSupplement: true
        });
      }
    } catch (e) { /* skip */ }
  }

  return { sources: supplementSources, readResults: supplementReads };
}

// ===== P4-2: 多源交叉验证 =====
async function _crossValidateSources(topic, readResults, opts) {
  if (readResults.length < 2) return null;

  var factsBySource = readResults.slice(0, 6).map(function(r, i) {
    return '\u6765\u6e90' + (i + 1) + ' [' + r.title + ']:\n' + (r.content || '').substring(0, 2000);
  }).join('\n\n---\n\n');

  var systemMsg = '\u4f60\u662f\u4e00\u4e2a\u4e8b\u5b9e\u6838\u67e5\u4e13\u5bb6\u3002\u8bf7\u5bf9\u6bd4\u591a\u4e2a\u6765\u6e90\u7684\u4fe1\u606f\uff0c\u627e\u51fa\uff1a\n' +
    '1. \u4e00\u81f4\u7684\u4e8b\u5b9e\uff08\u591a\u6e90\u5370\u8bc1\uff09\n' +
    '2. \u77db\u76fe\u7684\u4fe1\u606f\uff08\u6765\u6e90\u95f4\u51b2\u7a81\uff09\n' +
    '3. \u5b64\u7acb\u4fe1\u606f\uff08\u4ec5\u5355\u4e00\u6765\u6e90\u63d0\u53ca\uff09\n\n' +
    '\u4e25\u683c\u4ee5JSON\u683c\u5f0f\u56de\u590d\uff1a\n' +
    '{"consistent": ["\u4e00\u81f4\u4e8b\u5b9e1"], "contradictions": [{"fact": "\u77db\u76fe\u70b9", "sources": ["\u6765\u6e90A\u8bf4\u6cd5", "\u6765\u6e90B\u8bf4\u6cd5"]}], "isolated": ["\u5b64\u7acb\u4fe1\u606f1"], "reliability": 0.0-1.0}';

  var userMsg = '\u3010\u7814\u7a76\u4e3b\u9898\u3011' + topic + '\n\n\u3010\u591a\u6e90\u5185\u5bb9\u5bf9\u6bd4\u3011\n' + factsBySource.substring(0, 12000);

  try {
    var result = await Core.api.callAPI(
      userMsg, systemMsg, 0.2, null, null,
      [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
      { disableTools: true, _background: true }
    );

    var content = (result && result.message && result.message.content) || '';
    var parsed = _extractJSON(content);

    if (parsed) {
      return {
        consistent: Array.isArray(parsed.consistent) ? parsed.consistent : [],
        contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
        isolated: Array.isArray(parsed.isolated) ? parsed.isolated : [],
        reliability: typeof parsed.reliability === 'number' ? parsed.reliability : 0.5,
        sourceCount: readResults.length,
        timestamp: Date.now()
      };
    }
  } catch (e) {
    console.warn('Deep Research: \u4ea4\u53c9\u9a8c\u8bc1\u5931\u8d25', e.message);
  }

  return { consistent: [], contradictions: [], isolated: [], reliability: 0.5, sourceCount: readResults.length, timestamp: Date.now(), fallback: true };
}

// ===== Phase 1: 问题拆解 =====
async function _planResearch(topic, opts) {
  var systemMsg = '\u4f60\u662f\u4e00\u4e2a\u7814\u7a76\u89c4\u5212\u4e13\u5bb6\u3002\u7528\u6237\u7ed9\u4f60\u4e00\u4e2a\u7814\u7a76\u4e3b\u9898\uff0c\u4f60\u9700\u8981\u5c06\u5176\u62c6\u89e3\u4e3a3-' + opts.maxSubQuestions + '\u4e2a\u53ef\u72ec\u7acb\u68c0\u7d22\u7684\u5b50\u95ee\u9898\u3002\n' +
    '\u8981\u6c42\uff1a\n' +
    '1. \u5b50\u95ee\u9898\u5e94\u8986\u76d6\u4e3b\u9898\u7684\u4e0d\u540c\u7ef4\u5ea6\uff08\u80cc\u666f\u3001\u73b0\u72b6\u3001\u6570\u636e\u3001\u5bf9\u6bd4\u3001\u8d8b\u52bf\u3001\u98ce\u9669\u7b49\uff09\n' +
    '2. \u6bcf\u4e2a\u5b50\u95ee\u9898\u5e94\u5177\u4f53\u3001\u53ef\u641c\u7d22\uff0c\u907f\u514d\u8fc7\u4e8e\u5bbd\u6cdb\n' +
    '3. \u5b50\u95ee\u9898\u4e4b\u95f4\u5c3d\u91cf\u4e0d\u91cd\u53e0\n' +
    '4. \u540c\u65f6\u7ed9\u51fa3-5\u4e2a\u63a8\u8350\u641c\u7d22\u5173\u952e\u8bcd\uff08\u4e2d\u82f1\u6587\u6df7\u5408\uff09\n\n' +
    '\u4e25\u683c\u4ee5JSON\u683c\u5f0f\u56de\u590d\uff1a\n' +
    '{"subQuestions": ["\u5b50\u95ee\u98981", "\u5b50\u95ee\u98982"], "keywords": ["\u5173\u952e\u8bcd1", "\u5173\u952e\u8bcd2"], "researchAngle": "\u4e00\u53e5\u8bdd\u63cf\u8ff0\u7814\u7a76\u89d2\u5ea6"}';

  var result = await Core.api.callAPI(
    '\u7814\u7a76\u4e3b\u9898\uff1a' + topic,
    systemMsg,
    0.3,
    null, null,
    [{ role: 'system', content: systemMsg }, { role: 'user', content: '\u7814\u7a76\u4e3b\u9898\uff1a' + topic + '\n\n\u8bf7\u62c6\u89e3\u5b50\u95ee\u9898\u3002' }],
    { disableTools: true, _background: true }
  );

  var content = (result && result.message && result.message.content) || '';
  var parsed = _extractJSON(content);

  if (!parsed || !parsed.subQuestions || !Array.isArray(parsed.subQuestions)) {
    return { subQuestions: [topic], keywords: [topic], researchAngle: '\u7efc\u5408\u7814\u7a76' };
  }

  parsed.subQuestions = parsed.subQuestions.slice(0, opts.maxSubQuestions);
  parsed.keywords = (parsed.keywords || []).slice(0, 8);
  parsed.researchAngle = parsed.researchAngle || '\u7efc\u5408\u7814\u7a76';
  return parsed;
}

// ===== 来源重排序 =====
function _rankSources(sources, queries) {
  var nowYear = new Date().getFullYear();
  sources.forEach(function(s) {
    var text = ((s.title || '') + ' ' + (s.snippet || '') + ' ' + (s.url || '') + ' ' + (s.query || '')).toLowerCase();
    var score = 0;
    queries.forEach(function(q) {
      var terms = String(q).toLowerCase().split(/\s+/).filter(function(t) { return t.length > 1; });
      terms.forEach(function(t) {
        if (text.indexOf(t) !== -1) {
          var boundary = (text.indexOf(' ' + t + ' ') !== -1) || text.indexOf(t + ' ') === 0 || text.lastIndexOf(' ' + t) === text.length - (' ' + t).length;
          score += boundary ? 2 : 1;
        }
      });
    });
    for (var y = 0; y < 3; y++) {
      var yr = String(nowYear - y);
      if (text.indexOf(yr) !== -1) score += (3 - y) * 1.5;
    }
    s._rankScore = score;
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

  var searchPromises = subQuestions.map(function(q, idx) {
    return _searchOneQuestion(q, idx, opts).then(function(results) {
      completed++;
      if (onProgress) {
        onProgress({ phase: 'searching', progress: 20 + Math.floor(30 * completed / subQuestions.length), message: '\u68c0\u7d22\u8fdb\u5ea6: ' + completed + '/' + subQuestions.length });
      }
      return results;
    });
  });

  var results = await Promise.all(searchPromises);

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

  if (opts.useKnowledgeBase && Core.knowledge && Core.knowledge.searchWithCitations) {
    try {
      var kbResult = Core.knowledge.searchWithCitations(subQuestions.join(' '), 5);
      if (kbResult && kbResult.results && kbResult.results.length > 0) {
        kbResult.results.forEach(function(kb) {
          allSources.push({
            title: kb.fileName || '\u672c\u5730\u77e5\u8bc6\u5e93',
            url: 'knowledge://' + (kb.docId || 'local'),
            snippet: (kb.text || '').substring(0, 200),
            query: '\u672c\u5730\u77e5\u8bc6\u5e93',
            relevanceScore: kb.score || 0,
            isLocal: true,
            fullText: kb.text
          });
        });
      }
    } catch (e) {
      console.warn('Deep Research: \u77e5\u8bc6\u5e93\u68c0\u7d22\u5931\u8d25', e.message);
    }
  }

  allSources = _rankSources(allSources, subQuestions);
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
    console.warn('Deep Research: \u641c\u7d22\u5931\u8d25 [' + query + ']', e.message);
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
        readResults.push({ url: src.url, title: src.title, content: content.substring(0, 20000), query: src.query });
      }
    } catch (e) { /* skip */ }
    completed++;
    if (onProgress && completed % 3 === 0) {
      onProgress({ phase: 'reading', progress: 55 + Math.floor(15 * completed / candidates.length), message: '\u9605\u8bfb\u8fdb\u5ea6: ' + completed + '/' + candidates.length });
    }
  }

  sources.filter(function(s) { return s.isLocal && s.fullText; }).forEach(function(s) {
    readResults.push({ url: s.url, title: s.title, content: s.fullText.substring(0, 20000), query: s.query, isLocal: true });
  });

  return readResults;
}

async function _fetchPage(url, opts) {
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
      console.warn('\u26a0\ufe0f [deep-research] Playwright\u6293\u53d6\u5931\u8d25\uff0c\u56de\u9000read_url:', e.message || e);
    }
  }
  if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
    try {
      var result = await Core.toolsRegistry.executeTool('read_url', { url: url, max_length: 15000 });
      if (result && result.indexOf('\u274c') === -1) {
        return result.replace(/^\ud83c\udf10 \u7f51\u9875\u5185\u5bb9: [^\n]+\n\n/, '');
      }
    } catch (e) { console.warn('\u26a0\ufe0f [deep-research] read_url\u6293\u53d6\u5931\u8d25:', e.message || e); }
  }
  return null;
}

// ===== Phase 4: 综合撰写 =====
async function _synthesizeReport(topic, plan, searchResults, readResults, opts, reflection, crossValidation) {
  var sourceSummary = searchResults.sources.slice(0, 20).map(function(s, i) {
    return '[' + (i + 1) + '] ' + s.title + ' (' + s.url + ')\n    ' + (s.snippet || '').substring(0, 150);
  }).join('\n');

  var readContent = readResults.map(function(r, i) {
    return '--- \u6765\u6e90 ' + (i + 1) + ': ' + r.title + ' (' + r.url + ') ---\n' + r.content.substring(0, 12000);
  }).join('\n\n');

  if (readContent.length > 60000) readContent = readContent.substring(0, 60000) + '\n...(\u5185\u5bb9\u622a\u65ad)';
  if (sourceSummary.length > 8000) sourceSummary = sourceSummary.substring(0, 8000);

  var reflectionCtx = '';
  if (reflection) {
    reflectionCtx = '\n\u3010\u7814\u7a76\u8d28\u91cf\u8bc4\u4f30\u3011\n\u7f6e\u4fe1\u5ea6: ' + Math.round(reflection.confidence * 100) + '%\n';
    if (reflection.strengths && reflection.strengths.length > 0) reflectionCtx += '\u4f18\u52bf: ' + reflection.strengths.join('; ') + '\n';
    if (reflection.suggestions && reflection.suggestions.length > 0) reflectionCtx += '\u6539\u8fdb\u5efa\u8bae: ' + reflection.suggestions.join('; ') + '\n';
  }
  if (crossValidation) {
    reflectionCtx += '\n\u3010\u4ea4\u53c9\u9a8c\u8bc1\u7ed3\u679c\u3011\n\u53ef\u9760\u6027: ' + Math.round(crossValidation.reliability * 100) + '%\n';
    if (crossValidation.contradictions && crossValidation.contradictions.length > 0) {
      reflectionCtx += '\u77db\u76fe\u70b9: ' + crossValidation.contradictions.map(function(c) {
        return typeof c === 'string' ? c : (c.fact || JSON.stringify(c));
      }).join('; ') + '\n';
      reflectionCtx += '\u6ce8\u610f: \u5bf9\u77db\u76fe\u4fe1\u606f\u9700\u5728\u62a5\u544a\u4e2d\u660e\u786e\u6807\u6ce8\u4e0d\u540c\u6765\u6e90\u7684\u8bf4\u6cd5\u3002\n';
    }
    if (crossValidation.consistent && crossValidation.consistent.length > 0) {
      reflectionCtx += '\u591a\u6e90\u5370\u8bc1: ' + crossValidation.consistent.slice(0, 5).join('; ') + '\n';
    }
  }

  var systemMsg = '\u4f60\u662f\u4e00\u4e2a\u8d44\u6df1\u7814\u7a76\u5206\u6790\u5e08\u3002\u6839\u636e\u63d0\u4f9b\u7684\u68c0\u7d22\u7ed3\u679c\u548c\u6df1\u5ea6\u9605\u8bfb\u5185\u5bb9\uff0c\u64b0\u5199\u4e00\u4efd\u7ed3\u6784\u5316\u7684\u6df1\u5ea6\u7814\u7a76\u62a5\u544a\u3002\n\n' +
    '\u3010\u62a5\u544a\u8981\u6c42\u3011\n' +
    '1. \u7ed3\u6784\uff1a\u6458\u8981 \u2192 \u5404\u5b50\u4e3b\u9898\u5206\u6790 \u2192 \u7efc\u5408\u7ed3\u8bba \u2192 \u53c2\u8003\u6765\u6e90\n' +
    '2. \u6bcf\u4e2a\u8bba\u70b9\u5fc5\u987b\u6807\u6ce8\u5f15\u7528\u6765\u6e90\uff0c\u683c\u5f0f\uff1a[\u7f16\u53f7]\n' +
    '3. \u6570\u636e\u5fc5\u987b\u6765\u81ea\u63d0\u4f9b\u7684\u6750\u6599\uff0c\u4e25\u7981\u7f16\u9020\u6570\u5b57\n' +
    '4. \u5982\u679c\u6750\u6599\u4e0d\u8db3\u4ee5\u652f\u6491\u67d0\u4e2a\u8bba\u70b9\uff0c\u660e\u786e\u8bf4\u660e\u201c\u73b0\u6709\u8d44\u6599\u4e0d\u8db3\u201d\n' +
    '5. \u8bed\u8a00\uff1a\u4e2d\u6587\uff0c\u4e13\u4e1a\u4f46\u6613\u8bfb\n' +
    '6. \u957f\u5ea6\uff1a' + Math.floor(opts.maxReportLength * 0.7) + '-' + opts.maxReportLength + ' \u5b57\n' +
    '7. \u5728\u62a5\u544a\u672b\u5c3e\u5217\u51fa\u6240\u6709\u53c2\u8003\u6765\u6e90\uff08\u7f16\u53f7 + \u6807\u9898 + URL\uff09\n' +
    (crossValidation && crossValidation.contradictions && crossValidation.contradictions.length > 0 ?
      '8. \u5bf9\u5b58\u5728\u77db\u76fe\u7684\u4fe1\u606f\uff0c\u9700\u5217\u51fa\u4e0d\u540c\u6765\u6e90\u7684\u8bf4\u6cd5\u5e76\u6807\u6ce8\u53ef\u4fe1\u5ea6\n' : '') +
    '\n\u3010\u8f93\u51fa\u683c\u5f0f\u3011\n\u76f4\u63a5\u8f93\u51fa Markdown \u683c\u5f0f\u7684\u62a5\u544a\u6b63\u6587\uff0c\u4e0d\u8981\u5305\u88f9\u5728\u4ee3\u7801\u5757\u4e2d\u3002';

  var userMsg = '\u3010\u7814\u7a76\u4e3b\u9898\u3011\n' + topic + '\n\n' +
    '\u3010\u7814\u7a76\u89d2\u5ea6\u3011\n' + (plan.researchAngle || '\u7efc\u5408\u7814\u7a76') + '\n\n' +
    '\u3010\u5b50\u95ee\u9898\u3011\n' + plan.subQuestions.map(function(q, i) { return (i + 1) + '. ' + q; }).join('\n') + '\n\n' +
    '\u3010\u68c0\u7d22\u6765\u6e90\u6458\u8981\u3011\n' + sourceSummary + '\n\n' +
    '\u3010\u6df1\u5ea6\u9605\u8bfb\u5185\u5bb9\u3011\n' + readContent + '\n' +
    reflectionCtx + '\n\n' +
    '\u8bf7\u57fa\u4e8e\u4ee5\u4e0a\u6750\u6599\u64b0\u5199\u6df1\u5ea6\u7814\u7a76\u62a5\u544a\u3002';

  var result = await Core.api.callAPI(
    userMsg, systemMsg, 0.5, null, null,
    [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
    { disableTools: true, _background: true }
  );

  var markdown = (result && result.message && result.message.content) || '';
  markdown = markdown.replace(/^```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  return {
    markdown: markdown,
    sourceCount: searchResults.sources.length,
    pagesRead: readResults.length,
    confidence: reflection ? reflection.confidence : null,
    reliability: crossValidation ? crossValidation.reliability : null
  };
}

// ===== Phase 5: 输出交付物 =====
async function _saveOutput(topic, report, opts) {
  var output = { files: [] };
  var safeName = topic.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
  var timestamp = new Date().toISOString().slice(0, 10);

  if (Core.deliverables) {
    var mdDir = Core.deliverables.getOutputDir('report');
    var mdPath = path.join(mdDir, timestamp + '_' + safeName + '_research.md');
    try {
      fs.writeFileSync(mdPath, report.markdown, 'utf8');
      output.files.push({ type: 'markdown', path: mdPath });
      Core.deliverables.register({
        type: 'report',
        title: '\u6df1\u5ea6\u7814\u7a76: ' + topic.substring(0, 40),
        filePath: mdPath,
        metadata: { format: 'markdown', sources: report.sourceCount, pagesRead: report.pagesRead, confidence: report.confidence }
      });
    } catch (e) {
      console.warn('Deep Research: \u4fdd\u5b58 Markdown \u5931\u8d25', e.message);
    }

    if (opts.outputFormat === 'word' && Core.pipelineReport && Core.pipelineReport.generateWord) {
      try {
        var wordPath = path.join(mdDir, timestamp + '_' + safeName + '_research.docx');
        await Core.pipelineReport.generateWord(report.markdown, wordPath, { title: '\u6df1\u5ea6\u7814\u7a76: ' + topic });
        output.files.push({ type: 'word', path: wordPath });
      } catch (e) {
        console.warn('Deep Research: Word \u5bfc\u51fa\u5931\u8d25', e.message);
      }
    }
  }

  return output;
}

// ===== 工具函数 =====
function _extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (e) { /* continue */ }
  var match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch (e) { /* continue */ } }
  var start = text.indexOf('{');
  if (start !== -1) {
    var depth = 0, end = -1;
    for (var i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try { return JSON.parse(text.substring(start, end + 1)); } catch (e) { /* continue */ }
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
    reflections: _activeResearch.reflections.length,
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
      getConfig: getConfig,
      reflect: _reflectOnResearch,
      crossValidate: _crossValidateSources
    };
    console.log('\u2705 Deep Research \u7f16\u6392\u5668\u5df2\u52a0\u8f7d\uff08\u53cd\u601d\u5faa\u73af + \u591a\u6e90\u9a8c\u8bc1 + \u5e76\u884c\u68c0\u7d22 + \u5e26\u5f15\u7528\u62a5\u544a\uff09');
  }
};
