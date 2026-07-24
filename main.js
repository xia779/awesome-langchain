// main.js - Electron主进程（安全修复兼容版）

const path = require('path');

// 🔧 强制添加项目 node_modules 到模块搜索路径（确保无论从哪个目录启动都能找到依赖）
const projectNodeModules = path.join(__dirname, 'node_modules');
if (!module.paths.includes(projectNodeModules)) {
  module.paths.unshift(projectNodeModules);
}

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog, shell, session, globalShortcut, desktopCapturer, screen } = require('electron');

// 🔧 禁用 HTTP 缓存，确保 renderer 进程代码始终最新（无需手动清除缓存）
app.commandLine.appendSwitch('disable-http-cache');
// 🔒 安全说明（#11 contextIsolation 迁移完成）
// 渲染进程已启用 contextIsolation:true + nodeIntegration:false。
// 所有 Node.js API 通过 preload.js 的 contextBridge 桥接层安全暴露。
// 模块代码在渲染进程中通过 eval 执行，require() 被替换为桥接垫片函数。
// 原生模块（better-sqlite3, ws）保留在 preload 层，通过函数包装暴露。
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
console.log('🔒 [安全] contextIsolation=true, nodeIntegration=false（preload 桥接层提供 Node API）');

// 🔧 S6: 日志持久化 — 初始化 electron-log 主进程（注册 IPC handler）
const log = require('electron-log/main');
log.initialize();

// 🔧 Phase 5: 插件 Worker 线程隔离 — 主进程 Worker 池管理器
const pluginHost = require('./modules/lib/plugin-host');
log.transports.file.maxSize = 5 * 1024 * 1024;
log.info('[main] 应用启动');

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const { setupMobileRoutes } = require('./web-server');
const { registerApiRoutes } = require('./api-routes');

// 🔒 S5: 自动更新（electron-updater）
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false; // 不自动下载，由用户确认
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装已下载的更新
} catch (e) {
  console.warn('[updater] electron-updater 初始化失败（开发模式或无发布配置）:', e.message);
}

// 🔧 GPU 缓存清理已移至 app.whenReady() 内部（见下方），确保 app.getPath 可用
// DATA_ROOT 优先使用 E:\my-ai-data，仅当不存在时才回退到 userData

// ===== 全局变量 =====
let mainWindow = null;
let tray = null;
let server = null;
let actualPort = null; // 实际监听的端口（8080 被占用时自动递增）

// ===== 数据路径（动态获取）=====
const DATA_ROOT = process.env.AI_AGENT_DATA_ROOT || 
                  (fs.existsSync('E:\\my-ai-data') ? 'E:\\my-ai-data' : 
                   path.join(app.getPath('userData'), 'ai-data'));

// 确保数据目录存在
if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

// ===== API 认证 Token（B02 安全修复：防止局域网未授权访问）=====
// 🔒 #15 修复：优先使用 Electron safeStorage 加密存储，回退到明文
const API_TOKEN_FILE = path.join(DATA_ROOT, '.api-token');
let API_TOKEN = '';
try {
  const { safeStorage } = require('electron');
  let storedRaw = '';
  if (fs.existsSync(API_TOKEN_FILE)) {
    storedRaw = fs.readFileSync(API_TOKEN_FILE, 'utf-8').trim();
  }
  // 尝试解密（safeStorage 加密的数据以 'enc:' 前缀标识）
  if (storedRaw.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
    try {
      API_TOKEN = safeStorage.decryptString(Buffer.from(storedRaw.slice(4), 'base64'));
    } catch (e) {
      console.warn('⚠️ Token 解密失败，将重新生成:', e.message);
      API_TOKEN = '';
    }
  } else if (storedRaw && !storedRaw.startsWith('enc:')) {
    API_TOKEN = storedRaw; // 兼容旧版明文 token
  }
  if (!API_TOKEN || API_TOKEN.length < 32) {
    API_TOKEN = crypto.randomBytes(32).toString('hex');
    // 加密存储
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(API_TOKEN);
      fs.writeFileSync(API_TOKEN_FILE, 'enc:' + encrypted.toString('base64'), 'utf-8');
      console.log('🔑 已生成新 API Token（safeStorage 加密存储）');
    } else {
      fs.writeFileSync(API_TOKEN_FILE, API_TOKEN, 'utf-8');
      console.log('🔑 已生成新 API Token（明文存储，safeStorage 不可用）');
    }
  } else if (storedRaw && !storedRaw.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
    // 迁移：旧版明文 → 加密
    const encrypted = safeStorage.encryptString(API_TOKEN);
    fs.writeFileSync(API_TOKEN_FILE, 'enc:' + encrypted.toString('base64'), 'utf-8');
    console.log('🔑 API Token 已迁移为 safeStorage 加密存储');
  }
} catch (e) {
  // 回退：内存 token（每次重启变化）
  API_TOKEN = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️ Token 持久化失败，使用内存 Token:', e.message);
}

// 🔒 网络绑定地址：默认仅监听本地 127.0.0.1，防止局域网未授权访问
// 如需局域网访问（移动端/PWA），设置环境变量 AI_AGENT_BIND_HOST=0.0.0.0
const BIND_HOST = process.env.AI_AGENT_BIND_HOST || '127.0.0.1';
const _ALLOW_NONLOCAL_BIND = BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost';

