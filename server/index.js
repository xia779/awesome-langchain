// server/index.js — AI Agent Pro backend entry point
// HTTP server for health checks + WebSocket server for client communication
const http = require('http');
const { WebSocketServer } = require('ws');
const Core = require('./core');
const PROTOCOL = require('./protocol');
const { createRouter } = require('./ws-router');
const path = require('path');

const PORT = parseInt(process.env.AI_SERVER_PORT || '3847', 10);
// 🔒 默认仅监听本地 127.0.0.1，局域网访问需显式设置 AI_SERVER_HOST=0.0.0.0
const HOST = process.env.AI_SERVER_HOST || '127.0.0.1';

// ===== Initialize Core =====
Core.loadConfig('admin');
Core.log('Data root:', Core.DATA_ROOT);

// ===== Create router =====
var router = createRouter(Core);
Core.router = router;

// ===== Load server modules =====
function loadModules() {
  var modDir = path.join(__dirname, 'modules');
  var fs = require('fs');
  if (!fs.existsSync(modDir)) {
    Core.warn('No modules directory found at:', modDir);
    return;
  }
  var files = fs.readdirSync(modDir).filter(function(f) { return f.endsWith('.js'); });

  // Simple dependency-respecting loader
  var loaded = {};
  var pending = {};
  var failed = {};

  function loadModule(name) {
    if (loaded[name]) return loaded[name];
    if (failed[name]) return null;
    if (pending[name]) {
      Core.warn('Circular dependency:', name);
      return null;
    }
    pending[name] = true;
    var fp = path.join(modDir, name + '.js');
    if (!fs.existsSync(fp)) {
      Core.warn('Module not found:', name);
      delete pending[name];
      failed[name] = true;
      return null;
    }
    var mod;
    try {
      mod = require(fp);
    } catch (e) {
      console.error('Failed to require', name + ':', e.message);
      delete pending[name];
      failed[name] = true;
      return null;
    }

    // Load dependencies first
    if (mod.dependencies) {
      mod.dependencies.forEach(function(dep) {
        if (!loaded[dep]) loadModule(dep);
      });
    }

    if (typeof mod.init === 'function') {
      try {
        mod.init(Core, router);
      } catch (e) {
        console.error('Failed to init', name + ':', e.message);
        delete pending[name];
        failed[name] = true;
        return null;
      }
    }
    loaded[name] = mod;
    delete pending[name];
    Core.log('Module loaded:', mod.name || name);
    return mod;
  }

  files.forEach(function(f) {
    var name = f.replace('.js', '');
    try { loadModule(name); }
    catch (e) { console.error('Failed to load', name + ':', e.message); }
  });

  Core.log('Loaded', Object.keys(loaded).length, 'modules');
}

loadModules();

// ===== Register built-in handlers =====

// system.status
router.handle(PROTOCOL.SYSTEM_STATUS, function() {
  return {
    version: PROTOCOL.VERSION,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    modules: Object.keys(Core._modules),
    clients: router.getClients().size
  };
});

// config.get
router.handle(PROTOCOL.CONFIG_GET, function() {
  // Filter out sensitive keys
  var safe = {};
  var sensitive = ['apiKey', 'apiSecret', 'openaiKey', 'deepseekKey', 'qwenKey'];
  Object.keys(Core.config).forEach(function(k) {
    if (sensitive.indexOf(k) === -1) {
      safe[k] = Core.config[k];
    } else {
      safe[k] = Core.config[k] ? '***configured***' : '';
    }
  });
  return { config: safe };
});

// config.set
router.handle(PROTOCOL.CONFIG_SET, function(payload) {
  if (payload && payload.delta) {
    Core.saveConfig(payload.delta);
    router.broadcast(PROTOCOL.EVENT_CONFIG, { delta: payload.delta });
  }
  return { success: true };
});

// auth.login — switch user and load their data
router.handle('auth.login', function(payload) {
  var userId = (payload && payload.userId) || 'admin';
  var dbApi = Core.getModule('db');
  if (!dbApi) return { success: false, error: '数据库未初始化' };
  dbApi.switchUser(userId);
  Core.loadConfig(userId);
  var sessions = dbApi.listSessions ? Core.getModule('session').list() : [];
  return { success: true, userId: userId, sessions: sessions || [] };
});

// auth.listUsers — return available user accounts
router.handle('auth.listUsers', function() {
  var dbApi = Core.getModule('db');
  if (!dbApi) return { users: [] };
  return { users: dbApi.listUsers(), currentUser: Core.config.lastUser || 'admin' };
});

// Bridge Core events to WebSocket clients
Core.on('configChanged', function(delta) {
  router.broadcast(PROTOCOL.EVENT_CONFIG, { delta: delta });
});

// ===== Static file serving =====
var WEB_DIR = path.join(__dirname, 'web');
var MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), clients: router.getClients().size }));
    return;
  }
  if (req.url === '/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: Core.config.availableModels || [] }));
    return;
  }
  var urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  var safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  var filePath = path.join(WEB_DIR, safePath);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(WEB_DIR, 'index.html');
  }
  var ext = path.extname(filePath).toLowerCase();
  var mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

// ===== HTTP + WebSocket server =====
var fs = require('fs');
var server = http.createServer(serveStatic);

var wss = new WebSocketServer({ server: server });
wss.on('connection', function(ws, req) {
  router.onConnection(ws, req);
});

server.listen(PORT, HOST, function() {
  console.log('');
  console.log('  AI Agent Pro Server v' + PROTOCOL.VERSION);
  console.log('  HTTP:  http://' + HOST + ':' + PORT);
  console.log('  WS:    ws://' + HOST + ':' + PORT);
  console.log('  Web:   http://' + HOST + ':' + PORT + '/');
  console.log('  Data:  ' + Core.DATA_ROOT);
  console.log('  Time:  ' + new Date().toISOString());
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', function() {
  console.log('\nShutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
