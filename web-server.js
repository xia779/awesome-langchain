// web-server.js - 移动端 Web 服务器模块
// 提供 REST API + SSE 流式聊天，直接读写 SQLite 和 JSON 配置文件
// 集成到 main.js 的 Express 服务器中

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const cryptoUtils = require('./modules/crypto-utils');
const ENC_PREFIX = cryptoUtils.ENC_PREFIX;
const SENSITIVE_KEY_FIELDS = cryptoUtils.SENSITIVE_KEY_FIELDS;
const encryptValue = cryptoUtils.encryptValue;
const decryptValue = cryptoUtils.decryptValue;

//  强制 temperature 在 JSON 中始终带小数点（DashScope 严格要求 Float 格式）
function _tempFloat(v) {
  var t = Number(v);
  if (!isFinite(t) || t < 0 || t > 2) t = 0.7;
  t = Math.round(t * 100) / 100;
  if (Number.isInteger(t)) {
    if (t >= 2) t = 1.999;
    else if (t <= 0) t = 0.001;
    else t += 0.001;
  }
  return t;
}

// ===== 常量 =====
const CLOUD_SERVICES = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', apiKeyField: 'deepseekKey', name: 'DeepSeek' },
  qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyField: 'qwenKey', name: '通义千问' },
  doubao:   { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyField: 'doubaoKey', name: '豆包' },
  silicon:  { baseURL: 'https://api.siliconflow.cn/v1', apiKeyField: 'siliconFlowKey', name: '硅基流动' },
  custom:   { baseURL: null, apiKeyField: 'customKey', name: '自定义' },
};

// ===== 数据库 =====
let db = null;
function getDB(dataRoot) {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(dataRoot, 'users', 'admin', 'ai-agent.db');
    if (!fs.existsSync(dbPath)) return null;
    db = new Database(dbPath, { readonly: false });
    db.pragma('journal_mode = WAL');
    return db;
  } catch (e) {
    console.warn('Web server: SQLite 不可用:', e.message);
    return null;
  }
}

// ===== 配置读写 =====
function loadConfig(dataRoot) {
  const configPath = path.join(dataRoot, 'users', 'admin', 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const field of SENSITIVE_KEY_FIELDS) {
      if (raw[field] && typeof raw[field] === 'string' && raw[field].startsWith(ENC_PREFIX)) {
        raw[field] = decryptValue(raw[field]);
      }
    }
    return raw;
  } catch (e) { return {}; }
}

function saveConfig(dataRoot, newConfig) {
  const configPath = path.join(dataRoot, 'users', 'admin', 'config.json');
  try {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const merged = { ...current, ...newConfig };
    const toSave = { ...merged };
    for (const field of SENSITIVE_KEY_FIELDS) {
      if (toSave[field] && typeof toSave[field] === 'string' && !toSave[field].startsWith(ENC_PREFIX)) {
        toSave[field] = encryptValue(toSave[field]);
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf8');
    return merged;
  } catch (e) {
    console.error('保存配置失败:', e.message);
    return null;
  }
}

// ===== 云端 API 流式调用 =====
async function callCloudAPIStream(config, provider, model, messages, temperature, onChunk, signal) {
  const svc = CLOUD_SERVICES[provider];
  if (!svc) throw new Error('不支持的提供商: ' + provider);
  let apiKey = config[svc.apiKeyField] || '';
  if (!apiKey) throw new Error('请填写 ' + svc.name + ' API Key');
  if (apiKey.startsWith('Bearer ')) apiKey = apiKey.substring(7);

  let baseURL = svc.baseURL;
  if (provider === 'custom') {
    baseURL = config.customBase || '';
    baseURL = baseURL.replace(/\/v1\/chat\/completions$/, '').replace(/\/chat\/completions$/, '');
    if (!baseURL.endsWith('/v1')) baseURL += '/v1';
  }
  let actualModel = model;
  if (provider === 'doubao') actualModel = config.doubaoModel || model;

  const resp = await fetch(baseURL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: actualModel, messages, temperature: _tempFloat(temperature), stream: true }),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('API 请求失败 (' + resp.status + '): ' + errText.substring(0, 300));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.substring(6));
          const content = data.choices?.[0]?.delta?.content || '';
          if (content) { fullText += content; onChunk(content, fullText); }
        } catch (e) { /* ignore parse errors */ }
      }
    }
  }
  return fullText;
}

