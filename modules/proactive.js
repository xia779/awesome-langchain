// modules/proactive.js - 主动式助理（晨报、智能提醒、上下文感知建议）
'use strict';
const path = require('path');

let Core = null;

// ===== 晨报配置 =====
const DEFAULT_BRIEFING_CONFIG = {
  enabled: false,
  time: '08:30',         // 每日晨报时间
  weekdaysOnly: true,    // 仅工作日
  topics: ['A股大盘', '半导体', '新能源'],  // 关注主题
  includeWeather: false,
  includeCalendar: false
};

let _briefingTaskId = null;

// ===== 生成晨报 =====
async function generateMorningBriefing(options) {
  var cfg = getBriefingConfig();
  var opts = Object.assign({}, cfg, options || {});
  var sections = [];

  try {
    // 1. 大盘行情
    if (Core.stockQuote && Core.stockQuote.fetchQuotes) {
      try {
        var quotes = await Core.stockQuote.fetchQuotes('上证指数,深证成指,创业板指');
        if (quotes && quotes.length > 0) {
          var marketLines = quotes.map(function(q) {
            var arrow = (q.changePercent || 0) >= 0 ? '📈' : '📉';
            return arrow + ' ' + q.name + ': ' + q.price + ' (' + (q.changePercent >= 0 ? '+' : '') + q.changePercent + '%)';
          });
          sections.push('## 大盘行情\n\n' + marketLines.join('\n'));
        }
      } catch (e) {}
    }

    // 2. 关注主题新闻
    if (Core.webSearch && opts.topics && opts.topics.length > 0) {
      var newsItems = [];
      for (var i = 0; i < Math.min(opts.topics.length, 3); i++) {
        try {
          var result = await Core.webSearch(opts.topics[i] + ' 今日要闻');
          if (result) {
            // 提取前 3 条
            var lines = result.split('\n\n').slice(0, 3);
            newsItems.push('### ' + opts.topics[i] + '\n' + lines.join('\n'));
          }
        } catch (e) {}
      }
      if (newsItems.length > 0) {
        sections.push('## 关注领域动态\n\n' + newsItems.join('\n\n'));
      }
    }

    // 3. 待办/提醒
    if (Core.scheduler && Core.scheduler.list) {
      var tasks = Core.scheduler.list();
      var upcoming = tasks.filter(function(t) { return t.enabled && t.nextRun; }).slice(0, 5);
      if (upcoming.length > 0) {
        var taskLines = upcoming.map(function(t) {
          return '• ' + (t.name || t.action || '定时任务') + ' (' + (t.scheduleDesc || '') + ')';
        });
        sections.push('## 今日定时任务\n\n' + taskLines.join('\n'));
      }
    }

    // 4. 监控状态
    if (Core.watcher && Core.watcher.list) {
      var watchers = Core.watcher.list();
      var active = watchers.filter(function(w) { return w.enabled; });
      if (active.length > 0) {
        var watchLines = active.map(function(w) {
          var opText = w.operator === 'lt' ? '<' : w.operator === 'gt' ? '>' : '=';
          return '• ' + w.target + ' ' + opText + ' ' + w.threshold + (w.triggerCount > 0 ? ' (已触发' + w.triggerCount + '次)' : '');
        });
        sections.push('## 活跃监控\n\n' + watchLines.join('\n'));
      }
    }

    // 5. LLM 总结
    var briefing = '';
    if (sections.length > 0 && Core.api) {
      var rawContent = sections.join('\n\n');
      try {
        var result = await Core.api.callAPI(
          '请基于以下信息生成一份简洁的晨报摘要（200字以内），语气轻松专业：\n\n' + rawContent,
          '你是一个AI助理，负责生成每日晨报。简洁、有条理、突出重点。',
          0.5,
          null, null,
          [{ role: 'system', content: '你是一个AI助理，负责生成每日晨报。简洁、有条理、突出重点。' },
           { role: 'user', content: '请基于以下信息生成一份简洁的晨报摘要（200字以内）：\n\n' + rawContent }],
          { disableTools: true, _background: true }
        );
        briefing = (result && result.message && result.message.content) || '';
      } catch (e) {}
    }

    var fullReport = '☀️ **早安晨报** (' + new Date().toLocaleDateString('zh-CN') + ')\n\n';
    if (briefing) fullReport += briefing + '\n\n---\n\n';
    fullReport += sections.join('\n\n');

    // 6. 输出
    // 桌面通知
    try {
      if (typeof Notification !== 'undefined') {
        new Notification('☀️ 早安晨报', { body: briefing || '今日晨报已生成，请查看' });
      }
    } catch (e) {}

    // 会话消息
    if (Core.session && Core.session.addMessage) {
      Core.session.addMessage(fullReport, 'ai');
    }

    // 保存为交付物
    if (Core.deliverables) {
      var fs = require('fs');
      var dir = Core.deliverables.getOutputDir('report');
      var filePath = path.join(dir, new Date().toISOString().slice(0, 10) + '_morning-briefing.md');
      try {
        fs.writeFileSync(filePath, fullReport, 'utf8');
        Core.deliverables.register({
          type: 'report',
          title: '晨报 ' + new Date().toLocaleDateString('zh-CN'),
          filePath: filePath,
          metadata: { format: 'markdown', auto: true }
        });
      } catch (e) {}
    }

    return { success: true, report: fullReport };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 晨报定时注册 =====
function setupBriefingSchedule() {
  var cfg = getBriefingConfig();
  if (!cfg.enabled) return;

  if (Core.scheduler && Core.scheduler.add) {
    // 先清除旧的晨报任务
    if (_briefingTaskId) {
      try { Core.scheduler.delete(_briefingTaskId); } catch (e) {}
    }

    var result = Core.scheduler.add({
      name: '每日晨报',
      schedule: { type: 'daily', time: cfg.time, weekdaysOnly: cfg.weekdaysOnly },
      action: { type: 'custom', handler: 'Core.proactive.briefing()' },
      enabled: true
    });

    if (result && result.id) {
      _briefingTaskId = result.id;
      console.log('📰 晨报定时任务已注册（每日 ' + cfg.time + '）');
    }
  }
}

// ===== 智能建议（上下文感知）=====
function getContextSuggestions(userMessage) {
  var suggestions = [];
  if (!userMessage) return suggestions;

  var msg = userMessage.toLowerCase();

  // 检测研究意图
  if (msg.match(/分析|研究|调研|报告|深度/) && msg.length > 10) {
    suggestions.push({ type: 'deep_research', text: '💡 需要深度研究吗？输入 /research ' + userMessage.substring(0, 20) + '...' });
  }

  // 检测监控意图
  if (msg.match(/跌破|涨到|超过|提醒我|监控|盯着/)) {
    suggestions.push({ type: 'watcher', text: '💡 需要设置价格监控吗？我可以帮你盯着。' });
  }

  // 检测文档学习意图
  if (msg.match(/这个文件|这份文档|学习|学会|记住这个流程/)) {
    suggestions.push({ type: 'learn', text: '💡 想把这个文档变成技能吗？输入 /learn <文件路径>' });
  }

  return suggestions;
}

// ===== 配置 =====
function getBriefingConfig() {
  var cfg = Object.assign({}, DEFAULT_BRIEFING_CONFIG);
  if (Core && Core.config && Core.config.briefing) {
    Object.assign(cfg, Core.config.briefing);
  }
  return cfg;
}

// ===== 模块导出 =====
module.exports = {
  name: 'proactive',
  dependencies: ['scheduler', 'stock-quote'],
  init: function(_Core) {
    Core = _Core;

    Core.proactive = {
      briefing: generateMorningBriefing,
      setupSchedule: setupBriefingSchedule,
      suggestions: getContextSuggestions,
      getBriefingConfig: getBriefingConfig
    };

    // 延迟注册晨报定时
    setTimeout(setupBriefingSchedule, 5000);

    console.log('\u2705 \u4e3b\u52a8\u5f0f\u52a9\u7406\u5df2\u52a0\u8f7d\uff08\u6668\u62a5: ' + (getBriefingConfig().enabled ? '\u5df2\u542f\u7528' : '\u672a\u542f\u7528') + '\uff09');
  }
};
