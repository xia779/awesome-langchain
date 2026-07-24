// preload.js - Electron 42 Secure Bridge (contextIsolation: true)
// Migrated from nodeIntegration:true/contextIsolation:false
// Exposes all required Node.js APIs via contextBridge.exposeInMainWorld('nodeBridge', ...)
'use strict';

const { ipcRenderer, contextBridge, shell, clipboard, Notification, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync: cpExecSync, exec: cpExec, spawn: cpSpawn } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ===== Project paths =====
const ROOT_DIR = __dirname;
const MODULES_DIR = path.join(ROOT_DIR, 'modules');
const DATA_ROOT = path.join(ROOT_DIR, 'data');
const NODE_MODULES_DIR = path.join(ROOT_DIR, 'node_modules');

// ===== Helper: convert fs.Stats to plain object =====
function safeStat(stats) {
  if (!stats) return null;
  var isDir = stats.isDirectory();
  var isFile = stats.isFile();
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    _isDir: isDir,
    _isFile: isFile,
    isDirectory: function() { return isDir; },
    isFile: function() { return isFile; },
    isSymbolicLink: function() { return stats.isSymbolicLink ? stats.isSymbolicLink() : false; }
  };
}

// ===== Helper: wrap errors =====
function wrapErr(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ===== Helper: Buffer proxy (crosses contextBridge as plain object) =====
function createBufferProxy(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const b64 = buf.toString('base64');
  return {
    _isBufferProxy: true,
    _b64: b64,
    length: buf.length,
    toString: function(encoding, start, end) { return buf.toString(encoding || 'utf8', start, end); },
    slice: function(start, end) { return createBufferProxy(buf.slice(start, end)); },
    subarray: function(start, end) { return createBufferProxy(buf.subarray(start, end)); },
    write: function(str, offset, length, encoding) {
      if (typeof length === 'string') { encoding = length; length = undefined; }
      return buf.write(str, offset || 0, length, encoding || 'utf8');
    },
    indexOf: function(val, byteOffset, encoding) { return buf.indexOf(val, byteOffset, encoding); },
    includes: function(val, byteOffset, encoding) { return buf.includes(val, byteOffset, encoding); },
    equals: function(other) {
      var otherBuf = unwrapBuffer(other);
      return buf.equals(otherBuf);
    },
    compare: function(other) {
      var otherBuf = unwrapBuffer(other);
      return buf.compare(otherBuf);
    },
    copy: function(target, targetStart, sourceStart, sourceEnd) {
      // copy is a no-op across bridge (target is in renderer); return bytes that would be copied
      return Math.min(buf.length - (sourceStart || 0), (target && target.length) || buf.length);
    },
    fill: function(val, offset, end) { buf.fill(val, offset, end); return createBufferProxy(buf); },
    readUInt8: function(offset) { return buf.readUInt8(offset); },
    readUInt16LE: function(offset) { return buf.readUInt16LE(offset); },
    readUInt16BE: function(offset) { return buf.readUInt16BE(offset); },
    readUInt32LE: function(offset) { return buf.readUInt32LE(offset); },
    readUInt32BE: function(offset) { return buf.readUInt32BE(offset); },
    readInt8: function(offset) { return buf.readInt8(offset); },
    readInt16LE: function(offset) { return buf.readInt16LE(offset); },
    readInt32LE: function(offset) { return buf.readInt32LE(offset); },
    readFloatLE: function(offset) { return buf.readFloatLE(offset); },
    readDoubleLE: function(offset) { return buf.readDoubleLE(offset); },
    writeUInt8: function(val, offset) { buf.writeUInt8(val, offset); return createBufferProxy(buf); },
    writeUInt16LE: function(val, offset) { buf.writeUInt16LE(val, offset); return createBufferProxy(buf); },
    writeUInt32LE: function(val, offset) { buf.writeUInt32LE(val, offset); return createBufferProxy(buf); },
    toJSON: function() { return { type: 'Buffer', data: Array.from(buf) }; },
    values: function() { return Array.from(buf); }
  };
}

// ===== Helper: unwrap BufferProxy or base64 string back to real Buffer =====
function unwrapBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data && data._isBufferProxy && data._b64) return Buffer.from(data._b64, 'base64');
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  return Buffer.from(String(data));
}

// ===== Optional native modules =====
let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[preload] better-sqlite3 not available:', e.message);
}

let WebSocketServer = null;
try {
  const wsModule = require('ws');
  WebSocketServer = wsModule.Server || wsModule.WebSocketServer;
} catch (e) {
  console.warn('[preload] ws module not available:', e.message);
}

let DOMPurify = null;
try {
  const { JSDOM } = require('jsdom');
  const createDOMPurify = require('dompurify');
  const domWindow = new JSDOM('').window;
  DOMPurify = createDOMPurify(domWindow);
} catch (e) {
  // 渲染进程已通过 index.html 直接加载 DOMPurify 浏览器版（有真实 window/DOM，无需 jsdom），
  // preload 侧仅为兜底；缺失属预期情况，降级为 debug 日志，不再刷黄色警告。
  console.debug('[preload] DOMPurify/jsdom 兜底不可用（渲染进程已原生加载 DOMPurify）:', e.message);
}

