// modules/cloud-sync.js - 统一云同步引擎 (P6-1)
// 编排配置/记忆/知识库/人格的跨设备同步，支持增量diff + 冲突解决 + 离线队列
'use strict';

var Core = null;
var fs = null;
var path = null;

var SYNC_STATE_FILE = '';
var _syncState = { lastSync: null, device: '', pendingOps: [], conflicts: [] };
var _syncing = false;

// ===== 同步通道定义 =====
var SYNC_CHANNELS = {
  config: { file: 'config.json', merge: 'last-write-wins' },
  memory: { file: 'memory.json', merge: 'append-unique' },
  persona: { file: 'persona.json', merge: 'field-merge' },
  knowledge_index: { file: 'knowledge-index.json', merge: 'append-unique' },
  workflows: { dir: 'workflows', merge: 'file-level' },
  triggers: { file: 'triggers.json', merge: 'append-unique' }
};

// ===== 持久化 =====
function loadSyncState() {
  if (!Core || !Core.DATA_ROOT) return;
  SYNC_STATE_FILE = path.join(Core.DATA_ROOT, 'cloud-sync-state.json');
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      _syncState = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
    }
  } catch (e) { /* fresh state */ }
  if (!_syncState.pendingOps) _syncState.pendingOps = [];
  if (!_syncState.conflicts) _syncState.conflicts = [];
  if (!_syncState.device) _syncState.device = 'device_' + Date.now().toString(36);
}

function saveSyncState() {
  try {
    if (SYNC_STATE_FILE) fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(_syncState, null, 2), 'utf8');
  } catch (e) { console.error('cloud-sync: 保存状态失败', e.message); }
}

// ===== 增量 Diff 计算 =====
function computeDiff(local, remote, mergeStrategy) {
  if (!local && !remote) return { changes: [], hasConflict: false };
  if (!remote) return { changes: [{ op: 'push', data: local }], hasConflict: false };
  if (!local) return { changes: [{ op: 'pull', data: remote }], hasConflict: false };

  switch (mergeStrategy) {
    case 'last-write-wins':
      var localTs = local._updatedAt || local.updatedAt || 0;
      var remoteTs = remote._updatedAt || remote.updatedAt || 0;
      if (localTs >= remoteTs) return { changes: [{ op: 'push', data: local }], hasConflict: false };
      return { changes: [{ op: 'pull', data: remote }], hasConflict: false };

    case 'append-unique':
      var localArr = Array.isArray(local) ? local : [];
      var remoteArr = Array.isArray(remote) ? remote : [];
      var localIds = {};
      localArr.forEach(function(item) { if (item.id) localIds[item.id] = true; });
      var toPull = remoteArr.filter(function(item) { return item.id && !localIds[item.id]; });
      var remoteIds = {};
      remoteArr.forEach(function(item) { if (item.id) remoteIds[item.id] = true; });
      var toPush = localArr.filter(function(item) { return item.id && !remoteIds[item.id]; });
      return { changes: [
        { op: 'pull', data: toPull },
        { op: 'push', data: toPush }
      ], hasConflict: false };

    case 'field-merge':
      var merged = Object.assign({}, remote, local);
      var hasConflict = false;
      Object.keys(local).forEach(function(key) {
        if (key.charAt(0) === '_') return;
        if (remote[key] !== undefined && remote[key] !== local[key]) {
          // 数值型取较大值（如亲密度、交互次数）
          if (typeof local[key] === 'number' && typeof remote[key] === 'number') {
            merged[key] = Math.max(local[key], remote[key]);
          } else {
            hasConflict = true;
          }
        }
      });
      return { changes: [{ op: 'merge', data: merged }], hasConflict: hasConflict, merged: merged };

    default:
      return { changes: [{ op: 'push', data: local }], hasConflict: false };
  }
}

// ===== 同步执行 =====
async function syncAll(options) {
  if (_syncing) return { success: false, error: '同步正在进行中' };
  options = options || {};
  _syncing = true;

  var results = { channels: {}, success: true, syncedAt: Date.now() };
  var onProgress = options.onProgress || function() {};

  try {
    var channels = options.channels || Object.keys(SYNC_CHANNELS);
    for (var i = 0; i < channels.length; i++) {
      var channelName = channels[i];
      var channelDef = SYNC_CHANNELS[channelName];
      if (!channelDef) continue;

      onProgress({ channel: channelName, progress: Math.round((i / channels.length) * 100) });

      try {
        var channelResult = await _syncChannel(channelName, channelDef, options);
        results.channels[channelName] = channelResult;
      } catch (e) {
        results.channels[channelName] = { success: false, error: e.message };
        if (!options.continueOnError) {
          results.success = false;
          break;
        }
      }
    }

    _syncState.lastSync = Date.now();
    _syncState.pendingOps = [];
    saveSyncState();
  } catch (e) {
    results.success = false;
    results.error = e.message;
  }

  _syncing = false;
  return results;
}

