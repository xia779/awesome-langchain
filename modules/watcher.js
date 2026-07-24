// modules/watcher.js - 条件监控 + 触发提醒（股价/关键词/自定义条件）
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 状态 =====
let _watchers = [];
let _checkTimer = null;
let _watchFile = '';
const CHECK_INTERVAL = 60000; // 每分钟检查一次

// ===== 初始化 =====
function _loadWatchers() {
  try {
    if (fs.existsSync(_watchFile)) {
      _watchers = JSON.parse(fs.readFileSync(_watchFile, 'utf8'));
    }
  } catch (e) { _watchers = []; }
}

function _saveWatchers() {
  try {
    fs.writeFileSync(_watchFile, JSON.stringify(_watchers, null, 2), 'utf8');
  } catch (e) { console.warn('⚠️ [watcher] 操作失败:', e.message || e); }
}

// ===== 添加监控 =====
function addWatcher(options) {
  var w = {
    id: 'watch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    type: options.type || 'stock',   // stock | keyword | custom
    condition: options.condition,     // 条件表达式
    target: options.target || '',     // 监控目标（股票代码/关键词）
    operator: options.operator || 'lt', // lt | gt | eq | contains
    threshold: options.threshold,     // 阈值
    message: options.message || '',   // 触发时的提示消息
    enabled: true,
    triggered: false,
    triggerCount: 0,
    lastTriggerAt: null,
    createdAt: Date.now(),
    cooldownMs: options.cooldownMs || 3600000 // 触发后冷却 1 小时
  };

  // 自然语言解析
  if (!w.condition && options.text) {
    var parsed = _parseNaturalCondition(options.text);
    if (parsed) {
      w.type = parsed.type;
      w.target = parsed.target;
      w.operator = parsed.operator;
      w.threshold = parsed.threshold;
      w.message = options.text;
    }
  }

  _watchers.push(w);
  _saveWatchers();
  _ensureTimer();

  return { success: true, id: w.id, watcher: w };
}

// ===== 自然语言条件解析 =====
function _parseNaturalCondition(text) {
  // 股价监控: "茅台跌破1800" / "上证涨到3500" / "宁德超过300"
  var stockMatch = text.match(/([\u4e00-\u9fa5A-Za-z0-9]+?)(?:跌破|低于|小于|<)\s*(\d+(?:\.\d+)?)/);
  if (stockMatch) {
    return { type: 'stock', target: stockMatch[1], operator: 'lt', threshold: parseFloat(stockMatch[2]) };
  }
  stockMatch = text.match(/([\u4e00-\u9fa5A-Za-z0-9]+?)(?:涨到|超过|高于|大于|突破|>)\s*(\d+(?:\.\d+)?)/);
  if (stockMatch) {
    return { type: 'stock', target: stockMatch[1], operator: 'gt', threshold: parseFloat(stockMatch[2]) };
  }
  stockMatch = text.match(/([\u4e00-\u9fa5A-Za-z0-9]+?)(?:跌到|到)\s*(\d+(?:\.\d+)?)/);
  if (stockMatch) {
    return { type: 'stock', target: stockMatch[1], operator: 'lt', threshold: parseFloat(stockMatch[2]) };
  }
  // 关键词监控
  var kwMatch = text.match(/(?:包含|出现|提到|监控)\s*[""「]?([^""」\n]+)[""」]?/);
  if (kwMatch) {
    return { type: 'keyword', target: kwMatch[1].trim(), operator: 'contains', threshold: null };
  }
  return null;
}

// ===== 检查所有监控 =====
async function checkAll() {
  var now = Date.now();
  var triggered = [];

  for (var i = 0; i < _watchers.length; i++) {
    var w = _watchers[i];
    if (!w.enabled || w.triggered) continue;
    // 冷却期检查
    if (w.lastTriggerAt && (now - w.lastTriggerAt) < w.cooldownMs) continue;

    try {
      var hit = false;

      if (w.type === 'stock') {
        hit = await _checkStockCondition(w);
      } else if (w.type === 'keyword') {
        hit = await _checkKeywordCondition(w);
      }

      if (hit) {
        w.triggered = true;
        w.triggerCount++;
        w.lastTriggerAt = now;
        triggered.push(w);
        _fireNotification(w);
        // 重置 triggered 以便冷却后可再次触发
        setTimeout(function() { w.triggered = false; }, w.cooldownMs);
      }
    } catch (e) {
      // 跳过检查失败的
    }
  }

  if (triggered.length > 0) _saveWatchers();
  return triggered;
}

// ===== 股价条件检查 =====
async function _checkStockCondition(w) {
  if (!Core.stockQuote || !Core.stockQuote.fetchQuotes) return false;

  try {
    var quotes = await Core.stockQuote.fetchQuotes(w.target);
    if (!quotes || quotes.length === 0) return false;

    var price = quotes[0].price || quotes[0].current;
    if (!price) return false;

    if (w.operator === 'lt') return price < w.threshold;
    if (w.operator === 'gt') return price > w.threshold;
    if (w.operator === 'eq') return Math.abs(price - w.threshold) < 0.01;
    return false;
  } catch (e) {
    return false;
  }
}

