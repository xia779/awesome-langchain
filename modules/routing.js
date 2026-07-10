// modules/routing.js — 统一路由引擎（合并主管模式路由 + 智能路由）
let Core = null;

// ===== 智能路由代理定义（autoRoute 模式）=====
const AGENTS = {
  'code': {
    id: 'code',
    name: '代码执行代理',
    description: '负责运行 Python 代码、调试、代码审查',
    systemPrompt: '你是一个代码执行专家，擅长 Python 编程、代码调试和数据分析。如果用户要求运行代码，请直接输出可执行的 Python 代码，并用 ```python 包裹。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['python', '打印', 'range', 'for', 'while', '代码', '执行', '运行', 'print'],
  },
  'text': {
    id: 'text',
    name: '文本生成代理',
    description: '负责写作、翻译、创意内容生成',
    systemPrompt: '你是一个创意写作专家，擅长文案创作、故事编写、翻译和内容润色。请根据用户需求生成高质量文本。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['写', '翻译', '生成', '文案', '创意', '故事', '文章', '报告', '润色', '改写', '诗'],
  },
  'stock': {
    id: 'stock',
    name: '金融数据代理',
    description: '负责查询股票、基金、财经新闻（需开启联网）',
    systemPrompt: '你是一个金融数据分析师，擅长股票查询、财经新闻解读和市场分析。请务必开启联网搜索获取最新数据。',
    defaultModel: 'deepseek:deepseek-chat',
    keywords: ['股票', '股价', '基金', '行情', '涨停', '跌停', '财经', '经济', '涨幅', '收盘'],
  },
  'knowledge': {
    id: 'knowledge',
    name: '知识库代理',
    description: '基于已上传的文档回答问题',
    systemPrompt: '你是一个知识库助手。请根据提供的文档内容回答用户的问题。如果文档中没有相关信息，请告知用户。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['文档', '上传', '知识库', '文件', '根据文档', '基于资料'],
  },
  'general': {
    id: 'general',
    name: '通用知识代理',
    description: '负责百科问答、常识咨询（默认路由，支持联网）',
    systemPrompt: '你是一个知识渊博的通用助手，擅长回答各类百科、常识和技术问题。如果提供了联网搜索结果，请基于搜索结果回答；如果没有搜索结果，请根据你的知识回答。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['天气', '时间', '日期', '新闻', '最新', '今天', '明天', '现在', '查询', '搜索', '多少钱', '怎么样', '哪里', '是谁', '是什么', '为什么', '如何', '怎么', '多少', '哪个', '介绍', '推荐', '评价', '对比', '区别', '哪里', '地址', '电话', '官网'],
  }
};

// ===== 主管模式角色定义（master 模式后台分发）=====
const MASTER_ROLES = {
  coder: {
    roleType: 'coder',
    displayName: '💻 代码大师',
    keywords: ['代码', '编程', 'python', 'js', 'java', 'c++', '函数', 'bug', 'debug', 'git', '算法', '编译', '运行', '报错', 'error', 'code', 'program', 'function'],
  },
  writer: {
    roleType: 'writer',
    displayName: '✍️ 创意写手',
    keywords: ['写', '文章', '小说', '故事', '诗歌', '文案', '标题', '摘要', '改写', '润色', '作文', '创意', '写作', 'write', 'story', 'poem'],
  },
  analyst: {
    roleType: 'analyst',
    displayName: '📊 数据分析师',
    keywords: ['数据', '分析', '报表', '统计', '图表', '趋势', '预测', '计算', '数值', 'excel', 'csv', 'chart', 'data', 'analysis'],
  },
  teacher: {
    roleType: 'teacher',
    displayName: '🎓 学习导师',
    keywords: ['学习', '解释', '教', '辅导', '课程', '概念', '原理', '公式', 'learn', 'explain', 'teach', 'tutorial'],
  }
};

// ===== 通用关键词匹配函数 =====
function matchKeywords(text, keywordMap) {
  const lower = text.toLowerCase();
  for (const [id, config] of Object.entries(keywordMap)) {
    const keywords = config.keywords || [];
    for (const kw of keywords) {
      if (lower.indexOf(kw.toLowerCase()) >= 0) {
        return { id, keyword: kw, config };
      }
    }
  }
  return null;
}

