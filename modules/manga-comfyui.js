// modules/manga-comfyui.js - AI 漫剧 ComfyUI 图像生成模块
// 功能：角色生成（IPAdapter 保持一致性）、场景生成、批量出图
// 依赖：image-gen 模块（复用 ComfyUI 连接和 WebSocket 逻辑）

var Core = null;
var fs = null;
var path = null;

// ===== 配置 =====
var COMFYUI_BASE = 'http://127.0.0.1:8188';        // 直连（WebSocket 用）
var COMFYUI_PROXY = 'http://127.0.0.1:8080/api/comfyui';  // 代理（fetch 用，避免 CORS 403）
var MANGA_DIR = null;  // 运行时由 init 按数据根解析（Core.DATA_ROOT / AI_AGENT_DATA_ROOT）
var IMAGES_DIR = null;  // 运行时初始化

// ===== 状态 =====
var _statusCache = null;
var _statusTime = 0;
var _models = null;
var _ws = null;

// ================================================================
//  ComfyUI 连接管理
// ================================================================

async function checkStatus(force) {
  var now = Date.now();
  if (!force && _statusCache && (now - _statusTime) < 30000) return _statusCache;
  try {
    var resp = await fetch(COMFYUI_PROXY + '/status', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      var data = await resp.json();
      _statusCache = {
        online: data.online !== false,
        devices: data.data && data.data.devices ? data.data.devices : (data.devices || []),
        vram: data.data && data.data.gpu ? (data.data.gpu.vram_total / 1024 / 1024 / 1024).toFixed(1) + 'GB' : (data.devices && data.devices[0] ? (data.devices[0].vram_total / 1024 / 1024 / 1024).toFixed(1) + 'GB' : 'unknown')
      };
    } else {
      _statusCache = { online: false };
    }
  } catch (e) {
    _statusCache = { online: false, error: e.message };
  }
  _statusTime = now;
  return _statusCache;
}

async function getModels() {
  if (_models) return _models;
  try {
    var resp = await fetch(COMFYUI_PROXY + '/models', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      var data = await resp.json();
      var checkpoints = data.checkpoints || [];
      _models = { checkpoints: checkpoints };
      return _models;
    }
  } catch (e) {
    console.warn('Manga: 获取模型列表失败:', e.message);
  }
  _models = { checkpoints: [] };
  return _models;
}

function connectWs(clientId, onProgress) {
  try {
    if (_ws) { try { _ws.close(); } catch (e) { /* 可忽略：清理路径，失败不影响主流程 */ } }
    var wsUrl = COMFYUI_BASE.replace('http', 'ws') + '/ws?clientId=' + clientId;
    _ws = new WebSocket(wsUrl);
    _ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'progress' && onProgress) {
          onProgress({ type: 'progress', value: msg.data.value, max: msg.data.max });
        } else if (msg.type === 'executing' && msg.data.node === null && onProgress) {
          onProgress({ type: 'done' });
        } else if (msg.type === 'execution_error' && onProgress) {
          onProgress({ type: 'error', message: msg.data });
        }
      } catch (e) { console.warn('⚠️ [manga-comfyui] 操作失败:', e.message || e); }
    };
    _ws.onerror = function() { console.warn('Manga: WebSocket 错误'); };
    _ws.onclose = function() { _ws = null; };
  } catch (e) {
    console.warn('Manga: WebSocket 连接失败:', e.message);
  }
}

function closeWs() {
  if (_ws) { try { _ws.close(); } catch (e) { /* 可忽略：清理路径，失败不影响主流程 */ } _ws = null; }
}

// ================================================================
//  工作流构建
// ================================================================

// 基础 txt2img 工作流（SD1.5）
function buildTxt2ImgWorkflow(prompt, options) {
  var opts = options || {};
  var width = opts.width || 512;
  var height = opts.height || 768;  // 漫画常用竖版
  var steps = opts.steps || 25;
  var cfg = opts.cfg || 7;
  var sampler = opts.sampler || 'dpmpp_2m';
  var scheduler = opts.scheduler || 'karras';
  var negative = opts.negative || 'blurry, bad quality, worst quality, deformed, ugly, bad anatomy, disfigured, lowres, text, watermark';
  var seed = opts.seed || -1;
  var model = opts.model || findDefaultModel();

  var workflow = {
    "3": { "class_type": "KSampler", "inputs": {
      "cfg": cfg, "denoise": 1, "latent_image": ["5", 0], "model": ["4", 0],
      "negative": ["7", 0], "positive": ["6", 0],
      "sampler_name": sampler, "scheduler": scheduler,
      "seed": seed === -1 ? Math.floor(Math.random() * 2147483647) : seed,
      "steps": steps
    }},
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": model } },
    "5": { "class_type": "EmptyLatentImage", "inputs": { "batch_size": 1, "height": height, "width": width } },
    "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": prompt } },
    "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": negative } },
    "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
    "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": opts.prefix || "manga", "images": ["8", 0] } },
  };

  return workflow;
}

