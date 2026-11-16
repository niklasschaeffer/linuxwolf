#!/usr/bin/env bash
# Check whether this machine is set up for th.gl's Linux Companion App with
# Palia under Steam/Proton, and say what to change if not.
#
#   tools/thgl-palia-check.sh
#
# Start Palia through Steam first to also check that the app will be allowed
# to read the game (the live position needs that). Reads only; changes
# nothing.
set -uo pipefail

PALIA_APPID=2707930
PALIA_EXE=PaliaClient-Win64-Shipping.exe
fail=0
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  note  %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }

echo "System"
glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [[ -z "$glibc" ]]; then
  bad "glibc not found (musl systems are not supported by the AppImage)"
elif [[ "$(printf '2.38\n%s\n' "$glibc" | sort -V | head -1)" == "2.38" ]]; then
  ok "glibc $glibc (needs 2.38+)"
else
  bad "glibc $glibc, the Companion App needs 2.38 or newer"
fi

if [[ -n "${DISPLAY:-}" ]]; then
  ok "X11 display $DISPLAY (${XDG_SESSION_TYPE:-unknown} session${WAYLAND_DISPLAY:+, via XWayland})"
else
  bad "no X11 display: the app needs an X11 session or XWayland (on Plasma Wayland XWayland is on by default; check that DISPLAY is set)"
fi

scope="$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none)"
case "$scope" in
  none|0) ok "ptrace_scope ${scope/none/not set (no Yama)}" ;;
  1) ok "ptrace_scope 1 (default; th.gl says reading works when the game is started through Steam)" ;;
  *) bad "kernel.yama.ptrace_scope=$scope blocks reading other processes, so live mode cannot work. 1 is the usual default." ;;
esac

echo "Steam and Palia"
roots=()
for r in "$HOME/.local/share/Steam" "$HOME/.steam/steam" "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam" "$HOME/snap/steam/common/.local/share/Steam"; do
  [[ -f "$r/steamapps/libraryfolders.vdf" ]] || continue
  real="$(readlink -f "$r")"
  [[ " ${roots[*]-} " == *" $real "* ]] || roots+=("$real")
done
if (( ${#roots[@]} == 0 )); then
  bad "no Steam installation found"
fi
found=""
for r in "${roots[@]}"; do
  case "$r" in */.var/app/*) warn "Flatpak Steam at $r (the app knows this layout; not tested by Linuxwolf)" ;;
               */snap/*) warn "Snap Steam at $r (not tested)" ;;
               *) ok "Steam at $r" ;; esac
  while IFS= read -r lib; do
    [[ -f "$lib/steamapps/appmanifest_$PALIA_APPID.acf" ]] && found="$lib"
  done < <(sed -n 's/^[[:space:]]*"path"[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$r/steamapps/libraryfolders.vdf"; echo "$r")
done
if [[ -n "$found" ]]; then
  ok "Palia installed in $found"
  [[ -d "$found/steamapps/compatdata/$PALIA_APPID/pfx" ]] \
    && ok "Proton prefix exists" \
    || warn "no Proton prefix yet: start Palia once through Steam"
elif (( ${#roots[@]} > 0 )); then
  bad "Palia (Steam app $PALIA_APPID) is not installed in any Steam library. The Companion App only supports the Steam version under Proton."
fi

echo "Running game"
pid=""
for d in /proc/[0-9]*; do
  tr '\0' '\n' <"$d/cmdline" 2>/dev/null | head -1 | grep -qi "$PALIA_EXE\$" && { pid="${d#/proc/}"; break; }
done
if [[ -z "$pid" ]]; then
  warn "Palia is not running; start it through Steam and run this again to test memory access"
else
  appid="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n 's/^SteamAppId=//p' | head -1)"
  [[ "$appid" == "$PALIA_APPID" ]] && ok "Palia runs as pid $pid, started by Steam" \
    || warn "Palia runs as pid $pid but not with SteamAppId=$PALIA_APPID (started outside Steam?)"
  # Read 2 bytes ("MZ") of the game's main module the same way the app
  # reads the game: process_vm_readv.
  if python3 -I - "$pid" "$PALIA_EXE" <<'PY'
import ctypes, sys
pid, exe = int(sys.argv[1]), sys.argv[2].lower()
addr = None
with open(f"/proc/{pid}/maps") as f:
    for line in f:
        if line.rstrip().lower().endswith(exe):
            addr = int(line.split("-", 1)[0], 16)
            break
if addr is None:
    sys.exit(2)
class iovec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
buf = ctypes.create_string_buffer(2)
local, remote = iovec(ctypes.cast(buf, ctypes.c_void_p), 2), iovec(addr, 2)
libc = ctypes.CDLL(None, use_errno=True)
n = libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
sys.exit(0 if n == 2 and buf.raw == b"MZ" else 1)
PY
  then ok "the game's memory can be read (live mode should work)"
  else
    case $? in
      2) warn "game module not mapped yet (still loading?); try again in the main menu" ;;
      *) bad "reading the game's memory is not permitted: start Palia from Steam (not from a terminal or another launcher), and do not run Steam or the game as root" ;;
    esac
  fi
fi

echo "Display"
warn "use Palia in borderless/windowed fullscreen; exclusive fullscreen can hide the overlay"
if [[ "${XDG_CURRENT_DESKTOP:-}" == *KDE* ]]; then
  warn "KDE Plasma: if the overlay stays behind the game, set Palia to borderless, or add a KWin window rule for 'thgl-companion' with 'Keep above' (System Settings > Window Management > Window Rules)"
fi

echo
if (( fail )); then echo "Some checks failed, see FAIL above."; exit 1; fi
echo "Ready. Start the Companion App, then Palia through Steam."