// ============================================================
// 1. fs bridge
// ============================================================
const fsBridge = {
  readFileSync: (filePath, options) => wrapErr(() => {
    const result = fs.readFileSync(filePath, options);
    if (Buffer.isBuffer(result)) {
      // If encoding was specified, return string; otherwise return BufferProxy
      const enc = (typeof options === 'string') ? options : (options && options.encoding);
      if (enc) return result.toString(enc);
      return createBufferProxy(result);
    }
    return result;
  }),
  writeFileSync: (filePath, data, options) => wrapErr(() => {
    const realData = (data && data._isBufferProxy) ? unwrapBuffer(data) : data;
    fs.writeFileSync(filePath, realData, options);
    return true;
  }),
  existsSync: (filePath) => wrapErr(() => fs.existsSync(filePath)),
  mkdirSync: (dirPath, options) => wrapErr(() => {
    const result = fs.mkdirSync(dirPath, options);
    return result !== undefined ? String(result) : true;
  }),
  readdirSync: (dirPath, options) => wrapErr(() => {
    const entries = fs.readdirSync(dirPath, options);
    if (options && options.withFileTypes) {
      return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymbolicLink: e.isSymbolicLink() }));
    }
    return entries;
  }),
  statSync: (filePath, options) => wrapErr(() => safeStat(fs.statSync(filePath, options))),
  lstatSync: (filePath, options) => wrapErr(() => safeStat(fs.lstatSync(filePath, options))),
  unlinkSync: (filePath) => wrapErr(() => { fs.unlinkSync(filePath); return true; }),
  renameSync: (oldPath, newPath) => wrapErr(() => { fs.renameSync(oldPath, newPath); return true; }),
  copyFileSync: (src, dest, mode) => wrapErr(() => { fs.copyFileSync(src, dest, mode); return true; }),
  appendFileSync: (filePath, data, options) => wrapErr(() => { const d = (data && data._isBufferProxy) ? unwrapBuffer(data) : data; fs.appendFileSync(filePath, d, options); return true; }),
  rmSync: (target, options) => wrapErr(() => { fs.rmSync(target, options); return true; }),
  rmdirSync: (dirPath, options) => wrapErr(() => { fs.rmdirSync(dirPath, options); return true; }),
  accessSync: (filePath, mode) => wrapErr(() => { fs.accessSync(filePath, mode); return true; }),
  chmodSync: (filePath, mode) => wrapErr(() => { fs.chmodSync(filePath, mode); return true; }),
  realpathSync: (filePath) => wrapErr(() => fs.realpathSync(filePath)),

  // Async methods (callback-based converted to Promise)
  readFile: (filePath, options) => new Promise((resolve, reject) => {
    fs.readFile(filePath, options, (err, data) => {
      if (err) return reject({ error: err.message });
      if (Buffer.isBuffer(data)) {
        const enc = (typeof options === 'string') ? options : (options && options.encoding);
        if (enc) return resolve(data.toString(enc));
        return resolve(createBufferProxy(data));
      }
      resolve(data);
    });
  }),
  writeFile: (filePath, data, options) => new Promise((resolve, reject) => {
    const d = (data && data._isBufferProxy) ? unwrapBuffer(data) : data;
    fs.writeFile(filePath, d, options, (err) => {
      if (err) return reject({ error: err.message });
      resolve(true);
    });
  }),
  mkdir: (dirPath, options) => new Promise((resolve, reject) => {
    fs.mkdir(dirPath, options, (err, result) => {
      if (err) return reject({ error: err.message });
      resolve(result !== undefined ? String(result) : true);
    });
  }),
  readdir: (dirPath, options) => new Promise((resolve, reject) => {
    fs.readdir(dirPath, options, (err, entries) => {
      if (err) return reject({ error: err.message });
      if (options && options.withFileTypes) {
        return resolve(entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymbolicLink: e.isSymbolicLink() })));
      }
      resolve(entries);
    });
  }),
  stat: (filePath, options) => new Promise((resolve, reject) => {
    fs.stat(filePath, options, (err, stats) => {
      if (err) return reject({ error: err.message });
      resolve(safeStat(stats));
    });
  }),
  unlink: (filePath) => new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err) return reject({ error: err.message });
      resolve(true);
    });
  }),
  rename: (oldPath, newPath) => new Promise((resolve, reject) => {
    fs.rename(oldPath, newPath, (err) => {
      if (err) return reject({ error: err.message });
      resolve(true);
    });
  }),
  copyFile: (src, dest, mode) => new Promise((resolve, reject) => {
    fs.copyFile(src, dest, mode, (err) => {
      if (err) return reject({ error: err.message });
      resolve(true);
    });
  }),
  appendFile: (filePath, data, options) => new Promise((resolve, reject) => {
    const d = (data && data._isBufferProxy) ? unwrapBuffer(data) : data;
    fs.appendFile(filePath, d, options, (err) => {
      if (err) return reject({ error: err.message });
      resolve(true);
    });
  }),
  rm: (target, options) => new Promise((resolve, reject) => {
    fs.rm(target, options, (err) => {
      if (err) return reject({ error: err.message });
      resolve(true);
    });
  }),

  // watch - returns a watcherId, events relayed via callback
  _watchers: new Map(),
  _watcherIdCounter: 1,
  watch: (filePath, options, callback) => {
    try {
      const id = fsBridge._watcherIdCounter++;
      const watcher = fs.watch(filePath, options || {}, (eventType, filename) => {
        if (callback) callback(eventType, filename);
      });
      watcher.on('error', (err) => {
        if (callback) callback('error', err.message);
      });
      fsBridge._watchers.set(id, watcher);
      return id;
    } catch (e) {
      return { error: e.message };
    }
  },
  unwatch: (watcherId) => {
    const watcher = fsBridge._watchers.get(watcherId);
    if (watcher) {
      watcher.close();
      fsBridge._watchers.delete(watcherId);
    }
    return true;
  },

  // Streams - managed in preload, relayed via callbacks
  _streams: new Map(),
  _streamIdCounter: 1,
  createReadStream: (filePath, options) => {
    try {
      const id = fsBridge._streamIdCounter++;
      const stream = fs.createReadStream(filePath, options);
      fsBridge._streams.set(id, stream);
      return id;
    } catch (e) {
      return { error: e.message };
    }
  },
  createWriteStream: (filePath, options) => {
    try {
      const id = fsBridge._streamIdCounter++;
      const stream = fs.createWriteStream(filePath, options);
      fsBridge._streams.set(id, stream);
      return id;
    } catch (e) {
      return { error: e.message };
    }
  },
  streamOnData: (streamId, callback) => {
    const stream = fsBridge._streams.get(streamId);
    if (!stream) return { error: 'Stream not found' };
    stream.on('data', (chunk) => {
      callback(Buffer.isBuffer(chunk) ? chunk.toString('base64') : chunk);
    });
    return true;
  },
  streamOnEnd: (streamId, callback) => {
    const stream = fsBridge._streams.get(streamId);
    if (!stream) return { error: 'Stream not found' };
    stream.on('end', () => callback());
    return true;
  },
  streamOnError: (streamId, callback) => {
    const stream = fsBridge._streams.get(streamId);
    if (!stream) return { error: 'Stream not found' };
    stream.on('error', (err) => callback(err.message));
    return true;
  },
  streamOnFinish: (streamId, callback) => {
    const stream = fsBridge._streams.get(streamId);
    if (!stream) return { error: 'Stream not found' };
    stream.on('finish', () => callback());
    return true;
  },
  streamWrite: (streamId, data, encoding) => {
    const stream = fsBridge._streams.get(streamId);
    if (!stream) return { error: 'Stream not found' };
    return stream.write(data, encoding || 'utf8');
  },
  streamEnd: (streamId, data, encoding) => {
    const stream = fsBridge._streams.get(streamId);
    if (!stream) return { error: 'Stream not found' };
    if (data !== undefined && data !== null) {
      stream.end(data, encoding || 'utf8');
    } else {
      stream.end();
    }
    return true;
  },
  streamDestroy: (streamId) => {
    const stream = fsBridge._streams.get(streamId);
    if (stream) {
      stream.destroy();
      fsBridge._streams.delete(streamId);
    }
    return true;
  },
  streamPipe: (readStreamId, writeStreamId) => {
    const rs = fsBridge._streams.get(readStreamId);
    const ws = fsBridge._streams.get(writeStreamId);
    if (!rs || !ws) return { error: 'Stream not found' };
    rs.pipe(ws);
    return true;
  }
};

// ============================================================
// 2. path bridge
// ============================================================
const pathBridge = {
  join: (...args) => path.join(...args),
  resolve: (...args) => path.resolve(...args),
  dirname: (p) => path.dirname(p),
  basename: (p, ext) => path.basename(p, ext),
  extname: (p) => path.extname(p),
  normalize: (p) => path.normalize(p),
  sep: path.sep,
  delimiter: path.delimiter,
  isAbsolute: (p) => path.isAbsolute(p),
  relative: (from, to) => path.relative(from, to),
  parse: (p) => {
    const parsed = path.parse(p);
    return { root: parsed.root, dir: parsed.dir, base: parsed.base, ext: parsed.ext, name: parsed.name };
  },
  format: (obj) => path.format(obj)
};

