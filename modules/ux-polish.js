// modules/ux-polish.js - 体验微交互增强
// 骨架屏、空状态、过渡动画、状态指示器、快捷键速查、消息反应、智能滚动、Toast 反馈

let Core = null;

// ===== 状态 =====
var polishState = {
  initialized: false,
  userScrolledUp: false,
  lastScrollTop: 0,
  autoScrollEnabled: true,
  reactions: {},  // { messageId: ['emoji1', 'emoji2'] }
  cheatsheetVisible: false,
};

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;

  // 注册命令
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/polish', handlePolishCommand, '微交互：/polish [reactions|shortcuts|status|scroll]');
  }

  // 挂载 API
  Core.uxPolish = {
    showToast: showToast,
    showSkeleton: showSkeleton,
    hideSkeleton: hideSkeleton,
    showEmptyState: showEmptyState,
    hideEmptyState: hideEmptyState,
    toggleReaction: toggleReaction,
    getReactions: getReactions,
    toggleCheatsheet: toggleCheatsheet,
    flashCopy: flashCopy,
    setStatusIndicator: setStatusIndicator,
    scrollToBottom: smartScrollToBottom,
    injectStyles: injectPolishStyles,
    enableAutoScroll: function() { polishState.autoScrollEnabled = true; },
    disableAutoScroll: function() { polishState.autoScrollEnabled = false; },
  };

  // DOM 就绪后注入样式和行为
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPolish);
  } else {
    setTimeout(setupPolish, 200);
  }

  console.log('✨ 体验微交互模块已加载');
}

// ===== 注入 CSS 样式 =====
function injectPolishStyles() {
  if (document.getElementById('uxPolishStyles')) return;

  var style = document.createElement('style');
  style.id = 'uxPolishStyles';
  style.textContent = [
    // 骨架屏动画
    '@keyframes skeleton-pulse {',
    '  0% { opacity: 0.4; }',
    '  50% { opacity: 0.8; }',
    '  100% { opacity: 0.4; }',
    '}',
    '.skeleton-line {',
    '  height: 12px; border-radius: 6px; margin: 8px 0;',
    '  background: linear-gradient(90deg, var(--bg-tertiary,#2a2a3a) 25%, var(--bg-secondary,#1e1e2e) 50%, var(--bg-tertiary,#2a2a3a) 75%);',
    '  background-size: 200% 100%;',
    '  animation: skeleton-pulse 1.5s ease-in-out infinite;',
    '}',
    '.skeleton-line:nth-child(1) { width: 80%; }',
    '.skeleton-line:nth-child(2) { width: 60%; animation-delay: 0.2s; }',
    '.skeleton-line:nth-child(3) { width: 70%; animation-delay: 0.4s; }',

    // 消息入场动画
    '@keyframes msg-fade-in {',
    '  from { opacity: 0; transform: translateY(8px); }',
    '  to { opacity: 1; transform: translateY(0); }',
    '}',
    '.msg-polish-enter {',
    '  animation: msg-fade-in 0.3s ease-out;',
    '}',

    // 复制闪烁
    '@keyframes copy-flash {',
    '  0% { background: transparent; }',
    '  30% { background: rgba(59,130,246,0.2); }',
    '  100% { background: transparent; }',
    '}',
    '.copy-flash { animation: copy-flash 0.6s ease-out; }',

    // 空状态
    '.empty-state {',
    '  display: flex; flex-direction: column; align-items: center; justify-content: center;',
    '  padding: 40px 20px; opacity: 0.6; text-align: center;',
    '}',
    '.empty-state .empty-icon { font-size: 48px; margin-bottom: 16px; }',
    '.empty-state .empty-title { font-size: 16px; font-weight: 500; margin-bottom: 8px; }',
    '.empty-state .empty-desc { font-size: 13px; opacity: 0.7; max-width: 300px; }',
    '.empty-state .empty-actions { margin-top: 16px; display: flex; gap: 8px; }',

    // 状态指示器
    '.status-indicator {',
    '  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px;',
    '  border-radius: 10px; background: var(--bg-tertiary,#2a2a3a);',
    '}',
    '.status-dot {',
    '  width: 6px; height: 6px; border-radius: 50%;',
    '}',
    '.status-dot.online { background: #10b981; }',
    '.status-dot.offline { background: #ef4444; }',
    '.status-dot.busy { background: #f59e0b; }',

    // 快捷键速查遮罩
    '.cheatsheet-overlay {',
    '  position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999;',
    '  display: flex; align-items: center; justify-content: center;',
    '  animation: msg-fade-in 0.2s ease-out;',
    '}',
    '.cheatsheet-panel {',
    '  background: var(--bg-secondary,#1e1e2e); border: 1px solid var(--border-color,#444);',
    '  border-radius: 12px; padding: 24px; max-width: 500px; width: 90%;',
    '  max-height: 70vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.4);',
    '}',
    '.cheatsheet-row {',
    '  display: flex; justify-content: space-between; align-items: center;',
    '  padding: 6px 0; border-bottom: 1px solid var(--border-color,#333);',
    '}',
    '.cheatsheet-key {',
    '  display: inline-block; padding: 2px 8px; border-radius: 4px; font-family: monospace;',
    '  font-size: 12px; background: var(--bg-tertiary,#2a2a3a); border: 1px solid var(--border-color,#555);',
    '  min-width: 24px; text-align: center;',
    '}',

    // 消息反应
    '.reaction-bar {',
    '  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;',
    '}',
    '.reaction-chip {',
    '  display: inline-flex; align-items: center; gap: 2px; padding: 1px 6px;',
    '  border-radius: 10px; font-size: 12px; cursor: pointer;',
    '  background: var(--bg-tertiary,#2a2a3a); border: 1px solid var(--border-color,#444);',
    '  transition: background 0.2s;',
    '}',
    '.reaction-chip:hover { background: var(--bg-primary,#181825); }',
    '.reaction-chip.active { border-color: #3b82f6; background: rgba(59,130,246,0.1); }',

    // 🔧 滚动按钮由 styles.css + core-v10.js 统一管理，此处不再注入冲突样式

    // 面板过渡
    '.panel-transition {',
    '  transition: transform 0.3s ease, opacity 0.3s ease;',
    '}',
  ].join('\n');

  document.head.appendChild(style);
}

