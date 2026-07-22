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
    fishVoice: '语音测试01',              // Fish Speech 默认音色（声音克隆）
    voxcpmVoice: 'default',              // VoxCPM2 默认音色
    localTtsVoices: null,                // 缓存本地语音列表

    // ===== 本地服务可用性缓存（避免反复连接已下线的服务导致报错刷屏）=====
    _localSvc: { available: null, lastCheck: 0, cooldown: 60000 }, // null=未知, true/false
    // 🔧 各 TTS 引擎独立缓存：未安装/未启动的引擎在冷却期内直接跳过，避免每次朗读都报 503
    _voxcpmSvc: { available: null, lastCheck: 0, cooldown: 300000 }, // VoxCPM2 (8084)
    _fishSvc: { available: null, lastCheck: 0, cooldown: 300000 },   // Fish Speech

    // 快速探测本地音频服务是否在线（3s 超时）
    async _probeLocalService() {
      var now = Date.now();
      var svc = this._localSvc;
      // 冷却期内直接返回上次结果，不重复探测
      if (svc.available !== null && (now - svc.lastCheck) < svc.cooldown) {
        return svc.available;
      }
      try {
        var resp = await fetch('http://127.0.0.1:8080/api/tts/voices', { signal: AbortSignal.timeout(3000) });
        svc.available = resp.ok || resp.status === 200;
      } catch (e) {
        svc.available = false;
      }
      svc.lastCheck = now;
      if (!svc.available) {
        console.log('[Voice] 本地音频服务(8080)不可用，' + (svc.cooldown / 1000) + 's 内跳过本地通道');
      }
      return svc.available;
    },

    // 标记本地服务状态（成功时重置为可用）
    _markLocalSvc(ok) {
      if (ok) {
        this._localSvc.available = true;
        this._localSvc.lastCheck = Date.now();
      } else {
        this._localSvc.available = false;
        this._localSvc.lastCheck = Date.now();
      }
    },

    // 🔧 判断某个 TTS 引擎是否值得尝试
    // null=未知(尝试一次) / true=可用 / false=不可用且冷却期内(跳过)，冷却期满后重试一次
    _engineUsable(cache) {
      if (cache.available === null || cache.available === true) return true;
      return (Date.now() - cache.lastCheck) >= cache.cooldown;
    },

    // 🔧 记录引擎本次调用结果（成功→可用，失败→不可用并进入冷却）
    _markEngine(cache, ok) {
      cache.available = ok;
      cache.lastCheck = Date.now();
    },

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
    //  优先级：VoxCPM2 (本地GPU) → Fish Speech 1.5 → edge-tts → 云端 SiliconFlow → 浏览器 speechSynthesis
    // ================================================================

    // 对外入口：包一层，把"被更新的朗读取消"（AbortError）静默为 false，
    // 避免各调用点出现未处理的 Promise rejection；其余错误照常抛出。
    async speak(text, options) {
      try {
        return await this._speak(text, options);
      } catch (e) {
        if (e && e.name === 'AbortError') return false; // 被取消，正常现象
        throw e;
      }
    },

    async _speak(text, options) {
      options = options || {};

      // 停止之前的朗读，并中止上一次仍在进行中的 TTS 请求（配合服务端过期请求丢弃，避免堆积）
      this.cancelSpeak();

      // 🔧 先探测本地音频服务是否在线，离线则跳过全部本地通道（避免 503/ConnectTimeout 刷屏）
      var localOk = await this._probeLocalService();

      if (localOk) {
        // 最高优先：VoxCPM2 本地 GPU TTS（48kHz 高保真，零样本克隆）
        // 🔧 未安装/未启动时冷却期内直接跳过，不再每次报错
        if (this._engineUsable(this._voxcpmSvc)) {
          try {
            var r = await this._voxcpmSpeak(text, options);
            this._markEngine(this._voxcpmSvc, true);
            this._markLocalSvc(true);
            return r;
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            this._markEngine(this._voxcpmSvc, false);
            console.log('[Voice] VoxCPM 不可用，回退 Fish Speech:', e.message);
          }
        }

        // 回退 1：Fish Speech 1.5 本地 GPU TTS（高质量，支持声音克隆）
        if (this._engineUsable(this._fishSvc)) {
          try {
            var r2 = await this._fishSpeak(text, options);
            this._markEngine(this._fishSvc, true);
            this._markLocalSvc(true);
            return r2;
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            this._markEngine(this._fishSvc, false);
            console.log('[Voice] Fish Speech 不可用，回退 edge-tts:', e.message);
          }
        }

        // 回退 2：本地 edge-tts（免费神经语音，无需 API Key）
        try {
          var r3 = await this._localSpeak(text, options);
          this._markLocalSvc(true);
          return r3;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          // 三个本地通道全部失败，标记服务异常
          this._markLocalSvc(false);
          console.warn('本地 TTS 全部失败，回退云端/浏览器:', e.message);
        }
      }

      // 回退 3：云端 TTS
      if (this.isCloudAvailable()) {
        try {
          return await this._cloudSpeak(text, options);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          console.warn('云端 TTS 失败，回退浏览器:', e.message);
        }
      }

      // 回退 4：浏览器 speechSynthesis
      return this._browserSpeak(text, options);
    },

    // VoxCPM2 本地 GPU TTS（48kHz 高保真，零样本克隆，音色设计）
    async _voxcpmSpeak(text, options) {
      var voice = options.voice || this.voxcpmVoice || 'default';
      var speed = options.speed || options.rate || 1.0;
      var voiceDesign = options.voiceDesign || null;

      this._voxcpmAbortController = new AbortController();

      var bodyData = { text: text, voice: voice, speed: speed };
      if (voiceDesign) bodyData.voice_design = voiceDesign;
      if (options.referenceAudio) bodyData.reference_audio = options.referenceAudio;
      if (options.referenceText) bodyData.reference_text = options.referenceText;

      var response = await fetch('http://127.0.0.1:8080/api/tts-voxcpm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData),
        signal: this._voxcpmAbortController.signal
      });

      this._voxcpmAbortController = null;

      if (!response.ok) {
        var errData = {};
        try { errData = await response.json(); } catch (e2) {}
        throw new Error('HTTP ' + response.status + ': ' + (errData.error || response.statusText));
      }

      var arrayBuffer = await response.arrayBuffer();
      var blob = new Blob([arrayBuffer], { type: 'audio/wav' });
      var url = URL.createObjectURL(blob);

      var self = this;
      return new Promise(function(resolve) {
        self.currentAudio = new Audio(url);
        self.currentAudio.volume = options.volume !== undefined ? options.volume : 1.0;
        self.currentAudio.onended = function() {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          resolve(true);
        };
        self.currentAudio.onerror = function(e) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          resolve(false);
        };
        self.currentAudio.play().catch(function(err) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          resolve(false);
        });
      });
    },

    // Fish Speech s1-mini 本地 GPU TTS
    async _fishSpeak(text, options) {
      var voice = options.voice || this.fishVoice || 'default';
      var speed = options.speed || options.rate || 1.0;

      // 创建 AbortController 以支持取消
      this._fishAbortController = new AbortController();

      var response = await fetch('http://127.0.0.1:8080/api/tts-fish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voice: voice, speed: speed }),
        signal: this._fishAbortController.signal
      });

      this._fishAbortController = null;

      if (!response.ok) {
        var errData = {};
        try { errData = await response.json(); } catch (e2) {}
        throw new Error('HTTP ' + response.status + ': ' + (errData.error || response.statusText));
      }

      var arrayBuffer = await response.arrayBuffer();
      var blob = new Blob([arrayBuffer], { type: 'audio/wav' });
      var url = URL.createObjectURL(blob);

      var self = this;
      return new Promise(function(resolve) {
        self.currentAudio = new Audio(url);
        self.currentAudio.volume = options.volume !== undefined ? options.volume : 1.0;
        self.currentAudio.onended = function() {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          resolve(true);
        };
        self.currentAudio.onerror = function(e) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.warn('Fish audio error:', e);
          resolve(false);
        };
        self.currentAudio.play().catch(function(err) {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
          console.warn('Fish play failed:', err.message);
          resolve(false);
        });
      });
    },

    // 取消正在进行的 TTS 请求和播放
    cancelSpeak() {
      if (this._voxcpmAbortController) {
        this._voxcpmAbortController.abort();
        this._voxcpmAbortController = null;
      }
      if (this._fishAbortController) {
        this._fishAbortController.abort();
        this._fishAbortController = null;
      }
      this.stopSpeaking();
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
        self.currentAudio.onended = function() {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
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
        self.currentAudio.onended = function() {
          URL.revokeObjectURL(url);
          self.currentAudio = null;
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
    },

    // ================================================================
    //  ASR 语音识别
    //  优先级：本地 faster-whisper → 云端 SiliconFlow → 浏览器 SpeechRecognition → MediaRecorder
    // ================================================================

    async startListening(onResult, onError) {
      if (this.isListening) return;

      // 🔧 探测本地音频服务，离线则跳过本地 ASR（避免 60s ConnectTimeout 报错）
      var localOk = await this._probeLocalService();

      if (localOk) {
        // 优先：本地 faster-whisper（完全离线，无网络依赖）
        try {
          var mode = await this._startLocalASR(onResult, onError);
          this._markLocalSvc(true);
          return mode;
        } catch (e) {
          this._markLocalSvc(false);
          console.warn('⚠️ 本地 ASR 启动失败，回退云端:', e.message);
        }
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
                // 🔧 服务端 python ASR 最长 60s（首次运行还需下载模型），客户端超时需略大于服务端，避免提前中断
                signal: AbortSignal.timeout(65000)
              });

              if (!response.ok) {
                var errData = {};
                try { errData = await response.json(); } catch (e2) {}
                throw new Error('HTTP ' + response.status + ': ' + (errData.error || ''));
              }

              var data = await response.json();
              if (data.success && data.text) {
                self._markLocalSvc(true);
                if (onResult) onResult(data.text, true);
              } else {
                throw new Error(data.error || '识别结果为空');
              }
            } catch (e) {
              // 🔧 本地失败 → 标记服务异常 + 静默回退云端（不再向用户暴露原始错误）
              self._markLocalSvc(false);
              console.warn('[Voice] 本地 ASR 失败，尝试云端回退:', e.message);
              if (self.isCloudAvailable()) {
                try {
                  if (onResult) onResult('🔄 正在识别中...', false);
                  var text = await self._uploadASR(blob);
                  if (onResult) onResult(text, true);
                  return;
                } catch (e2) {
                  console.warn('[Voice] 云端 ASR 回退也失败:', e2.message);
                }
              }
              if (onError) onError('语音识别失败，请检查网络或稍后重试');
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

  window.voice = voice;
  // 挂载到 Core 供 /voice 命令和其他模块使用
  if (Core) Core.voice = voice;

  console.log('✅ 语音模块已加载（本地优先 + 云端 + 浏览器三级降级）');
}

// 获取当前语言（优先 i18n 模块，回退 zh-CN）
function getCurrentLang() {
  if (Core && Core.i18n && Core.i18n.getLanguage) return Core.i18n.getLanguage();
  if (Core && Core.config && Core.config.language) return Core.config.language;
  return 'zh-CN';
}

if (typeof module !== 'undefined') {
  module.exports = { name: 'voice', dependencies: ['settings'], init };
}
