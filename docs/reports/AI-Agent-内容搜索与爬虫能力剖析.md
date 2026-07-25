# AI Agent Pro — 内容搜索与爬虫能力剖析及超越路线

> 文档版本：v1.0 ｜ 基于 2026-07-25 代码实测（非凭记忆）
> 范围：聚焦「内容搜索 / 网页爬虫 / 深度研究抓取」这一最短板，给出与主流 Agent（KIMI、通义、Coze、Manus、Qoderwork 等）的差距分析、量化评分、以及可落地的 P0/P1/P2 超越路线。
> 说明：本文件为新增分析文档，不修改任何业务代码。

---

## 0. 阅读对象与目的

- **目的**：明确本产品在「让 Agent 真正能上网、能读网页、能持续监控网页」这件事上，和头部产品差在哪、差多少、怎么补。
- **结论先行**：产品「能聊、能搜摘要、能跑浏览器、知识库检索还很不错」，但**数据获取层（爬网页、追链接、判时效、持续监控）是明显短板**。补齐它，就能在「全技术栈可用性」上反超一众只做聊天壳的产品。

---

## 1. 现状基线（代码实测）

### 1.1 服务拓扑：其实有两个后端

| 端口 | 进程 | 职责 | 是否实现搜索 |
|------|------|------|--------------|
| **3847** | `server/index.js`（Node） | WebSocket 通信、DB、知识库、记忆、路由、静态资源、健康检查 | ❌ 无 `/api/search` |
| **8080**（默认） | 独立搜索代理（渲染层 `search.js` 通过 `Core.getBackendBase()` 解析，运行态指向 8080 搜索代理） | 对接 DuckDuckGo / Bing / SearXNG / 博查 / Tavily | ✅ 有 `/api/search` 与 `/health` |

> 关键事实：`server/index.js` 的 `serveStatic` 只暴露 `/health`、`/api/models` 和静态文件（见 `server/index.js:167-176`），**根本没有搜索接口**。也就是说，免费搜索引擎（DuckDuckGo/Bing/SearXNG）的搜索能力**完全依赖一个独立拉起的 8080 代理进程**，该进程不随主后端（3847）启动。这正是此前「搜索 8080 连接拒绝」报错的来源。

### 1.2 搜索链路（`modules/search.js`）

- 主入口 `webSearch()`（line 50）：优先走后端代理 `/api/search`，失败/不健康则降级 `webSearchDirect()`。
- 健康探测 `_probeSearchBackend()`（line 11-25）：2 秒超时 `GET /health`，结果缓存进 `_backendSearchHealthy`；不健康超 3 分钟才重试（line 8）。
- 引擎路由 `getEffectiveEngine()`（line 41）：博查/Tavily 无 Key 时自动回退 Bing。
- **降级真相**（line 339-345）：DuckDuckGo / Bing / SearXNG 在 `webSearchDirect` 里**仍走后端代理**，并非真正客户端直连。代理没起，直接返回「联网搜索暂时不可用」的友好提示。只有博查 / Tavily（需 API Key）是真正的 `fetch` 直连（line 248-268）。

**结论**：免费搜索 = 强依赖 8080 代理；无 Key 时，代理挂了就完全不能搜。

### 1.3 深度研究的抓取链路（`modules/deep-research.js` + `modules/tools.js`）

研究编排器分 5 阶段：拆解 → 并行检索 → 深度阅读 → 综合撰写 → 产出（line 32-118）。其中「深度阅读」是爬虫能力的核心落点：

- `_deepRead()`（line 270-312）：取 Top N 个 http 来源，逐个调用 `_fetchPage()`。
- `_fetchPage()`（line 314-326）：本质是 `Core.toolsRegistry.executeTool('read_url', { url, max_length: 8000 })`。
- `read_url` 实现（`tools.js:787-867`）：
  - 裸 `http.get` / `https.get` + `extractTextFromHtml` 正则抽文本；
  - `MAX_DOWNLOAD = 500000`（500KB，line 836），默认 `max_length = 5000`；
  - **只处理静态 HTML，没有任何 JS 渲染**，SPA / 动态加载内容抓不到；
  - 返回带前缀 `🌐 网页内容: <url>` 的截断纯文本。
- 再经两层截断：`_deepRead` 只保留 `content.substring(0, 6000)`（line 287），`_synthesizeReport` 喂给 LLM 的仅 `r.content.substring(0, 3000)`（line 337）。

