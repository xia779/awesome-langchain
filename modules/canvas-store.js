// modules/canvas-store.js — 画布数据模型 + 持久化 + canvas:* 事件源（Wave 6a）
//
// 设计铁律：布局落盘、实时状态不落盘。
//   · 本模块只持有「布局事实来源」：节点位置/尺寸、连线、视口、工作区。
//   · 节点的实时运行状态（running/done…）由 canvas-sync 从事件流即时推导，绝不写进这里。
//
// 模块契约：{ name, dependencies, init(Core) }，由 core-v10.js loadModules() 自动加载。
// 持久化范式对齐 custom.js / workflow.js：require('fs') + require('path') + Core.DATA_ROOT。

var Core = null;

// ═══════════════════════════════════════════
// 内部状态
// ═══════════════════════════════════════════

var state = {
  nodes: {},                 // id -> { id, type, x, y, w, h, title, data, createdAt, updatedAt }
  edges: {},                 // id -> { id, from, to, kind, createdAt }
  viewport: { x: 0, y: 0, zoom: 1 },
  meta: {}
};

var currentWorkspace = 'default';
var _idc = 0;
var _saveTimer = null;

var NODE_DEFAULTS = { w: 180, h: 90 };
var ZOOM_MIN = 0.2;
var ZOOM_MAX = 3;

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

function emit(ev, data) {
  if (Core && typeof Core.emit === 'function') {
    try { Core.emit(ev, data); } catch (e) { /* noop */ }
  }
}

function genId(prefix) {
  _idc += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + _idc.toString(36);
}

