// tests/e2e/harness.main.js
// Phase 0 验证地基：在【真实 contextIsolation:true 渲染进程】里驱动 window.nodeBridge。
// 这是 npm test（纯 Node）从未覆盖的那条路——所有「过桥才暴露」的 bug 在这里被抓住。
//
// 运行方式：由 tests/e2e/run.js 用 electron 二进制启动本文件作为 app 入口。
// 退出码：0=全部通过，1=存在失败。
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 🔧 与生产 main.js 一致：初始化 electron-log 主进程（注册 __ELECTRON_LOG__ IPC handler），
//    否则 preload 的 log 桥在渲染进程调用时会报 "No handler registered" 噪音。
try {
  const log = require('electron-log/main');
  log.initialize();
} catch (e) { /* 日志初始化失败不影响桥接测试 */ }

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(PROJECT_ROOT, 'preload.js');
const BLANK_HTML = path.join(__dirname, 'blank.html');
const TEST_BUNDLE = path.join(__dirname, 'bridge-tests-renderer.js');

// 无头测试：关硬件加速，避免 GPU 环境差异
app.disableHardwareAcceleration();

let exitCode = 1;

app.whenReady().then(async () => {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        // 🔒 与生产 main.js 完全一致的安全配置——这正是我们要验证的环境
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: PRELOAD
      }
    });

    // 把渲染进程 console 转发到主进程 stdout，便于调试
    // Electron 42：console-message 使用事件对象（event.level / event.message），旧的多参形式已废弃
    win.webContents.on('console-message', (event) => {
      const level = (event && typeof event.level === 'number') ? event.level : 1;
      const message = (event && event.message) || '';
      // level: 0=verbose 1=info 2=warning 3=error
      if (level >= 2) console.log('[renderer] ' + message);
    });

    await win.loadFile(BLANK_HTML);

    // 0) 前置检查：contextBridge 是否真的把 nodeBridge 暴露到了主世界
    const bridgeType = await win.webContents.executeJavaScript('typeof window.nodeBridge');
    if (bridgeType !== 'object') {
      console.error('[harness] FATAL: window.nodeBridge 未暴露（typeof=' + bridgeType + '）');
      console.error('[harness] 这意味着 preload 未在 contextIsolation:true 下正常工作。');
      exitCode = 1;
    } else {
      // 1a) 从 core-v10.js 提取 _createDatabaseShim 源码，暴露到渲染进程供测试直接驱动真实 shim
      try {
        const coreSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core-v10.js'), 'utf8');
        const shimMatch = coreSrc.match(/function _createDatabaseShim\(\) \{[\s\S]*?\n\}/);
        const shimSrc = shimMatch ? shimMatch[0] : null;
        await win.webContents.executeJavaScript('window.__DB_SHIM_SRC__ = ' + JSON.stringify(shimSrc));
      } catch (e) {
        console.log('[harness] 提取 DatabaseShim 源码失败（shim 测试将跳过）: ' + e.message);
        await win.webContents.executeJavaScript('window.__DB_SHIM_SRC__ = null');
      }

      // 1b) 注入并在渲染进程主世界执行测试包（async IIFE，返回 [{name,ok,detail}]）
      const bundleSrc = fs.readFileSync(TEST_BUNDLE, 'utf8');
      const results = await win.webContents.executeJavaScript(bundleSrc, false);

      if (!Array.isArray(results)) {
        console.error('[harness] FATAL: 测试包未返回结果数组，实际: ' + typeof results);
        exitCode = 1;
      } else {
        let pass = 0, fail = 0;
        console.log('\n========== Bridge E2E（真实 contextIsolation 渲染进程）==========');
        for (const r of results) {
          if (r && r.ok) { pass++; console.log('  \u2713 PASS  ' + r.name + (r.detail ? '  [' + r.detail + ']' : '')); }
          else { fail++; console.log('  \u2717 FAIL  ' + (r && r.name) + '  -> ' + (r && r.detail)); }
        }
        console.log('================================================================');
        console.log('Total: ' + results.length + '   Pass: ' + pass + '   Fail: ' + fail + '\n');
        exitCode = (fail === 0 && results.length > 0) ? 0 : 1;
      }
    }
  } catch (e) {
    console.error('[harness] ERROR: ' + ((e && e.stack) || e));
    exitCode = 1;
  } finally {
    try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
    // 给一点时间让日志 flush，然后退出
    setTimeout(() => app.exit(exitCode), 100);
  }
});

// 防止某些桥接残留定时器/服务阻止退出
app.on('window-all-closed', () => { /* 由 finally 里的 app.exit 控制退出 */ });
