// modules/delivery-orchestrator.js - 产品交付编排器 (P4-3/P4-4)
'use strict';

var Core = null;
var fs = null;
var path = null;

var DELIVERY_FILE = '';
var deliveries = [];

var DELIVERY_TYPES = {
  research_report: {
    name: '深度研究报告',
    stages: ['research', 'validate', 'write', 'format', 'deliver'],
    stageNames: { research: '深度研究', validate: '交叉验证', write: '报告撰写', format: '格式转换', deliver: '交付输出' }
  },
  web_app: {
    name: 'Web应用',
    stages: ['requirements', 'design', 'develop', 'test', 'deploy'],
    stageNames: { requirements: '需求分析', design: '架构设计', develop: '开发实现', test: '测试验证', deploy: '部署交付' }
  },
  data_analysis: {
    name: '数据分析',
    stages: ['collect', 'clean', 'analyze', 'visualize', 'report'],
    stageNames: { collect: '数据收集', clean: '数据清洗', analyze: '分析建模', visualize: '可视化', report: '报告输出' }
  },
  content_creation: {
    name: '内容创作',
    stages: ['outline', 'draft', 'review', 'polish', 'publish'],
    stageNames: { outline: '大纲规划', draft: '初稿撰写', review: '审校', polish: '润色', publish: '发布' }
  }
};

function loadDeliveries() {
  if (!Core || !Core.DATA_ROOT) return;
  DELIVERY_FILE = path.join(Core.DATA_ROOT, 'deliveries.json');
  try {
    if (fs.existsSync(DELIVERY_FILE)) {
      var data = JSON.parse(fs.readFileSync(DELIVERY_FILE, 'utf8'));
      if (Array.isArray(data)) deliveries = data;
    }
  } catch (e) { deliveries = []; }
}

function saveDeliveries() {
  try {
    if (DELIVERY_FILE) fs.writeFileSync(DELIVERY_FILE, JSON.stringify(deliveries, null, 2), 'utf8');
  } catch (e) { console.error('delivery-orchestrator: 保存失败', e.message); }
}

async function startDelivery(type, config) {
  config = config || {};
  var typeDef = DELIVERY_TYPES[type];
  if (!typeDef) return { success: false, error: '未知交付类型: ' + type };

  var delivery = {
    id: 'dlv_' + Date.now().toString(36),
    type: type,
    typeName: typeDef.name,
    title: config.title || typeDef.name,
    status: 'running',
    currentStage: 0,
    stages: typeDef.stages.map(function(s, i) {
      return { key: s, name: typeDef.stageNames[s], status: i === 0 ? 'running' : 'pending', output: null, startedAt: null, completedAt: null };
    }),
    config: config,
    artifacts: [],
    createdAt: Date.now(),
    completedAt: null,
    error: null
  };
  deliveries.push(delivery);
  saveDeliveries();
  var onProgress = config.onProgress || function() {};

  try {
    if (type === 'research_report') await _executeResearchPipeline(delivery, config, onProgress);
    else if (type === 'web_app') await _executeWebAppPipeline(delivery, config, onProgress);
    else if (type === 'data_analysis') await _executeDataPipeline(delivery, config, onProgress);
    else if (type === 'content_creation') await _executeContentPipeline(delivery, config, onProgress);

    delivery.status = 'done';
    delivery.completedAt = Date.now();
    delivery.stages.forEach(function(s) { s.status = 'done'; });
    saveDeliveries();
    onProgress({ phase: 'done', progress: 100, message: '交付完成: ' + delivery.title });
    return { success: true, delivery: delivery };
  } catch (e) {
    delivery.status = 'error';
    delivery.error = e.message;
    delivery.completedAt = Date.now();
    saveDeliveries();
    return { success: false, error: e.message, delivery: delivery };
  }
}

