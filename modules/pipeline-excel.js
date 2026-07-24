// modules/pipeline-excel.js - Excel (.xlsx) generator
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

let Core = null;

function getOutputDir() {
  if (Core.deliverables && Core.deliverables.getOutputDir) {
    return Core.deliverables.getOutputDir('excel');
  }
  const dir = Core.pathService.perUser(path.join('deliverables', 'excel'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function registerDeliverable(filePath, title) {
  if (Core.deliverables && Core.deliverables.register) {
    Core.deliverables.register({ type: 'excel', filePath, title });
  }
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\|?*]/g, '_').slice(0, 80);
}

// ═══════════════════════════════════════════
// generate - Create xlsx from structured sheets
// ═══════════════════════════════════════════
function generate(options) {
  const { title, sheets, outputPath } = options || {};
  if (!title) return { success: false, error: 'title is required' };
  if (!sheets || !sheets.length) return { success: false, error: 'sheets[] is required' };

  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const name = (sheet.name || 'Sheet1').slice(0, 31);
    const aoa = [];
    if (sheet.headers && sheet.headers.length) aoa.push(sheet.headers);
    if (sheet.rows && sheet.rows.length) aoa.push(...sheet.rows);
    if (!aoa.length) aoa.push([]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Bold + colored headers
    if (sheet.headers && sheet.headers.length) {
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c });
        if (ws[addr]) {
          ws[addr].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '4472C4' } } };
        }
      }
    }

    // Auto column widths
    const colWidths = [];
    aoa.forEach(row => {
      row.forEach((cell, i) => {
        const len = String(cell || '').length;
        colWidths[i] = Math.max(colWidths[i] || 8, Math.min(len + 2, 50));
      });
    });
    ws['!cols'] = colWidths.map(w => ({ wch: w }));

    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  const dir = getOutputDir();
  const fileName = sanitizeFilename(title) + '_' + Date.now() + '.xlsx';
  const filePath = outputPath || path.join(dir, fileName);

  try {
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
    XLSX.writeFile(wb, filePath);
  } catch (e) {
    return { success: false, error: 'Write failed: ' + e.message };
  }

  registerDeliverable(filePath, title);
  return { success: true, filePath };
}

// ═══════════════════════════════════════════
// fromData - Auto-detect headers from objects
// ═══════════════════════════════════════════
function fromData(title, data) {
  if (!title) return { success: false, error: 'title is required' };
  if (!Array.isArray(data) || !data.length) return { success: false, error: 'data must be a non-empty array' };

  const headers = Object.keys(data[0]);
  const rows = data.map(obj => headers.map(h => obj[h] !== undefined ? obj[h] : ''));

  return generate({ title, sheets: [{ name: 'Data', headers, rows }] });
}

// ═══════════════════════════════════════════
// fromCsv - Parse CSV text into xlsx
// ═══════════════════════════════════════════
function fromCsv(csvContent, title) {
  if (!csvContent) return { success: false, error: 'csvContent is required' };
  const t = title || 'csv_export';

  const lines = csvContent.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { success: false, error: 'No CSV data found' };

  const parseLine = (line) => {
    const result = [];
    let current = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);

  return generate({ title: t, sheets: [{ name: 'CSV', headers, rows }] });
}

// ═══════════════════════════════════════════
// Module init
// ═══════════════════════════════════════════
function init(_Core) {
  Core = _Core;
  Core.pipelineExcel = { generate, fromData, fromCsv };
  console.log('[pipeline-excel] initialized');
}

module.exports = { name: 'pipeline-excel', dependencies: [], init };
