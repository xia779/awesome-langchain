// modules/session-tags.js - 增强会话标签系统
// 标签 CRUD、颜色管理、过滤筛选、批量操作、自动建议、导入导出

let Core = null;
var fs = require('fs');
var path = require('path');

// ===== 数据存储 =====
var sessionTags = {};    // { sessionId: ['tag1', 'tag2'] }
var tagRegistry = {};    // { tagName: { color, desc, icon, createdAt } }
var TAGS_FILE = '';
var REGISTRY_FILE = '';

// 预设颜色调色板
var COLOR_PALETTE = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899',
  '#06b6d4', '#f97316', '#14b8a6', '#6366f1', '#84cc16', '#e11d48',
  '#0ea5e9', '#a855f7', '#eab308', '#22c55e', '#f43f5e', '#6b7280'
];

// 默认标签预设
var DEFAULT_PRESETS = {
  '工作': { color: '#3b82f6', icon: '💼', desc: '工作相关会话' },
  '学习': { color: '#8b5cf6', icon: '📚', desc: '学习笔记与教程' },
  '项目': { color: '#f59e0b', icon: '🔧', desc: '项目开发讨论' },
  '生活': { color: '#10b981', icon: '🏠', desc: '日常生活话题' },
  '代码': { color: '#ef4444', icon: '💻', desc: '编程与技术' },
  '创意': { color: '#ec4899', icon: '🎨', desc: '创意与灵感' },
  '重要': { color: '#e11d48', icon: '⭐', desc: '重要会话标记' },
  '归档': { color: '#6b7280', icon: '📦', desc: '已归档会话' }
};

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;

  // 数据文件路径
  TAGS_FILE = path.join(Core.DATA_ROOT, 'session-tags.json');
  REGISTRY_FILE = path.join(Core.DATA_ROOT, 'tag-registry.json');

  loadData();

  // 注册命令
  if (Core.custom && Core.custom.registerCommand) {
    setTimeout(function() {
      Core.custom.registerCommand('/tag', handleTagCommand, '标签管理：/tag list|add|remove|color|filter|batch|rename|delete|stats|export|import');
      Core.custom.registerCommand('/tags', handleTagCommand, '标签管理（同 /tag）');
    }, 100);
  }

  // 挂载到 Core
  Core.sessionTags = {
    get: getSessionTags,
    set: addTag,
    add: addTag,
    remove: removeTag,
    getAll: getAllTags,
    getRegistry: getTagRegistry,
    createTag: createTag,
    renameTag: renameTag,
    deleteTag: deleteTag,
    setColor: setTagColor,
    setColorHex: setTagColor,
    setDescription: setTagDescription,
    filter: filterSessionsByTags,
    filterByTag: filterByTag,
    batchAdd: batchAddTag,
    batchRemove: batchRemoveTag,
    suggest: suggestTags,
    stats: getTagStats,
    exportData: exportTags,
    importData: importTags,
    renderBadge: renderTagBadge,
    renderBadges: renderTagBadges,
    getPalette: function() { return COLOR_PALETTE.slice(); },
    getPresets: function() { return Object.assign({}, DEFAULT_PRESETS); },
  };

}

// ===== 数据加载/保存 =====
function loadData() {
  // 加载会话-标签映射
  try {
    if (fs.existsSync(TAGS_FILE)) {
      sessionTags = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf-8'));
    }
  } catch (e) { sessionTags = {}; }

  // 加载标签注册表
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      tagRegistry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (e) { tagRegistry = {}; }

  // 从已有 sessionTags 自动注册缺失的标签
  var dirty = false;
  Object.keys(sessionTags).forEach(function(sid) {
    (sessionTags[sid] || []).forEach(function(tag) {
      if (!tagRegistry[tag]) {
        var preset = DEFAULT_PRESETS[tag];
        tagRegistry[tag] = {
          color: preset ? preset.color : assignColor(tag),
          icon: preset ? preset.icon : '',
          desc: preset ? preset.desc : '',
          createdAt: Date.now()
        };
        dirty = true;
      }
    });
  });

  // 确保预设标签都在注册表中
  Object.keys(DEFAULT_PRESETS).forEach(function(name) {
    if (!tagRegistry[name]) {
      tagRegistry[name] = {
        color: DEFAULT_PRESETS[name].color,
        icon: DEFAULT_PRESETS[name].icon,
        desc: DEFAULT_PRESETS[name].desc,
        createdAt: Date.now()
      };
      dirty = true;
    }
  });

  if (dirty) saveRegistry();
}

