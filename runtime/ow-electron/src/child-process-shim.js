'use strict';
// Answers calls to Windows tools that ow-electron apps spawn, starting with
// `reg.exe`. Everything else goes to the real child_process.

const cp = require('child_process');
const util = require('util');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const log = require('./log');

const handlers = new Map(); // lowercase basename -> (args) => {code, stdout, stderr}

function register(names, fn) {
  for (const n of names) handlers.set(n.toLowerCase(), fn);
}

function handlerFor(file) {
  if (typeof file !== 'string') return null;
  return handlers.get(path.win32.basename(file).toLowerCase()) || null;
}

function run(fn, args) {
  if (process.env.LINUXWOLF_DEBUG) log(`[exec] ${(args || []).join(' ')}`);
  try {
    return fn(args || []);
  } catch (e) {
    return { code: 1, stdout: '', stderr: String(e && e.message) };
  }
}

function encode(s, encoding) {
  if (encoding === 'buffer' || encoding === null) return Buffer.from(s, 'utf8');
  return s;
}

function fakeChild(result) {
  const child = new EventEmitter();
  child.pid = 0;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  child.ref = () => {};
  child.unref = () => {};
  setImmediate(() => {
    child.stdout.end(result.stdout);
    child.stderr.end(result.stderr);
    child.exitCode = result.code;
    child.emit('exit', result.code, null);
    child.emit('close', result.code, null);
  });
  return child;
}

function errorFor(result, file, args) {
  if (result.code === 0) return null;
  const err = new Error(`Command failed: ${[file, ...(args || [])].join(' ')}\n${result.stderr}`);
  err.code = result.code;
  err.cmd = [file, ...(args || [])].join(' ');
  return err;
}

function splitCommand(command) {
  // Enough for `reg query "HKCU\..." /v Name`.
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function install() {
  if (cp.__linuxwolf) return;
  const orig = {
    execFile: cp.execFile,
    exec: cp.exec,
    spawn: cp.spawn,
    execFileSync: cp.execFileSync,
    execSync: cp.execSync,
    spawnSync: cp.spawnSync,
  };

  function execFile(file, args, options, callback) {
    const fn = handlerFor(file);
    if (!fn) return orig.execFile.apply(this, arguments);
    if (typeof args === 'function') [callback, args, options] = [args, [], {}];
    else if (!Array.isArray(args)) [callback, options, args] = [options, args, []];
    if (typeof options === 'function') [callback, options] = [options, {}];
    const result = run(fn, args);
    const enc = options && options.encoding;
    const child = fakeChild(result);
    if (typeof callback === 'function') {
      setImmediate(() => callback(errorFor(result, file, args), encode(result.stdout, enc), encode(result.stderr, enc)));
    }
    return child;
  }
  execFile[util.promisify.custom] = (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else resolve({ stdout, stderr });
      });
    });

  function exec(command, options, callback) {
    const [file, ...args] = splitCommand(String(command));
    if (!handlerFor(file)) return orig.exec.apply(this, arguments);
    return execFile(file, args, options, callback);
  }
  exec[util.promisify.custom] = (command, options) => {
    const [file, ...args] = splitCommand(String(command));
    if (!handlerFor(file)) return util.promisify(orig.exec)(command, options);
    return execFile[util.promisify.custom](file, args, options);
  };

  function spawn(file, args) {
    const fn = handlerFor(file);
    if (!fn) return orig.spawn.apply(this, arguments);
    return fakeChild(run(fn, Array.isArray(args) ? args : []));
  }

  function execFileSync(file, args, options) {
    const fn = handlerFor(file);
    if (!fn) return orig.execFileSync.apply(this, arguments);
    if (!Array.isArray(args)) [options, args] = [args, []];
    const result = run(fn, args);
    const err = errorFor(result, file, args);
    if (err) throw err;
    return encode(result.stdout, options && options.encoding ? options.encoding : 'buffer');
  }

  function execSync(command, options) {
    const [file, ...args] = splitCommand(String(command));
    if (!handlerFor(file)) return orig.execSync.apply(this, arguments);
    return execFileSync(file, args, options);
  }

  function spawnSync(file, args, options) {
    const fn = handlerFor(file);
    if (!fn) return orig.spawnSync.apply(this, arguments);
    if (!Array.isArray(args)) [options, args] = [args, []];
    const r = run(fn, args);
    const enc = options && options.encoding ? options.encoding : 'buffer';
    return { pid: 0, status: r.code, signal: null, stdout: encode(r.stdout, enc), stderr: encode(r.stderr, enc), output: [null, encode(r.stdout, enc), encode(r.stderr, enc)] };
  }

  Object.assign(cp, { execFile, exec, spawn, execFileSync, execSync, spawnSync });
  Object.defineProperty(cp, '__linuxwolf', { value: orig });
}

module.exports = { install, register, splitCommand };
