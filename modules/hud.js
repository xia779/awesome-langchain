// modules/hud.js — HUD 悬浮窗控制器（运行于主窗口渲染进程）
//
// 架构说明：
//   - HUD 的 BrowserWindow（透明/无边框/置顶）由 main.js（主进程）创建与持有。
//   - 本模块运行在主窗口渲染进程，职责有三：
//       1) 把 Agent 运行状态（思考/执行/完成/出错）经 IPC 中继到 HUD 窗口；
//       2) 接收 HUD 窗口发来的输入指令，注入主应用并发送；
//       3) 对外暴露 Core.hud API（setState / setProgress / setGauge / setActiveFn / show / hide / toggle）。
//
// 数据流：
//   agent-loop(Core.emit) → 本模块(Core.on) → ipc.send('hud-relay') → main.js → hudWindow.send('hud-state') → HUD 视图
//   HUD 视图 ipc.send('hud-input') → main.js → mainWindow.send('hud-command') → 本模块(ipc.on) → 注入主应用
//
// 测试安全：渲染进程全局（window/nodeBridge）在 Node 测试环境不存在，全部以 typeof 守卫；
//           Core.on/emit/custom 均按需守卫，mock Core 无这些方法时静默跳过。
let Core = null;

var bridge = (typeof window !== 'undefined' && window.nodeBridge && window.nodeBridge.ipc)
  ? window.nodeBridge.ipc : null;

var _state = 'idle';
var _visible = false;

// ---- Wave 6d：HUD↔画布联动状态 ----
var _activeNodeId = null;                              // 最近进入运行态的节点（HUD 一键定位用）
var _canvasSummary = { workspace: 'default', running: 0, total: 0 };
var LIVE_STATES = { thinking: 1, executing: 1, running: 1 };  // 视为「活跃」的节点状态

function _send(channel, payload) {
  if (bridge && typeof bridge.send === 'function') {
    try { bridge.send(channel, payload); } catch (e) { /* noop */ }
  }
}

// 工具名 → HUD 功能标签映射（与 public/hud/index.html 的 data-fn 对应）
var TOOL_FN_MAP = {
  web_search: 'search', search: 'search', bocha_search: 'search', tavily_search: 'search',
  deep_research: 'research',
  knowledge_search: 'knowledge', knowledge: 'knowledge',
  stock_quote: 'stock',
  web_crawl: 'crawl', read_url: 'crawl',
  schedule: 'schedule', add_schedule: 'schedule'
};

function setState(state, opts) {
  if (typeof state === 'string') _state = state;
  _send('hud-relay', Object.assign({ state: _state }, opts || {}));
}

function setProgress(pct) {
  _send('hud-relay', { state: _state, progress: pct });
}

function setGauge(pct, title, sub) {
  _send('hud-relay', { state: _state, gauge: pct, gaugeTitle: title, gaugeSub: sub });
}

function setActiveFn(fn) {
  _send('hud-relay', { state: _state, fn: fn });
}

function show() { _visible = true; _send('hud-show'); }
function hide() { _visible = false; _send('hud-hide'); }
function toggle() { _visible = !_visible; _send('hud-toggle'); }

