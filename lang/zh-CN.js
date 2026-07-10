// lang/zh-CN.js - 中文语言包
module.exports = {
  // 侧边栏
  'app.title': 'AI测试体',
  'sidebar.newChat': '+',
  'sidebar.settings': '⚙️ 设置',
  'sidebar.uploadDoc': '📤 上传文档',
  'sidebar.exportChat': '📥 导出对话',
  'sidebar.checkUpdate': '🔄 检查更新',
  'sidebar.refreshModels': '刷新模型列表',

  // 输入框
  'input.placeholder': '输入消息...',
  'input.send': '发送',
  'input.webSearch': '🌐 联网',
  'input.deepThink': '🧠 深度思考',
  'input.voice': '🎤',
  'input.image': '🖼️',

  // 设置面板
  'settings.title': '⚙️ 全局设置',
  'settings.appName': '应用名称',
  'settings.chatBg': '聊天背景（图片路径或颜色）',
  'settings.bubbleUser': '用户气泡颜色',
  'settings.bubbleAI': 'AI 气泡颜色',
  'settings.temperature': '聊天温度',
  'settings.autoRoute': '自动路由模型（根据联网状态自动切换）',
  'settings.systemPrompt': '系统提示词（角色设定）',
  'settings.ollamaModel': 'Ollama 模型名',
  'settings.deepseekKey': 'DeepSeek API Key',
  'settings.deepseekModel': 'DeepSeek 模型',
  'settings.doubaoKey': '豆包 API Key',
  'settings.doubaoModel': '豆包模型',
  'settings.customBase': '自定义 OpenAI 兼容 API',
  'settings.customKey': 'API Key',
  'settings.customModel': '模型名',
  'settings.save': '💾 保存设置',
  'settings.close': '关闭',
  'settings.language': '🌐 界面语言',

  // 右键菜单
  'context.copy': '📋 复制',
  'context.paste': '📥 粘贴',
  'context.rename': '✏️ 重命名会话',
  'context.pin': '📌 置顶/取消置顶',
  'context.delete': '🗑️ 删除会话',

  // 状态栏
  'status.ready': '✅ 已就绪',
  'status.searching': '🌐 正在搜索网络...',
  'status.routing': '🧠 正在路由任务...',
  'status.typing': '⏳ 正在请求 {{provider}} ...',
  'status.done': '✅ 已就绪 ({{provider}})',
  'status.uploadSuccess': '✅ 文档已上传: {{fileName}}',
  'status.uploadFail': '❌ 上传失败: {{error}}',
  'status.exportSuccess': '✅ 对话已导出: {{fileName}}',
  'status.exportFail': '❌ 导出失败: {{error}}',
  'status.analyzing': '🖼️ 正在分析图片...',
  'status.imageReady': '✅ 图片描述已生成，可发送',
  'status.checking': '🔄 正在检查更新...',
  'status.updateFound': '📢 发现新版本 {{version}}',
  'status.latest': '✅ 已是最新版本 ({{version}})',

  // 提示框
  'alert.noSession': '❌ 没有活动会话可导出',
  'alert.emptySession': '❌ 当前会话为空，无法导出',
  'alert.uploadOnly': '仅支持 .txt, .md, .pdf 文件',
  'alert.uploadSuccess': '文档 "{{fileName}}" 上传成功！（{{chunks}} 个片段）',
  'alert.exportSuccess': '✅ 导出成功！\n文件保存在:\n{{filePath}}',
  'alert.updateLatest': '✅ 当前已是最新版本（{{version}}）',
  'alert.updateFound': '📢 发现新版本 {{remoteVersion}}！\n\n当前版本：{{currentVersion}}\n更新内容：{{releaseNotes}}\n\n是否前往下载？',
  'alert.updateFail': '❌ 检查更新失败：\n{{error}}',
  'alert.pluginNotLoaded': '❌ {{module}} 模块未加载，请检查',
  'alert.imageAnalyzeFail': '❌ 图片分析失败：{{error}}',
  'alert.renameTitle': '✏️ 重命名会话',
  'alert.renamePlaceholder': '输入新名称...',
  'alert.confirmDelete': '确定要删除此会话吗？',
  'alert.pinUnavailable': '置顶功能未加载，请检查模块',
  'alert.deleteUnavailable': '删除功能未加载，请检查模块',

  // 代理名称
  'agent.code': '代码执行代理',
  'agent.text': '文本生成代理',
  'agent.stock': '金融数据代理',
  'agent.knowledge': '知识库代理',
  'agent.general': '通用知识代理',

  // 其他
  'chat.distributed': '📤 已分发至 **{{agentName}}**',
  'model.default': 'Qwen2.5 7B (默认)',
  'model.ollama': 'Ollama',
  'model.deepseek': 'DeepSeek',
  'model.doubao': '豆包',
};