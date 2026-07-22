// modules/market-panel.js - 盯盘面板（文本看板 + 结构化数据 API）
// 指令：/zpan 看板 | /zadd <代码|名称> | /zdel <代码> | /zlist 自选 | /zmin <代码> 分时
// 自动盯盘：自选股非空且 config.marketAutoWatch!==false 时，盘中自动订阅快照写入 market-db。
var Core = null;
var _watchSubId = null;

// ===== 消息输出（复用 knowledge-distill 的约定）=====
function showMsg(text) {
  var currentId = Core.session && Core.session.getCurrentId && Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(currentId);
  }
}

// ===== 结构化看板数据（供未来富 UI/移动端复用）=====
async function getBoard() {
  var watch = Core.marketDb.listWatch();
  var status = Core.tradingCal.getStatus();
  var quotes = [];
  if (watch.length) {
    try { quotes = await Core.marketData.getQuote(watch.map(function(w) { return w.code; })); }
    catch (e) { quotes = [{ error: e.message }]; }
  }
  var alerts = Core.marketDb.getAlerts(20);
  return { status: status, watchlist: watch, quotes: quotes, alerts: alerts };
}

// ===== 文本看板 =====
function fmtPct(p) {
  if (p == null) return '--';
  return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
}

async function renderBoardText() {
  var board = await getBoard();
  var lines = [];
  lines.push('【盯盘面板】' + board.status.phase);
  if (!board.status.open && board.status.next) {
    lines.push('下一交易时点: ' + board.status.next.toLocaleString('zh-CN'));
  }
  lines.push('');
  if (!board.watchlist.length) {
    lines.push('自选股为空。用 /zadd 600519 或 /zadd 贵州茅台 添加。');
  } else if (board.quotes.length && board.quotes[0].error) {
    lines.push('行情获取失败: ' + board.quotes[0].error);
  } else {
    board.quotes.forEach(function(q) {
      var arrow = q.changePct > 0 ? '↑' : (q.changePct < 0 ? '↓' : '→');
      var name = q.name || (board.watchlist.find(function(w) { return w.code === q.code; }) || {}).name || q.code;
      lines.push(arrow + ' ' + name + ' (' + q.code + ')  ' + (q.price != null ? q.price : '--') +
        '  ' + fmtPct(q.changePct) + '   量 ' + (q.vol != null ? q.vol : '--') +
        '   [' + q.source + ']');
    });
  }
  if (board.alerts.length) {
    lines.push('');
    lines.push('最近预警:');
    board.alerts.slice(0, 5).forEach(function(a) {
      lines.push('  · ' + new Date(a.ts).toLocaleTimeString('zh-CN') + ' ' + a.code + ' ' + a.msg);
    });
  }
  return lines.join('\n');
}

// ===== 分时文本图（▁▂▃▄▅▆▇█）=====
var SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function sparkline(values) {
  if (!values.length) return '';
  var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
  var span = max - min || 1;
  // 抽样到最多 60 点
  var step = Math.max(1, Math.floor(values.length / 60));
  var out = '';
  for (var i = 0; i < values.length; i += step) {
    out += SPARK[Math.min(7, Math.floor(((values[i] - min) / span) * 7.99))];
  }
  return out;
}

async function renderMinute(code) {
  var data = await Core.marketData.getMinute(code);
  if (!data.length) return '分时数据为空（非交易时段或服务不可用）';
  var prices = data.map(function(d) { return d.price; }).filter(function(p) { return p != null; });
  var last = prices[prices.length - 1], first = prices[0];
  var pct = first ? +(((last - first) / first) * 100).toFixed(2) : null;
  return '【分时】' + code + '  最新 ' + last + ' (' + fmtPct(pct) + ')\n' +
    sparkline(prices) + '\n' +
    '最低 ' + Math.min.apply(null, prices) + ' / 最高 ' + Math.max.apply(null, prices) +
    ' / 点 ' + prices.length;
}

// ===== 自选股管理 =====
async function addWatch(input) {
  var sym = Core.stockQuote.resolveSymbol(input);
  var name = null;
  if (!sym) {
    sym = await Core.stockQuote.searchSymbol(input);
    if (sym) name = input;
  }
  if (!sym) return '无法识别: ' + input;
  if (!name) {
    try {
      var q = await Core.marketData.getQuote([sym]);
      name = q[0] && q[0].name;
    } catch (e) {}
  }
  Core.marketDb.addWatch(sym, name || sym, Core.marketDb.listWatch().length);
  ensureWatching();
  return '已添加自选: ' + (name || sym) + ' (' + sym + ')';
}

// ===== 自动盯盘订阅（盘中快照落库，供缓存降级与 P3 预警引擎）=====
function ensureWatching() {
  if (_watchSubId != null) return;
  if (Core.config && Core.config.marketAutoWatch === false) return;
  var codes = Core.marketDb.listWatch().map(function(w) { return w.code; });
  if (!codes.length) return;
  _watchSubId = Core.marketData.subscribe(codes, function(snaps) {
    snaps.forEach(function(s) { try { Core.marketDb.insertSnap(s); } catch (e) {} });
  });
}

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  var reg = function(name, zh, handler) {
    Core.custom.registerCommand(name, { zh: zh, en: zh }, handler);
  };
  reg('/zpan', '盯盘面板：自选股实时行情 + 预警', function() {
    renderBoardText().then(showMsg).catch(function(e) { showMsg('看板渲染失败: ' + e.message); });
  });
  reg('/zadd', '添加自选: /zadd 600519 或 /zadd 贵州茅台', function(args) {
    if (!args || !args.trim()) { showMsg('用法: /zadd <代码或名称>'); return; }
    addWatch(args.trim()).then(showMsg).catch(function(e) { showMsg('添加失败: ' + e.message); });
  });
  reg('/zdel', '删除自选: /zdel 600519', function(args) {
    var sym = Core.stockQuote.resolveSymbol((args || '').trim()) || (args || '').trim();
    showMsg(Core.marketDb.removeWatch(sym) ? '已删除: ' + sym : '未找到: ' + sym);
  });
  reg('/zlist', '自选股列表', function() {
    var list = Core.marketDb.listWatch();
    showMsg(list.length
      ? '【自选股】\n' + list.map(function(w, i) { return (i + 1) + '. ' + (w.name || '') + ' (' + w.code + ')'; }).join('\n')
      : '自选股为空，用 /zadd 添加');
  });
  reg('/zmin', '分时图: /zmin 600519', function(args) {
    if (!args || !args.trim()) { showMsg('用法: /zmin <代码>'); return; }
    renderMinute(args.trim()).then(showMsg).catch(function(e) { showMsg('分时获取失败: ' + e.message); });
  });
}

module.exports = {
  name: 'market-panel',
  dependencies: ['market-data', 'market-db', 'trading-calendar'],
  init: function(_Core) {
    Core = _Core;
    Core.marketPanel = {
      getBoard: getBoard,
      renderBoardText: renderBoardText,
      renderMinute: renderMinute,
      addWatch: addWatch,
      sparkline: sparkline,
    };
    registerCommands();
    setTimeout(ensureWatching, 5000);
    console.log('market-panel 模块已加载（/zpan /zadd /zdel /zlist /zmin）');
  },
};
