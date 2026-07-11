/**
 * tests/html-utils.test.js — HTML 转义工具测试
 *
 * 覆盖模块: modules/html-utils.js
 * 纯函数，无需 DOM，直接 Node.js 测试
 *
 * 运行: node tests/html-utils.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');

var htmlUtils = require('../modules/html-utils');
var escapeHtml = htmlUtils.escapeHtml;
var escapeAndTruncate = htmlUtils.escapeAndTruncate;

// ===== escapeHtml — 5 种特殊字符转义 =====

test('escapeHtml - 转义 & 为 &amp;', function() {
  assert.strictEqual(escapeHtml('a&b'), 'a&amp;b');
});

test('escapeHtml - 转义 < 为 &lt;', function() {
  assert.strictEqual(escapeHtml('<div>'), '&lt;div&gt;');
});

test('escapeHtml - 转义 > 为 &gt;', function() {
  assert.strictEqual(escapeHtml('a>b'), 'a&gt;b');
});

test('escapeHtml - 转义 " 为 &quot;', function() {
  assert.strictEqual(escapeHtml('a"b'), 'a&quot;b');
});

test('escapeHtml - 转义 \' 为 &#39;', function() {
  assert.strictEqual(escapeHtml("a'b"), 'a&#39;b');
});

test('escapeHtml - 同时转义所有 5 种特殊字符', function() {
  assert.strictEqual(
    escapeHtml('&<>"\''),
    '&amp;&lt;&gt;&quot;&#39;'
  );
});

test('escapeHtml - 普通文本不变', function() {
  assert.strictEqual(escapeHtml('hello world'), 'hello world');
});

test('escapeHtml - 空字符串返回空字符串', function() {
  assert.strictEqual(escapeHtml(''), '');
});

// ===== escapeHtml — null / undefined 返回空字符串 =====

test('escapeHtml - null 返回空字符串', function() {
  assert.strictEqual(escapeHtml(null), '');
});

test('escapeHtml - undefined 返回空字符串', function() {
  assert.strictEqual(escapeHtml(undefined), '');
});

// ===== escapeAndTruncate — 默认 maxLen (200) =====

test('escapeAndTruncate - 默认 maxLen 200，短文本不截断', function() {
  var short = 'Hello';
  assert.strictEqual(escapeAndTruncate(short), 'Hello');
});

test('escapeAndTruncate - 默认 maxLen 200，恰好 200 字符不截断', function() {
  var exact = 'a'.repeat(200);
  assert.strictEqual(escapeAndTruncate(exact), exact);
});

test('escapeAndTruncate - 默认 maxLen 200，超过 200 字符截断并加 ...', function() {
  var long = 'x'.repeat(250);
  var result = escapeAndTruncate(long);
  // 截断后: 200 chars + "..." => 转义后仍是 200 个 x + "..."
  assert.strictEqual(result, 'x'.repeat(200) + '...');
  assert.strictEqual(result.length, 203);
});

// ===== escapeAndTruncate — 自定义 maxLen =====

test('escapeAndTruncate - 自定义 maxLen=10，短文本不截断', function() {
  assert.strictEqual(escapeAndTruncate('hello', 10), 'hello');
});

test('escapeAndTruncate - 自定义 maxLen=5，超过截断加 ...', function() {
  var result = escapeAndTruncate('abcdefghij', 5);
  assert.strictEqual(result, 'abcde...');
});

test('escapeAndTruncate - 自定义 maxLen=1', function() {
  var result = escapeAndTruncate('abc', 1);
  assert.strictEqual(result, 'a...');
});

// ===== escapeAndTruncate — 截断 + 转义组合 =====

test('escapeAndTruncate - 截断后内容含特殊字符也正确转义', function() {
  // 前 5 字符是 "<div>" => 截断到 "<div>" => 拼接 "..." => "<div>..."
  // => escapeHtml => "&lt;div&gt;..."
  var input = '<div>some long content here</div>';
  var result = escapeAndTruncate(input, 5);
  assert.strictEqual(result, '&lt;div&gt;...');
});

test('escapeAndTruncate - 短文本含特殊字符正确转义不截断', function() {
  assert.strictEqual(escapeAndTruncate('<b>hi</b>'), '&lt;b&gt;hi&lt;/b&gt;');
});

// ===== escapeAndTruncate — null / undefined 返回空字符串 =====

test('escapeAndTruncate - null 返回空字符串', function() {
  assert.strictEqual(escapeAndTruncate(null), '');
});

test('escapeAndTruncate - undefined 返回空字符串', function() {
  assert.strictEqual(escapeAndTruncate(undefined), '');
});

// ===== escapeAndTruncate — 数字/布尔值转换为字符串 =====

test('escapeAndTruncate - 数字转换为字符串', function() {
  assert.strictEqual(escapeAndTruncate(12345), '12345');
});

test('escapeAndTruncate - 布尔值 true 转换为字符串', function() {
  assert.strictEqual(escapeAndTruncate(true), 'true');
});

// 注意：模块使用 (s || '').toString()，falsy 值（false, 0）会被当作空字符串
// 这是模块的设计行为——与 escapeHtml(null/undefined) 返回 '' 保持一致

test('escapeAndTruncate - 布尔值 false 视为空字符串（falsy 行为）', function() {
  assert.strictEqual(escapeAndTruncate(false), '');
});

test('escapeAndTruncate - 数字 0 视为空字符串（falsy 行为）', function() {
  assert.strictEqual(escapeAndTruncate(0), '');
});

// ===== 模块元信息 =====

test('模块导出 name 和 dependencies', function() {
  assert.strictEqual(htmlUtils.name, 'html-utils');
  assert.deepStrictEqual(htmlUtils.dependencies, []);
});
