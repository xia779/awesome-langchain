// tests/context-budget.test.js - Token 预算管理器测试
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// 加载模块
const mod = require(path.join(__dirname, '..', 'modules', 'context-budget.js'));
const Core = {};
mod.init(Core);
const CB = Core.contextBudget;

test('estimateTokens: 纯英文约 4 chars/token', function() {
  var text = 'Hello world this is a test sentence for token estimation.';
  var tokens = CB.estimateTokens(text);
  // 57 chars / 4 ≈ 14 tokens
  assert.ok(tokens >= 10 && tokens <= 20, 'Expected ~14 tokens, got ' + tokens);
});

test('estimateTokens: 纯中文约 1.5 chars/token', function() {
  var text = '你好世界这是一个测试句子用于估算分词数量';
  var tokens = CB.estimateTokens(text);
  // 20 CJK chars / 1.5 ≈ 13 tokens
  assert.ok(tokens >= 10 && tokens <= 18, 'Expected ~13 tokens, got ' + tokens);
});

test('estimateTokens: 空值返回 0', function() {
  assert.strictEqual(CB.estimateTokens(''), 0);
  assert.strictEqual(CB.estimateTokens(null), 0);
  assert.strictEqual(CB.estimateTokens(undefined), 0);
});

test('getModelContextLimit: 已知模型返回配置值', function() {
  assert.strictEqual(CB.getModelContextLimit('qwen2.5:7b'), 32768);
  assert.strictEqual(CB.getModelContextLimit('deepseek-chat'), 65536);
  assert.strictEqual(CB.getModelContextLimit('gpt-4o'), 128000);
});

test('getModelContextLimit: 未知模型返回默认值', function() {
  assert.strictEqual(CB.getModelContextLimit('unknown-model-xyz'), 32768);
  assert.strictEqual(CB.getModelContextLimit(null), 32768);
});

test('allocate: 短文本不截断', function() {
  var result = CB.allocate({
    system: 'You are helpful.',
    time: 'Now is 2026.',
    memory: 'User likes cats.',
    userMessage: 'Hello'
  }, { model: 'qwen2.5' });

  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.allocated.system, 'You are helpful.');
  assert.strictEqual(result.allocated.memory, 'User likes cats.');
  assert.ok(result.totalTokens < result.budget);
});

test('allocate: 超长文本触发截断', function() {
  var longMemory = 'A'.repeat(200000); // ~50K tokens
  var result = CB.allocate({
    system: 'System prompt',
    memory: longMemory,
    userMessage: 'Hi'
  }, { model: 'qwen2.5', maxTokens: 8000 });

  assert.strictEqual(result.truncated, true);
  assert.ok(result.stats.memory < 50000, 'Memory should be truncated');
  assert.ok(result.totalTokens <= result.budget + 100, 'Total should be near budget');
});

test('allocate: system 段优先级最高', function() {
  var result = CB.allocate({
    system: 'Important system instructions '.repeat(100),
    memory: 'Some memory',
    knowledge: 'Some knowledge',
    userMessage: 'Question'
  }, { model: 'qwen2.5', maxTokens: 4000 });

  // system 应该完整保留（在 30% 预算内）
  assert.ok(result.stats.system > 0);
  assert.ok(result.allocated.userMessage === 'Question');
});

test('truncateToTokens: 在段落边界截断', function() {
  var text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph is very long and contains many words to make the text longer than the budget allows for.';
  var truncated = CB.truncateToTokens(text, 20);
  assert.ok(truncated.length < text.length);
  assert.ok(truncated.includes('已截断'));
});

test('truncateHistory: 短历史不截断', function() {
  var msgs = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' }
  ];
  var result = CB.truncateHistory(msgs, 1000);
  assert.strictEqual(result.length, 2);
});

test('truncateHistory: 长历史保留最近消息', function() {
  var msgs = [];
  for (var i = 0; i < 50; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Message number ' + i + ' with some content to take up space in the context window.' });
  }
  var result = CB.truncateHistory(msgs, 500);
  assert.ok(result.length < 50, 'Should truncate');
  assert.ok(result.length >= 6, 'Should keep at least recent messages');
  // 最后一条应该是原始最后一条
  assert.ok(result[result.length - 1].content.includes('49'));
});

test('buildSystemPrompt: 按顺序拼接各段', function() {
  var prompt = CB.buildSystemPrompt({
    base: 'You are an AI.',
    time: 'Current time: 2026-07-27',
    memory: 'User prefers Chinese.'
  }, { model: 'qwen2.5' });

  assert.ok(prompt.includes('You are an AI.'));
  assert.ok(prompt.includes('Current time: 2026-07-27'));
  assert.ok(prompt.includes('User prefers Chinese.'));
  // 顺序：base 在 time 前面
  assert.ok(prompt.indexOf('You are an AI.') < prompt.indexOf('Current time'));
});

test('setModelLimit: 自定义模型限制', function() {
  CB.setModelLimit('my-custom-model', 16384);
  assert.strictEqual(CB.getModelContextLimit('my-custom-model'), 16384);
});

// ═══ P1-3: 滚动摘要测试 ═══

test('needsCompression: 短对话不触发', function() {
  var msgs = [];
  for (var i = 0; i < 10; i++) {
    msgs.push({ role: 'user', content: 'Short msg ' + i });
  }
  assert.strictEqual(CB.needsCompression(msgs), false);
});

test('needsCompression: 长对话触发', function() {
  var msgs = [];
  for (var i = 0; i < 50; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Message ' + i + ': ' + 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(6) });
  }
  // 50 msgs * ~180 tokens each = ~9000 tokens > 8000 threshold
  assert.strictEqual(CB.needsCompression(msgs), true);
});

test('compressHistory: 保留最近消息', async function() {
  var msgs = [];
  for (var i = 0; i < 30; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'Message ' + i + ' with content about decisions and conclusions.' });
  }
  var result = await CB.compressHistory(msgs, 'test-session-1', null);
  // 应该有 1 条摘要 + 10 条最近消息
  assert.ok(result.length <= 12, 'Should be compressed');
  assert.ok(result[0].content.includes('摘要') || result[0].content.includes('对话'));
  // 最后一条应该是原始最后一条
  assert.ok(result[result.length - 1].content.includes('29'));
});

test('compressHistory: 短历史不压缩', async function() {
  var msgs = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' }
  ];
  var result = await CB.compressHistory(msgs, 'test-session-2', null);
  assert.strictEqual(result.length, 2);
});

test('compressHistory: LLM 摘要回调', async function() {
  var msgs = [];
  for (var i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: 'Question ' + i });
  }
  var called = false;
  var result = await CB.compressHistory(msgs, 'test-session-3', async function(text) {
    called = true;
    return '这是 LLM 生成的摘要';
  });
  assert.strictEqual(called, true);
  assert.ok(result[0].content.includes('LLM 生成的摘要'));
});

test('clearSummaryCache: 清除缓存', async function() {
  var msgs = [];
  for (var i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: 'Msg ' + i });
  }
  await CB.compressHistory(msgs, 'cache-test', null);
  CB.clearSummaryCache('cache-test');
  // 再次压缩应该重新生成（不命中缓存）
  var result = await CB.compressHistory(msgs, 'cache-test', null);
  assert.ok(result.length > 0);
});
