// modules/session.js (树形层级架构版 - 20250628)
const fs = require('fs');
const path = require('path');
var _htmlUtils = require('./html-utils');

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
      return a.localeCompare(b);
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
    sessions[masterId] = { title: '👑 廿廿', messages: [], pinned: true, temperature: 0.7, roleType: 'master', parentId: null, collapsed: false, _manuallyRenamed: true };
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
      title: '👑 廿廿', messages: [], pinned: true, temperature: 0.7,
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
  
  // 1. 保存到 SQLite
  try {
    if (Core.db && Core.db.saveSession) {
      const userId = Core._currentUser || 'admin';
      Core.db.saveSession(id, { ...saveData, userId: userId });
    }
  } catch (e) {
    console.warn('⚠️ SQLite 保存会话失败:', e.message);
  }
  
  // 2. 同时保存到 JSON 作为备份
  try {
    const dir = getSessionsDir();
    fs.writeFile(path.join(dir, id + '.json'), JSON.stringify(saveData, null, 2), function(err) {
      if (err) console.error('❌ JSON 保存会话失败 [' + id + ']:', err.message);
    });
  } catch (e) {
    console.error('❌ JSON 保存会话失败:', e.message);
  }
}

// ===== 生成摘要 =====
function generateSummary(messages) {
  var userMsgs = messages.filter(function(m) { return m.role === 'user'; });
  if (userMsgs.length === 0) return '';
  var latest = userMsgs[userMsgs.length - 1].content;
  return latest.substring(0, 50) + (latest.length > 50 ? '...' : '');
}

// ===== 渲染侧边栏（树形层级） =====
// 🔧 P4: 辅助函数 - 获取会话最后活动时间
function getSessionDate(session) {
  if (!session) return null;
  if (session.messages && session.messages.length > 0) {
    var lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg.timestamp) return new Date(lastMsg.timestamp);
  }
  if (session.updatedAt) return new Date(session.updatedAt);
  if (session.createdAt) return new Date(session.createdAt);
  return null;
}

// 🔧 P4: 辅助函数 - 检查会话是否匹配筛选条件
function matchesFilter(session) {
  if (!session) return false;
  
  // 文本搜索
  if (chatListFilter) {
    var titleMatch = session.title && session.title.toLowerCase().indexOf(chatListFilter) !== -1;
    var contentMatch = false;
    if (session.messages) {
      for (var i = 0; i < session.messages.length; i++) {
        if (session.messages[i].content && session.messages[i].content.toLowerCase().indexOf(chatListFilter) !== -1) {
          contentMatch = true;
          break;
        }
      }
    }
    if (!titleMatch && !contentMatch) return false;
  }
  
  // 日期筛选
  if (chatListDateFilter !== 'all') {
    var sessionDate = getSessionDate(session);
    if (!sessionDate) return false;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    var weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    if (chatListDateFilter === 'today') {
      if (sessionDate < today) return false;
    } else if (chatListDateFilter === 'yesterday') {
      if (sessionDate < yesterday || sessionDate >= today) return false;
    } else if (chatListDateFilter === 'week') {
      if (sessionDate < weekAgo) return false;
    }
  }
  
  return true;
}

function renderChatList() {
  var chatList = document.getElementById('chatList');
  if (!chatList) return;
  // 使用 DocumentFragment 原子化渲染，避免 innerHTML='' 造成的空白闪烁
  var fragment = document.createDocumentFragment();

  var hasFilter = chatListFilter || chatListDateFilter !== 'all';

  if (hasFilter) {
    // 🔧 P4: 有筛选条件时，扁平化显示匹配的节点
    var matchedIds = Object.keys(sessions).filter(function(id) {
      return matchesFilter(sessions[id]);
    });


    if (matchedIds.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'padding:20px;text-align:center;color:#999;';
      emptyDiv.textContent = '没有找到匹配的会话';
      fragment.appendChild(emptyDiv);
    } else {
      matchedIds.forEach(function(id) {
        renderFlatNode(id, fragment);
      });
    }
  } else {
    // 🔧 无筛选时，正常树形渲染（置顶会话排在前面）
    var rootIds = Object.keys(sessions).filter(function(id) { return !sessions[id].parentId; });

    // 置顶会话排在最前面，然后按时间排序
    rootIds.sort(function(a, b) {
      var aPinned = sessions[a].pinned ? 1 : 0;
      var bPinned = sessions[b].pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      var aTime = sessions[a].timestamp || 0;
      var bTime = sessions[b].timestamp || 0;
      return bTime - aTime;
    });


    rootIds.forEach(function(id) {
      renderTreeNode(id, fragment, 0);
    });

    if (rootIds.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'padding:20px;text-align:center;color:#999;';
      emptyDiv.textContent = '暂无对话';
      fragment.appendChild(emptyDiv);
    }
  }

  // 原子化替换：一次 DOM 操作，避免先清空再重建的闪烁
  chatList.replaceChildren(fragment);

  updateChatCountDisplay();
  highlightChatItem(currentSessionId);
}

