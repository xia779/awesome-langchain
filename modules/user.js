// modules/user.js - 用户管理
const fs = require('fs');
const path = require('path');

let Core = null;
let currentUser = null;

// 🔧 统一从 Core 获取数据路径（动态化，不再硬编码）
function getUsersRoot() {
  var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || process.env.AI_AGENT_DATA_ROOT;
  if (!base) {
    // 最终回退：检查默认路径
    var defaultPath = 'E:\\my-ai-data';
    if (require('fs').existsSync(defaultPath)) return defaultPath + '\\users';
    return require('path').join(require('os').homedir(), '.ai-agent-data', 'users');
  }
  return require('path').join(base, 'users');
}
function getUsersDir() { return getUsersRoot(); }

function ensureUsersDir() {
  const root = getUsersRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
}

function getUserDir(username) {
  return path.join(getUsersRoot(), username);
}

function getUserConfigPath(username) {
  return path.join(getUserDir(username), 'config.json');
}

function getUserSessionsDir(username) {
  return path.join(getUserDir(username), 'sessions');
}

function getUserKnowledgeDir(username) {
  return path.join(getUserDir(username), 'knowledge');
}

function getUserPluginsDir(username) {
  return path.join(getUserDir(username), 'plugins');
}

function ensureUserDirs(username) {
  const userDir = getUserDir(username);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  const sessionsDir = getUserSessionsDir(username);
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  const knowledgeDir = getUserKnowledgeDir(username);
  if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });
  const pluginsDir = getUserPluginsDir(username);
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
}

function listUsers() {
  ensureUsersDir();
  const root = getUsersRoot();
  const dirs = fs.readdirSync(root);
  return dirs.filter(d => {
    const stat = fs.statSync(path.join(root, d));
    return stat.isDirectory() && fs.existsSync(getUserConfigPath(d));
  });
}

function userExists(username) {
  const configPath = getUserConfigPath(username);
  return fs.existsSync(configPath);
}

function createUser(username) {
  if (userExists(username)) {
    return { success: false, error: '用户已存在' };
  }
  ensureUserDirs(username);
  const configPath = getUserConfigPath(username);
  const defaultConfig = {
    username: username,
    createdAt: new Date().toISOString(),
    temperature: 0.7,
    ollamaModel: 'qwen2.5:7b',
    deepseekModel: 'deepseek-chat',
    doubaoModel: 'doubao-pro-32k',
    customModel: 'gpt-3.5-turbo',
    defaultApi: 'ollama',
    autoRoute: false,
    language: 'zh-CN',
    searchEngine: 'bocha',
  };
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  console.log(`✅ 用户 ${username} 创建成功`);
  return { success: true, username };
}

function loginUser(username) {
  if (!userExists(username)) {
    return { success: false, error: `用户 ${username} 不存在` };
  }
  currentUser = username;
  // 🔧 同步设置 Core._currentUser（下游代码依赖此值）
  if (Core) Core._currentUser = username;
  
  // 🔧 使用动态路径，防止硬编码嵌套
  var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || 'E:\\my-ai-data';
  const correctDir = path.join(base, 'users', username);
  if (Core.DATA_ROOT !== correctDir) {
    Core.DATA_ROOT = correctDir;
  }
  
  Core.CONFIG_FILE = path.join(correctDir, 'config.json');
  Core.SESSIONS_DIR = path.join(correctDir, 'sessions');
  Core.KNOWLEDGE_DIR = path.join(correctDir, 'knowledge');
  Core.PLUGINS_DIR = path.join(correctDir, 'plugins');
  Core.loadConfig();
  console.log(`✅ 用户 ${username} 登录成功, DATA_ROOT=${Core.DATA_ROOT}`);
  return { success: true, username };
}

function getCurrentUser() {
  return currentUser;
}

function logoutUser() {
  const username = currentUser;
  if (username) {
    // 清空聊天容器
    if (Core.dom && Core.dom.chatContainer) {
      Core.dom.chatContainer.innerHTML = '';
    }
    // 清空侧边栏
    if (Core.dom && Core.dom.chatList) {
      Core.dom.chatList.innerHTML = '';
    }
    // 重置当前会话 ID
    if (Core.session && typeof Core.session.setCurrentId === 'function') {
      Core.session.setCurrentId(null);
    }
    currentUser = null;
    console.log(`✅ 用户 ${username} 已注销`);
    // 显示登录界面
    const overlay = document.getElementById('loginOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.style.display = 'flex';
    }
    if (Core.dom && Core.dom.status) {
      Core.dom.status.textContent = '👤 请登录';
    }
  }
  return { success: true };
}

function migrateOldData(username) {
  // 🔧 动态获取数据根目录
  var base = (Core && Core._globalDataRoot) || (Core && Core.DATA_ROOT) || process.env.AI_AGENT_DATA_ROOT;
  if (!base) {
    var defaultPath = 'E:\\my-ai-data';
    if (fs.existsSync(defaultPath)) base = defaultPath;
    else base = path.join(require('os').homedir(), '.ai-agent-data');
  }
  const oldDataRoot = base;
  const newUserDir = getUserDir(username);
  const oldFiles = ['config.json', 'sessions', 'knowledge', 'plugins', 'history', 'temp'];
  let migrated = false;
  for (const item of oldFiles) {
    const oldPath = path.join(oldDataRoot, item);
    const newPath = path.join(newUserDir, item);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      try {
        if (fs.statSync(oldPath).isDirectory()) {
          fs.cpSync(oldPath, newPath, { recursive: true });
        } else {
          fs.copyFileSync(oldPath, newPath);
        }
        migrated = true;
      } catch (err) {
        console.warn(`⚠️ 迁移 ${item} 失败:`, err);
      }
    }
  }
  if (migrated) {
    console.log(`✅ 旧数据已迁移到用户 ${username}`);
  }
  return migrated;
}

function showLoginUI() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
  }
  if (Core.dom && Core.dom.chatList) {
    Core.dom.chatList.innerHTML = '';
  }
}

function deleteUser(username) {
  try {
    if (!username || username === 'admin') {
      showToast('不能删除管理员用户或空用户名', 'error');
      return false;
    }
    const userDir = getUserDir(username);
    if (!fs.existsSync(userDir)) {
      showToast('用户不存在', 'error');
      return false;
    }
    if (!confirm('确定删除用户 "' + username + '" 吗？\n\n⚠️ 此操作不可恢复，所有数据将被删除！')) return false;
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
      console.log('✅ 用户已删除:', username);
      return true;
    } catch (err) {
      console.error('❌ 删除用户失败:', err);
      showToast('删除失败: ' + err.message, 'error');
      return false;
    }
  } catch (err) {
    console.error('❌ 删除用户异常:', err);
    return false;
  }
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.user = {
      ensureUsersDir,
      getUserDir,
      getUserConfigPath,
      getUserSessionsDir,
      getUserKnowledgeDir,
      getUserPluginsDir,
      ensureUserDirs,
      listUsers,
      userExists,
      createUser,
      loginUser,
      getCurrentUser,
      logoutUser,
      deleteUser,
      migrateOldData,
      showLoginUI,
    };
    console.log('✅ 用户模块已加载');
  }
};