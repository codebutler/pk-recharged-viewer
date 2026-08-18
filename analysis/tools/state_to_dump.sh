#!/bin/bash
# state_to_dump.sh — convert an mGBA savestate to iwram.bin/ewram.bin by loading
# it in mGBA (0.11 nightly) and dumping RAM. Fallback for states that
# state_extract.py cannot parse; state_extract.py is instant and needs no
# emulator, so try it first.
#
# Usage: state_to_dump.sh <rom.gba> <savestate> <outdir>
#
# Then: python3 parse_ram.py <outdir>

set -euo pipefail

ROM=${1:?usage: state_to_dump.sh <rom.gba> <savestate> <outdir>}
STATE=${2:?missing savestate}
OUT_DIR=${3:?missing outdir}

TOOLS=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$TOOLS/mgba_state_dump.lua"

MGBA_BIN=${MGBA_BIN:-}
if [[ -z "$MGBA_BIN" ]]; then
  for cand in "/Applications/mGBA-nightly.app/Contents/MacOS/mGBA" \
              "$HOME/Applications/mGBA-nightly.app/Contents/MacOS/mGBA"; do
    [[ -x "$cand" ]] && MGBA_BIN=$cand && break
  done
fi
if [[ -z "$MGBA_BIN" ]] || ! "$MGBA_BIN" --help 2>/dev/null | grep -q -- --script; then
  echo "error: need an mGBA build with --script (0.11 nightly); see README.md" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
# The ROM copy lives inside OUT_DIR, and mGBA silently skips --script for ROMs
# under /var/folders (macOS mktemp default) -- refuse early instead of hanging.
if [[ "$OUT_DIR" == /var/folders/* || "$OUT_DIR" == /private/var/folders/* ]]; then
  echo "error: outdir is under /var/folders, where mGBA silently ignores --script." >&2
  echo "Pick an outdir on a normal path (see tools/README.md)." >&2
  exit 1
fi
# mGBA silently skips --script when the ROM is under /var/folders; keep the ROM
# copy (and the .sav mGBA creates) inside the output dir.
WORK="$OUT_DIR/work"
mkdir -p "$WORK"
cp "$ROM" "$WORK/rom.gba"

export HARNESS_OUT_DIR="$OUT_DIR"
export HARNESS_STATE="$(cd "$(dirname "$STATE")" && pwd)/$(basename "$STATE")"

rm -f "$OUT_DIR/DONE"
"$MGBA_BIN" -C audio.mute=1 --script "$SCRIPT" "$WORK/rom.gba" &
MGBA_PID=$!

for ((i = 0; i < 60; i++)); do
  [[ -f "$OUT_DIR/DONE" ]] && break
  kill -0 "$MGBA_PID" 2>/dev/null || break
  sleep 1
done
kill "$MGBA_PID" 2>/dev/null || true
wait "$MGBA_PID" 2>/dev/null || true

if [[ -f "$OUT_DIR/DONE" ]] && grep -q "ok=true" "$OUT_DIR/DONE"; then
  echo "OK: $OUT_DIR/iwram.bin + ewram.bin"
else
  echo "FAILED; see $OUT_DIR/harness.log" >&2
  exit 2
fi
