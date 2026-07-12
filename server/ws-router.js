// server/ws-router.js — WebSocket message router + handler registry
const { v4: uuidv4 } = require('uuid');
const PROTOCOL = require('./protocol');

function createRouter(Core) {
  var handlers = {};    // type → handler(payload, ctx) → result
  var clients = new Map(); // ws → { id, userId }

  // Register a request handler
  function handle(type, fn) {
    handlers[type] = fn;
  }

  // Broadcast event to all connected clients
  function broadcast(type, payload, excludeWs) {
    var msg = JSON.stringify({ type: type, payload: payload });
    clients.forEach(function(info, ws) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(msg);
      }
    });
  }

  // Send targeted message to one client
  function sendTo(ws, type, payload, id) {
    if (ws.readyState === 1) {
      var msg = { type: type, payload: payload };
      if (id) msg.id = id;
      ws.send(JSON.stringify(msg));
    }
  }

  // Handle incoming WebSocket connection
  function onConnection(ws, req) {
    var clientId = uuidv4();
    var clientInfo = { id: clientId, userId: 'admin' };
    clients.set(ws, clientInfo);
    Core.log('Client connected:', clientId, 'total:', clients.size);

    // Send protocol version on connect
    sendTo(ws, 'connected', { version: PROTOCOL.VERSION, clientId: clientId });

    ws.on('message', function(raw) {
      var msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        sendTo(ws, 'error', { error: 'invalid JSON' });
        return;
      }

      var ctx = { ws: ws, clientId: clientId, userId: clientInfo.userId };
      var handler = handlers[msg.type];

      if (!handler) {
        sendTo(ws, 'error', { error: 'unknown type: ' + msg.type }, msg.id);
        return;
      }

      // Execute handler (supports sync and async)
      try {
        var result = handler(msg.payload || {}, ctx);
        if (result && typeof result.then === 'function') {
          // Async handler
          result.then(function(data) {
            sendTo(ws, 'result', data || {}, msg.id);
          }).catch(function(err) {
            sendTo(ws, 'error', { error: err.message }, msg.id);
          });
        } else {
          sendTo(ws, 'result', result || {}, msg.id);
        }
      } catch (err) {
        sendTo(ws, 'error', { error: err.message }, msg.id);
      }
    });

    ws.on('close', function() {
      clients.delete(ws);
      Core.log('Client disconnected:', clientId, 'remaining:', clients.size);
    });

    ws.on('error', function(err) {
      console.error('[WS] client error:', clientId, err.message);
      clients.delete(ws);
    });
  }

  return {
    handle: handle,
    broadcast: broadcast,
    sendTo: sendTo,
    onConnection: onConnection,
    getClients: function() { return clients; }
  };
}

module.exports = { createRouter: createRouter };
