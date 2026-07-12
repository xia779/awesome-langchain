// server/modules/routing.js — 统一路由引擎（主管模式路由 + 智能路由）
var Core = null;

// ===== 智能路由代理定义 =====
var AGENTS = {
  'code': {
    id: 'code',
    name: '代码执行代理',
    description: '负责运行 Python 代码、调试、代码审查',
    systemPrompt: '你是一个代码执行专家，擅长 Python 编程、代码调试和数据分析。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['python', '打印', 'range', 'for', 'while', '代码', '执行', '运行', 'print'],
  },
  'text': {
    id: 'text',
    name: '文本生成代理',
    description: '负责写作、翻译、创意内容生成',
    systemPrompt: '你是一个创意写作专家，擅长文案创作、故事编写、翻译和内容润色。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['写', '翻译', '生成', '文案', '创意', '故事', '文章', '报告', '润色', '改写', '诗'],
  },
  'stock': {
    id: 'stock',
    name: '金融数据代理',
    description: '负责查询股票、基金、财经新闻',
    systemPrompt: '你是一个金融数据分析师，擅长股票查询、财经新闻解读和市场分析。',
    defaultModel: 'deepseek:deepseek-chat',
    keywords: ['股票', '股价', '基金', '行情', '涨停', '跌停', '财经', '经济', '涨幅', '收盘'],
  },
  'knowledge': {
    id: 'knowledge',
    name: '知识库代理',
    description: '基于已上传的文档回答问题',
    systemPrompt: '你是一个知识库助手。请根据提供的文档内容回答用户的问题。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['文档', '上传', '知识库', '文件', '根据文档', '基于资料'],
  },
  'general': {
    id: 'general',
    name: '通用知识代理',
    description: '负责百科问答、常识咨询（默认路由）',
    systemPrompt: '你是一个知识渊博的通用助手，擅长回答各类百科、常识和技术问题。',
    defaultModel: 'ollama:qwen2.5:7b',
    keywords: ['天气', '时间', '日期', '新闻', '最新', '今天', '明天', '现在', '查询', '搜索', '怎么样', '哪里', '是谁', '是什么', '为什么', '如何', '怎么', '多少', '哪个', '介绍', '推荐', '评价', '对比', '区别'],
  }
};

// ===== 主管模式角色定义 =====
var MASTER_ROLES = {
  coder: {
    roleType: 'coder',
    displayName: 'Code Master',
    keywords: ['代码', '编程', 'python', 'js', 'java', 'c++', '函数', 'bug', 'debug', 'git', '算法', '编译', '运行', '报错', 'error', 'code', 'program', 'function'],
  },
  writer: {
    roleType: 'writer',
    displayName: 'Creative Writer',
    keywords: ['写', '文章', '小说', '故事', '诗歌', '文案', '标题', '摘要', '改写', '润色', '作文', '创意', '写作', 'write', 'story', 'poem'],
  },
  analyst: {
    roleType: 'analyst',
    displayName: 'Data Analyst',
    keywords: ['数据', '分析', '报表', '统计', '图表', '趋势', '预测', '计算', '数值', 'excel', 'csv', 'chart', 'data', 'analysis'],
  },
  teacher: {
    roleType: 'teacher',
    displayName: 'Learning Tutor',
    keywords: ['学习', '解释', '教', '辅导', '课程', '概念', '原理', '公式', 'learn', 'explain', 'teach', 'tutorial'],
  }
};

// ===== 通用关键词匹配 =====
function matchKeywords(text, keywordMap) {
  var lower = text.toLowerCase();
  var entries = Object.entries(keywordMap);
  for (var i = 0; i < entries.length; i++) {
    var id = entries[i][0];
    var config = entries[i][1];
    var keywords = config.keywords || [];
    for (var j = 0; j < keywords.length; j++) {
      if (lower.indexOf(keywords[j].toLowerCase()) >= 0) {
        return { id: id, keyword: keywords[j], config: config };
      }
    }
  }
  return null;
}

