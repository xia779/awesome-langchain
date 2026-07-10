// modules/github.js - GitHub 深度集成模块
// 封装 gh CLI 实现 PR/Issue/CI/Release 等开发工作流操作
// 自动检测 gh 安装状态和认证状态

var Core = null;
var fs = null;
var path = null;
var childProcess = null;

try {
  fs = require('fs');
  path = require('path');
  childProcess = require('child_process');
} catch (e) {}

// ═══════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════

var state = {
  ghAvailable: null,      // null=未检测, true/false
  ghVersion: null,
  authenticated: null,    // null=未检测, true/false
  username: null,
  defaultRepo: null,      // 从 cwd 的 git remote 推断
  lastCheck: null
};

// ═══════════════════════════════════════════
// gh CLI 执行器
// ═══════════════════════════════════════════

/**
 * 执行 gh CLI 命令并返回结果
 */
function runGh(args, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    if (!childProcess) {
      reject(new Error('child_process 不可用'));
      return;
    }

    var cmdArgs = Array.isArray(args) ? args : args.split(/\s+/);
    var cwd = options.cwd || (Core && Core.DATA_ROOT) || process.cwd();
    var timeout = options.timeout || 30000;

    var child = childProcess.spawn('gh', cmdArgs, {
      cwd: cwd,
      env: Object.assign({}, process.env, options.env || {}),
      timeout: timeout,
      shell: process.platform === 'win32'
    });

    var stdout = '';
    var stderr = '';

    child.stdout.on('data', function(data) { stdout += data.toString(); });
    child.stderr.on('data', function(data) { stderr += data.toString(); });

    child.on('close', function(code) {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        var errMsg = stderr.trim() || stdout.trim() || 'gh 命令失败 (exit ' + code + ')';
        reject(new Error(errMsg));
      }
    });

    child.on('error', function(err) {
      if (err.code === 'ENOENT') {
        reject(new Error('gh CLI 未安装。请运行: winget install GitHub.cli 或访问 https://cli.github.com'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * 执行 git 命令
 */
function runGit(args, cwd) {
  return new Promise(function(resolve, reject) {
    var child = childProcess.spawn('git', Array.isArray(args) ? args : args.split(/\s+/), {
      cwd: cwd || process.cwd(),
      timeout: 15000,
      shell: process.platform === 'win32'
    });
    var stdout = '';
    var stderr = '';
    child.stdout.on('data', function(d) { stdout += d.toString(); });
    child.stderr.on('data', function(d) { stderr += d.toString(); });
    child.on('close', function(code) {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || 'git 命令失败'));
    });
    child.on('error', function(err) { reject(err); });
  });
}

// ═══════════════════════════════════════════
// 环境检测
// ═══════════════════════════════════════════

async function checkEnvironment() {
  // 检查 gh 是否安装
  try {
    var version = await runGh(['--version']);
    state.ghAvailable = true;
    state.ghVersion = (version.match(/\d+\.\d+\.\d+/) || ['unknown'])[0];
  } catch (e) {
    state.ghAvailable = false;
    state.ghVersion = null;
  }

  // 检查认证状态
  if (state.ghAvailable) {
    try {
      var authStatus = await runGh(['auth', 'status']);
      state.authenticated = true;
      var nameMatch = authStatus.match(/Logged in to .* as (\S+)/);
      state.username = nameMatch ? nameMatch[1] : null;
    } catch (e) {
      state.authenticated = false;
    }
  }

  state.lastCheck = Date.now();
  return { ghAvailable: state.ghAvailable, ghVersion: state.ghVersion, authenticated: state.authenticated, username: state.username };
}

function ensureReady() {
  if (state.ghAvailable === false) {
    throw new Error('gh CLI 未安装。请运行: winget install GitHub.cli');
  }
  if (state.authenticated === false) {
    throw new Error('gh 未登录。请运行: gh auth login');
  }
}

// ═══════════════════════════════════════════
// PR 操作
// ═══════════════════════════════════════════

async function prCreate(options) {
  ensureReady();
  options = options || {};
  var args = ['pr', 'create'];

  if (options.title) args.push('--title', options.title);
  if (options.body) args.push('--body', options.body);
  if (options.base) args.push('--base', options.base);
  if (options.head) args.push('--head', options.head);
  if (options.draft) args.push('--draft');
  if (options.fill) args.push('--fill');
  if (!options.title && !options.fill) args.push('--fill');

  return await runGh(args, { cwd: options.cwd });
}

async function prList(options) {
  ensureReady();
  options = options || {};
  var args = ['pr', 'list', '--limit', String(options.limit || 10)];
  if (options.state) args.push('--state', options.state);
  if (options.author) args.push('--author', options.author);
  if (options.label) args.push('--label', options.label);
  args.push('--json', 'number,title,state,author,createdAt,url,reviewDecision,isDraft');

  var result = await runGh(args, { cwd: options.cwd });
  try { return JSON.parse(result); } catch (e) { return result; }
}

async function prView(number, options) {
  ensureReady();
  options = options || {};
  var args = ['pr', 'view', String(number), '--json', 'number,title,body,state,author,url,additions,deletions,changedFiles,reviewDecision,mergeable,commits'];
  var result = await runGh(args, { cwd: options.cwd });
  try { return JSON.parse(result); } catch (e) { return result; }
}

async function prDiff(number, options) {
  ensureReady();
  options = options || {};
  return await runGh(['pr', 'diff', String(number)], { cwd: options.cwd });
}

async function prMerge(number, options) {
  ensureReady();
  options = options || {};
  var args = ['pr', 'merge', String(number)];
  if (options.squash) args.push('--squash');
  if (options.rebase) args.push('--rebase');
  if (options.merge) args.push('--merge');
  if (options.deleteBranch !== false) args.push('--delete-branch');
  return await runGh(args, { cwd: options.cwd });
}

async function prClose(number, options) {
  ensureReady();
  return await runGh(['pr', 'close', String(number)], { cwd: (options || {}).cwd });
}

async function prChecks(number, options) {
  ensureReady();
  options = options || {};
  var args = ['pr', 'checks', String(number)];
  var result = await runGh(args, { cwd: options.cwd });
  return result;
}

// ═══════════════════════════════════════════
// Issue 操作
// ═══════════════════════════════════════════

async function issueCreate(options) {
  ensureReady();
  options = options || {};
  var args = ['issue', 'create'];
  if (options.title) args.push('--title', options.title);
  if (options.body) args.push('--body', options.body);
  if (options.label) args.push('--label', options.label);
  if (options.assignee) args.push('--assignee', options.assignee);
  if (options.milestone) args.push('--milestone', options.milestone);
  return await runGh(args, { cwd: options.cwd });
}

async function issueList(options) {
  ensureReady();
  options = options || {};
  var args = ['issue', 'list', '--limit', String(options.limit || 10)];
  if (options.state) args.push('--state', options.state);
  if (options.label) args.push('--label', options.label);
  if (options.assignee) args.push('--assignee', options.assignee);
  args.push('--json', 'number,title,state,author,createdAt,url,labels');

  var result = await runGh(args, { cwd: options.cwd });
  try { return JSON.parse(result); } catch (e) { return result; }
}

async function issueView(number, options) {
  ensureReady();
  options = options || {};
  var args = ['issue', 'view', String(number), '--json', 'number,title,body,state,author,url,labels,comments'];
  var result = await runGh(args, { cwd: options.cwd });
  try { return JSON.parse(result); } catch (e) { return result; }
}

async function issueClose(number, options) {
  ensureReady();
  return await runGh(['issue', 'close', String(number)], { cwd: (options || {}).cwd });
}

async function issueComment(number, body, options) {
  ensureReady();
  return await runGh(['issue', 'comment', String(number), '--body', body], { cwd: (options || {}).cwd });
}

// ═══════════════════════════════════════════
// Repo / Release 操作
// ═══════════════════════════════════════════

async function repoView(options) {
  ensureReady();
  options = options || {};
  var args = ['repo', 'view'];
  if (options.repo) args.push(options.repo);
  args.push('--json', 'name,description,url,defaultBranchRef,stargazerCount,forkCount,issues,pullRequests');
  var result = await runGh(args, { cwd: options.cwd });
  try { return JSON.parse(result); } catch (e) { return result; }
}

async function releaseList(options) {
  ensureReady();
  options = options || {};
  var args = ['release', 'list', '--limit', String(options.limit || 5)];
  return await runGh(args, { cwd: options.cwd });
}

async function releaseCreate(tag, options) {
  ensureReady();
  options = options || {};
  var args = ['release', 'create', tag];
  if (options.title) args.push('--title', options.title);
  if (options.notes) args.push('--notes', options.notes);
  if (options.draft) args.push('--draft');
  if (options.prerelease) args.push('--prerelease');
  if (options.generateNotes) args.push('--generate-notes');
  return await runGh(args, { cwd: options.cwd });
}

// ═══════════════════════════════════════════
// Gist 操作
// ═══════════════════════════════════════════

async function gistCreate(filepath, options) {
  ensureReady();
  options = options || {};
  var args = ['gist', 'create', filepath];
  if (options.description) args.push('--desc', options.description);
  if (options.public) args.push('--public');
  return await runGh(args, { cwd: options.cwd });
}

async function gistList(options) {
  ensureReady();
  options = options || {};
  var args = ['gist', 'list', '--limit', String(options.limit || 5)];
  return await runGh(args, { cwd: options.cwd });
}

// ═══════════════════════════════════════════
// API 直接调用
// ═══════════════════════════════════════════

async function apiCall(endpoint, options) {
  ensureReady();
  options = options || {};
  var args = ['api', endpoint];
  if (options.method) args.push('-X', options.method);
  if (options.field) {
    Object.keys(options.field).forEach(function(k) {
      args.push('-f', k + '=' + options.field[k]);
    });
  }
  return await runGh(args, { cwd: options.cwd });
}

// ═══════════════════════════════════════════
// /github 命令路由
// ═══════════════════════════════════════════

async function handleGithubCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'status').toLowerCase();
  var rest = parts.slice(1).join(' ');

  // 先检测环境
  if (state.ghAvailable === null) {
    await checkEnvironment();
  }

  switch (sub) {
    case 'status': case 'check': case '状态':
      var env = state.ghAvailable === null ? await checkEnvironment() : state;
      if (!env.ghAvailable) {
        return '❌ gh CLI 未安装\n\n安装方法: `winget install GitHub.cli`\n或访问 https://cli.github.com';
      }
      var info = '🐙 **GitHub CLI 状态**\n\n';
      info += '版本: gh ' + (env.ghVersion || 'unknown') + '\n';
      info += '认证: ' + (env.authenticated ? '✅ 已登录' : '❌ 未登录（运行 `gh auth login`）') + '\n';
      if (env.username) info += '用户: ' + env.username + '\n';
      return info;

    case 'login': case 'auth':
      return '请在终端运行以下命令完成登录:\n\n```bash\ngh auth login\n```\n\n支持浏览器 OAuth 或 token 方式。';

    case 'pr':
      return await handlePrCommand(rest);

    case 'issue':
      return await handleIssueCommand(rest);

    case 'release':
      return await handleReleaseCommand(rest);

    case 'repo': case '仓库':
      if (rest === 'view' || !rest) {
        var repoInfo = await repoView();
        if (typeof repoInfo === 'object') {
          return '📦 **' + repoInfo.name + '**\n\n' +
            (repoInfo.description || '无描述') + '\n\n' +
            '分支: ' + ((repoInfo.defaultBranchRef && repoInfo.defaultBranchRef.name) || 'main') + '\n' +
            'Star: ' + (repoInfo.stargazerCount || 0) + '\n' +
            'Fork: ' + (repoInfo.forkCount || 0) + '\n' +
            'URL: ' + (repoInfo.url || '');
        }
        return String(repoInfo);
      }
      return '用法: /github repo [view]';

    case 'gist':
      return await handleGistCommand(rest);

    case 'api':
      if (!rest) return '用法: /github api <endpoint>  例如: /github api repos/owner/repo';
      return await apiCall(rest);

    default:
      return '🐙 **GitHub 命令**\n\n' +
        '- `/github status` — 检查 gh 安装和认证状态\n' +
        '- `/github pr list|view|create|diff|merge|close|checks` — PR 操作\n' +
        '- `/github issue list|view|create|close|comment` — Issue 操作\n' +
        '- `/github release list|create <tag>` — Release 操作\n' +
        '- `/github repo [view]` — 仓库信息\n' +
        '- `/github gist list|create <file>` — Gist 操作\n' +
        '- `/github api <endpoint>` — 直接调用 GitHub API\n' +
        '- `/github login` — 认证帮助';
  }
}

async function handlePrCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'list').toLowerCase();
  var rest = parts.slice(1).join(' ');

  switch (sub) {
    case 'list': case 'ls':
      var prs = await prList({ limit: 10, state: 'open' });
      if (Array.isArray(prs) && prs.length === 0) return '暂无打开的 PR';
      if (Array.isArray(prs)) {
        return '📋 **打开的 Pull Requests**\n\n' + prs.map(function(pr) {
          var draft = pr.isDraft ? ' 📝草稿' : '';
          var review = pr.reviewDecision === 'APPROVED' ? ' ✅' : pr.reviewDecision === 'CHANGES_REQUESTED' ? ' ❌' : '';
          return '#' + pr.number + ' ' + pr.title + draft + review + '\n  by ' + (pr.author && pr.author.login || '?') + ' | ' + (pr.url || '');
        }).join('\n\n');
      }
      return String(prs);

    case 'view': case 'show':
      if (!rest) return '用法: /github pr view <number>';
      var prInfo = await prView(parseInt(rest));
      if (typeof prInfo === 'object') {
        return '📋 **PR #' + prInfo.number + ': ' + prInfo.title + '**\n\n' +
          '状态: ' + prInfo.state + '\n' +
          '作者: ' + (prInfo.author && prInfo.author.login || '?') + '\n' +
          '变更: +' + prInfo.additions + ' -' + prInfo.deletions + ' (' + prInfo.changedFiles + ' 文件)\n' +
          '可合并: ' + (prInfo.mergeable || 'unknown') + '\n' +
          '审查: ' + (prInfo.reviewDecision || 'pending') + '\n' +
          'URL: ' + (prInfo.url || '') + '\n\n' +
          (prInfo.body ? prInfo.body.substring(0, 500) : '');
      }
      return String(prInfo);

    case 'create':
      if (!rest) {
        return '用法: /github pr create <title>\n或使用 Agent 模式让 AI 自动填写';
      }
      var result = await prCreate({ title: rest, fill: true });
      return '✅ PR 已创建:\n' + result;

    case 'diff':
      if (!rest) return '用法: /github pr diff <number>';
      var diff = await prDiff(parseInt(rest));
      if (diff.length > 3000) diff = diff.substring(0, 3000) + '\n...[已截断]';
      return '```diff\n' + diff + '\n```';

    case 'merge':
      if (!rest) return '用法: /github pr merge <number>';
      var mergeResult = await prMerge(parseInt(rest), { squash: true });
      return '✅ PR #' + rest + ' 已合并\n' + mergeResult;

    case 'close':
      if (!rest) return '用法: /github pr close <number>';
      await prClose(parseInt(rest));
      return '🔒 PR #' + rest + ' 已关闭';

    case 'checks': case 'ci':
      if (!rest) return '用法: /github pr checks <number>';
      var checks = await prChecks(parseInt(rest));
      return '🔍 **PR #' + rest + ' CI 状态**\n\n' + checks;

    default:
      return 'PR 命令: list, view, create, diff, merge, close, checks';
  }
}

