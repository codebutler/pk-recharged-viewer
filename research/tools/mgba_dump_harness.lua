-- mgba_dump_harness.lua
-- Runs inside mGBA (0.11 nightly, --script). Spams A/Start to advance the game,
-- periodically dumps IWRAM + EWRAM to binary files, logs Emerald save pointers,
-- and writes a DONE marker when finished so a driver script can kill the emulator.
--
-- Configuration via environment variables (all optional except OUT_DIR):
--   HARNESS_OUT_DIR     output root; dumps land in <root>/f<NNNNNN>/  (required)
--   HARNESS_MAX_FRAMES  total frames to run before final dump + DONE (default 20000)
--   HARNESS_PERIOD      frames between periodic dumps               (default 600)
--   HARNESS_INPUT       "1" to spam A/Start, "0" to run hands-off   (default 1)
--
-- Dump layout per snapshot directory:
--   iwram.bin    0x03000000..0x03007FFF (0x8000 bytes)
--   ewram.bin    0x02000000..0x0203FFFF (0x40000 bytes)
--   pointers.txt gSaveBlock1Ptr/gSaveBlock2Ptr/gPokemonStoragePtr + frame count
--   screen.png   screenshot (if the API supports it)

local IWRAM_BASE, IWRAM_SIZE = 0x03000000, 0x8000
local EWRAM_BASE, EWRAM_SIZE = 0x02000000, 0x40000
local PTR_SB1, PTR_SB2, PTR_STORAGE = 0x03005AD0, 0x03005AD4, 0x03005AD8

local OUT_DIR   = os.getenv("HARNESS_OUT_DIR")
local MAX_FRAMES = tonumber(os.getenv("HARNESS_MAX_FRAMES") or "20000")
local PERIOD     = tonumber(os.getenv("HARNESS_PERIOD") or "600")
local DO_INPUT   = (os.getenv("HARNESS_INPUT") or "1") ~= "0"

local frames = 0
local logf = nil
local function log(msg)
  local line = string.format("[f%06d] %s", frames, msg)
  if console then console:log(line) end
  if logf then logf:write(line .. "\n"); logf:flush() end
end

if not OUT_DIR then
  if console then console:log("HARNESS_OUT_DIR not set; harness disabled") end
  return
end

os.execute(string.format('mkdir -p "%s"', OUT_DIR))
logf = io.open(OUT_DIR .. "/harness.log", "a")

local function isEwramPtr(v)
  return v >= EWRAM_BASE and v < EWRAM_BASE + EWRAM_SIZE
end

local function dump(label)
  local dir = string.format("%s/%s", OUT_DIR, label)
  os.execute(string.format('mkdir -p "%s"', dir))
  local ok, err = pcall(function()
    local f = assert(io.open(dir .. "/iwram.bin", "wb"))
    f:write(emu:readRange(IWRAM_BASE, IWRAM_SIZE)); f:close()
    f = assert(io.open(dir .. "/ewram.bin", "wb"))
    f:write(emu:readRange(EWRAM_BASE, EWRAM_SIZE)); f:close()
    local p1, p2, p3 = emu:read32(PTR_SB1), emu:read32(PTR_SB2), emu:read32(PTR_STORAGE)
    f = assert(io.open(dir .. "/pointers.txt", "w"))
    f:write(string.format("frame=%d\ngSaveBlock1Ptr=0x%08X\ngSaveBlock2Ptr=0x%08X\ngPokemonStoragePtr=0x%08X\nvalid=%s\n",
      frames, p1, p2, p3,
      tostring(isEwramPtr(p1) and isEwramPtr(p2) and isEwramPtr(p3))))
    f:close()
    pcall(function() emu:screenshot(dir .. "/screen.png") end)
    log(string.format("dumped %s  SB1=0x%08X SB2=0x%08X STOR=0x%08X", label, p1, p2, p3))
  end)
  if not ok then log("dump FAILED: " .. tostring(err)) end
end

-- Input pattern: 32-frame cycle. Hold A frames 0-7, release, hold Start 16-23,
-- release. Edge transitions are what the game registers; ~2 presses/sec at 60fps.
local KEY_A, KEY_START = C.GBA_KEY.A, C.GBA_KEY.START
local function driveInput(frame)
  local phase = frame % 32
  if phase == 0 then emu:addKey(KEY_A)
  elseif phase == 8 then emu:clearKey(KEY_A)
  elseif phase == 16 then emu:addKey(KEY_START)
  elseif phase == 24 then emu:clearKey(KEY_START)
  end
end

local finished = false

local function onFrame()
  if finished then return end
  frames = frames + 1
  if DO_INPUT then driveInput(frames) end
  if frames % PERIOD == 0 then
    dump(string.format("f%06d", frames))
  end
  if frames >= MAX_FRAMES then
    finished = true
    emu:setKeys(0)
    dump("final")
    local f = io.open(OUT_DIR .. "/DONE", "w")
    if f then f:write(string.format("frames=%d\n", frames)); f:close() end
    log("harness complete")
    if logf then logf:close(); logf = nil end
  end
end

callbacks:add("frame", onFrame)
log(string.format("harness started: out=%s max=%d period=%d input=%s",
  OUT_DIR, MAX_FRAMES, PERIOD, tostring(DO_INPUT)))
