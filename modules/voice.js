// modules/voice.js - 语音输入与朗读模块
// 优先使用硅基流动云端 ASR/TTS（高质量），回退到浏览器 Web Speech API

let Core = null;

function init(_Core) {
  Core = _Core;

  const voice = {
    // ===== 状态 =====
    isListening: false,
    recognition: null,        // 浏览器 SpeechRecognition 实例
    mediaRecorder: null,      // MediaRecorder 实例（云端 ASR 用）
    audioStream: null,        // 麦克风 MediaStream
    audioChunks: [],
    currentAudio: null,       // 云端 TTS 播放中的 Audio 对象

    // ===== 配置 =====
    ttsModel: 'fishaudio/fish-speech-1.5',
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    apiBase: 'https://api.siliconflow.cn/v1',
    localVoice: 'zh-CN-XiaoxiaoNeural',  // edge-tts 默认语音
    localTtsVoices: null,                // 缓存本地语音列表

    // ===== 辅助方法 =====

    // 检查云端 API 是否可用（有 siliconFlowKey）
    isCloudAvailable() {
      return !!(Core && Core.config && Core.config.siliconFlowKey);
    },

    // 获取 API Key（去除可能的 Bearer 前缀）
    _getApiKey() {
      var key = Core.config.siliconFlowKey;
      if (key && key.startsWith('Bearer ')) key = key.substring(7);
      return key;
    },

    // 检查浏览器原生 API 支持
    isSpeechRecognitionSupported() {
      return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
    },

    isSpeechSynthesisSupported() {
      return 'speechSynthesis' in window;
    },

    // ================================================================
    //  TTS 语音合成
    //  优先级：本地 edge-tts → 云端 SiliconFlow → 浏览器 speechSynthesis
    // ================================================================

    async speak(text, options) {
      options = options || {};

      // 停止之前的朗读
      this.stopSpeaking();

      // 优先：本地 edge-tts（免费神经语音，无需 API Key）
      try {
        return await this._localSpeak(text, options);
      } catch (e) {
        console.warn('⚠️ 本地 TTS 失败，回退云端:', e.message);
      }

      // 回退 1：云端 TTS
      if (this.isCloudAvailable()) {
        try {
          return await this._cloudSpeak(text, options);
        } catch (e) {
          console.warn('⚠️ 云端 TTS 失败，回退浏览器:', e.message);
        }
      }

      // 回退 2：浏览器 speechSynthesis
      return this._browserSpeak(text, options);
    },

    // 本地 TTS：POST /api/tts → 返回音频二进制
    async _localSpeak(text, options) {
      var voice = options.voice || this.localVoice || 'zh-CN-XiaoxiaoNeural';
      var speed = options.speed || options.rate || 1.0;

      var response = await fetch('http://127.0.0.1:8080/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voice: voice, speed: speed }),
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        var errData = {};
        try { errData = await response.json(); } catch (e2) {}
        throw new Error('HTTP ' + response.status + ': ' + (errData.error || response.statusText));
      }

      var arrayBuffer = await response.arrayBuffer();
      var blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      var url = URL.createObjectURL(blob);

      var self = this;
      return new Promise(function(resolve) {
        self.currentAudio = new Audio(url);
        self.currentAudio.volume = options.volume !== undefined ? options.volume : 1.0;
        self.currentAudio.onplay = function() { console.log('🔊 本地 TTS 开始播放 (edge-tts: ' + voice + ')'); };
        self.currentAudio.onended = function() {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.log('🔊 本地 TTS 播放结束');
          resolve(true);
        };
        self.currentAudio.onerror = function(e) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.warn('⚠️ 音频播放错误:', e);
          resolve(false);
        };
        self.currentAudio.play().catch(function(err) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.warn('⚠️ 播放失败:', err.message);
          resolve(false);
        });
      });
    },

    // 云端 TTS：POST /v1/audio/speech → 返回二进制音频
    async _cloudSpeak(text, options) {
      var apiKey = this._getApiKey();
      if (!apiKey) throw new Error('API Key 未配置');

      var model = (Core.config && Core.config.ttsModel) || this.ttsModel;
      var response = await fetch(this.apiBase + '/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: model,
          input: text,
          voice: options.voice || 'default',
          response_format: options.format || 'mp3',
          speed: options.speed || 1.0
        })
      });

      if (!response.ok) {
        var errText = '';
        try { errText = await response.text(); } catch (e2) {}
        throw new Error('HTTP ' + response.status + ': ' + errText);
      }

      var arrayBuffer = await response.arrayBuffer();
      var mimeType = {
        'mp3': 'audio/mpeg', 'wav': 'audio/wav',
        'flac': 'audio/flac', 'opus': 'audio/ogg'
      }[options.format || 'mp3'] || 'audio/mpeg';

      var blob = new Blob([arrayBuffer], { type: mimeType });
      var url = URL.createObjectURL(blob);

      var self = this;
      return new Promise(function(resolve) {
        self.currentAudio = new Audio(url);
        self.currentAudio.volume = options.volume !== undefined ? options.volume : 1.0;
        self.currentAudio.onplay = function() { console.log('🔊 云端 TTS 开始播放 (' + model + ')'); };
        self.currentAudio.onended = function() {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.log('🔊 云端 TTS 播放结束');
          resolve(true);
        };
        self.currentAudio.onerror = function(e) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.warn('⚠️ 音频播放错误:', e);
          resolve(false);
        };
        self.currentAudio.play().catch(function(err) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.warn('⚠️ 播放失败:', err.message);
          resolve(false);
        });
      });
    },

    // 浏览器 TTS 回退
    _browserSpeak(text, options) {
      if (!this.isSpeechSynthesisSupported()) {
        console.warn('⚠️ 浏览器不支持语音朗读');
        return false;
      }

      window.speechSynthesis.cancel();

      var utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options.lang || getCurrentLang();
      utterance.rate = options.rate || 1.0;
      utterance.pitch = options.pitch || 1.0;
      utterance.volume = options.volume !== undefined ? options.volume : 1.0;

      var voices = window.speechSynthesis.getVoices();
      var lang = utterance.lang;
      var matchedVoice = voices.find(function(v) {
        return v.lang === lang || v.lang.startsWith(lang.split('-')[0]);
      });
      if (matchedVoice) utterance.voice = matchedVoice;

      utterance.onstart = function() { console.log('🔊 浏览器 TTS 开始朗读'); };
      utterance.onend = function() { console.log('🔊 浏览器 TTS 朗读结束'); };
      utterance.onerror = function(e) { console.warn('⚠️ 朗读错误:', e.error); };

      window.speechSynthesis.speak(utterance);
      return true;
    },

    // 停止朗读
    stopSpeaking() {
      // 停止云端播放
      if (this.currentAudio) {
        try {
          this.currentAudio.pause();
          this.currentAudio.currentTime = 0;
          if (this.currentAudio.src) URL.revokeObjectURL(this.currentAudio.src);
        } catch (e) {}
        this.currentAudio = null;
      }
      // 停止浏览器朗读
      if (this.isSpeechSynthesisSupported()) {
        window.speechSynthesis.cancel();
      }
    },

    isSpeaking() {
      if (this.currentAudio && !this.currentAudio.paused) return true;
      return this.isSpeechSynthesisSupported() && window.speechSynthesis.speaking;
    },

    getVoices() {
      if (!this.isSpeechSynthesisSupported()) return [];
      return window.speechSynthesis.getVoices();
    },

    // 获取本地 edge-tts 语音列表
    async getLocalVoices() {
      if (this.localTtsVoices) return this.localTtsVoices;
      try {
        var resp = await fetch('http://127.0.0.1:8080/api/tts/voices', { signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
          var data = await resp.json();
          if (data.success && data.voices) {
            this.localTtsVoices = data.voices;
            console.log('🔊 本地 TTS 语音列表:', data.voices.length, '个');
            return data.voices;
          }
        }
      } catch (e) {
        console.warn('⚠️ 获取本地语音列表失败:', e.message);
      }
      return [];
    },

    setLocalVoice(name) {
      this.localVoice = name;
      if (Core && Core.config) Core.config.localVoice = name;
      console.log('🔊 本地 TTS 语音切换为:', name);
    },

    // ================================================================
    //  ASR 语音识别
    //  优先级：本地 faster-whisper → 云端 SiliconFlow → 浏览器 SpeechRecognition → MediaRecorder
    // ================================================================

    async startListening(onResult, onError) {
      if (this.isListening) return;

      // 优先：本地 faster-whisper（完全离线，无网络依赖）
      try {
        return await this._startLocalASR(onResult, onError);
      } catch (e) {
        console.warn('⚠️ 本地 ASR 启动失败，回退云端:', e.message);
      }

      // 回退 1：云端 ASR（MediaRecorder 录音 + 上传识别）
      if (this.isCloudAvailable()) {
        try {
          return await this._startCloudASR(onResult, onError);
        } catch (e) {
          console.warn('⚠️ 云端 ASR 启动失败，回退浏览器:', e.message);
        }
      }

      // 回退 2：浏览器 SpeechRecognition（实时逐字输出）
      if (this.isSpeechRecognitionSupported()) {
        return this._startBrowserRecognition(onResult, onError);
      }

      // 回退 3：MediaRecorder 纯录音（无识别）
      return this._startRecorderOnly(onResult, onError);
    },

    // 本地 ASR：MediaRecorder 录音 → base64 → POST /api/asr
    async _startLocalASR(onResult, onError) {
      var self = this;
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioStream = stream;
      this.audioChunks = [];

      this.mediaRecorder = new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = function(event) {
        if (event.data.size > 0) self.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async function() {
        self.isListening = false;

        if (self.audioStream) {
          self.audioStream.getTracks().forEach(function(t) { t.stop(); });
          self.audioStream = null;
        }

        var blob = new Blob(self.audioChunks, { type: 'audio/webm' });
        self.audioChunks = [];

        if (onResult) onResult('🔄 本地识别中...', false);

        try {
          // 转 base64
          var reader = new FileReader();
          reader.onloadend = async function() {
            try {
              var base64Audio = reader.result; // data:audio/webm;base64,...
              var response = await fetch('http://127.0.0.1:8080/api/asr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audio: base64Audio,
                  model: (Core.config && Core.config.asrLocalModel) || 'base',
                  language: (Core.config && Core.config.asrLanguage) || 'zh'
                }),
                signal: AbortSignal.timeout(60000)
              });

              if (!response.ok) {
                var errData = {};
                try { errData = await response.json(); } catch (e2) {}
                throw new Error('HTTP ' + response.status + ': ' + (errData.error || ''));
              }

              var data = await response.json();
              if (data.success && data.text) {
                console.log('✅ 本地 ASR 识别完成:', data.text.substring(0, 50));
                if (onResult) onResult(data.text, true);
              } else {
                throw new Error(data.error || '识别结果为空');
              }
            } catch (e) {
              console.error('❌ 本地 ASR 请求失败:', e.message);
              if (onError) onError('语音识别失败: ' + e.message);
            }
          };
          reader.readAsDataURL(blob);
        } catch (e) {
          console.error('❌ 本地 ASR 编码失败:', e.message);
          if (onError) onError('音频编码失败: ' + e.message);
        }
      };

      this.mediaRecorder.start();
      this.isListening = true;
      console.log('🎤 本地 ASR 录音中（faster-whisper，停止后自动识别）');
      if (onResult) onResult('🎤 正在录音（本地识别），再次点击停止...', false);
      return 'local-asr';
    },

    // 云端 ASR：先用 MediaRecorder 录音，停止后上传识别
    async _startCloudASR(onResult, onError) {
      var self = this;
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioStream = stream;
      this.audioChunks = [];

      this.mediaRecorder = new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = function(event) {
        if (event.data.size > 0) self.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async function() {
        self.isListening = false;

        // 停止麦克风
        if (self.audioStream) {
          self.audioStream.getTracks().forEach(function(t) { t.stop(); });
          self.audioStream = null;
        }

        var blob = new Blob(self.audioChunks, { type: 'audio/webm' });
        self.audioChunks = [];

        // 通知前端"正在识别"
        if (onResult) onResult('🔄 正在识别中...', false);

        try {
          var text = await self._uploadASR(blob);
          if (onResult) onResult(text, true);
        } catch (e) {
          console.error('❌ 云端 ASR 失败:', e.message);
          if (onError) onError('语音识别失败: ' + e.message);
        }
      };

      this.mediaRecorder.start();
      this.isListening = true;
      console.log('🎤 云端 ASR 录音中（停止后自动上传识别）');
      if (onResult) onResult('🎤 正在录音，再次点击停止...', false);
      return 'cloud-asr';
    },

    // 上传音频到云端 ASR
    async _uploadASR(audioBlob) {
      var apiKey = this._getApiKey();
      var model = (Core.config && Core.config.asrModel) || this.asrModel;

      var formData = new FormData();
      formData.append('model', model);
      formData.append('file', audioBlob, 'recording.webm');

      var response = await fetch(this.apiBase + '/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey
          // 不设置 Content-Type，让浏览器自动设置 multipart/form-data boundary
        },
        body: formData
      });

      if (!response.ok) {
        var errText = '';
        try { errText = await response.text(); } catch (e2) {}
        throw new Error('HTTP ' + response.status + ': ' + errText);
      }

      var data = await response.json();
      return data.text || '';
    },

    // 浏览器 SpeechRecognition（实时逐字输出）
    _startBrowserRecognition(onResult, onError) {
      var self = this;
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = getCurrentLang();

      var finalTranscript = '';

      this.recognition.onresult = function(event) {
        var interim = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interim += transcript;
          }
        }
        if (onResult) onResult(finalTranscript + interim, false);
      };

      this.recognition.onerror = function(event) {
        console.warn('⚠️ 语音识别错误:', event.error);
        if (event.error === 'not-allowed') {
          if (onError) onError('麦克风权限被拒绝，请检查浏览器设置');
        } else if (event.error === 'no-speech') {
          // 没有检测到语音，静默处理
        } else {
          if (onError) onError('语音识别错误: ' + event.error);
        }
      };

      this.recognition.onend = function() {
        self.isListening = false;
        if (onResult) onResult(finalTranscript, true);
      };

      this.recognition.start();
      this.isListening = true;
      console.log('🎤 浏览器语音识别已启动');
      return 'speech';
    },

    // MediaRecorder 纯录音（无识别能力）
    async _startRecorderOnly(onResult, onError) {
      var self = this;
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(stream);
        this.audioChunks = [];

        this.mediaRecorder.ondataavailable = function(event) {
          if (event.data.size > 0) self.audioChunks.push(event.data);
        };

        this.mediaRecorder.onstop = function() {
          self.isListening = false;
          var blob = new Blob(self.audioChunks, { type: 'audio/webm' });
          var url = URL.createObjectURL(blob);
          if (onResult) onResult('[语音录制完成，音频: ' + url + ']', true);
          stream.getTracks().forEach(function(t) { t.stop(); });
        };

        this.mediaRecorder.start();
        this.isListening = true;
        console.log('🎤 录音已启动（MediaRecorder 回退，无识别）');
        return 'recorder';
      } catch (e) {
        console.error('❌ 麦克风访问失败:', e.message);
        if (onError) onError('无法访问麦克风: ' + e.message);
        return null;
      }
    },

    // 停止录音/识别
    stopListening() {
      // 云端 ASR：停止 MediaRecorder（触发 onstop → 自动上传）
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        try { this.mediaRecorder.stop(); } catch (e) {}
      }
      this.mediaRecorder = null;

      // 停止麦克风流
      if (this.audioStream) {
        this.audioStream.getTracks().forEach(function(t) { t.stop(); });
        this.audioStream = null;
      }

      // 浏览器 SpeechRecognition
      if (this.recognition) {
        try { this.recognition.stop(); } catch (e) {}
        this.recognition = null;
      }

      this.isListening = false;
      console.log('🎤 录音/识别已停止');
    },
  };

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
    console.log('🔊 自动朗读 AI 回复，长度:', cleanText.length, '音色:', this.voiceProfile);
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
          var text = lastMsg.textContent || lastMsg.innerText || '';
          voice.autoSpeakReply(text);
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
        if (p) { p.speed = Math.min(p.speed + 0.2, 2.0); console.log('语速:', p.speed); }
      }};
    }
    if (/^(慢一点|说慢点|减速)/.test(lower)) {
      return { command: 'slow_down', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
        if (p) { p.speed = Math.max(p.speed - 0.2, 0.5); console.log('语速:', p.speed); }
      }};
    }
    // 音量调整
    if (/^(大声点|声音大点)/.test(lower)) {
      return { command: 'volume_up', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
        if (p) { p.volume = Math.min(p.volume + 0.2, 1.5); console.log('音量:', p.volume); }
      }};
    }
    if (/^(小声点|声音小点|轻一点)/.test(lower)) {
      return { command: 'volume_down', action: function() {
        var p = voice.voiceProfiles[voice.voiceProfile];
        if (p) { p.volume = Math.max(p.volume - 0.2, 0.2); console.log('音量:', p.volume); }
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
    if (Core && Core.config) Core.config.voiceProfile = name;
    console.log('🔊 音色已切换:', name);
    return true;
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
        console.log('🔊 浏览器语音列表已加载:', voice.getVoices().length, '个');
      };
    }
  }

  window.voice = voice;
  // 挂载到 Core 供 /voice 命令和其他模块使用
  if (Core) Core.voice = voice;

  console.log('✅ 语音模块已加载（本地优先 + 云端 + 浏览器三级降级）');
  console.log('🔊 TTS: edge-tts(本地) → SiliconFlow(云端) → speechSynthesis(浏览器)');
  console.log('🎤 ASR: faster-whisper(本地) → SiliconFlow(云端) → SpeechRecognition(浏览器) → MediaRecorder');
  console.log('☁️ 云端 API:', voice.isCloudAvailable() ? '已配置' : '未配置 siliconFlowKey');
  console.log('🔊 本地 TTS 默认语音:', voice.localVoice);
}

// 获取当前语言（优先 i18n 模块，回退 zh-CN）
function getCurrentLang() {
  if (Core && Core.i18n && Core.i18n.getLanguage) return Core.i18n.getLanguage();
  if (Core && Core.config && Core.config.language) return Core.config.language;
  return 'zh-CN';
}

if (typeof module !== 'undefined') {
  module.exports = { init };
}
