// modules/knowledge.js - 知识库模块（JSON 文件持久化 + Ollama 嵌入 + BM25 混合检索 + RRF 融合排序）
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let Core = null;

// ===== 配置 =====
function getKnowledgeDir() {
  // 🔧 优先使用全局数据根目录下的知识库，回退到动态路径
  if (Core && Core._globalDataRoot) return path.join(Core._globalDataRoot, 'knowledge');
  if (Core && Core.DATA_ROOT) return path.join(Core.DATA_ROOT, 'knowledge');
  // 最终兜底：使用 PathService
  return Core.pathService.global('knowledge');
}

const CHUNK_SIZE = 500;   // 每个文档块的最大字符数
const OVERLAP = 100;      // 块与块之间的重叠字符数
const DEFAULT_EMBEDDING_MODEL = 'bge-m3';
const FALLBACK_EMBEDDING_MODEL = 'nomic-embed-text';
const OLLAMA_BASE = 'http://127.0.0.1:11434';

// ===== 嵌入模型可用性缓存 =====
let embeddingAvailable = null; // null = 未检测, true = 可用, false = 不可用
let activeEmbeddingModel = null; // 实际使用的嵌入模型名（检测后缓存）

// 获取用户配置的嵌入模型（优先 config，默认 bge-m3）
function getPreferredEmbeddingModel() {
  if (Core && Core.config && Core.config.embeddingModel) {
    return Core.config.embeddingModel;
  }
  return DEFAULT_EMBEDDING_MODEL;
}

// 获取当前实际生效的嵌入模型（考虑可用性回退）
function getEmbeddingModel() {
  if (activeEmbeddingModel) return activeEmbeddingModel;
  return getPreferredEmbeddingModel();
}

// ===== 确保目录存在 =====
function ensureDir() {
  const dir = getKnowledgeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ===== 检测嵌入模型是否可用（支持 fallback 链）=====
async function checkEmbeddingModel(force) {
  if (embeddingAvailable !== null && !force) return embeddingAvailable;

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name || m.model || '');

    // 优先检测用户配置/默认模型
    const preferred = getPreferredEmbeddingModel();
    const foundPreferred = models.some(m =>
      m.includes(preferred) || m.startsWith(preferred + ':')
    );

    if (foundPreferred) {
      embeddingAvailable = true;
      activeEmbeddingModel = preferred;
      console.log(`✅ 嵌入模型 ${preferred} 已就绪`);
      return true;
    }

    // 回退到 fallback 模型
    if (preferred !== FALLBACK_EMBEDDING_MODEL) {
      const foundFallback = models.some(m =>
        m.includes(FALLBACK_EMBEDDING_MODEL) || m.startsWith(FALLBACK_EMBEDDING_MODEL + ':')
      );
      if (foundFallback) {
        embeddingAvailable = true;
        activeEmbeddingModel = FALLBACK_EMBEDDING_MODEL;
        console.log(`⚠️ ${preferred} 未安装，回退到 ${FALLBACK_EMBEDDING_MODEL}`);
        console.log(`💡 推荐安装: ollama pull ${preferred}`);
        return true;
      }
    }

    // 都不可用
    embeddingAvailable = false;
    activeEmbeddingModel = null;
    console.warn(`⚠️ 嵌入模型 ${preferred} 和 ${FALLBACK_EMBEDDING_MODEL} 均未安装`);
    console.warn(`💡 安装方法: ollama pull ${preferred}`);
    console.warn(`📂 知识库将使用 BM25 文本检索（无需嵌入模型，功能正常）`);
    return false;
  } catch (e) {
    embeddingAvailable = false;
    activeEmbeddingModel = null;
    console.warn('⚠️ 无法检测 Ollama 服务，嵌入模型不可用:', e.message.split('\n')[0]);
    console.warn('📂 知识库将使用 BM25 文本检索');
    return false;
  }

  // 🔧 额外验证 /api/embeddings 端点是否真的可调用（避免 tags 通但 embed 卡死）
  try {
    const model = activeEmbeddingModel || getPreferredEmbeddingModel();
    const probeResp = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model, prompt: 'test' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!probeResp.ok) throw new Error(`HTTP ${probeResp.status}`);
    const probeData = await probeResp.json();
    if (!probeData.embedding || !Array.isArray(probeData.embedding)) {
      throw new Error('embeddings 端点返回异常');
    }
  } catch (e) {
    embeddingAvailable = false;
    activeEmbeddingModel = null;
    console.warn('⚠️ Ollama embeddings 端点探测失败:', e.message.split('\n')[0]);
    console.warn('📂 知识库将使用 BM25 文本检索');
    return false;
  }

  return embeddingAvailable;
}

// ===== 读取文档内容（支持 .txt / .md / .pdf）=====
async function readFileContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(filePath, 'utf8');
  } else if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(fs.readFileSync(filePath));
      return pdfData.text;
    } catch (e) {
      throw new Error(`PDF 解析失败: ${e.message}（请确保已安装 pdf-parse）`);
    }
  } else if (ext === '.docx' || ext === '.doc') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (e) {
      throw new Error(`DOCX 解析失败: ${e.message}（请确保已安装 mammoth）`);
    }
  } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    try {
      const XLSX = require('xlsx');
      const workbook = XLSX.readFile(filePath);
      let allText = '';
      workbook.sheetNames.forEach(function(sheetName) {
        const ws = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(ws);
        allText += '== ' + sheetName + ' ==\n' + csv + '\n\n';
      });
      return allText.trim();
    } catch (e) {
      throw new Error(`XLSX 解析失败: ${e.message}（请确保已安装 xlsx）`);
    }
  } else {
    throw new Error(`不支持的文件类型: ${ext}（支持 .txt / .md / .pdf / .docx / .xlsx / .csv）`);
  }
}

