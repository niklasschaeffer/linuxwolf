#!/usr/bin/env bash
# Headless check that MetaBot runs on the Linuxwolf runtime and reacts to
# Aniimo, without the game: starts Xvfb, a fake Aniimo-under-Proton process
# and a fake Steam library, runs MetaBot for a while and takes a screenshot.
#
#   tools/metabot-smoketest.sh <installed app dir> [screenshot.png]
#
# Install the app first with tools/fetch-ow-electron-app.sh.
# Needs: Xvfb, ImageMagick (import), npm install in runtime/ow-electron.
# Uses a throwaway HOME, so your real MetaBot settings are not touched.
set -euo pipefail

app="${1:?usage: $0 <installed app dir> [screenshot.png]}"
shot="$(readlink -f "${2:-metabot-smoketest.png}")"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
display=":$((90 + RANDOM % 9))"
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

# Fake Steam library with Aniimo installed.
mkdir -p "$work/steam/steamapps" "$work/home"
printf '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n}\n' "$work/steam" > "$work/steam/steamapps/libraryfolders.vdf"
printf '"AppState"\n{\n\t"appid"\t\t"4126040"\n\t"name"\t\t"Aniimo"\n}\n' > "$work/steam/steamapps/appmanifest_4126040.acf"

# Pre-seed MetaBot settings: skip the first-run wizard and open the Aniimo
# companion automatically when the game starts.
cfg="$work/home/.config/MetaBot.GG Desktop"
mkdir -p "$cfg"
echo '{"ftueCompleted":true,"overlaySettings":{"aniimo-overlay":{"companionWidget":true}}}' > "$cfg/config.json"

# A process that looks like Aniimo running under Proton.
(
  export SteamAppId=4126040 STEAM_COMPAT_DATA_PATH="$work/steam/steamapps/compatdata/4126040"
  exec -a 'Z:\games\Aniimo\Aniimo.exe' sleep 600
) &
pids+=($!)

Xvfb "$display" -screen 0 1920x1080x24 >/dev/null 2>&1 &
pids+=($!)
sleep 1

echo "running MetaBot for 90 s (MetaBot needs two polls, 30 s apart, to see the game)"
HOME="$work/home" DISPLAY="$display" LINUXWOLF_STEAM_ROOT="$work/steam" LINUXWOLF_DEBUG=1 \
  "$here/runtime/ow-electron/bin/linuxwolf-run" "$app" > "$work/run.log" 2>&1 &
pids+=($!)
sleep 90
DISPLAY="$display" import -window root "$shot"
grep '^\[linuxwolf\]' "$work/run.log" | sort | uniq -c
echo "screenshot: $shot"
