// modules/api.js - 多服务路由 + MCP 工具调用 + Agent智能体循环 + 流式输出 + 停止生成
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

//  强制 temperature 在 JSON 中始终带小数点（DashScope 严格要求 Float 格式）
function _tempFloat(v) {
  var t = Number(v);
  if (!isFinite(t) || t < 0 || t > 2) t = 0.7;
  t = Math.round(t * 100) / 100;
  if (Number.isInteger(t)) {
    if (t >= 2) t = 1.999;
    else if (t <= 0) t = 0.001;
    else t += 0.001;
  }
  return t;
}

let Core = null;
let webSearchFn = null;

// ===== 按会话存储的生成状态 =====
function getSessionState(sessionId) {
  var sess = Core.session.sessions[sessionId];
  if (!sess) return { isGenerating: false, abortController: null };
  if (!sess._apiState) sess._apiState = { isGenerating: false, abortController: null };
  return sess._apiState;
}

function setGeneratingState(generating, sessionId) {
  sessionId = sessionId || (Core.session && Core.session.getCurrentId ? Core.session.getCurrentId() : '');
  var state = getSessionState(sessionId);
  state.isGenerating = generating;
  
  const sendBtn = Core.dom.sendBtn;
  if (sendBtn) {
    if (generating) {
      sendBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:20px;vertical-align:middle;">stop</span>';
      sendBtn.style.background = '#ef4444';
      sendBtn.title = '停止生成';
      sendBtn.disabled = false;
    } else {
      sendBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:20px;vertical-align:middle;">arrow_upward</span>';
      sendBtn.style.background = '';
      sendBtn.title = '发送';
      sendBtn.disabled = false;
    }
  }
  if (Core.dom.deepThinkBtn) Core.dom.deepThinkBtn.disabled = generating;
  if (Core.dom.webSearchBtn) Core.dom.webSearchBtn.disabled = generating;
  console.log(generating ? '⏳ 生成开始' : '✅ 生成结束');
}

function stopGeneration(sessionId) {
  sessionId = sessionId || (Core.session && Core.session.getCurrentId ? Core.session.getCurrentId() : '');
  console.log('⏹ 用户点击停止，sessionId=' + sessionId);
  var state = getSessionState(sessionId);
  if (state.abortController) {
    try { state.abortController.abort(); } catch (e) { console.warn('⚠️ [api] 中止生成请求失败:', e.message); }
    state.abortController = null;
  }
  state.isGenerating = false;
  
  const sendBtn = Core.dom.sendBtn;
  if (sendBtn) {
    sendBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:20px;vertical-align:middle;">arrow_upward</span>';
    sendBtn.style.background = '';
    sendBtn.title = '发送';
    sendBtn.disabled = false;
  }
  if (Core.dom.deepThinkBtn) Core.dom.deepThinkBtn.disabled = false;
  if (Core.dom.webSearchBtn) Core.dom.webSearchBtn.disabled = false;
  Core.dom.status.textContent = '⏹ 已停止';
  Core.emit('typingEnd');
  setTimeout(() => { Core.dom.status.textContent = `✅ 已就绪 (${Core.getCurrentService()})`; }, 1500);
}

// ===== 后台任务追踪 =====
var _backgroundTasks = {};  // { taskId: { sessionId, role, status, startTime, promise } }
var _backgroundTaskCounter = 0;

function _addBackgroundTask(task) {
  var taskId = 'bg_' + (++_backgroundTaskCounter) + '_' + Date.now();
  _backgroundTasks[taskId] = Object.assign({ id: taskId, status: 'running', startTime: Date.now() }, task);
  if (Core.session && Core.session.renderChatList) Core.session.renderChatList();
  return taskId;
}

function _completeBackgroundTask(taskId, status) {
  if (!_backgroundTasks[taskId]) return;
  _backgroundTasks[taskId].status = status || 'done';
  _backgroundTasks[taskId].endTime = Date.now();
  // 5秒后自动清理已完成任务
  setTimeout(function() { delete _backgroundTasks[taskId]; }, 5000);
  if (Core.session && Core.session.renderChatList) Core.session.renderChatList();
}

function getBackgroundTasks() {
  return Object.keys(_backgroundTasks).map(function(k) {
    var t = _backgroundTasks[k];
    return { id: t.id, sessionId: t.sessionId, role: t.role, status: t.status, startTime: t.startTime, endTime: t.endTime };
  });
}

// 🔧 辅助函数：将消息中的图片内容替换为短提示，防止 base64 导致 token 爆炸
function sanitizeContent(content) {
  if (!content || typeof content !== 'string') return content;
  return content.replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '[图片]')
                .replace(/!\[.*?\]\(https?:\/\/[^)]+\)/g, '[图片]');
}

// ===== 桌面通知 =====
function _showDesktopNotification(title, body) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      var iconPath = path.join(__dirname, '..', 'icon.ico');
      new Notification(title, { body: body, icon: iconPath });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(function(perm) {
        if (perm === 'granted') new Notification(title, { body: body });
      });
    }
  } catch (e) { console.warn('⚠️ [api] 桌面通知失败:', e.message); }
}

