// modules/ui-interactions.js — 文件拖拽、剪贴板粘贴、快捷键、主题切换
// 从 core-v10.js IIFE 中提取

var fs = (typeof require !== 'undefined') ? require('fs') : (window.fs || {});
var path = (typeof require !== 'undefined') ? require('path') : (window.path || {});

var Core = null;

function initFileDragDrop() {
  var chatContainer = document.getElementById('chatContainer');
  var inputArea = document.getElementById('input-area');
  
  // 聊天区域拖拽：直接发送
  if (chatContainer) {
    chatContainer.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.target.closest('#input-area')) {
        chatContainer.classList.add('drag-over');
      }
    });
    chatContainer.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target === chatContainer) chatContainer.classList.remove('drag-over');
    });
    chatContainer.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      chatContainer.classList.remove('drag-over');
      if (e.target.closest('#input-area')) return;
      var files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (var i = 0; i < files.length; i++) handleDroppedFile(files[i]);
    });
  }
  
  // 输入区域拖拽：暂存为附件
  if (inputArea) {
    inputArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      inputArea.classList.add('drag-over');
    });
    inputArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target === inputArea) inputArea.classList.remove('drag-over');
    });
    inputArea.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      inputArea.classList.remove('drag-over');
      var files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (var i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
          handleImageToInput(files[i]);
        } else {
          handleDroppedFile(files[i]);
        }
      }
    });
  }
  
  console.log('✅ 文件拖拽已启用（聊天区域直接发送，输入区域暂存为附件）');
}

function handleImageToInput(file) {
  if (!file.type.startsWith('image/')) {
    alert('请拖拽图片文件');
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    var dataUrl = e.target.result;
    Core.pendingImage = dataUrl;
    showAttachmentPreview(dataUrl);
  };
  reader.readAsDataURL(file);
}

function showAttachmentPreview(dataUrl) {
  var preview = document.getElementById('attachmentPreview');
  if (!preview) return;
  preview.innerHTML = '';
  preview.style.display = 'flex';
  
  var container = document.createElement('div');
  container.style.cssText = 'position:relative; display:inline-block;';
  
  var img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'max-width:80px; max-height:80px; border-radius:8px; object-fit:cover; border:1px solid var(--border);';
  
  var removeBtn = document.createElement('button');
  removeBtn.innerHTML = '\u00d7';
  removeBtn.style.cssText = 'position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; background:#ef4444; color:#fff; border:none; font-size:12px; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0; line-height:1;';
  removeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    Core.pendingImage = null;
    preview.style.display = 'none';
    preview.innerHTML = '';
  });
  
  container.appendChild(img);
  container.appendChild(removeBtn);
  preview.appendChild(container);
}

