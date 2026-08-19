#!/bin/bash
# run_harness.sh — drive mGBA headless-ish to produce RAM dumps of the ROM.
#
# Usage: run_harness.sh <rom.gba> <label> [max_frames] [period] [input(1|0)]
#
#   <rom.gba>    path to the ROM (it is COPIED to a work dir so the .sav that
#                mGBA creates never lands next to the original)
#   <label>      dumps go to research/dumps/<label>/
#   max_frames   frames to emulate before finishing (default 20000, ~5.5 game-min)
#   period       frames between periodic dumps (default 600)
#   input        1 = spam A/Start to advance the game (default), 0 = hands-off
#
# Requires the mGBA 0.11 nightly (has --script); see README.md. Set MGBA_BIN to
# override the binary location. A GUI window appears during the run; the script
# kills mGBA when the Lua harness writes its DONE marker or on timeout.

set -euo pipefail

ROM=${1:?usage: run_harness.sh <rom.gba> <label> [max_frames] [period] [input]}
LABEL=${2:?missing label}
MAX_FRAMES=${3:-20000}
PERIOD=${4:-600}
INPUT=${5:-1}

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT_DIR="$REPO_ROOT/research/dumps/$LABEL"
# HARNESS_SCRIPT overrides which Lua harness runs (e.g. mgba_walk_harness.lua)
SCRIPT=${HARNESS_SCRIPT:-"$REPO_ROOT/research/tools/mgba_dump_harness.lua"}

MGBA_BIN=${MGBA_BIN:-}
if [[ -z "$MGBA_BIN" ]]; then
  for cand in "/Applications/mGBA-nightly.app/Contents/MacOS/mGBA" \
              "$HOME/Applications/mGBA-nightly.app/Contents/MacOS/mGBA"; do
    [[ -x "$cand" ]] && MGBA_BIN=$cand && break
  done
fi
if [[ -z "$MGBA_BIN" ]] || ! "$MGBA_BIN" --help 2>/dev/null | grep -q -- --script; then
  echo "error: need an mGBA build with --script (0.11 nightly)." >&2
  echo "Install: curl -L -o /tmp/mgba.dmg https://s3.amazonaws.com/mgba/mGBA-build-latest-macos.dmg" >&2
  echo "then mount and copy mGBA.app to /Applications/mGBA-nightly.app, or set MGBA_BIN." >&2
  exit 1
fi

# Work dir lives inside OUT_DIR: mGBA silently fails to run --script when the
# ROM sits under /var/folders (mktemp default), and this also keeps the .sav
# with the dumps for reproducibility.
WORK="$OUT_DIR/work"
mkdir -p "$WORK"
cp "$ROM" "$WORK/rom.gba"

export HARNESS_OUT_DIR="$OUT_DIR"
export HARNESS_MAX_FRAMES="$MAX_FRAMES"
export HARNESS_PERIOD="$PERIOD"
export HARNESS_INPUT="$INPUT"

echo "mGBA:   $MGBA_BIN"
echo "out:    $OUT_DIR"
echo "frames: $MAX_FRAMES (dump every $PERIOD), input=$INPUT"

rm -f "$OUT_DIR/DONE"
"$MGBA_BIN" -C audio.mute=1 --script "$SCRIPT" "$WORK/rom.gba" &
MGBA_PID=$!

# Wall-clock budget: frames/60 plus generous slack for dump I/O and startup.
TIMEOUT=$(( MAX_FRAMES / 60 + 120 ))
for ((i = 0; i < TIMEOUT; i++)); do
  [[ -f "$OUT_DIR/DONE" ]] && break
  kill -0 "$MGBA_PID" 2>/dev/null || break
  sleep 1
done

kill "$MGBA_PID" 2>/dev/null || true
wait "$MGBA_PID" 2>/dev/null || true

if [[ -f "$OUT_DIR/DONE" ]]; then
  echo "DONE. Final pointers:"
  cat "$OUT_DIR/final/pointers.txt"
else
  echo "TIMED OUT or mGBA exited early; partial dumps (if any) are in $OUT_DIR" >&2
  exit 2
fi
