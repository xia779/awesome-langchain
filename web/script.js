// web/script.js (完整修复版)
const chatBox = document.getElementById('chat-box');
const modelSelect = document.getElementById('modelSelect');
const webSearchToggle = document.getElementById('webSearchToggle');

let isProcessing = false;
let currentUser = null;
let currentSessionId = null;

// ===== 安全设置状态栏 =====
function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

// ===== 加载模型列表 =====
async function loadModels() {
  try {
    const resp = await fetch('/api/models');
    if (!resp.ok) throw new Error('获取模型失败');
    const data = await resp.json();
    const models = data.models || [];
    modelSelect.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'qwen2.5:7b';
      opt.textContent = 'qwen2.5:7b (默认)';
      modelSelect.appendChild(opt);
    } else {
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        const size = m.size ? ` (${(m.size / 1024 / 1024 / 1024).toFixed(1)} GB)` : '';
        opt.textContent = m.name + size;
        modelSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('加载模型列表失败:', err);
  }
}

// ===== 用户登录界面 =====
function showLoginUI() {
  fetch('/api/users')
    .then(res => res.json())
    .then(data => {
      const users = data.users || [];
      let html = `
        <div style="text-align:center; padding:20px;">
          <h2 style="color:#e4e4e7; margin-bottom:8px;">👤 选择用户</h2>
          <p style="color:#666; font-size:14px; margin-bottom:16px;">登录以同步聊天记录</p>
          <div style="margin:12px 0;">
      `;
      if (users.length > 0) {
        users.forEach(u => {
          html += `<button onclick="loginUser('${u}')" style="display:block;width:100%;padding:12px;margin:6px 0;background:#1e1e32;border:1px solid #2a2a3e;border-radius:10px;color:#e4e4e7;font-size:16px;cursor:pointer;">${u}</button>`;
        });
      } else {
        html += `<div style="color:#666;font-size:14px;padding:12px;">暂无用户，请在下方创建</div>`;
      }
      html += `
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <input id="loginInput" placeholder="输入用户名" style="flex:1;padding:10px;border-radius:10px;border:1px solid #2a2a3e;background:#141425;color:#e4e4e7;font-size:15px;outline:none;" />
            <button onclick="loginUser()" style="padding:10px 20px;background:#3b82f6;border:none;border-radius:10px;color:#fff;font-weight:600;cursor:pointer;">登录/注册</button>
          </div>
          <div id="loginError" style="color:#ef4444;margin-top:10px;font-size:13px;"></div>
        </div>
      `;
      chatBox.innerHTML = html;
      setStatus('👤 请选择用户');
      setTimeout(() => {
        const inp = document.getElementById('loginInput');
        if (inp) inp.focus();
      }, 100);
    })
    .catch(err => {
      chatBox.innerHTML = `<div style="text-align:center;padding:40px;color:#ef4444;">❌ 连接服务器失败: ${err.message}</div>`;
    });
}

// ===== 登录/注册用户 =====
window.loginUser = function(username) {
  const inputEl = document.getElementById('loginInput');
  const errorEl = document.getElementById('loginError');
  const name = username || (inputEl ? inputEl.value.trim() : '');
  if (!name) {
    if (errorEl) errorEl.textContent = '请输入用户名';
    return;
  }
  if (errorEl) errorEl.textContent = '';

  fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      currentUser = name;
      setStatus(`👤 ${name}`);
      loadSessions();
    } else {
      if (errorEl) errorEl.textContent = data.error || '登录失败';
    }
  })
  .catch(err => {
    if (errorEl) errorEl.textContent = '网络错误: ' + err.message;
  });
};

