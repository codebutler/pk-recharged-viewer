#!/usr/bin/env python3
"""parse_ram.py -- Pokemon Recharged Yellow RAM-dump -> game-state JSON.

Parses raw GBA memory dumps (iwram.bin @ 0x03000000, ewram.bin @ 0x02000000) of a
running "Pokemon Recharged Yellow" game (a pokeemerald-engine rebuild) and emits the
game state as structured JSON.

Usage:
    python3 parse_ram.py <dumpdir-or-iwram.bin> [--ewram PATH] [--pretty]
                         [--offsets EXTRA.json] [--no-scan]

A dump directory must contain iwram.bin and ewram.bin.

Offset configuration is layered (later wins):
    1. built-in vanilla pokeemerald offsets (from analysis/structs.json, verified
       against compiled headers -- see analysis/structs-notes.md)
    2. offsets-discovered.json   (this tool's own empirical findings, next to script)
    3. analysis/hack-offsets.json (authoritative hack offsets, if present)
    4. --offsets EXTRA.json      (manual override)

Every emitted section carries a confidence and, when data cannot be trusted, an
explicit "error" instead of silent garbage. The "meta" section records which anchors
validated, which offsets were used with what status, and any deltas discovered at
runtime (encryption-key relocation scan, party relocation scan).

Requires only the Python 3 standard library plus analysis/structs.json (charmap and
substruct permutation). analysis/gamedata.json, if present, supplies name tables for
species/items/moves/maps.
"""

import argparse
import json
import os
import re
import struct
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.dirname(TOOLS_DIR)

EWRAM_BASE = 0x02000000
EWRAM_SIZE = 0x40000
IWRAM_BASE = 0x03000000
IWRAM_SIZE = 0x8000

# Hack's SaveBlock sizes (hack-offsets.json meta.sizes, live-confirmed). Bytes at
# sb2+0xF64..0xFE3 are inter-block ASLR slack (stale copies of SB1's head from
# earlier shifts), NOT SaveBlock2 -- never parse from there.
SB1_SIZE = 0x3D94
SB2_SIZE = 0xF64

# Accelerated day/night clock at SB2+0xF5C (8-byte struct, ~9x real time). Byte
# semantics tentative: minute @+3 and second @+4 are live-confirmed; day/hour
# assumed at +0..+2 (still zero in all available dumps). Gated by flag 0x895,
# archived to SB2+0xE0, leading u16 mirrored in var 0x408E.
GAME_CLOCK_OFF = 0xF5C

# IWRAM addresses of the live save-block pointers (rom-fingerprint.md).
PTR_SAVEBLOCK1 = 0x03005AD0
PTR_SAVEBLOCK2 = 0x03005AD4
PTR_STORAGE = 0x03005AD8

# Vanilla pokeemerald offsets (analysis/structs.json). Overlaid by config files.
VANILLA_OFFSETS = {
    "sb2.playerName":       {"offset": 0x00, "status": "vanilla-unverified"},
    "sb2.playerGender":     {"offset": 0x08, "status": "vanilla-unverified"},
    "sb2.playerTrainerId":  {"offset": 0x0A, "status": "vanilla-unverified"},
    "sb2.playTime":         {"offset": 0x0E, "status": "vanilla-unverified"},
    "sb2.options":          {"offset": 0x14, "status": "vanilla-unverified"},
    "sb2.pokedex":          {"offset": 0x18, "status": "vanilla-unverified"},
    "sb2.encryptionKey":    {"offset": 0xAC, "status": "vanilla-unverified"},
    "sb1.pos":              {"offset": 0x000, "status": "vanilla-unverified"},
    "sb1.location":         {"offset": 0x004, "status": "vanilla-unverified"},
    "sb1.lastHealLocation": {"offset": 0x01C, "status": "vanilla-unverified"},
    "sb1.mapLayoutId":      {"offset": 0x032, "status": "vanilla-unverified"},
    "sb1.partyCount":       {"offset": 0x234, "status": "vanilla-unverified"},
    "sb1.playerParty":      {"offset": 0x238, "status": "vanilla-unverified"},
    # Live party globals at fixed EWRAM addresses (offsets from 0x02000000). The
    # SaveBlock1 party is only a copy-on-save; these are the live state.
    "ewram.partyCount":     {"offset": 0x38559, "status": "vanilla-unverified"},
    "ewram.party":          {"offset": 0x3855C, "status": "vanilla-unverified"},
    "sb1.money":            {"offset": 0x490, "status": "vanilla-unverified"},
    "sb1.coins":            {"offset": 0x494, "status": "vanilla-unverified"},
    "sb1.registeredItem":   {"offset": 0x496, "status": "vanilla-unverified"},
    "sb1.pcItems":          {"offset": 0x498, "status": "vanilla-unverified"},
    "sb1.bagPocket_Items":    {"offset": 0x560, "status": "vanilla-unverified"},
    "sb1.bagPocket_KeyItems": {"offset": 0x5D8, "status": "vanilla-unverified"},
    "sb1.bagPocket_PokeBalls": {"offset": 0x650, "status": "vanilla-unverified"},
    "sb1.bagPocket_TMHM":     {"offset": 0x690, "status": "vanilla-unverified"},
    "sb1.bagPocket_Berries":  {"offset": 0x790, "status": "vanilla-unverified"},
    "sb1.bagPocket_Medicine": {"offset": None,  "status": "vanilla-unverified"},
    # Mail: THREE candidate offsets. Live dumps show the exact vanilla ClearMail
    # 16x36 pattern at SB1+0x1D98 (parsed as primary); static mail-handling code
    # points at ~0x1DB8; load_save-side code claims 0x910 (all-zero live). Slots
    # 0-5 are party mail, 6-15 PC mail. A real mail item would settle it.
    # Deliberately NOT mapped from hack-offsets.json so the contested entries
    # don't override this.
    "sb1.mail":             {"offset": 0x1D98, "status": "empirical-medium"},
    "sb1.berryTrees":       {"offset": 0x1998, "status": "vanilla-unverified"},
    "sb1.flags":            {"offset": 0x1270, "status": "vanilla-unverified"},
    "sb1.vars":             {"offset": 0x139C, "status": "vanilla-unverified"},
    "sb1.gameStats":        {"offset": 0x159C, "status": "vanilla-unverified"},
}

# (output name, config key, default capacity, expected pocket type). Capacities are
# overridden by a config entry's "capacity" field (hack-offsets.json carries the real
# ones). Pocket types are the hack's item-table pocket byte (gamedata.json):
# 1=Items, 2=Medicine, 3=PokeBalls, 4=TM/HM, 5=Berries, 6=KeyItems. The 100-slot
# pocket at gBagPockets[1] is presumed Medicine; the pocket-type cross-check below
# will confirm or refute that once it has contents.
BAG_POCKETS = [
    ("items", "sb1.bagPocket_Items", 30, 1),
    ("keyItems", "sb1.bagPocket_KeyItems", 30, 6),
    ("pokeBalls", "sb1.bagPocket_PokeBalls", 16, 3),
    ("tmHm", "sb1.bagPocket_TMHM", 64, 4),
    ("berries", "sb1.bagPocket_Berries", 46, 5),
    ("medicine", "sb1.bagPocket_Medicine", None, 2),  # hack-only 6th pocket (FRLG-style)
]
PC_ITEMS_COUNT = 50

