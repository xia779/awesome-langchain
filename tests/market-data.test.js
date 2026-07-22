var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var helper = require('./helper');

var marketDataMod = require('../modules/market-data');

// 假 stockQuote：代码解析 + 可控制的腾讯快照
function fakeStockQuote(tencentRows) {
  return {
    resolveSymbol: function(c) {
      c = String(c).trim().toLowerCase();
      if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
      if (/^\d{6}$/.test(c)) return (c[0] === '6' ? 'sh' : 'sz') + c;
      return null;
    },
    fetchQuotes: function(symbols, cb) {
      if (!tencentRows) return cb(new Error('tencent down'));
      cb(null, tencentRows);
    },
  };
}

function makeCore(opts) {
  opts = opts || {};
  var Core = helper.createMockCore();
  Core.config.pytdxAutoStart = false;                    // 测试不拉起真实 sidecar
  Core.stockQuote = fakeStockQuote(opts.tencentRows);
  var calMod = require('../modules/trading-calendar');
  calMod.init(Core);
  if (opts.pytdxPort) Core.config.pytdxPort = opts.pytdxPort;
  if (opts.pollMs) Core.config.marketPollMs = opts.pollMs;
  return Core;
}

// 起 mock sidecar，返回 { server, port, hits }
function startMockSidecar() {
  var hits = { health: 0, quote: 0, kline: 0, minute: 0 };
  var server = http.createServer(function(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') {
      hits.health++;
      res.end(JSON.stringify({ ok: true, server: 'mock:1', since: 1 }));
    } else if (req.url.indexOf('/quote') === 0) {
      hits.quote++;
      res.end(JSON.stringify({ ok: true, server: 'mock:1', data: [
        { code: 'sh600519', price: 1680.5, open: 1670, high: 1690, low: 1665, prevClose: 1670, vol: 10000, amount: 16800000 },
      ] }));
    } else if (req.url.indexOf('/kline') === 0) {
      hits.kline++;
      res.end(JSON.stringify({ ok: true, data: [
        { datetime: '2026-07-21', open: 1650, high: 1675, low: 1640, close: 1670, vol: 9000, amount: 15000000 },
        { datetime: '2026-07-22', open: 1670, high: 1690, low: 1665, close: 1680.5, vol: 10000, amount: 16800000 },
      ] }));
    } else if (req.url.indexOf('/minute') === 0) {
      hits.minute++;
      res.end(JSON.stringify({ ok: true, data: [{ price: 1680, vol: 100 }, { price: 1680.5, vol: 120 }] }));
    } else {
      res.statusCode = 404; res.end('{}');
    }
  });
  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() {
      resolve({ server: server, port: server.address().port, hits: hits });
    });
  });
}

var TENCENT_ROW = {
  name: '贵州茅台', code: '600519', price: '1681', prevClose: '1670', open: '1675',
  volume: '12000', time: '20260722150000', changePct: '0.66', amount: '2000',
};

test('market-data 模块导出与依赖', function() {
  assert.equal(marketDataMod.name, 'market-data');
  assert.ok(marketDataMod.dependencies.includes('stock-quote'));
  assert.ok(marketDataMod.dependencies.includes('trading-calendar'));
});

test('init 挂载 Core.marketData API', function() {
  var Core = makeCore({});
  marketDataMod.init(Core);
  Core.marketData._reset();
  ['getQuote', 'getKline', 'getMinute', 'getStockList', 'subscribe', 'unsubscribe', 'ensureService']
    .forEach(function(k) { assert.equal(typeof Core.marketData[k], 'function'); });
  helper.cleanTestData();
});

