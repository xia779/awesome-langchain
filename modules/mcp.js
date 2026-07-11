// modules/mcp.js - MCP 协议（本地工具 + 外部服务器 stdio 传输）
let Core;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let mcpClient = null;
let registeredTools = {}; // name -> { description, handler, schema, source }
let mcpEnabled = false;

// ===== 外部 MCP 服务器管理 =====
let externalServers = {}; // serverId -> { process, tools, status, config }
let _rpcId = 0;

function getServersConfigPath() {
  var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || 'E:\\my-ai-data';
  return path.join(base, 'mcp-servers.json');
}

function loadServersConfig() {
  var configPath = getServersConfigPath();
  if (!fs.existsSync(configPath)) return { servers: [] };
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.warn('⚠️ 读取 MCP 服务器配置失败:', e.message);
    return { servers: [] };
  }
}

function saveServersConfig(config) {
  var configPath = getServersConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('❌ 保存 MCP 服务器配置失败:', e.message);
    return false;
  }
}

// ===== stdio 传输层 =====

function sendRpc(serverId, method, params) {
  return new Promise(function (resolve, reject) {
    var server = externalServers[serverId];
    if (!server || !server.process || !server.process.stdin.writable) {
      reject(new Error('服务器 ' + serverId + ' 未连接'));
      return;
    }
    var id = ++_rpcId;
    var request = { jsonrpc: '2.0', id: id, method: method, params: params || {} };
    var json = JSON.stringify(request);

    server._pendingCallbacks = server._pendingCallbacks || {};
    var timeout = setTimeout(function () {
      delete server._pendingCallbacks[id];
      reject(new Error('RPC 超时: ' + method));
    }, 15000);

    server._pendingCallbacks[id] = function (response) {
      clearTimeout(timeout);
      if (response.error) {
        reject(new Error(response.error.message || 'RPC 错误'));
      } else {
        resolve(response.result);
      }
    };

    try {
      server.process.stdin.write(json + '\n');
    } catch (e) {
      clearTimeout(timeout);
      delete server._pendingCallbacks[id];
      reject(e);
    }
  });
}

// ===== 服务器生命周期 =====

