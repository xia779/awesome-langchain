// modules/settings.js - 设置管理模块（修复事件绑定 + 关闭按钮）
let Core = null;
var _htmlUtils = require('./html-utils');

// ===== 加载配置到界面 =====
function loadSettingsToUI() {
  try {
    if (!Core.config) return;
    const c = Core.config;
    const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    safeSet('appNameInput', c.appName);
    safeSet('bgInput', c.chatBackground);
    safeSet('bubbleUserInput', c.chatBubbleUser || '#3b82f6');
    safeSet('bubbleAIInput', c.chatBubbleAI || '#1e1e32');
    // 自定义颜色
    safeSet('sidebarColorInput', c.sidebarColor || '#141414');
    safeSet('panelColorInput', c.panelColor || '#141414');
    safeSet('accentColorInput', c.accentColor || '#3b82f6');
    safeSet('textColorInput', c.textColor || '#e8e8e8');
    // 主题模式
    var themeSelect = document.getElementById('themeSelect');
    if (themeSelect) themeSelect.value = c.themeMode || 'dark';
    safeSet('temperatureSlider', c.temperature);
    const tempDisplay = document.getElementById('tempDisplay');
    if (tempDisplay) tempDisplay.textContent = c.temperature || 0.7;
    safeSet('systemPrompt', c.systemPrompt || c.systemInstruction);
    safeSet('ollamaModel', c.ollamaModel);
    safeSet('deepseekKey', c.deepseekKey);
    safeSet('deepseekModel', c.deepseekModel);
    safeSet('doubaoKey', c.doubaoKey);
    safeSet('doubaoModel', c.doubaoModel);
    safeSet('qwenKey', c.qwenKey);
    safeSet('qwenModel', c.qwenModel);
    safeSet('customBase', c.customBase);
    safeSet('customKey', c.customKey);
    safeSet('customModel', c.customModel);
    const autoRoute = document.getElementById('autoRouteCheckbox');
    if (autoRoute) autoRoute.checked = c.autoRoute || false;
    const notification = document.getElementById('notificationCheckbox');
    if (notification) notification.checked = c.notification !== false; // 默认开启
    const autoKnowledge = document.getElementById('autoKnowledgeCheckbox');
    if (autoKnowledge) autoKnowledge.checked = c.autoKnowledgeMemory || false;
    const lang = document.getElementById('languageSelect');
    if (lang) lang.value = c.language || 'zh-CN';
    safeSet('searchEngineSelect', c.searchEngine || 'bocha');
    safeSet('bochaApiKey', c.bochaApiKey);
    safeSet('tavilyApiKey', c.tavilyApiKey);
    const rolePreset = document.getElementById('rolePresetSelect');
    if (rolePreset) rolePreset.value = c.rolePreset || '';
    // 图像生成设置
    var igProvider = document.getElementById('imageGenProviderSelect');
    if (igProvider) igProvider.value = c.imageGenProvider || 'silicon';
    safeSet('imageGenSizeSelect', c.imageGenSize || '1024x1024');
    safeSet('siliconFlowKey', c.siliconFlowKey);
    safeSet('openaiImageKey', c.openaiImageKey);
    // 视频生成设置
    safeSet('videoGenModelSelect', c.videoGenModel || 'Wan-AI/Wan2.1-T2V-14B');
    safeSet('videoGenSizeSelect', c.videoGenSize || '1280x720');
    // 权限模式
    var permSelect = document.getElementById('permissionModeSelect');
    if (permSelect) permSelect.value = c.permissionMode || 'full';
    toggleKeyInputsVisibility();
  } catch (err) {
    console.warn('⚠️ 加载设置到UI失败:', err.message);
  }
}

// ===== 角色预设切换 =====
function applyRolePreset(presetId) {
  if (!presetId) return;
  const presets = {
    general: '你是一个知识渊博的通用助手，擅长回答各类百科、常识和技术问题。',
    code: '你是一个代码执行专家，擅长 Python 编程、代码调试和数据分析。',
    text: '你是一个创意写作专家，擅长文案创作、故事编写、翻译和内容润色。',
    stock: '你是一个金融数据分析师，擅长股票查询、财经新闻解读和市场分析。',
    knowledge: '你是一个知识库助手。请根据提供的文档内容回答用户的问题。'
  };
  const prompt = presets[presetId];
  if (prompt) {
    document.getElementById('systemPrompt').value = prompt;
  }
}

// ===== 保存设置 =====
function saveSettings() {
  try {
    if (!Core) return;
    const rolePresetEl = document.getElementById('rolePresetSelect');
    const rolePreset = rolePresetEl ? rolePresetEl.value : '';
    const safeVal = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    // 🔧 保护 API key：如果输入为空，保留现有值（防止误清除）
    const safeKey = (id) => { 
      const el = document.getElementById(id); 
      if (!el) return Core.config[id] || '';
      const val = el.value.trim();
      return val || Core.config[id] || ''; // 输入为空时保留现有值
    };
    const newConfig = {
      appName: safeVal('appNameInput'),
      chatBackground: safeVal('bgInput'),
      chatBubbleUser: safeVal('bubbleUserInput') || '#3b82f6',
      chatBubbleAI: safeVal('bubbleAIInput') || '#1e1e32',
      sidebarColor: safeVal('sidebarColorInput') || '#141414',
      panelColor: safeVal('panelColorInput') || '#141414',
      accentColor: safeVal('accentColorInput') || '#3b82f6',
      textColor: safeVal('textColorInput') || '#e8e8e8',
      themeMode: (document.getElementById('themeSelect') || {}).value || 'dark',
      temperature: parseFloat(safeVal('temperatureSlider') || 0.7),
      systemPrompt: safeVal('systemPrompt'),
      systemInstruction: safeVal('systemPrompt'),
      ollamaModel: safeVal('ollamaModel'),
      deepseekKey: safeKey('deepseekKey'),
      deepseekModel: safeVal('deepseekModel') || 'deepseek-chat',
      doubaoKey: safeKey('doubaoKey'),
      doubaoModel: safeVal('doubaoModel') || 'doubao-pro-32k',
      qwenKey: safeKey('qwenKey'),
      qwenModel: safeVal('qwenModel') || 'qwen-plus',
      customBase: safeVal('customBase'),
      customKey: safeKey('customKey'),
      customModel: safeVal('customModel') || 'gpt-3.5-turbo',
      autoRoute: (document.getElementById('autoRouteCheckbox') || {}).checked || false,
      notification: (document.getElementById('notificationCheckbox') || {}).checked !== false,
      autoKnowledgeMemory: (document.getElementById('autoKnowledgeCheckbox') || {}).checked || false,
      imageGenProvider: (document.getElementById('imageGenProviderSelect') || {}).value || 'silicon',
      imageGenSize: (document.getElementById('imageGenSizeSelect') || {}).value || '1024x1024',
      siliconFlowKey: safeKey('siliconFlowKey'),
      openaiImageKey: safeKey('openaiImageKey'),
      videoGenModel: (document.getElementById('videoGenModelSelect') || {}).value || 'Wan-AI/Wan2.1-T2V-14B',
      videoGenSize: (document.getElementById('videoGenSizeSelect') || {}).value || '1280x720',
      language: (document.getElementById('languageSelect') || {}).value || 'zh-CN',
      searchEngine: safeVal('searchEngineSelect') || 'bocha',
      bochaApiKey: safeKey('bochaApiKey'),
      tavilyApiKey: safeKey('tavilyApiKey'),
      rolePreset: rolePreset,
    };
    // 检测 API Key 是否变更，清除 OpenAI 客户端缓存（P5: 统一 API 调用）
    if (Core.cloudApi && Core.cloudApi.invalidateClient) {
      const keyProviders = ['deepseek', 'doubao', 'qwen', 'custom'];
      for (const p of keyProviders) {
        const keyField = p + 'Key';
        if (newConfig[keyField] !== Core.config[keyField]) {
          Core.cloudApi.invalidateClient(p);
        }
      }
    }
    
    Core.saveConfig(newConfig);
    // saveConfig 内部已触发 configChanged，无需重复 emit
    const status = document.getElementById('status');
    if (status) status.textContent = '✅ 设置已保存';
    // 保存后自动关闭设置面板
    closeSettings();
    setTimeout(() => { if (status) status.textContent = '✅ 已就绪'; }, 1500);
  } catch (err) {
    console.warn('⚠️ 保存设置失败:', err.message);
  }
}

