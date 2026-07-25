// modules/canvas-view.js — 画布视图（Wave 6a 壳 / 6b 状态着色 / 6c 可交互 / 6d 联动+工作区+裁剪）
//
// 桌面原生「工作层」：全屏无限画布，平移缩放 + 网格 + 工具栏 + 小地图 + 状态栏。
// 节点/连线数据来自 Core.canvas.store（canvas-store.js）；本模块负责「看得见 + 可交互」。
// 实时 agent 投影由 canvas-sync 接入；工作流编排投影由 canvas-flow 接入。
//
// Wave 6c 交互：选中/删除、新建菜单（便签/任务/工作流）、手柄连线、检视面板（含运行工作流）。
// Wave 6d 新增：
//   - 多工作区 UI：工具栏工作区菜单，可切换 / 新建工作区（canvas-store 已提供后端）。
//   - 视口裁剪：只渲染落在可视范围内的节点（含缓冲），大画布平移缩放更省。
//
// 渲染选型：方案 A —— 手写 DOM 节点 + SVG 连线 + CSS transform 平移缩放，零依赖零构建。
// 所有 DOM 操作守卫 hasDom()，Node 测试环境下安全 no-op。

var Core = null;
var built = false;
var els = {};
var dragState = null;
var selectedId = null;
var _suppressRender = false; // 检视面板改标题时避免整树重渲染丢焦点

// ---- Wave 6d：视口裁剪 ----
var CULL_MARGIN = 240;        // 世界坐标缓冲，避免平移边缘节点闪烁
var renderedIds = null;       // 上次实际渲染的节点 id 集合（数组）

var TYPE_LABEL = {
  agent: 'Agent', task: '任务', tool: '工具', data: '数据',
  result: '产物', workflow: '工作流', chat: '对话', note: '便签'
};
var TYPE_COLOR = {
  agent: '#7c5cff', task: '#2f81f7', tool: '#d29922', data: '#3fb950',
  result: '#db61a2', workflow: '#8957e5', chat: '#58a6ff', note: '#8b949e'
};
var STATUS_LABEL = {
  idle: '空闲', pending: '待处理', thinking: '思考中', executing: '执行中',
  running: '运行中', done: '完成', error: '出错', interrupted: '已中断', cancelled: '已取消'
};

// ═══════════════════════════════════════════
// 环境守卫与工具
// ═══════════════════════════════════════════

function hasDom() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clampZoom(z) {
  var store = getStore();
  var min = store ? store.ZOOM_MIN : 0.2;
  var max = store ? store.ZOOM_MAX : 3;
  z = Number(z) || 1;
  return Math.max(min, Math.min(max, z));
}

// 屏幕坐标 → 世界坐标
function screenToWorld(clientX, clientY) {
  var store = getStore(); if (!store || !built) return { x: 0, y: 0 };
  var rect = els.stage.getBoundingClientRect();
  var vp = store.getViewport();
  return { x: (clientX - rect.left - vp.x) / vp.zoom, y: (clientY - rect.top - vp.y) / vp.zoom };
}

// 当前视口中心的世界坐标（新建节点落点）
function centerWorldPos() {
  var store = getStore(); if (!store || !built) return { x: 80, y: 80 };
  var vp = store.getViewport();
  var cw = (els.stage.clientWidth || 0) / 2, ch = (els.stage.clientHeight || 0) / 2;
  return { x: (cw - vp.x) / vp.zoom, y: (ch - vp.y) / vp.zoom };
}

// ═══════════════════════════════════════════
// Wave 6d：视口裁剪（纯函数，可单测）
// ═══════════════════════════════════════════

// 由视口 + 舞台尺寸推算可视世界矩形
function worldRectFromViewport(vp, sw, sh) {
  vp = vp || { x: 0, y: 0, zoom: 1 };
  var zoom = vp.zoom || 1;
  var x0 = -(vp.x || 0) / zoom, y0 = -(vp.y || 0) / zoom;
  return { x0: x0, y0: y0, x1: x0 + (sw || 0) / zoom, y1: y0 + (sh || 0) / zoom };
}

// 节点是否与可视矩形相交（含缓冲 margin）
function nodeVisible(n, rect, margin) {
  if (!n || !rect) return false;
  margin = margin || 0;
  return (n.x + n.w >= rect.x0 - margin) && (n.x <= rect.x1 + margin) &&
         (n.y + n.h >= rect.y0 - margin) && (n.y <= rect.y1 + margin);
}

// 当前应渲染的节点 id 列表（视口尺寸未知时不裁剪，全量返回）
function currentVisibleIds() {
  var store = getStore(); if (!store) return [];
  var nodes = store.listNodes();
  var sw = (els.stage && els.stage.clientWidth) || 0;
  var sh = (els.stage && els.stage.clientHeight) || 0;
  if (!sw || !sh) return nodes.map(function (n) { return n.id; });
  var rect = worldRectFromViewport(store.getViewport(), sw, sh);
  return nodes.filter(function (n) { return nodeVisible(n, rect, CULL_MARGIN); })
              .map(function (n) { return n.id; });
}

function sameIds(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var set = {}; b.forEach(function (id) { set[id] = 1; });
  for (var i = 0; i < a.length; i++) { if (!set[a[i]]) return false; }
  return true;
}

// ═══════════════════════════════════════════
// 样式注入（自包含，作用域 #canvasRoot）
// ═══════════════════════════════════════════

