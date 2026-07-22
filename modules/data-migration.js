// modules/data-migration.js - 数据单源化迁移（JSON → SQLite，一次性）
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;

const MIGRATION_KEY = '_migration_v8_single_source';

// ===== 主迁移入口 =====
function runMigration() {
  if (!Core.db || Core.db._backend !== 'sqlite') {
    console.log('⏭️ 数据迁移跳过（非 SQLite 模式）');
    return { success: false, reason: 'not_sqlite' };
  }

  // 检查是否已完成迁移
  var done = Core.db.get(MIGRATION_KEY);
  if (done) {
    return { success: true, reason: 'already_done' };
  }

  var results = { sessions: 0, config: false, errors: [] };
  var userId = Core._currentUser || 'admin';
  var dataRoot = Core.DATA_ROOT || path.join('E:\\my-ai-data', 'users', userId);

  // 1. 迁移残留 JSON 会话
  try {
    var sessionsDir = path.join(dataRoot, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      var files = fs.readdirSync(sessionsDir).filter(function(f) { return f.endsWith('.json'); });
      files.forEach(function(file) {
        try {
          var filePath = path.join(sessionsDir, file);
          var content = fs.readFileSync(filePath, 'utf8');
          var data = JSON.parse(content);
          var sessionId = file.replace('.json', '');

          // 检查 SQLite 中是否已存在
          var existing = Core.db.getSession(sessionId);
          if (!existing) {
            // 导入到 SQLite
            data.userId = userId;
            Core.db.saveSession(sessionId, data);
            results.sessions++;
          }

          // 重命名为 .bak（不删除，保留回退能力）
          var bakPath = filePath + '.bak';
          if (!fs.existsSync(bakPath)) {
            fs.renameSync(filePath, bakPath);
          }
        } catch (e) {
          results.errors.push('session ' + file + ': ' + e.message);
        }
      });
    }
  } catch (e) {
    results.errors.push('sessions_dir: ' + e.message);
  }

  // 2. 迁移 config.json（如果 SQLite 中配置为空）
  try {
    var configPath = path.join(dataRoot, 'config.json');
    if (fs.existsSync(configPath)) {
      var dbConfig = Core.db.get(userId + ':model');
      if (!dbConfig) {
        // SQLite 中没有配置，从 JSON 导入
        var configContent = fs.readFileSync(configPath, 'utf8');
        var configData = JSON.parse(configContent);
        Object.keys(configData).forEach(function(key) {
          if (key.startsWith('_')) return; // 跳过内部字段
          Core.db.set(userId + ':' + key, JSON.stringify(configData[key]));
        });
        results.config = true;
      }
      // 重命名 config.json 为 .bak
      var configBak = configPath + '.bak';
      if (!fs.existsSync(configBak)) {
        fs.renameSync(configPath, configBak);
      }
    }
  } catch (e) {
    results.errors.push('config: ' + e.message);
  }

  // 3. 标记迁移完成
  Core.db.set(MIGRATION_KEY, JSON.stringify({ completedAt: Date.now(), results: results }));

  console.log('✅ 数据迁移完成: ' + results.sessions + ' 个会话导入, config=' + results.config +
    (results.errors.length > 0 ? ', ' + results.errors.length + ' 个错误' : ''));

  return { success: true, results: results };
}

// ===== 获取迁移状态 =====
function getMigrationStatus() {
  if (!Core.db || Core.db._backend !== 'sqlite') return { done: false, reason: 'not_sqlite' };
  var raw = Core.db.get(MIGRATION_KEY);
  if (!raw) return { done: false };
  try { return { done: true, detail: JSON.parse(raw) }; } catch (e) { return { done: true }; }
}

// ===== 模块导出 =====
module.exports = {
  name: 'data-migration',
  dependencies: ['database'],
  init: function(_Core) {
    Core = _Core;

    // 延迟执行迁移（等待 DB 完全初始化）
    setTimeout(function() {
      try { runMigration(); } catch (e) {
        console.warn('⚠️ 数据迁移异常:', e.message);
      }
    }, 2000);

    Core.dataMigration = {
      run: runMigration,
      status: getMigrationStatus
    };

    console.log('✅ 数据迁移模块已加载（单源化 JSON→SQLite）');
  }
};
