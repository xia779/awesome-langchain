# BRIDGE_CONTRACT.md — contextBridge 桥契约

> 本文档定义 `preload.js` 通过 `contextBridge` 暴露给渲染进程的 `window.nodeBridge` 接口契约。
> 所有渲染进程代码（core-v10.js、modules/*.js）必须且只能通过此桥访问 Node 能力。
> 修改桥接口时，必须同步更新本文档 + `tests/e2e/bridge-tests-renderer.js`。

---

## 1. 安全上下文

- `contextIsolation: true` + `nodeIntegration: false` + `sandbox: false`
- 渲染进程主世界**没有** `require` / `process` / `Buffer` / `__dirname`
- 唯一 Node 入口：`window.nodeBridge`（由 `preload.js` 的 `contextBridge.exposeInMainWorld` 注入）
- **sandbox:false 决策（Phase 3 锁定）**：
  - preload.js 是"胖预加载"，含 14 个原生 require（fs/path/crypto/os/child_process/http/https/url + better-sqlite3 同步 C++ 插件 + ws + jsdom + dompurify + electron-log）
  - sandbox:true 会禁用所有原生 require，需将整个桥接层迁移为主进程 IPC
  - better-sqlite3 是**同步** API，IPC 化意味着全量异步重写 DB 层
  - 本应用仅加载 `file://` 本地内容，不加载远程 URL；`contextIsolation:true` 已提供核心 XSS 隔离
  - 结论：sandbox:true 收益极小、风险极大，**有意保持 false**
- `contextBridge` 序列化规则：
  - 可过桥：纯对象、数组、字符串、数字、布尔、`null`、`undefined`、`Function`（仅 preload→renderer 方向的代理）
  - **不可过桥**：类实例（丢失原型）、`Buffer`（变空对象）、`Promise`（需 preload 侧处理）、`Symbol`
  - 因此需要手写 marshalling（见第 4 节）

---

## 2. 命名空间总览

`window.nodeBridge` 包含以下命名空间（共 21 个）：

| 命名空间 | 用途 | 关键方法 |
|---------|------|---------|
| `fs` | 文件系统 | `readFileSync(path, enc?)`, `writeFileSync(path, data, enc?)`, `existsSync`, `unlinkSync`, `mkdirSync`, `readdirSync`, `statSync`, `renameSync`, `copyFileSync`, `appendFileSync`, `rmSync` |
| `path` | 路径处理 | `join`, `resolve`, `dirname`, `basename`, `extname`, `sep`, `delimiter` |
| `os` | 操作系统 | `tmpdir()`, `homedir()`, `platform()`, `arch()`, `hostname()`, `cpus()`, `totalmem()`, `freemem()`, `networkInterfaces()` |
| `crypto` | 加密 | `pbkdf2Sync(pw,salt,iters,keylen,digest)→hex`, `randomBytes(size,enc)→hex`, `createCipheriv(algo,keyHex,ivHex)`, `createDecipheriv(algo,keyHex,ivHex)`, `createHash(algo)`, `createHmac(algo,key)` |
| `buffer` | Buffer 代理 | `from(str,enc)→BufferProxy`, `isBuffer(obj)→bool`, `compare(a,b)→int`, `concat(list)→BufferProxy`, `alloc(size)→BufferProxy` |
| `processInfo` | 进程信息 | `env`(getter), `platform`, `arch`, `version`, `versions`, `pid`, `cwd()`, `nextTick(fn)`, `stdout`, `stderr` |
| `database` | better-sqlite3 | `open(path)→dbId`, `exec(dbId,sql)`, `run(dbId,sql,params)`, `query(dbId,sql,params)`, `get(dbId,sql,params)`, `pragma(dbId,sql)`, `transaction(dbId,ops[])`, `close(dbId)`, `backup(dbId,dest)` |
| `nativeRequire` | Node 内置模块 | `nativeRequire(name)` — 仅 18 个白名单内置模块 |
| `requireNpm` | npm 包代理 | `requireNpm(name)` — 白名单 npm 包（见第 5 节） |
| `loadModuleSource` | 模块源码 | `loadModuleSource(basename)→string` — 从 `modules/` 读取 |
| `listModules` | 模块列表 | `listModules()→string[]` — `modules/*.js` 文件名 |
| `http` | HTTP 客户端/服务端 | `createServer(handler)→ServerProxy`, `request(opts)`, `get(url)` |
| `https` | HTTPS 客户端 | `request(opts)`, `get(url)` |
| `net` | 网络 | `createConnection(opts)`, `connect(opts)` |
| `wsServer` | WebSocket 服务端 | `WebSocketServer(opts)→WsServerProxy` |
| `electron` | Electron API | `ipcRenderer`, `shell`, `dialog`, `clipboard`, `Notification`, `safeStorage` |
| `childProcess` | 子进程 | `spawn(cmd,args,opts)`, `exec(cmd,opts)`, `execFile(cmd,args,opts)` |
| `zlib` | 压缩 | `gzipSync(buf)`, `gunzipSync(buf)`, `deflateSync`, `inflateSync` |
| `stream` | 流 | `Readable`, `Writable`, `Transform`, `pipeline` |
| `events` | 事件 | `EventEmitter` |
| `timers` | 定时器 | `setInterval`, `clearInterval`, `setTimeout`, `clearTimeout` |

---

## 3. 错误约定

**所有桥接方法失败时返回 `{error: string}` 纯对象，不抛异常。**

```js
// 正确用法
const result = nb.fs.readFileSync('/some/path', 'utf8');
if (result && result.error) {
  console.error('读取失败:', result.error);
  return;
}
// result 是字符串

// 错误用法（桥接方法不会抛异常，try/catch 捕获不到桥接错误）
try {
  const result = nb.fs.readFileSync('/some/path', 'utf8');
} catch (e) {
  // 这里捕获不到文件不存在的错误！
}
```

**例外**：`DatabaseShim`（core-v10.js 内的 better-sqlite3 shim）的构造函数和 `transaction` 包装器**会抛异常**，因为 better-sqlite3 的 API 契约是抛异常而非返回错误对象。

### 结构化错误字段

| 字段 | 类型 | 说明 |
|-----|------|------|
| `error` | string | 错误消息（必有） |
| `code` | string? | Node 错误码（如 `ENOENT`, `EACCES`） |
| `errno` | number? | 系统错误号 |
| `syscall` | string? | 失败的系统调用 |
| `path` | string? | 相关路径 |

---

## 4. Marshalling 规则

### 4.1 BufferProxy

`Buffer` 无法跨 `contextBridge`，用纯对象代理：

```js
// 形状
{ _isBufferProxy: true, _b64: string /* base64 */ }

