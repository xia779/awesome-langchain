// server/core.js — Server-side Core object (event bus + config + module registry)
// API-compatible with Electron Core: emit/on/off/saveConfig
const fs = require('fs');
const path = require('path');

const DATA_ROOT = process.env.AI_DATA_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE || '.', '.ai-agent-data');

const Core = {
  DATA_ROOT: DATA_ROOT,
  USERS_ROOT: path.join(DATA_ROOT, 'users'),
  config: {},
  events: {},
  _emitDepth: 0,
  _MAX_EMIT_DEPTH: 5,

  // Event system — identical to Electron Core
  on: function(event, cb) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(cb);
    var self = this;
    return function() { self.off(event, cb); };
  },
  off: function(event, cb) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter(function(f) { return f !== cb; });
    }
  },
  emit: function(event, data) {
    if (this._emitDepth >= this._MAX_EMIT_DEPTH) {
      console.warn('[Core.emit] recursion limit:', event);
      return;
    }
    if (this.events[event]) {
      this._emitDepth++;
      try {
        this.events[event].forEach(function(cb) {
          try { cb(data); } catch (e) { console.error('[event:' + event + ']', e.message); }
        });
      } finally {
        this._emitDepth--;
      }
    }
  },

  // Config — JSON file (SQLite will be added by database module)
  loadConfig: function(userId) {
    var dir = path.join(this.USERS_ROOT, userId || 'admin');
    var configPath = path.join(dir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        console.error('config load error:', e.message);
        this.config = {};
      }
    }
    if (!this.config.lastUser) this.config.lastUser = userId || 'admin';
    return this.config;
  },
  saveConfig: function(delta) {
    if (delta && typeof delta === 'object') {
      Object.assign(this.config, delta);
    }
    var userId = this.config.lastUser || 'admin';
    var dir = path.join(this.USERS_ROOT, userId);
    var configPath = path.join(dir, 'config.json');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) {
      console.error('config save error:', e.message);
    }
    this.emit('configChanged', delta || {});
  },

  // Module registry
  _modules: {},
  registerModule: function(name, api) {
    this._modules[name] = api;
    this[name] = api;
  },
  getModule: function(name) {
    return this._modules[name] || null;
  },

  // Logging
  log: function() { console.log.apply(console, ['[Core]'].concat(Array.prototype.slice.call(arguments))); },
  warn: function() { console.warn.apply(console, ['[Core]'].concat(Array.prototype.slice.call(arguments))); },
  error: function() { console.error.apply(console, ['[Core]'].concat(Array.prototype.slice.call(arguments))); }
};

module.exports = Core;
