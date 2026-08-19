# Pokemon Recharged Yellow — RAM and ROM extraction

Tooling and reverse-engineering notes for reading the full game state (player,
party, boxes, bag, dex, flags) out of a RAM dump of a running **Pokemon Recharged
Yellow** (v1.9.7), and for reading the game's **event scripts** out of the ROM.

> **Answering a gameplay question?** Every event script is dumped to
> `scripts/` — grep that instead of recalling vanilla Pokémon behaviour, which
> has been wrong here before. `scripts/index/item-sources.json` maps an item to
> everywhere it can be obtained. Read `scripts/README.md` for the coverage gaps
> before trusting a negative result. The ROM is a **pokeemerald decomp rebuild** — the BPRE/FireRed
header is cosmetic; the distribution .bps patch applies to retail Emerald
(verified by CRC). See `rom-fingerprint.md` for the identification chain.

> **Where the shipping code lives.** This directory is the research record and
> the offsets database. The parser that users actually run is the JavaScript port
> in `../lib/parser/`, which powers the browser app. `tools/parse_ram.py` is kept
> as the **reference oracle**: `bun tests/compare-python.js` runs both parsers
> over every dump and savestate here and requires byte-identical JSON, so the
> Python tool is what proves the JS port correct. Fix a parsing bug in both, or
> the comparison fails. The offsets in `hack-offsets.json` remain canonical for
> both; `public/data/` is a synced copy for the browser.

## Quickstart

Produce a dump (mGBA 0.11 nightly required — see `tools/README.md`):

```sh
tools/run_harness.sh "../local/Pokemon Recharged Yellow.gba" mylabel 20000 600 1
# dumps land in dumps/mylabel/<frame>/  (iwram.bin + ewram.bin + pointers.txt + screen.png)
```

Or take a raw dump from any emulator: IWRAM (32 KB @ 0x03000000) as `iwram.bin`
and EWRAM (256 KB @ 0x02000000) as `ewram.bin` in one directory.

Parse it:

```sh
python3 tools/parse_ram.py dumps/mylabel/f004200 --pretty      # dump directory
python3 tools/parse_ram.py path/iwram.bin --ewram path/ewram.bin
```

An mGBA **savestate** from a human-played session works too (`.ss0`-`.ss9` slot
files, scripted states, or libretro-core `.st*` files from MinUI-style
handhelds; not flash `.sav` — the JS parser reads those, `parse_ram.py` does not):

```sh
python3 tools/parse_ram.py --state save.ss0 --pretty
```

To *view* a parse rather than read JSON, use the browser app at the repo root —
it supersedes the Jinja2 page generator that used to live here (`generate_page.py`
+ `templates/`, deleted along with the `uv`/jinja2 dependency once the app
replaced it).

Everything under `tools/` is **stdlib-only** and runs with bare `python3`: no
virtualenv, no `pyproject.toml`, nothing to install. Keep it that way — a
third-party import here would break `bun tests/compare-python.js`, the check that
validates the JavaScript parser.

Python 3 stdlib only. Output is one JSON document; `meta` carries anchors,
per-section confidence, and offset provenance. Pre-game dumps (title/intro)
report `"inGame": false` instead of garbage. Offset layering: built-in vanilla
defaults → `tools/offsets-discovered.json` → `hack-offsets.json` → `--offsets`.

## Memory map in brief

**Pointers.** IWRAM `0x03005AD0/AD4/AD8` → SaveBlock1 / SaveBlock2 /
PokemonStorage. Buffer bases 0x0200EBD0 / 0x0200DBEC / 0x020129E4 plus one shared
ASLR shift (multiple of 4, 0..0x7C) re-randomized on load **and periodically
while idle (likely autosave: vanilla only reshuffles on save)** — always
dereference, never cache. Pointers become valid
before the title screen, so pointer validity is NOT an in-game test; the parser
uses content anchors.

**The saveblocks are repacked, not vanilla-plus-insertions.** Vanilla Emerald
offsets hold only for SB1+0x00–0x33 and SB2+0x00–0x8F. The hack moves mapView
(to SB1+0x2510, a tile cache — not parsed), deletes most Hoenn data, moves
BattleFrontier SB2→SB1, and repacks. Sizes: SB1
0x3D94, SB2 0xF64, Storage 0x83D0 (= vanilla). The XOR "encryption"
(money/coins/quantities/gameStats key) is **removed** — everything is plaintext.
BoxPokemon/party-mon encryption (personality^otId, %24 substruct permutation,
u16 checksum) is **fully vanilla**.

