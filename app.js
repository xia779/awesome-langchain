// ===== app.js - Extracted from index.html =====
// Ensure Node.js module resolution works for external JS file
try {
  var _path = require("path");
  var _projectNodeModules = _path.join(__dirname, "node_modules");
  if (typeof module !== "undefined" && module.paths && !module.paths.includes(_projectNodeModules)) {
    module.paths.unshift(_projectNodeModules);
  }
} catch (e) { console.warn("[app.js] module.paths fix failed:", e.message); }


// ===== Block: module.paths fixer (from index.html L4535-L4546) =====

  // 🔧 修复 renderer 进程的 module.paths，确保能找到项目目录的 node_modules
  if (typeof module !== 'undefined' && module.paths) {
    try {
      const projectDir = window.location.href.replace('file:///', '').replace('/index.html', '').replace(/\//g, '\\');
      const projectNodeModules = projectDir + '\\node_modules';
      if (!module.paths.includes(projectNodeModules)) {
        module.paths.unshift(projectNodeModules);
      }
    } catch (e) {}
  }


// ===== Block: stop-generation wrapper (from index.html L4550-L4654) =====

(function initStopGeneration() {
  if (!window.Core || !Core.dom || !Core.dom.sendBtn) {
    setTimeout(initStopGeneration, 500);
    return;
  }
  // 等待 Core.api.sendMessage 存在
  if (!Core.api || !Core.api.sendMessage) {
    setTimeout(initStopGeneration, 500);
    return;
  }

  var sendBtn = Core.dom.sendBtn;
  var isGenerating = false;
  var abortCtrl = null;
  var currentAiDiv = null;

  // 保存原始 sendMessage
  var origSendMessage = Core.api.sendMessage;

  function setGenState(generating) {
    isGenerating = generating;
    if (generating) {
      sendBtn.textContent = '⏹';
      sendBtn.style.background = '#ef4444';
      sendBtn.style.color = '#fff';
    } else {
      sendBtn.textContent = '↑';
      sendBtn.style.background = '';
      sendBtn.style.color = '';
    }
    sendBtn.disabled = false;
  }

  // 包装 sendMessage
  function wrappedSendMessage() {
    if (isGenerating) {
      if (abortCtrl) { try { abortCtrl.abort(); } catch(e) {} }
      isGenerating = false;
      sendBtn.textContent = '↑';
      sendBtn.style.background = '';
      Core.dom.status.textContent = '⏹ 已停止';
      setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 1500);
      return;
    }
    
    // 🔧 快捷指令解析（custom.js）
    var input = Core.dom.input.value.trim();
    if (input && input.startsWith('/') && Core.custom && Core.custom.executeCommand) {
      var handled = Core.custom.executeCommand(input);
      if (handled) {
        Core.dom.input.value = '';
        return;
      }
    }
    
    if (origSendMessage) return origSendMessage.apply(this, arguments);
  }

  // 覆盖 Core.api.sendMessage
  Core.api.sendMessage = wrappedSendMessage;
  // 🔧 关键：使用 onclick 覆盖所有旧事件监听器
  sendBtn.onclick = wrappedSendMessage;

  // 监听 typing 事件
  Core.on('typingStart', function() { setGenState(true); });
  Core.on('typingEnd', function() { setGenState(false); });

  // 覆盖 callAPIStream
  if (Core.api && Core.api.callAPIStream) {
    var origCallAPIStream = Core.api.callAPIStream;
    Core.api.callAPIStream = function(prompt, systemMsg, temp, model, provider, onChunk) {
      var aiDivs = document.querySelectorAll('.msg.ai');
      currentAiDiv = aiDivs[aiDivs.length - 1] || null;
      abortCtrl = new AbortController();
      var wrappedOnChunk = function(chunk, fullText) {
        if (!isGenerating) return;
        if (typeof onChunk === 'function') onChunk(chunk, fullText);
      };
      try {
        return origCallAPIStream(prompt, systemMsg, temp, model, provider, wrappedOnChunk, abortCtrl.signal);
      } catch(e) {
        return origCallAPIStream(prompt, systemMsg, temp, model, provider, wrappedOnChunk);
      }
    };
  }

  // 🔧 覆盖 callAPI 同样添加中断支持（非流式模式）
  if (Core.api && Core.api.callAPI) {
    var origCallAPI = Core.api.callAPI;
    Core.api.callAPI = function(prompt, systemMsg, temp, model, provider, messagesOverride) {
      if (!isGenerating) {
        console.log('⏹ callAPI 被拦截（生成已停止，跳过后续调用）');
        return Promise.resolve({ message: { content: '' }, response: '' });
      }
      return origCallAPI.apply(this, arguments);
    };
  }
})();


// ===== Block: sidebar toggle (from index.html L4657-L4669) =====

  (function() {
    const menuBtn = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const mainArea = document.getElementById('main-container');
    if (!menuBtn || !sidebar || !mainArea) return;
    menuBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      sidebar.classList.toggle('hidden');
      mainArea.classList.toggle('expanded');
    });
  })();


// ===== Block: context menu (from index.html L4674-L4801) =====

  (function() {
    const contextMenu = document.getElementById('contextMenu');
    let currentTarget = null;
    let targetType = null;

    function hideMenu() { contextMenu.style.display = 'none'; }
    function showMenu(e, type, target) {
      e.preventDefault();
      currentTarget = target;
      targetType = type;
      contextMenu.style.display = 'block';
      contextMenu.style.left = e.clientX + 'px';
      contextMenu.style.top = e.clientY + 'px';
    }


    const chatList = document.getElementById('chatList');
    if (chatList) {
      chatList.addEventListener('contextmenu', function(e) {
        const item = e.target.closest('.chat-item');
        if (item) showMenu(e, 'session', item);
      });
    }

    document.addEventListener('click', function(e) {
      if (!contextMenu.contains(e.target)) hideMenu();
    });

    function showCustomPrompt(title, defaultValue, callback) {
      const overlay = document.getElementById('customPromptOverlay');
      const input = document.getElementById('customPromptInput');
      const titleEl = document.getElementById('customPromptTitle');
      const confirmBtn = document.getElementById('customPromptConfirm');
      const cancelBtn = document.getElementById('customPromptCancel');

      titleEl.textContent = title || '✏️ 重命名会话';
      input.value = defaultValue || '';
      overlay.classList.add('show');
      input.focus();
      input.select();

      function cleanup() {
        overlay.classList.remove('show');
        confirmBtn.onclick = null;  // 🔧 使用 onclick 避免监听器累积
        cancelBtn.onclick = null;
        input.onkeydown = null;
      }
      confirmBtn.onclick = function() { const val = input.value.trim(); cleanup(); if (val) callback(val); };
      cancelBtn.onclick = function() { cleanup(); callback(null); };
      input.onkeydown = function(e) {
        if (e.key === 'Enter') { const val = input.value.trim(); cleanup(); if (val) callback(val); }
        else if (e.key === 'Escape') { cleanup(); callback(null); }
      };
    }

    contextMenu.addEventListener('click', function(e) {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      const action = item.dataset.action;
      if (!action) return;

      if (targetType === 'session' && !currentTarget) {
        showToast('无法获取会话信息，请重试', 'error');
        hideMenu();
        return;
      }

      if (targetType === 'session') {
        const sessionId = currentTarget.dataset.id;
        if (!sessionId) { showToast('无法获取会话 ID，请重试', 'error'); hideMenu(); return; }

        if (action === 'export-json' || action === 'export-md' || action === 'export-html' || action === 'export-tree' || action === 'copy-md' || action === 'export-pdf' || action === 'export-docx' || action === 'export-xlsx' || action === 'export-pptx') {
          // 临时切换到目标会话
          var origId = Core.session.getCurrentId();
          if (sessionId !== origId && Core.session.switchSession) Core.session.switchSession(sessionId);
          if (action === 'export-json') Core.export.exportCurrentSession('json');
          else if (action === 'export-md') Core.export.exportCurrentSession('markdown');
          else if (action === 'export-html') Core.export.exportCurrentSessionAsHtml();
          else if (action === 'export-tree') Core.export.exportSessionTree('json');
          else if (action === 'copy-md') Core.export.copySessionToClipboard('markdown');
          else if (Core.docHandler) {
            var msgs = Core.session.getMessages();
            var title = (Core.session.getCurrentTitle && Core.session.getCurrentTitle()) || '导出';
            var content = msgs.map(function(m) { return (m.role === 'user' ? '**用户**: ' : '**AI**: ') + (m.content || m.text || ''); }).join('\n\n');
            if (action === 'export-pdf') Core.docHandler.generatePDF({ title: title, content: content });
            else if (action === 'export-docx') Core.docHandler.generateDOCX({ title: title, content: content });
            else if (action === 'export-xlsx') {
              var rows = msgs.map(function(m, i) { return [i + 1, m.role === 'user' ? '用户' : 'AI', (m.content || m.text || '').substring(0, 500)]; });
              Core.docHandler.generateXLSX({ title: title, sheets: { '聊天记录': { headers: ['序号', '角色', '内容'], rows: rows } } });
            }
            else if (action === 'export-pptx') Core.docHandler.generatePPTX({ title: title, content: content });
          }
          if (sessionId !== origId && Core.session.switchSession) Core.session.switchSession(origId);
          hideMenu();
          return;
        }

        if (action === 'rename') {
          const titleElement = currentTarget.querySelector('.title');
          const currentTitle = titleElement ? titleElement.textContent.replace(/^📌\s*/, '').trim() : '';
          showCustomPrompt('✏️ 重命名会话', currentTitle, function(newTitle) {
            if (newTitle && window.Core && Core.session && typeof Core.session.renameSession === 'function') {
              Core.session.renameSession(sessionId, newTitle);
            }
          });
        } else if (action === 'pin') {
          if (window.Core && Core.session && typeof Core.session.togglePinSession === 'function') {
            Core.session.togglePinSession(sessionId);
          } else { showAlert('置顶功能未加载，请检查模块'); }
        } else if (action === 'delete') {
          if (confirm('确定要删除此会话吗？')) {
            if (window.Core && Core.session && typeof Core.session.deleteSession === 'function') {
              Core.session.deleteSession(sessionId);
            } else { showAlert('删除功能未加载，请检查模块'); }
          }
        }
        hideMenu();
      }
    });

    document.addEventListener('contextmenu', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.closest('#contextMenu')) {
        return;
      }
    });
  })();


