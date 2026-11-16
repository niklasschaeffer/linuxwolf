# th.gl Palia app on Linux

Date: 2026-11-16 · checked: th.gl Linux Companion App 30.2.1 (released
2026-11-16), Overwolf "Palia Map" 4.31.174

Target: the [th.gl Palia app](https://www.th.gl/apps/palia) (interactive
map, in-game overlay, live position and live tracking of spawned
resources) next to [Palia](https://store.steampowered.com/app/2707930)
under Steam Proton.

## Result

th.gl ships Palia in two forms, and only one of them needs Linuxwolf at all:

| | Overwolf app "Palia Map" | TH.GL Companion App |
|---|---|---|
| Kind | classic Overwolf `.opk` (`WebApp`), uses `overwolf.*` JS APIs, windows `background`/`desktop`/`overlay` | standalone app, no Overwolf |
| Live position / tracking | Overwolf native plugin `plugins/THGLOverwolfPlugin.dll` (.NET, class `THGL.Overwolf.PaliaPlugin`) reads Palia's memory | built in |
| Linux | no. Needs Overwolf's CEF host, its `overwolf.*` API and a Windows .NET plugin that reads the game's memory | **yes, native Linux beta** (`THGL_Companion-x86_64.AppImage`) |

The Companion App for Linux was released by th.gl as a beta. From its
FAQ and the AppImage itself:

- native x86_64 program (GTK3 + WebKitGTK; the UI is loaded from
  `https://app.th.gl`), built on Ubuntu 24.04, needs **glibc 2.38+**,
- finds games started **through Steam with Proton** by scanning `/proc`
  (`SteamAppId`, `STEAM_COMPAT_DATA_PATH`, `WINEPREFIX`), incl. Flatpak and
  Snap Steam layouts,
- reads the game's memory read-only with `process_vm_readv` (no injection,
  nothing changes in the game; th.gl says Singularity 6 has allowed the
  app for Palia),
- overlay is an **X11 window** placed over the game window, hotkeys come
  from XInput2 raw key events and X key grabs, so it needs an **X11 session
  or XWayland** (Proton games are XWayland windows on Plasma Wayland too),
- tray icon via KDE's StatusNotifierItem, self-updating from
  `https://cdn.th.gl/companion-linux/latest.json` (signed manifest),
  settings in `~/.config/thgl-companion/`, log in
  `~/.cache/thgl-companion/log.txt`.

So for Palia, Linuxwolf does not need to emulate Overwolf. Rebuilding the
Overwolf variant (CEF + `overwolf.*` shim + running a Windows .NET plugin
against a Proton process) would be a lot of work for a worse result than
what th.gl already ships. That stays on the roadmap only as a general
"classic `.opk` apps" item.

## What Linuxwolf adds

- `lw-detect` knows Palia (Steam app 2707930, Overwolf game id 23186 from
  the Palia Map manifest).
- `tools/fetch-thgl-companion.sh` installs the AppImage into
  `~/.local/share/linuxwolf/apps/thgl-companion/`, checking size, sha256
  and the glibc requirement from th.gl's release manifest. The folder stays
  writable so the app can update itself.
- `tools/thgl-palia-check.sh` checks the things that make it fail:
  glibc, X11/XWayland, `kernel.yama.ptrace_scope`, Steam and Palia
  install, Proton prefix, and, with Palia running, whether its memory can
  be read the same way the app does it.

## Try it

```sh
tools/fetch-thgl-companion.sh
tools/thgl-palia-check.sh          # once with Palia closed, once with it running
~/.local/share/linuxwolf/apps/thgl-companion/THGL_Companion-x86_64.AppImage
```

Then start Palia from Steam. The hotkeys are listed in the app's settings
(the Overwolf app uses F6 show/hide, F5 live mode, F9 lock/unlock, F10
mark as discovered).

On KDE Plasma (Wayland):

- Keep the session's XWayland on (default). The app runs as an X11 client.
- Use Palia in borderless or windowed fullscreen. If the overlay stays
  behind the game, add a KWin window rule for the window class
  `thgl-companion` with "Keep above".
- "Reading this game's memory is not permitted" in the app means the
  game was not started from Steam, or `ptrace_scope` is 2 or 3.

## Not tested yet

Nothing here ran against a real Palia session: no GPU or game in the cloud
environment, and the AppImage was not started there. Verified: the
download and checksum, the AppImage contents, the check script against a
fake Steam library and a fake game process, `lw-detect` with a fake Palia
process. Feedback on the beta goes to th.gl's Discord
(#suggestions-issues, "Linux Companion App (beta): your feedback").

## Notes

- Nothing from th.gl is in this repository.
- The Overwolf "Palia Map" `.opk` is a useful test case for the later
  classic-app runtime: it uses hotkeys with `passthrough`, launch events
  on game id 23186, `externally_connectable` for `*.th.gl`, and native
  plugins via `extra-objects` (which a Linux runtime cannot load).
