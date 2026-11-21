'use strict';
// Preload for classic Overwolf app windows: a small, sandbox-safe bridge to
// the main process. The `overwolf` object itself lives in the page
// (overwolf-api.js), so listener identity works like in Overwolf.

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('lw-opk:info');
let handler = null;
ipcRenderer.on('lw-opk:event', (_e, name, payload) => {
  if (handler) handler(name, payload);
});

contextBridge.exposeInMainWorld('__linuxwolf', {
  info,
  call: (method, args) => ipcRenderer.invoke('lw-opk:call', method, args),
  onEvent: (fn) => {
    handler = fn;
  },
});
