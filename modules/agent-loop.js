// modules/agent-loop.js - Agent 智能体循环
// 从 api.js 提取，处理 Agent ReAct 循环、工具执行、JSON 提取等
const fs = require('fs');

let Core = null;

// ===== Agent 系统提示词（强制中文 + 纯JSON）=====
const AGENT_SYSTEM_PROMPT = `你是一个中文AI智能体助手，可以自主思考并使用工具来完成用户任务。

【绝对规则 - 必须严格遵守】
1. 你的每一次回复必须且只能是纯JSON格式，绝对不能包含任何JSON之外的文字、说明、注释或解释
2. 所有最终回答内容必须是中文，绝对不能输出英文（代码中的关键字除外）
3. 不要输出 markdown 代码块标记（如 \`\`\`json），只输出纯JSON文本
4. 步骤说明和执行过程必须放在 complete 的 answer 参数中，用中文描述

【错误恢复规则 - 必须遵守】
5. 如果工具执行返回错误（包含 ❌、错误、error、failed、未找到、not found 等），你必须分析错误原因并尝试不同策略
6. 禁止用完全相同的参数重复调用同一个失败的工具
7. 替代策略示例：read_file失败→用list_dir查看目录；browser_click失败→用browser_execute执行JS；web_search无结果→换关键词或尝试read_url
8. 如果连续两次工具失败，考虑用 run_python 编写脚本来完成任务，或向用户 ask_user 确认参数

你可以使用以下工具（action名称）：
- web_search: 联网搜索，获取最新信息、实时数据、新闻
  参数: {"query": "搜索关键词"}
- read_url: 抓取网页内容，读取指定URL的网页正文
  参数: {"url": "网页URL地址"}
- read_file: 读取本地文件
  参数: {"path": "文件路径"}
- write_file: 写入本地文件
  参数: {"path": "文件路径", "content": "文件内容"}
- edit_file: 精确替换文件中的文本片段（查找old_text替换为new_text）
  参数: {"file_path": "文件路径", "old_text": "要替换的文本", "new_text": "替换后的文本", "replace_all": false}
- list_dir: 列出目录下的文件和子目录
  参数: {"dir_path": "目录路径"}
- search_files: 在目录中按文件名模式搜索文件
  参数: {"dir_path": "目录路径", "pattern": "glob模式如**/*.js"}
- file_info: 获取文件/目录的详细信息（大小、修改时间、类型）
  参数: {"file_path": "文件路径"}
- run_command: 执行系统命令（ls, cat, grep等）
  参数: {"command": "命令字符串", "cwd": "可选工作目录"}
- run_python: 执行Python代码
  参数: {"code": "Python代码"}
- browser_navigate: 打开浏览器并导航到网页（可渲染JS页面）
  参数: {"url": "网页URL"}
- browser_click: 点击页面上的元素
  参数: {"selector": "CSS选择器"}
- browser_type: 在页面输入框中输入文本
  参数: {"selector": "CSS选择器", "text": "文本内容"}
- browser_extract: 从页面提取内容（text/html/links/forms/info）
  参数: {"type": "text|html|links|forms|info", "selector": "可选CSS选择器"}
- browser_screenshot: 截取当前页面的屏幕截图
  参数: {"full_page": true/false}
- browser_wait: 等待页面加载或指定时间
  参数: {"selector": "可选等待元素", "timeout": 5000}
- github_pr: GitHub Pull Request 操作（list/view/create/diff/merge/checks）
  参数: {"action": "list|view|create|diff|merge|checks", "number": PR编号, "title": "标题"}
- github_issue: GitHub Issue 操作（list/view/create/close/comment）
  参数: {"action": "list|view|create|close|comment", "number": Issue编号, "title": "标题"}
- github_repo: 查看当前 GitHub 仓库信息
  参数: {}
- github_release: 管理 GitHub Release（list/view/create）
  参数: {"action": "list|view|create", "tag": "标签名", "title": "标题"}
- image_search: 搜索网络图片（DuckDuckGo/Bing/Unsplash）
  参数: {"query": "搜索关键词", "provider": "duckduckgo|bing|unsplash", "count": 5}
- image_download: 下载图片到本地
  参数: {"url": "图片URL", "dest": "保存路径"}
- ask_user: 向用户提问，收集偏好或确认信息（暂停执行等待回答）
  参数: {"question": "问题文本", "options": [{"label":"选项A","description":"说明"}], "multiSelect": false}
- parallel_execute: 并行执行多个工具（适用于互不依赖的子任务）
  参数: {"tasks": [{"action": "工具名", "params": {...}}, ...]}
- handoff_to_agent: 将子任务委派给专业代理执行（适合需要专业领域知识的子任务）
  参数: {"target": "code|research|writer|math|translate", "task": "任务描述", "context": "可选背景信息"}
- complete: 任务完成，给出最终回答
  参数: {"answer": "最终回答内容（必须是中文）"}

【回复格式 - 每次只能输出这个JSON，前后不要有任何文字】
{"action": "工具名", "params": {"参数": "值"}}

【示例 - 用户问"北京天气"，你的回复必须是】
{"action": "web_search", "params": {"query": "北京今天天气"}}

【获取搜索结果后，你的回复必须是】
{"action": "complete", "params": {"answer": "根据搜索结果，北京今天天气晴朗，气温25-32度..."}}`;


