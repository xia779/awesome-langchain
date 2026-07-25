// modules/canvas-sync.js — 事件 → 画布节点的只读投影（Wave 6b）
//
// 把 Agent 生命周期事件（typingStart / agent-think / agent-tool / typingEnd / ai:error）
// 与任务广播（task:sync）实时投影成画布上的 agent / tool / task 节点与连线。
// 只读投影：本模块只「监听事件 → 写画布」，绝不反向修改 Agent / 任务状态。
//
// 铁律落地：节点实时状态（thinking/executing/running）虽写入 node.status 作为历史记录，
//   但启动时会把上次会话遗留的「运行中」假状态统一调和为 interrupted —— live 状态不从磁盘盲信。

var Core = null;

var run = null;          // 当前运行上下文 { index, agentId, ox, oy, toolByStep, toolCount }
var runCounter = 0;
var taskNodeIds = {};    // task.id -> 画布节点 id

// 工具名 → 中文标签（与 hud.js 的功能映射同源）
var TOOL_LABEL = {
  web_search: '网络搜索', search: '网络搜索', bocha_search: '网络搜索', tavily_search: '网络搜索',
  deep_research: '深度研究',
  knowledge_search: '知识检索', knowledge: '知识检索',
  stock_quote: '行情查询',
  web_crawl: '网页爬取', read_url: '网页爬取',
  schedule: '日程安排', add_schedule: '日程安排'
};

// 任务状态 → 节点状态
var TASK_STATUS_MAP = {
  pending: 'pending', in_progress: 'running', completed: 'done',
  cancelled: 'cancelled', blocked: 'error', failed: 'error'
};

// 布局常量
var AGENT_W = 190, AGENT_H = 92, TOOL_W = 175, TOOL_H = 74;
var RUN_BASE_X = 340, RUN_Y0 = 40, RUN_GAP_X = 330, RUN_GAP_Y = 270, RUN_COLS = 3;
var TASK_X = 40, TASK_Y0 = 40, TASK_GAP_Y = 104, TASK_W = 220, TASK_H = 84;
var LIVE_STATES = { thinking: 1, executing: 1, running: 1 };

function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

function toolTitle(action) {
  return TOOL_LABEL[action] || action || '工具调用';
}

// ═══════════════════════════════════════════
// 运行投影（agent + tool）
// ═══════════════════════════════════════════

function ensureRun() {
  if (run) return run;
  var store = getStore();
  if (!store) return null;
  runCounter += 1;
  var ox = RUN_BASE_X + ((runCounter - 1) % RUN_COLS) * RUN_GAP_X;
  var oy = RUN_Y0 + Math.floor((runCounter - 1) / RUN_COLS) * RUN_GAP_Y;
  var node = store.addNode({
    type: 'agent', title: 'Agent 运行 #' + runCounter,
    x: ox, y: oy, w: AGENT_W, h: AGENT_H, status: 'thinking',
    data: { run: runCounter }
  });
  run = { index: runCounter, agentId: node.id, ox: ox, oy: oy, toolByStep: {}, toolCount: 0 };
  return run;
}

function onTypingStart() {
  ensureRun();
}

function onAgentThink(d) {
  var r = ensureRun(); if (!r) return;
  var store = getStore();
  d = d || {};
  var sub = d.step ? (' · 思考 ' + d.step + (d.maxSteps ? '/' + d.maxSteps : '')) : '';
  store.updateNode(r.agentId, { status: 'thinking', title: 'Agent 运行 #' + r.index + sub });
}

