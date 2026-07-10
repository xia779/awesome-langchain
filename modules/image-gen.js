// modules/image-gen.js - AI 图像 + 视频生成模块
// 图片：DALL-E (OpenAI)、Silicon Flow、本地 ComfyUI
// 视频：Silicon Flow (Wan 2.1 / CogVideoX)
var Core = null;

// ================================================================
//  图片生成
// ================================================================
async function generateImage(prompt, options) {
  options = options || {};
  var provider = options.provider || Core.config.imageGenProvider || 'silicon';
  var size = options.size || Core.config.imageGenSize || '1024x1024';
  console.log('\ud83c\udfa8 \u56fe\u50cf\u751f\u6210: provider=' + provider + ', prompt="' + prompt.substring(0, 50) + '..."');

  // 构建降级链
  var providers = [provider];
  if (provider === 'comfyui') {
    providers.push('silicon');  // ComfyUI → SiliconFlow
  } else if (provider === 'silicon') {
    providers.push('comfyui');  // SiliconFlow → ComfyUI (如果本地可用)
  }

  var lastError = null;
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    try {
      var result;
      switch (p) {
        case 'openai': result = await generateDallE(prompt, size); break;
        case 'silicon': result = await generateSiliconFlow(prompt, size); break;
        case 'comfyui': result = await generateComfyUI(prompt, options); break;
        default: throw new Error('\u672a\u77e5\u56fe\u50cf\u751f\u6210\u5f15\u64ce: ' + p);
      }
      if (i > 0) {
        console.log('🔄 降级成功: ' + provider + ' → ' + p);
        result.fallback = p;
      }
      return result;
    } catch (e) {
      lastError = e;
      console.warn('⚠️ ' + p + ' 失败:', e.message);
      // 如果是最后一个提供者，抛出原始错误
      if (i === providers.length - 1) throw e;
    }
  }
  throw lastError || new Error('所有图像生成引擎均失败');
}

// ===== DALL-E (OpenAI) =====
async function generateDallE(prompt, size) {
  var apiKey = Core.config.openaiImageKey || Core.config.deepseekKey;
  if (!apiKey) throw new Error('\u8bf7\u914d\u7f6e OpenAI API Key');
  var baseUrl = Core.config.openaiImageBase || 'https://api.openai.com/v1';
  var model = Core.config.openaiImageModel || 'dall-e-3';
  var resp = await fetch(baseUrl + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: model, prompt: prompt, n: 1, size: size, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    var errText = await resp.text();
    throw new Error('DALL-E \u8bf7\u6c42\u5931\u8d25 (' + resp.status + '): ' + errText.substring(0, 200));
  }
  var data = await resp.json();
  if (data.data && data.data[0]) {
    var imgData = data.data[0];
    if (imgData.b64_json) return { url: 'data:image/png;base64,' + imgData.b64_json, revised_prompt: imgData.revised_prompt || '' };
    if (imgData.url) return { url: imgData.url, revised_prompt: imgData.revised_prompt || '' };
  }
  throw new Error('DALL-E \u8fd4\u56de\u683c\u5f0f\u5f02\u5e38');
}

// ===== Silicon Flow (图片) =====
// 可用模型列表（按优先级排序，第一个失败自动尝试下一个）
var SILICON_IMAGE_MODELS = [
  'black-forest-labs/FLUX.1-schnell',
  'stabilityai/stable-diffusion-3-5-large',
  'Kwai-Kolors/Kolors'
];

