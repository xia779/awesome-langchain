// modules/lib/session-render.js
// UI rendering functions extracted from session.js
// Usage: var render = require('./lib/session-render')(ctx);

module.exports = function(ctx) {
  // ctx provides:
  //   ctx.sessions          - the sessions object (getter)
  //   ctx.currentSessionId  - current session ID (getter)
  //   ctx.Core              - Core module reference (getter)
  //   ctx.chatListFilter    - text filter (getter)
  //   ctx.chatListDateFilter - date filter (getter)
  //   ctx.getChildrenIds(parentId) - get child session IDs
  //   ctx.escapeHtml(str)   - HTML escape utility

  var escapeHtml = ctx.escapeHtml;

  // ===== P4: 辅助函数 - 获取会话最后活动时间
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

  // ===== P4: 辅助函数 - 检查会话是否匹配筛选条件
  function matchesFilter(session) {
    if (!session) return false;
    var chatListFilter = ctx.chatListFilter;
    var chatListDateFilter = ctx.chatListDateFilter;

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

  // ===== 渲染侧边栏（树形层级） =====
  function renderChatList() {
    var sessions = ctx.sessions;
    var currentSessionId = ctx.currentSessionId;
    var chatListFilter = ctx.chatListFilter;
    var chatListDateFilter = ctx.chatListDateFilter;

    var chatList = document.getElementById('chatList');
    if (!chatList) return;
    var fragment = document.createDocumentFragment();

    var hasFilter = chatListFilter || chatListDateFilter !== 'all';

    if (hasFilter) {
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
      var rootIds = Object.keys(sessions).filter(function(id) { return !sessions[id].parentId; });

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

    chatList.replaceChildren(fragment);

    updateChatCountDisplay();
    highlightChatItem(currentSessionId);
  }

  // ===== P4: 扁平化渲染节点（用于筛选结果） =====
  function renderFlatNode(id, container) {
    var sessions = ctx.sessions;
    var currentSessionId = ctx.currentSessionId;
    var session = sessions[id];
    if (!session) return;

    var item = document.createElement('div');
    item.className = 'chat-item' + (id === currentSessionId ? ' active' : '');
    item.dataset.id = id;
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'treeitem');
    if (id === currentSessionId) item.setAttribute('aria-selected', 'true');

    var emojiMap = { 'master': 'workspace_premium', 'coder': 'code', 'writer': 'edit_note', 'analyst': 'analytics', 'teacher': 'school', 'chat': 'chat' };
    var emoji = emojiMap[session.roleType] || 'chat';

    var lastMsgPreview = '';
    if (session.messages && session.messages.length > 0) {
      var lastMsg = session.messages[session.messages.length - 1];
      if (lastMsg.content) {
        lastMsgPreview = lastMsg.content.substring(0, 30) + (lastMsg.content.length > 30 ? '...' : '');
      }
    }

    var timeStr = '';
    var sessionDate = getSessionDate(session);
    if (sessionDate) {
      timeStr = sessionDate.toLocaleDateString() + ' ' + sessionDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }

    item.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;margin-right:6px;vertical-align:-2px;color:var(--text-secondary);">' + emoji + '</span>' +
      '<div style="flex:1;overflow:hidden;">' +
      '<div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (session.title || '未命名') + '</div>' +
      '<div style="font-size:11px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + lastMsgPreview + '</div>' +
      '</div>' +
      '<span style="font-size:11px;color:#6b7280;flex-shrink:0;margin-left:6px;">' + timeStr + '</span>';
    container.appendChild(item);
  }

  // ===== 渲染树节点（递归） =====
  function renderTreeNode(id, container, level) {
    var sessions = ctx.sessions;
    var currentSessionId = ctx.currentSessionId;
    var Core = ctx.Core;
    var session = sessions[id];
    if (!session) return;

    var nodeDiv = document.createElement('div');
    nodeDiv.className = 'chat-node';
    nodeDiv.style.marginLeft = (level * 20) + 'px';

    var isRole = (session.roleType === 'master' || session.roleType === 'coder' || session.roleType === 'writer' || session.roleType === 'analyst' || session.roleType === 'teacher');
    var isMaster = (session.roleType === 'master');

    var header = document.createElement('div');
    header.className = 'chat-item';
    header.dataset.id = id;
    header.setAttribute('tabindex', '0');
    header.setAttribute('role', 'treeitem');
    if (id === currentSessionId) {
      header.classList.add('active');
      header.setAttribute('aria-selected', 'true');
    }

    if (isMaster) header.classList.add('master-role');
    else if (isRole) header.classList.add('role-role');
    else header.classList.add('chat-role');

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

    if (session._unreadCount && session._unreadCount > 0) {
      var badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = session._unreadCount > 99 ? '99+' : session._unreadCount;
      badge.style.cssText = 'margin-left:4px;padding:1px 6px;font-size:10px;font-weight:600;color:#fff;background:#ef4444;border-radius:10px;min-width:16px;text-align:center;flex-shrink:0;';
      header.appendChild(badge);
    }

    if (Core && Core.api && Core.api.getBackgroundTasks) {
      var bgTasks = Core.api.getBackgroundTasks();
      var hasRunningTask = bgTasks.some(function(t) { return t.sessionId === id && t.status === 'running'; });
      if (hasRunningTask) {
        var runningIndicator = document.createElement('span');
        runningIndicator.className = 'bg-task-indicator';
        runningIndicator.title = '后台任务运行中...';
        runningIndicator.style.cssText = 'margin-left:4px;font-size:12px;flex-shrink:0;animation:spin 1s linear infinite;display:inline-block;';
        runningIndicator.textContent = '\u2699';
        header.appendChild(runningIndicator);
      }
    }

    var titleSpan = document.createElement('span');
    titleSpan.className = 'chat-title';
    titleSpan.textContent = session.title || '未命名';
    titleSpan.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    header.appendChild(titleSpan);

    var btnContainer = document.createElement('div');
    btnContainer.className = 'item-actions';

    var addBtn = document.createElement('span');
    addBtn.className = 'add-btn';
    addBtn.textContent = '+';
    addBtn.title = (level === 0 && session.roleType === 'master') ? '添加新对话' : '添加新对话';
    addBtn.style.cssText = 'cursor:pointer; width:20px; height:20px; border-radius:50%; background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold;';
    btnContainer.appendChild(addBtn);

    var delBtn = document.createElement('span');
    delBtn.className = 'del-btn';
    delBtn.textContent = '\u00d7';
    delBtn.title = '删除';
    delBtn.style.cssText = 'cursor:pointer; width:20px; height:20px; border-radius:50%; background:#ff4444; color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold;';
    btnContainer.appendChild(delBtn);

    header.appendChild(btnContainer);

    nodeDiv.appendChild(header);

    var childrenIds = ctx.getChildrenIds(id);
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
    var sessions = ctx.sessions;
    var container = document.getElementById('chatContainer');
    if (!container) return;
    var fragment = document.createDocumentFragment();
    var session = sessions[id];
    if (!session || !session.messages) {
      container.replaceChildren(fragment);
      return;
    }

    var msgs = session.messages;
    var total = msgs.length;

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

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];

      if (group.date) {
        var divider = createDateDivider(group.date);
        fragment.appendChild(divider);
      }

      var isToday = false;
      if (group.date) {
        var groupDay = new Date(group.date.getFullYear(), group.date.getMonth(), group.date.getDate());
        isToday = groupDay.getTime() === today.getTime();
      }

      if (!isToday && group.messages.length > 3) {
        var foldCount = group.messages.length - 2;
        var groupWrapper = document.createElement('div');
        groupWrapper.className = 'msg-group-foldable';
        groupWrapper.dataset.folded = 'true';

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
        for (var m = 0; m < group.messages.length; m++) {
          var item = group.messages[m];
          renderSingleMessage(item.msg, item.index, fragment);
        }
      }
    }

    container.classList.add('batch-render');
    container.replaceChildren(fragment);
    container.scrollTop = container.scrollHeight;

    var allMsgDivs = container.querySelectorAll('.msg');
    if (allMsgDivs.length > 0) {
      setTimeout(function() {
        allMsgDivs.forEach(function(div) {
          addCodeButtonsToDiv(div);
        });
      }, 50);
    }

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
    var sessions = ctx.sessions;
    var session = sessions[sessionId];
    if (!session || !session.messages) return;

    var container = document.getElementById('chatContainer');
    if (!container) return;

    var msgs = session.messages;
    var total = msgs.length;

    var newStartIndex = Math.max(0, currentStartIndex - pageSize);
    var countToLoad = currentStartIndex - newStartIndex;

    if (countToLoad <= 0) return;

    var oldBtn = container.querySelector('.load-more-divider');
    var insertBefore = oldBtn ? oldBtn.nextSibling : container.firstChild;

    var oldScrollHeight = container.scrollHeight;

    var fragment = document.createDocumentFragment();
    var lastDate = null;

    for (var i = newStartIndex; i < currentStartIndex; i++) {
      var msg = msgs[i];
      if (msg.timestamp && !isNaN(msg.timestamp)) {
        var msgDate = new Date(msg.timestamp);
        if (!isNaN(msgDate.getTime())) {
          var dateKey = msgDate.getFullYear() + '-' + String(msgDate.getMonth() + 1).padStart(2, '0') + '-' + String(msgDate.getDate()).padStart(2, '0');
          if (lastDate !== dateKey) {
            var divider = createDateDivider(msgDate);
            fragment.appendChild(divider);
            lastDate = dateKey;
          }
        }
      }
      renderSingleMessage(msg, i, fragment);
    }

    if (insertBefore) {
      container.insertBefore(fragment, insertBefore);
    } else {
      container.appendChild(fragment);
    }

    if (oldBtn) oldBtn.remove();
    if (newStartIndex > 0) {
      var newBtn = createLoadMoreBtn(sessionId, newStartIndex, pageSize);
      container.insertBefore(newBtn, container.firstChild);
    }

    var newScrollHeight = container.scrollHeight;
    container.scrollTop = newScrollHeight - oldScrollHeight;

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

    var weekdayNames = ['\u661f\u671f\u65e5', '\u661f\u671f\u4e00', '\u661f\u671f\u4e8c', '\u661f\u671f\u4e09', '\u661f\u671f\u56db', '\u661f\u671f\u4e94', '\u661f\u671f\u516d'];
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
    var Core = ctx.Core;
    var div = document.createElement('div');
    div.className = 'msg ' + (msg.role === 'user' ? 'user' : 'ai');
    div.dataset.msgIndex = index;

    if (msg.type === 'search' || msg.type === 'search-error') {
      div.innerHTML = '<div class="search-result">' + escapeHtml(msg.content || '') + '</div>';
    } else if (msg.thinking) {
      var thinkingHtml = '<div class="thinking-process"><div class="thinking-header"><span class="material-icons-outlined" style="font-size:15px;vertical-align:-2px;">psychology</span> \u601d\u8003\u8fc7\u7a0b</div><div class="thinking-content">' + escapeHtml(msg.thinking || '') + '</div></div>';
      var mainHtml = '<div class="main-content">' + escapeHtml(msg.content || '') + '</div>';
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

    var imgs = div.querySelectorAll('img');
    imgs.forEach(function(img) {
      if (!img.hasAttribute('loading')) img.loading = 'lazy';
      if (!img.hasAttribute('decoding')) img.decoding = 'async';
    });

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

    if ((msg.role === 'assistant' || msg.role === 'ai') && msg.content && !msg.type) {
      var quickActions = document.createElement('div');
      quickActions.className = 'quick-actions';

      var actions = [
        { icon: 'autorenew', text: '\u7ee7\u7eed', prompt: '\u8bf7\u7ee7\u7eed' },
        { icon: 'summarize', text: '\u603b\u7ed3', prompt: '\u8bf7\u603b\u7ed3\u4ee5\u4e0a\u5185\u5bb9' },
        { icon: 'translate', text: '\u7ffb\u8bd1', prompt: '\u8bf7\u5c06\u4ee5\u4e0a\u5185\u5bb9\u7ffb\u8bd1\u6210\u4e2d\u6587' },
        { icon: 'help_outline', text: '\u89e3\u91ca', prompt: '\u8bf7\u8be6\u7ec6\u89e3\u91ca\u4ee5\u4e0a\u5185\u5bb9' },
        { icon: 'lightbulb', text: '\u4e3e\u4f8b', prompt: '\u8bf7\u4e3e\u4f8b\u8bf4\u660e' },
        { icon: 'volume_up', text: '\u6717\u8bfb', action: 'tts' }
      ];

      actions.forEach(function(action) {
        var btn = document.createElement('button');
        btn.className = 'quick-action-btn';
        if (action.prompt) btn.dataset.prompt = action.prompt;
        if (action.action) btn.dataset.action = action.action;
        btn.innerHTML = '<span class="material-icons-outlined">' + action.icon + '</span>' + action.text;
        quickActions.appendChild(btn);
      });

      div.appendChild(quickActions);
    }

    container.appendChild(div);
  }

  // ===== 为代码块添加复制和运行按钮 =====
  function addCodeButtonsToDiv(contentDiv) {
    var Core = ctx.Core;
    var codeBlocks = contentDiv.querySelectorAll('pre code');
    codeBlocks.forEach(function(block) {
      if (block.parentElement.querySelector('.code-btn-group')) return;

      var btnGroup = document.createElement('div');
      btnGroup.className = 'code-btn-group';
      btnGroup.style.cssText = 'position:absolute; top:5px; right:5px; display:flex; gap:4px;';

      var copyBtn = document.createElement('button');
      copyBtn.textContent = '\ud83d\udccb \u590d\u5236';
      copyBtn.className = 'code-btn';
      copyBtn.style.cssText = 'padding:2px 8px; font-size:12px; cursor:pointer; border-radius:4px; border:1px solid #ccc; background:#f5f5f5;';
      btnGroup.appendChild(copyBtn);

      var lang = block.className.match(/language-(\w+)/);
      if (lang && (lang[1] === 'python' || lang[1] === 'javascript' || lang[1] === 'js')) {
        var runBtn = document.createElement('button');
        runBtn.textContent = '\u25b6\ufe0f \u8fd0\u884c';
        runBtn.className = 'code-btn';
        runBtn.style.cssText = 'padding:2px 8px; font-size:12px; cursor:pointer; border-radius:4px; border:1px solid #ccc; background:#e3f2fd;';
        runBtn.addEventListener('click', function() {
          var code = block.textContent;
          if (lang[1] === 'python') {
            Core.session.addMessage({ role: 'system', content: '\u6b63\u5728\u8fd0\u884c Python \u4ee3\u7801...', type: 'info' });
            if (Core.python) {
              Core.python.runPython(code).then(function(result) {
                Core.session.addMessage({ role: 'ai', content: '**Python \u8fd0\u884c\u7ed3\u679c\uff1a**\n```\n' + result + '\n```' });
              }).catch(function(err) {
                Core.session.addMessage({ role: 'ai', content: '\u274c Python \u8fd0\u884c\u9519\u8bef\uff1a' + err });
              });
            }
          } else {
            if (!confirm('\u26a0\ufe0f \u5b89\u5168\u63d0\u793a\uff1a\u5373\u5c06\u6267\u884c JavaScript \u4ee3\u7801\uff0c\u8bf7\u786e\u8ba4\u4ee3\u7801\u6765\u6e90\u53ef\u4fe1\u3002\n\n\u662f\u5426\u7ee7\u7eed\u6267\u884c\uff1f')) {
              return;
            }
            var forbidden = [
              'require(', 'process.', 'child_process', 'fs.', 'exec(', 'execSync(',
              'eval(', 'Function(', 'globalThis', 'global.', 'window.',
              'import(', '__dirname', '__filename', 'module.',
              'Proxy(', 'Reflect.', 'WeakRef('
            ];
            var dangerousPatterns = [
              /\[["']pro["']\s*\+\s*["']cess["']\]/,
              /this\s*\.\s*constructor/,
              /\bconstructor\s*\(\s*["']return/,
              /\.\s*call\s*\(\s*this/,
              /\.\s*apply\s*\(\s*this/,
            ];
            var hasForbidden = false;
            for (var i = 0; i < forbidden.length; i++) {
              if (code.indexOf(forbidden[i]) >= 0) {
                Core.session.addMessage({ role: 'ai', content: '\u274c \u5b89\u5168\u9650\u5236\uff1a\u4ee3\u7801\u4e2d\u5305\u542b\u7981\u6b62\u7684\u64cd\u4f5c "' + escapeHtml(forbidden[i]) + '"\u3002' });
                hasForbidden = true; break;
              }
            }
            if (!hasForbidden) {
              for (var pi = 0; pi < dangerousPatterns.length; pi++) {
                if (dangerousPatterns[pi].test(code)) {
                  Core.session.addMessage({ role: 'ai', content: '\u274c \u5b89\u5168\u9650\u5236\uff1a\u68c0\u6d4b\u5230\u53ef\u7591\u7684\u4ee3\u7801\u6a21\u5f0f\uff0c\u5df2\u963b\u6b62\u6267\u884c\u3002' });
                  hasForbidden = true; break;
                }
              }
            }
            if (hasForbidden) {
              console.warn('\ud83d\udd12 JS\u6c99\u7bb1\u963b\u6b62\u6267\u884c:', code.substring(0, 200));
              return;
            }
            try {
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
              var script = new vm.Script('return (' + code + ')', { timeout: 5000 });
              var result = script.runInContext(context);
              var resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
              if (resultStr.length > 5000) resultStr = resultStr.substring(0, 5000) + '\n...(\u7ed3\u679c\u5df2\u622a\u65ad)';
              Core.session.addMessage({ role: 'ai', content: '**JS \u8fd0\u884c\u7ed3\u679c\uff1a**\n```\n' + resultStr + '\n```' });
            } catch (e) {
              Core.session.addMessage({ role: 'ai', content: '\u274c JS \u8fd0\u884c\u9519\u8bef\uff1a' + escapeHtml(e.message) });
              console.warn('\ud83d\udd12 JS\u6c99\u7bb1\u6267\u884c\u5931\u8d25:', e.message);
            }
          }
        });
        btnGroup.appendChild(runBtn);
      }

      block.parentElement.style.position = 'relative';
      block.parentElement.appendChild(btnGroup);
    });
  }

  // ===== 备用 Markdown 解析（当 marked 不可用时） =====
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

  // ===== 滚动到底部 =====
  function scrollToBottom() {
    var container = document.getElementById('chatContainer');
    if (container) container.scrollTop = container.scrollHeight;
  }

  // ===== 更新会话计数 =====
  function updateChatCountDisplay() {
    var sessions = ctx.sessions;
    var count = Object.keys(sessions).length;
    var countEl = document.getElementById('chatCount');
    if (countEl) countEl.textContent = count;
  }

  // ===== 导出所有渲染函数 =====
  return {
    renderChatList: renderChatList,
    renderFlatNode: renderFlatNode,
    renderTreeNode: renderTreeNode,
    renderMessages: renderMessages,
    renderSingleMessage: renderSingleMessage,
    highlightChatItem: highlightChatItem,
    scrollToBottom: scrollToBottom,
    updateChatCountDisplay: updateChatCountDisplay,
    formatRelativeTime: formatRelativeTime,
    createDateDivider: createDateDivider,
    createLoadMoreBtn: createLoadMoreBtn,
    loadMoreMessages: loadMoreMessages,
    addCodeButtonsToDiv: addCodeButtonsToDiv,
    parseMarkdownWithCodeBlocks: parseMarkdownWithCodeBlocks,
    getSessionDate: getSessionDate,
    matchesFilter: matchesFilter
  };
};
