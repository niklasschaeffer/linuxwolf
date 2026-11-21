#!/usr/bin/env bash
# Download a classic Overwolf app (.opk) from Overwolf's public store catalog
# and unpack it for linuxwolf-run.
#
#   tools/fetch-opk-app.sh <overwolf app uid> [dest dir]
#
# WoW Forever Map: pjmcljgifdbecdpkdjjaklihmacmfjdondplefhg
# Default dest: ~/.local/share/linuxwolf/apps/<uid>/<version>
# Needs: curl, python3. Exit code 3: the uid is not in the catalog.
#
# The app stays on your machine. Do not commit the downloaded files.
set -euo pipefail

uid="${1:-}"
if [[ ! "$uid" =~ ^[a-z]{40}$ ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

catalog="https://apps.overwolf.com/prod/OWStoreExtentions.json.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/catalog.json.gz" "$catalog"

# -> "<version>\t<download url>\t<name>"
entry="$(python3 -I - "$work/catalog.json.gz" "$uid" <<'PY'
import gzip, json, sys
data = json.load(gzip.open(sys.argv[1]))
for e in data.get("Extensions", []):
    if e.get("UID") == sys.argv[2]:
        print(f'{e.get("Version", "")}\t{e.get("DownloadURL", "")}\t{e.get("Name", "")}\t{e.get("Type", "")}')
        break
PY
)"
if [[ -z "$entry" ]]; then
  echo "$uid is not in Overwolf's store catalog." >&2
  echo "If it is an ow-electron app (Electron, e.g. MetaBot), use tools/fetch-ow-electron-app.sh." >&2
  exit 3
fi
IFS=$'\t' read -r version url name type <<<"$entry"
[[ "$type" == "WebApp" ]] || { echo "$name is a $type, only WebApp apps run on Linuxwolf" >&2; exit 1; }
[[ "$url" == https://appsdl.overwolf.com/* ]] || { echo "unexpected download URL: $url" >&2; exit 1; }
[[ "$version" =~ ^[0-9A-Za-z._-]+$ ]] || { echo "unexpected version: $version" >&2; exit 1; }

dest="${2:-${XDG_DATA_HOME:-$HOME/.local/share}/linuxwolf/apps/$uid/$version}"
if [[ -f "$dest/manifest.json" ]]; then
  echo "already installed: $dest"
  exit 0
fi

echo "downloading $name $version"
curl -fL --progress-bar -o "$work/app.opk" "$url"

# An .opk is a zip. Check it, refuse paths outside the target, unpack.
python3 -I - "$work/app.opk" "$work/unpacked" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    bad = z.testzip()
    if bad:
        sys.exit(f"corrupt file in package: {bad}")
    root = os.path.realpath(out)
    for info in z.infolist():
        name = info.filename.replace("\\", "/")
        target = os.path.realpath(os.path.join(root, name))
        if target != root and not target.startswith(root + os.sep):
            sys.exit(f"refusing path outside the app folder: {info.filename}")
    z.extractall(out)
if not os.path.isfile(os.path.join(out, "manifest.json")):
    sys.exit("unexpected package layout, no manifest.json")
PY
mkdir -p "$(dirname "$dest")"
rm -rf "$dest.tmp"
mv "$work/unpacked" "$dest.tmp"
mv "$dest.tmp" "$dest"
echo "installed to $dest"
echo "run: runtime/ow-electron/bin/linuxwolf-run \"$dest\""
