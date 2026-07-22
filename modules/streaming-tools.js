// modules/streaming-tools.js — Streaming Tool Calls
// 支持工具执行过程中的进度回调和流式结果
var Core = null;

// ===== 流式工具执行器 =====

/**
 * 执行工具并支持进度回调
 * @param {string} action - 工具名称
 * @param {object} params - 工具参数
 * @param {object} options - 选项
 *   options.onProgress: function(progress) - 进度回调
 *     progress: { phase, message, percent?, data? }
 *   options.timeout: number - 超时毫秒数 (default 30000)
 *   options.signal: AbortSignal - 取消信号
 * @returns {object} { success, result, duration, progressLog }
 */
async function executeStreaming(action, params, options) {
  options = options || {};
  var onProgress = options.onProgress || function() {};
  var timeout = options.timeout || 30000;
  var signal = options.signal || null;

  var progressLog = [];
  var startTime = Date.now();

  function reportProgress(phase, message, percent, data) {
    var entry = {
      phase: phase,
      message: message,
      percent: percent !== undefined ? percent : null,
      data: data || null,
      timestamp: Date.now() - startTime,
    };
    progressLog.push(entry);
    try { onProgress(entry); } catch (e) { /* ignore callback errors */ }
  }

  // Phase 1: 初始化
  reportProgress('init', '正在初始化 ' + action + '...', 0);

  // 检查取消
  if (signal && signal.aborted) {
    return { success: false, result: '已取消', duration: Date.now() - startTime, progressLog: progressLog, cancelled: true };
  }

  // Phase 2: 执行
  reportProgress('executing', '正在执行 ' + action + '...', 20);

  var result;
  var timedOut = false;
  var timeoutId;

  try {
    var execPromise;
    if (Core.agentLoop && Core.agentLoop.executeAgentAction) {
      execPromise = Core.agentLoop.executeAgentAction(action, params || {});
    } else {
      return { success: false, result: 'Agent 引擎未就绪', duration: 0, progressLog: progressLog };
    }

    // 超时竞赛
    var timeoutPromise = new Promise(function(_, reject) {
      timeoutId = setTimeout(function() {
        timedOut = true;
        reject(new Error('工具执行超时 (' + timeout + 'ms)'));
      }, timeout);
    });

    // 取消竞赛
    if (signal) {
      var cancelPromise = new Promise(function(_, reject) {
        signal.addEventListener('abort', function() {
          reject(new Error('已取消'));
        }, { once: true });
      });
      result = await Promise.race([execPromise, timeoutPromise, cancelPromise]);
    } else {
      result = await Promise.race([execPromise, timeoutPromise]);
    }
    clearTimeout(timeoutId);

    // Phase 3: 处理结果
    reportProgress('processing', '处理结果...', 80);
    var resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // 检测工具执行错误（复用 agent-loop 的 detectToolError 前缀判定，与 agent-loop.js 保持一致）
    var isToolError = (Core.agentLoop && Core.agentLoop.detectToolError)
      ? Core.agentLoop.detectToolError(resultStr)
      : false;

    // Phase 4: 完成
    reportProgress('complete', isToolError ? '执行完成（有错误）' : '执行完成', 100, { resultLength: resultStr.length });

    return {
      success: !isToolError,
      result: resultStr,
      duration: Date.now() - startTime,
      progressLog: progressLog,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    var isCancelled = signal && signal.aborted;
    var phase = timedOut ? 'timeout' : (isCancelled ? 'cancelled' : 'error');
    reportProgress(phase, e.message, -1);

    return {
      success: false,
      result: e.message,
      duration: Date.now() - startTime,
      progressLog: progressLog,
      cancelled: isCancelled,
      timedOut: timedOut,
    };
  }
}

// ===== 批量流式执行 =====

/**
 * 批量执行多个工具，每个工具支持进度回调
 * @param {Array} tasks - [{ action, params }]
 * @param {object} options - { onProgress, onTaskComplete, concurrency, timeout }
 * @returns {object} { results, totalDuration, summary }
 */
async function executeBatchStreaming(tasks, options) {
  options = options || {};
  var onProgress = options.onProgress || function() {};
  var onTaskComplete = options.onTaskComplete || function() {};
  var concurrency = Math.min(options.concurrency || 3, tasks.length);
  var timeout = options.timeout || 30000;

  var results = [];
  var startTime = Date.now();
  var completed = 0;
  var taskIndex = 0;

  async function worker() {
    while (taskIndex < tasks.length) {
      var idx = taskIndex++;
      var task = tasks[idx];

      var taskResult = await executeStreaming(task.action, task.params || {}, {
        onProgress: function(p) {
          onProgress({
            taskIndex: idx,
            action: task.action,
            phase: p.phase,
            message: p.message,
            percent: p.percent,
          });
        },
        timeout: timeout,
      });

      results[idx] = {
        action: task.action,
        success: taskResult.success,
        result: taskResult.result,
        duration: taskResult.duration,
      };

      completed++;
      onTaskComplete(idx, task.action, taskResult, completed + '/' + tasks.length);
    }
  }

  // 启动并发 workers
  var workers = [];
  for (var i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  var successCount = results.filter(function(r) { return r && r.success; }).length;

  return {
    results: results,
    totalDuration: Date.now() - startTime,
    summary: {
      total: tasks.length,
      success: successCount,
      failed: tasks.length - successCount,
    },
  };
}

// ===== 管道式工具链 =====

/**
 * 顺序执行工具链，前一个工具的结果传递给下一个
 * @param {Array} chain - [{ action, params, transform? }]
 *   transform: function(prevResult) => newParams
 * @param {object} options - { onStepComplete, timeout }
 */
async function executePipeline(chain, options) {
  options = options || {};
  var onStepComplete = options.onStepComplete || function() {};
  var timeout = options.timeout || 30000;

  var prevResult = null;
  var pipelineLog = [];
  var startTime = Date.now();

  for (var i = 0; i < chain.length; i++) {
    var step = chain[i];
    var params = step.params || {};

    // 如果有 transform 函数，用前一步结果生成参数
    if (typeof step.transform === 'function' && prevResult !== null) {
      try {
        var transformed = step.transform(prevResult);
        if (typeof transformed === 'object') params = { ...params, ...transformed };
      } catch (e) {
        console.warn('[pipeline] transform failed at step ' + i + ':', e.message);
      }
    }

    var stepResult = await executeStreaming(step.action, params, { timeout: timeout });
    pipelineLog.push({
      step: i,
      action: step.action,
      success: stepResult.success,
      result: stepResult.result.substring(0, 300),
      duration: stepResult.duration,
    });

    onStepComplete(i, step.action, stepResult);

    if (!stepResult.success && !step.continueOnError) {
      return {
        success: false,
        failedAt: i,
        result: stepResult.result,
        pipelineLog: pipelineLog,
        totalDuration: Date.now() - startTime,
      };
    }

    prevResult = stepResult.result;
  }

  return {
    success: true,
    result: prevResult,
    pipelineLog: pipelineLog,
    totalDuration: Date.now() - startTime,
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'streaming-tools',
  dependencies: ['agent-loop'],
  init: function(_Core) {
    Core = _Core;
    Core.streamingTools = {
      executeStreaming: executeStreaming,
      executeBatchStreaming: executeBatchStreaming,
      executePipeline: executePipeline,
    };

    // 注册命令
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/st', 'Streaming Tools 诊断', function() {
        return '🔄 Streaming Tools 模块已加载\n' +
          '功能: executeStreaming, executeBatchStreaming, executePipeline\n' +
          '用法: 在 Agent 模式下自动使用';
      }, false);
    }

    console.log('✅ Streaming Tools 模块已加载');
  },
};
