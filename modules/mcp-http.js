// modules/mcp-http.js - MCP HTTP+SSE 传输层（Streamable HTTP 协议）
// 补充现有 stdio 传输层，支持通过 HTTP 连接远程 MCP 服务器
var Core = null;
var http = require('http');
var https = require('https');
var url = require('url');

// ===== HTTP 传输连接管理 =====

var httpServers = {}; // serverId -> { url, status, tools, session, eventSource }
var _httpRpcId = 0;

// ===== Streamable HTTP 传输层 =====

/**
 * 发送 JSON-RPC 请求到 MCP HTTP 服务器
 * MCP 2025 协议：POST 请求，Content-Type: application/json
 * 服务器可以返回 application/json 或 text/event-stream (SSE)
 */
function sendHttpRpc(serverId, method, params) {
  return new Promise(function (resolve, reject) {
    var server = httpServers[serverId];
    if (!server || server.status !== 'connected') {
      reject(new Error('HTTP 服务器 ' + serverId + ' 未连接'));
      return;
    }

    var id = ++_httpRpcId;
    var request = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params || {},
    };

    var parsedUrl = url.parse(server.url);
    var client = parsedUrl.protocol === 'https:' ? https : http;
    var body = JSON.stringify(request);

    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    };

    // 添加会话 ID（如果有）
    if (server.sessionId) {
      headers['Mcp-Session-Id'] = server.sessionId;
    }

    // 添加认证头（如果配置了）
    if (server.config && server.config.authToken) {
      headers['Authorization'] = 'Bearer ' + server.config.authToken;
    }
    if (server.config && server.config.apiKey) {
      headers['X-API-Key'] = server.config.apiKey;
    }

    var options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.path || '/mcp',
      method: 'POST',
      headers: headers,
      timeout: 30000,
    };

    var req = client.request(options, function (res) {
      // 捕获 session ID
      if (res.headers['mcp-session-id']) {
        server.sessionId = res.headers['mcp-session-id'];
      }

      var contentType = res.headers['content-type'] || '';
      var chunks = [];

      res.on('data', function (chunk) { chunks.push(chunk); });

      res.on('end', function () {
        var responseBody = Buffer.concat(chunks).toString('utf8');

        // JSON 响应
        if (contentType.indexOf('application/json') >= 0) {
          try {
            var response = JSON.parse(responseBody);
            if (response.error) {
              reject(new Error(response.error.message || 'RPC 错误'));
            } else {
              resolve(response.result !== undefined ? response.result : response);
            }
          } catch (e) {
            reject(new Error('JSON 解析失败: ' + e.message));
          }
          return;
        }

        // SSE 响应
        if (contentType.indexOf('text/event-stream') >= 0) {
          var result = parseSseResponse(responseBody, id);
          if (result.error) {
            reject(new Error(result.error.message || 'SSE 错误'));
          } else if (result.value !== undefined) {
            resolve(result.value);
          } else {
            resolve({ success: true });
          }
          return;
        }

        // 其他响应类型
        try {
          var parsed = JSON.parse(responseBody);
          resolve(parsed.result !== undefined ? parsed.result : parsed);
        } catch (e) {
          resolve({ success: true, raw: responseBody.substring(0, 500) });
        }
      });
    });

    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error('HTTP RPC 超时')); });
    req.write(body);
    req.end();
  });
}

/**
 * 解析 SSE 响应体，提取对应 ID 的结果
 * SSE 格式：
 * event: message
 * data: {"jsonrpc":"2.0","id":1,"result":{...}}
 */
function parseSseResponse(body, targetId) {
  var lines = body.split('\n');
  var lastData = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.startsWith('data: ')) {
      var jsonStr = line.substring(6);
      try {
        var data = JSON.parse(jsonStr);
        if (data.id === targetId) {
          lastData = data;
        } else if (!data.id) {
          // 通知（无 id），也保存
          lastData = data;
        }
      } catch (e) {
        // 非 JSON data 行
      }
    }
  }

  if (!lastData) return { error: { message: 'SSE 响应中未找到结果' } };
  if (lastData.error) return { error: lastData.error };
  return { value: lastData.result };
}

// ===== SSE 流连接（服务器推送通知）=====

