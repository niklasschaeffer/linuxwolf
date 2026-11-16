'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyPatches, forApp } = require('../src/compat');

// Synthetic minified code in the shape of the guarded functions.
const SAMPLE = [
  'function Rd(t={}){const e=t.query??Qx,s=t.platform??process.platform;let n=null;}',
  'function pA(){process.platform!=="win32"||k$||(T$(),k$=setInterval(()=>{T$()},z1))}',
  'function pB(){process.platform!=="win32"||c$||(f$(),c$=setInterval(()=>{f$()},z2),setTimeout(()=>{},1))}',
  'async function Iu(t){if(process.platform!=="win32")return false;const e=await Z4();return t.some(a=>e.has(a))}',
  'const Q=1,_e={deadlock:"1422450",aniimo:"4126040"};',
  'async function hx(t=false){const e=1;if(process.platform!=="win32")return Jd={league:false,aniimo:false},Jd;return 0}',
  'function koffiPath(){if(process.platform!=="win32")return false;require("koffi")}',
].join('');

test('MetaBot patches open only the Steam guards', () => {
  const app = forApp('iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf');
  const { source, report } = applyPatches(SAMPLE, app.files['out/main/index.js']);
  for (const r of report) assert.ok(r.ok, `${r.id} did not match`);
  assert.equal(report.find((r) => r.id === 'steam-presence-polls').count, 2);
  assert.match(source, /s=t\.platform\?\?"win32"/);
  assert.match(source, /false\|\|k\$\|\|\(T\$\(\),k\$=setInterval/);
  assert.match(source, /globalThis\.__linuxwolf\.steam\.anyInstalled\(t\)/);
  assert.match(source, /installedMap\(\{league:false,aniimo:false\},_e\)/);
  // Windows-only native code stays guarded.
  assert.match(source, /function koffiPath\(\)\{if\(process\.platform!=="win32"\)return false;/);
});

test('a patch that does not match is reported and leaves the code alone', () => {
  const { source, report } = applyPatches('const x=1;', forApp('iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf').files['out/main/index.js']);
  assert.equal(source, 'const x=1;');
  assert.ok(report.every((r) => !r.ok && r.count === 0));
});
