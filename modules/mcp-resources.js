// modules/mcp-resources.js — MCP Resources & Prompts 扩展
// 在 MCP 工具能力基础上，增加 Resources（数据源读取）和 Prompts（提示词模板）支持
var Core = null;

// ===== 本地 Resources 注册表 =====
var localResources = {};  // uri -> { uri, name, description, mimeType, handler }

// ===== 本地 Prompts 注册表 =====
var localPrompts = {};  // name -> { name, description, arguments, handler }

// ===== Resources 管理 =====

/**
 * 注册一个本地资源
 * @param {object} resource - { uri, name, description, mimeType, handler }
 *   handler: async function() => { content, mimeType? }
 */
function registerResource(resource) {
  if (!resource || !resource.uri) {
    console.warn('[mcp-resources] registerResource: uri required');
    return false;
  }
  localResources[resource.uri] = {
    uri: resource.uri,
    name: resource.name || resource.uri,
    description: resource.description || '',
    mimeType: resource.mimeType || 'text/plain',
    handler: resource.handler,
    source: 'local',
  };
  return true;
}

function unregisterResource(uri) {
  delete localResources[uri];
}

/**
 * 列出所有可用资源（本地 + 外部 MCP 服务器）
 */
async function listResources() {
  var result = [];

  // 本地资源
  for (var uri in localResources) {
    var r = localResources[uri];
    result.push({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
      source: 'local',
    });
  }

  // 外部 MCP 服务器资源（通过 resources/list RPC）
  if (Core.mcp && Core.mcp.listServers) {
    var servers = Core.mcp.listServers();
    for (var i = 0; i < servers.length; i++) {
      var srv = servers[i];
      if (srv.connected && Core.mcp._rpc) {
        try {
          var res = await Core.mcp._rpc(srv.id, 'resources/list', {});
          if (res && res.resources) {
            res.resources.forEach(function(extRes) {
              result.push({
                uri: extRes.uri,
                name: extRes.name || extRes.uri,
                description: extRes.description || '',
                mimeType: extRes.mimeType || 'text/plain',
                source: srv.id,
              });
            });
          }
        } catch (e) {
          // Server may not support resources
        }
      }
    }
  }

  return result;
}

/**
 * 读取指定资源的内容
 * @param {string} uri - 资源 URI
 * @returns {object} { success, content, mimeType, error? }
 */
async function readResource(uri) {
  // 先查本地
  if (localResources[uri]) {
    try {
      var r = localResources[uri];
      var content = typeof r.handler === 'function' ? await r.handler() : r.handler;
      return {
        success: true,
        uri: uri,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        mimeType: r.mimeType,
      };
    } catch (e) {
      return { success: false, uri: uri, error: e.message };
    }
  }

  // 查外部 MCP 服务器
  if (Core.mcp && Core.mcp._rpc) {
    var servers = Core.mcp.listServers ? Core.mcp.listServers() : [];
    for (var i = 0; i < servers.length; i++) {
      if (!servers[i].connected) continue;
      try {
        var res = await Core.mcp._rpc(servers[i].id, 'resources/read', { uri: uri });
        if (res && res.contents && res.contents.length > 0) {
          return {
            success: true,
            uri: uri,
            content: res.contents[0].text || '',
            mimeType: res.contents[0].mimeType || 'text/plain',
            source: servers[i].id,
          };
        }
      } catch (e) {
        // Try next server
      }
    }
  }

  return { success: false, uri: uri, error: '资源未找到: ' + uri };
}

// ===== Prompts 管理 =====

/**
 * 注册一个本地提示词模板
 * @param {object} prompt - { name, description, arguments, handler }
 *   arguments: [{ name, description, required }]
 *   handler: function(args) => { messages: [{ role, content }] }
 */
function registerPrompt(prompt) {
  if (!prompt || !prompt.name) {
    console.warn('[mcp-resources] registerPrompt: name required');
    return false;
  }
  localPrompts[prompt.name] = {
    name: prompt.name,
    description: prompt.description || '',
    arguments: prompt.arguments || [],
    handler: prompt.handler,
    source: 'local',
  };
  return true;
}

function unregisterPrompt(name) {
  delete localPrompts[name];
}

/**
 * 列出所有可用提示词模板（本地 + 外部 MCP 服务器）
 */
async function listPrompts() {
  var result = [];

  // 本地提示词
  for (var name in localPrompts) {
    var p = localPrompts[name];
    result.push({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
      source: 'local',
    });
  }

  // 外部 MCP 服务器提示词
  if (Core.mcp && Core.mcp.listServers) {
    var servers = Core.mcp.listServers();
    for (var i = 0; i < servers.length; i++) {
      var srv = servers[i];
      if (srv.connected && Core.mcp._rpc) {
        try {
          var res = await Core.mcp._rpc(srv.id, 'prompts/list', {});
          if (res && res.prompts) {
            res.prompts.forEach(function(extPrompt) {
              result.push({
                name: extPrompt.name,
                description: extPrompt.description || '',
                arguments: extPrompt.arguments || [],
                source: srv.id,
              });
            });
          }
        } catch (e) {
          // Server may not support prompts
        }
      }
    }
  }

  return result;
}

/**
 * 获取并渲染提示词模板
 * @param {string} name - 提示词名称
 * @param {object} args - 参数键值对
 * @returns {object} { success, messages?, error? }
 */
