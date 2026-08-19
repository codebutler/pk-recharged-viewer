# pk-recharged-viewer — notes for coding agents

**What this project is, how to run it, and the repo layout: see [README.md](README.md).**
**The reverse-engineering record and the offsets database: see
[research/README.md](research/README.md)** — it indexes every analysis document
and the per-section confidence table.

This file carries only what an agent working on the code needs and those two
documents don't cover.

## The rule that matters: JS ships, Python verifies

The parser exists **twice, on purpose**:

- **`lib/parser/`** (JavaScript) is the implementation. Pure ES modules, no
  dependencies, no Node/Bun APIs on the parse path — it runs unchanged in the
  browser, which is what the app uses. `parse-ram.js` is the parser,
  `state-extract.js` handles savestate containers, `sav-extract.js` +
  `parse-blocks.js` handle flash `.sav`, `index.js` is the entry point, `cli.js`
  is the only file that touches the filesystem.
- **`research/tools/parse_ram.py`** (Python) is the **reference oracle**. It came
  first, every offset was verified through it, and it is kept so the JS port can
  be proven correct against it. Do not delete it and do not let it rot.

**After any parser change:**

```sh
bun test                      # unit tests
bun tests/compare-python.js   # must stay 82/82 inputs matching
```

The harness runs both parsers over every dump and save in the repo, then
deep-diffs the JSON. Only two fields may differ (`meta.tool`, and the
config-layer file paths). **A parsing fix belongs in both implementations** —
changing only one breaks the comparison, and that is the intended signal, not a
nuisance.

Everything under `research/tools/` is **stdlib-only with no packaging** — plain
`python3` runs it, no virtualenv, nothing to install. Keep it that way: a
third-party import there would break the one check that validates the JS parser.

Data tables live in `research/` (canonical) and are copied to `public/data/`;
after editing an offsets or gamedata file, run `bun run sync-data`.

**Flash `.sav` is JS-only** — `parse_ram.py` does not read it, so there is no
oracle. Its verification is a cross-check instead: the repo's `flash.sav` and
`st0.bin` are the same game state, and a test requires the two parses to agree
field-for-field (only playtime and the clock may differ, the savestate being
later). A `.sav` result carries `state.source.live = false` and a caveat string:
the party is the saved copy, follower and bike/surf state are absent, the clock
is frozen at the save.

## ROM graphics

Sprite/tile decoding lives in `lib/gfx/` (JavaScript, used by the app and by
`tools/extract-rom-assets.js`). Its Python counterpart is
`research/tools/gba_gfx.py` + `gba_map.py` + `rom_gfx.py`, which
`lib/gfx/verify_python.py` uses as an independent reference: it renders the same
scenes and byte-compares them against the JS output and the exported PNGs
(`python3 lib/gfx/verify_python.py --assets public`). Same stdlib-only rule as
the parser oracle. (`rom_gfx.py` holds the ROM-graphics helpers extracted from
the retired Jinja2 page generator the browser app replaced.)

## Matching the game's UI: measure, don't eyeball

The page imitates the game's own screens, and every disagreement about them was
settled the same way: by measuring a capture, never by arguing from memory.

- Ground truth is `research/dumps/trainer-card/card-front/screen.png` (and the
  sibling captures) — real frames from the user's own save, 240x160, one pixel
  per GBA pixel.
- The trainer card's CSS defines `--u` as **one GBA pixel** (a container-query
  fraction of the card's width), so every coordinate in that block is directly
  comparable to the capture and the whole card scales as one model. Add to it in
  those units, not in px.
- When a shape looks wrong, render a colour mask of the capture rather than
  guessing. That is how the card's background "swoosh" turned out to be a **Poké
  Ball** drawn huge with its centre one unit past the body's bottom-right corner
  (ring r 49u..80u, white gap, button r 32u) rather than the two filled arcs we
  had been drawing.
- Some oddities are the game's, and reproducing them is the point: the ball's
  ring stops dead at body row 77 because the card's tiled background runs out of
  art there. It is commented in `app/styles.css` so nobody "fixes" it.
- Two known traps: a corner-notch `clip-path` cuts into glyphs, so it belongs on
  plates without text; and an inset `box-shadow` frame paints UNDER child
  content, so children need padding or they cover the frame.
- Deliberate departures from the game, keep them: money carries thousands
  separators, and the Time row keeps its colon.

## Game facts that affect analysis

- The engine is **Emerald**, not FireRed, despite the `BPRE` header — structs and
  the script VM are pokeemerald's. Never use vanilla Emerald or FRLG offsets: the
  hack **repacked/compacted** its SaveBlocks. `research/hack-offsets.json` is
  canonical.
- **FRLG-style map numbering** grafted onto the Emerald engine (Pallet Town =
  mapsec 0x58), but the story follows the **original Yellow/RBY order**, not
  FRLG's — e.g. Pokémon Tower (rival fight → Lavender cutscene) must be done
  **before** the Celadon Rocket Hideout opens (story counter var `0x405D`).
- The hack **removed** the vanilla save-data XOR obfuscation (money and
  quantities are plaintext) and **removed** dedicated daycare storage. Pokémon
  data encryption (personality⊕OTID, substructure permutation, checksum) is
  **fully vanilla Gen 3**.
- HM field moves work **without teaching them** — check HM ownership, and never
  advise teaching an HM to a party member.
- Other hack systems, as they touch the save: achievements run on a custom
  **"Smsh" script VM** (storage format still unknown), the language byte at
  SB2+0x91 also carries follower options in its high bits, the Medicine pocket
  holds 100 slots, and the game **likely autosaves**.

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
- Sector checksums in a flash `.sav` only verify under the **hack's** struct sizes
  (SB1 0x3D94, SB2 0xF64), which independently re-confirms them.
