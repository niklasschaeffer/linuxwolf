'use strict';
// GUI settings in ~/.config/linuxwolf/gui.json.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DEFAULTS = {
  backend: 'x11', // how ow-electron apps open windows: x11 (XWayland) or wayland
  osd: 'clickthrough', // KDE on-screen-display window type: clickthrough, all, off
  debug: false, // LINUXWOLF_DEBUG for ow-electron apps
  autoStart: {}, // app id -> true: start the app when one of its games starts
  stopWithGame: false, // stop auto-started apps when the game exits
  closeToTray: true, // keep running in the tray so auto-start keeps working
};

const CHOICES = { backend: ['x11', 'wayland'], osd: ['clickthrough', 'all', 'off'] };

function sanitize(s) {
  const out = { ...DEFAULTS };
  if (!s || typeof s !== 'object') return out;
  for (const [k, allowed] of Object.entries(CHOICES)) if (allowed.includes(s[k])) out[k] = s[k];
  for (const k of ['debug', 'stopWithGame', 'closeToTray']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (s.autoStart && typeof s.autoStart === 'object') {
    out.autoStart = Object.fromEntries(Object.entries(s.autoStart).filter(([, v]) => v === true));
  }
  return out;
}

function load(file = paths.configFile()) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return sanitize(null);
  }
}

function save(settings, file = paths.configFile()) {
  const clean = sanitize(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return clean;
}

module.exports = { DEFAULTS, CHOICES, sanitize, load, save };
