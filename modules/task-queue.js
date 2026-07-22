// modules/task-queue.js - 后台长任务队列（FIFO + 并发控制 + 进度 + 完成通知）
var Core = null;

// ===== 任务队列状态 =====
var _queue = [];        // 等待中的任务
var _running = {};      // 正在执行的任务 { taskId: task }
var _completed = [];    // 已完成的任务（保留最近 50 条）
var _taskCounter = 0;
var MAX_CONCURRENCY = 2; // 最大并发数
var MAX_HISTORY = 50;

// ===== 创建任务 =====
function createTask(options) {
  if (!options || !options.prompt) {
    return { success: false, error: '缺少 prompt 参数' };
  }

  var taskId = 'task_' + (++_taskCounter) + '_' + Date.now().toString(36);
  var task = {
    id: taskId,
    prompt: options.prompt,
    title: options.title || options.prompt.substring(0, 30),
    status: 'queued',       // queued → running → done/error/cancelled
    progress: 0,            // 0-100
    progressText: '',
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    sessionId: options.sessionId || null, // 关联的会话
    notifyOnComplete: options.notify !== false, // 完成时通知
    _resolve: null,
    _reject: null,
  };

  _queue.push(task);
  _processQueue();

  return { success: true, taskId: taskId, title: task.title };
}

// ===== 队列处理（FIFO + 并发控制）=====
function _processQueue() {
  while (_queue.length > 0 && Object.keys(_running).length < MAX_CONCURRENCY) {
    var task = _queue.shift();
    if (task.status === 'cancelled') continue;
    task.status = 'running';
    task.startedAt = Date.now();
    _running[task.id] = task;
    _executeTask(task);
  }
}

// ===== 执行任务 =====
async function _executeTask(task) {
  try {
    _updateProgress(task, 10, '正在准备执行...');

    if (!Core.api || !Core.api.callAPI) {
      throw new Error('API 模块不可用');
    }

    _updateProgress(task, 20, '正在调用 AI...');

    // 使用 Core.api.callAPI 执行任务（隔离上下文）
    var systemMsg = '你是一个后台任务执行助手。请认真完成用户交代的任务，给出详细结果。';
    var result = await Core.api.callAPI(
      task.prompt,
      systemMsg,
      0.7,
      null, null,
      [{ role: 'system', content: systemMsg }, { role: 'user', content: task.prompt }],
      { disableTools: false }
    );

    _updateProgress(task, 90, '正在整理结果...');

    if (result && result.message && result.message.content) {
      task.result = result.message.content;
      task.status = 'done';
    } else {
      task.result = '任务执行完成，但未返回内容。';
      task.status = 'done';
    }

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

    // 完成通知
    if (task.notifyOnComplete) {
      _notifyComplete(task);
    }

    // 继续处理队列
    _processQueue();
  }
}

// ===== 进度更新 =====
function _updateProgress(task, percent, text) {
  task.progress = percent;
  task.progressText = text || '';
}

// ===== 完成通知（桌面 + 主会话注入）=====
function _notifyComplete(task) {
  var title = task.status === 'done' ? '✅ 任务完成' : '❌ 任务失败';
  var body = task.title + (task.status === 'error' ? ' - ' + task.error : '');

  // 桌面通知
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body: body });
    }
  } catch (e) {}

  // 主会话注入提示（如果有 Core.emit）
  if (Core.emit) {
    Core.emit('taskComplete', { taskId: task.id, title: task.title, status: task.status });
  }

  console.log('📋 ' + title + ': ' + task.title);
}

// ===== 查询任务状态 =====
function getTask(taskId) {
  // 搜索 running + completed + queue
  if (_running[taskId]) return _formatTask(_running[taskId]);
  for (var i = 0; i < _queue.length; i++) {
    if (_queue[i].id === taskId) return _formatTask(_queue[i]);
  }
  for (var j = 0; j < _completed.length; j++) {
    if (_completed[j].id === taskId) return _formatTask(_completed[j]);
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

  return all.sort(function(a, b) { return b.createdAt - a.createdAt; }).slice(0, 20).map(_formatTask);
}

function _formatTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: task.progress,
    progressText: task.progressText,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    duration: task.completedAt ? task.completedAt - task.startedAt : (task.startedAt ? Date.now() - task.startedAt : 0),
    hasResult: !!task.result,
    error: task.error,
  };
}

// ===== 获取任务结果 =====
function getTaskResult(taskId) {
  for (var i = 0; i < _completed.length; i++) {
    if (_completed[i].id === taskId) {
      return { success: true, result: _completed[i].result, status: _completed[i].status, error: _completed[i].error };
    }
  }
  if (_running[taskId]) return { success: false, error: '任务仍在执行中', progress: _running[taskId].progress };
  return { success: false, error: '任务不存在' };
}

// ===== 取消任务 =====
function cancelTask(taskId) {
  // 队列中的直接标记取消
  for (var i = 0; i < _queue.length; i++) {
    if (_queue[i].id === taskId) {
      _queue[i].status = 'cancelled';
      _queue.splice(i, 1);
      return { success: true, message: '已取消排队中的任务' };
    }
  }
  // 运行中的暂不支持强制中断（LLM 调用无法中止）
  if (_running[taskId]) {
    return { success: false, error: '运行中的任务暂不支持强制取消' };
  }
  return { success: false, error: '任务不存在' };
}

// ===== 设置并发数 =====
function setConcurrency(n) {
  if (n >= 1 && n <= 5) {
    MAX_CONCURRENCY = n;
    _processQueue(); // 可能释放更多任务
    return { success: true, concurrency: n };
  }
  return { success: false, error: '并发数范围 1-5' };
}

// ===== 模块导出 =====
module.exports = {
  name: 'task-queue',
  dependencies: ['api'],
  init: function(_Core) {
    Core = _Core;

    Core.taskQueue = {
      create: createTask,
      get: getTask,
      list: listTasks,
      getResult: getTaskResult,
      cancel: cancelTask,
      setConcurrency: setConcurrency,
      getStats: function() {
        return { queued: _queue.length, running: Object.keys(_running).length, completed: _completed.length, maxConcurrency: MAX_CONCURRENCY };
      },
    };

    console.log('✅ Task-Queue 模块已加载（后台长任务队列，并发 ' + MAX_CONCURRENCY + '）');
  }
};
