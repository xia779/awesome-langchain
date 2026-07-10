// modules/ui-media.js — 图片预览、字体调节、TTS、Mermaid图表、代码高亮
// 从 core-v10.js IIFE 中提取

var Core = null;

  // ===== 方向A2：图片点击预览 =====
function initImagePreview() {
  var overlay = document.getElementById('imagePreviewOverlay');
  var wrapper = document.getElementById('previewWrapper');
  var previewImg = document.getElementById('imagePreviewImg');
  var closeBtn = document.getElementById('imagePreviewClose');
  var downloadBtn = document.getElementById('imagePreviewDownload');
  var copyBtn = document.getElementById('imagePreviewCopy');
  var zoomInBtn = document.getElementById('imagePreviewZoomIn');
  var zoomOutBtn = document.getElementById('imagePreviewZoomOut');
  var zoomLevelSpan = document.getElementById('zoomLevel');
  var rotateLeftBtn = document.getElementById('imagePreviewRotateLeft');
  var rotateRightBtn = document.getElementById('imagePreviewRotateRight');
  var resetBtn = document.getElementById('imagePreviewReset');
  
  if (!overlay || !previewImg) return;
  
  var currentSrc = '';
  var scale = 1;
  var rotation = 0;
  var translateX = 0;
  var translateY = 0;
  var isDragging = false;
  var startX = 0, startY = 0;
  var lastTranslateX = 0, lastTranslateY = 0;
  
  function updateTransform() {
    previewImg.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ') rotate(' + rotation + 'deg)';
    if (zoomLevelSpan) zoomLevelSpan.textContent = Math.round(scale * 100) + '%';
  }
  
  function resetTransform() {
    scale = 1;
    rotation = 0;
    translateX = 0;
    translateY = 0;
    updateTransform();
  }
  
  function showPreview(src) {
    currentSrc = src;
    previewImg.src = src;
    resetTransform();
    overlay.classList.add('active');
  }
  
  function hidePreview() {
    overlay.classList.remove('active');
    previewImg.src = '';
    currentSrc = '';
    resetTransform();
  }
  
  // 点击消息中的图片打开预览
  var chatContainer = document.getElementById('chatContainer');
  if (chatContainer) {
    chatContainer.addEventListener('click', function(e) {
      var img = e.target.closest && e.target.closest('img');
      if (img && img.closest('.msg')) {
        e.preventDefault();
        e.stopPropagation();
        showPreview(img.src);
      }
    });
  }
  
  // 点击 overlay 背景关闭
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay || e.target === wrapper) hidePreview();
  });
  
  if (closeBtn) closeBtn.addEventListener('click', hidePreview);
  
  // Escape 关闭
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && overlay.classList.contains('active')) hidePreview();
  });
  
  // 滚轮缩放
  if (wrapper) {
    wrapper.addEventListener('wheel', function(e) {
      if (!overlay.classList.contains('active')) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -0.1 : 0.1;
      scale = Math.max(0.1, Math.min(5, scale + delta));
      updateTransform();
    }, { passive: false });
  }
  
  // 拖拽平移
  if (previewImg) {
    previewImg.addEventListener('mousedown', function(e) {
      if (!overlay.classList.contains('active')) return;
      e.preventDefault();
      isDragging = true;
      startX = e.clientX - translateX;
      startY = e.clientY - translateY;
      previewImg.classList.add('grabbing');
    });
    
    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      e.preventDefault();
      translateX = e.clientX - startX;
      translateY = e.clientY - startY;
      updateTransform();
    });
    
    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        previewImg.classList.remove('grabbing');
      }
    });
  }
  
  // 缩放按钮
  if (zoomInBtn) zoomInBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    scale = Math.min(5, scale + 0.25);
    updateTransform();
  });
  
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    scale = Math.max(0.1, scale - 0.25);
    updateTransform();
  });
  
  // 旋转按钮
  if (rotateLeftBtn) rotateLeftBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    rotation -= 90;
    updateTransform();
  });
  
  if (rotateRightBtn) rotateRightBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    rotation += 90;
    updateTransform();
  });
  
  // 重置按钮
  if (resetBtn) resetBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    resetTransform();
  });
  
  // 下载按钮
  if (downloadBtn) downloadBtn.addEventListener('click', function() {
    if (!currentSrc) return;
    var a = document.createElement('a');
    a.href = currentSrc;
    a.download = 'image-' + Date.now() + '.png';
    a.click();
  });
  
  // 复制按钮
  if (copyBtn) copyBtn.addEventListener('click', function() {
    if (!currentSrc) return;
    navigator.clipboard.writeText(currentSrc).then(function() {
      if (Core.dom.status) {
        Core.dom.status.textContent = '✅ 图片链接已复制';
        setTimeout(function() {
          if (Core.dom.status) Core.dom.status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')';
        }, 2000);
      }
    });
  });
  
  console.log('✅ 图片预览已启用（支持缩放、旋转、拖拽）');
}

