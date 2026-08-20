# pk-recharged-viewer — notes for coding agents

**What this project is, how to run it, and the repo layout: see [README.md](README.md).**
**Everything about the reverse-engineering work itself — the parser, ROM
graphics, tooling, offsets, conventions — lives in
[research/CLAUDE.md](research/CLAUDE.md), which also indexes
[research/README.md](research/README.md)**, the RE record and confidence
table.

This file covers exactly one thing: answering the user's questions about
**their own save/savestate** — "where am I," "what should I do next,"
"where do I get X." Read research/CLAUDE.md before doing anything else in
this repo.

## Answering questions about the user's saved data

When the user asks about their own save/savestate (location, party, items,
progress, "where am I", "what should I do next", etc.), answer in **plain
English only** — like relaying game info to a friend. No JSON, no offsets, no
hex, no field names (`mapLayoutId`, `progressFlags`, `0x405D`), no confidence
labels, no mention of the parser/tooling. Parsing the save and reading the
technical fields is still the right way to *get* the answer — just don't show
that work in the reply. If a genuinely technical detail is needed to answer
well, translate it into plain language rather than quoting the raw value.

Parse with the JS parser (`bun lib/parser/cli.js --state <file> --pretty`) —
it's the implementation that ships, not the Python reference oracle. See
research/CLAUDE.md if you need to know why both exist.

**The user's real progression lives on a handheld** (MinUI device, libretro
mGBA core), backed up periodically to a dated folder under
`/Users/eric/Code/RGSP/backups/` (**read-only — never modify a backup**). For
"what's my current state" questions, use the newest backup available — ask for
a fresh one if the newest looks stale. On the device the state file is
`shared/MGBA-mgba/Pokemon Recharged Yellow.gba.st0`.

## How this hack differs from vanilla Pokémon

Keep these in mind whenever they're relevant to the question — don't answer
from vanilla Yellow/FRLG/Emerald recall, since any of these could make that
recall wrong:

- **Story order follows original Yellow/RBY, not FRLG's**, even though the
  hack grafted FRLG-style map numbering onto the Emerald engine. E.g.
  Pokémon Tower (rival fight → Lavender cutscene) happens **before** the
  Celadon Rocket Hideout opens. Progress var `0x405D` tracks this arc:
  0=not started, 1=tower rival beaten, 2=Lavender cutscene seen.
- **HM field moves work without teaching them** to a party member — never
  advise teaching an HM; just check whether the player owns it.
- **The Pokédex is always the national dex** — no national-dex unlock flag
  exists, the dex loop always runs to all 386.
- **Save-data XOR obfuscation is removed** (money and similar fields are
  plaintext), but per-Pokémon structure encryption (personality⊕OTID,
  substructure permutation, checksum) is still fully vanilla Gen 3.

This list is what's currently confirmed; treat it as incomplete rather than
exhaustive — research/CLAUDE.md and research/README.md's confidence table may
have more. If something behaves unexpectedly, that's a cue to check there or
grep the scripts, not to fall back on vanilla-game memory.

## Answering "what should I do next in the game?"

Recipe that worked well:

1. Parse the newest savestate. Read: badges, key items, party levels,
   location, `progressFlags`/story vars.
2. Map that onto original-Yellow/RBY story order (see above) and propose the
   next objective from it.
3. If an NPC/event seems stuck, or the question is "where do I get X" — **do
   not answer from vanilla Yellow/FRLG/Emerald knowledge, and do not re-derive
   it from the ROM by hand.** Every event script in the game is already
   dumped to `research/scripts/` (grep it) — see research/CLAUDE.md for how
   that corpus is organized and its known gaps.

This tooling exists because of a real failure mode: answering gameplay
questions from vanilla-Pokémon recall. In one session that produced advice to
teach an HM and a wrong claim about a move's type. Grep the dump for
script/event facts, and `research/gamedata.json` for species/move/item facts.
Do not answer either from memory.

## Conduct

These apply to all work in this repo, not just save-question answering:

- **Never submit/publish anything external** (no issues, PRs, uploads). PokéAPI
  *reads* are authorized for tooling; include no personal info in requests.
- ROMs, the BPS patch, and `.sav` files live in `local/` and **must never be
  committed** — they are copyrighted.
- The user's save backups are read-only source material.
- The user directs commits; sub-agents should not commit.