// ===== 显示/隐藏 Key 输入框 =====
function toggleKeyInputsVisibility() {
  const engine = document.getElementById('searchEngineSelect').value;
  const groups = {
    bocha: document.getElementById('bochaKeyGroup'),
    tavily: document.getElementById('tavilyKeyGroup'),
  };
  Object.keys(groups).forEach(key => {
    if (groups[key]) {
      groups[key].style.display = (engine === key) ? 'block' : 'none';
    }
  });
}

// ===== 知识库面板初始化 =====
async function initKnowledgePanel() {
  const uploadBtn = document.getElementById('knowledgeUploadBtn');
  const fileInput = document.getElementById('knowledgeFileInput');
  const refreshBtn = document.getElementById('knowledgeRefreshBtn');
  const testBtn = document.getElementById('knowledgeTestBtn');
  const testQuery = document.getElementById('knowledgeTestQuery');

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['txt','md','pdf','docx','doc','xlsx','xls','csv'].includes(ext)) {
        showAlert('仅支持 .txt .md .pdf .docx .xlsx .csv 格式');
        fileInput.value = '';
        return;
      }
      const status = document.getElementById('status');
      if (status) status.textContent = '⏳ 正在上传文档...';
      try {
        let result;
        
        if (file.path && require('fs').existsSync(file.path)) {
          // 方式1：使用文件路径（Electron 中可用时）
          result = await Core.knowledge.uploadDocument(file.path);
        } else {
          // 方式2：使用 FileReader 读取内容（兼容所有环境）
          const isBinary = ['pdf','docx','doc','xlsx','xls'].includes(ext);
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.onerror = () => reject(reader.error);
            if (isBinary) {
              reader.readAsArrayBuffer(file);
            } else {
              reader.readAsText(file);
            }
          });
          
          if (isBinary) {
            // 二进制格式：保存为临时文件后用对应库解析
            const os = require('os');
            const path = require('path');
            const fs = require('fs');
            const tmpFile = path.join(os.tmpdir(), 'knowledge-upload-' + Date.now() + '.' + ext);
            fs.writeFileSync(tmpFile, Buffer.from(content));
            result = await Core.knowledge.uploadDocument(tmpFile);
            try { fs.unlinkSync(tmpFile); } catch(e) {}
          } else {
            result = await Core.knowledge.uploadDocument({ content: content, fileName: file.name });
          }
        }
        
        if (result.success) {
          showToast('✅ 上传成功: ' + result.fileName + '\n共 ' + result.chunks + ' 个分块', 'success');
          renderKnowledgeDocList();
        } else {
          showToast('❌ 上传失败: ' + (result.error || '未知错误'), 'error');
        }
      } catch (err) {
        showToast('❌ 上传异常: ' + err.message, 'error');
      }
      if (status) status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')';
      fileInput.value = '';
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', renderKnowledgeDocList);
  }

  if (testBtn && testQuery) {
    testBtn.addEventListener('click', async () => {
      const query = testQuery.value.trim();
      if (!query) { showAlert('请输入检索问题'); return; }
      const resultsDiv = document.getElementById('knowledgeTestResults');
      if (resultsDiv) { resultsDiv.innerHTML = ''; Core.showSpinner(resultsDiv, '检索中...'); }
      try {
        const results = await Core.knowledge.search(query, 5);
        if (resultsDiv) Core.hideSpinner(resultsDiv);
        if (!results || results.length === 0) {
          if (resultsDiv) resultsDiv.innerHTML = '<div style="color:#94a3b8;">未找到相关内容</div>';
          return;
        }
        let html = '<div style="margin-bottom:8px;color:#94a3b8;">找到 ' + results.length + ' 条相关片段：</div>';
        results.forEach((r, i) => {
          html += '<div style="padding:8px;margin-bottom:6px;background:rgba(59,130,246,0.08);border-radius:6px;border-left:3px solid #3b82f6;">';
          html += '<div style="font-size:11px;color:#3b82f6;margin-bottom:4px;">📄 ' + (r.fileName || '未知') + ' · 相似度 ' + (r.score ? r.score.toFixed(3) : 'N/A') + '</div>';
          html += '<div style="font-size:12px;color:#e2e8f0;line-height:1.5;">' + (r.text || '').substring(0, 200) + (r.text && r.text.length > 200 ? '...' : '') + '</div>';
          html += '</div>';
        });
        if (resultsDiv) resultsDiv.innerHTML = html;
      } catch (err) {
        if (resultsDiv) Core.hideSpinner(resultsDiv);
        if (resultsDiv) resultsDiv.innerHTML = '<div style="color:#ef4444;">检索失败: ' + Core.sanitizeHtml(err.message) + '</div>';
      }
    });
    testQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') testBtn.click(); });
  }

  // 初始渲染文档列表
  renderKnowledgeDocList();
}

