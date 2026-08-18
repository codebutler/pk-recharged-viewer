-- mgba_inject_harness.lua
-- Round-trip verification: reach the overworld (A/Start spam), then INJECT
-- (a) a Potion x5 into Items pocket slot 0 (SB1+0x374, plaintext qty per findings)
-- (b) a hand-constructed level-5 Pikachu into SB1 party (count at SB1+0x3B,
--     mon at SB1+0x44) AND into the hack's static gPlayerParty (0x0203855C,
--     count 0x02038559, per analysis/hack-offsets.json) so the live engine sees it
-- (c) FLAG_SYS_POKEMON_GET candidates (Emerald 0x860 + FRLG 0x828) in the hack's
--     flags array at SB1+0xEFB, so the Start menu offers a POKEMON entry
-- then dump/screenshot before and after opening the menu.
--
-- The mon is built at runtime: plaintext substructs -> checksum -> XOR with
-- (personality ^ otId), permutation order [Growth,Attacks,EVs,Misc] because
-- personality % 24 == 0. otId and otName are copied from the live SaveBlock2 so
-- the mon belongs to the actual player.
--
-- Env: HARNESS_OUT_DIR (required). Output layout matches the other harnesses.

local IWRAM_BASE, IWRAM_SIZE = 0x03000000, 0x8000
local EWRAM_BASE, EWRAM_SIZE = 0x02000000, 0x40000
local PTR_SB1, PTR_SB2 = 0x03005AD0, 0x03005AD4

local OUT_DIR = os.getenv("HARNESS_OUT_DIR")

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
    local p1, p2 = emu:read32(PTR_SB1), emu:read32(PTR_SB2)
    f = assert(io.open(dir .. "/pointers.txt", "w"))
    f:write(string.format("frame=%d\ngSaveBlock1Ptr=0x%08X\ngSaveBlock2Ptr=0x%08X\n", frames, p1, p2))
    f:close()
    pcall(function() emu:screenshot(dir .. "/screen.png") end)
    log(string.format("dumped %s  SB1=0x%08X SB2=0x%08X", label, p1, p2))
  end)
  if not ok then log("dump FAILED: " .. tostring(err)) end
end

local function shot(name)
  pcall(function() emu:screenshot(OUT_DIR .. "/" .. name .. ".png") end)
  log("screenshot " .. name)
end

-- ---------- mon construction ----------

local function u16le(v) return v & 0xFF, (v >> 8) & 0xFF end
local function put16(t, off, v) t[off+1], t[off+2] = u16le(v) end
local function put32(t, off, v)
  t[off+1] = v & 0xFF; t[off+2] = (v >> 8) & 0xFF
  t[off+3] = (v >> 16) & 0xFF; t[off+4] = (v >> 24) & 0xFF
end

