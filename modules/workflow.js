// workflow.js - 工作流自动化模块（会话模板 + 自动回复规则 + 批量处理 + 自动摘要）
'use strict';

var Core = null;
var fs = null;
var path = null;

// ===== 数据目录 =====
var TEMPLATES_FILE = '';
var RULES_FILE = '';
var SCHEDULE_FILE = '';

// ===== 会话模板 =====
var templates = {};  // { id: { id, name, roleType, systemPrompt, model, initialMessages[], tags[], createdAt } }

function getTemplatesDir() {
  if (!Core || !Core.DATA_ROOT) return '';
  return Core.DATA_ROOT;
}

function loadTemplates() {
  TEMPLATES_FILE = path.join(getTemplatesDir(), 'workflow-templates.json');
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load templates:', e.message);
    templates = {};
  }
  // 内置默认模板
  if (Object.keys(templates).length === 0) {
    templates = {
      'daily-report': {
        id: 'daily-report', name: '日报生成', roleType: 'writer',
        systemPrompt: '你是一个专业的工作汇报助手。请根据用户提供的工作内容，生成结构化的日报，包含：今日完成、进行中、明日计划、风险/阻塞。语言简洁专业。',
        model: 'deepseek:deepseek-chat', tags: ['工作', '日报'],
        initialMessages: [{ role: 'user', content: '请帮我生成今天的工作日报，以下是今天的工作内容：\n' }],
        createdAt: Date.now()
      },
      'code-review': {
        id: 'code-review', name: '代码审查', roleType: 'coder',
        systemPrompt: '你是一个资深代码审查专家。请审查用户提供的代码，从以下维度给出反馈：\n1. 代码质量和最佳实践\n2. 潜在 bug 和安全问题\n3. 性能优化建议\n4. 可读性和可维护性\n请用具体代码示例说明改进方法。',
        model: 'deepseek:deepseek-chat', tags: ['开发', '审查'],
        initialMessages: [{ role: 'user', content: '请审查以下代码：\n```\n\n```\n' }],
        createdAt: Date.now()
      },
      'meeting-notes': {
        id: 'meeting-notes', name: '会议纪要', roleType: 'writer',
        systemPrompt: '你是一个会议纪要整理专家。请根据用户提供的会议内容，整理成结构化的会议纪要，包含：会议主题、参会人员、讨论要点、决议事项、待办事项（含负责人和截止日期）。',
        model: 'deepseek:deepseek-chat', tags: ['工作', '会议'],
        initialMessages: [{ role: 'user', content: '请帮我整理以下会议内容：\n' }],
        createdAt: Date.now()
      },
      'translate': {
        id: 'translate', name: '专业翻译', roleType: 'chat',
        systemPrompt: '你是一个专业翻译，精通中英文互译。翻译时保持原文的语气和风格，技术术语保持准确。如果是代码注释翻译，保持代码格式不变。',
        model: 'deepseek:deepseek-chat', tags: ['翻译'],
        initialMessages: [],
        createdAt: Date.now()
      },
      'brainstorm': {
        id: 'brainstorm', name: '头脑风暴', roleType: 'chat',
        systemPrompt: '你是一个创意顾问。当用户提出一个主题或问题时，从多个角度进行发散性思考，提供至少 5 个不同方向的创意或解决方案。每个方案包含简短描述和可行性评估。',
        model: 'deepseek:deepseek-chat', tags: ['创意', '策划'],
        initialMessages: [{ role: 'user', content: '我想就以下主题进行头脑风暴：\n' }],
        createdAt: Date.now()
      }
    };
    saveTemplates();
  }
}

function saveTemplates() {
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save templates:', e.message);
  }
}

function saveTemplate(name, options) {
  var id = 'tpl_' + Date.now().toString(36);
  var tpl = {
    id: id,
    name: name || '未命名模板',
    roleType: (options && options.roleType) || 'chat',
    systemPrompt: (options && options.systemPrompt) || Core.config.systemInstruction || '',
    model: (options && options.model) || '',
    tags: (options && options.tags) || [],
    initialMessages: (options && options.initialMessages) || [],
    createdAt: Date.now()
  };
  templates[id] = tpl;
  saveTemplates();
  return tpl;
}

function saveCurrentAsTemplate(name) {
  var currentId = Core.session.getCurrentId();
  var session = Core.session.sessions[currentId];
  if (!session) return { success: false, error: '无当前会话' };

  // 获取系统提示词（从当前配置）
  var systemPrompt = Core.config.systemInstruction || '';
  // 获取当前模型
  var modelSelect = document.getElementById('modelSelect');
  var model = modelSelect ? modelSelect.value : '';

  // 取前 3 条消息作为初始消息模板
  var msgs = session.messages || [];
  var initialMessages = [];
  for (var i = 0; i < Math.min(msgs.length, 3); i++) {
    initialMessages.push({
      role: msgs[i].role || 'user',
      content: msgs[i].content || ''
    });
  }

  var tpl = saveTemplate(name || session.title || '未命名模板', {
    roleType: session.roleType || 'chat',
    systemPrompt: systemPrompt,
    model: model,
    tags: [],
    initialMessages: initialMessages
  });

  return { success: true, template: tpl };
}

