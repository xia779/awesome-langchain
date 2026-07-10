// modules/doc-handler.js — 文档处理套件（PDF/DOCX/XLSX/PPTX）
var fs = require('fs');
var path = require('path');

var Core = null;

// ===== 输出目录 =====
function getOutputDir() {
  if (!Core) return null;
  var base = Core.DATA_ROOT || Core._globalDataRoot || 'E:\\my-ai-data';
  var dir = path.join(base, 'documents');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }
  return dir;
}

// ===== 文件类型检测 =====
function getFileIcon(ext) {
  var icons = {
    '.pdf': '📕', '.docx': '📘', '.doc': '📘',
    '.xlsx': '📗', '.xls': '📗', '.csv': '📗',
    '.pptx': '📙', '.ppt': '📙',
  };
  return icons[ext.toLowerCase()] || '📄';
}

function isDocFormat(ext) {
  return ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt'].indexOf(ext.toLowerCase()) >= 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF 处理
// ═══════════════════════════════════════════════════════════════════════════════

// PDF 读取（优先使用 pdf-parse，降级到 pdfjs-dist）
async function readPDF(filePath) {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: '文件不存在: ' + filePath };
  }

  // 优先方案：pdf-parse（内置 worker 处理，Node.js 环境下更稳定）
  try {
    var pdfParse = require('pdf-parse');
    var buf = fs.readFileSync(filePath);
    var result = await pdfParse(buf);
    if (result && result.text && result.text.trim().length > 0) {
      return {
        success: true,
        text: result.text.trim(),
        meta: { numPages: result.numpages, info: result.info || {} },
        pages: [{ pageNum: 1, text: result.text }],
      };
    }
    console.warn('⚠️ pdf-parse 返回空内容，尝试 pdfjs-dist');
  } catch (e) {
    console.warn('⚠️ pdf-parse 失败，尝试 pdfjs-dist:', e.message);
  }

  // 降级方案：pdfjs-dist（需要手动配置 worker）
  try {
    var pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

    // 🔧 修复：在 getDocument 之前配置 worker 路径，避免 "No workerSrc" 警告
    if (pdfjsLib.GlobalWorkerOptions) {
      var workerPaths = [
        path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
        path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'),
        path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs'),
      ];
      var workerFound = false;
      for (var wi = 0; wi < workerPaths.length; wi++) {
        if (fs.existsSync(workerPaths[wi])) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = workerPaths[wi];
          workerFound = true;
          break;
        }
      }
      if (!workerFound) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = ' ';  // 设为非空字符串抑制警告
      }
    }

    var data = new Uint8Array(fs.readFileSync(filePath));
    var loadingTask = pdfjsLib.getDocument({
      data: data,
      useSystemFonts: true,
      standardFontDataUrl: undefined,
      disableWorker: true,  // Electron renderer 中禁用 web worker
      isEvalSupported: false,
      verbosity: 0,  // 抑制 pdfjs 内部警告日志
    });
    var doc = await loadingTask.promise;

    var fullText = '';
    var pages = [];
    for (var i = 1; i <= doc.numPages; i++) {
      var page = await doc.getPage(i);
      var content = await page.getTextContent();
      var pageText = content.items.map(function(item) { return item.str; }).join(' ');
      pages.push({ pageNum: i, text: pageText });
      fullText += pageText + '\n\n';
    }

    if (fullText.trim().length > 0) {
      return {
        success: true,
        text: fullText.trim(),
        meta: { numPages: doc.numPages, info: doc._pdfInfo || {} },
        pages: pages,
      };
    }
    return { success: false, error: 'PDF 内容为空，可能是扫描件或图片型 PDF' };
  } catch (e2) {
    return { success: false, error: 'PDF 解析失败: ' + e2.message + '\n\n提示: 请确保已安装 pdf-parse 依赖 (npm install pdf-parse)' };
  }
}

