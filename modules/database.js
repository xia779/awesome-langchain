/**
 * database.js - SQLite 数据库管理模块
 * 统一管理配置、会话、消息、收藏、插件配置的持久化存储
 * 🔧 如果 better-sqlite3 加载失败（ABI 版本不匹配），自动回退到 JSON 文件存储
 */

let Database;
let sqliteAvailable = false;
try {
  Database = require('better-sqlite3');
  sqliteAvailable = true;
} catch (e) {
  console.warn('⚠️ better-sqlite3 加载失败:', e.message);
  console.warn('💡 修复方法: cd E:\\my-ai-desktop && npm rebuild better-sqlite3');
  console.warn('📂 将使用 JSON 文件作为数据存储回退');
}

const path = require('path');
const fs = require('fs');

let Core;
let db = null;
let dbPath = null;
let _stmts = {}; // 预编译语句缓存

function _stmt(name, sql) {
  if (!_stmts[name]) _stmts[name] = db.prepare(sql);
  return _stmts[name];
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  dbPath = path.join(Core.DATA_ROOT, 'ai-agent.db');
  
  if (sqliteAvailable) {
    try {
      // 打开数据库（如果不存在则创建）
      db = new Database(dbPath);
      
      // 启用 WAL 模式（提高并发性能）
      db.pragma('journal_mode = WAL');
      // 🔒 #21: WAL 模式 + 同步优化
      try {
        db.pragma('synchronous = NORMAL');
        db.pragma('wal_autocheckpoint = 1000');
      } catch (e) {
        console.warn('⚠️ [database] WAL 优化设置失败:', e.message);
      }
      // 🔧 关闭外键约束：应用使用文件系统管理用户，FK 约束仅为声明性
      db.pragma('foreign_keys = OFF');
      
      // 创建表结构
      createTables();
      
      console.log('✅ SQLite 数据库已初始化:', dbPath);
    } catch (e) {
      console.warn('⚠️ SQLite 打开失败，使用 JSON 回退:', e.message);
      sqliteAvailable = false;
      db = null;
    }
  }
  
  if (!sqliteAvailable) {
  }
  
  // 挂载到 Core（接口统一，无论底层是 SQLite 还是 JSON）
  Core.db = createDbInterface();
  
  if (!sqliteAvailable) {
    // 🔧 S8: 明确提示用户数据库降级状态
    console.warn('⚠️ [database] 当前使用 JSON 文件存储（性能受限）');
    setTimeout(function() {
      if (Core.showToast) {
        Core.showToast('⚠️ 数据库降级：SQLite 不可用，已回退到 JSON 存储。建议执行 npm rebuild better-sqlite3', 'warning', 8000);
      }
    }, 2000);
  }
}

// 🔧 创建统一的数据库接口（SQLite 或 JSON 回退）
function createDbInterface() {
  if (sqliteAvailable) {
    return {
      get: dbGet, set: dbSet, getAll: dbGetAll, delete: dbDelete,
      query: dbQuery, run: dbRun,
      transaction: (fn) => db.transaction(fn),
      close: () => db.close(),
      migrateFromJSON, getUserConfig, setUserConfig,
      getSessions, saveSession, deleteSession,
      getSessionMessages, addMessage, clearSessionMessages,
      getFavorites, addFavorite, deleteFavorite,
      getPluginConfig, setPluginConfig,
      _backend: 'sqlite',
    };
  }
  
  // JSON 回退模式
  return createJsonDbInterface();
}

