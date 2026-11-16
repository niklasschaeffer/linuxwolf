#!/usr/bin/env bash
# Download an ow-electron app (e.g. MetaBot) from Overwolf's update feed and
# unpack it for linuxwolf-run, without running the Windows installer.
#
#   tools/fetch-ow-electron-app.sh <overwolf app uid> [dest dir]
#
# MetaBot.GG: iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf
# Default dest: ~/.local/share/linuxwolf/apps/<uid>/<version>
# Needs: curl, openssl, 7z (p7zip / 7zip package).
#
# The app stays on your machine. Do not commit the downloaded files.
set -euo pipefail

uid="${1:-}"
if [[ ! "$uid" =~ ^[a-z]{40}$ ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
for tool in curl openssl 7z; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

feed="https://electron-updates.overwolf.com/electron-updates/electron/$uid/latest.yml"
yml="$(curl -fsSL "$feed")"
field() { sed -n "s/^ *-\{0,1\} *$1: *//p" <<<"$yml" | head -1 | tr -d "\"'\r"; }
version="$(field version)"
url="$(field url)"
sha512="$(field sha512)"
[[ -n "$version" && -n "$url" && -n "$sha512" ]] || { echo "could not read $feed" >&2; exit 1; }
case "$url" in
  https://*) ;;
  *) url="https://appsdl.overwolf.com/prod/apps/$uid/$version/$url" ;;
esac

dest="${2:-${XDG_DATA_HOME:-$HOME/.local/share}/linuxwolf/apps/$uid/$version}"
if [[ -f "$dest/resources/app.asar" ]]; then
  echo "already installed: $dest"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "downloading $(field releaseName) $version"
curl -fL --progress-bar -o "$work/setup.exe" "$url"
actual="$(openssl dgst -sha512 -binary "$work/setup.exe" | openssl base64 -A)"
[[ "$actual" == "$sha512" ]] || { echo "sha512 mismatch, not installing" >&2; exit 1; }

# NSIS installer -> $PLUGINSDIR/app-64.7z -> app folder.
7z x -y -o"$work/nsis" "$work/setup.exe" '$PLUGINSDIR/app-64.7z' >/dev/null
mkdir -p "$dest"
7z x -y -o"$dest" "$work/nsis/\$PLUGINSDIR/app-64.7z" >/dev/null
[[ -f "$dest/resources/app.asar" ]] || { echo "unexpected package layout, no resources/app.asar" >&2; exit 1; }
echo "installed to $dest"
echo "run: runtime/ow-electron/bin/linuxwolf-run \"$dest\""
