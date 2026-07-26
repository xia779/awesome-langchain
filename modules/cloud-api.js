// modules/cloud-api.js - 云端服务适配器（纯 fetch 实现，无需 openai 包）
let Core = null;
let currentService = 'ollama';

// 🔧 强制 temperature 在 JSON 中始终带小数点
// JSON.stringify({temperature:2}) → {"temperature":2} → DashScope 拒绝
// _tempFloat(2) → 2.0001 → JSON.stringify → {"temperature":2.0001} → DashScope 接受
function _tempFloat(v) {
  var t = Number(v);
  if (!isFinite(t) || t < 0 || t > 2) t = 0.7;
  t = Math.round(t * 100) / 100;
  if (Number.isInteger(t)) {
    // 边界值处理：2.0 不能加 epsilon 会超上限，0 不能减会低于下限
    if (t >= 2) t = 1.999;
    else if (t <= 0) t = 0.001;
    else t += 0.001;
  }
  return t;
}

// 服务配置（优先级：DeepSeek > 千问 > 豆包 > 本地 > 自定义）
const SERVICES = {
  deepseek: {
    name: 'DeepSeek',
    priority: 1,
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyField: 'deepseekKey',
  },
  qwen: {
    name: '通义千问',
    priority: 2,
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyField: 'qwenKey',
  },
  doubao: {
    name: '豆包',
    priority: 3,
    models: ['doubao-pro-32k', 'doubao-lite-32k'],
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyField: 'doubaoKey',
  },
  ollama: {
    name: '本地模型',
    priority: 4,
    models: ['qwen2.5:7b', 'llama3.1:8b', 'tinyllama:latest']
  },
  custom: {
    name: '自定义',
    priority: 5,
    models: ['gpt-3.5-turbo'],
    baseURL: null,
    apiKeyField: 'customKey',
  },
  silicon: {
    name: '硅基流动',
    priority: 6,
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-R1',
      'deepseek-ai/DeepSeek-V4-Flash',
      'Qwen/Qwen3-32B',
      'Qwen/Qwen3-8B',
      'Qwen/Qwen3.5-397B-A17B',
      'Qwen/Qwen3.5-27B',
      'Qwen/QwQ-32B',
      'zai-org/GLM-4.7',
      'zai-org/GLM-4.6',
      'zai-org/GLM-4.6V',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'Qwen/Qwen2.5-Coder-7B-Instruct',
    ],
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyField: 'siliconFlowKey',
  }
};

function getApiKey(provider) {
  const service = SERVICES[provider];
  if (!service) throw new Error('不支持的提供商: ' + provider);
  let apiKey = Core.config[service.apiKeyField];
  if (!apiKey) throw new Error('请填写 ' + service.name + ' API Key');
  if (apiKey.startsWith('Bearer ')) apiKey = apiKey.substring(7);
  return apiKey;
}

function getBaseURL(provider) {
  const service = SERVICES[provider];
  if (!service) throw new Error('不支持的提供商: ' + provider);

  let baseURL = service.baseURL;
  if (provider === 'custom') {
    baseURL = Core.config.customBase;
    if (!baseURL) throw new Error('请填写自定义 API 地址');
    baseURL = baseURL.replace(/\/v1\/chat\/completions$/, '').replace(/\/chat\/completions$/, '');
    if (!baseURL.endsWith('/v1')) baseURL = baseURL + '/v1';
  }
  return baseURL;
}

// 🔧 为每个云端提供商提供默认模型，避免 model 为空时错误地 fallback 到 gpt-3.5-turbo
function resolveCloudModel(provider, model) {
  if (model && typeof model === 'string' && model.trim() !== '') return model.trim();
  const defaults = {
    deepseek: Core.config.deepseekModel || 'deepseek-v4-flash',
    qwen: Core.config.qwenModel || 'qwen-plus',
    doubao: Core.config.doubaoModel || '',
    silicon: Core.config.siliconModel || 'deepseek-ai/DeepSeek-V4-Flash',
    custom: Core.config.customModel || 'gpt-3.5-turbo'
  };
  return defaults[provider] || model || 'gpt-3.5-turbo';
}

