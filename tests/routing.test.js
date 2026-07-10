var test = require('node:test');
var assert = require('node:assert/strict');
var helper = require('./helper');

var routingMod = require('../modules/routing');

test('routing 模块导出', function() {
  assert.equal(routingMod.name, 'routing');
  assert.ok(routingMod.dependencies.includes('custom'));
  assert.equal(typeof routingMod.init, 'function');
});

test('routing 初始化挂载 Core.routing', function() {
  var Core = helper.createMockCore();
  routingMod.init(Core);
  assert.ok(Core.routing);
  assert.equal(typeof Core.routing.analyzeMessage, 'function');
  assert.equal(typeof Core.routing.register, 'function');
  assert.equal(typeof Core.routing.routeMessage, 'function');
  helper.cleanTestData();
});

test('routing register 桥接到 custom.registerCommand', function() {
  var Core = helper.createMockCore();
  routingMod.init(Core);

  var handler = function() { return 'handled'; };
  Core.routing.register('/test', handler, '测试命令');

  assert.ok(Core.custom._commands['/test']);
  assert.equal(Core.custom._commands['/test'].desc, '测试命令');
  helper.cleanTestData();
});

test('routing listAgents 返回数组', function() {
  var Core = helper.createMockCore();
  routingMod.init(Core);

  var agents = Core.routing.listAgents();
  assert.ok(Array.isArray(agents));
  helper.cleanTestData();
});

test('routing listMasterRoles 返回数组', function() {
  var Core = helper.createMockCore();
  routingMod.init(Core);

  var roles = Core.routing.listMasterRoles();
  assert.ok(Array.isArray(roles));
  helper.cleanTestData();
});
