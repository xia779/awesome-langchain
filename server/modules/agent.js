// server/modules/agent.js — 服务端 Agent 循环（ReAct）
// 实现 agent.execute → agent.step 流式步骤推送 → agent.complete。
// 工具调用走 Core.toolsRegistry.executeTool，透明路由到在线节点远程执行。
var PROTOCOL = require('../protocol');

var Core = null;
var _router = null;

// sessionId → true（取消标记）
var _cancelled = {};
// sessionId → true（防止同一会话并发执行）
var _running = {};

var MAX_STEPS = 20;
var CONTEXT_LIMIT = 12000;

// ===== 步骤名中文映射 =====
var ACTION_ZH_MAP = {
  'read_file': '读取文件',
  'write_file': '写入文件',
  'edit_file': '编辑文件',
  'list_dir': '列出目录',
  'search_files': '搜索文件',
  'file_info': '文件信息',
  'run_command': '执行命令',
  'run_python': '运行Python',
  'read_url': '抓取网页',
  'complete': '完成任务',
};
function translateAction(action) {
  return ACTION_ZH_MAP[action] || action;
}

// ===== 系统提示词（从 toolsRegistry 动态生成工具列表）=====
function buildSystemPrompt() {
  var toolLines = [];
  if (Core.toolsRegistry) {
    var defs = Core.toolsRegistry.getToolDefinitions();
    defs.forEach(function(d) {
      var fn = d.function;
      var props = (fn.parameters && fn.parameters.properties) || {};
      var paramStr = Object.keys(props).map(function(k) {
        return '"' + k + '": ' + (props[k].description || props[k].type || '');
      }).join(', ');
      toolLines.push('- ' + fn.name + ': ' + fn.description + '\n  参数: {' + paramStr + '}');
    });
  }

  var now = new Date();
  var weekDays = ['日', '一', '二', '三', '四', '五', '六'];

  return '你是一个中文AI智能体助手，可以自主思考并使用工具来完成用户任务。\n' +
    '当前时间：' + now.toLocaleString('zh-CN', { hour12: false }) + ' 星期' + weekDays[now.getDay()] + '\n\n' +
    '【绝对规则 - 必须严格遵守】\n' +
    '1. 你的每一次回复必须且只能是纯JSON格式，绝对不能包含任何JSON之外的文字、说明、注释或解释\n' +
    '2. 所有最终回答内容必须是中文\n' +
    '3. 不要输出 markdown 代码块标记（如 ```json），只输出纯JSON文本\n' +
    '4. 步骤说明和执行过程必须放在 complete 的 answer 参数中，用中文描述\n\n' +
    '【错误恢复规则】\n' +
    '5. 工具返回错误时（[ERROR]/[BLOCKED]/失败），分析原因并尝试不同策略\n' +
    '6. 禁止用完全相同的参数重复调用同一个失败的工具\n' +
    '7. 替代策略：read_file失败→用list_dir查看目录；命令失败→检查路径或换用run_python\n' +
    '8. 【严禁编造数据】没有通过工具获取到的确切数据，绝对不允许编造，必须明确说明"未找到确切数据"\n\n' +
    '你可以使用以下工具（action名称）：\n' +
    toolLines.join('\n') + '\n' +
    '- complete: 任务完成，给出最终回答\n  参数: {"answer": "最终回答内容（必须是中文）"}\n\n' +
    '【回复格式 - 每次只能输出这个JSON，前后不要有任何文字】\n' +
    '{"action": "工具名", "params": {"参数": "值"}}\n\n' +
    '【示例 - 用户问"查看E盘根目录有什么"，你的回复必须是】\n' +
    '{"action": "list_dir", "params": {"dir_path": "E:/"}}\n\n' +
    '【获取结果后，你的回复必须是】\n' +
    '{"action": "complete", "params": {"answer": "E盘根目录有以下内容：..."}}';
}