// ===== 中文友好的文档切分 =====
// 优先按句子边界切分，保证中文文本不被截断
function chunkDocument(text) {
  if (!text || !text.trim()) return [];

  // 清理多余空白（保留段落分隔）
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 句子分隔符：中文句号、感叹号、问号、分号、换行、英文句号
  const SENTENCE_RE = /(?<=[。！？；\n.!?;])\s*/;
  const sentences = text.split(SENTENCE_RE).filter(s => s.trim());

  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    // 如果单个句子就超过 CHUNK_SIZE，强制按字符切分
    if (sentence.length > CHUNK_SIZE) {
      // 先把当前累积的内容作为一个 chunk
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      // 按字符切分超长句子
      for (let i = 0; i < sentence.length; i += CHUNK_SIZE - OVERLAP) {
        const sub = sentence.substring(i, i + CHUNK_SIZE);
        if (sub.trim()) chunks.push(sub.trim());
      }
      // 最后一段可能不足 CHUNK_SIZE，作为下一段的开头（重叠）
      const lastStart = Math.max(0, sentence.length - OVERLAP);
      currentChunk = sentence.substring(lastStart);
      continue;
    }

    // 累积句子，直到达到 CHUNK_SIZE
    if (currentChunk.length + sentence.length > CHUNK_SIZE && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      // 重叠：取当前 chunk 末尾 OVERLAP 个字符作为下一段开头
      const overlapText = currentChunk.length > OVERLAP
        ? currentChunk.substring(currentChunk.length - OVERLAP)
        : currentChunk;
      currentChunk = overlapText + sentence;
    } else {
      currentChunk += sentence;
    }
  }

  // 最后一个 chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // 过滤掉过短的 chunk（< 10 字符，通常是噪音）
  return chunks.filter(c => c.length >= 10);
}

// ===== 生成文本向量（调用 Ollama 嵌入模型）=====
async function getEmbedding(text) {
  if (embeddingAvailable === false) return null;

  try {
    const model = getEmbeddingModel();
    // 🔧 缩短超时：嵌入模型本地推理通常很快，10 秒足够；超时时快速降级 BM25
    const resp = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: text.substring(0, 8000), // bge-m3 支持较长输入
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('返回数据中无有效向量');
    }
    return data.embedding;
  } catch (err) {
    // 只打印一次友好提示，避免刷屏
    if (embeddingAvailable !== false) {
      console.warn('⚠️ 获取向量失败:', err.message.split('\n')[0]);
      console.warn('💡 如需语义检索，请确保 Ollama 已启动且模型已安装：ollama pull ' + getPreferredEmbeddingModel());
      console.warn('📂 当前已自动降级为 BM25 文本检索，知识库功能仍可用');
    }
    // 标记为不可用，避免后续重复请求
    embeddingAvailable = false;
    return null;
  }
}

// ===== 余弦相似度 =====
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ===== BM25 文本检索（无需向量的纯文本搜索）=====
// 当嵌入模型不可用时的核心检索算法

// 中文分词简化版：按字符 unigram + bigram + 标点/空格分隔的词语
function tokenize(text) {
  if (!text) return [];
  const tokens = [];

  // 提取英文/数字词
  const wordMatches = text.toLowerCase().match(/[a-z0-9]+/g);
  if (wordMatches) tokens.push(...wordMatches);

  // 提取中文字符：unigram + bigram
  const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  for (let i = 0; i < chineseChars.length; i++) {
    tokens.push(chineseChars[i]); // unigram
    if (i < chineseChars.length - 1) {
      tokens.push(chineseChars[i] + chineseChars[i + 1]); // bigram
    }
  }

  return tokens;
}

// BM25 参数
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function bm25Search(query, chunks, topK) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !chunks.length) return [];

  // 统计文档频率 (DF)
  const N = chunks.length;
  const df = {}; // token -> 包含该 token 的文档数
  const avgDocLen = chunks.reduce((sum, c) => sum + c.text.length, 0) / N;

  for (const chunk of chunks) {
    const chunkTokens = new Set(tokenize(chunk.text));
    for (const t of chunkTokens) {
      df[t] = (df[t] || 0) + 1;
    }
  }

  // 计算每个 chunk 的 BM25 分数
  const scores = chunks.map(chunk => {
    const chunkTokens = tokenize(chunk.text);
    // 词频统计
    const tf = {};
    for (const t of chunkTokens) {
      tf[t] = (tf[t] || 0) + 1;
    }

    let score = 0;
    const docLen = chunk.text.length;

    for (const qt of queryTokens) {
      if (!df[qt]) continue;
      const idf = Math.log((N - df[qt] + 0.5) / (df[qt] + 0.5) + 1);
      const freq = tf[qt] || 0;
      const numerator = freq * (BM25_K1 + 1);
      const denominator = freq + BM25_K1 * (1 - BM25_B + BM25_B * docLen / avgDocLen);
      score += idf * numerator / denominator;
    }

    return { ...chunk, score };
  });

  // 排序并返回 topK
  scores.sort((a, b) => b.score - a.score);
  return scores.filter(s => s.score > 0).slice(0, topK);
}