function handleDroppedFile(file) {
  if (file.type.startsWith('image/')) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result;
      var base64 = dataUrl.split(',')[1];
      
      // 🔧 将图片保存为消息到 session
      if (Core.session && Core.session.addMessage) {
        Core.session.addMessage('![图片](' + dataUrl + ')', 'user');
      }
      
      // 调用图片识别，结果放入输入框
      Core.dom.status.textContent = '🖼️ 正在分析图片...';
      if (Core.api && Core.api.describeImage) {
        Core.api.describeImage(base64, '请详细描述这张图片的内容').then(function(desc) {
          var input = document.getElementById('input');
          input.value = (input.value ? input.value + '\n' : '') + '📷 图片描述：' + desc;
          input.focus();
          Core.dom.status.textContent = '✅ 图片描述已生成，可继续输入或发送';
          setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 3000);
        }).catch(function(err) { console.error('图片分析失败:', err); });
      }
    };
    reader.readAsDataURL(file);
  } else if (/\.(pdf|docx|doc|xlsx|xls|csv|pptx|ppt)$/i.test(file.name)) {
    // 📄 文档格式：保存为附件，用户发送时 AI 可直接读取文件
    var icon = '📄';
    var ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (ext === '.pdf') icon = '📕';
    else if (ext === '.docx' || ext === '.doc') icon = '📘';
    else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') icon = '📗';
    else if (ext === '.pptx' || ext === '.ppt') icon = '📙';

    // 保存到临时目录
    var tmpDir = path.join(Core.DATA_ROOT || Core._globalDataRoot || '.', 'tmp');
    if (!fs.existsSync(tmpDir)) { try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) { console.warn('[UI] Failed to create tmp dir:', e.message); } }
    var tmpPath = path.join(tmpDir, file.name);

    Core.dom.status.textContent = icon + ' 正在保存文档 ' + file.name + '...';
    var reader = new FileReader();
    reader.onload = function(e) {
      fs.writeFileSync(tmpPath, Buffer.from(e.target.result));

      // 🔧 存储为待发送附件（而非提取文本到输入框）
      if (!Core.pendingFiles) Core.pendingFiles = [];
      Core.pendingFiles.push({ name: file.name, path: tmpPath, icon: icon, size: file.size });

      // 显示附件预览芯片
      showFileAttachmentPreview(Core.pendingFiles);

      Core.dom.status.textContent = '✅ 附件已添加: ' + file.name + ' (发送时 AI 将自动读取)';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 3000);
    };
    reader.readAsArrayBuffer(file);
  } else if (file.type.startsWith('text/') || /\.(md|txt|json|js|py|css|html|xml|yaml|yml)$/i.test(file.name)) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var input = document.getElementById('input');
      var prefix = '📄 文件「' + file.name + '」内容:\n\\`\\`\\`\\n';
      var suffix = '\\n\\`\\`\\`\\n';
      input.value = (input.value ? input.value + '\\n\\n' : '') + prefix + e.target.result + suffix;
      input.focus();
      Core.dom.status.textContent = '✅ 文件「' + file.name + '」已载入';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    };
    reader.readAsText(file);
  } else {
    var input = document.getElementById('input');
    input.value = (input.value ? input.value + '\n' : '') + '📎 文件「' + file.name + '」(' + (file.size / 1024).toFixed(1) + ' KB)';
    input.focus();
  }
}

function showFileAttachmentPreview(files) {
  var preview = document.getElementById('fileAttachmentPreview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'fileAttachmentPreview';
    preview.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:6px 10px;background:#1a1a2e;border:1px solid #333;border-radius:8px 8px 0 0;margin-bottom:-1px;';
    var inputArea = document.getElementById('input-area');
    if (inputArea) {
      var input = document.getElementById('input');
      inputArea.insertBefore(preview, input ? input.parentElement : inputArea.firstChild);
    } else {
      var input = document.getElementById('input');
      if (input && input.parentElement) input.parentElement.insertBefore(preview, input);
    }
  }
  preview.innerHTML = '';
  files.forEach(function(f, idx) {
    var chip = document.createElement('div');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#2a2a3e;border:1px solid #444;border-radius:16px;font-size:12px;color:#ddd;cursor:default;';
    chip.innerHTML = '<span>' + f.icon + '</span><span>' + f.name + '</span><span style="color:#888;font-size:11px;">(' + (f.size / 1024).toFixed(0) + 'KB)</span><span style="cursor:pointer;color:#f66;margin-left:4px;font-size:14px;" title="移除">&times;</span>';
    chip.querySelector('span:last-child').addEventListener('click', function() {
      files.splice(idx, 1);
      if (files.length === 0) {
        preview.remove();
      } else {
        showFileAttachmentPreview(files);
      }
    });
    preview.appendChild(chip);
  });
}

// 获取待发送文件信息（供 sendMessage 使用）
function getPendingFiles() {
  var files = Core.pendingFiles || [];
  return files;
}

// 清除待发送文件
function clearPendingFiles() {
  Core.pendingFiles = [];
  var preview = document.getElementById('fileAttachmentPreview');
  if (preview) preview.remove();
}