- Species IDs are Gen 3 **internal** numbers; internal→national mapping is a
  standalone artifact (`research/species-mapping.json`, copied to `public/data/`).

Every emitted section carries a confidence label in `meta`, and unparseable
sections emit explicit errors rather than garbage — the per-section status table
is in `research/README.md`.

## Answering "what should I do next in the game?"

Recipe that worked well:

1. Parse the newest savestate. Read: badges, key items, party levels, location,
   `progressFlags`/story vars (var `0x405D` = Lavender/Celadon Rocket arc:
   0=not started, 1=tower rival beaten, 2=Lavender cutscene seen).
2. Map that onto original-Yellow progression (not FRLG's) to propose the next
   objective.
3. If an NPC/event seems stuck, or the question is "where do I get X" — **do not
   answer from vanilla Yellow/FRLG/Emerald knowledge, and do not re-derive it
   from the ROM by hand.** Every event script in the game is already dumped to
   `research/scripts/`; grep it. See the next section.

### The dumped scripts: `research/scripts/` — grep this first

`research/tools/dump_scripts.py` disassembles every event script in the ROM into
a readable, greppable tree. **Read `research/scripts/README.md` before relying on
a negative result** — it lists the real gaps. Headlines:

- `research/scripts/maps/gNN_mMM_<Name>.txt` — one file per map: every object
  event, sign, coord trigger and map-script table, disassembled with dialogue
  inlined and items, species, moves, movement sequences, `callstd` ids and known
  flags/vars resolved to names. Each file opens with a legend for the hex that
  remains on purpose (ROM pointers, sprite ids, trainer ids).
- `research/scripts/index/item-sources.json` — item name → every place it can be
  obtained (mart stock, ground item balls, hidden items, scripted gives).
- `research/scripts/index/marts.json`, `index/stats.json`.
- `research/script-opcodes.json` — the opcode table, derived from pokeemerald's
  macros *and* its C handlers (they agree on 223/227), overlaid with this ROM's
  own command table at 0x081F1630 (235 entries), plus `callstd`/movement-action
  constant tables. Research-only: **not** part of `bun run sync-data`, since the
  browser app does not read it.

**Coverage numbers live in `research/scripts/index/stats.json`** — read them
there rather than trusting a figure copied into prose. As of the initial dump:
~95.6% of scripts reach a clean terminator across 491 maps (the other 35 of 526
have no scripts, only warps — verified).

Five hack-custom opcodes (0xE3, 0xE4, 0xE5, 0xE7, 0xE9) are deliberately
**unresolved** and stop their script rather than desynchronize it. Also **not**
covered: the shared `gStdScripts` table (so `callstd` targets are unrendered),
trainer parties, wild encounters, Game Corner prizes, battle scripts, and the
Smsh achievement VM — so "no mart sells it" does not rule out the Game Corner.

Regenerate after any ROM change with `python3 research/tools/dump_scripts.py`
(stdlib-only; needs the ROM in `local/`). `research/tools/extract_opcodes.py`
regenerates the opcode and constant tables from the pokeemerald submodule.

`research/scripts/` is ~7 MB across ~490 files and is **not** gitignored, so it
commits by default. That is intentional — it is the artifact that makes future
sessions cheap — but decide deliberately, and never commit the ROM itself.

This tooling exists because of a real failure mode: answering gameplay questions
from vanilla-Pokémon recall. In one session that produced advice to teach an HM
(this hack allows field moves straight from the bag) and a wrong claim about a
move's type. Grep the dump for script/event facts, and `research/gamedata.json`
for species/move/item facts. Do not answer either from memory.

**The user's real progression lives on a handheld** (MinUI device, libretro mGBA
core). A backup from 2026-08-18 is at `/Users/eric/rgsp-saves-backup-2026-08-18/`
(**read-only — never modify it**); its parsed snapshots are
`research/real-saves/st0.json` / `st9.json`. For "what's my current state"
questions, ask for a **fresh** backup first — the dated snapshot goes stale as
they play. On the device the state file is
`shared/MGBA-mgba/Pokemon Recharged Yellow.gba.st0`.

## Tooling & environment gotchas

- Emulation/scripting requires the **mGBA 0.11 nightly**
  (`/Applications/mGBA-nightly.app`); the brew formula is broken and stable mGBA
  lacks `--script`. Harness: `research/tools/run_harness.sh` (dump/input-injection
  Lua under `research/tools/`). mGBA silently ignores `--script` when the ROM sits
  under `/var/folders/...`.
- pret decomp clones live at `vendor/pokeemerald` (authoritative) and
  `vendor/pokefirered`. pokefirered was long dismissed here as a dead end, but
  that is **wrong for script commands**: the hack is FRLG content on the Emerald
  engine, so commands Emerald stubs out but FRLG implements (0xC7 `textcolor`,
  0xD0 `setworldmapflag`) are documented correctly only in pokefirered, which
  confirmed both. Check it before calling an opcode unknowable. Its command
  table has 214 entries vs Emerald's 227, so neither decomp explains the hack's
  own customs at 0xE3-0xEA.
- RAM-injection round-trips are a proven verification technique here (see
  `research/dumps/inject/`); if injecting mons, use a personality with
  `pid % 24 != 0`.
- The command sandbox can block things that look like tool bugs: writing
  `.gitmodules`, binding a socket for a local server. Retry outside it.
- A shell glob with no matches aborts the whole command in fish. After any bulk
  rewrite, sweep the repo to confirm it actually applied.

## Conduct

- **Never submit/publish anything external** (no issues, PRs, uploads). PokéAPI
  *reads* are authorized for tooling; include no personal info in requests.
- ROMs, the BPS patch, and `.sav` files live in `local/` and **must never be
  committed** — they are copyrighted.
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
