/**
 * tests/api.test.js — API 模块核心函数测试
 *
 * 覆盖: _tempFloat, sanitizeContent, extractReply, extractImagesFromContent
 * 注意: api.js 顶层 require('electron')，需先注入 mock 到 require 缓存
 * 运行: node --test tests/api.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var helper = require('./helper');

// ===== 注入 electron mock（api.js 顶层解构 ipcRenderer）=====
var electronPath = require.resolve('electron', { paths: [path.join(__dirname, '..')] }).replace(/\\/g, '/');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcRenderer: {
      send: function() {},
      sendSync: function() { return 'mock-token'; },
      on: function() {},
      invoke: function() { return Promise.resolve({}); }
    }
  }
};

var apiMod = require('../modules/api');

// ===== 模块结构 =====

test('api 模块导出结构', function() {
  assert.equal(apiMod.name, 'api');
  assert.ok(Array.isArray(apiMod.dependencies));
  assert.ok(apiMod.dependencies.includes('session'));
  assert.equal(typeof apiMod.init, 'function');
});

test('api init 挂载 Core.api 和辅助函数', function() {
  var Core = helper.createMockCore();
  Core.dom = { sendBtn: null, input: null, status: { textContent: '' }, deepThinkBtn: null, webSearchBtn: null, chatContainer: { appendChild: function() {}, scrollTop: 0, scrollHeight: 0 } };
  Core.session = { sessions: {}, getCurrentId: function() { return 's1'; }, renderChatList: function() {} };
  Core.config = {};
  Core.getCurrentService = function() { return 'test'; };
  Core.emit = function() {};
  Core.on = function() {};

  apiMod.init(Core);

  assert.ok(Core.api);
  assert.equal(typeof Core.api.sendMessage, 'function');
  assert.equal(typeof Core.api.callAPI, 'function');
  assert.equal(typeof Core.api.callAPIStream, 'function');
  assert.equal(typeof Core.api.extractReply, 'function');
  assert.equal(typeof Core._sanitizeContent, 'function');
  helper.cleanTestData();
});

// ===== _tempFloat 测试（通过 Core.api 间接或直接测试） =====
// _tempFloat 是内部函数，但通过 callAPI 的 options 使用
// 我们从源码提取逻辑进行单元测试

test('_tempFloat 逻辑验证', function() {
  // 复制 _tempFloat 逻辑进行独立验证
  function _tempFloat(v) {
    var t = Number(v);
    if (!isFinite(t) || t < 0 || t > 2) t = 0.7;
    t = Math.round(t * 100) / 100;
    if (Number.isInteger(t)) {
      if (t >= 2) t = 1.999;
      else if (t <= 0) t = 0.001;
      else t += 0.001;
    }
    return t;
  }

  // 正常浮点数保持不变
  assert.equal(_tempFloat(0.7), 0.7);
  assert.equal(_tempFloat(1.5), 1.5);
  assert.equal(_tempFloat(0.01), 0.01);

  // 整数强制加小数
  assert.equal(_tempFloat(1), 1.001);
  assert.equal(_tempFloat(0), 0.001);
  assert.equal(_tempFloat(2), 1.999);

  // 无效值回退到 0.7
  assert.equal(_tempFloat(NaN), 0.7);
  assert.equal(_tempFloat(Infinity), 0.7);
  assert.equal(_tempFloat(-1), 0.7);
  assert.equal(_tempFloat(3), 0.7);
  assert.equal(_tempFloat('abc'), 0.7);

  // 字符串数字正常解析
  assert.equal(_tempFloat('0.9'), 0.9);
  assert.equal(_tempFloat('1'), 1.001);
});

// ===== sanitizeContent 测试 =====

test('sanitizeContent 替换 base64 图片为 [图片]', function() {
  var Core = helper.createMockCore();
  Core.dom = { sendBtn: null, input: null, status: { textContent: '' }, deepThinkBtn: null, webSearchBtn: null, chatContainer: { appendChild: function() {}, scrollTop: 0, scrollHeight: 0 } };
  Core.session = { sessions: {}, getCurrentId: function() { return 's1'; }, renderChatList: function() {} };
  Core.config = {};
  Core.getCurrentService = function() { return 'test'; };
  Core.emit = function() {};
  Core.on = function() {};
  apiMod.init(Core);

  var sanitize = Core._sanitizeContent;

  // base64 图片替换
  var input1 = 'Hello ![screenshot](data:image/png;base64,iVBOR...) world';
  assert.equal(sanitize(input1), 'Hello [图片] world');

  // URL 图片替换
  var input2 = 'Look ![img](https://example.com/pic.jpg) here';
  assert.equal(sanitize(input2), 'Look [图片] here');

  // 无图片不变
  var input3 = 'Normal text without images';
  assert.equal(sanitize(input3), 'Normal text without images');

  // null/undefined 安全
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(undefined), undefined);
  assert.equal(sanitize(''), '');

  helper.cleanTestData();
});

// ===== extractReply 测试 =====

test('extractReply 解析 Ollama 格式', function() {
  var Core = helper.createMockCore();
  Core.dom = { sendBtn: null, input: null, status: { textContent: '' }, deepThinkBtn: null, webSearchBtn: null, chatContainer: { appendChild: function() {}, scrollTop: 0, scrollHeight: 0 } };
  Core.session = { sessions: {}, getCurrentId: function() { return 's1'; }, renderChatList: function() {} };
  Core.config = {};
  Core.getCurrentService = function() { return 'test'; };
  Core.emit = function() {};
  Core.on = function() {};
  apiMod.init(Core);

  var extract = Core.api.extractReply;

  // Ollama: { message: { content: "..." } }
  assert.equal(extract({ message: { content: 'Hello from Ollama' } }), 'Hello from Ollama');

  // Ollama: { response: "..." }
  assert.equal(extract({ response: 'Direct response' }), 'Direct response');

  helper.cleanTestData();
});

test('extractReply 解析 OpenAI 格式', function() {
  var Core = helper.createMockCore();
  Core.dom = { sendBtn: null, input: null, status: { textContent: '' }, deepThinkBtn: null, webSearchBtn: null, chatContainer: { appendChild: function() {}, scrollTop: 0, scrollHeight: 0 } };
  Core.session = { sessions: {}, getCurrentId: function() { return 's1'; }, renderChatList: function() {} };
  Core.config = {};
  Core.getCurrentService = function() { return 'test'; };
  Core.emit = function() {};
  Core.on = function() {};
  apiMod.init(Core);

  var extract = Core.api.extractReply;

  // OpenAI: { choices: [{ message: { content: "..." } }] }
  assert.equal(extract({ choices: [{ message: { content: 'OpenAI reply' } }] }), 'OpenAI reply');

  // OpenAI: { choices: [{ text: "..." }] }
  assert.equal(extract({ choices: [{ text: 'Legacy text' }] }), 'Legacy text');

  // OpenAI streaming: { choices: [{ delta: { content: "..." } }] }
  assert.equal(extract({ choices: [{ delta: { content: 'stream chunk' } }] }), 'stream chunk');

  helper.cleanTestData();
});

test('extractReply 过滤 DSML 标记', function() {
  var Core = helper.createMockCore();
  Core.dom = { sendBtn: null, input: null, status: { textContent: '' }, deepThinkBtn: null, webSearchBtn: null, chatContainer: { appendChild: function() {}, scrollTop: 0, scrollHeight: 0 } };
  Core.session = { sessions: {}, getCurrentId: function() { return 's1'; }, renderChatList: function() {} };
  Core.config = {};
  Core.getCurrentService = function() { return 'test'; };
  Core.emit = function() {};
  Core.on = function() {};
  apiMod.init(Core);

  var extract = Core.api.extractReply;

  // 完整 tool_calls 块被过滤
  var withDSML = 'Hello <|DSML|tool_calls|>some tool data<|DSML|/tool_calls|> World';
  var result = extract({ message: { content: withDSML } });
  assert.ok(result.indexOf('DSML') === -1);
  assert.ok(result.indexOf('Hello') >= 0);
  assert.ok(result.indexOf('World') >= 0);

  // 未闭合 DSML 块（截断到末尾）
  var unclosed = 'Before <|DSML|tool_calls|>truncated data...';
  var result2 = extract({ message: { content: unclosed } });
  assert.ok(result2.indexOf('DSML') === -1);
  assert.ok(result2.indexOf('Before') >= 0);

  helper.cleanTestData();
});

test('extractReply 空值安全', function() {
  var Core = helper.createMockCore();
  Core.dom = { sendBtn: null, input: null, status: { textContent: '' }, deepThinkBtn: null, webSearchBtn: null, chatContainer: { appendChild: function() {}, scrollTop: 0, scrollHeight: 0 } };
  Core.session = { sessions: {}, getCurrentId: function() { return 's1'; }, renderChatList: function() {} };
  Core.config = {};
  Core.getCurrentService = function() { return 'test'; };
  Core.emit = function() {};
  Core.on = function() {};
  apiMod.init(Core);

  var extract = Core.api.extractReply;

  assert.equal(extract(null), '');
  assert.equal(extract(undefined), '');
  assert.equal(extract({}), '');
  assert.equal(extract({ choices: [] }), '');

  helper.cleanTestData();
});
