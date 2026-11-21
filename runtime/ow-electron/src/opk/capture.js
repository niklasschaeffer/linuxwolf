'use strict';
// overwolf.media.createScreenshotBuffer on Linux: a frame of the game window.
//
// Uses Electron's desktopCapturer. With the default X11/XWayland backend this
// reads the game's XWayland window directly (XComposite), no portal dialog.
// On the native Wayland backend every capture would go through the
// screencast portal, so it is off there.

const { desktopCapturer, screen } = require('electron');

class GameCapture {
  /**
   * @param {object} o
   * @param {() => object|null} o.game  running game ({ title, windowTitle? }) or null
   * @param {() => object|null} o.display  Electron display the game is on
   * @param {string} o.backend  'x11' or 'wayland'
   */
  constructor({ game, display, backend, log = () => {} }) {
    this.game = game;
    this.display = display;
    this.backend = backend;
    this.log = log;
    this.buffers = new Set();
    this.seq = 0;
    this.warned = false;
  }

  create() {
    if (this.backend === 'wayland') return { success: false, error: 'Screen capture needs the X11/XWayland backend on Linuxwolf' };
    const id = ++this.seq;
    this.buffers.add(id);
    return { success: true, id };
  }

  close(id) {
    this.buffers.delete(id);
    return { success: true };
  }

  async capture(id) {
    if (!this.buffers.has(id)) return { success: false, error: 'Screenshot buffer closed' };
    const g = this.game();
    if (!g) return { success: false, error: 'No game running' };
    const d = this.display() || screen.getPrimaryDisplay();
    const full = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    const titleRe = g.windowTitle || new RegExp(`^${g.title.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    let src = null;
    try {
      const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: full, fetchWindowIcons: false });
      src = wins.find((s) => titleRe.test(s.name));
      if (!src) {
        const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
        src = screens.find((s) => String(s.display_id) === String(d.id)) || screens[0];
        if (src && !this.warned) {
          this.warned = true;
          this.log(`[capture] no window titled like ${titleRe} found, capturing the whole screen instead`);
        }
      }
    } catch (e) {
      return { success: false, error: `capture failed: ${e.message}` };
    }
    if (!src || src.thumbnail.isEmpty()) return { success: false, error: 'Nothing to capture' };
    const { width, height } = src.thumbnail.getSize();
    const bgra = src.thumbnail.toBitmap();
    // Chromium bitmaps are BGRA on Linux; Overwolf hands out RGBA.
    const rgba = Buffer.allocUnsafe(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2];
      rgba[i + 1] = bgra[i + 1];
      rgba[i + 2] = bgra[i];
      rgba[i + 3] = bgra[i + 3];
    }
    return { success: true, format: 'rgba', width, height, stride: width * 4, buffer: rgba };
  }
}

module.exports = { GameCapture };