// 将 HUD 输入的指令注入主应用并触发发送
// Wave 7 修复：返回布尔值表示是否成功派发；任何失败都立即回传 idle 状态，
//              避免 HUD 永远停在「正在思考中」。
function injectCommand(text) {
  if (!Core || !text) {
    setState('idle', { text: '指令无效', sub: '请输入有效内容' });
    return false;
  }
  try {
    // ---- Wave 8 指挥官模式：任务类意图 → 非阻塞派发后台任务，立即回执"已收到" ----
    // submit() 内部做意图识别：闲聊返回 dispatched:false，会继续走下方普通发送路径。
    if (Core.taskScheduler && typeof Core.taskScheduler.submit === 'function') {
      try {
        var dispatch = Core.taskScheduler.submit(text, { callbackChannel: 'hud' });
        if (dispatch && dispatch.dispatched) {
          // Wave 9：把用户消息 + 派发回执记入 master 会话，保证记录可溯（廿廿对话框可见）
          recordToMaster('user', text);
          recordToMaster('ai', (dispatch.count > 1)
            ? ('🧩 已收到，拆解为 ' + dispatch.count + ' 个子任务后台执行（' + dispatch.taskId + '）')
            : ('📨 已收到，派发给 ' + (dispatch.roleId || dispatch.intent) + ' 后台执行（' + dispatch.taskId + '）'));
          setState('idle', {
            text: '已收到',
            sub: (dispatch.count > 1)
              ? ('已拆解为 ' + dispatch.count + ' 个子任务')
              : ('派发 ' + (dispatch.roleId || dispatch.intent))
          });
          return true;
        }
      } catch (dispatchErr) {
        console.warn('[hud] 指挥官派发失败，回退普通发送:', dispatchErr && dispatchErr.message);
      }
    }
    // ---- 普通发送路径 ----
    // Wave 9：HUD 是 master（廿廿）聊天界面——闲聊必须落在 master 会话。
    // 若主窗口当前不在 master，先切过去（switchSession 会清空输入框，故之后再填文本）。
    var masterId = findMasterId();
    if (masterId && Core.session && typeof Core.session.getCurrentId === 'function' &&
        Core.session.getCurrentId() !== masterId && typeof Core.session.switchSession === 'function') {
      try { Core.session.switchSession(masterId); } catch (e) { console.warn('[hud] 切换 master 会话失败:', e.message); }
    }
    // 真实发送路径：填入输入框 → 调用 Core.api.sendMessage()
    // （与主应用 Enter 键发送完全一致；sendMessage 无参，内部读取 Core.dom.input.value）
    if (Core.dom && Core.dom.input) Core.dom.input.value = text;
    if (Core.api && typeof Core.api.sendMessage === 'function') {
      var ret = Core.api.sendMessage();
      // sendMessage 可能是 async（返回 Promise）——捕获异步拒绝并回传 HUD
      if (ret && typeof ret.catch === 'function') {
        ret.catch(function (err) {
          setState('idle', {
            text: '执行出错了',
            sub: (err && err.message ? String(err.message) : '请检查模型或网络').substring(0, 30)
          });
        });
      }
      return true;
    }
    // 回退：派发事件让上层处理
    if (Core.emit) { Core.emit('hud-command', { text: text }); return true; }
    setState('idle', { text: '主应用未就绪', sub: '聊天模块尚未加载完成' });
    return false;
  } catch (e) {
    setState('idle', {
      text: '执行出错了',
      sub: (e && e.message ? String(e.message) : '发送失败').substring(0, 30)
    });
    return false;
  }
}

// ═══════════════════════════════════════════
// Wave 6d：HUD ↔ 画布联动
// ═══════════════════════════════════════════

function getStore() {
  return (Core && Core.canvas && Core.canvas.store) || null;
}

// 重新统计画布摘要（工作区名 + 运行中/总节点数）
function recomputeCanvasSummary() {
  var store = getStore();
  if (store) {
    var nodes = (typeof store.listNodes === 'function') ? store.listNodes() : [];
    var running = 0;
    nodes.forEach(function (n) { if (LIVE_STATES[n.status]) running += 1; });
    _canvasSummary = {
      workspace: (typeof store.getWorkspace === 'function') ? store.getWorkspace() : 'default',
      running: running,
      total: nodes.length
    };
  }
  return _canvasSummary;
}

// 把画布摘要中继到 HUD 窗口（canvasOnly 标记，HUD 视图只更新画布 chip，不打扰角色状态）
function relayCanvasSummary() {
  recomputeCanvasSummary();
  _send('hud-relay', { canvasOnly: true, canvas: _canvasSummary });
}

// 记住最近进入运行态的节点，作为 HUD 一键定位的目标
function trackActiveNode(node) {
  if (node && node.id && LIVE_STATES[node.status]) _activeNodeId = node.id;
}

// 定位到活跃节点（需画布已挂载）
function focusActiveNode() {
  var store = getStore();
  if (!_activeNodeId || !store || typeof store.getNode !== 'function') return null;
  if (!store.getNode(_activeNodeId)) { _activeNodeId = null; return null; }
  if (Core.canvas) {
    if (typeof Core.canvas.focusNode === 'function') Core.canvas.focusNode(_activeNodeId);
    if (typeof Core.canvas.selectNode === 'function') Core.canvas.selectNode(_activeNodeId);
  }
  return _activeNodeId;
}

