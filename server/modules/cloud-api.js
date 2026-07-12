// server/modules/cloud-api.js — LLM API proxy (uses Node 20+ global fetch)
var Core;

async function fetchJSON(url, options) {
  var res = await fetch(url, options);
  var text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch (e) { return { status: res.status, data: text }; }
}

async function callOllama(prompt, systemPrompt, temperature, model) {
  var baseUrl = Core.config.ollamaUrl || 'http://127.0.0.1:11434';
  var modelName = model || Core.config.ollamaModel || 'qwen2.5:7b';
  var messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  
  var body = {
    model: modelName,
    messages: messages,
    stream: false,
    options: { temperature: temperature || 0.7 }
  };
  
  var result = await fetchJSON(baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  if (result.data && result.data.message) {
    return { message: result.data.message, provider: 'ollama' };
  }
  throw new Error('Ollama error: ' + JSON.stringify(result.data).substring(0, 200));
}

async function callCloudAPI(provider, prompt, systemPrompt, temperature) {
  var apiKey = Core.config[provider + 'Key'] || '';
  if (!apiKey) throw new Error(provider + ' API key not configured');

  var configs = {
    deepseek: { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
    qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    silicon: { url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct' }
  };

  var cfg = configs[provider];
  if (!cfg) throw new Error('Unknown provider: ' + provider);

  var messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  // Fix temperature for DashScope (requires float)
  var temp = temperature || 0.7;
  if (provider === 'qwen' && temp === Math.floor(temp)) temp = temp + 0.1;

  var result = await fetchJSON(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: messages,
      temperature: temp,
      max_tokens: 4096
    })
  });

  if (result.data && result.data.choices && result.data.choices[0]) {
    return { message: result.data.choices[0].message, provider: provider };
  }
  throw new Error(provider + ' error: ' + JSON.stringify(result.data).substring(0, 200));
}

async function callAPI(prompt, systemPrompt, temperature, model, provider) {
  var p = provider || Core.config.defaultProvider || 'ollama';
  if (p === 'ollama') return callOllama(prompt, systemPrompt, temperature, model);
  return callCloudAPI(p, prompt, systemPrompt, temperature);
}

// Streaming version
async function callAPIStream(prompt, systemPrompt, temperature, model, provider, onChunk) {
  var p = provider || Core.config.defaultProvider || 'ollama';
  var baseUrl = Core.config.ollamaUrl || 'http://127.0.0.1:11434';
  var modelName = model || Core.config.ollamaModel || 'qwen2.5:7b';

  var messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  if (p === 'ollama') {
    var res = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, messages: messages, stream: true, options: { temperature: temperature || 0.7 } })
    });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var fullText = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      var lines = decoder.decode(chunk.value).split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          var json = JSON.parse(lines[i]);
          if (json.message && json.message.content) {
            fullText += json.message.content;
            if (onChunk) onChunk(json.message.content, fullText);
          }
        } catch (e) { /* skip */ }
      }
    }
    return { message: { content: fullText }, provider: 'ollama' };
  }

  // Cloud providers use OpenAI-compatible streaming
  var configs = {
    deepseek: { url: 'https://api.deepseek.com/chat/completions' },
    qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
    openai: { url: 'https://api.openai.com/v1/chat/completions' },
    silicon: { url: 'https://api.siliconflow.cn/v1/chat/completions' }
  };
  var cfg = configs[p];
  if (!cfg) throw new Error('Unknown provider: ' + p);
  var apiKey = Core.config[p + 'Key'] || '';
  if (!apiKey) throw new Error(p + ' API key not configured');

  var res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: Core.config[p + 'Model'] || 'default', messages: messages, stream: true, temperature: temperature || 0.7 })
  });

  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  var fullText = '';
  var buffer = '';
  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        var json = JSON.parse(line.substring(6));
        var delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && delta.content) {
          fullText += delta.content;
          if (onChunk) onChunk(delta.content, fullText);
        }
      } catch (e) { /* skip */ }
    }
  }
  return { message: { content: fullText }, provider: p };
}

module.exports = {
  name: 'cloud-api',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    Core.registerModule('api', {
      callAPI: callAPI,
      callAPIStream: callAPIStream,
      callOllama: callOllama,
      callCloudAPI: callCloudAPI
    });
  }
};
