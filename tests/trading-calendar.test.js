// tests/trading-calendar.test.js
// 验证 M15：调休补班日（周末上班）应开市；普通周末闭市；工作日开市。
const test = require('node:test');
const assert = require('node:assert');
const tcMod = require('../modules/trading-calendar');

function mkCore(overrides) {
  const core = { config: {} };
  if (overrides) Object.assign(core.config, overrides);
  return core;
}

// 2026-07-27 是周一（工作日，非节假日）→ 开市
// 2026-07-25 是周六 → 闭市
// 2026-07-26 是周日 → 闭市
// 把 2026-07-25（周六）设为补班日 → 应开市
test('M15: 普通工作日开市 / 普通周末闭市', () => {
  const core = mkCore();
  tcMod.init(core);
  const isTD = core.tradingCal.isTradingDay;
  assert.strictEqual(isTD(new Date(2026, 6, 27)), true, '周一应开市');
  assert.strictEqual(isTD(new Date(2026, 6, 25)), false, '周六应闭市');
  assert.strictEqual(isTD(new Date(2026, 6, 26)), false, '周日应闭市');
});

test('M15: 调休补班日（周末）应开市', () => {
  const core = mkCore({ tradingMakeupDays: { '2026': ['2026-07-25'] } });
  tcMod.init(core);
  const isTD = core.tradingCal.isTradingDay;
  assert.strictEqual(isTD(new Date(2026, 6, 25)), true, '设为补班日的周六应开市');
  // 未配置的周日仍闭市
  assert.strictEqual(isTD(new Date(2026, 6, 26)), false, '未配置的周日仍闭市');
});

test('M15: 法定节假日闭市（春节）', () => {
  const core = mkCore();
  tcMod.init(core);
  const isTD = core.tradingCal.isTradingDay;
  assert.strictEqual(isTD(new Date(2026, 1, 18)), false, '春节假期应闭市');
});
