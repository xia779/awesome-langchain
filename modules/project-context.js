// modules/project-context.js - 项目上下文协议模块
// 自动扫描并加载项目目录中的约定文件（AGENTS.md, SOUL.md, USER.md 等）
// 将内容注入系统提示词，让 AI 理解项目规范并自动遵循

var Core = null;
var fs = null;
var path = null;

try {
  fs = require('fs');
  path = require('path');
} catch (e) {}

// ═══════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════

var state = {
  projectDir: null,         // 当前项目目录路径
  contextFiles: {},         // { filename: { content, loadedAt, size } }
  fileWatcher: null,        // fs.FSWatcher 实例
  autoInject: true,         // 是否自动注入到系统提示
  maxFileSize: 50000,       // 单文件最大字符数（约 50KB）
  totalTokenBudget: 4000,   // 所有上下文文件的总 token 预算
  lastScanTime: null
};

// 要扫描的上下文文件名（按优先级排序）
var CONTEXT_FILE_NAMES = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.aidoc',
  'CONTEXT.md',
  'CONVENTIONS.md',
  'CODING_STANDARDS.md',
  'PROJECT_RULES.md',
  '.github/copilot-instructions.md'
];

// 文件描述（用于 UI 显示）
var FILE_DESCRIPTIONS = {
  'AGENTS.md': '项目指令、编码约定、架构规则',
  'SOUL.md': 'AI 人格定义、沟通风格',
  'USER.md': '用户偏好和个性化设置',
  'CLAUDE.md': 'Claude 指令（兼容格式）',
  '.cursorrules': 'Cursor 编辑器规则',
  '.windsurfrules': 'Windsurf 编辑器规则',
  '.aidoc': 'AI 文档指令',
  'CONTEXT.md': '项目上下文信息',
  'CONVENTIONS.md': '编码约定',
  'CODING_STANDARDS.md': '编码标准',
  'PROJECT_RULES.md': '项目规则',
  '.github/copilot-instructions.md': 'GitHub Copilot 指令'
};

// ═══════════════════════════════════════════
// 核心操作
// ═══════════════════════════════════════════

/**
 * 扫描项目目录并加载所有上下文文件
 */
function scanAndLoad(dir) {
  if (!dir || !fs || !fs.existsSync(dir)) {
    state.projectDir = null;
    state.contextFiles = {};
    stopWatching();
    return { loaded: 0, files: [], error: dir ? '目录不存在' : '未设置项目目录' };
  }

  state.projectDir = dir;
  var prevFiles = Object.keys(state.contextFiles);
  state.contextFiles = {};
  var loaded = [];
  var totalSize = 0;

  for (var i = 0; i < CONTEXT_FILE_NAMES.length; i++) {
    var filename = CONTEXT_FILE_NAMES[i];
    var filepath = path.join(dir, filename);

    try {
      if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
        var content = fs.readFileSync(filepath, 'utf8');
        if (content && content.trim().length > 0) {
          // 限制文件大小
          if (content.length > state.maxFileSize) {
            content = content.substring(0, state.maxFileSize) + '\n\n... [文件过大，已截断]';
          }
          state.contextFiles[filename] = {
            content: content,
            loadedAt: Date.now(),
            size: content.length,
            path: filepath,
            description: FILE_DESCRIPTIONS[filename] || ''
          };
          loaded.push(filename);
          totalSize += content.length;
        }
      }
    } catch (e) {
      console.warn('project-context: 读取 ' + filename + ' 失败:', e.message);
    }
  }

  state.lastScanTime = Date.now();

  // 设置文件监听
  startWatching(dir);

  // 通知变更
  if (Core && Core.emit) {
    Core.emit('projectContextChanged', { dir: dir, files: loaded, totalSize: totalSize });
  }

  console.log('📁 项目上下文已加载: ' + dir + ' (' + loaded.length + ' 个文件, ' + Math.round(totalSize / 1024) + 'KB)');
  return { loaded: loaded.length, files: loaded, totalSize: totalSize };
}

/**
 * 获取格式化的上下文字符串（用于注入系统提示词）
 */