async function _syncChannel(name, def, options) {
  // 获取本地数据
  var localData = _readChannelData(name, def);

  // 获取远程数据（通过 sync-client 或 WebDAV）
  var remoteData = null;
  if (options.remoteStore && typeof options.remoteStore.get === 'function') {
    remoteData = await options.remoteStore.get(name);
  } else if (Core.syncClient && Core.syncClient.pull) {
    try { remoteData = await Core.syncClient.pull(name); } catch (e) { /* offline */ }
  }

  // 计算 diff
  var diff = computeDiff(localData, remoteData, def.merge);

  // 应用变更
  var applied = [];
  for (var i = 0; i < diff.changes.length; i++) {
    var change = diff.changes[i];
    if (change.op === 'pull' && change.data) {
      _applyPull(name, def, change.data);
      applied.push('pull');
    } else if (change.op === 'push' && change.data) {
      if (options.remoteStore && typeof options.remoteStore.put === 'function') {
        await options.remoteStore.put(name, change.data);
      }
      applied.push('push');
    } else if (change.op === 'merge' && change.data) {
      _writeChannelData(name, def, change.data);
      if (options.remoteStore && typeof options.remoteStore.put === 'function') {
        await options.remoteStore.put(name, change.data);
      }
      applied.push('merge');
    }
  }

  if (diff.hasConflict) {
    _syncState.conflicts.push({ channel: name, timestamp: Date.now(), resolved: false });
  }

  return { success: true, applied: applied, hasConflict: diff.hasConflict };
}

function _readChannelData(name, def) {
  try {
    if (def.file) {
      var filePath = path.join(Core.DATA_ROOT, def.file);
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    if (def.dir) {
      var dirPath = path.join(Core.DATA_ROOT, def.dir);
      if (fs.existsSync(dirPath)) {
        var files = fs.readdirSync(dirPath).filter(function(f) { return f.endsWith('.json'); });
        return files.map(function(f) {
          try { return JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8')); } catch (e) { return null; }
        }).filter(Boolean);
      }
    }
  } catch (e) { /* read error */ }
  return null;
}

function _writeChannelData(name, def, data) {
  try {
    if (def.file) {
      var filePath = path.join(Core.DATA_ROOT, def.file);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (e) { console.warn('cloud-sync: 写入失败 [' + name + ']', e.message); }
}

function _applyPull(name, def, data) {
  if (def.merge === 'append-unique' && Array.isArray(data)) {
    var existing = _readChannelData(name, def) || [];
    var merged = existing.concat(data);
    _writeChannelData(name, def, merged);
  } else {
    _writeChannelData(name, def, data);
  }
}

// ===== 离线队列 =====
function queueOp(operation) {
  _syncState.pendingOps.push({ op: operation, queuedAt: Date.now() });
  saveSyncState();
}

function getPendingOps() { return _syncState.pendingOps.slice(); }
function getConflicts() { return _syncState.conflicts.slice(); }
function resolveConflict(index, resolution) {
  if (index >= 0 && index < _syncState.conflicts.length) {
    _syncState.conflicts[index].resolved = true;
    _syncState.conflicts[index].resolution = resolution;
    saveSyncState();
    return true;
  }
  return false;
}

// ===== 状态查询 =====
function getSyncStatus() {
  return {
    device: _syncState.device,
    lastSync: _syncState.lastSync,
    syncing: _syncing,
    pendingOps: _syncState.pendingOps.length,
    conflicts: _syncState.conflicts.filter(function(c) { return !c.resolved; }).length,
    channels: Object.keys(SYNC_CHANNELS)
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'cloud-sync',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }
    loadSyncState();
    Core.cloudSync = {
      sync: syncAll,
      status: getSyncStatus,
      queue: queueOp,
      pendingOps: getPendingOps,
      conflicts: getConflicts,
      resolveConflict: resolveConflict,
      computeDiff: computeDiff,
      SYNC_CHANNELS: SYNC_CHANNELS
    };
    console.log('\u2705 cloud-sync \u5df2\u52a0\u8f7d\uff08\u7edf\u4e00\u4e91\u540c\u6b65: ' + Object.keys(SYNC_CHANNELS).length + ' \u4e2a\u901a\u9053, \u8bbe\u5907: ' + _syncState.device + '\uff09');
  }
};
