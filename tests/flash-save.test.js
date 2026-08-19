import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DumpError,
  looksLikeFlashSave,
  parseFlashSave,
  parseFlashSaveFile,
  parseSaveFile,
  parseSavestate,
  SavError,
} from "../lib/parser/index.js";
import {
  NUM_SECTORS_PER_SLOT,
  SAV_SIZE,
  SECTOR_SIZE,
  SECTOR_SIZES,
  sectorChecksum,
} from "../lib/parser/sav-extract.js";

const REPO = join(import.meta.dir, "..");
const read = async (p) => new Uint8Array(await readFile(p));

let sav; // raw bytes, never mutated
let flash; // parsed from the .sav
let live; // parsed from the savestate of the same game

beforeAll(async () => {
  sav = await read(join(REPO, "research", "real-saves", "flash.sav"));
  flash = parseFlashSaveFile(sav);
  live = await parseSavestate(await read(join(REPO, "research", "real-saves", "st0.bin")));
});

describe("flash sector structure", () => {
  test("128KB, 32 sectors, all footers signed", () => {
    expect(sav.length).toBe(SAV_SIZE);
    expect(SAV_SIZE / SECTOR_SIZE).toBe(32);
    expect(looksLikeFlashSave(sav)).toBe(true);
  });

  // The checksum covers each chunk's REAL size, so it only verifies under the
  // hack's own struct sizes. This is independent confirmation of SB1=0x3D94 and
  // SB2=0xF64 from a second evidence source (the save file itself), separate
  // from the memcpy disassembly that first established them.
  test("all 28 slot sectors verify under the hack's struct sizes", () => {
    let verified = 0;
    for (let sector = 0; sector < 28; sector++) {
      const off = sector * SECTOR_SIZE;
      const id = sav[off + 0xff4] | (sav[off + 0xff5] << 8);
      const stored = sav[off + 0xff6] | (sav[off + 0xff7] << 8);
      expect(SECTOR_SIZES[id]).toBeDefined();
      if (sectorChecksum(sav, off, SECTOR_SIZES[id]) === stored) verified += 1;
    }
    expect(verified).toBe(28);
  });

  test("vanilla Emerald's SaveBlock sizes would NOT verify", () => {
    // SB2 sector (id 0) and SB1's last chunk (id 4) are the two that depend on
    // the struct size; with vanilla sizes (SB2 0xF2C, SB1 0x3D88) they fail.
    const vanillaSb2 = 0xf2c;
    const vanillaSb1LastChunk = 0x3d88 - 3 * 3968;
    let mismatches = 0;
    for (let sector = 0; sector < 28; sector++) {
      const off = sector * SECTOR_SIZE;
      const id = sav[off + 0xff4] | (sav[off + 0xff5] << 8);
      const stored = sav[off + 0xff6] | (sav[off + 0xff7] << 8);
      if (id === 0 && sectorChecksum(sav, off, vanillaSb2) !== stored) mismatches += 1;
      if (id === 4 && sectorChecksum(sav, off, vanillaSb1LastChunk) !== stored) mismatches += 1;
    }
    expect(mismatches).toBe(4); // both slots x both size-dependent sectors
  });

  test("blocks reassemble to the hack's exact sizes", () => {
    const { saveBlock1, saveBlock2, storage, info } = parseFlashSave(sav);
    expect(saveBlock2.length).toBe(0xf64);
    expect(saveBlock1.length).toBe(0x3d94);
    expect(storage.length).toBe(0x83d0);
    expect(info.sectorsVerified).toBe(NUM_SECTORS_PER_SLOT);
  });

  test("picks the newer slot by save counter", () => {
    const { info } = parseFlashSave(sav);
    expect(info).toMatchObject({ slot: "B", saveCounter: 41 });
    expect(info.otherSlot).toMatchObject({ slot: "A", status: "ok", saveCounter: 40 });
  });
});

// The flash save and st0.bin are the SAME game state, so the saved-side data must
// agree field-for-field. Only playtime and the clock may differ: the savestate was
// taken a little while after the last save.
describe("cross-check against the savestate of the same game", () => {
  test.each([
    "location", "badges", "progressFlags", "pokedex", "gameStats", "berryTrees",
    "mail", "levelCap", "pcItems", "flagsRawHex", "rivalName",
  ])("%s is identical", (section) => {
    expect(flash[section]).toEqual(live[section]);
  });

  test("bag is identical across all six pockets", () => {
    expect(flash.bag).toEqual(live.bag);
  });

  test("PC boxes are identical", () => {
    expect(flash.pcBoxes).toEqual(live.pcBoxes);
  });

  test("the flash party equals the savestate's SAVED party", () => {
    expect(flash.party.pokemon).toEqual(live.savedParty.pokemon);
    expect(flash.party.count).toBe(live.savedParty.count);
    // ...and on this save the player had not changed anything since saving, so it
    // also matches the live party.
    expect(flash.party.pokemon).toEqual(live.party.pokemon);
  });

  test("player matches except playtime, which kept running after the save", () => {
    const { playTime: flashTime, ...flashRest } = flash.player;
    const { playTime: liveTime, ...liveRest } = live.player;
    expect(flashRest).toEqual(liveRest);
    // The savestate is strictly later than the last save.
    const secs = (t) => t.hours * 3600 + t.minutes * 60 + t.seconds;
    expect(secs(liveTime)).toBeGreaterThan(secs(flashTime));
  });

  test("the clock stopped at the save, so it lags the savestate", () => {
    expect(flash.gameClock.day).toBe(live.gameClock.day);
    expect(flash.gameClock.hour).toBe(live.gameClock.hour);
    const mins = (c) => c.minute * 60 + c.second;
    expect(mins(flash.gameClock)).toBeLessThan(mins(live.gameClock));
  });
});

