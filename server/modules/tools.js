// server/modules/tools.js - Agent 工具执行引擎（服务端版）
var fs = require('fs');
var path = require('path');
var exec = require('child_process').exec;
var http = require('http');
var https = require('https');
var URL = require('url').URL;

var Core = null;

// ===== 路径权限 =====
function getAllowedDirs() {
  var dirs = [process.cwd()];
  if (Core) {
    if (Core.DATA_ROOT) dirs.push(Core.DATA_ROOT);
    if (Core.USERS_ROOT) dirs.push(Core.USERS_ROOT);
  }
  var appRoot = path.resolve(__dirname, '..');
  if (dirs.indexOf(appRoot) === -1) dirs.push(appRoot);
  try {
    var os = require('os');
    dirs.push(path.join(os.homedir(), 'Desktop'));
  } catch(e) {}
  return dirs;
}

function isPathAllowed(filePath) {
  var resolved = path.resolve(filePath);
  var allowedDirs = getAllowedDirs();
  for (var i = 0; i < allowedDirs.length; i++) {
    if (resolved.startsWith(path.resolve(allowedDirs[i]))) return true;
  }
  return false;
}

// ===== HTML 文本提取 =====
function extractTextFromHtml(html) {
  if (!html) return '';
  var text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  var titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var title = titleMatch ? titleMatch[1].trim() : '';
  var descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
  var desc = descMatch ? descMatch[1].trim() : '';
  text = text.replace(/<\/(?:p|div|h[1-6]|li|tr|br|blockquote)>/gi, '\n');
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n)); });
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/^\s+|\s+$/gm, '');
  text = text.trim();
  var result = '';
  if (title) result += 'Title: ' + title + '\n';
  if (desc) result += 'Summary: ' + desc + '\n';
  if (result) result += '\n';
  result += text;
  return result;
}