function connectSseStream(serverId) {
  var server = httpServers[serverId];
  if (!server) return;

  // 如果服务器配置了 SSE 端点，建立持久连接接收通知
  if (!server.config || !server.config.sseEndpoint) return;

  var parsedUrl = url.parse(server.url.replace(/\/mcp$/, '') + server.config.sseEndpoint);
  var client = parsedUrl.protocol === 'https:' ? https : http;

  var headers = {
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
  };
  if (server.sessionId) headers['Mcp-Session-Id'] = server.sessionId;
  if (server.config.authToken) headers['Authorization'] = 'Bearer ' + server.config.authToken;
  if (server.config.apiKey) headers['X-API-Key'] = server.config.apiKey;

  var options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.path,
    method: 'GET',
    headers: headers,
  };

  function connect() {
    var req = client.request(options, function (res) {
      var buffer = '';

      res.on('data', function (chunk) {
        buffer += chunk.toString();
        var parts = buffer.split('\n\n');
        buffer = parts.pop(); // 保留不完整的事件

        parts.forEach(function (event) {
          if (!event.trim()) return;
          var dataLine = '';
          event.split('\n').forEach(function (line) {
            if (line.startsWith('data: ')) dataLine += line.substring(6);
          });
          if (dataLine) {
            try {
              var notification = JSON.parse(dataLine);
              handleServerNotification(serverId, notification);
            } catch (e) {}
          }
        });
      });

      res.on('end', function () {
        server._sseConnected = false;
        // 自动重连
        setTimeout(connect, 5000);
      });

      res.on('error', function (e) {
        console.warn('⚠️ SSE 流错误:', serverId, e.message);
        server._sseConnected = false;
        setTimeout(connect, 10000);
      });
    });

    req.on('error', function (e) {
      console.warn('⚠️ SSE 连接失败:', serverId, e.message);
      server._sseConnected = false;
      setTimeout(connect, 10000);
    });

    req.end();
    server._sseReq = req;
    server._sseConnected = true;
  }

  connect();
}

function handleServerNotification(serverId, notification) {
  if (!notification || !notification.method) return;

  switch (notification.method) {
    case 'notifications/tools/list_changed':
      // 工具列表变更，重新发现
      refreshServerTools(serverId);
      break;

    case 'notifications/progress':
      // 进度通知
      if (notification.params) {
        var p = notification.params;
      }
      break;

    case 'notifications/message':
      // 服务器消息
      if (notification.params && notification.params.data) {
      }
      break;

    default:
      // 其他通知
      console.log('📢 MCP 通知:', serverId, notification.method);
  }
}

// ===== 服务器生命周期 =====

async function connectHttpServer(serverId, serverConfig) {
  if (!serverConfig || !serverConfig.url) {
    throw new Error('缺少 HTTP 服务器 URL');
  }

  // 如果已连接，先断开
  if (httpServers[serverId]) {
    disconnectHttpServer(serverId);
  }

  var server = {
    url: serverConfig.url,
    config: serverConfig,
    status: 'connecting',
    tools: [],
    sessionId: null,
    _sseConnected: false,
  };

  httpServers[serverId] = server;

  try {
    // MCP 初始化握手
    var initResult = await sendHttpRpc(serverId, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ai-agent-pro', version: '1.2.0' },
    });

    server.status = 'connected';

    // 发送 initialized 通知
    try {
      await sendHttpRpc(serverId, 'notifications/initialized', {});
    } catch (e) {
      // 通知可能不返回结果
    }

    // 发现工具
    try {
      var toolsResult = await sendHttpRpc(serverId, 'tools/list', {});
      if (toolsResult && toolsResult.tools) {
        registerHttpServerTools(serverId, toolsResult.tools);
      }
    } catch (e) {
      console.warn('⚠️ HTTP MCP 工具发现失败:', serverId, e.message);
    }

    // 建立 SSE 流连接（如果配置了）
    connectSseStream(serverId);


    return server;
  } catch (e) {
    server.status = 'error';
    console.error('❌ 连接 HTTP MCP 服务器失败:', serverId, e.message);
    throw e;
  }
}

