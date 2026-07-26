// modules/trigger-engine.js - 统一触发引擎 (P5-1)
'use strict';

var Core = null;
var fs = null;
var path = null;

var TRIGGERS_FILE = '';
var triggers = [];
var _eventBus = {};
var _cooldowns = {};

function loadTriggers() {
  if (!Core || !Core.DATA_ROOT) return;
  TRIGGERS_FILE = path.join(Core.DATA_ROOT, 'triggers.json');
  try {
    if (fs.existsSync(TRIGGERS_FILE)) {
      var data = JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8'));
      if (Array.isArray(data)) triggers = data;
    }
  } catch (e) { triggers = []; }
}

function saveTriggers() {
  try {
    if (TRIGGERS_FILE) fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(triggers, null, 2), 'utf8');
  } catch (e) { console.error('trigger-engine: 保存失败', e.message); }
}

// ===== 事件总线 =====
function on(event, callback) {
  if (!_eventBus[event]) _eventBus[event] = [];
  _eventBus[event].push(callback);
}

function off(event, callback) {
  if (!_eventBus[event]) return;
  if (callback) _eventBus[event] = _eventBus[event].filter(function(cb) { return cb !== callback; });
  else delete _eventBus[event];
}

function emit(event, data) {
  var listeners = _eventBus[event] || [];
  listeners.forEach(function(cb) {
    try { cb(data); } catch (e) { console.warn('trigger-engine: 事件回调错误 [' + event + ']', e.message); }
  });
  _checkEventTriggers(event, data);
}

// ===== 条件评估 =====
function evaluateCondition(condition, context) {
  if (!condition) return false;
  context = context || {};

  switch (condition.type) {
    case 'keyword':
      var text = String(context.message || context.text || '').toLowerCase();
      var keywords = (condition.pattern || '').toLowerCase().split(',').map(function(k) { return k.trim(); });
      return keywords.some(function(kw) { return kw && text.indexOf(kw) >= 0; });

    case 'regex':
      try { return new RegExp(condition.pattern, condition.flags || 'i').test(String(context.message || context.text || '')); }
      catch (e) { return false; }

    case 'event':
      return context._event === condition.event;

    case 'threshold':
      var value = context[condition.field] || 0;
      var threshold = condition.value || 0;
      switch (condition.operator) {
        case '>': return value > threshold;
        case '>=': return value >= threshold;
        case '<': return value < threshold;
        case '<=': return value <= threshold;
        case '==': return value === threshold;
        case '!=': return value !== threshold;
        default: return false;
      }

    case 'compound':
      var conditions = condition.conditions || [];
      var logic = condition.logic || 'and';
      if (logic === 'and') return conditions.every(function(c) { return evaluateCondition(c, context); });
      return conditions.some(function(c) { return evaluateCondition(c, context); });

    case 'time_range':
      var hour = new Date().getHours();
      var start = condition.startHour || 0;
      var end = condition.endHour || 24;
      if (start <= end) return hour >= start && hour < end;
      return hour >= start || hour < end;

    case 'day_of_week':
      return (condition.days || []).indexOf(new Date().getDay()) >= 0;

    default:
      return false;
  }
}

// ===== 触发器检查 =====
function _checkEventTriggers(event, data) {
  var context = Object.assign({}, data, { _event: event });
  _checkTriggers('event', context);
}

function checkMessageTriggers(message) {
  _checkTriggers('message', { message: message, text: message });
}

function _checkTriggers(triggerType, context) {
  var now = Date.now();
  triggers.forEach(function(trigger) {
    if (!trigger.enabled) return;
    if (trigger.type !== triggerType && trigger.type !== 'compound') return;
    var cooldown = trigger.cooldown || 0;
    if (cooldown > 0 && _cooldowns[trigger.id] && (now - _cooldowns[trigger.id]) < cooldown) return;
    var matched = evaluateCondition(trigger.condition, context);
    if (!matched) return;
    _cooldowns[trigger.id] = now;
    trigger.lastFired = now;
    trigger.fireCount = (trigger.fireCount || 0) + 1;
    saveTriggers();
    _executeTriggerAction(trigger, context);
  });
}