// ===== 后台执行子会话任务（非阻塞）=====
async function runBackgroundTask(childSessionId, text, masterSessionId, roleName) {
  var taskId = _addBackgroundTask({ sessionId: childSessionId, role: roleName, masterSessionId: masterSessionId });

  try {
    // 保存用户消息到子会话
    var childSession = Core.session.sessions[childSessionId];
    if (!childSession) { _completeBackgroundTask(taskId, 'error'); return; }

    childSession.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    if (!childSession._manuallyRenamed) {
      var firstUser = childSession.messages.find(function(m) { return m.role === 'user'; });
      if (firstUser) childSession.title = firstUser.content.substring(0, 20) + (firstUser.content.length > 20 ? '...' : '');
    }
    if (Core.session.saveSession) Core.session.saveSession(childSessionId);

    // 构建历史上下文（基于子会话自身）
    var bgHistory = _buildHistoryMessages(childSession, childSessionId);
    bgHistory.push({ role: 'user', content: text });

    // 确定模型和系统消息
    var selectedValue = Core.dom.modelSelect ? Core.dom.modelSelect.value : 'ollama';
    var provider = selectedValue.split(':')[0] || 'ollama';
    var model = selectedValue.includes(':') ? selectedValue.substring(selectedValue.indexOf(':') + 1) : selectedValue;
    var systemMsg = Core.config.systemInstruction || '';

    // 🔧 注入角色专属系统提示词，确保子角色以专业身份回答
    var roleSystemPrompts = {
      coder: '你是一位资深全栈开发工程师，精通 Python、JavaScript、Java 等主流编程语言。请用中文回答，给出代码时务必附带详细注释和运行说明。回答风格：先分析问题，再给出解决方案和代码示例。',
      writer: '你是一位创意写作专家，擅长文案创作、故事编写、翻译和内容润色。请用中文回答，语言优美流畅，根据用户需求调整风格和语气。',
      analyst: '你是一位金融数据分析师，擅长股票市场分析、财经新闻解读、经济数据分析和市场趋势预测。请用中文回答，以自然语言形式呈现分析结论，避免输出代码或技术格式。如果涉及具体数据，请明确标注数据来源和时间。回答要求：条理清晰、观点鲜明、数据有据可查。',
      teacher: '你是一位耐心的学习导师，擅长用通俗易懂的方式解释复杂概念。请用中文回答，多举例子、多用类比，确保学习者能理解。回答风格：循序渐进，先讲基础概念，再深入细节。'
    };
    var childRoleType = childSession.roleType || '';
    if (roleSystemPrompts[childRoleType]) {
      systemMsg = systemMsg ? (systemMsg + '\n\n' + roleSystemPrompts[childRoleType]) : roleSystemPrompts[childRoleType];
    }

    // 🔧 分析师联网搜索：金融类查询自动注入实时搜索结果
    var _wsFn = webSearchFn || Core.webSearch || null;
    if (_wsFn && childRoleType === 'analyst') {
      var financialKeywords = ['股票', '大盘', 'A股', '港股', '美股', '基金', '行情', '走势', '涨停', '跌停', '指数', '汇率', '期货', '债券', '经济', 'GDP', 'CPI', 'PMI', '利率', '市场', '财经', '分析师', '板块', '龙头', '主力', '资金流', '北向', '融资', 'K线', '均线', '市值', '财报', '分红', '新股', '打新', 'ETF', '港股通', '沪港通'];
      var hasFinancialKeyword = false;
      for (var fki = 0; fki < financialKeywords.length; fki++) {
        if (text.indexOf(financialKeywords[fki]) >= 0) {
          hasFinancialKeyword = true;
          break;
        }
      }
      if (hasFinancialKeyword) {
        try {
          var searchQuery = text.replace(/📕|📘|📗|📙|📄|附件文件|路径:|`[^`]*`/g, '').replace(/请读取|请阅读|请分析|请解读/g, '').trim();
          if (searchQuery.length > 5 && searchQuery.length < 200) {
            var searchResult = await _wsFn(searchQuery);
            if (searchResult && searchResult.trim() && searchResult.length > 30 && !searchResult.includes('未找到有效的搜索结果')) {
              systemMsg = (systemMsg || '') + '\n\n【实时联网搜索结果】\n' + searchResult.substring(0, 5000) + '\n\n请优先基于以上实时搜索结果进行分析，并标注数据来源和时间。如果搜索结果与问题无关，请忽略并使用自身知识。';
            }
          }
        } catch (searchErr) {
          console.warn('⚠️ 分析师联网搜索失败:', searchErr.message);
        }
      }
    }

    // 调用 API（直接传 messagesOverride 绕过当前会话历史）
    var result = await callAPI(text, systemMsg, parseFloat(childSession.temperature) || 0.7, model, provider, bgHistory);

    var aiReply = '';
    if (result && result.message) aiReply = result.message.content || '';
    else if (result && result.choices) aiReply = result.choices[0].message.content || '';
    if (!aiReply && typeof result === 'string') aiReply = result;

    // 🔧 DSML/工具调用输出过滤：检测并清除非自然语言的工具调用格式
    if (aiReply) {
      // 检测 DSML 模式（如 <search query=...> 或类似 XML/DSL 格式的块）
      var dsmlPatterns = [
        /<\w+\s+[^>]*(?:query|online_search|date|source)[^>]*\/?>/gi,
        /\b(?:web_search|search_api|get_stock|get_news)\s*\(\s*\{[^}]*\}\s*\)/gi,
        /```(?:json|xml|yaml)\s*\n?\s*(?:\{[\s\S]*?"(?:function|tool|action|query)"[\s\S]*?\})\s*\n?```/gi,
        /"(?:function|tool_name|action)":\s*"(?:web_search|search|query)"/gi
      ];
      var dsmlCount = 0;
      for (var dpi = 0; dpi < dsmlPatterns.length; dpi++) {
        var matches = aiReply.match(dsmlPatterns[dpi]);
        if (matches) dsmlCount += matches.length;
      }
      // 如果超过 30% 的内容是 DSML 格式，或者 DSML 块数 >= 2，触发清洗
      if (dsmlCount >= 2 || (aiReply.length > 50 && dsmlCount > 0 && aiReply.replace(dsmlPatterns[0], '').replace(dsmlPatterns[1], '').length < aiReply.length * 0.7)) {
        console.warn('⚠️ 检测到 DSML 输出 (' + dsmlCount + ' 处)，正在过滤...');
        // 移除 DSML 块
        var cleaned = aiReply;
        for (var ci = 0; ci < dsmlPatterns.length; ci++) {
          cleaned = cleaned.replace(dsmlPatterns[ci], '');
        }
        // 移除多余的 XML/HTML 标签
        cleaned = cleaned.replace(/<[^>]+>/g, '').replace(/\s{3,}/g, '\n\n').trim();
        if (cleaned.length > 30) {
          aiReply = cleaned;
        } else {
          // 清洗后内容太少，替换为提示信息
          aiReply = '抱歉，我在尝试分析时遇到了技术问题。请直接向我提问，我会用自然语言为您分析。';
        }
      }
    }

    // 保存 AI 回复到子会话
    childSession.messages.push({ role: 'assistant', content: aiReply, timestamp: Date.now() });
    if (Core.session.saveSession) Core.session.saveSession(childSessionId);

    // 给子会话添加未读标记
    if (Core.session.addUnreadToSession) Core.session.addUnreadToSession(childSessionId);

    // 聚合摘要到主管会话
    if (masterSessionId && Core.session.sessions[masterSessionId]) {
      var masterSession = Core.session.sessions[masterSessionId];
      var summary = aiReply.length > 2000 ? aiReply.substring(0, 2000) + '\n\n...(内容较长，完整内容请切换到子会话查看)' : aiReply;
      masterSession.messages.push({
        role: 'assistant',
        content: '📋 ' + roleName + ' 后台任务完成：\n\n' + summary + '\n\n💡 切换到「' + (childSession.title || roleName) + '」查看完整结果',
        timestamp: Date.now()
      });
      if (Core.session.saveSession) Core.session.saveSession(masterSessionId);

      // 如果当前正在查看主管会话，刷新消息显示
      var currentId = Core.session.getCurrentId();
      if (currentId === masterSessionId) {
        if (Core.session.renderMessages) Core.session.renderMessages(masterSessionId);
        if (Core.dom.chatContainer) Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
      }
    }

    _completeBackgroundTask(taskId, 'done');
    _showDesktopNotification('✅ ' + roleName + ' 已完成', aiReply.substring(0, 100) + (aiReply.length > 100 ? '...' : ''));
    console.log('✅ 后台任务完成:', roleName, 'reply长度:', aiReply.length);

  } catch (err) {
    console.error('后台任务失败:', roleName, err);
    _completeBackgroundTask(taskId, 'error');

    // 通知主管会话任务失败
    if (masterSessionId && Core.session.sessions[masterSessionId]) {
      var masterSession = Core.session.sessions[masterSessionId];
      masterSession.messages.push({
        role: 'assistant',
        content: '⚠️ ' + roleName + ' 后台任务失败：' + err.message,
        timestamp: Date.now()
      });
      if (Core.session.saveSession) Core.session.saveSession(masterSessionId);
      var currentId = Core.session.getCurrentId();
      if (currentId === masterSessionId && Core.session.renderMessages) {
        Core.session.renderMessages(masterSessionId);
      }
    }
    _showDesktopNotification('⚠️ ' + roleName + ' 任务失败', err.message);
  }
}


// ===== 辅助：确保模型名包含标签 =====
function ensureModelTag(model) {
  if (!model) return 'qwen2.5:7b';
  if (model.includes(':')) return model;
  if (model === 'qwen2.5') return 'qwen2.5:7b';
  if (model === 'llama3.1') return 'llama3.1:8b';
  if (model === 'llama3.2') return 'llama3.2:3b';
  if (model === 'deepseek-r1') return 'deepseek-r1:7b';
  return model + ':latest';
}

// 🔧 上下文窗口管理：Token 预算替代固定 20 条限制
function _buildHistoryMessages(currentSession, currentSessionId) {
  var historyMessages = [];
  if (!currentSession || !currentSession.messages) return historyMessages;
  if (Core.contextManager && Core.contextManager.getOptimizedContext) {
    var ctx = Core.contextManager.getOptimizedContext(currentSessionId);
    if (ctx) {
      if (ctx.summary) historyMessages.push({ role: 'system', content: ctx.summary });
      ctx.window.forEach(function(msg) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          historyMessages.push({ role: msg.role, content: sanitizeContent(msg.content) });
        }
      });
      return historyMessages;
    }
  }
  // 降级：固定 20 条
  currentSession.messages.slice(-20).forEach(function(msg) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      historyMessages.push({ role: msg.role, content: sanitizeContent(msg.content) });
    }
  });
  return historyMessages;
}

// ===== 核心 API 调用（非流式）=====
async function callAPI(prompt, systemMsg, temperature, model, provider, messagesOverride = null, options = null) {
  // 🔧 provider 为空时回退到当前服务（防止后台模块传 null 导致"不支持的提供商: null"）
  if (!provider) {
    provider = (Core.getCurrentService && Core.getCurrentService()) || Core.currentService || 'ollama';
  }
  
  if (provider !== 'ollama' && Core.cloudApi) {
    // 🔧 修复：当 messagesOverride 存在时（后台任务/子会话），直接构建消息并禁用 function calling
    if (messagesOverride) {
      var cloudMessages = [];
      if (systemMsg) cloudMessages.push({ role: 'system', content: systemMsg });
      for (var cmi = 0; cmi < messagesOverride.length; cmi++) {
        cloudMessages.push(messagesOverride[cmi]);
      }
      var bgCompletion = await Core.cloudApi.callCloudAPI(prompt, systemMsg, temperature, model, provider, {
        messages: cloudMessages,
        disableTools: true
      });
      var bgContent = extractReply(bgCompletion);
      return { message: { content: bgContent, role: 'assistant' } };
    }
    const completion = await Core.cloudApi.callCloudAPI(prompt, systemMsg, temperature, model, provider, options || {});
    // 统一返回格式为 Ollama 兼容格式
    const content = extractReply(completion);
    return { message: { content: content, role: 'assistant' } };
  }

  let messages = messagesOverride;
  if (!messages) {
    messages = [];
    if (systemMsg) messages.push({ role: 'system', content: systemMsg });
    const currentService = Core.getCurrentService();
    let sessions;
    try {
      sessions = Core.session.loadSessionsForService ? Core.session.loadSessionsForService(currentService) : Core.session.sessions;
    } catch (e) { sessions = Core.session.sessions; }
    const currentSessionId = Core.session.getCurrentId();
    const currentSession = sessions && currentSessionId ? sessions[currentSessionId] : null;
    if (currentSession && currentSession.messages) {
      var ctxHistory = _buildHistoryMessages(currentSession, currentSessionId);
      for (var chi = 0; chi < ctxHistory.length; chi++) {
        messages.push(ctxHistory[chi]);
      }
    }
    // 🔧 防重复：session 历史中可能已包含当前用户消息
    var _lastUser = null;
    for (var _mi = messages.length - 1; _mi >= 0; _mi--) {
      if (messages[_mi].role === 'user') { _lastUser = messages[_mi]; break; }
    }
    var _lastUserText = typeof _lastUser?.content === 'string' ? _lastUser.content : '';
    if (_lastUserText !== prompt) {
      messages.push({ role: 'user', content: prompt });
    }
  }

  const fullModel = ensureModelTag(model || Core.config.ollamaModel);
  // 🔧 多模态：提取图片，构建 Ollama images 格式
  const chatMessages = messages.map(function(m) {
    var extracted = extractImagesFromContent(typeof m.content === 'string' ? m.content : '');
    var msg = { role: m.role, content: extracted.text };
    if (extracted.images.length > 0) {
      msg.images = extracted.images.filter(function(img) { return typeof img === 'string'; });
    }
    return msg;
  });
  let tools = [];
  if (Core.toolsRegistry && typeof Core.toolsRegistry.getToolDefinitions === 'function' && Core.getCurrentService() === 'ollama') {
    tools = Core.toolsRegistry.getToolDefinitions();
  }

  const bodyObj = {
    model: fullModel,
    messages: chatMessages,
    stream: false,
    options: { temperature: _tempFloat(temperature), num_predict: -1 }
  };
  if (tools.length > 0) bodyObj.tools = tools;
  // 🔧 #12: 接入 prompt-cache（Ollama keep_alive 减少冷启动）
  if (Core.promptCache && Core.promptCache.enhanceOllama) Core.promptCache.enhanceOllama(bodyObj);

  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(120000) // Phase 5-2: 120秒超时防止无限挂起
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errText}`);
  }

  // 安全解析 JSON，防止非 JSON 响应导致 SyntaxError
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (jsonErr) {
    console.error('❌ API 返回非 JSON 数据:', rawText.substring(0, 200));
    throw new Error(`API 返回格式错误，请检查 Ollama 服务是否正常运行。原始响应: ${rawText.substring(0, 100)}`);
  }

  // 检测是否有工具调用
  if (data.message && data.message.tool_calls && data.message.tool_calls.length > 0) {
    var _toolDepth = (options && options._toolDepth) || 0;
    if (_toolDepth >= 3) {
      console.warn('[callAPI] tool_calls 递归深度超限(3)，跳过工具执行');
      data.message.content = data.message.content || '工具调用次数过多，已停止。';
      return data;
    }
    const toolCall = data.message.tool_calls[0];
    const toolName = toolCall.function.name;
    let params;
    try { params = JSON.parse(toolCall.function.arguments); } catch (pe) {
      console.warn('[callAPI] 工具参数解析失败:', toolCall.function.arguments);
      data.message.content = '工具参数格式错误: ' + pe.message;
      return data;
    }
    if (Core.toolsRegistry && typeof Core.toolsRegistry.executeTool === 'function') {
      try {
        const result = await Core.toolsRegistry.executeTool(toolName, params);
        messages.push({ role: 'assistant', content: data.message.content || '' });
        messages.push({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result) });
        var _recurseOpts = Object.assign({}, options, { _toolDepth: _toolDepth + 1 });
        const finalResponse = await callAPI(null, null, temperature, model, provider, messages, _recurseOpts);
        return finalResponse;
      } catch (err) {
        console.error('工具执行失败:', err);
        data.message.content = `工具执行失败：${err.message}`;
      }
    }
  }
  return data;
}

//  统一提取回复内容（兼容 Ollama 和 OpenAI 格式）
// 同时过滤 DSML 标记（DeepSeek Function Calling 内部标记）
function extractReply(data) {
  if (!data) return '';
  var text = '';
  // Ollama 格式
  if (data.message && data.message.content) text = data.message.content;
  else if (data.response) text = data.response;
  // OpenAI SDK 格式
  else if (data.choices && data.choices[0]) {
    if (data.choices[0].message && data.choices[0].message.content) text = data.choices[0].message.content;
    else if (data.choices[0].text) text = data.choices[0].text;
    else if (data.choices[0].delta && data.choices[0].delta.content) text = data.choices[0].delta.content;
  }
  // 过滤 DSML 标记（所有模型统一处理，防止内部标记泄露）
  // 覆盖: <| DSML || tool_calls>、< | DSML | tool_calls>、| DSML | xxx> 等所有变体
  if (text) {
    // 完整的 tool_calls 块
    text = text.replace(/<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*tool_calls[\s\S]*?<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*\/tool_calls\s*>?/gi, '');
    // 未闭合的 tool_calls 块（截断到末尾）
    text = text.replace(/<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*tool_calls[\s\S]*$/gi, '');
    // 带 < 的单个标记（允许 < 和 | 之间有空格）
    text = text.replace(/<\s*\|{1,3}\s*DSML\s*\|{0,3}\s*[^>\n]*>?/gi, '');
    // 不带 < 的管道符格式
    text = text.replace(/\|{1,3}\s*DSML\s*\|{0,3}\s*[^>\n]*>?/gi, '');
  }
  return text;
}

// ===== 多模态图片提取 =====
function extractImagesFromContent(content) {
  if (!content || typeof content !== 'string') return { text: content || '', images: [] };
  var images = [];
  var text = content;
  // 匹配 ![alt](data:image/...;base64,...)
  var dataUrlRegex = /!\[([^\]]*?)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+)\)/g;
  var match;
  while ((match = dataUrlRegex.exec(content)) !== null) {
    var base64 = match[2];
    // 去掉 data:image/xxx;base64, 前缀
    var commaIdx = base64.indexOf(',');
    if (commaIdx >= 0) base64 = base64.substring(commaIdx + 1);
    // 去掉空白字符
    base64 = base64.replace(/\s/g, '');
    if (base64.length > 100) images.push(base64);
    text = text.replace(match[0], '[图片]');
  }
  // 匹配 ![alt](https://...) 图片URL
  var urlRegex = /!\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g;
  while ((match = urlRegex.exec(content)) !== null) {
    images.push({ url: match[2] });
    text = text.replace(match[0], '[图片]');
  }
  return { text: text, images: images };
}

