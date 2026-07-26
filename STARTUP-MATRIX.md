# AI Agent Pro 启动矩阵

## 三后端架构说明

| 后端 | 入口 | 端口 | 用途 | 启动方式 |
|------|------|------|------|----------|
| Electron 内嵌 Express | main.js → api-routes.js | 8080 | 主后端：API 路由 + 静态服务 + 移动端 PWA | npm start 自动启动 |
| 独立 WS 服务器 | server/index.js | 3847 | 可选远程节点：无 Electron 环境下的 Agent 服务 | node server/index.js |
| 多设备 WS 网关 | modules/gateway.js | 18789 | 多设备接入：手机/平板/开发板远程控制 | Electron 内自动启动 |

## 典型启动场景

### 场景 1：普通桌面使用（默认）

```bash
npm start
```

启动 Electron + 内嵌 Express(8080) + Gateway(18789)。无需其他操作。

### 场景 2：无头服务器模式（远程节点）

```bash
node server/index.js
```

仅启动 WS 服务(3847)，适用于无 GUI 的 Linux 服务器。可与主节点互联。

### 场景 3：开发模式

```bash
npm run dev
```

启动 Electron + DevTools 自动打开 + 详细日志。

## 端口冲突处理

- 8080 被占：Express 自动递增尝试 8081-8090
- 3847 被占：server/index.js 报错退出（需手动释放）
- 18789 被占：gateway 自动递增尝试（最多 10 次）

## 安全约束

- 所有服务默认绑定 127.0.0.1（仅本机访问）
- Gateway 支持 token 认证（配置项 gateway.token）
- 跨域仅允许 localhost 来源（cors 配置）
