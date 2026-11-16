'use strict';
// Stand-in for `koffi`, the FFI module ow-electron apps use to call Win32
// DLLs. The real module ships win32-x64 binaries only. Functions Linuxwolf
// can answer are implemented here; everything else returns a neutral value
// (0/false/null) so callers fall back to their non-native paths.

const log = require('./log');

const IMPLEMENTED = {
  'user32.dll': {
    // Z-order is handled by Linuxwolf's window manager integration.
    SetWindowPos: () => true,
    // No global key state on Wayland; report "not pressed".
    GetAsyncKeyState: () => 0,
  },
};

function load(lib) {
  const name = String(lib).toLowerCase();
  const impl = IMPLEMENTED[name] || {};
  log(`[koffi] load(${lib}) -> shim`);
  return {
    func(...spec) {
      // Both koffi signatures: func(conv, name, ret, args) and func("int foo(int)").
      let fname = spec.length >= 3 ? spec[1] : String(spec[0]);
      const m = /([A-Za-z_]\w*)\s*\(/.exec(fname);
      if (spec.length < 3 && m) fname = m[1];
      if (impl[fname]) return impl[fname];
      return () => {
        log(`[koffi] ${lib}!${fname} called, not available on Linux`);
        return 0;
      };
    },
    unload() {},
  };
}

const type = (name) => ({ name });
module.exports = {
  __linuxwolf: true,
  load,
  struct: (name) => type(name),
  pack: (name) => type(name),
  union: (name) => type(name),
  opaque: (name) => type(name),
  array: (t, n) => ({ array: t, n }),
  pointer: (t) => ({ pointer: t }),
  out: (t) => t,
  inout: (t) => t,
  alias: (name) => type(name),
  proto: (name) => type(name),
  register: () => null,
  unregister: () => {},
  sizeof: () => 0,
  alloc: () => null,
  decode: () => null,
  encode: () => {},
  address: () => 0n,
  free: () => {},
};
