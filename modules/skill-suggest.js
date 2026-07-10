// modules/skill-suggest.js - 技能建议模块（基于使用模式自动推荐/进化技能）
var Core = null;
var fs = require('fs');
var path = require('path');

// ===== 使用模式追踪 =====

var usageLog = {}; // sessionId -> { commands, tools, topics, errors, duration }
var patternStats = {}; // pattern key -> { count, lastSeen, contexts }
var suggestionHistory = []; // 已提出的建议

function trackSession(sessionId, data) {
  if (!sessionId) return;
  if (!usageLog[sessionId]) {
    usageLog[sessionId] = { commands: [], tools: [], topics: [], errors: [], startTime: Date.now() };
  }
  var log = usageLog[sessionId];
  if (data.command) log.commands.push(data.command);
  if (data.tool) log.tools.push(data.tool);
  if (data.topic) log.topics.push(data.topic);
  if (data.error) log.errors.push({ msg: data.error, time: Date.now() });
  log.lastActive = Date.now();
  log.duration = (log.lastActive - log.startTime) / 1000;
}

function trackCommand(command) {
  var key = 'cmd:' + command.split(/\s/)[0];
  if (!patternStats[key]) patternStats[key] = { count: 0, lastSeen: 0, contexts: [] };
  patternStats[key].count++;
  patternStats[key].lastSeen = Date.now();
}

function trackToolUse(toolName) {
  var key = 'tool:' + toolName;
  if (!patternStats[key]) patternStats[key] = { count: 0, lastSeen: 0, contexts: [] };
  patternStats[key].count++;
  patternStats[key].lastSeen = Date.now();
}

function trackError(errorMsg) {
  var key = 'err:' + (errorMsg || '').substring(0, 80);
  if (!patternStats[key]) patternStats[key] = { count: 0, lastSeen: 0, contexts: [] };
  patternStats[key].count++;
  patternStats[key].lastSeen = Date.now();
}

// ===== 模式分析 =====

function analyzePatterns() {
  var insights = [];

  // 高频命令分析
  var cmdPatterns = Object.keys(patternStats).filter(function(k) { return k.startsWith('cmd:'); });
  cmdPatterns.sort(function(a, b) { return patternStats[b].count - patternStats[a].count; });
  var topCmds = cmdPatterns.slice(0, 5).map(function(k) {
    return { name: k.substring(4), count: patternStats[k].count };
  });

  // 高频工具分析
  var toolPatterns = Object.keys(patternStats).filter(function(k) { return k.startsWith('tool:'); });
  toolPatterns.sort(function(a, b) { return patternStats[b].count - patternStats[a].count; });
  var topTools = toolPatterns.slice(0, 5).map(function(k) {
    return { name: k.substring(5), count: patternStats[k].count };
  });

  // 重复错误分析
  var errPatterns = Object.keys(patternStats).filter(function(k) { return k.startsWith('err:'); });
  var frequentErrors = errPatterns
    .filter(function(k) { return patternStats[k].count >= 2; })
    .sort(function(a, b) { return patternStats[b].count - patternStats[a].count; })
    .slice(0, 3)
    .map(function(k) { return { msg: k.substring(4), count: patternStats[k].count }; });

  return { topCommands: topCmds, topTools: topTools, frequentErrors: frequentErrors };
}

// ===== 技能建议生成 =====

