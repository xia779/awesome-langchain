// modules/context-panel.js - 智能上下文面板
// 根据当前会话动态展示上下文信息：会话元数据、知识关联、记忆、Agent 状态、相关会话等

let Core = null;
var _htmlUtils = require('./html-utils');

// ===== 面板状态 =====
var panelState = {
  visible: false,
  collapsedSections: {},  // { sectionId: true/false }
  lastSessionId: null,
  refreshTimer: null,
  data: {}  // 缓存的上下文数据
};

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;

  // 注册命令
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/context', handleContextCommand, '上下文面板：/context [toggle|show|hide|refresh]');
    Core.custom.registerCommand('/ctx', handleContextCommand, '上下文面板（同 /context）');
  }

  // 挂载到 Core
  Core.contextPanel = {
    toggle: toggle,
    show: show,
    hide: hide,
    refresh: refresh,
    isVisible: function() { return panelState.visible; },
    getData: function() { return panelState.data; },
    render: renderPanel,
    collectContext: collectAllContext,
  };

  // 监听会话切换事件
  if (Core.on) {
    Core.on('sessionSwitched', onSessionChanged);
    Core.on('messageSent', onMessageChange);
  }

}

// ===== 面板显隐 =====
function toggle() {
  if (panelState.visible) { hide(); } else { show(); }
}

function show() {
  panelState.visible = true;
  refresh();
  renderPanel();
  // 启动自动刷新（30秒）
  if (!panelState.refreshTimer) {
    panelState.refreshTimer = setInterval(function() {
      if (panelState.visible) refresh();
    }, 30000);
  }
}

function hide() {
  panelState.visible = false;
  // 移除面板 DOM
  var existing = document.getElementById('contextPanel');
  if (existing) existing.style.display = 'none';
  // 停止自动刷新
  if (panelState.refreshTimer) {
    clearInterval(panelState.refreshTimer);
    panelState.refreshTimer = null;
  }
}

// ===== 事件响应 =====
function onSessionChanged(sessionId) {
  panelState.lastSessionId = sessionId;
  if (panelState.visible) {
    refresh();
    renderPanel();
  }
}

function onMessageChange() {
  if (panelState.visible) {
    // 延迟刷新，等消息保存完成
    setTimeout(function() { refresh(); renderPanel(); }, 500);
  }
}

// ===== 上下文数据收集 =====
function collectAllContext() {
  var ctx = {};
  var currentId = Core.session ? Core.session.getCurrentId() : null;
  ctx.sessionId = currentId;

  // 1. 会话基本信息
  ctx.session = collectSessionInfo(currentId);

  // 2. 标签信息
  ctx.tags = collectTagInfo(currentId);

  // 3. 知识库相关
  ctx.knowledge = collectKnowledgeContext(currentId);

  // 4. 记忆上下文
  ctx.memories = collectMemoryContext(currentId);

  // 5. Agent 状态
  ctx.agent = collectAgentContext();

  // 6. 相关会话
  ctx.related = collectRelatedSessions(currentId);

  // 7. 工具状态
  ctx.tools = collectToolsInfo();

  // 8. 工作流信息
  ctx.workflow = collectWorkflowInfo(currentId);

  // 9. 性能指标
  ctx.performance = collectPerformanceInfo();

  panelState.data = ctx;
  return ctx;
}

function collectSessionInfo(sessionId) {
  if (!sessionId || !Core.session) return null;

  var info = {
    id: sessionId,
    title: Core.session.getTitle ? Core.session.getTitle(sessionId) : '未知',
    roleType: 'chat',
    messageCount: 0,
    createdAt: null,
    pinned: false,
  };

  // 获取消息数
  if (Core.session.getMessages) {
    var msgs = Core.session.getMessages(sessionId);
    info.messageCount = msgs ? msgs.length : 0;
  }

  // 获取会话配置
  if (Core.session.getConfig) {
    var config = Core.session.getConfig(sessionId);
    if (config) {
      info.roleType = config.roleType || 'chat';
      info.temperature = config.temperature || 0.7;
      info.pinned = config.pinned || false;
    }
  }

  return info;
}

