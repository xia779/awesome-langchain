// modules/artifact-render.js - Artifact 实时渲染模块
// 检测 AI 消息中的代码块，自动转换为可交互的预览面板
// 支持: HTML, JSX/React, Mermaid, SVG 四种 Artifact 类型

var Core = null;
var observer = null;

// 已处理过的代码块集合（防止重复处理）
var processedBlocks = new WeakSet();

// ═══════════════════════════════════════════
// Artifact 类型检测
// ═══════════════════════════════════════════

var ARTIFACT_TYPES = {
  html: {
    languages: ['html', 'htm'],
    label: 'HTML Preview',
    icon: '🌐',
    renderable: true
  },
  jsx: {
    languages: ['jsx', 'react', 'tsx'],
    label: 'React Preview',
    icon: '⚛️',
    renderable: true
  },
  mermaid: {
    languages: ['mermaid', 'mmd'],
    label: 'Mermaid Diagram',
    icon: '📊',
    renderable: true
  },
  svg: {
    languages: ['svg', 'xml-svg'],
    label: 'SVG Image',
    icon: '🖼️',
    renderable: true
  }
};

/**
 * 从 code 元素的 className 检测语言
 */
function detectLanguage(codeEl) {
  var cls = codeEl.className || '';
  var match = cls.match(/language-(\w[\w-]*)/);
  if (match) return match[1].toLowerCase();
  // 尝试从 pre 的 data 属性获取
  var pre = codeEl.parentElement;
  if (pre && pre.dataset && pre.dataset.lang) return pre.dataset.lang.toLowerCase();
  return '';
}

/**
 * 判断代码块是否属于可渲染的 Artifact 类型
 */
function getArtifactType(lang) {
  if (!lang) return null;
  lang = lang.toLowerCase();
  var types = Object.keys(ARTIFACT_TYPES);
  for (var i = 0; i < types.length; i++) {
    var type = ARTIFACT_TYPES[types[i]];
    if (type.languages.indexOf(lang) !== -1) {
      return { key: types[i], config: type };
    }
  }
  return null;
}

// ═══════════════════════════════════════════
// 渲染引擎
// ═══════════════════════════════════════════

/**
 * 获取代码块的原始文本内容
 */
function getCodeText(codeEl) {
  // 优先从 textContent 获取（保留原始文本）
  var text = codeEl.textContent || '';
  // 去除 hljs 可能添加的行号
  text = text.replace(/^\s*\d+\s*\n/gm, '');
  return text.trim();
}

/**
 * 渲染 HTML Artifact — 使用 sandboxed iframe
 */
function renderHtml(code, iframe) {
  // 构建完整 HTML 文档
  var htmlContent = code;
  if (htmlContent.indexOf('<html') === -1 && htmlContent.indexOf('<!DOCTYPE') === -1) {
    htmlContent = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8">' +
      '<style>body{margin:0;padding:12px;font-family:-apple-system,sans-serif;background:#1a1a2e;color:#e2e8f0;}</style>' +
      '</head><body>' + htmlContent + '</body></html>';
  }

  var blob = new Blob([htmlContent], { type: 'text/html' });
  var url = URL.createObjectURL(blob);
  iframe.src = url;
  iframe.onload = function() {
    // 清理 blob URL
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
    // 自适应高度
    try {
      var h = iframe.contentDocument.body.scrollHeight;
      if (h > 0 && h < 800) {
        iframe.style.height = Math.max(h + 20, 150) + 'px';
      }
    } catch (e) { console.warn('⚠️ [artifact-render] 获取iframe高度失败(cross-origin):', e.message); }
  };
}

/**
 * 渲染 JSX/React Artifact — 转换为 HTML 预览
 * 将 JSX 代码包装在一个带 React + Babel CDN 的 iframe 中执行
 */
