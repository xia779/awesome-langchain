// modules/market-data.js - 行情数据桥（pytdx sidecar + 腾讯快照 + 缓存 三级降级）
// 架构：scripts/pytdx_service.py (Flask:8085) 长驻服务，Node 主动轮询/按需拉取。
// 降级链：pytdx(8085) → 腾讯快照(stock-quote) → market-db 最后缓存（P2 接入后生效）。
var http = require('http');
var fs = require('fs');
var path = require('path');
var { spawn } = require('child_process');

var Core = null;
var PROBE_COOLDOWN = 300000;      // 健康探测冷却（复刻 voice.js 模式）
var RESTART_WINDOW = 600000;      // 10 分钟
var RESTART_MAX = 3;              // 窗口内最多重启 3 次
var DEFAULT_PORT = 8085;

var state = {
  proc: null, available: false, checkedOnce: false, lastCheck: 0,
  restartTimes: [], listeners: new Map(), seq: 0, timer: null,
};

function getPort() { return (Core.config && Core.config.pytdxPort) || DEFAULT_PORT; }

// ===== 轻量 HTTP JSON GET =====
function httpJson(path_, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var req = http.get({
      hostname: '127.0.0.1', port: getPort(), path: path_, timeout: timeoutMs || 4000,
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try {
          var json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (json && json.ok === false) { reject(new Error(json.error || 'sidecar error')); return; }
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('sidecar 超时')); });
  });
}

