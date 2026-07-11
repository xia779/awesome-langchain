/**
 * tests/mcp-resources.test.js — MCP Resources & Prompts 测试
 */
var test = require('node:test');
var assert = require('node:assert');

var helper = require('./helper');
var mcpResMod = require('../modules/mcp-resources');

function createTestCore() {
  var Core = helper.createMockCore();
  Core.config = { guardrailsEnabled: true };
  Core.session = { sessions: { 's1': { title: '测试会话', roleType: '' } } };
  Core.mcp = {
    enabled: function() { return false; },
    listServers: function() { return []; },
    _rpc: null,
  };
  Core.handoff = { getStats: function() { return { total: 0 }; } };
  return Core;
}

// ===== Module Structure =====
test('mcp-resources 模块导出', function() {
  assert.equal(mcpResMod.name, 'mcp-resources');
  assert.ok(mcpResMod.dependencies.includes('mcp'));
  assert.equal(typeof mcpResMod.init, 'function');
});

test('init 创建 Core.mcpResources', function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  assert.ok(Core.mcpResources);
  assert.equal(typeof Core.mcpResources.registerResource, 'function');
  assert.equal(typeof Core.mcpResources.listResources, 'function');
  assert.equal(typeof Core.mcpResources.readResource, 'function');
  assert.equal(typeof Core.mcpResources.registerPrompt, 'function');
  assert.equal(typeof Core.mcpResources.listPrompts, 'function');
  assert.equal(typeof Core.mcpResources.getPrompt, 'function');
  helper.cleanTestData();
});

// ===== Resources =====
test('内置资源自动注册', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var resources = await Core.mcpResources.listResources();
  assert.ok(resources.length >= 3);
  var uris = resources.map(function(r) { return r.uri; });
  assert.ok(uris.includes('app://config'));
  assert.ok(uris.includes('app://sessions'));
  assert.ok(uris.includes('app://status'));
  helper.cleanTestData();
});

test('readResource: app://config', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.readResource('app://config');
  assert.equal(result.success, true);
  assert.ok(result.content.includes('guardrailsEnabled'));
  helper.cleanTestData();
});

test('readResource: app://sessions', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.readResource('app://sessions');
  assert.equal(result.success, true);
  assert.ok(result.content.includes('测试会话'));
  helper.cleanTestData();
});

test('readResource: app://status', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.readResource('app://status');
  assert.equal(result.success, true);
  assert.ok(result.content.includes('version'));
  helper.cleanTestData();
});

test('readResource: 不存在的资源', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.readResource('app://nonexistent');
  assert.equal(result.success, false);
  assert.ok(result.error.includes('未找到'));
  helper.cleanTestData();
});

test('registerResource 自定义资源', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  Core.mcpResources.registerResource({
    uri: 'custom://data',
    name: '自定义数据',
    description: '测试自定义资源',
    handler: function() { return '自定义数据内容'; },
  });
  var result = await Core.mcpResources.readResource('custom://data');
  assert.equal(result.success, true);
  assert.equal(result.content, '自定义数据内容');
  helper.cleanTestData();
});

test('unregisterResource 删除资源', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  Core.mcpResources.registerResource({
    uri: 'custom://temp',
    name: '临时',
    handler: function() { return 'temp'; },
  });
  var r1 = await Core.mcpResources.listResources();
  var hasTemp = r1.some(function(r) { return r.uri === 'custom://temp'; });
  assert.ok(hasTemp);
  Core.mcpResources.unregisterResource('custom://temp');
  var r2 = await Core.mcpResources.listResources();
  var hasTempAfter = r2.some(function(r) { return r.uri === 'custom://temp'; });
  assert.ok(!hasTempAfter);
  helper.cleanTestData();
});

// ===== Prompts =====
test('内置提示词模板自动注册', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var prompts = await Core.mcpResources.listPrompts();
  assert.ok(prompts.length >= 3);
  var names = prompts.map(function(p) { return p.name; });
  assert.ok(names.includes('code-review'));
  assert.ok(names.includes('summarize'));
  assert.ok(names.includes('translate'));
  helper.cleanTestData();
});

test('getPrompt: code-review 模板', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.getPrompt('code-review', { code: 'print("hello")' });
  assert.equal(result.success, true);
  assert.ok(result.messages.length > 0);
  assert.ok(result.messages[0].content.includes('print("hello")'));
  helper.cleanTestData();
});

test('getPrompt: 缺少必需参数', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.getPrompt('code-review', {});
  assert.equal(result.success, false);
  assert.ok(result.error.includes('缺少'));
  helper.cleanTestData();
});

test('getPrompt: summarize 模板', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.getPrompt('summarize', { text: '这是一段很长的文本...', style: 'bullet' });
  assert.equal(result.success, true);
  assert.ok(result.messages[0].content.includes('要点'));
  helper.cleanTestData();
});

test('getPrompt: translate 模板', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.getPrompt('translate', { text: 'Hello World', target_lang: '中文' });
  assert.equal(result.success, true);
  assert.ok(result.messages[0].content.includes('中文'));
  helper.cleanTestData();
});

test('getPrompt: 不存在的模板', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  var result = await Core.mcpResources.getPrompt('nonexistent', {});
  assert.equal(result.success, false);
  assert.ok(result.error.includes('未找到'));
  helper.cleanTestData();
});

test('registerPrompt 自定义模板', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  Core.mcpResources.registerPrompt({
    name: 'custom-greeting',
    description: '自定义问候',
    arguments: [{ name: 'name', description: '姓名', required: true }],
    handler: function(args) {
      return { messages: [{ role: 'user', content: '你好，' + args.name + '！' }] };
    },
  });
  var result = await Core.mcpResources.getPrompt('custom-greeting', { name: '小明' });
  assert.equal(result.success, true);
  assert.ok(result.messages[0].content.includes('小明'));
  helper.cleanTestData();
});

test('unregisterPrompt 删除模板', async function() {
  var Core = createTestCore();
  mcpResMod.init(Core);
  Core.mcpResources.registerPrompt({
    name: 'temp-prompt',
    description: '临时',
    handler: function() { return { messages: [] }; },
  });
  var p1 = await Core.mcpResources.listPrompts();
  var hasTemp = p1.some(function(p) { return p.name === 'temp-prompt'; });
  assert.ok(hasTemp);
  Core.mcpResources.unregisterPrompt('temp-prompt');
  var p2 = await Core.mcpResources.listPrompts();
  var hasTempAfter = p2.some(function(p) { return p.name === 'temp-prompt'; });
  assert.ok(!hasTempAfter);
  helper.cleanTestData();
});

helper.cleanTestData();
