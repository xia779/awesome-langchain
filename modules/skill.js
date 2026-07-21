// modules/skill.js - 技能管理（文件加载 + 内置默认）
const fs = require('fs');
const path = require('path');

let Core = null;
let activeSkillIds = [];

// ===== 内置默认技能 =====
const builtinSkills = {
  'code-reviewer': {
    id: 'code-reviewer',
    name: '代码审查专家',
    description: '发现代码潜在问题、性能瓶颈和安全漏洞',
    systemPrompt: '你是一位资深代码审查专家，擅长发现代码中的潜在问题、性能瓶颈和安全漏洞。请给出具体改进建议，并提供重构方案。',
    source: 'builtin',
  },
  'python-tutor': {
    id: 'python-tutor',
    name: 'Python 导师',
    description: '用通俗方式解释编程概念，提供实际代码示例',
    systemPrompt: '你是一位 Python 编程导师，擅长用通俗易懂的方式解释编程概念，并提供实际代码示例。你的回答应包含清晰的步骤和示例代码。',
    source: 'builtin',
  },
  'git-helper': {
    id: 'git-helper',
    name: 'Git 助手',
    description: 'Git 版本控制专家，指导分支管理和冲突解决',
    systemPrompt: '你是一位 Git 版本控制专家，能帮助用户理解和使用 Git 命令，解决分支冲突，并指导团队协作流程。',
    source: 'builtin',
  },
  'debugger': {
    id: 'debugger',
    name: '调试专家',
    description: '分析错误堆栈、定位 Bug 根源并给出修复方案',
    systemPrompt: '你是一位经验丰富的调试专家，擅长分析错误堆栈、定位 Bug 根源，并给出修复方案。请帮助用户逐步排查问题。',
    source: 'builtin',
  },
  'architect': {
    id: 'architect',
    name: '系统架构师',
    description: '设计可扩展、高可用的系统架构',
    systemPrompt: '你是一位系统架构师，擅长设计可扩展、高可用的系统架构，能评估技术选型，并给出架构建议。',
    source: 'builtin',
  },
};

// 合并后的技能表：内置 + 文件
let allSkills = {};

// ===== 文件技能扫描 =====
function getSkillsDir() {
  if (!Core) return null;
  var base = Core._globalDataRoot || Core.DATA_ROOT || 'E:\\my-ai-data';
  return path.join(base, 'skills');
}

function ensureSkillsDir() {
  var dir = getSkillsDir();
  if (dir && !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.warn('[Skill] Failed to create skills dir:', e.message); }
  }
}

function scanFileSkills() {
  var dir = getSkillsDir();
  var result = {};
  if (!dir || !fs.existsSync(dir)) return result;

  try {
    var entries = fs.readdirSync(dir);
    entries.forEach(function (name) {
      var skillDir = path.join(dir, name);
      try {
        if (!fs.statSync(skillDir).isDirectory()) return;
      } catch (e) { return; }

      var jsonPath = path.join(skillDir, 'skill.json');
      var promptPath = path.join(skillDir, 'prompt.md');

      // 必须同时有 skill.json 和 prompt.md
      if (!fs.existsSync(jsonPath) || !fs.existsSync(promptPath)) return;

      try {
        var meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        var prompt = fs.readFileSync(promptPath, 'utf8').trim();
        if (!meta.id || !meta.name || !prompt) return;

        result[meta.id] = {
          id: meta.id,
          name: meta.name,
          description: meta.description || '',
          version: meta.version || '1.0.0',
          author: meta.author || '',
          systemPrompt: prompt,
          source: 'file',
          dir: skillDir,
        };
      } catch (e) {
        console.warn('⚠️ 加载技能失败 (' + name + '):', e.message);
      }
    });
  } catch (e) {
    console.warn('⚠️ 扫描技能目录失败:', e.message);
  }
  return result;
}