// ============================================================
// 3. crypto bridge
// ============================================================
const cryptoBridge = {
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (size, encoding) => {
    const buf = crypto.randomBytes(size);
    if (encoding) return buf.toString(encoding);
    return createBufferProxy(buf);
  },
  createHash: (algorithm) => {
    const hash = crypto.createHash(algorithm);
    const proxy = {
      update: (data, inputEncoding) => {
        if (data && data._isBufferProxy) {
          hash.update(unwrapBuffer(data));
        } else {
          hash.update(data, inputEncoding || 'utf8');
        }
        return proxy;
      },
      digest: (encoding) => {
        if (encoding) return hash.digest(encoding);
        return createBufferProxy(hash.digest());
      }
    };
    return proxy;
  },
  createHmac: (algorithm, key, keyEncoding) => {
    const keyBuf = (key && key._isBufferProxy) ? unwrapBuffer(key) : (keyEncoding ? Buffer.from(key, keyEncoding) : key);
    const hmac = crypto.createHmac(algorithm, keyBuf);
    const proxy = {
      update: (data, inputEncoding) => {
        if (data && data._isBufferProxy) {
          hmac.update(unwrapBuffer(data));
        } else {
          hmac.update(data, inputEncoding || 'utf8');
        }
        return proxy;
      },
      digest: (encoding) => {
        if (encoding) return hmac.digest(encoding);
        return createBufferProxy(hmac.digest());
      }
    };
    return proxy;
  },
  timingSafeEqual: (a, b) => {
    try {
      const bufA = unwrapBuffer(a);
      const bufB = unwrapBuffer(b);
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
      return { error: e.message };
    }
  },
  pbkdf2Sync: (password, salt, iterations, keylen, digest) => {
    const passBuf = (password && password._isBufferProxy) ? unwrapBuffer(password) : password;
    const saltBuf = (salt && salt._isBufferProxy) ? unwrapBuffer(salt) : salt;
    const result = crypto.pbkdf2Sync(passBuf, saltBuf, iterations, keylen, digest || 'sha256');
    return result.toString('hex');
  },
  randomInt: (min, max) => crypto.randomInt(min, max),
  createCipheriv: (algorithm, key, iv) => {
    try {
      const keyBuf = (key && key._isBufferProxy) ? unwrapBuffer(key) : Buffer.from(key, 'hex');
      const ivBuf = iv ? ((iv._isBufferProxy) ? unwrapBuffer(iv) : Buffer.from(iv, 'hex')) : null;
      const cipher = crypto.createCipheriv(algorithm, keyBuf, ivBuf);
      return {
        update: (data, inputEnc, outputEnc) => {
          const d = (data && data._isBufferProxy) ? unwrapBuffer(data) : data;
          return cipher.update(d, inputEnc || 'utf8', outputEnc || 'hex');
        },
        final: (outputEnc) => cipher.final(outputEnc || 'hex'),
        getAuthTag: () => { try { return cipher.getAuthTag().toString('hex'); } catch (e) { return null; } }
      };
    } catch (e) {
      return { error: e.message };
    }
  },
  createDecipheriv: (algorithm, key, iv) => {
    try {
      const keyBuf = (key && key._isBufferProxy) ? unwrapBuffer(key) : Buffer.from(key, 'hex');
      const ivBuf = iv ? ((iv._isBufferProxy) ? unwrapBuffer(iv) : Buffer.from(iv, 'hex')) : null;
      const decipher = crypto.createDecipheriv(algorithm, keyBuf, ivBuf);
      return {
        update: (data, inputEnc, outputEnc) => {
          const d = (data && data._isBufferProxy) ? unwrapBuffer(data) : data;
          return decipher.update(d, inputEnc || 'hex', outputEnc || 'utf8');
        },
        final: (outputEnc) => decipher.final(outputEnc || 'utf8'),
        setAuthTag: (tag) => { try { decipher.setAuthTag((tag && tag._isBufferProxy) ? unwrapBuffer(tag) : Buffer.from(tag, 'hex')); return true; } catch (e) { return { error: e.message }; } }
      };
    } catch (e) {
      return { error: e.message };
    }
  }
};

// ============================================================
// 4. os bridge
// ============================================================
const osBridge = {
  platform: () => os.platform(),
  arch: () => os.arch(),
  homedir: () => os.homedir(),
  tmpdir: () => os.tmpdir(),
  hostname: () => os.hostname(),
  cpus: () => os.cpus().map(c => ({ model: c.model, speed: c.speed, times: { user: c.times.user, nice: c.times.nice, sys: c.times.sys, idle: c.times.idle, irq: c.times.irq } })),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  networkInterfaces: () => {
    const ifaces = os.networkInterfaces();
    const result = {};
    for (const [name, addrs] of Object.entries(ifaces)) {
      result[name] = addrs.map(a => ({
        address: a.address, netmask: a.netmask, family: a.family,
        mac: a.mac, internal: a.internal, cidr: a.cidr
      }));
    }
    return result;
  },
  EOL: os.EOL,
  type: () => os.type(),
  release: () => os.release(),
  uptime: () => os.uptime(),
  loadavg: () => os.loadavg(),
  userInfo: () => {
    const info = os.userInfo();
    return { username: info.username, homedir: info.homedir, shell: info.shell, uid: info.uid, gid: info.gid };
  }
};

// ============================================================
// 5. childProcess bridge
// ============================================================
const childProcessBridge = {
  execSync: (cmd, opts) => {
    try {
      const options = Object.assign({}, opts, { encoding: opts && opts.encoding ? opts.encoding : 'utf8' });
      const stdout = cpExecSync(cmd, options);
      return { stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'), stderr: '' };
    } catch (e) {
      return {
        stdout: e.stdout ? (typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf8')) : '',
        stderr: e.stderr ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString('utf8')) : e.message,
        error: e.message,
        status: e.status
      };
    }
  },
  exec: (cmd, opts) => {
    return new Promise((resolve) => {
      const options = Object.assign({}, opts, { encoding: opts && opts.encoding ? opts.encoding : 'utf8' });
      cpExec(cmd, options, (error, stdout, stderr) => {
        resolve({
          stdout: typeof stdout === 'string' ? stdout : (stdout ? stdout.toString('utf8') : ''),
          stderr: typeof stderr === 'string' ? stderr : (stderr ? stderr.toString('utf8') : ''),
          code: error ? (error.code || 1) : 0,
          error: error ? error.message : null
        });
      });
    });
  },
  spawn: (cmd, args, opts) => {
    try {
      const child = cpSpawn(cmd, args || [], opts || {});
      const wrapper = {
        pid: child.pid,
        kill: (signal) => {
          try { child.kill(signal); return true; } catch (e) { return { error: e.message }; }
        },
        onData: (cb) => {
          child.stdout.on('data', (data) => cb(Buffer.isBuffer(data) ? data.toString('utf8') : data));
          return wrapper;
        },
        onStderr: (cb) => {
          child.stderr.on('data', (data) => cb(Buffer.isBuffer(data) ? data.toString('utf8') : data));
          return wrapper;
        },
        onExit: (cb) => {
          child.on('exit', (code, signal) => cb(code, signal));
          return wrapper;
        },
        onEnd: (cb) => {
          child.on('close', (code, signal) => cb(code, signal));
          return wrapper;
        },
        onError: (cb) => {
          child.on('error', (err) => cb(err.message));
          return wrapper;
        },
        write: (data) => {
          try { child.stdin.write(data); return true; } catch (e) { return { error: e.message }; }
        },
        end: () => {
          try { child.stdin.end(); return true; } catch (e) { return { error: e.message }; }
        },
        // 🔧 兼容标准 Node.js ChildProcess .on() API（python.js 等模块使用）
        on: (event, cb) => {
          if (event === 'close') child.on('close', (code, signal) => cb(code, signal));
          else if (event === 'exit') child.on('exit', (code, signal) => cb(code, signal));
          else if (event === 'error') child.on('error', (err) => cb(err));
          else if (event === 'data') child.stdout.on('data', (d) => cb(Buffer.isBuffer(d) ? d.toString('utf8') : d));
          else child.on(event, cb);
          return wrapper;
        },
        stdout: { on: (ev, cb) => { child.stdout.on(ev, (d) => cb(Buffer.isBuffer(d) ? d.toString('utf8') : d)); return wrapper; } },
        stderr: { on: (ev, cb) => { child.stderr.on(ev, (d) => cb(Buffer.isBuffer(d) ? d.toString('utf8') : d)); return wrapper; } },
        stdin: { write: (d) => { try { child.stdin.write(d); return true; } catch (e) { return false; } }, end: () => { try { child.stdin.end(); return true; } catch (e) { return false; } } }
      };
      return wrapper;
    } catch (e) {
      return { error: e.message, pid: null };
    }
  }
};

// ============================================================
// 6. buffer bridge
// ============================================================
const bufferBridge = {
  from: (data, encodingOrOffset, length) => {
    // Buffer.from(str, encoding) / Buffer.from(array) / Buffer.from(buffer)
    if (data && data._isBufferProxy && data._b64) {
      return createBufferProxy(Buffer.from(data._b64, 'base64'));
    }
    if (typeof data === 'string') {
      return createBufferProxy(Buffer.from(data, encodingOrOffset || 'utf8'));
    }
    if (Array.isArray(data)) {
      return createBufferProxy(Buffer.from(data));
    }
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      return createBufferProxy(Buffer.from(data));
    }
    return createBufferProxy(Buffer.from(String(data)));
  },
  alloc: (size, fill, encoding) => {
    return createBufferProxy(Buffer.alloc(size, fill, encoding));
  },
  allocUnsafe: (size) => {
    return createBufferProxy(Buffer.allocUnsafe(size));
  },
  concat: (list, totalLength) => {
    const buffers = list.map(item => unwrapBuffer(item));
    return createBufferProxy(Buffer.concat(buffers, totalLength));
  },
  isBuffer: (obj) => {
    return !!(obj && obj._isBufferProxy);
  },
  byteLength: (str, encoding) => {
    if (str && str._isBufferProxy) return str.length;
    return Buffer.byteLength(str, encoding || 'utf8');
  },
  compare: (a, b) => {
    return unwrapBuffer(a).compare(unwrapBuffer(b));
  },
  isEncoding: (encoding) => Buffer.isEncoding(encoding),
  // Legacy helpers (kept for backward compat)
  toBase64: (str, encoding) => Buffer.from(str, encoding || 'utf8').toString('base64'),
  fromBase64ToString: (b64, encoding) => Buffer.from(b64, 'base64').toString(encoding || 'utf8'),
  toHex: (str, encoding) => Buffer.from(str, encoding || 'utf8').toString('hex'),
  fromHex: (hex) => Buffer.from(hex, 'hex').toString('utf8')
};

