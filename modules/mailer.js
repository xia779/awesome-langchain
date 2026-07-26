// modules/mailer.js - 最小 SMTP 发送（零外部依赖）(P2-7)
// 设计原则：只完善、不删功能；零外部依赖（仅用 Node 内置 net/tls）。
// 支持：465 隐式 TLS；587/25 STARTTLS 升级；AUTH LOGIN/PLAIN。
// 纯函数（_encodeBase64/_buildMailData/_buildAuthLogin）导出供单测；真实发送走 _sendSmtp 并全程 try/catch 降级。
'use strict';

var Core = null;

// ===== 纯函数（导出供单测）=====

function _encodeBase64(s) {
  return Buffer.from(String(s), 'utf-8').toString('base64');
}

// 非 ASCII 主题做 RFC2047 base64 编码
function _encodeSubject(subject) {
  var s = String(subject || '');
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + _encodeBase64(s) + '?=';
}

function _buildMailData(from, to, subject, body) {
  var lines = [];
  lines.push('From: ' + from);
  lines.push('To: ' + to);
  lines.push('Subject: ' + _encodeSubject(subject));
  lines.push('Date: ' + new Date().toUTCString());
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(String(body || ''));
  // SMTP DATA 结束行为单独一个 "."，随 CRLF 分隔一并产出完整数据块
  return lines.join('\r\n') + '\r\n.\r\n';
}

function _buildAuthLogin(user, pass) {
  return {
    verb: 'AUTH LOGIN',
    userB64: _encodeBase64(user),
    passB64: _encodeBase64(pass)
  };
}

function _buildAuthPlain(user, pass) {
  // PLAIN: base64("\0user\0pass")
  return { verb: 'AUTH PLAIN', token: _encodeBase64('\u0000' + user + '\u0000' + pass) };
}

// ===== 配置 =====

function _cfg() {
  return (Core && Core.config && Core.config) ? (Core.config.mail && Core.config.mail.smtp) : null;
}

function configure(partial) {
  partial = partial || {};
  if (!Core.config) Core.config = {};
  if (!Core.config.mail) Core.config.mail = {};
  Core.config.mail.smtp = Object.assign(Core.config.mail.smtp || {}, partial);
  return Core.config.mail.smtp;
}

// ===== 真实 SMTP 会话（仅在用户实际发送时触发）=====

function _sendSmtp(smtp, mail) {
  var net = require('net');
  var tls = require('tls');

  return new Promise(function (resolve, reject) {
    var host = smtp.host;
    var port = smtp.port || (smtp.secure ? 465 : 587);
    var sock = smtp.secure
      ? tls.connect({ host: host, port: port }, function () {})
      : net.connect({ host: host, port: port }, function () {});

    var buf = '';
    var pending = null;       // 当前等待的响应 resolver
    var expectCode = 0;
    var usingTls = !!smtp.secure;
    var domain = (smtp.user && smtp.user.split('@')[1]) || 'localhost';

    function attach(s) {
      s.setTimeout(30000);
      s.on('data', function (d) {
        buf += d.toString('utf-8');
        var idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          var line = buf.slice(0, idx); buf = buf.slice(idx + 2);
          handleLine(line);
        }
      });
      s.on('error', function (e) { cleanup(); reject(e); });
      s.on('timeout', function () { cleanup(); reject(new Error('SMTP 连接超时')); });
    }

    function handleLine(line) {
      var code = parseInt(line.slice(0, 3), 10);
      if (line[3] === '-') return; // 多行续行，等待最终行
      if (pending) {
        var p = pending; pending = null;
        if (expectCode && code !== expectCode && !(expectCode === 250 && (code === 235 || code === 354))) {
          cleanup(); p.reject(new Error('SMTP 期望 ' + expectCode + ' 收到 ' + code + ': ' + line));
        } else {
          p.resolve(line);
        }
      }
    }

    function exchange(cmd, code) {
      return new Promise(function (res, rej) {
        pending = { resolve: res, reject: rej };
        expectCode = code;
        if (cmd) { try { sock.write(cmd + '\r\n'); } catch (e) { rej(e); } }
      });
    }

    function cleanup() { try { sock.destroy(); } catch (e) {} }

    attach(sock);

    (async function () {
      try {
        await exchange(null, 220);                       // 服务器欢迎
        await exchange('EHLO ' + domain, 250);           // 握手
        var caps = buf; // 已缓冲的 EHLO 响应中通常含能力
        if (!usingTls && /STARTTLS/i.test(caps)) {
          await exchange('STARTTLS', 220);
          var tlsSock = tls.connect({ socket: sock, host: host, port: port }, function () {});
          sock = tlsSock; usingTls = true;
          attach(sock); // 重新监听解密后的数据
          await new Promise(function (r) { tlsSock.once('secureConnect', r); });
          await exchange('EHLO ' + domain, 250);
        }
        // 认证
        if (smtp.user && smtp.pass) {
          var usePlain = /AUTH(?:\s+LOGIN)?\s+PLAIN/i.test(buf) && !/AUTH\s+LOGIN/i.test(buf);
          if (usePlain) {
            var ap = _buildAuthPlain(smtp.user, smtp.pass);
            await exchange(ap.verb + ' ' + ap.token, 235);
          } else {
            var al = _buildAuthLogin(smtp.user, smtp.pass);
            await exchange('AUTH LOGIN', 334);
            await exchange(al.userB64, 334);
            await exchange(al.passB64, 235);
          }
        }
        await exchange('MAIL FROM:<' + mail.from + '>', 250);
        await exchange('RCPT TO:<' + mail.to + '>', 250);
        await exchange('DATA', 354);
        await exchange(_buildMailData(mail.from, mail.to, mail.subject, mail.body), 250);
        await exchange('QUIT', 221);
        cleanup();
        resolve({ ok: true, info: '邮件已发送' });
      } catch (e) {
        cleanup();
        reject(e);
      }
    })().catch(function (e) { cleanup(); reject(e); });
  });
}

