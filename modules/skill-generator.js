// modules/skill-generator.js - 文档→技能生成器（document-to-skill）
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 从文档生成技能 =====
async function generateSkillFromFile(filePath, options) {
  var opts = options || {};

  // 1. 读取文档内容
  var content = _readDocument(filePath);
  if (!content || content.length < 50) {
    return { success: false, error: '文档内容过短或无法读取: ' + filePath };
  }

  // 截断过长文档（LLM 上下文限制）
  if (content.length > 15000) {
    content = content.substring(0, 15000) + '\n...(文档截断)';
  }

  // 2. LLM 分析文档，提取技能结构
  var systemMsg = '你是一个技能提取专家。分析用户提供的文档，从中提取可复用的操作技能/工作流程。\n\n' +
    '【输出要求】严格以 JSON 格式输出：\n' +
    '{\n' +
    '  "id": "skill-id-小写英文连字符",\n' +
    '  "name": "技能中文名称",\n' +
    '  "description": "一句话描述技能用途和触发场景",\n' +
    '  "category": "分类(如: workflow/analysis/coding/writing/trading)",\n' +
    '  "tags": ["标签1", "标签2"],\n' +
    '  "triggerKeywords": ["触发关键词1", "触发关键词2"],\n' +
    '  "steps": ["步骤1", "步骤2", "步骤3"],\n' +
    '  "systemPrompt": "完整的系统提示词（200-500字），指导AI如何执行此技能，包含角色定义、步骤、约束、输出格式",\n' +
    '  "examples": [{"input": "示例输入", "output": "期望输出"}]\n' +
    '}\n\n' +
    '【注意】\n' +
    '- systemPrompt 必须足够详细，让AI仅凭此提示词就能正确执行技能\n' +
    '- 如果文档是操作手册/SOP，提取完整流程\n' +
    '- 如果文档是知识资料，提取分析框架和判断标准\n' +
    '- 如果文档是代码/配置，提取使用方法和最佳实践\n' +
    '- id 必须是合法的小写英文+连字符格式';

  var result = await Core.api.callAPI(
    '请分析以下文档并提取技能：\n\n' + content,
    systemMsg,
    0.3,
    null, null,
    [{ role: 'system', content: systemMsg }, { role: 'user', content: '文档内容：\n' + content }],
    { disableTools: true, _background: true }
  );

  var responseText = (result && result.message && result.message.content) || '';
  var skillData = _extractJSON(responseText);

  if (!skillData || !skillData.id || !skillData.systemPrompt) {
    return { success: false, error: 'LLM 未能从文档中提取有效技能结构' };
  }

  // 3. 规范化技能数据
  var skill = {
    id: skillData.id.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
    name: skillData.name || path.basename(filePath, path.extname(filePath)),
    description: skillData.description || '从文档自动提取的技能',
    category: skillData.category || 'workflow',
    tags: skillData.tags || [],
    triggerKeywords: skillData.triggerKeywords || [],
    steps: skillData.steps || [],
    examples: skillData.examples || [],
    sourceFile: path.basename(filePath),
    createdAt: Date.now()
  };

  // 4. 生成 prompt.md
  var promptMd = _buildPromptMd(skill, skillData.systemPrompt);

  // 5. 安装技能
  if (opts.dryRun) {
    return { success: true, skill: skill, promptMd: promptMd, dryRun: true };
  }

  var installResult = _installSkill(skill, skillData.systemPrompt, promptMd);
  if (!installResult.success) {
    return installResult;
  }

  return {
    success: true,
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    steps: skill.steps.length,
    path: installResult.path
  };
}

// ===== 从对话历史生成技能 =====
async function generateSkillFromConversation(messages, title) {
  if (!messages || messages.length < 4) {
    return { success: false, error: '对话消息太少，无法提取技能' };
  }

  // 提取有意义的对话（排除系统消息）
  var conversation = messages
    .filter(function(m) { return m.role === 'user' || m.role === 'assistant'; })
    .slice(-20)
    .map(function(m) { return m.role + ': ' + (m.content || '').substring(0, 500); })
    .join('\n\n');

  var systemMsg = '你是一个技能提取专家。分析以下对话记录，从中提取可复用的操作技能。\n' +
    '对话中用户完成了一个任务，你需要将这个任务的执行方法总结为一个可复用的技能。\n\n' +
    '严格以 JSON 格式输出（同 generateSkillFromFile 的格式）。';

  var result = await Core.api.callAPI(
    '对话记录：\n' + conversation,
    systemMsg,
    0.3,
    null, null,
    [{ role: 'system', content: systemMsg }, { role: 'user', content: '请从对话中提取技能：\n\n' + conversation }],
    { disableTools: true, _background: true }
  );

  var responseText = (result && result.message && result.message.content) || '';
  var skillData = _extractJSON(responseText);

  if (!skillData || !skillData.id || !skillData.systemPrompt) {
    return { success: false, error: '未能从对话中提取有效技能' };
  }

  var skill = {
    id: skillData.id.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
    name: skillData.name || title || '对话技能',
    description: skillData.description || '从对话自动提取的技能',
    category: skillData.category || 'workflow',
    tags: skillData.tags || [],
    triggerKeywords: skillData.triggerKeywords || [],
    steps: skillData.steps || [],
    examples: skillData.examples || [],
    source: 'conversation',
    createdAt: Date.now()
  };

  var promptMd = _buildPromptMd(skill, skillData.systemPrompt);
  var installResult = _installSkill(skill, skillData.systemPrompt, promptMd);

  return installResult.success
    ? { success: true, skillId: skill.id, name: skill.name, path: installResult.path }
    : installResult;
}