describe("honesty about what a .sav cannot contain", () => {
  test("the result is flagged as not-live, with a caveat for the UI", () => {
    expect(flash.source).toMatchObject({ kind: "flash-save", live: false });
    expect(flash.source.caveat).toContain("as of the last in-game save");
    // A savestate parse must NOT carry this marker.
    expect(live.source).toBeUndefined();
  });

  test("party is labelled as the saved copy, not live", () => {
    expect(flash.party.source).toContain("flash save");
    expect(flash.party.source).toContain("no live party");
    // The savestate's "differs from live party" note cannot apply here.
    expect(flash.savedParty.note).not.toContain("differs from live party");
  });

  test("synthetic pointers are never presented as real addresses", () => {
    expect(flash.meta.pointers.note).toContain("no live pointers");
    expect(flash.meta.pointers.gSaveBlock1Ptr).toBeUndefined();
  });

  test("avatar comes from the saved objectEvents; bike/surf are unknown, not false", () => {
    expect(flash.playerAvatar.source).toContain("0x910");
    expect(flash.playerAvatar.facing).toBe(live.playerAvatar.facingAtLastSave);
    // ObjectEvent coords are map coords + 7, and that must hold for saved data too.
    expect(flash.playerAvatar.raw.currentCoords).toEqual([
      flash.location.x + 7,
      flash.location.y + 7,
    ]);
    // null means "a .sav does not record this", which is not the same as false.
    expect(flash.playerAvatar.onBike).toBeNull();
    expect(flash.playerAvatar.surfing).toBeNull();
  });

  test("follower is reported absent with the reason, not silently missing", () => {
    expect(flash.playerAvatar.follower.present).toBe(false);
    expect(flash.playerAvatar.follower.note).toContain("does not persist the follower");
    // The savestate of the same game DOES have one -- the difference is real.
    expect(live.playerAvatar.follower.present).toBe(true);
  });

  test("the clock note says it is frozen at the save", () => {
    expect(flash.gameClock.note).toContain("as of the last save");
  });
});

describe("corrupt and unusable saves", () => {
  const corrupted = () => {
    // Mutate a COPY. The fixture on disk is the user's real save.
    const copy = new Uint8Array(sav);
    // Break one data byte in every sector of both slots, so no slot verifies.
    for (let sector = 0; sector < 28; sector++) copy[sector * SECTOR_SIZE] ^= 0xff;
    return copy;
  };

  test("all sectors corrupt -> honest error naming the failure", () => {
    expect(() => parseFlashSave(corrupted())).toThrow(SavError);
    expect(() => parseFlashSave(corrupted())).toThrow(/no usable save slot/);
  });

  test("corruption in ONE slot falls back to the other, like the game does", () => {
    const copy = new Uint8Array(sav);
    // Break slot B (the newer one); slot A is still intact at counter 40.
    for (let s = NUM_SECTORS_PER_SLOT; s < 28; s++) copy[s * SECTOR_SIZE] ^= 0xff;
    const { info } = parseFlashSave(copy);
    expect(info).toMatchObject({ slot: "A", saveCounter: 40 });
  });

  test("an erased save reports that it was never written", () => {
    const blank = new Uint8Array(SAV_SIZE).fill(0xff);
    expect(() => parseFlashSave(blank)).toThrow(/never saved/);
  });

  test("wrong size is rejected with the expected size named", () => {
    expect(() => parseFlashSave(new Uint8Array(0x8000))).toThrow(/expected 131072/);
    expect(looksLikeFlashSave(new Uint8Array(0x8000))).toBe(false);
  });

  test("parseFlashSaveFile wraps failures as DumpError for the UI", async () => {
    expect(() => parseFlashSaveFile(new Uint8Array(SAV_SIZE))).toThrow(DumpError);
    expect(() => parseFlashSaveFile(new Uint8Array(SAV_SIZE))).toThrow(/flash save:/);
  });
});

describe("parseSaveFile routing", () => {
  test("routes a .sav to the flash reader", async () => {
    const state = await parseSaveFile(sav);
    expect(state.source.kind).toBe("flash-save");
  });

  test("routes a savestate to the savestate reader", async () => {
    const state = await parseSaveFile(await read(join(REPO, "research", "real-saves", "st0.bin")));
    expect(state.source).toBeUndefined();
    expect(state.inGame).toBe(true);
  });

  test("a damaged 128KB file gets the flash diagnosis, not 'not a savestate'", async () => {
    // Routing is by size, so a 128KB file with no valid sectors is still
    // recognized as a .sav and told what is actually wrong with it.
    const blank = new Uint8Array(SAV_SIZE).fill(0xff);
    const err = await parseSaveFile(blank).catch((e) => e);
    expect(err).toBeInstanceOf(DumpError);
    expect(err.message).toContain("flash save:");
    expect(err.message).not.toContain("not a PNG");
  });

  test("routes a PNG-container savestate too", async () => {
    const state = await parseSaveFile(
      await read(join(REPO, "research", "dumps", "statepair", "state_all.ss")),
    );
    expect(state.inGame).toBe(true);
    expect(state.player.name).toBe("A");
  });
});