**Live vs saved party.** SB1's party is a copy-on-save (kept fresh by the likely
autosave);
the live party is the EWRAM globals below. The parser emits both (`party` =
live, `savedParty` = SB1 copy, source-labeled).

| state | where | confidence |
|---|---|---|
| player name/gender/TID/playtime/options | SB2 +0x00/+0x08/+0x0A/+0x0E/+0x14 | confirmed live |
| pos / location / mapLayoutId | SB1 +0x00 / +0x04 / +0x32 | confirmed live (layout id == ROM map header) |
| party (live) | EWRAM 0x02038559 count, 0x0203855C 6×0x64 | confirmed live (injected mon, checksums) |
| party (saved copy) | SB1 +0x3B count, +0x44 mons | confirmed live |
| money / coins / registeredItem | SB1 +0x29C u32 / +0x2A0 u16 / +0x2A2 u16 (plain) | money confirmed; coins consistent |
| pcItems | SB1 +0x2AC ×50 | disasm high, live-consistent |
| bag (FRLG-style 6 pockets) | Items 0x374×60, Medicine 0x2380×100, Balls 0x52C×32, TM/HM 0x5AC×64, Berries 0x6AC×46, KeyItems 0x464×50 | gBagPockets @0x0200B770 confirmed live across 17 ASLR shifts |
| flags | SB1 +0xEFB, 0x12C bytes | confirmed live |
| badges | flags 0x880–0x887 (byte SB1+0x100B) | disasm, triple-verified |
| vars | SB1 +0x1028, var 0x4000+i at +2i | confirmed live |
| pokedex owned / seen | SB2 +0x28 / +0x5C, 0x34 bytes each (mirrors removed) | disasm high; bit convention unconfirmed |
| PC boxes | Storage +0x4, 14×30×0x50; names +0x8344 | confirmed (fully vanilla) |
| gameStats | SB1 +0xB50, u32[64], plain, vanilla enum order | live-verified on real save |
| day/night clock (9× speed) | SB2 +0xF5C | confirmed live |

Depth: `hack-offsets.md` (disassembly evidence chain, per-field),
`hack-offsets.json` (machine-readable, consumed by the parser),
`empirical-anchors.md` (live-dump verdict per claim), `structs-notes.md`
(vanilla-Emerald baseline + Gen-3 encryption spec), `rom-fingerprint.md`
(engine identification).

## File inventory

| file | role | produced by |
|---|---|---|
| `rom-fingerprint.md` | engine identification: pokeemerald rebuild, relocated pointers, item/species tables | rom-fingerprint agent |
| `structs.json` / `structs-notes.md` | vanilla pokeemerald layouts (compile-verified), charmap, substruct permutation, encryption spec | structs agent |
| `firered-structs.json` / `firered-structs-notes.md` | FireRed equivalents (superseded for **save layout** once the ROM proved Emerald-based — but note FRLG is still the right reference for *script commands* Emerald stubs out; see `scripts/README.md`) | structs agent |
| `hack-offsets.json` / `hack-offsets.md` | the hack's actual SaveBlock layouts from ROM disassembly — primary offset source | hack-offsets agent |
| `gamedata.json` | name tables from the ROM: species 412, items 409 (+pocket map), moves 355, abilities 78, natures, (group,num)→map name | gamedata agent |
| `empirical-anchors.md` / `.json` | live-RAM verification verdict for every hack-offsets claim | struct-extract agent |
| `species-mapping.json` | canonical Gen-3 internal id → national dex number (+ name, PokéAPI slug where resolved); table verified byte-identical in the hack ROM @0x9651D8 | ram-parser agent |
| `tools/parse_ram.py` | dump → game-state JSON; the **reference oracle** the JS parser in `../lib/parser/` is diffed against (stdlib-only, no packaging) | ram-parser agent |
| `tools/gba_gfx.py` / `gba_map.py` / `rom_gfx.py` | ROM graphics + map rasterizing; the reference `../lib/gfx/verify_python.py` checks the JS rasterizer against | page/gfx agents |
| `tools/offsets-discovered.json` | dump-verified offset facts (parser config layer) | ram-parser agent |
| `scripts/` | **every event script in the ROM**, disassembled one file per map, plus `index/item-sources.json`, `index/marts.json`, `index/stats.json` (coverage + gaps). See `scripts/README.md` | script-dump |
| `script-opcodes.json` | the event-script opcode table: argument widths derived twice independently from pokeemerald (`event.inc` macros and `scrcmd.c` handlers, agreeing on 223/227), plus `callstd` and movement-action constants. Research-only — **not** synced to `public/data/` | script-dump |
| `tools/dump_scripts.py` | ROM → `scripts/` (walks `gMapGroups`, decodes, resolves names, builds the indexes). stdlib-only; needs the ROM in `../local/` | script-dump |
| `tools/gba_script.py` | the Gen-3 text codec and script decoder `dump_scripts.py` is built on | script-dump |
| `tools/extract_opcodes.py` | regenerates `script-opcodes.json` from the pokeemerald submodule | script-dump |
| `tools/run_harness.sh` + `mgba_dump_harness.lua` | timed dump harness (A/Start spam) | harness agent |
| `tools/mgba_inject_harness.lua` / `_walk_` / `_explore_` | RAM-injection and exploration harness variants | harness agent |
| `tools/README.md` | mGBA setup, harness usage, dump format, live-vs-saved party notes | harness + ram-parser agents |
| `dumps/newgame-spam/` | 34 dumps of a fresh game (33 timed, f000600–f019800, + final); f000600–f002400 are pre-game | harness agent |
| `dumps/inject/` | dumps with an injected party Pikachu + bag Potion (party/bag ground truth) | harness agent |
| `real-saves/` | the user's real handheld savestates (libretro `.st0`/`.st9`, 9h23m, Celadon, 4 badges) + parsed JSON — organic end-to-end ground truth | ram-parser agent (source: user's MinUI backup) |
| `dumps/explore-starter/` | timed dumps of an intro-exploration run (no starter reached; party empty throughout) | harness agent |

