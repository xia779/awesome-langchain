// modules/pipeline-webapp.js - Single-page HTML webapp generator
const fs = require('fs');
const path = require('path');

let Core = null;

function getOutputDir() {
  if (Core.deliverables && Core.deliverables.getOutputDir) {
    return Core.deliverables.getOutputDir('webapp');
  }
  const dir = Core.pathService.perUser(path.join('deliverables', 'webapps'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function registerDeliverable(filePath, title) {
  if (Core.deliverables && Core.deliverables.register) {
    Core.deliverables.register({ type: 'webapp', filePath, title });
  }
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\|?*]/g, '_').slice(0, 80);
}

// ═══════════════════════════════════════════
// generate - Combine html/css/js into single file
// ═══════════════════════════════════════════
function generate(options) {
  const { title, html, css, js, outputPath } = options || {};
  if (!title) return { success: false, error: 'title is required' };
  if (!html) return { success: false, error: 'html content is required' };

  const fullHtml = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>' + title + '</title>',
    css ? '<style>\n' + css + '\n</style>' : '',
    '</head>',
    '<body>',
    html,
    js ? '<script>\n' + js + '\n</script>' : '',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');

  const dir = getOutputDir();
  const fileName = sanitizeFilename(title) + '_' + Date.now() + '.html';
  const filePath = outputPath || path.join(dir, fileName);

  try {
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(filePath, fullHtml, 'utf8');
  } catch (e) {
    return { success: false, error: 'Write failed: ' + e.message };
  }

  registerDeliverable(filePath, title);
  return { success: true, filePath };
}

// ═══════════════════════════════════════════
// fromDescription - AI-generate webapp from text
// ═══════════════════════════════════════════
async function fromDescription(description) {
  if (!description) return { success: false, error: 'description is required' };
  if (!Core.api || !Core.api.callAPI) {
    return { success: false, error: 'Core.api.callAPI not available' };
  }

  const systemPrompt = 'Generate a complete single-page web application. Output format: ```html\n<full html>\n```';

  let response;
  try {
    var apiResult = await Core.api.callAPI(description, systemPrompt, 0.7, null, null);
    // 🔧 B14: callAPI 返回 {message:{content}} 对象，需提取文本
    response = (apiResult && apiResult.message && apiResult.message.content) || '';
  } catch (e) {
    return { success: false, error: 'API call failed: ' + e.message };
  }

  if (!response || typeof response !== 'string') {
    return { success: false, error: 'Empty response from API' };
  }

  // Parse HTML from response (extract from code block or use raw)
  let htmlContent = response;
  const match = response.match(/```html\s*\n([\s\S]*?)```/);
  if (match) htmlContent = match[1].trim();

  const title = description.slice(0, 60).replace(/[<>:"/\|?*]/g, '_');
  const dir = getOutputDir();
  const fileName = sanitizeFilename(title) + '_' + Date.now() + '.html';
  const filePath = path.join(dir, fileName);

  try {
    fs.writeFileSync(filePath, htmlContent, 'utf8');
  } catch (e) {
    return { success: false, error: 'Write failed: ' + e.message };
  }

  registerDeliverable(filePath, title);
  return { success: true, filePath };
}

// ═══════════════════════════════════════════
// getPreviewUrl - Local preview URL
// ═══════════════════════════════════════════
function getPreviewUrl(filePath) {
  if (!filePath) return null;
  const fileName = path.basename(filePath);
  // 🔧 B15: 使用动态端口（不再硬编码 8082）
  var base = (Core && typeof Core.getBackendBase === 'function') ? Core.getBackendBase() : 'http://localhost:8080';
  return base + '/deliverables/webapps/' + fileName;
}

// ═══════════════════════════════════════════
// Module init
// ═══════════════════════════════════════════
function init(_Core) {
  Core = _Core;
  Core.pipelineWebapp = { generate, fromDescription, getPreviewUrl };
  console.log('[pipeline-webapp] initialized');
}

module.exports = { name: 'pipeline-webapp', dependencies: [], init };
