// node-agent.js — 桌面端远程执行节点代理
// 将本机注册为 AI Agent Server 的执行节点，服务端 Agent 的工具调用
// （文件读写/Shell/Python 等）可路由到本机执行。
//
// 用法：
//   node node-agent.js                          (默认连接 ws://127.0.0.1:3847)
//   node node-agent.js --server ws://IP:3847    (连接指定服务端)
//
// 也可被 require：const { NodeAgent } = require('./node-agent');
const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ===== 配置 =====
function parseArgs() {
  var args = process.argv.slice(2);
  var cfg = { serverUrl: process.env.AI_SERVER_URL || 'ws://127.0.0.1:3847' };
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) cfg.serverUrl = args[i + 1];
  }
  return cfg;
}

// ===== 安全层（🔧 P1-1: 规则收敛到 shared/guardrails-rules.js 单一事实源，与主进程/独立 server 一致）=====
var RULES = require('./shared/guardrails-rules');

// 路径白名单：节点只服务这些目录下的文件操作（node-agent 专属，非共享规则）
function getAllowedDirs() {
  var dirs = ['E:/'];
  try { dirs.push(os.homedir().replace(/\\/g, '/')); } catch (e) {}
  try { dirs.push(os.tmpdir().replace(/\\/g, '/')); } catch (e) {}
  return dirs;
}

function isPathAllowed(filePath) {
  var resolved = path.resolve(filePath).replace(/\\/g, '/');
  var allowed = getAllowedDirs();
  for (var i = 0; i < allowed.length; i++) {
    var dir = path.resolve(allowed[i]).replace(/\\/g, '/');
    if (resolved === dir || resolved.startsWith(dir + '/') || resolved.toLowerCase().startsWith(dir.toLowerCase() + '/')) return true;
  }
  return false;
}

// 🔧 P1-1: 受保护路径判定委托共享规则
function isProtectedPath(filePath) {
  return RULES.isProtectedPath(filePath);
}

// 🔧 P1-1: 危险命令段扫描委托共享规则（含 `git log && rm -rf x` 偷渡防护）
function checkCommand(command) {
  return RULES.scanCommand(command);
}

