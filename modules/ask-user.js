// modules/ask-user.js - 交互式结构化问答模块
// 让 AI 在执行复杂任务前通过结构化问题收集用户偏好
// 支持单选、多选、自由文本三种模式

var Core = null;

// 当前活跃的问答状态
var activeQuestion = null;  // { resolve, params, container }

// ═══════════════════════════════════════════
// 核心 API
// ═══════════════════════════════════════════

/**
 * 向用户展示结构化问题并等待回答
 * @param {Object} params - 问题参数
 * @param {string} params.question - 问题文本
 * @param {Array} params.options - 选项列表 [{label, description, preview}]
 * @param {boolean} params.multiSelect - 是否多选，默认 false
 * @param {string} params.header - 问题分类标签（短文本）
 * @param {HTMLElement} parentEl - 挂载的父元素（通常是 agentDiv）
 * @returns {Promise<Object>} 用户回答 {answers: {header: selectedLabel}, customText: string}
 */
function askUser(params, parentEl) {
  return new Promise(function(resolve) {
    if (!params || !params.question) {
      resolve({ cancelled: true, reason: '无效的问题参数' });
      return;
    }

    // 如果已有活跃问题，先取消
    if (activeQuestion) {
      activeQuestion.resolve({ cancelled: true, reason: '被新问题覆盖' });
      cleanupUI(activeQuestion.container);
    }

    var container = createQuestionUI(params, parentEl);
    activeQuestion = { resolve: resolve, params: params, container: container };
  });
}

/**
 * 处理用户的回答（由 UI 按钮点击触发）
 */
function submitAnswer(answers, customText) {
  if (!activeQuestion) return;
  var resolve = activeQuestion.resolve;
  cleanupUI(activeQuestion.container);
  activeQuestion = null;
  resolve({ answers: answers, customText: customText || '', cancelled: false });
}

/**
 * 取消当前问答
 */
function cancelQuestion() {
  if (!activeQuestion) return;
  var resolve = activeQuestion.resolve;
  cleanupUI(activeQuestion.container);
  activeQuestion = null;
  resolve({ cancelled: true, reason: '用户取消' });
}

/**
 * 检查是否有活跃的问答
 */
function isActive() {
  return activeQuestion !== null;
}

// ═══════════════════════════════════════════
// UI 创建
// ═══════════════════════════════════════════

