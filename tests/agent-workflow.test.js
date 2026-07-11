/**
 * tests/agent-workflow.test.js — Agent 状态机工作流测试
 */
var test = require('node:test');
var assert = require('node:assert');

var helper = require('./helper');
var workflowMod = require('../modules/agent-workflow');

function createTestCore() {
  var Core = helper.createMockCore();
  // Mock agentLoop
  Core.agentLoop = {
    executeAgentAction: async function(action, params) {
      if (action === 'fail_tool') return '❌ 工具执行失败';
      return 'mock result for ' + action;
    },
    extractJSONFromText: function(text) {
      try { return JSON.parse(text); } catch (e) {}
      try {
        var match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch (e) {}
      return null;
    },
    cleanFinalAnswer: function(text) { return text ? text.trim() : ''; },
    evaluateAnswer: function(text) {
      if (!text || text.trim().length < 10) return { pass: false, reason: 'too short' };
      return { pass: true, reason: '' };
    },
    AGENT_SYSTEM_PROMPT: 'mock system prompt',
  };
  // Mock api
  Core.api = {
    callAPI: async function() {
      return { message: { content: '{"action":"complete","params":{"answer":"这是一个高质量的回答，包含了详细的分析和解释说明。"}}' } };
    },
  };
  return Core;
}

// ===== Module Structure =====
test('agent-workflow 模块导出', function() {
  assert.equal(workflowMod.name, 'agent-workflow');
  assert.ok(workflowMod.dependencies.includes('agent-loop'));
  assert.equal(typeof workflowMod.init, 'function');
});

test('init 创建 Core.workflow.stateMachine 命名空间', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.ok(Core.workflow);
  assert.ok(Core.workflow.stateMachine);
  assert.equal(typeof Core.workflow.stateMachine.createMachine, 'function');
  assert.equal(typeof Core.workflow.stateMachine.runMachine, 'function');
});

test('States 枚举包含所有状态', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  var States = Core.workflow.stateMachine.States;
  assert.equal(States.INIT, 'INIT');
  assert.equal(States.THINK, 'THINK');
  assert.equal(States.ACT, 'ACT');
  assert.equal(States.OBSERVE, 'OBSERVE');
  assert.equal(States.COMPLETE, 'COMPLETE');
  assert.equal(States.ERROR, 'ERROR');
});

// ===== Transition Validation =====
test('合法转换: INIT → THINK', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('INIT', 'THINK'), true);
});

test('合法转换: THINK → ACT', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('THINK', 'ACT'), true);
});

test('合法转换: THINK → COMPLETE', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('THINK', 'COMPLETE'), true);
});

test('合法转换: ACT → OBSERVE', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('ACT', 'OBSERVE'), true);
});

test('合法转换: OBSERVE → THINK', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('OBSERVE', 'THINK'), true);
});

test('合法转换: ERROR → THINK (retry)', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('ERROR', 'THINK'), true);
});

test('非法转换: THINK → OBSERVE', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('THINK', 'OBSERVE'), false);
});

test('非法转换: COMPLETE → THINK (terminal)', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  assert.equal(Core.workflow.stateMachine.validateTransition('COMPLETE', 'THINK'), false);
});

// ===== Machine Creation =====
test('createMachine 初始状态为 INIT', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('test task');
  assert.equal(machine.state, 'INIT');
  assert.equal(machine.ctx.task, 'test task');
});

test('createMachine maxSteps 普通模式=12', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('task', { isDeepThink: false });
  assert.equal(machine.ctx.maxSteps, 12);
});

test('createMachine maxSteps 深度思考=20', function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('task', { isDeepThink: true });
  assert.equal(machine.ctx.maxSteps, 20);
});

// ===== Full Machine Run =====
test('runMachine: 直接 complete 响应', async function() {
  var Core = createTestCore();
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('简单任务');
  var result = await Core.workflow.stateMachine.runMachine(machine);
  assert.equal(result.success, true);
  assert.ok(result.reply.includes('高质量'));
  assert.ok(result.steps >= 1);
  assert.ok(result.transitionLog.length > 0);
  assert.ok(result.totalTime >= 0);
  helper.cleanTestData();
});

test('runMachine: 工具调用循环', async function() {
  var Core = createTestCore();
  var callCount = 0;
  Core.api.callAPI = async function() {
    callCount++;
    if (callCount === 1) {
      return { message: { content: '{"action":"read_file","params":{"path":"/test.txt"}}' } };
    }
    return { message: { content: '{"action":"complete","params":{"answer":"文件已读取完毕，内容如下..."}}' } };
  };
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('读取文件');
  var result = await Core.workflow.stateMachine.runMachine(machine);
  assert.equal(result.success, true);
  assert.ok(result.reply.includes('文件已读取'));
  assert.ok(result.steps >= 2);
  assert.ok(result.stepsLog.length >= 1);
  helper.cleanTestData();
});

test('runMachine: cancel 取消', async function() {
  var Core = createTestCore();
  Core.api.callAPI = async function() {
    return { message: { content: '{"action":"read_file","params":{}}' } };
  };
  var cancelled = false;
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('长任务', {
    cancelCheck: function() { cancelled = true; return cancelled; },
  });
  var result = await Core.workflow.stateMachine.runMachine(machine);
  assert.ok(result.reply.includes('取消'));
  helper.cleanTestData();
});

test('runMachine: stepsLog 条目结构正确', async function() {
  var Core = createTestCore();
  var callCount = 0;
  Core.api.callAPI = async function() {
    callCount++;
    if (callCount === 1) return { message: { content: '{"action":"search","params":{"query":"test"}}' } };
    return { message: { content: '{"action":"complete","params":{"answer":"搜索完成，找到5条结果。"}}' } };
  };
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('搜索');
  var result = await Core.workflow.stateMachine.runMachine(machine);
  if (result.stepsLog.length > 0) {
    var entry = result.stepsLog[0];
    assert.ok(entry.step !== undefined);
    assert.ok(entry.action !== undefined);
    assert.ok('time' in entry);
    assert.ok('success' in entry);
  }
  helper.cleanTestData();
});

test('runMachine: API 错误触发 ERROR 状态', async function() {
  var Core = createTestCore();
  Core.api.callAPI = async function() { throw new Error('API timeout'); };
  workflowMod.init(Core);
  var machine = Core.workflow.stateMachine.createMachine('失败任务');
  var result = await Core.workflow.stateMachine.runMachine(machine);
  assert.ok(result.reply.includes('❌') || result.reply.includes('出错'));
  helper.cleanTestData();
});

helper.cleanTestData();