function disconnectHttpServer(serverId) {
  var server = httpServers[serverId];
  if (!server) return;

  // 关闭 SSE 连接
  if (server._sseReq) {
    try { server._sseReq.destroy(); } catch (e) {}
    server._sseReq = null;
  }

  // 注销工具
  unregisterHttpServerTools(serverId);

  server.status = 'disconnected';
  server.sessionId = null;
  server._sseConnected = false;

}

// ===== 工具注册 =====

function registerHttpServerTools(serverId, tools) {
  var server = httpServers[serverId];
  if (!server || !Core.mcp) return;

  server.tools = [];
  for (var i = 0; i < tools.length; i++) {
    var tool = tools[i];
    var prefixedName = 'mcp_' + serverId + '__' + tool.name;
    server.tools.push(tool.name);

    Core.mcp.registerTool(prefixedName, {
      description: '[MCP-HTTP:' + serverId + '] ' + (tool.description || tool.name),
      schema: tool.inputSchema || { type: 'object', properties: {} },
      source: 'http-external',
      serverId: serverId,
      remoteName: tool.name,
      handler: (function (sid, rname) {
        return async function (args) {
          try {
            var result = await sendHttpRpc(sid, 'tools/call', { name: rname, arguments: args });
            return result || { success: true };
          } catch (e) {
            return { success: false, error: 'MCP HTTP 调用失败: ' + e.message };
          }
        };
      })(serverId, tool.name),
    });
  }
}

function unregisterHttpServerTools(serverId) {
  var server = httpServers[serverId];
  if (!server || !server.tools || !Core.mcp) return;

  for (var i = 0; i < server.tools.length; i++) {
    var prefixedName = 'mcp_' + serverId + '__' + server.tools[i];
    Core.mcp.unregisterTool(prefixedName);
  }
  server.tools = [];
}

function refreshServerTools(serverId) {
  var server = httpServers[serverId];
  if (!server || server.status !== 'connected') return;

  unregisterHttpServerTools(serverId);
  sendHttpRpc(serverId, 'tools/list', {}).then(function (result) {
    if (result && result.tools) {
      registerHttpServerTools(serverId, result.tools);
    }
  }).catch(function (e) {
    console.warn('⚠️ 刷新工具失败:', serverId, e.message);
  });
}

// ===== 服务器列表与管理 =====

function listHttpServers() {
  return Object.keys(httpServers).map(function (id) {
    var s = httpServers[id];
    return {
      id: id,
      url: s.url,
      name: (s.config && s.config.name) || id,
      status: s.status,
      tools: s.tools.length,
      sessionId: s.sessionId ? s.sessionId.substring(0, 8) + '...' : null,
      sse: s._sseConnected,
    };
  });
}