function refreshSkills() {
  allSkills = {};
  // 内置先填充
  var bKeys = Object.keys(builtinSkills);
  for (var i = 0; i < bKeys.length; i++) {
    allSkills[bKeys[i]] = builtinSkills[bKeys[i]];
  }
  // 文件覆盖/追加（文件版可覆盖内置同名技能）
  var fileSkills = scanFileSkills();
  var fKeys = Object.keys(fileSkills);
  for (var j = 0; j < fKeys.length; j++) {
    allSkills[fKeys[j]] = fileSkills[fKeys[j]];
  }
  return allSkills;
}

// ===== 公共 API =====

function getSkill(id) {
  return allSkills[id] || null;
}

function getAllSkills() {
  return Object.keys(allSkills).map(function (id) {
    var s = allSkills[id];
    return {
      id: id,
      name: s.name,
      description: s.description || '',
      systemPrompt: s.systemPrompt,
      source: s.source || 'builtin',
      version: s.version || '1.0.0',
      author: s.author || '',
    };
  });
}

// 运行时添加技能（同时写入文件）
function addSkill(id, config) {
  if (!id || !config || !config.name || !config.systemPrompt) {
    console.error('添加技能失败：缺少必要字段');
    return false;
  }
  // 写入文件
  ensureSkillsDir();
  var dir = getSkillsDir();
  if (!dir) return false;

  var skillDir = path.join(dir, id);
  try {
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
      id: id,
      name: config.name,
      description: config.description || '',
      version: config.version || '1.0.0',
      author: config.author || 'user',
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(skillDir, 'prompt.md'), config.systemPrompt, 'utf8');
  } catch (e) {
    console.error('❌ 写入技能文件失败:', e.message);
    return false;
  }
  // 刷新并激活
  refreshSkills();
  console.log('✅ 技能 "' + id + '" 已保存到文件');
  return true;
}

// 删除文件技能
function removeSkill(id) {
  if (!allSkills[id]) return { success: false, error: '技能不存在' };
  if (allSkills[id].source === 'builtin') {
    return { success: false, error: '内置技能不可删除' };
  }
  var skillDir = allSkills[id].dir;
  if (!skillDir) return { success: false, error: '技能目录未知' };

  try {
    // 安全删除：逐文件删除，不用 rmSync 递归
    var files = fs.readdirSync(skillDir);
    files.forEach(function (f) {
      fs.unlinkSync(path.join(skillDir, f));
    });
    fs.rmdirSync(skillDir);
  } catch (e) {
    return { success: false, error: '删除失败: ' + e.message };
  }
  var idx = activeSkillIds.indexOf(id);
  if (idx !== -1) activeSkillIds.splice(idx, 1);
  refreshSkills();
  return { success: true };
}

function setSkill(id) {
  if (id === null) {
    activeSkillIds = [];
    console.log('✅ 已取消激活全部技能');
    return true;
  }
  if (!allSkills[id]) {
    console.warn('❌ 技能 "' + id + '" 不存在');
    return false;
  }
  var idx = activeSkillIds.indexOf(id);
  if (idx !== -1) {
    // 已激活 → 取消激活（切换逻辑）
    activeSkillIds.splice(idx, 1);
    console.log('⏹ 已取消激活技能: ' + allSkills[id].name);
  } else {
    // 未激活 → 加入激活列表
    activeSkillIds.push(id);
    console.log('✅ 已激活技能: ' + allSkills[id].name + ' (当前激活 ' + activeSkillIds.length + ' 个)');
  }
  return true;
}

function getCurrentSkill() {
  // 兼容旧调用：返回第一个激活的技能
  if (activeSkillIds.length === 0) return null;
  return getSkill(activeSkillIds[0]);
}

function getActiveSkills() {
  return activeSkillIds
    .map(function (id) { return getSkill(id); })
    .filter(function (s) { return !!s; });
}

