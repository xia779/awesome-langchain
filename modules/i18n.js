// modules/i18n.js - 多语言国际化模块
let Core = null;

// 语言字典
const TRANSLATIONS = {
  zh: {
    // 通用
    appName: 'AI智能体',
    loading: '加载中...',
    send: '发送',
    stop: '停止',
    cancel: '取消',
    confirm: '确认',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    copy: '复制',
    search: '搜索',
    settings: '设置',
    backup: '备份',
    export: '导出',
    import: '导入',
    
    // 侧边栏
    newChat: '新对话',
    favorites: '收藏夹',
    plugins: '插件',
    history: '历史记录',
    knowledge: '知识库',
    
    // 消息
    you: '你',
    ai: 'AI',
    typing: '正在输入...',
    thinking: '正在思考...',
    messagePlaceholder: '输入消息...（Shift+Enter换行）',
    
    // 设置
    theme: '主题',
    themeDark: '深色',
    themeLight: '浅色',
    language: '语言',
    temperature: '温度',
    streamResponse: '流式响应',
    webSearch: '联网搜索',
    shortcuts: '快捷键',
    
    // API 设置
    apiSettings: 'API 设置',
    deepseekKey: 'DeepSeek API Key',
    qwenKey: '通义千问 API Key',
    doubaoKey: '豆包 API Key',
    customAPI: '自定义 API',
    
    // 通知
    saveSuccess: '✅ 保存成功',
    saveFailed: '❌ 保存失败',
    copySuccess: '✅ 已复制到剪贴板',
    deleteConfirm: '确定要删除吗？此操作不可撤销。',
    
    // 错误
    errorNetwork: '网络错误，请检查连接',
    errorAPI: 'API 请求失败，请检查 API Key',
    errorTimeout: '请求超时，请重试',
    errorUnknown: '发生未知错误',
    
    // 快捷键提示
    shortcutSend: '发送消息',
    shortcutNewChat: '新建对话',
    shortcutSearch: '搜索对话',
    shortcutSettings: '打开设置',
    shortcutFullscreen: '全屏切换',
    shortcutTheme: '切换主题',
    
    // 状态
    connected: '已连接',
    disconnected: '已断开',
    syncing: '同步中...',
    updated: '已更新',
  },
  en: {
    // General
    appName: 'AI Agent',
    loading: 'Loading...',
    send: 'Send',
    stop: 'Stop',
    cancel: 'Cancel',
    confirm: 'Confirm',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    copy: 'Copy',
    search: 'Search',
    settings: 'Settings',
    backup: 'Backup',
    export: 'Export',
    import: 'Import',
    
    // Sidebar
    newChat: 'New Chat',
    favorites: 'Favorites',
    plugins: 'Plugins',
    history: 'History',
    knowledge: 'Knowledge',
    
    // Messages
    you: 'You',
    ai: 'AI',
    typing: 'Typing...',
    thinking: 'Thinking...',
    messagePlaceholder: 'Type a message... (Shift+Enter for new line)',
    
    // Settings
    theme: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    language: 'Language',
    temperature: 'Temperature',
    streamResponse: 'Stream Response',
    webSearch: 'Web Search',
    shortcuts: 'Shortcuts',
    
    // API Settings
    apiSettings: 'API Settings',
    deepseekKey: 'DeepSeek API Key',
    qwenKey: 'Qwen API Key',
    doubaoKey: 'Doubao API Key',
    customAPI: 'Custom API',
    
    // Notifications
    saveSuccess: '✅ Saved successfully',
    saveFailed: '❌ Save failed',
    copySuccess: '✅ Copied to clipboard',
    deleteConfirm: 'Are you sure? This action cannot be undone.',
    
    // Errors
    errorNetwork: 'Network error, please check your connection',
    errorAPI: 'API request failed, please check your API Key',
    errorTimeout: 'Request timeout, please retry',
    errorUnknown: 'An unknown error occurred',
    
    // Shortcuts
    shortcutSend: 'Send message',
    shortcutNewChat: 'New chat',
    shortcutSearch: 'Search chats',
    shortcutSettings: 'Open settings',
    shortcutFullscreen: 'Toggle fullscreen',
    shortcutTheme: 'Toggle theme',
    
    // Status
    connected: 'Connected',
    disconnected: 'Disconnected',
    syncing: 'Syncing...',
    updated: 'Updated',
  }
};

