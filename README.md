# pk-recharged-viewer

A browser save analyzer for the ROM hack **Pokémon Recharged Yellow** — drag in a
save and get your trainer card, party, boxes, bag, Pokédex, badges, and progress
back as a readable page styled like the game itself.

Underneath it is a reverse-engineering project: the hack's memory layout was
mapped from scratch (the offsets database in [`research/`](research/) is the real
artifact), and the parser that reads it runs entirely in your browser.

## What is Recharged Yellow?

**Pokémon Recharged Yellow is a fan-made ROM hack by [Jaizu](https://x.com/JaizuFangaming)**
([@JaizuFangaming](https://x.com/JaizuFangaming)), available from their Ko-fi
shop: **https://ko-fi.com/s/7fec26b127** (name-your-price download). It ships as
a BPS patch you apply to a retail Pokémon Emerald ROM. The version analysed here
is 1.9.7.

It remakes Kanto — the Pokémon Yellow story — on top of the **Emerald** engine
rather than FireRed's: the ROM is a [pokeemerald](https://github.com/pret/pokeemerald)
decomp rebuild. Its header identifies as FireRed (`BPRE`), which is cosmetic and
misleading; this project's disassembly independently confirms the Emerald engine
underneath.

Things the hack does differently, all of them visible in the save data this tool
reads:

- a Yellow-style starter Pikachu that follows you around the overworld
- the original Yellow/RBY story order rather than FRLG's
- an accelerated in-game day/night clock, running about 9× real time
- opt-in level caps keyed to your badge count
- a six-pocket FRLG-style bag
- multi-language dialogue
- a custom achievements system ("Chievos"), and RetroAchievements compatibility

## Using it

Open the published page, or serve the repo locally:

```sh
bun run serve            # http://localhost:8000  (python3 -m http.server)
```

A local web server is required — the app is ES modules and `fetch`, which
browsers refuse to load from a `file://` URL.

Then drag a save onto the page. It accepts:

| what you have | file |
| --- | --- |
| handheld (MinUI / libretro mGBA core) | `Pokemon Recharged Yellow.gba.st0`, `.st9` |
| desktop mGBA save slot | `.ss0`–`.ss9`, including the PNG-screenshot kind |
| the game's own save file | `.sav` (128KB flash save) |
| a raw RAM dump | `iwram.bin` **and** `ewram.bin` together |

A `.sav` and a savestate differ in an important way. A savestate captures the
game as it is running, right now. A `.sav` is what the game wrote the last time
you saved — so the party, position, and clock are from that moment, and things
that only exist in memory (your follower, whether you're on a bike or surfing)
aren't in the file at all. The viewer says which kind it loaded and won't present
saved data as if it were live.

The save is all you need. Sprites, badge art, trainer art, and map tiles are
extracted from the ROM ahead of time and ship in `public/`, so the page renders
without a ROM.

## Development

No build step and no dependencies: the app is plain ES modules with Preact
vendored under `vendor/preact/`, and the parser is dependency-free.

```sh
bun test                      # unit tests for the parser
bun tests/compare-python.js   # equivalence vs the Python reference parser
bun run prepare-assets        # refresh public/ from the vendored PokéAPI mirrors
bun run sync-data             # refresh public/data/*.json from research/
```

**The equivalence harness is the important one.** `research/tools/parse_ram.py`
is a stdlib-only reference implementation of the parser, kept so
`bun tests/compare-python.js` can prove the JavaScript parser correct: it runs
both over every dump and save in the repo and requires byte-identical JSON. Every
input must match; a change that drops even one is a regression, so if you fix a
parsing bug, fix it in both implementations. Plain `python3` runs it — there is
no virtualenv and nothing to install.

Command-line use, if you want JSON rather than a page:

```sh
bun lib/parser/cli.js --state <save> --pretty
python3 research/tools/parse_ram.py --state <savestate> --pretty   # the oracle
```

## Layout

```
index.html          the app; no build step, all paths relative (works on Pages)
app/                Preact UI — components, view model, file handling
lib/parser/         the save parser: RAM/savestate/.sav -> game-state JSON
lib/gfx/            ROM graphics decoding (sprites, tiles, maps) — offline only
public/             everything the page serves: art extracted from the ROM and
                    PokéAPI, plus public/data/*.json (the parser's offset and
                    name tables, and the prepared view data)
tools/              offline asset pipeline: extraction and preparation
tests/              parser unit tests + the Python equivalence harness
research/           the reverse-engineering record — start at research/README.md
vendor/             submodules (PokéAPI mirrors, pokeemerald, pokefirered) and
                    vendored Preact
local/              your ROMs and the BPS patch — gitignored, never committed
```

## How it was built

The hack repacked its SaveBlocks, so no published offset table for Emerald or
FireRed applies to it, and the FireRed header sends you looking in the wrong
place to begin with.

So the layout was rebuilt from evidence, combining ROM disassembly with live RAM
dumps captured by an mGBA scripting harness, each method cross-checking the other.
Money was found by watching a known value sit at an unknown address across 29
dumps; the badge flags were confirmed three independent ways; a Pikachu injected
into RAM proved the Pokémon decryption end to end; and the flash save format
later re-confirmed the SaveBlock sizes from a completely different direction.
Every offset carries its evidence and a confidence rating, and the parser refuses
to emit a section it cannot vouch for — it reports an honest error instead of
plausible garbage.

[`research/README.md`](research/README.md) indexes all of it: the offsets
database, the per-section confidence table, the disassembly notes, and the dumps.

## Credits / thanks

- **[Jaizu](https://x.com/JaizuFangaming)** — creator of Pokémon Recharged
  Yellow. This project is an unaffiliated third-party tool for their game; get it
  from [their Ko-fi](https://ko-fi.com/s/7fec26b127).
- **[pret](https://github.com/pret)** — the `pokeemerald` and `pokefirered`
  decompilation projects, which made the memory map tractable.
- **[PokéAPI](https://pokeapi.co/)** — species metadata and sprites, vendored
  under `vendor/`.
- **Fonts** (`public/fonts/`, details in `public/fonts/PROVENANCE.md`) —
  community GBA font recreations built on FontStruct: *Pokemon Emerald* and
  *Pokemon Emerald Narrow* by aztecwarrior28, and *F77 Pokemon Battle* by
  anonymous-1520403, all CC BY-SA.
- **Cursors** (`public/cursors/`, details in `public/cursors/LICENSE.md`) —
  [pixelarticons](https://pixelarticons.com/) by Gerrit Halfmann, MIT.