// 托盘图标路径
const TRAY_ICON_PATH = path.join(__dirname, 'icon.ico');

// ===== Express Web 服务器（作为 npm start 的一部分）=====
async function startWebServer() {
  const app2 = express();
  app2.use(cors());
  app2.use(express.json({ limit: '50mb' }));

  // 🔒 B02: Token 认证中间件 — 保护 /api/* 路由，静态资源保持公开
  app2.use(function(req, res, next) {
    // 放行：非 API 路由（静态文件、/m 页面、/health 等）
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/api/m/')) {
      return next();
    }
    // 验证 Token（header 优先，兼容 query param 供 EventSource/WebSocket 使用）
    // 🔒 #2 修复：使用 timingSafeEqual 防止时序攻击
    var token = req.headers['x-auth-token'] || req.query.token;
    if (token && typeof token === 'string' && token.length === API_TOKEN.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(API_TOKEN, 'utf8'))) {
          return next();
        }
      } catch (e) { /* length mismatch or encoding error — fall through to 401 */ }
    }
    res.status(401).json({ error: 'Unauthorized', message: '缺少或无效的认证 Token' });
  });

  // 🔧 静态资源服务：让 public/ 下的自定义页面（如 nebula-3d.html）可通过 HTTP 访问
  app2.use(express.static(path.join(__dirname, 'public')));

  // 🔧 B15: 交付物静态服务（Web App 预览）
  var webappsDir = path.join(DATA_ROOT, 'deliverables', 'webapps');
  if (!fs.existsSync(webappsDir)) fs.mkdirSync(webappsDir, { recursive: true });
  app2.use('/deliverables/webapps', express.static(webappsDir));

  // 注册所有 API 路由（提取到 api-routes.js）
  registerApiRoutes(app2, { DATA_ROOT, getMainWindow: () => mainWindow, setActualPort: (p) => { actualPort = p; } });

  // 🔧 检测端口是否可用
  function tryListen(startPort, maxAttempts = 5) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      function tryPort(port) {
        attempts++;
        const testServer = createServer(app2);
        testServer.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.warn(`⚠️ 端口 ${port} 被占用，尝试端口 ${port + 1}...`);
            if (attempts < maxAttempts) {
              tryPort(port + 1);
            } else {
              reject(new Error(`无法找到可用端口（已尝试 ${startPort} 到 ${port}）`));
            }
          } else {
            reject(err);
          }
        });
        testServer.once('listening', () => {
          server = testServer;
          if (_ALLOW_NONLOCAL_BIND) {
            console.log(`⚠️ [安全] 服务器绑定到 ${BIND_HOST}，局域网设备可访问`);
            console.log(`📱 移动端访问: http://<本机IP>:${port}/m`);
          }
          resolve(port);
        });
        testServer.listen(port, BIND_HOST);
      }
      tryPort(startPort);
    });
  }

  try {
    const resolvedPort = await tryListen(8080);
    actualPort = resolvedPort;
    console.log(`✅ 本地 Web 服务器已启动: http://${BIND_HOST}:${resolvedPort}`);
    // 通知渲染进程实际端口（PWA/移动端连接依赖）
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('server:port', resolvedPort);
    }
  } catch (err) {
    console.error('❌ 启动服务器失败:', err.message);
    actualPort = 0;
    // 不阻止应用启动，继续创建窗口
  }
}