// 当前语言
let currentLang = 'zh';

function init(_Core) {
  Core = _Core;
  
  // 从配置加载语言设置
  currentLang = Core.config.language || 'zh';
  
  // 暴露键盘导航 API 供其他模块使用
  Core.KEYBOARD_NAV = KEYBOARD_NAV;

  Core.i18n = {
    t,           // 翻译
    setLanguage, // 切换语言
    getLanguage, // 获取当前语言
    getAvailableLanguages, // 获取可用语言列表
    refreshUI,   // 刷新 UI 文本
  };
  
  // 启动时刷新 UI
  setTimeout(() => refreshUI(), 1000);

  // Tab 键无障碍导航（通过统一 keyboard 分发器）
  if (!_tabNavRegistered && Core.keyboard) {
    _tabNavRegistered = true;
    Core.keyboard.register('i18n-tab-nav', 60, function(e) {
      KEYBOARD_NAV.handleTabKey(e);
    });
  }

}

// 翻译函数
function t(key, params = {}) {
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.zh;
  let text = dict[key] || TRANSLATIONS.zh[key] || key;
  
  // 替换参数 {name}
  Object.keys(params).forEach(k => {
    text = text.replace(new RegExp(`{${k}}`, 'g'), params[k]);
  });
  
  return text;
}

// 切换语言
function setLanguage(lang) {
  if (!TRANSLATIONS[lang]) {
    console.warn('⚠️ 不支持的语言:', lang);
    return false;
  }
  
  currentLang = lang;
  Core.saveConfig({ language: lang });
  refreshUI();
  
  Core.emit('languageChanged', lang);
  return true;
}

function getLanguage() {
  return currentLang;
}

function getAvailableLanguages() {
  return [
    { code: 'zh', name: '简体中文', flag: '🇨🇳' },
    { code: 'en', name: 'English', flag: '🇺🇸' },
  ];
}

// 刷新 UI 文本
function refreshUI() {
  // 更新 data-i18n 属性的元素
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const text = t(key);
    if (el.placeholder !== undefined && el.tagName === 'INPUT') {
      el.placeholder = text;
    } else if (el.title !== undefined && el.dataset.i18nTitle) {
      el.title = text;
    } else {
      el.textContent = text;
    }
  });
  
  // 更新 HTML lang 属性
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : currentLang;
  document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';

}

// ================================================================
//  Phase 5-5: 国际化增强 + 无障碍支持
// ================================================================

// ----- 额外语言翻译 -----
TRANSLATIONS.ja = {
  appName: 'AIエージェント', loading: '読み込み中...', send: '送信', stop: '停止',
  cancel: 'キャンセル', confirm: '確認', save: '保存', delete: '削除',
  edit: '編集', copy: 'コピー', search: '検索', settings: '設定',
  backup: 'バックアップ', export: 'エクスポート', import: 'インポート',
  newChat: '新しいチャット', favorites: 'お気に入り', plugins: 'プラグイン',
  history: '履歴', knowledge: 'ナレッジベース',
  you: 'あなた', ai: 'AI', typing: '入力中...', thinking: '思考中...',
  messagePlaceholder: 'メッセージを入力...（Shift+Enterで改行）',
  theme: 'テーマ', themeDark: 'ダーク', themeLight: 'ライト', language: '言語',
  temperature: '温度', streamResponse: 'ストリーム応答', webSearch: 'ウェブ検索',
  saveSuccess: '✅ 保存しました', saveFailed: '❌ 保存に失敗しました',
  copySuccess: '✅ コピーしました', deleteConfirm: '削除しますか？この操作は取り消せません。',
  errorNetwork: 'ネットワークエラー、接続を確認してください',
  errorAPI: 'APIリクエストに失敗しました、API Keyを確認してください',
  errorTimeout: 'リクエストタイムアウト、再試行してください',
  connected: '接続済み', disconnected: '切断済み',
};