// 检测
nb.buffer.isBuffer(obj) === true  // 仅当 obj._isBufferProxy === true

// 创建
nb.buffer.from('hello', 'utf8')  // → BufferProxy
nb.fs.readFileSync(path)         // 无编码参数 → BufferProxy
nb.crypto.randomBytes(16)        // 无编码参数 → BufferProxy（部分方法）

// 消费
nb.fs.writeFileSync(path, bufferProxy)  // 自动 unwrap
nb.buffer.compare(a, b)                 // 接受 BufferProxy
```

### 4.2 对象句柄（objRegistry）

类实例（如 `docx.Document`, `pptxgenjs`）无法过桥，用 `{__objId: number}` 句柄 + preload 侧注册表：

```js
// preload 侧
const handle = objRegistry.register(instance);  // → {__objId: 42}
// 渲染进程拿到句柄，调用方法时 preload 侧查注册表找到真实实例
```

### 4.3 函数代理

`contextBridge` 允许 preload→renderer 方向的函数代理，但**不能 `new`**：

```js
// ❌ 不能 new 过桥的构造函数
const Doc = nb.requireNpm('docx');
new Doc.Document();  // TypeError: Doc.Document is not a constructor

// ✅ preload 侧包装为工厂函数
const docx = nb.requireNpm('docx');
docx.createDocument({...});  // 工厂方法，内部 new
```

### 4.4 http.Server 代理

`http.createServer` 返回的 Server 是类实例，过桥后原型丢失。preload 侧包装为闭包代理：

```js
const server = nb.nativeRequire('http').createServer(handler);
server.listen(port, host, cb);  // ✅ 代理函数
server.on('error', cb);         // ✅
server.close(cb);               // ✅
```

---

## 5. npm 包白名单

`requireNpm(name)` 仅支持以下包：

| 包名 | 包装方式 |
|-----|---------|
| `docx` | 工厂函数包装（不能 new） |
| `pdf-lib` | 工厂函数包装 |
| `pptxgenjs` | 工厂函数包装 |
| `pdf-parse` | 自动 unwrap BufferProxy 入参 |
| `iconv-lite` | `{encode(str,enc)→BufferProxy, decode(buf,enc)→str, encodingExists}` |
| `mammoth` | `{convertToHtml, extractRawText}` 自动 unwrap buffer |
| `xlsx` | 纯对象透传 |
| `marked` | 纯对象透传 |
| `highlight.js` | 纯对象透传 |
| `mermaid` | 纯对象透传 |
| `@pdf-lib/fontkit` | 纯对象透传 |
| `ws` | 纯对象透传 |
| `express` | 纯对象透传 |
| `cors` | 纯对象透传 |
| `dompurify` | 纯对象透传 |
| `jsdom` | 纯对象透传 |

---

## 6. database 桥详解

### 6.1 基础 API

```js
const dbId = nb.database.open('/path/to/db.sqlite');  // → number
nb.database.exec(dbId, 'CREATE TABLE ...');            // → true | {error}
nb.database.run(dbId, 'INSERT ...', [params]);         // → {changes, lastInsertRowid} | {error}
nb.database.query(dbId, 'SELECT ...', [params]);       // → Row[] | {error}
nb.database.get(dbId, 'SELECT ...', [params]);         // → Row | undefined | {error}
nb.database.pragma(dbId, 'journal_mode = WAL');        // → result | {error}
nb.database.close(dbId);                               // → true | {error}
```

### 6.2 事务

**两种事务接口：**

#### (a) preload 预置数组式事务

```js
nb.database.transaction(dbId, [
  { sql: 'INSERT INTO t VALUES (?)', params: [1] },
  { sql: 'INSERT INTO t VALUES (?)', params: [2] }
]);
// → {success: true} | {error: string}
// 内部用 better-sqlite3 真实 db.transaction 包裹，原子性保证
```

#### (b) core-v10.js DatabaseShim 的 fn 式事务

```js
const db = new DatabaseShim('/path/to/db.sqlite');
const txn = db.transaction(function(arg1, arg2) {
  // 事务内可交错执行读/写/分支
  const cnt = db.prepare('SELECT COUNT(*) as c FROM t').get().c;
  if (cnt > 0) {
    db.prepare('INSERT INTO t VALUES (?)').run(arg1);
  }
  return result;
});
txn('a', 'b');  // → result
```

**实现机制**（Phase 1 修复）：
- 桥接调用是**同步**的，fn 内的 `prepare().run/get/all` 即时执行
- 采用 `BEGIN IMMEDIATE → 同步执行 fn → COMMIT/ROLLBACK`
- fn 抛异常 → `ROLLBACK` + 异常重新抛出（原子性）
- `BEGIN` 失败（如嵌套事务）→ 退化为直接执行 fn（保持可用）
- 兼容 better-sqlite3：`txn.deferred()` / `txn.immediate()` / `txn.exclusive()`

**⚠ 旧实现的 bug（已修复）**：
旧 shim 的 `transaction(fn)` 直接 `return fn.apply(null, arguments)`，每条桥接 SQL 各自自动提交，中途异常留下半截写入，毫无原子性。

---

## 7. 测试覆盖

桥接层的 e2e 测试位于 `tests/e2e/bridge-tests-renderer.js`，在**真实 contextIsolation:true 渲染进程**中运行：

```bash
npm run test:e2e
```

当前覆盖（11 项）：
1. nodeBridge 暴露 + 命名空间齐全
2. fs + BufferProxy 双往返
3. crypto AES-256-GCM 往返（API Key 路径）
4. http.Server 生命周期（listen/请求/close）
5. 模块加载桥（listModules / loadModuleSource）
6. requireNpm iconv-lite GBK 往返
7. database 基础 CRUD
8. 事务原子性：BEGIN/ROLLBACK/COMMIT（桥接机制）
9. 事务原子性：preload 数组式事务中途失败回滚
10. **DatabaseShim.transaction（真实 shim）**：提交 / 异常回滚 / 读-写-分支交错 / 变体
11. **safeStorage 桥（Phase 3）**：接口存在性 + 加密解密往返（DPAPI/Keychain）

**修改桥接口后必须跑 `npm run test:e2e` 验证。**

---

## 8. 已知限制与陷阱

1. **`nativeRequire` 仅 18 个内置模块**：`fs`, `path`, `os`, `crypto`, `buffer`, `http`, `https`, `net`, `url`, `util`, `events`, `stream`, `zlib`, `child_process`, `assert`, `querystring`, `string_decoder`, `timers`。其他模块返回 `{error}`。

2. **`requireNpm` 不能 `new`**：所有 npm 包过桥后类构造函数变代理函数，必须用工厂方法。

3. **`console-message` 事件**：Electron 42 使用事件对象形式 `(event) => {event.level, event.message}`，旧的多参形式已废弃。

4. **`electron-log` 初始化**：主进程必须 `require('electron-log/main').initialize()`，否则 preload 的 log 桥报 "No handler registered"。

5. **`DOMPurify`**：渲染进程通过 `index.html` 的 `<script src="node_modules/dompurify/dist/purify.min.js">` 原生加载（浏览器 UMD），不走桥。

6. **`ws` 模块**：`requireNpm('ws')` 返回 ws shim，但 WebSocketServer 需要真实 net 绑定，渲染进程沙箱内无法运行服务端 ws。网关须在主进程运行。

7. **路径**：渲染进程没有 `__dirname` / `process.cwd()`。用 `nb.os.tmpdir()` + `nb.path.join()` 构造路径，或从主进程传入。

---

## 9. 敏感数据加密（Phase 3）

### 9.1 safeStorage 桥

`window.nodeBridge.electronAPI.safeStorage` 暴露 Electron safeStorage API：

```js
const ss = window.nodeBridge.electronAPI.safeStorage;
ss.isEncryptionAvailable()       // → boolean（OS 钥匙串是否可用）
ss.encryptString(plainText)      // → base64 string | {error}
ss.decryptString(b64)            // → plainText string | {error}
```

底层使用操作系统密钥管理：Windows DPAPI / macOS Keychain / Linux libsecret。

### 9.2 双格式密文

| 前缀 | 后端 | 密钥来源 | 强度 |
|------|------|---------|------|
| `enc:v1:` | AES-256-GCM | PBKDF2(机器身份 + 硬编码 salt) | 中（可离线推导） |
| `enc:v2:` | Electron safeStorage | OS 钥匙串（DPAPI/Keychain/libsecret） | 高（绑定用户登录凭据） |

**加密优先级**：`encryptValue()` 优先尝试 v2（safeStorage），不可用时降级 v1（AES-GCM），均不可用时返回明文。

**解密路由**：`decryptValue()` 根据前缀自动选择对应后端。

**兼容规则**：
- 旧 v1 密文继续正常解密（不强制迁移）
- 新保存的密钥自动使用 v2（若 safeStorage 可用）
- `isEncryptedValue(str)` 检测两种前缀，替代旧的 `startsWith(ENC_PREFIX)`

### 9.3 解密失败可见化

换机/重装后 v1 密钥无法解密（机器身份变化 → 派生密钥不同 → GCM authTag 校验失败）。
Phase 3 修复：`loadConfig` 检测到解密失败字段时弹出 Toast 通知用户重新输入，不再静默置空。
`saveConfig` 中 `_decryptFailedFields` 保护机制不变：未重新输入的字段不用空值覆盖数据库。

### 9.4 web-server.js 降级

`web-server.js` 是纯 Node Express 服务（无 Electron），`require('electron')` 返回字符串路径。
因此 web-server 始终使用 v1（AES-GCM）后端，无法使用 safeStorage。这是预期行为。

---

## 10. 变更历史

| 日期 | 变更 | Commit |
|-----|------|--------|
| 2026-07-24 | 初版：定义桥契约 + 错误约定 + marshalling 规则 | Phase 1 |
| 2026-07-24 | 修复 DatabaseShim.transaction 假事务 → 真实 BEGIN/COMMIT/ROLLBACK | Phase 1 |
| 2026-07-24 | Phase 3：safeStorage 桥 + enc:v2 双格式加密 + 解密失败可见化 + IPC 补齐 + sandbox 决策锁定 | Phase 3 |
