// modules/error-recovery.js - 错误恢复增强：自动重试、指数退避、优雅降级、连接健康检查
let Core = null;

// ===== 配置 =====
const CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 15000,
  CIRCUIT_THRESHOLD: 5,      // 连续失败 N 次后触发断路
  CIRCUIT_RESET_MS: 60000,   // 断路 60 秒后半开
  HEALTH_CHECK_INTERVAL: 30000, // 30 秒健康检查
  OLLAMA_URL: 'http://127.0.0.1:11434',
  HEALTH_TIMEOUT_MS: 5000,
};

// ===== 断路器状态 =====
var _circuits = {}; // { provider: { failures, state, lastFailTime } }
// state: 'closed'(正常) | 'open'(断路) | 'half-open'(半开试探)

// ===== 连接状态 =====
var _healthStatus = {
  ollama: { online: null, lastCheck: 0, latency: null, model: null },
  cloud: {} // { provider: { online, lastCheck, latency } }
};
var _healthTimer = null;

function init(_Core) {
  Core = _Core;

  Core.recovery = {
    withRetry,
    checkHealth,
    getHealthStatus,
    getCircuitState,
    resetCircuit,
    getRetryAdvice,
    getFallbackProvider,
    CONFIG,
  };

  // 启动定期健康检查
  startHealthMonitor();

  // 命令注册（已声明 custom 依赖）
  if (Core.custom && Core.custom.registerCommand) {
    Core.custom.registerCommand('/health', function(args) {
      return handleHealthCommand(args);
    }, '连接健康检查 — 检测 Ollama 和云端服务状态');
  }

  // 初始检查一次
  setTimeout(function() { checkAllHealth(); }, 3000);

  console.log('✅ 错误恢复模块已加载');
}

// ===== 断路器 =====
function getCircuit(provider) {
  if (!_circuits[provider]) {
    _circuits[provider] = { failures: 0, state: 'closed', lastFailTime: 0 };
  }
  return _circuits[provider];
}

function recordSuccess(provider) {
  var c = getCircuit(provider);
  c.failures = 0;
  c.state = 'closed';
}

function recordFailure(provider) {
  var c = getCircuit(provider);
  c.failures++;
  c.lastFailTime = Date.now();
  if (c.failures >= CONFIG.CIRCUIT_THRESHOLD) {
    c.state = 'open';
    console.warn('⚡ 断路器 OPEN: ' + provider + ' (连续失败 ' + c.failures + ' 次)');
  }
}

function canRetry(provider) {
  var c = getCircuit(provider);
  if (c.state === 'closed') return true;
  if (c.state === 'open') {
    // 检查是否过了冷却期
    if (Date.now() - c.lastFailTime >= CONFIG.CIRCUIT_RESET_MS) {
      c.state = 'half-open';
      console.log('🔄 断路器 HALF-OPEN: ' + provider + ' (尝试恢复)');
      return true;
    }
    return false;
  }
  // half-open 允许一次试探
  return true;
}

function resetCircuit(provider) {
  if (provider) {
    delete _circuits[provider];
  } else {
    _circuits = {};
  }
}

function getCircuitState(provider) {
  if (!provider) {
    var result = {};
    Object.keys(_circuits).forEach(function(k) {
      result[k] = { state: _circuits[k].state, failures: _circuits[k].failures };
    });
    return result;
  }
  var c = getCircuit(provider);
  return { state: c.state, failures: c.failures };
}

// ===== 指数退避 =====
function getRetryDelay(attempt) {
  // 指数退避 + 随机抖动
  var delay = CONFIG.BASE_DELAY_MS * Math.pow(2, attempt);
  delay = Math.min(delay, CONFIG.MAX_DELAY_MS);
  // 添加 0~30% 的随机抖动
  delay += Math.floor(Math.random() * delay * 0.3);
  return delay;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ===== 核心重试包装器 =====
async function withRetry(fn, options) {
  options = options || {};
  var maxRetries = options.maxRetries != null ? options.maxRetries : CONFIG.MAX_RETRIES;
  var provider = options.provider || 'unknown';
  var onRetry = options.onRetry || null;
  var silent = options.silent || false;

  // 断路器检查
  if (!canRetry(provider)) {
    var c = getCircuit(provider);
    var waitSec = Math.ceil((CONFIG.CIRCUIT_RESET_MS - (Date.now() - c.lastFailTime)) / 1000);
    throw new Error('⚡ 服务暂时不可用 (' + provider + ')，已断路保护。请 ' + waitSec + ' 秒后重试，或使用 /health 检查连接。');
  }

  var lastError = null;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      var result = await fn(attempt);
      recordSuccess(provider);
      return result;
    } catch (err) {
      lastError = err;
      var errMsg = err.message || String(err);

      // 不可重试的错误直接抛出
      if (isNonRetryable(err)) {
        recordFailure(provider);
        throw err;
      }

      if (attempt < maxRetries && canRetry(provider)) {
        var delay = getRetryDelay(attempt);
        if (!silent) {
          console.warn('🔄 重试 ' + (attempt + 1) + '/' + maxRetries + ' (' + provider + ')，' + (delay / 1000).toFixed(1) + ' 秒后...');
          if (onRetry) onRetry(attempt + 1, maxRetries, delay);
        }
        recordFailure(provider);
        await sleep(delay);
      } else {
        recordFailure(provider);
        break;
      }
    }
  }

  // 所有重试均失败
  throw lastError;
}