TRANSLATIONS.ko = {
  appName: 'AI 에이전트', loading: '로딩 중...', send: '전송', stop: '중지',
  cancel: '취소', confirm: '확인', save: '저장', delete: '삭제',
  edit: '편집', copy: '복사', search: '검색', settings: '설정',
  backup: '백업', export: '내보내기', import: '가져오기',
  newChat: '새 대화', favorites: '즐겨찾기', plugins: '플러그인',
  history: '기록', knowledge: '지식베이스',
  you: '당신', ai: 'AI', typing: '입력 중...', thinking: '생각 중...',
  messagePlaceholder: '메시지를 입력하세요... (Shift+Enter로 줄바꿈)',
  theme: '테마', themeDark: '다크', themeLight: '라이트', language: '언어',
  temperature: '온도', streamResponse: '스트림 응답', webSearch: '웹 검색',
  saveSuccess: '✅ 저장 완료', saveFailed: '❌ 저장 실패',
  copySuccess: '✅ 복사 완료', deleteConfirm: '삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.',
  errorNetwork: '네트워크 오류, 연결을 확인하세요',
  errorAPI: 'API 요청 실패, API Key를 확인하세요',
  errorTimeout: '요청 시간 초과, 다시 시도하세요',
  connected: '연결됨', disconnected: '연결 끊김',
};

// ----- ARIA 无障碍支持 -----
function setupAccessibility() {
  // 创建 ARIA live region（供屏幕阅读器读取动态内容）
  if (document.getElementById('a11y-live-region')) return;
  var liveRegion = document.createElement('div');
  liveRegion.id = 'a11y-live-region';
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
  document.body.appendChild(liveRegion);

  // 跳转链接（Skip Navigation）
  if (!document.getElementById('a11y-skip-link')) {
    var skipLink = document.createElement('a');
    skipLink.id = 'a11y-skip-link';
    skipLink.href = '#msgInput';
    skipLink.textContent = t('skipToInput') || '跳转到输入框';
    skipLink.style.cssText = 'position:absolute;top:-40px;left:0;background:var(--accent,#3b82f6);color:#fff;padding:8px 16px;z-index:10000;transition:top .2s;border-radius:0 0 8px 0;font-size:14px;text-decoration:none';
    skipLink.addEventListener('focus', function() { this.style.top = '0'; });
    skipLink.addEventListener('blur', function() { this.style.top = '-40px'; });
    document.body.insertBefore(skipLink, document.body.firstChild);
  }

  // 为关键元素添加 ARIA 属性
  setTimeout(function() {
    var sendBtn = Core.dom.sendBtn;
    if (sendBtn && !sendBtn.getAttribute('aria-label')) {
      sendBtn.setAttribute('aria-label', t('send'));
      sendBtn.setAttribute('role', 'button');
    }
    var input = Core.dom.input;
    if (input && !input.getAttribute('aria-label')) {
      input.setAttribute('aria-label', t('messagePlaceholder'));
      input.setAttribute('role', 'textbox');
      input.setAttribute('aria-multiline', 'true');
    }
    var chatContainer = document.getElementById('chatContainer') || document.getElementById('chatArea');
    if (chatContainer && !chatContainer.getAttribute('role')) {
      chatContainer.setAttribute('role', 'log');
      chatContainer.setAttribute('aria-label', t('history') || '聊天记录');
      chatContainer.setAttribute('aria-live', 'polite');
    }
    var sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.getAttribute('role')) {
      sidebar.setAttribute('role', 'navigation');
      sidebar.setAttribute('aria-label', t('history') || '会话列表');
    }
  }, 2000);
}

function announceToScreenReader(message) {
  var liveRegion = document.getElementById('a11y-live-region');
  if (liveRegion) {
    liveRegion.textContent = '';
    setTimeout(function() { liveRegion.textContent = message; }, 50);
  }
}

