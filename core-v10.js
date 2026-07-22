// core.js - 核心注册表（完整修复版）

// 🔧 修复 module.paths，确保能找到项目目录的 node_modules
// Electron renderer 中 require 的 module.paths 可能不包含项目目录，需要手动修复
try {
  const _path = require('path');
  const projectNodeModules = _path.join(__dirname, 'node_modules');
  if (typeof module !== 'undefined' && module.paths && !module.paths.includes(projectNodeModules)) {
    module.paths.unshift(projectNodeModules);
  }
} catch (e) { console.warn('⚠️ [core] 修复 module.paths 失败:', e.message); }

// ===== 全局保险：确保 Node API 可用 =====
if (typeof require !== 'undefined' && typeof window !== 'undefined') {
  try {
    if (typeof window.fs === 'undefined') window.fs = require('fs');
    if (typeof window.path === 'undefined') window.path = require('path');
  } catch (e) { console.warn('⚠️ [core] 暴露 fs/path 到 window 失败:', e.message); }
}

// 使用 var 避免重复声明
var fs = (typeof require !== 'undefined') ? require('fs') : (window.fs || {});
var path = (typeof require !== 'undefined') ? require('path') : (window.path || {});

// ===== 兼容性检测 =====
const HAS_NODE_FS = typeof fs !== 'undefined' && fs.readFileSync;

// ===== 🔒 加密工具（从 crypto-utils.js 加载）=====
var _cryptoModule = null;
try { _cryptoModule = require('./modules/crypto-utils'); } catch (e) { console.warn('⚠️ [core] crypto-utils 加载失败:', e.message); }
var encryptValue = _cryptoModule ? _cryptoModule.encryptValue : function(v) { return v; };
var decryptValue = _cryptoModule ? _cryptoModule.decryptValue : function(v) { return v; };
var encryptSensitiveFields = _cryptoModule ? _cryptoModule.encryptSensitiveFields : function(c) { return c; };
var decryptSensitiveFields = _cryptoModule ? _cryptoModule.decryptSensitiveFields : function(c) { return c; };
var SENSITIVE_KEY_FIELDS = _cryptoModule ? _cryptoModule.SENSITIVE_KEY_FIELDS : [];
var ENC_PREFIX = _cryptoModule ? _cryptoModule.ENC_PREFIX : 'enc:v1:';

// ===== 动态获取数据路径 =====
var app = null;
try {
  const electron = require('electron');
  app = electron.app;
} catch (e) {
  console.warn('⚠️ electron app 模块不可用，使用回退路径');
}

function getDataRoot() {
  // 🔧 动态路径：环境变量 > 已存在的默认路径 > app userData 回退
  if (process.env.AI_AGENT_DATA_ROOT) {
    return process.env.AI_AGENT_DATA_ROOT;
  }
  var defaultPath = 'E:\\my-ai-data';
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  // 回退：使用 Electron app 的 userData 目录
  try {
    if (app) {
      var fallback = path.join(app.getPath('userData'), 'ai-data');
      return fallback;
    }
  } catch (e) { console.warn('⚠️ [core] 获取 userData 路径失败:', e.message); }
  return defaultPath; // 最终兜底
}

const DATA_ROOT = getDataRoot();
const USERS_ROOT = path.join(DATA_ROOT, 'users');

// 确保根目录
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
if (!fs.existsSync(USERS_ROOT)) fs.mkdirSync(USERS_ROOT, { recursive: true });

// ===== 工具函数：安全写入文件（自动处理EISDIR）=====
function safeWriteFile(filePath, content) {
  // 如果目标是一个目录（之前的错误），删除它
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    console.warn(`⚠️ ${path.basename(filePath)} 是目录而非文件，正在清理...`);
    fs.rmSync(filePath, { recursive: true, force: true });
  }
  // 确保父目录存在
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 写入文件
  fs.writeFileSync(filePath, content, 'utf8');
}

// ===== 工具函数：安全读取文件 =====
function safeReadFile(filePath, defaultContent) {
  // 如果目标是一个目录（之前的错误），删除它并用默认值
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    console.warn(`⚠️ ${path.basename(filePath)} 是目录而非文件，正在清理...`);
    fs.rmSync(filePath, { recursive: true, force: true });
  }
  if (!fs.existsSync(filePath)) {
    safeWriteFile(filePath, defaultContent);
    return defaultContent;
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ===== 模型列表获取 =====
async function fetchOllamaModels() {
  try {
    const resp = await fetch('http://127.0.0.1:11434/api/tags');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.models || [];
  } catch (err) {
    console.warn('⚠️ 无法获取Ollama模型:', err.message);
    return [];
  }
}

function updateModelSelect(models) {
  const select = document.getElementById('modelSelect');
  if (!select) return;
  const currentValue = select.value;
  const cloudOptions = [];
  for (let i = select.options.length - 1; i >= 0; i--) {
    const opt = select.options[i];
    if (!opt.value.startsWith('ollama:')) cloudOptions.push({ value: opt.value, text: opt.textContent });
  }
  select.innerHTML = '';
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'ollama:qwen2.5:7b';
    opt.textContent = 'Qwen2.5 7B (默认)';
    select.appendChild(opt);
  } else {
    models.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const model of models) {
      const opt = document.createElement('option');
      const fullName = model.name || model.model || 'unknown';
      opt.value = `ollama:${fullName}`;
      opt.textContent = `${fullName} (Ollama)`;
      select.appendChild(opt);
    }
  }
  for (const opt of cloudOptions) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.text;
    select.appendChild(option);
  }
  if (currentValue) {
    const exists = Array.from(select.options).some(o => o.value === currentValue);
    if (exists) select.value = currentValue;
  }
}

async function refreshModels() {
  const models = await fetchOllamaModels();
  updateModelSelect(models);
  if (Core.config) {
    const newList = models.map(m => m.name || m.model).sort();
    const oldList = (Core.config.availableModels || []).slice().sort();
    // 🔧 只在模型列表实际变化时才触发 saveConfig → configChanged（排序后比较，避免顺序差异导致误触发）
    if (JSON.stringify(newList) !== JSON.stringify(oldList)) {
      Core.config.availableModels = newList;
      Core.saveConfig({ availableModels: newList });
    }
  }
  return models;
}