async function handleIssueCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'list').toLowerCase();
  var rest = parts.slice(1).join(' ');

  switch (sub) {
    case 'list': case 'ls':
      var issues = await issueList({ limit: 10, state: 'open' });
      if (Array.isArray(issues) && issues.length === 0) return '暂无打开的 Issue';
      if (Array.isArray(issues)) {
        return '📋 **打开的 Issues**\n\n' + issues.map(function(i) {
          var labels = (i.labels || []).map(function(l) { return l.name; }).join(', ');
          return '#' + i.number + ' ' + i.title + (labels ? ' [' + labels + ']' : '') + '\n  by ' + (i.author && i.author.login || '?') + ' | ' + (i.url || '');
        }).join('\n\n');
      }
      return String(issues);

    case 'view': case 'show':
      if (!rest) return '用法: /github issue view <number>';
      var issueInfo = await issueView(parseInt(rest));
      if (typeof issueInfo === 'object') {
        var labels = (issueInfo.labels || []).map(function(l) { return l.name; }).join(', ');
        return '📋 **Issue #' + issueInfo.number + ': ' + issueInfo.title + '**\n\n' +
          '状态: ' + issueInfo.state + '\n' +
          '作者: ' + (issueInfo.author && issueInfo.author.login || '?') + '\n' +
          '标签: ' + (labels || '无') + '\n' +
          'URL: ' + (issueInfo.url || '') + '\n\n' +
          (issueInfo.body ? issueInfo.body.substring(0, 500) : '');
      }
      return String(issueInfo);

    case 'create':
      if (!rest) return '用法: /github issue create <title>';
      var issueResult = await issueCreate({ title: rest });
      return '✅ Issue 已创建:\n' + issueResult;

    case 'close':
      if (!rest) return '用法: /github issue close <number>';
      await issueClose(parseInt(rest));
      return '🔒 Issue #' + rest + ' 已关闭';

    case 'comment':
      var commentParts = rest.split(/\s+/);
      if (commentParts.length < 2) return '用法: /github issue comment <number> <评论内容>';
      var commentNum = parseInt(commentParts[0]);
      var commentBody = commentParts.slice(1).join(' ');
      await issueComment(commentNum, commentBody);
      return '💬 已添加评论到 Issue #' + commentNum;

    default:
      return 'Issue 命令: list, view, create, close, comment';
  }
}