// ===== Block: voice/image/export/menu (from index.html L4804-L5177) =====

  (function() {
    const voiceBtn = document.getElementById('voiceBtn');
    if (voiceBtn) {
      let isRecording = false;
      if (window.voice) {
        voiceBtn.addEventListener('click', () => {
          if (isRecording) {
            window.voice.stopListening();
            isRecording = false;
            voiceBtn.textContent = '🎤 语音';
            voiceBtn.classList.remove('recording');
            return;
          }
          voiceBtn.textContent = '⏹️ 停止';
          voiceBtn.classList.add('recording');
          isRecording = true;
          window.voice.startListening(
            (result) => {
              const input = document.getElementById('input');
              if (input) { input.value = result; input.focus(); }
              isRecording = false;
              voiceBtn.textContent = '🎤 语音';
              voiceBtn.classList.remove('recording');
            },
            (error) => {
              console.warn('语音识别错误:', error);
              isRecording = false;
              voiceBtn.textContent = '🎤 语音';
              voiceBtn.classList.remove('recording');
            }
          );
        });
      } else {
        voiceBtn.disabled = true;
        voiceBtn.title = '语音模块未加载';
        voiceBtn.style.opacity = '0.4';
      }
    }

    const speakBtn = document.getElementById('speakBtn');
    if (speakBtn && window.voice) {
      speakBtn.addEventListener('click', () => {
        if (window.voice.isSpeaking()) {
          window.voice.stopSpeaking();
          speakBtn.textContent = '🔊 朗读';
          return;
        }
        const messages = document.querySelectorAll('.msg-ai .msg-content');
        if (messages.length === 0) return;
        const lastMessage = messages[messages.length - 1];
        const text = lastMessage.textContent || '';
        if (!text.trim()) return;
        speakBtn.textContent = '⏹️ 停止';
        window.voice.speak(text, {
          onend: () => { speakBtn.textContent = '🔊 朗读'; }
        });
      });
    }

    const imageBtn = document.getElementById('imageBtn');
    const imageInput = document.createElement('input');
    imageInput.type = 'file';
    imageInput.accept = 'image/*';
    imageInput.style.display = 'none';
    imageInput.id = 'imageInput';
    document.body.appendChild(imageInput);
    // 🔧 多模态图片附件管理
    var _pendingImages = []; // [{dataUrl, name}]
    var _imagePreviewArea = null;

    function ensureImagePreviewArea() {
      if (_imagePreviewArea) return;
      var inputArea = document.getElementById('input-area');
      if (!inputArea) return;
      _imagePreviewArea = document.createElement('div');
      _imagePreviewArea.id = 'imagePreviewArea';
      _imagePreviewArea.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;padding:6px 0;';
      var input = document.getElementById('input');
      if (input && input.parentNode) input.parentNode.insertBefore(_imagePreviewArea, input);
    }

    function addImageToPreview(dataUrl, name) {
      ensureImagePreviewArea();
      if (!_imagePreviewArea) return;
      _pendingImages.push({ dataUrl: dataUrl, name: name || '图片' });
      _imagePreviewArea.style.display = 'flex';
      renderImagePreviews();
    }

    function renderImagePreviews() {
      if (!_imagePreviewArea) return;
      _imagePreviewArea.innerHTML = '';
      if (_pendingImages.length === 0) {
        _imagePreviewArea.style.display = 'none';
        return;
      }
      _pendingImages.forEach(function(img, idx) {
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:relative;display:inline-block;';
        var imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:8px;border:2px solid var(--primary,#3b82f6);';
        var removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;border:none;font-size:12px;cursor:pointer;line-height:1;padding:0;';
        removeBtn.onclick = function() { _pendingImages.splice(idx, 1); renderImagePreviews(); };
        wrapper.appendChild(imgEl);
        wrapper.appendChild(removeBtn);
        _imagePreviewArea.appendChild(wrapper);
      });
    }

    function getPendingImagesMarkdown() {
      return _pendingImages.map(function(img) {
        return '![' + img.name + '](' + img.dataUrl + ')';
      }).join('\n');
    }

    function clearPendingImages() {
      _pendingImages = [];
      if (_imagePreviewArea) { _imagePreviewArea.innerHTML = ''; _imagePreviewArea.style.display = 'none'; }
    }

    // 暴露到全局作用域，供 api.js sendMessage 访问
    window.getPendingImagesMarkdown = getPendingImagesMarkdown;
    window.clearPendingImages = clearPendingImages;
    Object.defineProperty(window, '_pendingImages', {
      get: function() { return _pendingImages; },
      set: function(v) { _pendingImages = v; },
      configurable: true
    });

    // 图片上传按钮 → 附件模式（预览在输入框上方）
    if (imageBtn) {
      imageBtn.addEventListener('click', () => { imageInput.click(); });
      imageInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          showAlert('请上传图片文件');
          imageInput.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = function(event) {
          addImageToPreview(event.target.result, file.name);
          Core.dom.status.textContent = '📎 图片已添加，输入消息后发送';
          setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 2000);
        };
        reader.readAsDataURL(file);
        imageInput.value = '';
      });
    }

    // 🔧 剪贴板粘贴支持（图片 + 纯文本强制）
    var inputEl = document.getElementById('input');
    if (inputEl) {
      inputEl.addEventListener('paste', function(e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        // 优先检测图片
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault();
            var blob = items[i].getAsFile();
            var reader = new FileReader();
            reader.onload = function(event) {
              addImageToPreview(event.target.result, '粘贴的图片');
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
        // 非图片：强制纯文本粘贴（防止 HTML/富文本代码注入）
        var textItem = null;
        for (var j = 0; j < items.length; j++) {
          if (items[j].type === 'text/plain') {
            textItem = items[j];
            break;
          }
        }
        if (textItem) {
          e.preventDefault();
          textItem.getAsString(function(text) {
            var input = document.getElementById('input');
            if (!input) return;
            var start = input.selectionStart;
            var end = input.selectionEnd;
            var before = input.value.substring(0, start);
            var after = input.value.substring(end);
            input.value = before + text + after;
            input.selectionStart = input.selectionEnd = start + text.length;
            input.dispatchEvent(new Event('input'));
          });
        }
      });
    }


    // Escape 清空输入框（通过统一 keyboard 分发器，priority 40）
    if (Core.keyboard) {
      Core.keyboard.register('app-escape-clear', 40, function(e) {
        if (e.key === 'Escape') {
          var input = document.getElementById('input');
          var isInputFocused = document.activeElement === input;
          if (isInputFocused) {
            var isGen = Core.api && typeof Core.api.isGenerating === 'function' && Core.api.isGenerating();
            if (!isGen) {
              e.preventDefault();
              input.value = '';
            }
          }
        }
      });
    }

    // 导出格式选择器
    function showExportSelector() {
      if (!window.Core || !Core.export) { showToast('❌ 导出模块未加载', 'error'); return; }
      var overlay = document.getElementById('exportSelectorOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'exportSelectorOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div style="background:var(--bg-secondary,#1e293b);border:1px solid var(--border,#334155);border-radius:16px;padding:24px;min-width:300px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.4);">'
          + '<h3 style="margin:0 0 16px;color:var(--text,#e2e8f0);font-size:16px;">选择导出格式</h3>'
          + '<div style="display:flex;flex-direction:column;gap:8px;">'
          + '<button data-format="json" style="padding:10px 16px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:8px;color:var(--primary,#3b82f6);cursor:pointer;font-size:13px;text-align:left;">📦 JSON — 完整数据，可导入还原</button>'
          + '<button data-format="markdown" style="padding:10px 16px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);border-radius:8px;color:#10b981;cursor:pointer;font-size:13px;text-align:left;">📝 Markdown — 纯文本，便于分享</button>'
          + '<button data-format="html" style="padding:10px 16px;background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.3);border-radius:8px;color:#f97316;cursor:pointer;font-size:13px;text-align:left;">🌐 HTML — 含代码高亮，可直接浏览</button>'
          + '<button data-format="clipboard" style="padding:10px 16px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);border-radius:8px;color:#8b5cf6;cursor:pointer;font-size:13px;text-align:left;">📋 剪贴板 — 复制 Markdown 到剪贴板</button>'
          + '<button data-format="tree" style="padding:10px 16px;background:rgba(236,72,153,0.15);border:1px solid rgba(236,72,153,0.3);border-radius:8px;color:#ec4899;cursor:pointer;font-size:13px;text-align:left;">🌳 会话树 — 批量导出主会话+子会话</button>'
          + '<div style="height:1px;background:var(--border,#334155);margin:4px 0;"></div>'
          + '<button data-format="pdf" style="padding:10px 16px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);border-radius:8px;color:#ef4444;cursor:pointer;font-size:13px;text-align:left;">📕 PDF — 排版精美的 PDF 文档</button>'
          + '<button data-format="docx" style="padding:10px 16px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);border-radius:8px;color:#3b82f6;cursor:pointer;font-size:13px;text-align:left;">📘 Word — 可编辑的 DOCX 文档</button>'
          + '<button data-format="xlsx" style="padding:10px 16px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);border-radius:8px;color:#10b981;cursor:pointer;font-size:13px;text-align:left;">📗 Excel — 结构化数据的 XLSX 表格</button>'
          + '<button data-format="pptx" style="padding:10px 16px;background:rgba(249,115,22,0.12);border:1px solid rgba(249,115,22,0.3);border-radius:8px;color:#f97316;cursor:pointer;font-size:13px;text-align:left;">📙 PPT — 演示文稿幻灯片</button>'
          + '</div>'
          + '<button id="exportSelectorCancel" style="margin-top:16px;width:100%;padding:8px;background:transparent;border:1px solid var(--border,#334155);border-radius:8px;color:var(--text-secondary,#94a3b8);cursor:pointer;font-size:12px;">取消</button>'
          + '</div>';
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function(e) {
          if (e.target === overlay) overlay.remove();
          var btn = e.target.closest('button[data-format]');
          if (btn) {
            var fmt = btn.dataset.format;
            overlay.remove();
            if (fmt === 'json') Core.export.exportCurrentSession('json');
            else if (fmt === 'markdown') Core.export.exportCurrentSession('markdown');
            else if (fmt === 'html') Core.export.exportCurrentSessionAsHtml();
            else if (fmt === 'clipboard') Core.export.copySessionToClipboard('markdown');
            else if (fmt === 'tree') Core.export.exportSessionTree('json');
            else if (fmt === 'pdf' && Core.docHandler) {
              var msgs = Core.session.getMessages();
              var content = msgs.map(function(m) { return (m.role === 'user' ? '**用户**: ' : '**AI**: ') + (m.content || m.text || ''); }).join('\n\n');
              var title = (Core.session.getCurrentTitle && Core.session.getCurrentTitle()) || '会话导出';
              Core.docHandler.generatePDF({ title: title, content: content }).then(function(r) {
                if (r.success) showToast('📕 PDF 已导出: ' + r.path, 'success');
                else showToast('❌ 导出失败: ' + r.error, 'error');
              });
            }
            else if (fmt === 'docx' && Core.docHandler) {
              var msgs = Core.session.getMessages();
              var content = msgs.map(function(m) { return (m.role === 'user' ? '**用户**: ' : '**AI**: ') + (m.content || m.text || ''); }).join('\n\n');
              var title = (Core.session.getCurrentTitle && Core.session.getCurrentTitle()) || '会话导出';
              Core.docHandler.generateDOCX({ title: title, content: content }).then(function(r) {
                if (r.success) showToast('📘 Word 已导出: ' + r.path, 'success');
                else showToast('❌ 导出失败: ' + r.error, 'error');
              });
            }
            else if (fmt === 'xlsx' && Core.docHandler) {
              var msgs = Core.session.getMessages();
              var rows = msgs.map(function(m, i) { return [i + 1, m.role === 'user' ? '用户' : 'AI', (m.content || m.text || '').substring(0, 500)]; });
              Core.docHandler.generateXLSX({ title: '会话数据', sheets: { '聊天记录': { headers: ['序号', '角色', '内容'], rows: rows } } }).then(function(r) {
                if (r.success) showToast('📗 Excel 已导出: ' + r.path, 'success');
                else showToast('❌ 导出失败: ' + r.error, 'error');
              });
            }
            else if (fmt === 'pptx' && Core.docHandler) {
              var msgs = Core.session.getMessages();
              var content = msgs.map(function(m) { return (m.role === 'user' ? '## 用户\n' : '## AI\n') + (m.content || m.text || ''); }).join('\n\n');
              var title = (Core.session.getCurrentTitle && Core.session.getCurrentTitle()) || '会话演示';
              Core.docHandler.generatePPTX({ title: title, content: content }).then(function(r) {
                if (r.success) showToast('📙 PPT 已导出: ' + r.path, 'success');
                else showToast('❌ 导出失败: ' + r.error, 'error');
              });
            }
          }
        });
        var cancelBtn = overlay.querySelector('#exportSelectorCancel');
        if (cancelBtn) cancelBtn.addEventListener('click', function() { overlay.remove(); });
      } else {
        overlay.style.display = 'flex';
      }
    }

    // 导出按钮点击
    var exportBtnEl = document.getElementById('exportBtn');
    if (exportBtnEl) {
      exportBtnEl.addEventListener('click', showExportSelector);
    }

    // IPC 导出快捷键
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.on('trigger-export', showExportSelector);
    } catch (err) {
      console.warn('IPC 不可用', err);
    }

    // 应用菜单项点击
    document.querySelectorAll('.apps-menu-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var action = this.dataset.action;
        // 关闭应用菜单
        var appsMenu = document.getElementById('appsMenuOverlay');
        if (appsMenu) appsMenu.style.display = 'none';

        if (action === 'export-all') {
          showExportSelector();
        } else if (action === 'new-chat') {
          if (window.Core && Core.session && Core.session.newChat) Core.session.newChat();
        } else if (action === 'knowledge') {
          // 打开设置面板并滚动到知识库区域
          var settingsModal = document.getElementById('settingsModal');
          if (settingsModal) {
            settingsModal.style.display = 'flex';
            var kbGroup = document.getElementById('knowledgeGroup');
            if (kbGroup) {
              setTimeout(function() {
                kbGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // 展开知识库 details 分组
                var details = kbGroup.closest('details');
                if (details) details.open = true;
              }, 200);
            }
          }
        } else if (action === 'agent') {
          // 打开 Agent 面板或显示 Agent 状态
          if (window.Core && Core.agent) {
            var status = Core.agent.getStatus ? Core.agent.getStatus() : {};
            if (Core.custom && Core.custom.executeCommand) {
              Core.custom.executeCommand('/agent');
            } else if (Core.uxPolish && Core.uxPolish.showToast) {
              Core.uxPolish.showToast(status.isRunning ? 'Agent 运行中 (' + status.currentStep + '/' + status.maxSteps + ')' : 'Agent 空闲，输入 /plan 或 /agent 开始', 'info');
            }
          }
        } else if (action === 'tools') {
          // 显示已注册工具列表
          if (window.Core && Core.toolsRegistry && Core.toolsRegistry.listTools) {
            var tools = Core.toolsRegistry.listTools();
            if (Core.custom && Core.custom.executeCommand) {
              Core.custom.executeCommand('/tools');
            } else if (Core.uxPolish && Core.uxPolish.showToast) {
              Core.uxPolish.showToast('已注册工具: ' + (tools ? tools.length : 0) + ' 个', 'info');
            }
          } else if (window.Core && Core.uxPolish && Core.uxPolish.showToast) {
            Core.uxPolish.showToast('工具模块未加载', 'error');
          }
        } else if (action === 'history') {
          // 打开搜索面板（搜索历史记录）
          var searchInput = document.getElementById('searchInput') || document.getElementById('sessionSearch');
          if (searchInput) {
            searchInput.focus();
            searchInput.click && searchInput.click();
          } else if (window.Core && Core.custom && Core.custom.executeCommand) {
            Core.custom.executeCommand('/search');
          } else if (window.Core && Core.uxPolish && Core.uxPolish.showToast) {
            Core.uxPolish.showToast('使用 Ctrl+/ 搜索历史会话', 'info');
          }
        }
      });
    });
  })();