async function addAndConnectHttpServer(config) {
  if (!config.id) config.id = 'http-' + Date.now().toString(36);
  if (!config.url) return { success: false, error: '缺少 URL' };

  // 保存到配置
  if (Core.mcp) {
    var addResult = Core.mcp.addServer({
      id: config.id,
      name: config.name || config.id,
      command: '__http__',  // 标记为 HTTP 传输
      args: [],
      env: {},
      enabled: true,
      _httpConfig: config,
    });
    // addServer 可能不允许 command=__http__，忽略错误
  }

  try {
    var server = await connectHttpServer(config.id, config);
    return { success: true, id: config.id, tools: server.tools.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function removeHttpServer(serverId) {
  disconnectHttpServer(serverId);
  delete httpServers[serverId];

  // 也从 mcp-servers.json 中移除
  if (Core.mcp && Core.mcp.removeServer) {
    Core.mcp.removeServer(serverId);
  }

  return { success: true };
}

// ===== 通用 HTTP 请求辅助（用于非 MCP 的 REST 调用）=====

async function httpRequest(method, urlStr, body, headers) {
  return new Promise(function (resolve, reject) {
    var parsedUrl = url.parse(urlStr);
    var client = parsedUrl.protocol === 'https:' ? https : http;
    var bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';

    var options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.path,
      method: method || 'GET',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }, headers || {}),
      timeout: 15000,
    };

    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    var req = client.request(options, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var responseBody = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(responseBody) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: responseBody });
        }
      });
    });

    req.on('error', function (e) { reject(e); });
    req.on('timeout', function () { req.destroy(); reject(new Error('请求超时')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ===== 命令处理 =====

function handleCommand(args) {
  var parts = args.trim().split(/\s+/);
  var cmd = parts[0] || 'help';

  switch (cmd) {
    case 'connect':
    case 'c':
      if (!parts[1]) return '用法: /mcp-http connect <URL> [名称]';
      var connectConfig = {
        url: parts[1],
        name: parts[2] || 'http-' + Date.now().toString(36),
        authToken: parts[3] || '',
      };
      return addAndConnectHttpServer(connectConfig).then(function (r) {
        return r.success ? '✅ HTTP MCP 已连接: ' + r.id + ' (' + r.tools + ' 个工具)' :
          '❌ 连接失败: ' + (r.error || '未知错误');
      });

    case 'disconnect':
    case 'd':
      if (!parts[1]) return '用法: /mcp-http disconnect <serverId>';
      disconnectHttpServer(parts[1]);
      return '✅ 已断开: ' + parts[1];

    case 'list':
    case 'ls':
      var servers = listHttpServers();
      if (servers.length === 0) return '暂无 HTTP MCP 服务器';
      return servers.map(function (s) {
        var icon = s.status === 'connected' ? '🟢' : s.status === 'connecting' ? '🟡' : '🔴';
        return icon + ' ' + s.id + ' — ' + s.url + '\n' +
          '   状态: ' + s.status + ' | 工具: ' + s.tools +
          (s.sse ? ' | SSE: ✓' : '') +
          (s.sessionId ? ' | Session: ' + s.sessionId : '');
      }).join('\n\n');

    case 'remove':
    case 'rm':
      if (!parts[1]) return '用法: /mcp-http remove <serverId>';
      removeHttpServer(parts[1]);
      return '✅ 已移除: ' + parts[1];

    case 'call':
      if (parts.length < 4) return '用法: /mcp-http call <serverId> <toolName> [args JSON]';
      var callArgs = parts[3] ? JSON.parse(parts.slice(3).join(' ')) : {};
      return sendHttpRpc(parts[1], 'tools/call', {
        name: parts[2], arguments: callArgs
      }).then(function (result) {
        return '📤 调用结果:\n' + JSON.stringify(result, null, 2);
      }).catch(function (e) {
        return '❌ 调用失败: ' + e.message;
      });

    default:
      return '🔌 MCP HTTP+SSE 传输层\n' +
        '/mcp-http connect <URL> [名称] [token] — 连接 HTTP MCP 服务器\n' +
        '/mcp-http disconnect <serverId> — 断开服务器\n' +
        '/mcp-http list — 列出所有 HTTP MCP 服务器\n' +
        '/mcp-http remove <serverId> — 移除服务器\n' +
        '/mcp-http call <serverId> <tool> [args] — 直接调用工具';
  }
}

// ===== 模块导出 =====

module.exports = {
  name: 'mcp-http',
  dependencies: ['mcp', 'routing'],
  init(_Core) {
    Core = _Core;

    Core.mcpHttp = {
      connect: connectHttpServer,
      disconnect: disconnectHttpServer,
      list: listHttpServers,
      addAndConnect: addAndConnectHttpServer,
      remove: removeHttpServer,
      sendRpc: sendHttpRpc,
      httpRequest: httpRequest,
    };

    // 注册命令
    if (Core.routing && Core.routing.register) {
      Core.routing.register('/mcp-http', handleCommand, 'MCP HTTP+SSE 传输层（连接远程 MCP 服务器）');
    }

    // 自动连接配置中的 HTTP MCP 服务器
    if (Core.mcp) {
      setTimeout(function () {
        var serverList = Core.mcp.listServers ? Core.mcp.listServers() : [];
        serverList.forEach(function (s) {
          if (s.command === '__http__' && s.enabled !== false) {
            var httpConfig = s._httpConfig || { url: s.url, name: s.name };
            connectHttpServer(s.id, httpConfig).catch(function (e) {
              console.warn('⚠️ 自动连接 HTTP MCP 失败:', s.id, e.message);
            });
          }
        });
      }, 3000);
    }

  }
};
