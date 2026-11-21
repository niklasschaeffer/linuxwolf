'use strict';
// Overwolf hotkeys (manifest "hotkeys" + overwolf.settings.hotkeys) on top
// of Electron's globalShortcut. On XWayland these are X11 key grabs, so they
// also fire while the Proton/Wine game has focus.

const fs = require('fs');

// Windows virtual-key codes (what overwolf.settings.hotkeys.assign gets) ->
// Electron accelerator key names.
const VK = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 19: 'Pause', 20: 'CapsLock', 27: 'Escape', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
  44: 'PrintScreen', 45: 'Insert', 46: 'Delete',
  96: 'num0', 97: 'num1', 98: 'num2', 99: 'num3', 100: 'num4', 101: 'num5', 102: 'num6', 103: 'num7', 104: 'num8', 105: 'num9',
  106: 'nummult', 107: 'numadd', 109: 'numsub', 110: 'numdec', 111: 'numdiv',
  186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'",
};
for (let c = 48; c <= 57; c++) VK[c] = String.fromCharCode(c);
for (let c = 65; c <= 90; c++) VK[c] = String.fromCharCode(c);
for (let i = 1; i <= 24; i++) VK[111 + i] = `F${i}`;

const KEY_ALIASES = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Super', super: 'Super', esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown' };

/** "Ctrl+Shift+D" (Overwolf binding) -> "Ctrl+Shift+D" (Electron accelerator), or null. */
function toAccelerator(binding) {
  if (!binding || typeof binding !== 'string') return null;
  const parts = binding.split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => KEY_ALIASES[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p)).join('+');
}

/** overwolf.settings.hotkeys.assign argument -> binding string, or null. */
function bindingFromAssign({ virtualKey, modifiers = {} }) {
  const key = VK[virtualKey];
  if (!key) return null;
  const mods = [];
  if (modifiers.ctrl) mods.push('Ctrl');
  if (modifiers.alt) mods.push('Alt');
  if (modifiers.shift) mods.push('Shift');
  return [...mods, key].join('+');
}

class Hotkeys {
  /**
   * @param {object} o
   * @param {object} o.manifestHotkeys  manifest.data.hotkeys
   * @param {number|null} o.gameId  class id for game-scoped hotkeys (dedicated apps)
   * @param {string} o.storeFile  user bindings (JSON)
   * @param {object} o.globalShortcut  Electron's globalShortcut
   * @param {(name: string) => void} o.onPressed
   * @param {(msg: string) => void} [o.log]
   */
  constructor({ manifestHotkeys = {}, gameId = null, storeFile, globalShortcut, onPressed, log = () => {} }) {
    this.defs = manifestHotkeys;
    this.gameId = gameId;
    this.storeFile = storeFile;
    this.gs = globalShortcut;
    this.onPressed = onPressed;
    this.log = log;
    this.user = {};
    try {
      this.user = JSON.parse(fs.readFileSync(storeFile, 'utf8')) || {};
    } catch {}
    this.active = false;
    this.registered = new Map(); // accelerator -> name
  }

  binding(name) {
    if (Object.prototype.hasOwnProperty.call(this.user, name)) return this.user[name] || '';
    return this.defs[name]?.default || '';
  }

  /** Result object of overwolf.settings.hotkeys.get. */
  list() {
    const items = Object.entries(this.defs).map(([name, d]) => {
      const binding = this.binding(name);
      return { name, title: d.title || name, binding, IsUnassigned: !binding, virtualKeycode: -1, modifierKeys: 0, extensionuid: '', isPassthrough: Boolean(d.passthrough), hold: d['action-type'] === 'hold' };
    });
    return this.gameId ? { success: true, globals: [], games: { [this.gameId]: items } } : { success: true, globals: items, games: {} };
  }

  assign(name, binding) {
    if (!this.defs[name]) return { success: false, error: `unknown hotkey ${name}` };
    if (binding) {
      const acc = toAccelerator(binding);
      const other = this.registered.get(acc);
      if (other && other !== name) return { success: false, error: `already used by ${other}` };
    }
    this.user[name] = binding || '';
    try {
      fs.writeFileSync(this.storeFile, JSON.stringify(this.user, null, 2));
    } catch (e) {
      this.log(`[hotkeys] could not save: ${e.message}`);
    }
    if (this.active) this.enable();
    return { success: true };
  }

  /** Grab the keys (Linuxwolf does this while the target game runs). */
  enable() {
    this.disable();
    this.active = true;
    for (const name of Object.keys(this.defs)) {
      const acc = toAccelerator(this.binding(name));
      if (!acc) continue;
      try {
        if (this.gs.register(acc, () => this.onPressed(name))) {
          this.registered.set(acc, name);
        } else {
          this.log(`[hotkeys] ${acc} (${name}) is taken by another program`);
        }
      } catch (e) {
        this.log(`[hotkeys] ${acc} (${name}): ${e.message}`);
      }
    }
    if (this.registered.size) this.log(`[hotkeys] active: ${[...this.registered].map(([a, n]) => `${a}=${n}`).join(', ')}`);
  }

  disable() {
    for (const acc of this.registered.keys()) {
      try {
        this.gs.unregister(acc);
      } catch {}
    }
    this.registered.clear();
    this.active = false;
  }
}

module.exports = { Hotkeys, toAccelerator, bindingFromAssign, VK };
