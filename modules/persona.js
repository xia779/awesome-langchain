// modules/persona.js - 人格引擎（P2-1/P2-2/P2-3/P2-5）
// 多维人格模型 + 情绪状态机 + 亲密度 + 风格自适应
// 差异化超越：KIMI/Qoder 均无人格系统
(function() {
  'use strict';

  var Core = null;
  var fs = require('fs');
  var path = require('path');

  // ═══════════════════════════════════════════
  // 1. 人格维度模型（大五人格 0-100）
  // ═══════════════════════════════════════════
  var DEFAULT_PERSONA = {
    openness: 70,        // 开放性：好奇心、创造力
    conscientiousness: 60, // 尽责性：条理、可靠
    extraversion: 65,    // 外向性：热情、主动
    agreeableness: 75,   // 宜人性：同理心、合作
    neuroticism: 30,     // 神经质：情绪波动（低=稳定）
    humor: 60,           // 幽默感（扩展维度）
    proactiveness: 55,   // 主动性（扩展维度）
    formality: 40        // 正式度（0=随意 100=正式）
  };

  var _persona = null; // 运行时人格配置

  function getPersona() {
    if (_persona) return _persona;
    _persona = Object.assign({}, DEFAULT_PERSONA);
    // 从持久化加载
    try {
      var file = _getConfigPath();
      if (fs.existsSync(file)) {
        var saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.persona) Object.assign(_persona, saved.persona);
      }
    } catch (e) {}
    return _persona;
  }

  function setPersona(updates) {
    var p = getPersona();
    Object.keys(updates).forEach(function(k) {
      if (k in DEFAULT_PERSONA) {
        p[k] = Math.max(0, Math.min(100, Number(updates[k]) || 0));
      }
    });
    _persona = p;
    _saveConfig();
    return p;
  }

  function resetPersona() {
    _persona = Object.assign({}, DEFAULT_PERSONA);
    _saveConfig();
    return _persona;
  }

  // ═══════════════════════════════════════════
  // 2. 情绪状态机（P2-2）
  // ═══════════════════════════════════════════
  var EMOTIONS = ['neutral', 'happy', 'curious', 'empathetic', 'excited', 'concerned'];

  var _emotionState = {
    current: 'neutral',
    intensity: 0.5,     // 0-1
    history: [],        // 最近 20 次情绪变化
    lastUpdate: Date.now()
  };

  function getEmotionState() {
    // 自然衰减：长时间无交互回归 neutral
    var elapsed = Date.now() - _emotionState.lastUpdate;
    if (elapsed > 30 * 60 * 1000 && _emotionState.current !== 'neutral') {
      _emotionState.current = 'neutral';
      _emotionState.intensity = 0.3;
    }
    return { current: _emotionState.current, intensity: _emotionState.intensity };
  }

  function updateEmotion(newEmotion, intensity) {
    if (EMOTIONS.indexOf(newEmotion) < 0) newEmotion = 'neutral';
    _emotionState.history.push({ from: _emotionState.current, to: newEmotion, at: Date.now() });
    if (_emotionState.history.length > 20) _emotionState.history.shift();
    _emotionState.current = newEmotion;
    _emotionState.intensity = Math.max(0, Math.min(1, intensity || 0.5));
    _emotionState.lastUpdate = Date.now();
  }

  /**
   * detectUserEmotion - 从用户消息推断情绪（轻量规则，无需 LLM）
   */
  function detectUserEmotion(text) {
    if (!text) return 'neutral';
    var t = text.toLowerCase();

    // 积极信号
    if (/哈哈|太好了|感谢|谢谢|棒|厉害|开心|不错|赞|❤|👍|😄|🎉/.test(t)) return 'happy';
    if (/好奇|为什么|怎么回事|想了解|有意思/.test(t)) return 'curious';
    if (/加油|期待|兴奋|迫不及待/.test(t)) return 'excited';

    // 消极信号
    if (/烦|累|难过|失望|焦虑|压力|崩溃|烦死|郁闷|😢|😞/.test(t)) return 'concerned';
    if (/帮帮我|怎么办|出问题了|报错|失败|不行/.test(t)) return 'concerned';

    // 共情需求
    if (/你觉得|你认为|想聊聊|说说|倾诉/.test(t)) return 'empathetic';

    return 'neutral';
  }

  /**
   * respondToEmotion - 根据用户情绪调整 AI 响应策略
   * 返回应注入系统提示的情绪指令
   */
  function getEmotionDirective(userEmotion) {
    var persona = getPersona();
    var directives = {
      happy: '用户心情愉快，回复可以轻松活泼一些，适当分享喜悦。',
      curious: '用户充满好奇，回复要详尽且有深度，可以延伸相关知识。',
      excited: '用户很兴奋，回复要有热情和能量，配合节奏。',
      concerned: '用户可能有困扰或压力，回复要温和、有耐心、先共情再解决问题。不要急于给方案，先表达理解。',
      empathetic: '用户想要交流，回复要有温度、有观点、像朋友聊天。',
      neutral: ''
    };

    var directive = directives[userEmotion] || '';
    if (!directive) return '';

    // 人格调节：高宜人性增强共情，低外向性减少感叹号
    if (persona.agreeableness > 70 && userEmotion === 'concerned') {
      directive += ' 多用安慰性语言。';
    }
    if (persona.extraversion < 40) {
      directive += ' 语气保持平和内敛。';
    }

    return '\n\n【情绪适配】' + directive;
  }

  // ═══════════════════════════════════════════
  // 3. 亲密度模型（P2-3）
  // ═══════════════════════════════════════════
  var INTIMACY_LEVELS = [
    { name: '陌生', threshold: 0, style: '礼貌、正式、保持距离' },
    { name: '熟悉', threshold: 20, style: '自然、友善、可以开玩笑' },
    { name: '亲密', threshold: 50, style: '随意、默契、可以调侃' },
    { name: '默契', threshold: 80, style: '心照不宣、极简沟通、深度信任' }
  ];

  var _intimacy = { score: 0, interactions: 0, lastInteraction: Date.now(), milestones: [] };

  function getIntimacy() {
    return {
      score: _intimacy.score,
      level: _getIntimacyLevel(),
      interactions: _intimacy.interactions
    };
  }

  function _getIntimacyLevel() {
    var level = INTIMACY_LEVELS[0];
    for (var i = INTIMACY_LEVELS.length - 1; i >= 0; i--) {
      if (_intimacy.score >= INTIMACY_LEVELS[i].threshold) {
        level = INTIMACY_LEVELS[i];
        break;
      }
    }
    return level;
  }

  function recordInteraction(quality) {
    // quality: 1(普通) 2(深入) 3(关键事件)
    quality = quality || 1;
    _intimacy.interactions++;
    _intimacy.lastInteraction = Date.now();
    // 每次交互增加亲密度，深入交流加更多
    var gain = quality * 0.5;
    _intimacy.score = Math.min(100, _intimacy.score + gain);

    // 里程碑检测
    var level = _getIntimacyLevel();
    var lastMilestone = _intimacy.milestones[_intimacy.milestones.length - 1];
    if (!lastMilestone || lastMilestone.level !== level.name) {
      _intimacy.milestones.push({ level: level.name, at: Date.now(), interactions: _intimacy.interactions });
    }
    _saveConfig();
  }

  function getIntimacyDirective() {
    var level = _getIntimacyLevel();
    if (level.name === '陌生') return '';
    return '\n\n【关系层级：' + level.name + '】交互风格：' + level.style + '。';
  }

  // ═══════════════════════════════════════════
  // 4. 对话风格自适应（P2-5）
  // ═══════════════════════════════════════════
  var _styleHistory = []; // 最近 10 条用户消息的风格特征

  function detectUserStyle(text) {
    if (!text) return null;
    var features = {
      length: text.length,
      formal: /您|请|麻烦|劳驾/.test(text),
      casual: /哈|嘛|呗|呀|啦|哦/.test(text),
      technical: /代码|函数|API|bug|报错|编译|部署/.test(text),
      brief: text.length < 20,
      emoji: /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}]/u.test(text)
    };
    _styleHistory.push(features);
    if (_styleHistory.length > 10) _styleHistory.shift();
    return features;
  }

  function getStyleDirective() {
    if (_styleHistory.length < 3) return '';

    // 统计用户风格倾向
    var avgLen = _styleHistory.reduce(function(s, f) { return s + f.length; }, 0) / _styleHistory.length;
    var formalRatio = _styleHistory.filter(function(f) { return f.formal; }).length / _styleHistory.length;
    var casualRatio = _styleHistory.filter(function(f) { return f.casual; }).length / _styleHistory.length;
    var techRatio = _styleHistory.filter(function(f) { return f.technical; }).length / _styleHistory.length;
    var briefRatio = _styleHistory.filter(function(f) { return f.brief; }).length / _styleHistory.length;

    var hints = [];
    if (briefRatio > 0.6) hints.push('用户偏好简洁，回复尽量精炼');
    if (avgLen > 200) hints.push('用户习惯详细表达，回复可以充分展开');
    if (formalRatio > 0.5) hints.push('用户用语正式，回复保持专业');
    if (casualRatio > 0.5) hints.push('用户语气轻松，回复可以随意些');
    if (techRatio > 0.5) hints.push('用户关注技术，回复侧重技术细节');

    if (hints.length === 0) return '';
    return '\n\n【风格适配】' + hints.join('；') + '。';
  }

  // ═══════════════════════════════════════════
  // 5. 系统提示增强（核心输出）
  // ═══════════════════════════════════════════

  /**
   * enhanceSystemPrompt - 在系统提示末尾追加人格/情绪/关系/风格指令
   * @param {string} basePrompt - 原始系统提示
   * @param {string} userMessage - 当前用户消息（用于情绪/风格检测）
   * @returns {string} 增强后的系统提示
   */
  function enhanceSystemPrompt(basePrompt, userMessage) {
    var persona = getPersona();
    var additions = [];

    // 人格基调（始终注入，但很简短）
    var toneDesc = _buildToneDescription(persona);
    if (toneDesc) additions.push('【人格基调】' + toneDesc);

    // 情绪适配
    if (userMessage) {
      var userEmotion = detectUserEmotion(userMessage);
      if (userEmotion !== 'neutral') {
        updateEmotion(userEmotion, 0.6);
        var emotionDir = getEmotionDirective(userEmotion);
        if (emotionDir) additions.push(emotionDir.trim());
      }
      // 风格检测
      detectUserStyle(userMessage);
    }
    var styleDir = getStyleDirective();
    if (styleDir) additions.push(styleDir.trim());

    // 亲密度
    var intimacyDir = getIntimacyDirective();
    if (intimacyDir) additions.push(intimacyDir.trim());

    if (additions.length === 0) return basePrompt;
    return basePrompt + '\n\n' + additions.join('\n');
  }

  function _buildToneDescription(persona) {
    var parts = [];
    if (persona.humor > 60) parts.push('适度幽默');
    if (persona.formality > 60) parts.push('专业正式');
    else if (persona.formality < 30) parts.push('轻松随和');
    if (persona.extraversion > 70) parts.push('热情主动');
    else if (persona.extraversion < 30) parts.push('沉稳内敛');
    if (persona.agreeableness > 70) parts.push('善解人意');
    if (persona.openness > 70) parts.push('富有创造力');
    return parts.length > 0 ? '你的交流风格：' + parts.join('、') + '。' : '';
  }

  // ═══════════════════════════════════════════
  // 6. 预设角色模板
  // ═══════════════════════════════════════════
  var PRESETS = {
    'warm-friend': { name: '暖心朋友', openness: 65, conscientiousness: 50, extraversion: 75, agreeableness: 85, neuroticism: 25, humor: 70, proactiveness: 65, formality: 25 },
    'pro-assistant': { name: '专业助手', openness: 60, conscientiousness: 85, extraversion: 50, agreeableness: 65, neuroticism: 20, humor: 30, proactiveness: 60, formality: 70 },
    'tech-mentor': { name: '技术导师', openness: 80, conscientiousness: 70, extraversion: 55, agreeableness: 70, neuroticism: 20, humor: 45, proactiveness: 70, formality: 45 },
    'lively-companion': { name: '活泼伙伴', openness: 85, conscientiousness: 40, extraversion: 90, agreeableness: 80, neuroticism: 35, humor: 90, proactiveness: 75, formality: 15 }
  };

  function applyPreset(presetKey) {
    var preset = PRESETS[presetKey];
    if (!preset) return { success: false, error: '未知预设: ' + presetKey };
    var p = getPersona();
    Object.keys(preset).forEach(function(k) {
      if (k !== 'name' && k in DEFAULT_PERSONA) p[k] = preset[k];
    });
    _persona = p;
    _saveConfig();
    return { success: true, persona: p, presetName: preset.name };
  }

  function listPresets() {
    return Object.keys(PRESETS).map(function(k) {
      return { key: k, name: PRESETS[k].name };
    });
  }

  // ═══════════════════════════════════════════
  // 7. 持久化
  // ═══════════════════════════════════════════
  function _getConfigPath() {
    var dir = (Core && Core.DATA_ROOT) || path.join(__dirname, '..', 'data');
    return path.join(dir, 'persona.json');
  }

  function _saveConfig() {
    try {
      var file = _getConfigPath();
      var dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        persona: _persona,
        intimacy: _intimacy,
        emotion: { current: _emotionState.current, intensity: _emotionState.intensity },
        updatedAt: Date.now()
      }, null, 2), 'utf8');
    } catch (e) {}
  }

  function _loadConfig() {
    try {
      var file = _getConfigPath();
      if (!fs.existsSync(file)) return;
      var data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.persona) _persona = Object.assign({}, DEFAULT_PERSONA, data.persona);
      if (data.intimacy) _intimacy = Object.assign(_intimacy, data.intimacy);
      if (data.emotion) {
        _emotionState.current = data.emotion.current || 'neutral';
        _emotionState.intensity = data.emotion.intensity || 0.5;
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════
  // Module init
  // ═══════════════════════════════════════════
  function init(_Core) {
    Core = _Core;
    _loadConfig();

    Core.persona = {
      getPersona: getPersona,
      setPersona: setPersona,
      resetPersona: resetPersona,
      getEmotionState: getEmotionState,
      updateEmotion: updateEmotion,
      detectUserEmotion: detectUserEmotion,
      getEmotionDirective: getEmotionDirective,
      getIntimacy: getIntimacy,
      recordInteraction: recordInteraction,
      detectUserStyle: detectUserStyle,
      getStyleDirective: getStyleDirective,
      enhanceSystemPrompt: enhanceSystemPrompt,
      applyPreset: applyPreset,
      listPresets: listPresets,
      EMOTIONS: EMOTIONS,
      INTIMACY_LEVELS: INTIMACY_LEVELS,
      PRESETS: PRESETS
    };
    console.log('[persona] initialized (level: ' + _getIntimacyLevel().name + ', emotion: ' + _emotionState.current + ')');
  }

  module.exports = { name: 'persona', dependencies: [], init: init };
})();