// ===== Ollama 流式调用 =====
async function callOllamaStream(model, messages, temperature, onChunk, signal) {
  const resp = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'qwen2.5:7b', messages, stream: true,
      options: { temperature: _tempFloat(temperature) },
    }),
    signal,
  });
  if (!resp.ok) throw new Error('Ollama 请求失败 (' + resp.status + ')');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const content = data.message?.content || '';
        if (content) { fullText += content; onChunk(content, fullText); }
        if (data.done) return fullText;
      } catch (e) { /* ignore */ }
    }
  }
  return fullText;
}

// ===== ID 生成 =====
function generateId() {
  return Math.random().toString(36).substring(2, 12);
}

// ===== 注册路由 =====
function setupMobileRoutes(expressApp, dataRoot) {
  console.log('📱 移动端 Web 服务器初始化中...');
  const d = getDB(dataRoot);

  // 🔧 静态文件服务（修复 Cannot GET 问题）
  var publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    // 回退：尝试从 main.js 所在目录解析
    publicDir = path.join(path.dirname(require.main ? require.main.filename : __dirname), 'public');
  }
  console.log('📱 移动端静态文件目录:', publicDir, '存在:', fs.existsSync(publicDir));

  // 显式处理 /m 和 /m/ 路由（修复手机端 Cannot GET）
  expressApp.get('/m', function(req, res) {
    var indexFile = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      res.status(404).send('Mobile UI not found: ' + indexFile);
    }
  });
  expressApp.get('/m/', function(req, res) {
    var indexFile = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      res.status(404).send('Mobile UI not found: ' + indexFile);
    }
  });

  // 静态资源（CSS/JS/图片等）
  expressApp.use('/m', require('express').static(publicDir, { index: false }));

  // ===== AimangaStudio — AI 漫画/视频创作工具 =====
  var aimangaDir = path.join(publicDir, 'aimanga');
  if (fs.existsSync(aimangaDir)) {
    expressApp.get('/aimanga', function(req, res) {
      res.sendFile(path.join(aimangaDir, 'index.html'));
    });
    expressApp.get('/aimanga/', function(req, res) {
      res.sendFile(path.join(aimangaDir, 'index.html'));
    });
    expressApp.use('/aimanga', require('express').static(aimangaDir, { index: false }));
    console.log('🎨 AimangaStudio 已部署:', aimangaDir);
  } else {
    console.warn('⚠️ AimangaStudio 未找到:', aimangaDir);
  }

  // ===== ComfyUI 代理路由 =====
  var COMFYUI_URL = 'http://127.0.0.1:8188';
  expressApp.get('/api/comfyui/status', function(req, res) {
    fetch(COMFYUI_URL + '/system_stats', { signal: AbortSignal.timeout(5000) })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('status ' + r.status)); })
      .then(function(data) { res.json({ online: true, data: data }); })
      .catch(function(e) { res.json({ online: false, error: e.message }); });
  });
  expressApp.get('/api/comfyui/models', function(req, res) {
    fetch(COMFYUI_URL + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(5000) })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('status ' + r.status)); })
      .then(function(data) {
        res.json({ checkpoints: data.CheckpointLoaderSimple.input.required.ckpt_name[0] || [] });
      })
      .catch(function(e) { res.json({ checkpoints: [], error: e.message }); });
  });
  expressApp.get('/api/comfyui/view', function(req, res) {
    var url = COMFYUI_URL + '/view?' + new URLSearchParams(req.query).toString();
    fetch(url, { signal: AbortSignal.timeout(30000) })
      .then(function(r) {
        res.set('Content-Type', r.headers.get('content-type') || 'image/png');
        r.body.pipe(res);
      })
      .catch(function(e) { res.status(502).send('ComfyUI proxy error: ' + e.message); });
  });
  expressApp.post('/api/comfyui/prompt', function(req, res) {
    fetch(COMFYUI_URL + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) { res.json(data); })
      .catch(function(e) { res.status(502).json({ error: e.message }); });
  });
  expressApp.get('/api/comfyui/history/:promptId', function(req, res) {
    fetch(COMFYUI_URL + '/history/' + req.params.promptId, { signal: AbortSignal.timeout(10000) })
      .then(function(r) { return r.json(); })
      .then(function(data) { res.json(data); })
      .catch(function(e) { res.status(502).json({ error: e.message }); });
  });

  // ===== 会话列表 =====
  expressApp.get('/api/m/sessions', (req, res) => {
    try {
      if (!d) return res.json([]);
      const rows = d.prepare(
        'SELECT id, title, pinned, role_type, timestamp FROM sessions WHERE user_id = ? ORDER BY pinned DESC, timestamp DESC'
      ).all('admin');
      res.json(rows.map(r => ({
        id: r.id, title: r.title || '新会话', pinned: !!r.pinned,
        roleType: r.role_type || 'chat', timestamp: r.timestamp,
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 会话详情 + 消息 =====
  expressApp.get('/api/m/sessions/:id', (req, res) => {
    try {
      if (!d) return res.status(404).json({ error: '数据库不可用' });
      const sess = d.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
      if (!sess) return res.status(404).json({ error: '会话不存在' });
      const msgs = d.prepare(
        'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(req.params.id);
      res.json({
        id: sess.id, title: sess.title, pinned: !!sess.pinned,
        roleType: sess.role_type || 'chat', timestamp: sess.timestamp,
        messages: msgs.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 创建会话 =====
  expressApp.post('/api/m/sessions', (req, res) => {
    try {
      if (!d) return res.status(500).json({ error: '数据库不可用' });
      const id = generateId();
      const title = (req.body && req.body.title) || '新会话';
      const now = Date.now();
      d.prepare('INSERT INTO sessions (id, user_id, title, timestamp) VALUES (?, ?, ?, ?)')
        .run(id, 'admin', title, now);
      res.json({ id, title, timestamp: now });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 删除会话 =====
  expressApp.delete('/api/m/sessions/:id', (req, res) => {
    try {
      if (!d) return res.status(500).json({ error: '数据库不可用' });
      d.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.id);
      d.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 流式聊天 (SSE) =====
  const activeStreams = new Map();

  expressApp.post('/api/m/chat', async (req, res) => {
    const { sessionId, message, provider, model, temperature, systemPrompt } = req.body;
    if (!message) return res.status(400).json({ error: '缺少消息内容' });

    const config = loadConfig(dataRoot);
    const prov = provider || config.currentService || 'ollama';
    const mdl = model || config.ollamaModel || 'qwen2.5:7b';
    const temp = _tempFloat(temperature || config.temperature);

    // SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const streamId = generateId();
    const abortController = new AbortController();
    activeStreams.set(streamId, abortController);
    res.write('event: meta\ndata: ' + JSON.stringify({ streamId }) + '\n\n');

    try {
      // 确保会话存在
      let sessId = sessionId;
      if (d) {
        if (sessId) {
          const exists = d.prepare('SELECT id FROM sessions WHERE id = ?').get(sessId);
          if (!exists) {
            sessId = generateId();
            d.prepare('INSERT INTO sessions (id, user_id, title, timestamp) VALUES (?, ?, ?, ?)')
              .run(sessId, 'admin', message.substring(0, 20), Date.now());
          }
        } else {
          sessId = generateId();
          d.prepare('INSERT INTO sessions (id, user_id, title, timestamp) VALUES (?, ?, ?, ?)')
            .run(sessId, 'admin', message.substring(0, 20), Date.now());
        }
      }

      // 保存用户消息
      if (d) {
        d.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .run(sessId, 'user', message, Date.now());
      }

      // 构建消息历史
      const messages = [];
      const sysPrompt = systemPrompt || config.systemInstruction || '你是一个 helpful、honest、harmless 的 AI 助手。';
      messages.push({ role: 'system', content: sysPrompt });

      if (d && sessId) {
        const history = d.prepare(
          'SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT 20'
        ).all(sessId);
        for (const msg of history) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({ role: msg.role, content: msg.content });
          }
        }
      }
      // 确保最后一条是当前消息
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg || lastMsg.content !== message) {
        messages.push({ role: 'user', content: message });
      }

      res.write('event: session\ndata: ' + JSON.stringify({ sessionId: sessId }) + '\n\n');

      // 调用 API
      let fullText = '';
      const onChunk = (chunk, full) => {
        fullText = full;
        res.write('data: ' + JSON.stringify({ chunk, fullText: full }) + '\n\n');
      };

      if (prov === 'ollama') {
        await callOllamaStream(mdl, messages, temp, onChunk, abortController.signal);
      } else {
        await callCloudAPIStream(config, prov, mdl, messages, temp, onChunk, abortController.signal);
      }

      // 保存 AI 回复
      if (d && fullText) {
        d.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .run(sessId, 'assistant', fullText, Date.now());
      }

      res.write('event: done\ndata: ' + JSON.stringify({ sessionId: sessId }) + '\n\n');
    } catch (err) {
      console.error('Web chat error:', err.message);
      res.write('event: error\ndata: ' + JSON.stringify({ error: err.message }) + '\n\n');
    } finally {
      activeStreams.delete(streamId);
      res.end();
    }
  });

  // ===== 停止生成 =====
  expressApp.post('/api/m/chat/stop', (req, res) => {
    const streamId = req.body && req.body.streamId;
    const ctrl = activeStreams.get(streamId);
    if (ctrl) { ctrl.abort(); activeStreams.delete(streamId); }
    res.json({ success: true });
  });

  // ===== 配置 =====
  expressApp.get('/api/m/config', (req, res) => {
    const config = loadConfig(dataRoot);
    const safe = { ...config };
    for (const field of SENSITIVE_KEY_FIELDS) {
      if (safe[field]) {
        const val = safe[field];
        safe[field + '_set'] = !!val;
        safe[field] = val ? val.substring(0, 6) + '***' : '';
      }
    }
    res.json(safe);
  });

  expressApp.post('/api/m/config', (req, res) => {
    try {
      const updates = req.body || {};
      for (const field of SENSITIVE_KEY_FIELDS) delete updates[field];
      const config = loadConfig(dataRoot);
      const merged = saveConfig(dataRoot, { ...config, ...updates });
      res.json({ success: !!merged });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 网络信息（显示局域网 IP）=====
  expressApp.get('/api/m/network', (req, res) => {
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({ iface: name, address: net.address });
        }
      }
    }
    res.json({ addresses });
  });

  // ===== 文档处理 API =====

  // 读取文档内容
  expressApp.post('/api/m/doc/read', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

      const ext = path.extname(filePath).toLowerCase();
      let result = { success: false };

      if (ext === '.pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const pdfData = await pdfParse(fs.readFileSync(filePath));
          result = { success: true, text: pdfData.text, meta: { numPages: pdfData.numpages } };
        } catch (e) { result = { success: false, error: 'PDF 解析失败: ' + e.message }; }
      } else if (ext === '.docx' || ext === '.doc') {
        try {
          const mammoth = require('mammoth');
          const r = await mammoth.extractRawText({ path: filePath });
          result = { success: true, text: r.value };
        } catch (e) { result = { success: false, error: 'DOCX 解析失败: ' + e.message }; }
      } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
        try {
          const XLSX = require('xlsx');
          const wb = XLSX.readFile(filePath);
          let text = '';
          wb.sheetNames.forEach(function(name) {
            text += '== ' + name + ' ==\n' + XLSX.utils.sheet_to_csv(wb.Sheets[name]) + '\n\n';
          });
          result = { success: true, text: text.trim(), sheetNames: wb.sheetNames };
        } catch (e) { result = { success: false, error: 'XLSX 解析失败: ' + e.message }; }
      } else if (ext === '.txt' || ext === '.md') {
        result = { success: true, text: fs.readFileSync(filePath, 'utf8') };
      } else {
        result = { success: false, error: '不支持的格式: ' + ext };
      }

      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 生成文档
  expressApp.post('/api/m/doc/generate', async (req, res) => {
    try {
      const { format, title, content } = req.body;
      if (!format) return res.status(400).json({ error: '缺少格式参数' });

      const docDir = path.join(dataRoot, 'documents');
      if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });
      const safeTitle = (title || '文档').replace(/[\\/:*?"<>|]/g, '_');

      if (format === 'pdf') {
        const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        let page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText(safeTitle, { x: 50, y: 780, size: 18, font, color: rgb(0.1, 0.1, 0.3) });
        const lines = (content || '').split('\n');
        let y = 740;
        for (const line of lines) {
          if (y < 60) { page = pdfDoc.addPage([595.28, 841.89]); y = 780; }
          page.drawText(line.substring(0, 80), { x: 50, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
          y -= 18;
        }
        const bytes = await pdfDoc.save();
        const outPath = path.join(docDir, safeTitle + '.pdf');
        fs.writeFileSync(outPath, bytes);
        res.json({ success: true, path: outPath, size: bytes.length });
      } else if (format === 'xlsx') {
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new();
        const lines = (content || '').split('\n').filter(l => l.trim());
        const data = lines.map(l => l.split(/[,\t|]/).map(c => c.trim()));
        const ws = XLSX.utils.aoa_to_sheet(data.length ? data : [['空表格']]);
        XLSX.utils.book_append_sheet(wb, ws, safeTitle);
        const outPath = path.join(docDir, safeTitle + '.xlsx');
        XLSX.writeFile(wb, outPath);
        res.json({ success: true, path: outPath, size: fs.statSync(outPath).size });
      } else {
        res.status(400).json({ error: '不支持的格式: ' + format + '（支持 pdf/xlsx）' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 跨端同步 API =====
  // POST /api/m/sync/push — 接收其他设备的变更
  expressApp.post('/api/m/sync/push', express.json({ limit: '10mb' }), (req, res) => {
    try {
      const database = getDB(dataRoot);
      if (!database) return res.status(500).json({ success: false, error: 'DB unavailable' });

      const { deviceId, changes } = req.body || {};
      if (!deviceId) return res.status(400).json({ success: false, error: 'Missing deviceId' });
      if (!changes) return res.status(400).json({ success: false, error: 'Missing changes' });

      var applied = { sessions: 0, memories: 0, config: false };

      // 应用会话（last-write-wins by timestamp）
      if (changes.sessions && Array.isArray(changes.sessions)) {
        changes.sessions.forEach(function(s) {
          try {
            var existing = database.prepare('SELECT timestamp FROM sessions WHERE id = ?').get(s.id);
            if (!existing || (s.timestamp || 0) > (existing.timestamp || 0)) {
              database.prepare(
                'INSERT OR REPLACE INTO sessions (id, user_id, title, parent_id, pinned, role_type, timestamp, created_at) VALUES (?,?,?,?,?,?,?,?)'
              ).run(s.id, s.userId || 'admin', s.title || '', s.parentId || null, s.pinned ? 1 : 0, s.roleType || 'normal', s.timestamp || Date.now(), s.createdAt || Date.now());

              // 写入消息（增量）
              if (s.messages && s.messages.length > 0) {
                var existingCount = database.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(s.id);
                var skip = existingCount ? existingCount.c : 0;
                var insertMsg = database.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)');
                for (var i = skip; i < s.messages.length; i++) {
                  insertMsg.run(s.id, s.messages[i].role, s.messages[i].content, s.messages[i].timestamp || Date.now());
                }
              }
              applied.sessions++;
            }
          } catch (e) {}
        });
      }

      // 应用记忆
      if (changes.memories && Array.isArray(changes.memories)) {
        changes.memories.forEach(function(m) {
          try {
            database.prepare('INSERT OR IGNORE INTO memories (id, user_id, content, tags, created_at) VALUES (?,?,?,?,?)')
              .run(m.id, m.user_id || 'admin', m.content, m.tags || '', m.created_at || Date.now());
            applied.memories++;
          } catch (e) {}
        });
      }

      // 应用配置（合并到 SQLite config 表）
      if (changes.config && typeof changes.config === 'object') {
        Object.keys(changes.config).forEach(function(key) {
          try {
            database.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?,?,?)')
              .run('admin:' + key, JSON.stringify(changes.config[key]), Date.now());
          } catch (e) {}
        });
        applied.config = true;
      }

      res.json({ success: true, applied: applied, serverTime: Date.now() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // GET /api/m/sync/pull?since=timestamp&device=xxx — 返回自 since 以来的变更
  expressApp.get('/api/m/sync/pull', (req, res) => {
    try {
      const database = getDB(dataRoot);
      if (!database) return res.status(500).json({ success: false, error: 'DB unavailable' });

      var since = parseInt(req.query.since) || 0;
      var data = { sessions: [], memories: [], config: null };

      // 会话变更
      var sessions = database.prepare('SELECT * FROM sessions WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 50').all(since);
      sessions.forEach(function(s) {
        var msgs = database.prepare('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC').all(s.id);
        data.sessions.push({
          id: s.id, userId: s.user_id, title: s.title, parentId: s.parent_id,
          pinned: s.pinned, roleType: s.role_type, timestamp: s.timestamp, createdAt: s.created_at,
          messages: msgs
        });
      });

      // 记忆变更
      try {
        var cols = database.prepare("PRAGMA table_info(memories)").all();
        var hasUpdated = cols.some(function(c) { return c.name === 'updated_at'; });
        var memSql = hasUpdated
          ? 'SELECT * FROM memories WHERE updated_at > ? LIMIT 100'
          : 'SELECT * FROM memories WHERE created_at > ? LIMIT 100';
        data.memories = database.prepare(memSql).all(since);
      } catch (e) {}

      res.json({ success: true, data: data, serverTime: Date.now() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  console.log('📱 移动端 Web API 已就绪（含同步端点）');
}

module.exports = { setupMobileRoutes };
