// modules/tools.js - MCP 工具注册表
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

let Core = null;

// ===== 配置 =====
// 🔧 动态路径白名单：优先使用 permissions 模块，降级到内置列表
function getAllowedDirs() {
  if (Core && Core.permissions && Core.permissions.getAllowedDirs) {
    return Core.permissions.getAllowedDirs();
  }
  const dirs = [process.cwd()];
  if (Core) {
    if (Core._globalDataRoot) dirs.push(Core._globalDataRoot);
    if (Core.DATA_ROOT) dirs.push(Core.DATA_ROOT);
    if (Core.USERS_ROOT) dirs.push(Core.USERS_ROOT);
  }
  dirs.push((Core && (Core._globalDataRoot || Core.DATA_ROOT)) || path.join(__dirname, '..'));
  // 添加应用根目录（基于模块位置，非硬编码路径）
  var appRoot = path.resolve(__dirname, '..');
  if (dirs.indexOf(appRoot) === -1) dirs.push(appRoot);
  try {
    const os = require('os');
    dirs.push(path.join(os.homedir(), 'Desktop'));
  } catch(e) {}
  return dirs;
}

function isPathAllowed(filePath) {
  if (Core && Core.permissions && Core.permissions.isPathAllowed) {
    return Core.permissions.isPathAllowed(filePath);
  }
  const resolved = path.resolve(filePath);
  const allowedDirs = getAllowedDirs();
  for (const dir of allowedDirs) {
    if (resolved.startsWith(path.resolve(dir))) return true;
  }
  return false;
}

// ===== HTML 文本提取 =====
function extractTextFromHtml(html) {
  if (!html) return '';
  // 移除 script/style/noscript 标签及其内容
  var text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // 移除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // 提取 title
  var titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var title = titleMatch ? titleMatch[1].trim() : '';
  // 提取 meta description
  var descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
  var desc = descMatch ? descMatch[1].trim() : '';
  // 转换常见块元素为换行
  text = text.replace(/<\/(?:p|div|h[1-6]|li|tr|br|blockquote)>/gi, '\n');
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  // 移除所有 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ');
  // 解码 HTML 实体
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n)); });
  // 清理空白
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/^\s+|\s+$/gm, '');
  text = text.trim();
  // 拼接标题和描述
  var result = '';
  if (title) result += '标题: ' + title + '\n';
  if (desc) result += '摘要: ' + desc + '\n';
  if (result) result += '\n';
  result += text;
  return result;
}