// ===== 方向B1：代码高亮主题联动 =====
function syncCodeHighlighter(isDark) {
  var hljsLink = document.getElementById('hljs-theme');
  if (!hljsLink) return;
  var newHref = isDark
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
  if (hljsLink.href !== newHref) { hljsLink.href = newHref; console.log('🎨 代码高亮主题:', isDark ? 'github-dark' : 'github'); }
}

// ===== 方向B2：字体大小调节 =====
function initFontSize() {
  var fontSizeSlider = document.getElementById('fontSizeSlider');
  var fontSizeDisplay = document.getElementById('fontSizeDisplay');
  if (!fontSizeSlider) return;
  var savedSize = Core.config.fontSize || 14;
  fontSizeSlider.value = savedSize;
  if (fontSizeDisplay) fontSizeDisplay.textContent = savedSize + 'px';
  applyFontSize(savedSize);
  fontSizeSlider.addEventListener('input', function() {
    var size = parseInt(this.value);
    if (fontSizeDisplay) fontSizeDisplay.textContent = size + 'px';
    applyFontSize(size);
    Core.saveConfig({ fontSize: size });
  });
  console.log('✅ 字体大小调节已启用');
}
function applyFontSize(size) {
  var chatContainer = document.getElementById('chatContainer');
  if (chatContainer) chatContainer.style.fontSize = size + 'px';
  document.documentElement.style.setProperty('--chat-font-size', size + 'px');
}

// ===== 方向C1：AI回复语音朗读 =====
var _renderMermaidFn = null; // 🔧 由 initMermaidSupport 设置，供统一 Observer 调用

function initTextToSpeech() {
  if (!window.speechSynthesis) { console.warn('⚠️ 浏览器不支持语音朗读'); return; }
  // 🔧 Observer 已移至 initChatObserver（统一调度）
  var chatContainer = document.getElementById('chatContainer');
  if (!chatContainer) return;
  var existing = chatContainer.querySelectorAll('.msg.ai');
  for (var k = 0; k < existing.length; k++) addTTSButton(existing[k]);
  console.log('✅ 语音朗读已启用');
}

var _currentUtterance = null;
function addTTSButton(aiMsgDiv) {
  // 延迟500ms添加按钮，避免与流式输出冲突
  setTimeout(function() {
    if (aiMsgDiv.querySelector('.tts-btn')) return;
    // 创建按钮容器（放在消息div外部，不干扰内容）
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;';
    // 将消息div放入wrapper
    if (aiMsgDiv.parentNode) {
      aiMsgDiv.parentNode.insertBefore(wrapper, aiMsgDiv);
      wrapper.appendChild(aiMsgDiv);
    }
    // 创建按钮
    var btn = document.createElement('button');
    btn.className = 'tts-btn';
    btn.innerHTML = '🔊';
    btn.title = '朗读';
    btn.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(255,255,255,0.8);border:1px solid var(--border);border-radius:50%;width:28px;height:28px;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.2s;z-index:10;';
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); btn.innerHTML = '🔊'; return; }
      // 🔧 获取文本时排除时间戳、按钮和 msg-actions
      var btnClone = btn.cloneNode(true);
      btn.parentNode.removeChild(btn);
      var contentClone = aiMsgDiv.cloneNode(true);
      var timestamps = contentClone.querySelectorAll('.msg-timestamp');
      for (var t = 0; t < timestamps.length; t++) timestamps[t].remove();
      var actions = contentClone.querySelectorAll('.msg-actions');
      for (var a = 0; a < actions.length; a++) actions[a].remove();
      var text = contentClone.textContent.replace(/```[\s\S]*?```/g, '（代码）').replace(/\s+/g, ' ').trim();
      wrapper.appendChild(btnClone);
      if (text.length > 500) text = text.substring(0, 500) + '...';
      if (!text) return;
      var utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.0;
      btnClone.innerHTML = '⏹';
      utterance.onend = function() { btnClone.innerHTML = '🔊'; };
      utterance.onerror = function() { btnClone.innerHTML = '🔊'; };
      window.speechSynthesis.speak(utterance);
    });
    wrapper.appendChild(btn);
    wrapper.addEventListener('mouseenter', function() { btn.style.opacity = '1'; });
    wrapper.addEventListener('mouseleave', function() { btn.style.opacity = '0'; });
  }, 500);
}

