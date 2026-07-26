// modules/self-evolution.js - 自我进化闭环 (P2-1)
// 设计原则：只完善、不删功能；零外部依赖。
// 闭环：各模块/运行期把失败或异常信号 record() 进来 → 周期 runCycle() 分析 →
//      生成改进提案（优先云端生成，无 API 时走内置规则 playbook）→ 提案持久化 →
//      用户通过 /evolve 查看并应用（apply 仅做记录标记，具体改动由人在设置中落地，避免自动误改）。
'use strict';

var Core = null;
var fs = null;
var path = null;

var FILE = '';
var _signals = [];          // 环形缓冲：最近失败/异常信号
var MAX_SIGNALS = 200;
var proposals = [];         // 已生成提案
var _schedulerTaskId = '';
var CYCLE_INTERVAL = '6h';

function loadState() {
  if (!Core || !Core.DATA_ROOT) return;
  // 信号为瞬态（不持久化），每次 init 清空；提案缺失文件也从空开始
  _signals = [];
  proposals = [];
  try { fs.mkdirSync(Core.DATA_ROOT, { recursive: true }); } catch (e) {}
  FILE = path.join(Core.DATA_ROOT, 'self-evolution.json');
  try {
    if (fs.existsSync(FILE)) {
      var s = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      if (Array.isArray(s.proposals)) proposals = s.proposals;
    }
  } catch (e) { proposals = []; }
}

function saveState() {
  try { if (FILE) fs.writeFileSync(FILE, JSON.stringify({ proposals: proposals }, null, 2), 'utf-8'); }
  catch (e) { console.error('self-evolution: 保存失败', e.message); }
}

// ===== 信号采集 =====

function record(signal) {
  if (!signal) return;
  var s = {
    time: Date.now(),
    category: signal.category || 'misc',
    message: String(signal.message || ''),
    context: signal.context || ''
  };
  _signals.push(s);
  if (_signals.length > MAX_SIGNALS) _signals = _signals.slice(-MAX_SIGNALS);
}

function recordError(message, context) {
  record({ category: 'error', message: message, context: context || '' });
}

function getSignals() { return _signals.slice(); }

// ===== 规则 playbook（导出供单测，无需云端）=====

function _categorize(signals) {
  var counts = {};
  signals.forEach(function (s) { counts[s.category] = (counts[s.category] || 0) + 1; });
  return counts;
}

// 从信号文本粗略归类（便于 playbook 命中）
function _inferType(msg) {
  var m = String(msg || '').toLowerCase();
  if (m.indexOf('timeout') >= 0 || m.indexOf('超时') >= 0) return 'timeout';
  if (m.indexOf('rate') >= 0 || m.indexOf('429') >= 0 || m.indexOf('限流') >= 0) return 'rate_limit';
  if (m.indexOf('parse') >= 0 || m.indexOf('json') >= 0 || m.indexOf('解析') >= 0) return 'parse';
  if (m.indexOf('tool') >= 0 || m.indexOf('工具') >= 0) return 'tool_fail';
  if (m.indexOf('network') >= 0 || m.indexOf('fetch') >= 0 || m.indexOf('econn') >= 0 || m.indexOf('网络') >= 0) return 'network';
  return 'generic';
}

var PLAYBOOK = {
  timeout: { title: '请求超时频发', detail: '建议提高相关请求的超时阈值（如 10s→30s）并增加指数退避重试。' },
  rate_limit: { title: '触发限流/配额', detail: '建议接入请求队列与令牌桶限流，并在 429 时按 Retry-After 退避。' },
  parse: { title: '解析/序列化失败', detail: '建议对外部响应做 schema 校验与容错解析，单条异常不影响整体。' },
  tool_fail: { title: '工具调用失败', detail: '建议为关键工具增加失败兜底与替代路径，并记录失败上下文便于复盘。' },
  network: { title: '网络连接不稳定', detail: '建议增加连接健康检查、失败自动重连与本地缓存兜底。' },
  generic: { title: '重复出现的异常', detail: '建议关注该异常的根因，补充针对性防护与日志。' }
};