# Adapter map: hack-offsets.json section/field name -> our dotted config key.
HACK_OFFSETS_KEYMAP = {
    "SaveBlock1": {
        "pos": "sb1.pos", "location": "sb1.location",
        "lastHealLocation": "sb1.lastHealLocation", "mapLayoutId": "sb1.mapLayoutId",
        "playerPartyCount": "sb1.partyCount", "playerParty": "sb1.playerParty",
        "money": "sb1.money", "coins": "sb1.coins",
        "registeredItem": "sb1.registeredItem", "pcItems": "sb1.pcItems",
        "bagPocket_Items": "sb1.bagPocket_Items",
        "bagPocket_KeyItems": "sb1.bagPocket_KeyItems",
        "bagPocket_PokeBalls": "sb1.bagPocket_PokeBalls",
        "bagPocket_TMHM": "sb1.bagPocket_TMHM",
        "bagPocket_Berries": "sb1.bagPocket_Berries",
        "bagPocket_Medicine": "sb1.bagPocket_Medicine",
        "bagPocket_extra100": "sb1.bagPocket_Medicine",  # earlier name for the same pocket
        "flags": "sb1.flags", "vars": "sb1.vars", "gameStats": "sb1.gameStats",
        "berryTrees": "sb1.berryTrees",
    },
    "SaveBlock2": {
        "playerName": "sb2.playerName", "playerGender": "sb2.playerGender",
        "playerTrainerId": "sb2.playerTrainerId", "playTimeHours": "sb2.playTime",
        "options": "sb2.options", "pokedex": "sb2.pokedex",
        "encryptionKey": "sb2.encryptionKey",
    },
}

# PokemonStorage layout (verified fully vanilla for this hack).
STORAGE_BOXES = 14
STORAGE_SLOTS = 30
STORAGE_BOX_MONS = 0x4
STORAGE_BOX_NAMES = 0x8344
STORAGE_WALLPAPERS = 0x83C2

# Badge flags for THIS hack: 0x880-0x887 (badge N = 0x880 + N - 1), i.e. all 8 bits
# of the flags byte at SB1+0x100B. Triple-verified by rom-fingerprint: trainer card
# checks all 8 sequentially, the level-cap check uses badges 2/4/6/8, and HM gating
# matches Kanto (Flash=1, Fly=3, Surf=5, Waterfall=7). Note this base is neither
# vanilla Emerald (0x867) nor FRLG (0x820) -- the hack renumbers flags.
BADGE_FLAGS = list(range(0x880, 0x888))
BADGE_NAMES = ["Boulder", "Cascade", "Thunder", "Rainbow",
               "Soul", "Marsh", "Volcano", "Earth"]

# Progress flags for THIS hack, derived by rom-fingerprint (hack-offsets.json
# progress_flags section) from FlagGet/FlagSet call-site harvesting + disassembly.
# Flags 0x860/0x861/0x87A are set together at starter acquisition, but the real
# 4-badge save (analysis/real-saves/) has 0x860/0x861 SET and 0x87A CLEAR -- so
# 0x87A is cleared again later and is not a progress marker. hasStarterAndDex
# therefore keys on the 0x860/0x861 pair (0x861 gates the full start menu);
# 0x87A is still emitted raw.
STARTER_TRIO_FLAGS = [0x860, 0x861, 0x87A]
STARTER_PAIR = [0x860, 0x861]
FLAG_GAME_CLEAR = 0x864       # champion / Hall of Fame; also releases the level cap
FLAG_INTRO_COMPLETE = 0x89E   # medium confidence
FLAG_STEP_CHARGE = 0x862      # charge feature paired with var 0x40C8 (full > 204)

# Vanilla pokeemerald GAME_STAT enum (constants/game_stat.h). The hack keeps the
# order but relocated the array to SB1+0xB50 and dropped the XOR (live-verified
# on the real save: SAVED_GAME=41, STEPS=28582, TOTAL_BATTLES=328, ...).
GAME_STAT_NAMES = [
    "SAVED_GAME", "FIRST_HOF_PLAY_TIME", "STARTED_TRENDS", "PLANTED_BERRIES",
    "TRADED_BIKES", "STEPS", "GOT_INTERVIEWED", "TOTAL_BATTLES", "WILD_BATTLES",
    "TRAINER_BATTLES", "ENTERED_HOF", "POKEMON_CAPTURES", "FISHING_CAPTURES",
    "HATCHED_EGGS", "EVOLVED_POKEMON", "USED_POKECENTER", "RESTED_AT_HOME",
    "ENTERED_SAFARI_ZONE", "USED_CUT", "USED_ROCK_SMASH", "MOVED_SECRET_BASE",
    "POKEMON_TRADES", "UNKNOWN_22", "LINK_BATTLE_WINS", "LINK_BATTLE_LOSSES",
    "LINK_BATTLE_DRAWS", "USED_SPLASH", "USED_STRUGGLE", "SLOT_JACKPOTS",
    "CONSECUTIVE_ROULETTE_WINS", "ENTERED_BATTLE_TOWER", "UNKNOWN_31",
    "BATTLE_TOWER_BEST_STREAK", "POKEBLOCKS", "POKEBLOCKS_WITH_FRIENDS",
    "WON_LINK_CONTEST", "ENTERED_CONTEST", "WON_CONTEST", "SHOPPED",
    "USED_ITEMFINDER", "GOT_RAINED_ON", "CHECKED_POKEDEX", "RECEIVED_RIBBONS",
    "JUMPED_DOWN_LEDGES", "WATCHED_TV", "CHECKED_CLOCK", "WON_POKEMON_LOTTERY",
    "USED_DAYCARE", "RODE_CABLE_CAR", "ENTERED_HOT_SPRINGS",
    "NUM_UNION_ROOM_BATTLES", "PLAYED_BERRY_CRUSH",
]

# Story counter var (rom-fingerprint script dig, hack-offsets.md): var 0x405D
# tracks the Lavender/Celadon Rocket arc.
VAR_STORY_ROCKET = 0x405D
STORY_ROCKET_LABELS = {
    0: "not started",
    1: "rival beaten in Pokemon Tower",
    2: "Lavender grunt cutscene seen",
    3: "later beat",
}

# Rival name string (SB2+0x6E2, after the challenge-options u16 at 0x6E0).
# Real save reads "Kennedy" while the player is "Eric".
RIVAL_NAME_OFF = 0x6E2
VAR_STEP_CHARGE = 0x40C8

# Level-cap mechanism (hack-offsets.json derived_level_caps, fn @0x08168708):
# gameClear -> 100; challenge byte (SB2+0x6E0) bit2 clear -> 100; else
# table[badgeCount], +modifier[badgeCount] when (byte & 3) == 1.
CHALLENGE_OPTIONS_OFF = 0x6E0  # SB2 offset of the challenge-options byte
LEVEL_CAP_BY_BADGES = [14, 21, 24, 29, 43, 43, 47, 50, 63]
LEVEL_CAP_MODE1_MOD = [1, 1, 2, 2, 3, 3, 4, 4, 4]