// ===== 方向C2：Mermaid图表 =====
function initMermaidSupport() {
  if (typeof window.mermaid === 'undefined') { console.log('⏭️ Mermaid 未加载'); return; }
  window.mermaid.initialize({ startOnLoad: false, theme: document.body.classList.contains('dark-theme') ? 'dark' : 'default' });
  var chatContainer = document.getElementById('chatContainer');
  if (!chatContainer) return;
  function renderMermaid(root) {
    if (!root || !root.querySelectorAll) return;
    var codes = root.querySelectorAll('pre code');
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      var source = code.textContent;
      var isMermaid = code.classList.contains('mermaid') || source.trim().startsWith('mermaid');
      if (!isMermaid) continue;
      if (source.trim().startsWith('mermaid')) source = source.replace(/^mermaid\n/, '');
      var pre = code.parentNode;
      var id = 'mmd-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
      try {
        window.mermaid.render(id, source).then(function(result) {
          var div = document.createElement('div');
          div.className = 'mermaid-diagram';
          div.innerHTML = result.svg;
          div.style.background = document.body.classList.contains('dark-theme') ? '#1e293b' : '#f8fafc';
          div.style.padding = '16px';
          div.style.borderRadius = 'var(--radius-sm)';
          div.style.overflow = 'auto';
          pre.parentNode.replaceChild(div, pre);
        }).catch(function(e) { console.warn('Mermaid render failed:', e); });
      } catch(e) { console.warn('Mermaid error:', e); }
    }
  }
  renderMermaid(chatContainer);
  _renderMermaidFn = renderMermaid; // 🔧 暴露给统一 Observer
  // 🔧 Observer 已移至 initChatObserver（统一调度 TTS + Mermaid）
  console.log('✅ Mermaid 图表支持已启用');
}
function loadMermaidCDN() {
  if (typeof window.mermaid !== 'undefined') { initMermaidSupport(); return; }
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
  script.onload = function() { console.log('✅ Mermaid CDN 加载完成'); initMermaidSupport(); };
  script.onerror = function() { console.warn('⚠️ Mermaid CDN 加载失败'); };
  document.head.appendChild(script);
}

module.exports = {
  name: 'ui-media',
  dependencies: ['html-utils'],
  init: function(_Core) {
    Core = _Core;
    // Attach public functions to Core
    Core.initImagePreview = initImagePreview;
    Core.syncCodeHighlighter = syncCodeHighlighter;
    Core.initFontSize = initFontSize;
    Core.applyFontSize = applyFontSize;
    Core.initTextToSpeech = initTextToSpeech;
    Core.loadMermaidCDN = loadMermaidCDN;
    Core.addTTSButton = addTTSButton;
    Core._getRenderMermaidFn = function() { return _renderMermaidFn; };
    
    // Auto-initialize all media subsystems
    initImagePreview();
    initFontSize();
    initTextToSpeech();
    loadMermaidCDN();
    console.log('✅ ui-media 子系统已初始化（图片预览 + 字体 + TTS + Mermaid）');
  }
};
