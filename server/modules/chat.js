// server/modules/chat.js — Chat handler: ties sessions + API together
// Registers WebSocket handlers for chat.send, chat.cancel, session.*
var PROTOCOL = require('../protocol');

var Core;
var _router;
var _abortControllers = {};

function handleChatSend(payload, ctx) {
  var text = payload.text;
  var sessionId = payload.sessionId;
  var temperature = payload.temperature || Core.config.temperature || 0.7;
  var systemInstruction = payload.systemInstruction || Core.config.systemInstruction || '';

  if (!text || !text.trim()) {
    throw new Error('empty message');
  }

  // Auto-create session if needed
  if (!sessionId) {
    var session = Core.session.create('New Chat');
    sessionId = session.id;
  }
  Core.session.setCurrentId(sessionId);

  // Save user message
  Core.session.addMessage(sessionId, 'user', text);

  // Notify client: typing started
  _router.broadcast(PROTOCOL.EVENT_TYPING, { sessionId: sessionId, isTyping: true });
  _router.broadcast(PROTOCOL.EVENT_STATUS, { message: 'Thinking...' });

  // Create abort controller
  var controller = new AbortController();
  _abortControllers[sessionId] = controller;

  // Call API with streaming
  return Core.api.callAPIStream(
    text, systemInstruction, temperature, null, null,
    function(chunk, fullText) {
      if (controller.signal.aborted) return;
      _router.broadcast(PROTOCOL.CHAT_STREAM, { chunk: chunk, sessionId: sessionId });
    }
  ).then(function(result) {
    delete _abortControllers[sessionId];
    var content = result.message.content || '';

    // Save AI message
    Core.session.addMessage(sessionId, 'ai', content);

    _router.broadcast(PROTOCOL.CHAT_COMPLETE, {
      message: { role: 'ai', content: content },
      sessionId: sessionId
    });
    _router.broadcast(PROTOCOL.EVENT_TYPING, { sessionId: sessionId, isTyping: false });

    return { sessionId: sessionId, content: content };
  }).catch(function(err) {
    delete _abortControllers[sessionId];
    _router.broadcast(PROTOCOL.CHAT_ERROR, { error: err.message, sessionId: sessionId });
    _router.broadcast(PROTOCOL.EVENT_TYPING, { sessionId: sessionId, isTyping: false });
    throw err;
  });
}

function handleChatCancel(payload) {
  var sessionId = payload.sessionId;
  if (sessionId && _abortControllers[sessionId]) {
    _abortControllers[sessionId].abort();
    delete _abortControllers[sessionId];
  }
  return { cancelled: true };
}

module.exports = {
  name: 'chat',
  dependencies: ['database', 'session', 'cloud-api', 'html-utils'],
  init: function(_Core, router) {
    Core = _Core;
    _router = router;

    // Register WebSocket handlers
    router.handle(PROTOCOL.CHAT_SEND, handleChatSend);
    router.handle(PROTOCOL.CHAT_CANCEL, handleChatCancel);
    router.handle(PROTOCOL.SESSION_LIST, function() {
      return { sessions: Core.session.list() };
    });
    router.handle(PROTOCOL.SESSION_CREATE, function(payload) {
      var session = Core.session.create(payload.name, payload.parentId);
      return { session: session };
    });
    router.handle(PROTOCOL.SESSION_GET, function(payload) {
      var session = Core.session.get(payload.id);
      return { session: session };
    });
    router.handle(PROTOCOL.SESSION_DELETE, function(payload) {
      Core.session.delete(payload.id);
      return { success: true };
    });
    router.handle(PROTOCOL.SESSION_UPDATE, function(payload) {
      Core.session.update(payload.id, payload.delta);
      return { success: true };
    });
    router.handle(PROTOCOL.SESSION_SWITCH, function(payload) {
      Core.session.setCurrentId(payload.id);
      return { sessionId: payload.id };
    });

    Core.registerModule('chat', {
      send: handleChatSend,
      cancel: handleChatCancel
    });

    Core.log('Chat module initialized, handlers registered');
  }
};
