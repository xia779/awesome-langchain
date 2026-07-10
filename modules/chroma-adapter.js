// modules/chroma-adapter.js - ChromaDB 向量库可选适配器（HTTP 直连版）
// 直接通过 HTTP REST API 与 ChromaDB 通信，无需 chromadb npm 包
// 不可用时自动回退到 JSON + Ollama 方案
// 🔧 v2 API 适配：ChromaDB >= 1.0 弃用了 /api/v1，改用 /api/v2

var Core = null;
var available = false;
var collectionId = null;
var collectionName = 'ai_agent_knowledge';
var baseUrl = 'http://localhost:8000';
// 🔧 v2 API 路径前缀（包含默认 tenant 和 database）
var apiBase = '/api/v2/tenants/default_tenant/databases/default_database';
var _retryTimer = null;
var _retryCount = 0;
var MAX_RETRIES = 5;
var RETRY_DELAY = 3000;

// HTTP 请求封装（使用 Node.js 内置 http 模块）
function httpRequest(method, urlPath, body) {
  return new Promise(function(resolve, reject) {
    var http = require('http');
    var url = require('url');
    var parsed = url.parse(baseUrl + urlPath);
    var options = {
      hostname: parsed.hostname,
      port: parsed.port || 8000,
      path: parsed.path,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };
    var req = http.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', function(e) { reject(e); });
    req.on('timeout', function() { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 初始化连接
async function initChroma() {
  try {
    // 1. 心跳检测（v2 路径）
    await httpRequest('GET', '/api/v2/heartbeat');
    console.log('🔌 ChromaDB 服务器已响应 (v2 API)');

    // 2. 获取或创建集合（v2 路径）
    var collections = await httpRequest('GET', apiBase + '/collections');
    var found = null;
    if (Array.isArray(collections)) {
      for (var i = 0; i < collections.length; i++) {
        if (collections[i].name === collectionName) {
          found = collections[i];
          break;
        }
      }
    }
    if (!found) {
      found = await httpRequest('POST', apiBase + '/collections', {
        name: collectionName,
        metadata: { description: 'AI\u667a\u80fd\u4f53\u77e5\u8bc6\u5e93\u5411\u91cf' },
        get_or_create: true,
      });
    }
    collectionId = found.id || found;
    if (typeof collectionId === 'object') collectionId = collectionId.id;
    if (!collectionId) throw new Error('Failed to get collection ID');

    available = true;
    _retryCount = 0;
    console.log('✅ ChromaDB 已连接，集合: ' + collectionName + ' (ID: ' + String(collectionId).substring(0, 8) + '...)');
    if (Core && Core.emit) Core.emit('chromaStatusChanged', true);
    return true;
  } catch (e) {
    console.log('📂 ChromaDB 不可用（' + e.message + '），使用 JSON + Ollama 向量方案');
    available = false;
    collectionId = null;
    if (Core && Core.emit) Core.emit('chromaStatusChanged', false);
    return false;
  }
}

function startRetry() {
  stopRetry();
  _retryCount = 0;
  _retryTimer = setInterval(async function() {
    _retryCount++;
    console.log('🔄 ChromaDB 重试连接 (' + _retryCount + '/' + MAX_RETRIES + ')...');
    var ok = await initChroma();
    if (ok || _retryCount >= MAX_RETRIES) {
      stopRetry();
      if (!ok) console.log('⚠️ ChromaDB 连接失败，已停止重试。可在设置中手动重连。');
    }
  }, RETRY_DELAY);
}

function stopRetry() {
  if (_retryTimer) { clearInterval(_retryTimer); _retryTimer = null; }
}

async function reconnect() {
  stopRetry();
  var ok = await initChroma();
  if (!ok) startRetry();
  return ok;
}

async function addDocuments(ids, embeddings, documents, metadatas) {
  if (!available || !collectionId) throw new Error('ChromaDB \u672a\u8fde\u63a5');
  await httpRequest('POST', apiBase + '/collections/' + collectionId + '/add', {
    ids: ids, embeddings: embeddings, documents: documents, metadatas: metadatas,
  });
}

async function queryDocuments(queryEmbedding, topK) {
  if (!available || !collectionId) throw new Error('ChromaDB \u672a\u8fde\u63a5');
  topK = topK || 5;
  var result = await httpRequest('POST', apiBase + '/collections/' + collectionId + '/query', {
    query_embeddings: [queryEmbedding], n_results: topK,
  });
  if (!result || !result.ids || result.ids.length === 0) return [];
  var output = [];
  for (var i = 0; i < result.ids[0].length; i++) {
    output.push({
      id: result.ids[0][i],
      text: result.documents ? result.documents[0][i] : '',
      metadata: result.metadatas ? (result.metadatas[0][i] || {}) : {},
      distance: result.distances ? result.distances[0][i] : 0,
    });
  }
  return output;
}

async function deleteDocuments(ids) {
  if (!available || !collectionId) throw new Error('ChromaDB \u672a\u8fde\u63a5');
  await httpRequest('POST', apiBase + '/collections/' + collectionId + '/delete', { ids: ids });
}

async function getStats() {
  if (!available || !collectionId) return null;
  var count = await httpRequest('GET', apiBase + '/collections/' + collectionId + '/count');
  return { totalDocuments: count, backend: 'chromadb' };
}

async function migrateFromJSON(knowledgeDir) {
  if (!available) return { success: false, error: 'ChromaDB \u672a\u8fde\u63a5' };
  var fs = require('fs');
  var path = require('path');
  var indexPath = path.join(knowledgeDir, 'index.json');
  if (!fs.existsSync(indexPath)) return { success: false, error: '\u672a\u627e\u5230\u77e5\u8bc6\u5e93\u7d22\u5f15' };
  var index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  var migrated = 0;
  for (var i = 0; i < index.length; i++) {
    var doc = index[i];
    var docPath = path.join(knowledgeDir, doc.id + '.json');
    if (!fs.existsSync(docPath)) continue;
    try {
      var docData = JSON.parse(fs.readFileSync(docPath, 'utf8'));
      if (!docData.chunks) continue;
      var ids = [], embeddings = [], documents = [], metadatas = [];
      for (var j = 0; j < docData.chunks.length; j++) {
        var chunk = docData.chunks[j];
        if (!chunk.embedding) continue;
        ids.push(doc.id + '_chunk_' + j);
        embeddings.push(chunk.embedding);
        documents.push(chunk.text);
        metadatas.push({ fileName: doc.fileName, chunkIndex: j });
      }
      if (ids.length > 0) { await addDocuments(ids, embeddings, documents, metadatas); migrated += ids.length; }
    } catch (e) { console.warn('\u26a0\ufe0f \u8fc1\u79fb\u6587\u6863\u5931\u8d25 (' + doc.fileName + '):', e.message); }
  }
  return { success: true, migrated: migrated };
}

module.exports = {
  init: function(_Core) {
    Core = _Core;
    Core.chroma = {
      isAvailable: function() { return available; },
      initChroma: initChroma,
      reconnect: reconnect,
      addDocuments: addDocuments,
      queryDocuments: queryDocuments,
      deleteDocuments: deleteDocuments,
      getStats: getStats,
      migrateFromJSON: migrateFromJSON,
    };
    if (Core.config && Core.config.vectorBackend === 'chroma') {
      initChroma().then(function(ok) {
        if (!ok) { console.log('🔄 ChromaDB 首次连接失败，启动自动重试...'); startRetry(); }
      }).catch(function() {});
    }
    console.log('✅ ChromaDB 适配器已加载（HTTP 直连 v2 API）' + (available ? ' (已连接)' : ' (JSON 回退模式)'));
  }
};
