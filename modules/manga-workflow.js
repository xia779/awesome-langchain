// modules/manga-workflow.js - AI 漫剧全自动工作流编排器
// 功能：接收大纲 → 自动生成剧本 → 角色/场景图 → 配音/音效/音乐 → 分镜 → 视频
// 依赖：manga-comfyui（图像）, image-gen（ComfyUI 连接）
// 外部服务：Ollama(11434), ComfyUI(8188), TTS(8081), AudioLDM(8082), MusicGen(8083)

var Core = null;
var fs = null;
var path = null;
var http = null;

// ===== 配置 =====
var OLLAMA_URL = 'http://127.0.0.1:11434';
var COMFYUI_URL = 'http://127.0.0.1:8188';        // 直连（WebSocket 用）
var COMFYUI_PROXY = 'http://127.0.0.1:8080/api/comfyui';  // 代理（fetch 用，避免 CORS 403）
var TTS_URL = 'http://127.0.0.1:8081';
var AUDIOLDM_URL = 'http://127.0.0.1:8082';
var MUSICGEN_URL = 'http://127.0.0.1:8083';
var MANGA_DIR = null;  // 运行时由 init 按数据根解析（Core.DATA_ROOT / AI_AGENT_DATA_ROOT）
var OLLAMA_MODEL = 'llama3.2:3b';  // 剧本生成用模型（已验证可生成JSON）

// ffmpeg 可执行文件目录：跟随数据根，支持 AI_AGENT_DATA_ROOT 环境变量覆盖
function getFfmpegBinDir() {
  var dataRoot = Core.pathService.global();
  return path.join(dataRoot, 'ffmpeg', 'ffmpeg-master-latest-win64-gpl', 'bin');
}

// ===== 状态 =====
var _pipelineRunning = false;
var _pipelineLog = [];

// ================================================================
//  工具函数
// ================================================================

function log(msg) {
  var ts = new Date().toLocaleTimeString('zh-CN');
  var line = '[' + ts + '] ' + msg;
  _pipelineLog.push(line);
  console.log('[MangaWorkflow] ' + msg);
  if (Core && Core.session) {
    Core.session.addMessage(line, 'ai');
  }
}

function updateProgress(msg) {
  if (Core && Core.session && Core.session.updateLastMessage) {
    Core.session.updateLastMessage(msg);
  }
}

async function httpPost(url, data, timeout) {
  timeout = timeout || 60000;
  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).substring(0, 200));
  return await resp.json();
}

async function httpGet(url, timeout) {
  timeout = timeout || 10000;
  var resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.json();
}

