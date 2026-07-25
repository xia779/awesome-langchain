// modules/canvas-flow.js — 画布 ↔ 工作流引擎 编排桥（Wave 6c）
//
// 让画布可「编排」：从内置模板/已有工作流创建工作流节点，在画布上运行，
// 并把 workflow:start/step/done 事件投影成逐步点亮的步骤节点（sequence 链）。
// 既支持画布内发起的运行（runWorkflowNode），也支持外部 /workflow 命令发起的运行
// （workflow:start 时按需补建工作流节点）——画布是工作流的可视化作战室。

var Core = null;
var runs = {};           // workflowId -> { wfNodeId, stepNodes:{index:nodeId}, prevNodeId }

var STEP_W = 175, STEP_H = 70, STEP_GAP_X = 90, STEP_GAP_Y = 16;

function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

function getEngine() {
  return (Core && Core.workflow && Core.workflow.engine) || null;
}

// 取/建某次运行的上下文（含工作流节点）
function ensureRun(workflowId, name) {
  if (runs[workflowId]) return runs[workflowId];
  var store = getStore();
  if (!store) return null;
  // 复用画布上已有的同 workflowId 工作流节点
  var wfNode = null;
  store.listNodes().some(function (n) {
    if (n.type === 'workflow' && n.data && n.data.workflowId === workflowId) { wfNode = n; return true; }
    return false;
  });
  if (!wfNode) {
    wfNode = store.addNode({
      type: 'workflow', title: name || '工作流',
      x: 360, y: 380, w: 200, h: 96, status: 'running',
      data: { workflowId: workflowId, workflowName: name || '' }
    });
  }
  runs[workflowId] = { wfNodeId: wfNode.id, stepNodes: {}, prevNodeId: wfNode.id };
  return runs[workflowId];
}

// ═══════════════════════════════════════════
// 创建工作流节点
// ═══════════════════════════════════════════

function createWorkflowNode(opts) {
  opts = opts || {};
  var store = getStore(); var engine = getEngine();
  if (!store || !engine) return null;

  var wf = null;
  if (opts.templateIndex != null) {
    wf = engine.installBuiltin(opts.templateIndex);   // 从内置模板安装
  } else if (opts.workflowId) {
    var found = (engine.list() || []).filter(function (w) { return w.id === opts.workflowId; })[0];
    wf = found ? { id: found.id, name: found.name } : { id: opts.workflowId, name: opts.workflowName || '工作流' };
  }
  if (!wf || !wf.id) return null;

  var count = store.listNodes().filter(function (n) { return n.type === 'workflow'; }).length;
  var node = store.addNode({
    type: 'workflow',
    title: wf.name || '工作流',
    x: typeof opts.x === 'number' ? opts.x : (360 + count * 30),
    y: typeof opts.y === 'number' ? opts.y : (380 + count * 30),
    w: 200, h: 96, status: 'idle',
    data: { workflowId: wf.id, workflowName: wf.name || '' }
  });
  return node;
}

// ═══════════════════════════════════════════
// 运行画布上的工作流节点
// ═══════════════════════════════════════════

function runWorkflowNode(nodeId, inputText) {
  var store = getStore(); var engine = getEngine();
  if (!store || !engine) return false;
  var node = store.getNode(nodeId);
  if (!node || node.type !== 'workflow') return false;
  var workflowId = node.data && node.data.workflowId;
  if (!workflowId) return false;

  store.updateNode(nodeId, { status: 'running' });
  runs[workflowId] = { wfNodeId: nodeId, stepNodes: {}, prevNodeId: nodeId };

  try {
    var p = engine.run(workflowId, inputText || '');
    if (p && typeof p.catch === 'function') {
      p.catch(function (e) {
        store.updateNode(nodeId, { status: 'error' });
        delete runs[workflowId];
      });
    }
  } catch (e) {
    store.updateNode(nodeId, { status: 'error' });
    delete runs[workflowId];
  }
  return true;
}

// ═══════════════════════════════════════════
// 事件投影：步骤节点逐个点亮
// ═══════════════════════════════════════════

function onWorkflowStart(d) {
  if (!d) return;
  ensureRun(d.workflowId, d.name);
}

function onWorkflowStep(d) {
  if (!d) return;
  var store = getStore(); if (!store) return;
  var run = ensureRun(d.workflowId, d.name);
  if (!run) return;
  var key = d.index;

  if (d.status === 'running') {
    if (!run.stepNodes[key]) {
      var wfNode = store.getNode(run.wfNodeId);
      var baseX = wfNode ? wfNode.x + wfNode.w + STEP_GAP_X : 600;
      var baseY = wfNode ? wfNode.y : 380;
      var order = Object.keys(run.stepNodes).length;
      var sn = store.addNode({
        type: 'tool',
        title: (d.stepName || d.type || '步骤') + ' (' + (key + 1) + '/' + d.total + ')',
        x: baseX, y: baseY + order * (STEP_H + STEP_GAP_Y),
        w: STEP_W, h: STEP_H, status: 'running',
        data: { workflowId: d.workflowId, stepIndex: key, stepType: d.type }
      });
      store.addEdge({ from: run.prevNodeId, to: sn.id, kind: 'sequence' });
      run.stepNodes[key] = sn.id;
      run.prevNodeId = sn.id;
    } else {
      store.updateNode(run.stepNodes[key], { status: 'running' });
    }
  } else {
    // done / error
    if (run.stepNodes[key]) {
      store.updateNode(run.stepNodes[key], { status: d.status === 'done' ? 'done' : 'error' });
    }
  }
}

function onWorkflowDone(d) {
  if (!d) return;
  var store = getStore();
  var run = runs[d.workflowId];
  if (store && run) {
    store.updateNode(run.wfNodeId, { status: d.success ? 'done' : 'error' });
  }
  delete runs[d.workflowId];
}

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

function init(_Core) {
  Core = _Core;

  if (Core && typeof Core.on === 'function') {
    Core.on('workflow:start', onWorkflowStart);
    Core.on('workflow:step', onWorkflowStep);
    Core.on('workflow:done', onWorkflowDone);
  }

  Core.canvas = Core.canvas || {};
  Core.canvas.createWorkflowNode = createWorkflowNode;
  Core.canvas.runWorkflowNode = runWorkflowNode;

  Core.canvasFlow = {
    reset: function () { runs = {}; },
    get runs() { return runs; }
  };
}

module.exports = {
  name: 'canvas-flow',
  dependencies: ['canvas-store', 'workflow'],
  init: init,
  _internals: { STEP_W: STEP_W, STEP_H: STEP_H }
};
