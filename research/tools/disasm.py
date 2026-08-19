#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["capstone>=5.0.1"]
# ///
"""Disassemble a range of the Recharged Yellow ROM (Thumb by default).

    uv run research/tools/disasm.py 0x080D3598 0x080D3600   # FlagSet
    uv run research/tools/disasm.py 0x081B9530 --count 0x60
    uv run research/tools/disasm.py 0x08000000 --arm --count 0x40

Annotations, which are the reason this exists rather than a raw objdump:

  * `ldr rX, [pc, #N]` literals are resolved to their word value, and the value
    is looked up in `research/hack-offsets.json` — so `gSaveBlock1Ptr`,
    `gTasks`, `gPlayerParty` and friends appear by name.
  * addresses inside `gTasks` are decoded to `gTasks[id].data[k]`, which is what
    makes task-data code (and cheat codes aimed at it) readable.
  * `bl` targets are named from the `rom_functions` table in the same file.

This is the ONE tool here that takes a third-party dependency (capstone), via
the inline script metadata above — `uv run` installs it on demand, nothing to
set up. The parser oracle (`parse_ram.py`) and the graphics reference
(`gba_gfx.py` and friends) stay stdlib-only on purpose; see CLAUDE.md.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys

from capstone import CS_ARCH_ARM, CS_MODE_ARM, CS_MODE_LITTLE_ENDIAN, CS_MODE_THUMB, Cs

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_ROM = os.path.join(REPO, "local", "Pokemon Recharged Yellow.gba")
OFFSETS = os.path.join(REPO, "research", "hack-offsets.json")

ROM_BASE = 0x08000000
TASK_STRIDE = 40  # struct Task; data[] starts at +8


def load_symbols(path: str = OFFSETS) -> dict[int, str]:
    """addr -> name, harvested from every {"addr": "0x..."} entry in the DB."""
    syms: dict[int, str] = {}
    try:
        with open(path) as fh:
            db = json.load(fh)
    except OSError:
        return syms

    def walk(node, name=None):
        if isinstance(node, dict):
            addr = node.get("addr")
            if isinstance(addr, str) and addr.startswith("0x") and name:
                try:
                    syms.setdefault(int(addr, 16), name)
                except ValueError:
                    pass
            for key, val in node.items():
                walk(val, key)
        elif isinstance(node, list):
            for item in node:
                walk(item, name)

    walk(db)
    # meta.pointers is a flat name -> "0x..." map, not {"addr": ...} entries.
    for key, val in (db.get("meta", {}).get("pointers") or {}).items():
        if isinstance(val, str) and val.startswith("0x"):
            syms.setdefault(int(val, 16), key)
    return syms


def describe(value: int, syms: dict[int, str]) -> str:
    """Name a word: exact symbol, task-data slot, or nothing."""
    if value in syms:
        return syms[value]
    if (value & 1) and (value - 1) in syms:
        return syms[value - 1] + "+1 (thumb)"
    gtasks = next((a for a, n in syms.items() if n == "gTasks"), None)
    if gtasks is not None and gtasks <= value < gtasks + 16 * TASK_STRIDE:
        task, off = divmod(value - gtasks, TASK_STRIDE)
        if off >= 8 and off % 2 == 0:
            return f"gTasks[{task}].data[{(off - 8) // 2}]"
        field = {0: "func", 4: "isActive", 5: "prev", 6: "next", 7: "priority"}.get(off)
        return f"gTasks[{task}].{field}" if field else f"gTasks[{task}]+{off:#x}"
    return ""


def disassemble(rom: bytes, start: int, end: int, thumb: bool, syms: dict[int, str]):
    mode = CS_MODE_THUMB if thumb else CS_MODE_ARM
    md = Cs(CS_ARCH_ARM, mode | CS_MODE_LITTLE_ENDIAN)
    code = rom[start - ROM_BASE : end - ROM_BASE]
    reached = start
    for ins in md.disasm(code, start):
        reached = ins.address + ins.size
        line = f"{ins.address:08X}  {ins.bytes.hex():<10} {ins.mnemonic:<7} {ins.op_str}"
        note = ""
        if ins.mnemonic.startswith("ldr") and "pc" in ins.op_str:
            note = literal_note(rom, ins, syms)
        elif ins.mnemonic in ("bl", "blx", "b") and ins.op_str.startswith("#"):
            target = int(ins.op_str[1:], 0)
            name = syms.get(target) or syms.get(target | 1)
            if name:
                note = f"; {name}"
        print(line + (f"    {note}" if note else ""))
    if end - reached > 2:  # a lone trailing halfword is just a truncated range
        # Silence here is a trap: capstone stops dead at the first halfword it
        # cannot decode, which usually means a literal pool, the wrong start
        # alignment, or ARM code being read as Thumb.
        print(
            f"[stopped at {reached:#010x}: undecodable — literal pool, "
            f"misaligned start, or wrong mode?]",
            file=sys.stderr,
        )


def literal_note(rom: bytes, ins, syms: dict[int, str]) -> str:
    try:
        disp = int(ins.op_str.split("#")[1].rstrip("]"), 0)
    except (IndexError, ValueError):
        return ""
    pool = ((ins.address + 4) & ~3) + disp
    idx = pool - ROM_BASE
    if not 0 <= idx <= len(rom) - 4:
        return ""
    (value,) = struct.unpack_from("<I", rom, idx)
    name = describe(value, syms)
    return f"; =0x{value:08X}" + (f"  {name}" if name else "")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("start", help="start address, e.g. 0x080D3598")
    ap.add_argument("end", nargs="?", help="end address (exclusive)")
    ap.add_argument("--count", help="byte count instead of an end address")
    ap.add_argument("--arm", action="store_true", help="decode as ARM, not Thumb")
    ap.add_argument("--rom", default=DEFAULT_ROM)
    args = ap.parse_args()

    start = int(args.start, 16) & ~1
    if args.end:
        end = int(args.end, 16)
    else:
        end = start + (int(args.count, 0) if args.count else 0x80)
    if end <= start:
        ap.error("end must be after start")

    try:
        with open(args.rom, "rb") as fh:
            rom = fh.read()
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        print("The ROM lives in local/ and is never committed.", file=sys.stderr)
        return 1
    if not ROM_BASE <= start < ROM_BASE + len(rom):
        ap.error(f"address out of range for a {len(rom):#x}-byte ROM")

    disassemble(rom, start, min(end, ROM_BASE + len(rom)), not args.arm, load_symbols())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