// ===== JSON提取（多重容错 + 调试）=====
function extractJSONFromText(text) {
  if (!text || typeof text !== 'string') {
    console.log('❌ extractJSON: text为空或非字符串');
    return null;
  }
  const trimmed = text.trim();
  
  // 尝试1：直接解析纯JSON（trim后以{开头以}结尾）
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const result = JSON.parse(trimmed);
      return result;
    } catch (e) {
    }
  }
  
  // 尝试2：提取 ```json 代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const result = JSON.parse(codeBlockMatch[1].trim());
      return result;
    } catch (e) {
    }
  }
  
  // 尝试3：提取第一个完整JSON对象（括号匹配，处理多个JSON拼接）
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let endPos = -1;
    for (let i = firstBrace; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos !== -1) {
      const jsonStr = text.substring(firstBrace, endPos + 1);
      try {
        const result = JSON.parse(jsonStr);
        return result;
      } catch (e) {
      }
    }
  }
  
  // 尝试4：正则匹配最外层 { ... "action" ... }
  const actionMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"[^"]+"[\s\S]*?\}/);
  if (actionMatch) {
    try {
      const result = JSON.parse(actionMatch[0]);
      return result;
    } catch (e) {
    }
  }
  
  return null;
}


// ===== 最终回答清理（合并 5 个冗余清理块）=====
function cleanFinalAnswer(text) {
  if (!text) return text;

  // 1. 如果是JSON，尝试提取 complete.action 字段
  if (text.trim().startsWith('{')) {
    var parsed = extractJSONFromText(text);
    if (parsed) {
      var extracted = '';
      if (parsed.action === 'complete' && parsed.params) {
        extracted = parsed.params.answer || parsed.params.result || parsed.params.content || '';
      }
      if (!extracted && parsed.answer) extracted = parsed.answer;
      if (!extracted && parsed.params && parsed.params.answer) extracted = parsed.params.answer;
      if (extracted) text = extracted;
    }
  }

  // 2. 如果仍包含 "answer" 字段，用正则提取
  if (text.includes('"answer"')) {
    var answerMatch = text.match(/"answer"\s*:\s*"((?:[^"]|\\.){5,})"/);
    if (answerMatch) {
      text = answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  }

  // 3. 如果还残留JSON关键字（action/params），提取中文内容
  if (text.includes('"action"') || text.includes('"params"')) {
    var cleaned = text.replace(/\{[^{}]*\}/g, '').replace(/"[^"]*":\s*/g, '');
    var cnMatch = cleaned.match(/[\u4e00-\u9fa5].*[\u4e00-\u9fa5]/s);
    if (cnMatch && cnMatch[0].length > 5) {
      text = cnMatch[0];
    }
  }

  // 4. 去除末尾残留的JSON符号和空白
  text = text.replace(/["\}\{\]\[]+[a-zA-Z\s]*$/g, '');
  text = text.replace(/\s+$/, '');

  return text;
}


// ===== 工具结果规范化：统一 ToolResult 格式 =====
// 所有工具返回可能不一致（string/object/null/Error），此函数确保下游处理安全
function normalizeToolResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result instanceof Error) return '❌ ' + result.message;
  try { return JSON.stringify(result, null, 2); } catch (e) { return String(result); }
}
// ===== Agent 工具执行（MCP + toolsRegistry 统一调度）=====
async function _executeAgentActionRaw(action, params) {
  // 优先级 1：通过 toolsRegistry 执行（tools.js，含路径白名单 + 安全检查）
  if (Core.toolsRegistry && typeof Core.toolsRegistry.executeTool === 'function') {
    // 将 Agent 的参数名映射到 toolsRegistry 的参数名
    const mappedParams = { ...params };
    if (action === 'read_file' && params.path && !params.file_path) {
      mappedParams.file_path = params.path;
    }
    if (action === 'write_file' && params.path && !params.file_path) {
      mappedParams.file_path = params.path;
    }
    if (action === 'run_python' && params.code) {
      try {
        const result = await Core.toolsRegistry.executeTool('run_python', { code: params.code });
        return result;
      } catch (e) {
        return 'Python执行失败: ' + e.message;
      }
    }
    if (['read_file', 'write_file', 'list_dir', 'read_url', 'search_files', 'edit_file', 'file_info',
         'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_extract', 'browser_wait',
         'github_pr', 'github_issue', 'github_repo', 'github_release',
         'image_search', 'image_download'].includes(action)) {
      try {
        const result = await Core.toolsRegistry.executeTool(action, mappedParams);
        return result;
      } catch (e) {
        console.warn('⚠️ [api] toolsRegistry 执行工具 "' + action + '" 失败，尝试其他方式:', e.message);
      }
    }
  }

  // 优先级 2：MCP 外部工具（如果可用）
  if (Core.mcp && Core.mcp.enabled && Core.mcp.enabled()) {
    try {
      const result = await Core.mcp.callTool(action, params);
      if (result.success) {
        return JSON.stringify(result, null, 2);
      }
    } catch (e) {
      console.warn('⚠️ [api] MCP 调用 "' + action + '" 失败，回退到内置逻辑:', e.message);
    }
  }

  // 优先级 3：内置工具逻辑（兜底）
  switch (action) {
    case 'web_search':
      if (!Core.webSearch) return '联网搜索功能未启用';
      try { return await Core.webSearch(params.query || ''); } catch (e) { return '搜索失败: ' + e.message; }
    case 'handoff_to_agent':
      if (Core.handoff && Core.handoff.executeHandoff) {
        return await Core.handoff.executeHandoff(params.target, params.task, params.context || '');
      }
      return '❌ Handoff 模块未加载';
    case 'read_file':
      try { return fs.readFileSync(params.path, 'utf8'); } catch (e) { return '读取失败: ' + e.message; }
    case 'write_file':
      try { fs.writeFileSync(params.path, params.content, 'utf8'); return '文件写入成功'; } catch (e) { return '写入失败: ' + e.message; }
    default:
      return '未知工具: ' + action;
  }
}