function collectTagInfo(sessionId) {
  if (!Core.sessionTags) return { tags: [], suggestions: [] };
  return {
    tags: Core.sessionTags.get(sessionId) || [],
    allTags: Core.sessionTags.getAll ? Core.sessionTags.getAll() : [],
    suggestions: Core.sessionTags.suggest ? Core.sessionTags.suggest(sessionId) : []
  };
}

function collectKnowledgeContext(sessionId) {
  if (!Core.knowledge) return null;

  var result = { enabled: true, docs: [], searchAvailable: true };

  // 获取知识库状态
  if (Core.knowledge.getStats) {
    try { result.stats = Core.knowledge.getStats(); } catch(e) {}
  }

  // 尝试搜索相关内容
  if (Core.session && Core.session.getMessages && Core.knowledge.search) {
    var msgs = Core.session.getMessages(sessionId);
    if (msgs && msgs.length > 0) {
      // 取最后一条用户消息作为查询
      var lastUserMsg = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && msgs[i].content) {
          lastUserMsg = msgs[i].content.substring(0, 100);
          break;
        }
      }
      if (lastUserMsg) {
        try {
          var results = Core.knowledge.search(lastUserMsg, 3);
          result.docs = results || [];
        } catch(e) { result.searchError = e.message; }
      }
    }
  }

  return result;
}

function collectMemoryContext(sessionId) {
  if (!Core.memory) return null;

  var result = { enabled: true, relevant: [], stats: null };

  if (Core.memory.getStats) {
    try { result.stats = Core.memory.getStats(); } catch(e) {}
  }

  // 获取相关记忆
  if (Core.memory.search && Core.session && Core.session.getMessages) {
    var msgs = Core.session.getMessages(sessionId);
    if (msgs && msgs.length > 0) {
      var lastMsg = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].content) { lastMsg = msgs[i].content.substring(0, 80); break; }
      }
      if (lastMsg) {
        try {
          var memories = Core.memory.search(lastMsg, 5);
          result.relevant = memories || [];
        } catch(e) {}
      }
    }
  }

  return result;
}

function collectAgentContext() {
  if (!Core.agent) return null;
  var result = { enabled: true, isRunning: false };

  if (Core.agent.getStatus) {
    try {
      var status = Core.agent.getStatus();
      result.isRunning = status.isRunning;
      result.currentStep = status.currentStep;
      result.maxSteps = status.maxSteps;
      result.availableTools = status.availableTools || [];
      result.historyCount = status.historyCount || 0;
    } catch(e) {}
  }

  if (Core.agent.getHistory) {
    try { result.recentHistory = Core.agent.getHistory(3); } catch(e) {}
  }

  return result;
}

function collectRelatedSessions(sessionId) {
  if (!sessionId || !Core.session) return [];

  var related = [];

  // 通过标签查找相关会话
  if (Core.sessionTags) {
    var tags = Core.sessionTags.get(sessionId) || [];
    tags.forEach(function(tag) {
      var sessions = Core.sessionTags.filterByTag ? Core.sessionTags.filterByTag(tag) : [];
      sessions.forEach(function(sid) {
        if (sid !== sessionId && !related.find(function(r) { return r.id === sid; })) {
          related.push({
            id: sid,
            title: Core.session.getTitle ? Core.session.getTitle(sid) : sid,
            reason: '标签: ' + tag,
            tags: Core.sessionTags.get(sid) || []
          });
        }
      });
    });
  }

  return related.slice(0, 8);
}

function collectToolsInfo() {
  if (!Core.toolsRegistry) return null;
  var result = { enabled: true, tools: [] };

  if (Core.toolsRegistry.listTools) {
    try { result.tools = Core.toolsRegistry.listTools(); } catch(e) {}
  }

  if (Core.toolsRegistry.getToolDefinitions) {
    try { result.definitions = Core.toolsRegistry.getToolDefinitions(); } catch(e) {}
  }

  return result;
}