// 🔧 B6 修复：max_tokens 按提供商/模型分级，避免小输出上限模型（豆包/DeepSeek-chat 等）收到 16384 直接 400
// 优先级：调用方显式 options.maxTokens > 用户配置 Core.config.maxTokens > 提供商/模型默认值
function resolveMaxTokens(provider, model, options) {
  if (options && typeof options.maxTokens === 'number' && options.maxTokens > 0) {
    return Math.min(options.maxTokens, 32768);
  }
  if (Core.config && typeof Core.config.maxTokens === 'number' && Core.config.maxTokens > 0) {
    return Math.min(Core.config.maxTokens, 32768);
  }
  var m = String(model || '').toLowerCase();
  // 推理系模型（长思维链输出）
  if (m.indexOf('reasoner') >= 0 || m.indexOf('-r1') >= 0 || m.indexOf('qwq') >= 0) return 16384;
  // 豆包 Ark 端点常见输出上限 4096
  if (provider === 'doubao') return 4096;
  // DeepSeek 官方 chat 输出上限 8192
  if (provider === 'deepseek') return 8192;
  // 通义千问主流模型输出上限 8192
  if (provider === 'qwen') return 8192;
  // 硅基流动聚合平台模型差异大，8192 是安全值
  if (provider === 'silicon') return 8192;
  // 自定义端点保守取值，可在设置中通过 maxTokens 覆盖
  if (provider === 'custom') return 4096;
  return 8192;
}

// 获取已配置 API Key 的可用云端提供商列表
function getAvailableProviders() {
  var result = [];
  Object.keys(SERVICES).forEach(function(key) {
    var svc = SERVICES[key];
    if (svc.apiKeyField && Core.config && Core.config[svc.apiKeyField]) {
      result.push(key);
    }
  });
  // 按优先级排序
  result.sort(function(a, b) { return SERVICES[a].priority - SERVICES[b].priority; });
  return result;
}

// 测试某个提供商的连接
async function testConnection(provider) {
  var apiKey = getApiKey(provider);
  var baseURL = getBaseURL(provider);
  if (!apiKey || !baseURL) return { online: false, error: '未配置 API Key 或 Base URL' };
  try {
    var resp = await fetch(baseURL + '/models', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(5000)
    });
    return { online: resp.ok, status: resp.status };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// 构建消息列表
function buildMessages(prompt, systemMsg) {
  // 提取图片并构建多模态 content（OpenAI Vision 格式）
  // 🔧 净化文本：移除会导致 JSON 序列化/DeepSeek 解析失败的非法字符
  function sanitizeForJSON(str) {
    if (!str || typeof str !== 'string') return str || '';
    return str
      // 移除控制字符（保留 \n \r \t）
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // 移除 lone surrogates（U+D800-U+DFFF 中未配对的）
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
      // 移除 BOM 和零宽字符（可选，防止干扰）
      .replace(/\uFEFF/g, '');
  }

  function buildContent(content) {
    if (!content || typeof content !== 'string') return content || '';
    // 🔧 净化内容，防止非法字符导致 API 400 错误
    content = sanitizeForJSON(content);
    var images = [];
    var text = content;
    // 提取 base64 图片
    var dataUrlRegex = /!\[([^\]]*?)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+)\)/g;
    var match;
    while ((match = dataUrlRegex.exec(content)) !== null) {
      var dataUrl = match[2].replace(/\s/g, '');
      images.push({ type: 'image_url', image_url: { url: dataUrl } });
      text = text.replace(match[0], '[图片]');
    }
    // 提取 URL 图片
    var urlRegex = /!\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g;
    while ((match = urlRegex.exec(content)) !== null) {
      images.push({ type: 'image_url', image_url: { url: match[2] } });
      text = text.replace(match[0], '[图片]');
    }
    // 有图片时返回多模态数组，无图片返回纯文本
    if (images.length > 0) {
      return [{ type: 'text', text: text }].concat(images);
    }
    return text;
  }
  
  const messages = [];
  if (systemMsg) messages.push({ role: 'system', content: systemMsg });
  
  const currentServiceName = getCurrentService();
  const sessions = Core.session.loadSessionsForService 
    ? Core.session.loadSessionsForService(currentServiceName) 
    : Core.session.sessions;
  const currentSessionId = Core.session.getCurrentId();
  const sessionData = sessions[currentSessionId];
  if (sessionData && sessionData.messages) {
    // 优先使用 context-manager 的 token 预算滑动窗口
    var history;
    var ctxSummary = null;
    if (Core.contextManager && Core.contextManager.getOptimizedContext) {
      try {
        var ctx = Core.contextManager.getOptimizedContext(currentSessionId);
        history = ctx.window || [];
        ctxSummary = ctx.summary || null;
      } catch (e) {
        console.warn('cloud-api: context-manager 失败，回退 slice(-10):', e.message);
        history = sessionData.messages.slice(-10);
      }
    } else {
      history = sessionData.messages.slice(-10);
    }
    // 🔧 P0-5: 输入 token 预算保护——防止超长会话/大文档导致 API 上下文溢出报错
    try {
      var _budget = (Core.config && Core.config.contextTokenBudget) || 100000;
      var _estTokens = function (t) {
        if (t == null) return 0;
        var s = typeof t === 'string' ? t : JSON.stringify(t);
        return Math.ceil(s.length / 4);
      };
      if (history && history.length) {
        // 单条消息超预算则截断其内容，避免单条撑爆上下文
        history = history.map(function (m) {
          if (_estTokens(m.content) > _budget) {
            var raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return Object.assign({}, m, { content: raw.slice(0, _budget * 4) + '\n…[内容已截断]' });
          }
          return m;
        });
        // 整体超预算则丢弃最旧消息（保留最新对话）
        while (history.length > 1) {
          var _sum = history.reduce(function (acc, m) { return acc + _estTokens(m.content); }, 0);
          if (_sum <= _budget) break;
          history.shift();
        }
      }
    } catch (e) { console.warn('⚠️ [cloud-api] P0-5 预算截断失败，沿用原历史:', e.message || e); }
    // 注入上下文摘要（被窗口截断的早期消息摘要）
    if (ctxSummary) {
      messages.push({ role: 'system', content: '[早期对话摘要] ' + ctxSummary });
    }
    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: buildContent(msg.content) });
      }
    }
  }
  // 🔧 防重复：session 历史中可能已包含当前用户消息（handleNormalChat 在调用 callAPI 前已保存）
  var lastUserMsg = null;
  for (var mi = messages.length - 1; mi >= 0; mi--) {
    if (messages[mi].role === 'user') { lastUserMsg = messages[mi]; break; }
  }
  var promptText = typeof prompt === 'string' ? prompt : '';
  var lastUserText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
  if (lastUserText !== promptText) {
    messages.push({ role: 'user', content: buildContent(prompt) });
  }
  return messages;
}

