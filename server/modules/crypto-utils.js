// server/modules/crypto-utils.js — AES-256-GCM encryption for API keys
var crypto = require('crypto');
var os = require('os');

var ALGO = 'aes-256-gcm';
var IV_LEN = 12;
var TAG_LEN = 16;

function _deriveKey(password) {
  var salt = 'ai-agent-pro-' + os.hostname();
  return crypto.pbkdf2Sync(password || 'default-key-2024', salt, 10000, 32, 'sha256');
}

function encrypt(text, password) {
  if (!text) return '';
  var key = _deriveKey(password);
  var iv = crypto.randomBytes(IV_LEN);
  var cipher = crypto.createCipheriv(ALGO, key, iv);
  var encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  var tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

function decrypt(ciphertext, password) {
  if (!ciphertext || ciphertext.indexOf(':') === -1) return ciphertext || '';
  var parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;
  try {
    var key = _deriveKey(password);
    var iv = Buffer.from(parts[0], 'hex');
    var tag = Buffer.from(parts[1], 'hex');
    var decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(parts[2], 'hex', 'utf8') + decipher.final('utf8');
  } catch (e) {
    return '';
  }
}

module.exports = {
  name: 'crypto-utils',
  dependencies: [],
  init: function(Core) {
    Core.registerModule('crypto', { encrypt: encrypt, decrypt: decrypt });
  },
  encrypt: encrypt,
  decrypt: decrypt
};
