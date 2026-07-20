#!/usr/bin/env node
// distill.js - 漫剧工作流经验蒸馏分析器
// 读取执行日志 → 提取失败模式 → 生成经验报告 → 输出改进建议
// 用法: node distill.js [--days 7]

var fs = require('fs');
var path = require('path');

var LOG_DIR = 'E:\\my-ai-data\\manga_pipeline\\execution_logs';
var REPORT_DIR = 'E:\\my-ai-data\\manga_pipeline\\distillation_reports';
var SKILL_FILE = process.env.USERPROFILE + '\\.qoderworkcn\\skills\\manga-workflow-debug\\SKILL.md';

var args = process.argv.slice(2);
var daysBack = 7;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) daysBack = parseInt(args[i + 1]);
}

function loadLogs() {
  if (!fs.existsSync(LOG_DIR)) { console.log('日志目录不存在: ' + LOG_DIR); return []; }
  var files = fs.readdirSync(LOG_DIR).filter(function(f) { return f.endsWith('.json'); });
  var cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  var logs = [];
  for (var i = 0; i < files.length; i++) {
    try {
      var data = JSON.parse(fs.readFileSync(path.join(LOG_DIR, files[i]), 'utf-8'));
      if (new Date(data.start_time).getTime() >= cutoff) logs.push(data);
    } catch (e) { console.error('读取日志失败: ' + files[i]); }
  }
  logs.sort(function(a, b) { return new Date(a.start_time) - new Date(b.start_time); });
  return logs;
}

function analyze(logs) {
  var a = { total_runs: logs.length, success_count: 0, fail_count: 0, success_rate: 0,
    step_stats: {}, error_patterns: {}, service_issues: {}, timing_trends: [], insights: [], recommendations: [] };
  if (logs.length === 0) { a.insights.push('暂无执行日志，请先运行 /manga-auto。'); return a; }

  var stepNames = ['script','characters','scenes','voices','sfx','music','storyboard','video'];
  for (var s = 0; s < stepNames.length; s++)
    a.step_stats[stepNames[s]] = { ok:0, failed:0, skipped:0, total_ms:0, count:0, errors:[] };

  for (var i = 0; i < logs.length; i++) {
    var run = logs[i];
    if (run.success) a.success_count++; else a.fail_count++;
    for (var j = 0; j < stepNames.length; j++) {
      var name = stepNames[j], step = run.steps[name], st = a.step_stats[name];
      if (!step) { st.skipped++; continue; }
      if (step.status === 'ok') st.ok++;
      else if (step.status === 'failed') {
        st.failed++;
        var detail = step.detail;
        if (detail) st.errors.push(typeof detail === 'string' ? detail : (detail.error || JSON.stringify(detail)));
      }
      if (step.duration_ms) { st.total_ms += step.duration_ms; st.count++; }
    }
    if (run.errors) for (var e = 0; e < run.errors.length; e++) {
      var msg = run.errors[e].error || '';
      var pat = msg.replace(/\d+/g,'N').replace(/E:\\[^\s]+/g,'<PATH>').substring(0,120);
      if (!a.error_patterns[pat]) a.error_patterns[pat] = { count:0, examples:[], steps:[] };
      a.error_patterns[pat].count++;
      if (a.error_patterns[pat].examples.length < 3) a.error_patterns[pat].examples.push(msg.substring(0,200));
      if (a.error_patterns[pat].steps.indexOf(run.errors[e].step) < 0) a.error_patterns[pat].steps.push(run.errors[e].step);
    }
    if (run.services) for (var svc in run.services)
      if (run.services[svc] !== 'ok') a.service_issues[svc] = (a.service_issues[svc]||0) + 1;
    a.timing_trends.push({ run_id: run.run_id, time: run.start_time, total_ms: run.total_duration_ms||0, success: run.success });
  }
  a.success_rate = (a.success_count / logs.length * 100).toFixed(1);

  // 生成洞察
  var worst = [];
  for (var n in a.step_stats) {
    var st2 = a.step_stats[n], total = st2.ok + st2.failed;
    if (total > 0) worst.push({ name:n, failRate: Math.round(st2.failed/total*100), avgMs: st2.count>0?Math.round(st2.total_ms/st2.count):0, failed:st2.failed, ok:st2.ok, errors:st2.errors });
  }
  worst.sort(function(x,y){ return y.failRate - x.failRate; });
  for (var w = 0; w < worst.length; w++) {
    var ws = worst[w];
    if (ws.failRate > 0) {
      a.insights.push('步骤 ['+ws.name+'] 失败率 '+ws.failRate+'% ('+ws.failed+'/'+(ws.ok+ws.failed)+')，平均耗时 '+(ws.avgMs/1000).toFixed(1)+'s');
      var ef = {};
      for (var ei = 0; ei < ws.errors.length; ei++) { var ep = ws.errors[ei].replace(/\d+/g,'N').substring(0,100); ef[ep]=(ef[ep]||0)+1; }
      var top = Object.keys(ef).sort(function(x,y){return ef[y]-ef[x];});
      for (var te = 0; te < Math.min(top.length,3); te++) a.insights.push('  常见错误: "'+top[te]+'" (x'+ef[top[te]]+')');
    }
  }
  for (var si in a.service_issues) {
    a.insights.push('服务 ['+si+'] 在 '+a.service_issues[si]+'/'+logs.length+' 次运行中离线');
    a.recommendations.push('确保 '+si+' 服务在工作流启动前已运行');
  }
  var pats = Object.keys(a.error_patterns).sort(function(x,y){return a.error_patterns[y].count-a.error_patterns[x].count;});
  for (var p = 0; p < Math.min(pats.length,5); p++)
    if (a.error_patterns[pats[p]].count >= 2)
      a.recommendations.push('高频错误 (x'+a.error_patterns[pats[p]].count+', 步骤: '+a.error_patterns[pats[p]].steps.join('/')+'): '+pats[p]);
  if (a.recommendations.length === 0 && a.success_rate === '100.0') a.insights.push('所有运行均成功，工作流状态健康。');
  return a;
}

