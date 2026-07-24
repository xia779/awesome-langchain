/**
 * tests/helper.js - 测试辅助：模拟 Core 对象和数据库
 */
var path = require('path');
var fs = require('fs');
var os = require('os');

var TEST_DATA_ROOT = path.join(os.tmpdir(), 'ai-agent-test-' + process.pid);

function cleanTestData() {
  try {
    if (fs.existsSync(TEST_DATA_ROOT)) {
      fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    }
  } catch (e) {
    // Windows file lock — ignore, will be cleaned on next run
  }
}

function ensureTestData() {
  if (!fs.existsSync(TEST_DATA_ROOT)) {
    fs.mkdirSync(TEST_DATA_ROOT, { recursive: true });
  }
}

function createMockCore() {
  ensureTestData();
  var config = {};
  var commands = {};
  // 🔒 Phase 2: mock pathService（与生产 Core.pathService API 一致）
  var mockPathService = {
    _globalRoot: TEST_DATA_ROOT,
    _usersRoot: path.join(TEST_DATA_ROOT, 'users'),
    _currentUser: null,
    setCurrentUser: function(u) { this._currentUser = u; return this; },
    global: function(sub) { return sub ? path.join(this._globalRoot, sub) : this._globalRoot; },
    perUser: function(sub) {
      var base = path.join(this._usersRoot, this._currentUser || 'admin');
      return sub ? path.join(base, sub) : base;
    },
    userRoot: function(userId, sub) {
      var base = path.join(this._usersRoot, userId || 'admin');
      return sub ? path.join(base, sub) : base;
    },
    effectiveRoot: function() {
      return this._currentUser ? this.perUser() : this._globalRoot;
    }
  };
  var Core = {
    DATA_ROOT: TEST_DATA_ROOT,
    config: config,
    _currentUser: 'admin',
    pathService: mockPathService,
    saveConfig: function(patch) { Object.assign(config, patch); },
    showNotification: function() {},
    custom: {
      registerCommand: function(cmd, desc, handler, persist) {
        commands[cmd] = { desc: desc, handler: handler, persist: persist };
      },
      _commands: commands,
    },
    routing: {
      register: function(cmd, handler, desc) {
        Core.custom.registerCommand(cmd, desc || '', handler, false);
      },
    },
    db: createMockDb(),
  };
  return Core;
}