var CSS = [
  '#canvasRoot{position:fixed;inset:0;z-index:9000;display:none;background:#0b0e14;color:#e6edf3;',
  'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;}',
  'body.canvas-open #canvasRoot{display:block;}',
  '.cv-toolbar{position:absolute;top:0;left:0;right:0;height:48px;display:flex;align-items:center;gap:6px;',
  'padding:0 12px;background:rgba(13,17,23,.92);border-bottom:1px solid rgba(255,255,255,.08);z-index:4;}',
  '.cv-btn{height:30px;padding:0 12px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(255,255,255,.04);',
  'color:#e6edf3;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s;}',
  '.cv-btn:hover{background:rgba(124,92,255,.18);border-color:rgba(124,92,255,.5);}',
  '.cv-btn--primary{background:rgba(124,92,255,.22);border-color:rgba(124,92,255,.55);}',
  '.cv-sep{width:1px;height:20px;background:rgba(255,255,255,.1);margin:0 4px;}',
  // 新建菜单
  '.cv-addwrap,.cv-wswrap{position:relative;}',
  '.cv-addmenu,.cv-wsmenu{position:absolute;top:36px;left:0;min-width:170px;background:#161b22;border:1px solid rgba(255,255,255,.14);',
  'border-radius:8px;padding:4px;display:none;z-index:20;box-shadow:0 8px 24px rgba(0,0,0,.5);}',
  '.cv-addmenu.open,.cv-wsmenu.open{display:block;}',
  '.cv-addmenu-item,.cv-ws-item{padding:7px 10px;font-size:12px;border-radius:6px;cursor:pointer;color:#e6edf3;}',
  '.cv-addmenu-item:hover,.cv-ws-item:hover{background:rgba(124,92,255,.18);}',
  '.cv-ws-item.cur{color:#7c5cff;font-weight:600;}',
  '.cv-ws-item.cur::before{content:"✓ ";}',
  '.cv-ws-new{display:flex;gap:6px;padding:6px 8px;border-top:1px solid rgba(255,255,255,.1);margin-top:4px;}',
  '.cv-ws-input{flex:1;background:#0b0e14;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#e6edf3;',
  'padding:5px 8px;font-size:12px;font-family:inherit;}',
  '.cv-ws-add{border:1px solid rgba(124,92,255,.5);background:rgba(124,92,255,.2);color:#e6edf3;border-radius:6px;',
  'padding:0 10px;font-size:12px;cursor:pointer;}',
  '.cv-wf-picker{display:none;margin-top:4px;border-top:1px solid rgba(255,255,255,.1);padding-top:4px;max-height:220px;overflow:auto;}',
  '.cv-wf-picker.open{display:block;}',
  '.cv-wf-empty{padding:6px 10px;font-size:11px;color:#6e7681;}',
  // 工作区按钮（工具栏右侧）
  '.cv-ws{margin-left:auto;}',
  '.cv-wsbtn{height:30px;padding:0 12px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(255,255,255,.04);',
  'color:#8b949e;font-size:12px;cursor:pointer;}',
  '.cv-wsbtn b{color:#e6edf3;font-weight:600;}',
  '.cv-wsbtn:hover{border-color:rgba(124,92,255,.5);}',
  '.cv-stage{position:absolute;top:48px;left:0;right:0;bottom:24px;overflow:hidden;cursor:grab;',
  'background-color:#0b0e14;',
  'background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);',
  'background-size:40px 40px;}',
  '.cv-stage.cv-panning{cursor:grabbing;}',
  '.cv-world{position:absolute;top:0;left:0;width:0;height:0;transform-origin:0 0;}',
  '.cv-nodes{position:absolute;top:0;left:0;}',
  '.cv-edges{position:absolute;top:0;left:0;width:1px;height:1px;overflow:visible;pointer-events:none;}',
  '.cv-node{position:absolute;box-sizing:border-box;border-radius:10px;background:rgba(22,27,34,.96);',
  'border:1px solid rgba(255,255,255,.12);padding:9px 11px;cursor:grab;overflow:visible;',
  'box-shadow:0 4px 14px rgba(0,0,0,.35);transition:border-color .15s,box-shadow .15s;}',
  '.cv-node:hover{border-color:rgba(255,255,255,.28);}',
  '.cv-node--selected{border-color:rgba(124,92,255,.9);box-shadow:0 0 0 2px rgba(124,92,255,.35),0 4px 14px rgba(0,0,0,.35);}',
  '.cv-node-type{font-size:10px;letter-spacing:.5px;opacity:.7;text-transform:uppercase;margin-bottom:4px;}',
  '.cv-node-title{font-size:13px;font-weight:600;line-height:1.35;word-break:break-word;}',
  // 连线手柄（右侧中点）
  '.cv-handle{position:absolute;top:50%;right:-7px;width:12px;height:12px;margin-top:-6px;border-radius:50%;',
  'background:#7c5cff;border:2px solid #0b0e14;cursor:crosshair;opacity:0;transition:opacity .12s;z-index:5;}',
  '.cv-node:hover .cv-handle,.cv-node--selected .cv-handle{opacity:1;}',
  '.cv-connect-line{stroke:#7c5cff;stroke-width:2;stroke-dasharray:6 4;}',
  '.cv-minimap{position:absolute;right:12px;bottom:36px;width:180px;height:120px;background:rgba(13,17,23,.92);',
  'border:1px solid rgba(255,255,255,.1);border-radius:8px;z-index:4;overflow:hidden;}',
  'body.canvas-inspector-open .cv-minimap{right:284px;}',
  '.cv-statusbar{position:absolute;left:0;right:0;bottom:0;height:24px;display:flex;align-items:center;gap:16px;',
  'padding:0 12px;font-size:11px;color:#8b949e;background:rgba(13,17,23,.92);border-top:1px solid rgba(255,255,255,.08);z-index:4;}',
  '.cv-empty{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#6e7681;text-align:center;',
  'pointer-events:none;font-size:13px;line-height:1.8;}',
  '.cv-dot{position:absolute;top:8px;right:8px;width:8px;height:8px;border-radius:50%;background:#8b949e;}',
  '.cv-st--thinking .cv-dot{background:#7c5cff;animation:cv-pulse 1.2s infinite;}',
  '.cv-st--executing .cv-dot,.cv-st--running .cv-dot{background:#d29922;animation:cv-pulse 1s infinite;}',
  '.cv-st--done .cv-dot{background:#3fb950;}',
  '.cv-st--error .cv-dot{background:#ef4444;}',
  '.cv-st--interrupted .cv-dot,.cv-st--cancelled .cv-dot,.cv-st--pending .cv-dot{background:#6e7681;}',
  '.cv-st--thinking{border-color:rgba(124,92,255,.55);}',
  '.cv-st--executing,.cv-st--running{border-color:rgba(210,153,34,.55);}',
  '.cv-st--error{border-color:rgba(239,68,68,.55);}',
  '.cv-st--done{border-color:rgba(63,185,80,.4);}',
  '@keyframes cv-pulse{0%,100%{opacity:1;}50%{opacity:.25;}}',
  // 检视面板
  '.cv-inspector{position:absolute;top:48px;right:0;bottom:24px;width:272px;background:rgba(13,17,23,.96);',
  'border-left:1px solid rgba(255,255,255,.1);z-index:5;display:none;flex-direction:column;padding:14px;box-sizing:border-box;overflow:auto;}',
  '.cv-inspector.open{display:flex;}',
  '.cv-insp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}',
  '.cv-insp-head b{font-size:13px;}',
  '.cv-insp-close{cursor:pointer;color:#8b949e;font-size:16px;line-height:1;border:none;background:none;}',
  '.cv-insp-close:hover{color:#e6edf3;}',
  '.cv-insp-label{font-size:11px;color:#8b949e;margin:10px 0 4px;}',
  '.cv-insp-input,.cv-insp-run{width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid rgba(255,255,255,.14);',
  'border-radius:6px;color:#e6edf3;padding:7px 9px;font-size:12px;font-family:inherit;}',
  '.cv-insp-run{resize:vertical;min-height:60px;}',
  '.cv-insp-meta{font-size:11px;color:#8b949e;line-height:1.9;}',
  '.cv-insp-meta span{color:#e6edf3;}',
  '.cv-insp-btn{margin-top:12px;width:100%;height:32px;border-radius:7px;border:1px solid rgba(255,255,255,.14);',
  'background:rgba(255,255,255,.04);color:#e6edf3;font-size:12px;cursor:pointer;}',
  '.cv-insp-btn--run{background:rgba(63,185,80,.2);border-color:rgba(63,185,80,.5);}',
  '.cv-insp-btn--run:hover{background:rgba(63,185,80,.32);}',
  '.cv-insp-btn--del{color:#ef4444;border-color:rgba(239,68,68,.4);}',
  '.cv-insp-btn--del:hover{background:rgba(239,68,68,.15);}'
].join('');

