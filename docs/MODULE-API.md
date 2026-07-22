# AI Agent Pro 模块 API 文档

> 83+ 模块通过 core-v10.js Kahn 拓扑加载器自动初始化。
> 每个模块导出 `{ name, dependencies, init(Core) }`，init 中挂载到 Core 对象。

## 核心模块

### Core.knowledge（知识库）
| 方法 | 说明 |
|------|------|
| `uploadDocument(pathOrObj)` | 上传文档（路径或 {content, fileName}），sha256 去重 |
| `search(query, topK)` | 向量+BM25 混合检索 |
| `searchWithCitations(query, topK, opts)` | 带引用的检索（RRF融合+Rerank+查询改写） |
| `rewriteQuery(query, context)` | LLM 查询改写（指代消解） |
| `rerankResults(query, results, topN)` | SiliconFlow rerank 重排 |
| `syncDirectory(dirPath)` | 增量同步目录到知识库 |
| `watchDirectory(dirPath, debounceMs)` | 监听目录变化自动同步 |
| `migrateEmbeddings()` | 嵌入模型迁移（切换模型后重嵌入） |
| `rebuildEmbeddings()` | 为无向量的文档补充嵌入 |
| `getEmbeddingModel()` | 获取当前生效的嵌入模型名 |

### Core.memory（记忆系统）
| 方法 | 说明 |
|------|------|
| `add(content, tags)` | 添加记忆 |
| `addWithSource(content, tags, source)` | 带来源添加（自动嵌入） |
| `addWithImportance(content, tags, level)` | 带重要性添加 |
| `semanticSearch(query, limit)` | 语义搜索（向量优先，TF-IDF回退） |
| `vectorRecallAsync(query, userId, limit)` | 异步向量召回（衰减公式） |
| `smartContext(query, maxItems)` | 智能上下文注入 |
| `backfillEmbeddings()` | 后台填充已有记忆向量 |
| `llmExtract(sessionId, messages)` | LLM 自动提取记忆 |
| `getEnhancedContext(query)` | 增强上下文（画像+关键+语义） |

### Core.fileCheckpoint（文件安全）
| 方法 | 说明 |
|------|------|
| `createCheckpoint(filePath, sessionId)` | 写入前快照 |
| `generateDiff(filePath, newContent)` | 生成 unified diff |
| `rollbackFile(filePath, sessionId)` | 回滚单个文件 |
| `rollbackAll(sessionId)` | 回滚整个会话所有文件 |
| `listCheckpoints(sessionId)` | 列出会话 checkpoint |

### Core.taskQueue（后台任务）
| 方法 | 说明 |
|------|------|
| `create({prompt, title, sessionId})` | 创建后台任务 |
| `get(taskId)` | 查询任务状态 |
| `list(filter)` | 列出任务（running/queued/done） |
| `getResult(taskId)` | 获取任务结果 |
| `cancel(taskId)` | 取消排队中的任务 |
| `setConcurrency(n)` | 设置并发数（1-5） |

### Core.mcp（MCP 协议）
| 方法 | 说明 |
|------|------|
| `enabled()` | 是否启用 |
| `enable() / disable()` | 运行时开关 |
| `listTools()` | 列出所有注册工具 |
| `callTool(name, args)` | 调用工具 |
| `getAllTools()` | 合并本地+外部工具 |
| `connectServer(id) / disconnectServer(id)` | 外部服务器管理 |
| `addServer(config) / removeServer(id)` | 服务器配置管理 |

### Core.plugins（插件系统）
| 方法 | 说明 |
|------|------|
| `installPlugin(path)` | 安装（目录或 ZIP） |
| `uninstallPlugin(id)` | 卸载 |
| `checkUpdates()` | 检查所有插件版本更新 |
| `updatePlugin(id, downloadUrl)` | 下载并更新插件 |
| `installFromMarketplace(id)` | 从市场安装技能 |
| `hotUpdatePlugin(id)` | 热重载 |

### Core.session（会话管理）
| 方法 | 说明 |
|------|------|
| `newChat(roleType, parentId)` | 新建会话 |
| `switchSession(id)` | 切换会话 |
| `compress(sessionId)` | 长对话摘要压缩（>60条触发） |
| `renameSession(id, title)` | 重命名 |
| `saveSession(id)` | 保存 |

## 配置项（Core.config）

| 键 | 默认值 | 说明 |
|----|--------|------|
| `embeddingModel` | `'bge-m3'` | 嵌入模型（回退 nomic-embed-text） |
| `rerankEnabled` | `true` | SiliconFlow rerank 开关 |
| `queryRewrite` | `true` | 查询改写开关 |
| `mcpEnabled` | `true` | MCP 模块开关 |
| `siliconFlowKey` | `''` | 硅基流动 API Key |
| `knowledgeWatchDir` | `null` | 自动监听的知识库目录 |
| `autoMemoryExtract` | `true` | 自动记忆提取 |

## 事件（Core.on）

| 事件 | 触发时机 | 数据 |
|------|----------|------|
| `typingEnd` | AI 回复完成 | `{ sessionId, messages }` |
| `taskComplete` | 后台任务完成 | `{ taskId, title, status }` |