// 🔧 P4: 扁平化渲染节点（用于筛选结果）
function renderFlatNode(id, container) {
  var session = sessions[id];
  if (!session) return;
  
  var item = document.createElement('div');
  item.className = 'chat-item' + (id === currentSessionId ? ' active' : '');
  item.dataset.id = id;
  item.setAttribute('tabindex', '0');
  item.setAttribute('role', 'treeitem');
  if (id === currentSessionId) item.setAttribute('aria-selected', 'true');
  
  // emoji
  var emojiMap = { 'master': '👑', 'coder': '💻', 'writer': '✍️', 'analyst': '📊', 'teacher': '🎓', 'chat': '💬' };
  var emoji = emojiMap[session.roleType] || '💬';
  
  // 最后消息预览
  var lastMsgPreview = '';
  if (session.messages && session.messages.length > 0) {
    var lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg.content) {
      lastMsgPreview = lastMsg.content.substring(0, 30) + (lastMsg.content.length > 30 ? '...' : '');
    }
  }
  
  // 时间
  var timeStr = '';
  var sessionDate = getSessionDate(session);
  if (sessionDate) {
    timeStr = sessionDate.toLocaleDateString() + ' ' + sessionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  }
  
  item.innerHTML = '<span style="margin-right:6px;">' + emoji + '</span>' +
    '<div style="flex:1;overflow:hidden;">' +
    '<div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (session.title || '未命名') + '</div>' +
    '<div style="font-size:11px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + lastMsgPreview + '</div>' +
    '</div>' +
    '<span style="font-size:11px;color:#6b7280;flex-shrink:0;margin-left:6px;">' + timeStr + '</span>';
  // 🔧 click 由 chatList 事件委托处理
  container.appendChild(item);
}