function saveSessionTags() {
  try {
    fs.writeFileSync(TAGS_FILE, JSON.stringify(sessionTags, null, 2), 'utf-8');
  } catch (e) { console.error('保存会话标签失败:', e.message); }
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(tagRegistry, null, 2), 'utf-8');
  } catch (e) { console.error('保存标签注册表失败:', e.message); }
}

// ===== 颜色分配 =====
function assignColor(tag) {
  // 基于标签名哈希选择颜色
  var hash = 0;
  for (var i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash) + tag.charCodeAt(i);
    hash |= 0;
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

// ===== 标签 CRUD =====
function createTag(name, options) {
  if (!name || typeof name !== 'string') return { success: false, error: '标签名不能为空' };
  name = name.trim();
  if (name.length > 20) return { success: false, error: '标签名最长 20 字符' };

  var opts = options || {};
  if (tagRegistry[name]) return { success: false, error: '标签已存在: ' + name };

  tagRegistry[name] = {
    color: opts.color || assignColor(name),
    icon: opts.icon || '',
    desc: opts.desc || '',
    createdAt: Date.now()
  };
  saveRegistry();
  return { success: true, tag: name, meta: tagRegistry[name] };
}

function renameTag(oldName, newName) {
  if (!tagRegistry[oldName]) return { success: false, error: '标签不存在: ' + oldName };
  if (!newName || newName.trim().length === 0) return { success: false, error: '新标签名不能为空' };
  newName = newName.trim();
  if (newName.length > 20) return { success: false, error: '标签名最长 20 字符' };
  if (tagRegistry[newName]) return { success: false, error: '目标标签已存在: ' + newName };

  // 更新注册表
  tagRegistry[newName] = tagRegistry[oldName];
  delete tagRegistry[oldName];

  // 更新所有会话引用
  var count = 0;
  Object.keys(sessionTags).forEach(function(sid) {
    var arr = sessionTags[sid];
    var idx = arr.indexOf(oldName);
    if (idx !== -1) {
      arr[idx] = newName;
      count++;
    }
  });

  saveRegistry();
  saveSessionTags();
  return { success: true, from: oldName, to: newName, updatedSessions: count };
}

function deleteTag(name) {
  if (!tagRegistry[name]) return { success: false, error: '标签不存在: ' + name };

  // 从所有会话中移除
  var count = 0;
  Object.keys(sessionTags).forEach(function(sid) {
    var arr = sessionTags[sid];
    var idx = arr.indexOf(name);
    if (idx !== -1) {
      arr.splice(idx, 1);
      count++;
      if (arr.length === 0) delete sessionTags[sid];
    }
  });

  delete tagRegistry[name];
  saveRegistry();
  saveSessionTags();
  return { success: true, tag: name, removedFromSessions: count };
}

function setTagColor(name, color) {
  if (!tagRegistry[name]) {
    // 自动创建
    var result = createTag(name, { color: color });
    return result;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { success: false, error: '颜色格式错误，需要 #RRGGBB' };
  tagRegistry[name].color = color;
  saveRegistry();
  return { success: true, tag: name, color: color };
}

function setTagDescription(name, desc) {
  if (!tagRegistry[name]) return { success: false, error: '标签不存在: ' + name };
  tagRegistry[name].desc = desc || '';
  saveRegistry();
  return { success: true, tag: name, desc: desc };
}

// ===== 会话标签操作 =====
function getSessionTags(sessionId) {
  return (sessionTags[sessionId] || []).slice();
}

function addTag(sessionId, tag) {
  if (!tag || typeof tag !== 'string') return { success: false, error: '标签名无效' };
  tag = tag.trim();
  if (!sessionTags[sessionId]) sessionTags[sessionId] = [];
  if (sessionTags[sessionId].includes(tag)) return { success: true, already: true };

  // 确保标签在注册表中
  if (!tagRegistry[tag]) {
    var preset = DEFAULT_PRESETS[tag];
    tagRegistry[tag] = {
      color: preset ? preset.color : assignColor(tag),
      icon: preset ? preset.icon : '',
      desc: preset ? preset.desc : '',
      createdAt: Date.now()
    };
    saveRegistry();
  }

  sessionTags[sessionId].push(tag);
  saveSessionTags();
  return { success: true, tag: tag, sessionTags: sessionTags[sessionId].slice() };
}

function removeTag(sessionId, tag) {
  if (!sessionTags[sessionId]) return { success: false, error: '该会话无标签' };
  var idx = sessionTags[sessionId].indexOf(tag);
  if (idx === -1) return { success: false, error: '标签不存在: ' + tag };
  sessionTags[sessionId].splice(idx, 1);
  if (sessionTags[sessionId].length === 0) delete sessionTags[sessionId];
  saveSessionTags();
  return { success: true, tag: tag };
}

// ===== 查询与过滤 =====
function getAllTags() {
  var tagCount = {};
  Object.keys(sessionTags).forEach(function(sid) {
    (sessionTags[sid] || []).forEach(function(t) {
      tagCount[t] = (tagCount[t] || 0) + 1;
    });
  });

  return Object.keys(tagRegistry).map(function(name) {
    var meta = tagRegistry[name];
    return {
      name: name,
      color: meta.color,
      icon: meta.icon,
      desc: meta.desc,
      count: tagCount[name] || 0,
      createdAt: meta.createdAt
    };
  }).sort(function(a, b) { return b.count - a.count; });
}

function getTagRegistry(name) {
  if (name) return tagRegistry[name] || null;
  return Object.assign({}, tagRegistry);
}

function filterByTag(tag) {
  return Object.keys(sessionTags).filter(function(sid) {
    return sessionTags[sid] && sessionTags[sid].includes(tag);
  });
}

function filterSessionsByTags(tags, mode) {
  // mode: 'any' (OR, default) | 'all' (AND)
  if (!Array.isArray(tags) || tags.length === 0) return [];
  mode = mode || 'any';

  return Object.keys(sessionTags).filter(function(sid) {
    var st = sessionTags[sid] || [];
    if (mode === 'all') {
      return tags.every(function(t) { return st.includes(t); });
    } else {
      return tags.some(function(t) { return st.includes(t); });
    }
  });
}

// ===== 批量操作 =====
function batchAddTag(sessionIds, tag) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return { success: false, error: '无效的会话列表' };
  if (!tag) return { success: false, error: '标签名不能为空' };

  // 确保标签存在
  if (!tagRegistry[tag]) {
    var preset = DEFAULT_PRESETS[tag];
    tagRegistry[tag] = {
      color: preset ? preset.color : assignColor(tag),
      icon: preset ? preset.icon : '',
      desc: preset ? preset.desc : '',
      createdAt: Date.now()
    };
    saveRegistry();
  }

  var count = 0;
  sessionIds.forEach(function(sid) {
    if (!sessionTags[sid]) sessionTags[sid] = [];
    if (!sessionTags[sid].includes(tag)) {
      sessionTags[sid].push(tag);
      count++;
    }
  });
  saveSessionTags();
  return { success: true, tag: tag, addedTo: count, total: sessionIds.length };
}

function batchRemoveTag(sessionIds, tag) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return { success: false, error: '无效的会话列表' };

  var count = 0;
  sessionIds.forEach(function(sid) {
    if (!sessionTags[sid]) return;
    var idx = sessionTags[sid].indexOf(tag);
    if (idx !== -1) {
      sessionTags[sid].splice(idx, 1);
      count++;
      if (sessionTags[sid].length === 0) delete sessionTags[sid];
    }
  });
  saveSessionTags();
  return { success: true, tag: tag, removedFrom: count, total: sessionIds.length };
}

