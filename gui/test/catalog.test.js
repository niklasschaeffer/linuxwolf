'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const catalog = require('../src/core/catalog');
const paths = require('../src/core/paths');
const { tmpdir, fakeOwApp, fakeOpkApp } = require('./helpers');

test('compareVersions sorts numerically', () => {
  assert.deepStrictEqual(['4.0.10', '4.0.4', '4.1.0', '3.9'].sort(catalog.compareVersions), ['3.9', '4.0.4', '4.0.10', '4.1.0']);
});

test('nothing installed: known apps listed as not installed', () => {
  const apps = catalog.listApps(tmpdir());
  assert.deepStrictEqual(apps.map((a) => [a.id, a.installed]), [['metabot', false], ['thgl-companion', false], ['wow-forever-map', false]]);
});

test('newest installed MetaBot version wins, unknown ow-electron apps are listed too', () => {
  const dir = tmpdir();
  fakeOwApp(dir, catalog.METABOT_UID, '4.0.4', { productName: 'MetaBot.GG Desktop' });
  const newest = fakeOwApp(dir, catalog.METABOT_UID, '4.0.10', { productName: 'MetaBot.GG Desktop' });
  fs.mkdirSync(path.join(dir, catalog.METABOT_UID, 'partial'));
  const other = 'a'.repeat(40);
  fakeOwApp(dir, other, '1.2.3', { productName: 'Other App' });
  const apps = catalog.listApps(dir);
  const mb = apps.find((a) => a.id === 'metabot');
  assert.strictEqual(mb.installed, true);
  assert.strictEqual(mb.version, '4.0.10');
  assert.strictEqual(mb.path, newest);
  const o = apps.find((a) => a.id === `ow:${other}`);
  assert.strictEqual(o.name, 'Other App');
  assert.strictEqual(o.custom, true);
});

test('TH.GL AppImage counts as installed only when executable', () => {
  const dir = tmpdir();
  const file = catalog.thglAppImage(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.strictEqual(catalog.listApps(dir).find((a) => a.id === 'thgl-companion').installed, false);
  fs.chmodSync(file, 0o755);
  assert.strictEqual(catalog.listApps(dir).find((a) => a.id === 'thgl-companion').installed, true);
});

test('install and launch commands use the repo scripts and settings', () => {
  const dir = tmpdir();
  const appDir = fakeOwApp(dir, catalog.METABOT_UID, '4.0.4', {});
  const mb = catalog.listApps(dir).find((a) => a.id === 'metabot');
  assert.deepStrictEqual(catalog.installCommand(mb), [paths.tool('fetch-ow-electron-app.sh'), catalog.METABOT_UID]);
  const cmd = catalog.launchCommand(mb, { backend: 'wayland', osd: 'all', debug: true });
  assert.strictEqual(cmd.file, paths.runner());
  assert.deepStrictEqual(cmd.args, [appDir]);
  assert.deepStrictEqual(cmd.env, { LINUXWOLF_BACKEND: 'wayland', LINUXWOLF_OSD: 'all', LINUXWOLF_DEBUG: '1' });
  assert.deepStrictEqual(catalog.launchCommand(mb, {}).env, { LINUXWOLF_BACKEND: 'x11' });
  for (const f of [paths.tool('fetch-ow-electron-app.sh'), paths.tool('fetch-thgl-companion.sh'), paths.tool('thgl-palia-check.sh'), paths.runner()]) {
    assert.ok(fs.existsSync(f), `${f} exists`);
  }
});

test('classic Overwolf apps: WoW Forever Map and other .opk apps', () => {
  const dir = tmpdir();
  fakeOpkApp(dir, catalog.WOW_FOREVER_MAP_UID, '5.0.0', 'WoW Forever Map');
  const newest = fakeOpkApp(dir, catalog.WOW_FOREVER_MAP_UID, '5.0.1', 'WoW Forever Map');
  const other = 'b'.repeat(40);
  fakeOpkApp(dir, other, '1.0.0', 'Some Classic App');
  const apps = catalog.listApps(dir);
  const wfm = apps.find((a) => a.id === 'wow-forever-map');
  assert.strictEqual(wfm.kind, 'opk');
  assert.strictEqual(wfm.installed, true);
  assert.strictEqual(wfm.path, newest);
  assert.deepStrictEqual(wfm.games, ['wow-forever']);
  const o = apps.find((a) => a.id === `ow:${other}`);
  assert.strictEqual(o.kind, 'opk');
  assert.strictEqual(o.name, 'Some Classic App');
  assert.deepStrictEqual(catalog.installCommand(wfm), [paths.tool('fetch-opk-app.sh'), catalog.WOW_FOREVER_MAP_UID]);
  const cmd = catalog.launchCommand(wfm, {});
  assert.strictEqual(cmd.file, paths.runner());
  assert.deepStrictEqual(cmd.args, [newest]);
  for (const f of [paths.tool('fetch-opk-app.sh'), paths.tool('fetch-overwolf-app.sh')]) assert.ok(fs.existsSync(f), `${f} exists`);
});