async function generateSiliconFlow(prompt, size) {
  var apiKey = Core.config.siliconFlowKey;
  if (!apiKey) throw new Error('\u8bf7\u914d\u7f6e Silicon Flow API Key\uff08\u8bbe\u7f6e\u9762\u677f \u2192 \u56fe\u50cf\u751f\u6210\uff09');
  if (apiKey.startsWith('Bearer ')) apiKey = apiKey.substring(7);
  var model = Core.config.siliconFlowModel || 'black-forest-labs/FLUX.1-schnell';
  var actualSize = ({ '1024x1024': '1024x1024', '1024x1792': '1024x1792', '1792x1024': '1792x1024' })[size] || '1024x1024';

  // 构建模型候选列表：用户配置的模型优先，后面跟备选
  var modelsToTry = [model];
  for (var mi = 0; mi < SILICON_IMAGE_MODELS.length; mi++) {
    if (SILICON_IMAGE_MODELS[mi] !== model) modelsToTry.push(SILICON_IMAGE_MODELS[mi]);
  }

  var lastError = null;
  for (var tryIdx = 0; tryIdx < modelsToTry.length; tryIdx++) {
    var tryModel = modelsToTry[tryIdx];
    try {
      console.log('🎨 SiliconFlow 尝试模型: ' + tryModel + ' (第' + (tryIdx + 1) + '次)');
      var resp = await fetch('https://api.siliconflow.cn/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: tryModel, prompt: prompt, image_size: actualSize, num_inference_steps: 20, batch_size: 1 }),
        signal: AbortSignal.timeout(180000),
      });
      if (!resp.ok) {
        var errText = await resp.text();
        // 如果是模型被禁用（code 30003），自动尝试下一个模型
        if (errText.includes('30003') || errText.includes('Model disabled') || resp.status === 403) {
          console.warn('⚠️ 模型 ' + tryModel + ' 不可用，尝试备选...');
          lastError = 'Silicon Flow \u8bf7\u6c42\u5931\u8d25 (' + resp.status + '): ' + errText.substring(0, 200);
          continue;
        }
        throw new Error('Silicon Flow \u8bf7\u6c42\u5931\u8d25 (' + resp.status + '): ' + errText.substring(0, 200));
      }
      var data = await resp.json();
      // 兼容两种响应格式：images[] 和 data[]
      var imgList = data.images || data.data;
      if (imgList && imgList[0]) {
        var img = imgList[0];
        if (img.url) return { url: img.url, revised_prompt: '' };
        if (img.b64_json) return { url: 'data:image/png;base64,' + img.b64_json, revised_prompt: '' };
      }
      throw new Error('Silicon Flow \u8fd4\u56de\u683c\u5f0f\u5f02\u5e38');
    } catch (e) {
      if (tryIdx < modelsToTry.length - 1 && (e.message.includes('30003') || e.message.includes('Model disabled') || e.message.includes('不可用'))) {
        continue;
      }
      throw e;
    }
  }
  throw new Error(lastError || 'Silicon Flow \u6240\u6709\u6a21\u578b\u5747\u4e0d\u53ef\u7528');
}

// ===== ComfyUI (本地) — 完整集成 =====

// ComfyUI 状态缓存
var _comfyuiStatus = null;
var _comfyuiStatusTime = 0;
var _comfyuiModels = null;
var _comfyuiWs = null;

// 健康检查（60s 缓存）
async function checkComfyUI(force) {
  var baseUrl = Core.config.comfyuiBase || 'http://127.0.0.1:8188';
  var now = Date.now();
  if (!force && _comfyuiStatus && (now - _comfyuiStatusTime) < 60000) {
    return _comfyuiStatus;
  }
  try {
    var resp = await fetch(baseUrl + '/system_stats', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      var data = await resp.json();
      _comfyuiStatus = {
        online: true,
        gpu: (data.devices && data.devices[0]) ? {
          name: data.devices[0].name,
          vram_total: data.devices[0].vram_total,
          vram_free: data.devices[0].vram_free
        } : null,
        python: data.python_version || '',
        torch: data.torch_version || '',
        os: data.os || ''
      };
      _comfyuiStatusTime = now;
      console.log('✅ ComfyUI 在线:', JSON.stringify(_comfyuiStatus.gpu || {}));
      return _comfyuiStatus;
    }
  } catch (e) {
    // ComfyUI 不可用
  }
  _comfyuiStatus = { online: false };
  _comfyuiStatusTime = now;
  return _comfyuiStatus;
}

