/**
 * tests/theme.test.js — 主题模块逻辑测试
 *
 * 覆盖模块: modules/theme.js
 * 重点测试 _isThemeRelatedChange() 和 THEME_VISUAL_KEYS
 *
 * theme.js 可被 require（无 electron 依赖），init() 需要 DOM 但我们
 * 只测试导出的纯函数 _isThemeRelatedChange，不需要初始化 DOM。
 *
 * 运行: node tests/theme.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');

var themeMod = require('../modules/theme');
var _isThemeRelatedChange = themeMod._isThemeRelatedChange;
var THEME_VISUAL_KEYS = themeMod.THEME_VISUAL_KEYS;

// ===== THEME_VISUAL_KEYS 内容验证 =====

test('THEME_VISUAL_KEYS - 包含所有预期的视觉键', function() {
  var expectedKeys = [
    'chatBackground', 'chatBubbleUser', 'chatBubbleAI',
    'sidebarColor', 'panelColor', 'accentColor', 'textColor',
    'activeTheme', 'themeMode', 'appName',
    'sidebarBg', 'panel', 'primary', 'text'
  ];
  expectedKeys.forEach(function(key) {
    assert.ok(THEME_VISUAL_KEYS[key], 'THEME_VISUAL_KEYS 应包含 ' + key);
  });
});

test('THEME_VISUAL_KEYS - 不包含非视觉键', function() {
  var nonVisualKeys = [
    'searchEngine', 'language', 'temperature', 'favorites',
    'disabledPlugins', 'mcpServers', 'apiEndpoint'
  ];
  nonVisualKeys.forEach(function(key) {
    assert.ok(!THEME_VISUAL_KEYS[key], 'THEME_VISUAL_KEYS 不应包含 ' + key);
  });
});

// ===== _isThemeRelatedChange — null / undefined → false（跳过不必要的重建）=====

test('_isThemeRelatedChange - null 返回 false（跳过不必要的消息重建）', function() {
  assert.strictEqual(_isThemeRelatedChange(null), false);
});

test('_isThemeRelatedChange - undefined 返回 false（跳过不必要的消息重建）', function() {
  assert.strictEqual(_isThemeRelatedChange(undefined), false);
});

// ===== _isThemeRelatedChange — 空对象 {} → false =====

test('_isThemeRelatedChange - 空对象 {} 返回 false（无视觉变更）', function() {
  assert.strictEqual(_isThemeRelatedChange({}), false);
});

// ===== _isThemeRelatedChange — 仅视觉键 → true =====

test('_isThemeRelatedChange - 仅含 chatBackground 返回 true', function() {
  assert.strictEqual(_isThemeRelatedChange({ chatBackground: '#ff0000' }), true);
});

test('_isThemeRelatedChange - 仅含 activeTheme 返回 true', function() {
  assert.strictEqual(_isThemeRelatedChange({ activeTheme: 'dark' }), true);
});

test('_isThemeRelatedChange - 仅含 themeMode 返回 true', function() {
  assert.strictEqual(_isThemeRelatedChange({ themeMode: 'light' }), true);
});

test('_isThemeRelatedChange - 仅含 appName 返回 true', function() {
  assert.strictEqual(_isThemeRelatedChange({ appName: 'MyApp' }), true);
});

test('_isThemeRelatedChange - 多个视觉键同时变更返回 true', function() {
  assert.strictEqual(
    _isThemeRelatedChange({ chatBackground: '#000', textColor: '#fff', accentColor: '#0f0' }),
    true
  );
});

// ===== _isThemeRelatedChange — 仅非视觉键 → false =====

test('_isThemeRelatedChange - 仅含 searchEngine 返回 false', function() {
  assert.strictEqual(_isThemeRelatedChange({ searchEngine: 'google' }), false);
});

test('_isThemeRelatedChange - 仅含 language 返回 false', function() {
  assert.strictEqual(_isThemeRelatedChange({ language: 'zh-CN' }), false);
});

test('_isThemeRelatedChange - 多个非视觉键返回 false', function() {
  assert.strictEqual(
    _isThemeRelatedChange({ searchEngine: 'bing', language: 'en', temperature: 0.7 }),
    false
  );
});

test('_isThemeRelatedChange - 仅含 disabledPlugins 返回 false', function() {
  assert.strictEqual(_isThemeRelatedChange({ disabledPlugins: ['p1'] }), false);
});

// ===== _isThemeRelatedChange — 视觉 + 非视觉混合 → true =====

test('_isThemeRelatedChange - 视觉键 + 非视觉键混合返回 true', function() {
  assert.strictEqual(
    _isThemeRelatedChange({ chatBackground: '#111', searchEngine: 'duckduckgo' }),
    true
  );
});

test('_isThemeRelatedChange - language + textColor 混合返回 true', function() {
  assert.strictEqual(
    _isThemeRelatedChange({ language: 'ja', textColor: '#333' }),
    true
  );
});

// ===== _isThemeRelatedChange — 非对象输入 → false（避免不必要的 renderMessages）=====

test('_isThemeRelatedChange - 数字类型返回 false（非对象，跳过重建）', function() {
  assert.strictEqual(_isThemeRelatedChange(42), false);
});

test('_isThemeRelatedChange - 字符串类型返回 false（非对象，跳过重建）', function() {
  assert.strictEqual(_isThemeRelatedChange('theme'), false);
});

// ===== 模块导出完整性 =====

test('theme.js 导出包含 init、toggle、applyTheme', function() {
  assert.strictEqual(typeof themeMod.init, 'function');
  assert.strictEqual(typeof themeMod.toggle, 'function');
  assert.strictEqual(typeof themeMod.applyTheme, 'function');
});

test('theme.js 导出包含 _isThemeRelatedChange 和 THEME_VISUAL_KEYS', function() {
  assert.strictEqual(typeof themeMod._isThemeRelatedChange, 'function');
  assert.strictEqual(typeof themeMod.THEME_VISUAL_KEYS, 'object');
});