async function clearGPU() {
  // 清理所有音频服务的 GPU 显存
  var services = [
    { name: 'TTS', url: TTS_URL + '/clear_gpu' },
    { name: 'AudioLDM', url: AUDIOLDM_URL + '/clear_gpu' },
    { name: 'MusicGen', url: MUSICGEN_URL + '/clear_gpu' },
  ];
  for (var i = 0; i < services.length; i++) {
    try {
      var r = await httpGet(services[i].url, 5000);
      if (r.cleared) {
        log('  GPU 显存已清理 [' + services[i].name + ']: ' + r.free_mb + 'MB 可用');
      }
    } catch (_) {
      // 服务未启动，忽略
    }
  }
  // 等待显存真正释放
  await new Promise(function(resolve) { setTimeout(resolve, 2000); });
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ================================================================
//  Step 1: 剧本生成 (Ollama)
// ================================================================

async function generateScript(outline) {
  log('Step 1/8: 正在根据大纲生成剧本...');

  var prompt = '你是一个专业的漫画编剧。请根据以下大纲，生成一个完整的漫画剧本。\n\n' +
    '【最重要规则】dialogue 中的 text 字段必须100%使用中文！严禁出现任何英文单词！违反此规则将导致系统崩溃！\n\n' +
    '要求：\n' +
    '1. 输出为 JSON 格式\n' +
    '2. 包含 title（标题）和 scenes（场景数组）\n' +
    '3. 每个场景包含：id（数字）, description（场景描述，英文，用于AI绘图）, characters（角色名数组）, dialogue（对话数组）, sfx（音效描述，英文）, music（背景音乐描述，英文）\n' +
    '4. 每段对话包含：speaker（说话人，中文）, text（台词，必须全部是中文！禁止英文！）, emotion（情绪：calm/happy/sad/angry/excited/neutral）\n' +
    '5. 场景描述要详细，适合AI绘图（包含光线、角度、氛围等）\n' +
    '6. 3-5 个场景\n' +
    '7. 只输出 JSON，不要其他文字\n\n' +
    '大纲：' + outline + '\n\n' +
    'JSON 格式示例：\n' +
    '{"title":"示例标题","scenes":[{"id":1,"description":"A rainy city street at night, neon lights reflecting on wet pavement, cinematic wide shot","characters":["主角"],"dialogue":[{"speaker":"主角","text":"又是一个雨夜，这条街上只有我一个人。","emotion":"calm"},{"speaker":"神秘老者","text":"年轻人，你在找什么？","emotion":"neutral"}],"sfx":"rain and distant thunder","music":"melancholic piano melody"}]}';

  var body = {
    model: OLLAMA_MODEL,
    prompt: prompt,
    stream: false,
    options: { temperature: 0.7, num_predict: 8192 }
  };

  var resp = await httpPost(OLLAMA_URL + '/api/generate', body, 180000);
  var text = resp.response || '';

  // 修复被截断的 JSON：关闭未闭合的字符串和括号
  function repairTruncatedJSON(s) {
    var result = '';
    var inString = false;
    var escape = false;
    var brackets = []; // stack of '{' and '['
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (escape) { result += ch; escape = false; continue; }
      if (ch === '\\') { result += ch; escape = true; continue; }
      if (ch === '"') {
        inString = !inString;
        result += ch;
        continue;
      }
      if (!inString) {
        if (ch === '{' || ch === '[') { brackets.push(ch); result += ch; continue; }
        if (ch === '}' || ch === ']') {
          if (brackets.length > 0) brackets.pop();
          result += ch;
          continue;
        }
      }
      result += ch;
    }
    // 关闭未闭合的字符串
    if (inString) result += '"';
    // 关闭未闭合的括号（从内到外）
    for (var j = brackets.length - 1; j >= 0; j--) {
      result += (brackets[j] === '{' ? '}' : ']');
    }
    return result;
  }

  // 提取 JSON（LLM 输出可能有瑕疵，需要容错处理）
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  var rawJson = jsonMatch ? jsonMatch[0] : repairTruncatedJSON(text);
  if (!rawJson || rawJson.indexOf('{') < 0) throw new Error('Ollama 未返回有效 JSON: ' + text.substring(0, 200));

  var scriptData = null;

  // 尝试直接解析
  try {
    scriptData = JSON.parse(rawJson);
  } catch (e) {
    // 修复常见 LLM JSON 问题：尾部逗号
    var fixed = rawJson.replace(/,\s*([\]}])/g, '$1');
    try {
      scriptData = JSON.parse(fixed);
    } catch (e2) {
      // 再尝试提取第一个完整的顶层对象
      var depth = 0, start = -1;
      for (var i = 0; i < rawJson.length; i++) {
        if (rawJson[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (rawJson[i] === '}') { depth--; if (depth === 0 && start >= 0) {
          var candidate = rawJson.substring(start, i + 1).replace(/,\s*([\]}])/g, '$1');
          try { scriptData = JSON.parse(candidate); break; } catch (e3) {}
        }}
      }
      // 截断修复：关闭未闭合的字符串和括号
      if (!scriptData) {
        var repaired = repairTruncatedJSON(rawJson);
        try { scriptData = JSON.parse(repaired); log('  JSON 截断已自动修复'); } catch (e4) {}
      }
    }
  }

  if (!scriptData) {
    // 最终兜底：生成最小可用剧本
    log('  JSON 解析全部失败，使用兜底剧本');
    scriptData = {
      title: outline.substring(0, 20),
      scenes: [{ id: 1, description: outline, characters: ['角色A'],
        dialogue: [{ speaker: '角色A', text: '...', emotion: 'neutral' }],
        sfx: 'ambient', music: 'calm' }]
    };
  }

  if (!scriptData.scenes || !Array.isArray(scriptData.scenes)) {
    throw new Error('剧本格式错误: 缺少 scenes 数组');
  }

  // 后处理：确保所有对话 text 不为空且为中文
  for (var si = 0; si < scriptData.scenes.length; si++) {
    var sc = scriptData.scenes[si];
    if (!sc.dialogue || !Array.isArray(sc.dialogue)) {
      sc.dialogue = [{ speaker: sc.characters ? sc.characters[0] : '旁白', text: '（沉默）', emotion: 'neutral' }];
    }
    for (var di = 0; di < sc.dialogue.length; di++) {
      var dlg = sc.dialogue[di];
      if (!dlg.text || dlg.text.trim() === '') {
        dlg.text = dlg.speaker + '看着眼前的景象，若有所思。';
        log('  场景' + sc.id + ' 对话' + (di+1) + ' text 为空，已填充默认台词');
      }
      // 检测英文混杂：连续3个以上英文单词视为异常
      var engMatch = dlg.text.match(/[a-zA-Z]+(\s+[a-zA-Z]+){2,}/);
      if (engMatch) {
        log('  场景' + sc.id + ' 对话' + (di+1) + ' 含英文，已替换为中文');
        dlg.text = dlg.speaker + '低声说了一番意味深长的话。';
      }
      if (!dlg.emotion) dlg.emotion = 'neutral';
    }
    if (!sc.sfx) sc.sfx = '';
    if (!sc.music) sc.music = '';
  }

  // 保存剧本
  var scriptDir = path.join(MANGA_DIR, 'current_project');
  ensureDir(scriptDir);
  var scriptPath = path.join(scriptDir, '01_script.json');
  fs.writeFileSync(scriptPath, JSON.stringify(scriptData, null, 2), 'utf-8');
  log('剧本生成完成: ' + scriptData.title + ' (' + scriptData.scenes.length + ' 个场景)');

  // 展示剧本详情，方便用户审阅和修改
  log('--- 剧本内容 ---');
  for (var sci = 0; sci < scriptData.scenes.length; sci++) {
    var scn = scriptData.scenes[sci];
    log('场景 ' + scn.id + ': ' + (scn.description || '').substring(0, 80));
    if (scn.characters) log('  角色: ' + scn.characters.join(', '));
    for (var dli = 0; dli < (scn.dialogue || []).length; dli++) {
      var dl = scn.dialogue[dli];
      log('  [' + dl.speaker + '] ' + dl.text);
    }
    if (scn.sfx) log('  音效: ' + scn.sfx);
    if (scn.music) log('  音乐: ' + scn.music);
  }
  log('--- 剧本结束 (保存于 ' + scriptPath + ') ---');

  return scriptData;
}

// ================================================================
//  Step 2: 角色图生成 (ComfyUI)
// ================================================================

