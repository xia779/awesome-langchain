// modules/present-files.js - 文件展示卡片模块
// 检测工具执行结果中的文件路径，渲染可交互的文件卡片
// 支持打开文件、打开所在目录、复制路径等操作

var Core = null;
var fs = null;
var path = null;
var shell = null;

try {
  fs = require('fs');
  path = require('path');
  shell = require('electron').shell;
} catch (e) { console.warn('⚠️ [present-files] 操作失败:', e.message || e); }

// 已处理的文件路径集合（防重复）
var presentedFiles = new WeakSet();

// ═══════════════════════════════════════════
// 文件类型检测
// ═══════════════════════════════════════════

var FILE_ICONS = {
  '.js': '📜', '.ts': '📜', '.py': '🐍', '.html': '🌐', '.htm': '🌐',
  '.css': '🎨', '.scss': '🎨', '.less': '🎨',
  '.md': '📝', '.txt': '📄', '.log': '📋',
  '.json': '📊', '.xml': '📊', '.yaml': '📊', '.yml': '📊', '.toml': '📊',
  '.pdf': '📕', '.docx': '📘', '.doc': '📘', '.xlsx': '📗', '.xls': '📗',
  '.pptx': '📙', '.ppt': '📙', '.csv': '📊',
  '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️', '.ico': '🖼️',
  '.zip': '📦', '.tar': '📦', '.gz': '📦', '.7z': '📦', '.rar': '📦',
  '.mp3': '🎵', '.wav': '🎵', '.mp4': '🎬', '.avi': '🎬', '.mkv': '🎬',
  '.exe': '⚙️', '.bat': '⚙️', '.sh': '⚙️', '.ps1': '⚙️',
  '.sql': '🗃️', '.db': '🗃️', '.sqlite': '🗃️',
  '.gitignore': '🔧', '.env': '🔒', '.lock': '🔒',
  'default': '📄'
};

