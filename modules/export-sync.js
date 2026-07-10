// modules/export-sync.js - 高级导出与同步模块
// 多格式导出 (Markdown/HTML/TXT/JSON)、批量导出、WebDAV同步、自动备份版本管理
let Core = null;
let ipcRenderer = null;
var _htmlUtils = require('./html-utils');
try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}

// ===== 配置 =====
const CONFIG = {
  SYNC_INTERVAL_MS: 300000,   // 5分钟自动同步检查
  BACKUP_MAX_VERSIONS: 10,    // 最多保留10个备份版本
  EXPORT_DIR: 'exports',
};

var _syncTimer = null;
var _lastSyncTime = 0;

function init(_Core) {
  Core = _Core;

  Core.exportSync = {
    exportSession,
    exportBatch,
    exportAll,
    syncToWebDAV,
    syncFromWebDAV,
    getSyncStatus,
    autoBackup,
    getBackupVersions,
    restoreVersion,
    CONFIG,
  };

  // 注册命令
  setTimeout(function() {
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/export', function(args) {
        return handleExportCommand(args);
      }, '高级导出 — /export md|html|txt|json|all|batch');
      Core.custom.registerCommand('/sync', function(args) {
        return handleSyncCommand(args);
      }, '数据同步 — /sync push|pull|status|config');
      Core.custom.registerCommand('/backup', function(args) {
        return handleBackupCommand(args);
      }, '备份管理 — /backup create|list|restore|auto');
    }
  }, 100);

  // 启动自动备份（每30分钟检查一次）
  startAutoBackup();

  console.log('✅ 高级导出与同步模块已加载');
}

// ===== 导出功能 =====

// 导出单个会话
function exportSession(sessionId, format) {
  format = format || 'md';
  var sessions = Core.session.sessions;
  var session = sessions[sessionId];
  if (!session) return { error: '会话不存在: ' + sessionId };

  var messages = session.messages || [];
  var title = session.title || '未命名会话';
  var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  var filename = sanitizeFilename(title) + '_' + timestamp;

  var content = '';
  switch (format) {
    case 'md':
      content = toMarkdown(title, messages, session);
      filename += '.md';
      break;
    case 'html':
      content = toHTML(title, messages, session);
      filename += '.html';
      break;
    case 'txt':
      content = toPlainText(title, messages);
      filename += '.txt';
      break;
    case 'json':
      content = JSON.stringify({ title: title, session: session, messages: messages, exportedAt: new Date().toISOString() }, null, 2);
      filename += '.json';
      break;
    default:
      return { error: '不支持的格式: ' + format };
  }

  return { content: content, filename: filename, format: format, messageCount: messages.length };
}

// 批量导出
function exportBatch(sessionIds, format) {
  format = format || 'md';
  var results = [];
  var errors = [];
  for (var i = 0; i < sessionIds.length; i++) {
    var result = exportSession(sessionIds[i], format);
    if (result.error) {
      errors.push({ id: sessionIds[i], error: result.error });
    } else {
      results.push(result);
    }
  }
  return { exports: results, errors: errors, total: sessionIds.length, success: results.length };
}

// 导出所有会话（合并为一个文件）
function exportAll(format) {
  format = format || 'json';
  var sessions = Core.session.sessions;
  var ids = Object.keys(sessions);
  if (format === 'json') {
    var data = {
      appVersion: 'ai-agent-pro',
      exportedAt: new Date().toISOString(),
      sessionCount: ids.length,
      sessions: {}
    };
    ids.forEach(function(id) {
      data.sessions[id] = {
        title: sessions[id].title,
        messages: sessions[id].messages || [],
        roleType: sessions[id].roleType,
        timestamp: sessions[id].timestamp
      };
    });
    return {
      content: JSON.stringify(data, null, 2),
      filename: 'ai-agent-full-backup_' + new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19) + '.json',
      format: 'json',
      sessionCount: ids.length
    };
  }
  // 其他格式：每个会话单独导出
  return exportBatch(ids, format);
}

// ===== 格式转换 =====