// ===== 统一路由决策函数 =====
// 返回 { routeType, roleId, displayName, agentId } 或 null（无匹配）
// routeType: 'master-dispatch' | 'agent-route' | null
function analyzeMessage(text, sessionContext) {
  sessionContext = sessionContext || {};
  const isMasterRole = sessionContext.roleType === 'master';
  const autoRoute = sessionContext.autoRoute === true;

  // 清理查询文本（移除搜索上下文标记和文件引用）
  let cleanText = text;
  if (cleanText.includes('用户问题：')) {
    cleanText = cleanText.split('用户问题：')[1] || cleanText;
  }
  if (cleanText.includes('【联网搜索结果】')) {
    cleanText = cleanText.split('【联网搜索结果】')[0] || cleanText;
  }
  // 移除文件附件引用（避免"附件"、"文件"等词误触发知识库/文档路由）
  cleanText = cleanText.replace(/📕|📘|📗|📙|📄/g, '').replace(/附件[：:]\s*\S+/g, '').trim();

  // 优先级 1：主管模式 → 匹配子角色关键词 → 后台分发
  if (isMasterRole) {
    const masterMatch = matchKeywords(cleanText, MASTER_ROLES);
    if (masterMatch) {
      console.log('🎯 统一路由: 主管模式匹配 → ' + masterMatch.id + ' (关键词: "' + masterMatch.keyword + '")');
      return {
        routeType: 'master-dispatch',
        roleId: masterMatch.id,
        displayName: masterMatch.config.displayName,
        roleType: masterMatch.config.roleType,
      };
    }
    // 主管模式下无匹配 → 主管自己处理（不路由）
    console.log('ℹ️ 统一路由: 主管模式无匹配，由主管直接回答');
    return null;
  }

  // 优先级 2：智能路由 → 匹配代理关键词 → 同步路由
  if (autoRoute) {
    const agentMatch = matchKeywords(cleanText, AGENTS);
    if (agentMatch && agentMatch.id !== 'general') {
      console.log('🎯 统一路由: 智能路由匹配 → ' + agentMatch.id + ' (关键词: "' + agentMatch.keyword + '")');
      return {
        routeType: 'agent-route',
        agentId: agentMatch.id,
        displayName: agentMatch.config.name,
      };
    }
    // general 代理不路由，走普通聊天（避免所有消息都被路由）
    console.log('ℹ️ 统一路由: 智能路由无特定匹配，走普通聊天');
  }

  return null;
}

// ===== 智能路由匹配（保留向后兼容）=====
function matchAgent(query) {
  const lower = query.toLowerCase();
  let cleanQuery = lower;
  if (cleanQuery.includes('用户问题：')) {
    cleanQuery = cleanQuery.split('用户问题：')[1] || cleanQuery;
  }
  if (cleanQuery.includes('【联网搜索结果】')) {
    cleanQuery = cleanQuery.split('【联网搜索结果】')[0] || cleanQuery;
  }
  
  for (const [id, agent] of Object.entries(AGENTS)) {
    for (const kw of agent.keywords) {
      if (cleanQuery.includes(kw)) {
        console.log('✅ 路由匹配: 关键词 "' + kw + '" → 代理 ' + id);
        return id;
      }
    }
  }
  console.log('ℹ️ 未命中关键词，路由至通用代理');
  return 'general';
}

function getOrCreateAgentSession(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) return null;
  const sessions = Core.session.sessions;
  for (const [id, data] of Object.entries(sessions)) {
    if (data.title && data.title.includes('[' + agent.name + ']')) {
      return id;
    }
  }
  const newId = Core.generateId();
  sessions[newId] = {
    title: '[' + agent.name + '] ' + new Date().toLocaleString(),
    messages: [{ role: 'system', content: agent.systemPrompt }],
    pinned: false,
  };
  Core.session.saveSession(newId);
  return newId;
}

// ===== 安全获取搜索函数 =====
function getSearchFn() {
  if (Core && Core.webSearch) return Core.webSearch;
  if (Core && Core.search && Core.search.webSearch) return Core.search.webSearch;
  return null;
}