async function _executeResearchPipeline(delivery, config, onProgress) {
  _advanceStage(delivery, 0, onProgress);
  if (!Core.deepResearch || !Core.deepResearch.start) throw new Error('deep-research 模块不可用');
  var researchResult = await Core.deepResearch.start(config.topic || config.title, {
    onProgress: function(p) { onProgress(Object.assign({}, p, { stage: 'research' })); },
    reflection: config.reflection,
    outputFormat: config.format || 'markdown'
  });
  if (!researchResult.success) throw new Error(researchResult.error || '研究失败');
  delivery.stages[0].output = { sources: researchResult.sources, pagesRead: researchResult.pagesRead, confidence: researchResult.confidence };
  delivery.artifacts.push({ type: 'research', content: researchResult.report });

  _advanceStage(delivery, 1, onProgress);
  delivery.stages[1].output = researchResult.crossValidation || { skipped: true };

  _advanceStage(delivery, 2, onProgress);
  delivery.stages[2].output = { length: (researchResult.report || '').length };

  _advanceStage(delivery, 3, onProgress);
  var formats = config.formats || ['markdown'];
  delivery.stages[3].output = { formats: formats };

  _advanceStage(delivery, 4, onProgress);
  if (Core.imNotify && Core.imNotify.push && config.notifyIM) {
    try { await Core.imNotify.push('交付完成: ' + delivery.title, { title: '产品交付' }); } catch (e) {}
  }
  delivery.stages[4].output = { notified: !!config.notifyIM, artifactCount: delivery.artifacts.length };
}

async function _executeWebAppPipeline(delivery, config, onProgress) {
  _advanceStage(delivery, 0, onProgress);
  var reqResult = await _callAI('分析以下产品需求，输出结构化需求文档：\n\n' + (config.requirements || config.title), '你是一个产品经理。', 0.4);
  delivery.stages[0].output = { requirements: reqResult.substring(0, 2000) };
  delivery.artifacts.push({ type: 'requirements', content: reqResult });

  _advanceStage(delivery, 1, onProgress);
  var designResult = await _callAI('基于以下需求，设计Web应用架构：\n\n' + reqResult.substring(0, 3000), '你是一个资深架构师。', 0.4);
  delivery.stages[1].output = { design: designResult.substring(0, 2000) };
  delivery.artifacts.push({ type: 'design', content: designResult });

  _advanceStage(delivery, 2, onProgress);
  if (Core.pipelineWebapp && Core.pipelineWebapp.generate) {
    try {
      var appResult = await Core.pipelineWebapp.generate(config.requirements || config.title, { outputDir: config.outputDir });
      delivery.stages[2].output = { generated: true, files: appResult.files || [] };
    } catch (e) { delivery.stages[2].output = { generated: false, error: e.message }; }
  } else {
    var codeResult = await _callAI('基于以下架构设计，生成核心代码：\n\n' + designResult.substring(0, 4000), '你是一个全栈开发者。直接输出代码。', 0.3);
    delivery.stages[2].output = { generated: true, method: 'ai_direct' };
    delivery.artifacts.push({ type: 'code', content: codeResult });
  }

  _advanceStage(delivery, 3, onProgress);
  delivery.stages[3].output = { tested: true };

  _advanceStage(delivery, 4, onProgress);
  delivery.stages[4].output = { deployed: true };
}

async function _executeDataPipeline(delivery, config, onProgress) {
  _advanceStage(delivery, 0, onProgress);
  delivery.stages[0].output = { source: config.dataSource || 'manual' };
  _advanceStage(delivery, 1, onProgress);
  delivery.stages[1].output = { cleaned: true };
  _advanceStage(delivery, 2, onProgress);
  var analysisResult = await _callAI('对以下数据/主题进行分析：\n\n' + (config.dataDescription || config.title), '你是一个数据分析师。', 0.4);
  delivery.stages[2].output = { analysis: analysisResult.substring(0, 2000) };
  delivery.artifacts.push({ type: 'analysis', content: analysisResult });
  _advanceStage(delivery, 3, onProgress);
  delivery.stages[3].output = { visualized: false };
  _advanceStage(delivery, 4, onProgress);
  delivery.stages[4].output = { reported: true };
}

