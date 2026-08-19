#!/usr/bin/env python3
"""dump_scripts.py -- dump every event script in the Recharged Yellow ROM to a
readable, greppable tree under research/scripts/.

    python3 research/tools/dump_scripts.py [--rom PATH] [--out DIR]

Walks gMapGroups, collects every script entry point on every map (object
events, background events, coord triggers, map-script tables), decodes each
with gba_script.ScriptDecoder, follows goto/call pointers to reach code that no
event points at directly, and renders it with item/move/flag/var names and
inline dialogue.

Also resolves every `pokemart` product list, and emits derived JSON indexes:

    index/item-sources.json   item name -> where it can be obtained
    index/marts.json          map -> product list
    index/stats.json          coverage + every unresolved opcode encountered

Design rule: never guess. An opcode whose argument widths are unknown for THIS
ROM stops that script and is counted in stats.json rather than being decoded
with vanilla widths that might desynchronize everything after it.
"""

import argparse
import collections
import json
import os
import re
import struct
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
RESEARCH = os.path.dirname(TOOLS)
REPO = os.path.dirname(RESEARCH)

from gba_script import ScriptDecoder, decode_text, BASE  # noqa: E402

DEFAULT_ROM = os.path.join(REPO, "local", "Pokemon Recharged Yellow.gba")
DEFAULT_OUT = os.path.join(RESEARCH, "scripts")

GMAPGROUPS = 0x08B3F134
CMD_TABLE = 0x081F1630
CMD_TABLE_LEN = 235

# Hack customs documented in research/hack-offsets.md.
CUSTOM_SIGS = {
    # Slot 0 is English. Slot 1 has been observed holding Spanish, so the
    # remaining slot->language mapping is NOT known; slots are numbered rather
    # than named to avoid asserting an order that has not been verified against
    # the language byte at SB2+0x91.
    0xE6: ("msgbox_multilang",
           [(1, "type")] + [(4, "text_%d" % i) for i in range(7)]),
    0xE8: ("speakername", [(4, "name")]),
}

# Opcodes vanilla Emerald stubs out but THIS ROM reimplements, whose argument
# widths had to be recovered from the ROM itself. Evidence for each:
#
# Both are CONFIRMED against vendor/pokefirered, which is the right ground truth
# for them: these are FRLG-era commands that Emerald stubs out and this
# FRLG-flavoured hack reimplements. pokefirered/asm/macros/event.inc gives
#   textcolor        .byte 0xc7 + .byte  -> length 2
#   setworldmapflag  .byte 0xd0 + .2byte -> length 3
# and pokefirered's own command table puts them at exactly 0xC7 and 0xD0.
#
# Both were independently recovered from this ROM before that check, and agreed:
# 0xC7 by a sharp empirical fit (length 2 leaves 56 more scripts terminating
# cleanly than the runner-up, vs margins of 0-7 -- noise -- for every opcode that
# stayed unresolved), and 0xD0 by the handler disassembly showing exactly one
# call to the halfword reader at 0x081A578D.
#
# NOTE: FRLG's table has only 214 entries and Emerald's 227, so 0xE3-0xEA are
# genuinely specific to this hack and neither decomp can resolve them.
#
# 0xE3, 0xE4, 0xE5, 0xE7, 0xE9 remain UNRESOLVED on purpose: their empirical
# fits are flat (margin 0-5) and the disassembly estimates are not corroborated.
# They stop their script rather than risk desynchronizing everything after them.
RESOLVED_SIGS = {
    0xC7: ("textcolor", [(1, "color")]),
    0xD0: ("setworldmapflag", [(2, "flag")]),
}
CUSTOM_SIGS.update(RESOLVED_SIGS)

# trainerbattle types whose Nth pointer is an EVENT SCRIPT rather than text.
# (CONTINUE_SCRIPT / _NO_MUSIC use ptr3; the DOUBLE variants use ptr4.) The
# other pointers are text and must NOT be followed as code.
TB_EVENT_PTR = {1: 3, 2: 3, 6: 4, 8: 4}

