// modules/memory-enhance.js - 持久化记忆增强（用户画像 / 日志 / 重要性 / 会话摘要）
var fs = require('fs');
var path = require('path');

let Core = null;

// ===== 1. 数据库扩展：添加 importance 列 + daily_logs 表 =====

function extendDatabase() {
  if (!Core.db || Core.db._backend !== 'sqlite') return;
  try {
    // 给 memories 表添加 importance 列（如果不存在）
    var cols = Core.db.query("PRAGMA table_info(memories)");
    var hasImportance = cols.some(function(c) { return c.name === 'importance'; });
    if (!hasImportance) {
      Core.db.run("ALTER TABLE memories ADD COLUMN importance TEXT DEFAULT 'normal'");
      console.log('  📝 memories 表已添加 importance 列');
    }
    // 创建 daily_logs 表
    Core.db.run(`CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'admin',
      date TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      session_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )`);
    Core.db.run("CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(user_id, date DESC)");
    console.log('  📝 daily_logs 表已创建');
  } catch (e) {
    console.warn('  ⚠️ 数据库扩展失败:', e.message);
  }
}

// ===== 2. 记忆重要性管理 =====

var IMPORTANCE_LEVELS = { critical: 3, normal: 2, low: 1 };

function setMemoryImportance(id, importance) {
  if (!IMPORTANCE_LEVELS[importance]) importance = 'normal';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      Core.db.run('UPDATE memories SET importance = ? WHERE id = ?', [importance, id]);
      return { success: true };
    }
    // JSON 回退
    var memories = _getJsonMemories();
    for (var i = 0; i < memories.length; i++) {
      if (memories[i].id === id) { memories[i].importance = importance; break; }
    }
    _saveJsonMemories(memories);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function addMemoryWithImportance(content, tags, importance) {
  if (!content || !content.trim()) return { success: false, error: '内容不能为空' };
  if (!IMPORTANCE_LEVELS[importance]) importance = 'normal';
  var userId = (Core._currentUser) || 'admin';
  var tagStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      Core.db.run(
        'INSERT INTO memories (user_id, content, tags, importance) VALUES (?, ?, ?, ?)',
        [userId, content.trim(), tagStr, importance]
      );
      return { success: true };
    }
    // JSON 回退
    var memories = _getJsonMemories();
    memories.unshift({
      id: Date.now(), user_id: userId, content: content.trim(),
      tags: tagStr, importance: importance, created_at: Math.floor(Date.now() / 1000)
    });
    _saveJsonMemories(memories);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getCriticalMemories(limit) {
  limit = limit || 20;
  var userId = (Core._currentUser) || 'admin';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      return Core.db.query(
        "SELECT id, content, tags, importance, created_at FROM memories WHERE user_id = ? AND importance = 'critical' ORDER BY created_at DESC LIMIT ?",
        [userId, limit]
      );
    }
    var memories = _getJsonMemories();
    return memories.filter(function(m) {
      return m.user_id === userId && m.importance === 'critical';
    }).slice(0, limit);
  } catch (e) { return []; }
}

// ===== 3. 用户画像 =====

var PROFILE_KEYS = [
  'name', 'email', 'phone', 'language', 'timezone',
  'os', 'editor', 'programming_languages', 'role', 'company',
  'preferences', 'dislikes', 'projects', 'learning_goals'
];

function getUserProfile() {
  var userId = (Core._currentUser) || 'admin';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      var row = Core.db.query("SELECT value FROM config WHERE key = ?", ['user_profile_' + userId]);
      if (row && row.length > 0 && row[0].value) {
        return JSON.parse(row[0].value);
      }
    }
    // JSON 回退
    if (Core.config && Core.config._user_profiles) {
      return Core.config._user_profiles[userId] || {};
    }
  } catch (e) {}
  return {};
}

