/**
 * plugins.js - 插件系统核心模块
 * 支持插件的加载、注册、启用/禁用、卸载、安装、热更新、API钩子
 */

// 🔧 使用 window.__nodeFs / window.__nodePath（core-v10.js 暴露的备选）
let fs;
try {
  fs = require('fs');
} catch (e) {
  if (typeof window !== 'undefined' && window.__nodeFs) {
    fs = window.__nodeFs;
  } else {
    console.error('❌ fs 模块不可用:', e.message);
  }
}

let path;
try {
  path = require('path');
} catch (e) {
  if (typeof window !== 'undefined' && window.__nodePath) {
    path = window.__nodePath;
  } else {
    console.warn('⚠️ path 模块不可用，使用备选方案:', e.message);
    path = {
      join: (...args) => args.join('/').replace(/\/+/g, '/'),
      basename: (p) => {
        const parts = p.split(/[\\/]/);
        return parts[parts.length - 1] || '';
      },
      dirname: (p) => {
        const idx = p.lastIndexOf('/');
        return idx < 0 ? '.' : p.substring(0, idx) || '/';
      },
    };
  }
}

let Core;
let pluginsDir;
let loadedPlugins = {}; // id -> { manifest, instance, enabled }
let hooks = {
  beforeSend: [],      // (message) -> modifiedMessage | null (阻断)
  afterResponse: [],    // (message, response) -> void
  onMessageRender: [],  // (msgDiv, msgData) -> void
  onInit: [],         // () -> void
  onConfigChange: [], // (newConfig) -> void
};

// ===== 插件市场 =====
let marketplaceRegistry = null;
let marketplaceRegistryUrl = null;

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
  ensurePluginsDir();
  copySamplePlugins();
  loadAllPlugins();
  Core.plugins = {
    getPluginsDir,
    loadPlugin,
    unloadPlugin,
    enablePlugin,
    disablePlugin,
    listPlugins,
    getPlugin,
    registerHook,
    unregisterHook,
    callHook,
    installPlugin,
    uninstallPlugin,
    hotUpdatePlugin,
    reloadPlugin,
    // 插件市场
    fetchMarketplace,
    getMarketplaceRegistry,
    installFromMarketplace,
    getInstalledIds,
    // 版本更新
    checkUpdates: checkPluginUpdates,
    updatePlugin: updatePlugin,
  };
  // 加载本地市场注册表
  var localMarketplace = path.join(Core.DATA_ROOT, 'plugins-marketplace.json');
  if (fs.existsSync(localMarketplace)) {
    try { marketplaceRegistry = JSON.parse(fs.readFileSync(localMarketplace, 'utf8')); } catch(e) {}
  }

  // 注册命令
  registerPluginCommands();

  // 启动自动更新检查
  setTimeout(function() { startAutoUpdateCheck(); }, 5000);

  console.log('✅ 插件系统已加载');
}

// 将项目目录中的示例插件复制到用户插件目录
function copySamplePlugins() {
  try {
    let appDir = __dirname;
    appDir = appDir.replace(/[\\/]modules[\\/]?$/, '').replace(/[\\/]$/, '');
    const sampleDir = appDir + '/plugins';
    if (!fs.existsSync(sampleDir)) {
      console.warn('⚠️ 示例插件目录不存在:', sampleDir);
      return;
    }
    
    let entries;
    try {
      entries = fs.readdirSync(sampleDir);
    } catch (e) {
      console.warn('⚠️ 同步读取示例插件目录失败:', e.message);
      fs.readdir(sampleDir, (err, asyncEntries) => {
        if (err) {
          console.warn('⚠️ 异步读取示例插件目录也失败:', err.message);
          return;
        }
        processSampleEntries(asyncEntries, sampleDir);
      });
      return;
    }
    
    processSampleEntries(entries, sampleDir);
  } catch (err) {
    console.warn('⚠️ 复制示例插件失败:', err.message);
  }
}

function processSampleEntries(entries, sampleDir) {
  entries.forEach((entry) => {
    const srcPath = sampleDir + '/' + entry;
    const destPath = pluginsDir + '/' + entry;
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory() && !fs.existsSync(destPath)) {
        copyDirStr(srcPath, destPath);
      }
    } catch (e) {
      console.warn('⚠️ 复制示例插件条目失败:', entry, e.message);
    }
  });
}

function ensurePluginsDir() {
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }
}

function getPluginsDir() {
  return pluginsDir;
}

// ===== 插件加载 =====
function loadAllPlugins() {
  try {
    if (!fs.existsSync(pluginsDir)) {
      console.warn('⚠️ 插件目录不存在:', pluginsDir);
      return;
    }
    
    let entries;
    try {
      entries = fs.readdirSync(pluginsDir);
    } catch (e) {
      console.warn('⚠️ 读取插件目录失败:', e.message);
      return;
    }
    
    if (!entries || entries.length === 0) {
      return;
    }
    
    entries.forEach((entry) => {
      const pluginPath = pluginsDir + '/' + entry;
      try {
        const stat = fs.statSync(pluginPath);
        if (stat.isDirectory()) {
          loadPluginFromDir(entry, pluginPath);
        }
      } catch (e) {
        console.warn('⚠️ 插件状态检查失败:', entry, e.message);
      }
    });
  } catch (err) {
    console.warn('⚠️ 加载插件失败:', err.message);
  }
}

