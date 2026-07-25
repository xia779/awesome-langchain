# AI 智能体（AI-Agent-Pro）功能完善与依赖补齐建议书

> 版本：v1.0　|　分析日期：2026-07-24　|　分析范围：`E:\my-ai-desktop` 全量代码
> 说明：本文档基于对项目源码的**完整通读**（核心架构、模块系统、主进程、依赖清单、测试覆盖），给出客观、可落地的改进建议。**未改动任何业务文件，仅作评估。**

---

## 0. 项目现状速览（评估基线）

| 维度 | 现状 |
|------|------|
| 项目类型 | Electron 桌面应用（本地多模型聚合 AI 助手） |
| 入口 | `main.js`（主进程）/ `index.html` + `app.js`（渲染进程）/ `core-v10.js`（模块注册中心） |
| 模块数量 | **100+ 个**（`modules/` 目录下） |
| 模型供应商 | 6 个：DeepSeek、通义千问、豆包、Ollama、自定义、硅基流动（Silicon） |
| 生产依赖 | 16 个 npm 包（express / better-sqlite3 / marked / dompurify / pptxgenjs / xlsx / sharp / tesseract.js / pdf-lib 等） |
| 测试 | 16 个测试文件，165 个用例（约 15 个核心模块有测试，其余 85+ 个模块无单测） |
| 运行安全模型 | `nodeIntegration: true` + `contextIsolation: false`（渲染进程可直接 `require` Node 模块） |
| 外部 CDN 依赖 | marked、highlight.js、mermaid、DOMPurify、Google Fonts（均走 jsDelivr/cloudflare CDN） |
| 已具备能力 | 多模型路由+降级、斜杠命令 30+、知识库（BM25+向量）、MCP 协议、Agent 编排、深度研究、定时任务、监控告警、语音、图像/视频生成、办公自动化、GitHub 集成、安全防护（注入检测+沙箱）、性能优化、可观测性等 |

**结论**：功能覆盖面已经相当广，属于"功能多但地基不稳"的状态。改进重点不是"加功能"，而是**加固地基（安全/离线化/测试）+ 补全几处明显短板**。

---

## 1. 优先级总表（核心）

| 编号 | 分类 | 缺失/风险 | 建议措施 | 优先级 | 投入估算 |
|------|------|-----------|----------|--------|----------|
| S1 | 依赖/CDN | marked/highlight.js/mermaid 走 CDN，断网失效 | 改为 npm 本地安装并本地引用 | 🔴 高 | 0.5 天 |
| S2 | 安全架构 | contextIsolation=false，XSS→RCE 风险 | 分阶段迁移到 preload 桥接 + 开启隔离 | 🔴 高 | 3-5 天 |
| S3 | 安全策略 | 无 CSP 头 | 注入 Content-Security-Policy | 🔴 高 | 0.5 天 |
| S4 | 测试 | cloud-api/search/command-handler 无单测 | 补充核心路径单元测试 | 🟡 中 | 2-3 天 |
| S5 | 依赖 | 无自动更新（electron-updater） | 集成 electron-updater | 🟡 中 | 1 天 |
| S6 | 可观测 | 无日志文件持久化 | 集成 electron-log | 🟡 中 | 0.5 天 |
| S7 | 功能 | 数学公式（LaTeX）不渲染 | 集成 KaTeX | 🟡 中 | 0.5 天 |
| S8 | 数据 | better-sqlite3 ABI 不匹配时静默降级 | 启动检测并明确提示数据库状态 | 🟡 中 | 0.5 天 |
| S9 | 知识库 | 嵌入模型仅依赖本地 Ollama | 增加云端嵌入 API 兜底 | 🟡 中 | 1 天 |
| S10 | 连接器 | 20+ 连接器多数无真实后端实现 | 标注实现状态，避免误导 | 🟡 中 | 1 天 |
| S11 | 加密 | API Key 加密密钥可能硬编码 | 改用 Electron safeStorage（OS 密钥链） | 🟡 中 | 1 天 |
| S12 | 搜索 | 后端 8080 未启动即降级，前端引擎受 CORS 限制 | 后端集成 SearXNG 或接入 Tavily/博查 Key | 🟡 中 | 1-2 天 |
| S13 | 版本 | electron ^42 需确认是否最新稳定版 | 定期 `npm outdated` 并升级 | 🟡 中 | 0.5 天 |
| S14 | 代码高亮 | highlight.js 走 CDN | 本地化（已在 deps 候选） | 🟡 中 | 0.5 天 |
| S15 | 依赖 | HTML 解析用正则，脆弱 | 安装 cheerio 解析网页内容 | 🟢 低 | 0.5 天 |
| S16 | 行情 | pytdx sidecar 需手动启动 | 启动时自动检测并拉起 | 🟢 低 | 0.5 天 |
| S17 | 定时 | 应用关闭后定时任务不执行 | node-cron + 系统任务计划 | 🟢 低 | 1 天 |
| S18 | 同步 | 仅本机 web-server，无真云端 | 部署云端同步后端（Supabase 等） | 🟢 低 | 2-3 天 |
| S19 | 可观测 | 调用追踪/Token 统计仅存内存 | 持久化到 SQLite 并展示趋势 | 🟢 低 | 1 天 |
| S20 | 语音 | 本地语音引擎门槛高 | 文档补充部署指引 + 连通性测试 UI | 🟢 低 | 0.5 天 |