// 获取可用模型列表（checkpoints + LoRA）
async function getComfyUIModels() {
  if (_comfyuiModels) return _comfyuiModels;
  var baseUrl = Core.config.comfyuiBase || 'http://127.0.0.1:8188';
  try {
    var resp = await fetch(baseUrl + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { checkpoints: [], loras: [] };
    var data = await resp.json();
    var checkpoints = [];
    if (data.CheckpointLoaderSimple && data.CheckpointLoaderSimple.input && data.CheckpointLoaderSimple.input.required) {
      checkpoints = data.CheckpointLoaderSimple.input.required.ckpt_name[0] || [];
    }
    // 获取 LoRA 列表
    var loras = [];
    try {
      var loraResp = await fetch(baseUrl + '/object_info/LoraLoader', { signal: AbortSignal.timeout(5000) });
      if (loraResp.ok) {
        var loraData = await loraResp.json();
        if (loraData.LoraLoader && loraData.LoraLoader.input && loraData.LoraLoader.input.required) {
          loras = loraData.LoraLoader.input.required.lora_name[0] || [];
        }
      }
    } catch (e) {}
    _comfyuiModels = { checkpoints: checkpoints, loras: loras };
    console.log('🎨 ComfyUI 模型: ' + checkpoints.length + ' checkpoints, ' + loras.length + ' LoRAs');
    return _comfyuiModels;
  } catch (e) {
    console.warn('⚠️ ComfyUI 模型列表获取失败:', e.message);
    return { checkpoints: [], loras: [] };
  }
}

// WebSocket 进度监听
function _connectComfyUIWs(clientId, onProgress) {
  var baseUrl = Core.config.comfyuiBase || 'http://127.0.0.1:8188';
  var wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws?clientId=' + clientId;
  try {
    if (_comfyuiWs) { try { _comfyuiWs.close(); } catch (e) {} }
    _comfyuiWs = new WebSocket(wsUrl);
    _comfyuiWs.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'progress' && onProgress) {
          onProgress({
            value: msg.data.value || 0,
            max: msg.data.max || 0,
            percent: msg.data.max > 0 ? Math.round((msg.data.value / msg.data.max) * 100) : 0
          });
        } else if (msg.type === 'executing') {
          // 节点执行状态
        } else if (msg.type === 'execution_error') {
          console.error('ComfyUI 执行错误:', msg.data);
        }
      } catch (e) {}
    };
    _comfyuiWs.onerror = function(e) { console.warn('ComfyUI WebSocket 错误'); };
    _comfyuiWs.onclose = function() { _comfyuiWs = null; };
  } catch (e) {
    console.warn('ComfyUI WebSocket 连接失败:', e.message);
  }
}

// 默认 txt2img 工作流
function _buildTxt2ImgWorkflow(prompt, options) {
  var size = options.size || '1024x1024';
  var parts = size.split('x');
  var width = parseInt(parts[0]) || 1024;
  var height = parseInt(parts[1]) || 1024;
  var model = options.model || (Core.config.comfyuiModel) || 'v1-5-pruned-emaonly.safetensors';
  var steps = options.steps || 20;
  var cfg = options.cfg || 7;
  var sampler = options.sampler || 'euler';
  var scheduler = options.scheduler || 'normal';
  var negative = options.negative || 'blurry, bad quality, worst quality, deformed';
  var seed = options.seed || Math.floor(Math.random() * 2147483647);

  var workflow = {
    "3": { "class_type": "KSampler", "inputs": {
      "cfg": cfg, "denoise": 1, "latent_image": ["5", 0], "model": ["4", 0],
      "negative": ["7", 0], "positive": ["6", 0],
      "sampler_name": sampler, "scheduler": scheduler, "seed": seed, "steps": steps
    }},
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": model } },
    "5": { "class_type": "EmptyLatentImage", "inputs": { "batch_size": 1, "height": height, "width": width } },
    "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": prompt } },
    "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": negative } },
    "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
    "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ai_agent", "images": ["8", 0] } },
  };

  // 如果有 LoRA，插入 LoRA 加载节点
  if (options.lora) {
    workflow["10"] = { "class_type": "LoraLoader", "inputs": {
      "lora_name": options.lora,
      "strength_model": options.loraStrength || 0.8,
      "strength_clip": options.loraStrength || 0.8,
      "model": ["4", 0],
      "clip": ["4", 1]
    }};
    // 重连 KSampler 和 CLIP 到 LoRA 输出
    workflow["3"].inputs.model = ["10", 0];
    workflow["6"].inputs.clip = ["10", 1];
    workflow["7"].inputs.clip = ["10", 1];
  }

  return workflow;
}

