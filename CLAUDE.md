# Pokémon Recharged Yellow — RAM analysis project

This repo reverse-engineered the memory layout of the ROM hack **Pokémon Recharged Yellow**
(`Pokemon Recharged Yellow.gba`) and built a working tool that turns a RAM dump or savestate
of a running game into complete structured JSON game state.

**Start here for any deep work: `analysis/README.md`** — it indexes every analysis document,
the offsets database, and the per-section confidence table. This file is the quick orientation
layer on top of it.

## What this game actually is (non-obvious)

- It's a **pokeemerald decomp rebuild** — compiled from modified pret/pokeemerald source.
  The ROM header says `POKEMON FIRE / BPRE` — that is **cosmetic and misleading**; the engine,
  structs, and script VM are Emerald's. Distributed as a BPS patch against retail **Emerald**.
- Content: a Kanto/Yellow remake. FRLG-style map numbering grafted onto the Emerald engine
  (Pallet Town = mapsec 0x58). Story follows the **original Yellow/RBY order**, not FRLG order
  — e.g. Pokémon Tower (rival fight → Lavender cutscene) must be done **before** the Celadon
  Rocket Hideout opens (story counter var `0x405D`).
- Hack-specific systems: achievements ("Chievos", custom **"Smsh" script VM**, storage format
  still unknown), an **accelerated in-game day/night clock** (~9× real time), **opt-in level
  caps** keyed to badge count, likely **autosave**, a six-pocket FRLG-style bag (incl. a
  100-slot Medicine pocket), multi-language dialogue (language byte SB2+0x91).
- The hack **removed** vanilla Emerald's save-data XOR obfuscation (money/quantities are
  plaintext) and **removed** dedicated daycare storage. Pokémon data encryption
  (personality⊕OTID, substructure permutation, checksum) is **fully vanilla Gen 3**.
- SaveBlocks are **repacked/compacted** vs vanilla — vanilla offsets are mostly wrong here.
  Never use vanilla or FRLG offsets; use `analysis/hack-offsets.json` (evidence-based, mostly
  disassembly-proven and live-verified).

## The tool: parse a save → JSON

```sh
python3 analysis/tools/parse_ram.py --state <savestate-file> --pretty
# or a dump dir containing iwram.bin + ewram.bin:
python3 analysis/tools/parse_ram.py <dump-dir> --pretty
```

Accepted inputs: desktop-mGBA savestates (PNG or raw), **libretro mGBA-core `.st0`/`.st9`
states from the user's handheld**, or raw IWRAM(32KB)+EWRAM(256KB) dumps. Flash `.sav`
parsing is deliberately out of scope (savestates carry the same data).

Output JSON: player, rivalName, location (map names resolved), party (live) + savedParty,
all 14 PC boxes, six bag pockets, PC items, mail, badges (Boulder→Earth), progress flags,
story vars, Pokédex, game stats, berry trees, in-game clock, derived level cap. Every section
carries a confidence label in `meta`; unparseable sections emit explicit errors, never garbage.

**The user's real progression lives on a handheld** (MinUI device, libretro mGBA core).
A backup from 2026-08-18 is at `/Users/eric/rgsp-saves-backup-2026-08-18/` (**read-only —
never modify it**); its parsed snapshots are `analysis/real-saves/st0.json` / `st9.json`.
For "what's my current state" questions, ask the user for a **fresh** backup/savestate first
— the dated snapshot goes stale as they play. On the device the state file is
`shared/MGBA-mgba/Pokemon Recharged Yellow.gba.st0`.

## Answering "what should I do next in the game?"

Recipe that worked well:
1. Parse the newest savestate. Read: badges, key items, party levels, location,
   `progressFlags`/story vars (var `0x405D` = Lavender/Celadon Rocket arc:
   0=not started, 1=tower rival beaten, 2=Lavender cutscene seen).
2. Map that onto original-Yellow progression (not FRLG's) to propose the next objective.
3. If an NPC/event seems stuck, don't guess — **decompile the gating script from the ROM**:
   map headers via `gMapGroups` @ROM 0x08B3F134, object events → script pointers, standard
   pokeemerald script opcodes (plus custom 0xE6 = multi-language msgbox, 0xE8 = speaker name).
   Then compare required flags/vars against the parsed save. Method details and worked
   example in `analysis/hack-offsets.md`.

## Key memory facts (all in hack-offsets.json; headline values)

- Save pointers (IWRAM): `gSaveBlock1Ptr` 0x03005AD0, `gSaveBlock2Ptr` 0x03005AD4,
  `gPokemonStoragePtr` 0x03005AD8. Buffers ASLR-shift (shared 0–0x7C offset); always
  dereference, never hardcode. Pointers are valid **before** the title screen — validity ≠
  in-game; use anchor checks (the parser does).
- Live party: `gPlayerPartyCount` 0x02038559, `gPlayerParty` 0x0203855C (EWRAM). The SB1
  party copy (+0x44) updates **on save only**.
- SB1: money 0x29C (plaintext), flags 0xEFB (badges = flag IDs 0x880–0x887), vars 0x1028,
  gameStats u32[64] 0xB50, six bag pockets per hack-offsets.json.
- SB2: playerName 0x00, Pokédex owned/seen bitfields 0x28/0x5C (species N → bit N−1),
  rival name 0x6E2, challenge-options byte 0x6E0, clock 0xF5C. SB2 ends at 0xF64 —
  bytes beyond are inter-block slack, not data.
- Species IDs are Gen 3 **internal** numbers; internal→national mapping is a standalone
  artifact (see `analysis/README.md` inventory — needed for PokéAPI and future work).

## Tooling & environment gotchas

- Emulation/scripting requires the **mGBA 0.11 nightly** (`/Applications/mGBA-nightly.app`);
  the brew formula is broken and stable mGBA lacks `--script`. Harness:
  `analysis/tools/run_harness.sh` (dump/input-injection Lua under `analysis/tools/`).
  mGBA silently ignores `--script` when the ROM sits under `/var/folders/...`.
- pret decomp clones live at `./pokeemerald` (authoritative) and `./pokefirered`
  (historical dead end — ignore).
- RAM-injection round-trips are a proven verification technique here (see
  `analysis/dumps/inject/`); if injecting mons, use a personality with `pid % 24 != 0`.

## Conduct

- **Never submit/publish anything external** (no issues, PRs, uploads). PokéAPI *reads*
  are authorized for tooling; include no personal info in requests.
- The user's save backups are read-only source material.
- Multi-agent workflow notes: past sessions ran parallel sub-agents (static disasm /
  empirical dump forensics / parser / emulator harness) whose reports cross-checked each
  other; keep that discipline — corroborate static claims against live data before trusting
  them, and record evidence + confidence in the analysis docs.

## Open items (data-starved, not blocking)

- Achievements storage format: candidate SB1+0xD2C..0xD45 (0xFF = locked); needs a save
  with ≥1 achievement earned.
- Mail struct parsing never exercised on an attached mail (location 0x1D98 is verified).
- gameStats idx31 holds an odd value — possibly repurposed.
