/**
 * backup.js - 数据备份与导出模块
 * 支持：会话导出 Markdown、配置 ZIP 备份、聊天记录迁移
 */

const fs = require('fs');
const path = require('path');
let ipcRenderer = null;
try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}

let Core;

// ===== 🔧 修复：settings.js 按钮调用的备份/恢复方法 =====
function backupData() {
  if (ipcRenderer) {
    ipcRenderer.send('backup-data');
    if (Core.errorHandler) Core.errorHandler.showSuccessToast('正在准备备份...');
    else {
      var status = document.getElementById('status');
      if (status) status.textContent = '⏳ 正在准备备份...';
    }
  } else {
    showToast('❌ 无法访问 IPC 通道', 'error');
  }
}

function restoreData() {
  if (ipcRenderer) {
    ipcRenderer.send('restore-data');
    if (Core.errorHandler) Core.errorHandler.showSuccessToast('正在准备恢复...');
    else {
      var status = document.getElementById('status');
      if (status) status.textContent = '⏳ 正在准备恢复...';
    }
  } else {
    showToast('❌ 无法访问 IPC 通道', 'error');
  }
}

// ===== 🔧 修复：监听主进程备份/恢复响应 =====
if (ipcRenderer) {
  ipcRenderer.on('backup-response', function(event, data) {
    var status = document.getElementById('status');
    if (data.success) {
      if (Core.errorHandler) Core.errorHandler.showSuccessToast('备份成功');
      if (status) status.textContent = '✅ 备份成功';
      showToast('✅ 备份成功！\n保存位置:\n' + (data.filePath || '未知'), 'success');
    } else {
      if (Core.errorHandler) Core.errorHandler.showErrorToast('备份失败');
      if (status) status.textContent = '❌ 备份失败';
      showToast('❌ 备份失败: ' + (data.error || '未知错误'), 'error');
    }
    setTimeout(function() { if (status) status.textContent = '✅ 已就绪'; }, 3000);
  });

  ipcRenderer.on('restore-response', function(event, data) {
    var status = document.getElementById('status');
    if (data.success) {
      if (Core.errorHandler) Core.errorHandler.showSuccessToast('恢复成功，即将重启');
      if (status) status.textContent = '✅ 数据恢复成功';
      showToast('✅ 数据恢复成功！\n应用将重新加载以应用恢复的数据。', 'success');
      // 恢复后重新加载页面以应用数据
      try { window.location.reload(); } catch(e) {}
    } else {
      if (Core.errorHandler) Core.errorHandler.showErrorToast('恢复失败');
      if (status) status.textContent = '❌ 恢复失败';
      showToast('❌ 恢复失败: ' + (data.error || '未知错误'), 'error');
    }
    setTimeout(function() { if (status) status.textContent = '✅ 已就绪'; }, 3000);
  });
}

function init(_Core) {
  Core = _Core;
  Core.backup = {
    exportSessionToMarkdown,
    exportAllSessionsToMarkdown,
    backupConfigToZip,
    backupAllToZip,
    importSessionsFromMarkdown,
    importConfigFromJson,
    getBackupInfo,
    backupData,   // 🔧 修复：settings.js 备份按钮调用
    restoreData,  // 🔧 修复：settings.js 恢复按钮调用
  };
  console.log('✅ 备份模块已加载');
}

// ===== 会话导出为 Markdown =====
function exportSessionToMarkdown(sessionId, sessions) {
  const session = sessions[sessionId];
  if (!session) throw new Error('会话不存在: ' + sessionId);
  
  let md = `# ${session.title || '未命名会话'}\n\n`;
  md += `> 导出时间: ${new Date().toLocaleString()}\n`;
  md += `> 会话ID: ${sessionId}\n`;
  md += `> 消息数: ${session.messages ? session.messages.length : 0}\n\n`;
  md += '---\n\n';
  
  if (session.messages && Array.isArray(session.messages)) {
    for (const msg of session.messages) {
      const roleLabel = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 AI' : '📋 系统';
      const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
      md += `### ${roleLabel}${time ? ' · ' + time : ''}\n\n`;
      md += `${msg.content || ''}\n\n`;
      md += '---\n\n';
    }
  }
  
  return md;
}