function injectStyle() {
  if (document.getElementById('canvas-view-style')) return;
  var st = document.createElement('style');
  st.id = 'canvas-view-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}

// 每个节点类型一条左边框色条
function injectNodeTypeStyles() {
  Object.keys(TYPE_COLOR).forEach(function (t) {
    var id = 'cv-node-color-' + t;
    if (document.getElementById(id)) return;
    var st = document.createElement('style');
    st.id = id;
    st.textContent = '.cv-node--' + t + '{border-left:3px solid ' + TYPE_COLOR[t] + ';}' +
      '.cv-node--' + t + ' .cv-node-type{color:' + TYPE_COLOR[t] + ';}';
    document.head.appendChild(st);
  });
}

// ═══════════════════════════════════════════
// DOM 构建
// ═══════════════════════════════════════════

function build() {
  if (built || !hasDom()) return;
  injectStyle();
  injectNodeTypeStyles();

  var root = document.createElement('div');
  root.id = 'canvasRoot';
  root.innerHTML =
    '<div class="cv-toolbar">' +
      '<button class="cv-btn" data-act="back">← 返回聊天</button>' +
      '<span class="cv-sep"></span>' +
      '<div class="cv-addwrap">' +
        '<button class="cv-btn cv-btn--primary" data-act="addmenu">＋ 新建</button>' +
        '<div class="cv-addmenu">' +
          '<div class="cv-addmenu-item" data-add="note">📝 便签</div>' +
          '<div class="cv-addmenu-item" data-add="task">✅ 任务</div>' +
          '<div class="cv-addmenu-item" data-add="workflow">🔀 工作流 ▸</div>' +
          '<div class="cv-wf-picker"></div>' +
        '</div>' +
      '</div>' +
      '<button class="cv-btn" data-act="fit">适应</button>' +
      '<button class="cv-btn" data-act="reset">重置视图</button>' +
      '<button class="cv-btn" data-act="zoomOut">－</button>' +
      '<button class="cv-btn" data-act="zoomIn">＋</button>' +
      '<button class="cv-btn" data-act="save">保存</button>' +
      '<div class="cv-ws cv-wswrap">' +
        '<button class="cv-wsbtn" data-act="wsmenu">工作区：<b class="cv-ws-name">default</b> ▾</button>' +
        '<div class="cv-wsmenu"></div>' +
      '</div>' +
    '</div>' +
    '<div class="cv-stage">' +
      '<div class="cv-world">' +
        '<svg class="cv-edges" xmlns="http://www.w3.org/2000/svg"></svg>' +
        '<div class="cv-nodes"></div>' +
      '</div>' +
      '<div class="cv-empty">画布是空的<br>点左上角「新建」放一个节点，或等待 Agent / 工作流自动投影</div>' +
    '</div>' +
    '<div class="cv-inspector"></div>' +
    '<div class="cv-minimap"><canvas width="180" height="120"></canvas></div>' +
    '<div class="cv-statusbar">' +
      '<span class="cv-st-zoom">100%</span>' +
      '<span class="cv-st-nodes">0 节点</span>' +
      '<span class="cv-st-ws">default</span>' +
    '</div>';

  document.body.appendChild(root);

  els.root = root;
  els.toolbar = root.querySelector('.cv-toolbar');
  els.stage = root.querySelector('.cv-stage');
  els.world = root.querySelector('.cv-world');
  els.nodesLayer = root.querySelector('.cv-nodes');
  els.edgesLayer = root.querySelector('.cv-edges');
  els.minimap = root.querySelector('.cv-minimap canvas');
  els.emptyHint = root.querySelector('.cv-empty');
  els.wsName = root.querySelector('.cv-ws-name');
  els.stZoom = root.querySelector('.cv-st-zoom');
  els.stNodes = root.querySelector('.cv-st-nodes');
  els.stWs = root.querySelector('.cv-st-ws');
  els.addMenu = root.querySelector('.cv-addmenu');
  els.wfPicker = root.querySelector('.cv-wf-picker');
  els.inspector = root.querySelector('.cv-inspector');
  els.wsMenu = root.querySelector('.cv-wsmenu');

  // 临时连线（拖拽手柄时显示），挂在 edges svg 内
  var SVGNS = 'http://www.w3.org/2000/svg';
  els.connectLine = document.createElementNS(SVGNS, 'line');
  els.connectLine.setAttribute('class', 'cv-connect-line');
  els.connectLine.style.display = 'none';
  els.edgesLayer.appendChild(els.connectLine);

  wireEvents();
  built = true;
}

function wireEvents() {
  // 工具栏（事件委托）
  els.toolbar.addEventListener('click', function (e) {
    var btn = e.target.closest ? (e.target.closest('.cv-btn') || e.target.closest('.cv-wsbtn')) : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'back') close();
    else if (act === 'addmenu') toggleAddMenu();
    else if (act === 'wsmenu') toggleWsMenu();
    else if (act === 'fit') fit();
    else if (act === 'reset') resetView();
    else if (act === 'zoomIn') zoomBy(1.2);
    else if (act === 'zoomOut') zoomBy(1 / 1.2);
    else if (act === 'save') { var s = getStore(); if (s) s.save(); }
  });

  // 新建菜单项
  els.addMenu.addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('.cv-addmenu-item') : null;
    if (item) {
      var kind = item.getAttribute('data-add');
      if (kind === 'note') { addNode('note', { title: '新便签' }); closeAddMenu(); }
      else if (kind === 'task') { addNode('task', { title: '新任务' }); closeAddMenu(); }
      else if (kind === 'workflow') { toggleWfPicker(); }
      return;
    }
    var tpl = e.target.closest ? e.target.closest('[data-wf-tpl]') : null;
    if (tpl) {
      var c = centerWorldPos();
      var node = Core.canvas.createWorkflowNode
        ? Core.canvas.createWorkflowNode({ templateIndex: parseInt(tpl.getAttribute('data-wf-tpl'), 10), x: c.x - 100, y: c.y - 48 })
        : null;
      if (node) selectNode(node.id);
      closeAddMenu();
      return;
    }
    var wf = e.target.closest ? e.target.closest('[data-wf-id]') : null;
    if (wf) {
      var c2 = centerWorldPos();
      var node2 = Core.canvas.createWorkflowNode
        ? Core.canvas.createWorkflowNode({ workflowId: wf.getAttribute('data-wf-id'), x: c2.x - 100, y: c2.y - 48 })
        : null;
      if (node2) selectNode(node2.id);
      closeAddMenu();
    }
  });

  // 工作区菜单项（切换 / 新建）
  els.wsMenu.addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('.cv-ws-item') : null;
    if (item) {
      var name = item.getAttribute('data-ws');
      var store = getStore();
      if (store && name) { store.switchWorkspace(name); closeWsMenu(); }
      return;
    }
    if (e.target.closest && e.target.closest('.cv-ws-add')) {
      var input = els.wsMenu.querySelector('.cv-ws-input');
      var v = input ? input.value.trim() : '';
      if (v) { createWorkspace(v); }
    }
  });
  // 新建工作区输入框回车确认
  els.wsMenu.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('cv-ws-input')) {
      e.preventDefault();
      var v = e.target.value.trim();
      if (v) createWorkspace(v);
    }
  });

  // 平移 / 节点拖拽 / 连线（统一在 stage 上判定）
  els.stage.addEventListener('mousedown', onStageMouseDown);

  // 滚轮缩放（非 passive 以阻止页面滚动）
  els.stage.addEventListener('wheel', onWheel, { passive: false });

  // 全局拖拽监听
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);

  // 键盘：Delete 删除选中 / Esc 取消
  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    var tag = e.target && e.target.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
      if (selectedId) { e.preventDefault(); deleteSelected(); }
    } else if (e.key === 'Escape') {
      deselect(); closeAddMenu(); closeWsMenu();
    }
  });

  // 点击菜单外关闭新建/工作区菜单
  document.addEventListener('mousedown', function (e) {
    if (!built) return;
    if (!(e.target.closest && e.target.closest('.cv-addwrap'))) closeAddMenu();
    if (!(e.target.closest && e.target.closest('.cv-wswrap'))) closeWsMenu();
  });

  // 窗口尺寸变化
  window.addEventListener('resize', function () {
    applyTransform(); renderMinimap();
    if (built) { var ids = currentVisibleIds(); if (!sameIds(ids, renderedIds)) { renderNodes(ids); renderEdges(ids); } }
  });
}

