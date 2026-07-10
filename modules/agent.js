// modules/agent.js - Agent 智能体辅助模块
// 🔧 重构：统一委托给 api.js 的 sendToAgent() 实现，消除重复实现冲突
// 本模块提供：Agent 状态管理、运行历史、工具描述生成、ReAct 解析（备用）

let Core = null;

const MAX_STEPS = 12; // 普通模式 12 步，深度思考模式 20 步（在 api.js sendToAgent 中动态决定）

// Agent 运行状态跟踪
const agentState = {
  isRunning: false,
  currentStep: 0,
  maxSteps: MAX_STEPS,
  history: [], // 最近 20 次 Agent 运行记录
};

// ===== 获取可用工具描述（供提示词构建使用）=====
function getToolsDescription() {
  if (!Core.toolsRegistry || typeof Core.toolsRegistry.getToolDefinitions !== 'function') {
    return '（无可用工具）';
  }
  const defs = Core.toolsRegistry.getToolDefinitions();
  return defs.map(d => {
    const name = d.function.name;
    const desc = d.function.description || '无描述';
    const params = d.function.parameters ? JSON.stringify(d.function.parameters) : '{}';
    return `- ${name}: ${desc}，参数：${params}`;
  }).join('\n');
}

// ===== 运行 Agent（委托给 api.js 的 sendToAgent 实现）=====
async function runAgent(task, customSystemPrompt = '') {
  if (!Core.api || !Core.api.sendToAgent) {
    return '❌ Agent 引擎未就绪，请检查 api 模块是否加载';
  }

  // 更新状态
  agentState.isRunning = true;
  agentState.currentStep = 0;

  try {
    const isDeepThink = customSystemPrompt.includes('深度思考');
    const result = await Core.api.sendToAgent(task, isDeepThink);

    // 记录运行历史
    agentState.history.unshift({
      task: task.substring(0, 100),
      steps: result.steps || 0,
      success: result.success,
      timestamp: Date.now(),
    });
    // 只保留最近 20 条
    if (agentState.history.length > 20) {
      agentState.history.length = 20;
    }

    return result.reply || 'Agent 未返回结果';
  } catch (err) {
    return '❌ Agent 执行出错：' + err.message;
  } finally {
    agentState.isRunning = false;
  }
}

// ===== Agent 状态查询 =====
function getStatus() {
  return {
    isRunning: agentState.isRunning,
    currentStep: agentState.currentStep,
    maxSteps: agentState.maxSteps,
    historyCount: agentState.history.length,
    availableTools: Core.toolsRegistry ? Core.toolsRegistry.listTools() : [],
  };
}

// ===== 获取运行历史 =====
function getHistory(limit = 10) {
  return agentState.history.slice(0, limit);
}

// ===== 清除历史 =====
function clearHistory() {
  agentState.history = [];
}