// img2img 工作流
function _buildImg2ImgWorkflow(prompt, imageBase64, options) {
  var model = options.model || Core.config.comfyuiModel || 'v1-5-pruned-emaonly.safetensors';
  var steps = options.steps || 20;
  var cfg = options.cfg || 7;
  var denoise = options.denoise || 0.5;
  var negative = options.negative || 'blurry, bad quality, worst quality';
  var seed = options.seed || Math.floor(Math.random() * 2147483647);

  return {
    "3": { "class_type": "KSampler", "inputs": {
      "cfg": cfg, "denoise": denoise, "latent_image": ["10", 0], "model": ["4", 0],
      "negative": ["7", 0], "positive": ["6", 0],
      "sampler_name": "euler", "scheduler": "normal", "seed": seed, "steps": steps
    }},
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": model } },
    "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": prompt } },
    "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": negative } },
    "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
    "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "ai_agent_i2i", "images": ["8", 0] } },
    "10": { "class_type": "VAEEncode", "inputs": { "pixels": ["11", 0], "vae": ["4", 2] } },
    "11": { "class_type": "LoadImage", "inputs": { "image": imageBase64 } },
  };
}

// 主 ComfyUI 生成函数（支持 txt2img + img2img + 自动降级）
async function generateComfyUI(prompt, options) {
  var baseUrl = Core.config.comfyuiBase || 'http://127.0.0.1:8188';

  // 先检查 ComfyUI 是否在线
  var status = await checkComfyUI();
  if (!status.online) {
    console.warn('⚠️ ComfyUI 不可用，尝试自动降级...');
    return await _comfyuiFallback(prompt, options);
  }

  // 生成 client ID（用于 WebSocket 追踪）
  var clientId = 'ai-agent-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);

  // 连接 WebSocket 获取实时进度
  var onProgress = options.onProgress || null;
  if (onProgress) {
    _connectComfyUIWs(clientId, onProgress);
  }

  // 构建工作流
  var workflow;
  if (options.image) {
    // img2img 模式
    var imgBase64 = options.image.replace(/^data:image\/\w+;base64,/, '');
    workflow = _buildImg2ImgWorkflow(prompt, imgBase64, options);
  } else if (options.customWorkflow) {
    // 自定义工作流
    workflow = typeof options.customWorkflow === 'string' ? JSON.parse(options.customWorkflow) : options.customWorkflow;
  } else {
    // 默认 txt2img
    workflow = _buildTxt2ImgWorkflow(prompt, options);
  }

  // 提交任务
  var queueResp;
  try {
    queueResp = await fetch(baseUrl + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    console.warn('ComfyUI 提交失败:', e.message);
    return await _comfyuiFallback(prompt, options);
  }

  if (!queueResp.ok) {
    var errText = await queueResp.text();
    // 检查是否是模型不存在错误
    if (errText.includes('not found') || errText.includes('Value not in list')) {
      console.warn('ComfyUI 模型错误:', errText.substring(0, 200));
      return await _comfyuiFallback(prompt, options);
    }
    throw new Error('ComfyUI 请求失败 (' + queueResp.status + '): ' + errText.substring(0, 200));
  }

  var queueData = await queueResp.json();
  var promptId = queueData.prompt_id;
  if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');

  console.log('🎨 ComfyUI 任务已提交:', promptId);

  // 轮询结果（WebSocket 提供进度，这里只检查完成状态）
  var maxAttempts = 90; // 3 分钟
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(function(r) { setTimeout(r, 2000); });
    try {
      var histResp = await fetch(baseUrl + '/history/' + promptId, { signal: AbortSignal.timeout(5000) });
      if (histResp.ok) {
        var histData = await histResp.json();
        if (histData[promptId]) {
          // 检查是否有错误
          if (histData[promptId].status && histData[promptId].status.status_str === 'error') {
            var errMsg = 'ComfyUI 执行错误';
            if (histData[promptId].status.messages) {
              errMsg += ': ' + JSON.stringify(histData[promptId].status.messages);
            }
            throw new Error(errMsg);
          }
          var outputs = histData[promptId].outputs;
          if (outputs) {
            var nodeKeys = Object.keys(outputs);
            for (var ni = 0; ni < nodeKeys.length; ni++) {
              var node = outputs[nodeKeys[ni]];
              if (node.images && node.images[0]) {
                var imgInfo = node.images[0];
                var imgUrl = baseUrl + '/view?filename=' + encodeURIComponent(imgInfo.filename)
                  + '&subfolder=' + (imgInfo.subfolder || '') + '&type=' + (imgInfo.type || 'output');
                // 关闭 WebSocket
                if (_comfyuiWs) { try { _comfyuiWs.close(); } catch (e) {} _comfyuiWs = null; }
                console.log('✅ ComfyUI 生成完成:', imgInfo.filename);
                return {
                  url: imgUrl,
                  revised_prompt: '',
                  engine: 'comfyui',
                  seed: workflow['3'] ? workflow['3'].inputs.seed : null
                };
              }
            }
          }
        }
      }
    } catch (e) {
      if (e.message.indexOf('ComfyUI') === 0) {
        if (_comfyuiWs) { try { _comfyuiWs.close(); } catch (e2) {} _comfyuiWs = null; }
        throw e;
      }
    }
  }
  if (_comfyuiWs) { try { _comfyuiWs.close(); } catch (e) {} _comfyuiWs = null; }
  throw new Error('ComfyUI 生成超时（3 分钟），任务 ID: ' + promptId);
}