// ===== JSON 提取（多层容错，与桌面端 agent-loop 一致）=====
function extractJSONFromText(text) {
  if (!text || typeof text !== 'string') return null;
  var trimmed = text.trim();

  // 尝试1：直接解析纯JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed); } catch (e) {}
  }

  // 尝试2：提取 ```json 代码块
  var codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()); } catch (e) {}
  }

  // 尝试3：括号深度匹配第一个完整JSON对象
  var firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    var depth = 0, endPos = -1;
    for (var i = firstBrace; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos !== -1) {
      try { return JSON.parse(text.substring(firstBrace, endPos + 1)); } catch (e) {}
    }
  }

  // 尝试4：正则匹配含 action 字段的片段
  var actionMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"[^"]+"[\s\S]*?\}/);
  if (actionMatch) {
    try { return JSON.parse(actionMatch[0]); } catch (e) {}
  }

  return null;
}

// 解析 LLM 回复为动作；解析失败返回 null（视为最终回答）
function parseAction(text) {
  var obj = extractJSONFromText(text);
  if (!obj || !obj.action) return null;
  return {
    action: String(obj.action),
    params: (obj.params && typeof obj.params === 'object') ? obj.params : {},
  };
}

// 最终回答清理（从 JSON 残留中提取 answer）
function cleanFinalAnswer(text) {
  if (!text) return text || '';
  if (text.trim().startsWith('{')) {
    var parsed = extractJSONFromText(text);
    if (parsed) {
      var extracted = '';
      if (parsed.action === 'complete' && parsed.params) {
        extracted = parsed.params.answer || parsed.params.result || parsed.params.content || '';
      }
      if (!extracted && parsed.answer) extracted = parsed.answer;
      if (extracted) return extracted;
    }
  }
  return text;
}

