// modules/memory.js - 对话记忆系统（/remember + 自动注入）
let Core = null;

// ===== 记忆 CRUD =====

function addMemory(content, tags) {
  if (!content || !content.trim()) return { success: false, error: '内容不能为空' };
  var userId = (Core._currentUser) || 'admin';
  var tagStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      Core.db.run('INSERT INTO memories (user_id, content, tags) VALUES (?, ?, ?)', [userId, content.trim(), tagStr]);
      return { success: true };
    }
    // JSON 回退：存到 config.json 的 memories 数组
    return jsonAddMemory(userId, content.trim(), tagStr);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listMemories(limit) {
  limit = limit || 50;
  var userId = (Core._currentUser) || 'admin';
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      return Core.db.query('SELECT id, content, tags, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
    }
    return jsonListMemories(userId, limit);
  } catch (e) {
    console.warn('⚠️ 读取记忆失败:', e.message);
    return [];
  }
}

function deleteMemory(id) {
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      Core.db.run('DELETE FROM memories WHERE id = ?', [id]);
      return { success: true };
    }
    return jsonDeleteMemory(id);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function searchMemories(query, limit) {
  limit = limit || 5;
  var userId = (Core._currentUser) || 'admin';
  if (!query || !query.trim()) return [];
  try {
    if (Core.db && Core.db._backend === 'sqlite') {
      // SQLite LIKE 搜索（content 和 tags 都搜）
      var pattern = '%' + query.trim() + '%';
      return Core.db.query(
        'SELECT id, content, tags, created_at FROM memories WHERE user_id = ? AND (content LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT ?',
        [userId, pattern, pattern, limit]
      );
    }
    return jsonSearchMemories(userId, query.trim(), limit);
  } catch (e) {
    console.warn('⚠️ 搜索记忆失败:', e.message);
    return [];
  }
}

// 获取用于注入 system prompt 的记忆上下文
function getMemoryContext(maxItems) {
  maxItems = maxItems || 10;
  var memories = listMemories(maxItems);
  if (!memories || memories.length === 0) return '';
  var lines = memories.map(function (m) {
    return '- ' + m.content;
  });
  return '【用户记忆（请在对话中自然地参考这些信息）】\n' + lines.join('\n');
}

// ===== 智能记忆增强 =====

// 1. 自动提取 — 从用户消息中检测值得记住的信息
var EXTRACTION_PATTERNS = [
  // 个人信息
  { regex: /(?:我(?:的名字|叫)|my name is)\s*[是为]?\s*(.{1,20})/i, tag: 'identity', desc: '用户姓名' },
  { regex: /(?:我的?(?:邮箱|邮件|email))\s*[是为:：]?\s*([\w.+-]+@[\w.-]+)/i, tag: 'contact', desc: '用户邮箱' },
  { regex: /(?:我的?(?:手机|电话|号码|phone))\s*[是为:：]?\s*(1[3-9]\d{9}|\+?\d{7,15})/i, tag: 'contact', desc: '用户电话' },
  // 偏好
  { regex: /(?:我喜欢|我偏好|我习惯|I prefer|I like)\s+(.{2,50})/i, tag: 'preference', desc: '用户偏好' },
  { regex: /(?:我不喜欢|我讨厌|I don.?t like|I hate)\s+(.{2,50})/i, tag: 'preference', desc: '用户厌恶' },
  { regex: /(?:请用|用|使用)\s*(简体中文|繁体中文|英文|English|日语|中文)\s*(?:回答|回复|交流|和我)/i, tag: 'preference', desc: '语言偏好' },
  // 技术环境
  { regex: /(?:我的?(?:系统|电脑|操作系统|OS))\s*[是为]?\s*(Windows|Mac|Linux|Ubuntu|CentOS|macOS)/i, tag: 'tech', desc: '操作系统' },
  { regex: /(?:我(?:用|使用|在)\s*(?:的是)?)\s*(VSCode|PyCharm|WebStorm|IDEA|Sublime|Vim|Emacs|Notepad)/i, tag: 'tech', desc: '开发工具' },
  { regex: /(?:我(?:的)?(?:主要)?(?:语言|编程语言))\s*[是为:：]?\s*(Python|JavaScript|Java|Go|Rust|C\+\+|TypeScript|PHP|Ruby|C#)/i, tag: 'tech', desc: '编程语言' },
  // 工作信息
  { regex: /(?:我在|我(?:在)?工作(?:于|在)|我(?:是)?(?:就职|任职)(?:于|在))\s*(.{2,30})/i, tag: 'work', desc: '工作单位' },
  { regex: /(?:我的?(?:职位|岗位|角色|工作))\s*[是为]?\s*(.{2,30})/i, tag: 'work', desc: '职位角色' },
  // 学习目标
  { regex: /(?:我想学|我正在学|我在学|学习)\s+(.{2,40})/i, tag: 'learning', desc: '学习目标' },
  // 明确指令 "记住..."
  { regex: /(?:请?记住|请记住|记一下|帮我记|记住：|remember)\s*[:：]?\s*(.{3,200})/i, tag: 'explicit', desc: '用户主动记忆' },
  // 项目信息
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
      extracted.push({
        content: p.desc + '：' + value,
        tags: p.tag,
        confidence: p.tag === 'explicit' ? 1.0 : 0.8,
      });
    }
  }

  return extracted;
}