// ===== 读取所有已存储的 chunks =====
// 🔧 #16: loadAllChunks 缓存层（避免每次搜索都重读磁盘）
var _chunksCache = null;
var _chunksCacheTime = 0;
var CHUNKS_CACHE_TTL = 60000; // 1 分钟 TTL（兜底，正常靠 invalidate 刷新）

function invalidateChunksCache() { _chunksCache = null; }

function loadAllChunks() {
  // 缓存命中
  if (_chunksCache && (Date.now() - _chunksCacheTime < CHUNKS_CACHE_TTL)) {
    return _chunksCache;
  }

  const dir = getKnowledgeDir();
  if (!fs.existsSync(dir)) return [];

  const allChunks = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const meta = data.metadata || {};
      for (const chunk of (data.chunks || [])) {
        if (chunk.text) {
          allChunks.push({
            text: chunk.text,
            index: chunk.index,
            embedding: chunk.embedding || null,
            fileName: meta.fileName || '未知',
            docId: meta.id || file.replace('.json', ''),
          });
        }
      }
    } catch (e) {
      console.warn(`⚠️ 读取知识库文件失败: ${file}`, e.message);
    }
  }

  _chunksCache = allChunks;
  _chunksCacheTime = Date.now();
  return allChunks;
}

// ===== 上传文档并存储 =====
async function uploadDocument(filePathOrContent) {
  ensureDir();
  try {
    let content, fileName, docId;

    if (typeof filePathOrContent === 'string') {
      // 文件路径
      content = await readFileContent(filePathOrContent);
      fileName = path.basename(filePathOrContent);
    } else if (typeof filePathOrContent === 'object' && filePathOrContent !== null) {
      // 直接传入内容
      content = filePathOrContent.content;
      fileName = filePathOrContent.fileName || 'document.txt';
      if (!content) throw new Error('content 不能为空');
    } else {
      throw new Error('参数必须是文件路径字符串或 { content, fileName } 对象');
    }

    // 计算内容哈希（用于去重）
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    // 🔒 #5 修复：同名文档追加序号而非静默覆盖
    var existingDocNames = listDocuments().map(function(d) { return d.fileName; });
    var finalName = fileName;
    var baseName = fileName;
    var nameCounter = 1;
    while (existingDocNames.indexOf(finalName) >= 0) {
      var dotIdx = baseName.lastIndexOf('.');
      if (dotIdx > 0) {
        finalName = baseName.substring(0, dotIdx) + '_' + nameCounter + baseName.substring(dotIdx);
      } else {
        finalName = baseName + '_' + nameCounter;
      }
      nameCounter++;
    }
    if (finalName !== fileName) {
      console.log('🔄 同名文档已存在，重命名: ' + fileName + ' → ' + finalName);
      fileName = finalName;
    }

    // 检查是否已存在相同内容的文档
    const existingIndex = listDocuments();
    const existingDoc = existingIndex.find(d => d.contentHash === contentHash);
    if (existingDoc) {
      console.log(`⏭️ 文档内容未变化，跳过重复上传: ${fileName} (hash: ${contentHash.substring(0, 12)}...)`);
      return { success: true, skipped: true, id: existingDoc.id, fileName: existingDoc.fileName, contentHash };
    }

    // 切分文档
    const chunks = chunkDocument(content);
    if (chunks.length === 0) {
      return { success: false, error: '文档内容为空或过短，无法分块' };
    }

    docId = Date.now().toString(36) + '_' + fileName.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_');

    // 检测嵌入模型
    const hasEmbedding = await checkEmbeddingModel();

    // 生成每个块的向量（如果嵌入模型可用）
    const chunkIds = [];
    const chunkTexts = [];
    const chunkEmbeddings = [];
    let embeddingSuccessCount = 0;
    let embeddingFailCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      chunkIds.push(`${docId}_chunk_${i}`);
      chunkTexts.push(chunks[i]);

      if (hasEmbedding) {
        const embedding = await getEmbedding(chunks[i]);
        if (embedding) {
          chunkEmbeddings.push(embedding);
          embeddingSuccessCount++;
        } else {
          chunkEmbeddings.push(null);
          embeddingFailCount++;
        }
      } else {
        chunkEmbeddings.push(null);
      }
    }

    // 始终存储所有 chunks（无论是否有向量）
    const metadata = {
      id: docId,
      fileName: fileName,
      sourcePath: (typeof filePathOrContent === 'string') ? path.resolve(filePathOrContent) : null,
      contentHash: contentHash,
      uploadedAt: new Date().toISOString(),
      totalChunks: chunks.length,
      hasEmbeddings: embeddingSuccessCount > 0,
      embeddingModel: embeddingSuccessCount > 0 ? getEmbeddingModel() : null,
    };

    const chunksWithVectors = chunkTexts.map((text, i) => ({
      index: i,
      text: text,
      embedding: chunkEmbeddings[i], // 可能为 null
    }));

    // 保存 JSON 文件
    const savePath = path.join(getKnowledgeDir(), `${docId}.json`);
    fs.writeFileSync(savePath, JSON.stringify({
      metadata: metadata,
      chunks: chunksWithVectors,
    }, null, 2));

    // 更新索引
    const indexPath = path.join(getKnowledgeDir(), 'index.json');
    let index = [];
    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch (e) {
        index = [];
      }
    }
    index.push({
      id: docId,
      fileName: metadata.fileName,
      contentHash: contentHash,
      chunkCount: metadata.totalChunks,
      hasEmbeddings: metadata.hasEmbeddings,
      uploadedAt: metadata.uploadedAt,
    });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    invalidateChunksCache(); // 🔧 #16: 写入后失效缓存

    // 构建返回消息
    let embedMsg = '';
    if (embeddingSuccessCount > 0) {
      embedMsg = `，向量嵌入 ${embeddingSuccessCount}/${chunks.length} 块`;
    } else {
      embedMsg = '（使用 BM25 文本检索模式）';
      if (!hasEmbedding) {
        embedMsg += `\n💡 如需语义检索，请安装嵌入模型: ollama pull ${getPreferredEmbeddingModel()}`;
      }
    }

    console.log(`✅ 文档已上传: ${fileName} (${chunks.length} 个分块${embedMsg})`);
    return {
      success: true,
      docId,
      chunks: chunks.length,
      fileName: metadata.fileName,
      hasEmbeddings: embeddingSuccessCount > 0,
      embeddingCount: embeddingSuccessCount,
    };
  } catch (err) {
    console.error('❌ 上传文档失败:', err);
    return { success: false, error: err.message };
  }
}

