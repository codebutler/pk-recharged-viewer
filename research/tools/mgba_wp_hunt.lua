-- Watch IWRAM addr for reads/writes while driving the game: intro spam, then
-- walking (to hit wild battles) with A presses to advance battle text.
local OUT=os.getenv("HARNESS_OUT_DIR"); if not OUT then return end
local ADDR=tonumber(os.getenv("WP_ADDR") or "0")
if ADDR == 0 then return end  -- WP_ADDR is required; no default (a baked-in address is a spoiler)
local MAXF=tonumber(os.getenv("HARNESS_MAX_FRAMES") or "9000")
local POKE=(os.getenv("WP_POKE") or "0")=="1"
local POKEVAL=tonumber(os.getenv("WP_VALUE") or "1")
local f=io.open(OUT.."/wp.log","w")
local frames=0
local function log(m) f:write(string.format("[f%06d] %s\n",frames,m)); f:flush() end
local hits, order = {}, {}
local kinds={}
emu:setWatchpoint(function(info)
  local pc = (info and (info.address)) or -1
  local key=string.format("0x%08X",pc)
  if not hits[key] then hits[key]=0; order[#order+1]=key end
  hits[key]=hits[key]+1
end, ADDR, C.WATCHPOINT_TYPE.RW)
log("watching 0x"..string.format("%08X",ADDR).." poke="..tostring(POKE))
local K=C.GBA_KEY
local done=false
local dirs={K.DOWN,K.LEFT,K.UP,K.RIGHT}
local curDir=nil
local function setDir(d)
  if curDir then emu:clearKey(curDir) end
  curDir=d
  if d then emu:addKey(d) end
end
callbacks:add("frame", function()
  if done then return end
  frames=frames+1
  if POKE then emu:write16(ADDR,POKEVAL) end
  if frames<=1200 then           -- boot + continue
    local p=frames%32
    if p==0 then emu:addKey(K.A) elseif p==8 then emu:clearKey(K.A)
    elseif p==16 then emu:addKey(K.START) elseif p==24 then emu:clearKey(K.START) end
  else
    if frames==1201 then emu:setKeys(0); log("phase: walk") end
    local p=frames%64
    if p==0 then setDir(dirs[((frames//64)%4)+1])
    elseif p==40 then setDir(nil)
    elseif p==44 then emu:addKey(K.A)
    elseif p==52 then emu:clearKey(K.A)
    elseif p==56 then emu:addKey(K.A)
    elseif p==60 then emu:clearKey(K.A) end
  end
  if frames%600==0 then
    log("alive uniquePCs="..#order.." val=0x"..string.format("%04X",emu:read16(ADDR)))
    emu:screenshot(string.format("%s/shot_%05d.png",OUT,frames))
  end
  if frames<MAXF then return end
  done=true; emu:setKeys(0)
  for _,k in ipairs(order) do log("PC "..k.." hits="..hits[k]) end
  log("done uniquePCs="..#order)
  emu:screenshot(OUT.."/final.png")
  local ewf=io.open(OUT.."/ewram.bin","wb"); ewf:write(emu:readRange(0x02000000,0x40000)); ewf:close()
  local iwf=io.open(OUT.."/iwram.bin","wb"); iwf:write(emu:readRange(0x03000000,0x8000)); iwf:close()
  local d=io.open(OUT.."/DONE","w"); d:write("x"); d:close()
end)
