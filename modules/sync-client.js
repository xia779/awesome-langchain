// modules/sync-client.js - 跨端增量同步客户端（基于 last_modified 的 diff 同步）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

let Core = null;

// 🔒 #7 修复：缓存认证 Token，便于 401 时刷新重试
var _cachedToken = '';

// ===== 同步状态 =====
let _syncTimer = null;
let _lastSyncTime = 0;
let _syncing = false;
let _syncLog = []; // 最近 20 条同步记录

const MAX_LOG = 20;

// ===== 配置 =====
function getSyncConfig() {
  var defaults = {
    enabled: false,
    // 默认同步到本机 web-server；端口动态解析（8080 被占用时 main.js 会自动递增）
    serverUrl: (Core && typeof Core.getBackendBase === 'function') ? Core.getBackendBase() : 'http://127.0.0.1:8080',
    intervalMs: 300000,                    // 5 分钟自动同步
    syncSessions: true,
    syncMemories: true,
    syncConfig: true,
    deviceId: _getDeviceId()
  };
  if (Core && Core.config && Core.config.sync) {
    Object.assign(defaults, Core.config.sync);
  }
  return defaults;
}

function _getDeviceId() {
  // 基于 hostname + platform 生成稳定设备标识
  var os = require('os');
  var raw = os.hostname() + '-' + os.platform() + '-' + os.arch();
  // 简单 hash
  var hash = 0;
  for (var i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return 'dev_' + Math.abs(hash).toString(36);
}

// ===== 核心：推送本地变更到服务端 =====
async function pushChanges() {
  var cfg = getSyncConfig();
  if (!cfg.enabled) return { success: false, error: '同步未启用' };
  if (_syncing) return { success: false, error: '同步正在进行中' };

  _syncing = true;
  var startTime = Date.now();
  var changes = { sessions: [], memories: [], config: null };

  try {
    // 收集自上次同步以来的变更
    var since = _lastSyncTime || 0;

    // 1. 会话变更
    if (cfg.syncSessions && Core.db && Core.db._backend === 'sqlite') {
      changes.sessions = _getChangedSessions(since);
    }

    // 2. 记忆变更
    if (cfg.syncMemories && Core.db && Core.db._backend === 'sqlite') {
      changes.memories = _getChangedMemories(since);
    }

    // 3. 配置快照（仅在配置有变更时推送）
    if (cfg.syncConfig && Core.config) {
      changes.config = _getSafeConfig();
    }

    // 推送到服务端
    var payload = {
      deviceId: cfg.deviceId,
      timestamp: Date.now(),
      changes: changes
    };

    var response = await _httpPost(cfg.serverUrl + '/api/m/sync/push', payload);

    if (response && response.success) {
      _lastSyncTime = Date.now();
      _logSync('push', changes.sessions.length, changes.memories.length, null);
      return {
        success: true,
        pushed: { sessions: changes.sessions.length, memories: changes.memories.length, config: !!changes.config },
        duration: Date.now() - startTime
      };
    } else {
      var err = (response && response.error) || '服务端拒绝';
      _logSync('push', 0, 0, err);
      return { success: false, error: err };
    }
  } catch (e) {
    _logSync('push', 0, 0, e.message);
    return { success: false, error: e.message };
  } finally {
    _syncing = false;
  }
}

// ===== 核心：从服务端拉取变更 =====
async function pullChanges() {
  var cfg = getSyncConfig();
  if (!cfg.enabled) return { success: false, error: '同步未启用' };
  if (_syncing) return { success: false, error: '同步正在进行中' };

  _syncing = true;
  var startTime = Date.now();

  try {
    var since = _lastSyncTime || 0;
    var url = cfg.serverUrl + '/api/m/sync/pull?since=' + since + '&device=' + cfg.deviceId;
    var response = await _httpGet(url);

    if (!response || !response.success) {
      var err = (response && response.error) || '拉取失败';
      _logSync('pull', 0, 0, err);
      return { success: false, error: err };
    }

    var applied = { sessions: 0, memories: 0, config: false };
    var data = response.data || {};

    // 应用会话变更（last-write-wins）
    if (data.sessions && data.sessions.length > 0 && Core.db) {
      data.sessions.forEach(function(s) {
        try {
          Core.db.saveSession(s.id, s);
          applied.sessions++;
        } catch (e) {}
      });
    }

    // 应用记忆变更
    if (data.memories && data.memories.length > 0 && Core.db && Core.db._backend === 'sqlite') {
      data.memories.forEach(function(m) {
        try {
          var db = Core.db._db;
          if (db) {
            db.prepare('INSERT OR REPLACE INTO memories (id, user_id, content, tags, created_at) VALUES (?, ?, ?, ?, ?)')
              .run(m.id, m.user_id || 'admin', m.content, m.tags || '', m.created_at || Date.now());
            applied.memories++;
          }
        } catch (e) {}
      });
    }

    // 应用配置（合并，不覆盖本地敏感字段）
    if (data.config && Core.saveConfig) {
      var safeMerge = {};
      Object.keys(data.config).forEach(function(k) {
        if (k.indexOf('Key') === -1 && k.indexOf('Token') === -1 && k.indexOf('password') === -1) {
          safeMerge[k] = data.config[k];
        }
      });
      if (Object.keys(safeMerge).length > 0) {
        Core.saveConfig(safeMerge);
        applied.config = true;
      }
    }

    _lastSyncTime = Date.now();
    _logSync('pull', applied.sessions, applied.memories, null);

    return { success: true, applied: applied, duration: Date.now() - startTime };
  } catch (e) {
    _logSync('pull', 0, 0, e.message);
    return { success: false, error: e.message };
  } finally {
    _syncing = false;
  }
}

// ===== 双向同步 =====
async function syncBoth() {
  var pushResult = await pushChanges();
  var pullResult = await pullChanges();
  return {
    success: pushResult.success || pullResult.success,
    push: pushResult,
    pull: pullResult
  };
}

// ===== 自动同步定时器 =====
function startAutoSync() {
  var cfg = getSyncConfig();
  stopAutoSync();
  if (!cfg.enabled || cfg.intervalMs < 60000) return;

  _syncTimer = setInterval(function() {
    syncBoth().catch(function(e) {
      console.warn('⚠️ 自动同步失败:', e.message);
    });
  }, cfg.intervalMs);

  console.log('🔄 自动同步已启动（间隔 ' + Math.round(cfg.intervalMs / 60000) + ' 分钟）');
}

function stopAutoSync() {
  if (_syncTimer) {
    clearInterval(_syncTimer);
    _syncTimer = null;
  }
}

// ===== 辅助：获取变更的会话 =====
function _getChangedSessions(since) {
  var results = [];
  try {
    var db = Core.db._db;
    if (!db) return results;
    var rows = db.prepare(
      'SELECT s.id, s.user_id, s.title, s.parent_id, s.pinned, s.role_type, s.timestamp, s.created_at ' +
      'FROM sessions s WHERE s.timestamp > ? ORDER BY s.timestamp DESC LIMIT 50'
    ).all(since);

    rows.forEach(function(row) {
      // 附带消息
      var msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC').all(row.id);
      results.push({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        parentId: row.parent_id,
        pinned: row.pinned,
        roleType: row.role_type,
        timestamp: row.timestamp,
        createdAt: row.created_at,
        messages: msgs
      });
    });
  } catch (e) {
    console.warn('Sync: 获取会话变更失败', e.message);
  }
  return results;
}

// ===== 辅助：获取变更的记忆 =====
function _getChangedMemories(since) {
  var results = [];
  try {
    var db = Core.db._db;
    if (!db) return results;
    // memories 表可能有 updated_at 列（memory-enhance 扩展）
    var hasUpdatedAt = false;
    try {
      var cols = db.prepare("PRAGMA table_info(memories)").all();
      hasUpdatedAt = cols.some(function(c) { return c.name === 'updated_at'; });
    } catch (e) {}

    var sql = hasUpdatedAt
      ? 'SELECT id, user_id, content, tags, created_at, updated_at FROM memories WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 100'
      : 'SELECT id, user_id, content, tags, created_at FROM memories WHERE created_at > ? ORDER BY created_at DESC LIMIT 100';
    results = db.prepare(sql).all(since);
  } catch (e) {
    console.warn('Sync: 获取记忆变更失败', e.message);
  }
  return results;
}

// ===== 辅助：安全配置（排除敏感字段）=====
function _getSafeConfig() {
  if (!Core.config) return null;
  var safe = {};
  var sensitiveKeys = ['apiKey', 'apiKeys', 'bochaApiKey', 'tavilyApiKey', 'siliconFlowKey', 'token', 'password', 'secret'];
  Object.keys(Core.config).forEach(function(k) {
    var isSensitive = sensitiveKeys.some(function(sk) { return k.toLowerCase().indexOf(sk.toLowerCase()) !== -1; });
    if (!isSensitive && !k.startsWith('_')) {
      safe[k] = Core.config[k];
    }
  });
  return safe;
}

// ===== HTTP 工具 =====
// 🔒 #7 修复：获取并缓存认证 Token
function _resolveAuthToken() {
  if (!_cachedToken && Core && typeof Core.getAuthToken === 'function') {
    try { _cachedToken = Core.getAuthToken() || ''; } catch (e) {}
  }
  return _cachedToken;
}

function _httpPost(url, data) {
  return new Promise(function(resolve) {
    try {
      var parsed = new (require('url').URL)(url);
      var body = JSON.stringify(data);

      var doRequest = function(retried) {
        var headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        // 🔧 B02 兼容: 注入认证 Token（使用缓存）
        var token = _resolveAuthToken();
        if (token) headers['x-auth-token'] = token;

        var options = {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          headers: headers,
          timeout: 15000
        };
        var req = http.request(options, function(res) {
          // 🔒 #7 修复：检测 401 并尝试刷新 Token 后重试一次
          if (res.statusCode === 401 && !retried) {
            console.warn('⚠️ [sync] 收到 401，尝试刷新 Token...');
            var oldToken = _cachedToken;
            var newToken = '';
            try {
              // 直接从 Core 重新获取，绕过缓存以拿到最新 Token
              if (Core && typeof Core.getAuthToken === 'function') newToken = Core.getAuthToken() || '';
            } catch (refreshErr) {
              console.warn('⚠️ [sync] Token 刷新失败:', refreshErr.message);
            }
            if (newToken && newToken !== oldToken) {
              _cachedToken = newToken;
              res.resume(); // 丢弃当前响应体
              doRequest(true);
              return;
            }
            console.error('❌ [sync] Token 刷新后仍然 401，同步失败');
            res.resume();
            resolve({ success: false, error: 'Token 无效或已过期' });
            return;
          }
          var chunks = [];
          res.on('data', function(c) { chunks.push(c); });
          res.on('end', function() {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { resolve({ success: false, error: 'JSON parse error' }); }
          });
        });
        req.on('error', function(e) { resolve({ success: false, error: e.message }); });
        req.on('timeout', function() { req.destroy(); resolve({ success: false, error: 'timeout' }); });
        req.write(body);
        req.end();
      };

      doRequest(false);
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

function _httpGet(url) {
  return new Promise(function(resolve) {
    try {
      var parsed = new (require('url').URL)(url);

      var doRequest = function(retried) {
        var headers = {};
        // 🔧 B02 兼容: 注入认证 Token（使用缓存）
        var token = _resolveAuthToken();
        if (token) headers['x-auth-token'] = token;

        var options = {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: headers,
          timeout: 15000
        };
        var req = http.request(options, function(res) {
          // 🔒 #7 修复：检测 401 并尝试刷新 Token 后重试一次
          if (res.statusCode === 401 && !retried) {
            console.warn('⚠️ [sync] 收到 401，尝试刷新 Token...');
            var oldToken = _cachedToken;
            var newToken = '';
            try {
              // 直接从 Core 重新获取，绕过缓存以拿到最新 Token
              if (Core && typeof Core.getAuthToken === 'function') newToken = Core.getAuthToken() || '';
            } catch (refreshErr) {
              console.warn('⚠️ [sync] Token 刷新失败:', refreshErr.message);
            }
            if (newToken && newToken !== oldToken) {
              _cachedToken = newToken;
              res.resume(); // 丢弃当前响应体
              doRequest(true);
              return;
            }
            console.error('❌ [sync] Token 刷新后仍然 401，同步失败');
            res.resume();
            resolve({ success: false, error: 'Token 无效或已过期' });
            return;
          }
          var chunks = [];
          res.on('data', function(c) { chunks.push(c); });
          res.on('end', function() {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { resolve({ success: false, error: 'JSON parse error' }); }
          });
        });
        req.on('error', function(e) { resolve({ success: false, error: e.message }); });
        req.on('timeout', function() { req.destroy(); resolve({ success: false, error: 'timeout' }); });
        req.end();
      };

      doRequest(false);
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

// ===== 同步日志 =====
function _logSync(direction, sessions, memories, error) {
  _syncLog.unshift({
    time: Date.now(),
    direction: direction,
    sessions: sessions,
    memories: memories,
    error: error
  });
  if (_syncLog.length > MAX_LOG) _syncLog.pop();
}

function getSyncStatus() {
  var cfg = getSyncConfig();
  return {
    enabled: cfg.enabled,
    serverUrl: cfg.serverUrl,
    deviceId: cfg.deviceId,
    intervalMs: cfg.intervalMs,
    lastSyncTime: _lastSyncTime,
    syncing: _syncing,
    autoSyncRunning: !!_syncTimer,
    recentLog: _syncLog.slice(0, 5)
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'sync-client',
  dependencies: ['database'],
  init: function(_Core) {
    Core = _Core;

    Core.syncClient = {
      push: pushChanges,
      pull: pullChanges,
      sync: syncBoth,
      startAuto: startAutoSync,
      stopAuto: stopAutoSync,
      status: getSyncStatus,
      getConfig: getSyncConfig
    };

    // 如果配置中启用了同步，自动启动
    var cfg = getSyncConfig();
    if (cfg.enabled) {
      setTimeout(startAutoSync, 5000);
    }

    console.log('✅ 同步客户端已加载（设备: ' + cfg.deviceId + ', ' + (cfg.enabled ? '已启用' : '未启用') + '）');
  }
};
