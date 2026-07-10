// modules/git.js - Git 版本控制（增强版）
const { spawn } = require('child_process');
const path = require('path');

let Core = null;

const GIT_TIMEOUT = 30000;

// 🔒 安全修复：spawn + 参数数组，防止命令注入
function runGitCommand(args, cwd) {
  return new Promise((resolve, reject) => {
    const workDir = cwd || (Core && Core.config && Core.config.gitRepoPath) || process.cwd();
    const child = spawn('git', args, { cwd: workDir, timeout: GIT_TIMEOUT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(stderr || 'git 命令退出码 ' + code);
      } else {
        resolve(stdout);
      }
    });
    child.on('error', (err) => {
      reject('执行 git 命令失败: ' + err.message);
    });
  });
}

// 通用执行
async function gitAction(action, params) {
  params = params || [];
  try {
    var args = [action].concat(params);
    var result = await runGitCommand(args);
    return '✅ Git 执行成功:\n' + result;
  } catch (err) {
    return '❌ Git 错误:\n' + err;
  }
}

// ===== 基础命令 =====

async function gitStatus() {
  return gitAction('status', ['--short']);
}

async function gitCommit(message) {
  if (!message) return '❌ 请提供提交信息';
  return gitAction('commit', ['-m', message]);
}

async function gitPull() {
  return gitAction('pull');
}

async function gitPush() {
  return gitAction('push');
}

async function gitLog(n) {
  n = n || 5;
  var count = Math.max(1, Math.min(parseInt(n, 10) || 5, 100));
  return gitAction('log', ['--oneline', '-' + count]);
}

// ===== 高级命令 =====

// diff: 查看变更详情
async function gitDiff(file, staged) {
  var params = [];
  if (staged) params.push('--staged');
  if (file) params = params.concat(['--', file]);
  try {
    var result = await runGitCommand(['diff'].concat(params));
    if (!result || !result.trim()) return '没有检测到变更';
    return '📝 Git Diff:\n' + result;
  } catch (err) {
    return '❌ Git diff 错误:\n' + err;
  }
}

// branch: 分支管理
async function gitBranch(action, name) {
  action = action || 'list';
  try {
    if (action === 'list' || action === '-a') {
      var result = await runGitCommand(['branch', '-a']);
      var current = await runGitCommand(['branch', '--show-current']).catch(function () { return ''; });
      var header = current ? '当前分支: ' + current.trim() + '\n' : '';
      return header + '分支列表:\n' + result;
    }
    if (action === 'create' && name) {
      return await gitAction('branch', [name]);
    }
    if (action === 'delete' && name) {
      return await gitAction('branch', ['-d', name]);
    }
    if (action === 'force-delete' && name) {
      return await gitAction('branch', ['-D', name]);
    }
    return '❌ 未知分支操作: ' + action + '\n可用: list, create <name>, delete <name>';
  } catch (err) {
    return '❌ Git branch 错误:\n' + err;
  }
}

// checkout: 切换分支或恢复文件
async function gitCheckout(target) {
  if (!target) return '❌ 请指定分支名或文件路径';
  try {
    var result = await runGitCommand(['checkout', target]);
    return '✅ 已切换到: ' + target + '\n' + result;
  } catch (branchErr) {
    try {
      await runGitCommand(['checkout', '--', target]);
      return '✅ 已恢复文件: ' + target;
    } catch (fileErr) {
      return '❌ Git checkout 错误:\n' + branchErr;
    }
  }
}

// stash: 暂存管理
async function gitStash(action, message) {
  action = action || 'save';
  try {
    if (action === 'save' || action === 'push') {
      var params = ['push'];
      if (message) params = params.concat(['-m', message]);
      return await gitAction('stash', params);
    }
    if (action === 'list') {
      var result = await runGitCommand(['stash', 'list']);
      return result ? '📦 Stash 列表:\n' + result : '暂无 stash';
    }
    if (action === 'pop') {
      return await gitAction('stash', ['pop']);
    }
    if (action === 'apply') {
      return await gitAction('stash', ['apply']);
    }
    if (action === 'drop') {
      return await gitAction('stash', ['drop']);
    }
    if (action === 'clear') {
      return await gitAction('stash', ['clear']);
    }
    return '❌ 未知 stash 操作: ' + action + '\n可用: save, list, pop, apply, drop, clear';
  } catch (err) {
    return '❌ Git stash 错误:\n' + err;
  }
}

// add: 暂存文件
async function gitAdd(file) {
  if (!file) return '❌ 请指定文件或 "." 添加所有变更';
  return gitAction('add', [file]);
}

// 冲突检测
async function gitConflictCheck() {
  try {
    var status = await runGitCommand(['status', '--porcelain']);
    var conflicts = [];
    var lines = status.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line)) {
        conflicts.push(line.substring(3).trim());
      }
    }
    if (conflicts.length === 0) {
      return '✅ 没有检测到合并冲突';
    }
    return '⚠️ 检测到 ' + conflicts.length + ' 个冲突文件:\n' + conflicts.map(function (f) {
      return '  - ' + f;
    }).join('\n');
  } catch (err) {
    return '❌ 冲突检测失败:\n' + err;
  }
}

// merge: 合并分支
async function gitMerge(branch) {
  if (!branch) return '❌ 请指定要合并的分支';
  return gitAction('merge', [branch]);
}

// reset: 重置（仅允许 soft/mixed 模式，禁止 hard 防止数据丢失）
async function gitReset(mode, target) {
  mode = mode || 'soft';
  target = target || 'HEAD~1';
  if (mode === 'hard') {
    return '❌ 为安全起见，不支持 hard reset。请使用 soft 或 mixed 模式。';
  }
  var allowedModes = ['soft', 'mixed'];
  if (allowedModes.indexOf(mode) < 0) return '❌ 不支持的 reset 模式: ' + mode;
  return gitAction('reset', ['--' + mode, target]);
}

module.exports = {
  name: 'git',
  dependencies: ['tools'],
  init(_Core) {
    Core = _Core;
    Core.tools = Core.tools || {};
    // 基础命令
    Core.tools.git = gitAction;
    Core.tools.gitStatus = gitStatus;
    Core.tools.gitCommit = gitCommit;
    Core.tools.gitPull = gitPull;
    Core.tools.gitPush = gitPush;
    Core.tools.gitLog = gitLog;
    // 高级命令
    Core.tools.gitDiff = gitDiff;
    Core.tools.gitBranch = gitBranch;
    Core.tools.gitCheckout = gitCheckout;
    Core.tools.gitStash = gitStash;
    Core.tools.gitAdd = gitAdd;
    Core.tools.gitMerge = gitMerge;
    Core.tools.gitReset = gitReset;
    Core.tools.gitConflictCheck = gitConflictCheck;
    console.log('✅ Git 模块已加载（增强版：diff/branch/checkout/stash/merge/conflict）');
  }
};
