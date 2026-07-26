// modules/multimodal-extract.js - 多模态提取（图像/文件 → 文本/描述）(P2-4)
// 设计原则：只完善、不删功能；零外部依赖（复用 Node fs + 全局 fetch + Core.cloudApi 视觉能力）。
// 流程：图片(本地/URL) → base64 dataURL → 构造 OpenAI 兼容 vision 消息 → 经 Core.cloudApi 提取文本/描述；
//      若未配置支持视觉的模型，则回退为文件元数据说明（绝不崩、绝不谎报 OCR 结果）。
'use strict';

var Core = null;
var fs = null;
var path = null;

var MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json'
};

function _mimeOf(name) {
  var ext = String(name || '').split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// ===== 纯函数（导出供单测）=====

function _toDataUrl(buffer, mime) {
  var b64 = Buffer.from(buffer).toString('base64');
  return 'data:' + (mime || 'application/octet-stream') + ';base64,' + b64;
}

function _buildVisionMessages(prompt, dataUrl) {
  return [
    { role: 'user', content: [
      { type: 'text', text: String(prompt || '请提取并描述这张图片中的文字与关键信息。') },
      { type: 'image_url', image_url: { url: dataUrl } }
    ] }
  ];
}

// ===== 读取/抓取为 dataURL =====

function _fileToDataUrl(filePath) {
  var buf = fs.readFileSync(filePath);
  return _toDataUrl(buf, _mimeOf(filePath));
}

async function _urlToDataUrl(url, fetchFn) {
  var fn = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('运行环境不支持 fetch');
  var res = await fn(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var buf = Buffer.from(await res.arrayBuffer());
  var mime = (res.headers && res.headers.get && res.headers.get('content-type')) || _mimeOf(url);
  return _toDataUrl(buf, mime);
}

// ===== 提取主流程 =====

async function extract(filePathOrUrl, prompt, opts) {
  opts = opts || {};
  var isUrl = /^https?:\/\//i.test(String(filePathOrUrl || ''));
  var dataUrl, name;
  try {
    if (isUrl) { dataUrl = await _urlToDataUrl(filePathOrUrl, opts.fetch); name = filePathOrUrl; }
    else { dataUrl = _fileToDataUrl(filePathOrUrl); name = path.basename(filePathOrUrl); }
  } catch (e) {
    return { ok: false, source: 'error', text: '', error: e.message };
  }

  var api = opts.cloudApi || (Core && Core.cloudApi && Core.cloudApi.callCloudAPI);
  if (api && !opts.noCloud) {
    try {
      var messages = _buildVisionMessages(prompt, dataUrl);
      var provider = opts.provider || (Core.cloudApi && Core.cloudApi.getCurrentService ? Core.cloudApi.getCurrentService() : null);
      var data = await api(prompt || '提取图片', '你是图像理解助手，擅长 OCR 与结构化描述。', opts.temperature || 0.2, opts.model || null, provider, { messages: messages, disableTools: true });
      var text = data && data.choices && data.choices[0] && data.choices[0].message ? (data.choices[0].message.content || '') : '';
      return { ok: true, source: 'vision', text: text, model: data && data.model, name: name };
    } catch (e) {
      // 视觉失败 → 回退元数据
      return { ok: true, source: 'metadata', text: '', name: name, note: '视觉模型调用失败，仅返回文件元数据：' + e.message };
    }
  }

  // 无视觉能力：返回文件元数据
  var stat = { name: name, mime: _mimeOf(name) };
  try { if (!isUrl) { var st = fs.statSync(filePathOrUrl); stat.size = st.size; } } catch (e) {}
  return { ok: true, source: 'metadata', text: '', name: name, info: stat, note: '未配置支持视觉的模型（请在设置中启用具备视觉能力的服务），仅返回文件元数据。' };
}

// ===== 命令 =====

function showMsg(text) {
  try {
    if (Core.session && Core.session.getCurrentId && Core.session.addMessage) {
      Core.session.addMessage(text, 'assistant');
      var id = Core.session.getCurrentId();
      if (Core.session.renderMessages) Core.session.renderMessages(id);
    }
  } catch (e) { console.log('[multimodal-extract] ' + text); }
}

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('extract', {
    zh: '多模态提取: /extract <图片路径或URL> [提示词] — 从图片提取文字/描述',
    en: 'Extract text/description from an image'
  }, function (args) {
    var parts = (args || '').trim().split(/\s+/);
    var target = parts[0];
    if (!target) { showMsg('⚠️ 用法: /extract <图片路径或URL> [提示词]\n示例: /extract C:/pic/receipt.png 提取发票金额'); return; }
    var prompt = parts.slice(1).join(' ') || '请提取并描述这张图片中的文字与关键信息。';
    showMsg('🔍 正在分析: ' + target + ' ...');
    extract(target, prompt).then(function (r) {
      if (r.source === 'vision') {
        showMsg('✅ **提取结果**\n\n' + (r.text || '(空)') + '\n\n_来源: 视觉模型_');
      } else if (r.source === 'metadata') {
        showMsg('ℹ️ ' + (r.note || '仅返回元数据') + '\n文件: ' + (r.name || '') + (r.info && r.info.size != null ? ' | ' + r.info.size + ' 字节' : ''));
      } else {
        showMsg('⚠️ 提取失败: ' + (r.error || '未知错误'));
      }
    }).catch(function (e) { showMsg('⚠️ 提取异常: ' + e.message); });
  });
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  try { fs = require('fs'); path = require('path'); } catch (e) {
    console.warn('multimodal-extract.js: 依赖不可用', e.message); return;
  }
  registerCommands();
  Core.multimodalExtract = {
    extract: extract,
    extractFromFile: function (p, prompt, o) { return extract(p, prompt, o); }
  };
  console.log('✅ multimodal-extract.js 已加载');
}

module.exports = {
  name: 'multimodal-extract',
  dependencies: [],
  init: init,
  _buildVisionMessages: _buildVisionMessages,
  _toDataUrl: _toDataUrl
};
