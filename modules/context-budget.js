// modules/context-budget.js - Token 预算管理器
// P1-1: 解决 agent-loop/chat-handler 中记忆+知识+历史无脑拼接导致上下文溢出的问题
// 提供 token 估算、分段预算分配、超限自动截断/摘要压缩
(function() {
  'use strict';

  var Core = null;

  // ═══════════════════════════════════════════
  // Token 估算（tiktoken 近似，无需外部依赖）
  // 英文 ~4 chars/token，中文 ~1.5 chars/token
  // ═══════════════════════════════════════════
  function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    var cjkCount = 0;
    var otherCount = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      // CJK 统一表意文字 + 扩展 + 标点
      if ((code >= 0x4E00 && code <= 0x9FFF) ||
          (code >= 0x3400 && code <= 0x4DBF) ||
          (code >= 0x3000 && code <= 0x303F) ||
          (code >= 0xFF00 && code <= 0xFFEF)) {
        cjkCount++;
      } else {
        otherCount++;
      }
    }
    // 中文约 1.5 字符/token，英文约 4 字符/token
    return Math.ceil(cjkCount / 1.5 + otherCount / 4);
  }

  // ═══════════════════════════════════════════
  // 模型上下文窗口配置
  // ═══════════════════════════════════════════
  var MODEL_CONTEXT_LIMITS = {
    // Ollama 本地模型
    'qwen2.5': 32768,
    'qwen3': 32768,
    'llama3': 8192,
    'llama3.1': 128000,
    'llama3.2': 128000,
    'mistral': 32768,
    'mixtral': 32768,
    'deepseek-r1': 65536,
    'deepseek-v3': 65536,
    'phi3': 128000,
    'gemma2': 8192,
    // 云端模型
    'deepseek-chat': 65536,
    'deepseek-reasoner': 65536,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'claude-3': 200000,
    'claude-3.5': 200000,
    'doubao': 4096,
    'qwen-max': 32768,
    'qwen-plus': 131072,
    'qwen-turbo': 131072
  };

  var DEFAULT_CONTEXT_LIMIT = 32768;
  // 预留给模型输出的 token 数
  var OUTPUT_RESERVE = 4096;

  function getModelContextLimit(modelName) {
    if (!modelName) return DEFAULT_CONTEXT_LIMIT;
    var lower = modelName.toLowerCase();
    var keys = Object.keys(MODEL_CONTEXT_LIMITS);
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i]) >= 0) return MODEL_CONTEXT_LIMITS[keys[i]];
    }
    // 用户自定义覆盖
    if (Core && Core.config && Core.config.contextLimit) {
      return Core.config.contextLimit;
    }
    return DEFAULT_CONTEXT_LIMIT;
  }

  // ═══════════════════════════════════════════
  // 预算分配优先级（数字越小优先级越高）
  // ═══════════════════════════════════════════
  var SEGMENT_PRIORITY = {
    system: 0,       // 系统提示词（不可截断）
    time: 1,         // 当前时间（不可截断）
    project: 2,      // 项目上下文
    memory: 3,       // 记忆注入
    knowledge: 4,    // 知识检索
    lessons: 5,      // 经验教训
    mcpTools: 6,     // MCP 工具列表
    history: 7,      // 对话历史
    userMessage: 8   // 当前用户消息（不可截断）
  };

  // 各段最大占比（相对于可用预算）
  var SEGMENT_MAX_RATIO = {
    system: 0.30,
    time: 0.02,
    project: 0.10,
    memory: 0.15,
    knowledge: 0.20,
    lessons: 0.08,
    mcpTools: 0.05,
    history: 0.40,
    userMessage: 0.10
  };

  // ═══════════════════════════════════════════
  // 核心：预算分配与截断
  // ═══════════════════════════════════════════

  /**
   * allocate - 在总预算内分配各段内容
   * @param {Object} segments - { system, time, project, memory, knowledge, lessons, mcpTools, history, userMessage }
   * @param {Object} options - { model, maxTokens, outputReserve }
   * @returns {Object} { allocated: {各段截断后文本}, stats: {各段token数}, truncated: bool, totalTokens }
   */
  function allocate(segments, options) {
    var opts = options || {};
    var modelLimit = getModelContextLimit(opts.model);
    var outputReserve = opts.outputReserve || OUTPUT_RESERVE;
    var totalBudget = (opts.maxTokens || modelLimit) - outputReserve;
    if (totalBudget < 1000) totalBudget = 1000; // 最低保障

    var result = {};
    var stats = {};
    var totalUsed = 0;
    var truncated = false;

    // 第一轮：不可截断段直接通过
    var protectedKeys = ['system', 'time', 'userMessage'];
    var flexibleKeys = ['project', 'memory', 'knowledge', 'lessons', 'mcpTools', 'history'];

    protectedKeys.forEach(function(key) {
      var text = segments[key] || '';
      var tokens = estimateTokens(text);
      result[key] = text;
      stats[key] = tokens;
      totalUsed += tokens;
    });

    // 如果不可截断段已超预算，强制截断 system（保留前 80%）
    if (totalUsed > totalBudget) {
      var sysText = result.system || '';
      var sysTokens = stats.system;
      var maxSys = Math.floor(totalBudget * 0.7);
      if (sysTokens > maxSys) {
        result.system = truncateToTokens(sysText, maxSys);
        stats.system = estimateTokens(result.system);
        totalUsed = stats.system + stats.time + stats.userMessage;
        truncated = true;
      }
    }

    // 第二轮：弹性段按优先级分配剩余预算
    var remaining = totalBudget - totalUsed;
    // 按优先级排序
    flexibleKeys.sort(function(a, b) {
      return (SEGMENT_PRIORITY[a] || 99) - (SEGMENT_PRIORITY[b] || 99);
    });

    flexibleKeys.forEach(function(key) {
      var text = segments[key] || '';
      if (!text) { result[key] = ''; stats[key] = 0; return; }

      var tokens = estimateTokens(text);
      var maxForSegment = Math.floor(totalBudget * (SEGMENT_MAX_RATIO[key] || 0.1));
      var allowed = Math.min(remaining, maxForSegment);

      if (tokens <= allowed) {
        result[key] = text;
        stats[key] = tokens;
        remaining -= tokens;
      } else {
        // 需要截断
        result[key] = truncateToTokens(text, allowed);
        stats[key] = estimateTokens(result[key]);
        remaining -= stats[key];
        truncated = true;
      }
    });

    return {
      allocated: result,
      stats: stats,
      truncated: truncated,
      totalTokens: totalUsed + flexibleKeys.reduce(function(sum, k) { return sum + (stats[k] || 0); }, 0),
      budget: totalBudget,
      modelLimit: modelLimit
    };
  }

  // ═══════════════════════════════════════════
  // 截断工具
  // ═══════════════════════════════════════════

  /**
   * truncateToTokens - 截断文本到指定 token 数以内
   * 优先在段落/句子边界截断，保留完整性
   */
  function truncateToTokens(text, maxTokens) {
    if (!text || maxTokens <= 0) return '';
    var currentTokens = estimateTokens(text);
    if (currentTokens <= maxTokens) return text;

    // 估算需要保留的字符数
    var ratio = maxTokens / currentTokens;
    var targetChars = Math.floor(text.length * ratio * 0.95); // 留 5% 余量

    // 尝试在段落边界截断
    var cut = text.substring(0, targetChars);
    var lastPara = cut.lastIndexOf('\n\n');
    if (lastPara > targetChars * 0.6) {
      cut = cut.substring(0, lastPara);
    } else {
      // 在句子边界截断
      var lastSentence = Math.max(
        cut.lastIndexOf('。'),
        cut.lastIndexOf('.\n'),
        cut.lastIndexOf('！'),
        cut.lastIndexOf('；')
      );
      if (lastSentence > targetChars * 0.7) {
        cut = cut.substring(0, lastSentence + 1);
      }
    }

    return cut + '\n[…已截断，原始内容约 ' + currentTokens + ' tokens]';
  }

  /**
   * truncateHistory - 对话历史智能截断
   * 保留最近 N 轮 + 最早 2 轮（保持上下文连贯）
   */
  function truncateHistory(messages, maxTokens) {
    if (!messages || !messages.length) return messages;
    var totalTokens = messages.reduce(function(sum, m) {
      return sum + estimateTokens(m.content || '');
    }, 0);
    if (totalTokens <= maxTokens) return messages;

    // 保留最近的消息，从后往前累加直到超限
    var kept = [];
    var usedTokens = 0;
    var keepRecent = Math.min(messages.length, 6); // 至少保留最近 3 轮(6条)

    // 从后往前
    for (var i = messages.length - 1; i >= 0; i--) {
      var msgTokens = estimateTokens(messages[i].content || '');
      if (usedTokens + msgTokens > maxTokens && kept.length >= keepRecent) break;
      kept.unshift(messages[i]);
      usedTokens += msgTokens;
    }

    // 如果截断了中间部分，插入摘要标记
    if (kept.length < messages.length) {
      var omitted = messages.length - kept.length;
      kept.unshift({
        role: 'system',
        content: '[上下文摘要：此前有 ' + omitted + ' 条消息被省略以控制上下文长度]'
      });
    }

    return kept;
  }

  // ═══════════════════════════════════════════
  // 便捷 API：构建带预算的系统提示
  // ═══════════════════════════════════════════

  /**
   * buildSystemPrompt - 将各段内容在预算内拼接为最终系统提示
   * @param {Object} parts - { base, time, project, memory, knowledge, lessons, mcpTools }
   * @param {Object} options - { model, maxTokens }
   * @returns {string} 拼接后的系统提示
   */
  function buildSystemPrompt(parts, options) {
    var segments = {
      system: parts.base || '',
      time: parts.time || '',
      project: parts.project || '',
      memory: parts.memory || '',
      knowledge: parts.knowledge || '',
      lessons: parts.lessons || '',
      mcpTools: parts.mcpTools || '',
      history: '',
      userMessage: ''
    };

    var result = allocate(segments, options);
    var a = result.allocated;

    // 按逻辑顺序拼接
    var finalParts = [
      a.system,
      a.time,
      a.project,
      a.memory,
      a.knowledge,
      a.lessons,
      a.mcpTools
    ].filter(function(s) { return s && s.trim(); });

    return finalParts.join('\n\n');
  }

  // ═══════════════════════════════════════════
  // 配置管理
  // ═══════════════════════════════════════════
  function getConfig() {
    return {
      defaultContextLimit: DEFAULT_CONTEXT_LIMIT,
      outputReserve: OUTPUT_RESERVE,
      modelLimits: MODEL_CONTEXT_LIMITS,
      segmentPriority: SEGMENT_PRIORITY,
      segmentMaxRatio: SEGMENT_MAX_RATIO
    };
  }

  function setModelLimit(modelKey, limit) {
    MODEL_CONTEXT_LIMITS[modelKey.toLowerCase()] = limit;
  }

  function setOutputReserve(tokens) {
    if (tokens > 0 && tokens < 32768) OUTPUT_RESERVE = tokens;
  }

  // ═══════════════════════════════════════════
  // P1-3: 滚动摘要——超长对话自动压缩
  // ═══════════════════════════════════════════
  var SUMMARY_THRESHOLD = 40;   // 超过 40 条消息触发摘要
  var SUMMARY_KEEP_RECENT = 10; // 保留最近 10 条不压缩
  var _summaryCache = {};       // sessionId -> { summary, compressedUpTo }

  /**
   * needsCompression - 检查对话历史是否需要压缩
   */
  function needsCompression(messages) {
    if (!messages || messages.length < SUMMARY_THRESHOLD) return false;
    var totalTokens = messages.reduce(function(sum, m) {
      return sum + estimateTokens(m.content || '');
    }, 0);
    // 超过 8000 tokens 的历史也触发压缩
    return totalTokens > 8000;
  }

  /**
   * compressHistory - 将旧消息压缩为摘要
   * @param {Array} messages - 完整对话历史 [{role, content}]
   * @param {string} sessionId - 会话 ID（用于缓存）
   * @param {Function} llmSummarize - async (text) => summaryText
   * @returns {Array} 压缩后的消息数组 [{role:'system', content:'[摘要]...'}, ...recent]
   */
  async function compressHistory(messages, sessionId, llmSummarize) {
    if (!messages || messages.length <= SUMMARY_KEEP_RECENT) return messages;

    var splitPoint = messages.length - SUMMARY_KEEP_RECENT;
    var oldMessages = messages.slice(0, splitPoint);
    var recentMessages = messages.slice(splitPoint);

    // 检查缓存：如果已经压缩过且没有新增旧消息
    var cached = _summaryCache[sessionId];
    if (cached && cached.compressedUpTo >= splitPoint) {
      var result = [{ role: 'system', content: '[对话历史摘要]\n' + cached.summary }];
      return result.concat(recentMessages);
    }

    // 构建待摘要文本
    var textToSummarize = oldMessages.map(function(m) {
      var prefix = m.role === 'user' ? '用户' : (m.role === 'assistant' ? 'AI' : '系统');
      return prefix + ': ' + (m.content || '').substring(0, 500);
    }).join('\n');

    // 截断到合理长度（避免摘要请求本身超限）
    var maxSummaryInput = 6000;
    if (estimateTokens(textToSummarize) > maxSummaryInput) {
      textToSummarize = truncateToTokens(textToSummarize, maxSummaryInput);
    }

    var summary;
    if (llmSummarize) {
      try {
        summary = await llmSummarize(
          '请将以下对话历史压缩为简洁摘要（200字以内），保留：关键决策、重要事实、用户偏好、未完成事项。\n\n' + textToSummarize
        );
      } catch (e) {
        summary = _fallbackSummary(oldMessages);
      }
    } else {
      summary = _fallbackSummary(oldMessages);
    }

    // 缓存
    _summaryCache[sessionId] = { summary: summary, compressedUpTo: splitPoint };

    var result = [{ role: 'system', content: '[对话历史摘要]\n' + summary }];
    return result.concat(recentMessages);
  }

  /**
   * _fallbackSummary - 无 LLM 时的简单摘要（提取关键句）
   */
  function _fallbackSummary(messages) {
    var keyPoints = [];
    messages.forEach(function(m) {
      var content = m.content || '';
      // 提取包含关键词的句子
      var sentences = content.split(/[。！？\n]/);
      sentences.forEach(function(s) {
        s = s.trim();
        if (s.length > 10 && s.length < 200 &&
            (s.includes('决定') || s.includes('需要') || s.includes('完成') ||
             s.includes('问题') || s.includes('方案') || s.includes('结论'))) {
          keyPoints.push(s);
        }
      });
    });
    if (keyPoints.length === 0) {
      return '此前有 ' + messages.length + ' 条对话消息（已省略）。';
    }
    return '此前对话要点：\n' + keyPoints.slice(0, 8).join('\n');
  }

  function clearSummaryCache(sessionId) {
    if (sessionId) delete _summaryCache[sessionId];
    else _summaryCache = {};
  }

  // ═══════════════════════════════════════════
  // Module init
  // ═══════════════════════════════════════════
  function init(_Core) {
    Core = _Core;
    Core.contextBudget = {
      estimateTokens: estimateTokens,
      getModelContextLimit: getModelContextLimit,
      allocate: allocate,
      truncateToTokens: truncateToTokens,
      truncateHistory: truncateHistory,
      buildSystemPrompt: buildSystemPrompt,
      getConfig: getConfig,
      setModelLimit: setModelLimit,
      setOutputReserve: setOutputReserve,
      needsCompression: needsCompression,
      compressHistory: compressHistory,
      clearSummaryCache: clearSummaryCache,
      SEGMENT_PRIORITY: SEGMENT_PRIORITY
    };
    console.log('[context-budget] initialized (default limit: ' + DEFAULT_CONTEXT_LIMIT + ' tokens)');
  }

  module.exports = { name: 'context-budget', dependencies: [], init: init };
})();