async function generateCharacters(scriptData) {
  log('Step 2/8: 正在生成角色立绘...');

  // 收集所有角色
  var characters = {};
  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    for (var j = 0; j < scene.characters.length; j++) {
      var name = scene.characters[j];
      if (!characters[name]) characters[name] = true;
    }
  }

  var charNames = Object.keys(characters);
  if (charNames.length === 0) {
    log('  无角色，跳过');
    return {};
  }

  var results = {};
  var charImgDir = path.join(MANGA_DIR, 'current_project', 'characters');
  ensureDir(charImgDir);

  // 为每个角色生成描述 prompt
  var charPrompts = {};
  for (var k = 0; k < charNames.length; k++) {
    var name = charNames[k];
    charPrompts[name] = name + ', full body portrait, manga character design, detailed face, clean lines, anime style';
  }

  // 逐个生成
  for (var k = 0; k < charNames.length; k++) {
    var name = charNames[k];
    var prompt = charPrompts[name] + ', manga style, anime style, detailed, high quality, clean lines';
    log('  生成角色: ' + name);

    var maxRetries = 2;
    for (var retry = 0; retry < maxRetries; retry++) {
      try {
        var workflow = {
          "3": { "class_type": "KSampler", "inputs": {
            "cfg": 7, "denoise": 1, "latent_image": ["5", 0], "model": ["4", 0],
            "negative": ["7", 0], "positive": ["6", 0],
            "sampler_name": "dpmpp_2m", "scheduler": "karras",
            "seed": Math.floor(Math.random() * 2147483647),
            "steps": 20
          }},
          "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" } },
          "5": { "class_type": "EmptyLatentImage", "inputs": { "batch_size": 1, "height": 512, "width": 512 } },
          "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": prompt } },
          "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": "blurry, bad quality, worst quality, deformed, ugly, bad anatomy, disfigured, lowres, text, watermark" } },
          "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
          "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "char_" + name.replace(/\s+/g, '_'), "images": ["8", 0] } },
        };

        var clientId = 'manga-wf-' + Date.now() + '-' + k;
        var queueResp = await fetch(COMFYUI_PROXY + '/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: workflow, client_id: clientId }),
          signal: AbortSignal.timeout(15000),
        });

        if (!queueResp.ok) throw new Error('ComfyUI 提交失败: ' + queueResp.status);
        var queueData = await queueResp.json();
        var promptId = queueData.prompt_id;

        // 等待完成
        var imgPath = await waitForComfyUIImage(promptId, charImgDir, 'char_' + name.replace(/\s+/g, '_'));
        results[name] = imgPath;
        log('  角色 ' + name + ' 生成完成: ' + imgPath);
        break; // 成功，跳出重试
      } catch (e) {
        if (retry < maxRetries - 1 && (e.message.indexOf('OutOfMemory') >= 0 || e.message.indexOf('执行错误') >= 0 || e.message.indexOf('Allocation') >= 0)) {
          log('  角色 ' + name + ' 显存不足，等待 5 秒后重试...');
          await new Promise(function(resolve) { setTimeout(resolve, 5000); });
        } else {
          log('  角色 ' + name + ' 生成失败: ' + e.message);
          results[name] = null;
        }
      }
    }
  }

  return results;
}

// ================================================================
//  Step 3: 场景图生成 (ComfyUI)
// ================================================================

async function generateScenes(scriptData) {
  log('Step 3/8: 正在生成场景背景...');

  var results = {};
  var sceneImgDir = path.join(MANGA_DIR, 'current_project', 'scenes');
  ensureDir(sceneImgDir);

  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    var prompt = scene.description + ', manga background, anime background, detailed, atmospheric, high quality';
    log('  生成场景 ' + scene.id + ': ' + scene.description.substring(0, 40) + '...');

    var maxRetries = 2;
    for (var retry = 0; retry < maxRetries; retry++) {
      try {
        var workflow = {
          "3": { "class_type": "KSampler", "inputs": {
            "cfg": 7, "denoise": 1, "latent_image": ["5", 0], "model": ["4", 0],
            "negative": ["7", 0], "positive": ["6", 0],
            "sampler_name": "dpmpp_2m", "scheduler": "karras",
            "seed": Math.floor(Math.random() * 2147483647),
            "steps": 20
          }},
          "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "v1-5-pruned-emaonly.safetensors" } },
          "5": { "class_type": "EmptyLatentImage", "inputs": { "batch_size": 1, "height": 512, "width": 512 } },
          "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": prompt } },
          "7": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["4", 1], "text": "blurry, bad quality, worst quality, deformed, ugly, bad anatomy, disfigured, lowres, text, watermark" } },
          "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
          "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "scene_" + scene.id, "images": ["8", 0] } },
        };

        var clientId = 'manga-wf-scene-' + Date.now() + '-' + i;
        var queueResp = await fetch(COMFYUI_PROXY + '/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: workflow, client_id: clientId }),
          signal: AbortSignal.timeout(15000),
        });

        if (!queueResp.ok) throw new Error('ComfyUI 提交失败: ' + queueResp.status);
        var queueData = await queueResp.json();
        var promptId = queueData.prompt_id;

        var imgPath = await waitForComfyUIImage(promptId, sceneImgDir, 'scene_' + scene.id);
        results[scene.id] = imgPath;
        log('  场景 ' + scene.id + ' 生成完成: ' + imgPath);
        break; // 成功，跳出重试
      } catch (e) {
        if (retry < maxRetries - 1 && (e.message.indexOf('OutOfMemory') >= 0 || e.message.indexOf('执行错误') >= 0 || e.message.indexOf('Allocation') >= 0)) {
          log('  场景 ' + scene.id + ' 显存不足，等待 5 秒后重试...');
          await new Promise(function(resolve) { setTimeout(resolve, 5000); });
        } else {
          log('  场景 ' + scene.id + ' 生成失败: ' + e.message);
          results[scene.id] = null;
        }
      }
    }
  }

  return results;
}