function generateReport(a) {
  var L = ['# 漫剧工作流蒸馏报告','','生成时间: '+new Date().toLocaleString('zh-CN'),'分析范围: 最近 '+daysBack+' 天','',
    '## 总览','','- 总运行: '+a.total_runs+'  成功: '+a.success_count+'  失败: '+a.fail_count+'  成功率: '+a.success_rate+'%','',
    '## 各步骤统计','','| 步骤 | 成功 | 失败 | 跳过 | 平均耗时 |','|------|------|------|------|----------|'];
  for (var n in a.step_stats) { var st=a.step_stats[n]; L.push('| '+n+' | '+st.ok+' | '+st.failed+' | '+st.skipped+' | '+(st.count>0?(st.total_ms/st.count/1000).toFixed(1)+'s':'-')+' |'); }
  L.push('');
  if (a.insights.length) { L.push('## 蒸馏经验',''); for (var i=0;i<a.insights.length;i++) L.push('- '+a.insights[i]); L.push(''); }
  if (a.recommendations.length) { L.push('## 改进建议',''); for (var r=0;r<a.recommendations.length;r++) L.push((r+1)+'. '+a.recommendations[r]); L.push(''); }
  return L.join('\n');
}

function updateSkill(a) {
  if (!fs.existsSync(SKILL_FILE)) { console.log('技能文件不存在，跳过'); return false; }
  var newItems = [];
  var pats = Object.keys(a.error_patterns).sort(function(x,y){return a.error_patterns[y].count-a.error_patterns[x].count;});
  for (var p = 0; p < pats.length; p++) {
    var info = a.error_patterns[pats[p]];
    if (info.count >= 2) newItems.push('- [蒸馏 '+new Date().toISOString().split('T')[0]+'] 高频错误 x'+info.count+' ('+info.steps.join('/')+'): '+pats[p].substring(0,100));
  }
  if (!newItems.length) return false;
  var content = fs.readFileSync(SKILL_FILE, 'utf-8');
  var marker = '\n## 蒸馏追加经验\n';
  if (content.indexOf(marker) < 0) content += marker;
  var added = 0;
  for (var i = 0; i < newItems.length; i++)
    if (content.indexOf(newItems[i].substring(30)) < 0) { content += newItems[i] + '\n'; added++; }
  if (added > 0) { fs.writeFileSync(SKILL_FILE, content, 'utf-8'); console.log('技能已更新，追加 '+added+' 条经验'); return true; }
  return false;
}

// ================================================================
//  写入 RAG 知识库（JSON 文件格式，与 knowledge.js 兼容）
// ================================================================

var KNOWLEDGE_DIR = 'E:\\my-ai-data\\knowledge';
var OLLAMA_BASE = 'http://127.0.0.1:11434';
var EMBEDDING_MODEL = 'nomic-embed-text';

