// server/modules/session.js — Session management (data layer, no DOM)
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var Core;

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

var sessionModule = {
  name: 'session',
  dependencies: ['database', 'html-utils'],
  init: function(_Core) {
    Core = _Core;

    var api = {
      getCurrentId: function() { return _currentSessionId; },
      setCurrentId: function(id) { _currentSessionId = id; },

      create: function(name, parentId) {
        var id = genId();
        var session = Core.db.createSession(id, name, parentId);
        return session;
      },

      get: function(id) {
        var session = Core.db.getSession(id);
        if (session) {
          session.messages = Core.db.getMessages(id);
        }
        return session;
      },

      list: function() {
        return Core.db.listSessions();
      },

      delete: function(id) {
        Core.db.deleteSession(id);
      },

      update: function(id, delta) {
        Core.db.updateSession(id, delta);
      },

      addMessage: function(sessionId, role, content, metadata) {
        return Core.db.addMessage(sessionId, role, content, metadata);
      },

      getMessages: function(sessionId) {
        return Core.db.getMessages(sessionId);
      }
    };

    Core.registerModule('session', api);
  }
};

var _currentSessionId = null;

module.exports = sessionModule;
