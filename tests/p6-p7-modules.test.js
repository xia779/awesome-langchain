// tests/p6-p7-modules.test.js - P6+P7 模块单元测试
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var os = require('os');

// ===== P6-1: Cloud Sync =====
test('cloud-sync: 模块结构完整', function() {
  var mod = require('../modules/cloud-sync.js');
  assert.strictEqual(mod.name, 'cloud-sync');
  assert.strictEqual(typeof mod.init, 'function');
});

test('cloud-sync: 6个同步通道', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var channels = Object.keys(Core.cloudSync.SYNC_CHANNELS);
  assert.strictEqual(channels.length, 6);
  assert.ok(channels.indexOf('config') >= 0);
  assert.ok(channels.indexOf('memory') >= 0);
  assert.ok(channels.indexOf('persona') >= 0);
  assert.ok(channels.indexOf('knowledge_index') >= 0);
  assert.ok(channels.indexOf('workflows') >= 0);
  assert.ok(channels.indexOf('triggers') >= 0);
});

test('cloud-sync: computeDiff last-write-wins 本地更新', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var local = { _updatedAt: 200, value: 'new' };
  var remote = { _updatedAt: 100, value: 'old' };
  var diff = Core.cloudSync.computeDiff(local, remote, 'last-write-wins');
  assert.strictEqual(diff.changes[0].op, 'push');
  assert.strictEqual(diff.hasConflict, false);
});

test('cloud-sync: computeDiff last-write-wins 远程更新', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var local = { _updatedAt: 100, value: 'old' };
  var remote = { _updatedAt: 200, value: 'new' };
  var diff = Core.cloudSync.computeDiff(local, remote, 'last-write-wins');
  assert.strictEqual(diff.changes[0].op, 'pull');
});

test('cloud-sync: computeDiff append-unique 合并数组', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var local = [{ id: 'a' }, { id: 'b' }];
  var remote = [{ id: 'b' }, { id: 'c' }];
  var diff = Core.cloudSync.computeDiff(local, remote, 'append-unique');
  var pullChange = diff.changes.find(function(c) { return c.op === 'pull'; });
  var pushChange = diff.changes.find(function(c) { return c.op === 'push'; });
  assert.strictEqual(pullChange.data.length, 1);
  assert.strictEqual(pullChange.data[0].id, 'c');
  assert.strictEqual(pushChange.data.length, 1);
  assert.strictEqual(pushChange.data[0].id, 'a');
});

test('cloud-sync: computeDiff field-merge 数值取大', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var local = { intimacy: 80, name: 'local' };
  var remote = { intimacy: 60, name: 'remote' };
  var diff = Core.cloudSync.computeDiff(local, remote, 'field-merge');
  assert.strictEqual(diff.changes[0].op, 'merge');
  assert.strictEqual(diff.merged.intimacy, 80);
  assert.strictEqual(diff.hasConflict, true); // name 冲突
});

test('cloud-sync: status 返回设备ID和通道', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var status = Core.cloudSync.status();
  assert.ok(status.device);
  assert.strictEqual(status.syncing, false);
  assert.strictEqual(status.channels.length, 6);
});

test('cloud-sync: queue 离线操作', function() {
  var mod = require('../modules/cloud-sync.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  Core.cloudSync.queue({ type: 'push', channel: 'memory' });
  var pending = Core.cloudSync.pendingOps();
  assert.ok(pending.length >= 1);
});

// ===== P6-3: Model Router =====
test('model-router: 模块结构完整', function() {
  var mod = require('../modules/model-router.js');
  assert.strictEqual(mod.name, 'model-router');
  assert.strictEqual(typeof mod.init, 'function');
});

test('model-router: addProvider + list', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var p = Core.modelRouter.addProvider({ name: 'TestProv', baseUrl: 'http://localhost', models: ['gpt-4'], priority: 80, weight: 2 });
  assert.ok(p.id);
  var list = Core.modelRouter.list();
  assert.ok(list.length >= 1);
  var found = list.find(function(x) { return x.id === p.id; });
  assert.strictEqual(found.name, 'TestProv');
  assert.strictEqual(found.priority, 80);
  Core.modelRouter.removeProvider(p.id);
});

