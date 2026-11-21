'use strict';
// Linuxwolf host for classic Overwolf apps (.opk, "WebApp" manifest).
//
//   electron src/opk/main.js --lw-app=<unpacked app folder> [--lw-source=<origin>]
//
// Serves the app from overwolf-extension://<uid>/ (the origin it has in
// Overwolf), opens its manifest windows and gives every page an `overwolf`
// object (overwolf-api.js) backed by the handlers below. Use
// bin/linuxwolf-run instead of calling this directly; it picks this host
// when the folder has a manifest.json.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, protocol, net, ipcMain, screen, shell, clipboard, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const log = require('../log');
const kdeWindows = require('../windows');
const { WinPaths } = require('./winpath');
const { OpkIo } = require('./io');
const { Hotkeys, bindingFromAssign } = require('./hotkeys');
const { OpkWindows } = require('./windows');
const { GameCapture } = require('./capture');
const owGames = require('./games');

const SCHEME = 'overwolf-extension';
const API_FILE = path.join(__dirname, 'overwolf-api.js');
const OVERWOLF_VERSION = '0.280.0.0'; // what we tell apps; above every app's minimum so far
const RUNTIME_VERSION = require('../../package.json').version;

function fail(msg) {
  log(`error: ${msg}`);
  process.exit(2);
}

const lwOpt = (name) => {
  const a = process.argv.find((x) => x === `--lw-${name}` || x.startsWith(`--lw-${name}=`));
  return a === undefined ? undefined : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};

// 1. The app.
const appDir = path.resolve(String(lwOpt('app') || fail('missing --lw-app=<unpacked .opk folder>')));
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
} catch (e) {
  fail(`no readable manifest.json in ${appDir}: ${e.message}`);
}
if (manifest.type && manifest.type !== 'WebApp') fail(`${manifest.type} apps are not supported (only WebApp)`);
// Installed apps live in .../apps/<uid>/<version>; the uid is the app's origin.
const parentName = path.basename(path.dirname(appDir));
const uid = /^[a-p]{40}$/.test(parentName) ? parentName : `lw${crypto.createHash('sha1').update(appDir).digest('hex').replace(/[^a-f]/g, '').padEnd(38, 'a').slice(0, 38)}`;
const origin = `${SCHEME}://${uid}`;
const meta = manifest.meta || {};
const data = manifest.data || {};
const appName = meta.name || uid;
const permissions = new Set(manifest.permissions || []);
const gameIds = [...new Set([
  ...((data.game_targeting && data.game_targeting.game_ids) || []),
  ...((data.launch_events || []).flatMap((e) => (e.event_data && e.event_data.game_ids) || [])),
  ...(data.game_events || []),
])].map(Number).filter(Boolean);
const iconFile = [meta.window_icon, meta.icon].map((f) => f && path.join(appDir, f)).find((f) => f && /\.png$/i.test(f) && fs.existsSync(f));

log(`runtime ${RUNTIME_VERSION} (classic Overwolf apps), Electron ${process.versions.electron}, app ${appName} ${meta.version || '?'} (${uid})`);
if (gameIds.length) log(`games: ${gameIds.map((id) => `${id} ${owGames.OW_GAMES[id]?.title || '(not known to Linuxwolf)'}`).join(', ')}`);

app.setName(appName);
app.setPath('userData', path.join(app.getPath('appData'), 'linuxwolf-opk', appName));
const stateFile = path.join(app.getPath('userData'), 'linuxwolf-state.json');
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
};
const writeState = (patch) => {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {}
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock({ source: lwOpt('source') || 'dock' })) {
  log('already running; asked the running instance to show itself');
  app.quit();
} else {
  start();
}

