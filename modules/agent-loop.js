// modules/agent-loop.js - Agent 智能体循环
// 从 api.js 提取，处理 Agent ReAct 循环、工具执行、JSON 提取等
const fs = require('fs');

let Core = null;

// ===== DSML 标记清理（DeepSeek V4 内部 Function Calling 标记）=====
// 兼容所有变体: <|DSML||...>、< | DSML | ...>、| DSML | ...> 等
function _stripDSML(text) {
  if (!text) return text;
  // 完整的 tool_calls 块（从 tool_calls 到 /tool_calls）
  text = text.replace(/<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*tool_calls[\s\S]*?<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*\/tool_calls\s*>?/gi, '');
  // 未闭合的 tool_calls 块（截断到末尾）
  text = text.replace(/<\s*\|{1,3}\s*DSML\s*\|{1,3}\s*tool_calls[\s\S]*$/gi, '');
  // 带 < 的单个 DSML 标记（允许 < 和 | 之间有空格）
  text = text.replace(/<\s*\|{1,3}\s*DSML\s*\|{0,3}\s*[^>\n]*>?/gi, '');
  // 不带 < 的管道符格式
  text = text.replace(/\|{1,3}\s*DSML\s*\|{0,3}\s*[^>\n]*>?/gi, '');
  return text;
}

// ===== Agent 系统提示词（强制中文 + 纯JSON）=====
const AGENT_SYSTEM_PROMPT = `你是一个中文AI智能体助手，可以自主思考并使用工具来完成用户任务。

【绝对规则 - 必须严格遵守】
1. 你的每一次回复必须且只能是纯JSON格式，绝对不能包含任何JSON之外的文字、说明、注释或解释
2. 所有最终回答内容必须是中文，绝对不能输出英文（代码中的关键字除外）
3. 不要输出 markdown 代码块标记（如 \`\`\`json），只输出纯JSON文本
4. 步骤说明和执行过程必须放在 complete 的 answer 参数中，用中文描述

【错误恢复规则 - 必须遵守】
5. 如果工具执行返回错误（包含 ❌、错误、error、failed、未找到、not found 等），你必须分析错误原因并尝试不同策略
6. 禁止用完全相同的参数重复调用同一个失败的工具
7. 替代策略示例：read_file失败→用list_dir查看目录；browser_click失败→用browser_execute执行JS
8. 如果连续两次工具失败，考虑用 run_python 编写脚本来完成任务，或向用户 ask_user 确认参数
9. web_search 可能不可用（返回"未启用"），此时应优先使用本地工具（run_command、run_python、read_file等）完成任务，不要反复尝试搜索
10. 【严禁编造数据】如果搜索结果中没有确切的数字（如股指点位、股价、开盘价、收盘价、涨跌幅、成交量等），绝对不允许编造一个"看起来合理"的数字，必须明确说明"未找到确切数据"。宁可承认不知道，也绝不给出虚假数字。引用数据时尽量注明来源和时间。
11. 【证据不足必须拒绝】如果搜索结果与用户问题无直接关联（如搜"现在几点"返回的是新闻文章），必须回复"未找到可靠信息"或"搜索结果与问题无关"，严禁从无关内容中推测、拼凑或"合理推断"出答案。
12. 【确定性数据用专用工具】时间/日期→get_current_time，数学计算→calculate，股票行情→stock_quote。这些数据有确定性来源，绝对不允许通过web_search获取或从网页文本中推断。
13. 【搜索结果相关性判断】使用搜索结果前，先判断结果是否与问题直接相关。如果搜索返回的内容只是"提到了相关关键词"但并未直接回答问题，不要将其作为答案依据，应换用更精确的关键词重新搜索或使用read_url抓取原文验证。

你可以使用以下工具（action名称）：
- get_current_time: 获取当前系统日期和时间（精确到秒）。【用户问时间、日期、星期几时必须用本工具，禁止用web_search】
  参数: {"timezone": "可选时区，默认Asia/Shanghai"}
- calculate: 精确计算数学表达式（加减乘除、幂、取模、Math方法）。【数学计算必须用本工具，禁止心算】
  参数: {"expression": "数学表达式，如(3+5)*2、Math.sqrt(144)"}
- web_search: 联网搜索，获取最新信息、实时数据、新闻
  参数: {"query": "搜索关键词"}
- read_url: 抓取网页内容，读取指定URL的网页正文
  参数: {"url": "网页URL地址"}
- web_crawl: 智能网页抓取（Playwright渲染+正文提取，支持SPA/动态页面）。比read_url更强：自动过滤广告导航、提取正文、支持递归爬取。需要高质量网页内容时优先使用。
  参数: {"url": "网页URL", "mode": "single|crawl", "max_pages": 10, "save_to_knowledge": false}
- read_file: 读取本地文件
  参数: {"path": "文件路径"}
- write_file: 写入本地文件
  参数: {"path": "文件路径", "content": "文件内容"}
- edit_file: 精确替换文件中的文本片段（查找old_text替换为new_text）
  参数: {"file_path": "文件路径", "old_text": "要替换的文本", "new_text": "替换后的文本", "replace_all": false}
- list_dir: 列出目录下的文件和子目录
  参数: {"dir_path": "目录路径"}
- search_files: 在目录中按文件名模式搜索文件
  参数: {"dir_path": "目录路径", "pattern": "glob模式如**/*.js"}
- file_info: 获取文件/目录的详细信息（大小、修改时间、类型）
  参数: {"file_path": "文件路径"}
- run_command: 执行系统命令（ls, cat, grep等）
  参数: {"command": "命令字符串", "cwd": "可选工作目录"}
- run_python: 执行Python代码
  参数: {"code": "Python代码"}
- browser_navigate: 打开浏览器并导航到网页（可渲染JS页面）
  参数: {"url": "网页URL"}
- browser_click: 点击页面上的元素
  参数: {"selector": "CSS选择器"}
- browser_type: 在页面输入框中输入文本
  参数: {"selector": "CSS选择器", "text": "文本内容"}
- browser_extract: 从页面提取内容（text/html/links/forms/info）
  参数: {"type": "text|html|links|forms|info", "selector": "可选CSS选择器"}
- browser_screenshot: 截取当前页面的屏幕截图
  参数: {"full_page": true/false}
- browser_wait: 等待页面加载或指定时间
  参数: {"selector": "可选等待元素", "timeout": 5000}
- github_pr: GitHub Pull Request 操作（list/view/create/diff/merge/checks）
  参数: {"action": "list|view|create|diff|merge|checks", "number": PR编号, "title": "标题"}
- github_issue: GitHub Issue 操作（list/view/create/close/comment）
  参数: {"action": "list|view|create|close|comment", "number": Issue编号, "title": "标题"}
- github_repo: 查看当前 GitHub 仓库信息
  参数: {}
- github_release: 管理 GitHub Release（list/view/create）
  参数: {"action": "list|view|create", "tag": "标签名", "title": "标题"}
- image_search: 搜索网络图片（DuckDuckGo/Bing/Unsplash）
  参数: {"query": "搜索关键词", "provider": "duckduckgo|bing|unsplash", "count": 5}
- image_download: 下载图片到本地
  参数: {"url": "图片URL", "dest": "保存路径"}
- stock_quote: 查询A股实时行情（指数/个股），返回现价、涨跌幅、开盘收盘、最高最低、成交量额和行情时间。数据来源腾讯行情接口，数字准确。【查询股指点位、开盘收盘、涨跌幅等行情时必须优先使用本工具，禁止用 web_search 猜测或编造数字】
  参数: {"query": "代码或名称，逗号分隔多个。如 上证指数 / 600519 / 贵州茅台,宁德时代"}
- ask_user: 向用户提问，收集偏好或确认信息（暂停执行等待回答）
  参数: {"question": "问题文本", "options": [{"label":"选项A","description":"说明"}], "multiSelect": false}
- parallel_execute: 并行执行多个工具（适用于互不依赖的子任务）
  参数: {"tasks": [{"action": "工具名", "params": {...}}, ...]}
- handoff_to_agent: 将子任务委派给专业代理执行（适合需要专业领域知识的子任务）
  参数: {"target": "code|research|writer|math|translate", "task": "任务描述", "context": "可选背景信息"}
- deep_research: 深度研究——自动拆解问题→并行检索多来源→深度阅读→撰写带引用的结构化报告。适合需要全面调研的复杂主题，耗时2-5分钟
  参数: {"topic": "研究主题", "format": "markdown|word"}
- complete: 任务完成，给出最终回答
  参数: {"answer": "最终回答内容（必须是中文）"}

【自然语言直达 - 用户无需使用斜杠命令】
用户可以用自然语言触发你的所有能力，例如：
- "帮我搜一下最新的React文档" → web_search + read_url
- "分析这张图片" → 图片理解
- "查一下上证指数" → stock_quote
- "现在几点了" → get_current_time
- "帮我写个Python脚本计算斐波那契" → run_python
- "深入研究一下量子计算的最新进展" → deep_research
你应主动识别用户意图并选择最合适的工具，无需用户显式指定命令。

【回复格式 - 每次只能输出这个JSON，前后不要有任何文字】
{"action": "工具名", "params": {"参数": "值"}}

【示例 - 用户问"查看桌面有哪些文件"，你的回复必须是】
{"action": "run_command", "params": {"command": "dir %USERPROFILE%\\Desktop"}}

【获取结果后，你的回复必须是】
{"action": "complete", "params": {"answer": "你的桌面上有以下文件：..."}}`;


