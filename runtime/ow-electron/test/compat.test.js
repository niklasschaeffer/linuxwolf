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
  'function zBe(){const t=new y.BrowserWindow({name:"metabot-overlay-window",width:800});return eg("overlay-fallback",t),t}',
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

test('MetaBot fallback overlay window is created hidden and made inert', () => {
  const code =
    'function zBe(){const t=new y.BrowserWindow({name:"metabot-overlay-window",width:800,height:600,frame:false,transparent:true});return eg("overlay-fallback",t),t.loadFile("x"),t}';
  const patches = forApp('iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf').files['out/main/index.js'].filter((p) => p.id.startsWith('overlay-fallback'));
  const { source, report } = applyPatches(code, patches);
  for (const r of report) assert.ok(r.ok, `${r.id} did not match`);
  assert.match(source, /name:"metabot-overlay-window",show:false,/);

  const calls = [];
  const win = { shown: false, show() { this.shown = true; } };
  globalThis.__linuxwolf = { inertWindow: (w, label) => { calls.push(label); w.show = () => {}; } };
  const y = { BrowserWindow: function (opts) { Object.assign(this, win, { opts, loadFile() {} }); } };
  const eg = () => {};
  const zBe = new Function('y', 'eg', `${source};return zBe`)(y, eg);
  try {
    const t = zBe();
    assert.equal(t.opts.show, false);
    t.show();
    assert.equal(t.shown, false);
    assert.deepEqual(calls, ['metabot-overlay-window']);
  } finally {
    delete globalThis.__linuxwolf;
  }
});

test('a patch that does not match is reported and leaves the code alone', () => {
  const { source, report } = applyPatches('const x=1;', forApp('iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf').files['out/main/index.js']);
  assert.equal(source, 'const x=1;');
  assert.ok(report.every((r) => !r.ok && r.count === 0));
});