// ===== 辅助函数 =====
function _readDocument(filePath) {
  try {
    var ext = path.extname(filePath).toLowerCase();
    if (!fs.existsSync(filePath)) return null;

    if (['.txt', '.md', '.json', '.csv', '.log', '.py', '.js', '.ts', '.html', '.css', '.yaml', '.yml', '.toml', '.ini', '.cfg'].indexOf(ext) !== -1) {
      return fs.readFileSync(filePath, 'utf8');
    }
    if (ext === '.pdf') {
      // 尝试用 pdf-parse
      try {
        var pdfParse = require('pdf-parse');
        var buf = fs.readFileSync(filePath);
        // pdf-parse 是 async，这里用同步 fallback
        return '[PDF文件: ' + path.basename(filePath) + '，请使用知识库上传后再生成技能]';
      } catch (e) {
        return null;
      }
    }
    if (ext === '.docx') {
      try {
        var mammoth = require('mammoth');
        return '[DOCX文件: ' + path.basename(filePath) + '，请使用知识库上传后再生成技能]';
      } catch (e) { return null; }
    }
    // 默认尝试 utf8 读取
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function _buildPromptMd(skill, systemPrompt) {
  var md = '# ' + skill.name + '\n\n';
  md += '> ' + skill.description + '\n\n';

  if (skill.steps && skill.steps.length > 0) {
    md += '## 执行步骤\n\n';
    skill.steps.forEach(function(step, i) {
      md += (i + 1) + '. ' + step + '\n';
    });
    md += '\n';
  }

  md += '## 系统提示词\n\n' + systemPrompt + '\n\n';

  if (skill.examples && skill.examples.length > 0) {
    md += '## 示例\n\n';
    skill.examples.forEach(function(ex) {
      md += '**输入:** ' + (ex.input || '') + '\n';
      md += '**输出:** ' + (ex.output || '') + '\n\n';
    });
  }

  if (skill.triggerKeywords && skill.triggerKeywords.length > 0) {
    md += '## 触发关键词\n\n' + skill.triggerKeywords.join(', ') + '\n';
  }

  return md;
}

function _installSkill(skill, systemPrompt, promptMd) {
  try {
    var skillsDir = Core.pathService.perUser('skills');
    var skillDir = path.join(skillsDir, skill.id);

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    // 写 skill.json
    var skillJson = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      tags: skill.tags,
      triggerKeywords: skill.triggerKeywords,
      steps: skill.steps,
      examples: skill.examples,
      sourceFile: skill.sourceFile || skill.source || 'manual',
      createdAt: skill.createdAt,
      version: '1.0.0'
    };
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skillJson, null, 2), 'utf8');

    // 写 prompt.md
    fs.writeFileSync(path.join(skillDir, 'prompt.md'), promptMd, 'utf8');

    // 刷新技能列表
    if (Core.skills && Core.skills.refreshSkills) {
      Core.skills.refreshSkills();
    }

    return { success: true, path: skillDir };
  } catch (e) {
    return { success: false, error: '安装技能失败: ' + e.message };
  }
}

function _extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (e) {}
  var match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch (e) {} }
  var start = text.indexOf('{');
  if (start !== -1) {
    var depth = 0, end = -1;
    for (var i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try { return JSON.parse(text.substring(start, end + 1)); } catch (e) {}
    }
  }
  return null;
}

// ===== 模块导出 =====
module.exports = {
  name: 'skill-generator',
  dependencies: ['api', 'skill'],
  init: function(_Core) {
    Core = _Core;

    Core.skillGenerator = {
      fromFile: generateSkillFromFile,
      fromConversation: generateSkillFromConversation
    };

    console.log('\u2705 \u6280\u80fd\u751f\u6210\u5668\u5df2\u52a0\u8f7d\uff08document-to-skill\uff09');
  }
};