test('model-router: selectProvider 按优先级', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  Core.modelRouter.CONFIG.strategy = 'priority';
  var p1 = Core.modelRouter.addProvider({ name: 'High', priority: 90, models: [] });
  var p2 = Core.modelRouter.addProvider({ name: 'Low', priority: 10, models: [] });
  var selected = Core.modelRouter.select(null);
  assert.strictEqual(selected.name, 'High');
  Core.modelRouter.removeProvider(p1.id);
  Core.modelRouter.removeProvider(p2.id);
});

test('model-router: selectProvider 模型过滤', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  Core.modelRouter.CONFIG.strategy = 'priority';
  var p1 = Core.modelRouter.addProvider({ name: 'OnlyGPT', priority: 90, models: ['gpt-4'] });
  var p2 = Core.modelRouter.addProvider({ name: 'All', priority: 50, models: [] });
  var selected = Core.modelRouter.select('claude-3');
  assert.strictEqual(selected.name, 'All'); // p1 不支持 claude-3
  Core.modelRouter.removeProvider(p1.id);
  Core.modelRouter.removeProvider(p2.id);
});

test('model-router: recordLatency + getAvgLatency', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var p = Core.modelRouter.addProvider({ name: 'LatTest', models: [] });
  Core.modelRouter.recordLatency(p.id, 100, true);
  Core.modelRouter.recordLatency(p.id, 200, true);
  Core.modelRouter.recordLatency(p.id, 300, true);
  var avg = Core.modelRouter.getAvgLatency(p.id);
  assert.strictEqual(avg, 200);
  Core.modelRouter.removeProvider(p.id);
});

test('model-router: 失败后冷却期排除', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  Core.modelRouter.CONFIG.strategy = 'priority';
  var p1 = Core.modelRouter.addProvider({ name: 'Failing', priority: 99, models: [] });
  var p2 = Core.modelRouter.addProvider({ name: 'Healthy', priority: 50, models: [] });
  // 模拟失败
  Core.modelRouter.recordLatency(p1.id, 5000, false);
  var selected = Core.modelRouter.select(null);
  assert.strictEqual(selected.name, 'Healthy'); // Failing 在冷却期
  Core.modelRouter.removeProvider(p1.id);
  Core.modelRouter.removeProvider(p2.id);
});

test('model-router: getFallbackChain 排序', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var p1 = Core.modelRouter.addProvider({ name: 'A', priority: 80, models: [] });
  var p2 = Core.modelRouter.addProvider({ name: 'B', priority: 60, models: [] });
  var chain = Core.modelRouter.getFallbackChain(null);
  assert.ok(chain.length >= 2);
  Core.modelRouter.removeProvider(p1.id);
  Core.modelRouter.removeProvider(p2.id);
});

