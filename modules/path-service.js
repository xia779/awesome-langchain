// modules/path-service.js — 路径单一真相源（Phase 2）
// ============================================================================
// 消灭散落的 Core._globalDataRoot || Core.DATA_ROOT || 'E:\my-ai-data' 和二义性。
// 全局根启动时确定、不可变；每用户路径由当前用户上下文计算；显式 API 取代偷改全局。
//
// 用法（渲染进程模块内）：
//   Core.pathService.global()             → E:\my-ai-data
//   Core.pathService.global('pytdx-env')  → E:\my-ai-data\pytdx-env
//   Core.pathService.perUser()            → E:\my-ai-data\users\admin
//   Core.pathService.perUser('sessions')  → E:\my-ai-data\users\admin\sessions
//   Core.pathService.userRoot('alice')    → E:\my-ai-data\users\alice
//
// 向后兼容：
//   Core.DATA_ROOT       → getter，返回 effectiveRoot()（有用户→每用户，无→全局）
//   Core._globalDataRoot → getter，返回 global()
// ============================================================================

var path = require('path');

// PathService 实例由 core-v10.js 在启动时创建并挂载到 Core.pathService。
// 本模块的 init 仅做校验与补全（若 core 已挂载则直接复用）。
function init(_Core) {
  if (_Core.pathService) {
    // core-v10.js 已创建 PathService，直接复用
    return;
  }
  // 兜底：如果 core 未创建（如 server 端），创建一个最小实例
  var globalRoot = (_Core.DATA_ROOT && !_Core._currentUser)
    ? _Core.DATA_ROOT
    : (_Core._globalDataRoot || 'E:\\my-ai-data');
  _Core.pathService = {
    _globalRoot: globalRoot,
    _usersRoot: path.join(globalRoot, 'users'),
    _currentUser: _Core._currentUser || null,
    setCurrentUser: function(u) { this._currentUser = u; return this; },
    global: function(sub) { return sub ? path.join(this._globalRoot, sub) : this._globalRoot; },
    perUser: function(sub) {
      var base = path.join(this._usersRoot, this._currentUser || 'admin');
      return sub ? path.join(base, sub) : base;
    },
    userRoot: function(userId, sub) {
      var base = path.join(this._usersRoot, userId || 'admin');
      return sub ? path.join(base, sub) : base;
    },
    effectiveRoot: function() {
      return this._currentUser ? this.perUser() : this._globalRoot;
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    name: 'path-service',
    dependencies: [],
    init: init
  };
}