function saveUserProfile(profile) {
  var userId = (Core._currentUser) || 'admin';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      Core.db.run(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())",
        ['user_profile_' + userId, JSON.stringify(profile)]
      );
      return { success: true };
    }
    if (!Core.config._user_profiles) Core.config._user_profiles = {};
    Core.config._user_profiles[userId] = profile;
    if (Core.saveConfig) Core.saveConfig({ _user_profiles: Core.config._user_profiles });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateProfileField(key, value) {
  if (PROFILE_KEYS.indexOf(key) < 0) return { success: false, error: '无效的画像字段' };
  var profile = getUserProfile();
  profile[key] = value;
  profile.updated_at = Math.floor(Date.now() / 1000);
  return saveUserProfile(profile);
}

// 从已有记忆中自动构建用户画像
function buildProfileFromMemories() {
  var profile = getUserProfile();
  var memories = Core.memory ? Core.memory.list(200) : [];
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

  // 从 identity 类记忆提取姓名
  if (tagMap.identity && tagMap.identity.length > 0) {
    var nameMatch = tagMap.identity[0].match(/：(.+)/);
    if (nameMatch && !profile.name) profile.name = nameMatch[1].trim();
  }
  // 从 contact 类记忆提取联系方式
  if (tagMap.contact) {
    tagMap.contact.forEach(function(c) {
      if (c.indexOf('邮箱') >= 0 && !profile.email) {
        var emailMatch = c.match(/：(.+)/);
        if (emailMatch) profile.email = emailMatch[1].trim();
      }
      if (c.indexOf('电话') >= 0 && !profile.phone) {
        var phoneMatch = c.match(/：(.+)/);
        if (phoneMatch) profile.phone = phoneMatch[1].trim();
      }
    });
  }
  // 从 preference 类记忆提取偏好
  if (tagMap.preference) {
    profile.preferences = tagMap.preference.map(function(p) {
      var match = p.match(/：(.+)/);
      return match ? match[1].trim() : p;
    });
  }
  // 从 tech 类记忆提取技术环境
  if (tagMap.tech) {
    tagMap.tech.forEach(function(t) {
      if (t.indexOf('操作系统') >= 0 && !profile.os) {
        var osMatch = t.match(/：(.+)/);
        if (osMatch) profile.os = osMatch[1].trim();
      }
      if (t.indexOf('开发工具') >= 0 && !profile.editor) {
        var edMatch = t.match(/：(.+)/);
        if (edMatch) profile.editor = edMatch[1].trim();
      }
      if (t.indexOf('编程语言') >= 0 && !profile.programming_languages) {
        var langMatch = t.match(/：(.+)/);
        if (langMatch) profile.programming_languages = langMatch[1].trim();
      }
    });
  }
  // 从 work 类记忆提取工作信息
  if (tagMap.work) {
    tagMap.work.forEach(function(w) {
      if (w.indexOf('工作单位') >= 0 && !profile.company) {
        var cMatch = w.match(/：(.+)/);
        if (cMatch) profile.company = cMatch[1].trim();
      }
      if (w.indexOf('职位') >= 0 && !profile.role) {
        var rMatch = w.match(/：(.+)/);
        if (rMatch) profile.role = rMatch[1].trim();
      }
    });
  }
  // 从 project 类记忆提取项目
  if (tagMap.project) {
    profile.projects = tagMap.project.map(function(p) {
      var match = p.match(/：(.+)/);
      return match ? match[1].trim() : p;
    });
  }
  // 从 learning 类记忆提取学习目标
  if (tagMap.learning) {
    profile.learning_goals = tagMap.learning.map(function(l) {
      var match = l.match(/：(.+)/);
      return match ? match[1].trim() : l;
    });
  }

  profile.updated_at = Math.floor(Date.now() / 1000);
  saveUserProfile(profile);
  return profile;
}