**结论**：一次深度研究，单个网页真正进入报告的文本 ≈ 3000 字，且**只抓首页、不追链接、不渲染 JS**。

### 1.4 浏览器引擎现状（`modules/browser-pro.js`）—— 闲置的宝藏

- 已完整实现 Playwright 封装：`navigate / screenshot / click / type / extract / waitFor / evaluate / getCookies / newTab / closeTab`（line 16-216）。
- 支持多标签、自定义 UA、headless Chromium、**能渲染 JS 的整页文本提取**（line 144 `document.body.innerText`）。
- **但只通过 `/browser` 命令暴露**（line 219-250：`open|shot|text|close`），**没有被 deep-research、search 或任何研究管线调用**。

**结论**：工业级 JS 渲染抓取能力已经写好了，却躺在命令里没人用——这是性价比最高的可补点。

### 1.5 知识库检索（`modules/knowledge.js`）—— 亮点项

- BM25 文本检索 + Ollama 本地嵌入 + SiliconFlow 云端嵌入兜底 + RRF 融合排序（line 1、263、327+）。
- 无嵌入模型时自动降级 BM25，功能不中断（line 132-138）。
- 服务端 `server/modules/knowledge.js`（20KB）同样具备混合检索。

**结论**：本地知识检索能力在同体量产品里算上乘，**爬虫抓回来的内容完全可以复用这套索引做二次检索**。

### 1.6 能力速览表

| 能力 | 现状 | 关键文件 |
|------|------|----------|
| 联网搜索（免费引擎） | 依赖独立 8080 代理，代理挂则废 | `modules/search.js` |
| 联网搜索（付费直连） | 博查/Tavily 直连，需 Key | `modules/search.js` |
| 单页抓取 | 裸 http + 正则，无 JS 渲染，≤500KB | `modules/tools.js:787` |
| 链接跟随 / 递归爬取 | ❌ 无 | — |
| sitemap / 全站采集 | ❌ 无 | — |
| 结果重排 rerank / 时效过滤 | ❌ 无 | — |
| 网页监控 / 增量更新 | ❌ 无 | — |
| JS 渲染抓取 | ✅ 已写好（Playwright），但未接入 | `modules/browser-pro.js` |
| 本地知识混合检索 | ✅ BM25+向量+RRF，较强 | `modules/knowledge.js` |

---

## 2. 与主流 Agent 的能力差距总表

评分说明：5=领先/完备，4=可用且较好，3=基础可用，2=有明显缺陷，1=几乎不可用/缺失。

| 维度 | 本产品 | KIMI/通义系 | Coze/扣子 | Manus 类 | 差距判定 |
|------|:----:|:----:|:----:|:----:|------|
| 联网搜索（免费） | 3（依赖代理） | 5 | 4 | 4 | 落后：依赖外部进程 |
| 网页深度抓取（JS 渲染） | 2（仅静态） | 4 | 4 | 5 | 明显落后 |
| 递归爬取 / 全站采集 | 1 | 3 | 3 | 5 | 缺失 |
| 时效过滤 / 权威性排序 | 1 | 4 | 3 | 4 | 缺失 |
| 网页监控 / 增量 | 1 | 3 | 2 | 4 | 缺失 |
| 本地知识检索 | 4.5（BM25+向量） | 3 | 3 | 3 | **领先** |
| 多模态内容提取 | 2 | 4 | 3 | 4 | 落后 |
| 反爬/稳定性 | 2 | 4 | 3 | 4 | 落后 |
| 工具链完整度 | 4 | 4 | 5 | 5 | 持平/略落后 |
| 桌面端一体化体验 | 4.5 | 2 | 2 | 2 | **领先** |

> 综合判断：**在「本地知识 + 桌面一体化」上是优势；在「网页数据获取深度」上是最大短板，尤其是 JS 渲染抓取、递归爬取、时效排序、网页监控四项几乎为空白。** 补齐这四项的 P0/P1，即可在「全技术栈可用性」维度反超多数只做聊天壳的竞品。

---

## 3. 重点剖析：内容搜索 / 爬虫的「七宗罪」

### 罪一：搜索强依赖一个「非自带」的独立代理
免费引擎请求全部发往 8080 代理（`modules/search.js:27-38, 68`），而主后端 3847 不提供搜索接口。代理未启动 → 免费搜索整体失效，只能靠博查/Tavily 直连（需 Key）。**用户开箱即用的搜索体验高度脆弱。**