// ===== 渲染树节点（递归） =====
function renderTreeNode(id, container, level) {
  var session = sessions[id];
  if (!session) return;
  
  var nodeDiv = document.createElement('div');
  nodeDiv.className = 'chat-node';
  nodeDiv.style.marginLeft = (level * 20) + 'px';
  
  var isRole = (session.roleType === 'master' || session.roleType === 'coder' || session.roleType === 'writer' || session.roleType === 'analyst' || session.roleType === 'teacher');
  var isMaster = (session.roleType === 'master');
  
  // 创建头部
  var header = document.createElement('div');
  header.className = 'chat-item';
  header.dataset.id = id;  // 🔧 关键：设置 data-id，供右键菜单获取
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'treeitem');
  if (id === currentSessionId) {
    header.classList.add('active');
    header.setAttribute('aria-selected', 'true');
  }
  
  // 角色标签样式
  if (isMaster) header.classList.add('master-role');
  else if (isRole) header.classList.add('role-role');
  else header.classList.add('chat-role');
  
  // 折叠按钮（只对角色显示）
  if (isRole && !isMaster) {
    var foldBtn = document.createElement('span');
    foldBtn.className = 'fold-btn';
    foldBtn.setAttribute('role', 'button');
    foldBtn.setAttribute('aria-expanded', session.collapsed ? 'false' : 'true');
    foldBtn.setAttribute('tabindex', '0');
    foldBtn.textContent = session.collapsed ? '\u25b6' : '\u25bc';
    foldBtn.style.cssText = 'cursor:pointer; width:16px; display:inline-block; text-align:center;';
    header.appendChild(foldBtn);
  }
  
  // 🔧 未读消息红点
  if (session._unreadCount && session._unreadCount > 0) {
    var badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = session._unreadCount > 99 ? '99+' : session._unreadCount;
    badge.style.cssText = 'margin-left:4px;padding:1px 6px;font-size:10px;font-weight:600;color:#fff;background:#ef4444;border-radius:10px;min-width:16px;text-align:center;flex-shrink:0;';
    header.appendChild(badge);
  }

  // 🔧 Phase 2-5：后台任务运行中指示器（旋转动画）
  if (Core && Core.api && Core.api.getBackgroundTasks) {
    var bgTasks = Core.api.getBackgroundTasks();
    var hasRunningTask = bgTasks.some(function(t) { return t.sessionId === id && t.status === 'running'; });
    if (hasRunningTask) {
      var runningIndicator = document.createElement('span');
      runningIndicator.className = 'bg-task-indicator';
      runningIndicator.title = '后台任务运行中...';
      runningIndicator.style.cssText = 'margin-left:4px;font-size:12px;flex-shrink:0;animation:spin 1s linear infinite;display:inline-block;';
      runningIndicator.textContent = '⚙';
      header.appendChild(runningIndicator);
    }
  }
  
  // 标题
  var titleSpan = document.createElement('span');
  titleSpan.className = 'chat-title';
  titleSpan.textContent = session.title || '未命名';
  titleSpan.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  header.appendChild(titleSpan);
  
  // 按钮容器（使用 CSS class，hover 由 .chat-item:hover .item-actions 处理）
  var btnContainer = document.createElement('div');
  btnContainer.className = 'item-actions';
  
  // 添加按钮
  var addBtn = document.createElement('span');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+';
  addBtn.title = (level === 0 && session.roleType === 'master') ? '添加新对话' : '添加新对话';
  addBtn.style.cssText = 'cursor:pointer; width:20px; height:20px; border-radius:50%; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold;';
  btnContainer.appendChild(addBtn);
  
  // 删除按钮
  var delBtn = document.createElement('span');
  delBtn.className = 'del-btn';
  delBtn.textContent = '×';
  delBtn.title = '删除';
  delBtn.style.cssText = 'cursor:pointer; width:20px; height:20px; border-radius:50%; background:#ff4444; color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold;';
  btnContainer.appendChild(delBtn);
  
  header.appendChild(btnContainer);
  // 🔧 事件由 chatList 委托处理（click/dblclick/fold/add/del），hover 由 CSS .item-actions 处理

  nodeDiv.appendChild(header);
  
  // 渲染子节点（始终渲染，折叠时通过 CSS 动画隐藏）
  var childrenIds = getChildrenIds(id);
  if (childrenIds.length > 0) {
    var childrenContainer = document.createElement('div');
    childrenContainer.className = 'children-container' + (session.collapsed ? ' collapsed' : '');
    childrenIds.forEach(function(childId) {
      renderTreeNode(childId, childrenContainer, level + 1);
    });
    nodeDiv.appendChild(childrenContainer);
  }
  
  container.appendChild(nodeDiv);
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
        Core.dom.sendBtn.textContent = '⏹';
        Core.dom.sendBtn.style.background = '#ef4444';
        Core.dom.sendBtn.disabled = false;
      } else {
        Core.dom.sendBtn.textContent = '↑';
        Core.dom.sendBtn.style.background = '';
        Core.dom.sendBtn.disabled = false;
      }
    }
    if (Core.dom.deepThinkBtn) Core.dom.deepThinkBtn.disabled = isGenerating;
    if (Core.dom.webSearchBtn) Core.dom.webSearchBtn.disabled = isGenerating;
  }
}

// ===== 高亮当前会话 =====
function highlightChatItem(id) {
  document.querySelectorAll('.chat-item').forEach(function(item) {
    item.classList.remove('active');
  });
  var active = document.querySelector('.chat-item[data-id="' + id + '"]');
  if (active) active.classList.add('active');
}

