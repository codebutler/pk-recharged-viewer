# pk-recharged-viewer

A browser app that turns a save of the ROM hack **Pokémon Recharged Yellow**
(by Jaizu — https://ko-fi.com/s/7fec26b127) into a readable, game-styled page,
built on a from-scratch reverse-engineering of the hack's memory layout.

**Start here for any deep work: `research/README.md`** — it indexes every analysis
document, the offsets database, and the per-section confidence table. This file is
the quick orientation layer on top of it.

## What this game actually is (non-obvious)

- It's a **pokeemerald decomp rebuild** — compiled from modified pret/pokeemerald
  source. The ROM header says `POKEMON FIRE / BPRE` — that is **cosmetic and
  misleading**; the engine, structs, and script VM are Emerald's. Distributed as a
  BPS patch against retail **Emerald**.
- Content: a Kanto/Yellow remake. FRLG-style map numbering grafted onto the
  Emerald engine (Pallet Town = mapsec 0x58). Story follows the **original
  Yellow/RBY order**, not FRLG order — e.g. Pokémon Tower (rival fight → Lavender
  cutscene) must be done **before** the Celadon Rocket Hideout opens (story
  counter var `0x405D`).
- Hack-specific systems: achievements ("Chievos", custom **"Smsh" script VM**,
  storage format still unknown), an **accelerated in-game day/night clock** (~9×
  real time), **opt-in level caps** keyed to badge count, likely **autosave**, a
  six-pocket FRLG-style bag (incl. a 100-slot Medicine pocket), multi-language
  dialogue (language byte SB2+0x91).
- The hack **removed** vanilla Emerald's save-data XOR obfuscation (money and
  quantities are plaintext) and **removed** dedicated daycare storage. Pokémon data
  encryption (personality⊕OTID, substructure permutation, checksum) is **fully
  vanilla Gen 3**.
- SaveBlocks are **repacked/compacted** vs vanilla — vanilla offsets are mostly
  wrong here. Never use vanilla or FRLG offsets; use `research/hack-offsets.json`
  (evidence-based, mostly disassembly-proven and live-verified).

## Structure: JS ships, Python verifies

The parser exists **twice, on purpose**:

- **`lib/parser/`** (JavaScript) is the implementation. Pure ES modules, no
  dependencies, no Node/Bun APIs on the parse path — it runs unchanged in the
  browser, which is what the app uses. `parse-ram.js` is the parser,
  `state-extract.js` handles savestate containers, `index.js` is the entry point
  (`parseRam({iwram, ewram})`, `await parseSavestate(bytes)`), `cli.js` is the
  only file that touches the filesystem.
- **`research/tools/parse_ram.py`** (Python) is the **reference oracle**. It came
  first, every offset was verified through it, and it is kept so the JS port can
  be proven correct against it. Do not delete it and do not let it rot.

**The workflow for any parser change:**

```sh
bun test                      # unit tests
bun tests/compare-python.js   # must stay 82/82 inputs matching
```

The harness runs both parsers over every dump under `research/dumps/**` and every
savestate, then deep-diffs the JSON. Only two fields are allowed to differ
(`meta.tool`, and the config-layer file paths). **A parsing fix belongs in both
implementations** — changing only one breaks the comparison, and that is the
intended signal, not a nuisance.

Data tables live in `research/` (canonical) and are copied to `public/data/` for the
browser; after editing an offsets or gamedata file, run `bun run sync-data`.

**The Python side is stdlib-only and has no packaging.** `parse_ram.py` is a
reference implementation kept so `bun tests/compare-python.js` can prove the JS
parser correct; plain `python3` runs it, there is no virtualenv, no
`pyproject.toml`, and nothing to install. Keep it that way — a third-party import
in `research/tools/` would break the one check that validates the JS parser.

## Running things

```sh
bun run serve                 # http://localhost:8000 — the app (file:// won't work)
bun test
bun tests/compare-python.js
bun run sync-data             # research/*.json -> public/data/*.json
bun run prepare-assets        # vendored PokeAPI mirrors -> public/

# JSON from the command line
bun lib/parser/cli.js --state <savestate> --pretty
python3 research/tools/parse_ram.py --state <savestate> --pretty     # the oracle
python3 research/tools/parse_ram.py <dump-dir> --pretty
```

Accepted inputs: desktop-mGBA savestates (PNG or raw), **libretro mGBA-core
`.st0`/`.st9` states from the user's handheld**, raw IWRAM(32KB) + EWRAM(256KB)
dumps, and — **JS only** — 128KB flash `.sav` files.

Flash `.sav` support lives in `lib/parser/sav-extract.js` (sector reassembly) and
`parse-blocks.js` (save blocks → state); `parse_ram.py` does NOT read `.sav`, so
there is no oracle for it. Its verification is instead a cross-check: the repo's
`flash.sav` and `st0.bin` are the same game state, and a test requires the two
parses to agree field-for-field (only playtime and the clock may differ, since the
savestate was taken after the save). A `.sav` result carries `state.source.live =
false` plus a caveat string — the party is the saved copy, the follower and
bike/surf state are absent, and the clock is frozen at the save. Note the sector
checksums only verify under the **hack's** struct sizes, which makes the save file
independent confirmation of SB1=0x3D94 / SB2=0xF64.

Output JSON: player, rivalName, location (map names resolved), party (live) +
savedParty, all 14 PC boxes, six bag pockets, PC items, mail, badges
(Boulder→Earth), progress flags, story vars, Pokédex, game stats, berry trees,
in-game clock, derived level cap. Every section carries a confidence label in
`meta`; unparseable sections emit explicit errors, never garbage.

