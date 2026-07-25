// tests/canvas-6d.test.js — Wave 6d 单元测试
// 覆盖：画布视口裁剪纯函数（worldRectFromViewport / nodeVisible）、
//       HUD↔画布联动（活跃节点跟踪 / 画布摘要中继 / 一键展开定位 / open-canvas 指令 / 工作区切换同步）
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockCore } = require('./helper');

const HUD_PATH = require.resolve('../modules/hud.js');
const CV_PATH = require.resolve('../modules/canvas-view.js');

// ═══════════════════════════════════════════
// 视口裁剪（纯函数，无需 DOM）
// ═══════════════════════════════════════════

test('canvas-view 裁剪：worldRectFromViewport 由视口推算可视世界矩形', () => {
  delete require.cache[CV_PATH];
  const cv = require('../modules/canvas-view.js');
  const { worldRectFromViewport } = cv._internals;
  const r = worldRectFromViewport({ x: -100, y: -50, zoom: 2 }, 400, 300);
  // x0 = -(-100)/2 = 50；y0 = -(-50)/2 = 25；x1 = 50 + 400/2 = 250；y1 = 25 + 300/2 = 175
  assert.strictEqual(r.x0, 50);
  assert.strictEqual(r.y0, 25);
  assert.strictEqual(r.x1, 250);
  assert.strictEqual(r.y1, 175);
  // 另一组非零视口（zoom=1）：x0=-10, y0=-20, x1=-10+800=790, y1=-20+600=580
  const r2 = worldRectFromViewport({ x: 10, y: 20, zoom: 1 }, 800, 600);
  assert.strictEqual(r2.x0, -10);
  assert.strictEqual(r2.y0, -20);
  assert.strictEqual(r2.x1, 790);
  assert.strictEqual(r2.y1, 580);
});

test('canvas-view 裁剪：nodeVisible 相交判定（含缓冲 margin）', () => {
  delete require.cache[CV_PATH];
  const cv = require('../modules/canvas-view.js');
  const { nodeVisible } = cv._internals;
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
  assert.strictEqual(nodeVisible({ x: 10, y: 10, w: 20, h: 20 }, rect, 0), true, '完全在内应可见');
  assert.strictEqual(nodeVisible({ x: 200, y: 200, w: 20, h: 20 }, rect, 0), false, '完全在外不可见');
  assert.strictEqual(nodeVisible({ x: 120, y: 10, w: 20, h: 20 }, rect, 0), false, '右侧外无缓冲不可见');
  assert.strictEqual(nodeVisible({ x: 120, y: 10, w: 20, h: 20 }, rect, 30), true, '缓冲 30 应纳入');
  assert.strictEqual(nodeVisible({ x: -30, y: 10, w: 20, h: 20 }, rect, 0), false, '左侧外（右缘 -10<0）不可见');
  assert.strictEqual(nodeVisible({ x: 40, y: 90, w: 20, h: 20 }, rect, 0), true, '跨越下边缘应可见');
  assert.strictEqual(nodeVisible(null, rect, 0), false, '空节点不可见');
  assert.strictEqual(nodeVisible({ x: 0, y: 0, w: 10, h: 10 }, null, 0), false, '空矩形不可见');
});

// ═══════════════════════════════════════════
// HUD ↔ 画布联动
// ═══════════════════════════════════════════

function hudSetup() {
  const sent = [];
  const handlers = {};
  global.window = {
    nodeBridge: {
      ipc: {
        send: (ch, payload) => sent.push({ ch, payload }),
        on: (ch, cb) => { handlers[ch] = cb; return () => {}; }
      }
    }
  };
  delete require.cache[HUD_PATH];
  const hud = require('../modules/hud.js');
  const Core = createMockCore();
  const bus = {};
  Core.on = (ev, fn) => { (bus[ev] = bus[ev] || []).push(fn); };
  Core.emit = (ev, d) => { (bus[ev] || []).forEach(fn => fn(d)); };

  const nodes = [];
  let workspace = 'proj-a';
  const calls = { open: 0, focus: null, select: null };
  Core.canvas = {
    store: {
      getWorkspace: () => workspace,
      listNodes: () => nodes,
      getNode: (id) => nodes.find(n => n.id === id) || null
    },
    open: () => { calls.open += 1; },
    focusNode: (id) => { calls.focus = id; },
    selectNode: (id) => { calls.select = id; }
  };
  const setWorkspace = (w) => { workspace = w; };
  return { hud, Core, sent, handlers, nodes, calls, setWorkspace };
}

