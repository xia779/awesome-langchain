// ============================================================
// quick-panel.js — 侧边栏快捷功能面板
// 在侧边栏顶部添加「快捷功能」导航（定时任务 / 技能 / 设备·网关），
// 点击后右侧滑出对应管理面板，无需再敲 / 命令。
// 依赖: custom(命令注册) / session(系统消息)。scheduler/skill/gateway 懒加载访问。
// ============================================================

var Core = null;
var currentView = null;   // 'schedule' | 'skills' | 'devices'
var drawerEl = null;
var backdropEl = null;
var bodyEl = null;
var titleEl = null;

var VIEW_TITLES = {
  schedule: '定时任务',
  skills: '技能',
  devices: '设备 · 网关'
};

// ===== HTML 转义（用户数据防注入） =====
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getLocalIP() {
  try {
    var os = require('os');
    var ifaces = os.networkInterfaces();
    for (var name in ifaces) {
      for (var i = 0; i < ifaces[name].length; i++) {
        var f = ifaces[name][i];
        if (f.family === 'IPv4' && !f.internal) return f.address;
      }
    }
  } catch (e) { /* ignore */ }
  return '127.0.0.1';
}

function timeAgo(ts) {
  if (!ts) return '从未';
  var diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ===== 注入样式 =====
function injectStyles() {
  if (document.getElementById('quick-panel-styles')) return;
  var style = document.createElement('style');
  style.id = 'quick-panel-styles';
  style.textContent = [
    '/* ---- 快捷功能导航 ---- */',
    '.qp-nav{padding:8px 12px 6px;border-bottom:1px solid var(--border);}',
    '.qp-nav-title{font-size:11px;color:var(--text-secondary);padding:4px 8px;letter-spacing:.5px;}',
    '.qp-nav-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;cursor:pointer;color:var(--text);font-size:13.5px;transition:background .15s;user-select:none;}',
    '.qp-nav-item:hover{background:var(--primary-light);}',
    '.qp-nav-item .material-icons-outlined{font-size:18px;color:var(--text-secondary);transition:color .15s;}',
    '.qp-nav-item:hover .material-icons-outlined{color:var(--primary);}',
    '.qp-badge{margin-left:auto;background:var(--primary);color:#fff;font-size:10px;border-radius:9px;padding:1px 7px;min-width:16px;text-align:center;}',
    '.qp-badge:empty{display:none;}',
    '.qp-dot{margin-left:auto;width:8px;height:8px;border-radius:50%;background:#4b5563;transition:.2s;}',
    '.qp-dot.on{background:var(--success);box-shadow:0 0 6px var(--success);}',
    '/* ---- 抽屉面板 ---- */',
    '.qp-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);opacity:0;visibility:hidden;transition:.25s;z-index:998;}',
    '.qp-backdrop.show{opacity:1;visibility:visible;}',
    '.qp-drawer{position:fixed;top:0;right:0;width:400px;max-width:92vw;height:100vh;background:var(--panel);border-left:1px solid var(--border);box-shadow:var(--shadow-lg);transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1);z-index:999;display:flex;flex-direction:column;}',
    '.qp-drawer.show{transform:translateX(0);}',
    '.qp-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);}',
    '.qp-drawer-title{font-size:16px;font-weight:600;color:var(--text);}',
    '.qp-icon-btn{background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:6px;border-radius:8px;display:flex;}',
    '.qp-icon-btn:hover{background:var(--bg-secondary);color:var(--text);}',
    '.qp-drawer-body{flex:1;overflow-y:auto;padding:16px 20px;}',
    '/* ---- 统计卡 ---- */',
    '.qp-stats{display:flex;gap:10px;margin-bottom:14px;}',
    '.qp-stat{flex:1;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:10px 12px;text-align:center;}',
    '.qp-stat b{display:block;font-size:18px;color:var(--primary);}',
    '.qp-stat span{font-size:11px;color:var(--text-secondary);}',
    '/* ---- 内容卡片 ---- */',
    '.qp-card{background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px;transition:border-color .15s;}',
    '.qp-card:hover{border-color:var(--primary);}',
    '.qp-card-top{display:flex;align-items:center;gap:10px;}',
    '.qp-card-name{font-size:14px;font-weight:600;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.qp-card-desc{font-size:12px;color:var(--text-secondary);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.qp-card-meta{font-size:11px;color:var(--text-secondary);margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 12px;}',
    '.qp-card-actions{display:flex;gap:8px;margin-top:10px;}',
    '.qp-btn{border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text);font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;transition:.15s;}',
    '.qp-btn:hover{border-color:var(--primary);color:var(--primary);}',
    '.qp-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff;}',
    '.qp-btn.primary:hover{background:var(--primary-hover);color:#fff;}',
    '.qp-btn.danger:hover{border-color:var(--danger);color:var(--danger);}',
    '.qp-chip{display:inline-block;background:var(--primary-light);color:var(--accent-light);font-size:10.5px;padding:2px 8px;border-radius:8px;}',
    '.qp-src{font-size:10px;padding:2px 7px;border-radius:7px;background:var(--bg-tertiary);color:var(--text-secondary);border:1px solid var(--border);flex-shrink:0;}',
    '/* ---- 开关 ---- */',
    '.qp-switch{position:relative;width:36px;height:20px;flex-shrink:0;}',
    '.qp-switch input{opacity:0;width:0;height:0;}',
    '.qp-slider{position:absolute;inset:0;background:#4b5563;border-radius:20px;transition:.2s;cursor:pointer;}',
    '.qp-slider:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;background:#fff;border-radius:50%;transition:.2s;}',
    '.qp-switch input:checked+.qp-slider{background:var(--success);}',
    '.qp-switch input:checked+.qp-slider:before{transform:translateX(16px);}',
    '/* ---- 状态点 ---- */',
    '.qp-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;}',
    '.qp-status i{width:7px;height:7px;border-radius:50%;display:inline-block;}',
    '.qp-status.on i{background:var(--success);}',
    '.qp-status.off i{background:#6b7280;}',
    '/* ---- 其他 ---- */',
    '.qp-empty{text-align:center;color:var(--text-secondary);padding:40px 0;font-size:13px;}',
    '.qp-empty .material-icons-outlined{font-size:40px;display:block;margin-bottom:10px;opacity:.4;}',
    '.qp-hint{font-size:11.5px;color:var(--text-secondary);background:var(--bg-secondary);border:1px dashed var(--border);border-radius:10px;padding:10px 12px;margin-top:14px;line-height:1.6;}',
    '.qp-conn{background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:8px;}',
    '.qp-conn code{flex:1;font-size:11.5px;color:var(--accent-light);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,monospace;}',
    '.qp-dev-icon{font-size:22px;color:var(--primary);flex-shrink:0;}'
  ].join('\n');
  document.head.appendChild(style);
}

// ===== 构建侧边栏导航 =====
function buildNav() {
  var sidebar = document.getElementById('sidebar');
  if (!sidebar || document.getElementById('qpNav')) return;
  var header = sidebar.querySelector('.sidebar-header');
  var nav = document.createElement('div');
  nav.className = 'qp-nav';
  nav.id = 'qpNav';
  nav.innerHTML =
    '<div class="qp-nav-title">快捷功能</div>' +
    '<div class="qp-nav-item" data-view="schedule" title="定时任务管理">' +
      '<span class="material-icons-outlined">schedule</span><span>定时任务</span>' +
      '<span class="qp-badge" id="qpScheduleBadge"></span></div>' +
    '<div class="qp-nav-item" data-view="skills" title="技能管理">' +
      '<span class="material-icons-outlined">extension</span><span>技能</span>' +
      '<span class="qp-badge" id="qpSkillsBadge"></span></div>' +
    '<div class="qp-nav-item" data-view="devices" title="设备与网关">' +
      '<span class="material-icons-outlined">devices</span><span>设备·网关</span>' +
      '<span class="qp-dot" id="qpGatewayDot"></span></div>';
  nav.addEventListener('click', function (e) {
    var item = e.target.closest('.qp-nav-item');
    if (item) openPanel(item.getAttribute('data-view'));
  });
  if (header && header.nextSibling) {
    sidebar.insertBefore(nav, header.nextSibling);
  } else {
    sidebar.appendChild(nav);
  }
}

// ===== 构建抽屉 DOM =====
function buildDrawer() {
  if (document.getElementById('qpDrawer')) return;
  backdropEl = document.createElement('div');
  backdropEl.className = 'qp-backdrop';
  backdropEl.id = 'qpBackdrop';
  backdropEl.addEventListener('click', closePanel);

  drawerEl = document.createElement('div');
  drawerEl.className = 'qp-drawer';
  drawerEl.id = 'qpDrawer';
  drawerEl.innerHTML =
    '<div class="qp-drawer-header">' +
      '<span class="qp-drawer-title" id="qpDrawerTitle"></span>' +
      '<button class="qp-icon-btn" id="qpCloseBtn" title="关闭"><span class="material-icons-outlined">close</span></button>' +
    '</div>' +
    '<div class="qp-drawer-body" id="qpDrawerBody"></div>';
  document.body.appendChild(backdropEl);
  document.body.appendChild(drawerEl);

  titleEl = document.getElementById('qpDrawerTitle');
  bodyEl = document.getElementById('qpDrawerBody');
  document.getElementById('qpCloseBtn').addEventListener('click', closePanel);

  // 事件委托：面板内所有操作按钮
  bodyEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    handleAction(btn.getAttribute('data-action'), btn.getAttribute('data-id'), btn);
  });
}