function start() {
  const backend = kdeWindows.backend(app);

  // 2. Game state.
  let game = null; // { classId, title, pid, exePath, winePrefix, ... }
  let install = null; // { prefix, exePath } when found on disk
  let installCheckedAt = 0;
  const saved = readState();
  const findInstall = () => {
    if (Date.now() - installCheckedAt < 60000) return install;
    installCheckedAt = Date.now();
    for (const id of gameIds) {
      const prefixes = owGames.candidatePrefixes();
      if (saved.prefix && !prefixes.includes(saved.prefix) && fs.existsSync(saved.prefix)) prefixes.unshift(saved.prefix);
      const hit = owGames.findInstall(id, prefixes);
      if (hit) {
        if (!install || install.prefix !== hit.prefix) log(`[games] ${owGames.OW_GAMES[id].title} installed in Wine prefix ${hit.prefix}`);
        install = { ...hit, classId: id };
        return install;
      }
    }
    return install;
  };
  const currentPrefix = () => process.env.LINUXWOLF_WINEPREFIX?.split(':')[0] || game?.winePrefix || findInstall()?.prefix || saved.prefix || null;
  const gameDisplay = () => screen.getPrimaryDisplay();

  const appDrive = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'linuxwolf', 'opk-data', uid);
  fs.mkdirSync(appDrive, { recursive: true });
  const winPaths = new WinPaths({ appDrive, prefix: currentPrefix, user: os.userInfo().username || 'linuxwolf' });
  const io = new OpkIo(winPaths, log);

  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    windows.closeAll();
    app.quit();
  };
  const windows = new OpkWindows({ manifest, uid, origin, icon: iconFile, launchSource: lwOpt('source') || 'dock', gameDisplay, onQuit: quit });
  const capture = new GameCapture({
    game: () => game && { ...game, windowTitle: owGames.OW_GAMES[game.classId]?.windowTitle },
    display: gameDisplay,
    backend,
    log,
  });
  const hotkeys = new Hotkeys({
    manifestHotkeys: data.hotkeys || {},
    gameId: data.game_targeting?.type === 'dedicated' && gameIds.length === 1 ? gameIds[0] : null,
    storeFile: path.join(app.getPath('userData'), 'linuxwolf-hotkeys.json'),
    globalShortcut,
    log,
    onPressed: (name) => windows.broadcast('settings.hotkeys.onPressed', { name, state: 'down', gameId: game?.classId || 0 }),
  });

  function gameInfo() {
    if (!game) return null;
    const d = gameDisplay();
    const w = Math.round(d.bounds.width * d.scaleFactor);
    const h = Math.round(d.bounds.height * d.scaleFactor);
    return {
      success: true,
      isRunning: true,
      isInFocus: true,
      id: game.classId * 10,
      classId: game.classId,
      title: game.title,
      displayName: game.title,
      shortTitle: game.title,
      width: w,
      height: h,
      logicalWidth: d.bounds.width,
      logicalHeight: d.bounds.height,
      renderers: ['D3D11'],
      detectedRenderer: 'D3D11',
      executionPath: game.exePath,
      commandLine: game.cmdline.join(' '),
      processId: game.pid,
      sessionId: `${game.pid}`,
      monitorHandle: { value: d.id },
      windowHandle: { value: 0 },
      type: 0,
      typeAsString: 'Game',
      overlayInfo: { isInputEnabled: true },
      linuxwolf: { winePrefix: game.winePrefix, runner: game.runner, steamAppId: game.steamAppId },
    };
  }

  function pollGames() {
    let now = null;
    try {
      now = owGames.running(gameIds)[0] || null;
    } catch (e) {
      log(`[games] scan failed: ${e.message}`);
    }
    const was = game;
    if ((now && now.pid) === (was && was.pid)) return;
    game = now;
    if (now) {
      log(`[games] ${now.title} running (pid ${now.pid}, ${now.runner}, prefix ${now.winePrefix || '?'})`);
      if (now.winePrefix) writeState({ prefix: now.winePrefix });
      hotkeys.enable();
      const gi = gameInfo();
      windows.broadcast('games.onGameLaunched', gi);
      windows.broadcast('games.onGameInfoUpdated', { gameInfo: gi, runningChanged: true, gameChanged: !was, focusChanged: true, resolutionChanged: false, reason: ['gameLaunched'] });
    } else {
      log(`[games] ${was.title} exited`);
      hotkeys.disable();
      windows.hideInGameWindows();
      windows.broadcast('games.onGameInfoUpdated', {
        gameInfo: { isRunning: false, classId: was.classId, id: was.classId * 10, title: was.title, processId: was.pid },
        runningChanged: true,
        gameChanged: false,
        focusChanged: false,
        resolutionChanged: false,
        reason: ['gameTerminated'],
      });
    }
  }

  // 3. Tray (overwolf.os.tray).
  let tray = null;
  function setTrayMenu({ menu_items: items = [] } = {}) {
    if (!tray) {
      const img = iconFile ? nativeImage.createFromPath(iconFile).resize({ width: 22, height: 22 }) : nativeImage.createEmpty();
      tray = new Tray(img);
      tray.setToolTip(appName);
      tray.on('click', () => windows.broadcast('os.tray.onTrayIconClicked', {}));
      tray.on('double-click', () => windows.broadcast('os.tray.onTrayIconDoubleClicked', {}));
    }
    const toItem = (i) =>
      i.label === '-' || i.type === 'separator'
        ? { type: 'separator' }
        : {
            label: String(i.label || ''),
            enabled: i.enabled !== false,
            submenu: Array.isArray(i.sub_items) && i.sub_items.length ? i.sub_items.map(toItem) : undefined,
            click: () => windows.broadcast('os.tray.onMenuItemClicked', { item: i.id }),
          };
    tray.setContextMenu(Menu.buildFromTemplate(items.map(toItem)));
    return { success: true };
  }

  // 4. API handlers: "namespace.method" -> (sender window name, args) => result.
  const idArg = (sender, a) => (typeof a === 'string' ? a : sender);
  const H = {
    'windows.getCurrentWindow': (s) => ({ success: true, status: 'success', window: windows.info(s) }),
    'windows.obtainDeclaredWindow': (s, [name, overrides]) => {
      if (!windows.nameOf(name)) return { success: false, status: 'error', error: `Window ${name} is not declared in the manifest` };
      windows.obtain(windows.nameOf(name), typeof overrides === 'object' ? overrides : {});
      return { success: true, status: 'success', window: windows.info(windows.nameOf(name)) };
    },
    'windows.getWindow': (s, [name]) => (windows.nameOf(name) ? { success: true, window: windows.info(windows.nameOf(name)) } : { success: false, error: `unknown window ${name}` }),
    'windows.getWindowState': (s, [id]) => {
      const n = windows.nameOf(id);
      if (!n) return { success: false, error: 'unknown window' };
      const i = windows.info(n);
      return { success: true, status: 'success', window_id: i.id, window_state: i.state, window_state_ex: i.stateEx };
    },
    'windows.getWindowsStates': () => {
      const result = {};
      const resultV2 = {};
      for (const n of Object.keys(windows.decls)) {
        const i = windows.info(n);
        result[n] = i.state;
        resultV2[n] = i.stateEx;
      }
      return { success: true, status: 'success', result, resultV2 };
    },
    'windows.getOpenWindows': () => ({ success: true, windows: Object.keys(windows.decls).filter((n) => windows.info(n).stateEx !== 'closed') }),
    'windows.restore': (s, [id]) => windows.restore(idArg(s, id)),
    'windows.minimize': (s, [id]) => windows.minimize(idArg(s, id)),
    'windows.maximize': (s, [id]) => windows.maximize(idArg(s, id)),
    'windows.hide': (s, [id]) => windows.hide(idArg(s, id)),
    'windows.close': (s, [id]) => windows.close(idArg(s, id)),
    'windows.bringToFront': (s, [id, grab]) => windows.bringToFront(typeof id === 'boolean' ? s : idArg(s, id), typeof id === 'boolean' ? id : grab),
    'windows.sendToBack': (s, [id]) => windows.sendToBack(idArg(s, id)),
    'windows.changeSize': (s, [a, w, h]) => (a && typeof a === 'object' ? windows.changeSize(a.window_id, a.width, a.height) : windows.changeSize(a, w, h)),
    'windows.changePosition': (s, [id, l, t]) => windows.changePosition(id, l, t),
    'windows.setPosition': (s, [o]) => {
      const r = windows.changeSize(o.windowId || o.window_id, o.width, o.height);
      return r.success ? windows.changePosition(o.windowId || o.window_id, o.left, o.top) : r;
    },
    'windows.setMinSize': (s, [id, w, h]) => windows.setMinSize(id, w, h),
    'windows.setTopmost': (s, [id, on]) => windows.setTopmost(id, on),
    'windows.setDesktopOnly': () => ({ success: true }),
    'windows.setWindowStyle': (s, [id, style]) => windows.setStyle(id, style, true),
    'windows.removeWindowStyle': (s, [id, style]) => windows.setStyle(id, style, false),
    'windows.isWindowVisibleToUser': (s) => ({ success: true, status: 'success', visible: windows.visibleToUser(s) }),
    'windows.sendMessage': (s, [id, messageId, content]) => {
      const n = windows.nameOf(id);
      if (!n) return { success: false, error: 'unknown window' };
      windows.sendTo(n, 'windows.onMessageReceived', { id: messageId, content });
      return { success: true, status: 'success' };
    },
    'windows.dragMove': (s, [id]) => windows.startDrag(idArg(s, id)),
    'windows.dragResize': (s, [id, edge]) => windows.startDrag(idArg(s, id), edge || 'BottomRight'),
    'windows.dragEnd': () => windows.endDrag(),

    'games.getRunningGameInfo': () => gameInfo(),
    'games.getRunningGameInfo2': () => ({ success: true, gameInfo: gameInfo() }),
    'games.getGameInfo': (s, [classId]) => {
      classId = Number(classId);
      const def = owGames.OW_GAMES[classId];
      if (!def) return { success: false, error: 'Unknown game' };
      const exe = game && game.classId === classId ? game.exePath : findInstall()?.classId === classId ? findInstall().exePath : null;
      if (!exe) return { success: false, error: 'Game not installed' };
      return {
        success: true,
        status: 'success',
        gameInfo: { GameInfoClassID: classId, ID: classId * 10, ClassID: classId, DisplayName: def.title, GameTitle: def.title, ProcessPath: exe, LauncherPath: exe, InstallPath: exe.replace(/\\[^\\]*$/, '') },
      };
    },

    'io.fileExists': (s, [p]) => io.fileExists(p),
    'io.exist': (s, [p]) => io.exist(p),
    'io.dir': (s, [p]) => io.dir(p),
    'io.readFileContents': (s, [p, enc]) => io.readFileContents(p, enc),
    'io.readTextFile': (s, [p, opts]) => io.readTextFile(p, opts || {}),
    'io.writeFileContents': (s, [p, content, enc]) => io.writeFileContents(p, content, enc),

    'settings.hotkeys.get': () => hotkeys.list(),
    'settings.hotkeys.assign': (s, [o]) => {
      const binding = o && (o.binding || bindingFromAssign(o));
      if (!binding) return { success: false, error: 'Key not supported' };
      const r = hotkeys.assign(o.name, binding);
      if (r.success) windows.broadcast('settings.hotkeys.onChanged', { name: o.name, gameId: o.gameId || 0, binding });
      return r;
    },
    'settings.hotkeys.unassign': (s, [o]) => {
      const r = hotkeys.assign(o && o.name, '');
      if (r.success) windows.broadcast('settings.hotkeys.onChanged', { name: o.name, gameId: o.gameId || 0, binding: '' });
      return r;
    },
    'settings.getExtensionSettings': () => ({ success: true, settings: { auto_launch_with_overwolf: false, exit_overwolf_on_exit: false, channel: '' } }),
    'settings.setExtensionSettings': () => ({ success: true }),

    'extensions.current.getManifest': () => ({ success: true, status: 'success', ...manifest, UID: uid }),
    'extensions.getRunningState': (s, [id]) => ({ success: true, isRunning: !id || id === uid }),
    'extensions.launch': () => ({ success: false, error: 'Launching other apps is not supported' }),
    'extensions.relaunch': () => {
      app.relaunch();
      quit();
      return { success: true };
    },

    // Overwolf accounts and subscriptions do not exist outside Overwolf:
    // nobody is signed in, there are no plans.
    'profile.getCurrentUser': () => ({ success: true, status: 'success', username: null, userId: null, uuid: null, displayName: null, avatar: null, channel: 'linuxwolf', machineId: uid.slice(0, 16), partnerId: 0 }),
    'profile.openLoginDialog': () => {
      log('[profile] the app asked for the Overwolf login; Overwolf accounts are not available on Linuxwolf');
      return { success: false, error: 'Overwolf login is not available on Linuxwolf' };
    },
    'profile.generateUserSessionToken': () => ({ success: false, error: 'Not signed in' }),
    'profile.subscriptions.getActivePlans': () => ({ success: true, plans: [] }),

    'utils.getMonitorsList': () => {
      const primary = screen.getPrimaryDisplay().id;
      return {
        success: true,
        status: 'success',
        displays: screen.getAllDisplays().map((d, i) => ({
          name: d.label || `\\\\.\\DISPLAY${i + 1}`,
          id: `\\\\.\\DISPLAY${i + 1}`,
          x: d.bounds.x,
          y: d.bounds.y,
          width: d.bounds.width,
          height: d.bounds.height,
          is_primary: d.id === primary,
          handle: { value: d.id },
          dpiX: Math.round(96 * d.scaleFactor),
          dpiY: Math.round(96 * d.scaleFactor),
        })),
      };
    },
    'utils.openUrlInDefaultBrowser': (s, [url]) => {
      if (!/^(https?|mailto):/i.test(String(url))) return { success: false, error: 'only http(s) and mailto links' };
      shell.openExternal(String(url));
      return { success: true };
    },
    'utils.placeOnClipboard': (s, [text]) => {
      clipboard.writeText(String(text ?? ''));
      return { success: true };
    },
    'utils.getFromClipboard': () => clipboard.readText(),
    'utils.getSystemInformation': () => ({
      success: true,
      systemInfo: { OS: `Linux ${os.release()}`, CPU: os.cpus()[0]?.model || '', MemorySize: `${Math.round(os.totalmem() / 2 ** 30)} GB`, Monitors: screen.getAllDisplays().length, IsLaptop: false, Linuxwolf: RUNTIME_VERSION },
    }),
    'utils.openWindowsExplorer': (s, [p]) => {
      const real = winPaths.toLinux(p);
      if (real) shell.openPath(real);
      return { success: Boolean(real) };
    },

    'os.tray.setMenu': (s, [m]) => setTrayMenu(m),
    'os.tray.destroy': () => {
      if (tray) tray.destroy();
      tray = null;
      return { success: true };
    },

    'media.createScreenshotBuffer': () => (permissions.has('Media') || permissions.has('DesktopStreaming') ? capture.create() : { success: false, error: 'missing Media permission' }),
    'media.capture': (s, [id]) => capture.capture(id),
    'media.closeScreenshotBuffer': (s, [id]) => capture.close(id),
  };
  // Calls that need a manifest permission, like in Overwolf.
  const NEEDS = { 'io.': 'FileSystem', 'games.getRunning': 'GameInfo', 'settings.hotkeys.': 'Hotkeys', 'os.tray.': 'Tray', 'profile.': 'Profile' };

  ipcMain.on('lw-opk:info', (e) => {
    const name = windows.nameOfWebContents(e.sender);
    e.returnValue = { uid, windowName: name, windowId: name ? windows.id(name) : null, ioPaths: winPaths.ioPaths(), overwolfVersion: OVERWOLF_VERSION, runtimeVersion: RUNTIME_VERSION };
  });
  ipcMain.handle('lw-opk:call', async (e, method, args) => {
    const sender = windows.nameOfWebContents(e.sender);
    if (!sender) return { success: false, error: 'unknown window' };
    const h = H[method];
    if (!h) return { success: false, status: 'error', error: `${method} is not supported on Linuxwolf` };
    for (const [pre, perm] of Object.entries(NEEDS)) {
      if (method.startsWith(pre) && !permissions.has(perm)) return { success: false, status: 'error', error: `missing permission ${perm}` };
    }
    try {
      const r = await h(sender, Array.isArray(args) ? args : []);
      if (process.env.LINUXWOLF_DEBUG === '1' && !method.startsWith('media.')) log(`[api] ${sender}: ${method}(${JSON.stringify(args).slice(1, -1).slice(0, 160)}) -> ${JSON.stringify(r)?.slice(0, 200)}`);
      return r;
    } catch (err) {
      log(`[api] ${method} failed: ${err.stack || err.message}`);
      return { success: false, status: 'error', error: err.message };
    }
  });

  app.on('second-instance', (_e, _argv, _cwd, extra) => {
    const source = (extra && extra.source) || 'dock';
    log(`[app] launched again (${source})`);
    windows.broadcast('extensions.onAppLaunchTriggered', { origin: source, parameter: '' });
  });
  app.on('window-all-closed', () => {}); // the background window keeps the app alive
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    kdeWindows.install(app, BrowserWindow);
    protocol.handle(SCHEME, async (req) => {
      const u = new URL(req.url);
      if (u.host !== uid) return new Response('not found', { status: 404 });
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/__linuxwolf/overwolf-api.js') return net.fetch(pathToFileURL(API_FILE).href);
      const file = path.resolve(appDir, `.${path.posix.normalize(rel)}`);
      if (file !== appDir && !file.startsWith(appDir + path.sep)) return new Response('forbidden', { status: 403 });
      let target = file;
      try {
        if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      } catch {
        return new Response('not found', { status: 404 });
      }
      if (/\.html?$/i.test(target)) {
        // The overwolf API goes in before any of the page's own scripts.
        let html = fs.readFileSync(target, 'utf8');
        const tag = '<script src="/__linuxwolf/overwolf-api.js"></script>';
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : tag + html;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return net.fetch(pathToFileURL(target).href);
    });

    log(`[app] Wine prefix for game paths: ${currentPrefix() || 'none yet (start the game once, or set LINUXWOLF_WINEPREFIX)'}`);
    pollGames();
    setInterval(pollGames, 2000);
    const startWindow = data.start_window || Object.keys(windows.decls)[0];
    if (!windows.nameOf(startWindow)) fail(`start window ${startWindow} not in manifest`);
    windows.restore(startWindow);
  });
}
