/**
 * tests/agent-handoff.test.js — Agent Handoff 机制测试
 */
var test = require('node:test');
var assert = require('node:assert');

var helper = require('./helper');
var handoffMod = require('../modules/agent-handoff');

function createTestCore() {
  var Core = helper.createMockCore();
  Core.agentLoop = { AGENT_SYSTEM_PROMPT: 'mock' };
  Core.api = {
    callAPI: async function(prompt, sysPrompt, temp, model, provider) {
      if (prompt.includes('fail')) {
        throw new Error('API timeout');
      }
      return { message: { content: '专业代理回复: 已处理任务 "' + prompt.substring(0, 50) + '"' } };
    },
  };
  Core.toolsRegistry = {
    registerTool: function() {},
    executeTool: function() {},
  };
  return Core;
}

// ===== Module Structure =====
test('agent-handoff 模块导出', function() {
  assert.equal(handoffMod.name, 'agent-handoff');
  assert.ok(handoffMod.dependencies.includes('agent-loop'));
  assert.equal(typeof handoffMod.init, 'function');
});

test('init 创建 Core.handoff 命名空间', function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  assert.ok(Core.handoff);
  assert.equal(typeof Core.handoff.executeHandoff, 'function');
  assert.equal(typeof Core.handoff.getHistory, 'function');
  assert.equal(typeof Core.handoff.getStats, 'function');
  assert.equal(typeof Core.handoff.getSpecialists, 'function');
});

// ===== Specialist Registry =====
test('getSpecialists 返回专业代理列表', function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  var specialists = Core.handoff.getSpecialists();
  assert.ok(Array.isArray(specialists));
  assert.ok(specialists.length >= 5);
  var ids = specialists.map(function(s) { return s.id; });
  assert.ok(ids.includes('code'));
  assert.ok(ids.includes('research'));
  assert.ok(ids.includes('writer'));
  assert.ok(ids.includes('math'));
  assert.ok(ids.includes('translate'));
});

test('SPECIALISTS 每个代理有 name 和 description', function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  var specialists = Core.handoff.SPECIALISTS;
  for (var id in specialists) {
    assert.ok(specialists[id].name, id + ' missing name');
    assert.ok(specialists[id].description, id + ' missing description');
    assert.ok(specialists[id].systemPrompt, id + ' missing systemPrompt');
  }
});

// ===== Handoff Execution =====
test('executeHandoff 成功执行', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  var result = await Core.handoff.executeHandoff('code', '写一段排序算法');
  assert.ok(result.includes('专业代理回复'));
  helper.cleanTestData();
});

test('executeHandoff 带上下文', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  var result = await Core.handoff.executeHandoff('research', '分析数据', '背景: 电商用户行为数据');
  assert.ok(result.includes('专业代理回复'));
  helper.cleanTestData();
});

test('executeHandoff 未知代理返回错误', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  var result = await Core.handoff.executeHandoff('nonexistent', 'test task');
  assert.ok(result.includes('❌'));
  assert.ok(result.includes('未知'));
  helper.cleanTestData();
});

test('executeHandoff API 错误处理', async function() {
  var Core = createTestCore();
  Core.api.callAPI = async function() { throw new Error('API timeout'); };
  handoffMod.init(Core);
  var result = await Core.handoff.executeHandoff('code', 'fail task');
  assert.ok(result.includes('❌'));
  assert.ok(result.includes('失败'));
  helper.cleanTestData();
});

// ===== History & Stats =====
test('getHistory 记录 handoff 历史', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  Core.handoff.clearHistory();
  await Core.handoff.executeHandoff('code', 'task 1');
  await Core.handoff.executeHandoff('writer', 'task 2');
  var history = Core.handoff.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].to, 'code');
  assert.equal(history[1].to, 'writer');
  assert.equal(history[0].success, true);
  assert.equal(history[1].success, true);
  helper.cleanTestData();
});

test('getStats 统计正确', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  Core.handoff.clearHistory();
  await Core.handoff.executeHandoff('code', 'task 1');
  await Core.handoff.executeHandoff('code', 'task 2');
  await Core.handoff.executeHandoff('writer', 'task 3');
  var stats = Core.handoff.getStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.success, 3);
  assert.ok(stats.byAgent.code);
  assert.equal(stats.byAgent.code.total, 2);
  assert.ok(stats.byAgent.writer);
  assert.equal(stats.byAgent.writer.total, 1);
  helper.cleanTestData();
});

test('clearHistory 清空历史', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  await Core.handoff.executeHandoff('code', 'task');
  assert.ok(Core.handoff.getHistory().length > 0);
  Core.handoff.clearHistory();
  assert.equal(Core.handoff.getHistory().length, 0);
  helper.cleanTestData();
});

test('历史记录包含耗时', async function() {
  var Core = createTestCore();
  handoffMod.init(Core);
  Core.handoff.clearHistory();
  await Core.handoff.executeHandoff('math', '计算圆周率');
  var history = Core.handoff.getHistory();
  assert.ok(history[0].duration >= 0);
  assert.ok(history[0].timestamp > 0);
  helper.cleanTestData();
});

helper.cleanTestData();