## Status per parser section

| section | confidence | verified by | open items |
|---|---|---|---|
| player | high | live dumps | — |
| location | high | live + ROM-header cross-check | — |
| party / savedParty | high | injected-mon dumps, checksums | — |
| pcBoxes | high | layout vanilla; mons synthetic-tested | — |
| bag | high (offsets) | injected Potion ×5 (plaintext qty confirmed) | on the inject dumps the parser reports `suspect` — the harness put the Potion (a Medicine-pocket item) in the Items array, tripping the pocket-type cross-check; Medicine pocket (0x2380) still unexercised |
| pcItems | medium | disasm + synthetic only (empty in all real dumps) | — |
| pokedex | high | disasm + real save (bit convention confirmed vanilla: species N → bit N−1, 6/6 party species check) | — |
| badges | high | disasm (flags 0x880–0x887) | all-false on new game (vacuous live) |
| progressFlags | high–medium | disasm-derived IDs (starter trio 0x860/0x861/0x87A, gameClear 0x864, intro 0x89E, shoes 0x866); intro flag live-confirmed | trio's individual meanings not separable; raw array still emitted as `flagsRawHex` |
| levelCap (derived) | high | level-cap fn @0x08168708 + challenge byte SB2+0x6E0 | — |
| gameClock | high | day u16/hour/min/sec all live-confirmed (9× rate); rollover copy at SB2+0xE0 emitted | — |
| rivalName | high | SB2+0x6E2 ("Kennedy" on real save, distinct from player) | — |
| mail | medium | live ClearMail pattern at SB1+0x1D98 (slots 0–5 party, 6–15 PC) | three candidates: 0x1D98 (parsed), ~0x1DB8 (static mail code), 0x910 (load_save side, all-zero live); real mail item would settle it |
| trainer rematches | not parsed | disasm: step counter u16 @SB1+0x8AA, trainerRematches[100] @0x8AC | Match Call system (earlier "mon slot" guess corrected) |
| daycare | n/a | strong evidence of absence | no dedicated SB storage; deposits likely go via PC storage script-side |
| achievements | not parsed | — | owned by the hack's custom "Smsh" script VM; candidate region SB1+0xD2C..0xD45 (0xFF-initialized = locked; user has zero earned, format unreadable yet), secondary candidates 0x2178/0x1280 (see hack-offsets.json) |
| runningShoes | dropped | flag 0x866 refuted on real save | running appears always-on; no flag exists |
| berryTrees | high | live pre-planted tree data at SB1+0x1998 | — |
| gameStats | high | SB1+0xB50, real-save values match vanilla GAME_STAT enum exactly (41 saves, 28582 steps, 328 battles…) | earlier "removed" verdict corrected |

## Reproduction notes

mGBA **0.11 nightly** is required (`--script` doesn't exist in 0.10.x, and the
Homebrew formula build is broken); install per `tools/README.md`. Gotcha: mGBA
silently skips `--script` when the ROM sits under `/var/folders/...` — keep ROM
and outputs on normal paths (the driver script handles this). Runs are
real-time (~60 fps; 20000 frames ≈ 5.5 min) with a visible Qt window.