// ═══════════════════════════════════════════
// 新建菜单
// ═══════════════════════════════════════════

function toggleAddMenu() {
  if (!built) return;
  if (els.addMenu.classList.contains('open')) closeAddMenu();
  else { buildWfPicker(); els.addMenu.classList.add('open'); }
}
function closeAddMenu() {
  if (built && els.addMenu) els.addMenu.classList.remove('open');
  closeWfPicker();
}
function toggleWfPicker() {
  if (!built) return;
  buildWfPicker();
  els.wfPicker.classList.toggle('open');
}
function closeWfPicker() {
  if (built && els.wfPicker) els.wfPicker.classList.remove('open');
}

function buildWfPicker() {
  if (!built || !els.wfPicker) return;
  var html = '';
  var engine = Core && Core.workflow && Core.workflow.engine;
  if (engine) {
    var tpls = engine.builtinTemplates || [];
    tpls.forEach(function (t, i) {
      html += '<div class="cv-addmenu-item" data-wf-tpl="' + i + '">📦 ' + esc(t.name || ('模板 ' + (i + 1))) + '</div>';
    });
    var list = (typeof engine.list === 'function') ? engine.list() : [];
    list.forEach(function (w) {
      html += '<div class="cv-addmenu-item" data-wf-id="' + esc(w.id) + '">🔀 ' + esc(w.name || w.id) + '</div>';
    });
  }
  if (!html) html = '<div class="cv-wf-empty">暂无可用工作流</div>';
  els.wfPicker.innerHTML = html;
}