// 2. 语义搜索 — TF-IDF 加权评分（比 LIKE 更智能）
function _tokenize(text) {
  if (!text) return [];
  // 中英文混合分词：中文按字，英文按词
  var tokens = [];
  var enWord = '';
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (/[a-zA-Z0-9_]/.test(ch)) {
      enWord += ch.toLowerCase();
    } else {
      if (enWord.length > 1) { tokens.push(enWord); enWord = ''; }
      if (/[\u4e00-\u9fff]/.test(ch)) {
        tokens.push(ch);
      }
    }
  }
  if (enWord.length > 1) tokens.push(enWord);
  // 去停用词
  var stopWords = ['的','了','是','在','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','the','a','an','is','are','was','were','in','on','at','to','for','of','and','or','not'];
  return tokens.filter(function(t) { return stopWords.indexOf(t) < 0; });
}

function semanticSearch(query, limit) {
  limit = limit || 10;
  var userId = (Core._currentUser) || 'admin';
  if (!query || !query.trim()) return [];

  var queryTokens = _tokenize(query);
  if (queryTokens.length === 0) return searchMemories(query, limit); // 降级

  // 获取所有记忆
  var allMemories = listMemories(200);
  if (!allMemories || allMemories.length === 0) return [];

  // 计算 IDF（逆文档频率）
  var docCount = allMemories.length;
  var df = {}; // token -> 包含该 token 的文档数
  allMemories.forEach(function(m) {
    var seen = {};
    _tokenize(m.content + ' ' + (m.tags || '')).forEach(function(t) {
      if (!seen[t]) { seen[t] = true; df[t] = (df[t] || 0) + 1; }
    });
  });

  // 计算每条记忆的 TF-IDF 相关性得分
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

    // 时间衰减（越新越高）
    var age = (Date.now() / 1000 - (m.created_at || 0)) / 86400; // days
    var timeBoost = Math.max(0.5, 1 - age / 365); // 一年内 0.5-1.0

    return { memory: m, score: score * timeBoost };
  });

  // 按分数排序，过滤零分
  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.filter(function(s) { return s.score > 0; }).slice(0, limit).map(function(s) {
    s.memory._relevanceScore = s.score;
    return s.memory;
  });
}

// 3. 记忆去重 — 检查是否已有高度相似的记忆
function isDuplicateMemory(content) {
  if (!content || content.length < 5) return true;
  var existing = listMemories(200);
  if (!existing || existing.length === 0) return false;

  var newTokens = _tokenize(content);
  if (newTokens.length < 2) return false;

  for (var i = 0; i < existing.length; i++) {
    var existTokens = _tokenize(existing[i].content);
    if (existTokens.length < 2) continue;

    // Jaccard 相似度
    var setA = {};
    newTokens.forEach(function(t) { setA[t] = true; });
    var setB = {};
    existTokens.forEach(function(t) { setB[t] = true; });

    var intersection = 0;
    var union = 0;
    Object.keys(setA).forEach(function(t) {
      if (setB[t]) intersection++;
      union++;
    });
    Object.keys(setB).forEach(function(t) { if (!setA[t]) union++; });

    var jaccard = union > 0 ? intersection / union : 0;
    if (jaccard > 0.6) return true; // 60% 以上相似度视为重复
  }
  return false;
}