// ===== 关键词条件检查（搜索最新新闻）=====
async function _checkKeywordCondition(w) {
  if (!Core.webSearch) return false;
  try {
    var result = await Core.webSearch(w.target + ' 最新消息');
    if (result && result.indexOf(w.target) !== -1) {
      // 简单判断：搜索结果中包含关键词即触发
      return true;
    }
    return false;
  } catch (e) { return false; }
}

// ===== 触发通知 =====
function _fireNotification(w) {
  var title = '⚠️ 监控提醒';
  var body = '';

  if (w.type === 'stock') {
    var opText = w.operator === 'lt' ? '跌破' : w.operator === 'gt' ? '突破' : '到达';
    body = w.target + ' 已' + opText + ' ' + w.threshold;
  } else {
    body = '监控关键词「' + w.target + '」有新动态';
  }
  if (w.message) body += '\n' + w.message;

  // 桌面通知
  try {
    if (typeof Notification !== 'undefined') {
      new Notification(title, { body: body });
    }
  } catch (e) { console.warn('⚠️ [watcher] 操作失败:', e.message || e); }

  // 应用内通知
  if (Core.notifications && Core.notifications.pushWarning) {
    Core.notifications.pushWarning(title, body);
  }

  // 会话消息
  if (Core.session && Core.session.addMessage) {
    Core.session.addMessage('🔔 **监控提醒**\n\n' + body + '\n\n（监控ID: ' + w.id + '，可在设置中管理）', 'ai');
  }

  console.log('🔔 Watcher triggered: ' + w.id + ' - ' + body);
}

// ===== 定时器管理 =====
function _ensureTimer() {
  if (_checkTimer) return;
  if (_watchers.some(function(w) { return w.enabled; })) {
    _checkTimer = setInterval(function() {
      checkAll().catch(function(e) { console.warn('⚠️ [watcher] checkAll 失败:', e.message || e); });
    }, CHECK_INTERVAL);
  }
}

function _stopTimer() {
  if (_checkTimer) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }
}

// ===== 管理接口 =====
function listWatchers() {
  return _watchers.map(function(w) {
    return {
      id: w.id, type: w.type, target: w.target,
      operator: w.operator, threshold: w.threshold,
      enabled: w.enabled, triggerCount: w.triggerCount,
      message: w.message, lastTriggerAt: w.lastTriggerAt
    };
  });
}

function removeWatcher(id) {
  var idx = _watchers.findIndex(function(w) { return w.id === id; });
  // 模糊匹配：按 target 或 message 包含关系查找
  if (idx === -1) {
    var lowerId = id.toLowerCase().replace(/^watch\s*/, '');
    idx = _watchers.findIndex(function(w) {
      return (w.target && lowerId.indexOf(w.target.toLowerCase()) >= 0) ||
             (w.message && lowerId.indexOf(w.message.toLowerCase()) >= 0) ||
             (w.target && w.target.toLowerCase().indexOf(lowerId) >= 0);
    });
  }
  if (idx === -1) return { success: false, error: '未找到监控: ' + id };
  _watchers.splice(idx, 1);
  _saveWatchers();
  if (_watchers.length === 0) _stopTimer();
  return { success: true };
}

function toggleWatcher(id, enabled) {
  var w = _watchers.find(function(w) { return w.id === id; });
  // 模糊匹配：按 target 或 message 包含关系查找
  if (!w) {
    var lowerId = id.toLowerCase().replace(/^watch\s*/, '');
    w = _watchers.find(function(w) {
      return (w.target && lowerId.indexOf(w.target.toLowerCase()) >= 0) ||
             (w.message && lowerId.indexOf(w.message.toLowerCase()) >= 0) ||
             (w.target && w.target.toLowerCase().indexOf(lowerId) >= 0);
    });
  }
  if (!w) return { success: false, error: '未找到监控: ' + id };
  w.enabled = enabled !== undefined ? enabled : !w.enabled;
  _saveWatchers();
  if (w.enabled) _ensureTimer();
  return { success: true, enabled: w.enabled };
}

// ===== 模块导出 =====
module.exports = {
  name: 'watcher',
  dependencies: ['stock-quote'],
  init: function(_Core) {
    Core = _Core;
    _watchFile = Core.pathService.perUser('watchers.json');
    _loadWatchers();

    Core.watcher = {
      add: addWatcher,
      check: checkAll,
      list: listWatchers,
      remove: removeWatcher,
      toggle: toggleWatcher
    };

    // 启动时如果有活跃监控，开始定时检查
    if (_watchers.some(function(w) { return w.enabled; })) {
      setTimeout(_ensureTimer, 10000);
    }

    console.log('\u2705 \u76d1\u63a7\u63d0\u9192\u6a21\u5757\u5df2\u52a0\u8f7d\uff08' + _watchers.length + ' \u4e2a\u76d1\u63a7\uff09');
  }
};