// 为 OpenAI 兼容格式构建多模态 content
function buildOpenAIContent(text, images) {
  if (!images || images.length === 0) return text;
  var parts = [{ type: 'text', text: text }];
  images.forEach(function(img) {
    if (typeof img === 'string') {
      parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img } });
    } else if (img.url) {
      parts.push({ type: 'image_url', image_url: { url: img.url } });
    }
  });
  return parts;
}


// ===== 流式 API 调用（支持停止生成）=====
async function callAPIStream(prompt, systemMsg, temperature, model, provider, onChunk, signal) {
  let messages = [];
  if (systemMsg) messages.push({ role: 'system', content: systemMsg });
  const currentService = Core.getCurrentService();
  let sessions;
  try {
    sessions = Core.session.loadSessionsForService ? Core.session.loadSessionsForService(currentService) : Core.session.sessions;
  } catch (e) { sessions = Core.session.sessions; }
  const currentSessionId = Core.session.getCurrentId();
  const currentSession = sessions && currentSessionId ? sessions[currentSessionId] : null;
  if (currentSession && currentSession.messages) {
    var ctxHistory2 = _buildHistoryMessages(currentSession, currentSessionId);
    for (var chi2 = 0; chi2 < ctxHistory2.length; chi2++) {
      messages.push(ctxHistory2[chi2]);
    }
  }
  // 🔧 防重复：session 历史中可能已包含当前用户消息
  var _sLastUser = null;
  for (var _si = messages.length - 1; _si >= 0; _si--) {
    if (messages[_si].role === 'user') { _sLastUser = messages[_si]; break; }
  }
  var _sLastUserText = typeof _sLastUser?.content === 'string' ? _sLastUser.content : '';
  if (_sLastUserText !== prompt) {
    messages.push({ role: 'user', content: prompt });
  }

  // 🔧 P5: 云端 API 流式输出（OpenAI SDK 统一版）
  if (provider !== 'ollama' && Core.cloudApi && Core.cloudApi.callCloudAPIStream) {
    return await Core.cloudApi.callCloudAPIStream(prompt, systemMsg, temperature, model, provider, onChunk, signal);
  }

  const fullModel = ensureModelTag(model || Core.config.ollamaModel);
  // 🔧 多模态：提取图片给 Ollama
  const chatMessages = messages.map(function(m) {
    var extracted = extractImagesFromContent(typeof m.content === 'string' ? m.content : '');
    var msg = { role: m.role, content: extracted.text };
    if (extracted.images.length > 0) {
      msg.images = extracted.images.filter(function(img) { return typeof img === 'string'; });
    }
    return msg;
  });

  var streamPayload = {
    model: fullModel,
    messages: chatMessages,
    stream: true,
    options: { temperature: _tempFloat(temperature), num_predict: -1 }
  };
  // 🔧 #12: 接入 prompt-cache（Ollama keep_alive）
  if (Core.promptCache && Core.promptCache.enhanceOllama) Core.promptCache.enhanceOllama(streamPayload);

  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(streamPayload)
  };
  if (signal) fetchOpts.signal = signal;

  const resp = await fetch('http://127.0.0.1:11434/api/chat', fetchOpts);
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API 请求失败 (${resp.status}): ${errText}`);
  }
  if (!resp.body) throw new Error('无响应体');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  // 🔒 #1 修复：追踪流式响应中的 tool_calls（Ollama 在最后一个 chunk 返回）
  var _streamToolCalls = null;
  var _streamToolDepth = (arguments[7] && arguments[7]._toolDepth) || 0;

  while (true) {
    let chunkData;
    try {
      chunkData = await reader.read();
    } catch (readErr) {
      if (signal && signal.aborted) {
        console.log('⏹ 流式读取被中断，返回已生成内容');
        return fullText;
      }
      throw readErr;
    }
    if (chunkData.done) break;
    const chunk = decoder.decode(chunkData.value);
    const lines = chunk.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          fullText += data.message.content;
          onChunk(data.message.content, fullText);
        }
        if (data.response) {
          fullText += data.response;
          onChunk(data.response, fullText);
        }
        // 🔒 #1: 捕获 tool_calls（Ollama 流式模式在最终 chunk 的 message.tool_calls 中返回）
        if (data.message && data.message.tool_calls && data.message.tool_calls.length > 0) {
          _streamToolCalls = data.message.tool_calls;
        }
      } catch (e) { console.warn('⚠️ [api] 解析流式响应数据行失败:', e.message); }
    }
  }

  // 🔒 #1 修复：流式结束后处理 tool_calls（与非流式 callAPI 对齐）
  if (_streamToolCalls && _streamToolCalls.length > 0 && _streamToolDepth < 3) {
    var toolCall = _streamToolCalls[0];
    var toolName = toolCall.function ? toolCall.function.name : (toolCall.name || '');
    var toolParams = {};
    try {
      toolParams = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : (toolCall.function.arguments || toolCall.arguments || {});
    } catch (pe) {
      console.warn('[callAPIStream] 工具参数解析失败:', pe.message);
      return fullText || '工具参数格式错误';
    }
    if (Core.toolsRegistry && typeof Core.toolsRegistry.executeTool === 'function' && toolName) {
      try {
        console.log('[callAPIStream] 执行工具:', toolName, JSON.stringify(toolParams).substring(0, 200));
        var toolResult = await Core.toolsRegistry.executeTool(toolName, toolParams);
        // 将 assistant 回复（含 tool_calls）和工具结果追加到 messages
        messages.push({ role: 'assistant', content: fullText || '' });
        messages.push({ role: 'tool', content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult) });
        // 递归发起新的流式请求（深度 +1）
        var _recurseSignal = signal || null;
        var _depthOpts = { _toolDepth: _streamToolDepth + 1 };
        // 直接重新调用 callAPIStream（messages 已包含工具结果）
        var toolFullText = await _callAPIStreamWithMessages(messages, fullModel, temperature, onChunk, _recurseSignal, _depthOpts);
        return fullText + '\n\n' + toolFullText;
      } catch (toolErr) {
        console.error('[callAPIStream] 工具执行失败:', toolErr);
        return fullText + '\n\n⚠️ 工具执行失败：' + toolErr.message;
      }
    }
  } else if (_streamToolCalls && _streamToolDepth >= 3) {
    console.warn('[callAPIStream] tool_calls 递归深度超限(3)，跳过工具执行');
  }

  return fullText;
}

// 🔒 #1 辅助：基于已有 messages 数组发起流式请求（供 tool_calls 递归使用）
async function _callAPIStreamWithMessages(messages, fullModel, temperature, onChunk, signal, depthOpts) {
  var chatMsgs = messages.map(function(m) {
    var extracted = extractImagesFromContent(typeof m.content === 'string' ? m.content : '');
    var msg = { role: m.role, content: extracted.text };
    if (extracted.images && extracted.images.length > 0) {
      msg.images = extracted.images.filter(function(img) { return typeof img === 'string'; });
    }
    return msg;
  });
  var payload = {
    model: fullModel,
    messages: chatMsgs,
    stream: true,
    options: { temperature: _tempFloat(temperature), num_predict: -1 }
  };
  if (Core.promptCache && Core.promptCache.enhanceOllama) Core.promptCache.enhanceOllama(payload);
  var fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
  if (signal) fetchOpts.signal = signal;
  var resp = await fetch('http://127.0.0.1:11434/api/chat', fetchOpts);
  if (!resp.ok) throw new Error('API 请求失败 (' + resp.status + ')');
  if (!resp.body) throw new Error('无响应体');
  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  var text = '';
  var _toolCalls = null;
  var _depth = (depthOpts && depthOpts._toolDepth) || 0;
  while (true) {
    var cd;
    try { cd = await reader.read(); } catch (e) {
      if (signal && signal.aborted) return text;
      throw e;
    }
    if (cd.done) break;
    var lines = decoder.decode(cd.value).split('\n').filter(function(l) { return l.trim(); });
    for (var li = 0; li < lines.length; li++) {
      try {
        var d = JSON.parse(lines[li]);
        if (d.message && d.message.content) { text += d.message.content; onChunk(d.message.content, text); }
        if (d.response) { text += d.response; onChunk(d.response, text); }
        if (d.message && d.message.tool_calls && d.message.tool_calls.length > 0) _toolCalls = d.message.tool_calls;
      } catch (e) { /* skip */ }
    }
  }
  // 递归处理嵌套 tool_calls
  if (_toolCalls && _toolCalls.length > 0 && _depth < 3 && Core.toolsRegistry && Core.toolsRegistry.executeTool) {
    var tc = _toolCalls[0];
    var tn = tc.function ? tc.function.name : (tc.name || '');
    var tp = {};
    try { tp = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); } catch (e) { return text; }
    if (tn) {
      try {
        var tr = await Core.toolsRegistry.executeTool(tn, tp);
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'tool', content: typeof tr === 'string' ? tr : JSON.stringify(tr) });
        var deeper = await _callAPIStreamWithMessages(messages, fullModel, temperature, onChunk, signal, { _toolDepth: _depth + 1 });
        return text + '\n\n' + deeper;
      } catch (e) { return text + '\n\n⚠️ 工具执行失败：' + e.message; }
    }
  }
  return text;
}

// ===== 图像描述 =====
async function describeImage(base64Image, prompt = '请描述这张图片的内容', mode = 'describe') {
  try {
    // 🔧 优先使用后端 /api/image API（支持 OCR + sharp + tesseract）
    try {
      const response = await fetch(Core.getBackendBase() + '/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64Image,
          type: mode, // 'describe', 'ocr', 'full'
          prompt: prompt,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          // 根据模式返回不同内容
          if (mode === 'ocr' && data.ocr && data.ocr.text) {
            return `📝 OCR 识别结果：\n${data.ocr.text}`;
          }
          if (mode === 'full') {
            let result = '';
            if (data.description) result += `🖼️ 图片描述：${data.description}\n\n`;
            if (data.ocr && data.ocr.text) result += `📝 OCR 文字：${data.ocr.text}`;
            return result || '无法分析图片';
          }
          return data.description || '无法生成描述';
        }
      }
    } catch (e) {
      console.warn('⚠️ 后端 /api/image 不可用，回退到直接调用 Ollama:', e.message);
    }
    
    // 回退：直接调用 Ollama llava 模型
    const url = 'http://127.0.0.1:11434/api/generate';
    const body = JSON.stringify({
      model: 'llava:7b',
      prompt: prompt,
      stream: false,
      images: [base64Image],
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama 请求失败 (${response.status}): ${errText}`);
    }
    const data = await response.json();
    return data.response || '无法生成图片描述';
  } catch (err) {
    console.error('❌ 图像描述失败:', err);
    throw err;
  }
}