function toMarkdown(title, messages, session) {
  var lines = [];
  lines.push('# ' + title);
  lines.push('');
  lines.push('> 导出时间: ' + new Date().toLocaleString('zh-CN'));
  if (session.roleType) lines.push('> 角色: ' + session.roleType);
  lines.push('> 消息数: ' + messages.length);
  lines.push('');
  lines.push('---');
  lines.push('');

  messages.forEach(function(msg) {
    var role = msg.role === 'user' ? '**你**' : '**AI**';
    var time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    lines.push('### ' + role + (time ? ' <sub>' + time + '</sub>' : ''));
    lines.push('');
    lines.push(msg.content || '');
    lines.push('');
  });

  return lines.join('\n');
}

function toHTML(title, messages, session) {
  var html = [];
  html.push('<!DOCTYPE html>');
  html.push('<html lang="zh-CN"><head><meta charset="UTF-8"><title>' + escapeHtml(title) + '</title>');
  html.push('<style>');
  html.push('body{max-width:800px;margin:40px auto;padding:0 20px;font-family:-apple-system,system-ui,sans-serif;color:#1a1a1a;line-height:1.7;background:#fafafa}');
  html.push('h1{border-bottom:2px solid #3b82f6;padding-bottom:8px}');
  html.push('.meta{color:#666;font-size:13px;margin-bottom:24px}');
  html.push('.msg{margin:16px 0;padding:12px 16px;border-radius:12px}');
  html.push('.msg-user{background:#e8f4fd;border-left:4px solid #3b82f6}');
  html.push('.msg-ai{background:#f0f0f0;border-left:4px solid #8b5cf6}');
  html.push('.msg .role{font-weight:600;font-size:13px;color:#555;margin-bottom:4px}');
  html.push('.msg .time{font-size:11px;color:#999;float:right}');
  html.push('.msg .content{font-size:14px}');
  html.push('pre{background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}');
  html.push('code{font-family:Consolas,monospace;font-size:13px}');
  html.push('</style></head><body>');
  html.push('<h1>' + escapeHtml(title) + '</h1>');
  html.push('<div class="meta">导出时间: ' + new Date().toLocaleString('zh-CN') + ' | 消息数: ' + messages.length + '</div>');

  messages.forEach(function(msg) {
    var cls = msg.role === 'user' ? 'msg-user' : 'msg-ai';
    var role = msg.role === 'user' ? '你' : 'AI 助手';
    var time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    html.push('<div class="msg ' + cls + '">');
    html.push('<div class="role">' + role + '<span class="time">' + time + '</span></div>');
    html.push('<div class="content">' + escapeHtml(msg.content || '') + '</div>');
    html.push('</div>');
  });

  html.push('</body></html>');
  return html.join('\n');
}

function toPlainText(title, messages) {
  var lines = [];
  lines.push('=== ' + title + ' ===');
  lines.push('导出时间: ' + new Date().toLocaleString('zh-CN'));
  lines.push('消息数: ' + messages.length);
  lines.push('');

  messages.forEach(function(msg) {
    var role = msg.role === 'user' ? '[你]' : '[AI]';
    lines.push(role + ' ' + (msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''));
    lines.push(msg.content || '');
    lines.push('');
  });

  return lines.join('\n');
}

// ===== WebDAV 同步 =====

function getSyncConfig() {
  try {
    var configPath = require('path').join(Core.DATA_ROOT, 'sync-config.json');
    if (require('fs').existsSync(configPath)) {
      return JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
    }
  } catch (e) {}
  return { enabled: false, url: '', username: '', password: '', path: '/ai-agent-sync/' };
}

function saveSyncConfig(config) {
  try {
    var configPath = require('path').join(Core.DATA_ROOT, 'sync-config.json');
    require('fs').writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) { return false; }
}

