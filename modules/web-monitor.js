// modules/web-monitor.js - 指定 URL 内容变更监控 (P2-6)
// 设计原则：只完善、不删功能；零外部依赖（复用 Node 内置全局 fetch）。
// 复用：Core.scheduler（定时检查）、Core.DATA_ROOT（持久化）、Core.custom（/watch 命令）、
//      Core.notifications（变更通知）。单源失败不影响其他源，绝不崩。
'use strict';

var Core = null;
var fs = null;
var path = null;

var FILE = '';
var monitors = [];   // [{ id, url, name, selector, lastHash, lastContent, lastCheck, lastChange, changeCount, enabled, notify }]
var changes = [];    // [{ id, monitorId, url, title, time, snippet }]
var MAX_CHANGES = 500;
var _schedulerTaskId = '';
var CHECK_INTERVAL = '15m';

// ===== 持久化 =====

function loadState() {
  if (!Core || !Core.DATA_ROOT) return;
  // 始终先清空，缺失/损坏的状态文件都从空开始（避免跨 init 残留）
  monitors = [];
  changes = [];
  try { fs.mkdirSync(Core.DATA_ROOT, { recursive: true }); } catch (e) {}
  FILE = path.join(Core.DATA_ROOT, 'web-monitors.json');
  try {
    if (fs.existsSync(FILE)) {
      var s = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      if (Array.isArray(s.monitors)) monitors = s.monitors;
      if (Array.isArray(s.changes)) changes = s.changes;
    }
  } catch (e) { monitors = []; changes = []; }
}

function saveState() {
  try {
    if (!FILE) return;
    fs.writeFileSync(FILE, JSON.stringify({ monitors: monitors, changes: changes.slice(-MAX_CHANGES) }, null, 2), 'utf-8');
  } catch (e) { console.error('web-monitor: 保存失败', e.message); }
}

// ===== 文本工具（导出供单测）=====