function getProfileString() {
  var profile = getUserProfile();
  var keys = Object.keys(profile);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === 'updated_at')) return '';

  var lines = ['【用户画像】'];
  if (profile.name) lines.push('姓名: ' + profile.name);
  if (profile.role) lines.push('角色: ' + profile.role);
  if (profile.company) lines.push('公司: ' + profile.company);
  if (profile.email) lines.push('邮箱: ' + profile.email);
  if (profile.language) lines.push('语言: ' + profile.language);
  if (profile.timezone) lines.push('时区: ' + profile.timezone);
  if (profile.os) lines.push('系统: ' + profile.os);
  if (profile.editor) lines.push('编辑器: ' + profile.editor);
  if (profile.programming_languages) lines.push('编程语言: ' + profile.programming_languages);
  if (profile.preferences && profile.preferences.length > 0)
    lines.push('偏好: ' + profile.preferences.join('; '));
  if (profile.dislikes && profile.dislikes.length > 0)
    lines.push('厌恶: ' + profile.dislikes.join('; '));
  if (profile.projects && profile.projects.length > 0)
    lines.push('项目: ' + profile.projects.join('; '));
  if (profile.learning_goals && profile.learning_goals.length > 0)
    lines.push('学习目标: ' + profile.learning_goals.join('; '));

  return lines.length > 1 ? lines.join('\n') : '';
}

// ===== 4. 每日记忆日志 =====

function _today() {
  var now = new Date();
  return now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
}

function getDailyLog(date) {
  date = date || _today();
  var userId = (Core._currentUser) || 'admin';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      var rows = Core.db.query(
        "SELECT id, content, session_count, updated_at FROM daily_logs WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1",
        [userId, date]
      );
      return rows && rows.length > 0 ? rows[0] : null;
    }
    // JSON 回退
    var logs = _getJsonLogs();
    var found = logs.filter(function(l) { return l.user_id === userId && l.date === date; });
    return found.length > 0 ? found[found.length - 1] : null;
  } catch (e) { return null; }
}

function appendDailyLog(content) {
  if (!content || !content.trim()) return { success: false };
  var userId = (Core._currentUser) || 'admin';
  var date = _today();
  var existing = getDailyLog(date);

  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      if (existing) {
        var newContent = existing.content + '\n' + content.trim();
        Core.db.run(
          "UPDATE daily_logs SET content = ?, session_count = session_count + 1, updated_at = unixepoch() WHERE id = ?",
          [newContent, existing.id]
        );
      } else {
        Core.db.run(
          "INSERT INTO daily_logs (user_id, date, content, session_count) VALUES (?, ?, ?, 1)",
          [userId, date, content.trim()]
        );
      }
      return { success: true };
    }
    // JSON 回退
    var logs = _getJsonLogs();
    if (existing) {
      for (var i = 0; i < logs.length; i++) {
        if (logs[i].id === existing.id) {
          logs[i].content += '\n' + content.trim();
          logs[i].session_count = (logs[i].session_count || 0) + 1;
          logs[i].updated_at = Math.floor(Date.now() / 1000);
          break;
        }
      }
    } else {
      logs.push({
        id: Date.now(), user_id: userId, date: date,
        content: content.trim(), session_count: 1,
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000)
      });
    }
    _saveJsonLogs(logs);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listDailyLogs(days) {
  days = days || 7;
  var userId = (Core._currentUser) || 'admin';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      return Core.db.query(
        "SELECT id, date, content, session_count, updated_at FROM daily_logs WHERE user_id = ? ORDER BY date DESC LIMIT ?",
        [userId, days]
      );
    }
    var logs = _getJsonLogs();
    return logs.filter(function(l) { return l.user_id === userId; })
      .sort(function(a, b) { return b.date.localeCompare(a.date); })
      .slice(0, days);
  } catch (e) { return []; }
}

// ===== 5. 会话摘要生成 =====

