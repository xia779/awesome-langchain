// modules/export.js - 会话导入导出（增强版：添加复制到剪贴板、复制 Markdown）
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 导出当前会话 =====
function exportCurrentSession(format) {
  format = format || 'json';
  const id = Core.session.getCurrentId();
  if (!id) { showToast('❌ 没有活动会话可导出', 'error'); return; }
  const session = Core.session.sessions[id];
  if (!session || !session.messages || session.messages.length === 0) {
    showToast('❌ 当前会话为空', 'error'); return;
  }

  const title = session.title || '未命名会话';
  const timestamp = new Date().toISOString().slice(0, 10);
  const exportDir = Core.pathService.global('exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  if (format === 'json') {
    // JSON格式：完整会话数据，可导入
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        title: title,
        messages: session.messages,
        pinned: session.pinned || false
      }
    };
    const fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '_' + timestamp + '.json';
    const filePath = path.join(exportDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8');
    Core.dom.status.textContent = '✅ 已导出JSON: ' + fileName;
    showToast('✅ 导出成功（JSON格式，可导入）\n保存位置:\n' + filePath, 'success');
  } else if (format === 'markdown') {
    // Markdown格式：只读，便于分享
    let md = '# ' + title + '\n\n';
    md += '> 导出时间: ' + new Date().toLocaleString() + '\n\n';
    md += '---\n\n';
    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '👤 用户' : (msg.role === 'ai' || msg.role === 'assistant') ? '🤖 AI' : msg.role;
      md += '## ' + role + '\n\n' + (msg.content || '') + '\n\n---\n\n';
    }
    const fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '_' + timestamp + '.md';
    const filePath = path.join(exportDir, fileName);
    fs.writeFileSync(filePath, md, 'utf8');
    Core.dom.status.textContent = '✅ 已导出MD: ' + fileName;
    showToast('✅ 导出成功（Markdown格式）\n保存位置:\n' + filePath, 'success');
  }
  setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
  // 打开导出目录
  try { require('electron').shell.openPath(exportDir); } catch (e) { console.warn('⚠️ [export] 操作失败:', e.message || e); }
}

// ===== 复制会话到剪贴板 =====
function copySessionToClipboard(format) {
  format = format || 'markdown';
  const id = Core.session.getCurrentId();
  if (!id) { showToast('❌ 没有活动会话', 'error'); return; }
  const session = Core.session.sessions[id];
  if (!session || !session.messages || session.messages.length === 0) {
    showToast('❌ 当前会话为空', 'error'); return;
  }

  const title = session.title || '未命名会话';
  let content = '';

  if (format === 'markdown') {
    content = '# ' + title + '\n\n';
    content += '> 导出时间: ' + new Date().toLocaleString() + '\n\n';
    content += '---\n\n';
    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '👤 用户' : '🤖 AI';
      content += '## ' + role + '\n\n' + (msg.content || '') + '\n\n---\n\n';
    }
  } else if (format === 'plaintext') {
    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '用户' : 'AI';
      content += '【' + role + '】\n' + (msg.content || '') + '\n\n';
    }
  }

  navigator.clipboard.writeText(content).then(function() {
    Core.dom.status.textContent = '✅ 已复制到剪贴板';
    setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
  }).catch(function(err) {
    showToast('❌ 复制失败: ' + err.message, 'error');
  });
}

// ===== 复制单条消息 =====
function copyMessageToClipboard(msg, format) {
  format = format || 'plaintext';
  if (!msg || !msg.content) return;

  let content = '';
  if (format === 'markdown') {
    const role = msg.role === 'user' ? '用户' : 'AI';
    content = '## ' + role + '\n\n' + msg.content + '\n\n---\n\n';
  } else {
    content = msg.content;
  }

  navigator.clipboard.writeText(content).then(function() {
    Core.dom.status.textContent = '✅ 消息已复制';
    setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 2000);
  }).catch(function(err) {
    console.error('复制失败:', err);
  });
}


