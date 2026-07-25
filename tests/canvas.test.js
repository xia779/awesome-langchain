// tests/canvas.test.js — 画布模块单元测试（Wave 6a）
// canvas-store: 数据模型 / 级联删除 / 持久化 / 视口 / 工作区 / 事件
// canvas-view: Node 环境安全性 / API 面 / 命令注册 / 无 DOM 下与 store 联动
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createMockCore, TEST_DATA_ROOT } = require('./helper');

const STORE_PATH = require.resolve('../modules/canvas-store.js');
const VIEW_PATH = require.resolve('../modules/canvas-view.js');

function withBus(Core) {
  const bus = {};
  const events = [];
  Core.on = (ev, fn) => { (bus[ev] = bus[ev] || []).push(fn); return () => {}; };
  Core.emit = (ev, data) => { events.push({ ev, data }); (bus[ev] || []).forEach(fn => fn(data)); };
  return { bus, events };
}

test('canvas-store: CRUD / 级联删除 / 视口 / 事件', () => {
  delete require.cache[STORE_PATH];
  const store = require('../modules/canvas-store.js');
  const Core = createMockCore();
  const { events } = withBus(Core);
  store.init(Core);

  assert.ok(Core.canvas && Core.canvas.store, 'Core.canvas.store 应存在');
  const S = Core.canvas.store;
  ['addNode', 'updateNode', 'removeNode', 'getNode', 'listNodes',
   'addEdge', 'removeEdge', 'listEdges', 'setViewport', 'getViewport',
   'save', 'load', 'switchWorkspace', 'newWorkspace', 'clear', 'serialize']
    .forEach(m => assert.strictEqual(typeof S[m], 'function', 'S.' + m + ' 应为函数'));

  // addNode 默认值 + 事件
  const a = S.addNode({ type: 'agent', title: 'A', x: 10, y: 20 });
  assert.ok(a.id, '节点应有 id');
  assert.strictEqual(a.type, 'agent');
  assert.strictEqual(a.x, 10);
  assert.ok(a.createdAt > 0);
  assert.ok(events.some(e => e.ev === 'canvas:node-add'), '应发 canvas:node-add');

  const b = S.addNode({ type: 'tool', title: 'B' }); // 默认 note 位置/type 覆盖
  assert.strictEqual(b.type, 'tool');
  assert.strictEqual(S.listNodes().length, 2);

  // updateNode
  S.updateNode(a.id, { title: 'A2' });
  assert.strictEqual(S.getNode(a.id).title, 'A2');
  assert.ok(events.some(e => e.ev === 'canvas:node-update'));

  // addEdge：端点必须存在
  assert.strictEqual(S.addEdge({ from: 'nope', to: b.id }), null, '缺失端点应返回 null');
  const e1 = S.addEdge({ from: a.id, to: b.id, kind: 'data-flow' });
  assert.ok(e1 && e1.id, '应创建连线');
  assert.strictEqual(S.listEdges().length, 1);

  // removeNode 级联删除相连连线
  S.removeNode(a.id);
  assert.strictEqual(S.getNode(a.id), null, '节点应被删除');
  assert.strictEqual(S.listEdges().length, 0, '相连连线应被级联删除');
  assert.ok(events.some(e => e.ev === 'canvas:node-remove'));

  // 视口缩放钳制
  S.setViewport({ zoom: 99 });
  assert.strictEqual(S.getViewport().zoom, S.ZOOM_MAX, 'zoom 应钳制到上限');
  S.setViewport({ zoom: 0.001 });
  assert.strictEqual(S.getViewport().zoom, S.ZOOM_MIN, 'zoom 应钳制到下限');
});

test('canvas-store: 持久化 save/load + 工作区 + 路径清洗', () => {
  delete require.cache[STORE_PATH];
  const store = require('../modules/canvas-store.js');
  const Core = createMockCore();
  withBus(Core);
  store.init(Core);
  const S = Core.canvas.store;

  S.addNode({ type: 'note', title: 'persist-me', x: 5, y: 6 });
  assert.strictEqual(S.save(), true, 'save 应成功');

  const file = path.join(TEST_DATA_ROOT, 'canvas', 'default.json');
  assert.ok(fs.existsSync(file), '应写出 default.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.workspace, 'default');
  const titles = Object.keys(raw.nodes).map(k => raw.nodes[k].title);
  assert.ok(titles.includes('persist-me'), '文件应含节点');

  // 清空内存后 load 恢复
  S.clear();
  assert.strictEqual(S.listNodes().length, 0);
  assert.strictEqual(S.load(), true, 'load 应成功');
  assert.strictEqual(S.listNodes().length, 1, 'load 后应恢复节点');
  assert.strictEqual(S.listNodes()[0].title, 'persist-me');

  // 工作区切换
  S.newWorkspace('zone2');
  assert.strictEqual(S.getWorkspace(), 'zone2');
  assert.strictEqual(S.listNodes().length, 0, '新工作区应为空');
  S.switchWorkspace('default');
  assert.strictEqual(S.getWorkspace(), 'default');
  assert.strictEqual(S.listNodes().length, 1, '切回 default 应恢复节点');
  assert.ok(S.listWorkspaces().includes('default'), 'listWorkspaces 应含 default');

  // 路径清洗：穿越字符被替换（'../evil' 的 . . / 三个非法字符各替换为 _）
  assert.strictEqual(store._internals.safeName('../evil'), '___evil', 'safeName 应清洗路径穿越');
});

test('canvas-view: Node 环境（无 DOM）安全 + API 面 + 命令注册 + 与 store 联动', () => {
  delete global.window;
  delete require.cache[STORE_PATH];
  delete require.cache[VIEW_PATH];
  const store = require('../modules/canvas-store.js');
  const view = require('../modules/canvas-view.js');

  const Core = createMockCore();
  withBus(Core);
  store.init(Core);   // 先建立 Core.canvas.store（依赖顺序）
  view.init(Core);    // 再挂视图 API

  // 隔离磁盘残留：store.init 会自动载入上一轮测试写出的 default.json，先清空内存态
  Core.canvas.store.clear();
  assert.strictEqual(Core.canvas.store.listNodes().length, 0, '清空后应为空');

  // store 未被视图覆盖
  assert.ok(Core.canvas.store, 'Core.canvas.store 应保留');
  ['open', 'close', 'toggle', 'isOpen', 'render', 'fit', 'resetView', 'zoomBy', 'addNode', 'focusNode']
    .forEach(m => assert.strictEqual(typeof Core.canvas[m], 'function', 'Core.canvas.' + m + ' 应为函数'));

  // /canvas 命令已注册
  assert.ok(Core.custom._commands['canvas'], '/canvas 命令应注册');

  // 无 DOM 时全部安全 no-op
  assert.strictEqual(Core.canvas.isOpen(), false, '无 DOM 时 isOpen 应为 false');
  assert.strictEqual(Core.canvas.open(), false, '无 DOM 时 open 应返回 false');
  assert.doesNotThrow(() => Core.canvas.toggle(), '无 DOM 时 toggle 不应抛错');
  assert.doesNotThrow(() => Core.canvas.render(), '无 DOM 时 render 不应抛错');
  assert.doesNotThrow(() => Core.canvas.fit(), '无 DOM 时 fit 不应抛错');

  // addNode 在无 DOM 下仍写入 store（联动正确）
  const n = Core.canvas.addNode('note', { title: '无 DOM 节点', x: 1, y: 2 });
  assert.ok(n && n.id, 'addNode 应返回节点');
  assert.strictEqual(Core.canvas.store.listNodes().length, 1, '节点应进入 store');
});