async function _executeTriggerAction(trigger, context) {
  var action = trigger.action || {};
  console.log('\u26a1 trigger-engine: 触发 "' + trigger.name + '"');
  try {
    switch (action.type) {
      case 'send_message':
        if (Core.dom && Core.dom.input && Core.api && Core.api.sendMessage) {
          var msg = (action.message || '').replace(/\{\{(\w+)\}\}/g, function(_, k) { return context[k] || ''; });
          Core.dom.input.value = msg;
          await Core.api.sendMessage();
        }
        break;
      case 'notify':
        if (Core.imNotify && Core.imNotify.push) {
          var text = (action.message || trigger.name).replace(/\{\{(\w+)\}\}/g, function(_, k) { return context[k] || ''; });
          await Core.imNotify.push(text, { title: action.title || '触发通知' });
        }
        break;
      case 'run_workflow':
        if (Core.workflow && Core.workflow.engine && Core.workflow.engine.run) {
          await Core.workflow.engine.run(action.workflowId, context.message || JSON.stringify(context));
        }
        break;
      case 'run_task':
        if (Core.scheduler && Core.scheduler.runNow) Core.scheduler.runNow(action.taskId);
        break;
      case 'custom':
        if (action.handler && typeof action.handler === 'function') action.handler(context);
        break;
      case 'log':
        console.log('\u26a1 [trigger:' + trigger.name + '] ' + JSON.stringify(context).substring(0, 200));
        break;
    }
  } catch (e) {
    console.error('trigger-engine: 动作执行失败 [' + trigger.name + ']', e.message);
  }
}

// ===== CRUD =====
function addTrigger(config) {
  var trigger = {
    id: 'trg_' + Date.now().toString(36),
    name: config.name || '新触发器',
    enabled: config.enabled !== false,
    type: config.type || 'event',
    condition: config.condition || { type: 'event', event: 'unknown' },
    action: config.action || { type: 'log' },
    cooldown: config.cooldown || 0,
    lastFired: null,
    fireCount: 0,
    createdAt: Date.now()
  };
  triggers.push(trigger);
  saveTriggers();
  return trigger;
}

function updateTrigger(id, updates) {
  var idx = triggers.findIndex(function(t) { return t.id === id; });
  if (idx < 0) return { success: false, error: '触发器不存在' };
  Object.assign(triggers[idx], updates);
  saveTriggers();
  return { success: true, trigger: triggers[idx] };
}

function deleteTrigger(id) {
  triggers = triggers.filter(function(t) { return t.id !== id; });
  saveTriggers();
  return { success: true };
}

function listTriggers() { return triggers.slice(); }
function getTrigger(id) { return triggers.find(function(t) { return t.id === id; }) || null; }

// ===== 便捷方法 =====
function onKeyword(keywords, action, opts) {
  opts = opts || {};
  return addTrigger({ name: opts.name || ('关键词: ' + keywords.substring(0, 20)), type: 'message', condition: { type: 'keyword', pattern: keywords }, action: action, cooldown: opts.cooldown || 60000 });
}

function onEvent(eventName, action, opts) {
  opts = opts || {};
  return addTrigger({ name: opts.name || ('事件: ' + eventName), type: 'event', condition: { type: 'event', event: eventName }, action: action, cooldown: opts.cooldown || 0 });
}

function onThreshold(field, operator, value, action, opts) {
  opts = opts || {};
  return addTrigger({ name: opts.name || ('阈值: ' + field + ' ' + operator + ' ' + value), type: 'event', condition: { type: 'threshold', field: field, operator: operator, value: value }, action: action, cooldown: opts.cooldown || 300000 });
}

function scheduleWithCondition(scheduleConfig, condition, action, opts) {
  opts = opts || {};
  var task = null;
  if (Core.scheduler && Core.scheduler.add) {
    task = Core.scheduler.add({
      name: opts.name || '条件定时任务',
      schedule: scheduleConfig,
      action: { type: 'custom', handler: function() {
        var context = { _scheduled: true };
        if (evaluateCondition(condition, context)) {
          _executeTriggerAction({ name: opts.name || '条件定时', action: action }, context);
        }
      }}
    });
  }
  return task;
}

module.exports = {
  name: 'trigger-engine',
  dependencies: ['scheduler'],
  init: function(_Core) {
    Core = _Core;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }
    loadTriggers();
    Core.triggerEngine = {
      on: on, off: off, emit: emit,
      add: addTrigger, update: updateTrigger, delete: deleteTrigger,
      list: listTriggers, get: getTrigger,
      evaluate: evaluateCondition,
      checkMessage: checkMessageTriggers,
      onKeyword: onKeyword, onEvent: onEvent, onThreshold: onThreshold,
      scheduleWithCondition: scheduleWithCondition
    };
    if (Core.plugins && Core.plugins.registerHook) {
      Core.plugins.registerHook('_trigger-engine', 'afterResponse', function(msg, response) {
        checkMessageTriggers(msg);
      });
    }
    console.log('\u2705 trigger-engine 已加载（' + triggers.length + ' 个触发器，支持事件/关键词/阈值/组合触发）');
  }
};