async function syncToWebDAV() {
  var config = getSyncConfig();
  if (!config.enabled || !config.url) {
    return { error: '同步未配置，请先使用 /sync config 设置 WebDAV 地址' };
  }

  try {
    // 导出所有数据
    var data = exportAll('json');
    var remotePath = (config.path || '/ai-agent-sync/') + 'backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';

    // PUT 到 WebDAV
    var auth = config.username ? 'Basic ' + btoa(config.username + ':' + config.password) : '';
    var resp = await fetch(config.url + remotePath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: data.content
    });

    if (resp.ok || resp.status === 201 || resp.status === 204) {
      _lastSyncTime = Date.now();
      return { success: true, path: remotePath, size: data.content.length, sessionCount: data.sessionCount };
    } else {
      return { error: 'WebDAV 上传失败: HTTP ' + resp.status };
    }
  } catch (err) {
    return { error: '同步失败: ' + err.message };
  }
}

async function syncFromWebDAV() {
  var config = getSyncConfig();
  if (!config.enabled || !config.url) {
    return { error: '同步未配置' };
  }

  try {
    // PROPFIND 列出文件
    var auth = config.username ? 'Basic ' + btoa(config.username + ':' + config.password) : '';
    var listResp = await fetch(config.url + (config.path || '/ai-agent-sync/'), {
      method: 'PROPFIND',
      headers: {
        'Authorization': auth,
        'Depth': '1',
        'Content-Type': 'application/xml',
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>'
    });

    if (!listResp.ok) {
      return { error: 'WebDAV 列表失败: HTTP ' + listResp.status };
    }

    // 解析 XML 找最新的备份文件
    var xml = await listResp.text();
    var hrefs = [];
    var hrefRegex = /<d:href[^>]*>([^<]+)<\/d:href>/gi;
    var match;
    while ((match = hrefRegex.exec(xml)) !== null) {
      if (match[1].includes('backup_')) hrefs.push(match[1]);
    }

    if (hrefs.length === 0) {
      return { error: '远程没有备份文件' };
    }

    // 取最新的
    hrefs.sort();
    var latestHref = hrefs[hrefs.length - 1];

    // GET 下载
    var getResp = await fetch(config.url + latestHref, {
      headers: { 'Authorization': auth }
    });

    if (!getResp.ok) {
      return { error: '下载失败: HTTP ' + getResp.status };
    }

    var data = await getResp.json();
    _lastSyncTime = Date.now();
    return {
      success: true,
      file: latestHref,
      sessionCount: data.sessionCount || Object.keys(data.sessions || {}).length,
      exportedAt: data.exportedAt,
      data: data
    };
  } catch (err) {
    return { error: '同步拉取失败: ' + err.message };
  }
}

function getSyncStatus() {
  var config = getSyncConfig();
  return {
    enabled: config.enabled,
    url: config.url ? config.url.replace(/\/\/.*@/, '//***@') : '(未配置)',
    lastSync: _lastSyncTime ? new Date(_lastSyncTime).toLocaleString('zh-CN') : '从未同步',
    path: config.path || '/ai-agent-sync/'
  };
}

// ===== 自动备份 =====

function startAutoBackup() {
  if (_syncTimer) clearInterval(_syncTimer);
  _syncTimer = setInterval(function() {
    // 自动本地备份
    autoBackup().catch(function(e) { console.warn('[Sync] Auto-backup failed:', e.message); });
    // 自动 WebDAV 同步
    var config = getSyncConfig();
    if (config.enabled) {
      syncToWebDAV().catch(function(e) { console.warn('[Sync] WebDAV sync failed:', e.message); });
    }
  }, CONFIG.SYNC_INTERVAL_MS);
}

function autoBackup() {
  return new Promise(function(resolve, reject) {
    try {
      var backupDir = require('path').join(Core.DATA_ROOT, 'auto-backups');
      if (!require('fs').existsSync(backupDir)) {
        require('fs').mkdirSync(backupDir, { recursive: true });
      }

      var data = exportAll('json');
      var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      var filePath = require('path').join(backupDir, 'auto_' + timestamp + '.json');
      require('fs').writeFileSync(filePath, data.content, 'utf8');

      // 清理旧版本
      cleanupOldBackups(backupDir);

      resolve({ path: filePath, size: data.content.length });
    } catch (err) {
      reject(err);
    }
  });
}

function cleanupOldBackups(backupDir) {
  try {
    var files = require('fs').readdirSync(backupDir)
      .filter(function(f) { return f.startsWith('auto_') && f.endsWith('.json'); })
      .sort();
    // 保留最新的 N 个
    while (files.length > CONFIG.BACKUP_MAX_VERSIONS) {
      var oldest = files.shift();
      require('fs').unlinkSync(require('path').join(backupDir, oldest));
    }
  } catch (e) {}
}

function getBackupVersions() {
  try {
    var backupDir = require('path').join(Core.DATA_ROOT, 'auto-backups');
    if (!require('fs').existsSync(backupDir)) return [];
    var files = require('fs').readdirSync(backupDir)
      .filter(function(f) { return f.endsWith('.json'); })
      .sort()
      .reverse();
    return files.map(function(f) {
      var stat = require('fs').statSync(require('path').join(backupDir, f));
      return {
        name: f,
        size: stat.size,
        sizeHuman: formatBytes(stat.size),
        modified: new Date(stat.mtime).toLocaleString('zh-CN'),
        path: require('path').join(backupDir, f)
      };
    });
  } catch (e) { return []; }
}

function restoreVersion(filename) {
  try {
    var backupDir = require('path').join(Core.DATA_ROOT, 'auto-backups');
    var filePath = require('path').join(backupDir, filename);
    if (!require('fs').existsSync(filePath)) {
      return { error: '备份文件不存在: ' + filename };
    }
    var data = JSON.parse(require('fs').readFileSync(filePath, 'utf8'));
    if (!data.sessions) {
      return { error: '无效的备份文件格式' };
    }
    // 合并到当前会话（不覆盖已有的）
    var sessions = Core.session.sessions;
    var added = 0;
    Object.keys(data.sessions).forEach(function(id) {
      if (!sessions[id]) {
        sessions[id] = data.sessions[id];
        added++;
      }
    });
    return { success: true, total: Object.keys(data.sessions).length, added: added, skipped: Object.keys(data.sessions).length - added };
  } catch (err) {
    return { error: '恢复失败: ' + err.message };
  }
}

// ===== 命令处理 =====

function handleExportCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = parts[0] || 'help';

  if (sub === 'help' || sub === '') {
    return '📤 高级导出命令\n\n' +
      '/export md — 导出当前会话为 Markdown\n' +
      '/export html — 导出当前会话为 HTML\n' +
      '/export txt — 导出当前会话为纯文本\n' +
      '/export json — 导出当前会话为 JSON\n' +
      '/export all [格式] — 导出所有会话\n' +
      '/export batch [格式] — 批量导出（在侧边栏多选）';
  }

  var currentId = Core.session.getCurrentId();
  if (!currentId) return '❌ 请先选择一个会话';

  if (sub === 'all') {
    var format = parts[1] || 'json';
    var result = exportAll(format);
    if (result.error) return '❌ ' + result.error;
    if (result.content) {
      saveExportFile(result);
      return '✅ 已导出所有 ' + (result.sessionCount || 0) + ' 个会话 → ' + result.filename;
    }
    // 批量模式
    return '✅ 已导出 ' + result.success + '/' + result.total + ' 个会话';
  }

  if (sub === 'batch') {
    var format2 = parts[1] || 'md';
    var ids = Object.keys(Core.session.sessions);
    var result2 = exportBatch(ids, format2);
    return '✅ 批量导出 ' + result2.success + '/' + result2.total + ' 个会话 (' + format2 + ')';
  }

  // 单个导出
  var result3 = exportSession(currentId, sub);
  if (result3.error) return '❌ ' + result3.error;
  saveExportFile(result3);
  return '✅ 已导出 → ' + result3.filename + ' (' + result3.messageCount + ' 条消息)';
}

