-- mgba_card_harness.lua
-- Boots the copied ROM+sav (real save expected: overworld in Celadon), continues
-- the save, opens the start menu, selects the trainer-card entry, and dumps
-- palette RAM + VRAM + OAM + screenshots (front, and after an A press for the
-- flip side). Purpose: extract the authentic badge tile art (the card tileset
-- loads all 8 badge tiles regardless of earned state).
--
-- Env: HARNESS_OUT_DIR (required), HARNESS_MAX_FRAMES (default 6000).

local OUT_DIR = os.getenv("HARNESS_OUT_DIR")
local MAX_FRAMES = tonumber(os.getenv("HARNESS_MAX_FRAMES") or "6000")

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

local function dumpgfx(label)
  local dir = string.format("%s/%s", OUT_DIR, label)
  os.execute(string.format('mkdir -p "%s"', dir))
  local ok, err = pcall(function()
    local f = assert(io.open(dir .. "/palram.bin", "wb"))
    f:write(emu:readRange(0x05000000, 0x400)); f:close()
    f = assert(io.open(dir .. "/vram.bin", "wb"))
    f:write(emu:readRange(0x06000000, 0x18000)); f:close()
    f = assert(io.open(dir .. "/oam.bin", "wb"))
    f:write(emu:readRange(0x07000000, 0x400)); f:close()
    f = assert(io.open(dir .. "/ewram.bin", "wb"))
    f:write(emu:readRange(0x02000000, 0x40000)); f:close()
    pcall(function() emu:screenshot(dir .. "/screen.png") end)
    log("dumped " .. label)
  end)
  if not ok then log("dump FAILED: " .. tostring(err)) end
end

local K = C.GBA_KEY

-- script: list of {duration_frames, key_or_nil, label_to_dump_or_nil}
local steps = {
  {900, K.A, nil},        -- title/continue: tap A (handled as taps below)
  {240, nil, nil},        -- settle into overworld
  {2, K.START, nil},
  {90, nil, "menu-open"},
  {2, K.DOWN, nil}, {14, nil, nil},
  {2, K.DOWN, nil}, {14, nil, nil},
  {2, K.DOWN, nil}, {14, nil, nil},
  {90, nil, "menu-cursor"},
  {2, K.A, nil},
  {300, nil, "card-front"},
  {2, K.A, nil},
  {240, nil, "card-flip"},
  {2, K.A, nil},
  {240, nil, "card-after"},
}
local stepIdx, stepFrame = 1, 0

local function frame()
  frames = frames + 1
  if frames > MAX_FRAMES then
    local f = io.open(OUT_DIR .. "/DONE", "w"); f:write("timeout\n"); f:close()
    log("timeout"); os.exit(0)
  end
  local st = steps[stepIdx]
  if not st then
    local f = io.open(OUT_DIR .. "/DONE", "w"); f:write("ok\n"); f:close()
    log("done")
    stepIdx = -1
    return
  end
  if stepIdx == -1 then return end
  local dur, key, label = st[1], st[2], st[3]
  if key == K.A and dur > 100 then
    -- tap A: 2 frames down every 20
    local p = stepFrame % 20
    if p == 0 then emu:addKey(K.A) elseif p == 2 then emu:clearKey(K.A) end
  elseif key then
    if stepFrame == 0 then emu:addKey(key) end
    if stepFrame == dur - 1 then emu:clearKey(key) end
  end
  stepFrame = stepFrame + 1
  if stepFrame >= dur then
    emu:setKeys(0)
    if label then dumpgfx(label) end
    stepIdx = stepIdx + 1
    stepFrame = 0
  end
end

callbacks:add("frame", frame)
log("card harness loaded")
