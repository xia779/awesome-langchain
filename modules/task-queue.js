// modules/task-queue.js - 后台长任务队列（持久化 + 断点恢复 + 目标模式 + 并行子任务）
var Core = null;

// ===== 任务队列状态 =====
var _queue = [];
var _running = {};
var _completed = [];
var _taskCounter = 0;
var MAX_CONCURRENCY = 2;
var MAX_HISTORY = 50;

// ===== 数据库持久化 =====
function extendDatabase() {
  if (!Core.db || Core.db._backend !== 'sqlite') return;
  try {
    Core.db.run("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'queued', progress INTEGER DEFAULT 0, progress_text TEXT DEFAULT '', result TEXT, error TEXT, session_id TEXT, parent_task_id TEXT, mode TEXT DEFAULT 'normal', notify INTEGER DEFAULT 1, created_at INTEGER, started_at INTEGER, completed_at INTEGER)");
    Core.db.run("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
    Core.db.run("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)");
  } catch (e) {
    console.warn('tasks table creation failed:', e.message);
  }
}

function _dbSaveTask(task) {
  if (!Core.db || Core.db._backend !== 'sqlite') return;
  try {
    Core.db.run(
      "INSERT OR REPLACE INTO tasks (id, prompt, title, status, progress, progress_text, result, error, session_id, parent_task_id, mode, notify, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [task.id, task.prompt, task.title, task.status, task.progress, task.progressText || '', task.result || null, task.error || null, task.sessionId || null, task.parentTaskId || null, task.mode || 'normal', task.notifyOnComplete ? 1 : 0, task.createdAt, task.startedAt, task.completedAt]
    );
  } catch (e) { console.warn('⚠️ [task-queue] 操作失败:', e.message || e); }
}

function _dbUpdateStatus(task) {
  if (!Core.db || Core.db._backend !== 'sqlite') return;
  try {
    Core.db.run(
      "UPDATE tasks SET status=?, progress=?, progress_text=?, result=?, error=?, started_at=?, completed_at=? WHERE id=?",
      [task.status, task.progress, task.progressText || '', task.result || null, task.error || null, task.startedAt, task.completedAt, task.id]
    );
  } catch (e) { console.warn('⚠️ [task-queue] 操作失败:', e.message || e); }
}

// ===== 断点恢复 =====
function _restoreFromDB() {
  if (!Core.db || Core.db._backend !== 'sqlite') return;
  try {
    var rows = Core.db.query("SELECT * FROM tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC");
    if (!rows || rows.length === 0) return;
    var restored = 0;
    rows.forEach(function(row) {
      var task = {
        id: row.id, prompt: row.prompt, title: row.title || row.prompt.substring(0, 30),
        status: 'queued', progress: 0, progressText: '重启恢复，重新执行...',
        createdAt: row.created_at, startedAt: null, completedAt: null,
        result: null, error: null, sessionId: row.session_id,
        parentTaskId: row.parent_task_id, mode: row.mode || 'normal',
        notifyOnComplete: row.notify !== 0,
      };
      _queue.push(task);
      restored++;
    });
    if (restored > 0) {
      console.log('从数据库恢复了 ' + restored + ' 个未完成任务');
      _processQueue();
    }
  } catch (e) {
    console.warn('任务恢复失败:', e.message);
  }
}

// ===== 创建任务 =====
function createTask(options) {
  if (!options || !options.prompt) return { success: false, error: '缺少 prompt 参数' };
  var taskId = 'task_' + (++_taskCounter) + '_' + Date.now().toString(36);
  var task = {
    id: taskId, prompt: options.prompt,
    title: options.title || options.prompt.substring(0, 30),
    status: 'queued', progress: 0, progressText: '',
    createdAt: Date.now(), startedAt: null, completedAt: null,
    result: null, error: null,
    sessionId: options.sessionId || null,
    parentTaskId: options.parentTaskId || null,
    mode: options.mode || 'normal',
    notifyOnComplete: options.notify !== false,
  };
  _queue.push(task);
  _dbSaveTask(task);
  _processQueue();
  return { success: true, taskId: taskId, title: task.title, mode: task.mode };
}

// ===== 队列处理 =====
function _processQueue() {
  while (_queue.length > 0 && Object.keys(_running).length < MAX_CONCURRENCY) {
    var task = _queue.shift();
    if (task.status === 'cancelled') continue;
    task.status = 'running';
    task.startedAt = Date.now();
    _running[task.id] = task;
    _dbUpdateStatus(task);
    _executeTask(task);
  }
}

// ===== 执行任务 =====
async function _executeTask(task) {
  try {
    _updateProgress(task, 10, '正在准备执行...');
    if (!Core.api || !Core.api.callAPI) throw new Error('API 模块不可用');
    _updateProgress(task, 20, '正在调用 AI...');
    var systemMsg = task.mode === 'goal'
      ? '你是一个目标驱动的执行助手。请持续、彻底地完成用户的目标，不要中途停止。如果任务复杂，分步骤逐一完成。'
      : '你是一个后台任务执行助手。请认真完成用户交代的任务，给出详细结果。';
    var result = await Core.api.callAPI(task.prompt, systemMsg, 0.7, null, null,
      [{ role: 'system', content: systemMsg }, { role: 'user', content: task.prompt }],
      { disableTools: false });
    _updateProgress(task, 90, '正在整理结果...');
    task.result = (result && result.message && result.message.content) ? result.message.content : '任务执行完成，但未返回内容。';
    task.status = 'done';
    _updateProgress(task, 100, '完成');
  } catch (e) {
    task.status = 'error';
    task.error = e.message;
    task.progress = 100;
    task.progressText = '失败: ' + e.message;
  } finally {
    task.completedAt = Date.now();
    delete _running[task.id];
    _completed.unshift(task);
    if (_completed.length > MAX_HISTORY) _completed.pop();
    _dbUpdateStatus(task);
    if (task.parentTaskId) _checkSubtaskAggregation(task.parentTaskId);
    if (task.notifyOnComplete) _notifyComplete(task);
    _processQueue();
  }
}

// ===== 并行子任务 =====
function createSubtasks(parentTaskId, subtaskPrompts) {
  if (!parentTaskId || !subtaskPrompts || !Array.isArray(subtaskPrompts) || subtaskPrompts.length === 0)
    return { success: false, error: '需要 parentTaskId 和 subtaskPrompts 数组' };
  if (subtaskPrompts.length > 5) return { success: false, error: '最多 5 个并行子任务' };
  var ids = [];
  subtaskPrompts.forEach(function(prompt, i) {
    var r = createTask({
      prompt: typeof prompt === 'string' ? prompt : prompt.prompt,
      title: (typeof prompt === 'object' && prompt.title) ? prompt.title : ('子任务 ' + (i + 1)),
      parentTaskId: parentTaskId, notify: false,
    });
    if (r.success) ids.push(r.taskId);
  });
  return { success: true, subtaskIds: ids, count: ids.length };
}

function _checkSubtaskAggregation(parentTaskId) {
  if (!Core.db || Core.db._backend !== 'sqlite') return;
  try {
    var children = Core.db.query("SELECT id, status, result, error FROM tasks WHERE parent_task_id = ?", [parentTaskId]);
    if (!children || children.length === 0) return;
    var allDone = children.every(function(c) { return c.status === 'done' || c.status === 'error'; });
    if (!allDone) return;
    var aggregated = children.map(function(c, i) {
      return '【子任务 ' + (i + 1) + '】' + (c.status === 'done' ? (c.result || '').substring(0, 1000) : '失败: ' + c.error);
    }).join('\n\n');
    for (var i = 0; i < _completed.length; i++) {
      if (_completed[i].id === parentTaskId) {
        _completed[i].result = (_completed[i].result || '') + '\n\n--- 子任务聚合结果 ---\n' + aggregated;
        _dbUpdateStatus(_completed[i]);
        break;
      }
    }
    console.log('子任务聚合完成: ' + parentTaskId);
  } catch (e) { console.warn('⚠️ [task-queue] 操作失败:', e.message || e); }
}

// ===== 进度更新 =====
function _updateProgress(task, percent, text) {
  task.progress = percent;
  task.progressText = text || '';
  _dbUpdateStatus(task);
}

// ===== 完成通知 =====
function _notifyComplete(task) {
  var title = task.status === 'done' ? '✅ 任务完成' : '❌ 任务失败';
  var body = task.title + (task.status === 'error' ? ' - ' + task.error : '');
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: body });
  } catch (e) { console.warn('⚠️ [task-queue] 操作失败:', e.message || e); }
  if (Core.emit) Core.emit('taskComplete', { taskId: task.id, title: task.title, status: task.status, mode: task.mode });
  console.log(title + ': ' + task.title);
}

