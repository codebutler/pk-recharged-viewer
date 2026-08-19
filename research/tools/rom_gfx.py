"""rom_gfx.py -- ROM graphics primitives shared by the verification tools.

Extracted verbatim from the retired generate_page.py (the Jinja2 page generator
the browser app replaced). These pieces have nothing to do with page rendering:
they are the ROM lookups that turn a species or object-event graphics id into
pixels, plus the day/night tint phase. lib/gfx/verify_python.py renders these as
the reference the JS rasterizer in lib/gfx is diffed against.

Stdlib only; uses gba_gfx primitives. ROMs live in local/ (gitignored).
"""

import os

import gba_gfx

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
RESEARCH_DIR = os.path.dirname(TOOLS_DIR)
REPO_ROOT = os.path.dirname(RESEARCH_DIR)


def u32(b, o=0):
    return int.from_bytes(b[o:o + 4], "little")


def u16(b, o=0):
    return int.from_bytes(b[o:o + 2], "little")

# --- ROM tables ------------------------------------------------------
OBJ_GFX_INFO_PTRS = 0x0887EE9C   # gObjectEventGraphicsInfoPointers
SPRITE_PAL_TABLE = 0x08890458    # {u32 palettePtr, u16 tag} stride 8, ends 0x11FF
ROM_BASE = 0x08000000
# Standing-frame convention (uniform across the anim tables): 0=South, 1=North,
# 2=West; East is the West frame h-flipped.
FRAME_BY_FACING = {"down": 0, "up": 1, "left": 2, "right": 2}

_rom_cache = {}


def load_rom(name="Pokemon Recharged Yellow.gba"):
    """Read a ROM by name. ROMs live in local/ (gitignored); the repo root is
    still tried so an older checkout keeps working."""
    if name not in _rom_cache:
        candidates = ([name] if os.path.isabs(name) else
                      [os.path.join(REPO_ROOT, "local", name),
                       os.path.join(REPO_ROOT, name)])
        for path in candidates:
            if os.path.exists(path):
                break
        else:
            raise SystemExit("error: ROM not found: %s (looked in %s)"
                             % (name, " and ".join(os.path.dirname(c) for c in candidates)))
        with open(path, "rb") as f:
            _rom_cache[name] = f.read()
    return _rom_cache[name]


def _rom_off(rom, ptr):
    off = ptr - ROM_BASE
    if not (0 <= off < len(rom)):
        raise ValueError("pointer 0x%08X outside ROM" % ptr)
    return off


def object_sprite_pixels(rom, gfx_id, facing):
    """Render any object event's standing frame by graphicsId, straight from
    the ROM's graphics-info structs. Returns (pixels, w, h); raises on bad data."""
    import gba_gfx
    import struct as _s
    u32 = lambda off: _s.unpack_from("<I", rom, off)[0]
    u16 = lambda off: _s.unpack_from("<H", rom, off)[0]
    info = _rom_off(rom, u32(_rom_off(rom, OBJ_GFX_INFO_PTRS) + gfx_id * 4))
    pal_tag = u16(info + 2)
    width, height = u16(info + 8), u16(info + 0xA)
    wt, ht = width // 8, height // 8
    if not (1 <= wt <= 16 and 1 <= ht <= 16):
        raise ValueError("implausible sprite dims %dx%d" % (width, height))
    images = _rom_off(rom, u32(info + 0x1C))
    frame = FRAME_BY_FACING.get(facing, 0)
    data = _rom_off(rom, u32(images + frame * 8))
    tiles = rom[data:data + wt * ht * 32]
    # find the palette by tag
    p = _rom_off(rom, SPRITE_PAL_TABLE)
    pal_bytes = None
    for _ in range(256):
        tag = u16(p + 4)
        if tag == pal_tag:
            pal_bytes = rom[_rom_off(rom, u32(p)):][:32]
            break
        if tag == 0x11FF:
            break
        p += 8
    if pal_bytes is None:
        raise ValueError("palette tag 0x%04X not found" % pal_tag)
    palette = gba_gfx.decode_palette(pal_bytes)
    return gba_gfx.tiles_to_pixels(tiles, palette, wt, ht,
                                   hflip=(facing == "right"))


MON_GFX_INFO_ARRAY = 0x0888C430
MON_PAL_TABLE = 0x08751738       # {u32 lzPalPtr, u32 tag} stride 8


def mon_sprite_pixels(rom, species, facing):
    """Render a mon overworld standing frame by INTERNAL species id.
    Returns (pixels, w, h)."""
    import gba_gfx
    import struct as _s
    u32 = lambda off: _s.unpack_from("<I", rom, off)[0]
    info = _rom_off(rom, MON_GFX_INFO_ARRAY) + species * 36
    images = _rom_off(rom, u32(info + 0x1C))
    sheet = gba_gfx.lz77_decompress(rom, _rom_off(rom, u32(images)))
    if len(sheet) < 6 * 0x200:
        raise ValueError("mon sheet too small (%#x bytes)" % len(sheet))
    frame = FRAME_BY_FACING.get(facing, 0)
    tiles = sheet[frame * 0x200:(frame + 1) * 0x200]
    pal_lz = _rom_off(rom, u32(_rom_off(rom, MON_PAL_TABLE) + species * 8))
    pal_bytes = gba_gfx.lz77_decompress(rom, pal_lz)[:32]
    palette = gba_gfx.decode_palette(pal_bytes)
    return gba_gfx.tiles_to_pixels(tiles, palette, 4, 4,
                                   hflip=(facing == "right"))


# --- badges ----------------------------------------------------------
BADGE_SHEET_LZ = 0x08A60760
BADGE_PALETTE = 0x085E6024


# --- day/night tint --------------------------------------------------
DNS_NIGHT = (0.55, 0.48, 0.55)
DNS_TWILIGHT = (0.71, 0.62, 0.71)
DNS_CLEAR = (1.0, 1.0, 1.0)


def dns_phase(clock):
    """(chip_label, coeffs-or-None) for the in-game clock. Chip is the 4-state
    DAY/DUSK/NIGHT/DAWN; coeffs None means no tint (day colors)."""
    if not clock:
        return None, None
    m = clock.get("hour", 12) * 60 + clock.get("minute", 0)

    def lerp(a, b, t):
        return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

    if m >= 22 * 60 or m < 4 * 60:
        chip, coeffs = "NIGHT", DNS_NIGHT
    elif m < 7 * 60:
        chip, coeffs = "DAWN", lerp(DNS_NIGHT, DNS_TWILIGHT, (m - 4 * 60) / 180)
    elif m < 10 * 60:
        chip, coeffs = "DAWN", lerp(DNS_TWILIGHT, DNS_CLEAR, (m - 7 * 60) / 180)
    elif m < 18 * 60:
        chip, coeffs = "DAY", None
    elif m < 20 * 60:
        chip, coeffs = "DUSK", lerp(DNS_CLEAR, DNS_TWILIGHT, (m - 18 * 60) / 120)
    else:
        chip, coeffs = "DUSK", lerp(DNS_TWILIGHT, DNS_NIGHT, (m - 20 * 60) / 120)
    if coeffs and min(coeffs) > 0.985:  # end of the morning ramp = clear
        coeffs = None
    return chip, coeffs