function getCurrentSystemPrompt() {
  var skills = getActiveSkills();
  if (skills.length === 0) return null;
  if (skills.length === 1) return skills[0].systemPrompt;
  // 多技能：拼接所有激活技能的 prompt
  return skills.map(function (s) {
    return '【技能：' + s.name + '】\n' + s.systemPrompt;
  }).join('\n\n---\n\n');
}

function applySkillToPrompt(userSystemPrompt) {
  var skillPrompt = getCurrentSystemPrompt();
  if (!skillPrompt) return userSystemPrompt;
  var skills = getActiveSkills();
  var label = skills.length === 1
    ? '【当前技能：' + skills[0].name + '】'
    : '【当前技能（' + skills.length + ' 个）：' + skills.map(function (s) { return s.name; }).join('、') + '】';
  if (userSystemPrompt && userSystemPrompt.trim() !== '') {
    return userSystemPrompt + '\n\n' + label + '\n' + skillPrompt;
  }
  return label + '\n' + skillPrompt;
}

function listSkills() {
  var all = getAllSkills();
  return all.map(function (s) {
    var tag = activeSkillIds.indexOf(s.id) !== -1 ? ' [激活]' : '';
    var src = s.source === 'file' ? ' 📁' : '';
    return s.id + ' - ' + s.name + tag + src;
  }).join('\n');
}

// 安装技能（从指定路径复制）
function installSkill(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { success: false, error: '源路径不存在' };
  }
  ensureSkillsDir();
  var dir = getSkillsDir();
  if (!dir) return { success: false, error: '无法获取技能目录' };

  try {
    var stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      // 从目录安装
      var jsonPath = path.join(sourcePath, 'skill.json');
      if (!fs.existsSync(jsonPath)) {
        return { success: false, error: '目录中缺少 skill.json' };
      }
      var meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // 🔒 安全：清理 meta.id，防止路径穿越（../../ 等攻击）
      var safeId = (meta.id || path.basename(sourcePath)).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
      if (!safeId) safeId = path.basename(sourcePath).replace(/[^a-zA-Z0-9_-]/g, '-');
      var targetDir = path.join(dir, safeId);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      // 复制所有文件
      var files = fs.readdirSync(sourcePath);
      files.forEach(function (f) {
        var srcFile = path.join(sourcePath, f);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, path.join(targetDir, f));
        }
      });
    } else {
      // 从单个 .md 文件安装
      var ext = path.extname(sourcePath).toLowerCase();
      if (ext !== '.md') {
        return { success: false, error: '仅支持 .md 文件或包含 skill.json 的目录' };
      }
      var name = path.basename(sourcePath, ext);
      var id = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      var prompt = fs.readFileSync(sourcePath, 'utf8').trim();
      var skillDir = path.join(dir, id);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
        id: id, name: name, description: '从文件导入', version: '1.0.0', author: 'import',
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(skillDir, 'prompt.md'), prompt, 'utf8');
    }
  } catch (e) {
    return { success: false, error: '安装失败: ' + e.message };
  }
  refreshSkills();
  return { success: true };
}

module.exports = {
  name: 'skill',
  dependencies: ['tools'],
  init(_Core) {
    Core = _Core;
    ensureSkillsDir();
    refreshSkills();

    Core.skills = {
      getSkill: getSkill,
      getAllSkills: getAllSkills,
      addSkill: addSkill,
      removeSkill: removeSkill,
      installSkill: installSkill,
      setSkill: setSkill,
      getCurrentSkill: getCurrentSkill,
      getActiveSkills: getActiveSkills,
      getCurrentSystemPrompt: getCurrentSystemPrompt,
      applySkillToPrompt: applySkillToPrompt,
      listSkills: listSkills,
      refreshSkills: refreshSkills,
    };
    Core.tools = Core.tools || {};
    Core.tools.skill = {
      set: setSkill,
      list: getAllSkills,
      current: getCurrentSkill,
    };
    console.log('✅ Skill 模块已加载 (' + Object.keys(allSkills).length + ' 个技能, 目录: ' + getSkillsDir() + ')');
  }
};