---

## 2. 详细分析与实施方案

### 2.1 🔴 S1 · CDN 依赖本地化（最高性价比）

**现状**：`index.html` 第 935-941 行仍从 CDN 加载：
- `https://cdn.jsdelivr.net/npm/marked/marked.min.js`
- `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/...`
- `https://cdn.jsdelivr.net/npm/mermaid@10/...`
- `https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.6/purify.min.js`（DOMPurify 已在 `core-v10.js` 有本地加载兜底，但 highlight.js/marked/mermaid 没有）

**风险**：用户断网/弱网时，Markdown 渲染、代码高亮、Mermaid 图全部失效，AI 回复变成纯文本甚至原始 HTML。

**方案**：
1. `npm install marked@15 highlight.js@11 mermaid@10`（注意版本对齐现有功能）。
2. 在 `index.html` 移除 CDN `<script>`，改为 `app.js` 通过 `require` 引入（渲染进程 nodeIntegration 开启，可直接 require）。
3. 同步把 Google Fonts 改为本地字体或系统字体栈兜底。

**收益**：断网可用、加载更快、无 CDN 被墙风险。

---

### 2.2 🔴 S2 · 安全架构迁移（`contextIsolation` 迁移）

**现状**：`main.js` 第 170-176 行：
```js
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  sandbox: false,
  preload: path.join(__dirname, 'preload.js')
}
```
`preload.js` 已写好 `contextBridge` 安全 API 表面，但因 `contextIsolation:false` 实际未启用。104 个模块直接在渲染进程用 `require/process/module/__dirname`。

**风险**：任何 XSS 漏洞 → 攻击者可调用 `require('child_process').exec(...)` 实现远程代码执行。这是当前**最大的技术债**。

**分阶段方案**（不要一次全改，避免回归）：
- **阶段一**：将"文件操作"和"命令执行"类高风险模块（file/exec/python/git）改为经 `preload` 暴露的安全 API 调用，渲染进程不再直接 require fs/child_process。
- **阶段二**：主进程 IPC 层增加权限校验（参考 `permissions.js` 白名单）。
- **阶段三**：全部模块迁移完成后，开启 `contextIsolation: true`、`nodeIntegration: false`，仅通过 `contextBridge` 暴露必要 API。

**注意**：`core-v10.js` 的模块加载机制（拓扑排序 `loadModules`）依赖 `module` 全局，迁移时需重构注册方式。

---

### 2.3 🔴 S3 · 注入 CSP 安全头