NATURES = [
    "Hardy", "Lonely", "Brave", "Adamant", "Naughty",
    "Bold", "Docile", "Relaxed", "Impish", "Lax",
    "Timid", "Hasty", "Serious", "Jolly", "Naive",
    "Modest", "Mild", "Quiet", "Bashful", "Rash",
    "Calm", "Gentle", "Sassy", "Careful", "Quirky",
]

MAX_SPECIES = 411   # vanilla Gen 3 internal range (rom-fingerprint: no expansion)
MAX_ITEM = 410      # hack's expanded item table is ~409 entries
MAX_MONEY = 999999
MAX_COINS = 9999
MAX_BAG_QTY = 999


def u8(buf, off):
    return buf[off]


def u16(buf, off):
    return struct.unpack_from("<H", buf, off)[0]


def u32(buf, off):
    return struct.unpack_from("<I", buf, off)[0]


def s16(buf, off):
    return struct.unpack_from("<h", buf, off)[0]


def s8(buf, off):
    return struct.unpack_from("<b", buf, off)[0]


class Config:
    """Layered offset configuration with provenance tracking."""

    def __init__(self):
        self.entries = {k: dict(v, source="vanilla") for k, v in VANILLA_OFFSETS.items()}
        self.layers_loaded = []

    def load_file(self, path, source):
        if not os.path.exists(path):
            return False
        with open(path) as f:
            data = json.load(f)
        if any(sect in data for sect in HACK_OFFSETS_KEYMAP):
            n = self._load_hack_offsets(data, source)
        else:
            n = self._load_flat(data, source)
        self.layers_loaded.append({"file": path, "source": source, "entries": n})
        return True

    def _load_flat(self, data, source):
        """Our own flat schema: {"offsets": {"sb1.money": {"offset":..,"status":..}}}."""
        offsets = data.get("offsets", data)
        n = 0
        for key, val in offsets.items():
            if key.startswith("_") or not isinstance(val, dict) or "offset" not in val:
                continue
            self.entries[key] = {
                "offset": val["offset"],
                "status": val.get("status", "override"),
                "capacity": val.get("capacity"),
                "evidence": val.get("evidence"),
                "source": source,
            }
            n += 1
        return n

    def _load_hack_offsets(self, data, source):
        """analysis/hack-offsets.json schema: per-struct sections whose entries carry
        hack_offset (hex string or null), confidence, and a type like ItemSlot[60]."""
        n = 0
        # Live-party EWRAM symbols (fixed addresses, not ASLR-shifted).
        for sym, key in (("gPlayerPartyCount", "ewram.partyCount"),
                         ("gPlayerParty", "ewram.party")):
            entry = data.get("ewram_symbols", {}).get(sym)
            if isinstance(entry, dict) and "addr" in entry:
                self.entries[key] = {
                    "offset": int(entry["addr"], 0) - EWRAM_BASE,
                    "status": "rom:%s" % entry.get("confidence", "unknown"),
                    "evidence": entry.get("note"),
                    "source": source,
                }
                n += 1
        for sect, keymap in HACK_OFFSETS_KEYMAP.items():
            for name, entry in data.get(sect, {}).items():
                key = keymap.get(name)
                if key is None or not isinstance(entry, dict) or "hack_offset" not in entry:
                    continue
                off = entry["hack_offset"]
                if isinstance(off, str):
                    off = int(off, 0)
                if off == -1:
                    off = None
                capacity = None
                m = re.search(r"\[(\d+)\]", entry.get("type", "") or "")
                if m:
                    capacity = int(m.group(1))
                self.entries[key] = {
                    "offset": off,
                    "status": "rom:%s" % entry.get("confidence", "unknown"),
                    "capacity": capacity,
                    "evidence": entry.get("evidence") or entry.get("note"),
                    "source": source,
                }
                n += 1
        return n

    def off(self, key):
        return self.entries[key]["offset"]

    def status(self, key):
        return self.entries[key]["status"]

    def capacity(self, key, default):
        return self.entries[key].get("capacity") or default

    def trusted(self, key):
        """True when the offset comes from real evidence (dump verification or ROM
        disassembly), not an unexercised vanilla assumption."""
        return (self.entries[key]["offset"] is not None and
                self.entries[key]["status"] not in
                ("vanilla-unverified", "unverified-reorganized", "rom:unknown"))

    def describe(self, *keys):
        return {
            k: {"offset": self.entries[k]["offset"], "status": self.entries[k]["status"],
                "source": self.entries[k]["source"]}
            for k in keys if k in self.entries
        }


class GameData:
    """Optional name tables from analysis/gamedata.json (tolerant of schema)."""

    def __init__(self, path):
        self.tables = {}
        if path and os.path.exists(path):
            with open(path) as f:
                raw = json.load(f)
            for key in ("species", "items", "item_pockets", "moves", "maps",
                        "abilities", "natures"):
                if key in raw:
                    self.tables[key] = raw[key]
        self.loaded = bool(self.tables)

    def _lookup(self, table, key):
        tab = self.tables.get(table)
        if tab is None:
            return None
        if isinstance(tab, list):
            return tab[key] if isinstance(key, int) and 0 <= key < len(tab) else None
        return tab.get(str(key), tab.get(key) if not isinstance(key, str) else None)

    def species(self, sid):
        return self._lookup("species", sid)

    def item(self, iid):
        return self._lookup("items", iid)

    def move(self, mid):
        return self._lookup("moves", mid)

    def item_pocket(self, iid):
        """The hack item table's pocket byte for an item id, or None."""
        return self._lookup("item_pockets", iid)

    def map_entry(self, group, num):
        """Return the maps-table entry (dict or name string) for (group, num)."""
        tab = self.tables.get("maps")
        if tab is None:
            return None
        for key in ("%d,%d" % (group, num), "%d.%d" % (group, num), "(%d,%d)" % (group, num)):
            if isinstance(tab, dict) and key in tab:
                return tab[key]
        if isinstance(tab, dict):
            grp = tab.get(str(group))
            if isinstance(grp, list) and num < len(grp):
                return grp[num]
            if isinstance(grp, dict):
                return grp.get(str(num))
        return None


def load_charmap_and_permutation():
    path = os.path.join(ANALYSIS_DIR, "structs.json")
    with open(path) as f:
        data = json.load(f)
    charmap = {int(k, 16): v for k, v in data["charmap"].items()}
    perm = {int(k): v for k, v in data["substruct_permutation"]["type_to_slot"].items()}
    return charmap, perm


CHARMAP, TYPE_TO_SLOT = load_charmap_and_permutation()


def decode_text(buf):
    """Decode Gen-3 encoded text, stopping at 0xFF."""
    out = []
    for b in buf:
        if b == 0xFF:
            break
        out.append(CHARMAP.get(b, "?"))
    return "".join(out)


def text_is_clean(buf):
    """True if the region decodes without unmapped bytes and terminates/fills sanely."""
    seen_char = False
    for b in buf:
        if b == 0xFF:
            return seen_char
        if b not in CHARMAP or CHARMAP[b] == "\n":
            return False
        seen_char = True
    return seen_char  # full-length name with no terminator is legal for nicknames


# ---------------------------------------------------------------------------
# Pokemon parsing


