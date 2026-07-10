// modules/analytics.js - 数据分析仪表盘模块
// 追踪和可视化使用统计：消息量、Token 用量、模型分布、活跃时段等
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 分析数据存储 =====
var _analyticsDir = '';
var _dailyStats = {};  // { 'YYYY-MM-DD': { messages, tokens, models, commands, ... } }

function getAnalyticsDir() {
  if (_analyticsDir) return _analyticsDir;
  if (Core && Core.DATA_ROOT) {
    _analyticsDir = path.join(Core.DATA_ROOT, 'analytics');
    if (!fs.existsSync(_analyticsDir)) fs.mkdirSync(_analyticsDir, { recursive: true });
    return _analyticsDir;
  }
  return '';
}

// ===== 加载/保存统计数据 =====
function loadStats() {
  var dir = getAnalyticsDir();
  if (!dir) return;
  var filePath = path.join(dir, 'daily_stats.json');
  if (fs.existsSync(filePath)) {
    try { _dailyStats = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { _dailyStats = {}; }
  }
}

function saveStats() {
  var dir = getAnalyticsDir();
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, 'daily_stats.json'), JSON.stringify(_dailyStats, null, 2));
  } catch (e) { console.warn('保存统计数据失败:', e.message); }
}

function _today() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _getTodayStats() {
  var key = _today();
  if (!_dailyStats[key]) {
    _dailyStats[key] = {
      messages: 0, userMessages: 0, aiMessages: 0,
      tokens: { input: 0, output: 0 },
      models: {},       // { model_name: count }
      providers: {},    // { provider: count }
      commands: {},     // { command: count }
      sessions: 0,
      tools: {},        // { tool_name: count }
      agentSteps: 0,
      errors: 0,
      knowledgeSearches: 0,
      voiceUses: 0,
      screenshots: 0,
      workflows: 0,
      timestamps: []    // array of hour values (0-23) for activity heatmap
    };
  }
  return _dailyStats[key];
}

// ===== 事件追踪 API =====
function trackMessage(role, model, provider) {
  var stats = _getTodayStats();
  stats.messages++;
  if (role === 'user') stats.userMessages++;
  else if (role === 'assistant' || role === 'ai') stats.aiMessages++;
  if (model) {
    stats.models[model] = (stats.models[model] || 0) + 1;
  }
  if (provider) {
    stats.providers[provider] = (stats.providers[provider] || 0) + 1;
  }
  // 记录活跃时段
  var hour = new Date().getHours();
  stats.timestamps.push(hour);
  saveStats();
}

function trackTokens(inputTokens, outputTokens) {
  var stats = _getTodayStats();
  stats.tokens.input += (inputTokens || 0);
  stats.tokens.output += (outputTokens || 0);
}

function trackCommand(commandName) {
  var stats = _getTodayStats();
  stats.commands[commandName] = (stats.commands[commandName] || 0) + 1;
}

function trackToolUse(toolName) {
  var stats = _getTodayStats();
  stats.tools[toolName] = (stats.tools[toolName] || 0) + 1;
}

function trackAgentStep() {
  var stats = _getTodayStats();
  stats.agentSteps++;
}

function trackError() {
  var stats = _getTodayStats();
  stats.errors++;
}

function trackSession() {
  var stats = _getTodayStats();
  stats.sessions++;
}

function trackFeature(featureName) {
  var stats = _getTodayStats();
  if (featureName === 'knowledge') stats.knowledgeSearches++;
  else if (featureName === 'voice') stats.voiceUses++;
  else if (featureName === 'screenshot') stats.screenshots++;
  else if (featureName === 'workflow') stats.workflows++;
}

