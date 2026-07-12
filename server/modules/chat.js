// server/modules/chat.js — Chat orchestrator with guardrails, memory, knowledge, routing
var PROTOCOL = require('../protocol');

var Core;
var _router;
var _abortControllers = {};

// ===== 系统提示词组装 =====
function buildSystemPrompt(userText, payload) {
  var parts = [];

  // 1. Base system instruction (from config or payload)
  var baseInstruction = payload.systemInstruction || Core.config.systemInstruction || '';
  if (baseInstruction) parts.push(baseInstruction);

  // 2. User profile + critical memories
  if (Core.memory) {
    try {
      var memCtx = Core.memory.getEnhancedContext(userText);
      if (memCtx) parts.push(memCtx);
    } catch (e) {}
  }

  // 3. Knowledge base context (async, injected separately)
  // Knowledge is injected via the searchWithCitations flow in handleChatSend

  return parts.join('\n\n');
}

// ===== 主聊天处理 =====
function handleChatSend(payload, ctx) {
  var text = payload.text;
  var sessionId = payload.sessionId;
  var temperature = payload.temperature || Core.config.temperature || 0.7;

  if (!text || !text.trim()) {
    throw new Error('empty message');
  }

  // Input guardrails check
  if (Core.guardrails) {
    var inputCheck = Core.guardrails.checkInput(text);
    if (!inputCheck.safe) {
      _router.broadcast(PROTOCOL.CHAT_ERROR, {
        error: inputCheck.reason,
        sessionId: sessionId,
        guardrails: true
      });
      return Promise.resolve({ blocked: true, reason: inputCheck.reason });
    }
  }

  // Auto-create session if needed
  if (!sessionId) {
    var session = Core.session.create('New Chat');
    sessionId = session.id;
  }
  Core.session.setCurrentId(sessionId);

  // Save user message
  Core.session.addMessage(sessionId, 'user', text);

  // Auto-extract memories from user input
  if (Core.memory) {
    try {
      var extracted = Core.memory.autoExtract(text);
      for (var i = 0; i < extracted.length; i++) {
        if (!Core.memory.isDuplicate(extracted[i].content)) {
          Core.memory.add(extracted[i].content, extracted[i].tags);
        }
      }
    } catch (e) {}
  }

  // Check routing — should this message be dispatched to a specific agent?
  var routeDecision = null;
  if (Core.routing) {
    try {
      var sessionData = Core.session.get(sessionId);
      var sessionCtx = {
        roleType: payload.roleType || (sessionData && sessionData.roleType),
        autoRoute: payload.autoRoute || (Core.config.autoRoute === true),
      };
      routeDecision = Core.routing.analyzeMessage(text, sessionCtx);
    } catch (e) {}
  }

  // If routed to a specific agent, delegate
  if (routeDecision && routeDecision.routeType === 'agent-route') {
    _router.broadcast(PROTOCOL.EVENT_STATUS, { message: 'Routing to ' + routeDecision.displayName + '...' });
    return Core.routing.callAgent(routeDecision.agentId, text, {
      provider: payload.provider,
      model: payload.model,
      temperature: temperature,
      query: text,
    }).then(function(result) {
      Core.session.addMessage(sessionId, 'ai', result.reply);
      _router.broadcast(PROTOCOL.CHAT_COMPLETE, {
        message: { role: 'ai', content: result.reply },
        sessionId: sessionId,
        agent: routeDecision.displayName
      });
      return { sessionId: sessionId, content: result.reply, routed: true, agent: routeDecision.displayName };
    }).catch(function(err) {
      _router.broadcast(PROTOCOL.CHAT_ERROR, { error: err.message, sessionId: sessionId });
      throw err;
    });
  }

  // Build system prompt (sync parts)
  var systemInstruction = buildSystemPrompt(text, payload);

  // Inject knowledge context (async)
  var knowledgePromise = Promise.resolve('');
  if (Core.knowledge) {
    knowledgePromise = Core.knowledge.searchWithCitations(text, 3).then(function(kbResult) {
      if (kbResult && kbResult.context) {
        return '\n\nKnowledge base references:\n' + kbResult.context;
      }
      return '';
    }).catch(function() { return ''; });
  }

  // Notify client: typing started
  _router.broadcast(PROTOCOL.EVENT_TYPING, { sessionId: sessionId, isTyping: true });
  _router.broadcast(PROTOCOL.EVENT_STATUS, { message: 'Thinking...' });

  // Create abort controller
  var controller = new AbortController();
  _abortControllers[sessionId] = controller;

  return knowledgePromise.then(function(kbContext) {
    var fullSystemPrompt = systemInstruction;
    if (kbContext) fullSystemPrompt += kbContext;

    // Call API with streaming
    return Core.api.callAPIStream(
      text, fullSystemPrompt, temperature, payload.model, payload.provider,
      function(chunk, fullText) {
        if (controller.signal.aborted) return;
        _router.broadcast(PROTOCOL.CHAT_STREAM, { chunk: chunk, sessionId: sessionId });
      }
    ).then(function(result) {
      delete _abortControllers[sessionId];
      var content = result.message.content || '';

      // Output guardrails check
      if (Core.guardrails) {
        var outputCheck = Core.guardrails.checkOutput(content);
        if (!outputCheck.safe && outputCheck.cleaned) {
          content = outputCheck.cleaned;
        }
      }

      // Save AI message
      Core.session.addMessage(sessionId, 'ai', content);

      _router.broadcast(PROTOCOL.CHAT_COMPLETE, {
        message: { role: 'ai', content: content },
        sessionId: sessionId,
        knowledgeRefs: kbContext ? true : false,
      });
      _router.broadcast(PROTOCOL.EVENT_TYPING, { sessionId: sessionId, isTyping: false });

      return { sessionId: sessionId, content: content };
    }).catch(function(err) {
      delete _abortControllers[sessionId];
      _router.broadcast(PROTOCOL.CHAT_ERROR, { error: err.message, sessionId: sessionId });
      _router.broadcast(PROTOCOL.EVENT_TYPING, { sessionId: sessionId, isTyping: false });
      throw err;
    });
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
  dependencies: ['database', 'session', 'cloud-api', 'html-utils', 'guardrails', 'memory', 'routing', 'knowledge'],
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

    Core.log('Chat module initialized (guardrails + memory + routing + knowledge)');
  }
};
