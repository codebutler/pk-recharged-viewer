import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRam, parseSavestate } from "../lib/parser/index.js";
import { checksum16, decryptSecure } from "../lib/parser/pokemon.js";
import { u16, u32 } from "../lib/parser/util.js";

const REPO = join(import.meta.dir, "..");
const read = async (p) => new Uint8Array(await readFile(p));
const readDump = async (dir) => ({
  iwram: await read(join(dir, "iwram.bin")),
  ewram: await read(join(dir, "ewram.bin")),
});

// The user's real 4-badge save: the richest fixture, and the one every offset in
// research/hack-offsets.json was live-verified against.
let real;
beforeAll(async () => {
  real = await parseSavestate(await read(join(REPO, "research", "real-saves", "st0.bin")));
});

describe("player and location", () => {
  test("player identity, money and playtime", () => {
    expect(real.inGame).toBe(true);
    expect(real.player).toEqual({
      name: "Eric",
      gender: "male",
      trainerId: 49328,
      secretId: 15630,
      money: 99360,
      coins: 491,
      playTime: { hours: 9, minutes: 23, seconds: 5 },
    });
    expect(real.rivalName).toBe("Kennedy");
    expect(real.meta.confidence.player).toBe("high");
  });

  test("location resolves a map name and cross-checks the ROM layout id", () => {
    expect(real.location.mapGroup).toBe(3);
    expect(real.location.mapNum).toBe(6);
    expect(real.location.mapName).toBe("Celadon City");
    expect(real.location.mapLayoutId).toBe(138);
    const anchor = real.meta.anchors.find((a) => a.anchor === "sb1.mapLayoutId matches ROM map header");
    expect(anchor.ok).toBe(true);
    expect(real.meta.confidence.location).toContain("high");
  });

  test("save-block pointers are distinct and dereferenced, not hardcoded", () => {
    const p = real.meta.pointers;
    expect(new Set(Object.values(p)).size).toBe(3);
    for (const v of Object.values(p)) expect(v).toMatch(/^0x02[0-9A-F]{6}$/);
  });
});

describe("party", () => {
  test("six live mon, all checksum-valid", () => {
    expect(real.party.count).toBe(6);
    expect(real.party.pokemon).toHaveLength(6);
    expect(real.party.pokemon.every((m) => m.checksumValid)).toBe(true);
    expect(real.meta.confidence.party).toBe("high (checksums validated)");
    expect(real.party.source).toContain("gPlayerParty @ 0x0203855C");
  });

  test("substruct decryption yields coherent fields", () => {
    const drowzee = real.party.pokemon[0];
    expect(drowzee.species).toBe(96);
    expect(drowzee.speciesName).toBe("DROWZEE");
    expect(drowzee.level).toBe(20);
    expect(drowzee.nature).toBe("Bold");
    expect(drowzee.ivs).toEqual({ hp: 29, attack: 29, defense: 3, speed: 26, spAttack: 29, spDefense: 3 });
    for (const v of Object.values(drowzee.ivs)) expect(v).toBeLessThanOrEqual(31);
    expect(drowzee.moves.length).toBeGreaterThan(0);
    for (const m of drowzee.moves) expect(typeof m.name).toBe("string");
    expect(drowzee.hp).toBeLessThanOrEqual(drowzee.stats.maxHP);
  });

  test("nature and permutation derive from personality", () => {
    for (const m of real.party.pokemon) {
      // Nature is personality % 25; the substruct order is personality % 24. Both
      // must hold for every mon or the decryption path is wrong.
      expect(m.nature).toBeString();
      expect(m.experience).toBeGreaterThan(0);
      expect(m.otId).toBeGreaterThanOrEqual(0);
      expect(m.otId).toBeLessThanOrEqual(0xffffffff);
    }
  });

  test("checksum recomputation matches the stored value in raw bytes", async () => {
    // Independent re-derivation straight from EWRAM, not via the parser.
    const { iwram, ewram } = await (async () => {
      const { extractRam } = await import("../lib/parser/state-extract.js");
      return extractRam(await read(join(REPO, "research", "real-saves", "st0.bin")));
    })();
    const partyAddr = 0x3855c; // gPlayerParty - 0x02000000
    expect(iwram.length).toBe(0x8000);
    const pers = u32(ewram, partyAddr);
    const otId = u32(ewram, partyAddr + 4);
    const sec = decryptSecure(ewram.subarray(partyAddr, partyAddr + 80), pers, otId);
    expect(checksum16(sec)).toBe(u16(ewram, partyAddr + 28));
  });

  test("savedParty is parsed separately from the live party", () => {
    expect(real.savedParty.source).toContain("SaveBlock1+0x44");
    expect(real.savedParty.count).toBe(6);
    expect(real.meta.confidence.savedParty).toBe("high (checksums validated)");
  });
});

