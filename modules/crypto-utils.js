// modules/crypto-utils.js — 统一的加密/解密工具（消除 core-v10.js 与 web-server.js 重复）
// 使用 AES-256-GCM + PBKDF2 从机器信息派生密钥

const ENC_PREFIX = 'enc:v1:';

// 合并后的完整字段列表（消除两处不一致的 bug）
const SENSITIVE_KEY_FIELDS = [
  'deepseekKey', 'qwenKey', 'doubaoKey', 'customKey',
  'bochaApiKey', 'tavilyApiKey', 'siliconFlowKey', 'openaiImageKey'
];

let _crypto = null;
try { _crypto = require('crypto'); } catch (e) { console.warn('[crypto-utils] crypto 模块不可用'); }

let _cachedKey = null;

function _deriveKey() {
  if (!_crypto) return null;
  if (_cachedKey) return _cachedKey;
  try {
    const os = require('os');
    const salt = 'ai-agent-pro-key-salt-2026';
    const machineId = os.hostname() + '|' + os.userInfo().username + '|' + os.platform() + '|' + os.arch();
    _cachedKey = _crypto.pbkdf2Sync(machineId, salt, 10000, 32, 'sha256');
    return _cachedKey;
  } catch (e) {
    console.warn('[crypto-utils] 密钥派生失败:', e.message);
    return null;
  }
}

function encryptValue(plainText) {
  if (!_crypto || !plainText || typeof plainText !== 'string' || plainText.startsWith(ENC_PREFIX)) {
    return plainText;
  }
  try {
    const key = _deriveKey();
    if (!key) return plainText;
    const iv = _crypto.randomBytes(12);
    const cipher = _crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return ENC_PREFIX + iv.toString('hex') + '.' + authTag + '.' + encrypted;
  } catch (e) {
    console.warn('[crypto-utils] 加密失败:', e.message);
    return plainText;
  }
}

function decryptValue(encryptedText) {
  if (!_crypto || !encryptedText || typeof encryptedText !== 'string' || !encryptedText.startsWith(ENC_PREFIX)) {
    return encryptedText;
  }
  try {
    const key = _deriveKey();
    if (!key) return '';
    const payload = encryptedText.substring(ENC_PREFIX.length);
    const parts = payload.split('.');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = _crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.warn('[crypto-utils] 解密失败（可能密钥已变更）:', e.message);
    return '';
  }
}

function encryptSensitiveFields(config) {
  const result = { ...config };
  for (const field of SENSITIVE_KEY_FIELDS) {
    if (result[field] && typeof result[field] === 'string' && !result[field].startsWith(ENC_PREFIX)) {
      result[field] = encryptValue(result[field]);
    }
  }
  return result;
}

function decryptSensitiveFields(config) {
  const result = { ...config };
  for (const field of SENSITIVE_KEY_FIELDS) {
    if (result[field] && typeof result[field] === 'string' && result[field].startsWith(ENC_PREFIX)) {
      result[field] = decryptValue(result[field]);
    }
  }
  return result;
}

// Node.js require 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    name: 'crypto-utils',
    dependencies: [],
    ENC_PREFIX: ENC_PREFIX,
    SENSITIVE_KEY_FIELDS: SENSITIVE_KEY_FIELDS,
    encryptValue: encryptValue,
    decryptValue: decryptValue,
    encryptSensitiveFields: encryptSensitiveFields,
    decryptSensitiveFields: decryptSensitiveFields,
  };
}

// 模块 init（供 Core.loadModules 调用）
module.exports.init = function(_Core) {
  _Core.cryptoUtils = {
    ENC_PREFIX: ENC_PREFIX,
    SENSITIVE_KEY_FIELDS: SENSITIVE_KEY_FIELDS,
    encryptValue: encryptValue,
    decryptValue: decryptValue,
    encryptSensitiveFields: encryptSensitiveFields,
    decryptSensitiveFields: decryptSensitiveFields,
  };
  // 同时挂载顶层函数（兼容 core-v10.js 内部直接调用）
  _Core.encryptValue = encryptValue;
  _Core.decryptValue = decryptValue;
  _Core.encryptSensitiveFields = encryptSensitiveFields;
  _Core.decryptSensitiveFields = decryptSensitiveFields;
  console.log('[crypto-utils] 加密工具已加载（' + SENSITIVE_KEY_FIELDS.length + ' 个敏感字段）');
};
