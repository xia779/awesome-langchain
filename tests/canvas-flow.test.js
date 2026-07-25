// tests/canvas-flow.test.js — 画布工作流编排单元测试（Wave 6c）
// 覆盖：workflow:start 自动补建工作流节点、workflow:step 逐步点亮（sequence 链）、
//       workflow:done 收尾、createWorkflowNode（模板/已有）、runWorkflowNode 端到端、
//       workflow.js 真实广播、Node 安全
const { test, after } = require('node:test');
const assert = require('node:assert');
const { createMockCore } = require('./helper');

// workflow.js 在执行时会向 stdout 打印带 emoji 的进度日志；在 Node 24 测试运行器
// 高并发（16 路）下这些散落输出会破坏子进程→父进程的 IPC 帧，导致
// "Unable to deserialize cloned data" 误报。node:test 的报告走独立流而非 console.log，
// 故在此静默 console 输出即可，不影响断言与结果上报。
const _origLog = console.log;
const _origWarn = console.warn;
console.log = () => {};
console.warn = () => {};
after(() => { console.log = _origLog; console.warn = _origWarn; });

const STORE_PATH = require.resolve('../modules/canvas-store.js');
const FLOW_PATH = require.resolve('../modules/canvas-flow.js');
const WF_PATH = require.resolve('../modules/workflow.js');

function freshSetup() {
  delete require.cache[STORE_PATH];
  delete require.cache[FLOW_PATH];
  delete require.cache[WF_PATH];
  const store = require('../modules/canvas-store.js');
  const flow = require('../modules/canvas-flow.js');
  const workflow = require('../modules/workflow.js');
  const Core = createMockCore();
  const bus = {};
  Core.on = (ev, fn) => { (bus[ev] = bus[ev] || []).push(fn); };
  Core.emit = (ev, data) => { (bus[ev] || []).forEach(fn => fn(data)); };
  store.init(Core);
  Core.canvas.store.clear(); // 清掉 init 自动载入的磁盘残留
  workflow.init(Core);
  flow.init(Core);
  return { Core, store: Core.canvas.store, flow };
}

function byType(store, type) {
  return store.listNodes().filter(n => n.type === type);
}

const flush = () => new Promise(r => setTimeout(r, 20));

test('canvas-flow: workflow:start 自动补建工作流节点', () => {
  const { Core, store } = freshSetup();
  Core.emit('workflow:start', { workflowId: 'wf_x', name: '演示流程', total: 2 });
  const wfs = byType(store, 'workflow');
  assert.strictEqual(wfs.length, 1, '应补建 1 个工作流节点');
  assert.strictEqual(wfs[0].data.workflowId, 'wf_x');
  assert.strictEqual(wfs[0].status, 'running');
});

test('canvas-flow: workflow:step 逐步点亮并串成 sequence 链', () => {
  const { Core, store } = freshSetup();
  Core.emit('workflow:start', { workflowId: 'wf_y', name: '流程Y', total: 2 });

  // 步骤1 running → 生成步骤节点 + wf→step 连线
  Core.emit('workflow:step', { workflowId: 'wf_y', index: 0, total: 2, stepName: '变换A', type: 'transform', status: 'running' });
  let tools = byType(store, 'tool');
  assert.strictEqual(tools.length, 1, '应生成 1 个步骤节点');
  assert.ok(/变换A \(1\/2\)/.test(tools[0].title), '标题应含步骤名与序号');
  assert.strictEqual(tools[0].status, 'running');
  assert.strictEqual(store.listEdges().length, 1);
  assert.strictEqual(store.listEdges()[0].kind, 'sequence');

  // 步骤1 done → 转 done，不新增节点
  Core.emit('workflow:step', { workflowId: 'wf_y', index: 0, total: 2, status: 'done' });
  assert.strictEqual(byType(store, 'tool').length, 1);
  assert.strictEqual(byType(store, 'tool')[0].status, 'done');

  // 步骤2 running → 第 2 个节点 + step1→step2 连线
  Core.emit('workflow:step', { workflowId: 'wf_y', index: 1, total: 2, stepName: '变换B', type: 'transform', status: 'running' });
  assert.strictEqual(byType(store, 'tool').length, 2);
  assert.strictEqual(store.listEdges().length, 2, '应有 wf→s1、s1→s2 两条 sequence 边');

  // 收尾
  Core.emit('workflow:step', { workflowId: 'wf_y', index: 1, total: 2, status: 'done' });
  Core.emit('workflow:done', { workflowId: 'wf_y', name: '流程Y', success: true });
  assert.strictEqual(byType(store, 'workflow')[0].status, 'done', '工作流节点应转 done');
  assert.strictEqual(Object.keys(Core.canvasFlow.runs).length, 0, '运行上下文应清空');
});