// ===== 工具实现 =====
var tools = {
  read_file: {
    description: '读取指定文件的内容',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' }
      },
      required: ['file_path']
    },
    handler: async function(params) {
      var filePath = params.file_path;
      if (!isPathAllowed(filePath)) {
        return '[ERROR] 无权访问该路径 (' + filePath + ')';
      }
      if (!fs.existsSync(filePath)) {
        return '[ERROR] 文件不存在 (' + filePath + ')';
      }
      try {
        var content = fs.readFileSync(filePath, 'utf8');
        return '[OK] 文件内容：\n' + content;
      } catch (err) {
        return '[ERROR] 读取失败：' + err.message;
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
    handler: async function(params) {
      var filePath = params.file_path;
      var content = params.content;
      if (!isPathAllowed(filePath)) {
        return '[ERROR] 无权访问该路径 (' + filePath + ')';
      }
      try {
        var dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // 写入前备份
        if (fs.existsSync(filePath)) {
          try {
            var backupDir = path.join(Core ? (Core.DATA_ROOT || '.') : '.', 'tmp', 'file-backups');
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            var backupName = path.basename(filePath) + '.' + Date.now() + '.bak';
            fs.copyFileSync(filePath, path.join(backupDir, backupName));
          } catch(be) { /* backup failure non-fatal */ }
        }
        fs.writeFileSync(filePath, content, 'utf8');
        return '[OK] 文件写入成功：' + filePath;
      } catch (err) {
        return '[ERROR] 写入失败：' + err.message;
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
    handler: async function(params) {
      var dirPath = params.dir_path;
      if (!isPathAllowed(dirPath)) {
        return '[ERROR] 无权访问该路径 (' + dirPath + ')';
      }
      if (!fs.existsSync(dirPath)) {
        return '[ERROR] 目录不存在 (' + dirPath + ')';
      }
      try {
        var items = fs.readdirSync(dirPath);
        return '[OK] 目录内容：\n' + items.join('\n');
      } catch (err) {
        return '[ERROR] 读取失败：' + err.message;
      }
    }
  },

  run_command: {
    description: '执行一条系统命令',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' }
      },
      required: ['command']
    },
    handler: async function(params) {
      var command = params.command;
      // Guardrails check
      if (Core.guardrails) {
        var check = Core.guardrails.checkToolExecution('run_command', { command: command });
        if (!check.safe) return '[BLOCKED] ' + check.reason;
      }
      // Whitelist restriction
      var allowedPrefixes = ['echo', 'ls', 'dir', 'whoami', 'date', 'time', 'python --version', 'node --version', 'git status', 'git log'];
      var trimmed = command.trim();
      var allowed = false;
      for (var i = 0; i < allowedPrefixes.length; i++) {
        if (trimmed.startsWith(allowedPrefixes[i])) { allowed = true; break; }
      }
      if (!allowed) {
        return '[ERROR] 命令不在白名单中 (' + command + ')';
      }
      return new Promise(function(resolve) {
        exec(command, { timeout: 10000 }, function(error, stdout, stderr) {
          if (error) {
            resolve('[ERROR] 执行失败：' + error.message + '\n' + stderr);
          } else {
            resolve('[OK] 执行结果：\n' + (stdout || stderr));
          }
        });
      });
    }
  },

  run_python: {
    description: '执行Python代码并返回运行结果',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的Python代码' }
      },
      required: ['code']
    },
    handler: async function(params) {
      var code = params.code;
      if (!code || !code.trim()) {
        return '[ERROR] Python代码为空';
      }
      // Safety check
      var forbidden = ['os.system', 'subprocess.call', 'subprocess.run', 'subprocess.Popen', '__import__', 'eval(', 'exec(', 'compile('];
      for (var i = 0; i < forbidden.length; i++) {
        if (code.includes(forbidden[i])) {
          return '[ERROR] 安全限制：代码中包含禁止的操作 "' + forbidden[i] + '"';
        }
      }
      // Write temp file and execute
      var dataRoot = (Core && Core.DATA_ROOT) || process.cwd();
      var tmpDir = path.join(dataRoot, 'python_tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      var tmpFile = path.join(tmpDir, 'script_' + Date.now() + '.py');
      try {
        fs.writeFileSync(tmpFile, code, 'utf8');
        return new Promise(function(resolve) {
          exec('python "' + tmpFile + '"', { timeout: 30000, cwd: tmpDir }, function(error, stdout, stderr) {
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            if (error) {
              resolve('[ERROR] Python执行错误：\n' + (stderr || error.message));
            } else {
              var output = stdout || stderr || '(无输出)';
              var MAX_LEN = 3000;
              var result = output.length > MAX_LEN
                ? output.substring(0, MAX_LEN) + '\n...(输出已截断，共' + output.length + '字符)'
                : output;
              resolve('[OK] Python执行结果：\n' + result);
            }
          });
        });
      } catch (err) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        return '[ERROR] 执行失败：' + err.message;
      }
    }
  },

  search_files: {
    description: '在指定目录中搜索文件（支持文件名模式匹配和内容搜索）',
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: '搜索的根目录' },
        pattern: { type: 'string', description: '文件名匹配模式（支持 * 通配符）' },
        content_search: { type: 'string', description: '(可选) 在文件内容中搜索的关键词' },
        max_depth: { type: 'number', description: '(可选) 最大递归深度，默认 3' },
        max_results: { type: 'number', description: '(可选) 最大结果数，默认 50' }
      },
      required: ['dir_path']
    },
    handler: async function(params) {
      var dirPath = params.dir_path;
      var pattern = params.pattern;
      var contentSearch = params.content_search;
      var maxDepth = params.max_depth || 3;
      var maxResults = params.max_results || 50;

      if (!isPathAllowed(dirPath)) {
        return '[ERROR] 无权访问该路径 (' + dirPath + ')';
      }
      if (!fs.existsSync(dirPath)) {
        return '[ERROR] 目录不存在 (' + dirPath + ')';
      }

      function globToRegex(glob) {
        if (!glob) return null;
        var re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp('^' + re + '$', 'i');
      }

      var nameRegex = globToRegex(pattern);
      var results = [];
      var scanned = 0;

      function scanDir(dir, depth) {
        if (depth > maxDepth || results.length >= maxResults) return;
        try {
          var entries = fs.readdirSync(dir, { withFileTypes: true });
          for (var i = 0; i < entries.length && results.length < maxResults; i++) {
            var entry = entries[i];
            var fullPath = path.join(dir, entry.name);
            scanned++;
            if (entry.isDirectory()) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
              scanDir(fullPath, depth + 1);
            } else if (entry.isFile()) {
              var nameMatch = !nameRegex || nameRegex.test(entry.name);
              if (!nameMatch) continue;
              if (contentSearch) {
                try {
                  var ext = path.extname(entry.name).toLowerCase();
                  var textExts = ['.js','.ts','.json','.md','.txt','.html','.css','.py','.java','.c','.cpp','.h','.xml','.yml','.yaml','.sh','.bat'];
                  if (textExts.indexOf(ext) < 0) continue;
                  var content = fs.readFileSync(fullPath, 'utf8');
                  var idx = content.indexOf(contentSearch);
                  if (idx < 0) continue;
                  var lines = content.substring(0, idx).split('\n');
                  var lineNum = lines.length;
                  var lineContent = (content.split('\n')[lineNum - 1] || '').trim();
                  results.push({ path: fullPath, size: entry.size || 0, line: lineNum, match: lineContent.substring(0, 100) });
                } catch (e) {}
              } else {
                try {
                  var stat = fs.statSync(fullPath);
                  results.push({ path: fullPath, size: stat.size, modified: stat.mtime.toISOString().substring(0, 19).replace('T', ' ') });
                } catch (e) {}
              }
            }
          }
        } catch (e) {}
      }

      scanDir(dirPath, 0);

      if (results.length === 0) {
        return '[SEARCH] 未找到匹配文件（扫描了 ' + scanned + ' 个文件）';
      }
      var output = '[SEARCH] 找到 ' + results.length + ' 个结果（扫描了 ' + scanned + ' 个文件）\n\n';
      results.forEach(function(r, i) {
        var relPath = path.relative(dirPath, r.path);
        var sizeStr = r.size < 1024 ? r.size + 'B' : r.size < 1048576 ? (r.size / 1024).toFixed(1) + 'KB' : (r.size / 1048576).toFixed(1) + 'MB';
        output += (i + 1) + '. ' + relPath + ' (' + sizeStr + ')';
        if (r.line) output += ' [Line ' + r.line + ': ' + r.match + ']';
        else if (r.modified) output += ' [Modified: ' + r.modified + ']';
        output += '\n';
      });
      return output;
    }
  },

  edit_file: {
    description: '编辑文件内容（查找并替换指定文本）',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' },
        old_text: { type: 'string', description: '要被替换的原文本' },
        new_text: { type: 'string', description: '替换后的新文本' },
        replace_all: { type: 'boolean', description: '(可选) 是否替换所有匹配项' }
      },
      required: ['file_path', 'old_text', 'new_text']
    },
    handler: async function(params) {
      var filePath = params.file_path;
      var oldText = params.old_text;
      var newText = params.new_text;
      var replaceAll = params.replace_all;

      if (!isPathAllowed(filePath)) return '[ERROR] 无权访问该路径';
      if (!fs.existsSync(filePath)) return '[ERROR] 文件不存在';
      try {
        var content = fs.readFileSync(filePath, 'utf8');
        var count = 0;
        var newContent;
        if (replaceAll) {
          var parts = content.split(oldText);
          count = parts.length - 1;
          newContent = parts.join(newText);
        } else {
          var idx = content.indexOf(oldText);
          if (idx < 0) return '[ERROR] 未找到匹配的文本';
          count = 1;
          newContent = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
        }
        if (count === 0) return '[ERROR] 未找到匹配的文本';
        // Backup
        try {
          var backupDir = path.join(Core ? (Core.DATA_ROOT || '.') : '.', 'tmp', 'file-backups');
          if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath) + '.' + Date.now() + '.bak'));
        } catch(be) {}
        fs.writeFileSync(filePath, newContent, 'utf8');
        return '[OK] 编辑成功：替换了 ' + count + ' 处匹配文本';
      } catch (err) {
        return '[ERROR] 编辑失败：' + err.message;
      }
    }
  },

  file_info: {
    description: '获取文件的详细信息（大小、时间、行数等）',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' }
      },
      required: ['file_path']
    },
    handler: async function(params) {
      var filePath = params.file_path;
      if (!isPathAllowed(filePath)) return '[ERROR] 无权访问该路径';
      if (!fs.existsSync(filePath)) return '[ERROR] 文件不存在';
      try {
        var stat = fs.statSync(filePath);
        var ext = path.extname(filePath).toLowerCase();
        var info = {
          '文件名': path.basename(filePath),
          '路径': filePath,
          '扩展名': ext || '(无)',
          '类型': stat.isDirectory() ? '目录' : stat.isFile() ? '文件' : '其他',
          '大小': stat.size < 1024 ? stat.size + ' 字节'
            : stat.size < 1048576 ? (stat.size / 1024).toFixed(1) + ' KB'
            : (stat.size / 1048576).toFixed(2) + ' MB',
          '创建时间': stat.birthtime.toISOString(),
          '修改时间': stat.mtime.toISOString(),
        };
        if (stat.isFile()) {
          var textExts = ['.js','.ts','.json','.md','.txt','.html','.css','.py','.java','.c','.cpp','.h','.xml','.yml','.yaml'];
          if (textExts.indexOf(ext) >= 0) {
            try {
              var content = fs.readFileSync(filePath, 'utf8');
              info['行数'] = content.split('\n').length;
              info['字符数'] = content.length;
            } catch (e) {}
          }
        }
        var output = '[FILE INFO]\n';
        Object.keys(info).forEach(function(key) {
          output += key + ': ' + info[key] + '\n';
        });
        return output;
      } catch (err) {
        return '[ERROR] 获取文件信息失败：' + err.message;
      }
    }
  },

  read_url: {
    description: '抓取网页内容并提取纯文本',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        max_length: { type: 'number', description: '(可选) 最大返回字符数，默认 5000' }
      },
      required: ['url']
    },
    handler: async function(params) {
      var url = params.url;
      var maxLength = params.max_length || 5000;
      if (!url) return '[ERROR] URL 为空';
      var parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { return '[ERROR] 无效的 URL: ' + url; }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return '[ERROR] 仅支持 http/https 协议';
      }
      return new Promise(function(resolve) {
        var client = parsedUrl.protocol === 'https:' ? https : http;
        var options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          timeout: 15000,
        };
        var req = client.request(options, function(res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve('[REDIRECT] 重定向到: ' + res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            resolve('[ERROR] HTTP ' + res.statusCode);
            return;
          }
          var chunks = [];
          var totalSize = 0;
          var MAX_DOWNLOAD = 500000;
          res.on('data', function(chunk) {
            totalSize += chunk.length;
            if (totalSize < MAX_DOWNLOAD) chunks.push(chunk);
          });
          res.on('end', function() {
            try {
              var html = Buffer.concat(chunks).toString('utf8');
              var text = extractTextFromHtml(html);
              if (text.length > maxLength) {
                text = text.substring(0, maxLength) + '\n\n...(内容已截断)';
              }
              resolve('[OK] 网页内容: ' + url + '\n\n' + text);
            } catch (e) {
              resolve('[ERROR] 解析网页失败: ' + e.message);
            }
          });
          res.on('error', function(e) { resolve('[ERROR] 读取响应失败: ' + e.message); });
        });
        req.on('error', function(e) { resolve('[ERROR] 请求失败: ' + e.message); });
        req.on('timeout', function() { req.destroy(); resolve('[ERROR] 请求超时 (15s)'); });
        req.end();
      });
    }
  },
};