function renderKnowledgeDocList() {
  const container = document.getElementById('knowledgeDocList');
  if (!container) return;
  if (!Core.knowledge || !Core.knowledge.listDocuments) {
    container.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">正在加载知识库模块...</div>';
    // 延迟重试
    setTimeout(renderKnowledgeDocList, 1000);
    return;
  }
  try {
    const docs = Core.knowledge.listDocuments();
    if (!docs || docs.length === 0) {
      container.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">暂无文档，请上传</div>';
      return;
    }
    let html = '';
    // 🔒 安全修復：使用共享 HTML 轉義函數
    var escapeHtml = _htmlUtils.escapeHtml;
    docs.forEach((doc) => {
      const safeName = escapeHtml(doc.fileName || '未命名');
      const safeId = escapeHtml(doc.id || '');
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid var(--border);">';
      html += '<div style="flex:1;min-width:0;">';
      html += '<div style="font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + safeName + '">' + safeName + '</div>';
      html += '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">' + (doc.chunkCount || 0) + ' 个分块</div>';
      html += '</div>';
      html += '<button class="knowledge-delete-btn" data-id="' + safeId + '" style="margin-left:8px;padding:4px 10px;background:#ef4444;border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer;">删除</button>';
      html += '</div>';
    });
    container.innerHTML = html;

    // 绑定删除事件
    container.querySelectorAll('.knowledge-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const docId = btn.dataset.id;
        if (!docId) return;
        if (!confirm('确定删除该文档及其所有分块吗？')) return;
        try {
          // 🔧 使用 knowledge.deleteDocument 统一删除
          if (Core.knowledge && Core.knowledge.deleteDocument) {
            const result = await Core.knowledge.deleteDocument(docId);
            if (!result.success) throw new Error(result.error);
          } else {
            // 回退：手动删除 JSON
            const dir = Core.knowledge.getKnowledgeDir ? Core.knowledge.getKnowledgeDir() : require('path').join(Core.DATA_ROOT, 'knowledge');
            const docPath = require('path').join(dir, docId + '.json');
            const fs = require('fs');
            if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
            const indexPath = require('path').join(dir, 'index.json');
            let index = [];
            if (fs.existsSync(indexPath)) {
              index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            }
            index = index.filter((d) => d.id !== docId);
            fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
          }
          renderKnowledgeDocList();
          const status = document.getElementById('status');
          if (status) status.textContent = '✅ 文档已删除';
          setTimeout(() => { if (status) status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
        } catch (err) {
          showToast('❌ 删除失败: ' + err.message, 'error');
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<div style="color:#ef4444;font-size:13px;text-align:center;padding:16px 0;">加载文档列表失败: ' + Core.sanitizeHtml(err.message) + '</div>';
  }
}

// ===== 打开/关闭设置面板 =====
function openSettings() {
  loadSettingsToUI();
  var modal = document.getElementById('settingsModal');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  // 焦点陷阱
  if (Core.i18n && Core.KEYBOARD_NAV) {
    Core.KEYBOARD_NAV.enableFocusTrap(modal);
  }
}
function closeSettings() {
  var modal = document.getElementById('settingsModal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  // 释放焦点陷阱
  if (Core.KEYBOARD_NAV) {
    Core.KEYBOARD_NAV.disableFocusTrap();
  }
  // 返回焦点到输入框
  if (Core.dom && Core.dom.input) Core.dom.input.focus();
}

// ===== 模型管理（保持不变） =====
async function refreshModelList() {
  const container = document.getElementById('modelListContainer');
  if (!container) return;
  if (!Core.modelManager) {
    container.innerHTML = '<div style="color:#666;">模型管理模块未加载</div>';
    return;
  }
  try {
    const models = await Core.modelManager.getInstalledModels();
    if (models.length === 0) {
      container.innerHTML = '<div style="color:#666;">暂无已安装模型</div>';
    } else {
      let html = '';
      models.forEach(m => {
        html += `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #e2e8f0;">
            <span style="font-size:14px;">${m.name}</span>
            <span style="font-size:12px; color:#64748b;">${m.size}</span>
            <button data-model="${m.name}" class="delete-model-btn" style="background:#ef4444; border:none; border-radius:6px; color:#fff; padding:2px 10px; cursor:pointer;">删除</button>
          </div>
        `;
      });
      container.innerHTML = html;
      container.querySelectorAll('.delete-model-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.model;
          if (!confirm(`确定要删除模型 "${name}" 吗？`)) return;
          try {
            await Core.modelManager.deleteModel(name);
            showToast(`✅ 模型 "${name}" 已删除`, 'success');
            refreshModelList();
          } catch (err) {
            showToast(`❌ 删除失败: ${err.message}`, 'error');
          }
        });
      });
    }
  } catch (err) {
    container.innerHTML = `<div style="color:#ef4444;">加载模型列表失败: ${Core.sanitizeHtml(err.message)}</div>`;
  }
}

function downloadModel() {
  const input = document.getElementById('modelDownloadInput');
  const btn = document.getElementById('modelDownloadBtn');
  const progressContainer = document.getElementById('downloadProgressContainer');
  const progressBar = document.getElementById('downloadProgressBar');
  const progressText = document.getElementById('downloadProgressText');

  const modelName = input.value.trim();
  if (!modelName) { showAlert('请输入模型名称'); return; }

  btn.disabled = true;
  btn.textContent = '下载中...';
  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = '准备下载...';

  Core.modelManager.pullModel(
    modelName,
    (percent, message) => {
      if (percent !== null) {
        progressBar.style.width = Math.min(percent, 100) + '%';
        progressText.textContent = message || `${Math.round(percent)}%`;
      } else {
        progressText.textContent = message;
      }
    },
    (err, result) => {
      btn.disabled = false;
      btn.textContent = '下载';
      if (err) {
        progressText.textContent = '❌ ' + err.message;
        showToast(`下载失败: ${err.message}`, 'error');
      } else {
        progressText.textContent = '✅ 下载完成！';
        showToast(`✅ 模型 "${modelName}" 下载成功！`, 'success');
        input.value = '';
        progressContainer.style.display = 'none';
        refreshModelList();
      }
    }
  );
}

// ===== 插件面板初始化 =====
function initPluginsPanel() {
  const refreshBtn = document.getElementById('pluginsRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', renderPluginsList);
  }
  renderPluginsList();
}

function renderPluginsList() {
  const container = document.getElementById('pluginsList');
  if (!container) return;
  
  if (!Core.plugins || !Core.plugins.listPlugins) {
    container.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">正在加载插件系统...</div>';
    setTimeout(renderPluginsList, 1000);
    return;
  }
  
  try {
    const plugins = Core.plugins.listPlugins();
    if (!plugins || plugins.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary); font-size:13px; text-align:center; padding:16px 0;">暂无插件<br>将插件目录放入 E:\\my-ai-data\\plugins\\</div>';
      return;
    }
    
    let html = '';
    plugins.forEach((plugin) => {
      const status = plugin.enabled ? '🟢' : '⚫';
      const statusText = plugin.enabled ? '已启用' : '已禁用';
      html += '<div style="padding:8px 12px; margin-bottom:6px; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid var(--border);">';
      html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">';
      html += '<span style="font-size:13px; color:var(--text); font-weight:500;">' + status + ' ' + plugin.name + '</span>';
      html += '<span style="font-size:11px; color:#94a3b8;">v' + plugin.version + '</span>';
      html += '</div>';
      html += '<div style="font-size:11px; color:#94a3b8; margin-bottom:4px;">' + (plugin.description || '无描述') + '</div>';
      html += '<div style="display:flex; justify-content:space-between; align-items:center;">';
      html += '<span style="font-size:11px; color:#94a3b8;">👤 ' + (plugin.author || '未知') + ' · ' + statusText + '</span>';
      html += '<div>';
      if (plugin.enabled) {
        html += '<button class="plugin-disable-btn" data-id="' + plugin.id + '" style="padding:2px 8px; background:#ef4444; border:none; border-radius:4px; color:#fff; font-size:11px; cursor:pointer; margin-right:4px;">禁用</button>';
      } else {
        html += '<button class="plugin-enable-btn" data-id="' + plugin.id + '" style="padding:2px 8px; background:#22c55e; border:none; border-radius:4px; color:#fff; font-size:11px; cursor:pointer; margin-right:4px;">启用</button>';
      }
      html += '<button class="plugin-uninstall-btn" data-id="' + plugin.id + '" style="padding:2px 8px; background:#666; border:none; border-radius:4px; color:#fff; font-size:11px; cursor:pointer;">卸载</button>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
    });
    container.innerHTML = html;
    
    // 绑定启用事件
    container.querySelectorAll('.plugin-enable-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (Core.plugins && Core.plugins.enablePlugin) {
          Core.plugins.enablePlugin(id);
          renderPluginsList();
        }
      });
    });
    // 绑定禁用事件
    container.querySelectorAll('.plugin-disable-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (Core.plugins && Core.plugins.disablePlugin) {
          Core.plugins.disablePlugin(id);
          renderPluginsList();
        }
      });
    });
    // 绑定卸载事件
    container.querySelectorAll('.plugin-uninstall-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (!confirm('确定卸载插件 "' + id + '" 吗？')) return;
        if (Core.plugins && Core.plugins.uninstallPlugin) {
          Core.plugins.uninstallPlugin(id);
          renderPluginsList();
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<div style="color:#ef4444;font-size:13px;text-align:center;padding:16px 0;">加载插件列表失败: ' + Core.sanitizeHtml(err.message) + '</div>';
  }
}