function initClipboardPaste() {
  document.addEventListener('paste', function(e) {
    var input = document.getElementById('input');
    var isInputFocused = document.activeElement === input;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var hasImage = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        hasImage = true;
        var blob = items[i].getAsFile();
        var reader = new FileReader();
        reader.onload = function(event) {
          var dataUrl = event.target.result;
          var base64 = dataUrl.split(',')[1];
          
          // 🔧 将图片保存为消息到 session
          if (Core.session && Core.session.addMessage) {
            Core.session.addMessage('![图片](' + dataUrl + ')', 'user');
          }
          
          Core.dom.status.textContent = '🖼️ 正在分析图片...';
          if (Core.api && Core.api.describeImage) {
            Core.api.describeImage(base64, '请详细描述这张图片的内容').then(function(desc) {
              var inp = document.getElementById('input');
              inp.value = (inp.value ? inp.value + '\n' : '') + '📷 图片描述：' + desc;
              if (isInputFocused) inp.focus();
              Core.dom.status.textContent = '✅ 图片描述已生成，可继续输入或发送';
              setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 3000);
            }).catch(function(err) { console.error('图片分析失败:', err); });
          }
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
    if (hasImage) e.preventDefault();
  });
  console.log('✅ 剪贴板图片粘贴已启用');
}

var _inputHistory = [];
var _historyIndex = -1;
var _currentQuote = null; // 当前引用的消息 { msgIndex, role, content }

function initShortcuts() {
  // 通过统一 keyboard 分发器注册（priority 5 = 最先执行）
  if (!Core.keyboard) { console.warn('ui-interactions: Core.keyboard 不可用'); return; }
  Core.keyboard.register('ui-interactions', 5, function(e) {
    var input = document.getElementById('input');
    if (!input) return;
    var isInputFocused = document.activeElement === input;
    var key = e.key.toLowerCase();

    // Ctrl+K: 聚焦输入框并全选
    if (key === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      input.focus();
      input.select();
      return false;
    }
    // Ctrl+N: 新建会话
    if (key === 'n' && (e.ctrlKey || e.metaKey) && !isInputFocused) {
      e.preventDefault();
      if (Core.session && typeof Core.session.newChat === 'function') {
        Core.session.newChat('chat', null);
      }
      return false;
    }
    // Esc: 优先退出多选模式，其次停止生成
    if (e.key === 'Escape') {
      var multiSelectBtn = document.getElementById('multiSelectToggle');
      if (multiSelectBtn && multiSelectBtn.classList.contains('active')) {
        e.preventDefault();
        if (Core.exitMultiSelectMode) Core.exitMultiSelectMode();
        return false;
      }
      if (Core.api) {
        var wasGenerating = typeof Core.api.isGenerating === 'function' && Core.api.isGenerating();
        if (wasGenerating && Core.api.stopGeneration) {
          e.preventDefault();
          Core.api.stopGeneration();
          return false;
        }
      }
      return; // 不阻止后续 Escape 处理器（清空输入框等）
    }
    // Ctrl+Shift+S: 截图分析
    if (key === 's' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      if (Core.screenshot && Core.screenshot.capture) {
        Core.screenshot.capture();
      }
      return false;
    }
    // Ctrl+Shift+F: 聚焦输入框
    if (key === 'f' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      input.focus();
      return false;
    }
    // Ctrl+↑/↓: 切换历史输入
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.ctrlKey && isInputFocused) {
      e.preventDefault();
      var direction = e.key === 'ArrowUp' ? -1 : 1;
      _historyIndex += direction;
      if (_historyIndex < 0) _historyIndex = 0;
      if (_historyIndex >= _inputHistory.length) _historyIndex = _inputHistory.length - 1;
      if (_inputHistory.length > 0 && _historyIndex >= 0) {
        input.value = _inputHistory[_historyIndex];
      }
      return false;
    }
    // Ctrl+/: 显示/隐藏快捷键面板
    // 使用 e.keyCode 兼容不同键盘布局（191 = 主键盘 / 键）
    if ((e.key === '/' || e.keyCode === 191) && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      var hint = document.getElementById('shortcutHint');
      if (hint) {
        hint.classList.toggle('show');
      }
      return false;
    }
    if (key === 'e' && (e.ctrlKey || e.metaKey) && !isInputFocused) {
      e.preventDefault();
      if (Core.export && Core.export.exportCurrentSession) {
        Core.export.exportCurrentSession('json');
      }
      return false;
    }
    // Ctrl+1~9: 快速切换会话
    if (key >= '1' && key <= '9' && (e.ctrlKey || e.metaKey) && !isInputFocused) {
      e.preventDefault();
      var index = parseInt(key) - 1;
      if (Core.session && Core.session.getSessionList) {
        var list = Core.session.getSessionList();
        if (list && list[index]) {
          var sessionId = list[index].id;
          Core.session.switchSession(sessionId);
          Core.dom.status.textContent = '✅ 已切换到: ' + (list[index].title || '会话');
          setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
        } else {
          Core.dom.status.textContent = '⚠️ 会话不存在';
          setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
        }
      }
      return false;
    }
    // Enter 发送时记录到历史
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isInputFocused) {
      if (input.value.trim()) {
        _inputHistory.push(input.value.trim());
        if (_inputHistory.length > 50) _inputHistory.shift();
        _historyIndex = _inputHistory.length;
      }
    }
  });
  console.log('✅ 快捷键系统已启用 (统一 keyboard 分发器)');
}

