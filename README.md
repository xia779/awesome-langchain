# AI Agent Pro

基于 Electron 的本地多模型 AI 智能体桌面助手，支持 83 个功能模块、多模型聚合、MCP 协议扩展、LangGraph 状态机和三层安全防护。

## 功能特性

### 核心能力

- **多模型聚合** — 本地 Ollama + DeepSeek、通义千问、豆包、硅基流动及任意 OpenAI 兼容服务，按任务类型自动路由
- **Agent 智能体循环** — 支持工具调用、多步推理、自动纠错重试，完整的 THINK→ACT→OBSERVE 循环
- **MCP 协议** — 完整的 Model Context Protocol 支持（Tools + Resources + Prompts），可连接外部 MCP 服务器扩展能力
- **流式输出** — 打字机效果 + 实时 Markdown 渲染，响应流畅无卡顿

### P0: 闪屏修复

- **DocumentFragment 批量渲染** — DOM 更新使用 DocumentFragment 一次性提交，消除中间态闪烁
- **saveConfig delta 过滤** — configChanged 事件携带 `(delta, fullConfig)`，theme/session 等模块按 key 选择性响应，避免非视觉配置变更触发不必要的 DOM 重建
- **会话切换防抖** — 切换会话时使用 `requestAnimationFrame` + CSS `will-change` 确保过渡平滑

### P1: 安全防护 + 追踪面板

- **三层 Guardrails 安全框架** (`modules/guardrails.js`)
  - **输入守卫** — 18 条规则检测中英文 Prompt Injection（"忽略之前的指令"、"you are now a" 等）
  - **输出守卫** — 8 条规则自动脱敏（API Key、私钥、数据库连接串、用户路径等）
  - **工具守卫** — 拦截危险命令（`rm -rf`、`shutdown`）和受保护目录（`C:\Windows`、`/etc`）的写操作
  - 可通过 `/gr` 命令切换启用/禁用
- **增强追踪面板** — 展示 Agent 每步耗时、成功/失败计数、可展开的步骤详情、一键复制追踪日志

### P2: 状态机 + Agent Handoff

- **LangGraph 状态机** (`modules/agent-workflow.js`)
  - 6 个状态：INIT → THINK → ACT → OBSERVE → COMPLETE/ERROR
  - 显式状态转换表，非法转换自动拒绝
  - ERROR 状态集成 `Core.recovery` 自动重试决策
  - 普通模式最多 12 步，深度思考模式最多 20 步
- **Agent Handoff 动态委派** (`modules/agent-handoff.js`)
  - 5 个专家代理：代码专家、研究专家、写作专家、数学专家、翻译专家
  - 支持上下文传递和历史记录追踪
  - 每个代理独立的成功率和平均耗时统计
  - 可通过 `/handoff` 命令查看状态

### P3: MCP 扩展 + 流式工具

- **MCP Resources & Prompts** (`modules/mcp-resources.js`)
  - Resources CRUD：注册、注销、列表、读取
  - Prompts 模板系统：注册、注销、列表、参数化获取
  - 3 个内置资源：`app://config`、`app://sessions`、`app://status`
  - 3 个内置提示词模板：`code-review`、`summarize`、`translate`
  - 可通过 `/mcp-res` 命令管理
- **流式工具执行** (`modules/streaming-tools.js`)
  - `executeStreaming` — 进度回调（init → executing → processing → complete）、超时控制、AbortController 取消
  - `executeBatchStreaming` — 批量执行 + 并发控制 + 单任务完成回调
  - `executePipeline` — 顺序管道链，支持 transform 函数和 continueOnError
  - 可通过 `/st` 命令查看状态

## 项目架构

```
├── app.js              # 应用入口 + Core 初始化
├── core-v10.js         # Kahn 拓扑排序模块加载器
├── main.js             # Electron 主进程
├── index.html          # 渲染进程 UI
├── modules/            # 83 个功能模块（自动发现 + 拓扑排序加载）
│   ├── api.js          # 多服务路由 + 消息发送
│   ├── agent-loop.js   # Agent 智能体循环 + 状态机集成
│   ├── agent-workflow.js    # LangGraph 状态机
│   ├── agent-handoff.js     # Agent 动态委派
│   ├── guardrails.js        # 三层安全防护
│   ├── mcp.js               # MCP 协议实现
│   ├── mcp-resources.js     # MCP Resources & Prompts
│   ├── streaming-tools.js   # 流式工具执行
│   ├── chat-handler.js      # 普通聊天处理
│   ├── session.js           # 会话管理（树形层级）
│   ├── theme.js             # 主题系统（防抖 + 选择性渲染）
│   └── ...                  # 其余 70+ 模块
├── tests/              # 12 个测试套件，189 个测试用例
└── .github/workflows/  # GitHub Actions CI
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动应用
npm start

# 开发模式
npm run dev

# 运行测试
npm test

# 打包（Windows）
npm run dist

# 打包（macOS）
npm run dist:mac

# 打包（Linux）
npm run dist:linux
```

## 技术栈

- **Electron** 42.4.1 + Node.js 22.x
- **模块系统** — 自定义 Kahn 拓扑排序加载器（`core-v10.js`），83 个模块自动发现 + 依赖解析
- **数据库** — better-sqlite3（本地 SQLite）
- **文档处理** — pdf-lib、mammoth、docx、xlsx、pptxgenjs
- **图像处理** — sharp、tesseract.js（OCR）
- **Markdown** — marked
- **测试** — Node.js 内置 `node:test` runner（零外部依赖）

## 测试

189 个测试覆盖核心模块和新功能，全部使用 Node.js 内置测试框架，无需安装额外依赖：

```bash
npm test
```

测试套件：guardrails (23) · agent-workflow (19) · agent-handoff (12) · mcp-resources (17) · streaming-tools (14) · agent-loop (18) · html-utils (25) · theme (20) · guardrails-integration (17) · memory (10) · plugins (8) · routing (6)

## CI/CD

GitHub Actions 自动运行测试，push 到 main 或提交 PR 时触发：

- **矩阵** — Node 20 + Node 22
- **无需 npm install** — 测试仅依赖 Node.js 内置模块，CI 运行速度 < 1 分钟

## 许可证

MIT
