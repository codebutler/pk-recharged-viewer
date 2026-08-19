#!/usr/bin/env python3
"""extract_opcodes.py -- derive the Gen-3 event-script opcode table from the
vendored pokeemerald sources and write research/script-opcodes.json.

Two independent derivations are computed and cross-checked, because a wrong
argument width desynchronizes every instruction after it in a dump:

  A. The assembler macros in asm/macros/event.inc. A macro's first `.byte
     SCR_OP_x` identifies the opcode; the emitting directives after it give the
     argument widths. Branch directives (.if/.ifb/.else/...) are enumerated, so
     the `AT` variants that live in an .else arm are recovered too.
  B. The C handlers in src/scrcmd.c. Each ScriptReadByte/Halfword/Word call
     consumes 1/2/4 bytes of arguments, in source order.

Where the two disagree the opcode is emitted with "confidence": "low" and the
disagreement is recorded, so the decoder can refuse to guess rather than
silently desync.

Opcode numbering comes from data/script_cmd_table.inc (table order IS the
opcode number). Run from the repo root; writes research/script-opcodes.json.
"""

import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EM = os.path.join(REPO, "vendor", "pokeemerald")
OUT = os.path.join(REPO, "research", "script-opcodes.json")

WIDTH = {"byte": 1, "2byte": 2, "4byte": 4}

# Sub-macros that emit bytes but are defined outside event.inc, or whose
# expansion is fixed. `map` (asm/macros/map.inc) emits mapGroup+mapNum.
EXTERNAL_MACROS = {
    "map": [(1, "mapGroup"), (1, "mapNum")],
    # stringvar's body is an .if chain emitting a bare literal, which would
    # otherwise name the argument "0"; it is always one string-var id byte.
    "stringvar": [(1, "stringVarId")],
}

# trainerbattle is variable-length keyed on its `type` byte; the macro's
# .elseif chain is transcribed here rather than evaluated symbolically.
# Values from include/constants/trainers.h (TRAINER_BATTLE_*).
TRAINERBATTLE_EXTRA_PTRS = {
    0: 2,   # SINGLE
    1: 3,   # CONTINUE_SCRIPT_NO_MUSIC
    2: 3,   # CONTINUE_SCRIPT
    3: 1,   # SINGLE_NO_INTRO_TEXT
    4: 3,   # DOUBLE
    5: 2,   # REMATCH
    6: 4,   # CONTINUE_SCRIPT_DOUBLE
    7: 3,   # REMATCH_DOUBLE
    8: 4,   # CONTINUE_SCRIPT_DOUBLE_NO_MUSIC
    9: 2,   # PYRAMID
    10: 2,  # SET_TRAINER_A
    11: 2,  # SET_TRAINER_B
    12: 2,  # HILL
}


def read(path):
    with open(os.path.join(EM, path)) as f:
        return f.read()


# ---------------------------------------------------------------------------
# opcode numbering + handler names


def opcode_table():
    """[(number, SCR_OP_name, ScrCmd_handler)] in table order."""
    out = []
    for line in read("data/script_cmd_table.inc").splitlines():
        m = re.search(r"script_cmd_table_entry\s+(SCR_OP_\w+)\s+(\w+)", line)
        if m:
            out.append((len(out), m.group(1), m.group(2)))
    return out


# ---------------------------------------------------------------------------
# derivation A: assembler macros


def parse_macros(text):
    """{macro name: (params, body)} for every .macro in the file."""
    out = {}
    for m in re.finditer(r"\.macro\s+(\w+)([^\n]*)\n(.*?)^\s*\.endm", text,
                         re.S | re.M):
        name, params, body = m.group(1), m.group(2), m.group(3)
        pnames = [p.split("=")[0].split(":")[0].strip()
                  for p in params.split(",") if p.strip()]
        out[name] = (pnames, body)
    return out


def split_branches(body):
    """Enumerate straight-line variants of a body containing .if/.else arms.

    Returns a list of bodies with the conditionals flattened. Nested
    conditionals are handled by recursing on each produced arm.
    """
    depth = 0
    arms, current, prefix = [], [], []
    lines = body.splitlines()
    for i, line in enumerate(lines):
        s = line.strip()
        if re.match(r"\.(if|ifb|ifnb|ifdef|ifndef)\b", s):
            if depth == 0:
                prefix = current
                current, arms = [], []
                depth = 1
                continue
            depth += 1
        elif re.match(r"\.(else|elseif)\b", s) and depth == 1:
            arms.append(current)
            current = []
            continue
        elif s.startswith(".endif"):
            depth -= 1
            if depth == 0:
                arms.append(current)
                tail = lines[i + 1:]
                out = []
                for arm in arms:
                    combined = "\n".join(prefix + arm + tail)
                    out.extend(split_branches(combined))
                return out
            # fall through to append nested .endif
        current.append(line)
    return ["\n".join(current)]