def decrypt_secure(box, personality, ot_id):
    key = personality ^ ot_id
    sec = bytearray(box[0x20:0x50])
    for i in range(0, 48, 4):
        struct.pack_into("<I", sec, i, u32(sec, i) ^ key)
    return bytes(sec)


def checksum16(sec):
    return sum(struct.unpack("<24H", sec)) & 0xFFFF


def parse_box_pokemon(buf, off, gamedata):
    """Parse an 80-byte BoxPokemon. Returns None for an empty slot, else a dict
    with parsed fields; dict contains "error" if the checksum fails (Bad Egg)."""
    box = bytes(buf[off:off + 80])
    personality = u32(box, 0)
    ot_id = u32(box, 4)
    flags = box[19]
    has_species = (flags >> 1) & 1
    if personality == 0 and ot_id == 0 and not has_species:
        return None

    sec = decrypt_secure(box, personality, ot_id)
    calc = checksum16(sec)
    stored = u16(box, 28)
    mon = {
        "personality": personality,
        "otId": ot_id,
        "nickname": decode_text(box[8:18]),
        "language": box[18],
        "isBadEgg": bool(flags & 1),
        "isEgg": bool((flags >> 2) & 1),
        "otName": decode_text(box[20:27]),
        "markings": box[27],
        "checksumValid": calc == stored,
    }
    if calc != stored:
        mon["error"] = "substruct checksum mismatch (stored 0x%04X, computed 0x%04X) -- Bad Egg / corrupt" % (stored, calc)
        return mon

    slots = TYPE_TO_SLOT[personality % 24]
    growth = sec[slots[0] * 12:slots[0] * 12 + 12]
    attacks = sec[slots[1] * 12:slots[1] * 12 + 12]
    evs = sec[slots[2] * 12:slots[2] * 12 + 12]
    misc = sec[slots[3] * 12:slots[3] * 12 + 12]

    species = u16(growth, 0)
    if species == 0:
        return None
    held_item = u16(growth, 2)
    mon["species"] = species
    name = gamedata.species(species)
    if name:
        mon["speciesName"] = name
    mon["heldItem"] = held_item
    iname = gamedata.item(held_item)
    if held_item and iname:
        mon["heldItemName"] = iname
    mon["experience"] = u32(growth, 4)
    mon["ppBonuses"] = growth[8]
    mon["friendship"] = growth[9]

    moves = []
    for i in range(4):
        mid = u16(attacks, i * 2)
        if mid == 0:
            continue
        m = {"move": mid, "pp": attacks[8 + i]}
        mname = gamedata.move(mid)
        if mname:
            m["name"] = mname
        moves.append(m)
    mon["moves"] = moves

    mon["evs"] = {
        "hp": evs[0], "attack": evs[1], "defense": evs[2],
        "speed": evs[3], "spAttack": evs[4], "spDefense": evs[5],
    }
    mon["condition"] = {
        "cool": evs[6], "beauty": evs[7], "cute": evs[8],
        "smart": evs[9], "tough": evs[10], "sheen": evs[11],
    }

    mon["pokerus"] = misc[0]
    mon["metLocation"] = misc[1]
    origins = u16(misc, 2)
    mon["metLevel"] = origins & 0x7F
    mon["metGame"] = (origins >> 7) & 0xF
    mon["pokeball"] = (origins >> 11) & 0xF
    mon["otGender"] = (origins >> 15) & 1
    ivword = u32(misc, 4)
    mon["ivs"] = {
        "hp": ivword & 31, "attack": (ivword >> 5) & 31, "defense": (ivword >> 10) & 31,
        "speed": (ivword >> 15) & 31, "spAttack": (ivword >> 20) & 31,
        "spDefense": (ivword >> 25) & 31,
    }
    mon["isEggIV"] = bool((ivword >> 30) & 1)
    mon["abilityNum"] = (ivword >> 31) & 1

    tid = ot_id & 0xFFFF
    sid = ot_id >> 16
    mon["shiny"] = (tid ^ sid ^ (personality >> 16) ^ (personality & 0xFFFF)) < 8
    mon["nature"] = NATURES[personality % 25]
    return mon


def parse_party_pokemon(buf, off, gamedata):
    """Parse a 100-byte party Pokemon (BoxPokemon + unencrypted battle section)."""
    mon = parse_box_pokemon(buf, off, gamedata)
    if mon is None:
        return None
    status = u32(buf, off + 80)
    mon["status"] = {
        "raw": status,
        "sleepTurns": status & 7,
        "poison": bool(status & 0x08),
        "burn": bool(status & 0x10),
        "freeze": bool(status & 0x20),
        "paralysis": bool(status & 0x40),
        "badPoison": bool(status & 0x80),
    }
    mon["level"] = buf[off + 84]
    mon["hp"] = u16(buf, off + 86)
    mon["stats"] = {
        "maxHP": u16(buf, off + 88),
        "attack": u16(buf, off + 90),
        "defense": u16(buf, off + 92),
        "speed": u16(buf, off + 94),
        "spAttack": u16(buf, off + 96),
        "spDefense": u16(buf, off + 98),
    }
    return mon


# ---------------------------------------------------------------------------
# Dump loading


class Dump:
    def __init__(self, iwram, ewram):
        self.iwram = iwram
        self.ewram = ewram

    def deref(self, iwram_addr):
        """Read a 32-bit pointer from IWRAM; return EWRAM offset or None."""
        off = iwram_addr - IWRAM_BASE
        if not (0 <= off <= IWRAM_SIZE - 4):
            return None, 0
        ptr = u32(self.iwram, off)
        if EWRAM_BASE <= ptr < EWRAM_BASE + EWRAM_SIZE:
            return ptr - EWRAM_BASE, ptr
        return None, ptr


class DumpError(Exception):
    """Input file problem (missing/truncated/unparseable) -- reported as a JSON
    error object per the explicit-error contract, never a raw traceback."""


def load_dump(target, ewram_path):
    if os.path.isdir(target):
        iwram_path = os.path.join(target, "iwram.bin")
        ewram_path = ewram_path or os.path.join(target, "ewram.bin")
    else:
        iwram_path = target
        if not ewram_path:
            ewram_path = os.path.join(os.path.dirname(target), "ewram.bin")
    for p, want in ((iwram_path, IWRAM_SIZE), (ewram_path, EWRAM_SIZE)):
        if not os.path.exists(p):
            raise DumpError("missing dump file: %s" % p)
        size = os.path.getsize(p)
        if size < want:
            raise DumpError("dump truncated: %s is %d bytes (expected %d)"
                            % (p, size, want))
        if size > want:
            sys.stderr.write("warning: %s is %d bytes (expected %d); using the "
                             "first %d\n" % (p, size, want, want))
    with open(iwram_path, "rb") as f:
        iwram = f.read(IWRAM_SIZE)
    with open(ewram_path, "rb") as f:
        ewram = f.read(EWRAM_SIZE)
    return Dump(iwram, ewram)


# ---------------------------------------------------------------------------
# Section parsers