# Opcodes whose 4-byte argument points at more script code.
FOLLOW_OPS = {"goto", "call", "goto_if", "call_if", "goto_if_set",
              "goto_if_unset"}

# Argument names whose value should render as a symbolic name.
ITEM_ARGS = {"itemId", "item", "index"}
TEXT_ARGS = {"text", "name", "pointer", "ptr1", "ptr2", "ptr3", "ptr4"}

# Flags and vars whose meaning this project has established. Sourced from
# research/hack-offsets.json and hack-offsets.md -- do not add guesses here.
KNOWN_FLAGS = {
    0x860: "STARTER_PROGRESSION_A", 0x861: "STARTER_PROGRESSION_B",
    0x862: "STEP_CHARGE_FEATURE_ENABLED", 0x864: "GAME_CLEAR_CHAMPION",
    0x880: "BADGE1_BOULDER", 0x881: "BADGE2_CASCADE",
    0x882: "BADGE3_THUNDER", 0x883: "BADGE4_RAINBOW",
    0x884: "BADGE5_SOUL", 0x885: "BADGE6_MARSH",
    0x886: "BADGE7_VOLCANO", 0x887: "BADGE8_EARTH",
    0x889: "TRAINER_REMATCH_ENABLED",
}
KNOWN_VARS = {
    0x405D: "ROCKET_STORY_COUNTER",   # 0=not started 1=tower rival 2=Lavender
    0x408E: "CLOCK_LAST_UPDATE_DAY",
    0x40C8: "STEP_CHARGE_COUNTER",
}


def u8(rom, a):
    return rom[a - BASE]


def u16(rom, a):
    return struct.unpack_from("<H", rom, a - BASE)[0]


def u32(rom, a):
    return struct.unpack_from("<I", rom, a - BASE)[0]


def valid(rom, a):
    return BASE <= a < BASE + len(rom)


class Names:
    def __init__(self):
        o = json.load(open(os.path.join(RESEARCH, "script-opcodes.json")))
        c = o.get("constants", {})
        self.callstd = {int(k): v for k, v in c.get("callstd", {}).items()}
        self.movement = {int(k): v for k, v in
                         c.get("movement_actions", {}).items()}
        g = json.load(open(os.path.join(RESEARCH, "gamedata.json")))
        self.items = {int(k): v for k, v in g["items"].items()}
        self.moves = {int(k): v for k, v in g["moves"].items()}
        self.species = {int(k): v for k, v in g["species"].items()}
        self.maps = g["maps"]
        self.mapsec = {int(k): v for k, v in g["mapsec_names"].items()}

    def item(self, i):
        return self.items.get(i, "item_%d" % i)

    def map_label(self, group, num):
        e = self.maps.get("%d,%d" % (group, num))
        if not e:
            return "g%d_m%d" % (group, num), "(unknown map)"
        name = e.get("name") or "map"
        return "g%02d_m%02d_%s" % (group, num, slug(name)), name


def slug(s):
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s or "map"