def layout_of(body, macros, seen=()):
    """Byte layout of a straight-line macro body: [(width, argname)] with the
    leading opcode byte included as (1, 'SCR_OP_x'). Returns None if the body
    emits nothing recognizable."""
    out = []
    for line in body.splitlines():
        s = line.split("@")[0].strip()
        if not s:
            continue
        m = re.match(r"\.(byte|2byte|4byte)\s+(.+)$", s)
        if m:
            for val in m.group(2).split(","):
                out.append((WIDTH[m.group(1)], val.strip().lstrip("\\")))
            continue
        m = re.match(r"(\w+)\b(.*)$", s)
        if not m:
            continue
        name = m.group(1)
        if name in EXTERNAL_MACROS:
            out.extend(EXTERNAL_MACROS[name])
        elif name in macros and name not in seen:
            # nested macro call: expand its first branch (callers of nested
            # macros in event.inc are all unconditional emitters)
            sub = split_branches(macros[name][1])[0]
            got = layout_of(sub, macros, seen + (name,))
            if got:
                out.extend(got)
    return out or None


def derive_from_macros(macros, names_by_op):
    """{opcode number: [(width, argname)] excluding the opcode byte}."""
    found = {}
    op_by_name = {n: i for i, n, _ in names_by_op}
    for mname, (params, body) in macros.items():
        for branch in split_branches(body):
            lay = layout_of(branch, macros)
            if not lay:
                continue
            w, first = lay[0]
            if w != 1 or not first.startswith("SCR_OP_"):
                continue
            if first not in op_by_name:
                continue
            num = op_by_name[first]
            args = lay[1:]
            # Prefer the macro whose name matches the opcode (showobjectat over
            # showplayer); otherwise first one wins.
            prev = found.get(num)
            better = (prev is None
                      or (mname == first.replace("SCR_OP_", "").lower()
                          and prev[0] != first.replace("SCR_OP_", "").lower()))
            if better:
                found[num] = (mname, args)
    return found


# ---------------------------------------------------------------------------
# derivation B: C handlers


# Handlers that ignore their arguments entirely. Emerald stubs several
# FRLG-era commands this way: the opcode consumes 0 bytes here even though the
# macro still declares arguments. A hack built on this engine may reimplement
# them, so their true length is undecidable from vanilla sources alone.
STUB_HANDLERS = {"ScrCmd_nop", "ScrCmd_nop1"}


