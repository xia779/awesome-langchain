// modules/hud.js — HUD 悬浮窗控制器（运行于主窗口渲染进程）
//
// 架构说明：
//   - HUD 的 BrowserWindow（透明/无边框/置顶）由 main.js（主进程）创建与持有。
//   - 本模块运行在主窗口渲染进程，职责有三：
//       1) 把 Agent 运行状态（思考/执行/完成/出错）经 IPC 中继到 HUD 窗口；
//       2) 接收 HUD 窗口发来的输入指令，注入主应用并发送；
//       3) 对外暴露 Core.hud API（setState / setProgress / setGauge / setActiveFn / show / hide / toggle）。
//
// 数据流：
//   agent-loop(Core.emit) → 本模块(Core.on) → ipc.send('hud-relay') → main.js → hudWindow.send('hud-state') → HUD 视图
//   HUD 视图 ipc.send('hud-input') → main.js → mainWindow.send('hud-command') → 本模块(ipc.on) → 注入主应用
//
// 测试安全：渲染进程全局（window/nodeBridge）在 Node 测试环境不存在，全部以 typeof 守卫；
//           Core.on/emit/custom 均按需守卫，mock Core 无这些方法时静默跳过。
let Core = null;

var bridge = (typeof window !== 'undefined' && window.nodeBridge && window.nodeBridge.ipc)
  ? window.nodeBridge.ipc : null;

var _state = 'idle';
var _visible = false;

// ---- Wave 6d：HUD↔画布联动状态 ----
var _activeNodeId = null;                              // 最近进入运行态的节点（HUD 一键定位用）
var _canvasSummary = { workspace: 'default', running: 0, total: 0 };
var LIVE_STATES = { thinking: 1, executing: 1, running: 1 };  // 视为「活跃」的节点状态

function _send(channel, payload) {
  if (bridge && typeof bridge.send === 'function') {
    try { bridge.send(channel, payload); } catch (e) { /* noop */ }
  }
}

// 工具名 → HUD 功能标签映射（与 public/hud/index.html 的 data-fn 对应）
var TOOL_FN_MAP = {
  web_search: 'search', search: 'search', bocha_search: 'search', tavily_search: 'search',
  deep_research: 'research',
  knowledge_search: 'knowledge', knowledge: 'knowledge',
  stock_quote: 'stock',
  web_crawl: 'crawl', read_url: 'crawl',
  schedule: 'schedule', add_schedule: 'schedule'
};

function setState(state, opts) {
  if (typeof state === 'string') _state = state;
  _send('hud-relay', Object.assign({ state: _state }, opts || {}));
}

function setProgress(pct) {
  _send('hud-relay', { state: _state, progress: pct });
}

function setGauge(pct, title, sub) {
  _send('hud-relay', { state: _state, gauge: pct, gaugeTitle: title, gaugeSub: sub });
}

function setActiveFn(fn) {
  _send('hud-relay', { state: _state, fn: fn });
}

function show() { _visible = true; _send('hud-show'); }
function hide() { _visible = false; _send('hud-hide'); }
function toggle() { _visible = !_visible; _send('hud-toggle'); }

// 将 HUD 输入的指令注入主应用并触发发送
function injectCommand(text) {
  if (!Core || !text) return;
  try {
    // 真实发送路径：填入输入框 → 调用 Core.api.sendMessage()
    // （与主应用 Enter 键发送完全一致；sendMessage 无参，内部读取 Core.dom.input.value）
    if (Core.dom && Core.dom.input) Core.dom.input.value = text;
    if (Core.api && typeof Core.api.sendMessage === 'function') { Core.api.sendMessage(); return; }
    // 回退：派发事件让上层处理
    if (Core.emit) Core.emit('hud-command', { text: text });
  } catch (e) { /* noop */ }
}

// ═══════════════════════════════════════════
// Wave 6d：HUD ↔ 画布联动
// ═══════════════════════════════════════════

function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

// 重新统计画布摘要（工作区名 + 运行中/总节点数）
function recomputeCanvasSummary() {
  var store = getStore();
  if (store) {
    var nodes = (typeof store.listNodes === 'function') ? store.listNodes() : [];
    var running = 0;
    nodes.forEach(function (n) { if (LIVE_STATES[n.status]) running += 1; });
    _canvasSummary = {
      workspace: (typeof store.getWorkspace === 'function') ? store.getWorkspace() : 'default',
      running: running,
      total: nodes.length
    };
  }
  return _canvasSummary;
}

// 把画布摘要中继到 HUD 窗口（canvasOnly 标记，HUD 视图只更新画布 chip，不打扰角色状态）
function relayCanvasSummary() {
  recomputeCanvasSummary();
  _send('hud-relay', { canvasOnly: true, canvas: _canvasSummary });
}

// 记住最近进入运行态的节点，作为 HUD 一键定位的目标
function trackActiveNode(node) {
  if (node && node.id && LIVE_STATES[node.status]) _activeNodeId = node.id;
}