// ===== Block: service tab switcher (from index.html L5180-L5201) =====

  (function() {
    const tabs = document.querySelectorAll('.service-tab');
    if (!tabs.length) return;
    function switchService(service) {
      tabs.forEach(tab => tab.classList.remove('active'));
      document.querySelector(`.service-tab[data-service="${service}"]`)?.classList.add('active');
      if (Core.cloudApi && typeof Core.cloudApi.switchService === 'function') {
        Core.cloudApi.switchService(service);
        document.getElementById('status').textContent = `✅ 已切换到 ${service}`;
      } else {
        console.warn('⚠️ cloudApi 模块未加载');
      }
    }
    tabs.forEach(tab => {
      tab.addEventListener('click', function() {
        switchService(this.dataset.service);
      });
    });
    window.switchService = switchService;
  })();


// ===== Block: logout patch (from index.html L5204-L5223) =====

  (function patchLogout() {
    var _retries = 0;
    function applyPatch() {
      if (window.Core && Core.user && Core.user.logoutUser) {
        const originalLogout = Core.user.logoutUser;
        Core.user.logoutUser = function() {
          document.body.classList.remove('logged-in');
          const chatList = document.getElementById('chatList');
          if (chatList) chatList.innerHTML = '';
          const chatContainer = document.getElementById('chatContainer');
          if (chatContainer) chatContainer.innerHTML = '';
          return originalLogout.apply(this, arguments);
        };
      } else if (_retries < 20) {
        _retries++;
        setTimeout(applyPatch, 200);
      } else {
        console.warn('⚠️ [app] applyPatch max retries reached');
      }
    }
    applyPatch();
  })();


