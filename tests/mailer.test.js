// tests/mailer.test.js - 邮箱 SMTP 发送单元测试 (P2-7)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mod = require('../modules/mailer');

function makeCore() {
  return {
    config: {},
    session: { getCurrentId: () => 's1', addMessage: () => {}, renderMessages: () => {} },
    custom: { registerCommand: () => {} }
  };
}

test('_encodeBase64 正确', () => {
  assert.strictEqual(mod._encodeBase64('aladdin:opensesame'), Buffer.from('aladdin:opensesame').toString('base64'));
});

test('_buildMailData 含必要头并以 . 结束', () => {
  const data = mod._buildMailData('a@x.com', 'b@y.com', '你好主题', '正文内容');
  assert.ok(data.indexOf('From: a@x.com') >= 0);
  assert.ok(data.indexOf('To: b@y.com') >= 0);
  assert.ok(data.indexOf('Subject:') >= 0);
  assert.ok(data.indexOf('正文内容') >= 0);
  assert.ok(data.endsWith('\r\n.\r\n'), 'DATA 应以单独一个点结束');
});

test('_encodeSubject 非 ASCII 做 RFC2047 编码', () => {
  const s = mod._buildMailData('a@x.com', 'b@y.com', '发票通知', 'x');
  const line = s.split('\r\n').find(l => l.startsWith('Subject:'));
  assert.ok(line.indexOf('=?UTF-8?B?') >= 0, '非 ASCII 主题应被编码');
  assert.ok(line.indexOf('发票通知') < 0, '原文不应明文出现');
});

test('_buildAuthLogin base64 可还原', () => {
  const a = mod._buildAuthLogin('user1', 'pw1');
  assert.strictEqual(a.verb, 'AUTH LOGIN');
  assert.strictEqual(Buffer.from(a.userB64, 'base64').toString('utf-8'), 'user1');
  assert.strictEqual(Buffer.from(a.passB64, 'base64').toString('utf-8'), 'pw1');
});

test('_buildAuthPlain 格式', () => {
  const a = mod._buildAuthPlain('u', 'p');
  assert.strictEqual(a.verb, 'AUTH PLAIN');
  assert.strictEqual(Buffer.from(a.token, 'base64').toString('utf-8'), '\u0000u\u0000p');
});

test('sendMail 未配置 SMTP 安全回退', async () => {
  const core = makeCore();
  mod.init(core);
  assert.ok(core.mailer, 'Core.mailer 应挂载');
  const r = await core.mailer.sendMail({ to: 'some@one.com', subject: 'hi', body: 'x' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.indexOf('SMTP') >= 0, '应提示未配置');
});
