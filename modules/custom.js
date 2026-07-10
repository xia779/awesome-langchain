// modules/custom.js - 自定义功能模块
// 支持：快捷指令、自定义主题CSS、系统提示词模板
let Core = null;

// 内置快捷指令
const BUILTIN_COMMANDS = {
  '/help': {
    desc: { zh: '显示帮助', en: 'Show help' },
    action: () => showHelp(),
  },
  '/clear': {
    desc: { zh: '清空当前会话', en: 'Clear current session' },
    action: () => clearCurrentSession(),
  },
  '/new': {
    desc: { zh: '新建会话', en: 'New chat' },
    action: () => Core.session.newSession(),
  },
  '/search': {
    desc: { zh: '搜索网络', en: 'Web search' },
    action: (args) => webSearchCommand(args),
  },
  '/image': {
    desc: { zh: '图片理解', en: 'Image understanding' },
    action: () => toggleImageMode(),
  },
  '/voice': {
    desc: { zh: '语音输入', en: 'Voice input' },
    action: () => toggleVoiceInput(),
  },
  '/theme': {
    desc: { zh: '切换主题', en: 'Toggle theme' },
    action: () => toggleTheme(),
  },
  '/fullscreen': {
    desc: { zh: '全屏切换', en: 'Toggle fullscreen' },
    action: () => toggleFullscreen(),
  },
  '/export': {
    desc: { zh: '导出会话', en: 'Export session' },
    action: () => exportSession(),
  },
  '/backup': {
    desc: { zh: '备份数据', en: 'Backup data' },
    action: () => backupData(),
  },
  '/stats': {
    desc: { zh: '显示统计', en: 'Show statistics' },
    action: () => showStats(),
  },
  '/reset': {
    desc: { zh: '重置设置', en: 'Reset settings' },
    action: () => resetSettings(),
  },
};

// 用户自定义指令
let customCommands = {};

// 系统提示词模板
const SYSTEM_PROMPT_TEMPLATES = {
  default: { zh: '默认助手', en: 'Default Assistant', prompt: '' },
  coder: {
    zh: '代码专家',
    en: 'Code Expert',
    prompt: 'You are an expert programmer. Provide clean, well-commented code. Explain your reasoning.'
  },
  writer: {
    zh: '写作助手',
    en: 'Writing Assistant',
    prompt: 'You are a professional writer. Help with writing, editing, and creative content.'
  },
  translator: {
    zh: '翻译专家',
    en: 'Translator',
    prompt: 'You are a professional translator. Translate accurately while preserving tone and meaning.'
  },
  teacher: {
    zh: '教学导师',
    en: 'Teacher',
    prompt: 'You are a patient teacher. Explain concepts clearly with examples.'
  },
  analyst: {
    zh: '数据分析',
    en: 'Data Analyst',
    prompt: 'You are a data analyst. Analyze data critically and provide insights.'
  },
};

function init(_Core) {
  Core = _Core;
  
  // 加载用户自定义指令
  loadCustomCommands();
  
  Core.custom = {
    // 快捷指令
    commands: { ...BUILTIN_COMMANDS, ...customCommands },
    registerCommand,
    unregisterCommand,
    executeCommand,
    
    // 系统提示词模板
    getPromptTemplates: () => SYSTEM_PROMPT_TEMPLATES,
    getPromptTemplate,
    setCustomPrompt,
    
    // 自定义CSS主题
    injectCustomCSS,
    removeCustomCSS,
    getCustomCSS,
    
    // 快捷指令解析
    parseCommand,
  };
  
  console.log('⚙️ 自定义功能模块已加载');
}

// ===== 快捷指令 =====
function parseCommand(input) {
  if (!input || !input.startsWith('/')) return null;
  
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  
  return { command: cmd, args, raw: input };
}

function executeCommand(input) {
  const parsed = parseCommand(input);
  if (!parsed) return false;
  
  const allCommands = { ...BUILTIN_COMMANDS, ...customCommands };
  const cmdDef = allCommands[parsed.command];
  
  if (!cmdDef) {
    Core.showNotification && Core.showNotification('未知指令', `未找到指令: ${parsed.command}，输入 /help 查看所有指令`);
    return false;
  }
  
  try {
    cmdDef.action(parsed.args);
    return true;
  } catch (err) {
    console.error('❌ 指令执行失败:', parsed.command, err);
    Core.showNotification && Core.showNotification('指令错误', err.message);
    return false;
  }
}

