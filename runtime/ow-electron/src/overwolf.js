'use strict';
// Linuxwolf's `app.overwolf`, the API that the ow-electron fork adds to
// Electron's `app` object.
//
// ow-electron loads optional "packages" (gep, overlay, recorder, utility,
// ads) at runtime and announces each with packages.emit('ready', e, name,
// version). Apps check `app.overwolf?.packages` and switch features off when
// it is missing. Linuxwolf only announces the packages it really implements,
// selected with LINUXWOLF_OW_PACKAGES (comma separated). Default: none, which
// is what MetaBot needs for Aniimo.

const { EventEmitter } = require('events');
const log = require('./log');
const proc = require('./proc');

const RUNTIME_VERSION = require('../package.json').version;

/** Steam app id -> Overwolf game id, for GEP game detection. */
const OVERWOLF_GAME_IDS = {
  // Filled in as games get verified. See crates/lw-detect/src/games.rs.
};

class Gep extends EventEmitter {
  constructor() {
    super();
    this.required = new Map();
    this.running = new Map();
    this.timer = null;
  }
  async setRequiredFeatures(gameId, features) {
    this.required.set(Number(gameId), features || []);
    log(`[gep] setRequiredFeatures(${gameId}, ${JSON.stringify(features)}) -> accepted, no events yet`);
    return true;
  }
  async getInfo(gameId) {
    return { gameId: Number(gameId), info: {} };
  }
  async getFeatures() {
    return [];
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      const now = new Map();
      for (const g of proc.scan()) {
        const owId = g.steamAppId && OVERWOLF_GAME_IDS[g.steamAppId];
        if (owId) now.set(owId, g);
      }
      for (const [id, g] of now) {
        if (this.running.has(id)) continue;
        const event = { gameId: id, name: g.exe, pid: g.pid, enable: () => {}, disable: () => {} };
        this.emit('game-detected', event, id, g.exe, {});
      }
      for (const id of this.running.keys()) if (!now.has(id)) this.emit('game-exit', {}, id, '', {});
      this.running = now;
    };
    this.timer = setInterval(tick, 2000);
    this.timer.unref?.();
    tick();
  }
}

class Utility extends EventEmitter {
  async scan() {
    return [];
  }
}

const IMPLEMENTATIONS = {
  gep: () => {
    const g = new Gep();
    g.start();
    return g;
  },
  utility: () => new Utility(),
};

class Packages extends EventEmitter {
  constructor(enabled) {
    super();
    this.enabled = enabled;
  }
  announce() {
    for (const name of this.enabled) {
      const make = IMPLEMENTATIONS[name];
      if (!make) {
        log(`[overwolf] package "${name}" is not implemented, skipping`);
        continue;
      }
      if (!this[name]) this[name] = make();
      log(`[overwolf] package ready: ${name}`);
      this.emit('loading', {}, name);
      this.emit('ready', {}, name, `linuxwolf-${RUNTIME_VERSION}`);
    }
  }
  relaunch() {
    setTimeout(() => this.announce(), 500);
  }
}

function install(app, { uid } = {}) {
  const enabled = String(process.env.LINUXWOLF_OW_PACKAGES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const overwolf = {
    isLinuxwolf: true,
    version: `linuxwolf-${RUNTIME_VERSION}`,
    uid: uid || null,
  };
  if (enabled.length) {
    overwolf.packages = new Packages(enabled);
    // Real ow-electron announces packages a moment after app ready.
    app.whenReady().then(() => setTimeout(() => overwolf.packages.announce(), 1000));
  }
  // Ads APIs (openAdPrivacySettingsWindow, generateUserEmailHashes,
  // setUserEmailHashes) are left out on purpose: no Overwolf ads SDK here.
  Object.defineProperty(app, 'overwolf', { value: overwolf, configurable: true, enumerable: false });
  log(`[overwolf] app.overwolf installed, packages: ${enabled.length ? enabled.join(', ') : 'none'}`);
  return overwolf;
}

module.exports = { install, Packages, OVERWOLF_GAME_IDS };