// 定位到活跃节点（需画布已挂载）
function focusActiveNode() {
  var store = getStore();
  if (!_activeNodeId || !store || typeof store.getNode !== 'function') return null;
  if (!store.getNode(_activeNodeId)) { _activeNodeId = null; return null; }
  if (Core.canvas) {
    if (typeof Core.canvas.focusNode === 'function') Core.canvas.focusNode(_activeNodeId);
    if (typeof Core.canvas.selectNode === 'function') Core.canvas.selectNode(_activeNodeId);
  }
  return _activeNodeId;
}

// 一键展开画布并定位到活跃节点
function openCanvas() {
  if (Core && typeof Core.emit === 'function') {
    try { Core.emit('hud:open-canvas', { nodeId: _activeNodeId }); } catch (e) { /* noop */ }
  }
  if (Core && Core.canvas && typeof Core.canvas.open === 'function') {
    Core.canvas.open();
    return focusActiveNode() || true;
  }
  return false;
}

function init(_Core) {
  Core = _Core;

  Core.hud = {
    setState: setState,
    setProgress: setProgress,
    setGauge: setGauge,
    setActiveFn: setActiveFn,
    show: show,
    hide: hide,
    toggle: toggle,
    injectCommand: injectCommand,
    // Wave 6d：画布联动
    openCanvas: openCanvas,
    focusActiveNode: focusActiveNode,
    relayCanvasSummary: relayCanvasSummary,
    get state() { return _state; },
    get visible() { return _visible; },
    get canvasSummary() { return recomputeCanvasSummary(); },
    get activeNodeId() { return _activeNodeId; }
  };

  // ---- 自动中继 Agent 生命周期状态 ----
  if (Core.on) {
    Core.on('typingStart', function () { setState('thinking', { text: '正在思考中…', sub: '分析你的意图与上下文' }); });
    Core.on('agent-think', function (d) {
      d = d || {};
      setState('thinking', { text: '正在思考中…', sub: d.step ? ('步骤 ' + d.step + (d.maxSteps ? '/' + d.maxSteps : '')) : '推理中' });
    });
    Core.on('agent-tool', function (d) {
      d = d || {};
      var fn = TOOL_FN_MAP[d.action] || null;
      var gauge = (d.step && d.maxSteps) ? Math.round(d.step / d.maxSteps * 100) : null;
      var payload = {
        state: 'executing',
        text: '正在执行任务…',
        sub: d.action ? ('调用 ' + d.action) : '调用工具链处理中',
        banner: d.action ? ('正在执行：' + d.action) : undefined,
        fn: fn,
        progress: gauge != null ? gauge : undefined,
        gauge: gauge != null ? gauge : undefined,
        gaugeTitle: '工作流',
        gaugeSub: d.action ? ('步骤 ' + d.step + '/' + d.maxSteps) : '执行中'
      };
      _send('hud-relay', payload);
      _state = 'executing';
    });
    Core.on('typingEnd', function () {
      setState('idle', { text: '主人，任务完成啦', sub: '随时为你效劳', gauge: 0, gaugeTitle: '工作流', gaugeSub: '等待指令', fn: '' });
    });
    Core.on('ai:error', function (d) {
      d = d || {};
      setState('idle', { text: '执行出错了', sub: d.message ? String(d.message).substring(0, 30) : '请检查模型或网络', gauge: 0, fn: '' });
    });

    // ---- Wave 6d：订阅画布事件 → 跟踪活跃节点 + 同步 HUD 画布 chip ----
    Core.on('canvas:node-add', function (d) {
      if (d && d.node) trackActiveNode(d.node);
      relayCanvasSummary();
    });
    Core.on('canvas:node-update', function (d) {
      if (d && d.node) trackActiveNode(d.node);
      relayCanvasSummary();
    });
    Core.on('canvas:node-remove', function (d) {
      if (d && d.id && d.id === _activeNodeId) _activeNodeId = null;
      relayCanvasSummary();
    });
    Core.on('canvas:workspace', function () { relayCanvasSummary(); });
    Core.on('canvas:load', function () { relayCanvasSummary(); });
    Core.on('canvas:clear', function () { _activeNodeId = null; relayCanvasSummary(); });
  }

  // ---- 接收 HUD 窗口发来的指令（经主进程转发）----
  if (bridge && typeof bridge.on === 'function') {
    bridge.on('hud-command', function (payload) {
      payload = payload || {};
      // Wave 6d：HUD「展开成画布」按钮
      if (payload.action === 'open-canvas') { openCanvas(); return; }
      if (payload.text) injectCommand(payload.text);
    });
  }

  // ---- 注册 /hud 命令 ----
  if (Core.custom && typeof Core.custom.registerCommand === 'function') {
    Core.custom.registerCommand('hud', '显示/隐藏桌面 HUD 悬浮窗', function () { toggle(); }, false);
  }

  // ---- Wave 6d：画布已挂载时，初始化即同步一次画布摘要 ----
  if (getStore()) relayCanvasSummary();
}

module.exports = {
  name: 'hud',
  dependencies: [],
  init: init,
  // 导出内部函数便于单元测试
  _internals: { TOOL_FN_MAP: TOOL_FN_MAP, LIVE_STATES: LIVE_STATES }
};
