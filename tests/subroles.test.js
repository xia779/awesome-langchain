// tests/subroles.test.js — 子角色注册表 + 执行器测试（Wave 8）
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockCore, cleanTestData } = require('./helper');

const mod = require('../modules/subroles.js');

function buildCore(apiImpl) {
  const Core = createMockCore();
  Core.api = { callAPI: apiImpl };
  return Core;
}

const okApi = async function (prompt, sys, temp, model, provider, messages, options) {
  return { message: { content: '子角色结果: ' + String(prompt).substring(0, 40) } };
};

// ===== 模块结构 =====
test('subroles 模块导出', () => {
  assert.strictEqual(mod.name, 'subroles');
  assert.strictEqual(mod.dependencies.length, 0);
  assert.strictEqual(typeof mod.init, 'function');
  assert.ok(mod._internals);
});

test('init 创建 Core.subroles 命名空间', () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  ['getRole', 'listRoles', 'roleForIntent', 'roleForTaskType', 'execute'].forEach(m =>
    assert.strictEqual(typeof Core.subroles[m], 'function', m + ' 应为函数'));
});

// ===== 注册表 =====
test('预设 4 个子角色且 id 正确', () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  const roles = Core.subroles.listRoles();
  assert.strictEqual(roles.length, 4);
  const ids = roles.map(r => r.id);
  ['code_expert', 'search_specialist', 'doc_assistant', 'data_analyst'].forEach(id =>
    assert.ok(ids.includes(id), '应包含 ' + id));
});

test('每个角色有 name/systemPrompt/taskTypes/tools', () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  Core.subroles.listRoles().forEach(r => {
    const full = Core.subroles.getRole(r.id);
    assert.ok(full.name, r.id + ' 缺 name');
    assert.ok(full.systemPrompt, r.id + ' 缺 systemPrompt');
    assert.ok(Array.isArray(full.taskTypes) && full.taskTypes.length > 0, r.id + ' 缺 taskTypes');
    assert.ok(Array.isArray(full.tools), r.id + ' 缺 tools');
  });
});

test('roleForTaskType 反查正确', () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  assert.strictEqual(Core.subroles.roleForTaskType('code_generation').id, 'code_expert');
  assert.strictEqual(Core.subroles.roleForTaskType('web_search').id, 'search_specialist');
  assert.strictEqual(Core.subroles.roleForTaskType('document_analysis').id, 'doc_assistant');
  assert.strictEqual(Core.subroles.roleForTaskType('data_analysis').id, 'data_analyst');
  assert.strictEqual(Core.subroles.roleForTaskType('composite'), null);
});

test('getRole 未知角色返回 null', () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  assert.strictEqual(Core.subroles.getRole('nonexistent'), null);
});

// ===== 执行器 =====
test('execute 成功返回 content/roleId/durationMs', async () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  const res = await Core.subroles.execute('code_expert', '写一个排序算法');
  assert.ok(res.content.includes('子角色结果'));
  assert.strictEqual(res.roleId, 'code_expert');
  assert.strictEqual(res.role, '代码专家');
  assert.ok(res.durationMs >= 0);
  cleanTestData();
});

test('execute 未知角色抛错', async () => {
  const Core = buildCore(okApi);
  mod.init(Core);
  await assert.rejects(() => Core.subroles.execute('ghost', 'task'), /未知子角色/);
  cleanTestData();
});

test('execute API 不可用抛错', async () => {
  const Core = createMockCore(); // 无 Core.api
  mod.init(Core);
  await assert.rejects(() => Core.subroles.execute('code_expert', 'task'), /API 模块不可用/);
  cleanTestData();
});

test('execute 空回复抛错', async () => {
  const Core = buildCore(async () => ({ message: { content: '' } }));
  mod.init(Core);
  await assert.rejects(() => Core.subroles.execute('code_expert', 'task'), /返回空内容/);
  cleanTestData();
});

test('execute 带上下文时注入背景信息', async () => {
  let captured = null;
  const Core = buildCore(async (prompt, sys, temp, model, provider, messages) => {
    captured = { prompt, messages };
    return { message: { content: 'ok' } };
  });
  mod.init(Core);
  await Core.subroles.execute('doc_assistant', '总结要点', '这是一份年度财报');
  assert.ok(captured.prompt.includes('背景信息'));
  assert.ok(captured.prompt.includes('年度财报'));
  // 独立上下文：messages 应为 system + user 两条
  assert.strictEqual(captured.messages.length, 2);
  assert.strictEqual(captured.messages[0].role, 'system');
  assert.strictEqual(captured.messages[1].role, 'user');
  cleanTestData();
});

test('execute 以 disableTools 隔离 function-calling', async () => {
  let capturedOptions = null;
  const Core = buildCore(async (prompt, sys, temp, model, provider, messages, options) => {
    capturedOptions = options;
    return { message: { content: 'ok' } };
  });
  mod.init(Core);
  await Core.subroles.execute('data_analyst', '分析数据');
  assert.ok(capturedOptions && capturedOptions.disableTools === true, '应传 disableTools:true');
  cleanTestData();
});

// ===== extractContent 兼容多种返回形状 =====
test('extractContent 兼容 message/response/choices', () => {
  const ec = mod._internals.extractContent;
  assert.strictEqual(ec({ message: { content: 'a' } }), 'a');
  assert.strictEqual(ec({ response: 'b' }), 'b');
  assert.strictEqual(ec({ choices: [{ message: { content: 'c' } }] }), 'c');
  assert.strictEqual(ec({ choices: [{ text: 'd' }] }), 'd');
  assert.strictEqual(ec(null), '');
  assert.strictEqual(ec({}), '');
});
