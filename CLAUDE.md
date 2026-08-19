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
3. If an NPC/event seems stuck, don't guess — **decompile the gating script from
   the ROM**: map headers via `gMapGroups` @ROM 0x08B3F134, object events → script
   pointers, standard pokeemerald script opcodes (plus custom 0xE6 = multi-language
   msgbox, 0xE8 = speaker name). Then compare required flags/vars against the
   parsed save. Method details and worked example in `research/hack-offsets.md`.

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
  `vendor/pokefirered` (historical dead end — ignore).
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
