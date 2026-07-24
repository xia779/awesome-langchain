// modules/sync-client.js - 跨端增量同步客户端（基于 last_modified 的 diff 同步）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

let Core = null;

// 🔒 #7 修复：缓存认证 Token，便于 401 时刷新重试
var _cachedToken = '';

// ===== 同步状态 =====
let _syncTimer = null;
let _lastSyncTime = 0;
let _syncing = false;
let _syncLog = []; // 最近 20 条同步记录

// ===== Phase 5 增强：健康监控 + 退避 + 离线队列 =====
let _consecutiveFailures = 0;       // 连续失败次数
const MAX_CONSECUTIVE_FAILURES = 5;  // 超过此数通知用户
let _backoffMs = 0;                  // 当前退避延迟
const BACKOFF_BASE = 30000;          // 退避基数 30s
const BACKOFF_MAX = 900000;          // 退避上限 15min
let _offlineQueue = [];              // 离线期间的待推送变更
let _offlineQueuePath = '';          // 离线队列持久化路径
let _sessionWatermarks = {};         // sessionId → 上次同步的消息时间戳（增量同步）

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

    // 1. 会话变更（Phase 5: 增量消息）
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

    // Phase 5: 先 flush 离线队列中的历史变更
    var queuedChanges = _flushOfflineQueue();
    if (queuedChanges) {
      changes.sessions = (queuedChanges.sessions || []).concat(changes.sessions);
      changes.memories = (queuedChanges.memories || []).concat(changes.memories);
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
      // Phase 5: 更新增量水位线
      _updateWatermarks(changes.sessions);
      // Phase 5: 重置健康计数
      _consecutiveFailures = 0;
      _backoffMs = 0;
      _logSync('push', changes.sessions.length, changes.memories.length, null);
      return {
        success: true,
        pushed: { sessions: changes.sessions.length, memories: changes.memories.length, config: !!changes.config },
        duration: Date.now() - startTime
      };
    } else {
      var err = (response && response.error) || '服务端拒绝';
      _handleSyncFailure(err);
      // Phase 5: 网络错误时入离线队列
      if (_isNetworkError(err)) {
        _enqueueOffline(changes);
      }
      _logSync('push', 0, 0, err);
      return { success: false, error: err };
    }
  } catch (e) {
    _handleSyncFailure(e.message);
    if (_isNetworkError(e.message)) {
      _enqueueOffline(changes);
    }
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
        } catch (e) { console.warn('⚠️ [sync-client] 操作失败:', e.message || e); }
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
        } catch (e) { console.warn('⚠️ [sync-client] 操作失败:', e.message || e); }
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
    // Phase 5: 重置健康计数
    _consecutiveFailures = 0;
    _backoffMs = 0;
    _logSync('pull', applied.sessions, applied.memories, null);

    return { success: true, applied: applied, duration: Date.now() - startTime };
  } catch (e) {
    _handleSyncFailure(e.message);
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

// ===== 自动同步定时器（Phase 5: 指数退避）=====
function startAutoSync() {
  var cfg = getSyncConfig();
  stopAutoSync();
  if (!cfg.enabled || cfg.intervalMs < 60000) return;

  // Phase 5: 使用 setTimeout 链式调用（支持动态退避间隔）
  function scheduleNext() {
    var delay = cfg.intervalMs;
    // 如果有退避，使用退避间隔（但不超过配置间隔的 3 倍）
    if (_backoffMs > 0) {
      delay = Math.min(_backoffMs, cfg.intervalMs * 3);
    }
    _syncTimer = setTimeout(function() {
      syncBoth().catch(function(e) {
        console.warn('⚠️ 自动同步失败:', e.message);
      }).finally(function() {
        scheduleNext(); // 链式调度下一次
      });
    }, delay);
  }

  scheduleNext();
  console.log('🔄 自动同步已启动（间隔 ' + Math.round(cfg.intervalMs / 60000) + ' 分钟，支持退避）');
}

function stopAutoSync() {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
}

// ===== 辅助：获取变更的会话（Phase 5: 增量消息同步）=====
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
      // Phase 5: 增量消息 — 只取该会话自上次同步后的新消息
      var watermark = _sessionWatermarks[row.id] || 0;
      var msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE session_id = ? AND timestamp > ? ORDER BY id ASC').all(row.id, watermark);
      // 如果会话元数据变了但没有新消息，仍然同步元数据（标记 messages: null 表示仅元数据）
      results.push({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        parentId: row.parent_id,
        pinned: row.pinned,
        roleType: row.role_type,
        timestamp: row.timestamp,
        createdAt: row.created_at,
        messages: msgs.length > 0 ? msgs : null,
        incremental: true  // 标记为增量模式
      });
    });
  } catch (e) {
    console.warn('Sync: 获取会话变更失败', e.message);
  }
  return results;
}

