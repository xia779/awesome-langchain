// modules/market-db.js - 行情数据存储层
// 主后端：better-sqlite3（DATA_ROOT/market.db，Electron 内可用）；
// 回退后端：纯内存实现（better-sqlite3 无法加载时，如 node:test / CI 环境）。
// 表：watchlist / quotes_snap / kline_daily / kline_min1 / alerts_log /
//     review_reports / strategies / backtest_results / patch_audit（P7 用）
var path = require('path');
var fs = require('fs');

var Core = null;

var Database = null;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }

// ================= SQLite 后端 =================
var DDL = [
  'CREATE TABLE IF NOT EXISTS watchlist (code TEXT PRIMARY KEY, name TEXT, sort INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS quotes_snap (code TEXT, ts INTEGER, price REAL, pct_chg REAL, vol REAL, vol_ratio REAL)',
  'CREATE TABLE IF NOT EXISTS kline_daily (code TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, vol REAL, amount REAL, PRIMARY KEY (code, date))',
  'CREATE TABLE IF NOT EXISTS kline_min1 (code TEXT, ts INTEGER, open REAL, high REAL, low REAL, close REAL, vol REAL, PRIMARY KEY (code, ts))',
  'CREATE TABLE IF NOT EXISTS alerts_log (id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id TEXT, code TEXT, ts INTEGER, msg TEXT, channels TEXT)',
  'CREATE TABLE IF NOT EXISTS review_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT UNIQUE, content TEXT, created_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, name TEXT, dsl TEXT, enabled INTEGER DEFAULT 1, created_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS backtest_results (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT, params TEXT, metrics TEXT, created_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS patch_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, branch TEXT, files TEXT, diff_hash TEXT, test_result TEXT, approver TEXT, result TEXT, rolled_back INTEGER DEFAULT 0)',
];