// ═══════════════════════════════════════════
// Wave 6d：工作区菜单
// ═══════════════════════════════════════════

function toggleWsMenu() {
  if (!built) return;
  if (els.wsMenu.classList.contains('open')) closeWsMenu();
  else { buildWsMenu(); els.wsMenu.classList.add('open'); }
}
function closeWsMenu() {
  if (built && els.wsMenu) els.wsMenu.classList.remove('open');
}

function buildWsMenu() {
  if (!built || !els.wsMenu) return;
  var store = getStore();
  var cur = store ? store.getWorkspace() : 'default';
  var names = (store && typeof store.listWorkspaces === 'function') ? store.listWorkspaces() : [];
  // 确保当前工作区在列表里
  if (names.indexOf(cur) < 0) names.unshift(cur);
  var html = '';
  names.forEach(function (n) {
    html += '<div class="cv-ws-item' + (n === cur ? ' cur' : '') + '" data-ws="' + esc(n) + '">' + esc(n) + '</div>';
  });
  html += '<div class="cv-ws-new">' +
            '<input class="cv-ws-input" placeholder="新工作区名…" />' +
            '<button class="cv-ws-add">新建</button>' +
          '</div>';
  els.wsMenu.innerHTML = html;
}

function createWorkspace(name) {
  var store = getStore(); if (!store || !name) return;
  deselect();
  store.newWorkspace(name);   // 触发 canvas:workspace → render
  closeWsMenu();
}

// ═══════════════════════════════════════════
// 平移 / 缩放
// ═══════════════════════════════════════════

function applyTransform() {
  if (!built) return;
  var store = getStore(); if (!store) return;
  var vp = store.getViewport();
  els.world.style.transform = 'translate(' + vp.x + 'px,' + vp.y + 'px) scale(' + vp.zoom + ')';
  var gs = 40 * vp.zoom;
  els.stage.style.backgroundSize = gs + 'px ' + gs + 'px';
  els.stage.style.backgroundPosition = vp.x + 'px ' + vp.y + 'px';
}

function onWheel(e) {
  e.preventDefault();
  var store = getStore(); if (!store) return;
  var rect = els.stage.getBoundingClientRect();
  var mx = e.clientX - rect.left, my = e.clientY - rect.top;
  var vp = store.getViewport();
  var wx = (mx - vp.x) / vp.zoom, wy = (my - vp.y) / vp.zoom;
  var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  var nz = clampZoom(vp.zoom * factor);
  store.setViewport({ x: mx - wx * nz, y: my - wy * nz, zoom: nz });
}

function zoomBy(factor) {
  var store = getStore(); if (!store || !built) return;
  var vp = store.getViewport();
  var cw = els.stage.clientWidth / 2, ch = els.stage.clientHeight / 2;
  var wx = (cw - vp.x) / vp.zoom, wy = (ch - vp.y) / vp.zoom;
  var nz = clampZoom(vp.zoom * factor);
  store.setViewport({ x: cw - wx * nz, y: ch - wy * nz, zoom: nz });
}

function resetView() {
  var store = getStore(); if (!store) return;
  store.setViewport({ x: 0, y: 0, zoom: 1 });
}

