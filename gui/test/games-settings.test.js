'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const games = require('../src/core/games');
const settings = require('../src/core/settings');
const { tmpdir } = require('./helpers');
const rt = require('../../runtime/ow-electron/test/helpers');

test('installed games come with names from the app manifests, tools are left out', () => {
  const root = tmpdir();
  rt.fakeSteam(root, []);
  const apps = path.join(root, 'steamapps');
  const acf = (id, name, dir) => fs.writeFileSync(path.join(apps, `appmanifest_${id}.acf`), `"AppState"\n{\n\t"appid"\t"${id}"\n\t"name"\t"${name}"\n\t"installdir"\t"${dir}"\n}\n`);
  acf(2707930, 'Palia', 'Palia');
  acf(4126040, 'Aniimo', 'Aniimo');
  acf(1493710, 'Proton Experimental', 'Proton - Experimental');
  acf(1628350, 'Steam Linux Runtime 3.0 (sniper)', 'SteamLinuxRuntime_sniper');
  const old = process.env.LINUXWOLF_STEAM_ROOT;
  const oldHome = process.env.HOME;
  process.env.LINUXWOLF_STEAM_ROOT = root;
  process.env.HOME = tmpdir();
  try {
    const list = games.installed();
    assert.deepStrictEqual(list.map((g) => [g.appId, g.name]), [[4126040, 'Aniimo'], [2707930, 'Palia']]);
    assert.strictEqual(list[0].installDir, path.join(fs.realpathSync(apps), 'common', 'Aniimo'));
  } finally {
    process.env.LINUXWOLF_STEAM_ROOT = old;
    process.env.HOME = oldHome;
    if (old === undefined) delete process.env.LINUXWOLF_STEAM_ROOT;
  }
});

test('running games from /proc get known names', () => {
  const proc = tmpdir();
  rt.fakeProc(proc, 4242, ['Z:\\games\\Aniimo\\Aniimo.exe'], rt.PROTON_ENV);
  const [g] = games.running(proc);
  assert.strictEqual(g.appId, 4126040);
  assert.strictEqual(g.name, 'Aniimo');
  assert.strictEqual(g.pid, 4242);
});

test('GameWatcher reports started and stopped games once', () => {
  const w = new games.GameWatcher();
  const a = { appId: 4126040, pid: 1, exe: 'Aniimo.exe' };
  const b = { appId: null, pid: 2, exe: 'Setup.exe' };
  assert.deepStrictEqual(w.update([a]), { started: [a], stopped: [] });
  assert.deepStrictEqual(w.update([a, b]), { started: [b], stopped: [] });
  assert.deepStrictEqual(w.update([b]), { started: [], stopped: [a] });
});

test('settings: defaults, bad values dropped, saved atomically', () => {
  const file = path.join(tmpdir(), 'sub', 'gui.json');
  assert.deepStrictEqual(settings.load(file), settings.DEFAULTS);
  const saved = settings.save({ backend: 'wayland', osd: 'nope', debug: 'yes', autoStart: { metabot: true, x: 1 } }, file);
  assert.strictEqual(saved.backend, 'wayland');
  assert.strictEqual(saved.osd, 'clickthrough');
  assert.strictEqual(saved.debug, false);
  assert.deepStrictEqual(saved.autoStart, { metabot: true });
  assert.deepStrictEqual(settings.load(file), saved);
});