function collectWorkflowInfo(sessionId) {
  if (!Core.workflow) return null;
  var result = { enabled: true, active: null, templates: [] };

  if (Core.workflow.getActiveWorkflow) {
    try { result.active = Core.workflow.getActiveWorkflow(); } catch(e) {}
  }

  if (Core.workflow.listTemplates) {
    try { result.templates = Core.workflow.listTemplates(); } catch(e) {}
  }

  return result;
}

function collectPerformanceInfo() {
  var result = {};

  // 内存使用
  if (typeof process !== 'undefined' && process.memoryUsage) {
    var mem = process.memoryUsage();
    result.heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
    result.heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
    result.rss = Math.round(mem.rss / 1024 / 1024);
  }

  // 错误恢复状态
  if (Core.recovery && Core.recovery.getCircuit) {
    try {
      result.ollamaCircuit = Core.recovery.getCircuit('ollama');
      result.cloudCircuit = Core.recovery.getCircuit('cloud');
    } catch(e) {}
  }

  return result;
}

// ===== 刷新 =====
function refresh() {
  collectAllContext();
}

// ===== 面板渲染 =====
function renderPanel() {
  if (!panelState.visible) return;

  var ctx = panelState.data;
  var container = document.getElementById('contextPanel');

  if (!container) {
    container = document.createElement('div');
    container.id = 'contextPanel';
    container.style.cssText = 'position:fixed;right:0;top:50px;bottom:50px;width:280px;background:var(--bg-secondary,#1e1e2e);' +
      'border-left:1px solid var(--border-color,#333);overflow-y:auto;z-index:100;padding:12px;font-size:13px;' +
      'transition:transform 0.3s ease;box-shadow:-2px 0 8px rgba(0,0,0,0.2);';
    document.body.appendChild(container);
  }

  container.style.display = 'block';

  var html = '';

  // 面板标题
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
  html += '<span style="font-weight:600;font-size:14px;">📋 上下文面板</span>';
  html += '<span style="cursor:pointer;opacity:0.6;font-size:16px;" onclick="Core.contextPanel.hide()" title="关闭面板">✕</span>';
  html += '</div>';

  // 1. 会话信息卡片
  html += renderSection('session', '💬 会话信息', renderSessionCard(ctx.session));

  // 2. 标签
  html += renderSection('tags', '🏷️ 标签', renderTagsSection(ctx.tags));

  // 3. 知识库
  if (ctx.knowledge && ctx.knowledge.enabled) {
    html += renderSection('knowledge', '📚 知识库', renderKnowledgeSection(ctx.knowledge));
  }

  // 4. 记忆
  if (ctx.memories && ctx.memories.enabled) {
    html += renderSection('memories', '🧠 相关记忆', renderMemorySection(ctx.memories));
  }

  // 5. Agent 状态
  if (ctx.agent && ctx.agent.enabled) {
    html += renderSection('agent', '🤖 Agent', renderAgentSection(ctx.agent));
  }

  // 6. 相关会话
  if (ctx.related && ctx.related.length > 0) {
    html += renderSection('related', '🔗 相关会话', renderRelatedSection(ctx.related));
  }

  // 7. 工具
  if (ctx.tools && ctx.tools.enabled) {
    html += renderSection('tools', '🔧 工具', renderToolsSection(ctx.tools));
  }

  // 8. 工作流
  if (ctx.workflow && ctx.workflow.enabled) {
    html += renderSection('workflow', '⚡ 工作流', renderWorkflowSection(ctx.workflow));
  }

  // 9. 性能
  html += renderSection('perf', '📊 性能', renderPerformanceSection(ctx.performance));

  // 刷新按钮
  html += '<div style="margin-top:12px;text-align:center;">';
  html += '<button onclick="Core.contextPanel.refresh();Core.contextPanel.render();" ' +
    'style="padding:4px 16px;border:1px solid var(--border-color,#444);border-radius:4px;' +
    'background:var(--bg-tertiary,#2a2a3a);color:var(--text-primary,#eee);cursor:pointer;font-size:12px;">🔄 刷新</button>';
  html += '</div>';

  // 🔧 原子 DOM 替换：避免 innerHTML 两阶段闪烁
  var _tmp = document.createElement('div');
  _tmp.innerHTML = html;
  container.replaceChildren(..._tmp.childNodes);
}