async function handleReleaseCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'list').toLowerCase();
  var rest = parts.slice(1).join(' ');

  if (sub === 'list' || sub === 'ls') {
    var releases = await releaseList();
    return '🏷️ **Releases**\n\n' + releases;
  }
  if (sub === 'create') {
    if (!rest) return '用法: /github release create <tag> [title]';
    var tagParts = rest.split(/\s+/);
    var tag = tagParts[0];
    var title = tagParts.slice(1).join(' ') || tag;
    var relResult = await releaseCreate(tag, { title: title, generateNotes: true });
    return '✅ Release ' + tag + ' 已创建:\n' + relResult;
  }
  return 'Release 命令: list, create';
}

async function handleGistCommand(args) {
  var parts = (args || '').trim().split(/\s+/);
  var sub = (parts[0] || 'list').toLowerCase();

  if (sub === 'list' || sub === 'ls') {
    var gists = await gistList();
    return '📝 **Gists**\n\n' + gists;
  }
  if (sub === 'create') {
    var filepath = parts[1];
    if (!filepath) return '用法: /github gist create <文件路径>';
    var gistResult = await gistCreate(filepath);
    return '✅ Gist 已创建:\n' + gistResult;
  }
  return 'Gist 命令: list, create';
}

// ═══════════════════════════════════════════
// 模块导出
// ═══════════════════════════════════════════