function renderJsx(code, iframe) {
  var jsxHtml = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8">' +
    '<script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>' +
    '<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>' +
    '<script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>' +
    '<style>body{margin:0;padding:12px;font-family:-apple-system,sans-serif;background:#1a1a2e;color:#e2e8f0;}' +
    '#root{min-height:100px;}</style></head><body>' +
    '<div id="root"></div>' +
    '<script type="text/babel">' +
    '\n' + code + '\n' +
    '// 尝试自动挂载\n' +
    'try {\n' +
    '  var root = ReactDOM.createRoot(document.getElementById("root"));\n' +
    '  var comps = [App, Component, App.default, Component.default];\n' +
    '  for (var c of comps) { if (typeof c === "function") { root.render(React.createElement(c)); break; } }\n' +
    '} catch(e) { var p=document.createElement("pre");p.style.color="#f87171";p.textContent=e.message;var r=document.getElementById("root");r.innerHTML="";r.appendChild(p); }\n' +
    '<\/script></body></html>';

  var blob = new Blob([jsxHtml], { type: 'text/html' });
  var url = URL.createObjectURL(blob);
  iframe.src = url;
  iframe.onload = function() {
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
    try {
      var h = iframe.contentDocument.body.scrollHeight;
      if (h > 0 && h < 800) iframe.style.height = Math.max(h + 20, 150) + 'px';
    } catch (e) { console.warn('⚠️ [artifact-render] 获取JSX iframe高度失败:', e.message); }
  };
}

/**
 * 渲染 Mermaid 图表
 */
function renderMermaid(code, container) {
  var id = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
  var div = document.createElement('div');
  div.id = id;
  div.className = 'mermaid-preview';
  div.textContent = code;
  container.innerHTML = '';
  container.appendChild(div);

  if (window.mermaid) {
    try {
      // mermaid v10+ 使用 async render
      var renderPromise = window.mermaid.render(id + '-svg', code);
      if (renderPromise && typeof renderPromise.then === 'function') {
        renderPromise.then(function(result) {
          var svgContainer = container.querySelector('.mermaid-preview');
          if (svgContainer) {
            svgContainer.innerHTML = result.svg;
            // 添加错误处理后的样式
            var svg = svgContainer.querySelector('svg');
            if (svg) {
              svg.style.maxWidth = '100%';
              svg.style.height = 'auto';
            }
          }
        }).catch(function(err) {
          container.innerHTML = '<div class="artifact-error">Mermaid 渲染失败: ' + Core.sanitizeHtml(err.message) + '</div>';
          var pre = document.createElement('pre');
          pre.className = 'artifact-fallback';
          var codeEl = document.createElement('code');
          codeEl.textContent = code;
          pre.appendChild(codeEl);
          container.appendChild(pre);
        });
      }
    } catch (e) {
      container.innerHTML = '<div class="artifact-error">Mermaid 渲染错误: ' + Core.sanitizeHtml(e.message) + '</div>';
    }
  } else {
    container.innerHTML = '<div class="artifact-error">Mermaid.js 未加载，无法渲染图表</div>';
    var pre = document.createElement('pre');
    pre.className = 'artifact-fallback';
    var codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    container.appendChild(pre);
  }
}

/**
 * 渲染 SVG 图像
 */
function renderSvg(code, container) {
  // 安全渲染：使用 DOMParser 而不是 innerHTML
  try {
    var parser = new DOMParser();
    var doc = parser.parseFromString(code, 'image/svg+xml');
    var svgEl = doc.querySelector('svg');
    if (svgEl) {
      container.innerHTML = '';
      var imported = document.importNode(svgEl, true);
      imported.style.maxWidth = '100%';
      imported.style.height = 'auto';
      imported.style.display = 'block';
      imported.style.margin = '0 auto';
      container.appendChild(imported);
    } else {
      container.innerHTML = '<div class="artifact-error">无效的 SVG 内容</div>';
    }
  } catch (e) {
    container.innerHTML = '<div class="artifact-error">SVG 解析失败: ' + Core.sanitizeHtml(e.message) + '</div>';
  }
}

// ═══════════════════════════════════════════
// Artifact 面板构建
// ═══════════════════════════════════════════

