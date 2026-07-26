// modules/connectors.js — 连接器管理：连接外部软件与服务，扩展 AI 能力边界
// 参考 QoderWork 的连接器（Connectors）设计：分类卡片 + 开关
var Core = null;

// ===== 连接器注册表 =====
// type: 'builtin' = 内置能力（Agent 已可直接使用）；'external' = 外部服务（可开关）
// status: 'active' = 已有可用后端实现；'planned' = 规划中（尚无后端）
var CONNECTOR_REGISTRY = [
  // —— 系统与本地 ——
  { id: 'filesystem', name: '文件系统', desc: '读写本地文件与目录', icon: 'folder_open', category: 'system', type: 'builtin', status: 'active' },
  { id: 'shell', name: '命令行', desc: '执行终端命令与脚本', icon: 'terminal', category: 'system', type: 'builtin', status: 'active' },
  { id: 'clipboard', name: '剪贴板', desc: '读取与写入系统剪贴板', icon: 'content_paste', category: 'system', type: 'builtin', status: 'active' },
  { id: 'browser', name: '浏览器', desc: '网页浏览与自动化操作', icon: 'public', category: 'system', type: 'external', status: 'active' },

  // —— 通讯协作 ——
  { id: 'wechat', name: '微信', desc: '消息收发与文件传输', icon: 'chat', category: 'communication', type: 'external', status: 'planned' },
  { id: 'dingtalk', name: '钉钉', desc: '企业消息与日程管理', icon: 'mark_chat_unread', category: 'communication', type: 'external', status: 'planned' },
  { id: 'feishu', name: '飞书', desc: '文档、表格与多维表格', icon: 'quickreply', category: 'communication', type: 'external', status: 'planned' },
  // 🔧 以下三项由 im-notify.js / mailer.js 提供真实后端（webhook / SMTP），从 planned 提升为 active
  { id: 'im-notify', name: 'IM 通知推送', desc: 'Telegram / Discord / Slack / Bark / 通用 Webhook 通知（im-notify 模块）', icon: 'send', category: 'communication', type: 'external', status: 'active' },
  { id: 'email', name: '电子邮件', desc: 'SMTP 发信可用（mailer 模块）；IMAP 收信规划中', icon: 'mail', category: 'communication', type: 'external', status: 'active' },

  // —— 开发工具 ——
  { id: 'github', name: 'GitHub', desc: '仓库、Issue 与 PR 管理', icon: 'code', category: 'development', type: 'external', status: 'active' },
  { id: 'vscode', name: 'VS Code', desc: '编辑器集成与代码操作', icon: 'code_blocks', category: 'development', type: 'external', status: 'planned' },
  { id: 'docker', name: 'Docker', desc: '容器与镜像管理', icon: 'deployed_code', category: 'development', type: 'external', status: 'planned' },
  { id: 'ssh', name: 'SSH', desc: '远程服务器连接', icon: 'dns', category: 'development', type: 'external', status: 'planned' },

  // —— 效率办公 ——
  { id: 'notion', name: 'Notion', desc: '笔记与知识库同步', icon: 'note_alt', category: 'productivity', type: 'external', status: 'planned' },
  { id: 'obsidian', name: 'Obsidian', desc: '本地 Markdown 知识库', icon: 'edit_note', category: 'productivity', type: 'external', status: 'planned' },
  { id: 'calendar', name: '日历', desc: '日程与提醒管理', icon: 'calendar_month', category: 'productivity', type: 'external', status: 'planned' },
  { id: 'office', name: 'Office', desc: 'Word / Excel / PPT 文档', icon: 'description', category: 'productivity', type: 'external', status: 'active' },

  // —— 数据服务 ——
  { id: 'sqlite', name: 'SQLite', desc: '本地数据库查询', icon: 'storage', category: 'data', type: 'builtin', status: 'active' },
  { id: 'mysql', name: 'MySQL', desc: '关系型数据库连接', icon: 'database', category: 'data', type: 'external', status: 'planned' },
  { id: 'redis', name: 'Redis', desc: '内存缓存与队列', icon: 'memory', category: 'data', type: 'external', status: 'planned' },
  { id: 'websearch', name: '网络搜索', desc: '实时联网检索信息', icon: 'travel_explore', category: 'data', type: 'builtin', status: 'active' }
];

var CATEGORY_LABELS = {
  system: '系统与本地',
  communication: '通讯协作',
  development: '开发工具',
  productivity: '效率办公',
  data: '数据服务'
};

// ===== 状态读取 =====
function getConnectorState() {
  if (Core && Core.config && Core.config.connectors && typeof Core.config.connectors === 'object') {
    return Core.config.connectors;
  }
  return {};
}

function isEnabled(connector) {
  // 内置能力默认启用；外部服务默认关闭，需用户手动开启
  var state = getConnectorState();
  if (typeof state[connector.id] === 'boolean') return state[connector.id];
  return connector.type === 'builtin';
}

function setEnabled(id, enabled) {
  var state = getConnectorState();
  state[id] = enabled;
  if (Core && Core.saveConfig) {
    Core.saveConfig({ connectors: state });
  }
}

