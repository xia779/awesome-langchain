// modules/session.js (树形层级架构版 - 20250628)
const fs = require('fs');
const path = require('path');
var _htmlUtils = require('./html-utils');
var sessionRenderFactory = require('./lib/session-render');

let Core = null;

// Phase 5-2: XSS防护 — HTML轉義工具函數（使用共享模組）
var _escapeHtml = _htmlUtils.escapeHtml;

// 🔧 获取会话目录：使用动态路径（修复硬编码问题）
function getSessionsDir() {
  var base = (Core && Core.DATA_ROOT) || process.env.AI_AGENT_DATA_ROOT || 'E:\\my-ai-data';
  var dir = path.join(base, 'sessions');
  ensureDir(dir);
  return dir;
}

let sessionsDir = null; // 延迟初始化，在 init() 中设置
let sessions = {};
let currentSessionId = null;

// ===== D: 防抖自动保存 =====
var autoSaveTimers = {};
var AUTO_SAVE_DELAY = 2000; // 2秒防抖

function debouncedAutoSave(sessionId) {
  if (autoSaveTimers[sessionId]) clearTimeout(autoSaveTimers[sessionId]);
  autoSaveTimers[sessionId] = setTimeout(function() {
    if (sessions[sessionId]) {
      saveSession(sessionId);
    }
    delete autoSaveTimers[sessionId];
  }, AUTO_SAVE_DELAY);
}

function immediateSave(sessionId) {
  if (autoSaveTimers[sessionId]) {
    clearTimeout(autoSaveTimers[sessionId]);
    delete autoSaveTimers[sessionId];
  }
  if (sessions[sessionId]) saveSession(sessionId);
}
let chatListFilter = '';
let chatListDateFilter = 'all'; // P4: 日期筛选

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ===== 渲染模块（从 lib/session-render.js 加载）=====
var _render = sessionRenderFactory({
  get sessions() { return sessions; },
  get currentSessionId() { return currentSessionId; },
  get Core() { return Core; },
  get chatListFilter() { return chatListFilter; },
  get chatListDateFilter() { return chatListDateFilter; },
  getChildrenIds: getChildrenIds,
  escapeHtml: _escapeHtml
});

// 委托函数（保持内部调用兼容）
function renderChatList() { return _render.renderChatList(); }
function renderMessages(id, ensureMsgIndex) { return _render.renderMessages(id, ensureMsgIndex); }
function renderSingleMessage(msg, index, container) { return _render.renderSingleMessage(msg, index, container); }
function highlightChatItem(id) { return _render.highlightChatItem(id); }
function scrollToBottom() { return _render.scrollToBottom(); }
function updateChatCountDisplay() { return _render.updateChatCountDisplay(); }
function addCodeButtonsToDiv(div) { return _render.addCodeButtonsToDiv(div); }

// ===== 获取子节点 ID =====
function getChildrenIds(parentId) {
  return Object.keys(sessions)
    .filter(id => sessions[id].parentId === parentId)
    .sort(function(a, b) {
      // 🔧 排序：chat 类型（普通对话）排在 role 类型（角色）之前
      var aRole = sessions[a].roleType;
      var bRole = sessions[b].roleType;
      if (aRole === 'chat' && bRole !== 'chat') return -1;
      if (aRole !== 'chat' && bRole === 'chat') return 1;
      // 同类型按创建时间倒序（新的在前）
      var aTime = sessions[a].timestamp || 0;
      var bTime = sessions[b].timestamp || 0;
      return bTime - aTime;
    });
}

