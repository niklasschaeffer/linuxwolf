'use strict';
// A small virtual Windows registry plus a `reg.exe` emulator.
//
// Windows apps ask the registry about Steam (install path, which app is
// running). Those keys are generated live from the Linux Steam client. Keys
// the app writes itself (`reg add`) are kept in a JSON file so they survive
// restarts, like on Windows.

const fs = require('fs');
const path = require('path');
const steam = require('./steam');

const ROOTS = {
  HKCU: 'HKEY_CURRENT_USER',
  HKEY_CURRENT_USER: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKEY_LOCAL_MACHINE: 'HKEY_LOCAL_MACHINE',
  HKCR: 'HKEY_CLASSES_ROOT',
  HKEY_CLASSES_ROOT: 'HKEY_CLASSES_ROOT',
  HKU: 'HKEY_USERS',
  HKEY_USERS: 'HKEY_USERS',
};

const NOT_FOUND = 'ERROR: The system was unable to find the specified registry key or value.\r\n';

/** `HKCU\Software\Valve` -> `HKEY_CURRENT_USER\Software\Valve` (display form). */
function normalizeKey(key) {
  const parts = String(key).replace(/\//g, '\\').split('\\').filter(Boolean);
  if (!parts.length) return null;
  const root = ROOTS[parts[0].toUpperCase()];
  if (!root) return null;
  return [root, ...parts.slice(1)].join('\\');
}

const lc = (s) => s.toLowerCase();

class Registry {
  constructor({ storeFile = null, steamApi = steam, procRoot = '/proc' } = {}) {
    this.storeFile = storeFile;
    this.steam = steamApi;
    this.procRoot = procRoot;
    this.stored = {};
    if (storeFile) {
      try {
        this.stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      } catch {}
    }
  }

  save() {
    if (!this.storeFile) return;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      fs.writeFileSync(this.storeFile, JSON.stringify(this.stored, null, 2));
    } catch {}
  }

  /** Map lowercase key path -> { name, values: Map(lowercase name -> {name, type, data}) }. */
  snapshot() {
    const keys = new Map();
    const ensure = (name) => {
      const k = lc(name);
      if (!keys.has(k)) keys.set(k, { name, values: new Map() });
      // Parent keys exist implicitly.
      const i = name.lastIndexOf('\\');
      if (i > 0) ensure(name.slice(0, i));
      return keys.get(k);
    };
    const set = (key, name, type, data) => ensure(key).values.set(lc(name), { name, type, data });

    // Live Steam keys.
    const steamKey = 'HKEY_CURRENT_USER\\Software\\Valve\\Steam';
    const roots = this.steam.roots();
    const running = this.steam.runningAppIds(this.procRoot);
    const installed = this.steam.installedAppIds();
    if (roots.length) {
      set(steamKey, 'SteamPath', 'REG_SZ', roots[0]);
      set(steamKey, 'SteamExe', 'REG_SZ', path.join(roots[0], 'steam.sh'));
      set('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath', 'REG_SZ', roots[0]);
    }
    set(steamKey, 'RunningAppID', 'REG_DWORD', running.size ? Number([...running][0]) : 0);
    for (const id of new Set([...installed, ...running])) {
      const k = `${steamKey}\\Apps\\${id}`;
      set(k, 'Installed', 'REG_DWORD', installed.has(id) ? 1 : 0);
      set(k, 'Running', 'REG_DWORD', running.has(id) ? 1 : 0);
    }
    // UTF-8 code page, so apps decode reg.exe output as UTF-8.
    set('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', 'OEMCP', 'REG_SZ', '65001');
    set('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', 'ACP', 'REG_SZ', '65001');

    // Values the app wrote.
    for (const [key, values] of Object.entries(this.stored)) {
      ensure(key);
      for (const v of Object.values(values)) set(key, v.name, v.type, v.data);
    }
    return keys;
  }

  add(key, name, type, data) {
    const k = normalizeKey(key);
    if (!k) return false;
    const entry = Object.keys(this.stored).find((s) => lc(s) === lc(k)) || k;
    this.stored[entry] = this.stored[entry] || {};
    this.stored[entry][lc(name)] = { name, type, data };
    this.save();
    return true;
  }

  delete(key, name) {
    const k = normalizeKey(key);
    const entry = k && Object.keys(this.stored).find((s) => lc(s) === lc(k));
    if (!entry) return false;
    if (name === undefined) delete this.stored[entry];
    else delete this.stored[entry][lc(name)];
    this.save();
    return true;
  }
}

