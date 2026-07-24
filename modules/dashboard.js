// modules/dashboard.js - 系统总览仪表盘（Phase 6-1）
// 统一面板整合：分析统计 + 连接健康 + 插件状态 + 同步备份 + 系统资源
let Core = null;

function init(_Core) {
  Core = _Core;

  Core.dashboard = {
    getOverview,
    renderDashboard,
    getSystemHealth,
  };

  // 命令注册（已声明 custom 依赖）
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/dashboard', function(args) {
      return renderDashboard(args);
    }, '系统总览仪表盘 — 一屏查看所有系统状态');

    Core.custom.registerCommand('/sys', function(args) {
      return renderDashboard(args);
    }, '系统总览（/dashboard 别名）');
  }

  console.log('✅ 系统总览仪表盘已加载');
}

// ===== 获取综合概览 =====
function getOverview() {
  var overview = {
    timestamp: new Date().toLocaleString('zh-CN'),
    analytics: null,
    health: null,
    plugins: null,
    sync: null,
    performance: null,
    sessions: null,
  };

  // 分析数据
  if (Core.analytics && Core.analytics.getOverview) {
    try { overview.analytics = Core.analytics.getOverview(7); } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
  }

  // 连接健康
  if (Core.recovery && Core.recovery.getHealthStatus) {
    try { overview.health = Core.recovery.getHealthStatus(); } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
  }

  // 插件状态
  if (Core.plugins) {
    try {
      var pluginList = Core.plugins.listPlugins ? Core.plugins.listPlugins() : [];
      overview.plugins = {
        count: pluginList.length,
        list: pluginList.slice(0, 10),
      };
    } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
  }

  // 同步状态
  if (Core.exportSync && Core.exportSync.getSyncStatus) {
    try { overview.sync = Core.exportSync.getSyncStatus(); } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
  }

  // 性能统计
  if (Core.performance && Core.performance.getStats) {
    try { overview.performance = Core.performance.getStats(); } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
  }

  // 会话统计
  if (Core.session && Core.session.sessions) {
    try {
      var sessions = Core.session.sessions;
      var ids = Object.keys(sessions);
      var totalMessages = 0;
      ids.forEach(function(id) {
        totalMessages += (sessions[id].messages || []).length;
      });
      overview.sessions = {
        count: ids.length,
        totalMessages: totalMessages,
        currentId: Core.session.getCurrentId ? Core.session.getCurrentId() : null,
      };
    } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
  }

  return overview;
}

// ===== 系统健康评分 =====
function getSystemHealth() {
  var score = 100;
  var issues = [];

  // 检查 Ollama
  if (Core.recovery) {
    var health = Core.recovery.getHealthStatus();
    if (health && health.ollama && !health.ollama.online) {
      score -= 30;
      issues.push('Ollama 离线');
    }
  }

  // 检查断路器
  if (Core.recovery && Core.recovery.getCircuitState) {
    var circuits = Core.recovery.getCircuitState();
    Object.keys(circuits).forEach(function(k) {
      if (circuits[k].state === 'open') {
        score -= 15;
        issues.push(k + ' 断路器 OPEN');
      }
    });
  }

  // 检查消息量
  if (Core.session && Core.session.sessions) {
    var ids = Object.keys(Core.session.sessions);
    ids.forEach(function(id) {
      var msgCount = (Core.session.sessions[id].messages || []).length;
      if (msgCount > 400) {
        score -= 5;
        issues.push('会话 ' + (Core.session.sessions[id].title || id).substring(0, 15) + ' 消息较多 (' + msgCount + ')');
      }
    });
  }

  return { score: Math.max(0, score), issues: issues };
}

