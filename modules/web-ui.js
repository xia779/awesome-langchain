// modules/web-ui.js - Web Control UI（浏览器聊天界面 + 设备面板）
// 通过 Gateway 的 HTTP 端口提供响应式 Web 前端，手机/平板/浏览器均可访问
'use strict';

var Core = null;
var fs = null;
var path = null;
var http = null;

var WEB_PORT = 18790; // HTTP 服务端口（WebSocket 在 18789）
var httpServer = null;

// ===== 内嵌 HTML 前端（单文件，无需额外静态资源）=====
function getHtmlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>AI Agent Pro - Web</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
:root { --bg:#0f172a; --surface:#1e293b; --border:#334155; --text:#e2e8f0; --text2:#94a3b8; --primary:#3b82f6; --primary2:#2563eb; --green:#22c55e; --red:#ef4444; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
.header { padding:12px 16px; background:var(--surface); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
.header h1 { font-size:16px; font-weight:600; }
.header .status { font-size:12px; color:var(--green); display:flex; align-items:center; gap:4px; }
.header .status::before { content:''; width:8px; height:8px; border-radius:50%; background:var(--green); }
.header .status.offline { color:var(--red); }
.header .status.offline::before { background:var(--red); }
.devices-bar { padding:8px 16px; background:var(--surface); border-bottom:1px solid var(--border); display:flex; gap:8px; overflow-x:auto; font-size:11px; }
.device-chip { padding:3px 8px; border-radius:12px; background:var(--border); white-space:nowrap; }
.device-chip.online { background:rgba(34,197,94,0.15); color:var(--green); }
.chat-area { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
.msg { max-width:85%; padding:10px 14px; border-radius:12px; font-size:14px; line-height:1.6; word-break:break-word; white-space:pre-wrap; }
.msg.user { align-self:flex-end; background:var(--primary); color:#fff; border-bottom-right-radius:4px; }
.msg.ai { align-self:flex-start; background:var(--surface); border:1px solid var(--border); border-bottom-left-radius:4px; }
.msg.system { align-self:center; background:transparent; color:var(--text2); font-size:12px; padding:4px; }
.msg .meta { font-size:10px; color:var(--text2); margin-top:4px; }
.input-area { padding:12px 16px; background:var(--surface); border-top:1px solid var(--border); display:flex; gap:8px; }
.input-area input { flex:1; padding:10px 14px; border-radius:20px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:14px; outline:none; }
.input-area input:focus { border-color:var(--primary); }
.input-area button { width:40px; height:40px; border-radius:50%; border:none; background:var(--primary); color:#fff; font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.input-area button:disabled { opacity:0.4; cursor:not-allowed; }
.typing-indicator { align-self:flex-start; padding:8px 14px; background:var(--surface); border-radius:12px; font-size:12px; color:var(--text2); display:none; }
.typing-indicator.active { display:block; }
@media(max-width:600px) { .msg { max-width:92%; } .header h1 { font-size:14px; } }
</style>
</head>
<body>
<div class="header">
  <h1>AI Agent Pro</h1>
  <div class="status" id="connStatus">连接中...</div>
</div>
<div class="devices-bar" id="devicesBar"><span class="device-chip">等待设备...</span></div>
<div class="chat-area" id="chatArea"></div>
<div class="typing-indicator" id="typingInd">AI 正在思考...</div>
<div class="input-area">
  <input type="text" id="msgInput" placeholder="输入消息..." autocomplete="off">
  <button id="sendBtn" onclick="sendMsg()">&#10148;</button>
</div>
<script>
var ws = null;
var heartbeatTimer = null;
var deviceId = 'web_' + Math.random().toString(36).substring(2,8);
var chatArea = document.getElementById('chatArea');
var msgInput = document.getElementById('msgInput');
var sendBtnEl = document.getElementById('sendBtn');
var connStatus = document.getElementById('connStatus');
var typingInd = document.getElementById('typingInd');
var devicesBar = document.getElementById('devicesBar');

function connect() {
  var wsUrl = 'ws://' + location.hostname + ':18789';
  ws = new WebSocket(wsUrl);
  ws.onopen = function() {
    connStatus.textContent = '已连接';
    connStatus.className = 'status';
    ws.send(JSON.stringify({ type:'device_register', deviceId:deviceId, deviceType:'web', os:navigator.platform, capabilities:['display','input'] }));
    // 💓 心跳保活：每 30s 发一次，避免被网关 90s 超时踢下线（修复频繁离线重连）
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(function() {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'heartbeat' }));
    }, 30000);
  };
  ws.onclose = function() {
    connStatus.textContent = '已断开';
    connStatus.className = 'status offline';
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    setTimeout(connect, 3000);
  };
  ws.onmessage = function(e) {
    var msg = JSON.parse(e.data);
    handleMsg(msg);
  };
}

function handleMsg(msg) {
  if (msg.type === 'ui_event') {
    if (msg.event === 'ui:message') {
      addMsg(msg.data.role === 'user' ? 'user' : 'ai', msg.data.content);
      typingInd.className = 'typing-indicator';
    }
    if (msg.event === 'ui:stream') {
      typingInd.className = 'typing-indicator active';
    }
    if (msg.event === 'ui:typing') {
      typingInd.className = 'typing-indicator' + (msg.data.active ? ' active' : '');
    }
    if (msg.event === 'ui:status') {
      // could show status somewhere
    }
  }
  if (msg.type === 'device_list' || msg.type === 'device_update') {
    updateDevices(msg.devices || null, msg);
  }
}

function addMsg(role, content) {
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = content;
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date().toLocaleTimeString('zh-CN');
  div.appendChild(meta);
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function updateDevices(devices, single) {
  if (devices) {
    devicesBar.innerHTML = '';
    devices.forEach(function(d) {
      var chip = document.createElement('span');
      chip.className = 'device-chip' + (d.status === 'online' ? ' online' : '');
      chip.textContent = d.deviceId + ' (' + d.type + ')';
      devicesBar.appendChild(chip);
    });
  } else if (single && single.deviceId) {
    var chip = document.createElement('span');
    chip.className = 'device-chip' + (single.status === 'online' ? ' online' : '');
    chip.textContent = single.deviceId + ' (' + (single.capabilities||[]).length + ' caps)';
    devicesBar.appendChild(chip);
  }
}

function sendMsg() {
  var text = msgInput.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type:'chat_message', text:text, deviceId:deviceId }));
  addMsg('user', text);
  msgInput.value = '';
}

msgInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendMsg(); });
connect();
</script>
</body>
</html>`;
}

// ===== HTTP 服务 =====
function startHttpServer() {
  if (httpServer) return;
  try {
    http = require('http');
  } catch (e) {
    console.warn('[web-ui] http 模块不可用');
    return;
  }

  httpServer = http.createServer(function(req, res) {
    // 只服务根路径（单页应用）
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtmlPage());
    } else if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Core.gateway ? Core.gateway.getStatus() : { running: false }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  // 🔒 默认仅监听本地，通过 AI_AGENT_BIND_HOST 环境变量可覆盖
  var BIND_HOST = process.env.AI_AGENT_BIND_HOST || '127.0.0.1';

  httpServer.listen(WEB_PORT, BIND_HOST, function() {
    console.log('🌐 [web-ui] Web Control UI: http://' + BIND_HOST + ':' + WEB_PORT);
  });

  httpServer.on('error', function(e) {
    if (e.code === 'EADDRINUSE') {
      WEB_PORT++;
      httpServer.listen(WEB_PORT, BIND_HOST);
    }
  });
}

// ===== 命令 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('webui', {
    zh: 'Web UI: /webui open|status',
    en: 'Web Control UI'
  }, function(args) {
    var sub = (args || '').trim() || 'status';
    if (sub === 'status') {
      showMsg('🌐 Web Control UI\n地址: http://localhost:' + WEB_PORT + '\n状态: ' + (httpServer ? '运行中' : '未启动') + '\n\n手机/平板访问: http://<PC_IP>:' + WEB_PORT);
    } else if (sub === 'open') {
      try { require('electron').shell.openExternal('http://localhost:' + WEB_PORT); } catch (e) { console.warn('⚠️ [web-ui] 操作失败:', e.message || e); }
      showMsg('已在浏览器中打开 Web UI');
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
  try { fs = require('fs'); path = require('path'); } catch(e) { return; }

  registerCommands();
  setTimeout(startHttpServer, 4000); // 等 gateway 先启动

  Core.webUI = { port: WEB_PORT, getPage: getHtmlPage };
  console.log('✅ web-ui.js 已加载 | Web UI 端口: ' + WEB_PORT);
}

module.exports = { name: 'web-ui', dependencies: ['gateway', 'custom', 'session'], init: init };