**现状**：无 Content-Security-Policy。

**方案**：在 `main.js` 中：
```js
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://api.deepseek.com https://dashscope.aliyuncs.com https://api.siliconflow.cn; img-src 'self' data: https:;"]
  }});
});
```
需把允许的 API 域名（DeepSeek/Qwen/硅基流动等）加入 `connect-src` 白名单。

---

### 2.4 🟡 S4 · 核心模块补测试

**现状**：`tests/` 覆盖 agent-handoff、agent-loop、guardrails、market-、mcp-resources、memory、plugins、routing、streaming-tools、theme、trading-calendar 等 16 文件。但**用户每日触发的核心路径无单测**：
- `cloud-api.js`：模型路由 / 降级链 / `resolveCloudModel()`
- `search.js`：搜索引擎降级（无 Key → Bing → 后端）
- `command-handler.js`：30+ 斜杠命令解析
- `knowledge.js`：BM25 + 向量混合检索 / RRF 融合

**方案**：用 `node:test` 为上述模块补充用例（mock `Core`、`fetch`），目标每个模块 ≥ 20 用例。

---

### 2.5 🟡 S5 · 自动更新（electron-updater）

**现状**：`update.js` 仅 `fetch` GitHub `version.json` 并 `shell.openExternal` 打开下载页，**无静默安装**。

**方案**：
1. `npm install electron-updater`（注意签名：`electron-builder` 需配置 `publish` 与代码签名证书）。
2. 主进程集成 `autoUpdater`，渲染进程 `update.js` 改为订阅 `autoUpdater` 事件（checking / available / downloaded / error）。
3. 保留 GitHub Releases 作为更新源（`version.json` 的 `downloadUrl` 已指向）。

---

### 2.6 🟡 S6 · 日志持久化（electron-log）

**现状**：全靠 `console.log/warn/error`，无文件落盘。用户反馈问题时无法提供日志。

**方案**：`npm install electron-log`，主进程与渲染进程统一写日志到 `userData/logs/`，按天轮转，保留 7 天。错误捕获（`core-v10.js` 的 `uncaughtException`/`unhandledRejection`）改为同时写日志。

---

### 2.7 🟡 S7 · 数学公式渲染（KaTeX）

**现状**：Markdown 渲染管线无公式支持，用户输入 `$E=mc^2$` 或 `$$\int...$$` 不渲染。

**方案**：`npm install katex`，在 `app.js` 的 Markdown 渲染函数中识别 `$...$` / `$$...$$` 并调用 `katex.renderToString`。

---

### 2.8 🟡 S8 · 数据库降级可见性

**现状**：`database.js` 在 `better-sqlite3` 加载失败时静默降级到 JSON 文件（`sqliteAvailable=false`），性能下降但用户无感知。

**方案**：降级时在状态栏/设置页明确提示「⚠ 数据库降级模式（JSON 文件）」，并给出修复命令 `npm rebuild better-sqlite3`。

---

### 2.9 🟡 S9 · 知识库云端嵌入兜底

**现状**：`knowledge.js` 嵌入模型仅 `bge-m3`/`nomic-embed-text` via Ollama 本地。Ollama 未安装/未拉取模型时降级为纯 BM25 关键词匹配（丢失语义检索）。

**方案**：在 `Core.config.embedding` 增加 `silicon` 云端选项，调用硅基流动 `/v1/embeddings` 接口，本地 Ollama 不可用时自动切换。

---

### 2.10 🟡 S10 · 连接器实现状态对齐

**现状**：`connectors.js` 注册 20+ 连接器（微信/钉钉/飞书/Notion/Docker/SSH 等），大部分标记 `type: 'external'`，但对应后端实现（`modules/` 中）多数不完整。

**方案**：逐个核实实现情况，对未实现的连接器在 UI 明确标注「计划中 / 需配置」，避免用户误以为开箱即用。

---

### 2.11 🟡 S11 · API Key 加密密钥安全