test('canvas-flow: workflow:done success:false → 工作流节点转 error', () => {
  const { Core, store } = freshSetup();
  Core.emit('workflow:start', { workflowId: 'wf_z', name: '流程Z', total: 1 });
  Core.emit('workflow:done', { workflowId: 'wf_z', name: '流程Z', success: false, error: 'boom' });
  assert.strictEqual(byType(store, 'workflow')[0].status, 'error');
});

test('canvas-flow: createWorkflowNode 从内置模板安装并落点', () => {
  const { Core, store } = freshSetup();
  const node = Core.canvas.createWorkflowNode({ templateIndex: 0, x: 100, y: 200 });
  assert.ok(node, '应返回节点');
  assert.strictEqual(node.type, 'workflow');
  assert.strictEqual(node.status, 'idle');
  assert.ok(node.data.workflowId, '应写入 workflowId');
  assert.strictEqual(node.x, 100);
  assert.strictEqual(node.y, 200);
  // 模板应已安装进引擎
  assert.ok(Core.workflow.engine.list().some(w => w.id === node.data.workflowId));
});

test('canvas-flow: runWorkflowNode 端到端（transform 工作流投影步骤节点）', async () => {
  const { Core, store } = freshSetup();
  // 造一个纯 transform 工作流（无需 Core.api）
  const wf = Core.workflow.engine.create({
    name: '纯变换',
    steps: [
      { type: 'transform', input: 'hello world', saveAs: 'a' },
      { type: 'transform', inputVar: 'a', regex: 'world', replacement: 'canvas', saveAs: 'b' }
    ]
  });
  const node = Core.canvas.createWorkflowNode({ workflowId: wf.id });
  assert.strictEqual(node.status, 'idle');

  const ok = Core.canvas.runWorkflowNode(node.id, '');
  assert.strictEqual(ok, true, 'runWorkflowNode 应返回 true');
  assert.strictEqual(store.getNode(node.id).status, 'running', '发起后应立即转 running');

  await flush(); // 等待异步 runWorkflow 完成投影

  const steps = byType(store, 'tool');
  assert.strictEqual(steps.length, 2, '应投影 2 个步骤节点');
  assert.ok(steps.every(s => s.status === 'done'), '步骤应全部 done');
  assert.strictEqual(store.getNode(node.id).status, 'done', '工作流节点最终应 done');
  assert.ok(store.listEdges().length >= 2, '应有 sequence 连线');
});

test('canvas-flow: runWorkflowNode 对非工作流节点返回 false', () => {
  const { Core, store } = freshSetup();
  const note = store.addNode({ type: 'note', title: 'n' });
  assert.strictEqual(Core.canvas.runWorkflowNode(note.id, ''), false);
  assert.strictEqual(Core.canvas.runWorkflowNode('nonexistent', ''), false);
});

test('workflow.js: runWorkflow 真实广播 start/step/done', async () => {
  delete require.cache[WF_PATH];
  const workflow = require('../modules/workflow.js');
  const Core = createMockCore();
  const events = [];
  Core.on = () => {};
  Core.emit = (ev, data) => { events.push({ ev, data }); };
  workflow.init(Core);

  const wf = Core.workflow.engine.create({
    name: '广播测试',
    steps: [{ type: 'transform', input: 'x', saveAs: 'out' }]
  });
  const res = await Core.workflow.engine.run(wf.id, '');
  assert.strictEqual(res.success, true);

  const names = events.map(e => e.ev);
  assert.ok(names.includes('workflow:start'), '应广播 workflow:start');
  assert.ok(names.includes('workflow:step'), '应广播 workflow:step');
  assert.ok(names.includes('workflow:done'), '应广播 workflow:done');

  const start = events.find(e => e.ev === 'workflow:start');
  assert.strictEqual(start.data.workflowId, wf.id);
  assert.strictEqual(start.data.total, 1);

  const stepRuns = events.filter(e => e.ev === 'workflow:step' && e.data.status === 'running');
  const stepDone = events.filter(e => e.ev === 'workflow:step' && e.data.status === 'done');
  assert.strictEqual(stepRuns.length, 1, '应有 1 个 running 步骤广播');
  assert.strictEqual(stepDone.length, 1, '应有 1 个 done 步骤广播');

  const done = events.find(e => e.ev === 'workflow:done');
  assert.strictEqual(done.data.success, true);
});

test('canvas-flow: 无 on/emit 的 Core 下初始化安全', () => {
  delete require.cache[STORE_PATH];
  delete require.cache[FLOW_PATH];
  const store = require('../modules/canvas-store.js');
  const flow = require('../modules/canvas-flow.js');
  const Core = createMockCore(); // 默认无 on/emit
  store.init(Core);
  assert.doesNotThrow(() => flow.init(Core), '无事件总线时 init 不应抛错');
  assert.ok(Core.canvasFlow, 'Core.canvasFlow 应存在');
  assert.strictEqual(typeof Core.canvas.createWorkflowNode, 'function');
  assert.strictEqual(typeof Core.canvas.runWorkflowNode, 'function');
  assert.doesNotThrow(() => Core.canvasFlow.reset());
});