function generateSessionSummary(messages, sessionId) {
  if (!messages || messages.length < 3) return null;

  var userMessages = messages.filter(function(m) { return m.role === 'user'; });
  var aiMessages = messages.filter(function(m) { return m.role === 'assistant'; });

  if (userMessages.length === 0) return null;

  // 提取关键信息
  var topics = [];
  var decisions = [];
  var tasks = [];

  // 从用户消息提取主题
  userMessages.forEach(function(m) {
    var text = (m.content || '').substring(0, 100);
    // 检测任务类消息
    if (/创建|生成|写|开发|实现|修复|fix|create|build|implement/i.test(text)) {
      tasks.push(text);
    }
    // 检测决策类消息
    if (/选择|决定|使用|采用|用.*方案|prefer|choose|decide/i.test(text)) {
      decisions.push(text);
    }
  });

  // 简单主题提取：统计高频词
  var allText = messages.map(function(m) { return m.content || ''; }).join(' ');
  var wordFreq = {};
  var words = allText.match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}/g) || [];
  var stopWords = ['function', 'return', 'const', 'var', 'let', 'this', 'that', 'with', 'from',
    '可以', '已经', '使用', '通过', '进行', '如果', '但是', '因为', '所以', '这个', '那个', '我们', '你们'];
  words.forEach(function(w) {
    if (stopWords.indexOf(w) < 0 && w.length >= 2) {
      wordFreq[w] = (wordFreq[w] || 0) + 1;
    }
  });
  var sortedWords = Object.keys(wordFreq).sort(function(a, b) { return wordFreq[b] - wordFreq[a]; });
  topics = sortedWords.slice(0, 8);

  var summary = {
    session_id: sessionId || 'unknown',
    date: _today(),
    message_count: messages.length,
    user_messages: userMessages.length,
    ai_messages: aiMessages.length,
    topics: topics,
    tasks: tasks.slice(0, 5),
    decisions: decisions.slice(0, 3),
    generated_at: Math.floor(Date.now() / 1000)
  };

  // 格式化为日志文本
  var logLines = ['## 会话摘要 (' + summary.date + ')'];
  logLines.push('消息数: ' + messages.length + ' (用户 ' + userMessages.length + ', AI ' + aiMessages.length + ')');
  if (topics.length > 0) logLines.push('主题: ' + topics.join(', '));
  if (tasks.length > 0) logLines.push('任务: ' + tasks.slice(0, 3).join(' | '));
  if (decisions.length > 0) logLines.push('决策: ' + decisions.slice(0, 3).join(' | '));

  // 写入每日日志
  appendDailyLog(logLines.join('\n'));

  return summary;
}

// ===== 6. 精炼长期记忆（MEMORY.md 风格）=====

function distillLongTermMemory() {
  var critical = getCriticalMemories(20);
  var profile = getUserProfile();
  var recentLogs = listDailyLogs(3);

  var sections = [];

  // 用户画像摘要
  var profileStr = getProfileString();
  if (profileStr) sections.push(profileStr);

  // 关键记忆（始终注入）
  if (critical.length > 0) {
    var critLines = critical.map(function(m) { return '- [重要] ' + m.content; });
    sections.push('【关键记忆】\n' + critLines.join('\n'));
  }

  // 近期日志摘要
  if (recentLogs.length > 0) {
    var logLines = ['【近期活动】'];
    recentLogs.forEach(function(log) {
      // 取前 200 字符作为摘要
      var excerpt = (log.content || '').substring(0, 200).replace(/\n/g, ' ');
      logLines.push('- ' + log.date + ': ' + excerpt);
    });
    sections.push(logLines.join('\n'));
  }

  var result = sections.join('\n\n');
  // Token budget: ~2000 tokens ≈ 8000 chars
  if (result.length > 8000) {
    result = result.substring(0, 7800) + '\n...(记忆已截断)';
  }

  return result;
}

