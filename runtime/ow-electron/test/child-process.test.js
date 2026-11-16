'use strict';
const test = require('node:test');
const assert = require('node:assert');
const util = require('util');
const cp = require('child_process');
const shim = require('../src/child-process-shim');

shim.install();
shim.register(['reg.exe', 'reg'], (args) =>
  args[0] === 'query' ? { code: 0, stdout: `ok ${args.slice(1).join(' ')}`, stderr: '' } : { code: 1, stdout: '', stderr: 'bad' });

test('execFile callback, encoding and errors', async () => {
  const out = await new Promise((res) => cp.execFile('reg.exe', ['query', 'HKCU\\X'], { encoding: 'latin1' }, (e, so) => res([e, so])));
  assert.equal(out[0], null);
  assert.equal(out[1], 'ok HKCU\\X');
  const buf = await new Promise((res) => cp.execFile('C:\\Windows\\System32\\reg.exe', ['query'], { encoding: 'buffer' }, (e, so) => res(so)));
  assert.ok(Buffer.isBuffer(buf));
  const err = await new Promise((res) => cp.execFile('reg', ['add'], (e) => res(e)));
  assert.equal(err.code, 1);
});

test('promisified execFile/exec resolve like Node does', async () => {
  const { stdout } = await util.promisify(cp.execFile)('reg.exe', ['query', 'A']);
  assert.equal(stdout, 'ok A');
  const r = await util.promisify(cp.exec)('reg query "HKCU\\Software\\Valve Steam" /v X');
  assert.equal(r.stdout, 'ok HKCU\\Software\\Valve Steam /v X');
  await assert.rejects(util.promisify(cp.execFile)('reg.exe', ['add']));
});

test('sync variants and passthrough for other commands', () => {
  assert.equal(cp.execFileSync('reg.exe', ['query', 'B'], { encoding: 'utf8' }), 'ok B');
  assert.equal(cp.spawnSync('reg', ['query', 'C'], { encoding: 'utf8' }).stdout, 'ok C');
  assert.equal(cp.execFileSync('echo', ['real'], { encoding: 'utf8' }).trim(), 'real');
});
