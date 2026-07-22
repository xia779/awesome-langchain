// modules/stock-quote.js - A股行情查询模块
// 数据源：腾讯行情 qt.gtimg.cn（返回真实小数价格 + 明确行情时间戳，GBK 编码）
// 名称解析：腾讯 smartbox 联想接口（支持任意股票名称/简称 → 代码）
// 设计目标：为 Agent 提供【确定的结构化行情数字】，取代"网页搜索+大模型猜数"，
//           杜绝股指点位/开盘收盘/涨跌幅的编造与多源不一致问题。
const http = require('http');
const https = require('https');

let Core = null;

// GBK 解码：优先 iconv-lite（纯JS，项目已装），降级 TextDecoder('gbk')（需ICU）
let iconv = null;
try { iconv = require('iconv-lite'); } catch (e) { /* 用 TextDecoder 兜底 */ }

function decodeGBK(buf) {
  try { if (iconv) return iconv.decode(buf, 'gbk'); } catch (e) {}
  try { return new TextDecoder('gbk').decode(buf); } catch (e) {}
  return buf.toString('utf8');
}

// ===== 常用指数名称 → 腾讯代码（高频，走快速路径）=====
var NAME_MAP = {
  '上证指数': 'sh000001', '上证': 'sh000001', '沪指': 'sh000001', '大盘': 'sh000001', '上证综指': 'sh000001',
  '深证成指': 'sz399001', '深成指': 'sz399001', '深指': 'sz399001',
  '创业板指': 'sz399006', '创业板': 'sz399006',
  '沪深300': 'sh000300', '沪深三百': 'sh000300',
  '上证50': 'sh000016', '上证五十': 'sh000016',
  '中证500': 'sh000905', '中证五百': 'sh000905',
  '中证1000': 'sh000852', '中证一千': 'sh000852',
  '科创50': 'sh000688', '科创五十': 'sh000688',
  '深证100': 'sz399009',
  '平安银行': 'sz000001',
};

// ===== 指数代码集合（用于裸代码消歧：000001 裸代码默认指上证指数）=====
var INDEX_CODES = {
  '000001': 'sh', '000016': 'sh', '000300': 'sh', '000688': 'sh',
  '000852': 'sh', '000905': 'sh',
  '399001': 'sz', '399005': 'sz', '399006': 'sz', '399009': 'sz',
};

var MAX_SYMBOLS = 20;   // 单次查询标的数上限

// ===== 代码/名称 → 腾讯代码（快速路径：前缀/指数名/裸代码）=====
function resolveSymbol(raw) {
  var s = String(raw).trim();
  if (!s) return null;
  if (/^(sh|sz|bj)\d{6}$/i.test(s)) return s.toLowerCase();   // 已带市场前缀
  if (NAME_MAP[s]) return NAME_MAP[s];                         // 常用指数名
  var code = s.replace(/[^\d]/g, '');
  if (/^\d{6}$/.test(code)) {
    if (INDEX_CODES[code]) return INDEX_CODES[code] + code;    // 指数（含 000001→上证指数）
    if (code[0] === '6') return 'sh' + code;                   // 沪市A股/科创板
    if (code[0] === '0' || code[0] === '3') return 'sz' + code; // 深市
    if (code[0] === '8' || code[0] === '4') return 'bj' + code; // 北交所
    return 'sh' + code;
  }
  return null;
}