function generateSuggestions() {
  var analysis = analyzePatterns();
  var suggestions = [];
  var existingSkills = Core.skills ? Core.skills.list() : [];
  var existingIds = existingSkills.map(function(s) { return s.id; });

  // 1. 基于高频命令的技能建议
  analysis.topCommands.forEach(function(cmd) {
    if (cmd.count >= 3) {
      var skillId = suggestSkillForCommand(cmd.name);
      if (skillId && existingIds.indexOf(skillId) < 0) {
        suggestions.push({
          type: 'new_skill',
          skillId: skillId,
          reason: '命令 /' + cmd.name + ' 已使用 ' + cmd.count + ' 次，建议创建专属技能',
          confidence: Math.min(0.9, 0.4 + cmd.count * 0.1),
          template: buildSkillTemplate(cmd.name),
        });
      }
    }
  });

  // 2. 基于工具组合的工作流建议
  if (analysis.topTools.length >= 2) {
    var toolCombo = analysis.topTools.slice(0, 3).map(function(t) { return t.name; });
    var workflowId = 'workflow-' + toolCombo.join('-').substring(0, 30);
    if (existingIds.indexOf(workflowId) < 0) {
      suggestions.push({
        type: 'workflow',
        skillId: workflowId,
        reason: '常用工具组合: ' + toolCombo.join(' + '),
        confidence: 0.6,
        template: buildWorkflowTemplate(toolCombo),
      });
    }
  }

  // 3. 基于重复错误的修复建议
  analysis.frequentErrors.forEach(function(err) {
    if (err.count >= 2) {
      suggestions.push({
        type: 'error_fix',
        reason: '重复错误 (' + err.count + ' 次): ' + err.msg.substring(0, 60),
        confidence: 0.7,
        fix: suggestErrorFix(err.msg),
      });
    }
  });

  // 4. 现有技能改进建议
  existingSkills.forEach(function(skill) {
    var improveSuggestion = suggestSkillImprovement(skill);
    if (improveSuggestion) suggestions.push(improveSuggestion);
  });

  // 去重：过滤已建议过的
  var existingSuggIds = suggestionHistory.map(function(s) { return s.skillId || s.reason; });
  suggestions = suggestions.filter(function(s) {
    var key = s.skillId || s.reason;
    return existingSuggIds.indexOf(key) < 0;
  });

  return suggestions;
}

// ===== 命令 → 技能映射 =====

var COMMAND_SKILL_MAP = {
  'github': { id: 'github-workflow', name: 'GitHub 工作流', desc: '自动化 GitHub PR/Issue/Release 工作流' },
  'docker': { id: 'docker-helper', name: 'Docker 助手', desc: 'Docker 容器管理、镜像构建、compose 编排' },
  'deploy': { id: 'deployment', name: '部署自动化', desc: '应用部署到云服务器/容器平台' },
  'test': { id: 'test-runner', name: '测试运行器', desc: '自动化运行测试、生成覆盖率报告' },
  'lint': { id: 'code-linter', name: '代码质量检查', desc: '自动运行 lint 检查并修复问题' },
  'db': { id: 'database-admin', name: '数据库管理', desc: '数据库查询、迁移、备份操作' },
  'api': { id: 'api-tester', name: 'API 测试', desc: 'RESTful API 请求测试和调试' },
  'log': { id: 'log-analyzer', name: '日志分析', desc: '应用日志搜索、过滤和分析' },
  'backup': { id: 'backup-manager', name: '备份管理', desc: '文件和数据库的自动备份与恢复' },
  'monitor': { id: 'system-monitor', name: '系统监控', desc: '服务器状态、资源使用监控' },
};

function suggestSkillForCommand(cmdName) {
  var mapped = COMMAND_SKILL_MAP[cmdName];
  return mapped ? mapped.id : null;
}

// ===== 模板构建 =====

function buildSkillTemplate(cmdName) {
  var mapped = COMMAND_SKILL_MAP[cmdName];
  var name = mapped ? mapped.name : cmdName + ' 助手';
  var desc = mapped ? mapped.desc : '自动化 ' + cmdName + ' 相关操作';

  return {
    id: 'custom-' + cmdName,
    name: name,
    description: desc,
    systemPrompt: '你是一个 ' + name + ' 专家。用户需要你帮助完成 ' + cmdName + ' 相关任务。\n\n' +
      '你的职责：\n' +
      '1. 理解用户的 ' + cmdName + ' 需求\n' +
      '2. 提供最佳实践建议\n' +
      '3. 执行自动化操作\n' +
      '4. 报告执行结果',
    version: '1.0.0',
  };
}

function buildWorkflowTemplate(tools) {
  return {
    id: 'workflow-custom',
    name: '自定义工作流 (' + tools.join(' → ') + ')',
    description: '将常用工具串联执行的自动化工作流',
    systemPrompt: '你是一个工作流自动化专家。按照以下步骤执行任务：\n\n' +
      tools.map(function(t, i) { return (i + 1) + '. 使用 ' + t + ' 工具'; }).join('\n') +
      '\n\n确保每一步都成功后再执行下一步。',
    version: '1.0.0',
  };
}

