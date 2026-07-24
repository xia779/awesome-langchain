// modules/browser-automation.js - 浏览器自动化模块
// 利用 Electron 内置 BrowserWindow 实现无头浏览器操作
// 无需额外依赖（Puppeteer/Playwright），直接使用 Chromium 引擎

var Core = null;
var BrowserWindow = null;

// 尝试加载 Electron BrowserWindow（renderer 进程，nodeIntegration:true）
try {
  var electron = require('electron');
  BrowserWindow = electron.BrowserWindow || electron.remote && electron.remote.BrowserWindow;
} catch (e) {
  console.warn('browser-automation: 无法加载 Electron BrowserWindow:', e.message);
}

// ─── 状态管理 ───
var currentWindow = null;
var sessionHistory = [];   // { url, title, timestamp }
var pageErrors = [];
var allTabs = [];          // [{ id, url, title, window }]

// ─── 常量 ───
var DEFAULT_OPTS = {
  width: 1280,
  height: 900,
  show: false,
  title: 'AI-Automation-Browser',
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    javascript: true,
    images: true,
    webSecurity: true,
    allowRunningInsecureContent: false
  }
};

var NAV_TIMEOUT = 30000;
var EXEC_TIMEOUT = 15000;

// ─── 工具函数 ───
function isValidUrl(url) {
  try {
    var u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) { return false; }
}

function ensureWindow() {
  if (!BrowserWindow) {
    throw new Error('BrowserWindow 不可用，请在 Electron 应用中运行');
  }
  if (!currentWindow || currentWindow.isDestroyed()) {
    throw new Error('浏览器未打开，请先执行 browser_navigate 打开网页');
  }
}

function createWindow(opts) {
  var options = Object.assign({}, DEFAULT_OPTS, opts || {});
  options.webPreferences = Object.assign({}, DEFAULT_OPTS.webPreferences, (opts && opts.webPreferences) || {});
  var win = new BrowserWindow(options);

  // 监听页面错误
  win.webContents.on('page-favicon-updated', function() {});
  win.webContents.on('did-fail-load', function(event, errorCode, errorDescription) {
    pageErrors.push({ code: errorCode, desc: errorDescription, time: Date.now() });
  });

  return win;
}

function destroyWindow(win) {
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch (e) { /* 可忽略：清理路径，失败不影响主流程 */ }
  }
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ═══════════════════════════════════════════
// 核心操作
// ═══════════════════════════════════════════

/**
 * 导航到 URL，可选等待页面加载完成
 */
async function browserNavigate(url, options) {
  if (!isValidUrl(url)) {
    throw new Error('无效的 URL: ' + url + '（仅支持 http:// 和 https://）');
  }
  options = options || {};

  // 如果没有窗口，创建一个
  if (!currentWindow || currentWindow.isDestroyed()) {
    currentWindow = createWindow({
      width: options.width || DEFAULT_OPTS.width,
      height: options.height || DEFAULT_OPTS.height
    });
  }

  pageErrors = [];

  // 等待页面加载完成
  var loadPromise = new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      resolve({ loaded: false, warning: '页面加载超时（' + NAV_TIMEOUT / 1000 + 's），已强制继续' });
    }, NAV_TIMEOUT);

    currentWindow.webContents.once('did-finish-load', function() {
      clearTimeout(timer);
      resolve({ loaded: true });
    });

    currentWindow.webContents.once('did-fail-load', function(e, code, desc) {
      clearTimeout(timer);
      if (code !== -3) { // -3 = aborted (e.g. redirect)
        reject(new Error('页面加载失败 (' + code + '): ' + desc));
      }
    });
  });

  currentWindow.loadURL(url);
  var loadResult = await loadPromise;

  // 额外等待渲染
  if (options.waitForLoad !== false) {
    await sleep(options.waitAfter || 1500);
  }

  var title = '';
  try { title = currentWindow.getTitle(); } catch (e) { console.warn('⚠️ [browser-automation] 操作失败:', e.message || e); }
  var finalUrl = currentWindow.webContents.getURL();

  // 记录历史
  sessionHistory.push({ url: url, title: title, timestamp: Date.now() });
  // 管理标签列表
  var tabIdx = allTabs.findIndex(function(t) { return t.window === currentWindow; });
  if (tabIdx >= 0) {
    allTabs[tabIdx].url = finalUrl;
    allTabs[tabIdx].title = title;
  } else {
    allTabs.push({ id: allTabs.length, url: finalUrl, title: title, window: currentWindow });
  }

  var result = {
    success: true,
    url: finalUrl,
    title: title,
    loaded: loadResult.loaded !== false
  };
  if (loadResult.warning) result.warning = loadResult.warning;
  if (pageErrors.length > 0) result.pageErrors = pageErrors;
  return JSON.stringify(result);
}

