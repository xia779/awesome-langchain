// tests/self-evolution.test.js - 自我进化闭环单元测试 (P2-1)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../modules/self-evolution');

function makeCore(tmpDir) {
  return {
    DATA_ROOT: tmpDir,
    config: {},
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    scheduler: { list: () => [], add: () => ({ id: 't1' }), registerHandler: () => {} },
    custom: { registerCommand: () => {} }
  };
}

test('_inferType 关键词归类', () => {
  assert.strictEqual(mod._inferType('request timeout after 10s'), 'timeout');
  assert.strictEqual(mod._inferType('HTTP 429 rate limit'), 'rate_limit');
  assert.strictEqual(mod._inferType('JSON parse error'), 'parse');
  assert.strictEqual(mod._inferType('tool call failed'), 'tool_fail');
  assert.strictEqual(mod._inferType('fetch failed ECONNREFUSED'), 'network');
  assert.strictEqual(mod._inferType('something weird'), 'generic');
});

test('_analyze 按类型聚合生成提案', () => {
  const sigs = [
    { category: 'error', message: 'request timeout' },
    { category: 'error', message: 'another timeout' },
    { category: 'error', message: 'JSON parse error' }
  ];
  const props = mod._analyze(sigs);
  assert.strictEqual(props.length, 2); // timeout + parse
  const timeoutProp = props.find(p => p.type === 'timeout');
  assert.ok(timeoutProp, '应有 timeout 提案');
  assert.ok(timeoutProp.title.indexOf('2 次') >= 0, '应标注出现次数');
});

test('_analyze 空信号返回空', () => {
  assert.deepStrictEqual(mod._analyze([]), []);
});

test('record + getSignals 环形缓冲', () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'se-test-')));
  mod.init(core);
  assert.ok(core.selfEvolution, 'Core.selfEvolution 应挂载');
  core.selfEvolution.recordError('boom timeout');
  assert.strictEqual(core.selfEvolution.getSignals().length, 1);
});

test('runCycle 无信号返回 0 且不崩', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'se-test2-')));
  mod.init(core);
  const r = await core.selfEvolution.runCycle({ skipCloud: true });
  assert.strictEqual(r.generated, 0);
});

test('runCycle 离线产出提案并清空信号', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'se-test3-')));
  mod.init(core);
  core.selfEvolution.recordError('request timeout again');
  core.selfEvolution.recordError('request timeout again');
  const r = await core.selfEvolution.runCycle({ skipCloud: true });
  assert.ok(r.generated >= 1, '应生成至少 1 条提案');
  assert.strictEqual(core.selfEvolution.getSignals().length, 0, '信号应被清空避免重复');
  assert.strictEqual(core.selfEvolution.getProposals().length, r.generated);
});

test('applyProposal 标记已应用', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'se-test4-')));
  mod.init(core);
  core.selfEvolution.recordError('parse failed');
  const r = await core.selfEvolution.runCycle({ skipCloud: true });
  const id = r.proposals[0].id;
  assert.strictEqual(core.selfEvolution.applyProposal(id), true);
  const p = core.selfEvolution.getProposals().find(x => x.id === id);
  assert.strictEqual(p.status, 'applied');
});