function getContextString() {
  var files = Object.keys(state.contextFiles);
  if (files.length === 0 || !state.autoInject) return '';

  var parts = [];
  var totalChars = 0;
  var budget = state.totalTokenBudget * 4; // 粗略估算：1 token ≈ 4 字符

  for (var i = 0; i < files.length; i++) {
    var filename = files[i];
    var entry = state.contextFiles[filename];
    var content = entry.content;

    // 检查 token 预算
    if (totalChars + content.length > budget) {
      // 超出预算，截断
      var remaining = budget - totalChars;
      if (remaining > 200) {
        content = content.substring(0, remaining) + '\n... [已截断，超出上下文预算]';
      } else {
        break;
      }
    }

    parts.push('=== ' + filename + ' (' + (entry.description || '项目文件') + ') ===\n' + content);
    totalChars += content.length + 100; // 100 字符留给分隔符
  }

  if (parts.length === 0) return '';

  return '\n\n【项目上下文 - 以下文件定义了当前项目的约定和规范，请严格遵守】\n\n' +
    parts.join('\n\n') +
    '\n\n【项目上下文结束 - 请根据以上约定回答问题和执行任务】\n';
}

/**
 * 检查是否有已加载的上下文
 */
function hasContext() {
  return Object.keys(state.contextFiles).length > 0;
}

/**
 * 获取状态信息
 */
function getStatus() {
  var files = Object.keys(state.contextFiles);
  return {
    projectDir: state.projectDir,
    autoInject: state.autoInject,
    loadedFiles: files.length,
    files: files.map(function(f) {
      return {
        name: f,
        description: state.contextFiles[f].description,
        size: state.contextFiles[f].size,
        loadedAt: state.contextFiles[f].loadedAt
      };
    }),
    totalSize: files.reduce(function(sum, f) { return sum + state.contextFiles[f].size; }, 0),
    lastScanTime: state.lastScanTime,
    watching: !!state.fileWatcher
  };
}

/**
 * 设置自动注入开关
 */
function setAutoInject(enabled) {
  state.autoInject = !!enabled;
  if (Core && Core.saveConfig) {
    Core.saveConfig({ projectContextAutoInject: state.autoInject });
  }
}

/**
 * 手动刷新（重新扫描目录）
 */
function refresh() {
  if (state.projectDir) {
    return scanAndLoad(state.projectDir);
  }
  return { loaded: 0, files: [], error: '未设置项目目录' };
}

/**
 * 获取单个文件内容
 */
function getFileContent(filename) {
  if (state.contextFiles[filename]) {
    return state.contextFiles[filename].content;
  }
  return null;
}

/**
 * 清除所有上下文
 */
function clear() {
  stopWatching();
  state.projectDir = null;
  state.contextFiles = {};
  state.lastScanTime = null;
  if (Core && Core.emit) {
    Core.emit('projectContextChanged', { dir: null, files: [], totalSize: 0 });
  }
}

// ═══════════════════════════════════════════
// 文件监听
// ═══════════════════════════════════════════

function startWatching(dir) {
  stopWatching(); // 先停止旧的监听

  if (!fs) return;

  try {
    state.fileWatcher = fs.watch(dir, { persistent: false, recursive: false }, function(eventType, filename) {
      if (!filename) return;
      // 检查是否是上下文文件
      var isContextFile = CONTEXT_FILE_NAMES.some(function(name) {
        return filename === name || filename === path.basename(name);
      });

      if (isContextFile) {
        console.log('📁 项目上下文文件变更: ' + filename + ' (' + eventType + ')');
        // 延迟 500ms 重新加载（防抖）
        clearTimeout(state._reloadTimer);
        state._reloadTimer = setTimeout(function() {
          scanAndLoad(state.projectDir);
        }, 500);
      }
    });

    state.fileWatcher.on('error', function(err) {
      console.warn('project-context: 文件监听错误:', err.message);
      state.fileWatcher = null;
    });
  } catch (e) {
    console.warn('project-context: 无法启动文件监听:', e.message);
  }
}

function stopWatching() {
  if (state.fileWatcher) {
    try { state.fileWatcher.close(); } catch (e) {}
    state.fileWatcher = null;
  }
  if (state._reloadTimer) {
    clearTimeout(state._reloadTimer);
    state._reloadTimer = null;
  }
}