// ===== 面板开关 =====
function openPanel(view) {
  if (!VIEW_TITLES[view]) return;
  currentView = view;
  titleEl.textContent = VIEW_TITLES[view];
  renderView(view);
  drawerEl.classList.add('show');
  backdropEl.classList.add('show');
}

function closePanel() {
  drawerEl.classList.remove('show');
  backdropEl.classList.remove('show');
  currentView = null;
}

function refresh() {
  if (currentView) renderView(currentView);
  updateBadges();
}

function renderView(view) {
  if (view === 'schedule') bodyEl.innerHTML = renderSchedule();
  else if (view === 'skills') bodyEl.innerHTML = renderSkills();
  else if (view === 'devices') bodyEl.innerHTML = renderDevices();
}

// ===== 定时任务视图 =====
function renderSchedule() {
  var h = '';
  if (!Core.scheduler) {
    return '<div class="qp-empty"><span class="material-icons-outlined">schedule</span>定时任务模块未加载</div>';
  }
  var tasks = Core.scheduler.list() || [];
  var enabledCount = tasks.filter(function (t) { return t.enabled; }).length;

  h += '<div class="qp-stats">' +
       '<div class="qp-stat"><b>' + tasks.length + '</b><span>全部任务</span></div>' +
       '<div class="qp-stat"><b>' + enabledCount + '</b><span>已启用</span></div>' +
       '</div>';

  if (tasks.length === 0) {
    h += '<div class="qp-empty"><span class="material-icons-outlined">event_busy</span>暂无定时任务</div>';
  } else {
    tasks.forEach(function (t) {
      var desc = Core.scheduler.describeSchedule ? Core.scheduler.describeSchedule(t.schedule) : JSON.stringify(t.schedule);
      var msg = (t.action && t.action.message) ? t.action.message : '';
      h += '<div class="qp-card">' +
        '<div class="qp-card-top">' +
          '<label class="qp-switch"><input type="checkbox" data-action="toggle-task" data-id="' + esc(t.id) + '" ' + (t.enabled ? 'checked' : '') + '><span class="qp-slider"></span></label>' +
          '<span class="qp-card-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
        '</div>' +
        '<div class="qp-card-meta"><span>⏰ ' + esc(desc) + '</span><span>已跑 ' + (t.runCount || 0) + ' 次</span><span>上次: ' + timeAgo(t.lastRun) + '</span></div>' +
        (msg ? '<div class="qp-card-desc">' + esc(msg) + '</div>' : '') +
        '<div class="qp-card-actions">' +
          '<button class="qp-btn primary" data-action="run-task" data-id="' + esc(t.id) + '">立即运行</button>' +
          '<button class="qp-btn danger" data-action="delete-task" data-id="' + esc(t.id) + '">删除</button>' +
        '</div>' +
      '</div>';
    });
  }

  h += '<button class="qp-btn" style="width:100%;margin-top:4px" data-action="new-task">＋ 新建定时任务</button>';
  h += '<div class="qp-hint">💡 也可以直接在对话框说「每天9点分析A股大盘」，我会自动帮你创建定时任务。</div>';
  return h;
}

