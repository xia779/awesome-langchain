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
  // 重新渲染当前会话以更新气泡颜色
  if (Core.session) {
    const currentId = Core.session.getCurrentId();
    if (currentId) {
      Core.session.renderMessages(currentId);
    }
  }
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
    Core.on('configChanged', applyTheme);
  },
  toggle,
  applyTheme
};