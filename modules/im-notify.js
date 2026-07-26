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

// ===== P5-3: 双向通信 — Webhook 接收器 =====
var _webhookServer = null;
var _webhookPort = 0;
var _messageHandlers = [];  // [{ filter: fn, handler: fn }]

function startWebhookReceiver(port) {
  if (_webhookServer) return { success: true, alreadyRunning: true, port: _webhookPort };
  port = port || 9876;

  try {
    var http = require('http');
    _webhookServer = http.createServer(function(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'ai-agent-im-webhook' }));
        return;
      }

      var body = '';
      req.on('data', function(chunk) { body += chunk; if (body.length > 1048576) req.destroy(); });
      req.on('end', function() {
        var parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* not JSON */ }

        var message = _parseIncomingMessage(req.url, parsed, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));

        if (message && message.text) {
          _routeIncomingMessage(message);
        }
      });
    });

    _webhookServer.listen(port, '127.0.0.1', function() {
      _webhookPort = port;
      console.log('\u2705 im-notify: Webhook \u63a5\u6536\u5668\u5df2\u542f\u52a8 (127.0.0.1:' + port + ')');
    });

    _webhookServer.on('error', function(e) {
      console.warn('\u26a0\ufe0f im-notify: Webhook \u670d\u52a1\u5668\u9519\u8bef:', e.message);
      _webhookServer = null;
    });

    return { success: true, port: port };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function stopWebhookReceiver() {
  if (_webhookServer) {
    _webhookServer.close();
    _webhookServer = null;
    _webhookPort = 0;
    return { success: true };
  }
  return { success: true, alreadyStopped: true };
}

function getWebhookStatus() {
  return { running: !!_webhookServer, port: _webhookPort };
}

// 解析不同平台的入站消息格式
function _parseIncomingMessage(url, parsed, rawBody) {
  if (!parsed) {
    // 纯文本 body
    return { platform: 'generic', text: rawBody, sender: 'unknown', timestamp: Date.now() };
  }

  // Telegram Bot webhook: { message: { text, from: { username }, chat: { id } } }
  if (parsed.message && parsed.message.text) {
    return {
      platform: 'telegram',
      text: parsed.message.text,
      sender: (parsed.message.from && parsed.message.from.username) || 'telegram_user',
      chatId: parsed.message.chat && String(parsed.message.chat.id || ''),
      timestamp: (parsed.message.date || 0) * 1000 || Date.now()
    };
  }

  // DingTalk: { msgtype: 'text', text: { content }, senderNick }
  if (parsed.msgtype === 'text' && parsed.text && parsed.text.content) {
    return {
      platform: 'dingtalk',
      text: parsed.text.content,
      sender: parsed.senderNick || 'dingtalk_user',
      timestamp: Date.now()
    };
  }

  // WeCom (企业微信): { MsgType: 'text', Content, FromUserName }
  if (parsed.MsgType === 'text' && parsed.Content) {
    return {
      platform: 'wecom',
      text: parsed.Content,
      sender: parsed.FromUserName || 'wecom_user',
      timestamp: Date.now()
    };
  }

  // Slack: { text, user_name }
  if (parsed.text && (parsed.user_name || parsed.user_id)) {
    return {
      platform: 'slack',
      text: parsed.text,
      sender: parsed.user_name || parsed.user_id,
      timestamp: Date.now()
    };
  }

  // 通用格式: { text/message, sender/from }
  var text = parsed.text || parsed.message || parsed.content || '';
  if (text) {
    return {
      platform: parsed.platform || 'generic',
      text: String(text),
      sender: parsed.sender || parsed.from || parsed.user || 'unknown',
      timestamp: Date.now()
    };
  }

  return null;
}

// 路由入站消息到 Agent
function _routeIncomingMessage(message) {
  console.log('\ud83d\udce8 im-notify: \u6536\u5230\u6d88\u606f [' + message.platform + '] ' + message.sender + ': ' + message.text.substring(0, 80));

  // 先检查自定义处理器
  for (var i = 0; i < _messageHandlers.length; i++) {
    var h = _messageHandlers[i];
    if (!h.filter || h.filter(message)) {
      try {
        var handled = h.handler(message);
        if (handled === true) return; // 已处理，不再继续
      } catch (e) { console.warn('im-notify: handler error', e.message); }
    }
  }

  // 默认路由：发送到当前会话
  if (Core.session && Core.session.addMessage && Core.session.getCurrentId) {
    var currentId = Core.session.getCurrentId();
    if (currentId) {
      Core.session.addMessage('[IM:' + message.platform + '] ' + message.sender + ': ' + message.text, 'user');
      if (Core.session.renderMessages) Core.session.renderMessages(currentId);

      // 触发 AI 回复
      if (Core.api && Core.api.sendMessage && Core.dom && Core.dom.input) {
        Core.dom.input.value = message.text;
        Core.api.sendMessage().catch(function(e) {
          console.warn('im-notify: auto-reply failed', e.message);
        });
      }
    }
  }

  // 触发 trigger-engine 事件
  if (Core.triggerEngine && Core.triggerEngine.emit) {
    Core.triggerEngine.emit('im.message', message);
  }
}

// 注册自定义消息处理器
function onIncomingMessage(filter, handler) {
  _messageHandlers.push({ filter: filter, handler: handler });
  return _messageHandlers.length - 1;
}

function removeMessageHandler(index) {
  if (index >= 0 && index < _messageHandlers.length) {
    _messageHandlers.splice(index, 1);
    return true;
  }
  return false;
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

  // P5-3: 自动启动 webhook 接收器（如果配置了）
  var cfg = (Core.config && Core.config.imNotify) || {};
  if (cfg.webhookEnabled) {
    startWebhookReceiver(cfg.webhookPort || 9876);
  }

  Core.imNotify = {
    push: imPush,
    addNotifier: addNotifier,
    removeNotifier: removeNotifier,
    listNotifiers: listNotifiers,
    test: testNotifier,
    // P5-3: 双向通信
    startWebhook: startWebhookReceiver,
    stopWebhook: stopWebhookReceiver,
    webhookStatus: getWebhookStatus,
    onMessage: onIncomingMessage,
    removeMessageHandler: removeMessageHandler
  };
  console.log('\u2705 im-notify.js \u5df2\u52a0\u8f7d (' + notifiers.length + ' \u4e2a IM \u901a\u77e5' + (cfg.webhookEnabled ? ', Webhook\u5df2\u542f\u52a8' : '') + ')');
}

module.exports = {
  name: 'im-notify',
  dependencies: [],
  init: init,
  _resolveEndpoint: _resolveEndpoint,
  _buildMessage: _buildMessage,
  _parseIncomingMessage: _parseIncomingMessage
};
