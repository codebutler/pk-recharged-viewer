# ROM Fingerprint: Pokemon Recharged Yellow (v1.9.7)

Analysis date: 2026-08-18. Inputs: `Pokemon Recharged Yellow.gba` (16 MiB), `Pokemon - Emerald Version (USA, Europe).gba`, `recharged-yellow_1.9.7.bps`, `pokefirered/` (pret clone, unbuilt).

## Verdict

**(c) Custom decomp rebuild — built on pokeemerald (Emerald decompilation), not FireRed, with modified save structures and an expanded item set.** Confidence: high.

Not vanilla FireRed layout, and not CFRU/DPE: CFRU is a binary patch over a retail FireRed ROM, but this ROM has no FireRed lineage at all — the BPRE header is cosmetic. No CFRU/Skeli/DPE signatures exist, and the data above 0x900000 is ordinary contiguous ROM data (the item struct table lives there), not a relocated code blob.

## Evidence chain

### 1. Header vs. patch provenance

- ROM header: `POKEMON FIRE` / game code `BPRE`, version 0 — claims FireRed 1.0.
- BPS footer checksums: source CRC32 = `0x1F1C08FB` = **exactly the retail Emerald (USA/Europe) ROM**; target CRC32 = `0xDEF0F69E` = the hack ROM. The distribution patch applies to Emerald, not FireRed.
- Byte comparison vs. retail Emerald: identical prefix ends at 0xA8 (just the Nintendo logo/header area). The only identical 4 KiB blocks are the trailing 0xFF padding (0xE71000–0x1000000). **Zero content shared with retail Emerald** → not a binary hack of Emerald either; it is a from-source rebuild (modern toolchain output differs from retail byte-for-byte).
- ROM content extends to ~0xE70254 (~14.4 MB used).

### 2. Vanilla pointer addresses are gone

Task 1 caveat: the `pokefirered/` clone is unbuilt (no `.map` file), so authoritative vanilla FR 1.0 IWRAM addresses could not be derived from the repo itself. What the repo does show: `gSaveBlock1Ptr` / `gSaveBlock2Ptr` / `gPokemonStoragePtr` are `COMMON_DATA` in `src/load_save.c:42-44`, placed via `sym_common.txt` (load_save.o is 13th in common ordering). The community-known vanilla FR addresses 0x03005008/0C/10 were therefore tested as *hypotheses* against the ROM:

| literal (LE32) | hits in hack ROM |
|---|---|
| 0x03005008 (FR gSaveBlock1Ptr) | 1 (noise) |
| 0x0300500C (FR gSaveBlock2Ptr) | 0 |
| 0x03005010 (FR gPokemonStoragePtr) | 0 |
| 0x03005D8C (Emerald gSaveBlock1Ptr) | 0 |
| 0x03005D90 (Emerald gSaveBlock2Ptr) | 0 |
| 0x03005D94 (Emerald gPokemonStoragePtr) | 0 |

Vanilla FR pointer scheme did not survive (this became moot once the ROM proved Emerald-derived). All IWRAM symbols are relocated.

### 3. Relocated save block pointers (identified)

Top IWRAM literal-pool values in the hack: 0x3005BB8 (1711×), 0x3005AD0 (804×), 0x3003B64 (570×), 0x30048F8 (490×), 0x3005AD4 (379×), 0x3005BC0 (272×), 0x3005AD8 (89×).

A single literal pool at ROM 0x0812B8C0 pairs three EWRAM buffers with three consecutive IWRAM words — the classic pokeemerald `SetSaveBlocksPointers` pattern (`ptr = &block + ASLR offset`, assignment order SB2, SB1, storage):

| symbol | IWRAM pointer | EWRAM backing buffer | literal refs |
|---|---|---|---|
| gSaveBlock2Ptr | **0x03005AD4** | 0x0200DBEC | 379 |
| gSaveBlock1Ptr | **0x03005AD0** | 0x0200EBD0 | 804 |
| gPokemonStoragePtr | **0x03005AD8** | 0x020129E4 | 89 |

Three independent legs agree, hence high confidence:
1. Pool usage order matches pokeemerald's `SetSaveBlocksPointers` source order (SB2, SB1, storage).
2. Reference counts 804 > 379 > 89 match expected SB1 > SB2 > storage frequencies.
3. Buffer spacing gives sizeof(SaveBlock2ASLR) = 0xFE4 and sizeof(SaveBlock1ASLR) = 0x3E14.