// ===== Block: login/registration (from index.html L5234-L5351) =====

  (function() {
    const overlay = document.getElementById('loginOverlay');
    const usernameInput = document.getElementById('loginUsername');
    const loginBtn = document.getElementById('loginBtn');
    const registerBtn = document.getElementById('registerBtn');
    const loginError = document.getElementById('loginError');
    const userListItems = document.getElementById('userListItems');
    const userListSection = document.getElementById('userListSection');

    if (!loginBtn || !registerBtn || !overlay) {
      console.error('❌ 登录界面元素未找到');
      return;
    }

    function showError(msg) {
      loginError.textContent = msg;
      loginError.style.display = 'block';
    }
    function hideError() { loginError.style.display = 'none'; }

    // 安全检测 Core 是否可用（处理TDZ情况：core.js加载失败时 typeof Core 也会抛错）
    function hasCore() {
      try { return typeof Core !== 'undefined' && Core !== null && Core !== window; } catch(e) { return false; }
    }
    function hasCoreUser() {
      try { return hasCore() && !!Core.user; } catch(e) { return false; }
    }

    function loadUserList() {
      if (!hasCoreUser()) { userListSection.style.display = 'none'; return; }
      try {
        const users = Core.user.listUsers();
        userListItems.innerHTML = '';
        if (users.length === 0) { userListSection.style.display = 'none'; return; }
        userListSection.style.display = 'block';
        users.forEach(u => {
          const el = document.createElement('div');
          el.className = 'login-user-item';
          el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);';
          el.innerHTML = '<span>&#128100; ' + escapeHtml(u) + '</span><div><button data-user="' + escapeHtml(u) + '" class="login-user-login" style="margin-right:6px;padding:4px 12px;background:var(--primary);border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer;">登录</button>' + (u !== 'admin' ? '<button data-user="' + escapeHtml(u) + '" class="login-user-delete" style="padding:4px 12px;background:#ef4444;border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer;">删除</button>' : '') + '</div>';
          el.querySelector('.login-user-login').addEventListener('click', () => { loginUser(u); });
          const delBtn = el.querySelector('.login-user-delete');
          if (delBtn) {
            delBtn.addEventListener('click', () => {
              if (Core.user && Core.user.deleteUser) {
                const success = Core.user.deleteUser(u);
                if (success) loadUserList();
              }
            });
          }
          userListItems.appendChild(el);
        });
      } catch (err) { console.warn('加载用户列表失败:', err); userListSection.style.display = 'none'; }
    }

    function loginUser(username) {
      hideError();
      if (!hasCoreUser()) {
        console.warn('Core.user 未加载，降级登录');
        overlay.style.display = 'none'; overlay.classList.add('hidden');
        document.body.classList.add('logged-in');
        if (hasCore()) {
          try {
            if (Core.session && typeof Core.session.loadSessions === 'function') Core.session.loadSessions();
            if (Core.dom && Core.dom.currentUserDisplay) Core.dom.currentUserDisplay.textContent = '\ud83d\udc64 ' + username;
            if (Core.dom && Core.dom.status) Core.dom.status.textContent = '\u2705 已就绪 (' + username + ')';
            Core._currentUser = username;
            if (Core.saveConfig) Core.saveConfig({ lastUser: username });
          } catch(e) { console.warn('降级登录UI更新失败:', e); }
        }
        return;
      }
      try {
        const result = Core.user.loginUser(username);
        if (result.success) {
          overlay.style.display = 'none'; overlay.classList.add('hidden');
          document.body.classList.add('logged-in');
          if (Core.session && typeof Core.session.loadSessions === 'function') Core.session.loadSessions();
          if (Core.dom && Core.dom.currentUserDisplay) Core.dom.currentUserDisplay.textContent = '&#128100; ' + username;
          if (Core.dom && Core.dom.status) Core.dom.status.textContent = '&#9989; 已就绪';
        } else { showError(result.error); }
      } catch (err) { console.error('登录失败:', err); showError('登录失败: ' + (err.message || '未知错误')); }
    }
    loginBtn.addEventListener('click', () => {
      const username = usernameInput.value.trim();
      if (!username) { showError('请输入用户名'); return; }
      try { loginUser(username); } catch (err) { console.error('登录错误:', err); showError('登录失败: ' + (err.message || '未知错误')); }
    });
    registerBtn.addEventListener('click', () => {
      const username = usernameInput.value.trim();
      if (!username) { showError('请输入用户名'); return; }
      if (typeof Core === 'undefined' || !Core.user) { console.warn('Core.user 未加载，注册降级为登录'); loginUser(username); return; }
      try {
        const result = Core.user.createUser(username);
        if (result.success) { Core.user.migrateOldData(username); loginUser(username); }
        else { showError(result.error); }
      } catch (err) { console.error('注册失败:', err); showError('注册失败: ' + (err.message || '未知错误')); }
    });
    usernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loginBtn.click();
    });

    setTimeout(() => {
      if (typeof Core !== 'undefined' && Core.user) {
        loadUserList();
        const users = Core.user.listUsers();
        if (users.length === 0) {
          overlay.style.display = 'flex';
          overlay.classList.remove('hidden');
        }
      } else {
        overlay.style.display = 'flex';
        overlay.classList.remove('hidden');
      }
    }, 500);

    window._loadUserList = loadUserList;
  })();


// ===== Block: switch user (from index.html L5354-L5382) =====

  (function() {
    const switchUserBtn = document.getElementById('switchUserBtn');
    if (!switchUserBtn) return;

    switchUserBtn.addEventListener('click', () => {
      const overlay = document.getElementById('loginOverlay');
      if (!overlay) return;

      // 如果有logoutUser则调用
      if (window.Core && Core.user && typeof Core.user.logoutUser === 'function') {
        try { Core.user.logoutUser(); } catch(e) { console.warn('[App] Logout failed:', e); }
      }

      // 清空界面
      const chatContainer = document.getElementById('chatContainer');
      const chatList = document.getElementById('chatList');
      if (chatContainer) chatContainer.innerHTML = '';
      if (chatList) chatList.innerHTML = '';

      // 显示登录界面
      overlay.style.display = 'flex';
      overlay.classList.remove('hidden');
      document.body.classList.remove('logged-in');

      // 刷新用户列表
      if (window._loadUserList) window._loadUserList();
    });
  })();


