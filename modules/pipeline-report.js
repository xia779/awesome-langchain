// -*- coding: utf-8 -*-
// modules/pipeline-report.js — Generate Word (.docx) and PDF reports from text/markdown
'use strict';

const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

let Core = null;

function getOutputDir() {
  if (Core.deliverables && typeof Core.deliverables.getOutputDir === 'function') {
    return Core.deliverables.getOutputDir('report');
  }
  const dir = path.join(Core.DATA_ROOT || 'E:\my-ai-data', 'deliverables', 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function registerDeliverable(filePath, title) {
  if (Core.deliverables && typeof Core.deliverables.register === 'function') {
    Core.deliverables.register({ filePath, title, type: 'report' });
  }
}

function parseMarkdown(content) {
  const lines = (content || '').split('\n');
  const blocks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^###\s+/.test(trimmed)) blocks.push({ type: 'h3', text: trimmed.replace(/^###\s+/, '') });
    else if (/^##\s+/.test(trimmed)) blocks.push({ type: 'h2', text: trimmed.replace(/^##\s+/, '') });
    else if (/^#\s+/.test(trimmed)) blocks.push({ type: 'h1', text: trimmed.replace(/^#\s+/, '') });
    else if (/^[-*]\s+/.test(trimmed)) blocks.push({ type: 'bullet', text: trimmed.replace(/^[-*]\s+/, '') });
    else blocks.push({ type: 'para', text: trimmed });
  }
  return blocks;
}

async function generateWord(options) {
  const { title, content, author, outputPath } = options || {};
  const blocks = parseMarkdown(content);
  const children = [];

  // Title page
  children.push(new Paragraph({ spacing: { before: 2400 } }));
  children.push(new Paragraph({
    children: [new TextRun({ text: title || 'Report', bold: true, size: 56 })],
    alignment: 'center'
  }));
  if (author) {
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Author: ' + author, size: 24, color: '666666' })],
      alignment: 'center', spacing: { before: 400 }
    }));
  }
  children.push(new Paragraph({
    children: [new TextRun({ text: new Date().toLocaleDateString(), size: 24, color: '666666' })],
    alignment: 'center', spacing: { before: 200 }
  }));
  children.push(new Paragraph({ children: [], pageBreakBefore: true }));

  // Content
  for (const block of blocks) {
    if (block.type === 'h1') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 }));
    else if (block.type === 'h2') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 }));
    else if (block.type === 'h3') children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_3 }));
    else if (block.type === 'bullet') children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }));
    else children.push(new Paragraph({ children: [new TextRun(block.text)] }));
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const outDir = getOutputDir();
  const fileName = (title || 'report').replace(/[\/:*?"<>|]/g, '_') + '.docx';
  const filePath = outputPath || path.join(outDir, fileName);
  fs.writeFileSync(filePath, buffer);
  registerDeliverable(filePath, title || 'Report');
  return { success: true, filePath };
}

async function generatePdf(options) {
  const { title, content, outputPath } = options || {};
  const pdfDoc = await PDFDocument.create();
  // 🔧 B16: 注册 fontkit 以支持自定义字体嵌入
  pdfDoc.registerFontkit(fontkit);

  // 尝试加载 CJK 字体（SimHei），回退到 Helvetica
  let font, boldFont;
  const cjkFontPaths = [
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\msyh.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'
  ];
  let cjkLoaded = false;
  for (const fp of cjkFontPaths) {
    try {
      if (fs.existsSync(fp)) {
        const fontBytes = fs.readFileSync(fp);
        font = await pdfDoc.embedFont(fontBytes, { subset: true });
        boldFont = font; // CJK 字体通常不区分 bold，复用即可
        cjkLoaded = true;
        break;
      }
    } catch (e) { /* 尝试下一个路径 */ }
  }
  if (!cjkLoaded) {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }
  const blocks = parseMarkdown(content);

  let page = pdfDoc.addPage([595, 842]);
  let y = 780;
  const margin = 50;
  const maxWidth = 495;

  function ensureSpace(needed) {
    if (y - needed < 50) { page = pdfDoc.addPage([595, 842]); y = 790; }
  }

    // 🔒 #6 修复：中英混排智能断行 — CJK 逐字断行，Latin 单词保持完整
    function drawWrapped(text, f, size, indent) {
      const x = margin + (indent || 0);
      const availWidth = maxWidth - (indent || 0);
      // 将文本分词：CJK 字符单独成 token，连续 ASCII 字母/数字作为整体
      var tokens = [];
      var i = 0;
      while (i < text.length) {
        var code = text.charCodeAt(i);
        // CJK 统一汉字 / 全角标点 / 日文假名等
        var isCJK = (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
                    (code >= 0x3000 && code <= 0x303F) || (code >= 0xFF00 && code <= 0xFFEF) ||
                    (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF);
        if (isCJK) {
          tokens.push(text[i]);
          i++;
        } else if (/[a-zA-Z0-9]/.test(text[i])) {
          // 连续 ASCII 字母/数字作为一个整体（不拆开英文单词）
          var word = '';
          while (i < text.length && /[a-zA-Z0-9._\-]/.test(text[i])) {
            word += text[i];
            i++;
          }
          tokens.push(word);
        } else {
          // 空格、标点等
          tokens.push(text[i]);
          i++;
        }
      }
      var line = '';
      for (var ti = 0; ti < tokens.length; ti++) {
        var tok = tokens[ti];
        var test = line + tok;
        if (f.widthOfTextAtSize(test, size) > availWidth && line.length > 0) {
          ensureSpace(size + 4);
          page.drawText(line, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
          y -= size + 4;
          line = tok;
        } else {
          line = test;
        }
      }
      if (line) { ensureSpace(size + 4); page.drawText(line, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 4; }
    }

  // Title
  ensureSpace(30);
  page.drawText(title || 'Report', { x: margin, y, size: 22, font: boldFont, color: rgb(0, 0, 0) });
  y -= 36;

  // Content
  for (const block of blocks) {
    if (block.type === 'h1') { y -= 8; ensureSpace(18); drawWrapped(block.text, boldFont, 16, 0); y -= 4; }
    else if (block.type === 'h2') { y -= 6; ensureSpace(15); drawWrapped(block.text, boldFont, 13, 0); y -= 3; }
    else if (block.type === 'h3') { y -= 4; ensureSpace(13); drawWrapped(block.text, boldFont, 11, 0); y -= 2; }
    else if (block.type === 'bullet') { ensureSpace(12); drawWrapped('• ' + block.text, font, 10, 10); }
    else { ensureSpace(12); drawWrapped(block.text, font, 10, 0); y -= 2; }
  }

  const bytes = await pdfDoc.save();
  const outDir = getOutputDir();
  const fileName = (title || 'report').replace(/[\/:*?"<>|]/g, '_') + '.pdf';
  const filePath = outputPath || path.join(outDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  registerDeliverable(filePath, title || 'Report');
  return { success: true, filePath };
}

async function fromConversation(sessionId, format) {
  const session = Core.session && Core.session.sessions ? Core.session.sessions[sessionId] : null;
  if (!session || !session.messages || session.messages.length === 0) {
    return { success: false, error: 'Session not found or empty' };
  }
  const title = session.title || 'Conversation Report';
  let content = '# ' + title + '\n\n';
  for (const msg of session.messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    content += '## ' + role + '\n\n' + (msg.content || '') + '\n\n';
  }
  if (format === 'pdf') return generatePdf({ title, content });
  return generateWord({ title, content, author: 'Pipeline Report' });
}

module.exports = {
  name: 'pipeline-report',
  dependencies: [],
  init(C) {
    Core = C;
    Core.pipelineReport = { generateWord, generatePdf, fromConversation };
  }
};