// ===== 🔧 #9: 插件沙箱加载（vm 隔离 + 受限 require）=====
const _BLOCKED_MODULES = [
  'child_process', 'cluster', 'dgram', 'dns', 'net', 'tls',
  'http', 'https', 'http2', 'worker_threads', 'wasi', 'fs',
  'fs/promises', 'node:fs', 'node:child_process', 'node:net',
  'node:http', 'node:https', 'node:worker_threads'
];
const _SAFE_MODULES = ['path', 'url', 'util', 'events', 'buffer', 'crypto', 'stream', 'querystring', 'assert', 'os', 'punycode', 'string_decoder', 'timers'];

function _loadPluginSandboxed(entryPath, pluginDir) {
  const vm = require('vm');
  const code = fs.readFileSync(entryPath, 'utf-8');
  const dirName = path.dirname(entryPath);

  // 受限 require：只允许安全模块 + 插件目录内的相对引用
  function sandboxRequire(mod) {
    // 阻止危险模块
    if (_BLOCKED_MODULES.indexOf(mod) !== -1) {
      throw new Error('🚫 插件沙箱: 禁止访问模块 "' + mod + '"');
    }
    // 相对路径：限制在插件目录内
    if (mod.startsWith('.') || mod.startsWith('/')) {
      var resolved = path.resolve(dirName, mod);
      if (!resolved.startsWith(pluginDir)) {
        throw new Error('🚫 插件沙箱: 禁止访问插件目录外的文件');
      }
      // 补全扩展名
      if (!fs.existsSync(resolved)) {
        if (fs.existsSync(resolved + '.js')) resolved += '.js';
        else if (fs.existsSync(resolved + '.json')) resolved += '.json';
        else if (fs.existsSync(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
      }
      if (resolved.endsWith('.json')) {
        return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      }
      return _loadPluginSandboxed(resolved, pluginDir);
    }
    // 安全白名单模块
    if (_SAFE_MODULES.indexOf(mod) !== -1) {
      return require(mod);
    }
    // 其他 node_modules：允许（插件可能需要 lodash 等纯 JS 库）
    // 但阻止任何包含危险子路径的
    if (mod.indexOf('child_process') !== -1 || mod.indexOf('/fs') !== -1) {
      throw new Error('🚫 插件沙箱: 禁止访问 "' + mod + '"');
    }
    try { return require(mod); } catch (e) {
      throw new Error('插件沙箱: 无法加载模块 "' + mod + '": ' + e.message);
    }
  }

  // CommonJS 包装器
  var moduleObj = { exports: {} };
  var wrapper = '(function(module, exports, require, __dirname, __filename, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Buffer, URL, URLSearchParams) {\n' + code + '\n})';

  var context = vm.createContext({
    console: { log: console.log, warn: console.warn, error: console.error, info: console.info },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    Promise: Promise, Buffer: Buffer, URL: URL, URLSearchParams: URLSearchParams,
    Math: Math, Date: Date, JSON: JSON, RegExp: RegExp,
    Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
    Map: Map, Set: Set, WeakMap: WeakMap, WeakSet: WeakSet, Symbol: Symbol,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    Error: Error, TypeError: TypeError, RangeError: RangeError
  });

  var script = new vm.Script(wrapper, { filename: entryPath, timeout: 10000 });
  var fn = script.runInContext(context);
  fn(moduleObj, moduleObj.exports, sandboxRequire, dirName, entryPath,
    context.console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Buffer, URL, URLSearchParams);

  return moduleObj.exports;
}

function loadPluginFromDir(pluginId, pluginPath) {
  try {
    const manifestPath = path.join(pluginPath, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      console.warn(`⚠️ 插件 ${pluginId} 缺少 plugin.json，跳过`);
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.id || !manifest.name || !manifest.version) {
      console.warn(`⚠️ 插件 ${pluginId} 元数据不完整，跳过`);
      return;
    }

    // 检查是否已禁用（从配置中读取）
    const disabledPlugins = Core.config.disabledPlugins || [];
    const enabled = !disabledPlugins.includes(manifest.id);

    let instance = null;
    if (enabled) {
      // 加载插件实例
      const entryPath = path.join(pluginPath, manifest.entry || 'index.js');
      if (fs.existsSync(entryPath)) {
        try {
          // 🔧 #9: 沙箱加载 — 不再直接 require，改用 vm + 受限 require
          const PluginClass = _loadPluginSandboxed(entryPath, pluginPath);
          if (typeof PluginClass === 'function') {
            instance = new PluginClass(createPluginAPI(manifest.id));
            if (instance.init && typeof instance.init === 'function') {
              instance.init();
            }
          }
        } catch (err) {
          console.error(`❌ 插件 ${manifest.id} 加载失败:`, err.message);
        }
      }
    }

    loadedPlugins[manifest.id] = {
      manifest: manifest,
      instance: instance,
      enabled: enabled,
      path: pluginPath,
    };

  } catch (err) {
    console.error(`❌ 加载插件 ${pluginId} 失败:`, err.message);
  }
}

// ===== 插件API（提供给插件使用）=====
function createPluginAPI(pluginId) {
  return {
    id: pluginId,
    // 注册钩子
    registerHook: (hookName, handler) => registerHook(pluginId, hookName, handler),
    // 注销钩子
    unregisterHook: (hookName, handler) => unregisterHook(pluginId, hookName, handler),
    // 获取配置
    getConfig: () => Core.config || {},
    // 保存插件私有配置
    savePluginConfig: (data) => savePluginConfig(pluginId, data),
    // 读取插件私有配置
    loadPluginConfig: () => loadPluginConfig(pluginId),
    // 发送通知
    notify: (title, body) => {
      try { Core.showNotification && Core.showNotification(title, body); } catch (e) {}
    },
    // 日志
    log: (...args) => console.log(`[插件:${pluginId}]`, ...args),
    warn: (...args) => console.warn(`[插件:${pluginId}]`, ...args),
    error: (...args) => console.error(`[插件:${pluginId}]`, ...args),
  };
}

function savePluginConfig(pluginId, data) {
  try {
    const configPath = path.join(pluginsDir, pluginId, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ 保存插件配置失败:', err.message);
  }
}

function loadPluginConfig(pluginId) {
  try {
    const configPath = path.join(pluginsDir, pluginId, 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    console.error('❌ 读取插件配置失败:', err.message);
  }
  return {};
}

// ===== 插件管理 =====
function listPlugins() {
  return Object.values(loadedPlugins).map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description || '',
    author: p.manifest.author || '',
    enabled: p.enabled,
    entry: p.manifest.entry || 'index.js',
  }));
}

function getPlugin(pluginId) {
  const p = loadedPlugins[pluginId];
  if (!p) return null;
  return {
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description || '',
    author: p.manifest.author || '',
    enabled: p.enabled,
  };
}

function enablePlugin(pluginId) {
  const p = loadedPlugins[pluginId];
  if (!p) return false;
  if (p.enabled) return true;

  // 从禁用列表中移除
  const disabledPlugins = Core.config.disabledPlugins || [];
  const idx = disabledPlugins.indexOf(pluginId);
  if (idx >= 0) {
    disabledPlugins.splice(idx, 1);
    Core.saveConfig({ disabledPlugins: disabledPlugins });
  }

  // 重新加载插件
  p.enabled = true;
  loadPluginFromDir(pluginId, p.path);
  return true;
}

function disablePlugin(pluginId) {
  const p = loadedPlugins[pluginId];
  if (!p) return false;
  if (!p.enabled) return true;

  // 添加到禁用列表
  const disabledPlugins = Core.config.disabledPlugins || [];
  if (!disabledPlugins.includes(pluginId)) {
    disabledPlugins.push(pluginId);
    Core.saveConfig({ disabledPlugins: disabledPlugins });
  }

  // 调用卸载钩子
  if (p.instance && p.instance.destroy && typeof p.instance.destroy === 'function') {
    try { p.instance.destroy(); } catch (e) {}
  }

  // 注销该插件的所有钩子
  Object.keys(hooks).forEach((hookName) => {
    hooks[hookName] = hooks[hookName].filter((h) => h.pluginId !== pluginId);
  });

  p.enabled = false;
  p.instance = null;
  return true;
}

function unloadPlugin(pluginId) {
  disablePlugin(pluginId);
  delete loadedPlugins[pluginId];
  return true;
}

function loadPlugin(pluginId) {
  const p = loadedPlugins[pluginId];
  if (p && p.path) {
    loadPluginFromDir(pluginId, p.path);
    return true;
  }
  return false;
}

// 🔧 新增：热更新插件（不重启应用，重新加载插件代码）
function hotUpdatePlugin(pluginId) {
  console.log(`🔄 热更新插件: ${pluginId}`);
  const p = loadedPlugins[pluginId];
  if (!p) {
    console.warn(`⚠️ 插件 ${pluginId} 未加载，无法热更新`);
    return false;
  }
  
  // 1. 先禁用（清理旧实例和钩子）
  disablePlugin(pluginId);
  
  // 2. 清除 require 缓存
  const entryPath = path.join(p.path, p.manifest.entry || 'index.js');
  try {
    delete require.cache[require.resolve(entryPath)];
  } catch (e) {}
  
  // 3. 重新加载
  enablePlugin(pluginId);
  
  console.log(`✅ 插件 ${pluginId} 热更新完成`);
  return true;
}

// 🔧 新增：重新加载插件（强制重新加载）
function reloadPlugin(pluginId) {
  console.log(`🔄 重新加载插件: ${pluginId}`);
  const p = loadedPlugins[pluginId];
  if (!p) {
    console.warn(`⚠️ 插件 ${pluginId} 未加载，尝试从目录加载`);
    const pluginPath = path.join(pluginsDir, pluginId);
    if (fs.existsSync(pluginPath)) {
      loadPluginFromDir(pluginId, pluginPath);
      return true;
    }
    return false;
  }
  
  return hotUpdatePlugin(pluginId);
}

// ===== 插件安装（从目录或ZIP）=====
function installPlugin(sourcePath) {
  try {
    // 检查源路径
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: '源路径不存在: ' + sourcePath };
    }
    
    const stat = fs.statSync(sourcePath);
    if (stat.isFile() && sourcePath.endsWith('.zip')) {
      // ZIP 安装：解压到临时目录后按目录安装
      const os = require('os');
      const { execSync } = require('child_process');
      const tmpDir = path.join(os.tmpdir(), 'plugin-install-' + Date.now());
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Expand-Archive -Path '${sourcePath}' -DestinationPath '${tmpDir}' -Force"`, { timeout: 30000 });
        } else {
          execSync(`unzip -o '${sourcePath}' -d '${tmpDir}'`, { timeout: 30000 });
        }
        // 检查解压后的结构（可能有一层包装目录）
        let extractedDir = tmpDir;
        const entries = fs.readdirSync(tmpDir);
        if (entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()) {
          extractedDir = path.join(tmpDir, entries[0]);
        }
        // 安全：Zip Slip 路径穿越检测
        const zipSlipCheck = validateExtractedPaths(tmpDir);
        if (!zipSlipCheck.ok) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return { success: false, error: zipSlipCheck.error };
        }
        // 验证 plugin.json 存在
        if (!fs.existsSync(path.join(extractedDir, 'plugin.json'))) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return { success: false, error: 'ZIP 内未找到 plugin.json（请确保插件清单在 ZIP 根目录）' };
        }
        // 递归调用自身（以目录模式安装）
        const result = installPlugin(extractedDir);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return result;
      } catch (zipErr) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        return { success: false, error: 'ZIP 解压失败: ' + zipErr.message };
      }
    }
    
    if (!stat.isDirectory()) {
      return { success: false, error: '不支持的源类型' };
    }
    
    // 读取插件信息
    const manifestPath = path.join(sourcePath, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      return { success: false, error: '源目录缺少 plugin.json' };
    }
    
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.id) {
      return { success: false, error: 'plugin.json 缺少 id 字段' };
    }
    
    const pluginId = manifest.id;
    const destDir = path.join(pluginsDir, pluginId);
    
    // 如果已存在，先卸载
    if (fs.existsSync(destDir)) {
      uninstallPlugin(pluginId);
    }
    
    // 复制插件到用户目录
    fs.mkdirSync(destDir, { recursive: true });
    copyDir(sourcePath, destDir);
    
    // 加载新插件
    loadPluginFromDir(pluginId, destDir);
    
    return { success: true, id: pluginId, manifest: manifest };
  } catch (err) {
    console.error('❌ 安装插件失败:', err.message);
    return { success: false, error: err.message };
  }
}

