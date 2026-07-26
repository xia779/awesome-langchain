// tests/multimodal-extract.test.js - 多模态提取单元测试 (P2-4)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../modules/multimodal-extract');

function makeCore() {
  return {
    config: {},
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    custom: { registerCommand: () => {} }
  };
}

test('_buildVisionMessages 含 image_url', () => {
  const msgs = mod._buildVisionMessages('提取文字', 'data:image/png;base64,AAAA');
  assert.strictEqual(msgs.length, 1);
  const content = msgs[0].content;
  assert.strictEqual(content[0].type, 'text');
  assert.strictEqual(content[0].text, '提取文字');
  assert.strictEqual(content[1].type, 'image_url');
  assert.strictEqual(content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('_toDataUrl 正确拼接', () => {
  const d = mod._toDataUrl(Buffer.from('hi'), 'image/png');
  assert.strictEqual(d, 'data:image/png;base64,' + Buffer.from('hi').toString('base64'));
});

test('extract 无视觉能力时回退元数据', async () => {
  const core = makeCore();
  mod.init(core);
  assert.ok(core.multimodalExtract, 'Core.multimodalExtract 应挂载');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-')), 'photo.png');
  fs.writeFileSync(tmp, Buffer.from('fake-image-bytes'));
  const r = await core.multimodalExtract.extract(tmp, '描述', { noCloud: true });
  assert.strictEqual(r.source, 'metadata');
  assert.strictEqual(r.name, 'photo.png');
  assert.ok(r.info && r.info.size === 'fake-image-bytes'.length, '应返回文件大小');
});

test('extract 经视觉模型返回文本', async () => {
  const core = makeCore();
  mod.init(core);
  const tmp = path.join(fs.mkdtemp ? fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test2-')) : os.tmpdir(), 'x.png');
  fs.writeFileSync(tmp, Buffer.from('img'));
  let captured = null;
  const fakeApi = async (prompt, sys, temp, model, provider, options) => {
    captured = options;
    return { choices: [{ message: { content: '发票金额：￥128.00' } }], model: 'vision-model' };
  };
  const r = await core.multimodalExtract.extract(tmp, '提取金额', { cloudApi: fakeApi });
  assert.strictEqual(r.source, 'vision');
  assert.strictEqual(r.text, '发票金额：￥128.00');
  // 验证透传了 vision 消息（含 image_url）
  assert.ok(captured && captured.messages, '应透传 messages');
  const imgPart = captured.messages[0].content.find(c => c.type === 'image_url');
  assert.ok(imgPart, '消息应包含 image_url');
});

test('extract URL 抓取失败返回 error 不崩', async () => {
  const core = makeCore();
  mod.init(core);
  const fetchFn = async () => ({ ok: false, status: 404 });
  const r = await core.multimodalExtract.extract('https://bad.example/x.png', '描述', { noCloud: true, fetch: fetchFn });
  assert.strictEqual(r.source, 'error');
  assert.ok(r.error);
});
