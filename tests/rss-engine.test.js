// tests/rss-engine.test.js - RSS 订阅引擎单元测试 (P2-2)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../modules/rss-engine');

const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>测试标题</title><link>https://example.com/1</link><description><![CDATA[<p>摘要内容</p>]]></description><pubDate>Mon, 22 Jul 2024 10:00:00 GMT</pubDate><guid>g1</guid></item>
  <item><title>第二条</title><link>https://example.com/2</link><description>纯文本摘要</description><pubDate>Tue, 23 Jul 2024 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom标题</title><link href="https://a.com/p1"/><summary>摘要A</summary><updated>2024-07-22T10:00:00Z</updated><id>aid1</id></entry>
</feed>`;

const ESC_XML = `<rss><channel><item><title>&lt;b&gt;粗体&lt;/b&gt; 标题</title><link>http://x/1</link><description>带 &amp; 符号 &lt;tag&gt;文本</description></item></channel></rss>`;

test('parseFeed 解析 RSS 2.0', () => {
  const out = mod._parse(RSS_XML);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].title, '测试标题');
  assert.strictEqual(out[0].link, 'https://example.com/1');
  assert.strictEqual(out[0].summary, '摘要内容'); // CDATA + stripTags
  assert.strictEqual(out[1].link, 'https://example.com/2');
});

test('parseFeed 解析 Atom', () => {
  const out = mod._parse(ATOM_XML);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'Atom标题');
  assert.strictEqual(out[0].link, 'https://a.com/p1'); // Atom link href
  assert.strictEqual(out[0].summary, '摘要A');
});

test('parseFeed 处理实体与标签剥离', () => {
  const out = mod._parse(ESC_XML);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, '粗体 标题');
  assert.strictEqual(out[0].summary, '带 & 符号 文本');
});

test('rssEngine CRUD + 空刷新不崩', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-test-'));
  const fakeCore = {
    DATA_ROOT: tmpDir,
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    scheduler: { list: () => [], add: () => ({ id: 'task1' }), registerHandler: () => {} },
    custom: { registerCommand: () => {} }
  };
  mod.init(fakeCore);

  assert.ok(fakeCore.rssEngine, 'Core.rssEngine 应被挂载');
  const f = fakeCore.rssEngine.addFeed('https://example.com/feed.xml', { keywords: ['AI'] });
  assert.strictEqual(fakeCore.rssEngine.listFeeds().length, 1);

  // 禁用源避免真实网络，验证 refreshAll 空源安全返回 []
  f.enabled = false;
  const res = await fakeCore.rssEngine.refreshAll();
  assert.ok(Array.isArray(res));
  assert.deepStrictEqual(res, []);

  fakeCore.rssEngine.removeFeed(f.id);
  assert.strictEqual(fakeCore.rssEngine.listFeeds().length, 0);
});

test('持久化：addFeed 写入 DATA_ROOT 文件', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-test2-'));
  const fakeCore = {
    DATA_ROOT: tmpDir,
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    scheduler: { list: () => [], add: () => ({ id: 'task1' }), registerHandler: () => {} },
    custom: { registerCommand: () => {} }
  };
  mod.init(fakeCore);
  const f = fakeCore.rssEngine.addFeed('https://persist.example/feed.xml');
  const file = path.join(tmpDir, 'rss-feeds.json');
  assert.ok(fs.existsSync(file), '应生成 rss-feeds.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].url, 'https://persist.example/feed.xml');
  fakeCore.rssEngine.removeFeed(f.id);
});
