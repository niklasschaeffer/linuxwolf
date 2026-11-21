'use strict';
// The apps Linuxwolf knows how to install and start, merged with what is
// installed under ~/.local/share/linuxwolf/apps.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const METABOT_UID = 'iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf';
const WOW_FOREVER_MAP_UID = 'pjmcljgifdbecdpkdjjaklihmacmfjdondplefhg';

/**
 * Known apps. `games` are the games the app is useful for on Linux (the GUI
 * starts the app with these games when auto-start is on): Steam app ids, or
 * keys of non-Steam games in games.KNOWN_GAMES.
 */
const KNOWN_APPS = [
  {
    id: 'metabot',
    name: 'MetaBot.GG',
    kind: 'ow-electron',
    uid: METABOT_UID,
    games: [4126040],
    description: 'Stats, companion and overlays. Runs natively on the Linuxwolf ow-electron runtime.',
    homepage: 'https://metabot.gg/',
    source: "Overwolf's update feed",
    needs: ['curl', 'openssl', '7z'],
  },
  {
    id: 'thgl-companion',
    name: 'TH.GL Companion',
    kind: 'appimage',
    games: [2707930],
    description: "th.gl's own native Linux app (beta): Palia map, live position and overlay.",
    homepage: 'https://www.th.gl/apps/palia',
    source: "th.gl's release feed",
    needs: ['curl', 'python3', 'sha256sum'],
    check: 'thgl-palia-check.sh',
  },
  {
    id: 'wow-forever-map',
    name: 'WoW Forever Map',
    kind: 'opk',
    uid: WOW_FOREVER_MAP_UID,
    games: ['wow-forever'],
    description: 'Interactive map, quests, guides and an in-game minimap for World of Warcraft: Forever. Classic Overwolf app on the Linuxwolf runtime.',
    homepage: 'https://www.overwolf.com/app/rastudio-wow_forever_map',
    source: "Overwolf's store catalog",
    needs: ['curl', 'python3'],
  },
];

/** Compare dotted version strings numerically ("4.0.10" > "4.0.4"). */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/);
  const pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const d = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** package.json of an installed ow-electron app (Electron can read inside app.asar). */
function readAppPackage(versionDir) {
  for (const rel of ['resources/app.asar/package.json', 'resources/app/package.json']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(versionDir, rel), 'utf8'));
    } catch {}
  }
  return null;
}

function isAppDir(versionDir) {
  return ['resources/app.asar', 'resources/app'].some((rel) => fs.existsSync(path.join(versionDir, rel)));
}

/** manifest.json of an installed classic Overwolf app, or null. */
function readOpkManifest(versionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(versionDir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** Installed classic Overwolf apps (.opk, unpacked): Map uid -> { dir, version, versions, productName }. */
function installedOpk(appsDir = paths.appsDir()) {
  return installedBy(appsDir, (dir) => fs.existsSync(path.join(dir, 'manifest.json')), (dir) => readOpkManifest(dir)?.meta?.name);
}

/** Installed ow-electron apps: Map uid -> { dir, version, versions, productName }. */
function installedOwElectron(appsDir = paths.appsDir()) {
  return installedBy(appsDir, isAppDir, (dir) => {
    const pkg = readAppPackage(dir) || {};
    return pkg.productName || pkg.name;
  });
}

function installedBy(appsDir, isInstalled, nameOf) {
  const out = new Map();
  let uids = [];
  try {
    uids = fs.readdirSync(appsDir).filter((n) => /^[a-z]{40}$/.test(n));
  } catch {}
  for (const uid of uids) {
    let versions = [];
    try {
      versions = fs.readdirSync(path.join(appsDir, uid)).filter((v) => isInstalled(path.join(appsDir, uid, v)));
    } catch {}
    if (!versions.length) continue;
    versions.sort(compareVersions);
    const version = versions[versions.length - 1];
    const dir = path.join(appsDir, uid, version);
    out.set(uid, { dir, version, versions, productName: nameOf(dir) || uid });
  }
  return out;
}

function thglAppImage(appsDir = paths.appsDir()) {
  return path.join(appsDir, 'thgl-companion', 'THGL_Companion-x86_64.AppImage');
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** All apps for the library view: known ones (installed or not) plus any other installed Overwolf app. */
function listApps(appsDir = paths.appsDir()) {
  const installed = { 'ow-electron': installedOwElectron(appsDir), opk: installedOpk(appsDir) };
  const apps = KNOWN_APPS.map((a) => {
    const app = { ...a, installed: false, version: null, path: null };
    const ow = installed[a.kind];
    if (ow && ow.has(a.uid)) {
      const i = ow.get(a.uid);
      Object.assign(app, { installed: true, version: i.version, path: i.dir, installDir: path.join(appsDir, a.uid) });
      ow.delete(a.uid);
    } else if (ow) {
      app.installDir = path.join(appsDir, a.uid);
    } else if (a.kind === 'appimage') {
      const file = thglAppImage(appsDir);
      app.installDir = path.dirname(file);
      if (isExecutable(file)) Object.assign(app, { installed: true, path: file });
    }
    return app;
  });
  for (const [kind, ow] of Object.entries(installed)) {
    for (const [uid, i] of ow) {
      const opk = kind === 'opk';
      apps.push({
        id: `ow:${uid}`,
        name: i.productName,
        kind,
        uid,
        games: [],
        description: opk ? "Classic Overwolf app installed from Overwolf's store catalog. Not tested with Linuxwolf yet." : 'ow-electron app installed from Overwolf\'s update feed. Not tested with Linuxwolf yet.',
        source: opk ? "Overwolf's store catalog" : "Overwolf's update feed",
        needs: opk ? ['curl', 'python3'] : ['curl', 'openssl', '7z'],
        installed: true,
        version: i.version,
        path: i.dir,
        installDir: path.join(appsDir, uid),
        custom: true,
      });
    }
  }
  return apps;
}

/** Command to install (or update) an app: [file, ...args]. */
function installCommand(app) {
  if (app.kind === 'ow-electron') return [paths.tool('fetch-ow-electron-app.sh'), app.uid];
  if (app.kind === 'opk') return [paths.tool('fetch-opk-app.sh'), app.uid];
  if (app.id === 'thgl-companion') return [paths.tool('fetch-thgl-companion.sh')];
  return null;
}

/** Command and extra environment to start an installed app. */
function launchCommand(app, settings = {}, env = process.env) {
  if (!app.installed) return null;
  if (app.kind === 'ow-electron' || app.kind === 'opk') {
    const extra = { LINUXWOLF_BACKEND: settings.backend || 'x11' };
    if (settings.osd && settings.osd !== 'clickthrough') extra.LINUXWOLF_OSD = settings.osd;
    if (settings.debug) extra.LINUXWOLF_DEBUG = '1';
    return { file: paths.runner(), args: [app.path], env: extra };
  }
  if (app.kind === 'appimage') {
    // Without FUSE an AppImage can still run by unpacking itself first.
    const extra = fs.existsSync('/dev/fuse') || env.APPIMAGE_EXTRACT_AND_RUN ? {} : { APPIMAGE_EXTRACT_AND_RUN: '1' };
    return { file: app.path, args: [], env: extra };
  }
  return null;
}

module.exports = { KNOWN_APPS, METABOT_UID, WOW_FOREVER_MAP_UID, compareVersions, installedOwElectron, installedOpk, listApps, installCommand, launchCommand, thglAppImage };
