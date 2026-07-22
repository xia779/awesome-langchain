// ux-enhance.js - 交互体验增强模块（消息操作按钮 + 会话标签 + 书签 + 代码增强）
'use strict';

var Core = null;
var fs = null;
var path = null;

var BOOKMARKS_FILE = '';
var TAGS_FILE = '';
var bookmarks = [];    // [{ sessionId, msgIndex, content, timestamp, sessionTitle }]
var sessionTags = {};  // { sessionId: ['tag1', 'tag2'] }

// ===== 书签系统 =====

function loadBookmarks() {
  BOOKMARKS_FILE = path.join(Core.DATA_ROOT, 'message-bookmarks.json');
  try {
    if (fs.existsSync(BOOKMARKS_FILE)) {
      bookmarks = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8'));
    }
  } catch (e) { bookmarks = []; }
}

function saveBookmarks() {
  try {
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save bookmarks:', e.message); }
}

function toggleBookmark(sessionId, msgIndex) {
  var idx = bookmarks.findIndex(function(b) {
    return b.sessionId === sessionId && b.msgIndex === msgIndex;
  });
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
    saveBookmarks();
    return { bookmarked: false };
  }

  // Add bookmark
  var session = Core.session.sessions[sessionId];
  if (!session || !session.messages[msgIndex]) return { bookmarked: false };
  var msg = session.messages[msgIndex];
  bookmarks.push({
    sessionId: sessionId,
    msgIndex: msgIndex,
    content: (msg.content || '').substring(0, 200),
    role: msg.role,
    timestamp: msg.timestamp || Date.now(),
    sessionTitle: session.title || '未命名'
  });
  saveBookmarks();
  return { bookmarked: true };
}

function isBookmarked(sessionId, msgIndex) {
  return bookmarks.some(function(b) {
    return b.sessionId === sessionId && b.msgIndex === msgIndex;
  });
}

function listBookmarks() {
  return bookmarks.slice().sort(function(a, b) { return b.timestamp - a.timestamp; });
}

function deleteBookmark(sessionId, msgIndex) {
  bookmarks = bookmarks.filter(function(b) {
    return !(b.sessionId === sessionId && b.msgIndex === msgIndex);
  });
  saveBookmarks();
}