// ===== 设置交互行为 =====
function setupPolish() {
  injectPolishStyles();

  // 智能滚动
  setupSmartScroll();

  // 消息入场动画（MutationObserver）
  setupMessageAnimation();

  // 快捷键增强
  setupKeyboardShortcuts();

  // 空状态检测
  checkEmptyState();

  // 复制反馈
  setupCopyFeedback();

  polishState.initialized = true;
}

// ===== 骨架屏 =====
function showSkeleton(containerId, lines) {
  lines = lines || 3;
  var container = document.getElementById(containerId);
  if (!container) return;

  var skeleton = document.createElement('div');
  skeleton.className = 'skeleton-container';
  skeleton.id = containerId + '-skeleton';
  for (var i = 0; i < lines; i++) {
    var line = document.createElement('div');
    line.className = 'skeleton-line';
    skeleton.appendChild(line);
  }
  container.appendChild(skeleton);
}

function hideSkeleton(containerId) {
  var skeleton = document.getElementById(containerId + '-skeleton');
  if (skeleton) {
    skeleton.style.opacity = '0';
    setTimeout(function() { skeleton.remove(); }, 300);
  }
}

// ===== 空状态 =====
function showEmptyState(containerId, options) {
  var opts = options || {};
  var container = document.getElementById(containerId);
  if (!container) return;

  hideEmptyState(containerId);

  var empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.id = containerId + '-empty';

  var icon = opts.icon || '💭';
  var title = opts.title || '暂无内容';
  var desc = opts.desc || '开始一次新对话吧';
  var actions = opts.actions || [];

  empty.innerHTML = '<div class="empty-icon">' + icon + '</div>' +
    '<div class="empty-title">' + title + '</div>' +
    '<div class="empty-desc">' + desc + '</div>';

  if (actions.length > 0) {
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'empty-actions';
    actions.forEach(function(action) {
      var btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'padding:6px 16px;border-radius:6px;border:1px solid var(--border-color,#444);' +
        'background:var(--bg-tertiary,#2a2a3a);color:var(--text-primary,#eee);cursor:pointer;font-size:13px;';
      btn.onclick = action.handler;
      actionsDiv.appendChild(btn);
    });
    empty.appendChild(actionsDiv);
  }

  container.appendChild(empty);
}