function createQuestionUI(params, parentEl) {
  var question = params.question || '';
  var options = params.options || [];
  var multiSelect = !!params.multiSelect;
  var header = params.header || '';

  // 创建容器
  var wrapper = document.createElement('div');
  wrapper.className = 'ask-user-question';
  wrapper.setAttribute('data-ask-id', Date.now());

  // 问题卡片
  var card = document.createElement('div');
  card.className = 'ask-user-card';

  // 头部标签
  if (header) {
    var tag = document.createElement('span');
    tag.className = 'ask-user-tag';
    tag.textContent = header;
    card.appendChild(tag);
  }

  // 问题文本
  var qEl = document.createElement('div');
  qEl.className = 'ask-user-question-text';
  qEl.textContent = question;
  card.appendChild(qEl);

  // 选项列表
  var selections = {};  // index -> true/false
  if (options.length > 0) {
    var optionsList = document.createElement('div');
    optionsList.className = 'ask-user-options';

    options.forEach(function(opt, idx) {
      var optEl = document.createElement('div');
      optEl.className = 'ask-user-option';
      optEl.setAttribute('data-index', idx);
      optEl.setAttribute('data-label', opt.label || '');

      // 选择指示器
      var indicator = document.createElement('span');
      indicator.className = 'ask-user-indicator';
      indicator.textContent = multiSelect ? '☐' : '○';
      optEl.appendChild(indicator);

      // 选项内容
      var content = document.createElement('div');
      content.className = 'ask-user-option-content';

      var label = document.createElement('div');
      label.className = 'ask-user-option-label';
      label.textContent = opt.label || '';
      content.appendChild(label);

      if (opt.description) {
        var desc = document.createElement('div');
        desc.className = 'ask-user-option-desc';
        desc.textContent = opt.description;
        content.appendChild(desc);
      }

      if (opt.preview) {
        var preview = document.createElement('pre');
        preview.className = 'ask-user-option-preview';
        preview.textContent = opt.preview;
        content.appendChild(preview);
      }

      optEl.appendChild(content);

      // 点击选择
      optEl.addEventListener('click', function() {
        if (multiSelect) {
          selections[idx] = !selections[idx];
          optEl.classList.toggle('selected', selections[idx]);
          indicator.textContent = selections[idx] ? '☑' : '☐';
        } else {
          // 单选：取消其他选择
          optionsList.querySelectorAll('.ask-user-option').forEach(function(el) {
            el.classList.remove('selected');
            el.querySelector('.ask-user-indicator').textContent = '○';
          });
          selections = {};
          selections[idx] = true;
          optEl.classList.add('selected');
          indicator.textContent = '●';
        }
      });

      optionsList.appendChild(optEl);
    });

    card.appendChild(optionsList);
  }

  // 自由文本输入（"其他"选项）
  var inputArea = document.createElement('div');
  inputArea.className = 'ask-user-input-area';

  var textInput = document.createElement('textarea');
  textInput.className = 'ask-user-textinput';
  textInput.placeholder = options.length > 0 ? '或输入自定义回答...' : '请输入您的回答...';
  textInput.rows = 2;
  inputArea.appendChild(textInput);

  card.appendChild(inputArea);

  // 按钮行
  var btnRow = document.createElement('div');
  btnRow.className = 'ask-user-btn-row';

  var submitBtn = document.createElement('button');
  submitBtn.className = 'ask-user-submit-btn';
  submitBtn.textContent = '确认提交';
  submitBtn.addEventListener('click', function() {
    var customText = textInput.value.trim();
    var answers = {};

    if (options.length > 0) {
      var selectedLabels = [];
      Object.keys(selections).forEach(function(idx) {
        if (selections[idx]) {
          selectedLabels.push(options[parseInt(idx)].label);
        }
      });
      if (selectedLabels.length > 0) {
        answers[header || 'question'] = selectedLabels.join(', ');
      }
    }

    // 如果没有选择选项但有自定义文本
    if (Object.keys(answers).length === 0 && customText) {
      answers[header || 'question'] = customText;
      customText = '';
    }

    if (Object.keys(answers).length === 0 && !customText) {
      textInput.style.borderColor = '#ef4444';
      textInput.placeholder = '请至少选择一个选项或输入回答';
      return;
    }

    submitAnswer(answers, customText);
  });

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'ask-user-cancel-btn';
  cancelBtn.textContent = '跳过';
  cancelBtn.addEventListener('click', function() {
    cancelQuestion();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(submitBtn);
  card.appendChild(btnRow);

  wrapper.appendChild(card);

  // 挂载到父元素或聊天容器
  var parent = parentEl || document.getElementById('chatContainer');
  if (parent) {
    parent.appendChild(wrapper);
    // 滚动到问答组件
    setTimeout(function() {
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  return wrapper;
}

/**
 * 清理 UI
 */
function cleanupUI(container) {
  if (!container) return;
  // 替换为已回答状态
  var answered = document.createElement('div');
  answered.className = 'ask-user-answered';
  answered.textContent = '✓ 已回答';
  if (container.parentNode) {
    container.parentNode.replaceChild(answered, container);
  }
}

// ═══════════════════════════════════════════
// /ask 命令
// ═══════════════════════════════════════════

function handleAskCommand(args) {
  var parts = (args || '').trim().split('|');
  var question = parts[0] || '';
  var options = parts.slice(1).map(function(s) {
    return { label: s.trim() };
  }).filter(function(o) { return o.label; });

  if (!question) {
    return '用法: /ask <问题文本>[|选项1|选项2|选项3]\n示例: /ask 你喜欢哪种编程语言?|Python|JavaScript|Go|其他';
  }

  return askUser({
    question: question,
    options: options.length > 0 ? options : [],
    multiSelect: false,
    header: '手动提问'
  }).then(function(result) {
    if (result.cancelled) return '❌ 问答已取消';
    var ans = result.answers || {};
    var text = Object.keys(ans).map(function(k) { return k + ': ' + ans[k]; }).join(', ');
    return '📋 用户回答: ' + (text || result.customText || '(空)');
  });
}

// ═══════════════════════════════════════════
// 格式化回答（供 Agent 使用）
// ═══════════════════════════════════════════

function formatAnswerForAgent(result) {
  if (!result) return '(无回答)';
  if (result.cancelled) return '(用户跳过了此问题)';

  var parts = [];
  if (result.answers) {
    Object.keys(result.answers).forEach(function(key) {
      parts.push(key + ': ' + result.answers[key]);
    });
  }
  if (result.customText) {
    parts.push('补充说明: ' + result.customText);
  }
  return parts.join('; ') || '(空回答)';
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.askUser = {
      ask: askUser,
      submit: submitAnswer,
      cancel: cancelQuestion,
      isActive: isActive,
      formatAnswer: formatAnswerForAgent,
      handleCommand: handleAskCommand
    };

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/ask', function(args) {
        return handleAskCommand(args);
      });
    }

    console.log('✅ 交互式问答模块已加载');
  }
};
