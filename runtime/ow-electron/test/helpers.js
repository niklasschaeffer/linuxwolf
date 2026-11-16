'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lw-test-'));
}

/** Fake /proc/<pid> with cmdline and environ. */
function fakeProc(root, pid, cmdline, env) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmdline'), cmdline.map((s) => `${s}\0`).join(''));
  fs.writeFileSync(path.join(dir, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(''));
}

/** Fake Steam install with one library and the given app manifests. */
function fakeSteam(root, appIds) {
  const apps = path.join(root, 'steamapps');
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(
    path.join(apps, 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root}"\n\t}\n}\n`,
  );
  for (const id of appIds) fs.writeFileSync(path.join(apps, `appmanifest_${id}.acf`), `"AppState"\n{\n\t"appid"\t"${id}"\n}\n`);
  return root;
}

const PROTON_ENV = { SteamAppId: '4126040', STEAM_COMPAT_DATA_PATH: '/home/nick/.steam/steam/steamapps/compatdata/4126040' };

module.exports = { tmpdir, fakeProc, fakeSteam, PROTON_ENV };