// Phase 5: 推送成功后更新消息水位线
function _updateWatermarks(sessions) {
  if (!sessions || !sessions.length) return;
  sessions.forEach(function(s) {
    if (s.messages && s.messages.length > 0) {
      var maxTs = 0;
      s.messages.forEach(function(m) { if (m.timestamp > maxTs) maxTs = m.timestamp; });
      _sessionWatermarks[s.id] = maxTs;
    }
  });
  // 持久化水位线
  _persistWatermarks();
}

function _persistWatermarks() {
  try {
    if (_offlineQueuePath) {
      var wmPath = _offlineQueuePath.replace('offline-queue.json', 'watermarks.json');
      fs.writeFileSync(wmPath, JSON.stringify(_sessionWatermarks));
    }
  } catch (e) { console.warn('⚠️ [sync-client] 操作失败:', e.message || e); }
}

function _loadWatermarks() {
  try {
    if (_offlineQueuePath) {
      var wmPath = _offlineQueuePath.replace('offline-queue.json', 'watermarks.json');
      if (fs.existsSync(wmPath)) {
        _sessionWatermarks = JSON.parse(fs.readFileSync(wmPath, 'utf8'));
      }
    }
  } catch (e) { _sessionWatermarks = {}; }
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
    } catch (e) { console.warn('⚠️ [sync-client] 操作失败:', e.message || e); }

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

// ===== Phase 5: 离线队列 + 健康监控 =====

function _isNetworkError(msg) {
  if (!msg) return false;
  return msg.indexOf('ECONNREFUSED') !== -1 || msg.indexOf('ENOTFOUND') !== -1 ||
    msg.indexOf('ETIMEDOUT') !== -1 || msg.indexOf('ECONNRESET') !== -1 ||
    msg.indexOf('timeout') !== -1 || msg.indexOf('Failed to fetch') !== -1 ||
    msg.indexOf('network') !== -1;
}

function _handleSyncFailure(errMsg) {
  _consecutiveFailures++;
  // 指数退避
  _backoffMs = Math.min(BACKOFF_BASE * Math.pow(2, _consecutiveFailures - 1), BACKOFF_MAX);

  if (_consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
    console.error('⚠️ [sync] 连续 ' + _consecutiveFailures + ' 次同步失败，退避间隔: ' + Math.round(_backoffMs / 1000) + 's');
    if (Core && Core.showNotification) {
      Core.showNotification('warning', '⚠️ 云同步连续失败 ' + _consecutiveFailures + ' 次，请检查网络或服务器状态');
    }
  }
}

function _enqueueOffline(changes) {
  if (!changes) return;
  _offlineQueue.push({ time: Date.now(), changes: changes });
  // 限制队列大小（最多 50 条）
  if (_offlineQueue.length > 50) _offlineQueue = _offlineQueue.slice(-50);
  _persistOfflineQueue();
}

function _flushOfflineQueue() {
  if (_offlineQueue.length === 0) return null;
  // 合并所有排队变更
  var merged = { sessions: [], memories: [] };
  _offlineQueue.forEach(function(item) {
    if (item.changes.sessions) merged.sessions = merged.sessions.concat(item.changes.sessions);
    if (item.changes.memories) merged.memories = merged.memories.concat(item.changes.memories);
  });
  _offlineQueue = [];
  _persistOfflineQueue();
  console.log('🔄 [sync] 已合并 ' + merged.sessions.length + ' 条离线会话变更');
  return merged;
}

function _persistOfflineQueue() {
  try {
    if (_offlineQueuePath) {
      fs.writeFileSync(_offlineQueuePath, JSON.stringify(_offlineQueue));
    }
  } catch (e) { console.warn('⚠️ [sync-client] 操作失败:', e.message || e); }
}

function _loadOfflineQueue() {
  try {
    if (_offlineQueuePath && fs.existsSync(_offlineQueuePath)) {
      _offlineQueue = JSON.parse(fs.readFileSync(_offlineQueuePath, 'utf8'));
      if (_offlineQueue.length > 0) {
        console.log('📦 [sync] 恢复 ' + _offlineQueue.length + ' 条离线待同步变更');
      }
    }
  } catch (e) { _offlineQueue = []; }
}