function useTemplate(templateId) {
  var tpl = templates[templateId];
  if (!tpl) return { success: false, error: '模板不存在' };

  // 创建新会话
  var newId = Core.session.newChat(tpl.roleType || 'chat', null);

  // 设置系统提示词（临时覆盖）
  if (tpl.systemPrompt) {
    Core.config.systemInstruction = tpl.systemPrompt;
    // 不保存到全局配置，只在本会话生效
    // 通过在 session 上设置 _customSystemPrompt 实现
    var session = Core.session.sessions[newId];
    if (session) {
      session._customSystemPrompt = tpl.systemPrompt;
    }
  }

  // 设置模型
  if (tpl.model) {
    var modelSelect = document.getElementById('modelSelect');
    if (modelSelect) {
      modelSelect.value = tpl.model;
      // 触发 change 事件
      var evt = new Event('change');
      modelSelect.dispatchEvent(evt);
    }
  }

  // 预填充初始消息到输入框
  if (tpl.initialMessages && tpl.initialMessages.length > 0) {
    var lastMsg = tpl.initialMessages[tpl.initialMessages.length - 1];
    if (lastMsg.role === 'user') {
      var input = document.getElementById('input');
      if (input) {
        input.value = lastMsg.content;
        input.focus();
        // 自动调整高度
        input.style.height = 'auto';
        input.style.height = input.scrollHeight + 'px';
      }
    }
  }

  // 重命名会话
  Core.session.renameSession(newId, tpl.name + ' ' + new Date().toLocaleDateString('zh-CN'));

  return { success: true, sessionId: newId, template: tpl };
}

function deleteTemplate(templateId) {
  if (!templates[templateId]) return { success: false, error: '模板不存在' };
  delete templates[templateId];
  saveTemplates();
  return { success: true };
}

function listTemplates() {
  return Object.values(templates).sort(function(a, b) { return b.createdAt - a.createdAt; });
}

// ===== 自动回复规则 =====
var rules = [];  // [{ id, name, enabled, trigger: {type, pattern}, action: {type, response, agentId, modifyTemplate} }]

function loadRules() {
  RULES_FILE = path.join(getTemplatesDir(), 'workflow-rules.json');
  try {
    if (fs.existsSync(RULES_FILE)) {
      rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load rules:', e.message);
    rules = [];
  }
}

function saveRules() {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save rules:', e.message);
  }
}

function addRule(rule) {
  var newRule = {
    id: 'rule_' + Date.now().toString(36),
    name: rule.name || '新规则',
    enabled: rule.enabled !== false,
    trigger: {
      type: (rule.trigger && rule.trigger.type) || 'keyword',  // keyword | regex | prefix
      pattern: (rule.trigger && rule.trigger.pattern) || '',
      caseSensitive: (rule.trigger && rule.trigger.caseSensitive) || false
    },
    action: {
      type: (rule.action && rule.action.type) || 'reply',  // reply | redirect | modify | block
      response: (rule.action && rule.action.response) || '',
      agentId: (rule.action && rule.action.agentId) || '',
      modifyTemplate: (rule.action && rule.action.modifyTemplate) || ''
    },
    priority: rule.priority || 0,
    createdAt: Date.now()
  };
  rules.push(newRule);
  rules.sort(function(a, b) { return b.priority - a.priority; });
  saveRules();
  return newRule;
}

function updateRule(ruleId, updates) {
  var idx = rules.findIndex(function(r) { return r.id === ruleId; });
  if (idx < 0) return { success: false, error: '规则不存在' };
  Object.assign(rules[idx], updates);
  saveRules();
  return { success: true, rule: rules[idx] };
}

function deleteRule(ruleId) {
  rules = rules.filter(function(r) { return r.id !== ruleId; });
  saveRules();
  return { success: true };
}

function listRules() {
  return rules.slice();
}

// 检查消息是否匹配规则
function matchRules(message) {
  var matches = [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule.enabled) continue;

    var trigger = rule.trigger;
    var pattern = trigger.pattern || '';
    var text = trigger.caseSensitive ? message : message.toLowerCase();
    var pat = trigger.caseSensitive ? pattern : pattern.toLowerCase();
    var matched = false;

    if (trigger.type === 'keyword') {
      // 关键词列表（逗号分隔）
      var keywords = pat.split(',').map(function(k) { return k.trim(); }).filter(Boolean);
      matched = keywords.some(function(kw) { return text.indexOf(kw) >= 0; });
    } else if (trigger.type === 'regex') {
      try {
        var re = new RegExp(pattern, trigger.caseSensitive ? '' : 'i');
        matched = re.test(message);
      } catch (e) { /* invalid regex, skip */ }
    } else if (trigger.type === 'prefix') {
      matched = text.indexOf(pat) === 0;
    }

    if (matched) {
      matches.push(rule);
    }
  }
  return matches;
}