function saveExportFile(result) {
  try {
    var exportDir = require('path').join(Core.DATA_ROOT, CONFIG.EXPORT_DIR);
    if (!require('fs').existsSync(exportDir)) {
      require('fs').mkdirSync(exportDir, { recursive: true });
    }
    var filePath = require('path').join(exportDir, result.filename);
    require('fs').writeFileSync(filePath, result.content, 'utf8');
    console.log('📤 导出文件: ' + filePath);

    // 复制到剪贴板（如果是文本格式）
    if (result.format === 'md' || result.format === 'txt') {
      try {
        var clipboard = require('electron').clipboard;
        clipboard.writeText(result.content);
      } catch (e) {}
    }
  } catch (e) {
    console.warn('保存导出文件失败:', e);
  }
}

function handleSyncCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = parts[0] || 'status';

  if (sub === 'status') {
    var status = getSyncStatus();
    return '🔄 同步状态\n\n' +
      '启用: ' + (status.enabled ? '✅' : '❌') + '\n' +
      '地址: ' + status.url + '\n' +
      '路径: ' + status.path + '\n' +
      '上次同步: ' + status.lastSync;
  }

  if (sub === 'push') {
    syncToWebDAV().then(function(r) {
      if (r.error) {
        if (Core.errorHandler) Core.errorHandler.showErrorToast(r.error);
      } else {
        if (Core.errorHandler) Core.errorHandler.showSuccessToast('同步推送完成: ' + r.sessionCount + ' 个会话');
      }
    });
    return '⏳ 正在推送到 WebDAV...';
  }

  if (sub === 'pull') {
    syncFromWebDAV().then(function(r) {
      if (r.error) {
        if (Core.errorHandler) Core.errorHandler.showErrorToast(r.error);
      } else {
        if (Core.errorHandler) Core.errorHandler.showSuccessToast('同步拉取完成: ' + r.sessionCount + ' 个会话');
      }
    });
    return '⏳ 正在从 WebDAV 拉取...';
  }

  if (sub === 'config') {
    // 显示当前配置提示
    var cfg = getSyncConfig();
    return '🔧 WebDAV 同步配置\n\n' +
      '当前: ' + (cfg.enabled ? '已启用' : '未启用') + '\n' +
      'URL: ' + (cfg.url || '(未设置)') + '\n\n' +
      '请在设置面板中配置 WebDAV 地址和凭据。\n' +
      '支持坚果云、Nextcloud 等 WebDAV 服务。';
  }

  return '❌ 未知子命令: ' + sub + ' (可用: status|push|pull|config)';
}

function handleBackupCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = parts[0] || 'help';

  if (sub === 'help' || sub === '') {
    return '💾 备份管理\n\n' +
      '/backup create — 创建本地备份\n' +
      '/backup list — 列出备份版本\n' +
      '/backup restore <文件名> — 恢复指定版本\n' +
      '/backup auto — 查看自动备份状态';
  }

  if (sub === 'create') {
    autoBackup().then(function(r) {
      if (Core.errorHandler) Core.errorHandler.showSuccessToast('备份已创建');
    }).catch(function(e) {
      if (Core.errorHandler) Core.errorHandler.showErrorToast('备份失败: ' + e.message);
    });
    return '⏳ 正在创建备份...';
  }

  if (sub === 'list') {
    var versions = getBackupVersions();
    if (versions.length === 0) return '📭 暂无备份文件';
    var lines = ['💾 备份版本列表 (' + versions.length + ' 个)\n'];
    versions.forEach(function(v, i) {
      lines.push((i + 1) + '. ' + v.name);
      lines.push('   大小: ' + v.sizeHuman + ' | 时间: ' + v.modified);
    });
    return lines.join('\n');
  }

  if (sub === 'restore') {
    var filename = parts[1];
    if (!filename) return '❌ 请指定备份文件名: /backup restore <文件名>';
    var result = restoreVersion(filename);
    if (result.error) return '❌ ' + result.error;
    return '✅ 恢复完成: 总计 ' + result.total + ' 个会话, 新增 ' + result.added + ', 跳过 ' + result.skipped;
  }

  if (sub === 'auto') {
    var versions2 = getBackupVersions();
    return '🔄 自动备份\n\n' +
      '间隔: 每 ' + (CONFIG.SYNC_INTERVAL_MS / 60000) + ' 分钟\n' +
      '最大版本数: ' + CONFIG.BACKUP_MAX_VERSIONS + '\n' +
      '当前版本数: ' + versions2.length;
  }

  return '❌ 未知子命令: ' + sub;
}

// ===== 工具函数 =====

function sanitizeFilename(name) {
  return (name || 'export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 50);
}

var escapeHtml = _htmlUtils.escapeHtml;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = { init };
