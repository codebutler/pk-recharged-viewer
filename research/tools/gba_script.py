#!/usr/bin/env python3
"""gba_script.py -- Gen-3 text codec and event-script decoder for the
Pokemon Recharged Yellow ROM (and retail Emerald, for calibration).

Stdlib-only, like the rest of the research tooling.

Two pieces:

  decode_text(rom, addr)   GBA character encoding -> UTF-8, using the charmap
                           vendored with pokeemerald.
  ScriptDecoder            byte stream -> [Instruction], using the opcode table
                           in research/script-opcodes.json, overlaid with the
                           target ROM's own command table so that opcodes the
                           hack stubbed out or reimplemented are handled per
                           THIS ROM rather than per vanilla Emerald.

Decoding NEVER guesses a length. An opcode whose argument layout is unknown
terminates the script with reason "unknown-opcode"; the caller is expected to
report those rather than emit a plausible-looking but desynchronized dump.
"""

import json
import os
import re
import struct

TOOLS = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(TOOLS)
REPO = os.path.dirname(RESEARCH)
EM = os.path.join(REPO, "vendor", "pokeemerald")

BASE = 0x08000000
OPCODES_JSON = os.path.join(RESEARCH, "script-opcodes.json")

# Control codes in the Gen-3 text encoding.
EOS = 0xFF
NEWLINE = 0xFE
PLACEHOLDER = 0xFD   # followed by a 1-byte buffer id
KEYPAD_ICON = 0xF8   # followed by a 1-byte icon id
EXTRA = 0xFC         # followed by a 1-byte control id (+ args for some)

PROMPT_SCROLL = 0xFA  # wait for button press, scroll
PROMPT_CLEAR = 0xFB   # wait for button press, clear

# Argument-byte counts for the 0xFC extended control codes. Transcribed from
# sExtCtrlCodeLengths in pokeemerald/src/string_util.c, which stores the TOTAL
# length including the code byte, so args = length - 1. Do not edit from
# memory -- a wrong count here silently corrupts the rest of the string.
FC_ARGS = {
    0x01: 1,  # COLOR                     0x0D: 1,  # SHIFT_RIGHT
    0x02: 1,  # HIGHLIGHT
    0x03: 1,  # SHADOW
    0x04: 3,  # COLOR_HIGHLIGHT_SHADOW
    0x05: 1,  # PALETTE
    0x06: 1,  # FONT
    0x07: 0,  # RESET_FONT
    0x08: 1,  # PAUSE
    0x09: 0,  # PAUSE_UNTIL_PRESS
    0x0A: 0,  # WAIT_SE
    0x0B: 2,  # PLAY_BGM
    0x0C: 1,  # ESCAPE
    0x0D: 1,  # SHIFT_RIGHT
    0x0E: 1,  # SHIFT_DOWN
    0x0F: 0,  # FILL_WINDOW
    0x10: 2,  # PLAY_SE
    0x11: 1,  # CLEAR
    0x12: 1,  # SKIP
    0x13: 1,  # CLEAR_TO
    0x14: 1,  # MIN_LETTER_SPACING
    0x15: 0,  # JPN
    0x16: 0,  # ENG
    0x17: 0,  # PAUSE_MUSIC
    0x18: 0,  # RESUME_MUSIC
}

PLACEHOLDER_NAMES = {
    0x00: "{UNKNOWN}", 0x01: "{PLAYER}", 0x02: "{STR_VAR_1}",
    0x03: "{STR_VAR_2}", 0x04: "{STR_VAR_3}", 0x05: "{KUN}",
    0x06: "{RIVAL}", 0x07: "{VERSION}", 0x08: "{AQUA}", 0x09: "{MAGMA}",
    0x0A: "{ARCHIE}", 0x0B: "{MAXIE}", 0x0C: "{KYOGRE}", 0x0D: "{GROUDON}",
}


def _load_charmap():
    """byte value -> character, from pokeemerald/charmap.txt."""
    table = {}
    path = os.path.join(EM, "charmap.txt")
    if not os.path.exists(path):
        return table
    for line in open(path, encoding="utf-8"):
        line = line.split("@")[0].strip()
        if not line or "=" not in line:
            continue
        left, right = line.split("=", 1)
        left, right = left.strip(), right.strip()
        vals = right.split()
        if len(vals) != 1:
            continue  # multi-byte sequences: not needed for plain text
        try:
            code = int(vals[0], 16)
        except ValueError:
            continue
        m = re.match(r"^'(.*)'$", left)
        if m:
            ch = m.group(1)
            if ch == "\\'":
                ch = "'"
            table.setdefault(code, ch)
    return table


CHARMAP = _load_charmap()


def decode_text(rom, addr, limit=4096):
    """Decode a GBA string at a ROM address. Returns (text, byte_length)."""
    if not (BASE <= addr < BASE + len(rom)):
        return None, 0
    off = addr - BASE
    out = []
    i = 0
    while i < limit and off + i < len(rom):
        b = rom[off + i]
        i += 1
        if b == EOS:
            return "".join(out), i
        if b == NEWLINE:
            out.append("\\n")
        elif b == PLACEHOLDER and off + i < len(rom):
            out.append(PLACEHOLDER_NAMES.get(rom[off + i], "{VAR_%02X}" % rom[off + i]))
            i += 1
        elif b == KEYPAD_ICON and off + i < len(rom):
            out.append("{ICON_%02X}" % rom[off + i])
            i += 1
        elif b in (PROMPT_SCROLL, PROMPT_CLEAR):
            out.append("\\p")   # wait-for-press: renders as a paragraph break
        elif b == EXTRA and off + i < len(rom):
            ctrl = rom[off + i]
            i += 1
            if ctrl not in FC_ARGS:
                # Unknown control code: its argument count is unknown, so
                # anything after it would be guesswork. Stop the string.
                out.append("{CTRL_%02X?}" % ctrl)
                return "".join(out), i
            out.append("{CTRL_%02X}" % ctrl)
            i += FC_ARGS[ctrl]
        else:
            out.append(CHARMAP.get(b, "{%02X}" % b))
    return "".join(out), i


