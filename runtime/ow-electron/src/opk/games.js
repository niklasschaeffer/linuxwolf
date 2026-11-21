'use strict';
// Overwolf games that classic apps can target, and how to spot them among
// the Wine/Proton processes in /proc. Overwolf identifies a game by its
// "class id"; overwolf.games reports `classId` and `id` (= classId * 10).
// Keep in sync with crates/lw-detect/src/games.rs and gui/src/core/games.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../proc');
const steam = require('../steam');

const OW_GAMES = {
  28268: {
    title: 'World of Warcraft: Forever',
    // Battle.net game, usually run through Lutris/Bottles/Wine or added to
    // Steam as a non-Steam game with Proton. The client lives in
    // "World of Warcraft\_forever_\Wow.exe".
    exe: 'wow.exe',
    pathIncludes: '\\_forever_\\',
    windowTitle: /^World of Warcraft/i,
    installDirs: ['Program Files (x86)\\World of Warcraft\\_forever_', 'Program Files\\World of Warcraft\\_forever_'],
  },
  23186: { title: 'Palia', steamAppId: 2707930, exe: 'paliaclientsteam-win64-shipping.exe' },
};

/** Windows-style path of the game's exe from its command line. */
function exePath(p) {
  return String(p.cmdline[0] || '').replace(/\//g, '\\');
}

function matches(def, p) {
  if (def.steamAppId && p.steamAppId === def.steamAppId) return true;
  if (!def.exe || p.exe.toLowerCase() !== def.exe) return false;
  return !def.pathIncludes || exePath(p).toLowerCase().includes(def.pathIncludes.toLowerCase());
}

/** Running games among `classIds`: [{ classId, title, pid, exePath, winePrefix, runner, steamAppId }]. */
function running(classIds, procRoot = '/proc') {
  const procs = proc.scanAll(procRoot);
  const out = [];
  for (const classId of classIds) {
    const def = OW_GAMES[classId];
    if (!def) continue;
    const p = procs.find((x) => matches(def, x));
    if (p) out.push({ classId, title: def.title, pid: p.pid, exePath: exePath(p), winePrefix: p.winePrefix, runner: p.runner, steamAppId: p.steamAppId, cmdline: p.cmdline });
  }
  return out;
}

/** Wine prefixes worth looking at: configured, Lutris/Bottles/Wine defaults, Steam compatdata. */
function candidatePrefixes(home = os.homedir(), env = process.env) {
  const out = [];
  const add = (p) => p && !out.includes(p) && out.push(p);
  for (const p of String(env.LINUXWOLF_WINEPREFIX || '').split(':')) add(p);
  add(env.WINEPREFIX);
  add(path.join(home, '.wine'));
  const sub = (dir, suffix = '') => {
    try {
      for (const n of fs.readdirSync(dir)) add(path.join(dir, n, suffix));
    } catch {}
  };
  sub(path.join(home, 'Games')); // Lutris default: ~/Games/<game>
  sub(path.join(home, '.local/share/bottles/bottles'));
  sub(path.join(home, '.var/app/com.usebottles.bottles/data/bottles/bottles'));
  sub(path.join(home, '.var/app/net.lutris.Lutris/data/lutris/runners/wine/prefixes'));
  for (const lib of steam.libraries()) sub(path.join(lib, 'compatdata'), 'pfx');
  return out.filter((p) => fs.existsSync(path.join(p, 'drive_c')));
}

/**
 * Where the game is installed when it is not running:
 * { prefix, exePath (Windows path) } or null.
 */
function findInstall(classId, prefixes = candidatePrefixes()) {
  const def = OW_GAMES[classId];
  if (!def || !def.installDirs) return null;
  for (const prefix of prefixes) {
    for (const dir of def.installDirs) {
      const rel = [...dir.split('\\'), def.exe];
      // Case-insensitive walk, like Windows.
      let cur = path.join(prefix, 'drive_c');
      let ok = true;
      for (const part of rel) {
        let names = [];
        try {
          names = fs.readdirSync(cur);
        } catch {
          ok = false;
          break;
        }
        const hit = names.find((n) => n.toLowerCase() === part.toLowerCase());
        if (!hit) {
          ok = false;
          break;
        }
        cur = path.join(cur, hit);
      }
      if (ok) return { prefix, exePath: `C:\\${dir}\\${path.basename(cur)}` };
    }
  }
  return null;
}

module.exports = { OW_GAMES, running, matches, candidatePrefixes, findInstall };