// ===== 发送消息 =====
// 🔒 #9 修复：Promise 链互斥锁，替代简单布尔信号量，防止同一微任务内的并发调用
var _sendLock = Promise.resolve();
async function sendMessage() {
  // 将实际逻辑包裹在锁链中，确保串行执行
  _sendLock = _sendLock.then(_doSendMessage).catch(function(e) {
    console.error('sendMessage 锁链异常:', e);
  });
  return _sendLock;
}
async function _doSendMessage() {
  // 快捷指令拦截（入口级，防止 Enter 键绕过 wrappedSendMessage）
  const inputText = Core.dom.input.value.trim();
  if (inputText && inputText.startsWith('/') && Core.custom && Core.custom.executeCommand) {
    const handled = Core.custom.executeCommand(inputText);
    if (handled) {
      Core.dom.input.value = '';
      return;
    }
  }

  try {
    // 如果当前会话正在生成，点击按钮=停止生成
    var currentId = Core.session.getCurrentId();
    var currentState = getSessionState(currentId);
    if (currentState.isGenerating) {
      stopGeneration(currentId);
      return;
    }

    const input = Core.dom.input;
    let text = input.value.trim();

    // Guardrails Layer 1: 输入守卫 — Prompt Injection 检测
    if (Core.guardrails && text) {
      var inputCheck = Core.guardrails.checkInput(text);
      if (!inputCheck.safe) {
        Core.dom.status.textContent = '🛡️ ' + inputCheck.reason;
        if (Core.showNotification) Core.showNotification(inputCheck.reason, 'warning');
        return;
      }
    }

    // 🔧 多模态：收集所有待发送图片（旧 single + 新 multiple）
    var allImages = [];
    var pendingImage = Core.pendingImage;
    if (pendingImage) {
      allImages.push('![图片](' + pendingImage + ')');
      Core.pendingImage = null;
      var preview = document.getElementById('attachmentPreview');
      if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    }
    // 新多图片附件
    if (typeof getPendingImagesMarkdown === 'function' && _pendingImages && _pendingImages.length > 0) {
      var imgMd = getPendingImagesMarkdown();
      if (imgMd) allImages.push(imgMd);
      clearPendingImages();
    }
    if (allImages.length > 0) {
      text = allImages.join('\n') + (text ? '\n\n' + text : '');
    }

    // 🔧 文件附件处理：拖拽的文档文件 — 读取内容后发送给 AI
    var pendingFiles = Core.pendingFiles || [];
    var _displayText = text;  // 用户输入框文本（用于聊天显示）
    var _apiText = text;      // API 发送文本（包含文件内容）
    if (pendingFiles.length > 0) {
      var fileDisplayParts = [];  // 显示用：简短引用
      var fileContentParts = [];  // API用：完整内容
      // 并发读取所有文件内容
      var TEXT_EXTS = ['.txt','.md','.json','.log','.html','.htm','.xml','.yaml','.yml','.ini','.cfg','.conf','.py','.js','.ts','.jsx','.tsx','.bat','.sh','.cmd','.sql','.toml','.env','.gitignore','.editorconfig','.css','.scss','.less','.vue','.svelte','.go','.rs','.java','.c','.cpp','.h','.hpp','.rb','.php','.swift','.kt','.r','.m','.svg','.tsv','.diff','.patch','.properties','.dockerfile','.makefile','.gradle'];
      var DOC_EXTS = ['.pdf','.docx','.doc','.xlsx','.xls','.csv','.pptx','.ppt'];
      var fileReadPromises = pendingFiles.map(function(pf, idx) {
        var ext = path.extname(pf.name).toLowerCase();
        if (Core.docHandler && Core.docHandler.readDocument && DOC_EXTS.indexOf(ext) >= 0) {
          Core.dom.status.textContent = '📄 正在读取 ' + pf.name + '...';
          return Core.docHandler.readDocument(pf.path).then(function(result) {
            return { pf: pf, result: result };
          }).catch(function(err) {
            console.warn('⚠️ 文件读取失败:', pf.name, err.message);
            return { pf: pf, result: null };
          });
        }
        // 🔧 纯文本格式：直接用 fs.readFileSync 读取
        if (TEXT_EXTS.indexOf(ext) >= 0) {
          try {
            var rawBuf = fs.readFileSync(pf.path);
            var textContent = rawBuf.toString('utf8');
            // 检测是否为GBK编码（UTF-8读取后大量替换字符说明编码不对）
            var replacementCount = (textContent.match(/\uFFFD/g) || []).length;
            if (replacementCount > textContent.length * 0.1) {
              // 尝试用 latin1 保留原始字节，比乱码好
              textContent = rawBuf.toString('latin1');
              console.log('📄 文件疑似GBK编码，使用latin1解码:', pf.name);
            }
            // 净化：移除控制字符（保留换行/制表符）+ 限制长度
            textContent = textContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
            if (textContent.length > 30000) textContent = textContent.substring(0, 30000) + '\n\n...(内容过长，已截取前30000字符)';
            return Promise.resolve({ pf: pf, result: { success: true, text: textContent, meta: { numPages: 1 } } });
          } catch (err) {
            console.warn('⚠️ 文本文件读取失败:', pf.name, err.message);
            return Promise.resolve({ pf: pf, result: { success: false, error: err.message } });
          }
        }
        return Promise.resolve({ pf: pf, result: null });
      });
      var fileReadResults = await Promise.all(fileReadPromises);
      for (var fri = 0; fri < fileReadResults.length; fri++) {
        var fr = fileReadResults[fri];
        var pf = fr.pf;
        var result = fr.result;
        // 显示部分：始终只显示文件名引用
        fileDisplayParts.push(pf.icon + ' 附件：' + pf.name);
        if (result && result.success && result.text) {
          var fileText = result.text;
          var pageCount = result.meta && result.meta.numPages ? result.meta.numPages : '?';
          // API部分：包含完整内容
          if (fileText.length > 15000) {
            fileContentParts.push(pf.icon + ' **附件文件「' + pf.name + '」**（共' + pageCount + '页，已截取前15000字符）：\n\n' + fileText.substring(0, 15000));
          } else {
            fileContentParts.push(pf.icon + ' **附件文件「' + pf.name + '」**（共' + pageCount + '页）：\n\n' + fileText);
          }
          console.log('✅ 文件读取成功:', pf.name, '长度:', fileText.length);
        } else {
          var errMsg = (result && result.error) ? result.error : '读取失败';
          fileContentParts.push(pf.icon + ' 附件文件「' + pf.name + '」路径: `' + pf.path + '`（文件读取失败: ' + errMsg + '）');
          console.warn('⚠️ 文件读取失败:', pf.name, errMsg);
        }
      }
      // 显示文本：简短的文件引用 + 用户输入
      var fileDisplayStr = fileDisplayParts.join('  ');
      _displayText = fileDisplayStr + (_displayText ? '\n' + _displayText : '');
      // API文本：完整文件内容 + 用户输入
      _apiText = fileContentParts.join('\n\n---\n\n') + (_apiText ? '\n\n用户提问：' + _apiText : '\n\n请阅读以上附件文件的内容并进行详细分析。');
      // 清除附件预览
      Core.clearPendingFiles();
    }
    // text 用于显示，_apiText 用于 API 调用
    text = _displayText || text;
    var apiText = _apiText || text;

    if (!text) {
      Core.dom.sendBtn.disabled = false;
      Core.dom.input.focus();
      return;
    }
    input.value = '';
    // 发送后清除草稿
    var sid = Core.session.getCurrentId();
    if (sid && Core.session.sessions[sid]) delete Core.session.sessions[sid]._draft;
    Core.dom.sendBtn.disabled = true;

    // 1. 先处理命令
    const isCommand = await Core.commandHandler.handleCommand(text);
    if (isCommand) {
      // 追踪命令使用
      if (Core.skillSuggest && Core.skillSuggest.trackCommand) {
        Core.skillSuggest.trackCommand(text.substring(1));
      }
      Core.dom.sendBtn.disabled = false;
      Core.dom.input.focus();
      return;
    }

    // ⏰ /remind 自然语言触发：无需输入命令，直接说"每天三点半推送给我最新的大盘情况"即可自动建好定时任务。
    // Agent 模式下同样拦截——"每天X点推送Y"这类句式本身足够明确，双重门槛（意图词+具体时间）已防住绝大多数误判；
    // 显式 /agent 前缀的命令仍交给 Agent（detectReminderIntent 内部会拒绝以 / 开头的消息）。可通过 config.autoRemindDetect=false 关闭。
    if (Core.scheduler && Core.scheduler.tryNaturalRemind && Core.config.autoRemindDetect !== false) {
      try {
        var remindResult = Core.scheduler.tryNaturalRemind(text);
        if (remindResult) {
          // 显示用户消息（让用户看到自己说的话）
          Core.session.addMessage(text, 'user');
          // 组装确认信息
          var nextRunStr = remindResult.task.nextRun ? new Date(remindResult.task.nextRun).toLocaleString('zh-CN') : 'N/A';
          var actionDesc = remindResult.actionType === 'send'
            ? '到点自动发送「' + remindResult.content + '」给我处理'
            : '到点弹窗提醒「' + remindResult.content + '」';
          var confirmText = '✅ 好的，已为你设置定时任务：\n\n' +
            '⏰ **' + remindResult.task.name + '**\n' +
            '调度：' + Core.scheduler.describeSchedule(remindResult.schedule) + '\n' +
            '动作：' + actionDesc + '\n' +
            '下次执行：' + nextRunStr + '\n\n' +
            '如需取消，输入 `/schedule list` 查看任务 ID，再用 `/schedule delete <ID>` 删除。';
          Core.session.addMessage(confirmText, 'ai');
          var _remindSid = Core.session.getCurrentId();
          if (_remindSid && Core.session.renderMessages) Core.session.renderMessages(_remindSid);
          console.log('⏰ 自然语言提醒已创建:', remindResult.task.name, JSON.stringify(remindResult.schedule));
          Core.dom.sendBtn.disabled = false;
          Core.dom.input.focus();
          return;
        }
      } catch (e) { console.warn('⚠️ [api] 自然语言提醒检测失败:', e.message); }
    }

    // 🔧 智能记忆自动提取：从用户消息中检测值得记住的信息
    if (Core.memory && Core.memory.autoExtract && Core.config.autoMemoryExtract !== false) {
      try {
        var extracted = Core.memory.autoExtract(text);
        var newMemCount = 0;
        for (var ei = 0; ei < extracted.length; ei++) {
          var mem = extracted[ei];
          if (!Core.memory.isDuplicate(mem.content)) {
            // 重要性感知：explicit 和 identity 标记为 critical
            var importance = (mem.tags === 'explicit' || mem.tags === 'identity') ? 'critical' : 'normal';
            if (Core.memoryEnhance && Core.memoryEnhance.addWithImportance) {
              Core.memoryEnhance.addWithImportance(mem.content, mem.tags, importance);
            } else {
              Core.memory.add(mem.content, mem.tags);
            }
            newMemCount++;
            console.log('🧠 自动记忆[' + importance + ']:', mem.content);
          }
        }
        // 有新记忆时异步更新用户画像
        if (newMemCount > 0 && Core.memoryEnhance && Core.memoryEnhance.buildProfile) {
          setTimeout(function() { Core.memoryEnhance.buildProfile(); }, 500);
        }
      } catch (e) { console.warn('⚠️ [api] 自动记忆提取失败:', e.message); }
    }

    // Phase 4-1：分析追踪 — 记录用户消息 + 命令使用
    try {
      if (Core.analytics && Core.analytics.track) {
        Core.analytics.track.message('user');
        if (text.startsWith('/')) {
          var cmdName = text.split(/\s/)[0];
          Core.analytics.track.command(cmdName);
        }
      }
    } catch (e) { console.warn('⚠️ [api] 分析追踪(用户消息)失败:', e.message); }

    // 2. 获取当前会话信息
    let currentSession = null;
    try {
      const id = Core.session.getCurrentId();
      const sessions = Core.session.sessions || {};
      currentSession = id ? sessions[id] : null;
    } catch (e) { console.warn('获取会话失败:', e); }
    const isMaster = currentSession && currentSession.title &&
      (currentSession.title.includes('置顶') || currentSession.title.includes('主管'));

    // 3. Agent 模式检测（支持 /agent 前缀 + UI 切换按钮双触发）
    const isDeepThinkActive = Core.dom.deepThinkBtn && Core.dom.deepThinkBtn.classList.contains('active');
    const isAgentCmd = text.toLowerCase().startsWith('/agent ');
    const isAgentToggle = Core.config.agentMode === true;
    const isAgentMode = isAgentCmd || isAgentToggle;
    const agentTask = isAgentCmd ? text.slice(7).trim() : text;

    if (isAgentMode) {
      try {
        // 🔧 先显示用户消息（不要等Agent完成才显示）
        Core.session.addMessage(agentTask, 'user');
        // 🔧 如果有文件附件内容，传给Agent（apiText包含完整文件内容）
        var agentInput = (apiText && apiText !== agentTask) ? apiText : agentTask;
        const agentResult = await Core.agentLoop.sendToAgent(agentInput, isDeepThinkActive);
        if (agentResult.success) {
          var agentReply = agentResult.reply;
          // Guardrails Layer 2: Agent 回复输出守卫
          if (Core.guardrails && agentReply) {
            var agentOutputCheck = Core.guardrails.checkOutput(agentReply);
            if (!agentOutputCheck.safe && agentOutputCheck.cleaned) {
              console.warn('[Agent] ' + agentOutputCheck.reason);
              agentReply = agentOutputCheck.cleaned;
            }
          }
          // 🔧 只存数据不渲染DOM（agent-loop已经把回答渲染到agentDiv了）
          var _sid = Core.session.getCurrentId();
          if (_sid && Core.session.sessions[_sid]) {
            Core.session.sessions[_sid].messages.push({ role: 'ai', content: agentReply, timestamp: Date.now() });
            if (Core.session.saveSession) Core.session.saveSession(_sid);
          }
        }
      } catch (err) {
        console.error('Agent模式错误:', err);
        setGeneratingState(false, Core.session.getCurrentId());
        try {
          await Core.chatHandler.handleNormalChat(text, '', apiText);
        } catch (chatErr) {
          console.error('Agent回退到普通聊天失败:', chatErr);
          Core.emit('ai:error', { message: chatErr.message || 'Agent 处理失败', context: 'agent', time: Date.now() });
        }
      }
      Core.dom.input.focus();
      return;
    }

    // 4. 🔧 统一路由决策（合并主管模式路由 + 智能路由，消除冲突）
    if (Core.routing && Core.routing.analyzeMessage) {
      var routeResult = Core.routing.analyzeMessage(text, {
        roleType: currentSession ? currentSession.roleType : '',
        autoRoute: Core.config.autoRoute === true,
      });

      if (routeResult) {
        // ===== 主管模式后台分发 =====
        if (routeResult.routeType === 'master-dispatch') {
          console.log('📨 统一路由分发: ' + routeResult.roleId + ' → 后台任务');

          // 查找或创建子角色会话（不切换当前视图）
          var allSessions = Core.session.sessions || {};
          var roleSessionId = null;
          for (var sid in allSessions) {
            if (allSessions[sid].roleType === routeResult.roleType && allSessions[sid].parentId === currentId) {
              roleSessionId = sid;
              break;
            }
          }
          if (!roleSessionId) {
            roleSessionId = Core.session.newChat(routeResult.roleId, currentId);
            Core.session.switchSession(currentId);
            console.log('创建后台子会话:', routeResult.roleId, 'id=', roleSessionId);
          }

          // 在主管会话中显示分发确认
          Core.session.addMessage('📨 已分发至 ' + routeResult.displayName + '（后台执行中）\n\n任务：' + text, 'ai');
          Core.dom.status.textContent = '📨 已分发至 ' + routeResult.displayName + '（后台运行）';

          // 启动后台任务（fire-and-forget）— 使用 apiText 包含文件内容
          runBackgroundTask(roleSessionId, apiText, currentId, routeResult.displayName);

          // 🔧 sendBtn 由 finally 块统一恢复，此处不提前启用，防止快速双击
          Core.dom.input.focus();
          return;
        }

        // ===== 智能路由同步转发 =====
        if (routeResult.routeType === 'agent-route') {
          try {
            Core.dom.status.textContent = '🎯 智能路由 → ' + routeResult.displayName + '...';
            const agentResult = await Core.routing.routeMessage(apiText);
            if (agentResult && agentResult.success) {
              console.log('✅ 智能路由完成: 代理=' + agentResult.agentName + ', 会话=' + agentResult.sessionId);
              if (Core.renderMessage) {
                Core.renderMessage(text, 'user');
                Core.renderMessage(agentResult.reply, 'ai');
              }
              Core.dom.status.textContent = '✅ ' + agentResult.agentName + ' 已回复';
              Core.dom.sendBtn.disabled = false;
              Core.dom.input.focus();
              return;
            }
            // 路由失败，打印警告但继续走普通聊天流程
            console.warn('⚠️ 智能路由未成功:', agentResult ? agentResult.error : '无结果', '，回退到普通聊天');
          } catch (routeErr) {
            console.warn('⚠️ 智能路由异常:', routeErr.message, '，回退到普通聊天');
          }
        }
      }
    }

    // 插件 beforeSend 钩子
    try {
      if (Core.plugins && Core.plugins.callHook) {
        const hookResult = await Core.plugins.callHook('beforeSend', text);
        if (hookResult === null) {
          console.log('插件阻断了消息发送');
          Core.dom.sendBtn.disabled = false;
          Core.dom.input.focus();
          return;
        }
        if (typeof hookResult === 'string') {
          text = hookResult;
        }
      }
    } catch (e) {
      console.warn('beforeSend 钩子执行失败:', e.message);
    }

    // 5. 知识库自动检索（使用 RRF 融合搜索 + 源引用）
    var knowledgeContext = '';
    var hasKnowledgeDocs = false;
    try {
      if (Core.knowledge && Core.knowledge.listDocuments) {
        hasKnowledgeDocs = (Core.knowledge.listDocuments() || []).length > 0;
      }
    } catch (e) { console.warn('⚠️ [api] 知识库文档列表检查失败:', e.message); }
    if (hasKnowledgeDocs && Core.knowledge) {
      try {
        // 🔥 优先查蒸馏索引（热缓存层，毫秒级）
        var distilledHit = false;
        if (Core.knowledgeDistill && Core.knowledgeDistill.searchDistilled) {
          var distilledResult = Core.knowledgeDistill.searchDistilled(text, 3);
          if (distilledResult && distilledResult.results && distilledResult.results.length > 0) {
            knowledgeContext = distilledResult.context + '\n\n📚 参考来源（蒸馏）：\n' + distilledResult.citations;
            console.log('[distill] 蒸馏索引命中', distilledResult.results.length, '条主题');
            distilledHit = true;
          }
        }

        // 蒸馏未命中 → 全量 BM25/RRF 检索
        if (!distilledHit) {
          if (Core.knowledge.searchWithCitations) {
            var kbResult = await Core.knowledge.searchWithCitations(text, 3);
            if (kbResult && kbResult.results && kbResult.results.length > 0) {
              knowledgeContext = kbResult.context + '\n\n📚 参考来源：\n' + kbResult.citations;
              console.log('知识库 RRF 检索到', kbResult.results.length, '条相关片段');
            }
          } else if (Core.knowledge.search) {
            var knowledgeResults = await Core.knowledge.search(text, 3);
            if (knowledgeResults && knowledgeResults.length > 0) {
              knowledgeContext = '';
              knowledgeResults.forEach(function(r) {
                knowledgeContext += '---\n来源：' + (r.fileName || '未知') + '\n' + (r.text || '').substring(0, 300) + '\n';
              });
              console.log('知识库检索到', knowledgeResults.length, '条相关片段');
            }
          }
        }
      } catch (err) {
        console.warn('知识库检索失败:', err.message);
      }
    }

    // 6. 普通聊天
    try {
      await Core.chatHandler.handleNormalChat(text, knowledgeContext, apiText);
    } catch (err) {
      console.error('普通聊天错误:', err);
      Core.dom.status.textContent = '请求失败，请检查配置';
      Core.emit('ai:error', { message: err.message || '请求失败，请检查配置', context: 'chat', time: Date.now() });
    } finally {
      Core.dom.sendBtn.disabled = false;
    }
    Core.dom.input.focus();
  } catch (err) {
    console.error('sendMessage 全局错误:', err);
    Core.dom.status.textContent = '发送失败: ' + err.message;
    Core.emit('ai:error', { message: err.message || '发送失败', context: 'send', time: Date.now() });
    Core.dom.sendBtn.disabled = false;
    Core.dom.input.focus();
  } finally {
    // 🔒 #9: Promise 链自动释放，无需手动重置
  }
}
module.exports = {
  name: 'api',
  dependencies: ['error-handler', 'search', 'routing', 'custom', 'session', 'command-handler', 'chat-handler', 'agent-loop', 'scheduler'],
  init(_Core) {
    Core = _Core;
    // 🔧 按钮点击事件由 index.html 中的 initStopGeneration 绑定
    // Core.dom.sendBtn.addEventListener('click', sendMessage);
    // 🔧 Enter 发送由 session.js 统一处理（含 Shift+Enter 换行守卫）
    // addTimestamp is now in chat-handler.js
    // Core.addTimestamp is set by chat-handler.init()
    // 定义 Core.renderMessage（供 custom.js 等模块使用）
    if (!Core.renderMessage) {
      Core.renderMessage = function(content, role) {
        const div = document.createElement('div');
        div.className = 'msg ' + (role === 'assistant' || role === 'ai' ? 'ai' : 'user');
        if (Core.config.chatBubbleAI && (role === 'assistant' || role === 'ai')) {
          div.style.backgroundColor = Core.config.chatBubbleAI;
        }
        if (Core.config.chatBubbleUser && role === 'user') {
          div.style.backgroundColor = Core.config.chatBubbleUser;
        }
        if (window.marked) {
          div.innerHTML = Core.renderMarkdown(content);
        } else {
          div.textContent = content;
        }
        Core.dom.chatContainer.appendChild(div);
        Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
      };
    }
    // Expose internal helpers for extracted modules
    Core._setGeneratingState = setGeneratingState;
    Core._apiGetSessionState = getSessionState;
    Core._sanitizeContent = sanitizeContent;

    Core.api = {
      sendMessage: sendMessage,
      callAPI: callAPI,
      callAPIStream: callAPIStream,
      extractReply: extractReply,
      describeImage: describeImage,
      sendToAgent: function() { return Core.agentLoop.sendToAgent.apply(null, arguments); },  // delegate to agent-loop
      stopGeneration: stopGeneration,
      isGenerating: () => getSessionState(Core.session.getCurrentId()).isGenerating,
      getBackgroundTasks: getBackgroundTasks,
      runBackgroundTask: runBackgroundTask,
      switchAndRetry: function(targetProvider) {
        // 切换到目标 provider 的模型并重试
        if (!Core.dom.modelSelect) return;
        var options = Core.dom.modelSelect.options;
        for (var i = 0; i < options.length; i++) {
          if (options[i].value.startsWith(targetProvider + ':') || options[i].value === targetProvider) {
            Core.dom.modelSelect.selectedIndex = i;
            if (Core.errorHandler) Core.errorHandler.showSuccessToast('已切换到 ' + targetProvider);
            // 触发重试
            setTimeout(function() { sendMessage(); }, 300);
            return;
          }
        }
        if (Core.errorHandler) Core.errorHandler.showWarningToast('未找到 ' + targetProvider + ' 的模型');
      },
    };
    // 🔧 修复：同时检查 Core.webSearch 是否已存在（解决事件时序问题）
    if (Core.webSearch) {
      webSearchFn = Core.webSearch;
      console.log('✅ 联网搜索函数已从 Core.webSearch 获取');
    }
    Core.on('searchReady', (fn) => {
      webSearchFn = fn;
      console.log('✅ 联网搜索函数已通过事件注册');
    });
    console.log('✅ API模块已加载 v20250709 — 流式输出 + 停止生成 + Agent循环 + Markdown渲染');
  }
};