// ===== 名称联想 → 腾讯代码（慢速路径：任意股票名/简称，如 贵州茅台/茅台）=====
function searchSymbol(name) {
  return new Promise(function(resolve) {
    var url = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(name) + '&t=all';
    var req = https.get(url, { timeout: 8000 }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try {
          var text = decodeGBK(Buffer.concat(chunks));
          var m = text.match(/v_hint="(.*)"/);
          if (!m || !m[1]) { resolve(null); return; }
          // 格式: market~code~name~pinyin~type^market~code~...（取第一个候选）
          var first = m[1].split('^')[0];
          var parts = first.split('~');
          if (parts.length >= 2 && /^(sh|sz|bj)$/i.test(parts[0]) && /^\d{6}$/.test(parts[1])) {
            resolve(parts[0].toLowerCase() + parts[1]);
          } else resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.on('timeout', function() { req.destroy(); resolve(null); });
  });
}

// ===== A股市场状态（工作日 9:30-11:30 / 13:00-15:00；不含节假日，以行情时间戳为准）=====
function getMarketStatus(now) {
  now = now || new Date();
  var day = now.getDay();
  if (day === 0 || day === 6) return { open: false, phase: '休市（周末）' };
  var hm = now.getHours() * 100 + now.getMinutes();
  if (hm < 930) return { open: false, phase: '未开盘（9:30开盘）' };
  if (hm < 1130) return { open: true, phase: '交易中（上午盘）' };
  if (hm < 1300) return { open: false, phase: '午间休市（13:00继续）' };
  if (hm < 1500) return { open: true, phase: '交易中（下午盘）' };
  return { open: false, phase: '已收盘（15:00收盘）' };
}

// ===== 拉取行情（支持多标的，一次请求）=====
function fetchQuotes(symbols, cb) {
  var url = 'http://qt.gtimg.cn/q=' + symbols.join(',');
  var req = http.get(url, { timeout: 15000 }, function(res) {
    var chunks = [];
    res.on('data', function(c) { chunks.push(c); });
    res.on('end', function() {
      try {
        var text = decodeGBK(Buffer.concat(chunks));
        var quotes = parseQuotes(text);
        if (quotes.length === 0) { cb(new Error('数据源返回为空')); return; }
        cb(null, quotes);
      } catch (e) { cb(e); }
    });
  });
  req.on('error', function(e) { cb(e); });
  req.on('timeout', function() { req.destroy(); cb(new Error('请求超时(15s)')); });
}

// ===== 解析腾讯行情文本（字段以 ~ 分隔）=====
function parseQuotes(text) {
  var quotes = [];
  var parts = String(text).split(';');
  for (var i = 0; i < parts.length; i++) {
    var m = parts[i].match(/="(.*)"/);
    if (!m) continue;
    var f = m[1].split('~');
    if (f.length < 46 || !f[1] || !f[3]) continue;   // 跳过无效/停牌无数据
    quotes.push({
      name: f[1], code: f[2],
      price: f[3], prevClose: f[4], open: f[5],
      volume: f[6],            // 手
      time: f[30],             // yyyyMMddHHmmss 行情时间戳
      change: f[31], changePct: f[32],
      high: f[33], low: f[34],
      amount: f[37],           // 万元
      turnover: f[38],         // 换手率%
      amplitude: f[43],        // 振幅%
    });
  }
  return quotes;
}

// ===== 数字格式化 =====
function fmtQuoteTime(t) {
  if (!t || t.length < 14) return t || '未知';
  return t.substring(0, 4) + '-' + t.substring(4, 6) + '-' + t.substring(6, 8) + ' ' +
    t.substring(8, 10) + ':' + t.substring(10, 12) + ':' + t.substring(12, 14);
}
function fmtVolume(v) {
  var n = parseFloat(v); if (isNaN(n)) return v || '-';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿手';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '万手';
  return n + '手';
}
function fmtAmount(a) {
  var n = parseFloat(a); if (isNaN(n)) return a || '-';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '亿元';
  return n.toFixed(2) + '万元';
}
function fmtNow() {
  var d = new Date();
  var p = function(n) { return String(n).length < 2 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// ===== 组织输出（确定数字 + 行情时间 + 市场状态 + 时效提示）=====
function formatQuotes(quotes, unresolved, symbols) {
  var status = getMarketStatus();
  var out = '📈 A股行情（数据源：腾讯行情，权威实时数据）\n';
  out += '市场状态：' + status.phase + '\n';
  out += '查询时间：' + fmtNow() + '\n\n';

  quotes.forEach(function(q) {
    var pct = parseFloat(q.changePct);
    var arrow = pct > 0 ? '↑' : (pct < 0 ? '↓' : '→');
    out += '【' + q.name + '】(' + q.code + ') ' + arrow + '\n';
    out += '  现价: ' + q.price + '   涨跌: ' + q.change + ' (' + q.changePct + '%)\n';
    out += '  今开: ' + q.open + '   昨收: ' + q.prevClose + '\n';
    out += '  最高: ' + q.high + '   最低: ' + q.low + '   振幅: ' + q.amplitude + '%\n';
    out += '  成交量: ' + fmtVolume(q.volume) + '   成交额: ' + fmtAmount(q.amount) + '\n';
    out += '  行情时间: ' + fmtQuoteTime(q.time) + '\n\n';
  });

  var returned = {};
  quotes.forEach(function(q) { returned[q.code] = true; });
  var missing = (symbols || []).filter(function(s) { return !returned[s.substring(2)]; });
  if (missing.length > 0) out += '⚠️ 以下代码未返回数据（可能无效/停牌/退市）: ' + missing.join(', ') + '\n';
  if (unresolved && unresolved.length > 0) out += '⚠️ 未识别的输入: ' + unresolved.join(', ') + '\n';

  if (!status.open) {
    out += '\n💡 当前' + status.phase + '，以上为最近交易时段的数据，请以上方"行情时间"判断时效，不要当作实时价格。\n';
  }
  return out;
}

// ===== 主入口：查询行情（代码走快速路径，名称走联想解析）=====
async function getQuote(query) {
  var inputs = String(query || '').split(/[,，、\s]+/).filter(Boolean);
  if (inputs.length === 0) return '❌ 错误：请提供股票代码或名称（如 上证指数 / 600519 / 贵州茅台）';

  var symbols = [];
  var unresolved = [];
  for (var i = 0; i < inputs.length && symbols.length < MAX_SYMBOLS; i++) {
    var inp = inputs[i];
    var sym = resolveSymbol(inp);          // 快速路径
    if (!sym) sym = await searchSymbol(inp); // 名称联想兜底
    if (sym) { if (symbols.indexOf(sym) < 0) symbols.push(sym); }
    else unresolved.push(inp);
  }
  if (symbols.length === 0) {
    return '❌ 错误：无法识别 "' + inputs.join(', ') + '"。请用6位代码、指数名称或股票名称。';
  }

  return new Promise(function(resolve) {
    fetchQuotes(symbols, function(err, quotes) {
      if (err) { resolve('❌ 行情获取失败：' + err.message); return; }
      resolve(formatQuotes(quotes, unresolved, symbols));
    });
  });
}

module.exports = {
  name: 'stock-quote',
  dependencies: [],
  init: function(_Core) {
    Core = _Core;
    Core.stockQuote = {
      getQuote: getQuote,
      resolveSymbol: resolveSymbol,
      searchSymbol: searchSymbol,
      getMarketStatus: getMarketStatus,
    };
    console.log('✅ A股行情模块已加载（数据源：腾讯行情 + 名称联想）');
  }
};