function hideEmptyState(containerId) {
  var empty = document.getElementById(containerId + '-empty');
  if (empty) empty.remove();
}

function checkEmptyState() {
  var chatContainer = document.getElementById('chatContainer');
  if (!chatContainer) return;

  if (chatContainer.children.length === 0) {
    showEmptyState('chatContainer', {
      icon: '💭',
      title: '开始新的对话',
      desc: '输入消息或使用 /help 查看所有命令',
      actions: [
        { label: '📝 新对话', handler: function() { if (Core.session) Core.session.newChat(); } },
        { label: '❓ 帮助', handler: function() { if (Core.custom) Core.custom.executeCommand('/help'); } }
      ]
    });
  } else {
    hideEmptyState('chatContainer');
  }
}

// ===== Toast：委托给 Core.showToast =====
function showToast(message, type, duration) {
  if (Core && Core.showToast) Core.showToast(message, type || 'info', duration || 2500);
}

// ===== 智能滚动 =====
function setupSmartScroll() {
  var chatContainer = document.getElementById('chatContainer');
  if (!chatContainer) return;

  // 检测用户是否向上滚动（rAF 节流，防止滚动卡顿）
  var _scrollRafId = 0;
  chatContainer.addEventListener('scroll', function() {
    if (_scrollRafId) return;
    _scrollRafId = requestAnimationFrame(function() {
      _scrollRafId = 0;
      var scrollTop = chatContainer.scrollTop;
      var scrollHeight = chatContainer.scrollHeight;
      var clientHeight = chatContainer.clientHeight;
      var distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      // 检测用户是否向上滚动（按钮由 core-v10.js 统一管理）
      polishState.userScrolledUp = distanceFromBottom > 100;
      polishState.lastScrollTop = scrollTop;
    });
  }, { passive: true });
}

function createScrollToBottomBtn() {
  // 按钮已在 index.html 中静态定义，由 core-v10.js 管理显隐，此处不再动态创建
  var existing = document.getElementById('scrollToBottomBtn');
  if (existing) existing.style.opacity = '1';
}

function smartScrollToBottom(force) {
  if (!force && polishState.userScrolledUp) return;

  var chatContainer = document.getElementById('chatContainer');
  if (!chatContainer) return;

  chatContainer.scrollTo({
    top: chatContainer.scrollHeight,
    behavior: 'smooth'
  });
  polishState.userScrolledUp = false;
}

// ===== 消息入场动画 =====
// 入场动画由 styles.css .msg { animation: messageIn 0.25s ease } 处理
// 此处仅处理空状态隐藏
function setupMessageAnimation() {
  if (!Core.chatObserver) return;
  Core.chatObserver.onMessage(function(node) {
    hideEmptyState('chatContainer');
  });
}

// ===== 快捷键增强（通过统一 keyboard 分发器）=====
function setupKeyboardShortcuts() {
  if (!Core.keyboard) return;
  Core.keyboard.register('ux-polish', 20, function(e) {
    // ? 键显示快捷键速查（不在输入框中时）
    if (e.key === '?' && !isInputFocused()) {
      e.preventDefault();
      toggleCheatsheet();
      return false;
    }
    // Escape 关闭速查
    if (e.key === 'Escape' && polishState.cheatsheetVisible) {
      e.preventDefault();
      toggleCheatsheet();
      return false;
    }
    // Ctrl+Shift+C 复制最后一条助手消息
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      e.preventDefault();
      copyLastAssistantMessage();
      return false;
    }
    // Ctrl+Shift+N 新对话
    if (e.ctrlKey && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      if (Core.session) Core.session.newChat();
      return false;
    }
    // Ctrl+. 切换上下文面板
    if (e.ctrlKey && e.key === '.') {
      e.preventDefault();
      if (Core.contextPanel) Core.contextPanel.toggle();
      return false;
    }
    // Ctrl+Shift+K 切换上下文面板（备选）
    if (e.ctrlKey && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      if (Core.contextPanel) Core.contextPanel.toggle();
      return false;
    }
  });
}

