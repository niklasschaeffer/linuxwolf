'use strict';
// The only bridge between the UI page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(`lw:${ch}`, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('lw', {
  call,
  onChanged: (fn) => ipcRenderer.on('lw:changed', () => fn()),
  onOutput: (fn) => ipcRenderer.on('lw:output', (_e, o) => fn(o)),
});