// ===== 分析查询 =====
function getOverview(days) {
  days = days || 7;
  var now = new Date();
  var result = {
    totalMessages: 0, totalUserMessages: 0, totalAiMessages: 0,
    totalTokens: { input: 0, output: 0 },
    totalSessions: 0, totalAgentSteps: 0, totalErrors: 0,
    totalCommands: 0, totalToolUses: 0,
    modelDistribution: {}, providerDistribution: {},
    dailyMessages: [], dailyTokens: [],
    peakHour: 0, avgMessagesPerDay: 0
  };

  var allHours = {};
  for (var d = 0; d < days; d++) {
    var date = new Date(now);
    date.setDate(date.getDate() - d);
    var key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    var dayStats = _dailyStats[key];

    if (dayStats) {
      result.totalMessages += dayStats.messages;
      result.totalUserMessages += dayStats.userMessages;
      result.totalAiMessages += dayStats.aiMessages;
      result.totalTokens.input += dayStats.tokens.input;
      result.totalTokens.output += dayStats.tokens.output;
      result.totalSessions += dayStats.sessions;
      result.totalAgentSteps += dayStats.agentSteps;
      result.totalErrors += dayStats.errors;
      result.dailyMessages.push({ date: key, count: dayStats.messages });
      result.dailyTokens.push({ date: key, input: dayStats.tokens.input, output: dayStats.tokens.output });

      // 聚合模型分布
      for (var m in dayStats.models) {
        result.modelDistribution[m] = (result.modelDistribution[m] || 0) + dayStats.models[m];
      }
      for (var p in dayStats.providers) {
        result.providerDistribution[p] = (result.providerDistribution[p] || 0) + dayStats.providers[p];
      }
      // 聚合命令使用
      for (var c in dayStats.commands) {
        result.totalCommands += dayStats.commands[c];
      }
      for (var t in dayStats.tools) {
        result.totalToolUses += dayStats.tools[t];
      }
      // 聚合活跃时段
      if (dayStats.timestamps) {
        dayStats.timestamps.forEach(function(h) { allHours[h] = (allHours[h] || 0) + 1; });
      }
    } else {
      result.dailyMessages.push({ date: key, count: 0 });
      result.dailyTokens.push({ date: key, input: 0, output: 0 });
    }
  }

  result.dailyMessages.reverse();
  result.dailyTokens.reverse();
  result.avgMessagesPerDay = days > 0 ? Math.round(result.totalMessages / days) : 0;

  // 找出最活跃时段
  var maxHourCount = 0;
  for (var h in allHours) {
    if (allHours[h] > maxHourCount) { maxHourCount = allHours[h]; result.peakHour = parseInt(h); }
  }

  return result;
}

// ===== 从 DB 获取深度分析 =====
function getDeepAnalysis() {
  var result = {
    totalSessionsInDb: 0, totalMessagesInDb: 0,
    oldestSession: null, newestSession: null,
    avgMessagesPerSession: 0, longestSession: null,
    topSessionsByMessages: [], roleDistribution: {},
    memoryCount: 0, knowledgeDocCount: 0
  };

  try {
    if (Core.db) {
      // 总会话数
      var sessionCount = Core.db.query ? Core.db.query('SELECT COUNT(*) as cnt FROM sessions') : null;
      if (sessionCount && sessionCount[0]) result.totalSessionsInDb = sessionCount[0].cnt;

      // 总消息数
      var msgCount = Core.db.query ? Core.db.query('SELECT COUNT(*) as cnt FROM messages') : null;
      if (msgCount && msgCount[0]) result.totalMessagesInDb = msgCount[0].cnt;

      // 最旧/最新会话
      var oldest = Core.db.query ? Core.db.query('SELECT id, title, created_at FROM sessions ORDER BY created_at ASC LIMIT 1') : null;
      if (oldest && oldest[0]) result.oldestSession = oldest[0];

      var newest = Core.db.query ? Core.db.query('SELECT id, title, created_at FROM sessions ORDER BY created_at DESC LIMIT 1') : null;
      if (newest && newest[0]) result.newestSession = newest[0];

      // 平均每会话消息数
      if (result.totalSessionsInDb > 0) {
        result.avgMessagesPerSession = Math.round(result.totalMessagesInDb / result.totalSessionsInDb);
      }

      // 消息最多的会话 top5
      var topSessions = Core.db.query ? Core.db.query('SELECT s.id, s.title, COUNT(m.id) as msg_count FROM sessions s JOIN messages m ON s.id = m.session_id GROUP BY s.id ORDER BY msg_count DESC LIMIT 5') : null;
      if (topSessions) result.topSessionsByMessages = topSessions;

      // 角色分布
      var roles = Core.db.query ? Core.db.query('SELECT role_type, COUNT(*) as cnt FROM sessions WHERE role_type IS NOT NULL GROUP BY role_type') : null;
      if (roles) {
        roles.forEach(function(r) { result.roleDistribution[r.role_type] = r.cnt; });
      }

      // 记忆数
      var memCount = Core.db.query ? Core.db.query('SELECT COUNT(*) as cnt FROM memories') : null;
      if (memCount && memCount[0]) result.memoryCount = memCount[0].cnt;
    }

    // 知识库文档数
    if (Core.knowledge && Core.knowledge.listDocuments) {
      result.knowledgeDocCount = (Core.knowledge.listDocuments() || []).length;
    }
  } catch (e) {
    console.warn('深度分析查询失败:', e.message);
  }

  return result;
}