// ===== 插件市场面板 =====
function initMarketplacePanel() {
  var refreshBtn = document.getElementById('marketplaceRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      var urlInput = document.getElementById('marketplaceUrlInput');
      var url = urlInput ? urlInput.value.trim() : '';
      renderMarketplaceList(url || null);
    });
  }
  renderMarketplaceList(null);
}

async function renderMarketplaceList(url) {
  var container = document.getElementById('marketplaceList');
  if (!container) return;

  if (!Core.plugins || !Core.plugins.fetchMarketplace) {
    container.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">插件系统未就绪</div>';
    return;
  }

  container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:16px 0;">正在加载市场...</div>';

  try {
    var registry = await Core.plugins.fetchMarketplace(url);
    if (!registry || !registry.plugins || registry.plugins.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:16px 0;">市场暂无可用插件<br>请检查注册表 URL 或本地 plugins-marketplace.json</div>';
      return;
    }

    var installedIds = Core.plugins.getInstalledIds ? Core.plugins.getInstalledIds() : [];
    var html = '';
    registry.plugins.forEach(function(mp) {
      var isInstalled = installedIds.indexOf(mp.id) >= 0;
      var categoryBadge = mp.category ? '<span style="font-size:10px;padding:1px 6px;background:rgba(59,130,246,0.15);color:var(--primary);border-radius:4px;margin-left:6px;">' + mp.category + '</span>' : '';
      html += '<div style="padding:8px 12px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid var(--border);">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
      html += '<span style="font-size:13px;color:var(--text);font-weight:500;">' + mp.name + categoryBadge + '</span>';
      html += '<span style="font-size:11px;color:#94a3b8;">v' + mp.version + '</span>';
      html += '</div>';
      html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">' + (mp.description || '无描述') + '</div>';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
      html += '<span style="font-size:11px;color:#94a3b8;">👤 ' + (mp.author || '未知') + ' · ' + mp.skills.length + ' 个技能</span>';
      if (isInstalled) {
        html += '<span style="padding:2px 10px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:4px;font-size:11px;">已安装</span>';
      } else {
        html += '<button class="marketplace-install-btn" data-id="' + mp.id + '" style="padding:3px 12px;background:var(--primary);color:#fff;border:none;border-radius:6px;font-size:11px;cursor:pointer;transition:opacity 0.2s;">安装</button>';
      }
      html += '</div>';
      html += '</div>';
    });
    container.innerHTML = html;

    // 绑定安装按钮
    container.querySelectorAll('.marketplace-install-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = '安装中...';
        btn.style.opacity = '0.6';
        try {
          var result = await Core.plugins.installFromMarketplace(id);
          if (result.success) {
            btn.textContent = '已安装';
            btn.style.background = '#22c55e';
            btn.style.opacity = '1';
            // 同时刷新技能列表
            if (Core.skills && Core.skills.refreshSkills) Core.skills.refreshSkills();
          } else {
            btn.textContent = '安装失败';
            btn.style.background = '#ef4444';
            btn.style.opacity = '1';
            console.error('市场安装失败:', result.error);
          }
        } catch (err) {
          btn.textContent = '出错';
          btn.style.background = '#ef4444';
          console.error('市场安装异常:', err);
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<div style="color:#ef4444;font-size:13px;text-align:center;padding:16px 0;">加载市场失败: ' + Core.sanitizeHtml(err.message) + '</div>';
  }
}
function initFavoritesPanel() {
  const refreshBtn = document.getElementById('favoritesRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', renderFavoritesList);
  }
  renderFavoritesList();
}

// ===== 技能管理面板 =====
function initSkillsPanel() {
  const refreshBtn = document.getElementById('skillsRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      if (Core.skills && Core.skills.refreshSkills) Core.skills.refreshSkills();
      renderSkillsList();
    });
  }
  const installBtn = document.getElementById('skillInstallBtn');
  const installInput = document.getElementById('skillInstallInput');
  if (installBtn && installInput) {
    installBtn.addEventListener('click', function() {
      const p = installInput.value.trim();
      if (!p) { showAlert('请输入技能目录路径'); return; }
      if (!Core.skills || !Core.skills.installSkill) { showAlert('技能模块未加载'); return; }
      const result = Core.skills.installSkill(p);
      if (result.success) {
        showToast('✅ 技能安装成功', 'success');
        installInput.value = '';
        renderSkillsList();
      } else {
        showToast('❌ 安装失败：' + (result.error || '未知错误'), 'error');
      }
    });
    installInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') installBtn.click(); });
  }
  renderSkillsList();
}

function renderSkillsList() {
  const container = document.getElementById('skillsList');
  if (!container) return;
  if (!Core.skills || !Core.skills.getAllSkills) {
    container.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">技能模块加载中...</div>';
    setTimeout(renderSkillsList, 800);
    return;
  }
  try {
    const skills = Core.skills.getAllSkills();
    const current = Core.skills.getCurrentSkill();
    if (!skills || skills.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:16px 0;">暂无技能</div>';
      return;
    }
    let html = '';
    skills.forEach(function(s) {
      const isActive = current && current.id === s.id;
      const activeStyle = isActive ? 'border-left:3px solid var(--primary);' : '';
      const activeTag = isActive ? ' <span style="color:var(--primary);font-size:11px;font-weight:600;">[激活中]</span>' : '';
      const srcTag = s.source === 'file' ? '<span style="color:#22c55e;font-size:10px;margin-left:6px;">文件</span>' : '<span style="color:#94a3b8;font-size:10px;margin-left:6px;">内置</span>';
      html += '<div style="padding:10px 12px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid var(--border);' + activeStyle + '">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
      html += '<span style="font-size:13px;color:var(--text);font-weight:500;">' + s.name + '</span>';
      html += '<span style="display:flex;align-items:center;gap:4px;">' + srcTag + activeTag + '</span>';
      html += '</div>';
      if (s.description) {
        html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">' + s.description + '</div>';
      }
      html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
      html += '<span style="font-size:11px;color:#94a3b8;">ID: ' + s.id + (s.version ? ' · v' + s.version : '') + '</span>';
      html += '<div style="display:flex;gap:4px;">';
      if (!isActive) {
        html += '<button class="skill-activate-btn" data-id="' + s.id + '" style="padding:3px 10px;background:var(--primary);border:none;border-radius:5px;color:#fff;font-size:11px;cursor:pointer;">激活</button>';
      } else {
        html += '<button class="skill-deactivate-btn" data-id="' + s.id + '" style="padding:3px 10px;background:#f59e0b;border:none;border-radius:5px;color:#fff;font-size:11px;cursor:pointer;">取消激活</button>';
      }
      if (s.source === 'file') {
        html += '<button class="skill-delete-btn" data-id="' + s.id + '" style="padding:3px 10px;background:#ef4444;border:none;border-radius:5px;color:#fff;font-size:11px;cursor:pointer;">删除</button>';
      }
      html += '</div></div></div>';
    });
    container.innerHTML = html;

    // 绑定事件
    container.querySelectorAll('.skill-activate-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        Core.skills.setSkill(btn.dataset.id);
        renderSkillsList();
      });
    });
    container.querySelectorAll('.skill-deactivate-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        Core.skills.setSkill(null);
        renderSkillsList();
      });
    });
    container.querySelectorAll('.skill-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (!confirm('确定删除技能 "' + btn.dataset.id + '" 吗？')) return;
        var result = Core.skills.removeSkill(btn.dataset.id);
        if (result.success) { renderSkillsList(); }
        else { showToast('❌ 删除失败：' + (result.error || ''), 'error'); }
      });
    });
  } catch (err) {
    container.innerHTML = '<div style="color:#ef4444;font-size:13px;text-align:center;padding:16px 0;">加载技能列表失败: ' + Core.sanitizeHtml(err.message) + '</div>';
  }
}

