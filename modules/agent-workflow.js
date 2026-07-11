// modules/agent-workflow.js — Agent 状态机工作流引擎
// LangGraph-style: THINK → ACT → OBSERVE → THINK (loop) | → COMPLETE | → ERROR
var Core = null;

// ===== 状态定义 =====
var States = Object.freeze({
  INIT:     'INIT',
  THINK:    'THINK',
  ACT:      'ACT',
  OBSERVE:  'OBSERVE',
  COMPLETE: 'COMPLETE',
  ERROR:    'ERROR',
});

// ===== 状态转换表 =====
var Transitions = Object.freeze({
  INIT:     { next: ['THINK'] },
  THINK:    { next: ['ACT', 'COMPLETE', 'ERROR'] },
  ACT:      { next: ['OBSERVE', 'ERROR', 'THINK'] },
  OBSERVE:  { next: ['THINK', 'COMPLETE', 'ERROR'] },
  COMPLETE: { next: [] },
  ERROR:    { next: ['THINK', 'COMPLETE'] },
});

function validateTransition(fromState, toState) {
  var allowed = Transitions[fromState];
  if (!allowed) return false;
  return allowed.next.indexOf(toState) !== -1;
}

// ===== 机器上下文 =====
function createMachineContext(task, config) {
  config = config || {};
  return {
    task: task,
    isDeepThink: config.isDeepThink || false,
    maxSteps: config.isDeepThink ? 20 : 12,
    step: 0,
    context: '',
    stepsLog: [],
    finalAnswer: '',
    cancelled: false,
    cancelCheck: config.cancelCheck || function() { return false; },
    consecutiveErrors: 0,
    maxRetries: config.maxRetries || 2,
    stepStartTimes: {},
    startTime: Date.now(),
    onStateChange: config.onStateChange || function() {},
    onStepStart: config.onStepStart || function() {},
    onStepComplete: config.onStepComplete || function() {},
    onToolError: config.onToolError || function() {},
    _pendingAction: null,
    _toolResult: null,
    _toolAction: null,
    _lastError: null,
  };
}

// ===== 状态处理器 =====

// INIT: 检查前置条件
async function handleInit(ctx) {
  if (!Core.agentLoop || !Core.agentLoop.executeAgentAction) {
    ctx.finalAnswer = '❌ Agent 引擎未就绪';
    return { nextState: States.COMPLETE, ctx: ctx };
  }
  if (!Core.api || !Core.api.callAPI) {
    ctx.finalAnswer = '❌ API 模块未就绪';
    return { nextState: States.COMPLETE, ctx: ctx };
  }
  return { nextState: States.THINK, ctx: ctx };
}

// THINK: LLM 决策下一步行动
async function handleThink(ctx) {
  ctx.step++;
  if (ctx.cancelCheck()) { ctx.cancelled = true; }
  if (ctx.cancelled) {
    ctx.finalAnswer = '⏹ 任务已被取消。已执行 ' + ctx.step + ' 步。';
    return { nextState: States.COMPLETE, ctx: ctx };
  }
  if (ctx.step > ctx.maxSteps) {
    ctx.finalAnswer = 'Agent 已达到最大步数限制，任务未能完成。';
    return { nextState: States.COMPLETE, ctx: ctx };
  }

  ctx.stepStartTimes[ctx.step] = Date.now();
  ctx.onStepStart(ctx.step, 'THINK');

  var prompt = '任务：' + ctx.task + '\n\n历史执行记录：' + (ctx.context || '（无）') + '\n\n请决定下一步行动。注意：只输出纯JSON，不要有任何其他文字。';

  var reply = '';
  try {
    var agentPrompt = Core.agentLoop.AGENT_SYSTEM_PROMPT || '';
    if (Core.projectContext && Core.projectContext.hasContext && Core.projectContext.hasContext()) {
      var pCtx = Core.projectContext.getContextString();
      if (pCtx) agentPrompt += pCtx;
    }
    if (Core.memoryEnhance && Core.memoryEnhance.getEnhancedContext) {
      var memCtx = Core.memoryEnhance.getEnhancedContext(ctx.task);
      if (memCtx) agentPrompt += '\n\n' + memCtx;
    }
    var data = await Core.api.callAPI(prompt, agentPrompt, 0.7, null, 'ollama');
    reply = (data.message && data.message.content) || data.response || '';
  } catch (err) {
    ctx._lastError = err;
    return { nextState: States.ERROR, ctx: ctx };
  }

  var action = Core.agentLoop.extractJSONFromText(reply);

  if (!action || !action.action) {
    var chineseMatch = reply.match(/[一-龥 －〿＀-￯].{10,}/);
    if (chineseMatch) {
      ctx.finalAnswer = chineseMatch[0];
    } else {
      var answerMatch = reply.match(/"answer"\s*:\s*"([^"]{5,})"/);
      if (answerMatch) {
        ctx.finalAnswer = answerMatch[1];
      } else {
        ctx.finalAnswer = '抱歉，AI 返回的格式不正确，无法解析结果。请重试。';
      }
    }
    return { nextState: States.COMPLETE, ctx: ctx };
  }

  if (action.action === 'complete') {
    var answer = '';
    if (action.params) {
      answer = action.params.answer || action.params.result || action.params.content || '';
    }
    if (!answer && action.answer) answer = action.answer;
    if (!answer && action.result) answer = action.result;
    ctx.finalAnswer = answer || reply;
    return { nextState: States.COMPLETE, ctx: ctx };
  }

  ctx._pendingAction = action;
  return { nextState: States.ACT, ctx: ctx };
}