async function callAgent(agentId, task, customSystemPrompt) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error('代理 ' + agentId + ' 不存在');
  const sessionId = getOrCreateAgentSession(agentId);
  const sessionData = Core.session.sessions[sessionId];
  if (!sessionData) throw new Error('无法获取代理会话');

  // 代理内联网搜索
  let finalTask = task;
  const isWebSearchActive = Core.dom.webSearchBtn && Core.dom.webSearchBtn.classList.contains('active') && !Core.dom.webSearchBtn.disabled;
  const hasValidSearchResults = task.includes('【联网搜索结果】') && 
      !task.includes('未找到有效搜索结果') && 
      !task.includes('联网搜索失败') &&
      !task.includes('搜索出错');
  
  if (isWebSearchActive && !hasValidSearchResults) {
    const searchFn = getSearchFn();
    if (searchFn) {
      Core.dom.status.textContent = '🔍 代理正在联网搜索...';
      try {
        let query = task;
        if (query.includes('用户问题：')) {
          query = query.split('用户问题：')[1].split('\n')[0].trim();
        }
        const searchResults = await searchFn(query);
        console.log('📡 代理内搜索结果:', searchResults.substring(0, 100) + '...');
        if (searchResults && searchResults.trim() !== '' && 
            !searchResults.includes('联网搜索失败') &&
            !searchResults.includes('未找到有效')) {
          finalTask = '用户问题：' + query + '\n\n【联网搜索结果】\n' + searchResults + '\n\n请基于上述搜索结果回答。';
        }
      } catch (err) {
        console.error('❌ 代理内搜索失败:', err.message);
      }
    }
  }

  // 构建系统提示词
  let systemPrompt = agent.systemPrompt;
  if (customSystemPrompt) {
    systemPrompt = agent.systemPrompt + '\n\n' + customSystemPrompt;
  }
  if (sessionData.messages[0] && sessionData.messages[0].role === 'system') {
    sessionData.messages[0].content = systemPrompt;
  } else {
    sessionData.messages.unshift({ role: 'system', content: systemPrompt });
  }

  sessionData.messages.push({ role: 'user', content: finalTask });

  // 解析 provider 和 model
  const selectedValue = Core.dom.modelSelect.value;
  const parts = selectedValue.split(':');
  const provider = parts[0] || 'ollama';
  const model = parts.slice(1).join(':') || Core.config.ollamaModel || 'qwen2.5:7b';
  console.log('🔍 调用 API: provider=' + provider + ', model=' + model);

  const temperature = 0.7;

  // 输入长度保护
  var maxInputLength = 20000;
  if (finalTask.length > maxInputLength) {
    console.warn('⚠️ 路由输入过长 (' + finalTask.length + ' 字符)，截取前 ' + maxInputLength + ' 字符');
    finalTask = finalTask.substring(0, maxInputLength) + '\n\n...(内容已截取)';
  }

  try {
    var data = await Core.api.callAPI(finalTask, systemPrompt, temperature, model, provider);
    console.log('📦 API 返回数据:', data);

    let reply = '';
    if (provider === 'ollama') {
      reply = (data.message && data.message.content) || data.response || '';
    } else {
      reply = (data.message && data.message.content) || (data.choices && data.choices[0] && (data.choices[0].message && data.choices[0].message.content || data.choices[0].text)) || '';
    }

    // 空回复重试
    if (!reply) {
      console.warn('⚠️ API 返回空回复，1秒后重试...');
      await new Promise(function(r) { setTimeout(r, 1000); });
      data = await Core.api.callAPI(finalTask, systemPrompt, temperature, model, provider);
      if (provider === 'ollama') {
        reply = (data.message && data.message.content) || data.response || '';
      } else {
        reply = (data.message && data.message.content) || (data.choices && data.choices[0] && (data.choices[0].message && data.choices[0].message.content || data.choices[0].text)) || '';
      }
    }
    
    // 模型身份混淆检测
    if (provider === 'deepseek' && reply && (reply.includes('通义千问') || reply.includes('Qwen') || reply.includes('阿里云'))) {
      console.warn('⚠️ 检测到模型身份异常：选择了 DeepSeek 但返回千问内容');
      reply = '⚠️ 【模型配置异常】\n\n系统检测到：你选择了 DeepSeek 模型，但 API 返回了千问（Qwen）的内容。\n\n可能原因：\n1. 使用了第三方 API 聚合平台的 Key\n2. API Key 配置错误\n\n建议：在设置面板中检查 API Key 配置';
    }

    if (!reply) {
      throw new Error('AI 返回空回复（已重试1次）。可能原因：1) API 服务暂时不可用 2) 模型 ' + model + ' 超出使用额度 3) 请在设置中检查 API Key 配置');
    }

    sessionData.messages.push({ role: 'assistant', content: reply });
    Core.session.saveSession(sessionId);

    return { agentName: agent.name, reply: reply, sessionId: sessionId };
  } catch (err) {
    console.error('❌ callAgent 错误:', err);
    throw new Error('代理处理失败：' + err.message);
  }
}

async function routeMessage(userInput, customSystemPrompt) {
  const agentId = matchAgent(userInput);
  console.log('🎯 路由到代理: ' + agentId);
  try {
    const result = await callAgent(agentId, userInput, customSystemPrompt || null);
    return { success: true, agentId: agentId, agentName: result.agentName, reply: result.reply, sessionId: result.sessionId };
  } catch (err) {
    console.error('❌ 路由错误:', err);
    return { success: false, error: err.message };
  }
}

function listAgents() {
  return Object.entries(AGENTS).map(function(entry) {
    var id = entry[0], config = entry[1];
    return {
      id: id,
      name: config.name,
      description: config.description,
      keywords: config.keywords.join('、'),
    };
  });
}

function listMasterRoles() {
  return Object.entries(MASTER_ROLES).map(function(entry) {
    var id = entry[0], config = entry[1];
    return {
      id: id,
      roleType: config.roleType,
      displayName: config.displayName,
      keywords: config.keywords.join('、'),
    };
  });
}

module.exports = {
  name: 'routing',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    Core.routing = {
      // 统一路由（新接口）
      analyzeMessage: analyzeMessage,
      listMasterRoles: listMasterRoles,

      // 智能路由（保留向后兼容）
      routeMessage: routeMessage,
      matchAgent: matchAgent,
      listAgents: listAgents,
      getAgent: function(id) { return AGENTS[id] || null; },
      callAgent: callAgent,
    };
    console.log('✅ 统一路由引擎已加载（主管模式 + 智能路由合并）');
  }
};