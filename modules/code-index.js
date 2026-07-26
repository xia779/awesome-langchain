// modules/code-index.js - 仓库级代码索引（P3-1/P3-2）
// 符号提取 + 文件嵌入 + SQLite 存储 + 语义代码检索
(function() {
  'use strict';

  var Core = null;
  var fs = require('fs');
  var path = require('path');

  // ═══════════════════════════════════════════
  // 配置
  // ═══════════════════════════════════════════
  var INDEX_DB_NAME = 'code-index.db';
  var SUPPORTED_EXTENSIONS = ['.js', '.ts', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.jsx', '.tsx', '.vue', '.rb', '.php'];
  var IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'vendor', 'target'];
  var MAX_FILE_SIZE = 500 * 1024; // 500KB

  var _db = null;
  var _indexedRoot = null;

  // ═══════════════════════════════════════════
  // 1. 符号提取（正则，无需 tree-sitter）
  // ═══════════════════════════════════════════

  var SYMBOL_PATTERNS = {
    js: [
      { type: 'function', regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g },
      { type: 'class', regex: /(?:export\s+)?class\s+(\w+)/g },
      { type: 'const', regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()/g },
      { type: 'method', regex: /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g },
      { type: 'import', regex: /import\s+.*?from\s+['"]([^'"]+)['"]/g }
    ],
    py: [
      { type: 'function', regex: /(?:async\s+)?def\s+(\w+)/g },
      { type: 'class', regex: /class\s+(\w+)/g },
      { type: 'import', regex: /(?:from\s+(\S+)\s+)?import\s+(\w+)/g }
    ],
    java: [
      { type: 'class', regex: /(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/g },
      { type: 'method', regex: /(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/g },
      { type: 'interface', regex: /interface\s+(\w+)/g }
    ],
    go: [
      { type: 'function', regex: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/g },
      { type: 'struct', regex: /type\s+(\w+)\s+struct/g },
      { type: 'interface', regex: /type\s+(\w+)\s+interface/g }
    ]
  };

  function extractSymbols(content, ext) {
    var lang = _extToLang(ext);
    var patterns = SYMBOL_PATTERNS[lang] || SYMBOL_PATTERNS.js;
    var symbols = [];
    var lines = content.split('\n');

    patterns.forEach(function(p) {
      var match;
      p.regex.lastIndex = 0;
      while ((match = p.regex.exec(content)) !== null) {
        var name = match[1] || match[2] || '';
        if (!name || name.length < 2) continue;
        // 计算行号
        var lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name: name,
          type: p.type,
          line: lineNum,
          context: (lines[lineNum - 1] || '').trim().substring(0, 120)
        });
      }
    });

    return symbols;
  }

  function _extToLang(ext) {
    var map = { '.js': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.vue': 'js', '.py': 'py', '.java': 'java', '.go': 'go', '.rs': 'js', '.c': 'js', '.cpp': 'js', '.h': 'js', '.rb': 'py', '.php': 'js' };
    return map[ext] || 'js';
  }

  // ═══════════════════════════════════════════
  // 2. 索引构建
  // ═══════════════════════════════════════════

  function _getIndexPath() {
    var dir = (Core && Core.DATA_ROOT) || path.join(__dirname, '..', 'data');
    return path.join(dir, INDEX_DB_NAME);
  }

  function _initDB() {
    if (_db) return true;
    if (!Core || !Core.db || Core.db._backend !== 'sqlite') return false;
    _db = Core.db;
    try {
      _db.run(`CREATE TABLE IF NOT EXISTS code_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        ext TEXT,
        size INTEGER DEFAULT 0,
        hash TEXT,
        indexed_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(root, rel_path)
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'function',
        line INTEGER DEFAULT 0,
        context TEXT DEFAULT '',
        FOREIGN KEY(file_id) REFERENCES code_files(id) ON DELETE CASCADE
      )`);
      _db.run("CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name)");
      _db.run("CREATE INDEX IF NOT EXISTS idx_cs_type ON code_symbols(type)");
      _db.run("CREATE INDEX IF NOT EXISTS idx_cf_root ON code_files(root)");
      return true;
    } catch (e) {
      console.warn('[code-index] DB init failed:', e.message);
      return false;
    }
  }

  /**
   * indexDirectory - 扫描目录并建立索引
   * @param {string} rootDir - 项目根目录
   * @param {Object} options - { force: bool, onProgress: fn }
   */
  function indexDirectory(rootDir, options) {
    var opts = options || {};
    if (!_initDB()) return { success: false, error: 'SQLite 不可用' };
    if (!fs.existsSync(rootDir)) return { success: false, error: '目录不存在: ' + rootDir };

    _indexedRoot = rootDir;
    var files = _scanFiles(rootDir, rootDir);
    var indexed = 0, skipped = 0, errors = 0;

    files.forEach(function(relPath) {
      try {
        var fullPath = path.join(rootDir, relPath);
        var stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) { skipped++; return; }

        var ext = path.extname(relPath).toLowerCase();
        var content = fs.readFileSync(fullPath, 'utf8');
        var hash = _simpleHash(content);

        // 检查是否已索引且未变化
        if (!opts.force) {
          var existing = _db.query("SELECT hash FROM code_files WHERE root = ? AND rel_path = ?", [rootDir, relPath]);
          if (existing && existing.length > 0 && existing[0].hash === hash) { skipped++; return; }
        }

        // 删除旧记录
        _db.run("DELETE FROM code_files WHERE root = ? AND rel_path = ?", [rootDir, relPath]);

        // 插入文件
        _db.run("INSERT INTO code_files (root, rel_path, ext, size, hash) VALUES (?, ?, ?, ?, ?)",
          [rootDir, relPath, ext, stat.size, hash]);
        var fileId = _db.query("SELECT last_insert_rowid() as id");
        var fid = fileId[0].id;

        // 提取并存储符号
        var symbols = extractSymbols(content, ext);
        symbols.forEach(function(sym) {
          _db.run("INSERT INTO code_symbols (file_id, name, type, line, context) VALUES (?, ?, ?, ?, ?)",
            [fid, sym.name, sym.type, sym.line, sym.context]);
        });

        indexed++;
        if (opts.onProgress && indexed % 20 === 0) opts.onProgress(indexed, files.length);
      } catch (e) {
        errors++;
      }
    });

    return { success: true, total: files.length, indexed: indexed, skipped: skipped, errors: errors };
  }

  function _scanFiles(root, base) {
    var results = [];
    var items;
    try { items = fs.readdirSync(root); } catch (e) { return results; }
    items.forEach(function(item) {
      if (IGNORE_DIRS.indexOf(item) >= 0) return;
      var full = path.join(root, item);
      var stat;
      try { stat = fs.statSync(full); } catch (e) { return; }
      if (stat.isDirectory()) {
        results = results.concat(_scanFiles(full, base));
      } else {
        var ext = path.extname(item).toLowerCase();
        if (SUPPORTED_EXTENSIONS.indexOf(ext) >= 0) {
          results.push(path.relative(base, full));
        }
      }
    });
    return results;
  }

  function _simpleHash(content) {
    var hash = 0;
    for (var i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  // ═══════════════════════════════════════════
  // 3. 代码检索（P3-2）
  // ═══════════════════════════════════════════

  /**
   * searchSymbol - 按名称搜索符号
   */
  function searchSymbol(name, options) {
    if (!_initDB()) return [];
    var opts = options || {};
    var limit = opts.limit || 20;
    var type = opts.type || null;

    var sql, params;
    if (type) {
      sql = "SELECT cs.*, cf.rel_path, cf.root FROM code_symbols cs JOIN code_files cf ON cs.file_id = cf.id WHERE cs.name LIKE ? AND cs.type = ? ORDER BY cs.name LIMIT ?";
      params = ['%' + name + '%', type, limit];
    } else {
      sql = "SELECT cs.*, cf.rel_path, cf.root FROM code_symbols cs JOIN code_files cf ON cs.file_id = cf.id WHERE cs.name LIKE ? ORDER BY cs.name LIMIT ?";
      params = ['%' + name + '%', limit];
    }

    try {
      var rows = _db.query(sql, params);
      return (rows || []).map(function(r) {
        return { name: r.name, type: r.type, line: r.line, file: r.rel_path, context: r.context, root: r.root };
      });
    } catch (e) { return []; }
  }

  /**
   * searchCode - 全文搜索代码内容
   */
  function searchCode(query, rootDir, limit) {
    limit = limit || 10;
    if (!rootDir || !fs.existsSync(rootDir)) return [];

    var results = [];
    var files = _scanFiles(rootDir, rootDir);
    var queryLower = query.toLowerCase();

    for (var i = 0; i < files.length && results.length < limit; i++) {
      try {
        var fullPath = path.join(rootDir, files[i]);
        var content = fs.readFileSync(fullPath, 'utf8');
        var lines = content.split('\n');
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].toLowerCase().indexOf(queryLower) >= 0) {
            results.push({ file: files[i], line: j + 1, content: lines[j].trim().substring(0, 150) });
            if (results.length >= limit) break;
          }
        }
      } catch (e) {}
    }
    return results;
  }

  /**
   * getFileSymbols - 获取文件的所有符号
   */
  function getFileSymbols(filePath) {
    if (!fs.existsSync(filePath)) return [];
    var ext = path.extname(filePath).toLowerCase();
    var content = fs.readFileSync(filePath, 'utf8');
    return extractSymbols(content, ext);
  }

  /**
   * getStats - 索引统计
   */
  function getStats() {
    if (!_initDB()) return { files: 0, symbols: 0 };
    try {
      var f = _db.query("SELECT COUNT(*) as cnt FROM code_files");
      var s = _db.query("SELECT COUNT(*) as cnt FROM code_symbols");
      return { files: f[0].cnt, symbols: s[0].cnt };
    } catch (e) { return { files: 0, symbols: 0 }; }
  }

  // ═══════════════════════════════════════════
  // Module init
  // ═══════════════════════════════════════════
  function init(_Core) {
    Core = _Core;
    Core.codeIndex = {
      indexDirectory: indexDirectory,
      searchSymbol: searchSymbol,
      searchCode: searchCode,
      getFileSymbols: getFileSymbols,
      extractSymbols: extractSymbols,
      getStats: getStats,
      SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS
    };
    console.log('[code-index] initialized');
  }

  module.exports = { name: 'code-index', dependencies: [], init: init };
})();