function fit() {
  var store = getStore(); if (!store || !built) return;
  var nodes = store.listNodes();
  if (!nodes.length) { resetView(); return; }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach(function (n) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  });
  var sw = els.stage.clientWidth, sh = els.stage.clientHeight;
  var bw = maxX - minX, bh = maxY - minY;
  var z = clampZoom(Math.min(sw / (bw + 100), sh / (bh + 100)));
  store.setViewport({ zoom: z, x: (sw - bw * z) / 2 - minX * z, y: (sh - bh * z) / 2 - minY * z });
}

function focusNode(id) {
  var store = getStore(); if (!store || !built) return;
  var n = store.getNode(id); if (!n) return;
  var vp = store.getViewport();
  var sw = els.stage.clientWidth, sh = els.stage.clientHeight;
  store.setViewport({ zoom: vp.zoom, x: sw / 2 - (n.x + n.w / 2) * vp.zoom, y: sh / 2 - (n.y + n.h / 2) * vp.zoom });
}

// ═══════════════════════════════════════════
// 拖拽（平移 + 节点 + 连线）
// ═══════════════════════════════════════════

function onStageMouseDown(e) {
  var store = getStore(); if (!store) return;
  // 手柄 → 连线
  var handle = e.target.closest ? e.target.closest('.cv-handle') : null;
  if (handle) {
    var nodeEl0 = handle.closest('.cv-node');
    var fromId = nodeEl0 ? nodeEl0.getAttribute('data-id') : null;
    var n0 = fromId ? store.getNode(fromId) : null;
    if (n0) {
      e.preventDefault();
      dragState = { mode: 'connect', fromId: fromId };
      els.connectLine.style.display = '';
      els.connectLine.setAttribute('x1', n0.x + n0.w / 2);
      els.connectLine.setAttribute('y1', n0.y + n0.h / 2);
      els.connectLine.setAttribute('x2', n0.x + n0.w / 2);
      els.connectLine.setAttribute('y2', n0.y + n0.h / 2);
      return;
    }
  }
  // 节点 → 选中 + 拖拽
  var nodeEl = e.target.closest ? e.target.closest('.cv-node') : null;
  if (nodeEl) {
    var id = nodeEl.getAttribute('data-id');
    var n = store.getNode(id); if (!n) return;
    selectNode(id);
    dragState = { mode: 'node', id: id, el: nodeEl, startX: e.clientX, startY: e.clientY, nodeX: n.x, nodeY: n.y };
  } else {
    // 空白 → 取消选中 + 平移
    deselect();
    var vp = store.getViewport();
    dragState = { mode: 'pan', startX: e.clientX, startY: e.clientY, origX: vp.x, origY: vp.y };
    els.stage.classList.add('cv-panning');
  }
}

function onDocMouseMove(e) {
  if (!dragState) return;
  var store = getStore(); if (!store) return;
  if (dragState.mode === 'pan') {
    store.setViewport({ x: dragState.origX + (e.clientX - dragState.startX), y: dragState.origY + (e.clientY - dragState.startY) });
  } else if (dragState.mode === 'node') {
    var vp = store.getViewport();
    var nx = dragState.nodeX + (e.clientX - dragState.startX) / vp.zoom;
    var ny = dragState.nodeY + (e.clientY - dragState.startY) / vp.zoom;
    store.setNodePosition(dragState.id, nx, ny);
    dragState.el.style.left = nx + 'px';
    dragState.el.style.top = ny + 'px';
    renderEdges();
    renderMinimap();
  } else if (dragState.mode === 'connect') {
    var w = screenToWorld(e.clientX, e.clientY);
    els.connectLine.setAttribute('x2', w.x);
    els.connectLine.setAttribute('y2', w.y);
  }
}

function onDocMouseUp(e) {
  if (!dragState) return;
  var store = getStore();
  if (dragState.mode === 'node' && store) {
    store.save();
  } else if (dragState.mode === 'connect' && store) {
    els.connectLine.style.display = 'none';
    // 落点命中哪个节点
    var target = null;
    if (document.elementFromPoint) {
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      var hitNode = hit && hit.closest ? hit.closest('.cv-node') : null;
      if (hitNode) target = hitNode.getAttribute('data-id');
    }
    if (target && target !== dragState.fromId) {
      store.addEdge({ from: dragState.fromId, to: target, kind: 'dependency' });
    }
  }
  dragState = null;
  if (built) els.stage.classList.remove('cv-panning');
}

// ═══════════════════════════════════════════
// 选中 / 删除
// ═══════════════════════════════════════════

function selectNode(id) {
  if (!built) { selectedId = id; return; }
  if (selectedId === id) { openInspector(id); return; }
  deselect();
  selectedId = id;
  var el = els.nodesLayer.querySelector('.cv-node[data-id="' + id + '"]');
  if (el) el.classList.add('cv-node--selected');
  openInspector(id);
}

function deselect() {
  if (!built) { selectedId = null; return; }
  if (selectedId) {
    var el = els.nodesLayer.querySelector('.cv-node[data-id="' + selectedId + '"]');
    if (el) el.classList.remove('cv-node--selected');
  }
  selectedId = null;
  closeInspector();
}

function deleteSelected() {
  var store = getStore();
  if (!store || !selectedId) return;
  var id = selectedId;
  deselect();
  store.removeNode(id); // 级联删边 + 触发 render
}

// ═══════════════════════════════════════════
// 检视面板
// ═══════════════════════════════════════════