function uninstallPlugin(pluginId) {
  try {
    unloadPlugin(pluginId);
    const pluginPath = path.join(pluginsDir, pluginId);
    if (fs.existsSync(pluginPath)) {
      fs.rmSync(pluginPath, { recursive: true, force: true });
    }
    // 从禁用列表中移除
    const disabledPlugins = Core.config.disabledPlugins || [];
    const idx = disabledPlugins.indexOf(pluginId);
    if (idx >= 0) {
      disabledPlugins.splice(idx, 1);
      Core.saveConfig({ disabledPlugins: disabledPlugins });
    }
    return { success: true };
  } catch (err) {
    console.error('❌ 卸载插件失败:', err.message);
    return { success: false, error: err.message };
  }
}

// ===== 安全工具函数 =====

/** 比较两个 semver 版本号，返回 1(a>b) / -1(a<b) / 0(相等) */
function compareSemver(a, b) {
  const pa = String(a || '0.0.0').split('.').map(Number);
  const pb = String(b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** 强制 https，拒绝 http/ftp 等明文协议 */
function assertHttps(url, label) {
  if (!url || typeof url !== 'string') return { ok: false, error: (label || 'URL') + ' 为空' };
  if (!url.startsWith('https://')) {
    return { ok: false, error: (label || 'URL') + ' 必须使用 https 协议（拒绝: ' + url.substring(0, 60) + '）' };
  }
  return { ok: true };
}

/** Zip Slip 防护：验证解压后所有文件路径未逃逸出目标目录 */
function validateExtractedPaths(extractDir) {
  const resolvedBase = path.resolve(extractDir);
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.resolve(path.join(dir, entry.name));
      if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
        return { ok: false, error: 'Zip Slip 路径穿越检测: ' + fullPath };
      }
      if (entry.isDirectory()) {
        const sub = walk(fullPath);
        if (!sub.ok) return sub;
      }
    }
    return { ok: true };
  }
  return walk(extractDir);
}

