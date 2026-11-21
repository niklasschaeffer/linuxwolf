'use strict';
// Steam games on this machine and the ones running under Proton/Wine right
// now. Uses the same Steam and /proc code as the ow-electron runtime.

const fs = require('fs');
const path = require('path');
const steam = require('../../../runtime/ow-electron/src/steam');
const proc = require('../../../runtime/ow-electron/src/proc');
const vdf = require('../../../runtime/ow-electron/src/vdf');
const owGames = require('../../../runtime/ow-electron/src/opk/games');

/**
 * Games Linuxwolf knows by name: Steam app ids (keep in sync with
 * crates/lw-detect/src/games.rs) and non-Steam Wine games by key, matched
 * through the classic-app runtime's table (runtime/ow-electron/src/opk/games.js).
 */
const KNOWN_GAMES = {
  4126040: { name: 'Aniimo', overwolfGameId: null },
  2707930: { name: 'Palia', overwolfGameId: 23186 },
  'wow-forever': { name: 'World of Warcraft: Forever', overwolfGameId: 28268, steam: false },
};
const WINE_GAMES = Object.entries(KNOWN_GAMES).filter(([, g]) => g.steam === false);

// Steam installs these like games. They are not.
const NOT_GAMES = /^(Proton|Steam Linux Runtime|Steamworks Common Redistributables|SteamVR)\b/i;

/** Installed Steam games: [{ appId, name, installDir, library }], sorted by name. */
function installed() {
  const out = new Map();
  for (const lib of steam.libraries()) {
    let names = [];
    try {
      names = fs.readdirSync(lib);
    } catch {}
    for (const n of names) {
      const m = /^appmanifest_(\d+)\.acf$/i.exec(n);
      if (!m || out.has(Number(m[1]))) continue;
      const appId = Number(m[1]);
      let state = {};
      try {
        state = vdf.get(vdf.parse(fs.readFileSync(path.join(lib, n), 'utf8')), 'AppState') || {};
      } catch {}
      const name = vdf.get(state, 'name') || KNOWN_GAMES[appId]?.name || `Steam app ${appId}`;
      if (NOT_GAMES.test(name)) continue;
      const dir = vdf.get(state, 'installdir');
      out.set(appId, { appId, name, installDir: dir ? path.join(lib, 'common', dir) : null, library: lib });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Games running under Proton/Wine: [{ appId, pid, exe, runner, winePrefix, name }].
 * `appId` is the Steam app id, or the KNOWN_GAMES key of a non-Steam game
 * (e.g. "wow-forever", also when it was added to Steam as a non-Steam game).
 */
function running(procRoot = '/proc') {
  const out = [];
  const taken = new Set();
  const wine = owGames.running(WINE_GAMES.map(([, g]) => g.overwolfGameId), procRoot);
  for (const [key, g] of WINE_GAMES) {
    const p = wine.find((w) => w.classId === g.overwolfGameId);
    if (!p) continue;
    out.push({ appId: key, pid: p.pid, exe: p.cmdline[0].split(/[\\/]/).pop(), runner: p.runner, winePrefix: p.winePrefix, name: g.name });
    taken.add(p.pid);
    // Its launcher (e.g. Battle.net) shares the non-Steam shortcut's id.
    if (p.steamAppId) taken.add(`steam:${p.steamAppId}`);
  }
  for (const g of proc.scan(procRoot)) {
    if (taken.has(g.pid) || (g.steamAppId && taken.has(`steam:${g.steamAppId}`))) continue;
    out.push({
      appId: g.steamAppId,
      pid: g.pid,
      exe: g.exe,
      runner: g.runner,
      winePrefix: g.winePrefix,
      name: (g.steamAppId && KNOWN_GAMES[g.steamAppId]?.name) || null,
    });
  }
  return out;
}

/** Keys of known non-Steam games installed in a Wine prefix Linuxwolf can find. */
function installedWine(prefixes = owGames.candidatePrefixes()) {
  return WINE_GAMES.filter(([, g]) => owGames.findInstall(g.overwolfGameId, prefixes)).map(([key]) => key);
}

/**
 * Turns successive scans into started/stopped events, keyed by Steam app id
 * (or exe for non-Steam Wine games) like `lw-detect --watch`.
 */
class GameWatcher {
  constructor() {
    this.current = new Map();
  }

  static key(g) {
    return g.appId ? `steam:${g.appId}` : `wine:${String(g.exe).toLowerCase()}`;
  }

  update(games) {
    const now = new Map(games.map((g) => [GameWatcher.key(g), g]));
    const started = [...now].filter(([k]) => !this.current.has(k)).map(([, g]) => g);
    const stopped = [...this.current].filter(([k]) => !now.has(k)).map(([, g]) => g);
    this.current = now;
    return { started, stopped };
  }
}

module.exports = { KNOWN_GAMES, installed, installedWine, running, GameWatcher };
