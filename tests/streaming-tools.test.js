/**
 * tests/streaming-tools.test.js — Streaming Tool Calls 测试
 */
var test = require('node:test');
var assert = require('node:assert');

var helper = require('./helper');
var streamMod = require('../modules/streaming-tools');

function createTestCore() {
  var Core = helper.createMockCore();
  Core.agentLoop = {
    executeAgentAction: async function(action, params) {
      if (action === 'slow_tool') {
        await new Promise(function(r) { setTimeout(r, 50); });
        return 'slow result: ' + JSON.stringify(params);
      }
      if (action === 'fail_tool') return '❌ tool failed';
      if (action === 'timeout_tool') {
        await new Promise(function(r) { setTimeout(r, 5000); });
        return 'should not reach here';
      }
      return 'result for ' + action + ': ' + JSON.stringify(params || {});
    },
  };
  return Core;
}

// ===== Module Structure =====
test('streaming-tools 模块导出', function() {
  assert.equal(streamMod.name, 'streaming-tools');
  assert.ok(streamMod.dependencies.includes('agent-loop'));
  assert.equal(typeof streamMod.init, 'function');
});

test('init 创建 Core.streamingTools', function() {
  var Core = createTestCore();
  streamMod.init(Core);
  assert.ok(Core.streamingTools);
  assert.equal(typeof Core.streamingTools.executeStreaming, 'function');
  assert.equal(typeof Core.streamingTools.executeBatchStreaming, 'function');
  assert.equal(typeof Core.streamingTools.executePipeline, 'function');
});

// ===== executeStreaming =====
test('executeStreaming: 正常执行', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var result = await Core.streamingTools.executeStreaming('read_file', { path: '/test' });
  assert.equal(result.success, true);
  assert.ok(result.result.includes('read_file'));
  assert.ok(result.duration >= 0);
  assert.ok(result.progressLog.length >= 3); // init, executing, processing, complete
  helper.cleanTestData();
});

test('executeStreaming: 进度回调被调用', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var phases = [];
  await Core.streamingTools.executeStreaming('read_file', {}, {
    onProgress: function(p) { phases.push(p.phase); },
  });
  assert.ok(phases.includes('init'));
  assert.ok(phases.includes('executing'));
  assert.ok(phases.includes('complete'));
  helper.cleanTestData();
});

test('executeStreaming: 超时处理', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var result = await Core.streamingTools.executeStreaming('timeout_tool', {}, { timeout: 100 });
  assert.equal(result.success, false);
  assert.ok(result.timedOut);
  assert.ok(result.result.includes('超时'));
  helper.cleanTestData();
});

test('executeStreaming: 取消处理', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var ac = new AbortController();
  setTimeout(function() { ac.abort(); }, 30);
  var result = await Core.streamingTools.executeStreaming('timeout_tool', {}, { signal: ac.signal, timeout: 5000 });
  assert.equal(result.success, false);
  assert.ok(result.cancelled);
  helper.cleanTestData();
});

// ===== executeBatchStreaming =====
test('executeBatchStreaming: 批量执行', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var tasks = [
    { action: 'read_file', params: { path: '/a' } },
    { action: 'read_file', params: { path: '/b' } },
    { action: 'read_file', params: { path: '/c' } },
  ];
  var result = await Core.streamingTools.executeBatchStreaming(tasks, { concurrency: 2 });
  assert.equal(result.results.length, 3);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.success, 3);
  helper.cleanTestData();
});

test('executeBatchStreaming: onTaskComplete 回调', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var completed = [];
  await Core.streamingTools.executeBatchStreaming(
    [{ action: 'read_file', params: {} }, { action: 'list_dir', params: {} }],
    { onTaskComplete: function(idx, action) { completed.push(action); } }
  );
  assert.equal(completed.length, 2);
  assert.ok(completed.includes('read_file'));
  assert.ok(completed.includes('list_dir'));
  helper.cleanTestData();
});

test('executeBatchStreaming: 包含失败任务', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var tasks = [
    { action: 'read_file', params: {} },
    { action: 'fail_tool', params: {} },
  ];
  var result = await Core.streamingTools.executeBatchStreaming(tasks);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.success, 1);
  assert.equal(result.summary.failed, 1);
  helper.cleanTestData();
});

// ===== executePipeline =====
test('executePipeline: 顺序执行', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var chain = [
    { action: 'read_file', params: { path: '/input.txt' } },
    { action: 'web_search', params: { query: 'result' } },
  ];
  var result = await Core.streamingTools.executePipeline(chain);
  assert.equal(result.success, true);
  assert.equal(result.pipelineLog.length, 2);
  assert.ok(result.totalDuration >= 0);
  helper.cleanTestData();
});

test('executePipeline: 失败时中断', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var chain = [
    { action: 'fail_tool', params: {} },
    { action: 'read_file', params: {} },
  ];
  var result = await Core.streamingTools.executePipeline(chain);
  assert.equal(result.success, false);
  assert.equal(result.failedAt, 0);
  assert.equal(result.pipelineLog.length, 1);
  helper.cleanTestData();
});

test('executePipeline: continueOnError 继续执行', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var chain = [
    { action: 'fail_tool', params: {}, continueOnError: true },
    { action: 'read_file', params: { path: '/ok' } },
  ];
  var result = await Core.streamingTools.executePipeline(chain);
  assert.equal(result.success, true);
  assert.equal(result.pipelineLog.length, 2);
  helper.cleanTestData();
});

test('executePipeline: onStepComplete 回调', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var steps = [];
  await Core.streamingTools.executePipeline(
    [{ action: 'read_file', params: {} }, { action: 'list_dir', params: {} }],
    { onStepComplete: function(idx, action) { steps.push({ idx: idx, action: action }); } }
  );
  assert.equal(steps.length, 2);
  assert.equal(steps[0].idx, 0);
  assert.equal(steps[1].idx, 1);
  helper.cleanTestData();
});

test('executePipeline: transform 传递结果', async function() {
  var Core = createTestCore();
  streamMod.init(Core);
  var chain = [
    { action: 'read_file', params: { path: '/data' } },
    {
      action: 'web_search',
      params: {},
      transform: function(prevResult) {
        return { query: 'processed: ' + prevResult.substring(0, 20) };
      },
    },
  ];
  var result = await Core.streamingTools.executePipeline(chain);
  assert.equal(result.success, true);
  // Second step should have received transformed params
  assert.ok(result.pipelineLog[1].result.includes('processed'));
  helper.cleanTestData();
});

helper.cleanTestData();