// ===== 工具实现 =====
const tools = {
  read_file: {
    description: '读取指定文件的内容',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' }
      },
      required: ['file_path']
    },
    handler: async (params) => {
      const { file_path } = params;
      if (!isPathAllowed(file_path)) {
        return `❌ 错误：无权访问该路径 (${file_path})`;
      }
      if (!fs.existsSync(file_path)) {
        return `❌ 错误：文件不存在 (${file_path})`;
      }
      try {
        const content = fs.readFileSync(file_path, 'utf8');
        return `✅ 文件内容：\n${content}`;
      } catch (err) {
        return `❌ 读取失败：${err.message}`;
      }
    }
  },
  write_file: {
    description: '将内容写入指定文件（覆盖原有内容）',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' },
        content: { type: 'string', description: '要写入的内容' }
      },
      required: ['file_path', 'content']
    },
    handler: async (params) => {
      const { file_path, content } = params;
      if (!isPathAllowed(file_path)) {
        return `❌ 错误：无权访问该路径 (${file_path})`;
      }
      // 🔧 权限检查（审计 + 询问模式拦截）
      if (Core && Core.permissions && Core.permissions.checkFileWrite) {
        var check = Core.permissions.checkFileWrite(file_path, content);
        if (!check.allowed) return '⛔ ' + check.reason;
      }
      try {
        // 确保目录存在
        const dir = path.dirname(file_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // 写入前备份（如果文件已存在）
        if (fs.existsSync(file_path)) {
          try {
            var backupDir = path.join(Core ? (Core.DATA_ROOT || Core._globalDataRoot || '.') : '.', 'tmp', 'file-backups');
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            var backupName = path.basename(file_path) + '.' + Date.now() + '.bak';
            fs.copyFileSync(file_path, path.join(backupDir, backupName));
          } catch(be) { /* 备份失败不阻止写入 */ }
        }
        fs.writeFileSync(file_path, content, 'utf8');
        return `✅ 文件写入成功：${file_path}`;
      } catch (err) {
        return `❌ 写入失败：${err.message}`;
      }
    }
  },
  list_dir: {
    description: '列出指定目录下的文件和子目录',
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: '目录的绝对路径' }
      },
      required: ['dir_path']
    },
    handler: async (params) => {
      const { dir_path } = params;
      if (!isPathAllowed(dir_path)) {
        return `❌ 错误：无权访问该路径 (${dir_path})`;
      }
      if (!fs.existsSync(dir_path)) {
        return `❌ 错误：目录不存在 (${dir_path})`;
      }
      try {
        const items = fs.readdirSync(dir_path);
        return `✅ 目录内容：\n${items.join('\n')}`;
      } catch (err) {
        return `❌ 读取失败：${err.message}`;
      }
    }
  },
  run_command: {
    description: '执行一条系统命令（需用户确认）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' }
      },
      required: ['command']
    },
    handler: async (params) => {
      const { command } = params;
      // 严格白名单限制
      const allowedPrefixes = ['echo', 'ls', 'dir', 'whoami', 'date', 'time', 'python --version',
        'where', 'find', 'type ', 'tasklist', 'systeminfo', 'ipconfig', 'netstat', 'hostname',
        'ver', 'wmic ', 'powershell -Command', 'cmd /c echo'];
      if (!allowedPrefixes.some(p => command.trim().startsWith(p))) {
        return `❌ 错误：命令 "${command}" 不在白名单中（仅允许：${allowedPrefixes.join(', ')}）`;
      }
      // 🔧 权限检查（询问模式 + 审计日志）
      if (Core && Core.permissions && Core.permissions.checkCommandExec) {
        var check = Core.permissions.checkCommandExec(command);
        if (!check.allowed) return '⛔ ' + check.reason;
      }
      // 用户确认（全权模式下也确认，询问模式由 permissions 模块处理）
      //  Agent 自动执行时跳过确认对话框，避免阻塞
      var isInAgentLoop = !!(Core && Core._agentRunning);
      if (!isInAgentLoop && (!Core || !Core.permissions || Core.permissions.getMode() === 'full')) {
        if (!confirm(`是否执行命令？\n${command}`)) {
          return ' 用户取消执行';
        }
      }
      return new Promise((resolve) => {
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
          if (error) {
            resolve(`❌ 执行失败：${error.message}\n${stderr}`);
          } else {
            resolve(`✅ 执行结果：\n${stdout || stderr}`);
          }
        });
      });
    }
  },
  run_python: {
    description: '执行Python代码并返回运行结果（支持数据分析、计算、图表生成等）',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的Python代码（完整代码字符串）' }
      },
      required: ['code']
    },
    handler: async (params) => {
      const { code } = params;
      if (!code || !code.trim()) {
        return '❌ 错误：Python代码为空';
      }
      // 安全检查：禁止危险操作
      const forbidden = ['os.system', 'subprocess.call', 'subprocess.run', 'subprocess.Popen', '__import__', 'eval(', 'exec(', 'compile(', 'open('];
      for (const f of forbidden) {
        if (code.includes(f)) {
          return `❌ 安全限制：代码中包含禁止的操作 "${f}"`;
        }
      }
      // 🔧 权限检查（询问模式 + 审计日志）
      if (Core && Core.permissions && Core.permissions.checkPythonExec) {
        var check = Core.permissions.checkPythonExec(code);
        if (!check.allowed) return '⛔ ' + check.reason;
      }
      // 写入临时文件执行（避免命令行注入）
      const dataRoot = (Core && Core._globalDataRoot) || getAllowedDirs()[0] || process.cwd();
      const tmpDir = path.join(dataRoot, 'python_tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, 'script_' + Date.now() + '.py');
      try {
        fs.writeFileSync(tmpFile, code, 'utf8');
        return new Promise((resolve) => {
          exec(`python "${tmpFile}"`, { timeout: 30000, cwd: tmpDir }, (error, stdout, stderr) => {
            // 清理临时文件
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            if (error) {
              resolve(`❌ Python执行错误：\n${stderr || error.message}`);
            } else {
              const output = stdout || stderr || '（无输出）';
              // 截断过长输出
              const MAX_LEN = 3000;
              const result = output.length > MAX_LEN
                ? output.substring(0, MAX_LEN) + '\n...（输出已截断，共' + output.length + '字符）'
                : output;
              resolve(`✅ Python执行结果：\n${result}`);
            }
          });
        });
      } catch (err) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        return `❌ 执行失败：${err.message}`;
      }
    }
  },

  // ===== 增强文件操作工具 =====

  search_files: {
    description: '在指定目录中搜索文件（支持文件名模式匹配和内容搜索）',
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: '搜索的根目录' },
        pattern: { type: 'string', description: '文件名匹配模式（支持 * 通配符，如 *.js、test_*）' },
        content_search: { type: 'string', description: '（可选）在文件内容中搜索的关键词' },
        max_depth: { type: 'number', description: '（可选）最大递归深度，默认 3' },
        max_results: { type: 'number', description: '（可选）最大结果数，默认 50' }
      },
      required: ['dir_path']
    },
    handler: async (params) => {
      const { dir_path, pattern, content_search, max_depth = 3, max_results = 50 } = params;
      if (!isPathAllowed(dir_path)) {
        return '❌ 错误：无权访问该路径 (' + dir_path + ')';
      }
      if (!fs.existsSync(dir_path)) {
        return '❌ 错误：目录不存在 (' + dir_path + ')';
      }

      // 通配符转正则
      function globToRegex(glob) {
        if (!glob) return null;
        var re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp('^' + re + '$', 'i');
      }

      var nameRegex = globToRegex(pattern);
      var results = [];
      var scanned = 0;

      function scanDir(dir, depth) {
        if (depth > max_depth || results.length >= max_results) return;
        try {
          var entries = fs.readdirSync(dir, { withFileTypes: true });
          for (var i = 0; i < entries.length && results.length < max_results; i++) {
            var entry = entries[i];
            var fullPath = path.join(dir, entry.name);
            scanned++;

            if (entry.isDirectory()) {
              // 跳过隐藏目录和 node_modules
              if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
              scanDir(fullPath, depth + 1);
            } else if (entry.isFile()) {
              var nameMatch = !nameRegex || nameRegex.test(entry.name);
              if (!nameMatch) continue;

              // 内容搜索
              if (content_search) {
                try {
                  var ext = path.extname(entry.name).toLowerCase();
                  var textExts = ['.js','.ts','.json','.md','.txt','.html','.css','.py','.java','.c','.cpp','.h','.xml','.yml','.yaml','.sh','.bat','.cfg','.ini','.env','.log','.csv','.jsx','.tsx','.vue','.go','.rs','.rb','.php','.sql','.toml'];
                  if (textExts.indexOf(ext) < 0) continue; // 跳过二进制
                  var content = fs.readFileSync(fullPath, 'utf8');
                  var idx = content.indexOf(content_search);
                  if (idx < 0) continue;
                  // 提取匹配行上下文
                  var lines = content.substring(0, idx).split('\n');
                  var lineNum = lines.length;
                  var lineContent = (content.split('\n')[lineNum - 1] || '').trim();
                  results.push({
                    path: fullPath,
                    size: entry.size || fs.statSync(fullPath).size,
                    line: lineNum,
                    match: lineContent.substring(0, 100),
                  });
                } catch (e) { /* 跳过不可读文件 */ }
              } else {
                try {
                  var stat = fs.statSync(fullPath);
                  results.push({
                    path: fullPath,
                    size: stat.size,
                    modified: stat.mtime.toISOString().substring(0, 19).replace('T', ' '),
                  });
                } catch (e) {}
              }
            }
          }
        } catch (e) { /* 跳过无权限目录 */ }
      }

      scanDir(dir_path, 0);

      if (results.length === 0) {
        return '🔍 未找到匹配文件（扫描了 ' + scanned + ' 个文件）';
      }

      var output = '🔍 找到 ' + results.length + ' 个结果（扫描了 ' + scanned + ' 个文件）\n\n';
      results.forEach(function(r, i) {
        var relPath = path.relative(dir_path, r.path);
        var sizeStr = r.size < 1024 ? r.size + 'B' : r.size < 1048576 ? (r.size / 1024).toFixed(1) + 'KB' : (r.size / 1048576).toFixed(1) + 'MB';
        output += (i + 1) + '. ' + relPath + ' (' + sizeStr + ')';
        if (r.line) output += ' [行 ' + r.line + ': ' + r.match + ']';
        else if (r.modified) output += ' [修改: ' + r.modified + ']';
        output += '\n';
      });
      if (results.length >= max_results) {
        output += '\n⚠️ 结果已达上限 (' + max_results + ')，可增大 max_results 参数';
      }
      return output;
    }
  },

  edit_file: {
    description: '编辑文件内容（查找并替换指定文本）',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' },
        old_text: { type: 'string', description: '要被替换的原文本（必须精确匹配）' },
        new_text: { type: 'string', description: '替换后的新文本' },
        replace_all: { type: 'boolean', description: '（可选）是否替换所有匹配项，默认 false 只替换第一个' }
      },
      required: ['file_path', 'old_text', 'new_text']
    },
    handler: async (params) => {
      const { file_path, old_text, new_text, replace_all } = params;
      if (!isPathAllowed(file_path)) {
        return '❌ 错误：无权访问该路径 (' + file_path + ')';
      }
      if (!fs.existsSync(file_path)) {
        return '❌ 错误：文件不存在 (' + file_path + ')';
      }
      // 权限检查
      if (Core && Core.permissions && Core.permissions.checkFileWrite) {
        var check = Core.permissions.checkFileWrite(file_path, new_text);
        if (!check.allowed) return '⛔ ' + check.reason;
      }
      try {
        var content = fs.readFileSync(file_path, 'utf8');
        var count = 0;
        var newContent;
        if (replace_all) {
          // 替换所有匹配
          var parts = content.split(old_text);
          count = parts.length - 1;
          newContent = parts.join(new_text);
        } else {
          // 只替换第一个
          var idx = content.indexOf(old_text);
          if (idx < 0) {
            return '❌ 未找到匹配的文本:\n"' + old_text.substring(0, 100) + '"';
          }
          count = 1;
          newContent = content.substring(0, idx) + new_text + content.substring(idx + old_text.length);
        }
        if (count === 0) {
          return '❌ 未找到匹配的文本:\n"' + old_text.substring(0, 100) + '"';
        }
        // 备份原文件
        try {
          var backupDir = path.join(Core ? (Core.DATA_ROOT || Core._globalDataRoot || '.') : '.', 'tmp', 'file-backups');
          if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(file_path, path.join(backupDir, path.basename(file_path) + '.' + Date.now() + '.bak'));
        } catch(be) { console.warn('[Tools] Pre-edit backup failed:', be.message); }
        fs.writeFileSync(file_path, newContent, 'utf8');
        return '✅ 编辑成功：替换了 ' + count + ' 处匹配文本\n文件：' + file_path;
      } catch (err) {
        return '❌ 编辑失败：' + err.message;
      }
    }
  },

  file_info: {
    description: '获取文件的详细信息（大小、创建时间、修改时间、编码、行数等）',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' }
      },
      required: ['file_path']
    },
    handler: async (params) => {
      const { file_path } = params;
      if (!isPathAllowed(file_path)) {
        return '❌ 错误：无权访问该路径 (' + file_path + ')';
      }
      if (!fs.existsSync(file_path)) {
        return '❌ 错误：文件不存在 (' + file_path + ')';
      }
      try {
        var stat = fs.statSync(file_path);
        var ext = path.extname(file_path).toLowerCase();
        var info = {
          '文件名': path.basename(file_path),
          '路径': file_path,
          '扩展名': ext || '（无）',
          '类型': stat.isDirectory() ? '目录' : stat.isFile() ? '文件' : '其他',
          '大小': stat.size < 1024 ? stat.size + ' 字节'
            : stat.size < 1048576 ? (stat.size / 1024).toFixed(1) + ' KB'
            : (stat.size / 1048576).toFixed(2) + ' MB',
          '创建时间': stat.birthtime.toLocaleString('zh-CN'),
          '修改时间': stat.mtime.toLocaleString('zh-CN'),
          '访问时间': stat.atime.toLocaleString('zh-CN'),
          '权限': '0' + (stat.mode & 0o777).toString(8),
        };

        // 文本文件附加信息
        if (stat.isFile()) {
          var textExts = ['.js','.ts','.json','.md','.txt','.html','.css','.py','.java','.c','.cpp','.h','.xml','.yml','.yaml','.sh','.bat','.cfg','.ini','.log','.csv','.jsx','.tsx','.vue','.go','.rs','.rb','.php','.sql','.toml'];
          if (textExts.indexOf(ext) >= 0) {
            try {
              var content = fs.readFileSync(file_path, 'utf8');
              var lines = content.split('\n');
              info['行数'] = lines.length;
              info['字符数'] = content.length;
              // 检测编码（简单判断）
              info['编码'] = 'UTF-8';
              // 检测行尾
              var crlfCount = (content.match(/\r\n/g) || []).length;
              var lfCount = (content.match(/(?<!\r)\n/g) || []).length;
              info['行尾'] = crlfCount > lfCount ? 'CRLF (Windows)' : 'LF (Unix)';
            } catch (e) { info['内容'] = '无法读取'; }
          }
        }

        // 目录附加信息
        if (stat.isDirectory()) {
          try {
            var items = fs.readdirSync(file_path);
            var files = 0, dirs = 0;
            items.forEach(function(item) {
              var p = path.join(file_path, item);
              try { if (fs.statSync(p).isDirectory()) dirs++; else files++; } catch(e) {}
            });
            info['文件数'] = files;
            info['子目录数'] = dirs;
            info['项目总数'] = items.length;
          } catch (e) {}
        }

        var output = '📋 文件信息\n\n';
        Object.keys(info).forEach(function(key) {
          output += key + '：' + info[key] + '\n';
        });
        return output;
      } catch (err) {
        return '❌ 获取文件信息失败：' + err.message;
      }
    }
  },

  batch_operations: {
    description: '批量文件操作（重命名、移动、复制），支持通配符匹配',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: '操作类型：rename（重命名）、copy（复制）、move（移动）' },
        source_dir: { type: 'string', description: '源目录路径' },
        pattern: { type: 'string', description: '文件名匹配模式（支持 * 通配符）' },
        target: { type: 'string', description: '目标（rename: 替换模板如 {name}_backup{ext}；copy/move: 目标目录）' },
        dry_run: { type: 'boolean', description: '（可选）仅预览不执行，默认 true' }
      },
      required: ['operation', 'source_dir', 'pattern']
    },
    handler: async (params) => {
      const { operation, source_dir, pattern, target, dry_run = true } = params;
      if (!isPathAllowed(source_dir)) {
        return '❌ 错误：无权访问源目录 (' + source_dir + ')';
      }
      if (target && (operation === 'copy' || operation === 'move') && !isPathAllowed(target)) {
        return '❌ 错误：无权访问目标路径 (' + target + ')';
      }
      if (!fs.existsSync(source_dir)) {
        return '❌ 错误：源目录不存在 (' + source_dir + ')';
      }
      // 权限检查（非 dry_run）
      if (!dry_run && Core && Core.permissions && Core.permissions.askPermission) {
        var allowed = Core.permissions.askPermission('批量' + operation, source_dir, '模式: ' + pattern + ', 目标: ' + (target || ''));
        if (!allowed) return '⛔ 用户取消批量操作';
      }

      // 通配符匹配
      var globRe = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      var regex = new RegExp('^' + globRe + '$', 'i');

      try {
        var entries = fs.readdirSync(source_dir);
        var matched = entries.filter(function(name) { return regex.test(name); });

        if (matched.length === 0) {
          return '🔍 未找到匹配 "' + pattern + '" 的文件（共 ' + entries.length + ' 个文件）';
        }

        var plan = [];
        matched.forEach(function(name) {
          var ext = path.extname(name);
          var baseName = path.basename(name, ext);
          var srcPath = path.join(source_dir, name);
          var destPath;

          if (operation === 'rename') {
            // 模板替换: {name} = 不含扩展名, {ext} = 扩展名, {NAME} = 大写
            var newName = (target || '{name}_new{ext}')
              .replace(/\{name\}/g, baseName)
              .replace(/\{ext\}/g, ext)
              .replace(/\{NAME\}/g, baseName.toUpperCase())
              .replace(/\{n\}/g, plan.length + 1);
            destPath = path.join(source_dir, newName);
          } else {
            // copy / move → target 是目录
            var targetDir = target || source_dir;
            if (!fs.existsSync(targetDir) && !dry_run) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
            destPath = path.join(targetDir, name);
          }

          plan.push({ src: srcPath, dest: destPath, name: name });
        });

        // 预览输出
        var opNames = { rename: '重命名', copy: '复制', move: '移动' };
        var output = (dry_run ? '🔍 预览' : '⚡ 执行') + '：批量' + (opNames[operation] || operation) + '（' + plan.length + ' 个文件）\n\n';
        plan.forEach(function(item, i) {
          var srcRel = path.relative(source_dir, item.src);
          var destRel = operation === 'rename' ? path.basename(item.dest) : path.relative(source_dir, item.dest);
          output += (i + 1) + '. ' + srcRel + ' → ' + destRel + '\n';
        });

        if (dry_run) {
          output += '\n💡 这是预览模式。设置 dry_run=false 执行实际操作。';
          return output;
        }

        // 执行操作
        var success = 0, errors = [];
        for (var i = 0; i < plan.length; i++) {
          try {
            if (operation === 'copy') {
              fs.copyFileSync(plan[i].src, plan[i].dest);
            } else {
              fs.renameSync(plan[i].src, plan[i].dest);
            }
            success++;
          } catch (e) {
            errors.push(plan[i].name + ': ' + e.message);
          }
        }

        output += '\n✅ 成功: ' + success + ' 个';
        if (errors.length > 0) {
          output += '\n❌ 失败: ' + errors.length + ' 个\n' + errors.join('\n');
        }
        return output;
      } catch (err) {
        return '❌ 批量操作失败：' + err.message;
      }
    }
  },

  read_url: {
    description: '抓取网页内容并提取纯文本（支持 http/https URL）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        max_length: { type: 'number', description: '（可选）最大返回字符数，默认 5000' }
      },
      required: ['url']
    },
    handler: async (params) => {
      const { url, max_length = 5000 } = params;
      if (!url) return '❌ 错误：URL 为空';

      // 验证 URL
      var parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { return '❌ 无效的 URL: ' + url; }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return '❌ 仅支持 http/https 协议';
      }

      return new Promise(function(resolve) {
        var client = parsedUrl.protocol === 'https:' ? https : http;
        var options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          timeout: 15000,
        };

        var req = client.request(options, function(res) {
          // 处理重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve('🔄 重定向到: ' + res.headers.location + '\n请重新请求该 URL');
            return;
          }
          if (res.statusCode !== 200) {
            resolve('❌ HTTP ' + res.statusCode + ' ' + (res.statusMessage || ''));
            return;
          }

          var chunks = [];
          var totalSize = 0;
          var MAX_DOWNLOAD = 500000; // 500KB

          res.on('data', function(chunk) {
            totalSize += chunk.length;
            if (totalSize < MAX_DOWNLOAD) chunks.push(chunk);
          });

          res.on('end', function() {
            try {
              var html = Buffer.concat(chunks).toString('utf8');
              var text = extractTextFromHtml(html);

              // 截断
              if (text.length > max_length) {
                text = text.substring(0, max_length) + '\n\n...（内容已截断，共 ' + text.length + ' 字符）';
              }

              resolve('🌐 网页内容: ' + url + '\n\n' + text);
            } catch (e) {
              resolve('❌ 解析网页失败: ' + e.message);
            }
          });

          res.on('error', function(e) { resolve('❌ 读取响应失败: ' + e.message); });
        });

        req.on('error', function(e) { resolve('❌ 请求失败: ' + e.message); });
        req.on('timeout', function() { req.destroy(); resolve('❌ 请求超时 (15s)'); });
        req.end();
      });
    }
  },

  // ===== 浏览器自动化工具 =====
  browser_navigate: {
    description: '打开浏览器并导航到指定URL，支持渲染JavaScript页面',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的网页URL（http或https）' },
        wait_after: { type: 'number', description: '（可选）页面加载后额外等待毫秒数，默认1500' }
      },
      required: ['url']
    },
    handler: async (params) => {
      if (!Core.browser || !Core.browser.isAvailable()) {
        return '❌ 浏览器自动化模块不可用';
      }
      return await Core.browser.navigate(params.url, { waitAfter: params.wait_after });
    }
  },

  browser_screenshot: {
    description: '截取当前浏览器页面的屏幕截图，返回base64图片',
    parameters: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: '（可选）是否截取完整页面，默认false' },
        quality: { type: 'number', description: '（可选）JPEG质量1-100，默认80' }
      },
      required: []
    },
    handler: async (params) => {
      if (!Core.browser || !Core.browser.isOpen()) {
        return '❌ 浏览器未打开，请先使用 browser_navigate 打开网页';
      }
      return await Core.browser.screenshot({ fullPage: params.full_page, quality: params.quality });
    }
  },

  browser_click: {
    description: '点击当前浏览器页面中匹配CSS选择器的元素',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS选择器，例如 #submit-btn, .nav-link, button.login' }
      },
      required: ['selector']
    },
    handler: async (params) => {
      if (!Core.browser || !Core.browser.isOpen()) {
        return '❌ 浏览器未打开，请先使用 browser_navigate 打开网页';
      }
      return await Core.browser.click(params.selector);
    }
  },

  browser_type: {
    description: '在当前浏览器页面中向匹配CSS选择器的输入框输入文本',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框的CSS选择器' },
        text: { type: 'string', description: '要输入的文本内容' },
        clear: { type: 'boolean', description: '（可选）输入前是否清空，默认true' }
      },
      required: ['selector', 'text']
    },
    handler: async (params) => {
      if (!Core.browser || !Core.browser.isOpen()) {
        return '❌ 浏览器未打开，请先使用 browser_navigate 打开网页';
      }
      return await Core.browser.type(params.selector, params.text, { clear: params.clear });
    }
  },

  browser_extract: {
    description: '从当前浏览器页面提取文本内容、HTML源码、链接列表、表单数据或页面元信息',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '提取类型: text, html, links, forms, info', enum: ['text', 'html', 'links', 'forms', 'info'] },
        selector: { type: 'string', description: '（可选）CSS选择器，仅提取匹配元素的内容' }
      },
      required: ['type']
    },
    handler: async (params) => {
      if (!Core.browser || !Core.browser.isOpen()) {
        return '❌ 浏览器未打开，请先使用 browser_navigate 打开网页';
      }
      const type = params.type || 'text';
      if (type === 'text') return await Core.browser.getText(params.selector);
      if (type === 'html') return await Core.browser.getHtml(params.selector);
      if (type === 'links') return await Core.browser.getLinks();
      if (type === 'forms') return await Core.browser.getForms();
      if (type === 'info') return await Core.browser.getInfo();
      return '❌ 不支持的提取类型: ' + type;
    }
  },

  browser_wait: {
    description: '等待指定毫秒数或等待页面中某个元素出现',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: '等待毫秒数' },
        selector: { type: 'string', description: '（可选）等待此CSS选择器对应的元素出现' },
        timeout: { type: 'number', description: '（可选）等待元素的最大毫秒数，默认10000' }
      },
      required: []
    },
    handler: async (params) => {
      if (!Core.browser || !Core.browser.isOpen()) {
        return '❌ 浏览器未打开，请先使用 browser_navigate 打开网页';
      }
      return await Core.browser.wait({ ms: params.ms, selector: params.selector, timeout: params.timeout });
    }
  },

  // ===== GitHub 工具 =====
  github_pr: {
    description: 'GitHub Pull Request 操作：list(列出), view(查看), create(创建), diff(差异), merge(合并), checks(CI状态)',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作: list, view, create, diff, merge, checks', enum: ['list', 'view', 'create', 'diff', 'merge', 'checks'] },
        number: { type: 'number', description: 'PR 编号（view/diff/merge/checks 必须）' },
        title: { type: 'string', description: 'PR 标题（create 时使用）' },
        body: { type: 'string', description: 'PR 描述（create 时使用）' },
        draft: { type: 'boolean', description: '是否创建为草稿 PR' }
      },
      required: ['action']
    },
    handler: async (params) => {
      if (!Core.github) return '❌ GitHub 模块未加载';
      if (!Core.github.isAvailable()) return '❌ gh CLI 未安装';
      if (!Core.github.isAuthenticated()) return '❌ gh 未登录，请运行 gh auth login';
      try {
        if (params.action === 'list') return JSON.stringify(await Core.github.prList());
        if (params.action === 'view') return JSON.stringify(await Core.github.prView(params.number));
        if (params.action === 'create') return await Core.github.prCreate({ title: params.title, body: params.body, draft: params.draft, fill: !params.title });
        if (params.action === 'diff') return await Core.github.prDiff(params.number);
        if (params.action === 'merge') return await Core.github.prMerge(params.number, { squash: true });
        if (params.action === 'checks') return await Core.github.prChecks(params.number);
        return '❌ 未知 PR 操作: ' + params.action;
      } catch (e) { return '❌ GitHub PR 错误: ' + e.message; }
    }
  },

  github_issue: {
    description: 'GitHub Issue 操作：list(列出), view(查看), create(创建), close(关闭), comment(评论)',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作: list, view, create, close, comment', enum: ['list', 'view', 'create', 'close', 'comment'] },
        number: { type: 'number', description: 'Issue 编号（view/close/comment 必须）' },
        title: { type: 'string', description: 'Issue 标题（create 时使用）' },
        body: { type: 'string', description: 'Issue 内容（create 时使用）' },
        comment: { type: 'string', description: '评论内容（comment 时使用）' }
      },
      required: ['action']
    },
    handler: async (params) => {
      if (!Core.github) return '❌ GitHub 模块未加载';
      if (!Core.github.isAvailable()) return '❌ gh CLI 未安装';
      if (!Core.github.isAuthenticated()) return '❌ gh 未登录';
      try {
        if (params.action === 'list') return JSON.stringify(await Core.github.issueList());
        if (params.action === 'view') return JSON.stringify(await Core.github.issueView(params.number));
        if (params.action === 'create') return await Core.github.issueCreate({ title: params.title, body: params.body });
        if (params.action === 'close') { await Core.github.issueClose(params.number); return '✅ Issue #' + params.number + ' 已关闭'; }
        if (params.action === 'comment') { await Core.github.issueComment(params.number, params.comment); return '💬 已评论 Issue #' + params.number; }
        return '❌ 未知 Issue 操作: ' + params.action;
      } catch (e) { return '❌ GitHub Issue 错误: ' + e.message; }
    }
  },

  github_repo: {
    description: '查看当前 GitHub 仓库信息（名称、描述、Star、Fork、默认分支）',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      if (!Core.github) return '❌ GitHub 模块未加载';
      if (!Core.github.isAvailable()) return '❌ gh CLI 未安装';
      try {
        return JSON.stringify(await Core.github.repoView());
      } catch (e) { return '❌ GitHub 仓库错误: ' + e.message; }
    }
  },

  github_release: {
    description: 'GitHub Release 操作：list(列出), create(创建)',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作: list, create', enum: ['list', 'create'] },
        tag: { type: 'string', description: '版本号标签（create 时必须，如 v1.0.0）' },
        title: { type: 'string', description: 'Release 标题' },
        notes: { type: 'string', description: 'Release 说明' }
      },
      required: ['action']
    },
    handler: async (params) => {
      if (!Core.github) return '❌ GitHub 模块未加载';
      if (!Core.github.isAvailable()) return '❌ gh CLI 未安装';
      try {
        if (params.action === 'list') return await Core.github.releaseList();
        if (params.action === 'create') return await Core.github.releaseCreate(params.tag, { title: params.title, notes: params.notes, generateNotes: true });
        return '❌ 未知 Release 操作: ' + params.action;
      } catch (e) { return '❌ GitHub Release 错误: ' + e.message; }
    }
  },

  // ===== 图片搜索 =====
  image_search: {
    description: '搜索网络图片，支持 DuckDuckGo、Bing、Unsplash 三个引擎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        provider: { type: 'string', description: '搜索引擎: duckduckgo/bing/unsplash' },
        count: { type: 'number', description: '返回数量，默认5' },
      },
      required: ['query'],
    },
    handler: async function (params) {
      if (!Core.imageSearch) return '❌ 图片搜索模块未加载';
      try {
        var results = await Core.imageSearch.search(params.query, {
          provider: params.provider,
          count: params.count || 5,
        });
        if (results.length === 0) return '未找到相关图片';
        return { results: results, count: results.length };
      } catch (e) { return '❌ 图片搜索失败: ' + e.message; }
    },
  },

  image_download: {
    description: '下载网络图片到本地文件',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片URL' },
        dest: { type: 'string', description: '本地保存路径' },
      },
      required: ['url', 'dest'],
    },
    handler: async function (params) {
      if (!Core.imageSearch) return '❌ 图片搜索模块未加载';
      try {
        var result = await Core.imageSearch.download(params.url, params.dest);
        return result;
      } catch (e) { return '❌ 图片下载失败: ' + e.message; }
    },
  },
};

// ===== 获取工具定义（用于 Ollama API） =====
function getToolDefinitions() {
  return Object.entries(tools).map(([name, def]) => ({
    type: 'function',
    function: {
      name: name,
      description: def.description,
      parameters: def.parameters
    }
  }));
}

// ===== 执行工具 =====
async function executeTool(toolName, params) {
  const tool = tools[toolName];
  if (!tool) throw new Error(`未知工具：${toolName}`);
  return await tool.handler(params);
}

module.exports = {
  name: 'tools',
  dependencies: [],
  init(_Core) {
    Core = _Core;
    Core.toolsRegistry = {
      getToolDefinitions,
      executeTool,
      listTools: () => Object.keys(tools)
    };
    console.log('✅ 工具注册表已加载（MCP 基础 + 增强，共 ' + Object.keys(tools).length + ' 个工具）');
  }
};