def find_encryption_key(ew, sb2, sb1, cfg, meta):
    """Return (key, note). Reads the configured offset and cross-validates it
    against money/coins plausibility; on failure scans SB2 for a working key.
    A configured offset of null means the hack removed save-data encryption."""
    key_off = cfg.off("sb2.encryptionKey")
    if key_off is None:
        return 0, "hack removed save-data encryption (money confirmed plaintext by ROM disassembly)"
    key = u32(ew, sb2 + key_off)
    money_raw = u32(ew, sb1 + cfg.off("sb1.money"))
    coins_raw = u16(ew, sb1 + cfg.off("sb1.coins"))

    def key_works(k):
        return (money_raw ^ k) <= MAX_MONEY and (coins_raw ^ (k & 0xFFFF)) <= MAX_COINS

    if key_works(key):
        note = "configured offset +0x%X" % key_off
        if key == 0:
            note += " (key is 0: fresh save, location not actually exercised)"
        return key, note

    # Configured location fails validation -- scan SB2 for a candidate key.
    candidates = []
    for off in range(0x90, SB2_SIZE, 4):
        k = u32(ew, sb2 + off)
        if k and key_works(k):
            candidates.append((off, k))
    if len(candidates) == 1:
        off, k = candidates[0]
        meta["discovered"].append({
            "field": "sb2.encryptionKey", "offset": off,
            "note": "runtime scan: configured +0x%X failed validation" % key_off})
        return k, "RELOCATED: found by scan at SB2+0x%X" % off
    return None, ("no unique key found (configured +0x%X invalid, %d scan candidates)"
                  % (key_off, len(candidates)))


def scan_for_mons(ew, sb1, sb1_size, gamedata, exclude):
    """Scan SaveBlock1 for checksum-valid encrypted Pokemon at any 4-aligned offset.
    Used to locate a relocated party. `exclude` is a set of known offsets to skip."""
    found = []
    end = min(sb1 + sb1_size, len(ew)) - 80
    for off in range(sb1, end, 4):
        pers = u32(ew, off)
        otid = u32(ew, off + 4)
        if pers == 0 and otid == 0:
            continue
        rel = off - sb1
        if rel in exclude:
            continue
        sec = decrypt_secure(ew[off:off + 80], pers, otid)
        if checksum16(sec) != u16(ew, off + 28):
            continue
        slots = TYPE_TO_SLOT[pers % 24]
        species = u16(sec, slots[0] * 12)
        if 1 <= species <= MAX_SPECIES:
            found.append(rel)
    return found


def parse_item_slots(ew, base, count, key16, encrypted, gamedata):
    """Parse ItemSlot[count]; returns (slots, ok, bad_reason)."""
    slots = []
    for i in range(count):
        item_id = u16(ew, base + i * 4)
        qty = u16(ew, base + i * 4 + 2)
        if encrypted:
            qty ^= key16
        if item_id == 0:
            continue
        slot = {"itemId": item_id, "quantity": qty}
        name = gamedata.item(item_id)
        if name:
            slot["name"] = name
        slots.append(slot)
        if item_id > MAX_ITEM or qty > MAX_BAG_QTY or qty == 0:
            return slots, False, ("slot %d implausible (itemId=%d qty=%d)"
                                  % (i, item_id, qty))
    return slots, True, None


def bit(arr, n):
    return (arr[n >> 3] >> (n & 7)) & 1


def dex_list(bits):
    return [n + 1 for n in range(len(bits) * 8) if (bits[n >> 3] >> (n & 7)) & 1]


UNVERIFIED_SB1 = ("offset unverified -- the hack reorganized SaveBlock1 internals "
                  "(see meta.offsets); refusing to emit values that would be silent "
                  "garbage. Provide analysis/hack-offsets.json to enable this section.")


