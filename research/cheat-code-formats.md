# GBA cheat-code formats, from the emulator's own source

Cheat codes arrive as opaque hex. Their meaning is a property of the *cheat
device*, not of the game — which makes it the one part of a cheat-code
investigation you cannot derive from the ROM. You do not have to guess it
either: `vendor/mgba` is the source of the emulator this project already drives,
so the decode is a citation, not a recollection.

Read the source rather than this summary when precision matters:
`vendor/mgba/src/gba/cheats/` (`codebreaker.c`, `gameshark.c`, `parv3.c`) and
`vendor/mgba/include/mgba/internal/gba/cheats.h`.

## Telling the formats apart

- **`AAAAAAAA VVVV`** (8 hex + 4 hex) — CodeBreaker / GameShark SP style.
- **`AAAAAAAA VVVVVVVV`** (8 + 8) — GameShark Advance (v1/v2) or Action
  Replay v3. These are commonly **encrypted**; ARv3 codes must be decrypted
  before the address means anything (`parv3.c`), so an 8+8 code cannot be read
  off by eye.

## CodeBreaker: the type nibble

The top nibble of the first word selects the operation
(`codebreaker.c:197`: `type = op1 >> 28`), and for the plain cases the address
is the remaining 28 bits with the operand in the second word
(`codebreaker.c:346-347`):

```c
cheat->address = op1 & 0x0FFFFFFF;
cheat->operand = op2;
```

Types (`cheats.h:27-44`):

| nibble | name | meaning |
|---|---|---|
| 0x0 | `CB_GAME_ID` | header / game id, not a write |
| 0x1 | `CB_HOOK` | sets the hook address in ROM |
| 0x2 | `CB_OR_2` | 16-bit OR |
| 0x3 | `CB_ASSIGN_1` | 8-bit write |
| 0x4 | `CB_FILL` | fill |
| 0x5 | `CB_FILL_LIST` | fill from a list |
| 0x6 | `CB_AND_2` | 16-bit AND |
| 0x7 | `CB_IF_EQ` | conditional: equal |
| **0x8** | **`CB_ASSIGN_2`** | **16-bit write** (`codebreaker.c:297-301`: `CHEAT_ASSIGN`, `width = 2`) |
| 0x9 | `CB_ENCRYPT` | reseeds the code encryption |
| 0xA | `CB_IF_NE` | conditional: not equal |
| 0xB | `CB_IF_GT` | conditional: greater than |
| 0xC | `CB_IF_LT` | conditional: less than |
| 0xD | `CB_IF_SPECIAL` | conditional on a special (e.g. keypad, `codebreaker.c:321-327`) |
| 0xE | `CB_ADD_2` | 16-bit add |
| 0xF | `CB_IF_AND` | conditional: bitwise and |

So a code of the form `8AAAAAAA VVVV` writes the halfword `VVVV` to address
`0x0AAAAAAA`, re-applied every frame while the cheat is enabled. Addresses
therefore read directly: `82…` is EWRAM (0x02…), `83…` is IWRAM (0x03…).

## What that does and does not tell you

The decode gives you an address and a value. It gives you **no** information
about meaning — that is entirely a property of this ROM's build. In particular,
an IWRAM address in 0x03005BB8-0x03005E38 lands inside `gTasks`, where the
meaning depends on which screen owns the slot; see `engine-architecture.md`.

Codes also travel between games. A code written for vanilla FireRed or Emerald
aimed at a named variable will, in a rebuilt hack, land wherever that build put
its data — usually somewhere unrelated. Checking the vanilla ROMs in `local/`
for references to the same address is a cheap way to tell "written for this
build" from "inherited from a list".
