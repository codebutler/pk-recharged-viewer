#!/usr/bin/env python3
"""state_extract.py -- extract iwram.bin/ewram.bin from an mGBA GBA savestate.

Supported containers (format probed empirically against a simultaneous RAM dump,
see analysis/dumps/statepair/):

- PNG savestate (mGBA default, incl. GUI .ss0-.ss9 slot files): a PNG whose
  `gbAs` chunk is the zlib-compressed 0x61000-byte serialized state.
- Raw serialized state (0x61000 bytes, e.g. scripting saveStateFile without the
  screenshot flag).
- libretro mGBA-core .st* (e.g. MinUI handhelds): the 0x61000-byte serialized
  state followed by appended savedata/extra of core-dependent length. Detected
  by the state's version magic (u32 0x010000xx at +0) or the ROM title at +0x10;
  only the first 0x61000 bytes are used.

Within the 0x61000-byte GBA serialized state: IWRAM (0x8000 bytes) at +0x19000,
EWRAM (0x40000 bytes) at +0x21000 (verified byte-identical to a same-frame
emu:readRange dump).

Usage:
    python3 state_extract.py <savestate> [-o OUTDIR]

Writes OUTDIR/iwram.bin and OUTDIR/ewram.bin (default: alongside the state file,
in <state-basename>.ramdump/), then parse with:
    python3 parse_ram.py OUTDIR

Flash .sav files are NOT savestates and are out of scope.
"""

import argparse
import os
import struct
import sys
import zlib

STATE_SIZE = 0x61000
IWRAM_OFF, IWRAM_SIZE = 0x19000, 0x8000
EWRAM_OFF, EWRAM_SIZE = 0x21000, 0x40000
PNG_MAGIC = bytes.fromhex("89504e470d0a1a0a")


def deserialize(blob):
    """Return the raw 0x61000-byte serialized state from a savestate file blob."""
    if blob[:8] == PNG_MAGIC:
        off = 8
        while off + 12 <= len(blob):
            (length,) = struct.unpack_from(">I", blob, off)
            ctype = blob[off + 4:off + 8]
            if ctype == b"gbAs":
                state = zlib.decompress(blob[off + 8:off + 8 + length])
                if len(state) != STATE_SIZE:
                    raise ValueError(
                        "gbAs chunk decompressed to %#x bytes (expected %#x) -- "
                        "not a GBA savestate?" % (len(state), STATE_SIZE))
                return state
            off += 12 + length
        raise ValueError("PNG file has no gbAs chunk -- not an mGBA savestate")
    if len(blob) == STATE_SIZE:
        return blob
    if len(blob) > STATE_SIZE:
        # libretro-style container: serialized state first, appended extras after.
        # Verify it actually starts with a GBA state (version magic 0x010000xx, or
        # the 12-byte ROM title at +0x10) rather than blindly slicing.
        (magic,) = struct.unpack_from("<I", blob, 0)
        if (magic & 0xFFFF0000) == 0x01000000 or blob[0x10:0x1C] == b"POKEMON FIRE":
            return blob[:STATE_SIZE]
        raise ValueError(
            "file is larger than a GBA state (%#x > %#x) but does not start "
            "with an mGBA state header" % (len(blob), STATE_SIZE))
    raise ValueError(
        "unrecognized savestate: not a PNG and smaller than %#x bytes (got %#x). "
        "Note: flash .sav files are not savestates." % (STATE_SIZE, len(blob)))


def extract(state_path, out_dir=None):
    with open(state_path, "rb") as f:
        blob = f.read()
    state = deserialize(blob)
    if out_dir is None:
        base = os.path.splitext(os.path.basename(state_path))[0]
        out_dir = os.path.join(os.path.dirname(os.path.abspath(state_path)),
                               base + ".ramdump")
    os.makedirs(out_dir, exist_ok=True)
    iwram = state[IWRAM_OFF:IWRAM_OFF + IWRAM_SIZE]
    ewram = state[EWRAM_OFF:EWRAM_OFF + EWRAM_SIZE]
    if not any(iwram):
        sys.stderr.write("warning: IWRAM is all zero -- savestate may be invalid "
                         "or from a just-reset system\n")
    with open(os.path.join(out_dir, "iwram.bin"), "wb") as f:
        f.write(iwram)
    with open(os.path.join(out_dir, "ewram.bin"), "wb") as f:
        f.write(ewram)
    return out_dir


def main():
    ap = argparse.ArgumentParser(
        description="Extract iwram.bin/ewram.bin from an mGBA GBA savestate.")
    ap.add_argument("state", help="savestate file (PNG or raw 0x61000-byte state)")
    ap.add_argument("-o", "--out", help="output directory (default: <state>.ramdump/)")
    args = ap.parse_args()
    out_dir = extract(args.state, args.out)
    print(out_dir)


if __name__ == "__main__":
    main()
