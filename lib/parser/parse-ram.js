/**
 * parse-ram.js -- Pokemon Recharged Yellow RAM -> game-state JSON.
 *
 * Port of research/tools/parse_ram.py, output-compatible with it. Pure ES module:
 * inputs are Uint8Arrays, no filesystem or platform APIs, so it runs unchanged in
 * a browser. The data tables (offsets/structs/gamedata) are injected; see
 * data.js for the default loader.
 *
 * Every emitted section carries a confidence and, when data cannot be trusted, an
 * explicit "error" instead of silent garbage.
 */

import {
  AVATAR_BIKE_MASK, AVATAR_SURF_MASK, BADGE_FLAGS, BADGE_NAMES, BAG_POCKETS,
  CHALLENGE_OPTIONS_OFF, EWRAM_BASE, EWRAM_SIZE, FACING_NAMES, FLAG_GAME_CLEAR,
  FLAG_INTRO_COMPLETE, FLAG_STEP_CHARGE, FOLLOWER_STARTER_MET,
  FOLLOWER_STARTER_SPECIES, GAME_CLOCK_OFF, GAME_STAT_NAMES, IWRAM_BASE,
  IWRAM_SIZE, LEVEL_CAP_BY_BADGES, LEVEL_CAP_MODE1_MOD, MAX_BAG_QTY, MAX_COINS,
  MAX_ITEM, MAX_MONEY, OBJ_EVENT_STRIDE, PC_ITEMS_COUNT, PTR_SAVEBLOCK1,
  PTR_SAVEBLOCK2, PTR_STORAGE, RIVAL_NAME_OFF, SB1_SIZE, SB2_SIZE,
  STARTER_PAIR, STARTER_TRIO_FLAGS, STORAGE_BOXES, STORAGE_BOX_MONS,
  STORAGE_BOX_NAMES, STORAGE_SLOTS, STORAGE_WALLPAPERS, STORY_ROCKET_LABELS,
  UNVERIFIED_SB1, VAR_STEP_CHARGE, VAR_STORY_ROCKET,
} from "./constants.js";
import { Config, GameData } from "./config.js";
import { Codec, parseBoxPokemon, parsePartyPokemon, scanForMons } from "./pokemon.js";
import { bytesHex, hexU, pad0, pyRepr, s16, s8, u16, u32 } from "./util.js";

export { Config, GameData } from "./config.js";
export { Codec, parseBoxPokemon, parsePartyPokemon, scanForMons } from "./pokemon.js";
export * from "./constants.js";

/** Input-file problem (missing/truncated/unparseable) -- reported as a JSON error. */
export class DumpError extends Error {
  constructor(message) {
    super(message);
    this.name = "DumpError";
  }
}

/** A pair of RAM regions: IWRAM @0x03000000 and EWRAM @0x02000000. */
export class Dump {
  constructor(iwram, ewram) {
    if (!(iwram instanceof Uint8Array) || !(ewram instanceof Uint8Array)) {
      throw new DumpError("iwram and ewram must be Uint8Array");
    }
    if (iwram.length < IWRAM_SIZE) {
      throw new DumpError(`dump truncated: iwram is ${iwram.length} bytes (expected ${IWRAM_SIZE})`);
    }
    if (ewram.length < EWRAM_SIZE) {
      throw new DumpError(`dump truncated: ewram is ${ewram.length} bytes (expected ${EWRAM_SIZE})`);
    }
    this.iwram = iwram.subarray(0, IWRAM_SIZE);
    this.ewram = ewram.subarray(0, EWRAM_SIZE);
  }

  /** Read a 32-bit pointer from IWRAM; return [ewramOffset|null, rawPointer]. */
  deref(iwramAddr) {
    const off = iwramAddr - IWRAM_BASE;
    if (!(off >= 0 && off <= IWRAM_SIZE - 4)) return [null, 0];
    const ptr = u32(this.iwram, off);
    if (ptr >= EWRAM_BASE && ptr < EWRAM_BASE + EWRAM_SIZE) return [ptr - EWRAM_BASE, ptr];
    return [null, ptr];
  }
}

function bit(arr, n) {
  return (arr[n >> 3] >> (n & 7)) & 1;
}

function dexList(bits) {
  const out = [];
  for (let n = 0; n < bits.length * 8; n++) {
    if ((bits[n >> 3] >> (n & 7)) & 1) out.push(n + 1);
  }
  return out;
}

