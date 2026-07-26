// tests/preload-security.test.js - S1 preload 收口回归测试
// 验证 fsBridge 写入沙箱 + childProcessBridge 命令分级 + ipcBridge 黑名单
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// ===== 从 preload.js 提取安全逻辑进行单元测试 =====
// 由于 preload.js 依赖 Electron API（contextBridge 等），无法直接 require，
// 这里提取核心安全函数进行独立验证。

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT_DIR, 'data');

// 复制 preload.js 中的沙箱逻辑
const _allowedWriteRoots = [
  path.resolve(ROOT_DIR),
  path.resolve(DATA_ROOT),
  path.resolve(os.tmpdir()),
  path.resolve(path.join(os.homedir(), 'Desktop')),
  path.resolve(path.join(os.homedir(), 'Downloads')),
  path.resolve(path.join(os.homedir(), 'Documents'))
];
if (process.platform === 'win32') {
  if (fs.existsSync('E:\\my-ai-data')) _allowedWriteRoots.push(path.resolve('E:\\my-ai-data'));
}

function validateWritePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  const normalizedTarget = resolved.toLowerCase().replace(/\//g, path.sep);
  for (let i = 0; i < _allowedWriteRoots.length; i++) {
    const normalizedRoot = _allowedWriteRoots[i].toLowerCase().replace(/\//g, path.sep);
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)) {
      return true;
    }
  }
  return false;
}

// 复制 preload.js 中的命令分级逻辑
const _CP_SAFE_PREFIXES = [
  'dir ', 'ls ', 'cat ', 'type ', 'echo ', 'pwd', 'cd ', 'whoami',
  'hostname', 'date ', 'time ', 'ver', 'uname ', 'id ', 'env',
  'git status', 'git log', 'git diff', 'git branch', 'git remote',
  'git show', 'git rev-parse', 'git ls-files', 'git config --get',
  'node --version', 'node -v', 'npm --version', 'npm -v',
  'python --version', 'python -v', 'python3 --version', 'pip --version',
  'where ', 'which ', 'find ', 'grep ', 'head ', 'tail ', 'wc ',
  'systeminfo', 'ipconfig', 'ifconfig', 'ping ', 'nslookup ',
  'tasklist', 'ps ', 'df ', 'du ', 'free ', 'netstat '
];
const _CP_HIGH_RISK_PREFIXES = [
  'format ', 'del /s', 'del /q', 'rd /s', 'deltree',
  'rm -rf /', 'rm -rf ~', 'rm -rf .', 'mkfs', 'fdisk', 'diskpart',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init 0', 'init 6',
  'cmd /c ', 'cmd /k ', 'cmd.exe /c ', 'cmd.exe /k ',
  'powershell -command', 'powershell -file', 'powershell -encodedcommand',
  'powershell.exe -command', 'powershell.exe -file', 'powershell.exe -encodedcommand',
  'bash -c ', 'sh -c ', 'mshta', 'wscript', 'cscript',
  'regsvr32', 'rundll32', 'certutil -urlcache', 'bitsadmin',
  'net user', 'net localgroup', 'sc create', 'sc delete',
  'schtasks /create', 'schtasks /delete', 'reg add', 'reg delete',
  'icacls ', 'takeown ', 'attrib '
];

function classifyCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return 'high';
  const cmdLower = cmd.trim().toLowerCase();
  for (let i = 0; i < _CP_HIGH_RISK_PREFIXES.length; i++) {
    const hp = _CP_HIGH_RISK_PREFIXES[i];
    if (cmdLower.startsWith(hp) || cmdLower === hp.trim()) return 'high';
  }
  if (/[&;|]/.test(cmdLower)) {
    const segments = cmdLower.split(/&&|\|\||;|\|/);
    let worst = 'safe';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i].trim();
      if (!seg) continue;
      const segClass = classifyCommand(seg);
      if (segClass === 'high') return 'high';
      if (segClass === 'medium') worst = 'medium';
    }
    return worst;
  }
  for (let i = 0; i < _CP_SAFE_PREFIXES.length; i++) {
    const sp = _CP_SAFE_PREFIXES[i];
    if (cmdLower.startsWith(sp) || cmdLower === sp.trim()) return 'safe';
  }
  return 'medium';
}

