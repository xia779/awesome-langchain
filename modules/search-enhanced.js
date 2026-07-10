// modules/search-enhanced.js - 搜索增强模块
// 功能：本地文件搜索、知识库语义搜索、搜索缓存、并行多引擎
let Core = null;

// 搜索缓存（减少重复请求）
const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 知识库索引（简单的 TF-IDF 实现）
let knowledgeIndex = null;

function init(_Core) {
  Core = _Core;
  Core.searchEnhanced = {
    localFileSearch,
    knowledgeSemanticSearch,
    searchWithCache,
    multiEngineSearch,
    clearSearchCache,
    buildKnowledgeIndex,
  };
  console.log('🔍 搜索增强模块已加载');
  
  // 启动时构建知识库索引
  setTimeout(() => {
    buildKnowledgeIndex().catch(e => console.warn('⚠️ 知识库索引构建失败:', e.message));
  }, 5000);
}

// ===== 1. 本地文件搜索 =====
async function localFileSearch(query, options = {}) {
  const {
    rootDir = Core.DATA_ROOT,
    extensions = ['.txt', '.md', '.json', '.pdf'],
    maxResults = 20,
    maxDepth = 3
  } = options;
  
  console.log('📂 本地文件搜索:', query, 'in', rootDir);
  const results = [];
  const queryLower = query.toLowerCase();
  
  try {
    await searchDirectory(rootDir, 0);
  } catch (e) {
    console.warn('⚠️ 本地搜索错误:', e.message);
  }
  
  // 按相关性排序（标题匹配优先）
  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, maxResults);
  
  async function searchDirectory(dir, depth) {
    if (depth > maxDepth) return;
    if (!require('fs').existsSync(dir)) return;
    
    const entries = require('fs').readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = require('path').join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('node_modules') && !entry.name.startsWith('.')) {
        await searchDirectory(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = require('path').extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) continue;
        
        // 快速匹配：文件名
        let relevance = 0;
        if (entry.name.toLowerCase().includes(queryLower)) relevance += 10;
        
        // 内容匹配（小文件）
        try {
          const stat = require('fs').statSync(fullPath);
          if (stat.size < 100000) { // 只搜索小于100KB的文件
            const content = require('fs').readFileSync(fullPath, 'utf8');
            const contentLower = content.toLowerCase();
            // 🔒 安全修复：转义 RegExp 特殊字符，防止注入
            const escapedQuery = queryLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const matches = (contentLower.match(new RegExp(escapedQuery, 'g')) || []).length;
            relevance += matches * 2;
            
            if (relevance > 0) {
              results.push({
                name: entry.name,
                path: fullPath,
                size: stat.size,
                modified: stat.mtime,
                relevance,
                snippet: extractSnippet(content, query, 150)
              });
            }
          }
        } catch (e) {}
      }
    }
  }
}

function extractSnippet(content, query, maxLen) {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.substring(0, maxLen) + '...';
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + query.length + 50);
  return (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
}

// ===== 2. 知识库语义搜索（基于 TF-IDF）=====
async function buildKnowledgeIndex() {
  try {
    const knowledgeDir = Core.KNOWLEDGE_DIR || require('path').join(Core.DATA_ROOT, 'knowledge');
    if (!require('fs').existsSync(knowledgeDir)) return;
    
    const documents = [];
    const files = require('fs').readdirSync(knowledgeDir)
      .filter(f => f.endsWith('.txt') || f.endsWith('.md'));
    
    for (const file of files) {
      try {
        const content = require('fs').readFileSync(require('path').join(knowledgeDir, file), 'utf8');
        documents.push({ id: file, text: content, tokens: tokenize(content) });
      } catch (e) {}
    }
    
    if (documents.length === 0) {
      knowledgeIndex = null;
      return;
    }
    
    // 构建词频统计
    const df = {}; // Document frequency
    documents.forEach(doc => {
      const uniqueTokens = [...new Set(doc.tokens)];
      uniqueTokens.forEach(token => {
        df[token] = (df[token] || 0) + 1;
      });
    });
    
    // 计算 TF-IDF
    const docVectors = documents.map(doc => {
      const tf = {};
      doc.tokens.forEach(token => {
        tf[token] = (tf[token] || 0) + 1;
      });
      
      const vector = {};
      Object.keys(tf).forEach(token => {
        const idf = Math.log(documents.length / (df[token] || 1)) + 1;
        vector[token] = tf[token] * idf;
      });
      
      return { id: doc.id, vector, text: doc.text };
    });
    
    knowledgeIndex = { documents: docVectors, df, totalDocs: documents.length };
    console.log('✅ 知识库索引构建完成:', documents.length, '个文档');
  } catch (e) {
    console.warn('⚠️ 知识库索引构建失败:', e.message);
  }
}

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

