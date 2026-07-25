// modules/canvas-view.js — 画布视图壳（Wave 6a）
//
// 桌面原生「工作层」：全屏无限画布，平移缩放 + 网格 + 工具栏 + 小地图 + 状态栏。
// 节点/连线数据来自 Core.canvas.store（canvas-store.js）；本模块只负责「看得见」。
// 实时 agent 投影由 Wave 6b 的 canvas-sync 接入；本期先做一个可放置/拖拽/持久化的可用画布壳。
//
// 渲染选型：方案 A —— 手写 DOM 节点 + SVG 连线 + CSS transform 平移缩放，零依赖零构建。
// 所有 DOM 操作守卫 hasDom()，Node 测试环境下安全 no-op。

var Core = null;
var built = false;
var els = {};
var dragState = null;

var TYPE_LABEL = {
  agent: 'Agent', task: '任务', tool: '工具', data: '数据',
  result: '产物', workflow: '工作流', chat: '对话', note: '便签'
};
var TYPE_COLOR = {
  agent: '#7c5cff', task: '#2f81f7', tool: '#d29922', data: '#3fb950',
  result: '#db61a2', workflow: '#8957e5', chat: '#58a6ff', note: '#8b949e'
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
  '.cv-ws{margin-left:auto;font-size:12px;color:#8b949e;}',
  '.cv-ws b{color:#e6edf3;font-weight:600;}',
  '.cv-stage{position:absolute;top:48px;left:0;right:0;bottom:24px;overflow:hidden;cursor:grab;',
  'background-color:#0b0e14;',
  'background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);',
  'background-size:40px 40px;}',
  '.cv-stage.cv-panning{cursor:grabbing;}',
  '.cv-world{position:absolute;top:0;left:0;width:0;height:0;transform-origin:0 0;}',
  '.cv-nodes{position:absolute;top:0;left:0;}',
  '.cv-edges{position:absolute;top:0;left:0;width:1px;height:1px;overflow:visible;pointer-events:none;}',
  '.cv-node{position:absolute;box-sizing:border-box;border-radius:10px;background:rgba(22,27,34,.96);',
  'border:1px solid rgba(255,255,255,.12);padding:9px 11px;cursor:grab;overflow:hidden;',
  'box-shadow:0 4px 14px rgba(0,0,0,.35);transition:border-color .15s;}',
  '.cv-node:hover{border-color:rgba(255,255,255,.28);}',
  '.cv-node-type{font-size:10px;letter-spacing:.5px;opacity:.7;text-transform:uppercase;margin-bottom:4px;}',
  '.cv-node-title{font-size:13px;font-weight:600;line-height:1.35;word-break:break-word;}',
  '.cv-minimap{position:absolute;right:12px;bottom:36px;width:180px;height:120px;background:rgba(13,17,23,.92);',
  'border:1px solid rgba(255,255,255,.1);border-radius:8px;z-index:4;overflow:hidden;}',
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
  '@keyframes cv-pulse{0%,100%{opacity:1;}50%{opacity:.25;}}'
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
      '<button class="cv-btn cv-btn--primary" data-act="addNote">＋ 新建便签</button>' +
      '<button class="cv-btn" data-act="fit">适应</button>' +
      '<button class="cv-btn" data-act="reset">重置视图</button>' +
      '<button class="cv-btn" data-act="zoomOut">－</button>' +
      '<button class="cv-btn" data-act="zoomIn">＋</button>' +
      '<button class="cv-btn" data-act="save">保存</button>' +
      '<span class="cv-ws">工作区：<b class="cv-ws-name">default</b></span>' +
    '</div>' +
    '<div class="cv-stage">' +
      '<div class="cv-world">' +
        '<svg class="cv-edges" xmlns="http://www.w3.org/2000/svg"></svg>' +
        '<div class="cv-nodes"></div>' +
      '</div>' +
      '<div class="cv-empty">画布是空的<br>点左上角「新建便签」放一个节点，或等待 Wave 6b 自动投影 Agent 活动</div>' +
    '</div>' +
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

  wireEvents();
  built = true;
}

function wireEvents() {
  // 工具栏（事件委托）
  els.toolbar.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.cv-btn') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'back') close();
    else if (act === 'addNote') addNode('note', { title: '新便签' });
    else if (act === 'fit') fit();
    else if (act === 'reset') resetView();
    else if (act === 'zoomIn') zoomBy(1.2);
    else if (act === 'zoomOut') zoomBy(1 / 1.2);
    else if (act === 'save') { var s = getStore(); if (s) s.save(); }
  });

  // 平移 / 节点拖拽（统一在 stage 上判定）
  els.stage.addEventListener('mousedown', onStageMouseDown);

  // 滚轮缩放（非 passive 以阻止页面滚动）
  els.stage.addEventListener('wheel', onWheel, { passive: false });

  // 全局拖拽监听
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);

  // 窗口尺寸变化
  window.addEventListener('resize', function () {
    applyTransform(); renderMinimap();
  });
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
// 拖拽（平移 + 节点）
// ═══════════════════════════════════════════

