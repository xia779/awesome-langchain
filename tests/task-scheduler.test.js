// tests/task-scheduler.test.js — 任务调度器测试（Wave 8）
// 覆盖：Task Schema / 非阻塞提交 / Worker 池并发 / 优先级 / 拆解聚合 /
//       取消 / 画布投影 / HUD 通知 / 持久化重载 / /task 命令
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helper = require('./helper');

const SCHED_PATH = require.resolve('../modules/task-scheduler.js');
const intentRouterMod = require('../modules/intent-router.js');
const subrolesMod = require('../modules/subroles.js');

const defaultApi = async (prompt) => ({ message: { content: '结果: ' + String(prompt).substring(0, 30) } });

function withBus(Core) {
  const bus = {};
  Core.on = (ev, fn) => {
    (bus[ev] = bus[ev] || []).push(fn);
    return () => { const a = bus[ev] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  };
  Core.emit = (ev, data) => { (bus[ev] || []).slice().forEach(fn => fn(data)); };
  return Core;
}

// 每个测试都拿到「干净的模块实例 + 干净的数据目录」
function setup(opts) {
  opts = opts || {};
  helper.cleanTestData();
  delete require.cache[SCHED_PATH];
  const Core = withBus(helper.createMockCore());
  Core.api = { callAPI: opts.api || defaultApi };
  intentRouterMod.init(Core);
  subrolesMod.init(Core);
  const mod = require('../modules/task-scheduler.js');
  mod.init(Core);
  return { Core, mod };
}

function waitFor(Core, evName, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('等待 ' + evName + ' 超时')); }, timeoutMs || 2000);
    const off = Core.on(evName, (data) => {
      if (!predicate || predicate(data)) { clearTimeout(timer); off(); resolve(data); }
    });
  });
}

// ===== 模块结构 =====
test('task-scheduler 模块导出与依赖', () => {
  const { mod } = setup();
  assert.strictEqual(mod.name, 'task-scheduler');
  assert.ok(mod.dependencies.includes('intent-router'));
  assert.ok(mod.dependencies.includes('subroles'));
  assert.strictEqual(typeof mod.init, 'function');
});

test('init 创建 Core.taskScheduler 命名空间', () => {
  const { Core } = setup();
  ['submit', 'getTask', 'getTaskResult', 'listTasks', 'cancelTask', 'setConcurrency', 'getStats']
    .forEach(m => assert.strictEqual(typeof Core.taskScheduler[m], 'function', m + ' 应为函数'));
});

// ===== 非阻塞提交 + 意图路由 =====
test('submit 闲聊不派发（交回主对话）', () => {
  const { Core } = setup();
  const r = Core.taskScheduler.submit('你好呀');
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.intent, 'chat');
});

test('submit 空输入不派发', () => {
  const { Core } = setup();
  assert.strictEqual(Core.taskScheduler.submit('').dispatched, false);
});

test('submit 代码任务派发给 code_expert', () => {
  const { Core } = setup();
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.intent, 'code_generation');
  assert.strictEqual(r.roleId, 'code_expert');
  assert.ok(r.taskId);
});

// ===== Task Schema =====
test('Task Schema 字段完整 + taskId 格式', () => {
  const { Core, mod } = setup();
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  const t = mod._internals._state.tasks[r.taskId];
  assert.ok(/^task_\d{8}_\d{3}$/.test(t.taskId), 'taskId 应为 task_YYYYMMDD_NNN');
  assert.strictEqual(t.taskType, 'code_generation');
  assert.strictEqual(typeof t.priority, 'number');
  assert.ok(['pending', 'running', 'completed', 'failed'].includes(t.status));
  assert.strictEqual(t.params.query, '帮我写一个排序代码');
  assert.ok(t.callbackChannel);
  assert.ok(t.createdAt > 0);
  assert.strictEqual(t.parentTaskId, null);
});

// ===== 生命周期 + 非阻塞 =====
test('submit 非阻塞：同步快速返回，任务后台完成', async () => {
  const slowApi = async () => { await new Promise(r => setTimeout(r, 120)); return { message: { content: 'ok' } }; };
  const { Core } = setup({ api: slowApi });
  const t0 = Date.now();
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  assert.ok(Date.now() - t0 < 100, 'submit 应同步快速返回');
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(Core.taskScheduler.getTask(r.taskId).status, 'running', '提交后应立即进入运行态');
  await waitFor(Core, 'task:done', d => d.taskId === r.taskId);
  assert.strictEqual(Core.taskScheduler.getTask(r.taskId).status, 'completed');
});

