# Live-RAM verification of hack-offsets.json (empirical anchors, v2)

Per-claim verdicts against the 29 in-game dumps in `analysis/dumps/newgame-spam/`
(f003000–f019800; the earlier dumps are pre-intro blanks). Machine-readable:
`empirical-anchors.json`. Reference dump: f019800 unless noted. Verdict scale:
**confirmed** (positive live evidence) / **consistent** (right value but zero/default —
position not independently provable on this save) / **indeterminate** / **refuted**.

State: brand-new game, no starter, empty bag/PC/dex, player idle in bedroom at map (4,1)
pos (6,6). No encryptionKey exists (static finding); money reads plaintext, so nothing here
depends on a key.

## Verdict summary

**Confirmed with positive evidence:**

| claim | evidence |
|---|---|
| SB2 head @vanilla (name 0x0, TID 0xA, playtime 0xE, options 0x14) | name `bb ff…`="A"; TID 0x63E3EE80 invariant; playtime ticks at wall-clock rate |
| SB1 head @vanilla (pos 0x0, location 0x4, lastHeal 0x1C, mapLayoutId 0x32) | (6,6); map (4,1)→Pallet Town indoor via gamedata; (3,0) Pallet overworld; layout 73 == ROM header layout_id |
| money @ SB1+0x29C plaintext | u32 3000, only 3000 anywhere, all dumps |
| **gBagPockets @EWRAM 0x0200B770** | 7 `{ptr,cap}` = SB1+0x374/60, +0x2380/100, +0x52C/32, +0x5AC/64, +0x6AC/46, +0x464/50, +0x2AC/50 — pointers track each dump's ASLR base exactly across 17 shifts |
| flags @ SB1+0xEFB | 133 bits set (matches static count), identical in all dumps; ids incl. dense 0x428–0x456 block |
| vars @ SB1+0x1028 | nonzero only at var slots: 0x4029=4, 0x404C=0xAD46, 0x404F=0x8000, 0x40A5=0xE769, 0x40AF=0x8000, 0x40E0=1 |
| objectEventTemplates @ SB1+0x1398 | template[0] = localId 1, gfx 60, xy (6,5), script 0x082439C0 = the mom NPC (explains my earlier unidentified cluster) |
| berryTrees @ SB1+0x1998 | real pre-planted data: berry 0x15, minutesUntilNextStage 3600, yield 2, stride 8 |
| language byte @ SB2+0x91 | 0 = English |
| unknown_0x1228 shape | u16 @+8 (abs 0x1230) = 0x197 exactly as claimed |

**Unresolved items from hack-offsets.md — now resolved:**

- **SB2 tail struct @0xF5C = the hack's accelerated day/night clock.** u8 minute @0xF5F,
  u8 second @0xF60 (hour/day fields @0xF5C–0xF5E still 0). It advances ≈+90 in-game seconds
  per 600 frames (10-second-quantized; observed deltas 90–100) — a 9× real-time clock:
  1m20s (f003000) → 9m00s (f006000) → 44m30s (f019800). Not a save counter. The 8-byte
  clock ends exactly at 0xF64, matching both hack-offsets' "memset(SB2+0xF5C, ?, 8) tail
  struct" and the claimed SB2 size — **size 0xF64 is thereby confirmed**: anything read at
  sb2ptr+0xF64..0xFE3 is inter-block ASLR slack, not SaveBlock2 (SB2 buffer 0x0200DBEC +
  0xFE4 = SB1 buffer base 0x0200EBD0 exactly; the "warp records" seen there decode as stale
  copies of SB1[0x00..0x0B] — pos (6,6) + location (4,1,−1,6,6) — left by previous shifts,
  and their "volatility" is shift churn).
- **RTC-like fields @SB2 0x144–0x16B: refuted as a live RTC** — all zero and fully static
  over 4.5 minutes. If they are Time fields they are a dormant snapshot; the running clock
  is at 0xF5C.