// ===== 插件版本更新检查 =====
async function checkPluginUpdates() {
  const updates = [];
  for (const pluginId of Object.keys(loadedPlugins)) {
    const p = loadedPlugins[pluginId];
    if (!p.manifest || !p.manifest.updateUrl) continue;
    // 安全：强制 https
    const urlCheck = assertHttps(p.manifest.updateUrl, 'updateUrl');
    if (!urlCheck.ok) { console.warn('⚠️ 插件 ' + pluginId + ': ' + urlCheck.error); continue; }
    try {
      const resp = await fetch(p.manifest.updateUrl, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) continue;
      const remote = await resp.json();
      // 安全：semver 比较，仅远端版本更高时才提示更新
      if (remote.version && compareSemver(remote.version, p.manifest.version) > 0) {
        updates.push({
          id: pluginId,
          name: p.manifest.name || pluginId,
          currentVersion: p.manifest.version || '0.0.0',
          remoteVersion: remote.version,
          downloadUrl: remote.downloadUrl || remote.zipUrl || null,
          sha256: remote.sha256 || null,
        });
      }
    } catch (e) { /* skip unreachable update servers */ }
  }
  return updates;
}

async function updatePlugin(pluginId, downloadUrl, expectedSha256) {
  if (!downloadUrl) return { success: false, error: '无下载地址' };
  // 安全：强制 https
  const urlCheck = assertHttps(downloadUrl, 'downloadUrl');
  if (!urlCheck.ok) return { success: false, error: urlCheck.error };
  try {
    const crypto = require('crypto');
    const os = require('os');
    const tmpZip = path.join(os.tmpdir(), 'plugin-update-' + pluginId + '-' + Date.now() + '.zip');
    // 下载 ZIP
    const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
    if (!resp.ok) return { success: false, error: '下载失败: HTTP ' + resp.status };
    const buffer = Buffer.from(await resp.arrayBuffer());
    // 安全：sha256 完整性校验
    if (expectedSha256) {
      const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actualHash.toLowerCase() !== expectedSha256.toLowerCase()) {
        return { success: false, error: 'SHA256 校验失败（期望: ' + expectedSha256.substring(0, 16) + '… 实际: ' + actualHash.substring(0, 16) + '…），已拒绝安装' };
      }
    }
    fs.writeFileSync(tmpZip, buffer);
    // 安装（会先卸载旧版）
    const result = installPlugin(tmpZip);
    try { fs.unlinkSync(tmpZip); } catch (e) {}
    return result;
  } catch (e) {
    return { success: false, error: '更新失败: ' + e.message };
  }
}

