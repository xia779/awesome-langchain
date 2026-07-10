// modules/model-manager.js - 模型管理模块
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let Core = null;

// ===== 获取已安装模型列表 =====
async function getInstalledModels() {
  return new Promise((resolve, reject) => {
    // 🔒 安全修复：使用 spawn 替代 exec，防止命令注入
    const child = spawn('ollama', ['list']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ollama list 失败，退出码 ${code}`));
        return;
      }
      // 解析输出
      const lines = stdout.trim().split('\n');
      if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === '')) {
        resolve([]);
        return;
      }
      // 跳过表头（如果有）
      const models = lines.map(line => {
        // 格式: NAME    ID    SIZE    MODIFIED
        const parts = line.split(/\s{2,}/);
        if (parts.length >= 4) {
          return {
            name: parts[0].trim(),
            id: parts[1].trim(),
            size: parts[2].trim(),
            modified: parts[3].trim()
          };
        }
        return null;
      }).filter(m => m !== null);
      resolve(models);
    });
    child.on('error', (err) => {
      reject(new Error('执行 ollama 命令失败: ' + err.message));
    });
  });
}

// ===== 下载模型（带进度） =====
function pullModel(modelName, onProgress, onComplete) {
  // 🔒 安全修复：验证模型名格式，防止命令注入
  if (!/^[\w.\-:\/]+$/.test(modelName)) {
    onComplete(new Error('模型名称包含非法字符: ' + modelName), null);
    return null;
  }
  const child = spawn('ollama', ['pull', modelName]);

  let lastProgress = 0;
  let totalSize = 0;

  child.stdout.on('data', (data) => {
    const output = data.toString();
    // 解析进度信息
    // 示例: pulling 2bada8a74506: 6% | 303 MB/4.7 GB 5.5 MB/s
    const match = output.match(/pulling\s+([a-f0-9]+):\s+(\d+)%\s+\|\s+([\d.]+)\s+(\w+)\/([\d.]+)\s+(\w+)/);
    if (match) {
      const current = parseFloat(match[3]);
      const unit = match[4];
      const total = parseFloat(match[5]);
      const totalUnit = match[6];
      // 转换为MB
      let currentMB = current;
      if (unit === 'GB') currentMB *= 1024;
      else if (unit === 'KB') currentMB /= 1024;
      let totalMB = total;
      if (totalUnit === 'GB') totalMB *= 1024;
      else if (totalUnit === 'KB') totalMB /= 1024;
      const percent = (currentMB / totalMB) * 100;
      onProgress(Math.min(percent, 100), output);
    } else if (output.includes('pulling manifest')) {
      onProgress(0, '正在获取清单...');
    } else if (output.includes('verifying sha256 digest')) {
      onProgress(100, '正在验证...');
    } else if (output.includes('writing manifest')) {
      onProgress(100, '正在写入...');
    } else if (output.includes('success')) {
      onProgress(100, '下载完成！');
    } else {
      // 其他信息
      onProgress(null, output);
    }
  });

  child.stderr.on('data', (data) => {
    onProgress(null, '错误: ' + data.toString());
  });

  child.on('close', (code) => {
    if (code === 0) {
      onComplete(null, '下载成功');
    } else {
      onComplete(new Error(`下载失败，退出码 ${code}`), null);
    }
  });

  return child;
}

// ===== 删除模型 =====
function deleteModel(modelName) {
  return new Promise((resolve, reject) => {
    // 🔒 安全修复：验证模型名格式，防止命令注入
    if (!/^[\w.\-:\/]+$/.test(modelName)) {
      reject(new Error('模型名称包含非法字符: ' + modelName));
      return;
    }
    // 🔒 安全修复：使用 spawn 替代 exec，防止命令注入
    const child = spawn('ollama', ['rm', modelName]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `删除失败，退出码 ${code}`));
      }
    });
    child.on('error', (err) => {
      reject(new Error('执行 ollama 命令失败: ' + err.message));
    });
  });
}

// ===== 检查模型是否存在 =====
async function modelExists(modelName) {
  const models = await getInstalledModels();
  return models.some(m => m.name === modelName);
}

module.exports = {
  init(_Core) {
    Core = _Core;
    Core.modelManager = {
      getInstalledModels,
      pullModel,
      deleteModel,
      modelExists,
    };
    console.log('✅ 模型管理模块已加载');
  }
};