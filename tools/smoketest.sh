#!/usr/bin/env bash
# Build the overlay layer and run the headless Vulkan smoke test against it.
# Needs a Vulkan driver; in CI/cloud: apt install mesa-vulkan-drivers vulkan-validationlayers
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
cargo build -q -p lw-overlay-layer -p lw-vk-smoketest
tmp="$(mktemp -d)"
sed "s|@LIBRARY_PATH@|$root/target/debug/libVkLayer_linuxwolf_overlay.so|" \
  crates/lw-overlay-layer/VkLayer_linuxwolf_overlay.json.in > "$tmp/VkLayer_linuxwolf_overlay.json"
# Installed for real, the manifest goes to ~/.local/share/vulkan/implicit_layer.d
# and the layer turns on with LINUXWOLF_OVERLAY=1. For the test we load it
# explicitly from a temp dir, which runs the same code.
export VK_LAYER_PATH="$tmp:/usr/share/vulkan/explicit_layer.d"
export LINUXWOLF_OVERLAY=1
export LINUXWOLF_OVERLAY_DEBUG=1
layers=VK_LAYER_LINUXWOLF_overlay
if [[ "${VALIDATE:-1}" == 1 ]] && [[ -e /usr/share/vulkan/explicit_layer.d/VkLayer_khronos_validation.json ]]; then
  # Validation sits between the app and our layer and below it, so it checks
  # the commands the overlay records as well.
  layers="VK_LAYER_KHRONOS_validation:$layers"
fi
export VK_INSTANCE_LAYERS="$layers"
exec "$root/target/debug/lw-vk-smoketest" "$@"
