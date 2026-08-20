# research/ — notes for coding agents

**The reverse-engineering record and the offsets database: see
[research/README.md](../research/README.md)** — it indexes every analysis
document and the per-section confidence table.

For answering the user's questions about their own save/savestate ("where am
I", "what should I do next"), see [../CLAUDE.md](../CLAUDE.md) instead — that
recipe lives at the repo root because it applies regardless of which files an
agent happens to touch.

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
bun tests/compare-python.js   # every input must match (84/84 as of 2026-08-19;
                              # the count grows when a run adds dumps)
```

The harness runs both parsers over every dump and save in the repo, then
deep-diffs the JSON. Only two fields may differ (`meta.tool`, and the
config-layer file paths). **A parsing fix belongs in both implementations** —
changing only one breaks the comparison, and that is the intended signal, not a
nuisance.

The **verification** tools under `research/tools/` are **stdlib-only with no
packaging** — plain `python3` runs them, no virtualenv, nothing to install. That
is `parse_ram.py` (and `state_extract.py`, which it uses) plus the graphics
reference below; a third-party import in those would break the one check that
validates the JS parser. Other tools in that directory may take dependencies,
declared as PEP 723 inline script metadata and run with `uv run` — see
`research/tools/disasm.py`, which uses capstone.

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

## The dumped scripts: `research/scripts/` — grep this first

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

## Chasing an IWRAM address (or a cheat code)

Start with `research/engine-architecture.md` — how a screen (a CB2 plus a
`gMain.state` setup machine) relates to the 16-slot `gTasks` array, with
citations into `vendor/pokeemerald`. `research/cheat-code-formats.md` decodes
the cheat-device formats out of `vendor/mgba`'s own source, so the code type is
a citation rather than a recollection. The tool is `research/tools/disasm.py`
(`uv run`, capstone): it names literals from `hack-offsets.json` and decodes
addresses inside the task array to `gTasks[id].data[k]`.

The fact that changes every conclusion, if you read nothing else: **task data is
screen-scoped scratch**. `ResetTasks` + lowest-free-slot `CreateTask` means
`gTasks[0]` is *the current screen's main task*, so one address is a different
variable per screen and is never saved. Work out which screen owns the slot
before deciding what the address means — and note that the dump corpus under
`research/dumps/` is overwhelmingly overworld, so "quiet in every dump" mostly
says the corpus never opened that screen.

A worked example, including the wrong turns, is in `hack-offsets.md` under
"Task data, and the bag sell path".

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
- Two more references are vendored: `vendor/mgba` (the emulator's source —
  authoritative for cheat-code formats, MPL-2.0, a submodule) and
  `vendor/gbatek` (GBATEK, Martin Korth's GBA hardware reference — a fetched
  copy, third-party and non-commercial; attribution stays, keep it out of any
  deploy).
- RAM-injection round-trips are a proven verification technique here (see
  `research/dumps/inject/`); if injecting mons, use a personality with
  `pid % 24 != 0`.
- The command sandbox can block things that look like tool bugs: writing
  `.gitmodules`, binding a socket for a local server. Retry outside it. mGBA is
  one of these: it aborts with **"no screens available"** (window-server access)
  until the sandbox is off. `uv` is *not* — it only needs its cache redirected:
  `UV_CACHE_DIR=$TMPDIR/uvcache uv run …` works sandboxed, where a bare `uv run`
  fails on `~/Library/Caches/uv`.
- A shell glob with no matches aborts the whole command in fish. After any bulk
  rewrite, sweep the repo to confirm it actually applied.

## Research workflow notes

Past sessions ran parallel sub-agents (static disasm / empirical dump
forensics / parser / emulator harness) whose reports cross-checked each other;
keep that discipline — corroborate static claims against live data before
trusting them, and record evidence + confidence in the analysis docs.

The user's save backups (wherever they land under
`/Users/eric/Code/RGSP/backups/`, or the older single-path backup referenced
in some analysis docs) are read-only source material — never modify them.

## Open items (data-starved, not blocking)

- Achievements storage format: candidate SB1+0xD2C..0xD45 (0xFF = locked); needs a
  save with ≥1 achievement earned.
- Mail struct parsing never exercised on an attached mail (location 0x1D98 is
  verified).
- gameStats idx31 holds an odd value — possibly repurposed.
- Parser branches no fixture exercises (and so unproven by the equivalence run):
  the relocated-party scan, encryption-key rescan, bag validation failure,
  `partyCount > 6`, follower modes 1–3, and populated mail.