function createMockDb() {
  var tables = {};
  var autoIncrements = {};

  function matchWhere(row, clause, params) {
    var conditions = clause.split(/\s+AND\s+/i);
    var paramOffset = 0;
    return conditions.every(function(cond) {
      cond = cond.trim();
      var eqM = cond.match(/(\w+)\s*=\s*\?/);
      if (eqM) { var val = params[paramOffset]; paramOffset++; return row[eqM[1]] == val; }
      var litM = cond.match(/(\w+)\s*=\s*'([^']*)'/);
      if (litM) { return row[litM[1]] == litM[2]; }
      return true;
    });
  }

  function parseSet(setStr, params) {
    var result = {};
    var paramIdx = 0;
    setStr.split(',').forEach(function(part) {
      part = part.trim();
      var m = part.match(/(\w+)\s*=\s*\?/);
      if (m) result[m[1]] = params[paramIdx++];
    });
    return result;
  }

  var db = {
    _backend: 'sqlite',
    _tables: tables,

    run: function(sql, params) {
      params = params || [];
      sql = sql.trim();

      // CREATE TABLE
      var ctM = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(/i);
      if (ctM) {
        if (!tables[ctM[1]]) { tables[ctM[1]] = []; autoIncrements[ctM[1]] = 1; }
        return;
      }
      if (/CREATE INDEX|ALTER TABLE/i.test(sql)) return;
      if (/^PRAGMA/i.test(sql)) return [];

      // INSERT
      var insM = sql.match(/INSERT (?:OR REPLACE )?INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (insM) {
        var tbl = insM[1];
        var cols = insM[2].split(',').map(function(c) { return c.trim(); });
        if (!tables[tbl]) { tables[tbl] = []; autoIncrements[tbl] = 1; }
        var row = { id: autoIncrements[tbl]++ };
        for (var i = 0; i < cols.length; i++) {
          row[cols[i]] = params[i] !== undefined ? params[i] : null;
        }
        row.created_at = row.created_at || Math.floor(Date.now() / 1000);
        row.updated_at = row.updated_at || Math.floor(Date.now() / 1000);
        if (/INSERT OR REPLACE/i.test(sql) && row.key) {
          tables[tbl] = tables[tbl].filter(function(r) { return r.key !== row.key; });
        }
        tables[tbl].push(row);
        return { changes: 1, lastInsertRowid: row.id };
      }

      // UPDATE
      var updM = sql.match(/UPDATE (\w+) SET (.+?) WHERE (.+)/i);
      if (updM) {
        var tbl2 = updM[1];
        if (!tables[tbl2]) return { changes: 0 };
        // Count ? in SET clause to offset WHERE params
        var setParamCount = (updM[2].match(/\?/g) || []).length;
        var whereParams = params.slice(setParamCount);
        var updated = 0;
        tables[tbl2].forEach(function(row) {
          if (matchWhere(row, updM[3], whereParams)) {
            var setParts = parseSet(updM[2], params);
            Object.assign(row, setParts);
            row.updated_at = Math.floor(Date.now() / 1000);
            updated++;
          }
        });
        return { changes: updated };
      }

      // DELETE
      var delM = sql.match(/DELETE FROM (\w+)(?:\s+WHERE\s+(.+))?/i);
      if (delM) {
        var tbl3 = delM[1];
        if (!tables[tbl3]) return { changes: 0 };
        var before = tables[tbl3].length;
        if (delM[2]) {
          tables[tbl3] = tables[tbl3].filter(function(r) { return !matchWhere(r, delM[2], params); });
        } else {
          tables[tbl3] = [];
        }
        return { changes: before - tables[tbl3].length };
      }
      return { changes: 0 };
    },

    query: function(sql, params) {
      params = params || [];
      sql = sql.trim();

      // PRAGMA table_info
      var pragmaM = sql.match(/PRAGMA table_info\((\w+)\)/i);
      if (pragmaM) {
        var tbl = pragmaM[1];
        if (!tables[tbl] || tables[tbl].length === 0) return [];
        return Object.keys(tables[tbl][0]).map(function(k) { return { name: k }; });
      }

      // SELECT
      var selM = sql.match(/SELECT (.+) FROM (\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY\s+(.+?))?(?:\s+LIMIT\s+(\d+|\?))?$/i);
      if (selM) {
        var tbl2 = selM[2];
        if (!tables[tbl2]) return [];
        var rows = tables[tbl2].slice();

        if (selM[3]) {
          rows = rows.filter(function(r) { return matchWhere(r, selM[3], params); });
        }
        if (selM[4]) {
          var oc = selM[4].replace(/\s+(ASC|DESC)/i, '').trim();
          var desc = /DESC/i.test(selM[4]);
          rows.sort(function(a, b) {
            var va = a[oc] || '', vb = b[oc] || '';
            if (typeof va === 'number' && typeof vb === 'number') return desc ? vb - va : va - vb;
            return desc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb));
          });
        }
        if (selM[5]) {
          var lim = selM[5] === '?' ? params[params.length - 1] : parseInt(selM[5]);
          rows = rows.slice(0, lim);
        }
        var colSpec = selM[1].trim();
        if (colSpec !== '*') {
          var cols = colSpec.split(',').map(function(c) { return c.trim(); });
          rows = rows.map(function(r) {
            var f = {};
            cols.forEach(function(c) { if (r[c] !== undefined) f[c] = r[c]; });
            return f;
          });
        }
        return rows;
      }
      return [];
    },
  };
  return db;
}

module.exports = { createMockCore, createMockDb, cleanTestData, TEST_DATA_ROOT };