// ============================================================
// 7. processInfo bridge
// ============================================================
const processInfoBridge = {
  platform: process.platform,
  arch: process.arch,
  get env() {
    return JSON.parse(JSON.stringify(process.env));
  },
  cwd: () => process.cwd(),
  pid: process.pid,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    v8: process.versions.v8
  },
  execPath: process.execPath,
  uptime: () => process.uptime(),
  memoryUsage: () => {
    const mem = process.memoryUsage();
    return { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external, arrayBuffers: mem.arrayBuffers };
  },
  hrtime: () => {
    const t = process.hrtime();
    return [t[0], t[1]];
  },
  nextTick: (cb) => { process.nextTick(cb); }
};

// ============================================================
// 8. httpRequest bridge
// ============================================================
function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: (options && options.method) || 'GET',
        headers: (options && options.headers) || {},
        timeout: (options && options.timeout) || 30000
      };
      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: Object.assign({}, res.headers),
            body: bodyBuf.toString('utf8')
          });
        });
        res.on('error', (err) => reject({ error: err.message }));
      });
      req.on('error', (err) => reject({ error: err.message }));
      req.on('timeout', () => { req.destroy(); reject({ error: 'Request timeout' }); });
      if (options && options.body) {
        req.write(options.body);
      }
      req.end();
    } catch (e) {
      reject({ error: e.message });
    }
  });
}

function httpRequestStream(url, options, onData, onEnd, onError) {
  try {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {},
      timeout: (options && options.timeout) || 60000
    };
    const req = lib.request(opts, (res) => {
      if (onData) onData({ statusCode: res.statusCode, headers: Object.assign({}, res.headers) });
      res.on('data', (chunk) => {
        if (onData) onData({ chunk: chunk.toString('utf8') });
      });
      res.on('end', () => { if (onEnd) onEnd(); });
      res.on('error', (err) => { if (onError) onError(err.message); });
    });
    req.on('error', (err) => { if (onError) onError(err.message); });
    req.on('timeout', () => { req.destroy(); if (onError) onError('Request timeout'); });
    if (options && options.body) req.write(options.body);
    req.end();
    return { abort: () => req.destroy() };
  } catch (e) {
    if (onError) onError(e.message);
    return { abort: () => {} };
  }
}

const httpBridge = {
  request: httpRequest,
  requestStream: httpRequestStream,
  get: (url, options) => httpRequest(url, Object.assign({}, options, { method: 'GET' })),
  post: (url, body, options) => httpRequest(url, Object.assign({}, options, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
};

// ===== Streaming-compatible http.request (mimics Node.js API for modules) =====
function httpNodeRequest(urlOrOptions, optionsOrCallback, maybeCallback) {
  // Normalize arguments: request(url, opts, cb) / request(opts, cb) / request(url, cb)
  let opts = {};
  let callback = null;
  let isHttps = false;

  if (typeof urlOrOptions === 'string') {
    try {
      const parsed = new URL(urlOrOptions);
      isHttps = parsed.protocol === 'https:';
      opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        protocol: parsed.protocol
      };
    } catch (e) {
      opts = { path: urlOrOptions };
    }
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    } else if (optionsOrCallback && typeof optionsOrCallback === 'object') {
      Object.assign(opts, optionsOrCallback);
      callback = maybeCallback || null;
    }
  } else if (urlOrOptions && typeof urlOrOptions === 'object') {
    opts = Object.assign({}, urlOrOptions);
    callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback || null);
  }

  if (opts.protocol === 'https:' || opts.port === 443) isHttps = true;
  const lib = isHttps ? https : http;

  const realReq = lib.request(opts, (res) => {
    // Build a response proxy with .on() method for streaming
    const resProxy = {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage || '',
      headers: Object.assign({}, res.headers),
      httpVersion: res.httpVersion,
      on: function(event, handler) {
        if (event === 'data') {
          res.on('data', (chunk) => { handler(createBufferProxy(chunk)); });
        } else if (event === 'end') {
          res.on('end', handler);
        } else if (event === 'error') {
          res.on('error', (err) => handler(err));
        } else if (event === 'close') {
          res.on('close', handler);
        } else {
          res.on(event, handler);
        }
        return resProxy;
      },
      setEncoding: function(enc) { res.setEncoding(enc); return resProxy; },
      resume: function() { res.resume(); return resProxy; },
      pause: function() { res.pause(); return resProxy; }
    };
    if (callback) callback(resProxy);
  });

  // Build request proxy with .write()/.end()/.on()/.destroy()
  const reqProxy = {
    write: function(data, encoding, cb) {
      if (data && data._isBufferProxy && data._b64) {
        realReq.write(Buffer.from(data._b64, 'base64'), cb);
      } else {
        realReq.write(data, encoding, cb);
      }
      return reqProxy;
    },
    end: function(data, encoding, cb) {
      if (data) {
        if (data._isBufferProxy && data._b64) {
          realReq.end(Buffer.from(data._b64, 'base64'), cb);
        } else {
          realReq.end(data, encoding, cb);
        }
      } else {
        realReq.end();
      }
      return reqProxy;
    },
    destroy: function(err) { realReq.destroy(err); return reqProxy; },
    abort: function() { realReq.destroy(); },
    setTimeout: function(ms, cb) { realReq.setTimeout(ms, cb); return reqProxy; },
    setNoDelay: function(noDelay) { realReq.setNoDelay(noDelay); return reqProxy; },
    setSocketKeepAlive: function(enable, ms) { realReq.setSocketKeepAlive(enable, ms); return reqProxy; },
    on: function(event, handler) {
      if (event === 'error') {
        realReq.on('error', (err) => handler(err));
      } else if (event === 'timeout') {
        realReq.on('timeout', handler);
      } else if (event === 'response') {
        realReq.on('response', (res) => {
          const resProxy = {
            statusCode: res.statusCode,
            headers: Object.assign({}, res.headers),
            on: function(ev, h) {
              if (ev === 'data') res.on('data', (c) => h(createBufferProxy(c)));
              else if (ev === 'end') res.on('end', h);
              else if (ev === 'error') res.on('error', h);
              else res.on(ev, h);
              return resProxy;
            }
          };
          handler(resProxy);
        });
      } else {
        realReq.on(event, handler);
      }
      return reqProxy;
    },
    once: function(event, handler) { realReq.once(event, handler); return reqProxy; },
    removeListener: function(event, handler) { realReq.removeListener(event, handler); return reqProxy; },
    getHeader: function(name) { return realReq.getHeader(name); },
    setHeader: function(name, value) { realReq.setHeader(name, value); return reqProxy; }
  };
  return reqProxy;
}

function httpNodeGet(urlOrOptions, optionsOrCallback, maybeCallback) {
  const req = httpNodeRequest(urlOrOptions, optionsOrCallback, maybeCallback);
  req.end();
  return req;
}