/**
 * 截取当前页面截图
 */
async function browserScreenshot(options) {
  ensureWindow();
  options = options || {};

  var nativeImage;
  var captured = false;

  // 方法1：直接调用 webContents.capturePage()（Electron renderer 进程可用）
  try {
    nativeImage = await currentWindow.webContents.capturePage();
    if (nativeImage && !nativeImage.isEmpty()) {
      captured = true;
    }
  } catch (e) {
    console.warn('browser-automation: capturePage 失败:', e.message);
  }

  // 方法2：通过 IPC 委托主进程截图
  if (!captured) {
    try {
      var ipcRenderer = require('electron').ipcRenderer;
      if (ipcRenderer) {
        nativeImage = await new Promise(function(resolve) {
          var id = 'ss_' + Date.now();
          var timer = setTimeout(function() {
            ipcRenderer.removeAllListeners('automation-screenshot-reply');
            resolve(null);
          }, 10000);

          ipcRenderer.once('automation-screenshot-reply', function(event, data) {
            clearTimeout(timer);
            if (data && data.id === id && data.image) {
              resolve(data.image);
            } else {
              resolve(null);
            }
          });

          ipcRenderer.send('automation-screenshot', {
            id: id,
            windowTitle: 'AI-Automation-Browser'
          });
        });
        if (nativeImage && !nativeImage.isEmpty()) captured = true;
      }
    } catch (e) {
      console.warn('browser-automation: IPC 截图失败:', e.message);
    }
  }

  if (!captured || !nativeImage) {
    return JSON.stringify({ success: false, error: '截图失败：无法捕获页面内容' });
  }

  var result = {};
  if (options.fullPage) {
    result.base64 = nativeImage.toPNG().toString('base64');
    result.format = 'png';
  } else {
    var quality = options.quality || 80;
    result.base64 = nativeImage.toJPEG(quality).toString('base64');
    result.format = 'jpeg';
  }

  var size = nativeImage.getSize();
  result.width = size.width;
  result.height = size.height;
  result.success = true;
  return JSON.stringify(result);
}

/**
 * 在页面中执行 JavaScript 并返回结果
 */