// ===== Python 解释器解析（只用专用 venv，不回落系统 python，避免误启动）=====
function resolvePython() {
  var cfg = Core.config || {};
  if (cfg.pytdxPython && fs.existsSync(cfg.pytdxPython)) return cfg.pytdxPython;
  var pyExe = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  // 候选路径：① 当前用户目录下 pytdx-env ② 全局数据根目录下 pytdx-env（多用户共享，推荐）
  var candidates = [
    path.join(Core.DATA_ROOT, 'pytdx-env', pyExe),
    path.join(Core.pathService.global(), 'pytdx-env', pyExe)
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

function canRestart() {
  var now = Date.now();
  state.restartTimes = state.restartTimes.filter(function(t) { return now - t < RESTART_WINDOW; });
  if (state.restartTimes.length >= RESTART_MAX) return false;
  state.restartTimes.push(now);
  return true;
}

function spawnService() {
  var python = resolvePython();
  if (!python) {
    console.warn('market-data: 未找到 pytdx-env，跳过 sidecar 启动（用腾讯源兜底）');
    return false;
  }
  if (!canRestart()) {
    console.warn('market-data: sidecar 重启过于频繁，进入冷却');
    return false;
  }
  var script = path.join(__dirname, '..', 'scripts', 'pytdx_service.py');
  var logDir = path.join(Core.DATA_ROOT, 'logs');
  try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
  var logStream;
  try { logStream = fs.createWriteStream(path.join(logDir, 'pytdx_service.log'), { flags: 'a' }); } catch (e) {}
  try {
    var child = spawn(python, [script, '--port', String(getPort())], {
      cwd: path.join(__dirname, '..'), windowsHide: true,
      stdio: ['ignore', logStream || 'ignore', logStream || 'ignore'],
    });
    child.on('exit', function() { state.proc = null; state.available = false; });
    child.on('error', function() { state.proc = null; state.available = false; });
    state.proc = child;
    return true;
  } catch (e) {
    console.warn('market-data: sidecar 启动失败 -', e.message);
    return false;
  }
}

function probe() {
  return httpJson('/health', 1500).then(function(res) { return !!(res && res.ok); }).catch(function() { return false; });
}

function waitHealth(ms) {
  var deadline = Date.now() + ms;
  return new Promise(function(resolve) {
    (function loop() {
      probe().then(function(ok) {
        if (ok) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(loop, 500);
      });
    })();
  });
}

// ===== 服务可用性（带冷却与自动拉起）=====
async function ensureService() {
  if (Core.config && Core.config.pytdxEnabled === false) return false;
  var now = Date.now();
  if (state.checkedOnce && now - state.lastCheck < PROBE_COOLDOWN) return state.available;
  state.lastCheck = now; state.checkedOnce = true;
  if (await probe()) { state.available = true; return true; }
  state.available = false;
  if (!state.proc) {
    if (!spawnService()) return false;
    var ok = await waitHealth(8000);
    state.available = ok;
    state.lastCheck = Date.now();
    return ok;
  }
  return false;
}

// ===== 代码规范化（复用 stock-quote 的解析）=====
function normalizeCodes(codes) {
  var out = [];
  (codes || []).forEach(function(c) {
    var sym = Core.stockQuote && Core.stockQuote.resolveSymbol ? Core.stockQuote.resolveSymbol(c) : null;
    if (sym && sym.indexOf('bj') !== 0 && out.indexOf(sym) < 0) out.push(sym);   // pytdx 不支持北交所
  });
  return out;
}

// ===== 快照映射 =====
function mapPytdx(rows, server) {
  var now = Date.now();
  return (rows || []).filter(function(r) { return r && r.price != null; }).map(function(r) {
    var pct = (r.price != null && r.prevClose) ? +(((r.price - r.prevClose) / r.prevClose) * 100).toFixed(2) : null;
    return {
      code: r.code, name: null, price: r.price, open: r.open, high: r.high, low: r.low,
      prevClose: r.prevClose, vol: r.vol, amount: r.amount, changePct: pct,
      ts: now, source: 'pytdx', server: server || null,
    };
  });
}

function mapTencent(q, symbols) {
  var prefix = '';
  for (var i = 0; i < symbols.length; i++) {
    if (symbols[i].slice(2) === q.code) { prefix = symbols[i].slice(0, 2); break; }
  }
  var ts = null;
  if (q.time && q.time.length >= 14) {
    ts = new Date(q.time.slice(0, 4) + '-' + q.time.slice(4, 6) + '-' + q.time.slice(6, 8) +
      'T' + q.time.slice(8, 10) + ':' + q.time.slice(10, 12) + ':' + q.time.slice(12, 14)).getTime() || null;
  }
  return {
    code: prefix + q.code, name: q.name || null,
    price: parseFloat(q.price) || null, open: parseFloat(q.open) || null,
    high: parseFloat(q.high) || null, low: parseFloat(q.low) || null,
    prevClose: parseFloat(q.prevClose) || null,
    vol: parseFloat(q.volume) || null,
    amount: (parseFloat(q.amount) || 0) * 10000 || null,   // 腾讯万元 → 元
    changePct: parseFloat(q.changePct) || null,
    ts: ts || Date.now(), source: 'tencent',
  };
}

function tencentQuotes(codes) {
  return new Promise(function(resolve) {
    if (!Core.stockQuote || !Core.stockQuote.fetchQuotes) return resolve(null);
    Core.stockQuote.fetchQuotes(codes, function(err, quotes) {
      if (err || !quotes || !quotes.length) return resolve(null);
      resolve(quotes.map(function(q) { return mapTencent(q, codes); }));
    });
  });
}

// ===== 对外 API =====
async function getQuote(codes) {
  var syms = normalizeCodes(Array.isArray(codes) ? codes : [codes]);
  if (!syms.length) throw new Error('无有效证券代码');
  if (await ensureService()) {
    try {
      var res = await httpJson('/quote?codes=' + syms.join(','), 4000);
      var rows = mapPytdx(res.data, res.server);
      if (rows.length) return rows;
    } catch (e) { state.available = false; }
  }
  var tq = await tencentQuotes(syms);
  if (tq && tq.length) return tq;
  if (Core.marketDb && Core.marketDb.getLastQuotes) {
    var cached = Core.marketDb.getLastQuotes(syms);
    if (cached && cached.length) {
      return cached.map(function(s) { return Object.assign({}, s, { source: 'cache' }); });
    }
  }
  throw new Error('行情不可用：pytdx 与腾讯源均失败');
}

async function getKline(code, period, count) {
  var syms = normalizeCodes([code]);
  if (!syms.length) throw new Error('无效证券代码: ' + code);
  if (!(await ensureService())) throw new Error('K线需要 pytdx 服务（当前不可用，腾讯源无K线）');
  var res = await httpJson('/kline?code=' + syms[0] + '&period=' + encodeURIComponent(period || 'day') +
    '&count=' + (count || 800), 20000);
  return res.data || [];
}

async function getMinute(code) {
  var syms = normalizeCodes([code]);
  if (!syms.length) throw new Error('无效证券代码: ' + code);
  if (!(await ensureService())) throw new Error('分时需要 pytdx 服务（当前不可用）');
  var res = await httpJson('/minute?code=' + syms[0], 8000);
  return res.data || [];
}

async function getStockList() {
  if (!(await ensureService())) throw new Error('证券列表需要 pytdx 服务（当前不可用）');
  var res = await httpJson('/list', 30000);
  return res.data || [];
}

// ===== 订阅轮询（盘中 3s；非交易时段自动跳过）=====
function startTimer() {
  if (state.timer) return;
  var ms = (Core.config && Core.config.marketPollMs) || 3000;
  state.timer = setInterval(tick, ms);
  if (state.timer.unref) state.timer.unref();
}

async function tick() {
  if (!state.listeners.size) return;
  var anyForce = false, codeSet = {};
  state.listeners.forEach(function(l) {
    if (l.opts && l.opts.ignoreTradingTime) anyForce = true;
    l.codes.forEach(function(c) { codeSet[c] = true; });
  });
  if (!anyForce && Core.tradingCal && !Core.tradingCal.isTradingTime()) return;
  try {
    var snaps = await getQuote(Object.keys(codeSet));
    state.listeners.forEach(function(l) {
      var mine = snaps.filter(function(s) { return l.codes.indexOf(s.code) >= 0; });
      if (mine.length) { try { l.cb(mine); } catch (e) {} }
    });
  } catch (e) { /* 本轮失败，下轮重试 */ }
}

function subscribe(codes, cb, opts) {
  var syms = normalizeCodes(Array.isArray(codes) ? codes : [codes]);
  if (!syms.length) throw new Error('无有效证券代码');
  var id = ++state.seq;
  state.listeners.set(id, { codes: syms, cb: cb, opts: opts || {} });
  startTimer();
  return id;
}

function unsubscribe(id) {
  state.listeners.delete(id);
  if (!state.listeners.size && state.timer) { clearInterval(state.timer); state.timer = null; }
}

// 测试用：重置模块级状态（生产环境请勿调用）
function _reset() {
  state.proc = null; state.available = false; state.checkedOnce = false;
  state.lastCheck = 0; state.restartTimes = [];
  state.listeners.clear();
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

module.exports = {
  name: 'market-data',
  dependencies: ['stock-quote', 'trading-calendar'],
  init: function(_Core) {
    Core = _Core;
    Core.marketData = {
      getQuote: getQuote, getKline: getKline, getMinute: getMinute,
      getStockList: getStockList, subscribe: subscribe, unsubscribe: unsubscribe,
      ensureService: ensureService, _reset: _reset,
    };
    if (!Core.config || Core.config.pytdxAutoStart !== false) {
      setTimeout(function() { ensureService().catch(function() {}); }, 3000);
    }
    console.log('market-data 模块已加载（pytdx sidecar :' + getPort() + ' → 腾讯 → 缓存 三级降级）');
  },
};
