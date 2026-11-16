#!/usr/bin/env bash
# Install th.gl's native Linux Companion App (beta), which covers Palia and
# the other Unreal Engine games of th.gl, started through Steam/Proton.
#
#   tools/fetch-thgl-companion.sh [dest dir]
#
# Default dest: ~/.local/share/linuxwolf/apps/thgl-companion
# Needs: curl, python3, sha256sum. Checks size and sha256 from th.gl's
# release manifest and the glibc version the build needs.
#
# The AppImage updates itself in the folder it lives in, so the folder must
# stay writable. Running this again only reinstalls when the file is gone.
# Nothing downloaded here belongs in the repository.
set -euo pipefail

case "${1:-}" in -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
for tool in curl python3 sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

feed="${THGL_LINUX_FEED:-https://cdn.th.gl/companion-linux/latest.json}"
dest="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/linuxwolf/apps/thgl-companion}"
target="$dest/THGL_Companion-x86_64.AppImage"

if [[ -x "$target" ]]; then
  echo "already installed: $target (it updates itself)"
  echo "run: $target"
  exit 0
fi

# latest.json = {"signed": "<release json as string>", "signature": "..."}.
# The signature is checked by the app's own updater; here we pin size and
# sha256 from the signed part.
manifest="$(curl -fsSL "$feed")"
read -r version url size sha256 min_glibc < <(python3 -I -c '
import json, sys
r = json.loads(json.loads(sys.stdin.read())["signed"])
print(r["version"], r["downloadUrl"], r["size"], r["sha256"], r.get("minGlibc", "0"))
' <<<"$manifest")
case "$url" in
  https://cdn.th.gl/*) ;;
  *) echo "unexpected download URL in $feed: $url" >&2; exit 1 ;;
esac

have_glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [[ -n "$have_glibc" ]] && [[ "$(printf '%s\n%s\n' "$min_glibc" "$have_glibc" | sort -V | head -1)" != "$min_glibc" ]]; then
  echo "glibc $have_glibc is too old, the Companion App $version needs $min_glibc or newer" >&2
  exit 1
fi

mkdir -p "$dest"
tmp="$(mktemp "$dest/.download.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
echo "downloading THGL Companion $version"
curl -fL --progress-bar -o "$tmp" "$url"
actual_size="$(stat -c %s "$tmp")"
[[ "$actual_size" == "$size" ]] || { echo "size mismatch ($actual_size != $size), not installing" >&2; exit 1; }
actual_sha="$(sha256sum "$tmp" | awk '{print $1}')"
[[ "$actual_sha" == "$sha256" ]] || { echo "sha256 mismatch, not installing" >&2; exit 1; }
chmod 755 "$tmp"
mv "$tmp" "$target"
trap - EXIT
echo "installed to $target"
echo "check your setup: tools/thgl-palia-check.sh"
echo "run: $target"
