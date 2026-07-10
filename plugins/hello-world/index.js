/**
 * Hello World 示例插件
 * 演示如何使用 beforeSend 和 afterResponse 钩子
 */
class HelloWorldPlugin {
  constructor(api) {
    this.api = api;
    this.prefix = '【来自HelloWorld插件】';
  }

  init() {
    this.api.log('Hello World 插件已初始化！');
    this.api.registerHook('beforeSend', (message) => {
      this.api.log('beforeSend 钩子被调用，原始消息:', message.substring(0, 50));
      // 可以在消息前添加前缀，或修改消息内容
      // return this.prefix + message; // 如果要修改消息，取消注释这行
      return message; // 返回原消息（不修改）
    });
    this.api.registerHook('afterResponse', (aiMessage, context) => {
      this.api.log('afterResponse 钩子被调用，AI回复长度:', (aiMessage.content || '').length);
      this.api.log('会话ID:', context.sessionId, '模型:', context.provider);
    });
  }

  destroy() {
    this.api.log('Hello World 插件已卸载');
  }
}

module.exports = HelloWorldPlugin;
