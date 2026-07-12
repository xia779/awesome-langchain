// server/modules/database.js — SQLite database layer
var path = require('path');
var fs = require('fs');

var db = null;
var Database = null;

function initDB(userId) {
  if (db) return db;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('[database] better-sqlite3 not installed, using JSON fallback');
    return null;
  }
  var dir = path.join(Core.USERS_ROOT, userId || 'admin');
  fs.mkdirSync(dir, { recursive: true });
  var dbPath = path.join(dir, 'data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Create tables — execute each statement separately
  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, created_at INTEGER, updated_at INTEGER, tags TEXT, is_pinned INTEGER DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at INTEGER, metadata TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE)');
  db.exec('CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, tags TEXT, importance REAL DEFAULT 0.5, created_at INTEGER, user_id TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)');
  return db;
}

var Core;

module.exports = {
  name: 'database',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    var userId = Core.config.lastUser || 'admin';
    initDB(userId);
    Core.registerModule('db', {
      getDB: function() { return db; },
      initDB: initDB,
      // Session CRUD
      createSession: function(id, name, parentId) {
        if (!db) return null;
        var now = Date.now();
        db.prepare('INSERT INTO sessions (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, name || 'New Chat', parentId || null, now, now);
        return { id: id, name: name || 'New Chat', parentId: parentId, createdAt: now, updatedAt: now };
      },
      getSession: function(id) {
        if (!db) return null;
        return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      },
      listSessions: function() {
        if (!db) return [];
        return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
      },
      deleteSession: function(id) {
        if (!db) return;
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      },
      updateSession: function(id, delta) {
        if (!db) return;
        var sets = [];
        var vals = [];
        if (delta.name !== undefined) { sets.push('name = ?'); vals.push(delta.name); }
        if (delta.parentId !== undefined) { sets.push('parent_id = ?'); vals.push(delta.parentId); }
        if (delta.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(delta.tags)); }
        if (delta.isPinned !== undefined) { sets.push('is_pinned = ?'); vals.push(delta.isPinned ? 1 : 0); }
        sets.push('updated_at = ?'); vals.push(Date.now());
        vals.push(id);
        db.prepare('UPDATE sessions SET ' + sets.join(', ') + ' WHERE id = ?').run.apply(null, vals);
      },
      // Message CRUD
      addMessage: function(sessionId, role, content, metadata) {
        if (!db) return null;
        var now = Date.now();
        var result = db.prepare('INSERT INTO messages (session_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?)')
          .run(sessionId, role, content, now, metadata ? JSON.stringify(metadata) : null);
        // Update session timestamp
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
        return { id: result.lastInsertRowid, role: role, content: content, createdAt: now };
      },
      getMessages: function(sessionId, limit, offset) {
        if (!db) return [];
        var sql = 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC';
        if (limit) sql += ' LIMIT ' + limit;
        if (offset) sql += ' OFFSET ' + offset;
        return db.prepare(sql).all(sessionId);
      },
      deleteMessages: function(sessionId) {
        if (!db) return;
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      }
    });
  }
};