// ComfyUI 降级到 SiliconFlow
async function _comfyuiFallback(prompt, options) {
  if (Core.config.siliconFlowKey) {
    console.log('🔄 自动降级到 SiliconFlow...');
    try {
      var result = await generateSiliconFlow(prompt, options.size || Core.config.imageGenSize || '1024x1024');
      result.engine = 'silicon-fallback';
      return result;
    } catch (e2) {
      throw new Error('ComfyUI 不可用且 SiliconFlow 降级也失败: ' + e2.message);
    }
  }
  throw new Error('ComfyUI 未运行（请先启动 ComfyUI 或配置 SiliconFlow API Key 作为备选）');
}

function getImageProviders() {
  return [
    { id: 'silicon', name: 'Silicon Flow\uff08\u56fd\u5185\u63a8\u8350\uff09', needsKey: true, keyField: 'siliconFlowKey' },
    { id: 'openai', name: 'OpenAI DALL-E', needsKey: true, keyField: 'openaiImageKey' },
    { id: 'comfyui', name: 'ComfyUI\uff08\u672c\u5730\uff09', needsKey: false, keyField: null },
  ];
}

// ================================================================
//  视频生成（Silicon Flow）
// ================================================================
var _videoTaskId = null;
var _videoGenerating = false;

async function generateVideo(prompt, options) {
  options = options || {};
  var apiKey = Core.config.siliconFlowKey;
  if (!apiKey) throw new Error('\u8bf7\u914d\u7f6e Silicon Flow API Key\uff08\u89c6\u9891\u751f\u6210\u4f7f\u7528\u540c\u4e00 API Key\uff09');
  if (apiKey.startsWith('Bearer ')) apiKey = apiKey.substring(7);
  var model = options.model || Core.config.videoGenModel || 'Wan-AI/Wan2.1-T2V-14B';

  console.log('\ud83c\udfac \u89c6\u9891\u751f\u6210: model=' + model + ', prompt="' + prompt.substring(0, 50) + '..."');

  // Step 1: 提交生成任务
  var createResp = await fetch('https://api.siliconflow.cn/v1/video/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: model,
      prompt: prompt,
      image_size: options.size || Core.config.videoGenSize || '1280x720',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!createResp.ok) {
    var errText = await createResp.text();
    throw new Error('\u89c6\u9891\u751f\u6210\u8bf7\u6c42\u5931\u8d25 (' + createResp.status + '): ' + errText.substring(0, 300));
  }

  var createData = await createResp.json();
  // Silicon Flow 可能直接返回结果
  if (createData.images && createData.images[0]) {
    return { url: createData.images[0].url || createData.images[0], type: 'video' };
  }

  var requestId = createData.requestId || createData.id || createData.task_id;
  if (!requestId) {
    if (createData.data && createData.data[0]) requestId = createData.data[0].id;
  }
  if (!requestId) throw new Error('\u89c6\u9891\u751f\u6210\u672a\u8fd4\u56de\u4efb\u52a1 ID');

  _videoTaskId = requestId;
  _videoGenerating = true;

  // Step 2: 轮询任务状态（视频生成通常需要 1-5 分钟）
  var maxAttempts = 150;
  var progressCallback = options.onProgress || null;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(function(r) { setTimeout(r, 2000); });
    try {
      var statusResp = await fetch('https://api.siliconflow.cn/v1/video/tasks/' + requestId, {
        headers: { 'Authorization': 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!statusResp.ok) {
        console.warn('\u89c6\u9891\u4efb\u52a1\u72b6\u6001\u67e5\u8be2\u5931\u8d25:', statusResp.status);
        continue;
      }
      var statusData = await statusResp.json();
      var status = statusData.status || statusData.state || 'processing';
      if (progressCallback) {
        var elapsed = (attempt + 1) * 2;
        progressCallback({ status: status, elapsed: elapsed, attempt: attempt + 1 });
      }
      if (status === 'succeeded' || status === 'completed' || status === 'success') {
        _videoGenerating = false;
        var videoUrl = null;
        if (statusData.video && statusData.video.url) {
          videoUrl = statusData.video.url;
        } else if (statusData.images && statusData.images[0]) {
          videoUrl = statusData.images[0].url || statusData.images[0];
        } else if (statusData.data && statusData.data[0]) {
          videoUrl = statusData.data[0].url || statusData.data[0];
        } else if (statusData.result && statusData.result.video_url) {
          videoUrl = statusData.result.video_url;
        } else if (typeof statusData.video === 'string') {
          videoUrl = statusData.video;
        }
        if (!videoUrl) {
          console.log('\u89c6\u9891\u4efb\u52a1\u8fd4\u56de\u6570\u636e:', JSON.stringify(statusData).substring(0, 500));
          throw new Error('\u89c6\u9891\u751f\u6210\u5b8c\u6210\u4f46\u672a\u627e\u5230\u89c6\u9891 URL');
        }
        return { url: videoUrl, type: 'video', model: model };
      }
      if (status === 'failed' || status === 'error') {
        _videoGenerating = false;
        var reason = statusData.reason || statusData.error || '\u672a\u77e5\u539f\u56e0';
        throw new Error('\u89c6\u9891\u751f\u6210\u5931\u8d25: ' + reason);
      }
    } catch (e) {
      if (e.message.indexOf('\u89c6\u9891\u751f\u6210') === 0) throw e;
      console.warn('\u89c6\u9891\u4efb\u52a1\u8f6e\u8be2\u5f02\u5e38 (' + (attempt + 1) + '):', e.message);
    }
  }
  _videoGenerating = false;
  throw new Error('\u89c6\u9891\u751f\u6210\u8d85\u65f6\uff085 \u5206\u949f\uff09\uff0c\u4efb\u52a1 ID: ' + requestId);
}

function getVideoProviders() {
  return [
    { id: 'silicon-wan', name: 'Silicon Flow - Wan 2.1 (14B)', model: 'Wan-AI/Wan2.1-T2V-14B' },
    { id: 'silicon-wan-480p', name: 'Silicon Flow - Wan 2.1 (480P)', model: 'Wan-AI/Wan2.1-T2V-480P' },
    { id: 'silicon-cogvideo', name: 'Silicon Flow - CogVideoX', model: 'THUDM/CogVideoX-5b' },
  ];
}

function isVideoGenerating() { return _videoGenerating; }

// ================================================================
//  命令注册
// ================================================================
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  // /draw 命令 — 图片生成
  Core.custom.registerCommand('draw', {
    zh: 'AI \u7ed8\u56fe \u2014 \u6839\u636e\u63cf\u8ff0\u751f\u6210\u56fe\u7247',
    en: 'Generate image from description'
  }, function(args) {
    var prompt = (args || '').trim();
    if (!prompt) {
      Core.session.addMessage('\u8bf7\u63d0\u4f9b\u56fe\u7247\u63cf\u8ff0\uff0c\u4f8b\u5982\uff1a`/draw \u4e00\u53ea\u53ef\u7231\u7684\u732b\u54aa`', 'ai');
      return;
    }
    Core.dom.status.textContent = '\ud83c\udfa8 \u6b63\u5728\u751f\u6210\u56fe\u7247...';
    Core.session.addMessage('\ud83c\udfa8 \u6b63\u5728\u751f\u6210\u56fe\u7247: *' + prompt + '*', 'ai');
    generateImage(prompt).then(function(result) {
      Core.dom.status.textContent = '\u2705 \u56fe\u7247\u751f\u6210\u5b8c\u6210';
      setTimeout(function() { Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + (Core.getCurrentService ? Core.getCurrentService() : 'ollama') + ')'; }, 3000);
      var msg = '![' + prompt + '](' + result.url + ')';
      if (result.revised_prompt) msg += '\n\n*\u4f18\u5316\u63d0\u793a: ' + result.revised_prompt + '*';
      Core.session.addMessage(msg, 'ai');
    }).catch(function(err) {
      Core.dom.status.textContent = '\u274c \u56fe\u7247\u751f\u6210\u5931\u8d25';
      setTimeout(function() { Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + (Core.getCurrentService ? Core.getCurrentService() : 'ollama') + ')'; }, 3000);
      Core.session.addMessage('\u274c \u56fe\u7247\u751f\u6210\u5931\u8d25: ' + err.message, 'ai');
    });
  });

  // /video 命令 — 视频生成
  Core.custom.registerCommand('video', {
    zh: 'AI \u89c6\u9891\u751f\u6210 \u2014 \u6839\u636e\u63cf\u8ff0\u751f\u6210\u89c6\u9891',
    en: 'Generate video from description'
  }, function(args) {
    var prompt = (args || '').trim();
    if (!prompt) {
      Core.session.addMessage('\u8bf7\u63d0\u4f9b\u89c6\u9891\u63cf\u8ff0\uff0c\u4f8b\u5982\uff1a`/video \u4e00\u53ea\u732b\u5728\u82b1\u56ed\u91cc\u8ffd\u8774\u8776`', 'ai');
      return;
    }
    Core.dom.status.textContent = '\ud83c\udfac \u6b63\u5728\u751f\u6210\u89c6\u9891...';
    var startTime = Date.now();
    Core.session.addMessage('\ud83c\udfac \u89c6\u9891\u751f\u6210\u4efb\u52a1\u5df2\u63d0\u4ea4\uff0c\u901a\u5e38\u9700\u8981 1-3 \u5206\u949f...\n\n**\u63cf\u8ff0**: ' + prompt, 'ai');
    generateVideo(prompt, {
      onProgress: function(info) {
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        Core.dom.status.textContent = '\ud83c\udfac \u89c6\u9891\u751f\u6210\u4e2d... ' + elapsed + 's (' + (info.status || 'processing') + ')';
      },
    }).then(function(result) {
      var elapsed = Math.round((Date.now() - startTime) / 1000);
      Core.dom.status.textContent = '\u2705 \u89c6\u9891\u751f\u6210\u5b8c\u6210 (' + elapsed + 's)';
      setTimeout(function() { Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + (Core.getCurrentService ? Core.getCurrentService() : 'ollama') + ')'; }, 5000);
      var videoMsg = '## \ud83c\udfac \u89c6\u9891\u751f\u6210\u5b8c\u6210\n\n'
        + '<video controls autoplay style="max-width:100%;border-radius:8px;" src="' + result.url + '"></video>\n\n'
        + '**\u63cf\u8ff0**: ' + prompt + '\n'
        + '**\u8017\u65f6**: ' + elapsed + 's | **\u6a21\u578b**: ' + (result.model || Core.config.videoGenModel || 'Wan 2.1') + '\n\n'
        + '[\u2b07\ufe0f \u4e0b\u8f7d\u89c6\u9891](' + result.url + ')';
      Core.session.addMessage(videoMsg, 'ai');
    }).catch(function(err) {
      Core.dom.status.textContent = '\u274c \u89c6\u9891\u751f\u6210\u5931\u8d25';
      setTimeout(function() { Core.dom.status.textContent = '\u2705 \u5df2\u5c31\u7eea (' + (Core.getCurrentService ? Core.getCurrentService() : 'ollama') + ')'; }, 3000);
      Core.session.addMessage('\u274c \u89c6\u9891\u751f\u6210\u5931\u8d25: ' + err.message, 'ai');
    });
  });

  console.log('\u2705 /draw \u548c /video \u547d\u4ee4\u5df2\u6ce8\u518c');
}

