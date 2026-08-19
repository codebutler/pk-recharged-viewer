#!/usr/bin/env python3
"""generate_page.py -- render a parsed Recharged Yellow game state as an 8-bit
GBA-styled, fully self-contained HTML page.

Usage:
    python3 generate_page.py <state.json | dump-dir | iwram.bin> [--state SAVESTATE]
                             [--out DIR] [--offline]

Input: a parse_ram.py output JSON, or anything parse_ram.py accepts (a dump
directory / iwram path, or --state for an mGBA savestate; parse_ram.py is run as
a subprocess in that case).

Output: <out>/index.html (default analysis/report/index.html) -- self-contained:
sprites and the pixel font are embedded as data URIs; the page makes no network
requests when viewed.

PokeAPI (pokeapi.co) is queried at GENERATE time only, sequentially, with a disk
cache under <out>/.cache/ so re-runs are offline (pass --offline to forbid any
network use). Species IDs in the save are Gen 3 INTERNAL numbers; they are
mapped to national dex numbers via analysis/species-mapping.json (extracted
from pokeemerald, verified byte-identical in the hack ROM). Items resolve by
slugified name
with an alias map for Gen-3 spellings; unresolvable entries degrade to a styled
placeholder.

Caveat: PokeAPI serves current-generation data, so types shown may include
later-gen changes (e.g. Fairy) and ability slot 2 may postdate Gen 3.
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import http.client
import urllib.request
import urllib.error

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.dirname(TOOLS_DIR)
REPO_ROOT = os.path.dirname(ANALYSIS_DIR)
# Local PokeAPI clones (vendor/README: shallow clones of PokeAPI/api-data and
# PokeAPI/sprites). Assets resolve from these first; HTTP is only a fallback.
LOCAL_DATA = os.path.join(REPO_ROOT, "vendor", "pokeapi-data", "data")
LOCAL_SPRITES = os.path.join(REPO_ROOT, "vendor", "pokeapi-sprites")
SPRITES_URL_PREFIX = "https://raw.githubusercontent.com/PokeAPI/sprites/master/"
USER_AGENT = "recharged-yellow-save-viewer/1.0 (fan tool; offline page generator)"
API = "https://pokeapi.co/api/v2"
FONT_CSS_URL = "https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap"

# Canonical internal->national mapping artifact (see its meta for provenance:
# extracted from pokeemerald, verified byte-identical in the hack ROM).
_SPECIES_MAP = json.load(open(os.path.join(ANALYSIS_DIR, "species-mapping.json")))
SPECIES_NATIONAL = {int(k): v["national"] for k, v in _SPECIES_MAP["species"].items()}

# Gen-3 item names whose PokeAPI slug is not the plain slugification.
ITEM_ALIASES = {
    "parlyz heal": "paralyze-heal",
    "thunderstone": "thunder-stone",
    "x defend": "x-defense",
    "x special": "x-sp-atk",
    "s.s. ticket": "ss-ticket",
    "guard spec.": "guard-spec",
    "exp. share": "exp-share",
    "itemfinder": "dowsing-machine",
    "pokeblock case": "pokeblock-case",
    "gold b. cap": "gold-bottle-cap",
    "stardust": "stardust",
}

TYPE_COLORS = {
    "normal": "#A8A878", "fire": "#F08030", "water": "#6890F0",
    "electric": "#F8D030", "grass": "#78C850", "ice": "#98D8D8",
    "fighting": "#C03028", "poison": "#A040A0", "ground": "#E0C068",
    "flying": "#A890F0", "psychic": "#F85888", "bug": "#A8B820",
    "rock": "#B8A038", "ghost": "#705898", "dragon": "#7038F8",
    "dark": "#705848", "steel": "#B8B8D0", "fairy": "#EE99AC",
}

# PokeAPI serves current-gen move types; these moves were retyped to Fairy
# after Gen 3, where they were Normal (ids: Sweet Kiss, Charm, Moonlight).
GEN3_MOVE_TYPE_OVERRIDES = {186: "normal", 204: "normal", 236: "normal"}

BADGE_NAMES = ["Boulder", "Cascade", "Thunder", "Rainbow",
               "Soul", "Marsh", "Volcano", "Earth"]
BADGE_COLORS = ["#9c9c94", "#4890e8", "#f8a800", "#e85890",
                "#e878a0", "#c8a838", "#e05038", "#58b048"]

stats = {"species_ok": 0, "species_ph": 0, "item_ok": 0, "item_ph": 0,
         "fetches": 0, "cache_hits": 0, "local_hits": 0, "font": "fallback"}


# ---------------------------------------------------------------------------
# fetching + cache


class Cache:
    def __init__(self, root, offline):
        self.root = root
        self.offline = offline
        os.makedirs(root, exist_ok=True)

    def _path(self, key):
        return os.path.join(self.root, re.sub(r"[^A-Za-z0-9._-]", "_", key))

    def get(self, key, url, binary=False):
        """Cached GET. Returns bytes/dict or None (negative results cached too)."""
        p = self._path(key)
        if os.path.exists(p):
            stats["cache_hits"] += 1
            data = open(p, "rb").read()
            if data == b"\x00MISS":
                return None
            return data if binary else json.loads(data)
        if self.offline:
            return None
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        data = None
        for attempt in range(4):
            # Be polite to the API/CDN: throttle every request, back off on
            # failures (raw.githubusercontent 429s under rapid sequential load).
            time.sleep(0.4 + attempt * 2.0)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break  # genuine miss, don't retry
            except (urllib.error.URLError, OSError, http.client.HTTPException):
                pass
        if data is None:
            with open(p, "wb") as f:
                f.write(b"\x00MISS")
            return None
        stats["fetches"] += 1
        if not binary:
            try:
                json.loads(data)
            except ValueError:
                data = None
        with open(p, "wb") as f:
            f.write(data if data is not None else b"\x00MISS")
        if data is None:
            return None
        return data if binary else json.loads(data)


def data_uri(png_bytes):
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode()


class PokeApi:
    def __init__(self, cache):
        self.cache = cache
        self._mon = {}
        self._item = {}
        self._move = {}
        self._item_ids = None  # slug -> numeric id, from the local item index

    def _local_json(self, rel):
        p = os.path.join(LOCAL_DATA, rel)
        if os.path.exists(p):
            stats["local_hits"] += 1
            with open(p) as f:
                return json.load(f)
        return None

    def _sprite_bytes(self, url):
        """Sprite bytes for a PokeAPI sprite URL: local clone first, HTTP fallback."""
        if url.startswith(SPRITES_URL_PREFIX):
            p = os.path.join(LOCAL_SPRITES, url[len(SPRITES_URL_PREFIX):])
            if os.path.exists(p):
                stats["local_hits"] += 1
                with open(p, "rb") as f:
                    return f.read()
        key = "spr_" + url.rsplit("/sprites/", 1)[-1].replace("/", "_")
        return self.cache.get(key, url, binary=True)

    def _item_id(self, slug):
        if self._item_ids is None:
            self._item_ids = {}
            idx = self._local_json("api/v2/item/index.json")
            if idx:
                for r in idx.get("results", []):
                    m = re.search(r"/item/(\d+)/", r.get("url", ""))
                    if m:
                        self._item_ids[r["name"]] = int(m.group(1))
        return self._item_ids.get(slug)

    def pokemon(self, national):
        """Return {name, types, abilities, sprite(dataURI or None)} for a
        national dex number, or None."""
        if national in self._mon:
            return self._mon[national]
        info = None
        data = self._local_json("api/v2/pokemon/%d/index.json" % national) \
            or self.cache.get("pokemon_%d.json" % national,
                              "%s/pokemon/%d" % (API, national))
        if data:
            g3 = (((data.get("sprites") or {}).get("versions") or {})
                  .get("generation-iii") or {})
            sprite_url = ((g3.get("emerald") or {}).get("front_default")
                          or (g3.get("firered-leafgreen") or {}).get("front_default")
                          or (data.get("sprites") or {}).get("front_default"))
            sprite = None
            if sprite_url:
                png = self._sprite_bytes(sprite_url)
                if png:
                    sprite = data_uri(png)
            info = {
                "name": data.get("name", "").replace("-", " ").title(),
                "types": [t["type"]["name"] for t in
                          sorted(data.get("types", []), key=lambda t: t["slot"])],
                "abilities": {a["slot"]: a["ability"]["name"].replace("-", " ").title()
                              for a in data.get("abilities", [])
                              if not a.get("is_hidden")},
                "sprite": sprite,
            }
        stats["species_ok" if info and info["sprite"] else "species_ph"] += 1
        self._mon[national] = info
        return info

    def growth_rate(self, national):
        """Growth-rate name for a species (from pokemon-species data), or None."""
        data = self._local_json("api/v2/pokemon-species/%d/index.json" % national) \
            or self.cache.get("species_%d.json" % national,
                              "%s/pokemon-species/%d" % (API, national))
        if data:
            return (data.get("growth_rate") or {}).get("name")
        return None

    def move_type(self, move_id):
        """Type name for a move id, or None. Gen 3 internal move IDs equal
        national/PokeAPI move IDs (unlike species), so no mapping table."""
        if move_id in self._move:
            return self._move[move_id]
        t = GEN3_MOVE_TYPE_OVERRIDES.get(move_id)
        if t is None:
            data = self._local_json("api/v2/move/%d/index.json" % move_id) \
                or self.cache.get("move_%d.json" % move_id,
                                  "%s/move/%d" % (API, move_id))
            if data:
                t = (data.get("type") or {}).get("name")
        self._move[move_id] = t
        return t

    def item_sprite(self, name):
        """Data URI for an item sprite by display name, or None."""
        key = name.lower()
        if key in self._item:
            return self._item[key]
        slug = ITEM_ALIASES.get(key)
        if slug is None:
            slug = unicodedata.normalize("NFKD", key).encode("ascii", "ignore").decode()
            slug = re.sub(r"[^a-z0-9]+", "-", slug).strip("-")
        uri = None
        iid = self._item_id(slug)
        data = (self._local_json("api/v2/item/%d/index.json" % iid) if iid else None) \
            or self.cache.get("item_%s.json" % slug, "%s/item/%s" % (API, slug))
        if data:
            url = (data.get("sprites") or {}).get("default")
            if url:
                png = self._sprite_bytes(url)
                if png:
                    uri = data_uri(png)
        stats["item_ok" if uri else "item_ph"] += 1
        self._item[key] = uri
        return uri


def fetch_font(cache):
    """Embed the pixel faces (both OFL): Press Start 2P for display text and
    VT323 for body text -- everything on the page is 8-bit type, but the body
    face stays readable at data densities Press Start 2P can't handle. Prefers
    the vendored TTFs next to this script, else fetches Press Start 2P via
    Google Fonts (generate time only). Returns @font-face CSS or ''."""
    css = []
    for fam, fname in (("Press Start 2P", "PressStart2P.ttf"),
                       ("VT323", "VT323.ttf")):
        local = os.path.join(TOOLS_DIR, fname)
        if os.path.exists(local):
            with open(local, "rb") as f:
                blob = f.read()
            css.append("@font-face{font-family:'%s';"
                       "src:url(data:font/ttf;base64,%s) format('truetype');}"
                       % (fam, base64.b64encode(blob).decode()))
    if css:
        stats["font"] = "embedded (Press Start 2P + VT323, OFL, vendored)"
        return "".join(css)
    css = cache.get("pressstart2p.css", FONT_CSS_URL, binary=True)
    if css:
        # Google serves woff2 to browser UAs but plain TTF to ours; accept both.
        m = re.search(rb"url\((https://fonts\.gstatic\.com/[^)]+\.(woff2|ttf))\)", css)
        if m:
            url, ext = m.group(1).decode(), m.group(2).decode()
            blob = cache.get("pressstart2p." + ext, url, binary=True)
            if blob:
                stats["font"] = "embedded (Press Start 2P %s, OFL)" % ext
                fmt = "woff2" if ext == "woff2" else "truetype"
                return ("@font-face{font-family:'Press Start 2P';"
                        "src:url(data:font/%s;base64,%s) format('%s');}"
                        % (ext, base64.b64encode(blob).decode(), fmt))
    return ""


# ---------------------------------------------------------------------------
# context builders (plain data for the Jinja2 template; no HTML in Python)


def internal_to_national(internal):
    return SPECIES_NATIONAL.get(internal, 0)


def section_data(state, key):
    """Return (data, error_msg). Error/absent sections yield (None, msg)."""
    v = state.get(key)
    if v is None:
        return None, "not present in this parse"
    if isinstance(v, dict) and "error" in v and len(v) <= 2:
        return None, v["error"]
    return v, None


def pct(value, maximum):
    return max(0, min(100, int(100 * value / maximum))) if maximum else 0


def type_info(name):
    return {"name": name, "color": TYPE_COLORS.get(name, "#888")}


# Gen 3 experience curves (integer math). PokeAPI growth-rate names map:
# medium = medium-fast, slow-then-very-fast = erratic,
# fast-then-very-slow = fluctuating.
def exp_for_level(rate, n):
    if n <= 1:
        return 0
    if rate == "fast":
        return 4 * n ** 3 // 5
    if rate in ("medium", "medium-fast"):
        return n ** 3
    if rate == "medium-slow":
        return 6 * n ** 3 // 5 - 15 * n ** 2 + 100 * n - 140
    if rate == "slow":
        return 5 * n ** 3 // 4
    if rate == "slow-then-very-fast":  # erratic
        if n < 50:
            return n ** 3 * (100 - n) // 50
        if n < 68:
            return n ** 3 * (150 - n) // 100
        if n < 98:
            return n ** 3 * ((1911 - 10 * n) // 3) // 500
        return n ** 3 * (160 - n) // 100
    if rate == "fast-then-very-slow":  # fluctuating
        if n < 15:
            return n ** 3 * ((n + 1) // 3 + 24) // 50
        if n < 36:
            return n ** 3 * (n + 14) // 50
        return n ** 3 * (n // 2 + 32) // 50
    return None


def exp_progress(api, national, level, experience):
    """(pct, to_next) toward the next level, or (None, None) when unknown."""
    if not national or not (1 <= level < 100) or experience is None:
        return None, None
    rate = api.growth_rate(national)
    cur = exp_for_level(rate, level) if rate else None
    nxt = exp_for_level(rate, level + 1) if rate else None
    if cur is None or nxt is None or nxt <= cur:
        return None, None
    return pct(experience - cur, nxt - cur), max(0, nxt - experience)


def mon_context(mon, api):
    nat = internal_to_national(mon.get("species", 0))
    info = api.pokemon(nat) if nat else None
    species = mon.get("speciesName") or (info["name"] if info else "#%d" % nat)
    status = mon.get("status", {})
    ailment = next((k.upper() for k in
                    ("poison", "burn", "freeze", "paralysis", "badPoison")
                    if status.get(k)), "")
    if status.get("sleepTurns"):
        ailment = "SLEEP"
    ability = ""
    if info and info["abilities"]:
        ability = info["abilities"].get(mon.get("abilityNum", 0) + 1) \
            or next(iter(info["abilities"].values()))
    hp, max_hp = mon.get("hp", 0), mon.get("stats", {}).get("maxHP", 0)
    hp_pct = pct(hp, max_hp)
    ivs, evs = mon.get("ivs", {}), mon.get("evs", {})
    level = mon.get("level", 0)
    exp_pct, exp_to_next = exp_progress(api, nat, level, mon.get("experience"))
    return {
        "sprite": info["sprite"] if info else None,
        "name": mon.get("nickname") or (info["name"] if info else "?"),
        "species": species,
        "shiny": bool(mon.get("shiny")),
        "level": mon.get("level", 0),
        "ailment": ailment,
        "types": [type_info(t) for t in (info["types"] if info else [])],
        "hp": hp, "max_hp": max_hp, "hp_pct": hp_pct,
        "hp_color": ("#58c858" if hp_pct > 50 else
                     "#f8d030" if hp_pct > 20 else "#f05038"),
        "exp_pct": exp_pct, "exp_to_next": exp_to_next,
        "maxed": level >= 100,
        "moves": [{
            "name": m.get("name", "move %d" % m["move"]),
            "type": type_info(api.move_type(m["move"]))
                    if api.move_type(m["move"]) else None,
            "pp": m.get("pp", 0),
        } for m in mon.get("moves", [])],
        "ability": ability or "ability ?",
        "nature": mon.get("nature", "?"),
        "friendship": mon.get("friendship"),
        "stat_rows": [{
            "label": lbl,
            "iv_pct": pct(ivs.get(k, 0), 31),
            "ev_pct": pct(evs.get(k, 0), 255),
        } for lbl, k in (("HP", "hp"), ("AT", "attack"), ("DF", "defense"),
                         ("SP", "speed"), ("SA", "spAttack"), ("SD", "spDefense"))],
        "held": (mon.get("heldItemName", "item #%d" % mon["heldItem"])
                 if mon.get("heldItem") else None),
    }


# Overworld sprite extraction. Primary path reads the ObjectEventGraphicsInfo
# structs straight from the ROM (addresses from hack-offsets.json
# player_sprite_rendering), so ANY object event renders by graphicsId; the
# hand-written avatar-sprites.json remains an override/fallback for the player.
OBJ_GFX_INFO_PTRS = 0x0887EE9C   # gObjectEventGraphicsInfoPointers
SPRITE_PAL_TABLE = 0x08890458    # {u32 palettePtr, u16 tag} stride 8, ends 0x11FF
ROM_BASE = 0x08000000
# Standing-frame convention (uniform across the anim tables): 0=South, 1=North,
# 2=West; East is the West frame h-flipped.
FRAME_BY_FACING = {"down": 0, "up": 1, "left": 2, "right": 2}

_rom_cache = {}


def load_rom(name="Pokemon Recharged Yellow.gba"):
    if name not in _rom_cache:
        with open(os.path.join(REPO_ROOT, name), "rb") as f:
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


def object_sprite_png(rom, gfx_id, facing):
    import gba_gfx
    return gba_gfx.rgba_to_png(*object_sprite_pixels(rom, gfx_id, facing))


def _json_spec_sprite(avatar):
    """Fallback: the hand-written avatar-sprites.json frame spec."""
    import gba_gfx
    spec_path = os.path.join(TOOLS_DIR, "avatar-sprites.json")
    if not os.path.exists(spec_path):
        return None
    spec = json.load(open(spec_path))
    rom = load_rom(spec.get("rom", "Pokemon Recharged Yellow.gba"))
    by_gfx = spec.get("by_graphics_id", {})
    sheet_name = by_gfx.get(str(avatar.get("graphicsId", -1)))
    if sheet_name is None:
        sheet_name = "bike" if avatar.get("onBike") and "bike" in spec else "walking"
    sheet = spec[sheet_name]
    facing = avatar.get("facing", "down")
    frame_key = "side" if facing in ("left", "right") else facing
    frame = sheet["frames"][frame_key]
    addr = int(frame["rom_addr"], 0) - ROM_BASE
    wt, ht = sheet["width_tiles"], sheet["height_tiles"]
    if sheet.get("compressed"):
        tiles = gba_gfx.lz77_decompress(rom, addr)
        tiles = tiles[frame.get("tile_offset", 0):]
    else:
        tiles = rom[addr:addr + wt * ht * 32]
    pal_addr = int(sheet["palette_addr"], 0) - ROM_BASE
    pal_bytes = rom[pal_addr:pal_addr + 32]
    if sheet.get("palette_compressed"):
        pal_bytes = gba_gfx.lz77_decompress(rom, pal_addr)[:32]
    palette = gba_gfx.decode_palette(pal_bytes)
    hflip = facing != sheet.get("side_faces", "left") if frame_key == "side" else False
    return gba_gfx.tiles_to_png(tiles, palette, wt, ht, hflip=hflip)


# Mon overworld sprites (follower etc.): graphics-info structs are an inline
# ARRAY (stride 36) indexed by INTERNAL species; the first images-table entry
# points at an LZ77 sheet of 6 32x32 frames (0/1/2 = stand S/N/W, 3-5 walk);
# the remaining image-table entries hold bogus in-stream pointers -- ignore
# them and slice the decompressed sheet. Species-indexed LZ77 palettes.
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


def mon_sprite_png(rom, species, facing):
    import gba_gfx
    return gba_gfx.rgba_to_png(*mon_sprite_pixels(rom, species, facing))


def avatar_sprite_uri(avatar):
    """Data URI for an object event's sprite given {graphicsId, facing, ...}.
    Mon overworld sprites (dicts carrying "species") use the species-indexed
    tables; others use the main graphics-info chain; json spec is the player
    fallback. None on any failure."""
    if not avatar:
        return None
    try:
        if avatar.get("species") is not None:
            png = mon_sprite_png(load_rom(), avatar["species"],
                                 avatar.get("facing", "down"))
        else:
            png = object_sprite_png(load_rom(), avatar.get("graphicsId", 0),
                                    avatar.get("facing", "down"))
        return data_uri(png)
    except Exception as e:
        sys.stderr.write("rom-driven sprite failed (gfx %s): %s\n"
                         % (avatar.get("graphicsId"), e))
    try:
        png = _json_spec_sprite(avatar)
        return data_uri(png) if png else None
    except Exception as e:
        sys.stderr.write("sprite fallback failed: %s\n" % e)
        return None


def player_sprite_uri(state):
    return avatar_sprite_uri(state.get("playerAvatar"))


# Authentic in-game badge pixel art (hack-offsets.json badge_pixel_art,
# live-verified against the trainer-card VRAM dump): LZ77 sheet of 8 16x16
# badges; badge i = tiles {2i, 2i+1} on the top row and {16+2i, 16+2i+1} on
# the bottom (the sheet is 16 tiles wide). Uncompressed BGR555 palette.
BADGE_SHEET_LZ = 0x08A60760
BADGE_PALETTE = 0x085E6024

_badge_sheet = []  # lazy: [] = untried, None = failed, (sheet, palette) = ready


def badge_sprite_uri(n):
    """Data URI for Kanto badge n (1=Boulder .. 8=Earth): the hack ROM's own
    16x16 pixel art first, the PokeAPI badge render as fallback, None if both
    fail (the template then falls back to the diamond glyph)."""
    import gba_gfx
    global _badge_sheet
    if _badge_sheet == []:
        try:
            rom = load_rom()
            sheet = gba_gfx.lz77_decompress(rom, _rom_off(rom, BADGE_SHEET_LZ))
            if len(sheet) != 0x400:
                raise ValueError("badge sheet is %#x bytes, expected 0x400"
                                 % len(sheet))
            pal_off = _rom_off(rom, BADGE_PALETTE)
            palette = gba_gfx.decode_palette(rom[pal_off:pal_off + 32])
            _badge_sheet = (sheet, palette)
        except Exception as e:
            sys.stderr.write("ROM badge art failed: %s\n" % e)
            _badge_sheet = None
    if _badge_sheet:
        sheet, palette = _badge_sheet
        i = n - 1
        tiles = b"".join(sheet[t * 32:(t + 1) * 32]
                         for t in (2 * i, 2 * i + 1, 16 + 2 * i, 17 + 2 * i))
        return data_uri(gba_gfx.tiles_to_png(tiles, palette, 2, 2))
    p = os.path.join(LOCAL_SPRITES, "sprites", "badges", "%d.png" % n)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return data_uri(f.read())
    return None


# Day/night schedule (hack-offsets.json day_night_tint, disassembled handler
# table + live-measured magnitudes): full night 22:00-3:59; dawn ramp
# night->twilight 4:00-6:59; morning ramp twilight->clear 7:00-9:59; full day
# 10:00-17:59; dusk ramp clear->twilight 18:00-19:59; evening ramp
# twilight->night 20:00-21:59 -- all minute-interpolated. Coefficients: night
# measured ~(0.55, 0.48, 0.55); twilight solved from the live 21:16 sample
# ((0.61, 0.53, 0.61) at 63% through the evening ramp) = ~(0.71, 0.62, 0.71).
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


def map_context(state, cache):
    """Render the terrain around the player: a 15x11-metatile crop centered on
    the player (marked) plus the full map, tinted per the in-game clock.
    Graceful error dict on any failure."""
    loc, err = section_data(state, "location")
    if loc is None or loc.get("mapGroup") is None:
        return {"error": err or "location unavailable"}
    try:
        import gba_map
        import gba_gfx
        rom = load_rom()
        px, W, H, wm, hm = gba_map.map_render(rom, loc["mapGroup"], loc["mapNum"])
        clock, _ = section_data(state, "gameClock")
        chip, coeffs = dns_phase(clock)
        # Interiors are exempt from the day/night system (mapType gate at
        # 0x08140E60; the live 21:18 bedroom capture is untinted).
        outdoor = gba_map.map_type(rom, loc["mapGroup"], loc["mapNum"]) in (1, 2, 3, 5, 6)
        if outdoor and coeffs:
            rs, gs, bs = coeffs
            px = [(int(r * rs), int(g * gs), int(b * bs), a) for r, g, b, a in px]
        tx, ty = loc.get("x", 0), loc.get("y", 0)

        # The marker is the ACTUAL player sprite (feet anchored on the tile),
        # drawn after the tint so it reads like the game's own sprite layer,
        # plus the follower at its own tile when visible.
        avatar = state.get("playerAvatar") or {}
        try:
            sp, sw_, sh_ = object_sprite_pixels(rom, avatar.get("graphicsId", 0),
                                                avatar.get("facing", "down"))
            gba_gfx.composite(px, W, H, sp, sw_, sh_,
                              tx * 16 + (16 - sw_) // 2, (ty + 1) * 16 - sh_)
        except Exception as e:
            # No visual fallback by design (red boxes are banned); the title
            # attribute still carries the coordinates.
            sys.stderr.write("map player sprite: %s\n" % e)
        follower = avatar.get("follower")
        if (follower and follower.get("present") and follower.get("species")
                and not follower.get("hidden")):
            try:
                fx = follower["coords"][0] - 7  # objectEvent coords are map+7
                fy = follower["coords"][1] - 7
                fp, fw, fh = mon_sprite_pixels(rom, follower["species"],
                                               follower.get("facing", "down"))
                gba_gfx.composite(px, W, H, fp, fw, fh,
                                  fx * 16 + (16 - fw) // 2, (fy + 1) * 16 - fh)
            except Exception as e:
                sys.stderr.write("map follower sprite: %s\n" % e)

        cpx, cw, ch, _, _ = gba_map.crop(px, W, H, (tx - 7) * 16, (ty - 5) * 16,
                                         15 * 16, 11 * 16)
        crop_png = gba_gfx.rgba_to_png(cpx, cw, ch)
        # full map: cache the encoded PNG (sprites + tint vary per save state,
        # so key on layout + tile + facing + chip)
        key = "map_%d_%d_%d_%s_%s.png" % (loc.get("mapLayoutId", 0), tx, ty,
                                          avatar.get("facing", "x"), chip or "day")
        cache_path = cache._path(key)
        if os.path.exists(cache_path):
            with open(cache_path, "rb") as f:
                full_png = f.read()
        else:
            full_png = gba_gfx.rgba_to_png(px, W, H)
            with open(cache_path, "wb") as f:
                f.write(full_png)
        # 12-hour clock text for the in-game-style popup box.
        clock12 = None
        if clock:
            h24 = clock.get("hour", 0)
            h12 = h24 % 12 or 12
            clock12 = "%d:%02d %s" % (h12, clock.get("minute", 0),
                                      "AM" if h24 < 12 else "PM")
        return {
            "name": loc.get("mapName") or "map (%d,%d)" % (loc["mapGroup"], loc["mapNum"]),
            "coords": "(%d, %d)" % (tx, ty),
            "clock12": clock12,
            "phase": chip,
            "crop": data_uri(crop_png),
            "full": data_uri(full_png),
            "full_w": W,
            "small": (wm, hm) <= (15, 11),
        }
    except Exception as e:
        sys.stderr.write("map render failed: %s\n" % e)
        return {"error": "map could not be rendered (%s)" % e}


def trainer_context(state):
    p, err = section_data(state, "player")
    if p is None:
        return {"error": err}
    badges_sec, _ = section_data(state, "badges")
    badge_map = (badges_sec or {}).get("badges") or {}
    pt = p.get("playTime", {})
    # Fields exactly as the in-game card shows them (no thousands separators,
    # Pokedollar sign, dex = owned count).
    dex_owned = ((state.get("pokedex") or {}).get("ownedCount")
                 if isinstance(state.get("pokedex"), dict) else None)
    fields = [("Money", "\u20bd%d" % (p.get("money") or 0)),
              ("Pok\u00e9dex", str(dex_owned if dex_owned is not None else "?")),
              ("Time", "%d:%02d" % (pt.get("hours", 0), pt.get("minutes", 0)))]
    # (Player and follower overworld sprites are composited onto the map
    # panel now -- see map_context -- so the card carries only the full-body
    # art, with the overworld sprite as its fallback.)
    # Full-body trainer art: extracted from the live card capture (vendored
    # asset, see assets/); fall back to the overworld sprite at 2x if absent.
    pic_path = os.path.join(TOOLS_DIR, "assets",
                            "trainer-pic-%s.png" % p.get("gender", "male"))
    pic = None
    if os.path.exists(pic_path):
        with open(pic_path, "rb") as f:
            pic = data_uri(f.read())
    return {
        "name": p.get("name", "?"),
        "idno": "IDNo.%05d" % p.get("trainerId", 0),
        "fields": fields,
        "pic": pic,
        "sprite": player_sprite_uri(state),
        "sprite_alt": "player overworld sprite",
        "badges": [{"name": n, "color": BADGE_COLORS[i],
                    "lit": bool(badge_map.get(n)),
                    "sprite": badge_sprite_uri(i + 1)}
                   for i, n in enumerate(BADGE_NAMES)],
    }


def party_context(state, api):
    party, err = section_data(state, "party")
    if party is None:
        return {"error": err}
    mons = [m for m in party.get("pokemon", []) if m and "error" not in m]
    if not mons:
        return {"empty": "No Pokemon in the party yet -- this trainer's "
                         "journey hasn't started."}
    return {"mons": [mon_context(m, api) for m in mons]}


def bag_context(state, api):
    bag, err = section_data(state, "bag")
    if bag is None:
        return {"error": err}
    labels = [("items", "ITEMS"), ("medicine", "MEDICINE"),
              ("pokeBalls", "POKE BALLS"), ("tmHm", "TM / HM"),
              ("berries", "BERRIES"), ("keyItems", "KEY ITEMS")]
    pockets = []
    any_items = False
    for key, label in labels:
        slots = bag.get(key)
        if slots is None:
            continue
        items = []
        for s in slots:
            any_items = True
            name = s.get("name", "item #%d" % s["itemId"])
            items.append({
                "name": name,
                "qty": s.get("quantity", 0),
                "sprite": api.item_sprite(name) if s.get("name") else None,
            })
        pockets.append({"label": label, "slots": items})
    if not any_items:
        return {"empty": "The bag is empty."}
    return {
        "pockets": pockets,
        "registered": bag.get("registeredItemName",
                              "item #%d" % bag["registeredItem"])
                      if bag.get("registeredItem") else None,
        "warning": bag.get("warning"),
    }


def dex_context(state, api):
    dex, err = section_data(state, "pokedex")
    if dex is None:
        return {"error": err}
    seen = dex.get("seen", [])
    owned = set(dex.get("owned", []))
    ctx = {"seen_count": dex.get("seenCount", 0),
           "owned_count": dex.get("ownedCount", 0)}
    if not seen:
        ctx["empty"] = "No Pokemon seen yet."
        return ctx
    cells = []
    for nat in seen:
        info = api.pokemon(nat)
        cells.append({
            "sprite": info["sprite"] if info else None,
            "owned": nat in owned,
            "label": "#%03d %s%s" % (nat, info["name"] if info else "?",
                                     "" if nat in owned else " (seen)"),
        })
    ctx["cells"] = cells
    return ctx


def boxes_context(state, api):
    pc, err = section_data(state, "pcBoxes")
    if pc is None:
        return {"error": err}
    total = pc.get("totalStored", 0)
    if total == 0:
        return {"empty": "All 14 boxes are empty."}
    shown = []
    for box in pc.get("boxes", []):
        mons = {m["slot"]: m for m in box.get("pokemon", [])}
        if not mons:
            continue
        cells = []
        for s in range(30):
            m = mons.get(s)
            if not m:
                cells.append(None)
                continue
            nat = internal_to_national(m.get("species", 0))
            info = api.pokemon(nat) if nat else None
            label = "%s Lv?" % (m.get("speciesName") or "?")
            if m.get("nickname") and m["nickname"] != m.get("speciesName"):
                label = "%s (%s)" % (m["nickname"], m.get("speciesName", "?"))
            cells.append({"sprite": info["sprite"] if info else None,
                          "label": label})
        shown.append({"name": box.get("name", "Box"), "cells": cells})
    return {
        "total": total,
        "current": pc.get("currentBox", 1),
        "n_empty": sum(1 for b in pc.get("boxes", []) if not b.get("pokemon")),
        "shown": shown,
    }


def game_stats_context(state):
    gs, err = section_data(state, "gameStats")
    if gs is None:
        return {"error": err}
    named = gs.get("named") or {}
    if not named:
        return {"empty": "All counters are zero."}
    return {"rows": [(k.replace("_", " ").title(), format(v, ","))
                     for k, v in named.items() if not k.startswith("UNKNOWN")]}


def challenge_context(state):
    lc, err = section_data(state, "levelCap")
    if lc is None:
        return None
    ch = lc.get("challengeOptions", {})
    if not ch.get("levelCapEnabled"):
        return {"empty": "Level cap disabled -- cap is %d." % lc.get("cap", 100)}
    return {"cap": lc.get("cap", 100), "mode": ch.get("capMode", 0)}


def mail_context(state):
    mail, err = section_data(state, "mail")
    if mail is None:
        return {"error": err}
    entries = mail.get("entries", [])
    if not entries:
        return {"empty": "No mail held or stored."}
    return {"entries": [{"slot": e["slot"], "kind": e.get("slotKind", "?"),
                         "item_id": e.get("itemId", 0),
                         "sender": e.get("playerName", "?")} for e in entries]}


def build_context(state, api, font_css):
    from markupsafe import Markup
    in_game = state.get("inGame", False)
    player_name = ((state.get("player") or {}).get("name", "?")
                   if in_game else "no save")
    conf = (state.get("meta") or {}).get("confidence", {})
    caveats = "; ".join("%s: %s" % (k, v.split(" (")[0]) for k, v in conf.items()
                        if not v.startswith("high"))
    ctx = {
        "in_game": in_game,
        "error": state.get("error", "This memory dump holds no game state."),
        "title": "%s -- Recharged Yellow" % player_name,
        "player_name": player_name,
        "font_css": Markup(font_css),
        "caveats": caveats,
    }
    if in_game:
        ctx.update(
            trainer=trainer_context(state),
            map=map_context(state, api.cache),
            party=party_context(state, api),
            bag=bag_context(state, api),
            dex=dex_context(state, api),
            boxes=boxes_context(state, api),
            game_stats=game_stats_context(state),
            challenge=challenge_context(state),
            mail=mail_context(state),
            rival=state.get("rivalName"),
        )

        # Tab bar: sections other than the always-visible trainer card. A tab
        # is "empty" (dimmed label) when its section(s) carry only an
        # empty/error state.
        def is_empty(sec):
            return sec is None or bool(sec.get("empty") or sec.get("error"))
        ctx["tabs"] = [
            {"id": "party", "label": "PARTY", "empty": is_empty(ctx["party"])},
            {"id": "bag", "label": "BAG", "empty": is_empty(ctx["bag"])},
            {"id": "pokedex", "label": "POKEDEX",
             "empty": is_empty(ctx["dex"]) or bool(ctx["dex"].get("empty"))},
            {"id": "storage", "label": "STORAGE", "empty": is_empty(ctx["boxes"])},
            {"id": "stats", "label": "STATS", "empty": is_empty(ctx["game_stats"])},
            {"id": "more", "label": "MORE",
             "empty": (is_empty(ctx["challenge"]) and is_empty(ctx["mail"])
                       and not ctx["rival"])},
        ]
    return ctx


def render_page(state, api, font_css):
    try:
        from jinja2 import Environment, FileSystemLoader, select_autoescape
    except ImportError:
        raise SystemExit(
            "error: jinja2 is not installed. Run via uv from the repo root:\n"
            "  uv run analysis/tools/generate_page.py ...\n"
            "(one-time setup: uv sync)")
    env = Environment(
        loader=FileSystemLoader(os.path.join(TOOLS_DIR, "templates")),
        autoescape=select_autoescape(("html", "j2")),
        trim_blocks=True, lstrip_blocks=True)
    template = env.get_template("report.html.j2")
    return template.render(**build_context(state, api, font_css))


# ---------------------------------------------------------------------------


def load_state(args):
    if args.state:
        cmd = [sys.executable, os.path.join(TOOLS_DIR, "parse_ram.py"),
               "--state", args.state]
    elif args.target and args.target.endswith(".json"):
        with open(args.target) as f:
            return json.load(f)
    elif args.target:
        cmd = [sys.executable, os.path.join(TOOLS_DIR, "parse_ram.py"), args.target]
    else:
        raise SystemExit("error: need a state JSON, dump target, or --state")
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except ValueError:
        raise SystemExit("error: parse_ram.py produced no JSON: %s"
                         % (r.stderr or r.stdout)[:300])


def main():
    ap = argparse.ArgumentParser(description="Render parsed game state as an "
                                 "8-bit HTML page.")
    ap.add_argument("target", nargs="?",
                    help="parsed-state .json, or a dump dir / iwram.bin")
    ap.add_argument("--state", help="mGBA savestate (passed to parse_ram.py)")
    ap.add_argument("--out", default=os.path.join(ANALYSIS_DIR, "report"),
                    help="output directory (default analysis/report)")
    ap.add_argument("--offline", action="store_true",
                    help="never touch the network; use only the disk cache")
    args = ap.parse_args()

    state = load_state(args)
    os.makedirs(args.out, exist_ok=True)
    cache = Cache(os.path.join(args.out, ".cache"), args.offline)
    api = PokeApi(cache)
    font_css = fetch_font(cache)

    page = render_page(state, api, font_css)
    out_path = os.path.join(args.out, "index.html")
    with open(out_path, "w") as f:
        f.write(page)

    size = os.path.getsize(out_path)
    print("wrote %s (%.1f KB)" % (out_path, size / 1024))
    print("species: %d with sprite, %d placeholder | items: %d with sprite, "
          "%d placeholder" % (stats["species_ok"], stats["species_ph"],
                              stats["item_ok"], stats["item_ph"]))
    print("local-clone hits: %d | network fetches: %d, http-cache hits: %d | font: %s"
          % (stats["local_hits"], stats["fetches"], stats["cache_hits"],
             stats["font"]))


if __name__ == "__main__":
    main()