async function browserExecuteJs(code) {
  ensureWindow();
  if (!code || typeof code !== 'string') {
    throw new Error('请提供要执行的 JavaScript 代码');
  }

  try {
    var result = await currentWindow.webContents.executeJavaScript(code, true);
    // 安全序列化
    try {
      return JSON.stringify({ success: true, result: result });
    } catch (e) {
      return JSON.stringify({ success: true, result: String(result) });
    }
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * 提取页面文本内容
 */
async function browserGetText(selector) {
  ensureWindow();
  var code;
  if (selector) {
    code = '(function() { var el = document.querySelector(' + JSON.stringify(selector) + '); return el ? el.innerText : null; })()';
  } else {
    code = '(function() { var clone = document.body.cloneNode(true); var scripts = clone.querySelectorAll("script,style,noscript"); scripts.forEach(function(s) { s.remove(); }); return clone.innerText; })()';
  }
  var result = await currentWindow.webContents.executeJavaScript(code, true);
  var text = result ? result.trim() : '';
  // 限制长度防止过大
  if (text.length > 50000) text = text.substring(0, 50000) + '\n...[已截断]';
  return JSON.stringify({ success: true, text: text, length: text.length });
}

/**
 * 获取页面 HTML 源码
 */
async function browserGetHtml(selector) {
  ensureWindow();
  var code;
  if (selector) {
    code = '(function() { var el = document.querySelector(' + JSON.stringify(selector) + '); return el ? el.outerHTML : null; })()';
  } else {
    code = 'document.documentElement.outerHTML';
  }
  var html = await currentWindow.webContents.executeJavaScript(code, true);
  if (html && html.length > 100000) html = html.substring(0, 100000) + '\n<!-- [已截断] -->';
  return JSON.stringify({ success: true, html: html || '', length: (html || '').length });
}

/**
 * 点击页面元素
 */
async function browserClick(selector) {
  ensureWindow();
  if (!selector) throw new Error('请提供 CSS 选择器');

  var code = '(function() {' +
    'var el = document.querySelector(' + JSON.stringify(selector) + ');' +
    'if (!el) return { success: false, error: "未找到元素: ' + selector.replace(/'/g, "\\'") + '" };' +
    'el.scrollIntoView({ behavior: "instant", block: "center" });' +
    'el.click();' +
    'return { success: true, tag: el.tagName, text: (el.innerText || el.value || "").substring(0, 100) };' +
  '})()';

  var result = await currentWindow.webContents.executeJavaScript(code, true);
  await sleep(500);
  return JSON.stringify(result || { success: false, error: '执行失败' });
}

/**
 * 在输入框中输入文本
 */
async function browserType(selector, text, options) {
  ensureWindow();
  if (!selector) throw new Error('请提供 CSS 选择器');
  if (text === undefined || text === null) throw new Error('请提供要输入的文本');
  options = options || {};

  var clearFirst = options.clear !== false ? 'true' : 'false';
  var code = '(function() {' +
    'var el = document.querySelector(' + JSON.stringify(selector) + ');' +
    'if (!el) return { success: false, error: "未找到元素: ' + selector.replace(/'/g, "\\'") + '" };' +
    'el.scrollIntoView({ behavior: "instant", block: "center" });' +
    'el.focus();' +
    'if (' + clearFirst + ') { el.value = ""; }' +
    'el.value = ' + JSON.stringify(String(text)) + ';' +
    'el.dispatchEvent(new Event("input", { bubbles: true }));' +
    'el.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return { success: true, tag: el.tagName, type: el.type || "text", length: el.value.length };' +
  '})()';

  var result = await currentWindow.webContents.executeJavaScript(code, true);
  return JSON.stringify(result || { success: false, error: '执行失败' });
}

/**
 * 提交表单
 */
async function browserSubmit(selector) {
  ensureWindow();
  var sel = selector || 'form';
  var code = '(function() {' +
    'var form = document.querySelector(' + JSON.stringify(sel) + ');' +
    'if (!form) return { success: false, error: "未找到表单: ' + sel.replace(/'/g, "\\'") + '" };' +
    'if (form.requestSubmit) { form.requestSubmit(); }' +
    'else { form.submit(); }' +
    'return { success: true, action: form.action || "(none)", method: form.method || "GET" };' +
  '})()';

  var result = await currentWindow.webContents.executeJavaScript(code, true);

  // 等待导航
  if (result && result.success) {
    await sleep(2000);
    try {
      result.finalUrl = currentWindow.webContents.getURL();
      result.finalTitle = currentWindow.getTitle();
    } catch (e) { console.warn('⚠️ [browser-automation] 操作失败:', e.message || e); }
  }
  return JSON.stringify(result || { success: false, error: '执行失败' });
}

/**
 * 等待指定时间或等待元素出现
 */
async function browserWait(options) {
  ensureWindow();
  options = options || {};

  if (options.selector) {
    var timeout = options.timeout || 10000;
    var interval = 300;
    var elapsed = 0;
    var code = '(function() { var el = document.querySelector(' + JSON.stringify(options.selector) + '); return !!el; })()';

    while (elapsed < timeout) {
      try {
        var found = await currentWindow.webContents.executeJavaScript(code, true);
        if (found) return JSON.stringify({ success: true, found: true, waited: elapsed + 'ms' });
      } catch (e) { console.warn('⚠️ [browser-automation] 操作失败:', e.message || e); }
      await sleep(interval);
      elapsed += interval;
    }
    return JSON.stringify({ success: false, found: false, waited: elapsed + 'ms', error: '等待超时: ' + options.selector });
  }

  // 简单延时
  var ms = options.ms || options.duration || 1000;
  await sleep(ms);
  return JSON.stringify({ success: true, waited: ms + 'ms' });
}

/**
 * 提取页面所有链接
 */
async function browserGetLinks() {
  ensureWindow();
  var code = '(function() {' +
    'var links = [];' +
    'var anchors = document.querySelectorAll("a[href]");' +
    'anchors.forEach(function(a, i) {' +
    '  links.push({ index: i, text: (a.innerText || "").trim().substring(0, 120), href: a.href });' +
    '});' +
    'return links;' +
  '})()';

  var links = await currentWindow.webContents.executeJavaScript(code, true);
  return JSON.stringify({ success: true, links: links || [], count: (links || []).length });
}

/**
 * 提取页面表单数据
 */
async function browserGetForms() {
  ensureWindow();
  var code = '(function() {' +
    'var forms = [];' +
    'document.querySelectorAll("form").forEach(function(form, fi) {' +
    '  var fields = [];' +
    '  form.querySelectorAll("input,select,textarea").forEach(function(el) {' +
    '    fields.push({' +
    '      tag: el.tagName, name: el.name || "", id: el.id || "",' +
    '      type: el.type || "", value: (el.value || "").substring(0, 200),' +
    '      placeholder: el.placeholder || "", required: el.required' +
    '    });' +
    '  });' +
    '  forms.push({ index: fi, action: form.action || "", method: form.method || "GET", fields: fields });' +
    '});' +
    'return forms;' +
  '})()';

  var forms = await currentWindow.webContents.executeJavaScript(code, true);
  return JSON.stringify({ success: true, forms: forms || [], count: (forms || []).length });
}

/**
 * 获取页面 cookies
 */
async function browserGetCookies() {
  ensureWindow();
  var code = '(function() { return document.cookie; })()';
  var cookieStr = await currentWindow.webContents.executeJavaScript(code, true);
  var cookies = (cookieStr || '').split(';').map(function(c) {
    var parts = c.trim().split('=');
    return { name: parts[0] || '', value: parts.slice(1).join('=') || '' };
  }).filter(function(c) { return c.name; });
  return JSON.stringify({ success: true, cookies: cookies, count: cookies.length });
}

/**
 * 获取页面元信息
 */
async function browserGetInfo() {
  ensureWindow();
  var code = '(function() {' +
    'var meta = {};' +
    'meta.title = document.title || "";' +
    'meta.url = location.href;' +
    'meta.description = (document.querySelector(\'meta[name="description"]\') || {}).content || "";' +
    'meta.keywords = (document.querySelector(\'meta[name="keywords"]\') || {}).content || "";' +
    'meta.canonical = (document.querySelector(\'link[rel="canonical"]\') || {}).href || "";' +
    'meta.og_title = (document.querySelector(\'meta[property="og:title"]\') || {}).content || "";' +
    'meta.og_desc = (document.querySelector(\'meta[property="og:description"]\') || {}).content || "";' +
    'meta.viewport = (document.querySelector(\'meta[name="viewport"]\') || {}).content || "";' +
    'meta.charset = document.characterSet || "";' +
    'meta.lang = document.documentElement.lang || "";' +
    'meta.links = document.querySelectorAll("a[href]").length;' +
    'meta.images = document.querySelectorAll("img").length;' +
    'meta.forms = document.querySelectorAll("form").length;' +
    'meta.scripts = document.querySelectorAll("script").length;' +
    'meta.stylesheets = document.querySelectorAll("link[rel=stylesheet]").length;' +
    'return meta;' +
  '})()';

  var info = await currentWindow.webContents.executeJavaScript(code, true);
  // 补充窗口信息
  try {
    info.windowTitle = currentWindow.getTitle();
    var bounds = currentWindow.getBounds();
    info.windowSize = { width: bounds.width, height: bounds.height };
  } catch (e) { console.warn('⚠️ [browser-automation] 操作失败:', e.message || e); }
  return JSON.stringify({ success: true, info: info || {} });
}

/**
 * 前进/后退导航
 */
async function browserGoBack(direction) {
  ensureWindow();
  if (direction === 'forward') {
    currentWindow.webContents.goForward();
  } else {
    currentWindow.webContents.goBack();
  }
  await sleep(1500);
  try {
    return JSON.stringify({
      success: true,
      direction: direction || 'back',
      url: currentWindow.webContents.getURL(),
      title: currentWindow.getTitle()
    });
  } catch (e) {
    return JSON.stringify({ success: true, direction: direction || 'back' });
  }
}

/**
 * 关闭浏览器窗口
 */
async function browserClose() {
  if (currentWindow && !currentWindow.isDestroyed()) {
    destroyWindow(currentWindow);
    currentWindow = null;
    allTabs = allTabs.filter(function(t) { return t.window !== currentWindow; });
    return JSON.stringify({ success: true, message: '浏览器已关闭' });
  }
  return JSON.stringify({ success: true, message: '浏览器未打开' });
}

/**
 * 多标签管理
 */
async function browserTabs(action, options) {
  options = options || {};

  if (action === 'new') {
    var url = options.url || 'about:blank';
    if (currentWindow && !currentWindow.isDestroyed()) {
      allTabs.push({ id: allTabs.length, url: currentWindow.webContents.getURL(), title: currentWindow.getTitle(), window: currentWindow });
    }
    currentWindow = createWindow(options);
    if (url !== 'about:blank') {
      await browserNavigate(url, options);
    }
    return JSON.stringify({ success: true, message: '新标签已打开', tabCount: allTabs.length + 1 });
  }

  if (action === 'switch') {
    var idx = options.index;
    if (idx === undefined) throw new Error('请提供标签索引');
    // 保存当前窗口
    if (currentWindow && !currentWindow.isDestroyed()) {
      var existIdx = allTabs.findIndex(function(t) { return t.window === currentWindow; });
      if (existIdx < 0) {
        allTabs.push({ id: allTabs.length, url: currentWindow.webContents.getURL(), title: currentWindow.getTitle(), window: currentWindow });
      }
    }
    if (idx >= 0 && idx < allTabs.length) {
      currentWindow = allTabs[idx].window;
      return JSON.stringify({ success: true, switched: idx, url: allTabs[idx].url });
    }
    throw new Error('标签索引超出范围: ' + idx);
  }

  if (action === 'close') {
    var closeIdx = options.index;
    if (closeIdx !== undefined && closeIdx >= 0 && closeIdx < allTabs.length) {
      destroyWindow(allTabs[closeIdx].window);
      allTabs.splice(closeIdx, 1);
      if (currentWindow === allTabs[closeIdx]) {
        currentWindow = allTabs.length > 0 ? allTabs[allTabs.length - 1].window : null;
      }
      return JSON.stringify({ success: true, message: '标签已关闭', remaining: allTabs.length });
    }
    // 关闭当前
    return await browserClose();
  }

  // 默认: list
  var tabs = allTabs.map(function(t, i) {
    return {
      index: i,
      url: t.url,
      title: t.title,
      active: t.window === currentWindow
    };
  });
  // 加上当前窗口（如果不在 allTabs 中）
  if (currentWindow && !currentWindow.isDestroyed()) {
    var found = tabs.some(function(t) { return t.active; });
    if (!found) {
      tabs.push({
        index: tabs.length,
        url: currentWindow.webContents.getURL(),
        title: currentWindow.getTitle(),
        active: true
      });
    }
  }
  return JSON.stringify({ success: true, tabs: tabs, count: tabs.length });
}

/**
 * 按键模拟
 */
async function browserKeyPress(key, modifiers) {
  ensureWindow();
  modifiers = modifiers || [];
  var code = '(function() {' +
    'var opts = { bubbles: true, cancelable: true, key: ' + JSON.stringify(key) + ' };' +
    (modifiers.includes('ctrl') ? 'opts.ctrlKey = true;' : '') +
    (modifiers.includes('shift') ? 'opts.shiftKey = true;' : '') +
    (modifiers.includes('alt') ? 'opts.altKey = true;' : '') +
    (modifiers.includes('meta') ? 'opts.metaKey = true;' : '') +
    'document.activeElement.dispatchEvent(new KeyboardEvent("keydown", opts));' +
    'document.activeElement.dispatchEvent(new KeyboardEvent("keyup", opts));' +
    'return { success: true, key: ' + JSON.stringify(key) + ' };' +
  '})()';

  var result = await currentWindow.webContents.executeJavaScript(code, true);
  return JSON.stringify(result || { success: false, error: '按键模拟失败' });
}

/**
 * 页面内搜索（高亮匹配）
 */
async function browserFindText(text) {
  ensureWindow();
  if (!text) throw new Error('请提供搜索文本');

  var code = '(function() {' +
    'var text = ' + JSON.stringify(text) + ';' +
    'var body = document.body.innerText;' +
    'var idx = body.toLowerCase().indexOf(text.toLowerCase());' +
    'if (idx === -1) return { found: false, message: "未找到: " + text };' +
    '// 计算上下文' +
    'var start = Math.max(0, idx - 80);' +
    'var end = Math.min(body.length, idx + text.length + 80);' +
    'var context = body.substring(start, end);' +
    '// 统计出现次数' +
    'var regex = new RegExp(text.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), "gi");' +
    'var matches = body.match(regex);' +
    'return { found: true, count: matches ? matches.length : 0, context: context, index: idx };' +
  '})()';

  var result = await currentWindow.webContents.executeJavaScript(code, true);
  return JSON.stringify(result || { found: false });
}

/**
 * 设置 HTTP 请求头
 */
async function browserSetHeaders(headers) {
  ensureWindow();
  if (!headers || typeof headers !== 'object') {
    throw new Error('请提供 headers 对象');
  }
  // Electron webContents 支持 setExtraHeaders（仅在下一次导航时生效）
  try {
    currentWindow.webContents.session.webRequest.onBeforeSendHeaders(function(details, callback) {
      Object.keys(headers).forEach(function(key) {
        details.requestHeaders[key] = headers[key];
      });
      callback({ requestHeaders: details.requestHeaders });
    });
    return JSON.stringify({ success: true, headers: headers, message: 'Headers 已设置（下次导航生效）' });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

/**
 * 清除浏览数据
 */
async function browserClearData(options) {
  ensureWindow();
  options = options || {};
  var session = currentWindow.webContents.session;

  try {
    if (options.cookies !== false) {
      await session.clearStorageData({ storages: ['cookies'] });
    }
    if (options.cache !== false) {
      await session.clearCache();
    }
    if (options.localStorage !== false) {
      await session.clearStorageData({ storages: ['localstorage', 'sessionstorage'] });
    }
    return JSON.stringify({ success: true, message: '浏览数据已清除' });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
}

// ═══════════════════════════════════════════
// /browser 命令路由
// ═══════════════════════════════════════════

async function handleBrowserCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'status').toLowerCase();
  var rest = parts.slice(1).join(' ');

  switch (sub) {
    case 'open': case 'goto': case 'navigate':
      if (!rest) return '请提供 URL，例如：/browser open https://example.com';
      return await browserNavigate(rest);

    case 'ss': case 'screenshot': case '截图':
      return await browserScreenshot({ fullPage: rest.includes('full') });

    case 'click': case '点击':
      return await browserClick(rest);

    case 'type': case '输入':
      var typeParts = rest.split(/\s+(?=\S)/);
      if (typeParts.length < 2) return '用法: /browser type <selector> <text>';
      return await browserType(typeParts[0], typeParts.slice(1).join(' '));

    case 'submit': case '提交':
      return await browserSubmit(rest || 'form');

    case 'js': case 'exec': case '执行':
      if (!rest) return '请提供 JavaScript 代码';
      return await browserExecuteJs(rest);

    case 'text': case '文本':
      return await browserGetText(rest || '');

    case 'html': case '源码':
      return await browserGetHtml(rest || '');

    case 'links': case '链接':
      return await browserGetLinks();

    case 'forms': case '表单':
      return await browserGetForms();

    case 'cookies': case 'cookie':
      return await browserGetCookies();

    case 'info': case '信息':
      return await browserGetInfo();

    case 'wait': case '等待':
      var ms = parseInt(rest) || 1000;
      return await browserWait({ ms: ms });

    case 'back': case '后退':
      return await browserGoBack('back');

    case 'forward': case '前进':
      return await browserGoBack('forward');

    case 'close': case '关闭':
      return await browserClose();

    case 'tabs': case '标签':
      return await browserTabs(rest || 'list');

    case 'find': case '搜索':
      return await browserFindText(rest);

    case 'clear': case '清除':
      return await browserClearData();

    case 'status': case '状态':
      if (currentWindow && !currentWindow.isDestroyed()) {
        return JSON.stringify({
          opened: true,
          url: currentWindow.webContents.getURL(),
          title: currentWindow.getTitle(),
          historyCount: sessionHistory.length,
          tabsCount: allTabs.length + 1
        });
      }
      return JSON.stringify({ opened: false, message: '浏览器未打开' });

    default:
      return '浏览器命令: open, screenshot, click, type, submit, js, text, html, links, forms, cookies, info, wait, back, forward, close, tabs, find, clear, status';
  }
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.browser = {
      navigate: browserNavigate,
      screenshot: browserScreenshot,
      executeJs: browserExecuteJs,
      getText: browserGetText,
      getHtml: browserGetHtml,
      click: browserClick,
      type: browserType,
      submit: browserSubmit,
      wait: browserWait,
      getLinks: browserGetLinks,
      getForms: browserGetForms,
      getCookies: browserGetCookies,
      getInfo: browserGetInfo,
      goBack: browserGoBack,
      close: browserClose,
      tabs: browserTabs,
      keyPress: browserKeyPress,
      findText: browserFindText,
      setHeaders: browserSetHeaders,
      clearData: browserClearData,
      handleCommand: handleBrowserCommand,
      isAvailable: function() { return !!BrowserWindow; },
      isOpen: function() { return currentWindow && !currentWindow.isDestroyed(); },
      getHistory: function() { return sessionHistory.slice(); }
    };

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/browser', function(args) {
        return handleBrowserCommand(args);
      });
    }

  }
};
