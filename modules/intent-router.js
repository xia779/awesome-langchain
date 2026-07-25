// modules/intent-router.js — 指挥官意图识别 + 任务路由（Wave 8，规则版 MVP）
//
// 对应 DS.txt 2.1.4 指挥官模式 / 2.3.1 架构流程 的「意图识别 -> 角色路由」环节。
// 本模块为纯逻辑模块：不触碰 DOM、不依赖 Core 运行时状态，classify/decompose 均为
// 同步纯函数，方便在 Node 测试环境直接断言。Core 仅在 init 时挂载 API。
//
// 设计：
//   · classify(text) -> { intent, confidence, role }
//       intent ∈ chat | code_generation | web_search | document_analysis | data_analysis
//       role   ∈ code_expert | search_specialist | doc_assistant | data_analyst | null(chat)
//   · decompose(text) -> [子任务文本]  （规则版：按编号/换行拆分，上限 5 条）
//
// 模块契约：{ name, dependencies, init(Core) }，由 core-v10.js loadModules() 自动加载。

var Core = null;

// ═══════════════════════════════════════════
// 意图 -> 子角色 映射（与 subroles.js 的 id 严格对齐）
// ═══════════════════════════════════════════
var ROLE_FOR_INTENT = {
  code_generation: 'code_expert',
  web_search: 'search_specialist',
  document_analysis: 'doc_assistant',
  data_analysis: 'data_analyst'
};

// ═══════════════════════════════════════════
// 关键词权重表（每条 [关键词, 权重]；命中即累加）
// 权重含义：2.0 强信号 / 1.5 中信号 / 1.0 弱信号
// ═══════════════════════════════════════════
var INTENTS = [
  {
    id: 'code_generation',
    keywords: [
      ['代码', 2.0], ['编程', 2.0], ['调试', 2.0], ['debug', 2.0], ['重构', 2.0],
      ['正则', 1.5], ['脚本', 1.5], ['函数', 1.5], ['算法', 1.5], ['编译', 1.5],
      ['报错', 1.5], ['bug', 1.5], ['程序', 1.5], ['python', 1.5], ['javascript', 1.5],
      ['sql', 1.5], ['code', 1.5], ['修复', 1.5], ['java', 1.0], ['实现', 1.0]
    ]
  },
  {
    id: 'web_search',
    keywords: [
      ['搜索', 2.0], ['搜一下', 2.0], ['查一下', 2.0], ['联网', 2.0], ['上网', 2.0],
      ['查询', 1.5], ['查找', 1.5], ['最新', 1.5], ['新闻', 1.5], ['天气', 1.5],
      ['行情', 1.5], ['股价', 1.5], ['资讯', 1.5], ['调研', 1.5], ['搜集', 1.5],
      ['网上', 1.5], ['谷歌', 1.5], ['百度', 1.5], ['google', 1.5], ['search', 1.5],
      ['今天', 1.0], ['现在', 1.0], ['价格', 1.0]
    ]
  },
  {
    id: 'document_analysis',
    keywords: [
      ['文档', 2.0], ['总结', 2.0], ['摘要', 2.0], ['概括', 2.0], ['论文', 2.0],
      ['合同', 2.0], ['pdf', 2.0], ['summarize', 2.0], ['提炼', 1.5], ['要点', 1.5],
      ['归纳', 1.5], ['翻译', 1.5], ['报告', 1.5], ['markdown', 1.5], ['附件', 1.5],
      ['这篇文章', 1.5], ['阅读', 1.0], ['文件', 1.0]
    ]
  },
  {
    id: 'data_analysis',
    keywords: [
      ['数据分析', 2.5], ['数据处理', 2.0], ['数据', 2.0], ['图表', 2.0], ['统计', 2.0],
      ['excel', 2.0], ['csv', 2.0], ['可视化', 2.0], ['柱状图', 2.0], ['折线图', 2.0],
      ['饼图', 2.0], ['回归', 2.0], ['相关性', 2.0], ['分析', 1.5], ['表格', 1.5],
      ['趋势', 1.5], ['预测', 1.5], ['计算', 1.5], ['数值', 1.5], ['均值', 1.5],
      ['data', 1.5]
    ]
  }
];

// 低于该分值判定为闲聊
var THRESHOLD = 1.5;
// 子任务数量上限
var MAX_SUBTASKS = 5;

