"""verify_python.py -- reference RGBA dumps from the Python rasterizer.

Renders the same cases as verify.js using research/tools/gba_gfx.py,
gba_map.py and rom_gfx.py, writes them as raw RGBA (py_<name>.rgba),
then byte-compares against the js_<name>.rgba files already in the directory.

Usage:  python3 lib/gfx/verify_python.py [outDir]
        python3 lib/gfx/verify_python.py --assets <assetsDir> [sampleCount]

The --assets mode decodes the PNGs written by tools/extract-rom-assets.js
and compares their pixels against fresh Python renders, which checks the
Bun-side PNG encoder (adaptive filtering, alpha dropping) as well as the
rasterizer.
"""

import os
import struct
import sys
import zlib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "research", "tools"))

import gba_gfx  # noqa: E402
import gba_map  # noqa: E402
import rom_gfx as gp  # noqa: E402

def decode_png(path):
    """Minimal PNG reader for what encodePNG writes: 8-bit truecolour with or
    without alpha, adaptive per-row filters. Returns (pixels, w, h) with
    pixels as (r, g, b, a) tuples."""
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG: %s" % path
    pos, idat, w = 8, bytearray(), None
    while pos < len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack_from(">IIBB", body, 0)
            assert depth == 8 and ctype in (2, 6), "unsupported PNG %d/%d" % (depth, ctype)
        elif tag == b"IDAT":
            idat += body
        pos += 12 + length
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(bytes(idat))
    stride = w * bpp
    out, prev = [], bytearray(stride)
    for y in range(h):
        ft = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if ft == 1:
                line[i] = (line[i] + a) & 0xFF
            elif ft == 2:
                line[i] = (line[i] + b) & 0xFF
            elif ft == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        for x in range(w):
            px = line[x * bpp:x * bpp + bpp]
            out.append((px[0], px[1], px[2], 255 if bpp == 3 else px[3]))
        prev = line
    return out, w, h


def verify_assets(assets_dir, sample=8):
    """Decode exported PNGs and compare against fresh Python renders."""
    import json
    import random
    with open(os.path.join(assets_dir, "data", "manifest.json")) as f:
        manifest = json.load(f)
    rom = gp.load_rom()
    bad = 0
    checked = 0

    # sample: an int (that many random layouts), "all", or a list of
    # "group,num" map keys to check by name.
    layouts = list(manifest["mapLayouts"].items())
    if isinstance(sample, list):
        chosen = []
        for key in sample:
            layout_id = str(manifest["maps"][key]["layout"])
            chosen.append((layout_id, manifest["mapLayouts"][layout_id],
                           manifest["maps"][key]["name"], key))
    else:
        random.Random(0).shuffle(layouts)
        picked = layouts if sample == "all" else layouts[:sample]
        chosen = [(lid, info, "", "") for lid, info in picked]

    for layout_id, info, label, key in chosen:
        g, n = info["source"]
        px, W, H, _, _ = gba_map.map_render(rom, g, n)
        got, gw, gh = decode_png(os.path.join(assets_dir, "maps",
                                              "%s.png" % layout_id))
        ok = (gw, gh) == (W, H) and got == px
        if not ok:
            diff = sum(1 for i in range(min(len(got), len(px))) if got[i] != px[i])
            note = "DIFF %d/%d px (exported %dx%d, python %dx%d)" % (
                diff, len(px), gw, gh, W, H)
        else:
            note = "match"
        print("map layout %-5s %-9s %-26s %4dx%-4d %s"
              % (layout_id, key or "(%d,%d)" % (g, n), label, W, H, note))
        bad += not ok
        checked += 1

    sheet = gba_gfx.lz77_decompress(rom, gp._rom_off(rom, gp.BADGE_SHEET_LZ))
    pal_off = gp._rom_off(rom, gp.BADGE_PALETTE)
    badge_pal = gba_gfx.decode_palette(rom[pal_off:pal_off + 32])
    for i in range(8):
        tiles = b"".join(sheet[t * 32:(t + 1) * 32]
                         for t in (2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i))
        want, _, _ = gba_gfx.tiles_to_pixels(tiles, badge_pal, 2, 2)
        got, _, _ = decode_png(os.path.join(assets_dir, "badges", "%d.png" % (i + 1)))
        bad += got != want
        checked += 1

    for facing in ("down", "up", "left", "right"):
        want, _, _ = gp.object_sprite_pixels(rom, 0, facing)
        got, _, _ = decode_png(os.path.join(assets_dir, "overworld",
                                            "player-%s.png" % facing))
        bad += got != want
        checked += 1
        want, _, _ = gp.object_sprite_pixels(rom, 1, facing)
        got, _, _ = decode_png(os.path.join(assets_dir, "overworld",
                                            "player-bike-%s.png" % facing))
        bad += got != want
        checked += 1

    for species in (1, 25, 151, 411):
        want, _, _ = gp.mon_sprite_pixels(rom, species, "down")
        got, _, _ = decode_png(os.path.join(assets_dir, "overworld", "mon",
                                            "%d.png" % species))
        bad += got != want
        checked += 1
        want, _, _ = gp.mon_sprite_pixels(rom, species, "right")
        got, _, _ = decode_png(os.path.join(assets_dir, "overworld", "mon",
                                            "%d-right.png" % species))
        bad += got != want
        checked += 1

    print("\n%d/%d exported assets match the Python render" % (checked - bad, checked))
    return 1 if bad else 0