// ===== JSON提取（多重容错 + 调试）=====
function extractJSONFromText(text) {
  if (!text || typeof text !== 'string') {
    console.log('❌ extractJSON: text为空或非字符串');
    return null;
  }
  const trimmed = text.trim();
  
  // 尝试1：直接解析纯JSON（trim后以{开头以}结尾）
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const result = JSON.parse(trimmed);
      return result;
    } catch (e) { console.warn('⚠️ [agent-loop] 操作失败:', e.message || e); }
  }
  
  // 尝试2：提取 ```json 代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const result = JSON.parse(codeBlockMatch[1].trim());
      return result;
    } catch (e) { console.warn('⚠️ [agent-loop] 操作失败:', e.message || e); }
  }
  
  // 尝试3：提取第一个完整JSON对象（括号匹配，处理多个JSON拼接）
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let endPos = -1;
    for (let i = firstBrace; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos !== -1) {
      const jsonStr = text.substring(firstBrace, endPos + 1);
      try {
        const result = JSON.parse(jsonStr);
        return result;
      } catch (e) { console.warn('⚠️ [agent-loop] 操作失败:', e.message || e); }
    }
  }
  
  // 尝试4：正则匹配最外层 { ... "action" ... }
  const actionMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"[^"]+"[\s\S]*?\}/);
  if (actionMatch) {
    try {
      const result = JSON.parse(actionMatch[0]);
      return result;
    } catch (e) { console.warn('⚠️ [agent-loop] 操作失败:', e.message || e); }
  }
  
  return null;
}


// ===== Agent 步骤名称中文翻译 =====
var ACTION_ZH_MAP = {
  'get_current_time': '获取时间',
  'calculate': '数学计算',
  'web_search': '联网搜索',
  'read_file': '读取文件',
  'write_file': '写入文件',
  'edit_file': '编辑文件',
  'list_dir': '列出目录',
  'search_files': '搜索文件',
  'run_command': '执行命令',
  'run_python': '运行Python',
  'browser_navigate': '浏览网页',
  'ask_user': '询问用户',
  'parallel_execute': '并行执行',
  'complete': '完成任务',
  'memory_search': '记忆检索',
  'knowledge_search': '知识检索',
  'stock_quote': '行情查询',
  'deep_research': '深度研究',
  'web_crawl': '网页爬取',
  // MCP 本地工具
  'list_directory': '列出目录',
  'execute_command': '执行命令',
  'get_system_info': '系统信息',
  'open_browser': '打开浏览器',
  'handoff_to_agent': '委派代理',
};
function translateAction(action) {
  if (ACTION_ZH_MAP[action]) return ACTION_ZH_MAP[action];
  // 动态查询 MCP 工具描述作为步骤名
  if (Core && Core.mcp && Core.mcp.enabled && Core.mcp.enabled()) {
    try {
      var tools = Core.mcp.getAllTools();
      for (var i = 0; i < tools.length; i++) {
        if (tools[i].name === action) return tools[i].description || action;
      }
    } catch (e) { /* ignore */ }
  }
  return action;
}

// ===== 最终回答清理（合并 5 个冗余清理块）=====
function cleanFinalAnswer(text) {
  if (!text) return text;

  // 0. 过滤 DSML 标记（DeepSeek V4 内部标记，可能以多种管道符格式出现）
  text = _stripDSML(text);
  text = text.trim();
  if (!text) return text;

  // 1. 如果是JSON，尝试提取 complete.action 字段
  if (text.trim().startsWith('{')) {
    var parsed = extractJSONFromText(text);
    if (parsed) {
      var extracted = '';
      if (parsed.action === 'complete' && parsed.params) {
        extracted = parsed.params.answer || parsed.params.result || parsed.params.content || '';
      }
      if (!extracted && parsed.answer) extracted = parsed.answer;
      if (!extracted && parsed.params && parsed.params.answer) extracted = parsed.params.answer;
      if (extracted) text = extracted;
    }
  }

  // 2. 如果仍包含 "answer" 字段，用正则提取
  if (text.includes('"answer"')) {
    var answerMatch = text.match(/"answer"\s*:\s*"((?:[^"]|\\.){5,})"/);
    if (answerMatch) {
      text = answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  }

  // 3. 如果还残留JSON关键字（action/params），提取中文内容
  if (text.includes('"action"') || text.includes('"params"')) {
    var cleaned = text.replace(/\{[^{}]*\}/g, '').replace(/"[^"]*":\s*/g, '');
    var cnMatch = cleaned.match(/[\u4e00-\u9fa5].*[\u4e00-\u9fa5]/s);
    if (cnMatch && cnMatch[0].length > 5) {
      text = cnMatch[0];
    }
  }

  // 4. 去除末尾残留的JSON符号和空白
  text = text.replace(/["\}\{\]\[]+[a-zA-Z\s]*$/g, '');
  text = text.replace(/\s+$/, '');

  return text;
}


// ===== 工具结果规范化：统一 ToolResult 格式 =====
// 所有工具返回可能不一致（string/object/null/Error），此函数确保下游处理安全
function normalizeToolResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result instanceof Error) return '❌ ' + result.message;
  try { return JSON.stringify(result, null, 2); } catch (e) { return String(result); }
}