// PDF 生成（使用 pdf-lib）
async function generatePDF(options) {
  var PDFDocument = require('pdf-lib').PDFDocument;
  var StandardFonts = require('pdf-lib').StandardFonts;
  var rgb = require('pdf-lib').rgb;

  var title = options.title || '文档';
  var content = options.content || '';
  var author = options.author || 'AI智能体';

  var pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setAuthor(author);
  pdfDoc.setCreationDate(new Date());

  // 使用内置字体（中文需要嵌入字体，这里先用 Helvetica + 分段处理）
  var helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  var helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  var pageWidth = 595.28; // A4
  var pageHeight = 841.89;
  var marginX = 50;
  var marginY = 60;
  var usableWidth = pageWidth - marginX * 2;
  var fontSize = 11;
  var titleFontSize = 18;
  var lineHeight = fontSize * 1.6;

  // 首页（标题页）
  var page = pdfDoc.addPage([pageWidth, pageHeight]);
  var y = pageHeight - marginY;

  // 标题
  page.drawText(title, {
    x: marginX,
    y: y,
    size: titleFontSize,
    font: helveticaBold,
    color: rgb(0.1, 0.1, 0.3),
  });
  y -= titleFontSize * 2;

  // 日期和作者
  var metaText = author + ' | ' + new Date().toLocaleDateString('zh-CN');
  page.drawText(metaText, {
    x: marginX,
    y: y,
    size: 9,
    font: helveticaFont,
    color: rgb(0.5, 0.5, 0.5),
  });
  y -= lineHeight * 2;

  // 分割线
  page.drawLine({
    start: { x: marginX, y: y },
    end: { x: pageWidth - marginX, y: y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= lineHeight;

  // 内容（按行处理，自动分页）
  var lines = content.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // 检查是否需要新页
    if (y < marginY) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - marginY;
    }

    // 标题行（# 开头）
    if (line.startsWith('### ')) {
      y -= lineHeight * 0.5;
      page.drawText(line.substring(4), {
        x: marginX, y: y, size: 13, font: helveticaBold, color: rgb(0.15, 0.15, 0.4),
      });
      y -= lineHeight * 1.2;
      continue;
    }
    if (line.startsWith('## ')) {
      y -= lineHeight * 0.5;
      page.drawText(line.substring(3), {
        x: marginX, y: y, size: 15, font: helveticaBold, color: rgb(0.1, 0.1, 0.35),
      });
      y -= lineHeight * 1.2;
      continue;
    }
    if (line.startsWith('# ')) {
      y -= lineHeight * 0.5;
      page.drawText(line.substring(2), {
        x: marginX, y: y, size: 16, font: helveticaBold, color: rgb(0.05, 0.05, 0.3),
      });
      y -= lineHeight * 1.2;
      continue;
    }

    // 空行
    if (line.trim() === '') {
      y -= lineHeight * 0.5;
      continue;
    }

    // 普通文本（自动换行）
    var words = line.split(' ');
    var currentLine = '';
    for (var w = 0; w < words.length; w++) {
      var testLine = currentLine ? currentLine + ' ' + words[w] : words[w];
      var textWidth = helveticaFont.widthOfTextAtSize(testLine, fontSize);
      if (textWidth > usableWidth && currentLine) {
        page.drawText(currentLine, {
          x: marginX, y: y, size: fontSize, font: helveticaFont, color: rgb(0.15, 0.15, 0.15),
        });
        y -= lineHeight;
        currentLine = words[w];
        if (y < marginY) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - marginY;
        }
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      page.drawText(currentLine, {
        x: marginX, y: y, size: fontSize, font: helveticaFont, color: rgb(0.15, 0.15, 0.15),
      });
      y -= lineHeight;
    }
  }

  var pdfBytes = await pdfDoc.save();
  var fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
  var outPath = path.join(getOutputDir(), fileName);
  fs.writeFileSync(outPath, pdfBytes);

  return { success: true, path: outPath, fileName: fileName, size: pdfBytes.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCX 处理
// ═══════════════════════════════════════════════════════════════════════════════

// DOCX 读取
async function readDOCX(filePath) {
  try {
    var mammoth = require('mammoth');
    var result = await mammoth.extractRawText({ path: filePath });
    var htmlResult = await mammoth.convertToHtml({ path: filePath });
    return {
      success: true,
      text: result.value,
      html: htmlResult.value,
      warnings: result.messages.map(function(m) { return m.message; }),
    };
  } catch (e) {
    return { success: false, error: 'DOCX 解析失败: ' + e.message };
  }
}

// DOCX 生成
async function generateDOCX(options) {
  var docx = require('docx');
  var Document = docx.Document;
  var Paragraph = docx.Paragraph;
  var TextRun = docx.TextRun;
  var HeadingLevel = docx.HeadingLevel;
  var Packer = docx.Packer;
  var AlignmentType = docx.AlignmentType;
  var Table = docx.Table;
  var TableRow = docx.TableRow;
  var TableCell = docx.TableCell;
  var WidthType = docx.WidthType;

  var title = options.title || '文档';
  var content = options.content || '';
  var author = options.author || 'AI智能体';

  var children = [];

  // 标题
  children.push(new Paragraph({
    children: [new TextRun({ text: title, bold: true, size: 36, color: '1A1A4E' })],
    heading: HeadingLevel.TITLE,
    spacing: { after: 200 },
  }));

  // 元信息
  children.push(new Paragraph({
    children: [new TextRun({
      text: author + ' | ' + new Date().toLocaleDateString('zh-CN'),
      italics: true, size: 18, color: '888888',
    })],
    spacing: { after: 400 },
  }));

  // 解析 Markdown 内容
  var lines = content.split('\n');
  var tableRows = [];
  var inTable = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // 表格检测（| col1 | col2 |）
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      var cells = line.split('|').filter(function(c) { return c.trim() !== ''; }).map(function(c) { return c.trim(); });
      // 跳过分隔行（|---|---|）
      if (cells.every(function(c) { return /^[-:]+$/.test(c); })) continue;
      tableRows.push(cells);
      inTable = true;
      continue;
    }

    // 如果之前在表格中，现在结束了，输出表格
    if (inTable && tableRows.length > 0) {
      var rows = tableRows.map(function(row, ri) {
        return new TableRow({
          children: row.map(function(cell) {
            return new TableCell({
              children: [new Paragraph({
                children: [new TextRun({ text: cell, bold: ri === 0, size: 20 })],
              })],
              width: { size: Math.floor(100 / row.length), type: WidthType.PERCENTAGE },
            });
          }),
        });
      });
      children.push(new Table({ rows: rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
      tableRows = [];
      inTable = false;
    }

    // 标题
    if (line.startsWith('### ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.substring(4), bold: true, size: 24 })],
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      continue;
    }
    if (line.startsWith('## ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.substring(3), bold: true, size: 28 })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 150 },
      }));
      continue;
    }
    if (line.startsWith('# ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.substring(2), bold: true, size: 32, color: '1A1A4E' })],
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      }));
      continue;
    }

    // 列表项
    if (/^\s*[-*]\s/.test(line)) {
      var listText = line.replace(/^\s*[-*]\s/, '');
      children.push(new Paragraph({
        children: [new TextRun({ text: '• ' + listText, size: 22 })],
        spacing: { after: 60 },
        indent: { left: 400 },
      }));
      continue;
    }
    if (/^\s*\d+\.\s/.test(line)) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.trim(), size: 22 })],
        spacing: { after: 60 },
        indent: { left: 400 },
      }));
      continue;
    }

    // 空行
    if (line.trim() === '') {
      children.push(new Paragraph({ children: [], spacing: { after: 100 } }));
      continue;
    }

    // 代码块标记跳过
    if (line.trim().startsWith('```')) continue;

    // 普通文本（处理 **bold** 和 *italic*）
    var runs = [];
    var remaining = line;
    var boldRegex = /\*\*(.+?)\*\*/g;
    var italicRegex = /\*(.+?)\*/g;
    var match;
    var lastIndex = 0;

    // 简化处理：直接作为 TextRun
    runs.push(new TextRun({ text: line, size: 22 }));

    children.push(new Paragraph({
      children: runs,
      spacing: { after: 80 },
    }));
  }

  // 处理末尾表格
  if (inTable && tableRows.length > 0) {
    var rows = tableRows.map(function(row, ri) {
      return new TableRow({
        children: row.map(function(cell) {
          return new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: cell, bold: ri === 0, size: 20 })],
            })],
            width: { size: Math.floor(100 / row.length), type: WidthType.PERCENTAGE },
          });
        }),
      });
    });
    children.push(new Table({ rows: rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }

  var doc = new Document({
    creator: author,
    title: title,
    description: '由 AI智能体 自动生成',
    sections: [{ children: children }],
  });

  var buffer = await Packer.toBuffer(doc);
  var fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '.docx';
  var outPath = path.join(getOutputDir(), fileName);
  fs.writeFileSync(outPath, buffer);

  return { success: true, path: outPath, fileName: fileName, size: buffer.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// XLSX 处理
// ═══════════════════════════════════════════════════════════════════════════════

// XLSX 读取
async function readXLSX(filePath) {
  try {
    var XLSX = require('xlsx');
    var workbook = XLSX.readFile(filePath);
    var sheets = {};
    var allText = '';

    workbook.sheetNames.forEach(function(sheetName) {
      var ws = workbook.Sheets[sheetName];
      var jsonData = XLSX.utils.sheet_to_json(ws, { header: 1 });
      var csvData = XLSX.utils.sheet_to_csv(ws);
      sheets[sheetName] = {
        rows: jsonData,
        csv: csvData,
        range: XLSX.utils.decode_range(ws['!ref'] || 'A1'),
      };
      allText += '== ' + sheetName + ' ==\n' + csvData + '\n\n';
    });

    return {
      success: true,
      text: allText.trim(),
      sheets: sheets,
      sheetNames: workbook.sheetNames,
      meta: {
        sheetCount: workbook.sheetNames.length,
      },
    };
  } catch (e) {
    return { success: false, error: 'XLSX 解析失败: ' + e.message };
  }
}

// XLSX 生成
async function generateXLSX(options) {
  var XLSX = require('xlsx');

  var title = options.title || '数据表';
  var sheets = options.sheets; // { sheetName: { headers: [], rows: [[]] } }
  var content = options.content; // 纯文本表格数据

  var workbook = XLSX.utils.book_new();

  if (sheets && typeof sheets === 'object') {
    // 结构化数据
    Object.keys(sheets).forEach(function(sheetName) {
      var sheet = sheets[sheetName];
      var data = [];
      if (sheet.headers && sheet.headers.length > 0) {
        data.push(sheet.headers);
      }
      if (sheet.rows && sheet.rows.length > 0) {
        data = data.concat(sheet.rows);
      }
      var ws = XLSX.utils.aoa_to_sheet(data);

      // 自动列宽
      if (data.length > 0) {
        ws['!cols'] = data[0].map(function(_, colIdx) {
          var maxLen = 0;
          data.forEach(function(row) {
            var cell = row[colIdx];
            if (cell != null) {
              var len = String(cell).length;
              // 中文字符算 2 个宽度
              var cjk = (String(cell).match(/[\u4e00-\u9fff]/g) || []).length;
              len = len + cjk;
              if (len > maxLen) maxLen = len;
            }
          });
          return { wch: Math.min(Math.max(maxLen + 2, 8), 50) };
        });
      }

      XLSX.utils.book_append_sheet(workbook, ws, sheetName);
    });
  } else if (content) {
    // 从文本解析（CSV 格式）
    var lines = content.split('\n').filter(function(l) { return l.trim() !== ''; });
    var data = lines.map(function(line) {
      return line.split(/[,\t|]/).map(function(c) { return c.trim(); });
    });
    var ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, ws, title);
  } else {
    // 空表
    var ws = XLSX.utils.aoa_to_sheet([['（空表格）']]);
    XLSX.utils.book_append_sheet(workbook, ws, 'Sheet1');
  }

  var fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '.xlsx';
  var outPath = path.join(getOutputDir(), fileName);
  XLSX.writeFile(workbook, outPath);

  var stat = fs.statSync(outPath);
  return { success: true, path: outPath, fileName: fileName, size: stat.size };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PPTX 处理
// ═══════════════════════════════════════════════════════════════════════════════

// PPTX 生成（使用 pptxgenjs）
async function generatePPTX(options) {
  var PptxGenJS = require('pptxgenjs');
  var pptx = new PptxGenJS();

  var title = options.title || '演示文稿';
  var content = options.content || '';
  var author = options.author || 'AI智能体';

  pptx.title = title;
  pptx.author = author;
  pptx.subject = '由 AI智能体 自动生成';
  pptx.layout = 'LAYOUT_WIDE'; // 16:9

  // 配色方案
  var colors = {
    titleBg: '1A1A2E',
    titleText: 'FFFFFF',
    sectionBg: '16213E',
    sectionText: '00B4D8',
    contentBg: 'FFFFFF',
    contentTitle: '1A1A4E',
    contentText: '333333',
    accent: '0F3460',
  };

  // === 标题页 ===
  var titleSlide = pptx.addSlide();
  titleSlide.background = { fill: colors.titleBg };
  titleSlide.addText(title, {
    x: 0.8, y: 2.0, w: 11.5, h: 1.5,
    fontSize: 36, bold: true, color: colors.titleText,
    fontFace: 'Microsoft YaHei',
    align: 'center',
  });
  titleSlide.addText(author + ' | ' + new Date().toLocaleDateString('zh-CN'), {
    x: 0.8, y: 3.8, w: 11.5, h: 0.5,
    fontSize: 14, color: '888888',
    fontFace: 'Microsoft YaHei',
    align: 'center',
  });
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: 3.5, y: 3.5, w: 6, h: 0.02, fill: { color: colors.accent },
  });

  // === 内容页（从 Markdown 大纲生成）===
  var sections = [];
  var currentSection = null;
  var lines = content.split('\n');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // H1 → 新章节标题页
    if (line.startsWith('# ')) {
      currentSection = { type: 'h1', title: line.substring(2), bullets: [] };
      sections.push(currentSection);
      continue;
    }
    // H2 → 子章节
    if (line.startsWith('## ')) {
      currentSection = { type: 'h2', title: line.substring(3), bullets: [] };
      sections.push(currentSection);
      continue;
    }
    // H3 → 幻灯片标题
    if (line.startsWith('### ')) {
      currentSection = { type: 'h3', title: line.substring(4), bullets: [] };
      sections.push(currentSection);
      continue;
    }

    // 列表项
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      var bullet = line.replace(/^\s*[-*]\s/, '').replace(/^\s*\d+\.\s/, '');
      if (currentSection) {
        currentSection.bullets.push(bullet);
      }
      continue;
    }

    // 普通文本
    if (line.trim() && currentSection) {
      currentSection.bullets.push(line.trim());
    }
  }

  // 如果没有检测到章节，按段落分页
  if (sections.length === 0 && content.trim()) {
    var paragraphs = content.split(/\n\n+/);
    paragraphs.forEach(function(para, idx) {
      var pLines = para.split('\n');
      sections.push({
        type: 'content',
        title: pLines[0].substring(0, 50),
        bullets: pLines.slice(1).filter(function(l) { return l.trim(); }),
      });
    });
  }

  // 生成幻灯片
  sections.forEach(function(section) {
    var slide = pptx.addSlide();

    if (section.type === 'h1') {
      // 章节分隔页
      slide.background = { fill: colors.sectionBg };
      slide.addText(section.title, {
        x: 0.8, y: 2.5, w: 11.5, h: 1.5,
        fontSize: 32, bold: true, color: colors.sectionText,
        fontFace: 'Microsoft YaHei',
        align: 'center',
      });
    } else {
      // 内容页
      slide.background = { fill: colors.contentBg };

      // 标题栏
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: 13.33, h: 0.8, fill: { color: colors.accent },
      });
      slide.addText(section.title, {
        x: 0.5, y: 0.1, w: 12, h: 0.6,
        fontSize: 22, bold: true, color: 'FFFFFF',
        fontFace: 'Microsoft YaHei',
      });

      // 内容
      if (section.bullets.length > 0) {
        var bulletTexts = section.bullets.map(function(b) {
          return { text: b, options: { bullet: true, fontSize: 16, color: colors.contentText, breakType: 'break', paraSpaceAfter: 8 } };
        });
        slide.addText(bulletTexts, {
          x: 0.8, y: 1.2, w: 11.5, h: 5.5,
          fontFace: 'Microsoft YaHei',
          valign: 'top',
          lineSpacingMultiple: 1.3,
        });
      }
    }
  });

  // 感谢页
  var endSlide = pptx.addSlide();
  endSlide.background = { fill: colors.titleBg };
  endSlide.addText('谢谢', {
    x: 0.8, y: 2.5, w: 11.5, h: 1.5,
    fontSize: 40, bold: true, color: colors.titleText,
    fontFace: 'Microsoft YaHei',
    align: 'center',
  });

  var fileName = title.replace(/[\\/:*?"<>|]/g, '_') + '.pptx';
  var outPath = path.join(getOutputDir(), fileName);
  await pptx.writeFile({ fileName: outPath });

  var stat = fs.statSync(outPath);
  return { success: true, path: outPath, fileName: fileName, size: stat.size, slideCount: sections.length + 2 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 统一读取接口
// ═══════════════════════════════════════════════════════════════════════════════

async function readDocument(filePath) {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: '文件不存在: ' + filePath };
  }
  var ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return await readPDF(filePath);
    case '.docx': case '.doc': return await readDOCX(filePath);
    case '.xlsx': case '.xls': case '.csv': return await readXLSX(filePath);
    default:
      return { success: false, error: '不支持的格式: ' + ext + '（支持 PDF/DOCX/XLSX/CSV）' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 斜杠命令注册
// ═══════════════════════════════════════════════════════════════════════════════

function registerCommands() {
  if (!Core.custom || !Core.custom.registerCommand) return;

  // /pdf — 读取或生成 PDF
  Core.custom.registerCommand('pdf', {
    zh: 'PDF 处理 — /pdf read <路径> 读取 | /pdf gen <标题> 生成',
    en: 'PDF operations — read or generate PDF files'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = (parts[0] || '').toLowerCase();
    var rest = parts.slice(1).join(' ');

    if (sub === 'read' && rest) {
      Core.dom.status.textContent = '📕 正在读取 PDF...';
      readPDF(rest).then(function(result) {
        Core.dom.status.textContent = result.success ? '📕 PDF 读取完成' : '❌ PDF 读取失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          var preview = result.text.length > 2000 ? result.text.substring(0, 2000) + '\n\n...(共 ' + result.text.length + ' 字符)' : result.text;
          Core.session.addMessage(
            '📕 **PDF 文件读取成功**\n\n' +
            '- 页数: ' + result.meta.numPages + '\n' +
            '- 字符数: ' + result.text.length + '\n\n' +
            '---\n\n' + preview,
            'ai'
          );
        } else {
          Core.session.addMessage('❌ PDF 读取失败: ' + result.error, 'ai');
        }
      });
    } else if (sub === 'gen') {
      var genTitle = rest || '文档_' + new Date().toISOString().slice(0, 10);
      // 获取当前会话最后一条 AI 消息作为内容
      var msgs = Core.session ? Core.session.getMessages() : [];
      var lastAiMsg = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'ai' || msgs[i].role === 'assistant') {
          lastAiMsg = msgs[i].content || msgs[i].text || '';
          break;
        }
      }
      Core.dom.status.textContent = '📕 正在生成 PDF...';
      generatePDF({ title: genTitle, content: lastAiMsg || '由 AI智能体 生成的文档' }).then(function(result) {
        Core.dom.status.textContent = result.success ? '📕 PDF 生成完成' : '❌ PDF 生成失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          Core.session.addMessage(
            '📕 **PDF 已生成**\n\n' +
            '- 文件名: ' + result.fileName + '\n' +
            '- 大小: ' + (result.size / 1024).toFixed(1) + ' KB\n' +
            '- 路径: `' + result.path + '`',
            'ai'
          );
        } else {
          Core.session.addMessage('❌ PDF 生成失败: ' + result.error, 'ai');
        }
      });
    } else {
      Core.session.addMessage(
        '**PDF 命令帮助**\n\n' +
        '- `/pdf read <文件路径>` — 读取 PDF 文件内容\n' +
        '- `/pdf gen <标题>` — 将最后一条 AI 回复生成为 PDF\n' +
        '- `/pdf` — 显示此帮助',
        'ai'
      );
    }
  });

  // /docx — Word 文档处理
  Core.custom.registerCommand('docx', {
    zh: 'Word 文档 — /docx read <路径> 读取 | /docx gen <标题> 生成',
    en: 'Word document operations'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = (parts[0] || '').toLowerCase();
    var rest = parts.slice(1).join(' ');

    if (sub === 'read' && rest) {
      Core.dom.status.textContent = '📘 正在读取 Word 文档...';
      readDOCX(rest).then(function(result) {
        Core.dom.status.textContent = result.success ? '📘 Word 读取完成' : '❌ Word 读取失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          var preview = result.text.length > 2000 ? result.text.substring(0, 2000) + '\n\n...(共 ' + result.text.length + ' 字符)' : result.text;
          Core.session.addMessage(
            '📘 **Word 文档读取成功**\n\n- 字符数: ' + result.text.length + '\n\n---\n\n' + preview,
            'ai'
          );
        } else {
          Core.session.addMessage('❌ Word 读取失败: ' + result.error, 'ai');
        }
      });
    } else if (sub === 'gen') {
      var genTitle = rest || '文档_' + new Date().toISOString().slice(0, 10);
      var msgs = Core.session ? Core.session.getMessages() : [];
      var lastAiMsg = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'ai' || msgs[i].role === 'assistant') {
          lastAiMsg = msgs[i].content || msgs[i].text || '';
          break;
        }
      }
      Core.dom.status.textContent = '📘 正在生成 Word 文档...';
      generateDOCX({ title: genTitle, content: lastAiMsg || '由 AI智能体 生成的文档' }).then(function(result) {
        Core.dom.status.textContent = result.success ? '📘 Word 生成完成' : '❌ Word 生成失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          Core.session.addMessage(
            '📘 **Word 文档已生成**\n\n' +
            '- 文件名: ' + result.fileName + '\n' +
            '- 大小: ' + (result.size / 1024).toFixed(1) + ' KB\n' +
            '- 路径: `' + result.path + '`',
            'ai'
          );
        } else {
          Core.session.addMessage('❌ Word 生成失败: ' + result.error, 'ai');
        }
      });
    } else {
      Core.session.addMessage(
        '**Word 命令帮助**\n\n' +
        '- `/docx read <文件路径>` — 读取 Word 文档内容\n' +
        '- `/docx gen <标题>` — 将最后一条 AI 回复生成为 Word 文档\n' +
        '- `/docx` — 显示此帮助',
        'ai'
      );
    }
  });

  // /xlsx — Excel 表格处理
  Core.custom.registerCommand('xlsx', {
    zh: 'Excel 表格 — /xlsx read <路径> 读取 | /xlsx gen <标题> 生成',
    en: 'Excel spreadsheet operations'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = (parts[0] || '').toLowerCase();
    var rest = parts.slice(1).join(' ');

    if (sub === 'read' && rest) {
      Core.dom.status.textContent = '📗 正在读取 Excel...';
      readXLSX(rest).then(function(result) {
        Core.dom.status.textContent = result.success ? '📗 Excel 读取完成' : '❌ Excel 读取失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          var sheetInfo = result.sheetNames.map(function(name) {
            var s = result.sheets[name];
            return '- **' + name + '** (' + s.rows.length + ' 行)';
          }).join('\n');
          var preview = result.text.length > 1500 ? result.text.substring(0, 1500) + '\n...' : result.text;
          Core.session.addMessage(
            '📗 **Excel 读取成功**\n\n' + sheetInfo + '\n\n---\n\n```\n' + preview + '\n```',
            'ai'
          );
        } else {
          Core.session.addMessage('❌ Excel 读取失败: ' + result.error, 'ai');
        }
      });
    } else if (sub === 'gen') {
      var genTitle = rest || '数据表_' + new Date().toISOString().slice(0, 10);
      var msgs = Core.session ? Core.session.getMessages() : [];
      var lastAiMsg = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'ai' || msgs[i].role === 'assistant') {
          lastAiMsg = msgs[i].content || msgs[i].text || '';
          break;
        }
      }
      Core.dom.status.textContent = '📗 正在生成 Excel...';
      generateXLSX({ title: genTitle, content: lastAiMsg || '序号,项目,状态\n1,示例项目,进行中' }).then(function(result) {
        Core.dom.status.textContent = result.success ? '📗 Excel 生成完成' : '❌ Excel 生成失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          Core.session.addMessage(
            '📗 **Excel 已生成**\n\n' +
            '- 文件名: ' + result.fileName + '\n' +
            '- 大小: ' + (result.size / 1024).toFixed(1) + ' KB\n' +
            '- 路径: `' + result.path + '`',
            'ai'
          );
        } else {
          Core.session.addMessage('❌ Excel 生成失败: ' + result.error, 'ai');
        }
      });
    } else {
      Core.session.addMessage(
        '**Excel 命令帮助**\n\n' +
        '- `/xlsx read <文件路径>` — 读取 Excel 文件内容\n' +
        '- `/xlsx gen <标题>` — 将最后一条 AI 回复生成为 Excel 表格\n' +
        '- `/xlsx` — 显示此帮助',
        'ai'
      );
    }
  });

  // /ppt — PPT 演示文稿生成
  Core.custom.registerCommand('ppt', {
    zh: 'PPT 演示文稿 — /ppt gen <标题> 从大纲生成 PPT',
    en: 'Generate PowerPoint presentation'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = (parts[0] || '').toLowerCase();
    var rest = parts.slice(1).join(' ');

    if (sub === 'gen' || sub) {
      var genTitle = (sub === 'gen' ? rest : (args || '').trim()) || '演示文稿_' + new Date().toISOString().slice(0, 10);
      var msgs = Core.session ? Core.session.getMessages() : [];
      var lastAiMsg = '';
      for (var i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'ai' || msgs[i].role === 'assistant') {
          lastAiMsg = msgs[i].content || msgs[i].text || '';
          break;
        }
      }
      if (!lastAiMsg) {
        Core.session.addMessage('请先让 AI 生成内容大纲，然后再使用 `/ppt gen <标题>` 转换为 PPT。', 'ai');
        return;
      }
      Core.dom.status.textContent = '📙 正在生成 PPT...';
      Core.session.addMessage('📙 正在生成 PPT: **' + genTitle + '** ...', 'ai');
      generatePPTX({ title: genTitle, content: lastAiMsg }).then(function(result) {
        Core.dom.status.textContent = result.success ? '📙 PPT 生成完成' : '❌ PPT 生成失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          Core.session.addMessage(
            '📙 **PPT 已生成**\n\n' +
            '- 文件名: ' + result.fileName + '\n' +
            '- 幻灯片数: ' + result.slideCount + ' 页\n' +
            '- 大小: ' + (result.size / 1024).toFixed(1) + ' KB\n' +
            '- 路径: `' + result.path + '`',
            'ai'
          );
        } else {
          Core.session.addMessage('❌ PPT 生成失败: ' + result.error, 'ai');
        }
      });
    } else {
      Core.session.addMessage(
        '**PPT 命令帮助**\n\n' +
        '- `/ppt gen <标题>` — 将最后一条 AI 回复（Markdown 大纲）转换为 PPT 演示文稿\n' +
        '- `/ppt` — 显示此帮助\n\n' +
        '**提示**: 先让 AI 用 Markdown 格式生成内容大纲（包含 # ## ### 标题和列表），然后再执行 `/ppt gen` 转为幻灯片。',
        'ai'
      );
    }
  });

  // /doc — 通用文档命令
  Core.custom.registerCommand('doc', {
    zh: '文档工具 — 读取或生成各种文档格式',
    en: 'Document toolkit'
  }, function(args) {
    var parts = (args || '').trim().split(/\s+/);
    var sub = (parts[0] || '').toLowerCase();

    if (sub === 'read' && parts.length >= 2) {
      var filePath = parts.slice(1).join(' ');
      Core.dom.status.textContent = '📄 正在读取文档...';
      readDocument(filePath).then(function(result) {
        Core.dom.status.textContent = result.success ? '📄 文档读取完成' : '❌ 文档读取失败';
        setTimeout(function() { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
        if (result.success) {
          var icon = getFileIcon(path.extname(filePath));
          var preview = result.text.length > 2000 ? result.text.substring(0, 2000) + '\n\n...(共 ' + result.text.length + ' 字符)' : result.text;
          Core.session.addMessage(
            icon + ' **文档读取成功**\n\n- 文件: `' + path.basename(filePath) + '`\n\n---\n\n' + preview,
            'ai'
          );
        } else {
          Core.session.addMessage('❌ 文档读取失败: ' + result.error, 'ai');
        }
      });
    } else {
      Core.session.addMessage(
        '**文档工具帮助**\n\n' +
        '- `/doc read <文件路径>` — 读取文档（支持 PDF/DOCX/XLSX/CSV）\n' +
        '- `/pdf read|gen` — PDF 专用命令\n' +
        '- `/docx read|gen` — Word 专用命令\n' +
        '- `/xlsx read|gen` — Excel 专用命令\n' +
        '- `/ppt gen` — PPT 生成命令\n\n' +
        '**支持的格式**: 📕 PDF | 📘 DOCX | 📗 XLSX/CSV | 📙 PPTX',
        'ai'
      );
    }
  });

  console.log('✅ /pdf /docx /xlsx /ppt /doc 命令已注册');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  init: function(_Core) {
    Core = _Core;

    // 暴露 API
    Core.docHandler = {
      // 读取
      readPDF: readPDF,
      readDOCX: readDOCX,
      readXLSX: readXLSX,
      readDocument: readDocument,

      // 生成
      generatePDF: generatePDF,
      generateDOCX: generateDOCX,
      generateXLSX: generateXLSX,
      generatePPTX: generatePPTX,

      // 工具
      getFileIcon: getFileIcon,
      isDocFormat: isDocFormat,
      getOutputDir: getOutputDir,
    };

    // 延迟注册命令（custom.js 在后面加载）
    setTimeout(function() { registerCommands(); }, 150);

    console.log('✅ 文档处理套件已加载（PDF/DOCX/XLSX/PPTX）');
  },
};
