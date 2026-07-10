// modules/performance.js - 性能优化与崩溃恢复模块（Phase 8 重写）
var Core = null;
var fs = require('fs');
var path = require('path');

// ===== 性能配置 =====
var PERF_CONFIG = {
  maxMessagesPerSession: 200,
  maxRenderedMessages: 80,
  virtualScrollBuffer: 10,
  lazyLoadBatch: 30,
  imageLazyLoad: true,
  gcInterval: 300000,
  compressImages: true,
  maxImageSize: 2 * 1024 * 1024,
  draftSaveInterval: 3000,
  crashRecoveryFile: 'crash-recovery.json',
  maxArchivedAge: 30 * 24 * 60 * 60 * 1000,
  perfSampleInterval: 10000,
  maxPerfSamples: 60,
};

// ===== 运行时统计 =====
var stats = {
  startTime: 0,
  messageCount: 0,
  domNodes: 0,
  memoryUsage: 0,
  renderTime: 0,
  renderTimes: [],
  perfSamples: [],
  crashRecoveries: 0,
  draftsSaved: 0,
  lazyLoadsTriggered: 0,
  gcTriggered: 0,
  archiveCount: 0,
};

// ===== 缓存的 DOM 引用 =====
var _dom = {
  chatContainer: null,
  input: null,
};

// 虚拟滚动状态
var _virtualState = {
  enabled: false,
  totalMessages: 0,
  renderedStart: 0,
  renderedEnd: 0,
  observer: null,
  scrollHandler: null,
};

// 懒加载状态
var _lazyState = {
  loadedCount: 0,
  totalCount: 0,
  isLoading: false,
  sentinel: null,
};

// 崩溃恢复状态
var _recovery = {
  draftTimer: null,
  lastDraft: '',
  generationState: null,
};

// 性能采样定时器
var _perfTimer = null;
var _gcTimer = null;
var _memCleanupTimer = null;

// ===== 模块初始化 =====
function init(_Core) {
  Core = _Core;
  stats.startTime = performance.now();

  Core.performance = {
    optimizeMessageRender: optimizeMessageRender,
    cleanupOldMessages: cleanupOldMessages,
    monitorMemory: monitorMemory,
    getStats: getStats,
    getDetailedStats: getDetailedStats,
    archiveOldSessions: archiveOldSessions,
    enableVirtualScrolling: enableVirtualScrolling,
    enableLazyLoading: enableLazyLoading,
    compressImage: compressImage,
    getCrashRecovery: getCrashRecovery,
    clearCrashRecovery: clearCrashRecovery,
    getPerfHistory: getPerfHistory,
    getCachedKnowledgeChunks: getCachedKnowledgeChunks,
    invalidateKnowledgeCache: invalidateKnowledgeCache,
    optimizeStreamingUpdate: optimizeStreamingUpdate,
    endStreamingOptimization: endStreamingOptimization,
    capSessionMessages: capSessionMessages,
    queueAsyncSave: queueAsyncSave,
    destroyTimers: function() {
      if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
      if (_memCleanupTimer) { clearInterval(_memCleanupTimer); _memCleanupTimer = null; }
      if (_perfTimer) { clearInterval(_perfTimer); _perfTimer = null; }
    },
    CONFIG: PERF_CONFIG,
  };

  setupPerformanceOptimizations();
  setupCrashRecovery();
  setupPerfMonitoring();

  // 延迟注册命令（custom.js 在 performance.js 之后加载）
  setTimeout(function() {
    registerCommands();
  }, 100);

  console.log('\u26a1 \u6027\u80fd\u4f18\u5316\u6a21\u5757\u5df2\u52a0\u8f7d\uff08Phase 8\uff09');
}