// 将精炼记忆写入文件（可选，供外部工具读取）
function writeDistilledMemoryFile() {
  var content = distillLongTermMemory();
  if (!content) return { success: false, error: '没有可精炼的记忆' };
  try {
    var filePath = path.join(Core.DATA_ROOT, 'MEMORY.md');
    fs.writeFileSync(filePath, '# 长期记忆\n\n' + content + '\n\n> 自动生成于 ' + new Date().toLocaleString('zh-CN'), 'utf8');
    return { success: true, path: filePath, size: content.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 7. 增强上下文注入 =====

function getEnhancedMemoryContext(currentQuery) {
  var parts = [];

  // 1. 用户画像
  var profileStr = getProfileString();
  if (profileStr) parts.push(profileStr);

  // 2. 关键记忆（始终注入）
  var critical = getCriticalMemories(5);
  if (critical.length > 0) {
    var critLines = critical.map(function(m) { return '- [重要] ' + m.content; });
    parts.push('【关键记忆】\n' + critLines.join('\n'));
  }

  // 3. 相关记忆（基于查询）
  if (currentQuery && Core.memory && Core.memory.smartContext) {
    var smartCtx = Core.memory.smartContext(currentQuery, 5);
    if (smartCtx) parts.push(smartCtx);
  } else if (Core.memory && Core.memory.getContext) {
    var basicCtx = Core.memory.getContext(5);
    if (basicCtx) parts.push(basicCtx);
  }

  // 4. 今日日志摘要
  var todayLog = getDailyLog();
  if (todayLog && todayLog.content) {
    var excerpt = todayLog.content.substring(0, 500);
    parts.push('【今日活动日志】\n' + excerpt);
  }

  return parts.length > 0 ? parts.join('\n\n') : '';
}

// ===== JSON 回退辅助函数 =====

function _getJsonMemories() {
  if (!Core.config || !Core.config._memories) return [];
  return Core.config._memories;
}
function _saveJsonMemories(memories) {
  if (!Core.config) return;
  Core.config._memories = memories;
  if (Core.saveConfig) Core.saveConfig({ _memories: memories });
}
function _getJsonLogs() {
  if (!Core.config || !Core.config._daily_logs) return [];
  return Core.config._daily_logs;
}
function _saveJsonLogs(logs) {
  if (!Core.config) return;
  Core.config._daily_logs = logs;
  if (Core.saveConfig) Core.saveConfig({ _daily_logs: logs });
}

// ===== 8. 格式化输出 =====

function formatProfile(profile) {
  if (!profile || Object.keys(profile).length === 0) return '暂无用户画像';
  var lines = [];
  if (profile.name) lines.push('👤 ' + profile.name);
  if (profile.role) lines.push('💼 ' + profile.role + (profile.company ? ' @ ' + profile.company : ''));
  if (profile.email) lines.push('📧 ' + profile.email);
  if (profile.os) lines.push('💻 ' + profile.os + (profile.editor ? ' + ' + profile.editor : ''));
  if (profile.programming_languages) lines.push('🔧 ' + profile.programming_languages);
  if (profile.language) lines.push('🌐 ' + profile.language);
  if (profile.preferences && profile.preferences.length > 0)
    lines.push('❤️ 偏好: ' + profile.preferences.join(', '));
  if (profile.projects && profile.projects.length > 0)
    lines.push('📁 项目: ' + profile.projects.join(', '));
  if (profile.learning_goals && profile.learning_goals.length > 0)
    lines.push('📚 学习: ' + profile.learning_goals.join(', '));
  return lines.length > 0 ? lines.join('\n') : '画像为空';
}

function formatDailyLogs(logs) {
  if (!logs || logs.length === 0) return '暂无日志';
  return logs.map(function(log) {
    return '📅 ' + log.date + ' (' + (log.session_count || 0) + '个会话)\n' + log.content;
  }).join('\n\n---\n\n');
}

// ===== 命令处理 =====

function handleCommand(args) {
  var parts = args.trim().split(/\s+/);
  var cmd = parts[0] || 'help';
  var subArgs = parts.slice(1).join(' ');

  switch (cmd) {
    case 'profile':
      if (parts[1] === 'build') {
        var profile = buildProfileFromMemories();
        return '✅ 画像已从记忆构建\n' + formatProfile(profile);
      }
      if (parts[1] === 'set' && parts[2] && parts[3]) {
        updateProfileField(parts[2], parts.slice(3).join(' '));
        return '✅ 已更新: ' + parts[2] + ' = ' + parts.slice(3).join(' ');
      }
      return formatProfile(getUserProfile());

    case 'log':
      if (parts[1] === 'add') {
        appendDailyLog(subArgs.substring(4));
        return '✅ 已追加到今日日志';
      }
      if (parts[1] === 'today') {
        var log = getDailyLog();
        return log ? '📅 ' + log.date + '\n' + log.content : '今日暂无日志';
      }
      var days = parseInt(parts[1]) || 7;
      return formatDailyLogs(listDailyLogs(days));

    case 'important':
    case 'critical':
      if (parts[1] === 'add') {
        var content = parts.slice(2).join(' ');
        addMemoryWithImportance(content, 'critical', 'critical');
        return '✅ 已添加关键记忆: ' + content;
      }
      if (parts[1] === 'set' && parts[2]) {
        var level = parts[3] || 'normal';
        setMemoryImportance(parseInt(parts[2]), level);
        return '✅ 记忆 #' + parts[2] + ' 重要性已设为 ' + level;
      }
      var crits = getCriticalMemories(20);
      return '⭐ 关键记忆 (' + crits.length + '条):\n' + (crits.length > 0 ?
        crits.map(function(m) { return '#' + m.id + ' ' + m.content; }).join('\n') : '暂无');

    case 'summary':
      if (Core.session && Core.session.getCurrentId) {
        var sid = Core.session.getCurrentId();
        var msgs = Core.session.getMessages ? Core.session.getMessages(sid) : [];
        if (msgs.length > 0) {
          var summary = generateSessionSummary(msgs, sid);
          return summary ? '✅ 会话摘要已生成并写入日志' : '⚠️ 消息不足以生成摘要';
        }
      }
      return '⚠️ 无法获取当前会话消息';

    case 'distill':
      var result = writeDistilledMemoryFile();
      if (result.success) return '✅ MEMORY.md 已生成: ' + result.path + ' (' + result.size + ' 字符)';
      return '⚠️ ' + (result.error || '生成失败');

    case 'stats':
      var stats = Core.memory ? Core.memory.getStats() : { total: 0, tags: {} };
      var critCount = getCriticalMemories(100).length;
      var logs = listDailyLogs(30);
      var profile = getUserProfile();
      var profileKeys = Object.keys(profile).filter(function(k) { return k !== 'updated_at'; });
      return '📊 记忆增强统计\n' +
        '总记忆: ' + stats.total + ' 条\n' +
        '关键记忆: ' + critCount + ' 条\n' +
        '日志天数: ' + logs.length + ' 天\n' +
        '画像完整度: ' + profileKeys.length + '/' + PROFILE_KEYS.length + ' (' +
        Math.round(profileKeys.length / PROFILE_KEYS.length * 100) + '%)\n' +
        '标签分布: ' + JSON.stringify(stats.tags);

    default:
      return '🧠 记忆增强命令\n' +
        '/mem profile [build|set <key> <value>] — 用户画像\n' +
        '/mem log [add|today|<天数>] — 每日日志\n' +
        '/mem critical [add|set <id> <level>] — 关键记忆\n' +
        '/mem summary — 生成当前会话摘要\n' +
        '/mem distill — 精炼 MEMORY.md\n' +
        '/mem stats — 记忆统计';
  }
}

// ===== 模块导出 =====

module.exports = {
  name: 'memory-enhance',
  dependencies: ['routing'],
  init(_Core) {
    Core = _Core;
    // 扩展数据库
    extendDatabase();

    Core.memoryEnhance = {
      // 用户画像
      getProfile: getUserProfile,
      saveProfile: saveUserProfile,
      updateProfileField: updateProfileField,
      buildProfile: buildProfileFromMemories,
      getProfileString: getProfileString,
      formatProfile: formatProfile,
      // 每日日志
      getDailyLog: getDailyLog,
      appendDailyLog: appendDailyLog,
      listDailyLogs: listDailyLogs,
      // 记忆重要性
      setImportance: setMemoryImportance,
      addWithImportance: addMemoryWithImportance,
      getCritical: getCriticalMemories,
      // 会话摘要
      generateSessionSummary: generateSessionSummary,
      // 精炼记忆
      distill: distillLongTermMemory,
      writeDistilledFile: writeDistilledMemoryFile,
      // 增强上下文
      getEnhancedContext: getEnhancedMemoryContext,
    };

    // 注册命令
    if (Core.routing && Core.routing.register) {
      Core.routing.register('/mem', handleCommand, '记忆增强（画像/日志/关键记忆/精炼）');
    }

    // 启动时自动构建画像
    setTimeout(function() {
      try {
        var profile = getUserProfile();
        if (!profile.name && Core.memory) {
          buildProfileFromMemories();
        }
      } catch (e) {}
    }, 2000);

    console.log('✅ Memory-Enhance 模块已加载（画像/日志/重要性/精炼）');
  }
};