test('任务完成后 result 可读（getTaskResult）', async () => {
  const { Core } = setup();
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  await waitFor(Core, 'task:done', d => d.taskId === r.taskId);
  const res = Core.taskScheduler.getTaskResult(r.taskId);
  assert.strictEqual(res.success, true);
  assert.ok(res.result.includes('结果'));
});

test('任务失败进入 failed 并发 task:error', async () => {
  const failApi = async () => { throw new Error('模型超时'); };
  const { Core } = setup({ api: failApi });
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  const ev = await waitFor(Core, 'task:error', d => d.taskId === r.taskId);
  assert.ok(ev.error.includes('模型超时'));
  assert.strictEqual(Core.taskScheduler.getTask(r.taskId).status, 'failed');
});

// ===== Worker 池 =====
test('Worker 池默认并发可并行执行', async () => {
  const slowApi = async () => { await new Promise(r => setTimeout(r, 100)); return { message: { content: 'x' } }; };
  const { Core } = setup({ api: slowApi });
  const r1 = Core.taskScheduler.submit('写一个代码');
  const r2 = Core.taskScheduler.submit('写一个排序代码');
  assert.strictEqual(Core.taskScheduler.getTask(r1.taskId).status, 'running');
  assert.strictEqual(Core.taskScheduler.getTask(r2.taskId).status, 'running', '默认并发 3 应并行');
  await waitFor(Core, 'task:done', d => d.taskId === r2.taskId, 3000);
});

test('Worker 池并发上限为 1 时串行', async () => {
  const slowApi = async () => { await new Promise(r => setTimeout(r, 100)); return { message: { content: 'x' } }; };
  const { Core } = setup({ api: slowApi });
  Core.taskScheduler.setConcurrency(1);
  const r1 = Core.taskScheduler.submit('写一个爬虫代码');
  const r2 = Core.taskScheduler.submit('写一个排序代码');
  assert.strictEqual(Core.taskScheduler.getTask(r1.taskId).status, 'running');
  assert.strictEqual(Core.taskScheduler.getTask(r2.taskId).status, 'pending', '超出并发应排队');
  await waitFor(Core, 'task:done', d => d.taskId === r2.taskId, 3000);
  assert.strictEqual(Core.taskScheduler.getTask(r1.taskId).status, 'completed');
  assert.strictEqual(Core.taskScheduler.getTask(r2.taskId).status, 'completed');
});

test('优先级：数字小的先执行', async () => {
  const slowApi = async () => { await new Promise(r => setTimeout(r, 80)); return { message: { content: 'x' } }; };
  const { Core } = setup({ api: slowApi });
  Core.taskScheduler.setConcurrency(1);
  const startOrder = [];
  Core.on('task:start', d => startOrder.push(d.taskId));
  const blocker = Core.taskScheduler.submit('写一个代码', { priority: 3 });
  const low = Core.taskScheduler.submit('写一个排序代码', { priority: 5 });
  const high = Core.taskScheduler.submit('写一个调试代码', { priority: 1 });
  await waitFor(Core, 'task:done', d => d.taskId === low.taskId, 3000);
  assert.strictEqual(startOrder[0], blocker.taskId);
  assert.strictEqual(startOrder[1], high.taskId, 'priority=1 应先于 priority=5');
  assert.strictEqual(startOrder[2], low.taskId);
});

test('setConcurrency 参数校验', () => {
  const { Core } = setup();
  assert.strictEqual(Core.taskScheduler.setConcurrency(0).success, false);
  assert.strictEqual(Core.taskScheduler.setConcurrency(99).success, false);
  assert.strictEqual(Core.taskScheduler.setConcurrency(2).success, true);
});

// ===== 拆解 + 聚合 =====
test('复合任务：自动拆解为子任务并聚合', async () => {
  const { Core } = setup();
  const r = Core.taskScheduler.submit('1. 写一个爬虫代码\n2. 总结这份文档');
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.subtasks.length, 2);
  await waitFor(Core, 'task:aggregated', d => d.taskId === r.taskId, 3000);
  const parent = Core.taskScheduler.getTask(r.taskId);
  assert.strictEqual(parent.status, 'completed');
  const res = Core.taskScheduler.getTaskResult(r.taskId);
  assert.ok(res.result.includes('【子任务 1'));
  assert.ok(res.result.includes('【子任务 2'));
});