// ACT: 执行工具
async function handleAct(ctx) {
  var action = ctx._pendingAction;
  if (!action) {
    ctx._lastError = new Error('ACT 状态无待执行动作');
    return { nextState: States.ERROR, ctx: ctx };
  }

  // ask_user: 特殊处理，直接回到 THINK
  if (action.action === 'ask_user' && action.params && Core.askUser && typeof Core.askUser.ask === 'function') {
    try {
      var askResult = await Core.askUser.ask({
        question: action.params.question || action.params.text || '请选择',
        options: Array.isArray(action.params.options) ? action.params.options : [],
        multiSelect: !!action.params.multiSelect,
        header: action.params.header || ''
      });
      var formattedAnswer = Core.askUser.formatAnswer ? Core.askUser.formatAnswer(askResult) : String(askResult);
      ctx.context += '\n[步骤' + ctx.step + '] 向用户提问: ' + (action.params.question || '') + '\n用户回答: ' + formattedAnswer;
      ctx.stepsLog.push({ step: ctx.step, action: 'ask_user', params: action.params, result: formattedAnswer, time: Date.now() - (ctx.stepStartTimes[ctx.step] || Date.now()), success: true });
      ctx.onStepComplete(ctx.step, 'ask_user', true);
    } catch (e) {
      ctx.context += '\n[步骤' + ctx.step + '] ask_user 失败: ' + e.message;
    }
    return { nextState: States.THINK, ctx: ctx };
  }

  // parallel_execute: 并行执行
  if (action.action === 'parallel_execute' && action.params && Array.isArray(action.params.tasks)) {
    var tasks = action.params.tasks;
    var combinedResult = '';
    try {
      var promises = tasks.map(function(subtask) {
        return Core.agentLoop.executeAgentAction(subtask.action, subtask.params || {}).catch(function(e) { return '错误: ' + e.message; });
      });
      var parallelResults = await Promise.all(promises);
      tasks.forEach(function(subtask, idx) {
        combinedResult += '\n--- 子任务 ' + (idx + 1) + ': ' + subtask.action + ' ---\n';
        combinedResult += (parallelResults[idx] || '无结果').substring(0, 400) + '\n';
      });
      ctx.context += '\n[步骤' + ctx.step + '] 并行执行 ' + tasks.length + ' 个子任务\n' + combinedResult.substring(0, 600);
      ctx.stepsLog.push({ step: ctx.step, action: 'parallel_execute', params: action.params, result: combinedResult.substring(0, 500), time: Date.now() - (ctx.stepStartTimes[ctx.step] || Date.now()), success: true });
      ctx.onStepComplete(ctx.step, 'parallel_execute', true);
    } catch (e) {
      ctx._lastError = e;
      return { nextState: States.ERROR, ctx: ctx };
    }
    return { nextState: States.THINK, ctx: ctx };
  }

  // 标准工具执行
  ctx.onStepStart(ctx.step, 'ACT', action.action);
  try {
    var toolResult = await Core.agentLoop.executeAgentAction(action.action, action.params || {});
    ctx._toolResult = toolResult;
    ctx._toolAction = action;
    return { nextState: States.OBSERVE, ctx: ctx };
  } catch (e) {
    ctx._lastError = e;
    return { nextState: States.ERROR, ctx: ctx };
  }
}

