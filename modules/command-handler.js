// modules/command-handler.js - 斜杠命令处理器
// 从 api.js 提取，处理所有 /command 命令
const { ipcRenderer } = require('electron');

let Core = null;

// ===== 命令处理 =====
async function handleCommand(text) {
  if (text.startsWith('/')) {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1).join(' ');
    if (Core.pluginManager) {
      const commands = Core.pluginManager.getCommands();
      if (commands[cmd]) {
        try {
          const result = commands[cmd](args, Core.session.getCurrentId());
          if (result !== false) return true;
        } catch (err) {
          Core.session.addMessage(`❌ 插件命令错误: ${err.message}`, 'ai');
          return true;
        }
      }
    }
  }

  if (text.startsWith('/file ')) {
    const parts = text.slice(6).trim().split(/\s+/);
    const action = parts[0];
    const args = parts.slice(1).join(' ');
    if (!Core.toolsRegistry || typeof Core.toolsRegistry.executeTool !== 'function') {
      Core.session.addMessage('❌ 工具模块未加载或不可用', 'ai');
      return true;
    }
    try {
      let result;
      if (action === 'read') {
        result = await Core.toolsRegistry.executeTool('read_file', { file_path: args });
      } else if (action === 'list') {
        result = await Core.toolsRegistry.executeTool('list_dir', { dir_path: args || '.' });
      } else if (action === 'write') {
        const spaceIndex = args.indexOf(' ');
        if (spaceIndex === -1) {
          Core.session.addMessage('❌ 用法: /file write <路径> <内容>', 'ai');
          return true;
        }
        const filePath = args.substring(0, spaceIndex);
        const content = args.substring(spaceIndex + 1);
        result = await Core.toolsRegistry.executeTool('write_file', { file_path: filePath, content: content });
      } else {
        Core.session.addMessage(`❌ 未知操作: ${action}（支持 read, list, write）`, 'ai');
        return true;
      }
      Core.session.addMessage(result, 'ai');
    } catch (err) {
      Core.session.addMessage(`❌ 工具执行错误: ${err.message}`, 'ai');
    }
    return true;
  }

  // ===== /git 命令（增强版）=====
  if (text === '/git') {
    if (Core.tools && Core.tools.gitStatus) {
      const result = await Core.tools.gitStatus();
      Core.session.addMessage(result, 'ai');
    } else {
      Core.session.addMessage('❌ Git 模块未加载', 'ai');
    }
    return true;
  }
  if (text.startsWith('/git ')) {
    if (!Core.tools || !Core.tools.git) {
      Core.session.addMessage('❌ Git 模块未加载', 'ai');
      return true;
    }
    const parts = text.slice(5).trim().split(/\s+/);
    const sub = parts[0];
    const arg1 = parts[1] || '';
    const arg2 = parts.slice(2).join(' ');
    var gitResult = '';
    switch (sub) {
      case 'status':
        gitResult = await Core.tools.gitStatus(); break;
      case 'diff':
        gitResult = await Core.tools.gitDiff(arg1, parts.indexOf('--staged') >= 0); break;
      case 'log':
        gitResult = await Core.tools.gitLog(parseInt(arg1) || 5); break;
      case 'commit':
        gitResult = await Core.tools.gitCommit(arg1 || arg2 || ''); break;
      case 'push':
        gitResult = await Core.tools.gitPush(); break;
      case 'pull':
        gitResult = await Core.tools.gitPull(); break;
      case 'add':
        gitResult = await Core.tools.gitAdd(arg1 || '.'); break;
      case 'branch':
        gitResult = await Core.tools.gitBranch(arg1 || 'list', arg2 || ''); break;
      case 'checkout':
      case 'switch':
        gitResult = await Core.tools.gitCheckout(arg1); break;
      case 'stash':
        gitResult = await Core.tools.gitStash(arg1 || 'save', arg2 || ''); break;
      case 'merge':
        gitResult = await Core.tools.gitMerge(arg1); break;
      case 'reset':
        gitResult = await Core.tools.gitReset(arg1 || 'soft', arg2 || 'HEAD~1'); break;
      case 'conflict':
      case 'conflicts':
        gitResult = await Core.tools.gitConflictCheck(); break;
      default:
        // 向后兼容：直接传参给 gitAction
        gitResult = await Core.tools.git(sub, parts.slice(1));
    }
    Core.session.addMessage(gitResult, 'ai');
    return true;
  }
  if (text.startsWith('/python ')) {
    const code = text.slice(8).trim();
    if (Core.python) {
      try {
        const result = await Core.python.runPython(code);
        Core.session.addMessage(result, 'ai');
      } catch (err) {
        Core.session.addMessage('❌ Python 错误: ' + err, 'ai');
      }
    } else {
      Core.session.addMessage('❌ Python 模块未加载', 'ai');
    }
    return true;
  }
  // ===== /browser 命令 =====
  if (text.startsWith('/browser')) {
    if (!Core.browser) {
      Core.session.addMessage('❌ 浏览器自动化模块未加载', 'ai');
      return true;
    }
    if (!Core.browser.isAvailable()) {
      Core.session.addMessage('❌ BrowserWindow 不可用，浏览器自动化功能无法使用', 'ai');
      return true;
    }
    const browserArgs = text.slice(8).trim();
    if (!browserArgs || browserArgs === 'help') {
      Core.session.addMessage(
        '🌐 **浏览器自动化命令**\n\n' +
        '- `/browser open <URL>` — 打开网页\n' +
        '- `/browser screenshot [full]` — 截图（full=全页面）\n' +
        '- `/browser click <selector>` — 点击元素\n' +
        '- `/browser type <selector> <text>` — 输入文本\n' +
        '- `/browser submit [selector]` — 提交表单\n' +
        '- `/browser js <code>` — 执行JavaScript\n' +
        '- `/browser text [selector]` — 提取文本\n' +
        '- `/browser html [selector]` — 提取HTML\n' +
        '- `/browser links` — 提取所有链接\n' +
        '- `/browser forms` — 提取表单数据\n' +
        '- `/browser info` — 页面元信息\n' +
        '- `/browser wait <ms>` — 等待毫秒\n' +
        '- `/browser back` / `/browser forward` — 前进/后退\n' +
        '- `/browser tabs [new|switch N|close N|list]` — 标签管理\n' +
        '- `/browser find <text>` — 页面内搜索\n' +
        '- `/browser clear` — 清除浏览数据\n' +
        '- `/browser close` — 关闭浏览器\n' +
        '- `/browser status` — 浏览器状态', 'ai');
      return true;
    }
    try {
      const result = await Core.browser.handleCommand(browserArgs);
      Core.session.addMessage(typeof result === 'string' ? result : JSON.stringify(result, null, 2), 'ai');
    } catch (err) {
      Core.session.addMessage('❌ 浏览器错误: ' + err.message, 'ai');
    }
    return true;
  }
  // ===== /skill 命令 =====
  if (text === '/skill' || text === '/skill list') {
    const list = Core.skills.listSkills();
    const current = Core.skills.getCurrentSkill();
    var header = current ? '当前技能：' + current.name + '\n\n' : '';
    Core.session.addMessage(header + '可用技能:\n' + list + '\n\n用法：/skill use <id> 激活 | /skill remove <id> 删除 | /skill reset 重置', 'ai');
    return true;
  }
  if (text === '/skill reset') {
    Core.skills.setSkill(null);
    Core.session.addMessage('✅ 技能已重置为默认', 'ai');
    return true;
  }
  if (text.startsWith('/skill use ')) {
    const skillId = text.slice(11).trim();
    const success = Core.skills.setSkill(skillId);
    if (success) {
      const current = Core.skills.getCurrentSkill();
      Core.session.addMessage('✅ 已激活技能：' + current.name + '\n' + (current.description || ''), 'ai');
    } else {
      Core.session.addMessage('❌ 未找到技能 "' + skillId + '"，可用技能：\n' + Core.skills.listSkills(), 'ai');
    }
    return true;
  }
  if (text.startsWith('/skill remove ')) {
    const skillId = text.slice(14).trim();
    const result = Core.skills.removeSkill(skillId);
    if (result.success) {
      Core.session.addMessage('✅ 技能 "' + skillId + '" 已删除', 'ai');
    } else {
      Core.session.addMessage('❌ 删除失败：' + (result.error || '未知错误'), 'ai');
    }
    return true;
  }
  if (text.startsWith('/skill install ')) {
    const sourcePath = text.slice(15).trim();
    const result = Core.skills.installSkill(sourcePath);
    if (result.success) {
      Core.skills.refreshSkills();
      Core.session.addMessage('✅ 技能安装成功！当前共 ' + Core.skills.getAllSkills().length + ' 个技能', 'ai');
    } else {
      Core.session.addMessage('❌ 安装失败：' + (result.error || '未知错误'), 'ai');
    }
    return true;
  }
  if (text.startsWith('/skill ')) {
    // 向后兼容：/skill <id> 等同于 /skill use <id>
    const skillId = text.slice(7).trim();
    const success = Core.skills.setSkill(skillId);
    if (success) {
      const current = Core.skills.getCurrentSkill();
      Core.session.addMessage('✅ 已激活技能：' + current.name, 'ai');
    } else {
      Core.session.addMessage('❌ 未找到技能 "' + skillId + '"，可用技能：\n' + Core.skills.listSkills(), 'ai');
    }
    return true;
  }
  // ===== /remember 命令 =====
  if (text.startsWith('/remember ')) {
    if (!Core.memory) { Core.session.addMessage('❌ 记忆模块未加载', 'ai'); return true; }
    var content = text.slice(10).trim();
    // 支持可选标签：/remember [tag1,tag2] 内容
    var tags = '';
    var tagMatch = content.match(/^\[([^\]]+)\]\s*(.*)/);
    if (tagMatch) {
      tags = tagMatch[1];
      content = tagMatch[2];
    }
    if (!content) { Core.session.addMessage('❌ 请输入要记住的内容\n用法：/remember [标签] 内容', 'ai'); return true; }
    var result = Core.memory.add(content, tags);
    if (result.success) {
      Core.session.addMessage('✅ 已记住：' + content, 'ai');
    } else {
      Core.session.addMessage('❌ 保存失败：' + (result.error || '未知错误'), 'ai');
    }
    return true;
  }
  // ===== /memory 命令 =====
  if (text === '/memory' || text === '/memory list') {
    if (!Core.memory) { Core.session.addMessage('❌ 记忆模块未加载', 'ai'); return true; }
    var memories = Core.memory.list(50);
    Core.session.addMessage('📝 记忆列表（共 ' + memories.length + ' 条）：\n' + Core.memory.formatList(memories) + '\n\n用法：/remember 内容 | /memory search 关键词 | /memory delete ID', 'ai');
    return true;
  }
  if (text.startsWith('/memory search ')) {
    if (!Core.memory) { Core.session.addMessage('❌ 记忆模块未加载', 'ai'); return true; }
    var query = text.slice(15).trim();
    var results = Core.memory.search(query, 10);
    if (results.length === 0) {
      Core.session.addMessage('🔍 未找到包含 "' + query + '" 的记忆', 'ai');
    } else {
      Core.session.addMessage('🔍 搜索 "' + query + '" 找到 ' + results.length + ' 条：\n' + Core.memory.formatList(results), 'ai');
    }
    return true;
  }
  if (text.startsWith('/memory delete ')) {
    if (!Core.memory) { Core.session.addMessage('❌ 记忆模块未加载', 'ai'); return true; }
    var id = parseInt(text.slice(15).trim());
    if (isNaN(id)) { Core.session.addMessage('❌ 请提供有效的记忆 ID', 'ai'); return true; }
    var delResult = Core.memory.delete(id);
    if (delResult.success) {
      Core.session.addMessage('✅ 记忆 #' + id + ' 已删除', 'ai');
    } else {
      Core.session.addMessage('❌ 删除失败：' + (delResult.error || '未知错误'), 'ai');
    }
    return true;
  }
  // /memory stats — 记忆统计
  if (text === '/memory stats') {
    if (!Core.memory || !Core.memory.getStats) { Core.session.addMessage('❌ 记忆模块未加载', 'ai'); return true; }
    var stats = Core.memory.getStats();
    var tagList = Object.keys(stats.tags).map(function(t) { return t + ': ' + stats.tags[t]; }).join(', ');
    Core.session.addMessage('📊 记忆统计\n\n总计: ' + stats.total + ' 条\n标签分布: ' + (tagList || '无') + '\n\n智能功能: TF-IDF 语义搜索 | 自动提取 | 去重检测', 'ai');
    return true;
  }
  // /memory cleanup — 清理过期记忆
  if (text.startsWith('/memory cleanup')) {
    if (!Core.memory || !Core.memory.cleanup) { Core.session.addMessage('❌ 记忆模块未加载', 'ai'); return true; }
    var days = parseInt(text.slice(15).trim()) || 180;
    var result = Core.memory.cleanup(days);
    Core.session.addMessage('🧹 清理完成\n移除: ' + result.removed + ' 条（超过 ' + days + ' 天）\n剩余: ' + result.remaining + ' 条', 'ai');
    return true;
  }
  // ===== /context 命令 — 上下文窗口状态 =====
  if (text === '/context') {
    if (!Core.contextManager) { Core.session.addMessage('❌ 上下文管理模块未加载', 'ai'); return true; }
    var sid = Core.session.getCurrentId();
    var usage = Core.contextManager.getTokenUsage(sid);
    if (!usage) { Core.session.addMessage('❌ 无法获取当前会话信息', 'ai'); return true; }
    var bar = '';
    var pct = Math.min(usage.utilization, 100);
    for (var bi = 0; bi < 20; bi++) bar += bi < pct / 5 ? '█' : '░';
    var statusMsg = '📊 上下文窗口状态\n\n';
    statusMsg += '消息总数: ' + usage.totalMessages + ' 条\n';
    statusMsg += '总 Token: ~' + usage.totalTokens.toLocaleString() + '\n';
    statusMsg += '窗口消息: ' + usage.contextMessages + ' 条\n';
    statusMsg += '窗口 Token: ~' + usage.contextTokens.toLocaleString() + '\n';
    statusMsg += '预算: ' + usage.budget.toLocaleString() + ' tokens\n\n';
    statusMsg += '使用率: ' + bar + ' ' + usage.utilization + '%\n';
    statusMsg += '\n💡 Token 预算制替代了固定 20 条限制，自动包含更多相关消息并生成历史摘要。';
    Core.session.addMessage(statusMsg, 'ai');
    return true;
  }
  // ===== /url 命令 — 抓取网页内容 =====
  if (text.startsWith('/url ')) {
    var targetUrl = text.slice(5).trim();
    if (!targetUrl) { Core.session.addMessage('⚠️ 用法: /url <网页地址>\n\n示例: /url https://example.com', 'ai'); return true; }
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
    Core.session.addMessage('⏳ 正在抓取: ' + targetUrl + ' ...', 'ai');
    if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
      try {
        var result = await Core.toolsRegistry.executeTool('read_url', { url: targetUrl, max_length: 6000 });
        Core.session.addMessage(result, 'ai');
      } catch (e) {
        Core.session.addMessage('❌ 抓取失败: ' + e.message, 'ai');
      }
    } else {
      Core.session.addMessage('❌ 工具模块未加载', 'ai');
    }
    return true;
  }
  // ===== /tasks 命令 — 查看后台任务状态 =====
  if (text === '/tasks') {
    var tasks = Core.api.getBackgroundTasks();
    var now = Date.now();
    if (tasks.length === 0) {
      Core.session.addMessage('📭 当前没有正在运行的后台任务。\n\n💡 在主管模式下发送消息，会自动分发到子角色后台执行。', 'ai');
    } else {
      var taskMsg = '📋 后台任务列表\n\n';
      tasks.forEach(function(t) {
        var elapsed = ((now - t.startTime) / 1000).toFixed(1);
        var icon = t.status === 'running' ? '⏳' : (t.status === 'done' ? '✅' : '❌');
        var statusText = t.status === 'running' ? '运行中 (' + elapsed + 's)' : (t.status === 'done' ? '已完成' : '失败');
        taskMsg += icon + ' ' + t.role + ' — ' + statusText + '\n';
      });
      Core.session.addMessage(taskMsg, 'ai');
    }
    return true;
  }
  // ===== /dispatch 命令 — 并行分发到多个角色 =====
  if (text.startsWith('/dispatch ')) {
    var dispatchText = text.slice(10).trim();
    if (!dispatchText) { Core.session.addMessage('⚠️ 用法: /dispatch <任务描述>\n\n自动分析并并行分发到所有匹配的角色。', 'ai'); return true; }
    var currentSession = null;
    try {
      var currentId = Core.session.getCurrentId();
      currentSession = Core.session.sessions[currentId];
    } catch (e) { console.warn('⚠️ [api] /dispatch 获取当前会话失败:', e.message); }
    if (!currentSession || currentSession.roleType !== 'master') {
      Core.session.addMessage('⚠️ /dispatch 只能在主管模式下使用。', 'ai');
      return true;
    }
    // 🔧 从统一路由引擎获取角色定义（消除硬编码副本）
    var masterRoles = (Core.routing && Core.routing.listMasterRoles) ? Core.routing.listMasterRoles() : [];
    if (masterRoles.length === 0) {
      Core.session.addMessage('⚠️ 未找到可用的子角色定义。', 'ai');
      return true;
    }
    var lowerText = dispatchText.toLowerCase();
    var matchedRoles = [];
    masterRoles.forEach(function(r) {
      var kws = (r.keywords || '').split('、');
      for (var ki = 0; ki < kws.length; ki++) {
        if (kws[ki] && lowerText.indexOf(kws[ki].toLowerCase()) >= 0) { matchedRoles.push(r); break; }
      }
    });
    if (matchedRoles.length === 0) matchedRoles = masterRoles.slice();
    var dispatchMsg = '🚀 并行分发到 ' + matchedRoles.length + ' 个角色：\n';
    matchedRoles.forEach(function(r) {
      var allSessions = Core.session.sessions || {};
      var roleSessionId = null;
      for (var sid in allSessions) {
        if (allSessions[sid].roleType === r.roleType && allSessions[sid].parentId === currentId) { roleSessionId = sid; break; }
      }
      if (!roleSessionId) {
        roleSessionId = Core.session.newChat(r.id, currentId);
        Core.session.switchSession(currentId);
      }
      dispatchMsg += '\n📨 ' + r.displayName + '（后台执行中）';
      Core.api.runBackgroundTask(roleSessionId, dispatchText, currentId, r.displayName);
    });
    Core.session.addMessage(dispatchMsg, 'ai');
    Core.dom.status.textContent = '🚀 已并行分发到 ' + matchedRoles.length + ' 个角色';
    return true;
  }
  // ===== /knowledge 命令 =====
  if (text === '/knowledge save' || text === '/knowledge') {
    if (!Core.knowledge || !Core.knowledge.saveConversation) {
      Core.session.addMessage('❌ 知识库模块未加载', 'ai');
      return true;
    }
    var currentId = Core.session.getCurrentId();
    var sessionData = Core.session.sessions && Core.session.sessions[currentId];
    if (!sessionData || !sessionData.messages || sessionData.messages.length < 2) {
      Core.session.addMessage('❌ 当前会话消息不足，无法保存', 'ai');
      return true;
    }
    var title = sessionData.title || '';
    Core.knowledge.saveConversation(sessionData.messages, title).then(function (r) {
      if (r.success) {
        Core.session.addMessage('✅ 当前对话已存入知识库（' + (r.chunks || 0) + ' 个分块）', 'ai');
      } else {
        Core.session.addMessage('❌ 保存失败：' + (r.error || '未知错误'), 'ai');
      }
    }).catch(function (e) {
      Core.session.addMessage('❌ 保存异常：' + e.message, 'ai');
    });
    return true;
  }
  if (text === '/knowledge stats') {
    if (!Core.knowledge || !Core.knowledge.getStats) {
      Core.session.addMessage('❌ 知识库模块未加载', 'ai');
      return true;
    }
    var stats = Core.knowledge.getStats();
    Core.session.addMessage('📊 知识库统计：\n文档数: ' + stats.totalDocs + '\n分块数: ' + stats.totalChunks + '\n有向量: ' + stats.chunksWithEmbeddings + '\n无向量: ' + stats.chunksWithoutEmbeddings + '\n搜索模式: ' + stats.searchMode + '\n嵌入模型: ' + (stats.embeddingModel || '不可用'), 'ai');
    return true;
  }
  // ===== /kb search <query> — 知识库搜索（带引用）=====
  if (text.startsWith('/kb search ')) {
    var kbQuery = text.slice(11).trim();
    if (!kbQuery) { Core.session.addMessage('⚠️ 用法: /kb search <关键词>\n\n示例: /kb search Python 异步编程', 'ai'); return true; }
    if (!Core.knowledge || !Core.knowledge.searchWithCitations) { Core.session.addMessage('❌ 知识库模块未加载', 'ai'); return true; }
    Core.session.addMessage('🔍 正在搜索知识库: ' + kbQuery + ' ...', 'ai');
    try {
      var kbResult = await Core.knowledge.searchWithCitations(kbQuery, 5);
      if (!kbResult.results || kbResult.results.length === 0) {
        Core.session.addMessage('📭 未找到与「' + kbQuery + '」相关的知识。\n\n💡 使用 /kb import <URL> 导入网页，或在设置中上传文档。', 'ai');
      } else {
        var reply = '🔍 知识库搜索结果（' + kbResult.results.length + ' 条）\n\n';
        kbResult.results.forEach(function(r, i) {
          var score = r.rrfScore || r.score || 0;
          reply += '**[' + (i + 1) + '] ' + (r.fileName || '未知') + '** — 相关度: ' + score.toFixed(3) + '\n';
          reply += '> ' + (r.text || '').substring(0, 200).replace(/\n/g, ' ') + '...\n\n';
        });
        if (kbResult.citations) reply += '📚 来源：\n' + kbResult.citations;
        Core.session.addMessage(reply, 'ai');
      }
    } catch (e) {
      Core.session.addMessage('❌ 搜索失败: ' + e.message, 'ai');
    }
    return true;
  }
  // ===== /kb import <url> — 从网页导入到知识库 =====
  if (text.startsWith('/kb import ')) {
    var importUrl = text.slice(11).trim();
    if (!importUrl) { Core.session.addMessage('⚠️ 用法: /kb import <网页地址>\n\n示例: /kb import https://docs.python.org/3/tutorial/', 'ai'); return true; }
    if (!Core.knowledge || !Core.knowledge.importFromUrl) { Core.session.addMessage('❌ 知识库模块未加载', 'ai'); return true; }
    Core.session.addMessage('⏳ 正在导入: ' + importUrl + ' ...', 'ai');
    try {
      var importResult = await Core.knowledge.importFromUrl(importUrl);
      if (importResult.success !== false && !importResult.error) {
        Core.session.addMessage('✅ 导入成功！\n\n标题: ' + (importResult.title || importUrl) + '\n分块数: ' + (importResult.chunkCount || 'N/A') + '\n来源: ' + importUrl, 'ai');
      } else {
        Core.session.addMessage('❌ 导入失败: ' + (importResult.error || '未知错误'), 'ai');
      }
    } catch (e) {
      Core.session.addMessage('❌ 导入异常: ' + e.message, 'ai');
    }
    return true;
  }
  // ===== /kb list — 列出知识库文档 =====
  if (text === '/kb list') {
    if (!Core.knowledge || !Core.knowledge.listDocuments) { Core.session.addMessage('❌ 知识库模块未加载', 'ai'); return true; }
    var docs = Core.knowledge.listDocuments();
    if (!docs || docs.length === 0) {
      Core.session.addMessage('📭 知识库为空。\n\n💡 使用以下方式添加文档：\n• /kb import <URL> — 导入网页\n• /knowledge save — 保存当前对话\n• 设置面板上传文件', 'ai');
    } else {
      var listMsg = '📚 知识库文档（' + docs.length + ' 篇）\n\n';
      docs.forEach(function(d, i) {
        var date = d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString('zh-CN') : '未知';
        listMsg += (i + 1) + '. **' + (d.fileName || '未命名') + '** — ' + (d.chunkCount || 0) + ' 块 — ' + date + '\n';
      });
      Core.session.addMessage(listMsg, 'ai');
    }
    return true;
  }
  // ===== /voice 命令组 =====
  if (text === '/voice auto' || text === '/voice toggle') {
    if (!Core.voice || !Core.voice.toggleAutoRead) { Core.session.addMessage('❌ 语音模块未加载', 'ai'); return true; }
    var enabled = Core.voice.toggleAutoRead();
    Core.session.addMessage(enabled ? '🔊 自动朗读已开启\n\nAI 回复将自动朗读。使用 /voice auto 再次切换。' : '🔇 自动朗读已关闭', 'ai');
    return true;
  }
  if (text === '/voice profiles' || text === '/voice list') {
    if (!Core.voice || !Core.voice.getVoiceProfiles) { Core.session.addMessage('❌ 语音模块未加载', 'ai'); return true; }
    var profiles = Core.voice.getVoiceProfiles();
    var msg = '🎙️ 可用音色\n\n';
    profiles.forEach(function(p) {
      msg += (p.active ? '▶ ' : '  ') + '**' + p.name + '** — ' + p.description + '\n';
    });
    msg += '\n💡 使用 /voice set <音色名> 切换';
    Core.session.addMessage(msg, 'ai');
    return true;
  }
  if (text.startsWith('/voice set ')) {
    var profileName = text.slice(11).trim();
    if (!Core.voice || !Core.voice.setVoiceProfile) { Core.session.addMessage('❌ 语音模块未加载', 'ai'); return true; }
    if (Core.voice.setVoiceProfile(profileName)) {
      Core.session.addMessage('✅ 音色已切换为: ' + profileName, 'ai');
    } else {
      Core.session.addMessage('⚠️ 未知音色: ' + profileName + '\n可用: default, fast, slow, warm, bright', 'ai');
    }
    return true;
  }
  if (text.startsWith('/voice fish ')) {
    var fishVoiceName = text.slice(12).trim();
    if (!Core.voice) { Core.session.addMessage('❌ 语音模块未加载', 'ai'); return true; }
    Core.voice.fishVoice = fishVoiceName;
    Core.session.addMessage('🎙️ Fish Speech 音色已设为: ' + fishVoiceName + '\n\n参考音频: E:/fish-speech-models/references/' + fishVoiceName + '.wav', 'ai');
    return true;
  }
  if (text === '/voice fish') {
    if (!Core.voice) { Core.session.addMessage('❌ 语音模块未加载', 'ai'); return true; }
    Core.session.addMessage('🎙️ 当前 Fish Speech 音色: ' + (Core.voice.fishVoice || 'default') + '\n\n使用 /voice fish <音色名> 切换\n例如: /voice fish 语音测试01', 'ai');
    return true;
  }
  // ===== /manga — AI 漫剧工作流 =====
  if (text === '/manga' || text === '/aimanga') {
    var msg = '🎨 AI 漫剧工作流\n\n';
    msg += '📌 图像生成（ComfyUI 本地）:\n';
    msg += '  /manga-char <角色名> <描述>  — 生成角色图\n';
    msg += '  /manga-scene <场景描述>      — 生成场景图\n';
    msg += '  /manga-gen <剧本JSON路径>    — 批量生成\n';
    msg += '  /manga-status                — 查看 ComfyUI 状态\n\n';
    msg += ' 其他工具:\n';
    msg += '  /aimanga  — 打开 AI 漫画工作室（网页版）\n\n';
    msg += '💡 使用流程: 写剧本 → 生成角色/场景图 → 生成语音 → 合成视频';

    // 如果有 manga-comfyui 模块，检查 ComfyUI 状态
    if (Core.mangaComfyUI) {
      Core.mangaComfyUI.checkStatus().then(function(status) {
        if (status.online) {
          Core.session.addMessage(msg + '\n\n✅ ComfyUI 在线 (' + (status.vram || '') + ')', 'ai');
        } else {
          Core.session.addMessage(msg + '\n\n️ ComfyUI 离线，请先启动 ComfyUI', 'ai');
        }
      });
    } else {
      Core.session.addMessage(msg, 'ai');
    }
    return true;
  }
  // ===== /aimanga — 打开 AI 漫画工作室网页版 =====
  if (text === '/aimanga-web') {
    var url = Core.getBackendBase() + '/aimanga';
    try {
      if (typeof window !== 'undefined' && window.open) {
        window.open(url, '_blank');
      }
    } catch (e) {}
    Core.session.addMessage('🎨 AI 漫画工作室已打开\n\n' + url + '\n\n💡 首次使用需在页面内设置 Google Gemini API Key', 'ai');
    return true;
  }
  // ===== /vision — 图片理解（分析聊天中最后一张图片）=====
  if (text.startsWith('/vision') || text === '/describe') {
    var mode = text.startsWith('/vision') ? text.slice(8).trim() || 'describe' : 'describe';
    var modeMap = { describe: 'describe', ocr: 'ocr', full: 'full', code: 'describe', analyze: 'full' };
    var actualMode = modeMap[mode] || 'describe';
    // 查找聊天中最新的图片
    var chatImgs = Core.dom.chatContainer ? Core.dom.chatContainer.querySelectorAll('img') : [];
    if (chatImgs.length === 0) {
      Core.session.addMessage('🖼️ 未找到图片。\n\n💡 请先粘贴或上传一张图片，然后使用 /vision 分析。\n\n模式: describe(描述), ocr(文字识别), full(完整分析)', 'ai');
      return true;
    }
    var lastImg = chatImgs[chatImgs.length - 1];
    var imgSrc = lastImg.src || '';
    // 提取 base64
    var base64Match = imgSrc.match(/data:image\/[^;]+;base64,(.+)/);
    if (base64Match) {
      Core.session.addMessage('🔍 正在分析图片（模式: ' + mode + '）...', 'ai');
      try {
        var result = await Core.api.describeImage(base64Match[1], mode === 'code' ? '请识别图片中的代码并给出解释' : '请描述这张图片的内容', actualMode);
        Core.session.addMessage(result, 'ai');
      } catch (e) {
        Core.session.addMessage('❌ 图片分析失败: ' + e.message, 'ai');
      }
    } else {
      Core.session.addMessage('⚠️ 图片格式不支持分析（仅支持粘贴上传的图片）', 'ai');
    }
    return true;
  }
  // ===== /ocr — 图片文字识别 =====
  if (text === '/ocr') {
    var chatImgs = Core.dom.chatContainer ? Core.dom.chatContainer.querySelectorAll('img') : [];
    if (chatImgs.length === 0) {
      Core.session.addMessage('🖼️ 未找到图片。请先粘贴或上传一张包含文字的图片。', 'ai');
      return true;
    }
    var lastImg = chatImgs[chatImgs.length - 1];
    var imgSrc = lastImg.src || '';
    var base64Match = imgSrc.match(/data:image\/[^;]+;base64,(.+)/);
    if (base64Match) {
      Core.session.addMessage('📝 正在 OCR 识别...', 'ai');
      try {
        var result = await Core.api.describeImage(base64Match[1], '请提取图片中的所有文字内容', 'ocr');
        Core.session.addMessage(result, 'ai');
      } catch (e) {
        Core.session.addMessage('❌ OCR 识别失败: ' + e.message, 'ai');
      }
    } else {
      Core.session.addMessage('⚠️ 图片格式不支持', 'ai');
    }
    return true;
  }
  // ===== /screenshot — 截屏分析（通过 Electron IPC）=====
  if (text.startsWith('/screenshot') || text === '/ss') {
    var ssMode = text.startsWith('/screenshot') ? text.slice(12).trim() || 'analyze' : 'analyze';
    Core.session.addMessage('📸 正在截取屏幕...', 'ai');
    try {
      var ssResult = await ipcRenderer.invoke('take-screenshot', { type: 'full' });
      if (ssResult && ssResult.success && ssResult.dataUrl) {
        // 从 dataUrl 提取 base64
        var ssBase64 = ssResult.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        Core.session.addMessage('🔍 正在分析截屏（模式: ' + ssMode + '）...', 'ai');
        var prompt = ssMode === 'bug' ? '请检查这个截图中的 UI 问题或 Bug' :
                     ssMode === 'code' ? '请识别截图中的代码并解释' :
                     '请描述这个截屏的内容';
        var result = await Core.api.describeImage(ssBase64, prompt, 'full');
        Core.session.addMessage('📸 **截屏分析** (' + (ssResult.name || '屏幕') + ')\n\n' + result, 'ai');
      } else {
        Core.session.addMessage('❌ 截屏失败: ' + (ssResult ? ssResult.error : '未知错误'), 'ai');
      }
    } catch (e) {
      Core.session.addMessage('❌ 截屏失败: ' + e.message, 'ai');
    }
    return true;
  }
  // ===== /goal 命令 — 目标模式（持续推进直到完成）=====
  if (text.startsWith('/goal ')) {
    var goalText = text.slice(6).trim();
    if (!goalText) { Core.session.addMessage('用法: /goal <目标描述>\n\n示例: /goal 分析本周A股走势并生成报告', 'ai'); return true; }
    if (!Core.taskQueue) { Core.session.addMessage('❌ 任务队列模块未加载', 'ai'); return true; }
    var sessionId = null;
    try { sessionId = Core.session.getCurrentId(); } catch (e) {}
    var result = Core.taskQueue.create({ prompt: goalText, title: goalText.substring(0, 30), mode: 'goal', sessionId: sessionId });
    if (result.success) {
      Core.session.addMessage('🎯 目标已设定（ID: ' + result.taskId + '）\n\n「' + goalText + '」\n\nAgent 将在后台持续推进直到完成，完成后桌面通知你。输入 /resume ' + result.taskId + ' 查看进度。', 'ai');
    } else {
      Core.session.addMessage('❌ 目标设定失败: ' + result.error, 'ai');
    }
    return true;
  }
  // ===== /resume 命令 — 查看/恢复任务 =====
  if (text.startsWith('/resume')) {
    var taskId = text.slice(7).trim();
    if (!Core.taskQueue) { Core.session.addMessage('❌ 任务队列模块未加载', 'ai'); return true; }
    if (!taskId) {
      // 列出所有目标模式任务
      var goals = Core.taskQueue.list('goal');
      if (!goals || goals.length === 0) { Core.session.addMessage('📋 当前没有进行中的目标。用 /goal <描述> 设定新目标。', 'ai'); return true; }
      var listStr = goals.map(function(t) { return '  ' + (t.status === 'done' ? '✅' : t.status === 'error' ? '❌' : '🔄') + ' [' + t.id + '] ' + t.title + ' (' + t.status + ', ' + t.progress + '%)'; }).join('\n');
      Core.session.addMessage('🎯 目标列表:\n' + listStr + '\n\n输入 /resume <ID> 查看详情', 'ai');
      return true;
    }
    var task = Core.taskQueue.get(taskId);
    if (!task) { Core.session.addMessage('❌ 未找到任务: ' + taskId, 'ai'); return true; }
    if (task.status === 'done') {
      var res = Core.taskQueue.getResult(taskId);
      Core.session.addMessage('✅ 目标「' + task.title + '」已完成！\n\n' + (res && res.result ? res.result.substring(0, 3000) : '（无输出）'), 'ai');
    } else if (task.status === 'error') {
      Core.session.addMessage('❌ 目标「' + task.title + '」执行失败: ' + (task.error || '未知错误') + '\n\n可重新提交: /goal ' + task.title, 'ai');
    } else {
      Core.session.addMessage('🔄 目标「' + task.title + '」正在执行中...\n状态: ' + task.status + '，进度: ' + task.progress + '%' + (task.progressText ? '（' + task.progressText + '）' : ''), 'ai');
    }
    return true;
  }
  // ===== /research 命令 — 深度研究（多步检索 + 带引用报告）=====
  if (text.startsWith('/research ')) {
    var researchTopic = text.slice(10).trim();
    if (!researchTopic) { Core.session.addMessage('用法: /research <研究主题>\n\n示例: /research 2026年A股半导体板块投资价值分析', 'ai'); return true; }
    if (!Core.deepResearch) { Core.session.addMessage('❌ 深度研究模块未加载', 'ai'); return true; }
    Core.session.addMessage('🔬 开始深度研究：「' + researchTopic + '」\n\n正在拆解子问题并并行检索，预计需要 2-5 分钟...', 'ai');
    try {
      var result = await Core.deepResearch.start(researchTopic, {
        onProgress: function(p) {
          // 进度通过 console 输出（避免频繁刷新 UI）
          console.log('🔬 [Research ' + p.progress + '%] ' + p.message);
        }
      });
      if (result.success) {
        var duration = Math.round(result.duration / 1000);
        var outputInfo = '';
        if (result.output && result.output.files && result.output.files.length > 0) {
          outputInfo = '\n\n📁 报告已保存: ' + result.output.files.map(function(f) { return f.path; }).join(', ');
        }
        Core.session.addMessage('✅ 深度研究完成！（耗时 ' + duration + ' 秒，检索 ' + result.sources + ' 个来源，阅读 ' + result.pagesRead + ' 个页面）\n\n' + result.report.substring(0, 4000) + (result.report.length > 4000 ? '\n\n...(报告已截断，完整版见交付物文件)' : '') + outputInfo, 'ai');
      } else {
        Core.session.addMessage('❌ 深度研究失败: ' + (result.error || '未知错误'), 'ai');
      }
    } catch (e) {
      Core.session.addMessage('❌ 深度研究异常: ' + e.message, 'ai');
    }
    return true;
  }
  // ===== /learn 命令 — 文档→技能 =====
  if (text.startsWith('/learn ')) {
    var learnPath = text.slice(7).trim();
    if (!learnPath) { Core.session.addMessage('用法: /learn <文件路径>\n\n示例: /learn E:\\docs\\交易策略手册.md', 'ai'); return true; }
    if (!Core.skillGenerator) { Core.session.addMessage('❌ 技能生成器模块未加载', 'ai'); return true; }
    Core.session.addMessage('📚 正在分析文档并提取技能: ' + learnPath + '\n\n请稍候...', 'ai');
    try {
      var result = await Core.skillGenerator.fromFile(learnPath);
      if (result.success) {
        Core.session.addMessage('✅ 技能生成成功！\n\n🎯 名称: ' + result.name + '\n📝 描述: ' + result.description + '\n📋 步骤: ' + result.steps + ' 步\n📁 路径: ' + result.path + '\n\n技能已安装，可通过技能面板激活使用。', 'ai');
      } else {
        Core.session.addMessage('❌ 技能生成失败: ' + (result.error || '未知错误'), 'ai');
      }
    } catch (e) {
      Core.session.addMessage('❌ 技能生成异常: ' + e.message, 'ai');
    }
    return true;
  }
  // ===== /watch 命令 — 条件监控 =====
  if (text.startsWith('/watch')) {
    var watchArgs = text.slice(6).trim();
    if (!Core.watcher) { Core.session.addMessage('❌ 监控模块未加载', 'ai'); return true; }
    if (!watchArgs || watchArgs === 'list') {
      var watchers = Core.watcher.list();
      if (watchers.length === 0) { Core.session.addMessage('📋 当前没有监控。\n\n用法: /watch 茅台跌破1800\n      /watch 上证涨到3500\n      /watch list — 列出所有监控\n      /watch remove <id> — 删除监控', 'ai'); return true; }
      var wLines = watchers.map(function(w) {
        var opText = w.operator === 'lt' ? '<' : w.operator === 'gt' ? '>' : '=';
        return '  ' + (w.enabled ? '🟢' : '⚪') + ' [' + w.id + '] ' + w.target + ' ' + opText + ' ' + w.threshold + (w.triggerCount > 0 ? ' (已触发' + w.triggerCount + '次)' : '');
      });
      Core.session.addMessage('📋 监控列表:\n' + wLines.join('\n'), 'ai');
      return true;
    }
    if (watchArgs.startsWith('remove ')) {
      var removeId = watchArgs.slice(7).trim();
      var rmResult = Core.watcher.remove(removeId);
      Core.session.addMessage(rmResult.success ? '✅ 监控已删除: ' + removeId : '❌ ' + rmResult.error, 'ai');
      return true;
    }
    // 添加新监控
    var addResult = Core.watcher.add({ text: watchArgs });
    if (addResult.success) {
      var w = addResult.watcher;
      var opText = w.operator === 'lt' ? '跌破' : w.operator === 'gt' ? '突破' : '到达';
      Core.session.addMessage('✅ 监控已设置！\n\n🎯 ' + w.target + ' ' + opText + ' ' + w.threshold + ' 时提醒你\n🆔 ID: ' + w.id + '\n⏱️ 每分钟检查一次\n\n输入 /watch list 查看所有监控', 'ai');
    } else {
      Core.session.addMessage('❌ 监控设置失败: ' + (addResult.error || '无法解析条件，试试: /watch 茅台跌破1800'), 'ai');
    }
    return true;
  }
  // ===== /stats 命令 — 可观测性面板 =====
  if (text === '/stats' || text.startsWith('/stats')) {
    if (!Core.observability) { Core.session.addMessage('❌ 可观测性模块未加载', 'ai'); return true; }
    var report = Core.observability.report();
    var output = '📊 **系统运行统计**\n\n';
    output += '⏱️ 运行时长: ' + report.uptimeHuman + '\n\n';

    if (report.tools.total > 0) {
      output += '🔧 **工具调用** (' + report.tools.total + ' 次)\n';
      output += '  成功率: ' + report.tools.successRate + ' (' + report.tools.success + '✅ / ' + report.tools.fail + '❌)\n';
      output += '  平均耗时: ' + report.tools.avgDurationMs + 'ms\n';
      if (report.tools.failTop5.length > 0) {
        output += '  失败 Top5:\n';
        report.tools.failTop5.forEach(function(f) {
          output += '    • ' + f.action + ': ' + f.fail + '次失败 (' + f.rate + ')\n';
        });
      }
      output += '\n';
    }

    if (report.agent.total > 0) {
      output += '🤖 **Agent 运行** (' + report.agent.total + ' 次)\n';
      output += '  成功率: ' + report.agent.successRate + '\n';
      output += '  平均步数: ' + report.agent.avgSteps + ' 步\n';
      output += '  平均耗时: ' + report.agent.avgDurationHuman + '\n\n';
    }

    if (report.tokens.totalCalls > 0) {
      output += '🪙 **Token 使用** (' + report.tokens.totalCalls + ' 次调用)\n';
      output += '  总 Token: ' + report.tokens.totalTokens.toLocaleString() + '\n';
      output += '  估算成本: $' + report.tokens.estimatedCostUsd + '\n';
      var models = Object.keys(report.tokens.byModel);
      if (models.length > 0) {
        output += '  模型分布: ' + models.map(function(m) { return m + '(' + report.tokens.byModel[m].calls + ')'; }).join(', ') + '\n';
      }
      output += '\n';
    }

    if (report.errorsTop5.length > 0) {
      output += '⚠️ **错误 Top5**\n';
      report.errorsTop5.forEach(function(e) {
        output += '  • ' + e.error + ' (' + e.count + '次)\n';
      });
    }

    Core.session.addMessage(output, 'ai');
    return true;
  }
  // ===== /nebula 命令 — 打开 3D 星云界面 =====
  if (text === '/nebula' || text.startsWith('/nebula')) {
    try {
      var nebulaBase = (Core && typeof Core.getBackendBase === 'function') ? Core.getBackendBase() : 'http://127.0.0.1:8080';
      var nebulaUrl = nebulaBase + '/nebula-3d.html';
      var electron = require('electron');
      if (electron && electron.shell && electron.shell.openExternal) {
        electron.shell.openExternal(nebulaUrl);
        Core.session.addMessage('🌌 已在浏览器中打开 3D 星云界面：\n' + nebulaUrl + '\n\n鼠标拖拽旋转 · 滚轮缩放 · 右上角切换配色主题', 'ai');
      } else {
        Core.session.addMessage('🌌 3D 星云界面地址：' + nebulaUrl, 'ai');
      }
    } catch (e) {
      Core.session.addMessage('❌ 打开星云界面失败: ' + e.message, 'ai');
    }
    return true;
  }

  // 🔧 #12b: 管线命令 — 接入 pipeline-ppt / pipeline-webapp / pipeline-report
  if (text.startsWith('/ppt ')) {
    var topic = text.slice(5).trim();
    if (!topic) { Core.session.addMessage('用法: /ppt <主题>', 'ai'); return true; }
    Core.session.addMessage('📊 正在生成 PPT: ' + topic + ' ...', 'ai');
    (async function() {
      try {
        var result = await Core.pipelinePpt.fromTopic(topic);
        if (result.success) {
          Core.session.addMessage('✅ PPT 已生成: ' + result.filePath, 'ai');
        } else {
          Core.session.addMessage('❌ PPT 生成失败: ' + (result.error || '未知错误'), 'ai');
        }
      } catch (e) { Core.session.addMessage('❌ PPT 生成异常: ' + e.message, 'ai'); }
    })();
    return true;
  }

  if (text.startsWith('/webapp ')) {
    var desc = text.slice(8).trim();
    if (!desc) { Core.session.addMessage('用法: /webapp <应用描述>', 'ai'); return true; }
    Core.session.addMessage('🌐 正在生成 Web App: ' + desc + ' ...', 'ai');
    (async function() {
      try {
        var result = await Core.pipelineWebapp.fromDescription(desc);
        if (result.success) {
          var previewUrl = Core.pipelineWebapp.getPreviewUrl(result.filePath);
          Core.session.addMessage('✅ Web App 已生成!\n文件: ' + result.filePath + '\n预览: ' + (previewUrl || '无'), 'ai');
        } else {
          Core.session.addMessage('❌ Web App 生成失败: ' + (result.error || '未知错误'), 'ai');
        }
      } catch (e) { Core.session.addMessage('❌ Web App 生成异常: ' + e.message, 'ai'); }
    })();
    return true;
  }

  if (text.startsWith('/report ')) {
    var reportArgs = text.slice(8).trim();
    if (!reportArgs) { Core.session.addMessage('用法: /report <标题> | <内容>\n格式: /report 周报 | 本周完成了...', 'ai'); return true; }
    var pipeIdx = reportArgs.indexOf('|');
    var rTitle = pipeIdx > 0 ? reportArgs.slice(0, pipeIdx).trim() : '报告';
    var rContent = pipeIdx > 0 ? reportArgs.slice(pipeIdx + 1).trim() : reportArgs;
    Core.session.addMessage('📄 正在生成报告: ' + rTitle + ' ...', 'ai');
    (async function() {
      try {
        var result = await Core.pipelineReport.generatePdf({ title: rTitle, content: rContent });
        if (result.success) {
          Core.session.addMessage('✅ 报告已生成: ' + result.filePath, 'ai');
        } else {
          Core.session.addMessage('❌ 报告生成失败: ' + (result.error || '未知错误'), 'ai');
        }
      } catch (e) { Core.session.addMessage('❌ 报告生成异常: ' + e.message, 'ai'); }
    })();
    return true;
  }

  return false;
}


module.exports = {
  name: 'command-handler',
  dependencies: ['html-utils'],
  init: function(_Core) {
    Core = _Core;
    Core.commandHandler = {
      handleCommand: handleCommand
    };
    console.log('✅ 命令处理器已加载');
  }
};
