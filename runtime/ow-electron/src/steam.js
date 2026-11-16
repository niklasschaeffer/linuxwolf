'use strict';
// What a Windows app learns about Steam from the registry and from
// C:\Program Files (x86)\Steam, answered from the Linux Steam client.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vdf = require('./vdf');
const proc = require('./proc');

function home() {
  return process.env.HOME || os.homedir();
}

function candidateRoots() {
  const h = home();
  return [
    process.env.LINUXWOLF_STEAM_ROOT,
    path.join(h, '.local/share/Steam'),
    path.join(h, '.steam/steam'),
    path.join(h, '.steam/root'),
    path.join(h, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
  ].filter(Boolean);
}

/** Existing Steam install roots, de-duplicated by real path. */
function roots() {
  const seen = new Set();
  const out = [];
  for (const r of candidateRoots()) {
    let real;
    try {
      real = fs.realpathSync(r);
    } catch {
      continue;
    }
    if (seen.has(real) || !fs.existsSync(path.join(real, 'steamapps'))) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/** All `<library>/steamapps` folders of all Steam roots. */
function libraries() {
  const libs = new Set();
  for (const root of roots()) {
    libs.add(path.join(root, 'steamapps'));
    try {
      const data = vdf.parse(fs.readFileSync(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8'));
      const folders = vdf.get(data, 'libraryfolders') || {};
      for (const entry of Object.values(folders)) {
        const p = entry && typeof entry === 'object' ? vdf.get(entry, 'path') : entry;
        if (typeof p === 'string' && fs.existsSync(path.join(p, 'steamapps'))) {
          libs.add(path.join(fs.realpathSync(p), 'steamapps'));
        }
      }
    } catch {}
  }
  return [...libs];
}

function installedAppIds() {
  const ids = new Set();
  for (const lib of libraries()) {
    let names = [];
    try {
      names = fs.readdirSync(lib);
    } catch {}
    for (const n of names) {
      const m = /^appmanifest_(\d+)\.acf$/i.exec(n);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

function anyInstalled(appIds) {
  const ids = installedAppIds();
  return appIds.some((id) => ids.has(String(id)));
}

/**
 * Fill an app's { game: installed } map from Steam app ids.
 * `defaults` has every game as false, `steamIds` maps game -> Steam app id.
 * Games without a Steam id (or with several, like "permafrost") keep their
 * default unless one of the ids matches.
 */
function installedMap(defaults, steamIds) {
  const ids = installedAppIds();
  const out = { ...defaults };
  for (const game of Object.keys(out)) {
    const candidates = Object.entries(steamIds)
      .filter(([k]) => k === game || k.startsWith(game))
      .map(([, v]) => String(v));
    if (candidates.some((id) => ids.has(id))) out[game] = true;
  }
  return out;
}

/** Steam's own registry emulation file (~/.steam/registry.vdf). */
function registryVdf() {
  const h = home();
  for (const f of [
    process.env.LINUXWOLF_STEAM_REGISTRY,
    path.join(h, '.steam/registry.vdf'),
    path.join(h, '.var/app/com.valvesoftware.Steam/.steam/registry.vdf'),
  ].filter(Boolean)) {
    try {
      return vdf.get(vdf.parse(fs.readFileSync(f, 'utf8')), 'Registry', 'HKCU', 'Software', 'Valve', 'Steam') || {};
    } catch {}
  }
  return {};
}

/**
 * Steam app ids that are running right now. Linux Steam keeps a `Running`
 * flag per app in registry.vdf like the Windows client does in the registry,
 * but it is only flushed now and then, so the /proc scan is the primary
 * source and the flag is a fallback.
 */
function runningAppIds(procRoot = '/proc') {
  const ids = new Set();
  for (const g of proc.scan(procRoot)) if (g.steamAppId) ids.add(String(g.steamAppId));
  const reg = registryVdf();
  const apps = vdf.get(reg, 'apps') || {};
  for (const [id, v] of Object.entries(apps)) {
    if (v && typeof v === 'object' && String(vdf.get(v, 'Running') ?? '0') !== '0') ids.add(id);
  }
  const runningAppId = String(vdf.get(reg, 'RunningAppID') ?? '0');
  if (runningAppId !== '0') ids.add(runningAppId);
  return ids;
}

module.exports = { roots, libraries, installedAppIds, anyInstalled, installedMap, runningAppIds, registryVdf };
