// tests/p4-p5-modules.test.js - P4+P5 模块单元测试
'use strict';
var test = require('node:test');
var assert = require('node:assert');

// ===== P4-1: Deep Research 反思循环 =====
test('deep-research: 模块结构完整', function() {
  var mod = require('../modules/deep-research.js');
  assert.strictEqual(mod.name, 'deep-research');
  assert.ok(Array.isArray(mod.dependencies));
  assert.ok(mod.dependencies.indexOf('api') >= 0);
  assert.strictEqual(typeof mod.init, 'function');
});

test('deep-research: getConfig 返回含 reflection 配置', function() {
  var mod = require('../modules/deep-research.js');
  var Core = { config: {} };
  mod.init(Core);
  var cfg = Core.deepResearch.getConfig();
  assert.ok(cfg.reflection);
  assert.strictEqual(cfg.reflection.enabled, true);
  assert.strictEqual(cfg.reflection.maxIterations, 2);
  assert.strictEqual(cfg.reflection.minConfidence, 0.7);
  assert.strictEqual(cfg.reflection.crossValidate, true);
});

test('deep-research: status 初始为 inactive', function() {
  var mod = require('../modules/deep-research.js');
  var Core = { config: {} };
  mod.init(Core);
  var status = Core.deepResearch.status();
  assert.strictEqual(status.active, false);
});

test('deep-research: start 空主题返回错误', async function() {
  var mod = require('../modules/deep-research.js');
  var Core = { config: {} };
  mod.init(Core);
  var result = await Core.deepResearch.start('');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.indexOf('不能为空') >= 0);
});

test('deep-research: 暴露 reflect 和 crossValidate 方法', function() {
  var mod = require('../modules/deep-research.js');
  var Core = { config: {} };
  mod.init(Core);
  assert.strictEqual(typeof Core.deepResearch.reflect, 'function');
  assert.strictEqual(typeof Core.deepResearch.crossValidate, 'function');
});

// ===== P4-3: Delivery Orchestrator =====
test('delivery-orchestrator: 模块结构完整', function() {
  var mod = require('../modules/delivery-orchestrator.js');
  assert.strictEqual(mod.name, 'delivery-orchestrator');
  assert.ok(Array.isArray(mod.dependencies));
  assert.strictEqual(typeof mod.init, 'function');
});

test('delivery-orchestrator: 4种交付类型', function() {
  var mod = require('../modules/delivery-orchestrator.js');
  var Core = { DATA_ROOT: require('os').tmpdir() };
  mod.init(Core);
  var types = Core.deliveryOrchestrator.types();
  assert.strictEqual(types.length, 4);
  var keys = types.map(function(t) { return t.key; });
  assert.ok(keys.indexOf('research_report') >= 0);
  assert.ok(keys.indexOf('web_app') >= 0);
  assert.ok(keys.indexOf('data_analysis') >= 0);
  assert.ok(keys.indexOf('content_creation') >= 0);
});

test('delivery-orchestrator: 每种类型有5个阶段', function() {
  var mod = require('../modules/delivery-orchestrator.js');
  var Core = { DATA_ROOT: require('os').tmpdir() };
  mod.init(Core);
  var types = Core.deliveryOrchestrator.types();
  types.forEach(function(t) {
    assert.strictEqual(t.stages.length, 5, t.key + ' should have 5 stages');
  });
});

test('delivery-orchestrator: start 未知类型返回错误', async function() {
  var mod = require('../modules/delivery-orchestrator.js');
  var Core = { DATA_ROOT: require('os').tmpdir() };
  mod.init(Core);
  var result = await Core.deliveryOrchestrator.start('unknown_type', {});
  assert.strictEqual(result.success, false);
  assert.ok(result.error.indexOf('未知交付类型') >= 0);
});

test('delivery-orchestrator: list 初始为空', function() {
  var mod = require('../modules/delivery-orchestrator.js');
  var Core = { DATA_ROOT: require('os').tmpdir() };
  mod.init(Core);
  var list = Core.deliveryOrchestrator.list();
  assert.ok(Array.isArray(list));
});

// ===== P5-1: Trigger Engine =====
test('trigger-engine: 模块结构完整', function() {
  var mod = require('../modules/trigger-engine.js');
  assert.strictEqual(mod.name, 'trigger-engine');
  assert.ok(mod.dependencies.indexOf('scheduler') >= 0);
  assert.strictEqual(typeof mod.init, 'function');
});

test('trigger-engine: evaluateCondition keyword 匹配', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);
  var cond = { type: 'keyword', pattern: '股票,大盘' };
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '今天大盘怎么样' }), true);
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '今天天气不错' }), false);
});

test('trigger-engine: evaluateCondition regex 匹配', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);
  var cond = { type: 'regex', pattern: '\\d{4}-\\d{2}-\\d{2}' };
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '日期是2026-07-27' }), true);
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '没有日期' }), false);
});