// 工作区名清洗，防止路径穿越
function safeName(name) {
  return String(name || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'default';
}

function clampZoom(z) {
  z = Number(z) || 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(function () {
    _saveTimer = null;
    save();
  }, 300);
}

// ═══════════════════════════════════════════
// 节点 CRUD
// ═══════════════════════════════════════════

function addNode(node) {
  node = node || {};
  var id = node.id || genId('n');
  var now = Date.now();
  var rec = {
    id: id,
    type: node.type || 'note',
    x: typeof node.x === 'number' ? node.x : 80,
    y: typeof node.y === 'number' ? node.y : 80,
    w: node.w || NODE_DEFAULTS.w,
    h: node.h || NODE_DEFAULTS.h,
    title: node.title || '',
    status: node.status || 'idle',
    data: node.data || {},
    createdAt: now,
    updatedAt: now
  };
  state.nodes[id] = rec;
  emit('canvas:node-add', { node: rec });
  scheduleSave();
  return rec;
}

function updateNode(id, patch) {
  var rec = state.nodes[id];
  if (!rec) return null;
  patch = patch || {};
  Object.keys(patch).forEach(function (k) {
    if (k === 'id' || k === 'createdAt') return;
    rec[k] = patch[k];
  });
  rec.updatedAt = Date.now();
  emit('canvas:node-update', { node: rec, patch: patch });
  scheduleSave();
  return rec;
}

// 拖拽期间的轻量位置更新：不发事件、不触发存盘（由调用方在 mouseup 时 save()）
function setNodePosition(id, x, y) {
  var rec = state.nodes[id];
  if (!rec) return null;
  rec.x = x; rec.y = y;
  rec.updatedAt = Date.now();
  return rec;
}

function removeNode(id) {
  var rec = state.nodes[id];
  if (!rec) return false;
  delete state.nodes[id];
  // 级联删除相连的连线
  var removedEdges = [];
  Object.keys(state.edges).forEach(function (eid) {
    var e = state.edges[eid];
    if (e.from === id || e.to === id) {
      delete state.edges[eid];
      removedEdges.push(eid);
    }
  });
  emit('canvas:node-remove', { id: id, removedEdges: removedEdges });
  scheduleSave();
  return true;
}

function getNode(id) { return state.nodes[id] || null; }

function listNodes() {
  return Object.keys(state.nodes).map(function (k) { return state.nodes[k]; });
}

// ═══════════════════════════════════════════
// 连线 CRUD
// ═══════════════════════════════════════════

function addEdge(edge) {
  edge = edge || {};
  if (!edge.from || !edge.to) return null;
  if (!state.nodes[edge.from] || !state.nodes[edge.to]) return null; // 端点必须存在
  var id = edge.id || genId('e');
  var rec = {
    id: id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind || 'data-flow',
    createdAt: Date.now()
  };
  state.edges[id] = rec;
  emit('canvas:edge-add', { edge: rec });
  scheduleSave();
  return rec;
}

function removeEdge(id) {
  if (!state.edges[id]) return false;
  delete state.edges[id];
  emit('canvas:edge-remove', { id: id });
  scheduleSave();
  return true;
}

function listEdges() {
  return Object.keys(state.edges).map(function (k) { return state.edges[k]; });
}

// ═══════════════════════════════════════════
// 视口
// ═══════════════════════════════════════════

function setViewport(vp) {
  vp = vp || {};
  if (typeof vp.x === 'number') state.viewport.x = vp.x;
  if (typeof vp.y === 'number') state.viewport.y = vp.y;
  if (typeof vp.zoom === 'number') state.viewport.zoom = clampZoom(vp.zoom);
  emit('canvas:viewport', { viewport: getViewport() });
  scheduleSave();
  return getViewport();
}

function getViewport() {
  return { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom };
}

// ═══════════════════════════════════════════
// 持久化
// ═══════════════════════════════════════════

function canvasDir() {
  var path = require('path');
  return path.join(Core.DATA_ROOT, 'canvas');
}

function workspaceFile(name) {
  var path = require('path');
  return path.join(canvasDir(), safeName(name || currentWorkspace) + '.json');
}

function save() {
  try {
    var fs = require('fs');
    var dir = canvasDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var payload = {
      version: 1,
      workspace: currentWorkspace,
      viewport: state.viewport,
      nodes: state.nodes,
      edges: state.edges,
      meta: state.meta,
      savedAt: Date.now()
    };
    fs.writeFileSync(workspaceFile(), JSON.stringify(payload, null, 2), 'utf8');
    emit('canvas:saved', { workspace: currentWorkspace });
    return true;
  } catch (e) {
    console.warn('[canvas-store] save failed:', e.message);
    return false;
  }
}

function load(workspace) {
  if (workspace) currentWorkspace = safeName(workspace);
  try {
    var fs = require('fs');
    var file = workspaceFile();
    if (!fs.existsSync(file)) {
      emit('canvas:load', { workspace: currentWorkspace, empty: true });
      return false;
    }
    var data = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.nodes = data.nodes || {};
    state.edges = data.edges || {};
    state.viewport = data.viewport || { x: 0, y: 0, zoom: 1 };
    state.meta = data.meta || {};
    emit('canvas:load', { workspace: currentWorkspace, empty: false });
    return true;
  } catch (e) {
    console.warn('[canvas-store] load failed:', e.message);
    return false;
  }
}

function listWorkspaces() {
  try {
    var fs = require('fs');
    var dir = canvasDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(function (f) { return /\.json$/.test(f); })
      .map(function (f) { return f.replace(/\.json$/, ''); });
  } catch (e) {
    return [];
  }
}

function switchWorkspace(name) {
  save(); // 先存当前
  currentWorkspace = safeName(name);
  // 重置内存再载入目标
  state.nodes = {}; state.edges = {};
  state.viewport = { x: 0, y: 0, zoom: 1 };
  state.meta = {};
  load(currentWorkspace);
  emit('canvas:workspace', { workspace: currentWorkspace });
  return currentWorkspace;
}

function newWorkspace(name) {
  save();
  currentWorkspace = safeName(name);
  state.nodes = {}; state.edges = {};
  state.viewport = { x: 0, y: 0, zoom: 1 };
  state.meta = {};
  save();
  emit('canvas:workspace', { workspace: currentWorkspace, created: true });
  return currentWorkspace;
}

function getWorkspace() { return currentWorkspace; }

// 清空当前工作区（主要用于测试 / 重置）
function clear() {
  state.nodes = {}; state.edges = {};
  state.viewport = { x: 0, y: 0, zoom: 1 };
  emit('canvas:clear', { workspace: currentWorkspace });
  scheduleSave();
}

function serialize() {
  return {
    workspace: currentWorkspace,
    viewport: getViewport(),
    nodes: JSON.parse(JSON.stringify(state.nodes)),
    edges: JSON.parse(JSON.stringify(state.edges))
  };
}

// ═══════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════

function init(_Core) {
  Core = _Core;
  Core.canvas = Core.canvas || {};
  Core.canvas.store = {
    // 节点
    addNode: addNode,
    updateNode: updateNode,
    setNodePosition: setNodePosition,
    removeNode: removeNode,
    getNode: getNode,
    listNodes: listNodes,
    // 连线
    addEdge: addEdge,
    removeEdge: removeEdge,
    listEdges: listEdges,
    // 视口
    setViewport: setViewport,
    getViewport: getViewport,
    // 持久化 / 工作区
    save: save,
    load: load,
    listWorkspaces: listWorkspaces,
    switchWorkspace: switchWorkspace,
    newWorkspace: newWorkspace,
    getWorkspace: getWorkspace,
    clear: clear,
    serialize: serialize,
    // 常量
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX
  };
  // 尝试载入默认工作区（无文件则为空，静默）
  try { load(currentWorkspace); } catch (e) { /* noop */ }
}

module.exports = {
  name: 'canvas-store',
  dependencies: [],
  init: init,
  _internals: { genId: genId, safeName: safeName, clampZoom: clampZoom }
};
