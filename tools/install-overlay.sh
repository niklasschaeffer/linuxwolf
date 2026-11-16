#!/usr/bin/env bash
# Install the Linuxwolf overlay layer for the current user.
# Afterwards set the Steam launch option of a game to:
#   LINUXWOLF_OVERLAY=1 %command%
# Remove with: tools/install-overlay.sh --uninstall
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
lib_dir="$data/linuxwolf"
manifest_dir="$data/vulkan/implicit_layer.d"
manifest="$manifest_dir/VkLayer_linuxwolf_overlay.json"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$manifest" "$lib_dir/libVkLayer_linuxwolf_overlay.so"
  echo "Removed."
  exit 0
fi

cargo build --release -p lw-overlay-layer --manifest-path "$root/Cargo.toml"
mkdir -p "$lib_dir" "$manifest_dir"
install -m 755 "$root/target/release/libVkLayer_linuxwolf_overlay.so" "$lib_dir/"
sed "s|@LIBRARY_PATH@|$lib_dir/libVkLayer_linuxwolf_overlay.so|" \
  "$root/crates/lw-overlay-layer/VkLayer_linuxwolf_overlay.json.in" > "$manifest"
echo "Installed $manifest"
echo "Steam launch option: LINUXWOLF_OVERLAY=1 %command%"
echo "Debug log:           LINUXWOLF_OVERLAY=1 LINUXWOLF_OVERLAY_DEBUG=1 %command%"
