// modules/agent-handoff.js — Agent Handoff 机制：动态任务委派
// 允许 Agent 在执行过程中将子任务委派给专业代理，获取结果后继续执行
var Core = null;
var handoffHistory = [];

// ===== 专业代理注册表 =====
var SPECIALISTS = {
  'code': {
    id: 'code',
    name: '代码专家',
    description: 'Python/JS 编程、代码调试、脚本执行',
    systemPrompt: '你是一个代码执行专家，擅长编写、调试和优化代码。请直接输出可执行代码和结果分析。',
  },
  'research': {
    id: 'research',
    name: '研究分析师',
    description: '信息检索、数据分析、深度研究',
    systemPrompt: '你是一个研究分析师，擅长信息检索、数据分析和深度研究。请提供详尽的分析报告。',
  },
  'writer': {
    id: 'writer',
    name: '写作专家',
    description: '文案创作、文档编辑、内容润色',
    systemPrompt: '你是一个创意写作专家，擅长各类文案创作、文档编辑和内容润色。',
  },
  'math': {
    id: 'math',
    name: '数学专家',
    description: '数学计算、公式推导、统计分析',
    systemPrompt: '你是一个数学专家，擅长数学计算、公式推导和统计分析。请给出详细的计算过程。',
  },
  'translate': {
    id: 'translate',
    name: '翻译专家',
    description: '多语言翻译、文化适配',
    systemPrompt: '你是一个翻译专家，精通中英日韩等多种语言。请提供准确自然的翻译。',
  },
};

// ===== 核心 Handoff 执行 =====
async function executeHandoff(targetAgentId, task, context) {
  var specialist = SPECIALISTS[targetAgentId];
  if (!specialist) {
    return '❌ 未知的专业代理: ' + targetAgentId + '。可用: ' + Object.keys(SPECIALISTS).join(', ');
  }

  if (!Core.api || !Core.api.callAPI) {
    return '❌ API 模块未就绪';
  }

  var startTime = Date.now();
  var record = {
    from: 'main-agent',
    to: targetAgentId,
    task: task,
    timestamp: Date.now(),
    success: false,
    duration: 0,
  };

  try {
    var prompt = task;
    if (context) {
      prompt = '背景信息:\n' + context.substring(0, 1000) + '\n\n任务:\n' + task;
    }

    var data = await Core.api.callAPI(prompt, specialist.systemPrompt, 0.7, null, 'ollama');
    var reply = (data.message && data.message.content) || data.response || '';

    record.success = true;
    record.result = reply.substring(0, 500);
    record.duration = Date.now() - startTime;
    handoffHistory.push(record);

    console.log('[Handoff] ' + targetAgentId + ' completed in ' + record.duration + 'ms');
    return reply;
  } catch (e) {
    record.success = false;
    record.error = e.message;
    record.duration = Date.now() - startTime;
    handoffHistory.push(record);
    return '❌ Handoff 到 ' + specialist.name + ' 失败: ' + e.message;
  }
}

// ===== 作为 Agent 工具注册 =====
function registerHandoffTool() {
  // 注册 handoff_to_agent 工具到 toolsRegistry
  if (Core.toolsRegistry && typeof Core.toolsRegistry.registerTool === 'function') {
    Core.toolsRegistry.registerTool({
      name: 'handoff_to_agent',
      description: '将子任务委派给专业代理执行。可用的专业代理: code(代码), research(研究), writer(写作), math(数学), translate(翻译)',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标代理ID: code/research/writer/math/translate' },
          task: { type: 'string', description: '要委派的任务描述' },
          context: { type: 'string', description: '可选的背景上下文信息' },
        },
        required: ['target', 'task'],
      },
      execute: function(params) {
        return executeHandoff(params.target, params.task, params.context || '');
      },
    });
  }

  // 同时在 _executeAgentActionRaw 的工具映射中添加
  if (Core.agentLoop) {
    Core.agentLoop._handoffHandler = executeHandoff;
  }
}

// ===== 查询与统计 =====
function getHistory() {
  return handoffHistory.slice();
}

function getStats() {
  var total = handoffHistory.length;
  var success = handoffHistory.filter(function(r) { return r.success; }).length;
  var byAgent = {};
  handoffHistory.forEach(function(r) {
    if (!byAgent[r.to]) byAgent[r.to] = { total: 0, success: 0, avgTime: 0 };
    byAgent[r.to].total++;
    if (r.success) byAgent[r.to].success++;
    byAgent[r.to].avgTime = (byAgent[r.to].avgTime * (byAgent[r.to].total - 1) + r.duration) / byAgent[r.to].total;
  });
  return { total: total, success: success, byAgent: byAgent };
}

function clearHistory() {
  handoffHistory = [];
}

function getSpecialists() {
  return Object.keys(SPECIALISTS).map(function(id) {
    return { id: id, name: SPECIALISTS[id].name, description: SPECIALISTS[id].description };
  });
}

// ===== 模块导出 =====
module.exports = {
  name: 'agent-handoff',
  dependencies: ['agent-loop', 'agent-workflow'],
  init: function(_Core) {
    Core = _Core;
    Core.handoff = {
      executeHandoff: executeHandoff,
      getHistory: getHistory,
      getStats: getStats,
      clearHistory: clearHistory,
      getSpecialists: getSpecialists,
      SPECIALISTS: SPECIALISTS,
    };

    // 注册工具
    registerHandoffTool();

    // 注册 /handoff 命令
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/handoff', '查看 Agent Handoff 专业代理列表和统计', function(args) {
        var sub = (args || '').trim().toLowerCase();
        if (sub === 'stats') {
          var s = getStats();
          var lines = ['📊 Handoff 统计'];
          lines.push('总计: ' + s.total + ' | 成功: ' + s.success);
          for (var id in s.byAgent) {
            var a = s.byAgent[id];
            lines.push('  ' + id + ': ' + a.total + '次 (' + a.success + '成功, 平均' + Math.round(a.avgTime) + 'ms)');
          }
          return lines.join('\n');
        }
        if (sub === 'clear') {
          clearHistory();
          return 'Handoff 历史已清空';
        }
        // 默认: 列出专业代理
        var specs = getSpecialists();
        var result = '🔄 Agent Handoff 专业代理:\n';
        specs.forEach(function(sp) {
          result += '  • ' + sp.id + ' — ' + sp.name + ': ' + sp.description + '\n';
        });
        result += '\n用法: /handoff stats | clear';
        return result;
      }, false);
    }

    console.log('✅ Agent Handoff 模块已加载 (' + Object.keys(SPECIALISTS).length + ' 个专业代理)');
  },
};
