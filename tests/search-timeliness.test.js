// tests/search-timeliness.test.js
// 验证 search.js 时效性增强：时效敏感查询识别、日期追加、明确日期豁免
const test = require('node:test');
const assert = require('node:assert');
const searchMod = require('../modules/search');

const { _isTimeSensitive, _augmentTimeSensitiveQuery } = searchMod;

test('时效敏感关键词被识别', () => {
  assert.strictEqual(_isTimeSensitive('今天上证指数行情'), true);
  assert.strictEqual(_isTimeSensitive('最新科技新闻'), true);
  assert.strictEqual(_isTimeSensitive('现在的金价是多少'), true);
  assert.strictEqual(_isTimeSensitive('latest AI news'), true);
});

test('非时效查询不被误判', () => {
  assert.strictEqual(_isTimeSensitive('什么是量子计算'), false);
  assert.strictEqual(_isTimeSensitive('Python 列表去重方法'), false);
  assert.strictEqual(_isTimeSensitive(''), false);
  assert.strictEqual(_isTimeSensitive(null), false);
});

test('自带明确日期的查询不再追加（豁免）', () => {
  assert.strictEqual(_isTimeSensitive('2024年中国GDP总量'), false);
  assert.strictEqual(_isTimeSensitive('2026年7月25日的发布会'), false);
  assert.strictEqual(_isTimeSensitive('2026-07-25 的赛程'), false);
});

test('时效敏感查询自动追加当前日期', () => {
  const out = _augmentTimeSensitiveQuery('今天天气怎么样');
  const now = new Date();
  const dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
  assert.ok(out.indexOf(dateStr) >= 0, '应包含当前日期: ' + out);
  assert.ok(out.indexOf('今天天气怎么样') === 0, '应保留原始查询');
});

test('非时效查询原样返回', () => {
  assert.strictEqual(_augmentTimeSensitiveQuery('什么是量子计算'), '什么是量子计算');
});

test('追加日期后不再被判定为需要追加（幂等）', () => {
  const once = _augmentTimeSensitiveQuery('最新新闻');
  const twice = _augmentTimeSensitiveQuery(once);
  assert.strictEqual(once, twice, '已含日期的查询不应重复追加');
});
