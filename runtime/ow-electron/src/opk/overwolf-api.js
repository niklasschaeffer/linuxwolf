// Linuxwolf: the `overwolf` object for classic Overwolf (.opk) apps.
//
// Loaded as the first script of every app page (the protocol handler puts it
// in front of the page's own scripts). Runs in the page's world, so apps can
// add and remove listeners with their own function objects. Everything that
// needs the system goes through window.__linuxwolf (see preload.js) to the
// main process (api.js).
//
// Only the APIs that classic apps commonly use are here. Missing ones are
// left undefined on purpose: well-written apps check for them and switch the
// feature off.
(function () {
  'use strict';
  const bridge = window.__linuxwolf;
  if (!bridge || window.overwolf) return;
  const info = bridge.info;

  function call(method, args, cb) {
    const p = bridge.call(method, args || []).catch((e) => ({ success: false, status: 'error', error: String((e && e.message) || e) }));
    if (typeof cb === 'function') p.then((r) => { try { cb(r); } catch (e) { console.error(e); } });
    return p;
  }
  const lastFn = (args) => (typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null);
  const rest = (args) => (lastFn(args) ? Array.prototype.slice.call(args, 0, -1) : Array.prototype.slice.call(args));

  // overwolf event objects: { addListener, removeListener }.
  const events = {};
  function ev(name) {
    if (events[name]) return events[name].api;
    const set = new Set();
    events[name] = {
      set,
      api: {
        addListener(fn) { if (typeof fn === 'function') set.add(fn); },
        removeListener(fn) { set.delete(fn); },
        hasListener(fn) { return set.has(fn); },
      },
    };
    return events[name].api;
  }
  bridge.onEvent((name, payload) => {
    const e = events[name];
    if (!e) return;
    for (const fn of Array.from(e.set)) {
      try { fn(payload); } catch (err) { console.error(`[linuxwolf] listener for ${name} failed`, err); }
    }
  });

  // Simple wrappers: overwolf.x.y(a, b, cb) -> main "x.y" with [a, b].
  const simple = (method) => function () { return call(method, rest(arguments), lastFn(arguments)); };

  const windows = {
    getCurrentWindow: simple('windows.getCurrentWindow'),
    obtainDeclaredWindow: simple('windows.obtainDeclaredWindow'),
    getWindow: simple('windows.getWindow'),
    getWindowState: simple('windows.getWindowState'),
    getWindowsStates: simple('windows.getWindowsStates'),
    getOpenWindows: simple('windows.getOpenWindows'),
    restore: simple('windows.restore'),
    minimize: simple('windows.minimize'),
    maximize: simple('windows.maximize'),
    hide: simple('windows.hide'),
    close: simple('windows.close'),
    bringToFront: simple('windows.bringToFront'),
    sendToBack: simple('windows.sendToBack'),
    changeSize: simple('windows.changeSize'),
    changePosition: simple('windows.changePosition'),
    setPosition: simple('windows.setPosition'),
    setTopmost: simple('windows.setTopmost'),
    setDesktopOnly: simple('windows.setDesktopOnly'),
    setMinSize: simple('windows.setMinSize'),
    setWindowStyle: simple('windows.setWindowStyle'),
    removeWindowStyle: simple('windows.removeWindowStyle'),
    isWindowVisibleToUser: simple('windows.isWindowVisibleToUser'),
    sendMessage: simple('windows.sendMessage'),
    dragMove(id, cb) {
      call('windows.dragMove', [id], cb);
      // The main process moves the window with the pointer until the button
      // goes up.
      const up = () => { window.removeEventListener('mouseup', up, true); bridge.call('windows.dragEnd', []); };
      window.addEventListener('mouseup', up, true);
    },
    dragResize(id, edge, contentRect, cb) {
      if (typeof contentRect === 'function') { cb = contentRect; contentRect = null; }
      call('windows.dragResize', [id, edge], cb);
      const up = () => { window.removeEventListener('mouseup', up, true); bridge.call('windows.dragEnd', []); };
      window.addEventListener('mouseup', up, true);
    },
    getMainWindow() { return null; },
    onStateChanged: ev('windows.onStateChanged'),
    onMessageReceived: ev('windows.onMessageReceived'),
    onMainWindowRestored: ev('windows.onMainWindowRestored'),
    onScreenPropertyChanged: ev('windows.onScreenPropertyChanged'),
    enums: {
      WindowStyle: { InputPassThrough: 'InputPassThrough', BottomMost: 'BottomMost', Topmost: 'Topmost' },
      WindowStateEx: { closed: 'closed', minimized: 'minimized', hidden: 'hidden', normal: 'normal', maximized: 'maximized' },
      WindowDragEdge: { None: 'None', Left: 'Left', Right: 'Right', Top: 'Top', Bottom: 'Bottom', TopLeft: 'TopLeft', TopRight: 'TopRight', BottomLeft: 'BottomLeft', BottomRight: 'BottomRight' },
    },
  };

  const games = {
    getRunningGameInfo: simple('games.getRunningGameInfo'),
    getRunningGameInfo2: simple('games.getRunningGameInfo2'),
    getGameInfo: simple('games.getGameInfo'),
    onGameInfoUpdated: ev('games.onGameInfoUpdated'),
    onGameLaunched: ev('games.onGameLaunched'),
    onMajorFrameRateChange: ev('games.onMajorFrameRateChange'),
    // No `events` (game events provider): Overwolf's GEP is closed and does
    // not exist on Linux. Apps that check for it fall back on their own.
  };

  const io = {
    paths: info.ioPaths,
    fileExists: simple('io.fileExists'),
    dir: simple('io.dir'),
    readFileContents: simple('io.readFileContents'),
    readTextFile: simple('io.readTextFile'),
    writeFileContents: simple('io.writeFileContents'),
    exist: simple('io.exist'),
  };

  const settings = {
    hotkeys: {
      get: simple('settings.hotkeys.get'),
      assign: simple('settings.hotkeys.assign'),
      unassign: simple('settings.hotkeys.unassign'),
      onPressed: ev('settings.hotkeys.onPressed'),
      onChanged: ev('settings.hotkeys.onChanged'),
      onHold: ev('settings.hotkeys.onHold'),
    },
    getExtensionSettings: simple('settings.getExtensionSettings'),
    setExtensionSettings: simple('settings.setExtensionSettings'),
    language: {
      get(cb) { const language = (navigator.language || 'en').split('-')[0]; if (cb) cb({ success: true, language }); },
      onLanguageChanged: ev('settings.language.onLanguageChanged'),
    },
  };

  const extensions = {
    current: {
      id: info.uid,
      getManifest: simple('extensions.current.getManifest'),
      getExtraObject(name, cb) { if (cb) cb({ success: false, status: 'error', error: 'Native plugins are not supported on Linuxwolf' }); },
    },
    getRunningState: simple('extensions.getRunningState'),
    launch: simple('extensions.launch'),
    relaunch: simple('extensions.relaunch'),
    onAppLaunchTriggered: ev('extensions.onAppLaunchTriggered'),
    onExtensionUpdated: ev('extensions.onExtensionUpdated'),
    onUncaughtException: ev('extensions.onUncaughtException'),
  };

  const profile = {
    getCurrentUser: simple('profile.getCurrentUser'),
    openLoginDialog: simple('profile.openLoginDialog'),
    generateUserSessionToken: simple('profile.generateUserSessionToken'),
    onLoginStateChanged: ev('profile.onLoginStateChanged'),
    subscriptions: {
      getActivePlans: simple('profile.subscriptions.getActivePlans'),
      onSubscriptionChanged: ev('profile.subscriptions.onSubscriptionChanged'),
    },
  };

  const utils = {
    getMonitorsList: simple('utils.getMonitorsList'),
    openUrlInDefaultBrowser: simple('utils.openUrlInDefaultBrowser'),
    openUrlInOverwolfBrowser: simple('utils.openUrlInDefaultBrowser'),
    placeOnClipboard: simple('utils.placeOnClipboard'),
    getFromClipboard: simple('utils.getFromClipboard'),
    getSystemInformation: simple('utils.getSystemInformation'),
    openFilePicker: simple('utils.openFilePicker'),
    openWindowsExplorer: simple('utils.openWindowsExplorer'),
    sendKeyStroke() {},
  };

  const os = {
    tray: {
      setMenu: simple('os.tray.setMenu'),
      destroy: simple('os.tray.destroy'),
      onMenuItemClicked: ev('os.tray.onMenuItemClicked'),
      onTrayIconClicked: ev('os.tray.onTrayIconClicked'),
      onTrayIconDoubleClicked: ev('os.tray.onTrayIconDoubleClicked'),
    },
  };

  // Screenshots of the game, used by apps that read the screen (e.g. OCR of
  // an addon's on-screen output). Buffer objects mirror Overwolf's.
  const media = {
    createScreenshotBuffer(options, cb) {
      if (typeof options === 'function') { cb = options; options = {}; }
      call('media.createScreenshotBuffer', [options || {}]).then((r) => {
        if (!r || !r.success) { if (cb) cb(r); return; }
        const id = r.id;
        let closed = false;
        const screenshotBuffer = {
          capture(done) {
            if (closed) { done({ success: false, error: 'Screenshot buffer closed' }); return; }
            call('media.capture', [id]).then((c) => {
              if (c && c.success && c.buffer) {
                const u8 = c.buffer;
                c.buffer = u8.buffer.byteLength === u8.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
              }
              done(c);
            });
          },
          close() { closed = true; bridge.call('media.closeScreenshotBuffer', [id]); },
        };
        if (cb) cb({ success: true, screenshotBuffer });
      });
    },
    takeScreenshot(cb) { if (cb) cb({ success: false, error: 'Not supported on Linuxwolf' }); },
  };

  window.overwolf = {
    version: info.overwolfVersion,
    windows, games, io, settings, extensions, profile, utils, os, media,
    // Linuxwolf extension, for apps or debugging.
    linuxwolf: { version: info.runtimeVersion },
  };
})();