// beforeSend hook 处理器
function handleBeforeSend(message) {
  var matched = matchRules(message);
  if (matched.length === 0) return message; // 不修改，放行

  for (var i = 0; i < matched.length; i++) {
    var rule = matched[i];
    var action = rule.action;

    if (action.type === 'block') {
      // 阻止发送
      if (Core.dom && Core.dom.status) {
        Core.dom.status.textContent = '⚠️ 规则 "' + rule.name + '" 阻止了消息发送';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
      }
      return null; // null = block in hook system
    }

    if (action.type === 'reply') {
      // 自动回复（跳过 AI，直接添加回复消息）
      setTimeout(function() {
        var currentId = Core.session.getCurrentId();
        if (currentId && Core.session.addMessage) {
          Core.session.addMessage(message, 'user');
          Core.session.addMessage(action.response, 'assistant');
          if (Core.session.renderMessages) {
            Core.session.renderMessages(currentId);
          }
        }
        // 清除输入
        if (Core.dom && Core.dom.input) {
          Core.dom.input.value = '';
        }
      }, 50);
      return null; // block original send
    }

    if (action.type === 'modify') {
      // 修改消息内容
      var template = action.modifyTemplate || '';
      message = template.replace('{message}', message).replace('{input}', message);
    }

    if (action.type === 'redirect' && action.agentId) {
      // 转发到指定 agent
      setTimeout(function() {
        if (Core.routing && Core.routing.callAgent) {
          Core.routing.callAgent(action.agentId, message).then(function(result) {
            var currentId = Core.session.getCurrentId();
            if (currentId) {
              Core.session.addMessage(message, 'user');
              Core.session.addMessage('[' + result.agentName + '] ' + result.reply, 'assistant');
              if (Core.session.renderMessages) {
                Core.session.renderMessages(currentId);
              }
            }
          });
        }
        if (Core.dom && Core.dom.input) {
          Core.dom.input.value = '';
        }
      }, 50);
      return null; // block original send
    }
  }

  return message; // 放行（可能被 modify 修改过）
}

// ===== 批量处理 =====

function batchSend(message, sessionIds) {
  if (!message || !sessionIds || sessionIds.length === 0) {
    return { success: false, error: '缺少消息或目标会话' };
  }

  var results = [];
  var currentId = Core.session.getCurrentId();

  for (var i = 0; i < sessionIds.length; i++) {
    var sid = sessionIds[i];
    var session = Core.session.sessions[sid];
    if (!session) {
      results.push({ sessionId: sid, success: false, error: '会话不存在' });
      continue;
    }

    try {
      Core.session.addMessage.call({ getCurrentId: function() { return sid; }, sessions: Core.session.sessions }, message, 'user');
      // 实际添加消息到目标会话
      if (session.messages) {
        session.messages.push({
          role: 'user',
          content: message,
          timestamp: Date.now()
        });
      }
      Core.session.saveSession(sid);
      results.push({ sessionId: sid, success: true });
    } catch (e) {
      results.push({ sessionId: sid, success: false, error: e.message });
    }
  }

  // 切回原会话
  if (currentId && Core.session.switchSession) {
    // 不自动切换，避免干扰
  }

  return { success: true, results: results };
}

// 批量摘要 — 对多个会话生成摘要
async function batchSummarize(sessionIds, maxLength) {
  if (!sessionIds || sessionIds.length === 0) {
    return { success: false, error: '缺少目标会话' };
  }

  maxLength = maxLength || 200;
  var summaries = [];

  for (var i = 0; i < sessionIds.length; i++) {
    var sid = sessionIds[i];
    var session = Core.session.sessions[sid];
    if (!session) continue;

    var msgs = session.messages || [];
    if (msgs.length === 0) {
      summaries.push({ sessionId: sid, title: session.title, summary: '(空会话)' });
      continue;
    }

    // 提取关键消息用于摘要
    var content = '';
    var lastMsgs = msgs.slice(-Math.min(msgs.length, 6));
    for (var j = 0; j < lastMsgs.length; j++) {
      var m = lastMsgs[j];
      var role = m.role === 'user' ? '用户' : 'AI';
      var text = (m.content || '').substring(0, 200);
      content += role + ': ' + text + '\n';
    }

    try {
      var systemPrompt = '请用一句话（不超过' + maxLength + '字）总结以下对话的核心内容和结论。直接输出摘要，不要加前缀。';
      var summary = '';
      if (Core.api && Core.api.callAPI) {
        summary = await Core.api.callAPI(content, systemPrompt, 0.3, null, null);
      } else {
        // 简单截取
        summary = msgs[msgs.length - 1].content.substring(0, maxLength);
      }

      summaries.push({
        sessionId: sid,
        title: session.title,
        summary: summary.substring(0, maxLength)
      });
    } catch (e) {
      summaries.push({
        sessionId: sid,
        title: session.title,
        summary: '(摘要生成失败: ' + e.message + ')'
      });
    }
  }

  return { success: true, summaries: summaries };
}