// ============================================================
// 9. electronAPI bridge (existing + extensions)
// ============================================================
const electronAPIBridge = {
  // 🔧 模块兼容：require('electron').ipcRenderer
  ipcRenderer: null, // 后面赋值为 ipcBridge（在 ipcBridge 定义之后）
  ipc: {
    send: (channel, ...args) => {
      const allowed = [
        'show-notification', 'get-user-data-path', 'get-server-port',
        'get-auth-token', 'app:get-path-sync', 'list-plugin-dirs',
        'copy-plugin-dir', 'delete-plugin-dir', 'open-external',
        'open-devtools', 'app-minimize', 'app-maximize', 'app-close',
        'select-directory', 'select-file', 'get-app-version'
      ];
      if (allowed.includes(channel)) {
        ipcRenderer.send(channel, ...args);
      } else {
        console.warn('[preload] blocked IPC channel:', channel);
      }
    },
    sendSync: (channel, ...args) => {
      const allowedSync = [
        'app:get-path-sync', 'get-user-data-path', 'get-server-port', 'get-auth-token'
      ];
      if (allowedSync.includes(channel)) {
        return ipcRenderer.sendSync(channel, ...args);
      }
      console.warn('[preload] blocked sync IPC channel:', channel);
      return null;
    },
    on: (channel, callback) => {
      const allowedOn = [
        'server:port', 'agent:response', 'agent:step', 'agent:error',
        'agent:done', 'agent:typing', 'config:changed', 'session:updated',
        'notification', 'tray:action', 'app:shutdown', 'trigger-export'
      ];
      if (allowedOn.includes(channel)) {
        const sub = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, sub);
        return () => ipcRenderer.removeListener(channel, sub);
      }
      console.warn('[preload] blocked IPC listener:', channel);
      return () => {};
    },
    invoke: (channel, ...args) => {
      const allowedInvoke = ['select-directory', 'select-file', 'get-app-info'];
      if (allowedInvoke.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      console.warn('[preload] blocked IPC invoke:', channel);
      return Promise.reject(new Error('Channel not allowed: ' + channel));
    }
  },
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  window: {
    minimize: () => ipcRenderer.send('app-minimize'),
    maximize: () => ipcRenderer.send('app-maximize'),
    close: () => ipcRenderer.send('app-close')
  },
  shell: {
    openExternal: (url) => {
      try { shell.openExternal(url); return true; } catch (e) { return { error: e.message }; }
    },
    openPath: (p) => {
      try { return shell.openPath(p); } catch (e) { return { error: e.message }; }
    }
  },
  clipboard: {
    writeText: (text) => { try { clipboard.writeText(text); return true; } catch (e) { return { error: e.message }; } },
    readText: () => { try { return clipboard.readText(); } catch (e) { return { error: e.message }; } }
  },
  app: {
    getVersion: () => ipcRenderer.sendSync('get-app-version'),
    getPath: (name) => ipcRenderer.sendSync('app:get-path-sync', name)
  },
  notification: (title, body) => {
    try {
      new Notification({ title: title, body: body || '' }).show();
      return true;
    } catch (e) {
      return { error: e.message };
    }
  },
  // 🔧 模块兼容：require('electron').Notification 构造函数
  Notification: function(opts) {
    const n = new Notification(opts || {});
    return {
      show: () => { try { n.show(); } catch (e) {} },
      close: () => { try { n.close(); } catch (e) {} },
      on: (event, cb) => { n.on(event, cb); }
    };
  },
  // 🔧 模块兼容：require('electron').remote (deprecated stub)
  remote: {
    dialog: {
      showOpenDialog: (opts) => ipcRenderer.invoke('select-directory', opts),
      showMessageBox: (opts) => Promise.resolve({ response: 0 })
    },
    app: {
      getVersion: () => ipcRenderer.sendSync('get-app-version'),
      getPath: (name) => ipcRenderer.sendSync('app:get-path-sync', name)
    },
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.send('app-minimize'),
      maximize: () => ipcRenderer.send('app-maximize'),
      close: () => ipcRenderer.send('app-close')
    })
  },
  // 🔒 Phase 3: safeStorage 桥接（OS 钥匙串：Windows DPAPI / macOS Keychain / Linux libsecret）
  //    用于 API Key 加密，取代「hostname+硬编码 salt 派生密钥」的弱方案。
  //    渲染进程通过 require('electron').safeStorage 或 window.nodeBridge.electronAPI.safeStorage 访问。
  safeStorage: {
    isEncryptionAvailable: () => {
      try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
    },
    // 加密字符串 → base64 密文（失败返回 {error}）
    encryptString: (plainText) => {
      try {
        if (typeof plainText !== 'string') return { error: 'encryptString: 入参必须是字符串' };
        if (!safeStorage.isEncryptionAvailable()) return { error: 'safeStorage 加密不可用' };
        return safeStorage.encryptString(plainText).toString('base64');
      } catch (e) { return { error: e.message }; }
    },
    // 解密 base64 密文 → 原文（失败返回 {error}）
    decryptString: (b64) => {
      try {
        if (typeof b64 !== 'string') return { error: 'decryptString: 入参必须是 base64 字符串' };
        if (!safeStorage.isEncryptionAvailable()) return { error: 'safeStorage 解密不可用' };
        return safeStorage.decryptString(Buffer.from(b64, 'base64'));
      } catch (e) { return { error: e.message }; }
    }
  }
};

// ============================================================
// 10. database bridge (better-sqlite3)
// ============================================================
const dbInstances = new Map();
let dbIdCounter = 1;

const databaseBridge = {
  available: Database !== null,
  open: (dbPath) => {
    if (!Database) return { error: 'better-sqlite3 not installed' };
    try {
      const db = new Database(dbPath);
      const id = dbIdCounter++;
      dbInstances.set(id, db);
      return id;
    } catch (e) {
      return { error: e.message };
    }
  },
  run: (dbId, sql, params) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      const stmt = db.prepare(sql);
      const result = stmt.run(...(params || []));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    } catch (e) {
      return { error: e.message };
    }
  },
  query: (dbId, sql, params) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(params || []));
      return rows.map(row => Object.assign({}, row));
    } catch (e) {
      return { error: e.message };
    }
  },
  get: (dbId, sql, params) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(params || []));
      return row ? Object.assign({}, row) : null;
    } catch (e) {
      return { error: e.message };
    }
  },
  exec: (dbId, sql) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      db.exec(sql);
      return true;
    } catch (e) {
      return { error: e.message };
    }
  },
  pragma: (dbId, sql) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      return db.pragma(sql);
    } catch (e) {
      return { error: e.message };
    }
  },
  transaction: (dbId, operations) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      const txn = db.transaction((ops) => {
        const results = [];
        for (const op of ops) {
          const stmt = db.prepare(op.sql);
          results.push(stmt.run(...(op.params || [])));
        }
        return results;
      });
      const results = txn(operations);
      return results.map(r => ({ changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }));
    } catch (e) {
      return { error: e.message };
    }
  },
  close: (dbId) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      db.close();
      dbInstances.delete(dbId);
      return true;
    } catch (e) {
      return { error: e.message };
    }
  },
  backup: (dbId, destPath) => {
    const db = dbInstances.get(dbId);
    if (!db) return { error: 'Database not found: ' + dbId };
    try {
      db.backup(destPath);
      return true;
    } catch (e) {
      return { error: e.message };
    }
  }
};

// ============================================================
// 11. wsServer bridge (WebSocket gateway)
// ============================================================
const wsServers = new Map();
let wsServerIdCounter = 1;