function openInspector(id) {
  if (!built || !els.inspector) return;
  var store = getStore(); if (!store) return;
  var n = store.getNode(id); if (!n) return;

  var isWf = n.type === 'workflow';
  var html =
    '<div class="cv-insp-head"><b>节点检视</b><button class="cv-insp-close" data-insp="close">✕</button></div>' +
    '<div class="cv-insp-label">标题</div>' +
    '<input class="cv-insp-input" data-insp="title" value="' + esc(n.title || '') + '" placeholder="未命名">' +
    '<div class="cv-insp-label">信息</div>' +
    '<div class="cv-insp-meta">' +
      '类型：<span>' + esc(TYPE_LABEL[n.type] || n.type) + '</span><br>' +
      '状态：<span>' + esc(STATUS_LABEL[n.status] || n.status || '空闲') + '</span>' +
      (n.data && n.data.action ? '<br>动作：<span>' + esc(n.data.action) + '</span>' : '') +
      (n.data && n.data.workflowName ? '<br>工作流：<span>' + esc(n.data.workflowName) + '</span>' : '') +
    '</div>';
  if (isWf) {
    html +=
      '<div class="cv-insp-label">运行输入</div>' +
      '<textarea class="cv-insp-run" data-insp="run" placeholder="给工作流的输入文本（可选）"></textarea>' +
      '<button class="cv-insp-btn cv-insp-btn--run" data-insp="runwf">▶ 运行工作流</button>';
  }
  html += '<button class="cv-insp-btn cv-insp-btn--del" data-insp="del">删除节点</button>';

  els.inspector.innerHTML = html;
  els.inspector.classList.add('open');
  document.body.classList.add('canvas-inspector-open');

  els.inspector.onclick = function (e) {
    var t = e.target;
    var act = t.getAttribute ? t.getAttribute('data-insp') : null;
    if (act === 'close') deselect();
    else if (act === 'del') deleteSelected();
    else if (act === 'runwf') {
      var ta = els.inspector.querySelector('[data-insp="run"]');
      var input = ta ? ta.value : '';
      if (Core.canvas.runWorkflowNode) Core.canvas.runWorkflowNode(id, input);
    }
  };

  var titleInput = els.inspector.querySelector('[data-insp="title"]');
  if (titleInput) {
    titleInput.addEventListener('input', function () {
      _suppressRender = true;
      store.updateNode(id, { title: titleInput.value });
      _suppressRender = false;
      // 直接改节点标题文本，避免整树重渲染丢焦点
      var nodeEl = els.nodesLayer.querySelector('.cv-node[data-id="' + id + '"] .cv-node-title');
      if (nodeEl) nodeEl.textContent = titleInput.value || '未命名';
    });
  }
}

function closeInspector() {
  if (!built || !els.inspector) return;
  els.inspector.classList.remove('open');
  els.inspector.innerHTML = '';
  document.body.classList.remove('canvas-inspector-open');
}

// ═══════════════════════════════════════════
// 渲染（Wave 6d：视口裁剪）
// ═══════════════════════════════════════════

function makeNodeEl(n) {
  var el = document.createElement('div');
  var cls = 'cv-node cv-node--' + (n.type || 'note') + ' cv-st--' + (n.status || 'idle');
  if (n.id === selectedId) cls += ' cv-node--selected';
  el.className = cls;
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  el.style.width = n.w + 'px';
  el.style.height = n.h + 'px';
  el.setAttribute('data-id', n.id);
  el.innerHTML =
    '<span class="cv-dot"></span>' +
    '<span class="cv-handle" title="拖出连线"></span>' +
    '<div class="cv-node-type">' + esc(TYPE_LABEL[n.type] || n.type || '节点') + '</div>' +
    '<div class="cv-node-title">' + esc(n.title || '未命名') + '</div>';
  return el;
}

// 只渲染可见节点（visibleIds 缺省时现算）
function renderNodes(visibleIds) {
  if (!built) return;
  var store = getStore(); if (!store) return;
  while (els.nodesLayer.firstChild) els.nodesLayer.removeChild(els.nodesLayer.firstChild);
  var ids = visibleIds || currentVisibleIds();
  var idSet = {}; ids.forEach(function (id) { idSet[id] = 1; });
  store.listNodes().forEach(function (n) {
    if (idSet[n.id]) els.nodesLayer.appendChild(makeNodeEl(n));
  });
  renderedIds = ids.slice();
  els.emptyHint.style.display = store.listNodes().length ? 'none' : 'block';
}

// 连线：仅绘制两端都可见的边（临时连线始终置顶保留）
function renderEdges(visibleIds) {
  if (!built) return;
  var store = getStore(); if (!store) return;
  var SVGNS = 'http://www.w3.org/2000/svg';
  while (els.edgesLayer.firstChild) els.edgesLayer.removeChild(els.edgesLayer.firstChild);
  var ids = visibleIds || renderedIds || [];
  var idSet = {}; ids.forEach(function (id) { idSet[id] = 1; });
  var cull = ids.length > 0;
  store.listEdges().forEach(function (e) {
    if (cull && (!idSet[e.from] || !idSet[e.to])) return;
    var a = store.getNode(e.from), b = store.getNode(e.to);
    if (!a || !b) return;
    var line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', a.x + a.w / 2);
    line.setAttribute('y1', a.y + a.h / 2);
    line.setAttribute('x2', b.x + b.w / 2);
    line.setAttribute('y2', b.y + b.h / 2);
    line.setAttribute('stroke', e.kind === 'sequence' ? 'rgba(137,87,229,.7)' : 'rgba(124,92,255,.55)');
    line.setAttribute('stroke-width', '2');
    els.edgesLayer.appendChild(line);
  });
  if (els.connectLine) els.edgesLayer.appendChild(els.connectLine);
}

function render() {
  if (!built || _suppressRender) return;
  var store = getStore(); if (!store) return;
  var ids = currentVisibleIds();
  renderNodes(ids);
  renderEdges(ids);
  renderMinimap();
  updateStatus();
}

