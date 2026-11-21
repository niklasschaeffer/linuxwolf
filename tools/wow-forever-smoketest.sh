#!/usr/bin/env bash
# Headless check that WoW Forever Map (classic Overwolf app) runs on the
# Linuxwolf runtime and reacts to the game, without the game: starts Xvfb, a
# fake Wine prefix with a WoW Forever install, a process that looks like
# WoW Forever under Wine, runs the app and takes screenshots.
#
#   tools/wow-forever-smoketest.sh <installed app dir> [screenshot prefix]
#
# Install the app first with tools/fetch-opk-app.sh.
# Needs: Xvfb, ImageMagick (import), npm install in runtime/ow-electron.
# Uses a throwaway HOME.
set -euo pipefail

app="${1:?usage: $0 <installed app dir> [screenshot prefix]}"
shot="$(readlink -f "${2:-wow-forever-smoketest}")"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
display=":$((90 + RANDOM % 9))"
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

# Fake Wine prefix (like Lutris' ~/Games/battlenet) with the game installed.
pfx="$work/home/Games/battlenet"
wow="$pfx/drive_c/Program Files (x86)/World of Warcraft/_forever_"
mkdir -p "$wow/Interface/AddOns" "$wow/WTF/Account/SMOKETEST/SavedVariables" "$pfx/dosdevices"
: > "$wow/Wow.exe"
ln -s ../drive_c "$pfx/dosdevices/c:"
# Keep the certificates Chromium trusts for this user (corporate proxies).
[[ -d "$HOME/.pki/nssdb" ]] && mkdir -p "$work/home/.pki" && cp -r "$HOME/.pki/nssdb" "$work/home/.pki/"

Xvfb "$display" -screen 0 1920x1080x24 >/dev/null 2>&1 &
pids+=($!)
sleep 1

echo "starting WoW Forever Map (no game yet)"
HOME="$work/home" DISPLAY="$display" LINUXWOLF_DEBUG=1 \
  "$here/runtime/ow-electron/bin/linuxwolf-run" "$app" > "$work/run.log" 2>&1 &
pids+=($!)
sleep 25
DISPLAY="$display" import -window root "$shot-desktop.png"

echo "starting a fake WoW Forever under Wine"
(
  export WINEPREFIX="$pfx"
  exec -a 'C:\Program Files (x86)\World of Warcraft\_forever_\Wow.exe' sleep 600
) &
pids+=($!)
sleep 25
DISPLAY="$display" import -window root "$shot-ingame.png"

grep '^\[linuxwolf\]' "$work/run.log" | grep -v '\[api\]' | sort | uniq -c
echo "--- overwolf API calls (count, method)"
grep -o '\[api\] [a-z_]*: [a-zA-Z0-9_.]*' "$work/run.log" | sed 's/.*: //' | sort | uniq -c | sort -rn
echo "--- addon files the app wrote into the game folder"
(cd "$wow" && find Interface -type f | sort)
echo "screenshots: $shot-desktop.png $shot-ingame.png"