// ===== 渲染消息 =====
function renderMessages(id, ensureMsgIndex) {
  var container = document.getElementById('chatContainer');
  if (!container) return;
  // 使用 DocumentFragment 原子化渲染，避免 innerHTML='' 造成的空白闪烁
  var fragment = document.createDocumentFragment();
  var session = sessions[id];
  if (!session || !session.messages) {
    container.replaceChildren(fragment);
    return;
  }

  var msgs = session.messages;
  var total = msgs.length;
  // 收集所有消息 div，批量添加代码按钮（替代逐条 setTimeout 100ms 引起的二次闪烁）
  var _batchMsgDivs = [];

  // 虚拟滚动：如果消息数超过阈值，只渲染后 100 条
  var startIndex = 0;
  var VIRTUAL_PAGE_SIZE = 100;
  if (total > VIRTUAL_PAGE_SIZE) {
    startIndex = total - VIRTUAL_PAGE_SIZE;
    if (ensureMsgIndex !== undefined && ensureMsgIndex >= 0 && ensureMsgIndex < startIndex) {
      startIndex = ensureMsgIndex;
    }
    if (startIndex > 0) {
      var loadMoreBtn = createLoadMoreBtn(id, startIndex, VIRTUAL_PAGE_SIZE);
      fragment.appendChild(loadMoreBtn);
    }
  }
  
  if (!session._renderMeta) session._renderMeta = {};
  session._renderMeta.startIndex = startIndex;
  session._renderMeta.total = total;
  
  // ===== 按日期分组消息 =====
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  var groups = [];
  var currentGroup = null;
  for (var i = startIndex; i < total; i++) {
    var msg = msgs[i];
    var dateKey = '';
    var msgDate = null;
    if (msg.timestamp && !isNaN(msg.timestamp)) {
      msgDate = new Date(msg.timestamp);
      if (!isNaN(msgDate.getTime())) {
        dateKey = msgDate.getFullYear() + '-' + String(msgDate.getMonth() + 1).padStart(2, '0') + '-' + String(msgDate.getDate()).padStart(2, '0');
      }
    }
    if (!currentGroup || currentGroup.dateKey !== dateKey) {
      currentGroup = { dateKey: dateKey, date: msgDate, messages: [], startIndex: i };
      groups.push(currentGroup);
    }
    currentGroup.messages.push({ msg: msg, index: i });
  }
  
  // ===== 渲染分组（支持折叠） =====
  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    
    // 日期分割线
    if (group.date) {
      var divider = createDateDivider(group.date);
      fragment.appendChild(divider);
    }
    
    // 判断是否是今天
    var isToday = false;
    if (group.date) {
      var groupDay = new Date(group.date.getFullYear(), group.date.getMonth(), group.date.getDate());
      isToday = groupDay.getTime() === today.getTime();
    }
    
    // 非今天且超过 3 条的消息组，默认折叠（只显示最后 2 条）
    if (!isToday && group.messages.length > 3) {
      var foldCount = group.messages.length - 2;
      var groupWrapper = document.createElement('div');
      groupWrapper.className = 'msg-group-foldable';
      groupWrapper.dataset.folded = 'true';
      
      // 折叠/展开按钮
      var foldBtn = document.createElement('div');
      foldBtn.className = 'msg-fold-btn';
      foldBtn.textContent = '\u25bc \u5c55\u5f00 ' + foldCount + ' \u6761\u66f4\u65e9\u7684\u6d88\u606f';
      foldBtn.addEventListener('click', function() {
        var wrapper = this.parentNode;
        var isFolded = wrapper.dataset.folded === 'true';
        var hiddenMsgs = wrapper.querySelectorAll('.msg-folded');
        for (var h = 0; h < hiddenMsgs.length; h++) {
          hiddenMsgs[h].style.display = isFolded ? 'block' : 'none';
        }
        wrapper.dataset.folded = isFolded ? 'false' : 'true';
        var count = hiddenMsgs.length;
        this.textContent = isFolded ? '\u25b2 \u6536\u8d77 ' + count + ' \u6761\u6d88\u606f' : '\u25bc \u5c55\u5f00 ' + count + ' \u6761\u66f4\u65e9\u7684\u6d88\u606f';
      });
      groupWrapper.appendChild(foldBtn);
      
      // 渲染消息：前 foldCount 条折叠，后 2 条显示
      for (var m = 0; m < group.messages.length; m++) {
        var item = group.messages[m];
        renderSingleMessage(item.msg, item.index, groupWrapper);
        var lastDiv = groupWrapper.lastElementChild;
        if (m < foldCount) {
          lastDiv.classList.add('msg-folded');
          lastDiv.style.display = 'none';
        }
      }
      fragment.appendChild(groupWrapper);
    } else {
      // 正常渲染该组所有消息
      for (var m = 0; m < group.messages.length; m++) {
        var item = group.messages[m];
        renderSingleMessage(item.msg, item.index, fragment);
      }
    }
  }
  
  // ===== 原子化渲染：禁止入场动画 → 一次性替换 DOM → 恢复动画 =====
  container.classList.add('batch-render');

  // 预设滚动到底部（在替换前设置，避免新内容先显示在顶部再跳到底部）
  container.scrollTop = container.scrollHeight;

  container.replaceChildren(fragment);

  // 确保滚动位置正确（布局已更新，scrollHeight 反映新内容）
  container.scrollTop = container.scrollHeight;

  // 批量添加代码按钮（单次 setTimeout 替代逐条 setTimeout 100ms）
  var allMsgDivs = container.querySelectorAll('.msg');
  if (allMsgDivs.length > 0) {
    setTimeout(function() {
      allMsgDivs.forEach(function(div) {
        addCodeButtonsToDiv(div);
      });
    }, 50);
  }

  // 首帧绘制后恢复动画
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      container.classList.remove('batch-render');
    });
  });
}