function navigateToBookmark(sessionId, msgIndex) {
  if (Core.session.switchSession) {
    Core.session.switchSession(sessionId);
  }
  // Scroll to message
  setTimeout(function() {
    var container = document.getElementById('chatContainer');
    if (!container) return;
    var msgs = container.querySelectorAll('.msg');
    if (msgs[msgIndex]) {
      msgs[msgIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      msgs[msgIndex].classList.add('highlight-flash');
      setTimeout(function() { msgs[msgIndex].classList.remove('highlight-flash'); }, 2000);
    }
  }, 300);
}

// ===== 会话标签系统 =====

function loadTags() {
  TAGS_FILE = path.join(Core.DATA_ROOT, 'session-tags.json');
  try {
    if (fs.existsSync(TAGS_FILE)) {
      sessionTags = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf-8'));
    }
  } catch (e) { sessionTags = {}; }
}

function saveTags() {
  try {
    fs.writeFileSync(TAGS_FILE, JSON.stringify(sessionTags, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save tags:', e.message); }
}

function getSessionTags(sessionId) {
  return sessionTags[sessionId] || [];
}

function setSessionTag(sessionId, tag) {
  if (!sessionTags[sessionId]) sessionTags[sessionId] = [];
  if (!sessionTags[sessionId].includes(tag)) {
    sessionTags[sessionId].push(tag);
    saveTags();
  }
  return sessionTags[sessionId];
}

function removeSessionTag(sessionId, tag) {
  if (!sessionTags[sessionId]) return;
  sessionTags[sessionId] = sessionTags[sessionId].filter(function(t) { return t !== tag; });
  if (sessionTags[sessionId].length === 0) delete sessionTags[sessionId];
  saveTags();
}

function getAllTags() {
  var tagSet = {};
  Object.keys(sessionTags).forEach(function(sid) {
    (sessionTags[sid] || []).forEach(function(t) { tagSet[t] = (tagSet[t] || 0) + 1; });
  });
  return Object.keys(tagSet).map(function(t) { return { name: t, count: tagSet[t] }; })
    .sort(function(a, b) { return b.count - a.count; });
}

function getSessionsByTag(tag) {
  return Object.keys(sessionTags).filter(function(sid) {
    return sessionTags[sid] && sessionTags[sid].includes(tag);
  });
}

// ===== 消息操作按钮注入 =====

var TAG_COLORS = {
  '工作': '#3b82f6', '学习': '#8b5cf6', '项目': '#f59e0b',
  '生活': '#10b981', '代码': '#ef4444', '创意': '#ec4899'
};

function getTagColor(tag) {
  return TAG_COLORS[tag] || '#6b7280';
}

function injectMessageActions() {
  // 通过统一 chatObserver 分发，不再创建独立 MutationObserver
  if (!Core.chatObserver) {
    console.warn('ux-enhance: Core.chatObserver 不可用，消息操作按钮未注册');
    return;
  }
  Core.chatObserver.onMessage(function(node) {
    addActionsToMessage(node);
  });
  console.log('✅ ux-enhance: Message actions 已注册到统一 chatObserver');
}

function addActionsToMessage(msgEl) {
  if (msgEl.querySelector('.msg-hover-actions')) return; // already added

  var isUser = msgEl.classList.contains('user');
  var isAI = msgEl.classList.contains('ai');
  msgEl.style.position = 'relative';

  var actionsDiv = document.createElement('div');
  actionsDiv.className = 'msg-hover-actions';
  actionsDiv.style.cssText = 'position:absolute;top:4px;right:4px;display:none;gap:2px;z-index:5;background:var(--panel,#141414);border-radius:8px;padding:2px 4px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:1px solid var(--border,#2a2a2a);pointer-events:none;';

  // Copy button
  var copyBtn = createActionBtn('content_copy', '复制');
  copyBtn.onclick = function(e) {
    e.stopPropagation();
    // 提取纯文本：排除图标连字、时间戳、操作按钮、代码行号/语言标签等 UI 元素，保留正文与代码
    var source = msgEl.querySelector('.agent-content') || msgEl;
    var clone = source.cloneNode(true);
    var rm = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .msg-actions, .quick-actions, .msg-hover-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .agent-think-panel, .agent-steps-live, .agent-status-row, .thinking-process, .line-numbers, .code-lang-label');
    rm.forEach(function(el) { el.remove(); });
    var text = clone.textContent || '';
    navigator.clipboard.writeText(text).then(function() {
      copyBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;">check</span>';
      setTimeout(function() { copyBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;">content_copy</span>'; }, 1500);
    });
  };
  actionsDiv.appendChild(copyBtn);

  // Quote button
  var quoteBtn = createActionBtn('format_quote', '引用');
  quoteBtn.onclick = function(e) {
    e.stopPropagation();
    var msgIndex = getMessageIndex(msgEl);
    var sessionId = Core.session.getCurrentId();
    var session = Core.session.sessions[sessionId];
    if (session && session.messages[msgIndex] && Core.setQuote) {
      Core.setQuote({
        msgIndex: msgIndex,
        role: session.messages[msgIndex].role,
        content: (session.messages[msgIndex].content || '').substring(0, 100)
      });
    }
  };
  actionsDiv.appendChild(quoteBtn);

  // Bookmark button
  var bookmarkBtn = createActionBtn('bookmark_border', '收藏');
  var msgIndex = getMessageIndex(msgEl);
  var sessionId = Core.session.getCurrentId();
  if (isBookmarked(sessionId, msgIndex)) {
    bookmarkBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;color:#f59e0b;">bookmark</span>';
  }
  bookmarkBtn.onclick = function(e) {
    e.stopPropagation();
    var sid = Core.session.getCurrentId();
    var idx = getMessageIndex(msgEl);
    var result = toggleBookmark(sid, idx);
    bookmarkBtn.innerHTML = result.bookmarked
      ? '<span class="material-icons-outlined" style="font-size:14px;color:#f59e0b;">bookmark</span>'
      : '<span class="material-icons-outlined" style="font-size:14px;">bookmark_border</span>';
    bookmarkBtn.title = result.bookmarked ? '取消收藏' : '收藏';
  };
  actionsDiv.appendChild(bookmarkBtn);

  // Edit button (user messages only)
  if (isUser) {
    var editBtn = createActionBtn('edit', '编辑');
    editBtn.onclick = function(e) {
      e.stopPropagation();
      if (Core.enterEditMode) {
        Core.enterEditMode(msgEl);
      } else if (typeof window.enterEditMode === 'function') {
        window.enterEditMode(msgEl);
      }
    };
    actionsDiv.appendChild(editBtn);
  }

  // Regenerate button (AI messages only)
  if (isAI) {
    var regenBtn = createActionBtn('autorenew', '重新生成');
    regenBtn.onclick = function(e) {
      e.stopPropagation();
      if (Core.regenerateMessage) {
        Core.regenerateMessage(msgEl);
      } else if (typeof window.regenerateMessage === 'function') {
        window.regenerateMessage(msgEl);
      }
    };
    actionsDiv.appendChild(regenBtn);
  }

  msgEl.appendChild(actionsDiv);
  // Show/hide 由 CSS .msg:hover .msg-hover-actions { display: flex !important; } 控制
  // 不再需要 JS mouseenter/mouseleave 监听器（减少每消息 2 个 listener）
}

function createActionBtn(icon, title) {
  var btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  btn.title = title;
  btn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;">' + icon + '</span>';
  btn.style.cssText = 'background:none;border:none;color:var(--text-secondary,#9ca3af);cursor:pointer;padding:3px;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;pointer-events:auto;';
  btn.onmouseenter = function() { btn.style.background = 'var(--primary-light,rgba(59,130,246,0.15))'; btn.style.color = 'var(--primary,#3b82f6)'; };
  btn.onmouseleave = function() { btn.style.background = 'none'; btn.style.color = 'var(--text-secondary,#9ca3af)'; };
  return btn;
}

function getMessageIndex(msgEl) {
  // 优先使用 session.js 渲染时设置的 data-msg-index（虚拟滚动下DOM位置≠数据索引）
  if (msgEl.dataset && msgEl.dataset.msgIndex !== undefined) {
    return parseInt(msgEl.dataset.msgIndex, 10);
  }
  var container = document.getElementById('chatContainer');
  if (!container) return -1;
  var msgs = Array.from(container.querySelectorAll('.msg'));
  return msgs.indexOf(msgEl);
}

// ===== 代码块增强 =====

function enhanceCodeBlocks() {
  // 通过统一 chatObserver 分发，不再创建独立 MutationObserver
  if (!Core.chatObserver) return;
  Core.chatObserver.onMessage(function(node) {
    if (node.querySelectorAll) {
      var pres = node.querySelectorAll('pre');
      for (var i = 0; i < pres.length; i++) enhanceSingleCodeBlock(pres[i]);
    }
  });
  // 处理已有代码块
  var container = document.getElementById('chatContainer');
  if (container) {
    container.querySelectorAll('pre').forEach(enhanceSingleCodeBlock);
  }
}

function enhanceSingleCodeBlock(pre) {
  if (pre.querySelector('.code-lang-label')) return;

  var code = pre.querySelector('code');
  if (!code) return;

  // Language label
  var lang = '';
  var classes = code.className || '';
  var match = classes.match(/language-(\w+)/);
  if (match) lang = match[1];
  if (!lang) {
    // Try to detect from content
    var text = code.textContent || '';
    if (text.includes('def ') || text.includes('import ') && text.includes(':')) lang = 'python';
    else if (text.includes('function ') || text.includes('const ') || text.includes('var ')) lang = 'javascript';
    else if (text.includes('<') && text.includes('>') && text.includes('/')) lang = 'html';
    else if (text.includes('{') && text.includes('}') && text.includes(':')) lang = 'css';
    else if (text.includes('SELECT ') || text.includes('select ')) lang = 'sql';
    else if (text.includes('package ') || text.includes('public class')) lang = 'java';
  }

  if (lang) {
    var label = document.createElement('span');
    label.className = 'code-lang-label';
    label.textContent = lang;
    label.style.cssText = 'position:absolute;top:0;left:0;padding:2px 8px;font-size:10px;color:var(--text-secondary,#9ca3af);background:rgba(0,0,0,0.3);border-radius:0 0 6px 0;text-transform:uppercase;letter-spacing:0.5px;';
    pre.style.position = 'relative';
    pre.style.paddingTop = '24px';
    pre.appendChild(label);
  }

  // Line numbers
  if (!pre.querySelector('.line-numbers')) {
    var lines = (code.textContent || '').split('\n');
    if (lines.length > 2) {
      var lnDiv = document.createElement('span');
      lnDiv.className = 'line-numbers';
      lnDiv.style.cssText = 'position:absolute;left:0;top:' + (lang ? '24' : '0') + 'px;width:32px;text-align:right;padding:12px 4px 12px 0;font-size:11px;line-height:1.5;color:rgba(255,255,255,0.2);user-select:none;border-right:1px solid rgba(255,255,255,0.06);';
      var lnText = '';
      for (var i = 1; i <= lines.length; i++) {
        lnText += i + '\n';
      }
      lnDiv.textContent = lnText;
      pre.style.position = 'relative';
      pre.style.paddingLeft = '40px';
      pre.appendChild(lnDiv);
    }
  }
}

// ===== 命令注册 =====

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('bookmarks', {
    zh: '查看收藏消息',
    en: 'View bookmarked messages'
  }, function(args) {
    var list = listBookmarks();
    if (list.length === 0) {
      showSystemMsg('📌 暂无收藏消息。\n将鼠标悬停在消息上，点击书签图标即可收藏。');
      return;
    }
    var text = '📌 **收藏的消息** (' + list.length + '条)\n\n';
    list.forEach(function(b, i) {
      var role = b.role === 'user' ? '👤' : '🤖';
      text += (i + 1) + '. ' + role + ' **' + (b.sessionTitle || '') + '**\n';
      text += '   ' + (b.content || '').substring(0, 100) + (b.content && b.content.length > 100 ? '...' : '') + '\n';
      text += '   [/go bookmark:' + b.sessionId + ':' + b.msgIndex + ']\n\n';
    });
    showSystemMsg(text);
  });

  Core.custom.registerCommand('tags', {
    zh: '会话标签管理: /tags list|add|remove',
    en: 'Session tag management'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'list') {
      var allTags = getAllTags();
      if (allTags.length === 0) {
        showSystemMsg('🏷 暂无标签。\n使用 `/tags add <标签名>` 为当前会话添加标签。');
        return;
      }
      var text = '🏷 **会话标签**\n\n';
      allTags.forEach(function(t) {
        text += '- **' + t.name + '** (' + t.count + ' 个会话)\n';
      });
      showSystemMsg(text);
      return;
    }

    if (sub === 'add') {
      var tag = parts.slice(1).join(' ') || '';
      if (!tag) { showSystemMsg('⚠️ 格式: /tags add <标签名>'); return; }
      var sid = Core.session.getCurrentId();
      setSessionTag(sid, tag);
      showSystemMsg('🏷 已添加标签: **' + tag + '**');
      return;
    }

    if (sub === 'remove') {
      var tag = parts.slice(1).join(' ') || '';
      if (!tag) { showSystemMsg('⚠️ 格式: /tags remove <标签名>'); return; }
      var sid = Core.session.getCurrentId();
      removeSessionTag(sid, tag);
      showSystemMsg('🏷 已移除标签: **' + tag + '**');
      return;
    }

    showSystemMsg('🏷 标签命令:\n/tags list — 列出所有标签\n/tags add <名称> — 为当前会话添加标签\n/tags remove <名称> — 移除标签');
  });
}

function showSystemMsg(text) {
  var currentId = Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(currentId);
  }
}

// ================================================================
//  Phase 3-5：命令面板 + 快捷键 + 会话内搜索
// ================================================================

// ===== 命令面板（Ctrl+K）=====
var _paletteOpen = false;
var _paletteEl = null;
var _paletteInput = null;
var _paletteResults = null;

function _buildCommandList() {
  var commands = [];
  // 从 Core.custom 获取已注册的命令
  if (Core.custom && Core.custom.commands) {
    for (var name in Core.custom.commands) {
      var cmd = Core.custom.commands[name];
      var displayName = name.startsWith('/') ? name : '/' + name;
      var rawDesc = cmd.desc || cmd.description || '';
      var resolvedDesc = (typeof rawDesc === 'object') ? (rawDesc.zh || rawDesc.en || '') : rawDesc;
      commands.push({ type: 'command', name: displayName, desc: resolvedDesc, action: function(n) { return function() { _executePaletteCommand(n.startsWith('/') ? n : '/' + n); }; }(displayName) });
    }
  }
  // 内置快捷命令
  var builtins = [
    { type: 'action', name: '新建对话', desc: '创建一个新的对话', action: function() { if (Core.session && Core.session.newChat) Core.session.newChat('chat'); } },
    { type: 'action', name: '切换主题', desc: '亮色/暗色主题切换', action: function() { if (Core.theme && Core.theme.toggle) Core.theme.toggle(); } },
    { type: 'action', name: '打开设置', desc: '打开设置面板', action: function() { var btn = document.getElementById('settingsBtn'); if (btn) btn.click(); } },
    { type: 'action', name: '清空当前对话', desc: '清除当前会话的所有消息', action: function() { if (Core.session && Core.session.clearMessages) Core.session.clearMessages(); } },
    { type: 'action', name: '导出对话', desc: '导出当前对话为文件', action: function() { if (Core.export && Core.export.exportJSON) Core.export.exportJSON(); } },
    { type: 'action', name: '切换 Agent 模式', desc: '开关 Agent 自主工具调用', action: function() { var btn = document.getElementById('agentModeBtn'); if (btn) btn.click(); } },
    { type: 'action', name: '切换自动朗读', desc: '开关 AI 回复自动朗读', action: function() { if (Core.voice && Core.voice.toggleAutoRead) Core.voice.toggleAutoRead(); } },
    { type: 'action', name: '停止朗读', desc: '停止当前语音朗读', action: function() { if (Core.voice && Core.voice.stopSpeaking) Core.voice.stopSpeaking(); } },
    { type: 'action', name: '停止生成', desc: '停止当前 AI 生成', action: function() { if (Core.api && Core.api.stopGeneration) Core.api.stopGeneration(); } },
  ];
  // 添加会话列表
  if (Core.session && Core.session.sessions) {
    for (var sid in Core.session.sessions) {
      var s = Core.session.sessions[sid];
      commands.push({ type: 'session', name: s.title || '未命名', desc: '切换到会话', action: function(id) { return function() { if (Core.session.switchSession) Core.session.switchSession(id); }; }(sid) });
    }
  }
  return commands.concat(builtins);
}

function _fuzzyMatch(query, text) {
  if (!query) return { match: true, score: 0 };
  query = query.toLowerCase();
  text = text.toLowerCase();
  // 精确包含
  if (text.indexOf(query) >= 0) return { match: true, score: 100 - text.indexOf(query) };
  // 模糊匹配
  var qi = 0;
  var score = 0;
  for (var ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) { qi++; score += 10; }
  }
  if (qi === query.length) return { match: true, score: score };
  return { match: false, score: 0 };
}

function _createPalette() {
  if (_paletteEl) return;
  _paletteEl = document.createElement('div');
  _paletteEl.id = 'command-palette';
  _paletteEl.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;background:rgba(0,0,0,0.5);align-items:flex-start;justify-content:center;padding-top:15vh;';
  _paletteEl.innerHTML = '<div style="width:500px;max-width:90vw;background:var(--bg-primary,#1a1a1a);border:1px solid var(--border-color,#333);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);overflow:hidden;">' +
    '<input id="palette-input" type="text" placeholder="搜索命令、会话..." style="width:100%;padding:14px 18px;font-size:15px;border:none;background:transparent;color:var(--text-primary,#eee);outline:none;border-bottom:1px solid var(--border-color,#333);" />' +
    '<div id="palette-results" style="max-height:400px;overflow-y:auto;padding:6px 0;"></div>' +
    '<div style="padding:8px 14px;font-size:11px;color:#888;border-top:1px solid var(--border-color,#333);">↑↓ 导航 · Enter 执行 · Esc 关闭</div>' +
    '</div>';
  document.body.appendChild(_paletteEl);

  _paletteInput = document.getElementById('palette-input');
  _paletteResults = document.getElementById('palette-results');

  // 输入事件
  _paletteInput.addEventListener('input', function() { _updatePaletteResults(_paletteInput.value); });
  // 键盘事件
  _paletteInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { _closePalette(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      _navigatePalette(e.key === 'ArrowDown' ? 1 : -1);
    }
    else if (e.key === 'Enter') {
      e.preventDefault();
      _executePaletteSelection();
    }
  });
  // 点击背景关闭
  _paletteEl.addEventListener('click', function(e) {
    if (e.target === _paletteEl) _closePalette();
  });
}

function _openPalette() {
  _createPalette();
  _paletteEl.style.display = 'flex';
  _paletteOpen = true;
  _paletteSelectedIdx = 0;
  _paletteInput.value = '';
  _paletteInput.focus();
  _updatePaletteResults('');
}

function _closePalette() {
  if (_paletteEl) _paletteEl.style.display = 'none';
  _paletteOpen = false;
  if (Core.dom && Core.dom.input) Core.dom.input.focus();
}

function _updatePaletteResults(query) {
  if (!_paletteResults) return;
  var commands = _buildCommandList();
  var filtered = commands.map(function(cmd) {
    var r1 = _fuzzyMatch(query, cmd.name);
    var r2 = _fuzzyMatch(query, cmd.desc);
    return { cmd: cmd, score: Math.max(r1.score, r2.score), match: r1.match || r2.match };
  }).filter(function(r) { return r.match; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, 15);

  _paletteResults.innerHTML = '';
  filtered.forEach(function(r, idx) {
    var item = document.createElement('div');
    item.className = 'palette-item' + (idx === 0 ? ' selected' : '');
    item.style.cssText = 'padding:10px 18px;cursor:pointer;display:flex;align-items:center;gap:10px;';
    item.dataset.idx = idx;
    var icon = r.cmd.type === 'command' ? '⚡' : (r.cmd.type === 'session' ? '💬' : '▶');
    var iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'font-size:16px;';
    iconSpan.textContent = icon;
    var wrapDiv = document.createElement('div');
    wrapDiv.style.cssText = 'flex:1;';
    var nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-size:14px;color:var(--text-primary,#eee);';
    nameDiv.textContent = r.cmd.name || '';
    var descDiv = document.createElement('div');
    descDiv.style.cssText = 'font-size:12px;color:#888;';
    descDiv.textContent = r.cmd.desc || '';
    wrapDiv.appendChild(nameDiv);
    wrapDiv.appendChild(descDiv);
    item.appendChild(iconSpan);
    item.appendChild(wrapDiv);
    item.addEventListener('click', function() { _closePalette(); r.cmd.action(); });
    item.addEventListener('mouseenter', function() {
      _paletteResults.querySelectorAll('.palette-item').forEach(function(el) { el.classList.remove('selected'); });
      item.classList.add('selected');
    });
    _paletteResults.appendChild(item);
  });

  // 注入 hover 样式
  if (!document.getElementById('palette-hover-style')) {
    var s = document.createElement('style');
    s.id = 'palette-hover-style';
    s.textContent = '.palette-item.selected{background:var(--primary-alpha,rgba(100,100,255,0.15));} .palette-item:hover{background:var(--primary-alpha,rgba(100,100,255,0.1));}';
    document.head.appendChild(s);
  }
}

var _paletteSelectedIdx = 0;

function _navigatePalette(dir) {
  var items = _paletteResults ? _paletteResults.querySelectorAll('.palette-item') : [];
  if (items.length === 0) return;
  items[_paletteSelectedIdx] && items[_paletteSelectedIdx].classList.remove('selected');
  _paletteSelectedIdx = Math.max(0, Math.min(items.length - 1, _paletteSelectedIdx + dir));
  items[_paletteSelectedIdx] && items[_paletteSelectedIdx].classList.add('selected');
  items[_paletteSelectedIdx] && items[_paletteSelectedIdx].scrollIntoView({ block: 'nearest' });
}

function _executePaletteSelection() {
  var items = _paletteResults ? _paletteResults.querySelectorAll('.palette-item') : [];
  if (items[_paletteSelectedIdx]) {
    items[_paletteSelectedIdx].click();
  }
}

function _executePaletteCommand(cmdText) {
  _closePalette();
  if (Core.dom && Core.dom.input) {
    Core.dom.input.value = cmdText;
    if (Core.session && Core.session.sendMessage) {
      Core.session.sendMessage(cmdText);
    }
  }
}

// ===== 快捷键系统（通过统一 keyboard 分发器）=====
function _registerKeyboardShortcuts() {
  if (!Core.keyboard) return;
  Core.keyboard.register('ux-enhance', 15, function(e) {
    // Ctrl+K / Cmd+K — 命令面板
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (_paletteOpen) _closePalette();
      else _openPalette();
      return false;
    }
    // Ctrl+F — 会话内搜索
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      _openConversationSearch();
      return false;
    }
    // Ctrl+N — 新建对话
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      if (Core.session && Core.session.newChat) Core.session.newChat('chat');
      return false;
    }
    // Ctrl+Shift+S — 停止生成
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      if (Core.api && Core.api.stopGeneration) Core.api.stopGeneration();
      return false;
    }
    // Ctrl+D — 切换深度思考
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      var btn = document.getElementById('deepThinkBtn');
      if (btn) btn.click();
      return false;
    }
    // Escape — 关闭命令面板 / 关闭搜索
    if (e.key === 'Escape') {
      if (_paletteOpen) { _closePalette(); return false; }
      if (_searchPanelOpen) { _closeConversationSearch(); return false; }
    }
  });
}

