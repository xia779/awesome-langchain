// modules/gateway.js - WebSocket 网关（多设备接入 + 命令路由 + 事件广播）
// Stage 1 核心：让 PC 成为 Gateway 节点，手机/Web/开发板通过 WebSocket 接入
'use strict';

var Core = null;
var fs = null;
var path = null;

// ===== 配置 =====
var GATEWAY_PORT = 18789;  // 与 OpenClaw 同端口（致敬 + 兼容）
var GATEWAY_HOST = '0.0.0.0'; // 监听所有网卡（局域网设备可连）
var HEARTBEAT_INTERVAL = 30000; // 心跳间隔 30s
var DEVICE_TIMEOUT = 90000; // 设备超时 90s 无心跳视为离线

// ===== 状态 =====
var wss = null;           // WebSocket Server 实例
var clients = new Map();  // ws -> { deviceId, type, capabilities, lastHeartbeat, authenticated }
var deviceRegistry = {};  // deviceId -> { type, os, capabilities[], status, lastSeen, ws }
var serverStarted = false;

// ===== 消息协议定义 =====
// 客户端 → Gateway:
//   { type: "device_register", deviceId, deviceType, os, capabilities[] }
//   { type: "chat_message", text, sessionId? }
//   { type: "tool_result", callId, result, success }
//   { type: "heartbeat" }
//   { type: "command", action, params, targetDevice? }
//
// Gateway → 客户端:
//   { type: "welcome", gatewayVersion, deviceId }
//   { type: "chat_response", role, content, streaming, sessionId }
//   { type: "ui_event", event, data }  (Core.ui 事件转发)
//   { type: "tool_call", callId, tool, params, sourceDevice }
//   { type: "device_list", devices[] }
//   { type: "device_update", deviceId, status, capabilities }
//   { type: "error", message, code }
//   { type: "pong" }

// ===== 启动 WebSocket 服务 =====
function startServer() {
  if (serverStarted) return;

  var WebSocket;
  try {
    WebSocket = require('ws');
  } catch (e) {
    console.warn('[gateway] ws 模块未安装，网关不可用。运行: npm install ws');
    return;
  }

  try {
    wss = new WebSocket.Server({
      host: GATEWAY_HOST,
      port: GATEWAY_PORT
    });
  } catch (e) {
    console.error('[gateway] 启动 WebSocket 服务失败:', e.message);
    if (e.code === 'EADDRINUSE') {
      console.warn('[gateway] 端口 ' + GATEWAY_PORT + ' 被占用，尝试 ' + (GATEWAY_PORT + 1));
      GATEWAY_PORT++;
      try {
        wss = new WebSocket.Server({ host: GATEWAY_HOST, port: GATEWAY_PORT });
      } catch (e2) {
        console.error('[gateway] 备用端口也失败，网关未启动');
        return;
      }
    } else {
      return;
    }
  }

  serverStarted = true;
  console.log('🌐 [gateway] WebSocket 网关已启动: ws://' + GATEWAY_HOST + ':' + GATEWAY_PORT);

  wss.on('connection', function(ws, req) {
    var clientIp = req.socket.remoteAddress || 'unknown';
    console.log('[gateway] 新连接: ' + clientIp);

    // 初始化客户端状态
    clients.set(ws, {
      deviceId: null,
      type: 'unknown',
      capabilities: [],
      lastHeartbeat: Date.now(),
      authenticated: false,
      ip: clientIp
    });

    // 发送欢迎消息
    sendToClient(ws, {
      type: 'welcome',
      gatewayVersion: '1.0.0',
      message: 'AI Agent Gateway ready',
      time: Date.now()
    });

    // 消息处理
    ws.on('message', function(raw) {
      var msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        sendToClient(ws, { type: 'error', message: 'Invalid JSON', code: 'PARSE_ERROR' });
        return;
      }
      handleMessage(ws, msg);
    });

    // 断开处理
    ws.on('close', function() {
      var client = clients.get(ws);
      if (client && client.deviceId) {
        setDeviceOffline(client.deviceId);
      }
      clients.delete(ws);
      console.log('[gateway] 连接断开: ' + clientIp);
    });

    ws.on('error', function(err) {
      console.warn('[gateway] 连接错误:', err.message);
    });

    // 💓 WS 协议级 pong：浏览器等标准客户端收到 ping 会自动回 pong，借此刷新心跳，无需客户端写心跳代码
    ws.on('pong', function() {
      var c = clients.get(ws);
      if (c) c.lastHeartbeat = Date.now();
    });
  });

  // 心跳检测定时器：主动 ping 保活 + 超时清理
  setInterval(function() {
    var now = Date.now();
    clients.forEach(function(client, ws) {
      if (now - client.lastHeartbeat > DEVICE_TIMEOUT) {
        if (client.deviceId) setDeviceOffline(client.deviceId);
        clients.delete(ws);
        try { ws.close(); } catch (e) {}
        return;
      }
      // 主动发 ping，标准 WS 客户端自动回 pong（触发 ws.on('pong') 刷新 lastHeartbeat），避免误判离线
      try { ws.ping(); } catch (e) {}
    });
  }, HEARTBEAT_INTERVAL);

  // 监听 Core.ui 事件并广播给所有客户端
  registerEventBridge();
}

