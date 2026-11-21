'use strict';
// overwolf.media.createScreenshotBuffer on Linux: a frame of the game.
//
// 1. From the Linuxwolf Vulkan layer, when the game runs with it
//    (LINUXWOLF_OVERLAY=1, optionally LINUXWOLF_OVERLAY_HUD=0): the layer
//    copies a presented frame to /dev/shm on request
//    (crates/lw-overlay-layer/src/capture.rs). Works for any Proton/Wine game
//    that presents through Vulkan (DXVK, VKD3D), also when it is a native
//    Wayland window, and never shows a dialog.
// 2. Otherwise Electron's desktopCapturer: the game's X11/XWayland window
//    (XComposite, no dialog). A whole-screen capture is only used on X11
//    sessions; on Wayland it would ask through the screencast portal every
//    time.

const fs = require('fs');
const path = require('path');
// Loaded lazily, so the layer part can be tested with plain Node.
const electron = () => require('electron');

const LAYER_DIR = '/dev/shm/linuxwolf-capture';

/** One frame from the Vulkan layer, or null. `key` is the game exe's file name, lowercase. */
async function layerFrame(key, { dir = LAYER_DIR, timeoutMs = 1500 } = {}) {
  if (!fs.existsSync(path.join(dir, `${key}.layer`))) return null;
  const req = path.join(dir, `${key}.req`);
  const frameFile = path.join(dir, `${key}.frame`);
  let before = 0;
  try {
    before = fs.statSync(frameFile).mtimeMs;
  } catch {}
  const now = new Date();
  fs.writeFileSync(req, '');
  fs.utimesSync(req, now, now);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    let st;
    try {
      st = fs.statSync(frameFile);
    } catch {
      continue;
    }
    if (st.mtimeMs <= before) continue;
    const data = fs.readFileSync(frameFile);
    return parseFrame(data);
  }
  return null;
}

/** Layer frame file -> { width, height, rgba: Buffer } (always RGBA). */
function parseFrame(data) {
  if (data.length < 24 || data.toString('latin1', 0, 8) !== 'LWFRAME1') return null;
  const width = data.readUInt32LE(8);
  const height = data.readUInt32LE(12);
  const isRgba = data.readUInt32LE(16) === 1;
  const px = data.subarray(24);
  if (!width || !height || px.length !== width * height * 4) return null;
  return { width, height, rgba: isRgba ? Buffer.from(px) : bgraToRgba(px) };
}

function bgraToRgba(bgra) {
  const rgba = Buffer.allocUnsafe(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
  return rgba;
}

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
    this.waylandSession = process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY);
  }

  create() {
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
    const key = String(g.exePath || '').split(/[\\/]/).pop().toLowerCase();
    if (key) {
      try {
        const f = await layerFrame(key);
        if (f) {
          if (this.source !== 'layer') this.log(`[capture] frames from the Linuxwolf Vulkan layer (${f.width}x${f.height})`);
          this.source = 'layer';
          return { success: true, format: 'rgba', width: f.width, height: f.height, stride: f.width * 4, buffer: f.rgba };
        }
      } catch (e) {
        this.log(`[capture] Vulkan layer frame failed: ${e.message}`);
      }
    }
    if (this.backend === 'wayland') return { success: false, error: 'No frame source: start the game with the Linuxwolf Vulkan layer (LINUXWOLF_OVERLAY=1)' };
    const { desktopCapturer, screen } = electron();
    const d = this.display() || screen.getPrimaryDisplay();
    const full = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    const titleRe = g.windowTitle || new RegExp(`^${g.title.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    let src = null;
    try {
      const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: full, fetchWindowIcons: false });
      src = wins.find((s) => titleRe.test(s.name));
      // On a Wayland session a whole-screen capture goes through the
      // screencast portal, which asks the user every time ("Bildschirm
      // freigeben"). Never do that from a 2-second poll.
      if (!src && !this.waylandSession) {
        const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
        src = screens.find((s) => String(s.display_id) === String(d.id)) || screens[0];
      }
      if (!src && !this.warned) {
        this.warned = true;
        this.log(
          this.waylandSession
            ? `[capture] no frames: the game window (${titleRe}) is not an X11/XWayland window and the Linuxwolf Vulkan layer is not active in the game. Start the game with LINUXWOLF_OVERLAY=1 LINUXWOLF_OVERLAY_HUD=0 (after tools/install-overlay.sh), or under XWayland`
            : `[capture] no window titled like ${titleRe} found, capturing the whole screen instead`,
        );
      }
    } catch (e) {
      return { success: false, error: `capture failed: ${e.message}` };
    }
    if (!src || src.thumbnail.isEmpty()) return { success: false, error: 'Nothing to capture' };
    const { width, height } = src.thumbnail.getSize();
    // Chromium bitmaps are BGRA on Linux; Overwolf hands out RGBA.
    const rgba = bgraToRgba(src.thumbnail.toBitmap());
    if (this.source !== 'window') this.log(`[capture] frames from the X11 window "${src.name}"`);
    this.source = 'window';
    return { success: true, format: 'rgba', width, height, stride: width * 4, buffer: rgba };
  }
}

module.exports = { GameCapture, layerFrame, parseFrame };