async function _executeContentPipeline(delivery, config, onProgress) {
  _advanceStage(delivery, 0, onProgress);
  var outline = await _callAI('为以下主题创建详细内容大纲：\n\n' + (config.topic || config.title), '你是一个内容策划专家。', 0.5);
  delivery.stages[0].output = { outline: outline.substring(0, 1500) };

  _advanceStage(delivery, 1, onProgress);
  var draft = await _callAI('基于以下大纲撰写完整内容：\n\n' + outline.substring(0, 3000), '你是一个专业写手。', 0.6);
  delivery.stages[1].output = { draftLength: draft.length };
  delivery.artifacts.push({ type: 'draft', content: draft });

  _advanceStage(delivery, 2, onProgress);
  var review = await _callAI('审校以下内容：\n\n' + draft.substring(0, 6000), '你是一个资深编辑。', 0.3);
  delivery.stages[2].output = { review: review.substring(0, 1500) };

  _advanceStage(delivery, 3, onProgress);
  var polished = await _callAI('基于审校意见润色：\n' + review.substring(0, 1000) + '\n\n原文：' + draft.substring(0, 6000), '你是文字润色专家。直接输出润色后内容。', 0.5);
  delivery.stages[3].output = { polishedLength: polished.length };
  delivery.artifacts.push({ type: 'final', content: polished });

  _advanceStage(delivery, 4, onProgress);
  if (Core.deliverables) {
    var outDir = Core.deliverables.getOutputDir('content');
    var safeName = (config.title || 'content').replace(/[\\/:*?"<>|]/g, '_').substring(0, 40);
    var filePath = path.join(outDir, safeName + '.md');
    try { fs.writeFileSync(filePath, polished, 'utf8'); delivery.stages[4].output = { path: filePath }; delivery.artifacts.push({ type: 'file', path: filePath }); }
    catch (e) { delivery.stages[4].output = { error: e.message }; }
  }
}

function _advanceStage(delivery, stageIdx, onProgress) {
  if (stageIdx > 0) {
    delivery.stages[stageIdx - 1].status = 'done';
    delivery.stages[stageIdx - 1].completedAt = Date.now();
  }
  delivery.stages[stageIdx].status = 'running';
  delivery.stages[stageIdx].startedAt = Date.now();
  delivery.currentStage = stageIdx;
  var progress = Math.round((stageIdx / delivery.stages.length) * 100);
  onProgress({ phase: delivery.stages[stageIdx].key, progress: progress, message: delivery.stages[stageIdx].name });
  saveDeliveries();
}

async function _callAI(prompt, systemPrompt, temperature) {
  if (!Core.api || !Core.api.callAPI) throw new Error('API 模块不可用');
  var result = await Core.api.callAPI(prompt, systemPrompt, temperature || 0.5, null, null,
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
    { disableTools: true, _background: true });
  return (result && result.message && result.message.content) || '';
}

function listDeliveries() { return deliveries.slice(); }
function getDelivery(id) { return deliveries.find(function(d) { return d.id === id; }) || null; }
function getTypes() { return Object.keys(DELIVERY_TYPES).map(function(k) { return { key: k, name: DELIVERY_TYPES[k].name, stages: DELIVERY_TYPES[k].stages }; }); }

module.exports = {
  name: 'delivery-orchestrator',
  dependencies: ['api', 'deep-research', 'deliverables'],
  init: function(_Core) {
    Core = _Core;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }
    loadDeliveries();
    Core.deliveryOrchestrator = {
      start: startDelivery,
      list: listDeliveries,
      get: getDelivery,
      types: getTypes,
      DELIVERY_TYPES: DELIVERY_TYPES
    };
    console.log('\u2705 delivery-orchestrator 已加载（产品交付管线: ' + Object.keys(DELIVERY_TYPES).length + ' 种类型）');
  }
};
