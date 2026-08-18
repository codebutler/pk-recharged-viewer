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
mapped to national dex numbers via species_national.json (extracted from
pokeemerald's sSpeciesToNationalPokedexNum). Items resolve by slugified name
with an alias map for Gen-3 spellings; unresolvable entries degrade to a styled
placeholder.

Caveat: PokeAPI serves current-generation data, so types shown may include
later-gen changes (e.g. Fairy) and ability slot 2 may postdate Gen 3.
"""

import argparse
import base64
import html
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
    """Embed OFL Press Start 2P: prefer the vendored TTF next to this script,
    else fetch via Google Fonts (generate time only). Returns @font-face or ''."""
    local = os.path.join(TOOLS_DIR, "PressStart2P.ttf")
    if os.path.exists(local):
        with open(local, "rb") as f:
            blob = f.read()
        stats["font"] = "embedded (Press Start 2P ttf, OFL, vendored)"
        return ("@font-face{font-family:'Press Start 2P';"
                "src:url(data:font/ttf;base64,%s) format('truetype');}"
                % base64.b64encode(blob).decode())
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
# HTML helpers


def esc(x):
    return html.escape(str(x))


def internal_to_national(internal):
    return SPECIES_NATIONAL.get(internal, 0)


def sprite_img(info, cls="spr", title=""):
    if info and info["sprite"]:
        return '<img class="%s" src="%s" alt="%s" title="%s">' % (
            cls, info["sprite"], esc(title or info["name"]), esc(title))
    return '<span class="%s ph" title="%s">?</span>' % (cls, esc(title))


def panel(title, body, cls=""):
    return ('<section class="panel %s"><h2>%s</h2>%s</section>'
            % (cls, esc(title), body))


def empty_state(msg):
    return '<p class="empty">%s</p>' % esc(msg)


def section_data(state, key):
    """Return (data, error_msg). Error/absent sections yield (None, msg)."""
    v = state.get(key)
    if v is None:
        return None, "not present in this parse"
    if isinstance(v, dict) and "error" in v and len(v) <= 2:
        return None, v["error"]
    return v, None


def bar(pct, color):
    return ('<span class="bar"><span class="fill" style="width:%d%%;'
            'background:%s"></span></span>' % (max(0, min(100, pct)), color))


def hp_bar(hp, maxhp):
    pct = int(100 * hp / maxhp) if maxhp else 0
    color = "#58c858" if pct > 50 else ("#f8d030" if pct > 20 else "#f05038")
    return bar(pct, color) + '<span class="hpnum">%d/%d</span>' % (hp, maxhp)


def type_chips(types, cls="type"):
    return "".join('<span class="%s" style="background:%s">%s</span>'
                   % (cls, TYPE_COLORS.get(t, "#888"), esc(t.upper()))
                   for t in types)


def render_mon_card(mon, api):
    nat = internal_to_national(mon.get("species", 0))
    info = api.pokemon(nat) if nat else None
    name = mon.get("nickname") or (info["name"] if info else "?")
    species = mon.get("speciesName") or (info["name"] if info else "#%d" % nat)
    shiny = '<span class="shiny" title="shiny">&#9733;</span>' if mon.get("shiny") else ""
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
    moves = "".join(
        '<li><span>%s%s</span> <span class="pp">PP %d</span></li>'
        % (esc(m.get("name", "move %d" % m["move"])),
           type_chips([api.move_type(m["move"])], cls="type mtype")
           if api.move_type(m["move"]) else "",
           m.get("pp", 0))
        for m in mon.get("moves", []))
    ivs = mon.get("ivs", {})
    evs = mon.get("evs", {})
    statbars = "".join(
        '<div class="sb"><i>%s</i>%s%s</div>' % (
            lbl,
            bar(int(100 * ivs.get(k, 0) / 31), "#68a0e8"),
            bar(int(100 * evs.get(k, 0) / 255), "#e8a068"))
        for lbl, k in (("HP", "hp"), ("AT", "attack"), ("DF", "defense"),
                       ("SP", "speed"), ("SA", "spAttack"), ("SD", "spDefense")))
    held = ""
    if mon.get("heldItem"):
        held = '<div class="held">holds %s</div>' % esc(
            mon.get("heldItemName", "item #%d" % mon["heldItem"]))
    return """<div class="mon">
  <div class="mon-head">%s<div>
    <div class="mon-name">%s%s</div>
    <div class="mon-sub">%s &middot; Lv%d %s</div>
    <div class="types">%s</div></div></div>
  <div class="hp">%s %s</div>
  <ul class="moves">%s</ul>
  <div class="mon-meta">%s &middot; %s nature%s</div>
  <div class="statbars"><span class="legend"><i style="background:#68a0e8"></i>IV
    <i style="background:#e8a068"></i>EV</span>%s</div>%s
</div>""" % (
        sprite_img(info, "spr big", species), esc(name), shiny, esc(species),
        mon.get("level", 0), '<span class="ail">%s</span>' % ailment if ailment else "",
        type_chips(info["types"] if info else []),
        hp_bar(mon.get("hp", 0), mon.get("stats", {}).get("maxHP", 0)),
        "", moves,
        esc(ability or "ability ?"), esc(mon.get("nature", "?")),
        " &middot; FRIEND %d" % mon.get("friendship", 0) if "friendship" in mon else "",
        statbars, held)


# ---------------------------------------------------------------------------
# sections


def player_sprite_uri(state):
    """Data URI for the player's overworld sprite (saved facing, bike variant),
    or None. Requires state.playerAvatar plus tools/avatar-sprites.json (frame
    spec: ROM addresses from the rom-fingerprint avatar work). Any failure --
    missing spec, missing ROM, decode error -- degrades to None, never breaks
    the page."""
    avatar = state.get("playerAvatar")
    spec_path = os.path.join(TOOLS_DIR, "avatar-sprites.json")
    if not avatar or not os.path.exists(spec_path):
        return None
    try:
        import gba_gfx
        spec = json.load(open(spec_path))
        rom_path = os.path.join(REPO_ROOT, spec.get("rom", "Pokemon Recharged Yellow.gba"))
        with open(rom_path, "rb") as f:
            rom = f.read()
        by_gfx = spec.get("by_graphics_id", {})
        sheet_name = by_gfx.get(str(avatar.get("graphicsId", -1)))
        if sheet_name is None:
            sheet_name = "bike" if avatar.get("onBike") and "bike" in spec else "walking"
        sheet = spec[sheet_name]
        facing = avatar.get("facing", "down")
        frame_key = "side" if facing in ("left", "right") else facing
        frame = sheet["frames"][frame_key]
        addr = int(frame["rom_addr"], 0) - 0x08000000
        wt, ht = sheet["width_tiles"], sheet["height_tiles"]
        if sheet.get("compressed"):
            tiles = gba_gfx.lz77_decompress(rom, addr)
            tiles = tiles[frame.get("tile_offset", 0):]
        else:
            tiles = rom[addr:addr + wt * ht * 32]
        pal_addr = int(sheet["palette_addr"], 0) - 0x08000000
        pal_bytes = rom[pal_addr:pal_addr + 32]
        if sheet.get("palette_compressed"):
            pal_bytes = gba_gfx.lz77_decompress(rom, pal_addr)[:32]
        palette = gba_gfx.decode_palette(pal_bytes)
        hflip = facing != sheet.get("side_faces", "left") if frame_key == "side" else False
        png = gba_gfx.tiles_to_png(tiles, palette, wt, ht, hflip=hflip)
        return data_uri(png)
    except Exception as e:
        sys.stderr.write("player sprite skipped: %s\n" % e)
        return None


def render_trainer_card(state):
    p, err = section_data(state, "player")
    if p is None:
        return panel("Trainer Card", empty_state(err))
    badges_sec, _ = section_data(state, "badges")
    badge_map = (badges_sec or {}).get("badges") or {}
    badge_html = "".join(
        '<span class="badge %s" style="--bc:%s" title="%s Badge">&#9670;</span>'
        % ("lit" if badge_map.get(n) else "unlit", BADGE_COLORS[i], n)
        for i, n in enumerate(BADGE_NAMES))
    loc, _ = section_data(state, "location")
    clock, _ = section_data(state, "gameClock")
    daynight = ""
    if clock:
        hour = clock.get("hour", 0)
        daynight = ('<span class="dn">%s %02d:%02d</span>'
                    % ("DAY" if 6 <= hour < 18 else "NIGHT",
                       hour, clock.get("minute", 0)))
    pt = p.get("playTime", {})
    rows = [
        ("MONEY", "&yen;%s" % format(p.get("money") or 0, ",")),
        ("TIME", "%d:%02d" % (pt.get("hours", 0), pt.get("minutes", 0))),
        ("ID No.", "%05d" % p.get("trainerId", 0)),
    ]
    if state.get("rivalName"):
        rows.append(("RIVAL", esc(state["rivalName"])))
    if loc:
        where = loc.get("mapName") or "map (%d,%d)" % (loc.get("mapGroup", -1),
                                                       loc.get("mapNum", -1))
        rows.append(("PLACE", esc(where)))
    stats_rows = "".join('<div class="tc-row"><i>%s</i><b>%s</b></div>' % r
                         for r in rows)
    sprite_uri = player_sprite_uri(state)
    sprite_html = ""
    if sprite_uri:
        avatar = state.get("playerAvatar", {})
        sprite_html = ('<img class="tc-player" src="%s" alt="player facing %s%s">'
                       % (sprite_uri, esc(avatar.get("facing", "?")),
                          " on bike" if avatar.get("onBike") else ""))
    return """<section class="panel tcard"><h2>Trainer Card</h2>
  <div class="tc-body">
    <div class="tc-namerow">%s<div class="tc-name">%s</div></div>
    <div class="tc-rows">%s %s</div>
    <div class="tc-badges">%s</div>
  </div></section>""" % (sprite_html, esc(p.get("name", "?")), stats_rows,
                         daynight, badge_html)


def render_party(state, api):
    party, err = section_data(state, "party")
    if party is None:
        return panel("Party", empty_state(err))
    mons = [m for m in party.get("pokemon", []) if m and "error" not in m]
    if not mons:
        return panel("Party", empty_state(
            "No Pokemon in the party yet -- this trainer's journey hasn't started."))
    return panel("Party", '<div class="party">%s</div>'
                 % "".join(render_mon_card(m, api) for m in mons))


def render_boxes(state, api):
    pc, err = section_data(state, "pcBoxes")
    if pc is None:
        return panel("Pokemon Storage", empty_state(err))
    total = pc.get("totalStored", 0)
    if total == 0:
        return panel("Pokemon Storage",
                     empty_state("All 14 boxes are empty."))
    boxes_html = []
    for box in pc.get("boxes", []):
        mons = {m["slot"]: m for m in box.get("pokemon", [])}
        if not mons:
            continue
        cells = []
        for s in range(30):
            m = mons.get(s)
            if m:
                nat = internal_to_national(m.get("species", 0))
                info = api.pokemon(nat) if nat else None
                tip = "%s Lv?" % (m.get("speciesName") or "?")
                if m.get("nickname") and m["nickname"] != m.get("speciesName"):
                    tip = "%s (%s)" % (m["nickname"], m.get("speciesName", "?"))
                cells.append('<span class="cell">%s</span>'
                             % sprite_img(info, "spr sm", tip))
            else:
                cells.append('<span class="cell"></span>')
        boxes_html.append('<div class="box"><h3>%s</h3><div class="grid">%s</div></div>'
                          % (esc(box.get("name", "Box")), "".join(cells)))
    n_empty = sum(1 for b in pc.get("boxes", []) if not b.get("pokemon"))
    body = ('<p class="note">%d Pokemon stored &middot; current box: %d'
            '%s</p><div class="boxes">%s</div>'
            % (total, pc.get("currentBox", 1),
               " &middot; %d empty boxes not shown" % n_empty if n_empty else "",
               "".join(boxes_html)))
    return panel("Pokemon Storage", body)


def render_bag(state, api):
    bag, err = section_data(state, "bag")
    if bag is None:
        return panel("Bag", empty_state(err))
    pockets = [("items", "ITEMS"), ("medicine", "MEDICINE"),
               ("pokeBalls", "POKE BALLS"), ("tmHm", "TM / HM"),
               ("berries", "BERRIES"), ("keyItems", "KEY ITEMS")]
    any_items = False
    cols = []
    for key, label in pockets:
        slots = bag.get(key)
        if slots is None:
            continue
        rows = []
        for s in slots:
            any_items = True
            name = s.get("name", "item #%d" % s["itemId"])
            spr = api.item_sprite(name) if s.get("name") else None
            img = ('<img class="ispr" src="%s" alt="">' % spr if spr
                   else '<span class="ispr ph">?</span>')
            rows.append('<li>%s<span class="iname">%s</span>'
                        '<span class="qty">&times;%d</span></li>'
                        % (img, esc(name), s.get("quantity", 0)))
        body = ("<ul class='items'>%s</ul>" % "".join(rows)) if rows else \
            '<p class="pocket-empty">empty</p>'
        cols.append('<div class="pocket"><h3>%s</h3>%s</div>' % (label, body))
    if not any_items:
        return panel("Bag", empty_state("The bag is empty."))
    extra = ""
    if bag.get("registeredItem"):
        extra = '<p class="note">SELECT registered: %s</p>' % esc(
            bag.get("registeredItemName", "item #%d" % bag["registeredItem"]))
    if bag.get("warning"):
        extra += '<p class="warn">%s</p>' % esc(bag["warning"])
    return panel("Bag", '<div class="pockets">%s</div>%s' % ("".join(cols), extra))


def render_dex(state, api):
    dex, err = section_data(state, "pokedex")
    if dex is None:
        return panel("Pokedex", empty_state(err))
    seen = dex.get("seen", [])
    owned = set(dex.get("owned", []))
    head = ('<div class="dexcount"><div><b>%d</b><i>SEEN</i></div>'
            '<div><b>%d</b><i>OWNED</i></div></div>'
            % (dex.get("seenCount", 0), dex.get("ownedCount", 0)))
    if not seen:
        return panel("Pokedex", head + empty_state("No Pokemon seen yet."))
    cells = []
    for nat in seen:
        info = api.pokemon(nat)
        cls = "spr sm" if nat in owned else "spr sm seen"
        label = "#%03d %s%s" % (nat, info["name"] if info else "?",
                                "" if nat in owned else " (seen)")
        cells.append('<span class="cell">%s</span>' % sprite_img(info, cls, label))
    legend = ('<p class="note">color = owned &middot; silhouette = seen only</p>')
    return panel("Pokedex", head + legend + '<div class="grid dexgrid">%s</div>'
                 % "".join(cells))


def render_game_stats(state):
    gs, err = section_data(state, "gameStats")
    if gs is None:
        return panel("Game Stats", empty_state(err))
    named = gs.get("named") or {}
    if not named:
        return panel("Game Stats", empty_state("All counters are zero."))
    rows = "".join('<tr><td>%s</td><td>%s</td></tr>'
                   % (esc(k.replace("_", " ").title()), format(v, ","))
                   for k, v in named.items() if not k.startswith("UNKNOWN"))
    return panel("Game Stats", '<table class="stats">%s</table>' % rows)


def render_challenge(state):
    lc, err = section_data(state, "levelCap")
    if lc is None:
        return ""
    ch = lc.get("challengeOptions", {})
    if not ch.get("levelCapEnabled"):
        return panel("Challenge", empty_state(
            "Level cap disabled -- cap is %d." % lc.get("cap", 100)))
    return panel("Challenge",
                 '<p class="big">LEVEL CAP <b>%d</b> (mode %d)</p>'
                 % (lc.get("cap", 100), ch.get("capMode", 0)))


def render_mail(state):
    mail, err = section_data(state, "mail")
    if mail is None:
        return panel("Mail", empty_state(err))
    entries = mail.get("entries", [])
    if not entries:
        return panel("Mail", empty_state("No mail held or stored."))
    rows = "".join('<li>slot %d (%s): item #%d from %s</li>'
                   % (e["slot"], e.get("slotKind", "?"), e.get("itemId", 0),
                      esc(e.get("playerName", "?"))) for e in entries)
    return panel("Mail", "<ul>%s</ul>" % rows)


PAGE_CSS = """
:root{
  --backdrop:#10281c; --panel:#f8f8ee; --panel2:#e8e8d8; --ink:#33302b;
  --ink-shadow:#c8c4b0; --line:#141410; --pika:#f8d030; --pika-dk:#c89800;
  --accent:#c03028; --blue:#4878c8;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--backdrop);color:var(--ink);
  background-image:repeating-linear-gradient(0deg,transparent 0 2px,rgba(0,0,0,.12) 2px 4px);
  font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:13px;
  padding:24px 12px 64px}
main{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
h1,h2,h3,.tc-name,.dexcount b,.big{font-family:'Press Start 2P',ui-monospace,monospace}
h1{color:var(--pika);font-size:16px;text-align:center;line-height:1.6;
  text-shadow:2px 2px 0 #000;margin-bottom:4px}
h1 small{display:block;font-size:8px;color:#cfe8d8}
.panel{background:var(--panel);border:3px solid var(--line);border-radius:2px;
  box-shadow:inset 0 0 0 2px #fff,inset 0 0 0 4px #b0b0a0,4px 4px 0 rgba(0,0,0,.45);
  padding:16px 14px 14px}
.panel h2{font-size:10px;background:var(--line);color:var(--pika);
  display:inline-block;padding:6px 10px 4px;margin:-16px 0 12px -14px;
  border-bottom-right-radius:2px}
.panel h3{font-size:8px;margin-bottom:6px;color:#5a564e}
img.spr,span.spr{image-rendering:pixelated;display:inline-block;vertical-align:middle}
.spr.big{width:64px;height:64px}
.spr.sm{width:32px;height:32px}
.spr.seen{filter:brightness(0);opacity:.55}
.spr.ph{background:var(--panel2);border:2px dashed #a8a494;color:#a8a494;
  text-align:center;font-family:'Press Start 2P',monospace;font-size:10px;
  line-height:28px;width:32px;height:32px}
.spr.big.ph{width:64px;height:64px;line-height:60px;font-size:16px}
.empty{color:#7a766a;font-style:normal;padding:6px 2px}
.note{color:#7a766a;font-size:11px;margin:4px 0 8px}
.warn{color:var(--accent);font-size:11px;margin-top:8px}
/* trainer card */
.tcard{background:linear-gradient(#f8e070,#f0c830);border-color:var(--line)}
.tcard h2{color:#fff;background:#a06818}
.tc-namerow{display:flex;align-items:center;gap:12px}
.tc-player{image-rendering:pixelated;width:32px;filter:drop-shadow(1px 1px 0 rgba(0,0,0,.3))}
.tc-name{font-size:14px;margin:6px 0 10px;text-shadow:1px 1px 0 #fff}
.tc-rows{display:flex;flex-wrap:wrap;gap:6px 22px;margin-bottom:12px}
.tc-row i{font-style:normal;color:#7a5a10;font-size:10px;margin-right:6px}
.tc-row b{font-size:13px}
.dn{font-family:'Press Start 2P',monospace;font-size:8px;background:var(--line);
  color:#cfe8d8;padding:4px 6px;border-radius:2px;align-self:center}
.tc-badges{display:flex;gap:10px}
.badge{font-size:20px;line-height:1;color:var(--bc);
  text-shadow:1px 1px 0 rgba(0,0,0,.4)}
.badge.unlit{color:transparent;text-shadow:none;-webkit-text-stroke:2px #b09838}
/* party */
.party{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.mon{background:var(--panel2);border:2px solid var(--line);padding:10px;
  box-shadow:inset 0 0 0 2px #fff}
.mon-head{display:flex;gap:10px;align-items:center;margin-bottom:6px}
.mon-name{font-family:'Press Start 2P',monospace;font-size:10px}
.mon-sub{font-size:11px;color:#5a564e;margin:4px 0}
.shiny{color:#e8a800;margin-left:4px}
.ail{background:var(--accent);color:#fff;font-size:9px;padding:1px 4px}
.type{font-family:'Press Start 2P',monospace;font-size:7px;color:#fff;
  padding:3px 5px 2px;margin-right:4px;text-shadow:1px 1px 0 rgba(0,0,0,.5);
  border-radius:2px;display:inline-block}
.hp{display:flex;align-items:center;gap:8px;margin:6px 0}
.bar{flex:0 1 140px;height:8px;background:#585850;border:2px solid var(--line);
  display:inline-block;vertical-align:middle}
.fill{display:block;height:100%}
.hpnum{font-size:11px}
.moves{list-style:none;margin:6px 0;border-top:2px dotted #b8b4a4;padding-top:6px}
.moves li{display:flex;justify-content:space-between;padding:1px 0}
.pp{color:#7a766a}
.mtype{font-size:6px;padding:2px 3px 1px;margin:0 0 0 5px;vertical-align:1px}
.mon-meta{font-size:11px;color:#5a564e;margin:4px 0}
.statbars{margin-top:6px}
.sb{display:flex;align-items:center;gap:6px;margin:2px 0}
.sb i{font-style:normal;font-size:9px;width:18px;color:#7a766a}
.sb .bar{flex:0 1 90px;height:5px}
.legend{font-size:9px;color:#7a766a;display:block;margin-bottom:4px}
.legend i{display:inline-block;width:8px;height:8px;margin:0 3px 0 8px}
.held{font-size:11px;color:#5a564e;margin-top:4px}
/* storage + dex grids */
.boxes{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.box{background:var(--panel2);border:2px solid var(--line);padding:8px;
  box-shadow:inset 0 0 0 2px #fff}
.grid{display:flex;flex-wrap:wrap;gap:2px}
.box .grid{display:grid;grid-template-columns:repeat(6,1fr)}
.cell{width:34px;height:34px;background:#d8d8c4;border:1px solid #b8b4a4;
  display:flex;align-items:center;justify-content:center}
.dexgrid .cell{background:var(--panel2)}
.dexcount{display:flex;gap:28px;margin-bottom:8px}
.dexcount b{font-size:18px;display:block}
.dexcount i{font-style:normal;font-size:9px;color:#7a766a}
/* bag */
.pockets{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.pocket{background:var(--panel2);border:2px solid var(--line);padding:8px;
  box-shadow:inset 0 0 0 2px #fff}
.pocket-empty{color:#a8a494;font-size:11px}
.items{list-style:none}
.items li{display:flex;align-items:center;gap:8px;padding:2px 0;
  border-bottom:1px dotted #c8c4b0}
.ispr{width:24px;height:24px;image-rendering:pixelated}
.ispr.ph{display:inline-flex;align-items:center;justify-content:center;
  background:#d8d8c4;border:1px dashed #a8a494;color:#a8a494;font-size:11px}
.iname{flex:1}
.qty{color:#5a564e}
/* misc */
.stats{border-collapse:collapse;width:100%}
.stats td{border-bottom:1px dotted #c8c4b0;padding:4px 2px}
.stats td:last-child{text-align:right;font-weight:bold}
.big{font-size:12px}
footer{max-width:980px;margin:24px auto 0;color:#9db8a8;font-size:10px;
  line-height:1.7}
@media(max-width:520px){.tc-rows{gap:4px 14px}.sb .bar{flex-basis:60px}}
"""


def build_page(state, api, font_css):
    if not state.get("inGame", False):
        body = ('<section class="panel"><h2>No save loaded</h2>'
                '<p class="empty">%s</p></section>'
                % esc(state.get("error", "This memory dump holds no game state.")))
        sections = [body]
        player_name = "no save"
    else:
        sections = [
            render_trainer_card(state),
            render_party(state, api),
            render_bag(state, api),
            render_dex(state, api),
            render_boxes(state, api),
            render_game_stats(state),
            render_challenge(state),
            render_mail(state),
        ]
        player_name = (state.get("player") or {}).get("name", "?")
    conf = (state.get("meta") or {}).get("confidence", {})
    caveats = "; ".join("%s: %s" % (k, v.split(" (")[0]) for k, v in conf.items()
                        if not v.startswith("high"))
    return """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s -- Recharged Yellow</title>
<style>%s%s</style></head><body>
<h1>POKEMON RECHARGED YELLOW<small>save state report &middot; %s</small></h1>
<main>%s</main>
<footer>Generated locally by generate_page.py. Sprites and metadata from
PokeAPI (cached at generate time; page is fully offline). Types and abilities
are current-generation PokeAPI data and may postdate Gen 3.
%s</footer>
</body></html>""" % (esc(player_name), font_css, PAGE_CSS, esc(player_name),
                     "\n".join(s for s in sections if s),
                     ("Non-high-confidence sections: " + esc(caveats) + ".")
                     if caveats else "")


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

    page = build_page(state, api, font_css)
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