// ===== 生成仪表盘文本 =====
function generateDashboardText(days) {
  var overview = getOverview(days || 7);
  var deep = getDeepAnalysis();

  var text = '📊 **数据分析仪表盘**\n\n';

  // 概览卡片
  text += '## 📈 概览（近 ' + (days || 7) + ' 天）\n\n';
  text += '| 指标 | 数值 |\n|---|---|\n';
  text += '| 总消息 | ' + overview.totalMessages + ' |\n';
  text += '| 用户消息 | ' + overview.totalUserMessages + ' |\n';
  text += '| AI 回复 | ' + overview.totalAiMessages + ' |\n';
  text += '| 日均消息 | ' + overview.avgMessagesPerDay + ' |\n';
  text += '| Token 消耗 | 输入 ' + overview.totalTokens.input.toLocaleString() + ' / 输出 ' + overview.totalTokens.output.toLocaleString() + ' |\n';
  text += '| 新建会话 | ' + overview.totalSessions + ' |\n';
  text += '| Agent 步骤 | ' + overview.totalAgentSteps + ' |\n';
  text += '| 工具调用 | ' + overview.totalToolUses + ' |\n';
  text += '| 命令使用 | ' + overview.totalCommands + ' |\n';
  text += '| 错误数 | ' + overview.totalErrors + ' |\n';
  text += '| 最活跃时段 | ' + overview.peakHour + ':00 |\n\n';

  // 每日消息趋势（ASCII 柱状图）
  text += '## 📉 每日消息趋势\n\n';
  if (overview.dailyMessages.length > 0) {
    var maxCount = Math.max.apply(null, overview.dailyMessages.map(function(d) { return d.count; })) || 1;
    overview.dailyMessages.forEach(function(d) {
      var barLen = Math.round((d.count / maxCount) * 20);
      var bar = '';
      for (var i = 0; i < 20; i++) bar += i < barLen ? '█' : '░';
      var dateShort = d.date.substring(5); // MM-DD
      text += dateShort + ' ' + bar + ' ' + d.count + '\n';
    });
    text += '\n';
  }

  // 模型分布
  text += '## 🤖 模型使用分布\n\n';
  var models = Object.entries(overview.modelDistribution).sort(function(a, b) { return b[1] - a[1]; });
  var totalModelUses = models.reduce(function(sum, m) { return sum + m[1]; }, 0) || 1;
  models.slice(0, 8).forEach(function(m) {
    var pct = Math.round(m[1] / totalModelUses * 100);
    var barLen = Math.round(pct / 5);
    var bar = '';
    for (var i = 0; i < 20; i++) bar += i < barLen ? '▓' : '░';
    text += m[0] + ': ' + bar + ' ' + pct + '% (' + m[1] + ')\n';
  });
  text += '\n';

  // Provider 分布
  text += '## ☁️ 服务商分布\n\n';
  var providers = Object.entries(overview.providerDistribution).sort(function(a, b) { return b[1] - a[1]; });
  providers.forEach(function(p) {
    text += '• **' + p[0] + '**: ' + p[1] + ' 次\n';
  });
  text += '\n';

  // DB 深度数据
  text += '## 💾 数据库统计\n\n';
  text += '| 指标 | 数值 |\n|---|---|\n';
  text += '| 数据库会话 | ' + deep.totalSessionsInDb + ' |\n';
  text += '| 数据库消息 | ' + deep.totalMessagesInDb + ' |\n';
  text += '| 平均消息/会话 | ' + deep.avgMessagesPerSession + ' |\n';
  text += '| 记忆条目 | ' + deep.memoryCount + ' |\n';
  text += '| 知识库文档 | ' + deep.knowledgeDocCount + ' |\n';
  if (deep.oldestSession) text += '| 最早会话 | ' + (deep.oldestSession.title || '未命名') + ' |\n';
  text += '\n';

  // Top 会话
  if (deep.topSessionsByMessages.length > 0) {
    text += '## 🏆 消息最多的会话\n\n';
    deep.topSessionsByMessages.forEach(function(s, i) {
      text += (i + 1) + '. **' + (s.title || '未命名') + '** — ' + s.msg_count + ' 条消息\n';
    });
    text += '\n';
  }

  // 角色分布
  if (Object.keys(deep.roleDistribution).length > 0) {
    text += '## 🎭 角色分布\n\n';
    var roleNames = { master: '👑 主管', coder: '💻 代码', writer: '✍️ 写手', analyst: '📊 分析', teacher: '🎓 导师', chat: '💬 普通' };
    for (var role in deep.roleDistribution) {
      text += '• ' + (roleNames[role] || role) + ': ' + deep.roleDistribution[role] + ' 个\n';
    }
  }

  return text;
}

