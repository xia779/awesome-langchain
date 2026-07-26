// tests/local-inference.test.js - 本地推理兜底客户端单元测试 (P2-3)
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../modules/local-inference');

// 构造一个开启本地推理的 fakeCore
function makeCore(extra) {
  return Object.assign({
    config: { localInference: { enabled: true, baseURL: 'http://local.test/v1', apiKey: 'x', model: 'test-model' } }
  }, extra || {});
}

// 收集请求并返回受控的响应
function mockFetch(handler) {
  return async function (url, opts) {
    return handler(url, opts);
  };
}

test('_buildMessages 拼装 system+user', () => {
  const m = mod._buildMessages('你好', '你是助手');
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].role, 'system');
  assert.strictEqual(m[1].role, 'user');
  assert.strictEqual(m[1].content, '你好');
});

test('_buildBody 默认非流式', () => {
  const b = mod._buildBody('m1', [{ role: 'user', content: 'x' }], {});
  assert.strictEqual(b.model, 'm1');
  assert.strictEqual(b.stream, false);
  assert.strictEqual(b.temperature, 0.7);
  assert.strictEqual(b.max_tokens, 4096);
});

test('_parseCompletion 提取 content', () => {
  const r = mod._parseCompletion({ choices: [{ message: { content: '回答' } }], model: 'm' });
  assert.strictEqual(r.content, '回答');
  assert.strictEqual(r.model, 'm');
});

test('_parseStreamLine 解析 SSE data 行', () => {
  assert.strictEqual(mod._parseStreamLine('data: {"choices":[{"delta":{"content":"你好"}}]}'), '你好');
  assert.strictEqual(mod._parseStreamLine('data: [DONE]'), null);
  assert.strictEqual(mod._parseStreamLine(': keep-alive'), null);
});

test('complete 发送正确请求体并解析回复', async () => {
  let captured = null;
  const fetchFn = mockFetch(async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '本地回复' } }], model: 'test-model' })
    };
  });
  const core = makeCore();
  mod.init(core);
  const res = await core.localInference.complete('提示', '系统', { fetch: fetchFn, temperature: 0.3 });
  assert.strictEqual(res.content, '本地回复');
  assert.ok(captured.url.endsWith('/chat/completions'), '应请求 /chat/completions');
  assert.strictEqual(captured.opts.method, 'POST');
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.model, 'test-model');
  assert.strictEqual(body.temperature, 0.3);
  assert.strictEqual(body.stream, false);
});

test('listModels 解析模型列表', async () => {
  const fetchFn = mockFetch(async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'qwen2.5:latest' }, { id: 'llama3' }] })
  }));
  const core = makeCore();
  mod.init(core);
  const list = await core.localInference.listModels(fetchFn);
  assert.deepStrictEqual(list, ['qwen2.5:latest', 'llama3']);
});

test('未启用时 complete 直接抛错（不改变默认行为）', async () => {
  const core = makeCore({ config: { localInference: { enabled: false } } });
  mod.init(core);
  await assert.rejects(() => core.localInference.complete('x', 'y', { fetch: mockFetch(async () => ({})) }));
});