function isInputFocused() {
  var el = document.activeElement;
  if (!el) return false;
  var tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// ===== 快捷键速查遮罩 =====
function toggleCheatsheet() {
  polishState.cheatsheetVisible = !polishState.cheatsheetVisible;

  var existing = document.getElementById('cheatsheetOverlay');
  if (existing) { existing.remove(); }

  if (!polishState.cheatsheetVisible) return;

  var overlay = document.createElement('div');
  overlay.id = 'cheatsheetOverlay';
  overlay.className = 'cheatsheet-overlay';
  overlay.onclick = function(e) {
    if (e.target === overlay) toggleCheatsheet();
  };

  var shortcuts = [
    { keys: ['Enter'], desc: '发送消息' },
    { keys: ['Ctrl', 'Enter'], desc: '发送消息（备选）' },
    { keys: ['Shift', 'Enter'], desc: '换行' },
    { keys: ['Ctrl', 'N'], desc: '新对话' },
    { keys: ['Ctrl', 'Shift', 'N'], desc: '新对话（备选）' },
    { keys: ['Ctrl', 'K'], desc: '命令面板' },
    { keys: ['Ctrl', '/'], desc: '搜索会话' },
    { keys: ['Ctrl', 'Shift', 'C'], desc: '复制最后一条回复' },
    { keys: ['Ctrl', '.'], desc: '切换上下文面板' },
    { keys: ['Ctrl', 'D'], desc: '切换深色主题' },
    { keys: ['F11'], desc: '全屏' },
    { keys: ['Escape'], desc: '停止生成 / 关闭面板' },
    { keys: ['?'], desc: '显示/隐藏此快捷键列表' },
  ];

  // Agent 模式快捷键
  if (Core.agent) {
    shortcuts.push(
      { keys: [], desc: '', section: 'Agent 模式' },
      { keys: ['Ctrl', 'Shift', 'A'], desc: '切换 Agent 模式' }
    );
  }

  var panel = document.createElement('div');
  panel.className = 'cheatsheet-panel';

  var title = '<div style="font-size:16px;font-weight:600;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">' +
    '⌨️ 快捷键速查' +
    '<span style="cursor:pointer;opacity:0.6;font-size:14px;" onclick="Core.uxPolish.toggleCheatsheet && document.getElementById(\'cheatsheetOverlay\').remove()">✕</span></div>';

  var rows = '';
  shortcuts.forEach(function(s) {
    if (s.section) {
      rows += '<div style="margin-top:12px;font-size:12px;font-weight:600;color:var(--accent,#3b82f6);">' + s.section + '</div>';
      return;
    }
    var keysHtml = s.keys.map(function(k) {
      return '<span class="cheatsheet-key">' + k + '</span>';
    }).join(' + ');
    rows += '<div class="cheatsheet-row"><span style="font-size:13px;">' + s.desc + '</span><span>' + keysHtml + '</span></div>';
  });

  // 斜杠命令
  rows += '<div style="margin-top:16px;font-size:12px;font-weight:600;color:var(--accent,#3b82f6);">常用命令</div>';
  var cmds = [
    ['/help', '查看所有命令'],
    ['/dashboard', '系统总览'],
    ['/context', '上下文面板'],
    ['/tag list', '标签管理'],
    ['/stats', '使用统计'],
    ['/theme', '主题切换'],
    ['/health', '健康检查'],
  ];
  cmds.forEach(function(c) {
    rows += '<div class="cheatsheet-row"><span style="font-size:13px;">' + c[1] + '</span>' +
      '<span class="cheatsheet-key" style="min-width:auto;">' + c[0] + '</span></div>';
  });

  panel.innerHTML = title + rows;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

// ===== 复制反馈 =====
function setupCopyFeedback() {
  document.addEventListener('copy', function(e) {
    // 找到当前选中的消息元素
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    var node = selection.anchorNode;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('msg')) {
        flashCopy(node);
        break;
      }
      node = node.parentNode;
    }
  });
}

function flashCopy(element) {
  if (!element) return;
  element.classList.add('copy-flash');
  showToast('已复制到剪贴板', 'success', 1500);
  setTimeout(function() { element.classList.remove('copy-flash'); }, 600);
}

