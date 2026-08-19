"""gba_map.py -- render pokeemerald-engine map terrain from the ROM.

Format facts, cross-checked between the hack-offsets map_rendering spec and
pixel-exact empirical validation (the bedroom render matches the live
screen.png byte-for-byte in layout):

- gMapGroups: array of pointers to per-group arrays of MapHeader pointers
  (@0x08B3F134, ROM-verified).
- MapHeader: mapLayout* at +0, mapLayoutId u16 at +0x12.
- MapLayout: s32 width, s32 height, border*, blockdata*, primaryTileset*,
  secondaryTileset*.
- Blockdata: width*height u16, bits 0-9 metatileId, 10-11 collision,
  12-15 elevation (spec-confirmed vanilla).
- Tileset struct: FRLG field order (spec-confirmed): isCompressed u8 (nonzero
  = LZ77), isSecondary u8, pad, tiles* @+4, palettes* @+8, metatiles* @+0xC,
  callback @+0x10, metatileAttributes @+0x14. (Only the first three pointers
  are read here.)
- Metatiles: 3-LAYER, 12 u16 each (three layers x 4 quads TL/TR/BL/BR),
  24-byte stride. Code-proven (rom-fingerprint reconciliation): the metatile
  copy routine at 0x0816364A computes [tileset+0xC] + id*24 and copies 24
  bytes; Celadon's attrs-minus-metatiles spans are exactly 0x280*24 (primary)
  and 240*24 (secondary). Also pixel-proven against the live bedroom capture.
- Splits: 640 primary tiles (tileId >= 640 -> secondary). Metatile
  primary/secondary boundary AND secondary index base = 0x280: the attribute
  readers (0x081088E2 etc.) compose 0x280 inline (movs #0xA0; lsls #2),
  branch ids >= 0x280 to the secondary tileset with index id-0x280, and
  return 0xFF for ids >= 0x400. Pixel-proven too (bedroom ids up to 0x297).
- Metatile attributes: u32 each at [tileset+0x14] (behavior/terrain bits;
  not needed for terrain rendering -- collision lives in blockdata bits
  10-11). Available if walkability overlays are ever wanted.
- Palettes: FRLG split (spec-confirmed): slots 0-6 from the primary tileset's
  palette block, 7-12 from the secondary's (its 0-6 are dummies; absolute
  indexing handles this).
- Rendering: color 0 transparent on ALL layers over a black backdrop
  (porymap-style); 16x16 px per metatile. ROM palettes are DAY colors -- the
  hack tints at night at runtime (the page applies a labeled CSS tint).

Stdlib only; uses gba_gfx primitives.
"""

import struct

import gba_gfx

ROM_BASE = 0x08000000
GMAP_GROUPS = 0x08B3F134
# FRLG-style tileset split (empirically the right one for this hack: with the
# Emerald split, Celadon's secondary metatiles/tiles render black). Adjustable
# if the map_rendering spec says otherwise.
NUM_PALS_IN_PRIMARY = 7
NUM_TILES_IN_PRIMARY = 640
NUM_METATILES_IN_PRIMARY = 0x280
METATILE_STRIDE = 24
METATILE_LAYERS = 3


def _off(rom, ptr):
    o = ptr - ROM_BASE
    if not (0 <= o < len(rom)):
        raise ValueError("pointer 0x%08X outside ROM" % ptr)
    return o


def _u32(rom, off):
    return struct.unpack_from("<I", rom, off)[0]


def _load_tileset(rom, ts_ptr):
    """Return (gfx bytes, palettes bytes, metatiles offset)."""
    ts = _off(rom, ts_ptr)
    compressed = rom[ts]
    gfx_ptr, pal_ptr, meta_ptr = struct.unpack_from("<III", rom, ts + 4)
    if compressed:
        gfx = gba_gfx.lz77_decompress(rom, _off(rom, gfx_ptr))
    else:
        o = _off(rom, gfx_ptr)
        gfx = rom[o:o + NUM_TILES_IN_PRIMARY * 32]
    pals = rom[_off(rom, pal_ptr):_off(rom, pal_ptr) + 16 * 32]
    return gfx, pals, _off(rom, meta_ptr)


def map_type(rom, group, num):
    """MapHeader.mapType (u8 at +0x17): 1=town 2=city 3=route 5/6=water routes,
    8=indoor, 4=underground, 9=secret base."""
    grp_ptr = _u32(rom, _off(rom, GMAP_GROUPS) + group * 4)
    hdr = _off(rom, _u32(rom, _off(rom, grp_ptr) + num * 4))
    return rom[hdr + 0x17]