// ===== 导出 HTML 格式（含代码高亮）=====
function exportCurrentSessionAsHtml() {
  const id = Core.session.getCurrentId();
  if (!id) { showToast('❌ 没有活动会话可导出', 'error'); return; }
  const session = Core.session.sessions[id];
  if (!session || !session.messages || session.messages.length === 0) {
    showToast('❌ 当前会话为空', 'error'); return;
  }

  const title = session.title || '未命名会话';
  const timestamp = new Date().toISOString().slice(0, 10);
  const exportDir = Core.pathService.global('exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  var msgHtml = '';
  session.messages.forEach(function(msg) {
    var isUser = msg.role === 'user';
    var roleLabel = isUser ? '用户' : 'AI';
    var roleColor = isUser ? '#3b82f6' : '#10b981';
    var bgColor = isUser ? '#eff6ff' : '#f0fdf4';
    var borderColor = isUser ? '#bfdbfe' : '#bbf7d0';
    var content = msg.content || '';
    // 简单 HTML 转义
    content = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 代码块处理（使用 hljs 预渲染语法高亮，导出文件自包含无需外部 JS）
    content = content.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
      var highlighted = code.trim();
      if (window.hljs) {
        try {
          if (lang && window.hljs.getLanguage(lang)) {
            highlighted = window.hljs.highlight(code.trim(), { language: lang }).value;
          } else {
            highlighted = window.hljs.highlightAuto(code.trim()).value;
          }
        } catch (e) { /* 高亮失败保留原文 */ }
      }
      return '<pre style="background:#1e293b;color:#e2e8f0;padding:12px 16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;"><code>' + highlighted + '</code></pre>';
    });
    // 行内代码
    content = content.replace(/`([^`]+)`/g, '<code style="background:#e2e8f0;padding:1px 4px;border-radius:3px;font-size:0.9em;">$1</code>');
    // 粗体
    content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 换行
    content = content.replace(/\n/g, '<br>');

    msgHtml += '<div style="margin-bottom:16px;">';
    msgHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
    msgHtml += '<span style="color:' + roleColor + ';font-weight:600;font-size:14px;">' + roleLabel + '</span>';
    if (msg.timestamp) {
      msgHtml += '<span style="color:#94a3b8;font-size:11px;">' + new Date(msg.timestamp).toLocaleString() + '</span>';
    }
    msgHtml += '</div>';
    msgHtml += '<div style="padding:12px 16px;background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:10px;line-height:1.7;font-size:14px;">';
    msgHtml += content;
    msgHtml += '</div></div>';
  });

  var htmlContent = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' + title + '</title>';
  // 🔒 S1 离线化：内联本地 highlight.js 主题 CSS（不再依赖 CDN）
  var hljsCss = '';
  try { hljsCss = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'highlight.js', 'styles', 'github-dark.min.css'), 'utf8'); } catch(e) { hljsCss = ''; }
  if (hljsCss) { htmlContent += '<style>' + hljsCss + '</style>'; }
  htmlContent += '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:800px;margin:0 auto;padding:24px;background:#f8fafc;color:#1e293b;}h1{color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:12px;}.meta{color:#64748b;font-size:13px;margin-bottom:24px;}</style>';
  htmlContent += '</head><body>';
  htmlContent += '<h1>' + title + '</h1>';
  htmlContent += '<div class="meta">导出时间: ' + new Date().toLocaleString() + ' · 消息数: ' + session.messages.length + '</div>';
  htmlContent += msgHtml;
  htmlContent += '</body></html>';

  var fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '_' + timestamp + '.html';
  var filePath = path.join(exportDir, fileName);
  fs.writeFileSync(filePath, htmlContent, 'utf8');
  Core.dom.status.textContent = '✅ 已导出HTML: ' + fileName;
  showToast('✅ 导出成功（HTML格式，含代码高亮）\n保存位置:\n' + filePath, 'success');
  setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
  try { require('electron').shell.openPath(exportDir); } catch (e) { console.warn('⚠️ [export] 操作失败:', e.message || e); }
}

// ===== 批量导出会话树（主会话 + 所有子会话）=====
function exportSessionTree(format) {
  format = format || 'json';
  const id = Core.session.getCurrentId();
  if (!id) { showToast('❌ 没有活动会话可导出', 'error'); return; }

  const sessions = Core.session.sessions || {};
  var treeIds = [id];
  // 查找所有子会话
  Object.keys(sessions).forEach(function(sid) {
    if (sessions[sid].parentId === id) treeIds.push(sid);
    // 也查找孙会话
    Object.keys(sessions).forEach(function(gid) {
      if (sessions[gid].parentId === sid && treeIds.indexOf(sid) >= 0) treeIds.push(gid);
    });
  });

  if (treeIds.length <= 1) {
    // 没有子会话，直接导出当前
    exportCurrentSession(format);
    return;
  }

  const exportDir = Core.pathService.global('exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 10);
  const masterTitle = (sessions[id].title || '未命名').replace(/[\\/:*?"<>|]/g, '_');

  if (format === 'json') {
    var treeData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      type: 'session-tree',
      sessions: []
    };
    treeIds.forEach(function(tid) {
      var s = sessions[tid];
      if (s && s.messages && s.messages.length > 0) {
        treeData.sessions.push({
          id: tid,
          title: s.title || '未命名',
          parentId: s.parentId || null,
          roleType: s.roleType || 'chat',
          messages: s.messages,
          pinned: s.pinned || false
        });
      }
    });
    var fileName = masterTitle + '_tree_' + timestamp + '.json';
    var filePath = path.join(exportDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(treeData, null, 2), 'utf8');
    Core.dom.status.textContent = '✅ 已导出会话树: ' + treeData.sessions.length + ' 个会话';
    showToast('✅ 批量导出成功\n会话数: ' + treeData.sessions.length + '\n保存位置:\n' + filePath, 'success');
  } else if (format === 'markdown') {
    var md = '# ' + masterTitle + ' (会话树)\n\n';
    md += '> 导出时间: ' + new Date().toLocaleString() + '\n';
    md += '> 包含 ' + treeIds.length + ' 个会话\n\n---\n\n';
    treeIds.forEach(function(tid) {
      var s = sessions[tid];
      if (!s || !s.messages || s.messages.length === 0) return;
      md += '## 📂 ' + (s.title || '未命名') + '\n\n';
      if (s.roleType) md += '*角色: ' + s.roleType + '*\n\n';
      s.messages.forEach(function(msg) {
        var role = msg.role === 'user' ? '👤 用户' : '🤖 AI';
        md += '### ' + role + '\n\n' + (msg.content || '') + '\n\n---\n\n';
      });
    });
    var fileName = masterTitle + '_tree_' + timestamp + '.md';
    var filePath = path.join(exportDir, fileName);
    fs.writeFileSync(filePath, md, 'utf8');
    Core.dom.status.textContent = '✅ 已导出会话树MD';
    showToast('✅ 批量导出成功（Markdown）\n会话数: ' + treeIds.length + '\n保存位置:\n' + filePath, 'success');
  }
  setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
  try { require('electron').shell.openPath(exportDir); } catch (e) { console.warn('⚠️ [export] 操作失败:', e.message || e); }
}
// ===== 导入会话 =====
function importSession(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    showToast('❌ 文件不存在', 'error'); return false;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data.session || !data.session.messages) {
      showToast('❌ 无效的文件格式', 'error'); return false;
    }
    const imported = data.session;
    const title = imported.title || '导入的会话';

    // 检查重复（相同标题且消息数相同且内容前100字相同）
    const sessions = Core.session.sessions || {};
    var isDuplicate = false;
    for (const sid of Object.keys(sessions)) {
      const s = sessions[sid];
      if (s.title === title && s.messages && s.messages.length === imported.messages.length) {
        // 进一步比较第一条消息内容
        var firstMsg = imported.messages[0];
        var existingFirst = s.messages[0];
        if (firstMsg && existingFirst && firstMsg.content && existingFirst.content &&
            firstMsg.content.substring(0, 100) === existingFirst.content.substring(0, 100)) {
          isDuplicate = true;
          break;
        }
      }
    }
    if (isDuplicate) {
      if (!confirm('⚠️ 已存在相同标题和内容的会话，是否仍要导入？')) return false;
    }

    // 创建新会话
    const newId = Core.generateId ? Core.generateId() : Date.now().toString(36);
    
    // 确保消息有时间戳
    var messages = imported.messages || [];
    var baseTime = Date.now();
    messages.forEach(function(msg, idx) {
      if (!msg.timestamp || isNaN(msg.timestamp)) {
        msg.timestamp = baseTime - (messages.length - 1 - idx) * 60000;
      }
    });
    
    sessions[newId] = {
      title: title,
      messages: messages,
      pinned: false,
      roleType: 'chat',
      parentId: null,
      collapsed: false,
      _manuallyRenamed: true
    };
    if (Core.session.saveSession) Core.session.saveSession(newId);

    // 刷新会话列表并切换到新会话
    if (Core.session.renderChatList) Core.session.renderChatList();
    if (Core.session.switchSession) Core.session.switchSession(newId);

    Core.dom.status.textContent = '✅ 会话导入成功: ' + title;
    showToast('✅ 导入成功！\n会话: ' + title + '\n消息数: ' + messages.length, 'success');
    setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
    return true;
  } catch (err) {
    showToast('❌ 导入失败: ' + err.message, 'error');
    console.error('导入错误:', err);
    return false;
  }
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.export = {
      exportCurrentSession: exportCurrentSession,
      exportCurrentSessionAsHtml: exportCurrentSessionAsHtml,
      exportSessionTree: exportSessionTree,
      copySessionToClipboard: copySessionToClipboard,
      copyMessageToClipboard: copyMessageToClipboard,
      importSession: importSession,
    };
    console.log('✅ 导入导出模块已加载（增强版）');
  }
};
