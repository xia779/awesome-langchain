// -*- coding: utf-8 -*-
// modules/memo.js — 备忘录记事本功能
// 纯文本+文件附件，无 AI 回复，纯备忘录用途
// 依赖: [custom]

'use strict';

var fs = require('fs');
var path = require('path');
var memos = {};
var currentMemoId = null;
var memoDir = '';

  function getMemoDir() {
    var userId = (Core._currentUser) || 'admin';
    var dataRoot = (Core.DATA_ROOT) || 'E:\\my-ai-data';
    return path.join(dataRoot, 'users', userId, 'memos');
  }

  function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function loadMemos() {
    memos = {};
    memoDir = getMemoDir();
    ensureDir(memoDir);
    try {
      var files = fs.readdirSync(memoDir);
      files.forEach(function (file) {
        if (file.endsWith('.json')) {
          try {
            var data = JSON.parse(fs.readFileSync(path.join(memoDir, file), 'utf8'));
            if (data && data.id) memos[data.id] = data;
          } catch (e) {
            console.warn('Memo load fail:', file, e.message);
          }
        }
      });
    } catch (e) {
      console.warn('Memo dir read fail:', e.message);
    }
    console.log('\u2705 \u5907\u5fd5\u5f55\u52a0\u8f7d:', Object.keys(memos).length, '\u4e2a');
  }

  function saveMemo(id) {
    var m = memos[id];
    if (!m) return;
    try {
      m.updatedAt = Date.now();
      var filePath = path.join(memoDir, id + '.json');
      fs.writeFileSync(filePath, JSON.stringify(m, null, 2), 'utf8');
    } catch (e) {
      console.warn('Memo save fail:', e.message);
    }
  }

  function newMemo() {
    var id = 'memo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    memos[id] = {
      id: id,
      title: '\u65b0\u5907\u5fd5\u5f55',
      content: '',
      files: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    currentMemoId = id;
    saveMemo(id);
    renderMemoList();
    renderMemoEditor();
    return id;
  }

  function deleteMemo(id) {
    if (!memos[id]) return;
    try {
      var filePath = path.join(memoDir, id + '.json');
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, filePath + '.deleted');
      }
    } catch (e) {
      console.warn('Memo delete fail:', e.message);
    }
    delete memos[id];
    if (currentMemoId === id) currentMemoId = null;
    var remaining = Object.keys(memos);
    if (remaining.length > 0) {
      currentMemoId = remaining[0];
    }
    renderMemoList();
    renderMemoEditor();
  }

  function renderMemoList() {
    var listEl = document.getElementById('memoList');
    if (!listEl) return;
    var fragment = document.createDocumentFragment();
    var ids = Object.keys(memos).sort(function (a, b) {
      return (memos[b].updatedAt || 0) - (memos[a].updatedAt || 0);
    });
    if (ids.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:20px;text-align:center;color:#666;font-size:14px;';
      empty.textContent = '\u6682\u65e0\u5907\u5fd5\u5f55';
      fragment.appendChild(empty);
    } else {
      ids.forEach(function (id) {
        var m = memos[id];
        var item = document.createElement('div');
        item.className = 'memo-item' + (id === currentMemoId ? ' active' : '');
        item.dataset.id = id;
        var title = document.createElement('div');
        title.className = 'memo-item-title';
        title.textContent = m.title || '\u672a\u547d\u540d';
        var time = document.createElement('div');
        time.className = 'memo-item-time';
        time.textContent = formatTime(m.updatedAt || m.createdAt);
        var fileCount = (m.files && m.files.length > 0) ? ' \u00b7 ' + m.files.length + '\u4e2a\u6587\u4ef6' : '';
        time.textContent += fileCount;
        item.appendChild(title);
        item.appendChild(time);
        fragment.appendChild(item);
      });
    }
    listEl.replaceChildren(fragment);
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var diff = now - d;
    if (diff < 60000) return '\u521a\u521a';
    if (diff < 3600000) return Math.floor(diff / 60000) + '\u5206\u949f\u524d';
    if (d.toDateString() === now.toDateString()) {
      var h = String(d.getHours()).padStart(2, '0');
      var m = String(d.getMinutes()).padStart(2, '0');
      return '\u4eca\u5929 ' + h + ':' + m;
    }
    var mo = d.getMonth() + 1;
    var da = d.getDate();
    return mo + '/' + da;
  }

  function renderMemoEditor() {
    var editor = document.getElementById('memoEditor');
    if (!editor) return;
    if (!currentMemoId || !memos[currentMemoId]) {
      editor.style.display = 'none';
      return;
    }
    editor.style.display = 'flex';
    var m = memos[currentMemoId];
    var titleInput = document.getElementById('memoTitleInput');
    var contentInput = document.getElementById('memoContentInput');
    var fileList = document.getElementById('memoFileList');
    if (titleInput) titleInput.value = m.title || '';
    if (contentInput) contentInput.value = m.content || '';
    if (fileList) {
      var f = document.createDocumentFragment();
      if (m.files && m.files.length > 0) {
        m.files.forEach(function (file, idx) {
          var chip = document.createElement('div');
          chip.className = 'memo-file-chip';
          var icon = document.createElement('span');
          icon.className = 'material-icons-outlined';
          icon.style.cssText = 'font-size:18px;vertical-align:middle;';
          icon.textContent = 'attach_file';
          var name = document.createElement('span');
          name.style.cssText = 'margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;';
          name.textContent = file.name;
          var del = document.createElement('button');
          del.className = 'memo-file-del';
          del.innerHTML = '&times;';
          del.title = '\u5220\u9664\u9644\u4ef6';
          del.dataset.idx = idx;
          chip.appendChild(icon);
          chip.appendChild(name);
          chip.appendChild(del);
          f.appendChild(chip);
        });
      }
      fileList.replaceChildren(f);
    }
  }

  function openMemo() {
    var panel = document.getElementById('memoPanel');
    if (!panel) return;
    if (Object.keys(memos).length === 0) {
      newMemo();
    } else if (!currentMemoId) {
      currentMemoId = Object.keys(memos)[0];
    }
    panel.style.display = 'flex';
    renderMemoList();
    renderMemoEditor();
  }

  function closeMemo() {
    var panel = document.getElementById('memoPanel');
    if (panel) panel.style.display = 'none';
  }

  function attachFiles(files) {
    if (!currentMemoId || !memos[currentMemoId]) return;
    var m = memos[currentMemoId];
    if (!m.files) m.files = [];
    var attachDir = path.join(memoDir, 'attachments');
    ensureDir(attachDir);
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var srcPath = file.path || file.filePath || '';
      if (srcPath) {
        try {
          var destName = Date.now() + '_' + file.name;
          var destPath = path.join(attachDir, destName);
          var fileData = fs.readFileSync(srcPath);
          fs.writeFileSync(destPath, fileData);
          m.files.push({ name: file.name, path: destPath, size: file.size || 0 });
        } catch (e) {
          m.files.push({ name: file.name, path: srcPath, size: file.size || 0, external: true });
          console.warn('File copy failed, stored as reference:', e.message);
        }
      }
    }
    saveMemo(currentMemoId);
    renderMemoEditor();
    renderMemoList();
  }

  function removeFile(idx) {
    if (!currentMemoId || !memos[currentMemoId]) return;
    var m = memos[currentMemoId];
    if (!m.files || idx < 0 || idx >= m.files.length) return;
    var file = m.files[idx];
    if (file.path && !file.external) {
      try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
    }
    m.files.splice(idx, 1);
    saveMemo(currentMemoId);
    renderMemoEditor();
    renderMemoList();
  }

  function init() {
    loadMemos();
    var panel = document.getElementById('memoPanel');
    if (!panel) return;

    var newBtn = document.getElementById('memoNewBtn');
    if (newBtn) newBtn.addEventListener('click', function () { newMemo(); });

    var closeBtn = document.getElementById('memoCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeMemo);

    var delBtn = document.getElementById('memoDeleteBtn');
    if (delBtn) delBtn.addEventListener('click', function () {
      if (currentMemoId) deleteMemo(currentMemoId);
    });

    var titleInput = document.getElementById('memoTitleInput');
    if (titleInput) {
      titleInput.addEventListener('blur', function () {
        if (currentMemoId && memos[currentMemoId]) {
          memos[currentMemoId].title = titleInput.value || '\u672a\u547d\u540d';
          saveMemo(currentMemoId);
          renderMemoList();
        }
      });
      titleInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
      });
    }

    var contentInput = document.getElementById('memoContentInput');
    if (contentInput) {
      var saveTimer = null;
      contentInput.addEventListener('input', function () {
        if (!currentMemoId || !memos[currentMemoId]) return;
        memos[currentMemoId].content = contentInput.value;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
          saveMemo(currentMemoId);
          renderMemoList();
        }, 800);
      });
    }

    var attachBtn = document.getElementById('memoAttachBtn');
    var fileInput = document.getElementById('memoFileInput');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        if (this.files && this.files.length > 0) {
          attachFiles(this.files);
          this.value = '';
        }
      });
    }

    var fileList = document.getElementById('memoFileList');
    if (fileList) {
      fileList.addEventListener('click', function (e) {
        var delBtn = e.target.closest('.memo-file-del');
        if (delBtn) {
          var idx = parseInt(delBtn.dataset.idx, 10);
          if (!isNaN(idx)) removeFile(idx);
        }
      });
    }

    var listEl = document.getElementById('memoList');
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        var item = e.target.closest('.memo-item');
        if (item) {
          currentMemoId = item.dataset.id;
          renderMemoList();
          renderMemoEditor();
        }
      });
    }

    var sidebarBtn = document.getElementById('memoBtn');
    if (sidebarBtn) {
      sidebarBtn.addEventListener('click', function () {
        var p = document.getElementById('memoPanel');
        if (p && p.style.display === 'flex') {
          closeMemo();
        } else {
          openMemo();
        }
      });
    }

    Core.memo = {
      open: openMemo,
      close: closeMemo,
      newMemo: newMemo,
      saveMemo: saveMemo,
      deleteMemo: deleteMemo,
      loadMemos: loadMemos,
      getMemos: function () { return memos; }
    };

    console.log('\u2705 \u5907\u5fd5\u5f55\u6a21\u5757\u5df2\u52a0\u8f7d');
  }

module.exports = { name: 'memo', dependencies: ['custom'], init: init };
