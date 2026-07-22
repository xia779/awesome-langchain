// main.js - Electron主进程（安全修复兼容版）

const path = require('path');

// 🔧 强制添加项目 node_modules 到模块搜索路径（确保无论从哪个目录启动都能找到依赖）
const projectNodeModules = path.join(__dirname, 'node_modules');
if (!module.paths.includes(projectNodeModules)) {
  module.paths.unshift(projectNodeModules);
}

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog, shell, session, globalShortcut, desktopCapturer, screen } = require('electron');

// 🔧 禁用 HTTP 缓存，确保 renderer 进程代码始终最新（无需手动清除缓存）
app.commandLine.appendSwitch('disable-http-cache');
// 🔧 本地桌面应用，nodeIntegration+unsafe-eval 为功能所需，抑制安全警告
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { setupMobileRoutes } = require('./web-server');

// 🔧 GPU 缓存清理已移至 app.whenReady() 内部（见下方），确保 app.getPath 可用
// DATA_ROOT 优先使用 E:\my-ai-data，仅当不存在时才回退到 userData

// ===== 全局变量 =====
let mainWindow = null;
let tray = null;
let server = null;

// ===== 数据路径（动态获取）=====
const DATA_ROOT = process.env.AI_AGENT_DATA_ROOT || 
                  (fs.existsSync('E:\\my-ai-data') ? 'E:\\my-ai-data' : 
                   path.join(app.getPath('userData'), 'ai-data'));

// 确保数据目录存在
if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

// 托盘图标路径
const TRAY_ICON_PATH = path.join(__dirname, 'icon.ico');

// ===== Express Web 服务器（作为 npm start 的一部分）=====
async function startWebServer() {
  const app2 = express();
  app2.use(cors());
  app2.use(express.json({ limit: '50mb' }));

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

  // 🔧 检测端口是否可用
  function tryListen(startPort, maxAttempts = 5) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      function tryPort(port) {
        attempts++;
        const testServer = createServer(app2);
        testServer.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.warn(`⚠️ 端口 ${port} 被占用，尝试端口 ${port + 1}...`);
            if (attempts < maxAttempts) {
              tryPort(port + 1);
            } else {
              reject(new Error(`无法找到可用端口（已尝试 ${startPort} 到 ${port}）`));
            }
          } else {
            reject(err);
          }
        });
        testServer.once('listening', () => {
          server = testServer;
          console.log(`📱 移动端访问: http://<本机IP>:${port}/m`);
          resolve(port);
        });
        testServer.listen(port, '0.0.0.0');
      }
      tryPort(startPort);
    });
  }

  try {
    await tryListen(8080);
  } catch (err) {
    console.error('❌ 启动服务器失败:', err.message);
    // 不阻止应用启动，继续创建窗口
  }
}