function registerCommand(name, desc, action) {
  if (!name.startsWith('/')) name = '/' + name;
  customCommands[name] = { desc, action };
  saveCustomCommands();
  console.log('⚙️ 自定义指令已注册:', name);
}

function unregisterCommand(name) {
  if (!name.startsWith('/')) name = '/' + name;
  delete customCommands[name];
  saveCustomCommands();
}

function saveCustomCommands() {
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(Core.DATA_ROOT, 'custom-commands.json');
    fs.writeFileSync(filePath, JSON.stringify(customCommands, null, 2));
  } catch (e) {}
}

function loadCustomCommands() {
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(Core.DATA_ROOT, 'custom-commands.json');
    if (fs.existsSync(filePath)) {
      customCommands = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    customCommands = {};
  }
}

// ===== 指令实现 =====
function showHelp() {
  const lang = Core.i18n ? Core.i18n.getLanguage() : 'zh';
  const allCommands = { ...BUILTIN_COMMANDS, ...customCommands };
  
  let helpText = lang === 'zh' ? '## 📋 快捷指令帮助\n\n' : '## 📋 Quick Command Help\n\n';
  helpText += lang === 'zh' ? '**内置指令：**\n\n' : '**Built-in Commands:**\n\n';
  
  Object.entries(BUILTIN_COMMANDS).forEach(([cmd, def]) => {
    const desc = typeof def.desc === 'object' ? (def.desc[lang] || def.desc.zh) : def.desc;
    helpText += `- \`${cmd}\` - ${desc}\n`;
  });
  
  if (Object.keys(customCommands).length > 0) {
    helpText += '\n' + (lang === 'zh' ? '**自定义指令：**\n\n' : '**Custom Commands:**\n\n');
    Object.entries(customCommands).forEach(([cmd, def]) => {
      helpText += `- \`${cmd}\` - ${def.desc}\n`;
    });
  }
  
  helpText += '\n' + (lang === 'zh' ? '💡 在输入框中输入 `/` 开头的指令即可使用' : '💡 Type commands starting with `/` in the input box');
  
  // 显示为 AI 消息
  if (Core.renderMessage) {
    Core.renderMessage(helpText, 'assistant');
  } else {
    // 内联渲染回退
    const div = document.createElement('div');
    div.className = 'msg ai';
    if (window.marked) div.innerHTML = marked.parse(helpText);
    else div.textContent = helpText;
    Core.dom.chatContainer.appendChild(div);
    Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
  }
}

function clearCurrentSession() {
  const sessionId = Core.session.getCurrentId();
  if (sessionId && Core.session.sessions[sessionId]) {
    Core.session.sessions[sessionId].messages = [];
    Core.session.saveSessions && Core.session.saveSessions();
    if (Core.renderChatHistory) {
    Core.renderChatHistory();
  } else if (Core.dom && Core.dom.chatContainer) {
    Core.dom.chatContainer.innerHTML = '';
  }
    console.log('🧹 会话已清空');
  }
}

function webSearchCommand(args) {
  if (Core.dom && Core.dom.webSearchBtn) {
    Core.dom.webSearchBtn.click();
    if (args && Core.dom && Core.dom.input) {
      Core.dom.input.value = args;
    }
  }
}

function toggleImageMode() {
  if (Core.dom && Core.dom.uploadBtn) {
    Core.dom.uploadBtn.click();
  }
}

function toggleVoiceInput() {
  if (!Core.voice) return;
  // 🔧 修复：使用正确的 startListening/stopListening 方法
  if (Core.voice.isListening) {
    Core.voice.stopListening();
    return;
  }
  Core.voice.startListening(
    function onResult(text) {
      if (Core.dom && Core.dom.input && text) {
        Core.dom.input.value = (Core.dom.input.value + ' ' + text).trim();
        Core.dom.input.focus();
      }
    },
    function onError(err) {
      if (Core.errorHandler) Core.errorHandler.showErrorToast('语音识别失败: ' + err);
    }
  );
}

