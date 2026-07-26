// tests/query-rewriter.test.js
// 验证 M7：Core.api.callAPI 返回 { message: { content } }，改写应据此提取文本（此前用 data.content 永远取不到）。
const test = require('node:test');
const assert = require('node:assert');
const qrMod = require('../modules/query-rewriter');

function fakeCore() {
  return {
    config: {},
    dom: { modelSelect: { value: 'gpt-4' } },
    api: {
      callAPI: async function () {
        // 🔧 真实 callAPI 返回结构：{ message: { content } }
        return { message: { content: '2024年中国GDP总量' } };
      }
    }
  };
}

test('M7: 改写能正确提取 {message:{content}} 并应用', async () => {
  const core = fakeCore();
  qrMod.init(core);
  // 含代词的追问 → needsRewrite 为真 → 走 LLM 改写
  // 🔧 模块契约：无对话历史时不调用 LLM（代词无从解析），因此测试须提供历史
  const history = [
    { role: 'user', content: '2024年中国GDP总量是多少？' },
    { role: 'assistant', content: '2024年中国GDP总量约为XX万亿元。' }
  ];
  const res = await core.queryRewriter.rewrite('它今年增长了多少？', history);
  assert.strictEqual(res.changed, true, '应判定为需要改写');
  assert.strictEqual(res.rewritten, '2024年中国GDP总量', '应从 message.content 提取改写结果');
});

test('M7: callAPI 返回 OpenAI choices 形状也能提取', async () => {
  const core = fakeCore();
  core.api.callAPI = async function () {
    return { choices: [{ message: { content: 'OpenAI形状改写' } }] };
  };
  qrMod.init(core);
  const history = [
    { role: 'user', content: '给我介绍一下这个工具' },
    { role: 'assistant', content: '这是一个查询改写工具。' }
  ];
  const res = await core.queryRewriter.rewrite('这个怎么用？', history);
  assert.strictEqual(res.rewritten, 'OpenAI形状改写');
});
