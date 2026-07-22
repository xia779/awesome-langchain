// modules/update.js - 使用 GitHub 远程更新源
const { shell } = require('electron');
let Core = null;

// 当前版本：优先从 package.json 读取（打包后用 electron app.getVersion 兜底）
let CURRENT_VERSION = '1.1.0';
try { CURRENT_VERSION = require('../package.json').version; } catch (e) {
  try { CURRENT_VERSION = require('electron').app.getVersion(); } catch (e2) {}
}

// 远程 version.json 的 Raw 链接（替换为你自己的）
const UPDATE_URL = 'https://raw.githubusercontent.com/xia779/my-ai-update/main/version.json';
const DOWNLOAD_URL = 'https://github.com/xia779/my-ai-update/releases';

// 检查更新
async function checkForUpdates(silent = false) {
  try {
    Core.dom.status.textContent = '🔄 正在检查更新...';

    const response = await fetch(UPDATE_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();

    const remoteVersion = data.version || '0.0.0';
    const releaseNotes = data.releaseNotes || '暂无更新说明';
    const downloadUrl = data.downloadUrl || DOWNLOAD_URL;

    // 比较版本
    const isNewer = compareVersions(remoteVersion, CURRENT_VERSION) > 0;

    if (isNewer) {
      const message = `📢 发现新版本 ${remoteVersion}！\n\n当前版本：${CURRENT_VERSION}\n更新内容：${releaseNotes}\n\n是否前往下载？`;
      if (confirm(message)) {
        shell.openExternal(downloadUrl);
      }
      Core.dom.status.textContent = `📢 发现新版本 ${remoteVersion}`;
      setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 3000);
    } else {
      if (!silent) {
        showAlert(`✅ 当前已是最新版本（${CURRENT_VERSION}）`);
      }
      Core.dom.status.textContent = `✅ 已是最新版本 (${CURRENT_VERSION})`;
      setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 2000);
    }
  } catch (err) {
    if (!silent) {
      showToast(`❌ 检查更新失败：\n${err.message}`, 'error');
    }
    console.warn('检查更新失败:', err);
    Core.dom.status.textContent = '⚠️ 更新检查失败';
    setTimeout(() => { Core.dom.status.textContent = '✅ 已就绪'; }, 2000);
  }
}

// 版本号比较
function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const valA = partsA[i] || 0;
    const valB = partsB[i] || 0;
    if (valA !== valB) return valA - valB;
  }
  return 0;
}

// 获取当前版本
function getCurrentVersion() {
  return CURRENT_VERSION;
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.update = {
      checkForUpdates,
      getCurrentVersion,
    };
    console.log(`✅ 更新模块已加载 (当前版本: ${CURRENT_VERSION})`);
  }
};