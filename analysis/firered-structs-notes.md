# FireRed RAM structure notes (ARCHIVED — superseded)

**This file is kept as insurance only.** The rom-fingerprint verdict is that the hack is a
pokeemerald decomp rebuild (BPRE header cosmetic); the live deliverables are
`structs.json` / `structs-notes.md`, which describe pokeemerald. Companion data:
`firered-structs.json`. All facts below cite the pret/pokefirered clone at `./pokefirered`.
Everything is little-endian; offsets are the true GBA (agbcc) values.

## Where the blocks live in RAM

FireRed does NOT keep SaveBlock1/2 at fixed addresses. On every save-load the game
allocates them with a random anti-cheat shift (`src/load_save.c`). A RAM-dump parser must
first read three IWRAM pointers and follow them:

- `gSaveBlock1Ptr` → struct SaveBlock1 (size 0x3D68)
- `gSaveBlock2Ptr` → struct SaveBlock2 (size 0xF24)
- `gPokemonStoragePtr` → struct PokemonStorage (size 0x83D0)

Community-documented FireRed v1.0 (US) addresses: `gSaveBlock1Ptr = 0x03005008`,
`gSaveBlock2Ptr = 0x0300500C`, `gPokemonStoragePtr = 0x03005010` — not confirmed from the
repo (only a built `.map` would show them). Pointer values must land in EWRAM
(0x02000000–0x0203FFFF).

## Alignment gotcha: agbcc uses old ARM APCS, not modern AAPCS

agbcc gives **every struct a minimum alignment of 4 and rounds every struct's size up to a
multiple of 4**. Concrete instances:

- `struct Time` is 6 data bytes but occupies 8 (`SaveBlock2.lastBerryTreeUpdate` at 0xA0).
- `struct LinkBattleRecords` is 0x56 → occupies 0x58.
- `struct FameCheckerSaveData` is a u16 bitfield but array elements stride **4**
  (SaveBlock1 0x3A54–0x3A93, 16 entries).
- `union OldMan` is 0x3C on GBA.

Verification: compiled the actual headers on x86-64 and with `clang -target armv4t-none-eabi`,
asserting every annotated offset. All parser-critical fields verified mechanically; fields
after the first APCS-rounded struct verified by hand-summing the annotated chain
(self-consistent; totals SaveBlock1 = 0x3D68, SaveBlock2 = 0xF24, `include/global.h:359,822`).

## Security key ("encryption key")

- Field name: **`encryptionKey`**, `u32` at **SaveBlock2 + 0xF20** (`include/global.h:358`).
  (Emerald keeps it at 0xAC.)
- XORed with the **full 32-bit key** (`src/load_save.c:286-298`):
  - `SaveBlock1.money` (0x290) — `src/money.c:14`
  - each `SaveBlock1.gameStats[i]` (0x1200, 64 × u32) — `src/overworld.c:394-401`
  - `SaveBlock1.trainerTower[i].bestTime` (0x3D38 + i*0xC + 4, i = 0..3)
  - `SaveBlock2.berryCrush.berryPowderAmount` (SaveBlock2 + 0xAF8) — `src/berry_powder.c:19-30`
- XORed with the **low 16 bits only** (u16 lvalue truncates, `src/load_save.c:274-278`):
  - `SaveBlock1.coins` (0x294) — `src/coins.c:13-18`
  - the `quantity` halfword of every slot in all 5 bag pockets — `src/item.c:21-28,41-52`
- **Not encrypted**: item IDs everywhere; PC item quantities (`GetPcItemQuantity` XORs
  with 0, `src/item.c:31-40`); registeredItem; playtime; flags; vars.

## Pokemon data encryption (BoxPokemon.secure, 48 bytes at +0x20)

Source: `src/pokemon.c` — `DecryptBoxMon` (2807), `GetSubstruct` (2863),
`CalculateBoxMonChecksum` (2069).

1. `key = personality ^ otId` (plaintext at BoxPokemon +0x00/+0x04).
2. XOR each of the 12 u32 words of the block with `key`.
3. Substruct order by `personality % 24` — table in `firered-structs.json`
   (direction: type → slot; inverse included). Example: `personality % 24 == 8` gives
   `[2,0,1,3]`: Growth at slot 2, Attacks at slot 0, EVs at slot 1, Misc at slot 3.
4. Checksum: u16 sum of the 24 decrypted u16 words vs BoxPokemon.checksum (+0x1C).
5. Empty slot: personality==0 && otId==0, or hasSpecies clear, or Growth.species==0.

## Pokedex seen/caught

Primary in **SaveBlock2** (`struct Pokedex` at +0x018): `owned` at SB2+0x028, `seen` at
SB2+0x05C, 52 bytes each (species N → bit N-1). Two seen backups in SaveBlock1: `seen1`
at 0x5F8, `seen2` at 0x3A18. National dex: `Pokedex.nationalMagic` (struct offset 0x03)
== 0xB9 plus flag FLAG_SYS_NATIONAL_DEX (0x840).

## Flags and vars

- `SaveBlock1.flags` at 0xEE0, 0x120 bytes = 0x900 flags. `flag N = (flags[N>>3] >> (N&7)) & 1`.
- System flags from 0x800 (`SYS_FLAGS`, flags.h:1324).
- Badges: FLAG_BADGE01..08_GET = **0x820–0x827** = all eight bits of `flags[0x104]`.
- Progress: SYS_POKEMON_GET 0x828, SYS_POKEDEX_GET 0x829, SYS_GAME_CLEAR 0x82C,
  SYS_B_DASH 0x82F, SYS_NATIONAL_DEX 0x840.
- `SaveBlock1.vars` at 0x1000, 256 × u16; `VAR_0x4000+i` is `vars[i]`.

## FireRed vs Emerald differences

- encryptionKey at SB2+0xF20 (Emerald: 0xAC); SaveBlock2 is 0xF24 (Emerald 0xF2C).
- SaveBlock1 layouts differ heavily (FR: questLog, fameChecker, trainerTower; party at
  0x38 vs Emerald 0x238; money 0x290 vs 0x490).
- FR has no berry-tree array; `enigmaBerry` at SB1+0x30EC.
- Bag pockets: Items(42), KeyItems(30), PokeBalls(13), TM/HM(58), Berries(43); PC 30 slots.

## Character encoding

`charmap` in firered-structs.json: Western table from `pokefirered/charmap.txt`;
stop at 0xFF (`<EOS>`), 0xFE newline, 0x00 space; digits 0xA1–0xAA, A–Z 0xBB–0xD4,
a–z 0xD5–0xEE.

## Uncertainties

- The three pointer addresses are community documentation, not repo-derived.
- Only v1.0 targeted; rev 1.1 not verified (the repo carries separate `sym_*_rev10.txt`).
- Opaque regions (BattleTowerData, QuestLogScene, ObjectEvent(Template), MysteryGiftSave)
  have verified extents only.