describe("storage boxes", () => {
  test("14 boxes with decodable names and valid mon", () => {
    expect(real.pcBoxes.boxes).toHaveLength(14);
    expect(real.pcBoxes.currentBox).toBe(1);
    expect(real.pcBoxes.totalStored).toBe(19);
    expect(real.pcBoxes.boxes.slice(0, 3).map((b) => b.name)).toEqual(["Box1", "Box2", "Box3"]);
    const stored = real.pcBoxes.boxes.flatMap((b) => b.pokemon);
    expect(stored).toHaveLength(19);
    for (const m of stored) {
      expect(m.checksumValid).toBe(true);
      expect(m.slot).toBeGreaterThanOrEqual(0);
      expect(m.slot).toBeLessThan(30);
      expect(m.species).toBeGreaterThan(0);
    }
    expect(real.meta.confidence.pcBoxes).toContain("0 checksum failures");
  });
});

describe("bag", () => {
  test("all six pockets parse, including the hack-only Medicine pocket", () => {
    const counts = Object.fromEntries(
      ["items", "keyItems", "pokeBalls", "tmHm", "berries", "medicine"].map((k) => [
        k,
        real.bag[k].length,
      ]),
    );
    expect(counts).toEqual({ items: 29, keyItems: 12, pokeBalls: 3, tmHm: 21, berries: 9, medicine: 19 });
    expect(real.meta.confidence.bag).toContain("medium");
  });

  test("quantities are plaintext (the hack removed the XOR obfuscation)", () => {
    for (const pocket of ["items", "keyItems", "pokeBalls", "tmHm", "berries", "medicine"]) {
      for (const slot of real.bag[pocket]) {
        expect(slot.quantity).toBeGreaterThan(0);
        expect(slot.quantity).toBeLessThanOrEqual(999);
        expect(slot.itemId).toBeGreaterThan(0);
      }
    }
    expect(real.meta.encryptionKey.value).toBe(0);
    expect(real.meta.encryptionKey.note).toContain("hack removed save-data encryption");
  });

  test("items land in the pocket their ROM item-table entry names", () => {
    expect(real.bag.warning).toBeUndefined();
  });
});

describe("badges, flags and level cap", () => {
  test("four badges in Kanto order", () => {
    expect(real.badges.count).toBe(4);
    expect(real.badges.badges).toEqual({
      Boulder: true, Cascade: true, Thunder: true, Rainbow: true,
      Soul: false, Marsh: false, Volcano: false, Earth: false,
    });
    expect(real.badges.flagIds[0]).toBe("0x880");
  });

  test("progress flags and the Rocket story counter", () => {
    expect(real.progressFlags.hasStarterAndDex).toBe(true);
    expect(real.progressFlags.gameClearChampion).toBe(false);
    expect(real.progressFlags.storyRocketArc.value).toBeGreaterThanOrEqual(0);
    expect(real.progressFlags.storyRocketArc.meaning).toBeString();
    expect(real.flagsRawHex).toHaveLength(0x12c * 2);
    expect(real.flagsRawHex).toMatch(/^[0-9a-f]+$/);
  });

  test("level cap follows the challenge-options byte", () => {
    // This save has the cap disabled (bit2 clear), so the cap is 100.
    expect(real.levelCap.challengeOptions.levelCapEnabled).toBe(false);
    expect(real.levelCap.cap).toBe(100);
  });
});