// ===== 加载会话列表 =====
function loadSessions() {
  if (!currentUser) return;
  fetch(`/api/sessions/${currentUser}`)
    .then(res => res.json())
    .then(data => {
      const sessions = data.sessions || [];
      let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #2a2a3e;flex-shrink:0;">
          <span style="font-size:14px;color:#aaa;">📋 ${currentUser} 的会话</span>
          <button onclick="newSession()" style="background:#3b82f6;border:none;border-radius:8px;color:#fff;padding:4px 12px;cursor:pointer;">+ 新建</button>
          <button onclick="logoutUser()" style="background:transparent;border:1px solid #3a3a52;border-radius:8px;color:#aaa;padding:4px 10px;cursor:pointer;font-size:12px;">切换</button>
        </div>
      `;
      if (sessions.length === 0) {
        html += `<div style="padding:20px;text-align:center;color:#666;font-size:14px;">暂无对话，点击"新建"开始</div>`;
      } else {
        sessions.forEach(s => {
          const active = s.id === currentSessionId ? 'border-left:3px solid #818cf8;background:#1e1e32;' : '';
          html += `<div onclick="switchSession('${s.id}')" style="padding:10px 12px;margin:4px 0;border-radius:8px;cursor:pointer;${active}display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:14px;">${s.title || '新对话'}</span>
            <span onclick="event.stopPropagation();deleteSession('${s.id}')" style="color:#666;cursor:pointer;font-size:12px;">✕</span>
          </div>`;
        });
      }
      chatBox.innerHTML = html;
      if (currentSessionId) {
        loadMessages(currentSessionId);
      } else if (sessions.length > 0) {
        currentSessionId = sessions[0].id;
        loadMessages(currentSessionId);
      } else {
        newSession();
      }
    })
    .catch(err => {
      chatBox.innerHTML = `<div style="padding:20px;color:#ef4444;">加载会话失败: ${err.message}</div>`;
    });
}

// ===== 加载消息 =====
function loadMessages(sessionId) {
  if (!currentUser || !sessionId) return;
  fetch(`/api/sessions/${currentUser}/${sessionId}`)
    .then(res => res.json())
    .then(data => {
      const session = data.session || { messages: [] };
      const messages = session.messages || [];
      
      let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #2a2a3e;flex-shrink:0;">
          <span style="font-size:14px;color:#aaa;">💬 ${session.title || '新对话'}</span>
          <button onclick="backToSessions()" style="background:transparent;border:1px solid #3a3a52;border-radius:8px;color:#aaa;padding:2px 10px;cursor:pointer;font-size:12px;">← 返回</button>
        </div>
      `;
      
      if (messages.length === 0) {
        html += `<div style="padding:40px;text-align:center;color:#666;font-size:14px;">暂无消息，开始聊天吧</div>`;
      } else {
        messages.forEach(msg => {
          const role = msg.role === 'user' ? 'user' : 'ai';
          html += `<div class="msg ${role}">${msg.content}</div>`;
        });
      }
      
      // 输入区域（唯一一个）
      html += `
        <div style="margin-top:auto;padding-top:10px;border-top:1px solid #2a2a3e;flex-shrink:0;">
          <div style="display:flex;gap:8px;">
            <input id="input" placeholder="输入消息..." style="flex:1;padding:10px 14px;border:none;border-radius:24px;background:#1e1e32;color:#e4e4e7;font-size:15px;outline:none;border:1px solid #2a2a3e;" />
            <button id="send" style="padding:10px 20px;border:none;border-radius:24px;background:#818cf8;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">发送</button>
          </div>
          <div style="font-size:12px;color:#666;text-align:center;padding-top:6px;" id="status">✅ 已就绪</div>
        </div>
      `;
      
      chatBox.innerHTML = html;
      chatBox.scrollTop = chatBox.scrollHeight;

      // 绑定事件（使用 onclick 和 onkeydown 避免多次监听叠加）
      const inputEl = document.getElementById('input');
      const sendEl = document.getElementById('send');
      if (inputEl && sendEl) {
        sendEl.onclick = () => sendMessage();
        inputEl.onkeydown = (e) => {
          if (e.key === 'Enter') sendMessage();
        };
        setTimeout(() => inputEl.focus(), 100);
      }
    })
    .catch(err => {
      chatBox.innerHTML = `<div style="padding:20px;color:#ef4444;">加载消息失败: ${err.message}</div>`;
    });
}

// ===== 切换会话 =====
window.switchSession = function(sessionId) {
  currentSessionId = sessionId;
  loadMessages(sessionId);
};

// ===== 新建会话 =====
window.newSession = function() {
  if (!currentUser) return;
  const newId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  fetch(`/api/sessions/${currentUser}/${newId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '新对话' })
  })
  .then(res => res.json())
  .then(() => {
    currentSessionId = newId;
    loadMessages(newId);
  })
  .catch(err => console.error('创建会话失败:', err));
};

// ===== 删除会话 =====
window.deleteSession = function(sessionId) {
  if (!currentUser || !confirm('确定要删除此会话吗？')) return;
  fetch(`/api/sessions/${currentUser}/${sessionId}`, {
    method: 'DELETE'
  })
  .then(() => {
    if (currentSessionId === sessionId) currentSessionId = null;
    loadSessions();
  })
  .catch(err => console.error('删除会话失败:', err));
};

// ===== 返回会话列表 =====
window.backToSessions = function() {
  loadSessions();
};

// ===== 登出 =====
window.logoutUser = function() {
  currentUser = null;
  currentSessionId = null;
  showLoginUI();
};

// ===== 发送消息 =====
async function sendMessage() {
  const inputEl = document.getElementById('input');
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text || isProcessing || !currentUser || !currentSessionId) return;
  inputEl.value = '';
  isProcessing = true;
  const sendBtnEl = document.getElementById('send');
  if (sendBtnEl) sendBtnEl.disabled = true;
  setStatus('⏳ 思考中...');

  // 添加用户消息
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg user';
  msgDiv.textContent = text;
  const inputArea = chatBox.querySelector('div[style*="margin-top:auto"]');
  if (inputArea) {
    chatBox.insertBefore(msgDiv, inputArea);
  } else {
    chatBox.appendChild(msgDiv);
  }
  chatBox.scrollTop = chatBox.scrollHeight;

  const model = modelSelect.value;
  const webSearch = webSearchToggle.checked;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: text,
        model,
        webSearch,
        username: currentUser,
        sessionId: currentSessionId
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`服务器错误: ${resp.status} ${err}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let isFirstChunk = true;

    const aiDiv = document.createElement('div');
    aiDiv.className = 'msg ai';
    const inputArea2 = chatBox.querySelector('div[style*="margin-top:auto"]');
    if (inputArea2) {
      chatBox.insertBefore(aiDiv, inputArea2);
    } else {
      chatBox.appendChild(aiDiv);
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.trim().startsWith('data: '));
      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          if (json.response) {
            full += json.response;
            aiDiv.textContent = full;
            chatBox.scrollTop = chatBox.scrollHeight;
            if (isFirstChunk) {
              isFirstChunk = false;
              setStatus('✍️ 生成中...');
            }
          }
        } catch (e) {}
      }
    }
    setStatus('✅ 已就绪');
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.className = 'msg ai';
    errDiv.textContent = `❌ 错误: ${err.message}`;
    errDiv.style.color = '#ef4444';
    const inputArea3 = chatBox.querySelector('div[style*="margin-top:auto"]');
    if (inputArea3) {
      chatBox.insertBefore(errDiv, inputArea3);
    } else {
      chatBox.appendChild(errDiv);
    }
    setStatus('❌ 连接失败');
    console.error(err);
  }

  isProcessing = false;
  if (sendBtnEl) sendBtnEl.disabled = false;
  const newInput = document.getElementById('input');
  if (newInput) newInput.focus();
}

// ===== 初始化 =====
loadModels();
showLoginUI();