// ================================================================
//  1. 虚拟滚动（IntersectionObserver + 消息折叠）
// ================================================================
function enableVirtualScrolling(container) {
  if (!container || _virtualState.enabled) return;
  _dom.chatContainer = container;
  _virtualState.enabled = true;

  // 使用 IntersectionObserver 监控每个消息元素的可见性
  _virtualState.observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      var msg = entry.target;
      if (!msg.classList.contains('msg')) return;
      if (entry.isIntersecting) {
        expandMessage(msg);
      } else {
        collapseMessage(msg);
      }
    });
  }, {
    root: container,
    rootMargin: '200px 0px',
    threshold: 0,
  });

  // 监控已有的和未来的消息
  observeExistingMessages(container);

  // MutationObserver 自动监控新添加的消息
  var mutObs = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('msg')) {
          _virtualState.observer.observe(node);
        }
      });
    });
  });
  mutObs.observe(container, { childList: true });

  // 滚动节流：折叠/展开由 IntersectionObserver 驱动，此处只做统计
  var scrollTicking = false;
  container.addEventListener('scroll', function() {
    if (!scrollTicking) {
      requestAnimationFrame(function() {
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }, { passive: true });

  console.log('\u26a1 \u865a\u62df\u6eda\u52a8\u5df2\u542f\u7528\uff08IntersectionObserver \u6a21\u5f0f\uff09');
}

function observeExistingMessages(container) {
  var msgs = container.querySelectorAll('.msg');
  msgs.forEach(function(msg) {
    _virtualState.observer.observe(msg);
  });
}

function collapseMessage(msg) {
  if (msg.dataset.collapsed === 'true') return;
  // 保留高度占位，隐藏内容
  var h = msg.offsetHeight;
  if (h < 20) return; // 太小的不折叠
  msg.dataset.collapsed = 'true';
  msg.dataset.collapsedHeight = h + 'px';
  msg.style.minHeight = h + 'px';
  msg.style.maxHeight = h + 'px';
  msg.style.overflow = 'hidden';
  // 隐藏子元素（保留 DOM 结构，不破坏事件监听）
  var children = msg.children;
  for (var i = 0; i < children.length; i++) {
    children[i].style.visibility = 'hidden';
  }
  // 显示折叠占位提示
  if (!msg.querySelector('.collapse-placeholder')) {
    var ph = document.createElement('div');
    ph.className = 'collapse-placeholder';
    ph.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'
      + 'font-size:12px;color:var(--text-secondary);cursor:pointer;z-index:1;'
      + 'background:var(--bg-secondary,#1e293b);padding:4px 12px;border-radius:12px;'
      + 'border:1px solid var(--border,#334155);opacity:0.8;';
    ph.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;">unfold_more</span> '
      + '<span>\u70b9\u51fb\u5c55\u5f00</span>';
    ph.onclick = function(e) {
      e.stopPropagation();
      expandMessage(msg);
    };
    msg.style.position = 'relative';
    msg.appendChild(ph);
  }
}

function expandMessage(msg) {
  if (msg.dataset.collapsed !== 'true') return;
  msg.dataset.collapsed = 'false';
  msg.style.minHeight = '';
  msg.style.maxHeight = '';
  msg.style.overflow = '';
  var children = msg.children;
  for (var i = 0; i < children.length; i++) {
    children[i].style.visibility = '';
  }
  var ph = msg.querySelector('.collapse-placeholder');
  if (ph) ph.remove();
}

// 兼容旧版调用
function optimizeMessageRender(container) {
  var c = container || _dom.chatContainer;
  if (!c) return;
  var msgs = c.querySelectorAll('.msg');
  if (msgs.length <= PERF_CONFIG.maxRenderedMessages) return;
  // 如果虚拟滚动未启用，尝试启用
  if (!_virtualState.enabled) {
    enableVirtualScrolling(c);
  }
}

// ================================================================
//  2. 消息懒加载（向上滚动加载更多）
// ================================================================
function enableLazyLoading(container) {
  if (!container) container = _dom.chatContainer || document.getElementById('chatContainer');
  if (!container || _lazyState.sentinel) return;
  _dom.chatContainer = container;

  // 创建顶部哨兵元素
  var sentinel = document.createElement('div');
  sentinel.id = 'lazy-load-sentinel';
  sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;';
  container.insertBefore(sentinel, container.firstChild);
  _lazyState.sentinel = sentinel;

  // IntersectionObserver 检测滚动到顶部
  var loadObserver = new IntersectionObserver(function(entries) {
    if (entries[0] && entries[0].isIntersecting && !_lazyState.isLoading) {
      loadMoreMessages();
    }
  }, { root: container, rootMargin: '100px 0px 0px 0px', threshold: 0 });
  loadObserver.observe(sentinel);

  console.log('\u26a1 \u6d88\u606f\u61d2\u52a0\u8f7d\u5df2\u542f\u7528');
}

function loadMoreMessages() {
  if (!Core || !Core.session) return;
  var currentId = Core.session.getCurrentId ? Core.session.getCurrentId() : null;
  if (!currentId) return;
  var session = Core.session.sessions ? Core.session.sessions[currentId] : null;
  if (!session || !session.messages) return;

  var total = session.messages.length;
  var container = _dom.chatContainer;
  if (!container) return;

  var currentRendered = container.querySelectorAll('.msg').length;
  if (currentRendered >= total) return; // 已全部加载

  _lazyState.isLoading = true;
  stats.lazyLoadsTriggered++;

  var prevScrollHeight = container.scrollHeight;
  var batch = PERF_CONFIG.lazyLoadBatch;
  var startIdx = Math.max(0, total - currentRendered - batch);
  var endIdx = total - currentRendered;

  // 在顶部插入更多消息
  if (Core.session.renderSingleMessage) {
    // 使用临时容器渲染消息（renderSingleMessage 直接 appendChild 到容器）
    var tempContainer = document.createElement('div');
    tempContainer.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;';
    document.body.appendChild(tempContainer);

    var sentinel = _lazyState.sentinel;
    for (var i = startIdx; i < endIdx; i++) {
      var msg = session.messages[i];
      if (!msg) continue;
      Core.session.renderSingleMessage(msg, i, tempContainer);
    }

    // 将渲染的消息移到 document fragment
    var fragment = document.createDocumentFragment();
    while (tempContainer.firstChild) {
      fragment.appendChild(tempContainer.firstChild);
    }
    document.body.removeChild(tempContainer);

    // 在哨兵之后插入
    if (sentinel && sentinel.nextSibling) {
      container.insertBefore(fragment, sentinel.nextSibling);
    } else {
      container.appendChild(fragment);
    }

    // 保持滚动位置
    requestAnimationFrame(function() {
      var newScrollHeight = container.scrollHeight;
      container.scrollTop += (newScrollHeight - prevScrollHeight);
      _lazyState.isLoading = false;

      // 对新消息启用虚拟滚动观察
      if (_virtualState.observer) {
        var newMsgs = container.querySelectorAll('.msg');
        for (var j = startIdx; j < endIdx && j < newMsgs.length; j++) {
          _virtualState.observer.observe(newMsgs[j]);
        }
      }
    });
  } else {
    _lazyState.isLoading = false;
  }
}

function createMessageElement(msg, index) {
  // 复用 session.js 的渲染逻辑 — 创建简易消息 DOM
  if (!msg || !msg.content) return null;
  var div = document.createElement('div');
  div.className = 'msg ' + (msg.role || 'ai');
  var content = msg.content || '';
  try {
    if (window.marked && window.marked.parse) {
      content = Core.renderMarkdown(content);
    }
  } catch (e) {}
  div.innerHTML = '<div class="msg-container">'
    + '<div class="msg-avatar">' + (msg.role === 'user' ? '\ud83d\udc64' : '\ud83e\udd16') + '</div>'
    + '<div class="msg-content">' + content + '</div>'
    + '</div>';
  return div;
}

// ================================================================
//  3. 崩溃恢复（草稿自动保存 + 生成中断恢复）
// ================================================================
function setupCrashRecovery() {
  // 3a. 草稿自动保存（每 3 秒检查输入框变化）
  _recovery.draftTimer = setInterval(function() {
    saveDraft();
  }, PERF_CONFIG.draftSaveInterval);

  // 3b. 页面关闭/崩溃前刷新所有挂起的保存
  window.addEventListener('beforeunload', function() {
    flushDraft();
    flushPendingSaves();
    saveGenerationState();
  });

  // 3c. 可见性变化时保存（切换窗口、最小化）
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      flushDraft();
      flushPendingSaves();
    }
  });

  // 3d. 启动时检查崩溃恢复数据
  setTimeout(function() {
    checkCrashRecovery();
  }, 3000);

  console.log('\u26a1 \u5d29\u6e83\u6062\u590d\u673a\u5236\u5df2\u542f\u7528');
}

