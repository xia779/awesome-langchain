var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');

// 直接加载 agent-loop 模块（不经过 core-v10.js）
var agentLoopMod = require('../modules/agent-loop');
var helper = require('./helper');

test('agent-loop 模块导出', function() {
  assert.equal(agentLoopMod.name, 'agent-loop');
  assert.ok(agentLoopMod.dependencies.includes('html-utils'));
  assert.equal(typeof agentLoopMod.init, 'function');
});

test('agent-loop 初始化挂载 Core.agentLoop', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  assert.ok(Core.agentLoop);
  assert.equal(typeof Core.agentLoop.cleanFinalAnswer, 'function');
  assert.equal(typeof Core.agentLoop.extractJSONFromText, 'function');
  assert.equal(typeof Core.agentLoop.sendToAgent, 'function');
  helper.cleanTestData();
});

test('cleanFinalAnswer - 纯文本不变', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var clean = Core.agentLoop.cleanFinalAnswer;

  assert.equal(clean('你好世界'), '你好世界');
  assert.equal(clean('Hello world'), 'Hello world');
  assert.equal(clean('这是一段普通回复。'), '这是一段普通回复。');
  helper.cleanTestData();
});

test('cleanFinalAnswer - null/空字符串', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var clean = Core.agentLoop.cleanFinalAnswer;

  assert.equal(clean(null), null);
  assert.equal(clean(''), '');
  assert.equal(clean(undefined), undefined);
  helper.cleanTestData();
});

test('cleanFinalAnswer - JSON complete action 提取', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var clean = Core.agentLoop.cleanFinalAnswer;

  var json1 = JSON.stringify({ action: 'complete', params: { answer: '最终答案' } });
  assert.equal(clean(json1), '最终答案');

  var json2 = JSON.stringify({ action: 'complete', params: { result: '结果文本' } });
  assert.equal(clean(json2), '结果文本');
  helper.cleanTestData();
});

test('cleanFinalAnswer - JSON answer 字段提取', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var clean = Core.agentLoop.cleanFinalAnswer;

  var json1 = JSON.stringify({ answer: '这是回答内容，至少五个字符' });
  var result = clean(json1);
  assert.equal(result, '这是回答内容，至少五个字符');
  helper.cleanTestData();
});

test('cleanFinalAnswer - 末尾 JSON 符号清理', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var clean = Core.agentLoop.cleanFinalAnswer;

  var result = clean('这是回答"}  ');
  // 末尾的 "} 应该被清理
  assert.ok(!result.endsWith('"}'));
  helper.cleanTestData();
});

test('extractJSONFromText - 纯 JSON', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var extract = Core.agentLoop.extractJSONFromText;

  var result = extract('{"action":"complete","params":{"answer":"test"}}');
  assert.ok(result);
  assert.equal(result.action, 'complete');
  assert.equal(result.params.answer, 'test');
  helper.cleanTestData();
});

test('extractJSONFromText - 代码块 JSON', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var extract = Core.agentLoop.extractJSONFromText;

  var text = '一些前缀\n```json\n{"key":"value"}\n```\n一些后缀';
  var result = extract(text);
  assert.ok(result);
  assert.equal(result.key, 'value');
  helper.cleanTestData();
});

test('extractJSONFromText - 嵌入文本的 JSON', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var extract = Core.agentLoop.extractJSONFromText;

  var text = 'Agent返回: {"action":"tool_call","params":{"tool":"read_file"}} 然后继续';
  var result = extract(text);
  assert.ok(result);
  assert.equal(result.action, 'tool_call');
  helper.cleanTestData();
});

test('extractJSONFromText - 非 JSON 返回 null', function() {
  var Core = helper.createMockCore();
  agentLoopMod.init(Core);
  var extract = Core.agentLoop.extractJSONFromText;

  assert.equal(extract('普通文本没有JSON'), null);
  assert.equal(extract(null), null);
  assert.equal(extract(''), null);
  helper.cleanTestData();
});