// ===== 混合检索：向量 + BM25 =====
async function search(query, topK = 5) {
  ensureDir();

  if (!query || !query.trim()) return [];

  const allChunks = loadAllChunks();
  if (allChunks.length === 0) {
    return [];
  }

  // 检查是否有向量数据
  const chunksWithEmbeddings = allChunks.filter(c => c.embedding);
  const hasVectorData = chunksWithEmbeddings.length > 0;

  // 尝试获取查询向量
  let queryEmbedding = null;
  if (hasVectorData) {
    queryEmbedding = await getEmbedding(query);
  }

  // === 策略 1: 向量检索（如果有向量数据且查询向量成功）===
  if (queryEmbedding && hasVectorData) {
    const vectorResults = chunksWithEmbeddings.map(chunk => ({
      text: chunk.text,
      fileName: chunk.fileName,
      docId: chunk.docId,
      index: chunk.index,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));
    vectorResults.sort((a, b) => b.score - a.score);
    const topVector = vectorResults.slice(0, topK);

    console.log(`✅ 向量检索到 ${topVector.length} 条结果（最高相似度: ${topVector[0]?.score?.toFixed(3) || 'N/A'}）`);
    return topVector;
  }

  // === 策略 2: BM25 文本检索（无向量时的回退）===
  const bm25Results = bm25Search(query, allChunks, topK);

  if (bm25Results.length > 0) {
    console.log(`✅ BM25 检索到 ${bm25Results.length} 条结果（最高分数: ${bm25Results[0].score.toFixed(3)}）`);
    return bm25Results.map(r => ({
      text: r.text,
      fileName: r.fileName,
      docId: r.docId,
      score: r.score,
    }));
  }

  return [];
}

// ===== 列出已上传的文档 =====
// 🔒 #20: FTS5 全文检索（比内存遍历快 10-100 倍）
function searchFTS(query, limit) {
  limit = limit || 5;
  try {
    if (typeof db === 'undefined' || !db) return [];
    var rows = db.prepare(
      'SELECT kc.* FROM knowledge_fts fts JOIN knowledge_chunks kc ON kc.rowid = fts.rowid WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?'
    ).all(query, limit);
    return rows;
  } catch (e) {
    console.warn('⚠️ [knowledge] FTS5 检索失败，回退到内存检索:', e.message);
    return [];
  }
}

function listDocuments() {
  const indexPath = path.join(getKnowledgeDir(), 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    console.warn('⚠️ 读取知识库索引失败:', e.message);
    return [];
  }
}

// ===== 删除文档 =====
async function deleteDocument(docId) {
  ensureDir();
  try {
    // 1. 删除 JSON 文件
    const docPath = path.join(getKnowledgeDir(), `${docId}.json`);
    if (fs.existsSync(docPath)) {
      fs.unlinkSync(docPath);
      console.log('✅ 已删除知识库文件:', docId);
    }

    // 2. 更新索引
    const indexPath = path.join(getKnowledgeDir(), 'index.json');
    if (fs.existsSync(indexPath)) {
      let index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      index = index.filter(d => d.id !== docId);
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    }
    invalidateChunksCache(); // 🔧 #16: 删除后失效缓存

    return { success: true };
  } catch (err) {
    console.error('❌ 删除文档失败:', err);
    return { success: false, error: err.message };
  }
}

// ===== 重建嵌入向量（当嵌入模型安装后，为已有文档补充向量）=====
async function rebuildEmbeddings() {
  const hasEmbedding = await checkEmbeddingModel(true);
  if (!hasEmbedding) {
    const model = getPreferredEmbeddingModel();
    return { success: false, error: `嵌入模型 ${model} 不可用，请先安装: ollama pull ${model}` };
  }

  const currentModel = getEmbeddingModel();

  ensureDir();
  const dir = getKnowledgeDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
  let totalChunks = 0;
  let embeddedChunks = 0;

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      let modified = false;
      for (const chunk of (data.chunks || [])) {
        totalChunks++;
        if (!chunk.embedding && chunk.text) {
          const embedding = await getEmbedding(chunk.text);
          if (embedding) {
            chunk.embedding = embedding;
            embeddedChunks++;
            modified = true;
          }
        }
      }

      if (modified) {
        data.metadata.hasEmbeddings = true;
        data.metadata.embeddingModel = currentModel;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`✅ 已补充向量: ${file}`);
      }
    } catch (e) {
      console.warn(`⚠️ 重建嵌入失败: ${file}`, e.message);
    }
  }

  // 更新索引中的 hasEmbeddings 标记
  const indexPath = path.join(dir, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      for (const doc of index) {
        doc.hasEmbeddings = true;
      }
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    } catch (e) { console.warn('[Knowledge] Failed to update index:', e.message); }
  }

  console.log(`✅ 嵌入重建完成: ${embeddedChunks}/${totalChunks} 块已补充向量`);
  return {
    success: true,
    totalChunks,
    embeddedChunks,
    message: `已为 ${embeddedChunks}/${totalChunks} 个分块补充向量嵌入`,
  };
}

