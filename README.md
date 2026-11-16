# Linuxwolf

A native Linux runtime for Overwolf apps, built to work with games running
under Steam Proton.

Overwolf itself does not run on Linux, not even with Wine workarounds.
Linuxwolf takes the other route: the apps run natively on Linux, and
Linuxwolf provides the pieces Overwolf normally provides (game detection,
game events, in-game overlay, app distribution).

**Status:** early prototype (step 1 of the [roadmap](ROADMAP.md)). First
target: [MetaBot.GG](https://metabot.gg/) with
[Aniimo](https://store.steampowered.com/app/4126040) under Proton on
KDE Plasma (Wayland).

## What is here

| Path | What it does |
|---|---|
| `crates/lw-detect` | Detects games running under Proton/Wine by scanning `/proc` (Steam app id, game exe, Wine prefix). `cargo run -p lw-detect -- --watch` |
| `crates/lw-overlay-layer` | Vulkan layer that draws an overlay into a game's frames. Works for Proton games because DXVK/VKD3D present through Vulkan. Currently draws a test HUD. |
| `crates/lw-vk-smoketest` | Headless Vulkan app that checks the layer really draws into presented images (runs on Mesa lavapipe, no GPU needed). |
| `tools/` | `smoketest.sh`, `install-overlay.sh`, font generator. |
| `docs/` | Spike reports and design notes. |

## Try it

```sh
# Game detection: start a Proton game, then
cargo run -p lw-detect

# Overlay test HUD in a Proton game
tools/install-overlay.sh
# Steam > game > Properties > Launch options:
#   LINUXWOLF_OVERLAY=1 %command%

# Headless overlay test (needs a Vulkan driver, e.g. mesa-vulkan-drivers)
tools/smoketest.sh
```

Read [docs/spike-1.md](docs/spike-1.md) before using the overlay with games
that ship kernel-level anti-cheat.

## License

Not chosen yet.