/**
 * Return [key, note]. Reads the configured offset and cross-validates it against
 * money/coins plausibility; on failure scans SB2 for a working key. A configured
 * offset of null means the hack removed save-data encryption.
 */
function findEncryptionKey(ew, sb2, sb1, cfg, meta) {
  const keyOff = cfg.off("sb2.encryptionKey");
  if (keyOff === null || keyOff === undefined) {
    return [0, "hack removed save-data encryption (money confirmed plaintext by ROM disassembly)"];
  }
  const key = u32(ew, sb2 + keyOff);
  const moneyRaw = u32(ew, sb1 + cfg.off("sb1.money"));
  const coinsRaw = u16(ew, sb1 + cfg.off("sb1.coins"));

  const keyWorks = (k) =>
    ((moneyRaw ^ k) >>> 0) <= MAX_MONEY && (coinsRaw ^ (k & 0xffff)) <= MAX_COINS;

  if (keyWorks(key)) {
    let note = `configured offset +0x${hexU(keyOff)}`;
    if (key === 0) note += " (key is 0: fresh save, location not actually exercised)";
    return [key, note];
  }

  // Configured location fails validation -- scan SB2 for a candidate key.
  const candidates = [];
  for (let off = 0x90; off < SB2_SIZE; off += 4) {
    const k = u32(ew, sb2 + off);
    if (k && keyWorks(k)) candidates.push([off, k]);
  }
  if (candidates.length === 1) {
    const [off, k] = candidates[0];
    meta.discovered.push({
      field: "sb2.encryptionKey",
      offset: off,
      note: `runtime scan: configured +0x${hexU(keyOff)} failed validation`,
    });
    return [k, `RELOCATED: found by scan at SB2+0x${hexU(off)}`];
  }
  return [
    null,
    `no unique key found (configured +0x${hexU(keyOff)} invalid, ${candidates.length} scan candidates)`,
  ];
}

/** Parse ItemSlot[count]; returns [slots, ok, badReason]. */
function parseItemSlots(ew, base, count, key16, encrypted, gamedata) {
  const slots = [];
  for (let i = 0; i < count; i++) {
    const itemId = u16(ew, base + i * 4);
    let qty = u16(ew, base + i * 4 + 2);
    if (encrypted) qty ^= key16;
    if (itemId === 0) continue;
    const slot = { itemId, quantity: qty };
    const name = gamedata.item(itemId);
    if (name) slot.name = name;
    slots.push(slot);
    if (itemId > MAX_ITEM || qty > MAX_BAG_QTY || qty === 0) {
      return [slots, false, `slot ${i} implausible (itemId=${itemId} qty=${qty})`];
    }
  }
  return [slots, true, null];
}

/**
 * Parse a Dump into the game-state object.
 * @param {Dump} dump
 * @param {Config} cfg
 * @param {GameData} gamedata
 * @param {Codec} codec charmap + substruct permutation
 * @param {{doScan?: boolean}} [opts]
 */
