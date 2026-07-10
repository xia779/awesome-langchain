// modules/chat-handler.js - 普通聊天处理器
// 从 api.js 提取，处理普通聊天、流式输出、打字机效果等
const path = require('path');
const { ipcRenderer } = require('electron');

let Core = null;

// ===== P5: 打字机效果（返回 Promise）=====
function typewriterEffect(element, fullText) {
  return new Promise(function(resolve) {
    if (!element || !fullText) {
      resolve();
      return;
    }
    
    var CHAR_SPEED = 12; // 每字 12ms
    var MAX_TYPING_TIME = 2500; // 最多 2.5 秒
    var speed = Math.max(5, Math.min(CHAR_SPEED, MAX_TYPING_TIME / fullText.length));
    
    var index = 0;
    element.innerHTML = '<span class="typing-cursor"></span>';
    
    var contentSpan = document.createElement('span');
    contentSpan.className = 'typewriter-content';
    var cursor = element.querySelector('.typing-cursor');
    if (cursor) {
      element.insertBefore(contentSpan, cursor);
    } else {
      element.appendChild(contentSpan);
    }
    
    function typeNext() {
      if (index < fullText.length) {
        contentSpan.textContent += fullText[index];
        index++;
        
        // 自动滚动
        var container = document.getElementById('chatContainer');
        if (container) container.scrollTop = container.scrollHeight;
        
        setTimeout(typeNext, speed);
      } else {
        // 打字完成，移除光标
        var c = element.querySelector('.typing-cursor');
        if (c) c.remove();
        resolve();
      }
    }
    
    typeNext();
  });
}
// ===== 消息时间戳辅助函数 =====
function addTimestamp(msgDiv) {
  if (!msgDiv) return;
  if (msgDiv.querySelector('.msg-timestamp')) return;
  var now = new Date();
  var hours = String(now.getHours()).padStart(2, '0');
  var minutes = String(now.getMinutes()).padStart(2, '0');
  var timeStr = hours + ':' + minutes;
  var fullStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + ' ' + timeStr + ':' + String(now.getSeconds()).padStart(2, '0');
  var tsSpan = document.createElement('span');
  tsSpan.className = 'msg-timestamp';
  tsSpan.textContent = timeStr;
  tsSpan.title = fullStr;
  // Let CSS handle colors based on .msg.user / .msg.ai classes and dark/light theme
  tsSpan.style.cssText = 'display:block;text-align:right;margin-top:6px;font-size:11px;padding:2px 6px;border-radius:4px;width:fit-content;margin-left:auto;';
  msgDiv.appendChild(tsSpan);
}
// ===== 普通聊天（支持流式输出 + Markdown渲染）=====
async function handleNormalChat(text, knowledgeContext, apiText) {
  // 🔧 快捷指令双重检查（防止 wrappedSendMessage 未拦截）
  if (text && text.startsWith('/') && Core.custom && Core.custom.executeCommand) {
    var handled = Core.custom.executeCommand(text);
    if (handled) {
      console.log('✅ 快捷指令已拦截（api.js）:', text);
      return;
    }
  }
  // apiText 包含完整文件内容，用于 API 调用；text 仅用于界面显示
  var promptForAPI = apiText || text;
  
  const service = Core.getCurrentService();
  let sessions, currentSessionId;
  try {
    sessions = Core.session.loadSessionsForService ? Core.session.loadSessionsForService(service) : Core.session.sessions;
    currentSessionId = Core.session.getCurrentId();
  } catch (e) {
    sessions = Core.session.sessions;
    currentSessionId = Core.session.getCurrentId();
  }

  // 🔧 如果提供了知识库上下文，附加到用户消息
  var finalText = text;
  if (knowledgeContext && knowledgeContext.trim()) {
    finalText = text + '\n\n[知识库检索结果]\n' + knowledgeContext;
    console.log('✅ 知识库上下文已附加，长度:', knowledgeContext.length);
  }

  let sessionData = sessions && currentSessionId ? sessions[currentSessionId] : null;
  if (!sessionData) {
    const newId = Core.generateId();
    if (Core.session.setCurrentId) Core.session.setCurrentId(newId);
    sessionData = { title: text.slice(0, 20), messages: [], pinned: false };
    try {
      if (Core.session.saveSessionForService) {
        Core.session.saveSessionForService(service, newId, sessionData);
      } else {
        Core.session.sessions[newId] = sessionData;
        Core.session.saveSession(newId);
      }
    } catch (e) { console.warn('创建新会话失败:', e); }
    if (Core.session.renderChatList) Core.session.renderChatList();
    currentSessionId = newId;
  }

  // 添加用户消息
  sessionData.messages.push({ role: 'user', content: text, timestamp: Date.now() });
  // 🔧 仅在未手动重命名时自动更新标题
  if (!sessionData._manuallyRenamed) {
    const firstUser = sessionData.messages.find(m => m.role === 'user');
    if (firstUser) {
      sessionData.title = firstUser.content.substring(0, 20) + (firstUser.content.length > 20 ? '...' : '');
    }
  }
  try {
    if (Core.session.saveSessionForService) {
      Core.session.saveSessionForService(service, currentSessionId, sessionData);
    } else {
      Core.session.saveSession(currentSessionId);
    }
  } catch (e) { console.warn('保存用户消息失败:', e); }

  // 渲染用户消息
  const userDiv = document.createElement('div');
  userDiv.className = 'msg user';
  if (Core.config.chatBubbleUser) userDiv.style.backgroundColor = Core.config.chatBubbleUser;
  userDiv.textContent = text;
  addTimestamp(userDiv); // 添加时间戳
  Core.dom.chatContainer.appendChild(userDiv);
  Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
  
  // 🔧 P5: 发送状态指示
  Core.dom.status.textContent = '📤 正在发送...';

  // 准备模型参数（自动路由：仅在用户未手动选择模型时生效）
  const autoRoute = Core.config.autoRoute;
  let selectedValue = Core.dom.modelSelect.value;
  // 🔧 诊断日志：确认用户实际选择的模型
  // 🔧 额外诊断：检查 selectedIndex 和选项
  if (Core.dom.modelSelect.selectedIndex >= 0) {
    const opt = Core.dom.modelSelect.options[Core.dom.modelSelect.selectedIndex];
  }
  
  // 🔧 修复：自动路由只在用户未手动选择模型时生效
  // 如果用户已经手动选择了模型（不是默认的ollama），保留用户选择
  if (autoRoute && selectedValue.startsWith('ollama:')) {
    const webSearchActive = Core.dom.webSearchBtn.classList.contains('active') && !Core.dom.webSearchBtn.disabled;
    const options = Core.dom.modelSelect.options;
    let targetProvider = null;
    if (webSearchActive) {
      // 仅在联网搜索时按优先级：DeepSeek > 千问 > 豆包 > 硅基流动 > 自定义
      const priority = ['deepseek', 'qwen', 'doubao', 'silicon', 'custom'];
      for (const p of priority) {
        for (let opt of options) {
          if (opt.value.startsWith(p + ':')) { targetProvider = opt.value; break; }
        }
        if (targetProvider) break;
      }
    }
    if (targetProvider) {
      selectedValue = targetProvider;
      Core.dom.modelSelect.value = selectedValue;
    }
  }
  // 如果用户已经选择了非 ollama 模型（如千问、DeepSeek），保留用户选择，不覆盖
  const provider = selectedValue.split(':')[0] || 'ollama';
  // 🔧 修复：Ollama 模型名称可能包含多个冒号（如 ollama:llama3.1:8b）
  let model = selectedValue;
  if (selectedValue.includes(':')) {
    const firstColon = selectedValue.indexOf(':');
    model = selectedValue.substring(firstColon + 1);
  }
  if (!model) model = Core.config.ollamaModel;
  
  // 🔧 模型验证：动态检查（不再硬编码，支持用户安装的所有 Ollama 模型）
  if (!model || model.trim() === '') {
    // 模型名为空，使用默认模型
    model = Core.config.ollamaModel || 'qwen2.5:7b';
    console.warn('⚠️ 模型名为空，回退到默认模型:', model);
    if (Core.dom.modelSelect) {
      Core.dom.modelSelect.value = provider + ':' + model;
    }
  } else if (provider === 'ollama') {
    // Ollama 模型：检查是否在已安装模型列表中（动态获取）
    const installedModels = Core.config.availableModels || [];
    const selectOptions = Core.dom.modelSelect ? Array.from(Core.dom.modelSelect.options)
      .filter(o => o.value.startsWith('ollama:'))
      .map(o => o.value.substring(7)) : [];
    const allKnownOllama = [...new Set([...installedModels, ...selectOptions])];
    
    // 如果已知列表不为空且模型不在列表中，给出警告但不强制回退
    if (allKnownOllama.length > 0 && !allKnownOllama.some(m => m === model || m.startsWith(model + ':'))) {
      console.warn('⚠️ 模型 "' + model + '" 未在已安装列表中检测到，但仍将尝试使用');
    }
  }
  // 云端模型：不做强验证，允许任何非空模型名（用户可能使用自定义模型端点）
  

  // 🔧 检查 API Key 是否配置
  const keyMap = {
    deepseek: Core.config.deepseekKey,
    qwen: Core.config.qwenKey,
    doubao: Core.config.doubaoKey,
    custom: Core.config.customKey,
    silicon: Core.config.siliconFlowKey,
  };
  if (provider !== 'ollama' && !keyMap[provider]) {
    const providerName = {
      deepseek: 'DeepSeek', qwen: '通义千问', doubao: '豆包', custom: '自定义', silicon: '硅基流动',
    }[provider] || provider;
    const aiDiv = document.createElement('div');
    aiDiv.className = 'msg ai';
    if (Core.config.chatBubbleAI) aiDiv.style.backgroundColor = Core.config.chatBubbleAI;
    aiDiv.innerHTML = `<span style="color:#ef4444">❌ 未配置 ${providerName} API Key</span><br>请在设置面板中填写 ${providerName} API Key，或切换到其他模型（如本地 Ollama 模型）。`;
    Core.dom.chatContainer.appendChild(aiDiv);
    Core.dom.status.textContent = `❌ 未配置 ${providerName} API Key`;
    Core._setGeneratingState(false);
    return;
  }

  const temperature = parseFloat(Core.dom.tempSlider.value);
  // 🔧 保存当前温度到当前会话
  var currentSessId = Core.session.getCurrentId();
  var currentSess = Core.session.sessions[currentSessId];
  if (currentSess && currentSess.temperature !== temperature) {
    currentSess.temperature = temperature;
    if (Core.session.saveSession) Core.session.saveSession(currentSessId);
  }
  let userSystemPrompt = Core.dom.systemPrompt.value || Core.config.systemInstruction || '';
  
  // 🔧 如果用户没有手动填写系统提示词，使用当前角色的系统指令
  if (!Core.dom.systemPrompt.value && Core.config.systemInstruction) {
    userSystemPrompt = Core.config.systemInstruction;
  }
  
  // 🔧 deepThink 按钮激活时增强系统提示词
  const isDeepThinkActive = Core.dom.deepThinkBtn && Core.dom.deepThinkBtn.classList.contains('active');
  if (isDeepThinkActive) {
    userSystemPrompt += '\n\n【深度思考模式】请仔细分析问题，逐步推理，给出详细、全面的回答。';
  }
  
  const finalSystemPrompt = Core.skills.applySkillToPrompt ? Core.skills.applySkillToPrompt(userSystemPrompt) : userSystemPrompt;

  // 🔧 智能记忆注入：用户画像 + 关键记忆 + 相关记忆 + 日志
  var memoryContext = '';
  if (Core.memoryEnhance && Core.memoryEnhance.getEnhancedContext) {
    memoryContext = Core.memoryEnhance.getEnhancedContext(text);
  } else if (Core.memory) {
    if (Core.memory.smartContext) {
      memoryContext = Core.memory.smartContext(text, 8);
    } else if (Core.memory.getContext) {
      memoryContext = Core.memory.getContext(10);
    }
  }
  var injectedSystemPrompt = finalSystemPrompt;
  if (memoryContext) {
    injectedSystemPrompt = finalSystemPrompt + '\n\n' + memoryContext;
  }

  // 📁 项目上下文注入：自动读取项目约定文件并注入系统提示
  if (Core.projectContext && Core.projectContext.hasContext()) {
    var projectCtx = Core.projectContext.getContextString();
    if (projectCtx) {
      injectedSystemPrompt += projectCtx;
    }
  }

  // 🔧 消息引用：如果有引用，附加到 prompt 中
  var quote = Core.getQuote ? Core.getQuote() : null;
  var quoteText = promptForAPI;
  if (quote && quote.content) {
    var roleLabel = quote.role === 'user' ? '用户' : 'AI';
    var quoteSnippet = quote.content.length > 200 ? quote.content.substring(0, 200) + '...' : quote.content;
    quoteText = `【引用${roleLabel}消息】\n${quoteSnippet}\n\n【当前问题】\n${promptForAPI}`;
    console.log('📌 已附加引用消息，角色:', roleLabel, '内容长度:', quote.content.length);
  }

  // 联网搜索
  let finalPrompt = quoteText;
  var searchItems = [];  // 结构化搜索结果，用于卡片渲染
  const isWebSearchActive = Core.dom.webSearchBtn.classList.contains('active') && !Core.dom.webSearchBtn.disabled;
  if (isWebSearchActive && Core.webSearch) {
    Core.dom.status.textContent = '🌐 正在搜索网络...';
    try {
      // 优先使用结构化搜索（返回卡片数据）
      var searchMeta = null;
      if (Core.webSearchWithMeta) {
        searchMeta = await Core.webSearchWithMeta(text);
      }
      var searchResult = searchMeta ? searchMeta.text : await Core.webSearch(text);
      searchItems = (searchMeta && searchMeta.items) ? searchMeta.items : [];

      if (searchResult && searchResult.trim() !== '' && 
          !searchResult.includes('未找到有效的搜索结果') && 
          !searchResult.includes('no valid results') &&
          !searchResult.includes('Search failed') &&
          searchResult.length > 30) {
        finalPrompt = `用户问题：${quoteText}\n\n【联网搜索结果】\n${searchResult}\n\n请基于上述搜索结果回答。`;
      } else {
        finalPrompt = `用户问题：${quoteText}\n\n【联网搜索结果】\n未找到有效结果，请根据你的知识回答。`;
      }
    } catch (err) {
      console.error('❌ 搜索错误:', err);
      finalPrompt = `用户问题：${text}\n\n【联网搜索结果】\n搜索出错：${err.message}。请根据你的知识回答。`;
    }
  }

  // 调用 API
  Core.dom.status.textContent = `⏳ 正在请求 ${provider} ...`;
  Core.emit('typingStart');
  Core._setGeneratingState(true);

  // 🔧 渲染搜索结果卡片（在 AI 回复之前显示）
  if (searchItems.length > 0) {
    var srPanel = document.createElement('div');
    srPanel.className = 'search-results-panel';
    var srHeader = document.createElement('div');
    srHeader.className = 'search-panel-header';
    srHeader.innerHTML = '<span class="material-icons-outlined">travel_explore</span> 找到 ' + searchItems.length + ' 条相关结果';
    srPanel.appendChild(srHeader);
    searchItems.forEach(function(item) {
      var card = document.createElement('a');
      card.className = 'search-result-card';
      if (item.url) { card.href = item.url; card.target = '_blank'; }
      else { card.style.cursor = 'default'; }
      var titleDiv = document.createElement('div');
      titleDiv.className = 'sr-title';
      titleDiv.textContent = item.title;
      card.appendChild(titleDiv);
      if (item.snippet) {
        var snippetDiv = document.createElement('div');
        snippetDiv.className = 'sr-snippet';
        snippetDiv.textContent = item.snippet;
        card.appendChild(snippetDiv);
      }
      if (item.url) {
        var urlDiv = document.createElement('div');
        urlDiv.className = 'sr-url';
        urlDiv.textContent = item.url;
        card.appendChild(urlDiv);
      }
      srPanel.appendChild(card);
    });
    Core.dom.chatContainer.appendChild(srPanel);
    Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
  }

  const aiDiv = document.createElement('div');
  aiDiv.className = 'msg ai';
  if (Core.config.chatBubbleAI) aiDiv.style.backgroundColor = Core.config.chatBubbleAI;
  aiDiv.innerHTML = '<span class="typing-cursor"></span>';
  Core.dom.chatContainer.appendChild(aiDiv);
  Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;


  try {
    let reply = '';
    const isStreamEnabled = Core.config.streamResponse !== false;

    if (isStreamEnabled) {
      // 流式输出模式（支持停止，所有 provider）
      var state = Core._apiGetSessionState(currentSessionId);
      state.abortController = new AbortController();
      const signal = state.abortController.signal;
      reply = await Core.api.callAPIStream(finalPrompt, injectedSystemPrompt, temperature, model, provider, (function() {
        var _streamRafId = 0;
        var _pendingFullText = '';
        return function(chunk, fullText) {
          reply = fullText;
          _pendingFullText = fullText;
          // Phase 3-2：流式朗读 — 将新文本块送入语音缓冲
          if (Core.voice && Core.voice.streamAppend) {
            try { Core.voice.streamAppend(chunk); } catch (e) { console.warn('⚠️ [api] 流式语音追加失败:', e.message); }
          }
          if (_streamRafId) return;
          _streamRafId = requestAnimationFrame(function() {
            _streamRafId = 0;
            if (window.marked) {
              aiDiv.innerHTML = Core.renderMarkdown(_pendingFullText);
              var cursor = document.createElement('span');
              cursor.className = 'typing-cursor';
              aiDiv.appendChild(cursor);
            } else {
              aiDiv.textContent = _pendingFullText;
            }
            Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
          });
        };
      })(), signal);
      // 最终渲染
      if (window.marked) {
        aiDiv.innerHTML = Core.renderMarkdown(reply);
      } else {
        aiDiv.textContent = reply;
      }
    } else {
      // 非流式模式，使用打字机效果
      const data = await Core.api.callAPI(finalPrompt, injectedSystemPrompt, temperature, model, provider);
      // 安全解析：确保 data 是有效对象
      if (!data || typeof data !== 'object') {
        throw new Error('API 返回无效数据格式，请检查模型服务是否正常');
      }
      // 🔧 P5: 统一提取回复（兼容 Ollama 和 OpenAI 格式）
      reply = Core.api.extractReply(data);
      
      // 内容检测：如果DeepSeek的AI回复自称千问
      if (provider === 'deepseek' && reply && (reply.includes('我是千问') || reply.includes('我是通义千问') || reply.includes('Qwen') || 
          reply.includes('阿里云') || reply.includes('阿里巴巴') || reply.includes('Aliyun'))) {
        console.warn('⚠️ 检测到 AI 回复自称是千问，但请求的是 DeepSeek');
      }
      
      // 打字机效果显示
      try {
        await typewriterEffect(aiDiv, reply);
        // 打字完成后渲染 Markdown
        if (window.marked) {
          aiDiv.innerHTML = Core.renderMarkdown(reply);
        } else {
          aiDiv.textContent = reply;
        }
      } catch (typewriterErr) {
        console.warn('打字机效果出错，直接显示:', typewriterErr);
        // 如果打字机效果失败，直接显示内容
        if (window.marked) {
          aiDiv.innerHTML = Core.renderMarkdown(reply);
        } else {
          aiDiv.textContent = reply;
        }
      }
    }
    addTimestamp(aiDiv); // 添加时间戳（流式+非流式统一添加）

    // 添加代码复制按钮和折叠按钮
    aiDiv.querySelectorAll('pre').forEach(pre => {
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

    if (reply) {
      sessionData.messages.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      if (Core.session.saveSessionForService) {
        Core.session.saveSessionForService(service, currentSessionId, sessionData);
      } else {
        Core.session.saveSession(currentSessionId);
      }
      // 🔧 知识库自动记忆：将本轮 Q&A 存入知识库供未来检索
      if (Core.config.autoKnowledgeMemory && Core.knowledge && Core.knowledge.saveConversation) {
        try {
          var sessionTitle = (Core.session.sessions && Core.session.sessions[currentSessionId]) ?
            Core.session.sessions[currentSessionId].title : '';
          Core.knowledge.saveConversation(sessionData.messages, sessionTitle).then(function (r) {
          }).catch(function (e) { console.warn('⚠️ [api] 知识库自动保存失败:', e.message); });
        } catch (e) { console.warn('⚠️ [api] 知识库自动记忆出错:', e.message); }
      }
    } else if (!Core._apiGetSessionState(currentSessionId).isGenerating) {
      console.log('⏹ 生成被用户主动停止，保留已生成内容');
    } else {
      throw new Error('AI 返回空内容');
    }

    Core.dom.status.textContent = `✅ 已就绪 (${provider})`;
    Core.emit('typingEnd');

    // Phase 3-2：流式朗读结束 + 自动朗读回复
    try {
      if (Core.voice) {
        if (Core.voice.streamEnd) Core.voice.streamEnd();
        if (reply && Core.voice.autoSpeakReply) Core.voice.autoSpeakReply(reply);
      }
    } catch (e) { console.warn('⚠️ [api] 语音朗读完成后处理失败:', e.message); }

    // Phase 4-1：分析追踪 — 记录 AI 回复 + 模型 + Token 估算
    try {
      if (Core.analytics && Core.analytics.track) {
        Core.analytics.track.message('assistant', model, provider);
        if (reply && Core.contextManager && Core.contextManager.estimateTokens) {
          Core.analytics.track.tokens(
            Core.contextManager.estimateTokens(finalPrompt || text),
            Core.contextManager.estimateTokens(reply)
          );
        }
      }
    } catch (e) { console.warn('⚠️ [api] 分析追踪(回复)失败:', e.message); }

    // 🔧 插件 afterResponse 钩子
    try {
      if (Core.plugins && Core.plugins.callHook) {
        const aiMsg = sessionData.messages[sessionData.messages.length - 1];
        await Core.plugins.callHook('afterResponse', aiMsg, { sessionId: currentSessionId, provider: provider });
      }
    } catch (e) {
      console.warn('⚠️ afterResponse 钩子执行失败:', e.message);
    }
    
    // 🔧 系统通知：如果用户开启了通知，且窗口不在前台
    try {
      if (Core.config.notification !== false) {
        ipcRenderer.send('show-notification', { 
          title: 'AI智能体', 
          body: '💬 新消息已回复，点击查看'
        });
      }
    } catch (e) { console.warn('⚠️ [api] 发送系统通知失败:', e.message); }

  } catch (err) {
    Core.emit('typingEnd');
    if (err.name === 'AbortError' || (err.message && err.message.includes('aborted'))) {
      console.log('⏹ 生成被中断（AbortError），保留已生成内容');
      const cursorEl = aiDiv ? aiDiv.querySelector('.typing-cursor') : null;
      if (cursorEl) cursorEl.remove();
    } else {
      const errMsg = '❌ 错误：' + err.message;
      // Phase 4-3：错误恢复增强 — 智能分类 + 重试建议 + 降级提示
      var recoveryInfo = '';
      if (Core.recovery) {
        try {
          var advice = Core.recovery.getRetryAdvice(err, provider);
          recoveryInfo += '\n\n🔍 错误类型: ' + advice.error.label;
          recoveryInfo += '\n💡 建议: ' + advice.error.suggestion;
          if (advice.suggestions.length > 0) {
            recoveryInfo += '\n📋 ' + advice.suggestions[0];
          }
          if (advice.fallback) {
            recoveryInfo += '\n🔄 可降级到: ' + advice.fallback;
          }
          if (advice.circuit && advice.circuit.state !== 'closed') {
            recoveryInfo += '\n⚡ 断路器: ' + advice.circuit.state + ' (失败 ' + advice.circuit.failures + ' 次)';
          }
          // 追踪错误
          if (Core.analytics && Core.analytics.track) {
            Core.analytics.track.error(err.message, provider);
          }
        } catch (e) { console.warn('⚠️ [api] 获取错误恢复建议失败:', e.message); }
      }
      var fullErrMsg = errMsg + recoveryInfo;
      // 🔧 安全访问 sessionData
      if (sessionData && sessionData.messages) {
        sessionData.messages.push({ role: 'assistant', content: fullErrMsg, timestamp: Date.now() });
      }
      try {
        if (Core.session.saveSessionForService) {
          Core.session.saveSessionForService(service, currentSessionId, sessionData);
        } else {
          Core.session.saveSession(currentSessionId);
        }
      } catch (e) { console.warn('保存错误消息失败:', e); }
      if (aiDiv) {
        var errorHtml = '<span style="color:#ef4444">' + errMsg.replace(/</g, '&lt;') + '</span>';
        if (recoveryInfo) {
          errorHtml += '<div style="margin-top:8px;padding:8px 12px;background:rgba(239,68,68,0.08);border-radius:8px;font-size:13px;color:var(--text-secondary,#999);white-space:pre-line">' + recoveryInfo.replace(/</g, '&lt;') + '</div>';
        }
        // 重试按钮
        errorHtml += '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">';
        errorHtml += '<button onclick="Core.dom.input.value=' + JSON.stringify(text) + ';Core.api.sendMessage()" style="padding:4px 12px;border-radius:6px;border:1px solid var(--border-color,#333);background:var(--bg-secondary,#1e1e1e);color:var(--text-primary,#eee);cursor:pointer;font-size:12px">🔄 重试</button>';
        if (Core.recovery) {
          try {
            var fb = Core.recovery.getRetryAdvice(err, provider).fallback;
            if (fb) {
              errorHtml += '<button onclick="Core.api.switchAndRetry(\'' + fb + '\')" style="padding:4px 12px;border-radius:6px;border:1px solid var(--border-color,#333);background:var(--bg-secondary,#1e1e1e);color:var(--text-primary,#eee);cursor:pointer;font-size:12px">🔀 切换到 ' + fb + ' 重试</button>';
            }
          } catch (e) { console.warn('⚠️ [api] 渲染恢复建议按钮失败:', e.message); }
        }
        errorHtml += '<button onclick="Core.recovery&&Core.recovery.resetCircuit(\'' + provider + '\');Core.errorHandler&&Core.errorHandler.showSuccessToast(\'已重置断路器\')" style="padding:4px 12px;border-radius:6px;border:1px solid var(--border-color,#333);background:var(--bg-secondary,#1e1e1e);color:var(--text-primary,#eee);cursor:pointer;font-size:12px">⚡ 重置断路器</button>';
        errorHtml += '</div>';
        aiDiv.innerHTML = errorHtml;
      }
      Core.dom.status.textContent = '❌ 连接失败，请查看控制台';
      console.error(err);
    }
  } finally {
    // 发送完成后清除引用
    if (Core.clearQuote) {
      Core.clearQuote();
    }
    var state = Core._apiGetSessionState(currentSessionId);
    Core._setGeneratingState(false, currentSessionId);
    state.abortController = null;
    // D: 请求完成后触发自动保存
    if (Core.session && Core.session.saveSession) {
      try { Core.session.saveSession(currentSessionId); } catch(e) { console.warn('⚠️ [api] 请求完成后自动保存会话失败:', e.message); }
    }
  }
}


module.exports = {
  name: 'chat-handler',
  dependencies: ['html-utils'],
  init: function(_Core) {
    Core = _Core;
    Core.chatHandler = {
      handleNormalChat: handleNormalChat,
      addTimestamp: addTimestamp,
      typewriterEffect: typewriterEffect
    };
    // Backward compatibility
    Core.addTimestamp = addTimestamp;
    console.log('✅ 聊天处理器已加载');
  }
};
