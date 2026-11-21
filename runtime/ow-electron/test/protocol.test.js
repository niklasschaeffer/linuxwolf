'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const protocol = require('../src/protocol');

const UID = 'iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf';

function setup(env = {}) {
  const data = tmpdir();
  const appDir = path.join(data, 'apps', UID, '4.0.5');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'resources', 'icon.png'), '');
  const calls = [];
  const app = {};
  const state = protocol.install(app, {
    uid: UID,
    appRoot: path.join(appDir, 'resources', 'app.asar'),
    launchPath: appDir,
    productName: 'MetaBot.GG Desktop',
    env: { XDG_DATA_HOME: data, LINUXWOLF_BACKEND: 'x11', HOME: '/nope', ...env },
    runner: '/opt/linuxwolf/bin/linuxwolf-run',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === 'query' ? `linuxwolf-app-${UID}.desktop` : '';
    },
  });
  return { app, state, calls, data, appDir };
}

test('setAsDefaultProtocolClient writes a link handler and makes it the default', async () => {
  const { app, state, calls, data, appDir } = setup();
  assert.equal(app.setAsDefaultProtocolClient('metabotgg', '/usr/bin/electron', ['/x']), true);
  await state.settled();
  assert.equal(state.file, path.join(data, 'applications', `linuxwolf-app-${UID}.desktop`));
  const text = fs.readFileSync(state.file, 'utf8');
  assert.match(text, /^MimeType=x-scheme-handler\/metabotgg;$/m);
  assert.match(text, new RegExp(`^Exec=env LINUXWOLF_BACKEND=x11 /opt/linuxwolf/bin/linuxwolf-run ${appDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} %u$`, 'm'));
  assert.match(text, /^NoDisplay=true$/m);
  assert.match(text, /^Icon=.*resources\/icon\.png$/m);
  assert.deepEqual(calls[0], ['xdg-mime', 'default', `linuxwolf-app-${UID}.desktop`, 'x-scheme-handler/metabotgg']);
  assert.equal(app.isDefaultProtocolClient('metabotgg'), true);
  assert.equal(app.isDefaultProtocolClient('other'), false);
});

test('several schemes share one desktop entry; removing the last deletes it', async () => {
  const { app, state } = setup();
  app.setAsDefaultProtocolClient('metabotgg');
  app.setAsDefaultProtocolClient('MetaBot-Dev');
  await state.settled();
  assert.match(fs.readFileSync(state.file, 'utf8'), /^MimeType=x-scheme-handler\/metabotgg;x-scheme-handler\/metabot-dev;$/m);
  assert.equal(app.removeAsDefaultProtocolClient('metabotgg'), true);
  assert.equal(app.removeAsDefaultProtocolClient('metabot-dev'), true);
  assert.equal(fs.existsSync(state.file), false);
});

test('invalid schemes are refused', () => {
  const { app, state } = setup();
  assert.equal(app.setAsDefaultProtocolClient('bad scheme'), false);
  assert.equal(app.setAsDefaultProtocolClient(''), false);
  assert.equal(fs.existsSync(state.file), false);
});

test('Exec arguments with spaces and special characters are quoted per the desktop entry spec', () => {
  assert.equal(protocol.quoteExecArg('/home/nick/apps/x'), '/home/nick/apps/x');
  assert.equal(protocol.quoteExecArg('/home/nick/My Apps/x'), '"/home/nick/My Apps/x"');
  assert.equal(protocol.quoteExecArg('a"b$c'), '"a\\\\"b\\\\$c"');
});
