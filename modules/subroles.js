// modules/subroles.js — 子角色注册表 + 执行器（Wave 8）
//
// 对应 DS.txt 2.3.3 子角色设计：每个子角色含 专属系统提示词 / 工具集 / 模型偏好 /
// 资源隔离。本模块维护 4 个预设子角色，并提供统一的 execute() 执行入口——通过
// Core.api.callAPI 以「独立消息上下文 + disableTools」方式调用，实现与主会话的隔离。
//
// 模块契约：{ name, dependencies, init(Core) }，由 core-v10.js loadModules() 自动加载。

var Core = null;

// ═══════════════════════════════════════════
// 子角色注册表（id 与 intent-router 的 ROLE_FOR_INTENT 严格对齐）
// ═══════════════════════════════════════════
var ROLES = {
  code_expert: {
    id: 'code_expert',
    name: '代码专家',
    emoji: '💻',
    description: '代码编写 / 调试 / 重构，绑定文件读写与终端命令',
    taskTypes: ['code_generation'],
    modelPref: null, // null = 跟随当前服务
    tools: ['file_read', 'file_write', 'terminal'],
    systemPrompt: '你是一名资深代码专家，擅长编写、调试、重构和优化代码。' +
      '请直接给出可运行的完整代码（用代码块包裹），并附简明的实现思路与注意事项。' +
      '不要输出与任务无关的寒暄。'
  },
  search_specialist: {
    id: 'search_specialist',
    name: '搜索专员',
    emoji: '🔍',
    description: '联网搜索 / 信息整合，绑定爬虫工具',
    taskTypes: ['web_search'],
    modelPref: null,
    tools: ['web_search', 'crawl'],
    systemPrompt: '你是一名搜索专员，擅长联网检索与信息整合。' +
      '请基于检索到的信息给出结构化、带来源的摘要；若信息不足或相互矛盾，请明确指出。' +
      '不要编造不存在的数据。'
  },
  doc_assistant: {
    id: 'doc_assistant',
    name: '文档助手',
    emoji: '📄',
    description: '文档总结 / RAG 问答，绑定向量数据库',
    taskTypes: ['document_analysis'],
    modelPref: null,
    tools: ['rag', 'vector_db'],
    systemPrompt: '你是一名文档助手，擅长长文档总结、要点提炼与基于资料的问答。' +
      '请输出「核心结论 + 要点清单 + 关键引用」三段式结构，严格忠于原文，不添加臆测。'
  },
  data_analyst: {
    id: 'data_analyst',
    name: '数据分析师',
    emoji: '📊',
    description: '数据处理 / 图表，绑定 Python 执行',
    taskTypes: ['data_analysis'],
    modelPref: null,
    tools: ['python'],
    systemPrompt: '你是一名数据分析师，擅长数据处理、统计分析与可视化。' +
      '请给出分析过程、关键数值结论，以及在需要时可直接执行的 Python 代码（用代码块包裹）。' +
      '涉及具体数字时务必准确，不要凭空估算。'
  }
};

// taskType -> 角色 反查表
var ROLE_FOR_TASKTYPE = {};
Object.keys(ROLES).forEach(function (id) {
  var role = ROLES[id];
  (role.taskTypes || []).forEach(function (tt) { ROLE_FOR_TASKTYPE[tt] = id; });
});

// ═══════════════════════════════════════════
// 查询
// ═══════════════════════════════════════════
function getRole(id) { return ROLES[id] || null; }

function listRoles() {
  return Object.keys(ROLES).map(function (id) {
    var r = ROLES[id];
    return { id: r.id, name: r.name, emoji: r.emoji, description: r.description, taskTypes: r.taskTypes.slice(), tools: r.tools.slice() };
  });
}

function roleForIntent(intent) {
  var id = Core && Core.intentRouter ? Core.intentRouter.roleForIntent(intent) : null;
  return id ? (ROLES[id] || null) : null;
}

function roleForTaskType(taskType) {
  var id = ROLE_FOR_TASKTYPE[taskType];
  return id ? ROLES[id] : null;
}

// ═══════════════════════════════════════════
// 执行器：以独立上下文调用子角色（资源隔离）
//   roleId : 子角色 id
//   query  : 用户指令
//   context: 可选的上下文摘要
// 返回 { content, roleId, role, durationMs }
// ═══════════════════════════════════════════
async function execute(roleId, query, context) {
  var role = ROLES[roleId];
  if (!role) throw new Error('未知子角色: ' + roleId);
  if (!Core || !Core.api || typeof Core.api.callAPI !== 'function') {
    throw new Error('API 模块不可用');
  }

  var start = Date.now();
  var userContent = String(query || '');
  if (context) {
    userContent = '背景信息:\n' + String(context).substring(0, 1500) + '\n\n任务:\n' + userContent;
  }

  var messages = [
    { role: 'system', content: role.systemPrompt },
    { role: 'user', content: userContent }
  ];

  // callAPI(prompt, systemMsg, temperature, model, provider, messagesOverride, options)
  // messagesOverride 独立上下文 + disableTools 避免 function-calling 冲突（资源隔离）
  var data = await Core.api.callAPI(userContent, role.systemPrompt, 0.7, role.modelPref, null, messages, { disableTools: true });

  var content = extractContent(data);
  if (!content) {
    throw new Error('子角色 ' + role.name + ' 返回空内容');
  }
  return { content: content, roleId: role.id, role: role.name, durationMs: Date.now() - start };
}

function extractContent(data) {
  if (!data) return '';
  if (data.message && data.message.content) return data.message.content;
  if (data.response) return data.response;
  if (data.choices && data.choices[0]) {
    var c = data.choices[0];
    return (c.message && c.message.content) || c.text || '';
  }
  return '';
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════
module.exports = {
  name: 'subroles',
  dependencies: [],
  init: function (_Core) {
    Core = _Core;
    Core.subroles = {
      getRole: getRole,
      listRoles: listRoles,
      roleForIntent: roleForIntent,
      roleForTaskType: roleForTaskType,
      execute: execute,
      ROLES: ROLES
    };
    console.log('✅ Subroles 已加载（' + Object.keys(ROLES).length + ' 个子角色）');
  },
  _internals: {
    ROLES: ROLES,
    ROLE_FOR_TASKTYPE: ROLE_FOR_TASKTYPE,
    extractContent: extractContent
  }
};
