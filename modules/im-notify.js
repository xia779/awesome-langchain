// modules/im-notify.js - IM 触达（webhook 推送）(P2-5)
// 设计原则：只完善、不删功能；零外部依赖（复用 Node 内置全局 fetch）。
// 支持：Telegram / Discord / Slack / Bark / 通用 webhook。配置持久化于 DATA_ROOT。
// 可选 forwardNotifications：把 Core.notifications.push 的本地通知同步转发到 IM（带幂等守卫）。
'use strict';

var Core = null;
var fs = null;
var path = null;

var FILE = '';
var notifiers = [];   // [{ id, type, name, url, token, chatId, enabled }]
var _wrapped = false;

function loadState() {
  if (!Core || !Core.DATA_ROOT) return;
  notifiers = [];
  try { fs.mkdirSync(Core.DATA_ROOT, { recursive: true }); } catch (e) {}
  FILE = path.join(Core.DATA_ROOT, 'im-notifiers.json');
  try {
    if (fs.existsSync(FILE)) {
      var s = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      if (Array.isArray(s.notifiers)) notifiers = s.notifiers;
    }
  } catch (e) { notifiers = []; }
}

function saveState() {
  try { if (FILE) fs.writeFileSync(FILE, JSON.stringify({ notifiers: notifiers }, null, 2), 'utf-8'); }
  catch (e) { console.error('im-notify: 保存失败', e.message); }
}

// ===== 纯函数（导出供单测）=====

function _resolveEndpoint(n) {
  switch (n.type) {
    case 'telegram':
      // token 形如 123456:ABC；chatId 为目标会话
      return 'https://api.telegram.org/bot' + (n.token || '') + '/sendMessage';
    case 'bark':
      // url 已含完整 https://api.day.app/xxx ；或在 token 字段给 key
      return n.url || ('https://api.day.app/' + (n.token || ''));
    case 'discord':
    case 'slack':
    case 'generic':
    default:
      return n.url || '';
  }
}

function _buildMessage(n, text, title) {
  var t = String(text || '');
  switch (n.type) {
    case 'telegram':
      return { chat_id: n.chatId || '', text: t, parse_mode: 'Markdown' };
    case 'discord':
      return { content: t };
    case 'slack':
      return { text: t };
    case 'bark':
      // Bark 支持 JSON: { title, body }
      return { title: title || 'AI Agent', body: t };
    case 'generic':
    default:
      return { text: t, title: title || 'AI Agent' };
  }
}

// ===== 推送 =====

async function imPush(text, opts) {
  opts = opts || {};
  var title = opts.title || 'AI Agent';
  var targets = notifiers.filter(function (n) { return n.enabled !== false; });
  if (opts.id) targets = targets.filter(function (n) { return n.id === opts.id; });
  if (!targets.length) return { sent: 0, skipped: true };

  var fn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('运行环境不支持 fetch');

  var results = [];
  for (var i = 0; i < targets.length; i++) {
    var n = targets[i];
    try {
      var url = _resolveEndpoint(n);
      var body = _buildMessage(n, text, title);
      var res = await fn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      results.push({ id: n.id, type: n.type, ok: res.ok, status: res.status });
    } catch (e) {
      results.push({ id: n.id, type: n.type, ok: false, error: e.message });
    }
  }
  return { sent: results.filter(function (r) { return r.ok; }).length, results: results };
}

// ===== 配置 CRUD =====

function addNotifier(type, info) {
  info = info || {};
  var n = {
    id: 'im_' + Date.now().toString(36),
    type: type,
    name: info.name || (type + ' 通知'),
    url: info.url || '',
    token: info.token || '',
    chatId: info.chatId || '',
    enabled: true
  };
  notifiers.push(n);
  saveState();
  return n;
}

function removeNotifier(id) {
  notifiers = notifiers.filter(function (n) { return n.id !== id; });
  saveState();
  return true;
}

function listNotifiers() { return notifiers.slice(); }

function testNotifier(id, fetchFn) {
  return imPush('✅ IM 触达测试：如果你看到这条消息，配置已生效。', { id: id, fetch: fetchFn });
}

// ===== 转发集成（可选，幂等守卫）=====

