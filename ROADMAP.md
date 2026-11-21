# Roadmap

Goal of the prototype: **MetaBot.GG works with Aniimo under Proton on
KDE Plasma (Wayland)**, without Overwolf and without Windows.

## Step 1: Feasibility spike (done, see [docs/spike-1.md](docs/spike-1.md))

- [x] Detect games running under Proton (`lw-detect`).
- [x] Vulkan layer that draws into a Proton game's frames, verified headless.
- [x] Analyse what Metabot actually needs from Overwolf.
- [ ] Run the overlay and detection with Aniimo on a real machine.

Main finding: Metabot is an **ow-electron** app (Overwolf's Electron fork),
not a classic `.opk` web app. For Aniimo it only needs "is the game
running", a transparent always-on-top window and hotkeys. It does not use
Overwolf's game events or overlay injection for Aniimo.

## Step 2: ow-electron runtime for Metabot (done, see [docs/step-2.md](docs/step-2.md))

Run Metabot's own `app.asar` on stock Linux Electron, with Linuxwolf
providing what ow-electron adds (`runtime/ow-electron`):

- [x] `app.overwolf` with `packages` (per-package `ready`); `gep` and
  `utility` as early stubs, opt-in. Metabot needs none for Aniimo.
- [x] `reg.exe` emulation answered from the Linux Steam client (install
  path, installed apps, `Running` flag from `/proc` + `registry.vdf`).
- [x] Shims for `koffi` and `electron-updater`; in-memory patches for the
  four `process.platform` guards around Steam detection.
- [x] KDE: XWayland by default (keep-above, click-through, X11 hotkeys
  while the Proton game has focus), on-screen-display window type for
  click-through companions; native Wayland via a KWin script (untested).
- [x] Install ow-electron apps from Overwolf's update feed
  (`tools/fetch-ow-electron-app.sh`).
- [x] Headless test: fake Aniimo process -> Metabot shows its prompt and
  opens the Aniimo Companion.
- [ ] Same on a real Plasma desktop with Aniimo (moves into step 3).

## Side track: th.gl Palia app (see [docs/palia.md](docs/palia.md))

th.gl ships its own native Linux Companion App (beta) that reads Palia
under Proton and draws an X11 overlay. Linuxwolf only installs and checks
it; the Overwolf variant (`.opk` + Windows .NET memory-reading plugin) is
not worth emulating.

- [x] Palia in `lw-detect` (Steam 2707930, Overwolf game id 23186).
- [x] Installer with checksum check, setup check script.
- [ ] Run it with Palia on a real Plasma desktop.

## Side track: desktop app (see [docs/gui.md](docs/gui.md))

- [x] One window for installing, starting and stopping apps, Steam/Proton
  game status, auto-start of apps with their game, overlay layer, setup
  checks and logs (`gui/`).
- [ ] Try it on a real Plasma desktop (tray, notifications, Wayland).

## Side track: WoW Forever Map (see [docs/wow-forever-map.md](docs/wow-forever-map.md))

First classic Overwolf app (`.opk`). Linuxwolf now hosts classic apps:
Electron serves the app from `overwolf-extension://<uid>/` and gives it an
`overwolf.*` API (windows, games, io, hotkeys, tray, screenshots).

- [x] Host for classic apps in `runtime/ow-electron/src/opk`, picked by
  `linuxwolf-run` for unpacked `.opk` folders.
- [x] Install from Overwolf's store catalog (`tools/fetch-opk-app.sh`).
- [x] WoW Forever (Overwolf game 28268) under Wine/Proton: detection, Wine
  prefix paths, install lookup.
- [x] Headless test with the real app; listed in the desktop app.
- [ ] Run it with WoW Forever on a real Plasma desktop.

## Step 3: Metabot + Aniimo end to end

- Metabot detects Aniimo started through Steam/Proton and shows its
  Aniimo companion over the game.
- Check behaviour with the game fullscreen vs. borderless on KWin.
- If the window approach does not stay on top of fullscreen games, route
  the companion window through the Vulkan overlay layer instead.

## Step 4: Distribution and the wider app catalog

- App download: ow-electron apps come from Overwolf's update feeds,
  classic apps from the public store catalog. Clarify Overwolf's terms
  and talk to app developers before building a store client on top.
- Classic `.opk` apps: the host exists now (see the WoW Forever Map side
  track); more of the `overwolf.*` API as more apps need it.
- Game events (GEP replacement) and in-game overlay for games where apps
  need them (LoL, TFT, Valorant, ...), using the Vulkan layer.