function saveDraft() {
  try {
    var input = _dom.input || document.getElementById('input');
    if (!input) return;
    var text = input.value || '';
    if (text === _recovery.lastDraft) return; // 未变化，跳过
    _recovery.lastDraft = text;

    var currentSessionId = null;
    if (Core.session && Core.session.getCurrentId) {
      currentSessionId = Core.session.getCurrentId();
    }

    var recoveryData = {
      draft: text,
      sessionId: currentSessionId,
      timestamp: Date.now(),
      scrollPosition: 0,
    };

    // 保存滚动位置
    var container = _dom.chatContainer || document.getElementById('chatContainer');
    if (container) {
      recoveryData.scrollPosition = container.scrollTop;
    }

    // 保存生成状态（如果正在生成）
    if (Core.api && Core.api.isGenerating && Core.api.isGenerating()) {
      recoveryData.generating = true;
      recoveryData.generationText = getLastPartialReply();
    }

    var recoveryPath = path.join(Core.DATA_ROOT || '', PERF_CONFIG.crashRecoveryFile);
    fs.writeFileSync(recoveryPath, JSON.stringify(recoveryData, null, 2));
    stats.draftsSaved++;
  } catch (e) {
    // 静默失败
  }
}

function flushDraft() {
  try {
    saveDraft();
  } catch (e) {}
}

function flushPendingSaves() {
  try {
    // 强制保存所有有挂起 debounce 的会话
    if (Core.session && Core.session.sessions) {
      var sessions = Core.session.sessions;
      Object.keys(sessions).forEach(function(id) {
        if (Core.session.saveSession) {
          try { Core.session.saveSession(id); } catch (e) {}
        }
      });
    }
  } catch (e) {}
}

function saveGenerationState() {
  try {
    if (!Core.api || !Core.api.isGenerating || !Core.api.isGenerating()) return;
    var state = {
      generating: true,
      sessionId: Core.session.getCurrentId ? Core.session.getCurrentId() : null,
      partialText: getLastPartialReply(),
      timestamp: Date.now(),
    };
    var statePath = path.join(Core.DATA_ROOT || '', 'generation-state.json');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[Performance] Failed to save generation state:', e.message);
  }
}

function getLastPartialReply() {
  try {
    var container = _dom.chatContainer || document.getElementById('chatContainer');
    if (!container) return '';
    var msgs = container.querySelectorAll('.msg.ai');
    if (msgs.length === 0) return '';
    var lastMsg = msgs[msgs.length - 1];
    var contentEl = lastMsg.querySelector('.msg-content');
    return contentEl ? (contentEl.textContent || '').trim() : '';
  } catch (e) {
    return '';
  }
}