// ===== 消息路由 =====
function handleMessage(ws, msg) {
  var client = clients.get(ws);
  if (!client) return;

  switch (msg.type) {
    case 'device_register':
      handleDeviceRegister(ws, client, msg);
      break;

    case 'heartbeat':
      client.lastHeartbeat = Date.now();
      sendToClient(ws, { type: 'pong', time: Date.now() });
      break;

    case 'chat_message':
      handleChatMessage(ws, client, msg);
      break;

    case 'tool_result':
      handleToolResult(ws, client, msg);
      break;

    case 'command':
      handleCommand(ws, client, msg);
      break;

    case 'get_devices':
      sendDeviceList(ws);
      break;

    default:
      sendToClient(ws, { type: 'error', message: 'Unknown message type: ' + msg.type, code: 'UNKNOWN_TYPE' });
  }
}

// ===== 设备注册 =====
function handleDeviceRegister(ws, client, msg) {
  var deviceId = msg.deviceId || 'device_' + Date.now().toString(36);
  var deviceType = msg.deviceType || msg.type || 'unknown';
  var os = msg.os || 'unknown';
  var capabilities = msg.capabilities || [];

  // 更新客户端状态
  client.deviceId = deviceId;
  client.type = deviceType;
  client.capabilities = capabilities;
  client.authenticated = true;

  // 更新设备注册表
  deviceRegistry[deviceId] = {
    type: deviceType,
    os: os,
    capabilities: capabilities,
    status: 'online',
    lastSeen: Date.now(),
    ip: client.ip,
    ws: ws
  };

  console.log('[gateway] 设备注册: ' + deviceId + ' (' + deviceType + ', ' + os + ') 能力: [' + capabilities.join(', ') + ']');

  // 通知设备注册成功
  sendToClient(ws, {
    type: 'device_registered',
    deviceId: deviceId,
    message: '注册成功',
    time: Date.now()
  });

  // 广播设备上线
  broadcastDeviceUpdate(deviceId, 'online', capabilities);

  // 发送当前设备列表
  sendDeviceList(ws);

  // 触发 Core 事件
  if (Core.ui) Core.ui.deviceStatus(deviceId, 'online', capabilities);
}