if len(sys.argv) > 1 and sys.argv[1] == "--assets":
    import gba_gfx  # noqa: E402,F811
    import gba_map  # noqa: E402,F811
    import rom_gfx as gp  # noqa: E402,F811
    arg = sys.argv[3] if len(sys.argv) > 3 else "8"
    if arg == "all":
        which = "all"
    elif "," in arg:
        which = arg.split(";")  # e.g. "3,6;4,1;1,1"
    else:
        which = int(arg)
    sys.exit(verify_assets(sys.argv[2], which))

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, ".gfx-verify")
CELADON = (3, 6)
PLAYER_TILE = (24, 20)
CLOCK = {"hour": 21, "minute": 16}

rom = gp.load_rom()
results = []


def emit(name, pixels, w, h):
    raw = bytearray()
    for p in pixels:
        raw.extend(p)
    with open(os.path.join(OUT, "py_%s.rgba" % name), "wb") as f:
        f.write(raw)
    js_path = os.path.join(OUT, "js_%s.rgba" % name)
    if not os.path.exists(js_path):
        results.append((name, "MISSING js dump"))
        return
    with open(js_path, "rb") as f:
        js = f.read()
    if js == bytes(raw):
        results.append((name, "match (%dx%d)" % (w, h)))
    else:
        diffs = sum(1 for i in range(min(len(js), len(raw))) if js[i] != raw[i])
        results.append((name, "DIFF %d/%d bytes (len js=%d py=%d)"
                        % (diffs, len(raw), len(js), len(raw))))


px, W, H, wm, hm = gba_map.map_render(rom, *CELADON)
emit("celadon_day", px, W, H)
cpx, cw, ch, _, _ = gba_map.crop(px, W, H, (PLAYER_TILE[0] - 7) * 16,
                                 (PLAYER_TILE[1] - 4) * 16, 15 * 16, 10 * 16)
emit("celadon_day_crop", cpx, cw, ch)

chip, coeffs = gp.dns_phase(CLOCK)
outdoor = gba_map.map_type(rom, *CELADON) in (1, 2, 3, 5, 6)
tinted = px
if outdoor and coeffs:
    rs, gs, bs = coeffs
    tinted = [(int(r * rs), int(g * gs), int(b * bs), a) for r, g, b, a in px]
emit("celadon_2116", tinted, W, H)

for facing in ("down", "up", "left", "right"):
    p, w, h = gp.object_sprite_pixels(rom, 0, facing)
    emit("player_%s" % facing, p, w, h)

for facing in ("down", "right"):
    p, w, h = gp.mon_sprite_pixels(rom, 25, facing)
    emit("pikachu_%s" % facing, p, w, h)

sheet = gba_gfx.lz77_decompress(rom, gp._rom_off(rom, gp.BADGE_SHEET_LZ))
pal_off = gp._rom_off(rom, gp.BADGE_PALETTE)
badge_pal = gba_gfx.decode_palette(rom[pal_off:pal_off + 32])
for i in range(8):
    tiles = b"".join(sheet[t * 32:(t + 1) * 32]
                     for t in (2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i))
    p, w, h = gba_gfx.tiles_to_pixels(tiles, badge_pal, 2, 2)
    emit("badge_%d" % (i + 1), p, w, h)

scene = list(tinted)
tx, ty = PLAYER_TILE
sp, sw, sh = gp.object_sprite_pixels(rom, 0, "down")
gba_gfx.composite(scene, W, H, sp, sw, sh, tx * 16 + (16 - sw) // 2,
                  (ty + 1) * 16 - sh)
fp, fw, fh = gp.mon_sprite_pixels(rom, 25, "down")
gba_gfx.composite(scene, W, H, fp, fw, fh, (tx - 1) * 16 + (16 - fw) // 2,
                  (ty + 1) * 16 - fh)
spx, sw2, sh2, _, _ = gba_map.crop(scene, W, H, (tx - 7) * 16, (ty - 4) * 16,
                                   15 * 16, 10 * 16)
emit("celadon_scene_crop", spx, sw2, sh2)

bad = [r for r in results if not r[1].startswith("match")]
for name, msg in results:
    print("%-22s %s" % (name, msg))
print("\n%d/%d cases match" % (len(results) - len(bad), len(results)))
sys.exit(1 if bad else 0)
