'use strict';
// MetaBot.GG Desktop (ow-electron app). Checked against 4.0.4.
//
// For Aniimo and other Steam games MetaBot asks the Windows registry whether
// the game is running (HKCU\Software\Valve\Steam\Apps\<id>\Running) and
// whether it is installed (Steam library manifests). Both are only enabled
// on win32. Linuxwolf answers reg.exe (src/registry.js), so these patches
// only open the platform guards. Windows-only code paths (koffi/user32,
// elevation, WMI) stay off.

module.exports = {
  uid: 'iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf',
  name: 'MetaBot',
  files: {
    'out/main/index.js': [
      {
        // The shared Steam "Running" flag reader returns null unless win32.
        id: 'steam-running-flag',
        find: /(\b\w+)\.platform\?\?process\.platform/g,
        replace: '$1.platform??"win32"',
        expect: 'one',
      },
      {
        // Per-game presence polls: process.platform!=="win32"||timer||(poll(),timer=setInterval(...
        id: 'steam-presence-polls',
        find: /process\.platform!=="win32"\|\|([\w$]+)\|\|\(([\w$]+)\(\),\1=setInterval\(/g,
        replace: 'false||$1||($2(),$1=setInterval(',
        expect: 'some',
      },
      {
        // "Is this Steam game installed?" walks Windows Steam paths; ask
        // Linuxwolf's Steam library scan instead.
        id: 'steam-installed',
        find: /async function ([\w$]+)\(([\w$]+)\)\{if\(process\.platform!=="win32"\)return false;const ([\w$]+)=await ([\w$]+)\(\);return \2\.some\(/g,
        replace: 'async function $1($2){if(globalThis.__linuxwolf)return globalThis.__linuxwolf.steam.anyInstalled($2);const $3=await $4();return $2.some(',
        expect: 'one',
      },
      {
        // The "installed games" map (drives which games show up in the app
        // and which get auto-unhidden) is all false off Windows. Fill the
        // Steam games from Linux Steam libraries.
        id: 'installed-games-map',
        apply(source) {
          const table = /(?:const |,)([\w$]+)=\{deadlock:"\d+"/.exec(source);
          if (!table) return { source, count: 0 };
          let count = 0;
          const out = source.replace(
            /if\(process\.platform!=="win32"\)return ([\w$]+)=(\{league:false,[^}]*\}),\1;/g,
            (m, cache, defaults) => {
              count++;
              return `if(process.platform!=="win32")return ${cache}=globalThis.__linuxwolf?globalThis.__linuxwolf.steam.installedMap(${defaults},${table[1]}):${defaults},${cache};`;
            },
          );
          return { source: out, count };
        },
        expect: 'one',
      },
      {
        // Without ow-electron's overlay package MetaBot still creates its
        // in-game overlay window, as a plain 800x600 transparent window in
        // the middle of the screen, visible right away and not click-through
        // (Electron on Linux has no `forward` for setIgnoreMouseEvents).
        // It cannot draw over the game without the package, but it takes
        // mouse input and stacking from the game under KWin; with the
        // "Alle In-Game Overlays" setting on, the game stops responding.
        // Create it hidden and keep it hidden and inert.
        id: 'overlay-fallback-window',
        find: /name:"metabot-overlay-window",/g,
        replace: 'name:"metabot-overlay-window",show:false,',
        expect: 'one',
      },
      {
        id: 'overlay-fallback-inert',
        find: /([\w$]+)\("overlay-fallback",([\w$]+)\)/g,
        replace: '(globalThis.__linuxwolf&&globalThis.__linuxwolf.inertWindow($2,"metabot-overlay-window"),$1("overlay-fallback",$2))',
        expect: 'one',
      },
    ],
  },
};
