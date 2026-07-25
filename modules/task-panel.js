// modules/task-panel.js - 子任务面板可视化模块
// 为 Agent 的计划执行提供可视化任务面板（TodoList Widget）
// 支持任务状态更新、进度条、嵌套子任务

var Core = null;
var _htmlUtils = require('./html-utils');

// ═══════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════

var tasks = [];           // [{ id, title, status, detail, createdAt, updatedAt }]
var panelEl = null;       // 当前面板 DOM 元素
var taskCounter = 0;
var PANEL_ID = 'task-panel-' + Date.now();

var STATUS_MAP = {
  pending:     { icon: '⬜', label: '待处理', color: 'var(--text-secondary)' },
  in_progress: { icon: '🔄', label: '进行中', color: 'var(--primary)' },
  completed:   { icon: '✅', label: '已完成', color: '#22c55e' },
  cancelled:   { icon: '❌', label: '已取消', color: 'var(--text-secondary)' },
  blocked:     { icon: '🚫', label: '已阻塞', color: '#ef4444' },
  failed:      { icon: '💥', label: '失败',   color: '#ef4444' }
};

// ═══════════════════════════════════════════
// 任务管理 API
// ═══════════════════════════════════════════

/**
 * 创建任务列表并显示面板
 */
function createTaskList(taskItems) {
  tasks = [];
  taskCounter = 0;

  if (Array.isArray(taskItems)) {
    taskItems.forEach(function(item) {
      addTask(typeof item === 'string' ? item : item.title, item.status || 'pending');
    });
  }

  showPanel();
  return tasks.map(function(t) { return { id: t.id, title: t.title, status: t.status }; });
}

/**
 * 添加单个任务
 */