function getConnector(id) {
  for (var i = 0; i < CONNECTOR_REGISTRY.length; i++) {
    if (CONNECTOR_REGISTRY[i].id === id) return CONNECTOR_REGISTRY[i];
  }
  return null;
}

function listEnabled() {
  var result = [];
  for (var i = 0; i < CONNECTOR_REGISTRY.length; i++) {
    if (isEnabled(CONNECTOR_REGISTRY[i])) result.push(CONNECTOR_REGISTRY[i]);
  }
  return result;
}

// ===== HTML 转义（防 XSS）=====
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== 渲染连接器列表 =====
function renderConnectors() {
  var container = document.getElementById('connectorsList');
  if (!container) return;

  var html = '';
  var categories = ['system', 'communication', 'development', 'productivity', 'data'];

  for (var c = 0; c < categories.length; c++) {
    var cat = categories[c];
    var items = CONNECTOR_REGISTRY.filter(function(x) { return x.category === cat; });
    if (items.length === 0) continue;

    html += '<div class="connector-category">' + esc(CATEGORY_LABELS[cat]) + '</div>';

    for (var i = 0; i < items.length; i++) {
      var conn = items[i];
      var enabled = isEnabled(conn);
      var isBuiltin = conn.type === 'builtin';
      var isPlanned = conn.status === 'planned';
      // 🔒 S10: 状态徽标——诚实标注真实可用性
      var statusBadge = isPlanned
        ? ' <span class="connector-badge connector-badge-planned">规划中</span>'
        : (isBuiltin ? ' <span class="connector-badge">内置</span>' : ' <span class="connector-badge connector-badge-active">已接入</span>');
      html += '<div class="connector-card' + (isPlanned ? ' connector-card-planned' : '') + '">' +
        '<span class="material-icons-outlined connector-icon">' + esc(conn.icon) + '</span>' +
        '<div class="connector-info">' +
          '<div class="connector-name">' + esc(conn.name) + statusBadge + '</div>' +
          '<div class="connector-desc">' + esc(conn.desc) + '</div>' +
        '</div>' +
        '<label class="connector-switch">' +
          '<input type="checkbox" data-connector-id="' + esc(conn.id) + '"' + (enabled ? ' checked' : '') + (isPlanned ? ' disabled' : '') + ' />' +
          '<span class="connector-slider"></span>' +
        '</label>' +
      '</div>';
    }
  }

  container.innerHTML = html;

  // 绑定开关事件
  var checkboxes = container.querySelectorAll('input[data-connector-id]');
  checkboxes.forEach(function(cb) {
    cb.addEventListener('change', function() {
      var id = cb.getAttribute('data-connector-id');
      var conn = getConnector(id);
      setEnabled(id, cb.checked);
      var label = conn ? conn.name : id;
      if (Core && Core.showNotification) {
        Core.showNotification('连接器「' + label + '」' + (cb.checked ? '已启用' : '已禁用'), 'info');
      }
      console.log('[connectors] ' + id + ' -> ' + cb.checked);
    });
  });
}

// ===== 模块导出 =====
module.exports = {
  name: 'connectors',
  dependencies: ['custom'],
  init: function(_Core) {
    Core = _Core;

    // 暴露 API
    Core.connectors = {
      registry: CONNECTOR_REGISTRY,
      isEnabled: function(id) {
        var conn = getConnector(id);
        return conn ? isEnabled(conn) : false;
      },
      setEnabled: setEnabled,
      listEnabled: listEnabled,
      render: renderConnectors
    };

    // 渲染列表
    renderConnectors();

    // 刷新按钮
    var refreshBtn = document.getElementById('connectorsRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        renderConnectors();
        if (Core.showNotification) Core.showNotification('连接器列表已刷新', 'info');
      });
    }

    // 注册 /connector 命令
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/connector', '连接器管理（查看/开关外部服务连接）', function(args) {
        var parts = (args || '').trim().split(/\s+/);
        var sub = (parts[0] || '').toLowerCase();

        if (!sub || sub === 'list') {
          var enabled = listEnabled();
          var lines = ['已启用 ' + enabled.length + ' / ' + CONNECTOR_REGISTRY.length + ' 个连接器：'];
          for (var i = 0; i < enabled.length; i++) {
            lines.push('  ✓ ' + enabled[i].name + ' — ' + enabled[i].desc);
          }
          return lines.join('\n');
        }

        if (sub === 'on' || sub === 'off') {
          var id = parts[1];
          if (!id) return '用法：/connector on|off <连接器ID>，例如 /connector on github';
          var conn = getConnector(id);
          if (!conn) return '未找到连接器：' + id + '（可用 /connector list 查看）';
          setEnabled(id, sub === 'on');
          return '连接器「' + conn.name + '」' + (sub === 'on' ? '已启用 ✓' : '已禁用 ✗');
        }

        return '用法：/connector [list | on <ID> | off <ID>]';
      }, false);
    }

    console.log('[connectors] initialized, ' + CONNECTOR_REGISTRY.length + ' connectors registered, ' + listEnabled().length + ' enabled');
  }
};