// ===== 获取工具定义（供 LLM API 使用）=====
function getToolDefinitions() {
  return Object.entries(tools).map(function(entry) {
    return {
      type: 'function',
      function: {
        name: entry[0],
        description: entry[1].description,
        parameters: entry[1].parameters
      }
    };
  });
}

// ===== 执行工具 =====
async function executeTool(toolName, params) {
  var tool = tools[toolName];
  if (!tool) throw new Error('未知工具：' + toolName);
  // Guardrails check
  if (Core.guardrails) {
    var check = Core.guardrails.checkToolExecution(toolName, params);
    if (!check.safe) return '[BLOCKED] ' + check.reason;
  }
  return await tool.handler(params);
}

module.exports = {
  name: 'tools',
  dependencies: ['guardrails'],
  init: function(_Core, router) {
    Core = _Core;

    // Register WebSocket handlers
    if (router) {
      router.handle('tool.list', function() {
        return { tools: Object.keys(tools) };
      });
      router.handle('tool.definitions', function() {
        return { definitions: getToolDefinitions() };
      });
      router.handle('tool.execute', async function(params) {
        try {
          var result = await executeTool(params.name, params.arguments || {});
          return { success: true, result: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      });
    }

    // Expose on Core
    Core.toolsRegistry = {
      getToolDefinitions: getToolDefinitions,
      executeTool: executeTool,
      listTools: function() { return Object.keys(tools); }
    };
    console.log('[tools] loaded (' + Object.keys(tools).length + ' tools)');
  }
};