function createSqlImpl() {
  var dbPath = (Core.config && Core.config.marketDbPath) || path.join(Core.DATA_ROOT, 'market.db');
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (e) { console.warn('⚠️ [market-db] 操作失败:', e.message || e); }
  var db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  DDL.forEach(function(sql) { db.exec(sql); });
  db.exec('CREATE INDEX IF NOT EXISTS idx_snap_code_ts ON quotes_snap (code, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_min1_code_ts ON kline_min1 (code, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts_log (ts)');

  return {
    _backend: 'sqlite',
    addWatch: function(code, name, sort) {
      db.prepare('INSERT OR REPLACE INTO watchlist (code, name, sort) VALUES (?, ?, ?)').run(code, name || null, sort || 0);
      return true;
    },
    removeWatch: function(code) { return db.prepare('DELETE FROM watchlist WHERE code = ?').run(code).changes > 0; },
    listWatch: function() { return db.prepare('SELECT code, name, sort FROM watchlist ORDER BY sort ASC, rowid ASC').all(); },
    insertSnap: function(s) {
      db.prepare('INSERT INTO quotes_snap (code, ts, price, pct_chg, vol, vol_ratio) VALUES (?, ?, ?, ?, ?, ?)')
        .run(s.code, s.ts || Date.now(), s.price, s.changePct, s.vol, s.volRatio || null);
    },
    getLastQuotes: function(codes) {
      var stmt = db.prepare('SELECT code, ts, price, pct_chg AS changePct, vol FROM quotes_snap WHERE code = ? ORDER BY ts DESC LIMIT 1');
      return (codes || []).map(function(c) { return stmt.get(c); }).filter(Boolean);
    },
    clearSnaps: function() { db.exec('DELETE FROM quotes_snap'); },
    upsertKline: function(period, code, bars) {
      var isMin = period === '1m';
      var stmt = isMin
        ? db.prepare('INSERT OR REPLACE INTO kline_min1 (code, ts, open, high, low, close, vol) VALUES (?, ?, ?, ?, ?, ?, ?)')
        : db.prepare('INSERT OR REPLACE INTO kline_daily (code, date, open, high, low, close, vol, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      db.transaction(function(rows) {
        rows.forEach(function(b) {
          if (isMin) stmt.run(code, b.ts, b.open, b.high, b.low, b.close, b.vol);
          else stmt.run(code, b.date || (b.datetime || '').slice(0, 10), b.open, b.high, b.low, b.close, b.vol, b.amount || null);
        });
      })(bars || []);
      return (bars || []).length;
    },
    getKline: function(code, period, limit) {
      var isMin = period === '1m';
      return db.prepare('SELECT * FROM ' + (isMin ? 'kline_min1' : 'kline_daily') + ' WHERE code = ? ORDER BY ' + (isMin ? 'ts' : 'date') + ' DESC LIMIT ?')
        .all(code, limit || 800).reverse();
    },
    pruneMin1: function() {
      return db.prepare('DELETE FROM kline_min1 WHERE ts < ?').run(Date.now() - 30 * 86400000).changes;
    },
    logAlert: function(ruleId, code, msg, channels) {
      db.prepare('INSERT INTO alerts_log (rule_id, code, ts, msg, channels) VALUES (?, ?, ?, ?, ?)')
        .run(ruleId, code, Date.now(), msg, JSON.stringify(channels || []));
    },
    getAlerts: function(limit) { return db.prepare('SELECT * FROM alerts_log ORDER BY ts DESC LIMIT ?').all(limit || 100); },
    saveReport: function(date, content) {
      db.prepare('INSERT OR REPLACE INTO review_reports (date, content, created_at) VALUES (?, ?, ?)').run(date, content, Date.now());
    },
    getReport: function(date) { return db.prepare('SELECT * FROM review_reports WHERE date = ? ORDER BY id DESC LIMIT 1').get(date); },
    saveStrategy: function(id, name, dsl, enabled) {
      db.prepare('INSERT OR REPLACE INTO strategies (id, name, dsl, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, typeof dsl === 'string' ? dsl : JSON.stringify(dsl), enabled === false ? 0 : 1, Date.now());
    },
    listStrategies: function(enabledOnly) {
      return db.prepare('SELECT * FROM strategies' + (enabledOnly ? ' WHERE enabled = 1' : '') + ' ORDER BY created_at ASC').all();
    },
    getStrategy: function(id) { return db.prepare('SELECT * FROM strategies WHERE id = ?').get(id); },
    deleteStrategy: function(id) { return db.prepare('DELETE FROM strategies WHERE id = ?').run(id).changes > 0; },
    saveBacktest: function(strategyId, params, metrics) {
      return db.prepare('INSERT INTO backtest_results (strategy_id, params, metrics, created_at) VALUES (?, ?, ?, ?)')
        .run(strategyId, JSON.stringify(params || {}), JSON.stringify(metrics || {}), Date.now()).lastInsertRowid;
    },
    getBacktests: function(strategyId, limit) {
      return db.prepare('SELECT * FROM backtest_results WHERE strategy_id = ? ORDER BY id DESC LIMIT ?').all(strategyId, limit || 20);
    },
    logPatch: function(entry) {
      return db.prepare('INSERT INTO patch_audit (ts, branch, files, diff_hash, test_result, approver, result, rolled_back) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Date.now(), entry.branch || '', JSON.stringify(entry.files || []), entry.diffHash || '',
          entry.testResult || '', entry.approver || '', entry.result || '', entry.rolledBack ? 1 : 0).lastInsertRowid;
    },
    listPatches: function(limit) { return db.prepare('SELECT * FROM patch_audit ORDER BY id DESC LIMIT ?').all(limit || 50); },
    _close: function() { db.close(); },
  };
}

