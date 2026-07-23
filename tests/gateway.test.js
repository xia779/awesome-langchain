/**
 * tests/gateway.test.js — WebSocket 网关模块测试
 *
 * 覆盖: 模块结构、认证逻辑（Token 验证/超时/门控）、广播过滤、设备注册
 * 运行: node --test tests/gateway.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

// 禁止 gateway init 时自动启动 WS 服务（测试中手动控制启停）
process.env.AI_AGENT_NO_GATEWAY = '1';
// 使用随机高端口避免与运行中的应用冲突
process.env.AI_AGENT_GATEWAY_PORT = String(28700 + Math.floor(Math.random() * 100));

// 抑制 gateway 模块的 console 输出，避免干扰 test runner IPC（--test-force-exit 下会导致序列化错误）
var _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
console.log = function() {};
console.warn = function() {};
console.error = function() {};
process.on('exit', function() { console.log = _origLog; console.warn = _origWarn; console.error = _origErr; });

// gateway.js 顶层 require('crypto') 正常，require('ws') 在 startServer 内按需加载
// require('electron') 仅在 getServerToken 回退路径中使用（函数内部），不影响模块加载
var gatewayMod = require('../modules/gateway');

// ===== 模块结构 =====

test('gateway 模块导出结构', function() {
  assert.equal(gatewayMod.name, 'gateway');
  assert.ok(Array.isArray(gatewayMod.dependencies));
  assert.ok(gatewayMod.dependencies.includes('custom'));
  assert.ok(gatewayMod.dependencies.includes('session'));
  assert.ok(gatewayMod.dependencies.includes('api'));
  assert.equal(typeof gatewayMod.init, 'function');
});

test('gateway init 挂载 Core.gateway API', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'test-token-abc123'; };
  Core._currentUser = 'tester';
  Core.ui = { deviceStatus: function() {} };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return 'sess1'; }, addMessage: function() {}, renderMessages: function() {} };

  gatewayMod.init(Core);

  assert.ok(Core.gateway);
  assert.equal(typeof Core.gateway.start, 'function');
  assert.equal(typeof Core.gateway.stop, 'function');
  assert.equal(typeof Core.gateway.close, 'function');
  assert.equal(typeof Core.gateway.getStatus, 'function');
  assert.equal(typeof Core.gateway.getOnlineDevices, 'function');
  assert.equal(typeof Core.gateway.getDeviceByCapability, 'function');
  assert.equal(typeof Core.gateway.routeToolCall, 'function');
  assert.equal(typeof Core.gateway.executeLocalTool, 'function');
  assert.equal(typeof Core.gateway.broadcast, 'function');
  assert.equal(typeof Core.gateway.broadcastToUser, 'function');
  assert.equal(typeof Core.gateway.sendToDevice, 'function');
  assert.ok(Core.gateway.deviceRegistry);
  helper.cleanTestData();
});

test('gateway close 是 stop 的别名', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  assert.equal(Core.gateway.close, Core.gateway.stop);
  helper.cleanTestData();
});

// ===== 状态查询 =====

test('gateway getStatus 初始状态', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  var st = Core.gateway.getStatus();
  assert.equal(typeof st.running, 'boolean');
  assert.equal(typeof st.port, 'number');
  assert.equal(typeof st.host, 'string');
  assert.equal(typeof st.connectedClients, 'number');
  assert.equal(typeof st.registeredDevices, 'number');
  assert.equal(typeof st.onlineDevices, 'number');
  helper.cleanTestData();
});

test('gateway getOnlineDevices 初始为空数组', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  var devices = Core.gateway.getOnlineDevices();
  assert.ok(Array.isArray(devices));
  assert.equal(devices.length, 0);
  helper.cleanTestData();
});

test('gateway getDeviceByCapability 无设备返回 null', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  var result = Core.gateway.getDeviceByCapability('camera');
  assert.equal(result, null);
  helper.cleanTestData();
});

// ===== 命令注册 =====

test('gateway 注册 /gateway 命令', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  assert.ok(Core.custom._commands['gateway']);
  assert.equal(typeof Core.custom._commands['gateway'].handler, 'function');
  helper.cleanTestData();
});

// ===== 广播安全 =====

test('gateway sendToDevice 无设备返回 false', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  var result = Core.gateway.sendToDevice('nonexistent_device', { type: 'test' });
  assert.equal(result, false);
  helper.cleanTestData();
});

test('gateway broadcastToUser 不抛异常（无客户端时）', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  assert.doesNotThrow(function() {
    Core.gateway.broadcastToUser('user1', { type: 'test', data: 'hello' });
  });
  helper.cleanTestData();
});

test('gateway broadcast 不抛异常（无客户端时）', function() {
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'token'; };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  assert.doesNotThrow(function() {
    Core.gateway.broadcast({ type: 'ui_event', event: 'ui:status', data: {} });
  });
  helper.cleanTestData();
});

// ===== WebSocket 集成测试（需要 ws 模块） =====

test('gateway WebSocket 认证流程', { skip: !wsAvailable() }, async function() {
  var WebSocket = require('ws');
  var Core = helper.createMockCore();
  var TEST_TOKEN = 'secure-test-token-' + Date.now();
  Core.getAuthToken = function() { return TEST_TOKEN; };
  Core._currentUser = 'testuser';
  Core.ui = { deviceStatus: function() {} };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  Core.gateway.start();
  await waitForServer(Core);

  var port = Core.gateway.getStatus().port;
  var ws = new WebSocket('ws://127.0.0.1:' + port);
  var messages = [];
  ws.on('message', function(raw) { messages.push(JSON.parse(raw.toString())); });

  try {
    await waitForOpen(ws);

    // 1. 应收到 welcome（requireAuth: true）
    await waitForMessages(messages, 1);
    assert.equal(messages[0].type, 'welcome');
    assert.equal(messages[0].requireAuth, true);

    // 2. 未认证时发送 chat_message 应被拒绝
    ws.send(JSON.stringify({ type: 'chat_message', text: 'hello' }));
    await waitForMessages(messages, 2);
    assert.equal(messages[1].type, 'error');
    assert.equal(messages[1].code, 'NOT_AUTHENTICATED');

    // 3. 错误 token 认证失败
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong-token' }));
    await waitForMessages(messages, 3);
    assert.equal(messages[2].type, 'error');
    assert.equal(messages[2].code, 'AUTH_FAILED');

    // 4. 正确 token 认证成功
    ws.send(JSON.stringify({ type: 'auth', token: TEST_TOKEN }));
    await waitForMessages(messages, 4);
    assert.equal(messages[3].type, 'auth_ok');
    assert.equal(messages[3].userId, 'testuser');

    // 5. 认证后可以注册设备
    ws.send(JSON.stringify({ type: 'device_register', deviceId: 'phone_1', deviceType: 'phone', os: 'Android', capabilities: ['camera', 'gps'] }));
    await waitForMessages(messages, 6); // device_registered + device_list
    var regMsg = messages.find(function(m) { return m.type === 'device_registered'; });
    assert.ok(regMsg);
    assert.equal(regMsg.deviceId, 'phone_1');
  } finally {
    try { ws.close(); } catch (e) {}
    Core.gateway.stop();
    helper.cleanTestData();
  }
});

test('gateway 未认证连接不能获取设备列表', { skip: !wsAvailable() }, async function() {
  var WebSocket = require('ws');
  var Core = helper.createMockCore();
  Core.getAuthToken = function() { return 'secret-token'; };
  Core._currentUser = 'admin';
  Core.ui = { deviceStatus: function() {} };
  Core.on = function() {};
  Core.session = { getCurrentId: function() { return null; } };

  gatewayMod.init(Core);
  Core.gateway.start();
  await waitForServer(Core);

  var port = Core.gateway.getStatus().port;
  var ws = new WebSocket('ws://127.0.0.1:' + port);
  var messages = [];
  ws.on('message', function(raw) { messages.push(JSON.parse(raw.toString())); });

  try {
    await waitForOpen(ws);
    await waitForMessages(messages, 1); // welcome

    // 未认证直接请求设备列表
    ws.send(JSON.stringify({ type: 'get_devices' }));
    await waitForMessages(messages, 2);
    assert.equal(messages[1].type, 'error');
    assert.equal(messages[1].code, 'NOT_AUTHENTICATED');
  } finally {
    try { ws.close(); } catch (e) {}
    Core.gateway.stop();
    helper.cleanTestData();
  }
});

// ===== 辅助函数 =====

function wsAvailable() {
  try { require('ws'); return true; } catch (e) { return false; }
}

function waitForServer(Core) {
  return new Promise(function(resolve, reject) {
    var attempts = 0;
    function check() {
      if (Core.gateway.getStatus().running) return resolve();
      attempts++;
      if (attempts > 40) return reject(new Error('Server start timeout'));
      setTimeout(check, 50);
    }
    check();
  });
}

function waitForOpen(ws) {
  return new Promise(function(resolve, reject) {
    if (ws.readyState === 1) return resolve();
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(function() { reject(new Error('WS connect timeout')); }, 3000);
  });
}

function waitForMessages(arr, count) {
  return new Promise(function(resolve, reject) {
    var attempts = 0;
    function check() {
      if (arr.length >= count) return resolve();
      attempts++;
      if (attempts > 50) return reject(new Error('Timeout waiting for ' + count + ' msgs, got ' + arr.length));
      setTimeout(check, 50);
    }
    check();
  });
}