function addTask(title, status) {
  status = status || 'pending';
  taskCounter++;
  var task = {
    id: taskCounter,
    title: title || '未命名任务',
    status: status,
    detail: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  tasks.push(task);
  renderPanel();
  return task.id;
}

/**
 * 更新任务状态
 */
function updateTask(id, updates) {
  var task = tasks.find(function(t) { return t.id === id; });
  if (!task) return false;

  if (updates.status) task.status = updates.status;
  if (updates.title) task.title = updates.title;
  if (updates.detail !== undefined) task.detail = updates.detail;
  task.updatedAt = Date.now();

  renderPanel();
  return true;
}

/**
 * 按标题查找并更新任务
 */
function updateTaskByTitle(titleKeyword, status) {
  var task = tasks.find(function(t) {
    return t.title.indexOf(titleKeyword) !== -1 && t.status !== 'completed' && t.status !== 'cancelled';
  });
  if (task) {
    task.status = status;
    task.updatedAt = Date.now();
    renderPanel();
    return task.id;
  }
  return -1;
}

/**
 * 获取进度统计
 */
function getProgress() {
  var total = tasks.length;
  var completed = tasks.filter(function(t) { return t.status === 'completed'; }).length;
  var inProgress = tasks.filter(function(t) { return t.status === 'in_progress'; }).length;
  var failed = tasks.filter(function(t) { return t.status === 'failed' || t.status === 'blocked'; }).length;
  var cancelled = tasks.filter(function(t) { return t.status === 'cancelled'; }).length;
  var pending = total - completed - inProgress - failed - cancelled;
  var percent = total > 0 ? Math.round(((completed + cancelled * 0.5) / total) * 100) : 0;

  return {
    total: total, completed: completed, inProgress: inProgress,
    failed: failed, cancelled: cancelled, pending: pending, percent: percent
  };
}

/**
 * 获取所有任务
 */
function getTasks() {
  return tasks.map(function(t) {
    return { id: t.id, title: t.title, status: t.status, detail: t.detail };
  });
}

/**
 * 清除所有任务
 */
function clearTasks() {
  tasks = [];
  taskCounter = 0;
  emitSync();
  hidePanel();
}

// ═══════════════════════════════════════════
// UI 渲染
// ═══════════════════════════════════════════

function showPanel() {
  if (panelEl && document.body.contains(panelEl)) {
    renderPanel();
    return;
  }

  var container = document.getElementById('chatContainer');
  if (!container) return;

  panelEl = document.createElement('div');
  panelEl.id = PANEL_ID;
  panelEl.className = 'task-panel';
  container.appendChild(panelEl);

  renderPanel();

  // 滚动到面板
  setTimeout(function() {
    panelEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

function hidePanel() {
  if (panelEl) {
    // 转换为完成状态
    var summary = document.createElement('div');
    summary.className = 'task-panel-summary';
    var progress = getProgress();
    summary.textContent = '📋 任务完成: ' + progress.completed + '/' + progress.total + ' (' + progress.percent + '%)';
    if (panelEl.parentNode) {
      panelEl.parentNode.replaceChild(summary, panelEl);
    }
    panelEl = null;
  }
}

// 任务变更全量广播（供 canvas-sync 投影任务节点；守卫式，无 Core/emit 时静默）
function emitSync() {
  if (Core && typeof Core.emit === 'function') {
    try { Core.emit('task:sync', { tasks: getTasks() }); } catch (e) { /* noop */ }
  }
}

function renderPanel() {
  emitSync();
  if (!panelEl) return;

  var progress = getProgress();

  var html = '<div class="task-panel-header">';
  html += '<span class="task-panel-title">📋 任务进度</span>';
  html += '<span class="task-panel-progress">' + progress.completed + '/' + progress.total + '</span>';
  html += '</div>';

  // 进度条
  html += '<div class="task-progress-bar">';
  html += '<div class="task-progress-fill" style="width:' + progress.percent + '%;';
  if (progress.failed > 0) html += 'background:linear-gradient(90deg,#22c55e ' + (progress.percent - 10) + '%,#ef4444 100%)';
  html += '"></div></div>';

  // 任务列表
  html += '<div class="task-list">';
  tasks.forEach(function(task) {
    var s = STATUS_MAP[task.status] || STATUS_MAP.pending;
    var rowClass = 'task-row task-status-' + task.status;
    if (task.status === 'completed') rowClass += ' task-done';

    html += '<div class="' + rowClass + '">';
    html += '<span class="task-icon">' + s.icon + '</span>';
    html += '<span class="task-title"' + (task.status === 'completed' ? ' style="text-decoration:line-through;opacity:0.6"' : '') + '>' + escapeHtml(task.title) + '</span>';
    if (task.detail) {
      html += '<span class="task-detail">' + escapeHtml(task.detail) + '</span>';
    }
    html += '</div>';
  });
  html += '</div>';

  panelEl.innerHTML = html;
}

var escapeHtml = _htmlUtils.escapeHtml;

// ═══════════════════════════════════════════
// Agent 集成：从 planAndExecute 结果创建面板
// ═══════════════════════════════════════════

/**
 * 从 Agent 的 plan 步骤创建任务面板
 */
function createFromPlan(planSteps) {
  if (!Array.isArray(planSteps) || planSteps.length === 0) return;

  var items = planSteps.map(function(step) {
    return {
      title: step.action || step.description || ('步骤 ' + step.step),
      status: 'pending'
    };
  });

  return createTaskList(items);
}

/**
 * 标记当前步骤为进行中
 */
function markInProgress(stepIndex) {
  if (stepIndex > 0 && stepIndex <= tasks.length) {
    tasks[stepIndex - 1].status = 'in_progress';
    tasks[stepIndex - 1].updatedAt = Date.now();
    renderPanel();
  }
}

/**
 * 标记当前步骤为完成
 */
function markCompleted(stepIndex, detail) {
  if (stepIndex > 0 && stepIndex <= tasks.length) {
    tasks[stepIndex - 1].status = 'completed';
    tasks[stepIndex - 1].detail = detail || '';
    tasks[stepIndex - 1].updatedAt = Date.now();
    renderPanel();
  }
}

/**
 * 标记当前步骤为失败
 */
function markFailed(stepIndex, detail) {
  if (stepIndex > 0 && stepIndex <= tasks.length) {
    tasks[stepIndex - 1].status = 'failed';
    tasks[stepIndex - 1].detail = detail || '';
    tasks[stepIndex - 1].updatedAt = Date.now();
    renderPanel();
  }
}

// ═══════════════════════════════════════════
// /task 命令
// ═══════════════════════════════════════════

function handleTaskCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'list').toLowerCase();
  var rest = parts.slice(1).join(' ');

  switch (sub) {
    case 'list': case 'ls': case '状态':
      if (tasks.length === 0) return '暂无任务。使用 `/task add <描述>` 添加任务';
      var progress = getProgress();
      var info = '📋 **任务列表** (' + progress.percent + '% 完成)\n\n';
      tasks.forEach(function(t) {
        var s = STATUS_MAP[t.status] || STATUS_MAP.pending;
        info += s.icon + ' [' + t.id + '] ' + t.title + (t.detail ? ' — ' + t.detail : '') + '\n';
      });
      return info;

    case 'add': case '添加':
      if (!rest) return '用法: /task add <任务描述>';
      var id = addTask(rest);
      showPanel();
      return '✅ 任务 #' + id + ' 已添加: ' + rest;

    case 'done': case '完成':
      var doneId = parseInt(rest);
      if (doneId && updateTask(doneId, { status: 'completed' })) return '✅ 任务 #' + doneId + ' 已完成';
      // 尝试按标题匹配
      var matched = updateTaskByTitle(rest, 'completed');
      if (matched > 0) return '✅ 任务 #' + matched + ' 已完成';
      return '❌ 未找到任务: ' + rest;

    case 'fail': case '失败':
      var failId = parseInt(rest);
      if (failId && updateTask(failId, { status: 'failed' })) return '💥 任务 #' + failId + ' 已标记失败';
      return '❌ 未找到任务: ' + rest;

    case 'cancel': case '取消':
      var cancelId = parseInt(rest);
      if (cancelId && updateTask(cancelId, { status: 'cancelled' })) return '❌ 任务 #' + cancelId + ' 已取消';
      return '❌ 未找到任务: ' + rest;

    case 'clear': case '清除':
      clearTasks();
      return '🗑️ 所有任务已清除';

    case 'progress': case '进度':
      var p = getProgress();
      return '📊 **任务进度**: ' + p.completed + '/' + p.total + ' (' + p.percent + '%)\n' +
        '✅ 完成: ' + p.completed + ' | 🔄 进行: ' + p.inProgress + ' | ⬜ 待处理: ' + p.pending +
        ' | 💥 失败: ' + p.failed + ' | ❌ 取消: ' + p.cancelled;

    default:
      return '📋 **任务面板命令**\n\n' +
        '- `/task list` — 查看所有任务\n' +
        '- `/task add <描述>` — 添加任务\n' +
        '- `/task done <ID或关键词>` — 标记完成\n' +
        '- `/task fail <ID>` — 标记失败\n' +
        '- `/task cancel <ID>` — 取消任务\n' +
        '- `/task progress` — 查看进度统计\n' +
        '- `/task clear` — 清除所有任务';
  }
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.taskPanel = {
      createTaskList: createTaskList,
      addTask: addTask,
      updateTask: updateTask,
      updateTaskByTitle: updateTaskByTitle,
      getProgress: getProgress,
      getTasks: getTasks,
      clearTasks: clearTasks,
      showPanel: showPanel,
      hidePanel: hidePanel,

      // Agent 集成
      createFromPlan: createFromPlan,
      markInProgress: markInProgress,
      markCompleted: markCompleted,
      markFailed: markFailed,

      handleCommand: handleTaskCommand
    };

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/task', function(args) {
        return handleTaskCommand(args);
      });
    }

    console.log('✅ 子任务面板模块已加载');
  }
};
