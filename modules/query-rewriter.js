// modules/query-rewriter.js - 查询改写模块（指代消解 + 关键词扩展）
// 在知识库/记忆检索前，将用户原始查询改写为更精确的检索句
// 例如："它的涨跌幅是多少？" → "上证指数今日涨跌幅"
'use strict';

var Core = null;

// ===== 快速判断：查询是否需要改写 =====
var PRONOUN_PATTERNS = /[它他她你们这个那这些那些上面前面刚才之前说的提到的]/;
var ELLIPSIS_PATTERNS = /^(继续|接着|然后呢|还有呢|呢？|\.\.\.)/;

function needsRewrite(query) {
  if (!query || query.length < 2) return false;
  if (query.length <= 4) return true;
  if (PRONOUN_PATTERNS.test(query)) return true;
  if (ELLIPSIS_PATTERNS.test(query)) return true;
  if (query.length <= 10 && query.includes('？')) return true;
  return false;
}

// ===== 从会话历史中提取最近几轮对话摘要 =====
function buildHistorySnippet(messages, maxTurns) {
  maxTurns = maxTurns || 3;
  if (!messages || messages.length === 0) return '';
  var recent = messages.slice(-(maxTurns * 2));
  var lines = [];
  for (var i = 0; i < recent.length; i++) {
    var m = recent[i];
    var role = m.role === 'user' ? '用户' : 'AI';
    var content = (m.content || '').replace(/\n/g, ' ').substring(0, 120);
    if (content.trim()) {
      lines.push(role + ': ' + content.trim());
    }
  }
  return lines.join('\n');
}

// ===== LLM 改写 =====
async function rewriteWithLLM(query, historySnippet) {
  var systemPrompt = '你是一个查询改写助手。你的任务是将用户的追问/指代性查询改写为独立、完整、适合搜索引擎检索的查询句。\n'
    + '规则：\n'
    + '1. 解析代词（它、这个、上面提到的）为具体实体\n'
    + '2. 补全省略的主语和上下文\n'
    + '3. 保留用户原始意图，不要添加无关信息\n'
    + '4. 输出仅包含改写后的查询文本，不要解释\n'
    + '5. 如果原始查询已经足够清晰完整，原样输出即可\n'
    + '6. 保持与用户相同的语言（中文问→中文输出）';

  var userPrompt = '';
  if (historySnippet) {
    userPrompt += '【对话历史】\n' + historySnippet + '\n\n';
  }
  userPrompt += '【用户当前查询】\n' + query + '\n\n请输出改写后的查询：';

  try {
    var model = null;
    var provider = 'ollama';
    if (Core.dom && Core.dom.modelSelect && Core.dom.modelSelect.value) {
      var selVal = Core.dom.modelSelect.value;
      if (selVal.includes(':')) {
        var parts = selVal.split(':');
        provider = parts[0];
        model = parts.slice(1).join(':');
      } else {
        model = selVal;
      }
    }

    var data = await Core.api.callAPI(userPrompt, systemPrompt, 0.1, model, provider, null, { disableTools: true });
    if (data && data.content) {
      var rewritten = data.content.trim().replace(/^["']|["']$/g, '');
      if (rewritten.length >= 2 && rewritten.length <= 200) {
        return rewritten;
      }
    }
  } catch (e) {
    console.warn('[query-rewriter] LLM 改写失败，使用原始查询:', e.message);
  }
  return query;
}

// ===== 带超时的改写（防止 LLM 响应慢阻塞主流程） =====
function rewriteWithTimeout(query, historySnippet, timeoutMs) {
  timeoutMs = timeoutMs || 4000;
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (!settled) {
        settled = true;
        console.warn('[query-rewriter] 改写超时(' + timeoutMs + 'ms)，使用原始查询');
        resolve(query);
      }
    }, timeoutMs);

    rewriteWithLLM(query, historySnippet).then(function(result) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    }).catch(function() {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(query);
      }
    });
  });
}

// ===== 主入口：改写查询 =====
async function rewrite(query, historyMessages) {
  if (!query || !Core || !Core.api || !Core.api.callAPI) {
    return { query: query, rewritten: query, changed: false };
  }

  // 快速路径：不需要改写
  if (!needsRewrite(query)) {
    return { query: query, rewritten: query, changed: false };
  }

  // 获取历史
  var messages = historyMessages;
  if (!messages) {
    try {
      var sid = Core.session.getCurrentId();
      var sessions = Core.session.sessions || {};
      if (sid && sessions[sid] && sessions[sid].messages) {
        messages = sessions[sid].messages;
      }
    } catch (e) { /* ignore */ }
  }

  var historySnippet = buildHistorySnippet(messages, 3);
  if (!historySnippet) {
    return { query: query, rewritten: query, changed: false };
  }

  var rewritten = await rewriteWithTimeout(query, historySnippet, 4000);
  var changed = rewritten !== query;
  if (changed) {
    console.log('[query-rewriter] 改写: "' + query + '" -> "' + rewritten + '"');
  }
  return { query: query, rewritten: rewritten, changed: changed };
}

// ===== 模块导出 =====
module.exports = {
  name: 'query-rewriter',
  dependencies: [],
  init: function(ctx) {
    Core = ctx.Core;

    Core.queryRewriter = {
      rewrite: rewrite,
      needsRewrite: needsRewrite,
      _buildHistorySnippet: buildHistorySnippet,
    };

    console.log('✅ [query-rewriter] 查询改写模块已加载');
  },
};