function toggleTheme() {
  const current = Core.config.theme || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  Core.saveConfig({ theme: next });
  document.body.classList.toggle('light-theme', next === 'light');
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
}

function exportSession() {
  if (Core.export && Core.export.exportCurrentSession) {
    Core.export.exportCurrentSession('markdown');
  }
}

function backupData() {
  if (Core.backup && Core.backup.backupAllToZip) {
    Core.backup.backupAllToZip().then(r => {
      showToast('✅ 备份完成: ' + r.backupPath, 'success');
    });
  }
}

function showStats() {
  const stats = Core.performance ? Core.performance.getStats() : {};
  const sessions = Core.session.sessions;
  const sessionCount = Object.keys(sessions).length;
  const messageCount = Object.values(sessions).reduce((sum, s) => sum + (s.messages ? s.messages.length : 0), 0);
  
  const text = `## 📊 应用统计

- **会话数**: ${sessionCount}
- **消息总数**: ${messageCount}
- **运行时间**: ${stats.uptime || 0}s
- **DOM 节点**: ${stats.domNodes || 0}
- **内存使用**: ${stats.memory ? stats.memory.usedMB + 'MB' : 'N/A'}
`;
  
  if (Core.renderMessage) {
    Core.renderMessage(text, 'assistant');
  } else {
    const div = document.createElement('div');
    div.className = 'msg ai';
    if (window.marked) div.innerHTML = marked.parse(text);
    else div.textContent = text;
    Core.dom.chatContainer.appendChild(div);
    Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
  }
}

function resetSettings() {
  if (confirm('⚠️ 确定要重置所有设置吗？此操作不可撤销。')) {
    Core.saveConfig({
      theme: 'dark',
      temperature: 0.7,
      streamResponse: true,
      notification: false,
      shortcutEnabled: true,
      language: 'zh',
    });
    showToast('✅ 设置已重置', 'success');
    location.reload();
  }
}

// ===== 系统提示词模板 =====
function getPromptTemplate(key) {
  return SYSTEM_PROMPT_TEMPLATES[key] || SYSTEM_PROMPT_TEMPLATES.default;
}

function setCustomPrompt(key, prompt) {
  const customPrompts = Core.config.customPrompts || {};
  customPrompts[key] = prompt;
  Core.saveConfig({ customPrompts });
}

// ===== 自定义CSS主题 =====
// 🔒 安全修复：过滤危险的 CSS 模式
function sanitizeCSS(css) {
  if (typeof css !== 'string') return '';
  // 移除 @import（可能引入外部恶意样式表）
  css = css.replace(/@import\s+[^;]+;?/gi, '');
  // 移除 expression()（IE 遗留的 JS 执行入口）
  css = css.replace(/expression\s*\(/gi, '/* blocked */');
  // 移除 behavior（IE 遗留的脚本绑定）
  css = css.replace(/behavior\s*:/gi, '/* blocked */:');
  // 移除 url() 中的远程链接（允许 data: 和本地路径）
  css = css.replace(/url\s*\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/gi, '/* blocked-url */');
  css = css.replace(/url\s*\(\s*['"]?(javascript:[^'")\s]+)['"]?\s*\)/gi, '/* blocked-url */');
  return css;
}

function injectCustomCSS(css) {
  let style = document.getElementById('custom-theme-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'custom-theme-style';
    document.head.appendChild(style);
  }
  style.textContent = sanitizeCSS(css);
  
  // 保存到配置（保存原始内容，加载时再过滤）
  Core.saveConfig({ customCSS: css });
}

function removeCustomCSS() {
  const style = document.getElementById('custom-theme-style');
  if (style) style.remove();
  Core.saveConfig({ customCSS: null });
}

function getCustomCSS() {
  return Core.config.customCSS || '';
}

// 启动时加载自定义CSS
function loadCustomCSS() {
  const css = Core.config.customCSS;
  if (css) {
    injectCustomCSS(css);
  }
}

module.exports = { name: 'custom', dependencies: ['session'], init };
