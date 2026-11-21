'use strict';
// Steam games on this machine and the ones running under Proton/Wine right
// now. Uses the same Steam and /proc code as the ow-electron runtime.

const fs = require('fs');
const path = require('path');
const steam = require('../../../runtime/ow-electron/src/steam');
const proc = require('../../../runtime/ow-electron/src/proc');
const vdf = require('../../../runtime/ow-electron/src/vdf');

/** Games Linuxwolf knows by name. Keep in sync with crates/lw-detect/src/games.rs. */
const KNOWN_GAMES = {
  4126040: { name: 'Aniimo', overwolfGameId: null },
  2707930: { name: 'Palia', overwolfGameId: 23186 },
};

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

/** Games running under Proton/Wine: [{ appId, pid, exe, runner, winePrefix, name }]. */
function running(procRoot = '/proc') {
  return proc.scan(procRoot).map((g) => ({
    appId: g.steamAppId,
    pid: g.pid,
    exe: g.exe,
    runner: g.runner,
    winePrefix: g.winePrefix,
    name: (g.steamAppId && KNOWN_GAMES[g.steamAppId]?.name) || null,
  }));
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

module.exports = { KNOWN_GAMES, installed, running, GameWatcher };
