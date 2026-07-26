// modules/crypto-utils.js — 统一的加密/解密工具（消除 core-v10.js 与 web-server.js 重复）
// ============================================================================
// Phase 3 加密后端：
//   enc:v2: —— Electron safeStorage（OS 钥匙串：Windows DPAPI / macOS Keychain / Linux libsecret）
//              首选后端。密钥由操作系统保护，不再依赖「hostname+硬编码 salt」这种源码一读即可破解的弱方案，
//              且对「改计算机名」等无关变更鲁棒。
//   enc:v1: —— AES-256-GCM + PBKDF2（机器身份派生密钥）。保留作为：
//              (a) safeStorage 不可用时的降级后端；
//              (b) web-server.js 等纯 Node 环境（无 Electron safeStorage）；
//              (c) 旧密文的向后兼容解密。
//
// 解密失败语义：decryptValue 失败统一返回 ''（保持与 core-v10.js 既有检测逻辑兼容），
//              由调用方（core-v10.js loadConfig）负责把「密钥无法解密」明确提示给用户，不再静默变空。
// ============================================================================

const ENC_PREFIX = 'enc:v1:';      // 旧后端（AES-GCM 机器身份密钥），保留兼容
const ENC_PREFIX_V2 = 'enc:v2:';   // 新后端（safeStorage）
const ENC_PREFIXES = [ENC_PREFIX, ENC_PREFIX_V2];

// 合并后的完整字段列表（消除两处不一致的 bug）
// 🔧 B2: 单一真相源——main.js / backup.js 的备份脱敏必须引用本列表，禁止各自硬编码
// bingSearchKey / unsplashKey 为 image-search.js 真实使用的密钥字段，此前遗漏导致明文存储
const SENSITIVE_KEY_FIELDS = [
  'deepseekKey', 'qwenKey', 'doubaoKey', 'customKey',
  'bochaApiKey', 'tavilyApiKey', 'siliconFlowKey', 'openaiImageKey',
  'bingSearchKey', 'unsplashKey'
];

let _crypto = null;
try { _crypto = require('crypto'); } catch (e) { console.warn('[crypto-utils] crypto 模块不可用'); }

// 🔒 Phase 3: 探测 safeStorage。渲染进程经 _bridgeRequire('electron') 拿到 electronAPIBridge.safeStorage；
//    纯 Node 环境（web-server.js）require('electron') 返回字符串路径，无 safeStorage → null → 自动降级 v1。
let _safeStorage = null;
try {
  const electron = require('electron');
  if (electron && electron.safeStorage && typeof electron.safeStorage.encryptString === 'function') {
    _safeStorage = electron.safeStorage;
  }
} catch (e) { _safeStorage = null; }

let _cachedKey = null;

// 判断字符串是否为任一格式的密文
function isEncryptedValue(value) {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < ENC_PREFIXES.length; i++) {
    if (value.startsWith(ENC_PREFIXES[i])) return true;
  }
  return false;
}

// safeStorage 是否可用作加密后端
function _safeStorageReady() {
  if (!_safeStorage) return false;
  try {
    if (typeof _safeStorage.isEncryptionAvailable === 'function') {
      return _safeStorage.isEncryptionAvailable() === true;
    }
    return true;
  } catch (e) { return false; }
}

// ===== v1 后端：AES-256-GCM + PBKDF2（机器身份派生密钥）=====
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

function _encryptV1(plainText) {
  if (!_crypto) return null;
  try {
    const key = _deriveKey();
    if (!key) return null;
    const iv = _crypto.randomBytes(12);
    const cipher = _crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return ENC_PREFIX + iv.toString('hex') + '.' + authTag + '.' + encrypted;
  } catch (e) {
    console.warn('[crypto-utils] v1 加密失败:', e.message);
    return null;
  }
}

function _decryptV1(encryptedText) {
  if (!_crypto) return '';
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
    console.warn('[crypto-utils] v1 解密失败（可能密钥已变更）:', e.message);
    return '';
  }
}

// ===== v2 后端：safeStorage（OS 钥匙串）=====
function _encryptV2(plainText) {
  if (!_safeStorageReady()) return null;
  try {
    const b64 = _safeStorage.encryptString(plainText);
    if (b64 && !b64.error && typeof b64 === 'string') {
      return ENC_PREFIX_V2 + b64;
    }
    return null;
  } catch (e) {
    console.warn('[crypto-utils] v2 加密失败:', e.message);
    return null;
  }
}

function _decryptV2(encryptedText) {
  if (!_safeStorage) return '';  // 纯 Node 环境无 safeStorage，无法解密 v2
  try {
    const b64 = encryptedText.substring(ENC_PREFIX_V2.length);
    const result = _safeStorage.decryptString(b64);
    if (result && !result.error && typeof result === 'string') {
      return result;
    }
    console.warn('[crypto-utils] v2 解密失败:', (result && result.error) || '未知错误');
    return '';
  } catch (e) {
    console.warn('[crypto-utils] v2 解密失败:', e.message);
    return '';
  }
}

// ===== 对外统一入口 =====
function encryptValue(plainText) {
  if (!plainText || typeof plainText !== 'string' || isEncryptedValue(plainText)) {
    return plainText;
  }
  // 首选 safeStorage（v2），不可用则降级 v1
  const v2 = _encryptV2(plainText);
  if (v2) return v2;
  const v1 = _encryptV1(plainText);
  if (v1) return v1;
  // 两个后端都失败：返回明文（与旧行为一致，避免数据丢失）
  console.warn('[crypto-utils] 加密失败：safeStorage 与 v1 后端均不可用，保留明文');
  return plainText;
}

function decryptValue(encryptedText) {
  if (!encryptedText || typeof encryptedText !== 'string') {
    return encryptedText;
  }
  if (encryptedText.startsWith(ENC_PREFIX_V2)) {
    return _decryptV2(encryptedText);
  }
  if (encryptedText.startsWith(ENC_PREFIX)) {
    return _decryptV1(encryptedText);
  }
  // 非密文，原样返回
  return encryptedText;
}

function encryptSensitiveFields(config) {
  const result = { ...config };
  for (const field of SENSITIVE_KEY_FIELDS) {
    if (result[field] && typeof result[field] === 'string' && !isEncryptedValue(result[field])) {
      result[field] = encryptValue(result[field]);
    }
  }
  return result;
}

function decryptSensitiveFields(config) {
  const result = { ...config };
  for (const field of SENSITIVE_KEY_FIELDS) {
    if (result[field] && typeof result[field] === 'string' && isEncryptedValue(result[field])) {
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
    ENC_PREFIX_V2: ENC_PREFIX_V2,
    ENC_PREFIXES: ENC_PREFIXES,
    SENSITIVE_KEY_FIELDS: SENSITIVE_KEY_FIELDS,
    isEncryptedValue: isEncryptedValue,
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
    ENC_PREFIX_V2: ENC_PREFIX_V2,
    ENC_PREFIXES: ENC_PREFIXES,
    SENSITIVE_KEY_FIELDS: SENSITIVE_KEY_FIELDS,
    isEncryptedValue: isEncryptedValue,
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
  _Core.isEncryptedValue = isEncryptedValue;
  var backend = _safeStorageReady() ? 'safeStorage(v2)' : 'AES-GCM(v1)';
  console.log('[crypto-utils] 加密工具已加载（' + SENSITIVE_KEY_FIELDS.length + ' 个敏感字段，主后端：' + backend + '）');
};
