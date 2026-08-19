import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deserialize,
  extractRam,
  EWRAM_SIZE,
  IWRAM_SIZE,
  STATE_SIZE,
  StateError,
} from "../lib/parser/state-extract.js";

const REPO = join(import.meta.dir, "..");
const STATEPAIR = join(REPO, "research", "dumps", "statepair");

const read = async (p) => new Uint8Array(await readFile(p));

describe("savestate containers", () => {
  test("PNG-container savestate (mGBA gbAs chunk)", async () => {
    const blob = await read(join(STATEPAIR, "state_all.ss"));
    expect(blob[0]).toBe(0x89); // PNG magic
    const state = await deserialize(blob);
    expect(state.length).toBe(STATE_SIZE);
  });

  test("raw 0x61000-byte serialized state", async () => {
    const blob = await read(join(STATEPAIR, "state_flags0.ss"));
    expect(blob.length).toBe(STATE_SIZE);
    const state = await deserialize(blob);
    expect(state.length).toBe(STATE_SIZE);
  });

  test("libretro .st container (state + appended savedata)", async () => {
    const blob = await read(join(REPO, "research", "real-saves", "st0.bin"));
    expect(blob.length).toBeGreaterThan(STATE_SIZE);
    const state = await deserialize(blob);
    expect(state.length).toBe(STATE_SIZE);
    // Header sanity: the ROM title sits at +0x10 of the serialized state.
    expect(String.fromCharCode(...state.subarray(0x10, 0x1c))).toBe("POKEMON FIRE");
  });

  test("extracted RAM is byte-identical to the same-frame dump", async () => {
    // statepair/ holds a savestate and an emu:readRange dump taken on one frame.
    const { iwram, ewram } = await extractRam(await read(join(STATEPAIR, "state_all.ss")));
    expect(iwram.length).toBe(IWRAM_SIZE);
    expect(ewram.length).toBe(EWRAM_SIZE);
    const iwramRef = await read(join(STATEPAIR, "iwram.bin"));
    const ewramRef = await read(join(STATEPAIR, "ewram.bin"));
    expect(Buffer.from(iwram).equals(Buffer.from(iwramRef))).toBe(true);
    expect(Buffer.from(ewram).equals(Buffer.from(ewramRef))).toBe(true);
  });

  test("all three PNG slot variants decode to the same state", async () => {
    const states = await Promise.all(
      ["state_all.ss", "state_default.ss", "state_screenshot.ss"].map(async (n) =>
        deserialize(await read(join(STATEPAIR, n))),
      ),
    );
    for (const s of states) expect(s.length).toBe(STATE_SIZE);
    expect(Buffer.from(states[0]).equals(Buffer.from(states[1]))).toBe(true);
  });
});

describe("rejected inputs", () => {
  // .sav files ARE supported now, but by parseFlashSaveFile / parseSaveFile --
  // this reader is savestate-only and must keep saying so rather than half-reading
  // a container it does not understand. See flash-save.test.js.
  test("flash .sav is rejected by the savestate reader", async () => {
    const blob = await read(join(REPO, "research", "real-saves", "flash.sav"));
    await expect(deserialize(blob)).rejects.toThrow(/flash \.sav files are not savestates/);
  });

  test("a PNG without a gbAs chunk is rejected", async () => {
    const blob = await read(join(STATEPAIR, "screen.png"));
    await expect(deserialize(blob)).rejects.toThrow(/no gbAs chunk/);
  });

  test("an oversized non-state blob is rejected", async () => {
    const blob = new Uint8Array(STATE_SIZE + 16); // all zero: no version magic, no title
    await expect(deserialize(blob)).rejects.toThrow(/does not start with an mGBA state header/);
  });

  test("errors are StateError instances", async () => {
    try {
      await deserialize(new Uint8Array(16));
      throw new Error("expected a rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(StateError);
      expect(e.message).toContain("0x61000");
    }
  });
});
