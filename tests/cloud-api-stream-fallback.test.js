// tests/cloud-api-stream-fallback.test.js
// 验证 P2-3 流式本地推理兜底：
//  1) 云端 fetch 失败 + 本地推理启用 → 本地 stream 接管，按 (piece, full) 双参契约回传
//  2) 云端 fetch 失败 + 本地推理禁用 → 抛出原始错误（不改行为）
//  3) 云端正常返回 → 走原生 SSE 解析（重构回归防护）
const test = require('node:test');
const assert = require('node:assert');
const cloudApiMod = require('../modules/cloud-api');

function makeCore(overrides) {
  const core = {
    config: {
      deepseekKey: 'test-key',
      localInference: { enabled: false },
      deepseekModel: 'deepseek-v4-flash'
    },
    dom: undefined,
    recovery: undefined,
    localInference: undefined,
    // buildMessages 需要的最小桩
    session: {
      loadSessionsForService: () => ({}),
      getCurrentId: () => null
    }
  };
  if (overrides) Object.assign(core, overrides);
  return core;
}

function fakeSSEStream(texts) {
  const enc = new TextEncoder();
  let i = 0;
  const chunks = texts.map(t => 'data: {"choices":[{"delta":{"content":"' + t + '"}}]}\n\n');
  chunks.push('data: [DONE]\n\n');
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return { ok: true, body: stream, text: async () => '' };
}

test('流式：云端失败 + 本地推理启用 → 本地兜底接管并按双参回传', async () => {
  const calls = [];
  const localStream = async (prompt, systemMsg, opts, onChunk) => {
    assert.strictEqual(prompt, 'hi');
    assert.strictEqual(systemMsg, 'sys');
    onChunk('Hello');
    onChunk(' world');
    return 'Hello world';
  };
  const core = makeCore();
  core.config.localInference = { enabled: true };
  core.localInference = { stream: localStream, isEnabled: () => true };
  cloudApiMod.init(core);

  const origFetch = global.fetch;
  // 云端 fetch 直接抛错，模拟网络/鉴权故障
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const out = await core.cloudApi.callCloudAPIStream('hi', 'sys', 0.7, 'deepseek-v4-flash', 'deepseek', (piece, full) => calls.push([piece, full]), null);
    assert.strictEqual(out, 'Hello world');
    assert.deepStrictEqual(calls, [['Hello', 'Hello'], [' world', 'Hello world']]);
  } finally {
    global.fetch = origFetch;
  }
});

test('流式：云端失败 + 本地推理禁用 → 抛出原始错误（行为不变）', async () => {
  const core = makeCore({ localInference: { enabled: false } });
  cloudApiMod.init(core);
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    await assert.rejects(
      () => core.cloudApi.callCloudAPIStream('hi', 'sys', 0.7, 'deepseek-v4-flash', 'deepseek', () => {}, null),
      /network down/
    );
  } finally {
    global.fetch = origFetch;
  }
});

test('流式：云端正常返回 → 原生 SSE 解析未被破坏', async () => {
  const calls = [];
  const core = makeCore();
  cloudApiMod.init(core);
  const origFetch = global.fetch;
  global.fetch = async () => fakeSSEStream(['Hel', 'lo']);
  try {
    const out = await core.cloudApi.callCloudAPIStream('hi', 'sys', 0.7, 'deepseek-v4-flash', 'deepseek', (p, f) => calls.push([p, f]), null);
    assert.strictEqual(out, 'Hello');
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1], ['lo', 'Hello']);
  } finally {
    global.fetch = origFetch;
  }
});

// 小工具：fakeSSEStream 已在上方定义