const wsServerBridge = {
  available: WebSocketServer !== null,
  createGateway: (port, host, handlers) => {
    if (!WebSocketServer) return { error: 'ws module not installed' };
    try {
      const serverId = wsServerIdCounter++;
      const clients = new Map();
      let clientIdCounter = 1;
      const wss = new WebSocketServer({ port: port, host: host || '0.0.0.0' });

      wss.on('connection', (ws, req) => {
        const clientId = clientIdCounter++;
        const ip = req.socket.remoteAddress || 'unknown';
        clients.set(clientId, ws);

        if (handlers && handlers.onConnect) {
          handlers.onConnect(clientId, ip);
        }

        ws.on('message', (data) => {
          let msg;
          if (Buffer.isBuffer(data)) {
            msg = data.toString('utf8');
          } else if (data instanceof ArrayBuffer) {
            msg = Buffer.from(data).toString('utf8');
          } else if (Array.isArray(data)) {
            msg = Buffer.concat(data).toString('utf8');
          } else {
            msg = String(data);
          }
          if (handlers && handlers.onMessage) {
            handlers.onMessage(clientId, msg);
          }
        });

        ws.on('close', () => {
          clients.delete(clientId);
          if (handlers && handlers.onClose) {
            handlers.onClose(clientId);
          }
        });

        ws.on('pong', () => {
          if (handlers && handlers.onPong) {
            handlers.onPong(clientId);
          }
        });

        ws.on('error', (err) => {
          console.warn('[preload] WS client error:', err.message);
        });
      });

      wss.on('error', (err) => {
        console.warn('[preload] WS server error:', err.message);
      });

      const gateway = {
        port: port,
        serverId: serverId,
        send: (clientId, data) => {
          const client = clients.get(clientId);
          if (client && client.readyState === 1) {
            client.send(typeof data === 'string' ? data : JSON.stringify(data));
            return true;
          }
          return { error: 'Client not connected: ' + clientId };
        },
        broadcast: (data) => {
          const msg = typeof data === 'string' ? data : JSON.stringify(data);
          for (const [, client] of clients) {
            if (client.readyState === 1) client.send(msg);
          }
          return true;
        },
        ping: (clientId) => {
          const client = clients.get(clientId);
          if (client && client.readyState === 1) { client.ping(); return true; }
          return { error: 'Client not connected: ' + clientId };
        },
        close: (clientId) => {
          const client = clients.get(clientId);
          if (client) { client.close(); clients.delete(clientId); return true; }
          return { error: 'Client not found: ' + clientId };
        },
        closeAll: () => {
          for (const [, client] of clients) { client.close(); }
          clients.clear();
          return true;
        },
        getInfo: () => {
          const info = [];
          for (const [id, client] of clients) {
            info.push({ clientId: id, readyState: client.readyState });
          }
          return { serverId: serverId, port: port, clientCount: clients.size, clients: info };
        },
        closeServer: () => {
          for (const [, client] of clients) { client.close(); }
          clients.clear();
          wss.close();
          wsServers.delete(serverId);
          return true;
        }
      };

      wsServers.set(serverId, { wss, clients, gateway });
      return gateway;
    } catch (e) {
      return { error: e.message };
    }
  }
};

// ============================================================
// 12. Module loading bridge
// ============================================================
const moduleLoaderBridge = {
  loadModuleSource: (filename) => {
    try {
      const safeName = path.basename(filename);
      const filePath = path.join(MODULES_DIR, safeName);
      if (!fs.existsSync(filePath)) return { error: 'Module not found: ' + safeName };
      return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { error: e.message };
    }
  },
  loadFileSource: (relativePath) => {
    try {
      const normalized = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(ROOT_DIR, normalized);
      if (!filePath.startsWith(ROOT_DIR)) return { error: 'Path traversal detected' };
      if (!fs.existsSync(filePath)) return { error: 'File not found: ' + normalized };
      return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { error: e.message };
    }
  },
  listModules: () => {
    try {
      if (!fs.existsSync(MODULES_DIR)) return [];
      return fs.readdirSync(MODULES_DIR).filter(f => f.endsWith('.js'));
    } catch (e) {
      return { error: e.message };
    }
  }
};

// ============================================================
// 13. DOMPurify bridge
// ============================================================
const dompurifyBridge = {
  available: DOMPurify !== null,
  sanitize: (html, options) => {
    if (!DOMPurify) return { error: 'DOMPurify not installed' };
    try {
      return DOMPurify.sanitize(html, options || {});
    } catch (e) {
      return { error: e.message };
    }
  }
};

// ============================================================
// 13.5 HTTP Server bridge (http.Server 类实例过桥包装)
// contextBridge 序列化会丢失 http.Server 的原型方法(.listen/.on/.close)，
// 因此用闭包代理包装：真实 server 留在 preload，渲染进程拿到可调用的方法桩。
// ============================================================
function createHttpServerBridge(mod, handler) {
  const realServer = mod.createServer();

  // 将真实 req/res 包装成可跨桥的对象，交给渲染进程的 handler
  function dispatch(req, res, rendererHandler) {
    const reqProxy = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      httpVersion: req.httpVersion,
      on: (event, cb) => {
        if (event === 'data') {
          req.on('data', (chunk) => cb(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk));
        } else if (event === 'end') {
          req.on('end', () => cb());
        } else {
          req.on(event, (...a) => cb(...a));
        }
        return reqProxy;
      }
    };
    const resProxy = {
      writeHead: (code, headers) => { try { res.writeHead(code, headers); } catch (e) {} return resProxy; },
      setHeader: (name, value) => { try { res.setHeader(name, value); } catch (e) {} return resProxy; },
      getHeader: (name) => { try { return res.getHeader(name); } catch (e) { return undefined; } },
      removeHeader: (name) => { try { res.removeHeader(name); } catch (e) {} return resProxy; },
      write: (data, encoding) => { try { return res.write(data, encoding); } catch (e) { return false; } },
      end: (data, encoding) => { try { res.end(data, encoding); } catch (e) {} return resProxy; }
    };
    try {
      rendererHandler(reqProxy, resProxy);
    } catch (e) {
      try { res.writeHead(500); res.end('Internal Server Error: ' + e.message); } catch (_) {}
    }
  }

  if (typeof handler === 'function') {
    realServer.on('request', (req, res) => dispatch(req, res, handler));
  }

  const serverProxy = {
    listen: (...args) => { realServer.listen(...args); return serverProxy; },
    close: (cb) => { realServer.close(typeof cb === 'function' ? cb : undefined); return serverProxy; },
    on: (event, cb) => {
      if (event === 'request') {
        realServer.on('request', (req, res) => dispatch(req, res, cb));
      } else if (event === 'error') {
        realServer.on('error', (e) => cb({ code: e.code, message: e.message, errno: e.errno }));
      } else if (event === 'close') {
        realServer.on('close', () => cb());
      } else if (event === 'listening') {
        realServer.on('listening', () => cb());
      } else {
        realServer.on(event, (...a) => cb(...a));
      }
      return serverProxy;
    },
    once: (event, cb) => {
      if (event === 'error') {
        realServer.once('error', (e) => cb({ code: e.code, message: e.message, errno: e.errno }));
      } else {
        realServer.once(event, (...a) => cb(...a));
      }
      return serverProxy;
    },
    address: () => { try { return realServer.address(); } catch (e) { return null; } },
    setTimeout: (ms, cb) => { realServer.setTimeout(ms, cb); return serverProxy; }
  };
  return serverProxy;
}

// ============================================================
// 14. nativeRequire bridge (whitelisted built-in modules)
// ============================================================
const ALLOWED_MODULES = [
  'fs', 'path', 'crypto', 'os', 'child_process', 'http', 'https',
  'net', 'tls', 'url', 'events', 'util', 'stream', 'string_decoder',
  'querystring', 'assert', 'buffer', 'process'
];