// ===== 查询 =====
function getTask(taskId) {
  if (_running[taskId]) return _formatTask(_running[taskId]);
  for (var i = 0; i < _queue.length; i++) { if (_queue[i].id === taskId) return _formatTask(_queue[i]); }
  for (var j = 0; j < _completed.length; j++) { if (_completed[j].id === taskId) return _formatTask(_completed[j]); }
  if (Core.db && Core.db._backend === 'sqlite') {
    try {
      var rows = Core.db.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (rows && rows.length > 0) return _formatTask(rows[0]);
    } catch (e) { console.warn('⚠️ [task-queue] 操作失败:', e.message || e); }
  }
  return null;
}

function listTasks(filter) {
  var all = [];
  _queue.forEach(function(t) { all.push(t); });
  Object.values(_running).forEach(function(t) { all.push(t); });
  _completed.forEach(function(t) { all.push(t); });
  if (filter === 'running') all = all.filter(function(t) { return t.status === 'running'; });
  else if (filter === 'queued') all = all.filter(function(t) { return t.status === 'queued'; });
  else if (filter === 'done') all = all.filter(function(t) { return t.status === 'done' || t.status === 'error'; });
  else if (filter === 'goal') all = all.filter(function(t) { return t.mode === 'goal'; });
  return all.sort(function(a, b) { return b.createdAt - a.createdAt; }).slice(0, 20).map(_formatTask);
}