var _systemMediaQuery = null;

function applyTheme(theme) {
  var root = document.documentElement;
  var body = document.body;

  // 清理之前的系统监听
  if (_systemMediaQuery) {
    _systemMediaQuery.removeListener(_systemThemeHandler);
    _systemMediaQuery = null;
  }

  if (theme === 'system') {
    // 跟随系统：检测 prefers-color-scheme
    _systemMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    _systemMediaQuery.addListener(_systemThemeHandler);
    _applyResolvedTheme(_systemMediaQuery.matches ? 'dark' : 'light');
  } else {
    _applyResolvedTheme(theme);
  }
  Core.saveConfig({ theme: theme });
}

function _systemThemeHandler(e) {
  _applyResolvedTheme(e.matches ? 'dark' : 'light');
}

function _applyResolvedTheme(resolved) {
  var root = document.documentElement;
  var body = document.body;
  if (resolved === 'dark') {
    body.classList.add('dark-theme');
    body.classList.remove('light-theme');
    Core.syncCodeHighlighter(true);
    root.style.setProperty('--bg', '#0f172a');
    root.style.setProperty('--panel', '#1e293b');
    root.style.setProperty('--text', '#e2e8f0');
    root.style.setProperty('--text-secondary', '#94a3b8');
    root.style.setProperty('--border', '#334155');
    root.style.setProperty('--shadow', '0 4px 24px rgba(0,0,0,0.3)');
    root.style.setProperty('--shadow-lg', '0 8px 32px rgba(0,0,0,0.4)');
  } else {
    body.classList.add('light-theme');
    body.classList.remove('dark-theme');
    Core.syncCodeHighlighter(false);
    root.style.setProperty('--bg', '#f8fafc');
    root.style.setProperty('--panel', '#ffffff');
    root.style.setProperty('--text', '#1e293b');
    root.style.setProperty('--text-secondary', '#64748b');
    root.style.setProperty('--border', '#e2e8f0');
    root.style.setProperty('--shadow', '0 4px 24px rgba(0,0,0,0.08)');
    root.style.setProperty('--shadow-lg', '0 8px 32px rgba(0,0,0,0.12)');
  }
}

function initTheme() {
  if (initTheme._done) return;
  initTheme._done = true;
  var savedTheme = Core.config.theme || 'dark';
  applyTheme(savedTheme);
  // 监听主题选择下拉框
  var themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.value = savedTheme;
    themeSelect.addEventListener('change', function() { applyTheme(this.value); });
  }
  console.log('✅ 主题系统已启用, 当前主题:', savedTheme);
}

// ===== Module Export =====
module.exports = {
  name: 'ui-interactions',
  dependencies: ['html-utils', 'ui-media'],
  init: function(_Core) {
    Core = _Core;
    // Attach public API
    Core.getPendingFiles = getPendingFiles;
    Core.clearPendingFiles = clearPendingFiles;
    Core.applyTheme = applyTheme;
    Core.inputHistory = _inputHistory || [];

    // Auto-initialize
    initFileDragDrop();
    initClipboardPaste();
    initShortcuts();
    initTheme();
    console.log('✅ ui-interactions 已初始化（拖拽 + 粘贴 + 快捷键 + 主题）');
  }
};
