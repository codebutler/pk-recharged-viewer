# How the engine works (pokeemerald), for people reading this ROM

Background for anyone chasing a RAM address, a function, or a screen in
Recharged Yellow. Everything here is **descriptive**: how the engine is built,
with citations into `vendor/pokeemerald` so you can check any claim. Hack-specific
addresses live in `hack-offsets.json`; this file is the model those addresses sit
inside.

Vanilla structure is a safe guide for *mechanism* even though the hack repacked
its save data — the hack is a pokeemerald rebuild, so `main.c`, `task.c`,
`window.c`, the CB2 pattern and the task conventions all survive intact. What
does **not** survive is any vanilla *offset*.

## The frame loop: two callbacks and a state counter

`AgbMain` runs `gMain.callback1()` then `gMain.callback2()` every frame
(`src/main.c:190-194`), then `RunTasks()`, sprite/text/palette work, and waits
for VBlank. `callback2` ("CB2") is what a screen *is*: switching screens means
`SetMainCallback2(CB2_Whatever)`, which also **zeroes `gMain.state`**
(`src/main.c:197-200`).

That zeroing is why nearly every screen is written as a `switch (gMain.state)`
setup machine that runs one step per frame — clear the screen, reset sprites,
reset tasks, load graphics, build windows, create its task, fade in — each case
ending in `gMain.state++`. `CB2_InitTrainerCard` in
`src/trainer_card.c:590+` is a compact example, and the hack's own screens are
recognisable jump-tables on the same counter.

Practical consequence: to identify an unknown screen in the ROM, find its
setup machine. It will call the same helpers in the same order as the decomp's,
which makes matching mechanical.

## Tasks: a 16-slot array of per-screen scratch

```c
struct Task {
    TaskFunc func;      // +0x00
    bool8 isActive;     // +0x04
    u8 prev, next;      // +0x05, +0x06   (intrusive priority-ordered list)
    u8 priority;        // +0x07
    s16 data[16];       // +0x08 .. +0x27
};                      // 40 (0x28) bytes; gTasks[NUM_TASKS = 16]
```
(`include/task.h:8-22`.)

- `ResetTasks` (`src/task.c:9-25`) wipes all 16: `func = TaskDummy`,
  `isActive = FALSE`, `prev`/`next` re-linked, `priority = -1`, and
  `memset(data, 0, sizeof(data))`.
- `CreateTask` (`src/task.c:27+`) scans from index 0 for the first entry with
  `isActive == FALSE` and takes it — **lowest free slot wins**.

Put those together and you get the single most useful fact for reading RAM in
this game:

> A screen that calls `ResetTasks` and then creates its main task owns
> **`gTasks[0]`**, and its `data[0..15]` are that screen's variables.

So one IWRAM address inside `gTasks` has **no single meaning**: it is one
screen's variable and the next screen's something else, and it is scratch —
nothing in `gTasks` is ever saved.

`data[]` is untyped `s16[16]` in the struct, and each screen names its own slots
with defines at the top of its file, e.g. `#define tFlipState data[0]` /
`#define tCardTop data[1]` (`src/trainer_card.c:1584-1585`), and a different
screen will name the same slots something else entirely. Those defines are the
dictionary: once you know which screen owns a slot, grep the decomp for
`data[k]` in that file and the field has a name.

Two consequences that repeatedly catch people out:

- **Task data is usually addressed without a literal.** agbcc keeps a
  `gTasks + 8` base in a register with `taskId * 40` folded in and reads
  `ldrh/ldrsh [reg, #imm]`. A ROM-wide search for the absolute address of
  `data[k]` therefore finds few or no hits, and any hit it does find is likely
  an unrelated screen where the compiler happened to fold the constant. Absence
  of a literal is not absence of use.
- **Slot occupancy is a fact about a moment, not about the game.** Reading it
  out of a dump tells you what that dump's screen was doing. Every dump
  directory ships a `screen.png` naming the screen, so a slot-0 census across
  `research/dumps/` is a census of *screens*, and the corpus is mostly overworld.

## Locating a subsystem in the ROM

Four routes, roughly in order of how fast they land:

1. **Text.** Encode a phrase from the screen with the pokeemerald charmap
   (`research/tools/gba_script.py` has the codec), find the bytes in the ROM,
   then find the 4-byte-aligned word pointing at that string. That word is in
   the literal pool of the function that prints it.
2. **Data tables.** Match a table's byte pattern against the decomp — option
   lists, type ids, stride-N record arrays. A byte-for-byte match is strong
   identification, since the hack rebuilt the same tables.
3. **The specials table.** Script-callable functions are listed in the table the
   script VM uses; an index found there can be grepped in `research/scripts/` to
   see which NPC calls it, which names the subsystem from the game's side.
4. **Structural match.** Disassemble and compare shape — the same helpers called
   in the same order with the same constants. This is what confirms 1-3.

Caution on 1-3: they identify *a* consumer, not *the* consumer. A screen that
merely mentions a variable is not necessarily the screen that gives it meaning.

## Memory regions

| region | range | what lives there |
|---|---|---|
| EWRAM | 0x02000000 + 256 KB | the SaveBlock buffers, party/box globals, most game state |
| IWRAM | 0x03000000 + 32 KB | fast globals: `gMain`, `gTasks`, the save pointers, engine scratch |
| ROM | 0x08000000 + 16 MB | code, text, tables |

The save pointers (`gSaveBlock1Ptr` etc., IWRAM 0x03005AD0-AD8) are the bridge:
saved state is reached by dereferencing them, never by a fixed EWRAM address,
because the buffers ASLR-shift. Anything you find in IWRAM outside those
pointers is engine scratch and is **not** part of the save.

For hardware-level detail — exact region sizes, mirroring, I/O registers, the
ARM7TDMI instruction encodings — see `vendor/gbatek/` (GBATEK).

## Further reading in the tree

- `vendor/pokeemerald/` — authoritative for engine structure and struct layouts.
- `vendor/pokefirered/` — the right reference for FRLG-only script commands and
  for FRLG-shaped content this hack inherited.
- `vendor/mgba/` — the emulator's own source; authoritative for cheat-code
  formats (see `cheat-code-formats.md`) and for how RAM is read at runtime.
- `vendor/gbatek/` — GBA hardware reference.
