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
    // 优先流式播放（首包延迟低，边生成边播）；失败自动回退阻塞模式。
    async _voxcpmSpeak(text, options) {
      try {
        var sentences = this._splitSentences(text);
        if (sentences.length > 1) {
          // 多句走流水线：第 N 句播放时 GPU 预生成第 N+1 句，句间自然停顿兼作生成预算补偿
          return await this._voxcpmSpeakPipeline(sentences, options);
        }
        return await this._voxcpmSpeakStream(sentences[0] || text, options);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e; // 取消直接向上抛，不回退
        console.warn('流式TTS不可用，回退阻塞模式:', e.message);
        this._cleanupStream();
        return await this._voxcpmSpeakBlocking(text, options);
      }
    },

    // VoxCPM2 流式播放：请求 /stream 端点，PCM16 分块到达即用 Web Audio API 排播。
    // 相比阻塞模式（整句生成完才出声），首包延迟从整句时间降到首个片段时间。
    // 缓冲策略：先累积约 1s 音频再开播（预缓冲吸收抖动），预缓冲块合并为单个
    // AudioBuffer 减少拼接缝；生成速度约 0.85x 实时，长文本欠载时以短停顿续播。
    async _voxcpmSpeakStream(text, options) {
      var self = this;
      var voice = options.voice || this.voxcpmVoice || 'default';
      var speed = options.speed || options.rate || 1.0;
      var voiceDesign = options.voiceDesign || null;

      this._voxcpmAbortController = new AbortController();
      var signal = this._voxcpmAbortController.signal;

      var bodyData = { text: text, voice: voice, speed: speed };
      if (voiceDesign) bodyData.voice_design = voiceDesign;
      if (options.referenceAudio) bodyData.reference_audio = options.referenceAudio;
      if (options.referenceText) bodyData.reference_text = options.referenceText;

      var response = await fetch('http://127.0.0.1:8080/api/tts-voxcpm/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData),
        signal: signal
      });

      var ctype = response.headers.get('Content-Type') || '';
      if (!response.ok || ctype.indexOf('json') !== -1) {
        this._voxcpmAbortController = null;
        var errData = {};
        try { errData = await response.json(); } catch (e2) {}
        if (errData && errData.stale) return false; // 过期请求=已被取代，视为取消
        throw new Error('HTTP ' + response.status + ': ' + (errData.error || response.statusText));
      }

      var sampleRate = parseInt(response.headers.get('X-Sample-Rate') || '48000', 10) || 48000;

      // Web Audio 流式播放上下文
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      var ctx;
      try { ctx = new AudioCtx({ sampleRate: sampleRate }); } catch (e) { ctx = new AudioCtx(); }
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      this._streamCtx = ctx;
      this._streamSources = [];

      var gain = ctx.createGain();
      gain.gain.value = options.volume !== undefined ? options.volume : 1.0;
      gain.connect(ctx.destination);

      var nextStartTime = 0;
      var leftover = null; // 上一块剩余的奇数字节
      var totalSamples = 0;
      var underruns = 0;

      // —— 缓冲策略参数 ——
      // 实测 VoxCPM2 2B 生成速率约 0.85x 实时（0.16s/块、间隔~190ms），
      // 播放终将追上生成；预缓冲积累提前量，吸收 GPU 调度/网络/GC 抖动。
      var PREBUFFER_SECONDS = 1.0;      // 累积满 1.0s 音频再开播
      var PREBUFFER_TIMEOUT_MS = 2500;  // 超时仍未攒满则用已有音频开播，避免死等
      var UNDERRUN_LEAD = 0.15;         // 欠载后重新排播的提前量（秒）

      var pendingChunks = [];   // 尚未排播的 Float32Array 队列
      var pendingSamples = 0;
      var playbackStarted = false;

      // 排播一段 Float32 音频：沿 nextStartTime 时间轴严格连续
      function scheduleFloats(f32) {
        if (!f32 || f32.length === 0) return;
        var buf = ctx.createBuffer(1, f32.length, sampleRate);
        buf.getChannelData(0).set(f32);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        var now = ctx.currentTime;
        if (nextStartTime < now + 0.02) {
          // 欠载：播放追上了生成，带提前量重排（产生短停顿而非爆音）
          nextStartTime = now + UNDERRUN_LEAD;
          underruns++;
        }
        src.start(nextStartTime);
        nextStartTime += buf.duration;
        self._streamSources.push(src);
        totalSamples += f32.length;
      }

      // 把预缓冲队列合并为单个大 buffer 一次排播（减少小块拼接的调度缝）
      function flushPending() {
        if (pendingSamples === 0) return;
        var merged = new Float32Array(pendingSamples);
        var off = 0;
        for (var i = 0; i < pendingChunks.length; i++) {
          merged.set(pendingChunks[i], off);
          off += pendingChunks[i].length;
        }
        pendingChunks = [];
        pendingSamples = 0;
        scheduleFloats(merged);
      }

      function startPlayback() {
        if (playbackStarted) return;
        playbackStarted = true;
        if (self._streamPrebufTimer) { clearTimeout(self._streamPrebufTimer); self._streamPrebufTimer = null; }
        nextStartTime = ctx.currentTime + 0.1; // 开播提前量
        flushPending();
      }

      function bytesToFloats(bytes) {
        // 拷入新 buffer 保证 Int16 对齐
        var copy = new Uint8Array(bytes);
        var int16 = new Int16Array(copy.buffer, 0, copy.byteLength / 2);
        if (int16.length === 0) return null;
        var f32 = new Float32Array(int16.length);
        for (var i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        return f32;
      }

      // 兜底：预缓冲一直攒不满（短文本/生成慢）时超时强制开播
      this._streamPrebufTimer = setTimeout(function() {
        self._streamPrebufTimer = null;
        if (!playbackStarted && pendingSamples > 0) startPlayback();
      }, PREBUFFER_TIMEOUT_MS);

      var reader = response.body.getReader();
      try {
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          var chunk = r.value;
          if (!chunk || chunk.byteLength === 0) continue;
          var bytes;
          if (leftover) {
            bytes = new Uint8Array(leftover.byteLength + chunk.byteLength);
            bytes.set(leftover, 0);
            bytes.set(chunk, leftover.byteLength);
            leftover = null;
          } else {
            bytes = chunk;
          }
          var usable = bytes.byteLength - (bytes.byteLength % 2);
          if (bytes.byteLength % 2 !== 0) leftover = bytes.subarray(usable);
          if (usable <= 0) continue;

          var f32 = bytesToFloats(bytes.subarray(0, usable));
          if (!f32) continue;

          if (!playbackStarted) {
            // 预缓冲阶段：只累积不播放，攒够目标时长再开播
            pendingChunks.push(f32);
            pendingSamples += f32.length;
            if (pendingSamples / sampleRate >= PREBUFFER_SECONDS) startPlayback();
          } else {
            // 播放阶段：到达即排播，延续时间轴
            scheduleFloats(f32);
          }
        }
      } catch (e) {
        this._voxcpmAbortController = null;
        this._cleanupStream();
        throw e; // AbortError 或读取错误，交由上层决定是否回退
      }

      this._voxcpmAbortController = null;

      // 流结束：若仍未开播（短文本不足预缓冲量），立即播出全部
      startPlayback();

      if (totalSamples === 0) {
        this._cleanupStream();
        throw new Error('流式合成未返回音频数据');
      }

      if (underruns > 0) {
        console.log('[Voice] 流式播放欠载 ' + underruns + ' 次（生成慢于实时，短停顿续播）');
      }

      // 等待已排播的音频播放完毕
      var endAt = nextStartTime;
      return new Promise(function(resolve) {
        self._streamResolve = resolve;
        var remainMs = Math.max(0, (endAt - ctx.currentTime) * 1000) + 150;
        self._streamDoneTimer = setTimeout(function() { self._cleanupStream(); }, remainMs);
      });
    },

    // 多句流水线播放：长文切句后共享一个 AudioContext 时间轴逐句合成。
    // 第 N 句播放时 GPU 预生成第 N+1 句（请求天然串行）；句间 0.4s 自然
    // 停顿既符合听感，又补偿生成预算（实测生成约 0.9x 实时）。首句预缓冲，
    // 后续句即到即排；欠载以短停顿续播。已播部分后某句失败则优雅提前结束
    // （不抛错、不重播），一句都没播才抛错触发阻塞回退。
    async _voxcpmSpeakPipeline(sentences, options) {
      var self = this;
      var voice = options.voice || this.voxcpmVoice || 'default';
      var speed = options.speed || options.rate || 1.0;
      var voiceDesign = options.voiceDesign || null;

      this._voxcpmAbortController = new AbortController();
      var signal = this._voxcpmAbortController.signal;

      var sampleRate = 48000;
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      var ctx;
      try { ctx = new AudioCtx({ sampleRate: sampleRate }); } catch (e) { ctx = new AudioCtx(); }
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      this._streamCtx = ctx;
      this._streamSources = [];

      var gain = ctx.createGain();
      gain.gain.value = options.volume !== undefined ? options.volume : 1.0;
      gain.connect(ctx.destination);

      var nextStartTime = 0;
      var totalSamples = 0;
      var underruns = 0;
      var playbackStarted = false;
      var pendingChunks = [];
      var pendingSamples = 0;

      var PREBUFFER_SECONDS = 1.0;      // 首句预缓冲目标
      var PREBUFFER_TIMEOUT_MS = 2500;  // 预缓冲兜底超时
      var UNDERRUN_LEAD = 0.15;         // 欠载续播提前量（秒）
      var SENTENCE_PAUSE = 0.4;         // 句间自然停顿（秒），兼作每句请求首包开销的预算补偿

      function scheduleFloats(f32) {
        if (!f32 || f32.length === 0) return;
        var buf = ctx.createBuffer(1, f32.length, sampleRate);
        buf.getChannelData(0).set(f32);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        var now = ctx.currentTime;
        if (nextStartTime < now + 0.02) {
          // 欠载：播放追上生成，带提前量续播（短停顿而非爆音）
          nextStartTime = now + UNDERRUN_LEAD;
          underruns++;
        }
        src.start(nextStartTime);
        nextStartTime += buf.duration;
        self._streamSources.push(src);
        totalSamples += f32.length;
      }

      function flushPending() {
        if (pendingSamples === 0) return;
        var merged = new Float32Array(pendingSamples);
        var off = 0;
        for (var i = 0; i < pendingChunks.length; i++) {
          merged.set(pendingChunks[i], off);
          off += pendingChunks[i].length;
        }
        pendingChunks = [];
        pendingSamples = 0;
        scheduleFloats(merged);
      }

      function startPlayback() {
        if (playbackStarted) return;
        playbackStarted = true;
        if (self._streamPrebufTimer) { clearTimeout(self._streamPrebufTimer); self._streamPrebufTimer = null; }
        nextStartTime = ctx.currentTime + 0.1;
        flushPending();
      }

      function bytesToFloats(bytes) {
        var copy = new Uint8Array(bytes);
        var int16 = new Int16Array(copy.buffer, 0, copy.byteLength / 2);
        if (int16.length === 0) return null;
        var f32 = new Float32Array(int16.length);
        for (var i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        return f32;
      }

      // 句间停顿：已开播则延长时间轴，未开播则往预缓冲队列追加静音段
      function insertPause() {
        if (playbackStarted) {
          nextStartTime += SENTENCE_PAUSE;
        } else {
          var n = Math.round(SENTENCE_PAUSE * sampleRate);
          pendingChunks.push(new Float32Array(n));
          pendingSamples += n;
        }
      }

      this._streamPrebufTimer = setTimeout(function() {
        self._streamPrebufTimer = null;
        if (!playbackStarted && pendingSamples > 0) startPlayback();
      }, PREBUFFER_TIMEOUT_MS);

      for (var si = 0; si < sentences.length; si++) {
        if (signal.aborted) break;
        var sentence = sentences[si];

        var bodyData = { text: sentence, voice: voice, speed: speed };
        if (voiceDesign) bodyData.voice_design = voiceDesign;
        if (options.referenceAudio) bodyData.reference_audio = options.referenceAudio;
        if (options.referenceText) bodyData.reference_text = options.referenceText;

        var response;
        try {
          response = await fetch('http://127.0.0.1:8080/api/tts-voxcpm/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData),
            signal: signal
          });
        } catch (e) {
          // 网络错误/取消：一字未播则抛上触发回退，否则提前结束播放已排内容
          if (totalSamples === 0 && pendingSamples === 0) {
            this._voxcpmAbortController = null;
            this._cleanupStream();
            throw e;
          }
          break;
        }

        var ctype = response.headers.get('Content-Type') || '';
        if (!response.ok || ctype.indexOf('json') !== -1) {
          var errData = {};
          try { errData = await response.json(); } catch (e2) {}
          this._voxcpmAbortController = null;
          if (errData && errData.stale) { this._cleanupStream(); return false; }
          var msg = 'HTTP ' + response.status + ': ' + (errData.error || response.statusText);
          if (totalSamples === 0 && pendingSamples === 0) { this._cleanupStream(); throw new Error(msg); }
          console.warn('[Voice] 流水线第' + (si + 1) + '句合成失败，提前结束:', msg);
          break;
        }

        var rate = parseInt(response.headers.get('X-Sample-Rate') || '48000', 10) || 48000;
        if (rate !== sampleRate) sampleRate = rate;

        if (si > 0 && (totalSamples > 0 || pendingSamples > 0)) insertPause();

        var leftover = null;
        var reader = response.body.getReader();
        try {
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            var chunk = r.value;
            if (!chunk || chunk.byteLength === 0) continue;
            var bytes;
            if (leftover) {
              bytes = new Uint8Array(leftover.byteLength + chunk.byteLength);
              bytes.set(leftover, 0);
              bytes.set(chunk, leftover.byteLength);
              leftover = null;
            } else {
              bytes = chunk;
            }
            var usable = bytes.byteLength - (bytes.byteLength % 2);
            if (bytes.byteLength % 2 !== 0) leftover = bytes.subarray(usable);
            if (usable <= 0) continue;

            var f32 = bytesToFloats(bytes.subarray(0, usable));
            if (!f32) continue;

            if (!playbackStarted) {
              // 首句预缓冲阶段：累积到目标时长再开播
              pendingChunks.push(f32);
              pendingSamples += f32.length;
              if (pendingSamples / sampleRate >= PREBUFFER_SECONDS) startPlayback();
            } else {
              scheduleFloats(f32);
            }
          }
        } catch (e) {
          this._voxcpmAbortController = null;
          this._cleanupStream();
          throw e;
        }
      }

      this._voxcpmAbortController = null;
      startPlayback(); // 首句过短未触发预缓冲时立即开播

      if (totalSamples === 0) {
        this._cleanupStream();
        throw new Error('流式合成未返回音频数据');
      }

      if (underruns > 0) {
        console.log('[Voice] 流水线播放欠载 ' + underruns + ' 次（生成慢于实时，短停顿续播）');
      }

      var endAt = nextStartTime;
      return new Promise(function(resolve) {
        self._streamResolve = resolve;
        var remainMs = Math.max(0, (endAt - ctx.currentTime) * 1000) + 150;
        self._streamDoneTimer = setTimeout(function() { self._cleanupStream(); }, remainMs);
      });
    },

    // 长文本切句（供流水线使用）：
    // 1) 按中英文句末标点与换行切分（英文句号等仅在后随空白时切，避免切断 3.5 这类小数）；
    // 2) 超长分句（>70字）按逗号二次切分（英文逗号后随数字不切，避免切断 12,345）；
    // 3) 过滤纯标点碎片；4) 合并过碎分句（前句<15字且合并后≤45字才合并；
    //    每次请求有约 0.5s 首包开销，碎句太多反而更慢）
    _splitSentences(text) {
      var raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
      var parts = raw.split(/(?<=[。！？；…\n]|[.!?;]\s)\s*/);
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (!p) continue;
        if (p.length <= 70) { out.push(p); continue; }
        var subs = p.split(/(?<=[，、,：:])(?![0-9])\s*/);
        var buf = '';
        for (var j = 0; j < subs.length; j++) {
          var s = subs[j];
          if (buf && (buf.length + s.length) > 70) { out.push(buf); buf = s; }
          else buf += s;
        }
        if (buf) out.push(buf);
      }
      out = out.filter(function(s) { return /[\u4e00-\u9fa5A-Za-z0-9]/.test(s); });
      var merged = [];
      for (var k = 0; k < out.length; k++) {
        var cur = out[k];
        var last = merged.length ? merged[merged.length - 1] : null;
        if (last !== null && last.length < 15 && last.length + cur.length <= 45) {
          // 非中文相接处补空格（避免英文合并成 "world.Next"；中文相接无需空格）
          var sep = (/[^\u4e00-\u9fa5]$/.test(last) && /^[^\u4e00-\u9fa5]/.test(cur)) ? ' ' : '';
          merged[merged.length - 1] = last + sep + cur;
        } else {
          merged.push(cur);
        }
      }
      return merged;
    },

    // 清理流式播放资源：停止所有已排播音频、关闭上下文、兑现未完成的 Promise。
    _cleanupStream() {
      if (this._streamPrebufTimer) { clearTimeout(this._streamPrebufTimer); this._streamPrebufTimer = null; }
      if (this._streamDoneTimer) { clearTimeout(this._streamDoneTimer); this._streamDoneTimer = null; }
      if (this._streamSources) {
        for (var i = 0; i < this._streamSources.length; i++) {
          try { this._streamSources[i].stop(); } catch (e) {}
        }
        this._streamSources = [];
      }
      if (this._streamCtx) {
        try { this._streamCtx.close(); } catch (e) {}
        this._streamCtx = null;
      }
      if (this._streamResolve) {
        var rr = this._streamResolve; this._streamResolve = null;
        rr(true);
      }
    },

    // VoxCPM2 阻塞模式（整段音频返回后再播放；流式失败时的回退路径）
    async _voxcpmSpeakBlocking(text, options) {
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
      this._cleanupStream(); // 停止流式播放（Web Audio）
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


  // ===== 语音命令 & 设置面板（提取到 lib/voice-commands.js）=====
  require('./lib/voice-commands')({ Core: Core, voice: voice });


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
