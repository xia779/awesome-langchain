// modules/file-checkpoint.js - 文件操作安全（diff 预览 + checkpoint 回滚）
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var Core = null;

// ===== Checkpoint 存储目录 =====
function getCheckpointDir(sessionId) {
  var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || 'E:\my-ai-data';
  var dir = path.join(base, '.checkpoints', sessionId || 'default');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ===== 生成 unified diff（简化版，逐行对比）=====
function generateDiff(filePath, newContent) {
  var oldContent = '';
  if (fs.existsSync(filePath)) {
    try { oldContent = fs.readFileSync(filePath, 'utf8'); } catch (e) { oldContent = ''; }
  }

  var oldLines = oldContent.split('\n');
  var newLines = newContent.split('\n');
  var maxLen = Math.max(oldLines.length, newLines.length);
  var changes = 0;
  var diffLines = [];

  for (var i = 0; i < maxLen; i++) {
    var oldLine = i < oldLines.length ? oldLines[i] : undefined;
    var newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      diffLines.push({ type: 'context', text: oldLine });
    } else {
      if (oldLine !== undefined) { diffLines.push({ type: 'remove', text: oldLine }); changes++; }
      if (newLine !== undefined) { diffLines.push({ type: 'add', text: newLine }); changes++; }
    }
  }

  // 压缩：只保留变更行 ± 2 行上下文
  var compressed = [];
  for (var j = 0; j < diffLines.length; j++) {
    if (diffLines[j].type !== 'context') {
      for (var back = Math.max(0, j - 2); back < j; back++) {
        if (diffLines[back].type === 'context' && compressed.indexOf(diffLines[back]) < 0) compressed.push(diffLines[back]);
      }
      compressed.push(diffLines[j]);
      for (var fwd = j + 1; fwd <= Math.min(diffLines.length - 1, j + 2); fwd++) {
        if (diffLines[fwd].type === 'context' && compressed.indexOf(diffLines[fwd]) < 0) compressed.push(diffLines[fwd]);
      }
    }
  }

  var output = '--- ' + path.basename(filePath) + ' (原始)\n+++ ' + path.basename(filePath) + ' (修改后)\n';
  compressed.forEach(function(d) {
    if (d.type === 'remove') output += '-' + d.text + '\n';
    else if (d.type === 'add') output += '+' + d.text + '\n';
    else output += ' ' + d.text + '\n';
  });

  if (compressed.length > 60) {
    output = compressed.slice(0, 60).map(function(d) {
      return (d.type === 'remove' ? '-' : d.type === 'add' ? '+' : ' ') + d.text;
    }).join('\n') + '\n... (共 ' + changes + ' 处变更，已截断)\n';
  }

  return { diff: output, changeCount: changes, totalLines: maxLen };
}

// ===== 创建 checkpoint（写入前快照）=====
function createCheckpoint(filePath, sessionId) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    var dir = getCheckpointDir(sessionId);
    var hash = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 12);
    var checkpointName = hash + '_' + path.basename(filePath);
    var checkpointPath = path.join(dir, checkpointName);

    fs.copyFileSync(filePath, checkpointPath);

    var metaPath = checkpointPath + '.meta.json';
    var meta = {
      originalPath: filePath,
      checkpointPath: checkpointPath,
      sessionId: sessionId || 'default',
      createdAt: new Date().toISOString(),
      size: fs.statSync(filePath).size,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return { success: true, checkpointPath: checkpointPath, meta: meta };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 回滚单个文件 =====
function rollbackFile(filePath, sessionId) {
  try {
    var dir = getCheckpointDir(sessionId);
    var hash = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 12);
    var checkpointName = hash + '_' + path.basename(filePath);
    var checkpointPath = path.join(dir, checkpointName);

    if (!fs.existsSync(checkpointPath)) {
      return { success: false, error: '未找到该文件的 checkpoint: ' + filePath };
    }
    fs.copyFileSync(checkpointPath, filePath);
    return { success: true, restored: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 回滚整个会话的所有 checkpoint =====
function rollbackAll(sessionId) {
  try {
    var dir = getCheckpointDir(sessionId);
    if (!fs.existsSync(dir)) return { success: false, error: '无 checkpoint 目录' };

    var metaFiles = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.meta.json'); });
    var restored = 0;
    var errors = [];

    metaFiles.forEach(function(metaFile) {
      try {
        var meta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8'));
        if (meta.originalPath && fs.existsSync(meta.checkpointPath)) {
          fs.copyFileSync(meta.checkpointPath, meta.originalPath);
          restored++;
        }
      } catch (e) { errors.push(metaFile + ': ' + e.message); }
    });

    return { success: true, restored: restored, errors: errors };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 列出会话的所有 checkpoint =====
function listCheckpoints(sessionId) {
  try {
    var dir = getCheckpointDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    var metaFiles = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.meta.json'); });
    return metaFiles.map(function(metaFile) {
      try { return JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8')); }
      catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ===== 清理过期 checkpoint（保留最近 N 个会话）=====
function cleanupCheckpoints(keepSessions) {
  keepSessions = keepSessions || 10;
  try {
    var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || 'E:\my-ai-data';
    var cpRoot = path.join(base, '.checkpoints');
    if (!fs.existsSync(cpRoot)) return;

    var sessions = fs.readdirSync(cpRoot).map(function(name) {
      var stat = fs.statSync(path.join(cpRoot, name));
      return { name: name, mtime: stat.mtimeMs };
    }).sort(function(a, b) { return b.mtime - a.mtime; });

    var toDelete = sessions.slice(keepSessions);
    toDelete.forEach(function(s) {
      try { fs.rmSync(path.join(cpRoot, s.name), { recursive: true, force: true }); } catch (e) {}
    });
    if (toDelete.length > 0) console.log('🧹 已清理 ' + toDelete.length + ' 个过期 checkpoint 会话');
  } catch (e) {}
}

// ===== 模块导出 =====
module.exports = {
  name: 'file-checkpoint',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    Core.fileCheckpoint = {
      generateDiff: generateDiff,
      createCheckpoint: createCheckpoint,
      rollbackFile: rollbackFile,
      rollbackAll: rollbackAll,
      listCheckpoints: listCheckpoints,
      cleanup: cleanupCheckpoints,
    };
    setTimeout(function() { cleanupCheckpoints(10); }, 5000);
    console.log('✅ File-Checkpoint 模块已加载（diff预览 + checkpoint回滚）');
  }
};