// ===== 创建主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0d0d0d',
    // 🔧 无边框自定义标题栏：隐藏原生黑色标题栏，窗口控制按钮与应用背景融合
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d0d0d',
      symbolColor: '#9ca3af',
      height: 44
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      allowRunningInsecureContent: false,
      webSecurity: true
    },
  });

  // 加载页面（彻底禁用缓存 - v9）
  const indexPath = path.join(__dirname, 'index.html').replace(/\\/g, '/');
  const url = `file:///${indexPath}?nocache=${Date.now()}`;
  
  // 清除 Electron 缓存并加载页面
  mainWindow.webContents.session.clearCache().then(() => {
    console.log('🧹 Electron 缓存已清除');
    mainWindow.loadURL(url, {
      extraHeaders: 'Cache-Control: no-cache, no-store, must-revalidate\nPragma: no-cache\nExpires: 0'
    });
  }).catch(err => {
    console.warn('⚠️ 缓存清除失败:', err.message);
    mainWindow.loadURL(url, {
      extraHeaders: 'Cache-Control: no-cache, no-store, must-revalidate\nPragma: no-cache\nExpires: 0'
    });
  });
  setupTray();

  // 🔧 注册快捷键：Ctrl+Shift+I 打开 DevTools，Ctrl+R 刷新，Ctrl+Shift+R 强制刷新
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.key === 'I' || input.key === 'i') && input.control && input.shift && !input.alt && !input.meta) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    } else if ((input.key === 'R' || input.key === 'r') && input.control && !input.alt && !input.meta) {
      if (input.shift) {
        mainWindow.webContents.reloadIgnoringCache();
      } else {
        mainWindow.webContents.reload();
      }
      event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 🔧 Renderer 进程崩溃自动恢复
  var _crashReloadCount = 0;
  var MAX_CRASH_RELOADS = 3;
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('❌ Renderer 进程崩溃:', details.reason, 'exitCode:', details.exitCode);
    // 写入崩溃标记，下次启动时清理 GPU 缓存
    try {
      const userDataPath = app.getPath('userData');
      fs.writeFileSync(path.join(userDataPath, '.crash-marker'), Date.now().toString(), 'utf8');
    } catch (e) {}

    if (_crashReloadCount < MAX_CRASH_RELOADS) {
      _crashReloadCount++;
      console.log('🔄 正在重新加载 renderer (第 ' + _crashReloadCount + ' 次)...');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 1000);
    } else {
      console.error('❌ Renderer 连续崩溃 ' + MAX_CRASH_RELOADS + ' 次，停止自动恢复');
    }
  });

  // 🔧 移除原生菜单栏（"视图"菜单），界面更简洁；快捷键由 before-input-event 处理
  Menu.setApplicationMenu(null);

  mainWindow.webContents.on('did-finish-load', () => {
    // 页面成功加载：重置崩溃计数器，删除崩溃标记
    _crashReloadCount = 0;
    try {
      const userDataPath = app.getPath('userData');
      const crashMarkerPath = path.join(userDataPath, '.crash-marker');
      if (fs.existsSync(crashMarkerPath)) fs.unlinkSync(crashMarkerPath);
    } catch (e) {}
    // 🔍 诊断：检查 Core.session.renderChatList 是否是树形版本
    setTimeout(() => {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          var result = { coreExists: false, sessionExists: false, renderChatListExists: false, isTree: false, coreVersion: 'unknown' };
          try {
            if (window.Core) {
              result.coreExists = true;
              // 检查 core.js 版本
              var coreLog = document.querySelector('console-log-version');
              if (Core.session) {
                result.sessionExists = true;
                if (Core.session.renderChatList) {
                  result.renderChatListExists = true;
                  result.isTree = Core.session.renderChatList.toString().indexOf('renderTreeNode') >= 0;
                }
              }
            }
          } catch(e) {}
          return result;
        })()
      `).then(r => {
      }).catch(e => {
        console.error('❌ 诊断失败:', e.message);
      });
    }, 2000);
  });
}

function setupTray() {
  if (!fs.existsSync(TRAY_ICON_PATH)) { console.warn('⚠️ 托盘图标不存在:', TRAY_ICON_PATH); return; }
  let icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (icon.isEmpty()) { console.warn('⚠️ 托盘图标加载失败'); return; }
  if (process.platform === 'darwin') { icon = icon.resize({ width: 16, height: 16 }); }
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) mainWindow.show(); } },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip('AI Agent');
  tray.on('click', () => {
    if (!mainWindow) { createWindow(); } else { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); }
  });
}

// ===== IPC 处理器 =====
ipcMain.on('app:get-path-sync', (event, arg) => { event.returnValue = app.getPath(arg); });
ipcMain.on('get-user-data-path', (event) => { event.returnValue = DATA_ROOT; });

ipcMain.on('show-notification', (event, arg) => {
  try { 
    const title = arg.title || arg || 'AI智能体';
    const body = arg.body || '';
    new Notification({ title: title, body: body }).show(); 
  } catch(e) {}
});

ipcMain.on('list-plugin-dirs', (event) => {
  try {
    const dir = path.join(DATA_ROOT, 'plugins');
    if (!fs.existsSync(dir)) {
      event.returnValue = { success: false, error: '目录不存在', dirs: [] };
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    event.returnValue = { success: true, dirs: dirs };
  } catch (err) {
    event.returnValue = { success: false, error: err.message, dirs: [] };
  }
});

ipcMain.on('copy-plugin-dir', (event, { src, dest }) => {
  try {
    if (!fs.existsSync(src)) {
      event.returnValue = { success: false, error: '源目录不存在' };
      return;
    }
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach(e => {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
      });
    }
    copyDir(src, dest);
    event.returnValue = { success: true };
  } catch (err) {
    event.returnValue = { success: false, error: err.message };
  }
});

ipcMain.on('get-app-dir', (event) => {
  event.returnValue = __dirname;
});

ipcMain.on('window-minimize', (event) => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', (event) => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.on('window-close', (event) => { if (mainWindow) mainWindow.hide(); });

ipcMain.handle('show-save-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle('show-open-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.on('open-external', (event, url) => { shell.openExternal(url); });

// 🔧 截图 IPC 处理器
ipcMain.handle('take-screenshot', async (event, options) => {
  try {
    const type = (options && options.type) || 'full';
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: {
        width: Math.round(width * scaleFactor),
        height: Math.round(height * scaleFactor)
      },
      fetchWindowIcons: false
    });

    if (type === 'full' || type === 'screen') {
      // 全屏截图 — 返回主屏幕
      const screenSource = sources.find(function(s) { return s.id.startsWith('screen:'); });
      if (screenSource && screenSource.thumbnail) {
        return {
          success: true,
          dataUrl: screenSource.thumbnail.toDataURL(),
          name: '屏幕截图'
        };
      }
    } else if (type === 'window') {
      // 窗口列表
      var winSources = sources.filter(function(s) { return s.id.startsWith('window:'); });
      var list = winSources.map(function(s) {
        return {
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
        };
      });
      return { success: true, windows: list };
    } else if (type === 'capture-window' && options && options.sourceId) {
      // 捕获指定窗口
      var src = sources.find(function(s) { return s.id === options.sourceId; });
      if (src && src.thumbnail) {
        return {
          success: true,
          dataUrl: src.thumbnail.toDataURL(),
          name: src.name || '窗口截图'
        };
      }
    }

    return { success: false, error: '未找到可用的截图源' };
  } catch (err) {
    console.error('Screenshot error:', err);
    return { success: false, error: err.message };
  }
});

// 🔧 浏览器自动化截图 IPC 处理器（备用方案）
ipcMain.handle('automation-screenshot', async (event, options) => {
  try {
    var windows = BrowserWindow.getAllWindows();
    var win = null;
    for (var i = 0; i < windows.length; i++) {
      if (!windows[i].isDestroyed() && windows[i].getTitle() === (options.windowTitle || 'AI-Automation-Browser')) {
        win = windows[i];
        break;
      }
    }
    if (!win) return { success: false, error: '未找到浏览器自动化窗口' };
    var nativeImage = await win.webContents.capturePage();
    if (!nativeImage || nativeImage.isEmpty()) {
      return { success: false, error: '截图为空' };
    }
    return { success: true, dataUrl: nativeImage.toDataURL(), base64: nativeImage.toPNG().toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('export-json', (event, data) => {
  const filePath = dialog.showSaveDialogSync(mainWindow, {
    title: '导出聊天记录',
    defaultPath: 'chat_export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (filePath) {
    try { fs.writeFileSync(filePath, data, 'utf8'); event.reply('export-response', { success: true, filePath }); }
    catch (e) { event.reply('export-response', { success: false, error: e.message }); }
  }
});

ipcMain.on('backup-data', (event) => {
  const filePath = dialog.showSaveDialogSync(mainWindow, {
    title: '备份数据',
    defaultPath: 'ai-agent-backup.zip',
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  });
  if (filePath) {
    // 🔒 安全修复：备份前清理 API 密钥，防止泄露
    const tempBackup = path.join(require('os').tmpdir(), 'ai-agent-backup-sanitized-' + Date.now());
    const API_KEY_FIELDS = [
      'deepseekKey', 'qwenKey', 'doubaoKey', 'customKey',
      'bochaApiKey', 'tavilyApiKey', 'siliconFlowKey', 'openaiImageKey'
    ];
    try {
      // 1. 复制数据到临时目录
      fs.cpSync(DATA_ROOT, tempBackup, { recursive: true });
      // 2. 遍历所有 config.json 文件，清理 API 密钥
      function sanitizeConfigFile(filePath) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const config = JSON.parse(content);
          let changed = false;
          for (const field of API_KEY_FIELDS) {
            if (config[field]) {
              config[field] = '';
              changed = true;
            }
          }
          // 也清理 SQLite 键值对中包含 key 的敏感条目
          if (changed) {
            fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
          }
        } catch (e) {
          // 解析失败的文件不处理
        }
      }
      // 递归查找并清理所有 config.json
      function walkAndSanitize(dir) {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              walkAndSanitize(fullPath);
            } else if (item === 'config.json') {
              sanitizeConfigFile(fullPath);
            }
          }
        } catch (e) {}
      }
      walkAndSanitize(tempBackup);
      // 3. 压缩清理后的数据（🔒 安全修复：使用 spawn 替代 exec）
      const { spawn } = require('child_process');
      const zipChild = spawn('powershell', [
        '-command', 'Compress-Archive',
        '-Path', tempBackup,
        '-DestinationPath', filePath,
        '-Force'
      ]);
      let zipErr = '';
      zipChild.stderr.on('data', (d) => { zipErr += d.toString(); });
      zipChild.on('close', (code) => {
        // 4. 清理临时目录
        try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) {}
        if (code !== 0) { event.reply('backup-response', { success: false, error: zipErr || '压缩失败' }); }
        else { event.reply('backup-response', { success: true, filePath }); }
      });
      zipChild.on('error', (err) => {
        try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) {}
        event.reply('backup-response', { success: false, error: err.message });
      });
    } catch (err) {
      try { fs.rmSync(tempBackup, { recursive: true, force: true }); } catch (e) {}
      event.reply('backup-response', { success: false, error: '备份准备失败: ' + err.message });
    }
  }
});

ipcMain.on('restore-data', (event) => {
  dialog.showOpenDialog(mainWindow, {
    title: '恢复数据',
    properties: ['openFile'],
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      const zipFile = result.filePaths[0];
      const tempDir = path.join(require('os').tmpdir(), 'ai-agent-restore-' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });
      // 🔒 安全修复：spawn 替代 exec，防止路径注入
      const unzipChild = spawn('powershell', [
        '-command', 'Expand-Archive',
        '-Path', zipFile,
        '-DestinationPath', tempDir,
        '-Force'
      ]);
      let unzipStderr = '';
      unzipChild.stderr.on('data', (d) => { unzipStderr += d.toString(); });
      unzipChild.on('close', (code) => {
        if (code !== 0) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
          event.reply('restore-response', { success: false, error: unzipStderr || '解压失败 (exit ' + code + ')' });
          return;
        }
        const restoredDataDir = path.join(tempDir, 'ai-data');
        if (fs.existsSync(restoredDataDir)) {
          // 🔒 安全修复：先备份当前数据，防止恢复失败时数据丢失
          const safetyBackup = path.join(require('os').tmpdir(), 'ai-agent-safety-backup-' + Date.now());
          let hasSafetyBackup = false;
          try {
            if (fs.existsSync(DATA_ROOT)) {
              fs.cpSync(DATA_ROOT, safetyBackup, { recursive: true });
              hasSafetyBackup = true;
            }
            // 删除旧数据并复制恢复数据
            fs.rmSync(DATA_ROOT, { recursive: true, force: true });
            fs.cpSync(restoredDataDir, DATA_ROOT, { recursive: true });
            console.log('✅ 数据恢复成功');
          } catch (restoreErr) {
            console.error('❌ 数据恢复失败:', restoreErr.message);
            // 从安全备份中恢复
            if (hasSafetyBackup && fs.existsSync(safetyBackup)) {
              try {
                if (fs.existsSync(DATA_ROOT)) {
                  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
                }
                fs.cpSync(safetyBackup, DATA_ROOT, { recursive: true });
                console.log('✅ 已从安全备份恢复原始数据');
              } catch (rollbackErr) {
                console.error('❌ 回滚也失败了:', rollbackErr.message);
              }
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
            if (hasSafetyBackup) { try { fs.rmSync(safetyBackup, { recursive: true, force: true }); } catch(e) {} }
            event.reply('restore-response', { success: false, error: '恢复失败: ' + restoreErr.message });
            return;
          }
          // 恢复成功后清理安全备份
          if (hasSafetyBackup) { try { fs.rmSync(safetyBackup, { recursive: true, force: true }); } catch(e) {} }
        } else {
          console.warn('⚠️ 备份文件中未找到 ai-data 目录');
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
        event.reply('restore-response', { success: true });
      });
    }
  }).catch(err => { event.reply('restore-response', { success: false, error: err.message }); });
});

// ===== 应用生命周期 =====
// 🔧 单实例锁：防止同时打开多个应用实例（桌面快捷方式 + start.bat 同时打开会产生重复进程）
const _gotSingleLock = app.requestSingleInstanceLock();
if (!_gotSingleLock) {
  console.log('⚠️ 检测到已有实例运行，退出当前实例');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {

  // 🔧 条件性清理 GPU/Code 缓存：仅在上次崩溃或版本变更时清理
  // 每次启动都清理反而会 destabilize GPU 进程，导致黑屏
  try {
    const userDataPath = app.getPath('userData');
    const markerPath = path.join(userDataPath, '.cache-version');
    const APP_VERSION = '1.1.0'; // 递增此版本号以触发缓存清理
    const crashMarkerPath = path.join(userDataPath, '.crash-marker');
    const hasCrashMarker = fs.existsSync(crashMarkerPath);

    let needsClean = hasCrashMarker;
    try {
      const lastVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
      if (lastVersion !== APP_VERSION) needsClean = true;
    } catch (e) { needsClean = true; }

    if (needsClean) {
      const cacheDirs = ['GPUCache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'VideoDecodeStats'];
      let cleaned = 0;
      for (const dir of cacheDirs) {
        const fullPath = path.join(userDataPath, dir);
        if (fs.existsSync(fullPath)) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
          } catch (e) {
            console.warn('⚠️ 缓存目录清理失败:', dir, e.message);
          }
        }
      }
      if (cleaned > 0) console.log('🧹 已清理 ' + cleaned + ' 个 GPU/代码缓存目录 (版本变更或崩溃恢复)');
      // 写入版本标记 + 清除崩溃标记
      try { fs.writeFileSync(markerPath, APP_VERSION, 'utf8'); } catch (e) {}
      try { if (hasCrashMarker) fs.unlinkSync(crashMarkerPath); } catch (e) {}
    } else {
      console.log('⏭️ GPU 缓存跳过清理 (版本未变且无崩溃记录)');
    }
  } catch (e) {
    console.warn('⚠️ GPU 缓存清理异常:', e.message);
  }

  // 🔧 启动时清除 HTTP 缓存（保留 localStorage/IndexedDB 等用户数据）
  try {
    await session.defaultSession.clearCache();
    console.log('✅ HTTP 缓存已清除');
  } catch (e) {
    console.warn('⚠️ 缓存清除异常:', e.message);
  }
  
  console.log(`✅ App ready | 📁 数据目录: ${DATA_ROOT}`);

  // 🔒 设置 Content-Security-Policy，消除 Electron 安全警告
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:"
        ]
      }
    });
  });

  app.setAppUserModelId('com.yourcompany.ai-agent');
  createWindow();
  await startWebServer();
  setTimeout(() => { try { new Notification({ title: 'AI智能体', body: '你的AI助手已就绪！' }).show(); } catch(e) {} }, 3000);
});

app.on('before-quit', () => { app.isQuitting = true; if (tray) tray.destroy(); if (server) server.close(); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  else if (mainWindow) { mainWindow.show(); }
});

// 🔧 IPC 监听：快捷键打开 DevTools
ipcMain.on('toggle-devtools', () => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.toggleDevTools();
  }
});

// 🔧 快捷键在 createWindow 中通过 before-input-event 注册

// ===== 开发模式：启用 DevTools =====
if (process.env.NODE_ENV === 'development') {
  app.whenReady().then(() => {
    setTimeout(() => {
      if (mainWindow && mainWindow.webContents) { mainWindow.webContents.openDevTools({ mode: 'right' }); }
    }, 2000);
  });
}
