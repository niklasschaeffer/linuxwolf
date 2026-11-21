'use strict';
// Windows paths for classic Overwolf apps, mapped onto the Linux file system.
//
// Overwolf apps build Windows paths ("C:\Program Files (x86)\...") and hand
// them to overwolf.io. Linuxwolf keeps those paths as they are on the app's
// side and maps them here:
//
//   <letter>:\...   the game's Wine prefix (dosdevices/<letter>: symlink,
//                   drive_c for C: when there is no symlink); Z: is "/"
//   L:\...          Linuxwolf's own per-app drive for overwolf.io.paths
//                   (localAppData, documents, ...), so app data never lands
//                   inside a game prefix
//   /...            plain Linux paths pass through
//
// Windows paths are case-insensitive, Linux ones are not, so lookups match
// each path component case-insensitively when the exact name is missing
// (WoW's "Interface\AddOns" vs. "interface/addons").

const fs = require('fs');
const path = require('path');

const APP_DRIVE = 'L';

class WinPaths {
  /**
   * @param {object} o
   * @param {string} o.appDrive  Linux folder that backs L:\
   * @param {() => string|null} [o.prefix]  current Wine prefix (game's or configured)
   * @param {string} [o.user]  Windows user name used in the virtual paths
   */
  constructor({ appDrive, prefix = () => null, user = 'linuxwolf' }) {
    this.appDrive = appDrive;
    this.prefix = prefix;
    this.user = user;
  }

  /** overwolf.io.paths, all on the app drive. */
  ioPaths() {
    const base = `${APP_DRIVE}:\\Users\\${this.user}`;
    const pf = this.prefix() ? 'C:' : `${APP_DRIVE}:`;
    return {
      localAppData: `${base}\\AppData\\Local`,
      documents: `${base}\\Documents`,
      desktop: `${base}\\Desktop`,
      pictures: `${base}\\Pictures`,
      videos: `${base}\\Videos`,
      overwolfInstallation: `${APP_DRIVE}:\\Overwolf`,
      overwolfInstallationWithVersion: `${APP_DRIVE}:\\Overwolf`,
      obsBin: `${APP_DRIVE}:\\Overwolf\\obs`,
      programFiles: `${pf}\\Program Files`,
      programFilesX86: `${pf}\\Program Files (x86)`,
      commonFiles: `${pf}\\Program Files\\Common Files`,
      commonFilesX86: `${pf}\\Program Files (x86)\\Common Files`,
      commonAppData: `${pf}\\ProgramData`,
    };
  }

  /** Linux folder for a drive letter, or null. */
  driveRoot(letter) {
    letter = letter.toUpperCase();
    if (letter === APP_DRIVE) return this.appDrive;
    if (letter === 'Z') return '/';
    const pfx = this.prefix();
    if (!pfx) return null;
    const link = path.join(pfx, 'dosdevices', `${letter.toLowerCase()}:`);
    try {
      return fs.realpathSync(link);
    } catch {}
    return letter === 'C' ? path.join(pfx, 'drive_c') : null;
  }

  /**
   * Windows (or Linux) path -> Linux path. Existing components are matched
   * case-insensitively; missing ones are kept as given. Returns null for a
   * drive Linuxwolf cannot map.
   */
  toLinux(p) {
    if (typeof p !== 'string' || !p) return null;
    let root;
    let rest;
    const m = /^([A-Za-z]):(?:[\\/]|$)(.*)$/s.exec(p);
    if (m) {
      root = this.driveRoot(m[1]);
      if (!root) return null;
      rest = m[2];
    } else if (p.startsWith('/')) {
      root = '/';
      rest = p.slice(1);
    } else {
      return null;
    }
    const parts = rest.split(/[\\/]+/).filter((s) => s && s !== '.');
    let cur = root;
    for (const part of parts) {
      if (part === '..') {
        // Never climb above the drive root.
        if (path.resolve(cur) !== path.resolve(root)) cur = path.dirname(cur);
        continue;
      }
      cur = path.join(cur, matchName(cur, part));
    }
    return cur;
  }

  /** Linux path -> Windows path an app can use (inverse of toLinux). */
  toWindows(linuxPath) {
    const abs = path.resolve(linuxPath);
    const tries = [[APP_DRIVE, this.appDrive]];
    const pfx = this.prefix();
    if (pfx) {
      for (const l of 'CDEFGHIJKMNOPQRSTUVWXY') {
        const r = this.driveRoot(l);
        if (r) tries.push([l, r]);
      }
    }
    for (const [l, r] of tries) {
      const root = path.resolve(r);
      if (abs === root || abs.startsWith(root + path.sep)) return `${l}:\\${path.relative(root, abs).split(path.sep).join('\\')}`.replace(/\\$/, '\\');
    }
    return `Z:${abs.split(path.sep).join('\\')}`;
  }
}

/** Name of `want` inside `dir`: exact if it exists, else a case-insensitive match, else `want`. */
function matchName(dir, want) {
  try {
    fs.lstatSync(path.join(dir, want));
    return want;
  } catch {}
  try {
    const lower = want.toLowerCase();
    const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === lower);
    if (hit) return hit;
  } catch {}
  return want;
}

module.exports = { WinPaths, APP_DRIVE, matchName };