// ===== 技能视图 =====
function renderSkills() {
  var h = '';
  if (!Core.skills) {
    return '<div class="qp-empty"><span class="material-icons-outlined">extension</span>技能模块未加载</div>';
  }
  var skills = Core.skills.getAllSkills() || [];
  var active = Core.skills.getActiveSkills() || [];
  var activeIds = {};
  active.forEach(function (s) { activeIds[s.id] = true; });

  h += '<div class="qp-stats">' +
       '<div class="qp-stat"><b>' + skills.length + '</b><span>全部技能</span></div>' +
       '<div class="qp-stat"><b>' + active.length + '</b><span>已激活</span></div>' +
       '</div>';

  if (skills.length === 0) {
    h += '<div class="qp-empty"><span class="material-icons-outlined">extension_off</span>暂无技能</div>';
  } else {
    skills.forEach(function (s) {
      var isActive = !!activeIds[s.id];
      h += '<div class="qp-card">' +
        '<div class="qp-card-top">' +
          '<label class="qp-switch"><input type="checkbox" data-action="toggle-skill" data-id="' + esc(s.id) + '" ' + (isActive ? 'checked' : '') + '><span class="qp-slider"></span></label>' +
          '<span class="qp-card-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
          '<span class="qp-src">' + (s.source === 'builtin' ? '内置' : '文件') + '</span>' +
        '</div>' +
        (s.description ? '<div class="qp-card-desc">' + esc(s.description) + '</div>' : '') +
      '</div>';
    });
  }

  h += '<div class="qp-card-actions" style="margin-top:4px">' +
       '<button class="qp-btn" data-action="refresh-skills" style="flex:1">↻ 刷新技能列表</button>' +
       '</div>';
  h += '<div class="qp-hint">💡 激活的技能会注入到 AI 的系统提示词。用 <b>/clawhub</b> 可从 ClawHub 市场安装更多技能。</div>';
  return h;
}