// 一键展开画布并定位到活跃节点
function openCanvas() {
  if (Core && typeof Core.emit === 'function') {
    try { Core.emit('hud:open-canvas', { nodeId: _activeNodeId }); } catch (e) { /* noop */ }
  }
  if (Core && Core.canvas && typeof Core.canvas.open === 'function') {
    Core.canvas.open();
    return focusActiveNode() || true;
  }
  return false;
}

// ═══════════════════════════════════════════
// Wave 9：HUD = master（廿廿）聊天界面 —— 会话中继
//   HUD 是独立渲染进程，拿不到主窗口的 Core.session 数据，
//   故由本模块（主窗口渲染进程）读取 master 会话消息，经 hud-relay
//   以 { chatOnly:true, chat:{...} } 载荷推送，HUD 视图只渲染聊天、不打扰角色状态。
// ═══════════════════════════════════════════
var CHAT_LIMIT = 60;          // 推送给 HUD 的最近消息条数（轻量窗口）
var CHAT_POLL_MS = 900;       // 轮询间隔：兜底捕获任意来源的 master 会话写入
var _lastChatSig = '';        // 消息数:末条时间戳 —— 变化才推送，避免空转
var _chatPollTimer = null;

function findMasterId() {
  if (!Core || !Core.session || !Core.session.sessions) return null;
  var sessions = Core.session.sessions;
  for (var id in sessions) {
    if (sessions[id] && sessions[id].roleType === 'master') return id;
  }
  return null;
}

// 把消息内容压成适合 IPC 传输的纯文本（去附件大文件内容，保留显示文本）
function _chatText(content) {
  var s = String(content == null ? '' : content);
  if (s.length > 2000) s = s.substring(0, 2000) + '\n…(内容过长已截断)';
  return s;
}

function serializeMasterMessages() {
  var masterId = findMasterId();
  if (!masterId) return null;
  var master = Core.session.sessions[masterId];
  if (!master || !Array.isArray(master.messages)) return null;
  var msgs = master.messages
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'ai' || m.role === 'assistant'); })
    .slice(-CHAT_LIMIT)
    .map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'ai', content: _chatText(m.content), ts: m.timestamp || 0 };
    });
  return { masterId: masterId, title: master.title || '廿廿', messages: msgs };
}

// 推送 master 会话快照到 HUD（force=true 无视签名强制推送，用于 HUD 刚打开时的首次同步）
function relayMasterChat(force) {
  var chat = serializeMasterMessages();
  if (!chat) return;
  var sig = chat.messages.length + ':' + (chat.messages.length ? chat.messages[chat.messages.length - 1].ts : 0);
  if (!force && sig === _lastChatSig) return;
  _lastChatSig = sig;
  _send('hud-relay', { chatOnly: true, chat: chat });
}

// 轮询兜底：任意来源（主窗口输入、后台任务聚合、知识库等）写入 master 都能被 HUD 感知
function startChatPolling() {
  if (_chatPollTimer || typeof setInterval !== 'function') return;
  _chatPollTimer = setInterval(function () {
    try { relayMasterChat(false); } catch (e) { /* noop */ }
  }, CHAT_POLL_MS);
}

// 把一条消息记入 master 会话（HUD 派发任务时同步用户消息/回执，保证记录可溯）
function recordToMaster(role, content) {
  try {
    var masterId = findMasterId();
    if (!masterId) return;
    var master = Core.session.sessions[masterId];
    if (!master || !Array.isArray(master.messages)) return;
    master.messages.push({ role: role, content: content, timestamp: Date.now() });
    if (Core.session.saveSession) Core.session.saveSession(masterId);
    relayMasterChat(true);
  } catch (e) { /* noop */ }
}