// OBSERVE: 处理工具结果，检测错误，更新上下文
async function handleObserve(ctx) {
  var toolResult = ctx._toolResult;
  var action = ctx._toolAction;
  var toolResultStr = (toolResult == null) ? '' : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult));

  // 错误检测
  var isToolError = false;
  var errorPatterns = ['❌', '错误', 'error', 'failed', '失败', '未找到', 'not found', 'ENOENT', 'EACCES', 'permission denied', 'timeout', '超时', '无法', 'cannot'];
  var lowerResult = toolResultStr.toLowerCase();
  isToolError = errorPatterns.some(function(p) { return lowerResult.indexOf(p.toLowerCase()) !== -1; });

  var resultForContext = toolResultStr;
  if (isToolError) {
    ctx.consecutiveErrors++;
    var correctionHint = '\n⚠️ [自动纠错提示] 工具 "' + action.action + '" 执行失败。请分析错误原因并尝试：\n1. 修正参数后重试\n2. 使用不同工具\n3. 使用 run_python 编写脚本\n请勿用相同参数重复调用 ' + action.action + '。';
    resultForContext = toolResultStr + correctionHint;
    ctx.onToolError(ctx.step, action.action, toolResultStr);
  } else {
    ctx.consecutiveErrors = 0;
  }

  var stepRecord = '[步骤' + ctx.step + '] 执行 ' + action.action + ': ' + JSON.stringify(action.params || {}) + '\n结果: ' + resultForContext.substring(0, 300);
  ctx.context += '\n' + stepRecord;

  ctx.stepsLog.push({
    step: ctx.step,
    action: action.action,
    params: action.params,
    result: toolResultStr.substring(0, 500),
    time: Date.now() - (ctx.stepStartTimes[ctx.step] || Date.now()),
    success: !isToolError,
  });

  ctx.onStepComplete(ctx.step, action.action, !isToolError);

  if (ctx.consecutiveErrors >= ctx.maxRetries) {
    ctx._lastError = new Error('连续 ' + ctx.consecutiveErrors + ' 次工具失败');
    return { nextState: States.ERROR, ctx: ctx };
  }

  return { nextState: States.THINK, ctx: ctx };
}

// COMPLETE: 清理最终回答 + 质量评估重试
async function handleComplete(ctx) {
  if (Core.agentLoop && Core.agentLoop.cleanFinalAnswer) {
    ctx.finalAnswer = Core.agentLoop.cleanFinalAnswer(ctx.finalAnswer);
  }

  // Evaluator-Optimizer
  if (Core.agentLoop && Core.agentLoop.evaluateAnswer) {
    var evalResult = Core.agentLoop.evaluateAnswer(ctx.finalAnswer);
    if (!evalResult.pass && ctx.step < ctx.maxSteps - 1 && !ctx.cancelled) {
      console.log('[StateMachine self-eval] ' + evalResult.reason + ', retrying');
      try {
        var retryPrompt = 'task: ' + ctx.task + '\n\nhistory: ' + (ctx.context || '(none)') + '\n\n[system-eval] your previous answer failed: ' + evalResult.reason + '. give a high-quality final answer using the complete action.';
        var retryData = await Core.api.callAPI(retryPrompt, Core.agentLoop.AGENT_SYSTEM_PROMPT || '', 0.7, null, 'ollama');
        var retryReply = (retryData.message && retryData.message.content) || retryData.response || '';
        var retryAction = Core.agentLoop.extractJSONFromText(retryReply);
        if (retryAction && retryAction.action === 'complete') {
          var retryAnswer = (retryAction.params && (retryAction.params.answer || retryAction.params.result || retryAction.params.content)) || retryReply;
          var cleaned = Core.agentLoop.cleanFinalAnswer(retryAnswer);
          if (Core.agentLoop.evaluateAnswer(cleaned).pass) {
            ctx.finalAnswer = cleaned;
            console.log('[StateMachine self-eval] retry succeeded');
          }
        }
      } catch (e) {
        console.warn('[StateMachine self-eval] retry failed: ' + e.message);
      }
    }
  }

  return { nextState: null, ctx: ctx };
}