// ===== Block: import stub (comment) (from index.html L5384-L5386) =====

  // importBtn 和 importFileInput 的绑定由 core-v10.js initToolbarButtons 处理


// ===== Block: screenshot capture (from index.html L5409-L5722) =====

    // ===== 🔧 截图分析功能 =====
    var _ssMode = 'full';       // 'full' | 'crop' | 'window'
    var _ssDataUrl = null;      // 当前截图 dataURL
    var _ssImg = null;          // Image 对象
    var _ssCropRect = { x: 0, y: 0, w: 0, h: 0 };
    var _ssDragging = false;
    var _ssDragStart = { x: 0, y: 0 };
    var _ssWindows = [];        // 窗口列表

    var screenshotBtn, ssOverlay, ssCanvas, ssCanvasWrap, ssCropRect, ssCropHint, ssWindowList, ssConfirm, ssCancel;
    var _ssDomReady = false;

    function ensureScreenshotDom() {
      if (_ssDomReady) return true;
      screenshotBtn = document.getElementById('screenshotBtn');
      ssOverlay = document.getElementById('screenshotOverlay');
      ssCanvas = document.getElementById('ssCanvas');
      ssCanvasWrap = document.getElementById('ssCanvasWrap');
      ssCropRect = document.getElementById('ssCropRect');
      ssCropHint = document.getElementById('ssCropHint');
      ssWindowList = document.getElementById('ssWindowList');
      ssConfirm = document.getElementById('ssConfirm');
      ssCancel = document.getElementById('ssCancel');
      if (!ssOverlay) return false;
      _ssDomReady = true;
      bindScreenshotEvents();
      return true;
    }

    function bindScreenshotEvents() {
      if (screenshotBtn) screenshotBtn.addEventListener('click', openScreenshot);
      if (ssCancel) ssCancel.addEventListener('click', closeScreenshot);
      if (ssConfirm) ssConfirm.addEventListener('click', confirmScreenshot);
      if (ssOverlay) {
        ssOverlay.querySelectorAll('.ss-mode-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            _ssMode = btn.getAttribute('data-mode');
            updateModeButtons();
            captureScreen(_ssMode);
          });
        });
      }
      if (ssCropRect) {
        ssCropRect.addEventListener('mousedown', function(e) {
          if (_ssMode !== 'crop') return;
          _ssDragging = true;
          _ssDragStart = { x: e.clientX - ssCropRect.offsetLeft, y: e.clientY - ssCropRect.offsetTop };
          e.preventDefault();
        });
        var resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = 'position:absolute;bottom:-4px;right:-4px;width:12px;height:12px;background:var(--primary,#3b82f6);border-radius:2px;cursor:se-resize;';
        ssCropRect.appendChild(resizeHandle);
        resizeHandle.addEventListener('mousedown', function(e) {
          _resizing = true;
          _ssDragStart = { x: e.clientX, y: e.clientY, w: ssCropRect.offsetWidth, h: ssCropRect.offsetHeight };
          e.preventDefault();
          e.stopPropagation();
        });
      }
    }

    function openScreenshot() {
      if (!ensureScreenshotDom()) return;
      if (!ssOverlay) return;
      _ssMode = 'full';
      _ssDataUrl = null;
      _ssImg = null;
      ssOverlay.classList.add('active');
      updateModeButtons();
      captureScreen('full');
    }

    function closeScreenshot() {
      if (ssOverlay) ssOverlay.classList.remove('active');
      _ssDataUrl = null;
      _ssImg = null;
    }

    function updateModeButtons() {
      var btns = ssOverlay.querySelectorAll('.ss-mode-btn');
      btns.forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === _ssMode);
      });
    }

    async function captureScreen(mode) {
      // 显示 loading
      ssCanvasWrap.style.display = 'none';
      ssWindowList.style.display = 'none';
      Core.showSpinner(ssOverlay, '正在截图...', { white: true });

      try {
        var ipcRenderer = require('electron').ipcRenderer;

        if (mode === 'window') {
          // 获取窗口列表
          var result = await ipcRenderer.invoke('take-screenshot', { type: 'window' });
          Core.hideSpinner(ssOverlay);
          if (result.success && result.windows) {
            _ssWindows = result.windows;
            renderWindowList(result.windows);
            ssWindowList.style.display = 'flex';
          } else {
            showToast('截图失败: ' + (result.error || '未知错误'), 'error');
            closeScreenshot();
          }
          return;
        }

        // 全屏截图
        var result = await ipcRenderer.invoke('take-screenshot', { type: 'full' });
        Core.hideSpinner(ssOverlay);

        if (!result.success) {
          showToast('截图失败: ' + (result.error || '未知错误'), 'error');
          closeScreenshot();
          return;
        }

        _ssDataUrl = result.dataUrl;

        // 加载到 canvas
        var img = new Image();
        img.onload = function() {
          _ssImg = img;
          var maxW = window.innerWidth * 0.9;
          var maxH = window.innerHeight * 0.8;
          var scale = Math.min(maxW / img.width, maxH / img.height, 1);
          ssCanvas.width = Math.round(img.width * scale);
          ssCanvas.height = Math.round(img.height * scale);
          var ctx = ssCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, ssCanvas.width, ssCanvas.height);
          ssCanvasWrap.style.display = 'block';

          if (mode === 'crop') {
            // 区域选择模式
            ssCropRect.style.display = 'block';
            ssCropRect.style.left = '10%';
            ssCropRect.style.top = '10%';
            ssCropRect.style.width = '80%';
            ssCropRect.style.height = '80%';
            _ssCropRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
            if (ssCropHint) ssCropHint.textContent = '拖动蓝色虚线框选择分析区域';
          } else {
            ssCropRect.style.display = 'none';
            if (ssCropHint) ssCropHint.textContent = '';
          }
        };
        img.src = result.dataUrl;

      } catch (err) {
        Core.hideSpinner(ssOverlay);
        showToast('截图失败: ' + err.message, 'error');
        closeScreenshot();
      }
    }

    function renderWindowList(windows) {
      if (!ssWindowList) return;
      ssWindowList.innerHTML = '';
      windows.forEach(function(win) {
        var item = document.createElement('div');
        item.className = 'screenshot-window-item';
        var img = document.createElement('img');
        img.src = win.thumbnail || '';
        img.alt = '';
        var nameDiv = document.createElement('div');
        nameDiv.className = 'win-name';
        nameDiv.textContent = win.name || '未知窗口';
        item.appendChild(img);
        item.appendChild(nameDiv);
        item.onclick = function() {
          // 捕获这个窗口
          captureWindowById(win.id, win.name);
        };
        ssWindowList.appendChild(item);
      });
    }

    async function captureWindowById(sourceId, name) {
      ssWindowList.style.display = 'none';
      Core.showSpinner(ssOverlay, '正在捕获窗口...', { white: true });

      try {
        var ipcRenderer = require('electron').ipcRenderer;
        var result = await ipcRenderer.invoke('take-screenshot', { type: 'capture-window', sourceId: sourceId });
        Core.hideSpinner(ssOverlay);

        if (result.success) {
          _ssDataUrl = result.dataUrl;
          var img = new Image();
          img.onload = function() {
            _ssImg = img;
            var maxW = window.innerWidth * 0.9;
            var maxH = window.innerHeight * 0.8;
            var scale = Math.min(maxW / img.width, maxH / img.height, 1);
            ssCanvas.width = Math.round(img.width * scale);
            ssCanvas.height = Math.round(img.height * scale);
            var ctx = ssCanvas.getContext('2d');
            ctx.drawImage(img, 0, 0, ssCanvas.width, ssCanvas.height);
            ssCanvasWrap.style.display = 'block';
            ssCropRect.style.display = 'none';
          };
          img.src = result.dataUrl;
          _ssMode = 'full';
          updateModeButtons();
        } else {
          showToast('窗口截图失败: ' + (result.error || '未知错误'), 'error');
        }
      } catch (err) {
        Core.hideSpinner(ssOverlay);
        showToast('窗口截图失败: ' + err.message, 'error');
      }
    }

    function confirmScreenshot() {
      if (!_ssDataUrl) return;

      var finalDataUrl = _ssDataUrl;

      // 如果是 crop 模式，裁剪 canvas 区域
      if (_ssMode === 'crop' && _ssImg) {
        var rect = ssCropRect.getBoundingClientRect();
        var wrapRect = ssCanvasWrap.getBoundingClientRect();
        var scaleX = _ssImg.width / ssCanvas.width;
        var scaleY = _ssImg.height / ssCanvas.height;

        var sx = (rect.left - wrapRect.left) * scaleX;
        var sy = (rect.top - wrapRect.top) * scaleY;
        var sw = rect.width * scaleX;
        var sh = rect.height * scaleY;

        // 确保在范围内
        sx = Math.max(0, sx);
        sy = Math.max(0, sy);
        sw = Math.min(sw, _ssImg.width - sx);
        sh = Math.min(sh, _ssImg.height - sy);

        if (sw > 10 && sh > 10) {
          var cropCanvas = document.createElement('canvas');
          cropCanvas.width = Math.round(sw);
          cropCanvas.height = Math.round(sh);
          var cropCtx = cropCanvas.getContext('2d');
          cropCtx.drawImage(_ssImg, sx, sy, sw, sh, 0, 0, sw, sh);
          finalDataUrl = cropCanvas.toDataURL('image/png');
        }
      }

      // 添加到图片预览
      if (typeof addImageToPreview === 'function') {
        addImageToPreview(finalDataUrl, '截图');
        if (Core.dom && Core.dom.status) {
          Core.dom.status.textContent = '📸 截图已添加，输入问题后发送进行分析';
          setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        }
      }

      closeScreenshot();
      // 聚焦输入框
      var input = document.getElementById('input');
      if (input) {
        input.focus();
        if (!input.value) input.placeholder = '请描述你想分析截图中的什么内容...';
      }
    }

    // 全局 mousemove/mouseup（裁剪框拖拽 + 大小调整，需要在 DOM ready 之前就注册）
    var _resizing = false;
    document.addEventListener('mousemove', function(e) {
      if (_ssDragging && ssCropRect && ssCanvasWrap) {
        var wrapRect = ssCanvasWrap.getBoundingClientRect();
        var newX = e.clientX - _ssDragStart.x;
        var newY = e.clientY - _ssDragStart.y;
        newX = Math.max(0, Math.min(newX, wrapRect.width - ssCropRect.offsetWidth));
        newY = Math.max(0, Math.min(newY, wrapRect.height - ssCropRect.offsetHeight));
        ssCropRect.style.left = newX + 'px';
        ssCropRect.style.top = newY + 'px';
      }
      if (_resizing && ssCropRect && ssCanvasWrap) {
        var wrapRect = ssCanvasWrap.getBoundingClientRect();
        var newW = Math.max(50, _ssDragStart.w + (e.clientX - _ssDragStart.x));
        var newH = Math.max(50, _ssDragStart.h + (e.clientY - _ssDragStart.y));
        newW = Math.min(newW, wrapRect.width - ssCropRect.offsetLeft);
        newH = Math.min(newH, wrapRect.height - ssCropRect.offsetTop);
        ssCropRect.style.width = newW + 'px';
        ssCropRect.style.height = newH + 'px';
      }
    });
    document.addEventListener('mouseup', function() {
      _ssDragging = false;
      _resizing = false;
    });

    // Escape 关闭截图覆盖（通过统一 keyboard 分发器，priority 1 = 最高优先级）
    if (Core.keyboard) {
      Core.keyboard.register('screenshot-escape', 1, function(e) {
        if (e.key === 'Escape' && ssOverlay && ssOverlay.classList.contains('active')) {
          e.preventDefault();
          closeScreenshot();
          return false;
        }
      });
    }

    // 暴露到 Core
    if (window.Core) {
      Core.screenshot = {
        capture: openScreenshot,
        close: closeScreenshot
      };
    }


