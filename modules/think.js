// modules/think.js
let Core = null;

function toggleDeepThink() {
  if (!Core.dom.deepThinkBtn) return;
  Core.dom.deepThinkBtn.classList.toggle('active');
  var isActive = Core.dom.deepThinkBtn.classList.contains('active');
  Core.config.deepThink = isActive;
  Core.saveConfig({ deepThink: isActive });
  if (Core.dom.status) {
    Core.dom.status.textContent = isActive ? '\ud83e\udde0 \u6df1\u5ea6\u601d\u8003\u5df2\u5f00\u542f' : '\ud83e\udde0 \u6df1\u5ea6\u601d\u8003\u5df2\u5173\u95ed';
    setTimeout(function() {
      if (Core.dom.status && Core.getCurrentService) {
        Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + Core.getCurrentService() + ')';
      }
    }, 1500);
  }
}

module.exports = {
  init(_Core) {
    Core = _Core;
    if (!Core.dom.deepThinkBtn) {
      console.warn('\u26a0\ufe0f \u6df1\u5ea6\u601d\u8003\u6309\u94ae\u672a\u627e\u5230\uff0c\u8df3\u8fc7');
      return;
    }
    Core.dom.deepThinkBtn.addEventListener('click', toggleDeepThink);
    if (Core.config.deepThink) {
      Core.dom.deepThinkBtn.classList.add('active');
    }
  }
};