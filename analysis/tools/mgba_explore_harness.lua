-- mgba_explore_harness.lua
-- Tries to reach real game progression: spams through the intro to the
-- overworld, then wanders pseudo-randomly (direction holds + A bursts + an
-- occasional B) hoping to trigger the starter-Pikachu sequence. Watches the
-- live party count at 0x02038559 (hack gPlayerPartyCount, per
-- analysis/hack-offsets.json); the moment it becomes nonzero it dumps
-- "starter-live", spams B for 900 frames to clear dialogue/naming, then dumps
-- "starter-settled" and finishes. Periodic dumps every HARNESS_PERIOD frames
-- (default 1200) regardless, so partial progress is always captured.
--
-- Env: HARNESS_OUT_DIR (required), HARNESS_MAX_FRAMES (default 40000),
-- HARNESS_PERIOD (default 1200).

local IWRAM_BASE, IWRAM_SIZE = 0x03000000, 0x8000
local EWRAM_BASE, EWRAM_SIZE = 0x02000000, 0x40000
local PTR_SB1, PTR_SB2, PTR_STORAGE = 0x03005AD0, 0x03005AD4, 0x03005AD8
local GPARTY_COUNT = 0x02038559

local OUT_DIR = os.getenv("HARNESS_OUT_DIR")
local MAX_FRAMES = tonumber(os.getenv("HARNESS_MAX_FRAMES") or "40000")
local PERIOD = tonumber(os.getenv("HARNESS_PERIOD") or "1200")

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

local function dump(label)
  local dir = string.format("%s/%s", OUT_DIR, label)
  os.execute(string.format('mkdir -p "%s"', dir))
  local ok, err = pcall(function()
    local f = assert(io.open(dir .. "/iwram.bin", "wb"))
    f:write(emu:readRange(IWRAM_BASE, IWRAM_SIZE)); f:close()
    f = assert(io.open(dir .. "/ewram.bin", "wb"))
    f:write(emu:readRange(EWRAM_BASE, EWRAM_SIZE)); f:close()
    local p1, p2, p3 = emu:read32(PTR_SB1), emu:read32(PTR_SB2), emu:read32(PTR_STORAGE)
    local pc = emu:read8(GPARTY_COUNT)
    local f2 = assert(io.open(dir .. "/pointers.txt", "w"))
    f2:write(string.format("frame=%d\ngSaveBlock1Ptr=0x%08X\ngSaveBlock2Ptr=0x%08X\ngPokemonStoragePtr=0x%08X\ngPlayerPartyCount=%d\n",
      frames, p1, p2, p3, pc))
    f2:close()
    pcall(function() emu:screenshot(dir .. "/screen.png") end)
    log(string.format("dumped %s  SB1=0x%08X partyCount=%d", label, p1, pc))
  end)
  if not ok then log("dump FAILED: " .. tostring(err)) end
end

local K = C.GBA_KEY
local DIRS = { K.DOWN, K.LEFT, K.UP, K.RIGHT }

-- deterministic LCG so runs are reproducible
local seed = 0x1234ABCD
local function rnd(n)
  seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
  return (seed >> 16) % n
end

local INTRO_FRAMES = 5400
local BSPAM_FRAMES = 240

local phase = "intro"        -- intro -> closemenus -> explore -> drain -> done
local phaseFrame = 0
local burstLeft = 0
local drainStart = 0

local curMode = nil   -- "dir", "A", or "B"
local function explorerInput()
  -- pattern unit: hold a random direction 48 frames, or a 32-frame burst of
  -- A (or occasionally B) presses to advance dialogue / dismiss stray menus
  if burstLeft == 0 then
    emu:setKeys(0)
    local r = rnd(10)
    if r < 6 then
      curMode = "dir"
      emu:addKey(DIRS[rnd(4) + 1])
      burstLeft = 48
    elseif r < 9 then
      curMode = "A"
      burstLeft = 32
    else
      curMode = "B"
      burstLeft = 32
    end
  end
  if curMode == "A" or curMode == "B" then
    local key = (curMode == "A") and K.A or K.B
    local p = burstLeft % 16
    if p == 0 then emu:addKey(key) elseif p == 8 then emu:clearKey(key) end
  end
  burstLeft = burstLeft - 1
end

local finished = false
local function onFrame()
  if finished then return end
  frames = frames + 1
  phaseFrame = phaseFrame + 1

  if phase == "intro" then
    local p = phaseFrame % 32
    if p == 0 then emu:addKey(K.A)
    elseif p == 8 then emu:clearKey(K.A)
    elseif p == 16 then emu:addKey(K.START)
    elseif p == 24 then emu:clearKey(K.START) end
    if phaseFrame >= INTRO_FRAMES then
      emu:setKeys(0); phase = "closemenus"; phaseFrame = 0
    end
  elseif phase == "closemenus" then
    local p = phaseFrame % 16
    if p == 0 then emu:addKey(K.B) elseif p == 8 then emu:clearKey(K.B) end
    if phaseFrame >= BSPAM_FRAMES then
      emu:setKeys(0); phase = "explore"; phaseFrame = 0
      dump("pre-explore")
    end
  elseif phase == "explore" then
    explorerInput()
    if emu:read8(GPARTY_COUNT) ~= 0 then
      emu:setKeys(0)
      log("party count became nonzero!")
      dump("starter-live")
      phase = "drain"; phaseFrame = 0
    end
  elseif phase == "drain" then
    -- clear dialogue/nickname prompt: alternate B and A presses
    local p = phaseFrame % 32
    if p == 0 then emu:addKey(K.B)
    elseif p == 8 then emu:clearKey(K.B)
    elseif p == 16 then emu:addKey(K.A)
    elseif p == 24 then emu:clearKey(K.A) end
    if phaseFrame >= 900 then
      emu:setKeys(0)
      dump("starter-settled")
      phase = "done"
    end
  end

  if phase ~= "done" and frames % PERIOD == 0 then
    dump(string.format("f%06d", frames))
  end

  if phase == "done" or frames >= MAX_FRAMES then
    finished = true
    emu:setKeys(0)
    if phase ~= "done" then dump("final") end
    local f = io.open(OUT_DIR .. "/DONE", "w")
    if f then f:write(string.format("frames=%d\n", frames)); f:close() end
    log("explore harness complete")
    if logf then logf:close(); logf = nil end
  end
end

callbacks:add("frame", onFrame)
log(string.format("explore harness started: out=%s max=%d", OUT_DIR, MAX_FRAMES))
