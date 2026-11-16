# Step 2: ow-electron runtime for MetaBot

Date: 2026-11-16 · tested with MetaBot.GG Desktop 4.0.4 on Electron 42.11.4

Goal: run MetaBot's own `app.asar` natively on Linux (route B in
[spike-1.md](spike-1.md#two-ways-to-run-metabot)), with Linuxwolf providing
what Overwolf's Electron fork (ow-electron) normally adds.

## Result

MetaBot starts on stock Linux Electron 42 with the runtime in
`runtime/ow-electron`. In a headless test with a fake Aniimo-under-Proton
process and a fake Steam library, MetaBot:

- sees Aniimo as installed and shows it in the app,
- detects the game start through its normal Steam "Running" flag check,
- shows its "Playing Aniimo?" prompt, and opens the **Aniimo Companion**
  window (hunt list, daily/weekly checklist, timers) when auto-open is on.

Not tested yet: a real Aniimo process, a real KDE Plasma session (KWin
stacking over a fullscreen game), Wayland mode, global hotkeys.

## What the runtime does

`bin/linuxwolf-run <app>` starts Electron with `src/main.js`, which sets
things up and then `require`s the app's own entry point:

| Piece | File | What it does |
|---|---|---|
| Packaged-app setup | `src/main.js` | App name, version, `userData`, `app.getAppPath()`, `process.resourcesPath`, `app.isPackaged = true`, so the app behaves like its Windows release build. Log files the app writes to the working directory go to `~/.local/state/linuxwolf/apps/<name>/`. |
| `app.overwolf` | `src/overwolf.js` | ow-electron API object. `packages` (an EventEmitter announcing `ready` per package) is only created for packages listed in `LINUXWOLF_OW_PACKAGES`. `gep` and `utility` exist as early stubs. Default is none: MetaBot needs no Overwolf package for Aniimo and switches GEP, overlay injection and recording off cleanly. Ads/email-hash APIs are left out on purpose. |
| `reg.exe` | `src/registry.js`, `src/child-process-shim.js` | Virtual registry answering `reg query/add/delete` in exact Windows output format. `HKCU\Software\Valve\Steam` (SteamPath, RunningAppID) and `...\Steam\Apps\<id>\{Installed,Running}` come live from the Linux Steam client: installed from the Steam library manifests, running from a `/proc` scan (same rules as `lw-detect`) plus Steam's `~/.steam/registry.vdf`. Values the app writes are kept in `linuxwolf-registry.json` in its `userData`. |
| Steam | `src/steam.js`, `src/vdf.js` | Finds native and Flatpak Steam, all library folders, installed app ids. |
| `koffi` | `src/koffi-shim.js` | Replaces the Win32-only FFI module. `user32!SetWindowPos`/`GetAsyncKeyState` are answered, anything else returns 0. MetaBot does not reach these on Linux. |
| `electron-updater` | `src/updater-shim.js` | Always "no update". Updates come from `tools/fetch-ow-electron-app.sh`. |
| Platform guards | `src/compat/` | Per-app patches applied in memory when the bundle is compiled (nothing on disk is changed). For MetaBot, four patterns open the `process.platform !== "win32"` guards around Steam detection: the shared "Running" flag reader, the per-game presence polls (5 games incl. Aniimo), "is installed" and the installed-games map. Koffi, elevation, WMI and other Windows-only paths stay off. Patches match by pattern, not minified names; a patch that stops matching is logged (`DID NOT MATCH`) and the feature stays off. |
| Windows on KDE | `src/windows.js` | See below. |
| Proxy | `src/main.js` | Node's `fetch()` ignores `HTTPS_PROXY`; the runtime routes it through the env proxy. |

Why not set `process.platform = "win32"` globally: MetaBot builds Windows
paths (`C:\...`, `%APPDATA%\..\Local`) and calls Windows tools whenever it
thinks it is on Windows, so it would break in many more places than the
four guards above.

## Windows, always-on-top and hotkeys on KDE

MetaBot puts companions in transparent windows with
`setAlwaysOnTop(true, "screen-saver")`, some also click-through.

- **Default: X11 via XWayland** (`--ozone-platform=x11`). Proton games are
  XWayland windows too, so the companion and the game share one X stack,
  and X11 global shortcuts (`globalShortcut`) work while the game has
  focus. KWin puts a focused fullscreen window above "keep above"
  windows, so for click-through screen-saver windows the runtime also
  sets `_NET_WM_WINDOW_TYPE` to KDE's on-screen-display type (needs
  `xprop`), which KWin stacks above fullscreen. Verified that the
  property is set; KWin behaviour still to be checked on a real desktop.
  `LINUXWOLF_OSD=all` does it for interactive windows too (they then
  cannot take keyboard focus), `off` disables it.
- **Native Wayland** (`LINUXWOLF_BACKEND=wayland`): Wayland has no
  always-on-top for normal windows. The runtime loads a short KWin script
  over D-Bus that sets `keepAbove`, and enables Electron's
  GlobalShortcuts portal. Does not beat a focused fullscreen game.
  Untested.

The MetaBot setting "companion always on top" (`companionOnTop`) is off by
default; the companion is then a normal window.

## Try it

```sh
cd runtime/ow-electron && npm install && npm test
tools/fetch-ow-electron-app.sh iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf
runtime/ow-electron/bin/linuxwolf-run ~/.local/share/linuxwolf/apps/iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf/4.0.4
```

`linuxwolf-run` runs `npm install` and downloads the Electron binary on
first start if needed (since Electron 42 the npm package no longer
downloads it during `npm install`). Needs Node.js >= 22.12.

In MetaBot, make sure Aniimo is not hidden in the game list, then start
Aniimo through Steam. MetaBot polls every 30 s and needs two polls in a
row, so the prompt or companion shows up 30 to 60 s after the game starts.

Headless check without the game (Xvfb, fake process, throwaway HOME):
`tools/metabot-smoketest.sh <installed app dir> shot.png`.

Debug output: `LINUXWOLF_DEBUG=1` logs every emulated `reg.exe` call.
`LINUXWOLF_APP_DEV=1` keeps `app.isPackaged` false, which turns on
MetaBot's own debug log (it then talks to its dev API host instead).

## Notes

- Nothing from MetaBot is in this repository. The fetch script downloads
  the installer from Overwolf's public update feed, checks its sha512 and
  unpacks it locally.
- MetaBot's `_metadata.json` signature check is an ow-electron feature and
  is not performed by stock Electron.
- Running another company's app this way is fine for a prototype. Before
  shipping anything, talk to the MetaBot developers; with this runtime a
  Linux build would be cheap for them.