// ===== 渲染仪表盘 =====
function renderDashboard(args) {
  var sub = (args || '').trim();
  var overview = getOverview();
  var health = getSystemHealth();

  var lines = [];
  lines.push('╔══════════════════════════════════════════╗');
  lines.push('║        📊 AI 智能体 系统总览仪表盘         ║');
  lines.push('╚══════════════════════════════════════════╝');
  lines.push('⏰ ' + overview.timestamp);
  lines.push('');

  // 健康评分
  var healthIcon = health.score >= 80 ? '🟢' : health.score >= 50 ? '🟡' : '🔴';
  lines.push(healthIcon + ' 系统健康: ' + health.score + '/100');
  if (health.issues.length > 0) {
    health.issues.forEach(function(issue) {
      lines.push('   ⚠️ ' + issue);
    });
  }
  lines.push('');

  // 会话统计
  lines.push('📁 会话与消息');
  lines.push('   会话数: ' + (overview.sessions ? overview.sessions.count : '?'));
  lines.push('   总消息: ' + (overview.sessions ? overview.sessions.totalMessages : '?'));
  if (overview.sessions && overview.sessions.currentId) {
    var currentTitle = '';
    try { currentTitle = Core.session.sessions[overview.sessions.currentId].title || '未命名'; } catch (e) { console.warn('⚠️ [dashboard] 操作失败:', e.message || e); }
    lines.push('   当前: ' + currentTitle.substring(0, 30));
  }
  lines.push('');

  // 分析数据（7天）
  if (overview.analytics) {
    var a = overview.analytics;
    lines.push('📈 7日分析');
    lines.push('   消息: ' + (a.totalMessages || 0) + ' (用户 ' + (a.userMessages || 0) + ' / AI ' + (a.aiMessages || 0) + ')');
    if (a.totalTokens) lines.push('   Token: ' + formatNumber(a.totalTokens));
    if (a.modelDistribution) {
      var models = Object.keys(a.modelDistribution);
      if (models.length > 0) {
        lines.push('   模型: ' + models.slice(0, 3).map(function(m) { return m + ' (' + a.modelDistribution[m] + ')'; }).join(', '));
      }
    }
    if (a.commandUsage) {
      var cmds = Object.keys(a.commandUsage);
      if (cmds.length > 0) {
        lines.push('   命令: ' + cmds.slice(0, 5).map(function(c) { return c + ' (' + a.commandUsage[c] + ')'; }).join(', '));
      }
    }
    if (a.errorCount) lines.push('   错误: ' + a.errorCount);
    lines.push('');
  }

  // 连接状态
  if (overview.health) {
    lines.push('🔌 连接状态');
    if (overview.health.ollama) {
      var ollama = overview.health.ollama;
      var icon = ollama.online ? '🟢' : '🔴';
      var latency = ollama.latency ? ' (' + ollama.latency + 'ms)' : '';
      var modelInfo = ollama.models ? ' | ' + ollama.models + ' 模型' : '';
      lines.push('   ' + icon + ' Ollama' + latency + modelInfo);
    }
    if (overview.health.cloud) {
      Object.keys(overview.health.cloud).forEach(function(p) {
        var s = overview.health.cloud[p];
        var icon = s.online === true ? '🟢' : s.online === false ? '🔴' : '🟡';
        var latency = s.latency ? ' (' + s.latency + 'ms)' : '';
        lines.push('   ' + icon + ' ' + p + latency);
      });
    }
    lines.push('');
  }

  // 插件
  if (overview.plugins) {
    lines.push('🧩 插件: ' + overview.plugins.count + ' 个已安装');
    if (overview.plugins.list && overview.plugins.list.length > 0) {
      overview.plugins.list.slice(0, 5).forEach(function(p) {
        var status = p.enabled !== false ? '✅' : '⬜';
        lines.push('   ' + status + ' ' + (p.name || p.id));
      });
    }
    lines.push('');
  }

  // 同步
  if (overview.sync) {
    lines.push('🔄 同步与备份');
    lines.push('   WebDAV: ' + (overview.sync.enabled ? '✅ 已启用' : '❌ 未配置'));
    lines.push('   上次同步: ' + overview.sync.lastSync);
    lines.push('');
  }

  // 性能
  if (overview.performance) {
    var p = overview.performance;
    lines.push('⚡ 性能');
    if (p.memoryUsage) lines.push('   内存: ' + formatBytes(p.memoryUsage));
    if (p.domNodes) lines.push('   DOM: ' + p.domNodes + ' 节点');
    if (p.gcTriggered) lines.push('   GC: ' + p.gcTriggered + ' 次');
    lines.push('');
  }

  // 断路器
  if (Core.recovery && Core.recovery.getCircuitState) {
    var circuits = Core.recovery.getCircuitState();
    var cKeys = Object.keys(circuits);
    if (cKeys.length > 0) {
      lines.push('⚡ 断路器');
      cKeys.forEach(function(k) {
        var c = circuits[k];
        var icon = c.state === 'closed' ? '✅' : c.state === 'open' ? '🚫' : '🔄';
        lines.push('   ' + icon + ' ' + k + ': ' + c.state);
      });
      lines.push('');
    }
  }

  // 快捷命令提示
  lines.push('─'.repeat(42));
  lines.push('💡 快捷命令:');
  lines.push('   /health — 详细连接检查');
  lines.push('   /analytics — 详细分析');
  lines.push('   /backup list — 备份版本');
  lines.push('   /plugin perms — 权限列表');
  lines.push('   /lang — 切换语言');
  lines.push('   /a11y — 无障碍设置');

  return lines.join('\n');
}

// ===== 工具函数 =====
function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

module.exports = { name: 'dashboard', dependencies: ['custom'], init };
