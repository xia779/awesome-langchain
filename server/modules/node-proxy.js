// server/modules/node-proxy.js — 远程节点注册与工具路由
// 桌面端/开发板通过 WebSocket 注册为执行节点，服务端 Agent 的工具调用
// 可按能力路由到节点远程执行（文件系统、Shell、Python 等本地能力）。
var PROTOCOL = require('../protocol');

var Core = null;
var _router = null;

// nodeId → { ws, name, platform, capabilities, lastSeen, registeredAt }
var nodes = new Map();
// callId → { resolve, reject, timer, nodeId, tool }
var pendingCalls = new Map();
var _callSeq = 0;

// 工具 → 所需节点能力（无此映射的工具始终在服务端本地执行）
var TOOL_CAPS = {
  read_file: ['fs'],
  write_file: ['fs'],
  edit_file: ['fs'],
  list_dir: ['fs'],
  search_files: ['fs'],
  file_info: ['fs'],
  run_command: ['shell'],
  run_python: ['python'],
};

// 各工具远程执行超时（毫秒）
var TOOL_TIMEOUT = {
  run_command: 30000,
  run_python: 60000,
};
var DEFAULT_TIMEOUT = 30000;

// ===== 节点管理 =====

function registerNode(ws, payload) {
  var nodeId = payload.nodeId;
  if (!nodeId) throw new Error('node.register 缺少 nodeId');

  var existing = nodes.get(nodeId);
  if (existing && existing.ws !== ws && existing.ws.readyState === 1) {
    // 同一 nodeId 重复注册（新连接顶替旧连接）
    try { existing.ws.close(); } catch (e) {}
  }

  nodes.set(nodeId, {
    ws: ws,
    name: payload.name || nodeId,
    platform: payload.platform || 'unknown',
    capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
    lastSeen: Date.now(),
    registeredAt: Date.now(),
  });

  Core.log('Node registered:', nodeId, '(' + (payload.name || '') + ')',
    'caps=[' + (payload.capabilities || []).join(',') + ']', 'total:', nodes.size);

  // 通知其他客户端（Web UI 可显示节点上线）
  _router.broadcast(PROTOCOL.NODE_ONLINE, {
    nodeId: nodeId,
    name: payload.name || nodeId,
    platform: payload.platform || 'unknown',
    capabilities: payload.capabilities || [],
  }, ws);

  return { success: true, serverTime: Date.now(), protocol: PROTOCOL.VERSION };
}

function removeNodeByWs(ws) {
  var removed = null;
  nodes.forEach(function(node, nodeId) {
    if (node.ws === ws) {
      nodes.delete(nodeId);
      removed = nodeId;
    }
  });
  if (!removed) return; // 断开的是普通客户端，不是节点

  Core.log('Node offline:', removed, 'remaining:', nodes.size);

  // 拒绝该节点所有未完成的调用（触发上层回退到服务端本地执行）
  pendingCalls.forEach(function(call, callId) {
    if (call.nodeId === removed) {
      clearTimeout(call.timer);
      pendingCalls.delete(callId);
      call.reject(new Error('节点 ' + removed + ' 已离线'));
    }
  });

  _router.broadcast(PROTOCOL.NODE_OFFLINE, { nodeId: removed }, ws);
}

function listNodes() {
  var result = [];
  nodes.forEach(function(node, nodeId) {
    result.push({
      nodeId: nodeId,
      name: node.name,
      platform: node.platform,
      capabilities: node.capabilities,
      online: node.ws.readyState === 1,
      lastSeen: node.lastSeen,
      pendingCalls: countPending(nodeId),
    });
  });
  return result;
}

function countPending(nodeId) {
  var n = 0;
  pendingCalls.forEach(function(call) { if (call.nodeId === nodeId) n++; });
  return n;
}

// ===== 节点选择 =====

function nodeHasCaps(node, caps) {
  for (var i = 0; i < caps.length; i++) {
    if (node.capabilities.indexOf(caps[i]) === -1) return false;
  }
  return true;
}

