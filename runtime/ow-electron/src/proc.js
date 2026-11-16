'use strict';
// Find games running under Proton/Wine by scanning /proc. Same rules as the
// Rust crate `lw-detect` (crates/lw-detect/src/lib.rs); keep them in sync.

const fs = require('fs');
const path = require('path');

const HELPER_EXES = new Set([
  'steam.exe', 'steamwebhelper.exe', 'steamerrorreporter.exe', 'steamerrorreporter64.exe',
  'services.exe', 'winedevice.exe', 'plugplay.exe', 'svchost.exe', 'rpcss.exe',
  'explorer.exe', 'tabtip.exe', 'conhost.exe', 'start.exe', 'rundll32.exe', 'wineboot.exe',
  'winemenubuilder.exe', 'crashpad_handler.exe', 'unitycrashhandler64.exe',
  'crashreportclient.exe', 'start_protected_game.exe', 'easyanticheat_eos_setup.exe',
]);

function splitNul(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function windowsExeName(arg) {
  const name = arg.split(/[\\/]/).pop();
  return name && name.toLowerCase().endsWith('.exe') ? name : null;
}

function inspect(dir, pid) {
  let cmdline;
  try {
    cmdline = splitNul(fs.readFileSync(path.join(dir, 'cmdline')));
  } catch {
    return null;
  }
  if (!cmdline.length) return null;
  const exe = windowsExeName(cmdline[0]);
  if (!exe || HELPER_EXES.has(exe.toLowerCase())) return null;
  let env = {};
  try {
    for (const kv of splitNul(fs.readFileSync(path.join(dir, 'environ')))) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch {
    env = {};
  }
  let steamAppId = null;
  for (const k of ['SteamAppId', 'SteamGameId', 'STEAM_COMPAT_APP_ID']) {
    const n = Number.parseInt(env[k], 10);
    if (Number.isFinite(n) && n > 0) {
      steamAppId = n;
      break;
    }
  }
  const isProton = 'STEAM_COMPAT_DATA_PATH' in env || steamAppId !== null;
  let isWine = isProton || 'WINEPREFIX' in env;
  if (!isWine) {
    try {
      const real = path.basename(fs.readlinkSync(path.join(dir, 'exe')));
      isWine = real.startsWith('wine') && real.includes('preloader');
    } catch {}
  }
  if (!isWine) return null;
  const winePrefix = env.WINEPREFIX
    || (env.STEAM_COMPAT_DATA_PATH ? `${env.STEAM_COMPAT_DATA_PATH.replace(/\/+$/, '')}/pfx` : null);
  return { steamAppId, pid, exe, cmdline, winePrefix, runner: isProton ? 'proton' : 'wine' };
}

/** One scan. Returns one entry per Steam app id (lowest pid wins). */
function scan(procRoot = '/proc') {
  const byKey = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const game = inspect(path.join(procRoot, name), pid);
    if (!game) continue;
    const key = game.steamAppId !== null ? `steam:${game.steamAppId}` : `wine:${game.exe.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || pid < prev.pid) byKey.set(key, game);
  }
  return [...byKey.values()];
}

module.exports = { scan, windowsExeName };