async function getEmbedding(text) {
  try {
    var resp = await fetch(OLLAMA_BASE + '/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text.substring(0, 2000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    return (data.embedding && Array.isArray(data.embedding)) ? data.embedding : null;
  } catch (e) {
    return null;
  }
}

async function writeToKnowledgeBase(analysis) {
  if (analysis.total_runs === 0) return false;
  try {
    // 构建蒸馏经验文档内容
    var docText = '# 漫剧工作流蒸馏经验 (' + new Date().toISOString().split('T')[0] + ')\n\n';
    docText += '成功率: ' + analysis.success_rate + '% (' + analysis.success_count + '/' + analysis.total_runs + ')\n\n';
    if (analysis.insights.length > 0) {
      docText += '## 关键发现\n';
      for (var i = 0; i < analysis.insights.length; i++) docText += '- ' + analysis.insights[i] + '\n';
      docText += '\n';
    }
    if (analysis.recommendations.length > 0) {
      docText += '## 改进建议\n';
      for (var r = 0; r < analysis.recommendations.length; r++) docText += (r+1) + '. ' + analysis.recommendations[r] + '\n';
      docText += '\n';
    }
    var pats = Object.keys(analysis.error_patterns).sort(function(a,b){return analysis.error_patterns[b].count-analysis.error_patterns[a].count;});
    if (pats.length > 0) {
      docText += '## 错误模式\n';
      for (var p = 0; p < pats.length; p++) {
        var info = analysis.error_patterns[pats[p]];
        docText += '- x' + info.count + ' (' + info.steps.join('/') + '): ' + pats[p] + '\n';
      }
    }

    // 分块（简单按段落切分，每块 ~500 字）
    var paragraphs = docText.split('\n\n');
    var chunks = [];
    var current = '';
    for (var pi = 0; pi < paragraphs.length; pi++) {
      if ((current + paragraphs[pi]).length > 500 && current.length > 0) {
        chunks.push(current.trim());
        current = paragraphs[pi];
      } else {
        current += (current ? '\n\n' : '') + paragraphs[pi];
      }
    }
    if (current.trim()) chunks.push(current.trim());

    // 为每个分块生成向量嵌入
    var embeddedCount = 0;
    var chunkObjects = [];
    for (var ci = 0; ci < chunks.length; ci++) {
      var emb = await getEmbedding(chunks[ci]);
      if (emb) embeddedCount++;
      chunkObjects.push({ index: ci, text: chunks[ci], embedding: emb });
    }
    var hasEmb = embeddedCount > 0;

    // 生成文档 ID 和 JSON
    var docId = 'distill_' + Date.now() + '_workflow_experience';
    var doc = {
      metadata: {
        id: docId,
        fileName: 'distill_workflow_experience.md',
        uploadedAt: new Date().toISOString(),
        totalChunks: chunks.length,
        hasEmbeddings: hasEmb,
        embeddingModel: hasEmb ? EMBEDDING_MODEL : undefined,
        source: 'auto-distillation',
      },
      chunks: chunkObjects,
    };

    // 写入文档 JSON
    if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, docId + '.json'), JSON.stringify(doc, null, 2), 'utf-8');

    // 更新 index.json
    var indexPath = path.join(KNOWLEDGE_DIR, 'index.json');
    var index = [];
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch (_) {}
    // 移除旧的蒸馏文档（只保留最新一份）
    index = index.filter(function(item) { return item.id.indexOf('distill_') !== 0; });
    index.push({
      id: docId,
      fileName: 'distill_workflow_experience.md',
      chunkCount: chunks.length,
      hasEmbeddings: hasEmb,
      uploadedAt: new Date().toISOString(),
    });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

    console.log('RAG 知识库已更新: ' + docId + ' (' + chunks.length + ' chunks, ' + embeddedCount + ' embedded)');
    return true;
  } catch (e) {
    console.error('写入知识库失败: ' + e.message);
    return false;
  }
}

// ================================================================
//  写入长期记忆（SQLite，与 memory.js 兼容）
// ================================================================

var DB_PATH = 'E:\\my-ai-data\\users\\admin\\ai-agent.db';

