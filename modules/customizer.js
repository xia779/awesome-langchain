// customizer.js - 高级定制模块（主题 + 快捷键 + 工具栏 + 插件编辑器 + 启动钩子）
'use strict';

var Core = null;
var fs = null;
var path = null;

var THEMES_FILE = '';
var KEYBINDINGS_FILE = '';
var TOOLBAR_FILE = '';
var HOOKS_FILE = '';

// ===== 主题系统 =====
var themes = {};       // { id: { id, name, vars:{}, customCSS, isBuiltin } }
var activeThemeId = '';

var BUILTIN_THEMES = {
  'dark-default': {
    id: 'dark-default', name: '深色（默认）', isBuiltin: true,
    vars: {
      primary: '#3b82f6', 'primary-hover': '#2563eb', 'primary-light': 'rgba(59,130,246,0.15)',
      bg: '#0d0d0d', 'bg-secondary': '#1a1a1a', panel: '#141414',
      text: '#e8e8e8', 'text-secondary': '#9ca3af', border: '#2a2a2a',
      shadow: '0 4px 24px rgba(0,0,0,0.4)', 'shadow-lg': '0 8px 32px rgba(0,0,0,0.5)',
      radius: '16px', 'radius-sm': '12px',
      'chat-bubble-user': '#3b82f6', 'chat-bubble-ai': '#1e293b'
    }
  },
  'light-default': {
    id: 'light-default', name: '浅色', isBuiltin: true,
    vars: {
      primary: '#2563eb', 'primary-hover': '#1d4ed8', 'primary-light': 'rgba(37,99,235,0.1)',
      bg: '#f8fafc', 'bg-secondary': '#f1f5f9', panel: '#ffffff',
      text: '#1e293b', 'text-secondary': '#64748b', border: '#e2e8f0',
      shadow: '0 4px 24px rgba(0,0,0,0.08)', 'shadow-lg': '0 8px 32px rgba(0,0,0,0.12)',
      radius: '16px', 'radius-sm': '12px',
      'chat-bubble-user': '#2563eb', 'chat-bubble-ai': '#f1f5f9'
    }
  },
  'midnight-blue': {
    id: 'midnight-blue', name: '午夜蓝', isBuiltin: true,
    vars: {
      primary: '#6366f1', 'primary-hover': '#4f46e5', 'primary-light': 'rgba(99,102,241,0.15)',
      bg: '#0f172a', 'bg-secondary': '#1e293b', panel: '#1a2332',
      text: '#e2e8f0', 'text-secondary': '#94a3b8', border: '#334155',
      shadow: '0 4px 24px rgba(0,0,0,0.5)', 'shadow-lg': '0 8px 32px rgba(0,0,0,0.6)',
      radius: '16px', 'radius-sm': '12px',
      'chat-bubble-user': '#6366f1', 'chat-bubble-ai': '#1e293b'
    }
  },
  'emerald': {
    id: 'emerald', name: '翡翠绿', isBuiltin: true,
    vars: {
      primary: '#10b981', 'primary-hover': '#059669', 'primary-light': 'rgba(16,185,129,0.15)',
      bg: '#0a0f0d', 'bg-secondary': '#111916', panel: '#0e1613',
      text: '#e8e8e8', 'text-secondary': '#9ca3af', border: '#1f3a2e',
      shadow: '0 4px 24px rgba(0,0,0,0.4)', 'shadow-lg': '0 8px 32px rgba(0,0,0,0.5)',
      radius: '16px', 'radius-sm': '12px',
      'chat-bubble-user': '#10b981', 'chat-bubble-ai': '#1a2e25'
    }
  },
  'rose': {
    id: 'rose', name: '玫瑰红', isBuiltin: true,
    vars: {
      primary: '#f43f5e', 'primary-hover': '#e11d48', 'primary-light': 'rgba(244,63,94,0.15)',
      bg: '#0d0a0b', 'bg-secondary': '#1a1617', panel: '#141011',
      text: '#e8e8e8', 'text-secondary': '#9ca3af', border: '#2a2225',
      shadow: '0 4px 24px rgba(0,0,0,0.4)', 'shadow-lg': '0 8px 32px rgba(0,0,0,0.5)',
      radius: '16px', 'radius-sm': '12px',
      'chat-bubble-user': '#f43f5e', 'chat-bubble-ai': '#1e1618'
    }
  }
};