test('model-router: 配额管理', function() {
  var mod = require('../modules/model-router.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var p = Core.modelRouter.addProvider({ name: 'QuotaTest', models: [] });
  Core.modelRouter.setQuota(p.id, 3, 86400000);
  assert.strictEqual(Core.modelRouter.consumeQuota(p.id), true);
  assert.strictEqual(Core.modelRouter.consumeQuota(p.id), true);
  assert.strictEqual(Core.modelRouter.consumeQuota(p.id), true);
  assert.strictEqual(Core.modelRouter.consumeQuota(p.id), false); // 超限
  Core.modelRouter.removeProvider(p.id);
});

// ===== P7-1: Adaptive Engine =====
test('adaptive-engine: 模块结构完整', function() {
  var mod = require('../modules/adaptive-engine.js');
  assert.strictEqual(mod.name, 'adaptive-engine');
  assert.strictEqual(typeof mod.init, 'function');
});

test('adaptive-engine: _extractTopics 识别主题', function() {
  var mod = require('../modules/adaptive-engine.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var topics = Core.adaptiveEngine._extractTopics('帮我debug这段代码的bug');
  assert.ok(topics.indexOf('programming') >= 0);
  var topics2 = Core.adaptiveEngine._extractTopics('今天股票行情怎么样');
  assert.ok(topics2.indexOf('finance') >= 0);
});

test('adaptive-engine: _detectPatterns 识别行为', function() {
  var mod = require('../modules/adaptive-engine.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var patterns = Core.adaptiveEngine._detectPatterns('请帮我写代码实现这个功能', {});
  assert.ok(patterns.indexOf('polite_request') >= 0);
  assert.ok(patterns.indexOf('code_related') >= 0);
});

test('adaptive-engine: record 更新交互统计', function() {
  var mod = require('../modules/adaptive-engine.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var before = Core.adaptiveEngine.profile().totalInteractions;
  Core.adaptiveEngine.record('你好，帮我分析数据', '好的，这是分析结果...', {});
  var after = Core.adaptiveEngine.profile().totalInteractions;
  assert.strictEqual(after, before + 1);
});

test('adaptive-engine: personalize 返回个性化指令', function() {
  var mod = require('../modules/adaptive-engine.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  // 多次记录建立偏好
  for (var i = 0; i < 5; i++) {
    Core.adaptiveEngine.record('帮我写代码实现功能', '短回复', {});
  }
  var directive = Core.adaptiveEngine.personalize();
  assert.strictEqual(typeof directive, 'string');
});

test('adaptive-engine: recommend 返回推荐列表', function() {
  var mod = require('../modules/adaptive-engine.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  Core.adaptiveEngine.record('帮我研究一下AI最新进展', '研究报告...', {});
  var recs = Core.adaptiveEngine.recommend();
  assert.ok(Array.isArray(recs));
});

test('adaptive-engine: profile 返回完整统计', function() {
  var mod = require('../modules/adaptive-engine.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var profile = Core.adaptiveEngine.profile();
  assert.ok('totalInteractions' in profile);
  assert.ok('avgMessageLength' in profile);
  assert.ok('satisfactionRate' in profile);
  assert.ok('topTopics' in profile);
  assert.ok('preferences' in profile);
});

// ===== P7-3: Health Monitor =====
test('health-monitor: 模块结构完整', function() {
  var mod = require('../modules/health-monitor.js');
  assert.strictEqual(mod.name, 'health-monitor');
  assert.strictEqual(typeof mod.init, 'function');
});

test('health-monitor: HEALTH_CHECKS 7项', function() {
  var mod = require('../modules/health-monitor.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  assert.strictEqual(Core.healthMonitor.HEALTH_CHECKS.length, 7);
});

test('health-monitor: check 返回结果数组', function() {
  var mod = require('../modules/health-monitor.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var results = Core.healthMonitor.check();
  assert.ok(Array.isArray(results));
  assert.ok(results.length >= 5);
  results.forEach(function(r) {
    assert.ok(r.id);
    assert.ok(['healthy', 'warning', 'critical', 'error', 'unknown'].indexOf(r.status) >= 0);
    assert.ok(r.timestamp);
  });
});

test('health-monitor: report 返回综合报告', function() {
  var mod = require('../modules/health-monitor.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var report = Core.healthMonitor.report();
  assert.ok(['healthy', 'degraded', 'critical'].indexOf(report.status) >= 0);
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.ok(Array.isArray(report.checks));
  assert.ok(Array.isArray(report.activeAlerts));
  assert.ok(report.performance);
});

test('health-monitor: metrics 返回性能指标', function() {
  var mod = require('../modules/health-monitor.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var metrics = Core.healthMonitor.metrics();
  assert.ok(metrics.uptime > 0);
  assert.ok(metrics.memory);
  assert.ok(metrics.memory.heapUsed > 0);
});

test('health-monitor: alerts 初始为空或已有', function() {
  var mod = require('../modules/health-monitor.js');
  var Core = { DATA_ROOT: os.tmpdir() };
  mod.init(Core);
  var alerts = Core.healthMonitor.alerts();
  assert.ok(Array.isArray(alerts));
});