// ═══════════════════════════════════════════
// /context 命令（项目上下文版）
// ═══════════════════════════════════════════

function handleContextCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'status').toLowerCase();

  switch (sub) {
    case 'status': case '状态':
      var status = getStatus();
      if (status.loadedFiles === 0) {
        return '📁 项目上下文: 未加载任何文件\n' +
          '使用 `/context set <目录路径>` 设置项目目录';
      }
      var info = '📁 **项目上下文状态**\n\n';
      info += '目录: `' + status.projectDir + '`\n';
      info += '自动注入: ' + (status.autoInject ? '✅ 开启' : '❌ 关闭') + '\n';
      info += '文件监听: ' + (status.watching ? '✅ 活跃' : '❌ 未启动') + '\n';
      info += '总大小: ' + Math.round(status.totalSize / 1024) + 'KB\n\n';
      info += '**已加载文件:**\n';
      status.files.forEach(function(f) {
        info += '- `' + f.name + '` ' + (f.description || '') + ' (' + Math.round(f.size / 1024) + 'KB)\n';
      });
      return info;

    case 'set': case '设置':
      var dir = parts.slice(1).join(' ');
      if (!dir) return '用法: /context set <项目目录路径>';
      var result = scanAndLoad(dir);
      if (result.error) return '❌ ' + result.error;
      return '✅ 已加载 ' + result.loaded + ' 个上下文文件\n' +
        '文件: ' + (result.files.join(', ') || '无') + '\n' +
        '总大小: ' + Math.round((result.totalSize || 0) / 1024) + 'KB';

    case 'refresh': case '刷新':
      var refreshResult = refresh();
      if (refreshResult.error) return '❌ ' + refreshResult.error;
      return '🔄 已刷新，加载 ' + refreshResult.loaded + ' 个文件';

    case 'toggle': case '切换':
      setAutoInject(!state.autoInject);
      return state.autoInject ? '✅ 自动注入已开启' : '❌ 自动注入已关闭';

    case 'clear': case '清除':
      clear();
      return '🗑️ 项目上下文已清除';

    case 'read': case '读取':
      var filename = parts[1];
      if (!filename) return '用法: /context read <文件名>\n可用: ' + Object.keys(state.contextFiles).join(', ');
      var content = getFileContent(filename);
      if (!content) return '❌ 未找到文件: ' + filename;
      return '**' + filename + '** (' + content.length + ' 字符)\n\n```\n' + content.substring(0, 3000) + (content.length > 3000 ? '\n...[已截断]' : '') + '\n```';

    case 'files': case '文件列表':
      var scanNames = CONTEXT_FILE_NAMES.join('\n  ');
      return '📋 **支持的上下文文件**（按优先级排序）:\n\n  ' + scanNames + '\n\n已找到: ' + (Object.keys(state.contextFiles).join(', ') || '无');

    default:
      return '📁 **项目上下文命令**\n\n' +
        '- `/context status` — 查看状态\n' +
        '- `/context set <目录>` — 设置项目目录\n' +
        '- `/context refresh` — 重新扫描\n' +
        '- `/context toggle` — 开关自动注入\n' +
        '- `/context read <文件名>` — 查看文件内容\n' +
        '- `/context files` — 查看支持的文件类型\n' +
        '- `/context clear` — 清除上下文';
  }
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.projectContext = {
      scanAndLoad: scanAndLoad,
      getContextString: getContextString,
      hasContext: hasContext,
      getStatus: getStatus,
      setAutoInject: setAutoInject,
      refresh: refresh,
      getFileContent: getFileContent,
      clear: clear,
      handleCommand: handleContextCommand,
      CONTEXT_FILE_NAMES: CONTEXT_FILE_NAMES
    };

    // 从配置中恢复项目目录
    if (Core.config && Core.config.projectDir) {
      scanAndLoad(Core.config.projectDir);
    }
    if (Core.config && Core.config.projectContextAutoInject !== undefined) {
      state.autoInject = !!Core.config.projectContextAutoInject;
    }

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/pctx', function(args) {
        return handleContextCommand(args);
      });
    }

    console.log('✅ 项目上下文协议模块已加载');
  }
};