// ===== 工具错误判定（基于结果前缀，替代全文关键词匹配）=====
// 旧逻辑对工具返回的【完整内容】做子串匹配，导致 read_file / search_files / run_command / run_python
// 返回的聊天记录、日志、命令输出里天然含有"错误、失败、error、未找到、无法"等词时，
// 把【成功】的工具调用误判为失败，触发无意义的"自动纠错"重试，错误率虚高。
// 实际上 tools.js 的所有工具已统一用开头表情标记成败：失败以 ❌ / ⛔ 开头，成功以 ✅ / 🔍 找到 / 📋 等开头，
// 因此判定应读取这个前缀标记，而不是扫描内容。
var TOOL_FAIL_PREFIXES = ['❌', '⛔'];
var TOOL_SUCCESS_PREFIXES = ['✅', '🔍 找到', '📋', '🌐', '🔄', '⚡', '💬', '🛡️', '{', '['];
// 仅用于无前缀的未知格式结果（如浏览器原始返回），且只检查首行，避免匹配到数据内容
var TOOL_HEAD_ERROR_PATTERNS = ['error:', 'error：', 'failed:', 'failed：', 'traceback (most recent call last)', 'exception:', 'enoent', 'permission denied', 'is not recognized', 'command failed'];

function detectToolError(toolResultStr) {
  if (!toolResultStr) return false;
  var t = String(toolResultStr).trim();
  if (!t) return false;
  // 1) 明确的失败前缀 → 判定为错误
  for (var i = 0; i < TOOL_FAIL_PREFIXES.length; i++) {
    if (t.indexOf(TOOL_FAIL_PREFIXES[i]) === 0) return true;
  }
  // 2) 明确的成功前缀 → 即使内容里出现错误关键词，也不算工具失败
  for (var j = 0; j < TOOL_SUCCESS_PREFIXES.length; j++) {
    if (t.indexOf(TOOL_SUCCESS_PREFIXES[j]) === 0) return false;
  }
  // 3) 无前缀（未知格式）：仅对首行做高置信度错误特征匹配
  var firstLine = t.split('\n')[0].toLowerCase();
  for (var k = 0; k < TOOL_HEAD_ERROR_PATTERNS.length; k++) {
    if (firstLine.indexOf(TOOL_HEAD_ERROR_PATTERNS[k]) !== -1) return true;
  }
  return false;
}

// ===== Agent 工具执行（MCP + toolsRegistry 统一调度）=====
async function _executeAgentActionRaw(action, params) {
  // 优先级 1：通过 toolsRegistry 执行（tools.js，含路径白名单 + 安全检查）
  if (Core.toolsRegistry && typeof Core.toolsRegistry.executeTool === 'function') {
    // 将 Agent 的参数名映射到 toolsRegistry 的参数名
    const mappedParams = { ...params };
    if (action === 'read_file' && params.path && !params.file_path) {
      mappedParams.file_path = params.path;
    }
    if (action === 'write_file' && params.path && !params.file_path) {
      mappedParams.file_path = params.path;
    }
    if (action === 'run_python' && params.code) {
      try {
        const result = await Core.toolsRegistry.executeTool('run_python', { code: params.code });
        return result;
      } catch (e) {
        return 'Python执行失败: ' + e.message;
      }
    }
    if (['read_file', 'write_file', 'list_dir', 'read_url', 'search_files', 'edit_file', 'file_info',
         'run_command',
         'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_extract', 'browser_wait',
         'github_pr', 'github_issue', 'github_repo', 'github_release',
         'image_search', 'image_download', 'stock_quote', 'deep_research',
         'get_current_time', 'calculate', 'web_crawl'].includes(action)) {
      try {
        const result = await Core.toolsRegistry.executeTool(action, mappedParams);
        return result;
      } catch (e) {
        console.warn('⚠️ [api] toolsRegistry 执行工具 "' + action + '" 失败，尝试其他方式:', e.message);
      }
    }
  }

  // 优先级 2：MCP 外部工具（如果可用）
  if (Core.mcp && Core.mcp.enabled && Core.mcp.enabled()) {
    try {
      const result = await Core.mcp.callTool(action, params);
      if (result.success) {
        return JSON.stringify(result, null, 2);
      }
    } catch (e) {
      console.warn('⚠️ [api] MCP 调用 "' + action + '" 失败，回退到内置逻辑:', e.message);
    }
  }

  // 优先级 3：内置工具逻辑（兜底）
  switch (action) {
    case 'web_search':
      if (!Core.webSearch) return '联网搜索功能未启用';
      try { return await Core.webSearch(params.query || ''); } catch (e) { return '搜索失败: ' + e.message; }
    case 'handoff_to_agent':
      if (Core.handoff && Core.handoff.executeHandoff) {
        return await Core.handoff.executeHandoff(params.target, params.task, params.context || '');
      }
      return '❌ Handoff 模块未加载';
    case 'read_file':
      try { return fs.readFileSync(params.path, 'utf8'); } catch (e) { return '读取失败: ' + e.message; }
    case 'write_file':
      try { fs.writeFileSync(params.path, params.content, 'utf8'); return '文件写入成功'; } catch (e) { return '写入失败: ' + e.message; }
    default:
      return '未知工具: ' + action;
  }
}


// 规范化包装器：确保所有调用者（顺序路径 + parallel_execute）都收到字符串结果
async function executeAgentAction(action, params) {
  // Guardrails Layer 3: 工具执行守卫
  if (Core.guardrails) {
    var toolCheck = Core.guardrails.checkToolExecution(action, params);
    if (!toolCheck.safe) {
      return '🛡️ 工具执行被安全策略阻止: ' + toolCheck.reason;
    }
    if (toolCheck.warning) console.warn(toolCheck.warning);
  }
  var _startTime = Date.now();
  try {
    var raw = await _executeAgentActionRaw(action, params);
    var result = normalizeToolResult(raw);
    // 可观测性：记录工具调用
    if (Core.observability && Core.observability.trackTool) {
      Core.observability.trackTool(action, params, result, Date.now() - _startTime);
    }
    return result;
  } catch (e) {
    if (Core.observability && Core.observability.trackTool) {
      Core.observability.trackTool(action, params, '❌ ' + e.message, Date.now() - _startTime);
    }
    return '❌ 工具 "' + action + '" 执行异常: ' + e.message;
  }
}

// ===== Agent 回答质量评估（Evaluator-Optimizer 模式）=====
function evaluateAnswer(answer) {
  if (!answer || typeof answer !== 'string') return { pass: false, reason: '回答为空' };
  var trimmed = answer.trim();
  if (trimmed.length < 10) return { pass: false, reason: '回答太短（' + trimmed.length + '字符）' };
  var apologyOnly = /^(抱歉|对不起|很遗憾|不好意思|sorry|I'?m sorry|I cannot|I can'?t)[。，.!！]?$/i.test(trimmed);
  if (apologyOnly) return { pass: false, reason: '仅包含道歉，无实质内容' };
  var jsonRemnants = /"action"\s*:\s*"(?!complete)/.test(trimmed) || /"params"\s*:\s*\{/.test(trimmed);
  if (jsonRemnants) return { pass: false, reason: '包含未清理的工具调用 JSON 残留' };
  var pureError = /^❌\s*Agent\s*执行出错/.test(trimmed) && !/建议/.test(trimmed);
  if (pureError) return { pass: false, reason: '仅包含错误信息，无解决建议' };
  var fallbackOnly = trimmed === '抱歉，AI 返回的格式不正确，无法解析结果。请重试。';
  if (fallbackOnly) return { pass: false, reason: '格式化失败的兆底文案' };
  return { pass: true, reason: '' };
}