**The user's real progression lives on a handheld** (MinUI device, libretro mGBA
core). A backup from 2026-08-18 is at `/Users/eric/rgsp-saves-backup-2026-08-18/`
(**read-only — never modify it**); its parsed snapshots are
`research/real-saves/st0.json` / `st9.json`. For "what's my current state"
questions, ask the user for a **fresh** backup/savestate first — the dated
snapshot goes stale as they play. On the device the state file is
`shared/MGBA-mgba/Pokemon Recharged Yellow.gba.st0`.

## ROM graphics

Sprite/tile decoding lives in `lib/gfx/` (JavaScript, used by the app and by
`tools/extract-rom-assets.js`). Its Python counterpart is
`research/tools/gba_gfx.py` + `gba_map.py` + `rom_gfx.py`, which
`lib/gfx/verify_python.py` uses as an independent reference — it renders the same
scenes and byte-compares them against the JS output and the exported PNGs
(`python3 lib/gfx/verify_python.py --assets public`). Stdlib-only, same rule as
the parser oracle.

A retired Jinja2 page generator (`generate_page.py` + `templates/`) produced
`research/report/index.html` before the browser app existed; it was deleted once
the app superseded it, along with the `uv`/jinja2 dependency. `rom_gfx.py` holds
the ROM-graphics helpers extracted from it.

## Answering "what should I do next in the game?"

Recipe that worked well:

1. Parse the newest savestate. Read: badges, key items, party levels, location,
   `progressFlags`/story vars (var `0x405D` = Lavender/Celadon Rocket arc:
   0=not started, 1=tower rival beaten, 2=Lavender cutscene seen).
2. Map that onto original-Yellow progression (not FRLG's) to propose the next
   objective.
3. If an NPC/event seems stuck, don't guess — **decompile the gating script from
   the ROM**: map headers via `gMapGroups` @ROM 0x08B3F134, object events → script
   pointers, standard pokeemerald script opcodes (plus custom 0xE6 = multi-language
   msgbox, 0xE8 = speaker name). Then compare required flags/vars against the
   parsed save. Method details and worked example in `research/hack-offsets.md`.

Note the hack allows HM field moves **without teaching them** — check HM ownership
and never advise teaching an HM to a party member.

## Key memory facts (all in hack-offsets.json; headline values)

- Save pointers (IWRAM): `gSaveBlock1Ptr` 0x03005AD0, `gSaveBlock2Ptr` 0x03005AD4,
  `gPokemonStoragePtr` 0x03005AD8. Buffers ASLR-shift (shared 0–0x7C offset);
  always dereference, never hardcode. Pointers are valid **before** the title
  screen — validity ≠ in-game; use anchor checks (the parsers do).
- Live party: `gPlayerPartyCount` 0x02038559, `gPlayerParty` 0x0203855C (EWRAM).
  The SB1 party copy (+0x44) updates **on save only**.
- SB1: money 0x29C (plaintext), flags 0xEFB (badges = flag IDs 0x880–0x887), vars
  0x1028, gameStats u32[64] 0xB50, six bag pockets per hack-offsets.json.
- SB2: playerName 0x00, Pokédex owned/seen bitfields 0x28/0x5C (species N → bit
  N−1), rival name 0x6E2, challenge-options byte 0x6E0, clock 0xF5C. SB2 ends at
  0xF64 — bytes beyond are inter-block slack, not data.
- Species IDs are Gen 3 **internal** numbers; internal→national mapping is a
  standalone artifact (`research/species-mapping.json`, also copied to `public/data/`
  for the app).

## Tooling & environment gotchas

- Emulation/scripting requires the **mGBA 0.11 nightly**
  (`/Applications/mGBA-nightly.app`); the brew formula is broken and stable mGBA
  lacks `--script`. Harness: `research/tools/run_harness.sh` (dump/input-injection
  Lua under `research/tools/`). mGBA silently ignores `--script` when the ROM sits
  under `/var/folders/...`.
- pret decomp clones live at `vendor/pokeemerald` (authoritative) and `vendor/pokefirered`
  (historical dead end — ignore).
- RAM-injection round-trips are a proven verification technique here (see
  `research/dumps/inject/`); if injecting mons, use a personality with
  `pid % 24 != 0`.
- The command sandbox can block things that look like tool bugs: writing
  `.gitmodules`, binding a socket for a local server. Retry outside it.

## Conduct

- **Never submit/publish anything external** (no issues, PRs, uploads). PokéAPI
  *reads* are authorized for tooling; include no personal info in requests.
- ROMs, the BPS patch, and `.sav` files are gitignored and **must never be
  committed** — they are copyrighted. `public/**` IS committed on purpose.
- The user's save backups are read-only source material.
- The user directs commits; sub-agents should not commit.
- Multi-agent workflow notes: past sessions ran parallel sub-agents (static disasm
  / empirical dump forensics / parser / emulator harness) whose reports
  cross-checked each other; keep that discipline — corroborate static claims
  against live data before trusting them, and record evidence + confidence in the
  analysis docs.

## Open items (data-starved, not blocking)

- Achievements storage format: candidate SB1+0xD2C..0xD45 (0xFF = locked); needs a
  save with ≥1 achievement earned.
- Mail struct parsing never exercised on an attached mail (location 0x1D98 is
  verified).
- gameStats idx31 holds an odd value — possibly repurposed.
- Parser branches no fixture exercises (and so unproven by the equivalence run):
  the relocated-party scan, encryption-key rescan, bag validation failure,
  `partyCount > 6`, follower modes 1–3, and populated mail.