- **gameStats: consistent with removed — no positive evidence of existence.** Monotonic-
  counter scan across all 29 dumps over SB1+SB2+full EWRAM+IWRAM found nothing stat-like
  incrementing — only frame counters (EWRAM 0x02038AF8, IWRAM 0x03003B84/88) and ASLR
  aliasing artifacts. Caveat: the idle player accrues no steps and no save was confirmed,
  so a dormant all-zero stats array would be invisible to this method; the removal case
  still rests primarily on the static evidence (no GetGameStat-shaped code).
- **SB2 inserted region 0x92–0x173 mapped:** completely static; single 0xFF bytes at 0xEC,
  0xFC, 0x10C, 0x11C, 0x12C (five 0x10-stride records with an empty-marker byte), rest zero.
- **SB2 unknown_0x6E0 identified:** `{u16=0, name[8]}` — bytes 0x6E2–0x6E9 are the player
  name "A" again (a name-copy record).
- **SB2+0x90:** constant 0x22 (34), set during init, static thereafter. Identity still unknown.

**Indeterminate (fresh-save degeneracy):**

- **mail @0x910**: the whole 0x910–0xB4F region is ZERO. Vanilla ClearMail leaves 0xFFFF
  word patterns, so either this hack zero-fills its mail, or mail lives elsewhere. Note the
  competing observation: a 16×36 array with the classic empty-mail pattern (ff×26 +
  species=1) sits at **0x1D98**, right before the OldMan/trader defaults at 0x1FDC
  (sDefaultTraderMons: PEGASO/PINZAS/KINGKONG…) and registeredTexts at 0x21B8 (exact
  HELLO/POKéMON/TRADE/… defaults, 10×21). The static save/load-loop evidence for 0x910
  stands unrefuted; a dump holding a real mail item settles it.
- partyCount@0x3B / party@0x44: read 0 / zeros — correct range and agrees with
  gPlayerPartyCount (EWRAM 0x02038559 = 0), but value-degenerate. Remember: party copies
  into SB1 **only on save**.
- coins@0x2A0, registeredItem@0x2A2, pcItems@0x2AC (empty), dex arrays (zero), frontier
  block @0x2744 (zero), PokemonStorage (empty): all consistent, none independently provable.
- Bag **quantity plaintext**: untestable with an empty bag (pointers/caps confirmed; the
  no-key argument makes plaintext near-certain, but the direct read needs items).
- **Dex seen-mirrors**: leaning removed (vanilla mirror positions are repurposed in the
  repacked layout; nothing contradicts removal) — needs a caught Pokémon to be definitive.

**Corrections to my earlier v1 empirical file:** the 0x1398 cluster I flagged as a "vars
candidate" is objectEventTemplates (mom NPC template); my "mail @0x1D98" identification is
downgraded to "mail-patterned array, identity open" given the static evidence for 0x910;
the "autosave" claim is softened to "pointer re-randomization every ≤10 s while idle —
autosave is one explanation, but no save counter exists to confirm"; and v1's "SB2
extension (0xF2C–0xFE4) is live" was an artifact of reading past SB2's true end (0xF64)
into inter-block ASLR slack containing stale SB1-head copies.

## All-zero gap regions (fresh save)

0x34–0x43, 0x764–0x8AC, 0x8AC–0x910 (claimed temp-mon slot), 0xB50–0xEFB, 0x2510–0x2744,
0x3B92–end (incl. the SB1 extension tail). SB1 has ZERO volatile bytes across dumps; SB2
varies only in playtime and the 0xF5C clock.

## What the next dump session must contain (to close every open item)

Starter obtained → **game saved** → an item in each bag pocket → one mail-attached item →
one badge → one caught Pokémon. That single state resolves: party base, bag segmentation +
quantity plaintext, mail 0x910-vs-0x1D98, badge flag ids in hack numbering, and the dex
mirror question.
