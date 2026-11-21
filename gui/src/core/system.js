'use strict';
// What the machine looks like from Linuxwolf's point of view: session,
// Steam, tools the install scripts need, Vulkan overlay layer.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('./paths');
const steam = require('../../../runtime/ow-electron/src/steam');

const TOOLS = ['curl', 'openssl', '7z', 'python3', 'sha256sum', 'xprop', 'cargo', 'steam'];

function which(name, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(':').filter(Boolean)) {
    const f = path.join(dir, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

function overlayLayer() {
  const manifest = path.join(paths.dataHome(), 'vulkan', 'implicit_layer.d', 'VkLayer_linuxwolf_overlay.json');
  const lib = path.join(paths.dataHome(), 'linuxwolf', 'libVkLayer_linuxwolf_overlay.so');
  return {
    installed: fs.existsSync(manifest) && fs.existsSync(lib),
    manifest,
    lib,
    launchOption: 'LINUXWOLF_OVERLAY=1 %command%',
    debugLaunchOption: 'LINUXWOLF_OVERLAY=1 LINUXWOLF_OVERLAY_DEBUG=1 %command%',
  };
}

let glibcCache;
function glibc() {
  if (glibcCache !== undefined) return glibcCache;
  try {
    return (glibcCache = execFileSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8', timeout: 2000 }).trim().split(' ')[1] || null);
  } catch {
    return (glibcCache = null);
  }
}

function ptraceScope() {
  try {
    return fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim();
  } catch {
    return null;
  }
}

/** Snapshot for the System page. */
function info(env = process.env) {
  const tools = Object.fromEntries(TOOLS.map((t) => [t, Boolean(which(t, env.PATH))]));
  return {
    session: env.XDG_SESSION_TYPE || (env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : 'unknown'),
    desktop: env.XDG_CURRENT_DESKTOP || null,
    display: env.DISPLAY || null,
    waylandDisplay: env.WAYLAND_DISPLAY || null,
    xwayland: Boolean(env.WAYLAND_DISPLAY && env.DISPLAY),
    steamRoots: steam.roots(),
    tools,
    fuse: fs.existsSync('/dev/fuse'),
    glibc: glibc(),
    ptraceScope: ptraceScope(),
    overlay: overlayLayer(),
    versions: { node: process.versions.node, electron: process.versions.electron || null },
    repoRoot: paths.repoRoot,
    appsDir: paths.appsDir(),
  };
}

module.exports = { info, which, overlayLayer, TOOLS };