// ----- 键盘导航增强 -----
var KEYBOARD_NAV = {
  // Tab 焦点陷阱管理
  focusTrap: null,
  trapActive: false,

  enableFocusTrap: function(container) {
    this.focusTrap = container;
    this.trapActive = true;
    var focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length > 0) focusable[0].focus();
  },

  disableFocusTrap: function() {
    this.trapActive = false;
    this.focusTrap = null;
  },

  handleTabKey: function(e) {
    if (!this.trapActive || !this.focusTrap) return;
    if (e.key !== 'Tab') return;

    var focusable = this.focusTrap.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
};

// Tab 键导航（通过统一 keyboard 分发器注册，在 init 中执行）
var _tabNavRegistered = false;

// ----- 高对比度模式 -----
function setHighContrast(enabled) {
  if (enabled) {
    document.documentElement.style.setProperty('--text-primary', '#ffffff');
    document.documentElement.style.setProperty('--text-secondary', '#cccccc');
    document.documentElement.style.setProperty('--border', 'rgba(255,255,255,.3)');
    document.documentElement.style.setProperty('--bg-surface', '#000000');
    document.documentElement.style.setProperty('--bg-card', '#111111');
    document.documentElement.classList.add('high-contrast');
  } else {
    document.documentElement.style.removeProperty('--text-primary');
    document.documentElement.style.removeProperty('--text-secondary');
    document.documentElement.style.removeProperty('--border');
    document.documentElement.style.removeProperty('--bg-surface');
    document.documentElement.style.removeProperty('--bg-card');
    document.documentElement.classList.remove('high-contrast');
  }
}

// ----- 字体大小调节 -----
function setFontSize(scale) {
  scale = Math.max(0.8, Math.min(1.5, scale));
  document.documentElement.style.fontSize = (scale * 100) + '%';
  if (Core.config) Core.config.fontSizeScale = scale;
}

// ----- 注册命令 -----
setTimeout(function() {
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/lang', function(args) {
      var lang = (args || '').trim();
      if (!lang) {
        var langs = getAvailableLanguages();
        var lines = ['🌐 可用语言:\n'];
        langs.forEach(function(l) {
          var current = l.code === currentLang ? ' ← 当前' : '';
          lines.push('  ' + l.flag + ' ' + l.name + ' (' + l.code + ')' + current);
        });
        lines.push('\n使用 /lang <代码> 切换语言');
        return lines.join('\n');
      }
      if (setLanguage(lang)) {
        return '✅ 语言已切换为: ' + lang;
      }
      return '❌ 不支持的语言: ' + lang + ' (可用: ' + Object.keys(TRANSLATIONS).join(', ') + ')';
    }, '切换语言 — /lang [zh|en|ja|ko]');

    Core.custom.registerCommand('/a11y', function(args) {
      var sub = (args || '').trim();
      if (sub === 'contrast') {
        var isHC = document.documentElement.classList.contains('high-contrast');
        setHighContrast(!isHC);
        return (isHC ? '🔓 已关闭高对比度' : '🔒 已开启高对比度');
      }
      if (sub.startsWith('font ')) {
        var scale = parseFloat(sub.split(' ')[1]) || 1;
        setFontSize(scale);
        return '✅ 字体缩放: ' + (scale * 100) + '%';
      }
      if (sub === 'announce') {
        announceToScreenReader('无障碍模式已激活');
        return '✅ 已发送屏幕阅读器通知';
      }
      return '♿ 无障碍设置\n\n' +
        '/a11y contrast — 切换高对比度模式\n' +
        '/a11y font <0.8-1.5> — 调节字体缩放\n' +
        '/a11y announce — 测试屏幕阅读器';
    }, '无障碍设置 — contrast/font/announce');
  }

  // 初始化无障碍
  setupAccessibility();
}, 300);

// 更新可用语言列表
var _origGetAvailable = getAvailableLanguages;
getAvailableLanguages = function() {
  return [
    { code: 'zh', name: '简体中文', flag: '🇨🇳' },
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'ja', name: '日本語', flag: '🇯🇵' },
    { code: 'ko', name: '한국어', flag: '🇰🇷' },
  ];
};

module.exports = { init };
