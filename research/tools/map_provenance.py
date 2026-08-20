#!/usr/bin/env python3
"""map_provenance.py -- where did Recharged Yellow's maps come from?

Gen 3 stores a map layout as an uncompressed u16 array of block ids, one per
8x8-block cell, which means a decomp's `data/layouts/<Map>/map.bin` can be
searched for verbatim inside a ROM image. That makes map provenance directly
testable rather than a matter of inference.

    python3 research/tools/map_provenance.py \
        --rom "local/Pokemon Recharged Yellow.gba" \
        --control "local/Pokemon - Emerald Version (USA, Europe).gba"

Two measurements per layout:

  exact       the whole map.bin appears verbatim in the ROM -> copied untouched
  containment fraction of the map's 16-byte (8-block) fragments that appear
              anywhere in the ROM -> survives editing, so it separates "edited
              copy" from "never present"

`--control` is not optional in spirit: short and repetitive maps match by
chance, so every figure is reported next to the same measurement against a ROM
the maps are known NOT to come from. Copied maps run 55-98% containment against
a control floor of 0-5%.

Stdlib only, like the rest of the research tooling.
"""

import argparse
import glob
import json
import os

WINDOW = 16       # bytes per fragment: 8 map blocks
MAX_SAMPLES = 200  # fragments probed per layout, evenly spaced
MIN_SIZE = 256    # smaller layouts collide by chance too often to report


def layouts(tree):
    out = {}
    for p in sorted(glob.glob(f'vendor/{tree}/data/layouts/*/map.bin')):
        b = open(p, 'rb').read()
        if len(b) >= MIN_SIZE:
            out[os.path.basename(os.path.dirname(p))] = b
    return out


def containment(rom, blob):
    wins = [blob[i:i+WINDOW] for i in range(0, len(blob) - WINDOW + 1, 2)]
    if not wins:
        return 0.0
    step = max(1, len(wins) // MAX_SAMPLES)
    probes = wins[::step]
    return sum(1 for w in probes if rom.find(w) >= 0) / len(probes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rom', required=True)
    ap.add_argument('--control', required=True)
    ap.add_argument('--tree', default='pokefirered')
    ap.add_argument('--json')
    args = ap.parse_args()

    rom = open(args.rom, 'rb').read()
    ctrl = open(args.control, 'rb').read()
    maps = layouts(args.tree)

    rows = []
    for name, b in maps.items():
        at = rom.find(b)
        rows.append({'map': name, 'blocks': len(b) // 2,
                     'exact': at if at >= 0 else None,
                     'containment': round(containment(rom, b), 3),
                     'control': round(containment(ctrl, b), 3)})

    exact = [r for r in rows if r['exact'] is not None]
    edited = [r for r in rows if r['exact'] is None and r['containment'] >= 0.40]
    absent = [r for r in rows if r['exact'] is None and r['containment'] < 0.40]
    print(f"{args.tree} layouts >= {MIN_SIZE} bytes: {len(rows)}")
    print(f"  copied verbatim : {len(exact):4d}  ({len(exact)*100//len(rows)}%)")
    print(f"  edited copy     : {len(edited):4d}  ({len(edited)*100//len(rows)}%)")
    print(f"  not present     : {len(absent):4d}  ({len(absent)*100//len(rows)}%)")
    if exact:
        lo = min(r['exact'] for r in exact); hi = max(r['exact'] for r in exact)
        print(f"  verbatim layouts occupy {0x08000000+lo:#x} .. {0x08000000+hi:#x}")
    cmax = max(r['control'] for r in rows)
    print(f"  control containment: max {cmax:.0%}, mean "
          f"{sum(r['control'] for r in rows)/len(rows):.0%}")
    if args.json:
        json.dump(rows, open(args.json, 'w'), indent=1)


main()