// 角色生成工作流（带 IPAdapter 保持角色一致性）
function buildCharacterWorkflow(characterPrompt, refImageBase64, options) {
  var opts = options || {};
  var workflow = buildTxt2ImgWorkflow(characterPrompt, opts);

  // 如果有参考图，添加 IPAdapter 节点
  if (refImageBase64) {
    var imgData = refImageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 加载参考图
    workflow["20"] = { "class_type": "LoadImage", "inputs": { "image": imgData } };

    // IPAdapter 应用
    workflow["21"] = { "class_type": "IPAdapterApply", "inputs": {
      "ipadapter": ["22", 0],
      "model": ["4", 0],
      "image": ["20", 0],
      "weight": opts.ipWeight || 0.7,
      "noise": opts.ipNoise || 0.0,
      "weight_type": opts.weightType || 'original',
      "start_at": 0.0,
      "end_at": 1.0,
      "unfold_batch": false
    }};

    // IPAdapter 模型加载
    workflow["22"] = { "class_type": "IPAdapterModelLoader", "inputs": {
      "ipadapter_file": opts.ipModel || "ip-adapter-plus_sd15.safetensors"
    }};

    // CLIP Vision 加载
    workflow["23"] = { "class_type": "CLIPVisionLoader", "inputs": {
      "clip_name": "clip_vision_model.safetensors"
    }};

    // 将 IPAdapter 输出连接到 KSampler
    workflow["3"].inputs.model = ["21", 0];
  }

  return workflow;
}

// 场景/环境生成工作流
function buildSceneWorkflow(scenePrompt, options) {
  var opts = options || {};
  // 场景通常用横版 16:9
  opts.width = opts.width || 768;
  opts.height = opts.height || 512;
  opts.prefix = opts.prefix || "manga_scene";
  return buildTxt2ImgWorkflow(scenePrompt, opts);
}

// 查找默认模型
function findDefaultModel() {
  if (_models && _models.checkpoints && _models.checkpoints.length > 0) {
    // 优先 SD1.5
    for (var i = 0; i < _models.checkpoints.length; i++) {
      var name = _models.checkpoints[i];
      if (name.indexOf('v1-5') >= 0 || name.indexOf('sd15') >= 0 || name.indexOf('1.5') >= 0) {
        return name;
      }
    }
    return _models.checkpoints[0];
  }
  return 'v1-5-pruned-emaonly.safetensors';
}

// ================================================================
//  图像生成 API
// ================================================================

// 提交任务到 ComfyUI 并等待结果
async function submitWorkflow(workflow, options) {
  var opts = options || {};
  var clientId = 'manga-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);

  // WebSocket 进度追踪
  if (opts.onProgress) {
    connectWs(clientId, opts.onProgress);
  }

  // 提交
  var queueResp;
  try {
    queueResp = await fetch(COMFYUI_PROXY + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    closeWs();
    throw new Error('ComfyUI 连接失败: ' + e.message);
  }

  if (!queueResp.ok) {
    var errText = await queueResp.text();
    closeWs();
    throw new Error('ComfyUI 提交失败 (' + queueResp.status + '): ' + errText.substring(0, 300));
  }

  var queueData = await queueResp.json();
  var promptId = queueData.prompt_id;
  if (!promptId) {
    closeWs();
    throw new Error('ComfyUI 未返回 prompt_id');
  }

  // 等待完成
  return await waitForCompletion(promptId, clientId, opts);
}

// 等待任务完成
async function waitForCompletion(promptId, clientId, options) {
  var opts = options || {};
  var timeout = opts.timeout || 180000;  // 3 分钟
  var startTime = Date.now();
  var lastOutput = null;

  while (Date.now() - startTime < timeout) {
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });

    try {
      var resp = await fetch(COMFYUI_PROXY + '/history/' + promptId, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        var history = await resp.json();
        var entry = history[promptId];
        if (entry) {
          if (entry.status && entry.status.completed) {
            // 获取输出图片
            var outputs = entry.outputs || {};
            var images = [];
            for (var nodeId in outputs) {
              if (outputs[nodeId].images) {
                for (var i = 0; i < outputs[nodeId].images.length; i++) {
                  var img = outputs[nodeId].images[i];
                  var imgUrl = COMFYUI_PROXY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=' + encodeURIComponent(img.type || 'output');
                  images.push({
                    url: imgUrl,
                    filename: img.filename,
                    nodeId: nodeId
                  });
                }
              }
            }
            closeWs();
            return { success: true, images: images, promptId: promptId };
          }
          if (entry.status && entry.status.status_str === 'error') {
            closeWs();
            throw new Error('ComfyUI 执行错误: ' + JSON.stringify(entry.status.messages || '').substring(0, 300));
          }
        }
      }
    } catch (e) {
      if (e.message.indexOf('ComfyUI') >= 0) throw e;
      // 网络错误，继续等待
    }
  }

  closeWs();
  throw new Error('ComfyUI 生成超时（' + (timeout / 1000) + '秒）');
}

