// modules/autocomplete.js - 智能提示与自动补全模块
// 命令补全（/）、会话提及（@）、上下文预测、Tab 键接受

let Core = null;

// ===== 补全建议面板 =====
var _suggestEl = null;
var _suggestItems = [];
var _selectedIdx = -1;
var _isActive = false;

// ===== 命令注册表（缓存）=====
var _commandCache = null;

function _getRegisteredCommands() {
  if (_commandCache) return _commandCache;
  _commandCache = [];
  if (Core.custom && Core.custom._commands) {
    for (var name in Core.custom._commands) {
      var cmd = Core.custom._commands[name];
      _commandCache.push({
        name: '/' + name,
        desc: cmd.description || '',
        type: 'command'
      });
    }
  }
  // 内置命令（可能未注册到 _commands）
  var builtins = [
    { name: '/agent', desc: 'Agent 模式（自主调用工具）' },
    { name: '/memory', desc: '记忆管理' },
    { name: '/context', desc: '上下文窗口状态' },
    { name: '/url', desc: '抓取网页内容' },
    { name: '/kb', desc: '知识库操作 (search/import/list)' },
    { name: '/voice', desc: '语音控制 (auto/profiles/set)' },
    { name: '/vision', desc: '图片理解分析' },
    { name: '/ocr', desc: '图片文字识别' },
    { name: '/screenshot', desc: '截屏分析' },
    { name: '/draw', desc: 'AI 生成图片' },
    { name: '/video', desc: 'AI 生成视频' },
    { name: '/workflow', desc: '工作流管理' },
    { name: '/template', desc: '会话模板管理' },
    { name: '/rule', desc: '自动回复规则' },
    { name: '/schedule', desc: '定时任务' },
    { name: '/remind', desc: '快速提醒' },
    { name: '/tasks', desc: '查看后台任务' },
    { name: '/dispatch', desc: '并行分发到多个角色' },
    { name: '/analytics', desc: '数据分析仪表盘' },
    { name: '/stats', desc: '今日快速统计' },
    { name: '/knowledge', desc: '知识库管理' },
    { name: '/perf', desc: '性能监控' },
    { name: '/skill', desc: '技能管理' },
    { name: '/git', desc: 'Git 操作' },
    { name: '/batch', desc: '批量操作' },
    { name: '/summary', desc: '会话摘要' },
    { name: '/bookmarks', desc: '书签管理' },
    { name: '/tags', desc: '会话标签' },
  ];
  builtins.forEach(function(b) {
    var exists = _commandCache.some(function(c) { return c.name === b.name; });
    if (!exists) _commandCache.push({ name: b.name, desc: b.desc, type: 'command' });
  });
  return _commandCache;
}

// ===== 获取会话建议 =====
function _getSessionSuggestions(query) {
  var results = [];
  if (!Core.session || !Core.session.sessions) return results;
  var lower = query.toLowerCase();
  for (var sid in Core.session.sessions) {
    var s = Core.session.sessions[sid];
    var title = (s.title || '').toLowerCase();
    if (title.indexOf(lower) >= 0 || (s.roleType && s.roleType.indexOf(lower) >= 0)) {
      results.push({
        name: '@' + (s.title || '未命名'),
        desc: s.roleType || 'chat',
        type: 'session',
        sessionId: sid
      });
    }
  }
  return results.slice(0, 8);
}

// ===== 上下文预测（基于最近消息）=====
function _getContextPredictions(input) {
  var predictions = [];
  if (!input || input.length < 2) return predictions;

  // 常见模式匹配
  var patterns = [
    { regex: /^(帮我|请|麻烦)/, suggestions: ['写一段', '翻译', '总结', '分析', '优化'] },
    { regex: /^(怎么|如何|为什么)/, suggestions: ['实现', '使用', '配置', '安装', '解决'] },
    { regex: /python|javascript|java|代码/i, suggestions: ['函数', '类', '模块', '示例代码'] },
    { regex: /^(翻译|translate)/i, suggestions: ['成英文', '成日文', '成中文'] },
  ];

  patterns.forEach(function(p) {
    if (p.regex.test(input)) {
      p.suggestions.forEach(function(s) {
        predictions.push({ name: s, desc: '预测补全', type: 'prediction' });
      });
    }
  });

  return predictions.slice(0, 5);
}

