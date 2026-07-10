// modules/html-utils.js — 统一的 HTML 转义工具（消除 9 处重复定义）
// 完整的 5 字符转义，防止 XSS 注入

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 截断 + 转义（用于消息预览等场景）
function escapeAndTruncate(s, maxLen) {
  maxLen = maxLen || 200;
  var text = (s || '').toString();
  if (text.length > maxLen) text = text.substring(0, maxLen) + '...';
  return escapeHtml(text);
}

// Node.js require 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    name: 'html-utils',
    dependencies: [],
    escapeHtml: escapeHtml,
    escapeAndTruncate: escapeAndTruncate,
  };
}

// 挂载到 window（供 index.html 内联脚本使用）
if (typeof window !== 'undefined') {
  window.escapeHtml = escapeHtml;
  window.escapeAndTruncate = escapeAndTruncate;
}

// 模块 init（供 Core.loadModules 调用）
module.exports.init = function(_Core) {
  _Core.htmlUtils = {
    escapeHtml: escapeHtml,
    escapeAndTruncate: escapeAndTruncate,
  };
};
