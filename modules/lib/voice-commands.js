// modules/lib/voice-commands.js
// 语音命令识别 & 设置面板（从 voice.js Phase 3-2 提取）
// 由 voice.js init() 调用，将所有命令/设置方法挂载到 voice 对象上。

module.exports = function(ctx) {
  var Core = ctx.Core;
  var voice = ctx.voice;

  // ================================================================
  //  Phase 3-2：语音增强
  // ================================================================

  // ===== 自动朗读设置 =====
  voice.autoReadEnabled = false;
  voice.voiceProfile = 'default';
  voice.voiceProfiles = {
    default: { speed: 1.0, pitch: 1.0, volume: 1.0, voiceName: null },
    fast:    { speed: 1.4, pitch: 1.0, volume: 1.0, voiceName: null },
    slow:    { speed: 0.8, pitch: 1.0, volume: 1.0, voiceName: null },
    warm:    { speed: 1.0, pitch: 0.9, volume: 0.9, voiceName: null },
    bright:  { speed: 1.1, pitch: 1.2, volume: 1.0, voiceName: null },
  };

  // ===== 自动朗读 AI 回复 =====
  voice.autoSpeakReply = function(text) {
    if (!this.autoReadEnabled) return;
    if (!text || text.length < 5) return;
    // 清理 markdown 和代码块（朗读时不需要）
    var cleanText = text.replace(/```[\s\S]*?```/g, '（代码块已省略）')
                       .replace(/`[^`]+`/g, function(m) { return m.slice(1, -1); })
                       .replace(/!\[.*?\]\(.*?\)/g, '（图片）')
                       .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
                       .replace(/[*_~#>]/g, '')
                       .replace(/\n{3,}/g, '\n\n');
    // 截断过长文本
    if (cleanText.length > 2000) cleanText = cleanText.substring(0, 2000) + '。朗读内容较长，已截断。';
    var profile = this.voiceProfiles[this.voiceProfile] || this.voiceProfiles.default;
    this.speak(cleanText, {
      speed: profile.speed,
      rate: profile.speed,
      pitch: profile.pitch,
      volume: profile.volume,
      voice: profile.voiceName || 'default'
    });
  };

  // ===== 切换自动朗读 =====
  voice.toggleAutoRead = function() {
    this.autoReadEnabled = !this.autoReadEnabled;
    if (!this.autoReadEnabled) this.stopSpeaking();
    console.log('🔊 自动朗读:', this.autoReadEnabled ? '开启' : '关闭');
    return this.autoReadEnabled;
  };

  // ===== 语音命令识别（从 ASR 文本中检测命令）=====
  voice.processVoiceCommand = function(text) {
    if (!text) return null;
    var lower = text.trim().toLowerCase();
    // 朗读命令
    if (/^(朗读|读一下|念一下|读出来|念出来|大声读)/.test(lower)) {
      return { command: 'speak_last', action: function() {
        var msgs = Core.dom.chatContainer ? Core.dom.chatContainer.querySelectorAll('.msg.ai') : [];
        if (msgs.length > 0) {
          var lastMsg = msgs[msgs.length - 1];
          // 提取纯文本（与 session.js 朗读按钮相同逻辑：排除图标连字、时间戳、按钮等）
          var source = lastMsg.querySelector('.agent-content') || lastMsg;
          var clone = source.cloneNode(true);
          var rm = clone.querySelectorAll('.msg-timestamp, .msg-actions-inline, .msg-actions, .quick-actions, .msg-hover-actions, .tts-btn, .copy-code-btn, .fold-code-btn, .agent-think-panel, .agent-steps-live, .agent-status-row, .thinking-process, pre');
          rm.forEach(function(el) { el.remove(); });
          var text = clone.textContent.replace(/\s+/g, ' ').trim();
          if (text.length > 2000) text = text.substring(0, 2000) + '...';
          if (text) voice.autoSpeakReply(text);
        }
      }};
    }
    // 停止朗读
    if (/^(停止朗读|停下|别念了|闭嘴|停止|静音)/.test(lower)) {
      return { command: 'stop_speak', action: function() { voice.stopSpeaking(); } };
    }
    // 切换音色
    var profileMatch = lower.match(/(?:切换|换成|用)(.+)(?:音色|声音|语调)/);
    if (profileMatch) {
      var profileName = profileMatch[1].trim();
      var profileMap = { '默认': 'default', '快速': 'fast', '慢速': 'slow', '温暖': 'warm', '明亮': 'bright' };
      var target = profileMap[profileName] || profileName;
      if (voice.voiceProfiles[target]) {
        return { command: 'set_profile', profile: target, action: function() { voice.setVoiceProfile(target); } };
      }
    }
    // 语速调整
    if (/^(快一点|说快点|加速)/.test(lower)) {
      return { command: 'speed_up', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
        if (p) { p.speed = Math.min(p.speed + 0.2, 2.0); }
      }};
    }
    if (/^(慢一点|说慢点|减速)/.test(lower)) {
      return { command: 'slow_down', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
        if (p) { p.speed = Math.max(p.speed - 0.2, 0.5); }
      }};
    }
    // 音量调整
    if (/^(大声点|声音大点)/.test(lower)) {
      return { command: 'volume_up', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
      }};
    }
    if (/^(小声点|声音小点|轻一点)/.test(lower)) {
      return { command: 'volume_down', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
      }};
    }
    // 开关自动朗读
    if (/^(开启|打开|启用)(自动朗读|自动播放|自动读)/.test(lower)) {
      return { command: 'auto_on', action: function() { voice.autoReadEnabled = true; } };
    }
    if (/^(关闭|关掉|禁用)(自动朗读|自动播放|自动读)/.test(lower)) {
      return { command: 'auto_off', action: function() { voice.autoReadEnabled = false; voice.stopSpeaking(); } };
    }
    return null; // 不是语音命令
  };

  // ===== 设置音色配置 =====
  voice.setVoiceProfile = function(name) {
    if (!this.voiceProfiles[name]) {
      console.warn('⚠️ 未知音色:', name, '可用:', Object.keys(this.voiceProfiles).join(', '));
      return false;
    }
    this.voiceProfile = name;
    // 🔧 持久化：写入配置（修复此前仅内存修改、重启丢失的问题）
    if (Core && Core.saveConfig) Core.saveConfig({ voiceProfile: name });
    else if (Core && Core.config) Core.config.voiceProfile = name;
    return true;
  };

  // ===== 设置 VoxCPM2 克隆音色 =====
  voice.setVoxcpmVoice = function(name) {
    this.voxcpmVoice = name || 'default';
    if (Core && Core.saveConfig) Core.saveConfig({ voxcpmVoice: this.voxcpmVoice });
    else if (Core && Core.config) Core.config.voxcpmVoice = this.voxcpmVoice;
    console.log('🎙️ VoxCPM 音色切换为:', this.voxcpmVoice);
    if (typeof this.renderVoicePanel === 'function') this.renderVoicePanel();
    return true;
  };

  // ===== 设置自动朗读（持久化）=====
  voice.setAutoRead = function(on) {
    this.autoReadEnabled = !!on;
    if (!this.autoReadEnabled && this.stopSpeaking) this.stopSpeaking();
    if (Core && Core.saveConfig) Core.saveConfig({ autoRead: this.autoReadEnabled });
    console.log('🔊 自动朗读:', this.autoReadEnabled ? '开启' : '关闭');
    return this.autoReadEnabled;
  };

  // ===== 获取可用音色列表 =====
  voice.getVoiceProfiles = function() {
    var profiles = [];
    var profileDescs = {
      default: '默认 — 标准语速语调',
      fast: '快速 — 适合速听',
      slow: '慢速 — 清晰易懂',
      warm: '温暖 — 低沉柔和',
      bright: '明亮 — 高亢活泼'
    };
    for (var name in this.voiceProfiles) {
      profiles.push({
        name: name,
        description: profileDescs[name] || name,
        active: name === this.voiceProfile,
        config: this.voiceProfiles[name]
      });
    }
    return profiles;
  };

  // ===== 流式朗读（用于流式回复，分段朗读）=====
  voice._streamBuffer = '';
  voice._streamReading = false;

  voice.streamAppend = function(chunk) {
    if (!this.autoReadEnabled) return;
    this._streamBuffer += chunk;
    // 当缓冲区包含句子结束符且未在朗读中时，开始朗读
    if (!this._streamReading && /[。！？\n.!?]/.test(this._streamBuffer) && this._streamBuffer.length > 20) {
      this._flushStreamBuffer();
    }
  };

  voice._flushStreamBuffer = function() {
    if (!this._streamBuffer) return;
    this._streamReading = true;
    var text = this._streamBuffer;
    this._streamBuffer = '';
    // 按句子切分，保留最后一个不完整的句子
    var sentences = text.match(/[^。！？\n.!?]+[。！？\n.!?]/g);
    if (sentences && sentences.length > 0) {
      var remainder = text.substring(sentences.join('').length);
      this._streamBuffer = remainder; // 不完整的部分留到下次
      var readText = sentences.join('');
      // 清理 markdown
      readText = readText.replace(/```[\s\S]*?```/g, '').replace(/[*_~#>]/g, '').trim();
      if (readText.length > 5) {
        var profile = this.voiceProfiles[this.voiceProfile] || this.voiceProfiles.default;
        this.speak(readText, { speed: profile.speed, rate: profile.speed, pitch: profile.pitch, volume: profile.volume });
      }
    }
    this._streamReading = false;
  };

  voice.streamEnd = function() {
    // 流结束时朗读剩余缓冲
    if (this._streamBuffer) {
      this._flushStreamBuffer();
      this._streamBuffer = '';
    }
  };

  // 预加载浏览器语音列表（某些浏览器需要异步加载）
  if (voice.isSpeechSynthesisSupported()) {
    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = function() {
      };
    }
  }

  // ================================================================
  //  音色管理面板（侧边栏 GUI）
  // ================================================================

  // HTML 转义（面板渲染防注入）
  voice._escHtml = function(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  voice._escAttr = function(s) {
    return voice._escHtml(s).replace(/"/g, '&quot;');
  };

  // 渲染音色面板（每次打开/切换时调用，仅重建 innerHTML）
  voice.renderVoicePanel = async function() {
    var container = document.getElementById('voicePanelList');
    if (!container) return;

    var currentVox = (Core && Core.config && Core.config.voxcpmVoice) || this.voxcpmVoice || 'default';
    var currentProfile = (Core && Core.config && Core.config.voiceProfile) || this.voiceProfile || 'default';
    var autoRead = !!(Core && Core.config && Core.config.autoRead);

    // 拉取 VoxCPM 音色列表（含克隆音色）
    var voxVoices = [{ name: 'default', description: '默认音色（模型自带，无需参考音频）' }];
    var svcOnline = false;
    try {
      var resp = await fetch('http://127.0.0.1:8080/api/tts-voxcpm/voices', { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        var data = await resp.json();
        if (data && data.voices && data.voices.length) voxVoices = data.voices;
        svcOnline = true;
      }
    } catch (e) { /* 服务离线，沿用默认音色 */ }

    var html = '';

    // 服务状态条
    html += '<div class="voice-svc-status ' + (svcOnline ? 'online' : 'offline') + '">'
      + '<span class="material-icons-outlined">' + (svcOnline ? 'check_circle' : 'error_outline') + '</span>'
      + (svcOnline ? 'VoxCPM2 本地语音服务在线 · 48kHz 高保真' : 'VoxCPM2 服务离线 · 启动后克隆音色自动生效')
      + '</div>';

    // 分区 1：音色（VoxCPM2 克隆）
    html += '<label class="settings-group-title">音色</label>'
      + '<div class="description-text">点击选择朗读音色，▶ 可试听。克隆音色基于参考音频零样本生成。</div>'
      + '<div class="voice-card-list">';
    for (var i = 0; i < voxVoices.length; i++) {
      var v = voxVoices[i];
      var active = v.name === currentVox;
      html += '<div class="voice-card' + (active ? ' active' : '') + '" data-voice="' + this._escAttr(v.name) + '">'
        + '<span class="material-icons-outlined voice-card-icon">' + (v.name === 'default' ? 'smart_toy' : 'record_voice_over') + '</span>'
        + '<div class="voice-card-info">'
        +   '<div class="voice-card-name">' + this._escHtml(v.name) + (active ? ' <span class="voice-active-badge">当前</span>' : '') + '</div>'
        +   '<div class="voice-card-desc">' + this._escHtml(v.description || '') + '</div>'
        + '</div>'
        + '<button class="voice-preview-btn" data-voice="' + this._escAttr(v.name) + '" title="试听"><span class="material-icons-outlined">play_circle</span></button>'
        + (v.name !== 'default' ? '<button class="voice-del-btn" data-voice="' + this._escAttr(v.name) + '" title="删除"><span class="material-icons-outlined">delete_outline</span></button>' : '')
        + '</div>';
    }
    html += '</div>';
    html += '<button id="voiceUploadBtn" class="btn-primary btn-full" style="margin-top:8px;">'
      + '<span class="material-icons-outlined material-icons-inline">upload_file</span>上传参考音频 · 新建克隆音色</button>';

    // 分区：AI 音色设计（用一句自然语言描述想要的声音，按描述的风格朗读）
    var savedDesign = this.voiceDesignDesc || '';
    html += '<label class="settings-group-title" style="margin-top:16px;">AI 音色设计</label>'
      + '<div class="description-text">用一句话描述你想要的声音，AI 会按这个风格朗读（无需参考音频）。例如：温柔甜美的年轻女声、低沉有磁性的中年男声。</div>'
      + '<div class="voice-design-row">'
      +   '<input id="voiceDesignInput" class="voice-design-input" type="text" maxlength="60" '
      +     'placeholder="例如：温柔甜美的年轻女声" value="' + this._escAttr(savedDesign) + '" />'
      +   '<button id="voiceDesignPreviewBtn" class="voice-design-preview-btn" title="按描述试听"><span class="material-icons-outlined">play_circle</span></button>'
      + '</div>';

    // 分区 2：语速 / 语调预设
    html += '<label class="settings-group-title" style="margin-top:16px;">语速 / 语调</label>'
      + '<div class="voice-card-list">';
    var profiles = this.getVoiceProfiles();
    for (var j = 0; j < profiles.length; j++) {
      var p = profiles[j];
      var pActive = p.name === currentProfile;
      html += '<div class="voice-card' + (pActive ? ' active' : '') + '" data-profile="' + this._escAttr(p.name) + '">'
        + '<span class="material-icons-outlined voice-card-icon">speed</span>'
        + '<div class="voice-card-info">'
        +   '<div class="voice-card-name">' + this._escHtml(p.name) + (pActive ? ' <span class="voice-active-badge">当前</span>' : '') + '</div>'
        +   '<div class="voice-card-desc">' + this._escHtml(p.description) + '</div>'
        + '</div></div>';
    }
    html += '</div>';

    // 分区 3：自动朗读开关
    html += '<div class="voice-card" style="margin-top:16px;">'
      + '<span class="material-icons-outlined voice-card-icon">volume_up</span>'
      + '<div class="voice-card-info"><div class="voice-card-name">自动朗读 AI 回复</div>'
      + '<div class="voice-card-desc">收到回复后自动语音播报</div></div>'
      + '<label class="connector-switch"><input type="checkbox" id="voiceAutoReadToggle"' + (autoRead ? ' checked' : '') + ' /><span class="connector-slider"></span></label>'
      + '</div>';

    container.innerHTML = html;
  };

  // 试听某个音色
  voice.previewVoice = function(name) {
    var self = this;
    var sample = '你好，这是「' + (name === 'default' ? '默认' : name) + '」音色的试听效果，希望你能喜欢。';
    var profile = this.voiceProfiles[this.voiceProfile] || this.voiceProfiles.default;

    // 立即给出反馈：按钮进入加载态（生成需要数秒，避免用户以为没反应而反复点击）
    this._setPreviewLoading(name, true);

    this.speak(sample, { voice: name, speed: profile.speed, rate: profile.speed, pitch: profile.pitch, volume: profile.volume })
      .catch(function(e) { if (e && e.name !== 'AbortError') console.warn('试听失败:', e.message); })
      .then(function() { self._setPreviewLoading(name, false); });
  };

  // 切换试听按钮的加载态（旋转图标）。loading=false 时恢复为播放图标。
  voice._setPreviewLoading = function(name, loading) {
    try {
      var sel = '.voice-preview-btn[data-voice="' + this._escAttr(name) + '"]';
      var btns = document.querySelectorAll(sel);
      for (var i = 0; i < btns.length; i++) {
        var ic = btns[i].querySelector('.material-icons-outlined');
        if (loading) {
          btns[i].classList.add('preview-loading');
          if (ic) ic.textContent = 'autorenew';
        } else {
          btns[i].classList.remove('preview-loading');
          if (ic) ic.textContent = 'play_circle';
        }
      }
    } catch (e) { /* DOM 未就绪时忽略 */ }
  };

  // 按自然语言描述试听设计音色（voiceDesign → 服务端控制指令前缀）
  voice.previewVoiceDesign = function(desc) {
    desc = String(desc || '').trim();
    if (!desc) return;
    this.voiceDesignDesc = desc;
    if (Core && Core.saveConfig) Core.saveConfig({ voiceDesignDesc: desc });
    else if (Core && Core.config) Core.config.voiceDesignDesc = desc;

    var sample = '你好，这是按「' + desc + '」设计的音色试听效果，希望你能喜欢。';
    var profile = this.voiceProfiles[this.voiceProfile] || this.voiceProfiles.default;

    function setBtnLoading(loading) {
      var btn = document.getElementById('voiceDesignPreviewBtn');
      if (!btn) return;
      var ic = btn.querySelector('.material-icons-outlined');
      if (loading) { btn.classList.add('preview-loading'); if (ic) ic.textContent = 'autorenew'; }
      else { btn.classList.remove('preview-loading'); if (ic) ic.textContent = 'play_circle'; }
    }
    setBtnLoading(true);

    this.speak(sample, { voiceDesign: desc, speed: profile.speed, rate: profile.speed, pitch: profile.pitch, volume: profile.volume })
      .catch(function(e) { if (e && e.name !== 'AbortError') console.warn('音色设计试听失败:', e.message); })
      .then(function() { setBtnLoading(false); });
  };

  // 上传参考音频 → 新建克隆音色
  voice.uploadReferenceAudio = function(file) {
    if (!file) return;
    var self = this;
    var baseName = file.name.replace(/\.[^.]+$/, '');
    var name = window.prompt('为这个克隆音色命名（中文/字母/数字/-/_）：', baseName);
    if (!name) return;
    name = String(name).replace(/[^\w\u4e00-\u9fa5\-]/g, '').trim();
    if (!name) { window.alert('音色名无效'); return; }
    var ext = '.' + (file.name.split('.').pop() || 'wav').toLowerCase();
    var reader = new FileReader();
    reader.onload = function() {
      fetch('http://127.0.0.1:8080/api/tts-voxcpm/voices/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, ext: ext, dataBase64: reader.result })
      }).then(function(r) { return r.json(); }).then(function(res) {
        if (res && res.success) {
          self.setVoxcpmVoice(res.name); // 选中并刷新
        } else {
          window.alert('上传失败：' + ((res && res.error) || '未知错误'));
        }
      }).catch(function(e) { window.alert('上传失败：' + e.message); });
    };
    reader.onerror = function() { window.alert('读取音频文件失败'); };
    reader.readAsDataURL(file);
  };

  // 删除克隆音色（移入回收目录）
  voice.deleteVoice = function(name) {
    if (!name || name === 'default') return;
    var self = this;
    if (!window.confirm('删除克隆音色「' + name + '」？\n（参考音频会移入回收目录，可恢复）')) return;
    fetch('http://127.0.0.1:8080/api/tts-voxcpm/voices/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res && res.success) {
        if (self.voxcpmVoice === name) self.setVoxcpmVoice('default');
        else self.renderVoicePanel();
      } else {
        window.alert('删除失败：' + ((res && res.error) || ''));
      }
    }).catch(function(e) { window.alert('删除失败：' + e.message); });
  };

  // 面板事件委托（只绑定一次，容器元素不随 innerHTML 重建）
  voice._bindVoicePanelOnce = function() {
    if (this._panelBound) return;
    var container = document.getElementById('voicePanelList');
    if (!container) return;
    var self = this;

    container.addEventListener('click', function(e) {
      if (e.target.closest('#voiceUploadBtn')) {
        var fi = document.getElementById('voiceRefFileInput');
        if (fi) fi.click();
        return;
      }
      if (e.target.closest('#voiceDesignPreviewBtn')) {
        var di = document.getElementById('voiceDesignInput');
        var desc = di ? di.value.trim() : '';
        if (!desc) { window.alert('请先输入一句音色描述，例如：温柔甜美的年轻女声'); if (di) di.focus(); return; }
        self.previewVoiceDesign(desc);
        return;
      }
      var prevBtn = e.target.closest('.voice-preview-btn');
      if (prevBtn) { e.stopPropagation(); self.previewVoice(prevBtn.getAttribute('data-voice')); return; }
      var delBtn = e.target.closest('.voice-del-btn');
      if (delBtn) { e.stopPropagation(); self.deleteVoice(delBtn.getAttribute('data-voice')); return; }
      var card = e.target.closest('.voice-card');
      if (card) {
        if (card.getAttribute('data-voice')) self.setVoxcpmVoice(card.getAttribute('data-voice'));
        else if (card.getAttribute('data-profile')) { self.setVoiceProfile(card.getAttribute('data-profile')); self.renderVoicePanel(); }
      }
    });

    container.addEventListener('change', function(e) {
      if (e.target && e.target.id === 'voiceAutoReadToggle') {
        self.setAutoRead(e.target.checked);
      }
    });

    // 参考音频文件选择
    var fileInput = document.getElementById('voiceRefFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files[0]) self.uploadReferenceAudio(fileInput.files[0]);
        fileInput.value = ''; // 允许重复选择同一文件
      });
    }

    this._panelBound = true;
  };

  // 打开设置面板并定位到「语音」分类
  voice.openVoicePanel = function() {
    if (Core && Core.dom && Core.dom.openSettingsBtn) Core.dom.openSettingsBtn.click();
    setTimeout(function() {
      var navBtn = document.querySelector('#settingsModal .settings-nav-item[data-cat="voice"]');
      if (navBtn) navBtn.click();
      voice._bindVoicePanelOnce();
      voice.renderVoicePanel();
    }, 60);
  };

  // ===== 从配置恢复音色设置 =====
  if (Core && Core.config) {
    if (Core.config.voxcpmVoice) voice.voxcpmVoice = Core.config.voxcpmVoice;
    if (Core.config.voiceProfile && voice.voiceProfiles[Core.config.voiceProfile]) voice.voiceProfile = Core.config.voiceProfile;
    if (typeof Core.config.autoRead === 'boolean') voice.autoReadEnabled = Core.config.autoRead;
    if (Core.config.voiceDesignDesc) voice.voiceDesignDesc = Core.config.voiceDesignDesc;
  }

  // ===== 侧边栏 / 导航 UI 绑定 =====
  var openVoiceBtn = document.getElementById('openVoiceBtn');
  if (openVoiceBtn) {
    openVoiceBtn.addEventListener('click', function() { voice.openVoicePanel(); });
  }
  // 直接点设置内「语音」导航时也刷新面板
  var voiceNavItem = document.querySelector('#settingsModal .settings-nav-item[data-cat="voice"]');
  if (voiceNavItem) {
    voiceNavItem.addEventListener('click', function() {
      voice._bindVoicePanelOnce();
      voice.renderVoicePanel();
    });
  }
};
