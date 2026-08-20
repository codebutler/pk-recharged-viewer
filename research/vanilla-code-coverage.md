# How much of the hack is still pokeemerald?

**Result: 64% of Recharged Yellow's compiled code is byte-for-byte vanilla
pokeemerald. 36% is not.** The 36% is an *upper* bound on the hack's own code —
see the caveats.

Produced by `research/tools/match_vanilla.py`. The question it answers is
practical: if you wanted a buildable source tree for this ROM, how much of it
would you already have from [pret](https://github.com/pret/pokeemerald), and how
much would have to be written?

## Method

A reference pokeemerald is built from source and every one of its functions is
fingerprinted and searched for in the target ROM.

| | |
| --- | --- |
| reference | `vendor/pokeemerald` @ `9a83a2bb`, built `MODERN=1` |
| compiler | ARM GNU Toolchain 14.2.rel1 (`arm-none-eabi-gcc 14.2.1`) |
| functions | 15,574 of ≥12 bytes, 1,988,070 bytes of code |
| target | `Pokemon Recharged Yellow.gba` (1.9.7) |

The fingerprint is the function's Thumb halfwords, with two allowances that let a
*relocated* function still compare equal:

- **BL/BLX pairs are masked.** Every call target moved when the hack relinked,
  but the call-graph shape did not.
- **Pointer-looking aligned words are wildcards** (`0x02xxxxxx`–`0x09xxxxxx`).
  These are literal-pool entries holding addresses, which all moved.

Everything else must match exactly; a function is accepted at ≤10% mismatch over
its non-wildcard halfwords. Keys are taken at four offsets into each function, so
an edited prologue still produces a candidate hit.

## Controls

The number is only worth anything because both controls behave:

| control | functions found | code bytes |
| --- | --- | --- |
| reference vs. itself (ceiling) | 15,574 / 15,574 — 100% | 99.7% of its code region |
| **retail Emerald** vs. reference (floor) | 411 / 15,574 — 2.6% | **0.7%** |
| known-address spot check | of 18 testable vanilla names, 8 found at exactly their recorded hack address and 2 within 12 bytes of it; **0 placed anywhere else** | |

The negative control is the important one. Retail Emerald is *the same source
code* as the reference, compiled with agbcc instead of gcc — and it scores 0.7%.
So the method does not match across compilers, and a hit means the same compiler
emitted the same code rather than merely similar code. It also means Jaizu built
with a gcc very close to 14.2: that is why this works at all.

The spot check runs against `rom_functions` in `hack-offsets.json`, whose
addresses were found by hand, one at a time, by disassembly. It is a check on
*precision*, and the matcher never contradicted it: every function it located
landed on the documented address (`ResetTasks`, `CreateTask`,
`ConvertIntToDecimalStringN`, `StringExpandPlaceholders`, `DisplayItemMessage`,
`CreateBagInputHandlerTask`, `SellItem`, `AdjustQuantityAccordingToDPadInput`),
with `ConfirmSell` 12 bytes off and `ItemIdToBallId` landing on a different one
of the several inlined copies that entry already notes.

Recall is the weaker half, and interestingly so: the 9 misses are
`AddMoney`, `GetItemPrice`, `RemoveBagItem`, `CopyItemName`,
`Task_BagMenu_HandleInput`, `Task_WallyTutorialBagMenu`,
`DisplaySellItemPriceAndConfirm`, `Cmd_handleballthrow` and `TaskDummy` (too
short to index). Every one of the first eight sits in a subsystem
`hack-offsets.md` independently documents as *modified* — the six-pocket bag,
the sell path that "converts with 7 digits where vanilla" does not, the
ball-catch routine. The misses corroborate the metric rather than undermine it:
the matcher is failing exactly where the hack changed the code.

## Result

The hack's code region ends at `0x081DB7D8`; past that the image is almost
entirely data, a few KB of compiler runtime aside. Vanilla's own code region is 1,976,172 bytes, so the two are
within 1.5% of each other in total size.

| | bytes | share |
| --- | ---: | ---: |
| hack code region | 1,947,608 | 100% |
| verbatim pokeemerald | 1,248,942 | **64.1%** |
| unattributed | 698,666 | **35.9%** |

Seen from the vanilla side: **11,444 of 15,574 pokeemerald functions (73.5%)
survive into the hack essentially untouched.** The other 4,123 (734,712 bytes of
vanilla code) break down by how much of the original is still recognizable:

| | functions | vanilla bytes |
| --- | ---: | ---: |
| no trace at all — deleted or fully rewritten | 2,588 | 370,512 |
| shell only (>50% differs) | 859 | 256,526 |
| heavily edited (25–50% differs) | 390 | 56,570 |
| close variant (≤25% differs) | 286 | 51,104 |

## Where it diverges

Per source file, by vanilla code bytes no longer present:

| file | gone | kept | |
| --- | ---: | ---: | ---: |
| `tv.c` | 43,618 | 612 | 98% |
| `pokemon_storage_system.c` | 27,750 | 24,552 | 53% |
| `pokemon_summary_screen.c` | 20,530 | 1,898 | 91% |
| `event_object_movement.c` | 19,864 | 39,710 | 33% |
| `roulette.c` | 19,840 | 34 | 99% |
| `pokemon.c` | 18,172 | 12,052 | 60% |
| `decoration.c` | 16,208 | 170 | 98% |
| `party_menu.c` | 14,758 | 30,154 | 32% |
| `trade.c` | 14,246 | 14,510 | 49% |
| `pokedex.c` | 13,734 | 11,966 | 53% |
| `battle_tower.c` | 13,212 | 3,750 | 77% |
| `intro.c` | 12,314 | 298 | 97% |
| `secret_base.c` | 12,270 | 144 | 98% |
| `item_menu.c` | 9,654 | 4,476 | 68% |
| `battle_tv.c` | 9,356 | 0 | 100% |
| `region_map.c` | 8,132 | 30 | 99% |
| `record_mixing.c` | 7,792 | 16 | 99% |

Two different things are mixed together here, and they matter differently:

- **Near-100% files are Hoenn content a Kanto remake simply deletes** — TV,
  Roulette, Secret Bases, Decorations, record mixing, the Emerald intro, the
  Hoenn region map. There is no missing source to write; the feature is gone.
  (Deleted code shrinks the region, so it does *not* contribute to the 36%.)
- **Partial files are rewrites**, and they line up with the hack's known
  behavioural differences: `item_menu.c` 68% (the six-pocket FRLG bag),
  `pokemon.c` 60% and `pokedex.c` 53% (always-national dex, species changes),
  `pokemon_storage_system.c` 53% (repacked SaveBlocks).

## What the 36% is not

It is an upper bound on "code Jaizu wrote", inflated by at least three things:

1. **Fork point.** The reference is pokeemerald `master`; the hack forked at some
   earlier commit. Any function pret changed in between fails to match despite
   being vanilla on both sides.
2. **Repacked SaveBlocks.** The hack moved fields inside SaveBlock1/2 (this is
   the whole subject of `hack-offsets.md`). Every otherwise-untouched function
   that reaches into those structs now emits different constants, and enough of
   them push it past the 10% threshold.
3. **Flags and inlining.** Different `-O` level or inlining decisions change
   codegen for identical source.

Tightening it is mostly a matter of rebuilding the reference at older pokeemerald
commits and taking the best match per function; that has not been done.

The number that is *not* inflated is the other one: **at least 64% of this ROM's
code is source you can already download.**