// ===== 设备·网关视图 =====
function deviceIcon(type) {
  var map = { phone: 'smartphone', tablet: 'tablet', web: 'language', pc: 'computer', 'arm-board': 'memory' };
  return map[type] || 'devices';
}

function renderDevices() {
  var h = '';
  if (!Core.gateway) {
    return '<div class="qp-empty"><span class="material-icons-outlined">devices</span>网关模块未加载</div>';
  }
  var st = Core.gateway.getStatus() || {};
  var registry = Core.gateway.deviceRegistry || {};
  var ids = Object.keys(registry);
  var onlineCount = ids.filter(function (id) { return registry[id].status === 'online'; }).length;
  var ip = getLocalIP();

  h += '<div class="qp-stats">' +
       '<div class="qp-stat"><b>' + (st.running ? '运行中' : '已停止') + '</b><span>网关状态</span></div>' +
       '<div class="qp-stat"><b>' + onlineCount + '</b><span>在线设备</span></div>' +
       '<div class="qp-stat"><b>' + (st.connectedClients || 0) + '</b><span>连接数</span></div>' +
       '</div>';

  // 连接地址
  h += '<div class="qp-conn"><span class="material-icons-outlined" style="font-size:16px;color:var(--text-secondary)">lan</span>' +
       '<code>ws://' + ip + ':' + (st.port || 18789) + '</code>' +
       '<button class="qp-btn" data-action="copy" data-id="ws://' + ip + ':' + (st.port || 18789) + '">复制</button></div>';
  h += '<div class="qp-conn"><span class="material-icons-outlined" style="font-size:16px;color:var(--text-secondary)">public</span>' +
       '<code>http://' + ip + ':18790</code>' +
       '<button class="qp-btn" data-action="copy" data-id="http://' + ip + ':18790">复制</button></div>';

  // 设备列表
  if (ids.length === 0) {
    h += '<div class="qp-empty"><span class="material-icons-outlined">devices_other</span>暂无注册设备<br><span style="font-size:11px">手机/平板连接上方 WebSocket 地址后即可出现</span></div>';
  } else {
    ids.forEach(function (id) {
      var d = registry[id];
      var online = d.status === 'online';
      var caps = (d.capabilities || []).map(function (c) { return '<span class="qp-chip">' + esc(c) + '</span>'; }).join(' ');
      h += '<div class="qp-card">' +
        '<div class="qp-card-top">' +
          '<span class="material-icons-outlined qp-dev-icon">' + deviceIcon(d.type) + '</span>' +
          '<span class="qp-card-name" title="' + esc(id) + '">' + esc(id) + '</span>' +
          '<span class="qp-status ' + (online ? 'on' : 'off') + '"><i></i>' + (online ? '在线' : '离线') + '</span>' +
        '</div>' +
        '<div class="qp-card-meta"><span>类型: ' + esc(d.type || '-') + '</span><span>系统: ' + esc(d.os || '-') + '</span><span>最后活跃: ' + timeAgo(d.lastSeen) + '</span></div>' +
        (caps ? '<div class="qp-card-meta" style="margin-top:6px">' + caps + '</div>' : '') +
      '</div>';
    });
  }

  h += '<div class="qp-card-actions" style="margin-top:4px">' +
       '<button class="qp-btn" data-action="refresh-panel" style="flex:1">↻ 刷新</button>' +
       '<button class="qp-btn" data-action="open-webui" style="flex:1">打开 Web 控制台</button>' +
       '</div>';
  h += '<div class="qp-hint">💡 手机/平板/开发板连接 WebSocket 地址并发送 <b>device_register</b> 即可加入网络，用 <b>/gateway devices</b> 查看详情。</div>';
  return h;
}

