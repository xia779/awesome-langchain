// modules/notifications.js - 统一通知中心（Phase 6-2）
// 聚合 Toast / 桌面通知 / 内联通知 / 后台任务 / 系统事件
let Core = null;

var _notifications = [];
var _maxNotifications = 100;
var _unreadCount = 0;
var _panelVisible = false;
var _listeners = [];

var TYPES = {
  SYSTEM: 'system', TASK: 'task', ERROR: 'error',
  INFO: 'info', SUCCESS: 'success', WARNING: 'warning',
};

function init(_Core) {
  Core = _Core;

  Core.notifications = {
    push, pushSystem, pushTask, pushError, pushSuccess, pushWarning,
    getAll, getUnread, getUnreadCount, markRead, markAllRead, clear,
    togglePanel, TYPES, onNotification,
  };

  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/notifications', function(args) {
      return handleNotificationsCommand(args);
    }, '通知中心 — 查看/管理所有通知');
    Core.custom.registerCommand('/bell', function() {
      return handleNotificationsCommand('list');
    }, '通知铃铛 — 查看未读通知');
  }
  createNotificationPanel();
  addBellButton();
  hookIntoEvents();

  loadNotifications();
  console.log('✅ 统一通知中心已加载');
}

// ===== 推送通知 =====
function push(notification) {
  var n = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    type: notification.type || TYPES.INFO,
    title: notification.title || '',
    message: notification.message || '',
    timestamp: Date.now(),
    read: false,
    sessionId: notification.sessionId || null,
  };

  _notifications.unshift(n);
  if (_notifications.length > _maxNotifications) _notifications = _notifications.slice(0, _maxNotifications);
  _unreadCount++;

  showToast(n);
  if (n.type === TYPES.TASK || n.type === TYPES.ERROR || n.type === TYPES.WARNING) {
    showDesktopNotification(n);
  }
  updateBellBadge();
  _listeners.forEach(function(fn) { try { fn(n); } catch (e) {} });
  saveNotifications();
  return n;
}

function pushSystem(title, msg) { return push({ type: TYPES.SYSTEM, title: title, message: msg }); }
function pushTask(title, msg, sid) { return push({ type: TYPES.TASK, title: title, message: msg, sessionId: sid }); }
function pushError(title, msg) { return push({ type: TYPES.ERROR, title: title, message: msg }); }
function pushSuccess(title, msg) { return push({ type: TYPES.SUCCESS, title: title, message: msg }); }
function pushWarning(title, msg) { return push({ type: TYPES.WARNING, title: title, message: msg }); }

// ===== Toast =====
function showToast(n) {
  var existing = document.querySelectorAll('.notif-toast');
  if (existing.length >= 3) existing[0].remove();

  var toast = document.createElement('div');
  toast.className = 'notif-toast notif-toast-' + n.type;
  var icons = { system: '🔧', task: '✅', error: '❌', info: 'ℹ️', success: '✅', warning: '⚠️' };
  var colors = { system: '#3b82f6', task: '#22c55e', error: '#ef4444', info: '#3b82f6', success: '#22c55e', warning: '#f59e0b' };

  toast.innerHTML = '<div style="display:flex;align-items:center;gap:8px">' +
    '<span style="font-size:16px">' + (icons[n.type] || 'ℹ️') + '</span>' +
    '<div style="flex:1;min-width:0">' +
      '<div style="font-size:12px;font-weight:600;color:' + (colors[n.type] || '#3b82f6') + '">' + esc(n.title) + '</div>' +
      '<div style="font-size:11px;color:var(--text-secondary,#999);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(n.message) + '</div>' +
    '</div>' +
    '<button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;color:var(--text-muted,#666);cursor:pointer;font-size:14px;padding:2px">✕</button>' +
  '</div>';

  toast.style.cssText = 'position:fixed;top:' + (60 + existing.length * 60) + 'px;right:16px;width:280px;padding:10px 14px;' +
    'background:var(--bg-surface,#1a1a2e);border:1px solid var(--border,rgba(255,255,255,.06));' +
    'border-left:3px solid ' + (colors[n.type] || '#3b82f6') + ';' +
    'border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.3);z-index:10001;' +
    'animation:notifSlideIn .3s ease-out;font-size:13px';

  if (!document.getElementById('notif-toast-styles')) {
    var style = document.createElement('style');
    style.id = 'notif-toast-styles';
    style.textContent = '@keyframes notifSlideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}@keyframes notifSlideOut{from{opacity:1}to{opacity:0;transform:translateX(20px)}}';
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  setTimeout(function() {
    if (toast.parentElement) {
      toast.style.animation = 'notifSlideOut .3s ease-in forwards';
      setTimeout(function() { toast.remove(); }, 300);
    }
  }, 4000);
}

function showDesktopNotification(n) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(n.title, { body: n.message });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  } catch (e) {}
}

