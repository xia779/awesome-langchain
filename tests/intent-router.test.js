// tests/intent-router.test.js — 指挥官意图识别测试（Wave 8）
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockCore } = require('./helper');

const MOD_PATH = require.resolve('../modules/intent-router.js');
const mod = require('../modules/intent-router.js');

// ===== 模块结构 =====
test('intent-router 模块导出', () => {
  assert.strictEqual(mod.name, 'intent-router');
  assert.ok(Array.isArray(mod.dependencies));
  assert.strictEqual(mod.dependencies.length, 0);
  assert.strictEqual(typeof mod.init, 'function');
  assert.ok(mod._internals, '应导出 _internals');
});

test('init 创建 Core.intentRouter 命名空间', () => {
  const Core = createMockCore();
  mod.init(Core);
  assert.ok(Core.intentRouter);
  ['classify', 'decompose', 'roleForIntent', 'listIntents'].forEach(m =>
    assert.strictEqual(typeof Core.intentRouter[m], 'function', m + ' 应为函数'));
});

// ===== classify：任务意图识别 =====
test('classify: 代码意图 → code_generation / code_expert', () => {
  const r = mod._internals.classify('帮我写一个快速排序的代码');
  assert.strictEqual(r.intent, 'code_generation');
  assert.strictEqual(r.role, 'code_expert');
  assert.ok(r.confidence > 0 && r.confidence <= 1);
});

test('classify: 搜索意图 → web_search / search_specialist', () => {
  const r = mod._internals.classify('搜索一下最新的 AI 新闻');
  assert.strictEqual(r.intent, 'web_search');
  assert.strictEqual(r.role, 'search_specialist');
});

test('classify: 文档意图 → document_analysis / doc_assistant', () => {
  const r = mod._internals.classify('总结这份文档的要点');
  assert.strictEqual(r.intent, 'document_analysis');
  assert.strictEqual(r.role, 'doc_assistant');
});

test('classify: 数据意图 → data_analysis / data_analyst', () => {
  const r = mod._internals.classify('分析这份销售数据并生成图表');
  assert.strictEqual(r.intent, 'data_analysis');
  assert.strictEqual(r.role, 'data_analyst');
});

// ===== classify：闲聊兜底 =====
test('classify: 问候语 → chat', () => {
  const r = mod._internals.classify('你好');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.role, null);
});

test('classify: 无任务关键词 → chat', () => {
  const r = mod._internals.classify('今天心情真不错呀');
  assert.strictEqual(r.intent, 'chat');
  assert.strictEqual(r.role, null);
});

test('classify: 空输入 → chat', () => {
  assert.strictEqual(mod._internals.classify('').intent, 'chat');
  assert.strictEqual(mod._internals.classify(null).intent, 'chat');
});

test('classify: 弱信号（单一弱关键词）不派发', () => {
  // "现在" 是 web_search 弱关键词（1.0 < THRESHOLD 1.5）
  const r = mod._internals.classify('现在几点了呀');
  assert.strictEqual(r.intent, 'chat');
});

// ===== classify：置信度 =====
test('classify: 置信度随次优意图逼近而衰减', () => {
  // code(调试2.0+代码2.0=4.0) 与 data(数据2.0+分析1.5+趋势1.5=5.0) 双强信号
  const r = mod._internals.classify('调试代码并分析数据趋势');
  assert.ok(r.intent, '应有意图');
  assert.ok(r.confidence < 0.95, '双强信号交叉时置信度应衰减（< 0.95）');
});

// ===== roleForIntent =====
test('roleForIntent 映射正确', () => {
  assert.strictEqual(mod._internals.ROLE_FOR_INTENT.code_generation, 'code_expert');
  assert.strictEqual(mod._internals.ROLE_FOR_INTENT.web_search, 'search_specialist');
  assert.strictEqual(mod._internals.ROLE_FOR_INTENT.document_analysis, 'doc_assistant');
  assert.strictEqual(mod._internals.ROLE_FOR_INTENT.data_analysis, 'data_analyst');
});

// ===== decompose：任务拆解 =====
test('decompose: 编号列表拆为多条', () => {
  const parts = mod._internals.decompose('1. 写一个爬虫\n2. 总结这份文档\n3. 分析数据');
  assert.strictEqual(parts.length, 3);
  assert.ok(parts[0].includes('爬虫'));
  assert.ok(parts[1].includes('文档'));
  assert.ok(parts[2].includes('数据'));
});

test('decompose: 换行拆分', () => {
  const parts = mod._internals.decompose('写一个排序算法\n搜索最新新闻');
  assert.strictEqual(parts.length, 2);
});

test('decompose: 单句不拆', () => {
  const parts = mod._internals.decompose('帮我写一个快速排序');
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0], '帮我写一个快速排序');
});

test('decompose: 子任务数量上限 5', () => {
  const text = '1. a任务\n2. b任务\n3. c任务\n4. d任务\n5. e任务\n6. f任务\n7. g任务';
  const parts = mod._internals.decompose(text);
  assert.ok(parts.length <= mod._internals.MAX_SUBTASKS);
});

test('decompose: 空输入返回空数组', () => {
  assert.deepStrictEqual(mod._internals.decompose(''), []);
});
