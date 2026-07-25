// modules/task-scheduler.js — 任务调度器（Wave 8：Task Schema + 优先队列 + Worker 池 + 非阻塞执行）
//
// 对应 DS.txt 2.3 任务调度与子角色系统：
//   2.3.1 架构流程：调度器（意图识别 -> 任务拆解 -> 角色路由）-> 任务队列/Worker 池 -> 子角色
//   2.3.2 任务工单 Task Schema
//   2.3.4 非阻塞执行：异步分发（立即返回"已接收"）/ Worker 池并发 / 进度回传 / 结果聚合
// 并联动：
//   2.2.3 画布：任务派发自动建根节点、执行实时同步状态、结果沉淀节点
//   2.1.3 HUD：任务完成推送轻量摘要通知
//
// 与既有 task-queue.js 的分工：task-queue 是通用后台任务队列（单一通用提示词）；
// 本模块是「指挥官式」调度器——带意图识别、子角色路由、任务拆解聚合、画布投影，
// 挂载在 Core.taskScheduler（注意：Core.scheduler 是定时器调度器，勿混淆）。
//
// 模块契约：{ name, dependencies, init(Core) }，由 core-v10.js loadModules() 自动加载。

var Core = null;

// ═══════════════════════════════════════════
// 内部状态
// ═══════════════════════════════════════════
var _tasks = {};        // taskId -> task（全量，含历史）
var _queue = [];        // 待执行 taskId 数组（pump 时按优先级排序）
var _running = {};      // taskId -> task（正在执行）
var _idc = 0;           // 任务自增序号
var _maxConcurrency = 3;
var _saveTimer = null;

// 任务状态 -> 画布节点状态 映射（DS 2.2.2：待执行灰/执行中橙/已完成绿/失败红）
var CANVAS_STATUS = {
  pending: 'pending',
  running: 'running',
  completed: 'done',
  failed: 'error'
};