// 规则分析：返回提案数组
function _analyze(signals) {
  if (!signals || !signals.length) return [];
  var results = [];
  var byType = {}; // type -> [signals]
  signals.forEach(function (s) {
    var t = _inferType(s.message);
    (byType[t] = byType[t] || []).push(s);
  });
  Object.keys(byType).forEach(function (t) {
    var group = byType[t];
    var pb = PLAYBOOK[t] || PLAYBOOK.generic;
    var sample = group.slice(0, 3).map(function (g) { return g.message; });
    results.push({
      id: 'se_' + Date.now().toString(36) + '_' + t,
      type: t,
      title: pb.title + '（' + group.length + ' 次）',
      detail: pb.detail,
      samples: sample,
      time: Date.now(),
      status: 'pending'
    });
  });
  return results;
}

function _generateCloudPrompt(signals) {
  var lines = signals.slice(-20).map(function (s) {
    return '- [' + s.category + '] ' + s.message + (s.context ? ' (' + s.context + ')' : '');
  });
  return '你是一个 AI 智能体的自我进化分析器。下面是近期运行期捕获的失败/异常信号，' +
    '请输出 JSON 数组，每项 { "type", "title", "detail", "priority" }，给出可落地的改进建议（不要改代码，只给方案）。\n' +
    '信号:\n' + lines.join('\n');
}

// ===== 周期运行 =====

async function runCycle(opts) {
  opts = opts || {};
  if (_signals.length === 0) return { generated: 0, proposals: [] };

  var generated = [];
  var useCloud = (Core.config && Core.config.selfEvolution && Core.config.selfEvolution.useCloud) && Core.cloudApi && Core.cloudApi.callCloudAPI;
  if (useCloud && !opts.skipCloud) {
    try {
      var prompt = _generateCloudPrompt(_signals);
      var data = await Core.cloudApi.callCloudAPI(prompt, '你是严谨的工程分析师。', 0.3, null, null, { disableTools: true });
      var text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      var parsed = _safeParseJsonArray(text);
      if (parsed && parsed.length) {
        parsed.forEach(function (p) {
          generated.push({
            id: 'se_' + Date.now().toString(36) + '_cloud',
            type: p.type || 'cloud',
            title: p.title || '云端建议',
            detail: p.detail || '',
            priority: p.priority || 'medium',
            time: Date.now(),
            status: 'pending'
          });
        });
      }
    } catch (e) {
      console.warn('self-evolution: 云端生成失败，回退规则分析', e_message(e));
    }
  }

  // 规则分析始终补充（双保险，离线也能产出）
  var ruleBased = _analyze(_signals);
  generated = generated.concat(ruleBased);

  proposals = proposals.concat(generated);
  if (proposals.length > 100) proposals = proposals.slice(-100);
  saveState();
  // 分析后清空信号，避免重复提案
  _signals = [];
  return { generated: generated.length, proposals: generated };
}

function _safeParseJsonArray(text) {
  try {
    var m = String(text).match(/\[[\s\S]*\]/);
    if (!m) return null;
    var arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : null;
  } catch (e) { return null; }
}

function e_message(e) { return e && e.message ? e.message : String(e); }

// ===== 提案查询/应用 =====

function getProposals(filter) {
  filter = filter || {};
  var out = proposals.slice();
  if (filter.status) out = out.filter(function (p) { return p.status === filter.status; });
  if (filter.limit) out = out.slice(0, filter.limit);
  return out;
}

function applyProposal(id) {
  var p = proposals.find(function (x) { return x.id === id; });
  if (!p) return false;
  p.status = 'applied';
  p.appliedAt = Date.now();
  saveState();
  return true;
}

// ===== 定时任务 =====

