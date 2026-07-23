// modules/defaults.js — 🔒 #29 修复：统一常量定义，消除散落在各模块中的魔法数字
// 所有超时、重试、缓存上限等配置集中管理，方便调整和测试

module.exports = {
  name: 'defaults',
  dependencies: [],

  // ===== 网络超时（毫秒）=====
  TIMEOUT: {
    API_CALL: 120000,        // callAPI 非流式超时
    STREAM_READ: 300000,     // 流式读取总超时
    SEARCH: 15000,           // 搜索引擎 API 超时
    SEARCH_BACKEND: 25000,   // 后端搜索代理超时
    SEARCH_PROBE: 2000,      // 后端健康探测超时
    IMAGE_DESCRIBE: 60000,   // 图像描述超时
    SYNC_HTTP: 15000,        // 同步客户端 HTTP 超时
    TOOL_EXECUTE: 30000,     // 工具执行默认超时
    MCP_CONNECT: 10000,      // MCP 连接超时
  },

  // ===== 重试策略 =====
  RETRY: {
    MAX_TOOL_DEPTH: 3,       // tool_calls 最大递归深度
    MAX_CRASH_RELOADS: 3,    // Renderer 崩溃最大自动重载次数
    SYNC_RETRY_COUNT: 2,     // 同步失败重试次数
    SEARCH_FALLBACK: 2,      // 搜索降级最大尝试次数
  },

  // ===== 缓存与限制 =====
  LIMITS: {
    HISTORY_MESSAGES: 20,    // 降级时的固定历史消息条数
    KNOWLEDGE_CHUNKS: 5000,  // 知识库 chunks 缓存上限
    FILE_CONTENT: 30000,     // 文件内容截取上限（字符）
    FILE_API_CONTENT: 15000, // 发送给 API 的文件内容上限
    SEARCH_RESULTS: 5,       // 搜索引擎返回结果数
    CHECKPOINT_VERSIONS: 5,  // 每文件最大 checkpoint 版本数
    CHECKPOINT_SESSIONS: 10, // 保留的 checkpoint 会话数
    BACKGROUND_TASK_TTL: 5000, // 后台任务完成后清理延迟（ms）
  },

  // ===== 速率限制（次/分钟）=====
  RATE_LIMIT: {
    WINDOW_MS: 60000,
    IMAGE: 10,
    SEARCH: 20,
    TTS: 15,
    ASR: 10,
    COMFYUI: 5,
    DEFAULT: 60,
  },

  // ===== 服务器 =====
  SERVER: {
    DEFAULT_PORT: 8080,
    MAX_PORT_ATTEMPTS: 5,
    BIND_HOST: '127.0.0.1',
  },

  init: function(_Core) {
    _Core.DEFAULTS = this;
    console.log('✅ Defaults 常量模块已加载');
  }
};