function getFileIcon(filepath) {
  var ext = path.extname(filepath).toLowerCase();
  var basename = path.basename(filepath).toLowerCase();
  if (FILE_ICONS[basename]) return FILE_ICONS[basename];
  return FILE_ICONS[ext] || FILE_ICONS['default'];
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 从文本中提取文件路径
 */
function extractFilePaths(text) {
  if (!text || typeof text !== 'string') return [];
  var paths = [];

  // 匹配 Windows 路径 (C:\..., D:\..., E:\...)
  var winPattern = /[A-Za-z]:\\[^\s<>:"|?*\u0000-\u001F]+/g;
  var matches = text.match(winPattern);
  if (matches) paths = paths.concat(matches);

  // 匹配 Unix 路径 (/home/..., /tmp/...)
  var unixPattern = /(?:\/(?:home|tmp|var|usr|opt|root|mnt|media))[^\s]+/g;
  var unixMatches = text.match(unixPattern);
  if (unixMatches) paths = paths.concat(unixMatches);

  // 去重并验证
  var unique = [];
  var seen = {};
  paths.forEach(function(p) {
    p = p.replace(/[.,;:)]$/, ''); // 去除尾部标点
    if (!seen[p] && fs && fs.existsSync(p)) {
      seen[p] = true;
      unique.push(p);
    }
  });

  return unique;
}

// ═══════════════════════════════════════════
// 文件卡片 UI
// ═══════════════════════════════════════════

function createFileCard(filepath) {
  var basename = path.basename(filepath);
  var ext = path.extname(filepath).toLowerCase();
  var icon = getFileIcon(filepath);

  // 获取文件信息
  var stat = null;
  var sizeStr = '';
  var modifiedStr = '';
  try {
    stat = fs.statSync(filepath);
    sizeStr = formatFileSize(stat.size);
    modifiedStr = stat.mtime.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { console.warn('⚠️ [present-files] 操作失败:', e.message || e); }

  // 卡片容器
  var card = document.createElement('div');
  card.className = 'file-card';

  // 文件信息行
  var infoRow = document.createElement('div');
  infoRow.className = 'file-card-info';

  var iconEl = document.createElement('span');
  iconEl.className = 'file-card-icon';
  iconEl.textContent = icon;
  infoRow.appendChild(iconEl);

  var details = document.createElement('div');
  details.className = 'file-card-details';

  var nameEl = document.createElement('div');
  nameEl.className = 'file-card-name';
  nameEl.textContent = basename;
  nameEl.title = filepath;
  details.appendChild(nameEl);

  var metaEl = document.createElement('div');
  metaEl.className = 'file-card-meta';
  var metaParts = [];
  if (sizeStr) metaParts.push(sizeStr);
  if (ext) metaParts.push(ext.toUpperCase().replace('.', '') + ' 文件');
  if (modifiedStr) metaParts.push(modifiedStr);
  metaEl.textContent = metaParts.join(' · ');
  details.appendChild(metaEl);

  infoRow.appendChild(details);
  card.appendChild(infoRow);

  // 操作按钮
  var actions = document.createElement('div');
  actions.className = 'file-card-actions';

  // 打开文件
  var openBtn = document.createElement('button');
  openBtn.className = 'file-card-btn file-card-open';
  openBtn.innerHTML = '📂 打开';
  openBtn.title = '用默认程序打开文件';
  openBtn.addEventListener('click', function() {
    if (shell) {
      shell.openPath(filepath).then(function(err) {
        if (err) openBtn.textContent = '❌ 打开失败';
        else { openBtn.textContent = '✅ 已打开'; setTimeout(function() { openBtn.innerHTML = '📂 打开'; }, 2000); }
      });
    }
  });
  actions.appendChild(openBtn);

  // 打开所在目录
  var revealBtn = document.createElement('button');
  revealBtn.className = 'file-card-btn file-card-reveal';
  revealBtn.innerHTML = '📁 目录';
  revealBtn.title = '在文件管理器中显示';
  revealBtn.addEventListener('click', function() {
    if (shell) {
      shell.showItemInFolder(filepath);
      revealBtn.textContent = '✅ 已定位';
      setTimeout(function() { revealBtn.innerHTML = '📁 目录'; }, 2000);
    }
  });
  actions.appendChild(revealBtn);

  // 复制路径
  var copyBtn = document.createElement('button');
  copyBtn.className = 'file-card-btn file-card-copy';
  copyBtn.innerHTML = '📋 路径';
  copyBtn.title = '复制文件路径';
  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(filepath).then(function() {
      copyBtn.textContent = '✅ 已复制';
      setTimeout(function() { copyBtn.innerHTML = '📋 路径'; }, 2000);
    });
  });
  actions.appendChild(copyBtn);

  card.appendChild(actions);
  return card;
}

// ═══════════════════════════════════════════
// MutationObserver — 自动检测文件路径
// ═══════════════════════════════════════════

function processMessage(msgEl) {
  if (!msgEl || !msgEl.classList || !msgEl.classList.contains('ai')) return;

  // 查找包含文件路径的文本节点
  var walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, null, false);
  var textNodes = [];
  while (walker.nextNode()) {
    var node = walker.currentNode;
    if (node.textContent && /[A-Za-z]:\\/.test(node.textContent)) {
      textNodes.push(node);
    }
  }

  // 从文本节点中提取路径并生成卡片
  var allPaths = [];
  textNodes.forEach(function(node) {
    var paths = extractFilePaths(node.textContent);
    allPaths = allPaths.concat(paths);
  });

  // 也检查 agent 步骤行中的文件路径
  var stepRows = msgEl.querySelectorAll('.agent-step-live');
  stepRows.forEach(function(row) {
    var text = row.textContent || '';
    var paths = extractFilePaths(text);
    allPaths = allPaths.concat(paths);
  });

  // 去重
  var seen = {};
  var uniquePaths = [];
  allPaths.forEach(function(p) {
    if (!seen[p]) {
      seen[p] = true;
      uniquePaths.push(p);
    }
  });

  if (uniquePaths.length > 0) {
    // 检查是否已经添加过文件卡片
    if (presentedFiles.has(msgEl)) return;
    presentedFiles.add(msgEl);

    // 在消息末尾添加文件卡片容器
    var container = document.createElement('div');
    container.className = 'file-cards-container';

    var header = document.createElement('div');
    header.className = 'file-cards-header';
    header.textContent = '📎 生成的文件 (' + uniquePaths.length + ')';
    container.appendChild(header);

    uniquePaths.forEach(function(filepath) {
      container.appendChild(createFileCard(filepath));
    });

    // 在时间戳之前插入
    var timestamp = msgEl.querySelector('.msg-timestamp');
    if (timestamp) {
      msgEl.insertBefore(container, timestamp);
    } else {
      msgEl.appendChild(container);
    }
  }
}