def parse_state(dump, cfg, gamedata, do_scan=True):
    ew = dump.ewram
    meta = {
        "tool": "parse_ram.py",
        "config_layers": cfg.layers_loaded,
        "gamedata_loaded": gamedata.loaded,
        "anchors": [],
        "discovered": [],
        "confidence": {},
    }
    state = {"meta": meta}

    def anchor(name, ok, detail):
        meta["anchors"].append({"anchor": name, "ok": bool(ok), "detail": detail})
        return ok

    # --- resolve pointers -------------------------------------------------
    sb1, p1 = dump.deref(PTR_SAVEBLOCK1)
    sb2, p2 = dump.deref(PTR_SAVEBLOCK2)
    ps, p3 = dump.deref(PTR_STORAGE)
    meta["pointers"] = {
        "gSaveBlock1Ptr": "0x%08X" % p1,
        "gSaveBlock2Ptr": "0x%08X" % p2,
        "gPokemonStoragePtr": "0x%08X" % p3,
    }
    if sb1 is None or sb2 is None or ps is None or len({p1, p2, p3}) != 3:
        state["inGame"] = False
        state["error"] = "save block pointers do not resolve to distinct EWRAM addresses -- no game state"
        return state

    # --- in-game detection: content anchors, not pointers -----------------
    # (pre-game dumps have valid pointers to zero-filled blocks)
    name_bytes = ew[sb2 + cfg.off("sb2.playerName"):sb2 + cfg.off("sb2.playerName") + 8]
    name_ok = name_bytes[0] not in (0x00, 0xFF) and text_is_clean(name_bytes)
    tid_raw = u32(ew, sb2 + cfg.off("sb2.playerTrainerId"))
    pt_off = cfg.off("sb2.playTime")
    playtime = (u16(ew, sb2 + pt_off), ew[sb2 + pt_off + 2], ew[sb2 + pt_off + 3])
    anchor("sb2.playerName decodes", name_ok, repr(decode_text(name_bytes)))
    anchor("sb2 trainerId/playtime nonzero", tid_raw != 0 or any(playtime),
           "tid=%d playtime=%d:%02d:%02d" % (tid_raw & 0xFFFF, *playtime))
    if not (name_ok and (tid_raw != 0 or any(playtime))):
        state["inGame"] = False
        if not name_ok and tid_raw == 0 and not any(playtime):
            state["error"] = ("no game state: save blocks are zero-filled "
                              "(title screen / intro, no save loaded)")
        else:
            state["error"] = ("no game state: save blocks only partially initialized "
                              "(new-game intro/naming in progress)")
        return state
    state["inGame"] = True

    # --- encryption key ---------------------------------------------------
    key, key_note = find_encryption_key(ew, sb2, sb1, cfg, meta)
    meta["encryptionKey"] = {"value": key, "note": key_note}
    if key is None:
        key = 0
    key16 = key & 0xFFFF

    # --- player -----------------------------------------------------------
    money = u32(ew, sb1 + cfg.off("sb1.money")) ^ key
    coins = u16(ew, sb1 + cfg.off("sb1.coins")) ^ key16
    money_ok = anchor("sb1.money plausible", money <= MAX_MONEY, str(money))
    state["player"] = {
        "name": decode_text(name_bytes),
        "gender": "female" if ew[sb2 + cfg.off("sb2.playerGender")] else "male",
        "trainerId": tid_raw & 0xFFFF,
        "secretId": tid_raw >> 16,
        "money": money if money_ok else None,
        "coins": coins if coins <= MAX_COINS else None,
        "playTime": {"hours": playtime[0], "minutes": playtime[1], "seconds": playtime[2]},
    }
    meta["confidence"]["player"] = (
        "high" if name_ok and money_ok and cfg.trusted("sb1.money") else "medium")

    # --- location ---------------------------------------------------------
    loc_off = sb1 + cfg.off("sb1.location")
    map_group = s8(ew, loc_off)
    map_num = s8(ew, loc_off + 1)
    state["location"] = {
        "mapGroup": map_group,
        "mapNum": map_num,
        "warpId": s8(ew, loc_off + 2),
        "x": s16(ew, sb1 + cfg.off("sb1.pos")),
        "y": s16(ew, sb1 + cfg.off("sb1.pos") + 2),
        "mapLayoutId": u16(ew, sb1 + cfg.off("sb1.mapLayoutId")),
    }
    entry = gamedata.map_entry(map_group, map_num)
    loc_conf = "medium (plausible values)"
    if isinstance(entry, str):
        state["location"]["mapName"] = entry
    elif isinstance(entry, dict):
        if entry.get("name"):
            state["location"]["mapName"] = entry["name"]
        if "layout_id" in entry:
            # Strong cross-check: the ROM header's layout id for (group,num) must
            # equal the layout id stored in SaveBlock1.
            match = entry["layout_id"] == state["location"]["mapLayoutId"]
            anchor("sb1.mapLayoutId matches ROM map header", match,
                   "SB1 says %d, ROM header for (%d,%d) says %d"
                   % (state["location"]["mapLayoutId"], map_group, map_num,
                      entry["layout_id"]))
            loc_conf = ("high (layout id cross-checked against ROM map header)"
                        if match else "suspect (layout id mismatch)")
    anchor("sb1.location plausible", 0 <= map_group < 64 and 0 <= map_num < 128,
           "map (%d,%d) pos (%d,%d)" % (map_group, map_num,
                                        state["location"]["x"], state["location"]["y"]))
    meta["confidence"]["location"] = loc_conf

    # --- party ------------------------------------------------------------
    # The live party lives in fixed EWRAM globals (gPlayerPartyCount/gPlayerParty);
    # SaveBlock1's party is only a copy taken when the game saves. The hack
    # likely autosaves (17 idle ASLR reshuffles observed, and vanilla only
    # reshuffles on save -- though no save counter was confirmed), which would
    # keep the saved copy fresh; the live globals are authoritative either way.
    def parse_party(count_abs, party_abs, source_label, count_key, party_key):
        count = ew[count_abs]
        section = {"source": source_label, "count": count, "pokemon": []}
        if count > 6:
            section["count"] = None
            section["error"] = ("partyCount=%d at configured offset is invalid "
                                "(offset likely wrong)" % count)
            return section, "failed", count
        for i in range(count):
            mon = parse_party_pokemon(ew, party_abs + i * 100, gamedata)
            section["pokemon"].append(
                mon if mon is not None else {"error": "empty slot within partyCount range"})
        valid = [m for m in section["pokemon"] if m and m.get("checksumValid")]
        if count and len(valid) != count:
            section["error"] = "party checksums failed at configured offset"
            return section, "failed", count
        if count == 0:
            conf = ("vacuous (party empty; offsets are %s / %s -- checksum "
                    "validation could not be exercised)"
                    % (cfg.status(count_key), cfg.status(party_key)))
        else:
            conf = "high (checksums validated)"
        return section, conf, count

    live, live_conf, live_count = parse_party(
        cfg.off("ewram.partyCount"), cfg.off("ewram.party"),
        "live: gPlayerParty @ 0x%08X" % (EWRAM_BASE + cfg.off("ewram.party")),
        "ewram.partyCount", "ewram.party")
    saved, saved_conf, saved_count = parse_party(
        sb1 + cfg.off("sb1.partyCount"), sb1 + cfg.off("sb1.playerParty"),
        "SaveBlock1+0x%X (copy as of last save; the hack likely autosaves)"
        % cfg.off("sb1.playerParty"),
        "sb1.partyCount", "sb1.playerParty")
    state["party"] = live
    state["savedParty"] = saved
    if live_count != saved_count:
        state["savedParty"]["note"] = ("differs from live party (saved count %s vs "
                                       "live %s) -- state changed since last save"
                                       % (saved_count, live_count))
    if "error" in saved and do_scan:
        # Saved-party checksums failed -- scan SB1 for relocated mons.
        hits = scan_for_mons(ew, sb1, SB1_SIZE, gamedata, exclude=set())
        if hits:
            meta["discovered"].append({
                "field": "sb1.playerParty(candidates)",
                "offsets": ["0x%X" % h for h in hits],
                "note": "checksum-valid mons found by scan; configured saved-party offset failed"})
    meta["confidence"]["party"] = live_conf
    meta["confidence"]["savedParty"] = saved_conf
    party_count = live_count if live_count is not None else 0
    anchor("party counts 0..6", (live_count or 0) <= 6 and (saved_count or 0) <= 6,
           "live=%s saved=%s" % (live_count, saved_count))

    # --- PC storage (verified fully vanilla) ------------------------------
    boxes = []
    total_stored = 0
    for b in range(STORAGE_BOXES):
        name = decode_text(ew[ps + STORAGE_BOX_NAMES + b * 9: ps + STORAGE_BOX_NAMES + b * 9 + 9])
        mons = []
        for s in range(STORAGE_SLOTS):
            off = ps + STORAGE_BOX_MONS + (b * STORAGE_SLOTS + s) * 80
            mon = parse_box_pokemon(ew, off, gamedata)
            if mon is not None:
                mon["slot"] = s
                mons.append(mon)
        total_stored += len(mons)
        boxes.append({"box": b + 1, "name": name, "wallpaper": ew[ps + STORAGE_WALLPAPERS + b],
                      "pokemon": mons})
    state["pcBoxes"] = {
        "currentBox": ew[ps] + 1,
        "totalStored": total_stored,
        "boxes": boxes,
    }
    names_ok = all(text_is_clean(ew[ps + STORAGE_BOX_NAMES + b * 9: ps + STORAGE_BOX_NAMES + b * 9 + 9])
                   for b in range(STORAGE_BOXES))
    anchor("storage box names decode", names_ok,
           ", ".join(bx["name"] for bx in boxes[:3]) + ", ...")
    bad = sum(1 for bx in boxes for m in bx["pokemon"] if not m.get("checksumValid"))
    meta["confidence"]["pcBoxes"] = (
        "high (layout verified vanilla; %d mons, %d checksum failures)" % (total_stored, bad)
        if names_ok else "failed (box names do not decode)")

    # --- bag + PC items ---------------------------------------------------
    bag_status = cfg.status("sb1.bagPocket_Items")
    bag = {}
    bag_ok = True
    bag_notes = []
    pocket_mismatches = []
    for out_name, key_name, default_cap, pocket_type in BAG_POCKETS:
        if cfg.off(key_name) is None:
            continue
        capacity = cfg.capacity(key_name, default_cap)
        slots, ok, reason = parse_item_slots(ew, sb1 + cfg.off(key_name), capacity,
                                             key16, True, gamedata)
        bag[out_name] = slots
        if not ok:
            bag_ok = False
            bag_notes.append("%s: %s" % (out_name, reason))
        # Cross-check pocket boundaries: the item table assigns each item id a
        # pocket type; an item stored in the wrong pocket suggests the boundary
        # offsets (or the pocket-name assignment) are wrong. Warning only, not an
        # error: RAM injection / cheats can legitimately place items in the wrong
        # pocket while the slot data itself parses fine.
        for slot in slots:
            expected = gamedata.item_pocket(slot["itemId"])
            if expected is not None and expected != pocket_type:
                pocket_mismatches.append(
                    "%s has item %d (%s) whose table pocket is %d, expected %d"
                    % (out_name, slot["itemId"], slot.get("name", "?"),
                       expected, pocket_type))
    state["bag"] = bag
    reg_item = u16(ew, sb1 + cfg.off("sb1.registeredItem"))
    state["bag"]["registeredItem"] = reg_item or None
    if reg_item:
        reg_name = gamedata.item(reg_item)
        if reg_name:
            state["bag"]["registeredItemName"] = reg_name

    pc_slots, pc_ok, pc_reason = parse_item_slots(ew, sb1 + cfg.off("sb1.pcItems"),
                                                  cfg.capacity("sb1.pcItems", PC_ITEMS_COUNT),
                                                  0, False, gamedata)
    state["pcItems"] = pc_slots
    n_bag = sum(len(v) for v in bag.values() if isinstance(v, list))
    if pocket_mismatches:
        state["bag"]["warning"] = (
            "pocket-type mismatch (wrong-pocket items -- injected/cheated save, or "
            "pocket assignment wrong): " + "; ".join(pocket_mismatches))
    if not bag_ok:
        state["bag"]["error"] = ("bag validation failed -- pocket offsets/capacities "
                                 "likely wrong: " + "; ".join(bag_notes))
        meta["confidence"]["bag"] = "failed"
    elif pocket_mismatches:
        meta["confidence"]["bag"] = ("suspect (slots parse but %d item(s) sit in a "
                                     "pocket that disagrees with the item table)"
                                     % len(pocket_mismatches))
    elif n_bag == 0:
        meta["confidence"]["bag"] = "vacuous (bag empty; offsets are %s)" % bag_status
    else:
        meta["confidence"]["bag"] = "medium (slots plausible; offsets are %s)" % bag_status
    pc_status = cfg.status("sb1.pcItems")
    meta["confidence"]["pcItems"] = (
        "failed: " + pc_reason if not pc_ok else
        ("vacuous (empty; offsets are %s)" % pc_status if not pc_slots
         else "medium (slots plausible; offsets are %s)" % pc_status))

    # --- Pokedex (SB2 primary copy) ---------------------------------------
    dex_off = sb2 + cfg.off("sb2.pokedex")
    owned_bits = ew[dex_off + 16:dex_off + 68]
    seen_bits = ew[dex_off + 68:dex_off + 120]
    owned = dex_list(owned_bits)
    seen = dex_list(seen_bits)
    national = ew[dex_off + 2] == 0xDA
    state["pokedex"] = {
        "ownedCount": len(owned),
        "seenCount": len(seen),
        "owned": owned,
        "seen": seen,
        "nationalMagicSet": national,
    }
    subset_ok = set(owned) <= set(seen) or (not owned)
    bit_note = ("bit convention CONFIRMED vanilla (species N -> bit N-1) on the "
                "real save: all 6 party species read owned+seen under it, 5/6 "
                "would fail under bit-N. SB1 seen-mirrors are removed; only these "
                "SB2 arrays exist, dex loops to 386.")
    state["pokedex"]["note"] = bit_note
    meta["confidence"]["pokedex"] = (
        "vacuous (all zero -- new game; offsets are %s; %s)"
        % (cfg.status("sb2.pokedex"), bit_note)
        if not seen else
        ("high (owned is subset of seen; offsets are %s; %s)"
         % (cfg.status("sb2.pokedex"), bit_note)
         if subset_ok else
         "suspect (owned not a subset of seen -- offset may be wrong)"))

    # --- sections gated on the reorganized SaveBlock1 tail ----------------
    if cfg.trusted("sb1.flags"):
        fl = ew[sb1 + cfg.off("sb1.flags"): sb1 + cfg.off("sb1.flags") + 0x12C]
        state["badges"] = {
            "count": sum(bit(fl, f) for f in BADGE_FLAGS),
            "badges": {name: bool(bit(fl, f))
                       for name, f in zip(BADGE_NAMES, BADGE_FLAGS)},
            "flagIds": ["0x%X" % f for f in BADGE_FLAGS],
        }
        meta["confidence"]["badges"] = (
            "high (hack badge flags 0x880-0x887 triple-verified by disassembly; "
            "flags array at %s)" % cfg.status("sb1.flags"))
        # Progress flags use the hack's own IDs (derived by rom-fingerprint).
        trio = {("0x%X" % f): bool(bit(fl, f)) for f in STARTER_TRIO_FLAGS}
        state["progressFlags"] = {
            "hasStarterAndDex": all(bit(fl, f) for f in STARTER_PAIR),
            "starterTrioFlags": trio,
            "gameClearChampion": bool(bit(fl, FLAG_GAME_CLEAR)),
            "introComplete": bool(bit(fl, FLAG_INTRO_COMPLETE)),
            "nationalDex": {
                "note": "no national-dex flag exists in this hack -- the dex is "
                        "always national (count loop runs to 386 unconditionally)"},
            "stepCharge": {
                "enabled": bool(bit(fl, FLAG_STEP_CHARGE)),
                "steps": u16(ew, sb1 + cfg.off("sb1.vars")
                             + 2 * (VAR_STEP_CHARGE - 0x4000)),
                "fullAt": 205,
            },
        }
        rocket = u16(ew, sb1 + cfg.off("sb1.vars") + 2 * (VAR_STORY_ROCKET - 0x4000))
        state["progressFlags"]["storyRocketArc"] = {
            "value": rocket,
            "meaning": STORY_ROCKET_LABELS.get(rocket, "unknown stage %d" % rocket),
        }
        meta["confidence"]["progressFlags"] = (
            "high for hasStarterAndDex (0x860+0x861, live-confirmed on the real "
            "save) and gameClearChampion; medium for introComplete; 0x87A is set "
            "at starter acquisition but cleared later (real-save evidence), "
            "meaning unknown. Running-shoes has no flag (0x866 refuted; running "
            "appears always-on)")
        state["flagsRawHex"] = fl.hex()

        # Derived level cap (challenge-options byte at SB2+0x6E0).
        chal = ew[sb2 + CHALLENGE_OPTIONS_OFF]
        badge_count = state["badges"]["count"]
        if bit(fl, FLAG_GAME_CLEAR) or not (chal & 0x04):
            cap = 100
        else:
            cap = LEVEL_CAP_BY_BADGES[badge_count]
            if (chal & 0x03) == 1:
                cap += LEVEL_CAP_MODE1_MOD[badge_count]
        state["levelCap"] = {
            "cap": cap,
            "challengeOptions": {
                "raw": chal,
                "levelCapEnabled": bool(chal & 0x04),
                "capMode": chal & 0x03,
                "preChampionFeatureGate": bool(chal & 0x10),
            },
        }
        meta["confidence"]["levelCap"] = (
            "high (mechanism recovered from level-cap fn @0x08168708 + ROM tables)")
    else:
        state["badges"] = {"error": UNVERIFIED_SB1}
        state["progressFlags"] = {"error": UNVERIFIED_SB1}
        meta["confidence"]["badges"] = meta["confidence"]["progressFlags"] = "unverified"

    # --- game clock (hack-specific accelerated day/night clock) -----------
    def read_clock(base):
        return {"day": u16(ew, base), "hour": ew[base + 2],
                "minute": ew[base + 3], "second": ew[base + 4]}
    state["gameClock"] = read_clock(sb2 + GAME_CLOCK_OFF)
    state["gameClock"]["note"] = "accelerated in-game clock, ~9x real time"
    # Archived copy written at the daily rollover (same shape, SB2+0xE0).
    state["gameClock"]["lastDailyRollover"] = read_clock(sb2 + 0xE0)
    meta["confidence"]["gameClock"] = (
        "high (minute/second progression confirmed at 9x rate across dumps; "
        "day/hour nonzero and coherent on the real save)")

    # --- rival name (hack-specific) ---------------------------------------
    state["rivalName"] = decode_text(ew[sb2 + RIVAL_NAME_OFF: sb2 + RIVAL_NAME_OFF + 8])
    meta["confidence"]["rivalName"] = ('high (real save reads the rival\'s name, '
                                      'distinct from the player name)')

    # --- mail -------------------------------------------------------------
    mail_off = sb1 + cfg.off("sb1.mail")
    mail_entries = []
    cleared = 0
    for i in range(16):
        e = ew[mail_off + i * 36: mail_off + (i + 1) * 36]
        # Mail record: words[9] @0, playerName @18, trainerId @26, species u16 @30,
        # itemId u16 @32, 2 bytes padding (QA-verified against the live cleared
        # records: ff x26 + 00 x4 + species 1 @30 + itemId 0 @32).
        item_id = u16(e, 32)
        words = [u16(e, j * 2) for j in range(9)]
        if item_id == 0 and all(w == 0xFFFF for w in words):
            cleared += 1
            continue
        mail_entries.append({
            "slot": i,
            "slotKind": "party" if i < 6 else "pc",
            "itemId": item_id,
            "species": u16(e, 30),
            "playerName": decode_text(e[18:26]),
            "words": words,
        })
    state["mail"] = {"entries": mail_entries, "clearedSlots": cleared}
    meta["confidence"]["mail"] = (
        "medium (offset %s: SB1+0x%X is the best candidate -- the real save shows "
        "the 16x0x24 ClearMail array stride-aligned from here, while 0x910 holds "
        "unrelated non-mail-shaped live data there; no attached mail exists yet to "
        "fully confirm)" % (cfg.status("sb1.mail"), cfg.off("sb1.mail")))

    # --- berry trees ------------------------------------------------------
    bt_off = sb1 + cfg.off("sb1.berryTrees")
    trees = []
    for i in range(128):
        t = ew[bt_off + i * 8: bt_off + (i + 1) * 8]
        if not any(t):
            continue
        trees.append({
            "tree": i,
            "berry": t[0],
            "stage": t[1] & 0x7F,
            "minutesUntilNextStage": u16(t, 2),
            "yield": t[4],
        })
    state["berryTrees"] = trees
    meta["confidence"]["berryTrees"] = (
        "%s (live dumps show real pre-planted tree data at this offset)"
        % cfg.status("sb1.berryTrees"))

    # --- game stats (relocated to SB1+0xB50, unencrypted, vanilla enum) ----
    # (An earlier static-analysis verdict of "removed" was corrected by a
    # real-save diff -- see hack-offsets.json gameStats evidence.)
    if cfg.trusted("sb1.gameStats"):
        gs_off = sb1 + cfg.off("sb1.gameStats")
        raw_stats = [u32(ew, gs_off + i * 4) for i in range(64)]
        named = {}
        for i, v in enumerate(raw_stats):
            if v:
                name = (GAME_STAT_NAMES[i] if i < len(GAME_STAT_NAMES)
                        else "UNKNOWN_%d" % i)
                named[name] = v
        state["gameStats"] = {"named": named, "raw": raw_stats}
        meta["confidence"]["gameStats"] = cfg.status("sb1.gameStats")
    else:
        state["gameStats"] = {"error": "gameStats offset not established for this "
                              "hack; section disabled"}
        meta["confidence"]["gameStats"] = "unverified"

    meta["offsets"] = cfg.describe(
        "sb2.playerName", "sb2.playerTrainerId", "sb2.playTime", "sb2.pokedex",
        "sb2.encryptionKey", "sb1.pos", "sb1.location", "sb1.partyCount",
        "sb1.playerParty", "ewram.partyCount", "ewram.party",
        "sb1.money", "sb1.coins",
        "sb1.registeredItem", "sb1.pcItems", "sb1.bagPocket_Items",
        "sb1.bagPocket_KeyItems", "sb1.bagPocket_PokeBalls", "sb1.bagPocket_TMHM",
        "sb1.bagPocket_Berries", "sb1.bagPocket_Medicine", "sb1.flags", "sb1.vars",
        "sb1.gameStats", "storage")
    return state