function switchService(service) {
  if (!SERVICES[service]) {
    console.warn('⚠️ 未知服务:', service);
    return;
  }
  currentService = service;
  const modelSelect = Core.dom.modelSelect;
  if (modelSelect) {
    const models = SERVICES[service].models;
    modelSelect.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = `${service}:${m}`;
      opt.textContent = `${m} (${SERVICES[service].name})`;
      modelSelect.appendChild(opt);
    });
  }
  console.log('✅ 已切换到 ' + SERVICES[service].name);
  Core.emit('serviceChanged', service);
}

function getCurrentService() { return currentService; }
function getServiceModels(service) { return SERVICES[service]?.models || []; }

// ===== 构建 Function Calling 工具定义 =====
function buildToolsPayload() {
  if (!Core || !Core.toolsRegistry || typeof Core.toolsRegistry.getToolDefinitions !== 'function') {
    return null;
  }
  try {
    const defs = Core.toolsRegistry.getToolDefinitions();
    if (defs && defs.length > 0) {
      return defs;
    }
  } catch (e) {
    console.warn('⚠️ 获取工具定义失败:', e.message);
  }
  return null;
}

// 支持 Function Calling 的提供商
const FUNCTION_CALLING_PROVIDERS = ['deepseek', 'qwen', 'custom', 'silicon'];