function startObserver() {
  // 通过统一 chatObserver 分发，不再创建独立 MutationObserver
  if (!Core.chatObserver) {
    console.warn('present-files: Core.chatObserver 不可用');
    return;
  }
  Core.chatObserver.onMessage(function(node) {
    if (node.classList.contains('msg')) {
      setTimeout(function() { processMessage(node); }, 500);
    }
  });
}

// ═══════════════════════════════════════════
// 公开 API — 手动展示文件
// ═══════════════════════════════════════════

/**
 * 在聊天中展示文件卡片
 * @param {string|string[]} filePaths - 文件路径或路径数组
 * @param {string} [message] - 可选的描述消息
 */
function presentFile(filePaths, message) {
  var paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  if (paths.length === 0) return;

  // 构建消息文本
  var msgText = '';
  if (message) msgText = message + '\n\n';
  msgText += '📎 **生成的文件：**\n';
  paths.forEach(function(p) {
    msgText += '- `' + p + '`\n';
  });

  // 添加为 AI 消息
  if (Core.session && Core.session.addMessage) {
    Core.session.addMessage(msgText, 'ai');
    // MutationObserver 会自动检测路径并生成卡片
  }
}

/**
 * 展示文件并返回可嵌入的 HTML 片段
 */
function presentFileHtml(filePaths, message) {
  var paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  var html = '';
  if (message) html += '<p>' + message + '</p>';
  paths.forEach(function(p) {
    var basename = path.basename(p);
    var icon = getFileIcon(p);
    html += '<div style="display:flex;align-items:center;gap:8px;padding:8px;margin:4px 0;background:var(--bg-secondary);border-radius:8px;">' +
      '<span style="font-size:20px">' + icon + '</span>' +
      '<span style="font-weight:500">' + basename + '</span>' +
      '<span style="color:var(--text-secondary);font-size:12px">' + p + '</span>' +
      '</div>';
  });
  return html;
}

// ═══════════════════════════════════════════
// /file 命令扩展
// ═══════════════════════════════════════════

function handleFilePresentCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || '').toLowerCase();

  if (sub === 'open' && parts[1]) {
    var filepath = parts.slice(1).join(' ');
    if (!fs || !fs.existsSync(filepath)) return '❌ 文件不存在: ' + filepath;
    if (shell) {
      shell.openPath(filepath).then(function(err) {
        return err ? '❌ 打开失败: ' + err : '✅ 已打开: ' + filepath;
      });
      return '⏳ 正在打开: ' + filepath;
    }
    return '❌ shell 不可用';
  }

  if (sub === 'reveal' && parts[1]) {
    var filepath = parts.slice(1).join(' ');
    if (shell) {
      shell.showItemInFolder(filepath);
      return '📁 已在文件管理器中定位: ' + filepath;
    }
    return '❌ shell 不可用';
  }

  if (sub === 'present' && parts[1]) {
    var filepath = parts.slice(1).join(' ');
    if (!fs || !fs.existsSync(filepath)) return '❌ 文件不存在: ' + filepath;
    presentFile(filepath, '手动展示文件');
    return '✅ 文件卡片已展示';
  }

  return '📎 **文件展示命令**\n\n' +
    '- `/file present <路径>` — 在聊天中展示文件卡片\n' +
    '- `/file open <路径>` — 用默认程序打开文件\n' +
    '- `/file reveal <路径>` — 在文件管理器中定位文件';
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.presentFiles = {
      presentFile: presentFile,
      presentFileHtml: presentFileHtml,
      createFileCard: createFileCard,
      extractFilePaths: extractFilePaths,
      handleCommand: handleFilePresentCommand,
      getFileIcon: getFileIcon
    };

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/filecard', function(args) {
        return handleFilePresentCommand(args);
      });
    }

    // 启动观察器
    setTimeout(startObserver, 800);

    console.log('✅ 文件展示卡片模块已加载');
  }
};
