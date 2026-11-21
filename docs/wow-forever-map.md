# WoW Forever Map on Linux

Date: 2026-11-21 · tested with WoW Forever Map 5.0.1 (rastudio), Electron 42.11.4

Target: the Overwolf app [WoW Forever Map](https://www.overwolf.com/app/rastudio-wow_forever_map)
(interactive map, quests, NPCs, dungeons, guides, talent calculator, an
in-game minimap) next to **World of Warcraft: Forever** running under
Wine/Proton.

## What kind of app it is

| | |
|---|---|
| Overwolf app uid | `pjmcljgifdbecdpkdjjaklihmacmfjdondplefhg` |
| Kind | **classic Overwolf app** (`.opk`, manifest type `WebApp`), 8 MB, in Overwolf's public store catalog. Not ow-electron (store page: `isElectron: false`). |
| Overwolf game | class id **28268**, "World of Warcraft: Forever" (Battle.net game, client in `World of Warcraft\_forever_\Wow.exe`) |
| Windows | `background` (start window), `main` (desktop, 1680×840), `in_game` (same UI over the game), `overlay_map` (360×280 minimap over the game) |
| Native parts | none: no plugins, no DLLs. Plain web app (React, vite build). |
| Linux version | none. The developer only ships the Overwolf app. |

So unlike MetaBot (ow-electron) and th.gl (own Linux app), this one needs a
host for classic Overwolf apps: an Electron shell that serves the app from
`overwolf-extension://<uid>/` and provides the `overwolf.*` JavaScript API.
Linuxwolf now has one (`runtime/ow-electron/src/opk/`), and
`linuxwolf-run` uses it automatically for unpacked `.opk` folders.

### How the app uses Overwolf

Read from the bundle (`assets/*.js`):

- **Game detection:** `overwolf.games.getRunningGameInfo` /
  `onGameInfoUpdated` / `onGameLaunched` with class id 28268.
  `executionPath` and `getGameInfo(...).ProcessPath` tell it where the game
  is installed; as a fallback it checks
  `<Program Files (x86)>\World of Warcraft\_forever_\Wow.exe`.
- **Files:** `overwolf.io` to install its own addon
  (`Interface\AddOns\wfm-position-bridge`) and to read the addon's
  SavedVariables (`WTF\Account\<account>\SavedVariables\...`) for character
  sync, plus a cache file in `localAppData\WoWForeverMap`.
- **Live position:** the addon draws a small code on screen; the app takes
  screenshots of the game (`overwolf.media.createScreenshotBuffer`) and reads
  them with Tesseract (bundled WASM). It also asks Overwolf's game events
  (`overwolf.games.events`, features `location`, `player_info`) if they exist.
  In 5.0.1 the position tracker logs `disabled`, so the feature looks like it
  is not switched on for users yet.
- **Windows, hotkeys, tray:** `overwolf.windows.*` (obtain/restore/minimize,
  drag move/resize, size/position, click-through via `InputPassThrough`,
  messages between windows), `overwolf.settings.hotkeys` (Ctrl+M minimap,
  Ctrl+Shift+D desktop app, Ctrl+Shift+A app), `overwolf.os.tray`.
- **Account/ads:** `overwolf.profile` (Overwolf login for premium),
  Overwolf's ad SDK (`owads.min.js`).

## What Linuxwolf provides

| Overwolf API | On Linuxwolf |
|---|---|
| windows | Electron windows from the manifest, frameless, transparent where the manifest says so. In-game windows are always-on-top windows on the game's screen (positions relative to it), hidden when the game exits. Drag move/resize follows the pointer. `InputPassThrough` = click-through (and KDE's on-screen-display layer, see [step-2.md](step-2.md#windows-always-on-top-and-hotkeys-on-kde)). |
| games | WoW Forever found in `/proc`: a Wine/Proton process `Wow.exe` under `\_forever_\`. Works for Lutris/Bottles/plain Wine and for WoW added to Steam as a non-Steam game with Proton. `getGameInfo` also finds the install when the game is not running (Wine prefixes in `~/Games/*`, `~/.wine`, Bottles, Steam `compatdata`, or `LINUXWOLF_WINEPREFIX`). |
| io | Windows paths mapped into the game's Wine prefix (`C:\` via `dosdevices`, `Z:\` = `/`), case-insensitive like Windows. `io.paths` (localAppData, documents, ...) point to a per-app drive `L:\` = `~/.local/share/linuxwolf/opk-data/<uid>/`, so app data never lands in the game prefix. |
| media.createScreenshotBuffer | Frame of the game window via Electron's desktopCapturer (XComposite on X11/XWayland, no portal dialog), handed out as RGBA like Overwolf. Off on the native Wayland backend. |
| settings.hotkeys | Electron global shortcuts (X11 key grabs, work while the Wine game has focus), active only while the game runs, rebinding saved per app. |
| os.tray, utils, extensions | Tray icon and menu, monitors, clipboard, open links in the default browser, manifest, launch events. |
| games.events (game events) | **Not available.** Overwolf's game events provider is closed. The app checks for it and carries on without. |
| profile | Nobody is signed in. Overwolf login and Overwolf subscriptions do not exist outside Overwolf, so **premium cannot be bought or used**; the free app works. |
| Ads | Overwolf's ad SDK does not work outside Overwolf (it fails with an error in the log). The app shows its own "Go Premium" banner instead. |

## Tested

In the cloud with Xvfb, no GPU, a fake Wine prefix with a WoW Forever
install and a fake `Wow.exe` process (`tools/wow-forever-smoketest.sh`):

- Install from Overwolf's catalog (`tools/fetch-opk-app.sh`, 5.0.1).
- The app starts, the background page opens the main window, the map loads
  its data from the developer's CDN, filters, search and the tour work.
- Before the game: `getGameInfo` finds the install in the prefix, the app
  checks the addon and SavedVariables in the right folders.
- Game starts: Linuxwolf reports WoW Forever (pid, prefix), the app's
  "auto move by game" reacts, the hotkeys get grabbed, the minimap
  (`overlay_map`) appears in the bottom right corner over the game.
- Linuxwolf desktop app: "WoW Forever Map" in the Library (install, update,
  start, "With game"), WoW Forever shows as installed and as running.

Not tested: a real WoW Forever client, a real Plasma desktop (stacking of
the overlay windows over a fullscreen game, see below), the position
tracking with the real addon, and with it the screenshot API (the app's
position tracker is off in 5.0.1, so it never asked for a screenshot).

## Use it

```sh
tools/fetch-opk-app.sh pjmcljgifdbecdpkdjjaklihmacmfjdondplefhg
runtime/ow-electron/bin/linuxwolf-run ~/.local/share/linuxwolf/apps/pjmcljgifdbecdpkdjjaklihmacmfjdondplefhg/5.0.1
```

Or in the desktop app: Library → WoW Forever Map → Install, then "With game"
to start it whenever WoW Forever starts.

Notes for the game side:

- Run WoW Forever through Battle.net in Wine/Proton (Lutris' Battle.net
  installer, Bottles, or Battle.net added to Steam as a non-Steam game with
  Proton). Linuxwolf finds the prefix from the running game.
- Use **borderless windowed** in WoW. KWin puts a focused fullscreen window
  above "keep above" windows, so the minimap and the in-game window may end
  up behind a true fullscreen game.
- Keep the default X11/XWayland backend for this app (screenshots for live
  position and hotkeys need it).
- Nothing touches the game process: the app writes its addon into the WoW
  folder and reads files and screenshots, the same as on Windows.

Debug: `LINUXWOLF_DEBUG=1` logs every `overwolf.*` call and every mapped
path. `LINUXWOLF_WINEPREFIX=<prefix>` picks the prefix by hand.

## Other classic apps

The host is generic: any `WebApp` from the catalog can be installed with
`tools/fetch-opk-app.sh <uid>` (or the desktop app's "Add an Overwolf app")
and started with `linuxwolf-run`. Apps that need game events, Overwolf
native plugins (`plugins/*.dll`, `overwolf.extensions.current.getExtraObject`)
or games Linuxwolf does not know yet (`src/opk/games.js`) will miss those
parts.