async function knowledgeSemanticSearch(query, topK = 5) {
  if (!knowledgeIndex) {
    console.log('⏭️ 知识库索引未构建，尝试构建...');
    await buildKnowledgeIndex();
    if (!knowledgeIndex) return [];
  }
  
  const queryTokens = tokenize(query);
  const queryVector = {};
  queryTokens.forEach(token => {
    queryVector[token] = (queryVector[token] || 0) + 1;
  });
  
  // 计算余弦相似度
  const scores = knowledgeIndex.documents.map(doc => {
    let dotProduct = 0;
    let queryNorm = 0;
    let docNorm = 0;
    
    Object.keys(queryVector).forEach(token => {
      const idf = Math.log(knowledgeIndex.totalDocs / (knowledgeIndex.df[token] || 1)) + 1;
      const qWeight = queryVector[token] * idf;
      queryNorm += qWeight * qWeight;
      if (doc.vector[token]) {
        dotProduct += qWeight * doc.vector[token];
      }
    });
    
    Object.values(doc.vector).forEach(v => {
      docNorm += v * v;
    });
    
    const similarity = dotProduct / (Math.sqrt(queryNorm) * Math.sqrt(docNorm) + 1e-9);
    return { id: doc.id, text: doc.text, similarity: Math.round(similarity * 1000) / 1000 };
  });
  
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, topK).filter(s => s.similarity > 0.01);
}

// ===== 3. 搜索缓存 =====
async function searchWithCache(searchFn, query, engine) {
  const cacheKey = `${engine}:${query}`;
  const cached = searchCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('📦 搜索缓存命中:', cacheKey);
    return cached.result;
  }
  
  const result = await searchFn(query);
  searchCache.set(cacheKey, { result, timestamp: Date.now() });
  
  // 清理过期缓存
  if (searchCache.size > 100) {
    const now = Date.now();
    for (const [key, val] of searchCache.entries()) {
      if (now - val.timestamp > CACHE_TTL) searchCache.delete(key);
    }
  }
  
  return result;
}

function clearSearchCache() {
  searchCache.clear();
  console.log('🧹 搜索缓存已清空');
}

// ===== 4. 并行多引擎搜索 =====
async function multiEngineSearch(query, engines = ['bocha', 'duckduckgo']) {
  console.log('🔍 并行多引擎搜索:', engines.join(', '));
  
  const promises = engines.map(async engine => {
    try {
      const result = await Core.webSearch(query, engine);
      return { engine, result, success: true };
    } catch (err) {
      return { engine, result: '', success: false, error: err.message };
    }
  });
  
  const results = await Promise.all(promises);
  
  // 合并结果（去重+排序）
  const successful = results.filter(r => r.success && r.result && r.result.length > 50);
  if (successful.length === 0) {
    return `关于"${query}"未找到有效搜索结果。`;
  }
  
  // 优先返回第一个成功的结果，附加其他引擎的补充信息
  let combined = successful[0].result;
  if (successful.length > 1) {
    combined += '\n\n【其他来源补充】\n';
    for (let i = 1; i < successful.length; i++) {
      combined += `\n[${successful[i].engine}]\n${successful[i].result.substring(0, 300)}...\n`;
    }
  }
  
  return combined;
}

module.exports = { init };