// ERROR: 处理失败，决定重试或放弃
async function handleError(ctx) {
  var err = ctx._lastError;

  // 利用 error-recovery 模块获取重试建议
  var advice = null;
  if (Core.recovery && Core.recovery.getRetryAdvice) {
    advice = Core.recovery.getRetryAdvice(err, 'ollama');
  }

  var canRetry = ctx.step < ctx.maxSteps && !ctx.cancelled;
  if (advice && advice.canRetry === false) canRetry = false;

  if (canRetry) {
    console.warn('[StateMachine ERROR] retrying step ' + ctx.step + ': ' + (err ? err.message : 'unknown'));
    ctx.context += '\n[步骤' + ctx.step + '] ❌ 错误: ' + (err ? err.message : '未知错误');
    if (advice && advice.suggestions && advice.suggestions.length > 0) {
      ctx.context += '\n建议: ' + advice.suggestions.join('; ');
    }
    ctx._lastError = null;
    return { nextState: States.THINK, ctx: ctx };
  }

  // 无法重试，生成错误回答
  ctx.finalAnswer = '❌ Agent 执行出错：' + (err ? err.message : '未知错误');
  if (advice && advice.suggestions && advice.suggestions.length > 0) {
    ctx.finalAnswer += '\n\n建议：\n' + advice.suggestions.map(function(s) { return '- ' + s; }).join('\n');
  }
  return { nextState: States.COMPLETE, ctx: ctx };
}

// ===== 机器运行器 =====

function createMachine(task, config) {
  var ctx = createMachineContext(task, config || {});
  return { state: States.INIT, ctx: ctx };
}

async function runMachine(machine) {
  var handlers = {};
  handlers[States.INIT]     = handleInit;
  handlers[States.THINK]    = handleThink;
  handlers[States.ACT]      = handleAct;
  handlers[States.OBSERVE]  = handleObserve;
  handlers[States.COMPLETE] = handleComplete;
  handlers[States.ERROR]    = handleError;

  var currentState = machine.state;
  var ctx = machine.ctx;
  var transitionLog = [];

  while (currentState !== null) {
    var handler = handlers[currentState];
    if (!handler) {
      console.error('[StateMachine] No handler for state: ' + currentState);
      break;
    }

    var result = await handler(ctx);
    var nextState = result.nextState;
    ctx = result.ctx;

    transitionLog.push({ from: currentState, to: nextState, step: ctx.step, time: Date.now() });

    if (nextState && !validateTransition(currentState, nextState)) {
      console.error('[StateMachine] Invalid transition: ' + currentState + ' → ' + nextState);
      nextState = States.ERROR;
    }

    ctx.onStateChange(currentState, nextState, ctx);
    currentState = nextState;
  }

  return {
    success: true,
    reply: ctx.finalAnswer || '',
    steps: ctx.step,
    stepsLog: ctx.stepsLog,
    transitionLog: transitionLog,
    totalTime: Date.now() - ctx.startTime,
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'agent-workflow',
  dependencies: ['agent-loop'],
  init: function(_Core) {
    Core = _Core;
    Core.workflow = Core.workflow || {};
    Core.workflow.stateMachine = {
      createMachine: createMachine,
      runMachine: runMachine,
      States: States,
      Transitions: Transitions,
      validateTransition: validateTransition,
    };
    // 诊断命令
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/sm', '查看 Agent 状态机配置', function() {
        var lines = ['🔄 Agent 状态机'];
        lines.push('状态: ' + Object.keys(States).join(', '));
        lines.push('');
        for (var s in Transitions) {
          lines.push('  ' + s + ' → ' + Transitions[s].next.join(', '));
        }
        return lines.join('\n');
      }, false);
    }
    console.log('✅ Agent 状态机工作流模块已加载');
  },
};
