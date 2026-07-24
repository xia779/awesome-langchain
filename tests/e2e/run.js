// tests/e2e/run.js
// 用项目里的 electron 二进制启动 harness.main.js（作为 app 入口），跑真实桥接 E2E 测试。
// 用法：npm run test:e2e  （或 node tests/e2e/run.js）
'use strict';

const { spawn } = require('child_process');
const path = require('path');

// 在普通 Node 环境里 require('electron') 返回 electron 可执行文件的绝对路径
const electronBinary = require('electron');
const harness = path.join(__dirname, 'harness.main.js');
const projectRoot = path.join(__dirname, '..', '..');

if (typeof electronBinary !== 'string') {
  console.error('[test:e2e] 无法定位 electron 二进制（require("electron") 未返回路径）。');
  console.error('[test:e2e] 请确认已安装依赖：npm install');
  process.exit(1);
}

const child = spawn(electronBinary, [harness], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: Object.assign({}, process.env, { ELECTRON_DISABLE_SECURITY_WARNINGS: '1' })
});

child.on('error', (e) => {
  console.error('[test:e2e] 启动 electron 失败: ' + e.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error('[test:e2e] electron 被信号终止: ' + signal);
    process.exit(1);
  }
  process.exit(code == null ? 1 : code);
});