// 导出所有会话为 Markdown（按日期分文件）
function exportAllSessionsToMarkdown(sessions) {
  const results = [];
  for (const [sessionId, session] of Object.entries(sessions)) {
    try {
      const md = exportSessionToMarkdown(sessionId, sessions);
      const filename = (session.title || '未命名会话').replace(/[<>:"/\\|?*]/g, '_') + '_' + sessionId.slice(0, 8) + '.md';
      results.push({ filename, content: md, sessionId });
    } catch (e) {
      console.warn('⚠️ 导出会话失败:', sessionId, e.message);
    }
  }
  return results;
}

// ===== 配置导出为 JSON =====
function exportConfig() {
  const config = { ...Core.config };
  // 🔒 安全修复：脱敏所有 API Keys（完整列表）
  const sensitiveKeys = [
    'deepseekKey', 'qwenKey', 'doubaoKey', 'customKey',
    'bingApiKey', 'bochaApiKey', 'googleApiKey', 'googleCx',
    'searxngApiKey', 'openaiKey'
  ];
  for (const key of sensitiveKeys) {
    if (config[key]) {
      const val = config[key];
      config[key] = val.length > 12 ? val.slice(0, 4) + '****' + val.slice(-4) : '****';
    }
  }
  return JSON.stringify(config, null, 2);
}

// ===== 完整备份（ZIP 格式，使用原生 JS 实现）=====
async function backupAllToZip() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(Core.DATA_ROOT, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  
  const backupPath = path.join(backupDir, `backup_${timestamp}`);
  fs.mkdirSync(backupPath, { recursive: true });
  
  // 1. 备份配置
  fs.writeFileSync(path.join(backupPath, 'config.json'), exportConfig());
  
  // 2. 备份所有会话为 Markdown
  const sessions = Core.session.loadSessionsForService 
    ? Core.session.loadSessionsForService(Core.cloudApi.getCurrentService())
    : Core.session.sessions;
  
  const sessionsDir = path.join(backupPath, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  
  const exported = exportAllSessionsToMarkdown(sessions);
  for (const item of exported) {
    fs.writeFileSync(path.join(sessionsDir, item.filename), item.content, 'utf8');
  }
  
  // 3. 备份收藏
  const favoritesPath = path.join(Core.DATA_ROOT, 'users', Core.getCurrentUser ? Core.getCurrentUser() : 'admin', 'favorites.json');
  if (fs.existsSync(favoritesPath)) {
    fs.copyFileSync(favoritesPath, path.join(backupPath, 'favorites.json'));
  }
  
  // 4. 备份知识库
  const knowledgePath = path.join(Core.DATA_ROOT, 'knowledge');
  if (fs.existsSync(knowledgePath)) {
    const knowledgeBackupDir = path.join(backupPath, 'knowledge');
    fs.mkdirSync(knowledgeBackupDir, { recursive: true });
    copyDirSync(knowledgePath, knowledgeBackupDir);
  }
  
  console.log('✅ 备份完成:', backupPath);
  console.log('📦 会话数:', exported.length);
  return { backupPath, sessionCount: exported.length };
}

// 配置单独备份
async function backupConfigToZip() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(Core.DATA_ROOT, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  
  const backupPath = path.join(backupDir, `config_${timestamp}.json`);
  fs.writeFileSync(backupPath, exportConfig(), 'utf8');
  
  console.log('✅ 配置备份完成:', backupPath);
  return { backupPath };
}

// ===== 导入功能 =====
function importSessionsFromMarkdown(mdContent, defaultTitle) {
  const lines = mdContent.split('\n');
  const messages = [];
  let currentRole = null;
  let currentContent = [];
  let title = defaultTitle || '导入的会话';
  
  // 提取标题
  if (lines[0] && lines[0].startsWith('# ')) {
    title = lines[0].substring(2).trim();
  }
  
  for (const line of lines) {
    if (line.startsWith('### 👤 用户')) {
      if (currentRole && currentContent.length > 0) {
        messages.push({ role: currentRole, content: currentContent.join('\n').trim(), timestamp: Date.now() });
      }
      currentRole = 'user';
      currentContent = [];
    } else if (line.startsWith('### 🤖 AI')) {
      if (currentRole && currentContent.length > 0) {
        messages.push({ role: currentRole, content: currentContent.join('\n').trim(), timestamp: Date.now() });
      }
      currentRole = 'assistant';
      currentContent = [];
    } else if (line.startsWith('### 📋 系统')) {
      if (currentRole && currentContent.length > 0) {
        messages.push({ role: currentRole, content: currentContent.join('\n').trim(), timestamp: Date.now() });
      }
      currentRole = 'system';
      currentContent = [];
    } else if (line.startsWith('---') || line.startsWith('#')) {
      // 分隔线或标题，跳过
    } else if (currentRole) {
      currentContent.push(line);
    }
  }
  
  // 最后一条消息
  if (currentRole && currentContent.length > 0) {
    messages.push({ role: currentRole, content: currentContent.join('\n').trim(), timestamp: Date.now() });
  }
  
  return { title, messages };
}

function importConfigFromJson(jsonContent) {
  try {
    const config = JSON.parse(jsonContent);
    // 只导入非敏感配置（不覆盖 API Keys）
    const safeKeys = ['theme', 'temperature', 'streamResponse', 'chatBubbleUser', 'chatBubbleAI', 'notification', 'shortcutEnabled'];
    const safeConfig = {};
    for (const key of safeKeys) {
      if (config[key] !== undefined) safeConfig[key] = config[key];
    }
    Core.saveConfig(safeConfig);
    return { success: true, imported: Object.keys(safeConfig) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 备份信息 =====
function getBackupInfo() {
  const backupDir = path.join(Core.DATA_ROOT, 'backups');
  if (!fs.existsSync(backupDir)) return { count: 0, backups: [] };
  
  const entries = fs.readdirSync(backupDir);
  const backups = [];
  for (const entry of entries) {
    const entryPath = path.join(backupDir, entry);
    try {
      const stat = fs.statSync(entryPath);
      backups.push({
        name: entry,
        path: entryPath,
        size: stat.size,
        created: stat.birthtime || stat.ctime,
        isDirectory: stat.isDirectory(),
      });
    } catch (e) {}
  }
  
  backups.sort((a, b) => b.created - a.created);
  return { count: backups.length, backups };
}

// 辅助：递归复制目录
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { init };
