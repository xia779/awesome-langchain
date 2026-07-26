// modules/rss-engine.js - RSS/Atom 订阅聚合引擎 (P2-2)
// 设计原则：只完善、不删功能；零外部依赖（Node 内置 http/https + 轻量正则解析）。
// 复用：Core.scheduler（定时刷新）、Core.DATA_ROOT（持久化）、Core.custom（/rss 命令）。
// 自动加载：core-v10.js 的 loadModules() 会扫描 modules/ 目录并调用本模块 init(Core)。
'use strict';

var Core = null;
var fs = null;
var path = null;
var http = null;
var https = null;

var FEEDS_FILE = '';
var ITEMS_FILE = '';
var feeds = [];   // [{ id, url, title, category, keywords[], enabled, lastFetch, lastError, itemCount }]
var items = [];   // [{ feedId, feedTitle, title, link, summary, author, pubDate, ts, guid, keywords[] }]
var _schedulerTaskId = '';
var REFRESH_INTERVAL = '30m';
var MAX_ITEMS = 1000;

// ===== 持久化 =====

function loadState() {
  if (!Core || !Core.DATA_ROOT) return;
  try { fs.mkdirSync(Core.DATA_ROOT, { recursive: true }); } catch (e) { /* 忽略 */ }
  FEEDS_FILE = path.join(Core.DATA_ROOT, 'rss-feeds.json');
  ITEMS_FILE = path.join(Core.DATA_ROOT, 'rss-items.json');
  try {
    if (fs.existsSync(FEEDS_FILE)) feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf-8')) || [];
  } catch (e) { feeds = []; }
  try {
    if (fs.existsSync(ITEMS_FILE)) items = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf-8')) || [];
  } catch (e) { items = []; }
}

function saveFeeds() {
  try { if (FEEDS_FILE) fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2), 'utf-8'); }
  catch (e) { console.error('rss-engine: saveFeeds 失败', e.message); }
}

function saveItems() {
  try { if (ITEMS_FILE) fs.writeFileSync(ITEMS_FILE, JSON.stringify(items.slice(-MAX_ITEMS), null, 2), 'utf-8'); }
  catch (e) { console.error('rss-engine: saveItems 失败', e.message); }
}

// ===== 文本工具 =====

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  if (!s) return '';
  // 必须先解码实体（RSS 中 < 常以 &lt; 形式存在），再剥离标签，否则 &lt;b&gt; 解码后会残留标签
  var decoded = decodeEntities(String(s));
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCdata(s) {
  if (!s) return '';
  var m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

// ===== 抓取（内置 http/https，支持重定向 + 超时）=====

function fetchUrl(targetUrl, depth, cb) {
  if (depth > 3) { cb(new Error('重定向次数过多'), null); return; }
  var parsed;
  try { parsed = new URL(targetUrl); } catch (e) { cb(e, null); return; }
  var isHttps = parsed.protocol === 'https:';
  var lib = isHttps ? https : http;
  if (!lib) { cb(new Error('不支持的协议: ' + parsed.protocol), null); return; }

  var opts = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: (parsed.pathname || '/') + (parsed.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AI-Agent-RSS/1.0)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
    },
    timeout: 10000
  };

  var req = lib.request(opts, function (res) {
    var code = res.statusCode;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume();
      var next;
      try { next = new URL(res.headers.location, targetUrl).toString(); }
      catch (e) { cb(new Error('重定向地址无效'), null); return; }
      fetchUrl(next, depth + 1, cb);
      return;
    }
    if (code !== 200) { res.resume(); cb(new Error('HTTP ' + code), null); return; }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, Buffer.concat(chunks).toString('utf-8')); });
  });
  req.on('error', function (e) { cb(e, null); });
  req.on('timeout', function () { req.destroy(new Error('请求超时')); });
  req.end();
}

// ===== 解析（RSS 2.0 <item> / Atom <entry>）=====

function parseFeed(xml) {
  if (!xml) return [];
  var out = [];
  var blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  var isAtom = blocks.length === 0;
  if (isAtom) blocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    function field(tag, attr) {
      if (attr) {
        var ma = block.match(new RegExp('<' + tag + '[^>]*\\b' + attr + '="([^"]*)"', 'i'));
        if (ma) return ma[1];
      }
      var m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      return m ? extractCdata(m[1]) : '';
    }
    var title = stripTags(field('title'));
    var link = isAtom ? field('link', 'href') : stripTags(field('link'));
    if (!link) link = stripTags(field('id'));
    var desc = stripTags(field('description') || field('summary') || field('content'));
    var pub = stripTags(field('pubDate') || field('published') || field('updated') || field('dc:date'));
    var guid = stripTags(field('guid') || field('id')) || link || title;
    var author = stripTags(field('author') || field('dc:creator') || field('name'));
    if (title || link) {
      out.push({ title: title, link: link, summary: desc, pubDate: pub, guid: guid, author: author });
    }
  }
  return out;
}

function parseDate(s) { var t = Date.parse(s); return isNaN(t) ? 0 : t; }

function _itemKey(it) { return it.guid || (it.link + '|' + it.title) || ('fallback-' + Math.random()); }

