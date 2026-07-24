// modules/knowledge-distill.js - 知识库蒸馏引擎
// 功能：定时聚类去重、高频主题提取、生成蒸馏索引、技能候选、错误经验集
// 检索优先级：蒸馏索引(热缓存) → 全量 BM25/RRF → 联网搜索
'use strict';

var Core = null;
var fs = null;
var path = null;

// ===== 配置 =====
var SIMILARITY_THRESHOLD = 0.82;   // 向量相似度阈值，超过则归为同一簇
var TEXT_JACCARD_THRESHOLD = 0.45; // 无向量时 Jaccard 相似度阈值
var SKILL_PROMOTE_THRESHOLD = 5;   // 高频主题被检索次数达到此值时推荐为技能候选
var DISTILLED_FILE = '_distilled_index.json';
var LESSONS_FILE = '_lessons_learned.json';
var DISTILL_STATS_FILE = '_distill_stats.json';

// ===== 路径 =====
function getDistilledPath() {
  var dir = Core.knowledge.getKnowledgeDir();
  return path.join(dir, DISTILLED_FILE);
}

function getLessonsPath() {
  var dir = Core.knowledge.getKnowledgeDir();
  return path.join(dir, LESSONS_FILE);
}

function getStatsPath() {
  var dir = Core.knowledge.getKnowledgeDir();
  return path.join(dir, DISTILL_STATS_FILE);
}

// ===== 蒸馏索引读写 =====
function loadDistilledIndex() {
  try {
    var filePath = getDistilledPath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.warn('[distill] 读取蒸馏索引失败:', e.message);
  }
  return { version: 1, distilledAt: null, topics: [], totalClusters: 0, totalChunks: 0 };
}

function saveDistilledIndex(index) {
  try {
    var filePath = getDistilledPath();
    fs.writeFileSync(filePath, JSON.stringify(index, null, 2), 'utf8');
  } catch (e) {
    console.error('[distill] 保存蒸馏索引失败:', e.message);
  }
}

// ===== 错误经验集读写 =====
function loadLessons() {
  try {
    var filePath = getLessonsPath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.warn('[distill] 读取经验集失败:', e.message);
  }
  return { version: 1, lessons: [] };
}

function saveLessons(data) {
  try {
    var filePath = getLessonsPath();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[distill] 保存经验集失败:', e.message);
  }
}

