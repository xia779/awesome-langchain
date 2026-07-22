var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

var marketDbMod = require('../modules/market-db');

function makeCore() {
  var Core = helper.createMockCore();
  marketDbMod.init(Core);
  return Core;
}

test('market-db 模块导出与挂载', function() {
  var Core = makeCore();
  assert.equal(marketDbMod.name, 'market-db');
  ['addWatch', 'removeWatch', 'listWatch', 'insertSnap', 'getLastQuotes', 'upsertKline', 'getKline',
   'logAlert', 'getAlerts', 'saveReport', 'getReport', 'saveStrategy', 'listStrategies',
   'saveBacktest', 'getBacktests', 'logPatch', 'listPatches'].forEach(function(k) {
    assert.equal(typeof Core.marketDb[k], 'function', k);
  });
  helper.cleanTestData();
});

test('自选股增删查与排序', function() {
  var Core = makeCore();
  Core.marketDb.addWatch('sh600519', '贵州茅台', 2);
  Core.marketDb.addWatch('sz000001', '平安银行', 1);
  Core.marketDb.addWatch('sh600519', '贵州茅台', 0);   // 覆盖
  var list = Core.marketDb.listWatch();
  assert.equal(list.length, 2);
  assert.equal(list[0].code, 'sh600519');              // sort=0 排最前
  assert.equal(Core.marketDb.removeWatch('sz000001'), true);
  assert.equal(Core.marketDb.listWatch().length, 1);
  helper.cleanTestData();
});

test('快照写入与最后快照读取（缓存降级用）', function() {
  var Core = makeCore();
  Core.marketDb.insertSnap({ code: 'sh600519', ts: 1000, price: 1670, changePct: 0.5, vol: 9000 });
  Core.marketDb.insertSnap({ code: 'sh600519', ts: 2000, price: 1680, changePct: 0.6, vol: 10000 });
  var last = Core.marketDb.getLastQuotes(['sh600519', 'sz000001']);
  assert.equal(last.length, 1);
  assert.equal(last[0].price, 1680);
  assert.equal(last[0].ts, 2000);
  helper.cleanTestData();
});

test('日K/分钟K 写入读取与去重覆盖', function() {
  var Core = makeCore();
  var bars = [
    { date: '2026-07-20', open: 1, high: 2, low: 0.5, close: 1.5, vol: 100 },
    { date: '2026-07-21', open: 1.5, high: 2.5, low: 1, close: 2, vol: 200 },
    { date: '2026-07-21', open: 1.5, high: 2.6, low: 1, close: 2.2, vol: 210 },  // 同日覆盖
  ];
  Core.marketDb.upsertKline('day', 'sh600519', bars);
  var k = Core.marketDb.getKline('sh600519', 'day', 10);
  assert.equal(k.length, 2);
  assert.equal(k[1].close, 2.2);
  // 分钟线
  Core.marketDb.upsertKline('1m', 'sh600519', [
    { ts: 1000, open: 1, high: 1, low: 1, close: 1, vol: 10 },
    { ts: 2000, open: 2, high: 2, low: 2, close: 2, vol: 20 },
  ]);
  var m = Core.marketDb.getKline('sh600519', '1m', 10);
  assert.equal(m.length, 2);
  // 过期清理
  Core.marketDb.upsertKline('1m', 'sh600519', [{ ts: Date.now() - 40 * 86400000, open: 0, high: 0, low: 0, close: 0, vol: 0 }]);
  assert.ok(Core.marketDb.pruneMin1() >= 1);
  helper.cleanTestData();
});

test('预警日志与复盘报告', function() {
  var Core = makeCore();
  Core.marketDb.logAlert('r1', 'sh600519', '价格突破 1680', ['desktop', 'voice']);
  Core.marketDb.logAlert('r2', 'sz000001', '跌幅超 3%', ['pwa']);
  var alerts = Core.marketDb.getAlerts(10);
  assert.equal(alerts.length, 2);
  Core.marketDb.saveReport('2026-07-22', '复盘内容 v1');
  Core.marketDb.saveReport('2026-07-22', '复盘内容 v2');   // 同日覆盖
  assert.equal(Core.marketDb.getReport('2026-07-22').content, '复盘内容 v2');
  helper.cleanTestData();
});

test('策略 CRUD 与回测结果', function() {
  var Core = makeCore();
  Core.marketDb.saveStrategy('s1', 'MA5上穿MA20', { conditions: [] }, true);
  Core.marketDb.saveStrategy('s2', '停用策略', { conditions: [] }, false);
  assert.equal(Core.marketDb.listStrategies().length, 2);
  assert.equal(Core.marketDb.listStrategies(true).length, 1);
  var id = Core.marketDb.saveBacktest('s1', { from: '2025-01-01' }, { totalReturn: 0.12, winRate: 0.55 });
  assert.ok(id >= 1);
  var bts = Core.marketDb.getBacktests('s1');
  assert.equal(bts.length, 1);
  assert.ok(JSON.parse(bts[0].metrics).winRate === 0.55);
  assert.equal(Core.marketDb.deleteStrategy('s2'), true);
  helper.cleanTestData();
});

test('改码审计记录', function() {
  var Core = makeCore();
  var id = Core.marketDb.logPatch({ branch: 'agent/patch-1', files: ['modules/x.js'], diffHash: 'abc', testResult: 'pass', approver: 'admin', result: 'merged' });
  assert.ok(id >= 1);
  var list = Core.marketDb.listPatches();
  assert.equal(list.length, 1);
  assert.equal(list[0].branch, 'agent/patch-1');
  helper.cleanTestData();
});
