// tests/sync-client-p2.test.js - 云端同步增强 (P2-8) 单元测试
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require('../modules/sync-client');

function makeCore(tmpDir) {
  return {
    DATA_ROOT: tmpDir,
    getBackendBase: () => 'http://127.0.0.1:8080',
    config: {},
    custom: { registerCommand: () => {} }
  };
}

test('init 挂载 setRemote / checkRemote', () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-p2-')));
  mod.init(core); // 注意：sync-client 以 module.exports.init 暴露
  assert.ok(core.syncClient, 'Core.syncClient 应挂载');
  assert.strictEqual(typeof core.syncClient.setRemote, 'function');
  assert.strictEqual(typeof core.syncClient.checkRemote, 'function');
});

test('setRemote 写入 config.sync.serverUrl', () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-p2-2-')));
  mod.init(core);
  core.syncClient.setRemote('https://cloud.example/sync');
  assert.strictEqual(core.config.sync.serverUrl, 'https://cloud.example/sync');
});

test('checkRemote 探测并返回可达性（mock fetch）', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-p2-3-')));
  mod.init(core);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ status: 200, ok: true });
  try {
    const r = await core.syncClient.checkRemote('https://cloud.example/sync');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'https://cloud.example/sync');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('checkRemote 网络错误返回不可达（mock fetch 抛错）', async () => {
  const core = makeCore(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-p2-4-')));
  mod.init(core);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const r = await core.syncClient.checkRemote('https://down.example/x');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  } finally {
    globalThis.fetch = realFetch;
  }
});
