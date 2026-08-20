# Where the maps came from

**Recharged Yellow's maps are FireRed's maps.** 69% of pokefirered's layouts are
in the ROM byte-for-byte; another 29% are edited copies that still keep three
quarters of FireRed's original block data. Almost nothing was drawn from
scratch.

Produced by `research/tools/map_provenance.py`. This is the harder version of a
claim already in the record — `hack-offsets.md` established that FRLG-style map
*numbering* was grafted onto the Emerald engine. This shows the map *bytes* were
taken too.

## Method

A Gen 3 map layout is an uncompressed `u16` array of block ids, so a decomp's
`data/layouts/<Map>/map.bin` can be searched for verbatim inside a ROM image. No
disassembly or inference required.

Two measurements per layout:

- **exact** — the whole `map.bin` occurs in the ROM, so the map was copied
  untouched.
- **containment** — the fraction of the layout's 16-byte (8-block) fragments
  occurring anywhere in the ROM. Fragments survive editing, so this separates an
  *edited copy* from a map that was never there.

Every figure is reported against a control: the same measurement run on retail
Emerald, a ROM the FRLG maps are known not to come from.

## Controls

| | verbatim | note |
| --- | ---: | --- |
| pokeemerald layouts vs. retail Emerald | 414/414 — **100%** | the method finds what is there |
| pokefirered layouts vs. retail Emerald | 22/363 — **6%** | noise floor, all short maps |
| pokefirered layouts ≥512 bytes vs. retail Emerald | **0%** | noise vanishes with size |

18 of 268 layouts have to be discarded rather than trusted: they score ≥30%
containment against retail Emerald, because Ruby/Sapphire shipped the same map
(`RS_SafariZone_*`, `SSTidal_*`, `EverGrandeCity_HallOfFame`) or the layout is a
single repeated block. All figures below use the 250 layouts whose control is
clean; their mean control containment is 7%.

## Result

Of 250 pokefirered layouts ≥256 bytes with a trustworthy control:

| | layouts | share |
| --- | ---: | ---: |
| copied verbatim | 174 | **69%** |
| edited copy (mean 74% of FRLG fragments kept) | 73 | **29%** |
| not present | 3 | 1% |

The verbatim layouts occupy one contiguous region, `0x08ABF854`–`0x08B39CF4`.
That is a wholesale data port, not maps rebuilt one at a time.

By contrast only 19% of *pokeemerald's* own layouts survive in the hack.

## What got edited

Interiors were taken as-is; the outdoor world was reworked on top of FireRed's:

| map | FRLG fragments kept | control |
| --- | ---: | ---: |
| Rocket Hideout B4F | 95% | 2% |
| Celadon Game Corner | 93% | 3% |
| Route 11 | 74% | 5% |
| Pallet Town | 71% | 0% |
| Pewter City | 60% | 0% |
| Viridian City | 58% | 0% |
| Celadon City | 57% | 0% |
| Cerulean City | 57% | 1% |
| Vermilion City | 52% | 0% |
| Route 8 | 48% | 11% |
| Route 17 | 48% | 0% |
| **Lavender Town** | **18%** | 2% |

Towns and routes sit at 48–74%: someone opened FireRed's Pallet Town in a map
editor and changed it toward the Yellow-era layout, rather than starting on a
blank grid.

**Lavender Town is the one genuine redraw** — 18%, below even the "edited"
threshold. Worth noting alongside the fact that the hack restructures the
Pokémon Tower arc to RBY order (`0x405D`), though nothing here establishes the
two are connected.

## The Sevii Islands are still in the data

Worth recording because it is easy to assume otherwise: a Yellow remake has no
use for the Sevii Islands, but their layouts are in the ROM anyway — of 53,
**27 verbatim and 24 edited**, only 2 absent. Some were even edited, which is not
what you would do to content you had abandoned.

This says nothing about whether the game can *reach* those maps; layout data
being present in ROM is not the same as the map being used. Whether the warps
and map headers connect them is untested.

## Reading it together with the code

`vanilla-code-coverage.md` finds 64% of the hack's *code* is verbatim
pokeemerald. This finds ~69% of its *maps* are verbatim pokefirered. The project
took the engine from one decomp and the world from the other, then wrote the
Yellow story on top — which is why the FireRed header, the Emerald internals and
the RBY story order all coexist in one ROM.