**Correction (2026-08-18, follow-up analysis):** the EWRAM buffers include the 0x80-byte ASLR pad (`struct SaveBlockXASLR`), so the true struct sizes are **SaveBlock2 = 0xF64** (vanilla 0xF2C, +0x38) and **SaveBlock1 = 0x3D94** (vanilla 0x3D88, +0xC), later confirmed exactly by the memcpy sizes in the hack's `MoveSaveBlocks_ResetHeap` (ROM 0x0812B8D8), which also confirms **PokemonStorage = 0x83D0, identical to vanilla**. The internal layout is significantly reordered, not merely grown — see `research/hack-offsets.md`.

Unverified hypothesis (not load-bearing): 0x3005BB8 (top literal, 1711×) with satellite 0x3005BC0 (+8, 272×) is likely `gTasks` / `gTasks[].data`.

### 4. Engine text is Emerald's, not FireRed's

Encoded-text search (GBA proprietary charset via `pokefirered/charmap.txt`):

- Present: `LITTLEROOT` (2), `PETALBURG` (6), `BIRCH` (3), `HOENN` (7), `BATTLE FRONTIER` (39), `TRAINER TOWER` (2 — Emerald text references it).
- Absent: `PALLET TOWN`, `OAK`, `SEVII`, `KANTO`, `QUEST LOG`, `POKéDUDE` (all FireRed-specific).

### 5. Species table: vanilla count, multi-language

Flat 11-byte-stride name table at ROM **0x087703BC** (found via encoded `BULBASAUR`):

- English table: exactly **412 entries**, vanilla Gen 3 internal order (index 151 MEW, 410 DEOXYS, 411 CHIMECHO). **No Gen 4+ species, no expansion.**
- Followed immediately by French (index 412 = `？…？`, 413 = BULBIZARRE) and German (824 placeholder, 825 = BISASAM) tables of 412 each — a multi-language feature of the hack; move names (`Pound`) follow. A Spanish item-name table also exists (0x0077A508, stride 16, 409 entries, includes "DexNav", "Planos").
- Species names are ALL-CAPS vanilla style (pokeemerald-expansion uses mixed case + names embedded in gSpeciesInfo) → base is classic pokeemerald, not RHH expansion.

Vanilla species count means the 30-slot box `BoxPokemon` species field range is vanilla; **but substructure order/encryption of BoxPokemon was not verified by this analysis** — that is the top open question for RAM parsing.

### 6. Item table: expanded and restructured

English `gItems`-style struct array at ROM base ~0x0090F960 (entry 0), **stride 48 bytes** (vanilla Emerald: 44), name[~16] at offset 0, description pointer at +24, field-use func pointer at +44:

- **~409–410 entries** (vanilla Emerald: 377). Entry 409 decodes partially ("s") — boundary ambiguous, count is 409±1.
- Tail includes post-Gen-3 features: Nature Mints (Gen 8), `Bottle Cap` / `Gold B. Cap` (Gen 7), `DexNav` (Gen 6/ORAS), `Appeal Sensor`, Kanto fossils, `Power Items`, `Blueprints`.
- Held-item IDs in Pokémon structures can therefore exceed the vanilla range, and the Item struct is not vanilla-shaped.

### 7. Signature strings

No meaningful hits. ASCII scans for `CFRU`, `Complete FireRed`, `Skeli`, `RHH`, `expansion`, `pokefirered`, `pokeemerald`, `Recharged`, `HUBOL`, build timestamps: the few byte-level matches (`DPE` ×9, `gcc`/`GCC` ×3, `GNU` ×2) all sit inside compressed graphics / audio sample data — random binary coincidences, verified by context dump.

### 8. Upper ROM region (0x900000+)

Substantial non-0xFF data (≥1 MB in 0x900000–0xA00000 alone) continuing to ~0xE70254. It is ordinary linked data — the English item struct table itself sits at ~0x90F960, with item descriptions around 0x89088xx region referenced from it. This is a large monolithic build image, **not** a CFRU-style "vanilla ROM + relocated code at 0x900000" layout.

## Consequences for the RAM-dump parsing project

1. Read `[0x03005AD0]` → SaveBlock1, `[0x03005AD4]` → SaveBlock2, `[0x03005AD8]` → PokemonStorage (Emerald-style ASLR: pointers shift within the fixed EWRAM buffers 0x0200EBD0 / 0x0200DBEC / 0x020129E4).
2. Start from **pokeemerald** (pret), not pokefirered, as the structural reference — but treat SaveBlock1/2 layouts as modified (+0x8C / +0xB8); field offsets must be recovered from the hack's own code (or its source, if available), not assumed.
3. Species IDs are vanilla Gen 3 (0–411). Item IDs run to ~409 with custom entries.
4. Verify BoxPokemon substructure order/encryption before parsing party/box data — unproven either way here. Also note Emerald's SaveBlock2 encryption-key obfuscation of money/items likely applies.