// 生成当前会话摘要
async function generateSummary(sessionId) {
  var sid = sessionId || Core.session.getCurrentId();
  var session = Core.session.sessions[sid];
  if (!session) return { success: false, error: '会话不存在' };

  var msgs = session.messages || [];
  if (msgs.length < 2) return { success: false, error: '消息不足，无法生成摘要' };

  // 提取所有消息
  var content = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    var role = m.role === 'user' ? '用户' : (m.role === 'system' ? '系统' : 'AI');
    var text = (m.content || '').substring(0, 300);
    content += role + ': ' + text + '\n\n';
  }

  try {
    var systemPrompt = '请根据以下对话内容，生成一份结构化摘要，包含：\n1. 主题概述（一句话）\n2. 关键讨论点（3-5个）\n3. 结论或下一步行动\n语言简洁专业。';
    var summary = '';
    if (Core.api && Core.api.callAPI) {
      summary = await Core.api.callAPI(content, systemPrompt, 0.3, null, null);
    } else {
      summary = '对话共 ' + msgs.length + ' 条消息';
    }

    // 保存到会话
    session.summary = summary;
    Core.session.saveSession(sid);

    // 添加摘要消息到会话
    Core.session.addMessage('📋 **会话摘要**\n\n' + summary, 'assistant');

    return { success: true, summary: summary };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 命令注册 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  // /template 命令
  Core.custom.registerCommand('template', {
    zh: '会话模板管理: /template list|save|use|delete',
    en: 'Template management'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'list') {
      var list = listTemplates();
      if (list.length === 0) {
        showSystemMessage('📋 暂无模板。使用 /template save 保存当前会话为模板。');
        return;
      }
      var text = '📋 **会话模板列表**\n\n';
      list.forEach(function(tpl, i) {
        text += (i + 1) + '. **' + tpl.name + '** (' + tpl.roleType + ')\n';
        text += '   标签: ' + (tpl.tags || []).join(', ') + ' | ID: ' + tpl.id + '\n';
      });
      text += '\n使用 `/template use <ID>` 启动模板\n使用 `/template delete <ID>` 删除模板';
      showSystemMessage(text);
      return;
    }

    if (sub === 'save') {
      var name = parts.slice(1).join(' ') || '';
      if (!name) {
        showSystemMessage('⚠️ 请提供模板名称: /template save 日报生成');
        return;
      }
      var result = saveCurrentAsTemplate(name);
      if (result.success) {
        showSystemMessage('✅ 模板已保存: **' + result.template.name + '** (ID: ' + result.template.id + ')');
      } else {
        showSystemMessage('❌ 保存失败: ' + result.error);
      }
      return;
    }

    if (sub === 'use') {
      var tplId = parts[1] || '';
      if (!tplId) {
        showSystemMessage('⚠️ 请提供模板 ID: /template use tpl_xxx');
        return;
      }
      // 支持按名称查找
      var tpl = templates[tplId];
      if (!tpl) {
        var found = listTemplates().find(function(t) { return t.name === tplId; });
        if (found) tpl = found;
      }
      if (!tpl) {
        showSystemMessage('❌ 模板不存在: ' + tplId);
        return;
      }
      var result = useTemplate(tpl.id);
      if (result.success) {
        showSystemMessage('✅ 已从模板 "' + tpl.name + '" 创建新会话');
      } else {
        showSystemMessage('❌ 创建失败: ' + result.error);
      }
      return;
    }

    if (sub === 'delete') {
      var delId = parts[1] || '';
      if (!delId) {
        showSystemMessage('⚠️ 请提供模板 ID: /template delete tpl_xxx');
        return;
      }
      var result = deleteTemplate(delId);
      if (result.success) {
        showSystemMessage('✅ 模板已删除');
      } else {
        showSystemMessage('❌ 删除失败: ' + result.error);
      }
      return;
    }

    showSystemMessage('📋 模板命令:\n/template list — 列出所有模板\n/template save <名称> — 保存当前会话为模板\n/template use <ID或名称> — 从模板创建新会话\n/template delete <ID> — 删除模板');
  });

  // /rule 命令
  Core.custom.registerCommand('rule', {
    zh: '自动回复规则: /rule list|add|delete|enable|disable',
    en: 'Auto-reply rules'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'list') {
      var list = listRules();
      if (list.length === 0) {
        showSystemMessage('📋 暂无自动回复规则。使用 /rule add 添加。\n格式: /rule add <名称> | <关键词> | <自动回复内容>');
        return;
      }
      var text = '📋 **自动回复规则**\n\n';
      list.forEach(function(rule, i) {
        var status = rule.enabled ? '✅' : '❌';
        text += (i + 1) + '. ' + status + ' **' + rule.name + '** [' + rule.trigger.type + ': ' + rule.trigger.pattern + ']\n';
        text += '   → ' + rule.action.type + ': ' + (rule.action.response || rule.action.agentId || '').substring(0, 60) + '\n';
        text += '   ID: ' + rule.id + '\n';
      });
      showSystemMessage(text);
      return;
    }

    if (sub === 'add') {
      // 格式: /rule add 名称 | 关键词 | 回复内容
      var rest = parts.slice(1).join(' ');
      var segments = rest.split('|').map(function(s) { return s.trim(); });
      if (segments.length < 3) {
        showSystemMessage('⚠️ 格式: /rule add <名称> | <关键词(逗号分隔)> | <自动回复内容>\n例如: /rule add 打招呼 | 你好,hi,hello | 你好！有什么可以帮你的吗？');
        return;
      }
      var rule = addRule({
        name: segments[0],
        trigger: { type: 'keyword', pattern: segments[1] },
        action: { type: 'reply', response: segments[2] }
      });
      showSystemMessage('✅ 规则已添加: **' + rule.name + '** (ID: ' + rule.id + ')');
      return;
    }

    if (sub === 'delete') {
      var delId = parts[1] || '';
      if (!delId) {
        showSystemMessage('⚠️ 请提供规则 ID: /rule delete rule_xxx');
        return;
      }
      deleteRule(delId);
      showSystemMessage('✅ 规则已删除');
      return;
    }

    if (sub === 'enable' || sub === 'disable') {
      var targetId = parts[1] || '';
      if (!targetId) {
        showSystemMessage('⚠️ 请提供规则 ID');
        return;
      }
      updateRule(targetId, { enabled: sub === 'enable' });
      showSystemMessage('✅ 规则已' + (sub === 'enable' ? '启用' : '禁用'));
      return;
    }

    showSystemMessage('📋 规则命令:\n/rule list — 列出所有规则\n/rule add <名称> | <关键词> | <回复> — 添加规则\n/rule delete <ID> — 删除规则\n/rule enable|disable <ID> — 启用/禁用规则');
  });

  // /batch 命令
  Core.custom.registerCommand('batch', {
    zh: '批量操作: /batch send|summary',
    en: 'Batch operations'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || '';

    if (sub === 'summary') {
      // 批量摘要当前会话
      var currentId = Core.session.getCurrentId();
      if (!currentId) {
        showSystemMessage('⚠️ 无当前会话');
        return;
      }
      showSystemMessage('⏳ 正在生成摘要...');
      generateSummary(currentId).then(function(result) {
        if (result.success) {
          // 摘要已添加到会话
        } else {
          showSystemMessage('❌ 摘要生成失败: ' + result.error);
        }
      });
      return;
    }

    if (sub === 'send') {
      // /batch send <消息> — 发送到所有子会话
      var msg = parts.slice(1).join(' ');
      if (!msg) {
        showSystemMessage('⚠️ 格式: /batch send <消息内容> — 发送到当前会话的所有子会话');
        return;
      }
      var currentId = Core.session.getCurrentId();
      var session = Core.session.sessions[currentId];
      if (!session) {
        showSystemMessage('⚠️ 无当前会话');
        return;
      }
      // 获取子会话
      var childIds = [];
      if (Core.session.sessions) {
        Object.keys(Core.session.sessions).forEach(function(sid) {
          var s = Core.session.sessions[sid];
          if (s && s.parentId === currentId) {
            childIds.push(sid);
          }
        });
      }
      if (childIds.length === 0) {
        showSystemMessage('⚠️ 当前会话没有子会话');
        return;
      }
      var result = batchSend(msg, childIds);
      showSystemMessage('✅ 已发送到 ' + result.results.filter(function(r) { return r.success; }).length + '/' + childIds.length + ' 个子会话');
      return;
    }

    showSystemMessage('📋 批量命令:\n/batch summary — 生成当前会话摘要\n/batch send <消息> — 发送到所有子会话');
  });

  // /summary 命令（快捷方式）
  Core.custom.registerCommand('summary', {
    zh: '生成当前会话摘要',
    en: 'Generate session summary'
  }, function(args) {
    showSystemMessage('⏳ 正在分析对话内容，生成摘要...');
    generateSummary().then(function(result) {
      if (!result.success) {
        showSystemMessage('❌ 摘要生成失败: ' + result.error);
      }
    });
  });
}