// ===== 错误分类 =====
function isNonRetryable(err) {
  var msg = (err.message || '').toLowerCase();
  // 认证失败、参数错误、模型不存在 — 不可重试
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) return true;
  if (msg.includes('400') || msg.includes('bad request')) return true;
  if (msg.includes('404') && msg.includes('model')) return true;
  if (msg.includes('invalid_api_key') || msg.includes('api key')) return true;
  if (msg.includes('rate_limit') || msg.includes('429')) return false; // 限速可以重试
  if (msg.includes('aborted') || err.name === 'AbortError') return true;
  return false;
}

function classifyError(err) {
  var msg = (err.message || '').toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network')) {
    return { type: 'connection', label: '连接失败', suggestion: '请检查服务是否启动' };
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
    return { type: 'timeout', label: '请求超时', suggestion: '服务可能繁忙，请稍后重试' };
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
    return { type: 'auth', label: '认证失败', suggestion: '请检查 API Key 是否正确' };
  }
  if (msg.includes('429') || msg.includes('rate_limit')) {
    return { type: 'ratelimit', label: '频率限制', suggestion: '请求过于频繁，请稍后重试' };
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return { type: 'server', label: '服务端错误', suggestion: '服务端暂时不可用' };
  }
  if (msg.includes('model') && msg.includes('not found')) {
    return { type: 'model', label: '模型不存在', suggestion: '请检查模型名称或先下载模型' };
  }
  return { type: 'unknown', label: '未知错误', suggestion: '请查看控制台日志' };
}

// ===== 健康检查 =====
async function checkOllamaHealth() {
  var start = Date.now();
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CONFIG.HEALTH_TIMEOUT_MS);
    var resp = await fetch(CONFIG.OLLAMA_URL + '/api/tags', {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache' }
    });
    clearTimeout(timer);
    var latency = Date.now() - start;
    if (resp.ok) {
      var data = await resp.json();
      var models = data.models || [];
      _healthStatus.ollama = {
        online: true,
        lastCheck: Date.now(),
        latency: latency,
        models: models.length,
        modelList: models.slice(0, 10).map(function(m) { return m.name; })
      };
      recordSuccess('ollama');
      return _healthStatus.ollama;
    } else {
      _healthStatus.ollama = { online: false, lastCheck: Date.now(), latency: latency, error: 'HTTP ' + resp.status };
      return _healthStatus.ollama;
    }
  } catch (err) {
    _healthStatus.ollama = { online: false, lastCheck: Date.now(), latency: Date.now() - start, error: err.message };
    return _healthStatus.ollama;
  }
}

async function checkCloudHealth(provider) {
  if (!Core.cloudApi || !Core.cloudApi.testConnection) {
    // 没有测试方法，尝试简单 ping
    _healthStatus.cloud[provider] = { online: null, lastCheck: Date.now(), error: '无测试方法' };
    return _healthStatus.cloud[provider];
  }
  var start = Date.now();
  try {
    var ok = await Core.cloudApi.testConnection(provider);
    var latency = Date.now() - start;
    _healthStatus.cloud[provider] = {
      online: !!ok,
      lastCheck: Date.now(),
      latency: latency
    };
    if (ok) recordSuccess(provider);
    return _healthStatus.cloud[provider];
  } catch (err) {
    _healthStatus.cloud[provider] = { online: false, lastCheck: Date.now(), latency: Date.now() - start, error: err.message };
    return _healthStatus.cloud[provider];
  }
}

async function checkHealth(provider) {
  if (!provider || provider === 'ollama') {
    return await checkOllamaHealth();
  }
  return await checkCloudHealth(provider);
}

async function checkAllHealth() {
  var results = { ollama: null, cloud: {} };
  // Ollama
  results.ollama = await checkOllamaHealth();
  // 云端 providers — 只检查已配置了 key 的
  if (Core.cloudApi && Core.cloudApi.getAvailableProviders) {
    try {
      var providers = Core.cloudApi.getAvailableProviders();
      for (var i = 0; i < providers.length; i++) {
        results.cloud[providers[i]] = await checkCloudHealth(providers[i]);
      }
    } catch (e) { console.warn('⚠️ [error-recovery] 操作失败:', e.message || e); }
  }
  return results;
}

function getHealthStatus() {
  return JSON.parse(JSON.stringify(_healthStatus));
}