// ===== HTTP 工具（Phase 5: 支持 HTTPS）=====
// 🔒 #7 修复：获取并缓存认证 Token
function _resolveAuthToken() {
  if (!_cachedToken && Core && typeof Core.getAuthToken === 'function') {
    try { _cachedToken = Core.getAuthToken() || ''; } catch (e) { console.warn('⚠️ [sync-client] 操作失败:', e.message || e); }
  }
  return _cachedToken;
}

function _httpPost(url, data) {
  return new Promise(function(resolve) {
    try {
      var parsed = new (require('url').URL)(url);
      var body = JSON.stringify(data);
      // Phase 5: 根据协议选择 http/https 模块
      var transport = parsed.protocol === 'https:' ? https : http;

      var doRequest = function(retried) {
        var headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        // 🔧 B02 兼容: 注入认证 Token（使用缓存）
        var token = _resolveAuthToken();
        if (token) headers['x-auth-token'] = token;

        var options = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname,
          method: 'POST',
          headers: headers,
          timeout: 15000
        };
        var req = transport.request(options, function(res) {
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
      // Phase 5: 根据协议选择 http/https 模块
      var transport = parsed.protocol === 'https:' ? https : http;

      var doRequest = function(retried) {
        var headers = {};
        // 🔧 B02 兼容: 注入认证 Token（使用缓存）
        var token = _resolveAuthToken();
        if (token) headers['x-auth-token'] = token;

        var options = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: headers,
          timeout: 15000
        };
        var req = transport.request(options, function(res) {
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
    recentLog: _syncLog.slice(0, 5),
    // Phase 5: 健康指标
    health: {
      consecutiveFailures: _consecutiveFailures,
      backoffMs: _backoffMs,
      offlineQueueSize: _offlineQueue.length,
      watermarkCount: Object.keys(_sessionWatermarks).length
    }
  };
}

// ===== 模块导出 =====
module.exports = {
  name: 'sync-client',
  dependencies: ['database'],
  init: function(_Core) {
    Core = _Core;

    // Phase 5: 初始化离线队列和水位线路径
    try {
      var syncDir = path.join(Core.DATA_ROOT, 'sync');
      if (!fs.existsSync(syncDir)) fs.mkdirSync(syncDir, { recursive: true });
      _offlineQueuePath = path.join(syncDir, 'offline-queue.json');
      _loadOfflineQueue();
      _loadWatermarks();
    } catch (e) {
      console.warn('⚠️ [sync] 初始化持久化路径失败:', e.message);
    }

    Core.syncClient = {
      push: pushChanges,
      pull: pullChanges,
      sync: syncBoth,
      startAuto: startAutoSync,
      stopAuto: stopAutoSync,
      status: getSyncStatus,
      getConfig: getSyncConfig
    };

    // Phase 5: 注册 /sync 命令
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('sync', '手动触发云同步 / 查看同步状态', function(args) {
        var sub = (args || '').trim().toLowerCase();
        if (sub === 'status' || sub === '') {
          var st = getSyncStatus();
          var lines = [
            '📡 云同步状态:',
            '  启用: ' + (st.enabled ? '是' : '否'),
            '  服务器: ' + st.serverUrl,
            '  设备: ' + st.deviceId,
            '  上次同步: ' + (st.lastSyncTime ? new Date(st.lastSyncTime).toLocaleString() : '从未'),
            '  自动同步: ' + (st.autoSyncRunning ? '运行中' : '未运行'),
            '  连续失败: ' + st.health.consecutiveFailures + ' 次',
            '  离线队列: ' + st.health.offlineQueueSize + ' 条待推送'
          ];
          return lines.join('\n');
        }
        if (sub === 'push' || sub === 'pull' || sub === 'both') {
          var task = sub === 'push' ? pushChanges() : sub === 'pull' ? pullChanges() : syncBoth();
          return task.then(function(r) {
            return r.success ? '✅ 同步完成: ' + JSON.stringify(r.pushed || r.applied || r) : '❌ 同步失败: ' + r.error;
          });
        }
        return '用法: /sync [status|push|pull|both]';
      });
    }

    // 如果配置中启用了同步，自动启动
    var cfg = getSyncConfig();
    if (cfg.enabled) {
      setTimeout(startAutoSync, 5000);
    }

    console.log('✅ 同步客户端已加载（设备: ' + cfg.deviceId + ', ' + (cfg.enabled ? '已启用' : '未启用') + ', Phase 5 增强）');
  }
};