// 辅助: 显示系统消息
function showSystemMessage(text) {
  var currentId = Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) {
      Core.session.renderMessages(currentId);
    }
  }
}

// ================================================================
//  Phase 3-3：工作流引擎增强
// ================================================================

// ===== 工作流定义（多步骤链式执行）=====
var workflows = {};

function getWorkflowsDir() {
  if (!Core || !Core.DATA_ROOT) return '';
  return path.join(Core.DATA_ROOT, 'workflows');
}

function loadWorkflows() {
  var dir = getWorkflowsDir();
  if (!dir || !fs.existsSync(dir)) return;
  try {
    var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.json'); });
    files.forEach(function(f) {
      try {
        var data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (data.id) workflows[data.id] = data;
      } catch (e) {}
    });
  } catch (e) { console.warn('加载工作流失败:', e.message); }
}

function saveWorkflows() {
  var dir = getWorkflowsDir();
  if (!dir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (var id in workflows) {
    try {
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(workflows[id], null, 2));
    } catch (e) {}
  }
}

// 创建工作流
function createWorkflow(config) {
  var id = 'wf_' + Date.now().toString(36);
  var wf = {
    id: id,
    name: config.name || '新工作流',
    description: config.description || '',
    enabled: config.enabled !== false,
    trigger: config.trigger || { type: 'manual' },  // manual | keyword | schedule
    steps: config.steps || [],
    variables: config.variables || {},
    createdAt: Date.now()
  };
  workflows[id] = wf;
  saveWorkflows();
  return wf;
}