function checkCrashRecovery() {
  try {
    var recoveryPath = path.join(Core.DATA_ROOT || '', PERF_CONFIG.crashRecoveryFile);
    if (!fs.existsSync(recoveryPath)) return;

    var data = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
    if (!data || !data.timestamp) return;

    // 恢复数据过期检查（超过 24 小时的丢弃）
    var age = Date.now() - data.timestamp;
    if (age > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(recoveryPath);
      return;
    }

    // 恢复草稿
    if (data.draft && data.draft.length > 0) {
      var input = document.getElementById('input');
      if (input && !input.value) {
        input.value = data.draft;
        _recovery.lastDraft = data.draft;
        console.log('\u26a1 \u5df2\u6062\u590d\u8349\u7a3f\uff08' + data.draft.length + ' \u5b57\u7b26\uff09');
      }
    }

    // 恢复滚动位置
    if (data.scrollPosition && data.sessionId) {
      var currentId = Core.session.getCurrentId ? Core.session.getCurrentId() : null;
      if (currentId === data.sessionId) {
        var container = document.getElementById('chatContainer');
        if (container) {
          setTimeout(function() {
            container.scrollTop = data.scrollPosition;
          }, 500);
        }
      }
    }

    stats.crashRecoveries++;
    Core.emit && Core.emit('crashRecovered', data);

    // 检查生成中断恢复
    checkGenerationRecovery();

    // 清理恢复文件
    fs.unlinkSync(recoveryPath);
  } catch (e) {
    console.warn('\u26a0\ufe0f \u5d29\u6e83\u6062\u590d\u68c0\u67e5\u5931\u8d25:', e.message);
  }
}

function checkGenerationRecovery() {
  try {
    var statePath = path.join(Core.DATA_ROOT || '', 'generation-state.json');
    if (!fs.existsSync(statePath)) return;

    var state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state || !state.generating || !state.partialText) {
      fs.unlinkSync(statePath);
      return;
    }

    // 检查是否还是同一个会话
    var currentId = Core.session.getCurrentId ? Core.session.getCurrentId() : null;
    if (state.sessionId === currentId && state.partialText) {
      // 提示用户上次生成被中断
      var notice = '\u26a0\ufe0f \u4e0a\u6b21\u751f\u6210\u88ab\u4e2d\u65ad\uff0c\u5df2\u6062\u590d\u90e8\u5206\u5185\u5bb9\uff08' + state.partialText.length + ' \u5b57\u7b26\uff09\u3002\u4f60\u53ef\u4ee5\u7ee7\u7eed\u751f\u6210\u6216\u91cd\u65b0\u53d1\u9001\u3002';
      if (Core.session && Core.session.addMessage) {
        Core.session.addMessage(notice, 'ai');
      }
    }

    fs.unlinkSync(statePath);
  } catch (e) {}
}

function getCrashRecovery() {
  try {
    var recoveryPath = path.join(Core.DATA_ROOT || '', PERF_CONFIG.crashRecoveryFile);
    if (!fs.existsSync(recoveryPath)) return null;
    return JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function clearCrashRecovery() {
  try {
    var recoveryPath = path.join(Core.DATA_ROOT || '', PERF_CONFIG.crashRecoveryFile);
    if (fs.existsSync(recoveryPath)) fs.unlinkSync(recoveryPath);
    var statePath = path.join(Core.DATA_ROOT || '', 'generation-state.json');
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } catch (e) {}
}

// ================================================================
//  4. 图片懒加载
// ================================================================
function lazyLoadImages(container) {
  if (!container || !PERF_CONFIG.imageLazyLoad) return;
  var images = container.querySelectorAll('img[data-src]');
  if (images.length === 0) return;

  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var img = entry.target;
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
        observer.unobserve(img);
      }
    });
  }, { rootMargin: '200px' });

  images.forEach(function(img) { observer.observe(img); });
}

