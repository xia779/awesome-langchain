// tests/persona.test.js - 人格引擎测试
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const mod = require(path.join(__dirname, '..', 'modules', 'persona.js'));
const Core = { DATA_ROOT: path.join(__dirname, '..', 'data') };
mod.init(Core);
const P = Core.persona;

test('getPersona: 返回默认人格维度', function() {
  var p = P.getPersona();
  assert.ok(p.openness >= 0 && p.openness <= 100);
  assert.ok(p.agreeableness >= 0 && p.agreeableness <= 100);
  assert.ok('humor' in p);
  assert.ok('formality' in p);
});

test('setPersona: 更新人格维度并限制范围', function() {
  P.setPersona({ humor: 150, formality: -10 });
  var p = P.getPersona();
  assert.strictEqual(p.humor, 100); // 限制到 100
  assert.strictEqual(p.formality, 0); // 限制到 0
  P.resetPersona(); // 恢复
});

test('detectUserEmotion: 识别积极情绪', function() {
  assert.strictEqual(P.detectUserEmotion('哈哈太好了！'), 'happy');
  assert.strictEqual(P.detectUserEmotion('为什么会这样呢'), 'curious');
  assert.strictEqual(P.detectUserEmotion('太期待了！'), 'excited');
});

test('detectUserEmotion: 识别消极情绪', function() {
  assert.strictEqual(P.detectUserEmotion('好烦啊'), 'concerned');
  assert.strictEqual(P.detectUserEmotion('代码报错了怎么办'), 'concerned');
  assert.strictEqual(P.detectUserEmotion('帮我查一下文件'), 'neutral');
});

test('getEmotionDirective: concerned 返回共情指令', function() {
  var d = P.getEmotionDirective('concerned');
  assert.ok(d.includes('共情') || d.includes('温和') || d.includes('理解'));
});

test('getEmotionDirective: neutral 返回空', function() {
  var d = P.getEmotionDirective('neutral');
  assert.strictEqual(d, '');
});

test('getIntimacy: 初始为陌生', function() {
  var info = P.getIntimacy();
  assert.ok(info.level);
  assert.ok(info.level.name);
  assert.ok(typeof info.score === 'number');
});

test('recordInteraction: 增加亲密度', function() {
  var before = P.getIntimacy().score;
  P.recordInteraction(2);
  var after = P.getIntimacy().score;
  assert.ok(after > before);
});

test('detectUserStyle: 检测正式/随意', function() {
  P.detectUserStyle('请您帮我查看一下这个问题');
  P.detectUserStyle('麻烦你了');
  P.detectUserStyle('请帮忙看看');
  var d = P.getStyleDirective();
  // 3 条正式消息后应该有风格建议
  assert.ok(typeof d === 'string');
});

test('enhanceSystemPrompt: 注入人格基调', function() {
  var result = P.enhanceSystemPrompt('You are helpful.', '你好呀！');
  assert.ok(result.includes('You are helpful.'));
  // 应该有人格/情绪/风格相关注入
  assert.ok(result.length > 'You are helpful.'.length);
});

test('enhanceSystemPrompt: 无用户消息时仅注入基调', function() {
  var result = P.enhanceSystemPrompt('Base prompt.', null);
  assert.ok(result.includes('Base prompt.'));
});

test('applyPreset: 应用预设角色', function() {
  var r = P.applyPreset('warm-friend');
  assert.strictEqual(r.success, true);
  assert.ok(r.persona.agreeableness > 70);
  P.resetPersona();
});

test('applyPreset: 未知预设返回错误', function() {
  var r = P.applyPreset('nonexistent');
  assert.strictEqual(r.success, false);
});

test('listPresets: 返回所有预设', function() {
  var presets = P.listPresets();
  assert.ok(presets.length >= 4);
  assert.ok(presets[0].key);
  assert.ok(presets[0].name);
});

test('updateEmotion: 更新情绪状态', function() {
  P.updateEmotion('happy', 0.8);
  var state = P.getEmotionState();
  assert.strictEqual(state.current, 'happy');
  assert.ok(state.intensity > 0.7);
});
