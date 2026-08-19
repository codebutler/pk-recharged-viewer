# mGBA RAM-dump harness

Scriptable harness that runs `local/Pokemon Recharged Yellow.gba` in mGBA, auto-advances
the game by spamming A/Start, and periodically dumps IWRAM + EWRAM to binary files.
Used as ground truth for RAM-map verification.

## mGBA setup (what works and what doesn't)

- `brew install mgba` (formula, 0.10.5_2) is **broken** on this machine: the bottle
  links `/opt/homebrew/opt/ffmpeg/lib/libavcodec.62.dylib` (ffmpeg 8) but installed
  ffmpeg is 9 (`libavcodec.63`); the binary won't launch and no `ffmpeg@8` formula
  exists. Also 0.10.x has **no `--script` CLI flag** (scripting only via GUI menu).
- `brew install --cask mgba` (0.10.5 official build, bundled libs) launches fine but
  likewise lacks `--script`.
- **The mGBA 0.11 nightly is what works.** It adds `--script FILE`:

  ```sh
  curl -L -o /tmp/mgba.dmg https://s3.amazonaws.com/mgba/mGBA-build-latest-macos.dmg
  hdiutil attach -nobrowse -readonly /tmp/mgba.dmg -mountpoint /tmp/mgba-mnt
  cp -R /tmp/mgba-mnt/mGBA.app /Applications/mGBA-nightly.app
  hdiutil detach /tmp/mgba-mnt
  ```

  Installed here as `/Applications/mGBA-nightly.app`
  (version `0.11-9123-438c77387` at time of writing).
- There is no true headless mode; a Qt window appears for the duration of the run.
  `-C audio.mute=1` mutes audio. Emulation runs at normal speed (~60 fps), so a
  20000-frame run takes ~5.5 minutes.
- **Gotcha:** mGBA silently never executes the `--script` file when the ROM path is
  under `/var/folders/...` (macOS mktemp default). The emulator stays up but the
  script does not run. Keep ROM and output on normal paths (the driver script
  handles this by working inside the dump directory).

### Scripting API facts verified on this build

- Standard Lua libs available: `io`, `os` (incl. `os.getenv`, `os.execute`).
- `emu:read32(addr)`, `emu:readRange(addr, len)` (returns a byte string).
- `emu:addKey(C.GBA_KEY.X)` / `emu:clearKey(...)` / `emu:setKeys(mask)` /
  `emu:getKeys()`. Key indices: A=0, B=1, SELECT=2, START=3, R=8, L=9.
- `callbacks:add("frame", fn)` fires once per emulated frame. There is no
  `emu:runFrame()` in the scripting context — frame advance is callback-driven.
- `emu:screenshot(path)` writes a PNG.
- `console:log(msg)` goes to the (invisible) scripting console, not stdout — the
  harness writes its own `harness.log` instead.

## Usage

```sh
research/tools/run_harness.sh <rom.gba> <label> [max_frames] [period] [input]
# e.g.
research/tools/run_harness.sh "local/Pokemon Recharged Yellow.gba" newgame-spam 20000 600 1
```

- `label` — dumps land in `research/dumps/<label>/`
- `max_frames` — frames to emulate before the final dump (default 20000)
- `period` — frames between periodic dumps (default 600 = 10 s of game time)
- `input` — `1` (default) spams A/Start in a 32-frame cycle (hold A 8 frames,
  release 8, hold Start 8, release 8 ≈ 2 presses/sec); `0` runs hands-off
- `MGBA_BIN` env var overrides the emulator path.

The driver copies the ROM to `research/dumps/<label>/work/rom.gba` (so mGBA's
`.sav` never lands next to the original ROM), launches mGBA with
`research/tools/mgba_dump_harness.lua`, polls for the `DONE` marker, and kills the
emulator. Exit code 2 = timed out / died early (partial dumps may still exist).

The Lua script is configured through env vars set by the driver:
`HARNESS_OUT_DIR`, `HARNESS_MAX_FRAMES`, `HARNESS_PERIOD`, `HARNESS_INPUT`.

### Alternate harness scripts

Set `HARNESS_SCRIPT` to run a different Lua file through the same driver (pass a
`max_frames` argument roughly matching the script's plan so the driver's timeout
budget is right; the scripts below ignore `HARNESS_MAX_FRAMES` itself):

- `mgba_walk_harness.lua` — spams through the intro to the overworld, closes
  menus with B, then walks in each direction with a labeled dump after every
  segment (`prewalk`, `walk-down/left/up/right`, `wander1/2`, `final`). Its
  timeline is the `plan` table inside the script — edit in place, it is not
  parameterized. Plan total ≈ 7300 frames; pass `max_frames` 8000.