test('trigger-engine: evaluateCondition threshold', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);
  var cond = { type: 'threshold', field: 'count', operator: '>', value: 10 };
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { count: 15 }), true);
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { count: 5 }), false);
});

test('trigger-engine: evaluateCondition compound AND', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);
  var cond = {
    type: 'compound',
    logic: 'and',
    conditions: [
      { type: 'keyword', pattern: '股票' },
      { type: 'keyword', pattern: '分析' }
    ]
  };
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '帮我分析股票' }), true);
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '帮我分析天气' }), false);
});

test('trigger-engine: evaluateCondition compound OR', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);
  var cond = {
    type: 'compound',
    logic: 'or',
    conditions: [
      { type: 'keyword', pattern: '股票' },
      { type: 'keyword', pattern: '基金' }
    ]
  };
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '推荐基金' }), true);
  assert.strictEqual(Core.triggerEngine.evaluate(cond, { message: '推荐电影' }), false);
});

test('trigger-engine: evaluateCondition time_range', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);
  // 全天范围应该总是匹配
  var cond = { type: 'time_range', startHour: 0, endHour: 24 };
  assert.strictEqual(Core.triggerEngine.evaluate(cond, {}), true);
});

test('trigger-engine: CRUD 操作', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);

  var trigger = Core.triggerEngine.add({
    name: '测试触发器',
    type: 'message',
    condition: { type: 'keyword', pattern: '测试' },
    action: { type: 'log' },
    cooldown: 5000
  });
  assert.ok(trigger.id);
  assert.strictEqual(trigger.name, '测试触发器');

  var list = Core.triggerEngine.list();
  assert.ok(list.length >= 1);

  var updated = Core.triggerEngine.update(trigger.id, { name: '改名触发器' });
  assert.strictEqual(updated.success, true);
  assert.strictEqual(updated.trigger.name, '改名触发器');

  var deleted = Core.triggerEngine.delete(trigger.id);
  assert.strictEqual(deleted.success, true);
});

test('trigger-engine: 事件总线 on/emit', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);

  var received = null;
  Core.triggerEngine.on('test.event', function(data) { received = data; });
  Core.triggerEngine.emit('test.event', { value: 42 });
  assert.deepStrictEqual(received, { value: 42 });

  Core.triggerEngine.off('test.event');
  received = null;
  Core.triggerEngine.emit('test.event', { value: 99 });
  assert.strictEqual(received, null);
});

test('trigger-engine: onKeyword 便捷方法', function() {
  var mod = require('../modules/trigger-engine.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), plugins: { registerHook: function() {} } };
  mod.init(Core);

  var trigger = Core.triggerEngine.onKeyword('紧急,重要', { type: 'log' }, { name: '紧急关键词' });
  assert.ok(trigger.id);
  assert.strictEqual(trigger.condition.type, 'keyword');
  assert.strictEqual(trigger.condition.pattern, '紧急,重要');
  assert.strictEqual(trigger.cooldown, 60000);

  Core.triggerEngine.delete(trigger.id);
});

// ===== P5-2: Plugin SDK =====
test('plugin-sdk: 模块结构完整', function() {
  var mod = require('../modules/plugin-sdk.js');
  assert.strictEqual(mod.name, 'plugin-sdk');
  assert.ok(mod.dependencies.indexOf('plugins') >= 0);
  assert.strictEqual(typeof mod.init, 'function');
});

test('plugin-sdk: validateManifest 必填字段检查', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);

  var result = Core.pluginSDK.validateManifest({});
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length >= 4);

  var valid = Core.pluginSDK.validateManifest({
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin'
  });
  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.errors.length, 0);
});

test('plugin-sdk: validateManifest 权限警告', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);

  var result = Core.pluginSDK.validateManifest({
    id: 'test-plugin',
    name: 'Test',
    version: '1.0.0',
    description: 'Test',
    permissions: ['network', 'unknown_perm']
  });
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.length >= 1);
  assert.ok(result.warnings[0].indexOf('unknown_perm') >= 0);
});

test('plugin-sdk: register + activate + deactivate 生命周期', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);

  var activated = false;
  var deactivated = false;

  var reg = Core.pluginSDK.register({
    id: 'lifecycle-test',
    name: 'Lifecycle Test',
    version: '1.0.0',
    description: 'Test lifecycle'
  }, {
    onActivate: function() { activated = true; },
    onDeactivate: function() { deactivated = true; }
  });
  assert.strictEqual(reg.success, true);

  var act = Core.pluginSDK.activate('lifecycle-test');
  assert.strictEqual(act.success, true);
  assert.strictEqual(activated, true);

  var info = Core.pluginSDK.getInfo('lifecycle-test');
  assert.strictEqual(info.state, 'active');

  var deact = Core.pluginSDK.deactivate('lifecycle-test');
  assert.strictEqual(deact.success, true);
  assert.strictEqual(deactivated, true);
});