// ===== 聊天消息处理 =====
function handleChatMessage(ws, client, msg) {
  var text = msg.text || msg.message || msg.content || '';
  if (!text.trim()) {
    sendToClient(ws, { type: 'error', message: '消息内容为空', code: 'EMPTY_MESSAGE' });
    return;
  }

  console.log('[gateway] 收到消息 [' + (client.deviceId || 'unknown') + ']: ' + text.substring(0, 50));

  // 立即确认收到，让客户端知道消息已送达
  sendToClient(ws, { type: 'chat_ack', text: text, time: Date.now() });

  // 将消息注入到 AI Agent 的处理流程
  if (Core.api && Core.api.sendMessage) {
    // 检查是否可发送（避免 sendMessage 早期返回导致客户端无感知）
    if (Core.api.isGenerating && Core.api.isGenerating()) {
      sendToClient(ws, { type: 'error', message: 'AI 正在生成中，请稍后再试', code: 'BUSY' });
      return;
    }
    // 设置输入框内容并触发发送
    if (Core.dom && Core.dom.input) {
      Core.dom.input.value = text;
    }
    // 异步执行（不阻塞 WebSocket），响应通过 Core.ui 事件桥自动广播
    Core.api.sendMessage().then(function() {
      // sendMessage 正常完成，Core.ui 事件桥已广播 AI 回复
    }).catch(function(e) {
      console.error('[gateway] AI 处理失败:', e.message);
      sendToClient(ws, { type: 'error', message: 'AI 处理失败: ' + e.message, code: 'AI_ERROR' });
    });
  } else {
    sendToClient(ws, { type: 'error', message: 'AI 引擎未就绪', code: 'NOT_READY' });
  }
}

// ===== 工具执行结果回传 =====
var pendingToolCalls = {}; // callId -> { resolve, reject, timeout }

function handleToolResult(ws, client, msg) {
  var callId = msg.callId;
  if (!callId || !pendingToolCalls[callId]) return;

  var pending = pendingToolCalls[callId];
  clearTimeout(pending.timeout);
  delete pendingToolCalls[callId];

  if (msg.success !== false) {
    pending.resolve(msg.result);
  } else {
    pending.reject(new Error(msg.error || 'Tool execution failed'));
  }
}

// ===== 跨设备命令 =====
function handleCommand(ws, client, msg) {
  var action = msg.action || '';
  var params = msg.params || {};
  var targetDevice = msg.targetDevice || null;

  if (!targetDevice) {
    // 无指定目标 → 本地执行
    executeLocalTool(action, params).then(function(result) {
      sendToClient(ws, { type: 'tool_result', callId: msg.callId, result: result, success: true });
    }).catch(function(e) {
      sendToClient(ws, { type: 'tool_result', callId: msg.callId, error: e.message, success: false });
    });
    return;
  }

  // 路由到目标设备
  routeToolCall(targetDevice, action, params, client.deviceId).then(function(result) {
    sendToClient(ws, { type: 'tool_result', callId: msg.callId, result: result, success: true });
  }).catch(function(e) {
    sendToClient(ws, { type: 'tool_result', callId: msg.callId, error: e.message, success: false });
  });
}

// ===== 工具路由：发送 tool_call 到目标设备 =====
function routeToolCall(targetDeviceId, tool, params, sourceDeviceId) {
  return new Promise(function(resolve, reject) {
    var device = deviceRegistry[targetDeviceId];
    if (!device || device.status !== 'online' || !device.ws) {
      reject(new Error('设备 ' + targetDeviceId + ' 不在线'));
      return;
    }

    var callId = 'call_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);

    // 设置超时
    var timeout = setTimeout(function() {
      delete pendingToolCalls[callId];
      reject(new Error('工具调用超时 (30s): ' + tool));
    }, 30000);

    pendingToolCalls[callId] = { resolve: resolve, reject: reject, timeout: timeout };

    // 发送 tool_call 到目标设备
    sendToClient(device.ws, {
      type: 'tool_call',
      callId: callId,
      tool: tool,
      params: params,
      sourceDevice: sourceDeviceId || 'gateway',
      time: Date.now()
    });
  });
}