// 选择能执行该工具的最佳节点：能力匹配 + 在线 + 空闲优先
function selectNode(toolName) {
  var caps = TOOL_CAPS[toolName];
  if (!caps) return null; // 服务端本地工具，不路由

  var candidates = [];
  nodes.forEach(function(node, nodeId) {
    if (node.ws.readyState === 1 && nodeHasCaps(node, caps)) {
      candidates.push({ id: nodeId, node: node, pending: countPending(nodeId) });
    }
  });
  if (candidates.length === 0) return null;

  // 空闲优先，其次最近活跃
  candidates.sort(function(a, b) {
    if (a.pending !== b.pending) return a.pending - b.pending;
    return b.node.lastSeen - a.node.lastSeen;
  });
  return candidates[0];
}

// 该工具当前是否可路由到节点（供 tools.js 判断）
function canRoute(toolName) {
  if (Core.config && Core.config.nodeRouting === 'server-only') return false;
  return selectNode(toolName) !== null;
}

// ===== 远程执行 =====

function executeOnNode(nodeId, toolName, params, timeoutMs) {
  var node = nodes.get(nodeId);
  if (!node || node.ws.readyState !== 1) {
    return Promise.reject(new Error('节点 ' + nodeId + ' 不在线'));
  }

  var callId = 'call_' + (++_callSeq) + '_' + Date.now();
  var timeout = timeoutMs || TOOL_TIMEOUT[toolName] || DEFAULT_TIMEOUT;

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      pendingCalls.delete(callId);
      reject(new Error('节点 ' + nodeId + ' 执行 ' + toolName + ' 超时 (' + timeout + 'ms)'));
    }, timeout);

    pendingCalls.set(callId, { resolve: resolve, reject: reject, timer: timer, nodeId: nodeId, tool: toolName });

    _router.sendTo(node.ws, PROTOCOL.NODE_EXECUTE, {
      callId: callId,
      tool: toolName,
      params: params || {},
    });
  });
}

// 选择最佳节点执行工具；无可用节点时抛错（由调用方决定回退策略）
async function execute(toolName, params) {
  var target = selectNode(toolName);
  if (!target) {
    throw new Error('没有能执行 ' + toolName + ' 的在线节点');
  }
  return await executeOnNode(target.id, toolName, params);
}

// 处理节点返回的执行结果
function handleNodeResult(payload) {
  var callId = payload.callId;
  var call = pendingCalls.get(callId);
  if (!call) return { ignored: true }; // 可能是超时后的迟到响应

  clearTimeout(call.timer);
  pendingCalls.delete(callId);

  if (payload.error) {
    call.reject(new Error(String(payload.error)));
  } else {
    call.resolve(payload.result);
  }
  return { resolved: true };
}

function handleNodeStatus(payload, ctx) {
  // 心跳：更新 lastSeen；payload 含 cpu/mem 等状态
  nodes.forEach(function(node) {
    if (node.ws === ctx.ws) {
      node.lastSeen = Date.now();
      if (payload.stats) node.stats = payload.stats;
    }
  });
  return { ok: true };
}

// ===== 模块导出 =====

module.exports = {
  name: 'node-proxy',
  dependencies: [],
  init: function(_Core, router) {
    Core = _Core;
    _router = router;

    router.handle(PROTOCOL.NODE_REGISTER, function(payload, ctx) {
      return registerNode(ctx.ws, payload);
    });

    router.handle(PROTOCOL.NODE_RESULT, handleNodeResult);
    router.handle(PROTOCOL.NODE_STATUS, handleNodeStatus);

    router.handle(PROTOCOL.NODE_LIST, function() {
      return { nodes: listNodes() };
    });

    // 节点断连清理
    router.onDisconnect(function(info, ws) {
      removeNodeByWs(ws);
    });

    // 暴露给其他模块（tools.js 的路由层、agent 循环）
    Core.nodeProxy = {
      execute: execute,
      executeOnNode: executeOnNode,
      canRoute: canRoute,
      selectNode: selectNode,
      listNodes: listNodes,
    };

    Core.log('node-proxy initialized (tool routing ready)');
  }
};
