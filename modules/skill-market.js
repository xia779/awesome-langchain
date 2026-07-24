// modules/skill-market.js - 技能/插件市场（在线仓库 + 搜索 + 一键安装）
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let Core = null;

// ===== 市场配置 =====
// 🔧 修复: 默认 registry 使用用户自己的 GitHub 仓库（与 version.json 一致）
const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/xia779/my-ai-update/main/skill-registry.json';
let _localRegistry = [];
let _remoteRegistry = null;
let _lastFetch = 0;
const FETCH_TTL = 3600000; // 1 小时缓存

// ===== 获取市场目录 =====
async function fetchRegistry(options) {
  var opts = options || {};
  var registryUrl = opts.url || (Core.config && Core.config.skillMarketUrl) || DEFAULT_REGISTRY;

  // 缓存检查
  if (_remoteRegistry && (Date.now() - _lastFetch) < FETCH_TTL && !opts.force) {
    return { success: true, skills: _remoteRegistry, cached: true };
  }

  try {
    var data = await _httpGet(registryUrl);
    if (data && Array.isArray(data.skills)) {
      _remoteRegistry = data.skills;
      _lastFetch = Date.now();
      return { success: true, skills: _remoteRegistry, cached: false };
    }
    return { success: false, error: '无效的注册表格式' };
  } catch (e) {
    // 网络不可用时使用本地注册表
    if (_remoteRegistry) {
      return { success: true, skills: _remoteRegistry, cached: true, offline: true };
    }
    return { success: false, error: '无法连接技能市场: ' + e.message };
  }
}

// ===== 搜索技能 =====
async function searchSkills(query) {
  var result = await fetchRegistry();
  if (!result.success) return result;

  var skills = result.skills || [];
  var q = (query || '').toLowerCase();

  if (!q) return { success: true, skills: skills.slice(0, 20) };

  var matched = skills.filter(function(s) {
    return (s.name && s.name.toLowerCase().indexOf(q) !== -1) ||
           (s.description && s.description.toLowerCase().indexOf(q) !== -1) ||
           (s.tags && s.tags.some(function(t) { return t.toLowerCase().indexOf(q) !== -1; })) ||
           (s.category && s.category.toLowerCase().indexOf(q) !== -1);
  });

  return { success: true, skills: matched, query: query };
}

// ===== 安装技能 =====
async function installSkill(skillIdOrUrl, options) {
  var opts = options || {};

  // 如果是 URL，直接下载安装
  if (skillIdOrUrl.startsWith('http')) {
    return _installFromUrl(skillIdOrUrl, opts);
  }

  // 从注册表查找
  var result = await fetchRegistry();
  if (!result.success) return result;

  var skill = (result.skills || []).find(function(s) { return s.id === skillIdOrUrl; });
  if (!skill) {
    return { success: false, error: '未找到技能: ' + skillIdOrUrl };
  }

  if (!skill.downloadUrl) {
    return { success: false, error: '技能无下载地址' };
  }

  return _installFromUrl(skill.downloadUrl, opts);
}

// ===== 从 URL 安装 =====
async function _installFromUrl(url, opts) {
  try {
    // 🔧 安全: 仅允许 HTTPS（防止中间人注入恶意技能）
    if (!url.startsWith('https://')) return { success: false, error: '仅支持 HTTPS 链接' };

    // 下载 ZIP 或 JSON
    var content = await _httpGetRaw(url);
    if (!content) return { success: false, error: '下载失败' };

    // 如果是 JSON（单文件技能）
    if (url.endsWith('.json') || url.endsWith('skill.json')) {
      var skillData = JSON.parse(content);
      return _installFromData(skillData);
    }

    // 如果是 Markdown（prompt 文件）
    if (url.endsWith('.md')) {
      var skillId = path.basename(url, '.md').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      var skillDir = Core.pathService.perUser(path.join('skills', skillId));
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'prompt.md'), content, 'utf8');
      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
        id: skillId, name: skillId, description: '从市场安装', version: '1.0.0', installedAt: Date.now()
      }, null, 2), 'utf8');
      if (Core.skills && Core.skills.refreshSkills) Core.skills.refreshSkills();
      return { success: true, skillId: skillId, path: skillDir };
    }

    return { success: false, error: '不支持的文件格式' };
  } catch (e) {
    return { success: false, error: '安装失败: ' + e.message };
  }
}