// ===== 统一路由决策 =====
function analyzeMessage(text, sessionContext) {
  sessionContext = sessionContext || {};
  var isMasterRole = sessionContext.roleType === 'master';
  var autoRoute = sessionContext.autoRoute === true;

  // Clean text
  var cleanText = text;
  if (cleanText.indexOf('用户问题：') >= 0) {
    cleanText = cleanText.split('用户问题：')[1] || cleanText;
  }
  if (cleanText.indexOf('【联网搜索结果】') >= 0) {
    cleanText = cleanText.split('【联网搜索结果】')[0] || cleanText;
  }
  cleanText = cleanText.replace(/附件[：:]\s*\S+/g, '').trim();

  // Priority 1: Master mode → dispatch to sub-role
  if (isMasterRole) {
    var masterMatch = matchKeywords(cleanText, MASTER_ROLES);
    if (masterMatch) {
      return {
        routeType: 'master-dispatch',
        roleId: masterMatch.id,
        displayName: masterMatch.config.displayName,
        roleType: masterMatch.config.roleType,
      };
    }
    return null; // Master handles directly
  }

  // Priority 2: Smart routing → match agent
  if (autoRoute) {
    var agentMatch = matchKeywords(cleanText, AGENTS);
    if (agentMatch && agentMatch.id !== 'general') {
      return {
        routeType: 'agent-route',
        agentId: agentMatch.id,
        displayName: agentMatch.config.name,
      };
    }
  }

  return null;
}

// ===== 智能路由匹配（向后兼容）=====
function matchAgent(query) {
  var lower = query.toLowerCase();
  var cleanQuery = lower;
  if (cleanQuery.indexOf('用户问题：') >= 0) {
    cleanQuery = cleanQuery.split('用户问题：')[1] || cleanQuery;
  }
  var entries = Object.entries(AGENTS);
  for (var i = 0; i < entries.length; i++) {
    var id = entries[i][0];
    var agent = entries[i][1];
    for (var j = 0; j < agent.keywords.length; j++) {
      if (cleanQuery.indexOf(agent.keywords[j]) >= 0) {
        console.log('[routing] matched: ' + agent.keywords[j] + ' -> ' + id);
        return id;
      }
    }
  }
  return 'general';
}

// ===== Agent 会话管理 =====
function getOrCreateAgentSession(agentId) {
  var agent = AGENTS[agentId];
  if (!agent) return null;
  var sessionMod = Core.getModule ? Core.getModule('session') : null;
  if (!sessionMod) return null;

  var sessions = sessionMod.list();
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].name && sessions[i].name.indexOf('[' + agent.name + ']') >= 0) {
      return sessions[i].id;
    }
  }
  // Create new
  var newId = Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  sessionMod.create(newId, '[' + agent.name + '] ' + new Date().toLocaleString());
  // Add system message
  sessionMod.addMessage(newId, 'system', agent.systemPrompt);
  return newId;
}