// ===== 嵌入模型迁移（模型切换后自动重新嵌入旧文档）=====
let _migrationRunning = false;
async function migrateEmbeddings() {
  if (_migrationRunning) return { success: false, error: '迁移正在进行中' };
  const hasEmbedding = await checkEmbeddingModel(true);
  if (!hasEmbedding) return { success: false, error: '无可用嵌入模型' };

  const currentModel = getEmbeddingModel();
  ensureDir();
  const dir = getKnowledgeDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');

  // 找出需要迁移的文档
  const toMigrate = [];
  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const docModel = data.metadata && data.metadata.embeddingModel;
      if (docModel && docModel !== currentModel) {
        toMigrate.push({ file, filePath, data });
      }
    } catch (e) { /* skip corrupt files */ }
  }

  if (toMigrate.length === 0) {
    return { success: true, migrated: 0, message: '所有文档已使用当前模型，无需迁移' };
  }

  _migrationRunning = true;
  let migratedDocs = 0;
  let migratedChunks = 0;

  try {
    for (const { file, filePath, data } of toMigrate) {
      let modified = false;
      for (const chunk of (data.chunks || [])) {
        if (chunk.text) {
          const embedding = await getEmbedding(chunk.text);
          if (embedding) {
            chunk.embedding = embedding;
            modified = true;
            migratedChunks++;
          }
        }
      }
      if (modified) {
        data.metadata.embeddingModel = currentModel;
        data.metadata.hasEmbeddings = true;
        data.metadata.migratedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        migratedDocs++;
        console.log(`🔄 嵌入迁移: ${file} → ${currentModel}`);
      }
    }

    // 更新 index.json
    const indexPath = path.join(dir, 'index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        for (const doc of index) {
          if (toMigrate.some(t => t.data.metadata.id === doc.id)) {
            doc.hasEmbeddings = true;
            doc.embeddingModel = currentModel;
          }
        }
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      } catch (e) { /* non-critical */ }
    }

    console.log(`✅ 嵌入迁移完成: ${migratedDocs} 文档, ${migratedChunks} 块 → ${currentModel}`);
    return { success: true, migrated: migratedDocs, chunks: migratedChunks, model: currentModel };
  } finally {
    _migrationRunning = false;
  }
}

// ===== 获取知识库统计信息 =====
function getStats() {
  const docs = listDocuments();
  const allChunks = loadAllChunks();
  const withEmbeddings = allChunks.filter(c => c.embedding).length;

  // 检测当前后端
  var searchMode = withEmbeddings > 0 ? '向量 + BM25' : 'BM25 文本检索';

  return {
    totalDocs: docs.length,
    totalChunks: allChunks.length,
    chunksWithEmbeddings: withEmbeddings,
    chunksWithoutEmbeddings: allChunks.length - withEmbeddings,
    embeddingModel: embeddingAvailable ? getEmbeddingModel() : null,
    embeddingAvailable: !!embeddingAvailable,
    vectorBackend: (Core && Core.config && Core.config.vectorBackend) || 'json',
    searchMode: searchMode,
  };
}

// ===== 对话记忆自动存储 =====
// 将一组 Q&A 消息保存为知识文档（用于对话记忆）
async function saveConversation(messages, title) {
  if (!messages || messages.length === 0) {
    return { success: false, error: '没有消息可保存' };
  }
  // 提取最后一轮 Q&A
  var userMsg = '';
  var aiMsg = '';
  for (var i = messages.length - 1; i >= 0; i--) {
    var m = messages[i];
    var role = m.role || '';
    if (!aiMsg && (role === 'assistant' || role === 'ai')) {
      aiMsg = m.content || '';
    } else if (!userMsg && (role === 'user') && aiMsg) {
      userMsg = m.content || '';
      break;
    }
  }
  if (!userMsg && !aiMsg) {
    return { success: false, error: '未找到有效的 Q&A 对话' };
  }
  // 构造文档内容
  var docContent = '# 对话记录\n\n';
  if (title) docContent += '## ' + title + '\n\n';
  docContent += '**问题：** ' + userMsg + '\n\n';
  docContent += '**回答：** ' + aiMsg.substring(0, 2000) + '\n';

  // 用 uploadDocument 的逻辑存入知识库
  var fileName = 'auto_' + (title || 'conversation').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30);
  try {
    var result = await uploadDocument({ content: docContent, fileName: fileName + '.md' });
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== HTML 文本提取（用于 URL 导入）=====
function _extractTextFromHtml(html) {
  if (!html) return '';
  // 提取标题
  var title = '';
  var titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].trim();
  // 移除 script / style
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  // 提取 meta description
  var metaDesc = '';
  var metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
  if (metaMatch) metaDesc = metaMatch[1].trim();
  // 替换 block 标签为换行
  html = html.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  html = html.replace(/<br\s*\/?>/gi, '\n');
  // 移除所有标签
  html = html.replace(/<[^>]+>/g, ' ');
  // 解码 HTML 实体
  html = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // 清理空白
  html = html.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  var result = '';
  if (title) result += '# ' + title + '\n\n';
  if (metaDesc) result += metaDesc + '\n\n';
  result += html;
  return result;
}

