# Recharged Yellow: actual SaveBlock layouts vs vanilla pokeemerald

Companion to `hack-offsets.json` (machine-readable field map) and `rom-fingerprint.md` (engine identification). Analysis date 2026-08-18, target `Pokemon Recharged Yellow.gba` v1.9.7.

## Headline results

1. **The saveblocks are reordered and repacked, not just grown.** The task framing ("where did the insertions land") turned out wrong: the hack moves big vanilla regions (SB1 `mapView` → 0x2510, the whole `BattleFrontier` block SB2 → SB1+0x2744), deletes others (tvShows/pokeNews/secretBases/gameStats not found), and repacks everything else. Vanilla Emerald offsets must NOT be used for anything past SB1+0x33 / SB2+0x8F.
2. **Exact struct sizes** (from the memcpys in the hack's `MoveSaveBlocks_ResetHeap`, ROM 0x0812B8D8): SaveBlock1 = **0x3D94** (vanilla 0x3D88), SaveBlock2 = **0xF64** (vanilla 0xF2C), PokemonStorage = **0x83D0 — byte-identical size to vanilla**. (This corrects the +0xB8/+0x8C deltas in the first rom-fingerprint report, which had ignored the 0x80-byte ASLR pad on the EWRAM buffers.)
3. **BoxPokemon / party Pokemon / PC storage are fully vanilla Gen 3.** GetSubstruct (ROM 0x081637A8) was disassembled and all 24 `personality % 24` cases hand-verified equal to the vanilla permutation table; decryption key = `personality ^ otId` XOR over the 48 bytes at mon+0x20; checksum u16 at +0x1C; party mon = 0x64 bytes with vanilla battle-stats tail. PokemonStorage: currentBox u8 @+0, `boxes[14][30]` of 0x50-byte BoxPokemon @+4.
4. **The saveblock XOR "encryption" is removed** (at least for money — GetMoney/AddMoney at 0x0813A3E4/0x0813A3F8 are plain loads/stores, and no encryptionKey field could be found in SB2). Parse money/coins/quantities as plaintext; confirm bag quantities in the live-RAM pass.
5. Items are expanded to **409 ids** (English `gItems` at ROM 0x0890F960, stride 0x30, name embedded at +0); the game is **multi-language** (SB2+0x91 low 5 bits select the language; separate name tables per language, e.g. Spanish item names at 0x0877A508).

## How to read a RAM dump (recipe)

```
sb1  = *(u32*)0x03005AD0   # in 0x0200EBD0 + [0,0x7C]
sb2  = *(u32*)0x03005AD4   # in 0x0200DBEC + [0,0x7C]
sto  = *(u32*)0x03005AD8   # in 0x020129E4 + [0,0x7C]
# all three share the same ASLR offset (multiple of 4, 0..0x7C)
```

Party: count = u8 @ sb1+0x3B, mons = 6 × 0x64 @ sb1+0x44 (also live at EWRAM 0x2038559 / 0x203855C).
Money u32 @ sb1+0x29C (plain). Coins u16 @ sb1+0x2A0. Registered item u16 @ sb1+0x2A2.
Bag (FRLG-style six pockets + PC): Items @ 0x374 ×60, Medicine @ 0x2380 ×100, Balls @ 0x52C ×32, TM/HM @ 0x5AC ×64, Berries @ 0x6AC ×46, KeyItems @ 0x464 ×50, pcItems @ sb1+0x2AC ×50. Slots are vanilla `{u16 itemId, u16 quantity}`; gBagPockets[i] (EWRAM 0x0200B770) = item-struct pocket byte i+1, entry 6 = PC.
Flags: byte array @ sb1+0xEFB, 0x12C bytes; flag N (N<0x4000) = bit N&7 of byte sb1+0xEFB+(N>>3).
Vars: u16 array @ sb1+0x1028; var 0x4000+i @ sb1+0x1028+2i.
Dex: owned bitfield @ sb2+0x28 (0x34 bytes), seen @ sb2+0x5C; species N ↔ bit N-1, vanilla 412-species order.
Trainer: name @ sb2+0x0 (8 bytes, 0xFF-terminated GBA charset), gender u8 @ +0x8, trainerId u8[4] @ +0xA, playtime @ +0xE (u16 h, u8 m, u8 s, u8 vbl), buttonMode u8 @ +0x13, options u16 bitfield @ +0x14.
Boxes: current u8 @ sto+0x0, mon(box,slot) @ sto+4 + (box*30+slot)*0x50, vanilla decryption.

## Evidence chain (function-level, all addresses ROM)

| Finding | Function / evidence |
|---|---|
| Struct sizes, buffer bases, ASLR mask 0x7C | MoveSaveBlocks_ResetHeap 0x0812B8D8 (memcpys of 0xF64/0x3D94/0x83D0; `ands #0x7C` on trainer-id-sum + Random) |
| SetSaveBlocksPointers | 0x0812B898 (pool pairs buffer↔pointer) |
| Bag pockets + capacities | SetBagItemsPointers 0x081186BC (called from SetSaveBlocksPointers), writes gBagPockets @EWRAM 0x0200B770: 7 pockets |
| Money | AddMoney 0x0813A3F8 (cap 0x98967F, no XOR), IsEnoughMoney 0x0813A420 (`ldr [sb1+0x29C]`), 21+ caller sites forming sb1+0x29C |
| Party save/load | 0x0812BA40 / 0x0812BA7C (SB1+0x3B count, SB1+0x44 6×0x64 ↔ EWRAM 0x2038559/0x203855C) |
| Mail | 0x0812BAB8 / 0x0812BB50 (SB1+0x910, 16×0x24 ↔ EWRAM 0x2005CD4) |
| Flags | FlagSet/Clear/Get 0x080D3598/0x080D3650/0x080D36AC, found via script command table 0x081F1630 entries 0x29–0x2B; base sb1+0xEFB; special flags (≥0x4000) @EWRAM 0x2005C64 |
| Vars | GetVarPointer 0x080D33E4: `sb1 + (id-0x37EC)*2` for 0x4000≤id<0x8000; special-var ptr table 0x081F19DC |
| Dex owned/seen | memset(sb2+0x28,0,0x34) & memset(sb2+0x5C,0,0x34) @0x0813E798/0x0813E7A4 (and 0x68-byte combined clear @0x0815907C); dex header access profile at 0x18-0x24 matches vanilla |
| objectEventTemplates | template-coord/script setters 0x08140630-region and 0x08079474 (SB1+0x1398, 64×0x18, script ptr @+0x10) |
| berryTrees | memset(sb1+0x1998,0,0x400) @0x0809F1BA |
| Frontier moved to SB1 (+0x20F8 from vanilla SB2 offsets) | memset(sb1+0x2744,0,0xEC)=towerPlayer, 0x2830=towerRecords; ref-count twins for lvlMode (177↔178) and 6 more fields |
| Apprentices in SB2 (+0xC4 from vanilla) | memset(sb2+0x1A0,?,0x44); playerApprentice @0x174 abutting |
| Language byte | ItemId_GetName 0x08118734: sb2+0x91 bits0-4 select name table (0=English gItems 0x0890F960, 1=Spanish 0x0877A508) |
| Substruct order & encryption | GetSubstruct 0x081637A8 + jump table 0x08972DE4 (24 cases, all = vanilla); DecryptBoxMon path in GetBoxMonData 0x081639B4: key=`[mon+0]^[mon+4]`, XOR 0x20..0x50, checksum cmp @+0x1C, bad-egg bits @+0x13 |

## Method

Two-ROM literal-pool displacement harvesting: for every `ldr rX,[pc]` load of a saveblock pointer, a linear THUMB-1 simulation recorded every `[base+disp]` access and every `base+const` address formation. Run on retail Emerald (known symbols — calibration showed peaks exactly at documented vanilla offsets) and on the hack, then anchored semantically by disassembling the functions at the hottest sites (custom disassembler; scripts in scratchpad `harvest.py`/`disasm.py`). memset-call argument recovery (485 sites) provided array sizes.

## Empirical verification against live RAM dumps (2026-08-18)

Verified against `analysis/dumps/newgame-spam/` (pre-starter new-game session, final dump frame 20000):

- **Pointer model confirmed**: in every dump, all three live pointers equal buffer + one shared 4-aligned offset in [0,0x7C] (0x1C in `final`, 0x40 in `f004200`), exactly `0x0200EBD0/0x0200DBEC/0x020129E4 + off`.
- **Money plaintext confirmed**: u32 @ sb1+0x29C reads exactly 3000 (vanilla new-game default) in every in-game dump, 0 during the intro before saveblock init. Encryption removal is now live-proven, not just inferred.
- **gBagPockets @ EWRAM 0x0200B770 confirmed live**: 7 entries pointing at SB1+0x374/0x2380/0x52C/0x5AC/0x6AC/0x464/0x2AC with caps 60/100/32/64/46/50/50. With the gamedata finding that item structs use the FRLG pocket enum (1=Items 2=Medicine 3=Balls 4=TMHM 5=Berries 6=KeyItems), pocket names are now settled: **gBagPockets[i] = pocket i+1; the 100-slot pocket at SB1+0x2380 is Medicine; gBagPockets[6] is the PC item storage**. This also resolves the team-lead's "six-pocket bag region" hypothesis: the bag is six pockets + PC, but they are NOT a contiguous vanilla-style region — Medicine lives at 0x2380, far from the 0x374-0x764 chain.
- playerName/gender/trainerId/playtime/options/buttonMode @ SB2+0x0/0x8/0xA/0xE/0x14/0x13 all read sane values (playtime 0h04m30s at frame 20000); language byte SB2+0x91 = 0 (English).
- flags @ sb1+0xEFB: 133 bits set after the intro (plausible); vars @ sb1+0x1028: nonzero values only at script-var indices.
- partyCount 0 in all dumps (the session never picks a starter), so party/box mon decryption remains verified statically only (GetSubstruct + GetBoxMonData disassembly); dex arrays all-zero (consistent, but positions rest on the memset evidence).

## Follow-up round (badges, gameStats, dex mirrors, misc structs)

- **Badges = flag ids 0x880–0x887** (badge N = 0x880+N-1, Boulder→Earth). All eight sit in flags byte **SB1+0x100B** (= 0xEFB + 0x110), bit N-1. Three independent evidence legs: a trainer-card/tier function (0x08130A68+) checks all eight sequentially; an obedience-style check (0x0809EA38) tests 0x887/0x881/0x883/0x885 (badges 8/2/4/6); HM field-move gating matches Kanto exactly — Flash sites check 0x880 (badge 1), Fly 0x882 (3), Surf 0x884 (5), Waterfall 0x886 (7). Harvested from 409 FlagGet + 77 FlagSet + 58 FlagClear call sites with constant args.
- **gameStats: removed.** No bounds-check + u32-increment function exists against SB1, SB2, or any EWRAM array (ROM-wide pattern scans for both reg-offset and immediate-offset increment forms), and the repacked SB1 has no 0x100-byte u32 array region. Parser should not attempt to output game stats.
- **Dex seen-mirrors: removed, confirmed.** GetSetPokedexFlag found at **0x0815E100**: case 0 = get-seen (SB2+0x5C), 1 = get-caught (SB2+0x28), 2 = set-seen, 3 = set-caught — the only write targets are the two SB2 arrays. The adjacent count function loops dex numbers up to 386 (Gen 3 national count). One residual ambiguity: whether bit index is dexNum or dexNum-1 — settle with a single live dump containing a seen mon.
- **SB2+0x154 is a 0x10-byte records struct, not RTC** as first guessed: u16 caps 9999 @0x154/@0x158, u32 @0x15C, u32 cap 99990 @0x160 (clear fn 0x08173C84, update fn 0x08173CA4). Purpose unknown.
- **SB2+0xF5C / SB2+0xE0**: 8-byte "active record" at 0xF5C gated by flag 0x895, archived to SB2+0xE0, with its leading u16 mirrored into var 0x408E (fn 0x080B1530). Purpose unknown (daily-event/roamer-like).
- **SB1+0x8AA/0x8AC** — CORRECTED in the daycare/achievements round: this is the **trainer-rematch (Match Call) system**, not a mon slot. 0x8AA = trainerRematchStepCounter (vanilla 0x9C8), 0x8AC = trainerRematches[100] (vanilla 0x9CA, u8[78] → expanded to 100). Flag 0x889 enables the random rematch updates. Emerald's Match Call caller table survives at ROM 0x0898EEA8 (21 entries: Mr. Stone, Birch, Mom, Brendan/May, Steven, Scott, gym leaders, Elite Four, Champion).
- Bonus: **hidden-item flags = hiddenItemId + 0x32C** (handler 0x080D37A0).

## Progress flags round (for the parser's progressFlags section)

Method: static harvest of every FlagGet (409), FlagSet (77), FlagClear (58), GetVarPointer/VarSet call site with recoverable constant argument, then targeted disassembly of the clustered users. Caveat: scripts set flags through the same runtime functions but with script-supplied args, so a flag having no static set-site means nothing.

| Flag(s) | Meaning | Evidence | Confidence |
|---|---|---|---|
| 0x880–0x887 | Badges 1–8 (Boulder→Earth); badges byte = SB1+0x100B | GetBadgeCount @0x081686D8 loops exactly this range; tier ladder; obedience; HM gating | high |
| 0x864 | Game clear / champion | FlagSet @0x08192E1E directly after Hall-of-Fame party loop + playtime snapshot; releases level cap; 27 checks game-wide | high |
| 0x861 + 0x860 + 0x87A | Starter-progression trio (has Pokémon / has Pokédex analogues) | all three set together by one special @0x081B65C0; 0x861 gates the full start menu (@0x0812D5E6, reduced menu until set); individual name assignment not statically separable | high (trio), medium (individual) |
| 0x89E | Intro complete | only sys-range flag set in the pre-starter live dumps; set @0x080ED812 | medium |
| 0x866 | Running shoes / dash (probable) | checked only in player-movement code region | low-medium |
| 0x862 (+var 0x40C8) | Step-charged feature (Vs. Seeker-like): enable zeroes var 0x40C8, steps accumulate, full > 204 | fns @0x080FD750/0x080FD770/0x080FD780 | high mechanics, low name |
| 0x895 / 0x889 | Gate the SB2+0xF5C record feature / the SB1+0x8AC mon-slot feature | see follow-up round | high linkage |
| national dex | No flag: no 0xDA magic check exists; dex loops to 386 unconditionally — always enabled | — | medium |

**Derived level caps** (parser can expose as derived info): cap fn @0x08168708 — if flag 0x864: no cap (100); else if SB2+0x6E0 bit2 clear: no cap; else cap = `[14,21,24,29,43,43,47,50,63][badgeCount]`, and if (SB2+0x6E0 & 3)==1 add `[1,1,2,2,3,3,4,4,4][badgeCount]` (tables at ROM 0x089732D4/0x089732E0). **SB2+0x6E0 is thereby identified as a challenge-options byte** (bit2 = level cap on, bits0-1 = cap mode, bit4 gates another pre-champion feature).

Vars: no clean story-chapter var found cheaply (script archaeology out of scope). Known: 0x40C8 (charge counter above), 0x408E (mirror of SB2+0xF5C record u16). Highest-traffic constants: set 0x4000/0x4010/0x40E7, get 0x4000/0x4038.

## Daycare / achievements round (+ corrections)

- **Mon decryption now LIVE-verified**: the injected-Pikachu dump (`analysis/dumps/inject/injected/`) decodes perfectly with the vanilla scheme — species 25, Lv5, HP 19/19, Thunder Shock/Growl, checksum OK. The last static-only caveat on BoxPokemon is closed.
- **Correction — SB1+0x8AA/0x8AC is the trainer-rematch system** (Match Call), not a "flag-gated mon slot": stepCounter u16 @0x8AA (vanilla 0x9C8) + trainerRematches u8[100] @0x8AC (vanilla 0x9CA, expanded from 78). Match Call caller table at ROM 0x0898EEA8 (21 entries). Flag 0x889 enables it.
- **Correction — mapView was MOVED, not deleted**: u16[0x100] at **SB1+0x2510** (fill fn 0x08108B00 indexes by SB1 pos; presence check ORs 0x2510..0x2710).
- **gTasks = 0x03005BB8 CONFIRMED** (task-func store at base + taskId*40 seen in disasm) — upgraded from hypothesis.
- **Daycare: no dedicated storage exists.** Exhaustive scans (all memcpys of 0x50/0x64/0x88/0x8C touching saveblocks; all GetMonData-family calls with SB1-based mon pointers) find only the party slots. "Day-Care" survives as map/script text, so the feature is likely script-driven (perhaps via the PC system). One live A/B dump (deposit a mon, diff SB1/SB2/Storage) will settle it.
- **Mail is more complex than first mapped**: two 16×0x24 mail-format arrays exist — 0x910 (save/load transform loops paired with gLoadedSaveData @0x2005CD4) and ~0x1DB8 (vanilla `struct Mail` layout: words[9] @0, playerName @0x12, trainerId @0x1A, species @0x1E, itemId @0x20; indexed by Pokémon data field 0x49; entries 0–5 party / 6–15 PC). Which is authoritative for a parser needs one live mail test.
- **SB1+0x1FD8**: ~6-entry shift-insert log of 0x20-byte records {u16 id, nickname @+0xB, name @+0x16, u8 @+0x1E} — a "recent mons" log of unknown purpose.
- **Achievements ("Chievos")**: start-menu item 11, callback 0x081B80B8, opens scenes 0x52/0x54/0x56 of a custom **"Smsh" script VM** (magic 0x68736D53 in scene dispatcher 0x08000B68, scene table ROM 0x08B7EC90, scripts at 0x08E6FF98/0x08E6D7AC/0x08E6F4C0, referencing EWRAM 0x0200B108/0x0200B183). **Persistent storage not determined statically** — tracing the script VM is the archaeology this task excluded. Recommended: earn one achievement live and diff the saveblocks; candidates are dedicated flag ranges or the remaining unmapped SB1 bytes.

## Real-save diff round (st0, 9h/4 badges, vs fresh new game)

Method: byte-diff of every unmapped SB1/SB2 region between the real save's extracted RAM and `newgame-spam/final`.

- **gameStats EXISTS — earlier "removed" verdict corrected.** `u32[64]` at **SB1+0xB50** (ends 0xC50, matching the hot formed-0xC50 sites), unencrypted, vanilla GAME_STAT enum order. Real-save proof: idx0=41 (saves), idx5=28582 (steps), idx7=328 (total battles), idx8=192 (wild), idx9=136 (trainer), idx11=24 (captures). The static increment-pattern scans simply missed the compiled form. Parser can restore a gameStats section with vanilla stat names.
- **Game clock found**: live clock at **SB2+0xF5C** (u16 day, u8 hour @0xF5E, u8 min @0xF5F, u8 sec @0xF60 — read day 4, 21:18:20 exactly matching the parser's gameClock), with an archived copy at **SB2+0xE0** (the flag-0x895 daily-event "last update" record; corrects the earlier unown/spinda guess for 0xE0/0xE4).
- **Rival name = SB2+0x6E2** (u8[8]; real save decodes "Kennedy"), adjacent to the challenge-options byte 0x6E0.
- **Flag verdicts applied**: 0x87A demoted (transient — cleared later in the story); running shoes 0x866 refuted, and re-derivation against the real save's set sys-flags finds no movement-code dash flag — running appears always enabled (SB2+0x90 bit0, read in step/encounter code, may be an auto-run option). Parser should drop the runningShoes field.
- **Achievements**: the diff leaves one strong storage candidate — **SB1+0xD2C..0xD45**: all 0xFF on the real save, all 0x00 on a fresh game (0xFF-initialized when the feature first runs; 0xFF plausibly = "not earned", i.e. the user has zero achievements so far). Secondary candidates: SB1+0x2178 (u16[16], 2-bit state per entry, reset fn 0x080EA264) and a small struct at SB1+0x1280. A dump taken after earning one achievement pins it definitively.
- Misc: SB1+0x3D90 (last word of SB1) holds a random-looking u32 on the real save — likely a save counter/nonce.

## Script-engine facts (reusable, from the Game Corner grunt investigation)

- Event-script command table @ROM 0x081F1630 has 235 entries: 0x00–0xE2 follow vanilla pokeemerald order/semantics exactly; customs observed: **0xE6 = multi-language msgbox** (u8 msgbox-type + SEVEN text pointers, one per language, selected via SB2+0x91) and **0xE8 = speaker-name pointer** (one text ptr, sets the dialogue nameplate). Handlers for 0xE2–0xEA at table entries (0x081A48D5…0x081A29B5).
- Map data walk works vanilla-style: gMapGroups @0x08B3F134 → group array → header {layout, events, mapScripts, connections, music u16, layoutId u16, mapsec u8…}; events = {counts u8×4; objectEventTemplates(0x18 stride, script @+0x10, visibility-flag u16 @+0x14); warps; coords; bgEvents(12 stride, script @+8)}. Map-script tables are vanilla {type u8, ptr u32} lists (type 2 = ON_FRAME with {var,value,script} entries).
- Worked example — Celadon Game Corner poster grunt (map (10,14), object 11, script 0x08266562): battles only when **var 0x405D >= 2**. 0x405D=1 is set by the rival battle script in Pokémon Tower (0x08216FA8; trainer 0x1AD); 0x405D=2 by a Lavender Town ON_FRAME Rocket cutscene (0x0822A348); 0x405D=3 later (0x0820E42A). So **var 0x405D = the Lavender/Celadon Rocket story counter** — useful for the parser's story-progress readout.

## Player sprite / avatar round (for the trainer card)

- **gObjectEvents = EWRAM 0x02005CD4** (16 × 0x24, vanilla ObjectEvent layout). Found empirically by searching the real dump for the player's map coords (+7 offset) and verified in 4 dumps (isPlayer bit, localId 0xFF, map/coords match the parsed state). Player is normally entry 0; robust selection: the entry with the isPlayer bit / localId 0xFF. **Facing = low nibble of byte +0x18** (1=S, 2=N, 3=W, 4=E); **graphicsId = byte +5** (already reflects walking/bike/surf state).
- **gPlayerAvatar = EWRAM 0x02005F14** (vanilla struct, = gObjectEvents+0x240 exactly as in vanilla): flags @+0 (bit0 on-foot, bit1/2 bikes, bit3 surfing, bit7 dash), objectEventId @+5, gender @+7.
- This **corrects the 0x2005CD4 = gLoadedSaveData.mail label**: the SB1+0x910 ↔ 0x2005CD4 loops are the saved-objectEvents copy (vanilla SB1 0xA30 analogue). The mail ambiguity is resolved — the 0x1D98-region array is the Mail.
- **Real save answer**: Eric is at Celadon (43,22), **facing EAST, on foot** (avatar flags 0b1, graphicsId 0).
- **ROM sprite spec** (all verified, frame 0 ASCII-rendered as a capped Red-style hero): gObjectEventGraphicsInfoPointers @ **0x0887EE9C**; gfxId 0 = male walking 16×32 (18 frames × 0x100 from 0x08791708), gfxId 1 = bike 32×32 (9 × 0x200 from 0x087948A8); frames are **uncompressed 4bpp**, row-major 8×8 tiles; standing frames 0/1/2 = face South/North/West (East = h-flip of West), walk frames S 3/4, N 5/6, W 7/8 (verified from anim table 0x088891B4); palette tag 0x1100 → sprite-palette table 0x08890458 → **16×BGR555 @ 0x08792928**, color 0 transparent. Full recipe in hack-offsets.json `player_sprite_rendering`.

## Explicitly unresolved (for the live-RAM verification pass)

- SB1 0x34–0x3A and 0x3C–0x43 (gaps around partyCount/party), 0x764–0x8A8, 0xB50–0xEFA, 0x1228–0x1397 (0x1C-byte struct @0x1228, 0xC-stride records @0x1244), 0x1D98/0x20D8 structs, 0x2510–0x2743, tail 0x3B92+.
- SB2 0x90 (hot u8), most of the inserted 0x92–0x153 region, 0x6E0 (hot u16); the purposes of the mechanically-mapped structs at SB2+0x154, SB2+0xF5C/0xE0, and SB1+0x8AA/0x8AC.
- Whether bag quantities are truly unencrypted (money now live-proven plaintext; no encryptionKey exists, so quantities are almost certainly plain too, but all pockets were empty in the available dumps).
- Dex bit-index convention (dexNum vs dexNum-1) — one live dump with a seen mon settles it.
- gTasks = 0x03005BB8 hypothesis (not needed for save parsing).