// ===== 本地工具执行 =====
function executeLocalTool(tool, params) {
  return new Promise(function(resolve, reject) {
    // 优先使用 toolsRegistry
    if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
      Core.toolsRegistry.executeTool(tool, params).then(resolve).catch(reject);
      return;
    }
    // 回退：Agent 工具
    if (Core.agentLoop && Core.agentLoop.executeAction) {
      Core.agentLoop.executeAction(tool, params).then(resolve).catch(reject);
      return;
    }
    reject(new Error('无可用工具执行器: ' + tool));
  });
}

// ===== 事件桥：Core.ui 事件 → WebSocket 广播 =====
function registerEventBridge() {
  var uiEvents = ['ui:status', 'ui:message', 'ui:stream', 'ui:input', 'ui:sendState',
                  'ui:typing', 'ui:notify', 'ui:title', 'ui:session', 'ui:agentStep'];

  uiEvents.forEach(function(eventName) {
    Core.on(eventName, function(data) {
      broadcast({ type: 'ui_event', event: eventName, data: data });
    });
  });

  // Gateway 专属事件
  Core.on('gateway:toolCall', function(data) {
    if (data.targetDevice) {
      routeToolCall(data.targetDevice, data.tool, data.params, 'gateway').catch(function(e) {
        console.warn('[gateway] 工具路由失败:', e.message);
      });
    }
  });

  Core.on('gateway:device', function(data) {
    broadcast({ type: 'device_update', deviceId: data.deviceId, status: data.status, capabilities: data.capabilities });
  });

  // AI 出错回传：api.js 在 AI 调用失败时 emit 'ai:error'，转发给所有 WS 客户端（修复此前出错静默无响应）
  Core.on('ai:error', function(data) {
    broadcast({
      type: 'error',
      message: 'AI 处理失败: ' + (data.message || '未知错误'),
      code: 'AI_ERROR',
      context: data.context || 'chat',
      time: Date.now()
    });
  });
}

// ===== 广播工具 =====
function sendToClient(ws, msg) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(JSON.stringify(msg));
    }
  } catch (e) {
    console.warn('[gateway] 发送失败:', e.message);
  }
}

function broadcast(msg) {
  var data = JSON.stringify(msg);
  clients.forEach(function(client, ws) {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch (e) {}
  });
}

function broadcastDeviceUpdate(deviceId, status, capabilities) {
  broadcast({
    type: 'device_update',
    deviceId: deviceId,
    status: status,
    capabilities: capabilities || [],
    time: Date.now()
  });
}

function sendDeviceList(ws) {
  var devices = [];
  for (var id in deviceRegistry) {
    var d = deviceRegistry[id];
    devices.push({
      deviceId: id,
      type: d.type,
      os: d.os,
      capabilities: d.capabilities,
      status: d.status,
      lastSeen: d.lastSeen
    });
  }
  sendToClient(ws, { type: 'device_list', devices: devices, time: Date.now() });
}

function setDeviceOffline(deviceId) {
  if (deviceRegistry[deviceId]) {
    deviceRegistry[deviceId].status = 'offline';
    deviceRegistry[deviceId].ws = null;
    console.log('[gateway] 设备离线: ' + deviceId);
    broadcastDeviceUpdate(deviceId, 'offline', deviceRegistry[deviceId].capabilities);
    if (Core.ui) Core.ui.deviceStatus(deviceId, 'offline', deviceRegistry[deviceId].capabilities);
  }
}

// ===== 查询接口 =====
function getOnlineDevices() {
  var online = [];
  for (var id in deviceRegistry) {
    if (deviceRegistry[id].status === 'online') {
      online.push({ deviceId: id, type: deviceRegistry[id].type, capabilities: deviceRegistry[id].capabilities });
    }
  }
  return online;
}