class Dumper:
    def __init__(self, rom, out, names):
        self.rom, self.out, self.n = rom, out, names
        self.dec = ScriptDecoder(rom, CMD_TABLE, CMD_TABLE_LEN, CUSTOM_SIGS)
        self.stats = collections.Counter()
        self.unknown_hits = collections.Counter()
        self.item_sources = collections.defaultdict(list)
        self.marts = {}
        self.stop_reasons = collections.Counter()

    # -- map walk ---------------------------------------------------------
    def map_headers(self):
        """Yield (group, num, header_addr) using group sizes from gamedata."""
        sizes = collections.Counter(int(k.split(",")[0]) for k in self.n.maps)
        for group in sorted(sizes):
            gptr = u32(self.rom, GMAPGROUPS + 4 * group)
            if not valid(self.rom, gptr):
                continue
            for num in range(sizes[group]):
                hdr = u32(self.rom, gptr + 4 * num)
                if valid(self.rom, hdr):
                    yield group, num, hdr

    def map_entry_points(self, hdr):
        """[(kind, label, addr_or_data)] for every script entry on a map."""
        out = []
        events = u32(self.rom, hdr + 4)
        scripts = u32(self.rom, hdr + 8)
        if valid(self.rom, events):
            nobj, nwarp, ncoord, nbg = (u8(self.rom, events + i) for i in range(4))
            objs = u32(self.rom, events + 4)
            coords = u32(self.rom, events + 12)
            bgs = u32(self.rom, events + 16)
            if valid(self.rom, objs):
                for i in range(nobj):
                    t = objs + 24 * i
                    s = u32(self.rom, t + 0x10)
                    out.append(("object", "object %d (gfx 0x%02X, flag 0x%04X)"
                                % (u8(self.rom, t), u8(self.rom, t + 1),
                                   u16(self.rom, t + 0x14)), s))
            if valid(self.rom, coords):
                for i in range(ncoord):
                    t = coords + 16 * i
                    out.append(("coord", "coord trigger %d (var 0x%04X == %d)"
                                % (i, u16(self.rom, t + 6), u16(self.rom, t + 8)),
                                u32(self.rom, t + 12)))
            if valid(self.rom, bgs):
                for i in range(nbg):
                    t = bgs + 12 * i
                    kind = u8(self.rom, t + 5)
                    if kind == 7:  # hidden item
                        item = u16(self.rom, t + 8)
                        out.append(("hidden", "hidden item at (%d,%d): %s"
                                    % (u16(self.rom, t), u16(self.rom, t + 2),
                                       self.n.item(item)), item))
                    else:
                        out.append(("bg", "sign %d at (%d,%d)"
                                    % (i, u16(self.rom, t), u16(self.rom, t + 2)),
                                    u32(self.rom, t + 8)))
        if valid(self.rom, scripts):
            a = scripts
            for _ in range(16):
                t = u8(self.rom, a)
                if t == 0:
                    break
                p = u32(self.rom, a + 1)
                if t in (2, 4) and valid(self.rom, p):
                    # {var, value, script} triples
                    q = p
                    for _ in range(16):
                        var = u16(self.rom, q)
                        if var == 0:
                            break
                        out.append(("mapscript",
                                    "map script type %d (var 0x%04X == %d)"
                                    % (t, var, u16(self.rom, q + 2)),
                                    u32(self.rom, q + 4)))
                        q += 8
                elif valid(self.rom, p):
                    out.append(("mapscript", "map script type %d" % t, p))
                a += 5
        return out

    # -- rendering --------------------------------------------------------
    def movement_seq(self, addr, limit=32):
        """Decode an applymovement sequence into friendly action names."""
        if not valid(self.rom, addr):
            return None
        out, a = [], addr
        for _ in range(limit):
            if not valid(self.rom, a):
                return None
            b = u8(self.rom, a)
            a += 1
            if b == 0xFE:  # step_end
                return out
            out.append(self.n.movement.get(b, "action_0x%02X" % b))
        return out + ["..."]

    def render_arg(self, name, width, val, inst_name):
        if width == 4 and valid(self.rom, val):
            if name.startswith("text") or name == "name":
                txt, _ = decode_text(self.rom, val)
                if txt is not None:
                    return '%s="%s"' % (name, txt)
            if name == "movements":
                seq = self.movement_seq(val)
                if seq:
                    return "%s=[%s]" % (name, " ".join(seq))
            return "%s=0x%08X" % (name, val)
        if name in ITEM_ARGS and inst_name in (
                "additem", "removeitem", "checkitem", "checkitemspace",
                "addpcitem", "checkpcitem", "giveitem", "finditem"):
            return "%s=%s(%d)" % (name, self.n.item(val), val)
        if name == "species":
            return "%s=%s(%d)" % (name, self.n.species.get(val, "?"), val)
        if name == "move" or inst_name == "buffermovename" and name == "index":
            return "%s=%s(%d)" % (name, self.n.moves.get(val, "?"), val)
        if inst_name in ("callstd", "gotostd", "callstd_if", "gotostd_if") \
                and name == "function":
            known = self.n.callstd.get(val)
            return "%s=%s" % (name, "%s(%d)" % (known, val) if known else val)
        if name in ("flag", "flagId"):
            known = KNOWN_FLAGS.get(val)
            if known:
                return "%s=0x%03X:%s" % (name, val, known)
            # ids >= 0x4000 are volatile "special" flags kept in EWRAM, not save
            return "%s=0x%03X%s" % (name, val, " (temp)" if val >= 0x4000 else "")
        if name == "var":
            known = KNOWN_VARS.get(val)
            return "%s=0x%04X%s" % (name, val, ":" + known if known else "")
        # `destination` is overloaded: a 4-byte script pointer in goto/call
        # (handled above), but a 2-byte VARIABLE id in setvar/copyvar/etc.
        if name in ("destination", "source", "value") and width == 2:
            if val >= 0x4000:
                known = KNOWN_VARS.get(val)
                return "%s=VAR_0x%04X%s" % (name, val,
                                            ":" + known if known else "")
            return "%s=%d" % (name, val)   # a literal, not a var id
        if name == "trainer":
            return "%s=0x%X" % (name, val)
        return "%s=%d" % (name, val)

    def read_mart(self, addr):
        items = []
        a = addr
        for _ in range(64):
            if not valid(self.rom, a):
                break
            i = u16(self.rom, a)
            if i == 0:
                break
            items.append(i)
            a += 2
        return items

    def dump_script(self, addr, seen, lines, maplabel):
        """Decode addr and everything reachable from it, breadth-first.

        A worklist rather than bounded recursion: script graphs in this ROM nest
        deeper than any sane recursion cap (a depth-6 cap truncated 206 of them),
        and the visited set already guarantees termination.
        """
        queue = [addr]
        while queue:
            cur = queue.pop(0)
            if cur in seen or not valid(self.rom, cur):
                continue
            self._dump_one(cur, seen, lines, maplabel, queue)

    def _dump_one(self, addr, seen, lines, maplabel, queue):
        seen.add(addr)
        ins, why = self.dec.decode(addr)
        self.stop_reasons[why] += 1
        self.stats["scripts"] += 1
        if why.startswith("unknown-opcode"):
            self.unknown_hits[why.split(":")[1]] += 1
        lines.append("  script 0x%08X  [%s]" % (addr, why))
        follow = []
        # Ground item balls and NPC gifts do not use `giveitem`; they set
        # VAR_0x8000 to the item id and then callstd STD_FIND_ITEM(1) or
        # STD_OBTAIN_ITEM(0). Track the pending item across instructions.
        pending = None
        for i in ins:
            args = " ".join(self.render_arg(n, w, v, i.name) for n, w, v in i.args)
            lines.append("    %08X  %-20s %s" % (i.addr, i.name, args))
            if i.name == "pokemart":
                prods = self.read_mart(i.args[0][2])
                self.marts.setdefault(maplabel, []).extend(prods)
                for p in prods:
                    lines.append("        sells %s" % self.n.item(p))
                    self.item_sources[self.n.item(p)].append(
                        {"kind": "mart", "map": maplabel,
                         "script": "0x%08X" % i.addr})
            if i.name in ("additem", "giveitem", "finditem"):
                iid = i.args[0][2]
                self.item_sources[self.n.item(iid)].append(
                    {"kind": "script-give", "map": maplabel,
                     "script": "0x%08X" % i.addr})
            if i.name == "setorcopyvar" and i.args[0][2] == 0x8000:
                src = i.args[1][2]
                pending = src if src < 0x4000 else None
            elif i.name == "callstd" and pending:
                fn = i.args[0][2]
                if fn in (0, 1):
                    kind = "ground-item" if fn == 1 else "npc-gift"
                    lines.append("        ^ %s: %s"
                                 % (kind, self.n.item(pending)))
                    self.item_sources[self.n.item(pending)].append(
                        {"kind": kind, "map": maplabel,
                         "script": "0x%08X" % i.addr})
                    self.stats[kind] += 1
                pending = None
            if i.name == "trainerbattle":
                # Only the post-battle CONTINUE_SCRIPT pointer is code; the
                # others are intro/loss text and must not be decoded as script.
                idx = TB_EVENT_PTR.get(i.args[0][2])
                if idx is not None and len(i.args) > 2 + idx:
                    tgt = i.args[2 + idx][2]
                    if valid(self.rom, tgt):
                        follow.append(tgt)
                        self.stats["trainer_post_battle"] += 1
            for n, w, v in i.args:
                if w == 4 and valid(self.rom, v) and i.name in FOLLOW_OPS:
                    follow.append(v)
        lines.append("")
        queue.extend(follow)

    def run(self):
        mapdir = os.path.join(self.out, "maps")
        os.makedirs(mapdir, exist_ok=True)
        for group, num, hdr in self.map_headers():
            fname, label = self.n.map_label(group, num)
            eps = self.map_entry_points(hdr)
            if not eps:
                continue
            lines = ["%s  (group %d, map %d)  header 0x%08X"
                     % (label, group, num, hdr), "=" * 72,
                     "Legend: the leading 8-digit column is the instruction's",
                     "ROM address. Remaining raw hex is deliberate:",
                     "  gfx 0xNN     object sprite id (no name table extracted)",
                     "  trainer=0xN  trainer id (trainer table not dumped yet)",
                     "  flag=0xNNN   unnamed flag; '(temp)' = volatile, not saved",
                     "  var=0x4NNN   unnamed var; var 0x4000+i lives at",
                     "               SB1+0x1028+2i, so it is cross-referable",
                     "               with a parsed save's storyVars",
                     "  0x08......   a ROM pointer (script, text or data)",
                     ""]
            seen = set()
            for kind, desc, data in eps:
                if kind == "hidden":
                    lines.append("  %s" % desc)
                    lines.append("")
                    self.item_sources[self.n.item(data)].append(
                        {"kind": "hidden-item", "map": label})
                    self.stats["hidden_items"] += 1
                    continue
                lines.append("  %s -> 0x%08X" % (desc, data))
                self.dump_script(data, seen, lines, label)
            self.stats["maps"] += 1
            with open(os.path.join(mapdir, fname + ".txt"), "w") as f:
                f.write("\n".join(lines) + "\n")
        self.write_indexes()

    def write_indexes(self):
        idx = os.path.join(self.out, "index")
        os.makedirs(idx, exist_ok=True)
        with open(os.path.join(idx, "item-sources.json"), "w") as f:
            json.dump({k: v for k, v in sorted(self.item_sources.items())},
                      f, indent=1)
            f.write("\n")
        with open(os.path.join(idx, "marts.json"), "w") as f:
            json.dump({k: [self.n.item(i) for i in v]
                       for k, v in sorted(self.marts.items())}, f, indent=1)
            f.write("\n")
        stats = {
            "counts": dict(self.stats),
            "stop_reasons": dict(self.stop_reasons),
            "unresolved_opcodes": sorted("0x%02X" % o for o in self.dec.unresolved),
            "unknown_opcode_hits": dict(self.unknown_hits),
        }
        with open(os.path.join(idx, "stats.json"), "w") as f:
            json.dump(stats, f, indent=1)
            f.write("\n")
        return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rom", default=DEFAULT_ROM)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    rom = open(a.rom, "rb").read()
    d = Dumper(rom, a.out, Names())
    d.run()
    print("maps dumped:      %d" % d.stats["maps"])
    print("scripts decoded:  %d" % d.stats["scripts"])
    print("hidden items:     %d" % d.stats["hidden_items"])
    print("stop reasons:")
    for k, v in d.stop_reasons.most_common():
        print("   %-28s %d" % (k, v))
    if d.unknown_hits:
        print("UNKNOWN OPCODES HIT: %s" % dict(d.unknown_hits))
    return 0


if __name__ == "__main__":
    sys.exit(main())
