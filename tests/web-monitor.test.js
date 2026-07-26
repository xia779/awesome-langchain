// tests/web-monitor.test.js - 网页监控单元测试 (P2-6)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../modules/web-monitor');

function makeCore(tmpDir) {
  return {
    DATA_ROOT: tmpDir,
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    scheduler: { list: () => [], add: () => ({ id: 't1' }), registerHandler: () => {} },
    custom: { registerCommand: () => {} },
    notifications: { push: () => {} }
  };
}

test('_normalize 去除脚本/样式/标签并折叠空白', () => {
  const html = '<html><head><style>x{y:z}</style><script>var a=1;</script></head><body><p>  Hello   World </p></body></html>';
  const out = mod._normalize(html);
  assert.ok(out.indexOf('Hello World') >= 0, '应保留正文');
  assert.ok(out.indexOf('var a=1') < 0, '应去除脚本');
  assert.ok(out.indexOf('x{y:z}') < 0, '应去除样式');
  assert.ok(out.indexOf('<') < 0, '应去除标签');
  assert.strictEqual(out.indexOf('  '), -1, '应折叠多余空白');
});

test('_hash 相同输入稳定、不同输入不同', () => {
  assert.strictEqual(mod._hash('abc'), mod._hash('abc'));
  assert.notStrictEqual(mod._hash('abc'), mod._hash('abd'));
});

test('addMonitor/removeMonitor/listMonitors', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
  const core = makeCore(tmp);
  mod.init(core);
  assert.ok(core.webMonitor, 'Core.webMonitor 应挂载');
  const m = core.webMonitor.addMonitor('https://example.com', { name: '示例' });
  assert.strictEqual(core.webMonitor.listMonitors().length, 1);
  core.webMonitor.removeMonitor(m.id);
  assert.strictEqual(core.webMonitor.listMonitors().length, 0);
});

test('check 首次建基线、二次变更可捕获', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test2-'));
  const core = makeCore(tmp);
  mod.init(core);
  const m = core.webMonitor.addMonitor('https://news.example/page');
  // 第一次：建立基线，无变更
  const mockFetch = async (url) => ({ ok: true, text: async () => '<p>初始内容 123</p>' });
  const r1 = await core.webMonitor.check(m, mockFetch);
  assert.strictEqual(r1.changed, false);
  // 第二次：内容变更
  const mockFetch2 = async (url) => ({ ok: true, text: async () => '<p>更新后的内容 456</p>' });
  const r2 = await core.webMonitor.check(m, mockFetch2);
  assert.strictEqual(r2.changed, true);
  assert.strictEqual(r2.changeCount, 1);
  assert.strictEqual(core.webMonitor.getChanges().length, 1);
});

test('checkAll 禁用项跳过真实网络', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test3-'));
  const core = makeCore(tmp);
  mod.init(core);
  const m = core.webMonitor.addMonitor('https://x.example');
  m.enabled = false; // 禁用，避免真实网络
  const res = await core.webMonitor.checkAll(); // 无可用 fetch（禁用项被跳过）
  assert.deepStrictEqual(res, []);
});

test('fetchText 非 200 抛错（被 check 隔离）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test4-'));
  const core = makeCore(tmp);
  mod.init(core);
  const m = core.webMonitor.addMonitor('https://err.example');
  const mockFetch = async () => ({ ok: false, status: 500, text: async () => 'err' });
  const r = await core.webMonitor.check(m, mockFetch);
  assert.ok(r.error, '应记录错误且不崩');
});
