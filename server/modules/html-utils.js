// server/modules/html-utils.js — Text utility functions (no DOM)
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAndTruncate(str, maxLen) {
  var escaped = escapeHtml(str);
  if (maxLen && escaped.length > maxLen) escaped = escaped.substring(0, maxLen) + '...';
  return escaped;
}

module.exports = {
  name: 'html-utils',
  dependencies: [],
  init: function(Core) {
    Core.registerModule('htmlUtils', { escapeHtml: escapeHtml, escapeAndTruncate: escapeAndTruncate });
  },
  escapeHtml: escapeHtml,
  escapeAndTruncate: escapeAndTruncate
};