// ===== 创建"加载更多"按钮 =====
function createLoadMoreBtn(sessionId, currentStartIndex, pageSize) {
  var div = document.createElement('div');
  div.className = 'load-more-divider';
  div.dataset.sessionId = sessionId;
  div.dataset.currentStart = currentStartIndex;
  div.dataset.pageSize = pageSize;
  
  div.style.cssText = 'display:flex;align-items:center;justify-content:center;margin:16px 0;gap:12px;cursor:pointer;user-select:none;transition:opacity 0.2s;';
  
  var line = document.createElement('div');
  line.style.cssText = 'flex:1;height:1px;background:linear-gradient(90deg,transparent,var(--primary),transparent);';
  
  var label = document.createElement('span');
  label.style.cssText = 'font-size:12px;color:var(--primary);padding:4px 14px;border-radius:12px;background:var(--primary-light);border:1px solid var(--primary);white-space:nowrap;transition:all 0.2s;';
  label.textContent = '\u2191 \u52a0\u8f7d\u66f4\u591a\u5386\u53f2\u6d88\u606f (' + currentStartIndex + '\u6761)';
  
  div.addEventListener('mouseenter', function() {
    label.style.background = 'var(--primary)';
    label.style.color = '#fff';
  });
  div.addEventListener('mouseleave', function() {
    label.style.background = 'var(--primary-light)';
    label.style.color = 'var(--primary)';
  });
  
  div.addEventListener('click', function() {
    loadMoreMessages(sessionId, currentStartIndex, pageSize);
  });
  
  var line2 = line.cloneNode(true);
  div.appendChild(line);
  div.appendChild(label);
  div.appendChild(line2);
  return div;
}

// ===== 加载更多历史消息 =====
function loadMoreMessages(sessionId, currentStartIndex, pageSize) {
  var session = sessions[sessionId];
  if (!session || !session.messages) return;
  
  var container = document.getElementById('chatContainer');
  if (!container) return;
  
  var msgs = session.messages;
  var total = msgs.length;
  
  // 计算新的起始索引（往前加载 pageSize 条）
  var newStartIndex = Math.max(0, currentStartIndex - pageSize);
  var countToLoad = currentStartIndex - newStartIndex;
  
  if (countToLoad <= 0) return;
  
  // 找到旧的 load-more 按钮并移除
  var oldBtn = container.querySelector('.load-more-divider');
  var insertBefore = oldBtn ? oldBtn.nextSibling : container.firstChild;
  
  // 记录当前滚动位置（相对于容器顶部）
  var oldScrollHeight = container.scrollHeight;
  
  // 渲染新加载的消息（插入到顶部）
  var fragment = document.createDocumentFragment();
  var lastDate = null;
  
  // 获取新加载消息范围之前的日期（用于避免重复日期分割线）
  var existingFirstMsg = container.querySelector('.msg');
  var existingFirstDate = null;
  if (existingFirstMsg) {
    var ts = existingFirstMsg.querySelector('.msg-timestamp');
    if (ts && ts.title) {
      try {
        existingFirstDate = new Date(ts.title.split(' · ')[1] || ts.title);
      } catch(e) {}
    }
  }
  
  for (var i = newStartIndex; i < currentStartIndex; i++) {
    var msg = msgs[i];
    if (msg.timestamp && !isNaN(msg.timestamp)) {
      var msgDate = new Date(msg.timestamp);
      if (!isNaN(msgDate.getTime())) {
        var dateKey = msgDate.getFullYear() + '-' + String(msgDate.getMonth() + 1).padStart(2, '0') + '-' + String(msgDate.getDate()).padStart(2, '0');
        // 检查是否已有相同日期的分割线
        if (lastDate !== dateKey) {
          var divider = createDateDivider(msgDate);
          fragment.appendChild(divider);
          lastDate = dateKey;
        }
      }
    }
    renderSingleMessage(msg, i, fragment);
  }
  
  // 插入到容器顶部（在 load-more 按钮之后）
  if (insertBefore) {
    container.insertBefore(fragment, insertBefore);
  } else {
    container.appendChild(fragment);
  }
  
  // 如果还有更多历史消息，更新按钮
  if (oldBtn) oldBtn.remove();
  if (newStartIndex > 0) {
    var newBtn = createLoadMoreBtn(sessionId, newStartIndex, pageSize);
    container.insertBefore(newBtn, container.firstChild);
  }
  
  // 保持滚动位置（用户看到的内容不跳动）
  var newScrollHeight = container.scrollHeight;
  container.scrollTop = newScrollHeight - oldScrollHeight;
  
  // 更新渲染元数据
  session._renderMeta.startIndex = newStartIndex;
  
}

