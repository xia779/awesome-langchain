// modules/adaptive-engine.js - 自适应学习引擎 (P7-1)
// 用户行为模式识别 + 个性化推荐 + 交互质量追踪
'use strict';

var Core = null;
var fs = null;
var path = null;

var PROFILE_FILE = '';
var _profile = {
  behaviorPatterns: {},    // { patternId: { count, lastSeen, weight } }
  topicAffinity: {},       // { topic: score }
  timePatterns: { hourDistribution: [], dayDistribution: [] },
  interactionQuality: { totalSessions: 0, avgLength: 0, satisfactionSignals: 0 },
  preferences: { responseLength: 'medium', codeStyle: '', formality: 'neutral' },
  recommendations: [],
  lastUpdated: null
};

// ===== 持久化 =====
function loadProfile() {
  if (!Core || !Core.DATA_ROOT) return;
  PROFILE_FILE = path.join(Core.DATA_ROOT, 'adaptive-profile.json');
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      var data = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      Object.assign(_profile, data);
    }
  } catch (e) { /* fresh */ }
  if (!_profile.timePatterns.hourDistribution) _profile.timePatterns.hourDistribution = new Array(24).fill(0);
  if (!_profile.timePatterns.dayDistribution) _profile.timePatterns.dayDistribution = new Array(7).fill(0);
}

