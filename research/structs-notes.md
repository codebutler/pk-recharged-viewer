# Emerald-engine RAM structure notes for the parser author

Companion to `structs.json`. The target is a **pokeemerald decomp rebuild** (the BPRE/FireRed
ROM header is cosmetic — per the rom-fingerprint agent). All facts cite the pret/pokeemerald
clone at `./pokeemerald`. Everything is little-endian. structs.json records **vanilla
pokeemerald offsets** as the baseline.

## CRITICAL: the hack enlarged both SaveBlocks

Fingerprinting found **SaveBlock2 ≈ 0xFE4** (vanilla 0xF2C, +0xB8 bytes) and
**SaveBlock1 ≈ 0x3E14** (vanilla 0x3D88, +0x8C bytes). The insertion points are unknown, so:

- Offsets **before** an insertion point are correct as-is; offsets **after** it are shifted.
  Hacks usually append at the end or grow an existing array/struct in place; early fields
  (player name/gender/TID/playtime, party, money, bag, flags/vars) are the least likely to move.
- **Verify empirically** before trusting any offset: playerName at SB2+0x00 must decode to
  the known player name; partyCount at SB1+0x234 must be 0–6; party mon checksums at
  SB1+0x238 must validate; money^key must be a plausible value (≤ 999999). If the early
  anchors validate but later ones (e.g. flags at 0x1270) don't, walk outward to find the shift.
- The Pokemon/BoxPokemon/PokemonStorage layouts are engine-critical (checksummed, permuted)
  and are very unlikely to be modified; treat them as fixed.
- The hack's ROM items table is expanded (409 items, ids 0–408, 48-byte stride — extracted
  in gamedata.json), vs vanilla Emerald's 377. Item IDs above the vanilla max are legitimate.
- **KNOWN-STALE: the bag has SIX pockets in the hack.** The extracted item table's pocket
  byte proves an Items/Medicine split (1=Items, 2=Medicine, 3=Balls, 4=TM/HM, 5=Berries,
  6=Key Items). The vanilla 5-pocket layout at SB1 0x560–0x847 in structs.json therefore
  does NOT hold as-is — a sixth pocket array exists somewhere, which is a prime candidate
  for part of the +0x8C growth and shifts everything after the bag region. Recover the bag
  layout empirically: pocket boundaries where slots stop looking like {itemId < 409,
  quantity^(key&0xFFFF) <= 999}.

## Where the blocks live in RAM

The blocks are heap-allocated with a random anti-cheat shift on every load (`src/load_save.c`);
never assume fixed block addresses. For THIS hack the IWRAM pointers are (from rom-fingerprint):

- `gSaveBlock1Ptr` = **0x03005AD0** → SaveBlock1
- `gSaveBlock2Ptr` = **0x03005AD4** → SaveBlock2
- `gPokemonStoragePtr` = **0x03005AD8** → PokemonStorage

