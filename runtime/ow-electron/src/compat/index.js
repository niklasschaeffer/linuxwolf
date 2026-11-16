'use strict';
// Load-time compatibility patches for specific apps.
//
// Some app code is guarded with `process.platform !== "win32"` although the
// guarded feature works on Linux once Linuxwolf answers the Windows calls
// behind it (for example Steam's "Running" flag via reg.exe). Spoofing
// process.platform globally would break the app's path handling, so instead
// Linuxwolf rewrites those few guards in memory when the app's bundle is
// compiled. Nothing is written to disk.
//
// Each patch matches by pattern, not by minified names, so it survives most
// app updates. A patch that no longer matches is logged and skipped; the
// app then behaves as without Linuxwolf for that feature.

const Module = require('module');
const path = require('path');
const log = require('../log');

const APPS = [require('./metabot')];

function forApp(uid) {
  return APPS.find((a) => a.uid === uid) || null;
}

/** Apply a patch set to source text. Returns { source, report }. */
function applyPatches(source, patches) {
  const report = [];
  let out = source;
  for (const p of patches) {
    if (typeof p.apply === 'function') {
      // Custom patch: returns { source, count }.
      const r = p.apply(out);
      const ok = p.expect === 'one' ? r.count === 1 : r.count >= 1;
      if (ok) out = r.source;
      report.push({ id: p.id, count: r.count, ok });
      continue;
    }
    const re = new RegExp(p.find.source, p.find.flags.includes('g') ? p.find.flags : `${p.find.flags}g`);
    const count = [...out.matchAll(re)].length;
    const ok = p.expect === 'one' ? count === 1 : count >= 1;
    if (ok) out = out.replace(re, p.replace);
    report.push({ id: p.id, count, ok });
  }
  return { source: out, report };
}

function install(uid, appRoot) {
  const app = forApp(uid);
  if (!app) {
    log(`[compat] no compatibility patches for app ${uid}`);
    return null;
  }
  const targets = new Map(Object.entries(app.files).map(([rel, patches]) => [path.join(appRoot, rel), patches]));
  const origCompile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    const patches = targets.get(filename);
    if (patches) {
      const { source, report } = applyPatches(content, patches);
      for (const r of report) {
        log(`[compat] ${app.name}: ${r.id} ${r.ok ? 'applied' : 'DID NOT MATCH'} (${r.count}x)`);
      }
      content = source;
    }
    return origCompile.call(this, content, filename);
  };
  return app;
}

module.exports = { install, applyPatches, forApp };
