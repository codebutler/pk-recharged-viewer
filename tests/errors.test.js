import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Dump, DumpError, parseRam, parseSavestate } from "../lib/parser/index.js";
import { EWRAM_SIZE, IWRAM_SIZE } from "../lib/parser/constants.js";

const REPO = join(import.meta.dir, "..");
const read = async (p) => new Uint8Array(await readFile(p));
const readDump = async (dir) => ({
  iwram: await read(join(dir, "iwram.bin")),
  ewram: await read(join(dir, "ewram.bin")),
});

describe("honest errors instead of garbage", () => {
  test("pre-game dump (zero-filled save blocks) reports inGame:false", async () => {
    const state = parseRam(await readDump(join(REPO, "research", "dumps", "newgame-spam", "f000600")));
    expect(state.inGame).toBe(false);
    expect(state.error).toContain("save blocks are zero-filled");
    // No fabricated sections when there is no game state.
    expect(state.player).toBeUndefined();
    expect(state.party).toBeUndefined();
    // The anchors that failed are still reported.
    expect(state.meta.anchors.length).toBeGreaterThan(0);
  });

  test("mid-intro dump reports partial initialization, not a parsed player", async () => {
    const state = parseRam(await readDump(join(REPO, "research", "dumps", "newgame-spam", "f002400")));
    expect(state.inGame).toBe(false);
    expect(state.error).toContain("only partially initialized");
  });

  test("all-zero RAM reports unresolvable pointers", () => {
    const state = parseRam({
      iwram: new Uint8Array(IWRAM_SIZE),
      ewram: new Uint8Array(EWRAM_SIZE),
    });
    expect(state.inGame).toBe(false);
    expect(state.error).toContain("do not resolve to distinct EWRAM addresses");
    expect(state.meta.pointers.gSaveBlock1Ptr).toBe("0x00000000");
  });

  test("truncated RAM regions raise DumpError, not a silent short read", () => {
    expect(() => new Dump(new Uint8Array(0x100), new Uint8Array(EWRAM_SIZE))).toThrow(DumpError);
    expect(() => new Dump(new Uint8Array(IWRAM_SIZE), new Uint8Array(0x100))).toThrow(
      /dump truncated: ewram is 256 bytes/,
    );
  });

  test("non-Uint8Array input is rejected", () => {
    expect(() => new Dump([], [])).toThrow(/must be Uint8Array/);
  });

  // parseSavestate stays strictly savestate-only; parseSaveFile is the entry that
  // accepts either kind and routes a .sav to the flash reader.
  test("a flash .sav passed to parseSavestate raises DumpError", async () => {
    const blob = await read(join(REPO, "research", "real-saves", "flash.sav"));
    await expect(parseSavestate(blob)).rejects.toThrow(DumpError);
    await expect(parseSavestate(blob)).rejects.toThrow(/flash \.sav files are not savestates/);
  });
});

describe("meta provenance", () => {
  test("both config layers load and every offset records its source", async () => {
    const state = parseRam(await readDump(join(REPO, "research", "dumps", "statepair")));
    expect(state.meta.config_layers.map((l) => l.source)).toEqual(["discovered", "hack-offsets"]);
    expect(state.meta.gamedata_loaded).toBe(true);
    for (const [key, entry] of Object.entries(state.meta.offsets)) {
      expect(entry.source, key).toBeOneOf(["vanilla", "discovered", "hack-offsets"]);
      expect(entry.status, key).toBeString();
    }
    // The hack's own offsets must win over the vanilla defaults.
    expect(state.meta.offsets["sb1.money"]).toMatchObject({ offset: 0x29c, source: "hack-offsets" });
  });
});

describe("injectable data tables", () => {
  test("createContext accepts pre-loaded JSON instead of the bundled copies", async () => {
    const { createContext } = await import("../lib/parser/data.js");
    const load = async (n) => JSON.parse(await readFile(join(REPO, "public", "data", n), "utf8"));
    const ctx = createContext({
      gamedata: await load("gamedata.json"),
      structs: await load("structs.json"),
      hackOffsets: await load("hack-offsets.json"),
      offsetsDiscovered: await load("offsets-discovered.json"),
    });
    const ram = await readDump(join(REPO, "research", "dumps", "statepair"));
    expect(parseRam(ram, { context: ctx })).toEqual(parseRam(ram));
  });

  test("a context without gamedata still parses, just without name lookups", async () => {
    const { createContext } = await import("../lib/parser/data.js");
    const ctx = createContext({ gamedata: {} });
    const state = parseRam(await readDump(join(REPO, "research", "dumps", "statepair")), {
      context: ctx,
    });
    expect(state.inGame).toBe(true);
    expect(state.meta.gamedata_loaded).toBe(false);
    expect(state.location.mapName).toBeUndefined();
    expect(state.player.name).toBe("A");
  });
});