// ⏰ 时间意图预检：用户问"现在几点/今天几号/星期几"时，直接调用确定性工具 get_current_time，
// 把权威时间作为硬事实前置注入任务，杜绝模型走 web_search 抓到过期网页快照（如 Time.is 缓存时间）。
// 在 sendToAgent 入口统一处理，状态机路径与传统循环路径都生效。
var _TIME_INTENT_RE = /(现在几点|几点了|几点钟|什么时间|现在时间|当前时间|今天几号|几月几号|星期几|今天日期|什么日期|now what time|what time is it|current time|today'?s date)/i;

async function _injectAuthoritativeTime(task) {
  if (!task || typeof task !== 'string' || !_TIME_INTENT_RE.test(task)) return task;
  try {
    if (Core && Core.toolsRegistry && typeof Core.toolsRegistry.executeTool === 'function') {
      var timeResult = await Core.toolsRegistry.executeTool('get_current_time', {});
      if (timeResult && typeof timeResult === 'string' && timeResult.indexOf('当前') > -1) {
        return '【权威时间事实（必须采用，禁止用 web_search 核对或推断时间）】' + timeResult + '\n\n用户任务：' + task;
      }
    }
  } catch (e) { /* 注入失败不阻断主流程，回退到提示词内的时间规则 */ }
  return task;
}
// ===== Agent 智能体循环 =====
async function sendToAgent(task, isDeepThink) {
  // ⏰ 时间类问题先注入权威时间，避免模型用 web_search 抓到过期时间快照
  task = await _injectAuthoritativeTime(task);
  var _cfgMaxSteps = (Core && Core.config && Core.config.maxAgentSteps) || 20;
  const maxSteps = isDeepThink ? (_cfgMaxSteps * 2) : _cfgMaxSteps;
  let context = '';
  let step = 0;
  let finalAnswer = '';
  let stepsLog = [];
  let _agentCancelled = false;
  let _searchCount = 0;  // 🔧 联网搜索计数，防止无限搜索
  let _stepStartTimes = {};

  // 🔧 标记生成开始，按钮变为停止
  Core._setGeneratingState(true);
  Core._agentRunning = true;
  Core.emit('typingStart');

  // 创建 Agent 消息div
  const agentDiv = document.createElement('div');
  agentDiv.className = 'msg ai';
  if (Core.config.chatBubbleAI) agentDiv.style.backgroundColor = Core.config.chatBubbleAI;
  // 🔧 实时步骤面板：每步追加，不再覆盖
  var stepsContainer = document.createElement('div');
  stepsContainer.className = 'agent-steps-live';
  stepsContainer.style.cssText = 'margin-bottom:8px;';

  // 状态行 + 取消按钮
  var statusRow = document.createElement('div');
  statusRow.className = 'agent-status-row';
  statusRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;padding-right:110px;';
  var statusSpan = document.createElement('span');
  statusSpan.className = 'typing-cursor';
  statusSpan.style.cssText = 'flex:1;';
  statusSpan.textContent = '🤔 Agent 正在思考...';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'agent-cancel-btn';
  cancelBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;">stop_circle</span> 取消';
  cancelBtn.onclick = function() {
    _agentCancelled = true;
    this.disabled = true;
    this.textContent = '已取消';
    this.style.opacity = '0.5';
    this.style.cursor = 'default';
    statusSpan.textContent = '⏹ 正在取消...';
  };
  statusRow.appendChild(statusSpan);
  statusRow.appendChild(cancelBtn);
  agentDiv.appendChild(statusRow);
  agentDiv.appendChild(stepsContainer);
  Core.dom.chatContainer.appendChild(agentDiv);
  Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;

  // ===== 状态机路径（优先）或传统循环路径（兜底）=====
  if (Core.workflow && Core.workflow.stateMachine) {
    // 状态机回调：更新 UI DOM
    var _currentStepRow = null;
    var _timerInterval = null;
    var _smConfig = {
      isDeepThink: isDeepThink,
      cancelCheck: function() { return _agentCancelled; },
      onStepStart: function(s, phase, actionName) {
        statusSpan.className = 'typing-cursor';
        if (phase === 'THINK') {
          statusSpan.textContent = '🤔 步骤 ' + s + '/' + maxSteps + '：思考中...';
          if (Core.emit) Core.emit('agent-think', { step: s, maxSteps: maxSteps }); // 🖥️ HUD 状态
        } else if (phase === 'ACT' && actionName) {
          statusSpan.textContent = '🛠️ 执行: ' + actionName + '...';
          if (Core.emit) Core.emit('agent-tool', { action: actionName, step: s, maxSteps: maxSteps }); // 🖥️ HUD 状态
          _currentStepRow = document.createElement('div');
          _currentStepRow.className = 'agent-step-live';
          _currentStepRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;margin:3px 0;font-size:12px;color:var(--text-secondary);border-left:3px solid var(--primary);border-radius:4px;background:rgba(59,130,246,0.05);';
          var _smLeft = document.createElement('div');
          var _smStepLabel = document.createElement('span');
          _smStepLabel.style.cssText = 'color:var(--primary);font-weight:600;';
          _smStepLabel.textContent = '\u6B65\u9AA4 ' + s;
          var _smActionLabel = document.createElement('span');
          _smActionLabel.style.cssText = 'font-weight:500;color:var(--text);margin-left:4px;';
          _smActionLabel.textContent = actionName;
          var _smStatusIcon = document.createElement('span');
          _smStatusIcon.style.fontSize = '10px';
          _smStatusIcon.className = 'typing-cursor';
          _smStatusIcon.textContent = '\u23F3';
          _smLeft.appendChild(_smStepLabel);
          _smLeft.appendChild(_smActionLabel);
          _smLeft.appendChild(_smStatusIcon);
          var _smTimer = document.createElement('span');
          _smTimer.style.cssText = 'font-size:10px;color:var(--text-secondary);opacity:0.7;';
          _currentStepRow.appendChild(_smLeft);
          _currentStepRow.appendChild(_smTimer);
          var timerSpan = _smTimer;
          _timerInterval = setInterval(function() {
            var elapsed = ((Date.now() - (_stepStartTimes[s] || Date.now())) / 1000).toFixed(1);
            if (timerSpan) timerSpan.textContent = elapsed + 's';
          }, 200);
          stepsContainer.appendChild(_currentStepRow);
          Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;
        }
      },
      onStepComplete: function(s, actionName, success) {
        if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
        if (_currentStepRow) {
          var stepElapsed = ((Date.now() - (_stepStartTimes[s] || Date.now())) / 1000).toFixed(1);
          if (success) {
            _currentStepRow.style.borderLeftColor = '#22c55e';
            _smStatusIcon.className = '';
            _smStatusIcon.textContent = '\u2705';
            _smTimer.textContent = stepElapsed + 's';
            _smTimer.style.color = '#22c55e';
          }
        }
      },
      onToolError: function(s, actionName, errText) {
        if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
        if (_currentStepRow) {
          _currentStepRow.style.borderLeftColor = '#ef4444';
          _smStatusIcon.className = '';
          _smStatusIcon.textContent = '\u274C';
          var _smErrHint = document.createElement('span');
          _smErrHint.style.cssText = 'font-size:10px;color:#ef4444;margin-left:4px;';
          _smErrHint.textContent = '\u81EA\u52A8\u7EA0\u9519\u4E2D';
          _smLeft.appendChild(_smErrHint);
          _smTimer.textContent = ((Date.now() - (_stepStartTimes[s] || Date.now())) / 1000).toFixed(1) + 's';
          _smTimer.style.color = '#ef4444';
        }
      },
      onStateChange: function(from, to) {
        console.log('[Agent] State: ' + from + ' → ' + (to || 'END'));
      }
    };
    var machine = Core.workflow.stateMachine.createMachine(task, _smConfig);
    var smResult = await Core.workflow.stateMachine.runMachine(machine);
    finalAnswer = smResult.reply;
    stepsLog = smResult.stepsLog;
    step = smResult.steps;
  } else {
  // ===== 传统循环路径（兜底）=====
  while (step < maxSteps) {
    step++;
    if (_agentCancelled) { console.log('⏹ Agent 已被用户取消'); break; }
    _stepStartTimes[step] = Date.now();
    // 更新状态行
    statusSpan.className = 'typing-cursor';
    statusSpan.textContent = '🤔 步骤 ' + step + '/' + maxSteps + '：思考中...';

    // 🔧 限制 context 长度，防止多步累积后 API 请求体过大导致 400 错误
    // 🔧 B10: 截断时保留早期步骤的错误摘要，避免 Agent 重复调用失败工具
    var trimmedContext = context || '';
    if (trimmedContext.length > 12000) {
      var _cutPart = trimmedContext.substring(0, trimmedContext.length - 10000);
      var _errSummary = '';
      // 提取被截断部分的错误信息
      var _errMatches = _cutPart.match(/\[步骤\d+\][\s\S]*?(?:❌|失败|错误|error|Error)[^\n]*/g);
      if (_errMatches && _errMatches.length > 0) {
        _errSummary = '⚠️ 早期步骤错误摘要:\n' + _errMatches.slice(-5).join('\n') + '\n\n';
      }
      trimmedContext = '...(早期步骤已省略)...\n' + _errSummary + trimmedContext.substring(trimmedContext.length - 10000);
    }
    const prompt = `任务：${task}\n\n历史执行记录：${trimmedContext || '（无）'}\n\n请决定下一步行动。注意：只输出纯JSON，不要有任何其他文字。`;

    let reply = '';
    try {
      // 📁 Agent 模式也注入项目上下文 + 增强记忆
      var agentPrompt = AGENT_SYSTEM_PROMPT;
      // ⏰ 注入当前时间：让 Agent 知道"现在"，才能判断市场是否开盘、数据是否过期，避免编造开盘/收盘点位、混淆日期
      var _nowDt = new Date();
      var _weekDayNames = ['日','一','二','三','四','五','六'];
      agentPrompt += '\n\n【当前时间】现在是 ' + _nowDt.getFullYear() + '年' + (_nowDt.getMonth() + 1) + '月' + _nowDt.getDate() + '日 星期' + _weekDayNames[_nowDt.getDay()] + ' ' + String(_nowDt.getHours()).padStart(2, '0') + ':' + String(_nowDt.getMinutes()).padStart(2, '0') + '。请基于这个时间点判断信息时效性：A股交易时段为工作日 9:30-15:00，非交易时段（如凌晨、深夜、周末）不存在当天的开盘/收盘数据，不要编造。';
      if (Core.projectContext && Core.projectContext.hasContext()) {
        var pCtx = Core.projectContext.getContextString();
        if (pCtx) agentPrompt += pCtx;
      }
      // 🔍 查询改写：将指代性任务描述转为完整查询，提升记忆/知识召回精度
      var agentSearchQuery = task;
      if (Core.queryRewriter) {
        try {
          var agentRw = await Core.queryRewriter.rewrite(task);
          if (agentRw.changed) agentSearchQuery = agentRw.rewritten;
        } catch (e) { /* 改写失败不影响主流程 */ }
      }
      if (Core.memoryEnhance && Core.memoryEnhance.getEnhancedContext) {
        var memCtx = await Core.memoryEnhance.getEnhancedContext(agentSearchQuery);
        if (memCtx) agentPrompt += '\n\n' + memCtx;
      }
      // 📚 注入历史经验教训：避免 Agent 重复犯同样的错误（如 ComfyUI 未启动、CUDA OOM 等）
      if (Core.knowledgeDistill && Core.knowledgeDistill.getRelevantLessons) {
        var lessons = Core.knowledgeDistill.getRelevantLessons(null, agentSearchQuery);
        if (lessons && lessons.length > 0) {
          agentPrompt += Core.knowledgeDistill.formatLessonsForPrompt(lessons);
        }
      }
      // 🔌 动态注入 MCP 外部工具：让 Agent 知道可以调用哪些 MCP 注册的工具
      if (Core.mcp && Core.mcp.enabled && Core.mcp.enabled()) {
        try {
          var mcpTools = Core.mcp.getAllTools();
          // 过滤掉已在静态提示词中列出的内置工具，只注入额外的 MCP 工具
          var builtinNames = ['web_search','read_url','read_file','write_file','edit_file','list_dir','search_files','file_info','run_command','run_python','browser_navigate','browser_click','browser_type','browser_extract','browser_screenshot','browser_wait','github_pr','github_issue','github_repo','github_release','image_search','image_download','stock_quote','ask_user','parallel_execute','handoff_to_agent','deep_research','complete'];
          var extraTools = mcpTools.filter(function(t) { return builtinNames.indexOf(t.name) < 0; });
          if (extraTools.length > 0) {
            agentPrompt += '\n\n【MCP 扩展工具】以下是通过 MCP 协议注册的额外工具，调用方式与内置工具相同：\n';
            extraTools.forEach(function(t) {
              agentPrompt += '- ' + t.name + ': ' + (t.description || '无描述') + '\n';
              if (t.schema && t.schema.properties) {
                agentPrompt += '  参数: ' + JSON.stringify(t.schema.properties) + '\n';
              }
            });
          }
        } catch (e) { console.warn('[agent-loop] MCP 工具列表注入失败:', e.message); }
      }
      // 🔧 使用用户当前选择的模型/提供商，而非硬编码 ollama
      var agentProvider = 'ollama';
      var agentModel = null;
      if (Core.dom && Core.dom.modelSelect && Core.dom.modelSelect.value) {
        var selVal = Core.dom.modelSelect.value;
        if (selVal.includes(':')) {
          var colonIdx = selVal.indexOf(':');
          agentProvider = selVal.substring(0, colonIdx);
          agentModel = selVal.substring(colonIdx + 1);
        }
      }
      const data = await Core.api.callAPI(prompt, agentPrompt, 0.7, agentModel, agentProvider, null, { disableTools: true });
      reply = (data.message && data.message.content) || data.response || '';
      // 🔧 立即过滤 DSML 标记（DeepSeek V4 可能在 JSON 前输出 | DSML | tool_calls> 等标记）
      reply = _stripDSML(reply).trim();
    } catch (err) {
      finalAnswer = '❌ Agent 执行出错：' + err.message + '\n\n可能原因：\n1. 模型服务未启动或 API Key 未配置\n2. 当前选择的模型不可用\n\n建议：检查设置中的模型配置，或切换到其他可用模型。';
      // 📡 Gateway 桥接：Agent 模型调用失败的真实现场。agent-loop 内部吞掉异常（返回 success:true），api.js 的 catch 够不到，须在此处补发 'ai:error'，回传结构化错误帧给 WS 客户端
      if (Core.emit) Core.emit('ai:error', { message: err.message || 'Agent 模型调用失败', context: 'agent', time: Date.now() });
      break;
    }

    // 解析JSON action
    const action = extractJSONFromText(reply);

    if (!action || !action.action) {
      const chineseMatch = reply.match(/[一-龥　-〿＀-￯].{10,}/);
      if (chineseMatch) {
        finalAnswer = chineseMatch[0];
      } else {
        const answerMatch = reply.match(/"answer"\s*:\s*"([^"]{5,})"/);
        if (answerMatch) {
          finalAnswer = answerMatch[1];
        } else {
          finalAnswer = '抱歉，AI 返回的格式不正确，无法解析结果。请重试。';
        }
      }
      break;
    }

    if (action.action === 'complete') {
      let answer = '';
      if (action.params) {
        answer = action.params.answer || action.params.result || action.params.content || '';
      }
      if (!answer && action.answer) answer = action.answer;
      if (!answer && action.result) answer = action.result;
      finalAnswer = answer || reply;
      break;
    }

    // 交互式问答：向用户提问并等待回答
    if (action.action === 'ask_user' && action.params) {
      if (Core.askUser && typeof Core.askUser.ask === 'function') {
        statusSpan.textContent = '❓ 等待用户回答...';
        // 在 agent 消息区域内显示问答 UI
        var askResult = await Core.askUser.ask({
          question: action.params.question || action.params.text || '请选择',
          options: Array.isArray(action.params.options) ? action.params.options : [],
          multiSelect: !!action.params.multiSelect,
          header: action.params.header || ''
        }, stepsContainer);

        var formattedAnswer = Core.askUser.formatAnswer(askResult);
        context += '\n[步骤' + step + '] 向用户提问: ' + (action.params.question || '') + '\n用户回答: ' + formattedAnswer;
        stepsLog.push({ step: step, action: 'ask_user', params: action.params, result: formattedAnswer, time: Date.now() - (_stepStartTimes[step] || Date.now()), success: true });

        // 更新步骤行状态
        var askRow = document.createElement('div');
        askRow.className = 'agent-step-live';
        askRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;margin:3px 0;font-size:12px;color:var(--text-secondary);border-left:3px solid #8b5cf6;border-radius:4px;background:rgba(139,92,246,0.05);';
        askRow.innerHTML = '<div><span style="color:#8b5cf6;font-weight:600;">步骤 ' + step + '</span> <span style="font-weight:500;color:var(--text);">ask_user</span> ✅</div><span style="font-size:10px;color:#8b5cf6;opacity:0.8;">' + formattedAnswer.substring(0, 60) + '</span>';
        stepsContainer.appendChild(askRow);
        statusSpan.textContent = '🤖 继续执行...';
        continue;
      }
    }

    // 并行执行多个子任务
    if (action.action === 'parallel_execute' && action.params && Array.isArray(action.params.tasks)) {
      var tasks = action.params.tasks.slice(0, 5); // 最多 5 个并行
      statusSpan.textContent = '⚡ 并行执行 ' + tasks.length + ' 个子任务...';
      var parallelResults = await Promise.all(tasks.map(function(subtask) {
        return executeAgentAction(subtask.action, subtask.params || {}).catch(function(e) { return '错误: ' + e.message; });
      }));
      var combinedResult = '并行执行结果（' + tasks.length + ' 个子任务）：\n';
      tasks.forEach(function(subtask, idx) {
        combinedResult += '\n--- 子任务 ' + (idx + 1) + ': ' + subtask.action + ' ---\n';
        combinedResult += (parallelResults[idx] || '无结果').substring(0, 400) + '\n';
      });
      context += '\n[步骤' + step + '] 并行执行 ' + tasks.length + ' 个子任务\n' + combinedResult.substring(0, 600);
      stepsLog.push({ step: step, action: 'parallel_execute', params: action.params, result: combinedResult.substring(0, 500), time: Date.now() - (_stepStartTimes[step] || Date.now()), success: true });
      continue;
    }

    // 执行工具 — 追加步骤行（含实时计时）
    statusSpan.textContent = '🛠️ 执行: ' + action.action + '...';
    if (Core.emit) Core.emit('agent-tool', { action: action.action, step: step, maxSteps: maxSteps }); // 🖥️ HUD 状态
    var stepRow = document.createElement('div');
    stepRow.className = 'agent-step-live';
    stepRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;margin:3px 0;font-size:12px;color:var(--text-secondary);border-left:3px solid var(--primary);border-radius:4px;background:rgba(59,130,246,0.05);';
    var _lpLeft = document.createElement('div');
    var _lpStepLabel = document.createElement('span');
    _lpStepLabel.style.cssText = 'color:var(--primary);font-weight:600;';
    _lpStepLabel.textContent = '\u6B65\u9AA4 ' + step;
    var _lpActionLabel = document.createElement('span');
    _lpActionLabel.style.cssText = 'font-weight:500;color:var(--text);margin-left:4px;';
    _lpActionLabel.textContent = translateAction(action.action);
    var _lpStatusIcon = document.createElement('span');
    _lpStatusIcon.style.fontSize = '10px';
    _lpStatusIcon.className = 'typing-cursor';
    _lpStatusIcon.textContent = '\u23F3';
    _lpLeft.appendChild(_lpStepLabel);
    _lpLeft.appendChild(_lpActionLabel);
    _lpLeft.appendChild(_lpStatusIcon);
    var _lpTimer = document.createElement('span');
    _lpTimer.style.cssText = 'font-size:10px;color:var(--text-secondary);opacity:0.7;';
    stepRow.appendChild(_lpLeft);
    stepRow.appendChild(_lpTimer);
    var timerSpan = _lpTimer;
    var _timerInterval = setInterval(function() {
      var elapsed = ((Date.now() - _stepStartTimes[step]) / 1000).toFixed(1);
      if (timerSpan) timerSpan.textContent = elapsed + 's';
    }, 200);
    stepsContainer.appendChild(stepRow);
    Core.dom.chatContainer.scrollTop = Core.dom.chatContainer.scrollHeight;

    const toolResult = await executeAgentAction(action.action, action.params || {});

    // 🔧 类型安全：确保 toolResult 是字符串
    var toolResultStr = (toolResult == null) ? '' : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult));

    // 🔒 S2: 间接 Prompt Injection 防御 — 扫描工具输出中的注入载荷
    if (toolResultStr && Core.guardrails && Core.guardrails.checkToolResult) {
      var _toolScan = Core.guardrails.checkToolResult(action.action, toolResultStr);
      if (!_toolScan.safe && _toolScan.sanitized) {
        toolResultStr = _toolScan.sanitized;
      }
    }

    // 🔧 自动纠错：检测工具失败并注入重试引导
    // 用 detectToolError 前缀判定，避免对返回内容做关键词全文匹配导致误判
    var resultForContext = toolResultStr;
    var isToolError = detectToolError(toolResultStr);
    if (isToolError) {
      // 📚 记录错误经验：供后续蒸馏和 Agent pre-check 使用
      if (Core.knowledgeDistill && Core.knowledgeDistill.addLesson) {
        try {
          Core.knowledgeDistill.addLesson({
            category: 'tool_error',
            pattern: action.action,
            message: '工具 "' + action.action + '" 执行失败: ' + toolResultStr.substring(0, 150),
            tool: action.action,
            suggestion: '检查参数/服务状态后重试，或使用替代方案'
          });
        } catch (e) { /* 静默失败，不影响主流程 */ }
      }
      var correctionHint = '\n⚠️ [自动纠错提示] 工具 "' + action.action + '" 执行失败。请分析上述错误原因，并尝试以下策略之一：\n' +
        '1. 检查并修正参数后重试（如路径错误则修正路径）\n' +
        '2. 使用不同的工具完成同一目标\n' +
        '3. 使用 run_python 编写脚本来解决\n' +
        '4. 使用 web_search 搜索解决方案\n' +
        '请勿用完全相同的参数重复调用 ' + action.action + '。';
      resultForContext = toolResultStr + correctionHint;
      // 更新步骤行为红色错误状态
      stepRow.style.borderLeftColor = '#ef4444';
      _lpStatusIcon.className = '';
      _lpStatusIcon.textContent = '\u274C';
      var _lpErrHint = document.createElement('span');
      _lpErrHint.style.cssText = 'font-size:10px;color:#ef4444;margin-left:4px;';
      _lpErrHint.textContent = '\u81EA\u52A8\u7EA0\u9519\u4E2D';
      _lpLeft.appendChild(_lpErrHint);
      _lpTimer.textContent = ((Date.now() - _stepStartTimes[step]) / 1000).toFixed(1) + 's';
      _lpTimer.style.color = '#ef4444';
    }

    const stepRecord = `[步骤${step}] 执行 ${action.action}: ${JSON.stringify(action.params || {})}\n结果: ${resultForContext.substring(0, 300)}${resultForContext.length > 300 ? '...' : ''}`;
    context += '\n' + stepRecord;

    // 🔧 联网搜索收敛控制：防止Agent无限搜索不产出答案
    if (action.action === 'web_search') {
      _searchCount++;
      if (_searchCount === 4) {
        context += '\n⚠️ [系统提示] 你已搜索了4次。请评估当前信息是否足够回答问题。如果足够，请立即使用 complete 动作输出最终答案，不要继续搜索。';
      } else if (_searchCount >= 6) {
        context += '\n🚨 [系统强制提示] 你已搜索了' + _searchCount + '次，信息收集阶段必须结束！请立即使用 complete 动作，基于已有信息给出最终答案。禁止再次调用 web_search。';
      }
    }
    stepsLog.push({ step: step, action: action.action, params: action.params, result: toolResultStr.substring(0, 500), time: Date.now() - (_stepStartTimes[step] || Date.now()), success: !isToolError });

    // 更新步骤行：完成状态（含耗时）— 仅非错误时更新为绿色
    clearInterval(_timerInterval);
    var stepElapsed = ((Date.now() - _stepStartTimes[step]) / 1000).toFixed(1);
    if (!isToolError) {
      stepRow.style.borderLeftColor = '#22c55e';
      _lpStatusIcon.className = '';
      _lpStatusIcon.textContent = '\u2705';
      _lpTimer.textContent = stepElapsed + 's';
      _lpTimer.style.color = '#22c55e';
    }
  }
  } // end else: legacy loop path

  if (_agentCancelled && !finalAnswer) {
    finalAnswer = '⏹ 任务已被取消。已执行 ' + step + ' 步。';
  }
  if (step >= maxSteps && !finalAnswer) {
    finalAnswer = 'Agent 已达到最大步数限制，任务未能完成。';
  }

  // 最终回答清理：从可能的JSON残留中提取纯文本回答
  finalAnswer = cleanFinalAnswer(finalAnswer);

  // ===== Evaluator-Optimizer: retry once if answer quality is poor =====
  var _evalResult = evaluateAnswer(finalAnswer);
  if (!_evalResult.pass && step < maxSteps - 1 && !_agentCancelled) {
    console.log("[self-eval] quality issue: " + _evalResult.reason + ", retrying once");
    var _retryPrompt = "task: " + task + "\n\nhistory: " + (context || "(none)") + "\n\n[system-eval] your previous answer failed quality check: " + _evalResult.reason + ". please give a high-quality final answer using the complete action. do NOT output tool call JSON.";
    try {
      var _agentProvider2 = 'ollama';
      var _agentModel2 = null;
      if (Core.dom && Core.dom.modelSelect && Core.dom.modelSelect.value) {
        var selVal2 = Core.dom.modelSelect.value;
        if (selVal2.includes(':')) {
          var ci2 = selVal2.indexOf(':');
          _agentProvider2 = selVal2.substring(0, ci2);
          _agentModel2 = selVal2.substring(ci2 + 1);
        }
      }
      var _retryData = await Core.api.callAPI(_retryPrompt, AGENT_SYSTEM_PROMPT, 0.7, _agentModel2, _agentProvider2, null, { disableTools: true });
      var _retryReply = (_retryData.message && _retryData.message.content) || _retryData.response || "";
      var _retryAction = extractJSONFromText(_retryReply);
      if (_retryAction && _retryAction.action === "complete") {
        var _retryAnswer = (_retryAction.params && (_retryAction.params.answer || _retryAction.params.result || _retryAction.params.content)) || _retryReply;
        var _cleaned = cleanFinalAnswer(_retryAnswer);
        if (evaluateAnswer(_cleaned).pass) {
          finalAnswer = _cleaned;
          console.log("[self-eval] retry succeeded, answer quality improved");
        }
      }
    } catch (e) {
      console.warn("[self-eval] retry failed: " + e.message);
    }
  }


  // 🔧 渲染：保留实时步骤面板，折叠为思考过程，追加最终回答
  statusRow.remove(); // 移除状态行（含取消按钮）
  // 将步骤容器转换为折叠面板
  if (stepsLog.length > 0) {
    var panelWrapper = document.createElement('div');
    panelWrapper.className = 'agent-think-panel';
    var panelToggle = document.createElement('div');
    panelToggle.className = 'agent-think-toggle';
    // 统计成功/失败/总时间
    var successCount = 0, failCount = 0, totalTime = 0;
    for (var si = 0; si < stepsLog.length; si++) {
      if (stepsLog[si].success) successCount++; else failCount++;
      if (stepsLog[si].time) totalTime += stepsLog[si].time;
    }
    var totalTimeStr = (totalTime / 1000).toFixed(1);
    var statsHtml = '<span class="agent-think-arrow">▼</span> 🧠 执行追踪 (' + stepsLog.length + '步';
    if (successCount > 0) statsHtml += ' <span style="color:#22c55e;">✓' + successCount + '</span>';
    if (failCount > 0) statsHtml += ' <span style="color:#ef4444;">✗' + failCount + '</span>';
    statsHtml += '，' + totalTimeStr + 's)';
    panelToggle.innerHTML = statsHtml;
    panelToggle.style.cssText = 'padding:6px 12px;cursor:pointer;border-radius:6px;background:linear-gradient(135deg,#f1f5f9,#e2e8f0);font-size:13px;font-weight:500;user-select:none;display:flex;align-items:center;justify-content:space-between;';
    // 复制追踪按钮
    var copyTraceBtn = document.createElement('button');
    copyTraceBtn.className = 'agent-trace-copy-btn';
    copyTraceBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;">content_copy</span>';
    copyTraceBtn.title = '复制执行追踪';
    copyTraceBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:4px;color:var(--text-secondary);font-size:12px;';
    copyTraceBtn.onclick = function(e) {
      e.stopPropagation();
      var traceText = '=== Agent 执行追踪 ===\n任务: ' + task + '\n步骤: ' + stepsLog.length + ' | 成功: ' + successCount + ' | 失败: ' + failCount + ' | 耗时: ' + totalTimeStr + 's\n\n';
      for (var ti = 0; ti < stepsLog.length; ti++) {
        var s = stepsLog[ti];
        traceText += '--- 步骤 ' + s.step + ': ' + s.action + ' ' + (s.success ? '✓' : '✗') + ' (' + ((s.time || 0) / 1000).toFixed(1) + 's) ---\n';
        traceText += '参数: ' + JSON.stringify(s.params || {}) + '\n';
        traceText += '结果: ' + (s.result || '(空)').substring(0, 300) + '\n\n';
      }
      traceText += '最终回答: ' + (finalAnswer || '').substring(0, 200) + '\n';
      navigator.clipboard.writeText(traceText).then(function() {
        copyTraceBtn.title = '已复制!';
        copyTraceBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;color:#22c55e;">check</span>';
        setTimeout(function() { copyTraceBtn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;">content_copy</span>'; copyTraceBtn.title = '复制执行追踪'; }, 2000);
      });
    };
    panelToggle.appendChild(copyTraceBtn);
    panelToggle.onclick = function(e) {
      if (e.target.closest('.agent-trace-copy-btn')) return; // 不触发展开
      var content = this.nextElementSibling;
      var arrow = this.querySelector('.agent-think-arrow');
      if (content.classList.toggle('expanded')) {
        content.style.maxHeight = content.scrollHeight + 'px';
        arrow.textContent = '▼';
      } else {
        content.style.maxHeight = '0';
        arrow.textContent = '▶';
      }
    };
    // 重建步骤内容为可展开详情 — 使用 DocumentFragment 原子替换
    var _traceFrag = document.createDocumentFragment();
    for (var di = 0; di < stepsLog.length; di++) {
      var sData = stepsLog[di];
      var stepItem = document.createElement('div');
      stepItem.className = 'agent-trace-step';
      var statusIcon = sData.success ? '✅' : '❌';
      var timeStr = ((sData.time || 0) / 1000).toFixed(1);
      var headerRow = document.createElement('div');
      headerRow.className = 'agent-trace-step-header';
      headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;border-radius:4px;font-size:12px;user-select:none;';
      headerRow.innerHTML = '<span style="color:' + (sData.success ? '#22c55e' : '#ef4444') + ';font-weight:600;">' + statusIcon + ' 步骤' + sData.step + '</span> <span style="font-weight:500;color:var(--text);">' + translateAction(sData.action) + '</span> <span style="font-size:10px;color:var(--text-secondary);margin-left:auto;">' + timeStr + 's</span> <span class="agent-trace-expand-icon" style="font-size:10px;color:var(--text-secondary);">▶</span>';
      var detailRow = document.createElement('div');
      detailRow.className = 'agent-trace-step-detail';
      detailRow.style.cssText = 'display:none;padding:4px 8px 6px 28px;font-size:11px;color:var(--text-secondary);line-height:1.5;';
      var paramsStr = JSON.stringify(sData.params || {}, null, 2);
      var resultStr = (sData.result || '(空)').substring(0, 300);
      detailRow.innerHTML = '<div style="margin-bottom:4px;"><span style="font-weight:600;color:var(--text);">参数:</span><pre style="margin:2px 0;padding:4px 6px;background:rgba(0,0,0,0.04);border-radius:3px;font-size:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;">' + paramsStr + '</pre></div>' +
        '<div><span style="font-weight:600;color:var(--text);">结果:</span><pre style="margin:2px 0;padding:4px 6px;background:rgba(0,0,0,0.04);border-radius:3px;font-size:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;">' + resultStr + '</pre></div>';
      headerRow.onclick = (function(hdr, dtl) {
        return function() {
          var visible = dtl.style.display !== 'none';
          dtl.style.display = visible ? 'none' : 'block';
          hdr.querySelector('.agent-trace-expand-icon').textContent = visible ? '▶' : '▼';
          // 重新计算父 maxHeight
          var pc = hdr.closest('.agent-think-content');
          if (pc && pc.classList.contains('expanded')) pc.style.maxHeight = pc.scrollHeight + 'px';
        };
      })(headerRow, detailRow);
      stepItem.appendChild(headerRow);
      stepItem.appendChild(detailRow);
      _traceFrag.appendChild(stepItem);
    }
    stepsContainer.replaceChildren(_traceFrag);
    var panelContent = document.createElement('div');
    panelContent.className = 'agent-think-content expanded';
    panelContent.style.cssText = 'max-height:2000px;overflow:hidden;transition:max-height 0.3s ease;';
    stepsContainer.style.marginTop = '4px';
    panelContent.appendChild(stepsContainer);
    panelWrapper.appendChild(panelToggle);
    panelWrapper.appendChild(panelContent);
    // 原子交换：单次 replaceChildren 替代 innerHTML 清空 + appendChild，消除中间空容器闪烁
    agentDiv.replaceChildren(panelWrapper);
  } else {
    agentDiv.removeChild(stepsContainer);
  }
  const contentDiv = document.createElement('div');
  contentDiv.className = 'agent-content';
  if (window.marked && finalAnswer) {
    contentDiv.innerHTML = Core.renderMarkdown(finalAnswer);
  } else {
    contentDiv.textContent = finalAnswer || 'Agent未能完成任务';
  }
  agentDiv.appendChild(contentDiv);
  Core.addTimestamp(agentDiv); // 添加时间戳

  // 📡 Gateway 桥接：Agent 回复广播到 WebSocket 客户端（Core.ui.appendMessage 仅发事件，不操作 DOM，不会二次渲染）
  if (Core.ui && Core.ui.appendMessage && finalAnswer) {
    Core.ui.appendMessage('ai', finalAnswer, {});
  }

  // 添加代码复制按钮和折叠按钮
  agentDiv.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-code-btn')) return; // 避免重复
    // 复制按钮
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = '复制';
      btn.onclick = function() {
        // 优先复制选中的文本
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
          navigator.clipboard.writeText(selection.toString());
          btn.textContent = '已复制';
          setTimeout(() => btn.textContent = '复制', 1500);
          return;
        }
        // 否则复制代码内容（排除按钮文本）
        const codeEl = pre.querySelector('code');
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent);
        } else {
          const clone = pre.cloneNode(true);
          clone.querySelectorAll('.copy-code-btn, .fold-code-btn').forEach(b => b.remove());
          navigator.clipboard.writeText(clone.textContent);
        }
        btn.textContent = '已复制';
        setTimeout(() => btn.textContent = '复制', 1500);
      };
    pre.appendChild(btn);
    // D3: 折叠按钮
    const foldBtn = document.createElement('button');
    foldBtn.className = 'fold-code-btn';
    foldBtn.textContent = '收起';
    foldBtn.onclick = function() {
      pre.classList.toggle('collapsed');
      foldBtn.textContent = pre.classList.contains('collapsed') ? '展开' : '收起';
    };
    pre.appendChild(foldBtn);
  });

  // 🔧 标记生成结束，按钮恢复
  Core._setGeneratingState(false);
  Core._agentRunning = false;
  Core.emit('typingEnd');
  Core.dom.status.textContent = `✅ Agent 完成 (${step}步${isDeepThink ? ' · 深度' : ''})`;
  return { success: true, reply: finalAnswer || '', steps: step };
}


module.exports = {
  name: 'agent-loop',
  dependencies: ['html-utils'],
  init: function(_Core) {
    Core = _Core;
    Core.agentLoop = {
      sendToAgent: sendToAgent,
      executeAgentAction: executeAgentAction,
      extractJSONFromText: extractJSONFromText,
      cleanFinalAnswer: cleanFinalAnswer,
      evaluateAnswer: evaluateAnswer,
      detectToolError: detectToolError,
      AGENT_SYSTEM_PROMPT: AGENT_SYSTEM_PROMPT
    };
    console.log('✅ Agent 循环模块已加载');
  }
};