// ================= 内存回退后端（测试/CI 用）=================
function createMemImpl() {
  var watchlist = [], snaps = [], kDaily = {}, kMin1 = {}, alerts = [], reports = {};
  var strategies = {}, backtests = [], patches = [];
  var seq = { alert: 1, bt: 1, patch: 1, report: 1 };

  function klineTable(period) { return period === '1m' ? kMin1 : kDaily; }
  function klineKey(period, b) { return period === '1m' ? b.ts : (b.date || (b.datetime || '').slice(0, 10)); }

  return {
    _backend: 'memory',
    addWatch: function(code, name, sort) {
      watchlist = watchlist.filter(function(w) { return w.code !== code; });
      watchlist.push({ code: code, name: name || null, sort: sort || 0 });
      return true;
    },
    removeWatch: function(code) {
      var n = watchlist.length;
      watchlist = watchlist.filter(function(w) { return w.code !== code; });
      return watchlist.length < n;
    },
    listWatch: function() {
      return watchlist.slice().sort(function(a, b) { return a.sort - b.sort; });
    },
    insertSnap: function(s) {
      snaps.push({ code: s.code, ts: s.ts || Date.now(), price: s.price, changePct: s.changePct, vol: s.vol, vol_ratio: s.volRatio || null });
    },
    getLastQuotes: function(codes) {
      return (codes || []).map(function(c) {
        var rows = snaps.filter(function(s) { return s.code === c; });
        return rows.length ? rows[rows.length - 1] : null;
      }).filter(Boolean);
    },
    clearSnaps: function() { snaps = []; },
    upsertKline: function(period, code, bars) {
      var tbl = klineTable(period);
      if (!tbl[code]) tbl[code] = {};
      (bars || []).forEach(function(b) { tbl[code][klineKey(period, b)] = Object.assign({ code: code }, b); });
      return (bars || []).length;
    },
    getKline: function(code, period, limit) {
      var tbl = klineTable(period)[code] || {};
      return Object.keys(tbl).sort().slice(-(limit || 800)).map(function(k) { return tbl[k]; });
    },
    pruneMin1: function() {
      var cutoff = Date.now() - 30 * 86400000, n = 0;
      Object.keys(kMin1).forEach(function(code) {
        Object.keys(kMin1[code]).forEach(function(ts) {
          if (+ts < cutoff) { delete kMin1[code][ts]; n++; }
        });
      });
      return n;
    },
    logAlert: function(ruleId, code, msg, channels) {
      alerts.push({ id: seq.alert++, rule_id: ruleId, code: code, ts: Date.now(), msg: msg, channels: JSON.stringify(channels || []) });
    },
    getAlerts: function(limit) { return alerts.slice().sort(function(a, b) { return b.ts - a.ts; }).slice(0, limit || 100); },
    saveReport: function(date, content) { reports[date] = { id: seq.report++, date: date, content: content, created_at: Date.now() }; },
    getReport: function(date) { return reports[date]; },
    saveStrategy: function(id, name, dsl, enabled) {
      strategies[id] = { id: id, name: name, dsl: typeof dsl === 'string' ? dsl : JSON.stringify(dsl), enabled: enabled === false ? 0 : 1, created_at: Date.now() };
    },
    listStrategies: function(enabledOnly) {
      return Object.keys(strategies).map(function(k) { return strategies[k]; })
        .filter(function(s) { return !enabledOnly || s.enabled === 1; })
        .sort(function(a, b) { return a.created_at - b.created_at; });
    },
    getStrategy: function(id) { return strategies[id]; },
    deleteStrategy: function(id) { var ok = !!strategies[id]; delete strategies[id]; return ok; },
    saveBacktest: function(strategyId, params, metrics) {
      var id = seq.bt++;
      backtests.push({ id: id, strategy_id: strategyId, params: JSON.stringify(params || {}), metrics: JSON.stringify(metrics || {}), created_at: Date.now() });
      return id;
    },
    getBacktests: function(strategyId, limit) {
      return backtests.filter(function(b) { return b.strategy_id === strategyId; })
        .sort(function(a, b) { return b.id - a.id; }).slice(0, limit || 20);
    },
    logPatch: function(entry) {
      var id = seq.patch++;
      patches.push({ id: id, ts: Date.now(), branch: entry.branch || '', files: JSON.stringify(entry.files || []), diff_hash: entry.diffHash || '', test_result: entry.testResult || '', approver: entry.approver || '', result: entry.result || '', rolled_back: entry.rolledBack ? 1 : 0 });
      return id;
    },
    listPatches: function(limit) { return patches.slice().sort(function(a, b) { return b.id - a.id; }).slice(0, limit || 50); },
    _close: function() {},
  };
}

module.exports = {
  name: 'market-db',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    var impl;
    var degraded = false;
    try {
      impl = Database ? createSqlImpl() : createMemImpl();
      if (!Database) degraded = true;
    } catch (e) {
      // better-sqlite3 原生 ABI 不匹配（如 node:test 环境）→ 内存后端兜底
      console.warn('market-db: sqlite 不可用，回退内存后端 -', e.message);
      impl = createMemImpl();
      degraded = true;
    }
    Core.marketDb = impl;
    console.log('market-db 模块已加载（后端：' + impl._backend + '，9 张表）');
    // 🔒 Phase 2 S8: 降级可见性——内存后端重启后数据丢失，必须明确告知用户
    if (degraded && impl._backend === 'memory') {
      setTimeout(function() {
        if (Core.showToast) {
          Core.showToast('⚠️ 行情数据库降级：SQLite 不可用，当前使用内存存储（重启后数据丢失）。建议执行 npm rebuild better-sqlite3', 'warning', 8000);
        }
      }, 3000);
    }
  },
};
