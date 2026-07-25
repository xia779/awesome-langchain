// tests/canvas-sync.test.js — 画布事件投影单元测试（Wave 6b）
// 覆盖：agent+tool 生命周期与按 step 去重、ai:error、task:sync 全量差分、启动状态调和、Node 安全
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockCore } = require('./helper');

const STORE_PATH = require.resolve('../modules/canvas-store.js');
const SYNC_PATH = require.resolve('../modules/canvas-sync.js');

function freshSetup() {
  delete require.cache[STORE_PATH];
  delete require.cache[SYNC_PATH];
  const store = require('../modules/canvas-store.js');
  const sync = require('../modules/canvas-sync.js');
  const Core = createMockCore();
  const bus = {};
  Core.on = (ev, fn) => { (bus[ev] = bus[ev] || []).push(fn); };
  Core.emit = (ev, data) => { (bus[ev] || []).forEach(fn => fn(data)); };
  store.init(Core);
  Core.canvas.store.clear(); // 清掉 init 自动载入的磁盘残留，保证干净起点
  sync.init(Core);
  return { Core, store: Core.canvas.store, sync };
}

function byType(store, type) {
  return store.listNodes().filter(n => n.type === type);
}

test('canvas-sync: agent + tool 生命周期投影（含按 step 去重）', () => {
  const { Core, store } = freshSetup();

  Core.emit('typingStart');
  let agents = byType(store, 'agent');
  assert.strictEqual(agents.length, 1, '应投影出 1 个 agent 节点');
  assert.strictEqual(agents[0].status, 'thinking', 'agent 初始为 thinking');

  Core.emit('agent-think', { step: 1, maxSteps: 3 });
  agents = byType(store, 'agent');
  assert.strictEqual(agents[0].status, 'thinking');
  assert.ok(/思考 1\/3/.test(agents[0].title), '标题应含步骤信息');

  // 第一次工具调用 → 生成 tool 节点 + 连线，agent 转 executing
  Core.emit('agent-tool', { action: 'web_search', step: 1, maxSteps: 3 });
  let tools = byType(store, 'tool');
  assert.strictEqual(tools.length, 1, '应生成 1 个 tool 节点');
  assert.strictEqual(tools[0].status, 'running');
  assert.strictEqual(tools[0].title, '网络搜索', 'web_search 应映射为中文标签');
  assert.strictEqual(store.listEdges().length, 1, '应有 agent→tool 连线');
  assert.strictEqual(store.listEdges()[0].kind, 'delegation');
  assert.strictEqual(byType(store, 'agent')[0].status, 'executing');

  // 同一步重复触发（agent-loop 两处各发一次）→ 不重复生成节点
  Core.emit('agent-tool', { action: 'web_search', step: 1, maxSteps: 3 });
  assert.strictEqual(byType(store, 'tool').length, 1, '同 step 去重，仍为 1 个 tool 节点');

  // 第二步工具 → 第 2 个 tool 节点
  Core.emit('agent-tool', { action: 'knowledge_search', step: 2, maxSteps: 3 });
  tools = byType(store, 'tool');
  assert.strictEqual(tools.length, 2, '应有 2 个 tool 节点');
  assert.ok(tools.some(t => t.title === '知识检索'));
  assert.strictEqual(store.listEdges().length, 2, '应有 2 条连线');

  // 结束 → agent 与所有 tool 转 done，运行上下文清空
  Core.emit('typingEnd');
  assert.strictEqual(byType(store, 'agent')[0].status, 'done');
  assert.ok(byType(store, 'tool').every(t => t.status === 'done'), '所有 tool 应转 done');
  assert.strictEqual(Core.canvasSync.activeRun, null, '运行上下文应清空');
});

test('canvas-sync: ai:error → agent 节点转 error', () => {
  const { Core, store } = freshSetup();
  Core.emit('typingStart');
  Core.emit('ai:error', { message: 'model timeout' });
  const agent = byType(store, 'agent')[0];
  assert.strictEqual(agent.status, 'error');
  assert.ok(/出错/.test(agent.title), '标题应标记出错');
  assert.strictEqual(Core.canvasSync.activeRun, null);
});

test('canvas-sync: task:sync 全量差分（新增/更新/移除）', () => {
  const { Core, store } = freshSetup();

  Core.emit('task:sync', { tasks: [
    { id: 1, title: '收集资料', status: 'pending' },
    { id: 2, title: '撰写报告', status: 'in_progress' }
  ]});
  let tasks = byType(store, 'task');
  assert.strictEqual(tasks.length, 2, '应投影 2 个 task 节点');
  const t1 = tasks.find(t => t.data.taskId === 1);
  const t2 = tasks.find(t => t.data.taskId === 2);
  assert.strictEqual(t1.status, 'pending');
  assert.strictEqual(t2.status, 'running', 'in_progress 应映射为 running');

  // 第二次同步：任务1完成，任务2消失 → 更新+移除
  Core.emit('task:sync', { tasks: [{ id: 1, title: '收集资料', status: 'completed' }] });
  tasks = byType(store, 'task');
  assert.strictEqual(tasks.length, 1, '任务2 节点应被移除');
  assert.strictEqual(tasks[0].data.taskId, 1);
  assert.strictEqual(tasks[0].status, 'done', 'completed 应映射为 done');
});

test('canvas-sync: 启动调和——遗留运行态降级为 interrupted', () => {
  delete require.cache[STORE_PATH];
  delete require.cache[SYNC_PATH];
  const store = require('../modules/canvas-store.js');
  const sync = require('../modules/canvas-sync.js');
  const Core = createMockCore();
  Core.on = () => {}; Core.emit = () => {};
  store.init(Core);
  const S = Core.canvas.store;
  S.clear();
  // 模拟上次会话崩溃遗留的「运行中」假状态
  const a = S.addNode({ type: 'agent', status: 'thinking' });
  const b = S.addNode({ type: 'tool', status: 'running' });
  const c = S.addNode({ type: 'note', status: 'done' });

  sync.init(Core); // 触发 reconcileStale

  assert.strictEqual(S.getNode(a.id).status, 'interrupted', 'thinking 应降级');
  assert.strictEqual(S.getNode(b.id).status, 'interrupted', 'running 应降级');
  assert.strictEqual(S.getNode(c.id).status, 'done', 'done 不应被改动');
});

test('canvas-sync: 无 on/emit 的 Core 下初始化安全', () => {
  delete require.cache[STORE_PATH];
  delete require.cache[SYNC_PATH];
  const store = require('../modules/canvas-store.js');
  const sync = require('../modules/canvas-sync.js');
  const Core = createMockCore(); // mock 默认无 on/emit
  store.init(Core);
  assert.doesNotThrow(() => sync.init(Core), '无事件总线时 init 不应抛错');
  assert.ok(Core.canvasSync, 'Core.canvasSync 应存在');
  assert.doesNotThrow(() => Core.canvasSync.reset());
});
