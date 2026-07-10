// modules/think.js
let Core = null;

function toggleDeepThink() {
  Core.dom.deepThinkBtn.classList.toggle('active');
  Core.config.deepThink = Core.dom.deepThinkBtn.classList.contains('active');
  Core.saveConfig({ deepThink: Core.config.deepThink });
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.dom.deepThinkBtn.addEventListener('click', toggleDeepThink);
    if (Core.config.deepThink) {
      Core.dom.deepThinkBtn.classList.add('active');
    }
  }
};