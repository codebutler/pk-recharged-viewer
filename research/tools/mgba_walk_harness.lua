-- mgba_walk_harness.lua
-- Like mgba_dump_harness.lua, but follows a scripted timeline: spam A/Start
-- through the intro to reach the overworld, close menus with B, then walk in
-- each direction with a labeled dump after every segment. Used to capture
-- coordinate/map deltas for RAM-map verification.
--
-- Env: HARNESS_OUT_DIR (required). Writes <out>/<label>/{iwram,ewram,pointers,screen}
-- per segment plus harness.log and DONE (same layout as mgba_dump_harness.lua).

local IWRAM_BASE, IWRAM_SIZE = 0x03000000, 0x8000
local EWRAM_BASE, EWRAM_SIZE = 0x02000000, 0x40000
local PTR_SB1, PTR_SB2, PTR_STORAGE = 0x03005AD0, 0x03005AD4, 0x03005AD8

local OUT_DIR = os.getenv("HARNESS_OUT_DIR")

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
    f:write(string.format("frame=%d\ngSaveBlock1Ptr=0x%08X\ngSaveBlock2Ptr=0x%08X\ngPokemonStoragePtr=0x%08X\n",
      frames, p1, p2, p3))
    f:close()
    pcall(function() emu:screenshot(dir .. "/screen.png") end)
    log(string.format("dumped %s  SB1=0x%08X SB2=0x%08X STOR=0x%08X", label, p1, p2, p3))
  end)
  if not ok then log("dump FAILED: " .. tostring(err)) end
end

local K = C.GBA_KEY

-- Segment plan. mode:
--   "spamAS"  A/Start alternating (32-frame cycle) — advances intro/menus
--   "spamA"   A only (16-frame cycle) — advances dialogue without Start menu
--   "spamB"   B presses — backs out of / closes menus
--   "hold"    hold `key` for the whole segment (walking)
--   "idle"    no input
-- dumpAfter: label to dump when the segment ends.
local plan = {
  { mode = "spamAS", frames = 5400 },                 -- boot -> overworld (~f4200 + margin)
  { mode = "spamB",  frames = 240, dumpAfter = "prewalk" },
  { mode = "hold",   key = K.DOWN,  frames = 80, dumpAfter = "walk-down"  },
  { mode = "hold",   key = K.LEFT,  frames = 80, dumpAfter = "walk-left"  },
  { mode = "hold",   key = K.UP,    frames = 80, dumpAfter = "walk-up"    },
  { mode = "hold",   key = K.RIGHT, frames = 80, dumpAfter = "walk-right" },
  -- wander farther; door/stairs warps trigger by walking onto them
  { mode = "hold",   key = K.DOWN,  frames = 160 },
  { mode = "hold",   key = K.RIGHT, frames = 160, dumpAfter = "wander1" },
  { mode = "hold",   key = K.UP,    frames = 160 },
  { mode = "hold",   key = K.LEFT,  frames = 160, dumpAfter = "wander2" },
  { mode = "spamA",  frames = 300 },                  -- interact / clear any dialogue
  { mode = "spamB",  frames = 120 },
  { mode = "hold",   key = K.DOWN,  frames = 200, dumpAfter = "final" },
}

local segIdx, segFrame = 1, 0
local finished = false

local function press(key, phase, period)
  -- hold `key` for the first half of each `period`-frame cycle
  if phase % period == 0 then emu:addKey(key)
  elseif phase % period == period // 2 then emu:clearKey(key) end
end

local function onFrame()
  if finished then return end
  frames = frames + 1
  local seg = plan[segIdx]
  if not seg then
    finished = true
    emu:setKeys(0)
    local f = io.open(OUT_DIR .. "/DONE", "w")
    if f then f:write(string.format("frames=%d\n", frames)); f:close() end
    log("walk harness complete")
    if logf then logf:close(); logf = nil end
    return
  end

  if segFrame == 0 then
    emu:setKeys(0)
    log(string.format("segment %d: %s%s for %d frames", segIdx, seg.mode,
      seg.key and (" key=" .. tostring(seg.key)) or "", seg.frames))
    if seg.mode == "hold" then emu:addKey(seg.key) end
  end

  if seg.mode == "spamAS" then
    local p = segFrame % 32
    if p == 0 then emu:addKey(K.A)
    elseif p == 8 then emu:clearKey(K.A)
    elseif p == 16 then emu:addKey(K.START)
    elseif p == 24 then emu:clearKey(K.START) end
  elseif seg.mode == "spamA" then
    press(K.A, segFrame, 16)
  elseif seg.mode == "spamB" then
    press(K.B, segFrame, 16)
  end

  segFrame = segFrame + 1
  if segFrame >= seg.frames then
    emu:setKeys(0)
    if seg.dumpAfter then dump(seg.dumpAfter) end
    segIdx = segIdx + 1
    segFrame = 0
  end
end

callbacks:add("frame", onFrame)
log("walk harness started: out=" .. OUT_DIR)
