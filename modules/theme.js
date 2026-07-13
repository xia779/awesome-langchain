// modules/theme.js
let Core = null;

// 只有这些 config 键影响消息气泡/背景视觉，变更时才需要 renderMessages
var THEME_VISUAL_KEYS = {
  chatBackground: 1, chatBubbleUser: 1, chatBubbleAI: 1,
  sidebarColor: 1, panelColor: 1, accentColor: 1, textColor: 1,
  activeTheme: 1, themeMode: 1, appName: 1,
  sidebarBg: 1, panel: 1, primary: 1, text: 1
};

// 检查 configChanged 传入的变更是否涉及主题视觉
function _isThemeRelatedChange(changedConfig) {
  if (!changedConfig || typeof changedConfig !== 'object') return false;
  var keys = Object.keys(changedConfig);
  if (keys.length === 0) return false; // saveConfig({}) 空对象 — 不涉及视觉
  for (var i = 0; i < keys.length; i++) {
    if (THEME_VISUAL_KEYS[keys[i]]) return true;
  }
  return false;
}

function applyTheme() {
  const c = Core.config;
  if (c.appName) {
    Core.dom.appTitle.textContent = c.appName;
    document.title = c.appName;
  }
  const bg = c.chatBackground || '';
  const container = Core.dom.chatContainer;
  if (bg.startsWith('#')) {
    container.style.background = bg;
    container.style.backgroundImage = 'none';
  } else if (bg) {
    container.style.backgroundImage = `url(${bg})`;
    container.style.backgroundSize = 'cover';
    container.style.backgroundPosition = 'center';
  } else {
    container.style.background = '#0d0d0d';
    container.style.backgroundImage = 'none';
  }
  Core.emit('themeApplied', c);
}

function toggle() {
  const c = Core.config;
  const current = c.chatBackground || '#0d0d0d';
  c.chatBackground = current === '#0d0d0d' ? '#f0f0f0' : '#0d0d0d';
  if (Core.saveConfig) Core.saveConfig({ chatBackground: c.chatBackground });
  applyTheme();
}

module.exports = {
  init(_Core) {
    Core = _Core;
    applyTheme();
    // 防抖 + 选择性渲染：只在主题视觉键变更时才重建消息 DOM
    // 非视觉键（searchEngine/favorites/language/temperature/disabledPlugins 等）不触发 renderMessages
    var _renderTimer = 0;
    Core.on('configChanged', function(changedConfig) {
      // 背景/标题始终轻量更新（不涉及 DOM 重建）
      applyTheme();
      // 仅当变更涉及主题视觉键时才防抖触发 renderMessages
      if (!_isThemeRelatedChange(changedConfig)) return;
      if (_renderTimer) clearTimeout(_renderTimer);
      _renderTimer = setTimeout(function() {
        _renderTimer = 0;
        if (Core.session) {
          var currentId = Core.session.getCurrentId();
          if (currentId) Core.session.renderMessages(currentId);
        }
      }, 50);
    });
  },
  toggle,
  applyTheme,
  _isThemeRelatedChange: _isThemeRelatedChange,
  THEME_VISUAL_KEYS: THEME_VISUAL_KEYS,
};