// ===== 会话内搜索（Ctrl+F）=====
var _searchPanelOpen = false;
var _searchPanel = null;

function _openConversationSearch() {
  if (_searchPanel) {
    _searchPanel.style.display = _searchPanel.style.display === 'none' ? 'flex' : 'none';
    _searchPanelOpen = _searchPanel.style.display === 'flex';
    if (_searchPanelOpen) {
      var input = _searchPanel.querySelector('input');
      if (input) { input.value = ''; input.focus(); }
    }
    return;
  }
  _searchPanel = document.createElement('div');
  _searchPanel.style.cssText = 'position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--bg-primary,#1a1a1a);border-bottom:1px solid var(--border-color,#333);';
  _searchPanel.innerHTML = '<input type="text" placeholder="搜索对话内容..." style="flex:1;padding:6px 12px;font-size:13px;border:1px solid var(--border-color,#333);border-radius:6px;background:var(--bg-secondary,#222);color:var(--text-primary,#eee);outline:none;" />' +
    '<span class="search-count" style="font-size:12px;color:#888;min-width:50px;"></span>' +
    '<button class="search-prev" style="padding:4px 8px;cursor:pointer;border:none;background:transparent;color:var(--text-primary,#eee);font-size:14px;">▲</button>' +
    '<button class="search-next" style="padding:4px 8px;cursor:pointer;border:none;background:transparent;color:var(--text-primary,#eee);font-size:14px;">▼</button>' +
    '<button class="search-close" style="padding:4px 8px;cursor:pointer;border:none;background:transparent;color:#888;font-size:16px;">✕</button>';

  var chatContainer = Core.dom.chatContainer;
  if (chatContainer) {
    chatContainer.insertBefore(_searchPanel, chatContainer.firstChild);
  }

  var input = _searchPanel.querySelector('input');
  var countEl = _searchPanel.querySelector('.search-count');
  var matches = [];
  var currentMatch = -1;

  function doSearch() {
    var query = input.value.trim();
    // 清除之前的高亮
    chatContainer.querySelectorAll('.search-highlight').forEach(function(el) {
      el.outerHTML = el.textContent;
    });
    matches = [];
    currentMatch = -1;
    if (!query) { countEl.textContent = ''; return; }

    var msgs = chatContainer.querySelectorAll('.msg');
    msgs.forEach(function(msg) {
      var text = msg.textContent || '';
      if (text.toLowerCase().indexOf(query.toLowerCase()) >= 0) {
        matches.push(msg);
      }
    });
    countEl.textContent = matches.length + ' 条';
    if (matches.length > 0) {
      currentMatch = 0;
      matches[0].style.outline = '2px solid var(--primary, #4f46e5)';
      matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  input.addEventListener('input', doSearch);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matches.length > 0) {
        if (currentMatch >= 0) matches[currentMatch].style.outline = '';
        currentMatch = (currentMatch + 1) % matches.length;
        matches[currentMatch].style.outline = '2px solid var(--primary, #4f46e5)';
        matches[currentMatch].scrollIntoView({ behavior: 'smooth', block: 'center' });
        countEl.textContent = (currentMatch + 1) + '/' + matches.length;
      }
    }
  });
  _searchPanel.querySelector('.search-prev').addEventListener('click', function() {
    if (matches.length > 0 && currentMatch >= 0) {
      matches[currentMatch].style.outline = '';
      currentMatch = (currentMatch - 1 + matches.length) % matches.length;
      matches[currentMatch].style.outline = '2px solid var(--primary, #4f46e5)';
      matches[currentMatch].scrollIntoView({ behavior: 'smooth', block: 'center' });
      countEl.textContent = (currentMatch + 1) + '/' + matches.length;
    }
  });
  _searchPanel.querySelector('.search-next').addEventListener('click', function() {
    if (matches.length > 0 && currentMatch >= 0) {
      matches[currentMatch].style.outline = '';
      currentMatch = (currentMatch + 1) % matches.length;
      matches[currentMatch].style.outline = '2px solid var(--primary, #4f46e5)';
      matches[currentMatch].scrollIntoView({ behavior: 'smooth', block: 'center' });
      countEl.textContent = (currentMatch + 1) + '/' + matches.length;
    }
  });
  _searchPanel.querySelector('.search-close').addEventListener('click', _closeConversationSearch);

  input.focus();
  _searchPanelOpen = true;
}

