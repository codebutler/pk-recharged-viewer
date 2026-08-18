-- mgba_state_dump.lua
-- Converter: boot mGBA with the game's ROM, load a savestate, dump IWRAM+EWRAM.
-- The reliable fallback for savestates state_extract.py cannot handle.
--
-- Env: HARNESS_OUT_DIR (required)  output dir for iwram.bin/ewram.bin/screen.png
--      HARNESS_STATE   (required)  savestate file to load

local IWRAM_BASE, IWRAM_SIZE = 0x03000000, 0x8000
local EWRAM_BASE, EWRAM_SIZE = 0x02000000, 0x40000

local OUT_DIR = os.getenv("HARNESS_OUT_DIR")
local STATE = os.getenv("HARNESS_STATE")

local frames = 0
local logf = nil
local function log(msg)
  local line = string.format("[f%06d] %s", frames, msg)
  if console then console:log(line) end
  if logf then logf:write(line .. "\n"); logf:flush() end
end

if not OUT_DIR or not STATE then return end
os.execute(string.format('mkdir -p "%s"', OUT_DIR))
logf = io.open(OUT_DIR .. "/harness.log", "a")

local loaded = false
local finished = false

local function onFrame()
  if finished then return end
  frames = frames + 1
  -- Let the core settle a few frames before loading, then dump on the frame
  -- AFTER the load so the loaded state is fully in place.
  if frames == 5 then
    local ok, res = pcall(function() return emu:loadStateFile(STATE) end)
    log(string.format("loadStateFile(%s) -> ok=%s result=%s", STATE,
      tostring(ok), tostring(res)))
    if not (ok and res) then
      local f = io.open(OUT_DIR .. "/DONE", "w")
      if f then f:write("error=loadStateFile failed\n"); f:close() end
      finished = true
      return
    end
    loaded = true
  elseif loaded and frames >= 6 then
    finished = true
    local f = assert(io.open(OUT_DIR .. "/iwram.bin", "wb"))
    f:write(emu:readRange(IWRAM_BASE, IWRAM_SIZE)); f:close()
    f = assert(io.open(OUT_DIR .. "/ewram.bin", "wb"))
    f:write(emu:readRange(EWRAM_BASE, EWRAM_SIZE)); f:close()
    pcall(function() emu:screenshot(OUT_DIR .. "/screen.png") end)
    f = io.open(OUT_DIR .. "/DONE", "w")
    if f then f:write("ok=true\n"); f:close() end
    log("state loaded and RAM dumped")
    if logf then logf:close(); logf = nil end
  end
end

callbacks:add("frame", onFrame)
log(string.format("state-dump converter started: state=%s out=%s", STATE, OUT_DIR))