### 罪二：页面抓取无 JS 渲染
`read_url` 用 `http.get` + 正则（`modules/tools.js:808-857`），对 React/Vue/SPA、懒加载、登录后内容**完全抓不到**。而 `browser-pro.js` 的 `extract()` 能拿到 `document.body.innerText`（line 144）——这个能力没接进研究链路，是最大的浪费。

### 罪三：单页容量与截断过激
下载上限 500KB（line 836），默认回传仅 5000 字符；deep-research 侧再砍到 6000、喂给 LLM 仅 3000（line 287、337）。长文、文档站、论坛帖被严重截断，报告质量天花板很低。

### 罪四：无链接跟随 / sitemap / 递归爬取
`_fetchPage` 只接受「给定 URL」（line 314），**不会从页面里提取链接继续抓**。深度研究因此只能覆盖搜索结果首页，做不到「顺着引用挖三度」。这是和 Manus 类产品的核心差距。

### 罪五：无重排（rerank）/ 时效过滤 / 去重 / 权威性评估
搜索结果是引擎原样返回，没有按时间、权威域名、相关性二次排序。**时效敏感问题（「最新政策/价格/版本」）极易引用过时内容。**

### 罪六：无网页监控 / 增量抓取
没有任何「盯住某些 URL、变化时通知我」的能力。**无法做竞品监控、舆情巡检、文档变更追踪**——而这些正是 Agent 取代人工的刚需场景。

### 罪七：Playwright 引擎闲置
`browser-pro.js` 写得很完整却只服务 `/browser` 命令，未被搜索/研究复用。**等于花了一份工业级浏览器引擎的钱，只用来截图。**

---

## 4. 超越路线（P0 / P1 / P2）

### P0 — 立竿见影（1~2 天，低风险）
1. **P0-1｜Playwright 接入 deep-research 抓取**：让 `_fetchPage()` 优先走 `Core.browserPro.extract()`（JS 渲染整页文本），失败时回退 `read_url`。改造成本极低，直接消除「罪二」。
2. **P0-2｜搜索降级增强**：8080 代理不可用时，自动切换博查/Tavily 直连（若配置了 Key），并给无 Key 用户清晰引导；对搜索结果做本地 TTL 缓存（如 10 分钟），减少重复请求与抖动。
3. **P0-3｜抓取失败可视化**：deep-research 进度里标注「X 页因 JS/超时跳过」，并支持对失败页一键用浏览器引擎重试。

### P1 — 体系成型（1~2 周，中等风险）
1. **链接跟随 / sitemap 解析 / 递归爬取**：在 `_deepRead` 之上加 `CrawlService`，带「最大深度、最大页数、域名白名单、去重（seenUrls）」预算控制，从种子 URL 自动扩展。
2. **抓取结果进知识库做混合索引**：复用现有 BM25+向量+RRF，把爬回内容存入本地知识库，研究时先查知识库再补抓——质量和速度双升。
3. **rerank + 时效过滤 + 权威性评分**：对搜索/爬取结果按发布时间、域名权重、与查询相关度打分排序，时效问题优先近期高权重源。

### P2 — 全面领先（月度，较高投入）
1. **网页监控 / 增量更新 / 变更告警**：持久化监控任务（可放现有 SQLite/任务队列），定时重抓、diff 变更、推送给用户。
2. **多模态内容提取**：PDF/表格/图片 OCR 抽取，纳入同一索引。
3. **反爬与稳定性**：代理池、UA 轮换、速率限制、重试退避，提升对严格站点的可达性。

---

## 5. 实施方案（P0 落地细节）

### 5.1 统一抓取层 `CrawlService`（建议新增 `modules/crawl.js`）
职责：对外暴露 `fetchPage(url, {render:true})`、`crawl(seedUrls, {maxDepth, maxPages})`、`searchAndCollect(query)`。内部按优先级选择抓取器：Playwright（渲染）→ read_url（静态）→ 失败兜底。

