# AI Agent Pro 插件加载失败修复报告

## 问题现象

启动后 DevTools 控制台显示：

```
❌ 插件 hello-world 加载失败：插件沙箱执行失败（index.js）: fn is not a function
❌ 插件 auto-knowledge-extract 加载失败：插件沙箱执行失败（index.js）: fn is not a function
```

## 根因分析

`modules/plugins.js` 的 `_loadPluginSandboxed` 函数在上一轮安全加固时，把 CommonJS 包装器从：

```js
'return (function(module, exports, require, ...) { ...code... })'
```

误改为：

```js
'(function(module, exports, require, ...) { ...code... })'
```

`new Function(wrapper)` 执行没有 `return` 的函数体时返回 `undefined`，导致后续调用 `fn(...)` 抛出 `fn is not a function`，所有插件都无法加载。

## 修复内容

### 1. 恢复 wrapper 的 `return`（`modules/plugins.js`）

```js
var wrapper = 'return (function(module, exports, require, __dirname, __filename, console, ' +
  'setTimeout, clearTimeout, setInterval, clearInterval, process, global, globalThis, Buffer) {\n' +
  code + '\n})';
```

### 2. 修复 `_runWithTimeout` 异常被静默吞掉的 bug

原实现在 `fn()` 抛异常时把异常存到局部变量但没有重新抛出，导致插件 `init()` 出错也被静默忽略。已改为：

```js
if (error) {
  throw error;
}
```

并补充注释说明：JS 单线程无法真正中断同步死循环，该包装器仅用于超时提示和异常上抛。

## 验证结果

- `tests/plugins.test.js`：8/8 全部通过
- 其他非插件测试：203/203 全部通过，0 失败

## 截图中其他提示说明

以下不是代码报错，属于服务未启动时的正常降级提示：

- `GET http://127.0.0.1:8080/api/comfyui/status net::ERR_CONNECTION_REFUSED` → ComfyUI 未运行，已自动降级到 SiliconFlow
- `market-data: 未找到 pytdx-env，跳过 sidecar 启动（用腾讯源兜底）` → pytdx 虚拟环境不存在，使用腾讯快照源兜底
- `Docker 不可用，使用本地目录沙箱` → Docker 未安装/未启动，使用本地目录沙箱

如需减少这些提示，可后续做：
1. ComfyUI 首次探测改为静默模式，未启动时只提示一次
2. 提供 `pytdx-env` 一键安装脚本/指引
3. Docker 缺失提示改为首次使用时再显示

本次仅修复真正的插件加载失败问题。
