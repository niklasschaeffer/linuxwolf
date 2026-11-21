'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { Processes, findAppPid } = require('../src/core/processes');
const { tmpdir } = require('./helpers');
const rt = require('../../runtime/ow-electron/test/helpers');

test('task output is streamed line by line and logged, curl-style \\r keeps the last state', async () => {
  const p = new Processes({ logDir: tmpdir() });
  const seen = [];
  p.on('output', (o) => seen.push(o.line));
  p.start('t', { file: 'bash', args: ['-c', 'echo one; printf "10%%\\r50%%\\r100%%\\n"; echo err >&2; exit 3'] });
  const [{ code }] = await once(p, 'exit');
  assert.strictEqual(code, 3);
  assert.ok(seen.includes('one') && seen.includes('100%') && seen.includes('err'));
  assert.ok(!seen.includes('10%'));
  assert.match(fs.readFileSync(p.get('t').logFile, 'utf8'), /one\n100%\n/);
  assert.strictEqual(p.isRunning('t'), false);
  assert.throws(() => {
    p.start('t2', { file: 'sleep', args: ['5'] });
    p.start('t2', { file: 'sleep', args: ['5'] });
  }, /already running/);
  p.stop('t2', 100);
  await once(p, 'exit');
});

test('apps write to their log file, which is followed; stop ends the process group', async () => {
  const p = new Processes({ logDir: tmpdir(), pollMs: 20 });
  const seen = [];
  p.on('output', (o) => seen.push(o.line));
  // The script starts a child of its own; stop() must end both.
  p.start('app:x', { file: 'bash', args: ['-c', 'echo hello; sleep 30 & echo "child $!"; wait'], kind: 'app' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.includes('hello'), seen.join('|'));
  const child = Number(seen.find((l) => l.startsWith('child ')).split(' ')[1]);
  assert.strictEqual(p.stop('app:x', 200), true);
  await once(p, 'exit');
  await new Promise((r) => setTimeout(r, 100));
  // Gone, or a zombie waiting for a reaper (containers without an init).
  let state = 'gone';
  try {
    state = fs.readFileSync(`/proc/${child}/stat`, 'utf8').split(') ')[1][0];
  } catch {}
  assert.ok(state === 'gone' || state === 'Z', `child state ${state}`);
  p.dispose();
});

test('adopt tracks an outside process until it is gone', async () => {
  const p = new Processes({ logDir: tmpdir() });
  const c = spawn('sleep', ['30']);
  p.adopt('app:y', c.pid, { label: 'Y' });
  assert.strictEqual(p.isRunning('app:y'), true);
  c.kill();
  const [{ code }] = await once(p, 'exit');
  assert.strictEqual(code, 'gone');
});

test('findAppPid finds the Electron main process of an ow-electron app and an AppImage', () => {
  const proc = tmpdir();
  const app = { installed: true, kind: 'ow-electron', path: '/home/n/.local/share/linuxwolf/apps/u/4.0.4' };
  rt.fakeProc(proc, 300, ['/x/electron', '--type=renderer', `--lw-app=${app.path}`], {});
  rt.fakeProc(proc, 200, ['/x/electron', '--ozone-platform=x11', '/r/src/main.js', `--lw-app=${app.path}`], {});
  rt.fakeProc(proc, 100, ['/x/electron', '--lw-app=/other'], {});
  rt.fakeProc(proc, 101, ['/x/electron', `--lw-app=${app.path}-old`], {});
  assert.strictEqual(findAppPid(app, proc), 200);
  // Chromium's rewritten process title: one string, switches moved forward.
  rt.fakeProc(proc, 150, [`/x/electron --ozone-platform=x11 --lw-app=${app.path} /r/src/main.js`], {});
  assert.strictEqual(findAppPid(app, proc), 150);
  const img = { installed: true, kind: 'appimage', path: '/a/THGL_Companion-x86_64.AppImage' };
  assert.strictEqual(findAppPid(img, proc), null);
  rt.fakeProc(proc, 400, ['/tmp/.mount_THGLab/usr/bin/thgl-companion'], { APPIMAGE: img.path });
  assert.strictEqual(findAppPid(img, proc), 400);
  assert.strictEqual(findAppPid({ ...img, installed: false }, proc), null);
});