function _closeConversationSearch() {
  if (_searchPanel) _searchPanel.style.display = 'none';
  _searchPanelOpen = false;
  // 清除高亮
  if (Core.dom.chatContainer) {
    Core.dom.chatContainer.querySelectorAll('.msg').forEach(function(msg) {
      msg.style.outline = '';
    });
  }
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    console.warn('ux-enhance.js: fs/path not available');
    return;
  }

  loadBookmarks();
  loadTags();
  registerCommands();

  // Defer UI enhancements to after DOM ready
  setTimeout(function() {
    injectMessageActions();
    enhanceCodeBlocks();
    _registerKeyboardShortcuts();
  }, 1000);

  // Expose API
  Core.uxEnhance = {
    bookmarks: {
      toggle: toggleBookmark,
      isBookmarked: isBookmarked,
      list: listBookmarks,
      delete: deleteBookmark,
      navigate: navigateToBookmark
    },
    tags: {
      get: getSessionTags,
      set: setSessionTag,
      remove: removeSessionTag,
      all: getAllTags,
      sessionsByTag: getSessionsByTag
    }
  };

  console.log('✅ ux-enhance.js 已加载 (书签:' + bookmarks.length + ', 标签:' + Object.keys(sessionTags).length + ')');
}

exports.init = init;
exports.name = 'ux-enhance';
exports.dependencies = ['custom'];
