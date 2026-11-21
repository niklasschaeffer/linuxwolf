'use strict';
// Linuxwolf ow-electron runtime: Electron main entry.
//
//   electron src/main.js --lw-app=<app> [app args...]
//
// <app> is an installed ow-electron app: the app folder (with
// resources/app.asar), the resources folder, or app.asar itself.
// Use bin/linuxwolf-run instead of calling this directly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { app, BrowserWindow } = require('electron');
const log = require('./log');

function fail(msg) {
  log(`error: ${msg}`);
  process.exit(2);
}

function resolveApp(arg) {
  if (!arg) fail('missing --lw-app=<path to app folder or app.asar>');
  const p = path.resolve(arg);
  const candidates = [p, path.join(p, 'app.asar'), path.join(p, 'resources/app.asar'), path.join(p, 'resources/app')];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return c;
    } catch {}
  }
  fail(`no ow-electron app found at ${p}`);
}

const lwArgs = process.argv.filter((a) => a.startsWith('--lw-'));
const lwOpt = (name) => {
  const a = lwArgs.find((x) => x === `--lw-${name}` || x.startsWith(`--lw-${name}=`));
  return a === undefined ? undefined : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};

const appRoot = resolveApp(lwOpt('app'));
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const uid = pkg.overwolf && pkg.overwolf.uid;
const productName = pkg.productName || pkg.name;
const devMode = process.env.LINUXWOLF_APP_DEV === '1';

log(`runtime ${require('../package.json').version}, Electron ${process.versions.electron}, app ${productName} ${pkg.version} (${uid || 'no overwolf uid'})`);

// 1. Make Electron look like it was started as this packaged app.
app.setName(productName);
app.setVersion(pkg.version);
app.setPath('userData', path.join(app.getPath('appData'), productName));
if (typeof app.setAppPath === 'function') app.setAppPath(appRoot);
Object.defineProperty(process, 'resourcesPath', { value: path.dirname(appRoot), configurable: true, writable: true });
if (!devMode) Object.defineProperty(app, 'isPackaged', { get: () => true, configurable: true });
const self = path.resolve(__filename);
process.argv = [process.execPath, ...process.argv.slice(1).filter((a) => !a.startsWith('--lw-') && path.resolve(a) !== self && path.resolve(a) !== path.dirname(path.dirname(self)))];

// Apps that write log files to the current directory get their own folder.
const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'linuxwolf', 'apps', productName);
fs.mkdirSync(stateDir, { recursive: true });
process.chdir(stateDir);

// 2. Windows tools and native modules.
const steam = require('./steam');
const { Registry, regExe } = require('./registry');
const childProcess = require('./child-process-shim');
const registry = new Registry({ storeFile: path.join(app.getPath('userData'), 'linuxwolf-registry.json') });
childProcess.install();
childProcess.register(['reg', 'reg.exe'], (args) => regExe(registry, args));

const replacements = {
  koffi: () => require('./koffi-shim'),
  'electron-updater': () => require('./updater-shim'),
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const make = replacements[request];
  if (make && parent && parent.filename && parent.filename.startsWith(appRoot)) return make();
  return origLoad.call(this, request, parent, isMain);
};

globalThis.__linuxwolf = { version: require('../package.json').version, steam, registry, inertWindow: require('./windows').inertWindow };

// 3. App-specific compatibility patches, app.overwolf, window handling.
require('./compat').install(uid, appRoot);
require('./overwolf').install(app, { uid });
require('./windows').install(app, BrowserWindow);
require('./protocol').install(app, { uid, appRoot, launchPath: path.resolve(lwOpt('app')), productName });

// Node's fetch() ignores HTTP(S)_PROXY. Desktop users behind a proxy expect
// the app to use it, so route undici (fetch's engine) through the env proxy.
if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
  try {
    const undici = Module.createRequire(path.join(appRoot, 'package.json'))('undici');
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    log('main-process fetch() uses the proxy from the environment');
  } catch (e) {
    log(`proxy from environment not applied: ${e.message}`);
  }
}

// 4. Start the app.
const entry = path.join(appRoot, pkg.main || 'index.js');
log(`starting ${entry}`);
require(entry);