function _maybeWrapNotifications() {
  if (_wrapped) return;
  var cfg = (Core.config && Core.config.imNotify) || {};
  if (!cfg.forwardNotifications) return;
  if (Core.notifications && typeof Core.notifications.push === 'function') {
    var orig = Core.notifications.push;
    Core.notifications.push = function (n) {
      try {
        var text = (n && (n.title ? (n.title + '\n' + (n.message || '')) : (n && n.message))) || '';
        if (text) imPush(text, { title: (n && n.title) || 'AI Agent' }).catch(function () {});
      } catch (e) { /* 不影响原通知 */ }
      return orig.apply(this, arguments);
    };
    _wrapped = true;
  }
}

// ===== 命令 =====

function showMsg(text) {
  try {
    if (Core.session && Core.session.getCurrentId && Core.session.addMessage) {
      Core.session.addMessage(text, 'assistant');
      var id = Core.session.getCurrentId();
      if (Core.session.renderMessages) Core.session.renderMessages(id);
    }
  } catch (e) { console.log('[im-notify] ' + text); }
}

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('im', {
    zh: 'IM 触达: /im add <telegram|discord|slack|bark|generic> <url或token> [chatId] | list | remove <id> | test [id]',
    en: 'Push notifications to IM via webhook'
  }, function (args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'add') {
      var type = parts[1];
      if (!type || ['telegram', 'discord', 'slack', 'bark', 'generic'].indexOf(type) < 0) {
        showMsg('⚠️ 用法: /im add <telegram|discord|slack|bark|generic> <url或token> [chatId]\n' +
          'Telegram 填 token（botToken）与 chatId；Discord/Slack/通用 填 webhook url；Bark 填 key 或完整 url。');
        return;
      }
      var info = { name: type, url: parts[2] || '', token: parts[2] || '', chatId: parts[3] || '' };
      var n = addNotifier(type, info);
      showMsg('✅ 已添加 IM 通知: **' + type + '**\nID: `' + n.id + '`\n用 `/im test ' + n.id + '` 验证。');
      return;
    }
    if (sub === 'list') {
      if (notifiers.length === 0) { showMsg('📭 暂无 IM 通知配置。用 `/im add <type> <url>` 添加。'); return; }
      var t = '🔔 **IM 通知 (' + notifiers.length + ')**\n\n';
      notifiers.forEach(function (n, i) {
        t += (i + 1) + '. ' + (n.enabled ? '▶' : '⏸') + ' **' + n.type + '** — ' + (n.name || '') + '\n';
        t += '   ID: `' + n.id + '`\n';
      });
      showMsg(t);
      return;
    }
    if (sub === 'remove') {
      var id = parts[1];
      if (!id) { showMsg('⚠️ 用法: /im remove <id>'); return; }
      removeNotifier(id);
      showMsg('✅ 已移除 IM 通知 ' + id);
      return;
    }
    if (sub === 'test') {
      var tid = parts[1];
      if (!tid && notifiers.length === 0) { showMsg('⚠️ 先用 `/im add` 添加，再用 `/im test <id>`。'); return; }
      showMsg('🔄 正在发送测试消息...');
      testNotifier(tid).then(function (r) {
        var ok = r.results ? r.results.filter(function (x) { return x.ok; }).length : 0;
        showMsg(ok > 0 ? '✅ 测试发送成功 (' + ok + ' 个送达)' : '⚠️ 发送失败：' + JSON.stringify(r.results || r));
      }).catch(function (e) { showMsg('⚠️ 发送异常: ' + e.message); });
      return;
    }
    showMsg('🔔 IM 触达命令:\n/im add <type> <url> [chatId] — 添加\n/im list — 列表\n/im remove <id> — 移除\n/im test [id] — 测试发送');
  });
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  try { fs = require('fs'); path = require('path'); } catch (e) {
    console.warn('im-notify.js: 依赖不可用', e.message); return;
  }
  loadState();
  registerCommands();
  _maybeWrapNotifications();
  Core.imNotify = {
    push: imPush,
    addNotifier: addNotifier,
    removeNotifier: removeNotifier,
    listNotifiers: listNotifiers,
    test: testNotifier
  };
  console.log('✅ im-notify.js 已加载 (' + notifiers.length + ' 个 IM 通知)');
}

module.exports = {
  name: 'im-notify',
  dependencies: [],
  init: init,
  _resolveEndpoint: _resolveEndpoint,
  _buildMessage: _buildMessage
};
