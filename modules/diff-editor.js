// modules/diff-editor.js - Diff 编辑闭环（P3-3）+ 代码审查（P3-7）
// unified diff 解析/应用 + dry-run + 回滚 + /review 命令
(function() {
  'use strict';

  var Core = null;
  var fs = require('fs');
  var path = require('path');

  // ═══════════════════════════════════════════
  // 1. Unified Diff 解析
  // ═══════════════════════════════════════════

  /**
   * parseUnifiedDiff - 解析 unified diff 文本为结构化数据
   * @returns {Array} [{file, hunks: [{oldStart, oldLines, newStart, newLines, changes: [{type, content}]}]}]
   */
  function parseUnifiedDiff(diffText) {
    if (!diffText || typeof diffText !== 'string') return [];
    var files = [];
    var currentFile = null;
    var currentHunk = null;
    var lines = diffText.split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 文件头
      var fileMatch = line.match(/^\+\+\+ [ab]\/(.+)$/);
      if (fileMatch) {
        currentFile = { file: fileMatch[1], hunks: [] };
        files.push(currentFile);
        currentHunk = null;
        continue;
      }
      if (line.match(/^--- /)) continue;

      // Hunk 头
      var hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch && currentFile) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1]),
          oldLines: parseInt(hunkMatch[2] || '1'),
          newStart: parseInt(hunkMatch[3]),
          newLines: parseInt(hunkMatch[4] || '1'),
          changes: []
        };
        currentFile.hunks.push(currentHunk);
        continue;
      }

      // 变更行
      if (currentHunk) {
        if (line.startsWith('+')) {
          currentHunk.changes.push({ type: 'add', content: line.substring(1) });
        } else if (line.startsWith('-')) {
          currentHunk.changes.push({ type: 'del', content: line.substring(1) });
        } else if (line.startsWith(' ') || line === '') {
          currentHunk.changes.push({ type: 'ctx', content: line.substring(1) });
        }
      }
    }
    return files;
  }

  // ═══════════════════════════════════════════
  // 2. Diff 应用（dry-run + 实际）
  // ═══════════════════════════════════════════

  /**
   * applyDiff - 将解析后的 diff 应用到文件
   * @param {Array} parsedDiff - parseUnifiedDiff 的输出
   * @param {string} baseDir - 项目根目录
   * @param {Object} options - { dryRun: bool }
   * @returns {Object} { success, results: [{file, status, error}] }
   */
  function applyDiff(parsedDiff, baseDir, options) {
    var opts = options || {};
    var results = [];

    for (var i = 0; i < parsedDiff.length; i++) {
      var entry = parsedDiff[i];
      var filePath = path.resolve(baseDir, entry.file);

      // 安全检查：不允许逃出 baseDir
      if (!filePath.startsWith(path.resolve(baseDir))) {
        results.push({ file: entry.file, status: 'blocked', error: '路径逃逸' });
        continue;
      }

      try {
        var original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        var modified = _applyHunks(original, entry.hunks);

        if (modified === null) {
          results.push({ file: entry.file, status: 'conflict', error: '上下文不匹配' });
          continue;
        }

        if (!opts.dryRun) {
          // 备份（复用 file-checkpoint 如果可用）
          if (Core.fileCheckpoint && Core.fileCheckpoint.save) {
            Core.fileCheckpoint.save(filePath, original);
          }
          fs.writeFileSync(filePath, modified, 'utf8');
        }

        results.push({ file: entry.file, status: opts.dryRun ? 'ok-dry' : 'applied' });
      } catch (e) {
        results.push({ file: entry.file, status: 'error', error: e.message });
      }
    }

    var allOk = results.every(function(r) { return r.status.startsWith('ok') || r.status === 'applied'; });
    return { success: allOk, results: results };
  }

  function _applyHunks(original, hunks) {
    var lines = original.split('\n');
    var offset = 0;

    for (var h = 0; h < hunks.length; h++) {
      var hunk = hunks[h];
      var startIdx = hunk.oldStart - 1 + offset;

      // 验证上下文
      var ctxIdx = 0;
      for (var c = 0; c < hunk.changes.length; c++) {
        var change = hunk.changes[c];
        if (change.type === 'ctx' || change.type === 'del') {
          if (startIdx + ctxIdx >= lines.length) return null; // 冲突
          if (lines[startIdx + ctxIdx].trim() !== change.content.trim()) {
            // 模糊匹配：允许首尾空格差异
            if (lines[startIdx + ctxIdx].replace(/^\s+|\s+$/g, '') !== change.content.replace(/^\s+|\s+$/g, '')) {
              return null; // 冲突
            }
          }
          ctxIdx++;
        }
      }

      // 应用变更
      var newLines = [];
      var oldIdx = startIdx;
      for (var c2 = 0; c2 < hunk.changes.length; c2++) {
        var ch = hunk.changes[c2];
        if (ch.type === 'ctx') { oldIdx++; newLines.push(lines[oldIdx - 1]); }
        else if (ch.type === 'del') { oldIdx++; }
        else if (ch.type === 'add') { newLines.push(ch.content); }
      }

      // 替换
      var delCount = hunk.changes.filter(function(ch) { return ch.type === 'del' || ch.type === 'ctx'; }).length;
      lines.splice(startIdx, delCount, newLines);
      offset += newLines.length - delCount;
    }

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════
  // 3. 代码审查（P3-7）
  // ═══════════════════════════════════════════

  /**
   * reviewCode - 对代码进行审查
   * @param {string} code - 代码内容
   * @param {string} fileName - 文件名（用于语言检测）
   * @returns {Object} { issues: [{line, severity, category, message}], score, summary }
   */
  function reviewCode(code, fileName) {
    var issues = [];
    var lines = code.split('\n');
    var ext = path.extname(fileName || '').toLowerCase();

    lines.forEach(function(line, idx) {
      var lineNum = idx + 1;
      var trimmed = line.trim();

      // 安全类
      if (/eval\s*\(/.test(trimmed)) issues.push({ line: lineNum, severity: 'high', category: 'security', message: 'eval() 存在代码注入风险' });
      if (/innerHTML\s*=/.test(trimmed) && !/DOMPurify|sanitize/.test(trimmed)) issues.push({ line: lineNum, severity: 'high', category: 'security', message: 'innerHTML 赋值未经消毒，XSS 风险' });
      if (/password|secret|api_key|token/i.test(trimmed) && /=\s*['"][^'"]+['"]/.test(trimmed)) issues.push({ line: lineNum, severity: 'critical', category: 'security', message: '疑似硬编码密钥/密码' });

      // 质量类
      if (/console\.log/.test(trimmed) && ext !== '.js') issues.push({ line: lineNum, severity: 'low', category: 'quality', message: '生产代码中的 console.log' });
      if (/TODO|FIXME|HACK|XXX/.test(trimmed)) issues.push({ line: lineNum, severity: 'info', category: 'quality', message: '待处理标记: ' + trimmed.match(/TODO|FIXME|HACK|XXX/)[0] });
      if (trimmed.length > 200) issues.push({ line: lineNum, severity: 'low', category: 'style', message: '行过长(' + trimmed.length + '字符)' });

      // 性能类
      if (/for\s*\(.*\.length\s*;/.test(trimmed)) issues.push({ line: lineNum, severity: 'medium', category: 'performance', message: '循环中重复计算 .length' });

      // 错误处理
      if (/catch\s*\(\w+\)\s*\{\s*\}/.test(trimmed)) issues.push({ line: lineNum, severity: 'medium', category: 'reliability', message: '空 catch 块，异常被静默吞掉' });
    });

    // 评分
    var criticalCount = issues.filter(function(i) { return i.severity === 'critical'; }).length;
    var highCount = issues.filter(function(i) { return i.severity === 'high'; }).length;
    var medCount = issues.filter(function(i) { return i.severity === 'medium'; }).length;
    var score = Math.max(0, 100 - criticalCount * 30 - highCount * 15 - medCount * 5 - issues.length);

    return {
      issues: issues,
      score: score,
      summary: issues.length === 0 ? '代码质量良好，未发现问题。' :
        '发现 ' + issues.length + ' 个问题（' + criticalCount + ' 严重, ' + highCount + ' 高危, ' + medCount + ' 中等）',
      linesReviewed: lines.length
    };
  }

  /**
   * reviewDiff - 审查 git diff 输出
   */
  function reviewDiff(diffText) {
    var parsed = parseUnifiedDiff(diffText);
    var allIssues = [];
    parsed.forEach(function(entry) {
      // 从 diff 重建新增代码
      var addedLines = [];
      entry.hunks.forEach(function(hunk) {
        hunk.changes.forEach(function(ch) {
          if (ch.type === 'add') addedLines.push(ch.content);
        });
      });
      if (addedLines.length > 0) {
        var result = reviewCode(addedLines.join('\n'), entry.file);
        result.issues.forEach(function(issue) { issue.file = entry.file; });
        allIssues = allIssues.concat(result.issues);
      }
    });
    return { files: parsed.length, issues: allIssues, score: Math.max(0, 100 - allIssues.length * 5) };
  }

  // ═══════════════════════════════════════════
  // Module init
  // ═══════════════════════════════════════════
  function init(_Core) {
    Core = _Core;
    Core.diffEditor = {
      parseUnifiedDiff: parseUnifiedDiff,
      applyDiff: applyDiff,
      reviewCode: reviewCode,
      reviewDiff: reviewDiff
    };
    console.log('[diff-editor] initialized');
  }

  module.exports = { name: 'diff-editor', dependencies: [], init: init };
})();