function formatValue(v) {
  const name = v.name === '' ? '(Default)' : v.name;
  let data = v.data;
  if (v.type === 'REG_DWORD' || v.type === 'REG_QWORD') data = `0x${Number(data).toString(16)}`;
  return `    ${name}    ${v.type}    ${data}\r\n`;
}

/** Parse `reg.exe` argv into { op, key, opts }. */
function parseArgs(args) {
  const [op = '', key = '', ...rest] = args;
  const opts = { s: false, v: undefined, ve: false, t: 'REG_SZ', d: '', f: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i].toLowerCase();
    if (a === '/s') opts.s = true;
    else if (a === '/ve') opts.ve = true;
    else if (a === '/f') opts.f = true;
    else if (a === '/v') opts.v = rest[++i];
    else if (a === '/t') opts.t = String(rest[++i]).toUpperCase();
    else if (a === '/d') opts.d = rest[++i];
  }
  return { op: op.toLowerCase(), key, opts };
}

/** Emulate `reg.exe <args>`. Returns { code, stdout, stderr }. */
function regExe(registry, args) {
  const { op, key, opts } = parseArgs(args);
  const k = normalizeKey(key);
  if (!k) return { code: 1, stdout: '', stderr: 'ERROR: Invalid key name.\r\n' };

  if (op === 'add') {
    let data = opts.d;
    if (opts.t === 'REG_DWORD' || opts.t === 'REG_QWORD') data = Number(data) || 0;
    registry.add(k, opts.ve ? '' : opts.v ?? '', opts.t, data);
    return { code: 0, stdout: 'The operation completed successfully.\r\n', stderr: '' };
  }
  if (op === 'delete') {
    registry.delete(k, opts.ve ? '' : opts.v);
    return { code: 0, stdout: 'The operation completed successfully.\r\n', stderr: '' };
  }
  if (op !== 'query') return { code: 1, stdout: '', stderr: `ERROR: Invalid syntax.\r\n` };

  const keys = registry.snapshot();
  const base = keys.get(lc(k));
  if (!base) return { code: 1, stdout: '', stderr: NOT_FOUND };
  const want = opts.ve ? '' : opts.v;
  const pick = (entry) => {
    if (want === undefined) return [...entry.values.values()];
    const v = entry.values.get(lc(want));
    return v ? [v] : [];
  };

  if (!opts.s) {
    const values = pick(base);
    if (want !== undefined && !values.length) return { code: 1, stdout: '', stderr: NOT_FOUND };
    let out = `\r\n${base.name}\r\n`;
    for (const v of values) out += formatValue(v);
    out += '\r\n';
    if (want === undefined) {
      const prefix = `${lc(base.name)}\\`;
      for (const [lk, e] of keys) {
        if (lk.startsWith(prefix) && !lk.slice(prefix.length).includes('\\')) out += `${e.name}\r\n`;
      }
    }
    return { code: 0, stdout: out, stderr: '' };
  }

  // Recursive search.
  const prefix = `${lc(base.name)}\\`;
  const sorted = [...keys.entries()]
    .filter(([lk]) => lk === lc(base.name) || lk.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  let out = '\r\n';
  let matches = 0;
  for (const [, e] of sorted) {
    const values = pick(e);
    if (!values.length) continue;
    out += `${e.name}\r\n`;
    for (const v of values) out += formatValue(v);
    out += '\r\n';
    matches += values.length;
  }
  if (!matches) return { code: 1, stdout: '', stderr: NOT_FOUND };
  out += `End of search: ${matches} match(es) found.\r\n`;
  return { code: 0, stdout: out, stderr: '' };
}

module.exports = { Registry, regExe, normalizeKey, parseArgs };