module.exports = {
  init(_Core) {
    Core = _Core;

    Core.github = {
      checkEnvironment: checkEnvironment,
      isAvailable: function() { return state.ghAvailable === true; },
      isAuthenticated: function() { return state.authenticated === true; },
      getStatus: function() { return Object.assign({}, state); },

      // PR
      prCreate: prCreate,
      prList: prList,
      prView: prView,
      prDiff: prDiff,
      prMerge: prMerge,
      prClose: prClose,
      prChecks: prChecks,

      // Issue
      issueCreate: issueCreate,
      issueList: issueList,
      issueView: issueView,
      issueClose: issueClose,
      issueComment: issueComment,

      // Repo
      repoView: repoView,

      // Release
      releaseList: releaseList,
      releaseCreate: releaseCreate,

      // Gist
      gistCreate: gistCreate,
      gistList: gistList,

      // API
      apiCall: apiCall,

      // Command
      handleCommand: handleGithubCommand
    };

    // 命令注册（已声明 custom 依赖）
    if (Core.custom && Core.custom.registerCommand) {
      Core.custom.registerCommand('/github', function(args) {
        return handleGithubCommand(args);
      });
    }

    // 延迟检测环境
    setTimeout(function() {
      checkEnvironment().then(function(env) {
        console.log('🐙 GitHub CLI: ' + (env.ghAvailable ? 'v' + env.ghVersion : '未安装') +
          (env.authenticated ? ' (已登录 ' + env.username + ')' : ''));
      });
    }, 2000);

    console.log('✅ GitHub 集成模块已加载');
  }
};