// ===== 工具执行器（输出格式与服务端 tools.js 一致）=====
var executors = {
  read_file: function(params) {
    var filePath = params.file_path;
    if (!isPathAllowed(filePath)) return Promise.resolve('[ERROR] 无权访问该路径 (' + filePath + ')');
    if (!fs.existsSync(filePath)) return Promise.resolve('[ERROR] 文件不存在 (' + filePath + ')');
    try {
      return Promise.resolve('[OK] 文件内容：\n' + fs.readFileSync(filePath, 'utf8'));
    } catch (err) { return Promise.resolve('[ERROR] 读取失败：' + err.message); }
  },

  write_file: function(params) {
    var filePath = params.file_path;
    if (!isPathAllowed(filePath)) return Promise.resolve('[ERROR] 无权访问该路径 (' + filePath + ')');
    if (isProtectedPath(filePath)) return Promise.resolve('[BLOCKED] 受保护路径不可写: ' + filePath);
    try {
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, params.content || '', 'utf8');
      return Promise.resolve('[OK] 文件写入成功：' + filePath);
    } catch (err) { return Promise.resolve('[ERROR] 写入失败：' + err.message); }
  },

  edit_file: function(params) {
    var filePath = params.file_path;
    if (!isPathAllowed(filePath)) return Promise.resolve('[ERROR] 无权访问该路径');
    if (isProtectedPath(filePath)) return Promise.resolve('[BLOCKED] 受保护路径不可写');
    if (!fs.existsSync(filePath)) return Promise.resolve('[ERROR] 文件不存在');
    try {
      var content = fs.readFileSync(filePath, 'utf8');
      var oldText = params.old_text, newText = params.new_text;
      var count = 0, newContent;
      if (params.replace_all) {
        var parts = content.split(oldText);
        count = parts.length - 1;
        newContent = parts.join(newText);
      } else {
        var idx = content.indexOf(oldText);
        if (idx < 0) return Promise.resolve('[ERROR] 未找到匹配的文本');
        count = 1;
        newContent = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
      }
      if (count === 0) return Promise.resolve('[ERROR] 未找到匹配的文本');
      fs.writeFileSync(filePath, newContent, 'utf8');
      return Promise.resolve('[OK] 编辑成功：替换了 ' + count + ' 处匹配文本');
    } catch (err) { return Promise.resolve('[ERROR] 编辑失败：' + err.message); }
  },

  list_dir: function(params) {
    var dirPath = params.dir_path;
    if (!isPathAllowed(dirPath)) return Promise.resolve('[ERROR] 无权访问该路径 (' + dirPath + ')');
    if (!fs.existsSync(dirPath)) return Promise.resolve('[ERROR] 目录不存在 (' + dirPath + ')');
    try {
      return Promise.resolve('[OK] 目录内容：\n' + fs.readdirSync(dirPath).join('\n'));
    } catch (err) { return Promise.resolve('[ERROR] 读取失败：' + err.message); }
  },

  file_info: function(params) {
    var filePath = params.file_path;
    if (!isPathAllowed(filePath)) return Promise.resolve('[ERROR] 无权访问该路径');
    if (!fs.existsSync(filePath)) return Promise.resolve('[ERROR] 文件不存在');
    try {
      var stat = fs.statSync(filePath);
      var output = '[FILE INFO]\n文件名: ' + path.basename(filePath) +
        '\n路径: ' + filePath +
        '\n类型: ' + (stat.isDirectory() ? '目录' : '文件') +
        '\n大小: ' + (stat.size < 1024 ? stat.size + ' 字节' : stat.size < 1048576 ? (stat.size / 1024).toFixed(1) + ' KB' : (stat.size / 1048576).toFixed(2) + ' MB') +
        '\n修改时间: ' + stat.mtime.toISOString() + '\n';
      return Promise.resolve(output);
    } catch (err) { return Promise.resolve('[ERROR] 获取文件信息失败：' + err.message); }
  },

  search_files: function(params) {
    var dirPath = params.dir_path;
    var maxDepth = params.max_depth || 3;
    var maxResults = params.max_results || 50;
    if (!isPathAllowed(dirPath)) return Promise.resolve('[ERROR] 无权访问该路径 (' + dirPath + ')');
    if (!fs.existsSync(dirPath)) return Promise.resolve('[ERROR] 目录不存在 (' + dirPath + ')');

    function globToRegex(glob) {
      if (!glob) return null;
      var re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp('^' + re + '$', 'i');
    }
    var nameRegex = globToRegex(params.pattern);
    var results = [], scanned = 0;

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
            if (nameRegex && !nameRegex.test(entry.name)) continue;
            if (params.content_search) {
              try {
                var content = fs.readFileSync(fullPath, 'utf8');
                var idx = content.indexOf(params.content_search);
                if (idx < 0) continue;
                var lineNum = content.substring(0, idx).split('\n').length;
                results.push({ path: fullPath, line: lineNum });
              } catch (e) {}
            } else {
              try { results.push({ path: fullPath, size: fs.statSync(fullPath).size }); } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }
    scanDir(dirPath, 0);

    if (results.length === 0) return Promise.resolve('[SEARCH] 未找到匹配文件（扫描了 ' + scanned + ' 个文件）');
    var output = '[SEARCH] 找到 ' + results.length + ' 个结果（扫描了 ' + scanned + ' 个文件）\n\n';
    results.forEach(function(r, i) {
      output += (i + 1) + '. ' + path.relative(dirPath, r.path);
      if (r.line) output += ' [Line ' + r.line + ']';
      output += '\n';
    });
    return Promise.resolve(output);
  },

  run_command: function(params) {
    var command = params.command;
    var check = checkCommand(command);
    if (!check.safe) return Promise.resolve('[BLOCKED] ' + check.reason);
    return new Promise(function(resolve) {
      exec(command, { timeout: 25000, maxBuffer: 1024 * 1024 }, function(error, stdout, stderr) {
        if (error) resolve('[ERROR] 执行失败：' + error.message + '\n' + (stderr || ''));
        else resolve('[OK] 执行结果：\n' + (stdout || stderr || '(无输出)'));
      });
    });
  },

  run_python: function(params) {
    var code = params.code;
    if (!code || !code.trim()) return Promise.resolve('[ERROR] Python代码为空');
    var forbidden = ['os.system', 'subprocess.call', 'subprocess.run', 'subprocess.Popen', '__import__', 'eval(', 'exec(', 'compile('];
    for (var i = 0; i < forbidden.length; i++) {
      if (code.indexOf(forbidden[i]) !== -1) {
        return Promise.resolve('[ERROR] 安全限制：代码中包含禁止的操作 "' + forbidden[i] + '"');
      }
    }
    var tmpDir = path.join(os.tmpdir(), 'node-agent-py');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    var tmpFile = path.join(tmpDir, 'script_' + Date.now() + '.py');
    try { fs.writeFileSync(tmpFile, code, 'utf8'); } catch (e) { return Promise.resolve('[ERROR] 写入临时文件失败: ' + e.message); }
    return new Promise(function(resolve) {
      exec('python "' + tmpFile + '"', { timeout: 55000, cwd: tmpDir, maxBuffer: 1024 * 1024 }, function(error, stdout, stderr) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        if (error) resolve('[ERROR] Python执行错误：\n' + (stderr || error.message));
        else {
          var output = stdout || stderr || '(无输出)';
          if (output.length > 3000) output = output.substring(0, 3000) + '\n...(输出已截断，共' + output.length + '字符)';
          resolve('[OK] Python执行结果：\n' + output);
        }
      });
    });
  },
};