var DEFAULT_PRIORITY = 3;   // 数字越小优先级越高
var MAX_CONCURRENCY = 5;

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════
function emitEvent(ev, data) {
  if (Core && typeof Core.emit === 'function') {
    try { Core.emit(ev, data); } catch (e) { /* noop */ }
  }
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function genTaskId() {
  var d = new Date();
  var ymd = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  var id;
  do {
    _idc += 1;
    id = 'task_' + ymd + '_' + String(_idc).padStart(3, '0');
  } while (_tasks[id]);
  return id;
}

function dataFile() {
  var path = require('path');
  return path.join(Core.DATA_ROOT, 'tasks.json');
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(function () { _saveTimer = null; saveNow(); }, 300);
}

function saveNow() {
  try {
    var fs = require('fs');
    var path = require('path');
    var dir = Core.DATA_ROOT;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var payload = { version: 1, counter: _idc, tasks: Object.keys(_tasks).map(function (k) { return _tasks[k]; }) };
    fs.writeFileSync(dataFile(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.warn('[task-scheduler] save failed:', e.message);
  }
}

function loadFromDisk() {
  try {
    var fs = require('fs');
    var file = dataFile();
    if (!fs.existsSync(file)) return;
    var data = JSON.parse(fs.readFileSync(file, 'utf8'));
    _idc = data.counter || 0;
    (data.tasks || []).forEach(function (t) {
      if (!t || !t.taskId) return;
      // 断点恢复：运行态任务重置为待执行
      if (t.status === 'running') { t.status = 'pending'; t.startedAt = null; }
      _tasks[t.taskId] = t;
      if (t.status === 'pending' && !t.parentTaskId) _queue.push(t.taskId);
    });
    // 有子任务的父任务若子任务未齐，重新入队未完成子任务
    Object.keys(_tasks).forEach(function (id) {
      var t = _tasks[id];
      if (t.parentTaskId && t.status === 'pending' && _queue.indexOf(t.taskId) < 0) _queue.push(t.taskId);
    });
  } catch (e) {
    console.warn('[task-scheduler] load failed:', e.message);
  }
}

// ═══════════════════════════════════════════
// 任务工单（DS 2.3.2 Task Schema）
// ═══════════════════════════════════════════
function createTicket(ticket) {
  ticket = ticket || {};
  var now = Date.now();
  var task = {
    // —— DS Task Schema 字段 ——
    taskId: genTaskId(),
    taskType: ticket.taskType || 'code_generation',
    priority: typeof ticket.priority === 'number' ? ticket.priority : DEFAULT_PRIORITY,
    status: 'pending',
    params: {
      query: String(ticket.params && ticket.params.query != null ? ticket.params.query : ''),
      context: String(ticket.params && ticket.params.context != null ? ticket.params.context : '')
    },
    callbackChannel: ticket.callbackChannel || 'both',
    createdAt: now,
    parentTaskId: ticket.parentTaskId || null,
    // —— 内部扩展字段 ——
    roleId: ticket.roleId || null,
    title: ticket.title || String(ticket.params && ticket.params.query ? ticket.params.query : '').substring(0, 30),
    progress: 0,
    progressText: '',
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
    canvasNodeId: null,
    subtaskIds: []
  };
  _tasks[task.taskId] = task;
  return task;
}

// ═══════════════════════════════════════════
// 非阻塞提交（指挥官入口）
//   返回 { dispatched:false, intent:'chat' }（闲聊，交回主对话）
//   或   { dispatched:true, taskId, intent, roleId, subtasks? }
// ═══════════════════════════════════════════
function submit(text, opts) {
  opts = opts || {};
  text = String(text == null ? '' : text).trim();
  if (!text) return { dispatched: false, reason: 'empty' };

  // 1) 意图识别
  var cls = (opts.intent)
    ? { intent: opts.intent, role: opts.roleId || (Core.intentRouter ? Core.intentRouter.roleForIntent(opts.intent) : null), confidence: 1 }
    : (Core.intentRouter ? Core.intentRouter.classify(text) : { intent: 'chat', role: null, confidence: 1 });

  // 闲聊不派发（除非强制）
  if (cls.intent === 'chat' && !opts.force) {
    return { dispatched: false, intent: 'chat', confidence: cls.confidence };
  }

  // 2) 任务拆解
  var parts = [text];
  if (opts.decompose !== false && Core.intentRouter && Core.intentRouter.decompose) {
    parts = Core.intentRouter.decompose(text);
  }

  // 3) 多条 -> 复合任务（父 + 子）
  if (parts.length > 1) {
    return submitComposite(text, parts, cls, opts);
  }

  // 4) 单条 -> 直接建工单入队
  var task = createTicket({
    taskType: cls.intent,
    roleId: cls.role,
    params: { query: text, context: opts.context || '' },
    priority: opts.priority,
    callbackChannel: opts.callbackChannel || 'both',
    parentTaskId: null
  });
  enqueue(task);
  pump();
  return {
    dispatched: true,
    taskId: task.taskId,
    intent: cls.intent,
    roleId: task.roleId,
    confidence: cls.confidence
  };
}

function submitComposite(rootText, parts, cls, opts) {
  var parent = createTicket({
    taskType: 'composite',
    roleId: null,
    title: rootText.substring(0, 30),
    params: { query: rootText, context: opts.context || '' },
    priority: opts.priority,
    callbackChannel: opts.callbackChannel || 'both',
    parentTaskId: null
  });
  // 父任务先投影到画布（根节点）
  projectToCanvas(parent, parent.status);

  var subtaskIds = [];
  parts.forEach(function (part) {
    var c = Core.intentRouter ? Core.intentRouter.classify(part) : { intent: cls.intent, role: cls.role };
    if (c.intent === 'chat') c = { intent: cls.intent, role: cls.role }; // 子句兜底用根意图
    var child = createTicket({
      taskType: c.intent,
      roleId: c.role,
      params: { query: part, context: opts.context || '' },
      priority: opts.priority,
      callbackChannel: opts.callbackChannel || 'both',
      parentTaskId: parent.taskId
    });
    parent.subtaskIds.push(child.taskId);
    subtaskIds.push(child.taskId);
    enqueue(child);
    projectToCanvas(child, child.status);
    linkCanvasEdge(parent, child);
  });

  scheduleSave();
  pump();
  return {
    dispatched: true,
    taskId: parent.taskId,
    intent: 'composite',
    subtasks: subtaskIds,
    count: subtaskIds.length
  };
}

function enqueue(task) {
  if (_queue.indexOf(task.taskId) < 0) _queue.push(task.taskId);
  emitEvent('task:queued', { taskId: task.taskId, taskType: task.taskType, roleId: task.roleId, priority: task.priority });
  projectToCanvas(task, task.status);
  scheduleSave();
}

// ═══════════════════════════════════════════
// Worker 池调度
// ═══════════════════════════════════════════
function sortQueue() {
  _queue.sort(function (a, b) {
    var ta = _tasks[a], tb = _tasks[b];
    if (!ta || !tb) return 0;
    if (ta.priority !== tb.priority) return ta.priority - tb.priority; // 小数字优先
    return ta.createdAt - tb.createdAt;
  });
}

function pump() {
  while (_queue.length > 0 && Object.keys(_running).length < _maxConcurrency) {
    sortQueue();
    var taskId = _queue.shift();
    var task = _tasks[taskId];
    if (!task || task.status !== 'pending') continue;
    startTask(task);
  }
}

function startTask(task) {
  task.status = 'running';
  task.startedAt = Date.now();
  _running[task.taskId] = task;
  emitEvent('task:start', { taskId: task.taskId, roleId: task.roleId, taskType: task.taskType });
  setProgress(task, 10, '已分派给 ' + roleName(task.roleId));
  projectToCanvas(task, 'running');
  executeAsync(task); // 异步执行，不阻塞 pump
}

function roleName(roleId) {
  var r = Core && Core.subroles ? Core.subroles.getRole(roleId) : null;
  return r ? r.name : (roleId || '通用执行器');
}

function setProgress(task, pct, text) {
  task.progress = pct;
  task.progressText = text || '';
  emitEvent('task:progress', { taskId: task.taskId, progress: pct, text: task.progressText });
  projectToCanvas(task, task.status);
  scheduleSave();
}

async function executeAsync(task) {
  try {
    setProgress(task, 25, '正在调用 ' + roleName(task.roleId) + '…');
    if (!Core || !Core.subroles || typeof Core.subroles.execute !== 'function') {
      throw new Error('子角色模块不可用');
    }
    var res = await Core.subroles.execute(task.roleId, task.params.query, task.params.context);
    setProgress(task, 90, '正在整理结果…');
    task.result = res.content;
    task.status = 'completed';
    task.progress = 100;
    task.progressText = '完成';
    emitEvent('task:done', { taskId: task.taskId, roleId: task.roleId, preview: String(res.content).substring(0, 200) });
    projectToCanvas(task, 'completed', { resultPreview: String(res.content).substring(0, 300) });
    notifyHud('done', task, String(res.content).substring(0, 40));
  } catch (e) {
    task.status = 'failed';
    task.error = e && e.message ? e.message : String(e);
    task.progress = 100;
    task.progressText = '失败: ' + task.error;
    emitEvent('task:error', { taskId: task.taskId, error: task.error });
    projectToCanvas(task, 'failed');
    notifyHud('error', task, task.error);
  } finally {
    task.completedAt = Date.now();
    delete _running[task.taskId];
    scheduleSave();
    if (task.parentTaskId) checkAggregation(task.parentTaskId);
    pump();
  }
}

// ═══════════════════════════════════════════
// 子任务聚合（DS 2.3.4 结果聚合）
// ═══════════════════════════════════════════
function checkAggregation(parentId) {
  var parent = _tasks[parentId];
  if (!parent || !parent.subtaskIds || parent.subtaskIds.length === 0) return;
  var children = parent.subtaskIds.map(function (id) { return _tasks[id]; }).filter(Boolean);
  if (children.length === 0) return;
  var allDone = children.every(function (c) { return c.status === 'completed' || c.status === 'failed'; });
  if (!allDone) return;

  var aggregated = children.map(function (c, i) {
    return '【子任务 ' + (i + 1) + ' · ' + (c.title || c.taskId) + '】\n' +
      (c.status === 'completed' ? String(c.result || '').substring(0, 800) : '失败: ' + (c.error || '未知错误'));
  }).join('\n\n');

  parent.result = aggregated;
  parent.status = 'completed';
  parent.progress = 100;
  parent.completedAt = Date.now();
  emitEvent('task:aggregated', { taskId: parentId, count: children.length });
  projectToCanvas(parent, 'completed', { resultPreview: aggregated.substring(0, 300) });
  notifyHud('aggregated', parent, children.length + ' 个子任务已完成');
  scheduleSave();
}

// ═══════════════════════════════════════════
// 画布投影（DS 2.2.3）
// ═══════════════════════════════════════════
function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

function projectToCanvas(task, status, extra) {
  var store = getStore();
  if (!store) return;
  try {
    var role = Core && Core.subroles ? Core.subroles.getRole(task.roleId) : null;
    var emoji = role && role.emoji ? role.emoji : (task.taskType === 'composite' ? '🧩' : '✅');
    var nodeStatus = CANVAS_STATUS[status] || 'pending';
    var nodeData = {
      taskId: task.taskId,
      taskType: task.taskType,
      roleId: task.roleId,
      priority: task.priority,
      progress: task.progress,
      progressText: task.progressText
    };
    if (extra) Object.keys(extra).forEach(function (k) { nodeData[k] = extra[k]; });

    if (!task.canvasNodeId) {
      var node = store.addNode({
        type: 'task',
        title: emoji + ' ' + (task.title || task.taskId),
        status: nodeStatus,
        data: nodeData
      });
      task.canvasNodeId = node.id;
    } else {
      store.updateNode(task.canvasNodeId, { status: nodeStatus, data: nodeData });
    }
  } catch (e) {
    console.warn('[task-scheduler] canvas projection failed:', e.message);
  }
}

function linkCanvasEdge(parent, child) {
  var store = getStore();
  if (!store || !parent.canvasNodeId || !child.canvasNodeId) return;
  try {
    store.addEdge({ from: parent.canvasNodeId, to: child.canvasNodeId, kind: 'task-dep' });
  } catch (e) { /* noop */ }
}

// ═══════════════════════════════════════════
// HUD 通知（DS 2.1.3：完成时推送轻量摘要）
// ═══════════════════════════════════════════
function notifyHud(kind, task, detail) {
  if (!Core || !Core.hud || typeof Core.hud.setState !== 'function') return;
  if (task.callbackChannel === 'canvas') return; // 用户指定仅画布
  try {
    if (kind === 'done') {
      Core.hud.setState('idle', { text: '✅ ' + (task.title || task.taskId), sub: String(detail || '').substring(0, 40) });
    } else if (kind === 'error') {
      Core.hud.setState('idle', { text: '❌ ' + (task.title || '任务') + ' 失败', sub: String(detail || '').substring(0, 40) });
    } else if (kind === 'aggregated') {
      Core.hud.setState('idle', { text: '🧩 ' + (task.title || '复合任务') + ' 已聚合', sub: String(detail || '') });
    }
  } catch (e) { /* noop */ }
}

// ═══════════════════════════════════════════
// 查询 / 管理
// ═══════════════════════════════════════════
function formatTask(t) {
  return {
    taskId: t.taskId, title: t.title, taskType: t.taskType, roleId: t.roleId,
    status: t.status, priority: t.priority, progress: t.progress, progressText: t.progressText,
    createdAt: t.createdAt, startedAt: t.startedAt, completedAt: t.completedAt,
    duration: t.completedAt && t.startedAt ? t.completedAt - t.startedAt : (t.startedAt ? Date.now() - t.startedAt : 0),
    parentTaskId: t.parentTaskId, subtaskCount: (t.subtaskIds || []).length,
    hasResult: !!t.result, error: t.error, canvasNodeId: t.canvasNodeId
  };
}

function getTask(taskId) {
  var t = _tasks[taskId];
  return t ? formatTask(t) : null;
}

function getTaskResult(taskId) {
  var t = _tasks[taskId];
  if (!t) return { success: false, error: '任务不存在' };
  if (t.status === 'running' || t.status === 'pending') return { success: false, error: '任务尚未完成', status: t.status, progress: t.progress };
  return { success: t.status === 'completed', result: t.result, status: t.status, error: t.error };
}

function listTasks(filter) {
  var all = Object.keys(_tasks).map(function (k) { return _tasks[k]; });
  if (filter === 'running') all = all.filter(function (t) { return t.status === 'running'; });
  else if (filter === 'pending') all = all.filter(function (t) { return t.status === 'pending'; });
  else if (filter === 'done') all = all.filter(function (t) { return t.status === 'completed' || t.status === 'failed'; });
  return all.sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 20).map(formatTask);
}

function cancelTask(taskId) {
  var t = _tasks[taskId];
  if (!t) return { success: false, error: '任务不存在' };
  if (t.status === 'running') return { success: false, error: '运行中的任务暂不支持强制取消' };
  if (t.status !== 'pending') return { success: false, error: '任务已结束，无法取消' };
  t.status = 'cancelled';
  var idx = _queue.indexOf(taskId);
  if (idx >= 0) _queue.splice(idx, 1);
  projectToCanvas(t, 'pending');
  emitEvent('task:cancelled', { taskId: taskId });
  scheduleSave();
  return { success: true, message: '已取消' };
}

function setConcurrency(n) {
  n = parseInt(n, 10);
  if (!n || n < 1 || n > MAX_CONCURRENCY) return { success: false, error: '并发数范围 1-' + MAX_CONCURRENCY };
  _maxConcurrency = n;
  pump();
  return { success: true, maxConcurrency: n };
}

function getStats() {
  var all = Object.keys(_tasks).map(function (k) { return _tasks[k]; });
  var by = function (s) { return all.filter(function (t) { return t.status === s; }).length; };
  return {
    pending: by('pending'), running: by('running'),
    completed: by('completed'), failed: by('failed'),
    total: all.length, maxConcurrency: _maxConcurrency
  };
}

// ═══════════════════════════════════════════
// /task 命令
// ═══════════════════════════════════════════
function registerCommand() {
  if (!Core || !Core.custom || typeof Core.custom.registerCommand !== 'function') return;
  Core.custom.registerCommand('/task', '任务调度：查看/管理后台任务（/task [list|stats|roles|cancel <id>|concurrency <n>]）', function (args) {
    var parts = String(args || '').trim().split(/\s+/);
    var sub = (parts[0] || 'list').toLowerCase();

    if (sub === 'stats') {
      var s = getStats();
      return '📊 任务统计\n待执行 ' + s.pending + ' | 执行中 ' + s.running + ' | 完成 ' + s.completed + ' | 失败 ' + s.failed +
        '\n总计 ' + s.total + ' | 最大并发 ' + s.maxConcurrency;
    }
    if (sub === 'roles') {
      var roles = Core.subroles ? Core.subroles.listRoles() : [];
      return '👥 子角色列表\n' + roles.map(function (r) { return '  ' + r.emoji + ' ' + r.id + ' — ' + r.name + ': ' + r.description; }).join('\n');
    }
    if (sub === 'cancel') {
      var r = cancelTask(parts[1]);
      return r.success ? '✅ ' + r.message : '❌ ' + r.error;
    }
    if (sub === 'concurrency') {
      var c = setConcurrency(parts[1]);
      return c.success ? '✅ 最大并发已设为 ' + c.maxConcurrency : '❌ ' + c.error;
    }
    // 默认 list
    var list = listTasks();
    if (list.length === 0) return '暂无任务。发送复杂指令（如"写代码/搜索/分析数据"）会自动派发为后台任务。';
    var icons = { pending: '⏳', running: '🔄', completed: '✅', failed: '❌', cancelled: '🚫' };
    return '📋 最近任务（' + list.length + '）\n' + list.map(function (t) {
      return '  ' + (icons[t.status] || '·') + ' [' + t.taskId + '] ' + (t.title || '') + ' (' + t.taskType + ') ' + t.progress + '%';
    }).join('\n');
  }, false);
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════
module.exports = {
  name: 'task-scheduler',
  dependencies: ['intent-router', 'subroles'],
  init: function (_Core) {
    Core = _Core;
    Core.taskScheduler = {
      submit: submit,
      getTask: getTask,
      getTaskResult: getTaskResult,
      listTasks: listTasks,
      cancelTask: cancelTask,
      setConcurrency: setConcurrency,
      getStats: getStats,
      saveNow: saveNow
    };
    registerCommand();
    loadFromDisk();
    pump(); // 恢复断点任务
    console.log('✅ Task-Scheduler 已加载（指挥官调度，最大并发 ' + _maxConcurrency + '）');
  },
  _internals: {
    createTicket: createTicket,
    submitComposite: submitComposite,
    checkAggregation: checkAggregation,
    pump: pump,
    sortQueue: sortQueue,
    CANVAS_STATUS: CANVAS_STATUS,
    _state: { tasks: _tasks, queue: _queue, running: _running }
  }
};
