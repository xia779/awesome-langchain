# AI Agent Pro 搜索与向量报错修复报告

## 报错分析

截图中主要出现三类报错：

1. **获取向量失败：signal timed out**  
   来源：`modules/knowledge.js:225`

2. **POST http://127.0.0.1:8080/api/search net::ERR_CONNECTION_REFUSED**  
   来源：`modules/search.js` → `core-v10.js:662`

3. **Bing 后端搜索失败 / DuckDuckGo 后端搜索失败**  
   来源：`modules/search.js` 调用后端 `/api/search` 失败后的降级链

---

## 根因

### 1. 本地搜索代理端口解析缺陷

`Core.getBackendBase()` 第一次解析端口时，如果主进程里的 `actualPort` 还没初始化（服务器尚未启动或 8080 被占用后递增到了其他端口），会把默认值 `8080` 永久缓存。后续所有搜索请求都会打到 `127.0.0.1:8080`，即使服务实际在别的端口或尚未启动，表现为 `ERR_CONNECTION_REFUSED`。

### 2. 后端搜索失败后反复重试同一失败端口

`webSearch()` 失败后会降级到 `webSearchDirect()`，而 Bing/DuckDuckGo/SearXNG 的 `webSearchDirect()` 仍然走同一个本地后端代理，导致同样的连接拒绝反复出现，日志刷屏。

### 3. Ollama 嵌入请求超时过长

`getEmbedding()` 使用 30 秒超时。当 Ollama 未启动或模型未加载时，会卡满 30 秒才报 `signal timed out`，并且失败后只把 `embeddingAvailable` 置为 false，提示信息不够明确。

---

## 修复内容

### 修改文件：`core-v10.js`

- `Core.getBackendBase()` 不再把未就绪状态缓存为 `8080`
- 主进程返回 `0` 表示服务器尚未启动，渲染进程会识别为"未就绪"并允许重试
- 对默认端口 `8080` 增加 2 秒内的重新解析，避免被过期缓存误导
- 新增 `Core.probeBackendPort()` 用于诊断

### 修改文件：`main.js`

- `ipcMain.on('get-server-port')` 在 `actualPort` 未初始化时返回 `0`，而不是默认 `8080`

### 修改文件：`modules/search.js`

- `_searchBackendBase()` 每次请求前先调用 `Core.refreshBackendPort()` 获取最新端口
- 新增 `_probeSearchBackend()` 健康检查
- `webSearchDirect()` 在后端不可用时直接给出友好提示，不再反复请求失败端口
- `webSearch()` catch 中识别 `ECONNREFUSED` / `Failed to fetch`，立即标记后端不可用

### 修改文件：`modules/knowledge.js`

- `getEmbedding()` 超时从 30 秒缩短到 10 秒
- 失败后只打印一次聚合提示，避免刷屏
- `checkEmbeddingModel()` 增加 `/api/embeddings` 端点真实探测，避免 `tags` 通但 `embed` 卡死

---

## 验证

- `node -c` 语法检查：4 个修改文件全部通过 ✅
- 非插件测试：**203/203 通过，0 失败** ✅
- 插件测试：**8/8 通过** ✅（退出码 1 是测试文件自身 `setInterval` 保持事件循环的既有问题，与本次修改无关）

---

## 仍可能出现的情况（非代码 BUG）

如果启动后仍然看到"本地搜索代理未启动"提示，通常是因为：

1. **8080 端口被其他程序占用**  
   应用会自动递增到 8081/8082 等，本次修复后前端会正确跟随实际端口。

2. **Ollama 未启动或未安装 bge-m3 模型**  
   这是正常降级，知识库会自动使用 BM25 文本检索，功能仍然可用。如需语义检索，在命令行执行：
   ```bash
   ollama pull bge-m3
   ```

3. **启动瞬间的瞬时失败**  
   窗口加载和服务器启动是并行的，极少数情况下前端会在服务器就绪前发起请求。刷新页面或重新提问即可恢复。