// ===== 技能改进建议 =====

function suggestSkillImprovement(skill) {
  if (!skill || skill.source !== 'file') return null;

  var improvements = [];

  // 检查是否有版本信息
  if (!skill.version || skill.version === '1.0.0') {
    improvements.push('添加版本号以便追踪变更');
  }

  // 检查描述是否足够详细
  if (!skill.description || skill.description.length < 20) {
    improvements.push('完善技能描述（当前过短）');
  }

  if (improvements.length === 0) return null;

  return {
    type: 'improve',
    skillId: skill.id,
    reason: '技能 "' + skill.name + '" 可以改进: ' + improvements.join('; '),
    confidence: 0.5,
    improvements: improvements,
  };
}

// ===== 错误修复建议 =====

function suggestErrorFix(errorMsg) {
  if (!errorMsg) return '请检查错误详情';

  if (errorMsg.indexOf('ENOENT') >= 0) return '文件路径不存在，请检查路径是否正确';
  if (errorMsg.indexOf('EACCES') >= 0 || errorMsg.indexOf('permission') >= 0)
    return '权限不足，尝试以管理员身份运行或修改文件权限';
  if (errorMsg.indexOf('ECONNREFUSED') >= 0) return '连接被拒绝，请检查目标服务是否已启动';
  if (errorMsg.indexOf('timeout') >= 0) return '操作超时，可能是网络问题或服务响应过慢';
  if (errorMsg.indexOf('JSON') >= 0) return 'JSON 解析失败，请检查数据格式';
  if (errorMsg.indexOf('API Key') >= 0 || errorMsg.indexOf('key') >= 0)
    return 'API Key 无效或缺失，请在设置面板中配置';

  return '建议搜索该错误的解决方案，或检查相关文档';
}

// ===== 技能创建辅助 =====