// ================================================================
//  高层 API：漫剧专用
// ================================================================

// 生成角色图
async function generateCharacter(characterName, description, options) {
  var opts = options || {};
  var fullPrompt = description;

  // 添加漫画风格后缀
  if (!opts.noStyle) {
    fullPrompt += ', manga style, anime style, detailed, high quality, clean lines';
  }

  var workflow = buildTxt2ImgWorkflow(fullPrompt, {
    width: opts.width || 512,
    height: opts.height || 768,
    steps: opts.steps || 25,
    cfg: opts.cfg || 7,
    prefix: 'char_' + characterName.replace(/\s+/g, '_'),
    negative: opts.negative,
    model: opts.model,
    seed: opts.seed
  });

  var result = await submitWorkflow(workflow, { onProgress: opts.onProgress, timeout: opts.timeout });

  // 保存图片到漫画目录
  if (result.images && result.images.length > 0) {
    for (var i = 0; i < result.images.length; i++) {
      var img = result.images[i];
      try {
        var imgResp = await fetch(img.url);
        var blob = await imgResp.blob();
        var arrayBuffer = await blob.arrayBuffer();
        var uint8Array = new Uint8Array(arrayBuffer);
        var savePath = path.join(IMAGES_DIR, 'characters', img.filename);
        if (!fs.existsSync(path.dirname(savePath))) {
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
        }
        fs.writeFileSync(savePath, Buffer.from(uint8Array));
        img.localPath = savePath;
      } catch (e) {
        console.warn('Manga: 保存图片失败:', e.message);
      }
    }
  }

  return result;
}

// 生成场景图
async function generateScene(sceneDescription, options) {
  var opts = options || {};
  var fullPrompt = sceneDescription;

  if (!opts.noStyle) {
    fullPrompt += ', manga background, anime background, detailed, atmospheric';
  }

  var workflow = buildSceneWorkflow(fullPrompt, {
    width: opts.width || 768,
    height: opts.height || 512,
    steps: opts.steps || 25,
    cfg: opts.cfg || 7,
    prefix: opts.prefix || 'scene',
    negative: opts.negative,
    model: opts.model,
    seed: opts.seed
  });

  var result = await submitWorkflow(workflow, { onProgress: opts.onProgress, timeout: opts.timeout });

  // 保存图片
  if (result.images && result.images.length > 0) {
    for (var i = 0; i < result.images.length; i++) {
      var img = result.images[i];
      try {
        var imgResp = await fetch(img.url);
        var blob = await imgResp.blob();
        var arrayBuffer = await blob.arrayBuffer();
        var uint8Array = new Uint8Array(arrayBuffer);
        var savePath = path.join(IMAGES_DIR, 'scenes', img.filename);
        if (!fs.existsSync(path.dirname(savePath))) {
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
        }
        fs.writeFileSync(savePath, Buffer.from(uint8Array));
        img.localPath = savePath;
      } catch (e) {
        console.warn('Manga: 保存图片失败:', e.message);
      }
    }
  }

  return result;
}