// ===== 蒸馏统计（记录每次检索命中，用于高频主题识别）=====
function loadStats() {
  try {
    var filePath = getStatsPath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { console.warn('⚠️ [knowledge-distill] 操作失败:', e.message || e); }
  return { topicHits: {}, lastDistill: null, distillCount: 0 };
}

function saveStats(stats) {
  try {
    fs.writeFileSync(getStatsPath(), JSON.stringify(stats, null, 2), 'utf8');
  } catch (e) { console.warn('⚠️ [knowledge-distill] 操作失败:', e.message || e); }
}

// ===== 核心：蒸馏引擎 =====
async function distill() {
  console.log('[distill] 开始知识库蒸馏...');
  var startTime = Date.now();

  var allChunks = Core.knowledge._loadAllChunks();
  if (allChunks.length === 0) {
    console.log('[distill] 知识库为空，跳过蒸馏');
    return { success: true, clusters: 0, topics: 0, message: '知识库为空' };
  }

  console.log('[distill] 加载了 ' + allChunks.length + ' 个 chunk，开始聚类...');

  // 1. 聚类
  var clusters = clusterChunks(allChunks);
  console.log('[distill] 聚类完成: ' + allChunks.length + ' chunks -> ' + clusters.length + ' 簇');

  // 2. 为每个簇生成主题摘要
  var topics = [];
  for (var i = 0; i < clusters.length; i++) {
    var topic = buildTopicFromCluster(clusters[i], i);
    if (topic) topics.push(topic);
  }

  // 3. 合并历史命中统计
  var stats = loadStats();
  for (var t = 0; t < topics.length; t++) {
    var topicKey = topics[t].topic;
    topics[t].hitCount = stats.topicHits[topicKey] || 0;
  }

  // 4. 按 hitCount 降序
  topics.sort(function(a, b) { return (b.hitCount || 0) - (a.hitCount || 0); });

  // 5. 生成蒸馏索引
  var index = {
    version: 1,
    distilledAt: new Date().toISOString(),
    totalChunks: allChunks.length,
    totalClusters: clusters.length,
    topics: topics
  };
  saveDistilledIndex(index);

  // 6. 更新统计
  stats.lastDistill = new Date().toISOString();
  stats.distillCount = (stats.distillCount || 0) + 1;
  saveStats(stats);

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  var skillCandidates = topics.filter(function(t) { return (t.hitCount || 0) >= SKILL_PROMOTE_THRESHOLD; });

  console.log('[distill] 蒸馏完成: ' + clusters.length + ' 簇, ' + topics.length + ' 主题, ' +
    skillCandidates.length + ' 个技能候选, 耗时 ' + elapsed + 's');

  return {
    success: true,
    clusters: clusters.length,
    topics: topics.length,
    skillCandidates: skillCandidates.length,
    elapsed: elapsed,
    message: '蒸馏完成: ' + allChunks.length + ' chunks -> ' + clusters.length + ' 簇 -> ' + topics.length + ' 主题'
  };
}

// ===== 聚类算法 =====
function clusterChunks(chunks) {
  var chunksWithEmbeddings = chunks.filter(function(c) { return c.embedding; });
  if (chunksWithEmbeddings.length > chunks.length * 0.5) {
    return vectorCluster(chunks);
  } else {
    return textCluster(chunks);
  }
}

function vectorCluster(chunks) {
  var cosineSim = Core.knowledge._cosineSimilarity;
  var clusters = [];

  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var merged = false;

    if (chunk.embedding) {
      for (var j = 0; j < clusters.length; j++) {
        var sim = cosineSim(chunk.embedding, clusters[j].centroid);
        if (sim >= SIMILARITY_THRESHOLD) {
          clusters[j].chunks.push(chunk);
          updateCentroid(clusters[j], chunk.embedding);
          merged = true;
          break;
        }
      }
    }

    if (!merged) {
      clusters.push({
        chunks: [chunk],
        centroid: chunk.embedding ? chunk.embedding.slice() : null
      });
    }
  }

  return clusters;
}

function updateCentroid(cluster, newEmbedding) {
  if (!cluster.centroid || !newEmbedding) return;
  var n = cluster.chunks.length;
  for (var i = 0; i < cluster.centroid.length; i++) {
    cluster.centroid[i] = cluster.centroid[i] * (n - 1) / n + newEmbedding[i] / n;
  }
}

function textCluster(chunks) {
  var tokenize = Core.knowledge._tokenize;
  var clusters = [];

  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var tokens = new Set(tokenize(chunk.text));
    var merged = false;

    for (var j = 0; j < clusters.length; j++) {
      var jaccard = jaccardSimilarity(tokens, clusters[j].tokenSet);
      if (jaccard >= TEXT_JACCARD_THRESHOLD) {
        clusters[j].chunks.push(chunk);
        tokens.forEach(function(t) { clusters[j].tokenSet.add(t); });
        merged = true;
        break;
      }
    }

    if (!merged) {
      clusters.push({ chunks: [chunk], tokenSet: tokens });
    }
  }

  return clusters;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  var intersection = 0;
  setA.forEach(function(item) {
    if (setB.has(item)) intersection++;
  });
  var union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ===== 从簇构建主题 =====