module.exports = {
  init: function(_Core) {
    Core = _Core;
    if (!Core.config.imageGenProvider) Core.config.imageGenProvider = 'silicon';
    if (!Core.config.imageGenSize) Core.config.imageGenSize = '1024x1024';
    if (!Core.config.videoGenModel) Core.config.videoGenModel = 'Wan-AI/Wan2.1-T2V-14B';
    if (!Core.config.videoGenSize) Core.config.videoGenSize = '1280x720';

    Core.imageGen = {
      generate: generateImage,
      getProviders: getImageProviders,
      generateVideo: generateVideo,
      getVideoProviders: getVideoProviders,
      isVideoGenerating: isVideoGenerating,
      // ComfyUI 增强
      checkComfyUI: checkComfyUI,
      getComfyUIModels: getComfyUIModels,
      buildWorkflow: _buildTxt2ImgWorkflow,
    };

    // 延迟注册命令（custom.js 在 image-gen.js 之后加载）
    setTimeout(function() { registerCommands(); }, 100);

    // 启动时检查 ComfyUI 状态
    checkComfyUI().then(function(status) {
      if (status.online) {
        console.log('✅ ComfyUI 已连接');
        getComfyUIModels(); // 预加载模型列表
      } else {
        console.log('⚠️ ComfyUI 未运行（本地图片生成将使用 SiliconFlow 降级）');
      }
    });

    console.log('✅ 图像 + 视频生成模块已加载（DALL-E / Silicon Flow / ComfyUI + 自动降级 / Wan 2.1）');
  }
};