// ===== 操作分发 =====
function handleAction(action, id, btn) {
  try {
    if (action === 'toggle-task') {
      var enabled = btn.checked;
      if (Core.scheduler && Core.scheduler.update) Core.scheduler.update(id, { enabled: enabled });
      updateBadges();
    } else if (action === 'run-task') {
      if (Core.scheduler && Core.scheduler.runNow) Core.scheduler.runNow(id);
      notify('定时任务已触发执行');
      setTimeout(refresh, 600);
    } else if (action === 'delete-task') {
      if (Core.scheduler && Core.scheduler.delete) Core.scheduler.delete(id);
      refresh();
    } else if (action === 'new-task') {
      if (Core.dom && Core.dom.input) {
        Core.dom.input.value = '/schedule add 每天早上9点分析A股大盘';
        Core.dom.input.focus();
      }
      closePanel();
    } else if (action === 'toggle-skill') {
      if (Core.skills && Core.skills.setSkill) Core.skills.setSkill(id);
      updateBadges();
      // setSkill 是 toggle，重新渲染以同步开关状态
      setTimeout(function () { renderView('skills'); updateBadges(); }, 50);
    } else if (action === 'refresh-skills') {
      if (Core.skills && Core.skills.refreshSkills) Core.skills.refreshSkills();
      renderView('skills');
      updateBadges();
    } else if (action === 'refresh-panel') {
      refresh();
    } else if (action === 'copy') {
      copyText(id);
      notify('已复制: ' + id);
    } else if (action === 'open-webui') {
      var ip2 = getLocalIP();
      if (Core.shell && Core.shell.openExternal) Core.shell.openExternal('http://' + ip2 + ':18790');
      else if (window.require) { try { require('electron').shell.openExternal('http://' + ip2 + ':18790'); } catch (e) { window.open('http://' + ip2 + ':18790'); } }
      else window.open('http://' + ip2 + ':18790');
    }
  } catch (e) {
    console.error('[quick-panel] 操作失败:', action, e);
    notify('操作失败: ' + e.message);
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

function notify(msg) {
  if (Core.ui && Core.ui.notify) Core.ui.notify('快捷面板', msg);
  else if (Core.showNotification) Core.showNotification(msg, 'info');
  if (Core.dom && Core.dom.status) Core.dom.status.textContent = msg;
}

// ===== 角标更新 =====
function updateBadges() {
  try {
    var sb = document.getElementById('qpScheduleBadge');
    if (sb && Core.scheduler) {
      var en = (Core.scheduler.list() || []).filter(function (t) { return t.enabled; }).length;
      sb.textContent = en > 0 ? en : '';
    }
    var kb = document.getElementById('qpSkillsBadge');
    if (kb && Core.skills) {
      var ac = (Core.skills.getActiveSkills() || []).length;
      kb.textContent = ac > 0 ? ac : '';
    }
    var dot = document.getElementById('qpGatewayDot');
    if (dot && Core.gateway) {
      var gst = Core.gateway.getStatus() || {};
      dot.classList.toggle('on', !!gst.running && (gst.onlineDevices || 0) > 0);
    }
  } catch (e) { /* ignore */ }
}

// ===== 命令注册 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('panel', {
    zh: '打开快捷面板: /panel schedule|skills|devices',
    en: 'Open quick panel'
  }, function (args) {
    var view = (args[0] || '').toLowerCase();
    if (view === 'schedule' || view === 'skills' || view === 'devices') {
      openPanel(view);
    } else {
      openPanel('schedule');
    }
    return true;
  });
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try {
    injectStyles();
    buildNav();
    buildDrawer();
    registerCommands();
    updateBadges();

    // 网关设备变化时刷新角标与（若打开）设备视图
    if (Core.on) {
      Core.on('gateway:device', function () {
        updateBadges();
        if (currentView === 'devices') renderView('devices');
      });
    }

    Core.quickPanel = {
      open: openPanel,
      close: closePanel,
      refresh: refresh
    };
    console.log('✅ quick-panel.js 已加载（定时任务 / 技能 / 设备·网关）');
  } catch (e) {
    console.error('❌ quick-panel.js 初始化失败:', e);
  }
}

module.exports = {
  name: 'quick-panel',
  dependencies: ['custom', 'session'],
  init: init
};