function onAgentTool(d) {
  var r = ensureRun(); if (!r) return;
  var store = getStore();
  d = d || {};
  // 按 step 去重：agent-loop 对同一步会在两处各发一次 agent-tool
  var key = (d.step != null) ? ('s' + d.step) : ('x' + r.toolCount);
  if (!r.toolByStep[key]) {
    var tx = r.ox + AGENT_W + 70;
    var ty = r.oy + r.toolCount * (TOOL_H + 18);
    var tn = store.addNode({
      type: 'tool', title: toolTitle(d.action),
      x: tx, y: ty, w: TOOL_W, h: TOOL_H, status: 'running',
      data: { action: d.action || '', step: d.step != null ? d.step : null }
    });
    store.addEdge({ from: r.agentId, to: tn.id, kind: 'delegation' });
    r.toolByStep[key] = tn.id;
    r.toolCount += 1;
  } else {
    store.updateNode(r.toolByStep[key], { status: 'running' });
  }
  store.updateNode(r.agentId, { status: 'executing' });
}

function onTypingEnd() {
  var store = getStore();
  if (run && store) {
    store.updateNode(run.agentId, { status: 'done', title: 'Agent 运行 #' + run.index + ' · 完成' });
    Object.keys(run.toolByStep).forEach(function (k) {
      store.updateNode(run.toolByStep[k], { status: 'done' });
    });
  }
  run = null;
}

function onAiError(d) {
  var store = getStore();
  if (run && store) {
    var msg = d && d.message ? String(d.message).substring(0, 20) : '';
    store.updateNode(run.agentId, {
      status: 'error',
      title: 'Agent 运行 #' + run.index + ' · 出错' + (msg ? '（' + msg + '）' : '')
    });
  }
  run = null;
}

// ═══════════════════════════════════════════
// 任务投影（task:sync 全量差分）
// ═══════════════════════════════════════════

function onTaskSync(d) {
  var store = getStore(); if (!store) return;
  var list = (d && Array.isArray(d.tasks)) ? d.tasks : [];
  var seen = {};
  list.forEach(function (t, i) {
    if (t == null || t.id == null) return;
    seen[t.id] = true;
    var st = TASK_STATUS_MAP[t.status] || 'pending';
    var title = t.title || '任务';
    if (taskNodeIds[t.id]) {
      store.updateNode(taskNodeIds[t.id], { status: st, title: title });
    } else {
      var n = store.addNode({
        type: 'task', title: title,
        x: TASK_X, y: TASK_Y0 + i * TASK_GAP_Y, w: TASK_W, h: TASK_H,
        status: st, data: { taskId: t.id }
      });
      taskNodeIds[t.id] = n.id;
    }
  });
  // 移除已不存在的任务节点，保持画布与任务列表同步
  Object.keys(taskNodeIds).forEach(function (tid) {
    if (!seen[tid]) {
      store.removeNode(taskNodeIds[tid]);
      delete taskNodeIds[tid];
    }
  });
}

// ═══════════════════════════════════════════
// 启动调和：清理上次会话遗留的「运行中」假状态
// ═══════════════════════════════════════════

function reconcileStale(store) {
  store.listNodes().forEach(function (n) {
    if (LIVE_STATES[n.status]) store.updateNode(n.id, { status: 'interrupted' });
  });
}

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

function init(_Core) {
  Core = _Core;
  var store = getStore();
  if (store) reconcileStale(store);

  if (Core && typeof Core.on === 'function') {
    Core.on('typingStart', onTypingStart);
    Core.on('agent-think', onAgentThink);
    Core.on('agent-tool', onAgentTool);
    Core.on('typingEnd', onTypingEnd);
    Core.on('ai:error', onAiError);
    Core.on('task:sync', onTaskSync);
  }

  Core.canvasSync = {
    reset: function () { run = null; runCounter = 0; taskNodeIds = {}; },
    get runCounter() { return runCounter; },
    get activeRun() { return run; }
  };
}

module.exports = {
  name: 'canvas-sync',
  dependencies: ['canvas-store'],
  init: init,
  _internals: { TOOL_LABEL: TOOL_LABEL, TASK_STATUS_MAP: TASK_STATUS_MAP, LIVE_STATES: LIVE_STATES }
};
