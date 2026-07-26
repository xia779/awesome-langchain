/**
 * tests/key-protection.test.js — B2 API Key 保护回归测试
 *
 * 验证三件事：
 * 1. 敏感字段单一真相源 SENSITIVE_KEY_FIELDS 覆盖代码中真实使用的全部密钥字段（无遗漏）。
 * 2. encryptSensitiveFields 对全部字段加密存储、可解密还原（静态不落明文）。
 * 3. main.js / backup.js 的备份脱敏统一引用 crypto-utils，不再各自硬编码脱节列表。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var cu = require(path.join(ROOT, 'modules', 'crypto-utils.js'));

// 从源码中枚举真实使用的 Core.config.*Key 字段
function enumerateRealKeyFields() {
  var fields = new Set();
  var dir = path.join(ROOT, 'modules');
  fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); }).forEach(function (f) {
    var src = fs.readFileSync(path.join(dir, f), 'utf8');
    var re = /Core\.config\.([a-zA-Z]*[Kk]ey[a-zA-Z]*)/g;
    var m;
    while ((m = re.exec(src)) !== null) fields.add(m[1]);
  });
  return fields;
}

test('SENSITIVE_KEY_FIELDS 覆盖全部真实密钥字段（无遗漏）', function () {
  var real = enumerateRealKeyFields();
  var covered = new Set(cu.SENSITIVE_KEY_FIELDS);
  var missing = [];
  real.forEach(function (f) { if (!covered.has(f)) missing.push(f); });
  assert.deepStrictEqual(missing, [], '以下真实密钥字段未纳入加密/脱敏: ' + missing.join(', '));
});

test('SENSITIVE_KEY_FIELDS 含新增的 bingSearchKey / unsplashKey', function () {
  assert.ok(cu.SENSITIVE_KEY_FIELDS.indexOf('bingSearchKey') >= 0);
  assert.ok(cu.SENSITIVE_KEY_FIELDS.indexOf('unsplashKey') >= 0);
});

test('encryptSensitiveFields 对全部字段加密且可解密还原', function () {
  var config = {};
  cu.SENSITIVE_KEY_FIELDS.forEach(function (f, i) {
    config[f] = 'sk-test-secret-value-' + i + '-abcdefgh';
  });
  config.temperature = 0.7; // 非敏感字段不应被加密

  var encrypted = cu.encryptSensitiveFields(config);

  // 非敏感字段保持原样
  assert.strictEqual(encrypted.temperature, 0.7);

  cu.SENSITIVE_KEY_FIELDS.forEach(function (f) {
    // 静态存储必须是密文（enc: 前缀），不能是明文
    assert.ok(cu.isEncryptedValue(encrypted[f]), f + ' 未加密，仍为明文: ' + encrypted[f]);
    assert.notStrictEqual(encrypted[f], config[f], f + ' 加密后不应等于明文');
    // 可解密还原
    assert.strictEqual(cu.decryptValue(encrypted[f]), config[f], f + ' 解密还原失败');
  });
});

test('已加密的值不会被二次加密', function () {
  var config = { deepseekKey: 'sk-original-1234567890' };
  var once = cu.encryptSensitiveFields(config);
  var twice = cu.encryptSensitiveFields(once);
  assert.strictEqual(twice.deepseekKey, once.deepseekKey, '重复加密应保持密文不变');
});

test('main.js 备份脱敏引用 crypto-utils 单一真相源', function () {
  var src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(src.indexOf("require('./modules/crypto-utils').SENSITIVE_KEY_FIELDS") >= 0,
    'main.js 应引用 crypto-utils.SENSITIVE_KEY_FIELDS');
});

test('backup.js 导出脱敏引用 crypto-utils 单一真相源', function () {
  var src = fs.readFileSync(path.join(ROOT, 'modules', 'backup.js'), 'utf8');
  assert.ok(src.indexOf("require('./crypto-utils').SENSITIVE_KEY_FIELDS") >= 0,
    'backup.js 应引用 crypto-utils.SENSITIVE_KEY_FIELDS');
  // 旧的错误字段名不应再出现
  assert.ok(src.indexOf('googleCx') < 0, 'backup.js 不应再含错误字段 googleCx');
  assert.ok(src.indexOf('searxngApiKey') < 0, 'backup.js 不应再含错误字段 searxngApiKey');
});