function matchKeywords(item, feedKeywords) {
  if (!feedKeywords || !feedKeywords.length) return [];
  var text = ((item.title || '') + ' ' + (item.summary || '')).toLowerCase();
  var hits = [];
  for (var i = 0; i < feedKeywords.length; i++) {
    if (feedKeywords[i] && text.indexOf(String(feedKeywords[i]).toLowerCase()) >= 0) hits.push(feedKeywords[i]);
  }
  return hits;
}

// ===== 刷新 =====

function refreshFeed(feed) {
  return new Promise(function (resolve) {
    fetchUrl(feed.url, 0, function (err, xml) {
      if (err) {
        feed.lastError = err.message;
        feed.lastFetch = Date.now();
        saveFeeds();
        resolve({ feed: feed.title || feed.url, ok: false, error: err.message, added: 0 });
        return;
      }
      var parsed = parseFeed(xml);
      var added = 0;
      var existing = {};
      for (var k = 0; k < items.length; k++) {
        existing[items[k].feedId + '::' + _itemKey(items[k])] = true;
      }
      for (var i = 0; i < parsed.length; i++) {
        var p = parsed[i];
        var key = feed.id + '::' + _itemKey(p);
        if (existing[key]) continue;
        existing[key] = true;
        items.push({
          feedId: feed.id,
          feedTitle: feed.title || feed.url,
          title: p.title,
          link: p.link,
          summary: p.summary,
          author: p.author,
          pubDate: p.pubDate,
          ts: parseDate(p.pubDate) || Date.now(),
          guid: p.guid,
          keywords: matchKeywords(p, feed.keywords)
        });
        added++;
      }
      feed.lastError = added > 0 ? '' : (parsed.length === 0 ? '无条目' : '');
      feed.lastFetch = Date.now();
      feed.itemCount = (feed.itemCount || 0) + added;
      saveFeeds();
      resolve({ feed: feed.title || feed.url, ok: true, total: parsed.length, added: added });
    });
  });
}

async function refreshAll() {
  var results = [];
  for (var i = 0; i < feeds.length; i++) {
    if (!feeds[i].enabled) continue;
    try { results.push(await refreshFeed(feeds[i])); }
    catch (e) { results.push({ feed: feeds[i].url, ok: false, error: e.message }); }
  }
  items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
  saveFeeds();
  saveItems();
  return results;
}

// ===== 订阅源 CRUD =====

function addFeed(url, opts) {
  opts = opts || {};
  var feed = {
    id: 'feed_' + Date.now().toString(36),
    url: url,
    title: opts.title || '',
    category: opts.category || '默认',
    keywords: opts.keywords || [],
    enabled: true,
    lastFetch: 0,
    lastError: '',
    itemCount: 0
  };
  feeds.push(feed);
  saveFeeds();
  _ensureSchedulerTask();
  return feed;
}

function removeFeed(id) {
  feeds = feeds.filter(function (f) { return f.id !== id; });
  items = items.filter(function (it) { return it.feedId !== id; });
  saveFeeds();
  saveItems();
  return true;
}

function listFeeds() { return feeds.slice(); }

function getItems(filter) {
  filter = filter || {};
  var out = items.slice();
  if (filter.feedId) out = out.filter(function (it) { return it.feedId === filter.feedId; });
  if (filter.keyword) {
    var kw = String(filter.keyword).toLowerCase();
    out = out.filter(function (it) { return ((it.title || '') + ' ' + (it.summary || '')).toLowerCase().indexOf(kw) >= 0; });
  }
  if (filter.limit) out = out.slice(0, filter.limit);
  return out;
}

// ===== 定时任务接入（复用 Core.scheduler）=====

function _ensureSchedulerTask() {
  if (!Core.scheduler || !Core.scheduler.registerHandler) return;
  Core.scheduler.registerHandler('rss.refresh', function () {
    refreshAll().catch(function (e) { console.error('rss-engine: 刷新失败', e.message); });
  });
  try {
    var existing = Core.scheduler.list() || [];
    var found = existing.some(function (t) { return (t.name || '').indexOf('RSS') >= 0; });
    if (!found && feeds.length > 0) {
      var task = Core.scheduler.add({
        name: 'RSS 订阅刷新',
        schedule: { type: 'interval', interval: REFRESH_INTERVAL },
        action: { type: 'custom', handler: 'rss.refresh' }
      });
      _schedulerTaskId = task.id;
    }
  } catch (e) { console.warn('rss-engine: 定时任务注册失败', e.message); }
}

// ===== 消息输出（失败静默降级，绝不崩）=====

function showMsg(text) {
  try {
    if (Core.session && Core.session.getCurrentId && Core.session.addMessage) {
      var id = Core.session.getCurrentId();
      Core.session.addMessage(text, 'assistant');
      if (Core.session.renderMessages) Core.session.renderMessages(id);
    }
  } catch (e) { console.log('[rss-engine]', text); }
}