// 4. 智能上下文注入 — 根据当前对话查询选择最相关的记忆
function getSmartMemoryContext(currentQuery, maxItems) {
  maxItems = maxItems || 8;
  if (!currentQuery || currentQuery.length < 2) {
    return getMemoryContext(maxItems); // 无查询时降级到最近 N 条
  }

  var relevant = semanticSearch(currentQuery, maxItems);
  if (relevant.length === 0) {
    // 降级：返回最近的记忆
    return getMemoryContext(Math.min(5, maxItems));
  }

  var lines = relevant.map(function(m) {
    var scoreTag = m._relevanceScore > 1.5 ? ' ★' : '';
    return '- ' + m.content + scoreTag;
  });
  return '【用户记忆（请在对话中自然地参考这些信息）】\n' + lines.join('\n');
}

// 5. 记忆维护 — 统计和清理
function getMemoryStats() {
  var all = listMemories(1000);
  var tags = {};
  var total = all.length;
  all.forEach(function(m) {
    if (m.tags) {
      m.tags.split(',').forEach(function(t) {
        t = t.trim();
        if (t) tags[t] = (tags[t] || 0) + 1;
      });
    }
  });
  return { total: total, tags: tags };
}

function cleanupOldMemories(maxAgeDays) {
  maxAgeDays = maxAgeDays || 180;
  var cutoff = Date.now() / 1000 - maxAgeDays * 86400;
  var all = listMemories(1000);
  var removed = 0;
  all.forEach(function(m) {
    if (m.created_at && m.created_at < cutoff) {
      deleteMemory(m.id);
      removed++;
    }
  });
  return { removed: removed, remaining: all.length - removed };
}

// ===== JSON 回退（SQLite 不可用时）=====

function _getMemoriesFromConfig() {
  if (!Core.config) return [];
  if (!Core.config._memories) Core.config._memories = [];
  return Core.config._memories;
}

function _saveMemoriesToConfig(memories) {
  if (!Core.config) return;
  Core.config._memories = memories;
  if (Core.saveConfig) Core.saveConfig({ _memories: memories });
}

function jsonAddMemory(userId, content, tags) {
  var memories = _getMemoriesFromConfig();
  memories.unshift({
    id: Date.now(),
    user_id: userId,
    content: content,
    tags: tags,
    created_at: Math.floor(Date.now() / 1000),
  });
  _saveMemoriesToConfig(memories);
  return { success: true };
}

function jsonListMemories(userId, limit) {
  var memories = _getMemoriesFromConfig();
  return memories.filter(function (m) { return m.user_id === userId; }).slice(0, limit);
}

function jsonDeleteMemory(id) {
  var memories = _getMemoriesFromConfig();
  var filtered = memories.filter(function (m) { return m.id !== id; });
  if (filtered.length === memories.length) return { success: false, error: '未找到该记忆' };
  _saveMemoriesToConfig(filtered);
  return { success: true };
}

function jsonSearchMemories(userId, query, limit) {
  var q = query.toLowerCase();
  var memories = _getMemoriesFromConfig();
  return memories.filter(function (m) {
    return m.user_id === userId && (
      (m.content && m.content.toLowerCase().indexOf(q) >= 0) ||
      (m.tags && m.tags.toLowerCase().indexOf(q) >= 0)
    );
  }).slice(0, limit);
}

// ===== 格式化输出 =====

function formatMemoryList(memories) {
  if (!memories || memories.length === 0) return '暂无记忆';
  return memories.map(function (m) {
    var time = m.created_at ? new Date(m.created_at * 1000).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    var tagStr = m.tags ? ' [' + m.tags + ']' : '';
    return '#' + m.id + tagStr + ' ' + m.content + (time ? ' (' + time + ')' : '');
  }).join('\n');
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.memory = {
      add: addMemory,
      list: listMemories,
      delete: deleteMemory,
      search: searchMemories,
      getContext: getMemoryContext,
      formatList: formatMemoryList,
      // 智能增强
      autoExtract: autoExtractMemories,
      smartContext: getSmartMemoryContext,
      semanticSearch: semanticSearch,
      isDuplicate: isDuplicateMemory,
      getStats: getMemoryStats,
      cleanup: cleanupOldMemories,
    };
    console.log('✅ Memory 模块已加载（智能增强）');
  }
};
