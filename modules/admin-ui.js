// modules/admin-ui.js - Gateway 管理后台（Web Dashboard）
// 侧边栏导航 + 卡片式面板：设备管理 / 技能管理 / 模型配置 / 会话历史 / 系统状态
// 设计参考：QoderWork 风格（深色主题 + 侧边栏 + 卡片 + 开关）
'use strict';

var Core = null;
var http = null;

var ADMIN_PORT = 18791;
var adminServer = null;

// ===== REST API 数据接口 =====

function apiOverview() {
  var gw = Core.gateway ? Core.gateway.getStatus() : { running: false };
  var skills = Core.skills ? Core.skills.getAllSkills() : [];
  var activeSkills = Core.skills ? Core.skills.getActiveSkills() : [];
  var sessions = Core.session ? Core.session.getSessionList() : [];
  var model = '';
  try {
    if (Core.dom && Core.dom.modelSelect) {
      model = Core.dom.modelSelect.value || '';
    }
  } catch (e) {}
  return {
    gateway: gw,
    skillCount: skills.length,
    activeSkillCount: activeSkills.length,
    activeSkills: activeSkills.map(function(s) { return s.name; }),
    sessionCount: sessions.length,
    currentModel: model || (Core.config ? Core.config.ollamaModel : ''),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    time: Date.now()
  };
}