// ===== 自动建议 =====
function suggestTags(sessionId) {
  if (!Core.session || !Core.session.getMessages) return [];

  var messages = Core.session.getMessages(sessionId) || [];
  if (messages.length === 0) return [];

  // 提取所有文本
  var text = messages.slice(-20).map(function(m) { return m.content || ''; }).join(' ').toLowerCase();

  // 关键词 → 标签映射
  var KEYWORD_MAP = {
    '工作': ['会议', '项目', '需求', '排期', '上线', '部署', '发布', 'review', 'sprint', '迭代', '周报', '日报', 'okr', 'kpi'],
    '学习': ['教程', '学习', '笔记', '课程', '知识点', '练习', '作业', '论文', '考试', 'study', 'learn', 'tutorial'],
    '代码': ['代码', '函数', '变量', 'bug', '调试', '编译', '报错', 'code', 'function', 'class', 'api', 'debug', '重构', '优化'],
    '项目': ['架构', '设计', '方案', '原型', '技术选型', '模块', '组件', '接口', '数据库', '前端', '后端'],
    '生活': ['吃饭', '旅行', '购物', '健康', '运动', '电影', '音乐', '游戏', 'recipe', 'travel'],
    '创意': ['想法', '灵感', '创意', '设计', '画面', '风格', '色彩', 'idea', 'concept', 'brainstorm'],
  };

  var scores = {};
  Object.keys(KEYWORD_MAP).forEach(function(tag) {
    scores[tag] = 0;
    KEYWORD_MAP[tag].forEach(function(kw) {
      var regex = new RegExp(kw, 'gi');
      var matches = text.match(regex);
      if (matches) scores[tag] += matches.length;
    });
  });

  // 排除已有标签
  var existing = sessionTags[sessionId] || [];

  return Object.keys(scores)
    .filter(function(t) { return scores[t] > 0 && !existing.includes(t); })
    .sort(function(a, b) { return scores[b] - scores[a]; })
    .slice(0, 3)
    .map(function(t) { return { tag: t, score: scores[t], color: tagRegistry[t] ? tagRegistry[t].color : assignColor(t) }; });
}