function getDeviceByCapability(capability) {
  for (var id in deviceRegistry) {
    var d = deviceRegistry[id];
    if (d.status === 'online' && d.capabilities.indexOf(capability) >= 0) {
      return { deviceId: id, type: d.type, capabilities: d.capabilities };
    }
  }
  return null;
}

function getGatewayStatus() {
  return {
    running: serverStarted,
    port: GATEWAY_PORT,
    host: GATEWAY_HOST,
    connectedClients: clients.size,
    registeredDevices: Object.keys(deviceRegistry).length,
    onlineDevices: getOnlineDevices().length
  };
}

// ===== 命令注册 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('gateway', {
    zh: '网关管理: /gateway status|devices|restart',
    en: 'Gateway management'
  }, function(args) {
    var sub = (args || '').trim().split(/\s+/)[0] || 'status';

    if (sub === 'status') {
      var st = getGatewayStatus();
      var text = '🌐 **Gateway 状态**\n\n';
      text += '运行: ' + (st.running ? '✅ 是' : '❌ 否') + '\n';
      text += '地址: ws://' + st.host + ':' + st.port + '\n';
      text += '连接客户端: ' + st.connectedClients + '\n';
      text += '注册设备: ' + st.registeredDevices + '\n';
      text += '在线设备: ' + st.onlineDevices + '\n';
      showMsg(text);
      return;
    }

    if (sub === 'devices') {
      var devices = [];
      for (var id in deviceRegistry) {
        devices.push(deviceRegistry[id]);
      }
      if (devices.length === 0) {
        showMsg('暂无注册设备。\n\n手机/开发板连接 ws://<PC_IP>:' + GATEWAY_PORT + ' 后发送 device_register 即可注册。');
        return;
      }
      var text = '📱 **设备列表**\n\n';
      for (var id in deviceRegistry) {
        var d = deviceRegistry[id];
        var icon = d.status === 'online' ? '🟢' : '⚪';
        text += icon + ' **' + id + '** (' + d.type + ', ' + d.os + ')\n';
        text += '   能力: [' + d.capabilities.join(', ') + ']\n';
        text += '   状态: ' + d.status + ' | IP: ' + (d.ip || '-') + '\n\n';
      }
      showMsg(text);
      return;
    }

    if (sub === 'restart') {
      stopServer();
      setTimeout(function() { startServer(); }, 1000);
      showMsg('🔄 Gateway 正在重启...');
      return;
    }

    showMsg('🌐 Gateway 命令:\n/gateway status — 查看状态\n/gateway devices — 设备列表\n/gateway restart — 重启网关');
  });
}

function showMsg(text) {
  var currentId = Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(currentId);
  }
}

// ===== 停止服务 =====
function stopServer() {
  if (wss) {
    clients.forEach(function(client, ws) {
      try { ws.close(); } catch (e) {}
    });
    clients.clear();
    wss.close();
    wss = null;
    serverStarted = false;
    console.log('[gateway] WebSocket 服务已停止');
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    console.warn('[gateway] fs/path not available');
    return;
  }

  registerCommands();

  // 延迟启动（等待其他模块就绪）
  setTimeout(function() {
    startServer();
  }, 3000);

  // 暴露 API
  Core.gateway = {
    start: startServer,
    stop: stopServer,
    getStatus: getGatewayStatus,
    getOnlineDevices: getOnlineDevices,
    getDeviceByCapability: getDeviceByCapability,
    routeToolCall: routeToolCall,
    executeLocalTool: executeLocalTool,
    broadcast: broadcast,
    sendToDevice: function(deviceId, msg) {
      var device = deviceRegistry[deviceId];
      if (device && device.ws) {
        sendToClient(device.ws, msg);
        return true;
      }
      return false;
    },
    deviceRegistry: deviceRegistry
  };

  console.log('✅ gateway.js 已加载 | 端口: ' + GATEWAY_PORT + ' | 等待启动...');
}

module.exports = {
  name: 'gateway',
  dependencies: ['custom', 'session', 'api'],
  init: init
};