async function getPrompt(name, args) {
  args = args || {};

  // 先查本地
  if (localPrompts[name]) {
    try {
      var p = localPrompts[name];
      // 验证必需参数
      for (var i = 0; i < p.arguments.length; i++) {
        var argDef = p.arguments[i];
        if (argDef.required && !args[argDef.name]) {
          return { success: false, error: '缺少必需参数: ' + argDef.name };
        }
      }
      var result = typeof p.handler === 'function' ? await p.handler(args) : p.handler;
      return { success: true, name: name, messages: result.messages || [{ role: 'user', content: result }] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // 查外部 MCP 服务器
  if (Core.mcp && Core.mcp._rpc) {
    var servers = Core.mcp.listServers ? Core.mcp.listServers() : [];
    for (var j = 0; j < servers.length; j++) {
      if (!servers[j].connected) continue;
      try {
        var res = await Core.mcp._rpc(servers[j].id, 'prompts/get', { name: name, arguments: args });
        if (res && res.messages) {
          return { success: true, name: name, messages: res.messages, source: servers[j].id };
        }
      } catch (e) {
        // Try next server
      }
    }
  }

  return { success: false, error: '提示词模板未找到: ' + name };
}

// ===== 注册内置资源和提示词 =====

function registerBuiltins() {
  // 内置资源：应用配置
  registerResource({
    uri: 'app://config',
    name: '应用配置',
    description: '当前应用的全局配置信息',
    mimeType: 'application/json',
    handler: function() { return JSON.stringify(Core.config, null, 2); },
  });

  // 内置资源：会话列表
  registerResource({
    uri: 'app://sessions',
    name: '会话列表',
    description: '当前所有聊天会话的列表',
    mimeType: 'application/json',
    handler: function() {
      var sessions = (Core.session && Core.session.sessions) || {};
      var list = Object.keys(sessions).map(function(id) {
        return { id: id, title: sessions[id].title || '(无标题)', roleType: sessions[id].roleType || '' };
      });
      return JSON.stringify(list, null, 2);
    },
  });

  // 内置资源：系统状态
  registerResource({
    uri: 'app://status',
    name: '系统状态',
    description: '当前系统运行状态和模块信息',
    mimeType: 'application/json',
    handler: function() {
      var status = {
        version: '1.0',
        guardrailsEnabled: Core.config.guardrailsEnabled !== false,
        mcpServers: Core.mcp && Core.mcp.listServers ? Core.mcp.listServers().length : 0,
      };
      if (Core.handoff) status.handoffStats = Core.handoff.getStats();
      return JSON.stringify(status, null, 2);
    },
  });

  // 内置提示词：代码审查
  registerPrompt({
    name: 'code-review',
    description: '对代码进行审查，检查最佳实践、安全性和性能',
    arguments: [
      { name: 'code', description: '要审查的代码', required: true },
      { name: 'language', description: '编程语言', required: false },
    ],
    handler: function(args) {
      var lang = args.language || '自动检测';
      return {
        messages: [{
          role: 'user',
          content: '请对以下 ' + lang + ' 代码进行审查，检查以下方面：\n1. 代码质量和最佳实践\n2. 安全漏洞\n3. 性能问题\n4. 可维护性\n\n代码:\n```\n' + args.code + '\n```'
        }]
      };
    },
  });

  // 内置提示词：总结
  registerPrompt({
    name: 'summarize',
    description: '总结文本内容，提取关键信息',
    arguments: [
      { name: 'text', description: '要总结的文本', required: true },
      { name: 'style', description: '总结风格: brief/detailed/bullet', required: false },
    ],
    handler: function(args) {
      var style = args.style || 'brief';
      var styleGuide = {
        brief: '用1-2句话简洁总结',
        detailed: '提供详细的分段总结，包含关键细节',
        bullet: '以要点列表形式总结',
      };
      return {
        messages: [{
          role: 'user',
          content: (styleGuide[style] || styleGuide.brief) + '：\n\n' + args.text
        }]
      };
    },
  });

  // 内置提示词：翻译
  registerPrompt({
    name: 'translate',
    description: '翻译文本到目标语言',
    arguments: [
      { name: 'text', description: '要翻译的文本', required: true },
      { name: 'target_lang', description: '目标语言', required: true },
    ],
    handler: function(args) {
      return {
        messages: [{
          role: 'user',
          content: '请将以下文本翻译为' + args.target_lang + '，保持原文的语气和风格：\n\n' + args.text
        }]
      };
    },
  });
}

// ===== 模块导出 =====
module.exports = {
  name: 'mcp-resources',
  dependencies: ['mcp'],
  init: function(_Core) {
    Core = _Core;

    // 注册内置资源和提示词
    registerBuiltins();

    // 挂载到 Core
    Core.mcpResources = {
      // Resources
      registerResource: registerResource,
      unregisterResource: unregisterResource,
      listResources: listResources,
      readResource: readResource,
      // Prompts
      registerPrompt: registerPrompt,
      unregisterPrompt: unregisterPrompt,
      listPrompts: listPrompts,
      getPrompt: getPrompt,
    };

    // 注册命令
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/mcp-res', '查看 MCP Resources 和 Prompts', async function(args) {
        var sub = (args || '').trim().toLowerCase();
        if (sub === 'prompts') {
          var prompts = await listPrompts();
          var lines = ['📝 MCP Prompts (' + prompts.length + '):'];
          prompts.forEach(function(p) {
            lines.push('  • ' + p.name + ' [' + p.source + '] — ' + p.description);
          });
          return lines.join('\n');
        }
        // Default: list resources
        var resources = await listResources();
        var result = ['📚 MCP Resources (' + resources.length + '):'];
        resources.forEach(function(r) {
          result.push('  • ' + r.uri + ' [' + r.source + '] — ' + r.description);
        });
        result.push('\n用法: /mcp-res prompts');
        return result.join('\n');
      }, false);
    }

    console.log('✅ MCP Resources/Prompts 模块已加载 (' +
      Object.keys(localResources).length + ' resources, ' +
      Object.keys(localPrompts).length + ' prompts)');
  },
};