def strip_c_comments(src):
    """Remove /*...*/ and //... so commented-out ScriptRead* calls aren't counted
    (ScrCmd_drawbox's argument reads are commented out in Emerald)."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def derive_from_scrcmd():
    """{ScrCmd handler name: [widths]} from ScriptRead* call order."""
    src = strip_c_comments(read("src/scrcmd.c"))
    out = {}
    for m in re.finditer(r"^bool8\s+(ScrCmd_\w+)\s*\([^)]*\)\s*\n\{", src, re.M):
        name = m.group(1)
        # take the body up to the next top-level function definition
        nxt = re.search(r"^bool8\s+ScrCmd_\w+", src[m.end():], re.M)
        body = src[m.end(): m.end() + (nxt.start() if nxt else len(src))]
        widths = []
        for r in re.finditer(r"ScriptRead(Byte|Halfword|Word)\s*\(", body):
            widths.append({"Byte": 1, "Halfword": 2, "Word": 4}[r.group(1)])
        out[name] = widths
    return out


# ---------------------------------------------------------------------------


def movement_actions():
    """{numeric value: friendly movement name}, e.g. 8 -> 'walk_down'.

    movement.inc maps friendly names to MOVEMENT_ACTION_* symbols; the numeric
    values live in include/constants/event_object_movement.h.
    """
    vals = {}
    hdr = read("include/constants/event_object_movement.h")
    for m in re.finditer(r"#define\s+(MOVEMENT_ACTION_\w+)\s+(0x[0-9A-Fa-f]+|\d+)",
                         hdr):
        vals[m.group(1)] = int(m.group(2), 0)
    out = {}
    for m in re.finditer(r"create_movement_action\s+(\w+)\s*,\s*(MOVEMENT_ACTION_\w+)",
                         read("asm/macros/movement.inc")):
        name, sym = m.group(1), m.group(2)
        if sym in vals:
            out.setdefault(vals[sym], name)
    return out


def simple_constants(prefixes):
    """{prefix: {value: name}} for `NAME = <int>` assignments in event.inc."""
    out = {p: {} for p in prefixes}
    for m in re.finditer(r"^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*$",
                         read("asm/macros/event.inc"), re.M):
        name, val = m.group(1), int(m.group(2))
        for p in prefixes:
            if name.startswith(p):
                out[p][val] = name
    return out


def main():
    table = opcode_table()
    macros = parse_macros(read("asm/macros/event.inc"))
    macros.update(parse_macros(read("asm/macros/map.inc")))
    from_macros = derive_from_macros(macros, table)
    from_c = derive_from_scrcmd()

    tb_num = next((i for i, n, _ in table if n == "SCR_OP_TRAINERBATTLE"), None)
    opcodes, disagree, missing, stubs = {}, [], [], []
    for num, opname, handler in table:
        entry = from_macros.get(num)
        c_widths = from_c.get(handler)
        if entry is None:
            missing.append(opname)
            opcodes["0x%02X" % num] = {
                "name": opname.replace("SCR_OP_", "").lower(),
                "handler": handler, "args": None, "confidence": "unknown",
            }
            continue
        mname, args = entry
        m_widths = [w for w, _ in args]
        rec = {
            "name": mname, "handler": handler,
            "args": [{"width": w, "name": n} for w, n in args],
            "length": 1 + sum(m_widths),
            "confidence": "high",
        }
        if handler in STUB_HANDLERS and m_widths:
            # Emerald ignores the args; a hack may not. Undecidable here.
            rec["confidence"] = "ambiguous_stub"
            rec["length"] = None
            rec["candidate_lengths"] = [1, 1 + sum(m_widths)]
            rec["note"] = ("dispatches to %s in Emerald (args ignored, so 1 byte "
                           "here), but the macro declares %d argument bytes. "
                           "Resolve against the target ROM's own handler before "
                           "decoding." % (handler, sum(m_widths)))
            stubs.append("0x%02X %s" % (num, mname))
        elif (not c_widths and m_widths
              and all(n == "0" for _, n in args)):
            # Macro emits literal 0 padding the handler never reads (e.g.
            # hidemoneybox). The VM executes the padding as NOPs, so the next
            # instruction is at the same address either way -- safe to keep the
            # macro length and render the padding as part of this instruction.
            rec["note"] = ("macro emits %d literal 0 padding byte(s) that %s "
                           "ignores; the VM runs them as NOPs, so the "
                           "instruction stream stays in sync either way."
                           % (sum(m_widths), handler))
        elif c_widths is None:
            rec["confidence"] = "medium"  # handler not found (inlined/aliased)
        elif m_widths != c_widths and num != tb_num:
            rec["confidence"] = "low"
            disagree.append({"opcode": "0x%02X" % num, "name": mname,
                             "macro_widths": m_widths, "c_widths": c_widths})
        opcodes["0x%02X" % num] = rec

    # trainerbattle: variable length, keyed on the type byte
    tb = [i for i, n, _ in table if n == "SCR_OP_TRAINERBATTLE"]
    if tb:
        key = "0x%02X" % tb[0]
        opcodes[key]["variable"] = {
            "keyed_on": "type",
            "fixed_args": [{"width": 1, "name": "type"},
                           {"width": 2, "name": "trainer"},
                           {"width": 2, "name": "localId"}],
            "extra_pointers_by_type": {str(k): v
                                       for k, v in TRAINERBATTLE_EXTRA_PTRS.items()},
        }
        opcodes[key]["confidence"] = "high"
        opcodes[key].pop("length", None)

    doc = {
        "meta": {
            "source": "vendor/pokeemerald (pret decomp)",
            "derivations": ["asm/macros/event.inc", "src/scrcmd.c"],
            "note": ("Opcode number = position in data/script_cmd_table.inc. "
                     "The hack's own table at ROM 0x081F1630 has 235 entries; "
                     "0x00-0xE2 match this table, 0xE3-0xEA are hack customs "
                     "and are NOT described here."),
            "vanilla_opcode_count": len(table),
            "disagreements": disagree,
            "no_macro_found": missing,
            "ambiguous_stubs": stubs,
        },
        "opcodes": opcodes,
    }
    consts = simple_constants(["STD_", "MSGBOX_"])
    # `msgbox` compiles to `loadword 0, text` + `callstd <type>`, so a callstd
    # function number is either an STD_* or an MSGBOX_* id -- one namespace.
    callstd = dict(consts["MSGBOX_"])
    callstd.update(consts["STD_"])
    doc["constants"] = {
        "callstd": {str(k): v for k, v in sorted(callstd.items())},
        "movement_actions": {str(k): v for k, v in
                             sorted(movement_actions().items())},
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=False)
        f.write("\n")

    counts = {}
    for v in opcodes.values():
        counts[v["confidence"]] = counts.get(v["confidence"], 0) + 1
    print("wrote %s" % os.path.relpath(OUT, REPO))
    print("opcodes: %d  confidence: %s" % (len(opcodes), counts))
    if disagree:
        print("DISAGREEMENTS (%d):" % len(disagree))
        for d in disagree:
            print("  %s %-24s macro=%s c=%s"
                  % (d["opcode"], d["name"], d["macro_widths"], d["c_widths"]))
    if missing:
        print("NO MACRO (%d): %s" % (len(missing), ", ".join(missing)))
    if stubs:
        print("AMBIGUOUS STUBS (%d, length undecidable from vanilla): %s"
              % (len(stubs), ", ".join(stubs)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