**现状**：`crypto-utils.js` 做 `encryptValue/decryptValue`，但加密密钥若硬编码在代码中则形同虚设。

**方案**：改用 Electron `safeStorage` API（基于 OS 密钥链：Windows DPAPI / macOS Keychain），密钥不落地。

---

### 2.12 🟡 S12 · 搜索后端健壮性

**现状**：`search.js` 主走 `127.0.0.1:8080/api/search`，有健康探测+降级。后端未启动时降级到前端引擎（Bing/DuckDuckGo），但 Electron 渲染进程直连搜索引擎可能被 CORS/反爬限制。

**方案**：在 Express 后端内置 SearXNG 代理或优先使用已配置的 Tavily/博查 API Key；设置页增加搜索引擎连通性测试。

---

### 2.13 🟢 S13-S20 · 低优先级项

- **S13 升级 Electron**：`npm outdated electron` 并升级到最新稳定版（安全补丁）。
- **S14 highlight.js 本地化**：同 S1 合并处理。
- **S15 cheerio**：`npm install cheerio`，替换 `deep-research.js`/`search.js` 中的正则 HTML 解析。
- **S16 pytdx 自动拉起**：在 `main.js` 启动时检测并 spawn `pytdx_service.py`（类似 Ollama 检测逻辑）。
- **S17 node-cron**：持久化定时任务，应用关闭后仍可执行（需配合系统任务计划）。
- **S18 云端同步**：如需多设备，部署 Supabase/Firebase 免费层作为同步后端。
- **S19 可观测持久化**：`observability.js` 的调用追踪/Token 统计 flush 到 SQLite 并展示趋势图。
- **S20 语音指引**：文档补充 Fish Speech/VoxCPM2 部署步骤；设置页加语音引擎连通性测试按钮。

---

## 3. 如果只做三件事（MVP 路线）

> 投入最小、收益最大、风险最低的三件事：

1. **S1 CDN 本地化**（0.5 天）— 断网可用，消除最明显的"联网才能用"短板。
2. **S3 CSP 头**（0.5 天）— 用 30 行代码把 XSS→RCE 风险大幅降低。
3. **S4 核心模块补测试**（2-3 天）— 给 `cloud-api.js`/`search.js`/`command-handler.js` 加单测，后续改动有回归保护。

完成这三件后，再视资源推进 S2（安全迁移，最大但最必要）和 S5/S6（更新+日志，提升用户体验与可维护性）。

---

## 4. 附录：当前已实现能力清单（避免重复造轮子）

以下能力**已经具备**，完善时无需重复开发：

- ✅ 多模型路由 + 按 provider 默认模型降级（`cloud-api.js` 的 `resolveCloudModel`）
- ✅ 安全防护：Prompt 注入检测 + 输出泄露检测 + 工具执行沙箱（`guardrails.js` / `sandbox.js`）
- ✅ 知识库：JSON 持久化 + Ollama 向量 + BM25 混合检索 + RRF 融合（`knowledge.js`）
- ✅ MCP 协议：stdio 外部服务器 + 本地工具注册（`mcp.js`）
- ✅ Agent 编排：ReAct + 深度思考模式（`agent.js` / `api.js`）
- ✅ 深度研究：多步拆解 + 并行检索 + 带引用报告（`deep-research.js`）
- ✅ 定时任务 + 条件监控 + 晨报（`scheduler.js` / `watcher.js` / `proactive.js`）
- ✅ 语音输入/朗读（多引擎降级）、图像/视频生成（多引擎降级）
- ✅ 办公自动化（邮件/日历/文档）、GitHub 集成（gh CLI 封装）
- ✅ 性能优化（虚拟滚动/懒加载/崩溃恢复）、可观测性（调用追踪/成本估算）
- ✅ 模块系统：拓扑排序加载 + 依赖图（`core-v10.js` 的 `loadModules`）

---

*本文档为纯评估报告，未对源代码做任何修改。*