// ===== 能力检测 =====
function detectCapabilities(onDone) {
  var caps = ['fs', 'shell'];
  var pending = 2;
  function done() { if (--pending === 0) onDone(caps); }
  exec('git --version', function(e) { if (!e) caps.push('git'); done(); });
  exec('python --version', function(e) { if (!e) caps.push('python'); done(); });
}

// ===== NodeAgent 主类 =====
class NodeAgent {
  constructor(options) {
    options = options || {};
    this.serverUrl = options.serverUrl || 'ws://127.0.0.1:3847';
    this.nodeId = options.nodeId || ('desktop-' + os.hostname().toLowerCase());
    this.nodeName = options.name || ('Desktop-' + os.hostname());
    this.platform = 'desktop-' + process.platform; // desktop-win32 / desktop-linux
    this.capabilities = options.capabilities || [];
    this.ws = null;
    this._closed = false;
    this._reconnectDelay = 2000;
    this._heartbeatTimer = null;
    this._stats = { executed: 0, errors: 0 };
  }

  start() {
    var self = this;
    detectCapabilities(function(caps) {
      self.capabilities = caps;
      console.log('[node-agent] 能力检测:', caps.join(', '));
      self.connect();
    });
  }

  connect() {
    var self = this;
    if (this._closed) return;

    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', function() {
      self._reconnectDelay = 2000;
      console.log('[node-agent] 已连接服务端:', self.serverUrl);
      self._register();
      self._startHeartbeat();
    });

    this.ws.on('message', function(raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      self._handleMessage(msg);
    });

    this.ws.on('close', function() {
      self._stopHeartbeat();
      if (!self._closed) {
        console.log('[node-agent] 与服务端断开，' + (self._reconnectDelay / 1000) + 's 后重连...');
        self._scheduleReconnect();
      }
    });

    this.ws.on('error', function(err) {
      // error 后必跟 close，重连由 close 处理；这里只静默记录
      if (!self._closed) console.error('[node-agent] 连接错误:', err.message);
    });
  }

  _scheduleReconnect() {
    var self = this;
    if (this._closed) return;
    setTimeout(function() { self.connect(); }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60000); // 指数退避，上限 60s
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _register() {
    this._send({
      id: 'reg_' + Date.now(),
      type: 'node.register',
      payload: {
        nodeId: this.nodeId,
        name: this.nodeName,
        platform: this.platform,
        capabilities: this.capabilities,
      }
    });
    console.log('[node-agent] 已注册为节点:', this.nodeId);
  }

  _startHeartbeat() {
    var self = this;
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(function() {
      self._send({
        type: 'node.status',
        payload: {
          nodeId: self.nodeId,
          stats: {
            cpu: os.loadavg()[0],
            memFree: Math.round(os.freemem() / 1048576) + 'MB',
            uptime: Math.round(process.uptime()),
            executed: self._stats.executed,
            errors: self._stats.errors,
          }
        }
      });
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'node.execute') {
      this._handleExecute(msg.payload || {});
    } else if (msg.type === 'result') {
      // 服务端对 register/status 的确认，静默
    } else if (msg.type === 'error') {
      console.error('[node-agent] 服务端错误:', (msg.payload && msg.payload.error) || 'unknown');
    }
  }

  async _handleExecute(payload) {
    var callId = payload.callId;
    var tool = payload.tool;
    var params = payload.params || {};

    var executor = executors[tool];
    if (!executor) {
      this._send({ type: 'node.result', payload: { callId: callId, error: '节点不支持工具: ' + tool } });
      return;
    }

    console.log('[node-agent] 执行工具:', tool, JSON.stringify(params).substring(0, 120));
    try {
      var result = await executor(params);
      this._stats.executed++;
      this._send({ type: 'node.result', payload: { callId: callId, result: result } });
      console.log('[node-agent] 完成:', tool, String(result).substring(0, 80).replace(/\n/g, ' '));
    } catch (err) {
      this._stats.errors++;
      this._send({ type: 'node.result', payload: { callId: callId, error: err.message } });
      console.error('[node-agent] 执行异常:', tool, err.message);
    }
  }

  stop() {
    this._closed = true;
    this._stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  }
}

module.exports = { NodeAgent: NodeAgent };

// ===== 直接运行时启动 =====
if (require.main === module) {
  var cfg = parseArgs();
  console.log('[node-agent] AI Agent Pro 桌面节点代理');
  console.log('[node-agent] 服务端:', cfg.serverUrl);
  var agent = new NodeAgent({ serverUrl: cfg.serverUrl });
  agent.start();

  process.on('SIGINT', function() {
    console.log('\n[node-agent] 退出...');
    agent.stop();
    process.exit(0);
  });
}