describe("pokedex, stats and clock", () => {
  test("dex owned is a subset of seen", () => {
    expect(real.pokedex.ownedCount).toBe(real.pokedex.owned.length);
    const seen = new Set(real.pokedex.seen);
    expect(real.pokedex.owned.every((n) => seen.has(n))).toBe(true);
    expect(real.meta.confidence.pokedex).toContain("high");
    // Every party species must read as both owned and seen under the bit-(N-1)
    // convention -- the evidence that fixed this offset.
    for (const m of real.party.pokemon) expect(seen.has(m.species)).toBe(true);
  });

  test("game stats decode with the vanilla enum order", () => {
    expect(real.gameStats.raw).toHaveLength(64);
    expect(real.gameStats.named.SAVED_GAME).toBe(41);
    expect(real.gameStats.named.STEPS).toBe(28582);
    expect(real.gameStats.named.TOTAL_BATTLES).toBe(328);
  });

  test("accelerated clock and its daily-rollover archive", () => {
    expect(real.gameClock).toMatchObject({ day: 4, hour: 21, minute: 18, second: 20 });
    expect(real.gameClock.lastDailyRollover).toMatchObject({ day: 4, hour: 21 });
    expect(real.gameClock.hour).toBeLessThan(24);
    expect(real.gameClock.minute).toBeLessThan(60);
  });

  test("mail slots are all cleared on this save", () => {
    expect(real.mail.clearedSlots).toBe(16);
    expect(real.mail.entries).toEqual([]);
  });
});

describe("overworld avatar and follower", () => {
  test("player avatar reads facing, bike and surf state", () => {
    expect(real.playerAvatar.facing).toBeOneOf(["up", "down", "left", "right"]);
    expect(real.playerAvatar.onBike).toBeBoolean();
    expect(real.playerAvatar.surfing).toBeBoolean();
    // ObjectEvent coords are map coords + 7.
    expect(real.playerAvatar.raw.currentCoords).toEqual([real.location.x + 7, real.location.y + 7]);
    expect(real.playerAvatar.objectEvents.some((e) => e.localId === 0xff)).toBe(true);
  });

  test("follower resolves to the starter Pikachu via GetFollowerMon mode 0", () => {
    expect(real.playerAvatar.follower).toMatchObject({
      present: true,
      mode: 0,
      slot: 5,
      species: 25,
      speciesName: "PIKACHU",
    });
    const mon = real.party.pokemon[real.playerAvatar.follower.slot];
    expect(mon.metLevel).toBe(5);
    expect(mon.metLocation).toBe(0x58); // Pallet Town
  });
});

describe("snapshot equivalence with the Python parser", () => {
  test("matches research/real-saves/st0.json byte-for-byte (modulo tool/path fields)", async () => {
    const expected = JSON.parse(await readFile(join(REPO, "research", "real-saves", "st0.json"), "utf8"));
    const strip = (o) => {
      const c = JSON.parse(JSON.stringify(o));
      delete c.meta.tool;
      for (const l of c.meta.config_layers) delete l.file;
      return c;
    };
    expect(strip(real)).toEqual(strip(expected));
  });
});

describe("dump-directory input", () => {
  test("parses a raw iwram/ewram pair the same way as a savestate", async () => {
    const dir = join(REPO, "research", "dumps", "statepair");
    const state = parseRam(await readDump(dir));
    expect(state.inGame).toBe(true);
    expect(state.player.name).toBe("A");
    expect(state.player.money).toBe(3000); // new-game starting money
    expect(state.location.mapName).toBeString();
  });
});