(Vanilla Emerald's pointers sit elsewhere — community docs commonly cite 0x03005D8C/D90/D94,
not confirmed from this repo; the hack's rebuild relocated them regardless.) Validate a dereferenced pointer by checking it lands in EWRAM (0x02000000–0x0203FFFF).

## Alignment gotcha: agbcc uses old ARM APCS, not modern AAPCS

agbcc gives **every struct a minimum alignment of 4 and rounds every struct's size up to a
multiple of 4**. Modern compilers and naive natural-alignment logic get several offsets wrong.
Instances a parser actually hits:

- `struct Time` is 6 data bytes but occupies 8 (`SaveBlock2.lastBerryTreeUpdate` at 0xA0, not 0x9E).
- `struct Pokeblock` is 7 data bytes but array elements stride **8** (`SaveBlock1.pokeblocks`
  at 0x848 spans 0x140, putting `seen1` at 0x988).
- `struct LinkBattleRecords` is 0x56 → occupies 0x58.

Verification method: compiled the actual pokeemerald headers with
`clang -target armv4t-none-eabi` and static-asserted every annotated offset. All
parser-critical asserts passed (SB2 through `pokedex` + `encryptionKey` region arithmetic,
SB1 through the bag pockets at 0x790–0x847, Pokemon=100, BoxPokemon=80, substruct=12,
PokemonStorage=0x83D0, NUM_FLAG_BYTES=0x12C, VARS_COUNT=0x100, NUM_GAME_STATS=64,
NUM_DEX_FLAG_BYTES=0x34). Asserts after the first APCS-rounded struct fail under AAPCS as
expected; that region was verified by hand-summing the annotated chain, which lands exactly
on the documented totals (SaveBlock1=0x3D88 at `global.h:1078`, SaveBlock2=0xF2C at
`global.h:542`).

## Security key ("encryption key")

- Field name: **`encryptionKey`**, `u32` at **SaveBlock2 + 0xAC** (`include/global.h:532`).
  (FireRed keeps it at SB2+0xF20 — do not mix these up.)
- XORed with the **full 32-bit key** (`ApplyNewEncryptionKeyToWord`, `src/load_save.c:280-284`;
  target list `src/load_save.c:286-293`):
  - `SaveBlock1.money` (0x490) — `src/money.c:74`
  - each `SaveBlock1.gameStats[i]` (0x159C, 64 × u32) — `src/overworld.c:452-467`
  - `SaveBlock2.berryCrush.berryPowderAmount` (SB2+0x1F4) — `src/berry_powder.c:128-142`
- XORed with the **low 16 bits only** (u16 lvalue truncates the u32 key,
  `ApplyNewEncryptionKeyToHword`, `src/load_save.c:274-278`):
  - `SaveBlock1.coins` (0x494) — `src/coins.c:43-48`
  - the `quantity` halfword of **every slot in all 5 bag pockets** — `src/item.c:26-33`
    (`GetBagItemQuantity`) and `src/item.c:46-54`
- **Not encrypted**: item IDs everywhere; **PC item quantities** (`GetPCItemQuantity`
  returns the raw value, `src/item.c:35-43`); registeredItem; playtime; flags; vars.
- Note: unlike FireRed, Emerald has no trainerTower bestTime in the encrypted set.

So: `money_real = money_raw ^ key`; `coins_real = coins_raw ^ (key & 0xFFFF)`;
`bag_qty_real = qty_raw ^ (key & 0xFFFF)`; `stat_real = stat_raw ^ key`.
A fresh save has key 0 (`src/new_game.c:155`), so raw values may already be plaintext.

## Pokemon data encryption (BoxPokemon.secure, 48 bytes at +0x20)

Source: `src/pokemon.c` — `DecryptBoxMon` (3546), `GetSubstruct` (3605), `CalculateBoxMonChecksum` (2790).

1. `key = personality ^ otId` (both plaintext, BoxPokemon +0x00 / +0x04).
2. XOR each of the 12 u32 words of the 48-byte block with `key`.
3. The block is 4 physical 12-byte slots (secure+0x00/0x0C/0x18/0x24). Which substruct type
   sits in which slot is chosen by `personality % 24` — see `substruct_permutation` in
   structs.json. **Direction:** that table is `type → slot` (most web references publish the
   inverse, `slot → type`; both are included). Worked example: `personality % 24 == 8` gives
   `[2,0,1,3]`: Growth at slot 2, Attacks at slot 0, EVs at slot 1, Misc at slot 3.
   The table is byte-identical between pokeemerald and pokefirered.
4. Checksum: sum the 24 u16 words of the **decrypted** block, truncate to u16, compare with
   BoxPokemon.checksum (+0x1C). Mismatch = corrupt (game shows a Bad Egg).
5. Empty slot: `personality == 0 && otId == 0`, or `hasSpecies` clear (BoxPokemon+0x13 bit 1),
   or decrypted Growth.species == 0.

## Pokedex seen/caught

Primary state in **SaveBlock2** (`struct Pokedex` at +0x18): `owned` at SB2+0x28, `seen` at
SB2+0x5C, 52 bytes each (`NUM_DEX_FLAG_BYTES = ceil(412/8)`; species N → bit N-1, national
dex order). Two **seen** backups in SaveBlock1: `seen1` at 0x988, `seen2` at 0x3B24 (kept in
sync; read the SB2 copy). National mode: `Pokedex.nationalMagic` (SB2+0x1A) == **0xDA**
plus `FLAG_SYS_NATIONAL_DEX` (0x896). Note the FireRed difference: there nationalMagic is at
struct offset 0x03 with value 0xB9; Emerald has it at 0x02 with 0xDA (`global.h:210`).
If the hack expanded the dex beyond 412 species, these bitfields may be relocated/enlarged —
that would be one of the +0xB8 SB2 additions to check first.

## Flags and vars

- `SaveBlock1.flags` at 0x1270, 0x12C bytes = 0x960 flags. `flag N = (flags[N>>3] >> (N&7)) & 1`.
- `SYSTEM_FLAGS = 0x860` (`constants/flags.h:1348`; trainer flags end at 0x85F).
- Badges: FLAG_BADGE01..08_GET = **0x867–0x86E** (flags.h:1359-1366). They straddle flag
  bytes 0x10C/0x10D: badge1 = flags[0x10C] bit 7, badges 2-8 = flags[0x10D] bits 0-6.
- Progress: SYS_POKEMON_GET 0x860, SYS_POKEDEX_GET 0x861, SYS_POKENAV_GET 0x862,
  SYS_GAME_CLEAR 0x864, IS_CHAMPION 0x87F, SYS_NATIONAL_DEX 0x896, SYS_B_DASH 0x8C0
  (running shoes), SYS_FRONTIER_PASS 0x8D2.
- `SaveBlock1.vars` at 0x139C, 256 × u16; script variable `VAR_0x4000+i` is `vars[i]`.
- Hacks freely repurpose script flags/vars but rarely renumber engine SYS flags.

## Emerald layout traps for anyone coming from FireRed

- `mapView` is in SaveBlock1 (0x34) in Emerald, in SaveBlock2 in FireRed — so SB1
  playerParty is at **0x238** (not FR's 0x38) and money at **0x490** (not 0x290).
- encryptionKey at SB2+**0xAC** (FR: 0xF20).
- Bag pocket capacities differ: Items 30 (FR 42), KeyItems 30, PokeBalls 16 (FR 13),
  TM/HM 64 (FR 58), Berries 46 (FR 43); PC_ITEMS_COUNT 50 (FR 30).
- Badges at 0x867-0x86E (FR: 0x820-0x827).
- Emerald has pokeblocks, berry trees (128×8 at 0x169C), secret bases, TV shows, contest
  data; FireRed's questLog/fameChecker/trainerTower do not exist here.

## Character encoding

`charmap` in structs.json maps `"0xHH"` → string for the Western table parsed from
`pokeemerald/charmap.txt` (identical printable range to FireRed's). Decoding rules:
stop at **0xFF** (terminator, emitted as `<EOS>`); 0xFE = line break; 0x00 = space;
digits 0xA1–0xAA, A–Z 0xBB–0xD4, a–z 0xD5–0xEE, `♂`=0xB5, `♀`=0xB6, `¥`=0xB7.
0xF7–0xFD are multi-byte control codes that never appear in player/mon/box names; treat
unmapped bytes as `?` and keep scanning until 0xFF.

## Reference name tables (gamedata.json) — how each was located in the hack ROM

Extracted by ROM scan (`Pokemon Recharged Yellow.gba`), decoded with the charmap in
structs.json. Per-table locations, strides, counts, and validation results are in
`gamedata.json` meta. Location methods:

- **Species names** (412 × 11 at ROM 0x087703BC): anchor from rom-fingerprint.md; validated
  25=PIKACHU, 29/32=NIDORAN♀/♂, 151=MEW, 411=CHIMECHO. French (BULBIZARRE) and German
  tables follow immediately — never read past index 411.
- **Items** (409 × 48 at ROM 0x0890F960): struct layout recovered empirically: name (≤18
  bytes, mixed case) at +0, u16 price +18, holdEffect +20/+21, description pointer +24,
  importance +28, pocket +30, type +31, fieldUseFunc +32, battleUsage +36, battleUseFunc
  +40, secondaryId +44. Vanilla's u16 itemId column is GONE, so the boundary was found by
  name-decode + description-pointer validity (entry 409 is a partial "s" → real count 409,
  ids 0–408). **The hack has SIX bag pockets**: pocket byte values 1=Items, 2=Medicine,
  3=Poké Balls, 4=TM/HM, 5=Berries, 6=Key Items — the Items/Medicine split means the
  SaveBlock1 bag pocket arrays differ from vanilla (candidate cause of part of the +0x8C).
- **Move names** (355 × 13 at ROM 0x087738D8): found by encoding "Pound"/"Karate Chop";
  the table starts immediately after the 3-language species block. NOT expanded (exactly
  355; entry 33=Tackle, 354=Psycho Boost; the next language's table follows). A second
  ALL-CAPS English move table exists at 0x0877D5E8 (battle-message variant).
- **Ability names** (78 × 13 at ROM 0x0861D454): found via "Stench" at index 1; index
  9=Static, 77=Air Lock; not expanded.
- **Natures**: constant table from pokeemerald source (NATURE_* order, personality%25).
- **Mapsec names** (ROM 0x0899A338): flat array of string pointers indexed by
  regionMapSectionId. **Surprise resolved**: earlier "PALLET TOWN absent" was a case
  artifact — the hack uses mixed-case names ("Pallet Town"). Indices 0x00–0x57 are the
  vanilla Hoenn sections (Littleroot=0 still present), and Kanto/Sevii sections start at
  **0x58 = Pallet Town, exactly FRLG's mapsec numbering** (0x62=Saffron, 0x8F–0x95 Sevii
  islands). 213 indexed entries; some indices have no name.
- **Map headers** (511 headers; pointer run at ROM 0x08B3E938, gMapGroups at 0x08B3F134,
  44 groups): headers found by scanning for pokeemerald `struct MapHeader` shape (3–4 ROM
  pointers, plausible mapLayoutId/mapType, layout target with sane width/height), then the
  pointer arrays over them. Group organization is FRLG-style: group 1 = dungeons (first
  Viridian Forest), group 3 = Kanto overworld (map (3,0) = Pallet Town), groups 4–14 town
  interiors, 29–40 Sevii, 41–43 retained Hoenn/Battle-Frontier maps. gamedata.json `maps`
  maps "group,num" → {mapsec, name, layout_id, map_type}; combined with SaveBlock1.location
  (s8 mapGroup, s8 mapNum) this renders the player's location name.

## Uncertainties

- All offsets are vanilla pokeemerald; the hack's +0xB8 (SB2) and +0x8C (SB1) insertions
  are unlocated. Anchor-validate as described above before trusting anything past the
  early fields.
- The hack's pointer addresses (0x03005AD0/AD4/AD8) come from the rom-fingerprint agent,
  not from this repo.
- Opaque regions (BattleFrontier, Apprentice, TVShow, SecretBase, MysteryGiftSave, DayCare
  internals) were not field-verified; only their extents were. None are needed for the
  target game state.
- If the hack raised NUM_SPECIES (common in enhancement hacks), dex bitfield sizes, and
  possibly party/box substructure semantics for new species, would differ from vanilla.
