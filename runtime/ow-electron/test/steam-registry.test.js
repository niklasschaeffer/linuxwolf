'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmpdir, fakeProc, fakeSteam, PROTON_ENV } = require('./helpers');

function setup({ running = true } = {}) {
  const root = tmpdir();
  const steamRoot = fakeSteam(path.join(root, 'steam'), ['4126040', '730']);
  const procRoot = path.join(root, 'proc');
  fakeProc(procRoot, 100, ['C:\\windows\\system32\\steam.exe'], PROTON_ENV);
  if (running) fakeProc(procRoot, 105, ['Z:\\games\\Aniimo\\Aniimo.exe', '-dx12'], PROTON_ENV);
  fakeProc(procRoot, 200, ['/usr/bin/bash'], PROTON_ENV);
  process.env.LINUXWOLF_STEAM_ROOT = steamRoot;
  process.env.LINUXWOLF_STEAM_REGISTRY = path.join(root, 'none.vdf');
  process.env.HOME = root;
  return { root, procRoot };
}

test('proc scan finds the Proton game and skips helpers', () => {
  const { procRoot } = setup();
  const games = require('../src/proc').scan(procRoot);
  assert.equal(games.length, 1);
  assert.equal(games[0].steamAppId, 4126040);
  assert.equal(games[0].exe, 'Aniimo.exe');
  assert.equal(games[0].pid, 105);
});

test('steam: installed apps and installed map', () => {
  setup();
  const steam = require('../src/steam');
  assert.deepEqual([...steam.installedAppIds()].sort(), ['4126040', '730']);
  assert.equal(steam.anyInstalled(['4126040']), true);
  assert.equal(steam.anyInstalled(['1']), false);
  const map = steam.installedMap(
    { league: false, cs2: false, aniimo: false, permafrost: false },
    { cs2: '730', aniimo: '4126040', permafrost: '1', permafrostPreview: '2' },
  );
  assert.deepEqual(map, { league: false, cs2: true, aniimo: true, permafrost: false });
});

// The parser MetaBot (and other apps) apply to `reg query ... /s /v Running`.
function parseRunning(out) {
  const flags = new Map();
  let app = null;
  for (const line of out.split(/\r?\n/)) {
    const s = line.replace(/\s+$/, '');
    if (!s) continue;
    if (/^HKEY_/i.test(s)) {
      const m = /\\Steam\\Apps\\(\d+)$/i.exec(s);
      app = m ? m[1] : null;
      continue;
    }
    const m = app && /^\s+Running\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)$/i.exec(s);
    if (m) flags.set(app, parseInt(m[1], 16) !== 0);
  }
  return flags;
}

test('reg.exe query reports the Running flag in Windows format', () => {
  const { procRoot } = setup();
  const { Registry, regExe } = require('../src/registry');
  const reg = new Registry({ procRoot });
  const r = regExe(reg, ['query', 'HKCU\\Software\\Valve\\Steam\\Apps', '/s', '/v', 'Running']);
  assert.equal(r.code, 0);
  const flags = parseRunning(r.stdout);
  assert.equal(flags.get('4126040'), true);
  assert.equal(flags.get('730'), false);
  assert.match(r.stdout, /End of search: 2 match\(es\) found\./);
});

test('reg.exe query when nothing runs, single value, and missing keys', () => {
  const { procRoot } = setup({ running: false });
  const { Registry, regExe } = require('../src/registry');
  const reg = new Registry({ procRoot });
  const flags = parseRunning(regExe(reg, ['query', 'HKCU\\Software\\Valve\\Steam\\Apps', '/s', '/v', 'Running']).stdout);
  assert.equal(flags.get('4126040'), false);
  const one = regExe(reg, ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  assert.equal(one.code, 0);
  assert.match(one.stdout, /^\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    \/.+steam\r\n/);
  const missing = regExe(reg, ['query', 'HKCU\\Software\\Nope', '/v', 'X']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /unable to find/);
});

test('reg.exe add persists values', () => {
  const { root, procRoot } = setup();
  const { Registry, regExe } = require('../src/registry');
  const store = path.join(root, 'reg.json');
  const reg = new Registry({ storeFile: store, procRoot });
  assert.equal(regExe(reg, ['add', 'HKCU\\Software\\MetaBot.GG', '/v', 'Language', '/t', 'REG_SZ', '/d', 'de', '/f']).code, 0);
  const again = new Registry({ storeFile: store, procRoot });
  const r = regExe(again, ['query', 'HKCU\\Software\\MetaBot.GG', '/v', 'Language']);
  assert.match(r.stdout, /Language    REG_SZ    de/);
});