function writeToMemory(analysis) {
  if (analysis.total_runs === 0) return false;
  try {
    var Database = require('better-sqlite3');
    var db = new Database(DB_PATH);

    // 构建记忆内容
    var memContent = '[蒸馏] 漫剧工作流 ' + new Date().toISOString().split('T')[0] +
      ' | 成功率 ' + analysis.success_rate + '%';
    if (analysis.insights.length > 0) {
      memContent += ' | ' + analysis.insights.slice(0, 3).join('; ');
    }

    // 去重检查（Jaccard > 0.6 视为重复）
    var existing = db.prepare("SELECT id, content FROM memories WHERE user_id='admin' AND tags LIKE '%distill%' ORDER BY created_at DESC LIMIT 5").all();
    var isDup = false;
    for (var i = 0; i < existing.length; i++) {
      var sim = jaccard(memContent, existing[i].content);
      if (sim > 0.6) { isDup = true; break; }
    }

    if (!isDup) {
      var now = Math.floor(Date.now() / 1000);
      db.prepare("INSERT INTO memories (user_id, content, tags, created_at, importance) VALUES (?, ?, ?, ?, ?)")
        .run('admin', memContent, 'distill,workflow', now, 'normal');
      console.log('长期记忆已写入: ' + memContent.substring(0, 80) + '...');
    } else {
      console.log('记忆已存在（去重跳过）');
    }

    // 追加每日日志
    var today = new Date().toISOString().split('T')[0];
    var logContent = '漫剧蒸馏: 成功率 ' + analysis.success_rate + '%, ' +
      analysis.total_runs + ' 次运行, ' + analysis.fail_count + ' 次失败';
    var logRow = db.prepare("SELECT id FROM daily_logs WHERE user_id='admin' AND date=?").get(today);
    if (logRow) {
      db.prepare("UPDATE daily_logs SET content = content || '\n' || ?, updated_at = ? WHERE id = ?")
        .run(logContent, Math.floor(Date.now()/1000), logRow.id);
    } else {
      db.prepare("INSERT INTO daily_logs (user_id, date, content, session_count, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
        .run('admin', today, logContent, Math.floor(Date.now()/1000), Math.floor(Date.now()/1000));
    }

    db.close();
    return true;
  } catch (e) {
    console.error('写入记忆失败: ' + e.message + ' (尝试 JSON 回退)');
    return writeToMemoryJsonFallback(analysis);
  }
}

function jaccard(a, b) {
  var setA = new Set(a.split(/\s+/));
  var setB = new Set(b.split(/\s+/));
  var inter = 0;
  setA.forEach(function(x) { if (setB.has(x)) inter++; });
  var union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

function writeToMemoryJsonFallback(analysis) {
  // SQLite 不可用时的 JSON 回退
  try {
    var memFile = 'E:\\my-ai-data\\manga_pipeline\\distillation_reports\\memory_distill.json';
    var mems = [];
    try { mems = JSON.parse(fs.readFileSync(memFile, 'utf-8')); } catch (_) {}
    mems.push({
      date: new Date().toISOString(),
      success_rate: analysis.success_rate,
      total_runs: analysis.total_runs,
      insights: analysis.insights.slice(0, 5),
      recommendations: analysis.recommendations.slice(0, 3),
    });
    // 只保留最近 30 条
    if (mems.length > 30) mems = mems.slice(-30);
    fs.writeFileSync(memFile, JSON.stringify(mems, null, 2), 'utf-8');
    console.log('记忆已写入 JSON 回退文件');
    return true;
  } catch (e2) {
    console.error('JSON 回退也失败: ' + e2.message);
    return false;
  }
}

// 主流程
(async function main() {
  console.log('=== 漫剧工作流蒸馏分析 ===');
  console.log('范围: 最近 '+daysBack+' 天 | 日志: '+LOG_DIR);
  var logs = loadLogs();
  console.log('读取 '+logs.length+' 条日志');
  var analysis = analyze(logs);
  var report = generateReport(analysis);
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  var rf = path.join(REPORT_DIR, 'distill_'+new Date().toISOString().split('T')[0]+'.md');
  fs.writeFileSync(rf, report, 'utf-8');
  console.log('报告: '+rf);
  updateSkill(analysis);
  await writeToKnowledgeBase(analysis);
  writeToMemory(analysis);
  console.log('\n--- 摘要 ---');
  console.log('成功率: '+analysis.success_rate+'% ('+analysis.success_count+'/'+analysis.total_runs+')');
  for (var i=0;i<Math.min(analysis.insights.length,5);i++) console.log('  '+analysis.insights[i]);
  for (var r=0;r<Math.min(analysis.recommendations.length,3);r++) console.log('  建议'+(r+1)+': '+analysis.recommendations[r]);
})();