test('getQuote 命中 pytdx sidecar，计算涨跌幅', async function() {
  var mock = await startMockSidecar();
  try {
    var Core = makeCore({ pytdxPort: mock.port });
    marketDataMod.init(Core);
  Core.marketData._reset();
    var snaps = await Core.marketData.getQuote(['600519']);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].source, 'pytdx');
    assert.equal(snaps[0].code, 'sh600519');
    assert.equal(snaps[0].price, 1680.5);
    assert.equal(snaps[0].changePct, 0.63);      // (1680.5-1670)/1670
    assert.ok(mock.hits.health >= 1 && mock.hits.quote === 1);
  } finally { mock.server.close(); helper.cleanTestData(); }
});

test('getQuote sidecar 不可用时降级腾讯快照（结构化）', async function() {
  var Core = makeCore({ pytdxPort: 9, tencentRows: [TENCENT_ROW] });   // 端口 9 必然拒绝
  Core.config.pytdxPython = '/nonexistent/python';                      // 且不允许拉起
  marketDataMod.init(Core);
  Core.marketData._reset();
  var snaps = await Core.marketData.getQuote(['600519']);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].source, 'tencent');
  assert.equal(snaps[0].code, 'sh600519');
  assert.equal(snaps[0].name, '贵州茅台');
  assert.equal(snaps[0].amount, 20000000);       // 腾讯万元→元
  assert.equal(snaps[0].changePct, 0.66);
  helper.cleanTestData();
});

test('getQuote 双源均失败时抛出明确错误', async function() {
  var Core = makeCore({ pytdxPort: 9, tencentRows: null });
  Core.config.pytdxPython = '/nonexistent/python';
  marketDataMod.init(Core);
  Core.marketData._reset();
  await assert.rejects(Core.marketData.getQuote(['600519']), /行情不可用/);
  helper.cleanTestData();
});

test('getQuote 过滤北交所与无效代码', async function() {
  var Core = makeCore({ pytdxPort: 9, tencentRows: [TENCENT_ROW] });
  Core.config.pytdxPython = '/nonexistent/python';
  marketDataMod.init(Core);
  Core.marketData._reset();
  await assert.rejects(Core.marketData.getQuote(['bj430047', 'abc']), /无有效证券代码/);
  helper.cleanTestData();
});

test('getKline / getMinute 走 sidecar 并返回结构化数据', async function() {
  var mock = await startMockSidecar();
  try {
    var Core = makeCore({ pytdxPort: mock.port });
    marketDataMod.init(Core);
  Core.marketData._reset();
    var kline = await Core.marketData.getKline('sh600519', 'day', 2);
    assert.equal(kline.length, 2);
    assert.equal(kline[1].close, 1680.5);
    var minute = await Core.marketData.getMinute('sh600519');
    assert.equal(minute.length, 2);
    assert.equal(minute[0].price, 1680);
  } finally { mock.server.close(); helper.cleanTestData(); }
});

test('getKline sidecar 不可用时给出明确错误（腾讯无K线）', async function() {
  var Core = makeCore({ pytdxPort: 9, tencentRows: [TENCENT_ROW] });
  Core.config.pytdxPython = '/nonexistent/python';
  marketDataMod.init(Core);
  Core.marketData._reset();
  await assert.rejects(Core.marketData.getKline('sh600519', 'day', 10), /pytdx 服务/);
  helper.cleanTestData();
});

test('subscribe 轮询推送 + unsubscribe 停止', async function() {
  var mock = await startMockSidecar();
  try {
    var Core = makeCore({ pytdxPort: mock.port, pollMs: 40 });
    marketDataMod.init(Core);
  Core.marketData._reset();
    var calls = 0;
    var id = Core.marketData.subscribe(['600519'], function(snaps) {
      calls++;
      assert.equal(snaps[0].code, 'sh600519');
    }, { ignoreTradingTime: true });
    await new Promise(function(r) { setTimeout(r, 150); });
    Core.marketData.unsubscribe(id);
    var stopped = calls;
    await new Promise(function(r) { setTimeout(r, 100); });
    assert.ok(calls >= 1, '至少推送一次');
    assert.equal(calls, stopped, '退订后不再推送');
  } finally { mock.server.close(); helper.cleanTestData(); }
});