// ===== Block: shortcut hint (from index.html L5739-L5751) =====

(function() {
  var hintPanel = document.getElementById('shortcutHint');
  var hintBtn = document.getElementById('shortcutHintBtn');
  if (!hintPanel) return;
  // Ctrl+/ 快捷键由 core-v10.js initShortcuts 统一处理，此处仅绑定按钮点击
  if (hintBtn) {
    hintBtn.addEventListener('click', function() {
      hintPanel.classList.toggle('show');
    });
  }
})();


// ===== Block: DevTools shortcut (通过统一 keyboard 分发器) =====

if (Core.keyboard) {
  Core.keyboard.register('devtools', 50, function(e) {
    if ((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      try {
        var ipcRenderer = require('electron').ipcRenderer;
        ipcRenderer.send('toggle-devtools');
      } catch(err) {}
      return false;
    }
  });
}


// ===== Block: message search + lightbox (from index.html L5766-L6127) =====

// 🔧 滚动到底部按钮由 core-v10.js initScrollToBottom 处理

// 🔧 初始化消息搜索框（Ctrl+F 触发）
(function initMsgSearch() {
  var searchBox = document.getElementById('msgSearchBox');
  var searchInput = document.getElementById('msgSearchInput');
  var searchPrev = document.getElementById('msgSearchPrev');
  var searchNext = document.getElementById('msgSearchNext');
  var searchClose = document.getElementById('msgSearchClose');
  var searchCount = document.getElementById('msgSearchCount');
  var chatContainer = document.getElementById('chatContainer');
  
  if (!searchBox || !searchInput || !chatContainer) {
    console.warn('⚠️ 消息搜索初始化失败：元素未找到');
    return;
  }
  
  // 🔧 创建匹配预览面板
  var searchPreview = document.createElement('div');
  searchPreview.id = 'searchPreviewPanel';
  searchPreview.className = 'search-preview-panel';
  document.body.appendChild(searchPreview);
  
  var matches = [];
  var matchIdx = -1;
  
  function clearHighlights() {
    var hl = chatContainer.querySelectorAll('.search-highlight');
    for (var i = 0; i < hl.length; i++) {
      var p = hl[i].parentNode;
      if (p) {
        hl[i].classList.remove('current');
        p.replaceChild(document.createTextNode(hl[i].textContent), hl[i]);
        p.normalize();
      }
    }
  }
  
  function getTextContext(node, query) {
    var text = node.textContent;
    var lq = query.toLowerCase();
    var lt = text.toLowerCase();
    var idx = lt.indexOf(lq);
    if (idx === -1) return text;
    var start = Math.max(0, idx - 25);
    var end = Math.min(text.length, idx + query.length + 25);
    var prefix = start > 0 ? '...' : '';
    var suffix = end < text.length ? '...' : '';
    return prefix + text.substring(start, end) + suffix;
  }
  
  function updatePreviewPanel(query) {
    searchPreview.innerHTML = '';
    if (matches.length === 0) {
      if (query) {
        var empty = document.createElement('div');
        empty.className = 'search-preview-empty';
        empty.textContent = '未找到匹配结果';
        searchPreview.appendChild(empty);
      }
      return;
    }
    
    // 按消息分组收集匹配
    var msgMatches = {};
    for (var i = 0; i < matches.length; i++) {
      var msgDiv = matches[i].closest('.msg');
      if (!msgDiv) continue;
      var msgIndex = Array.prototype.indexOf.call(chatContainer.querySelectorAll('.msg'), msgDiv);
      if (!msgMatches[msgIndex]) {
        var isUser = msgDiv.classList.contains('user');
        var roleLabel = isUser ? '\u3010\u7528\u6237\u3011' : '\u3010AI\u3011';
        var fullText = msgDiv.textContent.replace(/\s+/g, ' ').substring(0, 100);
        msgMatches[msgIndex] = {
          msgDiv: msgDiv,
          roleLabel: roleLabel,
          fullText: fullText,
          matchIndices: []
        };
      }
      msgMatches[msgIndex].matchIndices.push(i);
    }
    
    // 渲染预览项
    var sortedIndices = Object.keys(msgMatches).sort(function(a, b) { return parseInt(a) - parseInt(b); });
    sortedIndices.forEach(function(mi) {
      var mm = msgMatches[mi];
      var item = document.createElement('div');
      item.className = 'search-preview-item';
      item.dataset.msgIndex = mi;
      item.dataset.firstMatchIdx = mm.matchIndices[0];
      
      var roleSpan = document.createElement('span');
      roleSpan.className = 'preview-role';
      roleSpan.textContent = mm.roleLabel;
      
      var textSpan = document.createElement('span');
      textSpan.className = 'preview-text';
      // 高亮匹配词
      var context = mm.fullText;
      var lq = query.toLowerCase();
      var lContext = context.toLowerCase();
      var idx = lContext.indexOf(lq);
      if (idx !== -1) {
        textSpan.innerHTML = escapeHtml(context.substring(0, idx)) + '<span class="match">' + escapeHtml(context.substring(idx, idx + query.length)) + '</span>' + escapeHtml(context.substring(idx + query.length));
      } else {
        textSpan.textContent = context;
      }
      
      item.appendChild(roleSpan);
      item.appendChild(textSpan);
      
      item.addEventListener('click', function() {
        var firstIdx = parseInt(item.dataset.firstMatchIdx);
        if (matchIdx >= 0 && matchIdx < matches.length) matches[matchIdx].classList.remove('current');
        matchIdx = firstIdx;
        matches[matchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        matches[matchIdx].classList.add('current');
        updatePreviewActiveItem();
        searchCount.textContent = (matchIdx + 1) + '/' + matches.length;
      });
      
      searchPreview.appendChild(item);
    });
    
    updatePreviewActiveItem();
  }
  
  function updatePreviewActiveItem() {
    var items = searchPreview.querySelectorAll('.search-preview-item');
    items.forEach(function(item) { item.classList.remove('active'); });
    if (matchIdx < 0) return;
    var currentMsg = matches[matchIdx] && matches[matchIdx].closest('.msg');
    if (!currentMsg) return;
    var currentMsgIndex = Array.prototype.indexOf.call(chatContainer.querySelectorAll('.msg'), currentMsg);
    items.forEach(function(item) {
      if (parseInt(item.dataset.msgIndex) === currentMsgIndex) {
        item.classList.add('active');
      }
    });
  }
  
  function doSearch(query) {
    clearHighlights();
    matches = [];
    matchIdx = -1;
    if (!query) { searchCount.textContent = '0/0'; updatePreviewPanel(''); return; }
    // 🔧 保存搜索历史
    saveSearchHistory(query);
    var msgs = chatContainer.querySelectorAll('.msg');
    for (var m = 0; m < msgs.length; m++) {
      var walker = document.createTreeWalker(msgs[m], NodeFilter.SHOW_TEXT, null, false);
      var nodes = [];
      var n;
      while (n = walker.nextNode()) nodes.push(n);
      for (var j = 0; j < nodes.length; j++) {
        var tn = nodes[j];
        if (tn.parentNode && tn.parentNode.classList && tn.parentNode.classList.contains('search-highlight')) continue;
        var text = tn.textContent;
        var lq = query.toLowerCase();
        var lt = text.toLowerCase();
        var idx = lt.indexOf(lq);
        if (idx !== -1) {
          var span = document.createElement('span');
          span.className = 'search-highlight';
          span.textContent = text.substring(idx, idx + query.length);
          var parent = tn.parentNode;
          if (idx > 0) parent.insertBefore(document.createTextNode(text.substring(0, idx)), tn);
          parent.insertBefore(span, tn);
          if (idx + query.length < text.length) parent.insertBefore(document.createTextNode(text.substring(idx + query.length)), tn);
          parent.removeChild(tn);
          matches.push(span);
        }
      }
    }
    searchCount.textContent = matches.length > 0 ? '1/' + matches.length : '0/0';
    updatePreviewPanel(query);
    if (matches.length > 0) { 
      matchIdx = 0; 
      matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); 
      matches[0].classList.add('current'); 
    }
  }
  
  function scrollToMatch(dir) {
    if (matches.length === 0) return;
    if (matchIdx >= 0 && matchIdx < matches.length) matches[matchIdx].classList.remove('current');
    matchIdx = (matchIdx + dir + matches.length) % matches.length;
    matches[matchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    matches[matchIdx].classList.add('current');
    searchCount.textContent = (matchIdx + 1) + '/' + matches.length;
    updatePreviewActiveItem();
  }
  
  // 🔧 搜索历史管理
  var HISTORY_KEY = 'ai-search-history';
  var MAX_HISTORY = 10;
  var historyDropdown = document.getElementById('searchHistoryDropdown');
  var historyList = document.getElementById('searchHistoryList');
  var historyClear = document.getElementById('searchHistoryClear');
  
  function getSearchHistory() {
    try {
      var data = localStorage.getItem(HISTORY_KEY);
      if (data) return JSON.parse(data);
    } catch (e) {}
    return [];
  }
  
  function saveSearchHistory(query) {
    if (!query || query.length < 2) return;
    var history = getSearchHistory();
    var idx = history.indexOf(query);
    if (idx !== -1) history.splice(idx, 1);
    history.unshift(query);
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
  }
  
  function removeSearchHistory(query) {
    var history = getSearchHistory();
    var idx = history.indexOf(query);
    if (idx !== -1) {
      history.splice(idx, 1);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
      renderSearchHistory();
    }
  }
  
  function clearSearchHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
    renderSearchHistory();
  }
  
  function renderSearchHistory() {
    if (!historyList) return;
    var history = getSearchHistory();
    historyList.innerHTML = '';
    if (history.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'search-history-empty';
      empty.textContent = '暂无搜索历史';
      historyList.appendChild(empty);
      return;
    }
    history.forEach(function(item) {
      var row = document.createElement('div');
      row.className = 'search-history-item';
      
      var textWrap = document.createElement('div');
      textWrap.className = 'history-text';
      var icon = document.createElement('span');
      icon.className = 'history-icon';
      icon.textContent = '⏱';
      var text = document.createElement('span');
      text.textContent = item;
      textWrap.appendChild(icon);
      textWrap.appendChild(text);
      
      var delBtn = document.createElement('button');
      delBtn.className = 'history-delete';
      delBtn.textContent = '✕';
      delBtn.title = '删除';
      delBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        removeSearchHistory(item);
      });
      
      row.appendChild(textWrap);
      row.appendChild(delBtn);
      
      row.addEventListener('click', function() {
        searchInput.value = item;
        doSearch(item);
        hideSearchHistory();
      });
      
      historyList.appendChild(row);
    });
  }
  
  function showSearchHistory() {
    if (!historyDropdown) return;
    renderSearchHistory();
    historyDropdown.classList.add('active');
  }
  
  function hideSearchHistory() {
    if (!historyDropdown) return;
    historyDropdown.classList.remove('active');
  }
  
  function showSearch() { 
    searchBox.classList.add('active'); 
    searchInput.focus(); 
    searchInput.select(); 
    if (searchPreview) searchPreview.classList.add('active');
    // focus 事件监听器会自动触发 showSearchHistory
  }
  function hideSearch() { 
    searchBox.classList.remove('active'); 
    if (searchPreview) searchPreview.classList.remove('active');
    hideSearchHistory();
    clearHighlights(); 
    matches = []; 
    matchIdx = -1; 
    searchInput.value = ''; 
    searchCount.textContent = '0/0'; 
  }
  
  // Ctrl+F / Escape 搜索（通过统一 keyboard 分发器，priority 30）
  if (Core.keyboard) {
    Core.keyboard.register('app-search', 30, function(e) {
      if (e.key === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        if (searchBox.classList.contains('active')) hideSearch();
        else showSearch();
        return false;
      }
      if (e.key === 'Escape' && searchBox.classList.contains('active')) {
        e.preventDefault();
        hideSearch();
        return false;
      }
    });
  }
  
  searchInput.addEventListener('input', function() {
    doSearch(this.value.trim());
    // 有输入时隐藏历史，显示搜索结果预览
    if (this.value.trim()) hideSearchHistory();
  });
  if (searchPrev) searchPrev.addEventListener('click', function() { scrollToMatch(-1); });
  if (searchNext) searchNext.addEventListener('click', function() { scrollToMatch(1); });
  if (searchClose) searchClose.addEventListener('click', hideSearch);
  
  // 🔧 搜索历史事件监听
  if (historyClear) historyClear.addEventListener('click', function(e) {
    e.stopPropagation();
    if (confirm('确定清空所有搜索历史？')) clearSearchHistory();
  });
  // 点击搜索输入框时显示历史（如果没有输入内容）
  searchInput.addEventListener('focus', function() {
    if (!this.value.trim() && searchBox.classList.contains('active')) showSearchHistory();
  });
  // 点击外部隐藏历史下拉
  document.addEventListener('click', function(e) {
    if (!searchBox.contains(e.target) && historyDropdown && !historyDropdown.contains(e.target)) {
      hideSearchHistory();
    }
  });
  
  console.log('✅ 消息搜索已启用 (Ctrl+F)');
})();

  // 🔧 图片点击放大
  document.addEventListener('click', function(e) {
    if (e.target.tagName === 'IMG' && e.target.closest('.msg')) {
      var lb = document.createElement('div');
      lb.className = 'image-lightbox';
      var img = document.createElement('img');
      img.src = e.target.src;
      lb.appendChild(img);
      lb.onclick = function() { lb.remove(); };
      document.body.appendChild(lb);
    }
  });



