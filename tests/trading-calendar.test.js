var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

var calMod = require('../modules/trading-calendar');

function D(y, m, d, hh, mm) { return new Date(y, m - 1, d, hh || 0, mm || 0, 0); }

test('trading-calendar 模块导出', function() {
  assert.equal(calMod.name, 'trading-calendar');
  assert.deepEqual(calMod.dependencies, []);
  assert.equal(typeof calMod.init, 'function');
});

test('trading-calendar 初始化挂载 Core.tradingCal', function() {
  var Core = helper.createMockCore();
  calMod.init(Core);
  assert.equal(typeof Core.tradingCal.isTradingDay, 'function');
  assert.equal(typeof Core.tradingCal.isTradingTime, 'function');
  assert.equal(typeof Core.tradingCal.nextOpen, 'function');
  assert.equal(typeof Core.tradingCal.getStatus, 'function');
  helper.cleanTestData();
});

test('周末闭市（含调休规则：周末一律闭市）', function() {
  var Core = helper.createMockCore();
  calMod.init(Core);
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 7, 25)), false);  // 周六
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 7, 26)), false);  // 周日
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 7, 27)), true);   // 周一
  helper.cleanTestData();
});

test('法定节假日闭市：春节与国庆', function() {
  var Core = helper.createMockCore();
  calMod.init(Core);
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 2, 17)), false);  // 春节（周二）
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 2, 23)), false);  // 春节假期最后一天（周一）
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 2, 24)), true);   // 节后开市（周二）
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 10, 1)), false);  // 国庆（周四）
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 10, 8)), true);   // 节后开市（周四）
  helper.cleanTestData();
});

test('交易时段判定：边界精确到分钟', function() {
  var Core = helper.createMockCore();
  calMod.init(Core);
  var mon = function(hh, mm) { return D(2026, 7, 27, hh, mm); };      // 周一
  assert.equal(Core.tradingCal.isTradingTime(mon(9, 29)), false);
  assert.equal(Core.tradingCal.isTradingTime(mon(9, 30)), true);
  assert.equal(Core.tradingCal.isTradingTime(mon(11, 29)), true);
  assert.equal(Core.tradingCal.isTradingTime(mon(11, 30)), false);
  assert.equal(Core.tradingCal.isTradingTime(mon(12, 59)), false);
  assert.equal(Core.tradingCal.isTradingTime(mon(13, 0)), true);
  assert.equal(Core.tradingCal.isTradingTime(mon(14, 59)), true);
  assert.equal(Core.tradingCal.isTradingTime(mon(15, 0)), false);
  // 节假日盘中时间也判闭市
  assert.equal(Core.tradingCal.isTradingTime(D(2026, 10, 1, 10, 0)), false);
  helper.cleanTestData();
});

test('nextOpen 跨周末与节假日', function() {
  var Core = helper.createMockCore();
  calMod.init(Core);
  // 周五收盘后 → 下周一 9:30
  var n1 = Core.tradingCal.nextOpen(D(2026, 7, 24, 15, 30));
  assert.equal(n1.getDay(), 1);
  assert.equal(n1.getHours() * 100 + n1.getMinutes(), 930);
  // 周六 → 下周一 9:30
  var n2 = Core.tradingCal.nextOpen(D(2026, 7, 25, 10, 0));
  assert.equal(n2.getDate(), 27);
  // 盘中 → 返回当日
  var n3 = Core.tradingCal.nextOpen(D(2026, 7, 27, 10, 0));
  assert.equal(n3.getDate(), 27);
  // 午休 → 当日 13:00
  var n4 = Core.tradingCal.nextOpen(D(2026, 7, 27, 12, 0));
  assert.equal(n4.getHours() * 100 + n4.getMinutes(), 1300);
  helper.cleanTestData();
});

test('getStatus 返回相位与下一交易时点', function() {
  var Core = helper.createMockCore();
  calMod.init(Core);
  assert.equal(Core.tradingCal.getStatus(D(2026, 7, 27, 10, 0)).open, true);
  assert.equal(Core.tradingCal.getStatus(D(2026, 7, 25, 10, 0)).open, false);
  assert.ok(Core.tradingCal.getStatus(D(2026, 7, 25, 10, 0)).next instanceof Date);
  helper.cleanTestData();
});

test('支持 config.tradingHolidays 自定义节假日覆盖', function() {
  var Core = helper.createMockCore();
  Core.config.tradingHolidays = { '2026': ['2026-07-27'] };
  calMod.init(Core);
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 7, 27)), false);  // 被自定义覆盖
  assert.equal(Core.tradingCal.isTradingDay(D(2026, 7, 28)), true);
  helper.cleanTestData();
});