test('plugin-sdk: register 无效清单返回错误', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);

  var reg = Core.pluginSDK.register({ name: 'No ID' }, {});
  assert.strictEqual(reg.success, false);
  assert.ok(reg.errors.length > 0);
});

test('plugin-sdk: list 返回已注册插件', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);

  Core.pluginSDK.register({
    id: 'list-test',
    name: 'List Test',
    version: '2.0.0',
    description: 'For list test'
  }, {});

  var list = Core.pluginSDK.list();
  assert.ok(list.length >= 1);
  var found = list.find(function(p) { return p.id === 'list-test'; });
  assert.ok(found);
  assert.strictEqual(found.version, '2.0.0');
});

test('plugin-sdk: MANIFEST_SCHEMA 包含所有权限类型', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);
  var perms = Core.pluginSDK.MANIFEST_SCHEMA.permissions;
  assert.ok(perms.indexOf('network') >= 0);
  assert.ok(perms.indexOf('filesystem') >= 0);
  assert.ok(perms.indexOf('shell') >= 0);
  assert.ok(perms.indexOf('storage') >= 0);
});

test('plugin-sdk: LIFECYCLE_STATES 完整', function() {
  var mod = require('../modules/plugin-sdk.js');
  var Core = {};
  mod.init(Core);
  var states = Core.pluginSDK.LIFECYCLE_STATES;
  assert.ok(states.indexOf('registered') >= 0);
  assert.ok(states.indexOf('active') >= 0);
  assert.ok(states.indexOf('error') >= 0);
  assert.ok(states.indexOf('unloaded') >= 0);
});

// ===== P5-3: IM 双向通信 =====
test('im-notify: _parseIncomingMessage Telegram 格式', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/webhook', {
    message: { text: '你好', from: { username: 'test_user' }, chat: { id: 12345 }, date: 1700000000 }
  }, '');
  assert.strictEqual(msg.platform, 'telegram');
  assert.strictEqual(msg.text, '你好');
  assert.strictEqual(msg.sender, 'test_user');
  assert.strictEqual(msg.chatId, '12345');
});

test('im-notify: _parseIncomingMessage DingTalk 格式', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/dingtalk', {
    msgtype: 'text', text: { content: '钉钉消息' }, senderNick: '张三'
  }, '');
  assert.strictEqual(msg.platform, 'dingtalk');
  assert.strictEqual(msg.text, '钉钉消息');
  assert.strictEqual(msg.sender, '张三');
});

test('im-notify: _parseIncomingMessage WeCom 格式', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/wecom', {
    MsgType: 'text', Content: '企业微信消息', FromUserName: 'lisi'
  }, '');
  assert.strictEqual(msg.platform, 'wecom');
  assert.strictEqual(msg.text, '企业微信消息');
  assert.strictEqual(msg.sender, 'lisi');
});

test('im-notify: _parseIncomingMessage Slack 格式', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/slack', {
    text: 'hello from slack', user_name: 'bob'
  }, '');
  assert.strictEqual(msg.platform, 'slack');
  assert.strictEqual(msg.text, 'hello from slack');
  assert.strictEqual(msg.sender, 'bob');
});

test('im-notify: _parseIncomingMessage 通用格式', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/generic', {
    text: '通用消息', sender: 'someone', platform: 'custom'
  }, '');
  assert.strictEqual(msg.platform, 'custom');
  assert.strictEqual(msg.text, '通用消息');
  assert.strictEqual(msg.sender, 'someone');
});

test('im-notify: _parseIncomingMessage 纯文本 body', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/raw', null, 'plain text message');
  assert.strictEqual(msg.platform, 'generic');
  assert.strictEqual(msg.text, 'plain text message');
});

test('im-notify: _parseIncomingMessage 空内容返回 null', function() {
  var mod = require('../modules/im-notify.js');
  var msg = mod._parseIncomingMessage('/empty', { foo: 'bar' }, '');
  assert.strictEqual(msg, null);
});

test('im-notify: init 后暴露双向通信 API', function() {
  var mod = require('../modules/im-notify.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), config: {} };
  mod.init(Core);
  assert.strictEqual(typeof Core.imNotify.startWebhook, 'function');
  assert.strictEqual(typeof Core.imNotify.stopWebhook, 'function');
  assert.strictEqual(typeof Core.imNotify.webhookStatus, 'function');
  assert.strictEqual(typeof Core.imNotify.onMessage, 'function');
  assert.strictEqual(typeof Core.imNotify.removeMessageHandler, 'function');
});

test('im-notify: webhookStatus 初始未运行', function() {
  var mod = require('../modules/im-notify.js');
  var Core = { DATA_ROOT: require('os').tmpdir(), config: {} };
  mod.init(Core);
  var status = Core.imNotify.webhookStatus();
  assert.strictEqual(status.running, false);
});