export function parseState(dump, cfg, gamedata, codec, opts = {}) {
  const doScan = opts.doScan !== false;
  const ew = dump.ewram;
  const meta = {
    tool: "parse-ram.js",
    config_layers: cfg.layers_loaded,
    gamedata_loaded: gamedata.loaded,
    anchors: [],
    discovered: [],
    confidence: {},
  };
  const state = { meta };

  const anchor = (name, ok, detail) => {
    meta.anchors.push({ anchor: name, ok: Boolean(ok), detail });
    return ok;
  };

  // --- resolve pointers -------------------------------------------------
  const [sb1, p1] = dump.deref(PTR_SAVEBLOCK1);
  const [sb2, p2] = dump.deref(PTR_SAVEBLOCK2);
  const [ps, p3] = dump.deref(PTR_STORAGE);
  meta.pointers = {
    gSaveBlock1Ptr: "0x" + hexU(p1, 8),
    gSaveBlock2Ptr: "0x" + hexU(p2, 8),
    gPokemonStoragePtr: "0x" + hexU(p3, 8),
  };
  if (sb1 === null || sb2 === null || ps === null || new Set([p1, p2, p3]).size !== 3) {
    state.inGame = false;
    state.error =
      "save block pointers do not resolve to distinct EWRAM addresses -- no game state";
    return state;
  }

  // --- in-game detection: content anchors, not pointers -----------------
  // (pre-game dumps have valid pointers to zero-filled blocks)
  const nameOff = sb2 + cfg.off("sb2.playerName");
  const nameBytes = ew.subarray(nameOff, nameOff + 8);
  const nameOk = nameBytes[0] !== 0x00 && nameBytes[0] !== 0xff && codec.textIsClean(nameBytes);
  const tidRaw = u32(ew, sb2 + cfg.off("sb2.playerTrainerId"));
  const ptOff = cfg.off("sb2.playTime");
  const playtime = [u16(ew, sb2 + ptOff), ew[sb2 + ptOff + 2], ew[sb2 + ptOff + 3]];
  anchor("sb2.playerName decodes", nameOk, pyRepr(codec.decodeText(nameBytes)));
  anchor(
    "sb2 trainerId/playtime nonzero",
    tidRaw !== 0 || playtime.some((v) => v),
    `tid=${tidRaw & 0xffff} playtime=${playtime[0]}:${pad0(playtime[1], 2)}:${pad0(playtime[2], 2)}`,
  );
  if (!(nameOk && (tidRaw !== 0 || playtime.some((v) => v)))) {
    state.inGame = false;
    if (!nameOk && tidRaw === 0 && !playtime.some((v) => v)) {
      state.error =
        "no game state: save blocks are zero-filled (title screen / intro, no save loaded)";
    } else {
      state.error =
        "no game state: save blocks only partially initialized (new-game intro/naming in progress)";
    }
    return state;
  }
  state.inGame = true;

  // --- encryption key ---------------------------------------------------
  let [key, keyNote] = findEncryptionKey(ew, sb2, sb1, cfg, meta);
  meta.encryptionKey = { value: key, note: keyNote };
  if (key === null) key = 0;
  const key16 = key & 0xffff;

  // --- player -----------------------------------------------------------
  const money = (u32(ew, sb1 + cfg.off("sb1.money")) ^ key) >>> 0;
  const coins = u16(ew, sb1 + cfg.off("sb1.coins")) ^ key16;
  // Money is NOT capped at the vanilla 999,999: a cheat code can legitimately
  // push it past that, and nulling a real value is worse than reporting a big
  // one. The offset is already guarded by the name/party/coords/layout anchors.
  const overCap = money > MAX_MONEY;
  anchor("sb1.money readable", true,
    overCap ? `${money} (above the vanilla ${MAX_MONEY} cap -- cheat or edited save)`
            : String(money));
  state.player = {
    name: codec.decodeText(nameBytes),
    gender: ew[sb2 + cfg.off("sb2.playerGender")] ? "female" : "male",
    trainerId: tidRaw & 0xffff,
    secretId: tidRaw >>> 16,
    money,
    coins: coins <= MAX_COINS ? coins : null,
    playTime: { hours: playtime[0], minutes: playtime[1], seconds: playtime[2] },
  };
  meta.confidence.player =
    nameOk && cfg.trusted("sb1.money") ? "high" : "medium";

  // --- location ---------------------------------------------------------
  const locOff = sb1 + cfg.off("sb1.location");
  const mapGroup = s8(ew, locOff);
  const mapNum = s8(ew, locOff + 1);
  state.location = {
    mapGroup,
    mapNum,
    warpId: s8(ew, locOff + 2),
    x: s16(ew, sb1 + cfg.off("sb1.pos")),
    y: s16(ew, sb1 + cfg.off("sb1.pos") + 2),
    mapLayoutId: u16(ew, sb1 + cfg.off("sb1.mapLayoutId")),
  };
  const entry = gamedata.mapEntry(mapGroup, mapNum);
  let locConf = "medium (plausible values)";
  if (typeof entry === "string") {
    state.location.mapName = entry;
  } else if (entry && typeof entry === "object") {
    if (entry.name) state.location.mapName = entry.name;
    if ("layout_id" in entry) {
      // Strong cross-check: the ROM header's layout id for (group,num) must equal
      // the layout id stored in SaveBlock1.
      const match = entry.layout_id === state.location.mapLayoutId;
      anchor(
        "sb1.mapLayoutId matches ROM map header",
        match,
        `SB1 says ${state.location.mapLayoutId}, ROM header for (${mapGroup},${mapNum}) says ${entry.layout_id}`,
      );
      locConf = match
        ? "high (layout id cross-checked against ROM map header)"
        : "suspect (layout id mismatch)";
    }
  }
  anchor(
    "sb1.location plausible",
    mapGroup >= 0 && mapGroup < 64 && mapNum >= 0 && mapNum < 128,
    `map (${mapGroup},${mapNum}) pos (${state.location.x},${state.location.y})`,
  );
  meta.confidence.location = locConf;

  // --- party ------------------------------------------------------------
  // The live party lives in fixed EWRAM globals (gPlayerPartyCount/gPlayerParty);
  // SaveBlock1's party is only a copy taken when the game saves.
  const parseParty = (countAbs, partyAbs, sourceLabel, countKey, partyKey) => {
    const count = ew[countAbs];
    const section = { source: sourceLabel, count, pokemon: [] };
    if (count > 6) {
      section.count = null;
      section.error = `partyCount=${count} at configured offset is invalid (offset likely wrong)`;
      return [section, "failed", count];
    }
    for (let i = 0; i < count; i++) {
      const mon = parsePartyPokemon(ew, partyAbs + i * 100, gamedata, codec);
      section.pokemon.push(mon !== null ? mon : { error: "empty slot within partyCount range" });
    }
    const valid = section.pokemon.filter((m) => m && m.checksumValid);
    if (count && valid.length !== count) {
      section.error = "party checksums failed at configured offset";
      return [section, "failed", count];
    }
    const conf =
      count === 0
        ? `vacuous (party empty; offsets are ${cfg.status(countKey)} / ${cfg.status(partyKey)} -- ` +
          "checksum validation could not be exercised)"
        : "high (checksums validated)";
    return [section, conf, count];
  };

  const [live, liveConf, liveCount] = parseParty(
    cfg.off("ewram.partyCount"),
    cfg.off("ewram.party"),
    `live: gPlayerParty @ 0x${hexU(EWRAM_BASE + cfg.off("ewram.party"), 8)}`,
    "ewram.partyCount",
    "ewram.party",
  );
  const [saved, savedConf, savedCount] = parseParty(
    sb1 + cfg.off("sb1.partyCount"),
    sb1 + cfg.off("sb1.playerParty"),
    `SaveBlock1+0x${hexU(cfg.off("sb1.playerParty"))} (copy as of last save; the hack likely autosaves)`,
    "sb1.partyCount",
    "sb1.playerParty",
  );
  state.party = live;
  state.savedParty = saved;
  if (liveCount !== savedCount) {
    state.savedParty.note =
      `differs from live party (saved count ${savedCount} vs live ${liveCount}) -- ` +
      "state changed since last save";
  }
  if ("error" in saved && doScan) {
    // Saved-party checksums failed -- scan SB1 for relocated mons.
    const hits = scanForMons(ew, sb1, SB1_SIZE, codec, new Set());
    if (hits.length) {
      meta.discovered.push({
        field: "sb1.playerParty(candidates)",
        offsets: hits.map((h) => "0x" + hexU(h)),
        note: "checksum-valid mons found by scan; configured saved-party offset failed",
      });
    }
  }
  meta.confidence.party = liveConf;
  meta.confidence.savedParty = savedConf;
  anchor(
    "party counts 0..6",
    (liveCount || 0) <= 6 && (savedCount || 0) <= 6,
    `live=${liveCount} saved=${savedCount}`,
  );

  // --- PC storage (verified fully vanilla) ------------------------------
  const boxes = [];
  let totalStored = 0;
  const boxNameBytes = (b) =>
    ew.subarray(ps + STORAGE_BOX_NAMES + b * 9, ps + STORAGE_BOX_NAMES + b * 9 + 9);
  for (let b = 0; b < STORAGE_BOXES; b++) {
    const name = codec.decodeText(boxNameBytes(b));
    const mons = [];
    for (let s = 0; s < STORAGE_SLOTS; s++) {
      const off = ps + STORAGE_BOX_MONS + (b * STORAGE_SLOTS + s) * 80;
      const mon = parseBoxPokemon(ew, off, gamedata, codec);
      if (mon !== null) {
        mon.slot = s;
        mons.push(mon);
      }
    }
    totalStored += mons.length;
    boxes.push({
      box: b + 1,
      name,
      wallpaper: ew[ps + STORAGE_WALLPAPERS + b],
      pokemon: mons,
    });
  }
  state.pcBoxes = { currentBox: ew[ps] + 1, totalStored, boxes };
  let namesOk = true;
  for (let b = 0; b < STORAGE_BOXES; b++) {
    if (!codec.textIsClean(boxNameBytes(b))) namesOk = false;
  }
  anchor(
    "storage box names decode",
    namesOk,
    boxes.slice(0, 3).map((bx) => bx.name).join(", ") + ", ...",
  );
  let bad = 0;
  for (const bx of boxes) for (const m of bx.pokemon) if (!m.checksumValid) bad += 1;
  meta.confidence.pcBoxes = namesOk
    ? `high (layout verified vanilla; ${totalStored} mons, ${bad} checksum failures)`
    : "failed (box names do not decode)";

  // --- bag + PC items ---------------------------------------------------
  const bagStatus = cfg.status("sb1.bagPocket_Items");
  const bag = {};
  let bagOk = true;
  const bagNotes = [];
  const pocketMismatches = [];
  for (const [outName, keyName, defaultCap, pocketType] of BAG_POCKETS) {
    if (cfg.off(keyName) === null || cfg.off(keyName) === undefined) continue;
    const capacity = cfg.capacity(keyName, defaultCap);
    const [slots, ok, reason] = parseItemSlots(
      ew, sb1 + cfg.off(keyName), capacity, key16, true, gamedata,
    );
    bag[outName] = slots;
    if (!ok) {
      bagOk = false;
      bagNotes.push(`${outName}: ${reason}`);
    }
    // Cross-check pocket boundaries: an item stored in the wrong pocket suggests
    // the boundary offsets are wrong. Warning only -- RAM injection / cheats can
    // legitimately place items in the wrong pocket.
    for (const slot of slots) {
      const expected = gamedata.itemPocket(slot.itemId);
      if (expected !== null && expected !== pocketType) {
        pocketMismatches.push(
          `${outName} has item ${slot.itemId} (${slot.name ?? "?"}) whose table pocket is ` +
            `${expected}, expected ${pocketType}`,
        );
      }
    }
  }
  state.bag = bag;
  const regItem = u16(ew, sb1 + cfg.off("sb1.registeredItem"));
  state.bag.registeredItem = regItem || null;
  if (regItem) {
    const regName = gamedata.item(regItem);
    if (regName) state.bag.registeredItemName = regName;
  }

  const [pcSlots, pcOk, pcReason] = parseItemSlots(
    ew,
    sb1 + cfg.off("sb1.pcItems"),
    cfg.capacity("sb1.pcItems", PC_ITEMS_COUNT),
    0,
    false,
    gamedata,
  );
  state.pcItems = pcSlots;
  let nBag = 0;
  for (const v of Object.values(bag)) if (Array.isArray(v)) nBag += v.length;
  if (pocketMismatches.length) {
    state.bag.warning =
      "pocket-type mismatch (wrong-pocket items -- injected/cheated save, or pocket " +
      "assignment wrong): " + pocketMismatches.join("; ");
  }
  if (!bagOk) {
    state.bag.error =
      "bag validation failed -- pocket offsets/capacities likely wrong: " + bagNotes.join("; ");
    meta.confidence.bag = "failed";
  } else if (pocketMismatches.length) {
    meta.confidence.bag =
      `suspect (slots parse but ${pocketMismatches.length} item(s) sit in a pocket that ` +
      "disagrees with the item table)";
  } else if (nBag === 0) {
    meta.confidence.bag = `vacuous (bag empty; offsets are ${bagStatus})`;
  } else {
    meta.confidence.bag = `medium (slots plausible; offsets are ${bagStatus})`;
  }
  const pcStatus = cfg.status("sb1.pcItems");
  meta.confidence.pcItems = !pcOk
    ? "failed: " + pcReason
    : pcSlots.length === 0
      ? `vacuous (empty; offsets are ${pcStatus})`
      : `medium (slots plausible; offsets are ${pcStatus})`;

  // --- Pokedex (SB2 primary copy) ---------------------------------------
  const dexOff = sb2 + cfg.off("sb2.pokedex");
  const ownedBits = ew.subarray(dexOff + 16, dexOff + 68);
  const seenBits = ew.subarray(dexOff + 68, dexOff + 120);
  const owned = dexList(ownedBits);
  const seen = dexList(seenBits);
  const national = ew[dexOff + 2] === 0xda;
  state.pokedex = {
    ownedCount: owned.length,
    seenCount: seen.length,
    owned,
    seen,
    nationalMagicSet: national,
  };
  const seenSet = new Set(seen);
  const subsetOk = owned.every((n) => seenSet.has(n)) || owned.length === 0;
  const bitNote =
    "bit convention CONFIRMED vanilla (species N -> bit N-1) on the real save: all 6 " +
    "party species read owned+seen under it, 5/6 would fail under bit-N. SB1 seen-mirrors " +
    "are removed; only these SB2 arrays exist, dex loops to 386.";
  state.pokedex.note = bitNote;
  const dexStatus = cfg.status("sb2.pokedex");
  meta.confidence.pokedex =
    seen.length === 0
      ? `vacuous (all zero -- new game; offsets are ${dexStatus}; ${bitNote})`
      : subsetOk
        ? `high (owned is subset of seen; offsets are ${dexStatus}; ${bitNote})`
        : "suspect (owned not a subset of seen -- offset may be wrong)";

  // --- sections gated on the reorganized SaveBlock1 tail ----------------
  if (cfg.trusted("sb1.flags")) {
    const flagsOff = sb1 + cfg.off("sb1.flags");
    const fl = ew.subarray(flagsOff, flagsOff + 0x12c);
    const badgeMap = {};
    BADGE_NAMES.forEach((name, i) => {
      badgeMap[name] = Boolean(bit(fl, BADGE_FLAGS[i]));
    });
    state.badges = {
      count: BADGE_FLAGS.reduce((acc, f) => acc + bit(fl, f), 0),
      badges: badgeMap,
      flagIds: BADGE_FLAGS.map((f) => "0x" + hexU(f)),
    };
    meta.confidence.badges =
      "high (hack badge flags 0x880-0x887 triple-verified by disassembly; flags array at " +
      `${cfg.status("sb1.flags")})`;
    // Progress flags use the hack's own IDs.
    const trio = {};
    for (const f of STARTER_TRIO_FLAGS) trio["0x" + hexU(f)] = Boolean(bit(fl, f));
    state.progressFlags = {
      hasStarterAndDex: STARTER_PAIR.every((f) => bit(fl, f)),
      starterTrioFlags: trio,
      gameClearChampion: Boolean(bit(fl, FLAG_GAME_CLEAR)),
      introComplete: Boolean(bit(fl, FLAG_INTRO_COMPLETE)),
      nationalDex: {
        note:
          "no national-dex flag exists in this hack -- the dex is always national " +
          "(count loop runs to 386 unconditionally)",
      },
      stepCharge: {
        enabled: Boolean(bit(fl, FLAG_STEP_CHARGE)),
        steps: u16(ew, sb1 + cfg.off("sb1.vars") + 2 * (VAR_STEP_CHARGE - 0x4000)),
        fullAt: 205,
      },
    };
    const rocket = u16(ew, sb1 + cfg.off("sb1.vars") + 2 * (VAR_STORY_ROCKET - 0x4000));
    state.progressFlags.storyRocketArc = {
      value: rocket,
      meaning: STORY_ROCKET_LABELS[rocket] ?? `unknown stage ${rocket}`,
    };
    meta.confidence.progressFlags =
      "high for hasStarterAndDex (0x860+0x861, live-confirmed on the real save) and " +
      "gameClearChampion; medium for introComplete; 0x87A is set at starter acquisition " +
      "but cleared later (real-save evidence), meaning unknown. Running-shoes has no flag " +
      "(0x866 refuted; running appears always-on)";
    state.flagsRawHex = bytesHex(fl);

    // Derived level cap (challenge-options byte at SB2+0x6E0).
    const chal = ew[sb2 + CHALLENGE_OPTIONS_OFF];
    const badgeCount = state.badges.count;
    let cap;
    if (bit(fl, FLAG_GAME_CLEAR) || !(chal & 0x04)) {
      cap = 100;
    } else {
      cap = LEVEL_CAP_BY_BADGES[badgeCount];
      if ((chal & 0x03) === 1) cap += LEVEL_CAP_MODE1_MOD[badgeCount];
    }
    state.levelCap = {
      cap,
      challengeOptions: {
        raw: chal,
        levelCapEnabled: Boolean(chal & 0x04),
        capMode: chal & 0x03,
        preChampionFeatureGate: Boolean(chal & 0x10),
      },
    };
    meta.confidence.levelCap =
      "high (mechanism recovered from level-cap fn @0x08168708 + ROM tables)";
  } else {
    state.badges = { error: UNVERIFIED_SB1 };
    state.progressFlags = { error: UNVERIFIED_SB1 };
    meta.confidence.badges = "unverified";
    meta.confidence.progressFlags = "unverified";
  }

  // --- game clock (hack-specific accelerated day/night clock) -----------
  const readClock = (base) => ({
    day: u16(ew, base),
    hour: ew[base + 2],
    minute: ew[base + 3],
    second: ew[base + 4],
  });
  state.gameClock = readClock(sb2 + GAME_CLOCK_OFF);
  state.gameClock.note = "accelerated in-game clock, ~9x real time";
  // Archived copy written at the daily rollover (same shape, SB2+0xE0).
  state.gameClock.lastDailyRollover = readClock(sb2 + 0xe0);
  meta.confidence.gameClock =
    "high (minute/second progression confirmed at 9x rate across dumps; day/hour nonzero " +
    "and coherent on the real save)";

  // --- player avatar (live facing / bike / surf from overworld globals) --
  const objOff = cfg.off("ewram.objectEvents");
  const avOff = cfg.off("ewram.playerAvatar");
  if (objOff !== null && objOff !== undefined && avOff !== null && avOff !== undefined) {
    // Pick the player entry robustly: localId 0xFF (player), else isPlayer bit
    // (byte +2 bit0) on an active entry.
    let playerEnt = null;
    for (let i = 0; i < 16; i++) {
      const e = objOff + i * OBJ_EVENT_STRIDE;
      if (ew[e] & 1 && (ew[e + 8] === 0xff || ew[e + 2] & 1)) {
        playerEnt = e;
        break;
      }
    }
    if (playerEnt !== null) {
      const facingRaw = ew[playerEnt + 0x18];
      const flagsRaw = ew[avOff];
      const cx = s16(ew, playerEnt + 0x10);
      const cy = s16(ew, playerEnt + 0x12);
      state.playerAvatar = {
        facing: FACING_NAMES[facingRaw & 0xf] ?? "unknown",
        onBike: Boolean(flagsRaw & AVATAR_BIKE_MASK),
        surfing: Boolean(flagsRaw & AVATAR_SURF_MASK),
        graphicsId: ew[playerEnt + 5],
        raw: { facing: facingRaw, avatarFlags: flagsRaw, currentCoords: [cx, cy] },
      };
      // ObjectEvent coords are map coords + 7; cross-check vs SaveBlock1 pos.
      const px = "location" in state ? state.location.x : null;
      if (px !== null) {
        const py = state.location.y;
        anchor(
          "playerAvatar coords == location + 7",
          cx === px + 7 && cy === py + 7,
          `objectEvent (${cx},${cy}) vs map pos (${px},${py})`,
        );
      }
      // Compact summary of all active object events (localId 0xFF = player,
      // 0xFE = follower) -- groundwork for follower rendering.
      const actives = [];
      let followerObj = null;
      for (let i = 0; i < 16; i++) {
        const e = objOff + i * OBJ_EVENT_STRIDE;
        if (!(ew[e] & 1)) continue;
        const ent = {
          localId: ew[e + 8],
          graphicsId: ew[e + 5],
          facing: FACING_NAMES[ew[e + 0x18] & 0xf] ?? "unknown",
          coords: [s16(ew, e + 0x10), s16(ew, e + 0x12)],
        };
        actives.push(ent);
        if (ew[e + 8] === 0xfe) followerObj = { ...ent, hidden: Boolean(ew[e + 1] & 0x20) };
      }
      state.playerAvatar.objectEvents = actives;
      // Follower species via the GetFollowerMon replication: the 0xFE object gives
      // facing/hidden only.
      if (followerObj !== null) {
        const mode = (ew[sb2 + 0x91] >> 5) & 3;
        const partyMons = state.party?.pokemon ?? [];
        let slot = null;
        if (mode === 0) {
          for (let i = 0; i < partyMons.length; i++) {
            const m = partyMons[i];
            if (
              m &&
              m.species === FOLLOWER_STARTER_SPECIES &&
              m.metLevel === FOLLOWER_STARTER_MET[0] &&
              m.metLocation === FOLLOWER_STARTER_MET[1]
            ) {
              slot = i;
              break;
            }
          }
        } else if (mode === 1) {
          for (let i = 0; i < partyMons.length; i++) {
            const m = partyMons[i];
            if (m && !m.isEgg && (m.hp ?? 0) > 0) {
              slot = i;
              break;
            }
          }
        }
        if (slot !== null) {
          const m = partyMons[slot];
          state.playerAvatar.follower = {
            present: true,
            mode,
            slot,
            species: m.species ?? null,
            speciesName: m.speciesName ?? null,
            nickname: m.nickname ?? null,
            facing: followerObj.facing,
            coords: followerObj.coords,
            hidden: followerObj.hidden,
          };
        } else {
          state.playerAvatar.follower = {
            present: false,
            mode,
            note:
              mode >= 2
                ? `follower disabled (mode ${mode})`
                : `no party mon satisfies mode-${mode} criteria`,
          };
        }
      }
      // Facing as of the last save lives in the SB1 objectEvents copy at +0x910.
      const savedFacing = ew[sb1 + 0x910 + 0x18];
      state.playerAvatar.facingAtLastSave = FACING_NAMES[savedFacing & 0xf] ?? "unknown";
      meta.confidence.playerAvatar =
        `${cfg.status("ewram.objectEvents")} (vanilla struct layouts live-verified by ` +
        "rom-fingerprint)";
    }
  }

  // --- rival name (hack-specific) ---------------------------------------
  state.rivalName = codec.decodeText(
    ew.subarray(sb2 + RIVAL_NAME_OFF, sb2 + RIVAL_NAME_OFF + 8),
  );
  meta.confidence.rivalName =
    "high (real save reads the rival's name, distinct from the player name)";

  // --- mail -------------------------------------------------------------
  const mailOff = sb1 + cfg.off("sb1.mail");
  const mailEntries = [];
  let cleared = 0;
  for (let i = 0; i < 16; i++) {
    const e = ew.subarray(mailOff + i * 36, mailOff + (i + 1) * 36);
    // Mail record: words[9] @0, playerName @18, trainerId @26, species u16 @30,
    // itemId u16 @32, 2 bytes padding.
    const itemId = u16(e, 32);
    const words = [];
    for (let j = 0; j < 9; j++) words.push(u16(e, j * 2));
    if (itemId === 0 && words.every((w) => w === 0xffff)) {
      cleared += 1;
      continue;
    }
    mailEntries.push({
      slot: i,
      slotKind: i < 6 ? "party" : "pc",
      itemId,
      species: u16(e, 30),
      playerName: codec.decodeText(e.subarray(18, 26)),
      words,
    });
  }
  state.mail = { entries: mailEntries, clearedSlots: cleared };
  meta.confidence.mail =
    `high (SB1+0x${hexU(cfg.off("sb1.mail"))} resolved as Mail; the once-contested 0x910 is ` +
    "the saved objectEvents copy)";

  // --- berry trees ------------------------------------------------------
  const btOff = sb1 + cfg.off("sb1.berryTrees");
  const trees = [];
  for (let i = 0; i < 128; i++) {
    const t = ew.subarray(btOff + i * 8, btOff + (i + 1) * 8);
    let anyByte = false;
    for (const b of t) if (b) anyByte = true;
    if (!anyByte) continue;
    trees.push({
      tree: i,
      berry: t[0],
      stage: t[1] & 0x7f,
      minutesUntilNextStage: u16(t, 2),
      yield: t[4],
    });
  }
  state.berryTrees = trees;
  meta.confidence.berryTrees =
    `${cfg.status("sb1.berryTrees")} (live dumps show real pre-planted tree data at this offset)`;

  // --- game stats (relocated to SB1+0xB50, unencrypted, vanilla enum) ----
  if (cfg.trusted("sb1.gameStats")) {
    const gsOff = sb1 + cfg.off("sb1.gameStats");
    const rawStats = [];
    for (let i = 0; i < 64; i++) rawStats.push(u32(ew, gsOff + i * 4));
    const named = {};
    rawStats.forEach((v, i) => {
      if (v) named[i < GAME_STAT_NAMES.length ? GAME_STAT_NAMES[i] : `UNKNOWN_${i}`] = v;
    });
    state.gameStats = { named, raw: rawStats };
    meta.confidence.gameStats = cfg.status("sb1.gameStats");
  } else {
    state.gameStats = {
      error: "gameStats offset not established for this hack; section disabled",
    };
    meta.confidence.gameStats = "unverified";
  }

  meta.offsets = cfg.describe(
    "sb2.playerName", "sb2.playerTrainerId", "sb2.playTime", "sb2.pokedex",
    "sb2.encryptionKey", "sb1.pos", "sb1.location", "sb1.partyCount",
    "sb1.playerParty", "ewram.partyCount", "ewram.party", "sb1.money", "sb1.coins",
    "sb1.registeredItem", "sb1.pcItems", "sb1.bagPocket_Items",
    "sb1.bagPocket_KeyItems", "sb1.bagPocket_PokeBalls", "sb1.bagPocket_TMHM",
    "sb1.bagPocket_Berries", "sb1.bagPocket_Medicine", "sb1.flags", "sb1.vars",
    "sb1.gameStats", "storage",
  );
  return state;
}