function renderMinimap() {
  if (!built || !els.minimap) return;
  var store = getStore(); if (!store) return;
  var ctx = els.minimap.getContext('2d');
  var W = els.minimap.width, H = els.minimap.height;
  ctx.clearRect(0, 0, W, H);
  var nodes = store.listNodes();   // 小地图画全量，便于全局定位
  var vp = store.getViewport();
  var sw = els.stage.clientWidth || 1, sh = els.stage.clientHeight || 1;
  var vx = -vp.x / vp.zoom, vy = -vp.y / vp.zoom, vw = sw / vp.zoom, vh = sh / vp.zoom;
  var minX = vx, minY = vy, maxX = vx + vw, maxY = vy + vh;
  nodes.forEach(function (n) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  });
  var pad = 40; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  var s = Math.min(W / (maxX - minX), H / (maxY - minY));
  function mx(x) { return (x - minX) * s; }
  function my(y) { return (y - minY) * s; }
  nodes.forEach(function (n) {
    ctx.fillStyle = TYPE_COLOR[n.type] || '#8b949e';
    ctx.fillRect(mx(n.x), my(n.y), Math.max(2, n.w * s), Math.max(2, n.h * s));
  });
  ctx.strokeStyle = 'rgba(124,92,255,.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx(vx), my(vy), vw * s, vh * s);
}

function updateStatus() {
  if (!built) return;
  var store = getStore(); if (!store) return;
  var vp = store.getViewport();
  els.stZoom.textContent = Math.round(vp.zoom * 100) + '%';
  els.stNodes.textContent = store.listNodes().length + ' 节点';
  els.stWs.textContent = store.getWorkspace();
  els.wsName.textContent = store.getWorkspace();
}

// ═══════════════════════════════════════════
// 节点便捷 API
// ═══════════════════════════════════════════

function addNode(type, opts) {
  var store = getStore(); if (!store) return null;
  opts = opts || {};
  if (built && typeof opts.x !== 'number') {
    var vp = store.getViewport();
    var cw = (els.stage.clientWidth || 0) / 2, ch = (els.stage.clientHeight || 0) / 2;
    opts.x = (cw - vp.x) / vp.zoom - (opts.w || 180) / 2;
    opts.y = (ch - vp.y) / vp.zoom - (opts.h || 90) / 2;
  }
  opts.type = type || 'note';
  var node = store.addNode(opts); // 触发 canvas:node-add → render
  if (node && built) selectNode(node.id);
  return node;
}

// ═══════════════════════════════════════════
// 开关
// ═══════════════════════════════════════════

function isOpen() {
  return hasDom() && document.body.classList.contains('canvas-open');
}

function open() {
  if (!hasDom()) return false;
  build();
  var store = getStore();
  if (store) store.load();
  document.body.classList.add('canvas-open');
  applyTransform();
  render();
  return true;
}

function close() {
  if (!hasDom()) return;
  document.body.classList.remove('canvas-open');
  closeInspector();
  closeAddMenu();
  closeWsMenu();
}

function toggle() {
  if (isOpen()) close(); else open();
}

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

function init(_Core) {
  Core = _Core;
  Core.canvas = Core.canvas || {};
  Core.canvas.open = open;
  Core.canvas.close = close;
  Core.canvas.toggle = toggle;
  Core.canvas.isOpen = isOpen;
  Core.canvas.render = render;
  Core.canvas.fit = fit;
  Core.canvas.resetView = resetView;
  Core.canvas.zoomBy = zoomBy;
  Core.canvas.addNode = addNode;
  Core.canvas.focusNode = focusNode;
  Core.canvas.selectNode = selectNode;
  Core.canvas.deselect = deselect;
  Core.canvas.deleteSelected = deleteSelected;

  // 订阅 store 事件 → 增量刷新（DOM 就绪后才真正生效）
  if (Core && typeof Core.on === 'function') {
    ['canvas:node-add', 'canvas:node-remove',
     'canvas:edge-add', 'canvas:edge-remove', 'canvas:load',
     'canvas:clear', 'canvas:workspace'].forEach(function (ev) {
      Core.on(ev, render);
    });
    // node-update：尊重 _suppressRender；若是选中节点则刷新检视面板
    Core.on('canvas:node-update', function (d) {
      if (_suppressRender) return;
      render();
      if (d && d.node && d.node.id === selectedId && built && els.inspector && els.inspector.classList.contains('open')) {
        openInspector(d.node.id);
      }
    });
    // Wave 6d：视口变化 → 平移缩放变换 + 仅在可见集合变化时重渲染节点
    Core.on('canvas:viewport', function () {
      applyTransform(); renderMinimap(); updateStatus();
      if (built) {
        var ids = currentVisibleIds();
        if (!sameIds(ids, renderedIds)) { renderNodes(ids); renderEdges(ids); }
      }
    });
  }

  // 注册 /canvas 命令
  if (Core.custom && typeof Core.custom.registerCommand === 'function') {
    Core.custom.registerCommand('canvas', '打开/关闭画布工作区', function () { toggle(); }, false);
  }
}

module.exports = {
  name: 'canvas-view',
  dependencies: ['canvas-store', 'custom'],
  init: init,
  _internals: {
    TYPE_LABEL: TYPE_LABEL, TYPE_COLOR: TYPE_COLOR, STATUS_LABEL: STATUS_LABEL,
    worldRectFromViewport: worldRectFromViewport, nodeVisible: nodeVisible, CULL_MARGIN: CULL_MARGIN
  }
};
