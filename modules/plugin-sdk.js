// modules/plugin-sdk.js - 插件SDK正式版 (P5-2)
// 提供插件开发的标准化接口、生命周期管理、权限声明
'use strict';

var Core = null;

// ===== 插件清单 Schema =====
var MANIFEST_SCHEMA = {
  required: ['id', 'name', 'version', 'description'],
  optional: ['author', 'homepage', 'license', 'icon', 'permissions', 'hooks', 'settings', 'commands'],
  permissions: ['network', 'filesystem', 'clipboard', 'notification', 'shell', 'storage'],
  hookTypes: ['beforeSend', 'afterResponse', 'onMessageRender', 'onInit', 'onConfigChange', 'onSessionSwitch']
};

// ===== 插件生命周期 =====
var LIFECYCLE_STATES = ['registered', 'loading', 'active', 'suspended', 'error', 'unloaded'];

// ===== 插件基类（供插件继承）=====
function PluginBase(manifest) {
  this.manifest = manifest || {};
  this.state = 'registered';
  this._hooks = {};
  this._intervals = [];
  this._listeners = [];
}

PluginBase.prototype.onActivate = function() {};
PluginBase.prototype.onDeactivate = function() {};
PluginBase.prototype.onSuspend = function() {};
PluginBase.prototype.onResume = function() {};
PluginBase.prototype.onError = function(err) { console.error('[Plugin:' + this.manifest.id + ']', err); };

PluginBase.prototype.registerHook = function(hookName, handler) {
  if (!this._hooks[hookName]) this._hooks[hookName] = [];
  this._hooks[hookName].push(handler);
  if (Core && Core.plugins && Core.plugins.registerHook) {
    Core.plugins.registerHook(this.manifest.id + ':' + hookName, hookName, handler);
  }
};

PluginBase.prototype.setInterval = function(fn, ms) {
  var id = setInterval(fn, ms);
  this._intervals.push(id);
  return id;
};

PluginBase.prototype.notify = function(text, opts) {
  if (Core && Core.imNotify && Core.imNotify.push) {
    return Core.imNotify.push(text, opts);
  }
};

PluginBase.prototype.getSetting = function(key, defaultVal) {
  var settings = this.manifest.settings || {};
  return settings[key] !== undefined ? settings[key] : defaultVal;
};

PluginBase.prototype.cleanup = function() {
  this._intervals.forEach(function(id) { clearInterval(id); });
  this._intervals = [];
  if (Core && Core.plugins && Core.plugins.unregisterHook) {
    var self = this;
    Object.keys(this._hooks).forEach(function(hookName) {
      self._hooks[hookName].forEach(function(handler) {
        Core.plugins.unregisterHook(self.manifest.id + ':' + hookName, hookName, handler);
      });
    });
  }
  this._hooks = {};
};

// ===== 清单验证 =====
function validateManifest(manifest) {
  var errors = [];
  var warnings = [];

  if (!manifest) return { valid: false, errors: ['清单为空'] };

  MANIFEST_SCHEMA.required.forEach(function(field) {
    if (!manifest[field]) errors.push('缺少必填字段: ' + field);
  });

  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    warnings.push('版本号格式建议使用 semver (x.y.z)');
  }

  if (manifest.permissions) {
    manifest.permissions.forEach(function(p) {
      if (MANIFEST_SCHEMA.permissions.indexOf(p) < 0) {
        warnings.push('未知权限: ' + p);
      }
    });
  }

  if (manifest.hooks) {
    Object.keys(manifest.hooks).forEach(function(h) {
      if (MANIFEST_SCHEMA.hookTypes.indexOf(h) < 0) {
        warnings.push('未知钩子类型: ' + h);
      }
    });
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}

// ===== 插件注册表（SDK层面）=====
var _sdkRegistry = {};

function registerPlugin(manifest, pluginClass) {
  var validation = validateManifest(manifest);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  var instance = null;
  if (typeof pluginClass === 'function') {
    instance = new pluginClass(manifest);
  } else if (pluginClass && typeof pluginClass === 'object') {
    instance = Object.create(PluginBase.prototype);
    Object.assign(instance, pluginClass);
    instance.manifest = manifest;
    instance._hooks = {};
    instance._intervals = [];
  }

  _sdkRegistry[manifest.id] = {
    manifest: manifest,
    instance: instance,
    state: 'registered',
    validation: validation
  };

  return { success: true, id: manifest.id, warnings: validation.warnings };
}

function activatePlugin(id) {
  var entry = _sdkRegistry[id];
  if (!entry) return { success: false, error: '插件未注册: ' + id };
  if (entry.state === 'active') return { success: true, alreadyActive: true };

  try {
    entry.state = 'loading';
    if (entry.instance && entry.instance.onActivate) {
      entry.instance.onActivate();
    }
    entry.state = 'active';
    return { success: true };
  } catch (e) {
    entry.state = 'error';
    if (entry.instance && entry.instance.onError) entry.instance.onError(e);
    return { success: false, error: e.message };
  }
}

function deactivatePlugin(id) {
  var entry = _sdkRegistry[id];
  if (!entry) return { success: false, error: '插件未注册' };
  try {
    if (entry.instance) {
      if (entry.instance.onDeactivate) entry.instance.onDeactivate();
      if (entry.instance.cleanup) entry.instance.cleanup();
    }
    entry.state = 'unloaded';
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getPluginInfo(id) {
  var entry = _sdkRegistry[id];
  if (!entry) return null;
  return { id: id, manifest: entry.manifest, state: entry.state, validation: entry.validation };
}

function listRegistered() {
  return Object.keys(_sdkRegistry).map(function(id) {
    return { id: id, name: _sdkRegistry[id].manifest.name, version: _sdkRegistry[id].manifest.version, state: _sdkRegistry[id].state };
  });
}

// ===== 模块导出 =====
module.exports = {
  name: 'plugin-sdk',
  dependencies: ['plugins'],
  init: function(_Core) {
    Core = _Core;
    Core.pluginSDK = {
      PluginBase: PluginBase,
      validateManifest: validateManifest,
      register: registerPlugin,
      activate: activatePlugin,
      deactivate: deactivatePlugin,
      getInfo: getPluginInfo,
      list: listRegistered,
      MANIFEST_SCHEMA: MANIFEST_SCHEMA,
      LIFECYCLE_STATES: LIFECYCLE_STATES
    };
    console.log('\u2705 plugin-sdk 已加载（插件开发SDK: 清单验证 + 生命周期 + 权限声明）');
  }
};