// ===== 从 URL 导入网页到知识库 =====
async function importFromUrl(url) {
  if (!url || !url.trim()) return { success: false, error: 'URL 不能为空' };
  if (!url.startsWith('http')) url = 'https://' + url;

  return new Promise(function(resolve) {
    var client = url.startsWith('https') ? https : http;
    var body = '';
    var maxSize = 1024 * 1024; // 1MB 限制

    try {
      var req = client.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIAgentPro/1.0)' },
        timeout: 15000
      }, function(res) {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith('http')) {
            var u = new URL(url);
            redirectUrl = u.origin + redirectUrl;
          }
          resolve(importFromUrl(redirectUrl));
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ success: false, error: 'HTTP ' + res.statusCode });
          return;
        }
        res.on('data', function(chunk) {
          if (body.length < maxSize) body += chunk.toString();
        });
        res.on('end', async function() {
          try {
            var text = _extractTextFromHtml(body);
            if (!text || text.length < 50) {
              resolve({ success: false, error: '网页内容过少或为空（可能为 SPA 动态页面）' });
              return;
            }
            // 截断到合理长度
            if (text.length > 50000) text = text.substring(0, 50000) + '\n\n[内容已截断]';
            // 从 URL 提取文件名
            var fileName = 'web_' + url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_').substring(0, 60);
            var result = await uploadDocument({ content: text, fileName: fileName + '.txt', sourceUrl: url });
            result.sourceUrl = url;
            result.title = text.split('\n')[0] || url;
            console.log('✅ URL 导入成功:', url, '→', fileName, '分块数:', result.chunkCount || 'N/A');
            resolve(result);
          } catch (e) {
            resolve({ success: false, error: '解析失败: ' + e.message });
          }
        });
      });
      req.on('error', function(e) { resolve({ success: false, error: '请求失败: ' + e.message }); });
      req.on('timeout', function() { req.destroy(); resolve({ success: false, error: '请求超时 (15s)' }); });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// ===== SiliconFlow Rerank（bge-reranker-v2-m3）=====
var _rerankPrivacyNotified = false;

async function rerankResults(query, results, topN) {
  // 门控：需要 API key + 配置未禁用 + 结果数 > 1
  if (!Core || !Core.config) return null;
  if (Core.config.rerankEnabled === false) return null;
  var apiKey = Core.config.siliconFlowKey || '';
  apiKey = apiKey.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) return null;
  if (!results || results.length <= 1) return null;

  // 隐私提示（首次使用时提醒一次）
  if (!_rerankPrivacyNotified) {
    _rerankPrivacyNotified = true;
    console.log('🔒 [隐私提示] Rerank 功能会将查询内容和文档片段发送至 SiliconFlow 云端 (api.siliconflow.cn) 进行排序。如需完全本地化，请设置 config.rerankEnabled = false。');
  }

  try {
    var documents = results.map(function(r) { return (r.text || '').substring(0, 1000); });
    var body = JSON.stringify({
      model: 'BAAI/bge-reranker-v2-m3',
      query: query.substring(0, 2000),
      documents: documents,
      top_n: topN || results.length,
    });

    var resp = await fetch('https://api.siliconflow.cn/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: body,
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      console.warn('⚠️ Rerank API HTTP ' + resp.status + '，降级为 RRF 排序');
      return null;
    }

    var data = await resp.json();
    if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
      return null;
    }

    // 按 rerank 分数重排
    var reranked = data.results.map(function(item) {
      var original = results[item.index];
      if (!original) return null;
      return {
        text: original.text,
        fileName: original.fileName,
        docId: original.docId,
        index: original.index,
        score: item.relevance_score,
        rerankScore: item.relevance_score,
        rrfScore: original.rrfScore || original.score,
      };
    }).filter(Boolean);

    reranked.sort(function(a, b) { return b.rerankScore - a.rerankScore; });
    console.log('✅ Rerank 完成: ' + reranked.length + ' 条结果重排（top score: ' + (reranked[0] ? reranked[0].rerankScore.toFixed(4) : 'N/A') + '）');
    return reranked;
  } catch (e) {
    console.warn('⚠️ Rerank 失败，降级为 RRF 排序:', e.message);
    return null;
  }
}

// ===== Reciprocal Rank Fusion (RRF) — 融合多路检索结果 =====
function _rrfFuse(rankingsList, k) {
  k = k || 60; // RRF 常数，默认 60
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
  return fused.map(function(f) { return { text: f.item.text, fileName: f.item.fileName, docId: f.item.docId, index: f.item.index, score: f.score, rrfScore: f.score }; });
}

