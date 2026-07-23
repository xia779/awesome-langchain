/**
 * tests/scheduler.test.js — 定时任务引擎测试
 *
 * 覆盖: parseCronTime, parseNaturalSchedule, parseCronExpr, fieldMatches, 任务 CRUD
 * 运行: node --test tests/scheduler.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

// scheduler.js 无顶层 electron 依赖，可直接 require
// 但模块使用 exports.init 而非 module.exports = {name, dependencies, init}
var schedulerInit = require('../modules/scheduler').init;

function createSchedulerCore() {
  var Core = helper.createMockCore();
  Core.on = function() {};
  Core.emit = function() {};
  Core.showNotification = function() {};
  Core.session = {
    getCurrentId: function() { return 'sess1'; },
    addMessage: function() {},
    renderMessages: function() {},
    renderChatList: function() {}
  };
  Core.api = { sendMessage: function() { return Promise.resolve(); } };
  Core.dom = { status: { textContent: '' } };
  return Core;
}

// ===== 模块结构 =====

test('scheduler 模块导出 init 函数', function() {
  assert.equal(typeof schedulerInit, 'function');
});

test('scheduler init 挂载 Core.scheduler', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);

  assert.ok(Core.scheduler);
  assert.equal(typeof Core.scheduler.list, 'function');
  assert.equal(typeof Core.scheduler.add, 'function');
  assert.equal(typeof Core.scheduler.update, 'function');
  assert.equal(typeof Core.scheduler.delete, 'function');
  assert.equal(typeof Core.scheduler.start, 'function');
  assert.equal(typeof Core.scheduler.stop, 'function');
  assert.equal(typeof Core.scheduler.stopAll, 'function');
  assert.equal(typeof Core.scheduler.runNow, 'function');
  assert.equal(typeof Core.scheduler.parseNaturalSchedule, 'function');
  assert.equal(typeof Core.scheduler.describeSchedule, 'function');
  assert.equal(typeof Core.scheduler.tryNaturalRemind, 'function');
  assert.equal(typeof Core.scheduler.registerHandler, 'function');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

// ===== parseNaturalSchedule 测试 =====

test('parseNaturalSchedule: 每X分钟 → interval', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r1 = parse('每30分钟');
  assert.equal(r1.type, 'interval');
  assert.equal(r1.interval, '30m');

  var r2 = parse('每5分钟');
  assert.equal(r2.type, 'interval');
  assert.equal(r2.interval, '5m');

  var r3 = parse('每2小时');
  assert.equal(r3.type, 'interval');
  assert.equal(r3.interval, '2h');

  var r4 = parse('每1天');
  assert.equal(r4.type, 'interval');
  assert.equal(r4.interval, '1d');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('parseNaturalSchedule: 中文数字', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r1 = parse('每三十分钟');
  assert.equal(r1.type, 'interval');
  assert.equal(r1.interval, '30m');

  var r2 = parse('每三小时');
  assert.equal(r2.type, 'interval');
  assert.equal(r2.interval, '3h');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('parseNaturalSchedule: 每分钟/每小时（无数字）', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r1 = parse('每分钟');
  assert.equal(r1.type, 'interval');
  assert.equal(r1.interval, '1m');

  var r2 = parse('每小时');
  assert.equal(r2.type, 'interval');
  assert.equal(r2.interval, '1h');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('parseNaturalSchedule: X分钟后 → once', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r1 = parse('30分钟后');
  assert.equal(r1.type, 'once');
  assert.equal(r1.delay, '30m');

  var r2 = parse('一小时后');
  assert.equal(r2.type, 'once');
  assert.equal(r2.delay, '1h');

  var r3 = parse('半小时后');
  assert.equal(r3.type, 'once');
  assert.equal(r3.delay, '30m');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('parseNaturalSchedule: 每天+时间 → daily', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r1 = parse('每天早上9点');
  assert.equal(r1.type, 'daily');
  assert.equal(r1.time, '09:00');

  var r2 = parse('每天下午3点30分');
  assert.equal(r2.type, 'daily');
  assert.equal(r2.time, '15:30');

  var r3 = parse('每天14:30');
  assert.equal(r3.type, 'daily');
  assert.equal(r3.time, '14:30');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('parseNaturalSchedule: 无效输入返回 null', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  assert.equal(parse(null), null);
  assert.equal(parse(''), null);
  assert.equal(parse(123), null);

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

// ===== parseCronExpr 测试（通过 describeSchedule 间接验证） =====

test('scheduler describeSchedule 描述 cron 表达式', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);

  // describeSchedule 接受 schedule 对象
  var desc1 = Core.scheduler.describeSchedule({ type: 'cron', cron: '0 9 * * *' });
  assert.ok(typeof desc1 === 'string');
  assert.ok(desc1.length > 0);

  var desc2 = Core.scheduler.describeSchedule({ type: 'daily', time: '14:30' });
  assert.ok(typeof desc2 === 'string');

  var desc3 = Core.scheduler.describeSchedule({ type: 'interval', interval: '30m' });
  assert.ok(typeof desc3 === 'string');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

// ===== 任务 CRUD =====

test('scheduler 任务增删改查', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);

  // 添加任务
  var task = Core.scheduler.add({
    name: '测试任务',
    schedule: { type: 'interval', interval: '60m' },
    action: { type: 'message', text: 'hello' },
    enabled: false
  });
  assert.ok(task);
  assert.ok(task.id);
  assert.equal(task.name, '测试任务');

  // 列表包含新任务
  var list = Core.scheduler.list();
  assert.ok(list.length >= 1);
  var found = list.find(function(t) { return t.id === task.id; });
  assert.ok(found);
  assert.equal(found.name, '测试任务');

  // 更新任务（update 返回 {success, task}）
  var updateResult = Core.scheduler.update(task.id, { name: '改名任务' });
  assert.ok(updateResult);
  assert.ok(updateResult.success);
  assert.equal(updateResult.task.name, '改名任务');

  // 删除任务
  var deleted = Core.scheduler.delete(task.id);
  assert.ok(deleted);
  var afterDelete = Core.scheduler.list().find(function(t) { return t.id === task.id; });
  assert.equal(afterDelete, undefined);

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('scheduler registerHandler 注册命名处理器', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);

  var called = false;
  Core.scheduler.registerHandler('test_handler', function(params) {
    called = true;
    return 'handled: ' + (params.msg || '');
  });

  // registerHandler 不抛异常即可（handler 在任务执行时被调用）
  assert.ok(!called); // 注册时不执行

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

// ===== 边界情况 =====

test('scheduler parseNaturalSchedule 半点解析', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r1 = parse('每天9点半');
  assert.equal(r1.type, 'daily');
  assert.equal(r1.time, '09:30');

  var r2 = parse('每天下午三点半');
  assert.equal(r2.type, 'daily');
  assert.equal(r2.time, '15:30');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});

test('scheduler parseNaturalSchedule 工作日', function() {
  var Core = createSchedulerCore();
  schedulerInit(Core);
  var parse = Core.scheduler.parseNaturalSchedule;

  var r = parse('工作日9点');
  // 工作日应解析为 weekday 类型或 daily + days 限定
  assert.ok(r);
  assert.ok(r.type === 'daily' || r.type === 'weekday');

  Core.scheduler.stopAll();
  helper.cleanTestData();
});