const _SPAWN_ALLOWED_BINARIES = [
  'git', 'python', 'python3', 'node', 'npm', 'npx', 'pip', 'pip3',
  'ollama', 'gh', 'ffmpeg', 'ffprobe', 'unzip', 'tar', 'curl', 'wget',
  'code', 'dotnet', 'java', 'javac', 'go', 'cargo', 'rustc'
];

function isSpawnBinaryAllowed(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const basename = path.basename(cmd).toLowerCase().replace(/\.exe$/, '');
  return _SPAWN_ALLOWED_BINARIES.includes(basename);
}

// ===== IPC 黑名单 =====
const _IPC_BLOCKED_CHANNELS = [
  'app-exit', 'app-quit', 'destroy-window', 'app:force-quit',
  'disable-security', 'bypass-auth', 'reset-password',
  'grant-all-permissions', 'disable-sandbox',
  'wipe-data', 'factory-reset', 'delete-all-sessions',
  'set-always-on-top', 'set-fullscreen-forced'
];

// ===== 测试运行器 =====
let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL: ' + msg); }
}

console.log('=== S1 Preload Security Tests ===\n');

// --- 1. Write path sandbox ---
console.log('[1] fsBridge write-path sandbox');
assert(validateWritePath(path.join(ROOT_DIR, 'modules', 'test.js')), 'app dir write allowed');
assert(validateWritePath(path.join(ROOT_DIR, 'data', 'config.json')), 'data subdir write allowed');
assert(validateWritePath(path.join(os.tmpdir(), 'temp-file.txt')), 'tmpdir write allowed');
assert(validateWritePath(path.join(os.homedir(), 'Desktop', 'output.txt')), 'Desktop write allowed');
assert(validateWritePath(path.join(os.homedir(), 'Downloads', 'file.zip')), 'Downloads write allowed');
assert(validateWritePath(path.join(os.homedir(), 'Documents', 'doc.md')), 'Documents write allowed');
if (process.platform === 'win32' && fs.existsSync('E:\\my-ai-data')) {
  assert(validateWritePath('E:\\my-ai-data\\sessions\\test.json'), 'E:\\my-ai-data write allowed');
}
// Blocked paths
assert(!validateWritePath('C:\\Windows\\System32\\config\\SAM'), 'System32 write BLOCKED');
assert(!validateWritePath(path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'evil.exe')), 'Startup folder write BLOCKED');
assert(!validateWritePath('C:\\Program Files\\evil.dll'), 'Program Files write BLOCKED');
assert(!validateWritePath('/etc/passwd'), '/etc/passwd write BLOCKED');
assert(!validateWritePath(null), 'null path BLOCKED');
assert(!validateWritePath(''), 'empty path BLOCKED');

// --- 2. Command classification ---
console.log('[2] childProcessBridge command classification');
// SAFE commands
assert(classifyCommand('dir C:\\') === 'safe', 'dir is safe');
assert(classifyCommand('git status') === 'safe', 'git status is safe');
assert(classifyCommand('echo hello') === 'safe', 'echo is safe');
assert(classifyCommand('node --version') === 'safe', 'node --version is safe');
assert(classifyCommand('ls -la') === 'safe', 'ls is safe');
// HIGH risk commands
assert(classifyCommand('cmd /c del /s /q C:\\') === 'high', 'cmd /c is high');
assert(classifyCommand('powershell -Command "Remove-Item -Recurse"') === 'high', 'powershell -Command is high');
assert(classifyCommand('shutdown /s /t 0') === 'high', 'shutdown is high');
assert(classifyCommand('format C:') === 'high', 'format is high');
assert(classifyCommand('rm -rf /') === 'high', 'rm -rf / is high');
assert(classifyCommand('mshta vbscript:Execute("evil")') === 'high', 'mshta is high');
assert(classifyCommand('reg add HKLM\\Software\\evil') === 'high', 'reg add is high');
assert(classifyCommand('schtasks /create /tn evil /tr malware.exe') === 'high', 'schtasks /create is high');
// Chain detection
assert(classifyCommand('echo hi && cmd /c del important.txt') === 'high', 'chain with cmd /c is high');
assert(classifyCommand('dir && shutdown /s') === 'high', 'chain with shutdown is high');
assert(classifyCommand('git status && git log') === 'safe', 'chain of safe commands is safe');
// MEDIUM (unknown) commands
assert(classifyCommand('npm install express') === 'medium', 'npm install is medium');
assert(classifyCommand('python script.py') === 'medium', 'python script.py is medium');
assert(classifyCommand('del myfile.txt') === 'medium', 'del single file is medium (not /s /q)');