// ===== 查询改写（LLM 指代消解 + 扩展，提升召回率）=====
async function rewriteQuery(query, conversationContext) {
  // 门控：配置未禁用 + API 可用 + 查询足够短（长查询无需改写）
  if (!Core || !Core.config || Core.config.queryRewrite === false) return query;
  if (!Core.api || !Core.api.callAPI) return query;
  if (!query || query.length > 100) return query; // 长查询已足够明确

  try {
    var contextHint = '';
    if (conversationContext && conversationContext.length > 0) {
      // 取最近 2 条消息作为指代消解上下文
      var recent = conversationContext.slice(-2).map(function(m) {
        return (m.role === 'user' ? '用户: ' : 'AI: ') + (m.content || '').substring(0, 200);
      }).join('\n');
      contextHint = '\n最近对话:\n' + recent;
    }

    var systemPrompt = '你是查询改写助手。将用户的搜索查询改写为更适合知识库检索的形式。\n' +
      '规则：1)消解代词(它/这个/那个→具体名称) 2)补充省略的主语/对象 3)展开缩写 4)保持简洁，不超过30字\n' +
      '只输出改写后的查询，不要解释。如果原查询已经足够明确，原样输出。';

    var result = await Core.api.callAPI(
      query,
      systemPrompt,
      0.1,
      null, null,
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: '改写查询: "' + query + '"' + contextHint }],
      { disableTools: true }
    );

    if (result && result.message && result.message.content) {
      var rewritten = result.message.content.trim().replace(/^["']|["']$/g, '');
      if (rewritten && rewritten.length >= 2 && rewritten.length <= 80 && rewritten !== '无') {
        if (rewritten !== query) {
          console.log('🔍 查询改写: "' + query + '" → "' + rewritten + '"');
        }
        return rewritten;
      }
    }
    return query;
  } catch (e) {
    return query; // 静默降级
  }
}

// ===== 带引用的搜索（Phase 3-1 核心：混合 RRF + 相关度阈值 + 引用格式）=====
async function searchWithCitations(query, topK, options) {
  options = options || {};
  var minScore = options.minScore || 0.01; // RRF 最低分阈值
  topK = topK || 5;

  // 查询改写（指代消解 + 扩展）
  var rewrittenQuery = await rewriteQuery(query, options.conversationContext);

  ensureDir();
  var allChunks = loadAllChunks();
  if (allChunks.length === 0) return { results: [], citations: '', context: '' };

  // 尝试获取向量结果（使用改写后的查询）
  var queryEmbedding = null;
  var chunksWithEmbeddings = allChunks.filter(function(c) { return c.embedding; });
  if (chunksWithEmbeddings.length > 0) {
    queryEmbedding = await getEmbedding(rewrittenQuery);
  }

  var vectorResults = [];
  if (queryEmbedding && chunksWithEmbeddings.length > 0) {
    vectorResults = chunksWithEmbeddings.map(function(chunk) {
      return { text: chunk.text, fileName: chunk.fileName, docId: chunk.docId, index: chunk.index, score: cosineSimilarity(queryEmbedding, chunk.embedding) };
    });
    vectorResults.sort(function(a, b) { return b.score - a.score; });
    vectorResults = vectorResults.slice(0, topK * 2);
  }

  // BM25 结果（使用改写后的查询）
  var bm25Results = bm25Search(rewrittenQuery, allChunks, topK * 2);

  // RRF 融合
  var finalResults;
  if (vectorResults.length > 0 && bm25Results.length > 0) {
    // 两路融合
    finalResults = _rrfFuse([vectorResults, bm25Results]);
  } else if (vectorResults.length > 0) {
    finalResults = vectorResults;
  } else if (bm25Results.length > 0) {
    finalResults = bm25Results;
  } else {
    return { results: [], citations: '', context: '' };
  }

  // Rerank 重排（SiliconFlow bge-reranker-v2-m3，失败自动降级为 RRF 顺序）
  var rerankCandidates = finalResults.slice(0, topK * 3); // 取较多候选供 rerank
  var reranked = await rerankResults(query, rerankCandidates, topK);
  if (reranked && reranked.length > 0) {
    finalResults = reranked;
  }

  // 过滤低分 + 截取 topK
  finalResults = finalResults.filter(function(r) { return (r.rrfScore || r.score) >= minScore; });
  finalResults = finalResults.slice(0, topK);

  // 构建引用文本
  var citations = '';
  var context = '';
  var sourceSet = {};
  finalResults.forEach(function(r, i) {
    var sourceName = r.fileName || '未知';
    if (!sourceSet[sourceName]) {
      sourceSet[sourceName] = true;
      citations += '[' + (i + 1) + '] ' + sourceName + '\n';
    }
    context += '--- 来源 [' + (i + 1) + '] ' + sourceName + ' ---\n' + (r.text || '').substring(0, 500) + '\n\n';
  });

  return { results: finalResults, citations: citations.trim(), context: context.trim() };
}

// ===== 搜索建议（根据部分输入返回可能的查询）=====
function searchSuggestions(partial, limit) {
  limit = limit || 5;
  if (!partial || partial.length < 2) return [];
  var allChunks = loadAllChunks();
  if (allChunks.length === 0) return [];
  // 简单的前缀匹配
  var lowerPartial = partial.toLowerCase();
  var matches = {};
  allChunks.forEach(function(chunk) {
    var text = chunk.text || '';
    var sentences = text.split(/[。！？\n.!?]/);
    sentences.forEach(function(s) {
      s = s.trim();
      if (s.length > 10 && s.length < 100 && s.toLowerCase().indexOf(lowerPartial) >= 0) {
        var key = s.substring(0, 60);
        if (!matches[key]) matches[key] = s;
      }
    });
  });
  return Object.values(matches).slice(0, limit);
}

