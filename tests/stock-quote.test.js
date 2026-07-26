// tests/stock-quote.test.js
// 验证 M14 修复：fetchQuotes 支持数组/逗号串入参，Promise 化（兼容 await），保留旧回调契约。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const stockQuoteMod = require('../modules/stock-quote');

const fakeCore = { custom: { registerCommand() {} } };
stockQuoteMod.init(fakeCore);
const fetchQuotes = fakeCore.stockQuote.fetchQuotes;

// 构造一条 46 字段的腾讯行情文本（ASCII，GBK 解码仍为原串，避免编解码干扰）
function fakeQuoteLine() {
  var fields = ['1', 'SSE_Composite', 'sh000001', '100.0', '99.0'];
  while (fields.length < 46) fields.push('0');
  return 'v_sh000001="' + fields.join('~') + '"';
}

// 用 EventEmitter 风格的假 res/req 驱动 http.get
function installMockHttp(onGet) {
  const orig = http.get;
  http.get = function (url, opts, cb) {
    const respCb = typeof opts === 'function' ? opts : cb;
    if (onGet) onGet(url);
    const res = { _h: {}, on(ev, fn) { this._h[ev] = fn; return this; } };
    const req = { _h: {}, on(ev, fn) { this._h[ev] = fn; return this; }, destroy() { this._destroyed = true; } };
    process.nextTick(function () {
      respCb(res);
      res._h['data'] && res._h['data'](Buffer.from(fakeQuoteLine() + ';\n', 'utf-8'));
      res._h['end'] && res._h['end']();
    });
    return req;
  };
  return function () { http.get = orig; };
}

test('M14: 逗号字符串入参被归一并请求，返回 Promise 解析出行情', async () => {
  let capturedUrl = null;
  const restore = installMockHttp(function (u) { capturedUrl = u; });
  try {
    const quotes = await fetchQuotes('sh000001,sh000002');
    assert.ok(capturedUrl && capturedUrl.indexOf('sh000001,sh000002') >= 0, '应把字符串归一为逗号拼接的 URL');
    assert.ok(Array.isArray(quotes), '应返回数组');
    assert.strictEqual(quotes[0].name, 'SSE_Composite');
  } finally {
    restore();
  }
});

test('M14: 数组入参直接可用（proactive 早报场景）', async () => {
  let capturedUrl = null;
  const restore = installMockHttp(function (u) { capturedUrl = u; });
  try {
    const quotes = await fetchQuotes(['sh000001', 'sz399001', 'sz399006']);
    assert.ok(capturedUrl && capturedUrl.indexOf('sh000001') >= 0, '应请求归一后的代码');
    assert.strictEqual(quotes[0].name, 'SSE_Composite');
  } finally {
    restore();
  }
});

test('M14: 空输入返回被拒绝的 Promise（不抛同步异常）', async () => {
  const restore = installMockHttp(function () {});
  try {
    await assert.rejects(() => fetchQuotes(''), /未提供有效标的/);
  } finally {
    restore();
  }
});

test('M14: 旧回调契约仍可用（market-data.js 场景）', async () => {
  const restore = installMockHttp(function () {});
  try {
    const result = await new Promise(function (resolve) {
      fetchQuotes(['sh000001'], function (err, quotes) {
        resolve({ err: err, quotes: quotes });
      });
    });
    assert.strictEqual(result.err, null);
    assert.strictEqual(result.quotes[0].name, 'SSE_Composite');
  } finally {
    restore();
  }
});