function _formatTask(task) {
  return {
    id: task.id, title: task.title, status: task.status,
    progress: task.progress, progressText: task.progressText || task.progress_text || '',
    createdAt: task.createdAt || task.created_at,
    startedAt: task.startedAt || task.started_at,
    completedAt: task.completedAt || task.completed_at,
    duration: (task.completedAt || task.completed_at) ? (task.completedAt || task.completed_at) - (task.startedAt || task.started_at) : ((task.startedAt || task.started_at) ? Date.now() - (task.startedAt || task.started_at) : 0),
    hasResult: !!task.result, error: task.error,
    mode: task.mode || 'normal',
    parentTaskId: task.parentTaskId || task.parent_task_id || null,
  };
}

function getTaskResult(taskId) {
  for (var i = 0; i < _completed.length; i++) {
    if (_completed[i].id === taskId) return { success: true, result: _completed[i].result, status: _completed[i].status, error: _completed[i].error };
  }
  if (_running[taskId]) return { success: false, error: '任务仍在执行中', progress: _running[taskId].progress };
  if (Core.db && Core.db._backend === 'sqlite') {
    try {
      var rows = Core.db.query('SELECT result, status, error FROM tasks WHERE id = ?', [taskId]);
      if (rows && rows.length > 0) return { success: true, result: rows[0].result, status: rows[0].status, error: rows[0].error };
    } catch (e) { console.warn('⚠️ [task-queue] 操作失败:', e.message || e); }
  }
  return { success: false, error: '任务不存在' };
}

function cancelTask(taskId) {
  for (var i = 0; i < _queue.length; i++) {
    if (_queue[i].id === taskId) {
      _queue[i].status = 'cancelled';
      _dbUpdateStatus(_queue[i]);
      _queue.splice(i, 1);
      return { success: true, message: '已取消排队中的任务' };
    }
  }
  if (_running[taskId]) return { success: false, error: '运行中的任务暂不支持强制取消' };
  return { success: false, error: '任务不存在' };
}

function setConcurrency(n) {
  if (n >= 1 && n <= 5) { MAX_CONCURRENCY = n; _processQueue(); return { success: true, concurrency: n }; }
  return { success: false, error: '并发数范围 1-5' };
}

// ===== 模块导出 =====
module.exports = {
  name: 'task-queue',
  dependencies: ['api'],
  init: function(_Core) {
    Core = _Core;
    extendDatabase();
    Core.taskQueue = {
      create: createTask, get: getTask, list: listTasks,
      getResult: getTaskResult, cancel: cancelTask,
      setConcurrency: setConcurrency, createSubtasks: createSubtasks,
      getStats: function() {
        return { queued: _queue.length, running: Object.keys(_running).length, completed: _completed.length, maxConcurrency: MAX_CONCURRENCY };
      },
    };
    setTimeout(function() { _restoreFromDB(); }, 3000);
    console.log('Task-Queue 已加载（持久化 + 断点恢复 + 目标模式，并发 ' + MAX_CONCURRENCY + '）');
  }
};