function buildTopicFromCluster(cluster, index) {
  var chunks = cluster.chunks;
  if (!chunks || chunks.length === 0) return null;

  var representative = chunks[0];
  for (var i = 1; i < chunks.length; i++) {
    if (chunks[i].text.length > representative.text.length) {
      representative = chunks[i];
    }
  }

  var text = representative.text.trim();
  var topicLabel = '';
  var firstSentence = text.split(/[。！？\n.!?]/)[0];
  if (firstSentence && firstSentence.length >= 5) {
    topicLabel = firstSentence.substring(0, 60);
  } else {
    topicLabel = text.substring(0, 60);
  }

  var summary = text.substring(0, 300);
  if (text.length > 300) summary += '...';

  var sources = [];
  var sourceSet = {};
  for (var s = 0; s < chunks.length; s++) {
    var fn = chunks[s].fileName || '未知';
    if (!sourceSet[fn]) {
      sourceSet[fn] = true;
      sources.push(fn);
    }
  }

  return {
    id: 'topic_' + index,
    topic: topicLabel,
    summary: summary,
    sources: sources,
    chunkCount: chunks.length,
    hitCount: 0,
    lastUpdated: new Date().toISOString()
  };
}

// ===== 蒸馏索引检索（热缓存层）=====
function searchDistilled(query, topK) {
  topK = topK || 3;
  var index = loadDistilledIndex();
  if (!index.topics || index.topics.length === 0) return null;

  var tokenize = Core.knowledge._tokenize;
  var queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;

  var scored = [];
  for (var i = 0; i < index.topics.length; i++) {
    var topic = index.topics[i];
    var topicText = topic.topic + ' ' + topic.summary;
    var topicTokens = tokenize(topicText);

    var hitCount = 0;
    var tokenSet = new Set(topicTokens);
    for (var q = 0; q < queryTokens.length; q++) {
      if (tokenSet.has(queryTokens[q])) hitCount++;
    }

    var score = queryTokens.length > 0 ? hitCount / queryTokens.length : 0;
    score *= (1 + Math.log1p(topic.hitCount || 0) * 0.1);

    if (score > 0.15) {
      scored.push({ topic: topic, score: score });
    }
  }

  if (scored.length === 0) return null;

  scored.sort(function(a, b) { return b.score - a.score; });
  var topResults = scored.slice(0, topK);

  if (topResults[0].score < 0.3) return null;

  // 记录命中统计
  var stats = loadStats();
  for (var r = 0; r < topResults.length; r++) {
    var key = topResults[r].topic.topic;
    stats.topicHits[key] = (stats.topicHits[key] || 0) + 1;
  }
  saveStats(stats);

  var results = topResults.map(function(item) {
    return {
      text: item.topic.summary,
      fileName: item.topic.sources.join(', '),
      docId: item.topic.id,
      score: item.score,
      fromDistilled: true
    };
  });

  var context = '';
  var citations = '';
  for (var c = 0; c < results.length; c++) {
    context += '--- [蒸馏] ' + results[c].fileName + ' ---\n' + results[c].text + '\n\n';
    citations += '[' + (c + 1) + '] ' + results[c].fileName + '\n';
  }

  return { results: results, citations: citations.trim(), context: context.trim(), fromDistilled: true };
}

// ===== 技能候选 =====
function getSkillCandidates() {
  var index = loadDistilledIndex();
  if (!index.topics) return [];
  return index.topics.filter(function(t) {
    return (t.hitCount || 0) >= SKILL_PROMOTE_THRESHOLD;
  });
}

