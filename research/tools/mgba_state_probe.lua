-- mgba_state_probe.lua
-- One-shot probe: advance the game to HARNESS_MAX_FRAMES (A/Start spam like the
-- dump harness), then at that single instant write a RAM dump AND savestates with
-- several flag combinations. Used to reverse the savestate container format by
-- content-matching the known RAM against the state files.
--
-- Env: HARNESS_OUT_DIR (required), HARNESS_MAX_FRAMES (default 4200)

local IWRAM_BASE, IWRAM_SIZE = 0x03000000, 0x8000
local EWRAM_BASE, EWRAM_SIZE = 0x02000000, 0x40000

local OUT_DIR = os.getenv("HARNESS_OUT_DIR")
local MAX_FRAMES = tonumber(os.getenv("HARNESS_MAX_FRAMES") or "4200")

local frames = 0
local logf = nil
local function log(msg)
  local line = string.format("[f%06d] %s", frames, msg)
  if console then console:log(line) end
  if logf then logf:write(line .. "\n"); logf:flush() end
end

if not OUT_DIR then return end
os.execute(string.format('mkdir -p "%s"', OUT_DIR))
logf = io.open(OUT_DIR .. "/harness.log", "a")

local function saveState(path, flags)
  local ok, err
  if flags == nil then
    ok, err = pcall(function() return emu:saveStateFile(path) end)
  else
    ok, err = pcall(function() return emu:saveStateFile(path, flags) end)
  end
  log(string.format("saveStateFile(%s, %s) -> ok=%s err=%s",
    path, tostring(flags), tostring(ok), tostring(err)))
end

local KEY_A, KEY_START = C.GBA_KEY.A, C.GBA_KEY.START
local finished = false

local function onFrame()
  if finished then return end
  frames = frames + 1
  local phase = frames % 32
  if phase == 0 then emu:addKey(KEY_A)
  elseif phase == 8 then emu:clearKey(KEY_A)
  elseif phase == 16 then emu:addKey(KEY_START)
  elseif phase == 24 then emu:clearKey(KEY_START)
  end
  if frames < MAX_FRAMES then return end
  finished = true
  emu:setKeys(0)

  -- Log what the API offers.
  log("emu.saveStateFile type: " .. type(emu.saveStateFile))
  log("emu.loadStateFile type: " .. type(emu.loadStateFile))
  if C.SAVESTATE then
    for k, v in pairs(C.SAVESTATE) do log(string.format("C.SAVESTATE.%s = %s", k, tostring(v))) end
  else
    log("C.SAVESTATE table not present")
  end

  -- RAM dump of this exact instant (frame callback = consistent point).
  local f = assert(io.open(OUT_DIR .. "/iwram.bin", "wb"))
  f:write(emu:readRange(IWRAM_BASE, IWRAM_SIZE)); f:close()
  f = assert(io.open(OUT_DIR .. "/ewram.bin", "wb"))
  f:write(emu:readRange(EWRAM_BASE, EWRAM_SIZE)); f:close()
  pcall(function() emu:screenshot(OUT_DIR .. "/screen.png") end)
  log("RAM dumped")

  -- Savestate variants at the same instant.
  saveState(OUT_DIR .. "/state_default.ss")
  saveState(OUT_DIR .. "/state_flags0.ss", 0)
  if C.SAVESTATE then
    local all = 0
    for _, v in pairs(C.SAVESTATE) do if type(v) == "number" then all = all | v end end
    saveState(OUT_DIR .. "/state_all.ss", all)
    if C.SAVESTATE.SCREENSHOT then
      saveState(OUT_DIR .. "/state_screenshot.ss", C.SAVESTATE.SCREENSHOT)
    end
  end

  local d = io.open(OUT_DIR .. "/DONE", "w")
  if d then d:write(string.format("frames=%d\n", frames)); d:close() end
  log("state probe complete")
  if logf then logf:close(); logf = nil end
end

callbacks:add("frame", onFrame)
log(string.format("state probe started: out=%s target_frame=%d", OUT_DIR, MAX_FRAMES))