// ===== 模糊匹配 =====
function _fuzzyMatch(query, text) {
  if (!query) return true;
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (text.indexOf(query) >= 0) return true;
  var qi = 0;
  for (var ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

// ===== 创建补全面板 =====
function _createSuggestPanel() {
  if (_suggestEl) return;
  _suggestEl = document.createElement('div');
  _suggestEl.id = 'autocomplete-panel';
  _suggestEl.style.cssText = 'display:none;position:fixed;z-index:9999;min-width:280px;max-width:400px;max-height:250px;overflow-y:auto;background:var(--bg-primary,#1a1a1a);border:1px solid var(--border-color,#333);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);padding:4px 0;';
  document.body.appendChild(_suggestEl);

  // 注入样式
  if (!document.getElementById('autocomplete-style')) {
    var s = document.createElement('style');
    s.id = 'autocomplete-style';
    s.textContent = '.ac-item{padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;} ' +
      '.ac-item.selected{background:var(--primary-alpha,rgba(100,100,255,0.15));} ' +
      '.ac-item:hover{background:var(--primary-alpha,rgba(100,100,255,0.1));} ' +
      '.ac-name{color:var(--text-primary,#eee);font-weight:500;} ' +
      '.ac-desc{color:#888;font-size:11px;flex:1;text-align:right;} ' +
      '.ac-icon{font-size:14px;flex-shrink:0;}';
    document.head.appendChild(s);
  }
}

function _showSuggestions(items) {
  _createSuggestPanel();
  _suggestItems = items;
  _selectedIdx = items.length > 0 ? 0 : -1;
  _isActive = items.length > 0;

  if (!_isActive) {
    _suggestEl.style.display = 'none';
    return;
  }

  // 定位到输入框上方
  var input = Core.dom.input;
  if (input) {
    var rect = input.getBoundingClientRect();
    _suggestEl.style.left = rect.left + 'px';
    _suggestEl.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    _suggestEl.style.top = 'auto';
  }

  // 渲染项目
  _suggestEl.innerHTML = '';
  items.forEach(function(item, idx) {
    var div = document.createElement('div');
    div.className = 'ac-item' + (idx === _selectedIdx ? ' selected' : '');
    var icon = item.type === 'command' ? '⚡' : (item.type === 'session' ? '💬' : '💡');
    var iconSpan = document.createElement('span');
    iconSpan.className = 'ac-icon';
    iconSpan.textContent = icon;
    var nameSpan = document.createElement('span');
    nameSpan.className = 'ac-name';
    nameSpan.textContent = item.name || '';
    var descSpan = document.createElement('span');
    descSpan.className = 'ac-desc';
    descSpan.textContent = item.desc || '';
    div.appendChild(iconSpan);
    div.appendChild(nameSpan);
    div.appendChild(descSpan);
    div.addEventListener('click', function() { _acceptSuggestion(idx); });
    div.addEventListener('mouseenter', function() {
      _suggestEl.querySelectorAll('.ac-item').forEach(function(el) { el.classList.remove('selected'); });
      div.classList.add('selected');
      _selectedIdx = idx;
    });
    _suggestEl.appendChild(div);
  });

  _suggestEl.style.display = 'block';
}

function _hideSuggestions() {
  if (_suggestEl) _suggestEl.style.display = 'none';
  _isActive = false;
  _selectedIdx = -1;
}

function _acceptSuggestion(idx) {
  if (idx < 0 || idx >= _suggestItems.length) return;
  var item = _suggestItems[idx];
  var input = Core.dom.input;
  if (!input) return;

  var currentText = input.value;

  if (item.type === 'command') {
    // 替换 "/" 开头的部分为完整命令
    var slashIdx = currentText.lastIndexOf('/');
    if (slashIdx >= 0) {
      input.value = currentText.substring(0, slashIdx) + item.name + ' ';
    } else {
      input.value = item.name + ' ';
    }
  } else if (item.type === 'session') {
    // 替换 "@" 开头的部分
    var atIdx = currentText.lastIndexOf('@');
    if (atIdx >= 0) {
      input.value = currentText.substring(0, atIdx) + item.name + ' ';
    }
  } else if (item.type === 'prediction') {
    // 追加预测文本
    input.value = currentText + item.name;
  }

  _hideSuggestions();
  input.focus();
  // 移动光标到末尾
  input.setSelectionRange(input.value.length, input.value.length);
}

function _navigateSuggestions(dir) {
  if (!_isActive || _suggestItems.length === 0) return;
  var items = _suggestEl.querySelectorAll('.ac-item');
  if (items[_selectedIdx]) items[_selectedIdx].classList.remove('selected');
  _selectedIdx = (_selectedIdx + dir + _suggestItems.length) % _suggestItems.length;
  if (items[_selectedIdx]) {
    items[_selectedIdx].classList.add('selected');
    items[_selectedIdx].scrollIntoView({ block: 'nearest' });
  }
}

// ===== 输入事件处理 =====
function _handleInput() {
  var input = Core.dom.input;
  if (!input) return;
  var text = input.value;

  // 命令补全：输入 "/" 时触发
  if (text.startsWith('/') && text.length >= 1) {
    var query = text.substring(1);
    var commands = _getRegisteredCommands();
    var filtered = commands.filter(function(c) {
      return _fuzzyMatch(query, c.name.substring(1)); // 去掉 "/" 前缀匹配
    }).slice(0, 10);
    if (filtered.length > 0) {
      _showSuggestions(filtered);
      return;
    }
  }

  // 会话提及：输入 "@" 时触发
  if (text.indexOf('@') >= 0) {
    var atIdx = text.lastIndexOf('@');
    var mentionQuery = text.substring(atIdx + 1);
    if (mentionQuery.length < 20 && mentionQuery.indexOf(' ') < 0) {
      var sessions = _getSessionSuggestions(mentionQuery);
      if (sessions.length > 0) {
        _showSuggestions(sessions);
        return;
      }
    }
  }

  // 上下文预测：非 "/" 且非 "@" 开头时
  if (text.length >= 2 && !text.startsWith('/')) {
    var predictions = _getContextPredictions(text);
    if (predictions.length > 0) {
      _showSuggestions(predictions);
      return;
    }
  }

  _hideSuggestions();
}

// ===== 键盘事件拦截 =====
function _handleKeydown(e) {
  if (!_isActive) return;

  if (e.key === 'Tab') {
    e.preventDefault();
    _acceptSuggestion(_selectedIdx);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _navigateSuggestions(-1);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _navigateSuggestions(1);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    _hideSuggestions();
    return;
  }
  if (e.key === 'Enter' && _isActive && _selectedIdx >= 0) {
    // 只在命令/会话补全时拦截 Enter
    if (_suggestItems[_selectedIdx] && _suggestItems[_selectedIdx].type !== 'prediction') {
      e.preventDefault();
      _acceptSuggestion(_selectedIdx);
      return;
    }
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;

  setTimeout(function() {
    if (Core.dom && Core.dom.input) {
      Core.dom.input.addEventListener('input', _handleInput);
      Core.dom.input.addEventListener('keydown', _handleKeydown);
      // 失焦时隐藏（延迟，以允许点击建议）
      Core.dom.input.addEventListener('blur', function() {
        setTimeout(_hideSuggestions, 200);
      });
      console.log('✅ autocomplete.js 已加载 — 输入 / 查看命令补全，输入 @ 查看会话提及');
    }
  }, 500);

  Core.autocomplete = {
    show: _showSuggestions,
    hide: _hideSuggestions,
    refreshCommands: function() { _commandCache = null; },
    getSuggestions: function(text) {
      if (!text) return [];
      if (text.startsWith('/')) {
        return _getRegisteredCommands().filter(function(c) {
          return _fuzzyMatch(text.substring(1), c.name.substring(1));
        });
      }
      return [];
    }
  };
}

module.exports = { init };
