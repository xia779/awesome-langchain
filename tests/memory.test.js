var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

var memoryMod = require('../modules/memory');

test('memory 模块导出', function() {
  assert.equal(memoryMod.name, 'memory');
  assert.ok(memoryMod.dependencies.includes('routing'));
  assert.ok(memoryMod.dependencies.includes('custom'));
  assert.equal(typeof memoryMod.init, 'function');
});

test('memory 初始化挂载 Core.memory + Core.memoryEnhance', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);
  assert.ok(Core.memory);
  assert.ok(Core.memoryEnhance);
  assert.strictEqual(Core.memory, Core.memoryEnhance); // 同一引用
  assert.equal(typeof Core.memory.add, 'function');
  assert.equal(typeof Core.memory.list, 'function');
  assert.equal(typeof Core.memory.delete, 'function');
  assert.equal(typeof Core.memory.search, 'function');
  assert.equal(typeof Core.memory.getProfile, 'function');
  assert.equal(typeof Core.memory.getDailyLog, 'function');
  assert.equal(typeof Core.memory.setImportance, 'function');
  assert.equal(typeof Core.memory.distill, 'function');
  assert.equal(typeof Core.memory.getEnhancedContext, 'function');
  helper.cleanTestData();
});

test('memory 注册 /mem 命令', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);
  assert.ok(Core.custom._commands['/mem']);
  assert.equal(typeof Core.custom._commands['/mem'].handler, 'function');
  helper.cleanTestData();
});

test('memory CRUD - 添加和列出', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  var r1 = Core.memory.add('测试记忆内容', 'test,unit');
  assert.ok(r1.success);

  var list = Core.memory.list(10);
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  assert.ok(list.some(function(m) { return m.content === '测试记忆内容'; }));
  helper.cleanTestData();
});

test('memory CRUD - 搜索', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  Core.memory.add('TypeScript 学习笔记', 'tech,typescript');
  Core.memory.add('今天的天气很好', 'daily');

  var results = Core.memory.search('TypeScript');
  assert.ok(Array.isArray(results));
  assert.ok(results.length >= 1);
  helper.cleanTestData();
});

test('memory 重要性 - setImportance + getCritical', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  var r = Core.memory.add('关键配置信息', 'config');
  assert.ok(r.success);

  // 获取刚添加的记忆 ID
  var list = Core.memory.list(1);
  if (list.length > 0 && list[0].id) {
    Core.memory.setImportance(list[0].id, 'critical');
    var critical = Core.memory.getCritical(10);
    assert.ok(Array.isArray(critical));
    assert.ok(critical.some(function(m) { return m.content === '关键配置信息'; }));
  }
  helper.cleanTestData();
});

test('memory 重要性 - addWithImportance', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  var r = Core.memory.addWithImportance('重要决策记录', 'decision', 'critical');
  assert.ok(r.success);

  var critical = Core.memory.getCritical(10);
  assert.ok(critical.some(function(m) { return m.content === '重要决策记录'; }));
  helper.cleanTestData();
});

test('memory 每日日志', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  var r1 = Core.memory.appendDailyLog('今天完成了单元测试');
  assert.ok(r1.success);

  var log = Core.memory.getDailyLog();
  assert.ok(log);
  assert.ok(log.content.indexOf('单元测试') >= 0);

  var logs = Core.memory.listDailyLogs(7);
  assert.ok(Array.isArray(logs));
  assert.ok(logs.length >= 1);
  helper.cleanTestData();
});

test('memory 用户画像', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  var profile = Core.memory.getProfile();
  assert.ok(typeof profile === 'object');

  Core.memory.saveProfile({ name: '测试用户', os: 'Windows 10', role: '开发者' });
  var saved = Core.memory.getProfile();
  assert.equal(saved.name, '测试用户');
  assert.equal(saved.os, 'Windows 10');

  var profileStr = Core.memory.getProfileString();
  assert.ok(typeof profileStr === 'string');
  assert.ok(profileStr.indexOf('测试用户') >= 0);
  helper.cleanTestData();
});

test('memory getEnhancedContext 返回上下文字符串', async function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  Core.memory.saveProfile({ name: '测试', preferences: ['暗色主题'] });
  Core.memory.addWithImportance('API密钥配置', 'config', 'critical');

  var ctx = await Core.memory.getEnhancedContext('如何配置API？');
  assert.ok(typeof ctx === 'string');
  helper.cleanTestData();
});

test('memory getStats 统计', function() {
  var Core = helper.createMockCore();
  memoryMod.init(Core);

  Core.memory.add('记忆1', 'tag1');
  Core.memory.add('记忆2', 'tag2');

  var stats = Core.memory.getStats();
  assert.ok(typeof stats === 'object');
  assert.ok(stats.total >= 2);
  helper.cleanTestData();
});