// ===== 统计 =====
function getTagStats() {
  var allTags = getAllTags();
  var totalSessions = Object.keys(sessionTags).length;
  var totalAssignments = 0;
  Object.keys(sessionTags).forEach(function(sid) {
    totalAssignments += (sessionTags[sid] || []).length;
  });

  var taggedSessions = Object.keys(sessionTags).length;
  var allSessionCount = 0;
  if (Core.session && Core.session.getAllIds) {
    allSessionCount = Core.session.getAllIds().length;
  }

  return {
    totalTags: allTags.length,
    taggedSessions: taggedSessions,
    totalSessions: allSessionCount,
    coverage: allSessionCount > 0 ? Math.round(taggedSessions / allSessionCount * 100) : 0,
    totalAssignments: totalAssignments,
    avgPerSession: taggedSessions > 0 ? (totalAssignments / taggedSessions).toFixed(1) : 0,
    topTags: allTags.slice(0, 10),
    unusedTags: allTags.filter(function(t) { return t.count === 0; }).map(function(t) { return t.name; }),
    colors: allTags.map(function(t) { return { name: t.name, color: t.color }; })
  };
}

// ===== 导出/导入 =====
function exportTags() {
  return JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    sessionTags: sessionTags,
    tagRegistry: tagRegistry
  }, null, 2);
}

function importTags(jsonStr) {
  try {
    var data = JSON.parse(jsonStr);
    if (!data.sessionTags || typeof data.sessionTags !== 'object') {
      return { success: false, error: '无效的标签数据格式' };
    }

    // 合并策略：保留已有，追加新的
    var newSessions = 0;
    var newAssignments = 0;
    Object.keys(data.sessionTags).forEach(function(sid) {
      var tags = data.sessionTags[sid];
      if (!Array.isArray(tags)) return;
      if (!sessionTags[sid]) {
        sessionTags[sid] = [];
        newSessions++;
      }
      tags.forEach(function(t) {
        if (!sessionTags[sid].includes(t)) {
          sessionTags[sid].push(t);
          newAssignments++;
        }
      });
    });

    // 合并注册表
    var newTags = 0;
    if (data.tagRegistry && typeof data.tagRegistry === 'object') {
      Object.keys(data.tagRegistry).forEach(function(name) {
        if (!tagRegistry[name]) {
          tagRegistry[name] = data.tagRegistry[name];
          newTags++;
        }
      });
    }

    saveSessionTags();
    saveRegistry();

    return {
      success: true,
      newSessions: newSessions,
      newAssignments: newAssignments,
      newTags: newTags
    };
  } catch (e) {
    return { success: false, error: '解析失败: ' + e.message };
  }
}

// ===== UI 渲染辅助 =====
function renderTagBadge(tag) {
  var meta = tagRegistry[tag] || {};
  var color = meta.color || assignColor(tag);
  var icon = meta.icon || '';
  var prefix = icon ? icon + ' ' : '';
  return '<span class="tag-badge" style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;' +
    'background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44;margin:0 2px;cursor:pointer;" ' +
    'data-tag="' + tag + '" title="标签: ' + tag + (meta.desc ? ' - ' + meta.desc : '') + '">' +
    prefix + tag + '</span>';
}

