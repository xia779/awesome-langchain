// modules/trading-calendar.js - A股交易日历
// 规则：周六/周日闭市（调休上班日照旧闭市）+ 法定节假日闭市。
// 节假日数据按年维护（来源：国务院办公厅放假安排），每年 12 月提醒更新次年表。
var Core = null;

// 2026 年 A股闭市日期（YYYY-MM-DD，仅列工作日闭市日期；周末由规则覆盖）
// 元旦1.1-1.3 春节2.15-2.23 清明4.4-4.6 劳动5.1-5.5 端午6.19-6.21 中秋9.25-9.27 国庆10.1-10.7
var HOLIDAYS = {
  '2026': [
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
    '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  ],
};

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function getHolidays(year) {
  var custom = Core && Core.config && Core.config.tradingHolidays;
  if (custom && custom[String(year)]) return custom[String(year)];
  return HOLIDAYS[String(year)] || [];
}

function isTradingDay(d) {
  d = d || new Date();
  var day = d.getDay();
  if (day === 0 || day === 6) return false;               // 周末一律闭市（含调休工作日）
  return getHolidays(d.getFullYear()).indexOf(dateStr(d)) < 0;
}

function isTradingTime(d) {
  d = d || new Date();
  if (!isTradingDay(d)) return false;
  var hm = d.getHours() * 100 + d.getMinutes();
  return (hm >= 930 && hm < 1130) || (hm >= 1300 && hm < 1500);
}

// 下一个交易时段起点（从 d 之后找）
function nextOpen(d) {
  d = new Date((d || new Date()).getTime());
  for (var i = 0; i < 40; i++) {
    if (isTradingDay(d)) {
      var hm = d.getHours() * 100 + d.getMinutes();
      if (hm < 930) { d.setHours(9, 30, 0, 0); return d; }
      if (hm >= 1130 && hm < 1300) { d.setHours(13, 0, 0, 0); return d; }
      if (hm >= 930 && hm < 1500) return d;   // 当前已在盘中
    }
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return null;
}

function getStatus(d) {
  d = d || new Date();
  if (!isTradingDay(d)) return { open: false, phase: '休市（非交易日）', next: nextOpen(d) };
  var hm = d.getHours() * 100 + d.getMinutes();
  if (hm < 930) return { open: false, phase: '未开盘（9:30开盘）', next: nextOpen(d) };
  if (hm < 1130) return { open: true, phase: '交易中（上午盘）', next: d };
  if (hm < 1300) return { open: false, phase: '午间休市（13:00继续）', next: nextOpen(d) };
  if (hm < 1500) return { open: true, phase: '交易中（下午盘）', next: d };
  return { open: false, phase: '已收盘（15:00收盘）', next: nextOpen(d) };
}

// 12 月提醒更新次年节假日表（每年一次）
function checkYearlyReminder() {
  var now = new Date();
  if (now.getMonth() !== 11) return;
  var nextYear = now.getFullYear() + 1;
  var key = 'tradingCalReminder' + nextYear;
  if (Core.config && Core.config[key]) return;
  if (!HOLIDAYS[String(nextYear)]) {
    Core.showNotification && Core.showNotification(
      '交易日历提醒', '请在设置中为 trading-calendar 配置 ' + nextYear + ' 年 A 股节假日（config.tradingHolidays）');
    Core.saveConfig && Core.saveConfig({ [key]: true });
  }
}

module.exports = {
  name: 'trading-calendar',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    Core.tradingCal = {
      isTradingDay: isTradingDay,
      isTradingTime: isTradingTime,
      nextOpen: nextOpen,
      getStatus: getStatus,
    };
    checkYearlyReminder();
    console.log('trading-calendar 模块已加载（2026 节假日表，' + HOLIDAYS['2026'].length + ' 个工作日闭市日）');
  },
};