def map_render(rom, group, num):
    """Render the terrain of map (group, num). Returns (pixels, width_px,
    height_px, width_metatiles, height_metatiles); pixels is a row-major RGBA
    list suitable for gba_gfx.rgba_to_png."""
    grp_ptr = _u32(rom, _off(rom, GMAP_GROUPS) + group * 4)
    hdr_ptr = _u32(rom, _off(rom, grp_ptr) + num * 4)
    layout_ptr = _u32(rom, _off(rom, hdr_ptr))
    lay = _off(rom, layout_ptr)
    width, height = struct.unpack_from("<ii", rom, lay)
    if not (1 <= width <= 300 and 1 <= height <= 300):
        raise ValueError("implausible map size %dx%d" % (width, height))
    blocks = _off(rom, _u32(rom, lay + 12))
    prim_gfx, prim_pals, prim_meta = _load_tileset(rom, _u32(rom, lay + 16))
    sec_gfx, sec_pals, sec_meta = _load_tileset(rom, _u32(rom, lay + 20))

    # palette slots: 0-5 primary, 6-12 secondary
    palettes = []
    for i in range(16):
        src = prim_pals if i < NUM_PALS_IN_PRIMARY else sec_pals
        palettes.append(gba_gfx.decode_palette(src[i * 32:(i + 1) * 32]))

    def tile_pixels(tid):
        gfx = prim_gfx if tid < NUM_TILES_IN_PRIMARY else sec_gfx
        base = (tid if tid < NUM_TILES_IN_PRIMARY
                else tid - NUM_TILES_IN_PRIMARY) * 32
        t = gfx[base:base + 32]
        if len(t) < 32:
            t = t + b"\0" * (32 - len(t))
        out = []
        for b in t:
            out.append(b & 0xF)
            out.append(b >> 4)
        return out

    W, H = width * 16, height * 16
    px = [(0, 0, 0, 255)] * (W * H)
    tile_cache = {}
    for my in range(height):
        for mx in range(width):
            block = struct.unpack_from("<H", rom, blocks + (my * width + mx) * 2)[0]
            mid = block & 0x3FF
            meta = prim_meta if mid < NUM_METATILES_IN_PRIMARY else sec_meta
            mbase = meta + (mid if mid < NUM_METATILES_IN_PRIMARY
                            else mid - NUM_METATILES_IN_PRIMARY) * METATILE_STRIDE
            for layer in range(METATILE_LAYERS):
                for quad in range(4):
                    ent = struct.unpack_from("<H", rom,
                                             mbase + (layer * 4 + quad) * 2)[0]
                    tid = ent & 0x3FF
                    hf, vf, pal = ent & 0x400, ent & 0x800, ent >> 12
                    if tid not in tile_cache:
                        tile_cache[tid] = tile_pixels(tid)
                    tp = tile_cache[tid]
                    ox = mx * 16 + (quad % 2) * 8
                    oy = my * 16 + (quad // 2) * 8
                    palette = palettes[pal]
                    for i in range(64):
                        c = tp[i]
                        # Color 0 is transparent on BOTH layers (porymap-style
                        # compositing over the black backdrop): FRLG-style
                        # metatiles freely put their art in either layer.
                        if c == 0:
                            continue
                        x = i % 8
                        y = i // 8
                        if hf:
                            x = 7 - x
                        if vf:
                            y = 7 - y
                        px[(oy + y) * W + ox + x] = palette[c]
    return px, W, H, width, height


def crop(px, W, H, x0_px, y0_px, w_px, h_px):
    """Crop a row-major RGBA pixel list; clamps to the image bounds."""
    x0 = max(0, min(x0_px, W - w_px))
    y0 = max(0, min(y0_px, H - h_px))
    w = min(w_px, W)
    h = min(h_px, H)
    out = [px[(y0 + y) * W + x0 + x] for y in range(h) for x in range(w)]
    return out, w, h, x0, y0


def mark_tile(px, W, H, tx, ty, color=(248, 56, 40, 255), thickness=2):
    """Draw a 16x16 rectangle outline around metatile (tx, ty), in place."""
    x0, y0 = tx * 16, ty * 16
    for t in range(thickness):
        for x in range(x0, min(x0 + 16, W)):
            for y in (y0 + t, y0 + 15 - t):
                if 0 <= y < H:
                    px[y * W + x] = color
        for y in range(y0, min(y0 + 16, H)):
            for x in (x0 + t, x0 + 15 - t):
                if 0 <= x < W:
                    px[y * W + x] = color