function createArtifactPanel(preEl, codeEl, lang, artifactType) {
  var code = getCodeText(codeEl);
  if (!code || code.length < 10) return null; // 太短，不渲染

  var typeKey = artifactType.key;
  var config = artifactType.config;

  // 主容器
  var panel = document.createElement('div');
  panel.className = 'artifact-panel';
  panel.dataset.type = typeKey;

  // 工具栏
  var toolbar = document.createElement('div');
  toolbar.className = 'artifact-toolbar';

  var label = document.createElement('span');
  label.className = 'artifact-label';
  label.textContent = config.icon + ' ' + config.label;
  toolbar.appendChild(label);

  // 切换按钮
  var previewBtn = document.createElement('button');
  previewBtn.className = 'artifact-tab active';
  previewBtn.textContent = '预览';
  previewBtn.dataset.tab = 'preview';

  var codeBtn = document.createElement('button');
  codeBtn.className = 'artifact-tab';
  codeBtn.textContent = '代码';
  codeBtn.dataset.tab = 'code';

  var btnGroup = document.createElement('div');
  btnGroup.className = 'artifact-tabs';
  btnGroup.appendChild(previewBtn);
  btnGroup.appendChild(codeBtn);
  toolbar.appendChild(btnGroup);

  // 操作按钮
  var actions = document.createElement('div');
  actions.className = 'artifact-actions';

  var copyBtn = document.createElement('button');
  copyBtn.className = 'artifact-action-btn';
  copyBtn.textContent = '📋 复制';
  copyBtn.title = '复制代码';
  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(code).then(function() {
      copyBtn.textContent = '✅ 已复制';
      setTimeout(function() { copyBtn.textContent = '📋 复制'; }, 2000);
    });
  });
  actions.appendChild(copyBtn);

  // 新窗口打开（仅 HTML/JSX）
  if (typeKey === 'html' || typeKey === 'jsx') {
    var openBtn = document.createElement('button');
    openBtn.className = 'artifact-action-btn';
    openBtn.textContent = '🔗 新窗口';
    openBtn.title = '在新窗口中打开';
    openBtn.addEventListener('click', function() {
      var fullCode = typeKey === 'html' ? code : code;
      var w = window.open('', '_blank', 'width=900,height=700');
      if (w) {
        if (typeKey === 'html') {
          w.document.write(code.indexOf('<html') !== -1 ? code : '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' + code + '</body></html>');
        } else {
          w.document.write('<html><head><meta charset="UTF-8"><title>Preview</title></head><body><pre>' + code.replace(/</g, '&lt;') + '</pre></body></html>');
        }
        w.document.close();
      }
    });
    actions.appendChild(openBtn);
  }

  // 刷新按钮
  var refreshBtn = document.createElement('button');
  refreshBtn.className = 'artifact-action-btn';
  refreshBtn.textContent = '🔄 刷新';
  refreshBtn.title = '重新渲染';
  actions.appendChild(refreshBtn);

  toolbar.appendChild(actions);
  panel.appendChild(toolbar);

  // 预览区域
  var previewArea = document.createElement('div');
  previewArea.className = 'artifact-preview';

  if (typeKey === 'html' || typeKey === 'jsx') {
    var iframe = document.createElement('iframe');
    iframe.className = 'artifact-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.width = '100%';
    iframe.style.minHeight = '200px';
    iframe.style.maxHeight = '500px';
    iframe.style.border = 'none';
    iframe.style.borderRadius = '8px';
    iframe.style.background = '#1a1a2e';
    previewArea.appendChild(iframe);

    // 初始渲染
    if (typeKey === 'html') renderHtml(code, iframe);
    else renderJsx(code, iframe);

    // 刷新
    refreshBtn.addEventListener('click', function() {
      if (typeKey === 'html') renderHtml(code, iframe);
      else renderJsx(code, iframe);
    });
  } else if (typeKey === 'mermaid') {
    renderMermaid(code, previewArea);
    refreshBtn.addEventListener('click', function() {
      renderMermaid(code, previewArea);
    });
  } else if (typeKey === 'svg') {
    renderSvg(code, previewArea);
    refreshBtn.addEventListener('click', function() {
      renderSvg(code, previewArea);
    });
  }

  panel.appendChild(previewArea);

  // 代码区域（默认隐藏）
  var codeArea = document.createElement('div');
  codeArea.className = 'artifact-code';
  codeArea.style.display = 'none';
  codeArea.appendChild(preEl.cloneNode(true)); // 保留 hljs 高亮
  panel.appendChild(codeArea);

  // 切换逻辑
  previewBtn.addEventListener('click', function() {
    previewArea.style.display = 'block';
    codeArea.style.display = 'none';
    previewBtn.classList.add('active');
    codeBtn.classList.remove('active');
  });

  codeBtn.addEventListener('click', function() {
    previewArea.style.display = 'none';
    codeArea.style.display = 'block';
    codeBtn.classList.add('active');
    previewBtn.classList.remove('active');
  });

  return panel;
}

// ═══════════════════════════════════════════
// MutationObserver — 自动检测并转换代码块
// ═══════════════════════════════════════════