// 执行工作流步骤
async function executeStep(step, context) {
  var result = { success: false, output: '' };
  context = context || {};

  switch (step.type) {
    case 'ai_call':
      // 调用 AI
      try {
        var prompt = (step.prompt || '').replace(/\{\{(\w+)\}\}/g, function(_, k) { return context[k] || ''; });
        var aiResult = await Core.api.callAPI(prompt, step.systemPrompt || '', step.temperature || 0.7, null, null);
        if (aiResult && aiResult.message) {
          result.success = true;
          result.output = aiResult.message.content || '';
          if (step.saveAs) context[step.saveAs] = result.output;
        }
      } catch (e) { result.error = e.message; }
      break;

    case 'transform':
      // 文本变换（正则替换、截取、格式化）
      try {
        var input = context[step.inputVar] || step.input || '';
        if (step.regex) {
          var re = new RegExp(step.regex, step.flags || 'g');
          input = input.replace(re, step.replacement || '');
        }
        if (step.maxLength) input = input.substring(0, step.maxLength);
        if (step.template) {
          input = step.template.replace(/\{\{(\w+)\}\}/g, function(_, k) { return context[k] || ''; });
        }
        result.success = true;
        result.output = input;
        if (step.saveAs) context[step.saveAs] = result.output;
      } catch (e) { result.error = e.message; }
      break;

    case 'condition':
      // 条件分支
      try {
        var condValue = context[step.checkVar] || '';
        var condMet = false;
        if (step.operator === 'contains') condMet = condValue.indexOf(step.value) >= 0;
        else if (step.operator === 'equals') condMet = condValue === step.value;
        else if (step.operator === 'regex') condMet = new RegExp(step.value, 'i').test(condValue);
        else if (step.operator === 'length_gt') condMet = condValue.length > (step.value || 0);
        else if (step.operator === 'length_lt') condMet = condValue.length < (step.value || 0);
        result.success = true;
        result.conditionMet = condMet;
        result.output = condMet ? 'true' : 'false';
      } catch (e) { result.error = e.message; }
      break;

    case 'send_message':
      // 发送消息到会话
      try {
        var msg = (step.message || '').replace(/\{\{(\w+)\}\}/g, function(_, k) { return context[k] || ''; });
        var currentId = Core.session.getCurrentId();
        if (currentId && Core.session.addMessage) {
          Core.session.addMessage(msg, step.role || 'assistant');
          if (Core.session.renderMessages) Core.session.renderMessages(currentId);
        }
        result.success = true;
        result.output = msg;
      } catch (e) { result.error = e.message; }
      break;

    case 'tool_call':
      // 调用工具
      try {
        if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
          var toolResult = await Core.toolsRegistry.executeTool(step.toolName, step.args || {});
          result.success = true;
          result.output = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          if (step.saveAs) context[step.saveAs] = result.output;
        }
      } catch (e) { result.error = e.message; }
      break;

    case 'delay':
      // 延迟
      await new Promise(function(r) { setTimeout(r, step.ms || 1000); });
      result.success = true;
      break;

    default:
      result.error = '未知步骤类型: ' + step.type;
  }

  return result;
}

// 执行完整工作流
async function runWorkflow(workflowId, inputText) {
  var wf = workflows[workflowId];
  if (!wf) return { success: false, error: '工作流不存在' };
  if (!wf.enabled) return { success: false, error: '工作流已禁用' };

  var context = Object.assign({}, wf.variables);
  if (inputText) context.input = inputText;

  console.log('🔄 执行工作流:', wf.name, '步骤数:', wf.steps.length);
  var results = [];

  for (var i = 0; i < wf.steps.length; i++) {
    var step = wf.steps[i];
    console.log('  步骤 ' + (i + 1) + '/' + wf.steps.length + ':', step.type, step.name || '');

    var stepResult = await executeStep(step, context);
    results.push({ step: i + 1, type: step.type, name: step.name || '', result: stepResult });

    if (!stepResult.success && step.required !== false) {
      console.log('  ❌ 步骤失败:', stepResult.error);
      return { success: false, error: '步骤 ' + (i + 1) + ' 失败: ' + stepResult.error, results: results, context: context };
    }

    // 条件分支处理
    if (step.type === 'condition') {
      if (stepResult.conditionMet && step.thenGoto !== undefined) {
        i = step.thenGoto - 1; // 跳转到指定步骤（-1 因为循环会 +1）
      } else if (!stepResult.conditionMet && step.elseGoto !== undefined) {
        i = step.elseGoto - 1;
      }
    }
  }

  console.log('✅ 工作流完成:', wf.name);
  return { success: true, results: results, context: context };
}