// ===== Core对象 =====
const Core = {
  config: {},
  currentService: 'ollama',
  _currentUser: null,
  DATA_ROOT,
  USERS_ROOT,
  _globalDataRoot: DATA_ROOT,  // 🔧 全局数据根目录（不受 setCurrentUser 影响）
  HAS_NODE_FS,

  dom: {},
  pluginManager: null,
  events: {},
  _emitDepth: 0,
  _MAX_EMIT_DEPTH: 5,

  on(event, callback) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
    return () => this.off(event, callback);
  },
  off(event, callback) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(cb => cb !== callback);
  },
  emit(event, data) {
    if (this._emitDepth >= this._MAX_EMIT_DEPTH) {
      console.warn('[Core.emit] 递归深度超限，跳过事件:', event);
      return;
    }
    if (this.events[event]) {
      this._emitDepth++;
      try {
        this.events[event].forEach(cb => { try { cb(data); } catch (e) { console.error('事件[' + event + ']错误:', e); } });
      } finally {
        this._emitDepth--;
      }
    }
  },

  setCurrentUser(username) {
    this._currentUser = username;
    const userDir = path.join(USERS_ROOT, username);
    this.DATA_ROOT = userDir;
    this.CONFIG_FILE = path.join(userDir, 'config.json');
    this.SESSIONS_DIR = path.join(userDir, 'sessions');
    this.KNOWLEDGE_DIR = path.join(userDir, 'knowledge');
    this.PLUGINS_DIR = path.join(userDir, 'plugins');
    // 🔧 关键修复：只创建目录，不要把 CONFIG_FILE（文件路径）也mkdir
    [this.SESSIONS_DIR, this.KNOWLEDGE_DIR, this.PLUGINS_DIR].forEach(p => {
      try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch(e) { console.warn('⚠️ [core] 创建用户目录失败:', p, e.message); }
    });
    // 单独处理 config.json：如果它意外变成了目录，删除它
    if (fs.existsSync(this.CONFIG_FILE) && fs.statSync(this.CONFIG_FILE).isDirectory()) {
      console.warn('⚠️ config.json 是目录，正在清理...');
      fs.rmSync(this.CONFIG_FILE, { recursive: true, force: true });
    }
  },

  getCurrentUser() { return this._currentUser; },

  setCurrentService(service) {
    this.currentService = service;
    this.config.currentService = service;
    this.saveConfig({ currentService: service });
  },
  getCurrentService() {
    // 优先从模型选择器读取当前服务的 provider
    if (this.dom && this.dom.modelSelect && this.dom.modelSelect.value) {
      var val = this.dom.modelSelect.value;
      if (val.includes(':')) return val.substring(0, val.indexOf(':'));
    }
    return this.currentService || 'ollama';
  },

  loadConfig() {
    if (!this.CONFIG_FILE) this.setCurrentUser('admin');
    
    const defaultConfig = {
      temperature: 0.7, ollamaModel: 'qwen2.5:7b',
      deepseekModel: 'deepseek-chat', doubaoModel: 'doubao-pro-32k',
      customModel: 'gpt-3.5-turbo', defaultApi: 'ollama',
      autoRoute: false, webSearch: false, deepThink: false, notification: true, disabledPlugins: [],
      appName: 'AI智能体', chatBackground: '', chatBubbleUser: '#3b82f6',
      chatBubbleAI: '#f1f5f9', language: 'zh-CN', searchEngine: 'bocha',
      currentService: 'ollama', bochaApiKey: '', tavilyApiKey: '',
      voiceInput: false, voiceOutput: false, streamResponse: true,
      voxcpmVoice: 'default', voiceProfile: 'default', autoRead: false,
      autoKnowledgeMemory: false,
    imageGenProvider: 'silicon',
    imageGenSize: '1024x1024',
    siliconFlowKey: '',
    siliconFlowModel: 'stabilityai/stable-diffusion-3-5-large',
    openaiImageKey: '',
    openaiImageModel: 'dall-e-3',
    openaiImageBase: 'https://api.openai.com/v1',
    comfyuiBase: 'http://127.0.0.1:8188', vectorBackend: 'json',
    activeTheme: 'dark-default',
      // 🔧 P2: 提示词与角色系统
      prompts: [
        { name: '总结', content: '请总结以下内容的要点，用简洁的语言输出。', icon: 'summarize' },
        { name: '翻译', content: '请将以下内容翻译成中文/英文，保持原意不变。', icon: 'translate' },
        { name: '编程', content: '请帮我编写代码，要求清晰、高效、有注释。', icon: 'code' },
        { name: '解释', content: '请用通俗易懂的方式解释以下内容，适合初学者理解。', icon: 'lightbulb' },
        { name: '优化', content: '请优化以下内容，使其更加通顺、专业、有说服力。', icon: 'auto_awesome' },
      ],
      roles: [
        { name: '通用助手', systemMsg: '你是一个 helpful、honest、harmless 的 AI 助手。', icon: 'smart_toy', description: '通用问答和日常对话' },
        { name: '程序员', systemMsg: '你是一位资深程序员，精通多种编程语言，擅长代码审查、算法优化和架构设计。', icon: 'code', description: '编程、代码审查、技术咨询' },
        { name: '作家', systemMsg: '你是一位专业作家，擅长各类文体写作，包括小说、散文、剧本、公文等。', icon: 'edit_note', description: '写作、编辑、文案创作' },
        { name: '老师', systemMsg: '你是一位经验丰富的教师，善于用通俗易懂的方式解释复杂概念，耐心引导学生学习。', icon: 'school', description: '教学、辅导、知识讲解' },
        { name: '医生', systemMsg: '你是一位专业医生，可以提供健康建议、解释医学知识，但请注意不能替代专业医疗诊断。', icon: 'medical_services', description: '健康咨询、医学知识' },
        { name: '律师', systemMsg: '你是一位专业律师，可以提供法律知识咨询，但请注意不能替代专业法律服务。', icon: 'balance', description: '法律咨询、合同审查' },
        { name: '产品经理', systemMsg: '你是一位资深产品经理，擅长需求分析、用户体验设计和产品规划。', icon: 'analytics', description: '产品设计、需求分析' },
      ],
      currentRole: '通用助手',
      systemInstruction: '你是一个 helpful、honest、harmless 的 AI 助手。',
      favorites: [], // 🔧 收藏夹
    };
    
    // 🔧 P0: 优先从 SQLite 读取配置
    try {
      if (Core.db && Core.db.getAll) {
        const dbConfig = Core.db.getAll();
        const userId = this._currentUser || 'admin';
        const userConfig = Core.db.getUserConfig ? Core.db.getUserConfig(userId) : {};
        
        if (Object.keys(userConfig).length > 0) {
          this.config = { ...defaultConfig, ...userConfig };
          console.log('✅ 配置已从 SQLite 加载');
        } else if (Object.keys(dbConfig).length > 0) {
          this.config = { ...defaultConfig, ...dbConfig };
          console.log('✅ 配置已从 SQLite 全局表加载');
        } else {
          // SQLite 中没有数据，从 JSON 读取并自动迁移
          this.loadConfigFromJSON(defaultConfig);
          
          // 自动迁移到 SQLite
          if (Core.db && Core.db.migrateFromJSON) {
            try {
              Core.db.migrateFromJSON(this._currentUser || 'admin');
              console.log('✅ JSON 配置已自动迁移到 SQLite');
            } catch (e) {
              console.warn('⚠️ 自动迁移失败:', e.message);
            }
          }
        }
      } else {
        // 数据库未加载，回退到 JSON
        this.loadConfigFromJSON(defaultConfig);
      }
    } catch (e) {
      console.warn('⚠️ SQLite 读取失败，回退到 JSON:', e.message);
      this.loadConfigFromJSON(defaultConfig);
    }
    
    // 默认值填充
    if (this.config.temperature === undefined) this.config.temperature = 0.7;
    if (!this.config.ollamaModel) this.config.ollamaModel = 'qwen2.5:7b';
    if (this.config.autoRoute === undefined) this.config.autoRoute = false;
    if (!this.config.searchEngine) this.config.searchEngine = 'bocha';
    if (this.config.currentService) this.currentService = this.config.currentService;
    else this.currentService = 'ollama';
    if (!this.config.prompts || this.config.prompts.length === 0) this.config.prompts = defaultConfig.prompts;
    if (!this.config.roles || this.config.roles.length === 0) this.config.roles = defaultConfig.roles;
    if (!this.config.currentRole) this.config.currentRole = defaultConfig.currentRole;
    if (!this.config.systemInstruction) {
      if (this.config.systemPrompt) {
        this.config.systemInstruction = this.config.systemPrompt;
      } else {
        this.config.systemInstruction = defaultConfig.systemInstruction;
      }
    }
    if (!this.config.disabledPlugins) this.config.disabledPlugins = [];
    if (!this.config.favorites) this.config.favorites = [];
    if (this.config.notification === undefined) this.config.notification = true;
    
    // 🔒 解密敏感字段（自动兼容旧的明文配置）
    let hadPlaintextKeys = false;
    for (const field of SENSITIVE_KEY_FIELDS) {
      if (this.config[field] && typeof this.config[field] === 'string') {
        if (this.config[field].startsWith(ENC_PREFIX)) {
          this.config[field] = decryptValue(this.config[field]);
        } else if (this.config[field].length > 0) {
          // 明文密钥（旧配置），标记需要重新加密保存
          hadPlaintextKeys = true;
        }
      }
    }
    // 如果检测到旧的明文密钥，自动重新保存为加密格式
    if (hadPlaintextKeys) {
      setTimeout(() => {
        try { this.saveConfig({}); } catch(e) { console.warn('⚠️ 自动加密保存失败:', e.message); }
      }, 4000);
    }
    
    return this.config;
  },
  
  // 🔧 从 JSON 读取配置的私有方法
  loadConfigFromJSON(defaultConfig) {
    try {
      if (fs.existsSync(this.CONFIG_FILE) && fs.statSync(this.CONFIG_FILE).isFile()) {
        const content = fs.readFileSync(this.CONFIG_FILE, 'utf8');
        this.config = JSON.parse(content);
      } else {
        this.config = { ...defaultConfig };
      }
    } catch (e) {
      console.warn('配置读取失败，使用默认配置:', e.message);
      this.config = { ...defaultConfig };
    }
  },

  saveConfig(newConfig) {
    // 🔧 确保 temperature 始终为有效数字（防止字符串类型存入配置）
    if (newConfig.temperature !== undefined) {
      var t = Number(newConfig.temperature);
      newConfig.temperature = (isFinite(t) && t >= 0 && t <= 2) ? Math.round(t * 100) / 100 : 0.7;
    }
    this.config = { ...this.config, ...newConfig };
    
    // 🔒 创建加密副本用于持久化（内存中保持明文）
    const configForStorage = encryptSensitiveFields(this.config);
    const newConfigEncrypted = encryptSensitiveFields(newConfig);
    
    // 🔧 仅在 SQLite 模式下写入键值对数据库
    // JSON 回退模式下跳过，避免 admin:xxx 前缀键污染配置文件
    try {
      if (Core.db && Core.db.set && Core.db._backend === 'sqlite') {
        const userId = this._currentUser || 'admin';
        Object.keys(newConfigEncrypted).forEach(key => {
          Core.db.set(userId + ':' + key, JSON.stringify(newConfigEncrypted[key]));
        });
      }
    } catch (e) {
      console.warn('⚠️ SQLite 保存失败:', e.message);
    }
    
    // 保存到 JSON（加密副本）
    try {
      safeWriteFile(this.CONFIG_FILE, JSON.stringify(configForStorage, null, 2));
    } catch (e) {
      console.error('❌ JSON 保存失败:', e.message);
    }
    
    this.emit('configChanged', newConfig, this.config);
  },

  loadModules() {
    const modulesDir = path.join(__dirname, 'modules');
    if (!fs.existsSync(modulesDir)) {
      console.warn('⚠️ modules 目录不存在:', modulesDir);
      return;
    }
    const allFiles = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));

    // 🔧 双重缓存清除（仅限项目自身模块，避免误清第三方包）
    var clearedCount = 0;
    var allKeys = Object.keys(require.cache);
    var _projectModulesPath = path.join(__dirname, 'modules');
    for (var k = 0; k < allKeys.length; k++) {
      if (allKeys[k].indexOf(_projectModulesPath) >= 0) {
        delete require.cache[allKeys[k]];
        clearedCount++;
      }
    }

    // ===== Phase 1: 加载所有模块，收集依赖元数据 =====
    var loadedModules = {};
    for (var i = 0; i < allFiles.length; i++) {
      var file = allFiles[i];
      try {
        var modulePath = path.join(modulesDir, file);
        var mod = require(modulePath);
        var baseName = file.replace('.js', '');
        loadedModules[file] = {
          module: mod,
          name: mod.name || baseName,
          dependencies: mod.dependencies || [],
          file: file,
        };
      } catch (e) {
        console.error('❌ 模块预加载失败 ' + file + ':', e.message);
      }
    }

    // ===== Phase 2: 构建依赖图 → Kahn 拓扑排序 =====
    var nameToFile = {};
    for (var f in loadedModules) {
      nameToFile[loadedModules[f].name] = f;
    }

    var inDegree = {};
    var graph = {};
    for (var f2 in loadedModules) {
      var name = loadedModules[f2].name;
      if (!inDegree[name]) inDegree[name] = 0;
      if (!graph[name]) graph[name] = [];
    }
    for (var f3 in loadedModules) {
      var info = loadedModules[f3];
      for (var d = 0; d < info.dependencies.length; d++) {
        var depName = info.dependencies[d];
        if (nameToFile[depName]) {
          if (!graph[depName]) graph[depName] = [];
          graph[depName].push(info.name);
          inDegree[info.name] = (inDegree[info.name] || 0) + 1;
        }
      }
    }

    var queue = [];
    for (var name2 in inDegree) {
      if (inDegree[name2] === 0) queue.push(name2);
    }
    queue.sort();

    var sortedNames = [];
    while (queue.length > 0) {
      var current = queue.shift();
      sortedNames.push(current);
      var neighbors = graph[current] || [];
      neighbors.sort();
      for (var n = 0; n < neighbors.length; n++) {
        inDegree[neighbors[n]]--;
        if (inDegree[neighbors[n]] === 0) queue.push(neighbors[n]);
      }
      queue.sort();
    }

    if (sortedNames.length < Object.keys(loadedModules).length) {
      console.warn('⚠️ 检测到循环依赖，部分模块将按原始顺序加载');
      for (var f4 in loadedModules) {
        if (sortedNames.indexOf(loadedModules[f4].name) === -1) {
          sortedNames.push(loadedModules[f4].name);
        }
      }
    }

    var sortedFiles = [];
    for (var s = 0; s < sortedNames.length; s++) {
      var targetFile = nameToFile[sortedNames[s]];
      if (targetFile) sortedFiles.push(targetFile);
    }

    // ===== Phase 3: 按拓扑顺序调用 init() =====
    for (var j = 0; j < sortedFiles.length; j++) {
      var file2 = sortedFiles[j];
      var entry = loadedModules[file2];
      if (!entry || typeof entry.module.init !== 'function') {
        continue;
      }
      try {
        if (file2 === 'plugins.js') {
          try {
            if (fs && fs.readFileSync) window.__nodeFs = fs;
            if (path && path.join) window.__nodePath = path;
          } catch (e) { console.warn('⚠️ [core] 暴露 Node API 到 window 失败:', e.message); }
        }
        entry.module.init(this);
      } catch (err) {
        console.error('❌ 模块 ' + file2 + ' init 失败:', err.message);
      }
    }
  },

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }
};

window.Core = Core;