function renderFavoritesList() {
  const container = document.getElementById('favoritesList');
  if (!container) return;
  
  const favorites = Core.config.favorites || [];
  if (favorites.length === 0) {
    container.innerHTML = '<div style="color:var(--text-secondary); font-size:13px; text-align:center; padding:16px 0;">暂无收藏消息</div>';
    return;
  }
  
  let html = '';
  favorites.forEach((fav, index) => {
    const role = fav.role === 'user' ? '👤 用户' : '🤖 AI';
    const date = fav.timestamp ? new Date(fav.timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    html += '<div style="padding:8px 12px; margin-bottom:6px; background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid var(--border);">';
    html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">';
    html += '<span style="font-size:11px; color:var(--primary);">' + role + '</span>';
    html += '<span style="font-size:11px; color:#94a3b8;">' + date + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px; color:var(--text); line-height:1.5; margin-bottom:6px; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;">' + (fav.content || '').substring(0, 200) + '</div>';
    html += '<div style="display:flex; justify-content:space-between; align-items:center;">';
    html += '<span style="font-size:11px; color:#94a3b8;">📄 ' + (fav.sessionTitle || '未命名会话') + '</span>';
    html += '<button class="fav-delete-btn" data-index="' + index + '" style="padding:2px 8px; background:#ef4444; border:none; border-radius:4px; color:#fff; font-size:11px; cursor:pointer;">删除</button>';
    html += '</div>';
    html += '</div>';
  });
  container.innerHTML = html;
  
  // 绑定删除事件
  container.querySelectorAll('.fav-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      if (isNaN(index)) return;
      const favorites = Core.config.favorites || [];
      if (index < 0 || index >= favorites.length) return;
      if (!confirm('确定删除这条收藏吗？')) return;
      favorites.splice(index, 1);
      Core.saveConfig({ favorites: favorites });
      renderFavoritesList();
      const status = document.getElementById('status');
      if (status) status.textContent = '❌ 收藏已删除';
      setTimeout(() => { if (status) status.textContent = '✅ 已就绪 (' + Core.getCurrentService() + ')'; }, 2000);
    });
  });
}

  // ===== 工作流自动化面板 =====
  function initWorkflowPanel() {
    // 模板
    var saveTemplateBtn = document.getElementById('saveTemplateBtn');
    if (saveTemplateBtn) {
      saveTemplateBtn.addEventListener('click', function() {
        var nameInput = document.getElementById('newTemplateName');
        var name = nameInput ? nameInput.value.trim() : '';
        if (!name) { showAlert('请输入模板名称'); return; }
        if (Core.workflow && Core.workflow.templates.saveCurrent) {
          var result = Core.workflow.templates.saveCurrent(name);
          if (result.success) {
            nameInput.value = '';
            renderTemplateList();
          } else {
            showToast('保存失败: ' + result.error, 'error');
          }
        }
      });
    }
    renderTemplateList();

    // 规则
    var addRuleBtn = document.getElementById('addRuleBtn');
    if (addRuleBtn) {
      addRuleBtn.addEventListener('click', function() {
        var nameEl = document.getElementById('newRuleName');
        var kwEl = document.getElementById('newRuleKeywords');
        var respEl = document.getElementById('newRuleResponse');
        var name = nameEl ? nameEl.value.trim() : '';
        var keywords = kwEl ? kwEl.value.trim() : '';
        var response = respEl ? respEl.value.trim() : '';
        if (!name || !keywords || !response) { showAlert('请填写完整'); return; }
        if (Core.workflow && Core.workflow.rules.add) {
          Core.workflow.rules.add({
            name: name,
            trigger: { type: 'keyword', pattern: keywords },
            action: { type: 'reply', response: response }
          });
          nameEl.value = ''; kwEl.value = ''; respEl.value = '';
          renderRuleList();
        }
      });
    }
    renderRuleList();

    // 定时任务
    var addTaskBtn = document.getElementById('addTaskBtn');
    if (addTaskBtn) {
      addTaskBtn.addEventListener('click', function() {
        var nameEl = document.getElementById('newTaskName');
        var typeEl = document.getElementById('newTaskScheduleType');
        var timeEl = document.getElementById('newTaskTime');
        var actionEl = document.getElementById('newTaskAction');
        var name = nameEl ? nameEl.value.trim() : '';
        var sType = typeEl ? typeEl.value : 'once';
        var time = timeEl ? timeEl.value.trim() : '';
        var action = actionEl ? actionEl.value.trim() : '';
        if (!name || !time) { showAlert('请填写任务名称和时间'); return; }
        var schedule = {};
        if (sType === 'interval') schedule = { type: 'interval', interval: time };
        else if (sType === 'daily') schedule = { type: 'daily', time: time };
        else if (sType === 'weekly') {
          // 格式: "1 09:00" (周几 时间)
          var wParts = time.split(/\s+/);
          var dayNum = parseInt(wParts[0]) || 1;
          var wTime = wParts[1] || '09:00';
          schedule = { type: 'weekly', time: wTime, dayOfWeek: dayNum };
        }
        else if (sType === 'cron') schedule = { type: 'cron', cron: time };
        else schedule = { type: 'once', delay: time };
        var actionObj = {};
        if (action === 'summary' || action === '摘要') actionObj = { type: 'summarize' };
        else actionObj = { type: 'prompt', message: action || name };
        if (Core.scheduler && Core.scheduler.add) {
          Core.scheduler.add({ name: name, schedule: schedule, action: actionObj });
          nameEl.value = ''; timeEl.value = ''; actionEl.value = '';
          renderScheduleList();
        }
      });
    }
    renderScheduleList();
  }

  function renderTemplateList() {
    var container = document.getElementById('templateList');
    if (!container) return;
    container.innerHTML = '';
    var list = (Core.workflow && Core.workflow.templates.list) ? Core.workflow.templates.list() : [];
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:4px;">暂无模板</div>';
      return;
    }
    list.forEach(function(tpl) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--border);';
      row.innerHTML = '<span class="material-icons-outlined" style="font-size:16px;color:var(--primary);">description</span>'
        + '<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (tpl.name || '') + '</span>'
        + '<span style="font-size:11px;color:var(--text-secondary);">' + (tpl.roleType || '') + '</span>';
      var useBtn = document.createElement('button');
      useBtn.textContent = '使用';
      useBtn.style.cssText = 'padding:2px 10px;border:none;border-radius:6px;background:var(--primary);color:#fff;cursor:pointer;font-size:12px;';
      useBtn.onclick = function() {
        if (Core.workflow && Core.workflow.templates.use) {
          Core.workflow.templates.use(tpl.id);
        }
      };
      var delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:12px;';
      delBtn.onclick = function() {
        if (confirm('删除模板 "' + tpl.name + '"？')) {
          if (Core.workflow && Core.workflow.templates.delete) {
            Core.workflow.templates.delete(tpl.id);
            renderTemplateList();
          }
        }
      };
      row.appendChild(useBtn);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }

  function renderRuleList() {
    var container = document.getElementById('ruleList');
    if (!container) return;
    container.innerHTML = '';
    var list = (Core.workflow && Core.workflow.rules.list) ? Core.workflow.rules.list() : [];
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:4px;">暂无规则</div>';
      return;
    }
    list.forEach(function(rule) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--border);';
      var status = rule.enabled ? '✅' : '⏸';
      row.innerHTML = '<span style="font-size:14px;">' + status + '</span>'
        + '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        + '<b>' + (rule.name || '') + '</b> [' + (rule.trigger.pattern || '').substring(0, 30) + '] → ' + (rule.action.response || '').substring(0, 40) + '</span>';
      var toggleBtn = document.createElement('button');
      toggleBtn.textContent = rule.enabled ? '禁用' : '启用';
      toggleBtn.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:' + (rule.enabled ? '#f59e0b' : '#22c55e') + ';color:#fff;cursor:pointer;font-size:12px;';
      toggleBtn.onclick = function() {
        if (Core.workflow && Core.workflow.rules.update) {
          Core.workflow.rules.update(rule.id, { enabled: !rule.enabled });
          renderRuleList();
        }
      };
      var delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:12px;';
      delBtn.onclick = function() {
        if (confirm('删除规则 "' + rule.name + '"？')) {
          if (Core.workflow && Core.workflow.rules.delete) {
            Core.workflow.rules.delete(rule.id);
            renderRuleList();
          }
        }
      };
      row.appendChild(toggleBtn);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }

  function renderScheduleList() {
    var container = document.getElementById('scheduleList');
    if (!container) return;
    container.innerHTML = '';
    var list = (Core.scheduler && Core.scheduler.list) ? Core.scheduler.list() : [];
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:4px;">暂无定时任务</div>';
      return;
    }
    list.forEach(function(task) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--border);';
      var status = task.enabled ? '▶' : '⏸';
      var schedDesc = '';
      if (task.schedule.type === 'interval') schedDesc = '每' + task.schedule.interval;
      else if (task.schedule.type === 'daily') schedDesc = '每天 ' + task.schedule.time;
      else if (task.schedule.type === 'weekly') {
        var dayNames = ['日','一','二','三','四','五','六'];
        schedDesc = '每周' + dayNames[task.schedule.dayOfWeek] + ' ' + task.schedule.time;
      }
      else if (task.schedule.type === 'cron') schedDesc = 'Cron ' + task.schedule.cron;
      else schedDesc = '一次性 ' + (task.schedule.delay || '');
      var nextRun = task.nextRun ? new Date(task.nextRun).toLocaleTimeString('zh-CN') : '-';
      row.innerHTML = '<span style="font-size:14px;">' + status + '</span>'
        + '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        + '<b>' + (task.name || '') + '</b> [' + schedDesc + '] 下次:' + nextRun + ' (' + (task.runCount || 0) + '次)</span>';
      var runBtn = document.createElement('button');
      runBtn.textContent = '执行';
      runBtn.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:var(--primary);color:#fff;cursor:pointer;font-size:12px;';
      runBtn.onclick = function() {
        if (Core.scheduler && Core.scheduler.runNow) Core.scheduler.runNow(task.id);
      };
      var delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:12px;';
      delBtn.onclick = function() {
        if (confirm('删除任务 "' + task.name + '"？')) {
          if (Core.scheduler && Core.scheduler.delete) {
            Core.scheduler.delete(task.id);
            renderScheduleList();
          }
        }
      };
      row.appendChild(runBtn);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }



  // ===== 权限控制面板 =====
  function initPermissionsPanel() {
    // 权限模式切换
    var modeSelect = document.getElementById('permissionModeSelect');
    if (modeSelect) {
      modeSelect.addEventListener('change', function() {
        if (Core.permissions && Core.permissions.setMode) {
          Core.permissions.setMode(modeSelect.value);
          var status = document.getElementById('status');
          if (status) status.textContent = modeSelect.value === 'full' ? '🔓 全权模式' : '🔒 询问模式';
          setTimeout(function() { if (status) status.textContent = '✅ 已就绪'; }, 1500);
        }
      });
    }

    // 添加允许目录
    var addDirBtn = document.getElementById('addAllowedDirBtn');
    var newDirInput = document.getElementById('newAllowedDirInput');
    if (addDirBtn && newDirInput) {
      addDirBtn.addEventListener('click', function() {
        var dirPath = newDirInput.value.trim();
        if (!dirPath) { showAlert('请输入目录路径'); return; }
        if (Core.permissions && Core.permissions.addAllowedDir) {
          var ok = Core.permissions.addAllowedDir(dirPath);
          if (ok) {
            newDirInput.value = '';
            renderAllowedDirsList();
          } else {
            showToast('❌ 添加失败：目录不存在或已添加', 'error');
          }
        }
      });
      newDirInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') addDirBtn.click(); });
    }

    // 查看审计日志
    var viewLogBtn = document.getElementById('viewAuditLogBtn');
    if (viewLogBtn) {
      viewLogBtn.addEventListener('click', function() {
        if (!Core.permissions || !Core.permissions.getAuditLog) { showToast('权限模块未加载', 'error'); return; }
        var log = Core.permissions.getAuditLog();
        if (log.length === 0) { showAlert('审计日志为空'); return; }
        var html = '📋 最近 ' + log.length + ' 条操作记录\n\n';
        log.slice(-20).reverse().forEach(function(entry) {
          var icon = entry.result === 'success' ? '✅' : entry.result === 'denied' ? '❌' : entry.result === 'cancelled' ? '⛔' : '⚠️';
          html += icon + ' [' + (entry.time || '') + '] ' + entry.action + ' → ' + (entry.target || '').substring(0, 40) + '\n';
          if (entry.details) html += '    ' + entry.details.substring(0, 60) + '\n';
        });
        showAlert(html);
      });
    }

    // 清空审计日志
    var clearLogBtn = document.getElementById('clearAuditLogBtn');
    if (clearLogBtn) {
      clearLogBtn.addEventListener('click', function() {
        if (!confirm('确定清空所有审计日志？')) return;
        if (Core.permissions && Core.permissions.clearAuditLog) {
          Core.permissions.clearAuditLog();
          renderAuditStats();
        }
      });
    }

    // 初始渲染
    renderAllowedDirsList();
    renderAuditStats();
  }

  function renderAllowedDirsList() {
    var container = document.getElementById('allowedDirsList');
    if (!container) return;
    if (!Core.permissions || !Core.permissions.getAllowedDirs) {
      container.innerHTML = '<span style="color:#94a3b8;">权限模块加载中...</span>';
      return;
    }
    var dirs = Core.permissions.getAllowedDirs();
    if (dirs.length === 0) {
      container.innerHTML = '<span style="color:#94a3b8;">暂无自定义目录（默认目录始终生效）</span>';
      return;
    }
    var html = '';
    dirs.forEach(function(dir) {
      html += '<div style="display:flex; align-items:center; justify-content:space-between; padding:3px 8px; margin-bottom:3px; background:rgba(255,255,255,0.03); border-radius:6px;">';
      html += '<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px;" title="' + dir + '">' + dir + '</span>';
      html += '<button class="allowed-dir-remove-btn" data-dir="' + dir + '" style="padding:1px 6px; background:rgba(239,68,68,0.2); border:none; border-radius:4px; color:#ef4444; font-size:10px; cursor:pointer; margin-left:6px;">移除</button>';
      html += '</div>';
    });
    container.innerHTML = html;

    // 绑定移除按钮
    container.querySelectorAll('.allowed-dir-remove-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var dir = btn.getAttribute('data-dir');
        if (!dir) return;
        if (Core.permissions && Core.permissions.removeAllowedDir) {
          Core.permissions.removeAllowedDir(dir);
          renderAllowedDirsList();
        }
      });
    });
  }

  function renderAuditStats() {
    var container = document.getElementById('auditLogStats');
    if (!container) return;
    if (!Core.permissions || !Core.permissions.getAuditStats) {
      container.textContent = '权限模块未加载';
      return;
    }
    var stats = Core.permissions.getAuditStats();
    container.innerHTML = '总计 <b>' + stats.total + '</b> 条 | '
      + '<span style="color:#22c55e;">成功 ' + stats.success + '</span> | '
      + '<span style="color:#ef4444;">拒绝 ' + stats.denied + '</span> | '
      + '<span style="color:#f59e0b;">取消 ' + stats.cancelled + '</span>';
  }

  // ===== 高级定制面板 =====
  function initCustomizerPanel() {
    // 主题
    renderThemeList();
    var createThemeBtn = document.getElementById('createThemeBtn');
    if (createThemeBtn) {
      createThemeBtn.addEventListener('click', function() {
        var nameInput = document.getElementById('newThemeName');
        var name = nameInput ? nameInput.value.trim() : '';
        if (!name) { showAlert('请输入主题名称'); return; }
        if (Core.customizer && Core.customizer.themes.create) {
          Core.customizer.themes.create(name);
          nameInput.value = '';
          renderThemeList();
        }
      });
    }

    // 快捷键
    renderKeybindList();
    var resetBtn = document.getElementById('resetKeybindsBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        if (confirm('确定恢复所有快捷键为默认设置？')) {
          if (Core.customizer && Core.customizer.keybindings.reset) {
            Core.customizer.keybindings.reset();
            renderKeybindList();
          }
        }
      });
    }

    // 工具栏
    renderToolbarList();

    // 钩子
    renderHookList();
    var addHookBtn = document.getElementById('addHookBtn');
    if (addHookBtn) {
      addHookBtn.addEventListener('click', function() {
        var nameEl = document.getElementById('newHookName');
        var eventEl = document.getElementById('newHookEvent');
        var scriptEl = document.getElementById('newHookScript');
        var name = nameEl ? nameEl.value.trim() : '';
        var event = eventEl ? eventEl.value : 'onInit';
        var script = scriptEl ? scriptEl.value.trim() : '';
        if (!name || !script) { showAlert('请填写名称和脚本'); return; }
        if (Core.customizer && Core.customizer.hooks.add) {
          Core.customizer.hooks.add({ name: name, event: event, script: script });
          nameEl.value = ''; scriptEl.value = '';
          renderHookList();
        }
      });
    }
  }

  function renderThemeList() {
    var container = document.getElementById('themeList');
    if (!container || !Core.customizer) return;
    container.innerHTML = '';
    var list = Core.customizer.themes.list();
    var activeId = Core.customizer.themes.getActive();
    list.forEach(function(theme) {
      var btn = document.createElement('button');
      var isActive = theme.id === activeId;
      btn.textContent = theme.name + (theme.isBuiltin ? '' : ' ✎');
      btn.style.cssText = 'padding:6px 14px;border:' + (isActive ? '2px solid var(--primary)' : '1px solid var(--border)') +
        ';border-radius:8px;background:' + (isActive ? 'var(--primary-light,rgba(59,130,246,0.15))' : 'var(--bg)') +
        ';color:var(--text);cursor:pointer;font-size:12px;font-weight:' + (isActive ? '600' : '400') + ';';
      btn.onclick = function() {
        Core.customizer.themes.apply(theme.id);
        renderThemeList();
      };
      container.appendChild(btn);
    });
  }

  function renderKeybindList() {
    var container = document.getElementById('keybindList');
    if (!container || !Core.customizer) return;
    container.innerHTML = '';
    var list = Core.customizer.keybindings.list();
    list.forEach(function(kb) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--border);';
      var mods = [];
      if (kb.ctrl) mods.push('Ctrl');
      if (kb.shift) mods.push('Shift');
      mods.push(kb.key);
      row.innerHTML = '<span style="flex:1;font-size:12px;">' + kb.desc + '</span>'
        + '<input type="text" value="' + mods.join('+') + '" data-action="' + kb.id + '" '
        + 'style="width:140px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px;text-align:center;" '
        + 'placeholder="输入快捷键">';
      var input = row.querySelector('input');
      input.addEventListener('keydown', function(e) {
        e.preventDefault();
        var parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (!['Control','Shift','Alt','Meta'].includes(e.key)) parts.push(key);
        input.value = parts.join('+');
      });
      input.addEventListener('change', function() {
        var actionId = input.getAttribute('data-action');
        var parts = input.value.split('+').map(function(p) { return p.trim(); });
        var key = parts[parts.length - 1] || '';
        var ctrl = parts.indexOf('Ctrl') >= 0;
        var shift = parts.indexOf('Shift') >= 0;
        var result = Core.customizer.keybindings.update(actionId, { key: key, ctrl: ctrl, shift: shift, desc: kb.desc });
        if (!result.success) {
          showToast(result.error, 'error');
          renderKeybindList();
        }
      });
      container.appendChild(row);
    });
  }

  function renderToolbarList() {
    var container = document.getElementById('toolbarList');
    if (!container || !Core.customizer) return;
    container.innerHTML = '';
    var layout = Core.customizer.toolbar.get();
    var allBtns = layout.left.concat(layout.right);
    var btnNames = {
      appsMenuBtn: '应用菜单', webSearchBtn: '联网搜索', deepThinkBtn: '深度思考',
      streamBtn: '流式输出', agentModeBtn: 'Agent模式', voiceBtn: '语音输入', speakBtn: '朗读回复',
      imageBtn: '上传图片', screenshotBtn: '截图分析', promptBtn: '提示词库', roleBtn: '角色切换'
    };
    allBtns.forEach(function(btnId) {
      var isHidden = layout.hidden.includes(btnId);
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--border);cursor:pointer;font-size:12px;';
      label.innerHTML = '<input type="checkbox" ' + (isHidden ? '' : 'checked') + ' data-btn="' + btnId + '"> ' + (btnNames[btnId] || btnId);
      var checkbox = label.querySelector('input');
      checkbox.addEventListener('change', function() {
        Core.customizer.toolbar.toggle(btnId);
      });
      container.appendChild(label);
    });
  }

  function renderHookList() {
    var container = document.getElementById('hookList');
    if (!container || !Core.customizer) return;
    container.innerHTML = '';
    var list = Core.customizer.hooks.list();
    if (list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:4px;">暂无钩子</div>';
      return;
    }
    list.forEach(function(hook) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--border);';
      var status = hook.enabled ? '✅' : '⏸';
      row.innerHTML = '<span style="font-size:14px;">' + status + '</span>'
        + '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
        + '<b>' + hook.name + '</b> [' + hook.event + '] ' + (hook.script || '').substring(0, 50) + '</span>';
      var delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:6px;background:#ef4444;color:#fff;cursor:pointer;font-size:12px;';
      delBtn.onclick = function() {
        if (confirm('删除钩子 "' + hook.name + '"？')) {
          Core.customizer.hooks.delete(hook.id);
          renderHookList();
        }
      };
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }

// ===== 主题模式切换 =====
function _applyThemeMode(mode, _skipCSS) {
  var root = document.documentElement;
  var body = document.body;

  if (mode === 'system') {
    var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    mode = isDark ? 'dark' : 'light';
  }

  if (mode === 'light') {
    body.classList.add('light-theme');
    body.classList.remove('dark-theme');
    if (!_skipCSS) {
      if (Core.customizer && Core.customizer.themes && Core.customizer.themes.apply) {
        Core.customizer.themes.apply('light-default');
      } else {
        _setLightThemeVars(root);
      }
    }
  } else {
    body.classList.remove('light-theme');
    body.classList.add('dark-theme');
    if (!_skipCSS) {
      if (Core.customizer && Core.customizer.themes && Core.customizer.themes.apply) {
        Core.customizer.themes.apply('dark-default');
      } else {
        _setDarkThemeVars(root);
      }
    }
  }

  // Sync code highlighter theme
  if (Core.syncCodeHighlighter) {
    Core.syncCodeHighlighter(mode === 'dark');
  }
}

function _setLightThemeVars(root) {
  root.style.setProperty('--bg', '#f8fafc');
  root.style.setProperty('--bg-secondary', '#f1f5f9');
  root.style.setProperty('--panel', '#ffffff');
  root.style.setProperty('--text', '#1e293b');
  root.style.setProperty('--text-secondary', '#64748b');
  root.style.setProperty('--border', '#e2e8f0');
  root.style.setProperty('--primary', '#2563eb');
  root.style.setProperty('--primary-hover', '#1d4ed8');
  root.style.setProperty('--shadow', '0 4px 24px rgba(0,0,0,0.08)');
}