// ===== 内置工作流模板 =====
var BUILTIN_WORKFLOWS = [
  {
    name: '翻译 + 润色',
    description: '将输入翻译为英文并润色',
    steps: [
      { type: 'ai_call', name: '翻译', prompt: '将以下内容翻译为英文：\n\n{{input}}', saveAs: 'translated', temperature: 0.3 },
      { type: 'ai_call', name: '润色', prompt: '请润色以下英文文本，使其更加流畅自然：\n\n{{translated}}', saveAs: 'polished', temperature: 0.5 },
      { type: 'send_message', name: '输出', message: '**原文：** {{input}}\n\n**翻译：** {{translated}}\n\n**润色后：** {{polished}}' }
    ]
  },
  {
    name: '摘要 + 要点提取',
    description: '生成文本摘要并提取关键要点',
    steps: [
      { type: 'ai_call', name: '摘要', prompt: '请为以下内容生成简明摘要：\n\n{{input}}', saveAs: 'summary', temperature: 0.3 },
      { type: 'ai_call', name: '要点', prompt: '请从以下内容中提取5-8个关键要点，每点一行：\n\n{{input}}', saveAs: 'points', temperature: 0.3 },
      { type: 'send_message', name: '输出', message: '📋 **摘要**\n\n{{summary}}\n\n🔑 **关键要点**\n\n{{points}}' }
    ]
  },
  {
    name: '代码审查',
    description: '审查代码并给出改进建议',
    steps: [
      { type: 'ai_call', name: '审查', prompt: '请审查以下代码，指出问题并给出改进建议：\n\n{{input}}', saveAs: 'review', temperature: 0.3 },
      { type: 'ai_call', name: '重构', prompt: '请重构以下代码，使其更加简洁高效：\n\n{{input}}', saveAs: 'refactored', temperature: 0.3 },
      { type: 'send_message', name: '输出', message: '🔍 **代码审查**\n\n{{review}}\n\n♻️ **重构建议**\n\n{{refactored}}' }
    ]
  },
  {
    name: '会议纪要生成',
    description: '从会议讨论生成结构化纪要',
    steps: [
      { type: 'ai_call', name: '提取议题', prompt: '从以下会议讨论中提取主要议题（3-5个），每个议题一行：\n\n{{input}}', saveAs: 'topics', temperature: 0.3 },
      { type: 'ai_call', name: '提取决议', prompt: '从以下会议讨论中提取关键决议和行动项，格式为：\n- [负责人] 行动内容 (截止日期)\n\n{{input}}', saveAs: 'actions', temperature: 0.3 },
      { type: 'send_message', name: '输出', message: '📝 **会议纪要**\n\n**主要议题：**\n{{topics}}\n\n**决议与行动项：**\n{{actions}}' }
    ]
  }
];

// 安装内置模板
function installBuiltinWorkflow(index) {
  if (index < 0 || index >= BUILTIN_WORKFLOWS.length) return { success: false, error: '模板索引越界' };
  var tpl = BUILTIN_WORKFLOWS[index];
  return createWorkflow(tpl);
}

// 列出工作流
function listWorkflows() {
  var result = [];
  for (var id in workflows) {
    var wf = workflows[id];
    result.push({ id: id, name: wf.name, description: wf.description, enabled: wf.enabled, steps: wf.steps.length });
  }
  return result;
}

// 删除工作流
function deleteWorkflow(id) {
  if (!workflows[id]) return { success: false, error: '工作流不存在' };
  delete workflows[id];
  var filePath = path.join(getWorkflowsDir(), id + '.json');
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  return { success: true };
}

// ===== 增强的条件匹配（AND/OR 组合条件）=====
function matchRulesEnhanced(message) {
  var matches = [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule.enabled) continue;

    var trigger = rule.trigger;

    // 支持复合条件 (conditions: [{type, pattern}, ...], logic: 'and'|'or')
    if (trigger.conditions && trigger.conditions.length > 0) {
      var logic = trigger.logic || 'and';
      var condResults = trigger.conditions.map(function(cond) {
        return _matchSingleCondition(message, cond);
      });
      var matched = logic === 'and'
        ? condResults.every(function(r) { return r; })
        : condResults.some(function(r) { return r; });
      if (matched) matches.push(rule);
      continue;
    }

    // 时间条件
    if (trigger.type === 'time_range') {
      var now = new Date();
      var hour = now.getHours();
      var startHour = trigger.startHour || 0;
      var endHour = trigger.endHour || 24;
      if (startHour <= endHour) {
        if (hour >= startHour && hour < endHour) matches.push(rule);
      } else {
        // 跨天：如 22:00 - 6:00
        if (hour >= startHour || hour < endHour) matches.push(rule);
      }
      continue;
    }

    // 原有匹配逻辑
    var pattern = trigger.pattern || '';
    var text = trigger.caseSensitive ? message : message.toLowerCase();
    var pat = trigger.caseSensitive ? pattern : pattern.toLowerCase();
    var matched = false;

    if (trigger.type === 'keyword') {
      var keywords = pat.split(',').map(function(k) { return k.trim(); }).filter(Boolean);
      matched = keywords.some(function(kw) { return text.indexOf(kw) >= 0; });
    } else if (trigger.type === 'regex') {
      try { matched = new RegExp(pattern, trigger.caseSensitive ? '' : 'i').test(message); } catch (e) {}
    } else if (trigger.type === 'prefix') {
      matched = text.indexOf(pat) === 0;
    }

    if (matched) matches.push(rule);
  }
  return matches;
}