def main():
    ap = argparse.ArgumentParser(description="Parse a Pokemon Recharged Yellow RAM dump to JSON.")
    ap.add_argument("target", nargs="?",
                    help="dump directory (iwram.bin+ewram.bin) or path to iwram.bin")
    ap.add_argument("--state", help="mGBA savestate file to parse instead of a dump "
                    "(PNG or raw; extracted via state_extract.py)")
    ap.add_argument("--ewram", help="path to ewram.bin (when target is an iwram file)")
    ap.add_argument("--offsets", help="extra offsets JSON overlay (highest priority)")
    ap.add_argument("--pretty", action="store_true", help="indent the JSON output")
    ap.add_argument("--no-scan", action="store_true",
                    help="skip the relocated-party scan on checksum failure")
    args = ap.parse_args()

    cfg = Config()
    cfg.load_file(os.path.join(TOOLS_DIR, "offsets-discovered.json"), "discovered")
    cfg.load_file(os.path.join(ANALYSIS_DIR, "hack-offsets.json"), "hack-offsets")
    if args.offsets:
        if not cfg.load_file(args.offsets, "cli"):
            raise SystemExit("error: offsets file not found: %s" % args.offsets)

    gamedata = GameData(os.path.join(ANALYSIS_DIR, "gamedata.json"))
    try:
        if args.state:
            import state_extract
            try:
                with open(args.state, "rb") as f:
                    blob = f.read()
                raw = state_extract.deserialize(blob)
            except (OSError, ValueError) as e:
                raise DumpError("savestate: %s" % e)
            dump = Dump(raw[state_extract.IWRAM_OFF:state_extract.IWRAM_OFF + IWRAM_SIZE],
                        raw[state_extract.EWRAM_OFF:state_extract.EWRAM_OFF + EWRAM_SIZE])
        elif args.target:
            dump = load_dump(args.target, args.ewram)
        else:
            ap.error("need a dump target or --state")
        state = parse_state(dump, cfg, gamedata, do_scan=not args.no_scan)
    except DumpError as e:
        json.dump({"error": str(e)}, sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        sys.exit(1)
    json.dump(state, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
