var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

var panelMod = require('../modules/market-panel');
var marketDbMod = require('../modules/market-db');
var calMod = require('../modules/trading-calendar');

function makeCore(quoteRows) {
  var Core = helper.createMockCore();
  Core.config.marketAutoWatch = false;      // 测试不启动订阅
  Core.stockQuote = {
    resolveSymbol: function(c) {
      c = String(c).trim().toLowerCase();
      if (/^(sh|sz)\d{6}$/.test(c)) return c;
      if (/^\d{6}$/.test(c)) return (c[0] === '6' ? 'sh' : 'sz') + c;
      return null;
    },
    searchSymbol: async function() { return null; },
  };
  Core.marketData = {
    getQuote: async function(codes) {
      return codes.map(function(c) {
        return { code: c, name: '贵州茅台', price: 1680.5, changePct: 0.63, vol: 10000, source: 'mock' };
      });
    },
    getMinute: async function() {
      return [{ price: 1670, vol: 1 }, { price: 1675, vol: 1 }, { price: 1680.5, vol: 1 }];
    },
    subscribe: function() { return 1; },
    unsubscribe: function() {},
  };
  calMod.init(Core);
  marketDbMod.init(Core);
  panelMod.init(Core);
  return Core;
}

test('market-panel 挂载 API 并注册指令', function() {
  var Core = makeCore();
  ['getBoard', 'renderBoardText', 'renderMinute', 'addWatch', 'sparkline'].forEach(function(k) {
    assert.equal(typeof Core.marketPanel[k], 'function', k);
  });
  ['/zpan', '/zadd', '/zdel', '/zlist', '/zmin'].forEach(function(cmd) {
    assert.ok(Core.custom._commands[cmd], cmd);
  });
  helper.cleanTestData();
});

test('getBoard 返回状态/自选/行情/预警结构', async function() {
  var Core = makeCore();
  Core.marketDb.addWatch('sh600519', '贵州茅台', 0);
  Core.marketDb.logAlert('r1', 'sh600519', '测试预警', ['desktop']);
  var board = await Core.marketPanel.getBoard();
  assert.ok(board.status && typeof board.status.open === 'boolean');
  assert.equal(board.watchlist.length, 1);
  assert.equal(board.quotes[0].price, 1680.5);
  assert.equal(board.alerts.length, 1);
  helper.cleanTestData();
});

test('renderBoardText 渲染行情行与预警', async function() {
  var Core = makeCore();
  Core.marketDb.addWatch('sh600519', '贵州茅台', 0);
  Core.marketDb.logAlert('r1', 'sh600519', '价格突破', ['desktop']);
  var text = await Core.marketPanel.renderBoardText();
  assert.ok(text.indexOf('盯盘面板') >= 0);
  assert.ok(text.indexOf('1680.5') >= 0);
  assert.ok(text.indexOf('+0.63%') >= 0);
  assert.ok(text.indexOf('价格突破') >= 0);
  helper.cleanTestData();
});

test('空自选股给出引导文案', async function() {
  var Core = makeCore();
  var text = await Core.marketPanel.renderBoardText();
  assert.ok(text.indexOf('/zadd') >= 0);
  helper.cleanTestData();
});

test('sparkline 输出长度受限且不抛错', function() {
  var Core = makeCore();
  var s = Core.marketPanel.sparkline([1, 2, 3, 2, 1, 5, 9, 1]);
  assert.ok(s.length > 0 && s.length <= 8);
  assert.equal(Core.marketPanel.sparkline([]), '');
  helper.cleanTestData();
});

test('renderMinute 输出最新价与高低点', async function() {
  var Core = makeCore();
  var text = await Core.marketPanel.renderMinute('sh600519');
  assert.ok(text.indexOf('1680.5') >= 0);
  assert.ok(text.indexOf('1670') >= 0);
  helper.cleanTestData();
});

test('addWatch 解析代码并写入自选股', async function() {
  var Core = makeCore();
  var msg = await Core.marketPanel.addWatch('600519');
  assert.ok(msg.indexOf('sh600519') >= 0);
  assert.equal(Core.marketDb.listWatch().length, 1);
  helper.cleanTestData();
});