function copyLastAssistantMessage() {
  var msgs = document.querySelectorAll('.msg.assistant');
  if (msgs.length === 0) { showToast('没有可复制的消息', 'info'); return; }

  var lastMsg = msgs[msgs.length - 1];
  var content = lastMsg.querySelector('.msg-content');
  var text = content ? content.innerText : lastMsg.innerText;

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      showToast('已复制最后一条回复', 'success');
      flashCopy(lastMsg);
    });
  }
}

// ===== 消息反应 =====
function toggleReaction(messageId, emoji) {
  if (!polishState.reactions[messageId]) polishState.reactions[messageId] = [];
  var arr = polishState.reactions[messageId];
  var idx = arr.indexOf(emoji);
  if (idx !== -1) {
    arr.splice(idx, 1);
  } else {
    arr.push(emoji);
  }
  if (arr.length === 0) delete polishState.reactions[messageId];
  renderReactions(messageId);
}

function getReactions(messageId) {
  return polishState.reactions[messageId] || [];
}

function renderReactions(messageId) {
  var msgEl = document.querySelector('[data-msg-id="' + messageId + '"]');
  if (!msgEl) return;

  var existing = msgEl.querySelector('.reaction-bar');
  if (existing) existing.remove();

  var reactions = polishState.reactions[messageId];
  if (!reactions || reactions.length === 0) return;

  var bar = document.createElement('div');
  bar.className = 'reaction-bar';
  reactions.forEach(function(emoji) {
    var chip = document.createElement('span');
    chip.className = 'reaction-chip active';
    chip.textContent = emoji;
    chip.onclick = function() { toggleReaction(messageId, emoji); };
    bar.appendChild(chip);
  });

  msgEl.appendChild(bar);
}

// ===== 状态指示器 =====
function setStatusIndicator(status, text) {
  // status: 'online' | 'offline' | 'busy'
  var existing = document.getElementById('statusIndicator');

  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'statusIndicator';
    existing.className = 'status-indicator';

    // 尝试插入到顶部栏
    var topbar = document.querySelector('.topbar') || document.querySelector('.header');
    if (topbar) {
      topbar.appendChild(existing);
    } else {
      existing.style.cssText += 'position:fixed;top:8px;right:60px;';
      document.body.appendChild(existing);
    }
  }

  var dotClass = 'status-dot ' + (status || 'offline');
  existing.innerHTML = '<span class="' + dotClass + '"></span><span>' + (text || status || 'unknown') + '</span>';
}

// ===== 命令处理 =====
function handlePolishCommand(input) {
  var parts = input.trim().split(/\s+/);
  var sub = (parts[1] || '').toLowerCase();

  switch (sub) {
    case 'toast':
      var msg = parts.slice(2).join(' ') || '测试通知';
      showToast(msg, 'info');
      return '✅ Toast 已显示';

    case 'shortcuts':
    case 'keys':
      toggleCheatsheet();
      return '⌨️ 快捷键速查已' + (polishState.cheatsheetVisible ? '打开' : '关闭');

    case 'scroll':
      smartScrollToBottom(true);
      return '⬇️ 已滚动到底部';

    case 'empty':
      checkEmptyState();
      return '🔍 空状态检测完成';

    case 'status':
      var online = navigator.onLine;
      var statusText = online ? '在线' : '离线';
      setStatusIndicator(online ? 'online' : 'offline', statusText);
      return '📡 网络状态: ' + statusText;

    case 'reaction':
    case 'react':
      var emoji = parts[2] || '👍';
      showToast('反应功能: 在消息上悬停可见操作按钮', 'info');
      return '✨ 消息反应: ' + emoji;

    case 'skeleton':
      showSkeleton('chatContainer', 3);
      setTimeout(function() { hideSkeleton('chatContainer'); }, 3000);
      return '💀 骨架屏已显示（3秒后消失）';

    default:
      return '✨ 微交互命令:\n' +
        '  /polish toast <消息>  — 显示 Toast 通知\n' +
        '  /polish shortcuts     — 快捷键速查表\n' +
        '  /polish scroll        — 滚动到底部\n' +
        '  /polish status        — 显示网络状态\n' +
        '  /polish skeleton      — 显示骨架屏\n' +
        '  /polish empty         — 检测空状态\n' +
        '  /polish reaction <emoji> — 消息反应\n\n' +
        '提示: 按 ? 键可随时打开快捷键速查表';
  }
}

module.exports = { name: 'ux-polish', dependencies: ['custom'], init };