class Instruction:
    __slots__ = ("addr", "opcode", "name", "args", "length", "raw")

    def __init__(self, addr, opcode, name, args, length, raw):
        self.addr, self.opcode, self.name = addr, opcode, name
        self.args, self.length, self.raw = args, length, raw

    def __repr__(self):
        return "<%08X %s %s>" % (self.addr, self.name, self.args)


# Opcodes that end a straight-line run of script.
TERMINATORS = {"end", "return", "goto", "waitstate", "releaseall", "release"}
# Opcodes whose 4-byte argument is a pointer to more script code.
CODE_PTR_ARGS = {"goto", "call", "goto_if", "call_if", "goto_if_set",
                 "goto_if_unset", "gotostd", "callstd", "vgoto", "vcall"}


class ScriptDecoder:
    """Decodes event scripts out of a ROM image.

    cmd_table_addr: the ROM's own gScriptCmdTable. Entries are compared against
    the table's nop handlers so that opcodes this ROM stubbed out are decoded as
    1-byte nops regardless of what the vanilla macro claims, and opcodes this ROM
    reimplemented are refused rather than decoded with vanilla widths.
    """

    def __init__(self, rom, cmd_table_addr, cmd_table_len, custom_sigs=None):
        self.rom = rom
        self.table = [self._u32(cmd_table_addr - BASE + 4 * i)
                      for i in range(cmd_table_len)]
        self.nop_handlers = {self.table[0], self.table[1]} if cmd_table_len > 1 else set()
        doc = json.load(open(OPCODES_JSON))
        self.vanilla = doc["opcodes"]
        self.custom = dict(custom_sigs or {})
        self.unresolved = set()
        self._classify()

    def _u8(self, off):
        return self.rom[off]

    def _u16(self, off):
        return struct.unpack_from("<H", self.rom, off)[0]

    def _u32(self, off):
        return struct.unpack_from("<I", self.rom, off)[0]

    def _classify(self):
        """Build {opcode: (name, [(width,name)] )}, or mark unresolved."""
        self.sig = {}
        for op in range(len(self.table)):
            key = "0x%02X" % op
            if op in self.custom:
                self.sig[op] = self.custom[op]
                continue
            if self.table[op] in self.nop_handlers:
                # this ROM ignores it: 1 byte, no args, whatever vanilla said
                v = self.vanilla.get(key)
                self.sig[op] = ((v["name"] if v else "nop_%02X" % op), [])
                continue
            v = self.vanilla.get(key)
            if v is None or v.get("args") is None:
                self.unresolved.add(op)
                continue
            if v["confidence"] == "ambiguous_stub":
                # vanilla stubbed it but THIS rom implements it -> unknown widths
                self.unresolved.add(op)
                continue
            self.sig[op] = (v["name"], [(a["width"], a["name"]) for a in v["args"]])

    def decode(self, addr, max_instructions=2000):
        """Decode a straight-line run. Returns (instructions, stop_reason)."""
        if not (BASE <= addr < BASE + len(self.rom)):
            return [], "bad-address"
        out = []
        pc = addr
        for _ in range(max_instructions):
            off = pc - BASE
            if off >= len(self.rom):
                return out, "ran-off-rom"
            op = self.rom[off]
            if op >= len(self.table):
                return out, "opcode-out-of-range:0x%02X" % op
            if op in self.unresolved:
                return out, "unknown-opcode:0x%02X" % op
            name, argspec = self.sig[op]
            if name == "trainerbattle":
                inst = self._trainerbattle(pc)
                if inst is None:
                    return out, "bad-trainerbattle"
            else:
                args, n = [], 1
                for w, an in argspec:
                    v = {1: self._u8, 2: self._u16, 4: self._u32}[w](off + n)
                    args.append((an, w, v))
                    n += w
                inst = Instruction(pc, op, name, args, n,
                                   self.rom[off:off + n])
            out.append(inst)
            pc += inst.length
            if inst.name in TERMINATORS:
                return out, "ok"
        return out, "instruction-limit"

    def _trainerbattle(self, pc):
        off = pc - BASE
        v = self.vanilla.get("0x%02X" % self.rom[off], {})
        var = v.get("variable")
        if not var:
            return None
        btype = self.rom[off + 1]
        extra = var["extra_pointers_by_type"].get(str(btype))
        if extra is None:
            return None
        args = [("type", 1, btype), ("trainer", 2, self._u16(off + 2)),
                ("localId", 2, self._u16(off + 4))]
        n = 6
        for i in range(extra):
            args.append(("ptr%d" % (i + 1), 4, self._u32(off + n)))
            n += 4
        return Instruction(pc, self.rom[off], "trainerbattle", args, n,
                           self.rom[off:off + n])