### 5.2 `_fetchPage` 改造（diff 级，低风险）
```js
// modules/deep-research.js  _fetchPage()
async function _fetchPage(url, opts) {
  // P0-1: 优先用浏览器引擎渲染抓取整页文本
  if (Core.browserPro && Core.browserPro.isReady && Core.browserPro.isReady()) {
    try {
      await Core.browserPro.navigate(url, { waitUntil: 'networkidle', timeout: 20000 });
      const r = await Core.browserPro.extract({ maxLength: 20000 });
      if (r && r.success && r.text && r.text.length > 100) {
        return r.text;
      }
    } catch (e) { /* 回退 */ }
  }
  // 回退到原有 read_url
  if (Core.toolsRegistry && Core.toolsRegistry.executeTool) {
    const result = await Core.toolsRegistry.executeTool('read_url', { url, max_length: 8000 });
    if (result && result.indexOf('❌') === -1) {
      return result.replace(/^\ud83c\udf10 网页内容: [^\n]+\n\n/, '');
    }
  }
  return null;
}
```
> 注意：`browserPro.navigate/extract` 当前是懒加载（`ensureBrowser`），首次调用会启动 Chromium，约 1~2 秒；研究流程里第 1 个页面触发一次即可，后续复用同一浏览器实例。

### 5.3 搜索降级增强（搜索链路）
- 在 `webSearch()` 的降级分支，若用户配置了博查/Tavily Key，则直接走 `webSearchDirect(query, 已配置付费引擎)`，避免无谓打 8080。
- 增加模块级 `Map` 做搜索结果缓存：`key = engine + ':' + query`，TTL 10 分钟；命中且后端不健康时直接返回缓存，提升弱网/代理故障时的可用性。

### 5.4 数据模型（复用现有 SQLite/任务队列）
- 监控任务表 `crawl_monitors(id, url, interval_min, last_hash, last_run, owner)`；
- 抓取缓存表 `crawl_cache(url, content_hash, fetched_at, ttl)`；
- 均挂在现有 SQLite 持久化层，无需引入新依赖。

---

## 6. 验收标准（可量化）

| 项目 | 验收口径 |
|------|----------|
| P0-1 | 对 3 个 SPA/动态站点（如 React 文档站），deep-research 能抓到正文（≥原方案 2 倍文本量） |
| P0-2 | 8080 代理关闭时，已配置付费 Key 用户仍可搜索；无 Key 用户给出明确引导，不再静默失败 |
| P0-3 | 抓取失败在进度中明确标注，支持一键浏览器重试且成功率高 |
| P1 递归 | 给定种子 URL，能自动扩展至第 2~3 层链接，页数受预算约束不失控 |
| P1 索引 | 爬回内容可经知识库 BM25+向量+RRF 检索召回 |
| P2 监控 | 配置监控 URL 后，内容变更能在下一个周期被检测并通知 |

---

## 7. 风险与权衡

- **Playwright 体积与启动成本**：Chromium 较大，首次启动慢。建议懒加载 + 复用单例，不在每次搜索都启动；对低端机可在设置里提供「仅静态抓取」开关。
- **递归爬取的合规与反爬**：需加 robots.txt 尊重、速率限制、域名白名单，避免被封或踩合规红线。
- **代理依赖的长期解法**：P0 阶段先把付费直连/缓存兜住，P1 再把 8080 搜索代理能力收敛进主后端 3847（统一端口、随主程序启动），从架构上消除「双后端割裂」。

---

## 附录：相关文件与行号速查

| 文件 | 关键行 | 内容 |
|------|--------|------|
| `modules/search.js` | 6-38, 50-113 | 后端代理搜索、健康探测、降级逻辑 |
| `modules/search.js` | 339-345 | 免费引擎仍依赖代理，非真直连 |
| `modules/deep-research.js` | 314-326 | `_fetchPage` 调 `read_url` |
| `modules/deep-research.js` | 287, 337 | 内容二次截断（6000 / 3000） |
| `modules/tools.js` | 787-867 | `read_url` 裸 http + 正则，500KB 上限 |
| `modules/browser-pro.js` | 16-216 | Playwright 完整封装（闲置） |
| `modules/browser-pro.js` | 219-250 | 仅 `/browser` 命令暴露 |
| `modules/knowledge.js` | 1, 263, 327+ | BM25 + 向量 + RRF（优势项） |
| `server/index.js` | 10-12, 167-176 | 主后端 3847，无 `/api/search` |
| `core-v10.js` | 1001-1037 | 后端地址动态解析（搜索请求落点） |

---

*本文档为分析与规划用途，所有改动建议在独立分支实施并跑通现有 165 项测试后再合并。*