// 等待 ComfyUI 图片生成完成并下载
async function waitForComfyUIImage(promptId, saveDir, prefix) {
  var timeout = 180000;
  var start = Date.now();

  while (Date.now() - start < timeout) {
    await new Promise(function(resolve) { setTimeout(resolve, 3000); });

    try {
      var resp = await fetch(COMFYUI_PROXY + '/history/' + promptId, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        var history = await resp.json();
        var entry = history[promptId];
        if (entry && entry.status && entry.status.completed) {
          var outputs = entry.outputs || {};
          for (var nodeId in outputs) {
            if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
              var img = outputs[nodeId].images[0];
              var imgUrl = COMFYUI_PROXY + '/view?filename=' + encodeURIComponent(img.filename) + '&subfolder=' + encodeURIComponent(img.subfolder || '') + '&type=' + encodeURIComponent(img.type || 'output');
              var imgResp = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) });
              var buffer = Buffer.from(await imgResp.arrayBuffer());
              var savePath = path.join(saveDir, prefix + '.png');
              fs.writeFileSync(savePath, buffer);
              return savePath;
            }
          }
        }
        if (entry && entry.status && entry.status.status_str === 'error') {
          var errMsg = 'ComfyUI 执行错误';
          try {
            var msgs = entry.status.messages || [];
            for (var m = 0; m < msgs.length; m++) {
              if (msgs[m][0] === 'execution_error' && msgs[m][1] && msgs[m][1].exception_message) {
                errMsg += ': ' + msgs[m][1].exception_message;
                break;
              }
            }
          } catch (_) {}
          throw new Error(errMsg);
        }
      }
    } catch (e) {
      if (e.message.indexOf('ComfyUI') >= 0 || e.message.indexOf('执行错误') >= 0 || e.message.indexOf('Allocation') >= 0 || e.message.indexOf('OutOfMemory') >= 0) throw e;
    }
  }
  throw new Error('ComfyUI 生成超时');
}

// ================================================================
//  Step 4: 配音生成 (Fish Speech TTS)
// ================================================================

async function generateVoices(scriptData) {
  log('Step 4/8: 正在生成角色配音...');

  var voiceDir = path.join(MANGA_DIR, 'current_project', 'voices');
  ensureDir(voiceDir);

  // 预热 TTS 服务（首次调用需加载模型，可能很慢）
  try {
    log('  预热 TTS 服务...');
    await httpPost(TTS_URL + '/synthesize', {
      text: '预热',
      output: path.join(voiceDir, '_warmup.wav'),
      speed: 1.0,
      voice: 'default',
    }, 300000);
    log('  TTS 预热完成');
  } catch (warmupErr) {
    log('  TTS 预热失败（不影响后续）: ' + warmupErr.message);
  }

  var results = [];
  var dialogueIdx = 0;

  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    for (var j = 0; j < scene.dialogue.length; j++) {
      var d = scene.dialogue[j];
      var outputFile = path.join(voiceDir, 'voice_' + String(dialogueIdx).padStart(3, '0') + '.wav');
      dialogueIdx++;

      log('  配音 [' + d.speaker + ']: ' + d.text.substring(0, 50) + (d.text.length > 50 ? '...' : ''));

      var maxTries = 2;
      for (var attempt = 0; attempt < maxTries; attempt++) {
        try {
          var result = await httpPost(TTS_URL + '/synthesize', {
            text: d.text,
            output: outputFile,
            speed: 1.0,
            voice: 'default',
          }, 300000);

          if (result.success) {
            results.push({ scene: scene.id, speaker: d.speaker, text: d.text, file: outputFile });
            log('  配音完成: ' + path.basename(outputFile));
          } else {
            log('  配音失败: ' + (result.error || '未知错误'));
            results.push({ scene: scene.id, speaker: d.speaker, text: d.text, file: null, error: result.error });
          }
          break;
        } catch (e) {
          if (attempt < maxTries - 1 && (e.message.indexOf('504') >= 0 || e.message.indexOf('timeout') >= 0 || e.message.indexOf('timed out') >= 0)) {
            log('  配音超时，重试 (' + (attempt + 2) + '/' + maxTries + ')...');
            await new Promise(function(resolve) { setTimeout(resolve, 3000); });
          } else {
            log('  配音服务不可用: ' + e.message + ' (跳过)');
            results.push({ scene: scene.id, speaker: d.speaker, text: d.text, file: null, error: e.message });
          }
        }
      }
    }
  }

  return results;
}

// ================================================================
//  Step 5: 音效生成 (AudioLDM-S)
// ================================================================

