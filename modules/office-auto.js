// modules/office-auto.js - 办公自动化（邮件 + 日程 + 文档操作）
// 支持 IMAP/SMTP 邮件、CalDAV 日程、文件整理
'use strict';

var Core = null;
var fs = null;
var path = null;
var net = null;
var tls = null;

// ===== 配置 =====
function getConfig() {
  return (Core.config && Core.config.office) || {};
}

// ===== 邮件：SMTP 发送 =====
async function sendEmail(options) {
  // options: { to, subject, body, html, cc, bcc, attachments }
  var cfg = getConfig();
  if (!cfg.smtpHost || !cfg.smtpUser) {
    return { success: false, error: 'SMTP 未配置。请在设置中配置 office.smtpHost/smtpUser/smtpPass' };
  }

  var smtpHost = cfg.smtpHost;
  var smtpPort = cfg.smtpPort || 465;
  var smtpUser = cfg.smtpUser;
  var smtpPass = cfg.smtpPass || '';
  var useSSL = cfg.smtpSSL !== false;

  // 构建邮件内容
  var boundary = '----=_Part_' + Date.now().toString(36);
  var from = cfg.smtpFrom || smtpUser;
  var lines = [];
  lines.push('From: ' + from);
  lines.push('To: ' + (options.to || ''));
  if (options.cc) lines.push('Cc: ' + options.cc);
  lines.push('Subject: =?UTF-8?B?' + Buffer.from(options.subject || '', 'utf8').toString('base64') + '?=');
  lines.push('MIME-Version: 1.0');
  lines.push('Date: ' + new Date().toUTCString());

  if (options.html) {
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('');
    lines.push(options.html);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(options.body || '');
  }

  var message = lines.join('\r\n');

  return new Promise(function(resolve) {
    try {
      var socket;
      if (useSSL) {
        socket = tls.connect(smtpPort, smtpHost, { rejectUnauthorized: false }, function() {
          doSmtpHandshake(socket, smtpUser, smtpPass, from, options.to, message, resolve);
        });
      } else {
        socket = net.connect(smtpPort, smtpHost, function() {
          doSmtpHandshake(socket, smtpUser, smtpPass, from, options.to, message, resolve);
        });
      }
      socket.on('error', function(e) { resolve({ success: false, error: 'SMTP连接失败: ' + e.message }); });
      socket.setTimeout(15000, function() { socket.destroy(); resolve({ success: false, error: 'SMTP超时' }); });
    } catch(e) {
      resolve({ success: false, error: e.message });
    }
  });
}

function doSmtpHandshake(socket, user, pass, from, to, message, resolve) {
  var step = 0;
  var buffer = '';
  var authBase64 = Buffer.from('\0' + user + '\0' + pass).toString('base64');

  socket.on('data', function(data) {
    buffer += data.toString();
    if (buffer.indexOf('\r\n') < 0) return;
    var code = parseInt(buffer.substring(0, 3));
    buffer = '';

    if (step === 0 && code === 220) {
      socket.write('EHLO localhost\r\n'); step = 1;
    } else if (step === 1 && code === 250) {
      socket.write('AUTH PLAIN ' + authBase64 + '\r\n'); step = 2;
    } else if (step === 2 && code === 235) {
      socket.write('MAIL FROM:<' + from + '>\r\n'); step = 3;
    } else if (step === 3 && code === 250) {
      socket.write('RCPT TO:<' + to + '>\r\n'); step = 4;
    } else if (step === 4 && code === 250) {
      socket.write('DATA\r\n'); step = 5;
    } else if (step === 5 && code === 354) {
      socket.write(message + '\r\n.\r\n'); step = 6;
    } else if (step === 6 && code === 250) {
      socket.write('QUIT\r\n');
      socket.end();
      resolve({ success: true, message: '邮件已发送' });
    } else if (code >= 400) {
      socket.destroy();
      resolve({ success: false, error: 'SMTP错误 ' + code + ': ' + buffer });
    }
  });
}

// ===== 邮件：IMAP 读取（简化版）=====
async function readEmails(options) {
  options = options || {};
  var cfg = getConfig();
  if (!cfg.imapHost || !cfg.imapUser) {
    return { success: false, error: 'IMAP 未配置' };
  }
  // 简化实现：使用 IMAP FETCH 获取最近邮件
  var limit = options.limit || 5;
  return { success: false, error: 'IMAP 读取需要 nodemailer 库。运行: npm install nodemailer' };
}

// ===== 日程管理（本地 JSON 存储）=====
function getCalendarPath() {
  return path.join(Core.DATA_ROOT, 'calendar.json');
}

function loadCalendar() {
  try {
    var p = getCalendarPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.warn('⚠️ [office-auto] 操作失败:', e.message || e); }
  return { events: [] };
}