// ===== 取消 =====
test('cancelTask：pending 可取消，running 拒绝', async () => {
  const slowApi = async () => { await new Promise(r => setTimeout(r, 120)); return { message: { content: 'x' } }; };
  const { Core } = setup({ api: slowApi });
  Core.taskScheduler.setConcurrency(1);
  const r1 = Core.taskScheduler.submit('写一个代码');
  const r2 = Core.taskScheduler.submit('写一个排序代码');
  assert.strictEqual(Core.taskScheduler.cancelTask(r2.taskId).success, true);
  assert.strictEqual(Core.taskScheduler.getTask(r2.taskId).status, 'cancelled');
  assert.strictEqual(Core.taskScheduler.cancelTask(r1.taskId).success, false);
  await waitFor(Core, 'task:done', d => d.taskId === r1.taskId, 3000);
});

// ===== 统计 =====
test('getStats 统计正确', async () => {
  const { Core } = setup();
  Core.taskScheduler.submit('帮我写一个排序代码');
  await waitFor(Core, 'task:done', () => true);
  const s = Core.taskScheduler.getStats();
  assert.strictEqual(s.completed, 1);
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.maxConcurrency, 3);
});

// ===== 画布投影 =====
test('画布投影：创建 task 节点并同步状态', async () => {
  const { Core } = setup();
  const nodes = {};
  Core.canvas = {
    store: {
      addNode: function (n) { const id = 'n' + (Object.keys(nodes).length + 1); nodes[id] = Object.assign({ id }, n); return nodes[id]; },
      updateNode: function (id, patch) { if (nodes[id]) Object.assign(nodes[id], patch); return nodes[id]; },
      addEdge: function (e) { return Object.assign({ id: 'e' }, e); }
    }
  };
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  const nodeId = Core.taskScheduler.getTask(r.taskId).canvasNodeId;
  assert.ok(nodeId, '应创建画布节点');
  assert.strictEqual(nodes[nodeId].type, 'task');
  await waitFor(Core, 'task:done', d => d.taskId === r.taskId);
  assert.strictEqual(nodes[nodeId].status, 'done', '完成后节点应变绿（done）');
});

// ===== HUD 通知 =====
test('HUD 通知：完成时推送轻量摘要', async () => {
  const { Core } = setup();
  const calls = [];
  Core.hud = { setState: (state, opts) => calls.push(Object.assign({ state }, opts)) };
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  await waitFor(Core, 'task:done', d => d.taskId === r.taskId);
  await new Promise(res => setTimeout(res, 10));
  assert.ok(calls.some(c => c.text && c.text.includes('✅')), '应有完成通知');
});

test('HUD 通知：callbackChannel=canvas 时不打扰 HUD', async () => {
  const { Core } = setup();
  const calls = [];
  Core.hud = { setState: (state, opts) => calls.push(opts) };
  const r = Core.taskScheduler.submit('帮我写一个排序代码', { callbackChannel: 'canvas' });
  await waitFor(Core, 'task:done', d => d.taskId === r.taskId);
  await new Promise(res => setTimeout(res, 10));
  assert.strictEqual(calls.length, 0, '仅画布回调时不应推送 HUD');
});

// ===== 持久化 =====
test('持久化：saveNow 落盘 + 重载恢复', async () => {
  const { Core } = setup();
  const r = Core.taskScheduler.submit('帮我写一个排序代码');
  await waitFor(Core, 'task:done', d => d.taskId === r.taskId);
  Core.taskScheduler.saveNow();
  const file = path.join(Core.DATA_ROOT, 'tasks.json');
  assert.ok(fs.existsSync(file), 'tasks.json 应存在');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.tasks.some(t => t.taskId === r.taskId));

  // 不清数据，重载新实例 → 应恢复任务
  delete require.cache[SCHED_PATH];
  const mod2 = require('../modules/task-scheduler.js');
  const Core2 = withBus(helper.createMockCore());
  Core2.api = { callAPI: defaultApi };
  intentRouterMod.init(Core2);
  subrolesMod.init(Core2);
  mod2.init(Core2);
  const restored = Core2.taskScheduler.getTask(r.taskId);
  assert.ok(restored, '重载后应恢复任务');
  assert.strictEqual(restored.status, 'completed');
});

// ===== /task 命令 =====
test('/task 命令已注册且可用', () => {
  const { Core } = setup();
  assert.ok(Core.custom._commands['/task'], '/task 命令应注册');
  const out = Core.custom._commands['/task'].handler('stats');
  assert.ok(out.includes('任务统计'));
  const roles = Core.custom._commands['/task'].handler('roles');
  assert.ok(roles.includes('代码专家'));
});

helper.cleanTestData();