async function connectServer(serverId) {
  var config = loadServersConfig();
  var serverConfig = null;
  for (var i = 0; i < config.servers.length; i++) {
    if (config.servers[i].id === serverId) {
      serverConfig = config.servers[i];
      break;
    }
  }
  if (!serverConfig) throw new Error('未找到服务器配置: ' + serverId);

  // 如果已经连接，先断开
  if (externalServers[serverId] && externalServers[serverId].process) {
    disconnectServer(serverId);
  }

  try {
    var env = Object.assign({}, process.env, serverConfig.env || {});
    var child = spawn(serverConfig.command, serverConfig.args || [], {
      env: env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    externalServers[serverId] = {
      process: child,
      tools: [],
      status: 'connecting',
      config: serverConfig,
      _pendingCallbacks: {},
    };

    // 处理 stdout（JSON-RPC 响应）
    var buffer = '';
    child.stdout.on('data', function (data) {
      buffer += data.toString();
      var lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整的行
      for (var l = 0; l < lines.length; l++) {
        var line = lines[l].trim();
        if (!line) continue;
        try {
          var response = JSON.parse(line);
          var server = externalServers[serverId];
          if (server && server._pendingCallbacks && server._pendingCallbacks[response.id]) {
            server._pendingCallbacks[response.id](response);
            delete server._pendingCallbacks[response.id];
          }
          // 处理 server->client 通知（无 id）
          if (!response.id && response.method === 'notifications/initialized') {
          }
        } catch (e) {
          // 非 JSON 行，忽略
        }
      }
    });

    child.stderr.on('data', function (data) {
      console.warn('⚠️ MCP[' + serverId + '] stderr:', data.toString().trim());
    });

    child.on('close', function (code) {
      if (externalServers[serverId]) {
        externalServers[serverId].status = 'disconnected';
        externalServers[serverId].process = null;
      }
      // 清理该服务器的工具
      unregisterServerTools(serverId);
    });

    child.on('error', function (err) {
      console.error('❌ MCP 服务器启动失败:', serverId, err.message);
      if (externalServers[serverId]) {
        externalServers[serverId].status = 'error';
        externalServers[serverId].process = null;
      }
    });

    // MCP 握手：initialize + initialized 通知
    await sendRpc(serverId, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ai-agent-pro', version: '1.1.0' },
    });
    sendRpc(serverId, 'notifications/initialized', {}).catch(function () {});

    externalServers[serverId].status = 'connected';

    // 发现工具
    try {
      var toolsResult = await sendRpc(serverId, 'tools/list', {});
      if (toolsResult && toolsResult.tools) {
        registerServerTools(serverId, toolsResult.tools);
      }
    } catch (e) {
      console.warn('⚠️ MCP 工具发现失败:', serverId, e.message);
    }

    return externalServers[serverId];
  } catch (e) {
    console.error('❌ 连接 MCP 服务器失败:', serverId, e.message);
    if (externalServers[serverId]) {
      externalServers[serverId].status = 'error';
    }
    throw e;
  }
}

function disconnectServer(serverId) {
  var server = externalServers[serverId];
  if (!server) return;
  unregisterServerTools(serverId);
  if (server.process) {
    try { server.process.kill(); } catch (e) {}
    server.process = null;
  }
  server.status = 'disconnected';
}

function registerServerTools(serverId, tools) {
  var server = externalServers[serverId];
  if (!server) return;
  server.tools = [];
  for (var i = 0; i < tools.length; i++) {
    var tool = tools[i];
    var prefixedName = 'mcp_' + serverId + '__' + tool.name;
    server.tools.push(tool.name);
    registerTool(prefixedName, {
      description: '[MCP:' + serverId + '] ' + (tool.description || tool.name),
      schema: tool.inputSchema || { type: 'object', properties: {} },
      source: 'external',
      serverId: serverId,
      remoteName: tool.name,
      handler: (function (sid, rname) {
        return async function (args) {
          try {
            var result = await sendRpc(sid, 'tools/call', { name: rname, arguments: args });
            return result || { success: true };
          } catch (e) {
            return { success: false, error: 'MCP 调用失败: ' + e.message };
          }
        };
      })(serverId, tool.name),
    });
  }
}

function unregisterServerTools(serverId) {
  var server = externalServers[serverId];
  if (!server || !server.tools) return;
  for (var i = 0; i < server.tools.length; i++) {
    var prefixedName = 'mcp_' + serverId + '__' + server.tools[i];
    unregisterTool(prefixedName);
  }
  server.tools = [];
}

// ===== 路径安全校验 =====
function getAllowedDirs() {
  const os = require('os');
  const path = require('path');
  const dirs = [process.cwd()];
  if (Core) {
    if (Core._globalDataRoot) dirs.push(Core._globalDataRoot);
    if (Core.DATA_ROOT) dirs.push(Core.DATA_ROOT);
    if (Core.USERS_ROOT) dirs.push(Core.USERS_ROOT);
  }
  dirs.push((Core && (Core._globalDataRoot || Core.DATA_ROOT)) || 'E:\\my-ai-data');
  dirs.push('E:\\my-ai-desktop');
  try { dirs.push(path.join(os.homedir(), 'Desktop')); } catch (e) {}
  try { dirs.push(os.tmpdir()); } catch (e) {}
  return dirs.map(d => path.resolve(d));
}

function isPathAllowed(filePath) {
  const path = require('path');
  const resolved = path.resolve(filePath);
  return getAllowedDirs().some(dir => resolved.startsWith(dir));
}

// ===== 初始化 MCP =====
function initMcp(_Core) {
  Core = _Core;
  registerLocalTools();

  // 自动连接配置中的 MCP 服务器
  var config = loadServersConfig();
  if (config.servers && config.servers.length > 0) {
    for (var i = 0; i < config.servers.length; i++) {
      var s = config.servers[i];
      if (s.enabled !== false) {
        connectServer(s.id).catch(function (e) {
          console.warn('⚠️ 自动连接 MCP 服务器失败:', e.message);
        });
      }
    }
  }

  Core.mcp = {
    enabled: function () { return mcpEnabled; },
    registerTool: registerTool,
    unregisterTool: unregisterTool,
    listTools: listTools,
    callTool: callTool,
    getToolSchema: getToolSchema,
    // 外部服务器管理
    connectServer: connectServer,
    disconnectServer: disconnectServer,
    listServers: listServers,
    addServer: addServer,
    removeServer: removeServer,
    _rpc: sendRpc,
  };

}

// ===== 服务器管理 =====

function listServers() {
  var config = loadServersConfig();
  return (config.servers || []).map(function (s) {
    var connected = externalServers[s.id] && externalServers[s.id].status === 'connected';
    var toolCount = externalServers[s.id] ? externalServers[s.id].tools.length : 0;
    return {
      id: s.id,
      name: s.name || s.id,
      command: s.command,
      enabled: s.enabled !== false,
      connected: connected,
      tools: toolCount,
      status: externalServers[s.id] ? externalServers[s.id].status : 'disconnected',
    };
  });
}

function addServer(serverConfig) {
  if (!serverConfig.id || !serverConfig.command) {
    return { success: false, error: '缺少必要字段: id, command' };
  }
  var config = loadServersConfig();
  // 检查重复
  for (var i = 0; i < config.servers.length; i++) {
    if (config.servers[i].id === serverConfig.id) {
      return { success: false, error: '服务器 ID 已存在: ' + serverConfig.id };
    }
  }
  config.servers.push({
    id: serverConfig.id,
    name: serverConfig.name || serverConfig.id,
    command: serverConfig.command,
    args: serverConfig.args || [],
    env: serverConfig.env || {},
    enabled: serverConfig.enabled !== false,
  });
  saveServersConfig(config);
  return { success: true };
}

function removeServer(serverId) {
  disconnectServer(serverId);
  var config = loadServersConfig();
  config.servers = config.servers.filter(function (s) { return s.id !== serverId; });
  saveServersConfig(config);
  delete externalServers[serverId];
  return { success: true };
}

// ===== 注册本地工具 =====
function registerLocalTools() {
  // 工具 1: 文件读取
  registerTool('read_file', {
    description: '读取本地文件的内容，支持文本文件',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const fs = require('fs');
      const path = require('path');
      try {
        const resolvedPath = path.resolve(args.path);
        if (!isPathAllowed(resolvedPath)) {
          return { success: false, error: '❌ 无权访问该路径: ' + resolvedPath };
        }
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: '文件不存在: ' + resolvedPath };
        }
        const content = fs.readFileSync(resolvedPath, args.encoding || 'utf8');
        return { success: true, content: content.substring(0, 10000), path: resolvedPath, size: content.length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  });

  // 工具 2: 文件写入
  registerTool('write_file', {
    description: '向本地文件写入内容，支持创建新文件',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        content: { type: 'string', description: '要写入的内容' },
        append: { type: 'boolean', default: false, description: '是否追加模式' },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      const fs = require('fs');
      const path = require('path');
      try {
        const resolvedPath = path.resolve(args.path);
        if (!isPathAllowed(resolvedPath)) {
          return { success: false, error: '❌ 无权写入该路径: ' + resolvedPath };
        }
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        if (args.append) {
          fs.appendFileSync(resolvedPath, args.content, 'utf8');
        } else {
          fs.writeFileSync(resolvedPath, args.content, 'utf8');
        }
        return { success: true, path: resolvedPath };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  });

  // 工具 3: 列出目录
  registerTool('list_directory', {
    description: '列出指定目录中的文件和子目录',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录的绝对路径' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const fs = require('fs');
      const path = require('path');
      try {
        const resolvedPath = path.resolve(args.path);
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: '目录不存在: ' + resolvedPath };
        }
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const result = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: e.isFile() ? fs.statSync(path.join(resolvedPath, e.name)).size : null,
        }));
        return { success: true, entries: result, path: resolvedPath };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  });

  // 工具 4: 执行命令
  registerTool('execute_command', {
    description: '在本地执行 shell 命令（需要用户确认）',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', default: 30000, description: '超时时间（毫秒）' },
      },
      required: ['command'],
    },
    handler: async (args) => {
      const { execFile } = require('child_process');
      return new Promise((resolve) => {
        const dangerousPatterns = [
          'rm -rf /', 'rm -rf /*', 'format', 'del /f /s /q', 'rd /s /q',
          'mkfs', ':(){', 'dd if=', '> /dev/sd', 'chmod -R 777 /',
          'powershell -enc', 'powershell -encodedcommand',
          'curl', 'wget', '| sh', '| bash', '| cmd', '| powershell',
          '$(', '`', '${',
          'shutdown', 'reboot', 'init 0', 'init 6',
        ];
        const cmdLower = args.command.toLowerCase();
        if (dangerousPatterns.some(p => cmdLower.includes(p.toLowerCase()))) {
          resolve({ success: false, error: '🚫 检测到危险命令模式，已阻止执行: ' + args.command });
          return;
        }
        const confirmed = confirm('⚠️ 即将执行以下命令，是否允许？\n\n' + args.command);
        if (!confirmed) {
          resolve({ success: false, error: '用户取消执行命令' });
          return;
        }
        execFile('cmd', ['/c', args.command], { timeout: args.timeout || 30000 }, (error, stdout, stderr) => {
          if (error) {
            resolve({ success: false, error: error.message, stderr: stderr });
          } else {
            resolve({ success: true, stdout: (stdout || '').substring(0, 5000), stderr: stderr });
          }
        });
      });
    },
  });

  // 工具 5: 获取系统信息
  registerTool('get_system_info', {
    description: '获取当前系统的基本信息（操作系统、CPU、内存等）',
    schema: { type: 'object', properties: {} },
    handler: async () => {
      const os = require('os');
      return {
        success: true,
        info: {
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          userInfo: os.userInfo().username,
          totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
          freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024) + ' GB',
          cpuCount: os.cpus().length,
          uptime: Math.round(os.uptime() / 3600) + ' hours',
        },
      };
    },
  });

  // 工具 6: 打开网页
  registerTool('open_browser', {
    description: '在默认浏览器中打开指定 URL',
    schema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的网页地址' } },
      required: ['url'],
    },
    handler: async (args) => {
      const { shell } = require('electron');
      try {
        if (!args.url || (!args.url.startsWith('http://') && !args.url.startsWith('https://'))) {
          return { success: false, error: '❌ 仅允许打开 http:// 或 https:// 协议的链接' };
        }
        await shell.openExternal(args.url);
        return { success: true, message: '已打开: ' + args.url };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  });

  mcpEnabled = true;
}

// ===== 工具注册 API =====
function registerTool(name, config) {
  registeredTools[name] = {
    name: name,
    description: config.description,
    schema: config.schema,
    handler: config.handler,
    source: config.source || 'local',
  };
}

function unregisterTool(name) {
  delete registeredTools[name];
}

function listTools() {
  return Object.values(registeredTools).map(t => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
    source: t.source || 'local',
  }));
}

function getToolSchema(name) {
  const tool = registeredTools[name];
  return tool ? { name: tool.name, description: tool.description, schema: tool.schema } : null;
}

// ===== 工具调用 =====
async function callTool(name, args) {
  const tool = registeredTools[name];
  if (!tool) {
    return { success: false, error: '工具不存在: ' + name };
  }
  try {
    const result = await tool.handler(args);
    return result;
  } catch (e) {
    console.error('❌ 工具调用异常:', name, e.message);
    return { success: false, error: e.message };
  }
}

module.exports = { name: 'mcp', dependencies: [], init: initMcp };