// ===== 通知面板 =====
function createNotificationPanel() {
  if (document.getElementById('notifPanel')) return;
  var panel = document.createElement('div');
  panel.id = 'notifPanel';
  panel.style.cssText = 'position:fixed;top:52px;right:0;width:340px;max-height:500px;' +
    'background:var(--bg-surface,#1a1a2e);border:1px solid var(--border,rgba(255,255,255,.06));' +
    'border-radius:0 0 0 14px;box-shadow:0 12px 48px rgba(0,0,0,.4);z-index:9999;' +
    'display:none;flex-direction:column;overflow:hidden';
  panel.innerHTML = '<div style="padding:14px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));display:flex;align-items:center;justify-content:space-between">' +
    '<span style="font-size:14px;font-weight:600">🔔 通知中心</span>' +
    '<div style="display:flex;gap:8px">' +
      '<button onclick="Core.notifications.markAllRead()" style="background:none;border:none;color:var(--accent,#3b82f6);cursor:pointer;font-size:11px">全部已读</button>' +
      '<button onclick="Core.notifications.clear()" style="background:none;border:none;color:var(--text-muted,#666);cursor:pointer;font-size:11px">清空</button>' +
    '</div></div>' +
    '<div id="notifList" style="flex:1;overflow-y:auto;padding:4px 0"></div>';
  document.body.appendChild(panel);
}

function renderNotificationList() {
  var list = document.getElementById('notifList');
  if (!list) return;
  if (_notifications.length === 0) {
    list.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-muted,#666);font-size:13px">🔔 暂无通知</div>';
    return;
  }
  var icons = { system: '🔧', task: '✅', error: '❌', info: 'ℹ️', success: '✅', warning: '⚠️' };
  list.innerHTML = _notifications.slice(0, 30).map(function(n) {
    var unread = n.read ? '' : '<span style="width:6px;height:6px;border-radius:50%;background:var(--accent);flex-shrink:0"></span>';
    return '<div style="padding:10px 16px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;border-bottom:1px solid var(--border,rgba(255,255,255,.03));opacity:' + (n.read ? '0.6' : '1') + '" ' +
      'onmouseover="this.style.background=\'var(--bg-hover,rgba(255,255,255,.04))\'" ' +
      'onmouseout="this.style.background=\'\'" ' +
      'onclick="Core.notifications.markRead(\'' + n.id + '\')">' +
      '<span style="font-size:16px;flex-shrink:0">' + (icons[n.type] || 'ℹ️') + '</span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:500">' + esc(n.title) + '</div>' +
        '<div style="font-size:11px;color:var(--text-secondary,#999);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(n.message) + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted,#666);margin-top:4px">' + formatTimeAgo(n.timestamp) + '</div>' +
      '</div>' + unread + '</div>';
  }).join('');
}

function togglePanel() {
  var panel = document.getElementById('notifPanel');
  if (!panel) return;
  _panelVisible = !_panelVisible;
  panel.style.display = _panelVisible ? 'flex' : 'none';
  if (_panelVisible) {
    renderNotificationList();
    setTimeout(function() { document.addEventListener('click', closePanelOutside, { once: true }); }, 10);
  }
}

function closePanelOutside(e) {
  var panel = document.getElementById('notifPanel');
  var bell = document.getElementById('notifBellBtn');
  if (panel && !panel.contains(e.target) && (!bell || !bell.contains(e.target))) {
    _panelVisible = false;
    panel.style.display = 'none';
  }
}

// ===== 铃铛 =====
function addBellButton() {
  if (document.getElementById('notifBellBtn')) return;
  var topbar = document.querySelector('.topbar, .header-bar');
  if (!topbar) return;
  var btn = document.createElement('button');
  btn.id = 'notifBellBtn';
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
    '<span id="notifBadge" style="display:none;position:absolute;top:2px;right:2px;min-width:14px;height:14px;border-radius:7px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;text-align:center;line-height:14px;padding:0 3px"></span>';
  btn.style.cssText = 'width:36px;height:36px;border-radius:10px;border:none;background:transparent;color:var(--text-secondary,#999);cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative';
  btn.title = '通知中心';
  btn.onclick = function(e) { e.stopPropagation(); togglePanel(); };
  var settingsBtn = topbar.querySelector('.btn-settings, [onclick*="toggleSettings"]');
  if (settingsBtn) topbar.insertBefore(btn, settingsBtn); else topbar.appendChild(btn);
  updateBellBadge();
}

