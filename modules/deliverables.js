// modules/deliverables.js - 交付物注册与管理
'use strict';
const fs = require('fs');
const path = require('path');

let Core = null;
let registry = [];
let baseDir = '';
let indexPath = '';

const TYPES = ['report', 'ppt', 'webapp', 'excel', 'manga', 'other'];
const TYPE_DIRS = { report: 'reports', ppt: 'ppt', webapp: 'webapps', excel: 'excel', manga: 'manga', other: 'other' };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadRegistry() {
  try {
    if (fs.existsSync(indexPath)) {
      registry = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    }
  } catch (e) { registry = []; }
}

function saveRegistry() {
  try { fs.writeFileSync(indexPath, JSON.stringify(registry, null, 2), 'utf8'); }
  catch (e) { console.warn('Deliverables save fail:', e.message); }
}

function register(options) {
  const { type, title, filePath, metadata } = options || {};
  if (!type || !TYPES.includes(type)) return { success: false, error: 'Invalid type: ' + type };
  if (!title) return { success: false, error: 'Title is required' };
  const id = 'del_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const record = { id, type, title, filePath: filePath || '', createdAt: Date.now(), metadata: metadata || {} };
  registry.push(record);
  saveRegistry();
  return { success: true, id, filePath: record.filePath };
}

function list(filter) {
  let items = registry;
  if (filter && filter.type) items = items.filter(d => d.type === filter.type);
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

function get(id) {
  return registry.find(d => d.id === id) || null;
}

function getFilePath(id) {
  const item = get(id);
  return item ? item.filePath : null;
}

function remove(id) {
  const idx = registry.findIndex(d => d.id === id);
  if (idx === -1) return { success: false, error: 'Not found' };
  registry.splice(idx, 1);
  saveRegistry();
  return { success: true };
}

function getOutputDir(type) {
  const sub = TYPE_DIRS[type] || 'other';
  const dir = path.join(baseDir, sub);
  ensureDir(dir);
  return dir;
}

function getStats() {
  const byType = {};
  TYPES.forEach(t => { byType[t] = 0; });
  registry.forEach(d => { byType[d.type] = (byType[d.type] || 0) + 1; });
  return { total: registry.length, byType };
}

function init(_Core) {
  Core = _Core;
  baseDir = Core.pathService.perUser('deliverables');
  indexPath = path.join(baseDir, 'index.json');
  ensureDir(baseDir);
  TYPES.forEach(t => ensureDir(path.join(baseDir, TYPE_DIRS[t])));
  loadRegistry();

  Core.deliverables = { register, list, get, getFilePath, remove, getOutputDir, getStats };
  console.log('✅ 交付物管理模块已加载 (' + registry.length + ' 个交付物)');
}

module.exports = { name: 'deliverables', dependencies: [], init };
