var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var helper = require('./helper');

// plugins.js 使用 window.__nodeFs 备选，但 require('fs') 在 Node 中总是可用
var pluginsMod = require('../modules/plugins');

test('plugins 模块导出', function() {
  assert.equal(pluginsMod.name, 'plugins');
  assert.ok(pluginsMod.dependencies.includes('custom'));
  assert.equal(typeof pluginsMod.init, 'function');
});

test('plugins 初始化挂载 Core.plugins', function() {
  var Core = helper.createMockCore();
  // 确保 plugins 目录存在
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);
  assert.ok(Core.plugins);
  assert.equal(typeof Core.plugins.listPlugins, 'function');
  assert.equal(typeof Core.plugins.registerHook, 'function');
  assert.equal(typeof Core.plugins.callHook, 'function');
  assert.equal(typeof Core.plugins.enablePlugin, 'function');
  assert.equal(typeof Core.plugins.disablePlugin, 'function');
  helper.cleanTestData();
});

test('plugins hook 注册与调用', async function() {
  var Core = helper.createMockCore();
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);

  var hookCalled = false;
  var hookArg = null;

  Core.plugins.registerHook('testPlugin', 'testHook', function(data) {
    hookCalled = true;
    hookArg = data;
    return data + '_modified';
  });

  var result = await Core.plugins.callHook('testHook', 'test_data');
  assert.ok(hookCalled);
  assert.equal(hookArg, 'test_data');
  assert.equal(result, 'test_data_modified');
  helper.cleanTestData();
});

test('plugins hook 阻断（返回 null）', async function() {
  var Core = helper.createMockCore();
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);

  Core.plugins.registerHook('blockPlugin', 'blockHook', function(data) {
    return null; // 阻断
  });

  var result = await Core.plugins.callHook('blockHook', 'original');
  assert.equal(result, null);
  helper.cleanTestData();
});

test('plugins hook 注销', async function() {
  var Core = helper.createMockCore();
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);

  var callCount = 0;
  var handler = function(data) { callCount++; return data; };

  Core.plugins.registerHook('countPlugin', 'countHook', handler);
  await Core.plugins.callHook('countHook', 'a');
  assert.equal(callCount, 1);

  Core.plugins.unregisterHook('countPlugin', 'countHook', handler);
  await Core.plugins.callHook('countHook', 'b');
  assert.equal(callCount, 1); // 不应再增加
  helper.cleanTestData();
});

test('plugins listPlugins 返回数组', function() {
  var Core = helper.createMockCore();
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);
  var list = Core.plugins.listPlugins();
  assert.ok(Array.isArray(list));
  helper.cleanTestData();
});

test('plugins callHook 无钩子时返回原值', async function() {
  var Core = helper.createMockCore();
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);

  var result = await Core.plugins.callHook('nonexistentHook', 'passthrough');
  assert.equal(result, 'passthrough');
  helper.cleanTestData();
});

test('plugins callHook 无参数无钩子返回 undefined', async function() {
  var Core = helper.createMockCore();
  var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

  pluginsMod.init(Core);

  var result = await Core.plugins.callHook('emptyHook');
  assert.equal(result, undefined);
  helper.cleanTestData();
});