// ===== 活跃度热力图（文本版）=====
function generateHeatmap() {
  var now = new Date();
  var hours = {};
  var weekdays = ['日', '一', '二', '三', '四', '五', '六'];

  // 统计近 30 天每天每小时的活跃度
  for (var d = 0; d < 30; d++) {
    var date = new Date(now);
    date.setDate(date.getDate() - d);
    var key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    var dayStats = _dailyStats[key];
    if (dayStats && dayStats.timestamps) {
      var dayOfWeek = date.getDay();
      if (!hours[dayOfWeek]) hours[dayOfWeek] = {};
      dayStats.timestamps.forEach(function(h) {
        hours[dayOfWeek][h] = (hours[dayOfWeek][h] || 0) + 1;
      });
    }
  }

  var text = '🔥 **活跃度热力图**（近 30 天）\n\n';
  text += '时段:  0  2  4  6  8 10 12 14 16 18 20 22\n';

  for (var w = 0; w < 7; w++) {
    text += '周' + weekdays[w] + ' ';
    for (var h = 0; h < 24; h += 2) {
      var count = (hours[w] && hours[w][h]) || 0;
      if (count === 0) text += '·  ';
      else if (count < 3) text += '░  ';
      else if (count < 6) text += '▒  ';
      else if (count < 10) text += '▓  ';
      else text += '█  ';
    }
    text += '\n';
  }

  text += '\n· 无活动  ░ 少量  ▒ 中等  ▓ 较多  █ 密集\n';
  return text;
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  loadStats();

  // 注入追踪钩子到 api.js 的 typingEnd 事件
  if (Core.on) {
    Core.on('typingEnd', function() {
      // 每次回复结束追踪一次
      var currentId = Core.session ? Core.session.getCurrentId() : null;
      var session = currentId && Core.session.sessions ? Core.session.sessions[currentId] : null;
      var model = Core.dom && Core.dom.modelSelect ? Core.dom.modelSelect.value : '';
      var provider = model.split(':')[0] || 'ollama';
      trackMessage('assistant', model, provider);
    });
  }

  // 注册 /analytics 命令
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('analytics', {
      description: '数据分析: /analytics [7|14|30|heatmap]',
      action: function(args) {
        var sub = (args || '').trim();
        if (sub === 'heatmap' || sub === 'heat') {
          Core.session.addMessage(generateHeatmap(), 'assistant');
        } else if (sub === 'raw' || sub === 'json') {
          var raw = JSON.stringify(_dailyStats, null, 2);
          if (raw.length > 5000) raw = raw.substring(0, 5000) + '\n\n[数据已截断]';
          Core.session.addMessage('📊 **原始统计 JSON**\n\n```json\n' + raw + '\n```', 'assistant');
        } else {
          var days = parseInt(sub) || 7;
          if (days > 90) days = 90;
          Core.session.addMessage(generateDashboardText(days), 'assistant');
        }
      }
    });

    Core.custom.registerCommand('stats', {
      description: '快速统计: /stats',
      action: function() {
        var today = _getTodayStats();
        var overview = getOverview(1);
        var text = '📊 **今日统计**\n\n';
        text += '消息: ' + today.messages + ' (用户 ' + today.userMessages + ' / AI ' + today.aiMessages + ')\n';
        text += 'Token: 输入 ' + today.tokens.input.toLocaleString() + ' / 输出 ' + today.tokens.output.toLocaleString() + '\n';
        text += 'Agent 步骤: ' + today.agentSteps + '\n';
        text += '工具调用: ' + Object.values(today.tools).reduce(function(s, v) { return s + v; }, 0) + '\n';
        text += '命令使用: ' + Object.values(today.commands).reduce(function(s, v) { return s + v; }, 0) + '\n';
        text += '错误: ' + today.errors + '\n';
        Core.session.addMessage(text, 'assistant');
      }
    });
  }

  // 暴露 API
  Core.analytics = {
    track: {
      message: trackMessage,
      tokens: trackTokens,
      command: trackCommand,
      tool: trackToolUse,
      agentStep: trackAgentStep,
      error: trackError,
      session: trackSession,
      feature: trackFeature
    },
    get: {
      overview: getOverview,
      deepAnalysis: getDeepAnalysis,
      dashboard: generateDashboardText,
      heatmap: generateHeatmap,
      todayStats: _getTodayStats
    }
  };

  console.log('✅ analytics.js 已加载 | 历史数据: ' + Object.keys(_dailyStats).length + ' 天');
}

module.exports = { name: 'analytics', dependencies: ['custom', 'session'], init };