// ===== 渲染辅助 =====
function renderSection(id, title, content) {
  var collapsed = panelState.collapsedSections[id] === true;
  var arrow = collapsed ? '▶' : '▼';

  var html = '<div class="ctx-section" style="margin-bottom:8px;border:1px solid var(--border-color,#333);border-radius:6px;overflow:hidden;">';
  html += '<div class="ctx-section-header" onclick="Core.contextPanel.toggleSection(\'' + id + '\')" ' +
    'style="padding:6px 10px;cursor:pointer;background:var(--bg-tertiary,#2a2a3a);display:flex;align-items:center;gap:6px;user-select:none;">';
  html += '<span style="font-size:10px;">' + arrow + '</span>';
  html += '<span style="font-size:12px;font-weight:500;">' + title + '</span>';
  html += '</div>';

  if (!collapsed) {
    html += '<div class="ctx-section-body" style="padding:8px 10px;">';
    html += content;
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderSessionCard(session) {
  if (!session) return '<div style="opacity:0.5;">无活动会话</div>';

  var ROLE_LABELS = { chat: '对话', master: '主控', coder: '编程', writer: '写作', analyst: '分析', teacher: '教学' };
  var roleLabel = ROLE_LABELS[session.roleType] || session.roleType;

  var html = '';
  html += '<div style="font-weight:500;margin-bottom:4px;word-break:break-all;">' + escapeHtml(session.title || '新对话') + '</div>';
  html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px;opacity:0.8;">';
  html += '<span>ID:</span><span style="font-family:monospace;font-size:10px;">' + session.id.substring(0, 12) + '...</span>';
  html += '<span>角色:</span><span>' + roleLabel + '</span>';
  html += '<span>消息:</span><span>' + session.messageCount + ' 条</span>';
  if (session.temperature !== undefined) {
    html += '<span>温度:</span><span>' + session.temperature + '</span>';
  }
  if (session.pinned) {
    html += '<span>状态:</span><span>📌 已置顶</span>';
  }
  html += '</div>';
  return html;
}

function renderTagsSection(tags) {
  if (!tags) return '';

  var html = '';
  if (tags.tags && tags.tags.length > 0) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
    tags.tags.forEach(function(tag) {
      if (Core.sessionTags && Core.sessionTags.renderBadge) {
        html += Core.sessionTags.renderBadge(tag);
      } else {
        html += '<span style="padding:1px 6px;border-radius:8px;font-size:10px;background:#3b82f622;color:#3b82f6;">' + tag + '</span>';
      }
    });
    html += '</div>';
  } else {
    html += '<div style="opacity:0.5;font-size:11px;">暂无标签</div>';
  }

  if (tags.suggestions && tags.suggestions.length > 0) {
    html += '<div style="margin-top:6px;font-size:11px;">';
    html += '<div style="opacity:0.6;margin-bottom:2px;">💡 建议:</div>';
    tags.suggestions.forEach(function(s) {
      html += '<span style="cursor:pointer;padding:1px 6px;border-radius:8px;font-size:10px;' +
        'background:' + s.color + '22;color:' + s.color + ';border:1px dashed ' + s.color + '44;margin:0 2px;" ' +
        'onclick="Core.sessionTags.add(Core.session.getCurrentId(),\'' + s.tag + '\');Core.contextPanel.refresh();Core.contextPanel.render();" ' +
        'title="点击添加">' + s.tag + '</span>';
    });
    html += '</div>';
  }

  return html;
}

function renderKnowledgeSection(kb) {
  var html = '';
  if (kb.stats) {
    html += '<div style="font-size:11px;opacity:0.7;margin-bottom:4px;">文档数: ' + (kb.stats.totalDocs || 0) + '</div>';
  }

  if (kb.docs && kb.docs.length > 0) {
    html += '<div style="font-size:11px;margin-bottom:4px;">📄 相关内容:</div>';
    kb.docs.slice(0, 3).forEach(function(doc) {
      var title = doc.title || doc.source || '未知文档';
      var score = doc.score ? (doc.score * 100).toFixed(0) + '%' : '';
      html += '<div style="padding:3px 0;border-bottom:1px solid var(--border-color,#333);font-size:11px;">';
      html += '<div style="font-weight:500;">' + escapeHtml(title.substring(0, 30)) + '</div>';
      if (score) html += '<div style="opacity:0.6;font-size:10px;">相关度: ' + score + '</div>';
      html += '</div>';
    });
  } else {
    html += '<div style="opacity:0.5;font-size:11px;">无相关知识库内容</div>';
  }
  return html;
}

function renderMemorySection(mem) {
  var html = '';
  if (mem.stats) {
    html += '<div style="font-size:11px;opacity:0.7;margin-bottom:4px;">记忆总数: ' + (mem.stats.total || 0) + '</div>';
  }

  if (mem.relevant && mem.relevant.length > 0) {
    mem.relevant.slice(0, 5).forEach(function(m) {
      var content = m.content || m.text || '';
      html += '<div style="padding:3px 0;border-bottom:1px solid var(--border-color,#333);font-size:11px;">';
      html += escapeHtml(content.substring(0, 60));
      if (content.length > 60) html += '...';
      html += '</div>';
    });
  } else {
    html += '<div style="opacity:0.5;font-size:11px;">无相关记忆</div>';
  }
  return html;
}

function renderAgentSection(agent) {
  var html = '';
  if (agent.isRunning) {
    html += '<div style="color:#f59e0b;font-weight:500;margin-bottom:4px;">⏳ 运行中...</div>';
    html += '<div style="font-size:11px;">步骤: ' + agent.currentStep + '/' + agent.maxSteps + '</div>';
  } else {
    html += '<div style="color:#10b981;font-size:11px;">✅ 空闲</div>';
  }

  if (agent.availableTools && agent.availableTools.length > 0) {
    html += '<div style="margin-top:4px;font-size:11px;opacity:0.7;">可用工具: ' + agent.availableTools.length + ' 个</div>';
  }

  if (agent.recentHistory && agent.recentHistory.length > 0) {
    html += '<div style="margin-top:6px;font-size:11px;">';
    html += '<div style="opacity:0.6;margin-bottom:2px;">最近任务:</div>';
    agent.recentHistory.forEach(function(h) {
      var status = h.success ? '✅' : '❌';
      html += '<div style="padding:2px 0;border-bottom:1px solid var(--border-color,#333);">' +
        status + ' ' + escapeHtml(h.task) + ' (' + h.steps + '步)</div>';
    });
    html += '</div>';
  }

  return html;
}

function renderRelatedSection(related) {
  var html = '';
  related.forEach(function(r) {
    html += '<div style="padding:3px 0;border-bottom:1px solid var(--border-color,#333);cursor:pointer;font-size:11px;" ' +
      'onclick="Core.session.switchTo(\'' + r.id + '\')" title="点击切换">';
    html += '<div style="font-weight:500;">' + escapeHtml((r.title || r.id).substring(0, 25)) + '</div>';
    html += '<div style="opacity:0.6;font-size:10px;">' + r.reason + '</div>';
    html += '</div>';
  });
  return html;
}

function renderToolsSection(tools) {
  var html = '';
  if (tools.tools && tools.tools.length > 0) {
    html += '<div style="font-size:11px;">已注册工具: ' + tools.tools.length + ' 个</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;">';
    tools.tools.slice(0, 12).forEach(function(t) {
      var name = typeof t === 'string' ? t : (t.name || t.function?.name || '?');
      html += '<span style="padding:1px 5px;border-radius:4px;font-size:10px;background:#6366f122;color:#6366f1;">' + name + '</span>';
    });
    if (tools.tools.length > 12) {
      html += '<span style="padding:1px 5px;font-size:10px;opacity:0.5;">+' + (tools.tools.length - 12) + '</span>';
    }
    html += '</div>';
  } else {
    html += '<div style="opacity:0.5;font-size:11px;">无可用工具</div>';
  }
  return html;
}

function renderWorkflowSection(wf) {
  var html = '';
  if (wf.active) {
    html += '<div style="font-size:11px;color:#f59e0b;">⚡ 活动: ' + escapeHtml(wf.active.name || '未知') + '</div>';
    if (wf.active.currentStep !== undefined) {
      html += '<div style="font-size:11px;opacity:0.7;">步骤: ' + wf.active.currentStep + '/' + (wf.active.totalSteps || '?') + '</div>';
    }
  } else {
    html += '<div style="opacity:0.5;font-size:11px;">无活动工作流</div>';
  }

  if (wf.templates && wf.templates.length > 0) {
    html += '<div style="margin-top:4px;font-size:11px;opacity:0.7;">模板: ' + wf.templates.length + ' 个</div>';
  }
  return html;
}

function renderPerformanceSection(perf) {
  if (!perf) return '<div style="opacity:0.5;font-size:11px;">无数据</div>';

  var html = '';
  html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:11px;">';

  if (perf.heapUsed !== undefined) {
    html += '<span>内存:</span><span>' + perf.heapUsed + '/' + perf.heapTotal + ' MB</span>';
  }
  if (perf.rss !== undefined) {
    html += '<span>RSS:</span><span>' + perf.rss + ' MB</span>';
  }

  // 熔断器状态
  if (perf.ollamaCircuit) {
    var c = perf.ollamaCircuit;
    var stateColor = c.state === 'closed' ? '#10b981' : (c.state === 'open' ? '#ef4444' : '#f59e0b');
    html += '<span>Ollama:</span><span style="color:' + stateColor + ';">' + c.state + ' (' + c.failures + ' 失败)</span>';
  }
  if (perf.cloudCircuit) {
    var c = perf.cloudCircuit;
    var stateColor = c.state === 'closed' ? '#10b981' : (c.state === 'open' ? '#ef4444' : '#f59e0b');
    html += '<span>Cloud:</span><span style="color:' + stateColor + ';">' + c.state + ' (' + c.failures + ' 失败)</span>';
  }

  html += '</div>';
  return html;
}

// ===== 区段折叠 =====
function toggleSection(id) {
  panelState.collapsedSections[id] = !panelState.collapsedSections[id];
  renderPanel();
}

// 挂载到 contextPanel（init 中已挂载，这里补充）
function extendAPI() {
  if (Core.contextPanel) {
    Core.contextPanel.toggleSection = toggleSection;
  }
}

// ===== HTML 转义 =====
var escapeHtml = _htmlUtils.escapeHtml;

// ===== 命令处理 =====
function handleContextCommand(input) {
  var parts = input.trim().split(/\s+/);
  var sub = (parts[1] || '').toLowerCase();

  switch (sub) {
    case 'toggle':
    case '':
      toggle();
      return panelState.visible ? '📋 上下文面板已打开' : '📋 上下文面板已关闭';
    case 'show':
      show();
      return '📋 上下文面板已打开';
    case 'hide':
      hide();
      return '📋 上下文面板已关闭';
    case 'refresh':
      refresh();
      renderPanel();
      return '📋 上下文数据已刷新';
    case 'data':
    case 'json':
      var data = collectAllContext();
      return '```json\n' + JSON.stringify(data, null, 2).substring(0, 2000) + '\n```';
    case 'export':
      var data = collectAllContext();
      return JSON.stringify(data, null, 2);
    default:
      return '📋 上下文面板命令:\n' +
        '  /context          — 切换面板显隐\n' +
        '  /context show     — 显示面板\n' +
        '  /context hide     — 隐藏面板\n' +
        '  /context refresh  — 刷新数据\n' +
        '  /context data     — 查看原始数据（JSON）';
  }
}

module.exports = { name: 'context-panel', dependencies: ['custom', 'session'], init };