function _setDarkThemeVars(root) {
  root.style.setProperty('--bg', '#0d0d0d');
  root.style.setProperty('--bg-secondary', '#1a1a1a');
  root.style.setProperty('--panel', '#141414');
  root.style.setProperty('--text', '#e8e8e8');
  root.style.setProperty('--text-secondary', '#9ca3af');
  root.style.setProperty('--border', '#2a2a2a');
  root.style.setProperty('--primary', '#3b82f6');
  root.style.setProperty('--primary-hover', '#2563eb');
  root.style.setProperty('--shadow', '0 4px 24px rgba(0,0,0,0.4)');
}

// 将 config 中的颜色值填充到 DOM 输入框（如果输入框存在）
function _loadColorInputs() {
  var c = Core.config || {};
  var map = {
    sidebarColorInput: c.sidebarColor || '#141414',
    panelColorInput: c.panelColor || '#141414',
    accentColorInput: c.accentColor || '#3b82f6',
    textColorInput: c.textColor || '#e8e8e8',
  };
  Object.keys(map).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = map[id];
  });
}

function _applyCustomColors(skipSave) {
  var root = document.documentElement;
  var c = Core.config || {};
  // 优先读 DOM 输入框（用户正在拖动色盘时取实时值），否则回退到 config
  var sidebar = document.getElementById('sidebarColorInput');
  var panel = document.getElementById('panelColorInput');
  var accent = document.getElementById('accentColorInput');
  var textColor = document.getElementById('textColorInput');

  var sidebarVal = (sidebar && sidebar.value) || c.sidebarColor || '#141414';
  var panelVal = (panel && panel.value) || c.panelColor || '#141414';
  var accentVal = (accent && accent.value) || c.accentColor || '#3b82f6';
  var textVal = (textColor && textColor.value) || c.textColor || '#e8e8e8';

  root.style.setProperty('--sidebar-bg', sidebarVal);
  root.style.setProperty('--panel', panelVal);
  root.style.setProperty('--primary', accentVal);
  root.style.setProperty('--text', textVal);

  // skipSave=true 时只更新 CSS（颜色拖动期间的实时预览），不触发 saveConfig/configChanged 级联
  if (!skipSave) {
    Core.saveConfig({
      sidebarColor: sidebarVal,
      panelColor: panelVal,
      accentColor: accentVal,
      textColor: textVal,
    });
  }
}