// ===== 健康监控 =====
function startHealthMonitor() {
  if (_healthTimer) clearInterval(_healthTimer);
  _healthTimer = setInterval(function() {
    // 只检查最近活跃过的 provider
    checkOllamaHealth().catch(function(e) { console.warn('[Recovery] Health check error:', e.message); });
  }, CONFIG.HEALTH_CHECK_INTERVAL);
}

// ===== 降级策略 =====
function getFallbackProvider(currentProvider) {
  // 优先降级到 Ollama（本地优先），然后是其他云端
  if (currentProvider !== 'ollama') {
    // 检查 Ollama 是否可用
    if (_healthStatus.ollama && _healthStatus.ollama.online) {
      return 'ollama';
    }
  }
  // 尝试其他云端 provider
  if (Core.cloudApi && Core.cloudApi.getAvailableProviders) {
    try {
      var providers = Core.cloudApi.getAvailableProviders();
      for (var i = 0; i < providers.length; i++) {
        if (providers[i] !== currentProvider) {
          var c = getCircuit(providers[i]);
          if (c.state === 'closed') return providers[i];
        }
      }
    } catch (e) { /* 可忽略：清理路径，失败不影响主流程 */ }
  }
  return null;
}

function getRetryAdvice(err, provider) {
  var classified = classifyError(err);
  var advice = {
    error: classified,
    canRetry: !isNonRetryable(err),
    circuit: getCircuitState(provider),
    fallback: null,
    suggestions: []
  };

  if (classified.type === 'connection') {
    if (provider === 'ollama') {
      advice.suggestions.push('确认 Ollama 是否启动：运行 ollama serve');
      advice.suggestions.push('检查端口 11434 是否被占用');
    } else {
      advice.suggestions.push('检查网络连接');
      advice.suggestions.push('确认 API Key 是否有效');
    }
  }

  if (classified.type === 'timeout') {
    advice.suggestions.push('模型可能较大，尝试切换更快的模型');
    advice.suggestions.push('检查系统资源使用情况');
  }

  if (classified.type === 'auth') {
    advice.suggestions.push('在设置中检查并更新 API Key');
    advice.suggestions.push('确认 Key 未过期且有足够额度');
  }

  if (classified.type === 'ratelimit') {
    advice.suggestions.push('等待一段时间后重试');
    advice.suggestions.push('考虑切换到其他 provider');
  }

  // 建议降级
  var fallback = getFallbackProvider(provider);
  if (fallback) {
    advice.fallback = fallback;
    advice.suggestions.push('可以临时切换到 ' + fallback);
  }

  return advice;
}

// ===== /health 命令 =====
async function handleHealthCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = parts[0] || '';

  Core.dom.status.textContent = '🔍 正在检查连接状态...';

  try {
    var results = await checkAllHealth();
    var lines = [];
    lines.push('🏥 连接健康检查报告');
    lines.push('═'.repeat(40));

    // Ollama
    var ollama = results.ollama;
    var ollamaIcon = ollama.online ? '🟢' : '🔴';
    lines.push(ollamaIcon + ' Ollama (本地)');
    if (ollama.online) {
      lines.push('   延迟: ' + ollama.latency + 'ms | 模型数: ' + ollama.models);
      if (ollama.modelList && ollama.modelList.length > 0) {
        lines.push('   可用: ' + ollama.modelList.slice(0, 5).join(', '));
      }
    } else {
      lines.push('   状态: 离线 — ' + (ollama.error || '无法连接'));
      lines.push('   建议: 运行 ollama serve 启动服务');
    }
    lines.push('');

    // 云端
    var cloudKeys = Object.keys(results.cloud);
    if (cloudKeys.length > 0) {
      lines.push('☁️ 云端服务');
      cloudKeys.forEach(function(p) {
        var s = results.cloud[p];
        var icon = s.online === true ? '🟢' : s.online === false ? '🔴' : '🟡';
        var latencyStr = s.latency ? ' | ' + s.latency + 'ms' : '';
        var errStr = s.error ? ' — ' + s.error : '';
        lines.push('  ' + icon + ' ' + p + latencyStr + errStr);
      });
    } else {
      lines.push('☁️ 云端服务: 未配置');
      lines.push('   在设置中添加 API Key 以启用云端模型');
    }
    lines.push('');

    // 断路器状态
    var circuits = getCircuitState();
    var circuitKeys = Object.keys(circuits);
    if (circuitKeys.length > 0) {
      lines.push('⚡ 断路器状态');
      circuitKeys.forEach(function(k) {
        var c = circuits[k];
        var icon = c.state === 'closed' ? '✅' : c.state === 'open' ? '🚫' : '🔄';
        lines.push('  ' + icon + ' ' + k + ': ' + c.state + ' (失败 ' + c.failures + ' 次)');
      });
    }

    Core.dom.status.textContent = '✅ 健康检查完成';
    return lines.join('\n');
  } catch (err) {
    Core.dom.status.textContent = '❌ 健康检查失败';
    return '❌ 健康检查失败: ' + err.message;
  }
}

module.exports = { init };