function saveProfile() {
  try {
    _profile.lastUpdated = Date.now();
    if (PROFILE_FILE) fs.writeFileSync(PROFILE_FILE, JSON.stringify(_profile, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

// ===== 行为记录 =====
function recordInteraction(message, response, metadata) {
  metadata = metadata || {};
  var now = new Date();

  // 时间模式
  _profile.timePatterns.hourDistribution[now.getHours()]++;
  _profile.timePatterns.dayDistribution[now.getDay()]++;

  // 主题亲和度
  var topics = _extractTopics(message);
  topics.forEach(function(topic) {
    _profile.topicAffinity[topic] = (_profile.topicAffinity[topic] || 0) + 1;
  });

  // 行为模式
  var patterns = _detectPatterns(message, metadata);
  patterns.forEach(function(p) {
    if (!_profile.behaviorPatterns[p]) {
      _profile.behaviorPatterns[p] = { count: 0, lastSeen: 0, weight: 1 };
    }
    _profile.behaviorPatterns[p].count++;
    _profile.behaviorPatterns[p].lastSeen = Date.now();
  });

  // 交互质量
  _profile.interactionQuality.totalSessions++;
  var msgLen = (message || '').length;
  var respLen = (response || '').length;
  _profile.interactionQuality.avgLength = Math.round(
    (_profile.interactionQuality.avgLength * (_profile.interactionQuality.totalSessions - 1) + msgLen) /
    _profile.interactionQuality.totalSessions
  );

  // 满意度信号检测
  if (_isSatisfactionSignal(message)) {
    _profile.interactionQuality.satisfactionSignals++;
  }

  // 响应长度偏好学习
  if (respLen > 0) {
    if (respLen < 200) _updatePreference('responseLength', 'short');
    else if (respLen > 1000) _updatePreference('responseLength', 'long');
    else _updatePreference('responseLength', 'medium');
  }

  saveProfile();
}

function _extractTopics(text) {
  if (!text) return [];
  var topics = [];
  var topicPatterns = [
    { re: /代码|编程|函数|bug|debug|api|框架/i, topic: 'programming' },
    { re: /研究|分析|报告|调研|论文/i, topic: 'research' },
    { re: /写|文章|文案|翻译|润色/i, topic: 'writing' },
    { re: /数据|图表|统计|可视化/i, topic: 'data' },
    { re: /设计|ui|界面|前端|css/i, topic: 'design' },
    { re: /股票|基金|投资|行情|涨|跌/i, topic: 'finance' },
    { re: /日程|提醒|安排|计划|todo/i, topic: 'productivity' },
    { re: /学习|教程|解释|什么是|怎么/i, topic: 'learning' }
  ];
  topicPatterns.forEach(function(tp) {
    if (tp.re.test(text)) topics.push(tp.topic);
  });
  return topics;
}

function _detectPatterns(message, metadata) {
  var patterns = [];
  if (!message) return patterns;
  if (message.length > 500) patterns.push('long_input');
  if (message.length < 20) patterns.push('short_input');
  if (/\?|？/.test(message)) patterns.push('question');
  if (/帮我|请|麻烦/.test(message)) patterns.push('polite_request');
  if (/代码|code|function|def |class /.test(message)) patterns.push('code_related');
  if (metadata.hasAttachment) patterns.push('multimodal');
  if (metadata.isFollowUp) patterns.push('multi_turn');
  return patterns;
}

function _isSatisfactionSignal(message) {
  return /谢谢|感谢|太好了|不错|很好|完美|excellent|thanks|great|perfect/i.test(message || '');
}

function _updatePreference(key, value) {
  // 简单多数投票
  if (!_profile.preferences._votes) _profile.preferences._votes = {};
  if (!_profile.preferences._votes[key]) _profile.preferences._votes[key] = {};
  _profile.preferences._votes[key][value] = (_profile.preferences._votes[key][value] || 0) + 1;
  var votes = _profile.preferences._votes[key];
  var maxVal = '', maxCount = 0;
  Object.keys(votes).forEach(function(v) {
    if (votes[v] > maxCount) { maxCount = votes[v]; maxVal = v; }
  });
  _profile.preferences[key] = maxVal;
}

// ===== 个性化推荐 =====
function getRecommendations() {
  var recs = [];
  var topTopics = Object.keys(_profile.topicAffinity)
    .sort(function(a, b) { return _profile.topicAffinity[b] - _profile.topicAffinity[a]; })
    .slice(0, 3);

  if (topTopics.length > 0) {
    recs.push({ type: 'topic', message: '你最近关注: ' + topTopics.join(', '), topics: topTopics });
  }

  // 时间建议
  var peakHour = _profile.timePatterns.hourDistribution.indexOf(Math.max.apply(null, _profile.timePatterns.hourDistribution));
  if (peakHour >= 0 && _profile.interactionQuality.totalSessions > 10) {
    recs.push({ type: 'time', message: '你最活跃的时段是 ' + peakHour + ':00-' + (peakHour + 1) + ':00' });
  }

  // 行为建议
  var topPatterns = Object.keys(_profile.behaviorPatterns)
    .sort(function(a, b) { return _profile.behaviorPatterns[b].count - _profile.behaviorPatterns[a].count; })
    .slice(0, 3);
  if (topPatterns.indexOf('code_related') >= 0) {
    recs.push({ type: 'feature', message: '提示: 可以使用 /code-index 索引项目代码获得更好的代码辅助' });
  }
  if (topPatterns.indexOf('question') >= 0 && _profile.topicAffinity['research']) {
    recs.push({ type: 'feature', message: '提示: 深度研究模式可以帮你系统性地调研问题' });
  }

  _profile.recommendations = recs;
  return recs;
}

// ===== 个性化 Prompt 增强 =====
function getPersonalizationDirective() {
  var parts = [];
  var prefs = _profile.preferences;

  if (prefs.responseLength === 'short') parts.push('用户偏好简短回复，尽量精炼');
  else if (prefs.responseLength === 'long') parts.push('用户偏好详细回复，可以展开说明');

  if (prefs.formality === 'casual') parts.push('用户喜欢轻松的对话风格');
  else if (prefs.formality === 'formal') parts.push('用户偏好正式专业的表达');

  var topTopics = Object.keys(_profile.topicAffinity)
    .sort(function(a, b) { return _profile.topicAffinity[b] - _profile.topicAffinity[a]; })
    .slice(0, 2);
  if (topTopics.length > 0) {
    parts.push('用户主要关注领域: ' + topTopics.join(', '));
  }

  if (_profile.interactionQuality.totalSessions > 50) {
    parts.push('这是长期用户（' + _profile.interactionQuality.totalSessions + '次交互），可以省略基础解释');
  }

  return parts.length > 0 ? parts.join('。') + '。' : '';
}

// ===== 统计查询 =====
function getProfile() {
  return {
    totalInteractions: _profile.interactionQuality.totalSessions,
    avgMessageLength: _profile.interactionQuality.avgLength,
    satisfactionRate: _profile.interactionQuality.totalSessions > 0
      ? Math.round(_profile.interactionQuality.satisfactionSignals / _profile.interactionQuality.totalSessions * 100) : 0,
    topTopics: Object.keys(_profile.topicAffinity)
      .sort(function(a, b) { return _profile.topicAffinity[b] - _profile.topicAffinity[a]; })
      .slice(0, 5),
    preferences: { responseLength: _profile.preferences.responseLength, formality: _profile.preferences.formality },
    peakHour: _profile.timePatterns.hourDistribution.indexOf(Math.max.apply(null, _profile.timePatterns.hourDistribution)),
    lastUpdated: _profile.lastUpdated
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'adaptive-engine',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }
    loadProfile();
    Core.adaptiveEngine = {
      record: recordInteraction,
      recommend: getRecommendations,
      personalize: getPersonalizationDirective,
      profile: getProfile,
      _extractTopics: _extractTopics,
      _detectPatterns: _detectPatterns
    };
    console.log('\u2705 adaptive-engine \u5df2\u52a0\u8f7d\uff08\u81ea\u9002\u5e94\u5b66\u4e60: ' + _profile.interactionQuality.totalSessions + ' \u6b21\u4ea4\u4e92\u8bb0\u5f55\uff09');
  }
};
