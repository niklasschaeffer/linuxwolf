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

module.exports = { tmpdir, fakeOwApp };