function _installFromData(skillData) {
  try {
    // 🔧 安全: 字段白名单 + 路径遍历防护
    var skillId = String(skillData.id || ('market-' + Date.now().toString(36)));
    // 阻止路径遍历：只允许字母、数字、横线
    if (!/^[a-z0-9-]+$/i.test(skillId)) return { success: false, error: '技能 ID 含非法字符' };

    var skillDir = Core.pathService.perUser(path.join('skills', skillId));
    // 二次验证：确保目标路径在 skills 目录内
    var skillsRoot = Core.pathService.perUser('skills');
    if (!skillDir.startsWith(skillsRoot)) return { success: false, error: '路径越界' };

    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

    // 白名单字段：只保留安全的元数据
    var safeData = {
      id: skillId,
      name: String(skillData.name || skillId).slice(0, 100),
      description: String(skillData.description || '').slice(0, 500),
      version: String(skillData.version || '1.0.0').slice(0, 20),
      triggerKeywords: Array.isArray(skillData.triggerKeywords) ? skillData.triggerKeywords.slice(0, 20) : [],
      installedAt: Date.now(),
      installedFrom: 'market'
    };

    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(safeData, null, 2), 'utf8');
    if (skillData.systemPrompt || skillData.prompt) {
      // 限制 prompt 大小（防止超大文件写入）
      var promptContent = String(skillData.systemPrompt || skillData.prompt).slice(0, 50000);
      fs.writeFileSync(path.join(skillDir, 'prompt.md'), promptContent, 'utf8');
    }

    if (Core.skills && Core.skills.refreshSkills) Core.skills.refreshSkills();
    return { success: true, skillId: skillId, name: safeData.name, path: skillDir };
  } catch (e) {
    return { success: false, error: '安装失败: ' + e.message };
  }
}

// ===== 发布技能（上传到本地注册表）=====
function publishLocal(skillId) {
  try {
    var skillDir = Core.pathService.perUser(path.join('skills', skillId));
    if (!fs.existsSync(skillDir)) return { success: false, error: '技能不存在: ' + skillId };

    var skillJson = JSON.parse(fs.readFileSync(path.join(skillDir, 'skill.json'), 'utf8'));
    var promptMd = '';
    try { promptMd = fs.readFileSync(path.join(skillDir, 'prompt.md'), 'utf8'); } catch (e) { console.warn('⚠️ [skill-market] 操作失败:', e.message || e); }

    _localRegistry.push(Object.assign({}, skillJson, { prompt: promptMd, publishedAt: Date.now() }));

    // 保存到本地注册表文件
    var regFile = Core.pathService.perUser('skill-registry-local.json');
    fs.writeFileSync(regFile, JSON.stringify(_localRegistry, null, 2), 'utf8');

    return { success: true, skillId: skillId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== 已安装列表 =====
function listInstalled() {
  var skillsDir = Core.pathService.perUser('skills');
  var installed = [];
  try {
    if (fs.existsSync(skillsDir)) {
      fs.readdirSync(skillsDir).forEach(function(dir) {
        var jsonPath = path.join(skillsDir, dir, 'skill.json');
        if (fs.existsSync(jsonPath)) {
          try {
            var data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            installed.push({ id: data.id || dir, name: data.name, description: data.description, version: data.version });
          } catch (e) { console.warn('⚠️ [skill-market] 操作失败:', e.message || e); }
        }
      });
    }
  } catch (e) { console.warn('⚠️ [skill-market] 操作失败:', e.message || e); }
  return installed;
}

// ===== HTTP 工具 =====
function _httpGet(url) {
  return new Promise(function(resolve, reject) {
    var client = url.startsWith('https') ? https : http;
    var req = client.get(url, { timeout: 10000 }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
  });
}

function _httpGetRaw(url) {
  return new Promise(function(resolve, reject) {
    var client = url.startsWith('https') ? https : http;
    var req = client.get(url, { timeout: 15000 }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
  });
}

// ===== 模块导出 =====
module.exports = {
  name: 'skill-market',
  dependencies: ['skill'],
  init: function(_Core) {
    Core = _Core;

    // 加载本地注册表
    try {
      var regFile = Core.pathService.perUser('skill-registry-local.json');
      if (fs.existsSync(regFile)) _localRegistry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    } catch (e) { console.warn('⚠️ [skill-market] 操作失败:', e.message || e); }

    Core.skillMarket = {
      search: searchSkills,
      install: installSkill,
      publish: publishLocal,
      listInstalled: listInstalled,
      fetchRegistry: fetchRegistry
    };

    console.log('\u2705 \u6280\u80fd\u5e02\u573a\u6a21\u5757\u5df2\u52a0\u8f7d\uff08\u672c\u5730: ' + _localRegistry.length + ' \u4e2a\u53d1\u5e03\uff09');
  }
};