//  过滤 DeepSeek 流式响应中的 DSML 标记
// 匹配所有格式: <| DSML || tool_calls>、| DSML | tool_calls>、|| DSML || invoke name="web_search">、<|DSML||/invoke>、< | DSML | xxx> 等
// 策略: 多轮清理 — 先剥离完整/未闭合 tool_calls 块，再清除残余单行标记
var DSML_MARKER_RE = /<\s*\|{1,3}\s*DSML\s*\|{0,3}\s*[^>\n]*>?/gi;
var DSML_MARKER_NOANGLE_RE = /\|{1,3}\s*DSML\s*\|{0,3}\s*[^>\n]*>?/gi;
var DSML_TOOLCALLS_BLOCK_RE = /<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*tool_calls[\s\S]*?<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*\/tool_calls\s*>?/gi;
var DSML_TOOLCALLS_UNCLOSED_RE = /<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*tool_calls[\s\S]*$/gi;
function stripDSMLMarkers(text) {
  if (!text) return text;
  // Pass 1: 完整的 tool_calls 块（从 tool_calls 到 /tool_calls）
  text = text.replace(DSML_TOOLCALLS_BLOCK_RE, '');
  // Pass 2: 未闭合的 tool_calls 块（截断到末尾）
  text = text.replace(DSML_TOOLCALLS_UNCLOSED_RE, '');
  // Pass 3: 带 < 的单个 DSML 标记（允许 < 和 | 之间有空格）
  text = text.replace(DSML_MARKER_RE, '');
  // Pass 4: 不带 < 的管道符格式 | DSML | xxx>
  text = text.replace(DSML_MARKER_NOANGLE_RE, '');
  return text;
}

// ===== 处理工具调用并生成后续消息 =====
async function handleToolCalls(toolCalls, messages, apiKey, baseURL, model, temperature, provider) {
  if (!toolCalls || toolCalls.length === 0) return null;

  // 将 assistant 的 tool_calls 加入消息历史
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: toolCalls
  });

  // 逐个执行工具并将结果加入消息
  for (const tc of toolCalls) {
    const fnName = tc.function?.name;
    let fnArgs = {};
    try {
      fnArgs = JSON.parse(tc.function?.arguments || '{}');
    } catch (e) {
      console.warn('⚠️ 工具参数解析失败:', tc.function?.arguments);
    }

    let result = '工具执行失败: 未知工具';
    try {
      if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
        result = await Core.toolsRegistry.executeTool(fnName, fnArgs);
      }
    } catch (e) {
      result = '工具执行错误: ' + e.message;
    }

    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: typeof result === 'string' ? result : JSON.stringify(result)
    });
  }

  // 用工具结果再次调用 API 获取最终回复
  console.log('🔄 Function Calling: 发送工具结果，请求最终回复...');
  const followUp = await fetch(baseURL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      temperature: _tempFloat(temperature),
      max_tokens: resolveMaxTokens(provider, model),
      stream: false
    })
  });

  if (!followUp.ok) {
    const errText = await followUp.text();
    throw new Error('Function Calling 后续请求失败 (' + followUp.status + '): ' + errText.substring(0, 200));
  }

  const followUpData = await followUp.json();
  return followUpData;
}