// ===== JSON 文件回退接口（SQLite 不可用时的兼容层）=====
function createJsonDbInterface() {
  // 🔧 统一获取配置文件路径（与 core-v10.js 的 CONFIG_FILE 一致）
  function getConfigPath() {
    return Core.CONFIG_FILE || path.join(Core.DATA_ROOT, 'config.json');
  }

  function jsonGet(key) {
    try {
      const all = jsonGetAll();
      return all[key] || null;
    } catch (e) { return null; }
  }
  
  function jsonSet(key, value) {
    try {
      const all = jsonGetAll();
      // 🔧 去掉 SQLite 风格的 userId: 前缀（如 admin:deepseekKey → deepseekKey）
      const cleanKey = key.replace(/^(admin|user):/, '');
      all[cleanKey] = value;
      safeWriteJson(getConfigPath(), all);
    } catch (e) { console.warn('⚠️ [database] JSON配置写入失败:', e.message); }
  }
  
  function jsonGetAll() {
    try {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (e) { console.warn('⚠️ [database] JSON配置文件读取失败:', e.message); }
    return {};
  }
  
  function jsonDelete(key) {
    try {
      const all = jsonGetAll();
      delete all[key];
      safeWriteJson(getConfigPath(), all);
    } catch (e) { console.warn('⚠️ [database] JSON配置删除失败:', e.message); }
  }
  
  function safeWriteJson(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) { console.warn('⚠️ [database] JSON文件写入失败:', filePath, e.message); }
  }
  
  function jsonGetUserConfig(userId) {
    try {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (e) { console.warn('⚠️ [database] JSON用户配置读取失败:', e.message); }
    return {};
  }
  
  function jsonSetUserConfig(userId, key, value) {
    jsonSet(userId + ':' + key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  
  // 🔒 D1 fix: 实现 JSON 回退的会话/消息/收藏/插件配置持久化
  // SQLite 不可用时，数据写入 DATA_ROOT 下的 JSON 文件，避免静默丢失。
  function _jsonPath(name) {
    return path.join(Core.DATA_ROOT || path.join(__dirname, '..', 'data'), name);
  }
  function _readJsonFile(name, fallback) {
    try {
      const fp = _jsonPath(name);
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) { console.warn('⚠️ [database] JSON回退读取失败:', name, e.message); }
    return fallback;
  }
  function _writeJsonFile(name, data) {
    safeWriteJson(_jsonPath(name), data);
  }

  return {
    get: jsonGet, set: jsonSet, getAll: jsonGetAll, delete: jsonDelete,
    query: () => [], run: () => ({}),
    transaction: (fn) => { try { fn(); } catch (e) { console.warn('⚠️ [database] JSON事务执行失败:', e.message); } },
    close: () => {},
    migrateFromJSON: () => false,
    getUserConfig: jsonGetUserConfig,
    setUserConfig: jsonSetUserConfig,
    // 会话持久化
    getSessions: () => _readJsonFile('sessions.json', {}),
    saveSession: (id, data) => {
      const all = _readJsonFile('sessions.json', {});
      all[id] = data;
      _writeJsonFile('sessions.json', all);
    },
    deleteSession: (id) => {
      const all = _readJsonFile('sessions.json', {});
      delete all[id];
      _writeJsonFile('sessions.json', all);
    },
    // 消息持久化
    getSessionMessages: (id) => _readJsonFile('sessions/' + id + '.json', []),
    addMessage: (id, msg) => {
      const msgs = _readJsonFile('sessions/' + id + '.json', []);
      msgs.push(msg);
      _writeJsonFile('sessions/' + id + '.json', msgs);
    },
    clearSessionMessages: (id) => { _writeJsonFile('sessions/' + id + '.json', []); },
    // 收藏持久化
    getFavorites: () => _readJsonFile('favorites.json', []),
    addFavorite: (item) => {
      const favs = _readJsonFile('favorites.json', []);
      favs.push(item);
      _writeJsonFile('favorites.json', favs);
    },
    deleteFavorite: (id) => {
      const favs = _readJsonFile('favorites.json', []);
      _writeJsonFile('favorites.json', favs.filter(f => (f.id || f._id) !== id));
    },
    // 插件配置持久化
    getPluginConfig: (name) => _readJsonFile('plugins/' + name + '.json', {}),
    setPluginConfig: (name, config) => { _writeJsonFile('plugins/' + name + '.json', config); },
    _backend: 'json',
  };
}

// ===== 创建表结构 =====
function createTables() {
  // 配置表（键值对）
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  
  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      last_login INTEGER DEFAULT (unixepoch())
    )
  `);
  
  // 会话表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      parent_id TEXT,
      pinned INTEGER DEFAULT 0,
      role_type TEXT,
      timestamp INTEGER DEFAULT (unixepoch()),
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(username)
    )
  `);
  
  // 消息表
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  
  // 收藏表
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      msg_index INTEGER,
      role TEXT,
      content TEXT,
      timestamp INTEGER DEFAULT (unixepoch()),
      session_title TEXT
    )
  `);
  
  // 插件配置表
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_configs (
      plugin_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      config TEXT DEFAULT '{}'
    )
  `);

  // 记忆表（/remember 功能）
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'admin',
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // 创建索引（加速查询）
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, timestamp DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, timestamp DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_session ON favorites(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at DESC)');
  
  console.log('✅ 数据库表结构已创建');
}

