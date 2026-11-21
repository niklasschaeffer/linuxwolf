'use strict';
// Classic Overwolf app host: path mapping, io, hotkeys, game detection.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, fakeProc } = require('./helpers');
const { WinPaths } = require('../src/opk/winpath');
const { OpkIo } = require('../src/opk/io');
const { Hotkeys, toAccelerator, bindingFromAssign } = require('../src/opk/hotkeys');
const games = require('../src/opk/games');

const WOW = 'Program Files (x86)/World of Warcraft/_forever_';

function fakePrefix(root) {
  const pfx = path.join(root, 'pfx');
  fs.mkdirSync(path.join(pfx, 'drive_c', WOW, 'Interface', 'AddOns'), { recursive: true });
  fs.writeFileSync(path.join(pfx, 'drive_c', WOW, 'Wow.exe'), '');
  fs.mkdirSync(path.join(pfx, 'dosdevices'));
  fs.symlinkSync('../drive_c', path.join(pfx, 'dosdevices', 'c:'));
  return pfx;
}

test('Windows paths map into the game prefix, case-insensitively', () => {
  const root = tmpdir();
  const pfx = fakePrefix(root);
  const wp = new WinPaths({ appDrive: path.join(root, 'app'), prefix: () => pfx });
  const real = fs.realpathSync(path.join(pfx, 'drive_c'));
  assert.strictEqual(wp.toLinux('C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow.exe'), path.join(real, WOW, 'Wow.exe'));
  // Wrong case still finds the existing folders; missing parts are kept.
  assert.strictEqual(wp.toLinux('c:\\program files (x86)\\world of warcraft\\_FOREVER_\\interface\\addons\\New\\x.lua'), path.join(real, WOW, 'Interface/AddOns/New/x.lua'));
  assert.strictEqual(wp.toLinux('Z:\\etc\\hostname'), '/etc/hostname');
  assert.strictEqual(wp.toLinux('L:\\Users\\u\\AppData\\Local\\x.json'), path.join(root, 'app', 'Users/u/AppData/Local/x.json'));
  assert.strictEqual(wp.toLinux('C:\\..\\..\\..\\etc'), path.join(real, 'etc'));
  assert.strictEqual(wp.toLinux('Q:\\nothing'), null);
  assert.strictEqual(wp.toWindows(path.join(real, WOW, 'Wow.exe')), 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow.exe');
  assert.match(wp.ioPaths().localAppData, /^L:\\Users\\.+\\AppData\\Local$/);
  assert.strictEqual(wp.ioPaths().programFilesX86, 'C:\\Program Files (x86)');
});

test('without a prefix only the app drive and Z: work', () => {
  const root = tmpdir();
  const wp = new WinPaths({ appDrive: path.join(root, 'app') });
  assert.strictEqual(wp.toLinux('C:\\x'), null);
  assert.strictEqual(wp.ioPaths().programFiles, 'L:\\Program Files');
});

test('overwolf.io: write (with folders), read, dir, exists', () => {
  const root = tmpdir();
  const pfx = fakePrefix(root);
  const io = new OpkIo(new WinPaths({ appDrive: path.join(root, 'app'), prefix: () => pfx }));
  const addon = 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns\\wfm\\wfm.toc';
  assert.deepStrictEqual(io.fileExists(addon), { success: true, status: 'success', found: false });
  assert.strictEqual(io.writeFileContents(addon, '## Title: x\n', 'UTF8BOM').success, true);
  assert.strictEqual(io.fileExists(addon).found, true);
  assert.strictEqual(io.readFileContents(addon, 'UTF8').content, '## Title: x\n'); // BOM stripped
  const part = io.readTextFile(addon, { encoding: 'UTF8', maxBytesToRead: 5, offset: 3 });
  assert.strictEqual(part.content, '## Ti');
  assert.strictEqual(part.info.eof, false);
  assert.deepStrictEqual(io.dir('C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns').data, [{ name: 'wfm', type: 'dir' }]);
  assert.strictEqual(io.readFileContents('C:\\nope.txt').success, false);
  assert.strictEqual(io.dir('Q:\\x').success, false);
});

test('hotkeys: bindings, assign, game scope', () => {
  assert.strictEqual(toAccelerator('Ctrl+Shift+D'), 'Ctrl+Shift+D');
  assert.strictEqual(toAccelerator('ctrl+m'), 'Ctrl+M');
  assert.strictEqual(bindingFromAssign({ virtualKey: 77, modifiers: { ctrl: true } }), 'Ctrl+M');
  assert.strictEqual(bindingFromAssign({ virtualKey: 113, modifiers: { alt: true, shift: true } }), 'Alt+Shift+F2');
  const registered = new Map();
  const gs = { register: (a, fn) => (registered.set(a, fn), true), unregister: (a) => registered.delete(a) };
  const pressed = [];
  const hk = new Hotkeys({
    manifestHotkeys: { toggle: { title: 'Toggle', default: 'Ctrl+M' }, other: { title: 'Other', default: 'Ctrl+N' } },
    gameId: 28268,
    storeFile: path.join(tmpdir(), 'hk.json'),
    globalShortcut: gs,
    onPressed: (n) => pressed.push(n),
  });
  assert.deepStrictEqual(hk.list().games[28268].map((h) => [h.name, h.binding]), [['toggle', 'Ctrl+M'], ['other', 'Ctrl+N']]);
  hk.enable();
  registered.get('Ctrl+M')();
  assert.deepStrictEqual(pressed, ['toggle']);
  assert.strictEqual(hk.assign('other', 'Ctrl+M').success, false, 'taken by toggle');
  assert.strictEqual(hk.assign('toggle', 'Alt+F2').success, true);
  assert.ok(registered.has('Alt+F2') && !registered.has('Ctrl+M'));
  hk.disable();
  assert.strictEqual(registered.size, 0);
});

test('WoW Forever is found under Wine, Proton and on disk', () => {
  const root = tmpdir();
  const procRoot = path.join(root, 'proc');
  fakeProc(procRoot, 100, ['C:\\Program Files (x86)\\Battle.net\\Battle.net.exe'], { WINEPREFIX: '/p' });
  fakeProc(procRoot, 200, ['C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe'], { WINEPREFIX: '/p' });
  assert.deepStrictEqual(games.running([28268], procRoot), [], 'retail WoW is a different game');
  fakeProc(procRoot, 300, ['C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow.exe'], { WINEPREFIX: '/p' });
  const [g] = games.running([28268], procRoot);
  assert.strictEqual(g.pid, 300);
  assert.strictEqual(g.winePrefix, '/p');
  assert.strictEqual(g.exePath, 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow.exe');

  // Non-Steam game in Steam: launcher and game share the Steam id; the game still wins.
  const proc2 = path.join(root, 'proc2');
  const env = { SteamGameId: '12345678901', STEAM_COMPAT_DATA_PATH: '/c/1' };
  fakeProc(proc2, 10, ['C:\\Program Files (x86)\\Battle.net\\Battle.net.exe'], env);
  fakeProc(proc2, 11, ['Z:\\games\\wow\\_forever_\\Wow.exe'], env);
  assert.strictEqual(games.running([28268], proc2)[0].pid, 11);
  assert.strictEqual(games.running([28268], proc2)[0].winePrefix, '/c/1/pfx');

  const pfx = fakePrefix(root);
  assert.deepStrictEqual(games.findInstall(28268, [path.join(root, 'none'), pfx]), { prefix: pfx, exePath: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Wow.exe' });
});