function updateBellBadge() {
  var badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (_unreadCount > 0) { badge.style.display = 'block'; badge.textContent = _unreadCount > 99 ? '99+' : String(_unreadCount); }
  else badge.style.display = 'none';
}

// ===== CRUD =====
function getAll() { return _notifications.slice(); }
function getUnread() { return _notifications.filter(function(n) { return !n.read; }); }
function getUnreadCount() { return _unreadCount; }
function markRead(id) {
  var n = _notifications.find(function(x) { return x.id === id; });
  if (n && !n.read) { n.read = true; _unreadCount = Math.max(0, _unreadCount - 1); updateBellBadge(); renderNotificationList(); saveNotifications(); }
}
function markAllRead() { _notifications.forEach(function(n) { n.read = true; }); _unreadCount = 0; updateBellBadge(); renderNotificationList(); saveNotifications(); }
function clear() { _notifications = []; _unreadCount = 0; updateBellBadge(); renderNotificationList(); saveNotifications(); }

// ===== 事件钩子 =====
function hookIntoEvents() {
  var _bgTaskPollTimer = setInterval(function() {
    if (Core.api && Core.api.getBackgroundTasks) {
      var tasks = Core.api.getBackgroundTasks();
      tasks.forEach(function(t) {
        if (t.status === 'done' && !t._notified) { t._notified = true; pushTask('后台任务完成', '会话任务已完成', t.sessionId); }
        else if (t.status === 'error' && !t._notified) { t._notified = true; pushError('后台任务失败', '会话任务执行出错', t.sessionId); }
      });
    }
  }, 5000);
}

function onNotification(fn) { if (typeof fn === 'function') _listeners.push(fn); }

// ===== 持久化 =====
var _notifSaveTimer = null;
function saveNotifications() {
  // 🔧 防抖 + 异步写入：避免 writeFileSync 阻塞 renderer 主线程
  if (_notifSaveTimer) clearTimeout(_notifSaveTimer);
  _notifSaveTimer = setTimeout(function() {
    _notifSaveTimer = null;
    try {
      var data = _notifications.slice(0, 50).map(function(n) { return { id: n.id, type: n.type, title: n.title, message: n.message, timestamp: n.timestamp, read: n.read }; });
      var fs = require('fs'), path = require('path');
      fs.promises.writeFile(path.join(Core.DATA_ROOT, 'notifications.json'), JSON.stringify(data), 'utf8').catch(function() {});
    } catch (e) {}
  }, 500);
}
function loadNotifications() {
  try {
    var fs = require('fs'), path = require('path');
    var fp = path.join(Core.DATA_ROOT, 'notifications.json');
    if (fs.existsSync(fp)) { var data = JSON.parse(fs.readFileSync(fp, 'utf8')); if (Array.isArray(data)) { _notifications = data; _unreadCount = data.filter(function(n) { return !n.read; }).length; } }
  } catch (e) {}
}

// ===== 命令 =====
function handleNotificationsCommand(args) {
  var sub = (args || '').trim();
  if (sub === 'list' || sub === '') {
    var unread = getUnread();
    if (unread.length === 0) return '🔔 没有未读通知\n共 ' + _notifications.length + ' 条历史通知';
    var lines = ['🔔 未读通知 (' + unread.length + ')\n'];
    var icons = { system: '🔧', task: '✅', error: '❌', info: 'ℹ️', success: '✅', warning: '⚠️' };
    unread.slice(0, 10).forEach(function(n, i) {
      lines.push((i + 1) + '. ' + (icons[n.type] || 'ℹ️') + ' **' + n.title + '** — ' + n.message + ' _' + formatTimeAgo(n.timestamp) + '_');
    });
    if (unread.length > 10) lines.push('\n... 还有 ' + (unread.length - 10) + ' 条');
    lines.push('\n💡 点击顶栏 🔔 按钮查看完整列表');
    return lines.join('\n');
  }
  if (sub === 'clear') { clear(); return '✅ 通知已清空'; }
  if (sub === 'read') { markAllRead(); return '✅ 全部标记为已读'; }
  return '🔔 通知中心\n\n/notifications — 查看未读\n/notifications clear — 清空\n/notifications read — 全部已读';
}

// ===== 工具 =====
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function formatTimeAgo(ts) {
  var diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

module.exports = { init };
