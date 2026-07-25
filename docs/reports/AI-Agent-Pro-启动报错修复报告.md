# AI Agent Pro 启动报错与图标显示修复报告

## 问题现象

用户反馈启动后 DevTools 出现大量报错，登录界面按钮/输入框显示英文图标名（`person` / `lock` / `person_add`）。

### 控制台报错

```
[core] 修复 module.paths 失败: require is not defined
[core] crypto-utils 加载失败: require is not defined
electron app 模块不可用；使用回退路径
Uncaught ReferenceError: process is not defined
[app.js] module.paths fix failed: require is not defined
Uncaught ReferenceError: Core is not defined
```

### 界面异常

- 用户名输入框前缀显示 `person请输入用户名（如 admin）`
- 登录按钮显示 `lock 登录`
- 注册按钮显示 `person_add 注册`

## 根因分析

1. **渲染进程 Node API 被切断**：上一轮修复架构限制时把 `contextIsolation` 设为 `true`，但 `core-v10.js`、`app.js` 以及 104 个核心模块直接依赖渲染进程的 `require`、`process`、`module`、`__dirname` 和全局 `Core`。开启隔离后这些全局 API 全部不可用，导致应用初始化失败。
2. **本地图标字体被 CSP 拦截**：`index.html` 的 CSP 中 `font-src` 只允许 `https://fonts.gstatic.com data:`，而 Material Symbols 图标字体是本地文件 `assets/fonts/material-symbols-outlined.woff2`（`file://` 协议），于是被拦截。图标字体无法加载时，基于 ligature 的图标会退化为显示文字名（`person`、`lock`、`person_add`），看起来就像“英文注释”。

## 修复内容

### 1. 回退 `contextIsolation` 恢复应用可用性（`main.js`）

```js
webPreferences: {
  nodeIntegration: true,         // 104 个模块依赖 Node 全局 require（后续需迁移到 preload 桥接）
  contextIsolation: false,       // #27: 兼容现有代码，否则 core-v10.js / app.js 中 require/process/Core 全不可用
  sandbox: false,
  allowRunningInsecureContent: false,
  webSecurity: true,
  preload: path.join(__dirname, 'preload.js')
}
```

同时补充注释说明：**当前应用 104 个模块深度依赖渲染进程 Node API，强行隔离会导致白屏，必须先将模块系统迁移到 preload 桥接后才能真正启用 `contextIsolation: true`**。

### 2. 修复 CSP 允许本地图标字体（`index.html` + `main.js`）

- `index.html` 的 `font-src` 增加 `'self' file:`：

```
font-src 'self' https://fonts.gstatic.com data: file:
```

- `main.js` 通过 `webRequest.onHeadersReceived` 下发的 CSP 也同步明确 `font-src 'self' https://fonts.gstatic.com data: file:`，避免响应头覆盖导致字体仍被拦截。

## 验证结果

- 非插件类测试全部通过：

```
# tests 203
# pass 203
# fail 0
```

- `tests/plugins.test.js` 仍会因 `plugins.js` 初始化时启动的 `setInterval` 保持事件循环而挂起（与本次修改无关，属于既有测试基础设施问题）。

## 后续建议

要真正解决 `contextIsolation` 安全问题，需要一次专门的架构重构：

1. 将 `core-v10.js` 改为在 `preload.js` 中加载，通过 `contextBridge.exposeInMainWorld` 暴露精简后的 `Core` API。
2. 104 个模块分类：纯业务逻辑模块改为 CommonJS 并在主进程/preload 加载；仅 UI 相关模块保留在渲染进程，通过 `window.electronAPI` 调用 Node 能力。
3. 渲染进程所有脚本移除直接使用 `require` / `process`，改为 `window.electronAPI`。
4. 完成迁移后再启用 `contextIsolation: true` + `sandbox: true`，并配合 `ipcRenderer` 白名单通道。

此重构涉及面广，建议作为独立大版本任务规划，而非在热修复中强行开启隔离。