// 批量生成（根据剧本自动生成所有角色和场景）
async function generateFromScript(scriptData, options) {
  var opts = options || {};
  var results = { characters: [], scenes: [], errors: [] };

  // 收集所有角色
  var characters = {};
  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    for (var j = 0; j < scene.characters.length; j++) {
      var charName = scene.characters[j];
      if (!characters[charName]) {
        characters[charName] = { name: charName, scenes: [] };
      }
      characters[charName].scenes.push(scene.id);
    }
  }

  // 生成角色图
  if (opts.onStatus) opts.onStatus('正在生成角色图...');
  for (var charName in characters) {
    try {
      if (opts.onStatus) opts.onStatus('生成角色: ' + charName);
      var desc = opts.characterDescriptions && opts.characterDescriptions[charName]
        ? opts.characterDescriptions[charName]
        : charName + ', full body portrait, manga character design';
      var result = await generateCharacter(charName, desc, {
        onProgress: opts.onProgress,
        seed: opts.seeds && opts.seeds[charName]
      });
      results.characters.push({ name: charName, result: result });
    } catch (e) {
      results.errors.push({ type: 'character', name: charName, error: e.message });
    }
  }

  // 生成场景图
  if (opts.onStatus) opts.onStatus('正在生成场景图...');
  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    try {
      if (opts.onStatus) opts.onStatus('生成场景 ' + scene.id + ': ' + scene.description.substring(0, 30) + '...');
      var result = await generateScene(scene.description, {
        prefix: 'scene_' + scene.id,
        onProgress: opts.onProgress,
        seed: opts.seeds && opts.seeds['scene_' + scene.id]
      });
      results.scenes.push({ sceneId: scene.id, result: result });
    } catch (e) {
      results.errors.push({ type: 'scene', sceneId: scene.id, error: e.message });
    }
  }

  return results;
}

// ================================================================
//  命令注册
// ================================================================

function registerCommands() {
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('manga-gen', '从 JSON 剧本批量生成漫画', function(args) {
      return handleMangaGen(args);
    });
    Core.custom.registerCommand('manga-char', '生成角色立绘（ComfyUI）', function(args) {
      return handleMangaChar(args);
    });
    Core.custom.registerCommand('manga-scene', '生成场景背景（ComfyUI）', function(args) {
      return handleMangaScene(args);
    });
    Core.custom.registerCommand('manga-status', '查看 ComfyUI 连接状态', function() {
      return handleMangaStatus();
    });
  } else {
    console.warn('Manga: Core.custom.registerCommand 不可用，命令未注册');
  }
}

async function handleMangaStatus() {
  var status = await checkStatus(true);
  var models = await getModels();
  var msg = 'ComfyUI 状态: ' + (status.online ? '在线' : '离线') + '\n';
  if (status.online) {
    msg += 'VRAM: ' + (status.vram || 'unknown') + '\n';
    msg += '可用模型: ' + (models.checkpoints.join(', ') || '无') + '\n';
  } else {
    msg += '错误: ' + (status.error || '无法连接') + '\n';
    msg += '请确保 ComfyUI 已启动 (http://127.0.0.1:8188)';
  }
  Core.session.addMessage(msg, 'ai');
  return true;
}

async function handleMangaChar(args) {
  if (!args) {
    Core.session.addMessage('用法: /manga-char <角色名> <描述>\n例如: /manga-char 主角 一个穿黑色风衣的年轻侦探，短发，严肃表情', 'ai');
    return true;
  }
  var parts = args.split(/\s+/);
  var charName = parts[0];
  var description = args.slice(charName.length).trim();
  if (!description) {
    Core.session.addMessage('请提供角色描述', 'ai');
    return true;
  }

  Core.session.addMessage('正在生成角色: ' + charName + '...', 'ai');
  try {
    var result = await generateCharacter(charName, description, {
      onProgress: function(p) {
        if (p.type === 'progress') {
          Core.session.updateLastMessage('生成中... ' + Math.round(p.value / p.max * 100) + '%');
        }
      }
    });
    if (result.images && result.images.length > 0) {
      Core.session.addMessage('角色 ' + charName + ' 生成完成！\n图片: ' + result.images[0].url, 'ai');
    }
  } catch (e) {
    Core.session.addMessage('生成失败: ' + e.message, 'ai');
  }
  return true;
}

