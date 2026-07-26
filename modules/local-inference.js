// modules/local-inference.js - 本地推理兜底客户端 (P2-3)
// 设计原则：只完善、不删功能；零外部依赖（复用 Node 内置全局 fetch）。
// 作用：当所有云端提供商调用失败且 config.localInference.enabled 为 true 时，
//       把请求兜回到本地 OpenAI 兼容推理端点（如 Ollama /v1/chat/completions）。
// 自动加载：core-v10.js 会扫描 modules/ 并调用 init(Core)。
'use strict';

var Core = null;

// 读取本地推理配置（默认关闭，确保不改变现有行为）
function _cfg() {
  return (Core && Core.config && Core.config.localInference) || {};
}

function isEnabled() {
  return _cfg().enabled === true;
}

function _baseURL() {
  return _cfg().baseURL || 'http://127.0.0.1:11434/v1';
}

function _apiKey() {
  return _cfg().apiKey || 'ollama';
}

// ===== 纯函数（导出供单测）=====

function _buildMessages(prompt, systemMsg) {
  var msgs = [];
  if (systemMsg) msgs.push({ role: 'system', content: String(systemMsg) });
  msgs.push({ role: 'user', content: String(prompt) });
  return msgs;
}

function _buildBody(model, messages, opts) {
  opts = opts || {};
  return {
    model: model,
    messages: messages,
    temperature: (typeof opts.temperature === 'number') ? opts.temperature : 0.7,
    max_tokens: opts.maxTokens || 4096,
    stream: !!opts.stream
  };
}

function _parseCompletion(data) {
  // 兼容 OpenAI 格式 { choices:[{ message:{ content } }] }
  try {
    var content = data && data.choices && data.choices[0] && data.choices[0].message
      ? (data.choices[0].message.content || '')
      : '';
    return { content: content, model: data && data.model ? data.model : '', raw: data };
  } catch (e) {
    return { content: '', model: '', raw: data };
  }
}

// 解析一行 SSE（"data: {...}" 或 "data: [DONE]"），返回 delta content 或 null
function _parseStreamLine(line) {
  if (!line) return null;
  var s = String(line).trim();
  if (s.indexOf('data:') !== 0) return null;
  var payload = s.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    var json = JSON.parse(payload);
    var delta = json.choices && json.choices[0] && json.choices[0].delta;
    return delta && delta.content ? delta.content : null;
  } catch (e) {
    return null;
  }
}

// ===== 模型解析 =====

async function _resolveModel(opts, fetchFn) {
  if (opts && opts.model) return opts.model;
  var cfgModel = _cfg().model;
  if (cfgModel) return cfgModel;
  // 未显式指定 → 尝试列出本地模型并取第一个
  try {
    var list = await listModels(fetchFn);
    if (list && list.length) return list[0];
  } catch (e) { /* 忽略，下面抛清晰错误 */ }
  throw new Error('本地推理未指定模型：请在设置中配置 localInference.model（如 qwen2.5:latest），或确保本地端点已加载模型。');
}

async function listModels(fetchFn) {
  var fn = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('运行环境不支持 fetch');
  var url = _baseURL().replace(/\/$/, '') + '/models';
  var res = await fn(url, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + _apiKey() }
  });
  if (!res.ok) throw new Error('列出本地模型失败 HTTP ' + res.status);
  var data = await res.json();
  // Ollama /v1/models => { data:[{ id }] }
  var arr = (data && data.data) || [];
  return arr.map(function (m) { return m.id; });
}

// ===== 非流式补全 =====

async function complete(prompt, systemMsg, opts) {
  opts = opts || {};
  if (!isEnabled()) throw new Error('本地推理兜底未启用（config.localInference.enabled=false）');
  var fn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('运行环境不支持 fetch');

  var model = await _resolveModel(opts, fn);
  var messages = _buildMessages(prompt, systemMsg);
  var body = _buildBody(model, messages, { temperature: opts.temperature, maxTokens: opts.maxTokens, stream: false });

  var res = await fn(_baseURL().replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + _apiKey()
    },
    body: JSON.stringify(body),
    signal: opts.signal || null
  });
  if (!res.ok) {
    var errText = await res.text().catch(function () { return ''; });
    throw new Error('本地推理请求失败 (' + res.status + '): ' + errText.substring(0, 200));
  }
  var data = await res.json();
  var parsed = _parseCompletion(data);
  return { content: parsed.content, model: parsed.model, raw: parsed.raw };
}

// ===== 流式补全 =====

async function stream(prompt, systemMsg, opts, onChunk) {
  opts = opts || {};
  if (typeof onChunk !== 'function') onChunk = function () {};
  if (!isEnabled()) throw new Error('本地推理兜底未启用（config.localInference.enabled=false）');
  var fn = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('运行环境不支持 fetch');

  var model = await _resolveModel(opts, fn);
  var messages = _buildMessages(prompt, systemMsg);
  var body = _buildBody(model, messages, { temperature: opts.temperature, maxTokens: opts.maxTokens, stream: true });

  var res = await fn(_baseURL().replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + _apiKey()
    },
    body: JSON.stringify(body),
    signal: opts.signal || null
  });
  if (!res.ok) {
    var errText = await res.text().catch(function () { return ''; });
    throw new Error('本地推理流式请求失败 (' + res.status + '): ' + errText.substring(0, 200));
  }
  if (!res.body || !res.body.getReader) {
    // 非流式回退：直接解析 JSON
    var data = await res.json();
    var c = _parseCompletion(data).content;
    onChunk(c);
    return c;
  }

  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var full = '';
  while (true) {
    var r = await reader.read();
    if (r.done) break;
    buffer += decoder.decode(r.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var piece = _parseStreamLine(lines[i]);
      if (piece) { full += piece; onChunk(piece); }
    }
  }
  return full;
}

// ===== 配置 =====

function configure(partial) {
  partial = partial || {};
  if (!Core.config) Core.config = {};
  if (!Core.config.localInference) Core.config.localInference = {};
  Object.assign(Core.config.localInference, partial);
  return Core.config.localInference;
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  Core.localInference = {
    complete: complete,
    stream: stream,
    listModels: listModels,
    isEnabled: isEnabled,
    configure: configure,
    // 供其他模块/测试直接调用
    _buildMessages: _buildMessages,
    _buildBody: _buildBody,
    _parseCompletion: _parseCompletion,
    _parseStreamLine: _parseStreamLine
  };
  var status = isEnabled()
    ? ('已启用 -> ' + _baseURL())
    : '未启用（config.localInference.enabled=false）';
  console.log('✅ local-inference.js 已加载 (' + status + ')');
}

module.exports = {
  name: 'local-inference',
  dependencies: [],
  init: init,
  _buildMessages: _buildMessages,
  _buildBody: _buildBody,
  _parseCompletion: _parseCompletion,
  _parseStreamLine: _parseStreamLine
};