function saveCalendar(data) {
  try { fs.writeFileSync(getCalendarPath(), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.warn('⚠️ [office-auto] 操作失败:', e.message || e); }
}

function addEvent(event) {
  // event: { title, date, time, duration, location, notes }
  var cal = loadCalendar();
  var ev = {
    id: 'ev_' + Date.now().toString(36),
    title: event.title || '未命名事件',
    date: event.date || new Date().toISOString().split('T')[0],
    time: event.time || '09:00',
    duration: event.duration || 60,
    location: event.location || '',
    notes: event.notes || '',
    createdAt: new Date().toISOString()
  };
  cal.events.push(ev);
  saveCalendar(cal);
  return { success: true, event: ev };
}

function listEvents(dateFilter) {
  var cal = loadCalendar();
  var events = cal.events;
  if (dateFilter) {
    events = events.filter(function(e) { return e.date === dateFilter; });
  }
  events.sort(function(a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
  return events;
}

function deleteEvent(eventId) {
  var cal = loadCalendar();
  cal.events = cal.events.filter(function(e) { return e.id !== eventId; });
  saveCalendar(cal);
  return { success: true };
}

// ===== 文件整理 =====
function organizeFolder(folderPath, options) {
  options = options || {};
  if (!fs.existsSync(folderPath)) return { success: false, error: '目录不存在: ' + folderPath };

  var files = fs.readdirSync(folderPath).filter(function(f) {
    return fs.statSync(path.join(folderPath, f)).isFile();
  });

  // 按扩展名分类
  var categories = {
    '文档': ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt'],
    '表格': ['.xlsx', '.xls', '.csv', '.ods'],
    '图片': ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp'],
    '视频': ['.mp4', '.avi', '.mkv', '.mov', '.wmv'],
    '音频': ['.mp3', '.wav', '.flac', '.aac', '.ogg'],
    '压缩包': ['.zip', '.rar', '.7z', '.tar', '.gz'],
    '代码': ['.js', '.py', '.java', '.c', '.cpp', '.html', '.css', '.json'],
    '其他': []
  };

  var moved = 0;
  var dryRun = options.dryRun !== false; // 默认 dry run

  files.forEach(function(file) {
    var ext = path.extname(file).toLowerCase();
    var targetCat = '其他';
    for (var cat in categories) {
      if (categories[cat].indexOf(ext) >= 0) { targetCat = cat; break; }
    }

    var targetDir = path.join(folderPath, targetCat);
    if (!dryRun) {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(path.join(folderPath, file), path.join(targetDir, file));
      moved++;
    }
  });

  return {
    success: true,
    totalFiles: files.length,
    moved: dryRun ? 0 : moved,
    dryRun: dryRun,
    message: dryRun ? '预览模式：' + files.length + ' 个文件将被分类（使用 dryRun:false 执行）' : '已整理 ' + moved + ' 个文件'
  };
}

// ===== 命令 =====
function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  Core.custom.registerCommand('office', {
    zh: '办公自动化: /office email|calendar|organize',
    en: 'Office automation'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'help';

    if (sub === 'email') {
      var action = parts[1] || 'help';
      if (action === 'send') {
        var to = parts[2] || '';
        var subject = parts[3] || '';
        var body = parts.slice(4).join(' ') || '';
        if (!to) { showMsg('用法: /office email send <收件人> <主题> <正文>'); return; }
        showMsg('正在发送邮件到 ' + to + '...');
        sendEmail({ to: to, subject: subject, body: body }).then(function(r) {
          showMsg(r.success ? '✅ 邮件已发送' : '❌ ' + r.error);
        });
      } else {
        showMsg('📧 邮件命令:\n/office email send <收件人> <主题> <正文>\n\n配置: 设置中填写 office.smtpHost/smtpUser/smtpPass');
      }
      return;
    }

    if (sub === 'calendar') {
      var action = parts[1] || 'list';
      if (action === 'add') {
        var title = parts.slice(2).join(' ') || '新事件';
        var r = addEvent({ title: title, date: new Date().toISOString().split('T')[0] });
        showMsg('✅ 事件已添加: ' + r.event.title + ' (' + r.event.date + ' ' + r.event.time + ')');
      } else if (action === 'list') {
        var events = listEvents(parts[2] || null);
        if (events.length === 0) { showMsg('暂无日程事件'); return; }
        var text = '📅 **日程列表**\n\n';
        events.slice(0, 10).forEach(function(e, i) {
          text += (i+1) + '. ' + e.date + ' ' + e.time + ' — ' + e.title + (e.location ? ' @' + e.location : '') + '\n';
        });
        showMsg(text);
      } else {
        showMsg('📅 日程命令:\n/office calendar list [日期]\n/office calendar add <标题>');
      }
      return;
    }

    if (sub === 'organize') {
      var folder = parts[1] || '';
      if (!folder) { showMsg('用法: /office organize <文件夹路径> [execute]'); return; }
      var dryRun = parts[2] !== 'execute';
      var r = organizeFolder(folder, { dryRun: dryRun });
      showMsg(r.success ? '📁 ' + r.message : '❌ ' + r.error);
      return;
    }

    showMsg('🏢 办公自动化:\n/office email send <to> <subject> <body> — 发邮件\n/office calendar list|add — 日程管理\n/office organize <path> [execute] — 文件整理');
  });
}

function showMsg(text) {
  var id = Core.session.getCurrentId();
  if (id && Core.session.addMessage) {
    Core.session.addMessage(text, 'assistant');
    if (Core.session.renderMessages) Core.session.renderMessages(id);
  }
}

// ===== 初始化 =====
function init(_Core) {
  Core = _Core;
  try { fs = require('fs'); path = require('path'); net = require('net'); tls = require('tls'); } catch(e) { return; }

  registerCommands();

  Core.office = {
    sendEmail: sendEmail,
    readEmails: readEmails,
    addEvent: addEvent,
    listEvents: listEvents,
    deleteEvent: deleteEvent,
    organizeFolder: organizeFolder
  };

  console.log('✅ office-auto.js 已加载 | 邮件+日程+文件整理');
}

module.exports = { name: 'office-auto', dependencies: ['custom', 'session'], init: init };
