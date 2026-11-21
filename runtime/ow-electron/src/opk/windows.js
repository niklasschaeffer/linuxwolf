'use strict';
// Overwolf windows (manifest "data.windows") as Electron BrowserWindows.
//
// Overwolf draws in-game windows into the game. Linuxwolf shows them as
// transparent, frameless, always-on-top windows over the game instead (like
// the ow-electron runtime does for MetaBot, see ../windows.js for how that
// behaves on KDE). Desktop windows are normal frameless windows; apps draw
// their own title bar and call dragMove/minimize/close.

const path = require('path');
const { BrowserWindow, screen, shell } = require('electron');
const log = require('../log');

const PRELOAD = path.join(__dirname, 'preload.js');

class OpkWindows {
  /**
   * @param {object} o
   * @param {object} o.manifest
   * @param {string} o.uid
   * @param {string} o.origin  overwolf-extension://<uid>
   * @param {string} o.icon  window icon (png)
   * @param {string} o.launchSource  ?source= for the start window
   * @param {() => object|null} o.gameDisplay  Electron display the game runs on
   * @param {() => void} o.onQuit
   */
  constructor({ manifest, uid, origin, icon, launchSource = 'dock', gameDisplay = () => null, onQuit = () => {} }) {
    this.manifest = manifest;
    this.uid = uid;
    this.origin = origin;
    this.icon = icon;
    this.launchSource = launchSource;
    this.gameDisplay = gameDisplay;
    this.onQuit = onQuit;
    this.decls = (manifest.data && manifest.data.windows) || {};
    this.items = new Map(); // name -> { win, stateEx, styles:Set, everShown }
    this.drag = null;
  }

  id(name) {
    return `Window_Extension_${this.uid}_${name}`;
  }

  /** Window name from an Overwolf window id or name. */
  nameOf(idOrName) {
    if (typeof idOrName !== 'string') return null;
    const prefix = `Window_Extension_${this.uid}_`;
    const name = idOrName.startsWith(prefix) ? idOrName.slice(prefix.length) : idOrName;
    return this.decls[name] ? name : null;
  }

  nameOfWebContents(wc) {
    for (const [name, it] of this.items) if (!it.win.isDestroyed() && it.win.webContents === wc) return name;
    return null;
  }

  /** Every live window's webContents (for events). */
  allWebContents() {
    return [...this.items.values()].filter((it) => !it.win.isDestroyed()).map((it) => it.win.webContents);
  }

  broadcast(event, payload) {
    for (const wc of this.allWebContents()) wc.send('lw-opk:event', event, payload);
  }

  sendTo(name, event, payload) {
    const it = this.items.get(name);
    if (it && !it.win.isDestroyed()) it.win.webContents.send('lw-opk:event', event, payload);
  }

  isInGame(name) {
    return Boolean(this.decls[name]?.in_game_only);
  }

