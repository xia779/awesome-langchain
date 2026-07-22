// server/protocol.js — WebSocket message protocol definitions
// Shared between server and all clients (Electron, Web, PWA, dev board)

// Message format:
// Request:  { id: uuid, type: 'action.name', payload: {...} }
// Response: { id: uuid, type: 'result' | 'error', payload: {...} }
// Event:    { type: 'event.name', payload: {...} }  (no id, server→client push)

var PROTOCOL = {
  VERSION: '1.0',

  // === Chat ===
  CHAT_SEND:         'chat.send',         // payload: { text, sessionId, systemInstruction?, temperature? }
  CHAT_STREAM:       'chat.stream',       // event: { chunk, sessionId }
  CHAT_COMPLETE:     'chat.complete',     // event: { message, sessionId }
  CHAT_ERROR:        'chat.error',        // event: { error, sessionId }
  CHAT_CANCEL:       'chat.cancel',       // payload: { sessionId }

  // === Sessions ===
  SESSION_LIST:      'session.list',      // response: { sessions: [...] }
  SESSION_GET:       'session.get',       // payload: { id }, response: { session }
  SESSION_CREATE:    'session.create',    // payload: { name?, parentId? }, response: { session }
  SESSION_UPDATE:    'session.update',    // payload: { id, delta }
  SESSION_DELETE:    'session.delete',    // payload: { id }
  SESSION_SWITCH:    'session.switch',    // payload: { id }

  // === Knowledge ===
  KB_SEARCH:         'kb.search',         // payload: { query, topK? }, response: { results }
  KB_IMPORT:         'kb.import',         // payload: { filePath }, event: progress
  KB_LIST:           'kb.list',           // response: { docs: [...] }
  KB_DELETE:         'kb.delete',         // payload: { id }

  // === Agent ===
  AGENT_EXECUTE:     'agent.execute',     // payload: { task, isDeepThink? }
  AGENT_STEP:        'agent.step',        // event: { step, action, status }
  AGENT_COMPLETE:    'agent.complete',    // event: { answer, stepsLog }
  AGENT_CANCEL:      'agent.cancel',      // payload: {}

  // === Config ===
  CONFIG_GET:        'config.get',        // response: { config }
  CONFIG_SET:        'config.set',        // payload: { delta }

  // === Tools ===
  TOOL_EXECUTE:      'tool.execute',      // payload: { tool, params }
  TOOL_LIST:         'tool.list',         // response: { tools: [...] }

  // === Memory ===
  MEMORY_SEARCH:     'memory.search',     // payload: { query }, response: { memories }
  MEMORY_ADD:        'memory.add',        // payload: { content, tags? }
  MEMORY_DELETE:     'memory.delete',     // payload: { id }

  // === Nodes (multi-device execution) ===
  NODE_REGISTER:     'node.register',     // N→S: { nodeId, name, platform, capabilities }
  NODE_EXECUTE:      'node.execute',      // S→N: { callId, tool, params }
  NODE_RESULT:       'node.result',       // N→S: { callId, result, error }
  NODE_STATUS:       'node.status',       // N→S: { nodeId, cpu, mem, uptime }
  NODE_LIST:         'node.list',         // C→S: response { nodes: [...] }
  NODE_ONLINE:       'node.online',       // S→C event: { nodeId, name, platform, capabilities }
  NODE_OFFLINE:      'node.offline',      // S→C event: { nodeId }

  // === System ===
  SYSTEM_STATUS:     'system.status',     // response: { models, memory, uptime, ... }
  SYSTEM_MODELS:     'system.models',     // response: { models: [...] }

  // === Server→Client events (no id) ===
  EVENT_STATUS:      'event.status',      // payload: { message }
  EVENT_TYPING:      'event.typing',      // payload: { sessionId, isTyping }
  EVENT_CONFIG:      'event.config',      // payload: { delta }
  EVENT_NOTIFICATION:'event.notification' // payload: { title, body, type }
};

module.exports = PROTOCOL;