// ===== 通用 CRUD =====
function dbGet(key) {
  const row = _stmt('dbGet', 'SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function dbSet(key, value) {
  _stmt('dbSet', `
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(key, value);
}

function dbGetAll() {
  const rows = _stmt('dbGetAll', 'SELECT key, value FROM config').all();
  const result = {};
  rows.forEach(row => {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch (e) {
      result[row.key] = row.value;
    }
  });
  return result;
}

function dbDelete(key) {
  _stmt('dbDelete', 'DELETE FROM config WHERE key = ?').run(key);
}

function dbQuery(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function dbRun(sql, params = []) {
  return db.prepare(sql).run(...params);
}

// ===== 用户配置 =====
function getUserConfig(userId) {
  const rows = db.prepare('SELECT key, value FROM config WHERE key LIKE ?').all(userId + ':%');
  const result = {};
  rows.forEach(row => {
    const key = row.key.replace(userId + ':', '');
    try {
      result[key] = JSON.parse(row.value);
    } catch (e) {
      result[key] = row.value;
    }
  });
  return result;
}

function setUserConfig(userId, key, value) {
  dbSet(userId + ':' + key, typeof value === 'string' ? value : JSON.stringify(value));
}

// ===== 会话管理 =====
function getSessions(userId) {
  const rows = _stmt('getSessions', `
    SELECT id, user_id, title, parent_id, pinned, role_type, timestamp, created_at
    FROM sessions WHERE user_id = ? ORDER BY pinned DESC, timestamp DESC
  `).all(userId);
  const sessions = {};
  rows.forEach(row => {
    sessions[row.id] = {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      parentId: row.parent_id,
      pinned: !!row.pinned,
      roleType: row.role_type,
      timestamp: row.timestamp,
      createdAt: row.created_at,
      messages: [], // 🔧 懒加载：不在列表加载时读取消息，打开会话时再加载
      _messagesLoaded: false,
    };
  });
  return sessions;
}

// 🔧 预编译 saveSession 内部语句
var _saveSessionInsert = null;
var _saveSessionDelete = null;
var _saveSessionMsgInsert = null;
var _saveSessionMsgCount = null;
var _ensureUser = null;

function _ensureSaveStmts() {
  if (!_saveSessionInsert) {
    // 🔧 确保用户记录存在（防止 FK 约束失败）
    _ensureUser = db.prepare(`
      INSERT OR IGNORE INTO users (username) VALUES (?)
    `);
    _saveSessionInsert = db.prepare(`
      INSERT INTO sessions (id, user_id, title, parent_id, pinned, role_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        parent_id = excluded.parent_id,
        pinned = excluded.pinned,
        role_type = excluded.role_type,
        timestamp = excluded.timestamp
    `);
    _saveSessionDelete = db.prepare('DELETE FROM messages WHERE session_id = ?');
    _saveSessionMsgInsert = db.prepare(`
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    _saveSessionMsgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?');
  }
}

function saveSession(sessionId, sessionData) {
  _ensureSaveStmts();

  // 🔧 事务包裹：保证原子性 + 减少 WAL fsync 开销（10-50x 加速）
  var doSave = db.transaction(function() {
    var userId = sessionData.userId || sessionData.user_id || 'admin';
    // 🔧 确保用户记录存在（防止 FK 约束失败）
    _ensureUser.run(userId);
    _saveSessionInsert.run(
      sessionId,
      userId,
      sessionData.title || '未命名会话',
      sessionData.parentId || sessionData.parent_id || null,
      sessionData.pinned ? 1 : 0,
      sessionData.roleType || sessionData.role_type || null,
      sessionData.timestamp || Date.now()
    );

    if (sessionData.messages && Array.isArray(sessionData.messages)) {
      var msgs = sessionData.messages;
      var dbCount = _saveSessionMsgCount.get(sessionId).cnt;

      if (msgs.length <= dbCount) {
        // 消息数没有增加，跳过消息写入
        return;
      }

      if (dbCount === 0) {
        // 新会话或无消息：直接全量插入
        for (var i = 0; i < msgs.length; i++) {
          _saveSessionMsgInsert.run(sessionId, msgs[i].role, msgs[i].content, msgs[i].timestamp || (Date.now() + i));
        }
      } else {
        // 增量追加：只插入 DB 中还没有的新消息
        for (var j = dbCount; j < msgs.length; j++) {
          _saveSessionMsgInsert.run(sessionId, msgs[j].role, msgs[j].content, msgs[j].timestamp || (Date.now() + j));
        }
      }
    }
  });

  try {
    doSave();
  } catch (e) {
    console.warn('⚠️ SQLite 保存会话失败:', e.message, '(sessionId:', sessionId + ')');
  }
}

function deleteSession(sessionId) {
  _stmt('deleteSession', 'DELETE FROM sessions WHERE id = ?').run(sessionId);
  // messages 表有 ON DELETE CASCADE，会自动删除
}

function getSessionMessages(sessionId) {
  return _stmt('getSessionMessages', `
    SELECT role, content, timestamp FROM messages
    WHERE session_id = ? ORDER BY timestamp
  `).all(sessionId);
}

function addMessage(sessionId, role, content, timestamp) {
  _ensureSaveStmts();
  _saveSessionMsgInsert.run(sessionId, role, content, timestamp || Date.now());
}

function clearSessionMessages(sessionId) {
  _ensureSaveStmts();
  _saveSessionDelete.run(sessionId);
}

// ===== 收藏管理 =====
function getFavorites(userId) {
  return db.prepare(`
    SELECT id, session_id, msg_index, role, content, timestamp, session_title
    FROM favorites WHERE user_id = ? ORDER BY timestamp DESC
  `).all(userId);
}

function addFavorite(userId, fav) {
  db.prepare(`
    INSERT INTO favorites (id, user_id, session_id, msg_index, role, content, timestamp, session_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      timestamp = excluded.timestamp
  `).run(
    fav.id,
    userId,
    fav.sessionId || fav.session_id,
    fav.msgIndex || fav.msg_index || 0,
    fav.role,
    fav.content,
    fav.timestamp || Date.now(),
    fav.sessionTitle || fav.session_title || '未命名会话'
  );
}

function deleteFavorite(userId, favId) {
  db.prepare('DELETE FROM favorites WHERE id = ? AND user_id = ?').run(favId, userId);
}

// ===== 插件配置 =====
function getPluginConfig(userId, pluginId) {
  const row = db.prepare('SELECT config FROM plugin_configs WHERE plugin_id = ? AND user_id = ?').get(pluginId, userId);
  if (!row) return {};
  try { return JSON.parse(row.config); } catch (e) { return {}; }
}

function setPluginConfig(userId, pluginId, config) {
  db.prepare(`
    INSERT INTO plugin_configs (plugin_id, user_id, config)
    VALUES (?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET config = excluded.config
  `).run(pluginId, userId, JSON.stringify(config));
}

// ===== 从 JSON 迁移到 SQLite =====
function migrateFromJSON(userId) {
  if (!userId) userId = 'admin';
  
  const userDir = path.join(Core.DATA_ROOT, 'users', userId);
  const configPath = path.join(userDir, 'config.json');
  const sessionsDir = path.join(userDir, 'sessions');
  
  let migrated = 0;
  
  // 🔒 #21 修复：批量操作使用事务包裹，减少 WAL 写入次数
  const doMigrate = db.transaction(function() {
    // 1. 迁移配置
    if (fs.existsSync(configPath)) {
      try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        Object.keys(configData).forEach(key => {
          setUserConfig(userId, key, configData[key]);
        });
        console.log('✅ 配置已迁移到 SQLite');
        migrated++;
      } catch (e) {
        console.warn('⚠️ 配置迁移失败:', e.message);
      }
    }
    
    // 2. 迁移会话
    if (fs.existsSync(sessionsDir)) {
      try {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        files.forEach(file => {
          try {
            const sessionPath = path.join(sessionsDir, file);
            const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            const sessionId = file.replace('.json', '');
            
            // 插入会话
            saveSession(sessionId, {
              ...sessionData,
              userId: userId,
            });
          } catch (e) {
            console.warn('⚠️ 会话迁移失败:', file, e.message);
          }
        });
        console.log('✅ 会话已迁移到 SQLite:', files.length, '个');
        migrated++;
      } catch (e) {
        console.warn('⚠️ 会话迁移失败:', e.message);
      }
    }
    
    // 3. 迁移收藏
    const favoritesPath = path.join(userDir, 'favorites.json');
    if (fs.existsSync(favoritesPath)) {
      try {
        const favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf8'));
        if (Array.isArray(favorites)) {
          favorites.forEach(fav => addFavorite(userId, fav));
          console.log('✅ 收藏已迁移到 SQLite:', favorites.length, '条');
          migrated++;
        }
      } catch (e) {
        console.warn('⚠️ 收藏迁移失败:', e.message);
      }
    }
  });

  try {
    doMigrate();
  } catch (e) {
    console.warn('⚠️ [database] 迁移事务执行失败:', e.message);
  }
  
  return migrated > 0;
}

module.exports = { name: 'database', dependencies: ['path-utils'], init };