// ===== 加载会话 =====
function loadSessions() {
  sessions = {};
  var userId = Core._currentUser || 'admin';
  
  // 🔧 P0: 优先从 SQLite 加载会话
  try {
    if (Core.db && Core.db.getSessions) {
      var dbSessions = Core.db.getSessions(userId);
      if (Object.keys(dbSessions).length > 0) {
        sessions = dbSessions;
        console.log('✅ 会话已从 SQLite 加载:', Object.keys(sessions).length, '个');
        return;
      }
    }
  } catch (e) {
    console.warn('⚠️ SQLite 加载会话失败:', e.message);
  }
  
  // 从 JSON 文件加载
  var dir = getSessionsDir();
  ensureDir(dir);
  
  function loadDir(directory) {
    try {
      var files = fs.readdirSync(directory);
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var filePath = path.join(directory, file);
        var stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          loadDir(filePath);
        } else if (file.endsWith('.json')) {
          var id = file.replace('.json', '');
          try {
            var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            sessions[id] = data;
            if (sessions[id].pinned === undefined) sessions[id].pinned = false;
            if (sessions[id].collapsed === undefined) sessions[id].collapsed = false;
          } catch (e) {
            console.warn('⚠️ 加载会话失败:', file, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ 读取目录失败:', directory, e.message);
    }
  }
  
  loadDir(dir);
  
  // 自动迁移到 SQLite
  if (Core.db && Core.db.migrateFromJSON && Object.keys(sessions).length > 0) {
    try {
      Core.db.migrateFromJSON(userId);
      console.log('✅ 会话已自动迁移到 SQLite');
    } catch (e) {
      console.warn('⚠️ 会话迁移到 SQLite 失败:', e.message);
    }
  }
  
  // 🔧 检查所有可能的旧目录并迁移（动态计算，消除硬编码）
  var globalRoot = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || process.env.AI_AGENT_DATA_ROOT || 'E:\\my-ai-data';
  var possibleDirs = [
    path.join(globalRoot, 'sessions'),
    path.join(globalRoot, 'users', 'admin', 'sessions')
  ];
  
  for (var d = 0; d < possibleDirs.length; d++) {
    var oldDir = possibleDirs[d];
    if (oldDir !== dir && fs.existsSync(oldDir)) {
      try {
        var oldFiles = fs.readdirSync(oldDir).filter(f => f.endsWith('.json'));
        var migrated = 0;
        for (var i = 0; i < oldFiles.length; i++) {
          var id = oldFiles[i].replace('.json', '');
          if (!sessions[id]) {
            var filePath = path.join(oldDir, oldFiles[i]);
            var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            sessions[id] = data;
            saveSession(id); // 保存到新目录
            fs.unlinkSync(filePath); // 删除旧文件
            migrated++;
          }
        }
        if (migrated > 0) {
          console.log('✅ 已迁移', migrated, '个旧会话从', oldDir);
        }
        // 如果目录为空，删除旧目录
        var remaining = fs.readdirSync(oldDir);
        if (remaining.length === 0) {
          fs.rmdirSync(oldDir);
        }
      } catch (e) {
        console.warn('⚠️ 迁移旧会话失败:', oldDir, e.message);
      }
    }
  }
  

  // 如果没有会话，创建一个默认的
  if (Object.keys(sessions).length === 0) {
    var defaultTemp = (Core && Core.config && Core.config.temperature !== undefined) ? Core.config.temperature : 0.7;
    var id = Core.generateId();
    sessions[id] = { 
      title: '新对话', 
      messages: [{ role: 'ai', content: '👋 你好！我是你的 AI 助手。' }], 
      pinned: false, 
      temperature: defaultTemp,
      roleType: 'chat', parentId: null, collapsed: false, _manuallyRenamed: false
    };
    saveSession(id);
    currentSessionId = id;
  } else {
    // 检查是否需要创建角色数据
    ensureDefaultRoles();
    // 🔧 设置 currentSessionId 为第一个根节点（如果未设置）
    if (!currentSessionId || !sessions[currentSessionId]) {
      var rootIds = Object.keys(sessions).filter(function(id) { return !sessions[id].parentId; });
      if (rootIds.length > 0) {
        currentSessionId = rootIds[0];
      }
    }
  }
  
  // 🔧 清除所有运行时状态（_apiState 不应被持久化）
  var clearedCount = 0;
  Object.keys(sessions).forEach(function(id) {
    if (sessions[id]._apiState) {
      delete sessions[id]._apiState;
      clearedCount++;
    }
  });
  if (clearedCount > 0) {
  }
  
  // 检查并修复旧数据：没有 parentId 的会话默认挂到 master 下
  // 🔧 迁移：为旧消息添加/修复时间戳（按消息顺序，每条间隔1分钟，避免全部相同）
  Object.keys(sessions).forEach(function(id) {
    var sess = sessions[id];
    if (sess.messages && Array.isArray(sess.messages) && sess.messages.length > 0) {
      var needsSave = false;
      var baseTime = Date.now();
      
      // 检测是否所有时间戳都相同（或缺失）——这是之前错误迁移的结果
      var timestamps = sess.messages.map(function(m) { return m.timestamp || 0; });
      var allSameOrMissing = true;
      if (timestamps.length > 1) {
        var first = timestamps[0];
        for (var t = 1; t < timestamps.length; t++) {
          if (Math.abs(timestamps[t] - first) > 1000) {
            allSameOrMissing = false;
            break;
          }
        }
      }
      
      sess.messages.forEach(function(msg, idx) {
        if (!msg.timestamp || isNaN(msg.timestamp) || allSameOrMissing) {
          // 按消息索引顺序，从当前时间往前推（每条消息间隔1分钟），保证时间顺序合理
          msg.timestamp = baseTime - (sess.messages.length - 1 - idx) * 60000;
          needsSave = true;
        }
      });
      if (needsSave) {
        saveSession(id);
      }
    }
  });

  var masterIds = Object.keys(sessions).filter(function(id) { return sessions[id].roleType === 'master'; });
  if (masterIds.length === 0) {
    // 创建一个 master 节点
    var masterId = Core.generateId();
    sessions[masterId] = { title: '廿廿', messages: [], pinned: true, temperature: 0.7, roleType: 'master', parentId: null, collapsed: false, _manuallyRenamed: true };
    saveSession(masterId);
    masterIds.push(masterId);
  }
  
  var masterId = masterIds[0];
  // 将没有 parentId 或 parentId 无效的会话挂到 master 下
  Object.keys(sessions).forEach(function(id) {
    if (id === masterId) return;
    var pid = sessions[id].parentId;
    // 如果 parentId 为 null、undefined、空字符串，或指向不存在的会话，重置为 master
    if (!pid || !sessions[pid]) {
      sessions[id].parentId = masterId;
      saveSession(id);
    }
  });
  
}

// 🔧 确保默认角色存在（如果没有角色数据，自动创建）
function ensureDefaultRoles() {
  var masterId = null;
  var hasMaster = false, hasCoder = false, hasWriter = false, hasAnalyst = false, hasTeacher = false;
  for (var id in sessions) {
    var rt = sessions[id].roleType;
    if (rt === 'master') { hasMaster = true; masterId = id; }
    else if (rt === 'coder') hasCoder = true;
    else if (rt === 'writer') hasWriter = true;
    else if (rt === 'analyst') hasAnalyst = true;
    else if (rt === 'teacher') hasTeacher = true;
  }
  
  // 🔧 保存当前的 currentSessionId，防止 newChat 覆盖
  var savedCurrentId = currentSessionId;
  
  // 如果没有主管角色，创建一个
  if (!hasMaster) {
    masterId = Core.generateId();
    sessions[masterId] = {
      title: '廿廿', messages: [], pinned: true, temperature: 0.7,
      roleType: 'master', parentId: null, collapsed: false, _manuallyRenamed: true
    };
    saveSession(masterId);
    console.log('✅ 自动创建主管角色: 廿廿');
  }
  
  // 如果没有其他角色，创建它们（挂到主管下）
  if (!hasCoder) { var cid = newChat('coder'); sessions[cid].parentId = masterId; saveSession(cid); }
  if (!hasWriter) { var wid = newChat('writer'); sessions[wid].parentId = masterId; saveSession(wid); }
  if (!hasAnalyst) { var aid = newChat('analyst'); sessions[aid].parentId = masterId; saveSession(aid); }
  if (!hasTeacher) { var tid = newChat('teacher'); sessions[tid].parentId = masterId; saveSession(tid); }
  
  // 🔧 恢复 currentSessionId
  if (savedCurrentId && sessions[savedCurrentId]) {
    currentSessionId = savedCurrentId;
  }
  
  // 重新渲染侧边栏
  renderChatList();
}

// ===== 保存会话 =====
function saveSession(id) {
  const data = sessions[id];
  if (!data) return;
  if (data.pinned === undefined) data.pinned = false;
  if (data.collapsed === undefined) data.collapsed = false;
  if (data.messages && data.messages.length >= 3) {
    data.summary = generateSummary(data.messages);
  }
  
  // 🔧 P0: 保存前排除运行时字段（_apiState, _draft 不应持久化）
  var saveData = JSON.parse(JSON.stringify(data));
  delete saveData._apiState;
  delete saveData._draft;
  
  // 1. 保存到 SQLite（单源化：不再写 JSON）
  try {
    if (Core.db && Core.db.saveSession) {
      const userId = Core._currentUser || 'admin';
      Core.db.saveSession(id, { ...saveData, userId: userId });
    }
  } catch (e) {
    console.warn('⚠️ SQLite 保存会话失败:', e.message);
  }
}

// ===== 生成摘要 =====
function generateSummary(messages) {
  var userMsgs = messages.filter(function(m) { return m.role === 'user'; });
  if (userMsgs.length === 0) return '';
  var latest = userMsgs[userMsgs.length - 1].content;
  return latest.substring(0, 50) + (latest.length > 50 ? '...' : '');
}

// ===== 切换会话 =====
function switchSession(id) {
  if (!sessions[id]) return;
  // A: 保存当前草稿到旧会话
  var oldId = currentSessionId;
  if (oldId && sessions[oldId] && Core && Core.dom && Core.dom.input) {
    var draft = Core.dom.input.value.trim();
    if (draft) sessions[oldId]._draft = draft;
    else delete sessions[oldId]._draft;
    immediateSave(oldId); // D: 切走前立即保存
  }
  currentSessionId = id;
  // 🔧 懒加载消息：首次打开会话时从 DB 加载
  var newSession = sessions[id];
  if (newSession && newSession._messagesLoaded === false && Core.db && Core.db.getSessionMessages) {
    try {
      newSession.messages = Core.db.getSessionMessages(id);
      newSession._messagesLoaded = true;
    } catch (e) {
      console.warn('⚠️ 懒加载消息失败:', e.message);
      newSession.messages = [];
      newSession._messagesLoaded = true;
    }
  }
  // 🔧 清除未读计数
  if (sessions[id]._unreadCount) {
    delete sessions[id]._unreadCount;
    renderChatList();
  }
  // A: 恢复新会话的草稿
  var newSession = sessions[id];
  if (newSession && Core && Core.dom && Core.dom.input) {
    Core.dom.input.value = newSession._draft || '';
  }
  renderMessages(id);
  highlightChatItem(id);
  // 更新输入框温度
  var session = sessions[id];
  if (session && session.temperature !== undefined) {
    var tempSlider = document.getElementById('temperatureSlider');
    var tempDisplay = document.getElementById('tempDisplay');
    if (tempSlider) { tempSlider.value = session.temperature; }
    if (tempDisplay) { tempDisplay.textContent = session.temperature; }
  }
  Core.dom.input.focus();
  
  // 恢复按钮状态：根据当前会话的生成状态
  if (Core && Core.dom) {
    var apiState = session && session._apiState;
    var isGenerating = apiState && apiState.isGenerating;
    if (Core.dom.sendBtn) {
      if (isGenerating) {
        Core.dom.sendBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:20px;vertical-align:middle;">stop</span>';
        Core.dom.sendBtn.style.background = '#ef4444';
        Core.dom.sendBtn.title = '停止生成';
        Core.dom.sendBtn.disabled = false;
      } else {
        Core.dom.sendBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:20px;vertical-align:middle;">arrow_upward</span>';
        Core.dom.sendBtn.style.background = '';
        Core.dom.sendBtn.title = '发送';
        Core.dom.sendBtn.disabled = false;
      }
    }
    if (Core.dom.deepThinkBtn) Core.dom.deepThinkBtn.disabled = isGenerating;
    if (Core.dom.webSearchBtn) Core.dom.webSearchBtn.disabled = isGenerating;
  }
}

// ===== 添加消息 =====
function addMessage(content, role, type) {
  if (!currentSessionId || !sessions[currentSessionId]) return;
  var msg = { role: role, content: content, timestamp: Date.now() };
  if (type) msg.type = type;
  sessions[currentSessionId].messages.push(msg);
  debouncedAutoSave(currentSessionId);
  // 自动压缩：超过阈值时异步触发（配置 autoCompress !== false 开启，5分钟冷却）
  var _sess = sessions[currentSessionId];
  if (_sess.messages.length > COMPRESS_THRESHOLD && Core && Core.config && Core.config.autoCompress !== false) {
    var cooldown = 5 * 60 * 1000;
    if (!_sess._compressedAt || (Date.now() - _sess._compressedAt > cooldown)) {
      var sid = currentSessionId;
      setTimeout(function() { compressLongConversation(sid); }, 2000);
    }
  }
  var container = document.getElementById('chatContainer');
  if (container) {
    renderSingleMessage(msg, sessions[currentSessionId].messages.length - 1, container);
    scrollToBottom();
  }
}

// 🔧 给非当前会话添加未读消息（由外部调用）
var _unreadRenderTimer = null;
function addUnreadToSession(sessionId) {
  if (!sessionId || !sessions[sessionId]) return;
  if (sessionId === currentSessionId) return;
  if (!sessions[sessionId]._unreadCount) sessions[sessionId]._unreadCount = 0;
  sessions[sessionId]._unreadCount++;
  // 防抖 500ms：合并多次未读消息后再刷新侧边栏，避免密集 DOM 重建
  if (_unreadRenderTimer) clearTimeout(_unreadRenderTimer);
  _unreadRenderTimer = setTimeout(function() {
    _unreadRenderTimer = null;
    renderChatList();
  }, 500);
}

// ===== 自动更新标题（LLM 增强版）=====
function autoTitle(sessionId) {
  if (!sessions[sessionId]) return;
  var session = sessions[sessionId];
  if (session._manuallyRenamed) return;
  var firstUser = session.messages.find(function(m) { return m.role === 'user'; });
  if (!firstUser) return;

  // 即时回退：截取前 20 字
  var fallbackTitle = firstUser.content.substring(0, 20) + (firstUser.content.length > 20 ? '...' : '');
  session.title = fallbackTitle;
  saveSession(sessionId);
  renderChatList();

  // 异步 LLM 生成更精准的标题
  if (Core && Core.api && Core.api.callAPI && session.messages.length >= 2) {
    var context = session.messages.slice(0, 4).map(function(m) {
      return (m.role === 'user' ? '用户: ' : 'AI: ') + (m.content || '').substring(0, 150);
    }).join('\n');

    Core.api.callAPI(
      context,
      '为以下对话生成一个简短标题（不超过12个字，中文），只输出标题文本，不要引号和标点。',
      0.3, null, null,
      [{ role: 'system', content: '为以下对话生成一个简短标题（不超过12个字，中文），只输出标题文本，不要引号和标点。' }, { role: 'user', content: context }],
      { disableTools: true }
    ).then(function(result) {
      if (result && result.message && result.message.content) {
        var llmTitle = result.message.content.trim().replace(/^["'《]|["'》]$/g, '').substring(0, 15);
        if (llmTitle && llmTitle.length >= 2 && !sessions[sessionId]._manuallyRenamed) {
          sessions[sessionId].title = llmTitle;
          saveSession(sessionId);
          renderChatList();
        }
      }
    }).catch(function() {});
  }
}

// ===== 长对话摘要压缩（消息数超阈值时，将旧消息压缩为摘要）=====
var COMPRESS_THRESHOLD = 60; // 超过此数量触发压缩
var KEEP_RECENT = 20;        // 保留最近 N 条不压缩

async function compressLongConversation(sessionId) {
  if (!sessions[sessionId]) return { success: false, error: '会话不存在' };
  var session = sessions[sessionId];
  if (session.messages.length <= COMPRESS_THRESHOLD) {
    return { success: false, error: '消息数未达压缩阈值 (' + session.messages.length + '/' + COMPRESS_THRESHOLD + ')' };
  }
  if (!Core || !Core.api || !Core.api.callAPI) {
    return { success: false, error: 'API 不可用' };
  }

  try {
    // 取旧消息（保留最近 KEEP_RECENT 条）
    var oldMessages = session.messages.slice(0, session.messages.length - KEEP_RECENT);
    var recentMessages = session.messages.slice(session.messages.length - KEEP_RECENT);

    // 构建摘要请求
    var oldText = oldMessages.map(function(m) {
      return (m.role === 'user' ? '用户: ' : 'AI: ') + (m.content || '').substring(0, 300);
    }).join('\n');

    var result = await Core.api.callAPI(
      oldText.substring(0, 6000),
      '将以下对话历史压缩为一段简洁的摘要（200字以内），保留关键信息、决定和上下文。只输出摘要。',
      0.3, null, null,
      [{ role: 'system', content: '将以下对话历史压缩为一段简洁的摘要（200字以内），保留关键信息、决定和上下文。只输出摘要。' }, { role: 'user', content: oldText.substring(0, 6000) }],
      { disableTools: true }
    );

    if (result && result.message && result.message.content) {
      var summary = result.message.content.trim();
      // 替换旧消息为一条摘要消息
      session.messages = [{ role: 'system', content: '[对话摘要] ' + summary, timestamp: Date.now(), _isSummary: true }].concat(recentMessages);
      session._compressedAt = Date.now();
      session._originalCount = oldMessages.length + recentMessages.length;
      saveSession(sessionId);
      renderMessages(sessionId);
      console.log('📦 会话已压缩: ' + oldMessages.length + ' 条旧消息 → 1 条摘要');
      return { success: true, compressed: oldMessages.length, kept: recentMessages.length };
    }
    return { success: false, error: 'LLM 未返回摘要' };
  } catch (e) {
    return { success: false, error: '压缩失败: ' + e.message };
  }
}

// ===== 重命名会话 =====
function renameSession(id, newTitle) {
  if (!sessions[id]) {
    console.warn('⚠️ 会话不存在，尝试重新加载:', id);
    loadSessions();
  }
  if (!sessions[id]) {
    console.error('❌ 无法获取会话ID', id, 'sessions 键:', Object.keys(sessions));
    return;
  }
  sessions[id].title = newTitle.trim();
  sessions[id]._manuallyRenamed = true;
  if (newTitle.indexOf('廿廿') >= 0 || newTitle.indexOf('主管') >= 0) {
    sessions[id].roleType = 'master';
    console.log('👑 已设置为主管模式');
  }
  saveSession(id);
  renderChatList();
  if (id === currentSessionId) document.title = newTitle;
  console.log('✅ 会话已重命名为:', newTitle);
}

// ===== 级联删除 =====
function deleteSessionWithChildren(id) {
  try {
    var childrenIds = getChildrenIds(id);
    for (var i = 0; i < childrenIds.length; i++) { deleteSessionWithChildren(childrenIds[i]); }
    delete sessions[id];
    
    // 🔧 从 SQLite 删除（loadSessions 优先从 SQLite 加载，不删 DB 行会导致删除的会话重启后重新出现）
    if (Core.db && Core.db.deleteSession) {
      try { Core.db.deleteSession(id); } catch(e) { console.warn('⚠️ SQLite 删除会话失败:', e.message); }
    }
    
    // 🔧 从所有可能的目录删除 JSON 文件（动态计算路径）
    var deleted = false;
    var globalRoot = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || process.env.AI_AGENT_DATA_ROOT || 'E:\\my-ai-data';
    var possibleDirs = [
      getSessionsDir(),
      path.join(globalRoot, 'sessions'),
      path.join(globalRoot, 'users', 'admin', 'sessions')
    ];
    
    for (var j = 0; j < possibleDirs.length; j++) {
      var filePath = path.join(possibleDirs[j], id + '.json');
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted = true;
      }
    }
  } catch (err) { console.error('❌ 删除会话失败:', err.message); }
  var ids = Object.keys(sessions).filter(function(k) { return !sessions[k].parentId; });
  if (ids.length > 0) { currentSessionId = ids[0]; renderMessages(currentSessionId); highlightChatItem(currentSessionId); }
  else { newChat('chat', null); }
  renderChatList();
}

// ===== 新建会话 =====
function newChat(roleType, parentId) {
  var id = Core.generateId();
  var defaultTemp = (Core && Core.config && Core.config.temperature !== undefined) ? Core.config.temperature : 0.7;
  var title = '新对话';
  if (roleType === 'master') title = '主管模式';
  else if (roleType === 'coder') title = '代码大师';
  else if (roleType === 'writer') title = '创意写手';
  else if (roleType === 'analyst') title = '数据分析师';
  else if (roleType === 'teacher') title = '学习导师';
  // 没有指定 parentId 时，自动挂到 master 节点下（避免成为根节点排到列表最底部）
  if (!parentId && roleType !== 'master') {
    var masterIds = Object.keys(sessions).filter(function(sid) { return sessions[sid].roleType === 'master'; });
    if (masterIds.length > 0) parentId = masterIds[0];
  }
  sessions[id] = {
    title: title, messages: [], pinned: false, temperature: defaultTemp,
    roleType: roleType || 'chat', parentId: parentId || null, collapsed: false, _manuallyRenamed: false,
    timestamp: Date.now()
  };
  immediateSave(id);
  currentSessionId = id;
  if (Core && Core.dom && Core.dom.input) Core.dom.input.value = '';
  var tempSlider = document.getElementById('temperatureSlider');
  var tempDisplay = document.getElementById('tempDisplay');
  if (tempSlider) { tempSlider.value = defaultTemp; if (tempDisplay) tempDisplay.textContent = defaultTemp; }
  renderChatList();
  renderMessages(id);
  highlightChatItem(id);
  Core.dom.input.focus();
  return id;
}

// 🔧 添加二级角色对话框
function showAddRoleDialog(parentId) {
  var choice = prompt('请选择要添加的二级角色：\n1. 💻 代码大师\n2. ✍️ 创意写手\n3. 📊 数据分析师\n4. 🎓 学习导师\n\n输入数字 1-4：');
  if (choice === '1') newChat('coder', parentId);
  else if (choice === '2') newChat('writer', parentId);
  else if (choice === '3') newChat('analyst', parentId);
  else if (choice === '4') newChat('teacher', parentId);
}

// ===== 重新加载会话 =====
function reloadSessions() {
  loadSessions();
  renderChatList();
  if (currentSessionId && sessions[currentSessionId]) {
    renderMessages(currentSessionId);
  }
}

// ===== 清除所有会话 =====
function clearSessions() {
  if (!confirm('确定要清除所有会话吗？此操作不可恢复！')) return;
  
  // 删除所有会话文件
  var dir = getSessionsDir();
  try {
    var files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (var i = 0; i < files.length; i++) {
      fs.unlinkSync(path.join(dir, files[i]));
    }
  } catch (e) {
    console.error('❌ 清除会话文件失败:', e.message);
  }
  
  sessions = {};
  currentSessionId = null;
  renderChatList();
  var container = document.getElementById('chatContainer');
  if (container) container.innerHTML = '';
}

// ===== 置顶/取消置顶 =====
function togglePinSession(id) {
  if (!sessions[id]) return;
  sessions[id].pinned = !sessions[id].pinned;
  saveSession(id);
  renderChatList();
}

// ===== 模块初始化 =====
function init(core) {
  Core = core;
  
  // 使用固定路径
  sessionsDir = getSessionsDir();
  
  loadSessions();
  
  // 🔧 加载后渲染当前会话的消息和侧边栏
  if (currentSessionId && sessions[currentSessionId]) {
    renderMessages(currentSessionId);
    highlightChatItem(currentSessionId);
  }
  renderChatList();

  // 🔧 事件委托：chatList 上统一处理所有树节点/扁平节点的交互事件
  (function initChatListDelegation() {
    var chatList = document.getElementById('chatList');
    if (!chatList) return;

    // 单击：切换会话 / 折叠按钮 / 添加子会话 / 删除会话
    chatList.addEventListener('click', function(e) {
      var foldBtn = e.target.closest('.fold-btn');
      if (foldBtn) {
        e.stopPropagation();
        var chatItem = foldBtn.closest('.chat-item');
        if (!chatItem) return;
        var sess = sessions[chatItem.dataset.id];
        if (sess) {
          sess.collapsed = !sess.collapsed;
          foldBtn.setAttribute('aria-expanded', sess.collapsed ? 'false' : 'true');
          foldBtn.textContent = sess.collapsed ? '\u25b6' : '\u25bc';
          saveSession(chatItem.dataset.id);
          // 🔧 直接 DOM 动画代替完整 renderChatList()
          // children-container 是 chat-item 的兄弟节点（在 chat-node 内），不是子节点
          var cc = chatItem.nextElementSibling;
          if (cc && cc.classList.contains('children-container')) {
            if (sess.collapsed) {
              cc.style.maxHeight = cc.scrollHeight + 'px';
              cc.offsetHeight; // 强制重排
              cc.classList.add('collapsed');
              cc.style.maxHeight = '0px';
              cc.addEventListener('transitionend', function handler(ev) {
                if (ev.propertyName === 'max-height') {
                  cc.removeEventListener('transitionend', handler);
                }
              });
            } else {
              cc.classList.remove('collapsed');
              cc.style.maxHeight = cc.scrollHeight + 'px';
              cc.addEventListener('transitionend', function handler(ev) {
                if (ev.propertyName === 'max-height') {
                  cc.style.maxHeight = '';
                  cc.removeEventListener('transitionend', handler);
                  // 展开时：清除所有子级 children-container 的残留 maxHeight
                  var innerCCs = cc.querySelectorAll('.children-container');
                  for (var k = 0; k < innerCCs.length; k++) {
                    innerCCs[k].style.maxHeight = '';
                    innerCCs[k].classList.remove('collapsed');
                  }
                  // 同步更新子级折叠按钮
                  var innerFoldBtns = cc.querySelectorAll('.fold-btn');
                  for (var f = 0; f < innerFoldBtns.length; f++) {
                    var innerItem = innerFoldBtns[f].closest('.chat-item');
                    if (innerItem) {
                      var innerSess = sessions[innerItem.dataset.id];
                      if (innerSess) {
                        innerSess.collapsed = false;
                        innerFoldBtns[f].textContent = '\u25bc';
                      }
                    }
                  }
                }
              });
            }
          }
          foldBtn.textContent = sess.collapsed ? '▶' : '▼';
        }
        return;
      }
      var addBtn = e.target.closest('.add-btn');
      if (addBtn) {
        e.stopPropagation();
        var chatItem2 = addBtn.closest('.chat-item');
        if (chatItem2) newChat('chat', chatItem2.dataset.id);
        return;
      }
      var delBtn = e.target.closest('.del-btn');
      if (delBtn) {
        e.stopPropagation();
        var chatItem3 = delBtn.closest('.chat-item');
        if (!chatItem3) return;
        var sess3 = sessions[chatItem3.dataset.id];
        var isRole = sess3 && (sess3.roleType === 'master' || sess3.roleType === 'coder' || sess3.roleType === 'writer' || sess3.roleType === 'analyst' || sess3.roleType === 'teacher');
        if (confirm('确定要删除这个会话' + (isRole ? '及其所有子对话' : '') + '吗？')) {
          deleteSessionWithChildren(chatItem3.dataset.id);
        }
        return;
      }
      var chatItem4 = e.target.closest('.chat-item');
      if (chatItem4 && chatItem4.dataset.id) {
        switchSession(chatItem4.dataset.id);
      }
    });

    // 双击：重命名会话
    chatList.addEventListener('dblclick', function(e) {
      var chatItem = e.target.closest('.chat-item');
      if (!chatItem || !chatItem.dataset.id) return;
      if (e.target.closest('.fold-btn, .add-btn, .del-btn')) return;
      e.stopPropagation();
      var sess = sessions[chatItem.dataset.id];
      if (!sess) return;
      if (typeof window.showCustomPrompt === 'function') {
        window.showCustomPrompt('✏️ 重命名会话', sess.title || '未命名', function(newTitle) {
          if (newTitle && newTitle.trim() && newTitle.trim() !== sess.title) {
            renameSession(chatItem.dataset.id, newTitle.trim());
          }
        });
      } else {
        try {
          var { dialog } = require('electron').remote;
          dialog.showInputBox({ title: '重命名会话', defaultValue: sess.title || '未命名' }).then(function(result) {
            if (result && result.trim() && result.trim() !== sess.title) {
              renameSession(chatItem.dataset.id, result.trim());
            }
          });
        } catch (err) {
          console.error('❌ 重命名对话框不可用:', err.message);
        }
      }
    });

  // ===== 侧边栏键盘导航 =====
  chatList.addEventListener('keydown', function(e) {
    var items = chatList.querySelectorAll('.chat-item');
    if (items.length === 0) return;
    var current = document.activeElement;
    var idx = Array.from(items).indexOf(current);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      var next = idx < items.length - 1 ? idx + 1 : 0;
      items[next].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      var prev = idx > 0 ? idx - 1 : items.length - 1;
      items[prev].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (current && current.classList.contains('chat-item')) {
        current.click();
      }
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (current && current.classList.contains('chat-item') && current.dataset.id) {
        if (confirm('确定删除这个会话？')) {
          if (Core.session && Core.session.deleteSession) {
            Core.session.deleteSession(current.dataset.id);
          }
        }
      }
    }
  });

    console.log('✅ chatList 事件委托已初始化');
  })();

  // 🔧 chatContainer 事件委托：快速操作按钮 + 代码块按钮
  (function initChatContainerDelegation() {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    chatContainer.addEventListener('click', function(e) {
      // 快速操作按钮（继续/总结/翻译/解释/举例）
      var qaBtn = e.target.closest('.quick-action-btn');
      if (qaBtn) {
        e.stopPropagation();
        // 朗读按钮 — 使用语音模块朗读该条消息
        if (qaBtn.dataset.action === 'tts') {
          var aiMsg = qaBtn.closest('.msg.ai');
          if (!aiMsg) return;

          // 如果正在生成中，点击取消
          if (qaBtn.dataset.loading === 'true') {
            if (window.voice && window.voice.cancelSpeak) {
              window.voice.cancelSpeak();
            }
            qaBtn.innerHTML = '<span class="material-icons-outlined">volume_up</span>朗读';
            qaBtn.dataset.loading = '';
            qaBtn.style.opacity = '';
            return;
          }

          // 停止正在进行的朗读
          if (window.voice && window.voice.isSpeaking && window.voice.isSpeaking()) {
            window.voice.stopSpeaking();
            // 恢复按钮状态
            qaBtn.innerHTML = '<span class="material-icons-outlined">volume_up</span>朗读';
            qaBtn.dataset.loading = '';
            qaBtn.style.opacity = '';
            return;
          }
          if (window.speechSynthesis && window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
            return;
          }
          // 提取纯文本（排除时间戳、操作按钮、执行追踪面板、思考过程、代码块等）
          // Agent 消息优先取 .agent-content（最终回答），避免朗读执行追踪中的英文参数/结果
          var contentSource = aiMsg.querySelector('.agent-content') || aiMsg;
          var contentClone = contentSource.cloneNode(true);
          var toRemove = contentClone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .msg-actions, .quick-actions, .msg-hover-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .agent-think-panel, .agent-steps-live, .agent-status-row, .thinking-process, pre');
          toRemove.forEach(function(el) { el.remove(); });
          var text = contentClone.textContent.replace(/\s+/g, ' ').trim();
          if (text.length > 2000) text = text.substring(0, 2000) + '...';
          if (!text) return;

          // 显示加载状态（可点击取消）
          qaBtn.innerHTML = '<span class="material-icons-outlined" style="animation:spin 1s linear infinite">autorenew</span>点击取消';
          qaBtn.dataset.loading = 'true';
          qaBtn.style.opacity = '0.7';
          qaBtn.title = '点击取消朗读';

          var resetBtn = function() {
            qaBtn.innerHTML = '<span class="material-icons-outlined">volume_up</span>朗读';
            qaBtn.dataset.loading = '';
            qaBtn.style.opacity = '';
            qaBtn.title = '';
          };

          if (window.voice && window.voice.speak) {
            window.voice.speak(text).then(function() {
              resetBtn();
            }).catch(function(err) {
              // 如果是用户主动取消，不显示错误
              if (err.name === 'AbortError') {
                resetBtn();
                return;
              }
              console.warn('朗读失败:', err.message);
              qaBtn.innerHTML = '<span class="material-icons-outlined">error_outline</span>失败';
              setTimeout(resetBtn, 3000);
            });
          } else if (window.speechSynthesis) {
            var utter = new SpeechSynthesisUtterance(text);
            utter.lang = 'zh-CN';
            utter.onend = resetBtn;
            utter.onerror = resetBtn;
            window.speechSynthesis.speak(utter);
          } else {
            resetBtn();
          }
          return;
        }
        // 提示词按钮 — 发送预设提示词
        if (qaBtn.dataset.prompt) {
          if (Core.dom && Core.dom.input) {
            Core.dom.input.value = qaBtn.dataset.prompt;
            if (Core.api && Core.api.sendMessage) Core.api.sendMessage();
          }
          return;
        }
      }

      // 代码复制按钮
      var copyBtn = e.target.closest('.code-btn');
      if (copyBtn) {
        var codeBlock = copyBtn.closest('pre');
        if (!codeBlock) return;
        var codeEl = codeBlock.querySelector('code');
        if (!codeEl) return;
        if (copyBtn.textContent.indexOf('复制') >= 0) {
          navigator.clipboard.writeText(codeEl.textContent).then(function() {
            copyBtn.textContent = '✅ 已复制';
            setTimeout(function() { copyBtn.textContent = '📋 复制'; }, 2000);
          });
        }
        return;
      }
    });

    console.log('✅ chatContainer 事件委托已初始化');
  })();

  // configChanged 由 theme.js 防抖处理器统一触发 renderMessages，此处不再重复监听
  
  // 绑定事件
  if (Core.dom && Core.dom.newChatBtn) {
    Core.dom.newChatBtn.addEventListener('click', function() { newChat('chat', null); });
  }
  
  if (Core.dom && Core.dom.input) {
    Core.dom.input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (Core.api && Core.api.sendMessage) Core.api.sendMessage();
      }
    });
  }
  
  // 绑定搜索过滤
  var searchInput = document.getElementById('chatSearch');
  var clearBtn = document.getElementById('clearSearch');
  var searchResultsPanel = document.getElementById('searchResultsPanel');
  var searchResultsList = document.getElementById('searchResultsList');
  var closeSearchResults = document.getElementById('closeSearchResults');
  
  function performGlobalSearch(query) {
    chatListFilter = query.toLowerCase();
    
    // 更新清除按钮
    if (clearBtn) clearBtn.style.display = chatListFilter ? 'block' : 'none';
    
    // 渲染会话列表（现有的过滤逻辑）
    renderChatList();
    
    // 🔧 全局搜索：在搜索结果面板中显示匹配的消息
    if (searchResultsPanel && searchResultsList) {
      if (!chatListFilter) {
        searchResultsPanel.classList.remove('active');
        searchResultsList.innerHTML = '';
        return;
      }
      
      var allResults = [];
      var lq = chatListFilter;
      
      // 遍历所有会话搜索消息内容
      Object.keys(sessions).forEach(function(sid) {
        var sess = sessions[sid];
        if (!sess || !sess.messages) return;
        
        for (var i = 0; i < sess.messages.length; i++) {
          var msg = sess.messages[i];
          if (msg.content && msg.content.toLowerCase().indexOf(lq) !== -1) {
            // 提取匹配上下文
            var content = msg.content;
            var lc = content.toLowerCase();
            var idx = lc.indexOf(lq);
            var start = Math.max(0, idx - 30);
            var end = Math.min(content.length, idx + lq.length + 30);
            var prefix = start > 0 ? '...' : '';
            var suffix = end < content.length ? '...' : '';
            var snippet = prefix + content.substring(start, end) + suffix;
            
            allResults.push({
              sessionId: sid,
              sessionTitle: sess.title || '未命名',
              msgIndex: i,
              role: msg.role,
              snippet: snippet,
              query: lq
            });
          }
        }
      });
      
      // 限制结果数量
      allResults = allResults.slice(0, 50);
      
      // 渲染结果
      searchResultsList.innerHTML = '';
      if (allResults.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'search-result-empty';
        empty.textContent = '未找到匹配的消息';
        searchResultsList.appendChild(empty);
      } else {
        allResults.forEach(function(result) {
          var item = document.createElement('div');
          item.className = 'search-result-item';
          
          var roleLabel = result.role === 'user' ? '【用户】' : '【AI】';
          
          // 高亮匹配词
          var highlightedSnippet = result.snippet.replace(
            new RegExp('(' + escapeRegExp(result.query) + ')', 'gi'),
            '<span class="match">$1</span>'
          );
          
          item.innerHTML = '<div class="result-session-title">' + escapeHtml(result.sessionTitle) + '</div>' +
            '<div><span class="result-role">' + roleLabel + '</span><span class="result-snippet">' + highlightedSnippet + '</span></div>';
          
          item.addEventListener('click', function() {
            // 切换到对应会话
            switchSession(result.sessionId);
            // 高亮对应消息（在消息渲染完成后）
            setTimeout(function() {
              highlightMessageByIndex(result.msgIndex);
            }, 300);
            // 关闭搜索面板
            if (searchResultsPanel) searchResultsPanel.classList.remove('active');
          });
          
          searchResultsList.appendChild(item);
        });
      }
      
      searchResultsPanel.classList.add('active');
    }
  }
  
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  var escapeHtml = _htmlUtils.escapeHtml;

  function highlightMessageByIndex(msgIndex) {
    var container = document.getElementById('chatContainer');
    if (!container) return;
    
    // 使用 data-msg-index 查找精确消息（兼容虚拟滚动）
    var targetMsg = container.querySelector('.msg[data-msg-index="' + msgIndex + '"]');
    
    // 如果未找到，可能是虚拟滚动截断了，重新渲染包含该消息
    if (!targetMsg) {
      var session = sessions[currentSessionId];
      if (session && session._renderMeta && session._renderMeta.startIndex > msgIndex) {
        renderMessages(currentSessionId, msgIndex);
        // 重新查找
        targetMsg = container.querySelector('.msg[data-msg-index="' + msgIndex + '"]');
      }
    }
    
    if (targetMsg) {
      targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetMsg.style.transition = 'box-shadow 0.3s';
      targetMsg.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.5)';
      setTimeout(function() {
        targetMsg.style.boxShadow = '';
      }, 3000);
    } else {
      console.warn('⚠️ 未找到消息索引:', msgIndex);
    }
  }
  
  if (searchInput) {
    var _searchDebounce = null;
    searchInput.addEventListener('input', function(e) {
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(function() {
        _searchDebounce = null;
        performGlobalSearch(e.target.value.trim());
      }, 200);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      chatListFilter = '';
      if (searchInput) searchInput.value = '';
      clearBtn.style.display = 'none';
      if (searchResultsPanel) searchResultsPanel.classList.remove('active');
      if (searchResultsList) searchResultsList.innerHTML = '';
      renderChatList();
    });
  }
  if (closeSearchResults) {
    closeSearchResults.addEventListener('click', function() {
      if (searchResultsPanel) searchResultsPanel.classList.remove('active');
    });
  }
  
  // 🔧 P4: 绑定日期筛选按钮
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      chatListDateFilter = btn.dataset.filter || 'all';
      renderChatList();
    });
  });
  
    // 导出 API
  Core.session = {
    getCurrentId: function() { return currentSessionId; },
    setCurrentId: function(id) { currentSessionId = id; },
    addMessage: addMessage,
    addUnreadToSession: addUnreadToSession,
    switchSession: switchSession,
    newChat: newChat,
    sessions: sessions,
    renderMessages: renderMessages,
    renderSingleMessage: renderSingleMessage,
    renderChatList: renderChatList,
    highlightChatItem: highlightChatItem,
    saveSession: saveSession,
    deleteSession: deleteSessionWithChildren,
    renameSession: renameSession,
    togglePinSession: togglePinSession,
    clear: clearSessions,
    reload: reloadSessions,
    compress: compressLongConversation,
    // 🔧 获取会话列表（按置顶和时间排序）
    getSessionList: function() {
      var rootIds = Object.keys(sessions).filter(function(id) { return !sessions[id].parentId; });
      rootIds.sort(function(a, b) {
        var aPinned = sessions[a].pinned ? 1 : 0;
        var bPinned = sessions[b].pinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        var aTime = sessions[a].timestamp || 0;
        var bTime = sessions[b].timestamp || 0;
        return bTime - aTime;
      });
      return rootIds.map(function(id) {
        return { id: id, title: sessions[id].title || '未命名会话' };
      });
    },
    // 🔧 兼容性：提供 loadSessionsForService 函数
    loadSessionsForService: function(service) { return sessions; }
  };

  console.log('✅ session.js 初始化完成');
}

module.exports = { name: 'session', dependencies: ['database', 'html-utils'], init: init };