// ===== 对外发送 =====

async function sendMail(opts) {
  opts = opts || {};
  var smtp = _cfg();
  if (!smtp || !smtp.host) {
    return { ok: false, error: '未配置 SMTP：请在设置中填写 mail.smtp（host/port/user/pass），或用 /mail config ...' };
  }
  if (!opts.to) return { ok: false, error: '缺少收件人 to' };
  var from = opts.from || smtp.user || smtp.from || ('noreply@' + (smtp.user ? smtp.user.split('@')[1] : 'localhost'));
  try {
    return await _sendSmtp(smtp, { from: from, to: opts.to, subject: opts.subject || '(无主题)', body: opts.body || '' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== 命令 =====

function showMsg(text) {
  try {
    if (Core.session && Core.session.getCurrentId && Core.session.addMessage) {
      Core.session.addMessage(text, 'assistant');
      var id = Core.session.getCurrentId();
      if (Core.session.renderMessages) Core.session.renderMessages(id);
    }
  } catch (e) { console.log('[mailer] ' + text); }
}

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;
  Core.custom.registerCommand('mail', {
    zh: '邮箱发送: /mail config <host> <port> <user> <pass> | send <to> <主题> <正文> | test <to>',
    en: 'Send email via SMTP'
  }, function (args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = parts[0] || 'help';

    if (sub === 'config') {
      var host = parts[1], port = parseInt(parts[2]) || 587, user = parts[3] || '', pass = parts[4] || '';
      var secure = (port === 465);
      configure({ host: host, port: port, user: user, pass: pass, secure: secure, from: user });
      showMsg('✅ 已保存 SMTP 配置:\nHost: ' + host + ':' + port + '\nUser: ' + user + '\nSecure(TLS): ' + secure);
      return;
    }
    if (sub === 'send' || sub === 'test') {
      var to = parts[1];
      if (!to) { showMsg('⚠️ 用法: /mail send <to> <主题> <正文...>'); return; }
      var subject, body;
      if (sub === 'test') { subject = 'AI Agent 邮件测试'; body = '如果你收到这封邮件，SMTP 配置已生效。'; }
      else {
        // 主题与正文用引号困难，这里以第一个空格后整体作为"主题 正文"：取前 8 词为标题，其余为正文
        var rest = parts.slice(2).join(' ');
        var sp = rest.indexOf(' ');
        subject = sp >= 0 ? rest.slice(0, sp) : rest;
        body = sp >= 0 ? rest.slice(sp + 1) : '';
      }
      showMsg('📤 正在发送邮件给 ' + to + ' ...');
      sendMail({ to: to, subject: subject, body: body }).then(function (r) {
        showMsg(r.ok ? ('✅ ' + (r.info || '发送成功')) : ('⚠️ 发送失败: ' + (r.error || '未知错误')));
      });
      return;
    }
    showMsg('📧 邮箱命令:\n/mail config <host> <port> <user> <pass> — 配置 SMTP\n/mail send <to> <主题> <正文> — 发送\n/mail test <to> — 发送测试邮件');
  });
}

// ===== 初始化 =====

function init(_Core) {
  Core = _Core;
  registerCommands();
  Core.mailer = {
    sendMail: sendMail,
    configure: configure
  };
  var has = _cfg();
  console.log('✅ mailer.js 已加载 (' + (has && has.host ? ('SMTP ' + has.host) : '未配置 SMTP') + ')');
}

module.exports = {
  name: 'mailer',
  dependencies: [],
  init: init,
  _encodeBase64: _encodeBase64,
  _buildMailData: _buildMailData,
  _buildAuthLogin: _buildAuthLogin,
  _buildAuthPlain: _buildAuthPlain
};