async function generateSFX(scriptData) {
  log('Step 5/8: 正在生成音效...');

  var sfxDir = path.join(MANGA_DIR, 'current_project', 'sfx');
  ensureDir(sfxDir);

  var results = [];

  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    var sfxDesc = scene.sfx || '';
    if (!sfxDesc) continue;

    var outputFile = path.join(sfxDir, 'sfx_' + scene.id + '.wav');
    log('  音效 [' + scene.id + ']: ' + sfxDesc);

    try {
      var result = await httpPost(AUDIOLDM_URL + '/generate', {
        prompt: sfxDesc,
        duration: 5,
        output: outputFile,
      }, 120000);

      if (result.success) {
        results.push({ scene: scene.id, description: sfxDesc, file: outputFile });
        log('  音效完成: ' + path.basename(outputFile));
      } else {
        log('  音效失败: ' + (result.error || '未知错误'));
        results.push({ scene: scene.id, file: null, error: result.error });
      }
    } catch (e) {
      log('  AudioLDM 服务不可用: ' + e.message + ' (跳过)');
      results.push({ scene: scene.id, file: null, error: e.message });
    }
  }

  return results;
}

// ================================================================
//  Step 6: 背景音乐生成 (MusicGen)
// ================================================================

async function generateMusic(scriptData) {
  log('Step 6/8: 正在生成背景音乐...');

  var musicDir = path.join(MANGA_DIR, 'current_project', 'music');
  ensureDir(musicDir);

  var results = [];

  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    var musicDesc = scene.music || '';
    if (!musicDesc) continue;

    var outputFile = path.join(musicDir, 'music_' + scene.id + '.wav');
    log('  音乐 [' + scene.id + ']: ' + musicDesc);

    try {
      var result = await httpPost(MUSICGEN_URL + '/generate', {
        prompt: musicDesc,
        duration: 10,
        output: outputFile,
      }, 180000);

      if (result.success) {
        results.push({ scene: scene.id, description: musicDesc, file: outputFile, duration: result.duration || 10 });
        log('  音乐完成: ' + path.basename(outputFile));
      } else {
        log('  音乐失败: ' + (result.error || '未知错误'));
        results.push({ scene: scene.id, file: null, error: result.error });
      }
    } catch (e) {
      log('  MusicGen 服务不可用: ' + e.message + ' (跳过)');
      results.push({ scene: scene.id, file: null, error: e.message });
    }
  }

  return results;
}

// ================================================================
//  Step 7: 分镜合成 (图片 + 字幕叠加)
// ================================================================