// ===== 非流式调用 =====
async function callCloudAPI(prompt, systemMsg, temperature, model, provider, options) {
  options = options || {};

  // 使用 error-recovery 的重试 + 断路器机制
  var retryFn = Core.recovery ? Core.recovery.withRetry : async function(fn) { return await fn(0); };

  try {
    return await retryFn(async function(attempt) {
      const apiKey = getApiKey(provider);
      const baseURL = getBaseURL(provider);
      const messages = options.messages || buildMessages(prompt, systemMsg);

      let actualModel = resolveCloudModel(provider, model);
      if (provider === 'doubao') {
        actualModel = model || Core.config.doubaoModel;
        if (!actualModel || !actualModel.startsWith('ep-')) {
          throw new Error('豆包需要配置 Endpoint ID（格式 ep-xxx），请在设置面板 → 豆包 中填写从火山引擎 Ark 控制台创建的 Endpoint ID');
        }
      }

      // 🔧 temperature 强制 Float 格式（DashScope 严格要求）
      var _temp = _tempFloat(temperature);
      const requestBody = {
        model: actualModel,
        messages: messages,
        temperature: _temp,
        max_tokens: resolveMaxTokens(provider, actualModel, options),
        stream: false
      };

      // 如果提供商支持 Function Calling 且有可用工具，添加 tools 参数（options.disableTools 可禁用）
      const toolsPayload = (!options.disableTools && FUNCTION_CALLING_PROVIDERS.includes(provider)) ? buildToolsPayload() : null;
      if (toolsPayload) {
        requestBody.tools = toolsPayload;
        requestBody.tool_choice = 'auto';
      }

      const response = await fetch(baseURL + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(120000)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error('API 请求失败 (' + response.status + '): ' + errText.substring(0, 200));
      }

      let data = await response.json();

      // 🔧 F12: 处理 tool_calls — 如果模型请求工具调用，执行后再次请求
      const toolCalls = data.choices?.[0]?.message?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        const followUpData = await handleToolCalls(toolCalls, messages, apiKey, baseURL, actualModel, temperature, provider);
        if (followUpData) {
          data = followUpData;
          console.log('🔄 Function Calling: 最终回复已获取');
        }
      }

      // 检测模型身份混淆
      if (provider === 'deepseek' && data.model) {
        if (data.model.includes('qwen') || data.model.includes('aliyun') || data.model.includes('dashscope')) {
          console.warn('⚠️ 检测到 API 路由异常：请求了 DeepSeek 但返回了 model=' + data.model);
        }
      }

      return data;
    }, { provider: provider, maxRetries: 2, onRetry: function(n) {
      if (Core.dom && Core.dom.status) Core.dom.status.textContent = '🔄 重试 ' + n + '/2 (' + provider + ')...';
    }});
  } catch (err) {
    // 所有重试失败 → 尝试故障转移到备用提供商
    console.warn('☁️ ' + provider + ' 全部重试失败:', err.message);
    if (Core.recovery && Core.recovery.getFallbackProvider) {
      var fallback = Core.recovery.getFallbackProvider(provider);
      // 🔧 ollama 是本地模型，走独立的 Ollama 路径，不能经 callCloudAPI 云端路径调用
      if (fallback && fallback !== provider && fallback !== 'ollama') {
        console.log('🔄 故障转移到: ' + fallback);
        if (Core.dom && Core.dom.status) Core.dom.status.textContent = '🔄 已切换到 ' + fallback + '...';
        return await callCloudAPI(prompt, systemMsg, temperature, model, fallback);
      }
    }
    // 🔧 P2-3: 云端所有提供商均失败后，启用本地推理兜底（Ollama / 兼容端点）
    if (Core.config && Core.config.localInference && Core.config.localInference.enabled && Core.localInference) {
      try {
        console.log('🔄 云端全部失败，启用本地推理兜底');
        if (Core.dom && Core.dom.status) Core.dom.status.textContent = '🔄 本地推理兜底中...';
        return await Core.localInference.complete(prompt, systemMsg, {
          temperature: temperature,
          model: model,
          maxTokens: (options && options.maxTokens) || undefined
        });
      } catch (le) {
        console.warn('⚠️ 本地推理兜底也失败:', le.message);
      }
    }
    throw err;
  }
}