// --- 3. Spawn binary whitelist ---
console.log('[3] spawn binary whitelist');
assert(isSpawnBinaryAllowed('git'), 'git allowed');
assert(isSpawnBinaryAllowed('python'), 'python allowed');
assert(isSpawnBinaryAllowed('python3'), 'python3 allowed');
assert(isSpawnBinaryAllowed('node'), 'node allowed');
assert(isSpawnBinaryAllowed('ffmpeg'), 'ffmpeg allowed');
assert(isSpawnBinaryAllowed('ollama'), 'ollama allowed');
assert(isSpawnBinaryAllowed('C:\\Program Files\\Git\\bin\\git.exe'), 'full path git.exe allowed');
assert(!isSpawnBinaryAllowed('cmd'), 'cmd NOT in spawn whitelist');
assert(!isSpawnBinaryAllowed('powershell'), 'powershell NOT in spawn whitelist');
assert(!isSpawnBinaryAllowed('bash'), 'bash NOT in spawn whitelist');
assert(!isSpawnBinaryAllowed('mshta'), 'mshta NOT in spawn whitelist');
assert(!isSpawnBinaryAllowed(''), 'empty binary NOT allowed');
assert(!isSpawnBinaryAllowed(null), 'null binary NOT allowed');

// --- 4. IPC blocklist ---
console.log('[4] ipcBridge blocklist');
assert(_IPC_BLOCKED_CHANNELS.includes('app-exit'), 'app-exit blocked');
assert(_IPC_BLOCKED_CHANNELS.includes('destroy-window'), 'destroy-window blocked');
assert(_IPC_BLOCKED_CHANNELS.includes('disable-security'), 'disable-security blocked');
assert(_IPC_BLOCKED_CHANNELS.includes('wipe-data'), 'wipe-data blocked');
assert(_IPC_BLOCKED_CHANNELS.includes('factory-reset'), 'factory-reset blocked');
assert(!_IPC_BLOCKED_CHANNELS.includes('agent:task'), 'agent:task NOT blocked');
assert(!_IPC_BLOCKED_CHANNELS.includes('config:get'), 'config:get NOT blocked');
assert(!_IPC_BLOCKED_CHANNELS.includes('session:save'), 'session:save NOT blocked');

// --- 5. Preload source verification ---
console.log('[5] preload.js source structure verification');
const preloadSrc = fs.readFileSync(path.join(ROOT_DIR, 'preload.js'), 'utf8');
assert(preloadSrc.includes('guardWritePath'), 'preload has guardWritePath');
assert(preloadSrc.includes('classifyCommand'), 'preload has classifyCommand');
assert(preloadSrc.includes('_rawExec'), 'preload has _rawExec privileged method');
assert(preloadSrc.includes('_rawSpawn'), 'preload has _rawSpawn privileged method');
assert(preloadSrc.includes('_IPC_BLOCKED_CHANNELS'), 'preload has IPC blocklist');
assert(preloadSrc.includes('registerWriteRoot'), 'preload exposes registerWriteRoot');
assert(preloadSrc.includes('SECURITY_BLOCKED'), 'preload returns SECURITY_BLOCKED error');
assert(!preloadSrc.includes("const blocked = ['app-exit', 'app-quit', 'destroy-window']"), 'old 3-item blocklist removed');

// --- 6. Module adaptation verification ---
console.log('[6] module adaptation verification');
const toolsSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'tools.js'), 'utf8');
assert(toolsSrc.includes('_cpBridge._rawExec'), 'tools.js uses _rawExec');
const sandboxSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'sandbox.js'), 'utf8');
assert(sandboxSrc.includes('_cpBridge._rawExec'), 'sandbox.js uses _rawExec');
assert(sandboxSrc.includes('_cpBridge._rawExecSync'), 'sandbox.js uses _rawExecSync');
const mcpSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'mcp.js'), 'utf8');
assert(mcpSrc.includes('_cpBridge._rawSpawn'), 'mcp.js uses _rawSpawn');
const pluginsSrc = fs.readFileSync(path.join(ROOT_DIR, 'modules', 'plugins.js'), 'utf8');
assert(pluginsSrc.includes('_cpBridge._rawExecSync'), 'plugins.js uses _rawExecSync');

// ===== 结果 =====
console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
