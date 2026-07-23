// scheduler.js - 定时任务引擎（定时器 + 周期任务 + 延迟执行）
'use strict';

var Core = null;
var fs = null;
var path = null;

var SCHEDULE_FILE = '';
var tasks = [];        // [{ id, name, enabled, type, schedule, action, lastRun, nextRun, runCount, createdAt }]
var activeTimers = {}; // { taskId: intervalId | timeoutId }
var _handlerRegistry = {}; // 🔧 B07: { 'proactive.briefing': fn, ... } 字符串标识符 → 函数映射

// ===== 持久化 =====

function loadTasks() {
  if (!Core || !Core.DATA_ROOT) return;
  SCHEDULE_FILE = path.join(Core.DATA_ROOT, 'workflow-schedule.json');
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      tasks = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('scheduler: Failed to load tasks:', e.message);
    tasks = [];
  }
}

function saveTasks() {
  try {
    if (SCHEDULE_FILE) {
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error('scheduler: Failed to save tasks:', e.message);
  }
}

// ===== 时间解析 =====

function parseInterval(str) {
  // 支持: "30s", "5m", "1h", "2d", "30000"(ms)
  if (!str || typeof str !== 'string') return 0;
  str = str.trim().toLowerCase();

  var match = str.match(/^(\d+)(ms|s|m|h|d)$/);
  if (match) {
    var num = parseInt(match[1]);
    var unit = match[2];
    switch (unit) {
      case 'ms': return num;
      case 's': return num * 1000;
      case 'm': return num * 60 * 1000;
      case 'h': return num * 3600 * 1000;
      case 'd': return num * 86400 * 1000;
    }
  }

  // 纯数字当毫秒
  var num = parseInt(str);
  return isNaN(num) ? 0 : num;
}

function parseCronTime(timeStr) {
  // 简易定时: "09:00", "14:30"
  if (!timeStr) return null;
  var parts = timeStr.split(':');
  if (parts.length !== 2) return null;
  var h = parseInt(parts[0]);
  var m = parseInt(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return { hour: h, minute: m };
}

function getNextCronTime(hour, minute) {
  var now = new Date();
  var next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

// ===== 自然语言时间解析（中文增强） =====

function parseNaturalSchedule(text) {
  // 将中文自然语言描述解析为 schedule 对象
  // 支持: "每天早上9点", "每30分钟", "每小时", "下周一14:30", "一小时后", "每天下午3点30", "工作日9点"
  if (!text || typeof text !== 'string') return null;
  text = text.trim();

  // 中文数字转阿拉伯数字
  var cnNums = { '零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
    '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,'十九':19,
    '二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25,'二十六':26,'二十七':27,'二十八':28,'二十九':29,'三十':30 };

  function cnToNum(str) {
    if (cnNums[str] !== undefined) return cnNums[str];
    var n = parseInt(str);
    return isNaN(n) ? null : n;
  }

  // 提取时间 (HH:MM 或 H点/MM分)
  function extractTime(str) {
    // "9:00", "14:30"
    var m1 = str.match(/(\d{1,2}):(\d{2})/);
    if (m1) return { hour: parseInt(m1[1]), minute: parseInt(m1[2]) };
    // "9点半", "三点半" → 30分（必须先于通用"X点Y分"判断，否则"半"会被忽略而返回整点）
    var mHalf = str.match(/(\d{1,2}|[一二三四五六七八九十]+)[点时]半/);
    if (mHalf) {
      var hHalf = cnToNum(mHalf[1]);
      if (/下午|晚上|晚|pm/i.test(str) && hHalf < 12) hHalf += 12;
      return { hour: hHalf, minute: 30 };
    }
    // "9点30分", "9点30", "3点"
    var m2 = str.match(/(\d{1,2}|[一二三四五六七八九十]+)[点时](\d{1,2}|[一二三四五六七八九十]+)?分?/);
    if (m2) {
      var h = cnToNum(m2[1]);
      var min = m2[2] ? cnToNum(m2[2]) : 0;
      if (min === null) min = 0;
      // "下午"/"晚上" +12h
      if (/下午|晚上|晚|pm/i.test(str) && h < 12) h += 12;
      return { hour: h, minute: min };
    }
    return null;
  }

  // 1. "每X分钟/小时/秒" → interval
  var intervalMatch = text.match(/每\s*(\d+|[一二三四五六七八九十]+)\s*(秒|分钟|分|小时|时|天|日)/);
  if (intervalMatch) {
    var num = cnToNum(intervalMatch[1]);
    var unit = intervalMatch[2];
    var intervalStr = '';
    if (unit === '秒') intervalStr = num + 's';
    else if (unit === '分钟' || unit === '分') intervalStr = num + 'm';
    else if (unit === '小时' || unit === '时') intervalStr = num + 'h';
    else if (unit === '天' || unit === '日') intervalStr = num + 'd';
    return { type: 'interval', interval: intervalStr };
  }

  // 2. "每分钟"/"每小时"/"每天" (没有数字) → interval
  if (/每分钟$|每分$/.test(text)) return { type: 'interval', interval: '1m' };
  if (/每小时$|每时$/.test(text)) return { type: 'interval', interval: '1h' };
  if (/每天$|每日$/.test(text)) return { type: 'daily', time: '09:00' };

  // 3. "X分钟后"/"一小时后"/"半小时后" → once
  var laterMatch = text.match(/(\d+|[一二三四五六七八九十]+|半)\s*(秒|分钟|分|小时|时|天|日)\s*后/);
  if (laterMatch) {
    var num = laterMatch[1] === '半' ? 0.5 : cnToNum(laterMatch[1]);
    var unit = laterMatch[2];
    var delayStr = '';
    if (unit === '秒') delayStr = Math.round(num) + 's';
    else if (unit === '分钟' || unit === '分') delayStr = Math.round(num) + 'm';
    else if (unit === '小时' || unit === '时') delayStr = (num < 1 ? Math.round(num * 60) + 'm' : num + 'h');
    else if (unit === '天' || unit === '日') delayStr = num + 'd';
    return { type: 'once', delay: delayStr };
  }

  // 4. "每天/每日 + 时间" → daily
  if (/每天|每日/.test(text)) {
    var time = extractTime(text);
    if (time) {
      var timeStr = String(time.hour).padStart(2, '0') + ':' + String(time.minute).padStart(2, '0');
      return { type: 'daily', time: timeStr };
    }
    return { type: 'daily', time: '09:00' };
  }

  // 5. "工作日/周一到周五 + 时间" → daily (with weekday filter stored as note)
  if (/工作日|周一到周五|星期一到星期五/.test(text)) {
    var time = extractTime(text);
    if (time) {
      var timeStr = String(time.hour).padStart(2, '0') + ':' + String(time.minute).padStart(2, '0');
      return { type: 'daily', time: timeStr, weekdaysOnly: true };
    }
    return { type: 'daily', time: '09:00', weekdaysOnly: true };
  }

  // 6. "明天/后天/大后天/今天/今晚 + 时间" → 一次性任务（指定日期时刻）
  var dayWordMatch = text.match(/(大后天|后天|明天|明日|今晚|今天晚上|今天|今日)/);
  if (dayWordMatch) {
    var dayWord = dayWordMatch[1];
    var dayTime = extractTime(text);
    var dayTarget = new Date();
    var dayOffset = 0;
    if (dayWord === '明天' || dayWord === '明日') dayOffset = 1;
    else if (dayWord === '后天') dayOffset = 2;
    else if (dayWord === '大后天') dayOffset = 3;
    if (dayTime) {
      dayTarget.setHours(dayTime.hour, dayTime.minute, 0, 0);
    } else {
      // 无具体时间：今晚默认20:00，其余默认09:00
      if (dayWord === '今晚' || dayWord === '今天晚上') dayTarget.setHours(20, 0, 0, 0);
      else dayTarget.setHours(9, 0, 0, 0);
    }
    if (dayOffset > 0) dayTarget.setDate(dayTarget.getDate() + dayOffset);
    return { type: 'once', at: dayTarget.toISOString() };
  }

  // 7. "周X/星期X + 时间" → weekly (用 daily + 86400 * 7 模拟)
  var weekMatch = text.match(/周([一二三四五六日天])|星期([一二三四五六日天])/);
  if (weekMatch) {
    var dayStr = weekMatch[1] || weekMatch[2];
    var dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    var dayNum = dayMap[dayStr];
    var time = extractTime(text);
    var timeStr = time ? String(time.hour).padStart(2, '0') + ':' + String(time.minute).padStart(2, '0') : '09:00';
    return { type: 'weekly', time: timeStr, dayOfWeek: dayNum };
  }

  // 8. 仅包含时间 → daily
  var timeOnly = extractTime(text);
  if (timeOnly) {
    var timeStr = String(timeOnly.hour).padStart(2, '0') + ':' + String(timeOnly.minute).padStart(2, '0');
    return { type: 'daily', time: timeStr };
  }

  return null;
}

// ===== 自然语言提醒意图检测（无需输入 /remind 命令） =====

// 判断文本是否包含"具体时刻 / 周期 / 倒计时"。
// 用作触发门槛之一，避免把"告诉我明天天气"这类问句误判为提醒。
function hasSpecificTime(text) {
  // 具体时刻: "3点" "三点半" "14:30" "3:30"
  if (/([一二三四五六七八九十\d]+\s*[点时])|(\d{1,2}[:：]\d{2})/.test(text)) return true;
  // 周期: "每30分钟" "每2小时" "每天" "每小时"
  if (/每\s*(\d+|[一二三四五六七八九十]+)\s*(秒|分钟|分|小时|时|天|日)/.test(text)) return true;
  if (/每分钟|每分|每小时|每时|每天|每日/.test(text)) return true;
  // 倒计时: "5分钟后" "一小时后" "半小时后"
  if (/(\d+|[一二三四五六七八九十半]+)\s*(秒|分钟|分|小时|时|天|日)\s*后/.test(text)) return true;
  return false;
}

// 从提醒句中提炼核心内容（去掉时间词与意图词），作为任务名和到点发送/提醒的文案。
function extractReminderContent(text) {
  var content = text;
  content = content.replace(/每天|每日/g, '');
  content = content.replace(/每[一二三四五六七八九十\d]+\s*(秒|分钟|分|小时|时|天|日)/g, '');
  content = content.replace(/工作日|周一到周五|星期一到星期五/g, '');
  content = content.replace(/(大后天|后天|明天|明日|今晚|今天晚上|今天|今日)/g, '');
  content = content.replace(/周[一二三四五六日天]|星期[一二三四五六日天]/g, '');
  content = content.replace(/(\d+|[一二三四五六七八九十半]+)\s*(秒|分钟|分|小时|时|天|日)\s*后/g, '');
  content = content.replace(/\d{1,2}[:：]\d{2}/g, '');
  content = content.replace(/[一二三四五六七八九十\d]+\s*[点时]\s*([一二三四五六七八九十\d]+\s*分|半)?/g, '');
  content = content.replace(/上午|下午|晚上|早上|中午|凌晨/g, '');
  // "做个定时任务/设置定时任务/建一个定时任务"等是元指令（要求创建任务），不属于到点发送的内容
  content = content.replace(/(帮我|请|麻烦|给我|设置|创建|添加|搞)?\s*(做|建|来|弄)?\s*(一?个)?\s*定时任务/g, '');
  content = content.replace(/提醒我?|通知我?|推送|推给我|发给我|发我|给我发|给我推|给我|叫我|喊我|播报|别忘了|别忘|记得|告诉我/g, '');
  content = content.replace(/^[，。,.:：;；!！?？\s]+/, '');
  content = content.replace(/\s+/g, ' ').trim();
  return content || text.trim();
}

// 检测一句话是否为"提醒 / 定时推送"意图。
// 双重门槛：必须同时含"提醒类意图词" + "具体时间/周期"，最大限度避免误判普通对话。
// 命中返回 { schedule, content, actionType }，否则返回 null。
function detectReminderIntent(text) {
  if (!text || typeof text !== 'string') return null;
  text = text.trim();
  if (text.length < 4) return null;
  // 命令（以 / 开头）不走自然语言触发，交给命令处理器
  if (text.charAt(0) === '/') return null;

  // 门槛1：明确的提醒 / 推送意图词
  var INTENT_RE = /(提醒我?|推送|推给我|发给我|发我|给我发|给我推|通知我?|叫我|喊我|播报|别忘了|别忘|记得|告诉我)/;
  if (!INTENT_RE.test(text)) return null;

  // 门槛2：具体的时刻 / 周期 / 倒计时
  if (!hasSpecificTime(text)) return null;

  var schedule = parseNaturalSchedule(text);
  if (!schedule) return null;

  // 如果解析为 daily 但原文并无"每天"等周期词（来自"仅时刻"兜底），视为"今天的一次性提醒"
  var hasRecurWord = /每天|每日|工作日|周一到周五|星期一到星期五|周[一二三四五六日天]|星期[一二三四五六日天]/.test(text);
  if (schedule.type === 'daily' && !hasRecurWord) {
    var t = parseCronTime(schedule.time);
    if (t) {
      var target = new Date();
      target.setHours(t.hour, t.minute, 0, 0);
      schedule = { type: 'once', at: target.toISOString() };
    }
  }

  var content = extractReminderContent(text);

  // 动作类型：内容含"需要AI执行/产出"的信号 → send（到点自动发给我处理）；否则 prompt（仅弹窗提醒）
  var AI_ACTION_RE = /(推送|分析|总结|查询|搜索|搜一下|生成|写|整理|发送|播报|获取|大盘|股票|行情|新闻|天气|股价|涨跌|报告|日报|周报|笑话|故事)/;
  var actionType = AI_ACTION_RE.test(content) ? 'send' : 'prompt';

  return { schedule: schedule, content: content, actionType: actionType };
}

// 尝试把一句自然语言直接创建为定时任务。
// 成功返回 { task, schedule, content, actionType }，未命中返回 null。
function tryNaturalRemind(text) {
  var detected = detectReminderIntent(text);
  if (!detected) return null;
  var taskName = detected.content.substring(0, 20) || '自然语言提醒';
  var task = addTask({
    name: taskName,
    schedule: detected.schedule,
    action: { type: detected.actionType, message: detected.content }
  });
  return { task: task, schedule: detected.schedule, content: detected.content, actionType: detected.actionType };
}

// 调度计划的中文描述（用于确认消息与任务列表）
function describeSchedule(schedule) {
  if (!schedule) return '';
  var dayNames = ['日','一','二','三','四','五','六'];
  if (schedule.type === 'interval') return '每 ' + schedule.interval;
  if (schedule.type === 'daily') return '每天 ' + schedule.time + (schedule.weekdaysOnly ? '（工作日）' : '');
  if (schedule.type === 'once') {
    if (schedule.at) return '一次性 ' + new Date(schedule.at).toLocaleString('zh-CN');
    return '一次性 ' + (schedule.delay || schedule.interval || '');
  }
  if (schedule.type === 'cron') return 'Cron: ' + schedule.cron;
  if (schedule.type === 'weekly') return '每周' + dayNames[schedule.dayOfWeek] + ' ' + schedule.time;
  return JSON.stringify(schedule);
}

// ===== Cron 表达式支持 =====

function parseCronExpr(expr) {
  // 标准 cron: 分 时 日 月 周 (5 字段)
  // 支持: *, 数字, 范围(1-5), 步进(*/5), 列表(1,3,5)
  if (!expr || typeof expr !== 'string') return null;
  var parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  function parseField(field, min, max) {
    if (field === '*') return { type: 'all' };
    // 步进
    var stepMatch = field.match(/^\*\/(\d+)$/);
    if (stepMatch) return { type: 'step', step: parseInt(stepMatch[1]) };
    // 范围
    var rangeMatch = field.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) return { type: 'range', from: parseInt(rangeMatch[1]), to: parseInt(rangeMatch[2]) };
    // 列表
    if (field.indexOf(',') >= 0) {
      return { type: 'list', values: field.split(',').map(Number) };
    }
    // 单一数字
    var num = parseInt(field);
    if (!isNaN(num) && num >= min && num <= max) return { type: 'exact', value: num };
    return null;
  }

  var minute = parseField(parts[0], 0, 59);
  var hour = parseField(parts[1], 0, 23);
  var dayOfMonth = parseField(parts[2], 1, 31);
  var month = parseField(parts[3], 1, 12);
  var dayOfWeek = parseField(parts[4], 0, 6); // 0=Sun

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;

  return { minute: minute, hour: hour, dayOfMonth: dayOfMonth, month: month, dayOfWeek: dayOfWeek, raw: expr };
}

function fieldMatches(field, value) {
  if (field.type === 'all') return true;
  if (field.type === 'exact') return field.value === value;
  if (field.type === 'range') return value >= field.from && value <= field.to;
  if (field.type === 'list') return field.values.indexOf(value) >= 0;
  if (field.type === 'step') return value % field.step === 0;
  return false;
}

function getNextCronExprTime(cron) {
  // 找到下一个匹配的 Date（最多搜索 366 天）
  var now = new Date();
  var candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // 至少下一分钟

  for (var i = 0; i < 525960; i++) { // 最多 366 天（分钟数）
    if (fieldMatches(cron.month, candidate.getMonth() + 1) &&
        fieldMatches(cron.dayOfMonth, candidate.getDate()) &&
        fieldMatches(cron.dayOfWeek, candidate.getDay()) &&
        fieldMatches(cron.hour, candidate.getHours()) &&
        fieldMatches(cron.minute, candidate.getMinutes())) {
      return candidate.getTime();
    }
    candidate = new Date(candidate.getTime() + 60000); // +1 分钟
  }
  return null; // 无匹配
}

function startCronTask(task) {
  var cron = parseCronExpr(task.schedule.cron);
  if (!cron) {
    console.warn('scheduler: Invalid cron expression:', task.schedule.cron);
    return false;
  }

  function scheduleNext() {
    var nextTime = getNextCronExprTime(cron);
    if (!nextTime) {
      console.warn('scheduler: No next cron time found for:', task.schedule.cron);
      return;
    }
    var delay = nextTime - Date.now();
    if (delay < 0) delay = 0;

    task.nextRun = nextTime;
    saveTasks();

    activeTimers[task.id] = setTimeout(function() {
      executeTask(task);
      // 安排下一次
      if (task.enabled) scheduleNext();
    }, delay);
  }

  scheduleNext();
  console.log('⏰ scheduler: Started cron task "' + task.name + '" [' + task.schedule.cron + '], next: ' + new Date(task.nextRun).toLocaleString('zh-CN'));
  return true;
}

// ===== 任务执行 =====

async function executeTask(task) {
  if (!task || !task.action) return;

  var action = task.action;
  console.log('⏰ scheduler: Executing task "' + task.name + '"');

  try {
    if (action.type === 'send') {
      // 发送消息到指定会话或当前会话
      var sessionId = action.sessionId || Core.session.getCurrentId();
      var message = action.message || '';
      if (!message) return;

      // 切换到目标会话（如果有）
      if (action.sessionId && Core.session.switchSession) {
        Core.session.switchSession(action.sessionId);
      }

      // 发送消息
      if (Core.dom && Core.dom.input && Core.api && Core.api.sendMessage) {
        Core.dom.input.value = message;
        await Core.api.sendMessage();
      }
    }

    if (action.type === 'summarize') {
      // 自动摘要
      var sessionId = action.sessionId || Core.session.getCurrentId();
      if (Core.workflow && Core.workflow.summary) {
        await Core.workflow.summary(sessionId);
      }
    }

    if (action.type === 'prompt') {
      // 弹出提醒（不自动发送，只填入输入框）
      var message = action.message || '';
      if (Core.dom && Core.dom.input) {
        Core.dom.input.value = message;
        Core.dom.input.focus();
        Core.dom.status.textContent = '⏰ 定时提醒: ' + (task.name || '');
      }
      // 桌面通知
      if (Core.plugins && Core.plugins.callHook) {
        // 使用 Notification
        try {
          var Notification = require('electron').Notification;
          new Notification({
            title: '⏰ 定时提醒',
            body: (task.name || '') + ': ' + message.substring(0, 100)
          }).show();
        } catch (e) {}
      }
    }

    if (action.type === 'custom' && action.handler) {
      // 自定义处理函数
      try {
        if (typeof action.handler === 'function') {
          // 函数引用直接调用
          action.handler();
        } else if (_handlerRegistry[action.handler]) {
          // 🔧 B07: 注册表查找（handler 为标识符字符串，如 'proactive.briefing'）
          _handlerRegistry[action.handler]();
        } else {
          // 向后兼容：字符串代码走 vm 沙箱
          var vm = require('vm');
          var sandbox = {
            console: { log: function() {}, warn: function() {}, error: function() {} },
            Math: Math, Date: Date, JSON: JSON,
            parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, isFinite: isFinite,
            Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
            RegExp: RegExp, Error: Error, Map: Map, Set: Set, Promise: Promise,
            encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
            setTimeout: setTimeout, clearTimeout: clearTimeout
          };
          var context = vm.createContext(sandbox);
          var script = new vm.Script('(function() { ' + action.handler + ' })()', { timeout: 10000 });
          script.runInContext(context);
        }
      } catch (e) {
        console.error('scheduler: Custom handler error:', e.message);
      }
    }

    // 更新运行记录
    task.lastRun = Date.now();
    task.runCount = (task.runCount || 0) + 1;
    saveTasks();

  } catch (e) {
    console.error('scheduler: Task execution error:', e.message);
  }
}

// ===== 定时器管理 =====

function startTask(taskId) {
  var task = tasks.find(function(t) { return t.id === taskId; });
  if (!task || !task.enabled) return false;

  // 清除旧定时器
  stopTask(taskId);

  var schedule = task.schedule || {};

  if (schedule.type === 'interval') {
    // 周期执行
    var intervalMs = parseInterval(schedule.interval);
    if (intervalMs < 1000) {
      console.warn('scheduler: Interval too short (< 1s), skipping');
      return false;
    }
    activeTimers[taskId] = setInterval(function() {
      executeTask(task);
    }, intervalMs);

    task.nextRun = Date.now() + intervalMs;
    saveTasks();
    console.log('⏰ scheduler: Started interval task "' + task.name + '" every ' + schedule.interval);
    return true;
  }

  if (schedule.type === 'daily') {
    // 每天定时
    var time = parseCronTime(schedule.time);
    if (!time) {
      console.warn('scheduler: Invalid daily time:', schedule.time);
      return false;
    }

    var nextRun = getNextCronTime(time.hour, time.minute);
    var delay = nextRun - Date.now();

    activeTimers[taskId] = setTimeout(function() {
      // 工作日过滤：weekdaysOnly 时仅周一到周五执行
      if (schedule.weekdaysOnly) {
        var day = new Date().getDay();
        if (day === 0 || day === 6) {
          console.log('⏰ scheduler: 跳过周末执行 "' + task.name + '"');
        } else {
          executeTask(task);
        }
      } else {
        executeTask(task);
      }
      // 之后每天重复
      activeTimers[taskId] = setInterval(function() {
        if (schedule.weekdaysOnly) {
          var day = new Date().getDay();
          if (day === 0 || day === 6) {
            console.log('⏰ scheduler: 跳过周末执行 "' + task.name + '"');
            return;
          }
        }
        executeTask(task);
      }, 86400000); // 24h
    }, delay);

    task.nextRun = nextRun;
    saveTasks();
    console.log('⏰ scheduler: Scheduled daily task "' + task.name + '" at ' + schedule.time + ', next: ' + new Date(nextRun).toLocaleString('zh-CN'));
    return true;
  }

  if (schedule.type === 'once') {
    // 一次性延迟执行
    var delayMs = parseInterval(schedule.delay || schedule.interval || '0');
    if (schedule.at) {
      // 指定时间
      var atTime = new Date(schedule.at).getTime();
      delayMs = atTime - Date.now();
      if (delayMs < 0) delayMs = 0;
    }

    activeTimers[taskId] = setTimeout(function() {
      executeTask(task);
      delete activeTimers[taskId];
      // 标记为已完成
      task.enabled = false;
      task.nextRun = null;
      saveTasks();
    }, delayMs);

    task.nextRun = Date.now() + delayMs;
    saveTasks();
    console.log('⏰ scheduler: Scheduled one-time task "' + task.name + '" in ' + delayMs + 'ms');
    return true;
  }

  if (schedule.type === 'cron') {
    // Cron 表达式
    return startCronTask(task);
  }

  if (schedule.type === 'weekly') {
    // 每周特定日期 + 时间
    var time = parseCronTime(schedule.time);
    if (!time) return false;
    var targetDay = schedule.dayOfWeek; // 0=Sun, 1=Mon, ...

    function getNextWeekly() {
      var now = new Date();
      var next = new Date(now);
      next.setHours(time.hour, time.minute, 0, 0);
      var currentDay = next.getDay();
      var daysUntil = (targetDay - currentDay + 7) % 7;
      if (daysUntil === 0 && next <= now) daysUntil = 7;
      if (daysUntil > 0) next.setDate(next.getDate() + daysUntil);
      return next.getTime();
    }

    var nextRun = getNextWeekly();
    var delay = nextRun - Date.now();

    activeTimers[taskId] = setTimeout(function() {
      executeTask(task);
      // 每周重复
      activeTimers[taskId] = setInterval(function() {
        executeTask(task);
      }, 7 * 86400000);
    }, delay);

    task.nextRun = nextRun;
    saveTasks();
    console.log('⏰ scheduler: Scheduled weekly task "' + task.name + '" day=' + targetDay + ' at ' + schedule.time);
    return true;
  }

  console.warn('scheduler: Unknown schedule type:', schedule.type);
  return false;
}

function stopTask(taskId) {
  if (activeTimers[taskId]) {
    clearTimeout(activeTimers[taskId]);
    clearInterval(activeTimers[taskId]);
    delete activeTimers[taskId];
  }
  var task = tasks.find(function(t) { return t.id === taskId; });
  if (task) {
    task.nextRun = null;
  }
}

function stopAllTasks() {
  Object.keys(activeTimers).forEach(function(id) {
    stopTask(id);
  });
}

// ===== CRUD =====

function addTask(options) {
  var task = {
    id: 'task_' + Date.now().toString(36),
    name: options.name || '新任务',
    enabled: options.enabled !== false,
    type: 'scheduled',
    schedule: {
      type: (options.schedule && options.schedule.type) || 'interval',  // interval | daily | once | cron | weekly
      interval: (options.schedule && options.schedule.interval) || '',
      time: (options.schedule && options.schedule.time) || '',
      delay: (options.schedule && options.schedule.delay) || '',
      at: (options.schedule && options.schedule.at) || '',
      cron: (options.schedule && options.schedule.cron) || '',
      dayOfWeek: (options.schedule && options.schedule.dayOfWeek !== undefined) ? options.schedule.dayOfWeek : null,
      weekdaysOnly: (options.schedule && options.schedule.weekdaysOnly) || false
    },
    action: {
      type: (options.action && options.action.type) || 'prompt',  // send | summarize | prompt | custom
      message: (options.action && options.action.message) || '',
      sessionId: (options.action && options.action.sessionId) || '',
      handler: (options.action && options.action.handler) || ''
    },
    lastRun: null,
    nextRun: null,
    runCount: 0,
    createdAt: Date.now()
  };

  tasks.push(task);
  saveTasks();

  // 如果启用，立即启动
  if (task.enabled) {
    startTask(task.id);
  }

  return task;
}

function updateTask(taskId, updates) {
  var idx = tasks.findIndex(function(t) { return t.id === taskId; });
  if (idx < 0) return { success: false, error: '任务不存在' };

  Object.assign(tasks[idx], updates);

  // 重启定时器
  stopTask(taskId);
  if (tasks[idx].enabled) {
    startTask(taskId);
  }

  saveTasks();
  return { success: true, task: tasks[idx] };
}

function deleteTask(taskId) {
  stopTask(taskId);
  tasks = tasks.filter(function(t) { return t.id !== taskId; });
  saveTasks();
  return { success: true };
}

function listTasks() {
  return tasks.slice();
}

function runNow(taskId) {
  var task = tasks.find(function(t) { return t.id === taskId; });
  if (!task) return { success: false, error: '任务不存在' };
  executeTask(task);
  return { success: true };
}

// ===== 命令注册 =====

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('schedule', {
    zh: '定时任务: /schedule list|add|delete|run|enable|disable',
    en: 'Scheduled tasks'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'list';

    if (sub === 'list') {
      var list = listTasks();
      if (list.length === 0) {
        showSystemMsg('⏰ 暂无定时任务。\n\n添加示例:\n/schedule add 每日提醒 | daily 09:00 | 请总结昨天的工作进展\n/schedule add 定时摘要 | interval 2h | summary\n/schedule add 5分钟提醒 | once 5m | 该休息了');
        return;
      }
      var text = '⏰ **定时任务列表**\n\n';
      list.forEach(function(task, i) {
        var status = task.enabled ? '▶' : '⏸';
        var scheduleDesc = '';
        if (task.schedule.type === 'interval') scheduleDesc = '每 ' + task.schedule.interval;
        else if (task.schedule.type === 'daily') scheduleDesc = '每天 ' + task.schedule.time + (task.schedule.weekdaysOnly ? ' (工作日)' : '');
        else if (task.schedule.type === 'once') scheduleDesc = '一次性 ' + (task.schedule.delay || task.schedule.interval);
        else if (task.schedule.type === 'cron') scheduleDesc = 'Cron: ' + task.schedule.cron;
        else if (task.schedule.type === 'weekly') {
          var dayNames = ['日','一','二','三','四','五','六'];
          scheduleDesc = '每周' + dayNames[task.schedule.dayOfWeek] + ' ' + task.schedule.time;
        }
        var nextRun = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '-';
        text += (i + 1) + '. ' + status + ' **' + task.name + '** [' + scheduleDesc + ']\n';
        text += '   → ' + task.action.type + ': ' + (task.action.message || task.action.type).substring(0, 50) + '\n';
        text += '   下次: ' + nextRun + ' | 已运行: ' + (task.runCount || 0) + '次 | ID: ' + task.id + '\n';
      });
      showSystemMsg(text);
      return;
    }

    if (sub === 'add') {
      // 格式1: /schedule add 名称 | 调度 | 动作 (原格式)
      // 格式2: /schedule add 名称 | cron 表达式 | 动作
      // 格式3: /schedule add 自然语言描述 (自动解析)
      var rest = parts.slice(1).join(' ');
      var segments = rest.split('|').map(function(s) { return s.trim(); });

      if (segments.length >= 3) {
        // 原格式解析
        var name = segments[0];
        var scheduleStr = segments[1];
        var actionStr = segments[2];

        // 解析调度
        var schedule = {};
        var schedParts = scheduleStr.split(/\s+/);
        if (schedParts[0] === 'interval') {
          schedule = { type: 'interval', interval: schedParts[1] || '1h' };
        } else if (schedParts[0] === 'daily') {
          schedule = { type: 'daily', time: schedParts[1] || '09:00' };
        } else if (schedParts[0] === 'once') {
          schedule = { type: 'once', delay: schedParts[1] || '5m' };
        } else if (schedParts[0] === 'cron') {
          // Cron 表达式: cron 0 9 * * 1-5
          var cronExpr = schedParts.slice(1).join(' ');
          var parsed = parseCronExpr(cronExpr);
          if (!parsed) {
            showSystemMsg('⚠️ 无效的 Cron 表达式: ' + cronExpr + '\n格式: 分 时 日 月 周（如: 0 9 * * 1-5 = 工作日9点）');
            return;
          }
          schedule = { type: 'cron', cron: cronExpr };
        } else if (schedParts[0] === 'weekly') {
          // weekly 1 09:00 = 每周一9点
          var dayNum = parseInt(schedParts[1]) || 1;
          var timeStr = schedParts[2] || '09:00';
          schedule = { type: 'weekly', time: timeStr, dayOfWeek: dayNum };
        } else {
          // 尝试自然语言解析调度部分
          var nlSchedule = parseNaturalSchedule(scheduleStr);
          if (nlSchedule) {
            schedule = nlSchedule;
          } else {
            showSystemMsg('⚠️ 无法解析调度: ' + scheduleStr + '\n支持: interval, daily, once, cron, weekly 或自然语言（如"每天早上9点"、"每30分钟"）');
            return;
          }
        }

        // 解析动作
        var action = {};
        if (actionStr === 'summary' || actionStr === '摘要') {
          action = { type: 'summarize' };
        } else if (actionStr.indexOf('prompt ') === 0) {
          action = { type: 'prompt', message: actionStr.substring(7) };
        } else {
          action = { type: 'send', message: actionStr };
        }

        var task = addTask({ name: name, schedule: schedule, action: action });
        var nextRunStr = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : 'N/A';
        showSystemMsg('✅ 定时任务已创建: **' + task.name + '**\n调度: ' + JSON.stringify(schedule) + '\n下次执行: ' + nextRunStr + '\nID: ' + task.id);
        return;
      }

      // 尝试自然语言解析整个字符串 (如 "每天早上9点提醒我整理日报")
      var nlResult = parseNaturalSchedule(rest);
      if (nlResult) {
        // 提取动作描述（去掉时间部分后的剩余文本）
        var actionText = rest;
        // 移除常见时间前缀
        actionText = actionText.replace(/每天|每日|每[一二三四五六七八九十\d]+\s*(秒|分钟|分|小时|时|天|日)|工作日|周[一二三四五六日天]|星期[一二三四五六日天]/, '');
        actionText = actionText.replace(/\d{1,2}[点时:]\d{0,2}分?|半|上午|下午|晚上/g, '');
        actionText = actionText.replace(/^\s*(提醒我?|通知|执行|发送|做)?\s*/, '');
        actionText = actionText.trim() || rest;

        // 自动生成任务名
        var taskName = actionText.substring(0, 20) || '定时任务';
        var action = { type: 'prompt', message: actionText };
        var task = addTask({ name: taskName, schedule: nlResult, action: action });
        var nextRunStr = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : 'N/A';
        showSystemMsg('✅ 定时任务已创建（自然语言解析）\n**' + task.name + '**\n调度: ' + JSON.stringify(nlResult) + '\n下次: ' + nextRunStr + '\nID: ' + task.id);
        return;
      }

      showSystemMsg('⚠️ 格式: /schedule add <名称> | <调度> | <动作>\n\n或直接使用自然语言:\n/schedule add 每天早上9点提醒我整理日报\n/schedule add 每30分钟检查邮件\n/schedule add 一小时后提醒开会\n\n调度格式:\n- `interval 2h` — 每2小时\n- `daily 09:00` — 每天9点\n- `once 5m` — 5分钟后\n- `cron 0 9 * * 1-5` — 工作日9点\n- `weekly 1 14:00` — 每周一14点\n\n动作:\n- `消息内容` — 自动发送\n- `summary` — 自动摘要\n- `prompt 提醒内容` — 仅提醒');
      return;
    }

    if (sub === 'delete') {
      var taskId = parts[1] || '';
      if (!taskId) {
        showSystemMsg('⚠️ 请提供任务 ID: /schedule delete task_xxx');
        return;
      }
      deleteTask(taskId);
      showSystemMsg('✅ 任务已删除');
      return;
    }

    if (sub === 'run') {
      var taskId = parts[1] || '';
      if (!taskId) {
        showSystemMsg('⚠️ 请提供任务 ID: /schedule run task_xxx');
        return;
      }
      var result = runNow(taskId);
      if (result.success) {
        showSystemMsg('✅ 已立即执行任务');
      } else {
        showSystemMsg('❌ ' + result.error);
      }
      return;
    }

    if (sub === 'enable' || sub === 'disable') {
      var taskId = parts[1] || '';
      if (!taskId) {
        showSystemMsg('⚠️ 请提供任务 ID');
        return;
      }
      updateTask(taskId, { enabled: sub === 'enable' });
      showSystemMsg('✅ 任务已' + (sub === 'enable' ? '启用' : '禁用'));
      return;
    }

    if (sub === 'stop') {
      stopAllTasks();
      showSystemMsg('⏰ 所有定时任务已停止');
      return;
    }

    showSystemMsg('⏰ 定时任务命令:\n/schedule list — 列出任务\n/schedule add <名称> | <调度> | <动作> — 添加\n/schedule add 自然语言描述 — 自动解析\n/schedule delete <ID> — 删除\n/schedule run <ID> — 立即执行\n/schedule enable|disable <ID> — 启用/禁用\n/schedule stop — 停止所有任务\n\n调度类型: interval, daily, once, cron, weekly\n自然语言: "每天早上9点", "每30分钟", "一小时后"');
  });

  // /remind 快捷命令: /remind 5m 该休息了
  Core.custom.registerCommand('remind', {
    zh: '快捷提醒: /remind <时间> <内容>',
    en: 'Quick reminder'
  }, function(args) {
    var text = (args || '').trim();
    if (!text) {
      showSystemMsg('⏰ 用法: /remind <时间> <提醒内容>\n\n示例:\n/remind 5m 该休息眼睛了\n/remind 1h 检查邮件\n/remind 30s 快速提醒\n/remind 明天9点 参加会议');
      return;
    }

    // 尝试解析时间前缀
    var schedule = null;
    // 英文缩写: 5m, 1h, 30s, 2d
    var shortMatch = text.match(/^(\d+)([smhd])\s+(.+)$/);
    if (shortMatch) {
      var num = parseInt(shortMatch[1]);
      var unit = shortMatch[2];
      var msg = shortMatch[3];
      schedule = { type: 'once', delay: num + unit };
      var task = addTask({ name: msg.substring(0, 20), schedule: schedule, action: { type: 'prompt', message: msg } });
      var nextRunStr = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : 'N/A';
      showSystemMsg('✅ 提醒已设置: ' + num + unit + ' 后\n"' + msg + '"\n触发时间: ' + nextRunStr);
      return;
    }

    // 自然语言: "明天9点开会", "半小时后喝水"
    schedule = parseNaturalSchedule(text);
    if (schedule) {
      // 提取消息
      var msg = text;
      msg = msg.replace(/(\d+|[一二三四五六七八九十半]+)\s*(秒|分钟|分|小时|时|天|日)\s*后/, '');
      msg = msg.replace(/(明天|后天|今天)/, '');
      msg = msg.replace(/每天|每日/, '');
      msg = msg.replace(/\d{1,2}[点时:]\d{0,2}分?/, '');
      msg = msg.replace(/^\s*(提醒我?|通知|做)?\s*/, '').trim() || text;

      var task = addTask({ name: msg.substring(0, 20), schedule: schedule, action: { type: 'prompt', message: msg } });
      var nextRunStr = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : 'N/A';
      showSystemMsg('✅ 提醒已设置\n"' + msg + '"\n调度: ' + JSON.stringify(schedule) + '\n触发时间: ' + nextRunStr);
      return;
    }

    showSystemMsg('⚠️ 无法解析时间。示例:\n/remind 5m 该休息了\n/remind 1h 检查邮件\n/remind 半小时后喝水\n/remind 明天9点开会');
  });
}

function showSystemMsg(text) {
  var currentId = Core.session.getCurrentId();
  if (currentId && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) {
      Core.session.renderMessages(currentId);
    }
  }
}

// ===== 恢复已有任务 =====

function restoreActiveTasks() {
  var count = 0;
  tasks.forEach(function(task) {
    if (task.enabled) {
      // 检查是否是一次性已过期任务
      if (task.schedule.type === 'once' && task.nextRun && task.nextRun < Date.now()) {
        task.enabled = false;
        return;
      }
      if (startTask(task.id)) count++;
    }
  });
  if (count > 0) {
    console.log('⏰ scheduler: Restored ' + count + ' active tasks');
  }
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  try {
    fs = require('fs');
    path = require('path');
  } catch (e) {
    console.warn('scheduler.js: fs/path not available');
    return;
  }

  loadTasks();
  registerCommands();
  restoreActiveTasks();

  // 暴露 API
  Core.scheduler = {
    list: listTasks,
    add: addTask,
    update: updateTask,
    delete: deleteTask,
    start: startTask,
    stop: stopTask,
    stopAll: stopAllTasks,
    runNow: runNow,
    parseNaturalSchedule: parseNaturalSchedule,
    describeSchedule: describeSchedule,
    tryNaturalRemind: tryNaturalRemind,
    // 🔧 B07: 注册命名 handler（字符串标识符 → 函数）
    registerHandler: function(name, fn) { _handlerRegistry[name] = fn; }
  };

  console.log('✅ scheduler.js 已加载 (' + tasks.length + ' 任务, ' + Object.keys(activeTimers).length + ' 活跃)');
}

exports.init = init;
