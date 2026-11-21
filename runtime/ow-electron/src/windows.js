'use strict';
// Always-on-top and click-through companion windows on KDE Plasma.
//
// ow-electron apps put game companions in transparent windows with
// setAlwaysOnTop(true, "screen-saver") + setIgnoreMouseEvents(true). On
// Windows the "screen-saver" level stays above borderless/fullscreen games.
// On Linux it depends on the window system:
//
// X11/XWayland (default): Electron sets _NET_WM_STATE_ABOVE, but KWin puts
//   the focused fullscreen game in a higher layer than "keep above". For
//   click-through screen-saver windows Linuxwolf also sets the window type
//   to KDE's on-screen-display type, which KWin stacks above fullscreen
//   windows (LINUXWOLF_OSD=all does it for interactive ones too, at the cost
//   of keyboard focus). Proton games are XWayland windows, so both live in the same X
//   stack, and X11 global shortcuts keep working while the game has focus.
//
// Native Wayland (LINUXWOLF_BACKEND=wayland): Wayland has no always-on-top
//   for normal windows. Linuxwolf asks KWin through a small KWin script to
//   set keepAbove on the window. This does not beat a focused fullscreen game.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./log');

const OSD_TYPES = '_KDE_NET_WM_WINDOW_TYPE_ON_SCREEN_DISPLAY,_NET_WM_WINDOW_TYPE_NOTIFICATION';

function backend(app) {
  const ozone = app.commandLine.getSwitchValue('ozone-platform');
  if (ozone) return ozone;
  return process.env.LINUXWOLF_BACKEND || (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY ? 'wayland' : 'x11');
}

function xid(win) {
  try {
    const h = win.getNativeWindowHandle();
    return h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
  } catch {
    return 0;
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    childProcess.execFile(cmd, args, { timeout: 3000 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function markOsdX11(win) {
  const id = xid(win);
  if (!id) return;
  const r = await run('xprop', ['-id', String(id), '-f', '_NET_WM_WINDOW_TYPE', '32a', '-set', '_NET_WM_WINDOW_TYPE', OSD_TYPES]);
  if (r.err) log(`[windows] xprop failed for 0x${id.toString(16)} (install xprop / x11-utils): ${r.err.code || r.err.message}`);
  else log(`[windows] window 0x${id.toString(16)} "${win.getTitle()}" -> on-screen-display layer`);
}

let scriptSeq = 0;
async function keepAboveKWin(win) {
  const title = win.getTitle();
  const file = path.join(os.tmpdir(), `linuxwolf-kwin-${process.pid}-${++scriptSeq}.js`);
  const name = `linuxwolf-${process.pid}-${scriptSeq}`;
  fs.writeFileSync(
    file,
    `const list = workspace.windowList ? workspace.windowList() : workspace.clientList();
for (const w of list) {
  if (w.pid === ${process.pid} && w.caption === ${JSON.stringify(title)}) {
    w.keepAbove = true; w.skipTaskbar = true; w.skipSwitcher = true; w.skipPager = true;
  }
}`,
  );
  const load = await run('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/Scripting', '--method', 'org.kde.kwin.Scripting.loadScript', file, name]);
  const m = /\((-?\d+),?\)/.exec(load.stdout);
  if (load.err || !m || Number(m[1]) < 0) {
    log(`[windows] KWin script not loaded (not on KDE?): ${load.stderr.trim() || load.stdout.trim()}`);
    fs.rmSync(file, { force: true });
    return;
  }
  for (const objPath of [`/Scripting/Script${m[1]}`, `/${m[1]}`]) {
    const r = await run('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', objPath, '--method', 'org.kde.kwin.Script.run']);
    if (!r.err) break;
  }
  setTimeout(() => {
    run('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/Scripting', '--method', 'org.kde.kwin.Scripting.unloadScript', name]);
    fs.rmSync(file, { force: true });
  }, 2000).unref?.();
  log(`[windows] KWin keepAbove requested for "${title}"`);
}

function inertWindow(win, label = win.getTitle()) {
  if (!win || win.isDestroyed()) return win;
  const noop = function () {};
  win.show = noop;
  win.showInactive = noop;
  win.focus = noop;
  win.moveTop = noop;
  win.setFocusable = noop;
  win.setIgnoreMouseEvents = noop;
  win.setAlwaysOnTop = noop;
  try {
    win.hide();
    win.blur();
    win.setSkipTaskbar(true);
    win.constructor.prototype.setFocusable.call(win, false);
    win.constructor.prototype.setIgnoreMouseEvents.call(win, true);
  } catch (e) {
    log(`[windows] ${label}: ${e.message}`);
  }
  log(`[windows] ${label}: kept hidden (no ow-electron overlay on Linux)`);
  return win;
}

function install(app, BrowserWindow) {
  const mode = backend(app);
  // Which screen-saver windows go to KWin's on-screen-display layer:
  // "clickthrough" (default), "all" (also interactive ones; they then cannot
  // take keyboard focus) or "off".
  const osdMode = process.env.LINUXWOLF_OSD || 'clickthrough';
  const state = new WeakMap(); // win -> { clickThrough, top, osd }
  const st = (w) => {
    if (!state.has(w)) state.set(w, { clickThrough: false, top: null, osd: false });
    return state.get(w);
  };

  const apply = (win) => {
    const s = st(win);
    if (win.isDestroyed() || !s.top) return;
    if (mode === 'wayland') {
      keepAboveKWin(win).catch((e) => log(`[windows] KWin: ${e.message}`));
    } else if (s.top === 'screen-saver' && !s.osd && (osdMode === 'all' || (osdMode === 'clickthrough' && s.clickThrough))) {
      s.osd = true;
      markOsdX11(win).catch((e) => log(`[windows] xprop: ${e.message}`));
    }
  };

  const proto = BrowserWindow.prototype;
  const origTop = proto.setAlwaysOnTop;
  proto.setAlwaysOnTop = function (flag, level, ...rest) {
    const r = origTop.call(this, flag, level, ...rest);
    st(this).top = flag ? level || 'floating' : null;
    if (flag) {
      if (this.isVisible()) apply(this);
      else this.once('show', () => apply(this));
    }
    return r;
  };
  const origIgnore = proto.setIgnoreMouseEvents;
  proto.setIgnoreMouseEvents = function (ignore, options, ...rest) {
    // Electron on Linux has no `forward` option; clicks just pass through.
    const r = origIgnore.call(this, ignore, options, ...rest);
    if (ignore) st(this).clickThrough = true;
    return r;
  };
  log(`[windows] window integration: ${mode}`);
  return mode;
}

module.exports = { install, backend, inertWindow };