// ===== 创建主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0d0d0d',
    // 🔧 无边框自定义标题栏：隐藏原生黑色标题栏，窗口控制按钮与应用背景融合
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d0d0d',
      symbolColor: '#9ca3af',
      height: 44
    },
    webPreferences: {
      // 🔒 Phase 3 安全锁定（勿修改，除非完整评估桥接层迁移）
      // contextIsolation:true 是核心安全边界——渲染进程 XSS 无法触及 Node.js
      // sandbox:false 是务实决策：preload 含 14 个原生 require（better-sqlite3 同步 C++ 插件、ws 等），
      //   开启 sandbox 需将整个桥接层迁移为主进程 IPC + 异步重写 DB 层，收益对本地应用极小
      // 本应用仅加载 file:// 本地内容，不加载远程 URL，contextIsolation 已提供充分隔离
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
  });

  // 加载页面（彻底禁用缓存 - v9）
  const indexPath = path.join(__dirname, 'index.html').replace(/\\/g, '/');
  const url = `file:///${indexPath}?nocache=${Date.now()}`;
  
  // 清除 Electron 缓存并加载页面
  mainWindow.webContents.session.clearCache().then(() => {
    console.log('🧹 Electron 缓存已清除');
    mainWindow.loadURL(url, {
      extraHeaders: 'Cache-Control: no-cache, no-store, must-revalidate\nPragma: no-cache\nExpires: 0'
    });
  }).catch(err => {
    console.warn('⚠️ 缓存清除失败:', err.message);
    mainWindow.loadURL(url, {
      extraHeaders: 'Cache-Control: no-cache, no-store, must-revalidate\nPragma: no-cache\nExpires: 0'
    });
  });
  setupTray();

  // 🔧 注册快捷键：Ctrl+Shift+I 打开 DevTools，Ctrl+R 刷新，Ctrl+Shift+R 强制刷新
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.key === 'I' || input.key === 'i') && input.control && input.shift && !input.alt && !input.meta) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    } else if ((input.key === 'R' || input.key === 'r') && input.control && !input.alt && !input.meta) {
      if (input.shift) {
        mainWindow.webContents.reloadIgnoringCache();
      } else {
        mainWindow.webContents.reload();
      }
      event.preventDefault();
    }
  });

  // 🔒 导航拦截：阻止渲染进程跳转到外部 URL，外链一律用系统浏览器打开
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const isSafe = parsed.protocol === 'file:' ||
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (!isSafe) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // 🔒 新窗口拦截：target=_blank 等场景，外链走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    const isSafe = parsed.protocol === 'file:' ||
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (!isSafe) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 🔧 Renderer 进程崩溃自动恢复
  var _crashReloadCount = 0;
  var MAX_CRASH_RELOADS = 3;
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('❌ Renderer 进程崩溃:', details.reason, 'exitCode:', details.exitCode);
    // 写入崩溃标记，下次启动时清理 GPU 缓存
    try {
      const userDataPath = app.getPath('userData');
      fs.writeFileSync(path.join(userDataPath, '.crash-marker'), Date.now().toString(), 'utf8');
    } catch (e) { console.warn('⚠️ [main] 写入崩溃标记失败:', e.message); }

    if (_crashReloadCount < MAX_CRASH_RELOADS) {
      _crashReloadCount++;
      console.log('🔄 正在重新加载 renderer (第 ' + _crashReloadCount + ' 次)...');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 1000);
    } else {
      console.error('❌ Renderer 连续崩溃 ' + MAX_CRASH_RELOADS + ' 次，停止自动恢复');
    }
  });

  // 🔧 移除原生菜单栏（"视图"菜单），界面更简洁；快捷键由 before-input-event 处理
  Menu.setApplicationMenu(null);

  mainWindow.webContents.on('did-finish-load', () => {
    // 页面成功加载：重置崩溃计数器，删除崩溃标记
    _crashReloadCount = 0;
    try {
      const userDataPath = app.getPath('userData');
      const crashMarkerPath = path.join(userDataPath, '.crash-marker');
      if (fs.existsSync(crashMarkerPath)) fs.unlinkSync(crashMarkerPath);
    } catch (e) { console.warn('⚠️ [main] 清除崩溃标记失败:', e.message); }
    // 🔍 诊断：检查 Core.session.renderChatList 是否是树形版本
    setTimeout(() => {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          var result = { coreExists: false, sessionExists: false, renderChatListExists: false, isTree: false, coreVersion: 'unknown' };
          try {
            if (window.Core) {
              result.coreExists = true;
              // 检查 core.js 版本
              var coreLog = document.querySelector('console-log-version');
              if (Core.session) {
                result.sessionExists = true;
                if (Core.session.renderChatList) {
                  result.renderChatListExists = true;
                  result.isTree = Core.session.renderChatList.toString().indexOf('renderTreeNode') >= 0;
                }
              }
            }
          } catch(e) { console.warn('⚠️ [main] 诊断检查异常:', e.message); }
          return result;
        })()
      `).then(r => {
      }).catch(e => {
        console.error('❌ 诊断失败:', e.message);
      });
    }, 2000);
  });
}

function setupTray() {
  // 多路径探测：开发环境 __dirname，打包后 resources/ 或 app.getAppPath()
  const candidates = [
    TRAY_ICON_PATH,
    path.join(app.getAppPath(), 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
  ];

  let icon = null;
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) { icon = img; break; }
      }
    } catch (e) { /* try next */ }
  }

  if (!icon) {
    // 兜底：创建 16x16 空白图标，确保托盘功能不丢失
    console.warn('⚠️ 托盘图标未找到，使用默认空白图标');
    icon = nativeImage.createEmpty();
  }

  if (process.platform === 'darwin' && !icon.isEmpty()) {
    icon = icon.resize({ width: 16, height: 16 });
  }

  try {
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => { if (mainWindow) mainWindow.show(); } },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip('AI Agent');
    tray.on('click', () => {
      if (!mainWindow) { createWindow(); } else { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); }
    });
  } catch (e) {
    console.warn('⚠️ 托盘创建失败:', e.message);
    tray = null;
  }
}

// ===== IPC 处理器 =====
// 🔒 #17 修复：所有 IPC handler 增加参数类型/范围校验，防止渲染进程传入畸形参数

// 白名单：app.getPath 允许的合法路径名
const _VALID_PATH_NAMES = ['home', 'appData', 'userData', 'temp', 'downloads', 'documents', 'desktop', 'pictures', 'music', 'videos', 'logs', 'crashDumps'];
ipcMain.on('app:get-path-sync', (event, arg) => {
  if (typeof arg !== 'string' || _VALID_PATH_NAMES.indexOf(arg) < 0) {
    console.warn('[IPC] app:get-path-sync 拒绝非法路径名:', arg);
    event.returnValue = '';
    return;
  }
  event.returnValue = app.getPath(arg);
});
ipcMain.on('get-user-data-path', (event) => { event.returnValue = DATA_ROOT; });
ipcMain.on('get-server-port', (event) => {
  // 🔧 返回 0 表示服务器尚未启动成功，避免渲染进程把未启动状态误判为 8080
  event.returnValue = actualPort || 0;
});

// 🔧 Wave 2: IPC 搜索——渲染进程直接调用，无需 HTTP 代理
ipcMain.handle('search-execute', async (event, { query, engine, apiKeys }) => {
  try {
    let results = '';
    const scriptsDir = path.join(__dirname, 'scripts');

    if (engine === 'bing') {
      const bingScript = path.join(scriptsDir, 'search_bing.py');
      if (!fs.existsSync(bingScript)) return { success: false, error: 'search_bing.py 不存在' };
      const out = await new Promise((resolve, reject) => {
        const proc = spawn('python', [bingScript, '--query', query, '--max-results', '5'], { timeout: 20000 });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', () => resolve(stdout));
        proc.on('error', e => reject(e));
      });
      try {
        const data = JSON.parse(out.trim());
        if (data.success && data.results && data.results.length > 0) {
          results = data.results.map(r => `${r.title}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
        }
      } catch (pe) { /* parse failed */ }
    } else if (engine === 'duckduckgo') {
      const ddgScript = path.join(scriptsDir, 'search_ddg.py');
      if (!fs.existsSync(ddgScript)) return { success: false, error: 'search_ddg.py 不存在' };
      const out = await new Promise((resolve, reject) => {
        const proc = spawn('python', [ddgScript, '--query', query, '--max-results', '5'], { timeout: 20000 });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', () => resolve(stdout));
        proc.on('error', e => reject(e));
      });
      try {
        const data = JSON.parse(out.trim());
        if (data.success && data.results && data.results.length > 0) {
          results = data.results.map(r => `${r.title}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
        }
      } catch (pe) { /* parse failed */ }
    } else if (engine === 'tavily' && apiKeys && apiKeys.tavilyApiKey) {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKeys.tavilyApiKey, query, max_results: 5, include_answer: true }),
        signal: AbortSignal.timeout(15000)
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.answer) results = `摘要：${data.answer}\n\n`;
        if (data.results && data.results.length > 0) {
          results += data.results.map(r => `${r.title}\n${r.content}\n${r.url || ''}`).join('\n\n');
        }
      }
    } else if (engine === 'bocha' && apiKeys && apiKeys.bochaApiKey) {
      const resp = await fetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeys.bochaApiKey}` },
        body: JSON.stringify({ query, count: 5 }),
        signal: AbortSignal.timeout(15000)
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.data && data.data.webPages && data.data.webPages.value) {
          results = data.data.webPages.value.map(r => `${r.name}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
        }
      }
    }

    if (results && results.trim().length > 10) {
      return { success: true, results };
    }
    return { success: false, error: '未找到有效结果' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.on('get-auth-token', (event) => { event.returnValue = API_TOKEN; });

ipcMain.on('show-notification', (event, arg) => {
  try {
    const title = (arg && typeof arg.title === 'string') ? arg.title.substring(0, 200) : (typeof arg === 'string' ? arg.substring(0, 200) : 'AI智能体');
    const body = (arg && typeof arg.body === 'string') ? arg.body.substring(0, 1000) : '';
    new Notification({ title: title, body: body }).show();
  } catch(e) { console.warn('[IPC] show-notification 失败:', e.message); }
});

ipcMain.on('list-plugin-dirs', (event) => {
  try {
    const dir = path.join(DATA_ROOT, 'plugins');
    if (!fs.existsSync(dir)) {
      event.returnValue = { success: false, error: '目录不存在', dirs: [] };
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    event.returnValue = { success: true, dirs: dirs };
  } catch (err) {
    event.returnValue = { success: false, error: err.message, dirs: [] };
  }
});

ipcMain.on('copy-plugin-dir', (event, { src, dest }) => {
  try {
    // 🔒 #17: 路径必须在 DATA_ROOT/plugins 下，防止路径遍历
    const pluginsRoot = path.join(DATA_ROOT, 'plugins');
    const resolvedSrc = path.resolve(src || '');
    const resolvedDest = path.resolve(dest || '');
    if (!resolvedSrc.startsWith(pluginsRoot) || !resolvedDest.startsWith(pluginsRoot)) {
      event.returnValue = { success: false, error: '路径必须在插件目录内' };
      return;
    }
    if (!fs.existsSync(resolvedSrc)) {
      event.returnValue = { success: false, error: '源目录不存在' };
      return;
    }
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach(e => {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
      });
    }
    copyDir(src, dest);
    event.returnValue = { success: true };
  } catch (err) {
    event.returnValue = { success: false, error: err.message };
  }
});

ipcMain.on('get-app-dir', (event) => {
  event.returnValue = __dirname;
});

ipcMain.on('window-minimize', (event) => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', (event) => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.on('window-close', (event) => { if (mainWindow) mainWindow.hide(); });

// 🔒 Phase 3: 补齐 preload 白名单中引用的 IPC 通道（消除渲染进程调用无响应的隐患）
// 窗口控制别名（preload 白名单使用 app-* 命名）
ipcMain.on('app-minimize', (event) => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('app-maximize', (event) => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.on('app-close', (event) => { if (mainWindow) mainWindow.hide(); });

// DevTools（preload 白名单使用 open-devtools 命名）
ipcMain.on('open-devtools', () => {
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.toggleDevTools();
});

// 删除插件目录（路径必须在 plugins/ 下，移入回收站而非永久删除）
ipcMain.on('delete-plugin-dir', (event, dirPath) => {
  try {
    const pluginsRoot = path.join(DATA_ROOT, 'plugins');
    const resolved = path.resolve(dirPath || '');
    if (!resolved.startsWith(pluginsRoot)) {
      event.returnValue = { success: false, error: '路径必须在插件目录内' };
      return;
    }
    if (!fs.existsSync(resolved)) {
      event.returnValue = { success: false, error: '目录不存在' };
      return;
    }
    // 移入系统回收站（Electron shell.trashItem 异步，此处用同步 fs 重命名到 .trash 后备）
    const trashDir = path.join(DATA_ROOT, '.trash');
    if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
    const trashDest = path.join(trashDir, path.basename(resolved) + '-' + Date.now());
    fs.renameSync(resolved, trashDest);
    event.returnValue = { success: true, trashPath: trashDest };
  } catch (err) {
    event.returnValue = { success: false, error: err.message };
  }
});

// 获取应用版本号
ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

// 目录选择对话框（invoke 异步模式）
ipcMain.handle('select-directory', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: (options && options.title) || '选择目录',
    defaultPath: (options && options.defaultPath) || DATA_ROOT
  });
});

// 文件选择对话框（invoke 异步模式）
ipcMain.handle('select-file', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: (options && options.title) || '选择文件',
    filters: (options && options.filters) || undefined,
    defaultPath: (options && options.defaultPath) || DATA_ROOT
  });
});

// 应用信息（invoke 异步模式）
ipcMain.handle('get-app-info', async () => {
  return {
    version: app.getVersion(),
    name: app.getName(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    dataRoot: DATA_ROOT,
    appDir: __dirname
  };
});

ipcMain.handle('show-save-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, options);
});

// 🔒 #17: 仅允许 http/https 协议，阻止 file://、javascript: 等危险协议
ipcMain.on('open-external', (event, url) => {
  if (typeof url !== 'string') return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
    } else {
      console.warn('[IPC] open-external 拒绝非 HTTP 协议:', parsed.protocol);
    }
  } catch (e) { console.warn('[IPC] open-external URL 解析失败:', url); }
});

// 🔧 截图 IPC 处理器
ipcMain.handle('take-screenshot', async (event, options) => {
  try {
    const type = (options && options.type) || 'full';
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: {
        width: Math.round(width * scaleFactor),
        height: Math.round(height * scaleFactor)
      },
      fetchWindowIcons: false
    });

    if (type === 'full' || type === 'screen') {
      // 全屏截图 — 返回主屏幕
      const screenSource = sources.find(function(s) { return s.id.startsWith('screen:'); });
      if (screenSource && screenSource.thumbnail) {
        return {
          success: true,
          dataUrl: screenSource.thumbnail.toDataURL(),
          name: '屏幕截图'
        };
      }
    } else if (type === 'window') {
      // 窗口列表
      var winSources = sources.filter(function(s) { return s.id.startsWith('window:'); });
      var list = winSources.map(function(s) {
        return {
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
        };
      });
      return { success: true, windows: list };
    } else if (type === 'capture-window' && options && options.sourceId) {
      // 捕获指定窗口
      var src = sources.find(function(s) { return s.id === options.sourceId; });
      if (src && src.thumbnail) {
        return {
          success: true,
          dataUrl: src.thumbnail.toDataURL(),
          name: src.name || '窗口截图'
        };
      }
    }

    return { success: false, error: '未找到可用的截图源' };
  } catch (err) {
    console.error('Screenshot error:', err);
    return { success: false, error: err.message };
  }
});

// 🔧 浏览器自动化截图 IPC 处理器（备用方案）
ipcMain.handle('automation-screenshot', async (event, options) => {
  try {
    var windows = BrowserWindow.getAllWindows();
    var win = null;
    for (var i = 0; i < windows.length; i++) {
      if (!windows[i].isDestroyed() && windows[i].getTitle() === (options.windowTitle || 'AI-Automation-Browser')) {
        win = windows[i];
        break;
      }
    }
    if (!win) return { success: false, error: '未找到浏览器自动化窗口' };
    var nativeImage = await win.webContents.capturePage();
    if (!nativeImage || nativeImage.isEmpty()) {
      return { success: false, error: '截图为空' };
    }
    return { success: true, dataUrl: nativeImage.toDataURL(), base64: nativeImage.toPNG().toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('export-json', (event, data) => {
  const filePath = dialog.showSaveDialogSync(mainWindow, {
    title: '导出聊天记录',
    defaultPath: 'chat_export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (filePath) {
    try { fs.writeFileSync(filePath, data, 'utf8'); event.reply('export-response', { success: true, filePath }); }
    catch (e) { event.reply('export-response', { success: false, error: e.message }); }
  }
});

ipcMain.on('backup-data', (event) => {
  const filePath = dialog.showSaveDialogSync(mainWindow, {
    title: '备份数据',
    defaultPath: 'ai-agent-backup.zip',
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  });
  if (filePath) {
    // 🔒 安全修复：备份前清理 API 密钥，防止泄露
    const tempBackup = path.join(require('os').tmpdir(), 'ai-agent-backup-sanitized-' + Date.now());
    const API_KEY_FIELDS = [
      'deepseekKey', 'qwenKey', 'doubaoKey', 'customKey',
      'bochaApiKey', 'tavilyApiKey', 'siliconFlowKey', 'openaiImageKey'
    ];
    try {
      // 1. 复制数据到临时目录
      fs.cpSync(DATA_ROOT, tempBackup, { recursive: true });
      // 2. 遍历所有 config.json 文件，清理 API 密钥
      function sanitizeConfigFile(filePath) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const config = JSON.parse(content);
          let changed = false;
          for (const field of API_KEY_FIELDS) {
            if (config[field]) {
              config[field] = '';
              changed = true;
            }
          }
          // 也清理 SQLite 键值对中包含 key 的敏感条目
          if (changed) {
            fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
          }
        } catch (e) {
          // 解析失败的文件不处理
        }
      }
      // 递归查找并清理所有 config.json
      function walkAndSanitize(dir) {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              walkAndSanitize(fullPath);
            } else if (item === 'config.json') {
              sanitizeConfigFile(fullPath);
            }
          }
        } catch (e) { console.warn('⚠️ [main] 备份数据清理遍历失败:', e.message); }
      }
      walkAndSanitize(tempBackup);
      // 3. 压缩清理后的数据（🔒 安全修复：使用 spawn 替代 exec）
      const { spawn } = require('child_process');
      const zipChild = spawn('powershell', [
        '-command', 'Compress-Archive',
        '-Path', tempBackup,
        '-DestinationPath', filePath,
        '-Force'
      ]);
      let zipErr = '';
      zipChild.stderr.on('data', (d) => { zipErr += d.toString(); });
      zipChild.on('close', (code) => {
        // 4. 清理临时目录
        try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) { console.warn('⚠️ [main] 清理备份临时目录失败:', e.message); }
        if (code !== 0) { event.reply('backup-response', { success: false, error: zipErr || '压缩失败' }); }
        else { event.reply('backup-response', { success: true, filePath }); }
      });
      zipChild.on('error', (err) => {
        try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) { console.warn('⚠️ [main] 清理备份临时目录失败:', e.message); }
        event.reply('backup-response', { success: false, error: err.message });
      });
    } catch (err) {
      try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) { console.warn('⚠️ [main] 清理备份临时目录失败:', e.message); }
      event.reply('backup-response', { success: false, error: '备份准备失败: ' + err.message });
    }
  }
});

ipcMain.on('restore-data', (event) => {
  dialog.showOpenDialog(mainWindow, {
    title: '恢复数据',
    properties: ['openFile'],
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      const zipFile = result.filePaths[0];
      const tempDir = path.join(require('os').tmpdir(), 'ai-agent-restore-' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });
      // 🔒 安全修复：spawn 替代 exec，防止路径注入
      const unzipChild = spawn('powershell', [
        '-command', 'Expand-Archive',
        '-Path', zipFile,
        '-DestinationPath', tempDir,
        '-Force'
      ]);
      let unzipStderr = '';
      unzipChild.stderr.on('data', (d) => { unzipStderr += d.toString(); });
      unzipChild.on('close', (code) => {
        if (code !== 0) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) { console.warn('⚠️ [main] 清理解压临时目录失败:', e.message); }
          event.reply('restore-response', { success: false, error: unzipStderr || '解压失败 (exit ' + code + ')' });
          return;
        }
        const restoredDataDir = path.join(tempDir, 'ai-data');
        if (fs.existsSync(restoredDataDir)) {
          // 🔒 安全修复：先备份当前数据，防止恢复失败时数据丢失
          const safetyBackup = path.join(require('os').tmpdir(), 'ai-agent-safety-backup-' + Date.now());
          let hasSafetyBackup = false;
          try {
            if (fs.existsSync(DATA_ROOT)) {
              fs.cpSync(DATA_ROOT, safetyBackup, { recursive: true });
              hasSafetyBackup = true;
            }
            // 删除旧数据并复制恢复数据
            fs.rmSync(DATA_ROOT, { recursive: true, force: true });
            fs.cpSync(restoredDataDir, DATA_ROOT, { recursive: true });
            console.log('✅ 数据恢复成功');
          } catch (restoreErr) {
            console.error('❌ 数据恢复失败:', restoreErr.message);
            // 从安全备份中恢复
            if (hasSafetyBackup && fs.existsSync(safetyBackup)) {
              try {
                if (fs.existsSync(DATA_ROOT)) {
                  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
                }
                fs.cpSync(safetyBackup, DATA_ROOT, { recursive: true });
                console.log('✅ 已从安全备份恢复原始数据');
              } catch (rollbackErr) {
                console.error('❌ 回滚也失败了:', rollbackErr.message);
              }
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
            if (hasSafetyBackup) { try { fs.rmSync(safetyBackup, { recursive: true, force: true }); } catch(e) { console.warn('⚠️ [main] 清理安全备份目录失败:', e.message); } }
            event.reply('restore-response', { success: false, error: '恢复失败: ' + restoreErr.message });
            return;
          }
          // 恢复成功后清理安全备份
          if (hasSafetyBackup) { try { fs.rmSync(safetyBackup, { recursive: true, force: true }); } catch(e) { console.warn('⚠️ [main] 清理安全备份目录失败:', e.message); } }
        } else {
          console.warn('⚠️ 备份文件中未找到 ai-data 目录');
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
        event.reply('restore-response', { success: true });
      });
    }
  }).catch(err => { event.reply('restore-response', { success: false, error: err.message }); });
});

// ===== 应用生命周期 =====
// 🔧 单实例锁：防止同时打开多个应用实例（桌面快捷方式 + start.bat 同时打开会产生重复进程）
const _gotSingleLock = app.requestSingleInstanceLock();
if (!_gotSingleLock) {
  console.log('⚠️ 检测到已有实例运行，退出当前实例');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {

  // 🔧 条件性清理 GPU/Code 缓存：仅在上次崩溃或版本变更时清理
  // 每次启动都清理反而会 destabilize GPU 进程，导致黑屏
  try {
    const userDataPath = app.getPath('userData');
    const markerPath = path.join(userDataPath, '.cache-version');
    const APP_VERSION = '1.1.0'; // 递增此版本号以触发缓存清理
    const crashMarkerPath = path.join(userDataPath, '.crash-marker');
    const hasCrashMarker = fs.existsSync(crashMarkerPath);

    let needsClean = hasCrashMarker;
    try {
      const lastVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
      if (lastVersion !== APP_VERSION) needsClean = true;
    } catch (e) { needsClean = true; }

    if (needsClean) {
      const cacheDirs = ['GPUCache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'VideoDecodeStats'];
      let cleaned = 0;
      for (const dir of cacheDirs) {
        const fullPath = path.join(userDataPath, dir);
        if (fs.existsSync(fullPath)) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
          } catch (e) {
            console.warn('⚠️ 缓存目录清理失败:', dir, e.message);
          }
        }
      }
      if (cleaned > 0) console.log('🧹 已清理 ' + cleaned + ' 个 GPU/代码缓存目录 (版本变更或崩溃恢复)');
      // 写入版本标记 + 清除崩溃标记
      try { fs.writeFileSync(markerPath, APP_VERSION, 'utf8'); } catch (e) { console.warn('⚠️ [main] 写入版本标记失败:', e.message); }
      try { if (hasCrashMarker) fs.unlinkSync(crashMarkerPath); } catch (e) { console.warn('⚠️ [main] 删除崩溃标记失败:', e.message); }
    } else {
      console.log('⏭️ GPU 缓存跳过清理 (版本未变且无崩溃记录)');
    }
  } catch (e) {
    console.warn('⚠️ GPU 缓存清理异常:', e.message);
  }

  // 🔧 GPU 缓存目录重定向到可写位置（避免 0x5 权限错误）
  try {
    const gpuCachePath = path.join(DATA_ROOT, '.gpu-cache');
    if (!fs.existsSync(gpuCachePath)) fs.mkdirSync(gpuCachePath, { recursive: true });
    app.setPath('gpuCacheDir', gpuCachePath);
  } catch (e) {
    console.warn('⚠️ GPU 缓存目录设置失败:', e.message);
  }

  // 🔧 GPU/Network 子进程崩溃监听（写崩溃标记，下次启动自动清理）
  app.on('child-process-gone', (event, details) => {
    if (details.type === 'GPU' || details.type === 'Network') {
      console.warn(`⚠️ ${details.type} 进程退出: reason=${details.reason}, exitCode=${details.exitCode}`);
      try {
        const userDataPath = app.getPath('userData');
        fs.writeFileSync(path.join(userDataPath, '.crash-marker'), `${details.type}:${Date.now()}`, 'utf8');
      } catch (e) { console.warn('⚠️ [main] 写入子进程崩溃标记失败:', e.message); }
    }
  });

  // 🔧 启动时清除 HTTP 缓存（保留 localStorage/IndexedDB 等用户数据）
  try {
    await session.defaultSession.clearCache();
    console.log('✅ HTTP 缓存已清除');
  } catch (e) {
    console.warn('⚠️ 缓存清除异常:', e.message);
  }
  
  console.log(`✅ App ready | 📁 数据目录: ${DATA_ROOT}`);

  // 🔒 设置 Content-Security-Policy，消除 Electron 安全警告
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:; " +
          "font-src 'self' data: file:; " +
          "img-src 'self' data: blob: http: https:; " +
          "connect-src 'self' ws: wss: http: https:; " +
          "media-src 'self' blob: http: https:;"
        ]
      }
    });
  });

  app.setAppUserModelId('com.yourcompany.ai-agent');
  createWindow();
  await startWebServer();
  initAutoUpdater(); // 🔒 S5: 窗口就绪后启动自动更新检查
  pluginHost.registerIPC(); // 🔧 Phase 5: 注册插件 Worker 线程 IPC 处理器
  setTimeout(() => { try { new Notification({ title: 'AI智能体', body: '你的AI助手已就绪！' }).show(); } catch(e) { console.warn('⚠️ [main] 显示就绪通知失败:', e.message); } }, 3000);
});

// 🔒 #3 修复：优雅关闭序列 — 按顺序清理所有资源，防止数据丢失
app.on('before-quit', () => {
  app.isQuitting = true;
  console.log('🔄 [shutdown] 开始优雅关闭...');

  // 1. 停止接受新的 HTTP 请求
  if (server) {
    try { server.close(); } catch (e) { console.warn('[shutdown] server.close 失败:', e.message); }
  }

  // 2. 通知渲染进程执行清理（停止 scheduler 定时器、取消 pending API 请求、关闭 WebSocket）
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    try {
      mainWindow.webContents.send('app:shutdown');
      // 给渲染进程 2 秒执行清理
    } catch (e) { console.warn('[shutdown] 通知渲染进程失败:', e.message); }
  }

  // 3. 销毁托盘
  if (tray) {
    try { tray.destroy(); } catch (e) { console.warn('[shutdown] tray.destroy 失败:', e.message); }
  }

  // 3.5 Phase 5: 终止所有插件 Worker 线程
  try { pluginHost.terminateAllWorkers(); } catch (e) { console.warn('[shutdown] terminateAllWorkers 失败:', e.message); }

  // 4. 关闭 SQLite 数据库（通过渲染进程的 Core.db.close()）
  //    渲染进程收到 app:shutdown 后应调用 Core.db.close()
  //    此处设置 2 秒超时后强制退出
  setTimeout(() => {
    console.log('✅ [shutdown] 清理完成，退出');
    app.exit(0);
  }, 2000);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  else if (mainWindow) { mainWindow.show(); }
});

// 🔧 IPC 监听：快捷键打开 DevTools
ipcMain.on('toggle-devtools', () => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.toggleDevTools();
  }
});

// 🔒 S5: 自动更新——事件转发 + IPC 控制
let _updateStatus = 'idle'; // idle | checking | available | downloading | downloaded | error

function initAutoUpdater() {
  if (!autoUpdater) return;
  try {
    autoUpdater.on('checking-for-update', () => {
      _updateStatus = 'checking';
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update', { status: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      _updateStatus = 'available';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update', { status: 'available', version: info.version, releaseDate: info.releaseDate });
      }
      log.info('[updater] 发现新版本:', info.version);
    });
    autoUpdater.on('update-not-available', () => {
      _updateStatus = 'idle';
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update', { status: 'up-to-date' });
    });
    autoUpdater.on('download-progress', (progress) => {
      _updateStatus = 'downloading';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update', { status: 'downloading', percent: Math.round(progress.percent) });
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      _updateStatus = 'downloaded';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update', { status: 'downloaded', version: info.version });
      }
      log.info('[updater] 更新已下载，等待安装:', info.version);
    });
    autoUpdater.on('error', (err) => {
      _updateStatus = 'error';
      console.warn('[updater] 错误:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:update', { status: 'error', message: err.message });
      }
    });
    // 启动后延迟 10 秒检查（避免启动时网络竞争）
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 10000);
    // 每 4 小时定期检查
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
    console.log('✅ [updater] 自动更新已启用');
  } catch (e) {
    console.warn('[updater] 初始化事件监听失败:', e.message);
  }
}

// 渲染进程 → 主进程：手动触发检查
ipcMain.handle('check-for-update', async () => {
  if (!autoUpdater) return { status: 'unavailable', message: 'electron-updater 未初始化' };
  try {
    await autoUpdater.checkForUpdates();
    return { status: _updateStatus };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

// 渲染进程 → 主进程：开始下载更新
ipcMain.on('download-update', () => {
  if (autoUpdater && _updateStatus === 'available') {
    autoUpdater.downloadUpdate().catch(e => console.warn('[updater] 下载失败:', e.message));
  }
});

// 渲染进程 → 主进程：安装更新并重启
ipcMain.on('install-update', () => {
  if (autoUpdater && _updateStatus === 'downloaded') {
    autoUpdater.quitAndInstall(false, true);
  }
});

// 渲染进程 → 主进程：获取当前更新状态
ipcMain.handle('get-update-status', async () => {
  return { status: _updateStatus, version: app.getVersion() };
});

// 🔧 快捷键在 createWindow 中通过 before-input-event 注册

// ===== 开发模式：启用 DevTools =====
if (process.env.NODE_ENV === 'development') {
  app.whenReady().then(() => {
    setTimeout(() => {
      if (mainWindow && mainWindow.webContents) { mainWindow.webContents.openDevTools({ mode: 'right' }); }
    }, 2000);
  });
}