module.exports = {
  name: 'settings',
  dependencies: ['knowledge'],

  init(_Core) {

    Core = _Core;
    // 设置面板打开/关闭事件（添加空检查）
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', openSettings);
    } else {
      console.warn('⚠️ openSettingsBtn 不存在，设置面板无法打开');
    }
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    if (closeSettingsBtn) {
      closeSettingsBtn.addEventListener('click', closeSettings);
    }
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettings();
      });
    }
    const saveBtn = document.getElementById('saveSettingsBtn');
    if (saveBtn) {
      saveBtn.removeEventListener('click', saveSettings);
      saveBtn.addEventListener('click', saveSettings);
    }

    // 备份恢复 — 使用 querySelectorAll 确保所有备份/恢复按钮都绑定
    var backupBtns = document.querySelectorAll('#backupBtn');
    backupBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (Core.backup && typeof Core.backup.backupData === 'function') Core.backup.backupData();
        else showToast('❌ 备份模块未加载', 'error');
      });
    });
    // 工具栏备份按钮也绑定
    var toolbarBackupBtn = document.getElementById('toolbarBackupBtn');
    if (toolbarBackupBtn) {
      toolbarBackupBtn.addEventListener('click', function() {
        if (Core.backup && typeof Core.backup.backupData === 'function') Core.backup.backupData();
        else showToast('❌ 备份模块未加载', 'error');
      });
    }
    var restoreBtn = document.getElementById('restoreBtn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function() {
        if (Core.backup && typeof Core.backup.restoreData === 'function') Core.backup.restoreData();
        else showToast('❌ 备份模块未加载', 'error');
      });
    }

    // 模型管理
    document.getElementById('modelDownloadBtn')?.addEventListener('click', downloadModel);
    document.getElementById('modelDownloadInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') downloadModel();
    });

    // 角色预设切换
    document.getElementById('rolePresetSelect')?.addEventListener('change', (e) => {
      applyRolePreset(e.target.value);
    });

    // 搜索引擎切换
    document.getElementById('searchEngineSelect')?.addEventListener('change', toggleKeyInputsVisibility);

    // ===== 界面主题切换 =====
    var themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      // 加载当前主题到下拉框
      var savedMode = Core.config.themeMode || 'dark';
      themeSelect.value = savedMode;
      themeSelect.addEventListener('change', function() {
        var mode = themeSelect.value;
        Core.saveConfig({ themeMode: mode });
        _applyThemeMode(mode);
        // 主题切换会重置 :root CSS 变量，需重新填充自定义颜色
        _loadColorInputs();
        _applyCustomColors();
      });
    }

    // ===== 自定义颜色：input 仅更新 CSS（实时预览），change 持久化到 config =====
    var colorPickers = ['sidebarColorInput', 'panelColorInput', 'accentColorInput', 'textColorInput'];
    colorPickers.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', function() { _applyCustomColors(true); });   // 实时预览，不触发 saveConfig
        el.addEventListener('change', function() { _applyCustomColors(false); }); // 松手后持久化
      }
    });

    // ===== 知识库管理 =====
    initKnowledgePanel();
    
    // ===== 收藏夹 =====
    initFavoritesPanel();

    // ===== 插件管理 =====
    initPluginsPanel();
  initMarketplacePanel();

    // ===== 启动时应用保存的主题模式和自定义颜色 =====
    _loadColorInputs(); // 先将 config 颜色值写入 DOM 输入框
    _applyThemeMode(Core.config.themeMode || 'dark', true); // skipCSS: customizer.init 已设置 CSS 变量
    _applyCustomColors(true); // skipSave: 启动时只应用 CSS，不触发 saveConfig/configChanged 级联

    // ===== 技能管理 =====
    initSkillsPanel();
    initWorkflowPanel();
    initPermissionsPanel();
    initCustomizerPanel();

    Core.on('configChanged', () => {
      if (document.getElementById('settingsModal').classList.contains('show')) {
        loadSettingsToUI();
        renderAllowedDirsList();
        renderAuditStats();
      }
    });
    console.log('✅ 设置管理模块已加载');
  },
  loadSettings: openSettings,
  saveSettings: saveSettings,
  refreshModelList,
  downloadModel,
};