// test-node-chain.js — 集成测试客户端
// 验证：node.list → tool.execute 远程路由 → agent.execute 步骤流式推送
const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:3847');
let msgId = 0;
const pending = new Map();

function send(type, payload) {
  const id = 'test_' + (++msgId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, payload }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(type + ' 超时')); }
    }, 90000);
  });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.payload.error));
    else p.resolve(msg.payload);
    return;
  }
  // 事件（无 id）
  if (msg.type === 'agent.step') {
    const s = msg.payload;
    console.log('  [STEP ' + s.step + '/' + (s.maxSteps || '?') + '] ' + s.status + ' — ' + (s.actionZh || s.action || '') +
      (s.params ? ' ' + JSON.stringify(s.params).substring(0, 60) : '') +
      (s.time ? ' (' + s.time + 'ms)' : '') +
      (s.resultPreview ? ' → ' + s.resultPreview.substring(0, 60).replace(/\n/g, ' ') : ''));
  } else if (msg.type === 'agent.complete') {
    console.log('  [COMPLETE] 共 ' + msg.payload.totalSteps + ' 步');
    console.log('  [ANSWER] ' + String(msg.payload.answer).substring(0, 300).replace(/\n/g, ' '));
  } else if (msg.type === 'node.online' || msg.type === 'node.offline') {
    console.log('  [NODE ' + msg.type.split('.')[1].toUpperCase() + '] ' + msg.payload.nodeId);
  }
});

async function main() {
  await new Promise(r => ws.on('open', r));
  console.log('已连接服务端\n');

  // 1. 节点列表
  console.log('=== 测试1: node.list ===');
  const nodes = await send('node.list', {});
  console.log('在线节点:', JSON.stringify(nodes.nodes, null, 1));
  if (!nodes.nodes || nodes.nodes.length === 0) throw new Error('没有在线节点！');
  console.log('PASS: ' + nodes.nodes.length + ' 个节点在线\n');

  // 2. 工具远程路由（list_dir E:/ 只能由桌面节点执行）
  console.log('=== 测试2: tool.execute list_dir E:/ (应路由到节点) ===');
  const t1 = await send('tool.execute', { name: 'list_dir', arguments: { dir_path: 'E:/' } });
  console.log('结果:', String(t1.result).substring(0, 200).replace(/\n/g, ' | '));
  if (!t1.success || String(t1.result).indexOf('[OK]') !== 0) throw new Error('list_dir 失败');
  console.log('PASS: 远程 list_dir 成功\n');

  // 3. run_command (shell 能力)
  console.log('=== 测试3: tool.execute run_command (应路由到节点) ===');
  const t2 = await send('tool.execute', { name: 'run_command', arguments: { command: 'echo hello-from-node' } });
  console.log('结果:', String(t2.result).substring(0, 100).replace(/\n/g, ' '));
  if (String(t2.result).indexOf('hello-from-node') === -1) throw new Error('run_command 未返回预期输出');
  console.log('PASS: 远程 run_command 成功\n');

  // 4. read_url 应留在服务端本地执行（无节点能力映射）
  console.log('=== 测试4: tool.execute read_url (应服务端本地执行) ===');
  const t3 = await send('tool.execute', { name: 'read_url', arguments: { url: 'http://127.0.0.1:3847/health', max_length: 200 } });
  console.log('结果:', String(t3.result).substring(0, 120).replace(/\n/g, ' '));
  console.log('PASS: read_url 本地执行\n');

  // 5. Agent 循环 + 步骤流式推送
  console.log('=== 测试5: agent.execute (观察 agent.step 流式事件) ===');
  const ag = await send('agent.execute', { task: '请列出 E:/ 根目录的内容，并告诉我其中有哪些文件夹' });
  console.log('Agent 启动:', JSON.stringify(ag));
  if (!ag.started) throw new Error('Agent 未启动: ' + ag.error);

  // 等待 agent.complete 事件（通过事件处理器打印，这里等待完成）
  await new Promise((resolve) => {
    const handler = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'agent.complete') { ws.off('message', handler); resolve(); }
    };
    ws.on('message', handler);
    setTimeout(resolve, 120000);
  });

  console.log('\n=== 全部测试完成 ===');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('TEST FAILED:', e.message);
  ws.close();
  process.exit(1);
});