function processMessage(msgEl) {
  if (!msgEl || !msgEl.classList || !msgEl.classList.contains('ai')) return;

  var preElements = msgEl.querySelectorAll('pre');
  for (var i = 0; i < preElements.length; i++) {
    var pre = preElements[i];
    if (processedBlocks.has(pre)) continue;

    var codeEl = pre.querySelector('code');
    if (!codeEl) continue;

    var lang = detectLanguage(codeEl);
    var artifactType = getArtifactType(lang);

    if (artifactType && artifactType.config.renderable) {
      processedBlocks.add(pre);

      var panel = createArtifactPanel(pre, codeEl, lang, artifactType);
      if (panel) {
        // 在 pre 之前插入面板，然后隐藏原始 pre
        pre.parentNode.insertBefore(panel, pre);
        pre.style.display = 'none';
        pre.classList.add('artifact-replaced');
      }
    } else {
      processedBlocks.add(pre);
    }
  }
}

function startObserver() {
  // 通过统一 chatObserver 分发，不再创建独立 MutationObserver
  if (!Core.chatObserver) {
    console.warn('artifact-render: Core.chatObserver 不可用');
    return;
  }
  Core.chatObserver.onMessage(function(node) {
    if (node.classList.contains('msg')) {
      setTimeout(function() { processMessage(node); }, 200);
    }
  });
  console.log('✅ Artifact 渲染已注册到统一 chatObserver');
}

// ═══════════════════════════════════════════
// /artifact 命令
// ═══════════════════════════════════════════

function handleArtifactCommand(args) {
  var sub = (args || '').trim().toLowerCase();

  if (!sub || sub === 'help') {
    return '🎨 **Artifact 渲染命令**\n\n' +
      '支持的代码块类型（AI 回复中自动渲染为预览面板）:\n' +
      '- `html` — HTML 页面预览（iframe）\n' +
      '- `jsx` / `react` — React 组件预览\n' +
      '- `mermaid` — 流程图/时序图/甘特图\n' +
      '- `svg` — SVG 矢量图\n\n' +
      '命令:\n' +
      '- `/artifact refresh` — 刷新当前会话所有 Artifact\n' +
      '- `/artifact stats` — 统计当前 Artifact 数量';
  }

  if (sub === 'refresh') {
    processedBlocks = new WeakSet();
    var msgs = document.querySelectorAll('.msg.ai');
    var count = 0;
    msgs.forEach(function(msg) {
      // 移除旧面板
      msg.querySelectorAll('.artifact-panel').forEach(function(p) { p.remove(); });
      msg.querySelectorAll('pre.artifact-replaced').forEach(function(p) {
        p.style.display = '';
        p.classList.remove('artifact-replaced');
      });
      processMessage(msg);
      count++;
    });
    return '🔄 已刷新 ' + count + ' 条消息的 Artifact 渲染';
  }

  if (sub === 'stats') {
    var panels = document.querySelectorAll('.artifact-panel');
    var stats = { html: 0, jsx: 0, mermaid: 0, svg: 0 };
    panels.forEach(function(p) {
      var type = p.dataset.type;
      if (stats[type] !== undefined) stats[type]++;
    });
    var total = Object.values(stats).reduce(function(a, b) { return a + b; }, 0);
    return '📊 **Artifact 统计**\n\n' +
      '总计: ' + total + ' 个\n' +
      '- HTML: ' + stats.html + '\n' +
      '- React/JSX: ' + stats.jsx + '\n' +
      '- Mermaid: ' + stats.mermaid + '\n' +
      '- SVG: ' + stats.svg;
  }

  return '未知命令。使用 `/artifact help` 查看帮助。';
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.artifactRender = {
      processMessage: processMessage,
      refreshAll: function() {
        processedBlocks = new WeakSet();
        document.querySelectorAll('.msg.ai').forEach(function(msg) {
          msg.querySelectorAll('.artifact-panel').forEach(function(p) { p.remove(); });
          msg.querySelectorAll('pre.artifact-replaced').forEach(function(p) {
            p.style.display = '';
            p.classList.remove('artifact-replaced');
          });
          processMessage(msg);
        });
      },
      handleCommand: handleArtifactCommand
    };

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/artifact', function(args) {
        return handleArtifactCommand(args);
      });
    }

    // 启动观察器
    setTimeout(startObserver, 500);

    console.log('✅ Artifact 渲染模块已加载');
  }
};
