// modules/theme.js
let Core = null;

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
    container.style.background = '#141425';
    container.style.backgroundImage = 'none';
  }
  // renderMessages 由 configChanged 防抖处理器触发，此处不再直接调用
  Core.emit('themeApplied', c);
}

function toggle() {
  const c = Core.config;
  const current = c.chatBackground || '#141425';
  // 简单深浅切换：深色 ↔ 浅色
  c.chatBackground = current === '#141425' ? '#f0f0f0' : '#141425';
  if (Core.saveConfig) Core.saveConfig();
  applyTheme();
}

module.exports = {
  init(_Core) {
    Core = _Core;
    applyTheme();
    // 防抖：快速配置变更（如颜色拖动）只在停止 200ms 后重建一次 DOM
    var _renderTimer = 0;
    Core.on('configChanged', function() {
      applyTheme();
      if (_renderTimer) clearTimeout(_renderTimer);
      _renderTimer = setTimeout(function() {
        _renderTimer = 0;
        if (Core.session) {
          var currentId = Core.session.getCurrentId();
          if (currentId) Core.session.renderMessages(currentId);
        }
      }, 200);
    });
  },
  toggle,
  applyTheme
};