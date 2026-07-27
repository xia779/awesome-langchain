// modules/health-monitor.js - 系统健康监控 (P7-3)
// 统一健康检查 + 异常检测 + 性能指标聚合
'use strict';

var Core = null;
var fs = null;
var path = null;

var HEALTH_FILE = '';
var _metrics = { checks: [], history: [], alerts: [] };
var _checkInterval = null;

// ===== 健康检查定义 =====
var HEALTH_CHECKS = [
  { id: 'disk_space', name: '磁盘空间', critical: true },
  { id: 'memory_usage', name: '内存使用', critical: true },
  { id: 'data_integrity', name: '数据完整性', critical: true },
  { id: 'api_connectivity', name: 'API连通性', critical: false },
  { id: 'module_status', name: '模块状态', critical: false },
  { id: 'db_health', name: '数据库健康', critical: false },
  { id: 'sync_status', name: '同步状态', critical: false }
];

// ===== 执行健康检查 =====
function runHealthCheck() {
  var results = [];
  var now = Date.now();

  // 磁盘空间
  try {
    var dataRoot = Core.DATA_ROOT || '';
    if (dataRoot && fs.existsSync(dataRoot)) {
      var files = fs.readdirSync(dataRoot);
      var totalSize = 0;
      files.forEach(function(f) {
        try { totalSize += fs.statSync(path.join(dataRoot, f)).size; } catch (e) {}
      });
      results.push({ id: 'disk_space', status: totalSize < 500 * 1024 * 1024 ? 'healthy' : 'warning', value: Math.round(totalSize / 1024 / 1024) + 'MB', timestamp: now });
    } else {
      results.push({ id: 'disk_space', status: 'unknown', value: 'N/A', timestamp: now });
    }
  } catch (e) {
    results.push({ id: 'disk_space', status: 'error', value: e.message, timestamp: now });
  }

  // 内存使用
  try {
    var mem = process.memoryUsage();
    var heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    var status = heapMB < 200 ? 'healthy' : (heapMB < 500 ? 'warning' : 'critical');
    results.push({ id: 'memory_usage', status: status, value: heapMB + 'MB / ' + Math.round(mem.heapTotal / 1024 / 1024) + 'MB', timestamp: now });
  } catch (e) {
    results.push({ id: 'memory_usage', status: 'unknown', value: 'N/A', timestamp: now });
  }

  // 数据完整性
  try {
    var dataRoot2 = Core.DATA_ROOT || '';
    var criticalFiles = ['config.json'];
    var missing = criticalFiles.filter(function(f) { return !fs.existsSync(path.join(dataRoot2, f)); });
    results.push({ id: 'data_integrity', status: missing.length === 0 ? 'healthy' : 'warning', value: missing.length === 0 ? '完整' : '缺失: ' + missing.join(', '), timestamp: now });
  } catch (e) {
    results.push({ id: 'data_integrity', status: 'error', value: e.message, timestamp: now });
  }

  // 模块状态
  try {
    var moduleCount = 0;
    var modulesDir = path.join(path.dirname(Core.DATA_ROOT || '.'), 'modules');
    if (fs.existsSync(modulesDir)) {
      moduleCount = fs.readdirSync(modulesDir).filter(function(f) { return f.endsWith('.js'); }).length;
    }
    results.push({ id: 'module_status', status: moduleCount > 0 ? 'healthy' : 'warning', value: moduleCount + ' 个模块', timestamp: now });
  } catch (e) {
    results.push({ id: 'module_status', status: 'unknown', value: 'N/A', timestamp: now });
  }

  // 数据库健康
  try {
    if (Core.db && typeof Core.db.prepare === 'function') {
      Core.db.prepare('SELECT 1').get();
      results.push({ id: 'db_health', status: 'healthy', value: 'SQLite 正常', timestamp: now });
    } else {
      results.push({ id: 'db_health', status: 'warning', value: 'SQLite 未初始化', timestamp: now });
    }
  } catch (e) {
    results.push({ id: 'db_health', status: 'error', value: e.message, timestamp: now });
  }

  // 同步状态
  if (Core.cloudSync && Core.cloudSync.status) {
    var syncStatus = Core.cloudSync.status();
    results.push({ id: 'sync_status', status: syncStatus.conflicts > 0 ? 'warning' : 'healthy', value: '上次同步: ' + (syncStatus.lastSync ? new Date(syncStatus.lastSync).toLocaleString('zh-CN') : '从未'), timestamp: now });
  } else {
    results.push({ id: 'sync_status', status: 'unknown', value: '云同步未加载', timestamp: now });
  }

  // API 连通性（基于 model-router 统计）
  if (Core.modelRouter && Core.modelRouter.stats) {
    var routerStats = Core.modelRouter.stats();
    results.push({ id: 'api_connectivity', status: routerStats.activeProviders > 0 ? 'healthy' : 'warning', value: routerStats.activeProviders + ' 个活跃 provider', timestamp: now });
  } else {
    results.push({ id: 'api_connectivity', status: 'unknown', value: '路由未加载', timestamp: now });
  }

  _metrics.checks = results;
  _metrics.history.push({ timestamp: now, results: results.map(function(r) { return { id: r.id, status: r.status }; }) });
  if (_metrics.history.length > 100) _metrics.history = _metrics.history.slice(-100);

  // 异常检测
  _detectAnomalies(results);

  saveMetrics();
  return results;
}