function _matchSingleCondition(message, cond) {
  var text = cond.caseSensitive ? message : message.toLowerCase();
  var pat = cond.caseSensitive ? (cond.pattern || '') : (cond.pattern || '').toLowerCase();
  switch (cond.type) {
    case 'keyword': return text.indexOf(pat) >= 0;
    case 'regex': try { return new RegExp(cond.pattern, cond.caseSensitive ? '' : 'i').test(message); } catch (e) { return false; }
    case 'prefix': return text.indexOf(pat) === 0;
    case 'suffix': return text.endsWith(pat);
    case 'length_min': return message.length >= (cond.value || 0);
    case 'length_max': return message.length <= (cond.value || 0);
    case 'contains_all':
      return (cond.patterns || []).every(function(p) { return text.indexOf(p.toLowerCase()) >= 0; });
    case 'contains_any':
      return (cond.patterns || []).some(function(p) { return text.indexOf(p.toLowerCase()) >= 0; });
    default: return false;
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    console.warn('workflow.js: fs/path not available');
    return;
  }

  // 加载数据
  loadTemplates();
  loadRules();
  loadWorkflows();

  // 注册命令
  registerCommands();

  // 注册 /workflow 命令组
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('workflow', {
      description: '工作流管理: /workflow list|run|install|delete',
      action: function(args) {
        var parts = (args || '').trim().split(/\s+/);
        var sub = parts[0];
        if (sub === 'list' || sub === '') {
          var wfs = listWorkflows();
          var builtins = BUILTIN_WORKFLOWS;
          var msg = '🔄 **工作流管理**\n\n';
          if (wfs.length > 0) {
            msg += '📋 已安装 (' + wfs.length + '):\n';
            wfs.forEach(function(w) {
              msg += (w.enabled ? '▶' : '⏸') + ' **' + w.name + '** — ' + (w.description || '') + ' (' + w.steps + '步)\n';
            });
          }
          msg += '\n📦 内置模板 (' + builtins.length + '):\n';
          builtins.forEach(function(b, i) {
            msg += (i + 1) + '. **' + b.name + '** — ' + b.description + '\n';
          });
          msg += '\n💡 /workflow install <序号> 安装模板\n💡 /workflow run <工作流ID> [输入] 执行';
          showSystemMessage(msg);
        } else if (sub === 'install') {
          var idx = parseInt(parts[1]) - 1;
          if (isNaN(idx)) { showSystemMessage('⚠️ 用法: /workflow install <序号>'); return; }
          var result = installBuiltinWorkflow(idx);
          if (result.id) {
            showSystemMessage('✅ 已安装工作流: **' + result.name + '**\nID: ' + result.id + '\n\n使用 /workflow run ' + result.id + ' <输入> 执行');
          } else {
            showSystemMessage('❌ 安装失败: ' + (result.error || '未知错误'));
          }
        } else if (sub === 'run') {
          var wfId = parts[1];
          var input = parts.slice(2).join(' ');
          if (!wfId) { showSystemMessage('⚠️ 用法: /workflow run <工作流ID> [输入文本]'); return; }
          showSystemMessage('⏳ 正在执行工作流...');
          runWorkflow(wfId, input).then(function(r) {
            if (r.success) {
              showSystemMessage('✅ 工作流执行完成\n\n最后步骤输出:\n' + (r.results[r.results.length - 1].result.output || '(无输出)').substring(0, 500));
            } else {
              showSystemMessage('❌ 工作流执行失败: ' + r.error);
            }
          }).catch(function(e) { showSystemMessage('❌ 执行异常: ' + e.message); });
        } else if (sub === 'delete') {
          var delId = parts[1];
          if (!delId) { showSystemMessage('⚠️ 用法: /workflow delete <工作流ID>'); return; }
          var delResult = deleteWorkflow(delId);
          showSystemMessage(delResult.success ? '✅ 工作流已删除' : '❌ ' + delResult.error);
        } else {
          showSystemMessage('⚠️ 未知子命令: ' + sub + '\n\n可用: list, run, install, delete');
        }
      }
    });
  }

  // 注册 beforeSend hook（自动回复规则）
  if (Core.plugins && Core.plugins.registerHook) {
    Core.plugins.registerHook('_workflow', 'beforeSend', handleBeforeSend);
    console.log('✅ workflow.js: beforeSend hook 已注册');
  }

  // 暴露 API
  Core.workflow = {
    // 模板
    templates: {
      list: listTemplates,
      save: saveTemplate,
      saveCurrent: saveCurrentAsTemplate,
      use: useTemplate,
      delete: deleteTemplate
    },
    // 规则
    rules: {
      list: listRules,
      add: addRule,
      update: updateRule,
      delete: deleteRule,
      match: matchRules,
      matchEnhanced: matchRulesEnhanced
    },
    // 批量
    batch: {
      send: batchSend,
      summarize: batchSummarize
    },
    // 摘要
    summary: generateSummary,
    // Phase 3-3：工作流引擎
    engine: {
      create: createWorkflow,
      run: runWorkflow,
      list: listWorkflows,
      delete: deleteWorkflow,
      installBuiltin: installBuiltinWorkflow,
      builtinTemplates: BUILTIN_WORKFLOWS
    }
  };

  console.log('✅ workflow.js 已加载 (模板:' + Object.keys(templates).length + ', 规则:' + rules.length + ', 工作流:' + Object.keys(workflows).length + ')');
}

exports.init = init;