function nativeRequire(moduleName) {
  if (!ALLOWED_MODULES.includes(moduleName)) {
    // 非内置模块由 core-v10.js 的 _bridgeRequire 走专用桥（electron / ws / 相对路径 / requireNpm），
    // 这里静默返回 error 即可，避免每次 require 都刷一条黄色警告；
    // 真正无法解析的模块会在 _bridgeRequire 末尾统一告警（[core] require 被阻止）。
    return { error: 'Module not allowed: ' + moduleName };
  }
  try {
    const mod = require(moduleName);
    switch (moduleName) {
      case 'fs': return fsBridge;
      case 'path': return pathBridge;
      case 'crypto': return cryptoBridge;
      case 'os': return osBridge;
      case 'child_process': return childProcessBridge;
      case 'buffer': return bufferBridge;
      case 'process': return processInfoBridge;
      case 'http': return { request: httpNodeRequest, get: httpNodeGet, post: httpBridge.post, httpRequest: httpRequest, Agent: function(){}, createServer: (handler) => createHttpServerBridge(mod, handler), Server: mod.Server };
      case 'https': return { request: httpNodeRequest, get: httpNodeGet, post: httpBridge.post, httpRequest: httpRequest, Agent: function(){}, createServer: (handler) => createHttpServerBridge(mod, handler), Server: mod.Server };
      case 'url': return {
        URL: URL,
        parse: (u) => {
          try {
            const p = new URL(u);
            return { href: p.href, protocol: p.protocol, hostname: p.hostname, port: p.port, pathname: p.pathname, search: p.search, hash: p.hash };
          } catch (e) {
            return { href: u, protocol: '', hostname: '', port: '', pathname: u, search: '', hash: '' };
          }
        },
        format: (obj) => {
          try { return new URL(obj.href || '').toString(); } catch (e) { return ''; }
        }
      };
      case 'events': return { EventEmitter: mod.EventEmitter };
      case 'util': return {
        format: mod.format,
        inspect: mod.inspect,
        promisify: mod.promisify,
        types: { isDate: mod.types.isDate, isRegExp: mod.types.isRegExp }
      };
      case 'stream': return {
        Readable: mod.Readable,
        Writable: mod.Writable,
        Transform: mod.Transform,
        Duplex: mod.Duplex,
        PassThrough: mod.PassThrough
      };
      case 'string_decoder': return { StringDecoder: mod.StringDecoder };
      case 'querystring': return {
        parse: mod.parse,
        stringify: mod.stringify,
        escape: mod.escape,
        unescape: mod.unescape
      };
      case 'assert': return mod;
      case 'net': return { createConnection: mod.createConnection, createServer: mod.createServer, connect: mod.connect };
      case 'tls': return { connect: mod.connect };
      default: return mod;
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// 15. log bridge (electron-log — 日志持久化到文件)
// ============================================================
let logBridge = { available: false, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
try {
  const log = require('electron-log');
  // transports.file 在 preload 上下文可能未初始化，需守卫
  if (log.transports && log.transports.file) {
    log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB rotation
    log.transports.file.level = 'info';
  }
  if (log.transports && log.transports.console) {
    log.transports.console.level = 'debug';
  }
  logBridge = {
    available: true,
    info: (...args) => log.info(...args),
    warn: (...args) => log.warn(...args),
    error: (...args) => log.error(...args),
    debug: (...args) => log.debug(...args),
    verbose: (...args) => log.verbose(...args),
    getFilePath: () => { try { return log.transports.file.getFile().path; } catch (e) { return ''; } }
  };
} catch (e) {
  console.warn('[preload] electron-log not available:', e.message);
}

// ============================================================
// 16. projectInfo bridge
// ============================================================
const projectInfoBridge = {
  rootDir: ROOT_DIR,
  modulesDir: MODULES_DIR,
  dataRoot: DATA_ROOT,
  nodeModulesDir: NODE_MODULES_DIR
};

// ============================================================
// 16. ipcRenderer bridge (more permissive for internal modules)
// ============================================================
const ipcBridge = {
  send: (channel, ...args) => {
    const blocked = ['app-exit', 'app-quit', 'destroy-window'];
    if (blocked.includes(channel)) {
      console.warn('[preload] ipcBridge blocked channel:', channel);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
  sendSync: (channel, ...args) => {
    const blocked = ['app-exit', 'app-quit', 'destroy-window'];
    if (blocked.includes(channel)) {
      console.warn('[preload] ipcBridge blocked sync channel:', channel);
      return null;
    }
    return ipcRenderer.sendSync(channel, ...args);
  },
  on: (channel, cb) => {
    const sub = (_event, ...args) => cb(...args);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
  once: (channel, cb) => {
    const sub = (_event, ...args) => cb(...args);
    ipcRenderer.once(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
  invoke: (channel, ...args) => {
    return ipcRenderer.invoke(channel, ...args);
  },
  removeListener: (channel, cb) => {
    ipcRenderer.removeListener(channel, cb);
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
};

// 🔧 模块兼容：让 require('electron').ipcRenderer 返回完整的 IPC 桥接
electronAPIBridge.ipcRenderer = ipcBridge;

// ============================================================
// 16. requireNpm bridge (whitelisted npm packages loaded in preload)
// ============================================================
const NPM_WHITELIST = [
  'pdf-parse', 'mammoth', 'xlsx', 'docx', 'pdf-lib', '@pdf-lib/fontkit',
  'pptxgenjs', 'iconv-lite', 'marked', 'highlight.js', 'mermaid',
  'ws', 'express', 'cors', 'dompurify', 'jsdom'
];
const _npmCache = {};

// ===== Object registry: keeps class instances in preload, exposes handles =====
const objRegistry = new Map();
let objIdCounter = 1;

function registerObj(obj) {
  if (obj === null || obj === undefined) return obj;
  const id = objIdCounter++;
  objRegistry.set(id, obj);
  return id;
}

function resolveArg(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value.__objId !== undefined) return objRegistry.get(value.__objId);
  if (value._isBufferProxy) return unwrapBuffer(value);
  if (Array.isArray(value)) return value.map(resolveArg);
  if (value instanceof Date) return value;
  const resolved = {};
  for (const key of Object.keys(value)) {
    resolved[key] = resolveArg(value[key]);
  }
  return resolved;
}

function wrapResult(value) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return createBufferProxy(value);
  if (value instanceof Uint8Array) return createBufferProxy(Buffer.from(value));
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(wrapResult);
  if (value instanceof Date) return value;
  // Plain objects cross fine; class instances need registration
  const proto = Object.getPrototypeOf(value);
  if (proto && proto !== Object.prototype && proto !== null) {
    return makeHandle(registerObj(value));
  }
  return value;
}

// Create a handle object with method-call stub for registered objects
function makeHandle(objId) {
  return { __objId: objId };
}

// Generic bridge for calling methods on registered objects
const objBridge = {
  call: function(objId, method, args) {
    const obj = objRegistry.get(objId);
    if (!obj) return { error: 'Object not found: ' + objId };
    try {
      const resolvedArgs = (args || []).map(resolveArg);
      const result = obj[method](...resolvedArgs);
      if (result && typeof result.then === 'function') {
        return result.then(wrapResult);
      }
      return wrapResult(result);
    } catch (e) {
      return { error: e.message };
    }
  },
  callAsync: function(objId, method, args) {
    const obj = objRegistry.get(objId);
    if (!obj) return Promise.resolve({ error: 'Object not found: ' + objId });
    try {
      const resolvedArgs = (args || []).map(resolveArg);
      const result = obj[method](...resolvedArgs);
      return Promise.resolve(result).then(wrapResult);
    } catch (e) {
      return Promise.resolve({ error: e.message });
    }
  },
  get: function(objId, prop) {
    const obj = objRegistry.get(objId);
    if (!obj) return undefined;
    return wrapResult(obj[prop]);
  },
  set: function(objId, prop, value) {
    const obj = objRegistry.get(objId);
    if (!obj) return { error: 'Object not found: ' + objId };
    obj[prop] = resolveArg(value);
    return true;
  },
  release: function(objId) {
    objRegistry.delete(objId);
    return true;
  }
};

// ===== Package-specific wrappers =====
function wrapDocx(mod) {
  function createInstance(Ctor, args) {
    const resolvedArgs = args.map(resolveArg);
    const obj = new Ctor(...resolvedArgs);
    const id = registerObj(obj);
    return makeHandle(id);
  }
  return {
    Document: function(opts) { return createInstance(mod.Document, [opts || {}]); },
    Paragraph: function(opts) { return createInstance(mod.Paragraph, [opts || {}]); },
    TextRun: function(opts) { return createInstance(mod.TextRun, [typeof opts === 'string' ? { text: opts } : (opts || {})]); },
    Table: function(opts) { return createInstance(mod.Table, [opts || {}]); },
    TableRow: function(opts) { return createInstance(mod.TableRow, [opts || {}]); },
    TableCell: function(opts) { return createInstance(mod.TableCell, [opts || {}]); },
    ImageRun: function(opts) { return createInstance(mod.ImageRun, [opts || {}]); },
    Packer: {
      toBuffer: function(docHandle) {
        const doc = objRegistry.get(docHandle && docHandle.__objId);
        if (!doc) return Promise.resolve({ error: 'Document not found' });
        return mod.Packer.toBuffer(doc).then(function(buf) { return createBufferProxy(buf); });
      }
    },
    HeadingLevel: mod.HeadingLevel || {},
    AlignmentType: mod.AlignmentType || {},
    BorderStyle: mod.BorderStyle || {},
    WidthType: mod.WidthType || {},
    ShadingType: mod.ShadingType || {},
    PageBreak: mod.PageBreak,
    ExternalHyperlink: mod.ExternalHyperlink,
    Tab: mod.Tab,
    PageNumber: mod.PageNumber
  };
}

function wrapPdfLib(mod) {
  const pageMethods = ['drawText', 'drawLine', 'drawRectangle', 'drawCircle', 'drawImage',
    'drawEllipse', 'drawPolygon', 'drawSvgPath', 'getWidth', 'getHeight',
    'setSize', 'setRotation', 'moveUp', 'moveDown', 'moveLeft', 'moveRight'];
  const fontMethods = ['widthOfTextAtSize', 'heightAtSize', 'sizeOfFontAtHeight', 'encodeText'];

  function makePageHandle(obj) {
    const id = registerObj(obj);
    const handle = { __objId: id };
    pageMethods.forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var resolved = args.map(resolveArg);
        var result = obj[m](...resolved);
        if (result && typeof result.then === 'function') return result.then(wrapResult);
        return wrapResult(result);
      };
    });
    return handle;
  }

  function makeFontHandle(obj) {
    const id = registerObj(obj);
    const handle = { __objId: id };
    fontMethods.forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var resolved = args.map(resolveArg);
        return obj[m](...resolved);
      };
    });
    return handle;
  }

  function makeDocHandle(doc) {
    const id = registerObj(doc);
    const handle = { __objId: id };
    // Metadata setters (return void/this)
    ['setTitle', 'setAuthor', 'setSubject', 'setCreationDate', 'setModificationDate', 'setProducer', 'setCreator'].forEach(function(m) {
      handle[m] = function() { var args = Array.prototype.slice.call(arguments); doc[m](...args.map(resolveArg)); return handle; };
    });
    // Page methods (return page handle)
    ['addPage', 'insertPage', 'getPage'].forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var result = doc[m](...args.map(resolveArg));
        return makePageHandle(result);
      };
    });
    handle.removePage = function(idx) { doc.removePage(idx); return handle; };
    handle.getPageCount = function() { return doc.getPageCount(); };
    // Font embedding (async, returns font handle)
    ['embedFont', 'embedStandardFont'].forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var result = doc[m](...args.map(resolveArg));
        if (result && typeof result.then === 'function') return result.then(makeFontHandle);
        return makeFontHandle(result);
      };
    });
    // Image embedding (async, returns image handle)
    ['embedPng', 'embedJpg', 'embedImage'].forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var resolved = args.map(resolveArg);
        var result = doc[m](...resolved);
        if (result && typeof result.then === 'function') return result.then(wrapResult);
        return wrapResult(result);
      };
    });
    // save (async, returns bytes)
    handle.save = function(opts) {
      return doc.save(opts).then(function(bytes) { return createBufferProxy(Buffer.from(bytes)); });
    };
    handle.registerFontkit = function(fk) { doc.registerFontkit(resolveArg(fk)); return handle; };
    return handle;
  }

  return {
    PDFDocument: {
      create: function() {
        return mod.PDFDocument.create().then(makeDocHandle);
      },
      load: function(bytes, opts) {
        var data = resolveArg(bytes);
        return mod.PDFDocument.load(data, opts).then(makeDocHandle);
      }
    },
    StandardFonts: mod.StandardFonts,
    rgb: function(r, g, b) { return mod.rgb(r, g, b); },
    degrees: function(deg) { return mod.degrees(deg); },
    radians: function(rad) { return mod.radians(rad); }
  };
}