// ===== ReAct 风格输出解析（备用，供外部工具调用场景使用）=====
function parseReActOutput(text) {
  if (!text || typeof text !== 'string') {
    return { action: 'FINAL_ANSWER', content: text || '' };
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  let reasoning = '';
  let action = 'FINAL_ANSWER';
  let finalAnswer = '';
  let toolName = '';
  let params = {};

  for (const line of lines) {
    if (line.startsWith('推理：') || line.startsWith('Reasoning:')) {
      reasoning = line.replace(/^(推理：|Reasoning:)\s*/, '');
    } else if (line.startsWith('ACTION:')) {
      const parts = line.replace('ACTION:', '').trim().split('|');
      if (parts.length >= 1) {
        toolName = parts[0].trim();
        if (parts.length >= 2) {
          try {
            params = JSON.parse(parts[1].replace('PARAMS:', '').trim());
          } catch (e) {
            try {
              params = JSON.parse(parts[1].replace('PARAMS:', '').trim().replace(/'/g, '"'));
            } catch (e2) {
              params = {};
            }
          }
        }
        action = 'ACTION';
      }
    } else if (line.startsWith('FINAL_ANSWER:')) {
      finalAnswer = line.replace('FINAL_ANSWER:', '').trim();
      action = 'FINAL_ANSWER';
    }
  }

  if (!finalAnswer && action !== 'ACTION') {
    finalAnswer = text;
    action = 'FINAL_ANSWER';
  }

  return { action, toolName, params, finalAnswer, reasoning };
}

// ===== Phase 5-3: 高级 Agent 增强 =====

// ----- 5a: 多步任务规划 (Plan-then-Execute) -----
async function planAndExecute(task, options) {
  options = options || {};
  var maxPlanningSteps = options.maxPlanningSteps || 5;
  var reflectionEnabled = options.reflection !== false;

  // Step 1: 让 AI 生成执行计划
  var planPrompt = '你是一个任务规划专家。请将以下复杂任务分解为可执行的步骤计划。\n\n' +
    '任务：' + task + '\n\n' +
    '要求：\n' +
    '1. 每个步骤应该是一个独立可执行的子任务\n' +
    '2. 步骤之间可以有依赖关系\n' +
    '3. 最多 ' + maxPlanningSteps + ' 个步骤\n' +
    '4. 以 JSON 数组格式输出计划，每个元素包含：step(步骤号)、action(动作描述)、dependsOn(依赖的步骤号数组)\n\n' +
    '输出格式：\n```json\n[{"step":1,"action":"...","dependsOn":[]},{"step":2,"action":"...","dependsOn":[1]}]\n```';

  agentState.isRunning = true;
  agentState.currentStep = 0;

  try {
    // 调用 API 生成计划
    var planResult = await Core.api.callAPI(planPrompt, '你是一个任务规划助手', 0.3);
    var planText = planResult.message ? planResult.message.content : '';

    // 解析计划
    var plan = parsePlan(planText);
    if (!plan || plan.length === 0) {
      // 无法解析计划，退回到普通 Agent 执行
      return await runAgent(task);
    }

    var results = [];
    var context = { task: task, plan: plan, results: [] };

    // Step 2: 按依赖关系顺序执行
    for (var i = 0; i < plan.length; i++) {
      agentState.currentStep = i + 1;
      var step = plan[i];

      // 收集依赖步骤的结果
      var depContext = '';
      if (step.dependsOn && step.dependsOn.length > 0) {
        depContext = step.dependsOn.map(function(depIdx) {
          var r = results.find(function(x) { return x.step === depIdx; });
          return r ? '步骤 ' + depIdx + ' 结果: ' + r.output.substring(0, 500) : '';
        }).filter(Boolean).join('\n');
      }

      var stepPrompt = '你正在执行一个多步任务的第 ' + step.step + ' 步。\n\n' +
        '总体任务：' + task + '\n' +
        '当前步骤：' + step.action + '\n' +
        (depContext ? '\n前序步骤结果：\n' + depContext + '\n' : '') +
        '\n请执行当前步骤并给出结果。';

      var stepResult = await Core.api.callAPI(stepPrompt, '你是一个任务执行助手', 0.5);
      var stepOutput = stepResult.message ? stepResult.message.content : '';

      results.push({ step: step.step, action: step.action, output: stepOutput, success: true });
      context.results = results;
      console.log('✅ 步骤 ' + step.step + '/' + plan.length + ' 完成');
    }

    // Step 3: 自我反思 — 评估结果
    var finalOutput = '';
    if (reflectionEnabled) {
      finalOutput = await selfReflect(task, results);
    } else {
      finalOutput = results.map(function(r) {
        return '**步骤 ' + r.step + ': ' + r.action + '**\n' + r.output;
      }).join('\n\n---\n\n');
    }

    // 记录历史
    agentState.history.unshift({
      task: task.substring(0, 100),
      steps: plan.length,
      success: true,
      mode: 'plan-execute',
      timestamp: Date.now(),
    });
    if (agentState.history.length > 20) agentState.history.length = 20;

    return finalOutput;
  } catch (err) {
    return '❌ 计划执行出错：' + err.message;
  } finally {
    agentState.isRunning = false;
    agentState.currentStep = 0;
  }
}

function parsePlan(text) {
  try {
    // 提取 JSON 块
    var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      var parsed = JSON.parse(jsonMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    }
    // 尝试直接解析
    var parsed2 = JSON.parse(text.trim());
    if (Array.isArray(parsed2)) return parsed2;
  } catch (e) {}
  return null;
}

// ----- 5b: 自我反思 (Self-Reflection) -----
async function selfReflect(originalTask, stepResults) {
  var resultsSummary = stepResults.map(function(r) {
    return '步骤 ' + r.step + ' (' + r.action + '): ' + r.output.substring(0, 300);
  }).join('\n\n');

  var reflectPrompt = '你是一个任务评估专家。请评估以下多步任务的执行结果。\n\n' +
    '原始任务：' + originalTask + '\n\n' +
    '各步骤执行结果：\n' + resultsSummary + '\n\n' +
    '请给出：\n' +
    '1. 任务是否成功完成（是/否/部分完成）\n' +
    '2. 结果质量评分（1-10）\n' +
    '3. 综合总结（合并所有步骤结果为最终答案）\n' +
    '4. 如果有未解决的问题，列出建议\n\n' +
    '输出格式：\n' +
    '状态: [完成/部分完成/未完成]\n' +
    '评分: [1-10]\n' +
    '总结: [综合结果]\n' +
    '建议: [改进建议，如有]';

  try {
    var reflectResult = await Core.api.callAPI(reflectPrompt, '你是一个任务评估专家', 0.3);
    return reflectResult.message ? reflectResult.message.content : resultsSummary;
  } catch (e) {
    // 反思失败，返回原始结果汇总
    return resultsSummary;
  }
}

// ----- 5c: 子任务编排 (Parallel Sub-Agent Orchestration) -----
async function orchestrateSubtasks(task, subtasks) {
  if (!subtasks || subtasks.length === 0) {
    return await runAgent(task);
  }

  agentState.isRunning = true;
  var results = [];
  var maxConcurrency = 3; // 最多3个并行子任务


  // 分批并行执行
  for (var batch = 0; batch < subtasks.length; batch += maxConcurrency) {
    var batchTasks = subtasks.slice(batch, batch + maxConcurrency);
    var promises = batchTasks.map(function(subtask, idx) {
      var taskIdx = batch + idx;
      return Core.api.callAPI(
        '你是子任务执行者。请完成以下子任务：\n\n总体任务背景：' + task + '\n\n子任务 ' + (taskIdx + 1) + '：' + subtask,
        '你是一个精确的任务执行助手',
        0.5
      ).then(function(result) {
        var output = result.message ? result.message.content : '';
        return { index: taskIdx, subtask: subtask, output: output, success: true };
      }).catch(function(err) {
        return { index: taskIdx, subtask: subtask, output: '❌ ' + err.message, success: false };
      });
    });

    var batchResults = await Promise.all(promises);
    results = results.concat(batchResults);
    console.log('✅ 批次 ' + (Math.floor(batch / maxConcurrency) + 1) + ' 完成 (' + batchResults.length + ' 个子任务)');
  }

  // 合并结果
  var mergedPrompt = '请将以下子任务结果合并为一个完整的最终回答。\n\n' +
    '原始任务：' + task + '\n\n' +
    results.map(function(r) {
      return '子任务 ' + (r.index + 1) + ' (' + r.subtask.substring(0, 50) + '):\n' + r.output;
    }).join('\n\n---\n\n') +
    '\n\n请综合所有子任务结果，给出最终的完整回答。';

  try {
    var finalResult = await Core.api.callAPI(mergedPrompt, '你是一个结果综合专家', 0.3);
    var finalOutput = finalResult.message ? finalResult.message.content : '';

    agentState.history.unshift({
      task: task.substring(0, 100),
      steps: subtasks.length,
      success: results.every(function(r) { return r.success; }),
      mode: 'orchestrated',
      timestamp: Date.now(),
    });
    if (agentState.history.length > 20) agentState.history.length = 20;

    return finalOutput;
  } catch (e) {
    return results.map(function(r) {
      return '**子任务 ' + (r.index + 1) + ':** ' + r.output;
    }).join('\n\n');
  } finally {
    agentState.isRunning = false;
  }
}

// ----- 5d: 代码执行沙盒 (Code Execution Sandbox) -----
function executeCode(code, language) {
  language = language || 'javascript';
  if (language !== 'javascript' && language !== 'js') {
    return { error: '仅支持 JavaScript 代码执行，当前语言: ' + language };
  }

  try {
    var vm = require('vm');
    var output = [];
    var sandbox = {
      console: {
        log: function() { output.push(Array.from(arguments).map(String).join(' ')); },
        warn: function() { output.push('WARN: ' + Array.from(arguments).map(String).join(' ')); },
        error: function() { output.push('ERROR: ' + Array.from(arguments).map(String).join(' ')); },
      },
      Math: Math, Date: Date, JSON: JSON,
      parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
      Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
      RegExp: RegExp, Error: Error, Map: Map, Set: Set, Promise: Promise,
      encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
      setTimeout: undefined, setInterval: undefined, setImmediate: undefined,
    };

    var context = vm.createContext(sandbox);
    var script = new vm.Script(code, { timeout: 10000 }); // 10秒超时
    var result = script.runInContext(context);

    return {
      success: true,
      result: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
      output: output.join('\n'),
      language: 'javascript'
    };
  } catch (err) {
    return { success: false, error: err.message, language: 'javascript' };
  }
}

// ----- 5e: /plan 和 /orchestrate 命令 -----
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('/plan', function(args) {
    if (!args || !args.trim()) return '❌ 请提供任务描述: /plan <复杂任务>';
    planAndExecute(args.trim()).then(function(result) {
      if (Core.session && Core.session.addMessage) {
        Core.session.addMessage(result, 'ai');
      }
    });
    return '⏳ 正在规划和执行任务...';
  }, '多步规划执行 — 将复杂任务分解为子步骤并逐步执行');

  Core.custom.registerCommand('/orchestrate', function(args) {
    if (!args || !args.trim()) return '❌ 请提供任务描述: /orchestrate <任务> | <子任务1> | <子任务2>';
    var parts = args.split('|').map(function(s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 2) return '❌ 格式: /orchestrate <总任务> | <子任务1> | <子任务2> | ...';
    var mainTask = parts[0];
    var subtasks = parts.slice(1);
    orchestrateSubtasks(mainTask, subtasks).then(function(result) {
      if (Core.session && Core.session.addMessage) {
        Core.session.addMessage(result, 'ai');
      }
    });
    return '⏳ 正在编排 ' + subtasks.length + ' 个子任务...';
  }, '子任务编排 — 并行执行多个子任务并合并结果');

  Core.custom.registerCommand('/exec', function(args) {
    if (!args || !args.trim()) return '❌ 请提供代码: /exec <javascript代码>';
    var result = executeCode(args.trim());
    if (result.success) {
      var output = result.output ? '控制台输出:\n' + result.output + '\n\n' : '';
      return '**执行结果：**\n```\n' + output + '返回值: ' + result.result + '\n```';
    }
    return '❌ 执行错误: ' + result.error;
  }, '代码沙盒执行 — 在安全沙箱中执行 JavaScript 代码');
}

// ===== 模块导出 =====
module.exports = {
  name: 'agent',
  dependencies: ['custom'],
  init(_Core) {
    Core = _Core;
    Core.agent = {
      runAgent,            // 主入口：委托给 api.js sendToAgent
      planAndExecute,      // Phase 5-3: 多步规划执行
      selfReflect,         // Phase 5-3: 自我反思
      orchestrateSubtasks, // Phase 5-3: 子任务编排
      executeCode,         // Phase 5-3: 代码沙盒执行
      getStatus,           // 查询 Agent 状态
      getHistory,          // 获取运行历史
      clearHistory,        // 清除历史
      getToolsDescription, // 获取工具描述
      parseReActOutput,    // ReAct 解析（备用）
      MAX_STEPS,
    };
    registerCommands();
    console.log('✅ Agent 模块已加载（委托模式，统一使用 api.js Agent 引擎）');
  }
};