function init(_Core) {
  Core = _Core;

  Core.hud = {
    setState: setState,
    setProgress: setProgress,
    setGauge: setGauge,
    setActiveFn: setActiveFn,
    show: show,
    hide: hide,
    toggle: toggle,
    injectCommand: injectCommand,
    // Wave 6d：画布联动
    openCanvas: openCanvas,
    focusActiveNode: focusActiveNode,
    relayCanvasSummary: relayCanvasSummary,
    // Wave 9：master 会话聊天中继
    relayMasterChat: relayMasterChat,
    findMasterId: findMasterId,
    get state() { return _state; },
    get visible() { return _visible; },
    get canvasSummary() { return recomputeCanvasSummary(); },
    get activeNodeId() { return _activeNodeId; }
  };

  // ---- 自动中继 Agent 生命周期状态 ----
  if (Core.on) {
    Core.on('typingStart', function () { setState('thinking', { text: '正在思考中…', sub: '分析你的意图与上下文' }); });
    Core.on('agent-think', function (d) {
      d = d || {};
      setState('thinking', { text: '正在思考中…', sub: d.step ? ('步骤 ' + d.step + (d.maxSteps ? '/' + d.maxSteps : '')) : '推理中' });
    });
    Core.on('agent-tool', function (d) {
      d = d || {};
      var fn = TOOL_FN_MAP[d.action] || null;
      var gauge = (d.step && d.maxSteps) ? Math.round(d.step / d.maxSteps * 100) : null;
      var payload = {
        state: 'executing',
        text: '正在执行任务…',
        sub: d.action ? ('调用 ' + d.action) : '调用工具链处理中',
        banner: d.action ? ('正在执行：' + d.action) : undefined,
        fn: fn,
        progress: gauge != null ? gauge : undefined,
        gauge: gauge != null ? gauge : undefined,
        gaugeTitle: '工作流',
        gaugeSub: d.action ? ('步骤 ' + d.step + '/' + d.maxSteps) : '执行中'
      };
      _send('hud-relay', payload);
      _state = 'executing';
    });
    Core.on('typingEnd', function () {
      setState('idle', { text: '主人，任务完成啦', sub: '随时为你效劳', gauge: 0, gaugeTitle: '工作流', gaugeSub: '等待指令', fn: '' });
    });
    Core.on('ai:error', function (d) {
      d = d || {};
      setState('idle', { text: '执行出错了', sub: d.message ? String(d.message).substring(0, 30) : '请检查模型或网络', gauge: 0, fn: '' });
    });

    // ---- Wave 6d：订阅画布事件 → 跟踪活跃节点 + 同步 HUD 画布 chip ----
    Core.on('canvas:node-add', function (d) {
      if (d && d.node) trackActiveNode(d.node);
      relayCanvasSummary();
    });
    Core.on('canvas:node-update', function (d) {
      if (d && d.node) trackActiveNode(d.node);
      relayCanvasSummary();
    });
    Core.on('canvas:node-remove', function (d) {
      if (d && d.id && d.id === _activeNodeId) _activeNodeId = null;
      relayCanvasSummary();
    });
    Core.on('canvas:workspace', function () { relayCanvasSummary(); });
    Core.on('canvas:load', function () { relayCanvasSummary(); });
    Core.on('canvas:clear', function () { _activeNodeId = null; relayCanvasSummary(); });
  }

  // ---- 接收 HUD 窗口发来的指令（经主进程转发）----
  if (bridge && typeof bridge.on === 'function') {
    bridge.on('hud-command', function (payload) {
      payload = payload || {};
      // Wave 6d：HUD「展开成画布」按钮
      if (payload.action === 'open-canvas') { openCanvas(); return; }
      // Wave 9：HUD 窗口就绪 → 强制全量同步 master 会话（首次打开即可见历史）
      if (payload.action === 'sync-chat') { relayMasterChat(true); return; }
      if (payload.text) injectCommand(payload.text);
    });
  }

  // ---- 注册 /hud 命令 ----
  if (Core.custom && typeof Core.custom.registerCommand === 'function') {
    Core.custom.registerCommand('hud', '显示/隐藏桌面 HUD 悬浮窗', function () { toggle(); }, false);
  }

  // ---- Wave 6d：画布已挂载时，初始化即同步一次画布摘要 ----
  if (getStore()) relayCanvasSummary();

  // ---- Wave 9：master 会话聊天轮询兜底 + 初始同步 ----
  startChatPolling();
  relayMasterChat(true);
}

module.exports = {
  name: 'hud',
  // Wave 8：指挥官模式依赖任务调度器（Core.taskScheduler）做非阻塞派发
  dependencies: ['task-scheduler'],
  init: init,
  // 导出内部函数便于单元测试
  _internals: { TOOL_FN_MAP: TOOL_FN_MAP, LIVE_STATES: LIVE_STATES }
};