- `mgba_inject_harness.lua` — reaches the overworld, then constructs a level-5
  Pikachu (encrypted substructs + checksum built at runtime from the live otId)
  and writes it into SB1 party (hack offsets 0x3B/0x44) and the hack's static
  `gPlayerParty` (0x0203855C, per hack-offsets.json), puts Potion x5 in the
  Items pocket (SB1+0x374, plaintext), sets FLAG_SYS_POKEMON_GET candidate
  flags (0x860/0x828 at the hack's flags base SB1+0xEFB), then dumps
  (`preinject`, `injected`, `injected-settled`, `final`) and screenshots the
  Start menu / party screens. The exact injected bytes are saved as
  `injected_mon.bin` in the output dir. Pass `max_frames` 8000.

```sh
HARNESS_SCRIPT=research/tools/mgba_inject_harness.lua \
  research/tools/run_harness.sh "local/Pokemon Recharged Yellow.gba" inject 8000
```

## Dump layout

```
research/dumps/<label>/
  harness.log          timestamped-by-frame log incl. pointer values per dump
  DONE                 written when the run completed (driver's success signal)
  work/                ROM copy + the .sav mGBA created (reusable to resume)
  f000600/ f001200/ ... final/
    iwram.bin          0x03000000..0x03007FFF (0x8000 bytes)
    ewram.bin          0x02000000..0x0203FFFF (0x40000 bytes)
    pointers.txt       frame, gSaveBlock1Ptr/gSaveBlock2Ptr/gPokemonStoragePtr, valid flag
    screen.png         240x160 screenshot of that moment
```

To read a pointer straight from a dump (IWRAM 0x03005AD0 = offset 0x5AD0):

```sh
python3 -c "import struct;print(hex(struct.unpack_from('<I', open('iwram.bin','rb').read(), 0x5AD0)[0]))"
```

## Save pointers in this ROM hack

`gSaveBlock1Ptr` (0x03005AD0), `gSaveBlock2Ptr` (0x03005AD4),
`gPokemonStoragePtr` (0x03005AD8) hold **valid EWRAM pointers already ~60 frames
after reset**, before the title screen — the engine allocates the save blocks
during startup, not on New Game. So "pointer valid" ≈ "save blocks allocated",
not "player is in the overworld"; use the screenshot / later dumps to judge
actual game progress. The pointer values shift between boots AND periodically
during play (Emerald's anti-cheat DMA shuffle; the in-run reshuffles are likely
autosave-related but that is unconfirmed) — e.g. 0x0200EBD0 one boot,
0x0200EBE0 the next, and 0x0200EBFC -> 0x0200EC04 mid-run in the inject run.
The block contents are migrated intact on reshuffle. Always re-read the IWRAM
pointers from the same dump you are parsing.

## parse_ram.py -- RAM dump to game-state JSON

The project's main deliverable. Parses one dump (directory with iwram.bin +
ewram.bin, or an iwram path with `--ewram`) and prints the full game state as
JSON:

```sh
python3 parse_ram.py ../dumps/newgame-spam/f004200 --pretty
```

Offset configuration is layered (later wins): built-in vanilla pokeemerald
defaults -> `offsets-discovered.json` (dump-verified facts from this tool's
author) -> `../hack-offsets.json` (ROM-disassembly derived, authoritative) ->
`--offsets EXTRA.json`. Name tables come from `../gamedata.json`, charmap and
substruct permutation from `../structs.json`.

Every section carries a confidence entry in `meta.confidence`; sections whose
offsets are unverified emit an explicit `error` instead of garbage. Pre-game
dumps (title/intro, zero or partially initialized save blocks) report
`"inGame": false` cleanly. If party checksums fail at the configured offset the
tool scans SaveBlock1 for checksum-valid Pokemon and reports candidate offsets
in `meta.discovered` (disable with `--no-scan`).

### Live vs. saved party

SaveBlock1's party (+0x44) and objectEvents are copy-on-save, not live state.
parse_ram.py therefore reads the LIVE party from the fixed EWRAM globals
`gPlayerPartyCount` (0x02038559) / `gPlayerParty` (0x0203855C) as the `party`
section, and emits the SaveBlock1 copy separately as `savedParty`, each with a
`source` label. The hack likely autosaves: 17 ASLR reshuffles of the save blocks
were observed across 29 idle dumps, and vanilla only reshuffles on save (no save
counter was directly confirmed). That would keep the SB1 copy fresh; other SB1
fields were invariant across those idle dumps. SaveBlock2 truly
ends at +0xF64; its last 8 bytes (+0xF5C) are the hack's accelerated day/night
clock (parsed as `gameClock`). Bytes at sb2+0xF64..0xFE3 are inter-block ASLR
slack containing stale copies of SB1's head from earlier shifts -- not SaveBlock2
data; the parser never reads there.

## Parsing an mGBA savestate (human-played sessions)

A savestate from a manual mGBA session can be parsed without the harness:

```sh
python3 parse_ram.py --state path/to/save.ss0 --pretty
```

or as an explicit two-step via `state_extract.py`:

```sh
python3 state_extract.py path/to/save.ss0          # -> path/to/save.ramdump/
python3 parse_ram.py path/to/save.ramdump --pretty
```

`state_extract.py` handles both mGBA savestate containers (format probed
empirically -- `dumps/statepair/` holds a savestate + same-frame RAM dump pair):

- **PNG container** (the default, incl. GUI slot files `.ss0`-`.ss9`): the
  `gbAs` chunk holds the zlib-compressed 0x61000-byte serialized state.
- **Raw 0x61000-byte state** (scripting `saveStateFile` variants).
- **libretro mGBA-core `.st*`** (MinUI-style handhelds): the raw state plus
  appended savedata/extras; detected by the state's version magic (u32
  0x010000xx at +0) or ROM title at +0x10, first 0x61000 bytes used.

Within the serialized state, IWRAM sits at +0x19000 and EWRAM at +0x21000 --
verified byte-identical to a same-frame `emu:readRange` dump, and the parse
output is identical to the direct-dump parse (round-trip tested for both
container types).

Fallback if a state doesn't extract (foreign format/version):

```sh
tools/state_to_dump.sh <rom.gba> <savestate> <outdir>   # loads it in mGBA, dumps RAM
```

(Also round-trip tested. Outdir must not be under /var/folders -- same --script
gotcha as the harness; the script refuses.) Flash `.sav` files are NOT
savestates and are out of scope for both tools.

Scripting API facts (0.11 nightly): `emu:saveStateFile(path[, flags])` and
`emu:loadStateFile(path)` exist; `C.SAVESTATE` = SCREENSHOT=1, SAVEDATA=2,
CHEATS=4, RTC=8, METADATA=16, ALL=31. Default save is the PNG container;
`saveStateFile(path, 0)` returns false and writes garbage -- don't use flags=0.