function createSkillFromSuggestion(suggestion) {
  if (!suggestion || !suggestion.template) {
    return { success: false, error: '无效的建议' };
  }

  var template = suggestion.template;

  if (Core.skills && Core.skills.create) {
    try {
      var result = Core.skills.create({
        id: template.id,
        name: template.name,
        description: template.description,
        systemPrompt: template.systemPrompt,
        version: template.version,
      });
      if (result && result.success !== false) {
        // 记录已采纳
        suggestionHistory.push({
          skillId: suggestion.skillId,
          reason: suggestion.reason,
          adopted: true,
          time: Date.now(),
        });
        return { success: true, skillId: template.id };
      }
      return result || { success: false, error: '创建失败' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // 直接写文件
  try {
    var base = Core._globalDataRoot || Core.DATA_ROOT || 'E:\\my-ai-data';
    var skillDir = path.join(base, 'skills', template.id);
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
      id: template.id,
      name: template.name,
      description: template.description,
      version: template.version,
    }, null, 2));

    fs.writeFileSync(path.join(skillDir, 'prompt.md'), template.systemPrompt);

    // 刷新技能列表
    if (Core.skills && Core.skills.refresh) Core.skills.refresh();

    suggestionHistory.push({
      skillId: suggestion.skillId,
      reason: suggestion.reason,
      adopted: true,
      time: Date.now(),
    });

    return { success: true, skillId: template.id, path: skillDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 持久化 =====

function getStatsFilePath() {
  var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || 'E:\\my-ai-data';
  return path.join(base, 'skill-suggest-stats.json');
}

function saveStats() {
  try {
    fs.writeFileSync(getStatsFilePath(), JSON.stringify({
      patternStats: patternStats,
      suggestionHistory: suggestionHistory.slice(-50),
    }, null, 2));
  } catch (e) {}
}

function loadStats() {
  try {
    var filePath = getStatsFilePath();
    if (fs.existsSync(filePath)) {
      var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      patternStats = data.patternStats || {};
      suggestionHistory = data.suggestionHistory || [];
    }
  } catch (e) {}
}

// ===== 格式化输出 =====

function formatSuggestions(suggestions) {
  if (!suggestions || suggestions.length === 0) return '暂无建议';
  var lines = suggestions.map(function (s, i) {
    var icon = s.type === 'new_skill' ? '💡' : s.type === 'workflow' ? '🔄' :
      s.type === 'error_fix' ? '🔧' : '📝';
    var conf = Math.round((s.confidence || 0) * 100) + '%';
    return icon + ' [' + conf + '] ' + s.reason;
  });
  return lines.join('\n');
}

function formatStats() {
  var analysis = analyzePatterns();
  var lines = ['📊 使用模式统计'];
  if (analysis.topCommands.length > 0) {
    lines.push('\n常用命令:');
    analysis.topCommands.forEach(function(c) {
      lines.push('  /' + c.name + ' × ' + c.count);
    });
  }
  if (analysis.topTools.length > 0) {
    lines.push('\n常用工具:');
    analysis.topTools.forEach(function(t) {
      lines.push('  ' + t.name + ' × ' + t.count);
    });
  }
  if (analysis.frequentErrors.length > 0) {
    lines.push('\n常见错误:');
    analysis.frequentErrors.forEach(function(e) {
      lines.push('  ⚠️ ' + e.msg.substring(0, 50) + ' × ' + e.count);
    });
  }
  return lines.join('\n');
}

// ===== 命令处理 =====

function handleCommand(args) {
  var parts = args.trim().split(/\s+/);
  var cmd = parts[0] || 'help';

  switch (cmd) {
    case 'suggest':
    case 's':
      var suggestions = generateSuggestions();
      if (suggestions.length === 0) return '暂无新建议。继续使用后会基于你的模式推荐技能。';
      return '💡 技能建议 (' + suggestions.length + ' 条):\n\n' + formatSuggestions(suggestions) +
        '\n\n使用 /skill-suggest adopt <序号> 采纳建议';

    case 'adopt':
    case 'a':
      var idx = parseInt(parts[1]) - 1;
      var allSuggestions = generateSuggestions();
      if (idx < 0 || idx >= allSuggestions.length) return '⚠️ 无效序号，使用 /skill-suggest suggest 查看';
      var result = createSkillFromSuggestion(allSuggestions[idx]);
      return result.success ? '✅ 技能已创建: ' + result.skillId : '❌ ' + (result.error || '创建失败');

    case 'stats':
      return formatStats();

    case 'reset':
      patternStats = {};
      suggestionHistory = [];
      saveStats();
      return '✅ 使用统计已重置';

    case 'track':
      // 手动追踪（调试用）
      if (parts[1] === 'cmd' && parts[2]) { trackCommand(parts[2]); return '✅ 已追踪命令: ' + parts[2]; }
      if (parts[1] === 'tool' && parts[2]) { trackToolUse(parts[2]); return '✅ 已追踪工具: ' + parts[2]; }
      if (parts[1] === 'error' && parts[2]) { trackError(parts.slice(2).join(' ')); return '✅ 已追踪错误'; }
      return '用法: /skill-suggest track [cmd|tool|error] <value>';

    default:
      return '💡 技能建议命令\n' +
        '/skill-suggest suggest — 查看技能建议\n' +
        '/skill-suggest adopt <序号> — 采纳建议并创建技能\n' +
        '/skill-suggest stats — 查看使用统计\n' +
        '/skill-suggest reset — 重置统计\n' +
        '/skill-suggest track <type> <value> — 手动追踪';
  }
}

// ===== 模块导出 =====

module.exports = {
  name: 'skill-suggest',
  dependencies: ['routing', 'skill'],
  init(_Core) {
    Core = _Core;

    // 加载历史统计
    loadStats();

    Core.skillSuggest = {
      trackSession: trackSession,
      trackCommand: trackCommand,
      trackToolUse: trackToolUse,
      trackError: trackError,
      analyze: analyzePatterns,
      suggest: generateSuggestions,
      adopt: createSkillFromSuggestion,
      saveStats: saveStats,
    };

    // 注册命令
    if (Core.routing && Core.routing.register) {
      Core.routing.register('/skill-suggest', handleCommand, '技能建议（基于使用模式推荐/进化技能）');
    }

    // 定期保存统计
    var _statsTimer = setInterval(saveStats, 60000);

    console.log('✅ Skill-Suggest 模块已加载（使用模式分析 + 技能建议）');
  }
};
