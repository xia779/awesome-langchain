// tests/e2e/bridge-tests-renderer.js
// ============================================================================
// Phase 0 桥接冒烟测试包。
// 本文件由 harness.main.js 通过 webContents.executeJavaScript 注入到【真实
// contextIsolation:true 渲染进程的主世界】执行，返回 [{name, ok, detail}]。
//
// 这里只依赖 window.nodeBridge（即生产 preload 暴露的桥），不加载 core-v10.js，
// 目的是把「桥契约」本身作为被测单元——正是 npm test（纯 Node）从未覆盖的层面。
// ============================================================================
(async () => {
  'use strict';
  const nb = window.nodeBridge;
  const results = [];

  async function test(name, fn) {
    try {
      const detail = await fn();
      results.push({ name: name, ok: true, detail: detail || '' });
    } catch (e) {
      const msg = (e && (e.error || e.message)) || String(e);
      results.push({ name: name, ok: false, detail: msg });
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function tmpFile(tag) {
    return nb.path.join(nb.os.tmpdir(), 'bridge_e2e_' + tag + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
  }

  // --------------------------------------------------------------------------
  // 0. 桥已暴露且核心命名空间齐全
  // --------------------------------------------------------------------------
  await test('nodeBridge 已暴露且核心命名空间齐全', () => {
    assert(nb, 'window.nodeBridge 不存在');
    const need = ['fs', 'path', 'os', 'crypto', 'buffer', 'processInfo', 'database',
      'nativeRequire', 'requireNpm', 'loadModuleSource', 'listModules'];
    for (const k of need) assert(nb[k], 'nodeBridge.' + k + ' 缺失');
    return Object.keys(nb).length + ' 个命名空间';
  });

  // --------------------------------------------------------------------------
  // 1. fs + Buffer 往返（BufferProxy marshalling —— 此前反复出错的类）
  // --------------------------------------------------------------------------
  await test('fs 写入→读取：utf8 与 BufferProxy 双往返一致', () => {
    const file = tmpFile('fs') + '.bin';
    const payload = '你好, Bridge! 中文+符号 \u00e9\u0000\u0001 ' + Math.random();

    assert(nb.fs.writeFileSync(file, payload, 'utf8') === true, 'writeFileSync(utf8) 失败');
    assert(nb.fs.readFileSync(file, 'utf8') === payload, 'utf8 往返不一致');

    // 无编码读取 → BufferProxy
    const proxy = nb.fs.readFileSync(file);
    assert(proxy && proxy._isBufferProxy === true, '无编码读取应返回 BufferProxy，实际: ' + JSON.stringify(proxy).slice(0, 50));
    assert(nb.buffer.isBuffer(proxy) === true, 'buffer.isBuffer(BufferProxy) 应为 true');
    const expected = nb.buffer.from(payload, 'utf8');
    assert(nb.buffer.compare(proxy, expected) === 0, 'BufferProxy 字节内容与原文不一致');

    // BufferProxy 作为写入入参（unwrapBuffer 路径）
    const file2 = tmpFile('fs2') + '.bin';
    assert(nb.fs.writeFileSync(file2, expected) === true, 'writeFileSync(BufferProxy) 失败');
    assert(nb.fs.readFileSync(file2, 'utf8') === payload, 'BufferProxy 写入往返不一致');

    nb.fs.unlinkSync(file);
    nb.fs.unlinkSync(file2);
    return 'utf8 + BufferProxy 读写双往返一致';
  });

  // --------------------------------------------------------------------------
  // 2. crypto AES-256-GCM 往返（API Key 加密路径 —— 此前 "Buffer is not defined"）
  // --------------------------------------------------------------------------
  await test('crypto AES-256-GCM 加解密往返一致（API Key 路径）', () => {
    const keyHex = nb.crypto.pbkdf2Sync('machine|id|secret', 'ai-agent-salt', 10000, 32, 'sha256');
    assert(typeof keyHex === 'string' && keyHex.length === 64, 'PBKDF2 应返回 64 位 hex 密钥，实际长度 ' + (keyHex && keyHex.length));

    const ivHex = nb.crypto.randomBytes(12, 'hex');
    assert(typeof ivHex === 'string' && ivHex.length === 24, 'IV 应为 24 位 hex（12 字节）');

    const plaintext = 'sk-7aef04253a734269a8dc34cab2d2ec8f';
    const cipher = nb.crypto.createCipheriv('aes-256-gcm', keyHex, ivHex);
    assert(cipher && !cipher.error, 'createCipheriv 失败: ' + (cipher && cipher.error));
    const enc = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    const tag = cipher.getAuthTag();
    assert(typeof tag === 'string' && tag.length === 32, 'authTag 应为 32 位 hex（16 字节）');

    const decipher = nb.crypto.createDecipheriv('aes-256-gcm', keyHex, ivHex);
    assert(decipher && !decipher.error, 'createDecipheriv 失败: ' + (decipher && decipher.error));
    const st = decipher.setAuthTag(tag);
    assert(st === true || (st && !st.error), 'setAuthTag 失败: ' + JSON.stringify(st));
    const dec = decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
    assert(dec === plaintext, 'AES-GCM 往返不一致: "' + dec + '"');
    return 'PBKDF2→加密→解密 全链路一致';
  });

  // --------------------------------------------------------------------------
  // 3. http.Server 生命周期（原型方法 .listen/.on/.close 过桥 —— 此前 "listen is not a function"）
  // --------------------------------------------------------------------------
  await test('http.Server 过桥：createServer→listen→GET→close', async () => {
    const http = nb.nativeRequire('http');
    assert(http && typeof http.createServer === 'function', 'http.createServer 缺失');

    const port = 18100 + Math.floor(Math.random() * 800);
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, method: req.method, ok: true }));
    });
    assert(typeof server.listen === 'function', 'server.listen 不是函数（原型丢失）');
    assert(typeof server.on === 'function', 'server.on 不是函数');
    assert(typeof server.close === 'function', 'server.close 不是函数');

    await new Promise((resolve, reject) => {
      server.on('error', (e) => reject(new Error('server error: ' + (e && (e.message || e.code)))));
      server.listen(port, '127.0.0.1', () => resolve());
    });

    const resp = await fetch('http://127.0.0.1:' + port + '/ping');
    assert(resp.status === 200, 'HTTP 状态码 ' + resp.status);
    const body = await resp.json();
    assert(body.ok === true && body.url === '/ping' && body.method === 'GET', '响应体异常: ' + JSON.stringify(body));

    await new Promise((resolve) => server.close(() => resolve()));
    return 'listen/请求/close 全通，端口 ' + port;
  });

  // --------------------------------------------------------------------------
  // 4. 模块加载桥：listModules / loadModuleSource
  // --------------------------------------------------------------------------
  await test('模块加载桥：listModules / loadModuleSource', () => {
    const list = nb.listModules();
    assert(Array.isArray(list) && list.length > 50, 'listModules 应返回 >50 个模块，实际 ' + (list && list.length));
    const src = nb.loadModuleSource('trading-calendar.js');
    assert(typeof src === 'string' && src.length > 100, 'loadModuleSource 应返回源码字符串');
    assert(!(src && src.error), 'loadModuleSource 报错: ' + (src && src.error));
    return list.length + ' 个模块可列举，源码可加载（' + src.length + ' 字符）';
  });

  // --------------------------------------------------------------------------
  // 5. requireNpm 过桥：iconv-lite 编解码往返（BufferProxy 经 requireNpm）
  // --------------------------------------------------------------------------
  await test('requireNpm 过桥：iconv-lite GBK 编解码往返', () => {
    const iconv = nb.requireNpm('iconv-lite');
    assert(iconv && !iconv.error, 'requireNpm(iconv-lite) 失败: ' + JSON.stringify(iconv));
    assert(typeof iconv.encode === 'function' && typeof iconv.decode === 'function', 'iconv.encode/decode 缺失');
    const text = '中文 GBK 编码往返测试 abc 123';
    const buf = iconv.encode(text, 'gbk');
    assert(buf && buf._isBufferProxy === true, 'encode 应返回 BufferProxy');
    const back = iconv.decode(buf, 'gbk');
    assert(back === text, 'GBK 往返不一致: "' + back + '"');
    return 'encode→BufferProxy→decode 往返一致';
  });

  // --------------------------------------------------------------------------
  // 6. database 基础 CRUD 过桥
  // --------------------------------------------------------------------------
  await test('database 过桥：open/exec/run/query/get/close', () => {
    const dbPath = tmpFile('db') + '.db';
    const dbId = nb.database.open(dbPath);
    assert(typeof dbId === 'number', 'open 应返回数字 dbId，实际: ' + JSON.stringify(dbId));

    let r = nb.database.exec(dbId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    assert(r === true, 'CREATE TABLE 失败: ' + JSON.stringify(r));
    r = nb.database.run(dbId, 'INSERT INTO t (name) VALUES (?)', ['alice']);
    assert(r && r.changes === 1, 'INSERT 失败: ' + JSON.stringify(r));
    const rows = nb.database.query(dbId, 'SELECT * FROM t', []);
    assert(Array.isArray(rows) && rows.length === 1 && rows[0].name === 'alice', 'query 异常: ' + JSON.stringify(rows));
    const one = nb.database.get(dbId, 'SELECT name FROM t WHERE id=?', [1]);
    assert(one && one.name === 'alice', 'get 异常: ' + JSON.stringify(one));
    assert(nb.database.close(dbId) === true, 'close 失败');
    nb.fs.unlinkSync(dbPath);
    return 'CRUD 正常';
  });

  // --------------------------------------------------------------------------
  // 7. 事务原子性（一）：BEGIN IMMEDIATE → 插入 → ROLLBACK 全部回滚
  //    —— 这正是 core-v10.js DatabaseShim.transaction 修复所依赖的桥接机制
  // --------------------------------------------------------------------------
  await test('事务原子性：BEGIN→插入2条→ROLLBACK 全回滚 / COMMIT 保留', () => {
    const dbPath = tmpFile('txn') + '.db';
    const dbId = nb.database.open(dbPath);
    assert(typeof dbId === 'number', 'open 失败');
    nb.database.exec(dbId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // 事务内插入两条后 ROLLBACK
    let b = nb.database.exec(dbId, 'BEGIN IMMEDIATE');
    assert(b === true, 'BEGIN IMMEDIATE 失败: ' + JSON.stringify(b));
    nb.database.run(dbId, "INSERT INTO t (v) VALUES ('a')", []);
    nb.database.run(dbId, "INSERT INTO t (v) VALUES ('b')", []);
    let rb = nb.database.exec(dbId, 'ROLLBACK');
    assert(rb === true, 'ROLLBACK 失败: ' + JSON.stringify(rb));
    let rows = nb.database.query(dbId, 'SELECT * FROM t', []);
    assert(rows.length === 0, 'ROLLBACK 后应为 0 行，实际 ' + rows.length + ' 行（事务非原子！）');

    // 事务内插入后 COMMIT
    nb.database.exec(dbId, 'BEGIN IMMEDIATE');
    nb.database.run(dbId, "INSERT INTO t (v) VALUES ('c')", []);
    let cm = nb.database.exec(dbId, 'COMMIT');
    assert(cm === true, 'COMMIT 失败: ' + JSON.stringify(cm));
    rows = nb.database.query(dbId, 'SELECT * FROM t', []);
    assert(rows.length === 1 && rows[0].v === 'c', 'COMMIT 后应为 1 行，实际 ' + rows.length);

    nb.database.close(dbId);
    nb.fs.unlinkSync(dbPath);
    return 'ROLLBACK 全回滚 / COMMIT 保留';
  });

  // --------------------------------------------------------------------------
  // 8. 事务原子性（二）：preload 预置 transaction(ops[]) 中途失败整体回滚
  // --------------------------------------------------------------------------
  await test('事务原子性：transaction(ops[]) 中途失败整体回滚', () => {
    const dbPath = tmpFile('txn2') + '.db';
    const dbId = nb.database.open(dbPath);
    nb.database.exec(dbId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    // 第二条违反 NOT NULL 约束 → 整个事务应回滚
    const res = nb.database.transaction(dbId, [
      { sql: "INSERT INTO t (v) VALUES ('x')", params: [] },
      { sql: 'INSERT INTO t (v) VALUES (?)', params: [null] }
    ]);
    assert(res && res.error, '应返回 error（事务失败），实际: ' + JSON.stringify(res));
    const rows = nb.database.query(dbId, 'SELECT * FROM t', []);
    assert(rows.length === 0, '原子事务失败后应为 0 行，实际 ' + rows.length + '（非原子！）');

    nb.database.close(dbId);
    nb.fs.unlinkSync(dbPath);
    return '数组式事务中途失败整体回滚';
  });

  // --------------------------------------------------------------------------
  // 9. DatabaseShim.transaction（core-v10.js 真实 shim）：原子性 + 异常回滚 + 读-写-分支交错
  //    —— 直接求值 core-v10.js 的 _createDatabaseShim，验证 Phase 1 修复的真实事务
  // --------------------------------------------------------------------------
  await test('DatabaseShim.transaction（真实 shim）：提交 / 异常回滚 / 读-写-分支交错', () => {
    const shimSrc = window.__DB_SHIM_SRC__;
    assert(typeof shimSrc === 'string' && shimSrc.length > 100, 'shim 源码未注入（harness 提取失败）');

    // 在沙箱中求值 shim 工厂：注入 _bridge = window.nodeBridge
    const factory = new Function('_bridge', shimSrc + '\n; return _createDatabaseShim();');
    const DatabaseShim = factory(window.nodeBridge);
    assert(typeof DatabaseShim === 'function', 'DatabaseShim 应为构造函数');

    const dbPath = tmpFile('shim_txn') + '.db';
    const db = new DatabaseShim(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // 1) 正常提交：transaction 返回 fn 的返回值，数据持久化
    const insert = db.transaction(function(name) {
      db.prepare('INSERT INTO t (v) VALUES (?)').run(name);
      return 'inserted:' + name;
    });
    const r1 = insert('alice');
    assert(r1 === 'inserted:alice', 'transaction 返回值异常: ' + r1);
    let rows = db.prepare('SELECT * FROM t').all();
    assert(rows.length === 1 && rows[0].v === 'alice', 'COMMIT 后应为 1 行，实际 ' + rows.length);

    // 2) 异常回滚：fn 中途抛错 → ROLLBACK → 异常重新抛出，数据不留
    const badInsert = db.transaction(function() {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('bob');
      throw new Error('模拟中途异常');
    });
    let threw = false;
    try { badInsert(); } catch (e) { threw = true; assert(/模拟中途异常/.test(e.message), '异常消息丢失: ' + e.message); }
    assert(threw, '异常应被重新抛出');
    rows = db.prepare('SELECT * FROM t').all();
    assert(rows.length === 1, '异常后应回滚（仍 1 行），实际 ' + rows.length + ' 行（事务非原子！）');

    // 3) 读-写-分支交错（saveSession 模式：事务内先读计数再决定写入路径）
    const readWrite = db.transaction(function(name) {
      const cnt = db.prepare('SELECT COUNT(*) as c FROM t').get().c;
      if (cnt >= 1) {
        db.prepare('INSERT INTO t (v) VALUES (?)').run(name + '_branch');
      }
      return cnt;
    });
    const cnt = readWrite('charlie');
    assert(cnt === 1, '事务内读取应为 1，实际 ' + cnt);
    rows = db.prepare('SELECT * FROM t').all();
    assert(rows.length === 2, '读-写-分支后应为 2 行，实际 ' + rows.length);

    // 4) .deferred / .immediate / .exclusive 变体存在且可调用
    const deferred = db.transaction(function() { return 'd'; });
    assert(typeof deferred.deferred === 'function', '.deferred 缺失');
    assert(typeof deferred.immediate === 'function', '.immediate 缺失');
    assert(typeof deferred.exclusive === 'function', '.exclusive 缺失');
    assert(deferred.deferred() === 'd', '.deferred() 调用异常');

    db.close();
    nb.fs.unlinkSync(dbPath);
    return '正常提交 / 异常回滚 / 读-写-分支交错 / 变体 全通过';
  });

  // --------------------------------------------------------------------------
  // 10. safeStorage 桥（Phase 3）：接口存在性 + 加密/解密往返
  // --------------------------------------------------------------------------
  await test('safeStorage 桥：接口存在 + 加密解密往返', () => {
    const api = nb.electronAPI;
    assert(api, 'nodeBridge.electronAPI 不存在');
    const ss = api.safeStorage;
    assert(ss, 'electronAPI.safeStorage 不存在');
    assert(typeof ss.isEncryptionAvailable === 'function', 'safeStorage.isEncryptionAvailable 缺失');
    assert(typeof ss.encryptString === 'function', 'safeStorage.encryptString 缺失');
    assert(typeof ss.decryptString === 'function', 'safeStorage.decryptString 缺失');

    const available = ss.isEncryptionAvailable();
    if (!available) {
      return 'safeStorage 接口齐全；当前环境加密不可用（跳过往返）';
    }

    // 完整往返测试
    const secret = 'sk-test-' + Math.random().toString(36).slice(2) + '-中文密钥';
    const encrypted = ss.encryptString(secret);
    assert(typeof encrypted === 'string' && encrypted.length > 0, 'encryptString 应返回 base64 字符串，实际: ' + JSON.stringify(encrypted));
    assert(encrypted !== secret, '密文不应等于明文');

    const decrypted = ss.decryptString(encrypted);
    assert(decrypted === secret, '解密往返不一致: ' + JSON.stringify(decrypted) + ' !== ' + JSON.stringify(secret));

    // 错误入参处理
    const errResult = ss.encryptString(12345);
    assert(errResult && errResult.error, '非字符串入参应返回 {error}');

    return 'safeStorage 加密解密往返通过（DPAPI/Keychain）';
  });

  return results;
})();
