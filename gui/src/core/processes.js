'use strict';
// Starts and stops apps and tool scripts, keeps their recent output and
// writes it to ~/.local/state/linuxwolf/gui/<key>.log.
//
// Apps write straight into their log file (not into a pipe to the GUI), so
// they keep running when the GUI is closed. The GUI finds them again on its
// next start (see findAppPid).

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const KEEP_LINES = 400;

function lastSegment(line) {
  // curl progress bars use \r; keep the last state of the line.
  return line.split('\r').filter(Boolean).pop() || '';
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

class Processes extends EventEmitter {
  constructor({ logDir = paths.logDir(), pollMs = 500 } = {}) {
    super();
    this.logDir = logDir;
    this.pollMs = pollMs;
    this.items = new Map();
  }

  _logFile(key) {
    return path.join(this.logDir, `${key.replace(/[^\w.-]+/g, '_')}.log`);
  }

  _newItem(key, { label = key, kind = 'task', meta = {} }) {
    const prev = this.items.get(key);
    if (prev && prev.running) throw new Error(`${label} is already running`);
    if (prev) this._cleanup(prev);
    fs.mkdirSync(this.logDir, { recursive: true });
    const item = { key, label, kind, meta, running: true, startedAt: Date.now(), exitCode: null, lines: [], logFile: this._logFile(key) };
    this.items.set(key, item);
    return item;
  }

  _push(item, line, stream) {
    item.lines.push({ t: Date.now(), stream, line });
    if (item.lines.length > KEEP_LINES) item.lines.splice(0, item.lines.length - KEEP_LINES);
    this.emit('output', { key: item.key, stream, line });
  }

  /**
   * Start `file args` under `key`.
   * kind "task": a script that finishes; output is piped and shown live.
   * kind "app": a long-running app; output goes to its log file, which is
   * followed for the UI, and the app outlives the GUI.
   */
  start(key, { file, args = [], env = {}, label, kind = 'task', cwd = paths.repoRoot, meta = {} }) {
    const item = this._newItem(key, { label, kind, meta });
    const header = `$ ${[file, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
    const opts = { cwd, env: { ...process.env, ...env }, detached: true };
    let child;
    try {
      if (kind === 'app') {
        fs.appendFileSync(item.logFile, `\n--- ${new Date().toISOString()} ---\n${header}\n`);
        item.offset = fs.statSync(item.logFile).size;
        this._push(item, header, 'meta');
        const fd = fs.openSync(item.logFile, 'a');
        try {
          child = spawn(file, args, { ...opts, stdio: ['ignore', fd, fd] });
        } finally {
          fs.closeSync(fd);
        }
        child.unref();
        item.tail = setInterval(() => this._readTail(item), this.pollMs);
      } else {
        item.logStream = fs.createWriteStream(item.logFile, { flags: 'w' });
        item.logStream.write(`${header}\n`);
        this._push(item, header, 'meta');
        child = spawn(file, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of ['stdout', 'stderr']) {
          let rest = '';
          child[stream].setEncoding('utf8');
          child[stream].on('data', (chunk) => {
            const parts = (rest + chunk).split('\n');
            rest = parts.pop();
            for (const p of parts) this._taskLine(item, lastSegment(p), stream);
          });
          child[stream].on('end', () => rest && this._taskLine(item, lastSegment(rest), stream));
        }
      }
    } catch (e) {
      this._finish(item, null, e);
      return item;
    }
    item.child = child;
    item.pid = child.pid;
    child.on('error', (e) => this._finish(item, null, e));
    // 'close' comes after the output pipes are drained, unlike 'exit'.
    child.on('close', (code, signal) => {
      if (item.tail) this._readTail(item);
      this._finish(item, code ?? signal, null);
    });
    this.emit('change', key);
    return item;
  }

  /** Track an app process that is already running (started earlier or outside the GUI). */
  adopt(key, pid, { label, meta = {} } = {}) {
    const item = this._newItem(key, { label, kind: 'app', meta });
    item.pid = pid;
    item.adopted = true;
    this._push(item, `already running (pid ${pid}), output in ${item.logFile} only if started by Linuxwolf`, 'meta');
    try {
      item.offset = fs.statSync(item.logFile).size;
      item.tail = setInterval(() => this._readTail(item), this.pollMs);
    } catch {}
    item.watch = setInterval(() => !alive(pid) && this._finish(item, 'gone', null), 2000);
    this.emit('change', key);
    return item;
  }

  _taskLine(item, line, stream) {
    item.logStream?.write(`${line}\n`);
    this._push(item, line, stream);
  }

  _readTail(item) {
    let fd;
    try {
      const size = fs.statSync(item.logFile).size;
      if (size < item.offset) item.offset = 0;
      if (size === item.offset) return;
      fd = fs.openSync(item.logFile, 'r');
      const buf = Buffer.alloc(Math.min(size - item.offset, 1 << 20));
      const n = fs.readSync(fd, buf, 0, buf.length, item.offset);
      item.offset += n;
      const text = (item.partial || '') + buf.subarray(0, n).toString('utf8');
      const parts = text.split('\n');
      item.partial = parts.pop();
      for (const p of parts) this._push(item, lastSegment(p), 'out');
    } catch {
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  _cleanup(item) {
    clearInterval(item.tail);
    clearInterval(item.watch);
    clearTimeout(item.killTimer);
  }

  _finish(item, code, err) {
    if (!item.running) return;
    item.running = false;
    item.exitCode = err ? 'error' : code;
    item.endedAt = Date.now();
    this._cleanup(item);
    const msg = err ? `failed to start: ${err.message}` : `exited (${code})`;
    this._push(item, msg, 'meta');
    const done = () => {
      this.emit('exit', { key: item.key, code: item.exitCode, item });
      this.emit('change', item.key);
    };
    if (item.logStream) item.logStream.end(`${msg}\n`, done);
    else fs.appendFile(item.logFile, `[linuxwolf-gui] ${msg}\n`, done);
  }

  /** SIGTERM the process group, SIGKILL after `graceMs`. */
  stop(key, graceMs = 5000) {
    const item = this.items.get(key);
    if (!item || !item.running || !item.pid) return false;
    const kill = (sig) => {
      try {
        process.kill(-item.pid, sig);
      } catch {
        try {
          process.kill(item.pid, sig);
        } catch {}
      }
    };
    kill('SIGTERM');
    item.killTimer = setTimeout(() => item.running && kill('SIGKILL'), graceMs);
    item.killTimer.unref?.();
    return true;
  }

  isRunning(key) {
    return Boolean(this.items.get(key)?.running);
  }

  get(key) {
    return this.items.get(key);
  }

  lines(key) {
    return this.items.get(key)?.lines || [];
  }

  /** Plain snapshot for the UI (no handles). */
  snapshot() {
    return [...this.items.values()].map((i) => ({
      key: i.key,
      label: i.label,
      kind: i.kind,
      meta: i.meta,
      running: i.running,
      pid: i.pid ?? null,
      startedAt: i.startedAt,
      endedAt: i.endedAt ?? null,
      exitCode: i.exitCode,
      adopted: Boolean(i.adopted),
      logFile: i.logFile,
      lastLine: i.lines.length ? i.lines[i.lines.length - 1].line : '',
    }));
  }

  dispose() {
    for (const i of this.items.values()) this._cleanup(i);
  }
}

function readNul(file) {
  try {
    return fs.readFileSync(file).toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * pid of a running copy of an installed app, or null. ow-electron apps carry
 * `--lw-app=<dir>` on their Electron command line; an AppImage runs from a
 * mount point with APPIMAGE=<file> in its environment.
 */
function findAppPid(app, procRoot = '/proc') {
  if (!app.installed || !app.path) return null;
  let names = [];
  try {
    names = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    const dir = path.join(procRoot, n);
    const cmd = readNul(path.join(dir, 'cmdline'));
    if (!cmd || !cmd.length) continue;
    let match = false;
    if (app.kind === 'ow-electron') {
      // Chromium rewrites its process title into one space-joined string
      // (and reorders the switches), so match on the joined command line.
      const line = ` ${cmd.join(' ')} `;
      match = line.includes(` --lw-app=${app.path} `) && !line.includes(' --type=');
    } else if (app.kind === 'appimage') {
      match = cmd[0] === app.path || (cmd[0].includes('/.mount_') && (readNul(path.join(dir, 'environ')) || []).includes(`APPIMAGE=${app.path}`));
    }
    if (match && (best === null || Number(n) < best)) best = Number(n);
  }
  return best;
}

module.exports = { Processes, findAppPid };
