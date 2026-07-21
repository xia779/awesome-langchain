// modules/browser-pro.js - Playwright 浏览器自动化（增强版）
// 替代基础 browser_* 工具，支持多标签、Cookie、表单、等待策略、截图
'use strict';

var Core = null;
var fs = null;
var path = null;
var playwright = null;
var browser = null;
var defaultContext = null;
var defaultPage = null;
var pages = {};  // name -> page
var isReady = false;

// ===== 初始化 Playwright =====
async function ensureBrowser() {
  if (isReady && browser) return true;

  try {
    playwright = require('playwright');
  } catch(e) {
    // 尝试 playwright-core
    try { playwright = require('playwright-core'); } catch(e2) {
      console.warn('[browser-pro] Playwright 未安装。运行: npm install playwright');
      return false;
    }
  }

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    defaultContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    defaultPage = await defaultContext.newPage();
    pages['default'] = defaultPage;
    isReady = true;
    console.log('[browser-pro] Chromium 已启动 (headless)');
    return true;
  } catch(e) {
    console.error('[browser-pro] 启动浏览器失败:', e.message);
    return false;
  }
}

// ===== 导航 =====
async function navigate(url, options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };

  var pageName = options.page || 'default';
  var page = pages[pageName] || defaultPage;

  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    var waitUntil = options.waitUntil || 'domcontentloaded';
    var timeout = options.timeout || 30000;

    await page.goto(url, { waitUntil: waitUntil, timeout: timeout });
    var title = await page.title();

    return { success: true, url: page.url(), title: title };
  } catch(e) {
    return { success: false, error: '导航失败: ' + e.message };
  }
}

// ===== 截图 =====
async function screenshot(options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };

  var page = pages[options.page || 'default'] || defaultPage;
  try {
    var screenshotOpts = { type: 'png' };
    if (options.fullPage) screenshotOpts.fullPage = true;
    if (options.selector) {
      var el = await page.$(options.selector);
      if (el) {
        var buf = await el.screenshot(screenshotOpts);
        var filePath = options.path || path.join(Core.DATA_ROOT, 'screenshots', 'shot_' + Date.now() + '.png');
        var dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, buf);
        return { success: true, path: filePath, type: 'element' };
      }
    }
    var buf = await page.screenshot(screenshotOpts);
    var filePath = options.path || path.join(Core.DATA_ROOT, 'screenshots', 'shot_' + Date.now() + '.png');
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buf);
    return { success: true, path: filePath, type: options.fullPage ? 'fullpage' : 'viewport' };
  } catch(e) {
    return { success: false, error: '截图失败: ' + e.message };
  }
}

// ===== 点击 =====
async function click(selector, options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  var page = pages[options.page || 'default'] || defaultPage;
  try {
    await page.click(selector, { timeout: options.timeout || 10000 });
    return { success: true, selector: selector };
  } catch(e) {
    return { success: false, error: '点击失败: ' + e.message };
  }
}

// ===== 输入 =====
async function type(selector, text, options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  var page = pages[options.page || 'default'] || defaultPage;
  try {
    await page.fill(selector, text);
    return { success: true, selector: selector, text: text };
  } catch(e) {
    return { success: false, error: '输入失败: ' + e.message };
  }
}

// ===== 提取内容 =====
async function extract(options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  var page = pages[options.page || 'default'] || defaultPage;
  try {
    if (options.selector) {
      var elements = await page.$$(options.selector);
      var texts = [];
      for (var i = 0; i < Math.min(elements.length, options.limit || 20); i++) {
        var t = await elements[i].textContent();
        if (t && t.trim()) texts.push(t.trim());
      }
      return { success: true, results: texts, count: texts.length };
    }
    // 提取整页文本
    var text = await page.evaluate(function() { return document.body.innerText; });
    var maxLen = options.maxLength || 5000;
    return { success: true, text: text.substring(0, maxLen), truncated: text.length > maxLen };
  } catch(e) {
    return { success: false, error: '提取失败: ' + e.message };
  }
}

// ===== 等待元素 =====
async function waitFor(selector, options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  var page = pages[options.page || 'default'] || defaultPage;
  try {
    await page.waitForSelector(selector, { timeout: options.timeout || 15000, state: options.state || 'visible' });
    return { success: true, selector: selector };
  } catch(e) {
    return { success: false, error: '等待超时: ' + selector };
  }
}

// ===== 执行 JS =====
async function evaluate(script, options) {
  options = options || {};
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  var page = pages[options.page || 'default'] || defaultPage;
  try {
    var result = await page.evaluate(script);
    return { success: true, result: result };
  } catch(e) {
    return { success: false, error: '执行失败: ' + e.message };
  }
}

// ===== Cookie 管理 =====
async function getCookies(url) {
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  try {
    var cookies = await defaultContext.cookies(url ? [url] : undefined);
    return { success: true, cookies: cookies };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ===== 多标签页 =====
async function newTab(url, name) {
  if (!(await ensureBrowser())) return { success: false, error: 'Playwright 不可用' };
  name = name || 'tab_' + Object.keys(pages).length;
  try {
    var page = await defaultContext.newPage();
    pages[name] = page;
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { success: true, name: name, url: page.url() };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

async function closeTab(name) {
  var page = pages[name];
  if (!page) return { success: false, error: '标签页不存在: ' + name };
  try { await page.close(); delete pages[name]; return { success: true }; }
  catch(e) { return { success: false, error: e.message }; }
}

// ===== 关闭浏览器 =====
async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch(e) {}
    browser = null; defaultContext = null; defaultPage = null; pages = {}; isReady = false;
  }
}

// ===== 命令 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('browser', {
    zh: '浏览器: /browser open|shot|text|close',
    en: 'Browser automation'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'open';

    if (sub === 'open') {
      var url = parts[1] || '';
      if (!url) { showMsg('用法: /browser open <url>'); return; }
      showMsg('正在打开: ' + url);
      navigate(url).then(function(r) {
        showMsg(r.success ? '✅ 已打开: ' + r.title + '\n' + r.url : '❌ ' + r.error);
      });
    } else if (sub === 'shot') {
      screenshot({ fullPage: parts[1] === 'full' }).then(function(r) {
        showMsg(r.success ? '✅ 截图已保存: ' + r.path : '❌ ' + r.error);
      });
    } else if (sub === 'text') {
      extract({ maxLength: 3000 }).then(function(r) {
        showMsg(r.success ? r.text.substring(0, 2000) : '❌ ' + r.error);
      });
    } else if (sub === 'close') {
      closeBrowser();
      showMsg('浏览器已关闭');
    } else {
      showMsg('🌐 浏览器命令:\n/browser open <url> — 打开网页\n/browser shot [full] — 截图\n/browser text — 提取文本\n/browser close — 关闭');
    }
  });
}

function showMsg(text) {
  var id = Core.session.getCurrentId();
  if (id && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(id);
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try { fs = require('fs'); path = require('path'); } catch(e) { return; }

  registerCommands();

  Core.browserPro = {
    navigate: navigate,
    screenshot: screenshot,
    click: click,
    type: type,
    extract: extract,
    waitFor: waitFor,
    evaluate: evaluate,
    getCookies: getCookies,
    newTab: newTab,
    closeTab: closeTab,
    close: closeBrowser,
    isReady: function() { return isReady; }
  };

  console.log('✅ browser-pro.js 已加载 | Playwright 浏览器自动化就绪');
}

module.exports = { name: 'browser-pro', dependencies: ['custom', 'session'], init: init };