// 规范化包装器：确保所有调用者（顺序路径 + parallel_execute）都收到字符串结果
async function executeAgentAction(action, params) {
  // Guardrails Layer 3: 工具执行守卫
  if (Core.guardrails) {
    var toolCheck = Core.guardrails.checkToolExecution(action, params);
    if (!toolCheck.safe) {
      return '🛡️ 工具执行被安全策略阻止: ' + toolCheck.reason;
    }
    if (toolCheck.warning) console.warn(toolCheck.warning);
  }
  try {
    var raw = await _executeAgentActionRaw(action, params);
    return normalizeToolResult(raw);
  } catch (e) {
    return '❌ 工具 "' + action + '" 执行异常: ' + e.message;
  }
}

// ===== Agent 回答质量评估（Evaluator-Optimizer 模式）=====
function evaluateAnswer(answer) {
  if (!answer || typeof answer !== 'string') return { pass: false, reason: '回答为空' };
  var trimmed = answer.trim();
  if (trimmed.length < 10) return { pass: false, reason: '回答太短（' + trimmed.length + '字符）' };
  var apologyOnly = /^(抱歉|对不起|很遗憾|不好意思|sorry|I'?m sorry|I cannot|I can'?t)[。，.!！]?$/i.test(trimmed);
  if (apologyOnly) return { pass: false, reason: '仅包含道歉，无实质内容' };
  var jsonRemnants = /"action"\s*:\s*"(?!complete)/.test(trimmed) || /"params"\s*:\s*\{/.test(trimmed);
  if (jsonRemnants) return { pass: false, reason: '包含未清理的工具调用 JSON 残留' };
  var pureError = /^❌\s*Agent\s*执行出错/.test(trimmed) && !/建议/.test(trimmed);
  if (pureError) return { pass: false, reason: '仅包含错误信息，无解决建议' };
  var fallbackOnly = trimmed === '抱歉，AI 返回的格式不正确，无法解析结果。请重试。';
  if (fallbackOnly) return { pass: false, reason: '格式化失败的兆底文案' };
  return { pass: true, reason: '' };
}
// ===== Agent 智能体循环 =====
async function sendToAgent(task, isDeepThink) {
  const maxSteps = isDeepThink ? 20 : 12;
  let context = '';
  let step = 0;
  let finalAnswer = '';
  let stepsLog = [];
  let _agentCancelled = false;
  let _stepStartTimes = {};

  // 🔧 标记生成开始，按钮变为停止
  Core._setGeneratingState(true);
  Core.emit('typingStart');

  // 创建 Agent 消息div
  const agentDiv = document.createElement('div');
  agentDiv.className = 'msg ai';
  if (Core.config.chatBubbleAI) agentDiv.style.backgroundColor = Core.config.chatBubbleAI;
  // 🔧 实时步骤面板：每步追加，不再覆盖
  var stepsContainer = document.createElement('div');
  stepsContainer.className = 'agent-steps-live';
  stepsContainer.style.cssText = 'margin-bottom:8px;';

  // 状态行 + 取消按钮
  var statusRow = document.createElement('div');
  statusRow.className = 'agent-status-row';
  statusRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
  var statusSpan = document.createElement('span');
  statusSpan.className = 'typing-cursor';
  statusSpan.style.cssText = 'flex:1;';
  statusSpan.textContent = '🤔 Agent 正在思考...';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'agent-cancel-btn';
  cancelBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;">stop_circle</span> 取消';
  cancelBtn.onclick = function() {
    _agentCancelled = true;
    this.disabled = true;
    this.textContent = '已取消';
    this.style.opacity = '0.5';
    this.style.cursor = 'default';
    statusSpan.textContent = '⏹ 正在取消...';
  };
  statusRow.appendChild(statusSpan);
  statusRow.appendChild(cancelBtn);
  agentDiv.appendChild(statusRow);
  agentDiv.appendChild(stepsContainer);
  Core.dom.chatContainer.appendChild(agentDiv);
  Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;

  // ===== 状态机路径（优先）或传统循环路径（兜底）=====
  if (Core.workflow && Core.workflow.stateMachine) {
    // 状态机回调：更新 UI DOM
    var _currentStepRow = null;
    var _timerInterval = null;
    var _smConfig = {
      isDeepThink: isDeepThink,
      cancelCheck: function() { return _agentCancelled; },
      onStepStart: function(s, phase, actionName) {
        statusSpan.className = 'typing-cursor';
        if (phase === 'THINK') {
          statusSpan.textContent = '🤔 步骤 ' + s + '/' + maxSteps + '：思考中...';
        } else if (phase === 'ACT' && actionName) {
          statusSpan.textContent = '🛠️ 执行: ' + actionName + '...';
          _currentStepRow = document.createElement('div');
          _currentStepRow.className = 'agent-step-live';
          _currentStepRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;margin:3px 0;font-size:12px;color:var(--text-secondary);border-left:3px solid var(--primary);border-radius:4px;background:rgba(59,130,246,0.05);';
          _currentStepRow.innerHTML = '<div><span style="color:var(--primary);font-weight:600;">步骤 ' + s + '</span> <span style="font-weight:500;color:var(--text);">' + actionName + '</span> <span class="typing-cursor" style="font-size:10px;">⏳</span></div><span class="agent-step-timer" style="font-size:10px;color:var(--text-secondary);opacity:0.7;"></span>';
          var timerSpan = _currentStepRow.querySelector('.agent-step-timer');
          _timerInterval = setInterval(function() {
            var elapsed = ((Date.now() - (_stepStartTimes[s] || Date.now())) / 1000).toFixed(1);
            if (timerSpan) timerSpan.textContent = elapsed + 's';
          }, 200);
          stepsContainer.appendChild(_currentStepRow);
          Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
        }
      },
      onStepComplete: function(s, actionName, success) {
        if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
        if (_currentStepRow) {
          var stepElapsed = ((Date.now() - (_stepStartTimes[s] || Date.now())) / 1000).toFixed(1);
          if (success) {
            _currentStepRow.style.borderLeftColor = '#22c55e';
            _currentStepRow.innerHTML = '<div><span style="color:var(--primary);font-weight:600;">步骤 ' + s + '</span> <span style="font-weight:500;color:var(--text);">' + actionName + '</span> ✅</div><span style="font-size:10px;color:#22c55e;opacity:0.8;">' + stepElapsed + 's</span>';
          }
        }
      },
      onToolError: function(s, actionName, errText) {
        if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
        if (_currentStepRow) {
          _currentStepRow.style.borderLeftColor = '#ef4444';
          _currentStepRow.innerHTML = '<div><span style="color:#ef4444;font-weight:600;">步骤 ' + s + '</span> <span style="font-weight:500;color:var(--text);">' + actionName + '</span> ❌ <span style="font-size:10px;color:#ef4444;">自动纠错中</span></div><span style="font-size:10px;color:#ef4444;opacity:0.8;">' + ((Date.now() - (_stepStartTimes[s] || Date.now())) / 1000).toFixed(1) + 's</span>';
        }
      },
      onStateChange: function(from, to) {
        console.log('[Agent] State: ' + from + ' → ' + (to || 'END'));
      }
    };
    var machine = Core.workflow.stateMachine.createMachine(task, _smConfig);
    var smResult = await Core.workflow.stateMachine.runMachine(machine);
    finalAnswer = smResult.reply;
    stepsLog = smResult.stepsLog;
    step = smResult.steps;
  } else {
  // ===== 传统循环路径（兜底）=====
  while (step < maxSteps) {
    step++;
    if (_agentCancelled) { console.log('⏹ Agent 已被用户取消'); break; }
    _stepStartTimes[step] = Date.now();
    // 更新状态行
    statusSpan.className = 'typing-cursor';
    statusSpan.textContent = '🤔 步骤 ' + step + '/' + maxSteps + '：思考中...';

    const prompt = `任务：${task}\n\n历史执行记录：${context || '（无）'}\n\n请决定下一步行动。注意：只输出纯JSON，不要有任何其他文字。`;

    let reply = '';
    try {
      // 📁 Agent 模式也注入项目上下文 + 增强记忆
      var agentPrompt = AGENT_SYSTEM_PROMPT;
      if (Core.projectContext && Core.projectContext.hasContext()) {
        var pCtx = Core.projectContext.getContextString();
        if (pCtx) agentPrompt += pCtx;
      }
      if (Core.memoryEnhance && Core.memoryEnhance.getEnhancedContext) {
        var memCtx = Core.memoryEnhance.getEnhancedContext(task);
        if (memCtx) agentPrompt += '\n\n' + memCtx;
      }
      const data = await Core.api.callAPI(prompt, agentPrompt, 0.7, null, 'ollama');
      reply = (data.message && data.message.content) || data.response || '';
    } catch (err) {
      finalAnswer = '❌ Agent 执行出错：' + err.message + '\n\n可能原因：\n1. Ollama 服务未启动（http://127.0.0.1:11434）\n2. 本地模型未加载\n\n建议：使用普通聊天模式，或确保 Ollama 已启动。';
      break;
    }

    // 解析JSON action
    const action = extractJSONFromText(reply);

    if (!action || !action.action) {
      const chineseMatch = reply.match(/[一-龥　-〿＀-￯].{10,}/);
      if (chineseMatch) {
        finalAnswer = chineseMatch[0];
      } else {
        const answerMatch = reply.match(/"answer"\s*:\s*"([^"]{5,})"/);
        if (answerMatch) {
          finalAnswer = answerMatch[1];
        } else {
          finalAnswer = '抱歉，AI 返回的格式不正确，无法解析结果。请重试。';
        }
      }
      break;
    }

    if (action.action === 'complete') {
      let answer = '';
      if (action.params) {
        answer = action.params.answer || action.params.result || action.params.content || '';
      }
      if (!answer && action.answer) answer = action.answer;
      if (!answer && action.result) answer = action.result;
      finalAnswer = answer || reply;
      break;
    }

    // 交互式问答：向用户提问并等待回答
    if (action.action === 'ask_user' && action.params) {
      if (Core.askUser && typeof Core.askUser.ask === 'function') {
        statusSpan.textContent = '❓ 等待用户回答...';
        // 在 agent 消息区域内显示问答 UI
        var askResult = await Core.askUser.ask({
          question: action.params.question || action.params.text || '请选择',
          options: Array.isArray(action.params.options) ? action.params.options : [],
          multiSelect: !!action.params.multiSelect,
          header: action.params.header || ''
        }, stepsContainer);

        var formattedAnswer = Core.askUser.formatAnswer(askResult);
        context += '\n[步骤' + step + '] 向用户提问: ' + (action.params.question || '') + '\n用户回答: ' + formattedAnswer;
        stepsLog.push({ step: step, action: 'ask_user', params: action.params, result: formattedAnswer, time: Date.now() - (_stepStartTimes[step] || Date.now()), success: true });

        // 更新步骤行状态
        var askRow = document.createElement('div');
        askRow.className = 'agent-step-live';
        askRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;margin:3px 0;font-size:12px;color:var(--text-secondary);border-left:3px solid #8b5cf6;border-radius:4px;background:rgba(139,92,246,0.05);';
        askRow.innerHTML = '<div><span style="color:#8b5cf6;font-weight:600;">步骤 ' + step + '</span> <span style="font-weight:500;color:var(--text);">ask_user</span> ✅</div><span style="font-size:10px;color:#8b5cf6;opacity:0.8;">' + formattedAnswer.substring(0, 60) + '</span>';
        stepsContainer.appendChild(askRow);
        statusSpan.textContent = '🤖 继续执行...';
        continue;
      }
    }

    // 并行执行多个子任务
    if (action.action === 'parallel_execute' && action.params && Array.isArray(action.params.tasks)) {
      var tasks = action.params.tasks.slice(0, 5); // 最多 5 个并行
      statusSpan.textContent = '⚡ 并行执行 ' + tasks.length + ' 个子任务...';
      var parallelResults = await Promise.all(tasks.map(function(subtask) {
        return executeAgentAction(subtask.action, subtask.params || {}).catch(function(e) { return '错误: ' + e.message; });
      }));
      var combinedResult = '并行执行结果（' + tasks.length + ' 个子任务）：\n';
      tasks.forEach(function(subtask, idx) {
        combinedResult += '\n--- 子任务 ' + (idx + 1) + ': ' + subtask.action + ' ---\n';
        combinedResult += (parallelResults[idx] || '无结果').substring(0, 400) + '\n';
      });
      context += '\n[步骤' + step + '] 并行执行 ' + tasks.length + ' 个子任务\n' + combinedResult.substring(0, 600);
      stepsLog.push({ step: step, action: 'parallel_execute', params: action.params, result: combinedResult.substring(0, 500), time: Date.now() - (_stepStartTimes[step] || Date.now()), success: true });
      continue;
    }

    // 执行工具 — 追加步骤行（含实时计时）
    statusSpan.textContent = '🛠️ 执行: ' + action.action + '...';
    var stepRow = document.createElement('div');
    stepRow.className = 'agent-step-live';
    stepRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;margin:3px 0;font-size:12px;color:var(--text-secondary);border-left:3px solid var(--primary);border-radius:4px;background:rgba(59,130,246,0.05);';
    stepRow.innerHTML = '<div><span style="color:var(--primary);font-weight:600;">步骤 ' + step + '</span> <span style="font-weight:500;color:var(--text);">' + action.action + '</span> <span class="typing-cursor" style="font-size:10px;">⏳</span></div><span class="agent-step-timer" style="font-size:10px;color:var(--text-secondary);opacity:0.7;"></span>';
    var timerSpan = stepRow.querySelector('.agent-step-timer');
    var _timerInterval = setInterval(function() {
      var elapsed = ((Date.now() - _stepStartTimes[step]) / 1000).toFixed(1);
      if (timerSpan) timerSpan.textContent = elapsed + 's';
    }, 200);
    stepsContainer.appendChild(stepRow);
    Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;

    const toolResult = await executeAgentAction(action.action, action.params || {});

    // 🔧 类型安全：确保 toolResult 是字符串
    var toolResultStr = (toolResult == null) ? '' : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult));

    // 🔧 自动纠错：检测工具失败并注入重试引导
    var resultForContext = toolResultStr;
    var isToolError = false;
    if (toolResultStr) {
      var errorPatterns = ['❌', '错误', 'error', 'failed', '失败', '未找到', 'not found', 'ENOENT', 'EACCES', 'permission denied', 'timeout', '超时', '无法', 'cannot'];
      var lowerResult = toolResultStr.toLowerCase();
      isToolError = errorPatterns.some(function(p) { return lowerResult.indexOf(p.toLowerCase()) !== -1; });
    }
    if (isToolError) {
      var correctionHint = '\n⚠️ [自动纠错提示] 工具 "' + action.action + '" 执行失败。请分析上述错误原因，并尝试以下策略之一：\n' +
        '1. 检查并修正参数后重试（如路径错误则修正路径）\n' +
        '2. 使用不同的工具完成同一目标\n' +
        '3. 使用 run_python 编写脚本来解决\n' +
        '4. 使用 web_search 搜索解决方案\n' +
        '请勿用完全相同的参数重复调用 ' + action.action + '。';
      resultForContext = toolResultStr + correctionHint;
      // 更新步骤行为红色错误状态
      stepRow.style.borderLeftColor = '#ef4444';
      stepRow.innerHTML = '<div><span style="color:#ef4444;font-weight:600;">步骤 ' + step + '</span> <span style="font-weight:500;color:var(--text);">' + action.action + '</span> ❌ <span style="font-size:10px;color:#ef4444;">自动纠错中</span></div><span style="font-size:10px;color:#ef4444;opacity:0.8;">' + ((Date.now() - _stepStartTimes[step]) / 1000).toFixed(1) + 's</span>';
    }

    const stepRecord = `[步骤${step}] 执行 ${action.action}: ${JSON.stringify(action.params || {})}\n结果: ${resultForContext.substring(0, 300)}${resultForContext.length > 300 ? '...' : ''}`;
    context += '\n' + stepRecord;
    stepsLog.push({ step: step, action: action.action, params: action.params, result: toolResultStr.substring(0, 500), time: Date.now() - (_stepStartTimes[step] || Date.now()), success: !isToolError });

    // 更新步骤行：完成状态（含耗时）— 仅非错误时更新为绿色
    clearInterval(_timerInterval);
    var stepElapsed = ((Date.now() - _stepStartTimes[step]) / 1000).toFixed(1);
    if (!isToolError) {
      stepRow.style.borderLeftColor = '#22c55e';
      stepRow.innerHTML = '<div><span style="color:var(--primary);font-weight:600;">步骤 ' + step + '</span> <span style="font-weight:500;color:var(--text);">' + action.action + '</span> ✅</div><span style="font-size:10px;color:#22c55e;opacity:0.8;">' + stepElapsed + 's</span>';
    }
  }
  } // end else: legacy loop path

  if (_agentCancelled && !finalAnswer) {
    finalAnswer = '⏹ 任务已被取消。已执行 ' + step + ' 步。';
  }
  if (step >= maxSteps && !finalAnswer) {
    finalAnswer = 'Agent 已达到最大步数限制，任务未能完成。';
  }

  // 最终回答清理：从可能的JSON残留中提取纯文本回答
  finalAnswer = cleanFinalAnswer(finalAnswer);

  // ===== Evaluator-Optimizer: retry once if answer quality is poor =====
  var _evalResult = evaluateAnswer(finalAnswer);
  if (!_evalResult.pass && step < maxSteps - 1 && !_agentCancelled) {
    console.log("[self-eval] quality issue: " + _evalResult.reason + ", retrying once");
    var _retryPrompt = "task: " + task + "\n\nhistory: " + (context || "(none)") + "\n\n[system-eval] your previous answer failed quality check: " + _evalResult.reason + ". please give a high-quality final answer using the complete action. do NOT output tool call JSON.";
    try {
      var _retryData = await Core.api.callAPI(_retryPrompt, AGENT_SYSTEM_PROMPT, 0.7, null, "ollama");
      var _retryReply = (_retryData.message && _retryData.message.content) || _retryData.response || "";
      var _retryAction = extractJSONFromText(_retryReply);
      if (_retryAction && _retryAction.action === "complete") {
        var _retryAnswer = (_retryAction.params && (_retryAction.params.answer || _retryAction.params.result || _retryAction.params.content)) || _retryReply;
        var _cleaned = cleanFinalAnswer(_retryAnswer);
        if (evaluateAnswer(_cleaned).pass) {
          finalAnswer = _cleaned;
          console.log("[self-eval] retry succeeded, answer quality improved");
        }
      }
    } catch (e) {
      console.warn("[self-eval] retry failed: " + e.message);
    }
  }


  // 🔧 渲染：保留实时步骤面板，折叠为思考过程，追加最终回答
  statusRow.remove(); // 移除状态行（含取消按钮）
  // 将步骤容器转换为折叠面板
  if (stepsLog.length > 0) {
    var panelWrapper = document.createElement('div');
    panelWrapper.className = 'agent-think-panel';
    var panelToggle = document.createElement('div');
    panelToggle.className = 'agent-think-toggle';
    // 统计成功/失败/总时间
    var successCount = 0, failCount = 0, totalTime = 0;
    for (var si = 0; si < stepsLog.length; si++) {
      if (stepsLog[si].success) successCount++; else failCount++;
      if (stepsLog[si].time) totalTime += stepsLog[si].time;
    }
    var totalTimeStr = (totalTime / 1000).toFixed(1);
    var statsHtml = '<span class="agent-think-arrow">▶</span> 🧠 执行追踪 (' + stepsLog.length + '步';
    if (successCount > 0) statsHtml += ' <span style="color:#22c55e;">✓' + successCount + '</span>';
    if (failCount > 0) statsHtml += ' <span style="color:#ef4444;">✗' + failCount + '</span>';
    statsHtml += '，' + totalTimeStr + 's)';
    panelToggle.innerHTML = statsHtml;
    panelToggle.style.cssText = 'padding:6px 12px;cursor:pointer;border-radius:6px;background:linear-gradient(135deg,#f1f5f9,#e2e8f0);font-size:13px;font-weight:500;user-select:none;display:flex;align-items:center;justify-content:space-between;';
    // 复制追踪按钮
    var copyTraceBtn = document.createElement('button');
    copyTraceBtn.className = 'agent-trace-copy-btn';
    copyTraceBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;">content_copy</span>';
    copyTraceBtn.title = '复制执行追踪';
    copyTraceBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:4px;color:var(--text-secondary);font-size:12px;';
    copyTraceBtn.onclick = function(e) {
      e.stopPropagation();
      var traceText = '=== Agent 执行追踪 ===\n任务: ' + task + '\n步骤: ' + stepsLog.length + ' | 成功: ' + successCount + ' | 失败: ' + failCount + ' | 耗时: ' + totalTimeStr + 's\n\n';
      for (var ti = 0; ti < stepsLog.length; ti++) {
        var s = stepsLog[ti];
        traceText += '--- 步骤 ' + s.step + ': ' + s.action + ' ' + (s.success ? '✓' : '✗') + ' (' + ((s.time || 0) / 1000).toFixed(1) + 's) ---\n';
        traceText += '参数: ' + JSON.stringify(s.params || {}) + '\n';
        traceText += '结果: ' + (s.result || '(空)').substring(0, 300) + '\n\n';
      }
      traceText += '最终回答: ' + (finalAnswer || '').substring(0, 200) + '\n';
      navigator.clipboard.writeText(traceText).then(function() {
        copyTraceBtn.title = '已复制!';
        copyTraceBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;color:#22c55e;">check</span>';
        setTimeout(function() { copyTraceBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;">content_copy</span>'; copyTraceBtn.title = '复制执行追踪'; }, 2000);
      });
    };
    panelToggle.appendChild(copyTraceBtn);
    panelToggle.onclick = function(e) {
      if (e.target.closest('.agent-trace-copy-btn')) return; // 不触发展开
      var content = this.nextElementSibling;
      var arrow = this.querySelector('.agent-think-arrow');
      if (content.classList.toggle('expanded')) {
        content.style.maxHeight = content.scrollHeight + 'px';
        arrow.textContent = '▼';
      } else {
        content.style.maxHeight = '0';
        arrow.textContent = '▶';
      }
    };
    // 重建步骤内容为可展开详情
    stepsContainer.innerHTML = '';
    for (var di = 0; di < stepsLog.length; di++) {
      var sData = stepsLog[di];
      var stepItem = document.createElement('div');
      stepItem.className = 'agent-trace-step';
      var statusIcon = sData.success ? '✅' : '❌';
      var timeStr = ((sData.time || 0) / 1000).toFixed(1);
      var headerRow = document.createElement('div');
      headerRow.className = 'agent-trace-step-header';
      headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;border-radius:4px;font-size:12px;user-select:none;';
      headerRow.innerHTML = '<span style="color:' + (sData.success ? '#22c55e' : '#ef4444') + ';font-weight:600;">' + statusIcon + ' 步骤' + sData.step + '</span> <span style="font-weight:500;color:var(--text);">' + sData.action + '</span> <span style="font-size:10px;color:var(--text-secondary);margin-left:auto;">' + timeStr + 's</span> <span class="agent-trace-expand-icon" style="font-size:10px;color:var(--text-secondary);">▶</span>';
      var detailRow = document.createElement('div');
      detailRow.className = 'agent-trace-step-detail';
      detailRow.style.cssText = 'display:none;padding:4px 8px 6px 28px;font-size:11px;color:var(--text-secondary);line-height:1.5;';
      var paramsStr = JSON.stringify(sData.params || {}, null, 2);
      var resultStr = (sData.result || '(空)').substring(0, 300);
      detailRow.innerHTML = '<div style="margin-bottom:4px;"><span style="font-weight:600;color:var(--text);">参数:</span><pre style="margin:2px 0;padding:4px 6px;background:rgba(0,0,0,0.04);border-radius:3px;font-size:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;">' + paramsStr + '</pre></div>' +
        '<div><span style="font-weight:600;color:var(--text);">结果:</span><pre style="margin:2px 0;padding:4px 6px;background:rgba(0,0,0,0.04);border-radius:3px;font-size:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;">' + resultStr + '</pre></div>';
      headerRow.onclick = (function(hdr, dtl) {
        return function() {
          var visible = dtl.style.display !== 'none';
          dtl.style.display = visible ? 'none' : 'block';
          hdr.querySelector('.agent-trace-expand-icon').textContent = visible ? '▶' : '▼';
          // 重新计算父 maxHeight
          var pc = hdr.closest('.agent-think-content');
          if (pc && pc.classList.contains('expanded')) pc.style.maxHeight = pc.scrollHeight + 'px';
        };
      })(headerRow, detailRow);
      stepItem.appendChild(headerRow);
      stepItem.appendChild(detailRow);
      stepsContainer.appendChild(stepItem);
    }
    var panelContent = document.createElement('div');
    panelContent.className = 'agent-think-content';
    panelContent.style.cssText = 'max-height:0;overflow:hidden;transition:max-height 0.3s ease;';
    stepsContainer.style.marginTop = '4px';
    panelContent.appendChild(stepsContainer);
    panelWrapper.appendChild(panelToggle);
    panelWrapper.appendChild(panelContent);
    // 清除 agentDiv 并重新组装
    agentDiv.innerHTML = '';
    agentDiv.appendChild(panelWrapper);
  } else {
    agentDiv.removeChild(stepsContainer);
  }
  const contentDiv = document.createElement('div');
  contentDiv.className = 'agent-content';
  if (window.marked && finalAnswer) {
    contentDiv.innerHTML = Core.renderMarkdown(finalAnswer);
  } else {
    contentDiv.textContent = finalAnswer || 'Agent未能完成任务';
  }
  agentDiv.appendChild(contentDiv);
  Core.addTimestamp(agentDiv); // 添加时间戳

  // 添加代码复制按钮和折叠按钮
  agentDiv.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-code-btn')) return; // 避免重复
    // 复制按钮
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = '复制';
      btn.onclick = function() {
        // 优先复制选中的文本
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
          navigator.clipboard.writeText(selection.toString());
          btn.textContent = '已复制';
          setTimeout(() => btn.textContent = '复制', 1500);
          return;
        }
        // 否则复制代码内容（排除按钮文本）
        const codeEl = pre.querySelector('code');
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent);
        } else {
          const clone = pre.cloneNode(true);
          clone.querySelectorAll('.copy-code-btn, .fold-code-btn').forEach(b => b.remove());
          navigator.clipboard.writeText(clone.textContent);
        }
        btn.textContent = '已复制';
        setTimeout(() => btn.textContent = '复制', 1500);
      };
    pre.appendChild(btn);
    // D3: 折叠按钮
    const foldBtn = document.createElement('button');
    foldBtn.className = 'fold-code-btn';
    foldBtn.textContent = '收起';
    foldBtn.onclick = function() {
      pre.classList.toggle('collapsed');
      foldBtn.textContent = pre.classList.contains('collapsed') ? '展开' : '收起';
    };
    pre.appendChild(foldBtn);
  });

  // 🔧 标记生成结束，按钮恢复
  Core._setGeneratingState(false);
  Core.emit('typingEnd');
  Core.dom.status.textContent = `✅ Agent 完成 (${step}步${isDeepThink ? ' · 深度' : ''})`;
  return { success: true, reply: finalAnswer || '', steps: step };
}


module.exports = {
  name: 'agent-loop',
  dependencies: ['html-utils'],
  init: function(_Core) {
    Core = _Core;
    Core.agentLoop = {
      sendToAgent: sendToAgent,
      executeAgentAction: executeAgentAction,
      extractJSONFromText: extractJSONFromText,
      cleanFinalAnswer: cleanFinalAnswer,
      evaluateAnswer: evaluateAnswer,
      AGENT_SYSTEM_PROMPT: AGENT_SYSTEM_PROMPT
    };
    console.log('✅ Agent 循环模块已加载');
  }
};