function apiDevices() {
  if (!Core.gateway || !Core.gateway.deviceRegistry) return [];
  var reg = Core.gateway.deviceRegistry;
  var list = [];
  for (var id in reg) {
    var d = reg[id];
    list.push({
      deviceId: id,
      type: d.type || 'unknown',
      os: d.os || '',
      capabilities: d.capabilities || [],
      status: d.status || 'offline',
      ip: d.ip || '',
      lastSeen: d.lastSeen || 0
    });
  }
  // 在线排前面
  list.sort(function(a, b) {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  return list;
}

function apiSkills() {
  if (!Core.skills) return [];
  var all = Core.skills.getAllSkills();
  var active = Core.skills.getActiveSkills().map(function(s) { return s.id; });
  return all.map(function(s) {
    return {
      id: s.id,
      name: s.name,
      description: s.description || '',
      source: s.source || 'builtin',
      version: s.version || '1.0.0',
      author: s.author || '',
      active: active.indexOf(s.id) !== -1
    };
  });
}

function apiToggleSkill(id) {
  if (!Core.skills) return { success: false, error: '技能模块未加载' };
  var skill = Core.skills.getSkill(id);
  if (!skill) return { success: false, error: '技能不存在: ' + id };
  Core.skills.setSkill(id);
  var active = Core.skills.getActiveSkills().map(function(s) { return s.id; });
  return { success: true, active: active.indexOf(id) !== -1 };
}

function apiSessions() {
  if (!Core.session) return [];
  var sessions = Core.session.sessions || {};
  var list = [];
  for (var id in sessions) {
    var s = sessions[id];
    list.push({
      id: id,
      title: s.title || '未命名会话',
      timestamp: s.timestamp || 0,
      updatedAt: s.updated_at || s.timestamp || 0,
      messageCount: (s.messages || []).length,
      pinned: !!s.pinned,
      parentId: s.parentId || null
    });
  }
  list.sort(function(a, b) {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return list.slice(0, 50); // 最多返回 50 条
}

function apiSessionDetail(id) {
  if (!Core.session || !Core.session.sessions) return null;
  var s = Core.session.sessions[id];
  if (!s) return null;
  return {
    id: id,
    title: s.title || '未命名会话',
    messages: (s.messages || []).slice(-30).map(function(m) {
      return { role: m.role, content: (m.content || '').substring(0, 500), time: m.timestamp || 0 };
    })
  };
}

function apiConfig() {
  var cfg = Core.config || {};
  return {
    ollamaModel: cfg.ollamaModel || '',
    defaultApi: cfg.defaultApi || '',
    siliconFlowKey: cfg.siliconFlowKey ? '***已配置***' : '未配置',
    deepseekKey: cfg.deepseekKey ? '***已配置***' : '未配置',
    language: cfg.language || 'zh-CN',
    availableModels: cfg.availableModels || [],
    autoRead: cfg.autoRead || false
  };
}

function apiSystem() {
  var modules = [];
  try {
    var fs = require('fs');
    var path = require('path');
    var modDir = path.join(__dirname);
    var files = fs.readdirSync(modDir);
    modules = files.filter(function(f) { return f.endsWith('.js'); }).map(function(f) { return f.replace('.js', ''); });
  } catch (e) {}
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron || '',
    pid: process.pid,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cwd: process.cwd(),
    moduleCount: modules.length,
    modules: modules.slice(0, 60)
  };
}

// ===== 事件日志环形缓冲 =====
var eventLog = [];
var EVENT_LOG_MAX = 100;

function pushLog(level, msg) {
  eventLog.push({ time: Date.now(), level: level, msg: msg });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
}

function apiLogs() {
  return eventLog.slice(-50).reverse();
}

function apiGatewayRestart() {
  if (!Core.gateway) return { success: false, error: 'Gateway 模块未加载' };
  try {
    pushLog('warn', '管理员触发 Gateway 重启');
    Core.gateway.stop();
    setTimeout(function() { Core.gateway.start(); }, 1000);
    return { success: true, message: 'Gateway 正在重启...' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function registerLogListeners() {
  if (!Core || !Core.on) return;
  Core.on('gateway:device', function(data) {
    pushLog('info', '设备 ' + (data.deviceId || '?') + ' → ' + (data.status || '?'));
  });
  Core.on('ai:error', function(data) {
    pushLog('error', 'AI 错误: ' + (data.message || '未知'));
  });
  Core.on('ui:message', function(data) {
    if (data && data.role === 'user') pushLog('info', '用户消息: ' + (data.content || '').substring(0, 60));
  });
}

// ===== HTTP 路由 =====

function handleRequest(req, res) {
  var url = req.url.split('?')[0];

  // CORS（允许局域网设备访问）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API 路由
  if (url === '/api/overview') { json(res, apiOverview()); return; }
  if (url === '/api/devices') { json(res, apiDevices()); return; }
  if (url === '/api/skills') { json(res, apiSkills()); return; }
  if (url === '/api/sessions') { json(res, apiSessions()); return; }
  if (url === '/api/config') { json(res, apiConfig()); return; }
  if (url === '/api/system') { json(res, apiSystem()); return; }
  if (url === '/api/logs') { json(res, apiLogs()); return; }

  // POST: Gateway 重启
  if (url === '/api/gateway/restart' && req.method === 'POST') {
    json(res, apiGatewayRestart());
    return;
  }

  // POST: 广播消息到所有设备
  if (url === '/api/broadcast' && req.method === 'POST') {
    var bodyB = '';
    req.on('data', function(c) { bodyB += c; });
    req.on('end', function() {
      try {
        var dataB = JSON.parse(bodyB);
        if (!dataB.message) { json(res, { success: false, error: '消息内容为空' }); return; }
        if (Core.gateway && Core.gateway.broadcast) {
          Core.gateway.broadcast({ type: 'ui_event', event: 'ui:notify', data: { message: dataB.message, from: 'admin' } });
          pushLog('info', '管理员广播: ' + dataB.message.substring(0, 60));
          json(res, { success: true, message: '已广播到所有设备' });
        } else {
          json(res, { success: false, error: 'Gateway 未运行' });
        }
      } catch (e) {
        json(res, { success: false, error: 'Invalid JSON' });
      }
    });
    return;
  }

  // POST: 删除会话
  if (url === '/api/sessions/delete' && req.method === 'POST') {
    var bodyD = '';
    req.on('data', function(c) { bodyD += c; });
    req.on('end', function() {
      try {
        var dataD = JSON.parse(bodyD);
        if (Core.session && Core.session.deleteSession) {
          Core.session.deleteSession(dataD.id);
          json(res, { success: true, message: '会话已删除' });
        } else {
          json(res, { success: false, error: '会话模块未加载' });
        }
      } catch (e) {
        json(res, { success: false, error: e.message });
      }
    });
    return;
  }

  // POST: 重命名会话
  if (url === '/api/sessions/rename' && req.method === 'POST') {
    var bodyR = '';
    req.on('data', function(c) { bodyR += c; });
    req.on('end', function() {
      try {
        var dataR = JSON.parse(bodyR);
        if (Core.session && Core.session.renameSession) {
          Core.session.renameSession(dataR.id, dataR.title);
          json(res, { success: true, message: '已重命名' });
        } else {
          json(res, { success: false, error: '会话模块未加载' });
        }
      } catch (e) {
        json(res, { success: false, error: e.message });
      }
    });
    return;
  }

  // POST: 技能切换
  if (url === '/api/skills/toggle' && req.method === 'POST') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        json(res, apiToggleSkill(data.id));
      } catch (e) {
        json(res, { success: false, error: 'Invalid JSON' });
      }
    });
    return;
  }

  // POST: 设备 Ping
  if (url === '/api/devices/ping' && req.method === 'POST') {
    var body2 = '';
    req.on('data', function(c) { body2 += c; });
    req.on('end', function() {
      try {
        var data2 = JSON.parse(body2);
        var ok = Core.gateway && Core.gateway.sendToDevice(data2.deviceId, { type: 'pong', time: Date.now(), from: 'admin' });
        json(res, { success: !!ok, message: ok ? 'Ping 已发送' : '设备不在线' });
      } catch (e) {
        json(res, { success: false, error: 'Invalid JSON' });
      }
    });
    return;
  }

  // POST: 移除设备
  if (url === '/api/devices/remove' && req.method === 'POST') {
    var body3 = '';
    req.on('data', function(c) { body3 += c; });
    req.on('end', function() {
      try {
        var data3 = JSON.parse(body3);
        var reg = Core.gateway ? Core.gateway.deviceRegistry : null;
        if (reg && reg[data3.deviceId]) {
          delete reg[data3.deviceId];
          json(res, { success: true, message: '设备已移除' });
        } else {
          json(res, { success: false, error: '设备不存在' });
        }
      } catch (e) {
        json(res, { success: false, error: 'Invalid JSON' });
      }
    });
    return;
  }

  // 会话详情
  var sessionMatch = url.match(/^\/api\/sessions\/(.+)$/);
  if (sessionMatch) {
    var detail = apiSessionDetail(decodeURIComponent(sessionMatch[1]));
    if (detail) { json(res, detail); } else { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  // 默认：管理面板 HTML
  if (url === '/' || url === '/admin' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getAdminHtml());
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ===== 管理面板前端 =====
function getAdminHtml() {
  return '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>AI Agent Pro - \u7ba1\u7406\u540e\u53f0</title>\n' +
'<style>\n' +
'* { margin:0; padding:0; box-sizing:border-box; }\n' +
':root { --bg:#0f172a; --surface:#1e293b; --surface2:#263548; --border:#334155; --text:#e2e8f0; --text2:#94a3b8; --text3:#64748b; --primary:#3b82f6; --primary2:#2563eb; --green:#22c55e; --green-bg:rgba(34,197,94,0.1); --red:#ef4444; --red-bg:rgba(239,68,68,0.1); --yellow:#eab308; --purple:#a78bfa; --radius:12px; }\n' +
'body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; overflow:hidden; }\n' +
'\n' +
'/* \u4fa7\u8fb9\u680f */\n' +
'.sidebar { width:220px; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; flex-shrink:0; }\n' +
'.sidebar .logo { padding:20px 16px; font-size:15px; font-weight:700; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; }\n' +
'.sidebar .logo .dot { width:10px; height:10px; border-radius:50%; background:var(--green); }\n' +
'.sidebar nav { flex:1; padding:12px 8px; display:flex; flex-direction:column; gap:4px; }\n' +
'.sidebar nav a { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px; color:var(--text2); text-decoration:none; font-size:13px; transition:all .15s; cursor:pointer; }\n' +
'.sidebar nav a:hover { background:var(--surface2); color:var(--text); }\n' +
'.sidebar nav a.active { background:var(--primary); color:#fff; }\n' +
'.sidebar nav a .icon { width:18px; text-align:center; font-size:15px; }\n' +
'.sidebar .footer { padding:12px 16px; border-top:1px solid var(--border); font-size:11px; color:var(--text3); }\n' +
'\n' +
'/* \u4e3b\u5185\u5bb9 */\n' +
'.main { flex:1; display:flex; flex-direction:column; overflow:hidden; }\n' +
'.topbar { padding:16px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }\n' +
'.topbar h2 { font-size:18px; font-weight:600; }\n' +
'.topbar .refresh { padding:6px 14px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--text2); font-size:12px; cursor:pointer; }\n' +
'.topbar .refresh:hover { border-color:var(--primary); color:var(--primary); }\n' +
'.content { flex:1; overflow-y:auto; padding:24px; }\n' +
'\n' +
'/* \u5361\u7247 */\n' +
'.cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:16px; }\n' +
'.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px; transition:border-color .2s; }\n' +
'.card:hover { border-color:var(--primary); }\n' +
'.card .card-title { font-size:14px; font-weight:600; margin-bottom:12px; display:flex; align-items:center; gap:8px; }\n' +
'.card .card-value { font-size:28px; font-weight:700; color:var(--primary); }\n' +
'.card .card-sub { font-size:12px; color:var(--text2); margin-top:6px; }\n' +
'\n' +
'/* \u72b6\u6001\u5fbd\u7ae0 */\n' +
'.badge { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:500; }\n' +
'.badge.online { background:var(--green-bg); color:var(--green); }\n' +
'.badge.offline { background:var(--red-bg); color:var(--red); }\n' +
'.badge.builtin { background:rgba(167,139,250,0.1); color:var(--purple); }\n' +
'.badge.file { background:rgba(59,130,246,0.1); color:var(--primary); }\n' +
'\n' +
'/* \u5f00\u5173 */\n' +
'.toggle { position:relative; width:40px; height:22px; border-radius:11px; background:var(--border); cursor:pointer; transition:background .2s; flex-shrink:0; }\n' +
'.toggle.on { background:var(--green); }\n' +
'.toggle::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform .2s; }\n' +
'.toggle.on::after { transform:translateX(18px); }\n' +
'\n' +
'/* \u5217\u8868 */\n' +
'.list-item { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:var(--surface); border:1px solid var(--border); border-radius:8px; margin-bottom:8px; }\n' +
'.list-item .info { flex:1; min-width:0; }\n' +
'.list-item .info .name { font-size:13px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n' +
'.list-item .info .desc { font-size:11px; color:var(--text2); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n' +
'\n' +
'/* \u8bbe\u5907\u5361\u7247 */\n' +
'.device-card { display:flex; align-items:center; gap:14px; }\n' +
'.device-card .dev-icon { width:40px; height:40px; border-radius:10px; background:var(--surface2); display:flex; align-items:center; justify-content:center; font-size:18px; }\n' +
'.device-card .dev-info { flex:1; }\n' +
'.device-card .dev-info .dev-name { font-size:13px; font-weight:600; }\n' +
'.device-card .dev-info .dev-meta { font-size:11px; color:var(--text2); margin-top:3px; }\n' +
'\n' +
'/* \u7cfb\u7edf\u4fe1\u606f */\n' +
'.sys-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px; }\n' +
'.sys-item { padding:14px; background:var(--surface); border:1px solid var(--border); border-radius:8px; }\n' +
'.sys-item .sys-label { font-size:11px; color:var(--text3); margin-bottom:4px; }\n' +
'.sys-item .sys-val { font-size:14px; font-weight:500; }\n' +
'\n' +
'/* \u4f1a\u8bdd\u8be6\u60c5 */\n' +
'.msg-bubble { padding:10px 14px; border-radius:10px; margin-bottom:8px; font-size:13px; line-height:1.5; max-width:80%; white-space:pre-wrap; word-break:break-word; }\n' +
'.msg-bubble.user { background:var(--primary); color:#fff; margin-left:auto; border-bottom-right-radius:3px; }\n' +
'.msg-bubble.ai { background:var(--surface2); border:1px solid var(--border); border-bottom-left-radius:3px; }\n' +
'\n' +
'/* \u54cd\u5e94\u5f0f */\n' +
'@media(max-width:768px) {\n' +
'  .sidebar { width:60px; }\n' +
'  .sidebar .logo span, .sidebar nav a span, .sidebar .footer { display:none; }\n' +
'  .sidebar nav a { justify-content:center; padding:12px; }\n' +
'  .cards { grid-template-columns:1fr; }\n' +
'}\n' +
'\n' +
'.empty { text-align:center; padding:40px; color:var(--text3); font-size:13px; }\n' +
'.panel { display:none; }\n' +
'.panel.active { display:block; }\n' +
'</style>\n</head>\n<body>\n' +
'\n' +
'<div class="sidebar">\n' +
'  <div class="logo"><div class="dot"></div><span>AI Agent Pro</span></div>\n' +
'  <nav>\n' +
'    <a class="active" data-panel="overview"><div class="icon">\u{1f4ca}</div><span>\u6982\u89c8</span></a>\n' +
'    <a data-panel="devices"><div class="icon">\u{1f4f1}</div><span>\u8bbe\u5907</span></a>\n' +
'    <a data-panel="skills"><div class="icon">\u26a1</div><span>\u6280\u80fd</span></a>\n' +
'    <a data-panel="sessions"><div class="icon">\u{1f4ac}</div><span>\u4f1a\u8bdd</span></a>\n' +
'    <a data-panel="config"><div class="icon">\u{1f9e0}</div><span>\u914d\u7f6e</span></a>\n' +
'    <a data-panel="logs"><div class="icon">\u{1f4dc}</div><span>\u65e5\u5fd7</span></a>\n' +
'    <a data-panel="system"><div class="icon">\u2699\ufe0f</div><span>\u7cfb\u7edf</span></a>\n' +
'  </nav>\n' +
'  <div class="footer">Gateway Admin v1.0</div>\n' +
'</div>\n' +
'\n' +
'<div class="main">\n' +
'  <div class="topbar">\n' +
'    <h2 id="pageTitle">\u6982\u89c8</h2>\n' +
'    <button class="refresh" onclick="refresh()">\u21bb \u5237\u65b0</button>\n' +
'  </div>\n' +
'  <div class="content">\n' +
'\n' +
'    <div class="panel active" id="panel-overview"></div>\n' +
'    <div class="panel" id="panel-devices"></div>\n' +
'    <div class="panel" id="panel-skills"></div>\n' +
'    <div class="panel" id="panel-sessions"></div>\n' +
'    <div class="panel" id="panel-config"></div>\n' +
'    <div class="panel" id="panel-logs"></div>\n' +
'    <div class="panel" id="panel-system"></div>\n' +
'\n' +
'  </div>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'var currentPanel = "overview";\n' +
'var titles = { overview:"\u6982\u89c8", devices:"\u8bbe\u5907\u7ba1\u7406", skills:"\u6280\u80fd\u7ba1\u7406", sessions:"\u4f1a\u8bdd\u5386\u53f2", config:"\u6a21\u578b\u914d\u7f6e", logs:"\u4e8b\u4ef6\u65e5\u5fd7", system:"\u7cfb\u7edf\u72b6\u6001" };\n' +
'\n' +
'// \u4fa7\u8fb9\u680f\u5bfc\u822a\n' +
'document.querySelectorAll(".sidebar nav a").forEach(function(a) {\n' +
'  a.addEventListener("click", function() {\n' +
'    var panel = this.dataset.panel;\n' +
'    if (!panel) return;\n' +
'    currentPanel = panel;\n' +
'    document.querySelectorAll(".sidebar nav a").forEach(function(x){ x.classList.remove("active"); });\n' +
'    this.classList.add("active");\n' +
'    document.querySelectorAll(".panel").forEach(function(p){ p.classList.remove("active"); });\n' +
'    document.getElementById("panel-" + panel).classList.add("active");\n' +
'    document.getElementById("pageTitle").textContent = titles[panel] || panel;\n' +
'    refresh();\n' +
'  });\n' +
'});\n' +
'\n' +
'function refresh() {\n' +
'  if (currentPanel === "overview") loadOverview();\n' +
'  else if (currentPanel === "devices") loadDevices();\n' +
'  else if (currentPanel === "skills") loadSkills();\n' +
'  else if (currentPanel === "sessions") loadSessions();\n' +
'  else if (currentPanel === "config") loadConfig();\n' +
'  else if (currentPanel === "logs") loadLogs();\n' +
'  else if (currentPanel === "system") loadSystem();\n' +
'}\n' +
'\n' +
'function fmtUptime(s) { var h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h+"h "+m+"m"; }\n' +
'function fmtTime(ts) { if(!ts) return "-"; var d=new Date(ts); return d.toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}); }\n' +
'function fmtMem(b) { return (b/1024/1024).toFixed(1)+" MB"; }\n' +
'\n' +
'// ===== \u6982\u89c8 =====\n' +
'function loadOverview() {\n' +
'  fetch("/api/overview").then(function(r){return r.json()}).then(function(d) {\n' +
'    var gw = d.gateway || {};\n' +
'    var html = \'<div class="cards">\';\n' +
'    html += card("\u{1f310} Gateway", gw.running ? "\u8fd0\u884c\u4e2d" : "\u5df2\u505c\u6b62", "\u7aef\u53e3 " + (gw.port||"-") + " | \u5ba2\u6237\u7aef " + (gw.connectedClients||0));\n' +
'    html += card("\u{1f4f1} \u5728\u7ebf\u8bbe\u5907", gw.onlineDevices||0, "\u6ce8\u518c\u8bbe\u5907 " + (gw.registeredDevices||0));\n' +
'    html += card("\u26a1 \u6280\u80fd", d.activeSkillCount + " \u6fc0\u6d3b", "\u5171 " + d.skillCount + " \u4e2a\u6280\u80fd");\n' +
'    html += card("\u{1f4ac} \u4f1a\u8bdd", d.sessionCount, "\u5386\u53f2\u4f1a\u8bdd\u603b\u6570");\n' +
'    html += card("\u{1f9e0} \u5f53\u524d\u6a21\u578b", d.currentModel || "-", "");\n' +
'    html += card("\u23f1\ufe0f \u8fd0\u884c\u65f6\u95f4", fmtUptime(d.uptime), "\u5185\u5b58 " + fmtMem(d.memory.rss));\n' +
'    html += \'</div>\';\n' +
'    document.getElementById("panel-overview").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-overview").innerHTML = errBox(e); });\n' +
'}\n' +
'function card(title, value, sub) {\n' +
'  return \'<div class="card"><div class="card-title">\' + title + \'</div><div class="card-value">\' + value + \'</div><div class="card-sub">\' + sub + \'</div></div>\';\n' +
'}\n' +
'\n' +
'// ===== \u8bbe\u5907 =====\n' +
'function loadDevices() {\n' +
'  fetch("/api/devices").then(function(r){return r.json()}).then(function(devices) {\n' +
'    if (!devices.length) { document.getElementById("panel-devices").innerHTML = \'<div class="empty">\u6682\u65e0\u6ce8\u518c\u8bbe\u5907<br><br>\u624b\u673a/\u5f00\u53d1\u677f\u8fde\u63a5 ws://&lt;PC_IP&gt;:18789 \u540e\u81ea\u52a8\u6ce8\u518c</div>\'; return; }\n' +
'    var html = \'<div style="margin-bottom:16px;display:flex;gap:8px">\';\n' +
'    html += \'<input id="broadcastInput" type="text" placeholder="\u5e7f\u64ad\u6d88\u606f\u5230\u6240\u6709\u8bbe\u5907..." style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;outline:none">\';\n' +
'    html += \'<button style="padding:8px 14px;border-radius:6px;border:none;background:var(--primary);color:#fff;font-size:12px;cursor:pointer" onclick="sendBroadcast()">\u5e7f\u64ad</button>\';\n' +
'    html += \'</div>\';\n' +
'    html += \'<div class="cards">\';\n' +
'    devices.forEach(function(d) {\n' +
'      var icon = d.type === "web" ? "\u{1f310}" : d.type === "phone" ? "\u{1f4f1}" : d.type === "desktop" ? "\u{1f4bb}" : "\u{1f527}";\n' +
'      html += \'<div class="card"><div class="device-card">\';\n' +
'      html += \'<div class="dev-icon">\' + icon + \'</div>\';\n' +
'      html += \'<div class="dev-info"><div class="dev-name">\' + d.deviceId + \'</div>\';\n' +
'      html += \'<div class="dev-meta">\' + d.type + \' | \' + (d.os||"-") + \' | IP: \' + (d.ip||"-") + \'</div>\';\n' +
'      html += \'<div class="dev-meta">\u80fd\u529b: \' + (d.capabilities||[]).join(", ") + \'</div></div>\';\n' +
'      html += \'<span class="badge \' + d.status + \'">\' + (d.status === "online" ? "\u5728\u7ebf" : "\u79bb\u7ebf") + \'</span>\';\n' +
'      html += \'</div>\';\n' +
'      html += \'<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px">\';\n' +
'      html += \'<div class="card-sub">\u6700\u540e\u6d3b\u8dc3: \' + fmtTime(d.lastSeen) + \'</div>\';\n' +
'      html += \'<div style="display:flex;gap:6px">\';\n' +
'      html += \'<button style="padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text2);font-size:11px;cursor:pointer" onclick="pingDevice(\\x27\' + d.deviceId + \'\\x27)">Ping</button>\';\n' +
'      html += \'<button style="padding:3px 10px;border-radius:4px;border:1px solid var(--red);background:transparent;color:var(--red);font-size:11px;cursor:pointer" onclick="removeDevice(\\x27\' + d.deviceId + \'\\x27)">\u79fb\u9664</button>\';\n' +
'      html += \'</div></div></div>\';\n' +
'    });\n' +
'    html += \'</div>\';\n' +
'    document.getElementById("panel-devices").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-devices").innerHTML = errBox(e); });\n' +
'}\n' +
'\n' +
'// ===== \u6280\u80fd =====\n' +
'function loadSkills() {\n' +
'  fetch("/api/skills").then(function(r){return r.json()}).then(function(skills) {\n' +
'    if (!skills.length) { document.getElementById("panel-skills").innerHTML = \'<div class="empty">\u6682\u65e0\u6280\u80fd</div>\'; return; }\n' +
'    var html = "";\n' +
'    skills.forEach(function(s) {\n' +
'      html += \'<div class="list-item">\';\n' +
'      html += \'<div class="info"><div class="name">\' + s.name + \' <span class="badge \' + s.source + \'">\' + (s.source === "builtin" ? "\u5185\u7f6e" : "\u6587\u4ef6") + \'</span></div>\';\n' +
'      html += \'<div class="desc">\' + (s.description || s.id) + \'</div></div>\';\n' +
'      html += \'<div class="toggle\' + (s.active ? " on" : "") + \'" data-id="\' + s.id + \'" onclick="toggleSkill(this)"></div>\';\n' +
'      html += \'</div>\';\n' +
'    });\n' +
'    document.getElementById("panel-skills").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-skills").innerHTML = errBox(e); });\n' +
'}\n' +
'function toggleSkill(el) {\n' +
'  var id = el.dataset.id;\n' +
'  fetch("/api/skills/toggle", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({id:id}) })\n' +
'  .then(function(r){return r.json()}).then(function(d) {\n' +
'    if (d.success) { el.classList.toggle("on", d.active); }\n' +
'  });\n' +
'}\n' +
'function pingDevice(id) {\n' +
'  fetch("/api/devices/ping", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({deviceId:id}) })\n' +
'  .then(function(r){return r.json()}).then(function(d) { alert(d.message || d.error); });\n' +
'}\n' +
'function removeDevice(id) {\n' +
'  if (!confirm("\u786e\u5b9a\u79fb\u9664\u8bbe\u5907 " + id + " \uff1f")) return;\n' +
'  fetch("/api/devices/remove", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({deviceId:id}) })\n' +
'  .then(function(r){return r.json()}).then(function(d) { if(d.success) loadDevices(); else alert(d.error); });\n' +
'}\n' +
'function sendBroadcast() {\n' +
'  var input = document.getElementById("broadcastInput");\n' +
'  var msg = input ? input.value.trim() : "";\n' +
'  if (!msg) return;\n' +
'  fetch("/api/broadcast", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({message:msg}) })\n' +
'  .then(function(r){return r.json()}).then(function(d) { alert(d.message || d.error); if(d.success && input) input.value=""; });\n' +
'}\n' +
'\n' +
'// ===== \u4f1a\u8bdd =====\n' +
'function loadSessions() {\n' +
'  fetch("/api/sessions").then(function(r){return r.json()}).then(function(sessions) {\n' +
'    if (!sessions.length) { document.getElementById("panel-sessions").innerHTML = \'<div class="empty">\u6682\u65e0\u4f1a\u8bdd\u8bb0\u5f55</div>\'; return; }\n' +
'    var html = "";\n' +
'    sessions.forEach(function(s) {\n' +
'      html += \'<div class="list-item">\';\n' +
'      html += \'<div class="info" style="cursor:pointer" onclick="viewSession(\\x27\' + s.id + \'\\x27)"><div class="name">\' + (s.pinned ? "\u{1f4cc} " : "") + s.title + \'</div>\';\n' +
'      html += \'<div class="desc">\' + s.messageCount + \' \u6761\u6d88\u606f | \' + fmtTime(s.updatedAt) + \'</div></div>\';\n' +
'      html += \'<div style="display:flex;gap:6px;flex-shrink:0">\';\n' +
'      html += \'<button style="padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text2);font-size:11px;cursor:pointer" onclick="renameSession(\\x27\' + s.id + \'\\x27)">\u91cd\u547d\u540d</button>\';\n' +
'      html += \'<button style="padding:3px 8px;border-radius:4px;border:1px solid var(--red);background:transparent;color:var(--red);font-size:11px;cursor:pointer" onclick="deleteSession(\\x27\' + s.id + \'\\x27)">\u5220\u9664</button>\';\n' +
'      html += \'</div></div>\';\n' +
'    });\n' +
'    document.getElementById("panel-sessions").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-sessions").innerHTML = errBox(e); });\n' +
'}\n' +
'function viewSession(id) {\n' +
'  fetch("/api/sessions/" + encodeURIComponent(id)).then(function(r){return r.json()}).then(function(d) {\n' +
'    if (!d) return;\n' +
'    var html = \'<div style="margin-bottom:16px"><a style="color:var(--primary);cursor:pointer;font-size:13px" onclick="loadSessions()">\u2190 \u8fd4\u56de\u5217\u8868</a><h3 style="margin-top:8px;font-size:15px">\' + d.title + \'</h3></div>\';\n' +
'    (d.messages||[]).forEach(function(m) {\n' +
'      var cls = m.role === "user" ? "user" : "ai";\n' +
'      html += \'<div class="msg-bubble \' + cls + \'">\' + escHtml(m.content) + \'</div>\';\n' +
'    });\n' +
'    document.getElementById("panel-sessions").innerHTML = html;\n' +
'  });\n' +
'}\n' +
'function renameSession(id) {\n' +
'  var title = prompt("\u8f93\u5165\u65b0\u540d\u79f0:");\n' +
'  if (!title) return;\n' +
'  fetch("/api/sessions/rename", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({id:id, title:title}) })\n' +
'  .then(function(r){return r.json()}).then(function(d) { if(d.success) loadSessions(); else alert(d.error); });\n' +
'}\n' +
'function deleteSession(id) {\n' +
'  if (!confirm("\u786e\u5b9a\u5220\u9664\u8be5\u4f1a\u8bdd\uff1f\u4e0d\u53ef\u6062\u590d\u3002")) return;\n' +
'  fetch("/api/sessions/delete", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({id:id}) })\n' +
'  .then(function(r){return r.json()}).then(function(d) { if(d.success) loadSessions(); else alert(d.error); });\n' +
'}\n' +
'\n' +
'// ===== \u914d\u7f6e =====\n' +
'function loadConfig() {\n' +
'  fetch("/api/config").then(function(r){return r.json()}).then(function(d) {\n' +
'    var html = \'<div class="cards">\';\n' +
'    html += card("\u{1f9e0} \u5f53\u524d\u6a21\u578b", d.ollamaModel || "-", "\u9ed8\u8ba4 API: " + (d.defaultApi || "-"));\n' +
'    html += card("\u{1f511} SiliconFlow", d.siliconFlowKey, "");\n' +
'    html += card("\u{1f511} DeepSeek", d.deepseekKey, "");\n' +
'    html += card("\u{1f310} \u8bed\u8a00", d.language, "");\n' +
'    html += card("\u{1f50a} \u81ea\u52a8\u6717\u8bfb", d.autoRead ? "\u5f00\u542f" : "\u5173\u95ed", "");\n' +
'    html += \'</div>\';\n' +
'    if (d.availableModels && d.availableModels.length) {\n' +
'      html += \'<div style="margin-top:20px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">\u53ef\u7528\u6a21\u578b</div>\';\n' +
'      html += \'<div style="display:flex;flex-wrap:wrap;gap:6px">\';\n' +
'      d.availableModels.forEach(function(m) { html += \'<span class="badge file">\' + m + \'</span>\'; });\n' +
'      html += \'</div></div>\';\n' +
'    }\n' +
'    document.getElementById("panel-config").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-config").innerHTML = errBox(e); });\n' +
'}\n' +
'\n' +
'// ===== \u65e5\u5fd7 =====\n' +
'function loadLogs() {\n' +
'  fetch("/api/logs").then(function(r){return r.json()}).then(function(logs) {\n' +
'    var html = \'<div style="margin-bottom:14px;display:flex;gap:8px">\';\n' +
'    html += \'<button style="padding:6px 14px;border-radius:6px;border:1px solid var(--yellow);background:transparent;color:var(--yellow);font-size:12px;cursor:pointer" onclick="restartGateway()">\u26a0\ufe0f \u91cd\u542f Gateway</button>\';\n' +
'    html += \'<button style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text2);font-size:12px;cursor:pointer" onclick="loadLogs()">\u21bb \u5237\u65b0</button>\';\n' +
'    html += \'</div>\';\n' +
'    if (!logs.length) { html += \'<div class="empty">\u6682\u65e0\u65e5\u5fd7\u8bb0\u5f55<br><br>\u8bbe\u5907\u4e0a\u4e0b\u7ebf\u3001AI \u9519\u8bef\u7b49\u4e8b\u4ef6\u4f1a\u81ea\u52a8\u8bb0\u5f55\u5230\u6b64\u5904</div>\'; }\n' +
'    else {\n' +
'      html += \'<div style="max-height:500px;overflow-y:auto;font-family:monospace;font-size:12px;line-height:1.8">\';\n' +
'      logs.forEach(function(l) {\n' +
'        var color = l.level === "error" ? "var(--red)" : l.level === "warn" ? "var(--yellow)" : "var(--text2)";\n' +
'        html += \'<div style="padding:4px 8px;border-bottom:1px solid var(--border)"><span style="color:var(--text3)">\' + fmtTime(l.time) + \'</span> <span style="color:\' + color + \'">[\' + l.level + \']</span> \' + escHtml(l.msg) + \'</div>\';\n' +
'      });\n' +
'      html += \'</div>\';\n' +
'    }\n' +
'    document.getElementById("panel-logs").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-logs").innerHTML = errBox(e); });\n' +
'}\n' +
'function restartGateway() {\n' +
'  if (!confirm("\u786e\u5b9a\u91cd\u542f Gateway \u670d\u52a1\uff1f\u8fde\u63a5\u4e2d\u7684\u8bbe\u5907\u4f1a\u65ad\u5f00\u3002")) return;\n' +
'  fetch("/api/gateway/restart", { method:"POST" }).then(function(r){return r.json()}).then(function(d) {\n' +
'    alert(d.message || d.error);\n' +
'  });\n' +
'}\n' +
'\n' +
'// ===== \u7cfb\u7edf =====\n' +
'function loadSystem() {\n' +
'  fetch("/api/system").then(function(r){return r.json()}).then(function(d) {\n' +
'    var html = \'<div class="sys-grid">\';\n' +
'    html += sysItem("\u5e73\u53f0", d.platform + " / " + d.arch);\n' +
'    html += sysItem("Node.js", d.nodeVersion);\n' +
'    html += sysItem("Electron", d.electronVersion || "-");\n' +
'    html += sysItem("PID", d.pid);\n' +
'    html += sysItem("\u8fd0\u884c\u65f6\u95f4", fmtUptime(d.uptime));\n' +
'    html += sysItem("\u5185\u5b58 (RSS)", fmtMem(d.memory.rss));\n' +
'    html += sysItem("\u5806\u5185\u5b58", fmtMem(d.memory.heapUsed) + " / " + fmtMem(d.memory.heapTotal));\n' +
'    html += sysItem("\u6a21\u5757\u6570", d.moduleCount);\n' +
'    html += sysItem("\u5de5\u4f5c\u76ee\u5f55", d.cwd);\n' +
'    html += \'</div>\';\n' +
'    html += \'<div style="margin-top:20px"><div style="font-size:13px;font-weight:600;margin-bottom:10px">\u5df2\u52a0\u8f7d\u6a21\u5757</div>\';\n' +
'    html += \'<div style="display:flex;flex-wrap:wrap;gap:6px">\';\n' +
'    (d.modules||[]).forEach(function(m) { html += \'<span class="badge file">\' + m + \'</span>\'; });\n' +
'    html += \'</div></div>\';\n' +
'    document.getElementById("panel-system").innerHTML = html;\n' +
'  }).catch(function(e){ document.getElementById("panel-system").innerHTML = errBox(e); });\n' +
'}\n' +
'function sysItem(label, val) { return \'<div class="sys-item"><div class="sys-label">\' + label + \'</div><div class="sys-val">\' + val + \'</div></div>\'; }\n' +
'\n' +
'function errBox(e) { return \'<div class="empty">\u52a0\u8f7d\u5931\u8d25: \' + e.message + \'<br><br>\u8bf7\u786e\u4fdd AI Agent Pro \u5df2\u542f\u52a8</div>\'; }\n' +
'function escHtml(s) { var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }\n' +
'\n' +
'// \u521d\u59cb\u52a0\u8f7d + \u81ea\u52a8\u5237\u65b0\n' +
'refresh();\n' +
'setInterval(function(){ refresh(); }, 15000);\n' +
'\n' +
'// ===== WebSocket \u5b9e\u65f6\u8bbe\u5907\u72b6\u6001 =====\n' +
'var wsLive = null;\n' +
'function connectWS() {\n' +
'  var wsPort = location.port === "18791" ? "18789" : (parseInt(location.port||"18791") - 2);\n' +
'  var wsUrl = "ws://" + location.hostname + ":" + wsPort;\n' +
'  try { wsLive = new WebSocket(wsUrl); } catch(e) { return; }\n' +
'  wsLive.onopen = function() {\n' +
'    wsLive.send(JSON.stringify({ type:"device_register", deviceId:"admin-dashboard", deviceType:"web", os:navigator.platform, capabilities:["display"] }));\n' +
'    document.querySelector(".logo .dot").style.background = "var(--green)";\n' +
'  };\n' +
'  wsLive.onmessage = function(ev) {\n' +
'    try {\n' +
'      var msg = JSON.parse(ev.data);\n' +
'      if (msg.type === "device_update" || msg.type === "device_list") {\n' +
'        if (currentPanel === "devices" || currentPanel === "overview") refresh();\n' +
'      }\n' +
'    } catch(e) {}\n' +
'  };\n' +
'  wsLive.onclose = function() {\n' +
'    document.querySelector(".logo .dot").style.background = "var(--red)";\n' +
'    setTimeout(connectWS, 5000);\n' +
'  };\n' +
'  wsLive.onerror = function() {};\n' +
'}\n' +
'connectWS();\n' +
'\n' +
'// \u5fc3\u8df3\u4fdd\u6d3b\n' +
'setInterval(function() { if (wsLive && wsLive.readyState === 1) wsLive.send(JSON.stringify({type:"heartbeat"})); }, 30000);\n' +
'</script>\n</body>\n</html>';
}

// ===== 启动 HTTP 服务 =====
function startAdminServer() {
  if (adminServer) return;
  try { http = require('http'); } catch (e) { return; }

  adminServer = http.createServer(handleRequest);
  adminServer.listen(ADMIN_PORT, '0.0.0.0', function() {
    console.log('\u{1f5a5}\ufe0f [admin-ui] Gateway \u7ba1\u7406\u540e\u53f0: http://0.0.0.0:' + ADMIN_PORT + '/admin');
  });
  adminServer.on('error', function(e) {
    if (e.code === 'EADDRINUSE') {
      ADMIN_PORT++;
      adminServer.listen(ADMIN_PORT, '0.0.0.0');
    }
  });
}

// ===== 命令注册 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('admin', {
    zh: '\u7ba1\u7406\u540e\u53f0: /admin open|status',
    en: 'Admin dashboard'
  }, function(args) {
    var sub = (args || '').trim() || 'status';
    if (sub === 'open') {
      try { require('electron').shell.openExternal('http://localhost:' + ADMIN_PORT + '/admin'); } catch (e) {}
      showMsg('\u5df2\u5728\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00\u7ba1\u7406\u540e\u53f0');
    } else {
      showMsg('\u{1f5a5}\ufe0f Gateway \u7ba1\u7406\u540e\u53f0\n\u5730\u5740: http://localhost:' + ADMIN_PORT + '/admin\n\u72b6\u6001: ' + (adminServer ? '\u8fd0\u884c\u4e2d' : '\u672a\u542f\u52a8') + '\n\n\u5c40\u57df\u7f51\u8bbf\u95ee: http://<PC_IP>:' + ADMIN_PORT + '/admin');
    }
  });
}

function showMsg(text) {
  var id = Core.session.getCurrentId();
  if (id && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(id);
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  registerCommands();
  startAdminServer();
  registerLogListeners();
  console.log('\u2705 admin-ui.js \u5df2\u52a0\u8f7d | \u7ba1\u7406\u540e\u53f0\u7aef\u53e3: ' + ADMIN_PORT);
}

module.exports = {
  name: 'admin-ui',
  dependencies: ['gateway', 'skill', 'session'],
  init: init
};
