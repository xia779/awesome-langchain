// tests/hud.test.js — HUD 控制器模块单元测试
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockCore } = require('./helper');

const HUD_PATH = require.resolve('../modules/hud.js');

test('hud: 暴露 Core.hud API 并中继 Agent 状态', () => {
  // 注入 fake bridge，模拟渲染进程 window.nodeBridge.ipc
  const sent = [];
  const handlers = {};
  global.window = {
    nodeBridge: {
      ipc: {
        send: (ch, payload) => sent.push({ ch, payload }),
        on: (ch, cb) => { handlers[ch] = cb; return () => {}; }
      }
    }
  };
  delete require.cache[HUD_PATH];
  const hud = require('../modules/hud.js');

  const Core = createMockCore();
  const bus = {};
  Core.on = (ev, fn) => { (bus[ev] = bus[ev] || []).push(fn); };
  Core.emit = (ev, data) => { (bus[ev] || []).forEach(fn => fn(data)); };

  hud.init(Core);

  assert.ok(Core.hud, 'Core.hud 应存在');
  ['setState', 'setProgress', 'setGauge', 'setActiveFn', 'show', 'hide', 'toggle', 'injectCommand']
    .forEach(m => assert.strictEqual(typeof Core.hud[m], 'function', 'Core.hud.' + m + ' 应为函数'));

  // typingStart → thinking
  Core.emit('typingStart');
  let relay = sent.filter(s => s.ch === 'hud-relay').pop();
  assert.ok(relay, '应发送 hud-relay');
  assert.strictEqual(relay.payload.state, 'thinking');

  // agent-tool → executing + 工具映射 + 进度仪表
  Core.emit('agent-tool', { action: 'web_search', step: 2, maxSteps: 5 });
  relay = sent.filter(s => s.ch === 'hud-relay').pop();
  assert.strictEqual(relay.payload.state, 'executing');
  assert.strictEqual(relay.payload.fn, 'search', 'web_search 应映射到 search 标签');
  assert.strictEqual(relay.payload.gauge, 40, '2/5 步应为 40%');

  // typingEnd → idle
  Core.emit('typingEnd');
  relay = sent.filter(s => s.ch === 'hud-relay').pop();
  assert.strictEqual(relay.payload.state, 'idle');

  // /hud 命令已注册
  assert.ok(Core.custom._commands['hud'], '/hud 命令应注册');

  // hud-command 注入主应用（真实路径：Core.dom.input.value + Core.api.sendMessage()）
  let sentText = null;
  Core.dom = { input: { value: '' } };
  Core.api = { sendMessage: () => { sentText = Core.dom.input.value; } };
  assert.ok(handlers['hud-command'], '应监听 hud-command');
  handlers['hud-command']({ text: '你好' });
  assert.strictEqual(sentText, '你好');

  delete global.window;
});

test('hud: Node 环境（无 window）下测试安全', () => {
  delete global.window;
  delete require.cache[HUD_PATH];
  const hud = require('../modules/hud.js');
  const Core = createMockCore();
  // mock Core 无 on/emit，init 不应抛错
  assert.doesNotThrow(() => hud.init(Core));
  assert.ok(Core.hud);
  // bridge 为 null 时调用 API 不抛错
  assert.doesNotThrow(() => Core.hud.setState('thinking'));
  assert.doesNotThrow(() => Core.hud.toggle());
  assert.strictEqual(Core.hud.state, 'thinking');
});
