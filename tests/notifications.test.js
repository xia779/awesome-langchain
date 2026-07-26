// tests/notifications.test.js
// 验证 M20：hookIntoEvents 的 setInterval 在重入时清理旧定时器（无泄漏），stopEventHook 可清除。
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const notificationsMod = require('../modules/notifications');

function makeEl() {
  return {
    style: {}, classList: { add() {}, remove() {} },
    setAttribute() {}, appendChild() {}, addEventListener() {},
    set innerHTML(v) {}, get innerHTML() { return ''; },
    set textContent(v) {}, get textContent() { return ''; },
    querySelectorAll: () => [],
  };
}

const _intervals = new Set();
const _origSet = global.setInterval, _origClear = global.clearInterval;

test('M20: hookIntoEvents 重入只保留一个后台轮询定时器（无泄漏）', () => {
  global.setInterval = function (fn, ms) { const id = { fn, ms }; _intervals.add(id); return id; };
  global.clearInterval = function (id) { _intervals.delete(id); };
  global.window = { addEventListener() {} };
  global.document = {
    getElementById: () => makeEl(),
    querySelector: () => null,
    createElement: () => makeEl(),
    querySelectorAll: () => [],
    head: makeEl(), body: makeEl(),
    addEventListener() {},
  };
  try {
    const core = { config: {}, DATA_ROOT: os.tmpdir(), custom: { registerCommand() {} } };
    notificationsMod.init(core);
    assert.strictEqual(_intervals.size, 1, '首次 init 应有 1 个轮询定时器');
    notificationsMod.init(core);  // 重入
    assert.strictEqual(_intervals.size, 1, '二次 init 应清理旧定时器，仍为 1 个（无泄漏）');
    notificationsMod.stopEventHook();
    assert.strictEqual(_intervals.size, 0, 'stopEventHook 应清除轮询定时器');
  } finally {
    global.setInterval = _origSet;
    global.clearInterval = _origClear;
    delete global.window;
    delete global.document;
  }
});