// ===== 目录同步（增量索引：扫描目录，新增/变更文件自动入库，已删除文件自动移除）=====
const SUPPORTED_EXTS = ['.txt', '.md', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv'];

async function syncDirectory(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { success: false, error: '目录不存在: ' + dirPath };
  }

  ensureDir();
  const stats = { added: 0, updated: 0, skipped: 0, removed: 0, errors: 0 };

  // 递归扫描目录中的支持文件
  function scanDir(dir) {
    let files = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(scanDir(fullPath));
        } else if (SUPPORTED_EXTS.includes(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    } catch (e) { /* permission errors etc */ }
    return files;
  }

  const diskFiles = scanDir(dirPath);
  const diskHashes = new Set();

  // 上传新增/变更文件
  for (const filePath of diskFiles) {
    try {
      const content = await readFileContent(filePath);
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      diskHashes.add(hash);

      const result = await uploadDocument(filePath);
      if (result.skipped) {
        stats.skipped++;
      } else if (result.success) {
        stats.added++;
      } else {
        stats.errors++;
      }
    } catch (e) {
      stats.errors++;
      console.warn('⚠️ 同步文件失败:', filePath, e.message);
    }
  }

  // 移除已不在磁盘上的文档（仅限来源于该目录的）
  const index = listDocuments();
  const normalizedDir = path.resolve(dirPath);
  for (const doc of index) {
    // 如果文档有 sourcePath 且在该目录下，但 hash 不在磁盘集合中 → 已删除
    if (doc.sourcePath && doc.sourcePath.startsWith(normalizedDir) && doc.contentHash && !diskHashes.has(doc.contentHash)) {
      await deleteDocument(doc.id);
      stats.removed++;
    }
  }

  console.log(`✅ 目录同步完成: ${dirPath} | 新增 ${stats.added}, 跳过 ${stats.skipped}, 移除 ${stats.removed}, 错误 ${stats.errors}`);
  return { success: true, ...stats, dirPath };
}

// ===== 目录监听（fs.watch + 防抖，文件变化自动增量同步）=====
const _watchers = {}; // dirPath → { watcher, timer }

function watchDirectory(dirPath, debounceMs) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { success: false, error: '目录不存在: ' + dirPath };
  }
  if (_watchers[dirPath]) {
    return { success: true, message: '已在监听中' };
  }

  debounceMs = debounceMs || 3000;
  let timer = null;

  try {
    const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!SUPPORTED_EXTS.includes(ext)) return;

      // 防抖：多次变化合并为一次同步
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        console.log(`🔄 检测到文件变化，开始增量同步: ${dirPath}`);
        syncDirectory(dirPath).catch(e => {
          console.warn('⚠️ 自动同步失败:', e.message);
        });
      }, debounceMs);
    });

    _watchers[dirPath] = { watcher, timer };
    console.log(`👁️ 开始监听目录: ${dirPath} (防抖 ${debounceMs}ms)`);
    return { success: true, message: '开始监听: ' + dirPath };
  } catch (e) {
    return { success: false, error: '监听失败: ' + e.message };
  }
}

function unwatchDirectory(dirPath) {
  if (_watchers[dirPath]) {
    _watchers[dirPath].watcher.close();
    if (_watchers[dirPath].timer) clearTimeout(_watchers[dirPath].timer);
    delete _watchers[dirPath];
    console.log(`👁️ 停止监听目录: ${dirPath}`);
    return { success: true };
  }
  return { success: false, error: '该目录未在监听中' };
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.knowledge = {
      uploadDocument,
      search,
      searchFTS,
      searchWithCitations,
      importFromUrl,
      searchSuggestions,
      listDocuments,
      deleteDocument,
      getKnowledgeDir,
      rebuildEmbeddings,
      migrateEmbeddings,
      getStats,
      saveConversation,
      syncDirectory,
      watchDirectory,
      unwatchDirectory,
      rerankResults,
      rewriteQuery,
      getEmbeddingModel,
      // 内部函数暴露（供 knowledge-distill 模块使用）
      _loadAllChunks: loadAllChunks,
      _getEmbedding: getEmbedding,
      _cosineSimilarity: cosineSimilarity,
      _tokenize: tokenize,
      _bm25Search: bm25Search,
      _chunkDocument: chunkDocument,
    };

    // 异步初始化：检测嵌入模型（不阻塞启动）
    ensureDir();

    // 🔒 #20 修复：FTS5 全文索引加速知识库检索
    try {
      if (typeof db !== 'undefined' && db) {
        db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(doc_id, text, content=knowledge_chunks, content_rowid=rowid)');
        // 同步触发器：chunks 表变更时自动更新 FTS 索引
        db.exec('CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge_chunks BEGIN INSERT INTO knowledge_fts(rowid, doc_id, text) VALUES (new.rowid, new.doc_id, new.text); END');
        db.exec('CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge_chunks BEGIN INSERT INTO knowledge_fts(knowledge_fts, rowid, doc_id, text) VALUES (\'delete\', old.rowid, old.doc_id, old.text); END');
      }
    } catch (ftsErr) {
      console.warn('⚠️ [knowledge] FTS5 索引创建失败（不影响基本功能）:', ftsErr.message);
    }

    checkEmbeddingModel().then((available) => {
      const stats = getStats();
      console.log(`✅ 知识库模块已加载 | ${stats.totalDocs} 文档, ${stats.totalChunks} 分块 | 模式: ${stats.searchMode}`);

      // 后台自动迁移：如果有文档使用旧模型，异步重新嵌入
      if (available) {
        migrateEmbeddings().then(result => {
          if (result.migrated > 0) {
            console.log(`🔄 后台嵌入迁移完成: ${result.migrated} 文档 → ${result.model}`);
          }
        }).catch(() => {});
      }

      // 自动监听配置的知识库目录
      if (Core.config && Core.config.knowledgeWatchDir) {
        watchDirectory(Core.config.knowledgeWatchDir);
      }
    });
  }
};