// ===== 命令 =====

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('rss', {
    zh: 'RSS 订阅: /rss add <url> [关键词] | list | remove <id> | refresh | items [n] | search <词>',
    en: 'RSS feed aggregator'
  }, function (args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'add') {
      var url = parts[1];
      if (!url || url.indexOf('http') !== 0) {
        showMsg('⚠️ 用法: /rss add <feed-url> [关键词...]\n示例: /rss add https://hnrss.org/frontpage AI 创业');
        return;
      }
      var kws = parts.slice(2);
      var feed = addFeed(url, { keywords: kws });
      showMsg('✅ 已添加订阅源:\n**' + (feed.title || url) + '**\nID: `' + feed.id + '`\n关键词: ' + (kws.join(', ') || '无') + '\n\n正在抓取首篇...');
      refreshFeed(feed).then(function (r) {
        showMsg((r.ok ? '✅ 抓取成功，新增 ' + r.added + ' 条' : '⚠️ 抓取失败: ' + r.error) + '\n可用 `/rss items` 查看。');
      });
      return;
    }

    if (sub === 'list') {
      if (feeds.length === 0) { showMsg('📭 暂无订阅源。用 `/rss add <url>` 添加。'); return; }
      var t = '📡 **RSS 订阅源 (' + feeds.length + ')**\n\n';
      feeds.forEach(function (f, i) {
        t += (i + 1) + '. ' + (f.enabled ? '▶' : '⏸') + ' **' + (f.title || f.url) + '**\n';
        t += '   ID: `' + f.id + '` | 条目: ' + (f.itemCount || 0) + ' | ' + (f.lastError ? '⚠️ ' + f.lastError : '正常') + '\n';
        if (f.keywords && f.keywords.length) t += '   关键词: ' + f.keywords.join(', ') + '\n';
      });
      showMsg(t);
      return;
    }

    if (sub === 'remove') {
      var id = parts[1];
      if (!id) { showMsg('⚠️ 用法: /rss remove <id>'); return; }
      removeFeed(id);
      showMsg('✅ 已移除订阅源 ' + id);
      return;
    }

    if (sub === 'refresh') {
      showMsg('🔄 正在刷新所有订阅源...');
      refreshAll().then(function (res) {
        var ok = res.filter(function (r) { return r.ok; }).length;
        var add = res.reduce(function (s, r) { return s + (r.added || 0); }, 0);
        showMsg('✅ 刷新完成: ' + ok + '/' + res.length + ' 个源成功，新增 ' + add + ' 条。');
      });
      return;
    }

    if (sub === 'items') {
      var n = parseInt(parts[1]) || 10;
      var list = getItems({ limit: n });
      if (list.length === 0) { showMsg('📭 暂无文章，先 `/rss add` 并 `/rss refresh`。'); return; }
      var t2 = '📰 **最新 ' + list.length + ' 条**\n\n';
      list.forEach(function (it, i) {
        t2 += (i + 1) + '. **' + (it.title || '(无标题)') + '**\n';
        t2 += '   ' + (it.feedTitle || '') + (it.pubDate ? ' · ' + it.pubDate : '') + '\n';
        if (it.keywords && it.keywords.length) t2 += '   🔖 ' + it.keywords.join(', ') + '\n';
        t2 += '   ' + (it.link || '') + '\n';
      });
      showMsg(t2);
      return;
    }

    if (sub === 'search') {
      var q = parts.slice(1).join(' ');
      if (!q) { showMsg('⚠️ 用法: /rss search <关键词>'); return; }
      var found = getItems({ keyword: q, limit: 20 });
      if (found.length === 0) { showMsg('🔍 未找到包含 "' + q + '" 的文章。'); return; }
      var t3 = '🔍 **匹配 "' + q + '" (' + found.length + ')**\n\n';
      found.forEach(function (it, i) {
        t3 += (i + 1) + '. **' + (it.title || '') + '** — ' + (it.link || '') + '\n';
      });
      showMsg(t3);
      return;
    }

    showMsg('📡 RSS 订阅命令:\n/rss add <url> [关键词] — 添加订阅源\n/rss list — 列出订阅源\n/rss remove <id> — 移除\n/rss refresh — 刷新全部\n/rss items [n] — 查看最新 n 条（默认10）\n/rss search <词> — 搜索文章');
  });
}

// ===== 初始化（被 core-v10.js 自动调用）=====

function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
    http = require('http');
    https = require('https');
  } catch (e) {
    console.warn('rss-engine.js: 依赖不可用', e.message);
    return;
  }

  loadState();
  registerCommands();
  _ensureSchedulerTask();

  Core.rssEngine = {
    addFeed: addFeed,
    removeFeed: removeFeed,
    listFeeds: listFeeds,
    refreshAll: refreshAll,
    refreshFeed: refreshFeed,
    getItems: getItems,
    search: function (q, limit) { return getItems({ keyword: q, limit: limit || 20 }); }
  };

  console.log('✅ rss-engine.js 已加载 (' + feeds.length + ' 订阅源, ' + items.length + ' 条缓存)');
}

module.exports = {
  name: 'rss-engine',
  dependencies: ['scheduler'],
  init: init,
  // 以下供测试使用，不影响模块加载
  _parse: parseFeed,
  _strip: stripTags,
  _decode: decodeEntities
};