// ===== 日期分割线 =====
function createDateDivider(date) {
  var div = document.createElement('div');
  div.className = 'date-divider';
  div.style.cssText = 'display:flex;align-items:center;justify-content:center;margin:16px 0;gap:12px;user-select:none;';
  
  var line = document.createElement('div');
  line.style.cssText = 'flex:1;height:1px;background:linear-gradient(90deg,transparent,#3a3a3a,transparent);';
  
  var label = document.createElement('span');
  label.style.cssText = 'font-size:12px;color:#6b7280;padding:2px 12px;border-radius:12px;background:#1a1a1a;border:1px solid #2a2a2a;white-space:nowrap;';
  
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  var msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  
  var weekdayNames = ['\u65e5\u671f\u4e00', '\u661f\u671f\u4e00', '\u661f\u671f\u4e8c', '\u661f\u671f\u4e09', '\u661f\u671f\u56db', '\u661f\u671f\u4e94', '\u661f\u671f\u516d'];
  var dateStr = '';
  if (msgDay.getTime() === today.getTime()) {
    dateStr = '\u4eca\u5929';
  } else if (msgDay.getTime() === yesterday.getTime()) {
    dateStr = '\u6628\u5929';
  } else {
    dateStr = (date.getMonth() + 1) + '\u6708' + date.getDate() + '\u65e5 ' + weekdayNames[date.getDay()];
    if (date.getFullYear() !== now.getFullYear()) {
      dateStr = date.getFullYear() + '\u5e74' + dateStr;
    }
  }
  label.textContent = dateStr;
  
  var line2 = line.cloneNode(true);
  div.appendChild(line);
  div.appendChild(label);
  div.appendChild(line2);
  return div;
}

// ===== 格式化相对时间 =====
function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  var now = Date.now();
  var diff = now - timestamp;
  var minutes = Math.floor(diff / 60000);
  var hours = Math.floor(diff / 3600000);
  var days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return '\u521a\u521a';
  if (minutes < 60) return minutes + '\u5206\u949f\u524d';
  if (hours < 24) return hours + '\u5c0f\u65f6\u524d';
  if (days < 7) return days + '\u5929\u524d';
  
  var date = new Date(timestamp);
  return String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0') + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