function loadThemes() {
  THEMES_FILE = path.join(Core.DATA_ROOT, 'custom-themes.json');
  try {
    if (fs.existsSync(THEMES_FILE)) {
      themes = JSON.parse(fs.readFileSync(THEMES_FILE, 'utf-8'));
    }
  } catch (e) { themes = {}; }
  // Merge built-in themes (don't overwrite custom)
  Object.keys(BUILTIN_THEMES).forEach(function(id) {
    if (!themes[id]) themes[id] = BUILTIN_THEMES[id];
  });
}

function saveThemes() {
  try {
    // Only save non-builtin themes
    var toSave = {};
    Object.keys(themes).forEach(function(id) {
      if (!themes[id].isBuiltin) toSave[id] = themes[id];
    });
    fs.writeFileSync(THEMES_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save themes:', e.message); }
}

function createTheme(name, vars, customCSS) {
  var id = 'theme_' + Date.now().toString(36);
  themes[id] = {
    id: id, name: name || '自定义主题', isBuiltin: false,
    vars: vars || {}, customCSS: customCSS || ''
  };
  saveThemes();
  return themes[id];
}

function updateTheme(themeId, updates) {
  if (!themes[themeId]) return { success: false, error: '主题不存在' };
  if (themes[themeId].isBuiltin) return { success: false, error: '内置主题不可修改' };
  Object.assign(themes[themeId], updates);
  saveThemes();
  if (activeThemeId === themeId) applyTheme(themeId);
  return { success: true };
}

function deleteTheme(themeId) {
  if (!themes[themeId]) return { success: false, error: '主题不存在' };
  if (themes[themeId].isBuiltin) return { success: false, error: '内置主题不可删除' };
  if (activeThemeId === themeId) applyTheme('dark-default');
  delete themes[themeId];
  saveThemes();
  return { success: true };
}

function listThemes() {
  return Object.values(themes);
}

function applyTheme(themeId) {
  var theme = themes[themeId];
  if (!theme) return false;
  activeThemeId = themeId;
  var root = document.documentElement;

  // Apply CSS variables
  if (theme.vars) {
    Object.keys(theme.vars).forEach(function(key) {
      root.style.setProperty('--' + key, theme.vars[key]);
    });
  }

  // Apply custom CSS
  var customStyleEl = document.getElementById('_customThemeCSS');
  if (!customStyleEl) {
    customStyleEl = document.createElement('style');
    customStyleEl.id = '_customThemeCSS';
    document.head.appendChild(customStyleEl);
  }
  customStyleEl.textContent = theme.customCSS || '';

  // Save active theme (skip if unchanged to avoid redundant configChanged)
  if (Core && Core.saveConfig && Core.config.activeTheme !== themeId) {
    Core.saveConfig({ activeTheme: themeId });
  }

  return true;
}

function exportTheme(themeId) {
  var theme = themes[themeId];
  if (!theme) return null;
  return JSON.stringify({ name: theme.name, vars: theme.vars, customCSS: theme.customCSS }, null, 2);
}

function importTheme(jsonStr) {
  try {
    var data = JSON.parse(jsonStr);
    return createTheme(data.name || '导入主题', data.vars, data.customCSS);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 快捷键系统 =====
var DEFAULT_KEYBINDINGS = {
  'send': { key: 'Enter', ctrl: false, shift: false, desc: '发送消息' },
  'newline': { key: 'Enter', ctrl: false, shift: true, desc: '换行' },
  'newSession': { key: 'n', ctrl: true, shift: false, desc: '新建会话' },
  'focusInput': { key: 'f', ctrl: true, shift: true, desc: '聚焦输入框' },
  'screenshot': { key: 's', ctrl: true, shift: true, desc: '截图分析' },
  'export': { key: 'e', ctrl: true, shift: false, desc: '导出会话' },
  'search': { key: 'f', ctrl: true, shift: false, desc: '消息搜索' },
  'shortcutHint': { key: '/', ctrl: true, shift: false, desc: '快捷键面板' },
  'selectAll': { key: 'k', ctrl: true, shift: false, desc: '聚焦并全选' },
  'stopGenerate': { key: 'Escape', ctrl: false, shift: false, desc: '停止生成' }
};
var keybindings = {};

function loadKeybindings() {
  KEYBINDINGS_FILE = path.join(Core.DATA_ROOT, 'custom-keybindings.json');
  keybindings = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
  try {
    if (fs.existsSync(KEYBINDINGS_FILE)) {
      var custom = JSON.parse(fs.readFileSync(KEYBINDINGS_FILE, 'utf-8'));
      Object.keys(custom).forEach(function(id) {
        keybindings[id] = Object.assign({}, DEFAULT_KEYBINDINGS[id] || {}, custom[id]);
      });
    }
  } catch (e) { /* use defaults */ }
}

function saveKeybindings() {
  try {
    // Only save non-default bindings
    var toSave = {};
    Object.keys(keybindings).forEach(function(id) {
      var d = DEFAULT_KEYBINDINGS[id];
      var k = keybindings[id];
      if (!d || k.key !== d.key || k.ctrl !== d.ctrl || k.shift !== d.shift) {
        toSave[id] = k;
      }
    });
    fs.writeFileSync(KEYBINDINGS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save keybindings:', e.message); }
}

function updateKeybinding(actionId, binding) {
  if (!actionId) return { success: false, error: '缺少 action ID' };
  // 冲突检测
  var conflict = detectConflict(actionId, binding);
  if (conflict) {
    return { success: false, error: '与 "' + DEFAULT_KEYBINDINGS[conflict].desc + '" 冲突', conflict: conflict };
  }
  keybindings[actionId] = binding;
  saveKeybindings();
  return { success: true };
}

function detectConflict(actionId, binding) {
  var key = binding.key.toLowerCase();
  var ctrl = !!binding.ctrl;
  var shift = !!binding.shift;
  var conflicts = Object.keys(keybindings).filter(function(id) {
    if (id === actionId) return false;
    var b = keybindings[id];
    return b.key.toLowerCase() === key && !!b.ctrl === ctrl && !!b.shift === shift;
  });
  return conflicts.length > 0 ? conflicts[0] : null;
}

function resetKeybindings() {
  keybindings = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
  saveKeybindings();
  return { success: true };
}

function listKeybindings() {
  return Object.keys(keybindings).map(function(id) {
    return Object.assign({ id: id }, keybindings[id]);
  });
}

// ===== 工具栏布局 =====
var DEFAULT_TOOLBAR_LEFT = ['appsMenuBtn', 'webSearchBtn', 'deepThinkBtn', 'streamBtn', 'agentModeBtn'];
var DEFAULT_TOOLBAR_RIGHT = ['voiceBtn', 'imageBtn', 'screenshotBtn', 'promptBtn', 'roleBtn'];
var toolbarLayout = { left: null, right: null, hidden: [] };

function loadToolbar() {
  TOOLBAR_FILE = path.join(Core.DATA_ROOT, 'custom-toolbar.json');
  try {
    if (fs.existsSync(TOOLBAR_FILE)) {
      var saved = JSON.parse(fs.readFileSync(TOOLBAR_FILE, 'utf-8'));
      toolbarLayout.left = saved.left || DEFAULT_TOOLBAR_LEFT.slice();
      toolbarLayout.right = saved.right || DEFAULT_TOOLBAR_RIGHT.slice();
      toolbarLayout.hidden = saved.hidden || [];
    } else {
      toolbarLayout.left = DEFAULT_TOOLBAR_LEFT.slice();
      toolbarLayout.right = DEFAULT_TOOLBAR_RIGHT.slice();
    }
  } catch (e) {
    toolbarLayout.left = DEFAULT_TOOLBAR_LEFT.slice();
    toolbarLayout.right = DEFAULT_TOOLBAR_RIGHT.slice();
  }
}

function saveToolbar() {
  try {
    fs.writeFileSync(TOOLBAR_FILE, JSON.stringify(toolbarLayout, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save toolbar:', e.message); }
}

function applyToolbar() {
  var leftContainer = document.querySelector('.input-left-actions');
  var rightContainer = document.querySelector('.input-right-actions');
  if (!leftContainer || !rightContainer) return;

  // Reorder left buttons
  toolbarLayout.left.forEach(function(btnId) {
    var btn = document.getElementById(btnId);
    if (btn && !toolbarLayout.hidden.includes(btnId)) {
      leftContainer.appendChild(btn);
    }
  });

  // Reorder right buttons
  toolbarLayout.right.forEach(function(btnId) {
    var btn = document.getElementById(btnId);
    if (btn && !toolbarLayout.hidden.includes(btnId)) {
      rightContainer.appendChild(btn);
    }
  });

  // Hide hidden buttons
  toolbarLayout.hidden.forEach(function(btnId) {
    var btn = document.getElementById(btnId);
    if (btn) btn.style.display = 'none';
  });

  // Show non-hidden
  toolbarLayout.left.concat(toolbarLayout.right).forEach(function(btnId) {
    if (!toolbarLayout.hidden.includes(btnId)) {
      var btn = document.getElementById(btnId);
      if (btn) btn.style.display = '';
    }
  });
}

function getToolbarLayout() {
  return JSON.parse(JSON.stringify(toolbarLayout));
}

function setToolbarLayout(layout) {
  if (layout.left) toolbarLayout.left = layout.left;
  if (layout.right) toolbarLayout.right = layout.right;
  if (layout.hidden !== undefined) toolbarLayout.hidden = layout.hidden;
  saveToolbar();
  applyToolbar();
  return { success: true };
}

function toggleToolbarButton(btnId) {
  var idx = toolbarLayout.hidden.indexOf(btnId);
  if (idx >= 0) {
    toolbarLayout.hidden.splice(idx, 1);
  } else {
    toolbarLayout.hidden.push(btnId);
  }
  saveToolbar();
  applyToolbar();
  return { success: true, hidden: toolbarLayout.hidden.includes(btnId) };
}

// ===== 插件可视化编辑器 =====

function createPluginFromUI(name, description, hooks) {
  if (!Core.plugins || !Core.plugins.getPluginsDir) {
    return { success: false, error: '插件系统未加载' };
  }

  var pluginId = 'custom-' + Date.now().toString(36);
  var pluginsDir = Core.plugins.getPluginsDir();
  var pluginDir = path.join(pluginsDir, pluginId);

  try {
    fs.mkdirSync(pluginDir, { recursive: true });

    // Generate plugin.json
    var manifest = {
      id: pluginId,
      name: name || '自定义插件',
      version: '1.0.0',
      description: description || '',
      author: Core.getCurrentUser() || 'user',
      entry: 'index.js'
    };
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Generate index.js from hook definitions
    var code = generatePluginCode(name, hooks || []);
    fs.writeFileSync(path.join(pluginDir, 'index.js'), code, 'utf-8');

    // Install the plugin
    if (Core.plugins.loadPlugin) {
      Core.plugins.loadPlugin(pluginId);
    }

    return { success: true, pluginId: pluginId, dir: pluginDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function generatePluginCode(name, hooks) {
  var code = '// ' + (name || '自定义插件') + ' - 自动生成\n';
  code += "'use strict';\n\n";
  code += 'module.exports = class ' + (name || 'CustomPlugin').replace(/[^a-zA-Z]/g, '') + ' {\n';
  code += '  constructor(api) {\n';
  code += '    this.api = api;\n';
  code += '    api.log("插件已加载");\n';

  hooks.forEach(function(hook) {
    if (hook.type === 'beforeSend') {
      code += '\n    api.registerHook("beforeSend", function(message) {\n';
      code += '      // ' + (hook.description || '消息发送前处理') + '\n';
      if (hook.action === 'append') {
        code += '      return message + "' + (hook.value || '') + '";\n';
      } else if (hook.action === 'replace') {
        code += '      return message.replace(/' + (hook.pattern || '') + '/g, "' + (hook.value || '') + '");\n';
      } else {
        code += '      return message;\n';
      }
      code += '    });\n';
    }

    if (hook.type === 'afterResponse') {
      code += '\n    api.registerHook("afterResponse", function(message, context) {\n';
      code += '      // ' + (hook.description || 'AI回复后处理') + '\n';
      if (hook.action === 'notify') {
        code += '      api.notify("AI 已回复", message.substring(0, 100));\n';
      }
      code += '    });\n';
    }

    if (hook.type === 'onInit') {
      code += '\n    api.registerHook("onInit", function() {\n';
      code += '      // ' + (hook.description || '初始化时执行') + '\n';
      code += '      api.log("初始化完成");\n';
      code += '    });\n';
    }
  });

  code += '  }\n';
  code += '};\n';
  return code;
}

function editPluginCode(pluginId, code) {
  if (!Core.plugins || !Core.plugins.getPluginsDir) return { success: false, error: '插件系统未加载' };
  var pluginDir = path.join(Core.plugins.getPluginsDir(), pluginId);
  try {
    fs.writeFileSync(path.join(pluginDir, 'index.js'), code, 'utf-8');
    // Reload
    if (Core.plugins.reloadPlugin) Core.plugins.reloadPlugin(pluginId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 启动钩子/事件系统 =====
var startupHooks = [];  // [{ id, name, event, script }]

function loadHooks() {
  HOOKS_FILE = path.join(Core.DATA_ROOT, 'custom-hooks.json');
  try {
    if (fs.existsSync(HOOKS_FILE)) {
      startupHooks = JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'));
    }
  } catch (e) { startupHooks = []; }
}

function saveHooks() {
  try {
    fs.writeFileSync(HOOKS_FILE, JSON.stringify(startupHooks, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save hooks:', e.message); }
}

function addHook(hook) {
  var newHook = {
    id: 'hook_' + Date.now().toString(36),
    name: hook.name || '自定义钩子',
    enabled: hook.enabled !== false,
    event: hook.event || 'onInit', // onInit | configChanged | typingEnd | typingStart
    script: hook.script || ''
  };
  startupHooks.push(newHook);
  saveHooks();

  // Register the hook
  if (newHook.enabled && newHook.event && newHook.script) {
    registerHookEvent(newHook);
  }
  return newHook;
}

function deleteHook(hookId) {
  startupHooks = startupHooks.filter(function(h) { return h.id !== hookId; });
  saveHooks();
  return { success: true };
}

function listHooks() {
  return startupHooks.slice();
}

function registerHookEvent(hook) {
  if (!Core.on) return;
  if (hook.event === 'onInit') {
    // Execute immediately
    try {
      var fn = new Function('Core', hook.script);
      setTimeout(function() { fn(Core); }, 1000);
    } catch (e) {
      console.warn('Hook "' + hook.name + '" init error:', e.message);
    }
  } else {
    Core.on(hook.event, function(data) {
      if (!hook.enabled) return;
      try {
        var fn = new Function('Core', 'data', hook.script);
        fn(Core, data);
      } catch (e) {
        console.warn('Hook "' + hook.name + '" error:', e.message);
      }
    });
  }
}

function executeAllHooks() {
  startupHooks.forEach(function(hook) {
    if (hook.enabled) registerHookEvent(hook);
  });
}

// ===== 命令注册 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('theme', {
    zh: '主题管理: /theme list|use|create|export|import',
    en: 'Theme management'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'list') {
      var list = listThemes();
      var text = '🎨 **可用主题**\n\n';
      list.forEach(function(t, i) {
        var active = t.id === activeThemeId ? ' ← 当前' : '';
        text += (i + 1) + '. **' + t.name + '**' + (t.isBuiltin ? ' (内置)' : ' (自定义)') + active + '\n';
        text += '   ID: ' + t.id + '\n';
      });
      text += '\n使用 `/theme use <ID>` 切换主题';
      showMsg(text);
      return;
    }

    if (sub === 'use') {
      var id = parts[1] || '';
      if (!id) { showMsg('⚠️ 格式: /theme use <主题ID>'); return; }
      if (applyTheme(id)) {
        showMsg('🎨 已切换主题: **' + (themes[id] && themes[id].name) + '**');
      } else {
        showMsg('❌ 主题不存在: ' + id);
      }
      return;
    }

    if (sub === 'create') {
      var name = parts.slice(1).join(' ') || '自定义主题';
      var current = themes[activeThemeId];
      var tpl = createTheme(name, current ? JSON.parse(JSON.stringify(current.vars)) : {});
      showMsg('✅ 主题已创建: **' + tpl.name + '** (ID: ' + tpl.id + ')\n在设置面板中编辑颜色变量。');
      return;
    }

    if (sub === 'export') {
      var id = parts[1] || activeThemeId;
      var json = exportTheme(id);
      if (json) {
        showMsg('📋 主题已导出:\n```\n' + json.substring(0, 500) + '\n```');
      } else {
        showMsg('❌ 导出失败');
      }
      return;
    }

    showMsg('🎨 主题命令:\n/theme list — 列出主题\n/theme use <ID> — 切换主题\n/theme create <名称> — 创建主题\n/theme export <ID> — 导出主题');
  });

  Core.custom.registerCommand('keybind', {
    zh: '快捷键管理: /keybind list|reset',
    en: 'Keybinding management'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'list') {
      var list = listKeybindings();
      var text = '⌨️ **快捷键配置**\n\n';
      list.forEach(function(kb) {
        var mods = [];
        if (kb.ctrl) mods.push('Ctrl');
        if (kb.shift) mods.push('Shift');
        mods.push(kb.key);
        text += '- **' + kb.desc + '** → ' + mods.join('+') + '\n';
      });
      text += '\n在设置面板中修改快捷键。';
      showMsg(text);
      return;
    }

    if (sub === 'reset') {
      resetKeybindings();
      showMsg('✅ 快捷键已恢复默认');
      return;
    }

    showMsg('⌨️ 快捷键命令:\n/keybind list — 列出所有快捷键\n/keybind reset — 恢复默认');
  });
}

function showMsg(text) {
  var currentId = Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(currentId);
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    console.warn('customizer.js: fs/path not available');
    return;
  }

  loadThemes();
  loadKeybindings();
  loadToolbar();
  loadHooks();
  registerCommands();

  // Apply saved theme
  if (Core.config && Core.config.activeTheme) {
    applyTheme(Core.config.activeTheme);
  }

  // Apply toolbar layout (deferred to after DOM ready)
  setTimeout(function() { applyToolbar(); }, 500);

  // Execute startup hooks
  executeAllHooks();

  // Expose API
  Core.customizer = {
    themes: {
      list: listThemes, create: createTheme, update: updateTheme, delete: deleteTheme,
      apply: applyTheme, export: exportTheme, import: importTheme, getActive: function() { return activeThemeId; }
    },
    keybindings: {
      list: listKeybindings, update: updateKeybinding, reset: resetKeybindings,
      detectConflict: detectConflict, defaults: DEFAULT_KEYBINDINGS
    },
    toolbar: {
      get: getToolbarLayout, set: setToolbarLayout, toggle: toggleToolbarButton,
      apply: applyToolbar, defaults: { left: DEFAULT_TOOLBAR_LEFT, right: DEFAULT_TOOLBAR_RIGHT }
    },
    pluginEditor: {
      create: createPluginFromUI, edit: editPluginCode, generate: generatePluginCode
    },
    hooks: {
      list: listHooks, add: addHook, delete: deleteHook
    }
  };

  console.log('✅ customizer.js 已加载 (主题:' + Object.keys(themes).length + ', 快捷键:' + Object.keys(keybindings).length + ')');
}

exports.init = init;