// ===== Agent 调用（通过 cloud-api）=====
async function callAgent(agentId, task, options) {
  options = options || {};
  var agent = AGENTS[agentId];
  if (!agent) throw new Error('Agent ' + agentId + ' not found');

  var cloudApi = Core.getModule ? Core.getModule('cloud-api') : null;
  if (!cloudApi) throw new Error('cloud-api module not available');

  var systemPrompt = agent.systemPrompt;
  if (options.customSystemPrompt) {
    systemPrompt += '\n\n' + options.customSystemPrompt;
  }

  // Inject knowledge context if available
  if (Core.knowledge && options.query) {
    try {
      var kbResult = await Core.knowledge.searchWithCitations(options.query, 3);
      if (kbResult && kbResult.context) {
        systemPrompt += '\n\nKnowledge base context:\n' + kbResult.context;
      }
    } catch (e) {}
  }

  // Inject memory context if available
  if (Core.memory && task) {
    try {
      var memCtx = Core.memory.getEnhancedContext(task);
      if (memCtx) {
        systemPrompt += '\n\n' + memCtx;
      }
    } catch (e) {}
  }

  var provider = options.provider || Core.config.defaultProvider || 'ollama';
  var model = options.model || Core.config.defaultModel || 'qwen2.5:7b';
  var temperature = options.temperature || 0.7;

  var data = await cloudApi.callAPI(task, systemPrompt, temperature, model, provider);

  var reply = '';
  if (provider === 'ollama') {
    reply = (data.message && data.message.content) || data.response || '';
  } else {
    reply = (data.message && data.message.content) || (data.choices && data.choices[0] && (data.choices[0].message && data.choices[0].message.content || data.choices[0].text)) || '';
  }

  // Empty reply retry
  if (!reply) {
    await new Promise(function(r) { setTimeout(r, 1000); });
    data = await cloudApi.callAPI(task, systemPrompt, temperature, model, provider);
    if (provider === 'ollama') {
      reply = (data.message && data.message.content) || data.response || '';
    } else {
      reply = (data.message && data.message.content) || (data.choices && data.choices[0] && (data.choices[0].message && data.choices[0].message.content || data.choices[0].text)) || '';
    }
  }

  if (!reply) {
    throw new Error('AI returned empty reply');
  }

  // Save to agent session
  var sessionId = getOrCreateAgentSession(agentId);
  if (sessionId) {
    var sessionMod = Core.getModule ? Core.getModule('session') : null;
    if (sessionMod) {
      sessionMod.addMessage(sessionId, 'user', task);
      sessionMod.addMessage(sessionId, 'assistant', reply);
    }
  }

  // Output guardrails check
  if (Core.guardrails) {
    var outputCheck = Core.guardrails.checkOutput(reply);
    if (!outputCheck.safe && outputCheck.cleaned) {
      reply = outputCheck.cleaned;
    }
  }

  return { agentName: agent.name, reply: reply, sessionId: sessionId };
}

async function routeMessage(userInput, options) {
  var agentId = matchAgent(userInput);
  try {
    var result = await callAgent(agentId, userInput, options);
    return { success: true, agentId: agentId, agentName: result.agentName, reply: result.reply };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function listAgents() {
  return Object.entries(AGENTS).map(function(entry) {
    return { id: entry[0], name: entry[1].name, description: entry[1].description, keywords: entry[1].keywords.join(', ') };
  });
}

function listMasterRoles() {
  return Object.entries(MASTER_ROLES).map(function(entry) {
    return { id: entry[0], roleType: entry[1].roleType, displayName: entry[1].displayName, keywords: entry[1].keywords.join(', ') };
  });
}

// ===== 模块导出 =====
module.exports = {
  name: 'routing',
  dependencies: ['cloud-api', 'guardrails'],
  init: function(_Core, router) {
    Core = _Core;

    // Register WebSocket handlers
    if (router) {
      router.handle('routing.analyze', function(params) {
        return analyzeMessage(params.text, params.context) || { routeType: null };
      });
      router.handle('routing.matchAgent', function(params) {
        return { agentId: matchAgent(params.query) };
      });
      router.handle('routing.listAgents', function() {
        return { agents: listAgents() };
      });
      router.handle('routing.listMasterRoles', function() {
        return { roles: listMasterRoles() };
      });
      router.handle('routing.callAgent', async function(params) {
        try {
          return await callAgent(params.agentId, params.task, params.options);
        } catch (e) {
          return { error: e.message };
        }
      });
      router.handle('routing.routeMessage', async function(params) {
        return await routeMessage(params.userInput, params.options);
      });
    }

    // Expose on Core
    Core.routing = {
      analyzeMessage: analyzeMessage,
      listMasterRoles: listMasterRoles,
      routeMessage: routeMessage,
      matchAgent: matchAgent,
      listAgents: listAgents,
      getAgent: function(id) { return AGENTS[id] || null; },
      callAgent: callAgent,
    };
    console.log('[routing] loaded (master + smart routing)');
  }
};
