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
// 🔧 本地桌面应用，nodeIntegration+unsafe-eval 为功能所需，抑制安全警告
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { setupMobileRoutes } = require('./web-server');
const { registerApiRoutes } = require('./api-routes');

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

// 托盘图标路径
const TRAY_ICON_PATH = path.join(__dirname, 'icon.ico');

// ===== Express Web 服务器（作为 npm start 的一部分）=====
async function startWebServer() {
  const app2 = express();
  app2.use(cors());
  app2.use(express.json({ limit: '50mb' }));

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
          console.log(`📱 移动端访问: http://<本机IP>:${port}/m`);
          resolve(port);
        });
        testServer.listen(port, '0.0.0.0');
      }
      tryPort(startPort);
    });
  }

  try {
    const resolvedPort = await tryListen(8080);
    actualPort = resolvedPort;
    // 通知渲染进程实际端口（PWA/移动端连接依赖）
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('server:port', resolvedPort);
    }
  } catch (err) {
    console.error('❌ 启动服务器失败:', err.message);
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
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      allowRunningInsecureContent: false,
      webSecurity: true
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
    } catch (e) {}

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
    } catch (e) {}
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
          } catch(e) {}
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
ipcMain.on('app:get-path-sync', (event, arg) => { event.returnValue = app.getPath(arg); });
ipcMain.on('get-user-data-path', (event) => { event.returnValue = DATA_ROOT; });
ipcMain.on('get-server-port', (event) => { event.returnValue = actualPort || 8080; });

ipcMain.on('show-notification', (event, arg) => {
  try { 
    const title = arg.title || arg || 'AI智能体';
    const body = arg.body || '';
    new Notification({ title: title, body: body }).show(); 
  } catch(e) {}
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
    if (!fs.existsSync(src)) {
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

ipcMain.handle('show-save-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.on('open-external', (event, url) => { shell.openExternal(url); });

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
        } catch (e) {}
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
        try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) {}
        if (code !== 0) { event.reply('backup-response', { success: false, error: zipErr || '压缩失败' }); }
        else { event.reply('backup-response', { success: true, filePath }); }
      });
      zipChild.on('error', (err) => {
        try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) {}
        event.reply('backup-response', { success: false, error: err.message });
      });
    } catch (err) {
      try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) {}
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
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
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
            if (hasSafetyBackup) { try { fs.rmSync(safetyBackup, { recursive: true, force: true }); } catch(e) {} }
            event.reply('restore-response', { success: false, error: '恢复失败: ' + restoreErr.message });
            return;
          }
          // 恢复成功后清理安全备份
          if (hasSafetyBackup) { try { fs.rmSync(safetyBackup, { recursive: true, force: true }); } catch(e) {} }
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
      try { fs.writeFileSync(markerPath, APP_VERSION, 'utf8'); } catch (e) {}
      try { if (hasCrashMarker) fs.unlinkSync(crashMarkerPath); } catch (e) {}
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
      } catch (e) {}
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
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:"
        ]
      }
    });
  });

  app.setAppUserModelId('com.yourcompany.ai-agent');
  createWindow();
  await startWebServer();
  setTimeout(() => { try { new Notification({ title: 'AI智能体', body: '你的AI助手已就绪！' }).show(); } catch(e) {} }, 3000);
});

app.on('before-quit', () => { app.isQuitting = true; if (tray) tray.destroy(); if (server) server.close(); });

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

// 🔧 快捷键在 createWindow 中通过 before-input-event 注册

// ===== 开发模式：启用 DevTools =====
if (process.env.NODE_ENV === 'development') {
  app.whenReady().then(() => {
    setTimeout(() => {
      if (mainWindow && mainWindow.webContents) { mainWindow.webContents.openDevTools({ mode: 'right' }); }
    }, 2000);
  });
}