// 纯闲聊/问候短路（避免「你好」之类误触发）
var CHITCHAT_RE = /^(你好|您好|嗨|哈喽|hello|hi|hey|早上好|下午好|晚上好|在吗|你是谁|谢谢|多谢|再见|拜拜|嗯|好的|哦|ok)[\s!！.。?？,，~]*$/i;

// ═══════════════════════════════════════════
// 打分
// ═══════════════════════════════════════════
function scoreAll(lower) {
  var out = [];
  for (var i = 0; i < INTENTS.length; i++) {
    var it = INTENTS[i];
    var score = 0;
    var hits = [];
    for (var j = 0; j < it.keywords.length; j++) {
      var kw = it.keywords[j][0];
      var w = it.keywords[j][1];
      if (lower.indexOf(kw) >= 0) { score += w; hits.push(kw); }
    }
    out.push({ id: it.id, score: score, hits: hits });
  }
  // 按分值降序
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

function classify(text) {
  var clean = String(text == null ? '' : text).trim();
  if (!clean) return { intent: 'chat', confidence: 1, role: null };

  var lower = clean.toLowerCase();

  // 纯问候/闲聊短路
  if (CHITCHAT_RE.test(clean)) {
    return { intent: 'chat', confidence: 0.95, role: null };
  }

  var scores = scoreAll(lower);
  var best = scores[0];
  var second = scores[1];

  if (!best || best.score < THRESHOLD) {
    return { intent: 'chat', confidence: 0.6, role: null };
  }

  // 置信度：按绝对强度分档，再因「次优意图逼近」而衰减
  var confidence;
  if (best.score >= 4) confidence = 0.95;
  else if (best.score >= 2.5) confidence = 0.8;
  else if (best.score >= 1.5) confidence = 0.6;
  else confidence = 0.45;
  if (second && second.score >= best.score * 0.8) {
    confidence = Math.max(0.3, confidence - 0.2);
  }

  return {
    intent: best.id,
    confidence: Math.round(confidence * 100) / 100,
    role: ROLE_FOR_INTENT[best.id] || null,
    hits: best.hits
  };
}

// ═══════════════════════════════════════════
// 任务拆解（规则版 MVP）
//   · 优先按编号标记拆（1. / 1、 / ①…）
//   · 否则按换行拆
//   · 拆不出多条则原样返回单条
// ═══════════════════════════════════════════
function decompose(text) {
  var clean = String(text == null ? '' : text).trim();
  if (!clean) return [];

  // 1) 编号标记拆分
  var numbered = clean.split(/(?:^|\n)\s*(?:\d+\s*[.、)]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/);
  var parts = cleanParts(numbered);
  if (parts.length > 1) return parts.slice(0, MAX_SUBTASKS);

  // 2) 换行拆分
  var lines = clean.split(/\r?\n/);
  parts = cleanParts(lines);
  if (parts.length > 1) return parts.slice(0, MAX_SUBTASKS);

  return [clean];
}

function cleanParts(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var s = String(arr[i] || '').trim();
    // 去掉残留的引导词，如「任务：」「然后」
    s = s.replace(/^(任务|子任务|然后|接着|再)\s*[::]?\s*/, '');
    if (s && s.length >= 2) out.push(s);
  }
  return out;
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════
module.exports = {
  name: 'intent-router',
  dependencies: [],
  init: function (_Core) {
    Core = _Core;
    Core.intentRouter = {
      classify: classify,
      decompose: decompose,
      roleForIntent: function (intent) { return ROLE_FOR_INTENT[intent] || null; },
      listIntents: function () {
        return INTENTS.map(function (it) { return { id: it.id, role: ROLE_FOR_INTENT[it.id] || null }; });
      },
      ROLE_FOR_INTENT: ROLE_FOR_INTENT
    };
    console.log('✅ Intent-Router 已加载（指挥官意图识别，' + INTENTS.length + ' 类任务意图）');
  },
  // 供单元测试直接引用内部实现
  _internals: {
    classify: classify,
    decompose: decompose,
    scoreAll: scoreAll,
    INTENTS: INTENTS,
    ROLE_FOR_INTENT: ROLE_FOR_INTENT,
    THRESHOLD: THRESHOLD,
    MAX_SUBTASKS: MAX_SUBTASKS
  }
};