// ================================================================
//  5. 图片压缩
// ================================================================
function compressImage(file, maxSize) {
  maxSize = maxSize || PERF_CONFIG.maxImageSize;
  if (file.size <= maxSize) return Promise.resolve(file);

  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var width = img.width;
        var height = img.height;
        var scale = Math.sqrt(maxSize / file.size);
        if (scale < 1) {
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(function(blob) {
          var compressed = new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
          resolve(compressed);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ================================================================
//  6. 内存管理
// ================================================================
function monitorMemory() {
  if (!performance.memory) return null;
  var memory = performance.memory;
  stats.memoryUsage = memory.usedJSHeapSize;

  var usedMB = (memory.usedJSHeapSize / 1048576).toFixed(1);
  var totalMB = (memory.totalJSHeapSize / 1048576).toFixed(1);
  var limitMB = (memory.jsHeapSizeLimit / 1048576).toFixed(1);
  var ratio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;

  if (ratio > 0.8) {
    console.warn('\u26a0\ufe0f \u5185\u5b58\u4f7f\u7528\u8fc7\u9ad8: ' + usedMB + 'MB / ' + limitMB + 'MB\uff08' + (ratio * 100).toFixed(0) + '%\uff09');
    triggerGC();
  }

  return { usedMB: usedMB, totalMB: totalMB, limitMB: limitMB, ratio: (ratio * 100).toFixed(1) };
}

function triggerGC() {
  stats.gcTriggered++;

  // 1. 清理离线 blob URL
  document.querySelectorAll('img[src^="blob:"]').forEach(function(img) {
    if (!img.isConnected) {
      try { URL.revokeObjectURL(img.src); } catch (e) {}
    }
  });

  // 2. 清理旧消息
  if (Core && Core.session && Core.session.sessions) {
    var sessions = Core.session.sessions;
    Object.keys(sessions).forEach(function(sessionId) {
      cleanupOldMessages(sessionId, PERF_CONFIG.maxMessagesPerSession);
    });
  }

  // 3. 清理已分离的 DOM 节点引用
  if (_virtualState.observer) {
    // observer 本身不持有强引用，但确保没有僵尸节点
  }

  // 4. 建议浏览器 GC
  if (window.gc) {
    try { window.gc(); } catch (e) {}
  }
}

function cleanupOldMessages(sessionId, keepCount) {
  keepCount = keepCount || 100;
  try {
    if (!Core || !Core.session || !Core.session.sessions) return;
    var session = Core.session.sessions[sessionId];
    if (!session || !session.messages) return;
    if (session.messages.length <= keepCount) return;

    var oldMessages = session.messages.slice(0, -keepCount);
    session.messages = session.messages.slice(-keepCount);

    var archivePath = path.join(Core.DATA_ROOT || '', 'archives', sessionId + '_' + Date.now() + '.json');
    try {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, JSON.stringify(oldMessages, null, 2));
    } catch (e) {
      console.warn('[Performance] Archive write failed:', e.message);
    }

    Core.emit && Core.emit('messagesArchived', { sessionId: sessionId, count: oldMessages.length });
  } catch (e) {
    console.warn('\u26a0\ufe0f \u6e05\u7406\u65e7\u6d88\u606f\u5931\u8d25:', e.message);
  }
}

// ================================================================
//  7. 会话归档
// ================================================================
function archiveOldSessions(maxAge) {
  maxAge = maxAge || PERF_CONFIG.maxArchivedAge;
  try {
    if (!Core || !Core.session || !Core.session.sessions) return;
    var sessions = Core.session.sessions;
    var now = Date.now();
    var archived = 0;

    Object.keys(sessions).forEach(function(id) {
      var session = sessions[id];
      var lastActive = session.timestamp || session.createdAt || now;
      if (now - lastActive > maxAge && !session.pinned) {
        var archivePath = path.join(Core.DATA_ROOT || '', 'archives', 'session_' + id + '_' + Date.now() + '.json');
        try {
          fs.mkdirSync(path.dirname(archivePath), { recursive: true });
          fs.writeFileSync(archivePath, JSON.stringify(session, null, 2));
          delete sessions[id];
          archived++;
        } catch (e) {
          console.warn('[Performance] Archive write failed:', e.message);
        }
      }
    });

    if (archived > 0) {
      stats.archiveCount += archived;
      // 逐个保存受影响的会话
      if (Core.session && Core.session.saveSession) {
        Object.keys(sessions).forEach(function(sid) {
          try { Core.session.saveSession(sid); } catch (e) {}
        });
      }
      // 刷新侧边栏
      if (Core.session && Core.session.renderChatList) {
        Core.session.renderChatList();
      }
    }
  } catch (e) {
    console.warn('\u26a0\ufe0f \u5f52\u6863\u65e7\u4f1a\u8bdd\u5931\u8d25:', e.message);
  }
}

// ================================================================
//  8. 性能采样与监控
// ================================================================
function setupPerfMonitoring() {
  _perfTimer = setInterval(function() {
    var sample = {
      time: Date.now(),
      domNodes: document.querySelectorAll('*').length,
      memory: null,
      renderTime: stats.renderTimes.length > 0
        ? stats.renderTimes.reduce(function(a, b) { return a + b; }, 0) / stats.renderTimes.length
        : 0,
    };

    if (performance.memory) {
      sample.memory = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
    }

    stats.perfSamples.push(sample);
    if (stats.perfSamples.length > PERF_CONFIG.maxPerfSamples) {
      stats.perfSamples.shift();
    }

    // 清空渲染时间采样
    stats.renderTimes = [];
  }, PERF_CONFIG.perfSampleInterval);
}

function getPerfHistory() {
  return stats.perfSamples.slice();
}

// ================================================================
//  9. 启动优化
// ================================================================
function setupPerformanceOptimizations() {
  // 缓存 DOM 引用
  setTimeout(function() {
    _dom.chatContainer = document.getElementById('chatContainer');
    _dom.input = document.getElementById('input');
  }, 500);

  // 定期内存清理
  _gcTimer = setInterval(function() {
    monitorMemory();
  }, PERF_CONFIG.gcInterval);

  // 延迟归档旧会话（启动后 15 秒）
  setTimeout(function() {
    archiveOldSessions();
  }, 15000);

  // 延迟启用虚拟滚动（启动后 3 秒）
  setTimeout(function() {
    var chatContainer = document.getElementById('chatContainer');
    if (chatContainer) {
      enableVirtualScrolling(chatContainer);
      enableLazyLoading(chatContainer);

      // 会话切换检测：chatContainer 被清空后重建时，重新初始化懒加载哨兵
      var clearDetectObserver = new MutationObserver(function(mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var mut = mutations[m];
          // 大量子节点被移除 = 会话切换（innerHTML 清空）
          if (mut.removedNodes.length > 5) {
            // 短暂延迟等新消息渲染完毕
            setTimeout(function() {
              if (!document.getElementById('lazy-load-sentinel')) {
                enableLazyLoading(chatContainer);
              }
            }, 200);
            break;
          }
        }
      });
      clearDetectObserver.observe(chatContainer, { childList: true });
    }
  }, 3000);

  // 图片懒加载 — MutationObserver 自动处理
  setTimeout(function() {
    var container = document.getElementById('chatContainer');
    if (!container) return;
    lazyLoadImages(container);
    var imgObserver = new MutationObserver(function() {
      lazyLoadImages(container);
    });
    imgObserver.observe(container, { childList: true, subtree: true });
  }, 2000);

  // 预热 marked 解析器
  if (window.marked && window.marked.parse) {
    try { window.marked.parse('warmup'); } catch (e) {}
  }

  console.log('\u26a1 \u6027\u80fd\u4f18\u5316\u5df2\u542f\u52a8');
}

// ================================================================
//  10. 统计信息
// ================================================================
function getStats() {
  var domNodes = document.querySelectorAll('*').length;
  var memory = monitorMemory();
  return {
    startTime: stats.startTime,
    messageCount: stats.messageCount,
    domNodes: domNodes,
    memory: memory,
    uptime: ((performance.now() - stats.startTime) / 1000).toFixed(1),
  };
}

function getDetailedStats() {
  var basic = getStats();
  var sessionCount = 0;
  var totalMessages = 0;
  if (Core && Core.session && Core.session.sessions) {
    var sessions = Core.session.sessions;
    sessionCount = Object.keys(sessions).length;
    Object.values(sessions).forEach(function(s) {
      totalMessages += (s.messages ? s.messages.length : 0);
    });
  }

  var avgRenderTime = 0;
  if (stats.perfSamples.length > 0) {
    var renderTimes = stats.perfSamples
      .filter(function(s) { return s.renderTime > 0; })
      .map(function(s) { return s.renderTime; });
    if (renderTimes.length > 0) {
      avgRenderTime = renderTimes.reduce(function(a, b) { return a + b; }, 0) / renderTimes.length;
    }
  }

  // 内存趋势
  var memTrend = 'N/A';
  if (stats.perfSamples.length >= 2) {
    var recent = stats.perfSamples.slice(-10);
    var memValues = recent.filter(function(s) { return s.memory; }).map(function(s) { return parseFloat(s.memory); });
    if (memValues.length >= 2) {
      var first = memValues[0];
      var last = memValues[memValues.length - 1];
      var diff = last - first;
      if (diff > 5) memTrend = '\u2191 +' + diff.toFixed(1) + 'MB';
      else if (diff < -5) memTrend = '\u2193 ' + diff.toFixed(1) + 'MB';
      else memTrend = '\u2192 \u7a33\u5b9a';
    }
  }

  // DOM 节点趋势
  var domTrend = 'N/A';
  if (stats.perfSamples.length >= 2) {
    var recentDom = stats.perfSamples.slice(-10);
    var domValues = recentDom.filter(function(s) { return s.domNodes; }).map(function(s) { return s.domNodes; });
    if (domValues.length >= 2) {
      var firstD = domValues[0];
      var lastD = domValues[domValues.length - 1];
      var diffD = lastD - firstD;
      if (diffD > 100) domTrend = '\u2191 +' + diffD;
      else if (diffD < -100) domTrend = '\u2193 ' + diffD;
      else domTrend = '\u2192 \u7a33\u5b9a';
    }
  }

  return {
    uptime: basic.uptime,
    sessions: sessionCount,
    totalMessages: totalMessages,
    domNodes: basic.domNodes,
    memory: basic.memory,
    memoryTrend: memTrend,
    domTrend: domTrend,
    avgRenderTime: avgRenderTime.toFixed(2),
    gcTriggered: stats.gcTriggered,
    draftsSaved: stats.draftsSaved,
    crashRecoveries: stats.crashRecoveries,
    lazyLoadsTriggered: stats.lazyLoadsTriggered,
    archiveCount: stats.archiveCount,
    virtualScrollEnabled: _virtualState.enabled,
    lazyLoadEnabled: !!_lazyState.sentinel,
    perfSamples: stats.perfSamples.length,
  };
}

// ================================================================
//  11. /perf 命令
// ================================================================
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('perf', {
    zh: '\u6027\u80fd\u76d1\u63a7\u4eea\u8868\u76d8: /perf [history|clear]',
    en: 'Performance dashboard'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'dashboard';

    if (sub === 'history') {
      showPerfHistory();
    } else if (sub === 'clear') {
      stats.perfSamples = [];
      stats.renderTimes = [];
      Core.session.addMessage('\u2705 \u6027\u80fd\u91c7\u6837\u5386\u53f2\u5df2\u6e05\u7a7a', 'ai');
    } else {
      showPerfDashboard();
    }
  });
}

function showPerfDashboard() {
  var d = getDetailedStats();
  var mem = d.memory || {};
  var uptimeMin = (parseFloat(d.uptime) / 60).toFixed(1);

  var text = '## \u26a1 \u6027\u80fd\u76d1\u63a7\u4eea\u8868\u76d8\n\n'
    + '**\u8fd0\u884c\u72b6\u6001**\n'
    + '- \u8fd0\u884c\u65f6\u95f4: ' + d.uptime + 's (' + uptimeMin + 'min)\n'
    + '- \u4f1a\u8bdd\u6570: ' + d.sessions + '\n'
    + '- \u6d88\u606f\u603b\u6570: ' + d.totalMessages + '\n\n'
    + '**\u5185\u5b58**\n'
    + '- \u5df2\u7528: ' + (mem.usedMB || 'N/A') + 'MB / ' + (mem.limitMB || 'N/A') + 'MB (' + (mem.ratio || 0) + '%)\n'
    + '- \u8d8b\u52bf: ' + d.memoryTrend + '\n\n'
    + '**DOM**\n'
    + '- \u8282\u70b9\u6570: ' + d.domNodes + '\n'
    + '- \u8d8b\u52bf: ' + d.domTrend + '\n'
    + '- \u5e73\u5747\u6e32\u67d3\u65f6\u95f4: ' + d.avgRenderTime + 'ms\n\n'
    + '**\u4f18\u5316\u529f\u80fd**\n'
    + '- \u865a\u62df\u6eda\u52a8: ' + (d.virtualScrollEnabled ? '\u2705 \u5df2\u542f\u7528' : '\u274c \u672a\u542f\u7528') + '\n'
    + '- \u61d2\u52a0\u8f7d: ' + (d.lazyLoadEnabled ? '\u2705 \u5df2\u542f\u7528' : '\u274c \u672a\u542f\u7528') + '\n\n'
    + '**\u7edf\u8ba1**\n'
    + '- GC \u89e6\u53d1: ' + d.gcTriggered + ' \u6b21\n'
    + '- \u8349\u7a3f\u4fdd\u5b58: ' + d.draftsSaved + ' \u6b21\n'
    + '- \u5d29\u6e83\u6062\u590d: ' + d.crashRecoveries + ' \u6b21\n'
    + '- \u61d2\u52a0\u8f7d\u89e6\u53d1: ' + d.lazyLoadsTriggered + ' \u6b21\n'
    + '- \u4f1a\u8bdd\u5f52\u6863: ' + d.archiveCount + ' \u4e2a\n'
    + '- \u91c7\u6837\u70b9: ' + d.perfSamples + '\n';

  if (Core.session && Core.session.addMessage) {
    Core.session.addMessage(text, 'ai');
  }
}

function showPerfHistory() {
  var samples = stats.perfSamples;
  if (samples.length === 0) {
    Core.session.addMessage('\u6682\u65e0\u6027\u80fd\u91c7\u6837\u6570\u636e', 'ai');
    return;
  }

  var text = '## \ud83d\udcc8 \u6027\u80fd\u91c7\u6837\u5386\u53f2\n\n'
    + '| \u65f6\u95f4 | DOM\u8282\u70b9 | \u5185\u5b58(MB) | \u6e32\u67d3(ms) |\n'
    + '|--------|----------|----------|----------|\n';

  samples.forEach(function(s) {
    var time = new Date(s.time).toLocaleTimeString('zh-CN');
    text += '| ' + time + ' | ' + s.domNodes + ' | ' + (s.memory || 'N/A') + ' | ' + (s.renderTime || 0).toFixed(1) + ' |\n';
  });

  if (Core.session && Core.session.addMessage) {
    Core.session.addMessage(text, 'ai');
  }
}

// ================================================================
//  Phase 5-1: 审计修复 — 知识库缓存 + 流式DOM优化 + 消息内存上限 + 异步保存队列
// ================================================================

// ----- 5a: 知识库分块内存缓存 (修复 audit #10: loadAllChunks 每次搜索都重读文件) -----
var _knowledgeChunkCache = null;
var _knowledgeCacheTime = 0;
var KNOWLEDGE_CACHE_TTL = 60000; // 60秒缓存

function getCachedKnowledgeChunks() {
  var now = Date.now();
  if (_knowledgeChunkCache && (now - _knowledgeCacheTime) < KNOWLEDGE_CACHE_TTL) {
    return _knowledgeChunkCache;
  }
  // 重新加载
  if (Core.knowledge && Core.knowledge.loadAllChunks) {
    try {
      _knowledgeChunkCache = Core.knowledge.loadAllChunks();
      _knowledgeCacheTime = now;
    } catch (e) {
      _knowledgeChunkCache = [];
    }
  }
  return _knowledgeChunkCache || [];
}

function invalidateKnowledgeCache() {
  _knowledgeChunkCache = null;
  _knowledgeCacheTime = 0;
}

// ----- 5b: 流式 DOM 增量优化 (修复 audit #5: 每帧全量 marked.parse) -----
var _streamingState = {
  active: false,
  lastParsedLength: 0,
  pendingChunks: [],
  parseTimer: null,
  PARSE_DEBOUNCE_MS: 80, // 80ms 防抖，约12fps
};

function optimizeStreamingUpdate(aiDiv, fullText, isNewChunk) {
  if (!aiDiv) return;

  // 流式模式：只在防抖结束时做一次完整 parse
  _streamingState.active = true;
  _streamingState.pendingChunks.push(fullText);

  if (_streamingState.parseTimer) clearTimeout(_streamingState.parseTimer);

  _streamingState.parseTimer = setTimeout(function() {
    _streamingState.parseTimer = null;
    var latestText = _streamingState.pendingChunks[_streamingState.pendingChunks.length - 1] || '';
    _streamingState.pendingChunks = [];
    _streamingState.lastParsedLength = latestText.length;

    // 只对增量部分做 parse（如果增长不多，用 append 模式）
    try {
      var html = typeof marked !== 'undefined' ? Core.renderMarkdown(latestText) : escapeHtmlSimple(latestText);
      aiDiv.innerHTML = html + '<span class="typing-cursor"></span>';
    } catch (e) {
      aiDiv.innerHTML = escapeHtmlSimple(latestText) + '<span class="typing-cursor"></span>';
    }
  }, _streamingState.PARSE_DEBOUNCE_MS);
}

function endStreamingOptimization(aiDiv, finalText) {
  _streamingState.active = false;
  if (_streamingState.parseTimer) {
    clearTimeout(_streamingState.parseTimer);
    _streamingState.parseTimer = null;
  }
  _streamingState.pendingChunks = [];
  _streamingState.lastParsedLength = 0;

  // 最终完整 parse
  if (aiDiv && finalText) {
    try {
      var html = typeof marked !== 'undefined' ? Core.renderMarkdown(finalText) : escapeHtmlSimple(finalText);
      aiDiv.innerHTML = html;
    } catch (e) {
      aiDiv.innerHTML = escapeHtmlSimple(finalText);
    }
  }
}

function escapeHtmlSimple(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ----- 5c: 会话消息内存上限 (修复 audit #2: messages 数组无限增长) -----
var MESSAGE_MEMORY_CAP = 500; // 每个会话内存最多保留500条消息

function capSessionMessages(session) {
  if (!session || !session.messages) return;
  if (session.messages.length <= MESSAGE_MEMORY_CAP) return;

  var overflow = session.messages.length - MESSAGE_MEMORY_CAP;
  // 保留最新的消息，丢弃最旧的
  session.messages = session.messages.slice(-MESSAGE_MEMORY_CAP);
  session._messagesTruncated = overflow;
}

function capAllSessions() {
  if (!Core.session || !Core.session.sessions) return;
  var sessions = Core.session.sessions;
  var totalTruncated = 0;
  Object.keys(sessions).forEach(function(id) {
    var s = sessions[id];
    if (s.messages && s.messages.length > MESSAGE_MEMORY_CAP) {
      var overflow = s.messages.length - MESSAGE_MEMORY_CAP;
      s.messages = s.messages.slice(-MESSAGE_MEMORY_CAP);
      s._messagesTruncated = overflow;
      totalTruncated += overflow;
    }
  });
  if (totalTruncated > 0) {
    // silently capped
  }
}

// ----- 5d: 异步保存队列 (修复 audit #3: 同步 writeFileSync 阻塞渲染线程) -----
var _saveQueue = [];
var _saveProcessing = false;
var _saveDebounceTimer = null;
var SAVE_DEBOUNCE_MS = 2000; // 2秒批量写入

function queueAsyncSave(sessionId, saveFn) {
  _saveQueue.push({ id: sessionId, fn: saveFn, time: Date.now() });

  // 防抖：2秒内的保存请求批量执行
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(function() {
    _saveDebounceTimer = null;
    processSaveQueue();
  }, SAVE_DEBOUNCE_MS);
}

function processSaveQueue() {
  if (_saveProcessing || _saveQueue.length === 0) return;
  _saveProcessing = true;

  // 去重：同一 sessionId 只保留最后一个保存
  var dedup = {};
  _saveQueue.forEach(function(item) { dedup[item.id] = item; });
  _saveQueue = [];

  var items = Object.values(dedup);
  var done = 0;

  items.forEach(function(item) {
    try {
      // 使用 setImmediate 分批执行，避免长时间阻塞
      if (typeof setImmediate !== 'undefined') {
        setImmediate(function() {
          try { item.fn(); } catch (e) { console.warn('异步保存失败 (' + item.id + '):', e); }
          done++;
          if (done >= items.length) _saveProcessing = false;
        });
      } else {
        item.fn();
        done++;
      }
    } catch (e) {
      console.warn('保存队列处理失败:', e);
      done++;
    }
  });

  if (done >= items.length) _saveProcessing = false;
}

// ----- 5e: TTS 按钮事件委托 (修复 audit #11: 每条消息独立监听器) -----
var _ttsDelegated = false;

function setupTTSDelegation() {
  if (_ttsDelegated) return;
  var chatContainer = document.getElementById('chatContainer') || document.getElementById('chatArea');
  if (!chatContainer) return;

  chatContainer.addEventListener('click', function(e) {
    var btn = e.target.closest('.tts-btn');
    if (!btn) return;
    e.stopPropagation();
    var msgDiv = btn.closest('.msg-ai, .ai-message, [data-role="assistant"]');
    if (!msgDiv) return;
    var text = msgDiv.textContent || '';
    if (Core.voice && Core.voice.speak) {
      Core.voice.speak(text.substring(0, 2000));
    } else if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(text.substring(0, 2000));
      utter.lang = 'zh-CN';
      speechSynthesis.speak(utter);
    }
  });

  _ttsDelegated = true;
}

// ----- 5f: 定期执行内存清理 -----
function startMemoryCleanup() {
  _memCleanupTimer = setInterval(function() {
    // 1. 消息内存上限
    capAllSessions();
    // 2. 知识库缓存过期
    if (_knowledgeChunkCache && (Date.now() - _knowledgeCacheTime) > KNOWLEDGE_CACHE_TTL * 2) {
      invalidateKnowledgeCache();
    }
    // 3. 后台任务清理
    if (Core.api && Core.api.getBackgroundTasks) {
      // getBackgroundTasks 内部已有5秒自动清理
    }
    stats.gcTriggered++;
  }, PERF_CONFIG.gcInterval);
}

// 在 setupPerformanceOptimizations 中调用
var _origSetup = setupPerformanceOptimizations;
setupPerformanceOptimizations = function() {
  _origSetup();
  setupTTSDelegation();
  startMemoryCleanup();
};

module.exports = { init: init };
