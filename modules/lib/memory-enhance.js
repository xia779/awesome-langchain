// modules/lib/memory-enhance.js - 记忆增强功能（重要性/画像/日志/摘要/精炼/LLM提取/嵌入）
var fs = require('fs');
var path = require('path');

module.exports = function(ctx) {
  // ctx provides: Core, addMemory, listMemories, getMemoryContext, getSmartMemoryContext, isDuplicateMemory, getMemoryStats
  var Core = ctx.Core;

  // ===== 1. 数据库扩展：添加 importance 列 + daily_logs 表 =====

  function extendDatabase() {
    if (!Core.db || Core.db._backend !== 'sqlite') return;
    try {
      var cols = Core.db.query("PRAGMA table_info(memories)");
      var colNames = cols.map(function(c) { return c.name; });

      if (colNames.indexOf('importance') < 0) {
        Core.db.run("ALTER TABLE memories ADD COLUMN importance TEXT DEFAULT 'normal'");
      }
      if (colNames.indexOf('embedding') < 0) {
        Core.db.run("ALTER TABLE memories ADD COLUMN embedding TEXT");
      }
      if (colNames.indexOf('source') < 0) {
        Core.db.run("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'manual'");
      }
      if (colNames.indexOf('status') < 0) {
        Core.db.run("ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'active'");
      }
      if (colNames.indexOf('updated_at') < 0) {
        Core.db.run("ALTER TABLE memories ADD COLUMN updated_at INTEGER");
      }
      if (colNames.indexOf('access_count') < 0) {
        Core.db.run("ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0");
      }

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
      if (Core.config && Core.config._user_profiles) {
        return Core.config._user_profiles[userId] || {};
      }
    } catch (e) { console.warn('⚠️ [memory-enhance] 操作失败:', e.message || e); }
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

  function buildProfileFromMemories() {
    var profile = getUserProfile();
    var memories = ctx.listMemories(200);
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
      var nameMatch = tagMap.identity[0].match(/：(.+)/);
      if (nameMatch && !profile.name) profile.name = nameMatch[1].trim();
    }
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
    if (tagMap.preference) {
      profile.preferences = tagMap.preference.map(function(p) {
        var match = p.match(/：(.+)/);
        return match ? match[1].trim() : p;
      });
    }
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
    if (tagMap.project) {
      profile.projects = tagMap.project.map(function(p) {
        var match = p.match(/：(.+)/);
        return match ? match[1].trim() : p;
      });
    }
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

  // ===== P1-7: 用户画像自动构建（LLM 提取） =====

  var _lastProfileExtract = 0;
  var PROFILE_EXTRACT_INTERVAL = 10 * 60 * 1000; // 最少 10 分钟间隔

  /**
   * autoExtractProfile - 从对话消息中 LLM 提取用户画像
   * @param {Array} messages - 最近的对话消息 [{role, content}]
   * @returns {Object} { updated: bool, fields: [更新的字段] }
   */
  async function autoExtractProfile(messages) {
    // 频率限制
    if (Date.now() - _lastProfileExtract < PROFILE_EXTRACT_INTERVAL) {
      return { updated: false, reason: 'cooldown' };
    }
    if (!messages || messages.length < 3) return { updated: false, reason: 'too_few' };
    if (!Core.api || !Core.api.callAPI) return { updated: false, reason: 'no_api' };

    _lastProfileExtract = Date.now();

    // 取最近的用户消息（最多 10 条）
    var userMsgs = messages.filter(function(m) { return m.role === 'user'; }).slice(-10);
    if (userMsgs.length < 2) return { updated: false, reason: 'too_few_user' };

    var conversationText = userMsgs.map(function(m) { return (m.content || '').substring(0, 300); }).join('\n');

    var extractPrompt = '从以下用户对话中提取用户画像信息。只输出 JSON，格式：{"name":"","role":"","company":"","programming_languages":"","preferences":"","projects":"","learning_goals":""}。只填写能确定的字段，不确定的留空字符串。不要编造。\n\n对话内容：\n' + conversationText;

    try {
      var result = await Core.api.callAPI(extractPrompt, '你是一个用户画像提取器。只输出纯JSON，不要有其他文字。', 0.1, null, null, null, { disableTools: true });
      var text = (result && result.message && result.message.content) || '';
      var jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return { updated: false, reason: 'no_json' };

      var extracted = JSON.parse(jsonMatch[0]);
      var profile = getUserProfile();
      var updatedFields = [];

      PROFILE_KEYS.forEach(function(key) {
        if (extracted[key] && typeof extracted[key] === 'string' && extracted[key].trim()) {
          // 只填充空字段，不覆盖已有数据
          if (!profile[key]) {
            profile[key] = extracted[key].trim();
            updatedFields.push(key);
          }
        }
      });

      if (updatedFields.length > 0) {
        profile.updated_at = Math.floor(Date.now() / 1000);
        profile._auto_extracted = (profile._auto_extracted || 0) + 1;
        saveUserProfile(profile);
        console.log('🧠 [profile] 自动提取 ' + updatedFields.length + ' 个画像字段: ' + updatedFields.join(', '));
      }

      return { updated: updatedFields.length > 0, fields: updatedFields };
    } catch (e) {
      return { updated: false, reason: 'error', error: e.message };
    }
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

  function formatProfile(profile) {
    if (!profile || Object.keys(profile).length === 0) return '暂无用户画像';
    var lines = [];
    if (profile.name) lines.push('👤 ' + profile.name);
    if (profile.role) lines.push('💼 ' + profile.role + (profile.company ? ' @ ' + profile.company : ''));
    if (profile.email) lines.push('📧 ' + profile.email);
    if (profile.os) lines.push('💻 ' + profile.os + (profile.editor ? ' + ' + profile.editor : ''));
    if (profile.programming_languages) lines.push('🔧 ' + profile.programming_languages);
    if (profile.preferences) {
      var prefs = Array.isArray(profile.preferences) ? profile.preferences.join(', ') : profile.preferences;
      lines.push('⚙️ ' + prefs);
    }
    if (profile.projects) {
      var projs = Array.isArray(profile.projects) ? profile.projects.join(', ') : profile.projects;
      lines.push('📁 ' + projs);
    }
    return lines.length > 0 ? lines.join('\n') : '暂无用户画像';
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

    var topics = [];
    var decisions = [];
    var tasks = [];

    userMessages.forEach(function(m) {
      var text = (m.content || '').substring(0, 100);
      if (/创建|生成|写|开发|实现|修复|fix|create|build|implement/i.test(text)) {
        tasks.push(text);
      }
      if (/选择|决定|使用|采用|用.*方案|prefer|choose|decide/i.test(text)) {
        decisions.push(text);
      }
    });

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

    var logLines = ['## 会话摘要 (' + summary.date + ')'];
    logLines.push('消息数: ' + messages.length + ' (用户 ' + userMessages.length + ', AI ' + aiMessages.length + ')');
    if (topics.length > 0) logLines.push('主题: ' + topics.join(', '));
    if (tasks.length > 0) logLines.push('任务: ' + tasks.slice(0, 3).join(' | '));
    if (decisions.length > 0) logLines.push('决策: ' + decisions.slice(0, 3).join(' | '));

    appendDailyLog(logLines.join('\n'));

    return summary;
  }

  // ===== 6. 精炼长期记忆（MEMORY.md 风格）=====

  function distillLongTermMemory() {
    var critical = getCriticalMemories(20);
    var profile = getUserProfile();
    var recentLogs = listDailyLogs(3);

    var sections = [];

    var profileStr = getProfileString();
    if (profileStr) sections.push(profileStr);

    if (critical.length > 0) {
      var critLines = critical.map(function(m) { return '- [重要] ' + m.content; });
      sections.push('【关键记忆】\n' + critLines.join('\n'));
    }

    if (recentLogs.length > 0) {
      var logLines = ['【近期活动】'];
      recentLogs.forEach(function(log) {
        var excerpt = (log.content || '').substring(0, 200).replace(/\n/g, ' ');
        logLines.push('- ' + log.date + ': ' + excerpt);
      });
      sections.push(logLines.join('\n'));
    }

    var result = sections.join('\n\n');
    if (result.length > 8000) {
      result = result.substring(0, 7800) + '\n...(记忆已截断)';
    }

    return result;
  }

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

  // ===== P1-4: 语义记忆检索 =====

  /**
   * semanticMemorySearch - 基于嵌入向量的语义相似度检索
   * @param {string} query - 查询文本
   * @param {number} topK - 返回条数
   * @returns {Array} [{id, content, score, importance}]
   */
  async function semanticMemorySearch(query, topK) {
    topK = topK || 5;
    if (!Core.knowledge || !Core.knowledge._getEmbedding || !Core.knowledge._cosineSimilarity) return [];
    if (!Core.db || Core.db._backend !== 'sqlite') return [];

    try {
      var queryEmbedding = await Core.knowledge._getEmbedding(query);
      if (!queryEmbedding) return [];

      var userId = (Core._currentUser) || 'admin';
      var rows = Core.db.query(
        "SELECT id, content, importance, access_count, created_at, updated_at FROM memories WHERE user_id = ? AND status = 'active' AND embedding IS NOT NULL AND embedding != '' ORDER BY created_at DESC LIMIT 200",
        [userId]
      );
      if (!rows || rows.length === 0) return [];

      var results = [];
      for (var i = 0; i < rows.length; i++) {
        var emb;
        try {
          var embRow = Core.db.query("SELECT embedding FROM memories WHERE id = ?", [rows[i].id]);
          if (!embRow || !embRow[0] || !embRow[0].embedding) continue;
          emb = JSON.parse(embRow[0].embedding);
        } catch (e) { continue; }
        if (!emb) continue;

        var sim = Core.knowledge._cosineSimilarity(queryEmbedding, emb);
        if (sim > 0.3) {
          // P1-5: 综合评分 = 语义相似度 × 重要性权重 × 时间衰减
          var score = _computeDecayScore(rows[i], sim);
          results.push({ id: rows[i].id, content: rows[i].content, score: score, rawSim: sim, importance: rows[i].importance || 'normal' });
        }
      }

      results.sort(function(a, b) { return b.score - a.score; });
      return results.slice(0, topK);
    } catch (e) {
      return [];
    }
  }

  // ===== P1-5: 记忆衰减 + 重要性加权 =====

  var IMPORTANCE_WEIGHTS = { critical: 2.0, normal: 1.0, low: 0.5 };
  var DECAY_HALF_LIFE_DAYS = 30; // 30 天半衰期

  /**
   * _computeDecayScore - 综合评分
   * score = semanticSim × importanceWeight × timeDecay × accessBoost
   */
  function _computeDecayScore(memoryRow, semanticSim) {
    var impWeight = IMPORTANCE_WEIGHTS[memoryRow.importance] || 1.0;

    // 时间衰减：指数衰减，critical 不衰减
    var timeDecay = 1.0;
    if (memoryRow.importance !== 'critical') {
      var now = Math.floor(Date.now() / 1000);
      var lastAccess = memoryRow.updated_at || memoryRow.created_at || now;
      var daysSinceAccess = (now - lastAccess) / 86400;
      timeDecay = Math.pow(0.5, daysSinceAccess / DECAY_HALF_LIFE_DAYS);
      timeDecay = Math.max(timeDecay, 0.1); // 最低 0.1，不完全遗忘
    }

    // 访问频率加成（log 缩放）
    var accessBoost = 1.0 + Math.log1p(memoryRow.access_count || 0) * 0.1;

    return semanticSim * impWeight * timeDecay * accessBoost;
  }

  /**
   * recordMemoryAccess - 记录记忆被访问（更新 access_count + updated_at）
   */
  function recordMemoryAccess(memoryId) {
    if (!Core.db || Core.db._backend !== 'sqlite') return;
    try {
      Core.db.run(
        "UPDATE memories SET access_count = COALESCE(access_count, 0) + 1, updated_at = ? WHERE id = ?",
        [Math.floor(Date.now() / 1000), memoryId]
      );
    } catch (e) { /* non-critical */ }
  }

  async function getEnhancedMemoryContext(currentQuery) {
    var parts = [];

    var profileStr = getProfileString();
    if (profileStr) parts.push(profileStr);

    var critical = getCriticalMemories(5);
    if (critical.length > 0) {
      var critLines = critical.map(function(m) { return '- [重要] ' + m.content; });
      parts.push('【关键记忆】\n' + critLines.join('\n'));
    }

    // 🔧 P1-4: 语义检索 + 关键词检索 RRF 融合
    if (currentQuery) {
      var semanticResults = await semanticMemorySearch(currentQuery, 5);
      var keywordResults = [];
      if (Core.memory && ctx.getSmartMemoryContext) {
        var smartCtx = await ctx.getSmartMemoryContext(currentQuery, 5);
        if (smartCtx) keywordResults.push(smartCtx);
      }

      if (semanticResults.length > 0) {
        var semLines = semanticResults.map(function(r) {
          recordMemoryAccess(r.id);
          return '- ' + r.content;
        });
        parts.push('【相关记忆】\n' + semLines.join('\n'));
      } else if (keywordResults.length > 0) {
        parts.push(keywordResults.join('\n'));
      } else if (Core.memory && ctx.getMemoryContext) {
        var basicCtx = ctx.getMemoryContext(5);
        if (basicCtx) parts.push(basicCtx);
      }
    } else if (Core.memory && ctx.getMemoryContext) {
      var basicCtx = ctx.getMemoryContext(5);
      if (basicCtx) parts.push(basicCtx);
    }

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

  // ===== 命令处理 =====

  function formatDailyLogs(logs) {
    if (!logs || logs.length === 0) return '暂无日志';
    return logs.map(function(l) {
      var excerpt = (l.content || '').substring(0, 100).replace(/\n/g, ' ');
      return '📅 ' + l.date + ' (' + (l.session_count || 0) + '次): ' + excerpt;
    }).join('\n');
  }

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
        var stats = ctx.getMemoryStats();
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

  // ===== LLM 自动记忆提取（typingEnd 触发，每会话节流）=====
  var _lastExtractSession = {};

  async function llmExtractMemories(sessionId, messages) {
    var now = Date.now();
    if (_lastExtractSession[sessionId] && now - _lastExtractSession[sessionId] < 60000) return;
    _lastExtractSession[sessionId] = now;

    if (!Core.api || !Core.api.callAPI) return;
    if (!messages || messages.length < 2) return;

    var recentMsgs = messages.slice(-6);
    var conversationText = recentMsgs.map(function(m) {
      var role = m.role === 'user' ? '用户' : 'AI';
      return role + ': ' + (m.content || '').substring(0, 500);
    }).join('\n');

    var systemPrompt = '你是一个记忆提取助手。从以下对话中提取值得长期记住的信息（用户偏好、重要事实、决定、个人信息等）。\n' +
      '输出格式：每行一条记忆，用 "- " 开头。如果没有值得记住的内容，输出 "无"。\n' +
      '只输出记忆条目，不要解释。最多提取 3 条最重要的。';

    try {
      var result = await Core.api.callAPI(
        conversationText,
        systemPrompt,
        0.3,
        null, null,
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: '请从以下对话中提取记忆：\n\n' + conversationText }],
        { disableTools: true }
      );

      if (!result || !result.message || !result.message.content) return;
      var content = result.message.content.trim();
      if (content === '无' || content.length < 3) return;

      var lines = content.split('\n').filter(function(l) {
        l = l.trim();
        return l.startsWith('- ') || l.startsWith('· ') || l.startsWith('* ');
      });

      var extracted = 0;
      for (var i = 0; i < lines.length && extracted < 3; i++) {
        var memContent = lines[i].replace(/^[-·*]\s*/, '').trim();
        if (memContent.length < 5) continue;

        var isDup = await _checkDuplicateVector(memContent);
        if (isDup) continue;
        if (ctx.isDuplicateMemory(memContent)) continue;

        addMemoryWithSource(memContent, 'auto', 'llm');
        extracted++;
      }

      if (extracted > 0) {
        console.log('🧠 LLM 自动提取 ' + extracted + ' 条记忆');
      }
    } catch (e) {
      // 静默失败，不影响主流程
    }
  }

  async function _checkDuplicateVector(content) {
    if (!Core.knowledge || !Core.knowledge._getEmbedding || !Core.knowledge._cosineSimilarity) return false;
    if (!Core.db || Core.db._backend !== 'sqlite') return false;

    try {
      var newEmbedding = await Core.knowledge._getEmbedding(content);
      if (!newEmbedding) return false;

      var userId = (Core._currentUser) || 'admin';
      var rows = Core.db.query(
        "SELECT embedding FROM memories WHERE user_id = ? AND status = 'active' AND embedding IS NOT NULL AND embedding != '' ORDER BY created_at DESC LIMIT 50",
        [userId]
      );
      if (!rows || rows.length === 0) return false;

      for (var i = 0; i < rows.length; i++) {
        var existing;
        try { existing = JSON.parse(rows[i].embedding); } catch (e) { continue; }
        if (!existing) continue;
        var sim = Core.knowledge._cosineSimilarity(newEmbedding, existing);
        if (sim > 0.9) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function addMemoryWithSource(content, tags, source) {
    var result = ctx.addMemory(content, tags);
    if (result.success && Core.db && Core.db._backend === 'sqlite') {
      try {
        var userId = (Core._currentUser) || 'admin';
        Core.db.run(
          "UPDATE memories SET source = ?, updated_at = ? WHERE user_id = ? AND content = ? AND (source IS NULL OR source = 'manual')",
          [source || 'manual', Math.floor(Date.now() / 1000), userId, content.trim()]
        );
        _embedLatestMemory(content.trim(), userId);
      } catch (e) { /* non-critical */ }
    }
    return result;
  }

  async function _embedLatestMemory(content, userId) {
    if (!Core.knowledge || !Core.knowledge._getEmbedding) return;
    try {
      var embedding = await Core.knowledge._getEmbedding(content);
      if (embedding && Core.db && Core.db._backend === 'sqlite') {
        Core.db.run(
          "UPDATE memories SET embedding = ? WHERE user_id = ? AND content = ? AND (embedding IS NULL OR embedding = '')",
          [JSON.stringify(embedding), userId, content]
        );
      }
    } catch (e) { /* non-critical */ }
  }

  var _backfillRunning = false;
  async function backfillMemoryEmbeddings() {
    if (_backfillRunning) return { success: false, error: '填充正在进行中' };
    if (!Core.knowledge || !Core.knowledge._getEmbedding) return { success: false, error: '嵌入模型不可用' };
    if (!Core.db || Core.db._backend !== 'sqlite') return { success: false, error: '需要 SQLite 后端' };

    _backfillRunning = true;
    var userId = (Core._currentUser) || 'admin';
    var filled = 0;

    try {
      var rows = Core.db.query(
        "SELECT id, content FROM memories WHERE user_id = ? AND (embedding IS NULL OR embedding = '') AND content != '' ORDER BY created_at DESC LIMIT 100",
        [userId]
      );

      for (var i = 0; i < rows.length; i++) {
        var embedding = await Core.knowledge._getEmbedding(rows[i].content);
        if (embedding) {
          Core.db.run('UPDATE memories SET embedding = ? WHERE id = ?', [JSON.stringify(embedding), rows[i].id]);
          filled++;
        }
      }

      console.log('🧠 记忆嵌入填充完成: ' + filled + '/' + rows.length + ' 条');
      return { success: true, filled: filled, total: rows.length };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      _backfillRunning = false;
    }
  }

  return {
    extendDatabase: extendDatabase,
    setMemoryImportance: setMemoryImportance,
    addMemoryWithImportance: addMemoryWithImportance,
    getCriticalMemories: getCriticalMemories,
    getUserProfile: getUserProfile,
    saveUserProfile: saveUserProfile,
    updateProfileField: updateProfileField,
    buildProfileFromMemories: buildProfileFromMemories,
    getProfileString: getProfileString,
    formatProfile: formatProfile,
    getDailyLog: getDailyLog,
    appendDailyLog: appendDailyLog,
    listDailyLogs: listDailyLogs,
    generateSessionSummary: generateSessionSummary,
    distillLongTermMemory: distillLongTermMemory,
    writeDistilledMemoryFile: writeDistilledMemoryFile,
    getEnhancedMemoryContext: getEnhancedMemoryContext,
    handleCommand: handleCommand,
    llmExtractMemories: llmExtractMemories,
    addMemoryWithSource: addMemoryWithSource,
    backfillMemoryEmbeddings: backfillMemoryEmbeddings,
    semanticMemorySearch: semanticMemorySearch,
    recordMemoryAccess: recordMemoryAccess,
    autoExtractProfile: autoExtractProfile,
    PROFILE_KEYS: PROFILE_KEYS
  };
};
