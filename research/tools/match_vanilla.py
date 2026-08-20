#!/usr/bin/env python3
"""match_vanilla.py -- how much of a target GBA ROM is verbatim pokeemerald?

Fingerprints every function of a locally built pokeemerald reference and looks
for it in a target ROM, so the Recharged Yellow ROM can be split into "code we
already have the source for" and "code that is the hack's own".

Building the reference (needs a bare-metal ARM toolchain *with newlib* --
Homebrew's arm-none-eabi-gcc ships without one; ARM's own release works):

    PATH=/path/to/arm-gnu-toolchain/bin:$PATH make -C vendor/pokeemerald MODERN=1 -j10
    arm-none-eabi-nm --print-size --radix=x \
        vendor/pokeemerald/pokeemerald_modern.elf > ref-syms.txt

    python3 research/tools/match_vanilla.py \
        --ref vendor/pokeemerald/pokeemerald_modern.gba --syms ref-syms.txt \
        --target "local/Pokemon Recharged Yellow.gba"

The fingerprint is Thumb halfwords with two allowances, which is what makes a
relocated function still compare equal:

  * BL/BLX halfword pairs are masked -- every call target moved when the hack
    relinked, but the *call graph shape* did not.
  * 4-byte-aligned words that look like GBA pointers (0x02xxxxxx-0x09xxxxxx) are
    wildcards. These are literal-pool entries; their values are addresses, which
    all moved.

Everything else must match exactly, which is the point: the negative control
(retail Emerald -- same source, compiled with agbcc instead of gcc) scores 0.7%,
so a hit means the same compiler emitted the same code, not merely similar code.

Stdlib only, like the rest of the research tooling.
"""

import argparse
import json
from collections import defaultdict

BASE = 0x08000000
KEY_HW = 6              # halfwords per index key
MIN_HW = 6              # shorter functions collide too often to index
OFFSETS = (0, 4, 8, 12)  # key windows, so an edited prologue still finds a hit
ACCEPT = 0.10           # max mismatch ratio over non-wildcard halfwords


def normalize(buf):
    """Mask BL/BLX pairs so relocated call targets compare equal."""
    nb = bytearray(buf)
    mv = memoryview(nb).cast('H')
    for i in range(len(mv) - 1):
        if 0xF000 <= mv[i] <= 0xF7FF and 0xF800 <= mv[i + 1] <= 0xFFFF:
            mv[i] = 0xF000
            mv[i + 1] = 0xF800
    return nb


def ptr_wildcards(buf, off, nhw):
    """Halfword indices covering pointer-looking words -- i.e. literal pools."""
    wc = bytearray(nhw)
    start = off if off % 4 == 0 else off + 2
    for a in range(start, off + nhw * 2 - 3, 4):
        if 0x02000000 <= int.from_bytes(buf[a:a + 4], 'little') < 0x0A000000:
            k = (a - off) // 2
            wc[k] = 1
            if k + 1 < nhw:
                wc[k + 1] = 1
    return wc


def load_functions(symfile, reflen):
    funcs = []
    for line in open(symfile):
        p = line.split()
        if len(p) == 4 and p[2] in ('t', 'T'):
            off = int(p[0], 16) - BASE
            size = int(p[1], 16)
            if 0 <= off and size >= MIN_HW * 2 and off + size <= reflen:
                funcs.append({'name': p[3], 'off': off, 'size': size})
    return funcs


def match(ref, tgt, funcs):
    refn, tgtn = normalize(ref), normalize(tgt)
    refh = memoryview(refn).cast('H')
    tgth = memoryview(tgtn).cast('H')

    index = defaultdict(list)
    for i, f in enumerate(funcs):
        f['wc'] = ptr_wildcards(ref, f['off'], f['size'] // 2)
        for o in OFFSETS:
            if o + KEY_HW > f['size'] // 2:
                break
            a = f['off'] + o * 2
            index[bytes(refn[a:a + KEY_HW * 2])].append((i, o))

    accepted = defaultdict(list)
    keylen = KEY_HW * 2
    for pos in range(0, len(tgtn) - keylen, 2):
        cands = index.get(bytes(tgtn[pos:pos + keylen]))
        if not cands:
            continue
        for ci, o in cands:
            f = funcs[ci]
            start = pos - o * 2
            if start < 0 or start + f['size'] > len(tgtn):
                continue
            nhw = f['size'] // 2
            wc = f['wc']
            ra, ha = f['off'] // 2, start // 2
            tot = mis = 0
            for k in range(nhw):
                if wc[k]:
                    continue
                tot += 1
                if refh[ra + k] != tgth[ha + k]:
                    mis += 1
            if tot and mis / tot <= ACCEPT:
                accepted[ci].append((mis / tot, start))
    return accepted


def merge(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True, help='pokeemerald_modern.gba')
    ap.add_argument('--syms', required=True, help='nm --print-size output for the reference ELF')
    ap.add_argument('--target', required=True, help='ROM to measure')
    ap.add_argument('--json', help='write full results here')
    args = ap.parse_args()

    ref = bytearray(open(args.ref, 'rb').read())
    tgt = bytearray(open(args.target, 'rb').read())
    funcs = load_functions(args.syms, len(ref))
    accepted = match(ref, tgt, funcs)

    merged = merge([(pos, pos + funcs[ci]['size'])
                    for ci, lst in accepted.items() for _, pos in lst])
    # The code region ends at the largest gap: past the last real function the
    # rest of the image is data, and nothing matches there.
    gaps = sorted(((merged[i + 1][0] - merged[i][1], merged[i][1])
                   for i in range(len(merged) - 1)), reverse=True)
    code_end = gaps[0][1] if gaps else merged[-1][1]
    covered = sum(b - a for a, b in merged if a < code_end)
    ref_bytes = sum(f['size'] for f in funcs)
    hit_bytes = sum(funcs[ci]['size'] for ci in accepted)

    print(f"target: {args.target}")
    print(f"  reference functions   {len(funcs):6d}   {ref_bytes:9,d} bytes")
    print(f"  found in target       {len(accepted):6d}   {hit_bytes:9,d} bytes"
          f"   ({len(accepted) * 100 / len(funcs):.1f}% of functions)")
    print(f"  target code region    {BASE:#x}..{BASE + code_end:#010x}   {code_end:9,d} bytes")
    print(f"    vanilla             {covered * 100 / code_end:5.1f}%   {covered:9,d} bytes")
    print(f"    unattributed        {(code_end - covered) * 100 / code_end:5.1f}%   {code_end - covered:9,d} bytes")

    if args.json:
        json.dump({'target': args.target, 'code_end': code_end, 'covered': covered,
                   'ref_funcs': len(funcs), 'ref_bytes': ref_bytes,
                   'matched_funcs': len(accepted), 'matched_bytes': hit_bytes,
                   'intervals': merged,
                   'matches': {funcs[ci]['name']: [BASE + lst[0][1], round(lst[0][0], 4)]
                               for ci, lst in accepted.items()},
                   'unmatched': [f['name'] for i, f in enumerate(funcs) if i not in accepted]},
                  open(args.json, 'w'), indent=1)


main()