local function readBytes(addr, n)
  local t = {}
  for i = 0, n-1 do t[#t+1] = emu:read8(addr + i) end
  return t
end

local function writeBytes(addr, t)
  for i = 1, #t do emu:write8(addr + i - 1, t[i]) end
end

-- Build the 100-byte party Pokemon. Returns byte table.
local function buildMon(otId, otName7)
  local personality = 24000000          -- % 24 == 0 -> substruct order G,A,E,M; nature Hardy
  local key = personality ~ otId

  -- 48-byte plaintext substruct block, order [Growth, Attacks, EVs, Misc]
  local sec = {}
  for i = 1, 48 do sec[i] = 0 end
  -- Growth @ +0x00
  put16(sec, 0x00, 25)                  -- species: Pikachu
  put16(sec, 0x02, 0)                   -- heldItem
  put32(sec, 0x04, 125)                 -- experience: level 5 medium-fast (5^3)
  sec[0x08+1] = 0                       -- ppBonuses
  sec[0x09+1] = 70                      -- friendship
  -- Attacks @ +0x0C
  put16(sec, 0x0C, 84)                  -- Thundershock
  put16(sec, 0x0E, 45)                  -- Growl
  sec[0x14+1] = 30                      -- pp[0]
  sec[0x15+1] = 40                      -- pp[1]
  -- EVs @ +0x18: all zero
  -- Misc @ +0x24
  sec[0x24+1] = 0                       -- pokerus
  sec[0x25+1] = 0                       -- metLocation
  put16(sec, 0x26, 5 | (3 << 7) | (4 << 11)) -- metLevel 5, metGame Emerald, Poke Ball
  local iv = 10
  put32(sec, 0x28, iv | (iv<<5) | (iv<<10) | (iv<<15) | (iv<<20) | (iv<<25))
  put32(sec, 0x2C, 0)                   -- ribbons

  -- checksum: u16 sum of the 24 plaintext u16 words
  local csum = 0
  for i = 0, 46, 2 do
    csum = (csum + sec[i+1] + (sec[i+2] << 8)) & 0xFFFF
  end

  -- encrypt: each u32 ^= key
  for i = 0, 44, 4 do
    local w = sec[i+1] | (sec[i+2] << 8) | (sec[i+3] << 16) | (sec[i+4] << 24)
    put32(sec, i, w ~ key)
  end

  local mon = {}
  for i = 1, 100 do mon[i] = 0 end
  put32(mon, 0x00, personality)
  put32(mon, 0x04, otId)
  local nick = {0xCA, 0xC3, 0xC5, 0xBB, 0xBD, 0xC2, 0xCF} -- "PIKACHU"
  for i = 1, 10 do mon[0x08 + i] = nick[i] or 0xFF end
  mon[0x12+1] = 2                       -- language ENG
  mon[0x13+1] = 0x02                    -- flags: hasSpecies
  for i = 1, 7 do mon[0x14 + i] = otName7[i] or 0xFF end
  mon[0x1B+1] = 0                       -- markings
  put16(mon, 0x1C, csum)
  put16(mon, 0x1E, 0)
  for i = 1, 48 do mon[0x20 + i] = sec[i] end
  -- party section
  put32(mon, 0x50, 0)                   -- status
  mon[0x54+1] = 5                       -- level
  mon[0x55+1] = 0xFF                    -- mail: none
  put16(mon, 0x56, 19)                  -- hp
  put16(mon, 0x58, 19)                  -- maxHP
  put16(mon, 0x5A, 11)                  -- attack
  put16(mon, 0x5C, 8)                   -- defense
  put16(mon, 0x5E, 14)                  -- speed
  put16(mon, 0x60, 10)                  -- spAttack
  put16(mon, 0x62, 9)                   -- spDefense
  return mon
end

-- hack statics per analysis/hack-offsets.json (Save/LoadPlayerParty evidence)
local GPARTY_COUNT, GPARTY = 0x02038559, 0x0203855C

local function inject()
  log(string.format("write API: write8=%s write16=%s write32=%s",
    tostring(emu.write8), tostring(emu.write16), tostring(emu.write32)))
  local sb1 = emu:read32(PTR_SB1)
  local sb2 = emu:read32(PTR_SB2)
  log(string.format("inject: SB1=0x%08X SB2=0x%08X", sb1, sb2))

  local otId = emu:read8(sb2+0xA) | (emu:read8(sb2+0xB) << 8)
             | (emu:read8(sb2+0xC) << 16) | (emu:read8(sb2+0xD) << 24)
  local otName7 = readBytes(sb2, 7)
  log(string.format("otId=0x%08X", otId))

  local mon = buildMon(otId, otName7)

  -- save the exact bytes for the report
  local f = io.open(OUT_DIR .. "/injected_mon.bin", "wb")
  if f then
    local s = {}
    for i = 1, 100 do s[i] = string.char(mon[i]) end
    f:write(table.concat(s)); f:close()
  end

  -- (a) bag item: Potion (13) x5, plaintext, Items pocket slot 0 = SB1+0x374
  emu:write16(sb1 + 0x374, 13)
  emu:write16(sb1 + 0x376, 5)
  -- (b) party per findings: count SB1+0x3B, mon SB1+0x44
  emu:write8(sb1 + 0x3B, 1)
  writeBytes(sb1 + 0x44, mon)
  -- (b2) vanilla static live party as well
  emu:write8(GPARTY_COUNT, 1)
  writeBytes(GPARTY, mon)
  -- (c) FLAG_SYS_POKEMON_GET: hack flags array is SB1+0xEFB (hack-offsets.json).
  -- The hack's flag ids are shifted vs vanilla (badges 0x880 vs Emerald 0x867),
  -- so set both candidate ids: Emerald 0x860 and FRLG 0x828.
  for _, flagId in ipairs({0x860, 0x828}) do
    local addr = sb1 + 0xEFB + (flagId >> 3)
    local fb = emu:read8(addr)
    emu:write8(addr, fb | (1 << (flagId & 7)))
    log(string.format("set flag 0x%X (byte SB1+0x%X was 0x%02X)", flagId, 0xEFB + (flagId >> 3), fb))
  end
  log("injection complete")
end

-- ---------- timeline ----------
-- step kinds: spamAS/spamB (frames), wait, press{key,hold}, call(fn), dump, shot
local K = C.GBA_KEY
local plan = {
  { kind = "spamAS", frames = 5400 },
  { kind = "spamB",  frames = 240 },
  { kind = "dump",   label = "preinject" },
  { kind = "call",   fn = inject },
  { kind = "dump",   label = "injected" },
  { kind = "wait",   frames = 300 },
  { kind = "dump",   label = "injected-settled" },
  { kind = "press",  key = K.START, hold = 10 },
  { kind = "wait",   frames = 90 },
  { kind = "shot",   name = "menu-open" },
  { kind = "press",  key = K.A, hold = 10 },
  { kind = "wait",   frames = 150 },
  { kind = "shot",   name = "menu-entry1" },
  { kind = "press",  key = K.A, hold = 10 },
  { kind = "wait",   frames = 120 },
  { kind = "shot",   name = "menu-entry1-A" },
  { kind = "press",  key = K.B, hold = 10 },
  { kind = "wait",   frames = 60 },
  { kind = "press",  key = K.B, hold = 10 },
  { kind = "wait",   frames = 90 },
  { kind = "shot",   name = "back-to-menu" },
  { kind = "press",  key = K.DOWN, hold = 10 },
  { kind = "wait",   frames = 30 },
  { kind = "press",  key = K.A, hold = 10 },
  { kind = "wait",   frames = 150 },
  { kind = "shot",   name = "menu-entry2" },
  { kind = "press",  key = K.B, hold = 10 },
  { kind = "wait",   frames = 60 },
  { kind = "press",  key = K.B, hold = 10 },
  { kind = "wait",   frames = 60 },
  { kind = "dump",   label = "final" },
}

local stepIdx, stepFrame = 1, 0
local finished = false

local function onFrame()
  if finished then return end
  frames = frames + 1

  while true do
    local st = plan[stepIdx]
    if not st then
      finished = true
      emu:setKeys(0)
      local f = io.open(OUT_DIR .. "/DONE", "w")
      if f then f:write(string.format("frames=%d\n", frames)); f:close() end
      log("inject harness complete")
      if logf then logf:close(); logf = nil end
      return
    end
    -- zero-frame steps execute immediately and advance
    if st.kind == "dump" then dump(st.label); stepIdx = stepIdx + 1
    elseif st.kind == "shot" then shot(st.name); stepIdx = stepIdx + 1
    elseif st.kind == "call" then
      local ok, err = pcall(st.fn)
      if not ok then log("call FAILED: " .. tostring(err)) end
      stepIdx = stepIdx + 1
    else
      break
    end
  end

  local st = plan[stepIdx]
  if st.kind == "spamAS" then
    local p = stepFrame % 32
    if p == 0 then emu:addKey(K.A)
    elseif p == 8 then emu:clearKey(K.A)
    elseif p == 16 then emu:addKey(K.START)
    elseif p == 24 then emu:clearKey(K.START) end
  elseif st.kind == "spamB" then
    local p = stepFrame % 16
    if p == 0 then emu:addKey(K.B)
    elseif p == 8 then emu:clearKey(K.B) end
  elseif st.kind == "press" then
    if stepFrame == 0 then emu:addKey(st.key)
    elseif stepFrame == st.hold then emu:clearKey(st.key) end
  end
  -- "wait": no input

  stepFrame = stepFrame + 1
  local dur = st.frames or ((st.hold or 0) + 2)
  if stepFrame >= dur then
    emu:setKeys(0)
    stepIdx = stepIdx + 1
    stepFrame = 0
  end
end

callbacks:add("frame", onFrame)
log("inject harness started: out=" .. OUT_DIR)
