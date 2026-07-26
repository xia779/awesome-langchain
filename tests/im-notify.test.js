// tests/im-notify.test.js - IM 触达单元测试 (P2-5)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../modules/im-notify');

function makeCore(tmpDir) {
  return {
    DATA_ROOT: tmpDir,
    config: {},
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    custom: { registerCommand: () => {} }
  };
}

test('_resolveEndpoint 各类型端点', () => {
  assert.strictEqual(mod._resolveEndpoint({ type: 'telegram', token: '123:ABC' }), 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.strictEqual(mod._resolveEndpoint({ type: 'discord', url: 'https://discord.com/api/webhooks/x' }), 'https://discord.com/api/webhooks/x');
  assert.strictEqual(mod._resolveEndpoint({ type: 'bark', token: 'key123' }), 'https://api.day.app/key123');
  assert.strictEqual(mod._resolveEndpoint({ type: 'slack', url: 'https://hooks.slack.com/x' }), 'https://hooks.slack.com/x');
});

test('_buildMessage 各类型消息体', () => {
  const tg = mod._buildMessage({ type: 'telegram', chatId: '99' }, '你好', '标题');
  assert.strictEqual(tg.chat_id, '99');
  assert.strictEqual(tg.text, '你好');
  const dc = mod._buildMessage({ type: 'discord' }, 'hi');
  assert.strictEqual(dc.content, 'hi');
  const bk = mod._buildMessage({ type: 'bark' }, 'body', '我的标题');
  assert.strictEqual(bk.title, '我的标题');
  assert.strictEqual(bk.body, 'body');
});

test('addNotifier/removeNotifier/listNotifiers', () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'im-test-')));
  mod.init(core);
  assert.ok(core.imNotify, 'Core.imNotify 应挂载');
  const n = core.imNotify.addNotifier('telegram', { token: 't', chatId: '1' });
  assert.strictEqual(core.imNotify.listNotifiers().length, 1);
  core.imNotify.removeNotifier(n.id);
  assert.strictEqual(core.imNotify.listNotifiers().length, 0);
});

test('imPush 经正确端点发送并记录送达', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'im-test2-')));
  mod.init(core);
  core.imNotify.addNotifier('discord', { url: 'https://discord.com/api/webhooks/test' });
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  const r = await core.imNotify.push('重要通知', { fetch: fetchFn });
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://discord.com/api/webhooks/test');
  assert.strictEqual(calls[0].body.content, '重要通知');
});

test('imPush 单源失败不影响其他源', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'im-test3-')));
  mod.init(core);
  core.imNotify.addNotifier('slack', { url: 'https://hooks.slack.com/ok' });
  core.imNotify.addNotifier('slack', { url: 'https://hooks.slack.com/bad' });
  const fetchFn = async (url) => {
    if (url.indexOf('bad') >= 0) throw new Error('network down');
    return { ok: true, status: 200 };
  };
  const r = await core.imNotify.push('x', { fetch: fetchFn });
  assert.strictEqual(r.sent, 1, '一个成功一个失败');
  assert.strictEqual(r.results.length, 2);
  assert.strictEqual(r.results[1].ok, false);
});

test('imPush 无可用通知返回 skipped', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'im-test4-')));
  mod.init(core);
  const r = await core.imNotify.push('x', { fetch: async () => ({ ok: true }) });
  assert.strictEqual(r.skipped, true);
});
