// server/modules/knowledge.js — 知识库模块（JSON 文件持久化 + Ollama 嵌入 + BM25 混合检索 + RRF 融合排序）
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var Core = null;

// ===== 配置 =====
function getKnowledgeDir() {
  if (Core && Core.DATA_ROOT) return path.join(Core.DATA_ROOT, 'knowledge');
  var root = (Core && Core.DATA_ROOT) || process.env.AI_AGENT_DATA_ROOT || path.join(process.cwd(), 'data');
  return path.join(root, 'knowledge');
}

var CHUNK_SIZE = 500;
var OVERLAP = 100;
var EMBEDDING_MODEL = 'nomic-embed-text';
var OLLAMA_BASE = 'http://127.0.0.1:11434';

var embeddingAvailable = null;

function ensureDir() {
  var dir = getKnowledgeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ===== 嵌入模型检测 =====
async function checkEmbeddingModel() {
  if (embeddingAvailable !== null) return embeddingAvailable;
  try {
    var resp = await fetch(OLLAMA_BASE + '/api/tags', {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    var models = (data.models || []).map(function(m) { return m.name || m.model || ''; });
    var found = models.some(function(m) {
      return m.includes(EMBEDDING_MODEL) || m.startsWith(EMBEDDING_MODEL + ':');
    });
    if (found) {
      embeddingAvailable = true;
      console.log('[knowledge] embedding model ' + EMBEDDING_MODEL + ' ready');
    } else {
      embeddingAvailable = false;
      console.log('[knowledge] embedding model ' + EMBEDDING_MODEL + ' not installed, using BM25');
    }
  } catch (e) {
    embeddingAvailable = false;
    console.log('[knowledge] Ollama not reachable, using BM25 text search');
  }
  return embeddingAvailable;
}

// ===== 读取文档内容 =====
async function readFileContent(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(filePath, 'utf8');
  } else if (ext === '.pdf') {
    try {
      var pdfParse = require('pdf-parse');
      var pdfData = await pdfParse(fs.readFileSync(filePath));
      return pdfData.text;
    } catch (e) {
      throw new Error('PDF 解析失败: ' + e.message);
    }
  } else if (ext === '.docx' || ext === '.doc') {
    try {
      var mammoth = require('mammoth');
      var result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (e) {
      throw new Error('DOCX 解析失败: ' + e.message);
    }
  } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    try {
      var XLSX = require('xlsx');
      var workbook = XLSX.readFile(filePath);
      var allText = '';
      workbook.sheetNames.forEach(function(sheetName) {
        var ws = workbook.Sheets[sheetName];
        var csv = XLSX.utils.sheet_to_csv(ws);
        allText += '== ' + sheetName + ' ==\n' + csv + '\n\n';
      });
      return allText.trim();
    } catch (e) {
      throw new Error('XLSX 解析失败: ' + e.message);
    }
  } else {
    throw new Error('不支持的文件类型: ' + ext);
  }
}

// ===== 文档切分 =====
function chunkDocument(text) {
  if (!text || !text.trim()) return [];
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var SENTENCE_RE = /(?<=[。！？；\n.!?;])\s*/;
  var sentences = text.split(SENTENCE_RE).filter(function(s) { return s.trim(); });
  var chunks = [];
  var currentChunk = '';

  for (var si = 0; si < sentences.length; si++) {
    var sentence = sentences[si];
    if (sentence.length > CHUNK_SIZE) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      for (var i = 0; i < sentence.length; i += CHUNK_SIZE - OVERLAP) {
        var sub = sentence.substring(i, i + CHUNK_SIZE);
        if (sub.trim()) chunks.push(sub.trim());
      }
      var lastStart = Math.max(0, sentence.length - OVERLAP);
      currentChunk = sentence.substring(lastStart);
      continue;
    }
    if (currentChunk.length + sentence.length > CHUNK_SIZE && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      var overlapText = currentChunk.length > OVERLAP
        ? currentChunk.substring(currentChunk.length - OVERLAP)
        : currentChunk;
      currentChunk = overlapText + sentence;
    } else {
      currentChunk += sentence;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks.filter(function(c) { return c.length >= 10; });
}

// ===== 向量生成 =====
async function getEmbedding(text) {
  if (embeddingAvailable === false) return null;
  try {
    var resp = await fetch(OLLAMA_BASE + '/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text.substring(0, 2000),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    if (!data.embedding || !Array.isArray(data.embedding)) return null;
    return data.embedding;
  } catch (err) {
    embeddingAvailable = false;
    return null;
  }
}

// ===== 余弦相似度 =====
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  var denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ===== BM25 文本检索 =====
function tokenize(text) {
  if (!text) return [];
  var tokens = [];
  var wordMatches = text.toLowerCase().match(/[a-z0-9]+/g);
  if (wordMatches) tokens.push.apply(tokens, wordMatches);
  var chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  for (var i = 0; i < chineseChars.length; i++) {
    tokens.push(chineseChars[i]);
    if (i < chineseChars.length - 1) {
      tokens.push(chineseChars[i] + chineseChars[i + 1]);
    }
  }
  return tokens;
}

var BM25_K1 = 1.5;
var BM25_B = 0.75;

function bm25Search(query, chunks, topK) {
  var queryTokens = tokenize(query);
  if (!queryTokens.length || !chunks.length) return [];
  var N = chunks.length;
  var df = {};
  var avgDocLen = chunks.reduce(function(sum, c) { return sum + c.text.length; }, 0) / N;
  for (var ci = 0; ci < chunks.length; ci++) {
    var chunkTokenSet = new Set(tokenize(chunks[ci].text));
    chunkTokenSet.forEach(function(t) { df[t] = (df[t] || 0) + 1; });
  }
  var scores = chunks.map(function(chunk) {
    var chunkTokens = tokenize(chunk.text);
    var tf = {};
    chunkTokens.forEach(function(t) { tf[t] = (tf[t] || 0) + 1; });
    var score = 0;
    var docLen = chunk.text.length;
    queryTokens.forEach(function(qt) {
      if (!df[qt]) return;
      var idf = Math.log((N - df[qt] + 0.5) / (df[qt] + 0.5) + 1);
      var freq = tf[qt] || 0;
      var numerator = freq * (BM25_K1 + 1);
      var denominator = freq + BM25_K1 * (1 - BM25_B + BM25_B * docLen / avgDocLen);
      score += idf * numerator / denominator;
    });
    var result = {};
    Object.keys(chunk).forEach(function(k) { result[k] = chunk[k]; });
    result.score = score;
    return result;
  });
  scores.sort(function(a, b) { return b.score - a.score; });
  return scores.filter(function(s) { return s.score > 0; }).slice(0, topK);
}

// ===== 读取所有 chunks =====
function loadAllChunks() {
  var dir = getKnowledgeDir();
  if (!fs.existsSync(dir)) return [];
  var allChunks = [];
  var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.json') && f !== 'index.json'; });
  for (var fi = 0; fi < files.length; fi++) {
    try {
      var filePath = path.join(dir, files[fi]);
      var data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      var meta = data.metadata || {};
      var fileChunks = data.chunks || [];
      for (var ci = 0; ci < fileChunks.length; ci++) {
        var chunk = fileChunks[ci];
        if (chunk.text) {
          allChunks.push({
            text: chunk.text,
            index: chunk.index,
            embedding: chunk.embedding || null,
            fileName: meta.fileName || '未知',
            docId: meta.id || files[fi].replace('.json', ''),
          });
        }
      }
    } catch (e) {}
  }
  return allChunks;
}

// ===== 上传文档 =====
async function uploadDocument(filePathOrContent) {
  ensureDir();
  try {
    var content, fileName, docId;
    if (typeof filePathOrContent === 'string') {
      content = await readFileContent(filePathOrContent);
      fileName = path.basename(filePathOrContent);
    } else if (typeof filePathOrContent === 'object' && filePathOrContent !== null) {
      content = filePathOrContent.content;
      fileName = filePathOrContent.fileName || 'document.txt';
      if (!content) throw new Error('content 不能为空');
    } else {
      throw new Error('参数必须是文件路径字符串或 { content, fileName } 对象');
    }
    var chunks = chunkDocument(content);
    if (chunks.length === 0) return { success: false, error: '文档内容为空或过短' };
    docId = Date.now().toString(36) + '_' + fileName.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_');
    var hasEmbedding = await checkEmbeddingModel();
    var chunkEmbeddings = [];
    var embeddingSuccessCount = 0;
    for (var i = 0; i < chunks.length; i++) {
      if (hasEmbedding) {
        var embedding = await getEmbedding(chunks[i]);
        if (embedding) { chunkEmbeddings.push(embedding); embeddingSuccessCount++; }
        else chunkEmbeddings.push(null);
      } else {
        chunkEmbeddings.push(null);
      }
    }
    var metadata = {
      id: docId, fileName: fileName,
      uploadedAt: new Date().toISOString(),
      totalChunks: chunks.length,
      hasEmbeddings: embeddingSuccessCount > 0,
      embeddingModel: embeddingSuccessCount > 0 ? EMBEDDING_MODEL : null,
    };
    var chunksWithVectors = chunks.map(function(text, i) {
      return { index: i, text: text, embedding: chunkEmbeddings[i] };
    });
    var savePath = path.join(getKnowledgeDir(), docId + '.json');
    fs.writeFileSync(savePath, JSON.stringify({ metadata: metadata, chunks: chunksWithVectors }, null, 2));
    // Update index
    var indexPath = path.join(getKnowledgeDir(), 'index.json');
    var index = [];
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e) { index = []; }
    }
    index.push({
      id: docId, fileName: metadata.fileName,
      chunkCount: metadata.totalChunks,
      hasEmbeddings: metadata.hasEmbeddings,
      uploadedAt: metadata.uploadedAt,
    });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log('[knowledge] uploaded: ' + fileName + ' (' + chunks.length + ' chunks)');
    return { success: true, docId: docId, chunks: chunks.length, fileName: metadata.fileName, hasEmbeddings: embeddingSuccessCount > 0 };
  } catch (err) {
    console.error('[knowledge] upload failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ===== 搜索 =====
async function search(query, topK) {
  topK = topK || 5;
  ensureDir();
  if (!query || !query.trim()) return [];
  var allChunks = loadAllChunks();
  if (allChunks.length === 0) return [];
  var chunksWithEmbeddings = allChunks.filter(function(c) { return c.embedding; });
  var hasVectorData = chunksWithEmbeddings.length > 0;
  var queryEmbedding = null;
  if (hasVectorData) queryEmbedding = await getEmbedding(query);
  if (queryEmbedding && hasVectorData) {
    var vectorResults = chunksWithEmbeddings.map(function(chunk) {
      return { text: chunk.text, fileName: chunk.fileName, docId: chunk.docId, index: chunk.index, score: cosineSimilarity(queryEmbedding, chunk.embedding) };
    });
    vectorResults.sort(function(a, b) { return b.score - a.score; });
    return vectorResults.slice(0, topK);
  }
  var bm25Results = bm25Search(query, allChunks, topK);
  if (bm25Results.length > 0) {
    return bm25Results.map(function(r) {
      return { text: r.text, fileName: r.fileName, docId: r.docId, score: r.score };
    });
  }
  return [];
}

// ===== RRF 融合 =====
function rrfFuse(rankingsList, k) {
  k = k || 60;
  var scores = {};
  rankingsList.forEach(function(ranking) {
    ranking.forEach(function(item, rank) {
      var key = item.docId + '::' + item.index;
      if (!scores[key]) scores[key] = { item: item, score: 0 };
      scores[key].score += 1.0 / (k + rank + 1);
    });
  });
  var fused = Object.values(scores);
  fused.sort(function(a, b) { return b.score - a.score; });
  return fused.map(function(f) {
    return { text: f.item.text, fileName: f.item.fileName, docId: f.item.docId, index: f.item.index, score: f.score };
  });
}

// ===== 带引用的搜索 =====
async function searchWithCitations(query, topK, options) {
  options = options || {};
  var minScore = options.minScore || 0.01;
  topK = topK || 5;
  ensureDir();
  var allChunks = loadAllChunks();
  if (allChunks.length === 0) return { results: [], citations: '', context: '' };
  var queryEmbedding = null;
  var chunksWithEmbeddings = allChunks.filter(function(c) { return c.embedding; });
  if (chunksWithEmbeddings.length > 0) queryEmbedding = await getEmbedding(query);
  var vectorResults = [];
  if (queryEmbedding && chunksWithEmbeddings.length > 0) {
    vectorResults = chunksWithEmbeddings.map(function(chunk) {
      return { text: chunk.text, fileName: chunk.fileName, docId: chunk.docId, index: chunk.index, score: cosineSimilarity(queryEmbedding, chunk.embedding) };
    });
    vectorResults.sort(function(a, b) { return b.score - a.score; });
    vectorResults = vectorResults.slice(0, topK * 2);
  }
  var bm25Results = bm25Search(query, allChunks, topK * 2);
  var finalResults;
  if (vectorResults.length > 0 && bm25Results.length > 0) {
    finalResults = rrfFuse([vectorResults, bm25Results]);
  } else if (vectorResults.length > 0) {
    finalResults = vectorResults;
  } else if (bm25Results.length > 0) {
    finalResults = bm25Results;
  } else {
    return { results: [], citations: '', context: '' };
  }
  finalResults = finalResults.filter(function(r) { return (r.score) >= minScore; });
  finalResults = finalResults.slice(0, topK);
  var citations = '';
  var context = '';
  var sourceSet = {};
  finalResults.forEach(function(r, i) {
    var sourceName = r.fileName || '未知';
    if (!sourceSet[sourceName]) {
      sourceSet[sourceName] = true;
      citations += '[' + (i + 1) + '] ' + sourceName + '\n';
    }
    context += '--- Source [' + (i + 1) + '] ' + sourceName + ' ---\n' + (r.text || '').substring(0, 500) + '\n\n';
  });
  return { results: finalResults, citations: citations.trim(), context: context.trim() };
}

function listDocuments() {
  var indexPath = path.join(getKnowledgeDir(), 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e) { return []; }
}

async function deleteDocument(docId) {
  ensureDir();
  try {
    var docPath = path.join(getKnowledgeDir(), docId + '.json');
    if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
    var indexPath = path.join(getKnowledgeDir(), 'index.json');
    if (fs.existsSync(indexPath)) {
      var index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      index = index.filter(function(d) { return d.id !== docId; });
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getStats() {
  var docs = listDocuments();
  var allChunks = loadAllChunks();
  var withEmbeddings = allChunks.filter(function(c) { return c.embedding; }).length;
  return {
    totalDocs: docs.length,
    totalChunks: allChunks.length,
    chunksWithEmbeddings: withEmbeddings,
    chunksWithoutEmbeddings: allChunks.length - withEmbeddings,
    embeddingModel: embeddingAvailable ? EMBEDDING_MODEL : null,
    embeddingAvailable: !!embeddingAvailable,
    searchMode: withEmbeddings > 0 ? 'vector + BM25' : 'BM25',
  };
}

// ===== URL 导入 =====
async function importFromUrl(url) {
  if (!url || !url.trim()) return { success: false, error: 'URL 不能为空' };
  if (!url.startsWith('http')) url = 'https://' + url;
  return new Promise(function(resolve) {
    var client = url.startsWith('https') ? https : http;
    var body = '';
    var maxSize = 1024 * 1024;
    try {
      var req = client.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIAgentPro/1.0)' },
        timeout: 15000
      }, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(importFromUrl(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ success: false, error: 'HTTP ' + res.statusCode });
          return;
        }
        res.on('data', function(chunk) { if (body.length < maxSize) body += chunk.toString(); });
        res.on('end', async function() {
          try {
            var text = extractTextFromHtml(body);
            if (!text || text.length < 50) {
              resolve({ success: false, error: '网页内容过少或为空' });
              return;
            }
            if (text.length > 50000) text = text.substring(0, 50000) + '\n\n[truncated]';
            var fileName = 'web_' + url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_').substring(0, 60);
            var result = await uploadDocument({ content: text, fileName: fileName + '.txt' });
            result.sourceUrl = url;
            resolve(result);
          } catch (e) {
            resolve({ success: false, error: '解析失败: ' + e.message });
          }
        });
      });
      req.on('error', function(e) { resolve({ success: false, error: '请求失败: ' + e.message }); });
      req.on('timeout', function() { req.destroy(); resolve({ success: false, error: '请求超时' }); });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// HTML text extraction (server-side copy)
function extractTextFromHtml(html) {
  if (!html) return '';
  var title = '';
  var titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].trim();
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<[^>]+>/g, ' ');
  html = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  html = html.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  var result = '';
  if (title) result += '# ' + title + '\n\n';
  result += html;
  return result;
}

// ===== 模块导出 =====
module.exports = {
  name: 'knowledge',
  dependencies: [],
  init: function(_Core, router) {
    Core = _Core;

    // Register WebSocket handlers
    if (router) {
      router.handle('kb.search', async function(params) {
        var results = await search(params.query, params.topK);
        return { results: results };
      });
      router.handle('kb.searchCitations', async function(params) {
        return await searchWithCitations(params.query, params.topK, params.options);
      });
      router.handle('kb.upload', async function(params) {
        if (params.content) {
          return await uploadDocument({ content: params.content, fileName: params.fileName || 'document.txt' });
        }
        return await uploadDocument(params.filePath);
      });
      router.handle('kb.importUrl', async function(params) {
        return await importFromUrl(params.url);
      });
      router.handle('kb.list', function() {
        return { documents: listDocuments() };
      });
      router.handle('kb.delete', async function(params) {
        return await deleteDocument(params.docId);
      });
      router.handle('kb.stats', function() {
        return getStats();
      });
    }

    // Expose on Core
    Core.knowledge = {
      uploadDocument: uploadDocument,
      search: search,
      searchWithCitations: searchWithCitations,
      importFromUrl: importFromUrl,
      listDocuments: listDocuments,
      deleteDocument: deleteDocument,
      getKnowledgeDir: getKnowledgeDir,
      getStats: getStats,
    };

    // Async init: check embedding model
    ensureDir();
    checkEmbeddingModel().then(function() {
      var s = getStats();
      console.log('[knowledge] ' + s.totalDocs + ' docs, ' + s.totalChunks + ' chunks, mode: ' + s.searchMode);
    });
  }
};