function onStageMouseDown(e) {
  var store = getStore(); if (!store) return;
  var nodeEl = e.target.closest ? e.target.closest('.cv-node') : null;
  if (nodeEl) {
    var id = nodeEl.getAttribute('data-id');
    var n = store.getNode(id); if (!n) return;
    dragState = { mode: 'node', id: id, el: nodeEl, startX: e.clientX, startY: e.clientY, nodeX: n.x, nodeY: n.y };
  } else {
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
  } else {
    var vp = store.getViewport();
    var nx = dragState.nodeX + (e.clientX - dragState.startX) / vp.zoom;
    var ny = dragState.nodeY + (e.clientY - dragState.startY) / vp.zoom;
    store.setNodePosition(dragState.id, nx, ny);
    dragState.el.style.left = nx + 'px';
    dragState.el.style.top = ny + 'px';
    renderEdges();
    renderMinimap();
  }
}

function onDocMouseUp() {
  if (!dragState) return;
  var store = getStore();
  if (dragState.mode === 'node' && store) store.save();
  dragState = null;
  if (built) els.stage.classList.remove('cv-panning');
}

// ═══════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════

function makeNodeEl(n) {
  var el = document.createElement('div');
  el.className = 'cv-node cv-node--' + (n.type || 'note') + ' cv-st--' + (n.status || 'idle');
  el.style.left = n.x + 'px';
  el.style.top = n.y + 'px';
  el.style.width = n.w + 'px';
  el.style.height = n.h + 'px';
  el.setAttribute('data-id', n.id);
  el.innerHTML =
    '<span class="cv-dot"></span>' +
    '<div class="cv-node-type">' + esc(TYPE_LABEL[n.type] || n.type || '节点') + '</div>' +
    '<div class="cv-node-title">' + esc(n.title || '未命名') + '</div>';
  return el;
}

function renderEdges() {
  if (!built) return;
  var store = getStore(); if (!store) return;
  var SVGNS = 'http://www.w3.org/2000/svg';
  // 清空（保留 svg 本身）
  while (els.edgesLayer.firstChild) els.edgesLayer.removeChild(els.edgesLayer.firstChild);
  store.listEdges().forEach(function (e) {
    var a = store.getNode(e.from), b = store.getNode(e.to);
    if (!a || !b) return;
    var line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', a.x + a.w / 2);
    line.setAttribute('y1', a.y + a.h / 2);
    line.setAttribute('x2', b.x + b.w / 2);
    line.setAttribute('y2', b.y + b.h / 2);
    line.setAttribute('stroke', 'rgba(124,92,255,.55)');
    line.setAttribute('stroke-width', '2');
    els.edgesLayer.appendChild(line);
  });
}

function render() {
  if (!built) return;
  var store = getStore(); if (!store) return;
  while (els.nodesLayer.firstChild) els.nodesLayer.removeChild(els.nodesLayer.firstChild);
  var nodes = store.listNodes();
  nodes.forEach(function (n) { els.nodesLayer.appendChild(makeNodeEl(n)); });
  renderEdges();
  els.emptyHint.style.display = nodes.length ? 'none' : 'block';
  renderMinimap();
  updateStatus();
}

function renderMinimap() {
  if (!built || !els.minimap) return;
  var store = getStore(); if (!store) return;
  var ctx = els.minimap.getContext('2d');
  var W = els.minimap.width, H = els.minimap.height;
  ctx.clearRect(0, 0, W, H);
  var nodes = store.listNodes();
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
  return store.addNode(opts); // 触发 canvas:node-add → render
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

  // 订阅 store 事件 → 增量刷新（DOM 就绪后才真正生效）
  if (Core && typeof Core.on === 'function') {
    ['canvas:node-add', 'canvas:node-update', 'canvas:node-remove',
     'canvas:edge-add', 'canvas:edge-remove', 'canvas:load',
     'canvas:clear', 'canvas:workspace'].forEach(function (ev) {
      Core.on(ev, render);
    });
    Core.on('canvas:viewport', function () {
      applyTransform(); renderMinimap(); updateStatus();
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
  _internals: { TYPE_LABEL: TYPE_LABEL, TYPE_COLOR: TYPE_COLOR }
};
