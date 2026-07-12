// server/index.js — AI Agent Pro backend entry point
// HTTP server for health checks + WebSocket server for client communication
const http = require('http');
const { WebSocketServer } = require('ws');
const Core = require('./core');
const PROTOCOL = require('./protocol');
const { createRouter } = require('./ws-router');
const path = require('path');

const PORT = parseInt(process.env.AI_SERVER_PORT || '3847', 10);
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

// Bridge Core events to WebSocket clients
Core.on('configChanged', function(delta) {
  router.broadcast(PROTOCOL.EVENT_CONFIG, { delta: delta });
});

// ===== HTTP + WebSocket server =====
var server = http.createServer(function(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), clients: router.getClients().size }));
  } else if (req.url === '/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: Core.config.availableModels || [] }));
  } else {
    res.writeHead(404);
    res.end('AI Agent Pro Server');
  }
});

var wss = new WebSocketServer({ server: server });
wss.on('connection', function(ws, req) {
  router.onConnection(ws, req);
});

server.listen(PORT, HOST, function() {
  console.log('');
  console.log('  AI Agent Pro Server v' + PROTOCOL.VERSION);
  console.log('  HTTP:  http://' + HOST + ':' + PORT);
  console.log('  WS:    ws://' + HOST + ':' + PORT);
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