function renderTagBadges(sessionId) {
  var tags = getSessionTags(sessionId);
  if (tags.length === 0) return '';
  return '<div class="session-tags" style="margin-top:2px;">' +
    tags.map(renderTagBadge).join('') + '</div>';
}

// ===== 命令处理 =====
function handleTagCommand(input) {
  var parts = input.trim().split(/\s+/);
  var cmd = (parts[0] || '').toLowerCase();
  var sub = (parts[1] || '').toLowerCase();
  var args = parts.slice(2);

  var currentId = Core.session ? Core.session.getCurrentId() : null;

  switch (sub) {
    case 'list':
    case '': {
      var all = getAllTags();
      if (all.length === 0) return '暂无标签。使用 /tag add <名称> 添加标签。';
      var lines = ['🏷️ 标签列表（' + all.length + ' 个）：', ''];
      all.forEach(function(t) {
        var icon = t.icon ? t.icon + ' ' : '';
        lines.push('  ' + icon + t.name + ' (' + t.count + ' 个会话)' + (t.desc ? ' — ' + t.desc : ''));
      });

      // 当前会话标签
      if (currentId) {
        var current = getSessionTags(currentId);
        if (current.length > 0) {
          lines.push('', '📌 当前会话标签: ' + current.join(', '));
        }
      }
      return lines.join('\n');
    }

    case 'add': {
      if (args.length === 0) return '用法: /tag add <标签名>';
      if (!currentId) return '❌ 无当前会话';
      var result = addTag(currentId, args[0]);
      if (result.error) return '❌ ' + result.error;
      return '✅ 已为当前会话添加标签: ' + args[0];
    }

    case 'remove':
    case 'rm': {
      if (args.length === 0) return '用法: /tag remove <标签名>';
      if (!currentId) return '❌ 无当前会话';
      var result = removeTag(currentId, args[0]);
      if (result.error) return '❌ ' + result.error;
      return '✅ 已移除标签: ' + args[0];
    }

    case 'color': {
      if (args.length < 2) return '用法: /tag color <标签名> <#RRGGBB>';
      var result = setTagColor(args[0], args[1]);
      if (result.error) return '❌ ' + result.error;
      return '✅ 标签 ' + args[0] + ' 颜色已设为 ' + args[1];
    }

    case 'create': {
      if (args.length === 0) return '用法: /tag create <标签名> [颜色]';
      var opts = args[1] ? { color: args[1] } : {};
      var result = createTag(args[0], opts);
      if (result.error) return '❌ ' + result.error;
      return '✅ 标签已创建: ' + args[0] + ' (颜色: ' + result.meta.color + ')';
    }

    case 'rename': {
      if (args.length < 2) return '用法: /tag rename <旧名> <新名>';
      var result = renameTag(args[0], args[1]);
      if (result.error) return '❌ ' + result.error;
      return '✅ 标签已重命名: ' + args[0] + ' → ' + args[1] + ' (' + result.updatedSessions + ' 个会话已更新)';
    }

    case 'delete':
    case 'del': {
      if (args.length === 0) return '用法: /tag delete <标签名>';
      var result = deleteTag(args[0]);
      if (result.error) return '❌ ' + result.error;
      return '✅ 标签已删除: ' + args[0] + ' (从 ' + result.removedFromSessions + ' 个会话中移除)';
    }

    case 'filter': {
      if (args.length === 0) return '用法: /tag filter <标签1> [标签2] ... (多标签用空格分隔)';
      var mode = 'any';
      var filterTags = args;
      // 如果最后一个参数是 --all，使用 AND 模式
      if (args[args.length - 1] === '--all') {
        mode = 'all';
        filterTags = args.slice(0, -1);
      }
      var sessions = filterSessionsByTags(filterTags, mode);
      if (sessions.length === 0) return '未找到匹配 ' + (mode === 'all' ? '所有' : '任一') + ' 标签的会话: ' + filterTags.join(', ');
      return '🔍 匹配 ' + (mode === 'all' ? '所有' : '任一') + ' 标签 [' + filterTags.join(', ') + '] 的会话 (' + sessions.length + ' 个):\n' +
        sessions.slice(0, 20).map(function(sid) {
          var title = '未知';
          if (Core.session && Core.session.getTitle) title = Core.session.getTitle(sid) || sid;
          return '  • ' + title + ' [' + getSessionTags(sid).join(', ') + ']';
        }).join('\n');
    }

    case 'batch': {
      if (args.length < 2) return '用法: /tag batch <标签名> <会话ID1> [会话ID2] ...';
      var tag = args[0];
      var sids = args.slice(1);
      var result = batchAddTag(sids, tag);
      if (result.error) return '❌ ' + result.error;
      return '✅ 批量添加标签 ' + tag + '：' + result.addedTo + '/' + result.total + ' 个会话';
    }

    case 'suggest': {
      if (!currentId) return '❌ 无当前会话';
      var suggestions = suggestTags(currentId);
      if (suggestions.length === 0) return '暂无标签建议。可以手动用 /tag add 添加。';
      var lines = ['💡 标签建议（基于会话内容分析）：', ''];
      suggestions.forEach(function(s) {
        lines.push('  ' + s.tag + ' (相关度: ' + s.score + ') — 输入 /tag add ' + s.tag + ' 添加');
      });
      return lines.join('\n');
    }

    case 'stats': {
      var stats = getTagStats();
      var lines = [
        '📊 标签统计',
        '━━━━━━━━━━━━━━━━━━',
        '  标签总数: ' + stats.totalTags,
        '  已标记会话: ' + stats.taggedSessions + '/' + stats.totalSessions + ' (' + stats.coverage + '%)',
        '  标签分配总数: ' + stats.totalAssignments,
        '  平均每会话标签数: ' + stats.avgPerSession,
      ];
      if (stats.topTags.length > 0) {
        lines.push('', '  🔝 热门标签:');
        stats.topTags.slice(0, 5).forEach(function(t, i) {
          lines.push('    ' + (i + 1) + '. ' + t.name + ' (' + t.count + ' 个会话)');
        });
      }
      if (stats.unusedTags.length > 0) {
        lines.push('', '  ⚠️ 未使用标签: ' + stats.unusedTags.join(', '));
      }
      return lines.join('\n');
    }

    case 'export': {
      var json = exportTags();
      // 保存到文件
      var exportPath = path.join(Core.DATA_ROOT, 'tags-export-' + Date.now() + '.json');
      try {
        fs.writeFileSync(exportPath, json, 'utf-8');
        return '✅ 标签已导出到: ' + exportPath;
      } catch (e) {
        return '❌ 导出失败: ' + e.message;
      }
    }

    case 'import': {
      if (args.length === 0) return '用法: /tag import <文件路径>';
      var filePath = args.join(' ');
      try {
        var json = fs.readFileSync(filePath, 'utf-8');
        var result = importTags(json);
        if (result.error) return '❌ ' + result.error;
        return '✅ 导入成功：新增 ' + result.newSessions + ' 个会话标记，' + result.newAssignments + ' 条标签分配，' + result.newTags + ' 个新标签';
      } catch (e) {
        return '❌ 导入失败: ' + e.message;
      }
    }

    case 'desc': {
      if (args.length < 2) return '用法: /tag desc <标签名> <描述>';
      var tagName = args[0];
      var desc = args.slice(1).join(' ');
      var result = setTagDescription(tagName, desc);
      if (result.error) return '❌ ' + result.error;
      return '✅ 标签 ' + tagName + ' 描述已更新';
    }

    case 'palette': {
      var lines = ['🎨 可用颜色调色板：', ''];
      COLOR_PALETTE.forEach(function(c, i) {
        lines.push('  ' + (i + 1) + '. ' + c);
      });
      lines.push('', '用法: /tag color <标签名> <颜色值>');
      return lines.join('\n');
    }

    default:
      return '🏷️ 标签命令帮助:\n' +
        '  /tag list          — 列出所有标签\n' +
        '  /tag add <名>      — 为当前会话添加标签\n' +
        '  /tag remove <名>   — 从当前会话移除标签\n' +
        '  /tag create <名> [颜色] — 创建新标签\n' +
        '  /tag rename <旧> <新> — 重命名标签\n' +
        '  /tag delete <名>   — 删除标签\n' +
        '  /tag color <名> <#RRGGBB> — 设置标签颜色\n' +
        '  /tag desc <名> <描述> — 设置标签描述\n' +
        '  /tag filter <标签...> [--all] — 按标签过滤会话\n' +
        '  /tag batch <标签> <ID...> — 批量添加标签\n' +
        '  /tag suggest       — 智能标签建议\n' +
        '  /tag stats         — 标签统计\n' +
        '  /tag export        — 导出标签数据\n' +
        '  /tag import <路径>  — 导入标签数据\n' +
        '  /tag palette       — 查看可用颜色';
  }
}

module.exports = { init };