function promoteToSkill(topicId) {
  var index = loadDistilledIndex();
  var topic = null;
  for (var i = 0; i < index.topics.length; i++) {
    if (index.topics[i].id === topicId) {
      topic = index.topics[i];
      break;
    }
  }
  if (!topic) return { success: false, error: '主题不存在' };

  var skillId = 'auto_' + topic.topic.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30);

  var skillsDir = path.join(Core.DATA_ROOT, 'skills', skillId);
  try {
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    var skillJson = {
      id: skillId,
      name: topic.topic.substring(0, 30),
      description: '从知识库高频主题自动提取 (命中' + topic.hitCount + '次)',
      version: '1.0.0',
      autoGenerated: true,
      sourceTopicId: topicId,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(skillsDir, 'skill.json'), JSON.stringify(skillJson, null, 2), 'utf8');

    var promptMd = '# ' + topic.topic + '\n\n' +
      '## 知识摘要\n\n' + topic.summary + '\n\n' +
      '## 来源\n\n' + topic.sources.join('\n') + '\n';
    fs.writeFileSync(path.join(skillsDir, 'prompt.md'), promptMd, 'utf8');

    console.log('[distill] 已将主题提升为技能: ' + skillId);
    return { success: true, skillId: skillId, name: skillJson.name };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 错误经验集（Lessons Learned）=====
function addLesson(lesson) {
  var data = loadLessons();
  var existing = null;

  for (var i = 0; i < data.lessons.length; i++) {
    if (data.lessons[i].pattern === lesson.pattern && data.lessons[i].tool === lesson.tool) {
      existing = data.lessons[i];
      break;
    }
  }

  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastSeen = new Date().toISOString();
    existing.message = lesson.message;
  } else {
    data.lessons.push({
      id: 'lesson_' + Date.now().toString(36),
      category: lesson.category || 'general',
      pattern: lesson.pattern || '',
      message: lesson.message || '',
      tool: lesson.tool || '',
      suggestion: lesson.suggestion || '',
      count: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    });
  }

  saveLessons(data);
}

function getRelevantLessons(toolName, context) {
  var data = loadLessons();
  if (!data.lessons || data.lessons.length === 0) return [];

  var relevant = [];
  var contextLower = (context || '').toLowerCase();

  for (var i = 0; i < data.lessons.length; i++) {
    var lesson = data.lessons[i];
    if (lesson.tool && toolName && lesson.tool.toLowerCase() === toolName.toLowerCase()) {
      relevant.push(lesson);
      continue;
    }
    if (lesson.pattern && contextLower.indexOf(lesson.pattern.toLowerCase()) >= 0) {
      relevant.push(lesson);
    }
  }

  relevant.sort(function(a, b) { return (b.count || 1) - (a.count || 1); });
  return relevant.slice(0, 3);
}

function formatLessonsForPrompt(lessons) {
  if (!lessons || lessons.length === 0) return '';
  var text = '\n\n【历史经验警告】以下是过去执行中遇到的错误模式，请注意避免：\n';
  for (var i = 0; i < lessons.length; i++) {
    var l = lessons[i];
    text += '- [' + l.category + '] ' + l.message;
    if (l.suggestion) text += '（建议: ' + l.suggestion + '）';
    text += ' (已出现' + l.count + '次)\n';
  }
  return text;
}

