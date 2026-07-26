// tests/code-intelligence.test.js - P3 代码智能测试（code-index + diff-editor）
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// ═══ code-index 测试 ═══
const codeIndexMod = require(path.join(__dirname, '..', 'modules', 'code-index.js'));
const CoreCI = {};
codeIndexMod.init(CoreCI);
const CI = CoreCI.codeIndex;

test('extractSymbols: JS 函数和类', function() {
  var code = 'function hello() {}\nasync function fetchData() {}\nclass MyClass {}\nconst handler = function() {}';
  var symbols = CI.extractSymbols(code, '.js');
  var names = symbols.map(s => s.name);
  assert.ok(names.includes('hello'));
  assert.ok(names.includes('fetchData'));
  assert.ok(names.includes('MyClass'));
  assert.ok(names.includes('handler'));
});

test('extractSymbols: Python 函数和类', function() {
  var code = 'def process_data():\n    pass\n\nclass DataProcessor:\n    pass\n\nasync def fetch_api():\n    pass';
  var symbols = CI.extractSymbols(code, '.py');
  var names = symbols.map(s => s.name);
  assert.ok(names.includes('process_data'));
  assert.ok(names.includes('DataProcessor'));
  assert.ok(names.includes('fetch_api'));
});

test('extractSymbols: 行号正确', function() {
  var code = 'line1\nline2\nfunction target() {}\nline4';
  var symbols = CI.extractSymbols(code, '.js');
  var target = symbols.find(s => s.name === 'target');
  assert.ok(target);
  assert.strictEqual(target.line, 3);
});

test('extractSymbols: Go 函数和结构体', function() {
  var code = 'func main() {}\n\ntype Server struct {\n  Port int\n}\n\nfunc (s *Server) Start() {}';
  var symbols = CI.extractSymbols(code, '.go');
  var names = symbols.map(s => s.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('Server'));
  assert.ok(names.includes('Start'));
});

test('getStats: 无 DB 时返回零', function() {
  var stats = CI.getStats();
  assert.strictEqual(stats.files, 0);
  assert.strictEqual(stats.symbols, 0);
});

test('getFileSymbols: 读取实际文件', function() {
  var testFile = path.join(__dirname, '..', 'modules', 'context-budget.js');
  if (fs.existsSync(testFile)) {
    var symbols = CI.getFileSymbols(testFile);
    assert.ok(symbols.length > 0);
    var names = symbols.map(s => s.name);
    assert.ok(names.includes('estimateTokens') || names.includes('allocate'));
  }
});

// ═══ diff-editor 测试 ═══
const diffMod = require(path.join(__dirname, '..', 'modules', 'diff-editor.js'));
const CoreDE = {};
diffMod.init(CoreDE);
const DE = CoreDE.diffEditor;

test('parseUnifiedDiff: 解析基本 diff', function() {
  var diff = '--- a/test.js\n+++ b/test.js\n@@ -1,3 +1,4 @@\n line1\n+added\n line2\n line3';
  var parsed = DE.parseUnifiedDiff(diff);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].file, 'test.js');
  assert.strictEqual(parsed[0].hunks.length, 1);
  assert.strictEqual(parsed[0].hunks[0].changes.length, 4);
});

test('parseUnifiedDiff: 多文件 diff', function() {
  var diff = '--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,2 @@\n keep\n+extra';
  var parsed = DE.parseUnifiedDiff(diff);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].file, 'a.js');
  assert.strictEqual(parsed[1].file, 'b.js');
});

test('parseUnifiedDiff: 空输入返回空数组', function() {
  assert.deepStrictEqual(DE.parseUnifiedDiff(''), []);
  assert.deepStrictEqual(DE.parseUnifiedDiff(null), []);
});

test('applyDiff: dry-run 不修改文件', function() {
  var tmpDir = path.join(__dirname, '..', 'data', '_test_diff_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3\n');

  var diff = '--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+modified\n line3';
  var parsed = DE.parseUnifiedDiff(diff);
  var result = DE.applyDiff(parsed, tmpDir, { dryRun: true });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.results[0].status, 'ok-dry');
  // 文件未变
  assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8'), 'line1\nline2\nline3\n');
  fs.rmSync(tmpDir, { recursive: true });
});

test('applyDiff: 实际应用修改', function() {
  var tmpDir = path.join(__dirname, '..', 'data', '_test_diff2_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'line1\nline2\nline3\n');

  var diff = '--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+modified\n line3';
  var parsed = DE.parseUnifiedDiff(diff);
  var result = DE.applyDiff(parsed, tmpDir, { dryRun: false });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.results[0].status, 'applied');
  assert.ok(fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf8').includes('modified'));
  fs.rmSync(tmpDir, { recursive: true });
});

test('applyDiff: 路径逃逸被阻止', function() {
  var diff = '--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1,1 +1,1 @@\n-root\n+hacked';
  var parsed = DE.parseUnifiedDiff(diff);
  var result = DE.applyDiff(parsed, '/tmp/safe', { dryRun: false });
  assert.strictEqual(result.results[0].status, 'blocked');
});

test('reviewCode: 检测安全问题', function() {
  var code = 'var x = eval(userInput);\nvar apiKey = "sk-12345";\nelement.innerHTML = data;';
  var result = DE.reviewCode(code, 'test.js');
  assert.ok(result.issues.length >= 2);
  var categories = result.issues.map(i => i.category);
  assert.ok(categories.includes('security'));
  assert.ok(result.score < 100);
});

test('reviewCode: 干净代码高分', function() {
  var code = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };';
  var result = DE.reviewCode(code, 'clean.js');
  assert.ok(result.score >= 90);
  assert.strictEqual(result.issues.length, 0);
});

test('reviewDiff: 审查 diff 中的新增代码', function() {
  var diff = '--- a/app.js\n+++ b/app.js\n@@ -1,2 +1,4 @@\n keep\n+eval(input)\n+const secret = "password123"\n keep2';
  var result = DE.reviewDiff(diff);
  assert.ok(result.issues.length >= 1);
  assert.ok(result.files === 1);
});
