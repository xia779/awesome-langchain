// server/modules/memory.js — 记忆系统（CRUD + 画像 + 日志 + 重要性 + 精炼 + 语义搜索）
var fs = require('fs');
var path = require('path');

var Core = null;

// ===== 获取 raw DB 实例 =====
function getDB() {
  if (Core && Core.getModule && Core.getModule('db')) {
    return Core.getModule('db').getDB();
  }
  return null;
}

// ===== 记忆 CRUD =====
function addMemory(content, tags) {
  if (!content || !content.trim()) return { success: false, error: '内容不能为空' };
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var tagStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  var db = getDB();
  try {
    if (db) {
      db.prepare('INSERT INTO memories (user_id, content, tags) VALUES (?, ?, ?)').run(userId, content.trim(), tagStr);
      return { success: true };
    }
    return jsonAddMemory(userId, content.trim(), tagStr);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listMemories(limit) {
  limit = limit || 50;
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var db = getDB();
  try {
    if (db) {
      return db.prepare('SELECT id, content, tags, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
    }
    return jsonListMemories(userId, limit);
  } catch (e) {
    return [];
  }
}

function deleteMemory(id) {
  var db = getDB();
  try {
    if (db) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return { success: true };
    }
    return jsonDeleteMemory(id);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function searchMemories(query, limit) {
  limit = limit || 5;
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  if (!query || !query.trim()) return [];
  var db = getDB();
  try {
    if (db) {
      var pattern = '%' + query.trim() + '%';
      return db.prepare(
        'SELECT id, content, tags, created_at FROM memories WHERE user_id = ? AND (content LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT ?'
      ).all(userId, pattern, pattern, limit);
    }
    return jsonSearchMemories(userId, query.trim(), limit);
  } catch (e) {
    return [];
  }
}

function getMemoryContext(maxItems) {
  maxItems = maxItems || 10;
  var memories = listMemories(maxItems);
  if (!memories || memories.length === 0) return '';
  var lines = memories.map(function(m) { return '- ' + m.content; });
  return 'User memories (reference these naturally in conversation):\n' + lines.join('\n');
}

// ===== 智能记忆提取 =====
var EXTRACTION_PATTERNS = [
  { regex: /(?:我(?:的名字|叫)|my name is)\s*[是为]?\s*(.{1,20})/i, tag: 'identity', desc: '用户姓名' },
  { regex: /(?:我的?(?:邮箱|邮件|email))\s*[是为:：]?\s*([\w.+-]+@[\w.-]+)/i, tag: 'contact', desc: '用户邮箱' },
  { regex: /(?:我喜欢|我偏好|我习惯|I prefer|I like)\s+(.{2,50})/i, tag: 'preference', desc: '用户偏好' },
  { regex: /(?:我不喜欢|我讨厌|I don.?t like|I hate)\s+(.{2,50})/i, tag: 'preference', desc: '用户厌恶' },
  { regex: /(?:请用|用|使用)\s*(简体中文|繁体中文|英文|English|日语|中文)\s*(?:回答|回复|交流)/i, tag: 'preference', desc: '语言偏好' },
  { regex: /(?:我的?(?:系统|电脑|操作系统|OS))\s*[是为]?\s*(Windows|Mac|Linux|Ubuntu|CentOS|macOS)/i, tag: 'tech', desc: '操作系统' },
  { regex: /(?:我(?:的)?(?:主要)?(?:语言|编程语言))\s*[是为:：]?\s*(Python|JavaScript|Java|Go|Rust|C\+\+|TypeScript|PHP|Ruby|C#)/i, tag: 'tech', desc: '编程语言' },
  { regex: /(?:请?记住|请记住|记一下|帮我记|记住：|remember)\s*[:：]?\s*(.{3,200})/i, tag: 'explicit', desc: '用户主动记忆' },
  { regex: /(?:我的?(?:项目|工程|仓库|repo|project))\s*[是为叫]?\s*(.{2,40})/i, tag: 'project', desc: '项目信息' },
];

function autoExtractMemories(text) {
  if (!text || typeof text !== 'string' || text.length < 3) return [];
  var extracted = [];
  for (var i = 0; i < EXTRACTION_PATTERNS.length; i++) {
    var p = EXTRACTION_PATTERNS[i];
    var match = text.match(p.regex);
    if (match) {
      var value = match[1] ? match[1].trim() : '';
      if (value.length < 2) continue;
      extracted.push({ content: p.desc + ': ' + value, tags: p.tag, confidence: p.tag === 'explicit' ? 1.0 : 0.8 });
    }
  }
  return extracted;
}

// ===== 语义搜索（TF-IDF）=====
function _tokenize(text) {
  if (!text) return [];
  var tokens = [];
  var enWord = '';
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (/[a-zA-Z0-9_]/.test(ch)) {
      enWord += ch.toLowerCase();
    } else {
      if (enWord.length > 1) { tokens.push(enWord); enWord = ''; }
      if (/[\u4e00-\u9fff]/.test(ch)) tokens.push(ch);
    }
  }
  if (enWord.length > 1) tokens.push(enWord);
  var stopWords = ['的','了','是','在','我','有','和','就','不','人','都','一','上','也','很','到','说','要','去','你','会','着','没有','看','好','这','那','the','a','an','is','are','was','were','in','on','at','to','for','of','and','or','not'];
  return tokens.filter(function(t) { return stopWords.indexOf(t) < 0; });
}

function semanticSearch(query, limit) {
  limit = limit || 10;
  if (!query || !query.trim()) return [];
  var queryTokens = _tokenize(query);
  if (queryTokens.length === 0) return searchMemories(query, limit);
  var allMemories = listMemories(200);
  if (!allMemories || allMemories.length === 0) return [];
  var docCount = allMemories.length;
  var df = {};
  allMemories.forEach(function(m) {
    var seen = {};
    _tokenize(m.content + ' ' + (m.tags || '')).forEach(function(t) {
      if (!seen[t]) { seen[t] = true; df[t] = (df[t] || 0) + 1; }
    });
  });
  var scored = allMemories.map(function(m) {
    var memTokens = _tokenize(m.content + ' ' + (m.tags || ''));
    var tf = {};
    memTokens.forEach(function(t) { tf[t] = (tf[t] || 0) + 1; });
    var score = 0;
    queryTokens.forEach(function(qt) {
      if (tf[qt]) {
        var termFreq = tf[qt] / memTokens.length;
        var idf = Math.log((docCount + 1) / ((df[qt] || 0) + 1)) + 1;
        score += termFreq * idf;
      }
    });
    var age = (Date.now() / 1000 - (m.created_at || 0)) / 86400;
    var timeBoost = Math.max(0.5, 1 - age / 365);
    return { memory: m, score: score * timeBoost };
  });
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.filter(function(s) { return s.score > 0; }).slice(0, limit).map(function(s) {
    s.memory._relevanceScore = s.score;
    return s.memory;
  });
}

// ===== 去重检测 =====
function isDuplicateMemory(content) {
  if (!content || content.length < 5) return true;
  var existing = listMemories(200);
  if (!existing || existing.length === 0) return false;
  var newTokens = _tokenize(content);
  if (newTokens.length < 2) return false;
  for (var i = 0; i < existing.length; i++) {
    var existTokens = _tokenize(existing[i].content);
    if (existTokens.length < 2) continue;
    var setA = {};
    newTokens.forEach(function(t) { setA[t] = true; });
    var setB = {};
    existTokens.forEach(function(t) { setB[t] = true; });
    var intersection = 0, unionCount = 0;
    Object.keys(setA).forEach(function(t) { if (setB[t]) intersection++; unionCount++; });
    Object.keys(setB).forEach(function(t) { if (!setA[t]) unionCount++; });
    var jaccard = unionCount > 0 ? intersection / unionCount : 0;
    if (jaccard > 0.6) return true;
  }
  return false;
}

// ===== 智能上下文注入 =====
function getSmartMemoryContext(currentQuery, maxItems) {
  maxItems = maxItems || 8;
  if (!currentQuery || currentQuery.length < 2) return getMemoryContext(maxItems);
  var relevant = semanticSearch(currentQuery, maxItems);
  if (relevant.length === 0) return getMemoryContext(Math.min(5, maxItems));
  var lines = relevant.map(function(m) {
    var star = m._relevanceScore > 1.5 ? ' *' : '';
    return '- ' + m.content + star;
  });
  return 'User memories:\n' + lines.join('\n');
}

// ===== 记忆重要性 =====
var IMPORTANCE_LEVELS = { critical: 3, normal: 2, low: 1 };

function setMemoryImportance(id, importance) {
  if (!IMPORTANCE_LEVELS[importance]) importance = 'normal';
  var db = getDB();
  try {
    if (db) {
      db.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(importance, id);
      return { success: true };
    }
    return { success: false, error: 'No database' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function addMemoryWithImportance(content, tags, importance) {
  if (!content || !content.trim()) return { success: false, error: '内容不能为空' };
  if (!IMPORTANCE_LEVELS[importance]) importance = 'normal';
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var tagStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  var db = getDB();
  try {
    if (db) {
      db.prepare('INSERT INTO memories (user_id, content, tags, importance) VALUES (?, ?, ?, ?)').run(userId, content.trim(), tagStr, importance);
      return { success: true };
    }
    return jsonAddMemory(userId, content.trim(), tagStr);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getCriticalMemories(limit) {
  limit = limit || 20;
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var db = getDB();
  try {
    if (db) {
      return db.prepare("SELECT id, content, tags, importance, created_at FROM memories WHERE user_id = ? AND importance = 'critical' ORDER BY created_at DESC LIMIT ?").all(userId, limit);
    }
    return [];
  } catch (e) { return []; }
}

// ===== 用户画像 =====
var PROFILE_KEYS = [
  'name', 'email', 'phone', 'language', 'timezone',
  'os', 'editor', 'programming_languages', 'role', 'company',
  'preferences', 'dislikes', 'projects', 'learning_goals'
];

function getUserProfile() {
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  try {
    if (Core.config && Core.config._user_profiles && Core.config._user_profiles[userId]) {
      return Core.config._user_profiles[userId];
    }
  } catch (e) {}
  return {};
}

function saveUserProfile(profile) {
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  try {
    if (!Core.config._user_profiles) Core.config._user_profiles = {};
    Core.config._user_profiles[userId] = profile;
    Core.saveConfig({ _user_profiles: Core.config._user_profiles });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getProfileString() {
  var profile = getUserProfile();
  var keys = Object.keys(profile);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === 'updated_at')) return '';
  var lines = ['User Profile:'];
  if (profile.name) lines.push('Name: ' + profile.name);
  if (profile.role) lines.push('Role: ' + profile.role);
  if (profile.language) lines.push('Language: ' + profile.language);
  if (profile.os) lines.push('OS: ' + profile.os);
  if (profile.programming_languages) lines.push('Languages: ' + profile.programming_languages);
  if (profile.preferences && profile.preferences.length > 0)
    lines.push('Preferences: ' + profile.preferences.join('; '));
  if (profile.projects && profile.projects.length > 0)
    lines.push('Projects: ' + profile.projects.join('; '));
  return lines.length > 1 ? lines.join('\n') : '';
}

function buildProfileFromMemories() {
  var profile = getUserProfile();
  var memories = listMemories(200);
  if (!memories || memories.length === 0) return profile;
  var tagMap = {};
  memories.forEach(function(m) {
    if (!m.tags) return;
    m.tags.split(',').forEach(function(t) {
      t = t.trim();
      if (!tagMap[t]) tagMap[t] = [];
      tagMap[t].push(m.content);
    });
  });
  if (tagMap.identity && tagMap.identity.length > 0) {
    var nameMatch = tagMap.identity[0].match(/[:：](.+)/);
    if (nameMatch && !profile.name) profile.name = nameMatch[1].trim();
  }
  if (tagMap.preference) {
    profile.preferences = tagMap.preference.map(function(p) {
      var match = p.match(/[:：](.+)/);
      return match ? match[1].trim() : p;
    });
  }
  profile.updated_at = Math.floor(Date.now() / 1000);
  saveUserProfile(profile);
  return profile;
}

// ===== 每日日志 =====
function _today() {
  var now = new Date();
  return now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
}

function getDailyLog(date) {
  date = date || _today();
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var db = getDB();
  try {
    if (db) {
      var rows = db.prepare("SELECT id, content, session_count, updated_at FROM daily_logs WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1").all(userId, date);
      return rows.length > 0 ? rows[0] : null;
    }
    return null;
  } catch (e) { return null; }
}

function appendDailyLog(content) {
  if (!content || !content.trim()) return { success: false };
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var date = _today();
  var existing = getDailyLog(date);
  var db = getDB();
  try {
    if (db) {
      if (existing) {
        var newContent = existing.content + '\n' + content.trim();
        db.prepare("UPDATE daily_logs SET content = ?, session_count = session_count + 1, updated_at = ? WHERE id = ?")
          .run(newContent, Math.floor(Date.now() / 1000), existing.id);
      } else {
        db.prepare("INSERT INTO daily_logs (user_id, date, content, session_count) VALUES (?, ?, ?, 1)")
          .run(userId, date, content.trim());
      }
      return { success: true };
    }
    return { success: false, error: 'No database' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listDailyLogs(days) {
  days = days || 7;
  var userId = (Core && Core.config && Core.config.lastUser) || 'admin';
  var db = getDB();
  try {
    if (db) {
      return db.prepare("SELECT id, date, content, session_count, updated_at FROM daily_logs WHERE user_id = ? ORDER BY date DESC LIMIT ?").all(userId, days);
    }
    return [];
  } catch (e) { return []; }
}

// ===== 精炼记忆 =====
function distillLongTermMemory() {
  var critical = getCriticalMemories(20);
  var profileStr = getProfileString();
  var recentLogs = listDailyLogs(3);
  var sections = [];
  if (profileStr) sections.push(profileStr);
  if (critical.length > 0) {
    var critLines = critical.map(function(m) { return '- [critical] ' + m.content; });
    sections.push('Critical memories:\n' + critLines.join('\n'));
  }
  if (recentLogs.length > 0) {
    var logLines = ['Recent activity:'];
    recentLogs.forEach(function(log) {
      var excerpt = (log.content || '').substring(0, 200).replace(/\n/g, ' ');
      logLines.push('- ' + log.date + ': ' + excerpt);
    });
    sections.push(logLines.join('\n'));
  }
  var result = sections.join('\n\n');
  if (result.length > 8000) result = result.substring(0, 7800) + '\n...(truncated)';
  return result;
}

// ===== 增强上下文注入 =====
function getEnhancedMemoryContext(currentQuery) {
  var parts = [];
  var profileStr = getProfileString();
  if (profileStr) parts.push(profileStr);
  var critical = getCriticalMemories(5);
  if (critical.length > 0) {
    var critLines = critical.map(function(m) { return '- [critical] ' + m.content; });
    parts.push('Critical memories:\n' + critLines.join('\n'));
  }
  if (currentQuery) {
    var smartCtx = getSmartMemoryContext(currentQuery, 5);
    if (smartCtx) parts.push(smartCtx);
  } else {
    var basicCtx = getMemoryContext(5);
    if (basicCtx) parts.push(basicCtx);
  }
  var todayLog = getDailyLog();
  if (todayLog && todayLog.content) {
    var excerpt = todayLog.content.substring(0, 500);
    parts.push('Today log:\n' + excerpt);
  }
  return parts.length > 0 ? parts.join('\n\n') : '';
}

// ===== 统计 =====
function getMemoryStats() {
  var all = listMemories(1000);
  var tags = {};
  all.forEach(function(m) {
    if (m.tags) {
      m.tags.split(',').forEach(function(t) {
        t = t.trim();
        if (t) tags[t] = (tags[t] || 0) + 1;
      });
    }
  });
  return { total: all.length, tags: tags };
}

// ===== JSON 回退 =====
function _getMemoriesFromConfig() {
  if (!Core.config) return [];
  if (!Core.config._memories) Core.config._memories = [];
  return Core.config._memories;
}
function _saveMemoriesToConfig(memories) {
  if (!Core.config) return;
  Core.config._memories = memories;
  Core.saveConfig({ _memories: memories });
}
function jsonAddMemory(userId, content, tags) {
  var memories = _getMemoriesFromConfig();
  memories.unshift({ id: Date.now(), user_id: userId, content: content, tags: tags, created_at: Math.floor(Date.now() / 1000) });
  _saveMemoriesToConfig(memories);
  return { success: true };
}
function jsonListMemories(userId, limit) {
  return _getMemoriesFromConfig().filter(function(m) { return m.user_id === userId; }).slice(0, limit);
}
function jsonDeleteMemory(id) {
  var memories = _getMemoriesFromConfig();
  var filtered = memories.filter(function(m) { return m.id !== id; });
  if (filtered.length === memories.length) return { success: false, error: '未找到该记忆' };
  _saveMemoriesToConfig(filtered);
  return { success: true };
}
function jsonSearchMemories(userId, query, limit) {
  var q = query.toLowerCase();
  return _getMemoriesFromConfig().filter(function(m) {
    return m.user_id === userId && ((m.content && m.content.toLowerCase().indexOf(q) >= 0) || (m.tags && m.tags.toLowerCase().indexOf(q) >= 0));
  }).slice(0, limit);
}

// ===== 数据库扩展 =====
function extendDatabase() {
  var db = getDB();
  if (!db) return;
  try {
    // Check if importance column exists (default schema uses REAL, we want TEXT)
    // The database.js already creates memories with importance REAL DEFAULT 0.5
    // We'll use it as-is, treating string values as labels
    // Create daily_logs table
    db.exec("CREATE TABLE IF NOT EXISTS daily_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL DEFAULT 'admin', date TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', session_count INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(user_id, date DESC)");
    // Add config table for user profiles
    db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
  } catch (e) {
    console.warn('[memory] DB extension error:', e.message);
  }
}

// ===== 模块导出 =====
module.exports = {
  name: 'memory',
  dependencies: ['database'],
  init: function(_Core, router) {
    Core = _Core;

    // Extend database
    extendDatabase();

    // Register WebSocket handlers
    if (router) {
      router.handle('memory.add', function(params) {
        return addMemory(params.content, params.tags);
      });
      router.handle('memory.list', function(params) {
        return { memories: listMemories(params && params.limit) };
      });
      router.handle('memory.delete', function(params) {
        return deleteMemory(params.id);
      });
      router.handle('memory.search', function(params) {
        return { results: searchMemories(params.query, params.limit) };
      });
      router.handle('memory.semanticSearch', function(params) {
        return { results: semanticSearch(params.query, params.limit) };
      });
      router.handle('memory.getContext', function(params) {
        return { context: getEnhancedMemoryContext(params.query) };
      });
      router.handle('memory.addWithImportance', function(params) {
        return addMemoryWithImportance(params.content, params.tags, params.importance);
      });
      router.handle('memory.setImportance', function(params) {
        return setMemoryImportance(params.id, params.importance);
      });
      router.handle('memory.getCritical', function(params) {
        return { memories: getCriticalMemories(params && params.limit) };
      });
      router.handle('memory.getProfile', function() {
        return { profile: getUserProfile() };
      });
      router.handle('memory.saveProfile', function(params) {
        return saveUserProfile(params.profile);
      });
      router.handle('memory.getStats', function() {
        return getMemoryStats();
      });
      router.handle('memory.getDailyLog', function(params) {
        return { log: getDailyLog(params && params.date) };
      });
      router.handle('memory.appendDailyLog', function(params) {
        return appendDailyLog(params.content);
      });
      router.handle('memory.listDailyLogs', function(params) {
        return { logs: listDailyLogs(params && params.days) };
      });
      router.handle('memory.distill', function() {
        return { distilled: distillLongTermMemory() };
      });
      router.handle('memory.autoExtract', function(params) {
        return { extracted: autoExtractMemories(params.text) };
      });
      router.handle('memory.isDuplicate', function(params) {
        return { duplicate: isDuplicateMemory(params.content) };
      });
    }

    // Expose on Core
    Core.memory = {
      add: addMemory,
      list: listMemories,
      delete: deleteMemory,
      search: searchMemories,
      getContext: getMemoryContext,
      autoExtract: autoExtractMemories,
      smartContext: getSmartMemoryContext,
      semanticSearch: semanticSearch,
      isDuplicate: isDuplicateMemory,
      getStats: getMemoryStats,
      getProfile: getUserProfile,
      saveProfile: saveUserProfile,
      getProfileString: getProfileString,
      buildProfile: buildProfileFromMemories,
      getDailyLog: getDailyLog,
      appendDailyLog: appendDailyLog,
      listDailyLogs: listDailyLogs,
      setImportance: setMemoryImportance,
      addWithImportance: addMemoryWithImportance,
      getCritical: getCriticalMemories,
      distill: distillLongTermMemory,
      getEnhancedContext: getEnhancedMemoryContext,
    };

    // Backward compat alias
    Core.memoryEnhance = Core.memory;

    // Auto build profile on startup
    setTimeout(function() {
      try {
        var profile = getUserProfile();
        if (!profile.name) buildProfileFromMemories();
      } catch (e) {}
    }, 2000);

    console.log('[memory] loaded');
  }
};