async function handleMangaScene(args) {
  if (!args) {
    Core.session.addMessage('用法: /manga-scene <场景描述>\n例如: /manga-scene 雨夜的城市街道，霓虹灯反射在湿漉漉的路面上', 'ai');
    return true;
  }

  Core.session.addMessage('正在生成场景...', 'ai');
  try {
    var result = await generateScene(args, {
      onProgress: function(p) {
        if (p.type === 'progress') {
          Core.session.updateLastMessage('生成中... ' + Math.round(p.value / p.max * 100) + '%');
        }
      }
    });
    if (result.images && result.images.length > 0) {
      Core.session.addMessage('场景生成完成！\n图片: ' + result.images[0].url, 'ai');
    }
  } catch (e) {
    Core.session.addMessage('生成失败: ' + e.message, 'ai');
  }
  return true;
}

async function handleMangaGen(args) {
  if (!args) {
    Core.session.addMessage('用法: /manga-gen <JSON剧本文件路径>\n例如: /manga-gen E:\\my-ai-data\\manga_pipeline\\01_script.json', 'ai');
    return true;
  }

  var scriptPath = args.trim();
  if (!fs.existsSync(scriptPath)) {
    Core.session.addMessage('文件不存在: ' + scriptPath, 'ai');
    return true;
  }

  try {
    var scriptData = JSON.parse(fs.readFileSync(scriptPath, 'utf-8'));
    Core.session.addMessage('开始批量生成...\n剧本: ' + (scriptData.title || '未命名') + '\n场景数: ' + scriptData.scenes.length, 'ai');

    var results = await generateFromScript(scriptData, {
      onStatus: function(msg) { Core.session.addMessage(msg, 'ai'); },
      onProgress: function(p) {
        if (p.type === 'progress') {
          Core.session.updateLastMessage('生成中... ' + Math.round(p.value / p.max * 100) + '%');
        }
      }
    });

    var summary = '批量生成完成！\n';
    summary += '角色: ' + results.characters.length + ' 个\n';
    summary += '场景: ' + results.scenes.length + ' 个\n';
    if (results.errors.length > 0) {
      summary += '失败: ' + results.errors.length + ' 个\n';
      for (var i = 0; i < results.errors.length; i++) {
        summary += '  - ' + results.errors[i].type + ' ' + (results.errors[i].name || results.errors[i].sceneId) + ': ' + results.errors[i].error.substring(0, 100) + '\n';
      }
    }
    Core.session.addMessage(summary, 'ai');
  } catch (e) {
    Core.session.addMessage('批量生成失败: ' + e.message, 'ai');
  }
  return true;
}

// ================================================================
//  模块导出
// ================================================================

module.exports = {
  name: 'manga-comfyui',
  dependencies: ['image-gen'],
  init: function(_Core) {
    Core = _Core;
    fs = require('fs');
    path = require('path');

    // 🔧 动态解析后端代理端口（8080 被占用时 main.js 会自动递增）
    if (Core && typeof Core.getBackendBase === 'function') {
      COMFYUI_PROXY = Core.getBackendBase() + '/api/comfyui';
    }

    // 数据目录：跟随 Core 数据根，支持 AI_AGENT_DATA_ROOT 环境变量覆盖
    var dataRoot = Core.pathService.global();
    MANGA_DIR = path.join(dataRoot, 'manga_pipeline');

    // 初始化图片目录
    IMAGES_DIR = path.join(MANGA_DIR, 'images');
    if (!fs.existsSync(IMAGES_DIR)) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
    }
    if (!fs.existsSync(path.join(IMAGES_DIR, 'characters'))) {
      fs.mkdirSync(path.join(IMAGES_DIR, 'characters'), { recursive: true });
    }
    if (!fs.existsSync(path.join(IMAGES_DIR, 'scenes'))) {
      fs.mkdirSync(path.join(IMAGES_DIR, 'scenes'), { recursive: true });
    }

    // 挂载到 Core
    Core.mangaComfyUI = {
      checkStatus: checkStatus,
      getModels: getModels,
      generateCharacter: generateCharacter,
      generateScene: generateScene,
      generateFromScript: generateFromScript,
      buildWorkflow: buildTxt2ImgWorkflow,
      buildCharacterWorkflow: buildCharacterWorkflow,
      buildSceneWorkflow: buildSceneWorkflow,
      submitWorkflow: submitWorkflow,
    };

    // 注册命令
    registerCommands();

    // 启动时检查状态
    checkStatus().then(function(status) {
      if (status.online) {
        getModels();
        console.log('Manga ComfyUI: 在线 (' + (status.vram || '') + ')');
      } else {
        console.log('Manga ComfyUI: 离线 (请先启动 ComfyUI)');
      }
    }).catch(function(e) {
      console.warn('Manga ComfyUI: 启动检查失败:', e.message);
    });
  }
};
