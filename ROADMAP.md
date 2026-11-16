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

## Step 2: ow-electron runtime for Metabot

This assumes the native route (B in [docs/spike-1.md](docs/spike-1.md#two-ways-to-run-metabot)).
The alternative is running the Windows build of Metabot inside the game's
Proton prefix.

Run Metabot's own `app.asar` on stock Linux Electron, with Linuxwolf
providing what ow-electron adds:

- `app.overwolf.packages` (event emitter, per-package `ready`), with `gep`,
  `overlay`, `recorder`, `utility` and `ads` as no-op or partial
  implementations. Metabot already disables features cleanly when a
  package is missing.
- Shims for the Windows-only bits Metabot calls for Aniimo: `reg.exe query`
  for Steam paths and the `Running` flag (answered from `lw-detect` and the
  Linux Steam install), `koffi` calls to `user32`/`kernel32`, and the
  `process.platform` guards.
- Wayland/KDE: always-on-top + click-through companion window (KWin script
  or XWayland), global hotkeys via the XDG GlobalShortcuts portal.

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
- Classic `.opk` apps (e.g. the Aniimo apps in the Overwolf catalog):
  CEF/Electron host plus an `overwolf.*` JS API shim.
- Game events (GEP replacement) and in-game overlay for games where apps
  need them (LoL, TFT, Valorant, ...), using the Vulkan layer.