  /** Create (hidden) if needed. */
  obtain(name, overrides = {}) {
    let it = this.items.get(name);
    if (it && !it.win.isDestroyed()) return it;
    const d = { ...this.decls[name], ...(overrides || {}) };
    const inGame = Boolean(d.in_game_only);
    const isBg = Boolean(d.is_background_page);
    const size = d.size || {};
    const min = d.min_size || {};
    const max = d.max_size || {};
    const win = new BrowserWindow({
      show: false,
      title: this.manifest.meta?.name || name,
      icon: this.icon,
      width: size.width || 800,
      height: size.height || 600,
      minWidth: min.width || undefined,
      minHeight: min.height || undefined,
      maxWidth: max.width || undefined,
      maxHeight: max.height || undefined,
      frame: false,
      transparent: Boolean(d.transparent),
      backgroundColor: d.transparent ? '#00000000' : '#000000',
      resizable: d.resizable !== false,
      skipTaskbar: inGame || isBg,
      focusable: !(d.ignore_keyboard_events && d.grab_keyboard_focus === false),
      webPreferences: {
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: d.background_optimization !== false,
        spellcheck: false,
      },
    });
    it = { win, stateEx: 'closed', prev: 'closed', styles: new Set(), everShown: false, decl: d };
    this.items.set(name, it);

    if (d.start_position && !inGame) win.setPosition(d.start_position.left | 0, d.start_position.top | 0);
    if (inGame || d.topmost) win.setAlwaysOnTop(true, 'screen-saver');
    if (d.mute) win.webContents.setAudioMuted(true);
    if (d.clickthrough) this.setStyle(name, 'InputPassThrough', true);

    // Links: Overwolf apps open them in the default browser (force_browser: user).
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(this.origin + '/')) return;
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    });

    const set = (s) => this.setState(name, s);
    win.on('show', () => set(win.isMaximized() ? 'maximized' : 'normal'));
    win.on('hide', () => it.stateEx !== 'minimized' && it.stateEx !== 'closed' && set('hidden'));
    win.on('minimize', () => set('minimized'));
    win.on('restore', () => set(win.isMaximized() ? 'maximized' : 'normal'));
    win.on('maximize', () => set('maximized'));
    win.on('unmaximize', () => win.isVisible() && set('normal'));
    win.on('closed', () => {
      this.items.delete(name);
      it.stateEx = 'closed';
      this.emitState(name, it.prev, 'closed');
      if (isBg) this.onQuit();
    });
    win.webContents.on('console-message', (e) => {
      const level = e.level ?? 'info';
      if (process.env.LINUXWOLF_DEBUG === '1' || level === 'error' || level === 'warning') log(`[${name}] ${level}: ${e.message}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => log(`[${name}] renderer gone: ${details.reason}`));

    const q = isBg || name === this.manifest.data?.start_window ? `?source=${encodeURIComponent(this.launchSource)}` : '';
    win.loadURL(`${this.origin}/${String(d.file || 'index.html').replace(/^\/+/, '')}${q}`).catch((e) => log(`[${name}] load failed: ${e.message}`));
    log(`[windows] created ${name}${inGame ? ' (in-game, shown over the game)' : ''}${isBg ? ' (background)' : ''}`);
    return it;
  }

  setState(name, stateEx) {
    const it = this.items.get(name);
    if (!it || it.stateEx === stateEx) return;
    const prev = it.stateEx;
    it.prev = prev;
    it.stateEx = stateEx;
    this.emitState(name, prev, stateEx);
  }

  emitState(name, prevEx, nowEx) {
    const plain = (s) => (s === 'hidden' ? 'minimized' : s);
    this.broadcast('windows.onStateChanged', {
      window_id: this.id(name),
      window_name: name,
      app_id: this.uid,
      window_previous_state: plain(prevEx),
      window_state: plain(nowEx),
      window_previous_state_ex: prevEx,
      window_state_ex: nowEx,
    });
  }

  info(name) {
    const it = this.items.get(name);
    const d = this.decls[name] || {};
    const stateEx = it ? it.stateEx : 'closed';
    let b = { x: 0, y: 0, width: d.size?.width || 0, height: d.size?.height || 0 };
    if (it && !it.win.isDestroyed()) b = it.win.getBounds();
    const off = this.offset(name);
    return {
      id: this.id(name),
      name,
      width: b.width,
      height: b.height,
      top: b.y - off.y,
      left: b.x - off.x,
      isVisible: Boolean(it && !it.win.isDestroyed() && it.win.isVisible()),
      state: stateEx === 'hidden' ? 'minimized' : stateEx,
      stateEx,
      type: d.in_game_only ? 'InGameOnly' : d.desktop_only ? 'DesktopOnly' : 'Unified',
      isAlwaysOnTop: Boolean(it && !it.win.isDestroyed() && it.win.isAlwaysOnTop()),
      Name: name,
      monitorId: String(screen.getDisplayMatching(b).id),
    };
  }

  /** In-game window positions are relative to the game's screen. */
  offset(name) {
    if (!this.isInGame(name)) return { x: 0, y: 0 };
    const d = this.gameDisplay() || screen.getPrimaryDisplay();
    return { x: d.bounds.x, y: d.bounds.y };
  }

  live(idOrName) {
    const name = this.nameOf(idOrName);
    if (!name) return null;
    const it = this.items.get(name);
    return it && !it.win.isDestroyed() ? { name, it } : { name, it: null };
  }

  restore(idOrName) {
    const name = this.nameOf(idOrName);
    if (!name) return { success: false, error: `unknown window ${idOrName}` };
    const it = this.obtain(name);
    const { win, decl } = it;
    if (decl.is_background_page) return { success: true, window_id: this.id(name) };
    if (!it.everShown) {
      it.everShown = true;
      if (this.isInGame(name)) {
        // First show: on the game's screen, like Overwolf's in-game layer.
        const d = this.gameDisplay() || screen.getPrimaryDisplay();
        const [w, h] = win.getSize();
        const sp = decl.start_position;
        const x = sp ? d.bounds.x + (sp.left | 0) : d.bounds.x + Math.round((d.bounds.width - w) / 2);
        const y = sp ? d.bounds.y + (sp.top | 0) : d.bounds.y + Math.round((d.bounds.height - h) / 2);
        win.setPosition(x, y);
      } else if (!decl.start_position) {
        win.center();
      }
    }
    if (win.isMinimized()) win.restore();
    if (decl.focusable === false || (decl.ignore_keyboard_events && decl.grab_keyboard_focus === false)) win.showInactive();
    else win.show();
    this.setState(name, win.isMaximized() ? 'maximized' : 'normal');
    return { success: true, window_id: this.id(name) };
  }

  minimize(idOrName) {
    const l = this.live(idOrName);
    if (!l) return { success: false, error: 'unknown window' };
    if (l.it) {
      // Overwolf hides minimized in-game windows; a transparent overlay in the
      // task bar makes no sense either.
      if (this.isInGame(l.name)) {
        l.it.win.hide();
        this.setState(l.name, 'minimized');
      } else l.it.win.minimize();
    }
    return { success: true, window_id: this.id(l.name) };
  }

  maximize(idOrName) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    if (!l.it.win.isVisible()) this.restore(l.name);
    l.it.win.maximize();
    return { success: true, window_id: this.id(l.name) };
  }

  hide(idOrName) {
    const l = this.live(idOrName);
    if (!l) return { success: false, error: 'unknown window' };
    if (l.it) {
      l.it.win.hide();
      this.setState(l.name, 'hidden');
    }
    return { success: true, window_id: this.id(l.name) };
  }

  close(idOrName) {
    const l = this.live(idOrName);
    if (!l) return { success: false, error: 'unknown window' };
    if (l.it) l.it.win.close();
    return { success: true, window_id: this.id(l.name) };
  }

  bringToFront(idOrName, grabFocus) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    l.it.win.moveTop();
    if (grabFocus) l.it.win.focus();
    return { success: true };
  }

  sendToBack(idOrName) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    l.it.win.blur();
    return { success: true };
  }

  changeSize(idOrName, width, height) {
    const l = this.live(idOrName);
    if (!l) return { success: false, error: 'unknown window' };
    const it = l.it || this.obtain(l.name);
    it.win.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    return { success: true };
  }

  changePosition(idOrName, left, top) {
    const l = this.live(idOrName);
    if (!l) return { success: false, error: 'unknown window' };
    const it = l.it || this.obtain(l.name);
    const off = this.offset(l.name);
    it.everShown = true;
    it.win.setPosition(Math.round(left) + off.x, Math.round(top) + off.y);
    return { success: true };
  }

  setMinSize(idOrName, width, height) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    l.it.win.setMinimumSize(Math.round(width), Math.round(height));
    return { success: true };
  }

  setTopmost(idOrName, on) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    l.it.win.setAlwaysOnTop(Boolean(on), 'screen-saver');
    return { success: true };
  }

  setStyle(idOrName, style, on) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    const { it } = l;
    if (on) it.styles.add(style);
    else it.styles.delete(style);
    if (style === 'InputPassThrough') it.win.setIgnoreMouseEvents(Boolean(on));
    else if (style === 'Topmost') it.win.setAlwaysOnTop(Boolean(on) || this.isInGame(l.name), 'screen-saver');
    return { success: true };
  }

  visibleToUser(name) {
    const it = this.items.get(name);
    if (!it || it.win.isDestroyed() || !it.win.isVisible() || it.win.isMinimized()) return 'hidden';
    return 'fully';
  }

  // Window move/resize that follows the pointer until the page reports the
  // mouse button went up (overwolf-api.js) or 15 s pass.
  startDrag(idOrName, edge = null) {
    const l = this.live(idOrName);
    if (!l || !l.it) return { success: false, error: 'window not open' };
    this.endDrag();
    const win = l.it.win;
    const start = screen.getCursorScreenPoint();
    const b0 = win.getBounds();
    const [minW, minH] = win.getMinimumSize();
    const timer = setInterval(() => {
      if (win.isDestroyed()) return this.endDrag();
      const p = screen.getCursorScreenPoint();
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!edge || edge === 'None') {
        win.setPosition(b0.x + dx, b0.y + dy);
        return;
      }
      let { x, y, width, height } = b0;
      if (/Left/.test(edge)) { width = Math.max(minW || 50, b0.width - dx); x = b0.x + b0.width - width; }
      if (/Right/.test(edge)) width = Math.max(minW || 50, b0.width + dx);
      if (/Top/.test(edge)) { height = Math.max(minH || 50, b0.height - dy); y = b0.y + b0.height - height; }
      if (/Bottom/.test(edge)) height = Math.max(minH || 50, b0.height + dy);
      win.setBounds({ x, y, width, height });
    }, 16);
    const safety = setTimeout(() => this.endDrag(), 15000);
    this.drag = { timer, safety, name: l.name, b0 };
    return { success: true };
  }

  endDrag() {
    if (!this.drag) return { success: true };
    clearInterval(this.drag.timer);
    clearTimeout(this.drag.safety);
    const it = this.items.get(this.drag.name);
    const moved = it && !it.win.isDestroyed() ? it.win.getBounds() : null;
    const name = this.drag.name;
    const b0 = this.drag.b0;
    this.drag = null;
    if (moved && (moved.x !== b0.x || moved.y !== b0.y || moved.width !== b0.width || moved.height !== b0.height)) {
      // Overwolf's dragMove callback reports whether the window moved.
      return { success: true, window_id: this.id(name), HorizontalChange: moved.x - b0.x, VerticalChange: moved.y - b0.y };
    }
    return { success: true };
  }

  /** In-game windows go away with the game. */
  hideInGameWindows() {
    for (const [name, it] of this.items) {
      if (this.isInGame(name) && !it.win.isDestroyed() && it.win.isVisible()) {
        it.win.hide();
        this.setState(name, 'hidden');
      }
    }
  }

  closeAll() {
    for (const it of this.items.values()) if (!it.win.isDestroyed()) it.win.destroy();
  }
}

module.exports = { OpkWindows };