// ===== 渲染单条消息 =====
function renderSingleMessage(msg, index, container) {
  var div = document.createElement('div');
  div.className = 'msg ' + (msg.role === 'user' ? 'user' : 'ai');
  div.dataset.msgIndex = index;
  
  if (msg.type === 'search' || msg.type === 'search-error') {
    // Phase 5-2: XSS防护 — 转义搜索内容
    div.innerHTML = '<div class="search-result">' + _escapeHtml(msg.content || '') + '</div>';
  } else if (msg.thinking) {
    // Phase 5-2: XSS防护 — 转义思考内容
    var thinkingHtml = '<div class="thinking-process"><div class="thinking-header">\ud83e\udde0 \u601d\u8003\u8fc7\u7a0b</div><div class="thinking-content">' + _escapeHtml(msg.thinking || '') + '</div></div>';
    var mainHtml = '<div class="main-content">' + _escapeHtml(msg.content || '') + '</div>';
    div.innerHTML = thinkingHtml + mainHtml;
  } else if (msg.content) {
    try {
      div.innerHTML = Core.renderMarkdown(msg.content);
    } catch (e) {
      div.innerHTML = parseMarkdownWithCodeBlocks(msg.content);
    }
  } else {
    div.textContent = '';
  }
  
  // 🔧 图片懒加载：给所有图片添加 loading="lazy"
  var imgs = div.querySelectorAll('img');
  imgs.forEach(function(img) {
    if (!img.hasAttribute('loading')) img.loading = 'lazy';
    if (!img.hasAttribute('decoding')) img.decoding = 'async';
  });
  
  // 时间戳（带相对时间提示）
  if (msg.timestamp) {
    var time = document.createElement('div');
    time.className = 'msg-timestamp';
    var date = new Date(msg.timestamp);
    var hours = String(date.getHours()).padStart(2, '0');
    var minutes = String(date.getMinutes()).padStart(2, '0');
    var timeStr = hours + ':' + minutes;
    var relativeStr = formatRelativeTime(msg.timestamp);
    time.textContent = timeStr;
    time.title = relativeStr + ' \u00b7 ' + date.toLocaleString();
    div.appendChild(time);
  }
  
  // \u4fee\u590d\u4ee3\u7801\u5757\u6309\u94ae\uff08\u590d\u5236 + \u8fd0\u884c\uff09
  // 代码按钮由 renderMessages 批量添加（避免逐条 setTimeout 引起二次闪烁）

  // 🔧 快速操作面板（AI消息）— Material Icons 版
  if (msg.role === 'assistant' && msg.content && !msg.type) {
    var quickActions = document.createElement('div');
    quickActions.className = 'quick-actions';

    var actions = [
      { icon: 'autorenew', text: '继续', prompt: '请继续' },
      { icon: 'summarize', text: '总结', prompt: '请总结以上内容' },
      { icon: 'translate', text: '翻译', prompt: '请将以上内容翻译成中文' },
      { icon: 'help_outline', text: '解释', prompt: '请详细解释以上内容' },
      { icon: 'lightbulb', text: '举例', prompt: '请举例说明' }
    ];

    actions.forEach(function(action) {
      var btn = document.createElement('button');
      btn.className = 'quick-action-btn';
      btn.dataset.prompt = action.prompt;
      btn.innerHTML = '<span class="material-icons-outlined">' + action.icon + '</span>' + action.text;
      quickActions.appendChild(btn);
    });

    div.appendChild(quickActions);
  }
  
  container.appendChild(div);
}
// 🔧 为代码块添加复制和运行按钮
function addCodeButtonsToDiv(contentDiv) {
  var codeBlocks = contentDiv.querySelectorAll('pre code');
  codeBlocks.forEach(function(block) {
    // 如果已经有按钮，跳过
    if (block.parentElement.querySelector('.code-btn-group')) return;
    
    var btnGroup = document.createElement('div');
    btnGroup.className = 'code-btn-group';
    btnGroup.style.cssText = 'position:absolute; top:5px; right:5px; display:flex; gap:4px;';
    
    // 复制按钮（click 由 chatContainer 事件委托处理）
    var copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 复制';
    copyBtn.className = 'code-btn';
    copyBtn.style.cssText = 'padding:2px 8px; font-size:12px; cursor:pointer; border-radius:4px; border:1px solid #ccc; background:#f5f5f5;';
    btnGroup.appendChild(copyBtn);
    
    // 运行按钮（Python/JS）
    var lang = block.className.match(/language-(\w+)/);
    if (lang && (lang[1] === 'python' || lang[1] === 'javascript' || lang[1] === 'js')) {
      var runBtn = document.createElement('button');
      runBtn.textContent = '▶️ 运行';
      runBtn.className = 'code-btn';
      runBtn.style.cssText = 'padding:2px 8px; font-size:12px; cursor:pointer; border-radius:4px; border:1px solid #ccc; background:#e3f2fd;';
      runBtn.addEventListener('click', function() {
        var code = block.textContent;
        if (lang[1] === 'python') {
          Core.session.addMessage({ role: 'system', content: '正在运行 Python 代码...', type: 'info' });
          if (Core.python) {
            Core.python.runPython(code).then(function(result) {
              Core.session.addMessage({ role: 'ai', content: '**Python 运行结果：**\n```\n' + result + '\n```' });
            }).catch(function(err) {
              Core.session.addMessage({ role: 'ai', content: '❌ Python 运行错误：' + err });
            });
          }
        } else {
          // Phase 5-2: 安全加固 — JS 沙箱执行（替代 new Function + 简单黑名单）
          if (!confirm('⚠️ 安全提示：即将执行 JavaScript 代码，请确认代码来源可信。\n\n是否继续执行？')) {
            return;
          }
          // 扩展黑名单 + 正则模式检测（防止间接访问绕过）
          var forbidden = [
            'require(', 'process.', 'child_process', 'fs.', 'exec(', 'execSync(',
            'eval(', 'Function(', 'globalThis', 'global.', 'window.',
            'import(', '__dirname', '__filename', 'module.',
            'Proxy(', 'Reflect.', 'WeakRef('
          ];
          var dangerousPatterns = [
            /\[["']pro["']\s*\+\s*["']cess["']\]/,  // 字符串拼接绕过
            /this\s*\.\s*constructor/,                 // 原型链逃逸
            /\bconstructor\s*\(\s*["']return/,         // 构造函数注入
            /\.\s*call\s*\(\s*this/,                   // call 注入
            /\.\s*apply\s*\(\s*this/,                  // apply 注入
          ];
          var hasForbidden = false;
          for (var i = 0; i < forbidden.length; i++) {
            if (code.indexOf(forbidden[i]) >= 0) {
              Core.session.addMessage({ role: 'ai', content: '❌ 安全限制：代码中包含禁止的操作 "' + _escapeHtml(forbidden[i]) + '"。' });
              hasForbidden = true; break;
            }
          }
          if (!hasForbidden) {
            for (var pi = 0; pi < dangerousPatterns.length; pi++) {
              if (dangerousPatterns[pi].test(code)) {
                Core.session.addMessage({ role: 'ai', content: '❌ 安全限制：检测到可疑的代码模式，已阻止执行。' });
                hasForbidden = true; break;
              }
            }
          }
          if (hasForbidden) {
            // 审计日志
            console.warn('🔒 JS沙箱阻止执行:', code.substring(0, 200));
            return;
          }
          try {
            // 使用 vm 模块在受限上下文中执行
            var vm = require('vm');
            var sandbox = {
              console: { log: function() {}, warn: function() {}, error: function() {} },
              Math: Math, Date: Date, JSON: JSON,
              parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
              Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
              RegExp: RegExp, Error: Error, Map: Map, Set: Set, Promise: Promise,
              encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
            };
            var context = vm.createContext(sandbox);
            var script = new vm.Script('return (' + code + ')', { timeout: 5000 }); // 5秒超时
            var result = script.runInContext(context);
            var resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
            if (resultStr.length > 5000) resultStr = resultStr.substring(0, 5000) + '\n...(结果已截断)';
            Core.session.addMessage({ role: 'ai', content: '**JS 运行结果：**\n```\n' + resultStr + '\n```' });
          } catch (e) {
            Core.session.addMessage({ role: 'ai', content: '❌ JS 运行错误：' + _escapeHtml(e.message) });
            console.warn('🔒 JS沙箱执行失败:', e.message);
          }
        }
      });
      btnGroup.appendChild(runBtn);
    }
    
    block.parentElement.style.position = 'relative';
    block.parentElement.appendChild(btnGroup);
  });
}

// 🔧 备用 Markdown 解析（当 marked 不可用时）
function parseMarkdownWithCodeBlocks(text) {
  if (!text) return '';
  return text
    .replace(/```(\w+)?\n([\s\S]*?)```/g, function(match, lang, code) {
      return '<pre><code class="language-' + (lang || 'text') + '">' + escapeHtml(code) + '</code></pre>';
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

var escapeHtml = _htmlUtils.escapeHtml;

// ===== 添加消息 =====
function addMessage(content, role, type) {
  if (!currentSessionId || !sessions[currentSessionId]) return;
  var msg = { role: role, content: content, timestamp: Date.now() };
  if (type) msg.type = type;
  sessions[currentSessionId].messages.push(msg);
  debouncedAutoSave(currentSessionId);
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

// ===== 滚动到底部 =====
function scrollToBottom() {
  var container = document.getElementById('chatContainer');
  if (container) container.scrollTop = container.scrollHeight;
}

// ===== 更新会话计数 =====
function updateChatCountDisplay() {
  var count = Object.keys(sessions).length;
  var countEl = document.getElementById('chatCount');
  if (countEl) countEl.textContent = count;
}

// ===== 自动更新标题 =====
function autoTitle(sessionId) {
  if (!sessions[sessionId]) return;
  var session = sessions[sessionId];
  if (session._manuallyRenamed) return;
  var firstUser = session.messages.find(function(m) { return m.role === 'user'; });
  if (firstUser) {
    var title = firstUser.content.substring(0, 20) + (firstUser.content.length > 20 ? '...' : '');
    session.title = title;
    saveSession(sessionId);
    renderChatList();
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
    
    // 🔧 从所有可能的目录删除（动态计算路径）
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
    if (!deleted) {
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
  if (roleType === 'master') title = '👑 主管模式';
  else if (roleType === 'coder') title = '💻 代码大师';
  else if (roleType === 'writer') title = '✍️ 创意写手';
  else if (roleType === 'analyst') title = '📊 数据分析师';
  else if (roleType === 'teacher') title = '🎓 学习导师';
  sessions[id] = {
    title: title, messages: [], pinned: false, temperature: defaultTemp,
    roleType: roleType || 'chat', parentId: parentId || null, collapsed: false, _manuallyRenamed: false
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
      if (qaBtn && qaBtn.dataset.prompt) {
        e.stopPropagation();
        if (Core.dom && Core.dom.input) {
          Core.dom.input.value = qaBtn.dataset.prompt;
          if (Core.api && Core.api.sendMessage) Core.api.sendMessage();
        }
        return;
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