// ===== 异常检测 =====
function _detectAnomalies(results) {
  results.forEach(function(r) {
    if (r.status === 'critical' || r.status === 'error') {
      var existing = _metrics.alerts.find(function(a) { return a.checkId === r.id && !a.resolved; });
      if (!existing) {
        _metrics.alerts.push({
          id: 'alert_' + Date.now().toString(36),
          checkId: r.id,
          severity: r.status,
          message: r.name + ': ' + r.value,
          timestamp: Date.now(),
          resolved: false
        });
      }
    }
  });
}

// ===== 性能指标聚合 =====
function getPerformanceMetrics() {
  var metrics = { uptime: process.uptime(), memory: process.memoryUsage(), timestamp: Date.now() };

  if (Core.observability && Core.observability.getStats) {
    try { metrics.observability = Core.observability.getStats(); } catch (e) {}
  }
  if (Core.analytics && Core.analytics.getTodayStats) {
    try { metrics.analytics = Core.analytics.getTodayStats(); } catch (e) {}
  }
  if (Core.modelRouter && Core.modelRouter.stats) {
    try { metrics.modelRouter = Core.modelRouter.stats(); } catch (e) {}
  }

  return metrics;
}

// ===== 综合报告 =====
function getHealthReport() {
  var checks = _metrics.checks.length > 0 ? _metrics.checks : runHealthCheck();
  var healthy = checks.filter(function(c) { return c.status === 'healthy'; }).length;
  var total = checks.length;
  var overallStatus = healthy === total ? 'healthy' : (checks.some(function(c) { return c.status === 'critical'; }) ? 'critical' : 'degraded');

  return {
    status: overallStatus,
    score: Math.round(healthy / Math.max(1, total) * 100),
    checks: checks,
    activeAlerts: _metrics.alerts.filter(function(a) { return !a.resolved; }),
    lastCheck: _metrics.history.length > 0 ? _metrics.history[_metrics.history.length - 1].timestamp : null,
    performance: getPerformanceMetrics()
  };
}

// ===== 告警管理 =====
function resolveAlert(alertId) {
  var alert = _metrics.alerts.find(function(a) { return a.id === alertId; });
  if (alert) { alert.resolved = true; alert.resolvedAt = Date.now(); saveMetrics(); return true; }
  return false;
}

function getAlerts(includeResolved) {
  if (includeResolved) return _metrics.alerts.slice();
  return _metrics.alerts.filter(function(a) { return !a.resolved; });
}

// ===== 持久化 =====
function loadMetrics() {
  if (!Core || !Core.DATA_ROOT) return;
  HEALTH_FILE = path.join(Core.DATA_ROOT, 'health-metrics.json');
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      var data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
      if (data.history) _metrics.history = data.history;
      if (data.alerts) _metrics.alerts = data.alerts;
    }
  } catch (e) { /* fresh */ }
}

function saveMetrics() {
  try {
    if (HEALTH_FILE) fs.writeFileSync(HEALTH_FILE, JSON.stringify({
      history: _metrics.history.slice(-50),
      alerts: _metrics.alerts.slice(-20)
    }, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

// ===== 模块导出 =====
module.exports = {
  name: 'health-monitor',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }
    loadMetrics();

    // 启动时执行一次健康检查
    setTimeout(function() { runHealthCheck(); }, 3000);

    Core.healthMonitor = {
      check: runHealthCheck,
      report: getHealthReport,
      metrics: getPerformanceMetrics,
      alerts: getAlerts,
      resolveAlert: resolveAlert,
      HEALTH_CHECKS: HEALTH_CHECKS
    };
    console.log('\u2705 health-monitor \u5df2\u52a0\u8f7d\uff08\u7cfb\u7edf\u5065\u5eb7\u76d1\u63a7: ' + HEALTH_CHECKS.length + ' \u9879\u68c0\u67e5\uff09');
  }
};