function _stripScripts(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function _stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 规范化：去脚本/样式 → 去标签 → 折叠空白。selector 命中时只取该区域文本。
function _normalize(html, selector) {
  var text = _stripScripts(html);
  if (selector) {
    var m = text.match(new RegExp(selector, 'i'));
    if (m) text = m[0];
  }
  text = _stripTags(text);
  return text.replace(/\s+/g, ' ').trim();
}

// 简单字符串哈希（djb2），无需依赖
function _hash(s) {
  var str = String(s || '');
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// ===== 抓取（全局 fetch，支持重定向跟随 + 超时）=====

async function fetchText(url, fetchFn) {
  var fn = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('运行环境不支持 fetch');
  var res = await fn(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Agent-WebMonitor/1.0)' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

// ===== 监控项 CRUD =====

function addMonitor(url, opts) {
  opts = opts || {};
  var m = {
    id: 'wm_' + Date.now().toString(36),
    url: url,
    name: opts.name || url,
    selector: opts.selector || '',
    lastHash: '',
    lastContent: '',
    lastCheck: 0,
    lastChange: 0,
    changeCount: 0,
    enabled: true,
    notify: (opts.notify !== false)
  };
  monitors.push(m);
  saveState();
  _ensureSchedulerTask();
  return m;
}

function removeMonitor(id) {
  monitors = monitors.filter(function (m) { return m.id !== id; });
  saveState();
  return true;
}

function listMonitors() { return monitors.slice(); }

function getChanges(filter) {
  filter = filter || {};
  var out = changes.slice();
  if (filter.monitorId) out = out.filter(function (c) { return c.monitorId === filter.monitorId; });
  if (filter.limit) out = out.slice(0, filter.limit);
  return out;
}

// ===== 单次检查 =====

async function check(monitor, fetchFn) {
  monitor.lastCheck = Date.now();
  try {
    var html = await fetchText(monitor.url, fetchFn);
    var norm = _normalize(html, monitor.selector);
    var h = _hash(norm);
    if (monitor.lastHash && monitor.lastHash !== h) {
      // 检测到变更
      monitor.lastChange = Date.now();
      monitor.changeCount = (monitor.changeCount || 0) + 1;
      var rec = {
        id: 'wc_' + Date.now().toString(36),
        monitorId: monitor.id,
        url: monitor.url,
        title: monitor.name,
        time: monitor.lastChange,
        snippet: norm.substring(0, 200)
      };
      changes.push(rec);
      if (changes.length > MAX_CHANGES) changes = changes.slice(-MAX_CHANGES);
      if (monitor.notify) _notifyChange(monitor, norm);
      monitor.lastHash = h;
      monitor.lastContent = norm;
      saveState();
      return { id: monitor.id, changed: true, changeCount: monitor.changeCount };
    }
    monitor.lastHash = h;
    monitor.lastContent = norm;
    saveState();
    return { id: monitor.id, changed: false };
  } catch (e) {
    monitor.lastError = e.message;
    saveState();
    return { id: monitor.id, changed: false, error: e.message };
  }
}

async function checkAll(fetchFn) {
  var results = [];
  for (var i = 0; i < monitors.length; i++) {
    if (!monitors[i].enabled) continue;
    try { results.push(await check(monitors[i], fetchFn)); }
    catch (e) { results.push({ id: monitors[i].id, error: e.message }); }
  }
  return results;
}

function _notifyChange(monitor, snippet) {
  var msg = '📡 网页变更: ' + (monitor.name || monitor.url) + '\n' + (monitor.url || '') + '\n' +
    (snippet ? snippet.substring(0, 120) + (snippet.length > 120 ? '…' : '') : '');
  try {
    if (Core.notifications && Core.notifications.push) {
      Core.notifications.push({ type: 'SYSTEM', title: '网页监控变更', message: msg, url: monitor.url });
    } else {
      console.log('[web-monitor] ' + msg);
    }
  } catch (e) { console.log('[web-monitor] ' + msg); }
}

// ===== 定时任务 =====

function _ensureSchedulerTask() {
  if (!Core.scheduler || !Core.scheduler.registerHandler) return;
  Core.scheduler.registerHandler('webmon.check', function () {
    checkAll().catch(function (e) { console.error('web-monitor: 检查失败', e.message); });
  });
  try {
    var existing = Core.scheduler.list() || [];
    var found = existing.some(function (t) { return (t.name || '').indexOf('网页监控') >= 0; });
    if (!found && monitors.length > 0) {
      var task = Core.scheduler.add({
        name: '网页监控检查',
        schedule: { type: 'interval', interval: CHECK_INTERVAL },
        action: { type: 'custom', handler: 'webmon.check' }
      });
      _schedulerTaskId = task.id;
    }
  } catch (e) { console.warn('web-monitor: 定时注册失败', e.message); }
}

// ===== 命令 =====

function showMsg(text) {
  try {
    if (Core.session && Core.session.getCurrentId && Core.session.addMessage) {
      Core.session.addMessage(text, 'assistant');
      var id = Core.session.getCurrentId();
      if (Core.session.renderMessages) Core.session.renderMessages(id);
    }
  } catch (e) { console.log('[web-monitor] ' + text); }
}

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('watch', {
    zh: '网页监控: /watch add <url> [名称] | list | remove <id> | check [id] | changes [n]',
    en: 'Web page change monitor'
  }, function (args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'add') {
      var url = parts[1];
      if (!url || url.indexOf('http') !== 0) {
        showMsg('⚠️ 用法: /watch add <url> [名称]\n示例: /watch add https://example.com 示例站');
        return;
      }
      var name = parts.slice(2).join(' ') || url;
      var m = addMonitor(url, { name: name });
      showMsg('✅ 已添加监控: **' + name + '**\nID: `' + m.id + '`\n正在首次抓取基线...');
      check(m).then(function (r) {
        showMsg(r.error ? ('⚠️ 首次抓取失败: ' + r.error) : '✅ 已建立内容基线，后续变更将通知你。');
      });
      return;
    }
    if (sub === 'list') {
      if (monitors.length === 0) { showMsg('📭 暂无监控项。用 `/watch add <url>` 添加。'); return; }
      var t = '📡 **网页监控 (' + monitors.length + ')**\n\n';
      monitors.forEach(function (m, i) {
        t += (i + 1) + '. ' + (m.enabled ? '▶' : '⏸') + ' **' + (m.name || m.url) + '**\n';
        t += '   ID: `' + m.id + '` | 变更: ' + (m.changeCount || 0) + ' 次' + (m.lastError ? ' | ⚠️ ' + m.lastError : '') + '\n';
        t += '   ' + (m.url || '') + '\n';
      });
      showMsg(t);
      return;
    }
    if (sub === 'remove') {
      var id = parts[1];
      if (!id) { showMsg('⚠️ 用法: /watch remove <id>'); return; }
      removeMonitor(id);
      showMsg('✅ 已移除监控 ' + id);
      return;
    }
    if (sub === 'check') {
      var cid = parts[1];
      if (cid) {
        var mm = monitors.find(function (x) { return x.id === cid; });
        if (!mm) { showMsg('⚠️ 未找到监控 ' + cid); return; }
        showMsg('🔄 正在检查 ' + (mm.name || mm.url) + '...');
        check(mm).then(function (r) {
          showMsg(r.changed ? '🔔 检测到变更！累计 ' + r.changeCount + ' 次' : (r.error ? '⚠️ 失败: ' + r.error : '✅ 无变更'));
        });
      } else {
        showMsg('🔄 正在检查全部监控项...');
        checkAll().then(function (res) {
          var ch = res.filter(function (r) { return r.changed; }).length;
          var err = res.filter(function (r) { return r.error; }).length;
          showMsg('✅ 完成: ' + res.length + ' 项，' + ch + ' 项有变更，' + err + ' 项异常。');
        });
      }
      return;
    }
    if (sub === 'changes') {
      var n = parseInt(parts[1]) || 10;
      var list = getChanges({ limit: n });
      if (list.length === 0) { showMsg('📭 暂无变更记录。'); return; }
      var t2 = '🔔 **最近 ' + list.length + ' 次变更**\n\n';
      list.forEach(function (c, i) {
        t2 += (i + 1) + '. **' + (c.title || c.url) + '** · ' + new Date(c.time).toLocaleString() + '\n';
        t2 += '   ' + (c.url || '') + '\n';
        if (c.snippet) t2 += '   ' + c.snippet + '\n';
      });
      showMsg(t2);
      return;
    }
    showMsg('📡 网页监控命令:\n/watch add <url> [名称] — 添加监控\n/watch list — 列表\n/watch remove <id> — 移除\n/watch check [id] — 检查\n/watch changes [n] — 查看变更');
  });
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  try { fs = require('fs'); path = require('path'); } catch (e) {
    console.warn('web-monitor.js: 依赖不可用', e.message); return;
  }
  loadState();
  registerCommands();
  _ensureSchedulerTask();
  Core.webMonitor = {
    addMonitor: addMonitor,
    removeMonitor: removeMonitor,
    listMonitors: listMonitors,
    check: check,
    checkAll: checkAll,
    getChanges: getChanges
  };
  console.log('✅ web-monitor.js 已加载 (' + monitors.length + ' 监控项)');
}

module.exports = {
  name: 'web-monitor',
  dependencies: ['scheduler'],
  init: init,
  _normalize: _normalize,
  _hash: _hash,
  _stripTags: _stripTags,
  _fetchText: fetchText,
  _check: check
};