// ===== Block: prompt templates + roles (from index.html L6130-L6332) =====

// 🔧 使用全局标志确保只初始化一次
window._promptRoleInitialized = window._promptRoleInitialized || false;

(function initPromptAndRoleExternal() {
  if (window._promptRoleInitialized) {
    return;
  }
  
  
  if (!window.Core || !Core.config || !Core.config.roles) {
    console.log('⏳ 等待 Core 加载...');
    setTimeout(initPromptAndRoleExternal, 500);
    return;
  }
  
  // 标记已初始化，防止重复执行
  window._promptRoleInitialized = true;
  
  // 🔧 保险：如果角色未加载，直接填充默认值
  if (!Core.config.roles || Core.config.roles.length === 0) {
    Core.config.roles = [
      { name: '通用助手', systemMsg: '你是一个 helpful、honest、harmless 的 AI 助手。', icon: '🤖', description: '通用问答和日常对话' },
      { name: '程序员', systemMsg: '你是一位资深程序员，精通多种编程语言，擅长代码审查、算法优化和架构设计。', icon: '💻', description: '编程、代码审查、技术咨询' },
      { name: '作家', systemMsg: '你是一位专业作家，擅长各类文体写作，包括小说、散文、剧本、公文等。', icon: '✍️', description: '写作、编辑、文案创作' },
      { name: '老师', systemMsg: '你是一位经验丰富的教师，善于用通俗易懂的方式解释复杂概念，耐心引导学生学习。', icon: '👨‍🏫', description: '教学、辅导、知识讲解' },
      { name: '医生', systemMsg: '你是一位专业医生，可以提供健康建议、解释医学知识，但请注意不能替代专业医疗诊断。', icon: '👨‍⚕️', description: '健康咨询、医学知识' },
      { name: '律师', systemMsg: '你是一位专业律师，可以提供法律知识咨询，但请注意不能替代专业法律服务。', icon: '⚖️', description: '法律咨询、合同审查' },
      { name: '产品经理', systemMsg: '你是一位资深产品经理，擅长需求分析、用户体验设计和产品规划。', icon: '📊', description: '产品设计、需求分析' },
    ];
    Core.config.currentRole = '通用助手';
    Core.config.systemInstruction = '你是一个 helpful、honest、harmless 的 AI 助手。';
    Core.saveConfig({ roles: Core.config.roles, currentRole: '通用助手', systemInstruction: '你是一个 helpful、honest、harmless 的 AI 助手。' });
  }
  
  // 🔧 保险：如果提示词未加载，直接填充默认值
  if (!Core.config.prompts || Core.config.prompts.length === 0) {
    Core.config.prompts = [
      { name: '总结', content: '请总结以下内容的要点，用简洁的语言输出。', icon: '📝' },
      { name: '翻译', content: '请将以下内容翻译成中文/英文，保持原意不变。', icon: '🌐' },
      { name: '编程', content: '请帮我编写代码，要求清晰、高效、有注释。', icon: '💻' },
      { name: '解释', content: '请用通俗易懂的方式解释以下内容，适合初学者理解。', icon: '💡' },
      { name: '优化', content: '请优化以下内容，使其更加通顺、专业、有说服力。', icon: '✨' },
    ];
    Core.saveConfig({ prompts: Core.config.prompts });
  }
  
  
  // --- 提示词面板 ---
  // 🔧 使用 clone 替换按钮，清除所有旧的事件监听器
  var promptBtnOld = document.getElementById('promptBtn');
  var promptBtn = promptBtnOld ? promptBtnOld.cloneNode(true) : null;
  if (promptBtnOld && promptBtn) promptBtnOld.parentNode.replaceChild(promptBtn, promptBtnOld);
  
  var promptPanel = document.getElementById('promptPanel');
  var promptList = document.getElementById('promptList');
  var promptPanelClose = document.getElementById('promptPanelClose');
  var input = document.getElementById('input');
  
  
  function renderPrompts() {
    if (!promptList) return;
    promptList.innerHTML = '';
    var prompts = Core.config.prompts || [];
    prompts.forEach(function(p) {
      var item = document.createElement('div');
      item.className = 'prompt-item';
      item.innerHTML = '<div class="prompt-item-icon">' + escapeHtml(p.icon || '📝') + '</div><div class="prompt-item-name">' + escapeHtml(p.name) + '</div>';
      item.addEventListener('click', function() {
        if (input) { input.value = p.content; input.focus(); }
        promptPanel.classList.remove('active');
      });
      promptList.appendChild(item);
    });
  }
  
  if (promptBtn && promptPanel) {
    promptBtn.addEventListener('click', function() {
      renderPrompts();
      promptPanel.classList.toggle('active');
      var rp = document.getElementById('rolePanel');
      if (rp) rp.classList.remove('active');
    });
  }
  if (promptPanelClose && promptPanel) {
    promptPanelClose.addEventListener('click', function() {
      promptPanel.classList.remove('active');
    });
  }
  
  // --- 角色面板 ---
  // 🔧 使用 clone 替换按钮，清除所有旧的事件监听器
  var roleBtnOld = document.getElementById('roleBtn');
  var roleBtn = roleBtnOld ? roleBtnOld.cloneNode(true) : null;
  if (roleBtnOld && roleBtn) roleBtnOld.parentNode.replaceChild(roleBtn, roleBtnOld);
  
  var rolePanel2 = document.getElementById('rolePanel');
  var roleList = document.getElementById('roleList');
  var rolePanelClose = document.getElementById('rolePanelClose');
  var systemPrompt = document.getElementById('systemPrompt');
  
  
  function renderRoles() {
    if (!roleList) { console.warn('⚠️ roleList 不存在'); return; }
    roleList.innerHTML = '';
    var roles = Core.config.roles || [];
    if (roles.length === 0) { console.warn('⚠️ 角色列表为空'); return; }
    var currentRole = Core.config.currentRole || '通用助手';
    roles.forEach(function(r) {
      var item = document.createElement('div');
      item.className = 'role-item' + (r.name === currentRole ? ' active' : '');
      item.innerHTML = '<div class="role-item-icon">' + escapeHtml(r.icon || '🤖') + '</div><div class="role-item-info"><div class="role-item-name">' + escapeHtml(r.name) + '</div><div class="role-item-desc">' + escapeHtml(r.description || '') + '</div></div><div class="role-item-check">✓</div>';
      item.addEventListener('click', function() {
        Core.config.currentRole = r.name;
        Core.config.systemInstruction = r.systemMsg;
        Core.saveConfig({ currentRole: r.name, systemInstruction: r.systemMsg });
        if (systemPrompt) systemPrompt.value = r.systemMsg;
        renderRoles();
        updateCurrentRoleDisplay();
        rolePanel2.classList.remove('active');
        var status = document.getElementById('status');
        if (status) status.textContent = '✅ 已切换角色: ' + r.name;
        setTimeout(function() {
          if (status) status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')';
        }, 2000);
      });
      roleList.appendChild(item);
    });
  }
  
  function updateCurrentRoleDisplay() {
    var toolbar = document.querySelector('.toolbar');
    if (!toolbar) return;
    var oldDisplay = document.getElementById('currentRoleDisplay');
    if (oldDisplay) oldDisplay.remove();
    var currentRole = Core.config.currentRole || '通用助手';
    var roles = Core.config.roles || [];
    var role = roles.find(function(r) { return r.name === currentRole; });
    var display = document.createElement('span');
    display.id = 'currentRoleDisplay';
    display.className = 'current-role-display';
    display.innerHTML = (role ? escapeHtml(role.icon) : '🤖') + ' ' + escapeHtml(currentRole);
    display.title = '当前角色: ' + currentRole + '\n' + (role ? role.description : '');
    display.addEventListener('click', function() {
      renderRoles();
      rolePanel2.classList.toggle('active');
      var pp = document.getElementById('promptPanel');
      if (pp) pp.classList.remove('active');
    });
    toolbar.appendChild(display);
  }
  
  if (roleBtn && rolePanel2) {
    roleBtn.addEventListener('click', function() {
      renderRoles();
      rolePanel2.classList.toggle('active');
      var pp = document.getElementById('promptPanel');
      if (pp) pp.classList.remove('active');
    });
  } else {
    console.warn('⚠️ 外部 roleBtn 或 rolePanel2 不存在');
  }
  if (rolePanelClose && rolePanel2) {
    rolePanelClose.addEventListener('click', function() {
      rolePanel2.classList.remove('active');
    });
  }
  
  updateCurrentRoleDisplay();
  
  if (systemPrompt && Core.config.systemInstruction) {
    systemPrompt.value = Core.config.systemInstruction;
  }
  
  Core.on('configChanged', function() {
    updateCurrentRoleDisplay();
    if (systemPrompt && Core.config.systemInstruction) {
      systemPrompt.value = Core.config.systemInstruction;
    }
  });
  
})();