// ===== Toast 通知系统（替代 alert()）=====
Core.showToast = function(message, type, duration) {
  type = type || 'info';
  duration = duration || 3000;
  var container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  var colors = { info: 'var(--primary)', success: 'var(--success)', error: 'var(--danger)', warning: '#f59e0b' };
  var icons = { info: '\u{1F4A1}', success: '\u2705', error: '\u274C', warning: '\u26A0\uFE0F' };
  var toast = document.createElement('div');
  toast.style.cssText = 'pointer-events:auto;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:8px;background:' + (colors[type] || colors.info) + ';color:#fff;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:400px;word-break:break-word;opacity:0;transform:translateX(40px);transition:all 0.3s ease;';
  var iconSpan = document.createElement('span');
  iconSpan.textContent = icons[type] || '';
  var msgSpan = document.createElement('span');
  msgSpan.style.cssText = 'flex:1';
  msgSpan.textContent = message || '';
  var closeSpan = document.createElement('span');
  closeSpan.style.cssText = 'cursor:pointer;opacity:0.7;font-size:16px';
  closeSpan.textContent = '\u00D7';
  closeSpan.onclick = function() { toast.remove(); };
  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);
  toast.appendChild(closeSpan);
  container.appendChild(toast);
  requestAnimationFrame(function() { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
  setTimeout(function() {
    toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)';
    setTimeout(function() { if (toast.parentElement) toast.remove(); }, 300);
  }, duration);
};
Core.showErrorToast = function(message, duration) { Core.showToast(message, 'error', duration || 5000); };
Core.showSuccessToast = function(message, duration) { Core.showToast(message, 'success', duration || 3000); };
Core.showWarningToast = function(message, duration) { Core.showToast(message, 'warning', duration || 4000); };
Core.showNotification = function(title, body) {
  var msg = title;
  if (body) msg += ': ' + body;
  Core.showToast(msg, 'info', 4000);
};
Core.showAlert = function(message) {
  if (Core.showToast) { Core.showToast(message, 'info', 4000); }
  else { alert(message); }
};
window.showToast = Core.showToast;
window.showAlert = Core.showAlert;

// ===== 统一 Loading Spinner =====
Core.showSpinner = function(container, text, options) {
  if (typeof container === 'string') container = document.getElementById(container);
  if (!container) return null;
  Core.hideSpinner(container);
  var opts = options || {};
  var el = document.createElement('div');
  el.className = 'app-spinner' + (opts.size ? ' spinner-' + opts.size : '') + (opts.white ? ' spinner-white' : '');
  el.setAttribute('data-spinner', 'true');
  var ring = document.createElement('div');
  ring.className = 'spinner-ring';
  el.appendChild(ring);
  if (text) {
    var span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
  }
  container.appendChild(el);
  return el;
};
Core.hideSpinner = function(container) {
  if (typeof container === 'string') container = document.getElementById(container);
  if (!container) return;
  var spinners = container.querySelectorAll('[data-spinner="true"]');
  spinners.forEach(function(s) { s.remove(); });
};

