'use strict';
// Linuxwolf desktop app: library of Overwolf apps that run on Linux, Steam
// games under Proton, auto-start of apps with their games, overlay layer
// and system checks. Wraps the scripts in tools/ and the ow-electron
// runtime; it adds no second implementation of them.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage, clipboard } = require('electron');
const paths = require('./core/paths');
const catalog = require('./core/catalog');
const games = require('./core/games');
const settingsStore = require('./core/settings');
const system = require('./core/system');
const { Processes, findAppPid } = require('./core/processes');

app.setName('Linuxwolf');
// KDE uses the desktop file name to group windows and pick the icon.
if (typeof app.setDesktopName === 'function') app.setDesktopName('linuxwolf.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const ICON = path.join(__dirname, 'ui', 'icon.png');
  const procs = new Processes();
  const watcher = new games.GameWatcher();
  let settings = settingsStore.load();
  let win = null;
  let tray = null;
  let quitting = false;
  let runningGames = [];
  let installedGames = [];
  let installedWineGames = [];
  let installedGamesAt = 0;
  let apps = [];

  const appKey = (id) => `app:${id}`;

  function refreshApps() {
    apps = catalog.listApps();
    // Pick up apps that run already (started before the GUI, or from a terminal).
    for (const a of apps) {
      if (!procs.isRunning(appKey(a.id))) {
        const pid = findAppPid(a);
        if (pid) procs.adopt(appKey(a.id), pid, { label: a.name, meta: { appId: a.id } });
      }
    }
    return apps;
  }

  function refreshInstalledGames(force = false) {
    if (force || Date.now() - installedGamesAt > 15000) {
      installedGames = games.installed();
      installedWineGames = games.installedWine();
      installedGamesAt = Date.now();
    }
    return installedGames;
  }

  function state() {
    refreshInstalledGames();
    const running = new Map(runningGames.filter((g) => g.appId).map((g) => [g.appId, g]));
    return {
      apps: apps.map((a) => ({
        ...a,
        running: procs.isRunning(appKey(a.id)),
        pid: procs.get(appKey(a.id))?.pid ?? null,
        autoStart: Boolean(settings.autoStart[a.id]),
        gameNames: a.games.map((id) => installedGames.find((g) => g.appId === id)?.name || games.KNOWN_GAMES[id]?.name || `Steam ${id}`),
        gamesInstalled: a.games.filter((id) => installedGames.some((g) => g.appId === id) || installedWineGames.includes(id)),
        task: procs.get(`install:${a.id}`)?.running ? 'installing' : procs.get(`check:${a.id}`)?.running ? 'checking' : null,
      })),
      games: {
        installed: installedGames.map((g) => ({
          ...g,
          known: Boolean(games.KNOWN_GAMES[g.appId]),
          running: running.has(g.appId),
          pid: running.get(g.appId)?.pid ?? null,
          apps: apps.filter((a) => a.games.includes(g.appId)).map((a) => a.id),
        })),
        running: runningGames,
      },
      processes: procs.snapshot(),
      settings,
      system: system.info(),
    };
  }

  let pushTimer = null;
  function pushState() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('lw:changed'), 100);
  }

  function notify(title, body) {
    try {
      if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
    } catch {}
  }

  function findApp(id) {
    const a = apps.find((x) => x.id === id) || refreshApps().find((x) => x.id === id);
    if (!a) throw new Error(`unknown app ${id}`);
    return a;
  }

  function launch(id, meta = {}) {
    const a = findApp(id);
    if (procs.isRunning(appKey(id))) return;
    const cmd = catalog.launchCommand(a, settings);
    if (!cmd) throw new Error(`${a.name} is not installed`);
    procs.start(appKey(id), { ...cmd, label: a.name, kind: 'app', meta: { appId: id, ...meta } });
  }

  function runTask(key, label, cmd, onDone) {
    const [file, ...args] = cmd;
    procs.start(key, { file, args, label, kind: 'task' });
    if (onDone) {
      const h = ({ key: k, code }) => {
        if (k !== key) return;
        procs.off('exit', h);
        onDone(code);
      };
      procs.on('exit', h);
    }
  }

  function install(id) {
    const a = findApp(id);
    const cmd = catalog.installCommand(a);
    if (!cmd) throw new Error(`no installer for ${a.name}`);
    runTask(`install:${id}`, `Install ${a.name}`, cmd, (code) => {
      refreshApps();
      notify('Linuxwolf', code === 0 ? `${a.name} is installed.` : `Installing ${a.name} failed. See Activity.`);
      pushState();
    });
  }

  function addByUid(uid) {
    uid = String(uid || '').trim().toLowerCase();
    if (!/^[a-z]{40}$/.test(uid)) throw new Error('An Overwolf app id has 40 letters a-z.');
    runTask(`install:ow:${uid}`, `Install ${uid}`, [paths.tool('fetch-overwolf-app.sh'), uid], (code) => {
      refreshApps();
      notify('Linuxwolf', code === 0 ? 'App installed.' : 'Install failed. See Activity.');
      pushState();
    });
  }

  async function remove(id) {
    const a = findApp(id);
    if (!a.installed || !a.installDir) return false;
    if (procs.isRunning(appKey(id))) throw new Error(`Stop ${a.name} first.`);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      message: `Remove ${a.name}?`,
      detail: `Deletes ${a.installDir}. The app's own settings in ~/.config stay.`,
    });
    if (response !== 1) return false;
    // Only ever delete inside Linuxwolf's apps folder.
    const dir = path.resolve(a.installDir);
    if (!dir.startsWith(path.resolve(paths.appsDir()) + path.sep)) throw new Error('refusing to delete outside the apps folder');
    fs.rmSync(dir, { recursive: true, force: true });
    refreshApps();
    return true;
  }

  // Auto-start: start an app when one of its games starts, optionally stop
  // it when the game exits.
  function onGames(list) {
    runningGames = list;
    const { started, stopped } = watcher.update(list);
    for (const g of started) {
      for (const a of apps) {
        if (!g.appId || !a.games.includes(g.appId) || !settings.autoStart[a.id] || !a.installed) continue;
        if (procs.isRunning(appKey(a.id))) continue;
        try {
          launch(a.id, { autoFor: g.appId });
          notify('Linuxwolf', `${games.KNOWN_GAMES[g.appId]?.name || 'Game'} started, starting ${a.name}.`);
        } catch (e) {
          notify('Linuxwolf', `Could not start ${a.name}: ${e.message}`);
        }
      }
    }
    if (settings.stopWithGame) {
      for (const g of stopped) {
        for (const p of procs.snapshot()) if (p.running && p.meta?.autoFor === g.appId) procs.stop(p.key);
      }
    }
    if (started.length || stopped.length) {
      updateTray();
      pushState();
    }
  }

  function updateTray() {
    if (!tray) return;
    const runningApps = apps.filter((a) => procs.isRunning(appKey(a.id)));
    const gameNames = runningGames.map((g) => g.name || g.exe);
    tray.setToolTip(`Linuxwolf${gameNames.length ? ` · ${gameNames.join(', ')}` : ''}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Linuxwolf', click: showWindow },
        { type: 'separator' },
        ...apps.filter((a) => a.installed).map((a) => ({
          label: `${procs.isRunning(appKey(a.id)) ? 'Stop' : 'Start'} ${a.name}`,
          click: () => {
            try {
              procs.isRunning(appKey(a.id)) ? procs.stop(appKey(a.id)) : launch(a.id);
            } catch (e) {
              notify('Linuxwolf', e.message);
            }
          },
        })),
        { type: 'separator' },
        { label: runningApps.length ? 'Quit (apps keep running)' : 'Quit', click: () => { quitting = true; app.quit(); } },
      ]),
    );
  }

  function showWindow() {
    if (!win || win.isDestroyed()) createWindow();
    else {
      win.show();
      win.focus();
    }
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 760,
      minHeight: 520,
      title: 'Linuxwolf',
      icon: ICON,
      backgroundColor: '#14161b',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.removeMenu();
    win.loadFile(path.join(__dirname, 'ui', 'index.html'));
    // Links open in the browser, never inside the app window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('close', (e) => {
      if (!quitting && tray && settings.closeToTray) {
        e.preventDefault();
        win.hide();
      }
    });
  }

  const handlers = {
    'state:get': () => state(),
    'app:install': (id) => install(id),
    'app:add': (uid) => addByUid(uid),
    'app:launch': (id) => launch(id),
    'app:stop': (id) => procs.stop(appKey(id)),
    'app:remove': (id) => remove(id),
    'app:check': (id) => {
      const a = findApp(id);
      if (!a.check) throw new Error(`no setup check for ${a.name}`);
      runTask(`check:${id}`, `Setup check: ${a.name}`, [paths.tool(a.check)]);
    },
    'app:openFolder': (id) => {
      const a = findApp(id);
      return shell.openPath(a.installed ? path.dirname(a.path) : paths.appsDir());
    },
    'app:setAutoStart': (id, on) => {
      settings = settingsStore.save({ ...settings, autoStart: { ...settings.autoStart, [id]: Boolean(on) } });
    },
    'game:play': (appId) => {
      if (!/^\d+$/.test(String(appId))) throw new Error('bad Steam app id');
      return shell.openExternal(`steam://rungameid/${appId}`);
    },
    'games:rescan': () => {
      refreshInstalledGames(true);
      refreshApps();
    },
    'overlay:install': () => runTask('overlay:install', 'Install overlay layer', [paths.tool('install-overlay.sh')]),
    'overlay:uninstall': () => runTask('overlay:uninstall', 'Remove overlay layer', [paths.tool('install-overlay.sh'), '--uninstall']),
    'process:log': (key) => procs.lines(String(key)),
    'process:stop': (key) => procs.stop(String(key)),
    'process:openLog': (key) => {
      const p = procs.get(String(key));
      return p ? shell.openPath(p.logFile) : '';
    },
    'settings:set': (patch) => {
      settings = settingsStore.save({ ...settings, ...patch, autoStart: settings.autoStart });
      updateTray();
    },
    'clipboard:write': (text) => clipboard.writeText(String(text)),
    'open:url': (url) => {
      if (!/^https:\/\//.test(String(url))) throw new Error('only https links');
      return shell.openExternal(url);
    },
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(`lw:${ch}`, async (_e, ...args) => {
      try {
        const value = await fn(...args);
        pushState();
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }

  procs.on('change', () => {
    updateTray();
    pushState();
  });
  procs.on('output', (o) => win && !win.isDestroyed() && win.webContents.send('lw:output', o));
  procs.on('exit', ({ item }) => {
    if (item.kind === 'app' && item.exitCode !== 0 && item.exitCode !== 'SIGTERM' && item.exitCode !== 'gone') {
      notify('Linuxwolf', `${item.label} stopped (${item.exitCode}).`);
    }
  });

  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!tray || !settings.closeToTray) app.quit();
  });
  app.on('will-quit', () => procs.dispose());

  app.whenReady().then(() => {
    refreshApps();
    onGames(games.running());
    let tick = 0;
    setInterval(() => {
      onGames(games.running());
      // Every 15 s also pick up apps installed or started from a terminal.
      if (++tick % 5 === 0) {
        const before = JSON.stringify(apps.map((a) => [a.id, a.version, a.installed]));
        refreshApps();
        if (JSON.stringify(apps.map((a) => [a.id, a.version, a.installed])) !== before) pushState();
      }
    }, 3000);
    try {
      tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
      tray.on('click', showWindow);
      updateTray();
    } catch {
      tray = null;
    }
    if (!process.argv.includes('--hidden')) createWindow();
    else if (!tray) createWindow();
  });
}