function _ensureSchedulerTask() {
  if (!Core.scheduler || !Core.scheduler.registerHandler) return;
  Core.scheduler.registerHandler('evolution.cycle', function () {
    runCycle().catch(function (e) { console.error('self-evolution: 周期失败', e_message(e)); });
  });
  try {
    var existing = Core.scheduler.list() || [];
    var found = existing.some(function (t) { return (t.name || '').indexOf('自我进化') >= 0; });
    if (!found) {
      var task = Core.scheduler.add({
        name: '自我进化分析',
        schedule: { type: 'interval', interval: CYCLE_INTERVAL },
        action: { type: 'custom', handler: 'evolution.cycle' }
      });
      _schedulerTaskId = task.id;
    }
  } catch (e) { console.warn('self-evolution: 定时注册失败', e_message(e)); }
}

// ===== 命令 =====

function showMsg(text) {
  try {
    if (Core.session && Core.session.getCurrentId && Core.session.addMessage) {
      Core.session.addMessage(text, 'assistant');
      var id = Core.session.getCurrentId();
      if (Core.session.renderMessages) Core.session.renderMessages(id);
    }
  } catch (e) { console.log('[self-evolution] ' + text); }
}

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('evolve', {
    zh: '自我进化: /evolve list | run | apply <id> | signals',
    en: 'Self-evolution loop'
  }, function (args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'run') {
      showMsg('🔄 正在分析近期信号...');
      runCycle({ skipCloud: true }).then(function (r) {
        showMsg('✅ 生成 ' + r.generated + ' 条改进提案。用 `/evolve list` 查看。');
      });
      return;
    }
    if (sub === 'signals') {
      var sigs = getSignals();
      if (!sigs.length) { showMsg('📭 暂无可分析信号。运行期异常会自动 record 进来。'); return; }
      var t = '📥 **近期信号 (' + sigs.length + ')**\n\n';
      sigs.slice(-15).forEach(function (s, i) {
        t += (i + 1) + '. [' + s.category + '] ' + (s.message || '').substring(0, 80) + '\n';
      });
      showMsg(t);
      return;
    }
    if (sub === 'apply') {
      var id = parts[1];
      if (!id) { showMsg('⚠️ 用法: /evolve apply <id>'); return; }
      showMsg(applyProposal(id) ? '✅ 已标记提案为已应用: ' + id : '⚠️ 未找到提案 ' + id);
      return;
    }
    // list
    var list = getProposals();
    if (!list.length) { showMsg('📭 暂无提案。用 `/evolve run` 立即分析，或等待周期自动运行。'); return; }
    var t2 = '🧬 **自我进化提案 (' + list.length + ')**\n\n';
    list.slice(0, 15).forEach(function (p, i) {
      t2 += (i + 1) + '. ' + (p.status === 'applied' ? '✅' : '⏳') + ' **' + p.title + '**\n';
      t2 += '   ' + (p.detail || '').substring(0, 120) + '\n';
      t2 += '   ID: `' + p.id + '`\n';
    });
    t2 += '\n用 `/evolve apply <id>` 标记已落地。';
    showMsg(t2);
  });
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  try { fs = require('fs'); path = require('path'); } catch (e) {
    console.warn('self-evolution.js: 依赖不可用', e.message); return;
  }
  loadState();
  registerCommands();
  _ensureSchedulerTask();
  Core.selfEvolution = {
    record: record,
    recordError: recordError,
    runCycle: runCycle,
    getProposals: getProposals,
    applyProposal: applyProposal,
    getSignals: getSignals
  };
  console.log('✅ self-evolution.js 已加载 (提案 ' + proposals.length + ' 条)');
}

module.exports = {
  name: 'self-evolution',
  dependencies: ['scheduler'],
  init: init,
  _analyze: _analyze,
  _inferType: _inferType,
  _generateCloudPrompt: _generateCloudPrompt,
  _categorize: _categorize
};