// ===== XSS 防护：HTML 消毒 =====
Core.sanitizeHtml = function(html) {
  if (!html || typeof html !== 'string') return '';
  if (window.DOMPurify) return DOMPurify.sanitize(html, {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'sandbox'],
    ALLOW_DATA_ATTR: true
  });
  // Fallback: 移除最危险的标签
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '');
};
// 安全渲染 Markdown：marked.parse() + DOMPurify（带 LRU 缓存）
var _mdCache = new Map();
var _MD_CACHE_MAX = 300;
Core.renderMarkdown = function(text) {
  if (!text) return '';
  if (window.marked) {
    if (_mdCache.has(text)) return _mdCache.get(text);
    var html = Core.sanitizeHtml(marked.parse(text));
    // 将 ComfyUI 直连 URL 重写为代理 URL，避免 ComfyUI 离线时 500 错误
    // 兼容 127.0.0.1 和 localhost，同时处理 &amp; 和 & 两种编码
    var _amp = '(?:&amp;|&)';
    var _comfyRe = new RegExp(
      'https?://(?:127\\.0\\.0\\.1|localhost):8188/view\\?filename=([^"\'\\s&]+)'
      + '(?:' + _amp + 'subfolder=([^"\'\\s&]*))?'
      + '(?:' + _amp + 'type=([^"\'\\s&]*))?', 'g'
    );
    html = html.replace(_comfyRe, function(match, filename, subfolder, type) {
      return 'http://127.0.0.1:8080/api/comfyui/view?filename=' + filename
        + '&subfolder=' + (subfolder || '')
        + '&type=' + (type || 'output');
    });
    // 将过期的 SiliconFlow S3 CDN 图片替换为占位符，避免控制台 500 报错
    html = html.replace(
      /<img\s+src="https?:\/\/s3\.siliconflow\.cn\/[^"]*"[^>]*>/gi,
      '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;'
        + 'background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;'
        + 'color:#f87171;font-size:12px;">\u{1f5bc}\ufe0f 图片链接已过期</span>'
    );
    _mdCache.set(text, html);
    if (_mdCache.size > _MD_CACHE_MAX) {
      // 删除最早的 1/3 条目
      var keys = _mdCache.keys();
      var del = Math.floor(_MD_CACHE_MAX / 3);
      while (del-- > 0) { var k = keys.next(); if (!k.done) _mdCache.delete(k.value); }
    }
    return html;
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

// ===== 统一键盘事件分发器 =====
// 所有 document 级 keydown 监听器统一注册到此，按 priority 排序执行
(function initKeyboardDispatcher() {
  var _keyHandlers = [];
  var _sorted = false;

  Core.keyboard = {
    /**
     * 注册键盘快捷键处理器
     * @param {string} name - 处理器名称（调试用）
     * @param {number} priority - 优先级（数字越小越先执行）
     * @param {Function} handler - fn(e) 返回 false 阻止后续处理器
     */
    register: function(name, priority, handler) {
      _keyHandlers.push({ name: name, priority: priority, handler: handler });
      _sorted = false;
    },
    _list: function() {
      return _keyHandlers.slice().sort(function(a, b) { return a.priority - b.priority; });
    }
  };

  document.addEventListener('keydown', function(e) {
    if (!_sorted) {
      _keyHandlers.sort(function(a, b) { return a.priority - b.priority; });
      _sorted = true;
    }
    for (var i = 0; i < _keyHandlers.length; i++) {
      var result = _keyHandlers[i].handler(e);
      if (result === false) return; // 返回 false 表示已处理，阻止后续
    }
  });
})();

// ===== 启动入口 =====
(function main() {

  var _currentQuote = null;

  // 🔧 缓存清除由 loadModules() 统一处理，此处不再重复
  
  const ids = [
    'chatContainer', 'chatList', 'input', 'send', 'status',
    'modelSelect', 'refreshModelsBtn', 'webSearchBtn', 'deepThinkBtn',
    'voiceBtn', 'speakBtn', 'imageBtn', 'promptBtn', 'roleBtn', 'streamBtn', 'agentModeBtn',
    'appsMenuBtn', 'modelTagName',
    'settingsModal', 'appNameInput', 'bgInput',
    'bubbleUserInput', 'bubbleAIInput', 'temperatureSlider', 'tempDisplay',
    'systemPrompt', 'ollamaModel', 'deepseekKey', 'deepseekModel',
    'doubaoKey', 'doubaoModel', 'qwenKey', 'qwenModel',
    'customBase', 'customKey', 'customModel',
    'saveSettingsBtn', 'closeSettingsBtn', 'openSettingsBtn', 'openVoiceBtn',
    'newChatBtn', 'appTitle', 'autoRouteCheckbox',
    'uploadBtn', 'fileInput', 'exportBtn', 'checkUpdateBtn',
    'languageSelect', 'switchUserBtn', 'currentUserDisplay',
    'searchEngineSelect', 'bochaApiKey', 'tavilyApiKey',
    'loginOverlay', 'loginUsername', 'loginBtn', 'registerBtn', 'loginError'
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) Core.dom[id] = el;
  }
  Core.dom.sendBtn = Core.dom.send || document.getElementById('send');
  Core.dom.tempSlider = Core.dom.temperatureSlider || document.getElementById('temperatureSlider');
  Core.dom.chatContainer = Core.dom.chatContainer || document.getElementById('chatContainer');

  // ===== Core.ui 抽象层（Gateway 化基础：事件广播 + DOM 兼容）=====
  // 每个方法同时执行 DOM 操作（本地 Electron）和 emit 事件（远程客户端 via WebSocket）
  // 远程客户端（手机/Web/开发板）监听这些事件来渲染自己的 UI
  Core.ui = {
    // 状态栏
    setStatus: function(text) {
      if (Core.dom.status) Core.dom.status.textContent = text;
      Core.emit('ui:status', { text: text, time: Date.now() });
    },

    // 追加聊天消息（role: user/ai/system, content: 文本或HTML）
    appendMessage: function(role, content, options) {
      options = options || {};
      Core.emit('ui:message', {
        role: role,
        content: content,
        sessionId: options.sessionId || (Core.session && Core.session.getCurrentId ? Core.session.getCurrentId() : null),
        streaming: options.streaming || false,
        time: Date.now()
      });
    },

    // 流式更新最后一条 AI 消息
    updateLastMessage: function(content, done) {
      Core.emit('ui:stream', { content: content, done: !!done, time: Date.now() });
    },

    // 设置输入框内容
    setInput: function(text) {
      if (Core.dom.input) {
        Core.dom.input.value = text;
        Core.dom.input.focus();
      }
      Core.emit('ui:input', { text: text, time: Date.now() });
    },

    // 获取输入框内容
    getInput: function() {
      return (Core.dom.input && Core.dom.input.value) || '';
    },

    // 发送按钮状态
    setSendEnabled: function(enabled) {
      if (Core.dom.sendBtn) Core.dom.sendBtn.disabled = !enabled;
      Core.emit('ui:sendState', { enabled: enabled, time: Date.now() });
    },

    // 打字指示器
    setTyping: function(active) {
      Core.emit('ui:typing', { active: active, time: Date.now() });
    },

    // 桌面通知
    notify: function(title, body) {
      Core.emit('ui:notify', { title: title, body: body, time: Date.now() });
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, { body: body });
        }
      } catch (e) {}
    },

    // 应用标题
    setTitle: function(title) {
      if (typeof document !== 'undefined') document.title = title;
      if (Core.dom.appTitle) Core.dom.appTitle.textContent = title;
      Core.emit('ui:title', { title: title, time: Date.now() });
    },

    // 会话列表更新
    sessionUpdated: function(sessionId, title) {
      Core.emit('ui:session', { sessionId: sessionId, title: title, time: Date.now() });
    },

    // Agent 步骤更新（实时进度）
    agentStep: function(step, action, status, detail) {
      Core.emit('ui:agentStep', { step: step, action: action, status: status, detail: detail, time: Date.now() });
    },

    // 工具调用广播（跨设备路由用）
    toolCall: function(tool, params, targetDevice) {
      Core.emit('gateway:toolCall', { tool: tool, params: params, targetDevice: targetDevice, time: Date.now() });
    },

    // 设备状态变更
    deviceStatus: function(deviceId, status, capabilities) {
      Core.emit('gateway:device', { deviceId: deviceId, status: status, capabilities: capabilities, time: Date.now() });
    }
  };

  // 🔧 浮动输入框：新建对话按钮 + 模型标签更新
  // 🔧 应用与插件菜单
  (function initAppsMenu() {
    var appsBtn = document.getElementById('appsMenuBtn');
    var appsPanel = document.getElementById('appsMenuPanel');
    var appsClose = document.getElementById('appsMenuClose');
    if (!appsBtn || !appsPanel) return;

    appsBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      appsPanel.classList.toggle('active');
    });
    if (appsClose) {
      appsClose.addEventListener('click', function() {
        appsPanel.classList.remove('active');
      });
    }
    document.addEventListener('click', function(e) {
      if (appsPanel.classList.contains('active') && !appsPanel.contains(e.target) && e.target !== appsBtn) {
        appsPanel.classList.remove('active');
      }
    });
    // 菜单项点击
    appsPanel.querySelectorAll('.apps-menu-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var action = item.getAttribute('data-action');
        appsPanel.classList.remove('active');
        if (action === 'memo') {
          if (Core.memo && Core.memo.open) Core.memo.open();
        } else if (action === 'knowledge') {
          if (Core.dom.openSettingsBtn) Core.dom.openSettingsBtn.click();
          // 滚动到知识库区域并展开
          setTimeout(function() {
            var kbGroup = document.getElementById('knowledgeGroup');
            if (kbGroup) {
              kbGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
              var details = kbGroup.closest('details');
              if (details) details.open = true;
            }
          }, 350);
        } else if (action === 'agent') {
          // 切换 Agent 模式按钮
          var agentBtn = document.getElementById('agentModeBtn');
          if (agentBtn) { agentBtn.click(); }
          else if (Core.dom.input) { Core.dom.input.value = '/agent '; Core.dom.input.focus(); }
        } else if (action === 'tools') {
          if (Core.dom.openSettingsBtn) Core.dom.openSettingsBtn.click();
          setTimeout(function() {
            var toolsGroup = document.getElementById('toolsGroup');
            if (toolsGroup) {
              toolsGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
              var details = toolsGroup.closest('details');
              if (details) details.open = true;
            }
          }, 350);
        } else if (action === 'history') {
          var chatSearch = document.getElementById('chatSearch');
          if (chatSearch) chatSearch.focus();
        } else if (action === 'export-all') {
          var exportBtn = document.getElementById('exportBtn');
          if (exportBtn) exportBtn.click();
        }
      });
    });
  })();
  var modelSelect = document.getElementById('modelSelect');
  var modelTagName = document.getElementById('modelTagName');
  if (modelSelect && modelTagName) {
    // 初始化标签
    modelTagName.textContent = modelSelect.options[modelSelect.selectedIndex]
      ? modelSelect.options[modelSelect.selectedIndex].text : 'Model';
    // 监听变更
    modelSelect.addEventListener('change', function() {
      modelTagName.textContent = modelSelect.options[modelSelect.selectedIndex].text;
    });
  }

  Core.setCurrentUser('admin');
  Core.loadConfig();
  
  // 🔧 修复：启动时将配置温度加载到UI
  setTimeout(() => {
    const tempSlider = document.getElementById('temperatureSlider');
    const tempDisplay = document.getElementById('tempDisplay');
    if (tempSlider && Core.config.temperature !== undefined) {
      tempSlider.value = Core.config.temperature;
      if (tempDisplay) tempDisplay.textContent = Core.config.temperature;
    }
  }, 100);
  
  // 🔧 延迟加载模块，确保 marked 库已加载后再渲染消息
  var markedCheckCount = 0;
  function loadModulesWhenReady() {
    if (window.marked) {
      Core.loadModules();
    } else if (markedCheckCount < 60) {
      markedCheckCount++;
      console.log('⏳ 等待 marked 库加载... (' + markedCheckCount + '/60)');
      setTimeout(loadModulesWhenReady, 50);
    } else {
      console.warn('⚠️ marked 库加载超时，继续初始化');
      Core.loadModules();
    }
  }
  loadModulesWhenReady();

  if (Core.config.appName) {
    document.title = Core.config.appName;
    if (Core.dom.appTitle) Core.dom.appTitle.textContent = Core.config.appName;
  }

  if (Core.dom.refreshModelsBtn) {
    Core.dom.refreshModelsBtn.addEventListener('click', async () => {
      Core.dom.refreshModelsBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;">hourglass_empty</span>';
      Core.dom.status.textContent = '🔄 正在获取模型...';
      await refreshModels();
      Core.dom.refreshModelsBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;">refresh</span>';
      Core.dom.status.textContent = '✅ 模型列表已刷新';
      setTimeout(() => { Core.dom.status.textContent = `✅ 已就绪 (${Core.getCurrentService()})`; }, 2000);
    });
    setTimeout(() => refreshModels(), 1500);
  }

  // 温度保存
  if (Core.dom.tempSlider) {
    Core.dom.tempSlider.addEventListener('change', (e) => {
      Core.saveConfig({ temperature: parseFloat(e.target.value) });
    });
  }

  if (Core.dom.tempSlider) {
    Core.dom.tempSlider.addEventListener('input', (e) => {
      const display = document.getElementById('tempDisplay');
      if (display) display.textContent = e.target.value;
    });
  }

  // ===== 方向A1：消息搜索（Ctrl+F）=====
  // 🔧 由 index.html initMsgSearch 统一实现（含预览面板、搜索历史、按钮绑定）
  // 🔧 图片预览、代码高亮、字体、TTS、Mermaid 已提取到 modules/ui-media.js
  // ===== 工具栏按钮统一初始化 =====
  (function initToolbarButtons() {
    // 联网按钮：由 search.js 负责初始化和事件绑定
    // 这里只做备份启用（处理 search.js 延迟加载的情况）
    var webBtn = document.getElementById('webSearchBtn');
    if (webBtn && webBtn.disabled) {
      var engine = Core.config.searchEngine || 'bocha';
      var needsKey = (engine === 'bocha' && !Core.config.bochaApiKey) ||
                     (engine === 'tavily' && !Core.config.tavilyApiKey);
      if (!needsKey) {
        webBtn.disabled = false;
      }
    }
    // 恢复联网按钮上次状态（search.js init 之后执行，覆盖 search.js 的状态）
    if (webBtn && Core.config.webSearch && !webBtn.disabled) {
      webBtn.classList.add('active');
    }

    // 🔧 深度思考按钮由 think.js 模块统一管理（避免双重绑定）

  })();

  const streamBtn = document.getElementById('streamBtn');
  if (streamBtn) {
    streamBtn.addEventListener('click', () => {
      streamBtn.classList.toggle('active');
      Core.saveConfig({ streamResponse: streamBtn.classList.contains('active') });
    });
    if (Core.config.streamResponse !== false) streamBtn.classList.add('active');
  }

  // 🔧 Agent 模式切换按钮
  (function initAgentModeBtn() {
    var agentBtn = document.getElementById('agentModeBtn');
    if (!agentBtn) return;
    // 恢复状态
    if (Core.config.agentMode) agentBtn.classList.add('active');
    agentBtn.addEventListener('click', function() {
      agentBtn.classList.toggle('active');
      var isActive = agentBtn.classList.contains('active');
      Core.saveConfig({ agentMode: isActive });
      // 视觉反馈
      var status = document.getElementById('status');
      if (status) {
        status.textContent = isActive ? '🤖 Agent 模式已启用 — AI 可自主调用工具完成任务' : '💬 Chat 模式 — 普通对话';
        setTimeout(function() { status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
      }
    });
  })();

  // ============================================================
  // 选项1-5：聊天记录导出 + 文件拖拽 + 剪贴板粘贴 + 快捷键 + 主题切换
  // ============================================================


  // 🔧 已提取到 modules/ui-interactions.js（文件拖拽 + 剪贴板粘贴 + 快捷键 + 主题切换）

  console.log('✅ Core 启动完成');

  // ===== 选项1：消息编辑与重新生成 =====
  // ===== 选项1：消息操作增强（编辑/复制/重新生成/删除/多选/右键菜单）=====
  // 注意：消息悬停操作按钮已统一由 ux-enhance.js 的 msg-hover-actions（Material Icons）提供
  // 此处仅保留多选模式和右键菜单功能
  function initMessageActions() {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    if (chatContainer._msgActionsInit) return;
    chatContainer._msgActionsInit = true;

    // 初始化多选模式和右键菜单
    initMultiSelect();
    initContextMenu();

  }

  function createMsgActions(msgDiv) {
    var isUser = msgDiv.classList.contains('user');
    var isAI = msgDiv.classList.contains('ai');
    
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'msg-actions-inline';
    actionsDiv.style.cssText = 'position:absolute;top:4px;right:4px;display:flex;gap:3px;opacity:0;transition:opacity 0.2s;z-index:5;pointer-events:none;';
    
    function makeBtn(html, title, onClick) {
      var btn = document.createElement('button');
      btn.innerHTML = html;
      btn.title = title;
      btn.style.cssText = 'background:rgba(40,40,40,0.85);border:1px solid #444;border-radius:50%;width:24px;height:24px;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;color:#ccc;transition:all 0.15s;';
      btn.addEventListener('mouseenter', function() { btn.style.background = '#555'; btn.style.color = '#fff'; });
      btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(40,40,40,0.85)'; btn.style.color = '#ccc'; });
      btn.addEventListener('click', function(ev) { ev.stopPropagation(); onClick(); });
      return btn;
    }
    
    if (isUser) {
      // 用户消息：编辑、撤回、收藏、删除
      actionsDiv.appendChild(makeBtn('\u270f\ufe0f', '编辑并重新发送', function() {
        enterEditMode(msgDiv);
      }));
      actionsDiv.appendChild(makeBtn('\u21a9\ufe0f', '撤回消息（5分钟内）', function() {
        withdrawMessage(msgDiv);
      }));
      actionsDiv.appendChild(makeBtn('\u2b50', '收藏消息', function() {
        toggleFavorite(msgDiv);
      }));
      actionsDiv.appendChild(makeBtn('\ud83d\uddd1\ufe0f', '删除此消息', function() {
        if (confirm('删除此消息？')) deleteSingleMessage(msgDiv);
      }));
    } else if (isAI) {
      // AI消息：复制、重新生成、收藏、删除
      actionsDiv.appendChild(makeBtn('\ud83d\udccb', '复制内容', function() {
        copyMessage(msgDiv);
      }));
      actionsDiv.appendChild(makeBtn('\ud83d\udd01', '重新生成', function() {
        regenerateMessage(msgDiv);
      }));
      actionsDiv.appendChild(makeBtn('\u2b50', '收藏消息', function() {
        toggleFavorite(msgDiv);
      }));
      actionsDiv.appendChild(makeBtn('\ud83d\uddd1\ufe0f', '删除此消息', function() {
        if (confirm('删除此消息？')) deleteSingleMessage(msgDiv);
      }));
    }
    
    msgDiv.style.position = 'relative';
    return actionsDiv;
  }

  function toggleFavorite(msgDiv) {
    var container = document.getElementById('chatContainer');
    if (!container || !msgDiv) return;
    var allMsgs = container.querySelectorAll('.msg');
    var msgIndex = Array.prototype.indexOf.call(allMsgs, msgDiv);
    if (msgIndex < 0) return;
    
    var sessionId = Core.session.getCurrentId();
    if (!sessionId || !Core.session.sessions[sessionId] || !Core.session.sessions[sessionId].messages) return;
    
    var msgData = Core.session.sessions[sessionId].messages[msgIndex];
    if (!msgData) return;
    
    // 获取或初始化收藏列表
    if (!Core.config.favorites) Core.config.favorites = [];
    var favorites = Core.config.favorites;
    
    // 生成唯一ID
    var favId = sessionId + '_' + msgIndex + '_' + (msgData.timestamp || Date.now());
    var existingIndex = -1;
    for (var i = 0; i < favorites.length; i++) {
      if (favorites[i].id === favId) {
        existingIndex = i;
        break;
      }
    }
    
    if (existingIndex >= 0) {
      // 取消收藏
      favorites.splice(existingIndex, 1);
      Core.saveConfig({ favorites: favorites });
      Core.dom.status.textContent = '❌ 已取消收藏';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    } else {
      // 添加收藏
      var clone = msgDiv.cloneNode(true);
      var toRemove = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .quick-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .typing-cursor, .msg-checkbox, .material-icons-outlined, .material-icons, .code-btn-group');
      toRemove.forEach(function(t) { t.remove(); });
      var text = clone.textContent.trim();
      
      favorites.push({
        id: favId,
        sessionId: sessionId,
        msgIndex: msgIndex,
        role: msgData.role || (msgDiv.classList.contains('user') ? 'user' : 'ai'),
        content: text.substring(0, 500),
        timestamp: msgData.timestamp || Date.now(),
        sessionTitle: Core.session.sessions[sessionId].title || '未命名会话'
      });
      Core.saveConfig({ favorites: favorites });
      Core.dom.status.textContent = '⭐ 已收藏消息';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    }
  }

  function enterEditMode(msgDiv) {
    // 获取消息索引
    var chatContainer = document.getElementById('chatContainer');
    var allMsgs = Array.from(chatContainer.querySelectorAll('.msg'));
    var msgIndex = allMsgs.indexOf(msgDiv);
    if (msgIndex < 0) return;
    
    // 获取原始文本（排除时间戳和按钮）
    var clone = msgDiv.cloneNode(true);
    var timestamps = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .quick-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .typing-cursor, .msg-checkbox, .material-icons-outlined, .material-icons, .code-btn-group');
    timestamps.forEach(function(t) { t.remove(); });
    var text = clone.textContent.trim();
    
    // 创建编辑区域
    var wrapper = document.createElement('div');
    wrapper.className = 'msg-edit-wrapper';
    wrapper.style.cssText = 'width:100%;';
    
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'width:100%;min-height:60px;padding:10px 12px;border:2px solid var(--primary);border-radius:10px;font-family:inherit;font-size:14px;resize:vertical;outline:none;background:#1a1a1a;color:#e8e8e8;line-height:1.5;';
    
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    
    var saveBtn = document.createElement('button');
    saveBtn.textContent = '\u2705 保存并重新发送';
    saveBtn.style.cssText = 'padding:6px 14px;background:var(--primary);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;';
    
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = '\u274c 取消';
    cancelBtn.style.cssText = 'padding:6px 14px;background:#2a2a2a;color:#e8e8e8;border:1px solid #444;border-radius:8px;cursor:pointer;font-size:13px;';
    
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    wrapper.appendChild(textarea);
    wrapper.appendChild(btnRow);
    
    // 保存原始内容
    var originalHTML = msgDiv.innerHTML;
    var originalClass = msgDiv.className;
    
    // 清空并显示编辑区
    msgDiv.innerHTML = '';
    msgDiv.className = originalClass + ' editing';
    msgDiv.appendChild(wrapper);
    textarea.focus();
    textarea.select();
    
    function restore() {
      msgDiv.innerHTML = originalHTML;
      msgDiv.className = originalClass;
    }
    
    saveBtn.addEventListener('click', function() {
      var newText = textarea.value.trim();
      if (!newText) { restore(); return; }
      
      // 🔧 从原消息位置开始截断（删除原消息及其后续所有消息）
      var sessionId = Core.session.getCurrentId();
      var sessions = Core.session.sessions;
      if (sessionId && sessions[sessionId] && sessions[sessionId].messages) {
        var msgs = sessions[sessionId].messages;
        if (msgIndex < msgs.length) {
          // 从 msgIndex 开始截断，删除原消息及后续所有消息
          msgs.splice(msgIndex, msgs.length - msgIndex);
          Core.session.saveSession(sessionId);
        }
      }
      
      // 恢复原始显示（编辑区域消失）
      restore();
      
      // 🔧 将新内容放入输入框并发送
      if (Core.dom.input) {
        Core.dom.input.value = newText;
      }
      
      // 重新发送（仅对用户消息）
      if (msgDiv.classList.contains('user')) {
        if (Core.api && Core.api.sendMessage) {
          Core.api.sendMessage();
        }
      }
    });
    
    cancelBtn.addEventListener('click', restore);
    
    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        restore();
      }
    });
  }

  function copyMessage(msgDiv) {
    // 🔧 优先复制用户选中的文本（局部复制）
    var selection = window.getSelection();
    if (selection && selection.toString().trim() && msgDiv.contains(selection.anchorNode)) {
      navigator.clipboard.writeText(selection.toString().trim()).then(function() {
        Core.dom.status.textContent = '✅ 已复制选中内容';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
      }).catch(function() {
        Core.dom.status.textContent = '❌ 复制失败';
      });
      return;
    }

    // 复制整条消息
    var clone = msgDiv.cloneNode(true);
    var toRemove = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .quick-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .typing-cursor, .msg-checkbox, .material-icons-outlined, .material-icons, .code-btn-group');
    toRemove.forEach(function(t) { t.remove(); });
    var text = clone.textContent.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(function() {
      Core.dom.status.textContent = '\u2705 内容已复制到剪贴板';
      setTimeout(function() { Core.dom.status.textContent = '\u2705 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    }).catch(function() {
      Core.dom.status.textContent = '\u274c 复制失败';
    });
  }

  function deleteSingleMessage(msgDiv) {
    var container = document.getElementById('chatContainer');
    if (!container || !msgDiv) return;
    var allMsgs = container.querySelectorAll('.msg');
    var msgIndex = Array.prototype.indexOf.call(allMsgs, msgDiv);
    if (msgIndex >= 0) {
      var sessionId = Core.session.getCurrentId();
      var sessions = Core.session.sessions;
      if (sessionId && sessions[sessionId] && sessions[sessionId].messages) {
        var msgs = sessions[sessionId].messages;
        if (msgIndex < msgs.length) {
          msgs.splice(msgIndex, 1);
          Core.session.saveSession(sessionId);
        }
      }
    }
    msgDiv.parentNode.removeChild(msgDiv);
  }

  function regenerateMessage(msgDiv) {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    var allMsgs = Array.from(chatContainer.querySelectorAll('.msg'));
    var currentIndex = allMsgs.indexOf(msgDiv);
    if (currentIndex <= 0) {
      Core.dom.status.textContent = '\u26a0\ufe0f 没有找到用户消息';
      return;
    }
    var userMsg = null;
    for (var i = currentIndex - 1; i >= 0; i--) {
      if (allMsgs[i].classList.contains('user')) {
        userMsg = allMsgs[i];
        break;
      }
    }
    if (!userMsg) {
      Core.dom.status.textContent = '\u26a0\ufe0f 没有找到用户消息';
      return;
    }
    var userText = userMsg.textContent.trim();
    var timestamp = userMsg.querySelector('.msg-timestamp');
    if (timestamp) userText = userText.replace(timestamp.textContent, '').trim();
    if (!userText) return;
    msgDiv.parentNode.removeChild(msgDiv);
    if (Core.api && Core.api.sendMessage) {
      Core.dom.input.value = userText;
      Core.api.sendMessage();
    }
  }

  // 暴露给 ux-enhance.js 消息操作按钮使用
  Core.enterEditMode = enterEditMode;
  Core.regenerateMessage = regenerateMessage;

  // ===== 消息引用/回复功能 =====
  function initQuoteBar() {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    // 引用条已存在则不再创建
    if (document.getElementById('quoteBar')) return;

    var quoteBar = document.createElement('div');
    quoteBar.id = 'quoteBar';
    quoteBar.style.cssText = 'display:none;position:fixed;bottom:105px;left:50%;transform:translateX(-50%);z-index:210;align-items:center;gap:8px;padding:6px 12px;max-width:80%;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.3);';
    quoteBar.innerHTML = '<span id="quoteBarText" style="color:#94a3b8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:400px;"></span>' +
      '<button id="quoteBarCancel" style="background:transparent;border:none;color:#94a3b8;font-size:14px;cursor:pointer;padding:2px 4px;line-height:1;" title="取消引用">\u00d7</button>';

    document.body.appendChild(quoteBar);

    document.getElementById('quoteBarCancel').addEventListener('click', function() {
      clearQuote();
    });
  }

  function setQuote(msgDiv) {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    var allMsgs = Array.from(chatContainer.querySelectorAll('.msg'));
    var msgIndex = allMsgs.indexOf(msgDiv);
    if (msgIndex < 0) return;

    var isUser = msgDiv.classList.contains('user');
    var clone = msgDiv.cloneNode(true);
    var toRemove = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .quick-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .typing-cursor, .msg-checkbox, .material-icons-outlined, .material-icons, .code-btn-group');
    toRemove.forEach(function(t) { t.remove(); });
    var text = clone.textContent.trim();

    _currentQuote = {
      msgIndex: msgIndex,
      role: isUser ? 'user' : 'ai',
      content: text
    };

    var quoteBar = document.getElementById('quoteBar');
    if (!quoteBar) initQuoteBar();
    quoteBar = document.getElementById('quoteBar');
    var quoteText = document.getElementById('quoteBarText');
    if (quoteText) {
      var prefix = isUser ? '\u3010\u5f15\u7528\u7528\u6237\u3011' : '\u3010\u5f15\u7528AI\u3011';
      var display = text.length > 50 ? text.substring(0, 50) + '...' : text;
      quoteText.textContent = prefix + display;
    }
    quoteBar.style.display = 'flex';
    Core.dom.status.textContent = '\u2705 \u5df2\u5f15\u7528\u6d88\u606f';
    setTimeout(function() { Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + Core.getCurrentService() + ')'; }, 2000);
  }

  function clearQuote() {
    _currentQuote = null;
    var quoteBar = document.getElementById('quoteBar');
    if (quoteBar) quoteBar.style.display = 'none';
  }

  function getQuote() {
    return _currentQuote;
  }

  // 将引用函数暴露到 Core，供 api.js 使用
  Core.setQuote = setQuote;
  Core.clearQuote = clearQuote;
  Core.getQuote = getQuote;

  // ===== 多选模式：批量删除 =====
  function initMultiSelect() {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;
    if (chatContainer._multiSelectInit) return;
    chatContainer._multiSelectInit = true;

    // 移除旧元素（如果有的话）
    var oldBtn = document.getElementById('multiSelectToggle');
    if (oldBtn) oldBtn.remove();
    var oldBar = document.getElementById('multiSelectActionBar');
    if (oldBar) oldBar.remove();

    // 创建多选切换按钮（隐藏：通过右键菜单触发）
    var multiSelectBtn = document.createElement('button');
    multiSelectBtn.id = 'multiSelectToggle';
    multiSelectBtn.textContent = '\u2611\ufe0f 多选';
    multiSelectBtn.title = '开启多选模式，批量删除消息';
    multiSelectBtn.style.cssText = 'display:none;';
    document.body.appendChild(multiSelectBtn);

    // 创建底部操作栏
    var actionBar = document.createElement('div');
    actionBar.id = 'multiSelectActionBar';
    actionBar.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:250;display:none;align-items:center;gap:10px;padding:8px 16px;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.4);';
    
    actionBar.innerHTML = '<span id="multiSelectCount" style="color:#ccc;font-size:13px;margin-right:8px;">已选 0 条</span>';
    
    function makeActionBtn(text, title, onClick, bg) {
      var btn = document.createElement('button');
      btn.textContent = text;
      btn.title = title;
      btn.style.cssText = 'padding:5px 12px;border-radius:6px;border:none;font-size:12px;cursor:pointer;color:#fff;transition:all 0.15s;' + (bg || 'background:#3a3a3a;');
      btn.addEventListener('mouseenter', function() { btn.style.opacity = '0.85'; });
      btn.addEventListener('mouseleave', function() { btn.style.opacity = '1'; });
      btn.addEventListener('click', onClick);
      return btn;
    }
    
    actionBar.appendChild(makeActionBtn('\u2611\ufe0f 全选', '选中所有消息', function() {
      document.querySelectorAll('.msg-checkbox').forEach(function(cb) { cb.checked = true; });
      updateMultiSelectCount();
    }, 'background:#3a3a3a;'));
    actionBar.appendChild(makeActionBtn('\u2610 反选', '反选消息', function() {
      document.querySelectorAll('.msg-checkbox').forEach(function(cb) { cb.checked = !cb.checked; });
      updateMultiSelectCount();
    }, 'background:#3a3a3a;'));
    actionBar.appendChild(makeActionBtn('\ud83d\udccb 复制选中', '复制选中的消息内容', function() {
      copySelectedMessages();
    }, 'background:#3a3a3a;'));
    actionBar.appendChild(makeActionBtn('\ud83d\udcca 导出选中', '导出选中的消息为Markdown', function() {
      exportSelectedMessages('markdown');
    }, 'background:#3a3a3a;'));
    actionBar.appendChild(makeActionBtn('\ud83d\uddd1\ufe0f 删除选中', '删除选中的消息', function() {
      deleteSelectedMessages();
    }, 'background:#ef4444;'));
    actionBar.appendChild(makeActionBtn('\u274c 取消', '退出多选模式', function() {
      exitMultiSelectMode();
    }, 'background:#2a2a2a;'));
    
    document.body.appendChild(actionBar);

    // 当聊天区域清空时自动退出多选模式（仅监听直接子节点，不含 subtree）
    var observer = new MutationObserver(function() {
      var hasMsgs = chatContainer.querySelectorAll('.msg').length > 0;
      if (!hasMsgs) exitMultiSelectMode();
    });
    observer.observe(chatContainer, { childList: true });

    // 多选按钮点击
    multiSelectBtn.addEventListener('click', function() {
      if (multiSelectBtn.classList.contains('active')) {
        exitMultiSelectMode();
      } else {
        enterMultiSelectMode();
      }
    });
  }

  function enterMultiSelectMode() {
    var btn = document.getElementById('multiSelectToggle');
    var bar = document.getElementById('multiSelectActionBar');
    if (!btn || !bar) return;
    btn.classList.add('active');
    btn.textContent = '\u274c 退出多选';
    btn.style.background = '#3a3a3a';
    bar.style.display = 'flex';
    
    // 为所有消息添加复选框
    document.querySelectorAll('.msg').forEach(function(msg) {
      if (msg.querySelector('.msg-checkbox')) return;
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'msg-checkbox';
      cb.style.cssText = 'position:absolute;top:8px;left:8px;width:16px;height:16px;cursor:pointer;z-index:6;accent-color:var(--primary);';
      cb.addEventListener('change', updateMultiSelectCount);
      msg.appendChild(cb);
    });
    updateMultiSelectCount();
  }

  function exitMultiSelectMode() {
    var btn = document.getElementById('multiSelectToggle');
    var bar = document.getElementById('multiSelectActionBar');
    if (!btn || !bar) return;
    btn.classList.remove('active');
    btn.textContent = '\u2611\ufe0f 多选';
    btn.style.background = '#2a2a2a';
    bar.style.display = 'none';
    
    // 移除所有复选框
    document.querySelectorAll('.msg-checkbox').forEach(function(cb) { cb.remove(); });
  }
  Core.exitMultiSelectMode = exitMultiSelectMode;

  function updateMultiSelectCount() {
    var count = document.querySelectorAll('.msg-checkbox:checked').length;
    var countSpan = document.getElementById('multiSelectCount');
    if (countSpan) countSpan.textContent = '已选 ' + count + ' 条';
  }

  function deleteSelectedMessages() {
    var checked = document.querySelectorAll('.msg-checkbox:checked');
    if (checked.length === 0) {
      showAlert('请先勾选要删除的消息');
      return;
    }
    if (!confirm('确定删除选中的 ' + checked.length + ' 条消息吗？')) return;
    
    var indices = [];
    checked.forEach(function(cb) {
      var msg = cb.closest('.msg');
      if (msg) {
        var container = document.getElementById('chatContainer');
        var allMsgs = container.querySelectorAll('.msg');
        var idx = Array.prototype.indexOf.call(allMsgs, msg);
        if (idx >= 0) indices.push(idx);
      }
    });
    
    // 按索引降序排序，避免删除时索引变化
    indices.sort(function(a, b) { return b - a; });
    
    var sessionId = Core.session.getCurrentId();
    var sessions = Core.session.sessions;
    if (sessionId && sessions[sessionId] && sessions[sessionId].messages) {
      var msgs = sessions[sessionId].messages;
      indices.forEach(function(idx) {
        if (idx < msgs.length) msgs.splice(idx, 1);
      });
      Core.session.saveSession(sessionId);
      console.log('\u2705 已批量删除', indices.length, '条消息');
    }
    
    // 从 DOM 中移除
    checked.forEach(function(cb) {
      var msg = cb.closest('.msg');
      if (msg) msg.parentNode.removeChild(msg);
    });
    
    exitMultiSelectMode();
    Core.dom.status.textContent = '\u2705 已删除 ' + indices.length + ' 条消息';
    setTimeout(function() { Core.dom.status.textContent = '\u2705 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
  }

  function copySelectedMessages() {
    var checked = document.querySelectorAll('.msg-checkbox:checked');
    if (checked.length === 0) {
      Core.dom.status.textContent = '⚠️ 请先勾选要复制的消息';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
      return;
    }
    var texts = [];
    checked.forEach(function(cb) {
      var msg = cb.closest('.msg');
      if (msg) {
        var clone = msg.cloneNode(true);
        var toRemove = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .quick-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .typing-cursor, .msg-checkbox, .material-icons-outlined, .material-icons, .code-btn-group');
        toRemove.forEach(function(t) { t.remove(); });
        var role = msg.classList.contains('user') ? '用户' : 'AI';
        var text = clone.textContent.trim();
        if (text) texts.push('[' + role + ']\n' + text);
      }
    });
    if (texts.length === 0) {
      Core.dom.status.textContent = '⚠️ 选中的消息内容为空';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
      return;
    }
    var fullText = texts.join('\n\n---\n\n');
    navigator.clipboard.writeText(fullText).then(function() {
      Core.dom.status.textContent = '✅ 已复制 ' + checked.length + ' 条消息';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    }).catch(function() {
      Core.dom.status.textContent = '❌ 复制失败';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    });
  }

  function exportSelectedMessages(format) {
    var checked = document.querySelectorAll('.msg-checkbox:checked');
    if (checked.length === 0) {
      Core.dom.status.textContent = '⚠️ 请先勾选要导出的消息';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
      return;
    }
    var sessionId = Core.session.getCurrentId();
    var sessions = Core.session.sessions;
    if (!sessionId || !sessions[sessionId] || !sessions[sessionId].messages) return;
    var allMsgs = sessions[sessionId].messages;
    var container = document.getElementById('chatContainer');
    var domMsgs = container.querySelectorAll('.msg');
    var indices = [];
    checked.forEach(function(cb) {
      var msg = cb.closest('.msg');
      if (msg) {
        var idx = Array.prototype.indexOf.call(domMsgs, msg);
        if (idx >= 0) indices.push(idx);
      }
    });
    indices.sort(function(a, b) { return a - b; });
    var selectedMsgs = indices.map(function(idx) { return allMsgs[idx]; }).filter(function(m) { return !!m; });
    var content = '';
    var filename = 'messages-export-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.';
    if (format === 'markdown') {
      filename += 'md';
      var mdLines = ['# 导出消息\n\n'];
      selectedMsgs.forEach(function(m) {
        var role = m.role === 'user' ? '👤 用户' : '🤖 AI';
        var time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : '';
        mdLines.push('## ' + role + (time ? ' (' + time + ')' : '') + '\n\n' + (m.content || '').trim() + '\n');
      });
      content = mdLines.join('\n---\n\n');
    } else {
      filename += 'json';
      content = JSON.stringify(selectedMsgs, null, 2);
    }
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
    Core.dom.status.textContent = '✅ 已导出 ' + selectedMsgs.length + ' 条消息';
    setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
  }

  // ===== 右键菜单 =====
  function initContextMenu() {
    var chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    // 移除旧的右键菜单和事件监听器
    var oldMenu = document.getElementById('msgContextMenu');
    if (oldMenu) oldMenu.remove();
    if (chatContainer._contextMenuHandler) {
      chatContainer.removeEventListener('contextmenu', chatContainer._contextMenuHandler);
      chatContainer._contextMenuHandler = null;
    }

    // 移除 document 级别的旧监听器（防止重复）
    if (document._clickMenuCloser) {
      document.removeEventListener('click', document._clickMenuCloser);
      document._clickMenuCloser = null;
    }
    if (document._scrollMenuCloser) {
      document.removeEventListener('scroll', document._scrollMenuCloser, true);
      document._scrollMenuCloser = null;
    }
    if (document._escMenuCloser) {
      document.removeEventListener('keydown', document._escMenuCloser);
      document._escMenuCloser = null;
    }

    var menu = document.createElement('div');
    menu.id = 'msgContextMenu';
    menu.style.cssText = 'position:fixed;z-index:400;display:none;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);padding:4px 0;min-width:160px;overflow:hidden;';
    document.body.appendChild(menu);

    // 点击其他地方关闭菜单（存储处理器以便移除）
    document._clickMenuCloser = function(e) {
      if (!menu.contains(e.target)) menu.style.display = 'none';
    };
    document.addEventListener('click', document._clickMenuCloser);

    document._scrollMenuCloser = function() { menu.style.display = 'none'; };
    document.addEventListener('scroll', document._scrollMenuCloser, true);

    document._escMenuCloser = function(e) { if (e.key === 'Escape') menu.style.display = 'none'; };
    // 通过统一 keyboard 分发器注册（priority 2，仅次于截图）
    if (Core.keyboard) Core.keyboard.register('context-menu-escape', 2, document._escMenuCloser);

    // 在聊天区域上监听右键（始终阻止默认菜单）
    chatContainer._contextMenuHandler = function(e) {
      e.preventDefault();  // 🔧 总是阻止默认右键菜单
      e.stopPropagation(); // 🔧 阻止事件冒泡
      
      // 🔧 优先检查是否点击了图片
      var img = e.target.closest('img');
      if (img && img.closest('.msg')) {
        showImageContextMenu(e.clientX, e.clientY, img);
        return;
      }
      
      var msgDiv = e.target.closest('.msg');
      if (!msgDiv) return;
      showContextMenu(e.clientX, e.clientY, msgDiv);
    };
    chatContainer.addEventListener('contextmenu', chatContainer._contextMenuHandler);

  }

  function showContextMenu(x, y, msgDiv) {
    var menu = document.getElementById('msgContextMenu');
    if (!menu) {
      console.warn('⚠️ msgContextMenu 不存在，重新初始化...');
      initContextMenu();
      menu = document.getElementById('msgContextMenu');
      if (!menu) return;
    }
    // 使用 textContent 彻底清空，避免 innerHTML 残留
    menu.textContent = '';
    
    var isUser = msgDiv.classList.contains('user');
    var isAI = msgDiv.classList.contains('ai');
    
    function addItem(icon, text, onClick, danger) {
      var item = document.createElement('div');
      item.style.cssText = 'padding:8px 14px;cursor:pointer;font-size:13px;color:' + (danger ? '#ef4444' : '#e8e8e8') + ';transition:background 0.15s;display:flex;align-items:center;gap:8px;white-space:nowrap;';
      item.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;width:20px;text-align:center;">' + icon + '</span><span>' + text + '</span>';
      item.addEventListener('mouseenter', function() { item.style.background = '#2a2a2a'; });
      item.addEventListener('mouseleave', function() { item.style.background = 'transparent'; });
      item.addEventListener('click', function() {
        menu.style.display = 'none';
        onClick();
      });
      menu.appendChild(item);
    }
    
    // 🔧 如果有选中的文本，显示"复制选中内容"选项
    var selection = window.getSelection();
    if (selection && selection.toString().trim() && msgDiv.contains(selection.anchorNode)) {
      addItem('content_copy', '复制选中内容', function() {
        navigator.clipboard.writeText(selection.toString().trim()).then(function() {
          Core.dom.status.textContent = '✅ 已复制选中内容';
          setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
        });
      });
    }

    addItem('content_copy', '复制全部内容', function() {
      // 清除选中状态，强制复制全部
      window.getSelection().removeAllRanges();
      copyMessage(msgDiv);
    });
    
    addItem('push_pin', '引用此消息', function() {
      setQuote(msgDiv);
    });
    
    // 🔧 消息撤回：仅用户消息，5分钟内可撤回
    var msgTimestamp = msgDiv.querySelector('.msg-timestamp');
    var msgIndex = parseInt(msgDiv.dataset.msgIndex || '-1');
    var canWithdraw = false;
    if (isUser && msgIndex >= 0) {
      var sessionId = Core.session.getCurrentId();
      var sessions = Core.session.sessions;
      if (sessionId && sessions[sessionId] && sessions[sessionId].messages && sessions[sessionId].messages[msgIndex]) {
        var msg = sessions[sessionId].messages[msgIndex];
        if (msg.timestamp) {
          var diffMinutes = (Date.now() - msg.timestamp) / 60000;
          canWithdraw = diffMinutes <= 5;
        }
      }
    }
    if (canWithdraw) {
      addItem('undo', '撤回消息', function() {
        withdrawMessage(msgDiv);
      });
    }
    
    // 🔧 消息转发
    addItem('forward', '转发', function() {
      forwardMessage(msgDiv);
    });
    
    if (isUser) {
      addItem('edit', '编辑并重新发送', function() {
        enterEditMode(msgDiv);
      });
    } else if (isAI) {
      addItem('refresh', '重新生成', function() {
        regenerateMessage(msgDiv);
      });
    }
    
    addItem('delete', '删除此消息', function() {
      if (confirm('删除此消息？')) deleteSingleMessage(msgDiv);
    }, true);
    
    addItem('check_box', '进入多选模式', function() {
      enterMultiSelectMode();
    });
    
    // 定位菜单，确保不超出视口
    menu.style.display = 'block';
    var rect = menu.getBoundingClientRect();
    var winW = window.innerWidth;
    var winH = window.innerHeight;
    if (x + rect.width > winW) x = winW - rect.width - 8;
    if (y + rect.height > winH) y = winH - rect.height - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function withdrawMessage(msgDiv) {
    var container = document.getElementById('chatContainer');
    if (!container || !msgDiv) return;
    var allMsgs = container.querySelectorAll('.msg');
    var msgIndex = Array.prototype.indexOf.call(allMsgs, msgDiv);
    if (msgIndex < 0) return;
    
    var sessionId = Core.session.getCurrentId();
    var sessions = Core.session.sessions;
    if (sessionId && sessions[sessionId] && sessions[sessionId].messages) {
      var msgs = sessions[sessionId].messages;
      if (msgIndex < msgs.length) {
        // 如果是最后一条用户消息，且下一条是AI回复，也一并删除
        var deleteCount = 1;
        if (msgIndex + 1 < msgs.length && msgs[msgIndex + 1].role === 'assistant') {
          if (confirm('该消息已有AI回复，撤回将同时删除回复。确认撤回？')) {
            deleteCount = 2;
          } else {
            return;
          }
        }
        msgs.splice(msgIndex, deleteCount);
        Core.session.saveSession(sessionId);
        console.log('✅ 消息已撤回');
      }
    }
    msgDiv.parentNode.removeChild(msgDiv);
    // 如果同时删除了AI回复，也要移除DOM
    if (msgIndex + 1 < allMsgs.length) {
      var nextMsg = allMsgs[msgIndex + 1];
      if (nextMsg && nextMsg.classList.contains('ai')) {
        nextMsg.parentNode.removeChild(nextMsg);
      }
    }
    Core.dom.status.textContent = '✅ 消息已撤回';
    setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
  }

  function forwardMessage(msgDiv) {
    // 获取消息内容
    var clone = msgDiv.cloneNode(true);
    var toRemove = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .quick-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .typing-cursor, .msg-checkbox, .material-icons-outlined, .material-icons, .code-btn-group');
    toRemove.forEach(function(t) { t.remove(); });
    var text = clone.textContent.trim();
    
    // 创建转发面板
    var overlay = document.createElement('div');
    overlay.id = 'forwardOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:5000;display:flex;justify-content:center;align-items:center;';
    
    var panel = document.createElement('div');
    panel.style.cssText = 'background:#1e1e1e;border:1px solid #2a2a2a;border-radius:16px;width:360px;max-height:500px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    
    var header = document.createElement('div');
    header.style.cssText = 'padding:14px 16px;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = '<span style="font-size:15px;font-weight:600;color:#e8e8e8;display:flex;align-items:center;gap:6px;"><span class="material-icons-outlined" style="font-size:18px;">forward</span>转发到</span><button id="forwardClose" style="background:none;border:none;color:#6b7280;cursor:pointer;padding:0 4px;line-height:1;display:flex;align-items:center;"><span class="material-icons-outlined" style="font-size:18px;">close</span></button>';
    
    var listDiv = document.createElement('div');
    listDiv.style.cssText = 'overflow-y:auto;max-height:380px;padding:8px 0;';
    
    var sessions = Core.session.sessions || {};
    var currentId = Core.session.getCurrentId();
    var hasSession = false;
    
    Object.keys(sessions).forEach(function(sid) {
      if (sid === currentId) return;
      var sess = sessions[sid];
      if (!sess) return;
      hasSession = true;
      
      var item = document.createElement('div');
      item.style.cssText = 'padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background 0.15s;';
      item.addEventListener('mouseenter', function() { item.style.background = '#2a2a2a'; });
      item.addEventListener('mouseleave', function() { item.style.background = 'transparent'; });
      
      var icon = document.createElement('span');
      icon.className = 'material-icons-outlined';
      icon.textContent = sess.roleType === 'master' ? 'work' : (sess.roleType === 'chat' ? 'chat' : 'smart_toy');
      icon.style.cssText = 'font-size:18px;color:#9ca3af;';
      
      var title = document.createElement('span');
      title.textContent = sess.title || '未命名';
      title.style.cssText = 'flex:1;color:#e8e8e8;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      
      item.appendChild(icon);
      item.appendChild(title);
      
      item.addEventListener('click', function() {
        // 先切换到目标会话，再添加消息（顺序不能反，否则消息会加到当前会话）
        if (Core.session.switchSession) {
          Core.session.switchSession(sid);
        }
        if (Core.session.addMessage) {
          Core.session.addMessage(text, 'user');
        }
        overlay.remove();
        Core.dom.status.textContent = '✅ 已转发到「' + (sess.title || '未命名') + '」';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
      });
      
      listDiv.appendChild(item);
    });
    
    if (!hasSession) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:24px;text-align:center;color:#6b7280;font-size:13px;';
      empty.textContent = '暂无可转发的其他会话';
      listDiv.appendChild(empty);
    }
    
    panel.appendChild(header);
    panel.appendChild(listDiv);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    
    document.getElementById('forwardClose').addEventListener('click', function() {
      overlay.remove();
    });
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.remove();
    });
  }

  // ===== 图片右键菜单 =====
  function showImageContextMenu(x, y, img) {
    var menu = document.getElementById('msgContextMenu');
    if (!menu) {
      console.warn('⚠️ msgContextMenu 不存在，重新初始化...');
      initContextMenu();
      menu = document.getElementById('msgContextMenu');
      if (!menu) return;
    }
    menu.textContent = '';

    var imgSrc = img.src || '';

    function addItem(icon, text, onClick, danger) {
      var item = document.createElement('div');
      item.style.cssText = 'padding:8px 14px;cursor:pointer;font-size:13px;color:' + (danger ? '#ef4444' : '#e8e8e8') + ';transition:background 0.15s;display:flex;align-items:center;gap:8px;white-space:nowrap;';
      item.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;width:20px;text-align:center;">' + icon + '</span><span>' + text + '</span>';
      item.addEventListener('mouseenter', function() { item.style.background = '#2a2a2a'; });
      item.addEventListener('mouseleave', function() { item.style.background = 'transparent'; });
      item.addEventListener('click', function() {
        menu.style.display = 'none';
        onClick();
      });
      menu.appendChild(item);
    }

    addItem('image', '查看大图', function() {
      if (Core.initImagePreview) {
        // 模拟点击打开图片预览
        var overlay = document.getElementById('imagePreviewOverlay');
        var previewImg = document.getElementById('imagePreviewImg');
        if (overlay && previewImg) {
          previewImg.src = imgSrc;
          overlay.classList.add('active');
        }
      }
    });

    addItem('link', '复制图片链接', function() {
      if (!imgSrc) return;
      navigator.clipboard.writeText(imgSrc).then(function() {
        if (Core.dom.status) {
          Core.dom.status.textContent = '\u2705 \u56fe\u7247\u94fe\u63a5\u5df2\u590d\u5236';
          setTimeout(function() {
            if (Core.dom.status) Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + Core.getCurrentService() + ')';
          }, 2000);
        }
      });
    });

    addItem('download', '保存图片', function() {
      if (!imgSrc) return;
      var a = document.createElement('a');
      a.href = imgSrc;
      a.download = 'image-' + Date.now() + '.png';
      a.click();
    });

    // 定位菜单，确保不超出视口
    menu.style.display = 'block';
    var rect = menu.getBoundingClientRect();
    var winW = window.innerWidth;
    var winH = window.innerHeight;
    if (x + rect.width > winW) x = winW - rect.width - 8;
    if (y + rect.height > winH) y = winH - rect.height - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  // 🔧 已提取到 modules/ui-interactions.js（拖拽 + 粘贴 + 快捷键 + 主题）
  // ===== 功能1（导出）：绑定导出按钮，添加下拉菜单 =====
  if (Core.dom.exportBtn) {
    // 清除旧监听器，防止重复绑定
    var oldExportBtn = Core.dom.exportBtn;
    var exportBtn = oldExportBtn.cloneNode(true);
    oldExportBtn.parentNode.replaceChild(exportBtn, oldExportBtn);
    Core.dom.exportBtn = exportBtn;
    
    exportBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      
      // 关闭已存在的菜单
      var existingMenu = document.getElementById('exportDropdownMenu');
      if (existingMenu) { existingMenu.remove(); return; }
      
      // 创建下拉菜单
      var menu = document.createElement('div');
      menu.id = 'exportDropdownMenu';
      menu.style.cssText = 'position:absolute;bottom:52px;right:0;background:#1e1e1e;border:1px solid #2a2a2a;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:300;overflow:hidden;min-width:200px;padding:4px 0;';
      
      var items = [
        { icon: 'description', text: '导出 JSON 文件', action: function() { if (Core.export && Core.export.exportCurrentSession) Core.export.exportCurrentSession('json'); } },
        { icon: 'edit_note', text: '导出 Markdown 文件', action: function() { if (Core.export && Core.export.exportCurrentSession) Core.export.exportCurrentSession('markdown'); } },
        { icon: 'content_cut', text: '复制 Markdown 到剪贴板', action: function() { if (Core.export && Core.export.copySessionToClipboard) Core.export.copySessionToClipboard('markdown'); } },
        { icon: 'content_copy', text: '复制纯文本到剪贴板', action: function() { if (Core.export && Core.export.copySessionToClipboard) Core.export.copySessionToClipboard('plaintext'); } }
      ];
      
      items.forEach(function(item) {
        var div = document.createElement('div');
        div.style.cssText = 'padding:10px 16px;cursor:pointer;color:#e8e8e8;font-size:13px;transition:background 0.2s;white-space:nowrap;display:flex;align-items:center;gap:8px;';
        div.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;color:#9ca3af;">' + item.icon + '</span><span>' + item.text + '</span>';
        div.addEventListener('mouseenter', function() { div.style.background = '#2a2a2a'; });
        div.addEventListener('mouseleave', function() { div.style.background = 'transparent'; });
        div.addEventListener('click', function(e) {
          e.stopPropagation();
          menu.remove();
          item.action();
        });
        menu.appendChild(div);
      });
      
      exportBtn.parentNode.appendChild(menu);
      
      // 点击外部关闭菜单
      setTimeout(function() {
        document.addEventListener('click', function closeMenu(e) {
          if (menu && !menu.contains(e.target) && e.target !== exportBtn) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
          }
        });
      }, 100);
    });
  }

  // 🔧 绑定导入按钮和拖拽导入
  (function initImport() {
    var importBtn = document.getElementById('importBtn');
    var importFileInput = document.getElementById('importFileInput');
    if (!importBtn || !importFileInput) return;

    // 点击导入按钮触发文件选择
    importBtn.addEventListener('click', function() {
      importFileInput.click();
    });

    // 处理文件选择
    importFileInput.addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (!file) return;
      if (!file.name.endsWith('.json')) {
        showToast('❌ 请选择一个 .json 文件', 'error');
        return;
      }
      var reader = new FileReader();
      reader.onload = function(ev) {
        try {
          var data = JSON.parse(ev.target.result);
          if (!data.session || !data.session.messages) {
            showToast('❌ 无效的文件格式', 'error');
            return;
          }
          // 创建临时文件供 importSession 读取
          var tmpPath = path.join((Core._globalDataRoot || Core.DATA_ROOT || 'E:\\my-ai-data'), 'imports', '_temp_import_' + Date.now() + '.json');
          if (!fs.existsSync(path.dirname(tmpPath))) fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
          fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
          if (Core.export && Core.export.importSession) {
            Core.export.importSession(tmpPath);
          }
          // 清理临时文件
          try { fs.unlinkSync(tmpPath); } catch(e) { console.warn('⚠️ [core] 清理临时导入文件失败:', e.message); }
        } catch(err) {
          showToast('❌ 文件解析失败: ' + err.message, 'error');
        }
      };
      reader.readAsText(file);
      // 重置 input 以便重复选择同一文件
      e.target.value = '';
    });

    // 拖拽导入到侧边栏
  // 🔧 备份按钮事件绑定
  // 🔧 备份/恢复按钮已由 settings.js 模块处理（Core.backup.backupData / restoreData）
  // 不再在此处绑定重复的下拉菜单，避免与设置面板冲突


    var sidebar = document.getElementById('sidebar');
    if (sidebar) {
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(eventName) {
        sidebar.addEventListener(eventName, function(e) {
          e.preventDefault();
          e.stopPropagation();
        }, false);
      });

      sidebar.addEventListener('dragenter', function() {
        sidebar.style.border = '2px dashed var(--primary)';
        sidebar.style.background = 'rgba(59,130,246,0.05)';
      });
      sidebar.addEventListener('dragleave', function() {
        sidebar.style.border = '';
        sidebar.style.background = '';
      });
      sidebar.addEventListener('drop', function(e) {
        sidebar.style.border = '';
        sidebar.style.background = '';
        var files = e.dataTransfer.files;
        if (files.length === 0) return;
        var file = files[0];
        if (!file.name.endsWith('.json')) {
          showToast('❌ 请拖拽 .json 文件', 'error');
          return;
        }
        var reader = new FileReader();
        reader.onload = function(ev) {
          try {
            var data = JSON.parse(ev.target.result);
            if (!data.session || !data.session.messages) {
              showToast('❌ 无效的文件格式', 'error');
              return;
            }
            var tmpPath = path.join((Core._globalDataRoot || Core.DATA_ROOT || 'E:\\my-ai-data'), 'imports', '_temp_import_' + Date.now() + '.json');
            if (!fs.existsSync(path.dirname(tmpPath))) fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
            fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
            if (Core.export && Core.export.importSession) {
              Core.export.importSession(tmpPath);
            }
            try { fs.unlinkSync(tmpPath); } catch(e) { console.warn('⚠️ [core] 清理临时导入文件失败:', e.message); }
          } catch(err) {
            showToast('❌ 文件解析失败: ' + err.message, 'error');
          }
        };
        reader.readAsText(file);
      });
    }

  })();

  // ===== 初始化方向A/B/C =====
  // 🔧 initImagePreview/initFontSize/initTextToSpeech/loadMermaidCDN 已由 ui-media.js 模块自动初始化

  // 🔧 TTS + Mermaid 处理（通过统一 chatObserver 分发，不再独立创建 MutationObserver）
  if (Core.chatObserver) {
    Core.chatObserver.onMessage(function(node) {
      // TTS 按钮（仅 AI 消息）
      if (node.classList.contains('ai') && Core.addTTSButton) Core.addTTSButton(node);
      // Mermaid 渲染（延迟 100ms 等待 innerHTML 稳定）
      var _mermaidFn = Core._getRenderMermaidFn ? Core._getRenderMermaidFn() : null;
      if (_mermaidFn) {
        setTimeout(function() { _mermaidFn(node); }, 100);
      }
    });
    console.log('✅ TTS + Mermaid 已注册到统一 chatObserver');
  } else {
    // 回退：chatObserver 尚未就绪，延迟注册
    setTimeout(function() {
      if (Core.chatObserver) {
        Core.chatObserver.onMessage(function(node) {
          if (node.classList.contains('ai') && Core.addTTSButton) Core.addTTSButton(node);
          var _mermaidFn = Core._getRenderMermaidFn ? Core._getRenderMermaidFn() : null;
          if (_mermaidFn) setTimeout(function() { _mermaidFn(node); }, 100);
        });
      }
    }, 2000);
  }

  // ===== 初始化选项1：消息编辑与重新生成 =====
  initMessageActions();

  // ===== P2: 提示词与角色系统（已移至 index.html 外部脚本）=====
  console.log('✅ 提示词与角色系统将在外部脚本中初始化');

  // 🔧 初始化滚动到底部按钮（居中透明样式，rAF节流）
  (function initScrollToBottom() {
    var chatContainer = document.getElementById('chatContainer');
    var scrollBtn = document.getElementById('scrollToBottomBtn');
    if (!chatContainer || !scrollBtn) return;

    var _scrollRafId = 0;
    var _scrollBtnVisible = false;
    chatContainer.addEventListener('scroll', function() {
      if (_scrollRafId) return;
      _scrollRafId = requestAnimationFrame(function() {
        _scrollRafId = 0;
        var distFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
        // 滞后阈值：隐藏 < 80px，显示 > 120px，防止边界处反复切换闪烁
        if (distFromBottom < 80 && _scrollBtnVisible) {
          _scrollBtnVisible = false;
          scrollBtn.style.opacity = '0';
          scrollBtn.style.pointerEvents = 'none';
          scrollBtn.style.transform = 'translateX(-50%) translateY(10px)';
        } else if (distFromBottom > 120 && !_scrollBtnVisible) {
          _scrollBtnVisible = true;
          scrollBtn.style.pointerEvents = 'auto';
          scrollBtn.style.opacity = '1';
          scrollBtn.style.transform = 'translateX(-50%) translateY(0)';
        }
      });
    });

    scrollBtn.addEventListener('click', function() {
      chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
    });

  })();

  // 🔧 配置 marked：启用 GFM 和语法高亮，确保代码块正确渲染
  (function initMarked() {
    if (window.marked) {
      try {
        // 尝试使用 marked.use (v5+)
        marked.use({
          gfm: true,
          breaks: false,
          highlight: function(code, lang) {
            if (window.hljs) {
              try {
                if (lang && hljs.getLanguage(lang)) {
                  return hljs.highlight(code, { language: lang }).value;
                }
                return hljs.highlightAuto(code).value;
              } catch (e) {
                return code;
              }
            }
            return code;
          }
        });
        console.log('✅ marked 已配置：GFM 启用，语法高亮集成');
      } catch (e) {
        // 回退到 setOptions (v3/v4)
        try {
          marked.setOptions({
            gfm: true,
            breaks: false,
            highlight: function(code, lang) {
              if (window.hljs) {
                try {
                  if (lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                  }
                  return hljs.highlightAuto(code).value;
                } catch (e2) {
                  return code;
                }
              }
              return code;
            }
          });
          console.log('✅ marked 已配置(v4): GFM 启用，语法高亮集成');
        } catch (e2) {
          console.warn('⚠️ marked 配置失败:', e2.message);
        }
      }
    } else {
      console.warn('⚠️ marked 库未加载，Markdown 渲染可能不可用');
    }
  })();

  console.log('✅ Core 初始化完成');
})();