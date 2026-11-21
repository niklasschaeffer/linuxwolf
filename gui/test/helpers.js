'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lw-gui-test-'));
}

/** Installed ow-electron app with an unpacked resources/app folder. */
function fakeOwApp(appsDir, uid, version, pkg) {
  const dir = path.join(appsDir, uid, version, 'resources', 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return path.join(appsDir, uid, version);
}

/** Installed classic Overwolf app (unpacked .opk with manifest.json). */
function fakeOpkApp(appsDir, uid, version, name) {
  const dir = path.join(appsDir, uid, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 1, type: 'WebApp', meta: { name, version } }));
  return dir;
}

module.exports = { tmpdir, fakeOwApp, fakeOpkApp };