// ===== 流式调用（SSE 解析）=====
async function callCloudAPIStream(prompt, systemMsg, temperature, model, provider, onChunk, signal) {
  
  const apiKey = getApiKey(provider);
  const baseURL = getBaseURL(provider);
  const messages = buildMessages(prompt, systemMsg);
  
  let actualModel = resolveCloudModel(provider, model);
  if (provider === 'doubao') {
    actualModel = model || Core.config.doubaoModel;
    if (!actualModel || !actualModel.startsWith('ep-')) {
      throw new Error('豆包需要配置 Endpoint ID（格式 ep-xxx），请在设置面板 → 豆包 中填写从火山引擎 Ark 控制台创建的 Endpoint ID');
    }
  }
  // 确保 temperature 始终为有效浮点数且带小数点（DashScope 等 API 严格要求 Float 类型）
  var _temp = _tempFloat(temperature);
  var requestBody = {
    model: actualModel,
    messages: messages,
    temperature: _temp,
    max_tokens: resolveMaxTokens(provider, actualModel),
    stream: true
  };
  console.log('[cloud-api] stream request:', JSON.stringify({ model: requestBody.model, temperature: requestBody.temperature, tempType: typeof requestBody.temperature }));

  const supportsTools = FUNCTION_CALLING_PROVIDERS.includes(provider);
  // 如果 prompt 已包含搜索结果，不再注入 web_search 工具（防止模型重复调用并清空回复）
  const alreadySearched = prompt && prompt.indexOf('【联网搜索结果】') >= 0;
  const toolsPayload = (supportsTools && !alreadySearched) ? buildToolsPayload() : null;
  if (toolsPayload) {
    requestBody.tools = toolsPayload;
    requestBody.tool_choice = 'auto';
  }

  const fetchOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(requestBody)
  };
  if (signal) fetchOpts.signal = signal;
  
  let fullText = '';
  let buffer = '';
  // 🔧 F12: 用于累积流式 tool_calls
  let accumulatedToolCalls = [];
  // decoder 提到外层：follow-up 请求（function calling）也会复用
  const decoder = new TextDecoder();

  try {
    const response = await fetch(baseURL + '/chat/completions', fetchOpts);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error('API 请求失败 (' + response.status + '): ' + errText.substring(0, 200));
    }
    
    if (!response.body) throw new Error('无响应体');
    
    const reader = response.body.getReader();
    
    while (true) {
      let chunkData;
      try {
        chunkData = await reader.read();
      } catch (readErr) {
        if (signal && signal.aborted) {
          console.log('⏹ 流式读取被中断');
          return fullText;
        }
        throw readErr;
      }
      if (chunkData.done) break;
      
      buffer += decoder.decode(chunkData.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留未完成的行
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.substring(6));
            const delta = data.choices?.[0]?.delta;
            const rawContent = delta?.content || data.choices?.[0]?.text || '';
            // 🔧 过滤 DSML 标记，防止 || DSML || tool_calls> 等原始文本显示在聊天中
            const content = stripDSMLMarkers(rawContent);
            if (content) {
              fullText += content;
              onChunk(content, fullText);
            }
            // 🔧 F12: 累积流式 tool_calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index || 0;
                if (!accumulatedToolCalls[idx]) {
                  accumulatedToolCalls[idx] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' }
                  };
                }
                if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch (e) {
            // 忽略解析错误，继续处理下一行
            console.warn('[cloud-api] 流式数据行解析失败:', e.message);
          }
        }
      }
    }
  } catch (err) {
    // 主请求（含 SSE 读取）失败 → 与非流式保持一致：先故障转移到备用云端提供商，再启用本地推理兜底
    console.warn('☁️ 流式 ' + provider + ' 请求失败:', err.message);
    if (Core.recovery && Core.recovery.getFallbackProvider) {
      var fallback = Core.recovery.getFallbackProvider(provider);
      // 🔧 ollama 是本地模型，走独立的 Ollama 路径，不能经 callCloudAPIStream 云端路径调用
      if (fallback && fallback !== provider && fallback !== 'ollama') {
        console.log('🔄 流式故障转移到: ' + fallback);
        if (Core.dom && Core.dom.status) Core.dom.status.textContent = '🔄 已切换到 ' + fallback + '...';
        return await callCloudAPIStream(prompt, systemMsg, temperature, model, fallback, onChunk, signal);
      }
    }
    // 🔧 P2-3: 云端所有提供商均失败后，启用本地推理流式兜底（Ollama / 兼容端点）
    if (Core.config && Core.config.localInference && Core.config.localInference.enabled && Core.localInference) {
      try {
        console.log('🔄 流式云端全部失败，启用本地推理兜底');
        if (Core.dom && Core.dom.status) Core.dom.status.textContent = '🔄 本地推理兜底中...';
        var _localFull = await Core.localInference.stream(
          prompt, systemMsg,
          { temperature: temperature, model: model, signal: signal },
          function (piece) {
            if (piece) {
              fullText += piece;
              onChunk(piece, fullText);
            }
          }
        );
        if (typeof _localFull === 'string' && _localFull) fullText = _localFull;
        // 本地兜底不触发云端 function-calling 流水线，直接收尾
        fullText = stripDSMLMarkers(fullText).trim();
        return fullText;
      } catch (le) {
        console.warn('⚠️ 流式本地推理兜底也失败:', le.message);
      }
    }
    throw err;
  }
  
  // 处理缓冲区中剩余的数据
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
      try {
        const data = JSON.parse(trimmed.substring(6));
        const delta = data.choices?.[0]?.delta;
        const rawContent = delta?.content || '';
        const content = stripDSMLMarkers(rawContent);
        if (content) {
          fullText += content;
          onChunk(content, fullText);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!accumulatedToolCalls[idx]) {
              accumulatedToolCalls[idx] = {
                id: tc.id || '',
                type: 'function',
                function: { name: '', arguments: '' }
              };
            }
            if (tc.id) accumulatedToolCalls[idx].id = tc.id;
            if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch (e) {
          console.warn('[cloud-api] 流式剩余缓冲区数据解析失败:', e.message);
        }
    }
  }

  // 🔧 F12: 处理流式 tool_calls — 执行工具后发起后续请求
  const validToolCalls = accumulatedToolCalls.filter(tc => tc && tc.id);
  if (validToolCalls.length > 0) {
    // 🔧 检测到工具调用，重置 fullText — 初始流中的 DSML 标记和前导文本不显示给用户
    // 只保留后续请求的最终回复作为聊天内容
    fullText = '';
    onChunk('', fullText);  // 清空聊天显示

    // 构建包含 tool_calls 的消息历史
    messages.push({ role: 'assistant', content: null, tool_calls: validToolCalls });
    for (const tc of validToolCalls) {
      const fnName = tc.function?.name;
      let fnArgs = {};
      try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch(e) { console.warn('[cloud-api] 流式工具调用参数解析失败:', tc.function?.arguments, e.message); }
      let result = '工具执行失败: 未知工具';
      try {
        if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
          result = await Core.toolsRegistry.executeTool(fnName, fnArgs);
        }
      } catch (e) {
        result = '工具执行错误: ' + e.message;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
    // 发起后续流式请求获取最终回复
    console.log('🔄 Function Calling (stream): 请求最终回复...');
    var toolReplyFailed = false;
    var _fuTemp = _tempFloat(temperature);
    const followUpBody = {
      model: actualModel,
      messages: messages,
      temperature: _fuTemp,
      max_tokens: resolveMaxTokens(provider, actualModel),
      stream: true
    };
    const followUpOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(followUpBody)
    };
    if (signal) followUpOpts.signal = signal;
    try {
      const followUpResp = await fetch(baseURL + '/chat/completions', followUpOpts);
      if (followUpResp.ok && followUpResp.body) {
        const fReader = followUpResp.body.getReader();
        let fBuffer = '';
        while (true) {
          let fChunk;
          try { fChunk = await fReader.read(); } catch (fReadErr) {
            if (signal && signal.aborted) break;
            throw fReadErr;
          }
          if (fChunk.done) break;
          fBuffer += decoder.decode(fChunk.value, { stream: true });
          const fLines = fBuffer.split('\n');
          fBuffer = fLines.pop() || '';
          for (const fLine of fLines) {
            const fTrimmed = fLine.trim();
            if (!fTrimmed || fTrimmed === 'data: [DONE]') continue;
            if (fTrimmed.startsWith('data: ')) {
              try {
                const fData = JSON.parse(fTrimmed.substring(6));
                const fRawContent = fData.choices?.[0]?.delta?.content || '';
                const fContent = stripDSMLMarkers(fRawContent);
                if (fContent) {
                  fullText += fContent;
                  onChunk(fContent, fullText);
                }
              } catch(e) {
                console.warn('[cloud-api] 流式后续响应数据解析失败:', e.message);
              }
            }
          }
        }
        // 🔧 处理缓冲区中剩余的数据（防止最后一个chunk无换行时丢失）
        if (fBuffer.trim()) {
          const fTrimmed = fBuffer.trim();
          if (fTrimmed.startsWith('data: ') && fTrimmed !== 'data: [DONE]') {
            try {
              const fData = JSON.parse(fTrimmed.substring(6));
              const fRawContent = fData.choices?.[0]?.delta?.content || '';
              const fContent = stripDSMLMarkers(fRawContent);
              if (fContent) { fullText += fContent; onChunk(fContent, fullText); }
            } catch(e) { /* ignore */ }
          }
        }
      } else {
        toolReplyFailed = true;
        console.warn('[cloud-api] 流式后续请求失败:', followUpResp.status, followUpResp.statusText);
      }
    } catch (fuErr) {
      if (signal && signal.aborted) { /* 用户取消，静默 */ }
      else { toolReplyFailed = true; console.warn('[cloud-api] 流式后续请求异常:', fuErr.message); }
    }
  }
  
  // 🔧 最终安全清理：确保返回的文本不包含任何 DSML 标记
  fullText = stripDSMLMarkers(fullText).trim();
  
  // 🔧 如果执行了工具调用但后续回复为空，提供兜底提示（M11：区分"已完成"与"失败"）
  if (validToolCalls && validToolCalls.length > 0 && !fullText) {
    fullText = toolReplyFailed ? '⚠️ 工具已执行，但获取最终回复失败，请重试' : '✅ 工具调用已完成';
  }
  
  return fullText;
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.cloudApi = {
      switchService,
      getCurrentService,
      getServiceModels,
      SERVICES,
      callCloudAPI,
      callCloudAPIStream,
      getAvailableProviders,
      testConnection,
      invalidateClient: () => {} // 纯 fetch 无需缓存，空函数保持兼容
    };
    console.log('✅ 云端 API 模块已加载 v2 (temperature fix applied)');
  }
};