async function composeStoryboard(scriptData, charImages, sceneImages, voices) {
  log('Step 7/8: 正在合成漫画分镜...');

  var storyboardDir = path.join(MANGA_DIR, 'current_project', 'storyboard');
  ensureDir(storyboardDir);

  var panels = [];
  var ffmpeg = path.join(getFfmpegBinDir(), 'ffmpeg.exe');

  for (var i = 0; i < scriptData.scenes.length; i++) {
    var scene = scriptData.scenes[i];
    var bgImg = sceneImages[scene.id] || null;

    for (var j = 0; j < scene.dialogue.length; j++) {
      var d = scene.dialogue[j];
      var panelId = 'panel_' + scene.id + '_' + (j + 1);
      var outputFile = path.join(storyboardDir, panelId + '.png');

      // 找到对应的配音文件
      var voiceFile = null;
      for (var k = 0; k < voices.length; k++) {
        if (voices[k].scene === scene.id && voices[k].speaker === d.speaker && voices[k].file) {
          voiceFile = voices[k].file;
          break;
        }
      }

      log('  合成面板: 场景' + scene.id + ' 对话' + (j + 1) + ' [' + d.speaker + '] ' + d.text.substring(0, 40));

      try {
        if (bgImg && fs.existsSync(bgImg)) {
          // 使用 FFmpeg 在背景图上叠加字幕
          // shell: false 下参数直接传递，不需要复杂转义
          var filterStr = "drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':text='" + d.text.replace(/'/g, "\\\\'").replace(/:/g, '\\:') + "':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-th-40";
          var cmd = [
            ffmpeg, '-y',
            '-i', bgImg,
            '-vf', filterStr,
            '-frames:v', '1',
            '-update', '1',
            outputFile
          ];

          await runCommand(cmd);
          panels.push({
            id: panelId, scene: scene.id, dialogue: j + 1,
            speaker: d.speaker, text: d.text, emotion: d.emotion,
            image: outputFile, voice: voiceFile
          });
          log('  面板完成: ' + path.basename(outputFile));
        } else {
          log('  跳过（无背景图）');
          panels.push({
            id: panelId, scene: scene.id, dialogue: j + 1,
            speaker: d.speaker, text: d.text, emotion: d.emotion,
            image: null, voice: voiceFile
          });
        }
      } catch (e) {
        log('  面板合成失败: ' + e.message);
        panels.push({
          id: panelId, scene: scene.id, dialogue: j + 1,
          speaker: d.speaker, text: d.text, emotion: d.emotion,
          image: null, voice: voiceFile, error: e.message
        });
      }
    }
  }

  return panels;
}

// ================================================================
//  Step 8: 最终视频渲染 (FFmpeg)
// ================================================================

async function renderVideo(scriptData, panels, sfxResults, musicResults) {
  log('Step 8/8: 正在渲染最终视频...');

  var renderDir = path.join(MANGA_DIR, 'current_project', 'render');
  ensureDir(renderDir);

  var outputFile = path.join(renderDir, scriptData.title.replace(/[^\w\u4e00-\u9fa5]/g, '_') + '_final.mp4');
  var ffmpeg = path.join(getFfmpegBinDir(), 'ffmpeg.exe');
  var ffprobe = path.join(getFfmpegBinDir(), 'ffprobe.exe');

  var validPanels = panels.filter(function(p) { return p.image && fs.existsSync(p.image); });
  if (validPanels.length === 0) {
    log('  没有可用的面板图片，跳过视频渲染');
    return { success: false, error: 'no valid panels' };
  }

  var clipDir = path.join(renderDir, 'clips');
  ensureDir(clipDir);
  var clipList = [];
  var fps = 25;
  var defaultDuration = 4;

  for (var i = 0; i < validPanels.length; i++) {
    var panel = validPanels[i];
    var clipFile = path.join(clipDir, 'clip_' + String(i).padStart(3, '0') + '.mp4');

    // 根据配音时长决定面板持续时间
    var duration = defaultDuration;
    var hasVoice = panel.voice && fs.existsSync(panel.voice);
    if (hasVoice) {
      try {
        var probeOut = await runCommandOutput([ffprobe, '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', panel.voice]);
        var voiceDur = parseFloat(probeOut.trim());
        if (voiceDur > 0 && voiceDur < 60) duration = Math.max(voiceDur + 1.0, 3);
      } catch (e) { /* 使用默认时长 */ }
    }

    var totalFrames = Math.round(duration * fps);
    var zoomSpeed = (0.25 / totalFrames).toFixed(5);

    // Ken Burns 效果：奇偶面板交替缩放方向
    var zoomExpr;
    if (i % 2 === 0) {
      zoomExpr = 'min(zoom+' + zoomSpeed + ',1.25)';           // 缓慢推近
    } else {
      zoomExpr = 'if(eq(on,0),1.25,max(zoom-' + zoomSpeed + ',1.0))';  // 缓慢拉远
    }

    var fadeOutStart = Math.max(duration - 0.5, 0.1).toFixed(1);
    var vf = "zoompan=z='" + zoomExpr + "':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" +
             ":d=" + totalFrames + ":s=512x512:fps=" + fps +
             ",fade=t=in:st=0:d=0.4,fade=t=out:st=" + fadeOutStart + ":d=0.5";

    var cmd;
    if (hasVoice) {
      // 带配音的片段：图片 + 语音 → 视频
      cmd = [ffmpeg, '-y',
        '-loop', '1', '-i', panel.image,
        '-i', panel.voice,
        '-vf', vf,
        '-t', String(duration),
        '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        clipFile];
    } else {
      // 无配音：静音音轨
      cmd = [ffmpeg, '-y',
        '-loop', '1', '-i', panel.image,
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-vf', vf,
        '-t', String(duration),
        '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        clipFile];
    }

    try {
      await runCommand(cmd);
      clipList.push(clipFile);
      log('  片段 ' + (i + 1) + '/' + validPanels.length + ' 完成 (' + duration.toFixed(1) + 's' + (hasVoice ? ', 含配音' : ', 静音') + ')');
    } catch (e) {
      log('  片段 ' + (i + 1) + ' 失败: ' + e.message);
    }
  }

  if (clipList.length === 0) {
    log('  没有成功生成的片段');
    return { success: false, error: 'no clips generated' };
  }

  // 拼接所有片段
  var concatFile = path.join(renderDir, 'concat_list.txt');
  var concatContent = clipList.map(function(f) { return "file '" + f.replace(/\\/g, '/') + "'"; }).join('\n');
  fs.writeFileSync(concatFile, concatContent, 'utf-8');

  // 查找可用的背景音乐
  var musicFile = null;
  for (var m = 0; m < musicResults.length; m++) {
    if (musicResults[m].file && fs.existsSync(musicResults[m].file)) {
      musicFile = musicResults[m].file;
      break;
    }
  }

  var finalCmd;
  if (musicFile) {
    // 配音 + 背景音乐混合（音乐音量 30%）
    finalCmd = [ffmpeg, '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-i', musicFile,
      '-filter_complex',
      '[0:a]volume=1.0[voice];[1:a]volume=0.3,afade=t=out:st=' + (clipList.length * defaultDuration - 2).toFixed(0) + ':d=2[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputFile];
  } else {
    finalCmd = [ffmpeg, '-y',
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'copy', '-c:a', 'aac',
      '-movflags', '+faststart',
      outputFile];
  }

  try {
    await runCommand(finalCmd);
    var size = fs.statSync(outputFile).size;
    log('视频渲染完成: ' + outputFile + ' (' + (size / 1024 / 1024).toFixed(1) + ' MB, ' + clipList.length + ' 片段' + (musicFile ? ', 含背景音乐' : '') + ')');
    return { success: true, file: outputFile, size: size, clips: clipList.length };
  } catch (e) {
    log('视频渲染失败: ' + e.message);
    return { success: false, error: e.message };
  }
}

// 执行命令行
function runCommand(args) {
  return new Promise(function(resolve, reject) {
    var child = require('child_process').spawn(args[0], args.slice(1), {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    var stderr = '';
    child.stderr.on('data', function(data) { stderr += data.toString(); });
    child.on('close', function(code) {
      if (code === 0) resolve();
      else reject(new Error('命令失败 (exit ' + code + '): ' + stderr.substring(stderr.length - 200)));
    });
    child.on('error', reject);
  });
}

// 执行命令行并返回 stdout（用于 ffprobe 等需要输出的场景）
function runCommandOutput(args) {
  return new Promise(function(resolve, reject) {
    var child = require('child_process').spawn(args[0], args.slice(1), {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    var stdout = '', stderr = '';
    child.stdout.on('data', function(data) { stdout += data.toString(); });
    child.stderr.on('data', function(data) { stderr += data.toString(); });
    child.on('close', function(code) {
      if (code === 0) resolve(stdout);
      else reject(new Error('命令失败 (exit ' + code + '): ' + stderr.substring(stderr.length - 200)));
    });
    child.on('error', reject);
  });
}

// ================================================================
//  完整工作流
// ================================================================

async function runFullWorkflow(outline) {
  if (_pipelineRunning) {
    log('工作流正在运行中，请等待完成');
    return;
  }
  _pipelineRunning = true;
  _pipelineLog = [];

  var projectDir = path.join(MANGA_DIR, 'current_project');
  ensureDir(projectDir);

  // 执行日志追踪（供蒸馏分析）
  var execLog = {
    run_id: 'run_' + Date.now(),
    start_time: new Date().toISOString(),
    outline: outline.substring(0, 200),
    steps: {},
    services: {},
    errors: [],
    success: false,
  };
  function stepStart(name) { execLog.steps[name] = { start: Date.now(), status: 'running' }; }
  function stepEnd(name, ok, detail) {
    if (execLog.steps[name]) {
      execLog.steps[name].end = Date.now();
      execLog.steps[name].duration_ms = execLog.steps[name].end - execLog.steps[name].start;
      execLog.steps[name].status = ok ? 'ok' : 'failed';
      if (detail) execLog.steps[name].detail = detail;
    }
  }

  try {
    log('========== AI 漫剧全自动工作流启动 ==========');
    log('大纲: ' + outline.substring(0, 100) + (outline.length > 100 ? '...' : ''));

    // 检查服务状态
    var services = await checkServices();
    execLog.services = services;
    log('服务状态: ComfyUI=' + services.comfyui + ', Ollama=' + services.ollama +
        ', TTS=' + services.tts + ', AudioLDM=' + services.audioldm + ', MusicGen=' + services.musicgen);

    // Step 1: 剧本生成
    stepStart('script');
    var scriptData;
    try {
      scriptData = await generateScript(outline);
      stepEnd('script', true, { title: scriptData.title, scenes: scriptData.scenes.length });
    } catch (e) {
      stepEnd('script', false, e.message);
      execLog.errors.push({ step: 'script', error: e.message });
      throw e;
    }

    // Step 2: 角色图
    stepStart('characters');
    var charImages = {};
    if (services.comfyui === 'ok') {
      charImages = await generateCharacters(scriptData);
      var charOk = Object.keys(charImages).filter(function(k) { return charImages[k]; }).length;
      stepEnd('characters', charOk > 0, { total: Object.keys(charImages).length, success: charOk });
    } else {
      stepEnd('characters', false, 'ComfyUI offline');
      log('ComfyUI 不可用，跳过角色生成');
    }

    // Step 3: 场景图
    stepStart('scenes');
    var sceneImages = {};
    if (services.comfyui === 'ok') {
      sceneImages = await generateScenes(scriptData);
      var sceneOk = Object.keys(sceneImages).filter(function(k) { return sceneImages[k]; }).length;
      stepEnd('scenes', sceneOk > 0, { total: Object.keys(sceneImages).length, success: sceneOk });
    } else {
      stepEnd('scenes', false, 'ComfyUI offline');
      log('ComfyUI 不可用，跳过场景生成');
    }

    // 图像生成完毕，清理 GPU 显存供音频服务使用
    await clearGPU();

    // Step 4: 配音
    stepStart('voices');
    var voices = [];
    if (services.tts === 'ok') {
      voices = await generateVoices(scriptData);
      var voiceOk = voices.filter(function(v) { return v.file; }).length;
      stepEnd('voices', voiceOk > 0, { total: voices.length, success: voiceOk });
    } else {
      stepEnd('voices', false, 'TTS offline');
      log('TTS 服务不可用，跳过配音');
    }

    // Step 5: 音效
    stepStart('sfx');
    var sfxResults = [];
    if (services.audioldm === 'ok') {
      sfxResults = await generateSFX(scriptData);
      var sfxOk = sfxResults.filter(function(s) { return s.file; }).length;
      stepEnd('sfx', sfxOk > 0, { total: sfxResults.length, success: sfxOk });
    } else {
      stepEnd('sfx', false, 'AudioLDM offline');
      log('AudioLDM 服务不可用，跳过音效');
    }

    // 清理 TTS/AudioLDM 显存，为 MusicGen 腾出空间
    await clearGPU();

    // Step 6: 背景音乐
    stepStart('music');
    var musicResults = [];
    if (services.musicgen === 'ok') {
      musicResults = await generateMusic(scriptData);
      var musicOk = musicResults.filter(function(m) { return m.file; }).length;
      stepEnd('music', musicOk > 0, { total: musicResults.length, success: musicOk });
    } else {
      stepEnd('music', false, 'MusicGen offline');
      log('MusicGen 服务不可用，跳过背景音乐');
    }

    // Step 7: 分镜合成
    stepStart('storyboard');
    var panels = await composeStoryboard(scriptData, charImages, sceneImages, voices);
    var panelOk = panels.filter(function(p) { return p.image; }).length;
    stepEnd('storyboard', panelOk > 0, { total: panels.length, success: panelOk });

    // Step 8: 最终视频
    stepStart('video');
    var videoResult = await renderVideo(scriptData, panels, sfxResults, musicResults);
    stepEnd('video', videoResult.success, videoResult.success ? { file: videoResult.file, size: videoResult.size } : { error: videoResult.error });

    execLog.success = videoResult.success;

    // 保存项目摘要
    var summary = {
      title: scriptData.title,
      outline: outline,
      timestamp: new Date().toISOString(),
      services: services,
      characters: Object.keys(charImages),
      scenes: scriptData.scenes.length,
      voices: voices.length,
      sfx: sfxResults.length,
      music: musicResults.length,
      panels: panels.length,
      video: videoResult,
      project_dir: projectDir,
    };
    var summaryPath = path.join(projectDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

    log('========== 工作流完成 ==========');
    log('项目目录: ' + projectDir);
    log('剧本: ' + path.join(projectDir, '01_script.json'));
    var charKeys = Object.keys(charImages);
    for (var ci2 = 0; ci2 < charKeys.length; ci2++) {
      if (charImages[charKeys[ci2]]) log('角色图 [' + charKeys[ci2] + ']: ' + charImages[charKeys[ci2]]);
    }
    var sceneKeys = Object.keys(sceneImages);
    for (var si2 = 0; si2 < sceneKeys.length; si2++) {
      if (sceneImages[sceneKeys[si2]]) log('场景图 [' + sceneKeys[si2] + ']: ' + sceneImages[sceneKeys[si2]]);
    }
    var voiceOk2 = voices.filter(function(v) { return v.file; });
    for (var vi2 = 0; vi2 < voiceOk2.length; vi2++) {
      log('配音 [' + voiceOk2[vi2].speaker + ']: ' + voiceOk2[vi2].file);
    }
    if (videoResult.success) {
      log('最终视频: ' + videoResult.file);
    }

    updateProgress('漫剧生成完成！标题: ' + scriptData.title +
      '\n场景: ' + scriptData.scenes.length +
      '\n角色: ' + charKeys.length +
      '\n配音: ' + voiceOk2.length + '/' + voices.length +
      '\n分镜: ' + panels.length +
      (videoResult.success ? '\n视频: ' + videoResult.file : '\n视频: 未生成') +
      '\n项目目录: ' + projectDir);

  } catch (e) {
    execLog.success = false;
    execLog.errors.push({ step: 'workflow', error: e.message });
    log('工作流异常: ' + e.message);
    updateProgress('工作流失败: ' + e.message);
  } finally {
    // 保存结构化执行日志（供蒸馏分析）
    execLog.end_time = new Date().toISOString();
    execLog.total_duration_ms = new Date(execLog.end_time) - new Date(execLog.start_time);
    try {
      var logDir = path.join(MANGA_DIR, 'execution_logs');
      ensureDir(logDir);
      var logFile = path.join(logDir, execLog.run_id + '.json');
      fs.writeFileSync(logFile, JSON.stringify(execLog, null, 2), 'utf-8');
      log('执行日志已保存: ' + logFile);
    } catch (logErr) {
      console.error('保存执行日志失败:', logErr.message);
    }
    _pipelineRunning = false;
  }
}

// 检查所有服务状态
async function checkServices() {
  var status = { comfyui: 'error', ollama: 'error', tts: 'error', audioldm: 'error', musicgen: 'error' };

  try {
    await httpGet(COMFYUI_PROXY + '/status', 3000);
    status.comfyui = 'ok';
  } catch (e) {}

  try {
    await httpGet(OLLAMA_URL + '/api/tags', 3000);
    status.ollama = 'ok';
  } catch (e) {}

  try {
    await httpGet(TTS_URL + '/health', 3000);
    status.tts = 'ok';
  } catch (e) {}

  try {
    await httpGet(AUDIOLDM_URL + '/health', 3000);
    status.audioldm = 'ok';
  } catch (e) {}

  try {
    await httpGet(MUSICGEN_URL + '/health', 3000);
    status.musicgen = 'ok';
  } catch (e) {}

  return status;
}

// ================================================================
//  命令注册
// ================================================================

function registerCommands() {
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('manga-auto', '全自动漫剧工作流（大纲→视频）', function(args) {
      if (!args || !args.trim()) {
        Core.session.addMessage('用法: /manga-auto <故事大纲>\n例如: /manga-auto 一个侦探在雨夜的城市里追踪神秘嫌疑人，最终在咖啡馆发现真相', 'ai');
        return true;
      }
      runFullWorkflow(args.trim());
      return true;
    });

    Core.custom.registerCommand('manga-status', '查看漫剧工作流服务状态', function() {
      checkServices().then(function(status) {
        var msg = '漫剧工作流服务状态:\n';
        msg += '  ComfyUI (图像): ' + (status.comfyui === 'ok' ? '✅ 在线' : '❌ 离线') + '\n';
        msg += '  Ollama (剧本): ' + (status.ollama === 'ok' ? '✅ 在线' : '❌ 离线') + '\n';
        msg += '  Fish Speech (配音): ' + (status.tts === 'ok' ? '✅ 在线' : '❌ 离线') + '\n';
        msg += '  AudioLDM-S (音效): ' + (status.audioldm === 'ok' ? '✅ 在线' : '❌ 离线') + '\n';
        msg += '  MusicGen (音乐): ' + (status.musicgen === 'ok' ? '✅ 在线' : '❌ 离线') + '\n';
        msg += '\n运行中: ' + (_pipelineRunning ? '是' : '否');
        Core.session.addMessage(msg, 'ai');
      });
      return true;
    });
  }
}

// ================================================================
//  模块导出
// ================================================================

module.exports = {
  name: 'manga-workflow',
  dependencies: ['manga-comfyui'],
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

    // 挂载到 Core
    Core.mangaWorkflow = {
      runFullWorkflow: runFullWorkflow,
      checkServices: checkServices,
      generateScript: generateScript,
      isRunning: function() { return _pipelineRunning; },
      getLog: function() { return _pipelineLog.slice(); },
    };

    registerCommands();
    log('漫剧工作流模块已加载');
  }
};