// 递归复制目录
function copyDir(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.forEach((entry) => {
    const srcPath = src + '/' + entry.name;
    const destPath = dest + '/' + entry.name;
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

// 字符串拼接版本（备选）
function copyDirStr(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.forEach((entry) => {
    const srcPath = src + '/' + entry.name;
    const destPath = dest + '/' + entry.name;
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirStr(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

// ===== 钩子系统 =====
function registerHook(pluginId, hookName, handler) {
  if (!hooks[hookName]) {
    hooks[hookName] = [];
  }
  hooks[hookName].push({ pluginId, handler });
}

function unregisterHook(pluginId, hookName, handler) {
  if (!hooks[hookName]) return;
  hooks[hookName] = hooks[hookName].filter((h) => {
    if (h.pluginId !== pluginId) return true;
    if (handler && h.handler !== handler) return true;
    return false;
  });
}

// 调用钩子，返回是否被阻断
async function callHook(hookName, ...args) {
  if (!hooks[hookName] || hooks[hookName].length === 0) {
    return args.length > 0 ? args[0] : undefined;
  }

  let result = args.length > 0 ? args[0] : undefined;
  for (const hook of hooks[hookName]) {
    try {
      const ret = await hook.handler(result, ...args.slice(1));
      if (ret === null) {
        return null; // 阻断
      }
      if (ret !== undefined) {
        result = ret;
      }
    } catch (err) {
      console.error(`[插件:${hook.pluginId}] 钩子 ${hookName} 执行失败:`, err.message);
    }
  }
  return result;
}


// ===== 插件市场：获取远程注册表 =====
async function fetchMarketplace(url) {
  marketplaceRegistryUrl = url || marketplaceRegistryUrl || '';
  if (!marketplaceRegistryUrl) {
    // 尝试加载本地注册表
    const localPath = path.join(Core.DATA_ROOT, 'plugins-marketplace.json');
    if (fs.existsSync(localPath)) {
      marketplaceRegistry = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return marketplaceRegistry;
    }
    return { version: '1.0.0', plugins: [] };
  }
  try {
    var resp = await fetch(marketplaceRegistryUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    marketplaceRegistry = await resp.json();
    // 缓存到本地
    var cachePath = path.join(Core.DATA_ROOT, 'plugins-marketplace-cache.json');
    try { fs.writeFileSync(cachePath, JSON.stringify(marketplaceRegistry, null, 2)); } catch(e) {}
    return marketplaceRegistry;
  } catch (err) {
    console.warn('⚠️ 市场: 远程获取失败，尝试本地缓存:', err.message);
    var cachePath = path.join(Core.DATA_ROOT, 'plugins-marketplace-cache.json');
    if (fs.existsSync(cachePath)) {
      marketplaceRegistry = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return marketplaceRegistry;
    }
    var localPath = path.join(Core.DATA_ROOT, 'plugins-marketplace.json');
    if (fs.existsSync(localPath)) {
      marketplaceRegistry = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return marketplaceRegistry;
    }
    return { version: '1.0.0', plugins: [] };
  }
}

function getMarketplaceRegistry() {
  return marketplaceRegistry;
}

// 获取已安装的市场插件 ID 列表
function getInstalledIds() {
  var ids = [];
  if (!marketplaceRegistry) return ids;
  marketplaceRegistry.plugins.forEach(function(mp) {
    // 检查所有 skills 是否都已安装
    var allInstalled = mp.skills.every(function(s) {
      var skillDir = path.join(Core.DATA_ROOT, 'skills', s.id);
      return fs.existsSync(skillDir);
    });
    if (allInstalled) ids.push(mp.id);
  });
  return ids;
}

// 从市场安装插件（下载 skill 文件到 skills 目录）
async function installFromMarketplace(pluginId) {
  if (!marketplaceRegistry) {
    return { success: false, error: '市场注册表未加载' };
  }
  var mp = marketplaceRegistry.plugins.find(function(p) { return p.id === pluginId; });
  if (!mp) {
    return { success: false, error: '未找到插件: ' + pluginId };
  }

  var skillsDir = path.join(Core.DATA_ROOT, 'skills');
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  var installed = [];
  var errors = [];

  for (var i = 0; i < mp.skills.length; i++) {
    var skill = mp.skills[i];
    var skillDir = path.join(skillsDir, skill.id);
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

    try {
      // 下载 skill.json
      if (skill.skillJsonUrl) {
        var jsonResp = await fetch(skill.skillJsonUrl, { signal: AbortSignal.timeout(15000) });
        if (jsonResp.ok) {
          var jsonText = await jsonResp.text();
          fs.writeFileSync(path.join(skillDir, 'skill.json'), jsonText);
        } else {
          // 生成默认的 skill.json
          fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
            id: skill.id, name: skill.name, description: mp.description,
            version: mp.version, author: mp.author, source: 'marketplace'
          }, null, 2));
        }
      } else {
        fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
          id: skill.id, name: skill.name, description: mp.description,
          version: mp.version, author: mp.author, source: 'marketplace'
        }, null, 2));
      }

      // 下载 prompt.md
      if (skill.promptMdUrl) {
        var promptResp = await fetch(skill.promptMdUrl, { signal: AbortSignal.timeout(15000) });
        if (promptResp.ok) {
          var promptText = await promptResp.text();
          fs.writeFileSync(path.join(skillDir, 'prompt.md'), promptText);
        } else {
          errors.push(skill.id + ': prompt.md 下载失败 (HTTP ' + promptResp.status + ')');
          continue;
        }
      }

      installed.push(skill.id);
    } catch (err) {
      errors.push(skill.id + ': ' + err.message);
      console.error('📦 市场安装失败: ' + skill.id, err.message);
    }
  }

  // 刷新技能列表
  if (Core.skills && Core.skills.refreshSkills) {
    Core.skills.refreshSkills();
  }

  if (installed.length > 0) {
    return { success: true, installed: installed, errors: errors };
  } else {
    return { success: false, error: '所有技能安装失败: ' + errors.join(', ') };
  }
}

// ================================================================
//  Phase 5-4: 插件生态增强 — 依赖管理 + 自动更新 + 沙盒权限 + 开发工具
// ================================================================

// ----- 5a: 插件依赖解析与排序 -----
function resolvePluginDependencies(pluginId) {
  var visited = {};
  var order = [];
  var errors = [];

  function visit(id) {
    if (visited[id]) return;
    visited[id] = true;

    var manifest = getPluginManifest(id);
    if (!manifest) {
      errors.push('插件 ' + id + ' 的 manifest 不存在');
      return;
    }

    var deps = manifest.dependencies || [];
    for (var i = 0; i < deps.length; i++) {
      var depId = typeof deps[i] === 'string' ? deps[i] : deps[i].id;
      if (depId && !visited[depId]) {
        visit(depId);
      }
    }
    order.push(id);
  }

  visit(pluginId);
  return { order: order, errors: errors };
}

function getPluginManifest(pluginId) {
  try {
    var pluginPath = path.join(Core.DATA_ROOT, 'plugins', pluginId, 'plugin.json');
    if (fs.existsSync(pluginPath)) {
      return JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
    }
  } catch (e) {}
  return null;
}

// ----- 5b: 自动更新检查 -----
var _updateCheckTimer = null;
var UPDATE_CHECK_INTERVAL = 3600000; // 1小时检查一次

function startAutoUpdateCheck() {
  if (_updateCheckTimer) clearInterval(_updateCheckTimer);
  _updateCheckTimer = setInterval(function() {
    checkForUpdates().then(function(updates) {
      if (updates && updates.length > 0) {
        if (Core.errorHandler && Core.errorHandler.showWarningToast) {
          Core.errorHandler.showWarningToast(updates.length + ' 个插件有可用更新，使用 /plugin update 查看');
        }
      }
    }).catch(function(e) { console.warn('[Plugins] Update check failed:', e.message); });
  }, UPDATE_CHECK_INTERVAL);
}

async function checkForUpdates() {
  try {
    var registry = await fetchMarketplace();
    if (!registry || !registry.plugins) return [];

    var installed = getInstalledPlugins();
    var updates = [];

    for (var i = 0; i < installed.length; i++) {
      var local = installed[i];
      var remote = registry.plugins.find(function(p) { return p.id === local.id; });
      if (remote && compareVersions(remote.version, local.version) > 0) {
        updates.push({
          id: local.id,
          name: remote.name || local.id,
          currentVersion: local.version,
          latestVersion: remote.version,
          changelog: remote.changelog || ''
        });
      }
    }

    return updates;
  } catch (e) {
    console.warn('更新检查失败:', e.message);
    return [];
  }
}

function compareVersions(a, b) {
  if (!a || !b) return 0;
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function getInstalledPlugins() {
  var result = [];
  try {
    var pluginsDir = path.join(Core.DATA_ROOT, 'plugins');
    if (!fs.existsSync(pluginsDir)) return result;
    var dirs = fs.readdirSync(pluginsDir);
    dirs.forEach(function(dir) {
      var manifest = getPluginManifest(dir);
      if (manifest) {
        result.push({ id: dir, name: manifest.name || dir, version: manifest.version || '0.0.0' });
      }
    });
  } catch (e) {}
  return result;
}

// ----- 5c: 插件沙盒权限系统 -----
var PLUGIN_PERMISSIONS = {
  'network': { label: '网络访问', desc: '允许插件发送 HTTP 请求' },
  'filesystem': { label: '文件读写', desc: '允许插件读写本地文件' },
  'system': { label: '系统信息', desc: '允许插件获取系统信息' },
  'storage': { label: '数据存储', desc: '允许插件使用持久化存储' },
  'ui': { label: '界面修改', desc: '允许插件修改 UI 元素' },
};

function getPluginPermissions(pluginId) {
  var manifest = getPluginManifest(pluginId);
  if (!manifest) return [];
  return manifest.permissions || [];
}

function checkPluginPermission(pluginId, permission) {
  var perms = getPluginPermissions(pluginId);
  return perms.indexOf(permission) >= 0;
}

function createPluginSandbox(pluginId) {
  var perms = getPluginPermissions(pluginId);
  var sandbox = {
    Core: {
      config: Core.config,
      session: { getCurrentId: Core.session.getCurrentId },
      emit: Core.emit,
      on: Core.on,
    },
    console: { log: console.log, warn: console.warn, error: console.error },
  };

  if (perms.indexOf('network') >= 0) {
    sandbox.fetch = fetch;
    sandbox.XMLHttpRequest = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined;
  }
  if (perms.indexOf('storage') >= 0) {
    sandbox._pluginStorage = {};
    sandbox.storage = {
      get: function(key) { return sandbox._pluginStorage[key]; },
      set: function(key, val) { sandbox._pluginStorage[key] = val; },
      delete: function(key) { delete sandbox._pluginStorage[key]; },
    };
  }
  if (perms.indexOf('ui') >= 0) {
    sandbox.document = document;
    sandbox.window = window;
  }

  return sandbox;
}

// ----- 5d: 插件开发工具 -----
function createPluginFromTemplate(name, description, author) {
  name = (name || 'my-plugin').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  var pluginDir = path.join(Core.DATA_ROOT, 'plugins', name);

  if (fs.existsSync(pluginDir)) {
    return { error: '插件目录已存在: ' + name };
  }

  try {
    fs.mkdirSync(pluginDir, { recursive: true });

    // plugin.json
    var manifest = {
      id: name,
      name: name,
      version: '1.0.0',
      description: description || '自定义插件',
      author: author || 'User',
      permissions: ['storage'],
      main: 'index.js',
      hooks: ['onLoad', 'onUnload'],
    };
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // index.js
    var indexCode = [
      '// ' + name + ' 插件入口',
      'var Core = null;',
      '',
      'function onLoad(_Core) {',
      '  Core = _Core;',
      '  console.log("✅ ' + name + ' 插件已加载");',
      '',
      '  // 注册命令',
      '  if (Core.custom && Core.custom.registerCommand) {',
      '    Core.custom.registerCommand("/' + name + '", function(args) {',
      '      return "' + name + ' 插件已运行: " + (args || "无参数");',
      '    }, "' + (description || name) + '");',
      '  }',
      '}',
      '',
      'function onUnload() {',
      '  console.log("🔄 ' + name + ' 插件已卸载");',
      '}',
      '',
      'module.exports = { onLoad, onUnload };',
    ].join('\n');
    fs.writeFileSync(path.join(pluginDir, 'index.js'), indexCode, 'utf8');

    // README.md
    var readme = '# ' + name + '\n\n' + (description || '自定义插件') + '\n\n## 使用方法\n\n在聊天中输入 `/' + name + '` 即可调用。\n';
    fs.writeFileSync(path.join(pluginDir, 'README.md'), readme, 'utf8');

    return { success: true, path: pluginDir, name: name };
  } catch (err) {
    return { error: '创建失败: ' + err.message };
  }
}

function validatePlugin(pluginId) {
  var errors = [];
  var warnings = [];
  var manifest = getPluginManifest(pluginId);

  if (!manifest) {
    errors.push('plugin.json 不存在或无法解析');
    return { valid: false, errors: errors, warnings: warnings };
  }

  // 必须字段
  if (!manifest.id) errors.push('缺少 id 字段');
  if (!manifest.name) warnings.push('缺少 name 字段，将使用 id');
  if (!manifest.version) warnings.push('缺少 version 字段');
  if (!manifest.main) errors.push('缺少 main 字段（入口文件）');

  // 入口文件检查
  if (manifest.main) {
    var mainPath = path.join(Core.DATA_ROOT, 'plugins', pluginId, manifest.main);
    if (!fs.existsSync(mainPath)) {
      errors.push('入口文件不存在: ' + manifest.main);
    }
  }

  // 权限检查
  if (manifest.permissions) {
    manifest.permissions.forEach(function(perm) {
      if (!PLUGIN_PERMISSIONS[perm]) {
        warnings.push('未知权限: ' + perm);
      }
    });
  }

  // 依赖检查
  if (manifest.dependencies) {
    manifest.dependencies.forEach(function(dep) {
      var depId = typeof dep === 'string' ? dep : dep.id;
      if (depId && !getPluginManifest(depId)) {
        errors.push('缺少依赖插件: ' + depId);
      }
    });
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

// ----- 5e: 扩展 /plugin 命令 -----
function registerPluginCommands() {
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/plugin', function(args) {
      var parts = (args || '').trim().split(/\s+/);
      var sub = parts[0] || 'help';

      if (sub === 'create') {
        var name = parts[1];
        if (!name) return '❌ 请提供插件名: /plugin create <名称> [描述]';
        var desc = parts.slice(2).join(' ') || '';
        var result = createPluginFromTemplate(name, desc);
        if (result.error) return '❌ ' + result.error;
        return '✅ 插件模板已创建: ' + result.path + '\n使用 /plugin load ' + result.name + ' 加载';
      }

      if (sub === 'validate') {
        var id = parts[1];
        if (!id) return '❌ 请提供插件 ID: /plugin validate <插件ID>';
        var v = validatePlugin(id);
        var lines = ['🔍 插件验证: ' + id];
        if (v.valid) lines.push('✅ 验证通过');
        else lines.push('❌ 验证失败');
        v.errors.forEach(function(e) { lines.push('  ❌ ' + e); });
        v.warnings.forEach(function(w) { lines.push('  ⚠️ ' + w); });
        return lines.join('\n');
      }

      if (sub === 'update') {
        checkForUpdates().then(function(updates) {
          if (updates.length === 0) {
            if (Core.errorHandler) Core.errorHandler.showSuccessToast('所有插件已是最新版本');
          } else {
            var lines = ['📦 可用更新:\n'];
            updates.forEach(function(u) {
              lines.push('  ' + u.name + ': ' + u.currentVersion + ' → ' + u.latestVersion);
            });
            if (Core.session && Core.session.addMessage) {
              Core.session.addMessage(lines.join('\n'), 'ai');
            }
          }
        });
        return '⏳ 正在检查更新...';
      }

      if (sub === 'deps') {
        var id2 = parts[1];
        if (!id2) return '❌ 请提供插件 ID: /plugin deps <插件ID>';
        var resolved = resolvePluginDependencies(id2);
        var lines2 = ['📋 依赖链: ' + id2];
        resolved.order.forEach(function(dep, i) { lines2.push('  ' + (i + 1) + '. ' + dep); });
        if (resolved.errors.length > 0) {
          lines2.push('\n❌ 错误:');
          resolved.errors.forEach(function(e) { lines2.push('  ' + e); });
        }
        return lines2.join('\n');
      }

      if (sub === 'perms') {
        var id3 = parts[1];
        if (!id3) {
          var lines3 = ['🔐 可用权限:\n'];
          Object.keys(PLUGIN_PERMISSIONS).forEach(function(k) {
            lines3.push('  ' + k + ' — ' + PLUGIN_PERMISSIONS[k].label + ': ' + PLUGIN_PERMISSIONS[k].desc);
          });
          return lines3.join('\n');
        }
        var perms = getPluginPermissions(id3);
        return '🔐 ' + id3 + ' 权限: ' + (perms.length > 0 ? perms.join(', ') : '(无)');
      }

      return '📦 插件管理\n\n' +
        '/plugin create <名称> [描述] — 从模板创建插件\n' +
        '/plugin validate <ID> — 验证插件完整性\n' +
        '/plugin update — 检查插件更新\n' +
        '/plugin deps <ID> — 查看依赖链\n' +
        '/plugin perms [ID] — 查看权限';
    }, '插件生态管理 — create/validate/update/deps/perms');
  }
}

module.exports = { name: 'plugins', dependencies: ['custom'], init };
