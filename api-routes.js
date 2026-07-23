// api-routes.js - Express API 路由处理（从 main.js startWebServer 提取）

const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { setupMobileRoutes } = require('./web-server');

/**
 * 注册所有 API 路由到 Express app
 * @param {import('express').Express} app2 - Express 应用实例
 * @param {object} ctx - 上下文对象
 * @param {string} ctx.DATA_ROOT - 数据根目录
 * @param {function} ctx.getMainWindow - 获取主窗口实例
 * @param {function} ctx.setActualPort - 设置实际端口
 */
function registerApiRoutes(app2, ctx) {
  const { DATA_ROOT, getMainWindow, setActualPort } = ctx;

  // 🔒 #16 修复：简易内存速率限制器（按 IP + 路径前缀）
  var _rateLimitMap = {};
  var RATE_LIMIT_WINDOW = 60000; // 1 分钟窗口
  var RATE_LIMIT_MAX = { '/api/image': 10, '/api/search': 20, '/api/tts': 15, '/api/asr': 10, '/api/comfyui': 5, 'default': 60 };

  function rateLimiter(req, res, next) {
    var ip = req.ip || req.connection.remoteAddress || 'unknown';
    var pathPrefix = '/api/' + (req.path.split('/')[2] || 'other');
    var limit = RATE_LIMIT_MAX[pathPrefix] || RATE_LIMIT_MAX['default'];
    var key = ip + ':' + pathPrefix;
    var now = Date.now();

    if (!_rateLimitMap[key]) {
      _rateLimitMap[key] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
      return next();
    }
    var entry = _rateLimitMap[key];
    if (now > entry.resetAt) {
      entry.count = 1;
      entry.resetAt = now + RATE_LIMIT_WINDOW;
      return next();
    }
    entry.count++;
    if (entry.count > limit) {
      res.status(429).json({ error: 'Too Many Requests', message: '请求过于频繁，请稍后再试（限制: ' + limit + '次/分钟）' });
      return;
    }
    next();
  }

  // 定期清理过期的速率限制条目
  setInterval(function() {
    var now = Date.now();
    var keys = Object.keys(_rateLimitMap);
    for (var i = 0; i < keys.length; i++) {
      if (now > _rateLimitMap[keys[i]].resetAt) delete _rateLimitMap[keys[i]];
    }
  }, 60000);

  // 应用速率限制到所有 /api 路由
  app2.use('/api', rateLimiter);

  // 健康检查
  app2.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 图片分析端点（支持 OCR + 图片信息 + 图片描述）
  app2.post('/api/image', async (req, res) => {
    try {
      const { image, type = 'describe', prompt } = req.body;
      if (!image) {
        return res.status(400).json({ error: '缺少图片数据' });
      }
      
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      
      let result = { success: true };
      
      // 🔧 图片处理（sharp）
      try {
        const sharp = require('sharp');
        const metadata = await sharp(buffer).metadata();
        result.imageInfo = {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          size: buffer.length,
        };
        
        // 如果图片太大，压缩后返回
        if (buffer.length > 1024 * 1024) { // > 1MB
          const compressed = await sharp(buffer)
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          result.compressed = 'data:image/jpeg;base64,' + compressed.toString('base64');
          result.compressedSize = compressed.length;
        }
      } catch (e) {
        result.imageInfo = { size: buffer.length, note: 'sharp 未安装' };
      }
      
      // 🔧 OCR 文字识别（tesseract.js）
      if (type === 'ocr' || type === 'full') {
        try {
          const { createWorker } = require('tesseract.js');
          const worker = await createWorker('chi_sim+eng'); // 中文简体 + 英文
          const { data: { text } } = await worker.recognize(buffer);
          await worker.terminate();
          result.ocr = {
            text: text.trim(),
            confidence: 'unknown', // tesseract.js v6 可能有不同 API
          };
        } catch (e) {
          result.ocr = { error: 'tesseract.js 未安装或配置错误: ' + e.message };
        }
      }
      
      // 🔧 图片描述（调用 Ollama llava 模型）
      if (type === 'describe' || type === 'full') {
        try {
          const ollamaResp = await fetch('http://127.0.0.1:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'llava:7b',
              prompt: prompt || '请详细描述这张图片的内容',
              stream: false,
              images: [base64Data],
            }),
          });
          if (ollamaResp.ok) {
            const ollamaData = await ollamaResp.json();
            result.description = ollamaData.response || '无法生成描述';
          } else {
            result.description = 'Ollama 请求失败: ' + ollamaResp.status;
          }
        } catch (e) {
          result.description = 'Ollama 不可用: ' + e.message;
        }
      }
      
      res.json(result);
    } catch (err) {
      console.error('❌ /api/image 错误:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 搜索端点（真正的后端代理 - 支持国内可用引擎）
  app2.post('/api/search', async (req, res) => {
    try {
      const { query, engine, apiKeys } = req.body;
      
      let results = '';
      
      switch (engine) {
        case 'bing':
          // Bing China — 免费搜索，无需 API Key，国内可访问
          try {
            const bingScript = path.join(__dirname, 'scripts', 'search_bing.py');
            const { spawn: spawnBing2 } = require('child_process');
            const bingProc2 = spawnBing2('python', [bingScript, '--query', query, '--max-results', '5'], { timeout: 20000 });
            let bingOut2 = '', bingErr2 = '';
            bingProc2.stdout.on('data', d => bingOut2 += d.toString());
            bingProc2.stderr.on('data', d => bingErr2 += d.toString());
            await new Promise((resolve) => bingProc2.on('close', resolve));
            try {
              const bingData2 = JSON.parse(bingOut2.trim());
              if (bingData2.success && bingData2.results && bingData2.results.length > 0) {
                results = bingData2.results.map(r => `${r.title}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
              } else if (bingData2.error) {
                console.warn('Bing China error:', bingData2.error);
              }
            } catch (pe) {
              console.warn('Bing China parse error:', bingErr2.substring(0, 200));
            }
          } catch (e) { console.warn('Bing China failed:', e.message); }
          break;

        case 'duckduckgo':
          // DuckDuckGo — 免费搜索，无需 API Key
          try {
            const ddgScript = path.join(__dirname, 'scripts', 'search_ddg.py');
            const { spawn: spawnDdg } = require('child_process');
            const ddgProc = spawnDdg('python', [ddgScript, '--query', query, '--max-results', '5'], { timeout: 20000 });
            let ddgOut = '', ddgErr = '';
            ddgProc.stdout.on('data', d => ddgOut += d.toString());
            ddgProc.stderr.on('data', d => ddgErr += d.toString());
            await new Promise((resolve) => ddgProc.on('close', resolve));
            try {
              const ddgData = JSON.parse(ddgOut.trim());
              if (ddgData.success && ddgData.results && ddgData.results.length > 0) {
                results = ddgData.results.map(r => `${r.title}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
              } else if (ddgData.error) {
                console.warn('DuckDuckGo error:', ddgData.error);
              }
            } catch (pe) {
              console.warn('DuckDuckGo parse error:', ddgErr.substring(0, 200));
            }
          } catch (e) { console.warn('DuckDuckGo failed:', e.message); }
          break;

        case 'tavily':
          if (apiKeys.tavilyApiKey) {
            try {
              const tavilyResp = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  api_key: apiKeys.tavilyApiKey,
                  query: query,
                  max_results: 5,
                  include_answer: true
                }),
                signal: AbortSignal.timeout(15000)
              });
              if (tavilyResp.ok) {
                const data = await tavilyResp.json();
                if (data.answer) {
                  results = `摘要：${data.answer}\n\n`;
                }
                if (data.results && data.results.length > 0) {
                  results += data.results.map(r => `${r.title}\n${r.content}\n${r.url || ''}`).join('\n\n');
                }
              }
            } catch (e) { console.warn('Tavily failed:', e.message); }
          }
          break;

        case 'searxng':
          // SearXNG — 自托管或公共实例，JSON API
          try {
            const searxngUrl = (apiKeys.searxngBaseUrl || 'https://searx.be').replace(/\/+$/, '');
            const searxngResp = await fetch(searxngUrl + '/search?q=' + encodeURIComponent(query) + '&format=json&pageno=1', {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(15000)
            });
            if (searxngResp.ok) {
              const searxngData = await searxngResp.json();
              if (searxngData.results && searxngData.results.length > 0) {
                results = searxngData.results.slice(0, 5).map(r => `${r.title || ''}\n${r.content || ''}\n${r.url || ''}`).join('\n\n');
              }
            }
          } catch (e) { console.warn('SearXNG failed:', e.message); }
          break;

        case 'bocha':
        default:
          if (apiKeys.bochaApiKey) {
            try {
              const bochaResp = await fetch('https://api.bochaai.com/v1/web-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeys.bochaApiKey}` },
                body: JSON.stringify({ query, count: 5 }),
                signal: AbortSignal.timeout(15000)
              });
              if (bochaResp.ok) {
                const data = await bochaResp.json();
                if (data.data) console.log('Bocha data keys:', Object.keys(data.data).join(', '));
                
                if (data.data && data.data.webPages && data.data.webPages.value && data.data.webPages.value.length > 0) {
                  results = data.data.webPages.value.map(p => `${p.name}\n${p.snippet}\n${p.url || ''}`).join('\n\n');
                } else if (data.data && data.data.webPages && data.data.webPages.length > 0) {
                  results = data.data.webPages.map(p => `${p.name}\n${p.snippet}\n${p.url || ''}`).join('\n\n');
                } else if (data.data && data.data.news && data.data.news.length > 0) {
                  results = data.data.news.map(n => `${n.name}\n${n.snippet}`).join('\n\n');
                } else if (data.webPages && data.webPages.value && data.webPages.value.length > 0) {
                  results = data.webPages.value.map(p => `${p.name || p.title}\n${p.snippet || p.summary}\n${p.url || p.link || ''}`).join('\n\n');
                } else if (data.webPages && data.webPages.length > 0) {
                  results = data.webPages.map(p => `${p.name || p.title}\n${p.snippet || p.summary}\n${p.url || p.link || ''}`).join('\n\n');
                } else if (data.news && data.news.length > 0) {
                  results = data.news.map(n => `${n.name || n.title}\n${n.snippet || n.summary}`).join('\n\n');
                } else if (data.results && data.results.length > 0) {
                  results = data.results.map(r => `${r.title || r.name}\n${r.snippet || r.summary || r.content}\n${r.url || r.link || ''}`).join('\n\n');
                } else {
                  console.log('Bocha returned empty data, falling back to direct');
                }
              }
            } catch (e) { console.warn('Bocha failed:', e.message); }
          }
          break;
      }

      // 🔧 DuckDuckGo + Bing China 自动降级：当配置的引擎无结果或无 API Key 时，自动尝试免费搜索
      if ((!results || results.length < 10) && engine !== 'duckduckgo') {
        // 先试 DuckDuckGo
        try {
          console.log('Auto-fallback to DuckDuckGo...');
          const ddgScript = path.join(__dirname, 'scripts', 'search_ddg.py');
          const { spawn: spawnDdg2 } = require('child_process');
          const ddgProc2 = spawnDdg2('python', [ddgScript, '--query', query, '--max-results', '5'], { timeout: 20000 });
          let ddgOut2 = '', ddgErr2 = '';
          ddgProc2.stdout.on('data', d => ddgOut2 += d.toString());
          ddgProc2.stderr.on('data', d => ddgErr2 += d.toString());
          await new Promise((resolve) => ddgProc2.on('close', resolve));
          const ddgData2 = JSON.parse(ddgOut2.trim());
          if (ddgData2.success && ddgData2.results && ddgData2.results.length > 0) {
            results = ddgData2.results.map(r => `${r.title}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
          }
        } catch (e) { console.warn('DuckDuckGo fallback failed:', e.message); }

        // DuckDuckGo 也失败了，试 Bing China（国内可用）
        if (!results || results.length < 10) {
          try {
            console.log('Auto-fallback to Bing China...');
            const bingScript = path.join(__dirname, 'scripts', 'search_bing.py');
            const { spawn: spawnBing } = require('child_process');
            const bingProc = spawnBing('python', [bingScript, '--query', query, '--max-results', '5'], { timeout: 20000 });
            let bingOut = '', bingErr = '';
            bingProc.stdout.on('data', d => bingOut += d.toString());
            bingProc.stderr.on('data', d => bingErr += d.toString());
            await new Promise((resolve) => bingProc.on('close', resolve));
            const bingData = JSON.parse(bingOut.trim());
            if (bingData.success && bingData.results && bingData.results.length > 0) {
              results = bingData.results.map(r => `${r.title}\n${r.snippet}\n${r.url || ''}`).join('\n\n');
            }
          } catch (e) { console.warn('Bing China fallback failed:', e.message); }
        }
      }
      
      if (results && results.length > 10) {
        res.json({ results: results });
      } else {
        res.json({ error: 'No results', results: `Search for "${query}" found no valid results. Please configure a search API key in Settings for better results.` });
      }
      
    } catch (err) {
      console.error('Search backend error:', err.message);
      res.status(500).json({ error: err.message, results: `Search failed: ${err.message}` });
    }
  });

  // ===== 本地 TTS 端点（edge-tts，免费神经语音，无需 API Key）=====
  app2.post('/api/tts', async (req, res) => {
    try {
      const { text, voice = 'zh-CN-XiaoxiaoNeural', speed = 1.0 } = req.body;
      if (!text) return res.status(400).json({ success: false, error: '缺少文本' });

      const os = require('os');
      const outputFile = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
      const scriptPath = path.join(__dirname, 'scripts', 'tts_local.py');

      const { spawn: spawnPy } = require('child_process');
      const py = spawnPy('python', [
        scriptPath, '--text', text, '--voice', voice,
        '--speed', String(speed), '--output', outputFile
      ], { timeout: 30000 });

      let stdout = '', stderr = '';
      py.stdout.on('data', d => stdout += d.toString());
      py.stderr.on('data', d => stderr += d.toString());

      py.on('close', async (code) => {
        try {
          const result = JSON.parse(stdout.trim());
          if (result.success && result.file) {
            // 读取音频文件并返回
            const audioBuffer = fs.readFileSync(result.file);
            // 异步删除临时文件
            try { fs.unlinkSync(result.file); } catch (e) {}
            res.set({
              'Content-Type': 'audio/mpeg',
              'Content-Length': audioBuffer.length,
              'X-TTS-Engine': 'edge-tts',
              'X-TTS-Voice': voice
            });
            res.send(audioBuffer);
          } else {
            res.status(500).json({ success: false, error: result.error || 'TTS 失败' });
          }
        } catch (e) {
          console.error('TTS parse error:', stderr, stdout);
          res.status(500).json({ success: false, error: 'TTS 脚本输出解析失败: ' + e.message });
        }
      });

      py.on('error', (err) => {
        res.status(500).json({ success: false, error: 'Python 启动失败: ' + err.message });
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 获取可用 TTS 语音列表
  app2.get('/api/tts/voices', async (req, res) => {
    try {
      const scriptPath = path.join(__dirname, 'scripts', 'tts_local.py');
      const { spawn: spawnPy } = require('child_process');
      const py = spawnPy('python', [scriptPath, '--list-voices'], { timeout: 15000 });
      let stdout = '', stderr = '';
      py.stdout.on('data', d => stdout += d.toString());
      py.stderr.on('data', d => stderr += d.toString());
      py.on('close', () => {
        try {
          res.json(JSON.parse(stdout.trim()));
        } catch (e) {
          res.status(500).json({ success: false, error: '语音列表解析失败' });
        }
      });
      py.on('error', (err) => {
        res.status(500).json({ success: false, error: err.message });
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== Fish Speech 本地 TTS 端点（GPU 加速，支持声音克隆，s1-mini 模型）=====
  app2.post('/api/tts-fish', async (req, res) => {
    try {
      const { text, voice = 'default', speed = 1.0, reference_audio, reference_text } = req.body;
      if (!text) return res.status(400).json({ success: false, error: '缺少文本' });

      const os = require('os');
      const outputFile = path.join(os.tmpdir(), `fish_tts_${Date.now()}.wav`);
      const scriptPath = path.join(__dirname, 'scripts', 'tts_fishspeech.py');
      const fishEnv = 'E:\\fish-speech-env\\Scripts\\python.exe';

      const { spawn: spawnPy } = require('child_process');
      const args = [scriptPath, '--text', text, '--speed', String(speed), '--output', outputFile];
      if (voice && voice !== 'default') args.push('--voice', voice);
      if (reference_audio) args.push('--reference_audio', reference_audio);
      if (reference_text) args.push('--reference_text', reference_text);

      const py = spawnPy(fishEnv, args, { timeout: 300000 });

      let stdout = '', stderr = '';
      py.stdout.on('data', d => stdout += d.toString());
      py.stderr.on('data', d => { stderr += d.toString(); console.log('[fish-tts]', d.toString().trim()); });

      py.on('close', async (code) => {
        try {
          const result = JSON.parse(stdout.trim());
          if (result.success && result.file) {
            const audioBuffer = fs.readFileSync(result.file);
            try { fs.unlinkSync(result.file); } catch (e) {}
            res.set({
              'Content-Type': 'audio/wav',
              'Content-Length': audioBuffer.length,
              'X-TTS-Engine': 'fish-speech-s1-mini',
              'X-TTS-Voice': encodeURIComponent(voice || 'default')
            });
            res.send(audioBuffer);
          } else {
            res.status(500).json({ success: false, error: result.error || 'Fish TTS 失败' });
          }
        } catch (e) {
          console.error('Fish TTS parse error:', stderr, stdout);
          res.status(500).json({ success: false, error: 'Fish TTS 输出解析失败: ' + e.message });
        }
      });

      py.on('error', (err) => {
        res.status(500).json({ success: false, error: 'Fish TTS Python 启动失败: ' + err.message });
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fish Speech 音色列表
  app2.get('/api/tts-fish/voices', async (req, res) => {
    try {
      const scriptPath = path.join(__dirname, 'scripts', 'tts_fishspeech.py');
      const fishEnv = 'E:\\fish-speech-env\\Scripts\\python.exe';
      const { spawn: spawnPy } = require('child_process');
      const py = spawnPy(fishEnv, [scriptPath, '--list-voices'], { timeout: 15000 });
      let stdout = '', stderr = '';
      py.stdout.on('data', d => stdout += d.toString());
      py.stderr.on('data', d => stderr += d.toString());
      py.on('close', () => {
        try { res.json(JSON.parse(stdout.trim())); } catch (e) {
          res.status(500).json({ success: false, error: '音色列表解析失败' });
        }
      });
      py.on('error', (err) => { res.status(500).json({ success: false, error: err.message }); });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== VoxCPM2 TTS 端点（代理到本地 8084 持久化服务）=====
  const VOXCPM_PORT = 8084;

  app2.post('/api/tts-voxcpm', async (req, res) => {
    try {
      const { text, voice = 'default', speed = 1.0, reference_audio, reference_text, voice_design } = req.body;
      if (!text) return res.status(400).json({ success: false, error: '缺少文本' });

      const os = require('os');
      const outputFile = path.join(os.tmpdir(), `voxcpm_tts_${Date.now()}.wav`);

      // 转发到 VoxCPM 持久化服务
      const http = require('http');
      const postData = JSON.stringify({
        text, voice, speed, reference_audio, reference_text, voice_design,
        output: outputFile
      });

      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: VOXCPM_PORT,
        path: '/synthesize',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 300000
      }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success && result.file) {
              const audioBuffer = fs.readFileSync(result.file);
              try { fs.unlinkSync(result.file); } catch (e) {}
              res.set({
                'Content-Type': 'audio/wav',
                'Content-Length': audioBuffer.length,
                'X-TTS-Engine': 'voxcpm2',
                'X-TTS-Voice': encodeURIComponent(voice || 'default')
              });
              res.send(audioBuffer);
            } else {
              res.status(500).json({ success: false, error: result.error || 'VoxCPM TTS 失败' });
            }
          } catch (e) {
            res.status(500).json({ success: false, error: 'VoxCPM 响应解析失败: ' + e.message });
          }
        });
      });

      proxyReq.on('error', (err) => {
        res.status(503).json({ success: false, error: 'VoxCPM 服务未启动 (端口 ' + VOXCPM_PORT + '): ' + err.message });
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.status(504).json({ success: false, error: 'VoxCPM 合成超时' });
      });

      proxyReq.write(postData);
      proxyReq.end();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== VoxCPM2 流式 TTS 端点（边生成边传 PCM16，首包延迟低）=====
  app2.post('/api/tts-voxcpm/stream', async (req, res) => {
    try {
      const { text, voice = 'default', speed = 1.0, reference_audio, reference_text, voice_design } = req.body;
      if (!text) return res.status(400).json({ success: false, error: '缺少文本' });

      const http = require('http');
      const postData = JSON.stringify({ text, voice, speed, reference_audio, reference_text, voice_design });

      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: VOXCPM_PORT,
        path: '/synthesize_stream',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 300000
      }, (proxyRes) => {
        const ct = String(proxyRes.headers['content-type'] || '');
        if (ct.indexOf('application/json') !== -1) {
          // 上游返回 JSON（过期请求/错误），原样转发
          let data = '';
          proxyRes.on('data', c => data += c);
          proxyRes.on('end', () => {
            res.status(proxyRes.statusCode).set('Content-Type', 'application/json; charset=utf-8').send(data);
          });
          return;
        }
        // PCM16 字节流：透传采样率头并 pipe 流式转发
        res.status(proxyRes.statusCode);
        res.set('Content-Type', 'application/octet-stream');
        res.set('X-Sample-Rate', String(proxyRes.headers['x-sample-rate'] || '48000'));
        res.set('Access-Control-Allow-Origin', '*');
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.status(503).json({ success: false, error: 'VoxCPM 服务未启动 (端口 ' + VOXCPM_PORT + '): ' + err.message });
      });
      proxyReq.on('timeout', () => { proxyReq.destroy(); });

      // 客户端中止时，同步断开上游连接（避免 GPU 继续生成被抛弃的音频）
      req.on('close', () => { try { proxyReq.destroy(); } catch (e) {} });

      proxyReq.write(postData);
      proxyReq.end();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // VoxCPM 音色列表
  app2.get('/api/tts-voxcpm/voices', async (req, res) => {
    try {
      const http = require('http');
      http.get(`http://127.0.0.1:${VOXCPM_PORT}/voices`, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          try { res.json(JSON.parse(data)); } catch (e) {
            res.status(500).json({ success: false, error: '解析失败' });
          }
        });
      }).on('error', (err) => {
        res.status(503).json({ success: false, error: 'VoxCPM 服务未启动: ' + err.message });
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // VoxCPM 参考音频目录（零样本克隆音色存放处，与服务端 list_voices 保持一致）
  const VOXCPM_REF_DIR = 'E:/voxcpm-models/references';

  // 上传参考音频 → 新增克隆音色
  app2.post('/api/tts-voxcpm/voices/upload', async (req, res) => {
    try {
      const { name, ext = '.wav', dataBase64 } = req.body;
      if (!name || !dataBase64) return res.status(400).json({ success: false, error: '缺少 name 或 dataBase64' });
      // 清洗音色名：仅允许中文/字母/数字/下划线/连字符，防止路径穿越
      const safeName = String(name).replace(/[^\w\u4e00-\u9fa5\-]/g, '').trim();
      if (!safeName) return res.status(400).json({ success: false, error: '音色名无效（仅支持中文/字母/数字/-/_）' });
      const safeExt = ['.wav', '.mp3', '.flac', '.ogg', '.m4a'].includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : '.wav';
      if (!fs.existsSync(VOXCPM_REF_DIR)) fs.mkdirSync(VOXCPM_REF_DIR, { recursive: true });
      const audioBuffer = Buffer.from(String(dataBase64).replace(/^data:audio\/\w+;base64,/, ''), 'base64');
      if (audioBuffer.length < 1024) return res.status(400).json({ success: false, error: '音频数据过小，可能无效' });
      const outFile = path.join(VOXCPM_REF_DIR, safeName + safeExt);
      fs.writeFileSync(outFile, audioBuffer);
      res.json({ success: true, name: safeName, file: outFile, size: audioBuffer.length });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // 删除克隆音色（移入 .trash 子目录，非永久删除，可随时恢复）
  app2.post('/api/tts-voxcpm/voices/delete', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || name === 'default') return res.status(400).json({ success: false, error: '默认音色不可删除' });
      const safeName = String(name).replace(/[^\w\u4e00-\u9fa5\-]/g, '').trim();
      if (!safeName) return res.status(400).json({ success: false, error: '音色名无效' });
      const trashDir = path.join(VOXCPM_REF_DIR, '.trash');
      if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
      let moved = 0;
      for (const ext of ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.txt']) {
        const src = path.join(VOXCPM_REF_DIR, safeName + ext);
        if (fs.existsSync(src)) {
          fs.renameSync(src, path.join(trashDir, safeName + '_' + Date.now() + ext));
          moved++;
        }
      }
      if (moved === 0) return res.status(404).json({ success: false, error: '未找到该音色文件' });
      res.json({ success: true, moved });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // VoxCPM 健康检查
  app2.get('/api/tts-voxcpm/health', async (req, res) => {
    try {
      const http = require('http');
      http.get(`http://127.0.0.1:${VOXCPM_PORT}/health`, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          try { res.json(JSON.parse(data)); } catch (e) {
            res.status(500).json({ status: 'error' });
          }
        });
      }).on('error', () => {
        res.json({ status: 'offline', service: 'voxcpm-tts' });
      });
    } catch (err) { res.json({ status: 'offline' }); }
  });

  // ===== 本地 ASR 端点（faster-whisper，完全离线语音识别）=====
  app2.post('/api/asr', async (req, res) => {
    try {
      const { audio, model = 'base', language = 'zh' } = req.body;
      if (!audio) return res.status(400).json({ success: false, error: '缺少音频数据' });

      const os = require('os');
      // audio 是 base64 编码的音频数据
      const audioBase64 = audio.replace(/^data:audio\/\w+;base64,/, '');
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const inputFile = path.join(os.tmpdir(), `asr_${Date.now()}.webm`);
      fs.writeFileSync(inputFile, audioBuffer);

      const scriptPath = path.join(__dirname, 'scripts', 'asr_local.py');
      const { spawn: spawnPy } = require('child_process');
      const py = spawnPy('python', [
        scriptPath, '--input', inputFile, '--model', model, '--language', language
      ], { timeout: 60000 }); // ASR 可能需要更长时间

      let stdout = '', stderr = '';
      py.stdout.on('data', d => stdout += d.toString());
      py.stderr.on('data', d => stderr += d.toString());

      py.on('close', (code) => {
        // 清理临时文件
        try { fs.unlinkSync(inputFile); } catch (e) {}
        try {
          const result = JSON.parse(stdout.trim());
          res.json(result);
        } catch (e) {
          console.error('ASR parse error:', stderr.substring(0, 500), stdout.substring(0, 500));
          res.status(500).json({ success: false, error: 'ASR 脚本输出解析失败: ' + e.message });
        }
      });

      py.on('error', (err) => {
        try { fs.unlinkSync(inputFile); } catch (e) {}
        res.status(500).json({ success: false, error: 'Python 启动失败: ' + err.message });
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== ComfyUI 代理端点（状态检查 + 模型列表）=====
  app2.get('/api/comfyui/status', async (req, res) => {
    var baseUrl = 'http://127.0.0.1:8188';
    try {
      var resp = await fetch(baseUrl + '/system_stats', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        var data = await resp.json();
        res.json({
          online: true,
          gpu: (data.devices && data.devices[0]) ? {
            name: data.devices[0].name,
            vram_total: data.devices[0].vram_total,
            vram_free: data.devices[0].vram_free
          } : null
        });
      } else {
        res.json({ online: false });
      }
    } catch (e) {
      res.json({ online: false, error: e.message });
    }
  });

  app2.get('/api/comfyui/models', async (req, res) => {
    var baseUrl = 'http://127.0.0.1:8188';
    try {
      var resp = await fetch(baseUrl + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return res.json({ checkpoints: [], loras: [] });
      var data = await resp.json();
      var checkpoints = [];
      if (data.CheckpointLoaderSimple && data.CheckpointLoaderSimple.input && data.CheckpointLoaderSimple.input.required) {
        checkpoints = data.CheckpointLoaderSimple.input.required.ckpt_name[0] || [];
      }
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
      res.json({ checkpoints: checkpoints, loras: loras });
    } catch (e) {
      res.json({ checkpoints: [], loras: [], error: e.message });
    }
  });

  // ComfyUI 图片代理（查看生成的图片）
  app2.get('/api/comfyui/view', async (req, res) => {
    var baseUrl = 'http://127.0.0.1:8188';
    var filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: 'missing filename' });
    try {
      var url = baseUrl + '/view?filename=' + encodeURIComponent(filename)
        + '&subfolder=' + encodeURIComponent(req.query.subfolder || '')
        + '&type=' + encodeURIComponent(req.query.type || 'output');
      var resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return res.status(resp.status).json({ error: 'ComfyUI image fetch failed' });
      var contentType = resp.headers.get('content-type') || 'image/png';
      res.setHeader('Content-Type', contentType);
      var buffer = Buffer.from(await resp.arrayBuffer());
      res.send(buffer);
    } catch (e) {
      res.status(502).json({ error: 'ComfyUI 不可用: ' + e.message });
    }
  });

  // ComfyUI 提交任务代理（POST /api/comfyui/prompt）
  app2.post('/api/comfyui/prompt', async (req, res) => {
    var baseUrl = 'http://127.0.0.1:8188';
    try {
      var resp = await fetch(baseUrl + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(30000),
      });
      var data = await resp.json();
      res.status(resp.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'ComfyUI prompt 提交失败: ' + e.message });
    }
  });

  // ComfyUI 查询历史代理（GET /api/comfyui/history/:promptId）
  app2.get('/api/comfyui/history/:promptId', async (req, res) => {
    var baseUrl = 'http://127.0.0.1:8188';
    try {
      var resp = await fetch(baseUrl + '/history/' + req.params.promptId, {
        signal: AbortSignal.timeout(10000),
      });
      var data = await resp.json();
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: 'ComfyUI history 查询失败: ' + e.message });
    }
  });

  // 📱 移动端 Web API
  setupMobileRoutes(app2, DATA_ROOT);
}

module.exports = { registerApiRoutes };