function wrapPptxgen(mod) {
  const pptxMethods = ['addSlide', 'writeFile', 'write', 'stream', 'getSlides', 'defineLayout',
    'defineSlideMaster', 'addNewSlide'];
  const slideMethods = ['addText', 'addShape', 'addImage', 'addTable', 'addChart',
    'addMedia', 'addNotes', 'addHyperlink', 'getSlideNumber', 'bkgd'];

  function makeSlideHandle(slide) {
    const id = registerObj(slide);
    const handle = { __objId: id };
    slideMethods.forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var resolved = args.map(resolveArg);
        var result = slide[m](...resolved);
        if (result && typeof result.then === 'function') return result.then(wrapResult);
        return wrapResult(result);
      };
    });
    // Property accessors for background
    Object.defineProperty(handle, 'background', {
      get: function() { return slide.background; },
      set: function(v) { slide.background = v; }
    });
    return handle;
  }

  function PptxShim() {
    var pptx = new (mod.default || mod)();
    var id = registerObj(pptx);
    var handle = { __objId: id, ShapeType: (mod.default || mod).ShapeType || pptx.ShapeType || {} };
    pptxMethods.forEach(function(m) {
      handle[m] = function() {
        var args = Array.prototype.slice.call(arguments);
        var resolved = args.map(resolveArg);
        var result = pptx[m](...resolved);
        if (result && typeof result.then === 'function') return result.then(wrapResult);
        if (m === 'addSlide') return makeSlideHandle(result);
        return wrapResult(result);
      };
    });
    // Property setters
    ['title', 'author', 'subject', 'company', 'layout'].forEach(function(prop) {
      Object.defineProperty(handle, prop, {
        get: function() { return pptx[prop]; },
        set: function(v) { pptx[prop] = v; },
        enumerable: true
      });
    });
    return handle;
  }
  return PptxShim;
}

function requireNpm(name) {
  if (!NPM_WHITELIST.includes(name)) {
    return { error: 'npm package not whitelisted: ' + name };
  }
  if (_npmCache[name]) return _npmCache[name];
  try {
    const mod = require(name);
    let wrapped;
    switch (name) {
      case 'docx':
        wrapped = wrapDocx(mod);
        break;
      case 'pdf-lib':
        wrapped = wrapPdfLib(mod);
        break;
      case 'pptxgenjs':
        wrapped = wrapPptxgen(mod);
        break;
      case 'pdf-parse':
        // Wrap to auto-unwrap BufferProxy input
        wrapped = function(data, opts) {
          var buf = resolveArg(data);
          return mod(buf, opts);
        };
        break;
      case 'iconv-lite':
        wrapped = {
          decode: function(buf, encoding) { return mod.decode(resolveArg(buf), encoding); },
          encode: function(str, encoding) { return createBufferProxy(mod.encode(str, encoding)); },
          encodingExists: function(enc) { return mod.encodingExists(enc); }
        };
        break;
      case 'mammoth':
        // mammoth uses {path} or {buffer} — wrap buffer case
        wrapped = {
          convertToHtml: function(input, opts) {
            var resolved = input && input.buffer ? { buffer: resolveArg(input.buffer) } : input;
            return mod.convertToHtml(resolved, opts);
          },
          extractRawText: function(input, opts) {
            var resolved = input && input.buffer ? { buffer: resolveArg(input.buffer) } : input;
            return mod.extractRawText(resolved, opts);
          }
        };
        break;
      default:
        // xlsx, marked, highlight.js, mermaid, @pdf-lib/fontkit — plain objects/functions, pass through
        wrapped = mod;
        break;
    }
    _npmCache[name] = wrapped;
    return wrapped;
  } catch (e) {
    return { error: 'npm package not available: ' + name + ' (' + e.message + ')' };
  }
}

// ============================================================
// Assemble the nodeBridge
// ============================================================
const nodeBridge = {
  fs: fsBridge,
  path: pathBridge,
  crypto: cryptoBridge,
  os: osBridge,
  childProcess: childProcessBridge,
  buffer: bufferBridge,
  processInfo: processInfoBridge,
  httpRequest: httpBridge,
  electronAPI: electronAPIBridge,
  database: databaseBridge,
  wsServer: wsServerBridge,
  loadModuleSource: moduleLoaderBridge.loadModuleSource,
  loadFileSource: moduleLoaderBridge.loadFileSource,
  listModules: moduleLoaderBridge.listModules,
  dompurify: dompurifyBridge,
  nativeRequire: nativeRequire,
  requireNpm: requireNpm,
  objBridge: objBridge,
  log: logBridge,
  projectInfo: projectInfoBridge,
  ipcRenderer: ipcBridge
};

// ============================================================
// Expose via contextBridge
// ============================================================
contextBridge.exposeInMainWorld('nodeBridge', nodeBridge);

// Backward compatibility: also expose electronAPI at top level
contextBridge.exposeInMainWorld('electronAPI', electronAPIBridge);

console.log('[preload] nodeBridge exposed successfully. Modules available:', Object.keys(nodeBridge).join(', '));