// ===== 命令注册 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('distill', {
    zh: '知识库蒸馏: /distill run|status|candidates|promote <id>',
    en: 'Knowledge distillation'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'status';

    if (sub === 'run') {
      showMsg('正在执行知识库蒸馏...');
      distill().then(function(result) {
        if (result.success) {
          showMsg('✅ 蒸馏完成\n' + result.message +
            '\n技能候选: ' + result.skillCandidates + ' 个' +
            '\n耗时: ' + result.elapsed + 's');
        } else {
          showMsg('❌ 蒸馏失败: ' + (result.error || '未知错误'));
        }
      }).catch(function(e) {
        showMsg('❌ 蒸馏异常: ' + e.message);
      });
      return;
    }

    if (sub === 'status') {
      var index = loadDistilledIndex();
      var stats = loadStats();
      var lessons = loadLessons();
      var text = '📊 **知识库蒸馏状态**\n\n';
      text += '上次蒸馏: ' + (index.distilledAt ? new Date(index.distilledAt).toLocaleString('zh-CN') : '从未') + '\n';
      text += '蒸馏次数: ' + (stats.distillCount || 0) + '\n';
      text += '主题数: ' + (index.topics ? index.topics.length : 0) + '\n';
      text += '聚类簇数: ' + (index.totalClusters || 0) + '\n';
      text += '原始 chunk 数: ' + (index.totalChunks || 0) + '\n';
      text += '技能候选: ' + getSkillCandidates().length + ' 个\n';
      text += '错误经验: ' + (lessons.lessons ? lessons.lessons.length : 0) + ' 条\n';
      showMsg(text);
      return;
    }

    if (sub === 'candidates') {
      var candidates = getSkillCandidates();
      if (candidates.length === 0) {
        showMsg('暂无技能候选。\n高频主题被检索 >= ' + SKILL_PROMOTE_THRESHOLD + ' 次后会自动成为候选。\n\n可先执行 /distill run 生成蒸馏索引。');
        return;
      }
      var text = '🎯 **技能候选列表**（高频主题 >= ' + SKILL_PROMOTE_THRESHOLD + ' 次命中）\n\n';
      candidates.forEach(function(c, i) {
        text += (i + 1) + '. **' + c.topic + '**\n';
        text += '   命中: ' + c.hitCount + '次 | 来源: ' + c.sources.join(', ') + '\n';
        text += '   ID: ' + c.id + '\n';
        text += '   提升: /distill promote ' + c.id + '\n\n';
      });
      showMsg(text);
      return;
    }

    if (sub === 'promote') {
      var topicId = parts[1] || '';
      if (!topicId) {
        showMsg('⚠️ 请提供主题 ID: /distill promote topic_0');
        return;
      }
      var result = promoteToSkill(topicId);
      if (result.success) {
        showMsg('✅ 已提升为技能: ' + result.name + '\n技能 ID: ' + result.skillId + '\n\n技能已写入 skills/ 目录，可在技能列表中查看和激活。');
      } else {
        showMsg('❌ 提升失败: ' + result.error);
      }
      return;
    }

    showMsg('📊 知识库蒸馏命令:\n/distill run — 立即执行蒸馏\n/distill status — 查看状态\n/distill candidates — 查看技能候选\n/distill promote <id> — 将高频主题提升为技能');
  });
}

function showMsg(text) {
  var currentId = Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) {
      Core.session.renderMessages(currentId);
    }
  }
}

// ===== 注册定时蒸馏任务 =====
function registerScheduledDistill() {
  if (!Core.scheduler || !Core.scheduler.add) return;

  var existingTasks = Core.scheduler.list();
  var hasDistillTask = existingTasks.some(function(t) {
    return t.name === '知识库每日蒸馏' || (t.action && t.action.message && t.action.message.indexOf('/distill run') >= 0);
  });

  if (hasDistillTask) {
    console.log('[distill] 定时蒸馏任务已存在，跳过创建');
    return;
  }

  Core.scheduler.add({
    name: '知识库每日蒸馏',
    schedule: { type: 'daily', time: '02:00' },
    action: { type: 'send', message: '/distill run' }
  });

  console.log('[distill] 已注册定时蒸馏任务: 每天 02:00');
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    console.warn('[distill] fs/path not available');
    return;
  }

  var dir = Core.knowledge.getKnowledgeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  registerCommands();

  setTimeout(function() {
    registerScheduledDistill();
  }, 2000);

  Core.knowledgeDistill = {
    distill: distill,
    searchDistilled: searchDistilled,
    getSkillCandidates: getSkillCandidates,
    promoteToSkill: promoteToSkill,
    addLesson: addLesson,
    getRelevantLessons: getRelevantLessons,
    formatLessonsForPrompt: formatLessonsForPrompt,
    loadDistilledIndex: loadDistilledIndex,
    loadLessons: loadLessons
  };

  var index = loadDistilledIndex();
  var topicCount = index.topics ? index.topics.length : 0;
  console.log('✅ knowledge-distill.js 已加载 | 蒸馏主题: ' + topicCount + ' | 蒸馏文件: ' + (index.distilledAt ? '有' : '无'));
}

module.exports = {
  name: 'knowledge-distill',
  dependencies: ['knowledge', 'scheduler', 'custom', 'session'],
  init: init
};