test('hud↔canvas: 活跃节点跟踪 + 画布摘要中继 + 一键展开定位', () => {
  const { hud, Core, sent, handlers, nodes, calls } = hudSetup();
  hud.init(Core);

  // init 时 store 已挂载 → 应中继一次画布摘要（canvasOnly）
  let relay = sent.filter(s => s.ch === 'hud-relay' && s.payload.canvas).pop();
  assert.ok(relay, 'init 应中继画布摘要');
  assert.strictEqual(relay.payload.canvasOnly, true);
  assert.strictEqual(relay.payload.canvas.workspace, 'proj-a');
  assert.strictEqual(relay.payload.canvas.total, 0);

  // 节点进入运行态 → 跟踪为活跃 + running 计数 + 中继
  nodes.push({ id: 'n1', status: 'thinking' });
  Core.emit('canvas:node-add', { node: nodes[0] });
  assert.strictEqual(Core.hud.activeNodeId, 'n1', '运行态节点应被记为活跃');
  assert.strictEqual(Core.hud.canvasSummary.running, 1);
  assert.strictEqual(Core.hud.canvasSummary.total, 1);
  relay = sent.filter(s => s.ch === 'hud-relay' && s.payload.canvas).pop();
  assert.strictEqual(relay.payload.canvas.running, 1);

  // 非运行态节点不改变活跃目标
  nodes.push({ id: 'n2', status: 'done' });
  Core.emit('canvas:node-add', { node: nodes[1] });
  assert.strictEqual(Core.hud.activeNodeId, 'n1', 'done 节点不应抢占活跃目标');
  assert.strictEqual(Core.hud.canvasSummary.total, 2);
  assert.strictEqual(Core.hud.canvasSummary.running, 1);

  // 一键展开画布 → open + 定位 + 选中活跃节点
  Core.hud.openCanvas();
  assert.strictEqual(calls.open, 1, '应调用 Core.canvas.open');
  assert.strictEqual(calls.focus, 'n1', '应定位到活跃节点');
  assert.strictEqual(calls.select, 'n1', '应选中活跃节点');

  // HUD 窗口发来 open-canvas 指令 → 同样展开
  calls.open = 0;
  handlers['hud-command']({ action: 'open-canvas' });
  assert.strictEqual(calls.open, 1, 'hud-command open-canvas 应触发展开');

  // 移除活跃节点 → activeNodeId 清空
  Core.emit('canvas:node-remove', { id: 'n1' });
  assert.strictEqual(Core.hud.activeNodeId, null, '活跃节点被删后应清空');

  delete global.window;
});

test('hud↔canvas: 工作区切换同步画布摘要', () => {
  const { hud, Core, sent, setWorkspace } = hudSetup();
  hud.init(Core);

  setWorkspace('sprint-2');
  Core.emit('canvas:workspace', { workspace: 'sprint-2' });
  const relay = sent.filter(s => s.ch === 'hud-relay' && s.payload.canvas).pop();
  assert.strictEqual(relay.payload.canvas.workspace, 'sprint-2', '工作区切换后摘要应更新');
  assert.strictEqual(Core.hud.canvasSummary.workspace, 'sprint-2');

  delete global.window;
});

test('hud↔canvas: 无画布（store 缺失）时安全降级', () => {
  const sent = [];
  global.window = { nodeBridge: { ipc: { send: (c, p) => sent.push({ c, p }), on: () => () => {} } } };
  delete require.cache[HUD_PATH];
  const hud = require('../modules/hud.js');
  const Core = createMockCore();
  Core.on = () => {}; Core.emit = () => {};
  // 不挂 Core.canvas
  assert.doesNotThrow(() => hud.init(Core));
  assert.strictEqual(Core.hud.activeNodeId, null);
  assert.strictEqual(Core.hud.openCanvas(), false, '无画布时 openCanvas 应返回 false');
  assert.doesNotThrow(() => Core.hud.relayCanvasSummary());
  delete global.window;
});
