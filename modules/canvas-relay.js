// modules/canvas-relay.js — 画布独立窗口中继（运行于主窗口渲染进程）
//
// 架构说明（对齐 hud.js 的 HUD 中继范式）：
//   - 画布独立窗口（BrowserWindow）由 main.js（主进程）创建与持有，加载 public/canvas/index.html。
//   - 画布的数据事实来源仍是主窗口的 canvas-store；独立窗口持有一份「远程 store」镜像。
//   - 本模块职责有二：
//       1) 订阅 canvas-store 的 canvas:* 事件 → 防抖序列化全量状态 → 经 IPC 推送到独立窗口；
//       2) 接收独立窗口发来的写操作（canvas-window-command {action:'op'}）→ 应用到本地 store。
//
// 数据流：
//   store 变更(Core.emit canvas:*) → 本模块(Core.on) → ipc.send('canvas-relay')
//     → main.js → canvasWindow.send('canvas-state') → 独立窗口远程 store → 重渲染
//   独立窗口 ipc.send('canvas-op') → main.js → mainWindow.send('canvas-window-command')
//     → 本模块(ipc.on) → store.addNode/updateNode/... → （store 发事件 → 回声推送）
//
// 设计取舍：
//   · 节点/连线/工作区为共享状态；视口为各窗口私有（互不干扰平移缩放）。
//   · setNodePosition（拖拽）在主 store 中不发事件，故拖拽期间不会回声到独立窗口，
//     避免独立窗口整树重渲染打断拖拽；拖拽结束 save 时补发一次 node-update 刷新嵌入画布。
//
// 测试安全：window/nodeBridge 在 Node 测试环境不存在，全部 typeof 守卫。
var Core = null;

var bridge = (typeof window !== 'undefined' && window.nodeBridge && window.nodeBridge.ipcRenderer)
  ? window.nodeBridge.ipcRenderer : null;

var _pushTimer = null;

function hasDom() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

// 结构化克隆清洗：剥离函数/DOM 节点/循环引用，避免 IPC 发送时
// "An object could not be cloned"（_send 的 try-catch 会静默吞掉整个 payload，造成同步丢失）
function _safeClone(obj) {
  var seen = new WeakSet();
  try {
    return JSON.parse(JSON.stringify(obj, function (k, v) {
      if (typeof v === 'function') return undefined;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return undefined;   // 循环引用 → 断开
        seen.add(v);
      }
      return v;
    }));
  } catch (e) { return null; }
}

function _send(channel, payload) {
  if (bridge && typeof bridge.send === 'function') {
    try { bridge.send(channel, payload); } catch (e) { /* noop */ }
  }
}

// ═══════════════════════════════════════════
// 状态推送（主窗口 → 独立窗口）
// ═══════════════════════════════════════════

function buildState() {
  var store = getStore();
  if (!store || typeof store.serialize !== 'function') return null;
  var st = store.serialize();
  st.workspaces = (typeof store.listWorkspaces === 'function') ? store.listWorkspaces() : [];
  return _safeClone(st) || { nodes: {}, edges: {}, viewport: { x: 0, y: 0, zoom: 1 }, workspaces: [] };
}

function pushState() {
  var st = buildState();
  if (!st) return;
  _send('canvas-relay', { state: st });
}

// 防抖推送：agent 运行期间节点状态高频更新，避免 IPC 洪泛
function pushStateDebounced() {
  if (_pushTimer) return;
  _pushTimer = setTimeout(function () { _pushTimer = null; pushState(); }, 120);
}

// ═══════════════════════════════════════════
// 写操作应用（独立窗口 → 主窗口 store）
// ═══════════════════════════════════════════

function applyOp(op, args) {
  var store = getStore();
  if (!store || !op) return;
  args = args || [];
  try {
    switch (op) {
      case 'addNode': store.addNode(args[0]); break;
      case 'updateNode': store.updateNode(args[0], args[1]); break;
      case 'removeNode': store.removeNode(args[0]); break;
      case 'addEdge': store.addEdge(args[0]); break;
      case 'removeEdge': store.removeEdge(args[0]); break;
      case 'setNodePosition': store.setNodePosition(args[0], args[1], args[2]); break;
      case 'save':
        store.save();
        // 存盘后补发一次 node-update：让嵌入画布刷新到独立窗口拖拽的最终位置，
        // 同时触发防抖回声，使独立窗口与主 store 完全对齐（此时拖拽已结束，重渲染安全）。
        if (Core && typeof Core.emit === 'function') {
          Core.emit('canvas:node-update', { node: null });
        }
        break;
      case 'switchWorkspace': store.switchWorkspace(args[0]); break;
      case 'newWorkspace': store.newWorkspace(args[0]); break;
      default:
        console.warn('[canvas-relay] 未知操作:', op);
    }
  } catch (e) {
    console.warn('[canvas-relay] 操作失败:', op, e.message);
  }
}

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

function init(_Core) {
  Core = _Core;

  // 对外暴露独立窗口控制 API（供 canvas-view 弹出按钮 / 标题栏按钮 / 命令调用）
  Core.canvasWindow = {
    open: function () { _send('canvas-window-open', {}); },
    close: function () { _send('canvas-window-close', {}); },
    toggle: function () { _send('canvas-window-toggle', {}); }
  };

  // 订阅 store 事件 → 防抖推送全量状态到独立窗口
  // （不含 canvas:viewport——视口为各窗口私有；不含 canvas:saved——内容未变）
  if (Core && typeof Core.on === 'function') {
    ['canvas:node-add', 'canvas:node-update', 'canvas:node-remove',
     'canvas:edge-add', 'canvas:edge-remove',
     'canvas:load', 'canvas:clear', 'canvas:workspace'].forEach(function (ev) {
      Core.on(ev, pushStateDebounced);
    });
  }

  // 接收独立窗口的指令：sync=推送初始状态；op=应用写操作
  if (bridge && typeof bridge.on === 'function') {
    bridge.on('canvas-window-command', function (payload) {
      if (!payload) return;
      if (payload.action === 'sync') { pushState(); return; }
      if (payload.action === 'op') { applyOp(payload.op, payload.args); }
    });
  }

  // 标题栏「画布独立窗口」按钮
  if (hasDom()) {
    var btn = document.getElementById('canvasWindowBtn');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', function () { Core.canvasWindow.toggle(); });
    }
  }

  // 注册 /canvas-window 命令
  if (Core.custom && typeof Core.custom.registerCommand === 'function') {
    Core.custom.registerCommand('canvas-window', '打开/关闭画布独立窗口', function () {
      Core.canvasWindow.toggle();
    }, false);
  }
}

module.exports = {
  name: 'canvas-relay',
  dependencies: ['canvas-store'],
  init: init
};
