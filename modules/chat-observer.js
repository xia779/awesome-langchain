// modules/chat-observer.js — 统一 chatContainer MutationObserver
// 将多个独立 Observer 合并为一个，通过回调注册 API 分发给各模块
'use strict';

var _handlers = [];        // fn(msgNode) — 新 .msg 节点
var _mutationHandlers = []; // fn(mutation) — 所有 DOM 变化
var _clearHandlers = [];   // fn() — 会话切换（批量移除）
var _observer = null;
var _pendingMsgs = [];
var _rafId = null;

function init(Core) {
  var container = document.getElementById('chatContainer');
  if (!container) {
    setTimeout(function() { init(Core); }, 500);
    return;
  }

  _observer = new MutationObserver(function(mutations) {
    var hasNewMsgs = false;
    var hasClear = false;

    for (var i = 0; i < mutations.length; i++) {
      var mut = mutations[i];

      // 检查新增节点
      var added = mut.addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;

        if (node.classList && node.classList.contains('msg')) {
          _pendingMsgs.push(node);
          hasNewMsgs = true;
        }
        // 检查子节点中的 .msg（批量渲染场景）
        if (node.querySelectorAll) {
          var subMsgs = node.querySelectorAll('.msg');
          for (var k = 0; k < subMsgs.length; k++) {
            _pendingMsgs.push(subMsgs[k]);
            hasNewMsgs = true;
          }
        }
      }

      // 检查批量移除（会话切换）
      if (mut.removedNodes.length > 5) {
        hasClear = true;
      }
    }

    // 批量触发 message 回调（rAF 去抖）
    if (hasNewMsgs && !_rafId) {
      _rafId = requestAnimationFrame(function() {
        _rafId = null;
        var msgs = _pendingMsgs.slice();
        _pendingMsgs.length = 0;
        for (var m = 0; m < msgs.length; m++) {
          (function(msg) {
            for (var h = 0; h < _handlers.length; h++) {
              try { _handlers[h](msg); } catch (e) {
                console.warn('[chat-observer] handler error:', e.message);
              }
            }
          })(msgs[m]);
        }
      });
    }

    // 触发 mutation 回调
    for (var mi = 0; mi < _mutationHandlers.length; mi++) {
      try { _mutationHandlers[mi](mutations); } catch (e) {
        console.warn('[chat-observer] mutation handler error:', e.message);
      }
    }

    // 触发 clear 回调
    if (hasClear) {
      for (var ci = 0; ci < _clearHandlers.length; ci++) {
        try { _clearHandlers[ci](); } catch (e) {
          console.warn('[chat-observer] clear handler error:', e.message);
        }
      }
    }
  });

  _observer.observe(container, { childList: true, subtree: true });

  // 处理已存在的消息
  var existing = container.querySelectorAll('.msg');
  for (var i = 0; i < existing.length; i++) {
    _pendingMsgs.push(existing[i]);
  }
  if (_pendingMsgs.length > 0 && !_rafId) {
    _rafId = requestAnimationFrame(function() {
      _rafId = null;
      var msgs = _pendingMsgs.slice();
      _pendingMsgs.length = 0;
      for (var m = 0; m < msgs.length; m++) {
        for (var h = 0; h < _handlers.length; h++) {
          try { _handlers[h](msgs[m]); } catch (e) {}
        }
      }
    });
  }

  // 暴露 API
  Core.chatObserver = {
    onMessage: function(fn) { _handlers.push(fn); },
    onMutation: function(fn) { _mutationHandlers.push(fn); },
    onClear: function(fn) { _clearHandlers.push(fn); },
    processNode: function(node) {
      for (var i = 0; i < _handlers.length; i++) {
        try { _handlers[i](node); } catch (e) {}
      }
    },
    getObserver: function() { return _observer; }
  };

  console.log('✅ chat-observer: 统一 MutationObserver 已启动');
}

module.exports = {
  name: 'chat-observer',
  dependencies: [],
  init: init
};