// ===== Agent 主循环 =====
async function runAgent(sessionId, task, opts) {
  var systemPrompt = buildSystemPrompt();
  var context = '';
  var stepsLog = [];
  var finalAnswer = '';
  var step = 0;

  function pushStep(payload) {
    payload.sessionId = sessionId;
    _router.broadcast(PROTOCOL.AGENT_STEP, payload);
  }

  try {
    while (step < MAX_STEPS) {
      if (_cancelled[sessionId]) {
        finalAnswer = '（任务已取消）';
        break;
      }
      step++;

      pushStep({ step: step, maxSteps: MAX_STEPS, status: 'thinking', actionZh: '思考中' });

      var prompt = '任务：' + task + '\n\n' +
        '已执行的步骤和结果：\n' + (context || '（暂无，这是第一步）') + '\n\n' +
        '请决定下一步行动（只输出JSON）：';

      var reply;
      try {
        reply = await Core.api.callAPI(prompt, systemPrompt, 0.3, opts.model, opts.provider);
      } catch (e) {
        pushStep({ step: step, status: 'error', actionZh: '模型调用失败', error: e.message });
        finalAnswer = '模型调用失败：' + e.message;
        break;
      }

      var content = (reply && reply.message && reply.message.content) || '';
      var action = parseAction(content);

      // 解析失败 → 视为最终回答
      if (!action) {
        finalAnswer = cleanFinalAnswer(content);
        break;
      }

      // 任务完成
      if (action.action === 'complete') {
        finalAnswer = action.params.answer || action.params.result || '（完成）';
        stepsLog.push({ step: step, action: 'complete', success: true });
        break;
      }

      // 未知工具 → 提示模型并继续
      var knownTools = Core.toolsRegistry ? Core.toolsRegistry.listTools() : [];
      if (knownTools.indexOf(action.action) === -1) {
        context += '\n步骤' + step + ': 调用了未知工具 "' + action.action + '"，可用工具：' + knownTools.join('/') + '。请重新选择。';
        stepsLog.push({ step: step, action: action.action, success: false, error: '未知工具' });
        if (context.length > CONTEXT_LIMIT) context = context.substring(context.length - CONTEXT_LIMIT);
        continue;
      }

      // 执行工具（透明路由到节点）
      pushStep({
        step: step, status: 'running',
        action: action.action, actionZh: translateAction(action.action),
        params: action.params,
      });

      var started = Date.now();
      var result;
      var success = true;
      try {
        result = await Core.toolsRegistry.executeTool(action.action, action.params);
      } catch (e) {
        result = '[ERROR] ' + e.message;
        success = false;
      }
      var elapsed = Date.now() - started;

      var resultStr = String(result == null ? '' : result);
      var isErr = /^\[(ERROR|BLOCKED)\]/.test(resultStr);

      stepsLog.push({
        step: step, action: action.action, actionZh: translateAction(action.action),
        params: action.params, success: success && !isErr,
        resultPreview: resultStr.substring(0, 200), time: elapsed,
      });

      pushStep({
        step: step, status: 'done',
        action: action.action, actionZh: translateAction(action.action),
        success: success && !isErr, time: elapsed,
        resultPreview: resultStr.substring(0, 500),
      });

      // 累积上下文（截断单条结果，防止上下文爆炸）
      var truncated = resultStr.length > 2000
        ? resultStr.substring(0, 2000) + '...(结果已截断，共' + resultStr.length + '字符)'
        : resultStr;
      context += '\n步骤' + step + ' [' + action.action + '] 参数' + JSON.stringify(action.params) + '\n结果: ' + truncated;
      if (context.length > CONTEXT_LIMIT) context = context.substring(context.length - CONTEXT_LIMIT);
    }

    if (step >= MAX_STEPS && !finalAnswer) {
      finalAnswer = '（已达到最大步骤数 ' + MAX_STEPS + '，任务可能未完全完成）';
    }
  } catch (e) {
    finalAnswer = 'Agent 执行异常：' + e.message;
    Core.error('agent loop error:', e.message);
  }

  delete _running[sessionId];
  delete _cancelled[sessionId];

  // 保存最终回答到会话
  try {
    if (Core.session && sessionId) Core.session.addMessage(sessionId, 'ai', finalAnswer);
  } catch (e) {}

  _router.broadcast(PROTOCOL.AGENT_COMPLETE, {
    sessionId: sessionId,
    answer: finalAnswer,
    steps: stepsLog,
    totalSteps: stepsLog.length,
  });

  return { answer: finalAnswer, steps: stepsLog };
}

// ===== WS 处理器 =====
function handleAgentExecute(payload, ctx) {
  var task = payload.task || payload.text || '';
  if (!task.trim()) throw new Error('任务内容为空');

  var sessionId = payload.sessionId;
  if (!sessionId) {
    var session = Core.session.create('Agent 任务');
    sessionId = session.id;
  }
  if (_running[sessionId]) {
    return { started: false, error: '该会话有正在执行的 Agent 任务' };
  }
  _running[sessionId] = true;

  // 保存用户任务消息
  try { Core.session.addMessage(sessionId, 'user', task); } catch (e) {}

  // 后台执行，步骤通过 agent.step 事件流式推送
  runAgent(sessionId, task, {
    model: payload.model,
    provider: payload.provider,
  });

  return { started: true, sessionId: sessionId };
}

function handleAgentCancel(payload) {
  var sessionId = payload.sessionId;
  if (sessionId && _running[sessionId]) {
    _cancelled[sessionId] = true;
    return { cancelling: true };
  }
  return { cancelling: false };
}

module.exports = {
  name: 'agent',
  dependencies: ['cloud-api', 'tools', 'session'],
  init: function(_Core, router) {
    Core = _Core;
    _router = router;

    router.handle(PROTOCOL.AGENT_EXECUTE, handleAgentExecute);
    router.handle(PROTOCOL.AGENT_CANCEL, handleAgentCancel);

    Core.registerModule('agent', {
      run: runAgent,
      cancel: handleAgentCancel,
    });

    Core.log('agent module initialized (ReAct loop + step streaming)');
  }
};
